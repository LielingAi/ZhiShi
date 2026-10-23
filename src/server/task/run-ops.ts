/**
 * `task/run` 与 `task/rerun` 的本地实现（S6）。
 *
 * 这两条原先转发 Rust Management API —— 应用不在时 `zhishi task run` 直接
 * `Management API not available`，而"派发任务"恰恰是最需要可用的动作。
 *
 * 语义逐条对 `src-tauri/src/management_api.rs:409-497`（task_run_handler /
 * task_rerun_handler）与 `src-tauri/src/task_scheduler.rs` 的 arm/disarm/
 * reset_for_rerun。
 *
 * **为什么单独一个文件**：调度器依赖 `ops.ts`（复用状态迁移），所以 ops 不能
 * 反向 import 调度器（depcruise no-circular）。run/rerun 同时需要两者，只能放在
 * 它们之上的一层，由 admin-api 调用。
 */

import { taskSchedulerOwner, type TaskSchedulerOwner } from './ownership';
import { taskOpError, taskUpdateStatus } from './ops';
import { getTaskScheduler, type TaskScheduler } from './scheduler';
import { assertSafeTaskId, type Task, type TaskStore } from './store';

/** run/rerun 的成功体：比通用 `{ok:true}` 多了调度权归属与降级提示。 */
export interface RunOpOk {
  ok: true;
  task: Task;
  /** 本进程是否真的接管了调度（node）还是让位给 Rust（rust）。 */
  scheduler: TaskSchedulerOwner;
  /** 降级时的可读提示（只在 scheduler==='rust' 时出现）。 */
  hint?: string;
}

export interface RunOpFail {
  ok: false;
  error: string;
}

export type RunOpResult = RunOpOk | RunOpFail;

export interface RunOpDeps {
  store: TaskStore;
  /** 注入调度器（测试用；缺省取进程内单例 —— 必须共用同一个，否则 executing 占位失效）。 */
  scheduler?: TaskScheduler;
  /** 注入 env（ownership 闸读它，默认 process.env）。 */
  env?: NodeJS.ProcessEnv;
}

/** rerun 的合法前置状态（Rust `task_rerun_handler` 的 matches! 列表）。 */
const RERUN_FROM: readonly Task['status'][] = ['blocked', 'stopped', 'done', 'archived'];

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readId(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.trim();
}

function schedulerFor(deps: RunOpDeps): TaskScheduler {
  return deps.scheduler ?? getTaskScheduler(deps.store);
}

/**
 * 降级说明（调度权在 rust 时用）。
 *
 * 为什么不是报错：状态迁移（todo→running）是用户能看到、也必须落盘的部分；
 * 调度权归属是运维事实。把它做成错误会让 CLI 打出"run 失败"，但任务其实已经
 * 进入 running —— 用户会重试、看到状态已变、彻底困惑。所以：迁移照做 +
 * 响应里标 `scheduler: 'rust'` + 一条可读 hint。
 */
const RUST_OWNER_HINT =
  '调度权当前在 rust（ZHISHI_TASK_SCHEDULER 未设为 node）：状态已按状态机迁移，但本进程未启动调度循环，' +
  '实际派发由 Rust 侧完成。';

/**
 * `task/run` —— 只在 `todo` 可用，`arm` 之后 `todo → running`
 * （actor=system / source=scheduler，Rust management_api.rs:428-446）。
 *
 * 顺序照 Rust：**先 arm 再迁移** —— arm 失败（终态 / 排期不可解析）时状态保持
 * 不动，用户看到的错误与"根本没派发"一致。
 */
export async function taskRun(deps: RunOpDeps, payload: { id?: unknown }): Promise<RunOpResult> {
  const id = readId(payload.id);
  if (id === null) return { ok: false, error: 'task id is required' };
  try {
    assertSafeTaskId(id);
  } catch (err) {
    return { ok: false, error: errText(err) };
  }

  let task: Task | undefined;
  try {
    task = await deps.store.getRaw(id);
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
  if (task === undefined) return { ok: false, error: taskOpError('not_found', `task not found: ${id}`) };

  // Rust 的原文案给了可执行建议（"改用 rerun"）；同时保留 code=invalid_transition
  // 供调用方分支 —— 两者合在一条 JSON 里。
  if (task.status !== 'todo') {
    return {
      ok: false,
      error: taskOpError(
        'invalid_transition',
        `task is in state '${task.status}'; use 'zhishi task rerun ${id}' to re-dispatch it`
      ),
    };
  }

  const owner: TaskSchedulerOwner = taskSchedulerOwner(deps.env ?? process.env);
  if (owner === 'node') {
    try {
      await schedulerFor(deps).arm(id);
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  } else {
    console.warn(`[task-run] ${id} 调度权在 rust —— 跳过 arm（避免与 Rust 双跑），仅做状态迁移`);
  }

  const transition = await taskUpdateStatus(deps.store, {
    id,
    status: 'running',
    message: 'dispatched',
    actor: 'system',
    source: 'scheduler',
  });
  if (!transition.ok) return { ok: false, error: transition.error };

  const updated = transition.task as Task;
  if (owner === 'node') return { ok: true, task: updated, scheduler: 'node' };
  return { ok: true, task: updated, scheduler: 'rust', hint: RUST_OWNER_HINT };
}

/**
 * `task/rerun` —— 从 `blocked | stopped | done | archived` 回到 `todo`，清空
 * 执行计数与会话，再走一遍 run（Rust management_api.rs:449-497）。
 *
 * 三步顺序不能换：
 *   1. `→ todo`（source=rerun，PRD §10.2.1 caller-inference 表）
 *   2. `disarm` + `reset_for_rerun`（不重置计数，maxExecutions 会在下一次 tick
 *      的"执行前检查"里立刻到期 → rerun 等于放空炮）
 *   3. 复用 run（arm + todo→running）
 */
export async function taskRerun(deps: RunOpDeps, payload: { id?: unknown }): Promise<RunOpResult> {
  const id = readId(payload.id);
  if (id === null) return { ok: false, error: 'task id is required' };
  try {
    assertSafeTaskId(id);
  } catch (err) {
    return { ok: false, error: errText(err) };
  }

  let task: Task | undefined;
  try {
    task = await deps.store.getRaw(id);
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
  if (task === undefined) return { ok: false, error: taskOpError('not_found', `task not found: ${id}`) };

  if (!RERUN_FROM.includes(task.status)) {
    return {
      ok: false,
      error: `rerun only valid from blocked/stopped/done/archived; current = '${task.status}'`,
    };
  }

  // Step 1: → todo
  const reset = await taskUpdateStatus(deps.store, {
    id,
    status: 'todo',
    message: 'rerun requested',
    actor: 'system',
    source: 'rerun',
  });
  if (!reset.ok) return { ok: false, error: `reset failed: ${reset.error}` };

  // Step 2: 清调度状态（只在 Node 拥有调度权时做 —— 否则是在替 Rust 改它内存里
  // 不认识的状态，反而制造两端不一致）。
  const owner = taskSchedulerOwner(deps.env ?? process.env);
  if (owner === 'node') {
    const scheduler = schedulerFor(deps);
    await scheduler.disarm(id, 'rerun');
    await scheduler.resetForRerun(id);
  } else {
    console.warn(`[task-run] ${id} 调度权在 rust —— 跳过 disarm/reset_for_rerun（由 Rust 侧自行重置）`);
  }

  // Step 3: 复用 run 流程（重新读盘，拿到刚写下的 todo）
  return taskRun(deps, { id });
}
