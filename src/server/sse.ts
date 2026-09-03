import { randomUUID } from 'crypto';
import { localTimestamp } from '../shared/logTime';

type SseClient = {
  id: string;
  send: (event: string, data: unknown) => void;
  close: () => void;
};

const encoder = new TextEncoder();

// ──────────────────────────────────────────────────────────────────────────
// Pattern 2 §2.3.2 — Priority-aware SSE backpressure.
//
// The historical client.send() called controller.enqueue() unconditionally;
// when the WebKit/Tauri downstream stalled (slow renderer, paused tab, frozen
// proxy), Node's ReadableStreamDefaultController would hold every pending
// chunk in memory forever. A long streaming session against a paused tab
// would OOM the sidecar.
//
// Three priority tiers:
//   - 'critical'    → must reach the client even under pressure (errors,
//                     completions, init events). Wait briefly, then enqueue
//                     anyway and emit a slow-client warning. NEVER dropped.
//   - 'coalescible' → chunk-style deltas and latest-wins snapshots. When the
//                     queue is over the high-water mark, same-type queued
//                     entries collapse — but HOW they collapse depends on the
//                     payload semantics: incremental text
//                     (`chat:message-chunk`) is MERGED (string append —
//                     replacing would silently drop never-delivered text),
//                     while latest-wins state snapshots (`chat:context-usage`
//                     etc.) are REPLACED by the newest entry.
//   - 'droppable'   → telemetry, logs. Drop silently and bump a counter.
//
// Per-client bounded queue (`MAX_QUEUE_PER_CLIENT`) is a hard ceiling — once
// the queue is full of critical entries, further critical entries still go
// in (we'd rather burn memory than drop a completion event), but the slow
// client is logged so operators can spot the wedge.
// ──────────────────────────────────────────────────────────────────────────

export type SseEventPriority = 'critical' | 'coalescible' | 'droppable';

/**
 * Default priority used when an event isn't listed in `SSE_EVENT_PRIORITIES`.
 *
 * Codex M9 fix: defaulting unknown events to 'coalescible' silently dropped
 * unregistered structural / control events (`chat:tool-use-start`,
 * `chat:content-block-stop`, `chat:message-sdk-uuid`, queue events…) under
 * backpressure — invisible data loss for anything someone forgot to
 * register. We now fail closed: unregistered events take the same priority
 * as critical events and emit a one-shot warning with the event name so the
 * regression is loud. Existing registered streaming deltas keep their
 * 'coalescible' priority via SSE_EVENT_PRIORITIES below.
 */
const DEFAULT_PRIORITY: SseEventPriority = 'critical';
const unknownEventWarned = new Set<string>();

/**
 * Data-driven priority table. Each callsite of `broadcast(event, ...)` picks
 * up its priority from this map — adding a new event type to the codebase
 * only requires registering it here, not threading priority through callers.
 *
 * Conventions:
 *   - chunk/delta-style streaming events                   → 'coalescible'
 *   - completion / error / init / permission gate events   → 'critical'
 *   - log / telemetry chatter                              → 'droppable'
 */
