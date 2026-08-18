// Task Scheduler for ZhiShi (phase 3b — engine swap: CronTask → Task as the key)
//
// Successor to `cron_task.rs`. The scheduler's primary key is now the Task
// Center `Task.id`; there is no separate cron id and no `Task.cron_task_id`
// ⇄ `CronTask.task_id` double pointer. The Task row (`task.rs`) is the single
// source of truth for ALL configuration: schedule, model, provider_id,
// permission_mode, runtime, runtime_config, mcp_enabled_servers, run_mode,
// end_conditions, name, workspace_path, notification — re-read from
// `TaskStore` every scheduler iteration, so config edits hot-apply.
//
// Only runtime execution state is persisted by this module, to
// `~/.zhishi/task_runtime.json` (atomic tmp+rename under a file lock, same
// strategy as the retired cron_tasks.json — which is neither read nor
// written anymore; the product never shipped, so no migration):
//   { task_id, session_id, internal_session_id, tab_id, execution_count,
//     last_executed_at, last_run_ok, last_run_duration_ms, exit_reason, armed }
//
// Execution history lives in `~/.zhishi/task_runs/<task_id>.jsonl`
// (same record format as the retired cron_runs/, renamed).
//
// What is deliberately inherited line-for-line from the old engine:
//   - wall-clock `sleep_until_wallclock` (survives system suspend)
//   - initial_target branches (At / Every+start_at / Cron / Loop /
//     cold-start +2s / past-due +5s)
//   - Ralph Loop backoff (3/10/30/60/120/300s, stop after 10 consecutive
//     failures) + 3s success buffer
//   - atomic executing-set reservation (no double-fire vs trigger_now)
//   - 60-minute per-tick timeout, per-tick wake-lock
//   - AI-requested-exit marker handling, one-shot completion
//
// Frontend events are renamed cron:* → task:* (renderer phase consumes):
//   task:scheduler-started / task:execution-starting / task:execution-complete
//   task:execution-error / task:task-stopped / task:task-recovered
//   task:recovery-summary / task:debug / task:manager-ready

use chrono::{DateTime, Utc};
use cron::Schedule as CronExprSchedule;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;
use tokio::time::Duration;
use uuid::Uuid;

use crate::utils::bom::strip_bom;
use crate::{ulog_debug, ulog_error, ulog_info, ulog_warn};
use crate::sidecar::{
    execute_scheduled_task, ScheduledTaskExecutePayload, ManagedSidecarManager,
    SidecarOwner, ensure_session_sidecar, release_session_sidecar,
};
use crate::task::{
    self, Task, TaskEndConditions, TaskExecutionMode, TaskRunMode, TaskStatus,
};

/// Base directory for scheduler-owned files (`~/.zhishi`). Routed through
/// `app_dirs::zhishi_data_dir()` so debug/prod data isolation applies; falls
/// back to the literal home-relative path when resolution fails.
fn zhishi_dir() -> PathBuf {
    crate::app_dirs::zhishi_data_dir().unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".zhishi")
    })
}

// ============ Cron expression dialect helpers ============
//
// Recurring Tasks express their schedule as a Unix cron expression; these
// helpers are carried over verbatim (the *expression dialect* keeps the name
// "cron" — that is the schedule syntax, not the retired CronTask entity).

/// Validate a cron expression (and optional timezone) at data-boundary time
/// so bad input is rejected when saved, not silently swallowed at next fire
/// (which would leave the scheduler dead and the task status "running" with
/// no tick). Returns `Ok(())` when the expression parses and the tz (if
/// supplied) is an IANA id we recognize.
pub fn validate_cron_expression(expr: &str, tz: Option<&str>) -> Result<(), String> {
    // `next_cron_fire_time` already does both checks and throws away the
    // result; reuse it so the validator stays in lockstep with the runtime
    // parser — no way for validation to diverge from execution.
    next_cron_fire_time(expr, tz).map(|_| ())
}

/// Translate a Unix-style day-of-week field (0-7, Sun=0 or Sun=7) into the
/// `cron` crate's day-of-week numbering (1-7, Sun=1, Sat=7 — Quartz semantics).
///
/// Why: `cron` v0.15 rejects `0` for DOW with "Days of Week must be greater
/// than or equal to 1", and even when numeric DOW values parse, they're
/// shifted vs. the Unix convention the rest of the app uses (frontend
/// `CronExpressionInput`, CLI scheduling, AI tool calls all generate
/// Unix-style cron). Without this translation, `0 21 * * 0` is rejected
/// outright, and `0 8 * * 1-5` (Mon-Fri in Unix) silently fires Sun-Thu in
/// crate land.
///
/// Approach: fully enumerate the Unix days the token represents, shift each
/// to its crate equivalent (so `5-7` Fri-Sun → `{6,7,1}` not the invalid
/// `6-1`, and `1-7/2` Mon/Wed/Fri/Sun → `{2,4,6,1}` not the wrong-phase
/// `*/2`), then re-emit as a sorted comma list with consecutive runs
/// compressed back into ranges. Tokens containing names (`SUN`-`SAT`) or
/// `?` are passed through — the crate accepts those natively.
fn translate_unix_dow_to_crate_dow(dow: &str) -> String {
    use std::collections::BTreeSet;

    fn shift_unix(n: u32) -> u32 {
        match n {
            0 | 7 => 1, // Sunday (Unix 0 or 7 → crate 1)
            1..=6 => n + 1,
            _ => n,
        }
    }

    /// Enumerate the Unix DOW values a token represents (0-7, where 7 also
    /// means Sunday). Returns `None` for anything we'd rather pass through
    /// (named days, `?`, malformed tokens).
    fn token_to_unix_days(token: &str) -> Option<Vec<u32>> {
        if token.is_empty() {
            return None;
        }
        if token == "*" {
            return Some((0..=6).collect());
        }
        if token == "?" {
            return None;
        }
        if let Some((base, step_str)) = token.split_once('/') {
            let step: u32 = step_str.parse().ok()?;
            if step == 0 {
                return None;
            }
            let (start, end) = if base == "*" {
                (0u32, 6u32)
            } else if let Some((s, e)) = base.split_once('-') {
                (s.parse().ok()?, e.parse().ok()?)
            } else {
                // single + step: "N/k" enumerates N, N+k, ... up to 7 (covers Sunday alias)
                let n: u32 = base.parse().ok()?;
                (n, 7u32)
            };
            if start > 7 || end > 7 || start > end {
                return None;
            }
            return Some((start..=end).step_by(step as usize).collect());
        }
        if let Some((s, e)) = token.split_once('-') {
            let start: u32 = s.parse().ok()?;
            let end: u32 = e.parse().ok()?;
            if start > 7 || end > 7 || start > end {
                return None;
            }
            return Some((start..=end).collect());
        }
        let n: u32 = token.parse().ok()?;
        if n > 7 {
            return None;
        }
        Some(vec![n])
    }

    /// Compact a sorted set of crate days back into the most readable form:
    /// 7 days → `*`, consecutive runs of ≥3 → `a-b`, otherwise comma list.
    fn format_crate_days(days: &BTreeSet<u32>) -> String {
        if days.len() == 7 {
            return "*".to_string();
        }
        let sorted: Vec<u32> = days.iter().copied().collect();
        let mut parts: Vec<String> = Vec::new();
        let mut i = 0;
        while i < sorted.len() {
            let run_start = sorted[i];
            let mut run_end = run_start;
            while i + 1 < sorted.len() && sorted[i + 1] == run_end + 1 {
                run_end = sorted[i + 1];
                i += 1;
            }
            if run_end >= run_start + 2 {
                parts.push(format!("{}-{}", run_start, run_end));
            } else if run_end == run_start + 1 {
                parts.push(run_start.to_string());
                parts.push(run_end.to_string());
            } else {
                parts.push(run_start.to_string());
            }
            i += 1;
        }
        parts.join(",")
    }

    let mut crate_days: BTreeSet<u32> = BTreeSet::new();
    for token in dow.split(',') {
        match token_to_unix_days(token) {
            Some(unix_days) => {
                for d in unix_days {
                    crate_days.insert(shift_unix(d));
                }
            }
            None => {
                // Fall back: any non-numeric token (named day, `?`, malformed)
                // means we can't safely fully enumerate — pass through verbatim.
                // This is rare in practice; the crate accepts SUN-SAT names natively.
                return dow.to_string();
            }
        }
    }
    if crate_days.is_empty() {
        return dow.to_string();
    }
    format_crate_days(&crate_days)
}

/// Parse a cron expression and compute the next fire time as a wall-clock UTC timestamp.
///
/// Input dialect: standard Unix 5-field (`min hour dom month dow`, Sun=0 or 7)
/// — the format used by every UI surface and `crontab(5)`. We convert to the
/// `cron` crate's native 7-field format (`sec min hour dom month dow year`,
/// Sun=1) by prepending seconds, appending year, and translating DOW.
///
/// 6-field and 7-field inputs are passed through with minimal massaging,
/// assuming the caller is using the cron crate's native dialect (Quartz-style,
/// 1=Sun). We don't translate DOW for those — power users typing 6/7 fields
/// know what they're doing.
fn next_cron_fire_time(expr: &str, tz: Option<&str>) -> Result<DateTime<Utc>, String> {
    let expr7 = {
        let fields: Vec<&str> = expr.split_whitespace().collect();
        match fields.len() {
            5 => {
                // Unix 5-field: translate DOW (the 5th field) from Unix to crate semantics.
                let dow_translated = translate_unix_dow_to_crate_dow(fields[4]);
                format!("0 {} {} {} {} {} *", fields[0], fields[1], fields[2], fields[3], dow_translated)
            }
            6 => format!("{} *", expr.trim()),     // crate-native 6-field (sec min hour dom month dow) — append year
            7 => expr.trim().to_string(),            // already full 7-field
            _ => return Err(format!("Invalid cron expression '{}': expected 5-7 fields, got {}", expr, fields.len())),
        }
    };

    let schedule = CronExprSchedule::from_str(&expr7)
        .map_err(|e| format!("Failed to parse cron expression '{}' (normalized: '{}'): {}", expr, expr7, e))?;

    // Resolve timezone
    let now = if let Some(tz_str) = tz {
        let tz: chrono_tz::Tz = tz_str.parse()
            .map_err(|_| format!("Invalid timezone '{}' for cron expression", tz_str))?;
        Utc::now().with_timezone(&tz)
    } else {
        // Default to UTC — use a fixed-offset representation
        Utc::now().with_timezone(&chrono_tz::UTC)
    };

    let next = schedule.after(&now).next()
        .ok_or_else(|| format!("No upcoming fire time for cron expression '{}'", expr))?;

    Ok(next.with_timezone(&Utc))
}

/// Wall-clock aware sleep that survives system suspend/hibernate.
///
/// Unlike `tokio::time::sleep(duration)` which uses monotonic time (pauses during
/// system sleep on macOS), this function polls `Utc::now()` (wall clock) every
/// POLL_INTERVAL seconds, correctly detecting that the scheduled time has passed
/// even after the system wakes from sleep.
///
/// Returns `true` if target time was reached, `false` if shutdown was requested
/// (either the manager-wide flag or this task's per-task disarm flag).
async fn sleep_until_wallclock(
    target: DateTime<Utc>,
    shutdown: &RwLock<bool>,
    task_shutdown: &RwLock<bool>,
    task_id: &str,
) -> bool {
    const POLL_SECS: u64 = 30;
    loop {
        let now = Utc::now();
        if now >= target {
            return true;
        }
        // Check shutdown flags (manager-wide + per-task disarm)
        if *shutdown.read().await || *task_shutdown.read().await {
            ulog_info!("[TaskScheduler] Task {} wallclock sleep interrupted by shutdown", task_id);
            return false;
        }
        // Sleep for min(remaining, POLL_SECS) — short sleeps survive system suspend
        let remaining_secs = (target - now).num_seconds().max(0) as u64;
        let sleep_secs = remaining_secs.clamp(1, POLL_SECS);
        tokio::time::sleep(Duration::from_secs(sleep_secs)).await;
    }
}

// ============ Shared schedule types ============

/// Run mode for scheduled tasks (session strategy across executions).
///
/// Serde shape is snake_case (`single_session` / `new_session`) — the wire
/// format of the sidecar execute payload and of `ScheduledTaskView`. The
/// Task layer has its own `TaskRunMode` (kebab-case, PRD shape); convert at
/// this boundary via the `From` impls below.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum RunMode {
    /// Keep session context between executions
    #[default]
    SingleSession,
    /// Create new session for each execution (no memory)
    NewSession,
}


impl From<TaskRunMode> for RunMode {
    fn from(m: TaskRunMode) -> Self {
        match m {
            TaskRunMode::SingleSession => Self::SingleSession,
            TaskRunMode::NewSession => Self::NewSession,
        }
    }
}

impl From<RunMode> for TaskRunMode {
    fn from(m: RunMode) -> Self {
        match m {
            RunMode::SingleSession => Self::SingleSession,
            RunMode::NewSession => Self::NewSession,
        }
    }
}

/// Explicit provider routing intent (PRD #119, 2026-05).
///
/// Retained as part of the execute payload wire format: the sidecar handler
/// branches on intent and either follows the workspace-agent snapshot
/// (`FollowAgent`) or short-circuits to task-owned values (`Explicit`).
/// Task-Center dispatches always send `FollowAgent` when `provider_id` is
/// absent; when `provider_id` is set the sidecar ignores this field and
/// live-resolves from `~/.zhishi/config.json` on every tick.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderIntent {
    /// Snapshot-based: follow the workspace agent at execute time.
    #[default]
    FollowAgent,
    /// Explicitly use a captured provider env. Not produced by the Task
    /// scheduler (Tasks never persist credential snapshots) — kept so the
    /// wire enum stays complete for the sidecar handler.
    Explicit,
}

/// Flexible schedule computed from a Task's scheduling fields
/// (`schedule_from_task`). Serde shape is unchanged from the retired
/// `CronSchedule` (`{kind: at|every|cron|loop, ...}`) — it is an in-memory
/// runtime representation, never persisted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TaskSchedule {
    /// One-shot: execute at a specific time, then complete
    At { at: String },
    /// Recurring interval in minutes, with optional delayed start
    Every { minutes: u32, #[serde(default, skip_serializing_if = "Option::is_none")] start_at: Option<String> },
    /// Cron expression with optional timezone
    Cron { expr: String, tz: Option<String> },
    /// Ralph Loop: completion-triggered re-execution (no time-based scheduling)
    /// AI finishes → 3s buffer → execute again. Exponential backoff on failure.
    Loop,
}

/// Translate a Task's scheduling intent into a concrete `TaskSchedule`.
///
/// Reads the v0.1.69 scheduling-detail fields in priority order:
///   * `Scheduled`  → explicit `dispatch_at`; falls back to legacy
///     `endConditions.deadline` for rows migrated before the split. Returns
///     `None` when neither is set — callers surface that as a user-visible
///     validation error instead of silently coining a "now + 1 minute"
///     schedule.
///   * `Recurring`  → `cron_expression` (advanced mode) wins over
///     `interval_minutes` (simple mode); defaults to every 60 minutes.
///   * `Loop`       → `TaskSchedule::Loop` (no knobs).
///   * `Once`       → fire in 2 s to survive clock jitter, then stop.
///
/// Moved from `management_api.rs` in phase 3b — the scheduler recomputes
/// this on every loop iteration so schedule edits hot-apply.
pub fn schedule_from_task(ta: &Task) -> Option<TaskSchedule> {
    match ta.execution_mode {
        TaskExecutionMode::Once => {
            let when = Utc::now() + chrono::Duration::seconds(2);
            Some(TaskSchedule::At {
                at: when.to_rfc3339(),
            })
        }
        TaskExecutionMode::Scheduled => ta
            .dispatch_at
            .or_else(|| ta.end_conditions.as_ref().and_then(|ec| ec.deadline))
            .and_then(DateTime::<Utc>::from_timestamp_millis)
            .map(|when| TaskSchedule::At {
                at: when.to_rfc3339(),
            }),
        TaskExecutionMode::Recurring => Some(
            if let Some(expr) = ta
                .cron_expression
                .as_ref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
            {
                TaskSchedule::Cron {
                    expr,
                    tz: ta
                        .cron_timezone
                        .as_ref()
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty()),
                }
            } else {
                TaskSchedule::Every {
                    minutes: ta.interval_minutes.unwrap_or(60).max(5),
                    start_at: None,
                }
            },
        ),
        TaskExecutionMode::Loop => Some(TaskSchedule::Loop),
    }
}

