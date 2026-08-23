/**
 * 1.2.8 TUI BUG 修复回归(app/entry/输入一路)。
 *
 * 覆盖:H4 泵叠加 / H6 rewind 吞消息 / H5 attach 挂起隔离 / H8 崩溃兜底 /
 * M5 gate 污染+modal 死锁 / M6 gate 盘点竞态 / M11 paste 跨 chunk /
 * L1 steering 双提示 / L2 幻影分隔条 / L10 多行斜杠 / L5 多行历史 /
 * L6 stdin utf8 / L7 状态栏滤 done。
 *
 * 无 TTY、无 sidecar:fake fetch + EventEmitter 注入按键字节(同
 * app-gate-reentry 惯例);history 指向临时目录,不写真实 ~/.zhishi。
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from './app';
import { TerminalWriter } from './terminal-writer';
import { SidecarClient, type FetchLike, type FetchResponseLike, type FetchInitLike } from '../client';
import { LineEditor } from './editor';
import { HistoryStore } from './history';
import { GateController, type GateHost } from './gate-controller';
import { createTerminalHandoff, createFatalHandler } from './entry';
import { composeBackgroundSeg, registerTask, finishTask } from './bg-tasks';
import type { SessionState, UserBlock } from './types';

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

/** /chat/stream:挂住不 EOF(泵活着),捕获 init.signal 供 H4 断言 abort。 */
function sseResponse(init: FetchInitLike | undefined, signals?: AbortSignal[]): FetchResponseLike {
  if (init?.signal && signals) signals.push(init.signal);
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

function fakeClient(opts: {
  sseSignals?: AbortSignal[];
  post?: (url: string, body: Record<string, unknown>) => Record<string, unknown>;
} = {}): SidecarClient {
  const fetchImpl: FetchLike = (async (url: string, init?: FetchInitLike) => {
    if (url.includes('/chat/stream')) return sseResponse(init, opts.sseSignals);
    const body =
      opts.post?.(url, JSON.parse(init?.body ?? '{}') as Record<string, unknown>) ??
      { success: true, data: {} };
    return jsonResponse(body);
  }) as FetchLike;
  return new SidecarClient({ base: 'http://test', fetchImpl });
}

interface AppHarness {
  app: App;
  input: EventEmitter;
  writer: TerminalWriter;
  written: string[];
}

function makeApp(client: SidecarClient, preset: boolean): AppHarness {
  const written: string[] = [];
  const writer = new TerminalWriter({
    out: {
      write: (t: string) => {
        written.push(t);
        return true;
      },
    },
    cols: 80,
    rows: 24,
    depth: 'none',
  });
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  const app = new App({
    client,
    writer,
    input,
    workspace: 'E:/code/u-disk',
    presetEnv: preset ? { kind: 'env', id: 'vm1', envKind: 'vm', warnings: [] } : null,
    history: new HistoryStore('agent', mkdtempSync(join(tmpdir(), 'tui-1-2-8-'))),
  });
  return { app, input: input as unknown as EventEmitter, writer, written };
}

type AppAny = {
  ingest: (ev: { event: string; data: string }) => void;
  doRewind: (srvId: string) => Promise<void>;
  stop: () => Promise<void>;
  state: SessionState;
  editor: LineEditor;
  overlay: unknown;
  mode: string;
};

function freshSessionState(): SessionState {
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

describe('H4: enterChat 先 abort 旧泵(gate→chat 不叠加泵)', () => {
  it('/env 进出一次:旧泵 signal aborted,全场只有新泵活着', async () => {
    const sseSignals: AbortSignal[] = [];
    const { app, input, writer } = makeApp(fakeClient({ sseSignals }), true);
    writer.enter();
    await app.start();
    await sleep(100);
    expect(sseSignals.length).toBe(1);

    input.emit('data', Buffer.from('/env\r', 'utf8')); // 重进正门
    await sleep(200);
    expect((app as unknown as AppAny).mode).toBe('gate');
    input.emit('data', Buffer.from('\x1b', 'utf8')); // Esc 返回 chat
    await sleep(150); // Esc 30ms 消歧 + enterChat

    expect(sseSignals.length).toBe(2);
    expect(sseSignals[0].aborted).toBe(true); // 修复前:旧泵不 abort,双泵消费同一流
    expect(sseSignals[1].aborted).toBe(false);
    app.dispose();
    writer.exit();
  });
});

describe('H6: rewind 清空整个 seenSrvIds', () => {
  it('服务端 messageSeq=0 全量复用 id——只清 user 不够,整个集合作废', async () => {
    const { app, writer } = makeApp(fakeClient(), true);
    writer.enter();
    await app.start();
    await sleep(50);
    const a = app as unknown as AppAny;
    const replay = (id: string, role: string, content: string): void =>
      a.ingest({ event: 'chat:message-replay', data: JSON.stringify({ message: { id, role, content } }) });
    replay('0', 'user', '第一条');
    replay('1', 'assistant', '回复');
    replay('2', 'user', '第二条');
    expect(a.state.seenSrvIds.size).toBe(3);

    await a.doRewind('2'); // fake /chat/rewind 默认 success
    expect(a.state.seenSrvIds.size).toBe(0); // 修复前剩 {0,1},新消息撞 id 被吞
    expect(a.state.blocks.some((b) => b.kind === 'user' && (b as UserBlock).srvId === '2')).toBe(false);
    app.dispose();
    writer.exit();
  });
});

describe('H5: /attach 挂起隔离(entry createTerminalHandoff)', () => {
  it('挂起:退屏 + cooked + 暂停 stdin;恢复:全量回滚 + reflow', () => {
    const calls: string[] = [];
    const input = {
      setRawMode: (v: boolean) => {
        calls.push(`raw:${v}`);
      },
      pause: () => {
        calls.push('pause');
      },
      resume: () => {
        calls.push('resume-stream');
      },
    } as unknown as NodeJS.ReadStream;
    const writer = {
      exit: () => {
        calls.push('exit');
      },
      enter: () => {
        calls.push('enter');
      },
      resize: (c: number, r: number) => {
        calls.push(`resize:${c}x${r}`);
      },
    };
    const h = createTerminalHandoff({ input, writer, measure: () => ({ cols: 100, rows: 30 }) });

    h.suspend();
    expect(h.isSuspended()).toBe(true); // SIGINT 处理器据此屏蔽
    h.resume();
    expect(h.isSuspended()).toBe(false);
    // 修复前:无 pause——子进程 stdio:'inherit' 与 TUI data 监听抢同一 fd。
    expect(calls).toEqual([
      'exit',
      'raw:false',
      'pause',
      'resume-stream',
      'raw:true',
      'enter',
      'resize:100x30',
    ]);
  });
});

describe('H8: 崩溃兜底(entry createFatalHandler)', () => {
  it('致命异常:先恢复终端,再 stderr,最后非零退出', () => {
    const order: string[] = [];
    const fatal = createFatalHandler({
      restore: () => {
        order.push('restore');
      },
      log: (msg) => {
        order.push(`log:${msg.includes('boom')}`);
      },
      exit: (code) => {
        order.push(`exit:${code}`);
      },
    });
    fatal(new Error('boom'));
    expect(order).toEqual(['restore', 'log:true', 'exit:1']);
  });

  it('恢复自身抛错也要继续退出流程', () => {
    const order: string[] = [];
    const fatal = createFatalHandler({
      restore: () => {
        throw new Error('restore failed');
      },
      log: () => {
        order.push('log');
      },
      exit: (code) => {
        order.push(`exit:${code}`);
      },
    });
    fatal('非 Error 值');
    expect(order).toEqual(['log', 'exit:1']);
  });
});

describe('M5: gate 模式 modal 优先 + ingest 不污染正门', () => {
  it('gate 模式下开着 boundary modal:y 路由到 modal 而非被 gate 吞掉', async () => {
    const { app, input, writer } = makeApp(fakeClient(), false);
    writer.enter();
    await app.start();
    await sleep(150);
    expect((app as unknown as AppAny).mode).toBe('gate');

    let answered: boolean | null = null;
    (app as unknown as AppAny).overlay = {
      kind: 'modal',
      state: {
        active: true,
        kind: 'host-write',
        objects: ['/etc/passwd'],
        resolve: (v: boolean) => {
          answered = v;
        },
      },
    };
    input.emit('data', Buffer.from('y', 'utf8'));
    await sleep(50);
    expect(answered).toBe(true); // 修复前:gate 先吃掉 'y',modal 死锁
    expect((app as unknown as AppAny).overlay).toBeNull();
    app.dispose();
    writer.exit();
  });

  it('gate 模式下 ingest 只归约 state,不 repaintBlocks/renderChrome 写屏', async () => {
    const { app, writer, written } = makeApp(fakeClient(), false);
    writer.enter();
    await app.start();
    await sleep(150);
    written.length = 0;

    const a = app as unknown as AppAny;
    a.ingest({
      event: 'chat:message-replay',
      data: JSON.stringify({ message: { id: '9', role: 'user', content: '迟到消息xyz' } }),
    });
    writer.flush();
    expect(written.join('')).not.toContain('迟到消息xyz'); // 正门不被会话块污染
    expect(a.state.blocks.length).toBe(1); // state 照归约,回 chat 全量重绘
    app.dispose();
    writer.exit();
  });
});

describe('M6: gate 盘点竞态', () => {
  function makeGateHost(adminPost: (path: string, body: Record<string, unknown>) => Promise<unknown>): {
    host: GateHost;
    calls: string[];
  } {
    const calls: string[] = [];
    const host: GateHost = {
      client: {
        adminPost,
        discoverEnvironments: async () => ({ docker: [], vm: [] }),
      } as unknown as GateHost['client'],
      workspace: '/ws',
      editor: new LineEditor(),
      isChatMode: () => true, // /env 重进
      enterGateMode: () => {
        calls.push('enterGateMode');
      },
      enterChat: () => {
        calls.push('enterChat');
      },
      requestQuit: () => {
        calls.push('requestQuit');
      },
      setEnv: () => {},
      clearScrollback: () => {},
      appendRaw: () => {
        calls.push('appendRaw');
      },
      renderChrome: () => {
        calls.push('renderChrome');
      },
      layoutCols: () => 80,
    };
    return { host, calls };
  }

  it('盘点中:上下/Enter 挡键,Esc 退出后迟到的 gather 结果不写屏', async () => {
    let releaseGather: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseGather = r;
    });
    const { host, calls } = makeGateHost(() => gate.then(() => ({ success: true })));
    const ctl = new GateController(host);
    const entered = ctl.enter();
    await sleep(20); // 盘点中
    calls.length = 0;

    await ctl.onKey({ name: 'down', mods: [] });
    await ctl.onKey({ name: 'enter', mods: [] });
    expect(calls).toEqual([]); // 修复前:踩陈旧 options,Enter 误 commit

    await ctl.onKey({ name: 'esc', mods: [] });
    expect(calls).toEqual(['enterChat']); // Esc 中途退出(重进语义:回 chat)

    releaseGather();
    await entered;
    expect(calls).toEqual(['enterChat']); // 迟到结果不再 render() 写屏
  });

  it('盘点正常完成:渲染选项,上下可移动', async () => {
    const { host, calls } = makeGateHost(async () => ({ success: true }));
    const ctl = new GateController(host);
    await ctl.enter();
    const afterGather = calls.length;
    expect(afterGather).toBeGreaterThan(0); // render() 已写屏
    await ctl.onKey({ name: 'down', mods: [] });
    expect(calls.length).toBeGreaterThan(afterGather); // 移动触发重绘
  });
});

