/**
 * /attach glue test — proves the hand-off ordering without a real TTY or ssh:
 * suspend(TUI 挂起) → spawn(正确的 ssh 目标) → resume(回屏重绘)。spawn 注入,
 * 绝不真起进程。
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { App } from './app';
import { TerminalWriter } from './terminal-writer';
import { SidecarClient, type FetchLike, type FetchResponseLike } from '../client';
import type { AttachTarget } from './attach';

const VM_ENTRY = {
  id: 'pwn-vm',
  kind: 'vm',
  address: '192.168.152.129',
  user: 'researcher',
  keyPath: 'C:\\Users\\Administrator\\.ssh\\id_ed25519',
};

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
    const body = url.includes('environment/list')
      ? { success: true, data: { environments: [VM_ENTRY] } }
      : { success: true, data: {} };
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

describe('/attach 挂起-接管-恢复', () => {
  it('顺序: suspend → spawn(ssh 目标带 key) → resume;恢复后输入照常上屏', async () => {
    const order: string[] = [];
    let spawned: AttachTarget | null = null;
    // 捕获真实屏字节,验证恢复后输入能被渲染出来(用户实测症状的回归钉)。
    const written: string[] = [];
    const writer = new TerminalWriter({
      out: { write: (t: string) => { written.push(t); return true; } },
      cols: 80, rows: 24, depth: 'none',
    });
    const input = new EventEmitter() as unknown as NodeJS.ReadStream;
    const app = new App({
      client: fakeClient(),
      writer,
      input,
      workspace: 'E:/code/u-disk',
      presetEnv: { kind: 'env', id: 'pwn-vm', envKind: 'vm', warnings: [] },
      suspend: () => { order.push('suspend'); writer.exit(); },
      resume: () => { order.push('resume'); writer.enter(); },
      spawnAttachImpl: async (t) => { order.push('spawn'); spawned = t; return 0; },
    });
    writer.enter();
    await app.start();
    await new Promise((r) => setTimeout(r, 100));

    (input as unknown as EventEmitter).emit('data', Buffer.from('/attach', 'utf8'));
    (input as unknown as EventEmitter).emit('data', Buffer.from('\r', 'utf8'));
    await new Promise((r) => setTimeout(r, 300));

    expect(order).toEqual(['suspend', 'spawn', 'resume']);
    expect(spawned).not.toBeNull();
    const cmd = (spawned as unknown as AttachTarget).command.join(' ');
    expect(cmd).toContain('researcher@192.168.152.129');
    expect(cmd).toContain('id_ed25519');

    // 恢复后键入:文字必须被画进输入区(此前调度器被 exit 误杀,画了等于没画)。
    (input as unknown as EventEmitter).emit('data', Buffer.from('ok', 'utf8'));
    await new Promise((r) => setTimeout(r, 100));
    writer.flush();
    expect(written.join('')).toContain('ok');

    (app as unknown as { dispose(): void }).dispose();
    writer.exit();
  });

  it('缺连接信息的环境 → 错误行,不挂起', async () => {
    const order: string[] = [];
    const writer = new TerminalWriter({
      out: { write: () => true },
      cols: 80, rows: 24, depth: 'none',
    });
    const input = new EventEmitter() as unknown as NodeJS.ReadStream;
    const client = fakeClient();
    const app = new App({
      client,
      writer,
      input,
      workspace: 'E:/code/u-disk',
      presetEnv: { kind: 'env', id: 'unknown-env', envKind: 'vm', warnings: [] },
      suspend: () => { order.push('suspend'); },
      resume: () => { order.push('resume'); },
      spawnAttachImpl: async () => { order.push('spawn'); return 0; },
    });
    writer.enter();
    await app.start();
    await new Promise((r) => setTimeout(r, 100));

    (input as unknown as EventEmitter).emit('data', Buffer.from('/attach\r', 'utf8'));
    await new Promise((r) => setTimeout(r, 300));

    expect(order).toEqual([]); // 没走到挂起
    (app as unknown as { dispose(): void }).dispose();
    writer.exit();
  });
});
