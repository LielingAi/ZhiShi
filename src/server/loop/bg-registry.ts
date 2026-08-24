/**
 * env_bg 宿主侧登记表（Phase 3 · docs/spec/env-bg-design.md §8）。
 *
 * 为什么需要这张表：env_bg 的真相在环境内（D1），但宿主仍需要一张
 * 「本工作区发起过哪些后台进程」的账——Phase 3 的回收杀掉（turn 结束 /
 * 会话 reset）必须知道要杀谁。纯内存表 sidecar 重启即丢 → 重启后回收
 * 链失明、进程变孤儿，故登记表落盘并在启动时恢复。
 *
 * 红线（继承 D1）：这张表是宿主侧的方便账本，不是真相。丢了/坏了只是
 * 回收链失明 + 一条警告日志，绝不拖死会话；环境内 .pid/.exit 文件仍是
 * 唯一权威（env_bg list 随时能重新发现全部进程）。
 *
 * 落盘位置：<数据目录>/bg-procs/<agentDir 短哈希>.json（getZhiShiDataDir
 * 解析，与 loop-sessions 同目录约定；哈希隔离多工作区 sidecar 互踩）。
 * 写入原子：tmp+rename（与 loop/session.ts 同惯例）；写失败仅告警。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getZhiShiDataDir } from '../utils/app-dirs';
import { BG_TAG_RE } from './bg-exec';

export interface BgRegistryEntry {
  tag: string;
  pid: number;
  /** 发起时锚定的环境条目 id（回收时据此从 config.environments 解析）。 */
  envId: string;
  /** 发起时间戳（epoch ms，审计用）。 */
  startedAt: number;
  /** 命令摘要（最长 100 字符，人审计用）。 */
  commandPreview: string;
}

/** 盘上文件形状（version 占位，为未来字段演进留余地）。 */
interface BgRegistryFile {
  version: number;
  entries: BgRegistryEntry[];
}

export interface BgRegistryOptions {
  /**
   * 盘上文件路径（缺省 null = 纯内存态）。生产经 initBgRegistry 按
   * agentDir 哈希推导；测试注入临时目录。
   */
  filePath?: string | null;
  /** 告警输出（缺省 console.warn；测试注入收集器）。 */
  logWarn?: (msg: string) => void;
}

export interface BgRegistry {
  /** 盘上文件路径；null = 纯内存态（不落盘，测试/降级用）。 */
  readonly filePath: string | null;
  register(entry: BgRegistryEntry): void;
  remove(tag: string): void;
  get(tag: string): BgRegistryEntry | undefined;
  /** 快照（回收迭代用；返回副本，迭代中 remove 不影响本次遍历）。 */
  list(): BgRegistryEntry[];
  /** 启动恢复：读盘重建内存表；文件缺失/损坏不抛错。 */
  restore(): void;
  /** 清空内存表（不写盘；测试用）。 */
  clear(): void;
}

// ---------------------------------------------------------------------------
// 纯函数：路径 / 编解码
// ---------------------------------------------------------------------------

/** agentDir 的短哈希（文件名成分，防跨工作区互踩）。 */
export function workspaceHash(agentDir: string): string {
  return createHash('sha256').update(agentDir).digest('hex').slice(0, 12);
}

/** 登记表盘上路径：<dir>/<hash>.json。 */
export function bgRegistryFilePath(agentDir: string, dir?: string): string {
  const base = dir ?? join(getZhiShiDataDir(), 'bg-procs');
  return join(base, `${workspaceHash(agentDir)}.json`);
}

/** 反序列化：坏 JSON / 坏条目逐条跳过（登记表坏了不炸会话）。 */
export function parseBgRegistryFile(content: string): BgRegistryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  const out: BgRegistryEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    if (
      typeof o.tag === 'string' &&
      BG_TAG_RE.test(o.tag) &&
      typeof o.pid === 'number' &&
      Number.isInteger(o.pid) &&
      o.pid > 0 &&
      typeof o.envId === 'string' &&
      o.envId.length > 0
    ) {
      out.push({
        tag: o.tag,
        pid: o.pid,
        envId: o.envId,
        startedAt: typeof o.startedAt === 'number' ? o.startedAt : 0,
        commandPreview: typeof o.commandPreview === 'string' ? o.commandPreview.slice(0, 100) : '',
      });
    }
  }
  return out;
}

/** 序列化（version + entries）。 */
export function serializeBgRegistryFile(entries: BgRegistryEntry[]): string {
  const file: BgRegistryFile = { version: 1, entries };
  return JSON.stringify(file, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// 实例
// ---------------------------------------------------------------------------

/**
 * 建一个登记表实例。写入失败（盘满/权限/目录被占）只走 logWarn——
 * 登记表不是真相，丢了不能让会话死（Phase 3 稳定性红线）。
 */
export function createBgRegistry(options: BgRegistryOptions = {}): BgRegistry {
  const filePath = options.filePath ?? null;
  const logWarn = options.logWarn ?? ((msg: string) => console.warn(msg));
  const byTag = new Map<string, BgRegistryEntry>();

  function persist(): void {
    if (!filePath) return;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, serializeBgRegistryFile([...byTag.values()]), 'utf-8');
      renameSync(tmp, filePath);
    } catch (err) {
      logWarn(`[bg-registry] 登记表落盘失败(内存态继续,重启后本批登记不可恢复):${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    filePath,

    register(entry) {
      byTag.set(entry.tag, entry);
      persist();
    },

    remove(tag) {
      if (!byTag.has(tag)) return;
      byTag.delete(tag);
      persist();
    },

    get(tag) {
      return byTag.get(tag);
    },

    list() {
      return [...byTag.values()];
    },

    restore() {
      if (!filePath || !existsSync(filePath)) return;
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch (err) {
        logWarn(`[bg-registry] 登记表读取失败(按空表启动):${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const entries = parseBgRegistryFile(content);
      for (const e of entries) byTag.set(e.tag, e);
      if (entries.length > 0) {
        console.log(`[bg-registry] 恢复 ${entries.length} 条 bg 登记(文件 ${filePath})`);
      }
    },

    clear() {
      byTag.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// 生产单例（sidecar 进程内一张表；initPiChatEngine 时初始化）
// ---------------------------------------------------------------------------

let currentRegistry: BgRegistry | null = null;

export function getBgRegistry(): BgRegistry | null {
  return currentRegistry;
}

/** sidecar 启动时初始化并恢复登记表（chat-engine initPiChatEngine 调用）。 */
export function initBgRegistry(agentDir: string, options: BgRegistryOptions = {}): BgRegistry {
  currentRegistry = createBgRegistry({ ...options, filePath: options.filePath ?? bgRegistryFilePath(agentDir) });
  currentRegistry.restore();
  return currentRegistry;
}

/** 测试复位（照 memory/store 的 resetMemoryStoreForTest 惯例）。 */
export function resetBgRegistryForTest(): void {
  currentRegistry = null;
}
