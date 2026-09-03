/**
 * crash-log.ts 直接单元测试（debt #3）。
 *
 * 该模块在 import 时即定死 CRASH_LOG_DIR / CRASH_LOG_FILE（读
 * ZHISHI_DATA_DIR），且 installCrashDiagnostics 向 process 挂
 * uncaughtException / unhandledRejection / exit / 信号 处理器。测试策略：
 *   - 每用例 mkdtemp + ZHISHI_DATA_DIR + resetModules + 动态 import
 *     （同时重置 stdioBroken / ceiling / 指纹表等模块级状态）；
 *   - 不在 process 上真正 emit 事件（vitest 自己也监听 uncaughtException，
 *     emit 会被误判为未捕获错误）——而是快照 install 前后监听器差集，
 *     取出「本模块新增的那个处理器」直接调用；
 *   - afterEach 摘掉新增监听器，避免污染同 fork 内其他测试。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CrashLogModule = typeof import('./crash-log');

const INSTALLED_EVENTS = [
  'exit',
  'beforeExit',
  'uncaughtException',
  'unhandledRejection',
  'SIGTERM',
  'SIGINT',
] as const;

let dataDir: string;
let prevDataDir: string | undefined;
let mod: CrashLogModule;
let baselineListeners: Map<string, AnyListener[]>;

function crashDir(): string {
  return join(dataDir, 'logs', 'crash');
}

function crashFiles(): string[] {
  if (!existsSync(crashDir())) return [];
  return readdirSync(crashDir()).filter(f => f.endsWith('.log'));
}

function readCrashLog(): string {
  const files = crashFiles();
  expect(files.length).toBeGreaterThan(0);
  return files.map(f => readFileSync(join(crashDir(), f), 'utf-8')).join('');
}

type AnyListener = (...args: never[]) => void;

// process.listeners 的 'exit'/'SIGTERM' 等重载是割裂的字面量类型，联合类型
// 传不进去；且方法依赖 this 绑定，不能摘成独立引用——包装成函数 + as never。
function procListeners(event: string): AnyListener[] {
  return process.listeners(event as never) as AnyListener[];
}

function procRemoveListener(event: string, listener: AnyListener): void {
  process.removeListener(event as never, listener as never);
}

/** 取出 installCrashDiagnostics 新增的事件处理器（差集）。 */
function addedListener(event: string): (...args: unknown[]) => void {
  const added = procListeners(event)
    .filter(l => !(baselineListeners.get(event) ?? []).includes(l));
  expect(added.length).toBe(1);
  return added[0] as (...args: unknown[]) => void;
}

beforeEach(async () => {
  prevDataDir = process.env.ZHISHI_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'crash-log-test-'));
  process.env.ZHISHI_DATA_DIR = dataDir;
  baselineListeners = new Map(INSTALLED_EVENTS.map(e => [e, procListeners(e)]));
  // 安静化：startup beacon + handler 的 console.error 反馈行
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.resetModules();
  mod = await import('./crash-log');
});

afterEach(() => {
  for (const e of INSTALLED_EVENTS) {
    for (const l of procListeners(e)) {
      if (!(baselineListeners.get(e) ?? []).includes(l)) procRemoveListener(e, l);
    }
  }
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
  if (prevDataDir === undefined) delete process.env.ZHISHI_DATA_DIR;
  else process.env.ZHISHI_DATA_DIR = prevDataDir;
});

describe('installCrashDiagnostics', () => {
  it('模块加载即创建 crash 目录；install 写入 STARTUP 行', () => {
    expect(existsSync(crashDir())).toBe(true);
    expect(crashFiles()).toHaveLength(0); // 文件惰性创建：首条日志落盘时生成

    mod.installCrashDiagnostics();

    const content = readCrashLog();
    expect(content).toContain('STARTUP');
    expect(content).toContain('Server starting');
  });

  it('注册全部生命周期监听器', () => {
    mod.installCrashDiagnostics();
    for (const e of INSTALLED_EVENTS) {
      expect(addedListener(e)).toBeTypeOf('function');
    }
  });
});

