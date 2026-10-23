/**
 * 任务调度器内核（S4）—— Rust `task_scheduler.rs` 的调度面在 Node 侧的重建。
 *
 * 这一片**只做调度内核**：决定"下次何时触发、触发时该派发什么、收尾怎么记账、
 * 什么时候 disarm"。真正的执行那一跳（`/cron/execute-sync` 里的 turn 驱动）
 * 不在这里 —— 用可注入的 `DispatchExecutor`，缺省实现直接报「S5 未接线」。
 * S5 把 `src/server/cron/routes.ts` 抽成 `runCronExecuteSync` 后注入即可。
 *
 * 权威语义逐条对 `src-tauri/src/task_scheduler.rs`，注释里标了行号方便对照。
 *
 * 三条纪律（与 Rust 一致或有意为之）：
 *
 * 1. **wall-clock 轮询，不用纯 monotonic 定时**：`sleepUntil()` 每 ≤30s 醒一次
 *    重读 `now()`。macOS 睡眠后 monotonic 时钟暂停，只用 `setTimeout(剩余毫秒)`
 *    会把"睡了 8 小时"当成"什么都没发生"，漏掉睡眠期间所有该触发的时刻。
 *    Rust 同名函数 `sleep_until_wallclock`（task_scheduler.rs:269）。
 * 2. **每 tick 重读 Task**：配置（model / provider / permission / runtime /
 *    mcp / name / prompt）改了立刻生效，不缓存快照。
 * 3. **不广播 SSE**：`task:*` 事件从未在 Node 侧注册（GUI 已删），未注册事件
 *    在 `sse.ts` 是 fail-closed + 告警，`sse-whitelist-crosscheck` 会变红。
 *    TUI 自己拉，不靠广播。
 *
 * 已知差一处（S5 才补）：`TODO(S5)` 处是执行器接线与 AbortSignal（超时后 JS 无法
 * 取消已在跑的 promise，只能丢弃结果）。
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  isTransitionLegal,
  taskAppendSession,
  taskUpdateStatus,
  type TaskOpResult,
} from './ops';
import { nextCronFire } from './cron';
import { taskSchedulerOwner } from './ownership';
import {
  assertSafeTaskId,
  createTaskStore,
  toEpochMs,
  toRfc3339,
  type Task,
  type TaskEndConditions,
  type TaskExecutionMode,
  type TaskRuntimeEntry,
  type TaskStatus,
  type TaskStore,
  type TransitionSource,
} from './store';

// ============ 常量（Rust 同名常量/字面量） ============

/** wall-clock 轮询粒度（Rust `sleep_until_wallclock` 的 `POLL_SECS = 30`）。 */
export const WALL_CLOCK_POLL_MS = 30_000;

/** 单次执行超时（Rust `Duration::from_secs(3600)`，task_scheduler.rs:1650）。 */
export const EXECUTION_TIMEOUT_MS = 60 * 60_000;

/** 首次触发/一次性任务的启动缓冲：躲过时钟抖动（Rust `now + 2s`）。 */
export const START_DELAY_MS = 2_000;

/** 已过期（睡眠补偿）情形的最小前移量（Rust `now + 5s`）。 */
export const PAST_DUE_COMPENSATION_MS = 5_000;

/** Ralph Loop 成功后的固定缓冲（Rust `now + 3s`）。 */
export const RALPH_SUCCESS_DELAY_MS = 3_000;

/** Ralph Loop 连续失败上限（Rust `>= 10` 停止）。 */
export const RALPH_MAX_CONSECUTIVE_FAILURES = 10;

/** 执行历史里 content/error 的截断长度（Rust `MAX_CONTENT_LEN`）。 */
export const RUN_TEXT_MAX_CHARS = 2000;

/** 终态集合：进这些状态就不再触发（Rust start_scheduler 的 iteration-top 检查）。 */
const TERMINAL_STATUSES: readonly TaskStatus[] = ['deleted', 'archived', 'stopped', 'blocked', 'done'];

/** 一个任务的调度描述（Rust `TaskSchedule`）。时间一律是 epoch 毫秒，便于注入时钟。 */
export type TaskSchedule =
  | { kind: 'at'; at: number }
  | { kind: 'every'; minutes: number; startAt?: number }
  | { kind: 'cron'; expr: string; tz?: string }
  | { kind: 'loop' };

/** 初始目标（Rust start_scheduler 里的 `initial_target` 矩阵）。 */
export type InitialTarget =
  | { kind: 'wait'; at: number }
  /** cron 解析失败：Rust 是 `active_schedulers.remove(); return;` —— 退出且不重试。 */
  | { kind: 'stop'; reason: string };

/**
 * 执行器注入点。**注意命名**：这里叫 `DispatchExecutor`，因为 store 里已有
 * `TaskExecutor`（'user' | 'agent' 那个枚举）；语义上它就是任务书里的
 * `TaskExecutor = (task, dispatch) => Promise<DispatchOutcome>`。
 */
export type DispatchExecutor = (task: Task, dispatch: DispatchPayload) => Promise<DispatchOutcome>;

/** 派发载荷：字段名与 `/cron/execute-sync` 的 body 一致，S5 可直接透传。 */
export interface DispatchPayload {
  taskId: string;
  /** 首个消息（PRD §9.3.1）：ai-aligned → `/task-implement <id>`；其余 → `执行任务：<task.md>`。 */
  prompt: string;
  sessionId: string;
  isFirstExecution: boolean;
  /** endConditions 整块缺失时是 **false**（见 `effectiveEndConditions`）。 */
  aiCanExit: boolean;
  permissionMode: string;
  model?: string;
  providerId?: string;
  runtime?: string;
  runtimeConfig?: Task['runtimeConfig'];
  mcpEnabledServers?: string[];
  runMode: 'single_session' | 'new_session';
  intervalMinutes: number;
  executionNumber: number;
  workspacePath: string;
  executionMode: TaskExecutionMode;
}

/** 执行器回执（`/cron/execute-sync` 的 response 形状 + 可选 durationMs）。 */
export interface DispatchOutcome {
  ok: boolean;
  aiRequestedExit?: boolean;
  exitReason?: string;
  outputText?: string;
  error?: string;
  durationMs?: number;
  sessionId?: string;
}

/** 单次 tick 的结果。循环据此决定"下一步等多久 / 是否退出"。 */
export interface TickResult {
  taskId: string;
  status:
    | 'success'
    | 'failure'
    | 'timeout'
    | 'skipped'
    | 'terminal'
    /** AI 明确请求退出（TERMINAL_STOP_SENTINEL 语义）：不写 run record，按 one-shot 收尾。 */
    | 'ai-exit'
    | 'one-shot'
    | 'end-condition'
    /** 派发前就失败（task.md 空/missing、provider 解析失败）→ 已转 blocked。 */
    | 'blocked';
  error?: string;
  executionCount?: number;
  /**
   * Ralph Loop 的下一次等待（成功 3s / 失败退避）。非 Loop 模式不填。
   * 循环用它，测试直接断言它。
   */
  nextDelayMs?: number;
  /** Loop 模式连续失败次数（成功归零）。 */
  consecutiveFailures?: number;
}

