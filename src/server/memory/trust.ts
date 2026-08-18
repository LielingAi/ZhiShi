/**
 * 信任账本（宪章 §5.1：自主不是开关，是挣来的）——Node + memory.db 实现。
 *
 * 从 src-tauri/src/trust.rs 迁来（原 trust.json 时代）：任务状态迁移记账，
 * 被验证的完成是存款，返工/否决是取款；跨过阈值挂「建议」——只是建议，
 * 采纳与否永远由用户决定（§8.4），账本对用户完全透明可重置（§7.4）。
 *
 * 写路径：Rust TaskStore::update_status 的钩子 record_transition → POST
 * 本模块（sidecar admin trust/event），sidecar 不可用则落 trust.json 缓冲，
 * 下次启动导入。
 */
import type { SqliteDatabase } from './store';
import { openTrustDb } from './store';

// ===== 规则（与 Rust trust.rs 一致，单一事实源） =====

export const TRUST_UPGRADE_THRESHOLD = 10;
export const TRUST_DOWNGRADE_THRESHOLD = -6;

export type TransitionActor = 'system' | 'user' | 'agent';

export interface TrustTransitionInput {
  taskId: string;
  taskName: string;
  from: string;
  to: string;
  actor: TransitionActor;
  source?: string;
}

export interface TrustEvent {
  ts: number;
  taskId: string;
  taskName: string;
  kind: string;
  delta: number;
  reason: string;
  scoreAfter: number;
}

export interface TrustLedgerView {
  score: number;
  baselineScore: number;
  suggestion: { direction: string; createdAt: number } | null;
  events: TrustEvent[];
}

/** 状态迁移 → 记账条目；null = 不记账。 */
export function classifyTransition(input: TrustTransitionInput): { delta: number; reason: string } | null {
  const { from, to, actor, source } = input;
  // 返工：一次"完成"被推翻。source=rerun 是用户主动重跑（再上膛），不是否定。
  if (from === 'done' && to === 'running' && source !== 'rerun') {
    return { delta: -3, reason: 'rework' };
  }
  // 否决：人在它干活中途叫停。
  if ((from === 'running' || from === 'verifying') && to === 'stopped' && actor === 'user') {
    return { delta: -2, reason: 'user_stopped' };
  }
  if (to === 'done' && actor === 'user') return { delta: 2, reason: 'user_done' };
  if (to === 'done' && actor === 'agent') return { delta: 1, reason: 'agent_done' };
  if (to === 'done' && actor === 'system') return { delta: 1, reason: 'system_done' };
  return null;
}

// ===== meta 存取 =====

function metaGet(db: SqliteDatabase, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM trust_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

function metaSet(db: SqliteDatabase, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO trust_meta (key, value) VALUES (?, ?)').run(key, value);
}

function getScore(db: SqliteDatabase): number {
  return Number(metaGet(db, 'score') ?? 0) || 0;
}

function getBaseline(db: SqliteDatabase): number {
  return Number(metaGet(db, 'baselineScore') ?? 0) || 0;
}

function getSuggestion(db: SqliteDatabase): { direction: string; createdAt: number } | null {
  const raw = metaGet(db, 'suggestion');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { direction: string; createdAt: number };
  } catch {
    return null;
  }
}

/** 记账后按阈值维护 pending 建议（只在无 pending 时挂）。 */
function maybeSuggest(db: SqliteDatabase, score: number, baseline: number): void {
  if (getSuggestion(db)) return;
  const delta = score - baseline;
  if (delta >= TRUST_UPGRADE_THRESHOLD) {
    metaSet(db, 'suggestion', JSON.stringify({ direction: 'upgrade', createdAt: Date.now() }));
  } else if (delta <= TRUST_DOWNGRADE_THRESHOLD) {
    metaSet(db, 'suggestion', JSON.stringify({ direction: 'downgrade', createdAt: Date.now() }));
  }
}

// ===== 公开 API =====

/** 记一笔状态迁移（Rust 钩子经 admin trust/event 调用）。返回是否记账。 */
export function recordTrustTransition(input: TrustTransitionInput): boolean {
  const classified = classifyTransition(input);
  if (!classified) return false;
  const db = openTrustDb();
  const score = getScore(db) + classified.delta;
  db.prepare(
    'INSERT INTO trust_events (ts, task_id, task_name, kind, delta, reason, score_after) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    Date.now(),
    input.taskId,
    input.taskName,
    classified.delta >= 0 ? 'deposit' : 'withdrawal',
    classified.delta,
    classified.reason,
    score,
  );
  metaSet(db, 'score', String(score));
  maybeSuggest(db, score, getBaseline(db));
  return true;
}

