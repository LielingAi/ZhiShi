/**
 * 任务写路径（S3）—— Rust `TaskStore` 写面在 Node 侧的重建。
 *
 * 为什么要有这一层：S1/S2 之后读路径已经本地化，写路径却还是转发 Rust
 * Management API —— 要求 Tauri 应用在场，裸 sidecar 下 `task create-direct`
 * 直接 `Management API not available`。任务面板能看不能动，等于半个功能。
 *
 * 语义权威源：`src-tauri/src/task.rs`（状态机 / 守卫 / 合并顺序 / 错误码）、
 * `src-tauri/src/management_api.rs`（每条路由的响应形状）。**逐条对源码**，
 * 不做"顺手改良"——CLI / AI / TUI 都是按 Rust 的形状写死的。
 *
 * 三条纪律：
 *
 * 1. **所有落盘走 `TaskStore.mutate`**：读索引 → 改 → 整表原子写，全程同一把
 *    文件锁。`get()` + `upsert()` 拼两步会在中间被别的写者覆盖（丢更新）。
 * 2. **不广播 SSE**：`task:*` 事件从来没有在 Node 侧注册过（GUI 已删，唯一
 *    消费者没了），而 `sse.ts` 对未注册事件是"fail closed + 一次性告警"
 *    （`sse-whitelist-crosscheck.unit.test.ts` 会把未注册事件变成红灯）。
 *    需要"界面刷新"的路径（TUI）自己拉取，不靠广播。
 * 3. **S4 才有的东西不假装有**：调度器 bounce / 武装 / cron 表达式校验都要
 *    等 Node 侧调度器落地（S4），这里只写 `TODO(S4)`。桌面通知同理——GUI 删了
 *    之后 Node 侧没有通知器，Rust 的 `dispatch_notification` 无对应实现。
 */

import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { writeFileAtomic } from 'zhishi-loop-core/file-lock';

import { recordTrustTransition } from '../memory/trust';
import { validateCronExpression } from './cron';
import {
  assertSafeTaskId,
  buildTaskDocs,
  TaskNotFoundError,
  taskDocFilename,
  type NotificationConfig,
  type StatusTransition,
  type Task,
  type TaskDispatchOrigin,
  type TaskEndConditions,
  type TaskExecutionMode,
  type TaskExecutor,
  type TaskRunMode,
  type TaskStatus,
  type TaskStore,
  type TransitionActor,
  type TransitionSource,
} from './store';

// ============ 结果形状 ============

/** Rust Management API 的 `{ok:...}` 形状：admin-api 再套一层 {success,data,error}。 */
export interface TaskOpOk {
  ok: true;
  [key: string]: unknown;
}

export interface TaskOpFail {
  ok: false;
  error: string;
}

export type TaskOpResult = TaskOpOk | TaskOpFail;

export interface TaskOpOptions {
  /** 发起者署名（信任账本 P2）。admin-api 从 currentActor() 取，测试可省。 */
  actorName?: string;
}

// ============ 错误（照 Rust `TaskOpError` 的 code 契约） ============

export type TaskOpErrorCode =
  | 'invalid_transition'
  | 'archive_user_only'
  | 'agent_source_must_be_cli'
  | 'not_found'
  | 'already_deleted'
  | 'update_rejected_running';

/**
 * Rust 把 `TaskOpError` 序列化成 JSON 字符串塞进 `error` 字段（见
 * `impl From<TaskOpError> for String`），CLI / UI 靠 `code` 分支而不是猜文案。
 * 这里保持逐字同形，避免"迁移后错误处理全挂"。
 */
export function taskOpError(code: TaskOpErrorCode, message: string): string {
  return JSON.stringify({ code, message });
}

/** 内部拒绝信号：把 Rust 的 `Result::Err` 控制流搬进 JS 的 throw/`catch`。 */
class OpReject extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpReject';
  }
}

function reject(message: string): never {
  throw new OpReject(message);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 统一的失败收敛：内部拒绝 / 找不到 / 其它异常 → `{ok:false, error}`。 */
async function runOp(op: () => Promise<TaskOpResult>): Promise<TaskOpResult> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof OpReject) return { ok: false, error: err.message };
    if (err instanceof TaskNotFoundError) {
      return { ok: false, error: taskOpError('not_found', err.message) };
    }
    return { ok: false, error: errText(err) };
  }
}

// ============ 入参读取 ============