export interface SchedulerOptions {
  store: TaskStore;
  /** 注入时钟（ms）。测试用它把虚拟时间推快。 */
  now?: () => number;
  /** 注入等待。测试传"把虚拟时钟往前拨"的实现即可让循环瞬间跑完。 */
  sleep?: (ms: number) => Promise<void>;
  /** 注入执行器；缺省是「S5 未接线」的失败实现。 */
  executor?: DispatchExecutor;
  /** wall-clock 轮询粒度（默认 30s；测试可缩小）。 */
  pollMs?: number;
  /** 单次执行超时（默认 60 分钟）。 */
  executionTimeoutMs?: number;
  /** 测试用：每个 loop 最多跑几轮（生产不设 = 无限）。 */
  maxLoopIterations?: number;
  /** 注入 env（ownership 闸读它，默认 process.env）。 */
  env?: NodeJS.ProcessEnv;
}

export interface InitializeReport {
  /** 谁拥有调度。`off` = 显式关闭（只保留手动 task run）。 */
  owner: 'node' | 'rust' | 'off';
  /** 是否需要 re-arm 的候选（status=running 且 mode != once，含 system）。 */
  candidates: number;
  armed: number;
  failed: number;
}

// ============ cron（croner，实现在叶子模块 ./cron） ============

// 解析放在叶子模块 ./cron：调度器依赖 ops（复用状态迁移），而 ops 也要用 cron
// 校验，留在本文件会让 ops → scheduler 成环。这里 re-export 保持调度器公共面不变。
export { nextCronFire, validateCronExpression } from './cron';

// ============ 从 Task 推导调度 ============

/**
 * Task → 调度描述（照 Rust `schedule_from_task`，task_scheduler.rs:384-427）。
 *
 * - `once` → 2s 后一次（躲时钟抖动），跑完即收尾
 * - `scheduled` → `dispatchAt`，回落 legacy `endConditions.deadline`；都没有 →
 *   `null`（arm() 会把它变成用户可见的"定时模式需要设置执行时间"）
 * - `recurring` → `cronExpression` 优先，否则 `intervalMinutes`（`.max(5)`，缺省 60）
 * - `loop` → Ralph Loop（不看时间）
 */
export function scheduleFromTask(task: Task, now: number): TaskSchedule | null {
  switch (task.executionMode) {
    case 'once':
      return { kind: 'at', at: now + START_DELAY_MS };
    case 'scheduled': {
      const at = task.dispatchAt ?? task.endConditions?.deadline;
      if (typeof at !== 'number' || !Number.isFinite(at)) return null;
      return { kind: 'at', at };
    }
    case 'recurring': {
      const expr = task.cronExpression?.trim();
      if (expr !== undefined && expr !== '') {
        const tz = task.cronTimezone?.trim();
        return { kind: 'cron', expr, ...(tz !== undefined && tz !== '' ? { tz } : {}) };
      }
      const minutes = Math.max(5, task.intervalMinutes ?? 60);
      return { kind: 'every', minutes };
    }
    case 'loop':
      return { kind: 'loop' };
  }
}

/** 运行模式（Rust `resolve_run_mode`，task_scheduler.rs:428-452）：loop 缺省单会话，其余新会话。 */
export function resolveRunMode(task: Task): 'single_session' | 'new_session' {
  if (task.runMode === 'new-session') return 'new_session';
  if (task.runMode === 'single-session') return 'single_session';
  return task.executionMode === 'loop' ? 'single_session' : 'new_session';
}

/**
 * 生效的结束条件（Rust `effective_end_conditions`，task_scheduler.rs:453-462）。
 *
 * **`endConditions` 整块缺失 ⇒ `aiCanExit = false`**。这不是笔误：
 * `TaskEndConditions` 自己的 serde 默认值（字段缺省时）才是 `true`，而"整个
 * 对象缺失"在旧引擎里走 `EndConditions::default()`（derived default = false）。
 * Rust 源码里专门写了「Do not simplify this to `unwrap_or_default()`」——
 * 简化了就会让"以前不能自己退出的任务"静默获得退出权。
 */
export function effectiveEndConditions(task: Task): TaskEndConditions {
  const ec = task.endConditions;
  // 整块缺失 → false。这一条是 Rust 特意标注"不要简化"的语义。
  if (ec === undefined) return { aiCanExit: false };
  // 对象在、字段缺 → serde 的 default_true（Rust `#[serde(default = "default_true")]`）。
  // Node 侧从盘上读回来时 parse 已经补过默认值，这里再兜一次是为了吃"调用方
  // 手搓的 Task 对象"，免得 payload 里出现 `aiCanExit: undefined`。
  return { ...ec, aiCanExit: ec.aiCanExit !== false };
}

/** 执行前/后各查一次（Rust `check_end_conditions`，task_scheduler.rs:1906）。 */
export function checkEndConditions(
  task: Task,
  executionCount: number,
  now: number
): 'deadline' | 'max-executions' | null {
  const ec = effectiveEndConditions(task);
  if (typeof ec.deadline === 'number' && now >= ec.deadline) return 'deadline';
  if (typeof ec.maxExecutions === 'number' && executionCount >= ec.maxExecutions) return 'max-executions';
  return null;
}

/** 载荷里的 interval 分钟数（Rust `interval_minutes_for_payload`）。 */
export function intervalMinutesForPayload(schedule: TaskSchedule): number {
  return schedule.kind === 'every' ? Math.max(5, schedule.minutes) : 60;
}

/**
 * initial_target 矩阵（Rust start_scheduler 的 `initial_target` 计算，
 * task_scheduler.rs:1380-1470）。逐行：
 *
 * | 情形 | 目标 |
 * |---|---|
 * | Loop | now + 2s |
 * | At（scheduled / once） | `at`；已过期 → now + 2s |
 * | Cron | 下次 cron 时刻；解析失败 → stop（不重试） |
 * | Every + startAt 且 count==0 | startAt（已过期 → now + 2s） |
 * | Every 且 count==0 | now + 2s |
 * | Every 且有 lastExecutedAt | last + interval；已过期 → now + 5s（睡眠补偿） |
 * | Every 且无 lastExecutedAt（count>0） | now + 整段 interval |
 */
