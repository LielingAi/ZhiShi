/**
 * W3 types — the session-flow data model shared across the reducer,
 * blocks, chrome and the app shell.
 *
 * These types are pure data (no I/O, no width math). The reducer
 * (event-reducer.ts) consumes SSE events and mutates a `SessionState`;
 * the presentation layer (blocks/*, chrome.ts) reads it to emit
 * styled spans; the renderer (terminal-writer) consumes those spans.
 */

// ---------------------------------------------------------------------------
// SSE event that reaches the reducer. The client.ts openSse() yields the raw
// `SSEEvent {event?, data}`; the app parses `data` as JSON and passes the
// `{event, payload}` shape here. Event names mirror tui_tech_spec.md §A.
// ---------------------------------------------------------------------------

export interface SseInput {
  event: string;
  /**
   * Parsed JSON payload (already decoded by the app from the raw data string).
   * `unknown` by design: this is the frozen SSE contract boundary — pi 引擎与
   * 历史路径的 payload 形状不一（裸字符串/对象/null 都有），reducer 逐事件
   * 用 str/num/rec 窄化读取（仓库 lint 禁 any）。
   */
  payload: unknown;
}

// ---------------------------------------------------------------------------
// Session-flow elements. A `Block` is the unit the blocks/* layer renders
// into one or more rows. Blocks carry stable ids so the reducer can patch
// them in place (streaming assistant text, tool cards, etc.).
// ---------------------------------------------------------------------------

export type BlockKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'divider'
  | 'error'
  | 'background';

export interface BaseBlock {
  id: string;
  kind: BlockKind;
  /** Logical order; lower = older. */
  seq: number;
}

export interface UserBlock extends BaseBlock {
  kind: 'user';
  text: string;
  /** Server-side message id (from chat:message-replay) — rewind 的目标 id。 */
  srvId?: string;
  /** @-refs the user attached (files/env/snapshot/taskmd). */
  refs?: RefAttachment[];
}

export interface AssistantBlock extends BaseBlock {
  kind: 'assistant';
  /** Server-side message id(fork 分叉的目标 id)。 */
  srvId?: string;
  /** Accumulated streamed text (markdown-ish). */
  text: string;
  complete: boolean;
  /** When true the stream is open and the block is the "current" tail. */
  streaming: boolean;
  usage?: { input?: number; output?: number };
}

export interface ThinkingBlock extends BaseBlock {
  kind: 'thinking';
  text: string;
  streaming: boolean;
  complete: boolean;
  /** Elapsed seconds estimate (for the folded summary). */
  seconds?: number;
}

export interface ToolBlock extends BaseBlock {
  kind: 'tool';
  name: string;
  /** One-line argument summary. */
  argsSummary: string;
  state: 'running' | 'done' | 'fail';
  /** Extracted signal summary (signal-extract.ts), shown in folded form. */
  signal?: string;
  /** Full output text (for expand mode). */
  output?: string;
  exitCode?: number;
  elapsedMs?: number;
  folded: boolean;
}

export interface DividerBlock extends BaseBlock {
  kind: 'divider';
  label: string;
  /** Optional follower line, e.g. "N 个工具结果已保留". */
  follow?: string;
  /** interrupt=amber 中断 / info=faint 提示 / ok=green 成功 / fail=red 失败。 */
  tone: 'interrupt' | 'info' | 'ok' | 'fail';
}

export interface ErrorBlock extends BaseBlock {
  kind: 'error';
  text: string;
}

export interface BackgroundBlock extends BaseBlock {
  kind: 'background';
  taskId: string;
  summary: string;
  /** "要我切过去吗" tail hook shown when the subagent finishes. */
  switchHook?: boolean;
}

export type Block =
  | UserBlock
  | AssistantBlock
  | ThinkingBlock
  | ToolBlock
  | DividerBlock
  | ErrorBlock
  | BackgroundBlock;

// ---------------------------------------------------------------------------
// Ref attachments (sent with /chat/send or carried on replay).
// ---------------------------------------------------------------------------

export interface RefAttachment {
  type: 'file' | 'env' | 'snapshot' | 'taskmd';
  path?: string;
  id?: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// Steering / queue (interrupt cost tiers: steer < hard-stop < rewind).
// ---------------------------------------------------------------------------

export interface QueueItem {
  id: string;
  text: string;
  kind: 'steering' | 'queued';
  addedAt: number;
}

// ---------------------------------------------------------------------------
// Subagent tasks (design §8 拍肩膀 model).
// ---------------------------------------------------------------------------

export interface BackgroundTask {
  id: string;
  description: string;
  /** Output artifact count (e.g. crash count). */
  outputCount: number;
  latestConclusion?: string;
  done: boolean;
}

/** env_bg 长驻进程（P2 Phase 2 状态行存在感）。 */
export interface BgProcess {
  tag: string;
  pid?: number;
  commandPreview: string;
}

// ---------------------------------------------------------------------------
// Status snapshot fed into status-line.ts (composeStatusLine).
// Extends the legacy StatusSnapshot semantics with escHint + backgroundSeg.
// ---------------------------------------------------------------------------

export type SessionPhase = 'idle' | 'running' | 'interrupted' | 'error';

export type EscHint = 'stop' | 'cancel' | 'resume-tail' | 'close';

export interface StatusSnapshot {
  phase: SessionPhase;
  /** Queue depth (steering + explicit queue combined). */
  queueDepth: number;
  /** Context window usage percent (0..100). */
  contextPct: number;
  /** Model label (narrow-screen first to drop). */
  model?: string;
  /** Subagent static segment, e.g. "⛁ fuzz · 3 崩溃". */
  backgroundSeg?: string;
  /** Right-side Esc hint, derived from mode/scroll/interrupt state. */
  escHint: EscHint;
  /** Env name + kind for the prompt anchor. */
  envName?: string;
  envKind?: string;
  /** Whether an input modal (越界确认) is currently active. */
  modalActive?: boolean;
}

// ---------------------------------------------------------------------------
// Modal signal (越界确认, design §6.6). The only red-bordered block.
// ---------------------------------------------------------------------------

export type BoundaryKind = 'host-write' | 'local-cred' | 'net-policy' | 'destroy-env';

export interface ModalState {
  active: boolean;
  kind: BoundaryKind;
  /** Human description of the object(s): paths / credential names / env+artifacts. */
  objects: string[];
  /** 服务端 ask id(boundary-ask 通道);本地触发的模态无此字段。 */
  askId?: string;
  /** Resolver called by app when the user answers y/n. */
  resolve?: (approve: boolean) => void;
}

// ---------------------------------------------------------------------------
// Whole-session mutable state. Owned by the app, mutated by the reducer.
// ---------------------------------------------------------------------------

export interface SessionState {
  blocks: Block[];
  /** id of the currently-streaming assistant/thinking block, if any. */
  streamingId: string | null;
  queue: QueueItem[];
  tasks: Map<string, BackgroundTask>;
  /** 当前会话里发起的长驻进程(chat:bg-started 登记,finished 移除)。 */
  bgProcs: Map<string, BgProcess>;
  status: Omit<StatusSnapshot, 'escHint'>;
  /** Discard late frames whose turnId != currentTurnId (stop edge case). */
  currentTurnId: string | null;
  /** Frozen divider id waiting for server confirmation (optimistic). */
  pendingDividerId: string | null;
  /** Server message ids already rendered (replay dedupe across SSE reconnects). */
  seenSrvIds: Set<string>;
  seq: number;
}
