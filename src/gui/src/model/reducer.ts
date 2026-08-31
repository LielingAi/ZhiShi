/**
 * 事件 → 块的归约层（1.3.0 GUI MVP，纯函数）。
 *
 * 消费 `src/server/loop/sse-adapter.ts` 定义的事件契约（事件名与 payload
 * 形状逐字段对齐 TUI，服务端零改动）。与 TUI event-reducer 的分工差异：
 * TUI 是平铺 block 列表，GUI 是「块」（turn）容器——归约规则见各 case 注释。
 *
 * 核心归属规则（review 重点）：
 *   - chat:message-replay（role=user）开新块；role=assistant/tool 归入当前块。
 *     用户输入不本地乐观渲染——服务端对每条 user 消息都广播 replay
 *     （chat-engine L713 发送路径 / L782 steering 注入路径），以 wire id 去重。
 *   - 活体事件（chunk/thinking/tool）全部归入「当前块」（streamingTurnId 或
 *     最后一个块；没有则开隐式块）。
 *   - chat:message-stopped / message-error 落流级分隔行，不进块。
 *   - chat:init（每次连接/重连的 replay 前导）：非流式块整体丢弃、摘掉其
 *     srvIds 让 replay 全量重建（同 TUI 1.2.8 H3）；流式块保留壳
 *     （结论文本 + thinking + running 工具卡），已完成工具卡丢弃——wire
 *     里有它们的消息，replay 会重建。
 *
 * 已知取舍（MVP 记录在案）：
 *   - thinking 不进 wire：重连后非流式块的 thinking 细节不重建（TUI 同）。
 *   - 重连落在「多轮 turn 且前几轮有非空 assistant 文本」的窄窗口时，
 *     结论区可能短暂重复前几轮的文本（replay 重建 + 活体结论并存）；
 *     单轮/工具轮（空文本）不受影响。
 *   - chat:boundary-ask / chat:boundary-expired → ReduceResult.boundaryAsk
 *     增量（store 顶层 boundaryAsks 登记表，1.3.1 ②；1.3.2 透传
 *     toolName/toolDescription/options additive 字段）。
 *   - chat:decision-request / chat:decision-resolved → ReduceResult.decisionRequest /
 *     decisionResolved 增量（store 顶层 decisions 登记表，1.3.2 ①）；
 *     chat:init → decisionRequest reset（重连重放先清再建）。
 *   - kind:'decision' 的 user replay → 带 TurnBlock.decision 的琥珀决策块。
 *   - chat:bg-* / chat:subagent-* → ReduceResult.bgEvent / subagentEvent
 *     增量（store 顶层登记表，状态栏后台段 + /tasks 面板，1.3.1 ③）。
 *
 * 纯函数：不 import store / React / client；单测逐事件断言。
 */

import type {
  Phase,
  QueueItem,
  SessionState,
  StreamItem,
  ThinkingDetail,
  ToolDetail,
  TurnBlock,
  TurnDecision,
  TurnMeta,
  TurnStatus,
} from './blocks';
import { summarizeSignal } from './blocks';
import type { BgEvent, SubagentEvent } from './tasks';
import { budgetKindOf, pauseReasonOf, parseVerdictRequest, type AutoRunDelta } from './auto-run';

// ---------------------------------------------------------------------------
// Payload narrowers（wire 是 unknown：pi 引擎裸字符串 / 对象 / null 都有）
// ---------------------------------------------------------------------------

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/** 文本增量：pi 引擎发裸字符串，历史路径发 {delta}。 */
function deltaOf(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  return str(rec(payload).delta) ?? '';
}

