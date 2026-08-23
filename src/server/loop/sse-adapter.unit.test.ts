/**
 * M4a — sse-adapter(loop/sse-adapter.ts)unit tests.
 *
 * 逐事件断言 LoopEvent → SSE 映射:事件名与 payload 形状和 SDK 路径
 * (agent-session.ts 的 broadcast 调用点)逐字段对齐。纯函数,无 I/O。
 */
import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import type { LoopEvent } from './loop';
import { buildMessageCompletePayload, mapLoopEventToSse, toolResultText } from './sse-adapter';

function assistantWithUsage(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }, model = 'k3'): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 't' }],
    model,
    usage: { ...usage, totalTokens: 0, cost: {} },
    stopReason: 'stop',
    timestamp: 0,
  } as unknown as AgentMessage;
}

describe('mapLoopEventToSse(逐事件对齐 SDK 路径)', () => {
  it('text-delta → chat:message-chunk(裸字符串,与 SDK 同形)', () => {
    const out = mapLoopEventToSse({ type: 'text-delta', delta: '你好' });
    expect(out).toEqual([{ event: 'chat:message-chunk', data: '你好' }]);
  });

  it('thinking-start/delta → chat:thinking-start / chat:thinking-chunk(SDK 同形)', () => {
    expect(mapLoopEventToSse({ type: 'thinking-start' })).toEqual([
      { event: 'chat:thinking-start', data: { index: 0 } },
    ]);
    expect(mapLoopEventToSse({ type: 'thinking-delta', delta: '让我想想' })).toEqual([
      { event: 'chat:thinking-chunk', data: { index: 0, delta: '让我想想' } },
    ]);
  });

  it('thinking-end → chat:thinking-complete { index }(1.2.8 H1,与 thinking-start 同 index)', () => {
    expect(mapLoopEventToSse({ type: 'thinking-end' })).toEqual([
      { event: 'chat:thinking-complete', data: { index: 0 } },
    ]);
  });

  it('tool-call → chat:tool-use-start { id, name, input, streamIndex }', () => {
    const out = mapLoopEventToSse({ type: 'tool-call', toolCallId: 'tc1', toolName: 'env_exec', args: { command: 'id' } });
    expect(out).toEqual([{
      event: 'chat:tool-use-start',
      data: { id: 'tc1', name: 'env_exec', input: { command: 'id' }, streamIndex: 0 },
    }]);
  });

  it('tool-result → chat:tool-result-complete { toolUseId, content, isError }(1.2.8 H2)', () => {
    const ev: LoopEvent = {
      type: 'tool-result', toolCallId: 'tc1', toolName: 'env_exec',
      result: { content: [{ type: 'text', text: 'exit=0\nfuzz' }], details: {} },
      isError: false,
    };
    const out = mapLoopEventToSse(ev);
    expect(out).toEqual([{ event: 'chat:tool-result-complete', data: { toolUseId: 'tc1', content: 'exit=0\nfuzz', isError: false } }]);
  });

  it('tool-result isError:true 原样透传(TUI reducer 按它定 fail 终态)', () => {
    const ev: LoopEvent = {
      type: 'tool-result', toolCallId: 'tc2', toolName: 'env_exec',
      result: { content: [{ type: 'text', text: 'command not found' }] },
      isError: true,
    };
    const out = mapLoopEventToSse(ev);
    expect(out).toEqual([{ event: 'chat:tool-result-complete', data: { toolUseId: 'tc2', content: 'command not found', isError: true } }]);
  });

  it('done → chat:message-complete(usage 聚合 + tool_count + duration_ms)', () => {
    const messages = [
      { role: 'user', content: 'q', timestamp: 0 },
      assistantWithUsage({ input: 100, output: 20, cacheRead: 30, cacheWrite: 5 }),
      { role: 'toolResult', toolCallId: 't1', toolName: 'env_exec', content: [], isError: false, timestamp: 1 },
      assistantWithUsage({ input: 200, output: 40, cacheRead: 10, cacheWrite: 2 }),
    ] as unknown as AgentMessage[];
    const out = mapLoopEventToSse({ type: 'done', messages }, { model: 'k3', durationMs: 1234 });
    expect(out).toHaveLength(1);
    expect(out[0].event).toBe('chat:message-complete');
    expect(out[0].data).toEqual({
      model: 'k3',
      input_tokens: 300,
      output_tokens: 60,
      cache_read_tokens: 40,
      cache_creation_tokens: 7,
      tool_count: 1,
      duration_ms: 1234,
    });
  });

  it('error → chat:message-error(裸字符串)', () => {
    const out = mapLoopEventToSse({ type: 'error', error: 'HTTP 401' });
    expect(out).toEqual([{ event: 'chat:message-error', data: 'HTTP 401' }]);
  });
});

describe('toolResultText', () => {
  it('字符串原样;content 块拼接;异常形状空串', () => {
    expect(toolResultText('raw')).toBe('raw');
    expect(toolResultText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
    expect(toolResultText(undefined)).toBe('');
    expect(toolResultText({})).toBe('');
  });
});

describe('buildMessageCompletePayload', () => {
  it('无 assistant/usage → 零值安全;model 缺省取消息字段', () => {
    const p = buildMessageCompletePayload([], { durationMs: 1 });
    expect(p.input_tokens).toBe(0);
    expect(p.tool_count).toBe(0);
    const p2 = buildMessageCompletePayload(
      [assistantWithUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, 'model-x')],
      { durationMs: 1 },
    );
    expect(p2.model).toBe('model-x');
  });
});
