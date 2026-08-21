/**
 * U2 /tasks 面板回归测试(1.1.9)。
 *
 *   - /tasks 打开 overlay:列出 subagent 任务(描述/状态/结论摘要)与
 *     后台进程(tag/pid/命令预览);空态给一行友好提示。
 *   - ↑/↓ 移动选择;Enter 展开详情(结论 summary 全文);Enter/Esc 返回
 *     列表,Esc 再按关闭(Esc 逐层退出)。
 *   - overlay 打开期间 subagent-finished 等事件到达,列表跟着刷新
 *     (面板渲染直读 SessionState,ingest 后的 renderChrome 顺带重绘)。
 *
 * 无 TTY、无 sidecar:fake fetch + EventEmitter 注入按键字节
 * (模式同 app-ux-1-1-9.unit.test.ts)。
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
  overlay: { kind: string; sel?: number; detail?: boolean } | null;
  state: SessionState;
  ingest(ev: { event?: string; data?: string }): void;
};

type WriterInternals = { inputLines: { text: string }[][] };

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
    history: new HistoryStore('agent', mkdtempSync(join(tmpdir(), 'tui-tasks-'))),
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

/** 钉住的输入区文本(overlay 面板 + 输入框),按行拼接。 */
function panelText(ctx: ReturnType<typeof makeApp>): string {
  const rows = (ctx.writer as unknown as WriterInternals).inputLines;
  return rows.map((r) => r.map((s) => s.text).join('')).join('\n');
}

async function key(ctx: ReturnType<typeof makeApp>, bytes: string, settle = 20): Promise<void> {
  ctx.input.emit('data', Buffer.from(bytes, 'utf8'));
  await sleep(settle);
}

/** 敲 /tasks + Enter 打开面板(经 completion 直提交,与真人路径一致)。 */
async function openTasks(ctx: ReturnType<typeof makeApp>): Promise<void> {
  await key(ctx, '/tasks');
  await key(ctx, '\r', 40);
}

describe('U2 /tasks 面板(1.1.9)', () => {
  it('打开后列出 subagent 任务(状态+结论摘要)与后台进程(tag/pid/命令预览)', async () => {
    const ctx = await startChat();
    const { internals } = ctx;
    internals.ingest({ event: 'chat:subagent-started', data: JSON.stringify({ taskId: 't1', description: 'fuzz 首轮' }) });
    internals.ingest({ event: 'chat:subagent-finished', data: JSON.stringify({ taskId: 't1', description: 'fuzz 首轮', summary: '3 个独有崩溃', status: 'completed' }) });
    internals.ingest({ event: 'chat:bg-started', data: JSON.stringify({ tag: 'srv', pid: 4242, commandPreview: 'npm run fuzz' }) });

    await openTasks(ctx);
    expect(internals.overlay?.kind).toBe('tasks');
    const text = panelText(ctx);
    expect(text).toContain('✓ fuzz 首轮 — 3 个独有崩溃');
    expect(text).toContain('⚙ srv · pid 4242 · npm run fuzz');
    teardown(ctx);
  });

  it('空态:无任务无进程时给一行友好提示,Enter 不展开', async () => {
    const ctx = await startChat();
    const { internals } = ctx;
    await openTasks(ctx);
    expect(internals.overlay?.kind).toBe('tasks');
    expect(panelText(ctx)).toContain('暂无子任务或后台进程');

    await key(ctx, '\r');
    expect(internals.overlay?.kind).toBe('tasks');
    expect(internals.overlay?.detail).toBe(false);
    teardown(ctx);
  });

  it('↑/↓ 移动选择;Enter 展开详情(summary 全文);Esc 逐层返回再关闭', async () => {
    const ctx = await startChat();
    const { input, internals } = ctx;
    const longTail = 'TAIL-7f3a9c 结论末尾标记';
    internals.ingest({ event: 'chat:subagent-started', data: JSON.stringify({ taskId: 't1', description: '任务甲' }) });
    internals.ingest({ event: 'chat:subagent-started', data: JSON.stringify({ taskId: 't2', description: '任务乙' }) });
    internals.ingest({ event: 'chat:subagent-finished', data: JSON.stringify({ taskId: 't2', description: '任务乙', summary: `乙完成:${longTail}`, status: 'completed' }) });

    await openTasks(ctx);
    expect(internals.overlay?.sel).toBe(0);

    await key(ctx, '\x1b[B'); // ↓ → 第二行(任务乙)
    expect(internals.overlay?.sel).toBe(1);
    await key(ctx, '\x1b[A'); // ↑ → 回到第一行
    expect(internals.overlay?.sel).toBe(0);
    await key(ctx, '\x1b[B');

    await key(ctx, '\r'); // Enter → 详情
    expect(internals.overlay?.detail).toBe(true);
    const detail = panelText(ctx);
    expect(detail).toContain('描述：任务乙');
    expect(detail).toContain('状态：已完成');
    expect(detail).toContain(longTail); // summary 全文,未截断

    input.emit('data', Buffer.from('\x1b', 'utf8')); // Esc → 退回列表(不是直接关)
    await sleep(60);
    expect(internals.overlay?.kind).toBe('tasks');
    expect(internals.overlay?.detail).toBe(false);

    input.emit('data', Buffer.from('\x1b', 'utf8')); // 再 Esc → 关闭
    await sleep(60);
    expect(internals.overlay).toBeNull();
    teardown(ctx);
  });

  it('详情里再按 Enter 返回列表', async () => {
    const ctx = await startChat();
    const { internals } = ctx;
    internals.ingest({ event: 'chat:subagent-started', data: JSON.stringify({ taskId: 't1', description: '任务甲' }) });
    await openTasks(ctx);
    await key(ctx, '\r');
    expect(internals.overlay?.detail).toBe(true);
    await key(ctx, '\r');
    expect(internals.overlay?.kind).toBe('tasks');
    expect(internals.overlay?.detail).toBe(false);
    teardown(ctx);
  });

  it('面板打开期间 subagent-finished 到达:列表跟着刷新(running → done)', async () => {
    const ctx = await startChat();
    const { internals } = ctx;
    internals.ingest({ event: 'chat:subagent-started', data: JSON.stringify({ taskId: 't1', description: 'fuzz 首轮' }) });
    await openTasks(ctx);
    expect(panelText(ctx)).toContain('… fuzz 首轮 · 输出 0');

    internals.ingest({ event: 'chat:subagent-finished', data: JSON.stringify({ taskId: 't1', description: 'fuzz 首轮', summary: '3 个独有崩溃', status: 'completed' }) });
    await sleep(20);
    const text = panelText(ctx);
    expect(text).toContain('✓ fuzz 首轮 — 3 个独有崩溃');
    expect(text).not.toContain('… fuzz 首轮');
    teardown(ctx);
  });
});
