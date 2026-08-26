/**
 * 1.3.7 场景 1 — 存量 vm 环境条目「实例即环境」一次性迁移。
 *
 * 旧语义（D22）：vmware up 回写的 env 条目 id = 配方 id（recipeId），
 * vmx 挂条目上。新语义：id = VM 实例名（vmx 文件 stem），与 hyperv/vbox
 * 口径一致，vmx 退化为纯定位辅助。
 *
 * 迁移对象（三处都引用 env id，改 id 必须同步）：
 *   1. config.json::environments  —— 旧条目（kind=vm 且带 vmx 且 id=recipeId）
 *      → id/vmName 改为 vmNameFromVmx(vmx)，vmx 与其余字段原样保留；
 *   2. env-sessions.json          —— 行键后缀 env:<oldId> / recipe:<oldId> 改名；
 *   3. env-selection.json         —— selection env.id / recipe.instanceId 改名。
 *
 * 幂等：迁移后不再存在「id=recipeId 且带 vmx」的条目，二次运行为无命中
 * 零写盘。可追溯：发生迁移打一行日志（UnifiedLogger 口径 = console.*）。
 * 失败不炸启动：坏条目/坏文件逐条跳过 + 告警；配置写走锁内重读重算
 * （并发启动的两个进程不会互相覆盖）。
 * 1.3.10 #1：config 改名与引用改名之间隔了进程死亡窗口——本批 renames
 * 在写 config 之前先落 pending 日志（<data>/env-migration-pending.json，
 * 锁内 tmp+rename），启动时先重放 pending 再扫描，引用改名失败/中断
 * 不再永久悬空。
 */

import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { AdminAppConfig } from '../utils/admin-config';
import { getZhiShiDataDir } from '../utils/app-dirs';
import { ensureDirSync } from '../utils/fs-utils';
import { withFileLock } from '../utils/file-lock';
import { listEnvironments } from './registry';
import { renameEnvSessionEnvId } from './env-sessions';
import { renameSelectionEnvId } from './selection';
import { vmNameFromVmx } from './vm-lifecycle';

// ---------------------------------------------------------------------------
// Pure — 旧条目识别与改名应用（可单测，不碰 I/O）
// ---------------------------------------------------------------------------

export interface VmEntryRename {
  oldId: string;
  newId: string;
}

export interface LegacyVmEntryScan {
  renames: VmEntryRename[];
  /** 无法迁移的条目 id + 原因（坏 vmx / 目标 id 撞名）。 */
  skipped: string[];
}

/**
 * 识别旧语义 vmware 条目：kind=vm 且带 vmx 且 id === recipeId（旧 up 回写
 * 口径）。新 id = vmx 文件 stem。newId 与现有其它条目撞名 / stem 为空 →
 * 跳过并给出原因（数据保留，不丢条目）。id 已等于 stem 的视为新口径，
 * 不算旧条目（幂等关键）。
 */
export function scanLegacyVmTemplateEntries(config: AdminAppConfig): LegacyVmEntryScan {
  const entries = listEnvironments(config);
  const renames: VmEntryRename[] = [];
  const skipped: string[] = [];
  // 目标 id 占用表：所有条目 id + 已计划的新 id。
  const taken = new Set(entries.map((e) => e.id));
  for (const entry of entries) {
    if (entry.kind !== 'vm' || !entry.vmx || !entry.recipeId || entry.id !== entry.recipeId) continue;
    const newId = vmNameFromVmx(entry.vmx);
    if (!newId) {
      skipped.push(`${entry.id}（vmx "${entry.vmx}" 解析不出 VM 名）`);
      continue;
    }
    if (newId === entry.id) continue; // 配方 id 恰好等于 VM 名——已是新口径
    if (taken.has(newId)) {
      skipped.push(`${entry.id}（目标 id "${newId}" 已被占用，请人工 zhishi env rm 其中一条）`);
      continue;
    }
    taken.add(newId);
    renames.push({ oldId: entry.id, newId });
  }
  return { renames, skipped };
}

/** 应用改名：id 与 vmName 同步为实例名，vmx 等其余字段原样保留。 */
export function applyVmEntryRenames(config: AdminAppConfig, renames: VmEntryRename[]): AdminAppConfig {
  if (renames.length === 0) return config;
  const byOldId = new Map(renames.map((r) => [r.oldId, r.newId]));
  const environments = listEnvironments(config).map((entry) => {
    const newId = byOldId.get(entry.id);
    return newId ? { ...entry, id: newId, vmName: newId } : entry;
  });
  return { ...config, environments };
}

