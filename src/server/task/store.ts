/**
 * 任务存储层（S1）—— Rust `task.rs` / `task_scheduler.rs` 的存储面在 Node 侧
 * 的重建。两端共读同一批文件，所以**字段名、文件名、序列化形态全部照搬
 * Rust**，不做"顺手改良"：
 *
 *   | 文件 | 位置 | 格式 |
 *   |---|---|---|
 *   | 任务索引 | `<dataDir>/tasks.jsonl` | JSONL，一行一个 Task，camelCase |
 *   | 文档 | `<dataDir>/tasks/<id>/{task,verify,progress,alignment}.md` | Markdown |
 *   | 调度运行态 | `<dataDir>/task_runtime.json` | `{ entries: [...] }` |
 *   | 执行历史 | `<dataDir>/task_runs/<id>.jsonl` | 一行一个 run 记录 |
 *
 * 权威字段定义来自 `src-tauri/src/task.rs`（Task / StatusTransition /
 * NotificationConfig / TaskEndConditions）与 `src-tauri/src/task_scheduler.rs`
 * （TaskRuntimeEntry / TaskRunRecord）。字段顺序也照 Rust 结构体声明顺序，
 * 这样两端交替写同一个文件时 diff 面最小。
 *
 * 本批次只做存储（读 / 写 / 崩溃恢复 / 运行态 / 执行历史）。HTTP 路由与调度器
 * 是 S2-S5；调度归属由 `ownership.ts` 的切流闸决定。
 *
 * 数据目录：统一 `getZhiShiDataDir()`（ZHISHI_DATA_DIR → ZHISHI_CONFIG_DIR →
 * `~/.zhishi`）。**已知差异**：Rust 另有便携模式探测（exe 旁 `.zhishi`），
 * Node 侧没有对应探测 —— 便携模式下必须由父进程注入 `ZHISHI_DATA_DIR` 才能
 * 对齐，否则两端会各自落在不同目录。本次不处理。
 *
 * 锁纪律：
 * - `tasks.jsonl`：`<dataDir>/tasks.jsonl.lock`。这是 Node 新增的跨进程锁
 *   （Rust 侧对 tasks.jsonl 只有进程内 RwLock，不认这个目录）—— 也就是说
 *   它只能互斥 Node 进程之间的写，挡不住"Rust 与 Node 同时写索引"。那要靠
 *   S0 的调度归属 + `ZHISHI_DATA_DIR` 对齐来约束。
 * - `task_runtime.json`：`<dataDir>/task_runtime.json.lock`，与 Rust
 *   `atomic_save_entries` 的锁路径**同名同址**，两端能真正互斥。
 * - `task_runs/<id>.jsonl`：`<dataDir>/task_runs/<id>.jsonl.lock`（Rust 侧
 *   追加逻辑不持锁，此处是 Node 自用的写互斥）。
 */

import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { withFileLock, writeFileAtomic } from 'zhishi-loop-core/file-lock';

import { getZhiShiDataDir } from '../../shared/app-dirs';
import { ensureDirSync } from '../utils/fs-utils';

// ============ 文件名 / 上限常量（照 Rust） ============

export const TASKS_INDEX_FILENAME = 'tasks.jsonl';
export const TASK_RUNTIME_FILENAME = 'task_runtime.json';
export const TASK_RUNS_DIRNAME = 'task_runs';
export const TASK_DOCS_DIRNAME = 'tasks';

/** 单任务执行历史保留行数（Rust `MAX_RUN_RECORDS`），超了整体截断。 */
export const MAX_RUN_RECORDS = 500;

/** `readRuns` 缺省返回条数（与 Rust `read_task_runs` 的常用入参一致）。 */
export const DEFAULT_RUN_READ_LIMIT = 100;

/**
 * 锁等待上限。file-lock 是 mkdir + 50ms 轮询；20 个并发写者排队时，
 * 默认 5s 在慢盘/杀软扫描下会假报 FILE_BUSY（Rust 侧同样是 5s，但那边是
 * 进程内 RwLock，不需要排队等盘）。
 */
const LOCK_TIMEOUT_MS = 20_000;

// ============ 类型（逐字段照搬 Rust） ============

export type TaskStatus =
  | 'todo'
  | 'running'
  | 'verifying'
  | 'done'
  | 'blocked'
  | 'stopped'
  | 'archived'
  /** 软删除审计用的伪状态：只有 delete 路径会写，且等价于 `deleted=true`。 */
  | 'deleted';

export type TaskExecutor = 'user' | 'agent';
export type TaskExecutionMode = 'once' | 'scheduled' | 'recurring' | 'loop';
/** kebab-case，与 Rust `TaskRunMode` 的 serde rename 一致（scheduler 层是 snake_case，边界转换）。 */
export type TaskRunMode = 'single-session' | 'new-session';
export type TaskDispatchOrigin = 'direct' | 'ai-aligned' | 'system';
/** LEGACY：Team Hub 已移除，仅为读旧数据保留。 */
export type DispatchTarget = 'local' | 'hub';
export type TransitionActor = 'system' | 'user' | 'agent';
export type TransitionSource =
  | 'cli'
  | 'ui'
  | 'watchdog'
  | 'crash'
  | 'scheduler'
  | 'endCondition'
  | 'rerun'
  | 'migration';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface StatusTransition {
  /** `null` = 建单之前的隐式初态（Rust `Option<TaskStatus>`，串行化成 null 而非缺字段）。 */
  from: TaskStatus | null;
  to: TaskStatus;
  at: number;
  actor: TransitionActor;
  message?: string;
  source?: TransitionSource;
}