export function computeInitialTarget(
  schedule: TaskSchedule,
  entry: Pick<TaskRuntimeEntry, 'executionCount' | 'lastExecutedAt'> | undefined,
  now: number
): InitialTarget {
  const executionCount = entry?.executionCount ?? 0;
  const lastExecutedAt = toEpochMs(entry?.lastExecutedAt ?? null);

  if (schedule.kind === 'loop') return { kind: 'wait', at: now + START_DELAY_MS };

  if (schedule.kind === 'at') {
    if (!Number.isFinite(schedule.at)) return { kind: 'wait', at: now + START_DELAY_MS };
    return { kind: 'wait', at: schedule.at > now ? schedule.at : now + START_DELAY_MS };
  }

  if (schedule.kind === 'cron') {
    const next = nextCronFire(schedule.expr, schedule.tz, now);
    if (next === null) {
      return { kind: 'stop', reason: `invalid cron expression '${schedule.expr}' (tz=${schedule.tz ?? 'UTC'})` };
    }
    return { kind: 'wait', at: next };
  }

  // Every
  const intervalMs = Math.max(5, schedule.minutes) * 60_000;
  if (schedule.startAt !== undefined && executionCount === 0) {
    return {
      kind: 'wait',
      at: schedule.startAt > now ? schedule.startAt : now + START_DELAY_MS,
    };
  }
  if (executionCount === 0 && lastExecutedAt === null) {
    return { kind: 'wait', at: now + START_DELAY_MS };
  }
  if (lastExecutedAt !== null) {
    const next = lastExecutedAt + intervalMs;
    // 已过期 = 进程睡眠/停机期间错过的那次。Rust 补 5s（不是 2s）——
    // 5s 的窗口让"刚醒来的第一轮"避开同时启动的一堆定时器抖动。
    return { kind: 'wait', at: next > now ? next : now + PAST_DUE_COMPENSATION_MS };
  }
  return { kind: 'wait', at: now + intervalMs };
}

/**
 * 一次 tick 之后下一个时间型目标（Loop 与 At 不走这里）。
 * Rust 的循环底部：cron → 下次 cron；every → `now + interval`。
 * `null` = 没有可解析的下一跳 → 循环退出。
 */
export function nextTickTarget(schedule: TaskSchedule, now: number): number | null {
  if (schedule.kind === 'cron') return nextCronFire(schedule.expr, schedule.tz, now);
  if (schedule.kind === 'every') return now + Math.max(5, schedule.minutes) * 60_000;
  return null;
}

/** Ralph Loop 失败退避序列（Rust `match n {1=>3,2=>10,3=>30,4=>60,5=>120,_=>300}`）。 */
export function ralphBackoffMs(consecutiveFailures: number): number {
  switch (consecutiveFailures) {
    case 1:
      return 3_000;
    case 2:
      return 10_000;
    case 3:
      return 30_000;
    case 4:
      return 60_000;
    case 5:
      return 120_000;
    default:
      return 300_000;
  }
}

// ============ 派发 prompt / provider 失败判定 ============

/** 派发 prompt 构造失败（→ Task 转 blocked + 记一次失败 run）。 */
export class DispatchPromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchPromptError';
  }
}

/**
 * 构造首个消息（照 Rust `task::build_dispatch_prompt` / `compose_dispatch_prompt`，
 * task.rs:2100-2160）：
 *   - `ai-aligned` → `/task-implement <id>`（技能自己去找四份对齐文档）
 *   - `direct` / `system` → 读 `task.md`，`执行任务：<正文>`
 *
 * 空正文/缺文件都是**错误**（Rust 同样返回 Err → 调用方把任务转 blocked），
 * 不是"派发个空 prompt 试试"。
 */
