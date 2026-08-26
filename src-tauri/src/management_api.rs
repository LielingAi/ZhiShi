// Internal Management API for Node Sidecar → Rust IPC
// Provides HTTP endpoints on localhost for task scheduling
// Only accessible from 127.0.0.1 (Node Sidecar processes)

use axum::{
    extract::{DefaultBodyLimit, Query},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use std::sync::OnceLock;
use tokio::net::TcpListener;

use crate::{ulog_info, ulog_error};
use crate::task_scheduler;
use crate::task;

/// Global management API port (set once at startup)
static MANAGEMENT_PORT: OnceLock<u16> = OnceLock::new();

/// Get the management API port (returns 0 if not started)
pub fn get_management_port() -> u16 {
    MANAGEMENT_PORT.get().copied().unwrap_or(0)
}

/// Global Sidecar manager state (set once at startup)
static SIDECAR_STATE: OnceLock<crate::sidecar::ManagedSidecarManager> = OnceLock::new();

/// Set the SidecarManager state for the management API (called once at startup)
pub fn set_sidecar_state(state: crate::sidecar::ManagedSidecarManager) {
    let _ = SIDECAR_STATE.set(state);
}

#[allow(dead_code)]
fn get_sidecar_state() -> Option<&'static crate::sidecar::ManagedSidecarManager> {
    SIDECAR_STATE.get()
}

/// Start the internal management API server on a random port
/// Returns the port number for injection into Sidecar env vars
pub async fn start_management_api() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind management API: {}", e))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get management API address: {}", e))?
        .port();

    MANAGEMENT_PORT
        .set(port)
        .map_err(|_| "Management API already started".to_string())?;

    let app = Router::new()
        // Task Center (v0.1.69) — HTTP surface for the `zhishi task` CLI.
        .route("/api/task/list", get(task_list_handler))
        .route("/api/task/get", get(task_get_handler))
        .route("/api/task/create-direct", post(task_create_direct_handler))
        .route(
            "/api/task/create-from-alignment",
            post(task_create_from_alignment_handler),
        )
        .route("/api/task/update", post(task_update_handler))
        .route("/api/task/update-status", post(task_update_status_handler))
        .route("/api/task/append-session", post(task_append_session_handler))
        .route("/api/task/archive", post(task_archive_handler))
        .route("/api/task/delete", post(task_delete_handler))
        .route("/api/task/run", post(task_run_handler))
        .route("/api/task/rerun", post(task_rerun_handler))
        .route("/api/task/read-doc", get(task_read_doc_handler))
        .route("/api/task/write-doc", post(task_write_doc_handler))
        // Task docs can be sizable markdown; default axum 2MB limit is too
        // small — raise to 50MB for this API.
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024));

    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            ulog_error!("[management-api] Server error: {}", e);
        }
    });

    ulog_info!(
        "[management-api] Started on http://127.0.0.1:{}",
        port
    );
    Ok(port)
}

// ========================================================================
// Task Center handlers (v0.1.69)
// ========================================================================
//
// These endpoints are called by the Node Admin API (admin-api.ts), which in
// turn is called by the `zhishi task` CLI. The CLI is the **entry point of
// trust inference** for `actor` / `source` (PRD §10.2.1 caller-inference table):
//
// - `ZHISHI_PORT` env var set → AI sub-process → `actor=agent, source=cli`
// - Otherwise (user terminal reading `~/.zhishi/sidecar.port`) →
//   `actor=user, source=cli`
//
// That inference happens in the CLI script itself (knows its own env) and is
// forwarded to the Node Admin API, which forwards here. We take the caller's
// word for actor/source: the CLI process running inside an SDK subprocess is
// inside a trust boundary already (the whole host is the user's machine).
// For UI transitions the Tauri command layer stamps `user/ui` authoritatively
// without ever reaching this path.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskListQuery {
    workspace_id: Option<String>,
    status: Option<String>,
    tag: Option<String>,
    include_deleted: Option<bool>,
    include_system: Option<bool>,
}

async fn task_list_handler(
    Query(q): Query<TaskListQuery>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    let filter = task::TaskListFilter {
        workspace_id: q.workspace_id,
        status: q.status.and_then(|s| parse_status_filter(&s)),
        tag: q.tag,
        include_deleted: q.include_deleted,
        include_system: q.include_system,
    };
    let tasks = store.list(filter).await;
    Json(serde_json::json!({ "ok": true, "tasks": tasks }))
}

