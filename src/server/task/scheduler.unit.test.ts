/**
 * S4 调度器内核单测。
 *
 * 全部用**注入时钟 + 注入执行器**：不真跑 turn、不留活着的 timer、不碰真实
 * `~/.zhishi`（数据目录是 mkdtemp 临时目录）。
 *
 * 时钟契约：`sleep(ms)` 只把虚拟时钟往前拨，所以 `sleepUntil` 的 wall-clock
 * 轮询瞬间收敛；`sleeps` 数组就是"调度器打算等多久"的完整轨迹，ralph 的
 * 3s/退避序列可以直接断言它。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetMemoryStoreForTest } from '../memory/store';
import {
  checkEndConditions,
  classifyCompletion,
  computeInitialTarget,
  createTaskScheduler,
  cronTurnExecutor,
  effectiveEndConditions,
  isProviderResolutionFailure,
  nextTickTarget,
  ralphBackoffMs,
  resolveRunMode,
  scheduleFromTask,
  validateCronExpression,
  type DispatchExecutor,
  type DispatchOutcome,
  type DispatchPayload,
  type SchedulerOptions,
  type TaskScheduler,
} from './scheduler';
import { TaskStore, type Task, type TaskRuntimeEntry } from './store';

// 缺省执行器（cronTurnExecutor）的**映射**要单独测：它把 DispatchPayload 翻成
// `/cron/execute-sync` 的 wire 形状再翻回来。真跑会起真 turn，这里把编排函数
// 换成 spy（动态 import 也会被 mock 拦到）。
const cronMock = vi.hoisted(() => ({ runCronExecuteSync: vi.fn() }));
vi.mock('../cron/routes', () => ({ runCronExecuteSync: cronMock.runCronExecuteSync }));

/** 虚拟时钟起点：2026-05-01T00:00:00Z（周五）。 */
const T0 = Date.parse('2026-05-01T00:00:00Z');

let clock: number;
let sleeps: number[];
let dataDir: string;
let store: TaskStore;
let calls: Array<{ task: Task; payload: DispatchPayload }>;

beforeEach(() => {
  clock = T0;
  sleeps = [];
  calls = [];
  dataDir = mkdtempSync(join(tmpdir(), 'zhishi-scheduler-'));
  store = new TaskStore({ dataDir });
  vi.restoreAllMocks();
});

afterEach(() => {
  // 状态迁移会写信任账本（<数据目录>/memory.db），sqlite 连接是模块级缓存 ——
  // Windows 上不先关连接，rmSync 会 EBUSY（既有惯例）。
  resetMemoryStoreForTest();
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function okExecutor(outcome: Partial<DispatchOutcome> = {}): DispatchExecutor {
  return async (task, payload) => {
    calls.push({ task, payload });
    return { ok: true, outputText: '本轮输出', durationMs: 1234, ...outcome };
  };
}

function makeScheduler(overrides: Partial<SchedulerOptions> = {}): TaskScheduler {
  return createTaskScheduler({
    store,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    executor: okExecutor(),
    maxLoopIterations: 20,
    // 默认把轮询粒度放大到"一次等到点"：这样 `sleeps` 记录的是**等待时长**
    // 而不是被切成 30s 片段的轮询次数。切片行为另有专门用例。
    pollMs: 24 * 3600_000,
    env: { ZHISHI_TASK_SCHEDULER: 'node' },
    ...overrides,
  });
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: '调度任务',
    executor: 'agent',
    workspaceId: 'ws-1',
    workspacePath: '',
    executionMode: 'recurring',
    sessionIds: [],
    status: 'running',
    tags: [],
    createdAt: T0 - 60_000,
    updatedAt: T0 - 60_000,
    statusHistory: [],
    dispatchOrigin: 'direct',
    deleted: false,
    ...overrides,
  };
}

/** 建任务 + 建 task.md（direct/system 派发要读它）。 */
async function seed(task: Task, taskMd = '执行任务：做事'): Promise<Task> {
  await store.upsert(task);
  const dir = store.docsDirFor(task.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'task.md'), taskMd, 'utf-8');
  return task;
}

/** 写/补一条运行态（测试夹具）。 */
async function setRuntime(taskId: string, patch: Partial<TaskRuntimeEntry>): Promise<void> {
  await store.updateRuntimeEntry(taskId, (entry) => ({
    taskId,
    sessionId: 'sess-initial',
    executionCount: 0,
    armed: true,
    ...entry,
    ...patch,
  }));
}

async function runtimeEntry(taskId: string): Promise<TaskRuntimeEntry | undefined> {
  return (await store.readRuntime()).find((e) => e.taskId === taskId);
}

