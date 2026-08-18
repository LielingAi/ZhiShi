/**
 * W3 event-reducer (归约层, plan §2.2). Pure-ish: takes an SSE event and the
 * current SessionState, mutates state in place, and returns a patch describing
 * what changed so the app can repaint the precise region.
 *
 * Event names follow tui_tech_spec.md §A (plus W1 additions: chat:steering-added,
 * chat:subagent-*, chat:status). No new event is introduced here — we only
 * CONSUME the frozen contract.
 *
 * Payload discipline: the wire is `unknown` (pi 引擎与历史路径形状不一:裸
 * 字符串 / 对象 / null 都有). Every read goes through the str/num/rec/bool
 * narrowers — no `any`, no blind casts (repo lint forbids both).
 */

import type {
  AssistantBlock,
  Block,
  DividerBlock,
  SseInput,
  SessionState,
  ThinkingBlock,
  ToolBlock,
  UserBlock,
} from './types';
import { extractSignal } from './blocks/signal-extract';
import { composeBackgroundSeg } from './bg-tasks';

export interface StatusPatch {
  phase?: SessionState['status']['phase'];
  queueDepth?: number;
  contextPct?: number;
  model?: string;
  backgroundSeg?: string;
  modalActive?: boolean;
}

export interface ModalSignal {
  kind: 'host-write' | 'local-cred' | 'net-policy' | 'destroy-env';
  objects: string[];
  /** 服务端 ask 的 id — 应答 POST /chat/boundary/respond 的回执键。 */
  askId?: string;
}

export interface ReduceResult {
  /** Blocks changed → app re-renders these + appends new rows. */
  touched: string[];
  /** New blocks appended (need row inserts). */
  appended: Block[];
  status?: StatusPatch;
  modal?: ModalSignal;
  /** 越界 ask 超时 — 若当前模态是该 askId,关闭它。 */
  modalExpired?: string;
}

// ---------------------------------------------------------------------------
// Payload narrowers (unknown → typed reads with sane fallbacks)
// ---------------------------------------------------------------------------

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

/** Text delta: pi 引擎发裸字符串,历史路径发 {delta}。 */
function deltaOf(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  return str(rec(payload).delta) ?? '';
}

function nextSeq(state: SessionState): number {
  return ++state.seq;
}

function findBlock(state: SessionState, id: string): Block | undefined {
  return state.blocks.find((b) => b.id === id);
}

function currentAssistant(state: SessionState): Block | undefined {
  if (!state.streamingId) return undefined;
  return findBlock(state, state.streamingId);
}

/**
 * Main entry. `event` is the decoded `{event, payload}`. Returns a patch; the
 * app applies it to the renderer. State is mutated in place for the next call.
 */
