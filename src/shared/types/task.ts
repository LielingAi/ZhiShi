// Task types (v0.1.69 Task Center)

// Workspace-scoped execution units. Persisted to ~/.zhishi/tasks.jsonl.

// Associated markdown documents live under <workspace>/.task/<taskId>/.

// See PRD §3.2 for the full schema and §9.1 for the state machine.



import type { RuntimeType } from './runtime';



/**

 * Task status — see PRD §9.1 state machine.

 *

 * `'deleted'` is a synthetic pseudo-state used only as the `to` of a soft-delete

 * audit entry (PRD §10.2.2) — it is never accepted as the target of

 * `update-status` and a task whose `status === 'deleted'` is equivalent to

 * `deleted === true` (filtered out of list queries by default).

 */

export type TaskStatus =

  | 'todo'

  | 'running'

  | 'verifying'

  | 'done'

  | 'blocked'

  | 'stopped'

  | 'archived'

  | 'deleted';



/** Who actually triggered the transition. */

export type TransitionActor = 'system' | 'user' | 'agent';



/** Fine-grained transition source for audit/statistics. */

export type TransitionSource =

  | 'cli'

  | 'ui'

  | 'watchdog'

  | 'crash'

  | 'scheduler'

  | 'endCondition'

  | 'rerun'

  | 'migration';



/** Execution mode — see PRD §9.2. */

export type TaskExecutionMode = 'once' | 'scheduled' | 'recurring' | 'loop';



/** Session strategy across multiple runs. Mirrors cron_task.rs `RunMode`. */

export type TaskRunMode = 'single-session' | 'new-session';



/** Who is responsible for carrying out the task. */

export type TaskExecutor = 'user' | 'agent';



/**

 * How the task was created — governs the initial prompt construction on dispatch

 * (see PRD §9.3.1) and which of the four `.task/` files are expected to exist.

 */

export type TaskDispatchOrigin = 'direct' | 'ai-aligned';



/** Where a task should be executed / synced. */

export type DispatchTarget = 'local' | 'hub';



/** One append-only entry in `Task.statusHistory`. See PRD §3.2. */

export interface StatusTransition {

  from: TaskStatus | null;

  to: TaskStatus;

  /** Timestamp (ms since epoch) */

  at: number;

  actor: TransitionActor;

  /** Free-form note; all target states can carry a message. */

  message?: string;

  source?: TransitionSource;

}



/** Auto-termination conditions for recurring/loop tasks. Mirrors cron_task.rs `EndConditions`. */

export interface EndConditions {

  /** Absolute timestamp (ms). After this point, no new round starts. */

  deadline?: number;

  /** Cap on total rounds run. */

  maxExecutions?: number;

  /** Whether AI may call `task update-status done` to exit a loop. Default `true`. */

  aiCanExit: boolean;

}



/** Per-task notification configuration. Falls back to global defaults when `null`. */

export interface NotificationConfig {

  /** Show OS desktop notification. Default `true`. */

  desktop: boolean;

  /**

   * Which transitions trigger a push.

   * Default: `['done', 'blocked', 'endCondition']`. Loop single-round completion is NOT a

   * status change and therefore not listed (see PRD §11.5).

   */

  events?: Array<'done' | 'blocked' | 'stopped' | 'verifying' | 'endCondition'>;

}



/** Runtime-scoped config snapshot captured at dispatch. */

export interface RuntimeConfigSnapshot {

  model?: string;

  permissionMode?: string;

  [key: string]: unknown;

}



/** A Task — workspace-scoped execution unit. */

export interface Task {

  id: string;

  name: string;

  executor: TaskExecutor;

  description?: string;

  workspaceId: string;

  /**

   * Absolute filesystem path of the workspace. Captured at create time so

   * background executors (scheduler, CLI) can locate `.task/<id>/` without

   * re-resolving the workspace. Not meant for UI display — prefer `workspaceId`.

   */

  workspacePath?: string;

  executionMode: TaskExecutionMode;

  /** Points into CronTaskManager when executionMode is scheduled/recurring/loop. */

  cronTaskId?: string;

  runMode?: TaskRunMode;

  endConditions?: EndConditions;

