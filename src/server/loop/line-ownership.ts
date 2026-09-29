/**
 * 1.8.7 P3b 团队大脑——研究线归属元数据（双线制：私有线默认 + 共享线）。
 *
 * 每条 loop 会话线（loop-sessions/<id>.jsonl）两个归属字段：
 *   - owner：actor 名（P2 身份贯穿的请求 actor；缺省 = 归属未知）；
 *   - shared：是否共享线（缺省 false = 私有线）。
 *
 * 落盘 `~/.zhishi/line-ownership.json`：
 *
 *   { "version": 1, "lines": { "<loopSessionId>": { "owner": "alice",
 *     "shared": false, "updatedAt": "<ISO-8601>" } } }
 *
 * 为什么独立成店（不挂 SessionStore meta / 不进 env-sessions 行）：归属是
 * 线的属性，与「哪个环境键映射到它」（env-sessions 会随 share/unshare 换
 * 键）和「有没有 SessionStore 绑定」（fork/首条消息前无 meta）都正交；
 * 权限判定按 loopSessionId 直查一张小表最稳。
 *
 * 归属未知（旧线，1.8.6 时代及 P3a 之前创建的线没有记录）的文档化缺省：
 * **人人可读，operator+ 可写**（见 auth/line-access.ts）——团队模式下旧线
 * 行为与升级前一致，不把人锁在自己的历史线外。
 *
 * 结构照 env-sessions.ts：校验、parse/serialize、行变换都是纯函数（可单测）；
 * IO 只有 load/mutate 两组薄函数，路径可注入（测试传临时目录）。写盘走
 * withFileLock + tmp+rename（与 env-sessions/SessionStore 同一惯例），读盘
 * 裸读（与 loadLoopSession 同惯例）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getZhiShiDataDir } from '../utils/app-dirs';
import { withFileLock } from '../utils/file-lock';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 一条线的归属元数据。owner 缺席 = 归属未知（旧线）；shared 缺席 = 私有。 */
export interface LineOwnership {
  owner?: string;
  shared?: boolean;
  /** ISO-8601 最近写盘时间。 */
  updatedAt: string;
}

export interface LineOwnershipStore {
  version: 1;
  lines: Record<string, LineOwnership>;
}

// ---------------------------------------------------------------------------
// Pure — parse / serialize / transforms
// ---------------------------------------------------------------------------

export function emptyLineOwnershipStore(): LineOwnershipStore {
  return { version: 1, lines: {} };
}

/** Parse raw file content. 损坏 JSON / 顶层形状错 → 空店；单行坏 → 丢该行
 *  （手改翻车不许卡死权限判定，与 env-sessions.ts 同口径）。 */
export function parseLineOwnershipStore(raw: string): LineOwnershipStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyLineOwnershipStore();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyLineOwnershipStore();
  const source = parsed as Record<string, unknown>;
  if (source.version !== 1 || !source.lines || typeof source.lines !== 'object' || Array.isArray(source.lines)) {
    return emptyLineOwnershipStore();
  }
  const store = emptyLineOwnershipStore();
  for (const [id, line] of Object.entries(source.lines as Record<string, unknown>)) {
    if (!id || !line || typeof line !== 'object' || Array.isArray(line)) continue;
    const rec = line as Record<string, unknown>;
    const entry: LineOwnership = { updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : '' };
    if (typeof rec.owner === 'string' && rec.owner) entry.owner = rec.owner;
    if (rec.shared === true) entry.shared = true;
    store.lines[id] = entry;
  }
  return store;
}

export function serializeLineOwnershipStore(store: LineOwnershipStore): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

/** 查行；无记录 → undefined（调用方按「归属未知」缺省处理）。 */
export function getLineOwnershipFromStore(
  store: LineOwnershipStore,
  loopSessionId: string,
): LineOwnership | undefined {
  return store.lines[loopSessionId];
}