// ============ 1. initial_target 矩阵 ============

describe('initial_target 矩阵（Rust start_scheduler initial_target 分支）', () => {
  it('Loop → now + 2s', () => {
    expect(computeInitialTarget({ kind: 'loop' }, undefined, T0)).toEqual({
      kind: 'wait',
      at: T0 + 2_000,
    });
  });

  it('At（未来）→ dispatchAt 原样；已过期 → now + 2s；非法值 → now + 2s', () => {
    const at = T0 + 3_600_000;
    expect(computeInitialTarget({ kind: 'at', at }, undefined, T0)).toEqual({ kind: 'wait', at });

    expect(computeInitialTarget({ kind: 'at', at: T0 - 1 }, undefined, T0)).toEqual({
      kind: 'wait',
      at: T0 + 2_000,
    });

    expect(computeInitialTarget({ kind: 'at', at: Number.NaN }, undefined, T0)).toEqual({
      kind: 'wait',
      at: T0 + 2_000,
    });
  });

  it('Cron → 下次触发时刻（UTC，5 字段 Unix 方言）', () => {
    // 2026-05-01T00:00Z 的"每天 21:00"下一次是当天 21:00Z
    const target = computeInitialTarget({ kind: 'cron', expr: '0 21 * * *' }, undefined, T0);
    expect(target).toEqual({ kind: 'wait', at: Date.parse('2026-05-01T21:00:00Z') });
  });

  it('Cron 解析失败 → 退出且不重试（stop）', () => {
    const target = computeInitialTarget({ kind: 'cron', expr: 'not a cron' }, undefined, T0);
    expect(target.kind).toBe('stop');
    expect(target).toMatchObject({ kind: 'stop' });
  });

  it('Every + startAt 且 count==0 → startAt', () => {
    const startAt = T0 + 600_000;
    expect(computeInitialTarget({ kind: 'every', minutes: 10, startAt }, { executionCount: 0 }, T0)).toEqual(
      { kind: 'wait', at: startAt }
    );
    // startAt 已过期 → now + 2s
    expect(
      computeInitialTarget({ kind: 'every', minutes: 10, startAt: T0 - 1 }, { executionCount: 0 }, T0)
    ).toEqual({ kind: 'wait', at: T0 + 2_000 });
  });

  it('Every 且 count==0（无 lastExecutedAt）→ now + 2s', () => {
    expect(
      computeInitialTarget({ kind: 'every', minutes: 10 }, { executionCount: 0 }, T0)
    ).toEqual({ kind: 'wait', at: T0 + 2_000 });
  });

  it('Every + lastExecutedAt（未过期）→ lastExecutedAt + interval', () => {
    const last = T0 - 60_000;
    expect(
      computeInitialTarget(
        { kind: 'every', minutes: 5 },
        { executionCount: 3, lastExecutedAt: new Date(last).toISOString() },
        T0
      )
    ).toEqual({ kind: 'wait', at: last + 5 * 60_000 });
  });

  it('Every + lastExecutedAt（已过期）→ now + 5s 补偿', () => {
    const last = T0 - 60 * 60_000;
    expect(
      computeInitialTarget(
        { kind: 'every', minutes: 5 },
        { executionCount: 3, lastExecutedAt: new Date(last).toISOString() },
        T0
      )
    ).toEqual({ kind: 'wait', at: T0 + 5_000 });
  });

  it('Every 且 count>0 但无 lastExecutedAt → now + 整段 interval', () => {
    expect(
      computeInitialTarget({ kind: 'every', minutes: 30 }, { executionCount: 2 }, T0)
    ).toEqual({ kind: 'wait', at: T0 + 30 * 60_000 });
  });

  it('past-due 补偿是 +5s（不是 +2s）', () => {
    const target = computeInitialTarget(
      { kind: 'every', minutes: 5 },
      { executionCount: 1, lastExecutedAt: new Date(T0 - 10 * 60_000).toISOString() },
      T0
    );
    expect(target).toEqual({ kind: 'wait', at: T0 + 5_000 });
  });
});

