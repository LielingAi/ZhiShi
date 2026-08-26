/**
 * 1.3.3 — term-pty（attach 交互式 pty 端点）unit tests.
 *
 * 全部通过注入(mock pty.spawn / mock ws / mock envResolver)断言协议与
 * 生命周期,绝不加载原生模块、绝不真调 docker/ssh。
 * 覆盖:input→write、resize→resize(护栏)、ping→pong、output 帧、exit 帧
 * + 关 WS、WS close→kill pty、同 env 抢占旧连接先关且不误杀继任、
 * env 缺失/guest 通道/原生模块缺席/spawn 抛错 → error 帧 + close、
 * 非法帧/未知类型静默忽略。
 */
import { describe, expect, it } from 'vitest';

import type { EnvironmentEntry } from '../../shared/config-types';
import {
  CLOSE_CODE_ATTACH_FAILED,
  CLOSE_CODE_SUPERSEDED,
  TermSessionManager,
  type PtyApi,
  type TermPty,
  type TermServerMessage,
  type TermWebSocket,
} from './term-pty';

const DOCKER_ENTRY: EnvironmentEntry = {
  id: 'pwn-box',
  kind: 'docker',
  container: 'zhishi-pwn-abc',
  createdAt: '2026-01-01T00:00:00Z',
};

const GUEST_ENTRY: EnvironmentEntry = {
  id: 'iso-vm',
  kind: 'vm',
  vmName: 'iso-vm',
  vmx: 'D:\\v\\iso.vmx',
  createdAt: '2026-01-01T00:00:00Z',
};

class FakePty implements TermPty {
  written: string[] = [];
  resizes: Array<[number, number]> = [];
  killed: Array<string | undefined> = [];
  private dataListeners: Array<(d: string) => void> = [];
  private exitListeners: Array<(ev: { exitCode: number; signal?: number }) => void> = [];

  write(data: string): void { this.written.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push([cols, rows]); }
  kill(signal?: string): void { this.killed.push(signal); }
  onData(l: (d: string) => void): unknown { this.dataListeners.push(l); return this; }
  onExit(l: (ev: { exitCode: number; signal?: number }) => void): unknown { this.exitListeners.push(l); return this; }

  emitData(d: string): void { for (const l of this.dataListeners) l(d); }
  emitExit(ev: { exitCode: number; signal?: number }): void { for (const l of this.exitListeners) l(ev); }
}

class FakeWs implements TermWebSocket {
  readyState = 1;
  sent: string[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];
  private handlers: Record<string, Array<(...args: never[]) => void>> = {};

  on(event: string, l: (...args: never[]) => void): unknown {
    (this.handlers[event] ??= []).push(l);
    return this;
  }
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.readyState = 3;
  }
  emit(event: string): void {
    for (const l of this.handlers[event] ?? []) (l as () => void)();
  }
  emitMessage(raw: string): void {
    for (const l of this.handlers['message'] ?? []) (l as (d: string) => void)(raw);
  }
  lastJson(): TermServerMessage {
    return JSON.parse(this.sent[this.sent.length - 1] ?? 'null') as TermServerMessage;
  }
}

interface Harness {
  manager: TermSessionManager;
  pty: FakePty;
  ws: FakeWs;
  spawnCalls: Array<{ file: string; args: string[] }>;
}

function makeHarness(overrides: {
  envResolver?: (envKey: string) => EnvironmentEntry | null;
  ptyLoader?: () => PtyApi | null;
  resolveHostBinary?: (cmd: string) => string;
} = {}): Harness {
  const pty = new FakePty();
  const spawnCalls: Array<{ file: string; args: string[] }> = [];
  const manager = new TermSessionManager({
    envResolver: overrides.envResolver ?? ((key) => (key === DOCKER_ENTRY.id ? DOCKER_ENTRY : null)),
    ptyLoader: overrides.ptyLoader ?? (() => ({
      spawn: (file, args) => {
        spawnCalls.push({ file, args });
        return pty;
      },
    })),
    resolveHostBinary: overrides.resolveHostBinary ?? ((cmd) => `/usr/local/bin/${cmd}`),
    log: () => {},
  });
  const ws = new FakeWs();
  manager.attach(ws, DOCKER_ENTRY.id);
  return { manager, pty, ws, spawnCalls };
}

