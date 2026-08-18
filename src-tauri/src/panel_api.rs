// AI Panel Control API — lets external CLI tools drive the embedded terminal
// panel over HTTP (loopback only).
//
// Started from lib.rs setup with the shared Arc<TerminalManager>.
// Binds 127.0.0.1 on a random port and publishes it to
// ~/.zhishi/panel-api.port (tmp+rename, same discovery pattern as
// sidecar.port) so CLI processes can find it.
//
// All routes are POST + JSON. (The embedded-browser routes were removed in
// the W6 subtraction: the windowless host has no parent window for child
// webviews, so browser.rs could only fail at runtime.)

use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;

use crate::terminal::{OutputBuffer, TerminalManager};
use crate::{ulog_error, ulog_info, ulog_warn};

/// Port file for CLI discovery — written when the Panel API starts.
const PORT_FILE_NAME: &str = "panel-api.port";

/// Shared state for all handlers.
struct PanelApiState {
    app: AppHandle,
    terminals: Arc<TerminalManager>,
    /// AI terminal output buffers, kept independent of TerminalManager so
    /// `/term/read` still works (with `closed: true`) after the shell exits
    /// and the session self-cleans from the manager. Entries are added by
    /// `/term/open` and removed by `/term/close`.
    ai_outputs: tokio::sync::Mutex<HashMap<String, Arc<std::sync::Mutex<OutputBuffer>>>>,
}

/// Start the Panel API server on 127.0.0.1 with a random port.
/// Returns the bound port; on bind/serve failure logs and returns Err
/// (never panics — the app must keep running without this API).
pub async fn start_panel_api(
    app: AppHandle,
    terminals: Arc<TerminalManager>,
) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind panel API: {}", e))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get panel API address: {}", e))?
        .port();

    let state = Arc::new(PanelApiState {
        app,
        terminals,
        ai_outputs: tokio::sync::Mutex::new(HashMap::new()),
    });

    let router = Router::new()
        .route("/term/open", post(term_open_handler))
        .route("/term/list", post(term_list_handler))
        .route("/term/write", post(term_write_handler))
        .route("/term/read", post(term_read_handler))
        .route("/term/close", post(term_close_handler))
        .with_state(state);

    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            ulog_error!("[panel-api] Server error: {}", e);
        }
    });

    write_port_file(port);
    ulog_info!("[panel-api] Started on http://127.0.0.1:{}", port);
    Ok(port)
}

/// Publish the port to ~/.zhishi/panel-api.port via tmp+rename (atomic
/// replace, so a CLI reading mid-write never sees a partial file).
fn write_port_file(port: u16) {
    let Some(dir) = crate::app_dirs::zhishi_data_dir() else {
        ulog_warn!("[panel-api] No data dir; port file not written");
        return;
    };
    let tmp = dir.join(format!("{}.tmp", PORT_FILE_NAME));
    let dst = dir.join(PORT_FILE_NAME);
    if let Err(e) = std::fs::write(&tmp, port.to_string()) {
        ulog_warn!("[panel-api] Failed to write port file {:?}: {}", tmp, e);
        return;
    }
    if let Err(e) = std::fs::rename(&tmp, &dst) {
        ulog_warn!("[panel-api] Failed to rename port file to {:?}: {}", dst, e);
    }
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

fn err(status: StatusCode, message: String) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": message })))
}

// ──────────────────────────────────────────────────────────
// Terminal routes
// ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TermOpenRequest {
    workspace_path: String,
    rows: Option<u16>,
    cols: Option<u16>,
    /// Optional command line to run instead of the default shell
    /// (e.g. `ssh user@target`, `docker exec -it <c> bash`). Passed through
    /// verbatim to TerminalManager — this API is loopback-only.
    cmd: Option<String>,
    /// D14 boundary tag (安全研究员版 P1 E6): `docker:<c>` / `vm:<name>` /
    /// `range:<host>`; absent = host. Stored on the session, surfaced by
    /// `/term/list` and the open response; consumed by the sidecar's
    /// boundary gate (env≠host ⇒ in-env).
    env: Option<String>,
}