describe('scheduleFromTask / runMode / interval（Rust 同源）', () => {
  it('once → 2s 后一次；scheduled 用 dispatchAt，缺失回落 endConditions.deadline', () => {
    expect(scheduleFromTask(makeTask({ executionMode: 'once' }), T0)).toEqual({
      kind: 'at',
      at: T0 + 2_000,
    });
    expect(
      scheduleFromTask(makeTask({ executionMode: 'scheduled', dispatchAt: T0 + 10_000 }), T0)
    ).toEqual({ kind: 'at', at: T0 + 10_000 });
    expect(
      scheduleFromTask(
        makeTask({ executionMode: 'scheduled', endConditions: { deadline: T0 + 20_000, aiCanExit: true } }),
        T0
      )
    ).toEqual({ kind: 'at', at: T0 + 20_000 });
    // 都没有 → null（arm() 会报"定时模式需要设置执行时间"）
    expect(scheduleFromTask(makeTask({ executionMode: 'scheduled' }), T0)).toBeNull();
  });

  it('recurring：cronExpression 优先于 intervalMinutes；interval 下限 5、缺省 60', () => {
    expect(
      scheduleFromTask(
        makeTask({ executionMode: 'recurring', intervalMinutes: 30, cronExpression: '0 9 * * *', cronTimezone: 'Asia/Shanghai' }),
        T0
      )
    ).toEqual({ kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' });
    expect(scheduleFromTask(makeTask({ executionMode: 'recurring', intervalMinutes: 2 }), T0)).toEqual({
      kind: 'every',
      minutes: 5,
    });
    expect(scheduleFromTask(makeTask({ executionMode: 'recurring' }), T0)).toEqual({
      kind: 'every',
      minutes: 60,
    });
  });

  it('runMode 缺省矩阵：loop → single_session，其余 new_session；显式值优先', () => {
    expect(resolveRunMode(makeTask({ executionMode: 'loop' }))).toBe('single_session');
    expect(resolveRunMode(makeTask({ executionMode: 'recurring' }))).toBe('new_session');
    expect(resolveRunMode(makeTask({ executionMode: 'recurring', runMode: 'single-session' }))).toBe(
      'single_session'
    );
    expect(resolveRunMode(makeTask({ executionMode: 'loop', runMode: 'new-session' }))).toBe('new_session');
  });

  it('nextTickTarget：cron → 下次 cron；every → now + interval；at/loop → null', () => {
    expect(nextTickTarget({ kind: 'cron', expr: '0 21 * * *' }, T0)).toBe(
      Date.parse('2026-05-01T21:00:00Z')
    );
    expect(nextTickTarget({ kind: 'every', minutes: 10 }, T0)).toBe(T0 + 600_000);
    expect(nextTickTarget({ kind: 'at', at: T0 }, T0)).toBeNull();
    expect(nextTickTarget({ kind: 'loop' }, T0)).toBeNull();
  });

  it('cron 校验函数（供 S5 接线时复用）', () => {
    expect(validateCronExpression('0 9 * * *')).toBeNull();
    expect(validateCronExpression('0 9 * * *', 'Asia/Shanghai')).toBeNull();
    expect(validateCronExpression('bad expr')).not.toBeNull();
    expect(validateCronExpression('0 9 * * *', 'Not/AZone')).not.toBeNull();
    expect(validateCronExpression('')).not.toBeNull();
  });
});

// ============ 3/4. endConditions ============

describe('endConditions', () => {
  it('整块缺失 ⇒ aiCanExit 必须是 false（Rust 明确要求别 unwrap_or_default）', async () => {
    const task = makeTask({ endConditions: undefined });
    expect(effectiveEndConditions(task)).toEqual({ aiCanExit: false });

    // 字段级缺省才是 true（serde default_true 只在对象存在时生效）
    expect(effectiveEndConditions(makeTask({ endConditions: {} as never })).aiCanExit).toBe(true);
  });

  it('执行前拦一次：命中 maxExecutions 时执行器一次都不跑', async () => {
    const scheduler = makeScheduler();
    const task = await seed(
      makeTask({ endConditions: { maxExecutions: 1, aiCanExit: false } })
    );
    await setRuntime(task.id, { executionCount: 1 });

    const result = await scheduler.runTick(task.id);
    expect(result.status).toBe('end-condition');
    expect(calls).toHaveLength(0);
    // 收尾：disarm + done
    expect((await runtimeEntry(task.id))?.armed).toBe(false);
    expect((await store.get(task.id))?.status).toBe('done');
    expect((await store.readRuns(task.id))).toEqual([]);
  });

  it('执行后拦一次：跑完正好到 maxExecutions → 执行器跑 1 次后收尾', async () => {
    const scheduler = makeScheduler();
    const task = await seed(makeTask({ endConditions: { maxExecutions: 2, aiCanExit: true } }));
    await setRuntime(task.id, { executionCount: 1 });

    const result = await scheduler.runTick(task.id);
    expect(calls).toHaveLength(1);
    expect(result.status).toBe('end-condition');
    expect(result.executionCount).toBe(2);
    expect((await runtimeEntry(task.id))?.armed).toBe(false);
    expect((await store.get(task.id))?.status).toBe('done');
  });

  it('deadline 命中（执行前）', async () => {
    const scheduler = makeScheduler();
    const task = await seed(makeTask({ endConditions: { deadline: T0 - 1000, aiCanExit: true } }));
    expect(checkEndConditions(task, 0, T0)).toBe('deadline');
    const result = await scheduler.runTick(task.id);
    expect(result.status).toBe('end-condition');
    expect(calls).toHaveLength(0);
  });
});

// ============ 5. 终态即停 ============

describe('终态即停', () => {
  it('deleted / deleted / archived / stopped / blocked / done 都不再执行', async () => {
    const cases: Array<Partial<Task>> = [
      { deleted: true },
      { status: 'deleted' },
      { status: 'archived' },
      { status: 'stopped' },
      { status: 'blocked' },
      { status: 'done' },
    ];
    for (const [index, patch] of cases.entries()) {
      const scheduler = makeScheduler();
      const task = await seed(makeTask({ id: `terminal-${index}`, ...patch }));
      await setRuntime(task.id, { armed: true });
      const result = await scheduler.runTick(task.id);
      expect(result.status).toBe('terminal');
      expect((await runtimeEntry(task.id))?.armed).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });
});

// ============ 6. executing 占位 ============

describe('executing 集（同刻只允许一次执行）', () => {
  it('同刻第二次触发被跳过，第一次照常结束', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: (() => void) | undefined;
    const startedSignal = new Promise<void>((resolve) => {
      started = resolve;
    });
    const scheduler = makeScheduler({
      executor: async () => {
        started?.();
        await gate;
        return { ok: true };
      },
    });
    const task = await seed(makeTask());

    const first = scheduler.runTick(task.id);
    // 等第一轮真正占位并进入执行器（「await 一个 microtask」不够：占位前面
    // 还有好几次读盘 await，靠时序猜会偶发假阴性）。
    await startedSignal;
    const second = await scheduler.runTick(task.id);
    expect(second.status).toBe('skipped');

    release?.();
    expect((await first).status).toBe('success');
    expect(scheduler.executingSnapshot()).toEqual([]);
  });
});

// ============ 7. Ralph Loop ============

describe('Ralph Loop', () => {
  it('退避序列 3/10/30/60/120/300s', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(ralphBackoffMs)).toEqual([
      3_000, 10_000, 30_000, 60_000, 120_000, 300_000, 300_000,
    ]);
  });

  it('成功 → 每轮之间固定 3s；失败 → 按退避序列；连续 10 次失败停止', async () => {
    const scheduler = makeScheduler({
      maxLoopIterations: 30,
      executor: async (_task, payload) => {
        calls.push({ task: _task, payload });
        return { ok: false, error: 'turn 失败' };
      },
    });
    const task = await seed(makeTask({ id: 'ralph-fail', executionMode: 'loop' }));
    await scheduler.arm(task.id);
    await scheduler.idle();

    // 初始 2s + 10 次失败的退避（第 10 次失败直接停，不再睡）
    expect(sleeps).toEqual([
      2_000, 3_000, 10_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000, 300_000,
    ]);
    expect(calls).toHaveLength(10);
    // 收尾：done + 记 10 条失败 run
    const task_ = await store.get(task.id);
    expect(task_?.status).toBe('done');
    expect(await store.readRuns(task.id)).toHaveLength(10);
  });

  it('成功路径：Loop 成功 → 3s buffer 后继续', async () => {
    const scheduler = makeScheduler({ maxLoopIterations: 3 });
    const task = await seed(makeTask({ id: 'ralph-ok', executionMode: 'loop' }));
    await scheduler.arm(task.id);
    await scheduler.idle();

    // 首轮等待 2s，之后每轮 3s
    expect(sleeps).toEqual([2_000, 3_000, 3_000, 3_000]);
    expect(calls).toHaveLength(3);
  });

  it('wall-clock 轮询：长等待被切成 ≤30s 的片（睡眠/挂起后仍能到点）', async () => {
    // pollMs 回到默认 30s：初始 2s 等待是一片；一次 300s 的 Loop 退避应该被
    // 切成 10 片 —— 这正是"用 wall-clock 每 30s 重读时钟"而不是一次性
    // setTimeout(300s) 的原因（后者在系统睡眠后不可信）。
    const scheduler = makeScheduler({
      pollMs: 30_000,
      maxLoopIterations: 8,
      executor: async (_task, payload) => {
        calls.push({ task: _task, payload });
        return { ok: false, error: 'fail' };
      },
    });
    const task = await seed(makeTask({ id: 'ralph-chunk', executionMode: 'loop' }));
    await scheduler.arm(task.id);
    await scheduler.idle();

    // 每次等待都是 30s 的倍数（末片可能不足 30s）：这里初始 2s → 一片 2s，
    // 之后 3s（一片）、10s（一片）、30s（一片）、60s（两片）...
    expect(sleeps.slice(0, 5)).toEqual([2_000, 3_000, 10_000, 30_000, 30_000]);
    expect(sleeps.every((ms) => ms <= 30_000)).toBe(true);
  });
});