describe('M11: bracketed paste 跨 chunk', () => {
  it('起始标记后跨 chunk 累积,\\x1b[201~ 到达才整段插入', async () => {
    const { app, input, writer } = makeApp(fakeClient(), true);
    writer.enter();
    await app.start();
    await sleep(50);
    const a = app as unknown as AppAny;

    input.emit('data', Buffer.from('\x1b[200~hel'));
    input.emit('data', Buffer.from('lo wor'));
    expect(a.editor.text).toBe(''); // 修复前:无结束标记时当即裸插入半截
    input.emit('data', Buffer.from('ld\x1b[201~'));
    expect(a.editor.text).toBe('hello world');
    app.dispose();
    writer.exit();
  });

  it('标记落在 chunk 中部:标记前普通键照常,结束后余量继续解析', async () => {
    const { app, input, writer } = makeApp(fakeClient(), true);
    writer.enter();
    await app.start();
    await sleep(50);
    const a = app as unknown as AppAny;

    input.emit('data', Buffer.from('a\x1b[200~XY'));
    expect(a.editor.text).toBe('a'); // 修复前:startsWith 不命中,整段当键序列乱解析
    input.emit('data', Buffer.from('Z\x1b[201~b'));
    expect(a.editor.text).toBe('aXYZb');
    app.dispose();
    writer.exit();
  });
});