export function readTrustLedger(limit = 200): TrustLedgerView {
  const db = openTrustDb();
  const rows = db
    .prepare('SELECT * FROM trust_events ORDER BY ts DESC LIMIT ?')
    .all(limit) as Array<{ ts: number; task_id: string; task_name: string; kind: string; delta: number; reason: string; score_after: number }>;
  return {
    score: getScore(db),
    baselineScore: getBaseline(db),
    suggestion: getSuggestion(db),
    events: rows.map((r) => ({
      ts: r.ts,
      taskId: r.task_id,
      taskName: r.task_name,
      kind: r.kind,
      delta: r.delta,
      reason: r.reason,
      scoreAfter: r.score_after,
    })),
  };
}

/** 处置 pending 建议（采纳/忽略）：baseline 对齐当前分 + 留 decision 事件。 */
export function resolveTrustSuggestion(accepted: boolean): TrustLedgerView {
  const db = openTrustDb();
  const suggestion = getSuggestion(db);
  if (!suggestion) return readTrustLedger();
  const score = getScore(db);
  metaSet(db, 'baselineScore', String(score));
  db.prepare('DELETE FROM trust_meta WHERE key = ?').run('suggestion');
  db.prepare(
    'INSERT INTO trust_events (ts, task_id, task_name, kind, delta, reason, score_after) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    Date.now(),
    '',
    '',
    'decision',
    0,
    `suggestion_${accepted ? 'accepted' : 'dismissed'}_${suggestion.direction}`,
    score,
  );
  return readTrustLedger();
}

/** 重置账本（§7.4 删除权）：分数、事件、建议全部清零。 */
export function resetTrustLedger(): TrustLedgerView {
  const db = openTrustDb();
  db.exec('DELETE FROM trust_events; DELETE FROM trust_meta;');
  return readTrustLedger();
}

/**
 * 合并 trust.json 缓冲（sidecar 不在场时 Rust 钩子的落盘缓冲）。
 *
 * 与旧实现不同：不再「DB 非空就整段跳过」，而是把缓冲里尚未落库的事件
 * append 进 trust_events，并以事件实际 score_after 重新对齐 meta 里的 score。
 * 这样 sidecar 短暂离线期间 Rust 写进 trust.json 的记账不会被永久丢失
 *（旧逻辑下一旦 DB 已有事件，缓冲永不回填，导致账本相对真实完成数「空/卡住」）。
 */
export function importTrustBuffer(ledger: {
  score?: number;
  baselineScore?: number;
  events?: Array<{ ts: number; taskId: string; taskName: string; kind: string; delta: number; reason: string; scoreAfter: number }>;
}): void {
  const events = ledger.events ?? [];
  if (events.length === 0) {
    // 即便没有缓冲事件，也确保 baseline 在首次导入时被建立。
    if (ledger.baselineScore != null) {
      const db0 = openTrustDb();
      if (getBaseline(db0) === 0) metaSet(db0, 'baselineScore', String(ledger.baselineScore));
    }
    return;
  }
  const db = openTrustDb();
  const have = db.prepare(
    'SELECT COUNT(*) AS c FROM trust_events WHERE ts = ? AND task_id = ? AND reason = ?',
  );
  const insert = db.prepare(
    'INSERT INTO trust_events (ts, task_id, task_name, kind, delta, reason, score_after) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  let added = 0;
  for (const e of events) {
    const hit = (have.get(e.ts, e.taskId, e.reason) as { c: number }).c;
    if (hit > 0) continue;
    insert.run(e.ts, e.taskId, e.taskName, e.kind, e.delta, e.reason, e.scoreAfter);
    added++;
  }
  if (added === 0) return;
  // 以全部事件里出现过的 score_after 重新对齐 score（取最大值，等价于顺序累加的终值）。
  const row = db
    .prepare('SELECT MAX(score_after) AS m, COUNT(*) AS c FROM trust_events')
    .get() as { m: number | null; c: number };
  if (row.c > 0) metaSet(db, 'score', String(row.m ?? 0));
}
