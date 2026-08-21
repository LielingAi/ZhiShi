/**
 * 安全研究员版 P1 T4（D17）— environment selection store（环境选定状态）.
 *
 * `zhishi agent` 首屏强制由人选定现场（运行中环境 / 配方新建 / 仅工作区
 * 控制面），选定结果落盘到 `~/.zhishi/env-selection.json`，按 workspace
 * 路径索引。后续 S1（能力清单注入）按同一结构读本文件——**结构稳定性是
 * 契约**，改 shape 必须同步 S1。
 *
 * 落盘格式：
 *
 *   {
 *     "version": 1,
 *     "workspaces": {
 *       "<workspace 绝对路径>": {
 *         "selection": { "kind": "env", "id": "dev-box" }
 *                    | { "kind": "recipe", "name": "pwn", "instanceId": "zhishi-pwn-a3f2" }
 *                    | { "kind": "host" },
 *         "selectedAt": "<ISO-8601>"
 *       }
 *     }
 *   }
 *
 * 缺省语义：文件不存在 / 损坏 / workspace 无记录 → host（仅工作区控制面）。
 * 结构照 `registry.ts`：校验、parse/serialize、按 workspace 读写都是纯
 * 函数（可单测）；IO 只有 load/save/mutate 三组薄函数，路径可注入（测试
 * 传临时目录）。写盘纪律同 env-sessions.ts：读-改-写必须走 mutate 的
 * withFileLock 锁内 + tmp+rename 原子替换（多实例共用数据目录时裸读-改-写
 * 有丢更新窗口），读盘裸读（与 loadLoopSession 同惯例）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getZhiShiDataDir } from '../utils/app-dirs';
import { withFileLock } from '../utils/file-lock';

// ---------------------------------------------------------------------------
// Types（S1 契约——勿随意改 shape）
// ---------------------------------------------------------------------------

/** 一次环境选定：具名环境 / 配方实例 / 仅工作区控制面。 */
export type EnvSelection =
  | { kind: 'env'; id: string }
  | { kind: 'recipe'; name: string; instanceId: string }
  | { kind: 'host' };

export const HOST_SELECTION: EnvSelection = { kind: 'host' };

export interface WorkspaceSelectionRecord {
  selection: EnvSelection;
  /** ISO-8601 选定时间。 */
  selectedAt: string;
}

export interface EnvSelectionStore {
  version: 1;
  workspaces: Record<string, WorkspaceSelectionRecord>;
}

export type SelectionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Pure — validation / store transforms
// ---------------------------------------------------------------------------

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function readRequiredString(source: Record<string, unknown>, field: string): string | null {
  const raw = source[field];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

/**
 * Validate a raw `environment/select` payload selection. Unknown extra fields
 * are ignored (forward-compatible); missing/wrong-typed required fields fail.
 */
export function validateEnvSelection(input: unknown): SelectionResult<{ selection: EnvSelection }> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return fail('selection 需要对象：{kind:"env",id} | {kind:"recipe",name,instanceId} | {kind:"host"}');
  }
  const source = input as Record<string, unknown>;
  switch (source.kind) {
    case 'host':
      return { ok: true, selection: { kind: 'host' } };
    case 'env': {
      const id = readRequiredString(source, 'id');
      if (!id) return fail('selection kind=env 缺少必填字段：id（非空字符串）');
      return { ok: true, selection: { kind: 'env', id } };
    }
    case 'recipe': {
      const name = readRequiredString(source, 'name');
      const instanceId = readRequiredString(source, 'instanceId');
      if (!name) return fail('selection kind=recipe 缺少必填字段：name（非空字符串）');
      if (!instanceId) return fail('selection kind=recipe 缺少必填字段：instanceId（非空字符串）');
      return { ok: true, selection: { kind: 'recipe', name, instanceId } };
    }
    default:
      return fail(`selection kind 非法：${JSON.stringify(source.kind)}（可选：env / recipe / host）`);
  }
}

export function emptySelectionStore(): EnvSelectionStore {
  return { version: 1, workspaces: {} };
}