describe('TermSessionManager — 协议', () => {
  it('input → pty.write 原样透传', () => {
    const { pty, ws } = makeHarness();
    ws.emitMessage(JSON.stringify({ type: 'input', data: 'ls -la\n' }));
    expect(pty.written).toEqual(['ls -la\n']);
  });

  it('resize → pty.resize(cols, rows)；越界/非法值忽略', () => {
    const { pty, ws } = makeHarness();
    ws.emitMessage(JSON.stringify({ type: 'resize', cols: 132, rows: 40 }));
    expect(pty.resizes).toEqual([[132, 40]]);
    // 非整数 / 0 / 超上限一律忽略
    ws.emitMessage(JSON.stringify({ type: 'resize', cols: 0, rows: 24 }));
    ws.emitMessage(JSON.stringify({ type: 'resize', cols: 1.5, rows: 24 }));
    ws.emitMessage(JSON.stringify({ type: 'resize', cols: 9999, rows: 24 }));
    expect(pty.resizes).toEqual([[132, 40]]);
  });

  it('ping → pong 帧', () => {
    const { ws } = makeHarness();
    ws.emitMessage(JSON.stringify({ type: 'ping' }));
    expect(ws.lastJson()).toEqual({ type: 'pong' });
  });

  it('pty onData → output 帧', () => {
    const { pty, ws } = makeHarness();
    pty.emitData('root@box:~# ');
    expect(ws.lastJson()).toEqual({ type: 'output', data: 'root@box:~# ' });
  });

  it('非法 JSON / 未知类型 → 静默忽略(不炸、不回帧)', () => {
    const { ws } = makeHarness();
    ws.emitMessage('not-json{{{');
    ws.emitMessage(JSON.stringify({ type: 'frobnicate' }));
    ws.emitMessage(JSON.stringify({ type: 'input', data: 42 }));
    expect(ws.sent).toHaveLength(0);
  });
});