describe('L1: steering 不本地插行', () => {
  it('send 返回 steering:true 无双提示;SSE steering-added 到达插唯一一条', async () => {
    const client = fakeClient({
      post: (url) => (url.includes('/chat/send') ? { success: true, steering: true } : { success: true, data: {} }),
    });
    const { app, input, writer } = makeApp(client, true);
    writer.enter();
    await app.start();
    await sleep(50);
    const a = app as unknown as AppAny;

    input.emit('data', Buffer.from('继续 fuzz\r', 'utf8'));
    await sleep(100);
    // 修复前:本地乐观插一条 background 行;SSE 广播再插一条 → 双提示。
    expect(a.state.blocks.filter((b) => b.kind === 'background').length).toBe(0);

    a.ingest({
      event: 'chat:steering-added',
      data: JSON.stringify({ queueId: 'q1', messageText: '继续 fuzz' }),
    });
    expect(a.state.blocks.filter((b) => b.kind === 'background').length).toBe(1);
    app.dispose();
    writer.exit();
  });
});

describe('L2: stop 幻影分隔条', () => {
  it('服务端空闲(alreadyStopped) → 主动撤下乐观分隔条', async () => {
    const client = fakeClient({
      post: (url) =>
        url.includes('/chat/stop') ? { success: true, alreadyStopped: true } : { success: true, data: {} },
    });
    const { app, writer } = makeApp(client, true);
    writer.enter();
    await app.start();
    await sleep(50);
    const a = app as unknown as AppAny;
    a.ingest({ event: 'chat:status', data: JSON.stringify({ sessionState: 'running' }) });

    await a.stop();
    // 修复前:acted=false 不广播 chat:message-stopped,分隔条永不确认残留。
    expect(a.state.pendingDividerId).toBeNull();
    expect(a.state.blocks.some((b) => b.kind === 'divider')).toBe(false);
    app.dispose();
    writer.exit();
  });

  it('服务端 acted(无 alreadyStopped) → 分隔条保留等 chat:message-stopped 确认', async () => {
    const client = fakeClient({
      post: (url) => (url.includes('/chat/stop') ? { success: true } : { success: true, data: {} }),
    });
    const { app, writer } = makeApp(client, true);
    writer.enter();
    await app.start();
    await sleep(50);
    const a = app as unknown as AppAny;
    a.ingest({ event: 'chat:status', data: JSON.stringify({ sessionState: 'running' }) });

    await a.stop();
    expect(a.state.pendingDividerId).not.toBeNull();
    expect(a.state.blocks.some((b) => b.kind === 'divider')).toBe(true);
    app.dispose();
    writer.exit();
  });
});

