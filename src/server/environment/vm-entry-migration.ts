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
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
// Runner — server 启动时调用一次（src/server/index.ts main()）
// ---------------------------------------------------------------------------

export interface VmEntryMigrationOptions {
  /** 默认 <dataDir>/config.json（测试注入临时路径）。 */
  configPath?: string;
  /** 默认 ~/.zhishi/env-sessions.json（测试注入临时路径）。 */
  envSessionsPath?: string;
  /** 默认 ~/.zhishi/env-selection.json（测试注入临时路径）。 */
  envSelectionPath?: string;
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
 */
export async function runLegacyVmEntryMigration(
  options: VmEntryMigrationOptions = {},
): Promise<VmEntryMigrationResult> {
  const log = options.log ?? ((msg: string) => console.log(msg));
  const warn = options.warn ?? ((msg: string) => console.warn(msg));
  const configPath = options.configPath ?? defaultConfigPath();
  const empty: VmEntryMigrationResult = { migrated: [], skipped: [] };

  if (!existsSync(configPath)) return empty;

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
      if (scan.renames.length === 0) return;
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

  if (migrated.length === 0) {
    for (const s of skipped) warn(`[env-migration] 跳过条目 ${s}`);
    return { migrated, skipped };
  }

  // 引用迁移：逐改名容错，一个文件坏了不拖另一个。
  for (const { oldId, newId } of migrated) {
    try {
      await renameEnvSessionEnvId(oldId, newId, options.envSessionsPath);
    } catch (err) {
      warn(`[env-migration] env-sessions.json 改名 ${oldId}→${newId} 失败：${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await renameSelectionEnvId(oldId, newId, options.envSelectionPath);
    } catch (err) {
      warn(`[env-migration] env-selection.json 改名 ${oldId}→${newId} 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const s of skipped) warn(`[env-migration] 跳过条目 ${s}`);
  log(`[env-migration] 1.3.7 vm 环境条目「实例即环境」迁移完成：${migrated.length} 条（${migrated.map((r) => `${r.oldId}→${r.newId}`).join('，')}）`);
  return { migrated, skipped };
}