const TASK_STATUS_VALUES: readonly TaskStatus[] = [
  'todo',
  'running',
  'verifying',
  'done',
  'blocked',
  'stopped',
  'archived',
  'deleted',
];
const TASK_EXECUTORS: readonly TaskExecutor[] = ['user', 'agent'];
const TASK_EXECUTION_MODES: readonly TaskExecutionMode[] = ['once', 'scheduled', 'recurring', 'loop'];
const TASK_RUN_MODES: readonly TaskRunMode[] = ['single-session', 'new-session'];
const TASK_DISPATCH_ORIGINS: readonly TaskDispatchOrigin[] = ['direct', 'ai-aligned', 'system'];
const TRANSITION_ACTORS: readonly TransitionActor[] = ['system', 'user', 'agent'];
const TRANSITION_SOURCES: readonly TransitionSource[] = [
  'cli',
  'ui',
  'watchdog',
  'crash',
  'scheduler',
  'endCondition',
  'rerun',
  'migration',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rust `Option<T>`：JSON 里缺字段和显式 null 都是 None（serde 语义）。 */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string');
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function flagEnabled(value: unknown): boolean {
  return value === true || value === 'true' || value === 1;
}

/** 冻结 taskId：非空 + 路径安全（`../../etc/passwd` / Windows 保留名全拒）。 */
function readTaskId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') reject('task id is required');
  return assertSafeTaskId(value.trim());
}

/** 照 Rust `validate_task_name`：trim 后 1–120 字符（按字符数，不是字节）。 */
function readTaskName(value: unknown): string {
  if (typeof value !== 'string') reject('task name is empty');
  const trimmed = value.trim();
  if (trimmed === '') reject('task name is empty');
  if ([...trimmed].length > 120) reject('task name exceeds 120 chars');
  return trimmed;
}

/**
 * 照 Rust `canonicalize_workspace_path` 的"非空 + 绝对路径"，但**允许缺省**。
 *
 * 为什么要放宽：CLI 的 `task create-direct` 不给 workspace 默认值（没传就
 * undefined），而 Rust 的 `workspace_id/workspace_path` 是 serde 必填 —— 裸
 * sidecar 时代这就是一条"连 Rust 都建不出任务"的死路。缺省落空串与既有系统
 * 任务行（`workspaceId: ""` 的蒸馏弧）同形；给了值仍必须绝对，避免相对路径
 * 被悄悄当成 sidecar cwd。
 */
function normalizeWorkspacePath(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return '';
  if (!isAbsolute(raw)) reject(`workspacePath must be absolute: ${raw}`);
  return raw;
}

/** PRD 0.2.4：`[]` 与 `None` 同义（"跟随 Agent"），只有非空数组才是覆盖。 */
function normalizeMcpOverride(value: string[] | undefined): string[] | undefined {
  if (value === undefined || value.length === 0) return undefined;
  return value;
}

/** PRD 0.2.9：providerId 在场但没写 runtime → 钉成 'builtin'（防跨 provider 串味）。 */
function pinRuntimeForProviderId(
  providerId: string | undefined,
  runtime: string | undefined
): string | undefined {
  if (providerId !== undefined && runtime === undefined) return 'builtin';
  return runtime;
}

/** 照 Rust `validate_task_provider_routing`（配对 + 外部 runtime 互斥）。 */
function validateProviderRouting(
  providerId: string | undefined,
  model: string | undefined,
  runtime: string | undefined
): string | null {
  if (providerId !== undefined && model === undefined) {
    return 'providerId 必须与 model 配对设置 — 选了 provider 后请同时选择该 provider 下的具体 model';
  }
  if (runtime !== undefined && providerId !== undefined) {
    if (runtime === 'claude-code' || runtime === 'codex' || runtime === 'gemini') {
      return `外部 runtime '${runtime}' 自管 provider — 不允许同时指定 providerId（请在该 runtime 自身的设置中切换 provider）`;
    }
  }
  return null;
}

function readEndConditions(value: unknown): TaskEndConditions {
  const raw = isRecord(value) ? value : {};
  const out: TaskEndConditions = { aiCanExit: raw.aiCanExit !== false };
  if (typeof raw.deadline === 'number') out.deadline = raw.deadline;
  if (typeof raw.maxExecutions === 'number') out.maxExecutions = raw.maxExecutions;
  return out;
}

function readNotification(value: unknown): NotificationConfig | undefined {
  if (!isRecord(value)) return undefined;
  const out: NotificationConfig = { desktop: value.desktop !== false };
  const events = optionalStringArray(value.events);
  if (events !== undefined) out.events = events;
  return out;
}

// ============ 状态机（照 Rust `is_transition_legal`） ============

const LEGAL_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  todo: ['running'],
  // running → verifying/done/blocked/stopped
  running: ['verifying', 'done', 'blocked', 'stopped'],
  // verifying → running 是 v1.4 的"宽松模式"（验收方要求返工，直接回到执行）
  verifying: ['running', 'done', 'blocked', 'stopped'],
  // 重跑 / 重置
  blocked: ['todo'],
  stopped: ['todo'],
  done: ['todo', 'archived'],
  archived: ['todo'],
  // `deleted` 只由 delete() 写，不是任何迁移的目标
  deleted: [],
};