export const SSE_EVENT_PRIORITIES: Readonly<Record<string, SseEventPriority>> = Object.freeze({
  // Streaming deltas — coalescible (replace same-key tail under pressure).
  'chat:message-chunk': 'coalescible',
  'chat:thinking-chunk': 'coalescible',
  // PRD 0.2.32 — context-usage indicator snapshot. A latest-wins value
  // (renderer only does setContextUsage(latest)) broadcast at Codex sub-turn
  // frequency; under backpressure superseded snapshots MUST collapse to the
  // newest rather than queue, so it is coalescible (NOT critical — the default
  // for unregistered events, which would never coalesce and spam a one-shot
  // [sse] missing-from-priorities warning per process).
  'chat:context-usage': 'coalescible',
  // (Phase E PRD 0.2.7: `workspace:files-changed` SSE event removed; the
  // renderer subscribes to the Rust workspace_files watcher via Tauri
  // events instead, so this whitelist no longer needs the entry.)
  // Logs / telemetry — droppable.
  'chat:log': 'droppable',
  // ('chat:logs' 已随 1.5.4 B3 删除——getPiLogLines 恒空壳退役,全链无消费者)
  // Critical — never drop or coalesce. Includes block-boundary / start
  // markers, completion / error events, status updates, queue lifecycle,
  // and client-driven request/response gates. These fire in tight bursts
  // at turn start (system-init → status → thinking-start → tool-use-start
  // → …); coalescing any of them would corrupt the client's structural
  // state machine.
  'chat:system-init': 'critical',
  'chat:status': 'critical',
  'chat:init': 'critical',
  'chat:thinking-start': 'critical',
  // 1.2.8(H1):thinking 块收尾(loop 路径)——结构级边界,与 thinking-start 同级。
  'chat:thinking-complete': 'critical',
  'chat:message-replay': 'critical',
  'chat:message-stopped': 'critical',
  'chat:message-complete': 'critical',
  'chat:message-error': 'critical',
  'chat:tool-use-start': 'critical',
  'chat:tool-result-complete': 'critical',
  'chat:subagent-tool-use': 'critical',
  'chat:subagent-tool-result-complete': 'critical',
  // W1(design-spec §8 拍肩膀)— delegate_task 子任务生命周期:started 带
  // {taskId, description},finished 带 {taskId, summary, status}(结论摘要,
  // 不带过程)。GUI 后台静态段 + 结论插行的数据源。
  'chat:subagent-started': 'critical',
  'chat:subagent-finished': 'critical',
  // W1(design-spec §6.1 纠偏档)— 运行中发送进 pi steering 队列;added
  // 携带 {queueId, messageText},cancelled 在 stop/reset 清队时逐条发。
  'chat:steering-added': 'critical',
  'chat:steering-cancelled': 'critical',
  // 越界 ask 通道(design §6.6)— 红色模态的请求/超时,结构级事件,绝不丢。
  'chat:boundary-ask': 'critical',
  'chat:boundary-expired': 'critical',
  // 1.3.2 决策面板——模型提请人拍板/人已作答,结构级事件,绝不丢。
  'chat:decision-request': 'critical',
  'chat:decision-resolved': 'critical',
  // 1.4.4 研究档案——档案变更(GUI 研究面板整包刷新),结构级事件,绝不丢。
  'archive:changed': 'critical',
  // env_bg 生命周期(P2 Phase 2)— 长驻进程在状态行的存在感 + 退出插行。
  'chat:bg-started': 'critical',
  'chat:bg-finished': 'critical',
  // 1.4.1 auto loop agent(design auto-loop-design.md §7)— 运行卡/暂停点/
  // 验收包的结构级事件,绝不丢。payload 见 loop/auto-run.ts 的 broadcast。
  'auto-run:started': 'critical',
  'auto-run:phase-changed': 'critical',
  'auto-run:turn-completed': 'critical',
  'auto-run:paused': 'critical',
  'auto-run:budget-warning': 'critical',
  'auto-run:completed': 'critical',
  // 1.6.0：暂停点恢复广播（paused→running）
  'auto-run:resumed': 'critical',
  'auto-run:verdict-requested': 'critical',
  'queue:added': 'critical',
  'queue:cancelled': 'critical',
  // ('cron:task-exit-requested' removed — emitter retired with exit_cron_task in v0.2.11)
  // ('appcraft:sediment-proposal' removed — AppCraft 已随 1.2.3 退役移除)
  // (1.3.10 A2:零产生点的孤儿事件条目已删——delta 系(tool-input/tool-result/
  //  subagent-tool-{input,result})、SDK 残留(debug-message/system-status/api-retry/
  //  attachments-{filtered,fallback}/content-block-stop/message-sdk-uuid/agent-error/
  //  server-tool-use-start/tool-result-start/subagent-tool-result-start)、
  //  交互体系残留(permission:request/ask-user-question/*/(exit|enter)-plan-mode/*、
  //  task-notification/task-started/permission-mode-changed/mcp:oauth-expired/
  //  queue:started);发射点全集与注册表的双向对账由
  //  sse-whitelist-crosscheck.unit.test.ts 钉死)
  'chat:session-title-changed': 'critical',
});

function resolvePriority(event: string): SseEventPriority {
  const explicit = SSE_EVENT_PRIORITIES[event];
  if (explicit) return explicit;
  if (!unknownEventWarned.has(event)) {
    unknownEventWarned.add(event);
    console.warn(
      `[sse] event "${event}" missing from SSE_EVENT_PRIORITIES — treating as critical. ` +
        `Register it in src/server/sse.ts to silence and pick the correct priority.`,
    );
  }
  return DEFAULT_PRIORITY;
}

const MAX_QUEUE_PER_CLIENT = 1000;
/** Highwater for coalesce trigger — once queue depth exceeds this, coalescible
 *  events start replacing same-type tails instead of appending. */
const COALESCE_HIGH_WATER = 256;
/** OOM defense — beyond this, even critical events get the slow client
 *  force-closed rather than enqueued. PRD §2.3.2 contract: critical never
 *  drops on the normal path, but a wedged renderer + buggy plugin emitting
 *  many `chat:status` (critical) must not be allowed
 *  to grow Node memory unboundedly. 10x MAX_QUEUE_PER_CLIENT gives plenty of
 *  headroom for a recoverable burst while bounding the worst case. */
const MAX_QUEUE_HARD_LIMIT = 10 * MAX_QUEUE_PER_CLIENT;
/** How long a 'critical' enqueue waits for desiredSize to recover before
 *  forcing through with a slow-client warning. PRD §2.3.2: "wait briefly,
 *  then enqueue anyway". Used by the dispatch path to give downstream a
 *  chance to drain before we bypass the soft cap. */
