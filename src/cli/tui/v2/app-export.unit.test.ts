/**
 * 1.2.0 /export 报告导出回归测试（design 1.2.0 TUI 侧）。
 *
 *   - 触发即插「正在组装报告…」进度行（divider tone info）；
 *   - 成功：完成行给报告目录 + 证据计数（+降级计数/+已脱敏），降级项各列
 *     一行（faint 提示行）；
 *   - 失败：error 块带服务端文案；
 *   - sanitize 词透传服务端（body.sanitize=true）。
 *
 * 无 TTY、无 sidecar：fake fetch + EventEmitter 注入按键字节
 * （模式同 app-tasks-overlay.unit.test.ts）。
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
import type { DividerBlock, SessionState } from './types';

type ExportResponder = (body: Record<string, unknown>) => Record<string, unknown>;

function fakeClient(respond: ExportResponder, onExportBody?: (body: Record<string, unknown>) => void): SidecarClient {
  const fetchImpl: FetchLike = (async (url: string, init?: { body?: string }) => {
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
    let body: Record<string, unknown> = { success: true, data: { environments: [] } };
    if (url.includes('/api/admin/report/export')) {
      const parsed = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      onExportBody?.(parsed);
      body = respond(parsed);
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

type AppInternals = {
  state: SessionState;
};

function makeApp(respond: ExportResponder, onExportBody?: (body: Record<string, unknown>) => void) {
  const writer = new TerminalWriter({
    out: { write: () => true },
    cols: 80, rows: 24, depth: 'none',
  });
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  const app = new App({
    client: fakeClient(respond, onExportBody),
    writer,
    input,
    workspace: 'E:/code/u-disk',
    // 跳过正门直进 chat；历史指向一次性临时目录，不碰真实 ~/.zhishi。
    presetEnv: { kind: 'env', id: 'vm1', envKind: 'vm', warnings: [] },
    history: new HistoryStore('agent', mkdtempSync(join(tmpdir(), 'tui-export-'))),
  });
  return { app, input: input as unknown as EventEmitter, writer, internals: app as unknown as AppInternals };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function startChat(respond: ExportResponder, onExportBody?: (body: Record<string, unknown>) => void) {
  const ctx = makeApp(respond, onExportBody);
  ctx.writer.enter();
  await ctx.app.start();
  await sleep(50);
  return ctx;
}

function teardown(ctx: ReturnType<typeof makeApp>): void {
  ctx.app.dispose();
  ctx.writer.exit();
}

async function key(ctx: ReturnType<typeof makeApp>, bytes: string, settle = 20): Promise<void> {
  ctx.input.emit('data', Buffer.from(bytes, 'utf8'));
  await sleep(settle);
}

/** 敲 /export… + Enter 提交（与真人路径一致：带 usage 的命令首个 Enter
 * 接受补全（文本变 '/export '），第二个 Enter 才提交；已带参数时首个
 * Enter 直接提交，第二个 Enter 空文本空转。） */
async function runExport(ctx: ReturnType<typeof makeApp>, text = '/export'): Promise<void> {
  await key(ctx, text);
  await key(ctx, '\r', 40);
  await key(ctx, '\r', 60);
}

function dividerLabels(ctx: ReturnType<typeof makeApp>): string[] {
  return ctx.internals.state.blocks.filter((b): b is DividerBlock => b.kind === 'divider').map((b) => b.label);
}

function errorTexts(ctx: ReturnType<typeof makeApp>): string[] {
  return ctx.internals.state.blocks.filter((b) => b.kind === 'error').map((b) => (b as { text: string }).text);
}

describe('/export 报告导出（1.2.0）', () => {
  it('成功：进度行 → 完成行（目录 + 证据计数），无降级时不列降级项', async () => {
    const ctx = await startChat(() => ({
      success: true,
      data: { reportDir: 'output/reports/20260821-1031-vm1', evidenceCount: 3, degraded: [], sanitized: false },
    }));
    await runExport(ctx);
    const labels = dividerLabels(ctx);
    expect(labels).toContain('正在组装报告…');
    expect(labels).toContain('报告已导出：output/reports/20260821-1031-vm1（证据 3 个）');
    expect(labels.some((l) => l.startsWith('降级：'))).toBe(false);
    expect(errorTexts(ctx)).toHaveLength(0);
    teardown(ctx);
  });

  it('降级：完成行带降级计数，降级项各列一行', async () => {
    const ctx = await startChat(() => ({
      success: true,
      data: {
        reportDir: 'output/reports/20260821-1031-vm1',
        evidenceCount: 1,
        degraded: ['docker 环境回收未支持', '叙述润色不可用（模型不可用）'],
        sanitized: false,
      },
    }));
    await runExport(ctx);
    const labels = dividerLabels(ctx);
    expect(labels).toContain('报告已导出：output/reports/20260821-1031-vm1（证据 1 个，降级 2 项）');
    expect(labels).toContain('降级：docker 环境回收未支持');
    expect(labels).toContain('降级：叙述润色不可用（模型不可用）');
    teardown(ctx);
  });

  it('失败：error 块带服务端文案', async () => {
    const ctx = await startChat(() => ({
      success: false,
      error: '没有可导出的研究记录（当前工作区无研究事件或无会话历史）',
    }));
    await runExport(ctx);
    const errors = errorTexts(ctx);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('导出失败：没有可导出的研究记录');
    expect(dividerLabels(ctx)).toContain('正在组装报告…');
    teardown(ctx);
  });

  it('/export sanitize：进度行标注脱敏版，body.sanitize=true 透传，完成行带「已脱敏」', async () => {
    let seen: Record<string, unknown> | null = null;
    const ctx = await startChat(
      () => ({
        success: true,
        data: { reportDir: 'output/reports/20260821-1031-vm1', evidenceCount: 2, degraded: [], sanitized: true },
      }),
      (body) => { seen = body; },
    );
    await runExport(ctx, '/export sanitize');
    expect(seen).not.toBeNull();
    expect((seen as unknown as Record<string, unknown>).sanitize).toBe(true);
    expect((seen as unknown as Record<string, unknown>).workspace).toBe('E:/code/u-disk');
    const labels = dividerLabels(ctx);
    expect(labels).toContain('正在组装报告（脱敏版）…');
    expect(labels).toContain('报告已导出：output/reports/20260821-1031-vm1（证据 2 个，已脱敏）');
    teardown(ctx);
  });

  it('未知参数：用法错误，不发请求', async () => {
    let called = false;
    const ctx = await startChat(() => {
      called = true;
      return { success: true, data: {} };
    });
    await runExport(ctx, '/export --all');
    expect(called).toBe(false);
    expect(errorTexts(ctx)[0]).toContain('用法：/export [sanitize]');
    teardown(ctx);
  });
});