export function isTransitionLegal(from: TaskStatus, to: TaskStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

// ============ create-direct ============

export async function taskCreateDirect(
  store: TaskStore,
  payload: Record<string, unknown>
): Promise<TaskOpResult> {
  return runOp(async () => {
    const name = readTaskName(payload.name);
    const executor = readEnum(payload.executor, TASK_EXECUTORS) ?? 'agent';
    const executionMode = readEnum(payload.executionMode, TASK_EXECUTION_MODES) ?? 'once';
    const workspaceId = optionalString(payload.workspaceId) ?? '';
    const workspacePath = normalizeWorkspacePath(payload.workspacePath);
    const taskMdContent = typeof payload.taskMdContent === 'string' ? payload.taskMdContent : '';
    const providerId = optionalString(payload.providerId);
    const model = optionalString(payload.model);
    const runtime = pinRuntimeForProviderId(providerId, optionalString(payload.runtime));
    const routingError = validateProviderRouting(providerId, model, runtime);
    if (routingError !== null) reject(routingError);

    // cron 表达式在建单口就校验：坏表达式落盘之后，调度器第一次 arm 会以
    // "invalid cron → 停止且不重试"静默死掉（任务显示 running 却永不触发）。
    // 报错文案与 Rust `create_direct` 一致：`cron expression invalid: ...`。
    const cronExpression = optionalString(payload.cronExpression);
    if (cronExpression !== undefined && cronExpression.trim() !== '') {
      const cronError = validateCronExpression(cronExpression, optionalString(payload.cronTimezone));
      if (cronError !== null) reject(`cron expression invalid: ${cronError}`);
    }

    const now = Date.now();
    const id = randomUUID();
    const task: Task = {
      id,
      name,
      executor,
      workspaceId,
      workspacePath,
      executionMode,
      sessionIds: [],
      status: 'todo',
      tags: optionalStringArray(payload.tags) ?? [],
      createdAt: now,
      updatedAt: now,
      // 与 Rust 同形：建单写一条 from=null 的审计（UI 渲染成"创建"事件点）
      statusHistory: [
        { from: null, to: 'todo', at: now, actor: 'user', message: 'created (direct)', source: 'ui' },
      ],
      dispatchOrigin: readEnum(payload.dispatchOrigin, TASK_DISPATCH_ORIGINS) ?? 'direct',
      deleted: false,
    };
    copyTaskOptionalFields(task, payload);
    if (providerId !== undefined) task.providerId = providerId;
    if (model !== undefined) task.model = model;
    if (runtime !== undefined) task.runtime = runtime;

    // 事务顺序照 Rust（交叉评审 C3）：先 materialize task.md，最后提交索引行。
    // 反过来的话，docs 目录写失败会留下"有索引行、没有 task.md"的孤儿任务，
    // 重启后依然存在；当前顺序最坏只留一个没人引用的空目录。
    const dir = store.docsDirFor(id);
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, 'task.md'), taskMdContent);
    try {
      await store.upsert(task);
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    return { ok: true, task };
  });
}

/** 把 create/update 共用的可选字段从 payload 搬到 task（缺省即不写键）。 */
function copyTaskOptionalFields(task: Task, payload: Record<string, unknown>): void {
  const description = optionalString(payload.description);
  if (description !== undefined) task.description = description;
  const runMode = readEnum(payload.runMode, TASK_RUN_MODES);
  if (runMode !== undefined) task.runMode = runMode;
  if (isRecord(payload.endConditions)) task.endConditions = readEndConditions(payload.endConditions);
  if (typeof payload.intervalMinutes === 'number') task.intervalMinutes = payload.intervalMinutes;
  const cronExpression = optionalString(payload.cronExpression);
  if (cronExpression !== undefined) task.cronExpression = cronExpression;
  const cronTimezone = optionalString(payload.cronTimezone);
  if (cronTimezone !== undefined) task.cronTimezone = cronTimezone;
  if (typeof payload.dispatchAt === 'number') task.dispatchAt = payload.dispatchAt;
  const permissionMode = optionalString(payload.permissionMode);
  if (permissionMode !== undefined) task.permissionMode = permissionMode;
  const preselectedSessionId = optionalString(payload.preselectedSessionId);
  if (preselectedSessionId !== undefined) task.preselectedSessionId = preselectedSessionId;
  if (payload.runtimeConfig !== undefined && payload.runtimeConfig !== null) {
    task.runtimeConfig = payload.runtimeConfig as Task['runtimeConfig'];
  }
  const mcp = normalizeMcpOverride(optionalStringArray(payload.mcpEnabledServers));
  if (mcp !== undefined) task.mcpEnabledServers = mcp;
  const sourceThoughtId = optionalString(payload.sourceThoughtId);
  if (sourceThoughtId !== undefined) task.sourceThoughtId = sourceThoughtId;
  const notification = readNotification(payload.notification);
  if (notification !== undefined) task.notification = notification;
  const dispatchTarget = readEnum(payload.dispatchTarget, ['local', 'hub'] as const);
  if (dispatchTarget !== undefined) task.dispatchTarget = dispatchTarget;
  const remoteTaskId = optionalString(payload.remoteTaskId);
  if (remoteTaskId !== undefined) task.remoteTaskId = remoteTaskId;
  const remoteOriginNodeId = optionalString(payload.remoteOriginNodeId);
  if (remoteOriginNodeId !== undefined) task.remoteOriginNodeId = remoteOriginNodeId;
  const remoteExecutorNodeId = optionalString(payload.remoteExecutorNodeId);
  if (remoteExecutorNodeId !== undefined) task.remoteExecutorNodeId = remoteExecutorNodeId;
}