/// Derive the RunMode from a Task, honoring the PRD §9.2 default matrix
/// (loop → single-session, recurring/others → new-session) unless the user
/// explicitly set `runMode`.
pub fn resolve_run_mode(ta: &Task) -> RunMode {
    match ta.run_mode {
        Some(TaskRunMode::NewSession) => RunMode::NewSession,
        Some(TaskRunMode::SingleSession) => RunMode::SingleSession,
        None => {
            if matches!(ta.execution_mode, TaskExecutionMode::Loop) {
                RunMode::SingleSession
            } else {
                RunMode::NewSession
            }
        }
    }
}

/// Effective end conditions for a Task.
///
/// IMPORTANT default-semantics note (parity with the retired
/// `ensure_cron_for_task`): when the Task has NO `end_conditions` at all,
/// `ai_can_exit` defaults to **false** — the old code mapped
/// `Option<TaskEndConditions>` through `cron_task::EndConditions::default()`
/// whose derived default was `false`. `TaskEndConditions`'s own serde
/// default (`default_true`) only kicks in when the struct is present but
/// the field is omitted in JSON. Do not "simplify" this to
/// `unwrap_or_default()` — that would silently let the AI exit tasks that
/// previously couldn't self-terminate.
fn effective_end_conditions(ta: &Task) -> TaskEndConditions {
    ta.end_conditions.clone().unwrap_or(TaskEndConditions {
        deadline: None,
        max_executions: None,
        ai_can_exit: false,
    })
}

/// Interval minutes carried in the execute payload (system-prompt context).
/// `Every` uses its own minutes; all other schedule kinds use the same 60
/// placeholder the old engine sent (the sidecar ignores it for At/Cron/Loop).
fn interval_minutes_for_payload(schedule: &TaskSchedule) -> u32 {
    match schedule {
        TaskSchedule::Every { minutes, .. } => (*minutes).max(5),
        _ => 60,
    }
}

// ============ Runtime execution state (persistence) ============

/// Runtime execution state for one scheduled Task. This is the ONLY thing
/// the scheduler persists — everything else is read live from the Task row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRuntimeEntry {
    pub task_id: String,
    /// Sidecar session key for the next execution (rotated per tick in
    /// new_session mode).
    pub session_id: String,
    /// Internal SDK session ID where conversation data is stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub internal_session_id: Option<String>,
    /// Tab ID associated with this task (frontend binding, notification nav).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub execution_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_executed_at: Option<DateTime<Utc>>,
    /// Denormalized last-run summary so list views don't crack open the
    /// task_runs JSONL on every read (PRD 0.2.5 R6).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_ok: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_duration_ms: Option<u64>,
    /// Why the scheduler was disarmed (end condition / AI exit / task state).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_reason: Option<String>,
    /// Whether the scheduler loop should be running for this task.
    #[serde(default)]
    pub armed: bool,
}

/// On-disk shape of `~/.zhishi/task_runtime.json`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct TaskRuntimeStore {
    #[serde(default)]
    entries: Vec<TaskRuntimeEntry>,
}

/// Atomic file save helper - writes to temp file first, then renames.
/// Same single-writer invariant as the retired cron_tasks.json writer:
/// wraps the write in `with_file_lock` against a sibling
/// `task_runtime.json.lock` directory and uses a unique tmp suffix
/// (`.tmp.{pid}.{nanos}`) so two concurrent saves don't race.
async fn atomic_save_entries(
    storage_path: &Path,
    entries: &Arc<RwLock<HashMap<String, TaskRuntimeEntry>>>,
) -> Result<(), String> {
    let snapshot = {
        let guard = entries.read().await;
        guard.values().cloned().collect::<Vec<_>>()
    };

    let store = TaskRuntimeStore { entries: snapshot };
    let count = store.entries.len();

    let content = serde_json::to_string_pretty(&store)
        .map_err(|e| format!("Failed to serialize task runtime: {}", e))?;

    if let Some(parent) = storage_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create task runtime directory: {}", e))?;
    }

    let lock_path = storage_path.with_file_name("task_runtime.json.lock");
    let storage_path_owned = storage_path.to_path_buf();

    crate::utils::file_lock::with_file_lock(
        &lock_path,
        crate::utils::file_lock::FileLockOptions::default(),
        move || {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let tmp_path = storage_path_owned.with_file_name(format!(
                "task_runtime.json.tmp.{}.{}",
                std::process::id(),
                nanos
            ));

            std::fs::write(&tmp_path, &content).map_err(|e| {
                crate::utils::file_lock::FileLockError::Io(std::io::Error::new(
                    e.kind(),
                    format!("Failed to write task runtime temp file: {}", e),
                ))
            })?;
            std::fs::rename(&tmp_path, &storage_path_owned).map_err(|e| {
                crate::utils::file_lock::FileLockError::Io(std::io::Error::new(
                    e.kind(),
                    format!("Failed to rename task runtime file: {}", e),
                ))
            })?;
            Ok(())
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    ulog_debug!("[TaskScheduler] Atomically saved {} runtime entries to disk", count);
    Ok(())
}

// ============ Task Run Records (execution history) ============

const MAX_RUN_RECORDS: usize = 500;

/// Sentinel prefix used by `execute_task_tick` to flag an `Err` that is
/// NOT an execution failure but a deliberate "Task entered a terminal
/// state, we've already disarmed" short-circuit (carried over from the
/// v0.1.69 H2 cross-review fix).
///
/// The outer scheduler loop detects this prefix and skips:
///   1. writing a failure record to `task_runs/<id>.jsonl`
///   2. emitting `task:execution-error`
///
/// — without it, the graceful terminal-state stop would still surface to the
/// UI as a failed tick, giving the user a misleading "最近一次失败" badge
/// seconds before the task's real status flips to its terminal state.
const TERMINAL_STOP_SENTINEL: &str = "__TERMINAL_STOP__:";

/// A single execution record for a scheduled task.
/// Format unchanged from the retired `CronRunRecord` — only the directory
/// moved (`cron_runs/` → `task_runs/`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunRecord {
    pub ts: i64,                    // Unix timestamp (ms)
    pub ok: bool,                   // Whether execution succeeded
    pub duration_ms: u64,           // Execution duration
    pub content: Option<String>,    // AI output text (delivery content)
    pub error: Option<String>,      // Error message on failure
}

/// Return shape for `trigger_now()`. Echoed back to the caller (CLI / IPC)
/// so they can display "what got fired, where to look".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerNowInfo {
    pub task_id: String,
    pub session_id: String,
    pub dispatched_at: String,
}

/// Sanitize task_id to prevent path traversal (remove path separators and dots sequences)
fn sanitize_task_id(task_id: &str) -> String {
    task_id
        .replace(['/', '\\', '\0'], "")
        .replace("..", "")
}

/// Get the JSONL file path for a task's run records
fn run_record_path(task_id: &str) -> PathBuf {
    let safe_id = sanitize_task_id(task_id);
    zhishi_dir()
        .join("task_runs")
        .join(format!("{}.jsonl", safe_id))
}

/// Append a run record to ~/.zhishi/task_runs/<taskId>.jsonl
/// Truncates to MAX_RUN_RECORDS if exceeded.
pub fn record_task_run(task_id: &str, record: &TaskRunRecord) -> Result<(), String> {
    let path = run_record_path(task_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create task_runs dir: {}", e))?;
    }

    let line = serde_json::to_string(record)
        .map_err(|e| format!("Failed to serialize run record: {}", e))?
        + "\n";

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open run record file: {}", e))?;

    file.write_all(line.as_bytes())
        .map_err(|e| format!("Failed to write run record: {}", e))?;

    // Truncate if over limit
    truncate_run_file_if_needed(&path, MAX_RUN_RECORDS);
    Ok(())
}

/// Read the most recent `limit` run records (returned in chronological order)
pub fn read_task_runs(task_id: &str, limit: usize) -> Vec<TaskRunRecord> {
    let path = run_record_path(task_id);
    if !path.exists() {
        return vec![];
    }

    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let capped = limit.min(100);
    let records: Vec<TaskRunRecord> = content
        .lines()
        .rev()
        .take(capped)
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    // Reverse back to chronological order
    records.into_iter().rev().collect()
}

/// Truncate a JSONL file to keep only the last `max` lines
fn truncate_run_file_if_needed(path: &Path, max: usize) {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };

    let lines: Vec<&str> = content.lines().collect();
    if lines.len() <= max {
        return;
    }

    // Keep only the last `max` lines
    let kept: Vec<&str> = lines[lines.len() - max..].to_vec();
    let new_content = kept.join("\n") + "\n";
    let _ = fs::write(path, new_content);
}

// ============ View / event payload types ============

/// Renderer-facing view of a scheduled Task (new IPC surface, phase 3b §15).
/// Composed from the Task row (config) + its runtime entry (execution state).
///
/// TS mirror lives in `src/shared/types/task.ts` (`ScheduledTaskView`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskView {
    pub task_id: String,
    pub name: String,
    pub workspace_path: String,
    pub session_id: String,
    /// 'running' when the scheduler is armed for this task, else 'stopped'.
    pub status: String,
    pub currently_executing: bool,
    /// RFC3339 next fire time (clamped forward; see compute_next_execution).
    pub next_execution_at: Option<String>,
    pub last_run_ok: Option<bool>,
    pub last_run_duration_ms: Option<u64>,
    pub execution_count: u32,
    pub run_mode: RunMode,
}

/// Event payload for a single task recovery success.
/// Emitted as "task:task-recovered" for each successfully recovered task.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecoveredPayload {
    pub task_id: String,
    pub session_id: String,
    pub workspace_path: String,
    pub port: u16,
    pub status: String,
    pub execution_count: u32,
    pub interval_minutes: u32,
}

/// Event payload for recovery summary.
/// Emitted as "task:recovery-summary" after all recovery attempts complete.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecoverySummaryPayload {
    pub total_tasks: u32,
    pub recovered_count: u32,
    pub failed_count: u32,
    pub failed_tasks: Vec<TaskRecoveryFailedTask>,
}

/// Info about a single failed recovery
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecoveryFailedTask {
    pub task_id: String,
    pub workspace_path: String,
    pub error: String,
}

/// Compute the next execution time for a scheduled task (enrichment helper).
/// Returns an RFC3339 string or None when the task is disarmed / Loop / has
/// no resolvable schedule.
///
/// Past-due values (cold start before first execution, or catch-up after
/// system sleep) are clamped forward to match the scheduler's own
/// "fire in 2s / 5s" fallbacks in the `initial_target` block, so the UI and
/// the scheduler agree (carried over from the v0.1.69 cross-review fix).
fn compute_next_execution(task: &Task, entry: &TaskRuntimeEntry) -> Option<String> {
    if !entry.armed {
        return None;
    }

    // Mirror of the scheduler's `initial_target` fallback: cold-start /
    // first-execution with no better signal fires +2s; past-due fires +5s.
    // `clamp_forward` keeps this computation in lockstep with those minimums
    // so the UI never displays a moment in the past.
    fn clamp_forward(candidate: DateTime<Utc>, min_ahead_secs: i64) -> DateTime<Utc> {
        let min_target = Utc::now() + chrono::Duration::seconds(min_ahead_secs);
        if candidate > min_target {
            candidate
        } else {
            min_target
        }
    }

    let schedule = schedule_from_task(task)?;
    let created_at = DateTime::<Utc>::from_timestamp_millis(task.created_at)
        .unwrap_or_else(Utc::now);

    match &schedule {
        TaskSchedule::At { at } => {
            // One-shot. Past-due → scheduler fires in ~2s after spawn.
            match DateTime::parse_from_rfc3339(at)
                .or_else(|_| DateTime::parse_from_str(at, "%Y-%m-%dT%H:%M:%S"))
            {
                Ok(target) => Some(clamp_forward(target.with_timezone(&Utc), 2).to_rfc3339()),
                Err(_) => None,
            }
        }
        TaskSchedule::Every { minutes, start_at } => {
            // Explicit `start_at` (future) wins for the first execution.
            if let Some(ref sa) = start_at {
                if let Ok(parsed) = DateTime::parse_from_rfc3339(sa) {
                    let target = parsed.with_timezone(&Utc);
                    if target > Utc::now() && entry.execution_count == 0 {
                        return Some(target.to_rfc3339());
                    }
                }
            }
            // First ever run with no last_executed_at → scheduler fires +2s.
            if entry.execution_count == 0 && entry.last_executed_at.is_none() {
                return Some(
                    (Utc::now() + chrono::Duration::seconds(2)).to_rfc3339(),
                );
            }
            let base = entry.last_executed_at.unwrap_or(created_at);
            let next = base + chrono::Duration::minutes(*minutes as i64);
            // Past-due (catch-up after sleep) → scheduler fires +5s.
            Some(clamp_forward(next, 5).to_rfc3339())
        }
        TaskSchedule::Cron { expr, tz } => {
            match next_cron_fire_time(expr, tz.as_deref()) {
                Ok(next) => Some(next.to_rfc3339()),
                Err(_) => None,
            }
        }
        TaskSchedule::Loop => {
            // Ralph Loop: no scheduled time, triggered by completion
            None
        }
    }
}

// ============ Scheduler Manager ============

/// Manager for scheduled Tasks. Singleton via `get_task_scheduler_manager()`.
pub struct TaskSchedulerManager {
    /// Runtime execution state, keyed by Task.id. Persisted to task_runtime.json.
    entries: Arc<RwLock<HashMap<String, TaskRuntimeEntry>>>,
    storage_path: PathBuf,
    /// Flag to stop all scheduler loops (app teardown)
    shutdown: Arc<RwLock<bool>>,
    /// Track which tasks are currently executing (for overlap prevention)
    executing_tasks: Arc<RwLock<HashSet<String>>>,
    /// Track which tasks have active schedulers (legacy bookkeeping, kept in
    /// sync inside the start critical section)
    active_schedulers: Arc<RwLock<HashSet<String>>>,
    /// JoinHandles for scheduler loops — enables graceful shutdown
    scheduler_handles: Arc<RwLock<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    /// Per-task shutdown flags. `disarm` sets the flag so a sleeping loop
    /// exits within one wall-clock poll (≤30s) instead of waiting out the
    /// whole interval — the old engine only discovered stops at the next
    /// fire time. In-flight executions are never aborted.
    task_shutdowns: Arc<RwLock<HashMap<String, Arc<RwLock<bool>>>>>,
    /// Tauri app handle for emitting events (set after initialization)
    app_handle: Arc<RwLock<Option<AppHandle>>>,
}

impl Default for TaskSchedulerManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TaskSchedulerManager {
    /// Create a new manager with persistence at ~/.zhishi/task_runtime.json
    pub fn new() -> Self {
        let storage_path = zhishi_dir().join("task_runtime.json");
        let initial_entries = Self::load_entries_from_file(&storage_path);

        let count = initial_entries.len();
        let manager = Self {
            entries: Arc::new(RwLock::new(initial_entries)),
            storage_path,
            shutdown: Arc::new(RwLock::new(false)),
            executing_tasks: Arc::new(RwLock::new(HashSet::new())),
            active_schedulers: Arc::new(RwLock::new(HashSet::new())),
            scheduler_handles: Arc::new(RwLock::new(HashMap::new())),
            task_shutdowns: Arc::new(RwLock::new(HashMap::new())),
            app_handle: Arc::new(RwLock::new(None)),
        };

        if count > 0 {
            ulog_info!("[TaskScheduler] Loaded {} runtime entries from disk", count);
        }

        manager
    }

