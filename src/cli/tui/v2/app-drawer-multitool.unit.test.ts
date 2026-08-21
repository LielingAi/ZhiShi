/**
 * U5(1.1.10)drawer 多工具卡切换回归测试。
 *
 *   - Ctrl+O 仍开最新一张 tool 卡(行为不变);drawer 打开态下 ←/→ 在最近
 *     N 张 tool 卡间循环切换目标(← 旧 → 新,两端回绕),offset 归零。
 *   - 只有一张 tool 卡时 ←/→ 原地不动(行为不变)。
 *   - currentHint:多卡时 drawer 态补「←→ 切换工具卡」,单卡保持原样。
 *
 * 无 TTY、无 sidecar:fake fetch + EventEmitter 注入按键字节
 * (模式同 app-tasks-overlay.unit.test.ts)。
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from './app';
import { TerminalWriter } from './terminal-writer';
import { HistoryStore } from './history';
import { SidecarClient, type FetchLike, type FetchResponseLike } from '../client';
import type { SessionState } from './types';

function fakeClient(): SidecarClient {
  const fetchImpl: FetchLike = (async (url: string) => {
    if (url.includes('/chat/stream')) {
      return {
        ok: true, status: 200, statusText: 'OK',
        headers: { get: () => 'text/event-stream' },
        json: async () => ({}), text: async () => '',
        body: {
          getReader: () => ({
            read: async () => new Promise(() => {}), // hang — stream stays open
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

type AppInternals = {
  overlay: { kind: string; blockId?: string; offset?: number } | null;
  state: SessionState;
  ingest(ev: { event?: string; data?: string }): void;
  currentHint(): string;
};

type Ctx = { app: App; input: EventEmitter; writer: TerminalWriter; internals: AppInternals };

function makeApp(): Ctx {
  const writer = new TerminalWriter({
    out: { write: () => true },
    cols: 80, rows: 24, depth: 'none',
  });
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  const app = new App({
    client: fakeClient(),
    writer,
    input,
    workspace: 'E:/code/u-disk',
    presetEnv: { kind: 'env', id: 'vm1', envKind: 'vm', warnings: [] },
    history: new HistoryStore('agent', mkdtempSync(join(tmpdir(), 'tui-drawer-'))),
  });
  return { app, input: input as unknown as EventEmitter, writer, internals: app as unknown as AppInternals };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function startChat(): Promise<Ctx> {
  const ctx = makeApp();
  ctx.writer.enter();
  await ctx.app.start();
  await sleep(50);
  return ctx;
}

function teardown(ctx: Ctx): void {
  ctx.app.dispose();
  ctx.writer.exit();
}

async function key(ctx: Ctx, bytes: string, settle = 20): Promise<void> {
  ctx.input.emit('data', Buffer.from(bytes, 'utf8'));
  await sleep(settle);
}

/** 造一张已完成的 tool 卡(output 行数可调,测滚动归零用)。 */
function addTool(ctx: Ctx, id: string, outputLines = 1): void {
  ctx.internals.ingest({ event: 'chat:tool-use-start', data: JSON.stringify({ id, name: 'bash', input: { command: `run-${id}` } }) });
  ctx.internals.ingest({
    event: 'chat:tool-result-complete',
    data: JSON.stringify({ toolUseId: id, content: Array.from({ length: outputLines }, (_, i) => `${id}-out-${i}`).join('\n') }),
  });
}

describe('U5(1.1.10)drawer 多工具卡切换', () => {
  it('Ctrl+O 开最新卡;←/→ 在最近 N 张卡间循环,切换后 offset 归零', async () => {
    const ctx = await startChat();
    addTool(ctx, 'tool-1', 20);
    addTool(ctx, 'tool-2');
    addTool(ctx, 'tool-3');

    await key(ctx, '\x0f'); // Ctrl+O → 最新一张
    expect(ctx.internals.overlay?.kind).toBe('drawer');
    expect(ctx.internals.overlay?.blockId).toBe('tool-3');

    await key(ctx, '\x1b[D'); // ← → 上一张(更旧)
    expect(ctx.internals.overlay?.blockId).toBe('tool-2');
    await key(ctx, '\x1b[D');
    expect(ctx.internals.overlay?.blockId).toBe('tool-1');

    // tool-1 有 20 行输出:先滚动,再切换 → offset 归零
    await key(ctx, '\x1b[B'); // ↓
    await key(ctx, '\x1b[B');
    expect(ctx.internals.overlay?.offset).toBe(2);
    await key(ctx, '\x1b[D'); // ← 回绕到最新一张
    expect(ctx.internals.overlay?.blockId).toBe('tool-3');
    expect(ctx.internals.overlay?.offset).toBe(0);

    await key(ctx, '\x1b[C'); // → 从最新回绕到最旧
    expect(ctx.internals.overlay?.blockId).toBe('tool-1');
    await key(ctx, '\x1b[C'); // → 往新走
    expect(ctx.internals.overlay?.blockId).toBe('tool-2');
    teardown(ctx);
  });

  it('单张 tool 卡:←/→ 原地不动(行为不变),Esc 收起照旧', async () => {
    const ctx = await startChat();
    addTool(ctx, 'tool-only');

    await key(ctx, '\x0f');
    expect(ctx.internals.overlay?.blockId).toBe('tool-only');
    await key(ctx, '\x1b[D');
    expect(ctx.internals.overlay?.kind).toBe('drawer');
    expect(ctx.internals.overlay?.blockId).toBe('tool-only');
    await key(ctx, '\x1b[C');
    expect(ctx.internals.overlay?.blockId).toBe('tool-only');

    ctx.input.emit('data', Buffer.from('\x1b', 'utf8')); // Esc 收起
    await sleep(60);
    expect(ctx.internals.overlay).toBeNull();
    teardown(ctx);
  });

  it('currentHint:多卡时补「←→ 切换工具卡」,单卡保持原样', async () => {
    const ctx = await startChat();
    addTool(ctx, 'tool-1');
    await key(ctx, '\x0f');
    expect(ctx.internals.currentHint()).toBe('↑↓ 滚动 · Esc 收起');

    addTool(ctx, 'tool-2'); // drawer 开着时再来一张卡
    await sleep(20);
    expect(ctx.internals.currentHint()).toBe('↑↓ 滚动 · ←→ 切换工具卡 · Esc 收起');
    teardown(ctx);
  });
});