// ============ 8. 会话模式 ============

describe('会话模式', () => {
  it('new_session：每 tick 铸新 id，且**执行前**就已落盘到运行态', async () => {
    const seen: Array<{ payloadId: string; runtimeId: string | undefined }> = [];
    const scheduler = makeScheduler({
      executor: async (_task, payload) => {
        const entry = await runtimeEntry(payload.taskId);
        seen.push({ payloadId: payload.sessionId, runtimeId: entry?.sessionId });
        return { ok: true };
      },
    });
    const task = await seed(makeTask({ id: 'new-session', runMode: 'new-session' }));

    await scheduler.runTick(task.id);
    await scheduler.runTick(task.id);

    expect(seen).toHaveLength(2);
    expect(seen[0]!.payloadId).not.toBe(seen[1]!.payloadId);
    // 落盘先于执行：执行器看到时运行态里的 sessionId 已经是本轮的了
    expect(seen[0]!.runtimeId).toBe(seen[0]!.payloadId);
    expect(seen[1]!.runtimeId).toBe(seen[1]!.payloadId);
  });

  it('single_session：复用同一 session id，且 appendSession 幂等', async () => {
    const ids: string[] = [];
    const scheduler = makeScheduler({
      executor: async (_task, payload) => {
        ids.push(payload.sessionId);
        return { ok: true };
      },
    });
    const task = await seed(makeTask({ id: 'single-session', runMode: 'single-session' }));

    await scheduler.runTick(task.id);
    await scheduler.runTick(task.id);
    await scheduler.runTick(task.id);

    expect(new Set(ids).size).toBe(1);
    const stored = await store.get(task.id);
    expect(stored?.sessionIds).toEqual([ids[0]]);
  });
});

