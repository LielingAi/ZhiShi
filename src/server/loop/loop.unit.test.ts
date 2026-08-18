/**
 * M1 — loop（loop/loop.ts）+ one-shot（loop/one-shot.ts）unit tests.
 *
 * loop：mapAgentEvent 纯映射断言（pi AgentEvent → 归一化 LoopEvent）+
 * runLoop 集成（mock pi-agent-core 的 agentLoop，验证事件流归一化与
 * prompt/messages 契约）。one-shot：fake Models.completeSimple 断言
 * 成功文本提取 / stopReason error 翻出 / 异常与空响应 → error 分支。
 * 绝无网络。
 */
import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Models } from '@earendil-works/pi-ai';

import { mapAgentEvent, runLoop, runLoopText } from './loop';
import { extractText, oneShot, oneShotResult } from './one-shot';

// ---- runLoop 集成：mock pi 的 agentLoop（模块级，类型导出不受影响）----

const agentLoopMock = vi.fn();
vi.mock('@earendil-works/pi-agent-core', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@earendil-works/pi-agent-core')>();
  return { ...orig, agentLoop: (...args: unknown[]) => agentLoopMock(...args) };
});

function assistantMessage(text: string, stopReason = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'kimi-coding',
    model: 'k3',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: 0,
  } as AssistantMessage;
}

// ---- mapAgentEvent ----

describe('mapAgentEvent', () => {
  it('text_delta → text-delta', () => {
    const ev = {
      type: 'message_update',
      message: assistantMessage(''),
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hel', partial: assistantMessage('hel') },
    } as unknown as AgentEvent;
    expect(mapAgentEvent(ev)).toEqual([{ type: 'text-delta', delta: 'hel' }]);
  });

  it('tool_execution_start/end → tool-call / tool-result', () => {
    const start = { type: 'tool_execution_start', toolCallId: 't1', toolName: 'env_exec', args: { command: 'id' } } as AgentEvent;
    expect(mapAgentEvent(start)).toEqual([{ type: 'tool-call', toolCallId: 't1', toolName: 'env_exec', args: { command: 'id' } }]);

    const end = { type: 'tool_execution_end', toolCallId: 't1', toolName: 'env_exec', result: { content: [] }, isError: false } as unknown as AgentEvent;
    expect(mapAgentEvent(end)).toEqual([{ type: 'tool-result', toolCallId: 't1', toolName: 'env_exec', result: { content: [] }, isError: false }]);
  });

  it('agent_end 正常 → 仅 done', () => {
    const ev = { type: 'agent_end', messages: [assistantMessage('ok')] } as unknown as AgentEvent;
    const out = mapAgentEvent(ev);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('done');
  });

  it('agent_end 带 stopReason=error 的 assistant → error + done', () => {
    const errMsg = { ...assistantMessage('', 'error'), errorMessage: 'HTTP 401' } as AssistantMessage;
    const ev = { type: 'agent_end', messages: [errMsg] } as unknown as AgentEvent;
    const out = mapAgentEvent(ev);
    expect(out.map((e) => e.type)).toEqual(['error', 'done']);
    expect(out[0]).toMatchObject({ error: 'HTTP 401' });
  });

  it('结构性事件（turn_start 等）→ 空', () => {
    expect(mapAgentEvent({ type: 'turn_start' } as AgentEvent)).toEqual([]);
    expect(mapAgentEvent({ type: 'agent_start' } as AgentEvent)).toEqual([]);
  });
});

// ---- runLoop ----