// ============ create-from-alignment ============

/** 「AI 讨论」启动时写进 `<dir>/metadata.json` 的会话元数据（Rust 同形）。 */
interface AlignmentSessionMetadata {
  workspaceId?: string;
  workspacePath?: string;
  sourceThoughtId?: string;
}

export async function taskCreateFromAlignment(
  store: TaskStore,
  payload: Record<string, unknown>
): Promise<TaskOpResult> {
  return runOp(async () => {
    const name = readTaskName(payload.name);
    const executor = readEnum(payload.executor, TASK_EXECUTORS) ?? 'agent';
    const executionMode = readEnum(payload.executionMode, TASK_EXECUTION_MODES) ?? 'once';
    if (executionMode !== 'once') {
      // 这条 AI 讨论路径的输入契约里没有排期字段；放过 recurring/scheduled
      // 会落一条"executionMode=recurring 但 interval/cron/dispatchAt 全空"的
      // 任务，之后 `task run` 会以"无可解析排期"失败，而 CLI 这个子命令
      // 又没有 --cron 能救回来。所以在建单口就挡掉并给出可行路径。
      reject(
        `create-from-alignment only supports executionMode=once; to set a schedule, create the task and then \`zhishi task update <id> --cronExpression <expr>\` or use \`create-direct\` (got ${executionMode})`
      );
    }
    const alignmentSessionId = assertSafeTaskId(
      typeof payload.alignmentSessionId === 'string' ? payload.alignmentSessionId.trim() : ''
    );
    const providerId = optionalString(payload.providerId);
    const model = optionalString(payload.model);
    const runtime = pinRuntimeForProviderId(providerId, optionalString(payload.runtime));
    const routingError = validateProviderRouting(providerId, model, runtime);
    if (routingError !== null) reject(routingError);

    const src = store.docsDirFor(alignmentSessionId);
    if (!existsSync(src)) reject(`alignment dir not found: ${src}`);

    const metadata = readAlignmentMetadata(join(src, 'metadata.json'));
    const workspaceId = optionalString(payload.workspaceId) ?? metadata?.workspaceId;
    if (workspaceId === undefined) {
      reject('workspaceId missing — pass --workspaceId or ensure alignment metadata.json exists');
    }
    const rawWorkspacePath = optionalString(payload.workspacePath) ?? metadata?.workspacePath;
    if (rawWorkspacePath === undefined) {
      reject('workspacePath missing — pass --workspacePath or ensure alignment metadata.json exists');
    }
    const workspacePath = normalizeWorkspacePath(rawWorkspacePath);

    const now = Date.now();
    const id = randomUUID();
    const task: Task = {
      id,
      name,
      executor,
      workspaceId,
      workspacePath,
      executionMode: 'once',
      sessionIds: [],
      status: 'todo',
      tags: optionalStringArray(payload.tags) ?? [],
      createdAt: now,
      updatedAt: now,
      statusHistory: [
        { from: null, to: 'todo', at: now, actor: 'agent', message: 'created (ai-aligned)', source: 'cli' },
      ],
      dispatchOrigin: 'ai-aligned',
      deleted: false,
    };
    copyTaskOptionalFields(task, payload);
    if (providerId !== undefined) task.providerId = providerId;
    if (model !== undefined) task.model = model;
    if (runtime !== undefined) task.runtime = runtime;
    const sourceThoughtId = optionalString(payload.sourceThoughtId) ?? metadata?.sourceThoughtId;
    if (sourceThoughtId !== undefined) task.sourceThoughtId = sourceThoughtId;

    // 事务顺序照 Rust：先落索引行，再搬目录；搬失败就把行删掉回滚 ——
    // 反过来会"目录已经搬成新 id、索引里却没有这行"，对齐文档就变成孤儿。
    await store.upsert(task);
    const dst = store.docsDirFor(id);
    try {
      moveDir(src, dst);
    } catch (err) {
      await store.remove(id);
      reject(`move alignment dir: ${errText(err)}`);
    }
    return { ok: true, task };
  });
}