const _CRITICAL_BACKOFF_MS = 100;

interface SseMetrics {
  /** Total dropped events broken down by event type. */
  dropped: Record<string, number>;
  /** Total slow-client critical force-throughs. */
  slowConsumerEnqueue: number;
  /** Coalesce-replace operations (kept as a sanity counter). */
  coalesceReplace: number;
}

const SSE_METRICS_KEY = '__zhishi_sse_metrics__';
const sseMetrics: SseMetrics =
  ((globalThis as Record<string, unknown>)[SSE_METRICS_KEY] as SseMetrics) ??
  ((globalThis as Record<string, unknown>)[SSE_METRICS_KEY] = {
    dropped: {},
    slowConsumerEnqueue: 0,
    coalesceReplace: 0,
  } as SseMetrics);

export function getSseMetrics(): Readonly<SseMetrics> {
  // Shallow copy — exported for /api/admin diagnostics. The dropped table is
  // a fresh object so callers can JSON.stringify without holding a live ref.
  return {
    dropped: { ...sseMetrics.dropped },
    slowConsumerEnqueue: sseMetrics.slowConsumerEnqueue,
    coalesceReplace: sseMetrics.coalesceReplace,
  };
}

function bumpDropped(event: string): void {
  sseMetrics.dropped[event] = (sseMetrics.dropped[event] ?? 0) + 1;
}

// 🔧 Fix: Use globalThis to ensure single clients Set even if module is loaded twice
// (Per ChatGPT's suggestion to prevent module double-loading issues)
const CLIENTS_KEY = '__zhishi_sse_clients__';
// SSE_INSTANCE_ID lives in sse-instance.ts (a leaf module) to break the
// static cycle with logger.ts. Re-exported here so existing callers that
// import it from './sse' keep working.
export { SSE_INSTANCE_ID } from './sse-instance';

const clients: Set<SseClient> =
  (globalThis as Record<string, unknown>)[CLIENTS_KEY] as Set<SseClient> ??
  ((globalThis as Record<string, unknown>)[CLIENTS_KEY] = new Set<SseClient>());

const HEARTBEAT_INTERVAL_MS = 15000;

// ── Last-Value Cache ──
// Events whose latest value is cached and replayed to newly connected clients.
// Solves the "late joiner" problem: when a Tab connects to a session already in progress
// (e.g., IM Bot mid-flight), it immediately receives the current session state instead
// of showing idle until the next live event arrives.
// Only cache chat:status — chat:system-init is already replayed inline by the /chat/stream
// handler (index.ts), so caching it here would cause duplicate delivery that poisons
// isStreamingRef in the frontend.
const CACHED_EVENTS = new Set(['chat:status']);
const LAST_VALUE_CACHE_KEY = '__zhishi_sse_lvc__';
const lastValueCache: Map<string, unknown> =
  (globalThis as Record<string, unknown>)[LAST_VALUE_CACHE_KEY] as Map<string, unknown> ??
  ((globalThis as Record<string, unknown>)[LAST_VALUE_CACHE_KEY] = new Map<string, unknown>());

const TEXT_SUMMARY_LIMIT = 30;
const ERROR_TEXT_SUMMARY_LIMIT = 120;
const GENERAL_STRING_SUMMARY_LIMIT = 160;
const STREAMING_LOG_FLUSH_EVERY = 50;
const LONG_TEXT_FIELD_KEYS = new Set([
  'content', 'delta', 'text', 'result', 'command', 'inputJson',
  'output', 'stdout', 'stderr', 'error',
]);

type StreamingLogAggregate = {
  chars: number;
  count: number;
  event: string;
  key: string;
  sample: string;
};

const streamingLogAggregates = new Map<string, StreamingLogAggregate>();