async fn term_open_handler(
    State(state): State<Arc<PanelApiState>>,
    Json(req): Json<TermOpenRequest>,
) -> (StatusCode, Json<Value>) {
    // Validate the workspace path with the same system-dir blacklist used by
    // the workspace file commands — the API is loopback-only but must still
    // not become an arbitrary-directory probe.
    let validated = match crate::workspace_files::path_safety::validate_external_read_path(
        &req.workspace_path,
    ) {
        Ok(p) => p,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    if !validated.is_dir() {
        return err(
            StatusCode::BAD_REQUEST,
            format!("workspacePath is not a directory: {}", req.workspace_path),
        );
    }

    let terminal_id = format!("ai-{}", uuid::Uuid::new_v4());
    let rows = req.rows.unwrap_or(24);
    let cols = req.cols.unwrap_or(80);
    let env_tag = req.env.filter(|t| !t.trim().is_empty());

    if let Err(e) = state
        .terminals
        .create(
            &state.app,
            validated.to_string_lossy().into_owned(),
            rows,
            cols,
            None,
            Some(terminal_id.clone()),
            req.cmd,
            env_tag.clone(),
        )
        .await
    {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e);
    }

    if let Some(buf) = state.terminals.output_buffer(&terminal_id).await {
        state
            .ai_outputs
            .lock()
            .await
            .insert(terminal_id.clone(), buf);
    }

    let _ = state.app.emit_to(
        "main",
        "panel:ai-terminal-opened",
        json!({ "terminalId": terminal_id, "envTag": env_tag }),
    );

    (
        StatusCode::OK,
        Json(json!({ "terminalId": terminal_id, "envTag": env_tag })),
    )
}

/// List live terminals with their D14 boundary tags (env≠host ⇒ in-env for
/// the sidecar's boundary gate).
async fn term_list_handler(
    State(state): State<Arc<PanelApiState>>,
) -> (StatusCode, Json<Value>) {
    let terminals = state.terminals.list().await;
    (StatusCode::OK, Json(json!({ "terminals": terminals })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TermWriteRequest {
    terminal_id: String,
    data: String,
}

async fn term_write_handler(
    State(state): State<Arc<PanelApiState>>,
    Json(req): Json<TermWriteRequest>,
) -> (StatusCode, Json<Value>) {
    // Data is written as-is — the caller supplies any trailing newline.
    match state
        .terminals
        .write(&req.terminal_id, req.data.as_bytes())
        .await
    {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => err(StatusCode::NOT_FOUND, e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TermReadRequest {
    terminal_id: String,
    cursor: Option<u64>,
}

async fn term_read_handler(
    State(state): State<Arc<PanelApiState>>,
    Json(req): Json<TermReadRequest>,
) -> (StatusCode, Json<Value>) {
    let cursor = req.cursor.unwrap_or(0);
    let buf = {
        let map = state.ai_outputs.lock().await;
        map.get(&req.terminal_id).cloned()
    };
    let Some(buf) = buf else {
        return err(
            StatusCode::NOT_FOUND,
            format!("Terminal {} not found", req.terminal_id),
        );
    };
    let Ok(output) = buf.lock() else {
        return err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to lock output buffer".to_string(),
        );
    };
    let (end_cursor, bytes, closed) = output.read_since(cursor);
    (
        StatusCode::OK,
        Json(json!({
            "cursor": end_cursor,
            // Lossy decode keeps the byte-cursor contract valid even when a
            // slice boundary splits a multi-byte UTF-8 sequence.
            "text": String::from_utf8_lossy(bytes),
            "closed": closed,
        })),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TermCloseRequest {
    terminal_id: String,
}

async fn term_close_handler(
    State(state): State<Arc<PanelApiState>>,
    Json(req): Json<TermCloseRequest>,
) -> (StatusCode, Json<Value>) {
    state.terminals.close(&req.terminal_id).await;
    state.ai_outputs.lock().await.remove(&req.terminal_id);
    (StatusCode::OK, Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::TermOpenRequest;

    #[test]
    fn term_open_request_without_cmd_defaults_to_none() {
        // Characterization: pre-E2 request shape must keep deserializing
        // unchanged — cmd is optional and absent means default shell.
        let req: TermOpenRequest =
            serde_json::from_str(r#"{"workspacePath":"/tmp/proj"}"#).unwrap();
        assert_eq!(req.workspace_path, "/tmp/proj");
        assert!(req.rows.is_none());
        assert!(req.cols.is_none());
        assert!(req.cmd.is_none());
    }

    #[test]
    fn term_open_request_passes_cmd_through_verbatim() {
        let req: TermOpenRequest = serde_json::from_str(
            r#"{"workspacePath":"/tmp/proj","rows":40,"cols":120,"cmd":"docker exec -it c1 bash"}"#,
        )
        .unwrap();
        assert_eq!(req.rows, Some(40));
        assert_eq!(req.cols, Some(120));
        assert_eq!(req.cmd.as_deref(), Some("docker exec -it c1 bash"));
    }

    #[test]
    fn term_open_request_without_env_defaults_to_none() {
        // E6 characterization: pre-E6 request shape keeps deserializing —
        // env is optional; absent means an untagged (host) session.
        let req: TermOpenRequest =
            serde_json::from_str(r#"{"workspacePath":"/tmp/proj"}"#).unwrap();
        assert!(req.env.is_none());
    }

    #[test]
    fn term_open_request_passes_env_tag_through() {
        let req: TermOpenRequest = serde_json::from_str(
            r#"{"workspacePath":"/tmp/proj","cmd":"docker exec -it c1 bash","env":"docker:c1"}"#,
        )
        .unwrap();
        assert_eq!(req.env.as_deref(), Some("docker:c1"));
    }
}