// ---------------------------------------------------------------------------
// pending 自愈日志（1.3.10 #1）——堵「config 已改名、引用改名失败/进程
// 中断 → 下次启动扫不到 legacy 条目 → 引用永久悬空」的窗
// ---------------------------------------------------------------------------

/** pending 文件形状（version 占位，为未来字段演进留余地）。 */
interface VmMigrationPendingFile {
  version: number;
  renames: VmEntryRename[];
}

const VM_MIGRATION_PENDING_VERSION = 1;

/** pending 写盘的锁等待上限——它是自愈日志，不值得为它把启动卡满默认 5s。 */
const PENDING_LOCK_TIMEOUT_MS = 1500;

function defaultPendingPath(): string {
  return join(getZhiShiDataDir(), 'env-migration-pending.json');
}

export function serializeVmMigrationPending(renames: VmEntryRename[]): string {
  const file: VmMigrationPendingFile = { version: VM_MIGRATION_PENDING_VERSION, renames };
  return JSON.stringify(file, null, 2) + '\n';
}

/** 读 pending（缺失 / 坏 JSON / 坏条目 → []，不炸启动）。 */
export function loadVmMigrationPending(path: string): VmEntryRename[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const raw = (parsed as { renames?: unknown }).renames;
  if (!Array.isArray(raw)) return [];
  const out: VmEntryRename[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.oldId === 'string' && o.oldId.length > 0 && typeof o.newId === 'string' && o.newId.length > 0) {
      out.push({ oldId: o.oldId, newId: o.newId });
    }
  }
  return out;
}

/** 写 pending（锁内 tmp+rename；空 → 删文件）。锁冲突抛 FileBusyError，调用方降级告警。 */
async function writeVmMigrationPending(path: string, renames: VmEntryRename[]): Promise<void> {
  if (renames.length === 0) {
    try { unlinkSync(path); } catch { /* 不存在/无权限——无害 */ }
    return;
  }
  await withFileLock({ lockPath: `${path}.lock`, timeoutMs: PENDING_LOCK_TIMEOUT_MS }, async () => {
    ensureDirSync(dirname(path));
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, serializeVmMigrationPending(renames), 'utf-8');
    renameSync(tmp, path);
  });
}

/** 一条改名的两条引用（env-sessions / env-selection）都成功才算 done；
 *  任一失败 → false（留 pending 下次重放）。幂等——oldId 已不在时是 no-op。 */