/** 读 alignment 会话的 metadata.json：缺失/损坏都返回 undefined（回落显式入参）。 */
function readAlignmentMetadata(path: string): AlignmentSessionMetadata | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as AlignmentSessionMetadata) : null;
  } catch (err) {
    // 损坏与缺失要能区分开：日志里能看出"元数据坏了，回落显式入参"，
    // 而不是让人误以为调用方没传 workspaceId。
    console.warn(`[task-ops] alignment metadata.json 解析失败 (${path})，回落显式入参：${errText(err)}`);
    return null;
  }
}

/** 目录搬移：先试 rename（同盘原子），跨盘失败再 copy+rm。 */
function moveDir(src: string, dst: string): void {
  if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
  try {
    renameSync(src, dst);
    return;
  } catch {
    // EXDEV / 跨卷等：退化成复制后删除（任务文档是小 markdown，代价可接受）
  }
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
  rmSync(src, { recursive: true, force: true });
}

// ============ update ============

export async function taskUpdate(
  store: TaskStore,
  payload: Record<string, unknown>
): Promise<TaskOpResult> {
  return runOp(async () => {
    const id = readTaskId(payload.id);
    let scheduleChanged = false;
    const updated = await store.mutate(id, (task) => {
      if (task.deleted) reject(taskOpError('already_deleted', 'task has been deleted'));
      if (task.status === 'running' || task.status === 'verifying') {
        reject(taskOpError('update_rejected_running', 'cannot edit task fields while running/verifying'));
      }
      const next = applyTaskUpdate(task, payload);
      next.updatedAt = Date.now();
      scheduleChanged = hasScheduleShapeChanged(task, next);

      // prompt（task.md 正文）与索引行必须在同一把锁里改：否则中间的
      // update-status(running) 会让"文档已改、状态已跑"同时成立（PRD §9.4）。
      const prompt = optionalString(payload.prompt);
      if (prompt !== undefined) {
        if (prompt.trim() === '') reject('prompt is empty');
        if (next.dispatchOrigin === 'ai-aligned') {
          reject('ai-aligned tasks use /task-implement; edit alignment.md instead');
        }
        const dir = store.docsDirFor(id);
        mkdirSync(dir, { recursive: true });
        writeFileAtomic(join(dir, 'task.md'), prompt);
      }
      return next;
    });
    if (updated === null) reject('task update produced no change');

    if (scheduleChanged) {
      // Rust 在排期形状变化时 disarm + re-arm（bounce），让新的
      // interval/cron/dispatchAt 立刻生效 —— 旧的 sleep target 是按老排期算的，
      // 不打断就要按旧节律再等一轮。
      //
      // S4 已在 `scheduler.ts` 提供 `TaskScheduler.bounce()`，但这里**还不能调**：
      // ops 是 scheduler 的下游（scheduler 用 ops 的状态迁移），静态引用会成环
      // （depcruise no-circular）。接线要等 S5 用一个叶子 hook 模块
      // （`setBounceHook`）双向解耦，或在 admin 的写路由里显式调 bounce。
      console.log(`[task-ops] 排期形状已变 id=${id}（S5 待接线：TaskScheduler.bounce）`);
    }
    return { ok: true, task: { ...updated, docs: buildTaskDocs(store, updated.id) } };
  });
}

/**
 * 字段合并（照 Rust `TaskStore::update` 的逐字段顺序）。
 *
 * 关键语义：`undefined`/`null` = "本次不改"（serde 的 `Option::None`），
 * 空串 = "清空"（仅对 model/providerId/permissionMode/... 这些把 '' 归一成
 * None 的字段）。`clearProviderOverride` / `clearRuntimeOverride` 在字段合并
 * **之后**生效（与 Rust 同序），所以它们能压过同请求里的显式值。
 */
