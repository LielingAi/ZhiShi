/**
 * M1 — 自研 agent loop：pi agentLoop 的薄包装 + 事件归一化。
 *
 * 对外是一个 async iterable 的 {@link LoopEvent} 流，命名对齐本仓 SSE
 * 习惯（kebab-case：text-delta / tool-call / tool-result / done / error，
 * 参照 sse.ts 的 chat:message-chunk 一族）。pi 的 AgentEvent 到 LoopEvent
 * 的映射集中在 {@link mapAgentEvent}（纯函数，单测直接断言）。
 *
 * 契约：
 * - convertToLlm 是白名单过滤（只放行 user/assistant/toolResult 三类标准
 *   LLM 消息；pi 的自定义消息类型——如 BashExecutionMessage——在此滤掉,
 *   见 runLoop 内 convertToLlm 注释）。
 * - getApiKey 由调用方注入（每次 LLM 调用前动态解析，pi 契约）。
 * - beforeToolCall 原样透传给 pi——M2 的边界规则挂在这里，本层不加料。
 * - pi 的 assistant 错误（stopReason "error"/"aborted"）归一化为末尾的
 *   { type:'error' } 事件，然后照常 { type:'done' } 收尾。
 */

import {
  agentLoop,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import type { Api, Model, Models, ThinkingLevel } from '@earendil-works/pi-ai';
// pi 1.1.0：系统提示 + 工具声明改由会话头部的 system 消息承载（adapters 经
// getCurrentTools 从 transcript 提取 tools；AgentContext.systemPrompt 字段已删）。
import { createInitialSystemMessage, toToolDeclaration } from '@earendil-works/pi-ai/utils/transcript';

// ---------------------------------------------------------------------------
// Normalized event stream
// ---------------------------------------------------------------------------

export type LoopEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'thinking-start' }
  | { type: 'thinking-delta'; delta: string }
  | { type: 'thinking-end' }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: 'done'; messages: AgentMessage[] }
  | { type: 'error'; error: string };

/**
 * pi AgentEvent → LoopEvent（纯映射）。一个 pi 事件可映射为 0..n 个
 * LoopEvent（不关心的结构性事件映射为空数组）。
 */