async function applyOneReferenceRename(
  r: VmEntryRename,
  renameSession: (oldId: string, newId: string) => Promise<void>,
  renameSelection: (oldId: string, newId: string) => Promise<void>,
  warn: (msg: string) => void,
): Promise<boolean> {
  let ok = true;
  try {
    await renameSession(r.oldId, r.newId);
  } catch (err) {
    ok = false;
    warn(`[env-migration] env-sessions.json 改名 ${r.oldId}→${r.newId} 失败：${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await renameSelection(r.oldId, r.newId);
  } catch (err) {
    ok = false;
    warn(`[env-migration] env-selection.json 改名 ${r.oldId}→${r.newId} 失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Runner — server 启动时调用一次（src/server/index.ts main()）
// ---------------------------------------------------------------------------

export interface VmEntryMigrationOptions {
  /** 默认 <dataDir>/config.json（测试注入临时路径）。 */
  configPath?: string;
  /** 默认 ~/.zhishi/env-sessions.json（测试注入临时路径）。 */
  envSessionsPath?: string;
  /** 默认 ~/.zhishi/env-selection.json（测试注入临时路径）。 */
  envSelectionPath?: string;
  /** 默认 <dataDir>/env-migration-pending.json（测试注入临时路径）。 */
  pendingPath?: string;
  /** 引用改名通道（缺省真实现；测试注入失败/计数）。 */
  renameSession?: (oldId: string, newId: string) => Promise<void>;
  renameSelection?: (oldId: string, newId: string) => Promise<void>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface VmEntryMigrationResult {
  migrated: VmEntryRename[];
  skipped: string[];
}

function defaultConfigPath(): string {
  return join(getZhiShiDataDir(), 'config.json');
}

/**
 * 一次性迁移入口。任何一步失败都不抛出（启动不被迁移卡死）：配置读写
 * 失败整体跳过；env-sessions / env-selection 逐改名容错。
 *
 * 1.3.10 #1 自愈序列：启动时先重放 pending（上次进程死在「config 已改名、
 * 引用未改名」窗口的续跑），再扫描 config；本批 renames 在写 config 之前
 * 先落 pending——此后任何中断都可在下次启动重放补齐，引用不再永久悬空。
 */
export async function runLegacyVmEntryMigration(
  options: VmEntryMigrationOptions = {},
): Promise<VmEntryMigrationResult> {
  const log = options.log ?? ((msg: string) => console.log(msg));
  const warn = options.warn ?? ((msg: string) => console.warn(msg));
  const configPath = options.configPath ?? defaultConfigPath();
  const pendingPath = options.pendingPath ?? defaultPendingPath();
  const renameSessionImpl = options.renameSession
    ?? ((oldId: string, newId: string) => renameEnvSessionEnvId(oldId, newId, options.envSessionsPath));
  const renameSelectionImpl = options.renameSelection
    ?? ((oldId: string, newId: string) => renameSelectionEnvId(oldId, newId, options.envSelectionPath));
  const empty: VmEntryMigrationResult = { migrated: [], skipped: [] };

  if (!existsSync(configPath)) return empty;

  // ① 重放上次未跑完的引用改名（先于扫描——堵「config 已改名、引用未改」
  //    的永久悬空窗；重放幂等，失败条目留在 pending 下次再试）。
  let pendingFailed: VmEntryRename[] = [];
  const pending = loadVmMigrationPending(pendingPath);
  if (pending.length > 0) {
    let replayed = 0;
    const stillFailed: VmEntryRename[] = [];
    for (const r of pending) {
      if (await applyOneReferenceRename(r, renameSessionImpl, renameSelectionImpl, warn)) replayed++;
      else stillFailed.push(r);
    }
    pendingFailed = stillFailed;
    if (replayed > 0) log(`[env-migration] 重放 pending 引用改名 ${replayed} 条`);
  }

  let migrated: VmEntryRename[] = [];
  const skipped: string[] = [];
  try {
    await withFileLock({ lockPath: `${configPath}.lock` }, async () => {
      // 锁内重读重算：并发进程谁先谁迁，后来者扫不到旧条目自然无操作。
      const raw = readFileSync(configPath, 'utf-8');
      let config: AdminAppConfig;
      try {
        config = JSON.parse(raw) as AdminAppConfig;
      } catch {
        skipped.push('config.json 解析失败（跳过迁移）');
        return;
      }
      const scan = scanLegacyVmTemplateEntries(config);
      skipped.push(...scan.skipped);
      if (scan.renames.length === 0) {
        // 无新迁移：把重放后仍失败的 pending 余量落回（成功的已在重放时消化）。
        try {
          await writeVmMigrationPending(pendingPath, pendingFailed);
        } catch (err) {
          warn(`[env-migration] pending 落盘失败（下次启动将重放全量，幂等无害）：${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      // ② 写 config 前先把「重放失败余量 + 本批 renames」落 pending——
      //    config 落盘成功后即使进程死在引用改名前，下次启动也能续上。
      try {
        await writeVmMigrationPending(pendingPath, [...pendingFailed, ...scan.renames]);
      } catch (err) {
        warn(`[env-migration] pending 落盘失败（引用改名一旦失败将无法续跑，仅本轮尽力）：${err instanceof Error ? err.message : String(err)}`);
      }
      const next = applyVmEntryRenames(config, scan.renames);
      ensureDirSync(dirname(configPath));
      const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
      try { copyFileSync(configPath, `${configPath}.bak`); } catch { /* best-effort 备份 */ }
      renameSync(tmp, configPath);
      migrated = scan.renames;
    });
  } catch (err) {
    warn(`[env-migration] config.json 迁移失败（不影响启动）：${err instanceof Error ? err.message : String(err)}`);
    return { migrated: [], skipped };
  }

  // ③ 引用改名：重放失败余量 + 本批新改名；成功后 pending 只留失败条目。
  const stillPending: VmEntryRename[] = [];
  for (const r of [...pendingFailed, ...migrated]) {
    if (!(await applyOneReferenceRename(r, renameSessionImpl, renameSelectionImpl, warn))) {
      stillPending.push(r);
    }
  }
  try {
    await writeVmMigrationPending(pendingPath, stillPending);
  } catch (err) {
    warn(`[env-migration] pending 落盘失败（失败条目将在下次启动重放时再试）：${err instanceof Error ? err.message : String(err)}`);
  }

  for (const s of skipped) warn(`[env-migration] 跳过条目 ${s}`);
  if (migrated.length > 0) {
    log(`[env-migration] 1.3.7 vm 环境条目「实例即环境」迁移完成：${migrated.length} 条（${migrated.map((r) => `${r.oldId}→${r.newId}`).join('，')}）`);
  }
  return { migrated, skipped };
}