    /// Load runtime entries from file synchronously (used during init).
    /// Returns empty HashMap on any error (logged as warning).
    fn load_entries_from_file(storage_path: &Path) -> HashMap<String, TaskRuntimeEntry> {
        if !storage_path.exists() {
            return HashMap::new();
        }

        let content = match fs::read_to_string(storage_path) {
            Ok(c) => c,
            Err(e) => {
                ulog_warn!("[TaskScheduler] Failed to read task runtime file: {}", e);
                return HashMap::new();
            }
        };

        // Tolerate UTF-8 BOM (hand-edited file, issue #170 #6 pattern).
        let content_no_bom = strip_bom(&content);

        match serde_json::from_str::<TaskRuntimeStore>(content_no_bom) {
            Ok(store) => store
                .entries
                .into_iter()
                .map(|e| (e.task_id.clone(), e))
                .collect(),
            Err(e) => {
                ulog_warn!(
                    "[TaskScheduler] Failed to parse task_runtime.json ({}); starting with empty runtime state",
                    e
                );
                HashMap::new()
            }
        }
    }

    /// Set the Tauri app handle for emitting events.
    pub async fn set_app_handle(&self, handle: AppHandle) {
        let mut app_handle = self.app_handle.write().await;
        *app_handle = Some(handle);
        ulog_info!("[TaskScheduler] App handle set");
    }

    /// Save runtime entries to disk using atomic writes (temp file + rename)
    pub(crate) async fn save_to_disk(&self) -> Result<(), String> {
        atomic_save_entries(&self.storage_path, &self.entries).await
    }

    /// Read a runtime entry (cloned).
    pub async fn get_entry(&self, task_id: &str) -> Option<TaskRuntimeEntry> {
        self.entries.read().await.get(task_id).cloned()
    }

    /// Scheduler-computed next fire time (RFC3339) for a Task, or None when
    /// not armed / no resolvable schedule. Used by the run-stats IPC.
    pub async fn next_execution_for(&self, task: &Task) -> Option<String> {
        let entry = self.get_entry(&task.id).await?;
        compute_next_execution(task, &entry)
    }

    /// Arm the scheduler for a Task: upsert the runtime entry (preserving
    /// historical execution counters) and start the scheduler loop
    /// (idempotent — a live loop is not duplicated).
    ///
    /// This is the phase-3b replacement for `ensure_cron_for_task`: the Task
    /// itself is the schedule's source of truth, so "ensuring" reduces to
    /// "mark armed + make sure a loop exists".
    pub async fn arm(&self, task: &Task) -> Result<(), String> {
        if task.deleted
            || matches!(
                task.status,
                TaskStatus::Deleted
                    | TaskStatus::Archived
                    | TaskStatus::Stopped
                    | TaskStatus::Blocked
                    | TaskStatus::Done
            )
        {
            return Err(format!(
                "task {} is in terminal state '{}'; cannot arm scheduler",
                task.id,
                task.status.as_str()
            ));
        }

        // The schedule must be resolvable — same user-facing error the old
        // `ensure_cron_for_task` produced for Scheduled tasks with no time.
        if schedule_from_task(task).is_none() {
            return Err(if matches!(task.execution_mode, TaskExecutionMode::Scheduled) {
                "定时模式需要设置执行时间（dispatchAt），请在编辑面板中填写。".to_string()
            } else {
                format!("task {} has no resolvable schedule", task.id)
            });
        }

        {
            let mut entries = self.entries.write().await;
            let entry = entries.entry(task.id.clone()).or_insert_with(|| TaskRuntimeEntry {
                task_id: task.id.clone(),
                session_id: initial_session_id_for(task),
                internal_session_id: None,
                tab_id: None,
                execution_count: 0,
                last_executed_at: None,
                last_run_ok: None,
                last_run_duration_ms: None,
                exit_reason: None,
                armed: false,
            });
            entry.armed = true;
            entry.exit_reason = None;
        }
        self.save_to_disk().await?;

        self.start_scheduler(&task.id).await
    }

    /// Reset execution counters for a rerun ("try again from scratch").
    /// Mirrors the old flow where rerun deleted the linked CronTask and
    /// minted a fresh one: execution_count / last_executed_at / last-run
    /// summary / exit_reason are cleared and a fresh session id is minted
    /// (single-session tasks keep their preselected session). `tab_id` and
    /// `armed` are preserved — `arm` decides arming afterwards.
    pub async fn reset_for_rerun(&self, task: &Task) {
        {
            let mut entries = self.entries.write().await;
            if let Some(e) = entries.get_mut(&task.id) {
                e.execution_count = 0;
                e.last_executed_at = None;
                e.last_run_ok = None;
                e.last_run_duration_ms = None;
                e.exit_reason = None;
                e.session_id = initial_session_id_for(task);
                e.internal_session_id = None;
            }
        }
        if let Err(e) = self.save_to_disk().await {
            ulog_warn!("[TaskScheduler] reset_for_rerun save failed for {}: {}", task.id, e);
        }
    }

    /// Disarm the scheduler for a Task: signal the loop to stop, mark the
    /// runtime entry disarmed, release the sidecar ownership, and emit
    /// `task:task-stopped`. Idempotent — safe to call for tasks that were
    /// never armed (no-op apart from the per-task shutdown flag).
    ///
    /// This does NOT touch the Task's own status; callers transitioning the
    /// Task do that themselves. For scheduler-initiated stops that should
    /// also complete the Task, see `stop_scheduled_task_internal`.
    pub async fn disarm(&self, task_id: &str, reason: Option<String>) {
        self.disarm_core(task_id, reason.clone(), true).await;
        ulog_info!("[TaskScheduler] Disarmed task {} (reason: {:?})", task_id, reason);
    }

    /// Shared disarm implementation. `emit_event` controls the
    /// `task:task-stopped` emission (internal callers emit through the same
    /// path; kept as a flag so future silent teardown doesn't double-emit).
    async fn disarm_core(&self, task_id: &str, reason: Option<String>, emit_event: bool) {
        // Signal the per-task shutdown flag so a sleeping loop exits within
        // one wall-clock poll.
        let flag = self.task_shutdowns.read().await.get(task_id).cloned();
        if let Some(flag) = flag {
            let mut f = flag.write().await;
            *f = true;
        }

        let (session_id, had_entry) = {
            let mut entries = self.entries.write().await;
            match entries.get_mut(task_id) {
                Some(e) => {
                    e.armed = false;
                    e.exit_reason = reason.clone();
                    (Some(e.session_id.clone()), true)
                }
                None => (None, false),
            }
        };

        if had_entry {
            if let Err(e) = self.save_to_disk().await {
                ulog_warn!("[TaskScheduler] save on disarm failed for {}: {}", task_id, e);
            }
        }

        // Release the task's ownership of the session sidecar + deactivate
        // the session (legacy session tracking). Mirrors the old stop path:
        // if a Tab still owns the sidecar it keeps running.
        if let Some(ref sid) = session_id {
            self.release_task_sidecar(sid, task_id).await;
            self.deactivate_session_internal(sid).await;
        }

        if emit_event && had_entry {
            let handle_opt = self.app_handle.read().await;
            if let Some(ref handle) = *handle_opt {
                let _ = handle.emit("task:task-stopped", serde_json::json!({
                    "taskId": task_id,
                    "exitReason": reason,
                }));
            }
        }
    }

    /// Full teardown when the Task itself is deleted: stop the loop, drop
    /// the runtime entry, and remove the task_runs history file (mirrors the
    /// old `delete_task` cleanup semantics).
    pub async fn on_task_deleted(&self, task_id: &str) {
        self.disarm(task_id, Some("task deleted".to_string())).await;

        {
            let mut entries = self.entries.write().await;
            entries.remove(task_id);
        }
        if let Err(e) = self.save_to_disk().await {
            ulog_warn!("[TaskScheduler] save after entry removal failed for {}: {}", task_id, e);
        }

        // Cascade-clean the run history file. Best-effort: failure must not
        // block delete (file may not exist if the task never executed).
        let runs_path = run_record_path(task_id);
        if runs_path.exists() {
            match std::fs::remove_file(&runs_path) {
                Ok(()) => ulog_info!("[TaskScheduler] Removed run history: {}", runs_path.display()),
                Err(e) => ulog_warn!("[TaskScheduler] Failed to remove run history {}: {}", runs_path.display(), e),
            }
        }
    }

    /// Internal helper to deactivate a session via SidecarManager
    async fn deactivate_session_internal(&self, session_id: &str) {
        let handle_opt = self.app_handle.read().await;
        if let Some(ref handle) = *handle_opt {
            if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
                match sidecar_state.lock() {
                    Ok(mut manager) => {
                        manager.deactivate_session(session_id);
                        ulog_debug!("[TaskScheduler] Deactivated session: {}", session_id);
                    }
                    Err(e) => {
                        ulog_error!("[TaskScheduler] Cannot deactivate session {}: lock poisoned: {}", session_id, e);
                    }
                }
            } else {
                ulog_warn!("[TaskScheduler] Cannot deactivate session {}: SidecarManager state not found", session_id);
            }
        } else {
            ulog_warn!("[TaskScheduler] Cannot deactivate session {}: app handle not available", session_id);
        }
    }

    /// Internal helper to release the task's ownership of the Session Sidecar.
    /// With Session-centric Sidecar (Owner model), this only releases this
    /// task's owner handle. If a Tab still owns the Sidecar, it continues.
    async fn release_task_sidecar(&self, session_id: &str, task_id: &str) {
        let handle_opt = self.app_handle.read().await;
        if let Some(ref handle) = *handle_opt {
            if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
                let owner = SidecarOwner::CronTask(task_id.to_string());
                match release_session_sidecar(&sidecar_state, session_id, &owner) {
                    Ok(stopped) => {
                        if stopped {
                            ulog_info!(
                                "[TaskScheduler] Released task {} from session {}, Sidecar stopped (was last owner)",
                                task_id, session_id
                            );
                        } else {
                            ulog_info!(
                                "[TaskScheduler] Released task {} from session {}, Sidecar continues (Tab still owns it)",
                                task_id, session_id
                            );
                        }
                    }
                    Err(e) => {
                        ulog_error!(
                            "[TaskScheduler] Failed to release task {} from session {}: {}",
                            task_id, session_id, e
                        );
                    }
                }
            } else {
                ulog_warn!("[TaskScheduler] Cannot release task {}: SidecarManager state not found", task_id);
            }
        } else {
            ulog_warn!("[TaskScheduler] Cannot release task {}: app handle not available", task_id);
        }
    }

    /// Atomic check-and-insert on the executing set. Returns true if the
    /// task was successfully reserved (was NOT executing). Caller MUST
    /// release via `mark_task_complete` when done. Single write lock closes
    /// the TOCTOU window where a scheduler tick and a `trigger_now` could
    /// both observe "not executing" (PRD 0.2.5 cross-review C4).
    pub async fn try_mark_task_executing(&self, task_id: &str) -> bool {
        let mut executing = self.executing_tasks.write().await;
        if executing.contains(task_id) {
            return false;
        }
        executing.insert(task_id.to_string());
        ulog_debug!("[TaskScheduler] Task {} reserved as executing (atomic)", task_id);
        true
    }

    /// Mark a task as no longer executing
    pub async fn mark_task_complete(&self, task_id: &str) {
        let mut executing = self.executing_tasks.write().await;
        executing.remove(task_id);
        ulog_debug!("[TaskScheduler] Task {} marked as complete", task_id);
    }

    /// Clone the currently-executing set in one read-lock acquisition (for
    /// view builders that mark `currently_executing` per task).
    pub async fn executing_snapshot(&self) -> HashSet<String> {
        self.executing_tasks.read().await.clone()
    }

    /// Shutdown the manager (stop all scheduler loops)
    pub async fn shutdown(&self) {
        {
            let mut shutdown = self.shutdown.write().await;
            *shutdown = true;
        }
        // Trip every per-task flag too so sleeping loops exit promptly.
        {
            let flags: Vec<Arc<RwLock<bool>>> =
                self.task_shutdowns.read().await.values().cloned().collect();
            for flag in flags {
                let mut f = flag.write().await;
                *f = true;
            }
        }
        ulog_info!("[TaskScheduler] Manager shutdown initiated, awaiting scheduler handles...");

        let handles: Vec<(String, tauri::async_runtime::JoinHandle<()>)> = {
            let mut h = self.scheduler_handles.write().await;
            h.drain().collect()
        };
        for (id, handle) in handles {
            match tokio::time::timeout(Duration::from_secs(5), handle).await {
                Ok(Ok(())) => ulog_debug!("[TaskScheduler] Scheduler {} joined", id),
                Ok(Err(e)) => ulog_warn!("[TaskScheduler] Scheduler {} panicked: {}", id, e),
                Err(_) => ulog_warn!("[TaskScheduler] Scheduler {} join timed out", id),
            }
        }
        ulog_info!("[TaskScheduler] Manager shutdown complete");
    }
}

/// Initial session id for a freshly-created runtime entry: `single-session`
/// run mode may reuse an explicit pre-selected session (e.g. "continue the
/// chat the user already has open"); otherwise each dispatch mints a fresh
/// Sidecar session id.
fn initial_session_id_for(task: &Task) -> String {
    task.preselected_session_id
        .clone()
        .filter(|s| !s.trim().is_empty() && matches!(resolve_run_mode(task), RunMode::SingleSession))
        .unwrap_or_else(|| Uuid::new_v4().to_string())
}