// ============ 9/10/11. 收尾记账 ============

describe('收尾记账', () => {
  it('成功：count++ / lastRunOk / lastExecutedAt(RFC3339) / 一条成功 run record', async () => {
    const scheduler = makeScheduler();
    const task = await seed(makeTask());
    const result = await scheduler.runTick(task.id);
    expect(result.status).toBe('success');

    const entry = await runtimeEntry(task.id);
    expect(entry?.executionCount).toBe(1);
    expect(entry?.lastRunOk).toBe(true);
    expect(typeof entry?.lastExecutedAt).toBe('string');
    const runs = await store.readRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ ok: true, content: '本轮输出' });
    // Task 行也记了最近执行时刻
    expect((await store.get(task.id))?.lastExecutedAt).toBe(clock);
  });

  it('AI 请求退出 → 不写 run record，任务收尾为 done', async () => {
    const scheduler = makeScheduler({
      executor: async (_task, payload) => {
        calls.push({ task: _task, payload });
        return { ok: true, aiRequestedExit: true, exitReason: '目标已达成' };
      },
    });
    const task = await seed(makeTask());
    const result = await scheduler.runTick(task.id);

    expect(result.status).toBe('ai-exit');
    expect(await store.readRuns(task.id)).toEqual([]);
    const stored = await store.get(task.id);
    expect(stored?.status).toBe('done');
    // AI 主动退出记 agent/cli（信任账本按这个分类）
    const last = stored?.statusHistory.at(-1);
    expect(last).toMatchObject({ to: 'done', actor: 'agent', source: 'cli', message: '目标已达成' });
  });

  it('一次性任务跑完即收尾（one-shot → done，source=endCondition）', async () => {
    const scheduler = makeScheduler();
    const task = await seed(makeTask({ id: 'one-shot', executionMode: 'once', status: 'running' }));
    const result = await scheduler.runTick(task.id);
    expect(result.status).toBe('one-shot');
    const stored = await store.get(task.id);
    expect(stored?.status).toBe('done');
    expect(stored?.statusHistory.at(-1)).toMatchObject({
      to: 'done',
      actor: 'system',
      source: 'endCondition',
      message: 'One-shot task completed',
    });
  });

  it('失败：lastRunOk=false + 失败 run record（error 截断到 2000 字符）', async () => {
    const longError = 'x'.repeat(5_000);
    const scheduler = makeScheduler({
      executor: async () => ({ ok: false, error: longError }),
    });
    const task = await seed(makeTask());
    const result = await scheduler.runTick(task.id);
    expect(result.status).toBe('failure');

    const entry = await runtimeEntry(task.id);
    expect(entry?.lastRunOk).toBe(false);
    const runs = await store.readRuns(task.id);
    expect(runs[0]?.ok).toBe(false);
    expect(runs[0]?.error).toHaveLength(2003); // 2000 + '...'
  });

  it('provider 解析失败 → 转 blocked 并 disarm', async () => {
    const scheduler = makeScheduler({
      executor: async () => ({
        ok: false,
        error: "Provider 'kimi' has no API Key — open 设置 → 模型供应商 to configure it",
      }),
    });
    const task = await seed(makeTask());
    const result = await scheduler.runTick(task.id);
    expect(result.status).toBe('blocked');

    expect((await store.get(task.id))?.status).toBe('blocked');
    const entry = await runtimeEntry(task.id);
    expect(entry?.armed).toBe(false);
    expect(entry?.exitReason).toContain('provider unavailable');
  });

  it('provider 判定只认"被删/没 key"两条（禁用不算永久失败）', () => {
    expect(isProviderResolutionFailure("Provider 'a' not found in config — x")).toBe(true);
    expect(isProviderResolutionFailure("Provider 'a' has no API Key — x")).toBe(true);
    expect(isProviderResolutionFailure("Provider 'a' is disabled — x")).toBe(false);
    expect(isProviderResolutionFailure("Provider 'a' something else")).toBe(false);
    expect(isProviderResolutionFailure('random error')).toBe(false);
    expect(isProviderResolutionFailure(undefined)).toBe(false);
  });

  it('task.md 为空 → 转 blocked（不派发空 prompt）', async () => {
    const scheduler = makeScheduler();
    const task = await seed(makeTask({ id: 'empty-md' }), '   \n  ');
    const result = await scheduler.runTick(task.id);
    expect(result.status).toBe('blocked');
    expect(result.error).toContain('task.md is empty');
    expect(calls).toHaveLength(0);
    expect((await store.get(task.id))?.status).toBe('blocked');
  });

  it('ai-aligned 任务派发 `/task-implement <id>`（不读 task.md）', async () => {
    const scheduler = makeScheduler();
    const task = await seed(makeTask({ id: 'aligned-1', dispatchOrigin: 'ai-aligned' }), '');
    await scheduler.runTick(task.id);
    expect(calls[0]!.payload.prompt).toBe('/task-implement aligned-1');
  });

  it('direct 任务派发 `执行任务：<task.md>`，并带上 aiCanExit（缺失 endConditions ⇒ false）', async () => {
    const scheduler = makeScheduler();
    const task = await seed(makeTask({ id: 'direct-1' }), '  跑通 v2.4  ');
    await scheduler.runTick(task.id);
    expect(calls[0]!.payload.prompt).toBe('执行任务：跑通 v2.4');
    expect(calls[0]!.payload.aiCanExit).toBe(false);
    expect(calls[0]!.payload.executionNumber).toBe(1);
    expect(calls[0]!.payload.isFirstExecution).toBe(true);
  });

  it('S5：派发载荷带上任务自己的工作区（不是 sidecar 启动工作区）', async () => {
    const taskWorkspace = join(dataDir, 'task-workspace');
    mkdirSync(taskWorkspace, { recursive: true });
    const scheduler = makeScheduler();
    const task = await seed(makeTask({ id: 'ws-1', workspacePath: taskWorkspace }));
    await scheduler.runTick(task.id);

    expect(calls[0]!.payload.workspacePath).toBe(taskWorkspace);
    expect(calls[0]!.payload.executionMode).toBe('recurring');
  });

  it('执行超时 → 记失败 run（Execution timed out）', async () => {
    const scheduler = makeScheduler({
      executionTimeoutMs: 1_000,
      sleep: async () => {
        // 执行器的等待不推进时钟：让超时判定依赖真实定时器
      },
      executor: () => new Promise<DispatchOutcome>(() => {}),
    });
    const task = await seed(makeTask({ id: 'timeout-1' }));
    const result = await scheduler.runTick(task.id);
    expect(result.status).toBe('failure');
    expect(result.error).toBe('Execution timed out');
    const runs = await store.readRuns(task.id);
    expect(runs[0]).toMatchObject({ ok: false, error: 'Execution timed out' });
  });
});

