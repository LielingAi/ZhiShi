/**
 * 1.2.9 TUI 修复回归——Q3 Tab 唤起补全 / Q4 ↑↓ 历史召回。
 *
 * Q3:Tab 此前只在补全面板已开时接受选中(overlay 路由),无 overlay 时是
 *   纯无操作(dead branch);现输入以 / 或 @ 开头时 Tab 主动唤起面板。
 * Q4:↑/↓ 历史召回自 1.0.0 已接线(keymap CSI→up/down → editor history),
 *   实机投诉多为旧包/感知差——此处用完整字节链路钉死回归。
 *
 * 无 TTY、无 sidecar:fake fetch + EventEmitter 注入按键字节(同
 * app-fixes-1-2-8 惯例);history 指向临时目录。
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from './app';
import { TerminalWriter } from './terminal-writer';
import { SidecarClient, type FetchLike, type FetchResponseLike, type FetchInitLike } from '../client';
import { HistoryStore } from './history';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function jsonResponse(body: Record<string, unknown>): FetchResponseLike {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: null,
  };
}

function sseResponse(): FetchResponseLike {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => 'text/event-stream' },
    json: async () => ({}),
    text: async () => '',
    body: {
      getReader: () => ({
        read: async () => new Promise(() => {}), // hang — stream stays open
        cancel: async () => {},
      }),
    },
  } as FetchResponseLike;
}

function fakeClient(): SidecarClient {
  const fetchImpl: FetchLike = (async (url: string, _init?: FetchInitLike) => {
    if (url.includes('/chat/stream')) return sseResponse();
    return jsonResponse({ success: true, data: {} });
  }) as FetchLike;
  return new SidecarClient({ base: 'http://test', fetchImpl });
}

function makeApp(history: HistoryStore) {
  const writer = new TerminalWriter({
    out: { write: () => true },
    cols: 80,
    rows: 24,
    depth: 'none',
  });
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  const app = new App({
    client: fakeClient(),
    writer,
    input,
    workspace: 'E:/code/u-disk',
    presetEnv: { kind: 'env', id: 'vm1', envKind: 'vm', warnings: [] },
    history,
  });
  return { app, input, writer };
}

type AppAny = {
  editor: { text: string };
  overlay: { kind: string } | null;
};

describe('Q3: Tab 唤起补全(1.2.9)', () => {
  it('输入 /mo 后按 Tab → 补全面板弹出;再 Tab 接受 → 编辑器得 /model ', async () => {
    const { app, input, writer } = makeApp(new HistoryStore('agent', mkdtempSync(join(tmpdir(), 'tui-1-2-9-'))));
    writer.enter();
    await app.start();
    await sleep(50);
    const a = app as unknown as AppAny;

    input.emit('data', Buffer.from('/mo', 'utf8'));
    await sleep(20);
    expect(a.overlay?.kind).toBe('completion'); // 输入即弹出(实时补全)

    // 关掉面板再按 Tab——Q3 修复点:无 overlay 时 Tab 唤起
    input.emit('data', Buffer.from('\x1b', 'utf8')); // Esc 关面板(消歧 30ms)
    await sleep(80);
    expect(a.overlay).toBeNull();
    input.emit('data', Buffer.from('\t', 'utf8'));
    await sleep(20);
    expect(a.overlay?.kind).toBe('completion'); // Tab 唤起

    input.emit('data', Buffer.from('\t', 'utf8')); // overlay 路由:接受选中项
    await sleep(20);
    expect(a.overlay).toBeNull();
    expect(a.editor.text).toBe('/model ');
  });

  it('普通文本按 Tab 不唤起(无操作)', async () => {
    const { app, input, writer } = makeApp(new HistoryStore('agent', mkdtempSync(join(tmpdir(), 'tui-1-2-9-'))));
    writer.enter();
    await app.start();
    await sleep(50);
    input.emit('data', Buffer.from('hello\t', 'utf8'));
    await sleep(20);
    expect((app as unknown as AppAny).overlay).toBeNull();
    expect((app as unknown as AppAny).editor.text).toBe('hello');
  });
});

describe('Q4: ↑/↓ 历史召回(回归钉死)', () => {
  it('空输入按 ↑ 召回最近一条;再 ↑ 更老;↓ 返回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tui-1-2-9-'));
    const history = new HistoryStore('agent', dir);
    history.append('第一条消息', 'vm1');
    history.append('第二条消息', 'vm1');
    const { app, input, writer } = makeApp(history);
    writer.enter();
    await app.start();
    await sleep(50);
    const a = app as unknown as AppAny;

    input.emit('data', Buffer.from('\x1b[A', 'utf8')); // ↑
    await sleep(20);
    expect(a.editor.text).toBe('第二条消息');
    input.emit('data', Buffer.from('\x1b[A', 'utf8'));
    await sleep(20);
    expect(a.editor.text).toBe('第一条消息');
    input.emit('data', Buffer.from('\x1b[B', 'utf8')); // ↓ 返回较新
    await sleep(20);
    expect(a.editor.text).toBe('第二条消息');
  });
});
