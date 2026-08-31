/**
 * 1.3.3 历史面板纯函数层：会话清单（分组/排序/过滤）+ wire transcript
 * 归一（服务端字段 → 现有 reducer/blocks 可吃形状 → 只读 SessionState）。
 *
 * 只读回看的核心约束：**不干扰活跃流的 store 状态**——wire 回放在这里从
 * emptySession 起步，走 reducer 的 chat:message-replay 路径重建块（决策块 /
 * 工具卡 / 折叠照常），产物是独立 SessionState，由 HistoryPanel 组件局部
 * 持有，绝不写回 store.sessions。
 *
 * 纯函数：不 import store / React / client；单测覆盖分组与回放。
 */

import { emptySession, type SessionState } from './blocks';
import { reduceSseEvent } from './reducer';

// ---------------------------------------------------------------------------
// 会话清单行（GET /sessions 的 SessionMetadata，逐字段声明最小面）
// ---------------------------------------------------------------------------

export interface SessionMetaRow {
  /** meta id（PATCH/DELETE/switch 的定位键）。 */
  id: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  /** wire 回看端点要的 loop-sessions id（旧行可能没有）。 */
  loopSessionId?: string;
  lastMessagePreview?: string;
  messageCount: number;
  /** 1.3.3 置顶（排序信号）。 */
  pinned?: boolean;
  /** 1.3.3 归档（默认藏到「已归档」折叠组）。 */
  archived?: boolean;
  /** 1.3.3 服务端补的环境分线键（无映射/宿主线可能缺省）。 */
  envKey?: string;
}

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** 服务端行 → SessionMetaRow（形状不合返回 null，调用方过滤）。 */
export function parseSessionRow(raw: unknown): SessionMetaRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = strOf(r.id);
  if (!id) return null;
  const stats =
    r.stats && typeof r.stats === 'object' && !Array.isArray(r.stats)
      ? (r.stats as Record<string, unknown>)
      : {};
  const row: SessionMetaRow = {
    id,
    title: strOf(r.title) ?? 'New Chat',
    createdAt: strOf(r.createdAt) ?? '',
    lastActiveAt: strOf(r.lastActiveAt) ?? '',
    messageCount: typeof stats.messageCount === 'number' && stats.messageCount > 0 ? stats.messageCount : 0,
  };
  const loopSessionId = strOf(r.loopSessionId);
  if (loopSessionId) row.loopSessionId = loopSessionId;
  const preview = strOf(r.lastMessagePreview);
  if (preview) row.lastMessagePreview = preview;
  if (r.pinned === true) row.pinned = true;
  if (r.archived === true) row.archived = true;
  const envKey = strOf(r.envKey);
  if (envKey) row.envKey = envKey;
  return row;
}

/** 服务端 sessions 数组 → 行数组（非法行静默丢弃）。 */
export function parseSessionRows(raw: unknown): SessionMetaRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: SessionMetaRow[] = [];
  for (const item of raw) {
    const row = parseSessionRow(item);
    if (row) rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 排序 / 过滤 / 分组
// ---------------------------------------------------------------------------

/** 行排序：置顶优先；其余按 lastActiveAt 降序（时间戳缺失/非法排末尾）。 */
export function sortSessionRows(rows: SessionMetaRow[]): SessionMetaRow[] {
  return [...rows].sort((a, b) => {
    if ((a.pinned === true) !== (b.pinned === true)) return a.pinned === true ? -1 : 1;
    const ta = Date.parse(a.lastActiveAt) || 0;
    const tb = Date.parse(b.lastActiveAt) || 0;
    return tb - ta;
  });
}

/** 客户端搜索：title + 预览 不区分大小写子串匹配。 */
export function filterSessionRows(rows: SessionMetaRow[], query: string): SessionMetaRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(
    (r) =>
      r.title.toLowerCase().includes(q) ||
      (r.lastMessagePreview ?? '').toLowerCase().includes(q),
  );
}

export interface SessionGroup {
  key: string;
  label: string;
  /** 置顶组（列表顶部，跨环境）。 */
  pinned?: boolean;
  /** 归档组（底部折叠）。 */
  archived?: boolean;
  rows: SessionMetaRow[];
}

/**
 * 分组：置顶组 → 按 envKey 分线组（组序 = 组内最新 lastActiveAt，宿主线
 * 排最后）→ 「已归档」折叠组。无 envKey 的行归宿主线（label '宿主'）。
 */