impl TaskSchedulerManager {
    /// Start the scheduler loop for an armed task.
    /// Spawns a background tokio task that executes the Task via Sidecar.
    /// Idempotent: a live loop for the same task is never duplicated.
    pub async fn start_scheduler(&self, task_id: &str) -> Result<(), String> {
        let entry = self.get_entry(task_id).await
            .ok_or_else(|| format!("No runtime entry for task: {}", task_id))?;
        if !entry.armed {
            return Err(format!("Task {} is not armed", task_id));
        }

        // Liveness check + reservation must be atomic (single critical
        // section — see the retired cron engine's v0.1.69 M2 fix for the
        // full race analysis: hold `scheduler_handles.write()` across
        // check → cleanup → reserve → spawn → store).
        let mut handles_guard = self.scheduler_handles.write().await;
        if let Some(existing) = handles_guard.get(task_id) {
            // Disarm 与 re-arm 竞速：该 handle 所属的循环已被 disarm 标记关停，
            // 但还没轮询到关停标记（wallclock 轮询最长 30s）。此时把它当作
            // "已在运行"而跳过重挂，旧循环退出后任务将处于 armed 但无任何
            // 活跃调度的死状态（真机验证 2026-07-31：rerun 后蒸馏弧不再触发）。
            // 已标记关停的 handle 视同失效——直接重挂；旧循环会自行退出。
            let shutdown_flagged = {
                let flags = self.task_shutdowns.read().await;
                match flags.get(task_id) {
                    Some(f) => *f.read().await,
                    None => false,
                }
            };
            if !existing.inner().is_finished() && !shutdown_flagged {
                ulog_info!("[TaskScheduler] Scheduler already running for task {}, skipping", task_id);
                return Ok(());
            }
            // Stale: previous tokio task panicked / aborted / returned early
            // without passing through our cleanup path — or is on its way out
            // via disarm. Drop the dead/dying handle before respawning so the
            // `.insert()` at the end overwrites a known-finished entry.
            ulog_warn!(
                "[TaskScheduler] Scheduler handle for task {} was finished or shutdown-flagged — respawning",
                task_id
            );
            handles_guard.remove(task_id);
        }
        {
            let mut active = self.active_schedulers.write().await;
            active.insert(task_id.to_string());
        }

        // Fresh per-task shutdown flag for this loop incarnation.
        let task_shutdown = Arc::new(RwLock::new(false));
        {
            let mut flags = self.task_shutdowns.write().await;
            flags.insert(task_id.to_string(), Arc::clone(&task_shutdown));
        }

        let entries = Arc::clone(&self.entries);
        let shutdown = Arc::clone(&self.shutdown);
        let executing_tasks = Arc::clone(&self.executing_tasks);
        let active_schedulers = Arc::clone(&self.active_schedulers);
        let app_handle = Arc::clone(&self.app_handle);
        let storage_path = self.storage_path.clone();
        let task_id_owned = task_id.to_string();
        let task_id_for_handle = task_id.to_string();

        let handle = tauri::async_runtime::spawn(async move {
            ulog_info!("[TaskScheduler] Scheduler started for task {} (executions: {})", task_id_owned, entry.execution_count);

            // Wait for app_handle to be available (with timeout) — handles
            // the race where the scheduler starts before initialize completes.
            let mut app_handle_ready = false;
            for i in 0..50 {  // 5 seconds max wait (50 * 100ms)
                let handle_opt = app_handle.read().await;
                if handle_opt.is_some() {
                    app_handle_ready = true;
                    break;
                }
                drop(handle_opt);
                if i == 0 {
                    ulog_warn!("[TaskScheduler] App handle not ready for task {}, waiting...", task_id_owned);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }

            if !app_handle_ready {
                ulog_error!("[TaskScheduler] App handle not available after 5 seconds, aborting scheduler for task {}", task_id_owned);
                let mut active = active_schedulers.write().await;
                active.remove(&task_id_owned);
                return;
            }

            // Fetch the Task — it is the schedule's source of truth.
            let Some(store) = task::get_task_store() else {
                ulog_error!("[TaskScheduler] TaskStore not initialized; aborting scheduler for {}", task_id_owned);
                let mut active = active_schedulers.write().await;
                active.remove(&task_id_owned);
                return;
            };

            let Some(initial_task) = store.get(&task_id_owned).await else {
                ulog_info!("[TaskScheduler] Task {} no longer exists, stopping scheduler", task_id_owned);
                let mut active = active_schedulers.write().await;
                active.remove(&task_id_owned);
                return;
            };

            let Some(initial_schedule) = schedule_from_task(&initial_task) else {
                ulog_error!("[TaskScheduler] Task {} has no resolvable schedule, stopping scheduler", task_id_owned);
                let mut active = active_schedulers.write().await;
                active.remove(&task_id_owned);
                return;
            };

            // Emit scheduler started event to frontend
            {
                let handle_opt = app_handle.read().await;
                if let Some(ref handle) = *handle_opt {
                    let _ = handle.emit("task:scheduler-started", serde_json::json!({
                        "taskId": task_id_owned,
                        "intervalMinutes": interval_minutes_for_payload(&initial_schedule),
                        "executionCount": entry.execution_count
                    }));
                }
            }

            // Compute initial target as a wall-clock time (not a Duration).
            // We use sleep_until_wallclock() which polls Utc::now() instead
            // of tokio::time::sleep() whose monotonic clock pauses during
            // system sleep/suspend.
            let is_loop = matches!(&initial_schedule, TaskSchedule::Loop);
            let interval_secs = match &initial_schedule {
                TaskSchedule::Every { minutes, .. } => (*minutes).max(5) as i64 * 60,
                _ => 60 * 60,
            };
            let last_executed = entry.last_executed_at;
            let execution_count = entry.execution_count;

            let initial_target: Option<DateTime<Utc>> = if is_loop {
                // Ralph Loop: execute immediately (2s startup delay)
                ulog_info!("[TaskScheduler] Task {} Ralph Loop mode, executing in 2 seconds", task_id_owned);
                Some(Utc::now() + chrono::Duration::seconds(2))
            } else if let TaskSchedule::At { ref at } = initial_schedule {
                // One-shot: target is the specified time
                match DateTime::parse_from_rfc3339(at).or_else(|_| DateTime::parse_from_str(at, "%Y-%m-%dT%H:%M:%S")) {
                    Ok(target) => {
                        let target_utc = target.with_timezone(&Utc);
                        let now = Utc::now();
                        if target_utc > now {
                            ulog_info!("[TaskScheduler] Task {} scheduled at {}, waiting {} seconds", task_id_owned, at, (target_utc - now).num_seconds());
                            Some(target_utc)
                        } else {
                            ulog_info!("[TaskScheduler] Task {} target time {} already passed, executing immediately", task_id_owned, at);
                            Some(now + chrono::Duration::seconds(2))
                        }
                    }
                    Err(e) => {
                        ulog_warn!("[TaskScheduler] Task {} invalid 'at' time '{}': {}, executing in 2s", task_id_owned, at, e);
                        Some(Utc::now() + chrono::Duration::seconds(2))
                    }
                }
            } else if let TaskSchedule::Cron { ref expr, ref tz } = initial_schedule {
                // Cron expression: compute next fire time from wall clock
                match next_cron_fire_time(expr, tz.as_deref()) {
                    Ok(target) => {
                        ulog_info!("[TaskScheduler] Task {} cron expr '{}' (tz={:?}), next fire at {} (in {} seconds)",
                            task_id_owned, expr, tz, target, (target - Utc::now()).num_seconds());
                        Some(target)
                    }
                    Err(e) => {
                        ulog_error!("[TaskScheduler] Task {} invalid cron config: {}, stopping scheduler", task_id_owned, e);
                        let mut active = active_schedulers.write().await;
                        active.remove(&task_id_owned);
                        return;
                    }
                }
            } else if let TaskSchedule::Every { start_at: Some(ref sa), .. } = initial_schedule {
                // Every with start_at: wait until the specified start time for first execution
                if execution_count == 0 {
                    match DateTime::parse_from_rfc3339(sa) {
                        Ok(target) => {
                            let target_utc = target.with_timezone(&Utc);
                            let now = Utc::now();
                            if target_utc > now {
                                ulog_info!("[TaskScheduler] Task {} delayed start at {}, waiting {} seconds", task_id_owned, sa, (target_utc - now).num_seconds());
                                Some(target_utc)
                            } else {
                                ulog_info!("[TaskScheduler] Task {} start time {} already passed, executing in 2 seconds", task_id_owned, sa);
                                Some(now + chrono::Duration::seconds(2))
                            }
                        }
                        Err(_) => {
                            ulog_warn!("[TaskScheduler] Task {} invalid start_at '{}', starting in 2 seconds", task_id_owned, sa);
                            Some(Utc::now() + chrono::Duration::seconds(2))
                        }
                    }
                } else if let Some(last_exec) = last_executed {
                    let next_exec = last_exec + chrono::Duration::seconds(interval_secs);
                    Some(next_exec)
                } else {
                    Some(Utc::now() + chrono::Duration::seconds(2))
                }
            } else if execution_count == 0 {
                ulog_info!("[TaskScheduler] Task {} first execution, starting in 2 seconds", task_id_owned);
                Some(Utc::now() + chrono::Duration::seconds(2))
            } else if let Some(last_exec) = last_executed {
                let next_exec = last_exec + chrono::Duration::seconds(interval_secs);
                let now = Utc::now();
                if next_exec > now {
                    ulog_info!("[TaskScheduler] Task {} next execution at {} (in {} seconds, based on lastExecutedAt)",
                        task_id_owned, next_exec, (next_exec - now).num_seconds());
                    Some(next_exec)
                } else {
                    ulog_info!("[TaskScheduler] Task {} is past due, executing in 5 seconds", task_id_owned);
                    Some(now + chrono::Duration::seconds(5))
                }
            } else {
                ulog_info!("[TaskScheduler] Task {} no lastExecutedAt but count={}, waiting full interval", task_id_owned, execution_count);
                Some(Utc::now() + chrono::Duration::seconds(interval_secs))
            };

            // Ralph Loop: track consecutive failures for exponential backoff
            let mut loop_consecutive_failures: u32 = 0;

            // Wait for initial period using wall-clock polling (survives system sleep)
            if let Some(target) = initial_target {
                if !sleep_until_wallclock(target, &shutdown, &task_shutdown, &task_id_owned).await {
                    let mut active = active_schedulers.write().await;
                    active.remove(&task_id_owned);
                    return;
                }
            }

            loop {
                // Check shutdown flags
                if *shutdown.read().await || *task_shutdown.read().await {
                    ulog_info!("[TaskScheduler] Scheduler shutdown for task {}", task_id_owned);
                    break;
                }

                // Re-read the Task every iteration — it is the single source
                // of truth, so config edits between ticks hot-apply.
                let Some(current_task) = store.get(&task_id_owned).await else {
                    ulog_info!("[TaskScheduler] Task {} no longer exists, stopping scheduler", task_id_owned);
                    break;
                };

                // Terminal state → stop the loop. Runtime entry is already
                // disarmed by whichever path transitioned the Task
                // (update_status / delete hooks); ensure it here as backstop.
                if current_task.deleted
                    || matches!(
                        current_task.status,
                        TaskStatus::Deleted
                            | TaskStatus::Archived
                            | TaskStatus::Stopped
                            | TaskStatus::Blocked
                            | TaskStatus::Done
                    )
                {
                    ulog_info!(
                        "[TaskScheduler] Task {} in terminal state '{}', stopping scheduler",
                        task_id_owned, current_task.status.as_str()
                    );
                    {
                        let mut entries_guard = entries.write().await;
                        if let Some(e) = entries_guard.get_mut(&task_id_owned) {
                            e.armed = false;
                        }
                    }
                    break;
                }

                // Recompute the schedule from the latest Task (never captured
                // outside the loop — spec §4).
                let Some(current_schedule) = schedule_from_task(&current_task) else {
                    ulog_error!("[TaskScheduler] Task {} lost its schedule, stopping scheduler", task_id_owned);
                    break;
                };
                let current_interval_secs = match &current_schedule {
                    TaskSchedule::Every { minutes, .. } => (*minutes).max(5) as i64 * 60,
                    _ => 60 * 60,
                };

                // Current runtime counters (re-read — trigger_now may have
                // advanced them since the last iteration).
                let (current_exec_count, _current_last_exec) = {
                    let entries_guard = entries.read().await;
                    entries_guard
                        .get(&task_id_owned)
                        .map(|e| (e.execution_count, e.last_executed_at))
                        .unwrap_or((execution_count, last_executed))
                };

                // Check end conditions before execution
                if check_end_conditions(&current_task, current_exec_count) {
                    ulog_info!("[TaskScheduler] Task {} reached end condition, completing", task_id_owned);
                    if let Some(ref handle) = *app_handle.read().await {
                        stop_scheduled_task_internal(handle, &task_id_owned, None).await;
                    }
                    break;
                }

                // Get app handle for execution (BEFORE reserving the
                // executing slot — if no handle, no point holding the lock).
                let handle_opt = {
                    let handle_guard = app_handle.read().await;
                    handle_guard.clone()
                };

                let Some(handle) = handle_opt else {
                    ulog_error!("[TaskScheduler] No app handle available for task {}, will retry next interval", task_id_owned);
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    continue;
                };

                // Atomic check-and-insert under a single write lock (closes
                // the TOCTOU window where a concurrent `trigger_now` could
                // double-fire).
                let reserved = {
                    let mut executing = executing_tasks.write().await;
                    if executing.contains(&task_id_owned) {
                        false
                    } else {
                        executing.insert(task_id_owned.clone());
                        true
                    }
                };
                if !reserved {
                    ulog_warn!("[TaskScheduler] Task {} is still executing, skipping this interval", task_id_owned);
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    continue;
                }

                let is_first = current_exec_count == 0;
                ulog_info!("[TaskScheduler] Executing task {} (execution #{})", task_id_owned, current_exec_count + 1);

                // Emit execution starting event to frontend
                let _ = handle.emit("task:execution-starting", serde_json::json!({
                    "taskId": task_id_owned,
                    "executionNumber": current_exec_count + 1,
                    "isFirstExecution": is_first
                }));

                // Execute directly via Sidecar with timeout to prevent indefinite hanging
                let exec_start = std::time::Instant::now();
                let execution_result = tokio::time::timeout(
                    Duration::from_secs(3600), // 60 minutes timeout
                    execute_task_tick(&handle, &current_task, is_first)
                ).await;

                let execution_result = match execution_result {
                    Ok(result) => result,
                    Err(_) => {
                        ulog_error!("[TaskScheduler] Task {} execution timed out after 60 minutes", task_id_owned);
                        let _ = handle.emit("task:debug", serde_json::json!({
                            "taskId": task_id_owned,
                            "message": "Execution timed out after 60 minutes",
                            "error": true
                        }));
                        Err("Execution timed out".to_string())
                    }
                };
                let duration_ms = exec_start.elapsed().as_millis() as u64;

                // Record execution history to JSONL
                // Cap content at 2000 chars to prevent JSONL bloat (500 records * large output)
                const MAX_CONTENT_LEN: usize = 2000;
                // Detect graceful terminal-state short-circuit (sentinel).
                let terminal_stop = matches!(&execution_result, Err(e) if e.starts_with(TERMINAL_STOP_SENTINEL));

                // If the task was deleted while this tick was in flight, skip
                // the JSONL write so we don't recreate an orphan run-history
                // file right after `on_task_deleted` cleaned it up.
                let task_still_alive = store.get(&task_id_owned).await.is_some();

                match &execution_result {
                    Ok((success, _, output_text, _)) => {
                        let run_record = TaskRunRecord {
                            ts: Utc::now().timestamp_millis(),
                            ok: *success,
                            duration_ms,
                            content: output_text.as_ref().map(|t| {
                                if t.len() > MAX_CONTENT_LEN {
                                    // Find a valid UTF-8 boundary near the limit
                                    let end = t.char_indices()
                                        .take_while(|(i, _)| *i < MAX_CONTENT_LEN)
                                        .last()
                                        .map(|(i, c)| i + c.len_utf8())
                                        .unwrap_or(MAX_CONTENT_LEN.min(t.len()));
                                    format!("{}...", &t[..end])
                                } else {
                                    t.clone()
                                }
                            }),
                            error: None,
                        };
                        if task_still_alive {
                            if let Err(e) = record_task_run(&task_id_owned, &run_record) {
                                ulog_warn!("[TaskScheduler] Failed to record run: {}", e);
                            }
                        } else {
                            ulog_info!("[TaskScheduler] Skip recording run for deleted task {}", task_id_owned);
                        }
                    }
                    Err(_) if terminal_stop => {
                        // Graceful stop — disarm already happened inside
                        // `execute_task_tick`. Skipping the JSONL write keeps
                        // "最近一次" stats clean.
                    }
                    Err(ref e) => {
                        let run_record = TaskRunRecord {
                            ts: Utc::now().timestamp_millis(),
                            ok: false,
                            duration_ms,
                            content: None,
                            error: Some(e.clone()),
                        };
                        if task_still_alive {
                            let _ = record_task_run(&task_id_owned, &run_record);
                        }
                    }
                }

                // Log the actual execution outcome (not just is_ok which only means "no Rust error")
                match &execution_result {
                    Ok((success, _, _, _)) => {
                        ulog_info!("[TaskScheduler] execute_task_tick completed for task {}: task_success={}", task_id_owned, success);
                        let _ = handle.emit("task:debug", serde_json::json!({
                            "taskId": task_id_owned,
                            "message": format!("execute_task_tick completed: task_success={}", success)
                        }));
                    }
                    Err(_) if terminal_stop => {
                        // Already logged inside the guard — no redundant
                        // failure log/emit.
                    }
                    Err(ref e) => {
                        ulog_warn!("[TaskScheduler] execute_task_tick failed for task {}: {}", task_id_owned, e);
                        let _ = handle.emit("task:debug", serde_json::json!({
                            "taskId": task_id_owned,
                            "message": format!("execute_task_tick failed: {}", e),
                            "error": true
                        }));
                    }
                }

                // Mark task as no longer executing
                {
                    let mut executing = executing_tasks.write().await;
                    executing.remove(&task_id_owned);
                }

                // Handle execution result
                match execution_result {
                    Ok((success, ai_exit_reason, _output_text, internal_sid)) => {
                        // Update execution count, last_executed_at, and
                        // internal_session_id in the runtime entry.
                        let updated_execution_count;
                        {
                            let mut entries_guard = entries.write().await;
                            if let Some(e) = entries_guard.get_mut(&task_id_owned) {
                                let now = Utc::now();
                                e.execution_count += 1;
                                e.last_executed_at = Some(now);
                                e.last_run_ok = Some(success);
                                e.last_run_duration_ms = Some(duration_ms);
                                // Track the internal SDK session ID for frontend session loading
                                if internal_sid.is_some() {
                                    e.internal_session_id = internal_sid.clone();
                                }
                                updated_execution_count = e.execution_count;
                            } else {
                                updated_execution_count = current_exec_count + 1;
                            }
                        }
                        // Mirror onto the Task row (renderer stats read it).
                        store.note_execution(&task_id_owned).await;

                        // Ralph Loop: reset failure counter on success, increment on logical failure
                        let is_loop_now = matches!(&current_schedule, TaskSchedule::Loop);
                        if is_loop_now {
                            if success {
                                loop_consecutive_failures = 0;
                            } else {
                                loop_consecutive_failures += 1;
                                if loop_consecutive_failures >= 10 {
                                    ulog_error!("[TaskScheduler] Task {} Ralph Loop: 10 consecutive failures (logical), stopping", task_id_owned);
                                    stop_scheduled_task_internal(&handle, &task_id_owned,
                                        Some("Ralph Loop: 10 consecutive failures".to_string())).await;
                                    break;
                                }
                                let backoff_secs = match loop_consecutive_failures {
                                    1 => 3, 2 => 10, 3 => 30, 4 => 60, 5 => 120, _ => 300,
                                };
                                ulog_warn!("[TaskScheduler] Task {} Ralph Loop: logical failure #{}, backoff {}s",
                                    task_id_owned, loop_consecutive_failures, backoff_secs);
                            }
                        }

                        // Emit execution-complete for ALL success paths
                        // (one-shot, AI exit, end condition, and normal continue)
                        // Must happen before any break so frontend always gets the update
                        ulog_info!("[TaskScheduler] Emitting task:execution-complete for task {} with executionCount={}", task_id_owned, updated_execution_count);
                        let _ = handle.emit("task:execution-complete", serde_json::json!({
                            "taskId": task_id_owned,
                            "success": success,
                            "executionCount": updated_execution_count,
                            "internalSessionId": internal_sid
                        }));

                        // Check if AI requested exit
                        if let Some(reason) = ai_exit_reason {
                            ulog_info!("[TaskScheduler] Task {} AI requested exit: {}", task_id_owned, reason);
                            stop_scheduled_task_internal(&handle, &task_id_owned, Some(reason)).await;
                            break;
                        }

                        // One-shot tasks (schedule::at) complete after first execution
                        let is_one_shot_now = matches!(&current_schedule, TaskSchedule::At { .. });
                        if is_one_shot_now {
                            ulog_info!("[TaskScheduler] Task {} is one-shot (schedule::at), completing after execution", task_id_owned);
                            stop_scheduled_task_internal(&handle, &task_id_owned, Some("One-shot task completed".to_string())).await;
                            break;
                        }

                        // Check end conditions after execution
                        let should_stop = {
                            let entries_guard = entries.read().await;
                            let count = entries_guard
                                .get(&task_id_owned)
                                .map(|e| e.execution_count)
                                .unwrap_or(updated_execution_count);
                            check_end_conditions(&current_task, count)
                        };
                        if should_stop {
                            ulog_info!("[TaskScheduler] Task {} reached end condition after execution", task_id_owned);
                            stop_scheduled_task_internal(&handle, &task_id_owned, None).await;
                            break;
                        }
                    }
                    Err(e) if e.starts_with(TERMINAL_STOP_SENTINEL) => {
                        // Graceful stop via sentinel — disarm already happened
                        // inside `execute_task_tick`. The next loop iteration's
                        // shutdown-flag / terminal-state check will break.
                        // Skip `task:execution-error` so the UI doesn't briefly
                        // show this as a failed tick. Also skip the Ralph Loop
                        // backoff branch — this is a terminal stop, not a
                        // retryable failure.
                        ulog_info!(
                            "[TaskScheduler] Task {} exited via terminal-stop sentinel: {}",
                            task_id_owned,
                            e.trim_start_matches(TERMINAL_STOP_SENTINEL)
                        );
                    }
                    Err(e) => {
                        ulog_error!("[TaskScheduler] Task {} execution failed: {}", task_id_owned, e);
                        // Denormalized last-run summary
                        {
                            let mut entries_guard = entries.write().await;
                            if let Some(en) = entries_guard.get_mut(&task_id_owned) {
                                en.last_run_ok = Some(false);
                                en.last_run_duration_ms = Some(duration_ms);
                            }
                        }
                        // Emit error event for frontend
                        let _ = handle.emit("task:execution-error", serde_json::json!({
                            "taskId": task_id_owned,
                            "error": e
                        }));

                        // Ralph Loop: exponential backoff on failure (3→10→30→60→120→300s, max 10 consecutive)
                        let is_loop_now = matches!(&current_schedule, TaskSchedule::Loop);
                        if is_loop_now {
                            loop_consecutive_failures += 1;
                            if loop_consecutive_failures >= 10 {
                                ulog_error!("[TaskScheduler] Task {} Ralph Loop: 10 consecutive failures, stopping", task_id_owned);
                                stop_scheduled_task_internal(&handle, &task_id_owned,
                                    Some("Ralph Loop: 10 consecutive failures".to_string())).await;
                                break;
                            }
                            let backoff_secs = match loop_consecutive_failures {
                                1 => 3, 2 => 10, 3 => 30, 4 => 60, 5 => 120, _ => 300,
                            };
                            ulog_warn!("[TaskScheduler] Task {} Ralph Loop: failure #{}, backoff {}s",
                                task_id_owned, loop_consecutive_failures, backoff_secs);
                            let backoff_target = Utc::now() + chrono::Duration::seconds(backoff_secs as i64);
                            if !sleep_until_wallclock(backoff_target, &shutdown, &task_shutdown, &task_id_owned).await {
                                ulog_info!("[TaskScheduler] Task {} shutdown during Loop backoff", task_id_owned);
                                break;
                            }
                        }
                        // Continue to next interval (don't break on error)
                    }
                }

                // Save updated runtime state atomically (temp file + rename)
                if let Err(e) = atomic_save_entries(&storage_path, &entries).await {
                    ulog_warn!("[TaskScheduler] Failed to save runtime state: {}", e);
                }

                // Ralph Loop: skip time-based scheduling, re-execute after 3s buffer
                if matches!(&current_schedule, TaskSchedule::Loop) {
                    ulog_info!("[TaskScheduler] Task {} Ralph Loop: next execution in 3 seconds", task_id_owned);
                    let buffer_target = Utc::now() + chrono::Duration::seconds(3);
                    if !sleep_until_wallclock(buffer_target, &shutdown, &task_shutdown, &task_id_owned).await {
                        ulog_info!("[TaskScheduler] Task {} shutdown during Loop buffer", task_id_owned);
                        break;
                    }
                    continue;
                }

                // Wait for the next execution time using wall-clock polling.
                // This survives system sleep/suspend — after wake, the poll detects
                // that wall-clock time has passed and fires within ≤30 seconds.
                let next_target = match &current_schedule {
                    TaskSchedule::Cron { expr, tz } => {
                        match next_cron_fire_time(expr, tz.as_deref()) {
                            Ok(target) => {
                                ulog_info!("[TaskScheduler] Task {} cron next fire at {} (in {} seconds)",
                                    task_id_owned, target, (target - Utc::now()).num_seconds());
                                target
                            }
                            Err(e) => {
                                ulog_error!("[TaskScheduler] Task {} cron schedule error: {}, stopping", task_id_owned, e);
                                break;
                            }
                        }
                    }
                    TaskSchedule::Every { .. } => {
                        // Fixed interval: next = now + interval
                        let target = Utc::now() + chrono::Duration::seconds(current_interval_secs);
                        ulog_info!("[TaskScheduler] Task {} next execution at {} (in {} seconds)",
                            task_id_owned, target, current_interval_secs);
                        target
                    }
                    // At already broke out above; Loop continued above.
                    _ => break,
                };
                if !sleep_until_wallclock(next_target, &shutdown, &task_shutdown, &task_id_owned).await {
                    ulog_info!("[TaskScheduler] Task {} shutdown during wait", task_id_owned);
                    break;
                }
            }

            // Clean up: remove from active schedulers
            {
                let mut active = active_schedulers.write().await;
                active.remove(&task_id_owned);
            }
            ulog_info!("[TaskScheduler] Scheduler loop exited for task {}", task_id_owned);
        });

        // Store JoinHandle under the same critical section that gated the
        // liveness check above — no race window between spawn and insert.
        handles_guard.insert(task_id_for_handle, handle);
        drop(handles_guard);

        Ok(())
    }
}

/// Check if a task should end based on its end conditions (deadline /
/// maxExecutions). `execution_count` comes from the runtime entry.
fn check_end_conditions(task: &Task, execution_count: u32) -> bool {
    let ec = effective_end_conditions(task);

    // Check deadline
    if let Some(deadline_ms) = ec.deadline {
        if Utc::now().timestamp_millis() >= deadline_ms {
            ulog_info!("[TaskScheduler] Task {} reached deadline", task.id);
            return true;
        }
    }

    // Check max executions
    if let Some(max) = ec.max_executions {
        if execution_count >= max {
            ulog_info!("[TaskScheduler] Task {} reached max executions ({})", task.id, max);
            return true;
        }
    }

    false
}

// ============ Execution ============

/// Rotate the session id for a `NewSession` task ahead of the next execution.
///
/// Keeps the Rust `ManagedSidecar` registry key and Bun's actual session id in
/// lockstep (see the retired engine's Bug A, v0.1.69: without rotation, Bun
/// generated its own id internally, the registry was keyed by the placeholder,
/// and opening the session from history spawned a duplicate read-only sidecar).
///
/// Side effects:
///   - Releases the task's ownership of the previous session's sidecar.
///     If that was the only owner, the sidecar stops. If a Tab had joined it,
///     the tab stays the remaining owner and the sidecar continues — benign.
///   - Writes the new id back to the runtime entry (`session_id` +
///     `internal_session_id` kept in lockstep) and persists synchronously —
///     a crash between rotate and the next mutation-triggered save must not
///     leave task_runtime.json pointing at a stale session id.
async fn rotate_new_session_id(handle: &AppHandle, task_id: &str) -> Result<String, String> {
    let new_session_id = Uuid::new_v4().to_string();
    let manager = get_task_scheduler_manager();

    let old_session_id = {
        let entries = manager.entries.read().await;
        entries.get(task_id).map(|e| e.session_id.clone())
    };

    if let Some(ref old_sid) = old_session_id {
        if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
            let owner = SidecarOwner::CronTask(task_id.to_string());
            if let Err(e) = release_session_sidecar(&sidecar_state, old_sid, &owner) {
                // Non-fatal: release failure just means the sidecar may linger
                // until another owner releases it or the app exits.
                ulog_warn!(
                    "[TaskScheduler] rotate_new_session_id: release old session {} failed: {} (non-fatal)",
                    old_sid, e
                );
            }
        }
    }