describe('TermSessionManager — 生命周期', () => {
  it('pty 自然退出 → exit 帧(带 signal 透传) + 关 WS + 会话清理', () => {
    const { manager, pty, ws } = makeHarness();
    pty.emitExit({ exitCode: 137, signal: 9 });
    expect(ws.lastJson()).toEqual({ type: 'exit', code: 137, signal: '9' });
    expect(ws.closed.some((c) => c.code === 1000)).toBe(true);
    expect(manager.activeCount()).toBe(0);
  });

  it('pty 自然退出(无 signal)→ exit 帧不带 signal 字段', () => {
    const { pty, ws } = makeHarness();
    pty.emitExit({ exitCode: 0 });
    expect(ws.lastJson()).toEqual({ type: 'exit', code: 0 });
  });

  it('WS close → kill pty(防泄漏) + 会话清理', () => {
    const { manager, pty, ws } = makeHarness();
    ws.emit('close');
    expect(pty.killed.length).toBeGreaterThan(0);
    expect(manager.activeCount()).toBe(0);
  });

  it('spawn 规格:docker 条目 → docker exec -it + sh 回退链;宿主二进制经 resolveHostBinary(args 不含程序名)', () => {
    const { spawnCalls } = makeHarness();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].file).toBe('/usr/local/bin/docker');
    expect(spawnCalls[0].args).toEqual([
      'exec', '-it', 'zhishi-pwn-abc', 'sh', '-c', '[ -x /bin/bash ] && exec /bin/bash; exec sh',
    ]);
  });

  it('同 env 抢占:旧连接先关(4001),新 pty 生成;旧连接 close 事件不误杀继任 pty', () => {
    const ptyA = new FakePty();
    const ptyB = new FakePty();
    const spawned: FakePty[] = [];
    const manager = new TermSessionManager({
      envResolver: () => DOCKER_ENTRY,
      ptyLoader: () => ({
        spawn: () => {
          const p = spawned.length === 0 ? ptyA : ptyB;
          spawned.push(p);
          return p;
        },
      }),
      resolveHostBinary: (c) => c,
      log: () => {},
    });
    const wsA = new FakeWs();
    manager.attach(wsA, DOCKER_ENTRY.id);
    expect(spawned).toEqual([ptyA]);

    const wsB = new FakeWs();
    manager.attach(wsB, DOCKER_ENTRY.id);
    // 旧连接被关(抢占码),新 pty 已 spawn,旧 pty 已被直接回收(不依赖 close 事件时序)
    expect(wsA.closed.some((c) => c.code === CLOSE_CODE_SUPERSEDED)).toBe(true);
    expect(spawned).toEqual([ptyA, ptyB]);
    expect(ptyA.killed.length).toBeGreaterThan(0);
    // wsA 再收 close 事件:不得误杀 ptyB(同 env 继任会话防护)
    wsA.emit('close');
    expect(ptyB.killed).toHaveLength(0);
    expect(manager.activeCount()).toBe(1);
    // ptyB 退出 → wsB 收到 exit,会话清空
    ptyB.emitExit({ exitCode: 0 });
    expect(manager.activeCount()).toBe(0);
  });

  it('closeAll:清空全部会话(kill + close WS)', () => {
    const { manager, pty, ws } = makeHarness();
    manager.closeAll();
    expect(pty.killed.length).toBeGreaterThan(0);
    expect(ws.closed.length).toBeGreaterThan(0);
    expect(manager.activeCount()).toBe(0);
  });
});

describe('TermSessionManager — 失败面(error 帧 + close)', () => {
  it('env 不存在 → error 帧 + close(1011),不 spawn', () => {
    const manager = new TermSessionManager({
      envResolver: () => null,
      ptyLoader: () => ({ spawn: () => new FakePty() }),
      resolveHostBinary: (c) => c,
      log: () => {},
    });
    const ws = new FakeWs();
    manager.attach(ws, 'ghost');
    expect(ws.lastJson().type).toBe('error');
    expect((ws.lastJson() as { message: string }).message).toContain('ghost');
    expect(ws.closed.some((c) => c.code === CLOSE_CODE_ATTACH_FAILED)).toBe(true);
  });

  it('guest 通道(断网隔离 VM)→ 明确拒绝(无 TTY)', () => {
    const manager = new TermSessionManager({
      envResolver: () => GUEST_ENTRY,
      ptyLoader: () => ({ spawn: () => new FakePty() }),
      resolveHostBinary: (c) => c,
      log: () => {},
    });
    const ws = new FakeWs();
    manager.attach(ws, GUEST_ENTRY.id);
    expect(ws.lastJson().type).toBe('error');
    expect((ws.lastJson() as { message: string }).message).toContain('guest-exec');
  });

  it('原生模块缺席 → error 帧(指引 environment/exec 兜底)', () => {
    const { ws, pty } = makeHarness({ ptyLoader: () => null });
    expect(ws.lastJson().type).toBe('error');
    expect((ws.lastJson() as { message: string }).message).toContain('node-pty');
    expect(pty.killed).toHaveLength(0);
  });

  it('spawn 抛错 → error 帧(带原始错误)', () => {
    const manager = new TermSessionManager({
      envResolver: () => DOCKER_ENTRY,
      ptyLoader: () => ({
        spawn: () => { throw new Error('docker: command not found'); },
      }),
      resolveHostBinary: (c) => c,
      log: () => {},
    });
    const ws = new FakeWs();
    manager.attach(ws, DOCKER_ENTRY.id);
    expect(ws.lastJson().type).toBe('error');
    expect((ws.lastJson() as { message: string }).message).toContain('docker: command not found');
  });
});