export function groupSessionRows(
  rows: SessionMetaRow[],
  opts: { showArchived?: boolean } = {},
): SessionGroup[] {
  const sorted = sortSessionRows(rows);
  const pinned: SessionMetaRow[] = [];
  const archived: SessionMetaRow[] = [];
  const envOrder: string[] = [];
  const byEnv = new Map<string, SessionMetaRow[]>();
  for (const r of sorted) {
    if (r.archived === true) {
      archived.push(r);
      continue;
    }
    if (r.pinned === true) {
      pinned.push(r);
      continue;
    }
    const key = r.envKey ?? 'host';
    const list = byEnv.get(key);
    if (list) list.push(r);
    else {
      byEnv.set(key, [r]);
      envOrder.push(key);
    }
  }
  const groups: SessionGroup[] = [];
  if (pinned.length > 0) groups.push({ key: 'pinned', label: '置顶', pinned: true, rows: pinned });
  // 组序：按组内最新时间降序；宿主线最后（env 线通常更「近」也避免与置顶混）。
  envOrder.sort((a, b) => {
    if (a === 'host') return 1;
    if (b === 'host') return -1;
    const ta = Date.parse(byEnv.get(a)![0].lastActiveAt) || 0;
    const tb = Date.parse(byEnv.get(b)![0].lastActiveAt) || 0;
    return tb - ta;
  });
  for (const key of envOrder) {
    groups.push({ key: `env:${key}`, label: key === 'host' ? '宿主' : key, rows: byEnv.get(key)! });
  }
  if (archived.length > 0 && opts.showArchived !== false) {
    groups.push({ key: 'archived', label: '已归档', archived: true, rows: archived });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// wire transcript 归一 + 只读回放
// ---------------------------------------------------------------------------

/**
 * 服务端 LoopWireMessage（/api/loop-session/messages?format=wire）→
 * reducer chat:message-replay 可吃形状。形状基本逐字段对齐（见
 * src/server/loop/wire-replay.ts 的 LoopWireMessage），这里只做窄化防御：
 * role 白名单 + 字段类型校验，1.3.2 决策块 additive 字段原样透传。
 */
export function normalizeWireMessage(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const role = m.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') return null;
  const out: Record<string, unknown> = {
    role,
    ...(strOf(m.id) ? { id: strOf(m.id) } : {}),
    content: typeof m.content === 'string' ? m.content : '',
  };
  if (typeof m.name === 'string' && m.name) out.name = m.name;
  if (typeof m.ok === 'boolean') out.ok = m.ok;
  if (m.kind === 'decision') {
    out.kind = 'decision';
    const decisionId = strOf(m.decisionId);
    if (decisionId) out.decisionId = decisionId;
    const choice = strOf(m.choice);
    if (choice) out.choice = choice;
    const note = strOf(m.note);
    if (note) out.note = note;
    if (Array.isArray(m.expertRefs)) {
      out.expertRefs = m.expertRefs.filter((x): x is string => typeof x === 'string');
    }
  }
  return out;
}

/**
 * wire 消息数组 → 只读 SessionState。逐条经 reducer 的 replay 路径重建
 * （与 /chat/stream 重放同一套归约），末尾补 message-complete 把最后一块
 * 从 running 落定为 complete（渲染层按 status 折叠细节）。
 *
 * 已知取舍（与 live replay 同源）：
 *   - thinking 段不在 wire 里（服务端刻意不重放）；
 *   - steering 徽标不恢复（wire 无 queueId，服务端 LoopWireMessage 不带）。
 */
export function buildHistorySession(messages: unknown[]): SessionState {
  let session = emptySession();
  for (const raw of messages) {
    const m = normalizeWireMessage(raw);
    if (!m) continue;
    session = reduceSseEvent(session, {
      event: 'chat:message-replay',
      payload: { message: m },
    }).session;
  }
  session = reduceSseEvent(session, { event: 'chat:message-complete', payload: {} }).session;
  return session;
}

// ---------------------------------------------------------------------------
// 1.4.6 auto-run 历史合成行（invoke 通道无会话元绑定——run 的 loop 会话不进
// sessions 清单，合成行使轨迹/研究档案在历史回看可达）
// ---------------------------------------------------------------------------

export interface AutoRunLike {
  id: string;
  name: string;
  envKey: string;
  loopSessionId?: string;
  updatedAt: number;
}

/** auto-run 记录 → 历史合成行（⚡ 前缀标识；无 loop 线的记录丢弃）。 */
export function autoRunRowsOf(runs: AutoRunLike[]): SessionMetaRow[] {
  return runs
    .filter((r) => r.loopSessionId)
    .map((r) => ({
      id: `auto-run:${r.id}`,
      title: `⚡ ${r.name}`,
      createdAt: '',
      lastActiveAt: r.updatedAt > 0 ? new Date(r.updatedAt).toISOString() : '',
      messageCount: 0,
      ...(r.loopSessionId ? { loopSessionId: r.loopSessionId } : {}),
      envKey: r.envKey,
    }));
}

/** 合并合成行（loopSessionId 去重——会话元里已有同线行时不重复）。 */
export function mergeAutoRunRows(rows: SessionMetaRow[], runRows: SessionMetaRow[]): SessionMetaRow[] {
  const existing = new Set(rows.map((r) => r.loopSessionId).filter(Boolean));
  return [...rows, ...runRows.filter((r) => !r.loopSessionId || !existing.has(r.loopSessionId))];
}

/**
 * 1.4.7 SSE 漏面收口：chat:session-title-changed 消费——auto-titler/人改
 * 标题后，历史清单已加载的行就地换标题（不重拉）。payload 的 sessionId
 * 是 SessionStore 元 id（与行 id 同键）；未加载（null）→ 原样返回。
 */
export function applySessionTitleChange(
  rows: SessionMetaRow[] | null,
  input: { sessionId?: unknown; title?: unknown },
): SessionMetaRow[] | null {
  if (!rows) return rows;
  const id = typeof input.sessionId === 'string' ? input.sessionId : '';
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!id || !title) return rows;
  let changed = false;
  const next = rows.map((r) => {
    if (r.id !== id) return r;
    changed = true;
    return { ...r, title };
  });
  return changed ? next : rows;
}