export interface NotificationConfig {
  desktop: boolean;
  /** 缺省应为 `['done','blocked','endCondition']`；用可选保留"未指定"与"显式空"的区别。 */
  events?: string[];
}

export interface TaskEndConditions {
  /** 到点停跑（ms）。与 `dispatchAt`（到点开跑）语义无关。 */
  deadline?: number;
  maxExecutions?: number;
  aiCanExit: boolean;
}

export interface Task {
  id: string;
  name: string;
  executor: TaskExecutor;
  description?: string;
  workspaceId: string;
  /** 工作区绝对路径（sidecar cwd / AI bash 基准）。任务文档不在这里（见 docPath）。 */
  workspacePath: string;
  executionMode: TaskExecutionMode;
  /** DEPRECATED：旧 CronTask 投影指针，不再写入，仅为读旧行保留。 */
  cronTaskId?: string;
  runMode?: TaskRunMode;
  endConditions?: TaskEndConditions;
  intervalMinutes?: number;
  cronExpression?: string;
  cronTimezone?: string;
  /** Scheduled 模式的"何时开跑"（ms）。 */
  dispatchAt?: number;
  model?: string;
  providerId?: string;
  permissionMode?: string;
  preselectedSessionId?: string;
  runtime?: string;
  runtimeConfig?: JsonValue;
  mcpEnabledServers?: string[];
  sourceThoughtId?: string;
  sessionIds: string[];
  status: TaskStatus;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  lastExecutedAt?: number;
  statusHistory: StatusTransition[];
  notification?: NotificationConfig;
  dispatchOrigin: TaskDispatchOrigin;
  deleted: boolean;
  deletedAt?: number;
  dispatchTarget?: DispatchTarget;
  remoteTaskId?: string;
  remoteOriginNodeId?: string;
  remoteExecutorNodeId?: string;
}

/** 运行态条目（Rust `TaskRuntimeEntry`）。`lastExecutedAt` 是 RFC3339 字符串，不是 ms。 */
export interface TaskRuntimeEntry {
  taskId: string;
  /** sidecar 会话 key（new-session 模式每 tick 轮换）。 */
  sessionId: string;
  internalSessionId?: string;
  tabId?: string;
  executionCount: number;
  /** RFC3339 字符串（Rust `Option<DateTime<Utc>>`）。取毫秒请用 `toEpochMs`。 */
  lastExecutedAt?: string;
  /** 反范式化的上次运行摘要，列表页不必拆 task_runs JSONL。 */
  lastRunOk?: boolean;
  lastRunDurationMs?: number;
  exitReason?: string;
  armed: boolean;
}

/** 单次执行记录（Rust `TaskRunRecord`）。Rust 恒写 `content`/`error` 两键（None → null）。 */
export interface TaskRunRecord {
  ts: number;
  ok: boolean;
  durationMs: number;
  content?: string | null;
  error?: string | null;
}

/** 任务文档种类（对应 Rust `TaskDocs` 的四个字段）。 */
export type TaskDocKind = 'task' | 'verify' | 'progress' | 'alignment';

const TASK_DOC_FILENAMES: Record<TaskDocKind, string> = {
  task: 'task.md',
  verify: 'verify.md',
  progress: 'progress.md',
  alignment: 'alignment.md',
};

/**
 * 文档种类 → 文件名（照 Rust `task::task_doc_filename`）。未知种类返回 `null`
 * 而不是抛错：调用方（write-doc / read-doc）都要把"未知 doc"转成一条普通
 * 的成功=false 答复，不是异常。
 */
export function taskDocFilename(doc: string): string | null {
  return Object.prototype.hasOwnProperty.call(TASK_DOC_FILENAMES, doc)
    ? TASK_DOC_FILENAMES[doc as TaskDocKind]
    : null;
}

// ============ 枚举校验表 ============

const TASK_STATUSES: readonly TaskStatus[] = [
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
const DISPATCH_TARGETS: readonly DispatchTarget[] = ['local', 'hub'];
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

/** Rust 结构体字段声明顺序（写盘顺序对齐，两端交替写时 diff 最小）。 */
const TASK_FIELD_ORDER = [
  'id',
  'name',
  'executor',
  'description',
  'workspaceId',
  'workspacePath',
  'executionMode',
  'cronTaskId',
  'runMode',
  'endConditions',
  'intervalMinutes',
  'cronExpression',
  'cronTimezone',
  'dispatchAt',
  'model',
  'providerId',
  'permissionMode',
  'preselectedSessionId',
  'runtime',
  'runtimeConfig',
  'mcpEnabledServers',
  'sourceThoughtId',
  'sessionIds',
  'status',
  'tags',
  'createdAt',
  'updatedAt',
  'lastExecutedAt',
  'statusHistory',
  'notification',
  'dispatchOrigin',
  'deleted',
  'deletedAt',
  'dispatchTarget',
  'remoteTaskId',
  'remoteOriginNodeId',
  'remoteExecutorNodeId',
] as const;

const TASK_FIELD_SET: ReadonlySet<string> = new Set(TASK_FIELD_ORDER);

const RUNTIME_ENTRY_FIELD_ORDER = [
  'taskId',
  'sessionId',
  'internalSessionId',
  'tabId',
  'executionCount',
  'lastExecutedAt',
  'lastRunOk',
  'lastRunDurationMs',
  'exitReason',
  'armed',
] as const;

const RUNTIME_ENTRY_FIELD_SET: ReadonlySet<string> = new Set(RUNTIME_ENTRY_FIELD_ORDER);

// ============ 小工具 ============

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readTextIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * RFC3339 字符串 → epoch 毫秒；空/非法返回 `null`。
 *
 * 供调用方把运行态的 `lastExecutedAt` 换算成 ms。不用 `Number(str)`：
 * 运行态存的是 RFC3339（Rust `DateTime<Utc>` 的 serde 形态），不是数字。
 */
export function toEpochMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** epoch 毫秒 → RFC3339 字符串（UTC，`Z` 结尾，chrono 可直接反序列化）。 */
export function toRfc3339(ms: number): string {
  return new Date(ms).toISOString();
}

// ============ id 安全 ============

/** Windows 保留设备名（不区分大小写；`CON.json` 之类在本函数里已先被字符集拦下）。 */
const WINDOWS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * 校验 taskId 可以安全地拼进路径（`tasks/<id>/`、`task_runs/<id>.jsonl`）。
 * 逐条照搬 Rust `validate_safe_id`：长度、首字符、字符集、Windows 保留名。
 *
 * 为什么拒绝而不是像 Rust `sanitize_task_id` 那样"洗掉危险字符"：洗字符会让
 * 两个不同 id 落到同一个文件（`a/b` 与 `ab`），静默串号比直接报错危险得多。
 * 合法 id（UUID / 用户自定义 slug）本来就不会命中这些限制。
 */
export function assertSafeTaskId(id: string): string {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    throw new Error(`taskId 非法：为空或超过 128 字符（收到 ${JSON.stringify(id)}）`);
  }
  if (id.startsWith('.')) {
    throw new Error(`taskId 非法：不得以 '.' 开头（${JSON.stringify(id)}）`);
  }
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new Error(`taskId 非法：只允许 A-Z a-z 0-9 - _（收到 ${JSON.stringify(id)}）`);
  }
  const upper = id.toUpperCase();
  if (WINDOWS_RESERVED_NAMES.has(upper)) {
    throw new Error(`taskId 非法：命中 Windows 保留设备名（${upper}）`);
  }
  return id;
}