describe('uncaughtException 处理器', () => {
  it('普通异常：落 UNCAUGHT_EXCEPTION 行 + console.error 反馈', () => {
    mod.installCrashDiagnostics();
    const handler = addedListener('uncaughtException');

    handler(new Error('boom'));

    const content = readCrashLog();
    expect(content).toContain('UNCAUGHT_EXCEPTION');
    expect(content).toContain('boom');
    expect(console.error).toHaveBeenCalledWith('[process] uncaughtException:', expect.any(Error));
    expect(mod.isStdioBroken()).toBe(false);
  });

  it('EPIPE（code）快路径：只落一行 UNCAUGHT_EPIPE，标记 stdioBroken，不写 console', () => {
    mod.installCrashDiagnostics();
    const handler = addedListener('uncaughtException');
    const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    handler(err);

    const content = readCrashLog();
    expect(content).toContain('UNCAUGHT_EPIPE');
    expect(content).not.toContain('UNCAUGHT_EXCEPTION');
    expect(mod.isStdioBroken()).toBe(true);
    expect(console.error).not.toHaveBeenCalledWith('[process] uncaughtException:', expect.anything());
  });

  it('消息形态 write EBADF（无 code）同样走管道快路径', () => {
    mod.installCrashDiagnostics();
    const handler = addedListener('uncaughtException');

    handler(new Error('write EBADF'));

    expect(readCrashLog()).toContain('UNCAUGHT_EPIPE');
    expect(mod.isStdioBroken()).toBe(true);
  });

  it('重入守卫：处理器执行中再次触发被丢弃（不递归落盘）', () => {
    mod.installCrashDiagnostics();
    const handler = addedListener('uncaughtException');
    // 构造一个会递归触发的场景：第一次调用时 console.error 反馈行里再调 handler。
    // 重入调用应被 inUncaughtHandler 直接 return——验证方式：递归那次不落第二行。
    vi.mocked(console.error).mockImplementationOnce(() => {
      handler(new Error('reentrant'));
    });

    handler(new Error('outer'));

    const content = readCrashLog();
    expect(content.match(/UNCAUGHT_EXCEPTION/g)).toHaveLength(1);
    expect(content).not.toContain('reentrant');
  });
});

describe('unhandledRejection 处理器', () => {
  it('落 UNHANDLED_REJECTION 行', () => {
    mod.installCrashDiagnostics();
    const handler = addedListener('unhandledRejection');

    handler(new Error('async boom'), Promise.resolve());

    const content = readCrashLog();
    expect(content).toContain('UNHANDLED_REJECTION');
    expect(content).toContain('async boom');
  });

  it('管道类 rejection 走快路径并标记 stdioBroken', () => {
    mod.installCrashDiagnostics();
    const handler = addedListener('unhandledRejection');

    handler(Object.assign(new Error('x'), { code: 'ENOTCONN' }), Promise.resolve());

    expect(readCrashLog()).toContain('UNHANDLED_REJECTION_EPIPE');
    expect(mod.isStdioBroken()).toBe(true);
  });
});

describe('异常指纹去重（PRD #133）', () => {
  it('同一指纹 dump 超 3 次后写一次 SUPPRESS_CONTEXT；1 行 crashLog 不限流', () => {
    mod.installCrashDiagnostics();
    const handler = addedListener('uncaughtException');
    const err = new Error('recurring misconfig');

    for (let i = 0; i < 5; i++) handler(err);

    const content = readCrashLog();
    expect(content.match(/UNCAUGHT_EXCEPTION/g)).toHaveLength(5);
    expect(content.match(/SUPPRESS_CONTEXT/g)).toHaveLength(1);
  });

  it('不同指纹各自计数，互不挤占 dump 预算', () => {
    mod.installCrashDiagnostics();
    const handler = addedListener('uncaughtException');

    for (let i = 0; i < 4; i++) handler(new Error(`error-kind-a`));
    for (let i = 0; i < 3; i++) handler(new Error(`error-kind-b`));

    const content = readCrashLog();
    // a 触发 4 次（超 3）→ 一次 SUPPRESS；b 恰好 3 次 → 不触发
    expect(content.match(/SUPPRESS_CONTEXT/g)).toHaveLength(1);
  });
});

describe('stdioBroken 标记', () => {
  it('markStdioBroken / isStdioBroken', () => {
    expect(mod.isStdioBroken()).toBe(false);
    mod.markStdioBroken();
    expect(mod.isStdioBroken()).toBe(true);
  });
});