    {
        let mut entries = manager.entries.write().await;
        if let Some(e) = entries.get_mut(task_id) {
            e.session_id = new_session_id.clone();
            // Keep `internal_session_id` in lockstep so any consumer that
            // falls back to `internalSessionId || sessionId` doesn't observe
            // a tick-start window where they disagree. Post-rotation these
            // are semantically the same thing: Bun's real session id.
            e.internal_session_id = Some(new_session_id.clone());
        }
    }

    // Persist the rotation synchronously (low-frequency: once per tick).
    if let Err(e) = manager.save_to_disk().await {
        // Non-fatal — execution proceeds on the in-memory id.
        ulog_warn!(
            "[TaskScheduler] rotate_new_session_id: save_to_disk failed for task {}: {} (non-fatal, in-memory id in use)",
            task_id, e
        );
    }

    ulog_info!(
        "[TaskScheduler] new_session rotate: task {} session_id {:?} → {}",
        task_id, old_session_id, new_session_id
    );

    Ok(new_session_id)
}

/// Execute a Task directly via Sidecar.
/// Returns (success, ai_exit_reason, output_text, internal_session_id) tuple.
async fn execute_task_tick(
    handle: &AppHandle,
    task: &Task,
    is_first_execution: bool,
) -> Result<(bool, Option<String>, Option<String>, Option<String>), String> {
    ulog_info!("[TaskScheduler] execute_task_tick starting for task {}", task.id);

    // Hold a system wake-lock for the duration of this execution to prevent
    // idle-sleep from killing the SDK's long-lived HTTPS stream. Real
    // incident: 2026-05-19 19:11 — Mac went idle during an issue-triage run,
    // TCP stream died, SDK never detected the dead socket, watchdog killed
    // the turn with empty output. `.ok()` so wake-lock failure never aborts
    // the execution (running without protection ≡ pre-wake-lock behavior).
    let _wake_lock = crate::wake_lock::WakeLock::acquire(&format!(
        "scheduled task {} ({})",
        task.id, task.name
    ))
    .map_err(|e| {
        ulog_warn!("[TaskScheduler] wake-lock acquire failed for {}: {} — continuing without protection", task.id, e);
        e
    })
    .ok();

    let _ = handle.emit("task:debug", serde_json::json!({
        "taskId": task.id,
        "message": "execute_task_tick: entering function"
    }));

    // Get SidecarManager state
    let sidecar_state = match handle.try_state::<ManagedSidecarManager>() {
        Some(state) => state,
        None => {
            ulog_error!("[TaskScheduler] SidecarManager state not available for task {}", task.id);
            let _ = handle.emit("task:debug", serde_json::json!({
                "taskId": task.id,
                "message": "execute_task_tick: SidecarManager state NOT available",
                "error": true
            }));
            return Err("SidecarManager state not available".to_string());
        }
    };

    // Terminal-state guard (H2): the Task may have transitioned to a terminal
    // state between the loop's iteration-top check and now. Without this, the
    // scheduler would keep firing every tick, each time failing — a silent
    // error loop that burns disk on task_runs and spams the unified log.
    if let Some(store) = task::get_task_store() {
        match store.get(&task.id).await {
            Some(fresh)
                if fresh.deleted
                    || matches!(
                        fresh.status,
                        TaskStatus::Deleted
                            | TaskStatus::Archived
                            | TaskStatus::Stopped
                            | TaskStatus::Blocked
                            | TaskStatus::Done
                    ) =>
            {
                let reason = format!(
                    "task {} entered terminal state '{}'",
                    task.id,
                    fresh.status.as_str()
                );
                ulog_warn!(
                    "[TaskScheduler] {} — disarming to prevent scheduler loop",
                    reason
                );
                get_task_scheduler_manager()
                    .disarm(&task.id, Some(reason.clone()))
                    .await;
                return Err(format!("{}{}", TERMINAL_STOP_SENTINEL, reason));
            }
            None => {
                let reason = format!("task {} no longer exists", task.id);
                get_task_scheduler_manager()
                    .disarm(&task.id, Some(reason.clone()))
                    .await;
                return Err(format!("{}{}", TERMINAL_STOP_SENTINEL, reason));
            }
            _ => {}
        }
    }

    // Per-tick session-id rotation for new_session mode. For single_session
    // mode the runtime entry's session_id is the stable identity of the
    // ongoing conversation; never rotated.
    let run_mode = resolve_run_mode(task);
    let run_mode_str = match run_mode {
        RunMode::SingleSession => "single_session",
        RunMode::NewSession => "new_session",
    };
    let manager = get_task_scheduler_manager();
    let entry = manager
        .get_entry(&task.id)
        .await
        .ok_or_else(|| format!("No runtime entry for task {}", task.id))?;
    let effective_session_id = if run_mode == RunMode::NewSession {
        rotate_new_session_id(handle, &task.id).await?
    } else {
        entry.session_id.clone()
    };

    // Append the session id to `task.sessionIds[]` so the "任务执行" panel in
    // TaskDetailOverlay can surface every execution (one row per tick for
    // new_session, one stable row for single_session). `append_session` is
    // idempotent (dedup'd) so the single_session case safely no-ops after
    // the first tick.
    //
    // Done at the Rust dispatch point (not delegated to the AI via CLI) so
    // coverage is guaranteed for every execution regardless of AI cooperation.
    if let Some(store) = task::get_task_store() {
        if let Err(e) = store.append_session(&task.id, &effective_session_id).await {
            // Non-fatal — the execution proceeds; the missing link just means
            // this run won't appear in the task detail 任务执行 list.
            ulog_warn!(
                "[TaskScheduler] append_session(task={}, session={}) failed: {} — 任务执行 UI will miss this run",
                task.id, effective_session_id, e
            );
        }
    }

    // Build execution payload. execution_number is 1-based (first = 1).
    let execution_number = entry.execution_count + 1;
    let schedule = schedule_from_task(task)
        .ok_or_else(|| format!("task {} has no resolvable schedule", task.id))?;
    let ec = effective_end_conditions(task);

    // PRD §9.3.1: the prompt is built dynamically from the latest
    // `~/.zhishi/tasks/<id>/task.md` (or alignment state) so edits between
    // firings are picked up by the next execution.
    let prompt_to_send = match task::build_dispatch_prompt(&task.id).await {
        Some(Ok(p)) => p,
        Some(Err(e)) => {
            ulog_error!(
                "[TaskScheduler] task {} dispatch prompt build failed: {} — blocking Task",
                task.id, e
            );
            // Transition Task to Blocked so the UI surfaces the problem.
            if let Some(store) = task::get_task_store() {
                let _ = store
                    .update_status(task::TaskUpdateStatusInput {
                        id: task.id.clone(),
                        status: TaskStatus::Blocked,
                        message: Some(format!("dispatch prompt build failed: {}", e)),
                        actor: task::TransitionActor::System,
                        source: Some(task::TransitionSource::Crash),
                    })
                    .await;
            }
            return Err(format!("dispatch prompt build failed: {}", e));
        }
        None => {
            // Store or task vanished between the guard above and here —
            // vanishingly rare; treat as a regular failure (run recorded).
            return Err(format!("dispatch prompt unavailable for task {}", task.id));
        }
    };

    let payload = ScheduledTaskExecutePayload {
        task_id: task.id.clone(),
        prompt: prompt_to_send,
        session_id: Some(effective_session_id.clone()),
        is_first_execution: Some(is_first_execution),
        ai_can_exit: Some(ec.ai_can_exit),
        permission_mode: Some(task.permission_mode.clone().unwrap_or_default()),
        model: task.model.clone(),
        // Task Center tasks never persist credential snapshots — the sidecar
        // live-resolves `provider_id` on every tick (PRD 0.2.9 R2 invariant:
        // zero credential copies on disk).
        provider_env: None,
        provider_id: task.provider_id.clone(),
        // Intent is subordinate to provider_id; sidecar ignores it when
        // provider_id is set. FollowAgent keeps the snapshot semantics for
        // the provider_id == None path.
        provider_intent: Some(ProviderIntent::FollowAgent),
        runtime: task.runtime.clone(),
        runtime_config: task.runtime_config.clone(),
        mcp_enabled_servers: task.mcp_enabled_servers.clone(),
        run_mode: Some(run_mode_str.to_string()),
        interval_minutes: Some(interval_minutes_for_payload(&schedule)),
        execution_number: Some(execution_number),
    };

    let _ = handle.emit("task:debug", serde_json::json!({
        "taskId": task.id,
        "message": format!("execute_task_tick: calling execute_scheduled_task, workspace={}", task.workspace_path)
    }));

    ulog_info!("[TaskScheduler] Built payload for task {}, calling execute_scheduled_task with workspace: {}", task.id, task.workspace_path);

    // Execute via Sidecar
    let result = execute_scheduled_task(handle, &sidecar_state, &task.workspace_path, payload).await
        .map_err(|e| {
            ulog_error!("[TaskScheduler] execute_scheduled_task failed for task {}: {}", task.id, e);
            let _ = handle.emit("task:debug", serde_json::json!({
                "taskId": task.id,
                "message": format!("execute_task_tick: execute_scheduled_task FAILED: {}", e),
                "error": true
            }));
            e
        })?;

    let _ = handle.emit("task:debug", serde_json::json!({
        "taskId": task.id,
        "message": format!("execute_task_tick: execute_scheduled_task completed, task_success={}", result.success)
    }));

    ulog_info!("[TaskScheduler] execute_scheduled_task completed for task {}, task_success={}", task.id, result.success);

    // PRD 0.2.9 — Provider-resolution failure should permanently Block the
    // Task, not just record `last_run_ok=false`. The sidecar surfaces these
    // via `success:false` + an error string starting with "Provider 'X'":
    //   - "Provider 'X' not found in config" — provider deleted
    //   - "Provider 'X' has no API Key" — credential removed
    // Both are deterministic per-tick failures: re-running on the next tick
    // will fail the same way until the user re-picks a provider. Mark the
    // Task as Blocked (which disarms the scheduler via the update_status
    // hook) so the UI surfaces the actionable error.
    if !result.success {
        let err_msg = result.error.clone().unwrap_or_default();
        let is_provider_resolution_failure = err_msg.starts_with("Provider '")
            && (err_msg.contains("not found in config")
                || err_msg.contains("has no API Key"));
        if is_provider_resolution_failure {
            ulog_error!(
                "[TaskScheduler] task {} provider resolution failed: {} — blocking Task",
                task.id, err_msg
            );
            if let Some(store) = task::get_task_store() {
                let _ = store
                    .update_status(task::TaskUpdateStatusInput {
                        id: task.id.clone(),
                        status: TaskStatus::Blocked,
                        message: Some(err_msg.clone()),
                        actor: task::TransitionActor::System,
                        source: Some(task::TransitionSource::Crash),
                    })
                    .await;
            }
            // Disarm too so the scheduler doesn't keep retrying every
            // interval. The user's UI action (re-pick provider → save)
            // re-arms via /api/task/run.
            get_task_scheduler_manager()
                .disarm(&task.id, Some(format!("provider unavailable: {}", err_msg)))
                .await;
        }
    }

    // Per-tick desktop notification (notification.desktop defaults to true).
    let desktop_enabled = task.notification.as_ref().map(|n| n.desktop).unwrap_or(true);
    if desktop_enabled {
        send_tick_notification(handle, task, &entry, &result);
    }

    let ai_exit_reason = if result.ai_requested_exit == Some(true) {
        result.exit_reason
    } else {
        None
    };

    Ok((result.success, ai_exit_reason, result.output_text, result.session_id))
}

