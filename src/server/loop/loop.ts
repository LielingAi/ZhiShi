/**
 * M1 — 自研 agent loop：pi agentLoop 的薄包装 + 事件归一化。
 *
 * 对外是一个 async iterable 的 {@link LoopEvent} 流，命名对齐本仓 SSE
 * 习惯（kebab-case：text-delta / tool-call / tool-result / done / error，
 * 参照 sse.ts 的 chat:message-chunk 一族）。pi 的 AgentEvent 到 LoopEvent
 * 的映射集中在 {@link mapAgentEvent}（纯函数，单测直接断言）。
 *
 * 契约：
 * - convertToLlm 恒等（M1 只有标准 LLM 消息；自定义消息类型留给 M2+）。
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
  maxTokens?: number;
}

/** Models.streamSimple 即 pi StreamFn 的现成实现（bind 后透传）。 */
export function streamFnFromModels(models: Models): StreamFn {
  return (model, context, options) => models.streamSimple(model, context, options);
}

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

  const stream = agentLoop(
    prompts,
    {
      systemPrompt: options.systemPrompt ?? '',
      messages: options.history ?? [],
      tools: options.tools,
    },
    {
      model: options.model,
      // 恒等转换（M1 只有标准 LLM 消息；pi 的自定义消息类型——如
      // BashExecutionMessage——在此过滤，契约见 AgentLoopConfig.convertToLlm）。
      convertToLlm: (messages) => messages.filter(
        (m): m is Extract<AgentMessage, { role: 'user' | 'assistant' | 'toolResult' }> =>
          m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult',
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

  for await (const event of stream) {
    for (const mapped of mapAgentEvent(event)) {
      yield mapped;
    }
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