// ============ 序列化 ============

/**
 * 一行 Task → JSON 字符串。
 *
 * 两个纪律：
 * 1. **字段顺序照 Rust 结构体**，未知字段（未来 Rust 新增、本模块还不认识的）
 *    原样保留在末尾 —— 否则 Node 一次重写就会把 Rust 新加的字段静默抹掉。
 * 2. `deleted: false` 不写：Rust 侧是 `skip_serializing_if = "std::ops::Not::not"`，
 *    写成 `false` 虽仍能反序列化，但两端交替写会让文件出现无意义抖动。
 *    `undefined` 一律不写（对应 Rust 的 `skip_serializing_if = Option::is_none`）。
 */
function serializeTask(task: Task): string {
  const source = task as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of TASK_FIELD_ORDER) {
    const value = source[key];
    if (value === undefined) continue;
    if (key === 'deleted' && value === false) continue;
    out[key] = value;
  }
  for (const key of Object.keys(source)) {
    if (TASK_FIELD_SET.has(key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return JSON.stringify(out);
}

function serializeRuntimeEntry(entry: TaskRuntimeEntry): Record<string, unknown> {
  const source = entry as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of RUNTIME_ENTRY_FIELD_ORDER) {
    const value = source[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  // 同 Task：不认识的字段原样带走。S2 的典型流程是"读出运行态 → 改一条 →
  // 整份写回"，丢掉一个 Rust 侧的未知字段等于静默削掉对方的功能。
  for (const key of Object.keys(source)) {
    if (RUNTIME_ENTRY_FIELD_SET.has(key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** Rust 的 `TaskRunRecord` 无 skip 标注，`content`/`error` 恒出现（None → null）——同形写。 */
function serializeRunRecord(record: TaskRunRecord): string {
  return JSON.stringify({
    ts: record.ts,
    ok: record.ok,
    durationMs: record.durationMs,
    content: record.content ?? null,
    error: record.error ?? null,
  });
}

// ============ 反序列化 / 规范化 ============

function parseTransition(raw: unknown): StatusTransition {
  if (!isRecord(raw)) throw new Error('statusHistory 项不是对象');
  if (!isOneOf(raw.to, TASK_STATUSES)) throw new Error(`statusHistory.to 非法：${String(raw.to)}`);
  if (typeof raw.at !== 'number') throw new Error('statusHistory.at 不是数字');
  if (!isOneOf(raw.actor, TRANSITION_ACTORS)) {
    throw new Error(`statusHistory.actor 非法：${String(raw.actor)}`);
  }
  const from = raw.from === undefined || raw.from === null ? null : raw.from;
  if (from !== null && !isOneOf(from, TASK_STATUSES)) {
    throw new Error(`statusHistory.from 非法：${String(from)}`);
  }
  const transition: StatusTransition = { from, to: raw.to, at: raw.at, actor: raw.actor };
  if (typeof raw.message === 'string') transition.message = raw.message;
  if (raw.source !== undefined && raw.source !== null) {
    if (!isOneOf(raw.source, TRANSITION_SOURCES)) {
      throw new Error(`statusHistory.source 非法：${String(raw.source)}`);
    }
    transition.source = raw.source;
  }
  return transition;
}

function parseEndConditions(raw: unknown): TaskEndConditions {
  if (!isRecord(raw)) throw new Error('endConditions 不是对象');
  const out: TaskEndConditions = { aiCanExit: raw.aiCanExit !== false };
  if (typeof raw.deadline === 'number') out.deadline = raw.deadline;
  if (typeof raw.maxExecutions === 'number') out.maxExecutions = raw.maxExecutions;
  return out;
}

function parseNotification(raw: unknown): NotificationConfig {
  if (!isRecord(raw)) throw new Error('notification 不是对象');
  const out: NotificationConfig = { desktop: raw.desktop !== false };
  if (Array.isArray(raw.events)) out.events = raw.events.filter((e): e is string => typeof e === 'string');
  return out;
}

/**
 * 一行 JSONL → Task。
 *
 * 缺必填字段 / 枚举越界一律抛错，由调用方按"坏行跳过 + warn"处理 —— 与 Rust
 * serde 的严格度对齐（那边反序列化失败也是跳过整行）。已知但可缺的字段按
 * Rust 的 `serde(default)` 补默认值（workspacePath=''、sessionIds=[]、tags=[]、
 * statusHistory=[]、deleted=false）。
 */
function parseTaskRow(raw: unknown): Task {
  if (!isRecord(raw)) throw new Error('不是 JSON 对象');
  if (typeof raw.id !== 'string' || raw.id.length === 0) throw new Error('缺少 id');
  if (typeof raw.name !== 'string') throw new Error('缺少 name');
  if (!isOneOf(raw.executor, TASK_EXECUTORS)) throw new Error(`executor 非法：${String(raw.executor)}`);
  if (typeof raw.workspaceId !== 'string') throw new Error('缺少 workspaceId');
  if (!isOneOf(raw.executionMode, TASK_EXECUTION_MODES)) {
    throw new Error(`executionMode 非法：${String(raw.executionMode)}`);
  }
  if (!isOneOf(raw.status, TASK_STATUSES)) throw new Error(`status 非法：${String(raw.status)}`);
  if (!isOneOf(raw.dispatchOrigin, TASK_DISPATCH_ORIGINS)) {
    throw new Error(`dispatchOrigin 非法：${String(raw.dispatchOrigin)}`);
  }
  if (typeof raw.createdAt !== 'number') throw new Error('createdAt 不是数字');
  if (typeof raw.updatedAt !== 'number') throw new Error('updatedAt 不是数字');

  // 展开原对象：不认识的字段（未来 Rust 新增）原样带出去，重写时不丢。
  const task = { ...raw } as unknown as Task;
  task.id = raw.id;
  task.name = raw.name;
  task.executor = raw.executor;
  task.workspaceId = raw.workspaceId;
  task.workspacePath = typeof raw.workspacePath === 'string' ? raw.workspacePath : '';
  task.executionMode = raw.executionMode;
  task.status = raw.status;
  task.dispatchOrigin = raw.dispatchOrigin;
  task.createdAt = raw.createdAt;
  task.updatedAt = raw.updatedAt;
  task.sessionIds = Array.isArray(raw.sessionIds)
    ? raw.sessionIds.filter((v): v is string => typeof v === 'string')
    : [];
  task.tags = Array.isArray(raw.tags) ? raw.tags.filter((v): v is string => typeof v === 'string') : [];
  task.statusHistory = Array.isArray(raw.statusHistory) ? raw.statusHistory.map(parseTransition) : [];
  task.deleted = raw.deleted === true;
  if (raw.runMode !== undefined && raw.runMode !== null) {
    if (!isOneOf(raw.runMode, TASK_RUN_MODES)) throw new Error(`runMode 非法：${String(raw.runMode)}`);
    task.runMode = raw.runMode;
  }
  if (raw.dispatchTarget !== undefined && raw.dispatchTarget !== null) {
    if (!isOneOf(raw.dispatchTarget, DISPATCH_TARGETS)) {
      throw new Error(`dispatchTarget 非法：${String(raw.dispatchTarget)}`);
    }
    task.dispatchTarget = raw.dispatchTarget;
  }
  if (raw.endConditions !== undefined && raw.endConditions !== null) {
    task.endConditions = parseEndConditions(raw.endConditions);
  }
  if (raw.notification !== undefined && raw.notification !== null) {
    task.notification = parseNotification(raw.notification);
  }
  return task;
}

function parseRuntimeEntry(raw: unknown): TaskRuntimeEntry {
  if (!isRecord(raw)) throw new Error('运行态条目不是对象');
  if (typeof raw.taskId !== 'string' || raw.taskId.length === 0) throw new Error('运行态条目缺少 taskId');
  if (typeof raw.sessionId !== 'string') throw new Error('运行态条目缺少 sessionId');
  const entry: TaskRuntimeEntry = {
    taskId: raw.taskId,
    sessionId: raw.sessionId,
    executionCount: typeof raw.executionCount === 'number' ? raw.executionCount : 0,
    armed: raw.armed === true,
  };
  if (typeof raw.internalSessionId === 'string') entry.internalSessionId = raw.internalSessionId;
  if (typeof raw.tabId === 'string') entry.tabId = raw.tabId;
  if (typeof raw.lastExecutedAt === 'string') entry.lastExecutedAt = raw.lastExecutedAt;
  if (typeof raw.lastRunOk === 'boolean') entry.lastRunOk = raw.lastRunOk;
  if (typeof raw.lastRunDurationMs === 'number') entry.lastRunDurationMs = raw.lastRunDurationMs;
  if (typeof raw.exitReason === 'string') entry.exitReason = raw.exitReason;
  // 与 Task 同策略：不认识的字段原样带着，"读出来 → 改一条 → 整份写回"不会
  // 悄悄削掉 Rust 侧新增的字段。
  const extras = entry as unknown as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (RUNTIME_ENTRY_FIELD_SET.has(key)) continue;
    extras[key] = raw[key];
  }
  return entry;
}

/** 按 createdAt 升序（同毫秒用 id 兜底，保证两端口径一致的确定性顺序）。 */
function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * 同步读整份运行态（锁内/锁外都可用：它只读，不改）。
 * 文件缺失 → 空表；整体坏 JSON / `entries` 不是数组 → warn 后空表（与 Rust
 * `load_entries_from_file` 的"整份不可信就弃用"一致，且**不覆盖原文件**——
 * 用户的运行态可能只是被手改坏了，下次写才修）；单条坏条目只跳过该条。
 */
function readRuntimeFileSync(path: string): TaskRuntimeEntry[] {
  const text = readTextIfExists(path);
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch (err) {
    console.warn(
      `[task-store] ${TASK_RUNTIME_FILENAME} 解析失败，按空运行态处理（文件保留原样）：${errMessage(err)}`
    );
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
    console.warn(`[task-store] ${TASK_RUNTIME_FILENAME} 缺少 entries 数组，按空运行态处理`);
    return [];
  }
  const entries: TaskRuntimeEntry[] = [];
  parsed.entries.forEach((raw, index) => {
    try {
      entries.push(parseRuntimeEntry(raw));
    } catch (err) {
      console.warn(
        `[task-store] ${TASK_RUNTIME_FILENAME} entries[${index}] 无法解析，已跳过：${errMessage(err)}`
      );
    }
  });
  return entries.sort((a, b) => a.taskId.localeCompare(b.taskId));
}

// ============ 崩溃恢复 ============

/** 恢复记录文案，与 Rust `task.rs` load_and_recover 完全一致（半角逗号）。 */
const CRASH_MESSAGE_KEEP_RUNNING = '上次运行被应用重启中断,调度器将在下次计划时间继续触发';
const CRASH_MESSAGE_BLOCKED = '上次运行被应用重启中断,可重新派发以继续';

export interface CrashRecoveryOutcome {
  tasks: Task[];
  /** 有任务被改写时需要立即写回，否则第二次崩溃会丢掉迁移结果（同 Rust `needs_rewrite`）。 */
  changed: boolean;
}

function crashTransition(from: TaskStatus, to: TaskStatus, at: number, message: string): StatusTransition {
  return { from, to, at, actor: 'system', message, source: 'crash' };
}

/**
 * 崩溃恢复矩阵（照 Rust `task.rs:775-879`）：
 *
 * | (status, executionMode)        | 结果 |
 * |---|---|
 * | (running, recurring / loop)    | 保持 running，追加一条 from==to 的自环审计 |
 * | 其它 running（once / scheduled）| 改 blocked + 一条 crash 记录 |
 * | 任何 verifying                  | 改 blocked + 一条 crash 记录 |
 *
 * 为什么这么分：
 *
 * - `running × recurring|loop`：这条任务的时间表还活着，调度器到点自然会再触发，
 *   它属于「进行中」而不是「已阻塞」。原状态本来就该是 running，所以只补一条
 *   from==to 的审计记录（前端渲染成不带箭头的事件点）。
 * - `verifying × 任意模式`：verifying 是交棒态（AI 跑完、等验收）。静默降级回
 *   running 会丢掉"已完成待验收"这个语义，下一次 tick 可能直接重跑 —— 烧 token
 *   且副作用重复。抬到 blocked 让用户显式重新验收更安全。
 * - `running × once|scheduled`：它们的触发窗口要么已经过去（死在执行中），
 *   要么本来就是一次性显式时刻，重跑语义不明确，需要用户介入。
 *
 * 幂等：若最后一条历史已经是同款崩溃自环（source=crash 且 from==to），不再追加。
 * 原因很实在 —— 笔记本合盖/开盖、每天一次重启，每次启动都会跑一遍恢复；
 * 不去重就会写出 20+ 条一模一样的"上次运行被中断"，把真正有意义的迁移淹没掉。
 * 一旦调度器真的 tick 过一次（写入非 crash 的迁移），下次崩溃就会重新写一条
 * —— 那一条才带真信息（"上次开机之后跑过、然后被打断"）。
 */
export function applyCrashRecovery(tasks: readonly Task[], now: number = Date.now()): CrashRecoveryOutcome {
  let changed = false;
  const recovered = tasks.map((task): Task => {
    if (task.status !== 'running' && task.status !== 'verifying') return task;
    const from = task.status;
    const history = task.statusHistory ?? [];

    const keepRunning = from === 'running' && (task.executionMode === 'recurring' || task.executionMode === 'loop');
    if (keepRunning) {
      const last = history[history.length - 1];
      const lastIsCrashSelfLoop = last !== undefined && last.source === 'crash' && last.from === last.to;
      if (lastIsCrashSelfLoop) return task;
      changed = true;
      return {
        ...task,
        updatedAt: now,
        statusHistory: [...history, crashTransition(from, 'running', now, CRASH_MESSAGE_KEEP_RUNNING)],
      };
    }

    changed = true;
    return {
      ...task,
      status: 'blocked',
      updatedAt: now,
      statusHistory: [...history, crashTransition(from, 'blocked', now, CRASH_MESSAGE_BLOCKED)],
    };
  });
  return { tasks: recovered, changed };
}

// ============ Store ============

export interface TaskStoreOptions {
  /** 数据目录。缺省 `getZhiShiDataDir()`；单测必须显式传临时目录。 */
  dataDir?: string;
}

/**
 * `mutate` 找不到目标行时抛这个（调用方转成 `{success:false, error:'not_found'}`）。
 *
 * 为什么用异常而不是返回 `undefined`：`undefined` 会和 "updater 决定不写" 的
 * `null` 撞语义——调用方分不清"任务不存在"和"任务存在但本次无变更"，而这两者
 * 的对外回答完全不同（前者必须报错）。
 */
export class TaskNotFoundError extends Error {
  readonly code = 'not_found';
  readonly taskId: string;

  constructor(taskId: string) {
    super(`task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
    this.taskId = taskId;
  }
}

/**
 * 任务存储。无内存缓存：每次读写都直接看盘上文件 —— 迁移期 Rust 与 Node
 * 都会改同一批文件，缓存只会让一侧看到过期快照。JSONL 全表重写本来就是
 * Rust 的做法，量级（几十~几百行）不值得引入缓存复杂度。
 */
export class TaskStore {
  readonly dataDir: string;

  constructor(options: TaskStoreOptions = {}) {
    this.dataDir = options.dataDir ?? getZhiShiDataDir();
  }

  get tasksIndexPath(): string {
    return join(this.dataDir, TASKS_INDEX_FILENAME);
  }

  get runtimePath(): string {
    return join(this.dataDir, TASK_RUNTIME_FILENAME);
  }

  get runsDir(): string {
    return join(this.dataDir, TASK_RUNS_DIRNAME);
  }

  get docsRoot(): string {
    return join(this.dataDir, TASK_DOCS_DIRNAME);
  }

  // ---- 内部：读写（**调用方必须持锁**或确认无并发） ----

  private readTasksFromDisk(): Task[] {
    const text = readTextIfExists(this.tasksIndexPath);
    if (text === null) return [];
    const body = stripBom(text);
    if (body.trim() === '') return [];

    const byId = new Map<string, Task>();
    body.split('\n').forEach((line, index) => {
      const raw = line.trim();
      if (raw === '') return;
      try {
        const task = parseTaskRow(JSON.parse(raw));
        // 同 id 后者覆盖：与 Rust `HashMap::insert` 语义一致。
        byId.set(task.id, task);
      } catch (err) {
        console.warn(
          `[task-store] ${TASKS_INDEX_FILENAME} 第 ${index + 1} 行无法解析，已跳过：${errMessage(err)}`
        );
      }
    });
    return sortTasks([...byId.values()]);
  }

  private writeTasksUnlocked(tasks: readonly Task[]): void {
    ensureDirSync(this.dataDir);
    const body = sortTasks(tasks)
      .map((task) => `${serializeTask(task)}\n`)
      .join('');
    writeFileAtomic(this.tasksIndexPath, body);
  }

  private async withTasksLock<T>(op: () => T | Promise<T>): Promise<T> {
    ensureDirSync(this.dataDir);
    return withFileLock({ lockPath: `${this.tasksIndexPath}.lock`, timeoutMs: LOCK_TIMEOUT_MS }, () =>
      Promise.resolve(op())
    );
  }

  // ---- 任务索引 ----

  /**
   * 读全表并跑崩溃恢复；恢复有改动时**立即写回**（同 Rust `TaskStore::new`），
   * 否则第二次崩溃会丢掉这次迁移结果。返回按 createdAt 升序的任务列表。
   *
   * 无恢复需求时走无锁快路径：读路径占绝大多数（S2 的列表/详情），不该为了
   * 读一次干净文件去抢 mkdir 锁。真需要写回时才拿锁，并在**锁内重新读一遍**
   * —— 否则会把并发写者刚追加的行盖掉。
   */
  async load(): Promise<Task[]> {
    const quick = applyCrashRecovery(this.readTasksFromDisk());
    if (!quick.changed) return quick.tasks;
    return this.withTasksLock(() => {
      const { tasks, changed } = applyCrashRecovery(this.readTasksFromDisk());
      if (changed) {
        this.writeTasksUnlocked(tasks);
        console.warn(
          '[task-store] 崩溃恢复已应用：遗留 running/verifying 按矩阵改写（recurring/loop 保持 running，其余转 blocked）'
        );
      }
      return tasks;
    });
  }

  /** 按 id 查一条。读路径不校验 id（纯查表不会碰到路径），找不到返回 undefined。 */
  async get(id: string): Promise<Task | undefined> {
    return (await this.load()).find((task) => task.id === id);
  }

  /**
   * 读全表但**不跑崩溃恢复**。
   *
   * 给调度器这类"每 tick 都要读一遍"的调用方用：崩溃恢复的语义是"进程启动时
   * 把上一个进程留下的 Running 残留态改写一次"，不是"每次读盘都把 running 行
   * 改成 blocked"。后者会误伤活着的任务（`running × once` 的行在恢复矩阵里
   * 正好是转 blocked 的那一格 —— 一次 `task list` 就能把正在跑的一次性任务
   * 判死）。
   */
  async loadRaw(): Promise<Task[]> {
    return this.readTasksFromDisk();
  }

  /** 按 id 读一条，不跑崩溃恢复（调度器专用，理由见 `loadRaw`）。 */
  async getRaw(id: string): Promise<Task | undefined> {
    return (await this.readTasksFromDisk()).find((task) => task.id === id);
  }

  /**
   * 写入一条任务：存在则整条覆盖（同 id 不产生重复行），并按 createdAt 升序整表重写。
   *
   * 读-改-写全程持锁，且**在锁内重新读盘**，所以 20 个并发写者不会互相盖掉
   * 对方新增的行（这是 S2 建单接口的落盘原语）。
   */
  async upsert(task: Task): Promise<Task> {
    assertSafeTaskId(task.id);
    return this.withTasksLock(() => {
      const byId = new Map(this.readTasksFromDisk().map((row) => [row.id, row] as const));
      byId.set(task.id, task);
      this.writeTasksUnlocked([...byId.values()]);
      return task;
    });
  }

  /**
   * 在文件锁内做 read-modify-write：读索引 → 交给 `updater` 改 → 整表原子写。
   *
   * 为什么必须有这个原语（而不是 `get()` + `upsert()`）：那两步各自拿锁，
   * 中间夹着别的写者时，后写的会拿着过期快照整表覆盖 —— 丢更新。S3 的
   * `update-status` / `append-session` / `delete` / `write-doc` 全是
   * "读一条、改一点、写回去"，必须走这一条。
   *
   * `updater` 返回 `null` = 本次无变更，跳过写盘（幂等分支用：重复 delete /
   * 重复 append-session 不该产生一次无意义的整表重写）。
   *
   * 找不到 id 抛 `TaskNotFoundError`；`updater` 里抛的错误原样外抛（锁由
   * `withFileLock` 的 finally 释放），所以守卫（running/deleted）可以在
   * updater 内直接 throw。
   */
  async mutate(id: string, updater: (task: Task) => Task | null): Promise<Task | null> {
    assertSafeTaskId(id);
    return this.withTasksLock(() => {
      const byId = new Map(this.readTasksFromDisk().map((row) => [row.id, row] as const));
      const current = byId.get(id);
      if (current === undefined) throw new TaskNotFoundError(id);
      const next = updater(current);
      if (next === null) return null;
      byId.set(next.id, next);
      this.writeTasksUnlocked([...byId.values()]);
      return next;
    });
  }

  /**
   * 直接删掉一行索引（**硬删**，仅用于建单失败回滚；用户删除走软删语义）。
   * 返回是否真的删掉了。S3 的 `create-from-alignment` 在"行已落盘、文档目录
   * 搬移失败"时用它回滚，对齐 Rust 的同名补偿逻辑。
   */
  async remove(id: string): Promise<boolean> {
    assertSafeTaskId(id);
    return this.withTasksLock(() => {
      const byId = new Map(this.readTasksFromDisk().map((row) => [row.id, row] as const));
      if (!byId.delete(id)) return false;
      this.writeTasksUnlocked([...byId.values()]);
      return true;
    });
  }

  // ---- 运行态 ----

  /**
   * 读运行态。文件缺失 → 空表；整体 JSON 坏 / `entries` 不是数组 → warn 后空表
   * （与 Rust `load_entries_from_file` 一致的"整份不可信就弃用"策略）；单条坏
   * 条目只跳过该条，不影响其它任务的运行态。
   */
  async readRuntime(): Promise<TaskRuntimeEntry[]> {
    return readRuntimeFileSync(this.runtimePath);
  }

  /**
   * 整份重写运行态。锁路径与 Rust `atomic_save_entries` 同名同址
   * （`task_runtime.json.lock`），两端能互斥。按 taskId 排序保证写盘确定性。
   */
  async writeRuntime(entries: readonly TaskRuntimeEntry[]): Promise<void> {
    await withFileLock(
      { lockPath: `${this.runtimePath}.lock`, timeoutMs: LOCK_TIMEOUT_MS },
      async () => {
        this.writeRuntimeUnlocked(entries);
      }
    );
  }

  /** 锁内写（调用方必须已持 `task_runtime.json.lock`）。 */
  private writeRuntimeUnlocked(entries: readonly TaskRuntimeEntry[]): void {
    ensureDirSync(this.dataDir);
    const sorted = [...entries].sort((a, b) => a.taskId.localeCompare(b.taskId));
    const payload = {
      entries: sorted.map((entry) => serializeRuntimeEntry(entry)),
    };
    writeFileAtomic(this.runtimePath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  /**
   * 从运行态里摘掉一条（软删任务时用）。条目本来就不在 → 不写盘（幂等）。
   *
   * 为什么软删必须摘条目：调度器按运行态里的 `armed` 决定要不要继续 tick，
   * 留着一条指向已删任务的条目等于"幽灵任务"继续烧 token（Rust
   * `on_task_deleted` 的同一动机）。
   */
  async removeRuntimeEntry(taskId: string): Promise<boolean> {
    assertSafeTaskId(taskId);
    ensureDirSync(this.dataDir);
    return withFileLock(
      { lockPath: `${this.runtimePath}.lock`, timeoutMs: LOCK_TIMEOUT_MS },
      async () => {
        const entries = readRuntimeFileSync(this.runtimePath);
        const kept = entries.filter((entry) => entry.taskId !== taskId);
        if (kept.length === entries.length) return false;
        this.writeRuntimeUnlocked(kept);
        return true;
      }
    );
  }

  /**
   * 锁内读改写运行态里的一条（S4 调度器的记账原语）。
   *
   * `updater` 收到当前条目（不存在 → `undefined`），返回 `null` = 不写盘。
   * 为什么要这个而不是 `readRuntime()` + `writeRuntime()`：两步各自拿锁，
   * 中间被别的写者（另一个调度 tick / S3 的 delete 清理）插进来就会互相覆盖；
   * 而且调度器若把运行态缓存在内存里再整份写回，会把已被删除的条目复活。
   */
  async updateRuntimeEntry(
    taskId: string,
    updater: (entry: TaskRuntimeEntry | undefined) => TaskRuntimeEntry | null
  ): Promise<TaskRuntimeEntry | null> {
    assertSafeTaskId(taskId);
    ensureDirSync(this.dataDir);
    return withFileLock(
      { lockPath: `${this.runtimePath}.lock`, timeoutMs: LOCK_TIMEOUT_MS },
      async () => {
        const entries = readRuntimeFileSync(this.runtimePath);
        const index = entries.findIndex((entry) => entry.taskId === taskId);
        const current = index >= 0 ? entries[index] : undefined;
        const next = updater(current);
        if (next === null) return null;
        if (index >= 0) entries[index] = next;
        else entries.push(next);
        this.writeRuntimeUnlocked(entries);
        return next;
      }
    );
  }

  // ---- 执行历史 ----

  private runPath(taskId: string): string {
    return join(this.runsDir, `${assertSafeTaskId(taskId)}.jsonl`);
  }

  /**
   * 追加一条执行记录；超过 `MAX_RUN_RECORDS` 行整体截断为最近 500 行。
   *
   * 追加与截断在**同一把锁**里：否则两个并发追加可能一个刚追加完、另一个
   * 正在截断（读-改-写），把新行吞掉。
   */
  async appendRun(taskId: string, record: TaskRunRecord): Promise<void> {
    const path = this.runPath(taskId);
    ensureDirSync(dirname(path));
    await withFileLock({ lockPath: `${path}.lock`, timeoutMs: LOCK_TIMEOUT_MS }, async () => {
      appendFileSync(path, `${serializeRunRecord(record)}\n`, 'utf-8');
      this.truncateRuns(path);
    });
  }

  private truncateRuns(path: string): void {
    const text = readTextIfExists(path);
    if (text === null) return;
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    if (lines.length <= MAX_RUN_RECORDS) return;
    writeFileAtomic(path, `${lines.slice(lines.length - MAX_RUN_RECORDS).join('\n')}\n`);
  }

  /**
   * 删掉某任务的执行历史文件（软删任务时用）。不存在 → 什么都不做。
   * 与 Rust `task_scheduler::on_task_deleted` 对齐：任务没了，历史跟着走。
   */
  async removeRunHistory(taskId: string): Promise<void> {
    const path = this.runPath(taskId);
    // 目录可能压根不存在（这条任务从没跑过）—— file-lock 的 mkdir 是
    // 非递归的，父目录缺了会 ENOENT，所以先建目录再抢锁。
    ensureDirSync(dirname(path));
    await withFileLock({ lockPath: `${path}.lock`, timeoutMs: LOCK_TIMEOUT_MS }, async () => {
      rmSync(path, { force: true });
    });
  }

  /**
   * 读最近 `limit` 条执行记录，按时间顺序返回。坏行 warn 后跳过。
   * 上限取 `MAX_RUN_RECORDS`（500，即文件本身的保留行数）。
   */
  async readRuns(taskId: string, limit: number = DEFAULT_RUN_READ_LIMIT): Promise<TaskRunRecord[]> {
    const path = this.runPath(taskId);
    const text = readTextIfExists(path);
    if (text === null) return [];
    const cap = Math.max(1, Math.min(Math.floor(limit), MAX_RUN_RECORDS));
    const lines = stripBom(text)
      .split('\n')
      .filter((line) => line.trim() !== '');
    const tail = lines.slice(Math.max(0, lines.length - cap));
    const records: TaskRunRecord[] = [];
    tail.forEach((line, index) => {
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed) || typeof parsed.ts !== 'number' || typeof parsed.ok !== 'boolean') {
          throw new Error('缺少 ts/ok');
        }
        const record: TaskRunRecord = {
          ts: parsed.ts,
          ok: parsed.ok,
          durationMs: typeof parsed.durationMs === 'number' ? parsed.durationMs : 0,
          content: typeof parsed.content === 'string' ? parsed.content : null,
          error: typeof parsed.error === 'string' ? parsed.error : null,
        };
        records.push(record);
      } catch (err) {
        console.warn(
          `[task-store] task_runs/${taskId}.jsonl 尾部第 ${index + 1} 行无法解析，已跳过：${errMessage(err)}`
        );
      }
    });
    return records;
  }

  // ---- 文档路径 ----

  /**
   * 任务文档目录 `<dataDir>/tasks/<id>/`。解析后仍要满足"落在 tasks/ 之内"，
   * 这是 Rust `task_docs_dir` 的 defense-in-depth（校验器将来被削弱时兜住）。
   */
  docsDirFor(taskId: string): string {
    assertSafeTaskId(taskId);
    const base = resolve(this.docsRoot);
    const dir = resolve(join(base, taskId));
    if (!dir.startsWith(base)) {
      throw new Error(`task docs dir 越界：${dir}（base=${base}）`);
    }
    return dir;
  }

  /**
   * 任务文档绝对路径。本批次只做路径解析 + 安全校验，读写业务留给后续批次
   * （skill / Agent 直接用文件工具读写这四个文件）。
   */
  docPath(taskId: string, doc: TaskDocKind): string {
    const filename = TASK_DOC_FILENAMES[doc];
    if (filename === undefined) {
      throw new Error(`未知的文档种类：${JSON.stringify(doc)}`);
    }
    return join(this.docsDirFor(taskId), filename);
  }
}

export function createTaskStore(options: TaskStoreOptions = {}): TaskStore {
  return new TaskStore(options);
}

/** 任务文档的绝对路径集合（形状照 Rust `TaskDocs`）。 */
export interface TaskDocs {
  dir: string;
  /** task.md：建单时必写，所以恒有。 */
  taskMd: string;
  /** 其余三份**只有文件真存在才给路径**（= "AI 已开工"的信号）。 */
  verifyMd?: string;
  progressMd?: string;
  alignmentMd?: string;
}

/**
 * 解析四份文档的绝对路径，只对存在的可选文件给路径 —— 调用方据此区分
 * "新任务"与"AI 已经在写验收/进度"，不用自己 stat 一轮。
 */
export function buildTaskDocs(store: TaskStore, taskId: string): TaskDocs {
  const docs: TaskDocs = {
    dir: store.docsDirFor(taskId),
    taskMd: store.docPath(taskId, 'task'),
  };
  const optional: ReadonlyArray<readonly [keyof TaskDocs, TaskDocKind]> = [
    ['verifyMd', 'verify'],
    ['progressMd', 'progress'],
    ['alignmentMd', 'alignment'],
  ];
  for (const [field, kind] of optional) {
    const path = store.docPath(taskId, kind);
    if (existsSync(path)) (docs as unknown as Record<string, string>)[field] = path;
  }
  return docs;
}