export function reduceSseEvent(
  state: SessionState,
  event: SseInput,
): ReduceResult {
  const { event: name, payload } = event;
  const p = rec(payload);
  const patch: ReduceResult = { touched: [], appended: [] };

  switch (name) {
    case 'chat:init': {
      // pi 引擎的 /chat/stream 首事件:{agentDir, sessionState, hasInitialPrompt,
      // loopEngine}。状态行必须从这里开始就是 running——否则 TUI 永远 idle。
      applySessionPhase(state, p.sessionState, patch);
      const model = str(p.model);
      if (model) {
        state.status.model = model;
        patch.status = { ...(patch.status ?? {}), model };
      }
      break;
    }

    case 'chat:message-chunk': {
      let blk = currentAssistant(state);
      if (!blk || blk.kind !== 'assistant') {
        blk = {
          id: `a-${nextSeq(state)}`,
          kind: 'assistant',
          seq: nextSeq(state),
          text: '',
          complete: false,
          streaming: true,
        } as Block;
        state.blocks.push(blk);
        state.streamingId = blk.id;
        patch.appended.push(blk);
      }
      const delta = deltaOf(payload);
      if (delta) {
        (blk as AssistantBlock).text += delta;
        patch.touched.push(blk.id);
      }
      if (state.status.phase !== 'running') {
        state.status.phase = 'running';
        patch.status = { phase: 'running' };
      }
      break;
    }

    case 'chat:message-complete': {
      const blk = currentAssistant(state);
      if (blk && blk.kind === 'assistant') {
        (blk as AssistantBlock).streaming = false;
        (blk as AssistantBlock).complete = true;
        // pi 路径:{model, input_tokens, output_tokens, cache_read_tokens,
        // cache_creation_tokens, tool_count, duration_ms};SDK 历史路径:{usage}。
        const usage = p.usage !== undefined
          ? (p.usage as AssistantBlock['usage'])
          : p.input_tokens !== undefined
            ? {
                input: num(p.input_tokens) ?? 0,
                output: num(p.output_tokens) ?? 0,
                cacheRead: num(p.cache_read_tokens) ?? 0,
                cacheWrite: num(p.cache_creation_tokens) ?? 0,
              }
            : undefined;
        if (usage) (blk as AssistantBlock).usage = usage;
        // 空结论兜底(实测:弱模型跑完工具后产出空文本,界面像「无响应」):
        // 把空 assistant 块改成分隔行,人永远看得见这轮发生了什么。
        if (!(blk as AssistantBlock).text.trim()) {
          const toolCount = state.blocks.filter((b) => b.kind === 'tool' && b.seq > (blk as AssistantBlock).seq - 10).length;
          (blk as unknown as DividerBlock).kind = 'divider';
          (blk as unknown as DividerBlock).label = toolCount > 0
            ? '本轮已执行工具调用（模型未产出文字结论——看上方工具卡）'
            : '（模型空回复）';
          (blk as unknown as DividerBlock).tone = 'info';
        }
        patch.touched.push(blk.id);
      }
      state.streamingId = null;
      if (p.sessionState) mergeStatus(state, p.sessionState, patch);
      break;
    }

    case 'chat:message-stopped': {
      // Confirm the optimistic interrupt divider. `payload` is null on the pi
      // stop path(chat-engine stopPiChat), so every read must be null-safe —
      // 否则 TUI 会在按下 Esc 后直接崩溃。
      if (state.pendingDividerId) {
        const d = findBlock(state, state.pendingDividerId);
        if (d && d.kind === 'divider') {
          (d as DividerBlock).follow = num(p.keptCount)
            ? `${num(p.keptCount)} 个工具结果已保留`
            : '已停止';
          patch.touched.push(d.id);
        }
        state.pendingDividerId = null;
      }
      state.streamingId = null;
      state.status.phase = 'interrupted';
      patch.status = { phase: 'interrupted' };
      break;
    }

    case 'chat:message-error': {
      const blk: Block = {
        id: `e-${nextSeq(state)}`,
        kind: 'error',
        seq: nextSeq(state),
        text:
          typeof payload === 'string'
            ? payload
            : (str(p.message) ?? str(p.text) ?? '未知错误'),
      };
      state.blocks.push(blk);
      state.streamingId = null;
      patch.appended.push(blk);
      state.status.phase = 'error';
      patch.status = { phase: 'error' };
      break;
    }

    case 'chat:thinking-start': {
      const blk: Block = {
        id: `t-${nextSeq(state)}`,
        kind: 'thinking',
        seq: nextSeq(state),
        text: '',
        streaming: true,
        complete: false,
      };
      state.blocks.push(blk);
      patch.appended.push(blk);
      break;
    }

    case 'chat:thinking-chunk': {
      const blk = state.blocks.find(
        (b) => b.kind === 'thinking' && (b as ThinkingBlock).streaming,
      );
      if (blk) {
        const delta = deltaOf(payload);
        if (delta) {
          (blk as ThinkingBlock).text += delta;
          patch.touched.push(blk.id);
        }
      }
      break;
    }

    case 'chat:thinking-complete': {
      const blk = state.blocks.find(
        (b) => b.kind === 'thinking' && (b as ThinkingBlock).streaming,
      );
      if (blk) {
        (blk as ThinkingBlock).streaming = false;
        (blk as ThinkingBlock).complete = true;
        const secs = num(p.seconds);
        if (secs !== undefined) (blk as ThinkingBlock).seconds = secs;
        patch.touched.push(blk.id);
      }
      break;
    }

    case 'chat:tool-use-start': {
      const blk: ToolBlock = {
        id: str(p.id) ?? `tool-${nextSeq(state)}`,
        kind: 'tool',
        seq: nextSeq(state),
        name: str(p.name) ?? 'tool',
        argsSummary: summarizeArgs(payload),
        state: 'running',
        folded: true,
      };
      state.blocks.push(blk);
      patch.appended.push(blk);
      break;
    }

    case 'chat:tool-result-start':
    case 'chat:tool-result-delta': {
      // pi 引擎没有 start/delta 事件;历史 SDK 路径用 {id, delta}。保留兼容。
      const id = str(p.toolUseId) ?? str(p.id) ?? '';
      const blk = findBlock(state, id);
      if (blk && blk.kind === 'tool') {
        blk.output = (blk.output ?? '') + (str(p.delta) ?? '');
        patch.touched.push(blk.id);
      }
      break;
    }

    case 'chat:tool-result-complete': {
      // pi 引擎(sse-adapter)发送 {toolUseId, content};历史路径发送
      // {id, output, ok}。两条契约都吃——否则工具卡在 running 永不落定。
      const id = str(p.toolUseId) ?? str(p.id) ?? '';
      const blk = findBlock(state, id);
      if (blk && blk.kind === 'tool') {
        const out = str(p.content) ?? str(p.output) ?? blk.output ?? '';
        blk.output = out;
        blk.state = p.isError === true || p.ok === false ? 'fail' : 'done';
        const exitCode = num(p.exitCode);
        if (exitCode !== undefined) blk.exitCode = exitCode;
        const elapsedMs = num(p.elapsedMs);
        if (elapsedMs !== undefined) blk.elapsedMs = elapsedMs;
        // 附加律引擎:从工具名+输出提取关键信号到摘要行。
        blk.signal = extractSignal(blk.name, out, {
          exitCode: blk.exitCode,
          elapsedMs: blk.elapsedMs,
        });
        patch.touched.push(blk.id);
      }
      break;
    }

    case 'chat:message-replay': {
      // Cold-history render (resume 主线)。服务端 payload 形如
      // { message: {...} }(chat-engine / resume 均为 {message, ...})。
      replayMessage(state, p.message ?? payload, patch);
      break;
    }

    case 'queue:added':
    case 'queue:cancelled': {
      // pi 引擎:FIFO 队列事件是 {queueId, messageText, isInFlight}。
      const qid = str(p.queueId) ?? str(p.id);
      if (qid) {
        if (name === 'queue:added') {
          state.queue.push({
            id: qid,
            text: str(p.messageText) ?? str(p.text) ?? '',
            kind: str(p.kind) === 'steering' ? 'steering' : 'queued',
            addedAt: Date.now(),
          });
        } else {
          state.queue = state.queue.filter((q) => q.id !== qid);
        }
      }
      patch.status = { queueDepth: state.queue.length };
      break;
    }

    case 'chat:steering-added': {
      state.queue.push({
        id: str(p.queueId) ?? `s-${Date.now()}`,
        text: str(p.messageText) ?? '',
        kind: 'steering',
        addedAt: Date.now(),
      });
      patch.status = { queueDepth: state.queue.length };
      // 一条淡色提示行。
      const hint: Block = {
        id: `bg-${nextSeq(state)}`,
        kind: 'background',
        seq: nextSeq(state),
        taskId: '',
        summary: `↳ 已插入纠偏:${str(p.messageText) ?? ''}`.slice(0, 200),
      };
      state.blocks.push(hint);
      patch.appended.push(hint);
      break;
    }

    case 'chat:steering-cancelled': {
      const qid = str(p.queueId) ?? str(p.id);
      if (qid) {
        state.queue = state.queue.filter((q) => q.id !== qid);
        patch.status = { queueDepth: state.queue.length };
      }
      break;
    }

    case 'chat:subagent-started': {
      // 拍肩膀(design §8):子任务立项 → 状态行中段静态段。
      ensureTask(state, str(p.taskId), str(p.description));
      patch.status = { backgroundSeg: composeBackgroundSeg(state) };
      break;
    }

    case 'chat:subagent-finished': {
      // 子任务收尾 → 结论插行(≤200 字已在服务端截断)+ 「要我切过去吗」尾钩。
      const t = ensureTask(state, str(p.taskId), str(p.description));
      t.done = true;
      t.latestConclusion = str(p.summary)?.slice(0, 200);
      const failed = str(p.status) === 'failed';
      const summary = t.latestConclusion ?? (failed ? '子任务失败' : '子任务完成');
      const row: Block = {
        id: `bg-${nextSeq(state)}`,
        kind: 'background',
        seq: nextSeq(state),
        taskId: t.id,
        summary: `${failed ? '✗ ' : ''}${t.description}:${summary}`,
        switchHook: !failed,
      };
      state.blocks.push(row);
      patch.appended.push(row);
      patch.status = { backgroundSeg: composeBackgroundSeg(state) };
      break;
    }

    case 'chat:bg-started': {
      const tag = str(p.tag) ?? `bg-${nextSeq(state)}`;
      state.bgProcs.set(tag, {
        tag,
        pid: num(p.pid),
        commandPreview: str(p.commandPreview) ?? '',
      });
      patch.status = { backgroundSeg: composeBackgroundSeg(state) };
      break;
    }

    case 'chat:bg-finished': {
      const tag = str(p.tag);
      if (tag) {
        const proc = state.bgProcs.get(tag);
        state.bgProcs.delete(tag);
        const status = str(p.status) ?? 'exited';
        const exit = num(p.exitCode);
        const summary = `${proc?.commandPreview ?? tag} · ${status === 'killed'
          ? '已 kill'
          : status === 'dead'
            ? '异常消失'
            : `exit=${exit ?? '?'}`}`;
        const row: Block = {
          id: `bg-${nextSeq(state)}`,
          kind: 'background',
          seq: nextSeq(state),
          taskId: tag,
          summary,
        };
        state.blocks.push(row);
        patch.appended.push(row);
        patch.status = { backgroundSeg: composeBackgroundSeg(state) };
      }
      break;
    }

    case 'chat:subagent-tool-use':
    case 'chat:subagent-tool-result-start':
    case 'chat:subagent-tool-result-delta': {
      // 状态行中段静态段更新(app 重新 compose)。
      patch.status = { backgroundSeg: composeBackgroundSeg(state) };
      break;
    }

    case 'chat:subagent-tool-result-complete': {
      const t = ensureTask(state, str(p.taskId), str(p.description));
      const outputCount = num(p.outputCount);
      if (outputCount !== undefined) t.outputCount = outputCount;
      patch.status = { backgroundSeg: composeBackgroundSeg(state) };
      break;
    }

    case 'chat:boundary-ask': {
      // 越界 ask(design §6.6):服务端动作 pending 等人。kind 白名单窄化,
      // 未知 kind 按 host-write 兜底显示(模态必须出,不能静默吞)。
      const kinds = ['host-write', 'local-cred', 'net-policy', 'destroy-env'] as const;
      const kind = kinds.find((k) => k === str(p.kind)) ?? 'host-write';
      const objects = Array.isArray(p.objects) ? p.objects.filter((o): o is string => typeof o === 'string') : [];
      patch.modal = { kind, objects, askId: str(p.askId) };
      break;
    }

    case 'chat:boundary-expired': {
      const askId = str(p.askId);
      if (askId) patch.modalExpired = askId;
      break;
    }

    case 'chat:status': {
      // pi 引擎发送 {sessionState:'running'|'idle'};历史 SDK 路径发送
      // {sessionState:{phase,...}}。两种都吃——否则状态行永远是 idle。
      applySessionPhase(state, p.sessionState ?? payload, patch);
      break;
    }

    case 'chat:context-usage': {
      // pi 引擎 turn 末广播 {contextTokens, contextWindow, usedPercent, ...}。
      const pct = num(p.usedPercent);
      if (pct !== undefined) {
        state.status.contextPct = Math.max(0, Math.min(100, Math.round(pct)));
        patch.status = { contextPct: state.status.contextPct };
      }
      const model = str(p.model);
      if (model) {
        state.status.model = model;
        patch.status = { ...(patch.status ?? {}), model };
      }
      break;
    }

    case 'chat:system-init': {
      // {info:{model,...}, sessionId, runtime, engine}。模型标签从这来。
      const model = str(rec(p.info).model);
      if (model) {
        state.status.model = model;
        patch.status = { ...(patch.status ?? {}), model };
      }
      break;
    }

    default:
      // Unknown events are ignored — contract红线: never invent events.
      break;
  }

  return patch;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeArgs(payload: unknown): string {
  const p = rec(payload);
  if (typeof p.summary === 'string') return p.summary;
  // pi 引擎发送 {id, name, input, streamIndex};历史路径发送 {args}/{arguments}。
  const a = rec(p.input ?? p.args ?? p.arguments);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(a)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${s.slice(0, 40)}`);
    if (parts.join(' ').length > 80) break;
  }
  return parts.join(' ') || str(p.name) || 'tool';
}

/**
 * 把 pi 引擎的 {sessionState:'running'|'idle'} 或历史 SDK 路径的
 * {sessionState:{phase,...}} 应用到状态行。null/undefined 安全。
 */
function applySessionPhase(
  state: SessionState,
  ss: unknown,
  patch: ReduceResult,
): void {
  if (typeof ss === 'string') {
    const phase = ss === 'running' ? 'running' : 'idle';
    state.status.phase = phase;
    patch.status = { ...(patch.status ?? {}), phase };
    return;
  }
  if (ss && typeof ss === 'object') {
    mergeStatus(state, ss, patch);
  }
}

function mergeStatus(
  state: SessionState,
  ss: unknown,
  patch: ReduceResult,
): void {
  const s = rec(ss);
  const p: StatusPatch = {};
  const phase = str(s.phase) as SessionState['status']['phase'] | undefined;
  if (phase) {
    state.status.phase = phase;
    p.phase = phase;
  }
  const contextPct = num(s.contextPct);
  if (contextPct !== undefined) {
    state.status.contextPct = contextPct;
    p.contextPct = contextPct;
  }
  const model = str(s.model);
  if (model) {
    state.status.model = model;
    p.model = model;
  }
  if (p.phase || p.contextPct !== undefined || p.model) patch.status = p;
}

function ensureTask(
  state: SessionState,
  id: string | undefined,
  desc: string | undefined,
): import('./types').BackgroundTask {
  const key = id ?? `task-${state.tasks.size}`;
  let t = state.tasks.get(key);
  if (!t) {
    t = {
      id: key,
      description: desc ?? '后台任务',
      outputCount: 0,
      done: false,
    };
    state.tasks.set(key, t);
  }
  return t;
}

function replayMessage(
  state: SessionState,
  msg: unknown,
  patch: ReduceResult,
): void {
  const m = rec(msg);
  if (!m.role) return;
  // Replay dedupe: /chat/stream replays the whole history on EVERY (re)connect,
  // and live user echoes share the same event. The server id is the identity —
  // without this guard every reconnect double-printed the entire transcript.
  const srvId = str(m.id);
  if (srvId) {
    if (state.seenSrvIds.has(srvId)) return;
    state.seenSrvIds.add(srvId);
  }
  const base = { seq: nextSeq(state) };
  if (m.role === 'user') {
    const blk: UserBlock = {
      id: `u-${base.seq}`,
      kind: 'user',
      seq: base.seq,
      srvId,
      text: str(m.content) ?? '',
      refs: m.refs as UserBlock['refs'],
    };
    state.blocks.push(blk);
    patch.appended.push(blk);
  } else if (m.role === 'assistant') {
    const text = str(m.content) ?? '';
    // 空助手消息(纯工具 turn 的残骸)不上屏——但要有兜底可见性:
    // 与活体 message-complete 同款,转分隔行(工具在前的说「看上方工具卡」)。
    if (!text.trim()) {
      const prevTool = state.blocks.length > 0 && state.blocks[state.blocks.length - 1].kind === 'tool';
      const blk: Block = {
        id: `a-${base.seq}`,
        kind: 'divider',
        seq: base.seq,
        label: prevTool
          ? '本轮已执行工具调用（模型未产出文字结论——看上方工具卡）'
          : '（模型空回复）',
        tone: 'info',
      };
      state.blocks.push(blk);
      patch.appended.push(blk);
      return;
    }
    const blk: Block = {
      id: `a-${base.seq}`,
      kind: 'assistant',
      seq: base.seq,
      srvId,
      text,
      complete: true,
      streaming: false,
      usage: m.usage as AssistantBlock['usage'],
    };
    state.blocks.push(blk);
    patch.appended.push(blk);
  } else if (m.role === 'tool') {
    const blk: ToolBlock = {
      id: srvId ?? `tool-${base.seq}`,
      kind: 'tool',
      seq: base.seq,
      name: str(m.name) ?? 'tool',
      argsSummary: summarizeArgs(m),
      state: m.ok === false ? 'fail' : 'done',
      output: str(m.content) ?? '',
      folded: true,
    };
    blk.signal = extractSignal(blk.name, blk.output ?? '', {});
    state.blocks.push(blk);
    patch.appended.push(blk);
  }
}
