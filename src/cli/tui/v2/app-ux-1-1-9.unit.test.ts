/**
 * 1.1.9 小 UX 三件回归测试(U1/U3/U6/U7a)。
 *
 *   U1 死按钮:background 块不再渲染「要我切过去吗？(y)」尾钩(服务端无
 *     subagent 会话切换入口);按 y 在空/非空编辑器都正常输入字母。
 *   U6 回看键位:PgUp/PgDn 整页翻页(页高=输出区可视行数),Ctrl+Home
 *     (\x1b[1;5H)跳顶;Esc 回底、滚轮翻历史语义不变(1.1.6 验收)。
 *   U7a 粘贴补补全:bracketed paste 后与普通击键一样触发 live completion。
 *   (U3 Esc 草稿恢复槽已随 1.3.5 瘦身移除,对应用例同步删除。)
 *
 * 无 TTY、无 sidecar:fake fetch + EventEmitter 注入按键字节
 * (模式同 app-gate-reentry.unit.test.ts)。
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from './app';
import { TerminalWriter } from './terminal-writer';
import { HistoryStore } from './history';
import { resolveKey } from './keymap';
import { renderBackground } from './blocks/dividers';
import { SidecarClient, type FetchLike, type FetchResponseLike } from '../client';
import type { BackgroundBlock, SessionState } from './types';

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
  editor: { text: string; isEmpty: boolean };
  overlay: { kind: string } | null;
  state: SessionState;
  ingest(ev: { event?: string; data?: string }): void;
};

function makeApp(): { app: App; input: EventEmitter; writer: TerminalWriter; internals: AppInternals } {
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
    // 跳过正门直进 chat;历史指向一次性临时目录,不碰真实 ~/.zhishi。
    presetEnv: { kind: 'env', id: 'vm1', envKind: 'vm', warnings: [] },
    history: new HistoryStore('agent', mkdtempSync(join(tmpdir(), 'tui-119-'))),
  });
  return { app, input: input as unknown as EventEmitter, writer, internals: app as unknown as AppInternals };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function startChat(): Promise<ReturnType<typeof makeApp>> {
  const ctx = makeApp();
  ctx.writer.enter();
  await ctx.app.start();
  await sleep(50);
  return ctx;
}

function teardown(ctx: ReturnType<typeof makeApp>): void {
  ctx.app.dispose();
  ctx.writer.exit();
}

describe('U1 死按钮(1.1.9):尾钩文案移除,y 永远正常输入', () => {
  it('renderBackground 不再渲染「要我切过去吗？(y)」——switchHook 只是数据标记', () => {
    const block: BackgroundBlock = {
      id: 'bg-1', kind: 'background', seq: 1,
      taskId: 't1', summary: 'fuzz 首轮:3 个独有崩溃', switchHook: true,
    };
    const text = renderBackground(block).flat().map((s) => s.text).join('');
    expect(text).toContain('3 个独有崩溃');
    expect(text).not.toContain('切过去');
  });

  it('存在待切结论(switchHook 块)时按 y:字母照常进编辑器,无任何拦截', async () => {
    const ctx = await startChat();
    const { input, internals } = ctx;
    internals.ingest({ event: 'chat:subagent-started', data: JSON.stringify({ taskId: 't1', description: 'fuzz 首轮' }) });
    internals.ingest({ event: 'chat:subagent-finished', data: JSON.stringify({ taskId: 't1', description: 'fuzz 首轮', summary: '3 个独有崩溃', status: 'completed' }) });
    const bg = internals.state.blocks.find((b) => b.kind === 'background') as BackgroundBlock;
    expect(bg.switchHook).toBe(true); // 数据层标记仍在

    input.emit('data', Buffer.from('y', 'utf8'));
    await sleep(20);
    expect(internals.editor.text).toBe('y'); // 空编辑器:y 是正常输入

    input.emit('data', Buffer.from('y', 'utf8'));
    await sleep(20);
    expect(internals.editor.text).toBe('yy'); // 非空编辑器:同样放行
    teardown(ctx);
  });
});

describe('U6 回看键位接线(1.1.9)', () => {
  it('keymap:\\x1b[1;5H → home+ctrl(Ctrl+Home 的 CSI 形态)', () => {
    expect(resolveKey('\x1b[1;5H')).toEqual({ name: 'home', mods: ['ctrl'] });
  });

  it('PgUp/PgDn 整页翻页(±1 页,页高=输出区可视行数)', async () => {
    const ctx = await startChat();
    const { input, writer } = ctx;
    for (let i = 0; i < 120; i++) writer.append([{ text: `row-${i}` }]);
    const page = writer.layout().outputBottom;

    input.emit('data', Buffer.from('\x1b[5~', 'utf8')); // PgUp
    await sleep(20);
    expect(writer.viewportState().scrollOffset).toBe(page); // 恰好一整页,不是旧 ±10
    expect(writer.viewportState().following).toBe(false);

    input.emit('data', Buffer.from('\x1b[6~', 'utf8')); // PgDn
    await sleep(20);
    expect(writer.viewportState().scrollOffset).toBe(0);
    expect(writer.viewportState().following).toBe(true);
    teardown(ctx);
  });

  it('Ctrl+Home 跳到最早一行;Esc 回底语义不变(1.1.6 验收)', async () => {
    const ctx = await startChat();
    const { input, writer } = ctx;
    for (let i = 0; i < 120; i++) writer.append([{ text: `row-${i}` }]);
    const st = writer.viewportState();
    const maxOffset = Math.max(0, st.total - st.height);
    expect(maxOffset).toBeGreaterThan(0);

    input.emit('data', Buffer.from('\x1b[1;5H', 'utf8')); // Ctrl+Home
    await sleep(20);
    expect(writer.viewportState().scrollOffset).toBe(maxOffset);
    expect(writer.viewportState().following).toBe(false);

    input.emit('data', Buffer.from('\x1b', 'utf8')); // Esc → 回底
    await sleep(60);
    expect(writer.viewportState().scrollOffset).toBe(0);
    expect(writer.viewportState().following).toBe(true);
    teardown(ctx);
  });
});

describe('U7a 粘贴补补全(1.1.9)', () => {
  it('bracketed paste 粘贴 / 前缀后触发 live completion(与普通击键同待遇)', async () => {
    const ctx = await startChat();
    const { input, internals } = ctx;
    input.emit('data', Buffer.from('\x1b[200~/mo\x1b[201~', 'utf8'));
    await sleep(20);
    expect(internals.editor.text).toBe('/mo');
    expect(internals.overlay?.kind).toBe('completion');
    teardown(ctx);
  });

  it('粘贴普通文本不唤起补全面板', async () => {
    const ctx = await startChat();
    const { input, internals } = ctx;
    input.emit('data', Buffer.from('\x1b[200~hello world\x1b[201~', 'utf8'));
    await sleep(20);
    expect(internals.editor.text).toBe('hello world');
    expect(internals.overlay?.kind ?? null).not.toBe('completion');
    teardown(ctx);
  });
});
