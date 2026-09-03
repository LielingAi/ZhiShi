/**
 * SSE 客户端单测：payload 解析 + 可注入 fetch 的流消费/重连。
 */

import { describe, expect, it } from 'vitest';

import { GuiHttpError, GuiSidecarClient, toInput, type GuiFetch, type GuiFetchResponse } from './sse-client';

describe('toInput', () => {
  it('JSON payload 解析为对象', () => {
    expect(toInput({ event: 'chat:init', data: '{"agentDir":"/w"}' })).toEqual({
      event: 'chat:init',
      payload: { agentDir: '/w' },
    });
  });
  it('裸字符串 delta（JSON 字符串）解析为 string', () => {
    expect(toInput({ event: 'chat:message-chunk', data: '"hi"' })).toEqual({
      event: 'chat:message-chunk',
      payload: 'hi',
    });
  });
  it('非 JSON 回退为原始字符串（不抛）', () => {
    expect(toInput({ event: 'x', data: 'not-json{' })).toEqual({ event: 'x', payload: 'not-json{' });
  });
});

// ── openSse 集成式单测：fake fetch 喂一段 SSE 文本后 EOF，断言事件序列 ──

function chunkResponse(text: string): GuiFetchResponse {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  let done = false;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => 'text/event-stream' },
    json: async () => ({}),
    text: async () => text,
    body: {
      getReader: () => ({
        read: async () => {
          if (done) return { done: true };
          done = true;
          return { done: false, value: bytes };
        },
        cancel: async () => {},
      }),
    },
  };
}

function fetchWith(response: GuiFetchResponse): GuiFetch {
  return async (url: string) => {
    void url;
    return response;
  };
}

describe('GuiSidecarClient.openSse', () => {
  it('消费 SSE 帧并产出 SseInput（注入 fetch，无真实网络）', async () => {
    const sseText = [
      'event: chat:init',
      'data: {"agentDir":"/w","sessionState":"idle"}',
      '',
      'event: chat:message-chunk',
      'data: "hello"',
      '',
      '',
    ].join('\n');
    const client = new GuiSidecarClient({ base: 'http://127.0.0.1:3199', fetchImpl: fetchWith(chunkResponse(sseText)) });

    const ac = new AbortController();
    const out: Array<{ event: string; payload: unknown }> = [];
    const gen = client.openSse('/chat/stream', {
      signal: ac.signal,
      onReconnect: () => {
        // 测试里主动掐断，避免重连循环
        ac.abort();
      },
    });
    for await (const input of gen) out.push(input);

    expect(out).toHaveLength(2);
    expect(out[0].event).toBe('chat:init');
    expect(out[0].payload).toEqual({ agentDir: '/w', sessionState: 'idle' });
    expect(out[1].event).toBe('chat:message-chunk');
    expect(out[1].payload).toBe('hello');
  });

  it('EOF 后自动重连（onReconnect 被调）', async () => {
    let connects = 0;
    const fetchImpl: GuiFetch = async () => {
      connects++;
      return chunkResponse('');
    };
    const client = new GuiSidecarClient({ base: 'http://x', fetchImpl });
    const ac = new AbortController();
    const gen = client.openSse('/chat/stream', {
      signal: ac.signal,
      retryDelayMs: 1,
      onReconnect: () => ac.abort(),
    });
    // 消费完第一段后重连尝试发生 → onReconnect 里 abort 退出
    for await (const _ of gen) void _;
    expect(connects).toBeGreaterThanOrEqual(1);
  });

  it('postJson 发送 JSON body 并解析 envelope', async () => {
    const fetchImpl: GuiFetch = async (_url, init) => {
      expect(init?.body).toBe(JSON.stringify({ text: 'hi' }));
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/json' },
        json: async () => ({ success: true, steering: true }),
        text: async () => '',
        body: null,
      };
    };
    const client = new GuiSidecarClient({ base: 'http://127.0.0.1:3199', fetchImpl });
    const res = await client.postJson('/chat/send', { text: 'hi' });
    expect(res).toEqual({ success: true, steering: true });
  });
});

// ── 1.6.3 refs 大值外溢取回（debt #2 消费端） ──

describe('GuiSidecarClient.getRefText', () => {
  it('200 → 返回原文（GET base + /refs/<id>，根路径非 /api/admin）', async () => {
    let seenUrl = '';
    const fetchImpl: GuiFetch = async (url) => {
      seenUrl = url;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/json' },
        json: async () => ({}),
        text: async () => '{"toolUseId":"t1","content":"FULL"}',
        body: null,
      };
    };
    const client = new GuiSidecarClient({ base: 'http://127.0.0.1:3199', fetchImpl });
    const body = await client.getRefText('ab12cd34');
    expect(seenUrl).toBe('http://127.0.0.1:3199/refs/ab12cd34');
    expect(body).toBe('{"toolUseId":"t1","content":"FULL"}');
  });

  it('404（GC/TTL 过期）→ 抛 GuiHttpError(404)，消费端据此走 expired 降级', async () => {
    const fetchImpl: GuiFetch = async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: { get: () => 'application/json' },
      json: async () => ({ error: 'ref not found or expired' }),
      text: async () => '{"error":"ref not found or expired"}',
      body: null,
    });
    const client = new GuiSidecarClient({ base: 'http://127.0.0.1:3199', fetchImpl });
    const err = await client.getRefText('dead0000').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GuiHttpError);
    expect((err as GuiHttpError).status).toBe(404);
  });
});