export function buildDispatchPrompt(store: TaskStore, task: Task): string {
  if (task.dispatchOrigin === 'ai-aligned') return `/task-implement ${task.id}`;
  const path = store.docPath(task.id, 'task');
  let body: string;
  try {
    body = readFileSync(path, 'utf-8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new DispatchPromptError(`Failed to read task.md for ${task.id} (${path}): ${reason}`);
  }
  const trimmed = body.trim();
  if (trimmed === '') {
    throw new DispatchPromptError(`task.md is empty for direct-dispatch task ${task.id}`);
  }
  return `执行任务：${trimmed}`;
}

/**
 * provider 解析失败判定（Rust task_scheduler.rs:2216-2230）。
 *
 * 只认两条：provider 被删（`not found in config`）/ 没配 key（`has no API Key`）。
 * 「provider 被禁用（`is disabled`）」**不在**这个名单里 —— 那是可恢复状态
 * （用户重新启用即可），Rust 也让它继续按排期重试，别顺手扩进来。
 */
export function isProviderResolutionFailure(message: string | undefined): boolean {
  if (typeof message !== 'string') return false;
  if (!message.startsWith("Provider '")) return false;
  return message.includes('not found in config') || message.includes('has no API Key');
}

// ============ 缺省执行器（S5：真的跑 turn） ============

/**
 * 缺省执行器：把一 tick 派发给 `runCronExecuteSync`（`cron/routes.ts` 的编排
 * 函数，HTTP 壳与调度器共用同一个实现）。
 *
 * 为什么用**动态 import**：`cron/routes.ts` 会把 agent-session / chat-engine /
 * SessionStore / memory 蒸馏整张图拉进来。静态 import 会让"只想读一下任务索引"
 * 的路径也背上这份冷启动成本；动态 import 只在真要执行时才付。
 *
 * 仍然受 `taskSchedulerOwner()==='node'` 闸约束 —— 闸在 `initialize()`，本函数
 * 不重复判（只在闸放行之后才会被调到）。
 */
export const cronTurnExecutor: DispatchExecutor = async (task, dispatch) => {
  const startedAt = Date.now();
  const { runCronExecuteSync } = await import('../cron/routes');
  const result = await runCronExecuteSync({
    taskId: dispatch.taskId,
    // 注意：调度器给的 prompt 已经是完整首消息（`执行任务：…` / `/task-implement …`），
    // 路由会再包一层 <system-reminder><CRON_TASK>…，与旧 Rust 链路同形。
    prompt: dispatch.prompt,
    sessionId: dispatch.sessionId,
    isFirstExecution: dispatch.isFirstExecution,
    aiCanExit: dispatch.aiCanExit,
    // DispatchPayload 里这些是宽类型（string），路由侧是窄 union —— 边界处收窄，
    // 值本身来自 Task 行（写路径已按同样的枚举校验过）。
    permissionMode: dispatch.permissionMode === '' ? undefined : (dispatch.permissionMode as CronPayload['permissionMode']),
    model: dispatch.model,
    providerId: dispatch.providerId,
    runtime: dispatch.runtime as CronPayload['runtime'],
    runtimeConfig: dispatch.runtimeConfig as CronPayload['runtimeConfig'],
    runMode: dispatch.runMode,
    intervalMinutes: dispatch.intervalMinutes,
    executionNumber: dispatch.executionNumber,
    // S5 核心：任务自己的工作区。空串**不发送**（路由侧把"缺字段"和"空串"
    // 当同一件事：回落 sidecar 启动工作区 + warn），这样旧 Rust 调度器发的
    // payload 与新调度器发的在 wire 上同形。
    ...(dispatch.workspacePath ? { workspacePath: dispatch.workspacePath } : {}),
  });

  const durationMs = Date.now() - startedAt;
  const body = result.body;
  if (body.success !== true) {
    return {
      ok: false,
      // 错误串原样带回：`Provider '…' has no API Key` 这类前缀是调度器判定
      // "永久失败 → 转 blocked" 的依据，不能包装掉。
      error: typeof body.error === 'string' ? body.error : `cron execute-sync failed (HTTP ${result.status})`,
      durationMs,
    };
  }
  return {
    ok: true,
    ...(body.aiRequestedExit === true ? { aiRequestedExit: true } : {}),
    ...(typeof body.exitReason === 'string' ? { exitReason: body.exitReason } : {}),
    ...(typeof body.outputText === 'string' ? { outputText: body.outputText } : {}),
    ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
    durationMs,
  };
};

/** 仅用于上面的类型收窄（避免把 routes 的类型图静态拉进来）。 */
type CronPayload = import('../cron/routes').CronExecutePayload;

// ============ 小工具 ============

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 按**码点**截断（Rust 按 UTF-8 边界截），超长补省略号。 */
function truncateText(text: string, max = RUN_TEXT_MAX_CHARS): string {
  const points = [...text];
  if (points.length <= max) return text;
  return `${points.slice(0, max).join('')}...`;
}

function isTerminal(task: Task): boolean {
  return task.deleted || TERMINAL_STATUSES.includes(task.status);
}

/** 缺省 sleep：`setTimeout` + **unref**（不阻进程退出；用例要求）。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** 初始会话 id（Rust `initial_session_id_for`，task_scheduler.rs:1237）。 */
function initialSessionIdFor(task: Task): string {
  const preselected = task.preselectedSessionId?.trim();
  if (preselected !== undefined && preselected !== '' && resolveRunMode(task) === 'single_session') {
    return preselected;
  }
  return randomUUID();
}

/**
 * `complete_task_after_stop` 的退出原因分类（Rust task_scheduler.rs:2315-2370）：
 * 凡是"排期/结束条件"类原因都记 system/endCondition，其余当 AI 主动退出记
 * agent/cli。分类错了会写歪审计（信任账本的 +2/+1 也跟着歪）。
 */
export function classifyCompletion(reason: string | undefined): {
  message: string;
  actor: 'system' | 'agent';
  source: TransitionSource;
} {
  if (reason === undefined) {
    return { message: 'endCondition fired', actor: 'system', source: 'endCondition' };
  }
  const low = reason.toLowerCase();
  if (
    low.includes('one-shot') ||
    low.includes('max executions') ||
    low.includes('deadline') ||
    low.includes('endcondition')
  ) {
    return { message: reason, actor: 'system', source: 'endCondition' };
  }
  return { message: reason, actor: 'agent', source: 'cli' };
}

// ============ 内核 ============

/**
 * 任务调度器内核。
 *
 * 状态分两处：
 * - **运行态**（`task_runtime.json`）是真相，每次读改写都过 store 的锁 ——
 *   不在内存里缓存一份再整份写回。缓存会让"另一个进程删掉的条目"复活，也会
 *   和 S3 的 delete 清理打架。
 * - **loop 存活 + executing 占位 + 代数（generation）** 是进程内状态。
 */
export class TaskScheduler {
  private readonly store: TaskStore;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly executor: DispatchExecutor;
  private readonly pollMs: number;
  private readonly executionTimeoutMs: number;
  private readonly maxLoopIterations?: number;
  private readonly env: NodeJS.ProcessEnv;

  /** 进程内：任务 id → 正在跑的 loop promise（测试可 await）。 */
  private readonly loops = new Map<string, Promise<void>>();
  /** 进程内：任务 id → 该 loop 的代数。arm 递增，旧 loop 到点自行退出。 */
  private readonly generations = new Map<string, number>();
  /** 进程内：原子占位集合（同一 taskId 同刻只允许一次执行）。 */
  private readonly executing = new Set<string>();
  /** 进程内：fire-and-forget 的 triggerNow 任务，测试可 await。 */
  private readonly inflight = new Set<Promise<void>>();
  /** 全局停机（shutdown）。 */
  private stopping = false;

  constructor(options: SchedulerOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.executor = options.executor ?? cronTurnExecutor;
    this.pollMs = options.pollMs ?? WALL_CLOCK_POLL_MS;
    this.executionTimeoutMs = options.executionTimeoutMs ?? EXECUTION_TIMEOUT_MS;
    this.maxLoopIterations = options.maxLoopIterations;
    this.env = options.env ?? process.env;
  }

  // ---- 启动 ----

  /**
   * 启动调度：先过所有权闸，再把所有 `running && mode != once` 的任务重新
   * arm 起来（Rust `recover_running_tasks`，task_scheduler.rs:2771）。
   *
   * **所有权闸**：`taskSchedulerOwner() !== 'node'` 时一行日志让位，不启动任何
   * loop —— 迁移期 Rust 也在跑，双跑会让同一个任务被两套节律各 tick 一遍。
   */
  async initialize(): Promise<InitializeReport> {
    const owner = taskSchedulerOwner(this.env);
    if (owner !== 'node') {
      // rust = 过渡期显式降级（还要跑旧 Tauri 安装包时）；off = 只保留手动 run。
      console.log(
        owner === 'rust'
          ? '[task-scheduler] 调度权显式让给 rust（ZHISHI_TASK_SCHEDULER=rust）——本进程不启动任何调度 loop'
          : '[task-scheduler] 调度已显式关闭（ZHISHI_TASK_SCHEDULER=off）——本进程不启动任何调度 loop'
      );
      return { owner, candidates: 0, armed: 0, failed: 0 };
    }

    const tasks = await this.store.load();
    // 恢复扫描必须包含系统任务（蒸馏弧隐于用户列表但必须在场），所以这里
    // 直接用 store.load()（不过 admin-api 的用户视图过滤）。
    const candidates = tasks.filter(
      (task) => !task.deleted && task.status === 'running' && task.executionMode !== 'once'
    );
    let armed = 0;
    let failed = 0;
    for (const task of candidates) {
      try {
        await this.arm(task.id);
        armed += 1;
      } catch (err) {
        failed += 1;
        console.warn(`[task-scheduler] 恢复 ${task.id} 失败：${errText(err)}`);
      }
    }
    console.log(
      `[task-scheduler] 启动恢复：${candidates.length} 条 running（mode != once）任务，arm ${armed} 条，失败 ${failed} 条`
    );
    return { owner, candidates: candidates.length, armed, failed };
  }

  // ---- arm / disarm / bounce ----

  /**
   * 武装一条任务（Rust `arm`，task_scheduler.rs:953-1007）：终态拒绝、排期
   * 不可解析拒绝、运行态条目 upsert（保留历史计数器）并起 loop（幂等）。
   */
  async arm(taskId: string): Promise<void> {
    assertSafeTaskId(taskId);
    const task = await this.store.getRaw(taskId);
    if (task === undefined) throw new Error(`task not found: ${taskId}`);
    if (isTerminal(task)) {
      throw new Error(`task ${taskId} is in terminal state '${task.status}'; cannot arm scheduler`);
    }
    if (scheduleFromTask(task, this.now()) === null) {
      throw new Error(
        task.executionMode === 'scheduled'
          ? '定时模式需要设置执行时间（dispatchAt），请在编辑面板中填写。'
          : `task ${taskId} has no resolvable schedule`
      );
    }

    await this.store.updateRuntimeEntry(taskId, (entry) => ({
      ...(entry ?? this.newEntry(task)),
      armed: true,
      // exitReason 是"上次为什么停"，重新武装后不再代表现状。
      exitReason: undefined,
    }));

    this.startLoop(taskId);
  }

  /**
   * 解除武装（Rust `disarm_core`，task_scheduler.rs:1043）：置代数中断 +
   * `armed=false` + 退出 executing 占位。
   *
   * 不碰 Task 自身状态 —— 那是调用方（状态迁移）的事。幂等。
   */
  async disarm(taskId: string, reason?: string): Promise<void> {
    assertSafeTaskId(taskId);
    this.bumpGeneration(taskId);
    this.executing.delete(taskId);
    await this.store.updateRuntimeEntry(taskId, (entry) =>
      entry === undefined ? null : { ...entry, armed: false, ...(reason !== undefined ? { exitReason: reason } : {}) }
    );
    this.logDisarmed(taskId, reason);
  }

  private logDisarmed(taskId: string, reason?: string): void {
    console.log(`[task-scheduler] disarm ${taskId}${reason !== undefined ? `（${reason}）` : ''}`);
  }

  /**
   * 排期改了要"重新上膛"（Rust `bounce` = disarm + 若 running 再 arm）：
   * loop 当前的 sleep target 是按老排期算的，不打断就会按旧节律触发。
   * executionCount 天然保留（运行态条目不被重置）。
   */
  async bounce(taskId: string): Promise<void> {
    await this.disarm(taskId, 'schedule changed');
    const task = await this.store.getRaw(taskId);
    if (task === undefined || isTerminal(task)) return;
    if (task.status !== 'running') return;
    try {
      await this.arm(taskId);
    } catch (err) {
      console.warn(`[task-scheduler] bounce 重新 arm ${taskId} 失败：${errText(err)}`);
    }
  }

  /**
   * 重跑前把执行计数与会话清干净（Rust `reset_for_rerun`，task_scheduler.rs:1009-1032）。
   *
   * 为什么必须先重置再 arm：`endConditions.maxExecutions` 是拿 `executionCount`
   * 判的 —— 不归零，一条已经跑满额度的任务 rerun 之后会在第一次 tick 的
   * "执行前检查"里立刻被判到期、直接收尾，用户看到"rerun 了但什么都没跑"。
   *
   * 保留：`tabId`（前端绑定）与 `armed`（随后由 arm 决定）；session id 重铸成
   * `initialSessionIdFor(task)`（single-session 可能复用 preselectedSessionId）。
   */
  async resetForRerun(taskId: string): Promise<void> {
    assertSafeTaskId(taskId);
    const task = await this.store.getRaw(taskId);
    if (task === undefined) return;
    await this.store.updateRuntimeEntry(taskId, (entry) => {
      // 没有运行态条目 → 无需重置（arm 会新建一条干净的）。
      if (entry === undefined) return null;
      return {
        ...entry,
        executionCount: 0,
        lastExecutedAt: undefined,
        lastRunOk: undefined,
        lastRunDurationMs: undefined,
        exitReason: undefined,
        sessionId: initialSessionIdFor(task),
        internalSessionId: undefined,
      };
    });
  }

  /**
   * 手动立即跑一次（Rust `trigger_now`，task_scheduler.rs:2382）：不改
   * armed / 不改排期；已在执行 → 报错。
   *
   * 返回**立即**返回（fire-and-forget），与 Rust 一致：S5 的 `task/run` 要让
   * CLI 立刻拿到 sessionId，不能等 60 分钟。执行结果进 runtime / run 历史。
   */
  async triggerNow(taskId: string): Promise<{ taskId: string; sessionId: string; dispatchedAt: string }> {
    assertSafeTaskId(taskId);
    const task = await this.store.getRaw(taskId);
    if (task === undefined) throw new Error(`Task not found: ${taskId}`);
    if (isTerminal(task)) throw new Error(`task ${taskId} is in terminal state '${task.status}'`);

    if (!this.reserveExecuting(taskId)) {
      throw new Error(
        `Cannot run-now: a scheduled tick or earlier run-now is firing for ${taskId} this instant. Wait for it to finish (typically <60s).`
      );
    }

    let sessionId: string;
    try {
      const entry = await this.getEntry(taskId);
      sessionId = entry?.sessionId ?? initialSessionIdFor(task);
      // 没有运行态条目也要有一条（触发后要按 tick 记账）。
      if (entry === undefined) {
        await this.store.updateRuntimeEntry(taskId, () => ({ ...this.newEntry(task), sessionId }));
      }
    } catch (err) {
      this.executing.delete(taskId);
      throw err;
    }

    const dispatchedAt = toRfc3339(this.now());
    const run: Promise<void> = this.runTick(taskId, { manual: true })
      .then(() => undefined)
      .catch((err) => {
        console.error(`[task-scheduler] triggerNow ${taskId} 异常：${errText(err)}`);
      })
      .finally(() => {
        this.executing.delete(taskId);
        this.inflight.delete(run);
      });
    this.inflight.add(run);

    return { taskId, sessionId, dispatchedAt };
  }

  /**
   * 停机：置全局标记 + 让所有 loop 的代数失效。**不等待** —— loop 会在下一次
   * wall-clock poll（≤ pollMs）内自行退出，进程退出不该被它拖住。
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const taskId of [...this.loops.keys()]) this.bumpGeneration(taskId);
    console.log('[task-scheduler] shutdown 已发出——各 loop 将在下一次轮询内退出');
  }

  // ---- 查询 / 诊断 ----

  /** 运行态快照（诊断/S5 的 view 用）。 */
  async listRuntime(): Promise<TaskRuntimeEntry[]> {
    return this.store.readRuntime();
  }

  /** 某任务"下一次触发时刻"（RFC3339）；未 armed / 无排期 → undefined。 */
  async nextExecutionFor(taskId: string): Promise<string | undefined> {
    const task = await this.store.getRaw(taskId);
    if (task === undefined) return undefined;
    const entry = await this.getEntry(taskId);
    if (entry === undefined || !entry.armed) return undefined;
    const schedule = scheduleFromTask(task, this.now());
    if (schedule === null) return undefined;
    const target = computeInitialTarget(schedule, entry, this.now());
    if (target.kind === 'stop') return undefined;
    return toRfc3339(target.at);
  }

  /** 正在执行的任务 id（诊断用）。 */
  executingSnapshot(): string[] {
    return [...this.executing];
  }

  /** 当前挂着 loop 的任务 id（诊断/测试用）。 */
  activeLoopIds(): string[] {
    return [...this.loops.keys()];
  }

  /** 等所有 loop / 手动触发跑完（**测试与诊断用**；生产里 loop 是长期的，别调）。 */
  async idle(): Promise<void> {
    for (;;) {
      const pending = [...this.loops.values(), ...this.inflight];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  // ---- 单次 tick ----

  /**
   * 跑一次 tick（Rust 循环体里"从 executing 占位到收尾记账"那一段）。
   *
   * 顺序照 Rust：终态检查 → 排期重算 → endConditions(前) → 占位 → 会话/
   * prompt/payload → 执行（带超时）→ run record → 记账 → AI 退出 / 一次性 /
   * endConditions(后) → provider 失败转 blocked。
   */
  async runTick(taskId: string, options: { manual?: boolean } = {}): Promise<TickResult> {
    const task = await this.store.getRaw(taskId);
    if (task === undefined) {
      await this.disarm(taskId, 'task no longer exists');
      return { taskId, status: 'terminal' };
    }
    if (isTerminal(task)) {
      // 循环顶部同款兜底：任务已终态却还挂着 loop（比如被 CLI 标了 done）。
      await this.disarm(taskId, `terminal state '${task.status}'`);
      return { taskId, status: 'terminal' };
    }

    const schedule = scheduleFromTask(task, this.now());
    if (schedule === null) {
      await this.disarm(taskId, 'no resolvable schedule');
      return { taskId, status: 'terminal' };
    }

    const entry = await this.getEntry(taskId);
    const executionCount = entry?.executionCount ?? 0;

    // ---- 结束条件（执行前）----
    const before = checkEndConditions(task, executionCount, this.now());
    if (before !== null) {
      await this.stopForEndCondition(taskId, before);
      return { taskId, status: 'end-condition', executionCount };
    }

    // ---- 原子占位 ----
    const manual = options.manual === true;
    const reserved = manual || this.reserveExecuting(taskId);
    if (!reserved) {
      // 同刻已有一次在跑（调度 tick 撞手动 run）：本轮跳过，不记账。
      console.warn(`[task-scheduler] ${taskId} 仍在执行，跳过本轮`);
      return { taskId, status: 'skipped', executionCount };
    }

    try {
      return await this.executeOnce(task, schedule, entry, executionCount);
    } finally {
      if (!manual) this.executing.delete(taskId);
    }
  }

  private async executeOnce(
    task: Task,
    schedule: TaskSchedule,
    entry: TaskRuntimeEntry | undefined,
    executionCount: number
  ): Promise<TickResult> {
    const runMode = resolveRunMode(task);
    const taskId = task.id;

    // new_session：每 tick 铸新会话并**先落盘**再执行（Rust rotate_new_session_id：
    // 崩在"换了 id 还没存盘"之间会让 task_runtime.json 指向过期 id）。
    let sessionId = entry?.sessionId ?? initialSessionIdFor(task);
    if (runMode === 'new_session') {
      sessionId = randomUUID();
      await this.store.updateRuntimeEntry(taskId, (current) => ({
        ...(current ?? this.newEntry(task)),
        sessionId,
        internalSessionId: sessionId,
      }));
    } else if (entry === undefined) {
      await this.store.updateRuntimeEntry(taskId, () => ({ ...this.newEntry(task), sessionId }));
    }

    // 每 tick 幂等追加会话（S3 的 append-session 自带去重）。
    const appended = await taskAppendSession(this.store, { id: taskId, sessionId });
    if (!appended.ok) {
      // 非致命：只是"任务执行"面板会少这一条。
      console.warn(`[task-scheduler] appendSession(${taskId}) 失败：${appended.error}`);
    }

    // ---- 派发 prompt ----
    let prompt: string;
    try {
      prompt = buildDispatchPrompt(this.store, task);
    } catch (err) {
      const message = errText(err);
      console.error(`[task-scheduler] ${taskId} 派发 prompt 构造失败：${message} — 转 blocked`);
      await this.markBlocked(taskId, message);
      return { taskId, status: 'blocked', error: message };
    }

    const payload: DispatchPayload = {
      taskId,
      prompt,
      sessionId,
      isFirstExecution: executionCount === 0,
      aiCanExit: effectiveEndConditions(task).aiCanExit,
      permissionMode: task.permissionMode ?? '',
      model: task.model,
      providerId: task.providerId,
      runtime: task.runtime,
      runtimeConfig: task.runtimeConfig,
      mcpEnabledServers: task.mcpEnabledServers,
      runMode,
      intervalMinutes: intervalMinutesForPayload(schedule),
      // Rust: `entry.execution_count + 1`（1-based）
      executionNumber: executionCount + 1,
      workspacePath: task.workspacePath,
      executionMode: task.executionMode,
    };

    // ---- 执行（60 分钟超时）----
    const startedAt = this.now();
    let outcome: DispatchOutcome;
    let timedOut = false;
    try {
      const raced = await this.withTimeout(this.executor(task, payload), this.executionTimeoutMs);
      if (raced === TIMED_OUT) {
        timedOut = true;
        outcome = { ok: false, error: 'Execution timed out' };
        console.error(`[task-scheduler] ${taskId} 执行超时（${this.executionTimeoutMs}ms）`);
      } else {
        outcome = raced;
      }
    } catch (err) {
      outcome = { ok: false, error: errText(err) };
    }
    const durationMs = Math.max(0, this.now() - startedAt);

    // 任务在本轮飞行中被删掉 → 不写 run record（否则会刚被清掉又重建历史文件）。
    const stillAlive = (await this.store.getRaw(taskId)) !== undefined;

    // ---- run record ----
    // AI 明确请求退出：按 TERMINAL_STOP_SENTINEL 语义**不写** run record
    // （不是"一次失败的 tick"，别在"最近一次失败"上挂红）。
    if (outcome.aiRequestedExit === true) {
      // 跳过
    } else if (stillAlive) {
      await this.store.appendRun(taskId, {
        ts: this.now(),
        ok: outcome.ok,
        durationMs,
        content: outcome.outputText !== undefined ? truncateText(outcome.outputText) : null,
        error: outcome.ok ? null : truncateText(outcome.error ?? (timedOut ? 'Execution timed out' : 'unknown error')),
      });
    }

    // ---- 运行态记账 ----
    const updatedEntry = await this.store.updateRuntimeEntry(taskId, (current) => ({
      ...(current ?? this.newEntry(task)),
      executionCount: (current?.executionCount ?? executionCount) + 1,
      // 运行态里的 lastExecutedAt 是 **RFC3339 字符串**（S1 的 schema）。
      lastExecutedAt: toRfc3339(this.now()),
      lastRunOk: outcome.ok,
      lastRunDurationMs: durationMs,
      ...(outcome.sessionId !== undefined ? { internalSessionId: outcome.sessionId } : {}),
    }));
    const newCount = updatedEntry?.executionCount ?? executionCount + 1;

    // Task 行的 lastExecutedAt（列表"最近执行"列读它；不 bump updatedAt，
    // 否则每次 tick 都会把任务顶到列表最前 —— Rust `note_execution` 同）。
    if (stillAlive) {
      try {
        await this.store.mutate(taskId, (current) => ({ ...current, lastExecutedAt: this.now() }));
      } catch (err) {
        console.warn(`[task-scheduler] noteExecution(${taskId}) 失败：${errText(err)}`);
      }
    }

    // ---- provider 解析失败 → blocked + disarm ----
    if (!outcome.ok && isProviderResolutionFailure(outcome.error)) {
      const message = outcome.error ?? '';
      console.error(`[task-scheduler] ${taskId} provider 解析失败：${message} — 转 blocked`);
      await this.markBlocked(taskId, message);
      await this.disarm(taskId, `provider unavailable: ${message}`);
      return { taskId, status: 'blocked', error: message, executionCount: newCount };
    }

    // ---- AI 请求退出 ----
    if (outcome.aiRequestedExit === true) {
      await this.stopAndComplete(taskId, outcome.exitReason ?? 'AI requested exit');
      return { taskId, status: 'ai-exit', executionCount: newCount };
    }

    // ---- 一次性任务收尾 ----
    if (schedule.kind === 'at') {
      await this.stopAndComplete(taskId, 'One-shot task completed');
      return { taskId, status: 'one-shot', executionCount: newCount };
    }

    // ---- 结束条件（执行后）----
    const after = checkEndConditions(task, newCount, this.now());
    if (after !== null) {
      await this.stopForEndCondition(taskId, after);
      return { taskId, status: 'end-condition', executionCount: newCount };
    }

    // ---- Loop 的下一跳 ----
    if (schedule.kind === 'loop') {
      return {
        taskId,
        status: outcome.ok ? 'success' : 'failure',
        executionCount: newCount,
        nextDelayMs: outcome.ok ? RALPH_SUCCESS_DELAY_MS : undefined,
        ...(outcome.ok ? {} : { consecutiveFailures: 1 }),
      };
    }

    return {
      taskId,
      status: outcome.ok ? 'success' : 'failure',
      executionCount: newCount,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };
  }

  // ---- 循环 ----

  private startLoop(taskId: string): void {
    if (this.loops.has(taskId)) {
      // 已有 loop：检查它的代数是否还新鲜。arm 会 bump 代数，旧 loop 到点自行
      // 退出 —— 所以"旧 loop 还在 map 里"不等于"它还在干活"，直接重挂更安全
      // （Rust 对 shutdown-flagged 的 handle 也是这个处理）。
      const generation = this.generations.get(taskId) ?? 0;
      const live = this.loopGeneration.get(taskId);
      if (live === generation) {
        console.log(`[task-scheduler] ${taskId} 的 loop 已在运行，跳过重复启动`);
        return;
      }
    }
    const generation = this.bumpGeneration(taskId);
    this.loopGeneration.set(taskId, generation);
    const promise = this.runLoop(taskId, generation)
      .catch((err) => {
        console.error(`[task-scheduler] ${taskId} 的 loop 异常退出：${errText(err)}`);
      })
      .finally(() => {
        if (this.loopGeneration.get(taskId) === generation) {
          this.loops.delete(taskId);
          this.loopGeneration.delete(taskId);
        }
      });
    this.loops.set(taskId, promise);
  }

  /** 任务 id → 当前挂着的 loop 代数（与 generations 分离，便于判"新旧"）。 */
  private readonly loopGeneration = new Map<string, number>();

  private bumpGeneration(taskId: string): number {
    const next = (this.generations.get(taskId) ?? 0) + 1;
    this.generations.set(taskId, next);
    return next;
  }

  private isStopping(taskId: string, generation: number): boolean {
    return this.stopping || (this.generations.get(taskId) ?? 0) !== generation;
  }

  /**
   * 单任务调度循环（Rust `start_scheduler` 里 spawn 的那段）。
   *
   * 结构：算 initial_target → 等到点 → 无限循环 { 终态检查 → runTick →
   * 决定下一跳 }。生产里无限跑；测试用 `maxLoopIterations` 封顶。
   */
  private async runLoop(taskId: string, generation: number): Promise<void> {
    const first = await this.store.getRaw(taskId);
    if (first === undefined) return;
    if (isTerminal(first)) {
      await this.disarm(taskId, `terminal state '${first.status}'`);
      return;
    }
    const initialSchedule = scheduleFromTask(first, this.now());
    if (initialSchedule === null) {
      await this.disarm(taskId, 'no resolvable schedule');
      return;
    }
    const entry = await this.getEntry(taskId);
    const target = computeInitialTarget(initialSchedule, entry, this.now());
    if (target.kind === 'stop') {
      // Rust: cron 解析失败 → active_schedulers.remove() 后直接 return，不重试。
      console.error(`[task-scheduler] ${taskId} ${target.reason} — 停止调度（不重试）`);
      await this.disarm(taskId, target.reason);
      return;
    }
    if (!(await this.sleepUntil(target.at, taskId, generation))) return;

    let consecutiveFailures = 0;
    for (let iteration = 0; ; iteration += 1) {
      if (this.isStopping(taskId, generation)) return;
      if (this.maxLoopIterations !== undefined && iteration >= this.maxLoopIterations) {
        console.log(`[task-scheduler] ${taskId} 达到测试轮数上限（${this.maxLoopIterations}），loop 退出`);
        return;
      }

      // 每 tick 重读 Task（配置热生效）；终态即停。
      const task = await this.store.getRaw(taskId);
      if (task === undefined) {
        await this.disarm(taskId, 'task no longer exists');
        return;
      }
      if (isTerminal(task)) {
        await this.disarm(taskId, `terminal state '${task.status}'`);
        return;
      }
      const schedule = scheduleFromTask(task, this.now());
      if (schedule === null) {
        await this.disarm(taskId, 'lost its schedule');
        return;
      }

      const result = await this.runTick(taskId);
      if (result.status === 'terminal') return;

      // 这些状态已经 disarm + 收尾，loop 退出。
      if (
        result.status === 'ai-exit' ||
        result.status === 'one-shot' ||
        result.status === 'end-condition' ||
        result.status === 'blocked'
      ) {
        return;
      }

      if (result.status === 'skipped') {
        // 占位失败：等一个 poll 周期再来（Rust `sleep(30s); continue;`）。
        if (!(await this.sleepUntil(this.now() + this.pollMs, taskId, generation))) return;
        continue;
      }

      // ---- Ralph Loop ----
      if (schedule.kind === 'loop') {
        if (result.status === 'success') {
          consecutiveFailures = 0;
          if (!(await this.sleepUntil(this.now() + RALPH_SUCCESS_DELAY_MS, taskId, generation))) return;
          continue;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= RALPH_MAX_CONSECUTIVE_FAILURES) {
          console.error(`[task-scheduler] ${taskId} Ralph Loop 连续 ${consecutiveFailures} 次失败，停止`);
          await this.stopAndComplete(taskId, 'Ralph Loop: 10 consecutive failures');
          return;
        }
        const backoff = ralphBackoffMs(consecutiveFailures);
        console.warn(`[task-scheduler] ${taskId} Ralph Loop 第 ${consecutiveFailures} 次失败，退避 ${backoff}ms`);
        if (!(await this.sleepUntil(this.now() + backoff, taskId, generation))) return;
        continue;
      }

      // ---- 时间型：算下一跳 ----
      const next = nextTickTarget(schedule, this.now());
      if (next === null) {
        console.error(`[task-scheduler] ${taskId} 无下一跳（${schedule.kind} 解析失败）—— 停止调度`);
        await this.disarm(taskId, 'no next tick target');
        return;
      }
      if (!(await this.sleepUntil(next, taskId, generation))) return;
    }
  }

  /**
   * wall-clock 等待：每 ≤pollMs 醒一次重读时钟，直到到点 / 被 disarm / 停机。
   * 返回 false = 被打断（调用方应退出 loop）。
   */
  private async sleepUntil(target: number, taskId: string, generation: number): Promise<boolean> {
    for (;;) {
      if (this.isStopping(taskId, generation)) return false;
      const now = this.now();
      if (now >= target) return true;
      const chunk = Math.min(target - now, this.pollMs);
      await this.sleep(chunk);
    }
  }

  // ---- 收尾 ----

  /** endConditions 命中：记一条原因日志 + 收尾（Rust `stop_scheduled_task_internal`）。 */
  private async stopForEndCondition(taskId: string, reason: 'deadline' | 'max-executions'): Promise<void> {
    const message = reason === 'deadline' ? 'endCondition: deadline' : 'endCondition: max executions';
    console.log(`[task-scheduler] ${taskId} 命中结束条件（${reason}）—— 收尾`);
    await this.stopAndComplete(taskId, message);
  }

  /** disarm + 把 Task 推进 done（Rust `stop_scheduled_task_internal` → `complete_task_after_stop`）。 */
  private async stopAndComplete(taskId: string, reason: string | undefined): Promise<void> {
    await this.disarm(taskId, reason);
    const { message, actor, source } = classifyCompletion(reason);
    const task = await this.store.getRaw(taskId);
    // 只在"还在跑/待验收"时收尾：用户手动标过 done/blocked/stopped 的别覆盖。
    if (task === undefined) return;
    if (task.status !== 'running' && task.status !== 'verifying') return;
    const result = await taskUpdateStatus(this.store, {
      id: taskId,
      status: 'done',
      message,
      actor,
      source,
    });
    if (!result.ok) {
      console.warn(`[task-scheduler] ${taskId} 收尾迁移 done 失败：${result.error}`);
    }
  }

  /**
   * 把任务转 blocked（派发 prompt 失败 / provider 解析失败）。
   *
   * 走 S3 的 `taskUpdateStatus`（状态机守卫 + 审计 + 信任账本一起复用）。
   * 注意 `todo → blocked` 在 Rust 的状态机里**不是合法迁移**，Rust 那边也是
   * `let _ =` 忽略结果 —— 这里同样只记日志，不抛。
   */
  private async markBlocked(taskId: string, message: string): Promise<void> {
    const task = await this.store.getRaw(taskId);
    if (task === undefined) return;
    if (!isTransitionLegal(task.status, 'blocked')) {
      console.warn(
        `[task-scheduler] ${taskId} 当前状态 '${task.status}' 无法转 blocked（状态机不允许），仅记日志：${message}`
      );
      return;
    }
    const result: TaskOpResult = await taskUpdateStatus(this.store, {
      id: taskId,
      status: 'blocked',
      message,
      actor: 'system',
      source: 'crash',
    });
    if (!result.ok) console.warn(`[task-scheduler] ${taskId} 转 blocked 失败：${result.error}`);
  }

  // ---- 运行态小工具 ----

  private async getEntry(taskId: string): Promise<TaskRuntimeEntry | undefined> {
    return (await this.store.readRuntime()).find((entry) => entry.taskId === taskId);
  }

  private newEntry(task: Task): TaskRuntimeEntry {
    return {
      taskId: task.id,
      sessionId: initialSessionIdFor(task),
      executionCount: 0,
      armed: false,
    };
  }

  /** 原子占位（单一 set 操作，无 TOCTOU 窗口）。 */
  private reserveExecuting(taskId: string): boolean {
    if (this.executing.has(taskId)) return false;
    this.executing.add(taskId);
    return true;
  }

  /** 带超时的执行器调用；超时返回哨兵，且**清掉定时器**（测试不留活 timer）。 */
  private async withTimeout(
    work: Promise<DispatchOutcome>,
    ms: number
  ): Promise<DispatchOutcome | typeof TIMED_OUT> {
    if (ms <= 0) return work;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
        timer.unref?.();
      });
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

const TIMED_OUT = Symbol('task-scheduler-timeout');

export function createTaskScheduler(options: SchedulerOptions): TaskScheduler {
  return new TaskScheduler(options);
}

// ============ 进程内单例（S5：S6 的路由层要用同一个实例） ============

let schedulerSingleton: TaskScheduler | null = null;

/**
 * 进程内调度器单例。
 *
 * 为什么要单例：`executing` 占位集、loop 代数、`triggerNow` 的互斥都是**进程内**
 * 状态。若每个调用点 `createTaskScheduler()` 各造一个，"同一任务同刻只跑一次"
 * 立刻失效（两个实例各有各的集）。`store` 只在首次构造时读入。
 */
export function getTaskScheduler(store?: TaskStore): TaskScheduler {
  if (schedulerSingleton === null) {
    schedulerSingleton = new TaskScheduler({ store: store ?? createTaskStore() });
  }
  return schedulerSingleton;
}

/** 测试用：丢弃单例（不清 loop —— 调用方负责先 shutdown）。 */
export function resetTaskSchedulerForTest(): void {
  schedulerSingleton = null;
}
