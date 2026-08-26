import { describe, expect, it } from 'vitest';

import {
  parseServerFrame,
  TermClient,
  termUrl,
  type TermServerMessage,
  type TermWebSocketLike,
} from './term-client';

/** 假 WS：记录 send 帧 + 手动触发服务端帧/close。 */
class FakeWs implements TermWebSocketLike {
  readyState = 1;
  sent: string[] = [];
  private listeners = new Map<string, Array<(ev: unknown) => void>>();

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((f) => f !== fn));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string): void {
    // 测试桩：不自动触发 close 事件（由测试显式驱动）。
  }

  serverFrame(msg: TermServerMessage): void {
    for (const fn of this.listeners.get('message') ?? []) {
      fn({ data: JSON.stringify(msg) });
    }
  }

  serverRaw(raw: string): void {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: raw });
  }

  serverClose(code: number): void {
    for (const fn of this.listeners.get('close') ?? []) fn({ code });
  }

  serverOpen(): void {
    for (const fn of this.listeners.get('open') ?? []) fn({});
  }
}

describe('termUrl（http base → ws 地址）', () => {
  it('协议替换 + envKey 编码', () => {
    expect(termUrl('http://127.0.0.1:4317', 'env:pwn-vm')).toBe(
      'ws://127.0.0.1:4317/api/admin/environment/term?env=env%3Apwn-vm',
    );
    expect(termUrl('https://x/', 'a b')).toBe('wss://x/api/admin/environment/term?env=a%20b');
  });
});

describe('parseServerFrame（服务端帧解析）', () => {
  it('四类帧', () => {
    expect(parseServerFrame('{"type":"output","data":"root@vm:~# "}')).toEqual({
      type: 'output',
      data: 'root@vm:~# ',
    });
    expect(parseServerFrame('{"type":"exit","code":0}')).toEqual({ type: 'exit', code: 0 });
    expect(parseServerFrame('{"type":"exit","code":143,"signal":"SIGTERM"}')).toEqual({
      type: 'exit',
      code: 143,
      signal: 'SIGTERM',
    });
    expect(parseServerFrame('{"type":"error","message":"未找到环境"}')).toEqual({
      type: 'error',
      message: '未找到环境',
    });
    expect(parseServerFrame('{"type":"pong"}')).toEqual({ type: 'pong' });
  });

  it('非法 JSON / 未知类型 / 字段类型不符 → null', () => {
    expect(parseServerFrame('not json')).toBeNull();
    expect(parseServerFrame('{"type":"other"}')).toBeNull();
    expect(parseServerFrame('{"type":"output","data":7}')).toBeNull();
    expect(parseServerFrame('null')).toBeNull();
    expect(parseServerFrame('42')).toBeNull();
  });
});

describe('TermClient（协议接线，fake WS 驱动）', () => {
  it('open 后自动发初始 resize（80×24 默认）', () => {
    const ws = new FakeWs();
    new TermClient({ ws, sink: { write: () => {} } });
    ws.serverOpen();
    expect(ws.sent).toEqual([JSON.stringify({ type: 'resize', cols: 80, rows: 24 })]);
  });

  it('input/resize/ping 出帧', () => {
    const ws = new FakeWs();
    const c = new TermClient({ ws, sink: { write: () => {} } });
    c.sendInput('ls\n');
    c.sendResize(100, 30);
    c.ping();
    expect(ws.sent).toEqual([
      JSON.stringify({ type: 'input', data: 'ls\n' }),
      JSON.stringify({ type: 'resize', cols: 100, rows: 30 }),
      JSON.stringify({ type: 'ping' }),
    ]);
  });

  it('output 帧写入 sink；exit/error 触发回调；pong 静默', () => {
    const ws = new FakeWs();
    const out: string[] = [];
    let exit: { code: number; signal?: string } | null = null;
    let error: string | null = null;
    new TermClient({
      ws,
      sink: { write: (d) => out.push(d) },
      onExit: (info) => (exit = info),
      onError: (m) => (error = m),
    });
    ws.serverFrame({ type: 'output', data: 'a' });
    ws.serverFrame({ type: 'output', data: 'b' });
    ws.serverFrame({ type: 'pong' });
    ws.serverFrame({ type: 'exit', code: 143, signal: 'SIGTERM' });
    expect(out.join('')).toBe('ab');
    expect(exit).toEqual({ code: 143, signal: 'SIGTERM' });
    ws.serverFrame({ type: 'error', message: '未找到环境' });
    expect(error).toBe('未找到环境');
  });

  it('close 事件 → onClose（code 透传）；dispose 后不再出帧', () => {
    const ws = new FakeWs();
    let closeCode = -1;
    const c = new TermClient({ ws, sink: { write: () => {} }, onClose: (code) => (closeCode = code) });
    ws.serverClose(4001);
    expect(closeCode).toBe(4001);
    c.sendInput('x');
    expect(ws.sent).toEqual([]);
    // dispose 后再 close 不重复回调。
    c.dispose();
    ws.serverClose(1000);
    expect(closeCode).toBe(4001);
  });

  it('非法 resize 参数不出帧', () => {
    const ws = new FakeWs();
    const c = new TermClient({ ws, sink: { write: () => {} } });
    c.sendResize(0, 10);
    c.sendResize(1.5, 10);
    expect(ws.sent).toEqual([]);
  });
});