function applyTaskUpdate(task: Task, payload: Record<string, unknown>): Task {
  const next: Task = { ...task };
  if (payload.name !== undefined && payload.name !== null) next.name = readTaskName(payload.name);
  const executor = readEnum(payload.executor, TASK_EXECUTORS);
  if (executor !== undefined) next.executor = executor;
  const description = optionalString(payload.description);
  if (description !== undefined) next.description = description;
  const executionMode = readEnum(payload.executionMode, TASK_EXECUTION_MODES);
  if (executionMode !== undefined) next.executionMode = executionMode;
  const runMode = readEnum(payload.runMode, TASK_RUN_MODES);
  if (runMode !== undefined) next.runMode = runMode;
  if (isRecord(payload.endConditions)) next.endConditions = readEndConditions(payload.endConditions);
  if (typeof payload.intervalMinutes === 'number') next.intervalMinutes = payload.intervalMinutes;
  const cronExpression = optionalString(payload.cronExpression);
  if (cronExpression !== undefined) {
    // 空串 = 从"高级 cron"切回固定间隔（前端用 '' 表达 clear）。
    next.cronExpression = cronExpression.trim() === '' ? undefined : cronExpression;
  }
  const cronTimezone = optionalString(payload.cronTimezone);
  if (cronTimezone !== undefined) {
    next.cronTimezone = cronTimezone.trim() === '' ? undefined : cronTimezone;
  }
  if (typeof payload.dispatchAt === 'number') next.dispatchAt = payload.dispatchAt;
  const model = optionalString(payload.model);
  if (model !== undefined) next.model = model.trim() === '' ? undefined : model;
  const providerId = optionalString(payload.providerId);
  if (providerId !== undefined) next.providerId = providerId.trim() === '' ? undefined : providerId;
  // "跟随 Agent" 原子清空：provider 与 model 必须一起清，只清一个会留下
  // provider-without-model 的非法形状（validateProviderRouting 会拒）。
  if (flagEnabled(payload.clearProviderOverride)) {
    next.providerId = undefined;
    next.model = undefined;
  }
  const permissionMode = optionalString(payload.permissionMode);
  if (permissionMode !== undefined) {
    next.permissionMode = permissionMode.trim() === '' ? undefined : permissionMode;
  }
  const preselectedSessionId = optionalString(payload.preselectedSessionId);
  if (preselectedSessionId !== undefined) {
    next.preselectedSessionId = preselectedSessionId.trim() === '' ? undefined : preselectedSessionId;
  }
  const runtime = optionalString(payload.runtime);
  if (runtime !== undefined) next.runtime = runtime;
  if (payload.runtimeConfig !== undefined && payload.runtimeConfig !== null) {
    next.runtimeConfig = payload.runtimeConfig as Task['runtimeConfig'];
  }
  if (flagEnabled(payload.clearRuntimeOverride)) {
    next.runtime = undefined;
    next.runtimeConfig = undefined;
  }
  if (Array.isArray(payload.mcpEnabledServers)) {
    next.mcpEnabledServers = normalizeMcpOverride(optionalStringArray(payload.mcpEnabledServers));
  }
  const tags = optionalStringArray(payload.tags);
  if (tags !== undefined) next.tags = tags;
  const notification = readNotification(payload.notification);
  if (notification !== undefined) next.notification = notification;

  // 合并后的整体状态再校验一遍（不是校验入参片段）：clear 之后的形状才是真实形状。
  next.runtime = pinRuntimeForProviderId(next.providerId, next.runtime);
  const routingError = validateProviderRouting(next.providerId, next.model, next.runtime);
  if (routingError !== null) reject(routingError);

  applyModeTransitionHygiene(next);

  // 校验位置照 Rust：在模式卫生**之后**校验合并结果（executionMode 翻成 once
  // 时 cronExpression 已被清掉，不该再为它报错）。
  const mergedCron = next.cronExpression;
  if (mergedCron !== undefined && mergedCron.trim() !== '') {
    const cronError = validateCronExpression(mergedCron, next.cronTimezone);
    if (cronError !== null) reject(`cron expression invalid: ${cronError}`);
  }
  return next;
}

/**
 * 模式切换清理（照 Rust 同名逻辑）：`runMode` / `endConditions` / 排期详情的
 * 归属只对特定执行模式有意义。不清理的话，`executionMode=once` 的任务会带着
 * 上一条 recurring 的 interval 字段，读的人（和将来的调度器）会被误导。
 *
 * `TaskUpdateInput` 用 `Option<T>` 表达不了"清空"，所以由服务端在模式不再
 * 需要该字段时兜底清掉。
 */
function applyModeTransitionHygiene(task: Task): void {
  if (task.executionMode === 'once') {
    task.runMode = undefined;
    task.endConditions = undefined;
    task.intervalMinutes = undefined;
    task.cronExpression = undefined;
    task.cronTimezone = undefined;
    task.dispatchAt = undefined;
    return;
  }
  if (task.executionMode === 'scheduled') {
    task.intervalMinutes = undefined;
    task.cronExpression = undefined;
    task.cronTimezone = undefined;
    // dispatchAt 现在是唯一的"何时开跑"，遗留的 endConditions.deadline
    // 只剩误导作用（语义不同：deadline 是"何时停止"）。
    if (task.endConditions !== undefined) task.endConditions = { ...task.endConditions, deadline: undefined };
    return;
  }
  // recurring / loop：dispatchAt 只属于 scheduled
  task.dispatchAt = undefined;
}

