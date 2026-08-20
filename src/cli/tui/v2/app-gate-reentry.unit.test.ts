/**
 * /env 重进正门回归测试（1.1.6 #2）。
 *
 * 修复前：gateBusy 在 commit 成功路径不复位、enterGate() 也不重置——
 * 启动正门选定成功后 /env 二次进门，onGateKey 开头被 gateBusy 吞掉，
 * 上下/Enter/Esc 全部无效（只能 Ctrl+C 杀进程）。
 * 附带：重进时 Esc 误退整个程序（startup 语义），应为取消并返回 chat。
 *
 * 无 TTY、无 sidecar：fake fetch + EventEmitter 注入按键字节。
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

describe('/env 重进正门（1.1.6 #2 回归）', () => {
  it('启动选定成功后 /env 重进：上下可移动、Enter 可再次选定', async () => {
    const selectCount = { n: 0 };
    const { app, input, writer } = makeApp(selectCount);
    writer.enter();
    await app.start();
    await sleep(100);

    // 启动正门：Enter 选定 vm1（stopped → select + 尽力 up，均成功）→ 进 chat。
    input.emit('data', Buffer.from('\r', 'utf8'));
    await sleep(200);
    expect(selectCount.n).toBe(1);
    expect((app as unknown as AppInternals).mode).toBe('chat');

    // /env 重进正门。
    input.emit('data', Buffer.from('/env\r', 'utf8'));
    await sleep(200);
    const internals = app as unknown as AppInternals;
    expect(internals.mode).toBe('gate');
    expect(internals.gateCursor).toBe(0);

    // 修复前这里所有键被 gateBusy 吞掉：down 必须真的移动光标。
    input.emit('data', Buffer.from('[B', 'utf8')); // ↓ → manual:ssh
    await sleep(50);
    expect(internals.gateCursor).toBe(1);
    input.emit('data', Buffer.from('[A', 'utf8')); // ↑ 回到 vm1
    await sleep(50);
    expect(internals.gateCursor).toBe(0);

    // Enter 必须再次走完 commit。
    input.emit('data', Buffer.from('\r', 'utf8'));
    await sleep(200);
    expect(selectCount.n).toBe(2);
    expect(internals.mode).toBe('chat');

    app.dispose();
    writer.exit();
  });

  it('/env 重进按 Esc：取消返回 chat，不退出程序；启动首次按 Esc 才退出', async () => {
    // 启动首次：Esc → quitRequested。
    const first = makeApp({ n: 0 });
    first.writer.enter();
    await first.app.start();
    await sleep(100);
    first.input.emit('data', Buffer.from('', 'utf8'));
    await sleep(100); // Esc 有 30ms CSI 消歧延迟
    expect(first.app.quitRequested).toBe(true);
    first.app.dispose();
    first.writer.exit();

    // 重进：Esc → 返回 chat，quitRequested 保持 false。
    const selectCount = { n: 0 };
    const { app, input, writer } = makeApp(selectCount);
    writer.enter();
    await app.start();
    await sleep(100);
    input.emit('data', Buffer.from('\r', 'utf8')); // 选定进 chat
    await sleep(200);
    input.emit('data', Buffer.from('/env\r', 'utf8')); // 重进正门
    await sleep(200);
    expect((app as unknown as AppInternals).mode).toBe('gate');

    input.emit('data', Buffer.from('', 'utf8'));
    await sleep(100);
    expect(app.quitRequested).toBe(false);
    expect((app as unknown as AppInternals).mode).toBe('chat');

    app.dispose();
    writer.exit();
  });
});