describe('L10: 多行斜杠不当命令解析', () => {
  it('多行文本以 / 开头 → 按消息发 /chat/send,不触发 /env', async () => {
    const urls: string[] = [];
    const client = fakeClient({
      post: (url) => {
        urls.push(url);
        return { success: true, data: {} };
      },
    });
    const { app, input, writer } = makeApp(client, true);
    writer.enter();
    await app.start();
    await sleep(50);
    const a = app as unknown as AppAny;

    a.editor.setText('/env\n第二行');
    input.emit('data', Buffer.from('\r', 'utf8'));
    await sleep(100);
    expect(urls.some((u) => u.includes('/chat/send'))).toBe(true);
    expect(urls.some((u) => u.includes('environment/select'))).toBe(false);
    expect((app as unknown as AppAny).mode).toBe('chat'); // 没进正门
    app.dispose();
    writer.exit();
  });
});

describe('L5: 多行历史召回拆行', () => {
  it("history-prev 召回多行条目按 \\n 拆行(与 setText 口径一致)", () => {
    const ed = new LineEditor();
    ed.setHistory(['单条', '第一行\n第二行']);
    ed.apply({ type: 'history-prev' });
    // 修复前:['第一行\n第二行'] 一整行进 lines[0],光标/折行全乱。
    expect(ed.snapshot().lines).toEqual(['第一行', '第二行']);
    expect(ed.text).toBe('第一行\n第二行');
  });
});

describe('L6: stdin setEncoding 后的 string chunk', () => {
  it('data 事件给 string 时 app 照常解析(entry setEncoding 契约)', async () => {
    const { app, input, writer } = makeApp(fakeClient(), true);
    writer.enter();
    await app.start();
    await sleep(50);
    input.emit('data', '你好'); // string,非 Buffer
    await sleep(50);
    expect((app as unknown as AppAny).editor.text).toBe('你好');
    app.dispose();
    writer.exit();
  });
});

describe('L7: 状态栏滤掉已完成任务', () => {
  it('done 任务不上状态栏;登记表 state.tasks 保留(/tasks 面板仍列)', () => {
    const state = freshSessionState();
    registerTask(state, 't1', 'fuzz 崩溃分析');
    registerTask(state, 't2', '跑 poc');
    finishTask(state, 't1', '3 个崩溃');
    const seg = composeBackgroundSeg(state);
    expect(seg).toContain('跑 poc');
    expect(seg).not.toContain('fuzz 崩溃分析');
    expect(state.tasks.size).toBe(2);
  });
});
