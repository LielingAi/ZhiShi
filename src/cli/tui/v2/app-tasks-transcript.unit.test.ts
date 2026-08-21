/**
 * 1.1.10(A′)/tasks 详情页 transcript 只读查看回归测试。
 *
 *   - 任务带 loopSessionId:Enter 开详情 → 「读取中…」→ 200 到达后渲染
 *     条目流(user ❯ / assistant ⏺ / 工具调用 ⚙ / 结果 ⎿,isError 标红),
 *     truncated=true 顶部给「已截断（共 N 条）」。
 *   - 404 / 拉取失败 / 无 loopSessionId(旧任务) → 回退 summary 视图;
 *     无 sessionId 时根本不发请求。
 *   - 同一 sessionId 重复开详情不重复拉(Map 缓存,面板关闭即清)。
 *   - 条目超出面板高度时 ↑/↓ 滚动(offset 归 overlay 状态,经 reducer 改)。
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

interface FakeTranscript {
  /** 非 null → 200 返回该 transcript;null → 404 JSON 信封。 */
  body: unknown;
  /** 响应前的人为延迟(ms)——用来钉「读取中…」中间态。 */
  delayMs?: number;
}

function fakeClient(transcript: FakeTranscript, counters: { loopFetch: number }): SidecarClient {
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
    if (url.includes('/api/loop-session/messages')) {
      counters.loopFetch++;
      if (transcript.delayMs) await new Promise((r) => setTimeout(r, transcript.delayMs));
      const body: Record<string, unknown> = transcript.body === null
        ? { success: false, error: 'not found' }
        : { success: true, transcript: transcript.body };
      return {
        ok: transcript.body !== null, status: transcript.body === null ? 404 : 200, statusText: 'OK',
        headers: { get: () => 'application/json' },
        json: async () => body,
        text: async () => JSON.stringify(body),
        body: null,
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
  overlay: { kind: string; sel?: number; detail?: boolean; offset?: number } | null;
  state: SessionState;
  ingest(ev: { event?: string; data?: string }): void;
};

type WriterInternals = { inputLines: { text: string }[][] };

type Ctx = {
  app: App;
  input: EventEmitter;
  writer: TerminalWriter;
  internals: AppInternals;
  counters: { loopFetch: number };
};

function makeApp(transcript: FakeTranscript): Ctx {
  const counters = { loopFetch: 0 };
  const writer = new TerminalWriter({
    out: { write: () => true },
    cols: 80, rows: 24, depth: 'none',
  });
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  const app = new App({
    client: fakeClient(transcript, counters),
    writer,
    input,
    workspace: 'E:/code/u-disk',
    presetEnv: { kind: 'env', id: 'vm1', envKind: 'vm', warnings: [] },
    history: new HistoryStore('agent', mkdtempSync(join(tmpdir(), 'tui-transcript-'))),
  });
  return { app, input: input as unknown as EventEmitter, writer, internals: app as unknown as AppInternals, counters };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function startChat(transcript: FakeTranscript): Promise<Ctx> {
  const ctx = makeApp(transcript);
  ctx.writer.enter();
  await ctx.app.start();
  await sleep(50);
  return ctx;
}

function teardown(ctx: Ctx): void {
  ctx.app.dispose();
  ctx.writer.exit();
}

/** 钉住的输入区文本(overlay 面板 + 输入框),按行拼接。 */
function panelText(ctx: Ctx): string {
  const rows = (ctx.writer as unknown as WriterInternals).inputLines;
  return rows.map((r) => r.map((s) => s.text).join('')).join('\n');
}

async function key(ctx: Ctx, bytes: string, settle = 20): Promise<void> {
  ctx.input.emit('data', Buffer.from(bytes, 'utf8'));
  await sleep(settle);
}

/** 敲 /tasks + Enter 打开面板(经 completion 直提交,与真人路径一致)。 */
async function openTasks(ctx: Ctx): Promise<void> {
  await key(ctx, '/tasks');
  await key(ctx, '\r', 40);
}

function finishTask(ctx: Ctx, extra?: Record<string, unknown>): void {
  ctx.internals.ingest({ event: 'chat:subagent-started', data: JSON.stringify({ taskId: 't1', description: '审计子任务' }) });
  ctx.internals.ingest({
    event: 'chat:subagent-finished',
    data: JSON.stringify({ taskId: 't1', description: '审计子任务', summary: '找到 2 处问题', status: 'completed', ...extra }),
  });
}

const SAMPLE_TRANSCRIPT = {
  entries: [
    { role: 'user', text: 'USER-MARK 审一下这段代码' },
    { role: 'assistant', text: 'ASSISTANT-MARK 我先看文件', toolCalls: [{ name: 'read_file', argsSummary: '{"path":"a.ts"}' }] },
    { role: 'tool', toolName: 'read_file', isError: false, text: 'RESULT-OK-MARK 文件内容' },
    { role: 'tool', toolName: 'bash', isError: true, text: 'RESULT-ERR-MARK 编译失败' },
    { role: 'assistant', text: 'CONCLUSION-MARK 找到 2 处问题' },
  ],
  truncated: true,
  totalMessages: 42,
  meta: null,
};

describe('A′(1.1.10)/tasks 详情 transcript 只读查看', () => {
  it('subagent-finished 的 loopSessionId 折进 tasks 记录', async () => {
    const ctx = await startChat({ body: SAMPLE_TRANSCRIPT });
    finishTask(ctx, { loopSessionId: 'ls-1' });
    expect(ctx.internals.state.tasks.get('t1')?.loopSessionId).toBe('ls-1');
    teardown(ctx);
  });

  it('200:先「读取中…」,到达后渲染条目流 + 截断提示行', async () => {
    const ctx = await startChat({ body: SAMPLE_TRANSCRIPT, delayMs: 40 });
    finishTask(ctx, { loopSessionId: 'ls-1' });

    await openTasks(ctx);
    await key(ctx, '\r', 5); // Enter → 详情(fetch 还在飞)
    expect(ctx.internals.overlay?.detail).toBe(true);
    expect(ctx.counters.loopFetch).toBe(1);
    expect(panelText(ctx)).toContain('读取中…');

    await sleep(80); // fetch 到达 → 重绘
    const text = panelText(ctx);
    expect(text).not.toContain('读取中…');
    expect(text).toContain('已截断（共 42 条）');
    expect(text).toContain('❯ USER-MARK 审一下这段代码');
    expect(text).toContain('ASSISTANT-MARK 我先看文件');
    expect(text).toContain('⚙ read_file');
    expect(text).toContain('{"path":"a.ts"}');
    expect(text).toContain('✔ RESULT-OK-MARK 文件内容');
    expect(text).toContain('✗ RESULT-ERR-MARK 编译失败');
    expect(text).toContain('CONCLUSION-MARK 找到 2 处问题');
    teardown(ctx);
  });

  it('404:回退 summary 视图(描述/状态/结论)', async () => {
    const ctx = await startChat({ body: null });
    finishTask(ctx, { loopSessionId: 'ls-gone' });

    await openTasks(ctx);
    await key(ctx, '\r', 60);
    expect(ctx.counters.loopFetch).toBe(1);
    const text = panelText(ctx);
    expect(text).toContain('描述：审计子任务');
    expect(text).toContain('状态：已完成');
    expect(text).toContain('结论：找到 2 处问题');
    teardown(ctx);
  });

  it('无 loopSessionId(旧任务):直接 summary 视图,不发请求', async () => {
    const ctx = await startChat({ body: SAMPLE_TRANSCRIPT });
    finishTask(ctx); // 不带 loopSessionId
    expect(ctx.internals.state.tasks.get('t1')?.loopSessionId).toBeUndefined();

    await openTasks(ctx);
    await key(ctx, '\r', 40);
    expect(ctx.internals.overlay?.detail).toBe(true);
    expect(ctx.counters.loopFetch).toBe(0);
    expect(panelText(ctx)).toContain('描述：审计子任务');
    teardown(ctx);
  });

  it('同一 sessionId 重复开详情不重复拉(Map 缓存)', async () => {
    const ctx = await startChat({ body: SAMPLE_TRANSCRIPT });
    finishTask(ctx, { loopSessionId: 'ls-1' });

    await openTasks(ctx);
    await key(ctx, '\r', 60); // 开详情 → 拉一次
    expect(ctx.counters.loopFetch).toBe(1);
    expect(panelText(ctx)).toContain('CONCLUSION-MARK');

    await key(ctx, '\r'); // 回列表
    await key(ctx, '\r', 40); // 再开详情 → 命中缓存
    expect(ctx.counters.loopFetch).toBe(1);
    expect(panelText(ctx)).toContain('CONCLUSION-MARK');
    teardown(ctx);
  });

  it('条目超出面板高度时 ↓ 滚动(offset 前进,窗口跟随)', async () => {
    const long = {
      entries: Array.from({ length: 30 }, (_, i) => ({ role: 'assistant', text: `MARK-${String(i).padStart(2, '0')}` })),
      truncated: false,
      totalMessages: 30,
      meta: null,
    };
    const ctx = await startChat({ body: long });
    finishTask(ctx, { loopSessionId: 'ls-1' });

    await openTasks(ctx);
    await key(ctx, '\r', 60);
    expect(ctx.internals.overlay?.offset).toBe(0);
    const top = panelText(ctx);
    expect(top).toContain('MARK-00');
    expect(top).not.toContain('MARK-15');

    for (let i = 0; i < 15; i++) await key(ctx, '\x1b[B', 5); // ↓ ×15
    expect(ctx.internals.overlay?.offset).toBe(15);
    const scrolled = panelText(ctx);
    expect(scrolled).toContain('MARK-15');
    expect(scrolled).not.toContain('MARK-00');

    for (let i = 0; i < 15; i++) await key(ctx, '\x1b[A', 5); // ↑ 回顶
    expect(ctx.internals.overlay?.offset).toBe(0);
    expect(panelText(ctx)).toContain('MARK-00');
    teardown(ctx);
  });
});
