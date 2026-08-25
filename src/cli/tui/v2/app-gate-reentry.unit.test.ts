/**
 * 启动正门(gate)回归测试:正门五组选项的选定与退出语义。
 *
 * 1.3.5:/env 重进正门已移除(原「/env 重进」对应用例随砍项删除),本文件
 * 只保留仍有效的启动路径:Enter 选定第一项 → commit 进 chat;Esc → 退出到
 * shell(quitRequested)。正门是 TUI 的启动入口,退出语义是红线,保留回归钉。
 *
 * 无 TTY、无 sidecar:fake fetch + EventEmitter 注入按键字节。
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { App } from './app';
import { TerminalWriter } from './terminal-writer';
import { SidecarClient, type FetchLike, type FetchResponseLike } from '../client';

function fakeClient(selectCount: { n: number }): SidecarClient {
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
    let body: Record<string, unknown> = { success: true, data: {} };
    if (url.includes('environment/list')) {
      body = { success: true, data: { environments: [{ id: 'vm1', kind: 'vm' }] } };
    } else if (url.includes('environment/select')) {
      selectCount.n += 1;
    }
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

type AppInternals = { gateCursor: number; mode: string; quitRequested: boolean };

function makeApp(selectCount: { n: number }): { app: App; input: EventEmitter; writer: TerminalWriter } {
  const writer = new TerminalWriter({
    out: { write: () => true },
    cols: 80, rows: 24, depth: 'none',
  });
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  const app = new App({
    client: fakeClient(selectCount),
    writer,
    input,
    workspace: 'E:/code/u-disk',
  });
  return { app, input: input as unknown as EventEmitter, writer };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('启动正门（gate）选定与退出', () => {
  it('启动正门:↑↓ 可移动、Enter 选定第一项 → commit 进 chat', async () => {
    const selectCount = { n: 0 };
    const { app, input, writer } = makeApp(selectCount);
    writer.enter();
    await app.start();
    await sleep(100);

    const internals = app as unknown as AppInternals;
    expect(internals.mode).toBe('gate');
    expect(internals.gateCursor).toBe(0);

    input.emit('data', Buffer.from('\x1b[B', 'utf8')); // ↓ → manual:ssh
    await sleep(50);
    expect(internals.gateCursor).toBe(1);
    input.emit('data', Buffer.from('\x1b[A', 'utf8')); // ↑ 回到 vm1
    await sleep(50);
    expect(internals.gateCursor).toBe(0);

    // Enter 选定 vm1（stopped → select + 尽力 up，均成功）→ 进 chat。
    input.emit('data', Buffer.from('\r', 'utf8'));
    await sleep(200);
    expect(selectCount.n).toBe(1);
    expect(internals.mode).toBe('chat');

    app.dispose();
    writer.exit();
  });

  it('启动正门:Esc → quitRequested（退出到 shell）', async () => {
    const { app, input, writer } = makeApp({ n: 0 });
    writer.enter();
    await app.start();
    await sleep(100);
    expect((app as unknown as AppInternals).mode).toBe('gate');

    input.emit('data', Buffer.from('\x1b', 'utf8'));
    await sleep(100); // Esc 有 30ms CSI 消歧延迟
    expect(app.quitRequested).toBe(true);

    app.dispose();
    writer.exit();
  });
});
