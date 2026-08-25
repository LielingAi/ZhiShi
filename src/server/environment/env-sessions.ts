/**
 * 1.1.6 #4 — 会话按环境分线映射（env-sessions.json）。
 *
 * 每个环境一条独立会话线：切换环境不重置、不串扰。映射文件
 * `~/.zhishi/env-sessions.json`，行键 = `${规范化workspace}::${环境键}`，
 * 值 = 该线的 loopSessionId（loop-sessions/<id>.jsonl 的全量历史）。
 *
 *   {
 *     "version": 1,
 *     "lines": {
 *       "E:/code/u-disk::env:pwn-vm": { "loopSessionId": "...", "updatedAt": "<ISO-8601>" },
 *       "E:/code/u-disk::host":     { "loopSessionId": "...", "updatedAt": "<ISO-8601>" }
 *     }
 *   }
 *
 * 环境键：env → `env:<envId>`；recipe → `recipe:<instanceId>`；host → `host`
 * （selection 三种 kind 见 selection.ts）。
 *
 * workspace 键规范化：resolve + 统一正斜杠——斜杠漂移是活体坑（见
 * chat-engine.ts resolveSessionEnv 的双形态兜底），新代码一律先规范化再
 * 作键，读写两侧天然一致。
 *
 * cron 语义：cron 不特殊处理——它跟随当前选定环境的线（引擎单例现状即
 * 如此）；cron 的 sessions/switch 会把引擎临时切走，不改动本映射。
 *
 * 结构照 selection.ts：校验、parse/serialize、行读写都是纯函数（可单测）；
 * IO 只有 load/mutate 两组薄函数，路径可注入（测试传临时目录）。与
 * selection.ts 不同：写盘必须走 withFileLock + tmp+rename（与
 * loop/session.ts、SessionStore 同一惯例），读盘裸读（与 loadLoopSession
 * 同惯例）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { getZhiShiDataDir } from '../utils/app-dirs';
import { withFileLock } from '../utils/file-lock';
import type { EnvSelection } from './selection';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 一条分线映射：环境线 → loop 会话。 */
export interface EnvSessionLine {
  loopSessionId: string;
  /** ISO-8601 最近写盘时间。 */
  updatedAt: string;
}

export interface EnvSessionsMap {
  version: 1;
  /** 行键（`${规范化workspace}::${环境键}`）→ 映射行。 */
  lines: Record<string, EnvSessionLine>;
}

// ---------------------------------------------------------------------------
// Pure — key / parse / serialize / transforms
// ---------------------------------------------------------------------------

/** 环境键：env → env:<id>；recipe → recipe:<instanceId>；host → host。 */
export function envKeyForSelection(selection: EnvSelection): string {
  switch (selection.kind) {
    case 'host':
      return 'host';
    case 'env':
      return `env:${selection.id}`;
    case 'recipe':
      return `recipe:${selection.instanceId}`;
  }
}

/** workspace 键规范化：resolve + 统一正斜杠（斜杠漂移活体坑的治本）。 */
export function normalizeWorkspaceKey(workspace: string): string {
  return resolve(workspace).replace(/\\/g, '/');
}

/** 映射行键：`${规范化workspace}::${环境键}`。 */
export function envSessionLineKey(workspace: string, envKey: string): string {
  return `${normalizeWorkspaceKey(workspace)}::${envKey}`;
}

export function emptyEnvSessionsMap(): EnvSessionsMap {
  return { version: 1, lines: {} };
}

/**
 * Parse raw file content into a map. Corrupt JSON / wrong top-level shape →
 * empty map; individual corrupt line entries are dropped（手改翻车不许卡死
 * 首屏/接线，与 selection.ts 同口径）。
 */
export function parseEnvSessionsMap(raw: string): EnvSessionsMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyEnvSessionsMap();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyEnvSessionsMap();
  const source = parsed as Record<string, unknown>;
  if (source.version !== 1 || !source.lines || typeof source.lines !== 'object' || Array.isArray(source.lines)) {
    return emptyEnvSessionsMap();
  }
  const map = emptyEnvSessionsMap();
  for (const [key, line] of Object.entries(source.lines as Record<string, unknown>)) {
    if (!line || typeof line !== 'object' || Array.isArray(line)) continue;
    const rec = line as Record<string, unknown>;
    if (typeof rec.loopSessionId !== 'string' || !rec.loopSessionId) continue;
    map.lines[key] = {
      loopSessionId: rec.loopSessionId,
      updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : '',
    };
  }
  return map;
}

export function serializeEnvSessionsMap(map: EnvSessionsMap): string {
  return `${JSON.stringify(map, null, 2)}\n`;
}