/** 排期形状是否变化（决定要不要 TODO(S4) 的调度器 bounce）。 */
function hasScheduleShapeChanged(before: Task, after: Task): boolean {
  return (
    before.executionMode !== after.executionMode ||
    before.runMode !== after.runMode ||
    JSON.stringify(before.endConditions ?? null) !== JSON.stringify(after.endConditions ?? null) ||
    before.intervalMinutes !== after.intervalMinutes ||
    before.cronExpression !== after.cronExpression ||
    before.cronTimezone !== after.cronTimezone ||
    before.dispatchAt !== after.dispatchAt
  );
}

// ============ update-status ============

interface TransitionOutcome {
  task: Task;
  transition: StatusTransition;
}

/**
 * 状态迁移核心（照 Rust `TaskStore::update_status` 的 5 步）：
 *   1. `deleted` 不能作为目标（那是 delete() 的专属伪状态）
 *   2. 任务存在且未被软删
 *   3. 迁移表合法性
 *   4. actor/source 守卫（archived 仅 user；agent 必须 source=cli）
 *   5. 落盘后记账（信任账本，best-effort）
 */
async function applyTransition(
  store: TaskStore,
  id: string,
  to: TaskStatus,
  actor: TransitionActor,
  source: TransitionSource | undefined,
  message: string | undefined,
  options: TaskOpOptions
): Promise<TransitionOutcome> {
  if (to === 'deleted') {
    // 与 Rust 同一条（from/to 都填 Deleted）：CLI 靠 code 判断，不是文案。
    reject(taskOpError('invalid_transition', 'invalid transition from deleted to deleted'));
  }
  let written: StatusTransition | null = null;
  const updated = await store.mutate(id, (task) => {
    if (task.deleted) reject(taskOpError('already_deleted', 'task has been deleted'));
    const from = task.status;
    if (!isTransitionLegal(from, to)) {
      reject(taskOpError('invalid_transition', `invalid transition from ${from} to ${to}`));
    }
    if (to === 'archived' && actor !== 'user') {
      reject(taskOpError('archive_user_only', 'archive is user-only (PRD §9.1)'));
    }
    if (actor === 'agent' && source !== 'cli') {
      reject(taskOpError('agent_source_must_be_cli', "agent transitions must come through CLI (source='cli')"));
    }
    const now = Date.now();
    const transition: StatusTransition = { from, to, at: now, actor, source };
    if (message !== undefined) transition.message = message;
    written = transition;
    const next: Task = { ...task, status: to, updatedAt: now, statusHistory: [...task.statusHistory, transition] };
    // 进 running 即记一次执行时刻（列表"最近执行"列的数据源）。
    if (to === 'running') next.lastExecutedAt = now;
    return next;
  });
  if (updated === null || written === null) reject('task status update produced no change');
  const transition = written as StatusTransition;

  if (to === 'stopped' || to === 'blocked' || to === 'archived' || to === 'done') {
    // Rust 在这一步主动 disarm，立刻打断调度 loop 的 sleep（≤30s 内退出）。
    // Node 侧 S4 的 loop 会在**下一轮 tick 顶部**发现终态并自行 disarm —— 语义
    // 等价，只是"打断休眠"这一步没做：被打断前 loop 最多睡到下一个计划时刻。
    // 立刻打断需要 ops 反向调用 scheduler，静态引用会成环（见 taskUpdate 的
    // 同类注释），S5 用叶子 hook 模块接线。
    console.log(
      `[task-ops] 任务进入 ${to}（id=${updated.id}）—— 调度 loop 将在下一轮 tick 顶部自行 disarm`
    );
  }

  // 信任账本（宪章 §5.1）：进程内直接记账，不再绕 HTTP 往返 —— 账本本体就在
  // 本进程（memory.db）。best-effort：账本写失败绝不能影响迁移本身。
  try {
    recordTrustTransition(
      {
        taskId: updated.id,
        taskName: updated.name,
        from: transition.from ?? '',
        to: transition.to,
        actor,
        source,
        actorName: options.actorName,
      },
      store.dataDir
    );
  } catch (err) {
    console.warn(`[task-ops] 信任账本记账失败（不影响迁移）：${errText(err)}`);
  }

  return { task: updated, transition };
}

export async function taskUpdateStatus(
  store: TaskStore,
  payload: Record<string, unknown>,
  options: TaskOpOptions = {}
): Promise<TaskOpResult> {
  return runOp(async () => {
    const id = readTaskId(payload.id);
    const to = readEnum(payload.status, TASK_STATUS_VALUES);
    if (to === undefined) reject(`unknown status: ${String(payload.status)}`);
    const actor = readEnum(payload.actor, TRANSITION_ACTORS) ?? 'user';
    // management API 层对 source 的缺省是 'cli'（Rust `req.source.or(Some(Cli))`）。
    const source = readEnum(payload.source, TRANSITION_SOURCES) ?? 'cli';
    const { task, transition } = await applyTransition(
      store,
      id,
      to,
      actor,
      source,
      optionalString(payload.message),
      options
    );
    return { ok: true, task, transition };
  });
}