/** 工具参数摘要（与 TUI summarizeArgs 同语义）。 */
function summarizeArgs(payload: unknown): string {
  const p = rec(payload);
  if (typeof p.summary === 'string') return p.summary;
  const a = rec(p.input ?? p.args ?? p.arguments);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(a)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${s.slice(0,40)}`);
    if (parts.join(' ').length > 80) break;
  }
  return parts.join(' ') || str(p.name) || 'tool';
}

// ---------------------------------------------------------------------------
// 不可变小工具
// ---------------------------------------------------------------------------

function cloneSession(s: SessionState): SessionState {
  return {
    ...s,
    items: [...s.items],
    seenSrvIds: new Set(s.seenSrvIds),
    queue: [...s.queue],
    steeringIds: [...s.steeringIds],
  };
}

function pushItem(session: SessionState, item: StreamItem): SessionState {
  const s = cloneSession(session);
  s.seq = session.seq + 1;
  s.items.push(item);
  return s;
}

/** 流式中的当前块；没有则最后一个块；再没有则 null。 */
function currentTurn(session: SessionState): TurnBlock | undefined {
  if (session.streamingTurnId) {
    const t = session.items.find(
      (i): i is TurnBlock => i.kind === 'turn' && i.id === session.streamingTurnId,
    );
    if (t) return t;
  }
  for (let i = session.items.length - 1; i >= 0; i--) {
    const it = session.items[i];
    if (it.kind === 'turn' && it.status === 'running') return it;
  }
  return undefined;
}

/** 取最后一个块（任意状态）。 */
function lastTurn(session: SessionState): TurnBlock | undefined {
  for (let i = session.items.length - 1; i >= 0; i--) {
    const it = session.items[i];
    if (it.kind === 'turn') return it;
  }
  return undefined;
}

/** 活体事件落点：流式块 ?? 最后块 ?? 开隐式块。 */
function ensureCurrentTurn(session: SessionState): SessionState {
  const t = currentTurn(session) ?? lastTurn(session);
  if (t && t.status === 'running') return session;
  const now = Date.now();
  const turn: TurnBlock = {
    kind: 'turn',
    id: `turn-${session.seq + 1}`,
    seq: session.seq + 1,
    userText: '',
    steering: false,
    conclusion: '',
    conclusionStreaming: false,
    details: [],
    status: 'running',
    srvIds: [],
    createdAt: now,
  };
  const s = pushItem(session, turn);
  s.streamingTurnId = turn.id;
  return s;
}

/** 把某个块内的细节替换后写回（返回新 session）。 */
function updateTurn(
  session: SessionState,
  turnId: string,
  mutate: (t: TurnBlock) => TurnBlock,
): SessionState {
  const s = cloneSession(session);
  s.items = s.items.map((it) => (it.kind === 'turn' && it.id === turnId ? mutate({ ...it }) : it));
  return s;
}

function findToolDetail(session: SessionState, id: string): ToolDetail | undefined {
  for (const item of session.items) {
    if (item.kind !== 'turn') continue;
    const d = item.details.find((x): x is ToolDetail => x.kind === 'tool' && x.id === id);
    if (d) return d;
  }
  return undefined;
}

/** 服务端 sessionState（'running' | 'idle' | 对象）→ Phase。 */
function phaseOf(ss: unknown, fallback: Phase): Phase {
  if (typeof ss === 'string') return ss === 'running' ? 'running' : 'idle';
  const p = str(rec(ss).phase);
  if (p === 'running' || p === 'idle' || p === 'interrupted' || p === 'error') return p;
  return fallback;
}

function upsertQueue(
  queue: QueueItem[],
  item: QueueItem,
): QueueItem[] {
  const existing = queue.find((q) => q.id === item.id);
  if (existing) return queue.map((q) => (q.id === item.id ? item : q));
  return [...queue, item];
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export interface SseInput {
  event: string;
  payload: unknown;
}

/**
 * 1.3.2 任务二 #2：chat:init 的环境锚（resolveSessionEnvAnchor 形状）。
 * host 会话 = null；kind='env' 时 id = 环境条目 id，kind='recipe' 时
 * id = instanceId（与 GUI 侧栏键/selectionToGuiKey 同口径）。
 */
export interface InitEnvAnchor {
  kind: 'env' | 'recipe';
  id: string;
  name: string;
  type: string;
}

/** chat:init payload 的 environment 字段 → 锚（非 env/recipe 形状回落 null）。 */
export function initAnchorOf(v: unknown): InitEnvAnchor | null {
  if (!v || typeof v !== 'object') return null;
  const p = rec(v);
  const kind = str(p.kind);
  const id = str(p.id);
  if ((kind === 'env' || kind === 'recipe') && id) {
    return { kind, id, name: str(p.name) ?? id, type: str(p.type) ?? '' };
  }
  return null;
}

export interface ReduceResult {
  session: SessionState;
  /** chat:init 携带的 agentDir（工作区）——environment/select 需要。 */
  workspace?: string;
  /** 需要 UI toast 的提示（steering 入队等）。 */
  toast?: string;
  /**
   * 1.3.1 ②：越界 ask 登记表增量（chat:boundary-ask → upsert；
   * chat:boundary-expired → remove）。store 顶层 boundaryAsks 消费。
   */
  boundaryAsk?:
    | { type: 'upsert'; askId: string; kind: string; objects: string[]; toolName?: string; toolDescription?: string; options?: string[] }
    | { type: 'remove'; askId: string };
  /** 1.3.1 ③：后台任务登记表增量（chat:bg-*）。store 顶层 bgTasks 消费。 */
  bgEvent?: BgEvent;
  /** 1.3.1 ③：子代理登记表增量（chat:subagent-*）。store 顶层 subagents 消费。 */
  subagentEvent?: SubagentEvent;
  /**
   * 1.3.2 ①：决策面板登记表增量。chat:init → reset（重连重放会重建全部
   * pending，先清掉已 resolved 的残影）；chat:decision-request → upsert；
   * chat:decision-resolved → remove。store 顶层 decisions 消费。
   */
  decisionRequest?:
    | { type: 'reset' }
    | { type: 'upsert'; decisionId: string; question: string; options: string[]; expertHits: string[] };
  /** 1.3.2 ①：chat:decision-resolved → store 摘除对应 pending。 */
  decisionResolved?: { decisionId: string };
  /**
   * 1.3.3 @ 补全：chat:system-init 广播的工具名清单（会话绑定/切换时刷新）。
   * store 顶层 tools 状态消费。
   */
  tools?: string[];
  /**
   * 1.3.2 任务二 #2：chat:init 环境锚（payload 带 environment 字段时才
   * 设置；null = 宿主线）。store 据此锚定当前环境，免 environment/current
   * 绕行（旧路径保留兜底）。
   */
  environment?: InitEnvAnchor | null;
  /**
   * 1.4.1：auto loop 登记表增量（auto-run:* 事件族）。store 顶层 autoRun
   * 消费，归并逻辑在 model/auto-run.ts::applyAutoRunEvent。
   */
  autoRun?: AutoRunDelta;
}

export function reduceSseEvent(session: SessionState, input: SseInput): ReduceResult {
  const { event: name, payload } = input;
  const p = rec(payload);

  switch (name) {
    // ── 连接 / 重连前导：resync（见文件头「已知取舍」） ──────────────────
    case 'chat:init': {
      const s = cloneSession(session);
      const kept: StreamItem[] = [];
      for (const item of s.items) {
        if (item.kind !== 'turn') continue; // divider/error/sys 丢弃
        if (item.status !== 'running') {
          for (const sid of item.srvIds) s.seenSrvIds.delete(sid);
          continue;
        }
        kept.push({
          ...item,
          details: item.details.filter(
            (d) => d.kind === 'thinking' || d.state === 'running',
          ),
          conclusionStreaming: item.status === 'running' && item.conclusionStreaming,
        });
      }
      s.items = kept;
      s.queue = []; // 旧队列残影先清：replay 末尾服务端补发队列快照
      s.phase = phaseOf(p.sessionState, s.phase);
      const model = str(p.model);
      if (model) s.model = model;
      s.streamingTurnId =
        s.streamingTurnId && kept.some((i) => i.kind === 'turn' && i.id === s.streamingTurnId)
          ? s.streamingTurnId
          : null;
      const workspace = str(p.agentDir);
      return {
        session: s,
        workspace,
        // 1.3.2 ①：决策登记表 reset——重连后服务端会重放全部 pending 决策
        // （含去重），先清掉已 resolved 的本地残影，再由 replay 重建。
        decisionRequest: { type: 'reset' },
        // 1.3.2 任务二 #2：环境锚（payload 带 environment 字段才透出；
        // host = null 也要能区分于「字段缺失」——用 undefined 表示缺失）。
        ...(p.environment !== undefined ? { environment: initAnchorOf(p.environment) } : {}),
      };
    }

    // ── 历史重建（replay，服务端对每条消息都广播；按 wire 顺序重建块） ──
    case 'chat:message-replay': {
      const m = rec(p.message ?? payload);
      const role = str(m.role);
      const srvId = str(m.id);
      if (!role) return { session };
      if (srvId && session.seenSrvIds.has(srvId)) return { session };
      const s = cloneSession(session);
      if (srvId) s.seenSrvIds.add(srvId);

      if (role === 'user') {
        // 新用户消息开新块：先把上一个 running 块落定（steering 在 turn
        // 边界注入，上一块此时应已 complete；replay 历史里的「上一块」同理）。
        s.items = s.items.map((it) => {
          if (it.kind !== 'turn' || it.status !== 'running') return it;
          return { ...it, status: 'complete' as TurnStatus, conclusionStreaming: false };
        });
        const now = Date.now();
        // 1.3.2 ①：kind:'decision' 的 user 消息 → 决策块（琥珀卡渲染；
        // 不按普通 user 气泡）。仍是「块」容器——决策注入后模型的
        // 后续 assistant/tool 消息照常归入本块 conclusion。
        const decision: TurnDecision | undefined =
          m.kind === 'decision'
            ? {
                decisionId: str(m.decisionId) ?? '',
                choice: str(m.choice) ?? '',
                ...(str(m.note) ? { note: str(m.note) } : {}),
                expertRefs: Array.isArray(m.expertRefs)
                  ? m.expertRefs.filter((x): x is string => typeof x === 'string')
                  : [],
              }
            : undefined;
        const turn: TurnBlock = {
          kind: 'turn',
          id: `turn-${s.seq + 1}`,
          seq: s.seq + 1,
          userText: str(m.content) ?? '',
          steering: str(m.queueId) !== undefined && s.steeringIds.includes(str(m.queueId)!),
          decision,
          conclusion: '',
          conclusionStreaming: false,
          details: [],
          status: 'running',
          srvIds: srvId ? [srvId] : [],
          createdAt: now,
        };
        s.seq = s.seq + 1;
        s.items.push(turn);
        s.streamingTurnId = turn.id;
        return { session: s };
      }

      if (role === 'assistant') {
        const text = str(m.content) ?? '';
        const t = currentTurn(s) ?? lastTurn(s);
        if (!t || !text) return { session: s };
        return {
          session: updateTurn(s, t.id, (blk) => ({
            ...blk,
            conclusion: blk.conclusion + text,
            srvIds: srvId && !blk.srvIds.includes(srvId) ? [...blk.srvIds, srvId] : blk.srvIds,
          })),
        };
      }

      if (role === 'tool') {
        const t = currentTurn(s) ?? lastTurn(s);
        if (!t) return { session: s };
        const id = srvId ?? `tool-${s.seq + 1}`;
        const detail: ToolDetail = {
          kind: 'tool',
          id,
          name: str(m.name) ?? 'tool',
          argsSummary: '',
          state: m.ok === false ? 'fail' : 'done',
          output: str(m.content) ?? '',
          step: t.details.filter((x) => x.kind === 'tool').length + 1,
        };
        detail.signal = summarizeSignal(detail.name, detail.output, {
          isError: detail.state === 'fail',
        });
        return {
          session: updateTurn(s, t.id, (blk) => ({
            ...blk,
            details: [...blk.details, detail],
            srvIds: srvId && !blk.srvIds.includes(srvId) ? [...blk.srvIds, srvId] : blk.srvIds,
          })),
        };
      }

      return { session: s };
    }

    // ── 结论聚合：chunk 进当前块 conclusion ────────────────────────────
    case 'chat:message-chunk': {
      const s = ensureCurrentTurn(session);
      const t = currentTurn(s);
      if (!t) return { session: s };
      const delta = deltaOf(payload);
      let out = updateTurn(s, t.id, (blk) => ({ ...blk, conclusion: blk.conclusion + delta }));
      if (s.phase !== 'running') {
        out = { ...out, phase: 'running' };
      }
      return { session: out };
    }

    // ── thinking 细节 ───────────────────────────────────────────────────
    case 'chat:thinking-start': {
      const s = ensureCurrentTurn(session);
      const t = currentTurn(s);
      if (!t) return { session: s };
      return {
        session: updateTurn(s, t.id, (blk) => {
          const details = blk.details.map((d) =>
            d.kind === 'thinking' && d.streaming
              ? { ...d, streaming: false }
              : d,
          );
          const th: ThinkingDetail = {
            kind: 'thinking',
            id: `th-${s.seq + 1}`,
            text: '',
            streaming: true,
          };
          return { ...blk, details: [...details, th] };
        }),
      };
    }

    case 'chat:thinking-chunk': {
      const t = currentTurn(session);
      if (!t) return { session };
      const delta = deltaOf(payload);
      if (!delta) return { session };
      return {
        session: updateTurn(session, t.id, (blk) => {
          const idx = blk.details.findLastIndex(
            (d): d is ThinkingDetail => d.kind === 'thinking' && d.streaming,
          );
          if (idx < 0) return blk;
          const details = [...blk.details];
          const th = details[idx] as ThinkingDetail;
          details[idx] = { ...th, text: th.text + delta };
          return { ...blk, details };
        }),
      };
    }

    case 'chat:thinking-complete': {
      const t = currentTurn(session);
      if (!t) return { session };
      const secs = num(p.seconds);
      return {
        session: updateTurn(session, t.id, (blk) => {
          const idx = blk.details.findLastIndex(
            (d): d is ThinkingDetail => d.kind === 'thinking' && d.streaming,
          );
          if (idx < 0) return blk;
          const details = [...blk.details];
          const th = details[idx] as ThinkingDetail;
          details[idx] = { ...th, streaming: false, seconds: secs ?? th.seconds };
          return { ...blk, details };
        }),
      };
    }

    // ── 工具卡细节 ─────────────────────────────────────────────────────
    case 'chat:tool-use-start': {
      const s = ensureCurrentTurn(session);
      const t = currentTurn(s);
      if (!t) return { session: s };
      const toolCount = t.details.filter((d) => d.kind === 'tool').length;
      const detail: ToolDetail = {
        kind: 'tool',
        id: str(p.id) ?? `tool-${s.seq + 1}`,
        name: str(p.name) ?? 'tool',
        argsSummary: summarizeArgs(payload),
        state: 'running',
        output: '',
        step: toolCount + 1,
      };
      return {
        session: updateTurn(s, t.id, (blk) => ({ ...blk, details: [...blk.details, detail] })),
      };
    }

    case 'chat:tool-result-complete': {
      const id = str(p.toolUseId) ?? str(p.id) ?? '';
      const d = findToolDetail(session, id);
      if (!d) return { session };
      const out = str(p.content) ?? str(p.output) ?? d.output;
      const isError = bool(p.isError) === true || bool(p.ok) === false;
      const exitCode = num(p.exitCode);
      const elapsedMs = num(p.elapsedMs);
      const state = isError ? 'fail' : 'done';
      const signal = summarizeSignal(d.name, out, { isError, exitCode });
      return {
        session: updateTurn(session, turnOf(session, id), (blk) => ({
          ...blk,
          details: blk.details.map((x) =>
            x.kind === 'tool' && x.id === id
              ? { ...x, output: out, state, exitCode, elapsedMs, signal }
              : x,
          ),
        })),
      };
    }

    // ── turn 终结 ─────────────────────────────────────────────────────
    case 'chat:message-complete': {
      const t = currentTurn(session);
      // A3-3：无当前块（窄窗口：complete 先于块建立到达）也要落相位与流指针，
      // 否则 phase 滞留 'running'。
      if (!t) {
        return { session: { ...session, streamingTurnId: null, phase: phaseOf(p.sessionState, 'idle') } };
      }
      const usage = p.usage !== undefined
        ? rec(p.usage)
        : p.input_tokens !== undefined
          ? p
          : null;
      const meta: TurnMeta | undefined = usage
        ? {
            inputTokens: num(usage.input_tokens) ?? num(usage.input) ?? 0,
            outputTokens: num(usage.output_tokens) ?? num(usage.output) ?? 0,
            toolCount: num(usage.tool_count) ?? t.details.filter((d) => d.kind === 'tool').length,
            durationMs: num(usage.duration_ms) ?? 0,
          }
        : undefined;
      let s = updateTurn(session, t.id, (blk) => ({
        ...blk,
        status: 'complete',
        conclusionStreaming: false,
        meta,
      }));
      s = { ...s, streamingTurnId: null, phase: phaseOf(p.sessionState, 'idle') };
      return { session: s };
    }

    case 'chat:message-stopped': {
      // payload 可能是 null（pi stop 路径）——所有读取必须 null-safe。
      let s = cloneSession(session);
      const t = currentTurn(session);
      if (t) {
        s = updateTurn(s, t.id, (blk) => ({
          ...blk,
          status: 'stopped',
          conclusionStreaming: false,
        }));
      }
      const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const kept = num(p.keptCount);
      s = pushItem(s, {
        kind: 'divider',
        id: `div-${s.seq + 1}`,
        seq: s.seq + 1,
        text: kept ? `⏸ 已中断 ${time}（${kept} 个工具结果已保留）` : `⏸ 已中断 ${time}`,
      });
      s.streamingTurnId = null;
      s.phase = 'interrupted';
      return { session: s };
    }

    case 'chat:message-error': {
      const t = currentTurn(session);
      let s = t
        ? updateTurn(session, t.id, (blk) => ({ ...blk, conclusionStreaming: false }))
        : session;
      const text = typeof payload === 'string'
        ? payload
        : (str(p.message) ?? str(p.text) ?? '未知错误');
      s = pushItem(s, { kind: 'error', id: `err-${s.seq + 1}`, seq: s.seq + 1, text });
      s = { ...s, streamingTurnId: null, phase: 'error' };
      return { session: s };
    }

    // ── 队列 / steering ───────────────────────────────────────────────
    case 'chat:steering-added': {
      const qid = str(p.queueId);
      if (!qid) return { session };
      const s = cloneSession(session);
      if (!s.steeringIds.includes(qid)) s.steeringIds.push(qid);
      s.queue = upsertQueue(s.queue, {
        id: qid,
        text: str(p.messageText) ?? '',
        kind: 'steering',
      });
      return { session: s, toast: `↳ 已插入纠偏：${str(p.messageText) ?? ''}`.slice(0, 120) };
    }

    case 'chat:steering-cancelled':
    case 'queue:cancelled': {
      const qid = str(p.queueId) ?? str(p.id);
      if (!qid) return { session };
      const s = cloneSession(session);
      s.queue = s.queue.filter((q) => q.id !== qid);
      return { session: s };
    }

    case 'queue:added': {
      const qid = str(p.queueId) ?? str(p.id);
      if (!qid) return { session };
      const s = cloneSession(session);
      if (bool(p.isInFlight) === true) {
        s.queue = s.queue.filter((q) => q.id !== qid);
        return { session: s };
      }
      s.queue = upsertQueue(s.queue, {
        id: qid,
        text: str(p.messageText) ?? str(p.text) ?? '',
        kind: str(p.kind) === 'steering' ? 'steering' : 'fifo',
      });
      return { session: s };
    }

    // ── 状态 ──────────────────────────────────────────────────────────
    case 'chat:status': {
      return { session: { ...session, phase: phaseOf(p.sessionState ?? payload, session.phase) } };
    }

    case 'chat:context-usage': {
      const pct = num(p.usedPercent);
      const s = { ...session };
      if (pct !== undefined) s.contextPct = Math.max(0, Math.min(100, Math.round(pct)));
      const model = str(p.model);
      if (model) s.model = model;
      return { session: s };
    }

    case 'chat:system-init': {
      const model = str(rec(p.info).model);
      // 1.3.3 @ 补全：工具名数据源（chat:system-init 的 info.tools，随会话
      // 绑定/切换广播一次）。store 顶层 tools 状态消费，@ 补全分节展示。
      const rawTools = rec(p.info).tools;
      const tools = Array.isArray(rawTools)
        ? rawTools.filter((t): t is string => typeof t === 'string')
        : undefined;
      return {
        session: model ? { ...session, model } : session,
        ...(tools ? { tools } : {}),
      };
    }

    // ── 1.3.1 ②：越界 ask（登记表增量交给 store；这里不落会话流） ─────
    case 'chat:boundary-ask': {
      const askId = str(p.askId);
      if (!askId) return { session };
      return {
        session,
        boundaryAsk: {
          type: 'upsert',
          askId,
          kind: str(p.kind) ?? '',
          objects: Array.isArray(p.objects)
            ? p.objects.filter((o): o is string => typeof o === 'string')
            : [],
          // 1.3.2 任务二 #1：additive 字段透传（有则显示，见 BoundaryModal）。
          ...(str(p.toolName) ? { toolName: str(p.toolName) } : {}),
          ...(str(p.toolDescription) ? { toolDescription: str(p.toolDescription) } : {}),
          ...(Array.isArray(p.options) && p.options.length > 0
            ? { options: p.options.filter((o): o is string => typeof o === 'string') }
            : {}),
        },
      };
    }

    case 'chat:boundary-expired': {
      const askId = str(p.askId);
      if (!askId) return { session };
      return { session, boundaryAsk: { type: 'remove', askId } };
    }

    // ── 1.3.2 ①：决策面板（登记表增量交给 store；不落会话流） ──────────
    case 'chat:decision-request': {
      const decisionId = str(p.decisionId);
      if (!decisionId) return { session };
      return {
        session,
        decisionRequest: {
          type: 'upsert',
          decisionId,
          question: str(p.question) ?? '',
          options: Array.isArray(p.options)
            ? p.options.filter((o): o is string => typeof o === 'string')
            : [],
          expertHits: Array.isArray(p.expertHits)
            ? p.expertHits.filter((o): o is string => typeof o === 'string')
            : [],
        },
      };
    }

    case 'chat:decision-resolved': {
      const decisionId = str(p.decisionId);
      if (!decisionId) return { session };
      return { session, decisionResolved: { decisionId } };
    }

    // ── 1.3.1 ③：后台任务 / 子代理登记表增量（不进会话流） ───────────
    case 'chat:bg-started': {
      const tag = str(p.tag);
      if (!tag) return { session };
      return {
        session,
        bgEvent: {
          kind: 'started',
          tag,
          pid: num(p.pid),
          commandPreview: str(p.commandPreview),
        },
      };
    }

    case 'chat:bg-finished': {
      const tag = str(p.tag);
      if (!tag) return { session };
      return {
        session,
        bgEvent: { kind: 'finished', tag, status: str(p.status) ?? '', exitCode: num(p.exitCode) },
      };
    }

    case 'chat:subagent-started': {
      const taskId = str(p.taskId);
      if (!taskId) return { session };
      return {
        session,
        subagentEvent: { kind: 'started', taskId, description: str(p.description) ?? '' },
      };
    }

    case 'chat:subagent-finished': {
      const taskId = str(p.taskId);
      if (!taskId) return { session };
      return {
        session,
        subagentEvent: {
          kind: 'finished',
          taskId,
          description: str(p.description) ?? '',
          summary: str(p.summary),
          status: str(p.status) ?? '',
          error: str(p.error),
          loopSessionId: str(p.loopSessionId),
        },
      };
    }

    case 'chat:subagent-tool-use': {
      const taskId = str(p.subagentId) ?? str(p.taskId);
      if (!taskId) return { session };
      return {
        session,
        subagentEvent: { kind: 'tool-use', taskId, name: str(p.name) ?? 'tool' },
      };
    }

    // ── 1.4.1：auto loop（auto-run:* → store 顶层 autoRun 登记表增量） ──
    case 'auto-run:started': {
      const id = str(p.id);
      if (!id) return { session };
      return {
        session,
        autoRun: {
          kind: 'started',
          id,
          name: str(p.name) ?? '',
          envKey: str(p.envKey) ?? '',
          goal: str(p.goal) ?? '',
          budget: {
            kind: budgetKindOf(rec(p.budget).kind),
            limit: num(rec(p.budget).limit) ?? 0,
          },
          criteria: Array.isArray(p.criteria)
            ? p.criteria.filter((x): x is string => typeof x === 'string')
            : [],
        },
      };
    }

    case 'auto-run:phase-changed': {
      const id = str(p.id);
      const phase = str(p.phase);
      if (!id || !phase) return { session };
      return { session, autoRun: { kind: 'phase', id, phase } };
    }

    case 'auto-run:turn-completed': {
      const id = str(p.id);
      if (!id) return { session };
      // 1.4.6 走查实证：server 发 turn/budget.spent，GUI 曾读 turnCount/used
      // ——观察卡轮次与预算从来就没对过（live 与恢复路径同错）。
      const turnCount = num(p.turnCount) ?? num(p.turn);
      const used = num(p.used) ?? num(rec(p.budget).spent);
      const conclusion = str(p.conclusion) ?? str(p.summary);
      return {
        session,
        autoRun: {
          kind: 'turn',
          id,
          ...(turnCount !== undefined ? { turnCount } : {}),
          ...(used !== undefined ? { used } : {}),
          ...(conclusion ? { conclusion } : {}),
        },
      };
    }

    case 'auto-run:paused': {
      const id = str(p.id);
      const reason = pauseReasonOf(p.reason);
      if (!id || !reason) return { session };
      const summary = str(p.summary);
      return {
        session,
        autoRun: { kind: 'paused', id, reason, ...(summary ? { summary } : {}) },
      };
    }

    case 'auto-run:budget-warning': {
      const id = str(p.id);
      if (!id) return { session };
      // 1.4.6：server 发 budget{kind,limit,spent}——同 turn-completed 的字段口径。
      const used = num(p.used) ?? num(rec(p.budget).spent);
      const limit = num(p.limit) ?? num(rec(p.budget).limit);
      return {
        session,
        autoRun: {
          kind: 'budget',
          id,
          ...(used !== undefined ? { used } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
      };
    }

    case 'auto-run:completed': {
      const id = str(p.id);
      if (!id) return { session };
      const summary = str(p.summary);
      return {
        session,
        autoRun: { kind: 'completed', id, ...(summary ? { summary } : {}) },
      };
    }

    case 'auto-run:verdict-requested': {
      const id = str(p.id);
      if (!id) return { session };
      return { session, autoRun: { kind: 'verdict', id, verdict: parseVerdictRequest(p) } };
    }

    // chat:tool-result-start / chat:tool-result-delta（服务端只发
    // tool-result-complete，增量分支 1.3.10 已删）/ chat:subagent-tool-result-complete
    // / chat:logs：不消费（工具结果只累工具数，见 chat:subagent-tool-use；日志行
    // GUI 不渲染）。
    default:
      return { session };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** 含某工具卡的块 id。 */
function turnOf(session: SessionState, toolId: string): string {
  for (const item of session.items) {
    if (item.kind !== 'turn') continue;
    if (item.details.some((d) => d.kind === 'tool' && d.id === toolId)) return item.id;
  }
  // 找不到时退回当前块（理论上不会发生）。
  return session.streamingTurnId ?? lastTurn(session)?.id ?? '';
}