/** 查行；无映射 → undefined。 */
export function getEnvSessionLine(
  map: EnvSessionsMap,
  workspace: string,
  envKey: string,
): EnvSessionLine | undefined {
  return map.lines[envSessionLineKey(workspace, envKey)];
}

/** Non-mutating set: returns a new map with the line replaced. */
export function setEnvSessionLineInMap(
  map: EnvSessionsMap,
  workspace: string,
  envKey: string,
  loopSessionId: string,
  updatedAt: string,
): EnvSessionsMap {
  return {
    version: 1,
    lines: { ...map.lines, [envSessionLineKey(workspace, envKey)]: { loopSessionId, updatedAt } },
  };
}

/** Non-mutating remove: returns a new map without the line. */
export function removeEnvSessionLineFromMap(
  map: EnvSessionsMap,
  workspace: string,
  envKey: string,
): EnvSessionsMap {
  const key = envSessionLineKey(workspace, envKey);
  if (!(key in map.lines)) return map;
  const lines = { ...map.lines };
  delete lines[key];
  return { version: 1, lines };
}

/** 清某 envId 的全部分线残留（环境删除时调用）：所有 workspace 的 `env:<envId>` 行。 */
export function removeEnvSessionsForEnvIdFromMap(map: EnvSessionsMap, envId: string): EnvSessionsMap {
  const suffix = `::env:${envId}`;
  if (!Object.keys(map.lines).some((key) => key.endsWith(suffix))) return map;
  const lines: Record<string, EnvSessionLine> = {};
  for (const [key, line] of Object.entries(map.lines)) {
    if (!key.endsWith(suffix)) lines[key] = line;
  }
  return { version: 1, lines };
}

/**
 * 1.3.3 历史面板 — 反查某 loopSessionId 属于哪个环境线:扫描指定 workspace
 * 前缀下的行,命中返回行键后缀(环境键:env:<id> / recipe:<instanceId> / host);
 * 无映射/跨 workspace → null。GET /sessions 用它给列表行补 envKey 分组字段。
 */
export function findEnvKeyForLoopSession(
  map: EnvSessionsMap,
  workspace: string,
  loopSessionId: string,
): string | null {
  const prefix = `${normalizeWorkspaceKey(workspace)}::`;
  for (const [key, line] of Object.entries(map.lines)) {
    if (key.startsWith(prefix) && line.loopSessionId === loopSessionId) {
      return key.slice(prefix.length);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Thin IO — path injectable for tests；写走 withFileLock + tmp+rename
// ---------------------------------------------------------------------------

/** 默认落盘路径：~/.zhishi/env-sessions.json。 */
export function defaultEnvSessionsPath(): string {
  return join(getZhiShiDataDir(), 'env-sessions.json');
}

/** Missing / unreadable / corrupt file → empty map（读不持锁，同 loadLoopSession）。 */
export function loadEnvSessionsMap(path: string = defaultEnvSessionsPath()): EnvSessionsMap {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return emptyEnvSessionsMap();
  }
  return parseEnvSessionsMap(raw);
}

/** 锁内读-改-写（tmp+rename 原子替换）：并发写串行化，无丢更新。 */
async function mutateEnvSessionsMap(
  mutate: (map: EnvSessionsMap) => EnvSessionsMap,
  path: string = defaultEnvSessionsPath(),
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await withFileLock({ lockPath: `${path}.lock` }, async () => {
    const current = loadEnvSessionsMap(path);
    const next = mutate(current);
    if (next === current) return; // 无改动不写盘（remove 未命中等）
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, serializeEnvSessionsMap(next), 'utf-8');
    renameSync(tmp, path);
  });
}

/** 写/刷新一条分线映射（某 workspace 的某环境键 → loopSessionId）。 */
export async function setEnvSessionLine(
  workspace: string,
  envKey: string,
  loopSessionId: string,
  path: string = defaultEnvSessionsPath(),
): Promise<void> {
  const updatedAt = new Date().toISOString();
  await mutateEnvSessionsMap(
    (map) => setEnvSessionLineInMap(map, workspace, envKey, loopSessionId, updatedAt),
    path,
  );
}

/** 删一条分线映射（reset 一致性：防 reset 后旧历史按映射复活）。 */
export async function removeEnvSessionLine(
  workspace: string,
  envKey: string,
  path: string = defaultEnvSessionsPath(),
): Promise<void> {
  await mutateEnvSessionsMap((map) => removeEnvSessionLineFromMap(map, workspace, envKey), path);
}

/** 清某 envId 的全部分线残留（环境删除时顺手调用）。 */
export async function removeEnvSessionsForEnvId(
  envId: string,
  path: string = defaultEnvSessionsPath(),
): Promise<void> {
  await mutateEnvSessionsMap((map) => removeEnvSessionsForEnvIdFromMap(map, envId), path);
}