fn parse_status_filter(raw: &str) -> Option<task::StatusFilter> {
    if raw.contains(',') {
        let list: Vec<task::TaskStatus> = raw
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .filter_map(|s| serde_json::from_str(&format!("\"{}\"", s)).ok())
            .collect();
        if list.is_empty() {
            None
        } else {
            Some(task::StatusFilter::Many(list))
        }
    } else {
        serde_json::from_str::<task::TaskStatus>(&format!("\"{}\"", raw.trim()))
            .ok()
            .map(task::StatusFilter::One)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskGetQuery {
    id: String,
}

async fn task_get_handler(
    Query(q): Query<TaskGetQuery>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    match store.get(&q.id).await {
        Some(t) => {
            // Attach task.docs (four absolute paths) so the AI / CLI
            // reading this response knows where task.md / verify.md /
            // progress.md / alignment.md live without having to
            // re-derive the layout from convention. See
            // `task::build_task_docs` for semantics of the optional
            // fields (only existing files are surfaced).
            let docs = match task::build_task_docs(&t.id) {
                Ok(d) => d,
                Err(e) => {
                    return Json(serde_json::json!({
                        "ok": false,
                        "error": format!("failed to build docs paths: {}", e)
                    }));
                }
            };
            Json(serde_json::json!({ "ok": true, "task": task::TaskWithDocs { task: t, docs } }))
        }
        None => Json(serde_json::json!({
            "ok": false,
            "error": "not_found"
        })),
    }
}

async fn task_create_direct_handler(
    Json(input): Json<task::TaskCreateDirectInput>,
) -> Json<serde_json::Value> {
    let Some(task_store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    match task_store.create_direct(input).await {
        Ok(t) => Json(serde_json::json!({ "ok": true, "task": t })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

async fn task_update_handler(
    Json(input): Json<task::TaskUpdateInput>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    // Reuses `TaskStore::update`, which:
    //   * rejects updates on Running/Verifying tasks (state-machine guard),
    //   * applies mode-transition hygiene (clearing recurring fields when
    //     `executionMode` flips to Once etc.),
    //   * bounces the scheduler (disarm + re-arm) when schedule-shape fields
    //     changed, so a CLI patch like `--intervalMinutes 180` actually
    //     re-arms the scheduler with the new cadence.
    match store.update(input).await {
        Ok(task) => {
            let docs = match task::build_task_docs(&task.id) {
                Ok(d) => d,
                // Doc dir absence is non-fatal — surface the task without
                // docs paths so the caller still sees the update result.
                Err(_) => task::TaskDocs {
                    dir: String::new(),
                    task_md: String::new(),
                    verify_md: None,
                    progress_md: None,
                    alignment_md: None,
                },
            };
            Json(serde_json::json!({
                "ok": true,
                "task": task::TaskWithDocs { task, docs },
            }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskUpdateStatusApiRequest {
    id: String,
    status: task::TaskStatus,
    #[serde(default)]
    message: Option<String>,
    /// Caller-declared actor. CLI from AI subprocess → "agent"; user terminal → "user".
    actor: task::TransitionActor,
    /// Caller-declared source. Usually "cli" from this endpoint; scheduler /
    /// watchdog / crash paths don't use HTTP.
    #[serde(default)]
    source: Option<task::TransitionSource>,
}

async fn task_update_status_handler(
    Json(req): Json<TaskUpdateStatusApiRequest>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    match store
        .update_status(task::TaskUpdateStatusInput {
            id: req.id,
            status: req.status,
            message: req.message,
            actor: req.actor,
            source: req.source.or(Some(task::TransitionSource::Cli)),
        })
        .await
    {
        Ok((task, transition)) => Json(serde_json::json!({
            "ok": true,
            "task": task,
            "transition": transition
        })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskAppendSessionApiRequest {
    id: String,
    session_id: String,
}

async fn task_append_session_handler(
    Json(req): Json<TaskAppendSessionApiRequest>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    match store.append_session(&req.id, &req.session_id).await {
        Ok(t) => Json(serde_json::json!({ "ok": true, "task": t })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskArchiveApiRequest {
    id: String,
    #[serde(default)]
    message: Option<String>,
}

async fn task_archive_handler(
    Json(req): Json<TaskArchiveApiRequest>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    match store.archive(&req.id, req.message).await {
        Ok(t) => Json(serde_json::json!({ "ok": true, "task": t })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskDeleteApiRequest {
    id: String,
}

async fn task_delete_handler(
    Json(req): Json<TaskDeleteApiRequest>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    match store.delete(&req.id).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

// ========================================================================
// Task Center execution handlers (v0.1.69)
// ========================================================================

async fn task_create_from_alignment_handler(
    Json(input): Json<task::TaskCreateFromAlignmentInput>,
) -> Json<serde_json::Value> {
    let Some(task_store) = task::get_task_store() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "task store not initialized"
        }));
    };
    match task_store.create_from_alignment(input).await {
        Ok(t) => Json(serde_json::json!({ "ok": true, "task": t })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

/// PRD §10.2.2 `POST /api/task/run` — trigger execution of an existing Task.
///
/// Behavior (phase 3b — Task is the scheduler's primary key):
/// - Arms the task scheduler (`task_scheduler::arm`): upserts the runtime
///   entry and (idempotently) starts the scheduler loop. The loop's first
///   tick builds the first-message prompt dynamically from `dispatchOrigin`
///   + `~/.zhishi/tasks/<id>/task.md` (PRD §9.3.1).
/// - On successful dispatch transitions `todo → running` via TaskStore.
/// - For `executionMode = 'once'` the computed schedule is `At { at: now+2s }`
///   so it fires once and completes (Task → done).
/// - For scheduled/recurring/loop the schedule is computed from the Task's
///   own fields on every tick (`schedule_from_task`).
async fn task_run_handler(
    Json(req): Json<TaskIdApiRequest>,
) -> Json<serde_json::Value> {
    let Some(task_store) = task::get_task_store() else {
        return Json(serde_json::json!({ "ok": false, "error": "task store not initialized" }));
    };
    let Some(ta) = task_store.get(&req.id).await else {
        return Json(serde_json::json!({ "ok": false, "error": "task not found" }));
    };

    // Legal-transition guard: `run` is only meaningful from `todo`. Other
    // states require the user to hit `rerun` (which resets first).
    if ta.status != task::TaskStatus::Todo {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!("task is in state '{}'; use 'zhishi task rerun {}' to re-dispatch it", ta.status.as_str(), ta.id)
        }));
    }

    match task_scheduler::arm_task(&ta).await {
        Ok(()) => {
            // Mark Task as running. `system / ui` — the invocation came from
            // UI button or CLI `task run`, the actor-inference table treats
            // both as system in this row.
            match task_store
                .update_status(task::TaskUpdateStatusInput {
                    id: ta.id.clone(),
                    status: task::TaskStatus::Running,
                    message: Some("dispatched".to_string()),
                    actor: task::TransitionActor::System,
                    source: Some(task::TransitionSource::Scheduler),
                })
                .await
            {
                Ok((t, _)) => Json(serde_json::json!({
                    "ok": true,
                    "task": t,
                })),
                Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
            }
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

/// PRD §10.2.2 `POST /api/task/rerun` — reset the status back to `todo` (via
/// a proper audited transition) then invoke the `run` flow. Used when a task
/// is stuck in `blocked` / `stopped` / `done` / `archived` and the user wants
/// to try again from scratch.
async fn task_rerun_handler(
    Json(req): Json<TaskIdApiRequest>,
) -> Json<serde_json::Value> {
    let Some(task_store) = task::get_task_store() else {
        return Json(serde_json::json!({ "ok": false, "error": "task store not initialized" }));
    };
    let Some(ta) = task_store.get(&req.id).await else {
        return Json(serde_json::json!({ "ok": false, "error": "task not found" }));
    };

    if !matches!(
        ta.status,
        task::TaskStatus::Blocked
            | task::TaskStatus::Stopped
            | task::TaskStatus::Done
            | task::TaskStatus::Archived
    ) {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!("rerun only valid from blocked/stopped/done/archived; current = '{}'", ta.status.as_str())
        }));
    }

    // Step 1: reset → todo with source=rerun (PRD §10.2.1 caller-inference
    // table row "rerun").
    if let Err(e) = task_store
        .update_status(task::TaskUpdateStatusInput {
            id: ta.id.clone(),
            status: task::TaskStatus::Todo,
            message: Some("rerun requested".to_string()),
            actor: task::TransitionActor::System,
            source: Some(task::TransitionSource::Rerun),
        })
        .await
    {
        return Json(serde_json::json!({ "ok": false, "error": format!("reset failed: {}", e) }));
    }

    // Disarm any live scheduler loop and reset execution counters so the
    // re-run starts from a clean slate (mirrors the pre-3b behavior where
    // rerun deleted the linked CronTask and minted a fresh one — important
    // when the task had exhausted its endConditions).
    task_scheduler::disarm_task(&ta.id, Some("rerun".to_string())).await;
    task_scheduler::get_task_scheduler_manager()
        .reset_for_rerun(&ta)
        .await;

    // Step 2: defer to the same path as `task/run`. Re-fetch to pick up the
    // fresh `todo` status.
    let req_next = TaskIdApiRequest { id: ta.id.clone() };
    task_run_handler(Json(req_next)).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskReadDocQuery {
    id: String,
    /// `task` | `verify` | `progress` — the md filename stem.
    doc: String,
}

/// `GET /api/task/read-doc?id=&doc=` — used by the `zhishi task show-doc`
/// CLI so Agents running in a workspace can read a Task's markdown without
/// hardcoding the filesystem path (task docs live in the user profile dir
/// after v0.1.69, not in the workspace).
async fn task_read_doc_handler(
    axum::extract::Query(q): axum::extract::Query<TaskReadDocQuery>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({ "ok": false, "error": "task store not initialized" }));
    };
    let Some(ta) = store.get(&q.id).await else {
        return Json(serde_json::json!({ "ok": false, "error": "task not found" }));
    };
    // Delegate to `task::task_doc_filename` so the Management API, Tauri
    // IPC, and any future doc-reading surface all share one whitelist —
    // preventing the v0.1.69 drift where Management accepted `alignment`
    // but Tauri IPC rejected it.
    let filename = match task::task_doc_filename(&q.doc) {
        Ok(f) => f,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
    };
    let dir = match task::task_docs_dir(&ta.id) {
        Ok(p) => p,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
    };
    let path = dir.join(filename);
    match std::fs::read_to_string(&path) {
        Ok(content) => Json(serde_json::json!({ "ok": true, "content": content })),
        // Missing file is not an error for the CLI — it means "no doc yet".
        // We still 200 and return empty content so scripting is idempotent.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Json(serde_json::json!({ "ok": true, "content": "" }))
        }
        Err(e) => Json(serde_json::json!({
            "ok": false,
            "error": format!("read {}: {}", filename, e),
        })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskWriteDocRequest {
    id: String,
    /// `task` | `verify` — `progress` is agent-only and rejected here.
    doc: String,
    content: String,
}

/// `POST /api/task/write-doc` — write `task.md` or `verify.md` for a Task.
/// Delegates to `TaskStore::write_doc`, which enforces the running/verifying
/// lock atomically with the file write (PRD §9.4). `progress.md` is
/// explicitly rejected here — only the runtime agent appends to it.
async fn task_write_doc_handler(
    Json(req): Json<TaskWriteDocRequest>,
) -> Json<serde_json::Value> {
    let Some(store) = task::get_task_store() else {
        return Json(serde_json::json!({ "ok": false, "error": "task store not initialized" }));
    };
    // Central whitelist via `task::task_doc_filename` — same contract as
    // read-doc. Then refuse writing progress.md / alignment.md (the Tauri
    // `cmd_task_write_doc` enforces the same rule, keeping both entry
    // points aligned).
    let filename = match task::task_doc_filename(&req.doc) {
        Ok(f) => f,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
    };
    if filename == "progress.md" || filename == "alignment.md" {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!(
                "{} is not writable via this API (progress=agent-appended, alignment=skill-written)",
                filename
            ),
        }));
    }
    match store.write_doc(&req.id, filename, &req.content).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskIdApiRequest {
    id: String,
}
