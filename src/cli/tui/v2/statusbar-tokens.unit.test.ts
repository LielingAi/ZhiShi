/**
 * U8(1.1.10)状态栏累计 token 段回归测试。
 *
 *   - event-reducer:message-complete(pi 形状 {input_tokens,...} 与 SDK 历史
 *     形状 {usage} 都吃)把 usage 累加进 state.status.tokens;replay 路径
 *     同款累加,srvId 去重挡 SSE 重连的重复计。
 *   - chrome:composeStatusBar 渲染 `⇅ <in>k/<out>k`(formatK 缩写);窄终端
 *     room 丢弃顺序里 token 段排最低——ctx 还在时它先被丢。
 *   - app 接线:ingest 后状态栏行真的带上 token 段。
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduceSseEvent } from './event-reducer';
import { composeStatusBar, formatK, type StatusBarState } from './chrome';
import { App } from './app';
import { TerminalWriter } from './terminal-writer';
import { HistoryStore } from './history';
import { SidecarClient, type FetchLike, type FetchResponseLike } from '../client';
import type { SessionState } from './types';

function freshState(): SessionState {
  return {
    blocks: [],
    streamingId: null,
    queue: [],
    tasks: new Map(),
    bgProcs: new Map(),
    status: { phase: 'idle', queueDepth: 0, contextPct: 0 },
    currentTurnId: null,
    pendingDividerId: null,
    seenSrvIds: new Set(),
    seq: 0,
  };
}

/** 一轮完整的 assistant 消息(chunk 建流 + complete 落定),payload 形状可选。 */
function runTurn(state: SessionState, completePayload: unknown): void {
  reduceSseEvent(state, { event: 'chat:message-chunk', payload: { delta: '答' } });
  reduceSseEvent(state, { event: 'chat:message-complete', payload: completePayload });
}

describe('U8(1.1.10)token 累计(event-reducer)', () => {
  it('message-complete 两种 payload 形状都累加进 status.tokens', () => {
    const state = freshState();
    expect(state.status.tokens).toBeUndefined(); // 没有 usage 不出段

    runTurn(state, { input_tokens: 10000, output_tokens: 1000 }); // pi 形状
    expect(state.status.tokens).toEqual({ input: 10000, output: 1000 });

    runTurn(state, { usage: { input: 2300, output: 200 } }); // SDK 历史形状
    expect(state.status.tokens).toEqual({ input: 12300, output: 1200 });
  });

  it('replay 累加且 srvId 去重(重连重放不重复计)', () => {
    const state = freshState();
    const replay = {
      event: 'chat:message-replay',
      payload: { message: { id: 'm1', role: 'assistant', content: 'hi', usage: { input: 2000, output: 500 } } },
    };
    reduceSseEvent(state, replay);
    expect(state.status.tokens).toEqual({ input: 2000, output: 500 });
    reduceSseEvent(state, replay); // 同一 srvId 重放 → 不再计
    expect(state.status.tokens).toEqual({ input: 2000, output: 500 });
  });
});

describe('U8(1.1.10)token 段(chrome)', () => {
  it('formatK:千位缩写,不足千原样', () => {
    expect(formatK(12300)).toBe('12.3k');
    expect(formatK(1200)).toBe('1.2k');
    expect(formatK(850)).toBe('850');
  });

  const base: StatusBarState = {
    phase: 'idle',
    queueDepth: 0,
    contextPct: 50,
    model: 'claude',
    envName: 'vm1',
    envKind: 'vm',
    hint: 'x',
    tokens: { input: 12300, output: 1200 },
  };
  const text = (cols: number): string =>
    composeStatusBar(base, cols, 0).map((s) => s.text).join('');

  it('宽终端渲染 ⇅ 12.3k/1.2k', () => {
    expect(text(120)).toContain('⇅ 12.3k/1.2k');
  });

  it('窄终端丢弃顺序排最低:ctx 仍在,token 段先丢', () => {
    const narrow = text(40);
    expect(narrow).toContain('ctx 50%');
    expect(narrow).not.toContain('⇅');
  });

  it('tokens 全 0 不出段', () => {
    const zero = composeStatusBar({ ...base, tokens: { input: 0, output: 0 } }, 120, 0)
      .map((s) => s.text).join('');
    expect(zero).not.toContain('⇅');
  });
});

// --- app 接线:ingest 后状态栏行带上 token 段 ---

function fakeClient(): SidecarClient {
  const fetchImpl: FetchLike = (async (url: string) => {
    if (url.includes('/chat/stream')) {
      return {
        ok: true, status: 200, statusText: 'OK',
        headers: { get: () => 'text/event-stream' },
        json: async () => ({}), text: async () => '',
        body: {
          getReader: () => ({
            read: async () => new Promise(() => {}),
            cancel: async () => {},
          }),
        },
      } as FetchResponseLike;
    }
    const body: Record<string, unknown> = { success: true, data: { environments: [] } };
    return {
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
      body: null,
    } as FetchResponseLike;
  }) as FetchLike;
  return new SidecarClient({ base: 'http://test', fetchImpl });
}

describe('U8(1.1.10)token 段(app 接线)', () => {
  it('message-complete 后状态栏行出现累计 token 段', async () => {
    const writer = new TerminalWriter({ out: { write: () => true }, cols: 120, rows: 24, depth: 'none' });
    const input = new EventEmitter() as unknown as NodeJS.ReadStream;
    const app = new App({
      client: fakeClient(),
      writer,
      input,
      workspace: 'E:/code/u-disk',
      presetEnv: { kind: 'env', id: 'vm1', envKind: 'vm', warnings: [] },
      history: new HistoryStore('agent', mkdtempSync(join(tmpdir(), 'tui-tokens-'))),
    });
    const internals = app as unknown as { state: SessionState; ingest(ev: { event?: string; data?: string }): void };
    writer.enter();
    await app.start();
    await new Promise((r) => setTimeout(r, 50));

    internals.ingest({ event: 'chat:message-chunk', data: JSON.stringify({ delta: '答' }) });
    internals.ingest({ event: 'chat:message-complete', data: JSON.stringify({ input_tokens: 12300, output_tokens: 1200 }) });
    await new Promise((r) => setTimeout(r, 20));

    expect(internals.state.status.tokens).toEqual({ input: 12300, output: 1200 });
    const statusText = (writer as unknown as { statusLines: { text: string }[][] }).statusLines
      .map((r) => r.map((s) => s.text).join('')).join('\n');
    expect(statusText).toContain('⇅ 12.3k/1.2k');

    app.dispose();
    writer.exit();
  });
});