/// Send system notification for a task execution tick.
fn send_tick_notification(
    handle: &AppHandle,
    _task: &Task,
    entry: &TaskRuntimeEntry,
    result: &crate::sidecar::ScheduledTaskExecuteResponse,
) {
    let title = if result.success {
        "定时任务执行完成".to_string()
    } else {
        "定时任务执行失败".to_string()
    };

    let body = if let Some(ref reason) = result.exit_reason {
        format!("智能体主动结束: {}", reason)
    } else if let Some(ref error) = result.error {
        format!("错误: {}", error)
    } else {
        format!("任务 #{} 已完成", entry.execution_count + 1)
    };

    // Send the OS notification through the unified notification module so the
    // click handler is wired structurally (Windows toast Activated, macOS /
    // Linux fallback).
    crate::notification::show_with_navigation(handle, &title, &body, entry.tab_id.clone());
}

/// Scheduler-initiated stop: disarm the scheduler (loop signal + runtime
/// entry + sidecar release + `task:task-stopped`) and then propagate
/// completion to the Task row (`→ done` with the right actor/source).
/// Used when end conditions are met, the AI requests exit, or a one-shot
/// finishes — i.e. the "good exit" flows.
async fn stop_scheduled_task_internal(
    handle: &AppHandle,
    task_id: &str,
    exit_reason: Option<String>,
) {
    let _ = handle; // disarm emits through the manager's app handle
    get_task_scheduler_manager()
        .disarm(task_id, exit_reason.clone())
        .await;
    complete_task_after_stop(task_id, exit_reason.as_deref()).await;
    ulog_info!("[TaskScheduler] Task {} stopped", task_id);
}

/// Completion bridge (replaces `task::mark_cron_completion_if_linked`):
/// when the scheduler concludes a Task (endConditions / AI exit / one-shot),
/// transition the Task to `done` with the right actor/source. Going through
/// `update_status` means the trust-ledger hook + notifications fire naturally.
///
/// Only fires for tasks still in "active" states — don't re-transition a
/// task the user already marked done/blocked/stopped via the UI.
async fn complete_task_after_stop(task_id: &str, exit_reason: Option<&str>) {
    let Some(store) = task::get_task_store() else {
        return;
    };
    let Some(ta) = store.get(task_id).await else {
        return;
    };
    if !matches!(ta.status, TaskStatus::Running | TaskStatus::Verifying) {
        return;
    }

    // Classify the exit reason (PRD §9.1 + §12.2 caller-inference):
    //   - `None` or "completed" / "executions" / "deadline" → endCondition → done
    //   - explicit string from the AI exit tool → agent/cli → done
    let (message, actor, source) = match exit_reason {
        None => (
            "endCondition fired".to_string(),
            task::TransitionActor::System,
            task::TransitionSource::EndCondition,
        ),
        Some(reason) => {
            let low = reason.to_lowercase();
            if low.contains("one-shot")
                || low.contains("max executions")
                || low.contains("deadline")
                || low.contains("endcondition")
            {
                (
                    reason.to_string(),
                    task::TransitionActor::System,
                    task::TransitionSource::EndCondition,
                )
            } else {
                // AI-requested exit.
                (
                    reason.to_string(),
                    task::TransitionActor::Agent,
                    task::TransitionSource::Cli,
                )
            }
        }
    };

    if let Err(e) = store
        .update_status(task::TaskUpdateStatusInput {
            id: task_id.to_string(),
            status: TaskStatus::Done,
            message: Some(message),
            actor,
            source: Some(source),
        })
        .await
    {
        ulog_warn!(
            "[TaskScheduler] completion transition for {}: update_status failed: {}",
            task_id, e
        );
    }
}

impl TaskSchedulerManager {
    /// Fire one immediate execution of an existing task without changing its
    /// armed state / schedule. Fire-and-forget: returns as soon as the
    /// execution is dispatched.
    ///
    /// Conflict semantics: if the task is currently executing (scheduled tick
    /// or earlier run-now), return Err with a hint to retry later.
    pub async fn trigger_now(&self, task_id: &str) -> Result<TriggerNowInfo, String> {
        let store = task::get_task_store()
            .ok_or_else(|| "Task store not initialized".to_string())?;
        let task = store.get(task_id).await
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        // Validate app_handle BEFORE reserving the executing slot (an early
        // Err here would otherwise leak the reservation forever).
        let handle = self.app_handle.read().await.clone()
            .ok_or_else(|| "App handle not initialized".to_string())?;

        // Atomic check-and-reserve (closes the TOCTOU window vs a scheduler
        // tick or another trigger_now).
        if !self.try_mark_task_executing(task_id).await {
            return Err(format!(
                "Cannot run-now: a scheduled tick or earlier run-now is firing for {} this instant. \
                 Wait for it to finish (typically <60s).",
                task_id
            ));
        }

        // A runtime entry must exist for session bookkeeping; create one on
        // the fly if this task was never armed (trigger_now works on any
        // non-deleted task, armed or not — same as the old engine).
        let session_id = {
            let mut entries = self.entries.write().await;
            let entry = entries.entry(task_id.to_string()).or_insert_with(|| TaskRuntimeEntry {
                task_id: task_id.to_string(),
                session_id: initial_session_id_for(&task),
                internal_session_id: None,
                tab_id: None,
                execution_count: 0,
                last_executed_at: None,
                last_run_ok: None,
                last_run_duration_ms: None,
                exit_reason: None,
                armed: false,
            });
            entry.session_id.clone()
        };

        let dispatched_at = Utc::now();
        let task_id_owned = task_id.to_string();
        let entries = Arc::clone(&self.entries);
        let executing_tasks = Arc::clone(&self.executing_tasks);
        let storage_path = self.storage_path.clone();

        // Fire-and-forget: spawn the execution off-task. The caller returns
        // to the user the moment dispatch starts.
        tauri::async_runtime::spawn(async move {
            // Snapshot the latest Task state inside the spawned task so we
            // pick up any mutation since the trigger arrived.
            let Some(t) = store.get(&task_id_owned).await else {
                ulog_warn!("[TaskScheduler] trigger_now: task {} disappeared before dispatch", task_id_owned);
                let mut executing = executing_tasks.write().await;
                executing.remove(&task_id_owned);
                return;
            };

            let current_exec_count = {
                let entries_guard = entries.read().await;
                entries_guard.get(&task_id_owned).map(|e| e.execution_count).unwrap_or(0)
            };

            // Emit execution-starting so frontend/IM users see the same
            // lifecycle signals as a scheduled tick.
            let _ = handle.emit("task:execution-starting", serde_json::json!({
                "taskId": task_id_owned,
                "executionNumber": current_exec_count + 1,
                "isFirstExecution": false,
                "trigger": "manual",  // distinguishes from scheduler ticks
            }));

            // 60min timeout matches the scheduler's tick timeout — without
            // it, a hung manual run would keep the task permanently reserved.
            let exec_start = std::time::Instant::now();
            let timed = tokio::time::timeout(
                Duration::from_secs(3600),
                execute_task_tick(&handle, &t, false /* is_first_execution */),
            ).await;
            let duration_ms = exec_start.elapsed().as_millis() as u64;
            let result = match timed {
                Ok(r) => r,
                Err(_) => {
                    ulog_error!("[TaskScheduler] trigger_now: task {} timed out after 60 minutes", task_id_owned);
                    Err("Execution timed out".to_string())
                }
            };

            // Skip JSONL write if the task was deleted while this manual run
            // was in flight (would resurrect the run-history file).
            let task_still_alive = store.get(&task_id_owned).await.is_some();

            const MAX_CONTENT_LEN: usize = 2000;
            let terminal_stop = matches!(&result, Err(e) if e.starts_with(TERMINAL_STOP_SENTINEL));
            match &result {
                Ok((success, ai_exit_reason, output_text, internal_sid)) => {
                    let run_record = TaskRunRecord {
                        ts: Utc::now().timestamp_millis(),
                        ok: *success,
                        duration_ms,
                        content: output_text.as_ref().map(|t| {
                            if t.len() > MAX_CONTENT_LEN {
                                let end = t.char_indices()
                                    .take_while(|(i, _)| *i < MAX_CONTENT_LEN)
                                    .last()
                                    .map(|(i, c)| i + c.len_utf8())
                                    .unwrap_or(MAX_CONTENT_LEN.min(t.len()));
                                format!("{}...", &t[..end])
                            } else {
                                t.clone()
                            }
                        }),
                        error: None,
                    };
                    if task_still_alive {
                        let _ = record_task_run(&task_id_owned, &run_record);
                    }

                    // Denormalize + post-process — mirror of the scheduler
                    // loop's Ok branch.
                    let updated_execution_count = {
                        let mut entries_guard = entries.write().await;
                        if let Some(e) = entries_guard.get_mut(&task_id_owned) {
                            e.execution_count += 1;
                            e.last_executed_at = Some(Utc::now());
                            e.last_run_ok = Some(*success);
                            e.last_run_duration_ms = Some(duration_ms);
                            if internal_sid.is_some() {
                                e.internal_session_id = internal_sid.clone();
                            }
                            e.execution_count
                        } else {
                            current_exec_count + 1
                        }
                    };
                    store.note_execution(&task_id_owned).await;

                    let _ = handle.emit("task:execution-complete", serde_json::json!({
                        "taskId": task_id_owned,
                        "success": success,
                        "executionCount": updated_execution_count,
                        "internalSessionId": internal_sid,
                        "trigger": "manual",
                    }));

                    // ai_exit_reason → stop the task. Even on a manual
                    // trigger, if the AI requests exit we honor it
                    // (consistent with scheduler behavior).
                    if let Some(reason) = ai_exit_reason.clone() {
                        ulog_info!("[TaskScheduler] trigger_now: task {} AI requested exit: {}", task_id_owned, reason);
                        stop_scheduled_task_internal(&handle, &task_id_owned, Some(reason)).await;
                    } else {
                        // End condition check (deadline / max_executions)
                        let count = {
                            let entries_guard = entries.read().await;
                            entries_guard.get(&task_id_owned).map(|e| e.execution_count).unwrap_or(updated_execution_count)
                        };
                        if check_end_conditions(&t, count) {
                            ulog_info!("[TaskScheduler] trigger_now: task {} reached end condition", task_id_owned);
                            stop_scheduled_task_internal(&handle, &task_id_owned, None).await;
                        }
                    }
                }
                Err(_) if terminal_stop => {
                    // Graceful stop already executed inside execute_task_tick.
                }
                Err(ref e) => {
                    let run_record = TaskRunRecord {
                        ts: Utc::now().timestamp_millis(),
                        ok: false,
                        duration_ms,
                        content: None,
                        error: Some(e.clone()),
                    };
                    if task_still_alive {
                        let _ = record_task_run(&task_id_owned, &run_record);
                    }
                    {
                        let mut entries_guard = entries.write().await;
                        if let Some(en) = entries_guard.get_mut(&task_id_owned) {
                            en.last_run_ok = Some(false);
                            en.last_run_duration_ms = Some(duration_ms);
                        }
                    }
                    let _ = handle.emit("task:execution-error", serde_json::json!({
                        "taskId": task_id_owned,
                        "error": e,
                        "trigger": "manual",
                    }));
                }
            }

            // Persist updates (best-effort).
            if let Err(e) = atomic_save_entries(&storage_path, &entries).await {
                ulog_warn!("[TaskScheduler] trigger_now: failed to persist post-run state: {}", e);
            }

            // Release the executing lock — must run on every path.
            let mut executing = executing_tasks.write().await;
            executing.remove(&task_id_owned);

            ulog_info!("[TaskScheduler] trigger_now completed for task {} in {}ms", task_id_owned, duration_ms);
        });

        Ok(TriggerNowInfo {
            task_id: task_id.to_string(),
            session_id,
            dispatched_at: dispatched_at.to_rfc3339(),
        })
    }