// ============ 12. arm / disarm / bounce / triggerNow ============

describe('arm / disarm / bounce / triggerNow 守卫', () => {
  it('arm：终态拒绝', async () => {
    const scheduler = makeScheduler();
    const task = await seed(makeTask({ id: 'arm-done', status: 'done' }));
    await expect(scheduler.arm(task.id)).rejects.toThrow(/terminal state/);
  });

  it('arm：scheduled 无 dispatchAt → 用户可读的报错', async () => {
    const scheduler = makeScheduler();
    const task = await seed(makeTask({ id: 'arm-sched', executionMode: 'scheduled' }));
    await expect(scheduler.arm(task.id)).rejects.toThrow(/定时模式需要设置执行时间/);
  });

  it('arm：写运行态 armed=true 并起 loop；disarm 置 armed=false + exitReason', async () => {
    const scheduler = makeScheduler({ maxLoopIterations: 1 });
    const task = await seed(makeTask({ id: 'arm-ok' }));
    await scheduler.arm(task.id);
    expect((await runtimeEntry(task.id))?.armed).toBe(true);
    await scheduler.idle();

    await scheduler.disarm(task.id, '手工停');
    const entry = await runtimeEntry(task.id);
    expect(entry?.armed).toBe(false);
    expect(entry?.exitReason).toBe('手工停');
  });

  it('bounce：保留 executionCount 重新上膛', async () => {
    const scheduler = makeScheduler({ maxLoopIterations: 1, executor: okExecutor() });
    const task = await seed(makeTask({ id: 'bounce-1' }));
    await scheduler.arm(task.id);
    await scheduler.idle();
    expect((await runtimeEntry(task.id))?.executionCount).toBe(1);

    await scheduler.bounce(task.id);
    expect((await runtimeEntry(task.id))?.armed).toBe(true);
    expect((await runtimeEntry(task.id))?.executionCount).toBe(1);
    await scheduler.idle();
  });

  it('triggerNow：未知任务报错；返回 sessionId 且不改 armed/schedule', async () => {
    const scheduler = makeScheduler();
    await expect(scheduler.triggerNow('nope')).rejects.toThrow(/Task not found/);

    const task = await seed(makeTask({ id: 'trigger-1' }));
    await setRuntime(task.id, { armed: false, sessionId: 'sess-x' });
    const info = await scheduler.triggerNow(task.id);
    expect(info.taskId).toBe(task.id);
    expect(info.sessionId).toBeDefined();
    await scheduler.idle();
    // 手动触发不改 armed
    expect((await runtimeEntry(task.id))?.armed).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('triggerNow：已在执行 → 报错', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = makeScheduler({
      executor: async () => {
        await gate;
        return { ok: true };
      },
    });
    const task = await seed(makeTask({ id: 'trigger-2' }));
    await scheduler.triggerNow(task.id);
    await Promise.resolve();
    await expect(scheduler.triggerNow(task.id)).rejects.toThrow(/Cannot run-now/);
    release?.();
    await scheduler.idle();
  });
});

// ============ 13/14. 启动恢复与所有权 ============

describe('启动恢复 + 所有权闸', () => {
  it('只 re-arm `running && mode != once`（含 system），Once 不收', async () => {
    // running + recurring（system，必须收）
    await seed(makeTask({ id: 'rec-system', executionMode: 'recurring', dispatchOrigin: 'system' }));
    // running + loop（收）
    await seed(makeTask({ id: 'loop-running', executionMode: 'loop' }));
    // running + once：崩溃恢复会把它改成 blocked → 不该收
    await seed(makeTask({ id: 'once-running', executionMode: 'once' }));
    // 非 running：不收
    await seed(makeTask({ id: 'todo-recurring', executionMode: 'recurring', status: 'todo' }));
    await seed(makeTask({ id: 'done-recurring', executionMode: 'recurring', status: 'done' }));
    // 已软删：不收（软删行的 status 是 'deleted'）
    await seed(
      makeTask({ id: 'deleted-recurring', executionMode: 'recurring', status: 'deleted', deleted: true })
    );

    const scheduler = makeScheduler({ maxLoopIterations: 1 });
    const report = await scheduler.initialize();
    await scheduler.idle();

    expect(report.owner).toBe('node');
    // `once-running` 在 initialize 的 load()（崩溃恢复）里被矩阵改成 blocked，
    // 因此不进候选集 —— Rust 的恢复扫描也是先 load 再筛 status=running。
    expect(report.candidates).toBe(2);
    expect(report.armed).toBe(2);
    expect(scheduler.activeLoopIds().sort()).toEqual([]); // 已跑完
  });

  it('所有权是 rust 时 initialize 不启动任何 loop', async () => {
    await seed(makeTask({ id: 'rec-1', executionMode: 'recurring' }));
    // 2.0.8 起缺省是 node；要让位必须显式声明 rust（过渡期降级路径）。
    const scheduler = makeScheduler({ env: { ZHISHI_TASK_SCHEDULER: 'rust' } });
    const report = await scheduler.initialize();
    expect(report).toEqual({ owner: 'rust', candidates: 0, armed: 0, failed: 0 });
    expect(scheduler.activeLoopIds()).toEqual([]);
    expect(await store.readRuntime()).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('classifyCompletion（Rust complete_task_after_stop 的分类）', () => {
  it('排期类原因 → system/endCondition；其余 → agent/cli', () => {
    expect(classifyCompletion(undefined)).toEqual({
      message: 'endCondition fired',
      actor: 'system',
      source: 'endCondition',
    });
    expect(classifyCompletion('One-shot task completed')).toMatchObject({
      actor: 'system',
      source: 'endCondition',
    });
    expect(classifyCompletion('endCondition: max executions')).toMatchObject({
      actor: 'system',
      source: 'endCondition',
    });
    expect(classifyCompletion('目标达成，我先退出')).toMatchObject({ actor: 'agent', source: 'cli' });
  });
});

describe('cronTurnExecutor（S5 缺省执行器：DispatchPayload ↔ /cron/execute-sync）', () => {
  const dispatch: DispatchPayload = {
    taskId: 'task-map-1',
    prompt: '执行任务：跑通 v2.4',
    sessionId: 'sess-1',
    isFirstExecution: false,
    aiCanExit: true,
    permissionMode: 'auto',
    model: 'k3',
    providerId: 'kimi',
    runtime: 'builtin',
    runtimeConfig: { permissionMode: 'auto' },
    mcpEnabledServers: ['fs'],
    runMode: 'new_session',
    intervalMinutes: 30,
    executionNumber: 4,
    workspacePath: 'F:/workspace/a',
    executionMode: 'recurring',
  };

  const task: Task = {
    id: 'task-map-1',
    name: '映射任务',
    executor: 'agent',
    workspaceId: 'ws-1',
    workspacePath: 'F:/workspace/a',
    executionMode: 'recurring',
    sessionIds: [],
    status: 'running',
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    statusHistory: [],
    dispatchOrigin: 'direct',
    deleted: false,
  };

  beforeEach(() => {
    cronMock.runCronExecuteSync.mockReset();
  });

  it('入参逐字段映射（含 workspacePath），返回值映射成 DispatchOutcome', async () => {
    cronMock.runCronExecuteSync.mockResolvedValue({
      status: 200,
      body: {
        success: true,
        aiRequestedExit: true,
        exitReason: '跑完了',
        outputText: '输出正文',
        sessionId: 'sess-returned',
      },
    });

    const outcome = await cronTurnExecutor(task, dispatch);

    expect(cronMock.runCronExecuteSync).toHaveBeenCalledTimes(1);
    expect(cronMock.runCronExecuteSync.mock.calls[0]![0]).toMatchObject({
      taskId: 'task-map-1',
      prompt: '执行任务：跑通 v2.4',
      sessionId: 'sess-1',
      isFirstExecution: false,
      aiCanExit: true,
      permissionMode: 'auto',
      model: 'k3',
      providerId: 'kimi',
      runtime: 'builtin',
      runMode: 'new_session',
      intervalMinutes: 30,
      executionNumber: 4,
      workspacePath: 'F:/workspace/a',
    });
    expect(outcome).toMatchObject({
      ok: true,
      aiRequestedExit: true,
      exitReason: '跑完了',
      outputText: '输出正文',
      sessionId: 'sess-returned',
    });
    expect(outcome.durationMs).toBeTypeOf('number');
  });

  it('空 workspacePath 不在 wire 上出现（与旧 Rust payload 同形）', async () => {
    cronMock.runCronExecuteSync.mockResolvedValue({ status: 200, body: { success: true } });
    await cronTurnExecutor(task, { ...dispatch, workspacePath: '' });
    const sent = cronMock.runCronExecuteSync.mock.calls[0]![0] as Record<string, unknown>;
    expect('workspacePath' in sent).toBe(false);
  });

  it('失败体 → ok:false 且错误串原样带回（`Provider \'` 前缀不能包装掉）', async () => {
    cronMock.runCronExecuteSync.mockResolvedValue({
      status: 400,
      body: { success: false, error: "Provider 'kimi' has no API Key — x" },
    });

    const outcome = await cronTurnExecutor(task, dispatch);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe("Provider 'kimi' has no API Key — x");
    // 前缀命中调度器的永久失败判定
    expect(isProviderResolutionFailure(outcome.error)).toBe(true);
  });

  it('非 2xx 且无 error 字段 → 兜底错误串带 HTTP 码', async () => {
    cronMock.runCronExecuteSync.mockResolvedValue({ status: 500, body: { success: false } });
    const outcome = await cronTurnExecutor(task, dispatch);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('HTTP 500');
  });
});