export function mapAgentEvent(event: AgentEvent): LoopEvent[] {
  switch (event.type) {
    case 'message_update': {
      const inner = event.assistantMessageEvent;
      if (inner.type === 'text_delta') {
        return [{ type: 'text-delta', delta: inner.delta }];
      }
      if (inner.type === 'thinking_start') {
        return [{ type: 'thinking-start' }];
      }
      if (inner.type === 'thinking_delta') {
        return [{ type: 'thinking-delta', delta: inner.delta }];
      }
      // 1.2.8(H1):thinking 块收尾也要归一化——否则 TUI 的 thinking 块
      // 永远停在 streaming 态(pi 的 thinking_end 在 message_update 内)。
      if (inner.type === 'thinking_end') {
        return [{ type: 'thinking-end' }];
      }
      return [];
    }
    case 'tool_execution_start':
      return [{ type: 'tool-call', toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }];
    case 'tool_execution_end':
      return [{
        type: 'tool-result',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      }];
    case 'agent_end': {
      const out: LoopEvent[] = [];
      // pi 把 LLM 失败编码为 stopReason error/aborted 的 assistant 消息，
      // 不 throw——归一化成 error 事件，调用方才看得到失败。
      const lastAssistant = [...event.messages].reverse().find((m) => m.role === 'assistant');
      if (lastAssistant && (lastAssistant.stopReason === 'error' || lastAssistant.stopReason === 'aborted')) {
        out.push({ type: 'error', error: lastAssistant.errorMessage ?? `LLM call ${lastAssistant.stopReason}` });
      }
      out.push({ type: 'done', messages: event.messages });
      return out;
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// runLoop
// ---------------------------------------------------------------------------

export type BeforeToolCallHook = (
  context: BeforeToolCallContext,
  signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined>;

export type AfterToolCallHook = (
  context: AfterToolCallContext,
  signal?: AbortSignal,
) => Promise<AfterToolCallResult | undefined>;

export interface RunLoopOptions {
  /** 单条用户消息（与 messages 二选一）。 */
  prompt?: string;
  /** 完整消息序列（AgentMessage[]，M1 均为标准 LLM 消息）。 */
  messages?: AgentMessage[];
  /**
   * 恢复的历史消息（M2 session 恢复语义）：进 context.messages，不算
   * 本次新增——done 事件返回的 newMessages 只含 prompts + 新产出，可
   * 直接 appendLoopMessages 续存，无重复。loadLoopSession 的输出直接
   * 喂这里即可。
   */
  history?: AgentMessage[];
  systemPrompt?: string;
  model: Model<Api>;
  /** pi Models 集合（streamFn 来源；与 model 同出 resolveLoopModel）。 */
  models: Models;
  getApiKey?: () => string | undefined | Promise<string | undefined>;
  tools?: AgentTool[];
  signal?: AbortSignal;
  /** M2 边界规则挂载点——原样透传给 pi 的 beforeToolCall。 */
  beforeToolCall?: BeforeToolCallHook;
  /** M3 输出审计挂载点（output-guard）——原样透传给 pi 的 afterToolCall。 */
  afterToolCall?: AfterToolCallHook;
  /** M3 压缩挂载点——原样透传给 pi 的 transformContext（只影响当次 LLM 上下文）。 */
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  /** M4b thinking 档位（pi SimpleStreamOptions.reasoning；仅 model.reasoning=true 时传）。 */
  reasoning?: ThinkingLevel;
  /**
   * W1 steering(design-spec §6.1 纠偏档)——运行中注入的用户消息来源，
   * 原样透传给 pi 的 getSteeringMessages(turn 间轮询,返回 [] = 无注入)。
   */
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  /** 1.5.13：模型静默看门狗阈值（模型流式阶段无事件的最大容忍；工具执行
   *  阶段不计时）。缺省 MODEL_SILENCE_TIMEOUT_MS；测试注入小值。 */
  modelSilenceTimeoutMs?: number;
  /**
   * 1.7.2：首事件看门狗阈值（收到**任意**模型事件之前的 prefill 容忍——
   * 大上下文 prefill 90-130s 属正常,90s 静默看门狗会误杀,实机 4 连超时
   * 实证)。缺省 MODEL_FIRST_EVENT_TIMEOUT_MS；测试注入小值。
   */
  modelFirstEventTimeoutMs?: number;
  /**
   * 1.8.4：看门狗宽限窗口（超时上屏后继续排空挂起流的时长——pi 的
   * generator 不被消费也照跑，晚到的 agent_end 照常出 done，turn 失败
   * 但工作不丢；缺省 MODEL_WATCHDOG_GRACE_MS；测试注入小值）。
   */
  modelWatchdogGraceMs?: number;
  maxTokens?: number;
}

/** Models.streamSimple 即 pi StreamFn 的现成实现（bind 后透传）。 */
export function streamFnFromModels(models: Models): StreamFn {
  return (model, context, options) => models.streamSimple(model, context, options);
}

/** 1.5.13：模型流式静默看门狗缺省阈值（90s——实机形态：供应商挂起零 token
 *  99s 无事件；正常流式 chunk 间隔远低于此）。 */
export const MODEL_SILENCE_TIMEOUT_MS = 90_000;

/** 1.7.2：首事件看门狗缺省阈值（300s——1M 上下文 prefill 实测 60-130s；
 *  90s 静默看门狗不分 prefill 与流间,在首 chunk 到达前误杀）。 */
export const MODEL_FIRST_EVENT_TIMEOUT_MS = 300_000;

/** 1.8.4：看门狗宽限缺省窗口（60s——超时上屏后给挂起流的恢复预算；
 *  实机：deepseek 挂起 90s 后 55s 恢复并完成，60s 覆盖该形态）。 */
export const MODEL_WATCHDOG_GRACE_MS = 60_000;

/**
 * 跑一轮 agent loop（可能含多 turn：工具调用 → 结果回注 → 再调模型），
 * 以归一化事件流产出。调用方 for await 消费即可。
 */
export async function* runLoop(options: RunLoopOptions): AsyncIterable<LoopEvent> {
  const prompts: AgentMessage[] = options.messages
    ?? (options.prompt !== undefined
      ? [{ role: 'user', content: options.prompt, timestamp: Date.now() }]
      : []);
  if (prompts.length === 0) {
    yield { type: 'error', error: 'runLoop: prompt 与 messages 至少提供一个' };
    return;
  }

  // pi 1.1.0 适配：自建头部 system 消息（系统提示 + 全量工具声明一次性写入，
  // 与 pi 自家 Agent 的 initialState 播种同形态）。放 context.messages 而非
  // prompts——prompts 会进 newMessages（轨迹污染 + 每 turn 重放），context
  // 侧零外溢；declareToolChanges 见状（toolsAdded 已全量声明）不再合成插入
  // 消息。window-transform 的 segmentContext 把首个 user 前的消息并入段 0
  // （anchor 恒保留）——system 消息自然永不参与置换。
  const systemMessage = createInitialSystemMessage(
    options.systemPrompt,
    options.tools?.map((t) => toToolDeclaration(t)),
  );
  const contextMessages: AgentMessage[] = systemMessage
    ? [systemMessage as unknown as AgentMessage, ...(options.history ?? [])]
    : [...(options.history ?? [])];

  const stream = agentLoop(
    prompts,
    {
      messages: contextMessages,
      tools: options.tools,
    },
    {
      model: options.model,
      // 白名单过滤（只放行标准 LLM 消息；pi 的自定义消息类型——如
      // BashExecutionMessage——在此过滤，契约见 AgentLoopConfig.convertToLlm）。
      // pi 1.1.0 起 system 也走消息带（系统提示+toolsAdded 声明），不过滤会
      // 把整条系统提示丢掉。
      convertToLlm: (messages) => messages.filter(
        (m): m is Extract<AgentMessage, { role: 'user' | 'assistant' | 'toolResult' | 'system' }> =>
          m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult' || m.role === 'system',
      ),
      getApiKey: options.getApiKey,
      beforeToolCall: options.beforeToolCall,
      afterToolCall: options.afterToolCall,
      transformContext: options.transformContext,
      reasoning: options.reasoning,
      getSteeringMessages: options.getSteeringMessages,
      maxTokens: options.maxTokens,
    },
    options.signal,
    streamFnFromModels(options.models),
  );

  // 1.5.13 模型静默看门狗（实机：deepseek API 挂起 99s 零 token——GUI 永远
  // 「思考中」）：模型流式阶段连续无事件 → 判挂起，中断并报明确错误。
  // 工具执行阶段不计时（tool_execution_start→end 之间——长 env_exec/下载
  // 合法地分钟级无事件）。
  // 1.7.2 分层：收到任意事件前按首事件预算计时（prefill 期——大上下文
  // 首 token 90-130s 属正常,90s 流间看门狗误杀实机实证）；收到后恢复
  // 流间静默阈值。
  const silenceMs = options.modelSilenceTimeoutMs ?? MODEL_SILENCE_TIMEOUT_MS;
  const firstEventMs = options.modelFirstEventTimeoutMs ?? MODEL_FIRST_EVENT_TIMEOUT_MS;
  const iter = stream[Symbol.asyncIterator]();
  let inToolExecution = false;
  let receivedAny = false;
  // 持久 next 句柄：race 超时绝不丢弃在途 next——异步生成器的 next() 串行化，
  // 对已挂起的 next 再发 next 只会排队，后到的 agent_end 会被吞进被丢弃的
  // promise 里（2026-09-28 实证：超时后重发 next 读回 {done}，done 事件丢失）。
  let pending = iter.next();
  const advance = () => { pending = iter.next(); };

  // 共享事件处理（主循环与宽限排空同一口径）：边界切换 + 映射产出，
  // agent_end 视为终局。
  async function* handleEvent(event: AgentEvent): AsyncGenerator<LoopEvent, boolean> {
    if (event.type === 'tool_execution_start') inToolExecution = true;
    else if (event.type === 'tool_execution_end') inToolExecution = false;
    for (const mapped of mapAgentEvent(event)) yield mapped;
    return event.type === 'agent_end';
  }

  for (;;) {
    let result: IteratorResult<AgentEvent>;
    if (inToolExecution) {
      // 工具执行期：纯等，不看门狗
      result = await pending;
      if (!result.done) advance();
    } else {
      const activeMs = receivedAny ? silenceMs : firstEventMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const raced = await Promise.race([
        pending.then((r): { kind: 'event'; result: IteratorResult<AgentEvent> } => {
          clearTimeout(timer);
          return { kind: 'event', result: r };
        }),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'timeout' }), activeMs);
        }),
      ]);
      if (raced.kind === 'timeout') {
        // 先让失败上屏（引擎据此记 failed）——但不 iter.return 杀生成器：
        // pi 的 agent generator 不被消费也照跑（实机 2026-09-28：deepseek
        // 挂起 90s 被判超时，55s 后恢复并完成全部工作）——杀了它，晚到的
        // 工具产出与消息全蒸发（turn 的 loop jsonl 永远缺失）。
        yield {
          type: 'error',
          error: receivedAny
            ? `模型响应超时（${Math.round(activeMs / 1000)}s 无任何数据流回）——供应商或网络挂起，已中断。请重试或换模型。`
            : `模型响应超时（${Math.round(activeMs / 1000)}s 无首 token——上下文较大 prefill 慢或供应商挂起，已中断。可 /reset 开新会话或稍后重试。`,
        };
        // 宽限排空（modelWatchdogGraceMs，缺省 60s）：复用同一个 pending
        // 继续消费——晚到的事件照常映射，agent_end 到达即出 done（消息
        // 续存依赖它：turn 失败但工作不丢）。宽限耗尽仍无产出才中断。
        const graceMs = options.modelWatchdogGraceMs ?? MODEL_WATCHDOG_GRACE_MS;
        const graceDeadline = Date.now() + graceMs;
        for (;;) {
          if (inToolExecution) {
            // 工具执行期：纯等，不看宽限（与主循环同规则）
            const r = await pending;
            if (!r.done) advance();
            if (r.done) return;
            receivedAny = true;
            const terminal = yield* handleEvent(r.value);
            if (terminal) return;
            continue;
          }
          const remaining = graceDeadline - Date.now();
          if (remaining <= 0) break;
          let graceTimer: ReturnType<typeof setTimeout> | undefined;
          const graceRaced = await Promise.race([
            pending.then((r): { kind: 'event'; result: IteratorResult<AgentEvent> } => {
              clearTimeout(graceTimer);
              return { kind: 'event', result: r };
            }),
            new Promise<{ kind: 'timeout' }>((resolve) => {
              graceTimer = setTimeout(() => resolve({ kind: 'timeout' }), remaining);
            }),
          ]);
          if (graceRaced.kind === 'timeout') continue;
          result = graceRaced.result;
          if (!result.done) advance();
          if (result.done) return;
          receivedAny = true;
          const terminal = yield* handleEvent(result.value);
          if (terminal) return;
        }
        // 宽限耗尽仍无产出——真的死了：中断消费（iter.return 加 1s 预算
        // ——生成器挂在永不 settle 的 promise 上时 return 也会挂死）。
        await Promise.race([
          (async () => { await iter.return?.(undefined).catch(() => {}); })(),
          new Promise((r) => setTimeout(r, 1000)),
        ]);
        return;
      }
      result = raced.result;
      if (!result.done) advance();
    }
    if (result.done) break;
    receivedAny = true; // 任意事件到达即切换回流间看门狗
    // 工具执行边界（映射前的 pi 事件名）：进入后停表，出来后恢复。
    const terminal = yield* handleEvent(result.value);
    if (terminal) break;
  }
}

/** 便捷收集器：跑完 loop 返回最终文本（拼接最后一个 assistant 的 text）。 */
export async function runLoopText(options: RunLoopOptions): Promise<{ text: string; error?: string }> {
  let error: string | undefined;
  let messages: AgentMessage[] = [];
  for await (const event of runLoop(options)) {
    if (event.type === 'error') error = event.error;
    if (event.type === 'done') messages = event.messages;
  }
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const text = lastAssistant
    ? lastAssistant.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    : '';
  return { text, error };
}