/** Non-mutating upsert：合并写入（只动传入字段），刷新 updatedAt。
 *  shared 只持久化 true（false 存为缺省——与 SessionStore favorite 同口径
 *  的零成本语义;parse 侧 absent = 私有,round-trip 对称）。 */
export function upsertLineOwnershipInStore(
  store: LineOwnershipStore,
  loopSessionId: string,
  patch: { owner?: string; shared?: boolean },
  updatedAt: string,
): LineOwnershipStore {
  const prev = store.lines[loopSessionId];
  const shared = patch.shared !== undefined ? patch.shared : prev?.shared;
  const next: LineOwnership = {
    ...(patch.owner !== undefined ? { owner: patch.owner } : prev?.owner !== undefined ? { owner: prev.owner } : {}),
    ...(shared === true ? { shared: true } : {}),
    updatedAt,
  };
  if (prev && prev.owner === next.owner && (prev.shared === true) === (next.shared === true)) return store;
  return { version: 1, lines: { ...store.lines, [loopSessionId]: next } };
}

// ---------------------------------------------------------------------------
// Thin IO — path injectable for tests；写走 withFileLock + tmp+rename
// ---------------------------------------------------------------------------

/** 默认落盘路径：~/.zhishi/line-ownership.json。 */
export function defaultLineOwnershipPath(): string {
  return join(getZhiShiDataDir(), 'line-ownership.json');
}

/** Missing / unreadable / corrupt file → empty store（读不持锁，同 loadLoopSession）。 */
export function loadLineOwnershipStore(path: string = defaultLineOwnershipPath()): LineOwnershipStore {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return emptyLineOwnershipStore();
  }
  return parseLineOwnershipStore(raw);
}

/** 便捷直查：某线的归属（无记录 → undefined = 归属未知旧线）。 */
export function getLineOwnership(
  loopSessionId: string,
  path: string = defaultLineOwnershipPath(),
): LineOwnership | undefined {
  if (!loopSessionId) return undefined;
  return getLineOwnershipFromStore(loadLineOwnershipStore(path), loopSessionId);
}

/** 锁内读-改-写（tmp+rename 原子替换）：并发写串行化，无丢更新。 */
async function mutateLineOwnershipStore(
  mutate: (store: LineOwnershipStore) => LineOwnershipStore,
  path: string = defaultLineOwnershipPath(),
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await withFileLock({ lockPath: `${path}.lock` }, async () => {
    const current = loadLineOwnershipStore(path);
    const next = mutate(current);
    if (next === current) return; // 无改动不写盘
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, serializeLineOwnershipStore(next), 'utf-8');
    renameSync(tmp, path);
  });
}

/**
 * 登记线的 owner（仅当尚未有归属——旧线/新线首次写盘时补登；已有归属
 * 不覆盖，unshare 的改归属走 setLineShared 显式路径）。
 */
export async function ensureLineOwner(
  loopSessionId: string,
  owner: string,
  path: string = defaultLineOwnershipPath(),
): Promise<void> {
  if (!loopSessionId || !owner) return;
  await mutateLineOwnershipStore((store) => {
    const prev = getLineOwnershipFromStore(store, loopSessionId);
    if (prev?.owner) return store; // 已有归属不动
    return upsertLineOwnershipInStore(store, loopSessionId, { owner }, new Date().toISOString());
  }, path);
}

/** share/unshare：改 shared 标记；unshare 时顺带把归属改登记给 caller。 */
export async function setLineShared(
  loopSessionId: string,
  shared: boolean,
  owner: string | undefined,
  path: string = defaultLineOwnershipPath(),
): Promise<void> {
  if (!loopSessionId) return;
  await mutateLineOwnershipStore(
    (store) => upsertLineOwnershipInStore(store, loopSessionId, { shared, ...(owner !== undefined ? { owner } : {}) }, new Date().toISOString()),
    path,
  );
}
