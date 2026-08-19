/**
 * intel-progress 轮询助手单元测试（1.1.4）——statusFn/sleepMs/write 全注入，
 * 不发网络、不碰真实计时器。
 *
 * 覆盖：进度行格式化、状态响应形状解析（含坏形状/null）、轮询循环按间隔
 * 刷行、stop() 打断（不再写屏 + 补空写清行）、statusFn 抛错静默跳过、
 * inProgress=false 不刷行。
 */
import { describe, expect, it } from 'vitest';

import {
  extractIntelProgress,
  formatIntelProgressLine,
  startIntelProgressPolling,
} from './intel-progress';

/** 可控睡眠门：测试手动放行每轮轮询。 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** 宏任务 tick：让已就绪的 microtask 链 + 下一轮宏任务都跑完。 */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('纯函数', () => {
  it('formatIntelProgressLine：窗口标签与入库数', () => {
    const p = { inProgress: true, currentWindowLabel: '2026-01-01T00:00:00.000Z~2026-05-01T00:00:00.000Z', nvdAdded: 42, exploitCount: 3 };
    expect(formatIntelProgressLine(p))
      .toBe('⏳ 情报更新中: 已入库 42 条（窗口 2026-01-01T00:00:00.000Z~2026-05-01T00:00:00.000Z）');
    expect(formatIntelProgressLine({ ...p, currentWindowLabel: null }))
      .toBe('⏳ 情报更新中: 已入库 42 条');
  });

  it('extractIntelProgress：正常形状（data.status.progress）', () => {
    const res = {
      success: true,
      data: {
        status: {
          dbExists: true,
          progress: { inProgress: true, currentWindowLabel: 'a~b', nvdAdded: 7, exploitCount: 1 },
        },
      },
    };
    expect(extractIntelProgress(res)).toEqual({
      inProgress: true,
      currentWindowLabel: 'a~b',
      nvdAdded: 7,
      exploitCount: 1,
    });
  });

  it('extractIntelProgress：非对象 / 缺 progress / inProgress≠true → null', () => {
    expect(extractIntelProgress(null)).toBeNull();
    expect(extractIntelProgress('x')).toBeNull();
    expect(extractIntelProgress({})).toBeNull();
    expect(extractIntelProgress({ data: {} })).toBeNull();
    expect(extractIntelProgress({ data: { status: {} } })).toBeNull();
    expect(extractIntelProgress({ data: { status: { progress: { inProgress: false, nvdAdded: 1 } } } })).toBeNull();
    // 缺字段兜底
    expect(extractIntelProgress({ data: { status: { progress: { inProgress: true } } } })).toEqual({
      inProgress: true,
      currentWindowLabel: null,
      nvdAdded: 0,
      exploitCount: 0,
    });
  });
});

describe('轮询循环', () => {
  it('按间隔轮询刷行；stop() 打断并补空写清行；放行后不再写', async () => {
    // 每轮睡眠都停在新的未放行门上——放行一轮后循环立刻停在下一道门，
    // 不会空转饿死事件循环（写屏/断言才有确定的时序）。
    const gates: Array<{ promise: Promise<void>; resolve: () => void }> = [];
    const writes: string[] = [];
    const poller = startIntelProgressPolling({
      statusFn: async () => ({
        success: true,
        data: { status: { progress: { inProgress: true, currentWindowLabel: 'a~b', nvdAdded: 3, exploitCount: 0 } } },
      }),
      intervalMs: 3000,
      sleepMs: async () => {
        const g = deferred<void>();
        gates.push(g);
        await g.promise;
      },
      write: (l) => writes.push(l),
    });
    await tick();
    expect(gates).toHaveLength(1); // 首查前先睡一个间隔（第一道门未放行）
    expect(writes).toEqual([]);
    gates[0].resolve();
    await tick();
    expect(writes).toEqual(['⏳ 情报更新中: 已入库 3 条（窗口 a~b）']); // 第一轮：刷一行
    expect(gates).toHaveLength(2); // 下一轮已停在第二道门
    poller.stop(); // 打断 + 清行（空写）
    expect(writes).toEqual(['⏳ 情报更新中: 已入库 3 条（窗口 a~b）', '']);
    gates[1].resolve(); // 即使放行也不再写
    await tick();
    expect(writes).toHaveLength(2);
    poller.stop(); // 幂等
    expect(writes).toHaveLength(2);
  });

  it('statusFn 抛错 / inProgress=false：静默跳过不刷行、不炸循环', async () => {
    let calls = 0;
    const writes: string[] = [];
    const poller = startIntelProgressPolling({
      statusFn: async () => {
        calls += 1;
        if (calls === 1) throw new Error('sidecar busy');
        return { success: true, data: { status: { progress: { inProgress: false } } } };
      },
      intervalMs: 3000,
      sleepMs: async () => { await tick(); },
      write: (l) => writes.push(l),
    });
    // 放几轮宏任务让循环跑（每轮 sleep 都是宏任务 tick）
    await tick();
    await tick();
    await tick();
    await tick();
    poller.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(writes).toEqual([]); // 一轮抛错、其余 inProgress=false → 从不刷行
  });
});