// ============ append-session ============

export async function taskAppendSession(
  store: TaskStore,
  payload: Record<string, unknown>
): Promise<TaskOpResult> {
  return runOp(async () => {
    const id = readTaskId(payload.id);
    const sessionId = optionalString(payload.sessionId)?.trim();
    if (sessionId === undefined || sessionId === '') reject('sessionId is required');
    const updated = await store.mutate(id, (task) => {
      // 去重：同一个 session 重复登记不改任何东西（也不 bump updatedAt，
      // 否则列表会被"重复登记"反复顶到最前面）。
      if (task.sessionIds.includes(sessionId)) return null;
      return { ...task, sessionIds: [...task.sessionIds, sessionId], updatedAt: Date.now() };
    });
    const task = updated ?? (await store.get(id));
    if (task === undefined) reject(taskOpError('not_found', `task not found: ${id}`));
    return { ok: true, task };
  });
}

// ============ archive ============

export async function taskArchive(
  store: TaskStore,
  payload: Record<string, unknown>,
  options: TaskOpOptions = {}
): Promise<TaskOpResult> {
  return runOp(async () => {
    const id = readTaskId(payload.id);
    // Rust `archive()` 就是写死 actor=user / source=ui 的一次 update_status。
    const { task } = await applyTransition(
      store,
      id,
      'archived',
      'user',
      'ui',
      optionalString(payload.message),
      options
    );
    return { ok: true, task };
  });
}

// ============ delete ============

export async function taskDelete(
  store: TaskStore,
  payload: Record<string, unknown>
): Promise<TaskOpResult> {
  return runOp(async () => {
    const id = readTaskId(payload.id);
    const updated = await store.mutate(id, (task) => {
      // 幂等：已删的任务不再写第二条伪迁移（Rust 同：`if existing.deleted { return Ok(()) }`）。
      if (task.deleted) return null;
      const now = Date.now();
      const next: Task = {
        ...task,
        status: 'deleted',
        deleted: true,
        deletedAt: now,
        updatedAt: now,
        // 伪迁移（PRD §10.2.2）：审计侧靠 `to === 'deleted'` 就能捞到所有删除，
        // 而迁移表里 deleted 永远不是合法目标 —— 只有这条路径能写它。
        statusHistory: [
          ...task.statusHistory,
          { from: task.status, to: 'deleted', at: now, actor: 'user', message: 'deleted', source: 'ui' },
        ],
      };
      delete next.cronTaskId;
      return next;
    });
    if (updated !== null) {
      // 摘掉调度侧残留（Rust `on_task_deleted`）：运行态条目留着会让调度器
      // 继续对着一条幽灵任务 tick，执行历史留着则是纯垃圾。
      //
      // best-effort：清理失败只 warn —— 索引行已经软删落盘了，这时候把整个
      // 请求报成失败，会让调用方以为"没删掉"而去重试，语义更乱（Rust 的
      // on_task_deleted 同样不向上抛错）。
      try {
        await store.removeRunHistory(id);
        await store.removeRuntimeEntry(id);
      } catch (err) {
        console.warn(`[task-ops] 删除后清理调度残留失败（忽略）：${errText(err)}`);
      }
    }
    return { ok: true };
  });
}

// ============ write-doc ============

export async function taskWriteDoc(
  store: TaskStore,
  payload: Record<string, unknown>
): Promise<TaskOpResult> {
  return runOp(async () => {
    const id = readTaskId(payload.id);
    const docName = typeof payload.doc === 'string' ? payload.doc : '';
    const filename = taskDocFilename(docName);
    if (filename === null) {
      reject(`unknown doc name: ${docName} (expected task|verify|progress|alignment)`);
    }
    // progress.md 是执行期 AI 自己追加的，alignment.md 由对齐技能写 —— 这两份
    // 不接受外部整篇覆盖（否则会把 AI 的进度记录冲掉）。
    if (filename === 'progress.md' || filename === 'alignment.md') {
      reject(`${filename} is not writable via this API (progress=agent-appended, alignment=skill-written)`);
    }
    const content = typeof payload.content === 'string' ? payload.content : '';
    await store.mutate(id, (task) => {
      if (task.deleted) reject(taskOpError('already_deleted', 'task has been deleted'));
      if (task.status === 'running' || task.status === 'verifying') {
        reject(taskOpError('update_rejected_running', 'cannot edit task fields while running/verifying'));
      }
      const dir = store.docsDirFor(id);
      mkdirSync(dir, { recursive: true });
      // 文档先写、行后写（同 Rust）：文件写失败时索引还是干净的。
      writeFileAtomic(join(dir, filename), content);
      return { ...task, updatedAt: Date.now() };
    });
    return { ok: true };
  });
}
