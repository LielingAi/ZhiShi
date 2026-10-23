/**
 * S6 ② — `task/run` 与 `task/rerun` 的本地实现（`run-ops.ts`）。
 *
 * 语义源：`src-tauri/src/management_api.rs:409-497` + `task_scheduler.rs` 的
 * arm / disarm / reset_for_rerun。用例锁四件事：
 *   1. run 的 `todo` 守卫与派发后的 actor/source
 *   2. rerun 的四个合法前置 + `reset_for_rerun` 的清空/重铸
 *   3. 调度权在 rust 时的**降级**（迁移照做、不 arm、响应里标出来）
 *   4. 错误码仍是 `{code,message}` JSON 串（CLI/AI 靠 code 分支）
 *
 * 全部注入调度器（假执行器 + 虚拟时钟 + maxLoopIterations: 0）：arm 只写运行态
 * 不真跑 turn，所以断言不会被执行烧掉。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetMemoryStoreForTest } from '../memory/store';
import { taskRerun, taskRun, type RunOpFail, type RunOpOk, type RunOpResult } from './run-ops';
import { createTaskScheduler, type TaskScheduler } from './scheduler';
import { TaskStore, type Task, type TaskStatus } from './store';

let dataDir: string;
let store: TaskStore;
let scheduler: TaskScheduler;
let clock: number;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zhishi-run-ops-'));
  store = new TaskStore({ dataDir });
  clock = Date.parse('2026-05-01T00:00:00Z');
  scheduler = createTaskScheduler({
    store,
    now: () => clock,
    // 等待只推进虚拟时钟；maxLoopIterations:0 → arm 之后 loop 立刻退出，
    // 不会真的跑 tick（否则执行器一跑就把 executionCount 加上去了）。
    sleep: async (ms) => {
      clock += ms;
    },
    executor: async () => ({ ok: true }),
    maxLoopIterations: 0,
    env: { ZHISHI_TASK_SCHEDULER: 'node' },
  });
});

afterEach(() => {
  // 状态迁移会写信任账本（<数据目录>/memory.db）——Windows 上不先关连接会 EBUSY。
  resetMemoryStoreForTest();
  rmSync(dataDir, { recursive: true, force: true });
});

function expectOk(result: RunOpResult): RunOpOk {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result;
}

function expectFail(result: RunOpResult): RunOpFail {
  if (result.ok) throw new Error('expected failure, got ok');
  return result;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'run-task-1',
    name: '跑一次',
    executor: 'agent',
    workspaceId: 'ws-1',
    workspacePath: '',
    executionMode: 'once',
    sessionIds: [],
    status: 'todo',
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    statusHistory: [],
    dispatchOrigin: 'direct',
    deleted: false,
    ...overrides,
  };
}

async function seed(task: Task): Promise<Task> {
  await store.upsert(task);
  return task;
}

async function reload(id: string): Promise<Task> {
  const task = await store.getRaw(id);
  if (task === undefined) throw new Error('missing task');
  return task;
}

function deps(env: NodeJS.ProcessEnv = { ZHISHI_TASK_SCHEDULER: 'node' }) {
  return { store, scheduler, env };
}

describe('task/run', () => {
  it('todo → arm + running（actor=system / source=scheduler / message=dispatched）', async () => {
    await seed(makeTask());
    const ok = expectOk(await taskRun(deps(), { id: 'run-task-1' }));

    expect(ok.task.status).toBe('running');
    expect(ok.task.statusHistory.at(-1)).toMatchObject({
      from: 'todo',
      to: 'running',
      actor: 'system',
      source: 'scheduler',
      message: 'dispatched',
    });
    // 响应里标明调度权归属
    expect(ok.scheduler).toBe('node');
    // arm 写了运行态并置 armed（loop 已按 maxLoopIterations 退出，不影响断言）
    const entry = (await store.readRuntime()).find((e) => e.taskId === 'run-task-1');
    expect(entry?.armed).toBe(true);
  });

  it('非 todo → invalid_transition（文案带 rerun 建议）', async () => {
    await seed(makeTask({ status: 'done' }));
    const fail = expectFail(await taskRun(deps(), { id: 'run-task-1' }));

    expect(fail.error).toContain('invalid_transition');
    expect(fail.error).toContain("use 'zhishi task rerun run-task-1'");
    // 未落盘任何变更
    expect((await reload('run-task-1')).status).toBe('done');
  });

  it('未知 id → not_found；缺 id → 明确的入参错误', async () => {
    const missing = expectFail(await taskRun(deps(), { id: 'nope' }));
    expect(missing.error).toContain('not_found');

    const noId = expectFail(await taskRun(deps(), {}));
    expect(noId.error).toBe('task id is required');
  });

  it('arm 失败（scheduled 无 dispatchAt）→ 不迁移，状态保持 todo', async () => {
    await seed(makeTask({ executionMode: 'scheduled' }));
    const fail = expectFail(await taskRun(deps(), { id: 'run-task-1' }));

    expect(fail.error).toContain('定时模式需要设置执行时间');
    expect((await reload('run-task-1')).status).toBe('todo');
  });

  it('调度权在 rust → 降级：状态照迁移、不 arm、响应标 scheduler=rust + hint', async () => {
    await seed(makeTask());
    // 2.0.8 起缺省是 node；降级路径必须显式声明 rust。
    const ok = expectOk(await taskRun(deps({ ZHISHI_TASK_SCHEDULER: 'rust' }), { id: 'run-task-1' }));

    expect(ok.scheduler).toBe('rust');
    expect(String(ok.hint)).toContain('调度权当前在 rust');
    expect(ok.task.status).toBe('running');
    // 关键：没有 arm（运行态里不该出现这条，否则会和 Rust 双跑）
    expect((await store.readRuntime()).some((e) => e.taskId === 'run-task-1')).toBe(false);
  });

  it('路径穿越 id → 拒绝', async () => {
    const fail = expectFail(await taskRun(deps(), { id: '../../etc/passwd' }));
    expect(fail.error).toContain('taskId 非法');
  });
});

describe('task/rerun', () => {
  const fromStatuses: TaskStatus[] = ['blocked', 'stopped', 'done', 'archived'];

  for (const status of fromStatuses) {
    it(`${status} → todo → running（source=rerun 的审计在中间那步）`, async () => {
      await seed(makeTask({ status }));
      expectOk(await taskRerun(deps(), { id: 'run-task-1' }));

      const task = await reload('run-task-1');
      expect(task.status).toBe('running');
      const history = task.statusHistory.map((h) => `${h.from}→${h.to}/${h.source}`);
      expect(history).toContain(`${status}→todo/rerun`);
      expect(history).toContain('todo→running/scheduler');
    });
  }

  it('非法前置（todo）→ 明确报错，不动状态', async () => {
    await seed(makeTask({ status: 'todo' }));
    const fail = expectFail(await taskRerun(deps(), { id: 'run-task-1' }));
    expect(fail.error).toBe("rerun only valid from blocked/stopped/done/archived; current = 'todo'");
    expect((await reload('run-task-1')).status).toBe('todo');
  });

  it('重置执行计数：清 executionCount / lastRunOk / lastRunDurationMs / lastExecutedAt / exitReason，并重铸 session id', async () => {
    await seed(makeTask({ status: 'done', executionMode: 'recurring', intervalMinutes: 5 }));
    await store.updateRuntimeEntry('run-task-1', () => ({
      taskId: 'run-task-1',
      sessionId: 'old-session',
      internalSessionId: 'old-session',
      tabId: 'tab-keep',
      executionCount: 7,
      lastExecutedAt: '2026-04-30T00:00:00.000Z',
      lastRunOk: false,
      lastRunDurationMs: 999,
      exitReason: 'max executions',
      armed: true,
    }));

    expectOk(await taskRerun(deps(), { id: 'run-task-1' }));

    const entry = (await store.readRuntime()).find((e) => e.taskId === 'run-task-1');
    expect(entry?.executionCount).toBe(0);
    expect(entry?.lastExecutedAt).toBeUndefined();
    expect(entry?.lastRunOk).toBeUndefined();
    expect(entry?.lastRunDurationMs).toBeUndefined();
    expect(entry?.exitReason).toBeUndefined();
    expect(entry?.sessionId).not.toBe('old-session');
    expect(entry?.internalSessionId).toBeUndefined();
    // tabId 保留（前端绑定不该被重跑清掉），armed 由随后的 arm 决定
    expect(entry?.tabId).toBe('tab-keep');
    expect(entry?.armed).toBe(true);
  });

  it('调度权在 rust → 不 disarm / 不重置计数（由 Rust 侧自己重置），但仍迁移到 running', async () => {
    await seed(makeTask({ status: 'done' }));
    await store.updateRuntimeEntry('run-task-1', () => ({
      taskId: 'run-task-1',
      sessionId: 'old-session',
      executionCount: 3,
      armed: true,
    }));

    const ok = expectOk(await taskRerun(deps({ ZHISHI_TASK_SCHEDULER: 'rust' }), { id: 'run-task-1' }));
    expect(ok.scheduler).toBe('rust');
    expect((await reload('run-task-1')).status).toBe('running');

    const entry = (await store.readRuntime()).find((e) => e.taskId === 'run-task-1');
    // 计数与 session 原样（未替 Rust 改它内存外的状态）
    expect(entry?.executionCount).toBe(3);
    expect(entry?.sessionId).toBe('old-session');
    expect(entry?.armed).toBe(true);
  });

  it('未知 id → not_found', async () => {
    const fail = expectFail(await taskRerun(deps(), { id: 'nope' }));
    expect(fail.error).toContain('not_found');
  });
});