/**
 * Parse raw file content into a store. Corrupt JSON / wrong top-level shape →
 * empty store; individual corrupt workspace records are dropped (a hand-edit
 * gone wrong must never wedge the first screen).
 */
export function parseSelectionStore(raw: string): EnvSelectionStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptySelectionStore();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptySelectionStore();
  const source = parsed as Record<string, unknown>;
  if (source.version !== 1 || !source.workspaces || typeof source.workspaces !== 'object' || Array.isArray(source.workspaces)) {
    return emptySelectionStore();
  }
  const store = emptySelectionStore();
  for (const [workspace, record] of Object.entries(source.workspaces as Record<string, unknown>)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const rec = record as Record<string, unknown>;
    const validated = validateEnvSelection(rec.selection);
    if (!validated.ok) continue;
    store.workspaces[workspace] = {
      selection: validated.selection,
      selectedAt: typeof rec.selectedAt === 'string' ? rec.selectedAt : '',
    };
  }
  return store;
}

export function serializeSelectionStore(store: EnvSelectionStore): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

/** Missing workspace → host（D17 缺省：仅工作区控制面）。 */
export function getWorkspaceSelection(store: EnvSelectionStore, workspace: string): EnvSelection {
  return store.workspaces[workspace]?.selection ?? HOST_SELECTION;
}

/** Full record (incl. selectedAt) when present; undefined when never selected. */
export function getWorkspaceSelectionRecord(
  store: EnvSelectionStore,
  workspace: string,
): WorkspaceSelectionRecord | undefined {
  return store.workspaces[workspace];
}

/** Non-mutating set: returns a new store with the workspace entry replaced. */
export function setWorkspaceSelection(
  store: EnvSelectionStore,
  workspace: string,
  selection: EnvSelection,
  selectedAt: string,
): EnvSelectionStore {
  return {
    version: 1,
    workspaces: { ...store.workspaces, [workspace]: { selection, selectedAt } },
  };
}

/**
 * 状态行/日志用的短标记。env 条目在服务端无法分辨 ssh/vm/docker（要看
 * registry 条目），选择器按条目数据给出精确 tag，这里只兜底：
 *   host                       → host
 *   env:<id>                   → env:<id>
 *   recipe:<name>@<instanceId> → docker:<instanceId>（配方实例都是 docker）
 */
export function selectionTag(selection: EnvSelection): string {
  switch (selection.kind) {
    case 'host':
      return 'host';
    case 'env':
      return `env:${selection.id}`;
    case 'recipe':
      return `docker:${selection.instanceId}`;
  }
}

// ---------------------------------------------------------------------------
// Thin IO — path injectable for tests；读-改-写走 withFileLock + tmp+rename
// ---------------------------------------------------------------------------

/** 默认落盘路径：~/.zhishi/env-selection.json。 */
export function defaultSelectionStorePath(): string {
  return join(getZhiShiDataDir(), 'env-selection.json');
}

/** Missing / unreadable / corrupt file → empty store（首屏永不被本文件卡死；读不持锁，同 loadLoopSession）。 */
export function loadSelectionStore(path: string = defaultSelectionStorePath()): EnvSelectionStore {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return emptySelectionStore();
  }
  return parseSelectionStore(raw);
}

/** 整店覆盖写（tmp+rename 原子替换）。调用方有读-改-写语义时必须改用 mutateSelectionStore。 */
export function saveSelectionStore(store: EnvSelectionStore, path: string = defaultSelectionStorePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, serializeSelectionStore(store), 'utf-8');
  renameSync(tmp, path);
}

/** 锁内读-改-写（tmp+rename 原子替换）：并发写串行化，无丢更新。 */
export async function mutateSelectionStore(
  mutate: (store: EnvSelectionStore) => EnvSelectionStore,
  path: string = defaultSelectionStorePath(),
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await withFileLock({ lockPath: `${path}.lock` }, async () => {
    const current = loadSelectionStore(path);
    const next = mutate(current);
    if (next === current) return; // 无改动不写盘
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, serializeSelectionStore(next), 'utf-8');
    renameSync(tmp, path);
  });
}