  /** Recurring-mode fixed interval (minutes). Simple mode; mutually exclusive with `cronExpression`. */

  intervalMinutes?: number;

  /** Advanced-mode cron expression. Takes precedence over `intervalMinutes` when set. */

  cronExpression?: string;

  /** IANA timezone id for `cronExpression` (e.g. `Asia/Shanghai`). */

  cronTimezone?: string;

  /** Dedicated "when to fire" timestamp (ms) for `scheduled` mode. Decouples from `endConditions.deadline`. */

  dispatchAt?: number;

  /** Per-task model override. When absent, the Agent's default model is used.

   *

   *  PRD 0.2.9 pairing rule (asymmetric, by design): setting `providerId`

   *  REQUIRES `model` — the validator rejects provider-without-model so a

   *  user that picked a specific provider can't end up routing the Agent's

   *  default model name to the wrong upstream. The reverse is allowed:

   *  setting `model` alone means "use the Agent's currently-resolved

   *  provider but override the model id" — the renderer's grouped picker

   *  writes a `(providerId, model)` pair atomically; the model-only form

   *  is reachable only via the CLI / management API for legacy / advanced

   *  use. */

  model?: string;

  /** PRD 0.2.9 — Per-task provider id override. When absent, the cron follows

   *  the workspace agent. When set, the sidecar live-resolves the provider

   *  env from `~/.zhishi/config.json` on every tick, so credential

   *  rotation propagates without re-saving the task and no credential

   *  copies land in `~/.zhishi/tasks/...jsonl`.

   *

   *  Mutually exclusive with external runtime (`runtime ∈ {claude-code,

   *  codex, gemini}`) — those runtimes manage their own provider; the Rust

   *  validator rejects the combination. */

  providerId?: string;

  /** Per-task permission mode (auto / plan / fullAgency / …). Defaults to

   *  the **runtime maximum** (e.g. SDK builtin → `bypassPermissions`) rather

   *  than the Agent's default — see PRD 0.2.4 §需求 4 (4b note). */

  permissionMode?: string;

  /** For `single-session` run mode: id of a pre-existing SDK session to continue. */

  preselectedSessionId?: string;

  runtime?: RuntimeType;

  runtimeConfig?: RuntimeConfigSnapshot;

  /** Per-task MCP enable list override. `undefined` = follow Agent workspace.

   *  `[]` = explicitly run with no MCP servers. PRD 0.2.4 §需求 4 (4a). */

  mcpEnabledServers?: string[];

  /** Set only when the task was created from a Thought (v0.1.69 softened: Thought ↔ Task is loosely coupled). */

  sourceThoughtId?: string;

  sessionIds: string[];

  status: TaskStatus;

  tags: string[];

  createdAt: number;

  updatedAt: number;

  lastExecutedAt?: number;

  /** Append-only audit log of status changes. See PRD §3.2 / §10.2.1. */

  statusHistory: StatusTransition[];

  notification?: NotificationConfig;

  /** How the task was created; governs first-message construction. See PRD §9.3.1. */

  dispatchOrigin: TaskDispatchOrigin;

  /** Team Hub sync target. `hub` means this task is mirrored with the Team Hub. */

  dispatchTarget?: DispatchTarget;

  /** Hub-side task id when `dispatchTarget === 'hub'`. */

  remoteTaskId?: string;

  /** Hub-side origin node id when `dispatchTarget === 'hub'`. */

  remoteOriginNodeId?: string;

  /** Hub-side executor node id when `dispatchTarget === 'hub'`. */

  remoteExecutorNodeId?: string;

  /** Set to `true` by `task delete` (soft delete with 30-day retention, §9.5). */

  deleted?: boolean;

  /** Set when `deleted = true`. Used for retention cleanup. */

  deletedAt?: number;

  /** Absolute paths to the four task markdown docs. Populated by

   *  `cmd_task_get` / `/api/task/get` at read time (not persisted) — the

   *  consumer (CLI, AI, UI) reads the files directly via Read/Edit/Write

   *  rather than going through dedicated read-doc / write-doc commands.

   *  Only existing files are surfaced (except `taskMd`, always present

   *  at creation time). See Rust `TaskDocs` for semantics. */