    /// Build renderer views for all runtime entries (joined with Task rows).
    pub async fn list_views(&self) -> Vec<ScheduledTaskView> {
        let entries: Vec<TaskRuntimeEntry> = self.entries.read().await.values().cloned().collect();
        let executing = self.executing_snapshot().await;
        let mut out = Vec::new();
        if let Some(store) = task::get_task_store() {
            for entry in entries {
                let Some(ta) = store.get(&entry.task_id).await else {
                    continue; // Task gone — entry is orphaned; skip (delete path removes it)
                };
                out.push(build_view(&ta, &entry, executing.contains(&entry.task_id)));
            }
        }
        out
    }

    /// View for the armed task bound to a tab, if any.
    pub async fn view_for_tab(&self, tab_id: &str) -> Option<ScheduledTaskView> {
        let entries: Vec<TaskRuntimeEntry> = self.entries.read().await.values().cloned().collect();
        let executing = self.executing_snapshot().await;
        let store = task::get_task_store()?;
        for entry in entries {
            if entry.tab_id.as_deref() == Some(tab_id) && entry.armed {
                if let Some(ta) = store.get(&entry.task_id).await {
                    return Some(build_view(&ta, &entry, executing.contains(&entry.task_id)));
                }
            }
        }
        None
    }

    /// 定时预告（Novo 搭子）：window_ms 内最近的一次下次触发。
    /// 返回 (任务名, RFC3339 触发时间)。
    /// 系统内置任务（蒸馏弧）排除在外——可见的应该是信息（它想起了什么），
    /// 不是记忆机器的内部节律；否则空任务列表时搭子每小时只会念叨「蒸馏弧」。
    pub async fn next_execution_soon(&self, window_ms: i64) -> Option<(String, String)> {
        let now = chrono::Utc::now();
        let mut best: Option<(chrono::DateTime<chrono::Utc>, String, String)> = None;
        let store = task::get_task_store()?;
        let entries: Vec<TaskRuntimeEntry> = self.entries.read().await.values().cloned().collect();
        for entry in entries {
            let Some(ta) = store.get(&entry.task_id).await else { continue };
            if ta.dispatch_origin == task::TaskDispatchOrigin::System {
                continue;
            }
            let Some(at) = compute_next_execution(&ta, &entry) else { continue };
            let Ok(t) = chrono::DateTime::parse_from_rfc3339(&at) else { continue };
            let t = t.with_timezone(&chrono::Utc);
            let delta = t - now;
            if delta < chrono::Duration::zero() || delta > chrono::Duration::milliseconds(window_ms) {
                continue;
            }
            if best.as_ref().map(|(bt, _, _)| t < *bt).unwrap_or(true) {
                best = Some((t, ta.name.clone(), at.clone()));
            }
        }
        best.map(|(_, name, at)| (name, at))
    }

    /// View for the armed task occupying a session, if any.
    pub async fn view_for_session(&self, session_id: &str) -> Option<ScheduledTaskView> {
        let entries: Vec<TaskRuntimeEntry> = self.entries.read().await.values().cloned().collect();
        let executing = self.executing_snapshot().await;
        let store = task::get_task_store()?;
        for entry in entries {
            if !entry.armed {
                continue;
            }
            if entry.session_id == session_id
                || entry.internal_session_id.as_deref() == Some(session_id)
            {
                if let Some(ta) = store.get(&entry.task_id).await {
                    return Some(build_view(&ta, &entry, executing.contains(&entry.task_id)));
                }
            }
        }
        None
    }

    /// Update the tab binding of a task's runtime entry.
    pub async fn bind_tab(&self, task_id: &str, tab_id: Option<String>) -> Result<(), String> {
        {
            let mut entries = self.entries.write().await;
            let entry = entries
                .get_mut(task_id)
                .ok_or_else(|| format!("No runtime entry for task: {}", task_id))?;
            entry.tab_id = tab_id;
        }
        self.save_to_disk().await
    }

    /// Session ids currently occupied by armed tasks (replaces the renderer's
    /// `getBackgroundSessions` query with Task semantics).
    pub async fn armed_session_ids(&self) -> Vec<String> {
        let entries = self.entries.read().await;
        let mut out: Vec<String> = Vec::new();
        for e in entries.values().filter(|e| e.armed) {
            out.push(e.session_id.clone());
            if let Some(ref sid) = e.internal_session_id {
                if !out.contains(sid) {
                    out.push(sid.clone());
                }
            }
        }
        out
    }
}

/// Compose a `ScheduledTaskView` from a Task row + its runtime entry.
fn build_view(task: &Task, entry: &TaskRuntimeEntry, currently_executing: bool) -> ScheduledTaskView {
    ScheduledTaskView {
        task_id: task.id.clone(),
        name: task.name.clone(),
        workspace_path: task.workspace_path.clone(),
        session_id: entry
            .internal_session_id
            .clone()
            .unwrap_or_else(|| entry.session_id.clone()),
        status: if entry.armed { "running" } else { "stopped" }.to_string(),
        currently_executing,
        next_execution_at: compute_next_execution(task, entry),
        last_run_ok: entry.last_run_ok,
        last_run_duration_ms: entry.last_run_duration_ms,
        execution_count: entry.execution_count,
        run_mode: resolve_run_mode(task),
    }
}


// ============ Global singleton ============

static TASK_SCHEDULER_MANAGER: std::sync::OnceLock<TaskSchedulerManager> = std::sync::OnceLock::new();

/// Get the global TaskSchedulerManager instance
pub fn get_task_scheduler_manager() -> &'static TaskSchedulerManager {
    TASK_SCHEDULER_MANAGER.get_or_init(TaskSchedulerManager::new)
}

/// Convenience free-function wrappers (call sites in task.rs /
/// management_api.rs shouldn't have to name the manager).
pub async fn arm_task(task: &Task) -> Result<(), String> {
    get_task_scheduler_manager().arm(task).await
}

pub async fn disarm_task(task_id: &str, reason: Option<String>) {
    get_task_scheduler_manager().disarm(task_id, reason).await
}

pub async fn on_task_deleted(task_id: &str) {
    get_task_scheduler_manager().on_task_deleted(task_id).await
}

// ============ Initialization & crash recovery ============

/// Initialize the task scheduler with app handle (called during app setup).
/// Scans the TaskStore for tasks that were running before the restart and
/// re-arms them (方案 A: Rust 统一恢复 — there is no separate cron recovery
/// table anymore).
///
/// Emits "task:task-recovered" for each recovered task,
/// "task:recovery-summary" after all recovery attempts complete, and
/// "task:manager-ready" when initialization is done.
pub async fn initialize_task_scheduler(handle: AppHandle) {
    let manager = get_task_scheduler_manager();
    manager.set_app_handle(handle.clone()).await;
    ulog_info!("[TaskScheduler] Manager initialized with app handle");

    recover_running_tasks(&handle).await;

    let _ = handle.emit("task:manager-ready", serde_json::json!({}));
    ulog_info!("[TaskScheduler] Emitted task:manager-ready event");
}

/// Recover all tasks that were running before app restart:
/// `execution_mode != Once && status == Running` — the TaskStore crash
/// recovery already demoted everything else (Once/Scheduled/Verifying →
/// Blocked), so what's still Running here is meant to keep firing.
async fn recover_running_tasks(handle: &AppHandle) {
    let Some(store) = task::get_task_store() else {
        ulog_warn!("[TaskScheduler] TaskStore not initialized; skipping recovery");
        let _ = handle.emit("task:recovery-summary", TaskRecoverySummaryPayload {
            total_tasks: 0,
            recovered_count: 0,
            failed_count: 0,
            failed_tasks: vec![],
        });
        return;
    };

    let tasks_to_recover: Vec<Task> = store
        .list(task::TaskListFilter {
            // 恢复扫描必须包含系统任务（蒸馏弧——它隐于列表但必须在场）。
            include_system: Some(true),
            ..Default::default()
        })
        .await
        .into_iter()
        .filter(|t| {
            t.status == TaskStatus::Running
                && !matches!(t.execution_mode, TaskExecutionMode::Once)
        })
        .collect();

    if tasks_to_recover.is_empty() {
        ulog_info!("[TaskScheduler] No tasks to recover");
        let _ = handle.emit("task:recovery-summary", TaskRecoverySummaryPayload {
            total_tasks: 0,
            recovered_count: 0,
            failed_count: 0,
            failed_tasks: vec![],
        });
        return;
    }

    // Phrased as "reattaching" rather than "recovering" — every boot
    // reattaches all Running tasks to a fresh Sidecar, which is the normal
    // happy path, not error remediation.
    ulog_info!("[TaskScheduler] Reattaching {} scheduled task(s) (status=Running)...", tasks_to_recover.len());

    let mut recovered_count = 0u32;
    let mut failed_tasks: Vec<TaskRecoveryFailedTask> = vec![];

    for ta in &tasks_to_recover {
        match try_recover_single_task(handle, ta).await {
            Ok((port, session_id)) => {
                recovered_count += 1;
                ulog_info!("[TaskScheduler] Reattached task {} on port {}", ta.id, port);

                let manager = get_task_scheduler_manager();
                let execution_count = manager
                    .get_entry(&ta.id)
                    .await
                    .map(|e| e.execution_count)
                    .unwrap_or(0);
                let interval = schedule_from_task(ta)
                    .map(|s| interval_minutes_for_payload(&s))
                    .unwrap_or(60);

                let _ = handle.emit("task:task-recovered", TaskRecoveredPayload {
                    task_id: ta.id.clone(),
                    session_id,
                    workspace_path: ta.workspace_path.clone(),
                    port,
                    status: "running".to_string(),
                    execution_count,
                    interval_minutes: interval,
                });
            }
            Err(e) => {
                ulog_error!("[TaskScheduler] Failed to reattach task {}: {}", ta.id, e);
                failed_tasks.push(TaskRecoveryFailedTask {
                    task_id: ta.id.clone(),
                    workspace_path: ta.workspace_path.clone(),
                    error: e,
                });
            }
        }
    }

    let total = tasks_to_recover.len() as u32;
    let failed_count = failed_tasks.len() as u32;

    ulog_info!(
        "[TaskScheduler] Reattach complete: {}/{} tasks reattached, {} failed",
        recovered_count, total, failed_count
    );

    let _ = handle.emit("task:recovery-summary", TaskRecoverySummaryPayload {
        total_tasks: total,
        recovered_count,
        failed_count,
        failed_tasks,
    });
}