function normalizeTextForLog(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function summarizeTextField(value: string, limit = TEXT_SUMMARY_LIMIT): string {
  const normalized = normalizeTextForLog(value);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}……（共 ${value.length} 字符）`;
}

function summarizeLongFields(value: unknown, limit = TEXT_SUMMARY_LIMIT, fieldName?: string): unknown {
  if (typeof value === 'string') {
    const fieldLimit = fieldName && LONG_TEXT_FIELD_KEYS.has(fieldName)
      ? limit
      : GENERAL_STRING_SUMMARY_LIMIT;
    return summarizeTextField(value, fieldLimit);
  }
  if (Array.isArray(value)) {
    return value.map((item) => summarizeLongFields(item, limit, fieldName));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = summarizeLongFields(item, limit, key);
  }
  return result;
}

function summarizePayload(event: string, data: unknown): string {
  if (event === 'chat:message-replay' && typeof data === 'object' && data !== null) {
    const message = (data as { message?: { id?: string } }).message;
    if (message?.id) {
      return `messageId=${message.id}`;
    }
  }
  if (event === 'chat:message-chunk' && typeof data === 'string') {
    return `chars=${data.length}`;
  }
  if (typeof data === 'string') {
    const trimmed = data.replace(/\s+/g, ' ').slice(0, 120);
    return `text="${trimmed}"`;
  }
  if (data === null || data === undefined) {
    return 'data=null';
  }
  try {
    const isErrorPayload = typeof data === 'object' && data !== null && (data as { isError?: unknown }).isError === true;
    return `data=${JSON.stringify(summarizeLongFields(data, isErrorPayload ? ERROR_TEXT_SUMMARY_LIMIT : TEXT_SUMMARY_LIMIT))}`;
  } catch {
    return 'data=[unserializable]';
  }
}

function getStreamingLogDelta(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }
  if (data && typeof data === 'object') {
    const record = data as { delta?: unknown; text?: unknown; content?: unknown };
    if (typeof record.delta === 'string') return record.delta;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }
  return '';
}

function getStreamingLogKey(event: string, data: unknown): string {
  if (!data || typeof data !== 'object') {
    return event;
  }
  const record = data as { index?: unknown; parentToolUseId?: unknown; subagentId?: unknown; toolId?: unknown; toolUseId?: unknown };
  const parts = [event];
  if (typeof record.index === 'number' || typeof record.index === 'string') {
    parts.push(`index:${record.index}`);
  }
  if (typeof record.parentToolUseId === 'string' && record.parentToolUseId) {
    parts.push(`parent:${record.parentToolUseId}`);
  }
  if (typeof record.toolId === 'string' && record.toolId) {
    parts.push(`tool:${record.toolId}`);
  }
  if (typeof record.toolUseId === 'string' && record.toolUseId) {
    parts.push(`tool:${record.toolUseId}`);
  }
  if (typeof record.subagentId === 'string' && record.subagentId) {
    parts.push(`subagent:${record.subagentId}`);
  }
  return parts.join('|');
}

function flushStreamingLogAggregate(key: string, reason: string): void {
  const aggregate = streamingLogAggregates.get(key);
  if (!aggregate) {
    return;
  }
  streamingLogAggregates.delete(key);
  console.log(
    `[sse] ${aggregate.event} -> deltas=${aggregate.count} chars=${aggregate.chars} sample="${summarizeTextField(aggregate.sample)}" reason=${reason}`
  );
}

function flushStreamingLogAggregatesBy(matcher: (key: string, aggregate: StreamingLogAggregate) => boolean, reason: string): void {
  for (const [key, aggregate] of Array.from(streamingLogAggregates.entries())) {
    if (matcher(key, aggregate)) {
      flushStreamingLogAggregate(key, reason);
    }
  }
}

function recordStreamingLog(event: string, data: unknown): void {
  const key = getStreamingLogKey(event, data);
  const delta = getStreamingLogDelta(data);
  const existing = streamingLogAggregates.get(key);
  const aggregate = existing ?? { chars: 0, count: 0, event, key, sample: '' };
  aggregate.count += 1;
  aggregate.chars += delta.length;
  if (!aggregate.sample && delta) {
    aggregate.sample = delta;
  } else if (aggregate.sample.length < TEXT_SUMMARY_LIMIT && delta) {
    aggregate.sample += delta;
  }
  streamingLogAggregates.set(key, aggregate);

  if (aggregate.count % STREAMING_LOG_FLUSH_EVERY === 0) {
    flushStreamingLogAggregate(key, `every-${STREAMING_LOG_FLUSH_EVERY}`);
  }
}

function flushStreamingLogsForBoundary(event: string): void {
  // 块/工具边界事件(chat:content-block-stop / chat:tool-result-complete)已随
  // SDK 删除不再发射(1.3.10 A2 清表),这里只留 message 级收尾的全量 flush。
  if (event === 'chat:message-complete' || event === 'chat:message-error' || event === 'chat:message-stopped') {
    flushStreamingLogAggregatesBy(() => true, event);
  }
}

function formatSse(event: string, data: unknown): Uint8Array {
  const lines: string[] = [];
  if (event) {
    lines.push(`event: ${event}`);
  }

  const safeJsonStringify = (value: unknown): string => {
    try {
      return JSON.stringify(value);
    } catch {
      return JSON.stringify({ error: 'unserializable_payload' });
    }
  };

  if (data === undefined) {
    lines.push('data:');
  } else if (data === null) {
    lines.push('data: null');
  } else if (typeof data === 'string') {
    const parts = data.split(/\r?\n/);
    parts.forEach((part) => {
      lines.push(`data: ${part}`);
    });
  } else {
    lines.push(`data: ${safeJsonStringify(data)}`);
  }

  lines.push('');
  return encoder.encode(`${lines.join('\n')}\n`);
}

const sseDecoder = new TextDecoder();

/**
 * 1.2.8(M3):背压合并的逆操作——从已编码的 `chat:message-chunk` 帧取回
 * 字符串负载(formatSse 对字符串按行拆 `data:`;合并 = 数据行取回后拼接
 * 再编码)。帧形状不符时返回 null,调用方回退替换语义(不冒险拼损坏帧)。
 */
function decodeMessageChunkPayload(chunk: Uint8Array): string | null {
  const dataLines: string[] = [];
  for (const line of sseDecoder.decode(chunk).split('\n')) {
    if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length));
    else if (line === 'data:') dataLines.push('');
    else if (line.startsWith('event:') || line === '') continue;
    else return null;
  }
  return dataLines.join('\n');
}

function heartbeatChunk(): Uint8Array {
  return encoder.encode(': ping\n\n');
}

// High-frequency streaming events — aggregate console.log to reduce unified log noise.
// These events fire per-token/per-delta and produce thousands of lines with little diagnostic value.
const AGGREGATED_EVENTS = new Set([
  'chat:message-chunk', 'chat:thinking-chunk',
]);

const SILENT_EVENTS = new Set(['chat:log']);

// Time-window coalescing for high-frequency streaming deltas.
//
// Background: each SDK token emits a `chat:message-chunk` (string delta) at
// ~60Hz. With N concurrent sidecars (one per Tab) all streaming at once, the
// Rust sse_proxy fires N × 60 = 300+ Tauri `emit()` calls per second — every
// one of them round-trips JSON through the single WebKit IPC channel. On macOS
// that thread is the same one running the React renderer, so the backlog
// materializes as UI jank in every tab simultaneously.
//
// Solution: buffer consecutive `chat:message-chunk` string deltas in a 40ms
// window per process, then flush as a single concatenated chunk. 40ms ≈ 25fps,
// far above the ~15fps threshold below which streaming text feels choppy, and
// it cuts IPC traffic by ~58% in the steady state. Any non-chunk event
// (tool-use-start, message-complete, permission prompts, …) flushes the
// pending buffer first to keep strict event ordering.
//
// Only `chat:message-chunk` is coalesced. `chat:thinking-chunk` carries
// `{index, delta}` payloads where different index values can't legally merge,
// and its frequency is lower to begin with. Keeping the rule narrow avoids
// semantic surprises.
const CHUNK_COALESCE_MS = 40;
const chunkBuffers = new Map<string, { merged: string; timer: ReturnType<typeof setTimeout> }>();

// Events that don't carry ordering semantics with the text stream and must
// NOT cause a pending-chunk buffer drain. `chat:log` fires from inside the
// text-delta handler on verbose providers; treating it as a flush boundary
// would defeat coalescing entirely under heavy logging. Anything else
// (tool-use-start, message-complete, permission prompts, …) must still
// flush so the consumer's strict ordering invariants hold.
const NON_FLUSHING_EVENTS = new Set<string>(['chat:log']);

// Coalesce buffer scope: module-level Map. Each Sidecar is one Node process
// serving a single session under the project's Tab-scoped Sidecar isolation
// (see specs/ARCHITECTURE.md § "Tab-scoped 隔离"), so cross-session
// mixing cannot happen here. If that invariant ever changes, key the buffer
// by client id instead.

function flushCoalescedChunk(event: string): void {
  const entry = chunkBuffers.get(event);
  if (!entry) return;
  chunkBuffers.delete(event);
  clearTimeout(entry.timer);
  dispatchWithSpillGuard(event, entry.merged);
}

function flushAllCoalesced(): void {
  if (chunkBuffers.size === 0) return;
  // Copy keys — flushCoalescedChunk deletes entries as it runs.
  const keys = Array.from(chunkBuffers.keys());
  for (const k of keys) flushCoalescedChunk(k);
}

function broadcastImmediate(event: string, data: unknown): void {
  if (AGGREGATED_EVENTS.has(event)) {
    recordStreamingLog(event, data);
  } else {
    flushStreamingLogsForBoundary(event);
  }
  if (!SILENT_EVENTS.has(event) && !AGGREGATED_EVENTS.has(event)) {
    console.log(`[sse] ${event} -> ${summarizePayload(event, data)}`);
  }
  // Update last-value cache for stateful events
  if (CACHED_EVENTS.has(event)) {
    lastValueCache.set(event, data);
  }
  for (const client of clients) {
    client.send(event, data);
  }
}

export function broadcast(event: string, data: unknown): void {
  if (event === 'chat:message-chunk' && typeof data === 'string') {
    let entry = chunkBuffers.get(event);
    if (!entry) {
      entry = {
        merged: data,
        timer: setTimeout(() => flushCoalescedChunk(event), CHUNK_COALESCE_MS),
      };
      chunkBuffers.set(event, entry);
    } else {
      entry.merged += data;
    }
    return;
  }
  // Every non-coalesced event flushes pending chunk buffers first so that
  // a tool-use-start or message-complete never lands before the text delta
  // that preceded it — except for events declared non-ordering above, which
  // pass through without disturbing the in-flight coalesce window.
  if (chunkBuffers.size > 0 && !NON_FLUSHING_EVENTS.has(event)) {
    flushAllCoalesced();
  }
  dispatchWithSpillGuard(event, data);
}

// ──────────────────────────────────────────────────────────────────────────
// 1.5.4 ① refs 大值外溢（CLAUDE.md 红线：>256KB payload 不直接进 SSE/IPC JSON）。
//
// broadcast 出口统一过 spill 闸：payload JSON 超过阈值时经 maybeSpill 落盘
// （~/.zhishi/refs/<id>），线上改发 {kind:'ref', id, preview, ...} 占位引用，
// 全量体由消费端走 GET /refs/:id 取回。
//
// 消费端待接（刻意记录）：当前 GUI/CLI 尚无 fetchRef / {kind:'ref'} 解析端——
// 服务端写链路（落盘 + /refs/:id + startRefsGc）真实生效；消费端接上前，客户
// 端在超大 payload 处会看到 ref 占位而非全量 JSON。这正是红线的取舍：宁可占位
// 也不让 MB 级 JSON 进 IPC 桥拖死 sidecar。
//
// spill 是异步落盘；SSE 消费端是结构化状态机（tool-result 必须先于
// message-complete 等），故 spill 在飞期间到达的后续事件经 spillTail 串行
// 尾链排队，保住严格时序。
// ──────────────────────────────────────────────────────────────────────────
const SPILL_INLINE_MAX_BYTES = 256 * 1024;

/** spill 串行尾链。不重置为 resolved 初值以外的状态——resolved 链上的 then
 *  只是一次微任务，换来「spill 在飞时后续事件绝不抢跑」的时序保证。 */
let spillTail: Promise<void> = Promise.resolve();
/** 在飞的 spill 数（>0 时普通事件排到尾链后广播）。 */
let spillInFlight = 0;

function enqueueBehindSpillTail(step: () => void | Promise<void>): void {
  spillTail = spillTail.then(step, step);
}

function measurePayloadBytes(data: unknown): number {
  if (typeof data === 'string') {
    return Buffer.byteLength(data, 'utf-8');
  }
  try {
    return Buffer.byteLength(JSON.stringify(data), 'utf-8');
  } catch {
    // 不可序列化 → formatSse 的 safeJsonStringify 会发错误占位，按内联放行。
    return 0;
  }
}

function dispatchWithSpillGuard(event: string, data: unknown): void {
  const sizeBytes = measurePayloadBytes(data);
  if (sizeBytes > SPILL_INLINE_MAX_BYTES) {
    spillInFlight++;
    enqueueBehindSpillTail(async () => {
      try {
        // 动态 import：spill 是冷路径，不为它把 large-value-store 拉进
        // sse 的静态依赖图（sse 被 logger 等底层模块引用）。
        const { maybeSpill } = await import('./utils/large-value-store');
        const json = typeof data === 'string' ? data : JSON.stringify(data);
        const spilled = await maybeSpill(json, {
          mimetype: 'application/json',
          inlineMaxBytes: SPILL_INLINE_MAX_BYTES,
        });
        if ('inline' in spilled) {
          // 防御分支：按字节数已超阈值，maybeSpill 恒走落盘；此分支不可达。
          broadcastImmediate(event, data);
        } else {
          console.warn(
            `[sse] 大 payload 外溢 event=${event} sizeBytes=${spilled.sizeBytes} → ref=${spilled.id}（全文走 GET /refs/${spilled.id}）`,
          );
          broadcastImmediate(event, spilled);
        }
      } catch (err) {
        // fail closed：外溢失败绝不回退内联（红线即防此刻的 MB 级泛洪）——
        // 改发小型错误占位，日志留证。
        console.warn(
          `[sse] 大 payload 外溢失败 event=${event} sizeBytes=${sizeBytes}:`,
          err instanceof Error ? err.message : String(err),
        );
        broadcastImmediate(event, { error: 'large_payload_spill_failed', sizeBytes });
      } finally {
        spillInFlight--;
      }
    });
    return;
  }
  if (spillInFlight > 0) {
    // spill 在飞——排到串行尾链之后广播，保住事件时序。
    enqueueBehindSpillTail(() => broadcastImmediate(event, data));
    return;
  }
  broadcastImmediate(event, data);
}

/**
 * Get all active SSE clients (for logger integration)
 */
export function getClients(): SseClient[] {
  return Array.from(clients);
}

export function createSseClient(onClose: (client: SseClient) => void): {
  client: SseClient;
  response: Response;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let client: SseClient | null = null;
  // `pending` holds payloads queued before the stream's start() handler hooks
  // up the controller. `queue` is the post-start backpressure-aware buffer;
  // its entries are tagged with the event name + priority so we can do
  // priority-aware dispositions when downstream stalls.
  const pending: Uint8Array[] = [];
  type QueueEntry = { event: string; priority: SseEventPriority; chunk: Uint8Array };
  const queue: QueueEntry[] = [];
  let slowConsumerLogged = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Drain as many queued entries as `controller.desiredSize` permits. Called
   * after every enqueue and after `pull()` (which fires when downstream
   * actually consumed bytes — i.e. desiredSize bumped back into positive).
   *
   * `force=true` ignores the desiredSize hint and pushes everything through;
   * used at close-time so a paused downstream still receives any tail of
   * queued criticals before EOF.
   */
  const drainQueue = (force: boolean = false): void => {
    if (!controller) return;
    while (queue.length > 0) {
      if (!force) {
        const desired = controller.desiredSize;
        if (desired === null || desired <= 0) break;
      }
      const entry = queue.shift()!;
      try {
        controller.enqueue(entry.chunk);
      } catch {
        // Controller closed — drop the rest; cancel handler will clean up.
        queue.length = 0;
        return;
      }
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
      if (pending.length > 0) {
        pending.forEach((chunk) => {
          controller?.enqueue(chunk);
        });
        pending.length = 0;
      }
    },
    pull() {
      // Downstream consumed; try to flush any backlog we coalesced/queued.
      drainQueue();
    },
    cancel() {
      if (controller) {
        controller = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      queue.length = 0;
      if (client) {
        clients.delete(client);
        onClose(client);
        console.log(`[sse] client disconnected id=${client.id} total=${clients.size}`);
        client = null;
      }
    }
  });

  /**
   * Decide and apply the disposition for an event under backpressure.
   *
   * Returns true if the entry was added to the live queue (or the controller
   * directly), false if it was dropped.
   */
  const dispatchWithBackpressure = (event: string, payload: Uint8Array): boolean => {
    const priority = resolvePriority(event);

    if (!controller) {
      // Pre-start: buffer raw payloads — start() flushes them.
      pending.push(payload);
      return true;
    }

    const desired = controller.desiredSize;

    // Hot path: downstream is consuming, queue is empty.
    if (queue.length === 0 && (desired === null || desired > 0)) {
      try {
        controller.enqueue(payload);
        return true;
      } catch {
        return false;
      }
    }

    // Either we already have a backlog, or downstream is paused. Time for
    // priority-aware dispositions.

    // Coalescible: if queue is hot, collapse the previous same-type tail entry
    // rather than letting the queue grow unbounded with stale chunks.
    if (priority === 'coalescible' && queue.length >= COALESCE_HIGH_WATER) {
      // Find the most recent same-event entry and collapse it in place.
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].event === event) {
          // 1.2.8(M3): incremental text (`chat:message-chunk`) must MERGE
          // (string append) — replacing would silently drop never-delivered
          // middle text. Latest-wins state snapshots (`chat:context-usage`
          // etc.) keep replace semantics. On frame-decode failure fall back
          // to replace rather than risk corrupting the stream.
          if (event === 'chat:message-chunk') {
            const prev = decodeMessageChunkPayload(queue[i].chunk);
            const next = decodeMessageChunkPayload(payload);
            queue[i].chunk = prev !== null && next !== null
              ? formatSse(event, prev + next)
              : payload;
          } else {
            queue[i].chunk = payload;
          }
          sseMetrics.coalesceReplace += 1;
          drainQueue();
          return true;
        }
      }
      // No prior same-type entry — fall through to normal append.
    }

    // Hard ceiling check.
    //
    // Fix #6 (review-by-cc + review-by-codex): critical events used to bypass
    // MAX_QUEUE_PER_CLIENT *unboundedly* — a wedged renderer + buggy plugin
    // emitting many critical events (e.g. chat:status) could
    // grow the queue forever, OOMing the sidecar. We now apply a secondary
    // hard cap MAX_QUEUE_HARD_LIMIT (10x the soft cap). Beyond that, even
    // critical events trigger a force-close on the slow client — better to
    // evict than to OOM.
    if (queue.length >= MAX_QUEUE_HARD_LIMIT) {
      console.warn(
        `[sse] hard cap exceeded, force-closing slow client ${client?.id ?? 'unknown'} (reason=oom-defense queue=${queue.length} event=${event})`,
      );
      // Evict immediately so subsequent broadcasts don't try to enqueue.
      bumpDropped(event);
      try { client?.close?.(); } catch { /* ignore */ }
      return false;
    }

    if (queue.length >= MAX_QUEUE_PER_CLIENT) {
      if (priority === 'critical') {
        sseMetrics.slowConsumerEnqueue += 1;
        if (!slowConsumerLogged) {
          slowConsumerLogged = true;
          console.warn(
            `[sse] slow client ${client?.id ?? 'unknown'}: forcing critical ${event} through (queue=${queue.length})`,
          );
        }
        // fall through to push
      } else {
        bumpDropped(event);
        return false;
      }
    }

    if (priority === 'droppable' && (desired !== null && desired <= 0)) {
      bumpDropped(event);
      return false;
    }

    queue.push({ event, priority, chunk: payload });

    if (priority === 'critical' && (desired === null || desired > 0)) {
      drainQueue();
      return true;
    }

    if (priority === 'critical') {
      // Fix #6: PRD §2.3.2 contract — when a critical event sees
      // desiredSize<=0, "wait briefly" before forcing through. We can't
      // synchronously await here (would block other broadcasts), but we
      // schedule a deferred drainQueue() for ~CRITICAL_BACKOFF_MS in case
      // downstream recovers. The event is already enqueued so it'll be
      // delivered as soon as the controller has room (either via this
      // timer's drain attempt, or via pull() if downstream consumes
      // sooner). The slow-client log fires above when the queue actually
      // fills.
      const backoffTimer = setTimeout(() => {
        try { drainQueue(); } catch { /* ignore */ }
      }, _CRITICAL_BACKOFF_MS);
      backoffTimer.unref?.();
      drainQueue();
      return true;
    }

    drainQueue();
    return true;
  };

  client = {
    id: randomUUID(),
    send: (event, data) => {
      try {
        const payload = formatSse(event, data);
        dispatchWithBackpressure(event, payload);
      } catch {
        if (client) {
          clients.delete(client);
          onClose(client);
          console.log(`[sse] client disconnected id=${client.id} total=${clients.size}`);
          client = null;
        }
      }
    },
    close: () => {
      if (!controller) {
        return;
      }
      // Force-flush any queued backlog before closing. Without `force`, a
      // paused downstream (desiredSize ≤ 0) would lose tail criticals on EOF;
      // here we want every queued event to land in the readable side's
      // internal buffer so the consumer's last `read()`s return them.
      try { drainQueue(true); } catch { /* ignore */ }
      controller.close();
      controller = null;
      queue.length = 0;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (client) {
        clients.delete(client);
        onClose(client);
        console.log(`[sse] client disconnected id=${client.id} total=${clients.size}`);
        client = null;
      }
    }
  };

  clients.add(client);
  console.log(`[sse] client connected id=${client.id} total=${clients.size}`);

  // Send cached log history to newly connected client (Ring Buffer for early logs)
  // Only replay logs from BEFORE this client connected — logs after connectTime
  // are already delivered by live broadcast (client was added to `clients` above).
  const connectTime = localTimestamp();
  try {
    import('./logger').then(({ getLogHistory }) => {
      const history = getLogHistory();
      const replayEntries = history.filter(e => e.timestamp < connectTime);
      if (replayEntries.length > 0) {
        // Small delay to ensure connection is stable
        setTimeout(() => {
          replayEntries.forEach(entry => {
            client?.send('chat:log', entry);
          });
        }, 200);
      }
    }).catch(() => {
      // Ignore if logger not yet initialized
    });
  } catch {
    // Ignore
  }

  // Replay last-value cache to newly connected client.
  // Solves the "late joiner" problem: a Tab connecting to a mid-flight IM session
  // immediately receives the current session state (e.g., chat:status → "running")
  // instead of appearing idle until the next live event.
  // Delay is required: the SSE stream (hono/node-server) buffers correctly, but the
  // full chain is: Node Sidecar → SSE bytes → Rust proxy parse → Tauri emit → React listener.
  // React's useEffect registers the Tauri listener AFTER first render, so a synchronous
  // replay arrives before the listener is ready and gets silently dropped.
  // 200ms matches the log replay delay and gives React enough time to mount.
  if (lastValueCache.size > 0) {
    setTimeout(() => {
      for (const [event, cached] of lastValueCache) {
        console.log(`[sse] replaying cached ${event} to client ${client?.id}`);
        client?.send(event, cached);
      }
    }, 200);
  }

  heartbeatTimer = setInterval(() => {
    if (!controller) {
      return;
    }
    try {
      controller.enqueue(heartbeatChunk());
    } catch {
      if (client) {
        clients.delete(client);
        onClose(client);
        console.log(`[sse] client disconnected id=${client.id} total=${clients.size}`);
        client = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  const response = new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      // 1.3.0(GUI):webview 直连——SSE 响应同样必须带 ACAO,否则浏览器
      // 拿到流即拦断(表现为连接建立即断、无限重连)。
      'Access-Control-Allow-Origin': '*',
    }
  });

  response.headers.set('X-SSE-Client-Id', client.id);

  return { client, response };
}