  docs?: TaskDocs;

}



/** Absolute paths to a task's markdown docs. Returned alongside a [`Task`]

 *  by `cmd_task_get` so the AI / CLI can `Read` / `Edit` / `Write` them

 *  directly. Only existing files are surfaced (task.md is always created

 *  at task-creation time, so it's always present). */

export interface TaskDocs {

  /** Absolute path to the docs directory: `~/.zhishi/tasks/<id>/`. */

  dir: string;

  /** `task.md` — always present; the task's instruction/prompt body. */

  taskMd: string;

  /** `verify.md` — present once the AI or user has written verification rules. */

  verifyMd?: string;

  /** `progress.md` — present once the AI has started recording execution progress. */

  progressMd?: string;

  /** `alignment.md` — present when the task was created via `/task-alignment`. */

  alignmentMd?: string;

}



/** Payload for `cmd_task_create_direct` (PRD §10.2.2). */

export interface TaskCreateDirectInput {

  name: string;

  executor: TaskExecutor;

  description?: string;

  workspaceId: string;

  workspacePath: string;

  taskMdContent: string;

  executionMode: TaskExecutionMode;

  runMode?: TaskRunMode;

  endConditions?: EndConditions;

  /** Recurring-mode fixed interval (minutes). Mutually exclusive with `cronExpression`. */

  intervalMinutes?: number;

  /** Advanced-mode cron expression. Takes precedence over `intervalMinutes` when set. */

  cronExpression?: string;

  /** IANA timezone id for `cronExpression`. */

  cronTimezone?: string;

  /** Fire time for `scheduled` mode (ms epoch). */

  dispatchAt?: number;

  /** Per-task model override. */

  model?: string;

  /** PRD 0.2.9 — Per-task provider id override. MUST be paired with `model`. */

  providerId?: string;

  /** Per-task permission mode override. */

  permissionMode?: string;

  /** For `single-session` run mode: id of a pre-existing SDK session to continue. */

  preselectedSessionId?: string;

  runtime?: RuntimeType;

  runtimeConfig?: RuntimeConfigSnapshot;

  /** Per-task MCP enable list override (PRD 0.2.4 §需求 4). */

  mcpEnabledServers?: string[];

  sourceThoughtId?: string;

  tags?: string[];

  notification?: NotificationConfig;

  /** Team Hub sync target. */

  dispatchTarget?: DispatchTarget;

  /** Hub-side task id when dispatching a Hub task locally. */

  remoteTaskId?: string;

  /** Hub-side origin node id. */

  remoteOriginNodeId?: string;

  /** Hub-side executor node id. */

  remoteExecutorNodeId?: string;

}



/**

 * Payload for `cmd_task_create_from_alignment`.

 * `alignmentSessionId` identifies the pending directory `<workspace>/.task/<sessionId>/`.

 */

export interface TaskCreateFromAlignmentInput {

  name: string;

  executor: TaskExecutor;

  description?: string;

  workspaceId: string;

  workspacePath: string;

  alignmentSessionId: string;

  executionMode: TaskExecutionMode;

  runMode?: TaskRunMode;

  endConditions?: EndConditions;

  /** Per-task model override. Omit to inherit the Agent workspace default. */

  model?: string;

  /** PRD 0.2.9 — Per-task provider id override. MUST be paired with `model`. */

  providerId?: string;

  /** Per-task permission mode override. Runtime-specific values — see `zhishi runtime describe <runtime>`. */

  permissionMode?: string;

  runtime?: RuntimeType;

  runtimeConfig?: RuntimeConfigSnapshot;

  /** Per-task MCP enable list override (PRD 0.2.4 §需求 4). */

  mcpEnabledServers?: string[];

  sourceThoughtId?: string;

  tags?: string[];

  notification?: NotificationConfig;

}



/** Payload for `cmd_task_update`. */

export interface TaskUpdateInput {

  id: string;

  name?: string;

  executor?: TaskExecutor;

  description?: string;

  executionMode?: TaskExecutionMode;

  runMode?: TaskRunMode;

  endConditions?: EndConditions;