describe('runLoop', () => {
  const fakeModels = {} as Models;
  const fakeModel = { id: 'k3' } as never;

  it('prompt 与 messages 都缺 → error 事件，不触达 agentLoop', async () => {
    agentLoopMock.mockReset();
    const events = [];
    for await (const e of runLoop({ model: fakeModel, models: fakeModels })) events.push(e);
    expect(events).toEqual([{ type: 'error', error: expect.stringContaining('至少提供一个') }]);
    expect(agentLoopMock).not.toHaveBeenCalled();
  });

  it('pi 事件流经归一化后原序产出；getApiKey/beforeToolCall 透传', async () => {
    const piEvents: AgentEvent[] = [
      { type: 'message_update', message: assistantMessage(''), assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'A', partial: assistantMessage('A') } } as unknown as AgentEvent,
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'env_exec', args: { command: 'hostname' } } as AgentEvent,
      { type: 'tool_execution_end', toolCallId: 't1', toolName: 'env_exec', result: { content: [{ type: 'text', text: 'fuzz' }] }, isError: false } as unknown as AgentEvent,
      { type: 'agent_end', messages: [{ role: 'user', content: 'p', timestamp: 0 }, assistantMessage('done-text')] } as unknown as AgentEvent,
    ];
    agentLoopMock.mockReset();
    agentLoopMock.mockReturnValue((async function* () { for (const e of piEvents) yield e; })());

    const getApiKey = () => 'k';
    const beforeToolCall = async () => undefined;
    const events = [];
    for await (const e of runLoop({
      prompt: '查主机名',
      systemPrompt: 'sys',
      model: fakeModel,
      models: fakeModels,
      getApiKey,
      beforeToolCall,
      tools: [],
    })) events.push(e);

    expect(events.map((e) => e.type)).toEqual(['text-delta', 'tool-call', 'tool-result', 'done']);
    // 配置透传断言
    const config = agentLoopMock.mock.calls[0][2];
    expect(config.getApiKey).toBe(getApiKey);
    expect(config.beforeToolCall).toBe(beforeToolCall);
    // streamFn 由 models 提供（第 5 参）
    expect(typeof agentLoopMock.mock.calls[0][4]).toBe('function');
  });

  it('W1 — getSteeringMessages 原样透传给 pi agentLoop 配置', async () => {
    agentLoopMock.mockReset();
    agentLoopMock.mockReturnValue((async function* () {
      yield { type: 'agent_end', messages: [assistantMessage('ok')] } as unknown as AgentEvent;
    })());
    const getSteeringMessages = async () => [];
    for await (const _ of runLoop({
      prompt: 'x',
      model: fakeModel,
      models: fakeModels,
      getSteeringMessages,
    })) { /* 消费完即可 */ }
    const config = agentLoopMock.mock.calls[0][2];
    expect(config.getSteeringMessages).toBe(getSteeringMessages);
  });

  it('runLoopText：拼接最终 assistant 文本；error 事件透出', async () => {
    agentLoopMock.mockReset();
    const errMsg = { ...assistantMessage('', 'error'), errorMessage: 'boom' } as AssistantMessage;
    agentLoopMock.mockReturnValue((async function* () {
      yield { type: 'agent_end', messages: [errMsg] } as unknown as AgentEvent;
    })());
    const r = await runLoopText({ prompt: 'x', model: fakeModel, models: fakeModels });
    expect(r.error).toBe('boom');
    expect(r.text).toBe('');
  });
});

// ---- one-shot ----

function fakeModelsWith(message: Partial<AssistantMessage> | Error): Models {
  return {
    completeSimple: async () => {
      if (message instanceof Error) throw message;
      return message;
    },
  } as unknown as Models;
}

describe('oneShotResult', () => {
  const model = { id: 'k3' } as never;

  it('成功：提取全部 text 块', async () => {
    const models = fakeModelsWith({ stopReason: 'stop', content: [{ type: 'text', text: '标题A' }] });
    const r = await oneShotResult({ prompt: 'p', model, models, apiKey: 'k' });
    expect(r).toEqual({ ok: true, text: '标题A' });
  });

  it('stopReason=error → ok:false 带 errorMessage', async () => {
    const models = fakeModelsWith({ stopReason: 'error', errorMessage: 'HTTP 401 unauthorized', content: [] });
    const r = await oneShotResult({ prompt: 'p', model, models });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('HTTP 401 unauthorized');
  });

  it('completeSimple 抛错 → ok:false（不向上 throw）', async () => {
    const models = fakeModelsWith(new Error('socket hangup'));
    const r = await oneShotResult({ prompt: 'p', model, models });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('socket hangup');
  });

  it('空文本响应 → ok:false', async () => {
    const models = fakeModelsWith({ stopReason: 'stop', content: [{ type: 'text', text: '  ' }] });
    const r = await oneShotResult({ prompt: 'p', model, models });
    expect(r.ok).toBe(false);
  });
});

describe('oneShot（便捷封装）', () => {
  const model = { id: 'k3' } as never;

  it('成功返回文本，失败返回 null', async () => {
    const ok = fakeModelsWith({ stopReason: 'stop', content: [{ type: 'text', text: 't' }] });
    expect(await oneShot({ prompt: 'p', model, models: ok })).toBe('t');
    const bad = fakeModelsWith(new Error('x'));
    expect(await oneShot({ prompt: 'p', model, models: bad })).toBeNull();
  });
});

describe('extractText', () => {
  it('多 text 块换行拼接；非 text 块忽略', () => {
    expect(extractText([
      { type: 'thinking', text: undefined },
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ])).toBe('a\nb');
  });
});