/// Try to recover a single task: arm (runtime entry + scheduler loop), then
/// re-ensure the session sidecar and activate the session.
/// Returns (sidecar_port, session_id) on success.
async fn try_recover_single_task(handle: &AppHandle, ta: &Task) -> Result<(u16, String), String> {
    ulog_info!(
        "[TaskScheduler] Reattaching task {} for workspace {}",
        ta.id, ta.workspace_path
    );

    let manager = get_task_scheduler_manager();
    // Arm first — creates the runtime entry (preserving any existing session
    // id) and starts the scheduler loop. Idempotent if a loop already runs.
    manager.arm(ta).await?;

    let entry = manager
        .get_entry(&ta.id)
        .await
        .ok_or_else(|| format!("runtime entry missing after arm for {}", ta.id))?;

    // Ensure Session has a Sidecar with the task as owner.
    // IMPORTANT: spawn_blocking because ensure_session_sidecar uses
    // reqwest::blocking::Client (deadlock inside the tokio runtime).
    let sidecar_state = handle.try_state::<ManagedSidecarManager>()
        .ok_or_else(|| "SidecarManager state not available".to_string())?;

    let handle_clone = handle.clone();
    let sidecar_state_clone = sidecar_state.inner().clone();
    let session_id = entry.session_id.clone();
    let workspace_path = ta.workspace_path.clone();
    let task_id = ta.id.clone();
    let owner = SidecarOwner::CronTask(task_id.clone());

    let result = tokio::task::spawn_blocking(move || {
        let workspace = std::path::Path::new(&workspace_path);
        ensure_session_sidecar(&handle_clone, &sidecar_state_clone, &session_id, workspace, owner)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {}", e))??;

    ulog_info!(
        "[TaskScheduler] Session {} Sidecar ensured: port={}, is_new={}",
        entry.session_id, result.port, result.is_new
    );

    // Activate session (for legacy session tracking)
    {
        let mut sidecar_manager = sidecar_state.lock()
            .map_err(|e| format!("Failed to lock SidecarManager: {}", e))?;

        sidecar_manager.activate_session(
            entry.session_id.clone(),
            entry.tab_id.clone(),
            Some(task_id),
            result.port,
            ta.workspace_path.clone(),
            true, // is_cron_task = true (sidecar-registry vocabulary for "owned by the scheduler")
        );
        ulog_info!("[TaskScheduler] Session {} activated for task {}", entry.session_id, ta.id);
    }

    Ok((result.port, entry.session_id.clone()))
}

// ============ Tauri Commands (phase 3b §15 — Task-semantics IPC) ============
//
// Payload shapes consumed by the renderer phase; TS mirrors live in
// `src/shared/types/task.ts`:
//
//   ScheduledTaskView { taskId, name, workspacePath, sessionId,
//     status: 'running'|'stopped', currentlyExecuting,
//     nextExecutionAt: string|null, lastRunOk: boolean|null,
//     lastRunDurationMs: number|null, executionCount,
//     runMode: 'single_session'|'new_session' }
//   TaskRunRecord { ts, ok, durationMs, content: string|null, error: string|null }
//   TriggerNowInfo { taskId, sessionId, dispatchedAt }


// ============ Tests ============

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::{TaskDispatchOrigin, TaskExecutor};

    fn sample_task(id: &str, mode: TaskExecutionMode) -> Task {
        Task {
            id: id.to_string(),
            name: format!("task-{}", id),
            executor: TaskExecutor::Agent,
            description: None,
            workspace_id: "ws".to_string(),
            workspace_path: "C:/ws".to_string(),
            execution_mode: mode,
            cron_task_id: None,
            run_mode: None,
            end_conditions: None,
            interval_minutes: None,
            cron_expression: None,
            cron_timezone: None,
            dispatch_at: None,
            model: None,
            provider_id: None,
            permission_mode: None,
            preselected_session_id: None,
            runtime: None,
            runtime_config: None,
            mcp_enabled_servers: None,
            source_thought_id: None,
            session_ids: vec![],
            status: TaskStatus::Running,
            tags: vec![],
            created_at: Utc::now().timestamp_millis(),
            updated_at: Utc::now().timestamp_millis(),
            last_executed_at: None,
            status_history: vec![],
            notification: None,
            dispatch_origin: TaskDispatchOrigin::Direct,
            deleted: false,
            deleted_at: None,
            dispatch_target: None,
            remote_task_id: None,
            remote_origin_node_id: None,
            remote_executor_node_id: None,
        }
    }

    fn sample_entry(task_id: &str) -> TaskRuntimeEntry {
        TaskRuntimeEntry {
            task_id: task_id.to_string(),
            session_id: "session".to_string(),
            internal_session_id: None,
            tab_id: None,
            execution_count: 0,
            last_executed_at: None,
            last_run_ok: None,
            last_run_duration_ms: None,
            exit_reason: None,
            armed: true,
        }
    }

    // ---- schedule_from_task mapping (Task semantics) ----

    #[test]
    fn schedule_once_is_at_now_plus_2s() {
        let ta = sample_task("t1", TaskExecutionMode::Once);
        let before = Utc::now();
        let s = schedule_from_task(&ta).expect("once resolves");
        let after = Utc::now();
        match s {
            TaskSchedule::At { at } => {
                let parsed = DateTime::parse_from_rfc3339(&at).unwrap().with_timezone(&Utc);
                assert!(parsed >= before + chrono::Duration::seconds(2));
                assert!(parsed <= after + chrono::Duration::seconds(3));
            }
            other => panic!("expected At, got {:?}", other),
        }
    }

    #[test]
    fn schedule_scheduled_uses_dispatch_at() {
        let mut ta = sample_task("t2", TaskExecutionMode::Scheduled);
        let ts = (Utc::now() + chrono::Duration::hours(1)).timestamp_millis();
        ta.dispatch_at = Some(ts);
        match schedule_from_task(&ta).expect("scheduled resolves") {
            TaskSchedule::At { at } => {
                let parsed = DateTime::parse_from_rfc3339(&at).unwrap().with_timezone(&Utc);
                assert_eq!(parsed.timestamp_millis(), ts);
            }
            other => panic!("expected At, got {:?}", other),
        }
    }

    #[test]
    fn schedule_scheduled_without_dispatch_at_is_none() {
        let ta = sample_task("t3", TaskExecutionMode::Scheduled);
        assert!(schedule_from_task(&ta).is_none());
    }

    #[test]
    fn schedule_recurring_cron_wins_over_interval() {
        let mut ta = sample_task("t4", TaskExecutionMode::Recurring);
        ta.cron_expression = Some("0 3 * * *".to_string());
        ta.cron_timezone = Some("Asia/Shanghai".to_string());
        ta.interval_minutes = Some(30);
        match schedule_from_task(&ta).expect("recurring resolves") {
            TaskSchedule::Cron { expr, tz } => {
                assert_eq!(expr, "0 3 * * *");
                assert_eq!(tz.as_deref(), Some("Asia/Shanghai"));
            }
            other => panic!("expected Cron, got {:?}", other),
        }
    }

    #[test]
    fn schedule_recurring_interval_defaults_and_floor() {
        let mut ta = sample_task("t5", TaskExecutionMode::Recurring);
        ta.interval_minutes = Some(2); // below the 5-minute floor
        match schedule_from_task(&ta).expect("recurring resolves") {
            TaskSchedule::Every { minutes, start_at } => {
                assert_eq!(minutes, 5);
                assert!(start_at.is_none());
            }
            other => panic!("expected Every, got {:?}", other),
        }
        // No interval at all → 60-minute default
        let ta2 = sample_task("t6", TaskExecutionMode::Recurring);
        match schedule_from_task(&ta2).expect("recurring resolves") {
            TaskSchedule::Every { minutes, .. } => assert_eq!(minutes, 60),
            other => panic!("expected Every, got {:?}", other),
        }
    }

    #[test]
    fn schedule_loop_is_loop() {
        let ta = sample_task("t7", TaskExecutionMode::Loop);
        assert!(matches!(schedule_from_task(&ta), Some(TaskSchedule::Loop)));
    }

    // ---- run mode resolution ----

    #[test]
    fn run_mode_defaults_by_execution_mode() {
        let loop_task = sample_task("t8", TaskExecutionMode::Loop);
        assert_eq!(resolve_run_mode(&loop_task), RunMode::SingleSession);
        let recurring = sample_task("t9", TaskExecutionMode::Recurring);
        assert_eq!(resolve_run_mode(&recurring), RunMode::NewSession);
        let once = sample_task("t10", TaskExecutionMode::Once);
        assert_eq!(resolve_run_mode(&once), RunMode::NewSession);
    }

    #[test]
    fn run_mode_explicit_overrides_default() {
        let mut ta = sample_task("t11", TaskExecutionMode::Loop);
        ta.run_mode = Some(TaskRunMode::NewSession);
        assert_eq!(resolve_run_mode(&ta), RunMode::NewSession);
    }

    // ---- end conditions ----

    #[test]
    fn absent_end_conditions_mean_ai_cannot_exit() {
        // Parity invariant: Task without endConditions → ai_can_exit = false
        // (the retired engine's EndConditions::default() semantics).
        let ta = sample_task("t12", TaskExecutionMode::Recurring);
        let ec = effective_end_conditions(&ta);
        assert!(!ec.ai_can_exit);
        assert!(ec.deadline.is_none());
        assert!(ec.max_executions.is_none());
    }

    #[test]
    fn end_conditions_deadline_check() {
        let mut ta = sample_task("t13", TaskExecutionMode::Recurring);
        ta.end_conditions = Some(TaskEndConditions {
            deadline: Some(Utc::now().timestamp_millis() - 1000),
            max_executions: None,
            ai_can_exit: true,
        });
        assert!(check_end_conditions(&ta, 0));
        ta.end_conditions = Some(TaskEndConditions {
            deadline: Some(Utc::now().timestamp_millis() + 60_000),
            max_executions: None,
            ai_can_exit: true,
        });
        assert!(!check_end_conditions(&ta, 0));
    }

    #[test]
    fn end_conditions_max_executions_check() {
        let mut ta = sample_task("t14", TaskExecutionMode::Recurring);
        ta.end_conditions = Some(TaskEndConditions {
            deadline: None,
            max_executions: Some(3),
            ai_can_exit: true,
        });
        assert!(!check_end_conditions(&ta, 2));
        assert!(check_end_conditions(&ta, 3));
        assert!(check_end_conditions(&ta, 4));
    }

    // ---- runtime entry serde round-trip ----

    #[test]
    fn runtime_entry_serde_round_trip() {
        let entry = TaskRuntimeEntry {
            task_id: "abc".to_string(),
            session_id: "s-1".to_string(),
            internal_session_id: Some("s-1".to_string()),
            tab_id: Some("tab-9".to_string()),
            execution_count: 7,
            last_executed_at: Some(Utc::now()),
            last_run_ok: Some(true),
            last_run_duration_ms: Some(1234),
            exit_reason: Some("done".to_string()),
            armed: false,
        };
        let store = TaskRuntimeStore { entries: vec![entry] };
        let json = serde_json::to_string(&store).unwrap();
        let back: TaskRuntimeStore = serde_json::from_str(&json).unwrap();
        assert_eq!(back.entries.len(), 1);
        let e = &back.entries[0];
        assert_eq!(e.task_id, "abc");
        assert_eq!(e.execution_count, 7);
        assert_eq!(e.last_run_ok, Some(true));
        assert_eq!(e.last_run_duration_ms, Some(1234));
        assert!(!e.armed);
    }

    #[test]
    fn runtime_store_tolerates_missing_optional_fields() {
        // Minimal JSON — everything except task_id/session_id defaults.
        let json = r#"{"entries":[{"taskId":"x","sessionId":"s"}]}"#;
        let store: TaskRuntimeStore = serde_json::from_str(json).unwrap();
        let e = &store.entries[0];
        assert_eq!(e.execution_count, 0);
        assert!(e.last_executed_at.is_none());
        assert!(!e.armed);
    }

    // ---- next-execution computation ----

    #[test]
    fn next_execution_none_when_disarmed() {
        let ta = sample_task("t15", TaskExecutionMode::Recurring);
        let mut entry = sample_entry("t15");
        entry.armed = false;
        assert!(compute_next_execution(&ta, &entry).is_none());
    }

    #[test]
    fn next_execution_cold_start_fires_in_about_2s() {
        let ta = sample_task("t16", TaskExecutionMode::Recurring);
        let entry = sample_entry("t16");
        let next = compute_next_execution(&ta, &entry).expect("next fire");
        let parsed = DateTime::parse_from_rfc3339(&next).unwrap().with_timezone(&Utc);
        let delta = (parsed - Utc::now()).num_seconds();
        assert!((1..=3).contains(&delta), "delta={} not ~2s", delta);
    }

    #[test]
    fn next_execution_past_due_every_clamps_to_5s() {
        let mut ta = sample_task("t17", TaskExecutionMode::Recurring);
        ta.interval_minutes = Some(5);
        let mut entry = sample_entry("t17");
        entry.execution_count = 4;
        // Last executed an hour ago with a 5-minute interval → past due.
        entry.last_executed_at = Some(Utc::now() - chrono::Duration::hours(1));
        let next = compute_next_execution(&ta, &entry).expect("next fire");
        let parsed = DateTime::parse_from_rfc3339(&next).unwrap().with_timezone(&Utc);
        let delta = (parsed - Utc::now()).num_seconds();
        assert!((4..=6).contains(&delta), "delta={} not ~5s", delta);
    }

    #[test]
    fn next_execution_loop_is_none() {
        let ta = sample_task("t18", TaskExecutionMode::Loop);
        let entry = sample_entry("t18");
        assert!(compute_next_execution(&ta, &entry).is_none());
    }


    // ---- cron dialect fingerprints (carried over from cron_task.rs) ----

    /// Fingerprint cases for `translate_unix_dow_to_crate_dow` — encodes the
    /// Unix→crate mapping that the rest of the app relies on.
    #[test]
    fn translate_dow_handles_singletons_ranges_lists_steps_names() {
        // Singletons
        assert_eq!(translate_unix_dow_to_crate_dow("0"), "1");   // Sunday
        assert_eq!(translate_unix_dow_to_crate_dow("7"), "1");   // Sunday alias
        assert_eq!(translate_unix_dow_to_crate_dow("1"), "2");   // Monday
        assert_eq!(translate_unix_dow_to_crate_dow("6"), "7");   // Saturday
        // Wildcards
        assert_eq!(translate_unix_dow_to_crate_dow("*"), "*");
        assert_eq!(translate_unix_dow_to_crate_dow("?"), "?");   // Quartz wildcard, pass through
        // Forward ranges (no Sunday-alias wrap)
        assert_eq!(translate_unix_dow_to_crate_dow("1-5"), "2-6");   // Mon-Fri
        assert_eq!(translate_unix_dow_to_crate_dow("0-6"), "*");     // all days, Unix Sun=0 form
        assert_eq!(translate_unix_dow_to_crate_dow("0-7"), "*");     // wraps → all days
        assert_eq!(translate_unix_dow_to_crate_dow("1-7"), "*");     // wraps → all days
        // Wrap-around ranges that hit Sunday-alias 7 — must enumerate, not
        // produce invalid descending crate ranges like "6-1"
        assert_eq!(translate_unix_dow_to_crate_dow("5-7"), "1,6,7"); // Fri-Sun
        assert_eq!(translate_unix_dow_to_crate_dow("2-7"), "1,3-7"); // Tue-Sun
        // Lists
        assert_eq!(translate_unix_dow_to_crate_dow("0,3,5"), "1,4,6");
        assert_eq!(translate_unix_dow_to_crate_dow("1,3,5"), "2,4,6");
        // Step values — must produce same days as the Unix expression
        // `*/2` Unix (0,2,4,6 = Sun/Tue/Thu/Sat) → crate (1,3,5,7 = same days)
        assert_eq!(translate_unix_dow_to_crate_dow("*/2"), "1,3,5,7");
        assert_eq!(translate_unix_dow_to_crate_dow("0/2"), "1,3,5,7");
        assert_eq!(translate_unix_dow_to_crate_dow("1-5/2"), "2,4,6"); // Mon,Wed,Fri
        // 1-7/2 Unix = Mon,Wed,Fri,Sun (NOT */2 phase). Must preserve phase.
        assert_eq!(translate_unix_dow_to_crate_dow("1-7/2"), "1,2,4,6");
        // Named days pass through unchanged (cron crate already accepts them)
        assert_eq!(translate_unix_dow_to_crate_dow("SUN"), "SUN");
        assert_eq!(translate_unix_dow_to_crate_dow("MON-FRI"), "MON-FRI");
    }

    /// Issue #166 regression — `0 21 * * 0` (every Sunday 21:00) must parse,
    /// and the next fire time must land on a Sunday at 21:00.
    #[test]
    fn issue_166_unix_sunday_cron_parses_and_fires_on_sunday() {
        assert!(validate_cron_expression("0 21 * * 0", Some("UTC")).is_ok());
        assert!(validate_cron_expression("0 21 * * 7", Some("UTC")).is_ok());

        let next = next_cron_fire_time("0 21 * * 0", Some("UTC")).unwrap();
        assert_eq!(next.format("%A").to_string(), "Sunday");
        assert_eq!(next.format("%H:%M").to_string(), "21:00");
    }

    /// Issue #166 broader pattern — `1-5` (frontend "weekdays") must mean
    /// Mon-Fri, not Sun-Thu. Regression for the silent-mis-fire bug.
    #[test]
    fn weekdays_range_means_monday_through_friday() {
        let next = next_cron_fire_time("0 8 * * 1-5", Some("UTC")).unwrap();
        let weekday = next.format("%A").to_string();
        assert!(
            matches!(weekday.as_str(), "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday"),
            "weekday cron should fire Mon-Fri, got {}",
            weekday
        );
    }

    /// 6-field input is treated as the cron crate's native sec-min-hour-dom-month-dow
    /// (no year). Previously the year wildcard was missing and the format!
    /// prepended `0` instead, producing 7 fields with everything off by one.
    #[test]
    fn six_field_cron_appends_year_wildcard() {
        // 6-field: sec=0, min=0, hour=21, dom=*, month=*, dow=1 (Sun in crate semantics)
        assert!(validate_cron_expression("0 0 21 * * 1", Some("UTC")).is_ok());
    }
}