  /** Recurring-mode fixed interval (minutes). */

  intervalMinutes?: number;

  /** Advanced-mode cron expression. Empty string clears (switches back to simple mode). */

  cronExpression?: string;

  cronTimezone?: string;

  /** Dedicated dispatch time for `scheduled` mode (ms epoch). */

  dispatchAt?: number;

  /** Per-task model override. Empty string clears. */

  model?: string;

  /** PRD 0.2.9 — Per-task provider id override. Empty string clears. */

  providerId?: string;

  /** PRD 0.2.9 — Atomic "follow Agent" reset: clears providerId AND model

   *  in one update. Lets the renderer's "跟随 Agent" picker option round-trip

   *  cleanly without inventing a double-Option JSON shape. Pure boolean — no

   *  pairing risk if only one of (providerId, model) is omitted. */

  clearProviderOverride?: boolean;

  /** Per-task permission mode override. Empty string clears. */

  permissionMode?: string;

  /** For `single-session` run mode: id of a pre-existing SDK session to continue. */

  preselectedSessionId?: string;

  runtime?: RuntimeType;

  runtimeConfig?: RuntimeConfigSnapshot;

  /** PRD #131 — Atomic clear of `runtime` + `runtimeConfig`. The

   *  renderer's "跟随 Agent" runtime option sends this flag because

   *  `runtime: undefined` deserializes to `None` server-side which the

   *  apply path leaves untouched. Symmetric with `clearProviderOverride`. */

  clearRuntimeOverride?: boolean;

  /** Per-task MCP enable list override. Empty array clears (= follow

   *  Agent); a populated array snapshots the chosen server ids. Rust

   *  `update_task` normalises an empty vec → None on persistence. */

  mcpEnabledServers?: string[];

  tags?: string[];

  notification?: NotificationConfig;

  /**

   * When provided, the new markdown body is atomically written to

   * `.task/<id>/task.md` under the same write lock that persists the JSONL

   * row. Empty string is rejected server-side. AI-aligned tasks may not

   * overwrite their prompt this way — they use `/task-implement` + `alignment.md`.

   */

  prompt?: string;

}



/** Response from `cmd_task_get_run_stats` — aggregated telemetry for the task detail overlay. */

export interface TaskRunStats {

  executionCount: number;

  lastExecutedAt?: number;

  /** `ok` flag from the most recent `cron_runs/<id>.jsonl` row. */

  lastSuccess?: boolean;

  /** Duration of the most recent run (ms). */

  lastDurationMs?: number;

  /** Underlying CronTask status: 'running' | 'stopped' | … (string because `Debug` serialisation). */

  cronStatus?: string;

  cronTaskId?: string;

  /** Number of SDK sessions this task has spanned. */

  sessionCount: number;

  /** Next scheduled fire (ms since epoch). Parsed server-side from

   *  `CronTask.next_execution_at` so the frontend avoids cron-parser /

   *  timezone math — reflects what Rust will actually run. Absent when

   *  the task has no active cron binding or the schedule is not

   *  recurring / scheduled. */

  nextExecutionAt?: number;

}



/**

 * Payload for `cmd_task_update_status`. See PRD §10.2.1.

 *

 * UI callers MUST NOT send `actor` / `source` — these are authoritatively

 * stamped server-side at the Tauri command layer (`user` / `ui` for any

 * renderer-originated call). The fields are present in the shared type only for

 * internal Admin API / CLI transport payloads. A buggy renderer that sends them

 * anyway has them ignored.

 */

export interface TaskUpdateStatusInput {

  id: string;

  status: TaskStatus;

  message?: string;

  /** Internal only — ignored by the renderer-facing `cmd_task_update_status`. */

  actor?: TransitionActor;

  /** Internal only — ignored by the renderer-facing `cmd_task_update_status`. */

  source?: TransitionSource;

}



/** Filters accepted by `cmd_task_list`. Accepts a single status or an array. */

export interface TaskListFilter {

  workspaceId?: string;

  status?: TaskStatus | TaskStatus[];

  tag?: string;

  /** If `true`, include soft-deleted rows (default `false`). */

  includeDeleted?: boolean;

}

