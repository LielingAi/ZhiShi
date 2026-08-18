/**
 * M4a — SSE 适配器:LoopEvent → 现有 SSE 事件(纯函数)。
 *
 * TUI/渲染器零改动的关键:事件名与 payload 形状逐字段对齐 SDK 路径
 * (agent-session.ts 的 broadcast 调用点):
 *
 *   LoopEvent          SSE 事件                     payload
 *   ─────────────────  ───────────────────────────  ──────────────────────────────
 *   text-delta         chat:message-chunk           string(delta 原文)
 *   thinking-start     chat:thinking-start          { index }（M4b,SDK 同形）
 *   thinking-delta     chat:thinking-chunk          { index, delta }（M4b,SDK 同形）
 *   tool-call          chat:tool-use-start          { id, name, input, streamIndex }
 *   tool-result        chat:tool-result-complete    { toolUseId, content }
 *   done               chat:message-complete        { model, input_tokens, output_tokens,
 *                                                     cache_read_tokens, cache_creation_tokens,
 *                                                     tool_count, duration_ms }
 *   error              chat:message-error           string
 *
 * (chat:message-stopped / chat:system-init / chat:context-usage 不由 LoopEvent
 * 驱动——分别由 stop 端点、会话启动、chat-engine 在 turn 末发,见
 * chat-engine.ts。)
 *
 * 纯函数,单测逐事件断言;payload 里绝不放 apiKey/环境凭据。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import type { LoopEvent } from './loop';

export interface SseOut {
  event: string;
  data: unknown;
}

export interface SseAdapterContext {
  /** 展示用模型 id(缺省取最后一条 assistant 消息的 model 字段)。 */
  model?: string;
  /** turn 开始时间(Date.now()),用于 duration_ms。 */
  startedAt?: number;
  /** tool-use-start 的 streamIndex(SDK 用 content block 下标;loop 无此概念,缺省 0)。 */
  streamIndex?: number;
  /** done 负载的耗时兜底(now - startedAt 之外的显式值,测试用)。 */
  durationMs?: number;
}

/** 从 pi AgentToolResult/未知 result 形状提取文本内容。 */
export function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
      ? (b as { text: string }).text
      : ''))
    .filter(Boolean)
    .join('\n');
}

/** done 负载:从本次新增消息聚合 usage 与工具数(与 SDK currentTurnUsage 同义)。 */
export function buildMessageCompletePayload(
  messages: AgentMessage[],
  ctx: SseAdapterContext,
): Record<string, unknown> {
  const assistants = messages.filter((m) => m.role === 'assistant');
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let model: string | undefined = ctx.model;
  for (const m of assistants) {
    const usage = (m as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
    if (usage) {
      input += usage.input ?? 0;
      output += usage.output ?? 0;
      cacheRead += usage.cacheRead ?? 0;
      cacheWrite += usage.cacheWrite ?? 0;
    }
    if (!model) model = (m as { model?: string }).model;
  }
  let toolCount = 0;
  for (const m of messages) {
    if (m.role === 'toolResult') toolCount++;
  }
  return {
    model,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheWrite,
    tool_count: toolCount,
    duration_ms: ctx.durationMs ?? (ctx.startedAt ? Date.now() - ctx.startedAt : 0),
  };
}

/** 单个 LoopEvent → 0..n 个 SSE 事件(保序)。 */
export function mapLoopEventToSse(event: LoopEvent, ctx: SseAdapterContext = {}): SseOut[] {
  switch (event.type) {
    case 'text-delta':
      return [{ event: 'chat:message-chunk', data: event.delta }];
    case 'thinking-start':
      // SDK 路径用 content block 下标;loop 单 thinking 流,恒 0。
      return [{ event: 'chat:thinking-start', data: { index: ctx.streamIndex ?? 0 } }];
    case 'thinking-delta':
      return [{ event: 'chat:thinking-chunk', data: { index: ctx.streamIndex ?? 0, delta: event.delta } }];
    case 'tool-call':
      return [{
        event: 'chat:tool-use-start',
        data: {
          id: event.toolCallId,
          name: event.toolName,
          input: event.args ?? {},
          streamIndex: ctx.streamIndex ?? 0,
        },
      }];
    case 'tool-result':
      return [{
        event: 'chat:tool-result-complete',
        data: { toolUseId: event.toolCallId, content: toolResultText(event.result) },
      }];
    case 'done':
      return [{ event: 'chat:message-complete', data: buildMessageCompletePayload(event.messages, ctx) }];
    case 'error':
      return [{ event: 'chat:message-error', data: event.error }];
    default:
      return [];
  }
}
