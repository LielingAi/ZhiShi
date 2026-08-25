// Sidecar process management module
// Handles spawning, monitoring, and shutting down multiple Bun backend server instances
// Supports per-Tab isolation with independent Sidecar processes

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(unix)]
use std::sync::Once;
use std::thread;
use std::time::Duration;

use crate::{ulog_info, ulog_warn, ulog_error, ulog_debug};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::perf_trace::{elapsed_ms, emit_perf_trace, trace_start, PerfTrace, PerfTraceName};
use crate::proxy_config;

// Ensure file descriptor limit is increased only once (unix only)
#[cfg(unix)]
static RLIMIT_INIT: Once = Once::new();

/// Increase file descriptor limit to prevent "low max file descriptors" error from Bun
/// This is especially important on macOS where the default soft limit is often 2560
#[cfg(unix)]
fn ensure_high_file_descriptor_limit() {
    RLIMIT_INIT.call_once(|| {
        use libc::{getrlimit, setrlimit, rlimit, RLIMIT_NOFILE};

        unsafe {
            let mut rlim = rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };

            // Get current limits
            if getrlimit(RLIMIT_NOFILE, &mut rlim) == 0 {
                let old_soft = rlim.rlim_cur;
                let hard_limit = rlim.rlim_max;

                // Only increase if current soft limit is below a reasonable threshold
                // Target: at least 65536, or hard limit if lower
                let target = std::cmp::min(65536, hard_limit);

                if old_soft < target {
                    rlim.rlim_cur = target;

                    if setrlimit(RLIMIT_NOFILE, &rlim) == 0 {
                        ulog_info!(
                            "[sidecar] Increased file descriptor limit: {} -> {} (hard limit: {})",
                            old_soft, target, hard_limit
                        );
                    } else {
                        ulog_warn!(
                            "[sidecar] Failed to increase file descriptor limit (current: {}, target: {})",
                            old_soft, target
                        );
                    }
                } else {
                    ulog_info!(
                        "[sidecar] File descriptor limit already sufficient: {} (hard: {})",
                        old_soft, hard_limit
                    );
                }
            } else {
                ulog_warn!("[sidecar] Failed to get current file descriptor limit");
            }
        }
    });
}

#[cfg(not(unix))]
fn ensure_high_file_descriptor_limit() {
    // No-op on non-Unix systems
}

// Configuration constants
const BASE_PORT: u16 = 31415;
// Health check: exponential backoff 50ms → 500ms, capped. Wall-clock ceiling ≈ 5 min.
// Node cold start is ~2s (tsx boot + module load), so the first 5 attempts at
// 50/100/200/400/500ms (cumulative 1.25s) usually arrive before listen — cheap,
// no-ops. Attempts 6+ poll at 500ms to accommodate Windows Defender first-run
// scanning (20-30s hold) without burning CPU.
const HEALTH_CHECK_MAX_ATTEMPTS: u32 = 600;
const HEALTH_CHECK_DELAY_CAP_MS: u64 = 500;
const HEALTH_CHECK_DELAY_START_MS: u64 = 50;
const HEALTH_CHECK_TIMEOUT_MS: u64 = 100;
// HTTP health check for existing sidecar.
// 2000ms accommodates Windows systems under startup load (Defender, proxy, Plugin Bridge init).
// Previously 500ms which caused false "unhealthy" during busy startup windows.
const HTTP_HEALTH_CHECK_TIMEOUT_MS: u64 = 2000;
// Grace period after sidecar creation during which the health monitor skips checks.
// Prevents the monitor from killing a sidecar that's still completing its initial startup
// (TCP health check, Bun init, Plugin Bridge, etc.), especially on Windows with Defender.
const STARTUP_GRACE_SECS: u64 = 45;
#[cfg(unix)]
const GRACEFUL_SHUTDOWN_TIMEOUT_SECS: u64 = 5;
// Port range: 500 ports (31415-31914)
const PORT_RANGE: u16 = 500;
// Special identifier for global sidecar (used by Settings page)
pub const GLOBAL_SIDECAR_ID: &str = "__global__";
// Process identification marker (used to identify our sidecar processes)
// This marker is added to all sidecar commands for reliable process identification
const SIDECAR_MARKER: &str = "--zhishi-sidecar";

// Port file for CLI discovery — written when Global Sidecar starts,
// read by `cli.rs` to know which port to connect to.
pub const PORT_FILE_NAME: &str = "sidecar.port";

// ===== Crashed Node Tracking =====
// When a bundled Node.js crashes with STATUS_ACCESS_VIOLATION (0xC0000005) on Windows —
// usually a missing VC++ runtime DLL or some AV-injection incompatibility — mark it as
// crashed so subsequent spawn attempts fall through to system Node.
// v0.1.x tracked Bun crashes here (AVX2 baseline issue); Node has its own failure modes.
static CRASHED_NODE_PATHS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

#[allow(dead_code)] // Only called from #[cfg(windows)] blocks; harmless on other platforms
fn mark_node_as_crashed(path: &std::path::Path) {
    let normalized = normalize_external_path(path.to_path_buf());
    // unwrap_or_else recovers from Mutex poisoning — the body is trivial (Vec::push),
    // so the data is still consistent even if a previous holder panicked.
    let mut paths = CRASHED_NODE_PATHS.lock().unwrap_or_else(|e| e.into_inner());
    if !paths.iter().any(|p| p == &normalized) {
        paths.push(normalized.clone());
        ulog_warn!(
            "[sidecar] Marked node as crashed (will try system fallback on next attempt): {:?}",
            normalized
        );
    }
}

fn is_node_crashed(path: &std::path::Path) -> bool {
    let normalized = normalize_external_path(path.to_path_buf());
    let paths = CRASHED_NODE_PATHS.lock().unwrap_or_else(|e| e.into_inner());
    paths.iter().any(|x| x == &normalized)
}

/// On Windows, check if the process exited with STATUS_ACCESS_VIOLATION (0xC0000005)
/// and mark the node binary as crashed for fallback to system node.
#[cfg(target_os = "windows")]
fn maybe_mark_crashed_node(status: &std::process::ExitStatus, node_path: &std::path::Path) {
    let code = status.code().unwrap_or(0) as u32;
    if code == 0xc0000005 {
        mark_node_as_crashed(node_path);
    }
}

// ===== Port File for CLI Discovery =====

/// Write the Global Sidecar port to `<data-dir>/sidecar.port` so the CLI can discover it.
/// Uses `zhishi_data_dir()` (not a hardcoded home path) so portable mode keeps
/// writer and readers (cli.rs, trust.rs) on the same file.
fn write_global_port_file(port: u16) {
    if let Some(dir) = crate::app_dirs::zhishi_data_dir() {
        let port_file = dir.join(PORT_FILE_NAME);
        if let Err(e) = std::fs::write(&port_file, port.to_string()) {
            ulog_warn!("[sidecar] Failed to write port file {:?}: {}", port_file, e);
        } else {
            ulog_info!("[sidecar] Wrote CLI port file: {:?} = {}", port_file, port);
        }
    }
}

/// Remove the port file (called on app exit / sidecar shutdown).
fn remove_global_port_file() {
    if let Some(dir) = crate::app_dirs::zhishi_data_dir() {
        let port_file = dir.join(PORT_FILE_NAME);
        let _ = std::fs::remove_file(&port_file);
    }
}

// ===== Proxy Configuration =====
// Default values (must match TypeScript PROXY_DEFAULTS in types.ts)
// Proxy configuration is now managed by the shared proxy_config module
// See src/proxy_config.rs for implementation details

// ============= Stale process cleanup =============
//
// Two pattern sets, sharing a common `CHILD_CLEANUP_PATTERNS` base:
//
// * [`STARTUP_CLEANUP_PATTERNS`] additionally sweeps sidecars by
//   [`SIDECAR_MARKER`]. Startup cleanup runs only when `acquire_lock`
//   reports a prior instance — in that scenario the prior instance is
//   already dead (SIGKILL'd by our lock code or crashed), so any matching
//   sidecar must be an orphan we legitimately own.
//
// * [`CHILD_CLEANUP_PATTERNS`] (used by [`cleanup_child_processes`] during
//   shutdown) deliberately **does not** sweep by `SIDECAR_MARKER`. Our
//   own sidecars are killed via their `Child` handles in
//   [`stop_all_sidecars`] — sweeping by marker here would potentially
//   kill a concurrent ZhiShi instance's sidecars during any
//   hypothetical overlap window (single-instance plugin makes this
//   extremely rare but not architecturally impossible, e.g. during an
//   update handoff).
//
// All forward-slash form — the matcher in `process_cleanup` normalizes
// `\` → `/` and lowercases both sides before comparison.
const CHILD_CLEANUP_PATTERNS: &[crate::process_cleanup::ProcessPattern] = &[
    // SDK subprocess spawned by Claude Agent SDK.
    crate::process_cleanup::ProcessPattern::new("SDK", "claude-agent-sdk"),
    // MCP servers installed under ~/.zhishi/mcp/.
    crate::process_cleanup::ProcessPattern::new("MCP", ".zhishi/mcp/"),
    // Well-known external MCP packages launched via `bun x` / `npx`.
    crate::process_cleanup::ProcessPattern::new("MCP-ext", "@playwright/mcp"),
    crate::process_cleanup::ProcessPattern::new("MCP-ext", "@anthropic-ai/mcp"),
    // MCP servers running under bundled Node.js (cmd.exe intermediates on
    // Windows can orphan these; the descendants-by-PPID walk inside
    // `process_cleanup` catches them regardless).
    crate::process_cleanup::ProcessPattern::new("nodejs", "/zhishi/nodejs/"),
];

const STARTUP_CLEANUP_PATTERNS: &[crate::process_cleanup::ProcessPattern] = &[
    // Our own Bun sidecar, identified by the argv marker.
    crate::process_cleanup::ProcessPattern::new("sidecar", SIDECAR_MARKER),
    // SDK subprocess spawned by Claude Agent SDK.
    crate::process_cleanup::ProcessPattern::new("SDK", "claude-agent-sdk"),
    crate::process_cleanup::ProcessPattern::new("MCP", ".zhishi/mcp/"),
    crate::process_cleanup::ProcessPattern::new("MCP-ext", "@playwright/mcp"),
    crate::process_cleanup::ProcessPattern::new("MCP-ext", "@anthropic-ai/mcp"),
    crate::process_cleanup::ProcessPattern::new("nodejs", "/zhishi/nodejs/"),
];

// ===== Sidecar stderr classification =====
//
// Node.js writes to stderr from a few intentional informational paths
// (startup beacon, log-retention sweep audit, sdk-shim warnings). The
// pre-existing default of "stderr ⇒ ERROR" surfaced these as red lines in
// the unified log and broke `grep ERROR` for monitoring. Recognise the
// known prefixes and downgrade.
//
// NOTE on adding new entries: only demote messages that are unconditionally
// non-actionable. If a prefix EVER signals a real problem, leave it on
// ERROR — false negatives in this table are far worse than the noise.

#[derive(Clone, Copy)]
pub(crate) enum SidecarStderrLevel {
    Info,
    Warn,
    Error,
}

pub(crate) fn classify_sidecar_stderr(line: &str) -> SidecarStderrLevel {
    // Anchor the prefix match. `contains()` would silently demote any
    // genuine ERROR line that happens to embed one of these brackets in a
    // user-content echo (e.g., `Failed to validate '[log-retention]' user
    // input`). Sidecar / bridge stderr lines from the producers below
    // start with the prefix unconditionally — leading whitespace is the
    // only natural variation, so trim before matching. Cross-review of
    // dev/0.2.9 flagged the substring-match risk.
    let head = line.trim_start();
    // INFO: pure progress / audit output that just happens to land on
    // stderr because the sidecar logger writes there before unified
    // logging is wired up.
    //   - `[startup]` startupBeacon, fired before stdout drain is hooked.
    //   - `[log-retention]` daily / on-demand sweep audit (deleted N old
    //     files, etc.) — see `src/server/log-retention.ts::safeStderr`.
    if head.starts_with("[startup]") || head.starts_with("[log-retention]") {
        return SidecarStderrLevel::Info;
    }
    // WARN: real warnings the sidecar emits via `console.warn`. The
    // `[sdk-shim]` "not implemented in Bridge mode" lines warn that an
    // openclaw plugin reached for an SDK method the bridge doesn't
    // implement. They are expected (the shim is intentionally partial)
    // but worth keeping visible at WARN level for plugin developers.
    if head.starts_with("[sdk-shim]") {
        return SidecarStderrLevel::Warn;
    }
    SidecarStderrLevel::Error
}

#[cfg(test)]
mod session_activation_tab_uniqueness_tests {
    use super::*;

    /// Helper: shape an activate_session call with sensible defaults.
    fn activate(mgr: &mut SidecarManager, session_id: &str, tab_id: Option<&str>, port: u16) {
        mgr.activate_session(
            session_id.to_string(),
            tab_id.map(String::from),
            None,
            port,
            "/tmp/workspace".to_string(),
            false,
        );
    }

    /// Helper: collect (session_id, tab_id) pairs for assertion clarity.
    fn snapshot(mgr: &SidecarManager) -> Vec<(String, Option<String>)> {
        let mut v: Vec<(String, Option<String>)> = mgr.session_activations
            .iter()
            .map(|(sid, a)| (sid.clone(), a.tab_id.clone()))
            .collect();
        v.sort();
        v
    }

    #[test]
    fn activate_session_clears_stale_tab_id_from_other_activations() {
        let mut mgr = SidecarManager::new();
        // First activation: session_X owned by tab T_A.
        activate(&mut mgr, "session_X", Some("T_A"), 31418);
        // New activation: same tab T_A claims session_Y. Without the
        // uniqueness fix, both session_X and session_Y would carry
        // tab_id=Some("T_A") simultaneously, and the priority-2
        // `find(|a| a.tab_id == Some("T_A"))` lookup in
        // get_tab_server_url would return either entry depending on
        // HashMap iteration order — issue #169's stop-routes-to-wrong-
        // session bug.
        activate(&mut mgr, "session_Y", Some("T_A"), 31419);

        let snap = snapshot(&mgr);
        // session_X's tab_id MUST be cleared. session_Y MUST own T_A.
        assert_eq!(snap, vec![
            ("session_X".to_string(), None),
            ("session_Y".to_string(), Some("T_A".to_string())),
        ]);
    }

    #[test]
    fn update_session_tab_clears_stale_tab_id_from_other_activations() {
        let mut mgr = SidecarManager::new();
        activate(&mut mgr, "session_X", Some("T_A"), 31418);
        activate(&mut mgr, "session_Y", None, 31419);

        // Tab T_A switches to session_Y via update_session_tab. The fix
        // must transfer the tab binding, not duplicate it.
        mgr.update_session_tab("session_Y", Some("T_A".to_string()));

        let snap = snapshot(&mgr);
        assert_eq!(snap, vec![
            ("session_X".to_string(), None),
            ("session_Y".to_string(), Some("T_A".to_string())),
        ]);
    }

    #[test]
    fn update_session_tab_to_none_does_not_touch_other_activations() {
        let mut mgr = SidecarManager::new();
        activate(&mut mgr, "session_X", Some("T_A"), 31418);
        activate(&mut mgr, "session_Y", Some("T_B"), 31419);

        // Clearing T_A from session_X shouldn't affect session_Y's
        // unrelated tab_id.
        mgr.update_session_tab("session_X", None);

        let snap = snapshot(&mgr);
        assert_eq!(snap, vec![
            ("session_X".to_string(), None),
            ("session_Y".to_string(), Some("T_B".to_string())),
        ]);
    }

    #[test]
    fn activate_session_self_keeps_its_own_tab_id() {
        let mut mgr = SidecarManager::new();
        activate(&mut mgr, "session_X", Some("T_A"), 31418);
        // Re-activate the same session with the same tab_id — this
        // should NOT clear its own tab_id during the uniqueness sweep
        // (the sweep skips the keeper session_id).
        activate(&mut mgr, "session_X", Some("T_A"), 31418);

        let snap = snapshot(&mgr);
        assert_eq!(snap, vec![("session_X".to_string(), Some("T_A".to_string()))]);
    }

    #[test]
    fn multiple_unrelated_tabs_coexist() {
        let mut mgr = SidecarManager::new();
        activate(&mut mgr, "session_X", Some("T_A"), 31418);
        activate(&mut mgr, "session_Y", Some("T_B"), 31419);
        activate(&mut mgr, "session_Z", Some("T_C"), 31420);

        // Three tabs each on their own session — no interference.
        let snap = snapshot(&mgr);
        assert_eq!(snap, vec![
            ("session_X".to_string(), Some("T_A".to_string())),
            ("session_Y".to_string(), Some("T_B".to_string())),
            ("session_Z".to_string(), Some("T_C".to_string())),
        ]);
    }

    #[test]
    fn clearing_tab_id_preserves_task_id_and_port() {
        // When session_X loses its tab binding because tab T_A claims
        // session_Y, session_X's other fields (task_id, port, workspace,
        // is_cron_task) MUST stay intact — the cron / BG owner that
        // keeps the sidecar alive still depends on them.
        let mut mgr = SidecarManager::new();
        mgr.activate_session(
            "session_X".to_string(),
            Some("T_A".to_string()),
            Some("task-123".to_string()),
            31418,
            "/tmp/workspace_x".to_string(),
            true,
        );
        // Tab T_A switches to session_Y → session_X's tab_id must clear,
        // but task_id="task-123" / port=31418 / workspace must persist.
        mgr.activate_session(
            "session_Y".to_string(),
            Some("T_A".to_string()),
            None,
            31419,
            "/tmp/workspace_y".to_string(),
            false,
        );

        let session_x = mgr.session_activations.get("session_X").expect("session_X stays");
        assert_eq!(session_x.tab_id, None);
        assert_eq!(session_x.task_id.as_deref(), Some("task-123"));
        assert_eq!(session_x.port, 31418);
        assert_eq!(session_x.workspace_path, "/tmp/workspace_x");
        assert!(session_x.is_cron_task);
    }

    #[test]
    fn get_tab_server_url_returns_unique_port_after_tab_switch() {
        // Integration-style check: the priority-2 fallback in
        // get_tab_server_url iterates session_activations.values() to
        // find by tab_id. After enforcing uniqueness, there can only
        // be one match — so the port returned is deterministic
        // regardless of HashMap iteration order.
        let mut mgr = SidecarManager::new();
        activate(&mut mgr, "session_X", Some("T_A"), 31418);
        activate(&mut mgr, "session_Y", Some("T_A"), 31419); // T_A switches to session_Y

        // Find by tab_id == T_A: must be session_Y (port 31419), not session_X.
        let matches: Vec<(String, u16)> = mgr.session_activations.values()
            .filter(|a| a.tab_id.as_deref() == Some("T_A"))
            .map(|a| (a.session_id.clone(), a.port))
            .collect();
        assert_eq!(matches.len(), 1, "tab_id uniqueness violated: {:?}", matches);
        assert_eq!(matches[0], ("session_Y".to_string(), 31419));
    }
}

#[cfg(test)]
mod stderr_classifier_tests {
    use super::*;

    #[test]
    fn anchored_prefixes_demote_only_when_at_line_start() {
        assert!(matches!(classify_sidecar_stderr("[startup] init"), SidecarStderrLevel::Info));
        assert!(matches!(classify_sidecar_stderr("[log-retention] sweep done"), SidecarStderrLevel::Info));
        assert!(matches!(classify_sidecar_stderr("[sdk-shim] foo() not implemented"), SidecarStderrLevel::Warn));
        // Leading whitespace OK.
        assert!(matches!(classify_sidecar_stderr("  [startup] foo"), SidecarStderrLevel::Info));
        // Embedded prefix in a real error MUST stay ERROR.
        assert!(matches!(
            classify_sidecar_stderr("Error: failed to parse '[log-retention]' user input"),
            SidecarStderrLevel::Error
        ));
        assert!(matches!(
            classify_sidecar_stderr("uncaught: missing [sdk-shim] field in payload"),
            SidecarStderrLevel::Error
        ));
        // Default = ERROR.
        assert!(matches!(classify_sidecar_stderr("ReferenceError: x is not defined"), SidecarStderrLevel::Error));
    }
}

// ===== Startup cleanup synchronization =====
//
// `cleanup_stale_sidecars` is now hoisted off the main thread (see
// `lib.rs::setup`). Any sidecar start path MUST wait on this barrier before
// spawning to avoid port collisions with stale processes that are still
// being killed. The barrier is set up once at app start and, in the vast
// majority of cases, is already signaled by the time the first sidecar
// spawn is requested (cleanup is ~50 ms when there's nothing to kill).

pub(crate) struct StartupCleanupBarrier {
    done: std::sync::atomic::AtomicBool,
}

static STARTUP_CLEANUP_BARRIER: std::sync::OnceLock<Arc<StartupCleanupBarrier>> =
    std::sync::OnceLock::new();

/// Initialize the startup-cleanup barrier. Call exactly once, before any
/// potential call to [`wait_for_startup_cleanup`]. Safe to call multiple
/// times — subsequent calls are no-ops.
pub fn init_startup_cleanup_barrier() -> Arc<StartupCleanupBarrier> {
    STARTUP_CLEANUP_BARRIER
        .get_or_init(|| {
            Arc::new(StartupCleanupBarrier {
                done: std::sync::atomic::AtomicBool::new(false),
            })
        })
        .clone()
}

/// Mark the startup cleanup as complete. Waiters will observe the flag
/// via their own polling loop — no async condvar needed.
pub fn mark_startup_cleanup_done() {
    if let Some(b) = STARTUP_CLEANUP_BARRIER.get() {
        b.done.store(true, std::sync::atomic::Ordering::Release);
    }
}

/// Block the current (sync) thread until the startup cleanup pass has
/// finished, or until `timeout` elapses. Logs a warning on timeout but
/// does not fail — callers should proceed with best-effort spawn.
///
/// Implementation note: pure `AtomicBool` polling with a 25 ms sleep —
/// deliberately **not** using `tokio::sync::Notify` + `block_on`. This
/// function is called from `start_tab_sidecar`, which is invoked from
/// within an async Tauri command (running on a tokio worker), where
/// `tauri::async_runtime::block_on` would panic
/// ("cannot start a runtime from within a runtime"). Polling is also
/// cheap enough here: the common case is the barrier is already
/// signaled before the first sidecar spawn is requested, so we exit on
/// the first atomic-load without ever sleeping.
pub fn wait_for_startup_cleanup(timeout: Duration) {
    let Some(barrier) = STARTUP_CLEANUP_BARRIER.get() else {
        return;
    };
    if barrier.done.load(std::sync::atomic::Ordering::Acquire) {
        return;
    }
    let start = std::time::Instant::now();
    let poll = Duration::from_millis(25);
    while !barrier.done.load(std::sync::atomic::Ordering::Acquire) {
        if start.elapsed() >= timeout {
            ulog_warn!(
                "[sidecar] Startup cleanup barrier timed out after {:?}; proceeding anyway",
                start.elapsed()
            );
            return;
        }
        thread::sleep(poll);
    }
    let elapsed = start.elapsed();
    if elapsed > Duration::from_millis(100) {
        ulog_info!(
            "[sidecar] Sidecar spawn waited {:?} for startup cleanup",
            elapsed
        );
    }
}

/// Fast synchronous preamble — safe to run on the main thread before the
/// heavy cleanup pass is spawned into a blocking worker. Removes the stale
/// port file so a lingering CLI read doesn't see a dead port.
pub fn cleanup_stale_sidecars_preamble() {
    remove_global_port_file();
}

/// Heavy cleanup pass — enumerate and kill stale sidecar/SDK/MCP
/// subprocesses left behind by a prior app instance.
///
/// Intended to run on a blocking tokio worker off the main thread. The
/// entire Windows path previously took 5–15 seconds synchronously by
/// shelling out to PowerShell+WMI six times; this native implementation
/// typically completes in 10–200 ms.
///
/// When `had_prior_instance` is `false` (true first launch / post-uninstall),
/// the scan is skipped entirely — there cannot be any orphans to kill,
/// so the PID enumeration overhead is pure waste.
pub fn cleanup_stale_sidecars(had_prior_instance: bool) {
    if !had_prior_instance {
        ulog_info!(
            "[sidecar] True first launch (no prior lock file) — skipping stale process scan"
        );
        mark_startup_cleanup_done();
        return;
    }

    let report = crate::process_cleanup::kill_stale_processes(STARTUP_CLEANUP_PATTERNS);
    if report.total_targets() == 0 {
        ulog_info!(
            "[sidecar] Startup cleanup complete in {:?} (no stale processes found)",
            report.elapsed
        );
    } else {
        ulog_info!(
            "[sidecar] Startup cleanup: killed {} (roots={}, descendants={}, residual={}) in {:?}",
            report.killed,
            report.matched_roots,
            report.descendants,
            report.residual,
            report.elapsed
        );
        if report.residual > 0 {
            ulog_warn!(
                "[sidecar] {} processes survived termination deadline",
                report.residual
            );
        }
    }
    mark_startup_cleanup_done();
}



// ============= Session-Centric Sidecar Architecture =============
// Sidecar is a service process for Sessions, not for Tabs or CronTasks.
// Multiple owners (Tabs, CronTasks) can share a Session's Sidecar.

/// Owner of a Sidecar - can be a Tab, CronTask, or BackgroundCompletion
/// When all owners release, the Sidecar is stopped.
#[derive(Debug, Clone, Eq, PartialEq, Hash, Serialize, Deserialize)]
pub enum SidecarOwner {
    /// Tab ID that owns part of this Sidecar
    Tab(String),
    /// Cron Task ID that owns part of this Sidecar
    CronTask(String),
    /// Background completion owner - keeps Sidecar alive while AI finishes responding
    /// String is the session ID for identification
    BackgroundCompletion(String),
    /// Agent owner - keeps Sidecar alive for IM/Agent message processing
    /// String is the session_key (e.g. "agent:{agentId}:{channel}:{type}:{id}")
    Agent(String),
}

/// Explicit three-state lifecycle for a SessionSidecar.
///
/// Replaces the previous `healthy: bool` which conflated Starting (process alive,
/// not yet healthy) with Dead (process exited), causing race conditions where
/// health monitors would kill Starting sidecars.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarState {
    /// Process spawned, `wait_for_health` in progress — do not kill.
    Starting,
    /// TCP health check passed (`wait_for_health`), ready to serve requests.
    Healthy,
    /// Process exited or health check permanently failed.
    Dead,
}

/// Session-centric Sidecar instance
/// Each Session has at most one Sidecar, shared by multiple owners.
/// Result of `SidecarManager::kill_sidecar_if_runtime_differs`.
///
/// Distinguishes between three cases:
/// - `NoDrift`: the existing Sidecar's runtime matches the desired runtime
///   (or there's no existing Sidecar).
/// - `DetectedKeptAlive`: drift was detected but the Sidecar has non-Agent
///   owners (Tab/Cron/BackgroundCompletion) attached, so killing would
///   orphan a desktop session. The caller (IM router) should still treat
///   this as drift and fork the peer to a new session_id.
/// - `KilledAndRemoved`: drift was detected AND the Sidecar had only Agent
///   owners, so it's been killed and evicted from the manager.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeDriftResult {
    NoDrift,
    DetectedKeptAlive,
    KilledAndRemoved,
}

impl RuntimeDriftResult {
    /// Did we observe a runtime drift? (True for both kill outcomes.)
    pub fn is_drift(&self) -> bool {
        matches!(self, Self::KilledAndRemoved | Self::DetectedKeptAlive)
    }
}

enum ExistingSidecarReuse {
    Healthy { port: u16, generation: u64, runtime: String },
    /// `owner_added` = whether THIS ensure call newly inserted its owner when it
    /// joined the still-starting Sidecar. Only true means a readiness-timeout
    /// detach may safely remove that owner (see `add_owner`).
    Starting { port: u16, generation: u64, runtime: String, owner_added: bool },
}

fn normalize_runtime_name(runtime: Option<&str>) -> &str {
    match runtime {
        Some(runtime) if !runtime.is_empty() => runtime,
        _ => "builtin",
    }
}

fn sidecar_has_non_agent_owner(owners: &HashSet<SidecarOwner>) -> bool {
    owners.iter().any(|owner| !matches!(owner, SidecarOwner::Agent(_)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SidecarRemovalEventPolicy {
    emit_stop: bool,
    emit_terminal: bool,
}

fn sidecar_removal_event_policy(owners: &HashSet<SidecarOwner>) -> SidecarRemovalEventPolicy {
    SidecarRemovalEventPolicy {
        emit_stop: true,
        emit_terminal: owners.is_empty(),
    }
}

fn decide_runtime_drift_result(
    sidecar_runtime: Option<&str>,
    desired_runtime: &str,
    owners: &HashSet<SidecarOwner>,
) -> RuntimeDriftResult {
    let sidecar_runtime = normalize_runtime_name(sidecar_runtime);
    let desired_runtime = normalize_runtime_name(Some(desired_runtime));

    if sidecar_runtime == desired_runtime {
        RuntimeDriftResult::NoDrift
    } else if sidecar_has_non_agent_owner(owners) {
        RuntimeDriftResult::DetectedKeptAlive
    } else {
        RuntimeDriftResult::KilledAndRemoved
    }
}

#[cfg(test)]
mod lifecycle_contract_tests {
    use super::*;
    use std::collections::HashSet;

    fn owners(values: Vec<SidecarOwner>) -> HashSet<SidecarOwner> {
        values.into_iter().collect()
    }

    #[test]
    fn runtime_drift_with_tab_and_agent_owner_is_kept_alive() {
        let owners = owners(vec![
            SidecarOwner::Tab("tab-a".to_string()),
            SidecarOwner::Agent("agent-a".to_string()),
        ]);

        assert_eq!(
            decide_runtime_drift_result(Some("codex"), "gemini", &owners),
            RuntimeDriftResult::DetectedKeptAlive
        );
    }

    #[test]
    fn runtime_drift_with_only_agent_owners_is_killable() {
        let owners = owners(vec![SidecarOwner::Agent("agent-a".to_string())]);

        assert_eq!(
            decide_runtime_drift_result(Some("codex"), "gemini", &owners),
            RuntimeDriftResult::KilledAndRemoved
        );
    }

    #[test]
    fn builtin_runtime_names_are_normalized_for_no_drift() {
        let owners = owners(vec![SidecarOwner::Agent("agent-a".to_string())]);

        assert_eq!(
            decide_runtime_drift_result(None, "", &owners),
            RuntimeDriftResult::NoDrift
        );
        assert_eq!(
            decide_runtime_drift_result(None, "builtin", &owners),
            RuntimeDriftResult::NoDrift
        );
    }

    #[test]
    fn cron_and_background_owners_make_runtime_drift_non_killable() {
        let cron = owners(vec![SidecarOwner::CronTask("cron-a".to_string())]);
        let background = owners(vec![SidecarOwner::BackgroundCompletion(
            "session-a".to_string(),
        )]);

        assert_eq!(
            decide_runtime_drift_result(Some("codex"), "gemini", &cron),
            RuntimeDriftResult::DetectedKeptAlive
        );
        assert_eq!(
            decide_runtime_drift_result(Some("codex"), "gemini", &background),
            RuntimeDriftResult::DetectedKeptAlive
        );
    }

    #[test]
    fn terminal_removal_requires_no_remaining_owners() {
        assert_eq!(
            sidecar_removal_event_policy(&HashSet::new()),
            SidecarRemovalEventPolicy { emit_stop: true, emit_terminal: true }
        );
        assert_eq!(
            sidecar_removal_event_policy(&owners(vec![SidecarOwner::Tab("tab-a".to_string())])),
            SidecarRemovalEventPolicy { emit_stop: true, emit_terminal: false }
        );
        assert_eq!(
            sidecar_removal_event_policy(&owners(vec![SidecarOwner::Agent("agent-a".to_string())])),
            SidecarRemovalEventPolicy { emit_stop: true, emit_terminal: false }
        );
    }

    #[test]
    fn sidecar_generation_is_monotonic_and_not_reused_after_clear() {
        let mut manager = SidecarManager::new();

        let first = manager.next_generation("session-a");
        let second = manager.next_generation("session-a");
        assert!(second > first);

        manager.clear_generation("session-a");
        assert_eq!(manager.current_generation("session-a"), 0);

        let third = manager.next_generation("session-a");
        assert!(third > second);
    }

    fn spawn_test_child() -> Child {
        #[cfg(windows)]
        let mut cmd = {
            let mut cmd = crate::process_cmd::new("powershell");
            cmd.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 60"]);
            cmd
        };

        #[cfg(not(windows))]
        let mut cmd = {
            let mut cmd = crate::process_cmd::new("sleep");
            cmd.arg("60");
            cmd
        };

        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn test child")
    }

    fn insert_test_sidecar(manager: &mut SidecarManager, session_id: &str, state: SidecarState) {
        manager.insert_sidecar(
            session_id,
            SessionSidecar {
                process: spawn_test_child(),
                port: 31418,
                session_id: session_id.to_string(),
                workspace_path: PathBuf::from("/tmp/workspace"),
                state,
                owners: owners(vec![SidecarOwner::Tab("tab-a".to_string())]),
                created_at: std::time::Instant::now(),
                runtime: None,
            },
        );
    }

    #[test]
    fn session_port_is_not_exposed_until_sidecar_is_healthy() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Starting);

        assert_eq!(manager.get_session_port("session-a"), None);

        manager
            .get_session_sidecar_mut("session-a")
            .expect("session sidecar")
            .state = SidecarState::Healthy;

        assert_eq!(manager.get_session_port("session-a"), Some(31418));
    }

    #[test]
    fn generation_for_requires_current_sidecar_entry() {
        let mut manager = SidecarManager::new();
        insert_test_sidecar(&mut manager, "session-a", SidecarState::Healthy);
        let generation = manager.generation_for("session-a").expect("current generation");

        manager.remove_sidecar("session-a");

        assert_eq!(manager.current_generation("session-a"), generation);
        assert_eq!(manager.generation_for("session-a"), None);
    }
}

pub struct SessionSidecar {
    /// The child process handle
    pub process: Child,
    /// Port this instance is running on
    pub port: u16,
    /// Session ID this Sidecar serves
    pub session_id: String,
    /// Workspace path for this session
    /// Reserved for future use (e.g., workspace-aware operations)
    #[allow(dead_code)]
    pub workspace_path: PathBuf,
    /// Lifecycle state: Starting → Healthy → Dead
    pub state: SidecarState,
    /// Set of owners (Tabs and CronTasks) that are using this Sidecar
    pub owners: HashSet<SidecarOwner>,
    /// Creation timestamp
    /// Reserved for future use (e.g., TTL-based cleanup)
    #[allow(dead_code)]
    pub created_at: std::time::Instant,
    /// ZHISHI_RUNTIME env var value this Sidecar was spawned with.
    /// Used for drift detection on Agent-owner reuse: when the agent's
    /// runtime config changes (e.g. codex → gemini), subsequent IM messages
    /// for the same peer session must not reuse a Sidecar that's still
    /// running the old runtime. None = builtin (no env var injected).
    pub runtime: Option<String>,
}

impl SessionSidecar {
    /// Is this sidecar healthy and ready to accept requests?
    pub fn is_reusable(&self) -> bool {
        matches!(self.state, SidecarState::Healthy)
    }

    /// Is this sidecar both marked healthy and still alive?
    pub fn is_ready_for_requests(&mut self) -> bool {
        !self.is_dead() && self.is_reusable()
    }

    /// Is this sidecar still starting up? (process alive, `wait_for_health` in progress)
    pub fn is_starting(&self) -> bool {
        matches!(self.state, SidecarState::Starting)
    }

    /// Is this sidecar dead?
    /// Also auto-detects process exit and transitions Starting/Healthy → Dead.
    pub fn is_dead(&mut self) -> bool {
        if self.state == SidecarState::Dead {
            return true;
        }
        // Check if the process actually exited while we thought it was alive
        match self.process.try_wait() {
            Ok(Some(_)) => {
                self.state = SidecarState::Dead;
                true
            }
            Ok(None) => false, // Still running
            Err(_) => {
                self.state = SidecarState::Dead;
                true
            }
        }
    }

    /// Check if this Sidecar has any owners
    /// Reserved for future use (e.g., lifecycle management)
    #[allow(dead_code)]
    pub fn has_owners(&self) -> bool {
        !self.owners.is_empty()
    }

    /// Add an owner to this Sidecar.
    /// Returns true if the owner was newly inserted, false if it already owned
    /// this Sidecar (symmetric with `remove_owner`). The Starting-join path uses
    /// this to decide whether a later readiness-timeout detach is safe: only the
    /// call that actually added a *new* owner may remove it on timeout. A
    /// same-owner concurrent ensure (e.g. two `ensure_session_sidecar(.., Tab(t))`
    /// for one tab) gets `false` here, so it must NOT remove the shared owner —
    /// doing so would empty the owner set and kill a Sidecar another caller is
    /// still starting.
    pub fn add_owner(&mut self, owner: SidecarOwner) -> bool {
        self.owners.insert(owner)
    }

    /// Remove an owner from this Sidecar
    /// Returns true if this was the last owner (Sidecar should be stopped)
    pub fn remove_owner(&mut self, owner: &SidecarOwner) -> bool {
        self.owners.remove(owner);
        self.owners.is_empty()
    }
}

/// Ensure Sidecar process is killed when SessionSidecar is dropped
impl Drop for SessionSidecar {
    fn drop(&mut self) {
        ulog_info!(
            "[sidecar] Drop: killing SessionSidecar for session {} on port {} (state: {:?})",
            self.session_id, self.port, self.state
        );
        let _ = kill_process(&mut self.process);
    }
}

/// Single Sidecar instance (legacy - used only for Global Sidecar).
/// Still uses `healthy: bool` since the Global Sidecar is a singleton
/// without the multi-owner race conditions that motivated `SidecarState`.
pub struct SidecarInstance {
    /// The child process handle
    pub process: Child,
    /// Port this instance is running on
    pub port: u16,
    /// Agent directory (None for global sidecar)
    pub agent_dir: Option<PathBuf>,
    /// Whether the sidecar passed initial health check
    pub healthy: bool,
    /// Whether this is a global sidecar (uses temp directory)
    pub is_global: bool,
    /// When this instance was created — used by health monitor to apply startup grace period.
    /// During the grace window the monitor skips health checks, preventing false "unhealthy"
    /// verdicts while the sidecar is still initialising (TCP check, Bun startup, Plugin Bridge…).
    pub created_at: std::time::Instant,
}

impl SidecarInstance {
    /// Check if the sidecar process is still running
    /// This actively checks the process rather than just relying on the healthy flag
    pub fn is_running(&mut self) -> bool {
        if !self.healthy {
            return false;
        }
        
        // Try to check if process has exited
        match self.process.try_wait() {
            Ok(Some(_)) => {
                // Process has exited
                self.healthy = false;
                false
            }
            Ok(None) => true, // Still running
            Err(_) => {
                self.healthy = false;
                false
            }
        }
    }
}

/// Ensure Node.js process is killed when SidecarInstance is dropped
impl Drop for SidecarInstance {
    fn drop(&mut self) {
        ulog_info!("[sidecar] Drop: killing process on port {}", self.port);
        let _ = kill_process(&mut self.process);
        
        // Clean up temp directory for global sidecar
        if self.is_global {
            if let Some(ref dir) = self.agent_dir {
                ulog_info!("[sidecar] Cleaning up temp directory: {:?}", dir);
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }
}

/// Session activation record
/// Tracks which Sidecar is currently "activating" a Session
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionActivation {
    /// Session ID being activated
    pub session_id: String,
    /// Tab ID that owns this activation (None for headless cron tasks)
    pub tab_id: Option<String>,
    /// Cron task ID if activated by cron task
    pub task_id: Option<String>,
    /// Port of the Sidecar handling this session
    pub port: u16,
    /// Workspace path
    pub workspace_path: String,
    /// Whether this is a cron task activation
    pub is_cron_task: bool,
}

/// Sidecar info for external queries
/// Reserved for future use (e.g., admin UI, debugging endpoints)
#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct SidecarInfo {
    pub port: u16,
    pub workspace_path: String,
    pub is_healthy: bool,
}

/// Multi-instance Sidecar Manager
/// Manages multiple Sidecar processes with Session singleton support
///
/// Architecture (v0.1.11 - Session-Centric):
/// - Sessions own Sidecars (1:1 relationship between Session and Sidecar)
/// - Multiple owners (Tabs, CronTasks) can share a Session's Sidecar
/// - Sidecar only stops when all owners release
///
/// Legacy support (v0.1.10):
/// - instances: per-Tab Sidecar instances (for backward compatibility)
/// - cron_task_instances: dedicated cron task Sidecars (for backward compatibility)
pub struct SidecarManager {
    // ===== New Session-Centric Storage (v0.1.11) =====
    /// Session ID -> SessionSidecar (primary storage for Session-centric model)
    sidecars: HashMap<String, SessionSidecar>,

    // ===== Legacy Storage (kept for backward compatibility) =====
    /// Tab ID -> Sidecar Instance (legacy, used for Global Sidecar)
    instances: HashMap<String, SidecarInstance>,
    /// Session ID -> Session Activation (tracks which session is active for Session singleton)
    session_activations: HashMap<String, SessionActivation>,
    /// Port counter for allocation (starts from BASE_PORT)
    port_counter: AtomicU16,
    /// Session ID -> generation counter. The generation is the unique instance
    /// ID of the *current* sidecar bound to that session_id, drawn from the
    /// process-global `instance_counter` below. Used both for lock-gap HTTP
    /// health-check race detection AND for IM event-consumer cancellation
    /// matching (consumer entries store the generation they were spawned
    /// against; broadcast stop events carry the generation; matching is
    /// reuse-safe because the global counter never produces the same value
    /// twice).
    sidecar_generations: HashMap<String, u64>,
    /// Process-global monotonic counter for sidecar instance IDs. Every
    /// `insert_sidecar` draws a fresh value via `fetch_add`. Crucially, this
    /// is **never** reset — even when `sidecar_generations.clear()` runs in
    /// `stop_all` or `clear_generation` removes one entry, the counter
    /// keeps climbing. Without this, a session_id reused after idle release
    /// (IM idle collector preserves session_id by design) would get
    /// generation=1 again and a stale stop event for the previous instance
    /// would falsely match. With this, IDs are unique for the lifetime of
    /// the process and reuse is impossible.
    instance_counter: AtomicU64,
    /// Broadcast sender — emits `(session_id, generation)` whenever a
    /// SessionSidecar is removed (last owner released, runtime drift kill,
    /// explicit stop, app shutdown). The generation is critical: a remove +
    /// recreate under the same `session_id` (e.g. IM idle collector preserves
    /// session_id, next message rebuilds sidecar) bumps generation, so a
    /// stale stop event from the previous instance no longer matches the
    /// fresh consumer entry. Used by IM ImEventConsumer registry to cancel
    /// its long-poll loop in lockstep with sidecar lifecycle, instead of
    /// letting orphan consumers hammer a dead port until the 60s idle
    /// collector or app shutdown notices.
    /// Channel capacity 64 — one event per sidecar removal; multi-IM setups
    /// have at most a few simultaneous removals during shutdown bursts; on
    /// `Lagged` subscribers do a full reconciliation sweep against
    /// `live_sidecar_set()`.
    stop_events: tokio::sync::broadcast::Sender<(String, u64)>,
    /// Broadcast sender — fires `(session_id, generation)` only when a removal
    /// is *terminal* (no owners remained at the moment of removal). This is the
    /// signal the renderer needs: distinguishes "voluntary release / shutdown /
    /// terminal failure" (Tab binding now dangling, must be cleared) from
    /// "crash with owners still attached" (health monitor will auto-restart on
    /// the next 15-s cycle, Tab binding stays valid).
    ///
    /// Why a *second* channel and not a flag on `stop_events`: existing IM
    /// consumers want every stop regardless of recoverability, and changing
    /// the payload shape would ripple through the lock-gap reconciliation
    /// code. A dedicated channel keeps both concerns orthogonal.
    /// Capacity 64 mirrors `stop_events` — same burst envelope, same lag
    /// recovery story (subscribers reconcile against `live_sidecar_set()`).
    terminal_events: tokio::sync::broadcast::Sender<(String, u64)>,
}

impl SidecarManager {
    pub fn new() -> Self {
        // Drop the initial receiver immediately — subscribers grab their own via
        // `subscribe_stop_events()`. broadcast::Sender keeps working even with
        // zero receivers (send returns Err which we discard at call sites).
        let (stop_events, _drop_initial_rx) = tokio::sync::broadcast::channel(64);
        let (terminal_events, _drop_terminal_rx) = tokio::sync::broadcast::channel(64);
        Self {
            sidecars: HashMap::new(),
            instances: HashMap::new(),
            session_activations: HashMap::new(),
            port_counter: AtomicU16::new(BASE_PORT),
            sidecar_generations: HashMap::new(),
            // Start at 1 so callers using `0` as an "unknown / not present"
            // placeholder (see IM `sidecar_generation_initial.unwrap_or(0)`)
            // never collide with a real allocated generation.
            instance_counter: AtomicU64::new(1),
            stop_events,
            terminal_events,
        }
    }

    /// Subscribe to sidecar-stop events. The returned receiver yields
    /// `(session_id, generation)` of each removed SessionSidecar so the
    /// subscriber can clean up any per-session state it owns (e.g. IM
    /// ImEventConsumer registry). Generation distinguishes a fresh sidecar
    /// from a previous one bound to the same session_id.
    pub fn subscribe_stop_events(&self) -> tokio::sync::broadcast::Receiver<(String, u64)> {
        self.stop_events.subscribe()
    }

    /// Subscribe to *terminal* sidecar removal events — emitted only when the
    /// removed sidecar had no remaining owners (so the health monitor will not
    /// attempt auto-restart and any frontend Tab binding to this session is
    /// definitively dangling). Used by the lib.rs forwarder to drive the
    /// `session:sidecar-terminal` Tauri event so the renderer can reset stale
    /// Tab.sessionId bindings.
    pub fn subscribe_terminal_events(&self) -> tokio::sync::broadcast::Receiver<(String, u64)> {
        self.terminal_events.subscribe()
    }

    /// Snapshot of currently-live `(session_id, generation)` pairs. Subscribers
    /// use this to recover from broadcast `Lagged` (skipped events) by
    /// reconciling: any consumer entry whose `(session_id, generation)` is
    /// *not* in this set was either stopped during the lag window or was
    /// never installed against a live sidecar — either way, cancel it.
    pub fn live_sidecar_set(&self) -> HashSet<(String, u64)> {
        self.sidecars
            .keys()
            .map(|sid| {
                let gen = self.sidecar_generations.get(sid).copied().unwrap_or(0);
                (sid.clone(), gen)
            })
            .collect()
    }

    /// Public read of the generation (= unique instance ID) for a session,
    /// or `None` if no sidecar is currently bound to that session_id.
    /// Returning `Option` (not 0) makes "never existed" explicit at call sites.
    pub fn generation_for(&self, session_id: &str) -> Option<u64> {
        if self.sidecars.contains_key(session_id) {
            self.sidecar_generations.get(session_id).copied()
        } else {
            None
        }
    }

    /// True if a sidecar with this `(session_id, generation)` is currently
    /// in `sidecars` AND its recorded generation matches. Stronger predicate
    /// than `generation_for` alone: catches the case where the manager has a
    /// stale generation entry but the sidecar HashMap entry is gone.
    /// Used by IM `ensure_im_consumer` final-check.
    pub fn is_live(&self, session_id: &str, generation: u64) -> bool {
        self.sidecars.contains_key(session_id)
            && self.sidecar_generations.get(session_id).copied() == Some(generation)
    }

    /// Allocate the next instance ID and stash it as this session's current
    /// generation. The ID comes from the process-global atomic counter, so
    /// it is unique for the whole process lifetime — repeated sidecars under
    /// the same session_id (e.g. IM idle release + rebuild) get distinct
    /// generations, which is what makes IM event-consumer reuse race-free.
    fn next_generation(&mut self, session_id: &str) -> u64 {
        let id = self.instance_counter.fetch_add(1, Ordering::SeqCst);
        self.sidecar_generations.insert(session_id.to_string(), id);
        id
    }

    /// Get the current generation counter for a session (0 if never created
    /// or has been cleared). 0 is never a real generation (counter starts at 1).
    fn current_generation(&self, session_id: &str) -> u64 {
        self.sidecar_generations.get(session_id).copied().unwrap_or(0)
    }

    /// Get the next available port with max attempts to prevent infinite loop
    pub fn allocate_port(&self) -> Result<u16, String> {
        const MAX_ATTEMPTS: u32 = 200;
        
        for _ in 0..MAX_ATTEMPTS {
            let port = self.port_counter.fetch_add(1, Ordering::SeqCst);
            
            // Reset counter if we've gone past the range
            if port > BASE_PORT + PORT_RANGE {
                self.port_counter.store(BASE_PORT, Ordering::SeqCst);
            }
            
            if is_port_available(port) {
                return Ok(port);
            }
        }
        
        Err(format!("No available port found after {} attempts", MAX_ATTEMPTS))
    }

    /// Check if a Tab has a running instance
    #[allow(dead_code)]
    pub fn has_instance(&self, tab_id: &str) -> bool {
        self.instances.contains_key(tab_id)
    }

    /// Get instance status for a Tab
    pub fn get_instance(&self, tab_id: &str) -> Option<&SidecarInstance> {
        self.instances.get(tab_id)
    }

    /// Get mutable instance reference
    pub fn get_instance_mut(&mut self, tab_id: &str) -> Option<&mut SidecarInstance> {
        self.instances.get_mut(tab_id)
    }

    /// Insert a new instance
    pub fn insert_instance(&mut self, tab_id: String, instance: SidecarInstance) {
        self.instances.insert(tab_id, instance);
    }

    /// Remove and return an instance (will be dropped, killing the process)
    pub fn remove_instance(&mut self, tab_id: &str) -> Option<SidecarInstance> {
        self.instances.remove(tab_id)
    }

    /// Get all Tab IDs
    #[allow(dead_code)]
    pub fn tab_ids(&self) -> Vec<String> {
        self.instances.keys().cloned().collect()
    }

    /// Iterate over all instances (tab_id, instance)
    /// Reserved for future use (e.g., debugging, admin UI)
    #[allow(dead_code)]
    pub fn iter_instances(&self) -> impl Iterator<Item = (&String, &SidecarInstance)> {
        self.instances.iter()
    }

    /// Get all unique ports of running Sidecars (session-centric + legacy global).
    /// Used for broadcasting config changes (e.g. proxy hot-reload) to all Sidecars.
    pub fn get_all_active_ports(&mut self) -> Vec<u16> {
        let mut ports = Vec::new();
        // Session-centric sidecars (Tab/CronTask/BackgroundCompletion)
        for sc in self.sidecars.values_mut() {
            if !sc.is_dead() {
                ports.push(sc.port);
            }
        }
        // Legacy instances (Global Sidecar)
        for inst in self.instances.values_mut() {
            if inst.is_running() {
                ports.push(inst.port);
            }
        }
        ports.sort();
        ports.dedup();
        ports
    }

    /// Stop all instances (session sidecars and global sidecar)
    pub fn stop_all(&mut self) {
        ulog_info!(
            "[sidecar] Stopping all instances (sessions: {}, global: {})",
            self.sidecars.len(),
            self.instances.len()
        );
        // Broadcast stop for each live sidecar before clearing — covers callers
        // that invoke stop_all while IM bots are still running (e.g. exposed
        // `cmd_stop_all_sidecars` Tauri command). The app-exit path normally
        // signals IM shutdown_rx first, but we don't rely on caller ordering.
        let to_broadcast: Vec<(String, u64)> = self
            .sidecars
            .keys()
            .map(|sid| {
                (
                    sid.clone(),
                    self.sidecar_generations.get(sid).copied().unwrap_or(0),
                )
            })
            .collect();
        for ev in &to_broadcast {
            let _ = self.stop_events.send(ev.clone());
            // stop_all is unconditionally terminal — exposed via
            // `cmd_stop_all_sidecars` (debug/admin) and the app-exit path.
            // Either way no auto-restart will fire, so the renderer's tab
            // bindings should be cleared. (App-exit usually beats the
            // renderer's listener teardown to nothing, but `cmd_stop_all`
            // mid-session is a real path and the listener is alive there.)
            let _ = self.terminal_events.send(ev.clone());
        }
        self.sidecars.clear(); // Session-centric Sidecars (Drop kills processes)
        self.instances.clear(); // Global Sidecar (Drop kills process)
        self.session_activations.clear();
        self.sidecar_generations.clear();
        // Remove port file so CLI knows the sidecar is down
        remove_global_port_file();
    }

    // ============= Session Activation Methods =============

    /// Get session activation by session ID
    pub fn get_session_activation(&self, session_id: &str) -> Option<&SessionActivation> {
        self.session_activations.get(session_id)
    }

    /// (v0.2.12 — issue #169 fix) Enforce tab_id uniqueness across
    /// `session_activations`: at most one activation may have a given
    /// `tab_id == Some(T)` at any time. Called from `activate_session`
    /// and `update_session_tab` BEFORE writing the new tab_id.
    ///
    /// Why: `get_tab_server_url`'s priority-2 fallback iterates
    /// `session_activations.values().find(|a| a.tab_id == Some(tab_id))`
    /// and returns the first match. HashMap iteration order is non-
    /// deterministic, so two activations with the same tab_id mean a
    /// stop / queue-force / any other tab-keyed lookup may resolve to
    /// the wrong session's port → wrong Sidecar gets the request →
    /// wrong session aborted. Issue #169 reported 4 such cross-tab
    /// stop incidents in one day.
    ///
    /// The window where two activations briefly share a tab_id opens
    /// during tab→session switches: the renderer sequence is
    /// `update_session_tab(new_session, T)` → ... → `deactivate_session
    /// (old_session)`. Between those two awaits, both `new_session` and
    /// `old_session` carry `tab_id == Some(T)`. By proactively clearing
    /// the old binding here, we close that window unconditionally —
    /// regardless of whether the renderer remembers to call
    /// `deactivate_session` afterwards.
    ///
    /// Skips the entry whose key matches `keeper_session_id` (the
    /// caller's own session_id) so we don't clobber the write we're
    /// about to make.
    fn clear_tab_id_from_other_activations(
        &mut self,
        keeper_session_id: &str,
        tab_id: &str,
    ) {
        let stale_session_ids: Vec<String> = self.session_activations
            .iter()
            .filter(|(sid, a)| {
                sid.as_str() != keeper_session_id
                    && a.tab_id.as_deref() == Some(tab_id)
            })
            .map(|(sid, _)| sid.clone())
            .collect();
        for sid in stale_session_ids {
            if let Some(activation) = self.session_activations.get_mut(&sid) {
                ulog_info!(
                    "[sidecar] Clearing stale tab_id {:?} from session {} (now claimed by session {})",
                    tab_id, sid, keeper_session_id
                );
                activation.tab_id = None;
            }
        }
    }

    /// Activate a session (associate it with a Sidecar)
    pub fn activate_session(
        &mut self,
        session_id: String,
        tab_id: Option<String>,
        task_id: Option<String>,
        port: u16,
        workspace_path: String,
        is_cron_task: bool,
    ) {
        ulog_info!(
            "[sidecar] Activating session {} on port {}, tab: {:?}, task: {:?}, cron: {}",
            session_id, port, tab_id, task_id, is_cron_task
        );
        // (v0.2.12 — issue #169 fix) Enforce tab_id uniqueness BEFORE
        // inserting the new activation, so the new entry's tab_id is the
        // only match for `find(|a| a.tab_id == Some(tab_id))`.
        if let Some(ref tid) = tab_id {
            self.clear_tab_id_from_other_activations(&session_id, tid);
        }
        self.session_activations.insert(
            session_id.clone(),
            SessionActivation {
                session_id,
                tab_id,
                task_id,
                port,
                workspace_path,
                is_cron_task,
            },
        );
    }

    /// Deactivate a session
    pub fn deactivate_session(&mut self, session_id: &str) -> Option<SessionActivation> {
        ulog_info!("[sidecar] Deactivating session {}", session_id);
        self.session_activations.remove(session_id)
    }

    /// Update session activation's tab_id (e.g., when a Tab connects to headless Sidecar)
    pub fn update_session_tab(&mut self, session_id: &str, tab_id: Option<String>) {
        // (v0.2.12 — issue #169 fix) Enforce tab_id uniqueness BEFORE
        // mutating the target entry, so by the time the read below
        // finalizes, no other activation carries the same tab_id.
        // (Skipped when clearing — `tab_id == None` can't collide.)
        if let Some(ref tid) = tab_id {
            self.clear_tab_id_from_other_activations(session_id, tid);
        }
        if let Some(activation) = self.session_activations.get_mut(session_id) {
            ulog_info!(
                "[sidecar] Updating session {} tab: {:?} -> {:?}",
                session_id, activation.tab_id, tab_id
            );
            activation.tab_id = tab_id;
            // If a tab connects, it's no longer a pure cron task session
            if activation.tab_id.is_some() {
                activation.is_cron_task = false;
            }
        }
    }

    /// Get all active sessions for a workspace
    /// Reserved for future use (e.g., debugging, admin UI)
    #[allow(dead_code)]
    pub fn get_workspace_sessions(&self, workspace_path: &str) -> Vec<&SessionActivation> {
        self.session_activations
            .values()
            .filter(|a| a.workspace_path == workspace_path)
            .collect()
    }

    // ============= Session-Centric Sidecar API (v0.1.11) =============

    /// Get the port for a Session's Sidecar only after it is ready to serve requests.
    ///
    /// Renderer HTTP/SSE callers treat this port as directly usable. Returning a
    /// `Starting` sidecar here exposes a port before Node has finished binding
    /// and `/health/ready`, which can strand restored tabs in a failed load.
    pub fn get_session_port(&mut self, session_id: &str) -> Option<u16> {
        self.sidecars.get_mut(session_id).and_then(|s| {
            if s.is_ready_for_requests() {
                Some(s.port)
            } else {
                None
            }
        })
    }

    /// Check if a Session has an active Sidecar (Starting or Healthy)
    pub fn has_session_sidecar(&mut self, session_id: &str) -> bool {
        if let Some(sidecar) = self.sidecars.get_mut(session_id) {
            !sidecar.is_dead()
        } else {
            false
        }
    }

    /// Get SessionSidecar reference by session ID
    /// Reserved for future use (e.g., debugging, introspection)
    #[allow(dead_code)]
    pub fn get_session_sidecar(&self, session_id: &str) -> Option<&SessionSidecar> {
        self.sidecars.get(session_id)
    }

    /// Get mutable SessionSidecar reference by session ID
    /// Reserved for future use (e.g., advanced owner management)
    #[allow(dead_code)]
    pub fn get_session_sidecar_mut(&mut self, session_id: &str) -> Option<&mut SessionSidecar> {
        self.sidecars.get_mut(session_id)
    }

    /// Get session IDs that have a BackgroundCompletion owner
    /// Used by Task Center to show [后台] tags on sessions
    pub fn get_background_session_ids(&self) -> Vec<String> {
        self.sidecars.iter()
            .filter(|(_, sc)| sc.owners.iter().any(|o| matches!(o, SidecarOwner::BackgroundCompletion(_))))
            .map(|(sid, _)| sid.clone())
            .collect()
    }

    /// Insert a sidecar and auto-increment its generation counter.
    /// This ensures every creation is tracked for lock-gap race detection.
    fn insert_sidecar(&mut self, session_id: &str, sidecar: SessionSidecar) {
        self.next_generation(session_id);
        self.sidecars.insert(session_id.to_string(), sidecar);
    }

    /// Remove a sidecar. Does NOT clear the generation counter — it must remain
    /// queryable across lock gaps (e.g. during HTTP health check windows).
    /// Broadcasts `(session_id, generation)` on `stop_events` when the entry
    /// actually existed, so subscribers (IM event-consumer registry) can
    /// cancel resources tied to *this specific* sidecar instance — a stale
    /// event from a previous instance won't match a freshly-recreated one.
    fn remove_sidecar(&mut self, session_id: &str) -> Option<SessionSidecar> {
        let gen = self.current_generation(session_id);
        let removed = self.sidecars.remove(session_id);
        if let Some(ref sidecar) = removed {
            let event_policy = sidecar_removal_event_policy(&sidecar.owners);
            // send() returns Err only when there are no subscribers — fine, we
            // don't require anyone listening for sidecar removal to be valid.
            if event_policy.emit_stop {
                let _ = self.stop_events.send((session_id.to_string(), gen));
            }

            // Terminal = no owners remained. Health monitor only auto-restarts
            // when `is_dead() && !owners.is_empty()` (see `monitor_session_sidecars`
            // line 2356), so empty-owners ⇒ no restart attempt ⇒ any frontend
            // Tab binding to this session is now dangling and must be cleared.
            // Crash-with-owners stays silent here: the bound Tab keeps its
            // sessionId, and the existing `session-sidecar:restarted` Tauri
            // event drives transparent reconnection in TabProvider.
            if event_policy.emit_terminal {
                let _ = self.terminal_events.send((session_id.to_string(), gen));
            }
        }
        removed
    }

    /// Runtime drift helper for the IM router (v0.1.66).
    ///
    /// Looks up the Sidecar for `session_id` and checks whether its spawn-time
    /// ZHISHI_RUNTIME differs from `desired_runtime`. On drift, the kill
    /// decision depends on which owners are currently attached:
    ///
    ///   - Only `Agent(_)` owners → safe to kill: the IM router is the sole
    ///     stakeholder and it will regenerate the peer session_id anyway.
    ///     Kill + remove + clear generation counter.
    ///
    ///   - Any non-Agent owner (`Tab`, `CronTask`, `BackgroundCompletion`) →
    ///     the Sidecar is shared with a desktop-style caller whose session
    ///     would be orphaned by a kill (SSE stream dies, frontend can't
    ///     recover without reload). Skip the kill, leave the Sidecar alone,
    ///     but still return DriftDetected so the caller (IM router) can
    ///     regenerate the peer session_id and fork cleanly. The old Sidecar
    ///     keeps running under the old session_id for the desktop owner;
    ///     the IM peer gets a fresh Sidecar under the new session_id.
    ///
    /// `desired_runtime` follows the same normalization as everywhere else:
    /// `"builtin"` | `"claude-code"` | `"codex"` | `"gemini"`. Internally
    /// Sidecars spawned as builtin have `runtime = None` (no env var
    /// injected); this method treats that as equivalent to `"builtin"` for
    /// comparison.
    pub fn kill_sidecar_if_runtime_differs(
        &mut self,
        session_id: &str,
        desired_runtime: &str,
    ) -> RuntimeDriftResult {
        let decision = match self.sidecars.get(session_id) {
            Some(sidecar) => decide_runtime_drift_result(
                sidecar.runtime.as_deref(),
                desired_runtime,
                &sidecar.owners,
            ),
            None => RuntimeDriftResult::NoDrift,
        };
        if decision == RuntimeDriftResult::NoDrift {
            return decision;
        }
        if decision == RuntimeDriftResult::DetectedKeptAlive {
            ulog_info!(
                "[sidecar] Runtime drift on session {} detected but kept alive \
                 — non-Agent owner (Tab/Cron/BackgroundCompletion) still attached. \
                 Caller should fork via a fresh session_id.",
                session_id
            );
            return decision;
        }
        if let Some(sidecar) = self.sidecars.get_mut(session_id) {
            let _ = sidecar.process.kill();
        }
        // Go through remove_sidecar() so stop_events is broadcast — a runtime
        // drift kill is exactly the kind of stop that orphan IM consumers
        // would otherwise miss.
        self.remove_sidecar(session_id);
        // Clear the generation counter too — the old session_id is now orphaned
        // and the peer map will never reference it again, so there's no TOCTOU
        // concern that kept it alive in the normal remove_sidecar path.
        self.sidecar_generations.remove(session_id);
        decision
    }

    /// Clear the generation counter for a session.
    /// Call only when the session is permanently done (last owner released).
    fn clear_generation(&mut self, session_id: &str) {
        self.sidecar_generations.remove(session_id);
    }

    /// Add an owner to a Session's Sidecar
    /// Returns true if owner was added, false if session doesn't exist
    /// Reserved for future use (e.g., explicit owner management)
    #[allow(dead_code)]
    pub fn add_session_owner(&mut self, session_id: &str, owner: SidecarOwner) -> bool {
        if let Some(sidecar) = self.sidecars.get_mut(session_id) {
            ulog_info!(
                "[sidecar] Adding owner {:?} to session {} (port {})",
                owner, session_id, sidecar.port
            );
            sidecar.add_owner(owner);
            true
        } else {
            false
        }
    }

    /// Remove an owner from a Session's Sidecar
    /// If this was the last owner, the Sidecar is removed (and killed via Drop)
    /// Returns (was_removed, sidecar_was_stopped)
    pub fn remove_session_owner(&mut self, session_id: &str, owner: &SidecarOwner) -> (bool, bool) {
        let should_stop = if let Some(sidecar) = self.sidecars.get_mut(session_id) {
            ulog_info!(
                "[sidecar] Removing owner {:?} from session {} (port {})",
                owner, session_id, sidecar.port
            );
            sidecar.remove_owner(owner) // Returns true if this was the last owner
        } else {
            return (false, false);
        };

        if should_stop {
            ulog_info!(
                "[sidecar] Last owner removed from session {}, stopping Sidecar",
                session_id
            );
            self.remove_sidecar(session_id);
            (true, true)
        } else {
            (true, false)
        }
    }

    /// Upgrade a session ID (e.g., from "pending-xxx" to real session ID)
    /// This updates the key in both sidecars and session_activations HashMaps
    /// without stopping the Sidecar.
    ///
    /// Returns true if the upgrade was successful.
    pub fn upgrade_session_id(&mut self, old_session_id: &str, new_session_id: &str) -> bool {
        ulog_info!(
            "[sidecar] Upgrading session ID: {} -> {}",
            old_session_id, new_session_id
        );

        let mut upgraded = false;

        // 1. Upgrade in sidecars HashMap
        // NOTE: Direct HashMap access (not insert_sidecar/remove_sidecar) because this is
        // a key rename, not a creation. Generation is migrated separately in step 2.
        if let Some(mut sidecar) = self.sidecars.remove(old_session_id) {
            // Update the session_id field in the sidecar itself
            sidecar.session_id = new_session_id.to_string();
            self.sidecars.insert(new_session_id.to_string(), sidecar);
            ulog_info!(
                "[sidecar] Upgraded sidecars HashMap: {} -> {}",
                old_session_id, new_session_id
            );
            upgraded = true;
        }

        // 2. Migrate generation counter
        if let Some(gen) = self.sidecar_generations.remove(old_session_id) {
            self.sidecar_generations.insert(new_session_id.to_string(), gen);
        }

        // Note: deliberately NOT broadcasting a stop event for
        // (old_session_id, generation) here, even though the manager's key
        // has rotated. An earlier iteration did broadcast and Codex r4
        // caught the race: Message B may have already reused the OLD
        // ImConsumerHandle and registered an in-flight ReplySlot before the
        // upgrade (Message A's terminal triggered it); cancelling the old
        // entry mid-flight strands B's slot in a router whose consumer was
        // just terminated.
        //
        // The correctness invariant is upheld instead via
        // `ensure_im_consumer`'s reuse-path `is_live` check: the next message
        // (post-upgrade) sees `is_live(old_sid, gen) == false`, falls through
        // to cancel + respawn against new_session_id. In-flight slots on the
        // old entry continue draining naturally — the underlying sidecar
        // process is alive, SSE keeps flowing, terminal events still reach
        // the old router. After all slots terminate, the next ensure_im_consumer
        // call replaces the entry. No leak, no premature cancellation.

        // 3. Upgrade in session_activations HashMap
        if let Some(mut activation) = self.session_activations.remove(old_session_id) {
            // Update the session_id field in the activation itself
            activation.session_id = new_session_id.to_string();
            self.session_activations.insert(new_session_id.to_string(), activation);
            ulog_info!(
                "[sidecar] Upgraded session_activations HashMap: {} -> {}",
                old_session_id, new_session_id
            );
            upgraded = true;
        }

        if !upgraded {
            ulog_debug!(
                "[sidecar] No entries found for session {} to upgrade",
                old_session_id
            );
        }

        upgraded
    }

    /// Check if a session's Sidecar has persistent background owners (CronTask or Agent)
    /// that will keep it alive after a Tab releases its ownership.
    pub fn session_has_persistent_owners(&self, session_id: &str) -> bool {
        self.sidecars
            .get(session_id)
            .map(|s| s.owners.iter().any(|o| matches!(o, SidecarOwner::CronTask(_) | SidecarOwner::Agent(_))))
            .unwrap_or(false)
    }

}

impl Default for SidecarManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Ensure all processes are killed when manager is dropped
impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.stop_all();
    }
}

/// Thread-safe managed state wrapper
pub type ManagedSidecarManager = Arc<Mutex<SidecarManager>>;

/// Create a new managed sidecar manager
pub fn create_sidecar_manager() -> ManagedSidecarManager {
    Arc::new(Mutex::new(SidecarManager::new()))
}



/// Legacy managed sidecar type alias
pub type ManagedSidecar = ManagedSidecarManager;

/// Legacy function: create_sidecar_state -> create_sidecar_manager
pub fn create_sidecar_state() -> ManagedSidecar {
    create_sidecar_manager()
}


// ============= Core Functions =============

/// Kill a child process (non-blocking)
///
/// - Unix: sends SIGTERM, then spawns a background thread to wait for graceful
///   shutdown and escalate to SIGKILL if the process doesn't exit in time.
/// - Windows: uses `taskkill /T /F` to kill the entire process tree
///   (including SDK subprocess and MCP servers). Spawned WITHOUT waiting
///   (2026-08-06 audit F-09): `.output()` blocked the caller on taskkill's
///   exit, and the main call chain (Drop → remove_sidecar → sync
///   cmd_release_session_sidecar) runs on the main thread — a wedged taskkill
///   froze the whole WebView.
///
/// Returns immediately, making it suitable for use in Drop implementations.
fn kill_process(child: &mut Child) -> std::io::Result<()> {
    let pid = child.id();

    #[cfg(unix)]
    {
        // Kill the entire process group (negative PID) so SDK CLI + MCP servers are also signaled
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    {
        // taskkill /T kills the entire process tree (including SDK subprocess and MCP servers)
        // taskkill /F forces termination
        // process_cmd::new applies CREATE_NO_WINDOW automatically, replacing
        // the previous manual creation_flags() call.
        // Fire-and-forget: taskkill /T /F does its own tree walk; we must not
        // wait for it here (main-thread call chain — see fn doc). If taskkill
        // itself cannot even start, fall back to child.kill().
        let result = crate::process_cmd::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .spawn();
        if result.is_err() {
            // taskkill command not available, fallback
            let _ = child.kill();
        }
    }

    // Spawn a background thread to wait for graceful shutdown
    // This ensures we don't block the caller (important for UI responsiveness)
    // The thread will force kill if the process doesn't exit within timeout
    std::thread::spawn(move || {
        #[cfg(windows)]
        {
            // taskkill /T /F was spawned fire-and-forget; no background
            // polling needed on Windows
            let _ = pid; // suppress unused variable
        }

        #[cfg(unix)]
        {
            let timeout = Duration::from_secs(GRACEFUL_SHUTDOWN_TIMEOUT_SECS);
            let start = std::time::Instant::now();

            loop {
                // Use waitpid with WNOHANG to check without blocking
                let mut status: i32 = 0;
                let result = unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) };

                if result > 0 {
                    // Direct child exited; give group members a brief grace period then SIGKILL the group
                    ulog_debug!("[sidecar] Process {} exited gracefully, cleaning up process group", pid);
                    std::thread::sleep(Duration::from_millis(500));
                    unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
                    return;
                } else if result < 0 {
                    // Error (process might already be gone)
                    ulog_debug!("[sidecar] Process {} already gone or error", pid);
                    return;
                }
                // result == 0 means process still running

                if start.elapsed() > timeout {
                    ulog_warn!("[sidecar] Process {} didn't exit after SIGTERM, force killing process group", pid);
                    unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
                    return;
                }

                thread::sleep(Duration::from_millis(50));
            }
        }
    });

    Ok(())
}

/// Check if a port is available
fn is_port_available(port: u16) -> bool {
    std::net::TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok()
}

/// Normalize a path for use with external processes.
///
/// On Windows, Tauri's `resource_dir()` and Rust's `current_exe()` / `canonicalize()`
/// return paths with the `\\?\` extended-length prefix. Most external tools (Bun, Node,
/// npm) cannot handle this prefix — they silently hang or fail.
///
/// This function strips the prefix on Windows; on other platforms it's a no-op.
pub(crate) fn normalize_external_path(path: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = path.to_string_lossy();
        if let Some(stripped) = s.strip_prefix("\\\\?\\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

/// Diagnose why Node executable was not found and return a user-friendly error message.
fn diagnose_node_not_found<R: Runtime>(app_handle: &AppHandle<R>) -> String {
    let mut details = Vec::new();

    match app_handle.path().resource_dir() {
        Ok(resource_dir) => {
            details.push(format!("resource_dir: {:?}", resource_dir));
            let expected = node_path_in_resources(&resource_dir);
            if !expected.exists() {
                details.push(format!(
                    "bundled Node.js missing at {:?} — build scripts may not have run scripts/download_nodejs.sh",
                    expected
                ));
            }
        }
        Err(e) => {
            details.push(format!("resource_dir() failed: {}", e));
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        details.push(format!("current_exe: {:?}", exe_path));
    }

    let diag = details.join("; ");
    let msg = format!(
        "Node.js runtime not found. {} | \
         Possible causes: (1) Bundled Node not downloaded — run scripts/download_nodejs.sh. \
         (2) Antivirus quarantined node.exe on Windows — check Windows Security > Protection History. \
         (3) Installation is corrupted — try reinstalling. \
         Workaround: install Node.js manually from https://nodejs.org (v20+).",
        diag
    );
    ulog_error!("[sidecar] {}", msg);
    msg
}

/// Diagnose why bun process exited immediately and return a user-friendly error message.
fn diagnose_immediate_exit(status: &std::process::ExitStatus, node_path: &std::path::Path) -> String {
    let status_str = format!("{:?}", status);

    #[cfg(target_os = "windows")]
    {
        // On Windows, ExitStatus wraps the process exit code.
        // 0xc0000135 (STATUS_DLL_NOT_FOUND) = missing DLL (e.g., VCRUNTIME140.dll)
        // 0xc0000142 (STATUS_DLL_INIT_FAILED) = DLL initialization failed
        let code = status.code().unwrap_or(0) as u32;
        let hint = match code {
            0xc0000135 => {
                "Missing system DLL (likely VCRUNTIME140.dll). \
                 Please install Visual C++ Redistributable: \
                 https://aka.ms/vs/17/release/vc_redist.x64.exe"
            }
            0xc0000142 => {
                "DLL initialization failed. \
                 Please install Visual C++ Redistributable: \
                 https://aka.ms/vs/17/release/vc_redist.x64.exe"
            }
            0xc0000005 => {
                "STATUS_ACCESS_VIOLATION — bundled bun.exe may require AVX2 instructions \
                 (unsupported in many virtual machines and older CPUs). \
                 Install bun globally via: powershell -c \"irm bun.sh/install.ps1 | iex\" \
                 (or: npm install -g bun). Both auto-select a compatible baseline build. \
                 The app will fall back to the system-installed bun on the next attempt."
            }
            0xc0000022 => {
                "Access denied — antivirus may be blocking bun.exe. \
                 Check Windows Security > Protection History, or add the install directory to exclusions."
            }
            1 => {
                "Node exited with code 1. Check if Git for Windows is installed \
                 (required by Claude Agent SDK): https://git-scm.com/downloads/win"
            }
            _ => "",
        };

        let msg = if hint.is_empty() {
            format!(
                "Node process exited immediately (status: {}, code: 0x{:08x}). node_path: {:?}",
                status_str, code, node_path
            )
        } else {
            format!(
                "Node process exited immediately (status: {}, code: 0x{:08x}). {} | node_path: {:?}",
                status_str, code, hint, node_path
            )
        };
        ulog_error!("[sidecar] {}", msg);
        msg
    }

    #[cfg(not(target_os = "windows"))]
    {
        let msg = format!(
            "Node process exited immediately with status: {}. node_path: {:?}",
            status_str, node_path
        );
        ulog_error!("[sidecar] {}", msg);
        msg
    }
}

/// Find the Node.js executable path.
/// Returns a normalized path safe for `Command::new()` (no `\\?\` prefix on Windows).
fn find_node_executable<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    find_node_executable_inner(app_handle).map(normalize_external_path)
}

/// Build the canonical Node.js path relative to a given resources directory.
/// macOS/Linux: <resources>/nodejs/bin/node
/// Windows:     <resources>\nodejs\node.exe
fn node_path_in_resources(resources: &std::path::Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        resources.join("nodejs").join("node.exe")
    }
    #[cfg(not(target_os = "windows"))]
    {
        resources.join("nodejs").join("bin").join("node")
    }
}

fn find_node_executable_inner<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    // Bundled Node.js lives under resource_dir/nodejs/ (shipped by build_*.sh
    // via scripts/download_nodejs.sh). Unlike the prior Bun externalBin
    // flow, Node.js is a binary + lib directory combo that can't ride
    // Tauri's externalBin — it's a plain resource copy.
    match app_handle.path().resource_dir() {
        Ok(resource_dir) => {
            ulog_info!("[sidecar] resource_dir resolved to: {:?}", resource_dir);

            let bundled = node_path_in_resources(&resource_dir);
            if bundled.exists() {
                if is_node_crashed(&bundled) {
                    ulog_warn!("Skipping crashed bundled node: {:?}", bundled);
                } else {
                    ulog_info!("Using bundled node: {:?}", bundled);
                    return Some(bundled);
                }
            }
        }
        Err(e) => {
            ulog_warn!("[sidecar] resource_dir() failed: {}, will try exe-relative fallback", e);
        }
    }

    // Fallback: find node relative to the current executable (most reliable on Windows
    // installer layouts where resource_dir returns something unexpected).
    if let Ok(exe_path) = std::env::current_exe() {
        ulog_info!("[sidecar] current_exe: {:?}", exe_path);
        if let Some(exe_dir) = exe_path.parent() {
            #[cfg(target_os = "macos")]
            let layouts: [PathBuf; 2] = [
                // Inside the .app bundle: Contents/Resources/nodejs/bin/node
                exe_dir.parent().map(|p| p.join("Resources").join("nodejs").join("bin").join("node"))
                    .unwrap_or_else(|| exe_dir.join("Resources").join("nodejs").join("bin").join("node")),
                exe_dir.join("nodejs").join("bin").join("node"),
            ];
            #[cfg(target_os = "windows")]
            let layouts: [PathBuf; 2] = [
                exe_dir.join("resources").join("nodejs").join("node.exe"),
                exe_dir.join("nodejs").join("node.exe"),
            ];
            #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
            let layouts: [PathBuf; 2] = [
                exe_dir.join("resources").join("nodejs").join("bin").join("node"),
                exe_dir.join("nodejs").join("bin").join("node"),
            ];

            for candidate in &layouts {
                if candidate.exists() {
                    ulog_info!("Using bundled node (exe-relative): {:?}", candidate);
                    return Some(candidate.clone());
                }
            }
        }
    }

    // Last resort: system Node.js from PATH. Dev-mode fallback so `npm run dev` /
    // `./scripts/dev/start_dev.sh` works on machines where bundled Node hasn't been downloaded yet.
    #[cfg(target_os = "windows")]
    {
        if let Some(path) = crate::system_binary::find("node.exe")
            .or_else(|| crate::system_binary::find("node"))
        {
            ulog_info!("Using system node: {:?}", path);
            return Some(path);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(path) = crate::system_binary::find("node") {
            ulog_info!("Using system node: {:?}", path);
            return Some(path);
        }
    }

    ulog_error!("[sidecar] Node executable not found in any location. Checked: resource_dir, exe-relative, PATH");
    None
}

/// Find the server script path.
/// Returns a normalized path safe for `Command::new()` (no `\\?\` prefix on Windows).
fn find_server_script<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    find_server_script_inner(app_handle).map(normalize_external_path)
}

fn find_server_script_inner<R: Runtime>(_app_handle: &AppHandle<R>) -> Option<PathBuf> {
    // 1. First check for bundled server-dist.js (Production)
    // Modified: Only check bundled script in Release mode, so Dev mode uses source
    #[cfg(debug_assertions)]
    ulog_info!("[sidecar] Debug mode detected, SKIPPING bundled script check (forcing source usage)");

    #[cfg(not(debug_assertions))]
    {
        match _app_handle.path().resource_dir() {
            Ok(resource_dir) => {
                let bundled_script = resource_dir.join("server-dist.js");
                if bundled_script.exists() {
                    ulog_info!("Using bundled server script (bundled): {:?}", bundled_script);
                    return Some(bundled_script);
                }

                // Legacy check: Check for server/index.ts (Development / Legacy)
                let legacy_script = resource_dir.join("server").join("index.ts");
                if legacy_script.exists() {
                    ulog_info!("Using bundled server script (legacy): {:?}", legacy_script);
                    return Some(legacy_script);
                }
            }
            Err(e) => {
                ulog_warn!("[sidecar] resource_dir() failed for script search: {}", e);
            }
        }

        // Fallback: find server-dist.js relative to current executable
        #[cfg(target_os = "windows")]
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                let script = exe_dir.join("server-dist.js");
                if script.exists() {
                    ulog_info!("[sidecar] Using server script from exe_dir: {:?}", script);
                    return Some(script);
                }
            }
        }
    }

    if cfg!(debug_assertions) {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("src").join("server").join("index.ts"));

        if let Some(ref path) = dev_path {
            if path.exists() {
                ulog_info!("Using development server script: {:?}", path);
                return dev_path;
            }
        }

        if let Ok(cwd) = std::env::current_dir() {
            let cwd_path = cwd.join("src").join("server").join("index.ts");
            if cwd_path.exists() {
                ulog_info!("Using cwd server script: {:?}", cwd_path);
                return Some(cwd_path);
            }
        }
    }

    ulog_error!("[sidecar] Server script not found in any location");
    None
}

/// Wait for a new sidecar to become healthy using TCP-level check.
/// For initial startup, TCP check is sufficient and more reliable because:
/// - Bun starts listening on TCP port before HTTP handler is fully ready
/// - TCP check has been proven stable in production
///
/// Note: For REUSING an existing sidecar, use check_sidecar_http_health() instead
///
/// `alive_check`: optional closure that returns `true` if the sidecar process is still alive.
/// Checked every 20 iterations (~10s) to detect early crashes (e.g., AVX2 0xC0000005 on Windows
/// VMs where Windows Defender delays the crash by 20-30s, bypassing the 50ms early exit check).
fn wait_for_health(port: u16, alive_check: Option<Box<dyn Fn() -> bool>>) -> Result<(), String> {
    // Exponential backoff: 50, 100, 200, 400, 500, 500, 500, ... (cap).
    // See HEALTH_CHECK_DELAY_* constants for rationale.
    let delay_for = |attempt: u32| -> Duration {
        let ms = HEALTH_CHECK_DELAY_START_MS
            .saturating_mul(1u64 << attempt.saturating_sub(1).min(10))
            .min(HEALTH_CHECK_DELAY_CAP_MS);
        Duration::from_millis(ms)
    };

    for attempt in 1..=HEALTH_CHECK_MAX_ATTEMPTS {
        // Alive check: every 20 attempts in the slow-poll regime is ~10s. But
        // the early fast regime compresses 20 attempts to ~1.6s, still safe.
        // Catches crashes that happen after our initial try_wait (e.g. Windows
        // Defender holds node.exe for 20-30s then lets a crash happen).
        if attempt % 20 == 0 {
            if let Some(ref check) = alive_check {
                if !check() {
                    return Err(format!(
                        "Sidecar process exited during health check on port {} (detected at attempt {})",
                        port, attempt
                    ));
                }
            }
        }

        match std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            Duration::from_millis(HEALTH_CHECK_TIMEOUT_MS),
        ) {
            Ok(_) => {
                ulog_info!("[sidecar] TCP health check passed after {} attempts on port {}", attempt, port);
                return Ok(());
            }
            Err(_) => {
                if attempt < HEALTH_CHECK_MAX_ATTEMPTS {
                    thread::sleep(delay_for(attempt));
                }
            }
        }
    }

    Err(format!(
        "Sidecar failed TCP health check after {} attempts on port {}",
        HEALTH_CHECK_MAX_ATTEMPTS, port
    ))
}

/// Pattern 4: wait for /health/ready (deferred init complete) after /health/live
/// passes. Returns Ok if the sidecar reports ready within `timeout_secs`,
/// Err with the structured failure phase + error if it reports `failed`, or
/// Err with a timeout message otherwise.
///
/// Tolerates older sidecar builds (no /health/ready) by treating a 404 as
/// "ready" (best-effort backward compat — older sidecars used the bare /health
/// as both signals).
fn wait_for_readiness(port: u16, timeout_secs: u64) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/health/ready", port);
    let client = match crate::local_http::blocking_builder()
        .timeout(Duration::from_millis(2000))
        .build()
    {
        Ok(c) => c,
        Err(e) => return Err(format!("readiness client build failed: {}", e)),
    };

    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    let mut last_phase: Option<String> = None;
    while std::time::Instant::now() < deadline {
        match client.get(&url).send() {
            Ok(resp) => {
                let status = resp.status();
                if status == reqwest::StatusCode::NOT_FOUND {
                    // Older sidecar; treat as ready.
                    return Ok(());
                }
                if status.is_success() {
                    return Ok(());
                }
                // 503 — try to surface phase / error from the structured body.
                let body = resp.text().unwrap_or_default();
                if body.contains("\"state\":\"failed\"") {
                    return Err(format!("sidecar deferred init failed: {}", body));
                }
                // Track the most recent phase for the timeout error message.
                if let Some(start) = body.find("\"phase\":\"") {
                    let rest = &body[start + 9..];
                    if let Some(end) = rest.find('"') {
                        last_phase = Some(rest[..end].to_string());
                    }
                }
            }
            Err(_) => {
                // Sidecar not yet listening, or transient error — try again.
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let phase_part = last_phase.map(|p| format!(" (last phase: {})", p)).unwrap_or_default();
    Err(format!("sidecar /health/ready timed out after {}s{}", timeout_secs, phase_part))
}

/// Quick HTTP health check for existing sidecar (non-blocking style with short timeout)
/// Returns true if the sidecar HTTP server is responsive
fn check_sidecar_http_health(port: u16) -> bool {
    let health_url = format!("http://127.0.0.1:{}/health", port);

    // Short timeout for quick check - sidecar should respond immediately if healthy
    let client = match crate::local_http::blocking_builder()
        .timeout(Duration::from_millis(HTTP_HEALTH_CHECK_TIMEOUT_MS))
        .build() {
        Ok(c) => c,
        Err(_) => return false,
    };

    match client.get(&health_url).send() {
        Ok(response) => response.status().is_success(),
        Err(e) => {
            ulog_warn!("[sidecar] HTTP health check failed on port {}: {}", port, e);
            false
        }
    }
}

// ============= Tab-based Multi-instance Commands =============

/// Start a Sidecar for a specific Tab
/// Each Tab gets its own dedicated Sidecar (1:1 relationship)
pub fn start_tab_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    tab_id: &str,
    agent_dir: Option<PathBuf>,
) -> Result<u16, String> {
    // Ensure file descriptor limit is high enough for Bun
    ensure_high_file_descriptor_limit();

    // Block briefly if startup cleanup is still running — spawning a new
    // sidecar before stale ones are killed would race on ports. In the
    // common case this returns immediately (cleanup finishes in ~50 ms).
    // 15 s is a generous upper bound; the new sysinfo-based cleanup is
    // bounded internally at ~3 s even with laggy processes.
    wait_for_startup_cleanup(Duration::from_secs(15));

    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    // Check if already running for this tab
    if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
        if instance.is_running() {
            ulog_info!("[sidecar] Tab {} already has running instance on port {}", tab_id, instance.port);
            return Ok(instance.port);
        }
    }

    // Remove stale instance if exists
    manager_guard.remove_instance(tab_id);

    // Find executables
    let node_path = find_node_executable(app_handle)
        .ok_or_else(|| diagnose_node_not_found(app_handle))?;
    let script_path = find_server_script(app_handle)
        .ok_or_else(|| "Server script not found".to_string())?;

    // Allocate port
    let port = manager_guard.allocate_port()?;

    ulog_info!(
        "[sidecar] Starting for tab {} on port {}, agent_dir: {:?}",
        tab_id, port, agent_dir
    );

    // Build command — node directly executes server-dist.js (esbuild output).
    // In debug mode (.ts source) we inject tsx's ESM loader so TypeScript is
    // transpiled on the fly. Release builds load the pre-bundled .js and skip
    // the loader, keeping startup lean.
    // SIDECAR_MARKER tails every argv for reliable process identification.
    let mut cmd = crate::process_cmd::new(&node_path);
    if script_path.extension().and_then(|s| s.to_str()) == Some("ts") {
        cmd.arg("--import").arg("tsx/esm");
    }
    cmd.arg(&script_path)
        .arg("--port")
        .arg(port.to_string())
        .arg(SIDECAR_MARKER);

    // Determine if this is a global sidecar and handle agent directory
    let is_global = agent_dir.is_none();
    if is_global {
        cmd.arg("--no-pre-warm");
    }
    let effective_agent_dir = if let Some(ref dir) = agent_dir {
        cmd.arg("--agent-dir").arg(dir);
        Some(dir.clone())
    } else {
        // Global sidecar: use temp directory
        let temp_dir = std::env::temp_dir().join(format!("zhishi-global-{}", std::process::id()));
        ulog_info!("[sidecar] Creating temp agent directory: {:?}", temp_dir);

        // Create directory and fail early if unable to create
        std::fs::create_dir_all(&temp_dir).map_err(|e| {
            let err = format!(
                "[sidecar] Failed to create temp directory {:?}: {}. \
                 Check permissions on TEMP directory ({}). \
                 This directory is required for Global Sidecar to store runtime data.",
                temp_dir, e, std::env::temp_dir().display()
            );
            ulog_error!("{}", err);
            err
        })?;

        cmd.arg("--agent-dir").arg(&temp_dir);
        Some(temp_dir)
    };

    // Set working directory to script's parent directory
    // This is crucial for bun to find relative imports
    if let Some(script_dir) = script_path.parent() {
        cmd.current_dir(script_dir);
        ulog_info!("[sidecar] Working directory set to: {:?}", script_dir);
    }

    // Apply proxy policy: user proxy / inherit system / protect localhost (pit-of-success)
    proxy_config::apply_to_subprocess(&mut cmd);

    // Inject management API port for Bun→Rust IPC (v0.1.21)
    let mgmt_port = crate::management_api::get_management_port();
    if mgmt_port > 0 {
        cmd.env("ZHISHI_MANAGEMENT_PORT", mgmt_port.to_string());
    }

    // Inject runtime type for Agent Runtime selection (v0.1.59)
    // This path is used by start_sidecar (generic, IM/Agent channels).
    // Session sidecars created via ensure_session_sidecar use resolve_session_runtime()
    // for authoritative per-session runtime. This fallback uses agent config for cases
    // without a session_id (global sidecar, IM initial start).
    if !is_global {
        if let Some(ref dir) = agent_dir {
            if let Some(runtime) = resolve_agent_runtime_from_config(dir) {
                cmd.env("ZHISHI_RUNTIME", &runtime);
            }
        }
    }

    // Inject data directory so the Node.js sidecar resolves the same path
    // as the Rust process (critical for USB portable mode).
    if let Some(data_dir) = crate::app_dirs::zhishi_data_dir() {
        cmd.env("ZHISHI_DATA_DIR", data_dir.to_string_lossy().as_ref());
    }

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    // Windows: CREATE_NO_WINDOW already applied by process_cmd::new()

    // Unix: Make child a process group leader so kill(-PGID) kills the entire tree
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    // 关键诊断日志：打印当前可执行文件路径，确认运行的是正确版本
    ulog_info!("[sidecar] current_exe = {:?}", std::env::current_exe().ok());

    ulog_info!(
        "[sidecar] Spawning: bun={:?}, script={:?}, port={}, is_global={}",
        node_path, script_path, port, is_global
    );

    // Spawn
    let mut child = cmd.spawn().map_err(|e| {
        ulog_error!("[sidecar] Failed to spawn: {}", e);
        format!("Failed to spawn sidecar: {}", e)
    })?;

    ulog_info!("[sidecar] Process spawned with pid: {:?}", child.id());

    // 启动线程捕获 stdout → 写入统一日志（确保 Bun 输出在 unified log 可见）
    if let Some(stdout) = child.stdout.take() {
        let tab_id_clone = tab_id.to_string();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut bun_logger_active = false;
            for line in reader.lines().map_while(Result::ok) {
                if !bun_logger_active {
                    if line.contains("[Logger] Unified logging initialized") {
                        bun_logger_active = true;
                    }
                    ulog_info!("[bun-out][{}] {}", tab_id_clone, line);
                }
            }
        });
    }

    // 启动线程捕获 stderr → 写入统一日志。
    //
    // 不是所有 sidecar stderr 都是 ERROR：Node.js 的 `console.warn` /
    // 直接 `process.stderr.write` 在 sidecar 里有几处合法的 informational
    // 用法，盲目标 ERROR 会让 unified log 出现假阳性（grep ERROR 拿到无关
    // 噪音）。识别已知 informational/warn 前缀，按真实严重度落级。
    if let Some(stderr) = child.stderr.take() {
        let tab_id_clone = tab_id.to_string();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                match classify_sidecar_stderr(&line) {
                    SidecarStderrLevel::Info =>
                        ulog_info!("[bun-err][{}] {}", tab_id_clone, line),
                    SidecarStderrLevel::Warn =>
                        ulog_warn!("[bun-err][{}] {}", tab_id_clone, line),
                    SidecarStderrLevel::Error =>
                        ulog_error!("[bun-err][{}] {}", tab_id_clone, line),
                }
            }
        });
    }

    // Check if the process already exited. `try_wait()` is a non-blocking
    // poll — if the OS hasn't reaped the child yet, returns Ok(None). We no
    // longer pre-sleep 50ms here; the health-loop's alive_check (every 20
    // attempts) catches any crash that escapes this initial probe.
    if let Ok(Some(status)) = child.try_wait() {
        // Crash detected — give the stderr reader a brief window to flush.
        thread::sleep(Duration::from_millis(100));
        ulog_error!("[sidecar] Process exited immediately with status: {:?}", status);
        #[cfg(target_os = "windows")]
        maybe_mark_crashed_node(&status, &node_path);
        let diag = diagnose_immediate_exit(&status, &node_path);
        return Err(diag);
    }

    // Create instance (not yet healthy)
    let instance = SidecarInstance {
        process: child,
        port,
        agent_dir: effective_agent_dir,
        healthy: false,
        is_global,
        created_at: std::time::Instant::now(),
    };

    manager_guard.insert_instance(tab_id.to_string(), instance);

    // Drop lock before waiting for health
    drop(manager_guard);

    // Build liveness check closure — detects process death during health check.
    // Critical for Windows VMs where Defender delays bun.exe execution by 20-30s,
    // causing the crash to happen well after the 50ms early exit check above.
    //
    // Also detects instance replacement: if the health monitor restarts the sidecar
    // while we're waiting, the old port is dead and a new instance sits at a different
    // port under the same tab_id. Checking `instance.port == expected_port` prevents
    // this closure from silently accepting the replacement and looping forever on a
    // dead port.
    let liveness_manager = manager.clone();
    let liveness_tab_id = tab_id.to_string();
    let expected_port = port;
    let alive_check: Box<dyn Fn() -> bool> = Box::new(move || {
        if let Ok(mut guard) = liveness_manager.lock() {
            if let Some(instance) = guard.get_instance_mut(&liveness_tab_id) {
                // Reject if the instance was replaced (different port = different process)
                if instance.port != expected_port {
                    return false;
                }
                matches!(instance.process.try_wait(), Ok(None))
            } else {
                false
            }
        } else {
            true // can't acquire lock, assume alive
        }
    });

    // Wait for health
    match wait_for_health(port, Some(alive_check)) {
        Ok(()) => {
            // Mark as healthy
            let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
            if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
                instance.healthy = true;
            }
            Ok(port)
        }
        Err(e) => {
            // Health check failed — diagnostics go to unified log directly
            ulog_error!("[sidecar] Health check failed: {}", e);
            let mut diag = e.clone();

            let mut manager_guard = manager.lock().map_err(|_| e.clone())?;
            if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
                match instance.process.try_wait() {
                    Ok(Some(status)) => {
                        #[cfg(target_os = "windows")]
                        maybe_mark_crashed_node(&status, &node_path);
                        let detail = format!(" | process exited: {:?}", status);
                        ulog_error!("[sidecar]{}", detail);
                        diag.push_str(&detail);
                    }
                    Ok(None) => {
                        let detail = " | process alive but not listening. \
                            Possible causes: antivirus slow-scanning bun.exe, or port conflict";
                        ulog_error!("[sidecar]{}", detail);
                        diag.push_str(detail);
                    }
                    Err(wait_err) => {
                        let detail = format!(" | try_wait error: {}", wait_err);
                        ulog_error!("[sidecar]{}", detail);
                        diag.push_str(&detail);
                    }
                }

                // Note: stderr is already captured by the drain thread → ulog_error!
                // No need to .take() here (it was already taken at spawn time)
            }

            // Remove the failed instance
            manager_guard.remove_instance(tab_id);

            Err(diag)
        }
    }
}




/// Start the global sidecar (for Settings page)
pub fn start_global_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
) -> Result<u16, String> {
    let port = start_tab_sidecar(app_handle, manager, GLOBAL_SIDECAR_ID, None)?;
    // Write port file so the CLI can discover the running sidecar
    write_global_port_file(port);
    Ok(port)
}

/// Check Global Sidecar status.
/// Returns:
/// - None: sidecar was never started (no instance in manager) → skip
/// - Some((port, true, created_at)):  process alive → do HTTP health check (if past grace)
/// - Some((port, false, created_at)): process dead → needs restart immediately
fn check_global_sidecar_status(manager: &ManagedSidecarManager) -> Option<(u16, bool, std::time::Instant)> {
    let mut guard = manager.lock().ok()?;
    let instance = guard.get_instance_mut(GLOBAL_SIDECAR_ID)?;
    let created_at = instance.created_at;
    Some((instance.port, instance.is_running(), created_at))
}

/// How often to poll session-state for the turn wake-lock. Idle sleep triggers
/// after minutes of no user input, so a 10s poll asserts the lock long before
/// the OS can sleep and drop the SDK's HTTPS stream.
const WAKE_LOCK_POLL_INTERVAL_SECS: u64 = 10;

/// Holds a single process-wide system wake-lock (prevents idle sleep) while ANY
/// managed sidecar has an in-flight AI turn (session-state `running`/`starting`).
///
/// WHY: the SDK keeps a long-lived HTTPS stream to the model API; if the host
/// idle-sleeps mid-turn that socket dies and the SDK never notices, so the turn
/// stalls (and historically the 10-min watchdog then killed it). Cron already
/// held a wake-lock per execution (`cron_task.rs`); interactive turns did not —
/// so "walk away during a long task" let the Mac sleep and lose the turn. This
/// generalizes the protection to every turn type by reading the same
/// `/api/session-state` the background-completion poller already uses.
///
/// One assertion is enough system-wide, so we hold/release a single RAII
/// `WakeLock` based on whether any sidecar is currently active. This complements
/// the suspension-aware inactivity watchdog: the wake-lock *prevents* idle sleep
/// during active turns; the watchdog handles the sleep we cannot prevent
/// (lid close / forced sleep) by not counting suspended time as inactivity.
pub async fn monitor_turn_wake_lock(
    manager: ManagedSidecarManager,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering::Relaxed;

    // RAII: dropping this releases the OS assertion (also on loop break / task drop).
    let mut wake_lock: Option<crate::wake_lock::WakeLock> = None;

    loop {
        tokio::time::sleep(Duration::from_secs(WAKE_LOCK_POLL_INTERVAL_SECS)).await;
        if shutdown.load(Relaxed) {
            break; // wake_lock drops here → assertion released
        }

        // Snapshot live sidecar ports under the lock; never hold the mutex
        // across the (blocking) HTTP poll below.
        let ports: Vec<u16> = match manager.lock() {
            Ok(guard) => guard
                .sidecars
                .values()
                .filter(|sc| sc.is_reusable())
                .map(|sc| sc.port)
                .collect(),
            // A poisoned lock is permanent — if we kept `continue`-ing we'd hold
            // the wake-lock (block idle sleep) forever. Release it and retry.
            Err(_) => {
                wake_lock = None;
                continue;
            }
        };

        // Poll session-state off the async runtime (check_sidecar_session_state
        // is blocking). A dead/unreachable sidecar returns None → not active.
        let any_active = tokio::task::spawn_blocking(move || {
            ports.iter().any(|&port| {
                matches!(
                    check_sidecar_session_state(port).as_deref(),
                    Some("running") | Some("starting")
                )
            })
        })
        .await
        .unwrap_or(false);

        match (any_active, wake_lock.is_some()) {
            (true, false) => {
                wake_lock = crate::wake_lock::WakeLock::acquire("active AI turn")
                    .map_err(|e| {
                        ulog_warn!("[wake-lock] turn wake-lock acquire failed: {} — continuing without protection", e);
                        e
                    })
                    .ok();
                if wake_lock.is_some() {
                    ulog_debug!("[wake-lock] acquired — an AI turn is active");
                }
            }
            (false, true) => {
                wake_lock = None; // drop releases the OS assertion
                ulog_debug!("[wake-lock] released — no active AI turns");
            }
            _ => {}
        }
    }
}

/// How many CONSECUTIVE HTTP-health failures the global sidecar must rack up
/// (process still alive each time) before the monitor concludes it's truly
/// stuck and replaces it. #236: a single 2s health-check miss is not enough —
/// on Windows under Defender scanning / a momentary load spike / a brief OS
/// suspend the global sidecar's event loop can stall past the 2s budget while
/// being perfectly alive. Restarting on that single blip kills a healthy
/// global (the reporter saw it killed 6× in 76 minutes) and takes every
/// renderer consumer down with it. Requiring 2 consecutive failures (≈15s
/// apart) tolerates the transient stall while still recovering a genuinely
/// hung process within ~30s. A DEAD process is restarted immediately —
/// liveness is unambiguous, only HTTP-readiness is blip-prone.
const GLOBAL_HEALTH_FAIL_THRESHOLD: u32 = 2;

/// Pure restart decision for the global sidecar health monitor. Extracted so
/// the "don't kill on a single transient blip" rule (#236) is unit-testable
/// without standing up a real sidecar. Returns
/// `(needs_restart, next_consecutive_health_failures)`.
fn global_restart_decision(
    process_alive: bool,
    http_healthy: bool,
    prev_health_failures: u32,
    threshold: u32,
) -> (bool, u32) {
    if !process_alive {
        // Dead is unambiguous — restart now, reset the (HTTP-only) streak.
        return (true, 0);
    }
    if http_healthy {
        return (false, 0);
    }
    let failures = prev_health_failures.saturating_add(1);
    (failures >= threshold, failures)
}

#[cfg(test)]
mod global_restart_decision_tests {
    use super::global_restart_decision;

    const T: u32 = 2; // GLOBAL_HEALTH_FAIL_THRESHOLD in tests

    #[test]
    fn dead_process_restarts_immediately_and_resets_streak() {
        // Even with a prior streak, a dead process restarts now.
        assert_eq!(global_restart_decision(false, false, 1, T), (true, 0));
        assert_eq!(global_restart_decision(false, true, 0, T), (true, 0));
    }

    #[test]
    fn healthy_process_never_restarts_and_resets_streak() {
        assert_eq!(global_restart_decision(true, true, 1, T), (false, 0));
    }

    #[test]
    fn single_transient_blip_does_not_restart_a_live_sidecar() {
        // #236 core: alive + first HTTP miss → defer, just record the failure.
        assert_eq!(global_restart_decision(true, false, 0, T), (false, 1));
    }

    #[test]
    fn restarts_after_threshold_consecutive_blips() {
        // Second consecutive miss reaches the threshold → restart.
        assert_eq!(global_restart_decision(true, false, 1, T), (true, 2));
    }

    #[test]
    fn a_healthy_probe_between_blips_breaks_the_streak() {
        let (_, after_first) = global_restart_decision(true, false, 0, T);
        assert_eq!(after_first, 1);
        let (restart, after_recover) = global_restart_decision(true, true, after_first, T);
        assert_eq!((restart, after_recover), (false, 0));
        // Next blip starts the count over, so one more blip alone won't restart.
        assert_eq!(global_restart_decision(true, false, after_recover, T), (false, 1));
    }
}

/// Background health monitor for the Global Sidecar.
/// Periodically checks if the Global Sidecar is alive and auto-restarts it when it dies.
/// Emits `global-sidecar:restarted` Tauri event with the new URL on successful restart.
pub async fn monitor_global_sidecar(
    app_handle: AppHandle,
    manager: ManagedSidecarManager,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering::Relaxed;
    use crate::logger;

    const CHECK_INTERVAL_SECS: u64 = 15;
    const MAX_RESTART_FAILURES: u32 = 5;
    const MAX_BACKOFF_SECS: u64 = 300; // 5 minutes

    let mut consecutive_restart_failures: u32 = 0;
    // #236: consecutive HTTP-health misses while the process is still alive.
    // Reset on a healthy probe or a dead process; a restart only fires once it
    // reaches GLOBAL_HEALTH_FAIL_THRESHOLD.
    let mut consecutive_health_failures: u32 = 0;
    let mut is_first_check = true;

    logger::info(&app_handle, "[sidecar] Global sidecar health monitor started".to_string());

    loop {
        // First iteration: short delay (let Global Sidecar start up)
        // Subsequent iterations: normal interval or backoff on restart failures
        if is_first_check {
            is_first_check = false;
            tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
        } else if consecutive_restart_failures > 0 {
            // Exponential backoff: 30s, 60s, 120s, 240s, 300s, 300s, ...
            let backoff = std::cmp::min(
                CHECK_INTERVAL_SECS.saturating_mul(2u64.saturating_pow(consecutive_restart_failures)),
                MAX_BACKOFF_SECS,
            );
            tokio::time::sleep(Duration::from_secs(backoff)).await;
        } else {
            tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
        }

        if shutdown.load(Relaxed) {
            logger::info(&app_handle, "[sidecar] Global sidecar monitor stopping (app shutdown)".to_string());
            break;
        }

        // Check process status (cheap, no HTTP)
        let (port, process_alive, created_at) = match check_global_sidecar_status(&manager) {
            Some(status) => status,
            None => {
                // No instance to watch — drop any stale health-failure streak so
                // a future instance starts clean (Codex review hardening, #236).
                consecutive_health_failures = 0;
                continue;
            }
        };

        // Startup grace period: skip health checks for recently-created instances.
        // During startup the sidecar may be busy with TCP check, Bun init, Plugin Bridge
        // loading, etc. — an aggressive health check during this window false-fires and
        // triggers an unnecessary restart that cascades into frontend timeout (#58).
        let age = created_at.elapsed();
        if age < Duration::from_secs(STARTUP_GRACE_SECS) {
            if !process_alive {
                // Process died during startup — still worth restarting, but log clearly
                ulog_warn!(
                    "[sidecar] Global sidecar on port {} died during startup (age {:?}), restarting",
                    port, age
                );
                // Fall through to restart below
            } else {
                // Within grace period and process alive — skip check. A freshly
                // created instance hasn't earned any failures yet; clear the
                // streak so grace doesn't carry one over (Codex review, #236).
                consecutive_health_failures = 0;
                continue;
            }
        }

        let http_healthy = if process_alive {
            // Process alive → verify with HTTP health check (blocking)
            tokio::task::spawn_blocking(move || check_sidecar_http_health(port))
                .await
                .unwrap_or(false)
        } else {
            false
        };

        // #236: don't restart a still-alive global on a single transient HTTP
        // blip — require GLOBAL_HEALTH_FAIL_THRESHOLD consecutive misses.
        let (needs_restart, next_failures) = global_restart_decision(
            process_alive,
            http_healthy,
            consecutive_health_failures,
            GLOBAL_HEALTH_FAIL_THRESHOLD,
        );
        consecutive_health_failures = next_failures;

        if process_alive && !http_healthy && !needs_restart {
            ulog_warn!(
                "[sidecar] Global sidecar on port {} HTTP health check failed ({}/{}) — alive, deferring restart (transient blip guard)",
                port, consecutive_health_failures, GLOBAL_HEALTH_FAIL_THRESHOLD
            );
        }

        if !needs_restart || shutdown.load(Relaxed) {
            // Healthy (or under the blip threshold) — reset restart-failure counter.
            consecutive_restart_failures = 0;
            continue;
        }

        ulog_warn!(
            "[sidecar] Global sidecar on port {} is unhealthy (alive={}, health_failures={}), auto-restarting...",
            port, process_alive, consecutive_health_failures
        );

        // Mark the existing instance as unhealthy so start_global_sidecar() won't
        // short-circuit with "already running". Without this, a hung process (alive
        // but not responding to HTTP) would never be replaced — is_running() checks
        // the healthy flag first, and start_tab_sidecar returns the old port.
        {
            if let Ok(mut guard) = manager.lock() {
                if let Some(instance) = guard.get_instance_mut(GLOBAL_SIDECAR_ID) {
                    instance.healthy = false;
                }
            }
        }

        let app_clone = app_handle.clone();
        let mgr_clone = manager.clone();
        match tokio::task::spawn_blocking(move || {
            start_global_sidecar(&app_clone, &mgr_clone)
        })
        .await
        {
            Ok(Ok(new_port)) => {
                consecutive_restart_failures = 0;
                consecutive_health_failures = 0; // fresh process — clear the blip streak
                let new_url = format!("http://127.0.0.1:{}", new_port);
                logger::info(
                    &app_handle,
                    format!("[sidecar] Global sidecar auto-restarted on port {} ({})", new_port, new_url),
                );
                let _ = app_handle.emit("global-sidecar:restarted", &new_url);
            }
            Ok(Err(e)) => {
                consecutive_restart_failures += 1;
                if consecutive_restart_failures >= MAX_RESTART_FAILURES {
                    ulog_error!("[sidecar] Failed to auto-restart global sidecar ({} consecutive failures, backing off): {}", consecutive_restart_failures, e);
                } else {
                    ulog_error!("[sidecar] Failed to auto-restart global sidecar (attempt {}): {}", consecutive_restart_failures, e);
                }
            }
            Err(e) => {
                consecutive_restart_failures += 1;
                ulog_error!("[sidecar] spawn_blocking failed during global sidecar restart: {}", e);
            }
        }
    }
}

/// Forward `terminal_events` from `SidecarManager` to the renderer as the
/// `session:sidecar-terminal` Tauri event. Lets the renderer drop stale
/// `tab.sessionId` bindings the moment the underlying session is gone for good
/// (no auto-restart will fire because no owners remained at removal). Without
/// this bridge, a Tab that lost its sidecar via voluntary release silently
/// keeps `sessionId` set; the next time the user clicks that session in the
/// task center, `planSessionOpen` matches the stale Tab and "jumps" to a tab
/// whose sidecar has been gone for hours — empty UI + flood of "no running
/// sidecar" errors. (See unified-2026-05-02.log around 22:49:48 for the
/// reference trace.)
///
/// `Lagged` recovery: capacity is 64, normally plenty. On a burst (e.g.
/// shutdown / `cmd_stop_all`) we may drop events. Emit a one-shot reconcile
/// payload carrying the *currently-live* session ids so the renderer can
/// clear any tab whose `sessionId` is not in that set — equivalent to the
/// IM module's reconcile-against-`live_sidecar_set()` pattern.
pub async fn forward_terminal_events_to_renderer(
    app_handle: AppHandle,
    manager: ManagedSidecarManager,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering::Relaxed;

    let mut rx = match manager.lock() {
        Ok(g) => g.subscribe_terminal_events(),
        Err(e) => {
            ulog_error!(
                "[sidecar] terminal-event forwarder failed to subscribe: {}",
                e
            );
            return;
        }
    };

    ulog_info!("[sidecar] Terminal-event forwarder started");

    loop {
        if shutdown.load(Relaxed) {
            break;
        }
        match rx.recv().await {
            Ok((session_id, generation)) => {
                let _ = app_handle.emit(
                    "session:sidecar-terminal",
                    serde_json::json!({
                        "sessionId": session_id,
                        "generation": generation,
                    }),
                );
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                ulog_warn!(
                    "[sidecar] Terminal-event forwarder lagged by {} — emitting reconcile",
                    n
                );
                // On lock poison we cannot snapshot the live set safely.
                // Fall through with `Skip` (don't emit at all) rather than
                // emitting an empty list — an empty list would tell the
                // renderer "no sessions are live, clear every tab", which is
                // a destructive fallback exactly when our state is most
                // uncertain. The renderer's defensive `hasSessionSidecar` check
                // in `handleLaunchProject` jump-to-tab still saves the user
                // if they do click into a stale binding before our next
                // event arrives. (Codex review WARN-1.)
                let live: Option<Vec<String>> = match manager.lock() {
                    Ok(g) => Some(
                        g.live_sidecar_set()
                            .into_iter()
                            .map(|(sid, _)| sid)
                            .collect(),
                    ),
                    Err(e) => {
                        ulog_error!(
                            "[sidecar] Terminal-event reconcile skipped — manager lock poisoned: {}",
                            e
                        );
                        None
                    }
                };
                if let Some(live) = live {
                    let _ = app_handle.emit(
                        "session:sidecar-terminal-reconcile",
                        serde_json::json!({ "liveSessionIds": live }),
                    );
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                ulog_info!("[sidecar] Terminal-event forwarder channel closed");
                break;
            }
        }
    }
}

/// Monitor all session sidecars and auto-restart dead ones that still have owners.
/// Mirrors the `monitor_global_sidecar()` pattern with backoff tracking.
pub async fn monitor_session_sidecars(
    app_handle: AppHandle,
    manager: ManagedSidecarManager,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering::Relaxed;

    const CHECK_INTERVAL_SECS: u64 = 15;
    const MAX_RESTART_FAILURES: u32 = 5;

    // Initial delay: let app fully start before monitoring
    tokio::time::sleep(Duration::from_secs(20)).await;
    ulog_info!("[sidecar] Session sidecar health monitor started");

    // Recovery queue: preserves workspace + owners across failed restarts.
    // When ensure_session_sidecar fails, the dead entry is gone from sidecars
    // but we keep it here so the next cycle can retry.
    struct RecoveryEntry {
        workspace: std::path::PathBuf,
        owners: Vec<SidecarOwner>,
        /// Snapshot of the dead sidecar's `runtime` field (ZHISHI_RUNTIME env
        /// var that it was originally spawned with). Captured at the time the
        /// dead sidecar is detected so that auto-restart can pin the new
        /// sidecar to the same runtime regardless of which owner happens to
        /// come first in the `Vec<SidecarOwner>` ordering (owners is collected
        /// from a HashSet — iteration order is not deterministic). Without
        /// this, a session with both Agent and Tab owners could restart with
        /// the wrong runtime resolution branch (Agent → re-resolve from agent
        /// config; Tab/Cron → read session metadata), producing different
        /// runtimes across hash-random restarts. See cross-review Codex #2.
        runtime: Option<String>,
        failures: u32,
    }
    let mut recovery: HashMap<String, RecoveryEntry> = HashMap::new();

    loop {
        tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
        if shutdown.load(Relaxed) {
            break;
        }

        // Phase 1: Scan sidecars for newly dead sessions, merge into recovery queue
        {
            let mut guard = match manager.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            for (sid, sc) in guard.sidecars.iter_mut() {
                if sc.is_dead() && !sc.owners.is_empty() && !recovery.contains_key(sid) {
                    recovery.insert(sid.clone(), RecoveryEntry {
                        workspace: sc.workspace_path.clone(),
                        owners: sc.owners.iter().cloned().collect(),
                        runtime: sc.runtime.clone(),
                        failures: 0,
                    });
                }
            }
        }

        // Remove entries that recovered on their own (now healthy in sidecars)
        recovery.retain(|sid, _| {
            manager
                .lock()
                .map(|mut g| {
                    g.sidecars
                        .get_mut(sid)
                        .map(|sc| sc.is_dead())
                        .unwrap_or(true) // not in sidecars → keep in recovery
                })
                .unwrap_or(true)
        });

        if recovery.is_empty() {
            continue;
        }

        // Phase 2: Attempt restart for each entry in recovery queue
        let session_ids: Vec<String> = recovery.keys().cloned().collect();
        for session_id in session_ids {
            if shutdown.load(Relaxed) {
                break;
            }

            let entry = recovery.get(&session_id).unwrap();
            if entry.failures >= MAX_RESTART_FAILURES {
                continue;
            }

            // Remove dead entry from sidecars if still present (re-verify under lock)
            {
                let mut guard = match manager.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                if let Some(sc) = guard.sidecars.get_mut(&session_id) {
                    if !sc.is_dead() {
                        // Recovered on its own — remove from recovery
                        recovery.remove(&session_id);
                        continue;
                    }
                }
                guard.remove_sidecar(&session_id);
            }

            let first_owner = entry.owners[0].clone();
            let workspace = entry.workspace.clone();
            let owners_snapshot = entry.owners.clone();
            // Pin the restart to the same runtime the dead sidecar was running
            // with. `ensure_session_sidecar` would otherwise re-resolve runtime
            // via an owner-type branch (Agent → agent config; Tab/Cron → session
            // meta → agent fallback), and since `owners[0]` is picked from a
            // HashSet the owner type is non-deterministic when a session has
            // mixed owners. See cross-review Codex #2.
            let pinned_runtime = entry.runtime.clone();
            let mgr = manager.clone();
            let app = app_handle.clone();
            let sid = session_id.clone();

            match tokio::task::spawn_blocking(move || {
                ensure_session_sidecar_with_runtime_override(
                    &app, &mgr, &sid, &workspace, first_owner, pinned_runtime,
                )
            })
            .await
            {
                Ok(Ok(result)) => {
                    if owners_snapshot.len() > 1 {
                        if let Ok(mut guard) = manager.lock() {
                            if let Some(sc) = guard.sidecars.get_mut(&session_id) {
                                for owner in owners_snapshot.iter().skip(1) {
                                    sc.add_owner(owner.clone());
                                }
                            }
                        }
                    }
                    recovery.remove(&session_id);
                    ulog_info!(
                        "[sidecar] Session {} auto-restarted on port {}",
                        session_id,
                        result.port
                    );
                    let _ = app_handle.emit(
                        "session-sidecar:restarted",
                        serde_json::json!({
                            "sessionId": session_id,
                            "port": result.port,
                        }),
                    );
                }
                Ok(Err(e)) => {
                    if let Some(entry) = recovery.get_mut(&session_id) {
                        entry.failures += 1;
                    }
                    ulog_error!(
                        "[sidecar] Failed to auto-restart session {}: {}",
                        session_id,
                        e
                    );
                }
                Err(e) => {
                    if let Some(entry) = recovery.get_mut(&session_id) {
                        entry.failures += 1;
                    }
                    ulog_error!(
                        "[sidecar] spawn_blocking failed for session {}: {}",
                        session_id,
                        e
                    );
                }
            }
        }
    }
}

// ============= Session-Centric Sidecar API (v0.1.11) =============

/// Result returned from ensure_session_sidecar
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureSidecarResult {
    pub port: u16,
    pub is_new: bool,
}

/// Ensure a Session has a Sidecar running, adding the specified owner.
/// If the Session already has a healthy Sidecar, just adds the owner.
/// If no Sidecar exists, creates a new one with the owner.
///
/// Returns (port, is_new) where is_new is true if a new Sidecar was started.
///
/// # WARNING: Blocking Function
/// This function uses `reqwest::blocking::Client` internally (via `check_sidecar_http_health`)
/// which uses `block_on()`. Calling this function from within an async context (tokio runtime)
/// will cause a deadlock or panic.
///
/// When calling from async code, wrap in `tokio::task::spawn_blocking`:
/// ```ignore
/// let result = tokio::task::spawn_blocking(move || {
///     ensure_session_sidecar(&app_handle, &manager, &session_id, workspace_path, owner)
/// })
/// .await
/// .map_err(|e| format!("spawn_blocking failed: {}", e))?;
/// ```
pub fn ensure_session_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
) -> Result<EnsureSidecarResult, String> {
    ensure_session_sidecar_with_runtime_override(
        app_handle,
        manager,
        session_id,
        workspace_path,
        owner,
        None,
    )
}

/// Upper bound on ensure re-entry. The ensure path re-runs itself on
/// generation-change and concurrent-create (it must re-wait for `/health/ready`
/// rather than return a replacement port directly). This caps that re-entry so
/// a thrashing health monitor that keeps bumping the generation can't recurse
/// without a depth bound. Each attempt costs ≥2s (HTTP/readiness window), so 8
/// is generous — real churn settles in 1–2 (cross-review: all three reviewers
/// flagged the prior unbounded self-recursion).
const MAX_ENSURE_ATTEMPTS: u32 = 8;

pub fn ensure_session_sidecar_with_runtime_override<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    runtime_override: Option<String>,
) -> Result<EnsureSidecarResult, String> {
    ensure_session_sidecar_attempt(
        app_handle,
        manager,
        session_id,
        workspace_path,
        owner,
        runtime_override,
        0,
    )
}

fn ensure_session_sidecar_attempt<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    runtime_override: Option<String>,
    attempt: u32,
) -> Result<EnsureSidecarResult, String> {
    if attempt >= MAX_ENSURE_ATTEMPTS {
        return Err(format!(
            "Session {} ensure exceeded {} attempts (sidecar generation churn not settling)",
            session_id, MAX_ENSURE_ATTEMPTS
        ));
    }
    ulog_info!("[sidecar] ensure_session_sidecar called for session: {}, owner: {:?} (attempt {})", session_id, owner, attempt);
    let ensure_started = trace_start();
    let owner_for_trace = format!("{:?}", owner);
    let requested_runtime_for_trace = normalize_runtime_name(runtime_override.as_deref()).to_string();
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_start")
            .session_id(Some(session_id))
            .runtime(Some(&requested_runtime_for_trace))
            .detail("owner", &owner_for_trace),
    );

    // Ensure file descriptor limit is high enough for Bun
    ensure_high_file_descriptor_limit();

    // Block briefly if startup cleanup is still running — same barrier as
    // `start_tab_sidecar`. Without this, Cron task recovery / session-monitor
    // auto-restart / IM message arrival during the startup window would spawn
    // a new session sidecar that races with the stale-process sweep (the very
    // case db58545 set out to prevent). In the common case this returns
    // immediately (AtomicBool load; cleanup completes in ~50 ms).
    wait_for_startup_cleanup(Duration::from_secs(15));

    ulog_debug!("[sidecar] Acquiring manager lock...");
    let mut manager_guard = manager.lock().map_err(|e| {
        ulog_error!("[sidecar] Failed to acquire manager lock: {}", e);
        e.to_string()
    })?;
    ulog_debug!("[sidecar] Manager lock acquired");

    // Check if Session already has a healthy Sidecar
    // We use a two-phase approach to avoid holding the lock during HTTP check:
    // Phase 1: Check if sidecar exists and get its port (with lock)
    // Phase 2: Do HTTP health check (without lock)
    // Phase 3: Re-acquire lock and finalize decision

    // Note: there used to be an inline drift check for Agent-owner Sidecars
    // here, but it's been removed as of v0.1.66. Drift is now handled at the
    // IM router layer (`SessionRouter::check_and_reset_on_runtime_drift`)
    // which runs BEFORE `ensure_session_sidecar` and regenerates the peer
    // session_id on drift. By the time we reach here:
    //
    //   - IM message path (router-driven): the router already forked to a
    //     fresh session_id, so `session_id` has no existing Sidecar and the
    //     spawn path below uses the owner-aware priority chain to pick the
    //     correct runtime from agent config.
    //
    //   - Direct session_id callers: they target an existing session_id
    //     that may be shared with a desktop Tab. Killing the Sidecar here
    //     would orphan the Tab's SSE stream. Better to reuse the existing
    //     (possibly stale-runtime) Sidecar.
    //
    // The priority chain at the spawn path below still enforces "Agent owner
    // uses agent config, not session metadata" so fresh spawns for Agent
    // owners always honor the user's latest runtime choice, including the
    // external → builtin switch direction.

    let existing_sidecar_info: Option<ExistingSidecarReuse> = {
        let generation = manager_guard.current_generation(session_id);
        if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
            if sidecar.is_dead() {
                // Process exited, clean up
                ulog_info!(
                    "[sidecar] Session {} has dead Sidecar process, removing",
                    session_id
                );
                manager_guard.remove_sidecar(session_id);
                None
            } else if sidecar.is_reusable() {
                // Healthy — needs HTTP verification outside the lock
                Some(ExistingSidecarReuse::Healthy {
                    port: sidecar.port,
                    generation,
                    runtime: normalize_runtime_name(sidecar.runtime.as_deref()).to_string(),
                })
            } else {
                // Starting — another thread is doing wait_for_health/readiness.
                // Add the owner now, then wait for /health/ready outside the lock.
                ulog_info!(
                    "[sidecar] Session {} Sidecar still starting on port {}, adding owner {:?}",
                    session_id, sidecar.port, owner
                );
                validate_sidecar_runtime_invariant(session_id, sidecar.runtime.as_deref(), "reuse-starting");
                let owner_added = sidecar.add_owner(owner.clone());
                Some(ExistingSidecarReuse::Starting {
                    port: sidecar.port,
                    generation,
                    runtime: normalize_runtime_name(sidecar.runtime.as_deref()).to_string(),
                    owner_added,
                })
            }
        } else {
            None
        }
    };

    // If we found a running sidecar, verify HTTP health (with lock released).
    // CRITICAL: The lock is dropped during the 2s HTTP check. Another thread (health monitor)
    // can replace the sidecar during this window. We use a generation counter to detect this
    // and avoid accidentally killing the healthy replacement.
    if let Some(existing) = existing_sidecar_info {
        let (port, pre_gen, runtime_for_trace, wait_for_starting, joined_owner_added) = match existing {
            ExistingSidecarReuse::Healthy { port, generation, runtime } => {
                (port, generation, runtime, false, false)
            }
            ExistingSidecarReuse::Starting { port, generation, runtime, owner_added } => {
                (port, generation, runtime, true, owner_added)
            }
        };
        drop(manager_guard);

        let check_started = trace_start();
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "reuse_check_start")
                .session_id(Some(session_id))
                .runtime(Some(&runtime_for_trace))
                .detail("port", port)
                .detail("starting", wait_for_starting),
        );
        let http_healthy = if wait_for_starting {
            wait_for_readiness(port, 30).is_ok()
        } else {
            // Verify HTTP server is actually responsive (not just process alive)
            check_sidecar_http_health(port)
        };
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "reuse_check_end")
                .duration_ms(elapsed_ms(check_started))
                .session_id(Some(session_id))
                .runtime(Some(&runtime_for_trace))
                .status(if http_healthy { "ok" } else { "error" })
                .detail("port", port)
                .detail("starting", wait_for_starting),
        );

        // Re-acquire lock after HTTP check
        let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
        let post_gen = manager_guard.current_generation(session_id);

        if post_gen != pre_gen {
            // Generation changed: another thread replaced the sidecar during our HTTP check.
            // Re-enter the normal ensure path for the replacement instead of returning its
            // port directly. The replacement may still be Starting; the normal path knows
            // how to wait for /health/ready and also re-verifies Healthy sidecars over HTTP.
            ulog_info!(
                "[sidecar] Session {} generation changed ({} → {}) during HTTP check on port {}, checking replacement",
                session_id, pre_gen, post_gen, port
            );
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                if !sidecar.is_dead() {
                    ulog_info!(
                        "[sidecar] Session {} replacement on port {} is {:?}, retrying ensure",
                        session_id, sidecar.port, sidecar.state
                    );
                    validate_sidecar_runtime_invariant(session_id, sidecar.runtime.as_deref(), "reuse-replacement");
                    drop(manager_guard);
                    return ensure_session_sidecar_attempt(
                        app_handle,
                        manager,
                        session_id,
                        workspace_path,
                        owner,
                        runtime_override,
                        attempt + 1,
                    );
                }
            }
            // Replacement sidecar process also dead — fall through to create
        } else if http_healthy {
            // Same generation, HTTP healthy — try to reuse
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                if sidecar.port == port && sidecar.is_reusable() {
                    ulog_info!(
                        "[sidecar] Session {} Sidecar HTTP healthy on port {}, adding owner {:?}",
                        session_id, port, owner
                    );
                    validate_sidecar_runtime_invariant(session_id, sidecar.runtime.as_deref(), "reuse-http-healthy");
                    sidecar.add_owner(owner.clone());
                    emit_perf_trace(
                        PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                            .duration_ms(elapsed_ms(ensure_started))
                            .session_id(Some(session_id))
                            .runtime(Some(&runtime_for_trace))
                            .status("ok")
                            .detail("port", port)
                            .detail("is_new", false)
                            .detail("reuse", if wait_for_starting { "starting-ready" } else { "healthy" }),
                    );
                    return Ok(EnsureSidecarResult {
                        port,
                        is_new: false,
                    });
                }
                if sidecar.port == port && wait_for_starting {
                    ulog_info!(
                        "[sidecar] Session {} starting Sidecar reached readiness on port {}, adding owner {:?}",
                        session_id, port, owner
                    );
                    validate_sidecar_runtime_invariant(session_id, sidecar.runtime.as_deref(), "reuse-starting-ready");
                    sidecar.state = SidecarState::Healthy;
                    sidecar.add_owner(owner.clone());
                    emit_perf_trace(
                        PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                            .duration_ms(elapsed_ms(ensure_started))
                            .session_id(Some(session_id))
                            .runtime(Some(&runtime_for_trace))
                            .status("ok")
                            .detail("port", port)
                            .detail("is_new", false)
                            .detail("reuse", "starting-ready"),
                    );
                    return Ok(EnsureSidecarResult {
                        port,
                        is_new: false,
                    });
                }
            }
            // Sidecar gone but generation unchanged (removed without replacement)
            ulog_info!(
                "[sidecar] Session {} Sidecar removed during HTTP check, will create new",
                session_id
            );
        } else {
            if wait_for_starting {
                // We joined a sidecar that another owner was already starting.
                // Our independent readiness timeout must not kill or replace
                // that startup; the original creator may still be inside its
                // longer TCP+ready boot window. Detach only the owner we added.
                ulog_warn!(
                    "[sidecar] Session {} starting Sidecar on port {} did not become ready for joining owner {:?}; preserving original startup",
                    session_id, port, owner
                );
                // Only detach the owner if THIS call actually added it. When the
                // owner was already present (a same-owner concurrent ensure joined
                // the same Starting sidecar), `add_owner` returned false; removing
                // it here would empty the shared owner set and tear down a sidecar
                // the other caller is still legitimately starting (cross-review
                // Codex Critical #2). Leave teardown to whoever truly owns it.
                let should_stop = if joined_owner_added {
                    if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                        sidecar.port == port && sidecar.remove_owner(&owner)
                    } else {
                        false
                    }
                } else {
                    false
                };
                if should_stop {
                    manager_guard.remove_sidecar(session_id);
                    manager_guard.clear_generation(session_id);
                }
                return Err(format!(
                    "Session {} sidecar on port {} is still starting",
                    session_id, port
                ));
            }
            // Same generation, HTTP unhealthy — safe to remove (no one replaced it)
            ulog_warn!(
                "[sidecar] Session {} Sidecar process alive but HTTP unresponsive on port {}, removing",
                session_id, port
            );
            manager_guard.remove_sidecar(session_id);
        }

        let result = create_new_session_sidecar(
            app_handle,
            manager,
            session_id,
            workspace_path,
            owner,
            manager_guard,
            runtime_override.as_deref(),
            attempt,
        );
        if let Ok(ensure_result) = &result {
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                    .duration_ms(elapsed_ms(ensure_started))
                    .session_id(Some(session_id))
                    .runtime(Some(&requested_runtime_for_trace))
                    .status("ok")
                    .detail("port", ensure_result.port)
                    .detail("is_new", ensure_result.is_new),
            );
        }
        return result;
    }

    // No existing sidecar found, create a new one with the original guard
    let result = create_new_session_sidecar(
        app_handle,
        manager,
        session_id,
        workspace_path,
        owner,
        manager_guard,
        runtime_override.as_deref(),
        attempt,
    );
    if let Ok(ensure_result) = &result {
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                .duration_ms(elapsed_ms(ensure_started))
                .session_id(Some(session_id))
                .runtime(Some(&requested_runtime_for_trace))
                .status("ok")
                .detail("port", ensure_result.port)
                .detail("is_new", ensure_result.is_new),
        );
    }
    result
}

/// Helper function to create a new session sidecar
/// Extracted to avoid code duplication and handle the mutex guard properly
#[allow(clippy::too_many_arguments)] // 参数族是同一上下文的协作引用，收敛为 struct 属中性重构，暂以 lint 豁免记录
fn create_new_session_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    mut manager_guard: std::sync::MutexGuard<'_, SidecarManager>,
    runtime_override: Option<&str>,
    attempt: u32,
) -> Result<EnsureSidecarResult, String> {
    let boot_started = trace_start();

    // Guard against double-creation: if another thread already created a sidecar for this
    // session (e.g., health monitor raced with frontend), reuse it instead of spawning another.
    if let Some(existing) = manager_guard.sidecars.get_mut(session_id) {
        if !existing.is_dead() {
            ulog_info!(
                "[sidecar] Session {} already has a {:?} sidecar on port {} (created by another thread), retrying ensure",
                session_id, existing.state, existing.port
            );
            drop(manager_guard);
            return ensure_session_sidecar_attempt(
                app_handle,
                manager,
                session_id,
                workspace_path,
                owner,
                runtime_override.map(str::to_string),
                attempt + 1,
            );
        }
        // Exists but process dead — remove before creating fresh
        manager_guard.remove_sidecar(session_id);
    }

    // Need to start a new Sidecar
    // First, find executables
    let node_path = find_node_executable(app_handle)
        .ok_or_else(|| diagnose_node_not_found(app_handle))?;
    let script_path = find_server_script(app_handle)
        .ok_or_else(|| "Server script not found".to_string())?;

    // Allocate port
    let port = manager_guard.allocate_port()?;

    ulog_info!(
        "[sidecar] Starting SessionSidecar for session {} on port {}, owner: {:?}",
        session_id, port, owner
    );

    // Build command (see sibling SessionSidecar path for the tsx-loader rationale)
    let mut cmd = crate::process_cmd::new(&node_path);
    if script_path.extension().and_then(|s| s.to_str()) == Some("ts") {
        cmd.arg("--import").arg("tsx/esm");
    }
    cmd.arg(&script_path)
        .arg("--port")
        .arg(port.to_string())
        .arg(SIDECAR_MARKER)
        .arg("--agent-dir")
        .arg(workspace_path);

    // Pass session_id to Bun for real sessions (not pending-xxx)
    // so Bun uses the same UUID as Rust/SDK, enabling resume on crash recovery
    if !session_id.starts_with("pending-") {
        cmd.arg("--session-id").arg(session_id);
    }

    // Set working directory to script's parent directory
    if let Some(script_dir) = script_path.parent() {
        cmd.current_dir(script_dir);
    }

    // Apply proxy policy: user proxy / inherit system / protect localhost (pit-of-success)
    proxy_config::apply_to_subprocess(&mut cmd);

    // Inject management API port for Bun→Rust IPC (v0.1.21)
    let mgmt_port = crate::management_api::get_management_port();
    if mgmt_port > 0 {
        cmd.env("ZHISHI_MANAGEMENT_PORT", mgmt_port.to_string());
    }

    // Inject runtime type for Agent Runtime selection (v0.1.59, v0.1.62, v0.1.66).
    //
    // Priority rules, split by owner type:
    //
    //   Tab / CronTask / BackgroundCompletion (desktop-style):
    //     runtime_override → session metadata → agent config
    //
    //     Session metadata is authoritative so an ongoing conversation can't
    //     switch runtimes mid-stream just because the user tweaked the agent's
    //     default in Settings. This is the v0.1.62 session-stability guarantee.
    //
    //   Agent (IM / agent-channel):
    //     runtime_override → agent config (NO session fallback)
    //
    //     The IM peer session map is keyed on (agent, channel, user), so the
    //     user never sees individual session IDs — their mental model is "I'm
    //     talking to my agent". When they change the agent's runtime in
    //     Settings, they expect the next IM message to use the new runtime
    //     regardless of which session_id the peer map happens to point at.
    //
    //     Critically, we must NOT fall back to session metadata for the Agent
    //     branch: `resolve_agent_runtime_from_config` returns None when the
    //     agent is builtin, and falling through to session_runtime would then
    //     silently re-resurrect a previously-used external runtime (e.g.
    //     gemini→builtin switch), defeating the whole point of the IM drift
    //     semantics. A None result here means "spawn as builtin (no env var)"
    //     which is exactly correct — the user explicitly asked for builtin.
    let resolved_runtime = runtime_override.map(|runtime| runtime.to_string())
        .or_else(|| {
            if matches!(owner, SidecarOwner::Agent(_)) {
                resolve_agent_runtime_from_config(workspace_path)
            } else {
                resolve_session_runtime(session_id)
                    .or_else(|| resolve_agent_runtime_from_config(workspace_path))
            }
        });
    if let Some(runtime) = &resolved_runtime {
        cmd.env("ZHISHI_RUNTIME", runtime);
    }

    // Inject data directory so the Node.js sidecar resolves the same path
    // as the Rust process (critical for USB portable mode).
    if let Some(data_dir) = crate::app_dirs::zhishi_data_dir() {
        cmd.env("ZHISHI_DATA_DIR", data_dir.to_string_lossy().as_ref());
    }

    let runtime_for_trace = normalize_runtime_name(resolved_runtime.as_deref()).to_string();

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    // Windows: CREATE_NO_WINDOW already applied by process_cmd::new()

    // Unix: Make child a process group leader so kill(-PGID) kills the entire tree
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    // Spawn
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::SidecarBoot, "spawn_start")
            .session_id(Some(session_id))
            .runtime(Some(&runtime_for_trace))
            .detail("owner", format!("{:?}", owner)),
    );
    let mut child = cmd.spawn().map_err(|e| {
        ulog_error!("[sidecar] Failed to spawn SessionSidecar: {}", e);
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "spawn_failed")
                .duration_ms(elapsed_ms(boot_started))
                .session_id(Some(session_id))
                .runtime(Some(&runtime_for_trace))
                .status("error")
                .detail("error", e.to_string()),
        );
        format!("Failed to spawn sidecar: {}", e)
    })?;
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::SidecarBoot, "spawned")
            .duration_ms(elapsed_ms(boot_started))
            .session_id(Some(session_id))
            .runtime(Some(&runtime_for_trace))
            .status("ok")
            .detail("port", port),
    );

    // Capture stdout/stderr → 写入统一日志
    let session_id_clone = session_id.to_string();
    if let Some(stdout) = child.stdout.take() {
        let session_id_for_log = session_id_clone.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut bun_logger_active = false;
            for line in reader.lines().map_while(Result::ok) {
                // Once Bun's unified logger is initialized, ALL console.log output is
                // written directly to the unified log file by Bun's logger interceptor.
                // Capturing stdout after this point causes 100% duplication ([BUN] + [bun-out]).
                // Only pre-logger startup lines need to go through bun-out.
                if !bun_logger_active {
                    if line.contains("[Logger] Unified logging initialized") {
                        bun_logger_active = true;
                    }
                    ulog_info!("[bun-out][session:{}] {}", session_id_for_log, line);
                }
                // After logger init: silently drop stdout (Bun logger handles it)
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let session_id_for_log = session_id_clone.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                match classify_sidecar_stderr(&line) {
                    SidecarStderrLevel::Info =>
                        ulog_info!("[bun-err][session:{}] {}", session_id_for_log, line),
                    SidecarStderrLevel::Warn =>
                        ulog_warn!("[bun-err][session:{}] {}", session_id_for_log, line),
                    SidecarStderrLevel::Error =>
                        ulog_error!("[bun-err][session:{}] {}", session_id_for_log, line),
                }
            }
        });
    }

    // Check if the process already exited (non-blocking poll). No pre-sleep;
    // the health-loop's alive_check catches any crash this probe misses.
    if let Ok(Some(status)) = child.try_wait() {
        thread::sleep(Duration::from_millis(100));
        ulog_error!("[sidecar] SessionSidecar exited immediately with status: {:?}", status);
        #[cfg(target_os = "windows")]
        maybe_mark_crashed_node(&status, &node_path);
        let diag = diagnose_immediate_exit(&status, &node_path);
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "spawn_immediate_exit")
                .duration_ms(elapsed_ms(boot_started))
                .session_id(Some(session_id))
                .runtime(Some(&runtime_for_trace))
                .status("error")
                .detail("status", format!("{:?}", status)),
        );
        return Err(diag);
    }

    // Create SessionSidecar with owner
    let mut owners = HashSet::new();
    owners.insert(owner.clone());
    let sidecar = SessionSidecar {
        process: child,
        port,
        session_id: session_id.to_string(),
        workspace_path: workspace_path.to_path_buf(),
        state: SidecarState::Starting,
        owners,
        created_at: std::time::Instant::now(),
        runtime: resolved_runtime.clone(),
    };

    manager_guard.insert_sidecar(session_id, sidecar);

    // Drop lock before waiting for health
    drop(manager_guard);

    // Build liveness check closure for session sidecar
    let liveness_manager = manager.clone();
    let liveness_session_id = session_id.to_string();
    let alive_check: Box<dyn Fn() -> bool> = Box::new(move || {
        if let Ok(mut guard) = liveness_manager.lock() {
            if let Some(sidecar) = guard.sidecars.get_mut(&liveness_session_id) {
                matches!(sidecar.process.try_wait(), Ok(None))
            } else {
                false
            }
        } else {
            true // can't acquire lock, assume alive
        }
    });

    // Wait for health (TCP up). Then wait for /health/ready (deferred init
    // complete) so renderer-driven session startup gates on actual readiness,
    // not just liveness. Other startup paths (cron / IM bot) keep the looser
    // liveness-only contract — they don't surface a "still warming up" UI.
    let health_started = trace_start();
    match wait_for_health(port, Some(alive_check)) {
        Ok(()) => {
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "tcp_live")
                    .duration_ms(elapsed_ms(health_started))
                    .session_id(Some(session_id))
                    .runtime(Some(&runtime_for_trace))
                    .status("ok")
                    .detail("port", port),
            );
            // Pattern 4: tighten the renderer-driven session sidecar startup
            // to wait for /health/ready as well. 30s timeout matches existing
            // long-running migration / SDK init budgets.
            let readiness_started = trace_start();
            if let Err(e) = wait_for_readiness(port, 30) {
                ulog_error!("[sidecar] Session {} /health/ready failed: {}", session_id, e);
                emit_perf_trace(
                    PerfTrace::new(PerfTraceName::SidecarBoot, "ready_failed")
                        .duration_ms(elapsed_ms(readiness_started))
                        .session_id(Some(session_id))
                        .runtime(Some(&runtime_for_trace))
                        .status("error")
                        .detail("port", port)
                        .detail("error", &e),
                );
                let mut manager_guard = manager.lock().map_err(|_| e.clone())?;
                let port_matches = manager_guard.sidecars.get(session_id)
                    .map(|s| s.port == port)
                    .unwrap_or(false);
                if port_matches {
                    manager_guard.remove_sidecar(session_id);
                }
                return Err(e);
            }
            // Mark as healthy — verify port to avoid mutating a replacement sidecar
            // that was created by another thread (e.g., health monitor) during the wait.
            let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                if sidecar.port == port {
                    sidecar.state = SidecarState::Healthy;
                } else {
                    ulog_warn!(
                        "[sidecar] Session {} sidecar replaced during wait_for_health (expected port {}, found {}), skipping Healthy transition",
                        session_id, port, sidecar.port
                    );
                }
            }
            ulog_info!(
                "[sidecar] SessionSidecar for session {} is healthy on port {}",
                session_id, port
            );
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "ready_ok")
                    .duration_ms(elapsed_ms(boot_started))
                    .session_id(Some(session_id))
                    .runtime(Some(&runtime_for_trace))
                    .status("ok")
                    .detail("port", port),
            );
            Ok(EnsureSidecarResult {
                port,
                is_new: true,
            })
        }
        Err(e) => {
            ulog_error!("[sidecar] SessionSidecar health check failed: {}", e);
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "tcp_live_failed")
                    .duration_ms(elapsed_ms(health_started))
                    .session_id(Some(session_id))
                    .runtime(Some(&runtime_for_trace))
                    .status("error")
                    .detail("port", port)
                    .detail("error", &e),
            );
            let mut manager_guard = manager.lock().map_err(|_| e.clone())?;
            // Verify port before acting — another thread may have replaced the sidecar
            let port_matches = manager_guard.sidecars.get(session_id)
                .map(|s| s.port == port)
                .unwrap_or(false);
            if port_matches {
                // Check exit status and mark crashed bun for fallback
                #[cfg(target_os = "windows")]
                if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                    if let Ok(Some(status)) = sidecar.process.try_wait() {
                        maybe_mark_crashed_node(&status, &node_path);
                    }
                }
                // Remove the failed sidecar (ours, not a replacement)
                manager_guard.remove_sidecar(session_id);
            } else {
                ulog_warn!(
                    "[sidecar] Session {} sidecar replaced during wait_for_health (port {}), skipping removal",
                    session_id, port
                );
            }
            Err(e)
        }
    }
}

/// Release an owner from a Session's Sidecar.
/// If this was the last owner, the Sidecar is stopped.
///
/// Returns true if the Sidecar was stopped (no more owners).
pub fn release_session_sidecar(
    manager: &ManagedSidecarManager,
    session_id: &str,
    owner: &SidecarOwner,
) -> Result<bool, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    let (removed, stopped) = manager_guard.remove_session_owner(session_id, owner);

    if removed {
        if stopped {
            // Clean up generation counter when sidecar is permanently removed
            manager_guard.clear_generation(session_id);
            ulog_info!(
                "[sidecar] Released owner {:?} from session {}, Sidecar stopped (last owner)",
                owner, session_id
            );
        } else {
            ulog_info!(
                "[sidecar] Released owner {:?} from session {}, Sidecar continues running",
                owner, session_id
            );
        }
        Ok(stopped)
    } else {
        ulog_debug!(
            "[sidecar] Session {} has no Sidecar to release owner {:?} from",
            session_id, owner
        );
        Ok(false)
    }
}




/// Check if a Sidecar's session is currently in "running" state
/// by calling GET /api/session-state
fn check_sidecar_session_state(port: u16) -> Option<String> {
    let url = format!("http://127.0.0.1:{}/api/session-state", port);
    let client = match crate::local_http::blocking_builder()
        .timeout(Duration::from_secs(3))
        .build() {
        Ok(c) => c,
        Err(_) => return None,
    };

    match client.get(&url).send() {
        Ok(response) if response.status().is_success() => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct SessionStateResponse {
                session_state: String,
            }
            match response.json::<SessionStateResponse>() {
                Ok(state) => Some(state.session_state),
                Err(_) => None,
            }
        }
        _ => None,
    }
}


/// Stop all sidecar instances and clean up child processes
/// This should be called when the app is closing
pub fn stop_all_sidecars(manager: &ManagedSidecarManager) -> Result<(), String> {
    ulog_info!("[sidecar] Stopping all sidecars and cleaning up child processes...");

    // 1. Stop all managed sidecar instances (kills bun sidecars via Drop)
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
    manager_guard.stop_all();
    drop(manager_guard);

    // 2. Clean up any orphaned child processes (SDK and MCP)
    // This is necessary because SDK spawns child processes that don't die
    // when the parent bun sidecar is killed
    cleanup_child_processes();

    Ok(())
}

/// Shutdown for update — block until all child processes are fully terminated.
/// Unlike stop_all_sidecars (which is non-blocking), this function waits for
/// all bun/SDK/MCP processes to exit, preventing NSIS installer file-lock errors on Windows.
pub fn shutdown_for_update(manager: &ManagedSidecarManager) -> Result<(), String> {
    ulog_info!("[sidecar] Shutdown for update: stopping all processes...");

    // 1. Stop all sidecar instances (via Drop → kill_process → taskkill /T /F)
    stop_all_sidecars(manager)?;

    // 2. Actively kill orphan processes that may survive sidecar tree-kill
    //    (e.g., node.exe from bundled npx — cmd.exe intermediate layers break process tree)
    #[cfg(windows)]
    {
        cleanup_child_processes();
    }

    // 3. Wait for all related processes to truly exit. Uses the same
    //    sysinfo-backed process scan as startup cleanup — no PowerShell
    //    subprocesses, no cmd-line-escaping edge cases, consistent
    //    behavior across Windows and Unix.
    let max_wait = Duration::from_secs(5);
    let start = std::time::Instant::now();
    loop {
        // Update path MUST verify our own sidecars (SIDECAR_MARKER) too —
        // NSIS can't overwrite `bun.exe` while it's in use, so we need
        // confirmation that every ZhiShi-related process is gone. Uses
        // STARTUP patterns (superset that includes the sidecar marker).
        if !crate::process_cleanup::has_matching_processes(STARTUP_CLEANUP_PATTERNS) {
            ulog_info!(
                "[sidecar] All processes terminated in {:?}",
                start.elapsed()
            );
            break;
        }

        if start.elapsed() > max_wait {
            ulog_warn!("[sidecar] Update shutdown timeout, force killing remaining...");
            let report = crate::process_cleanup::kill_stale_processes(STARTUP_CLEANUP_PATTERNS);
            ulog_info!(
                "[sidecar] Force-kill final pass: killed {}, residual {} ({:?})",
                report.killed,
                report.residual,
                report.elapsed
            );
            break;
        }

        thread::sleep(Duration::from_millis(100));
    }

    ulog_info!("[sidecar] Shutdown for update complete");
    Ok(())
}

/// Clean up SDK and MCP child processes at app shutdown.
///
/// On Windows, SDK-spawned node/bun processes often survive a direct
/// parent kill because `cmd.exe` intermediates (npx.cmd / bun.exe wrapper)
/// break the process-tree linkage that `taskkill /T /F` relies on. This
/// shutdown cleanup walks descendants by PPID via sysinfo and kills
/// them all — orphans included — in one pass.
///
/// Uses [`CHILD_CLEANUP_PATTERNS`] (no `SIDECAR_MARKER`) because our own
/// sidecars are already killed through their `Child` handles in
/// [`stop_all_sidecars`]. Sweeping by marker here would risk killing a
/// concurrent ZhiShi instance's sidecars during any overlap window.
fn cleanup_child_processes() {
    let report = crate::process_cleanup::kill_stale_processes(CHILD_CLEANUP_PATTERNS);
    if report.total_targets() == 0 {
        ulog_info!(
            "[sidecar] Shutdown cleanup: nothing to kill ({:?})",
            report.elapsed
        );
    } else {
        ulog_info!(
            "[sidecar] Shutdown cleanup: killed {} (roots={}, descendants={}, residual={}) in {:?}",
            report.killed,
            report.matched_roots,
            report.descendants,
            report.residual,
            report.elapsed
        );
    }
}



/// Cron task execution payload - sent to Sidecar's /cron/execute-sync endpoint
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronExecutePayload {
    pub task_id: String,
    pub prompt: String,
    /// Session ID for activation tracking (prevents Sidecar from being killed during cron execution)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_first_execution: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_can_exit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_env: Option<ProviderEnv>,
    /// PRD 0.2.9: per-task provider id. When set, sidecar live-resolves the
    /// provider env on every tick from `~/.zhishi/config.json`. Mutually
    /// exclusive with `provider_env` (legacy explicit-snapshot path).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// PRD #119: routing intent. `None` deserializes to FollowAgent on the
    /// receiver side (sidecar handler treats absent as legacy default).
    /// PRD 0.2.9 prefers `provider_id` over this; intent is kept for
    /// backward-compat with crons persisted in 0.2.8 and earlier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_intent: Option<crate::task_scheduler::ProviderIntent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_config: Option<serde_json::Value>,
    /// Per-task MCP enable list override (PRD 0.2.4 §需求 4).
    /// `None` = follow workspace MCP config (Agent's mcpEnabledServers).
    /// `Some([...])` = enable only these server ids for this task.
    /// Sidecar `/cron/execute-sync` applies via `setMcpServers()` before
    /// delivering the prompt so the SDK's tool list matches the override.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_enabled_servers: Option<Vec<String>>,
    /// Run mode: "single_session" (keep context) or "new_session" (fresh each time)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_mode: Option<String>,
    /// Task execution interval in minutes (for System Prompt context)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_minutes: Option<u32>,
    /// Current execution number (1-based, for System Prompt context)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_number: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEnv {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens_param_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_format: Option<String>,
}

/// Cron task execution response from Sidecar
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronExecuteResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_requested_exit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_text: Option<String>,
    /// Internal SDK session ID where conversation data is stored
    /// (may differ from the Sidecar session key used for process management)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// 3b 引擎换主：新调度器（task_scheduler）使用 Task 语义名称——同一传输层结构体的别名。
pub type ScheduledTaskExecuteResponse = CronExecuteResponse;

/// 同上：`ScheduledTaskExecutePayload` 为 `CronExecutePayload` 的 Task 语义别名。
pub type ScheduledTaskExecutePayload = CronExecutePayload;

/// Execute a cron task synchronously via Sidecar HTTP API
/// This function ensures a Sidecar is running for the session and calls its /cron/execute-sync endpoint
/// Task 语义别名（3b）：新调度器调用入口，与 `execute_cron_task` 同一实现。
pub async fn execute_scheduled_task<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    workspace_path: &str,
    payload: ScheduledTaskExecutePayload,
) -> Result<ScheduledTaskExecuteResponse, String> {
    execute_cron_task(app_handle, manager, workspace_path, payload).await
}

pub async fn execute_cron_task<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    workspace_path: &str,
    payload: CronExecutePayload,
) -> Result<CronExecuteResponse, String> {
    ulog_info!(
        "[sidecar] execute_cron_task called for task {} in workspace {}",
        payload.task_id, workspace_path
    );
    let cron_started = trace_start();
    let cron_task_id = payload.task_id.clone();
    let cron_runtime = normalize_runtime_name(payload.runtime.as_deref()).to_string();

    // Require session_id for Session-centric Sidecar
    let session_id = payload.session_id.clone().ok_or_else(|| {
        let err = format!("[sidecar] execute_cron_task requires session_id for task {}", payload.task_id);
        ulog_error!("{}", err);
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::BackgroundJob, "cron_execute")
                .duration_ms(elapsed_ms(cron_started))
                .runtime(Some(&cron_runtime))
                .status("error")
                .detail("taskId", &cron_task_id)
                .detail("error", &err),
        );
        err
    })?;

    // Emit debug event
    let _ = app_handle.emit("cron:debug", serde_json::json!({
        "taskId": payload.task_id,
        "message": "execute_cron_task: about to call ensure_session_sidecar"
    }));

    // Ensure Sidecar is running for this session with CronTask as owner
    // IMPORTANT: Use spawn_blocking because ensure_session_sidecar uses reqwest::blocking::Client
    // which cannot be called from within a tokio async runtime (causes deadlock)
    let app_handle_clone = app_handle.clone();
    let manager_clone = manager.clone();
    let session_id_clone = session_id.clone();
    let workspace_clone = workspace_path.to_string();
    let task_id_clone = payload.task_id.clone();
    let owner = SidecarOwner::CronTask(task_id_clone.clone());
    let runtime_override = payload.runtime.clone();

    let result = tokio::task::spawn_blocking(move || {
        let workspace = PathBuf::from(&workspace_clone);
        ensure_session_sidecar_with_runtime_override(
            &app_handle_clone,
            &manager_clone,
            &session_id_clone,
            &workspace,
            owner,
            runtime_override,
        )
    })
    .await
    .map_err(|e| {
        let err = format!("spawn_blocking failed: {}", e);
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::BackgroundJob, "cron_execute")
                .duration_ms(elapsed_ms(cron_started))
                .session_id(Some(&session_id))
                .runtime(Some(&cron_runtime))
                .status("error")
                .detail("taskId", &cron_task_id)
                .detail("error", &err),
        );
        err
    })?
    .map_err(|e| {
        ulog_error!("[sidecar] ensure_session_sidecar failed for task {}: {}", payload.task_id, e);
        let _ = app_handle.emit("cron:debug", serde_json::json!({
            "taskId": payload.task_id,
            "message": format!("execute_cron_task: ensure_session_sidecar FAILED: {}", e),
            "error": true
        }));
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::BackgroundJob, "cron_execute")
                .duration_ms(elapsed_ms(cron_started))
                .session_id(Some(&session_id))
                .runtime(Some(&cron_runtime))
                .status("error")
                .detail("taskId", &cron_task_id)
                .detail("error", &e),
        );
        e
    })?;

    let port = result.port;
    let sidecar_is_new = result.is_new;

    // Emit debug event
    let _ = app_handle.emit("cron:debug", serde_json::json!({
        "taskId": payload.task_id,
        "message": format!("execute_cron_task: sidecar ready on port {}, isNew={}", port, result.is_new)
    }));

    ulog_info!(
        "[sidecar] Cron sidecar ready for task {} on port {} (isNew={})",
        payload.task_id, port, result.is_new
    );

    // Also record in session_activations for Session singleton tracking
    {
        let _ = app_handle.emit("cron:debug", serde_json::json!({
            "taskId": payload.task_id,
            "message": "execute_cron_task: recording session activation"
        }));

        let mut manager_guard = manager.lock().map_err(|e| {
            let _ = app_handle.emit("cron:debug", serde_json::json!({
                "taskId": payload.task_id,
                "message": format!("execute_cron_task: mutex lock FAILED: {}", e),
                "error": true
            }));
            e.to_string()
        })?;

        manager_guard.activate_session(
            session_id.clone(),
            None,  // No tab_id for cron tasks
            Some(payload.task_id.clone()),  // Store task_id for Tab connection
            port,
            workspace_path.to_string(),
            true,  // is_cron_task = true
        );

        let _ = app_handle.emit("cron:debug", serde_json::json!({
            "taskId": payload.task_id,
            "message": "execute_cron_task: session activation recorded"
        }));

        ulog_info!(
            "[sidecar] Cron task {} activated session {} as cron (port {})",
            payload.task_id, session_id, port
        );
    }

    let url = format!("http://127.0.0.1:{}/cron/execute-sync", port);

    let _ = app_handle.emit("cron:debug", serde_json::json!({
        "taskId": payload.task_id,
        "message": format!("execute_cron_task: about to send HTTP request to {}", url)
    }));

    ulog_info!(
        "[sidecar] Executing cron task {} via {}",
        payload.task_id, url
    );

    // Create HTTP client with generous timeout (cron tasks can take long)
    let client = crate::local_http::builder()
        .timeout(Duration::from_secs(3660)) // 61 minutes (slightly more than cron task's 60 min timeout)
        .tcp_nodelay(true)
        .build()
        .map_err(|e| format!("[sidecar] Failed to create HTTP client: {}", e))?;

    let _ = app_handle.emit("cron:debug", serde_json::json!({
        "taskId": payload.task_id,
        "message": "execute_cron_task: HTTP client created, sending request..."
    }));

    // Send request to Sidecar
    let response = client
        .post(&url)
        .json(&payload)
        .send()
        .await;

    // Deactivate session after execution (regardless of success/failure)
    // Note: We keep the session activated between cron executions to protect Sidecar.
    // Only deactivate if the task is being stopped or completed.
    // For now, we keep it activated - the cron scheduler should deactivate when task stops.

    let response = response.map_err(|e| {
        let err = format!("[sidecar] HTTP request failed: {}", e);
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::BackgroundJob, "cron_execute")
                .duration_ms(elapsed_ms(cron_started))
                .session_id(Some(&session_id))
                .runtime(Some(&cron_runtime))
                .status("error")
                .detail("taskId", &cron_task_id)
                .detail("error", &err),
        );
        err
    })?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| {
            let err = format!("[sidecar] Failed to read response body: {}", e);
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::BackgroundJob, "cron_execute")
                    .duration_ms(elapsed_ms(cron_started))
                    .session_id(Some(&session_id))
                    .runtime(Some(&cron_runtime))
                    .status("error")
                    .detail("taskId", &cron_task_id)
                    .detail("error", &err),
            );
            err
        })?;

    ulog_info!(
        "[sidecar] Cron task {} response: status={}, body={}",
        payload.task_id, status, body.chars().take(500).collect::<String>()
    );

    // Parse response
    let result: CronExecuteResponse = serde_json::from_str(&body)
        .map_err(|e| {
            let err = format!("[sidecar] Failed to parse response JSON: {} (body: {})", e, body);
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::BackgroundJob, "cron_execute")
                    .duration_ms(elapsed_ms(cron_started))
                    .session_id(Some(&session_id))
                    .runtime(Some(&cron_runtime))
                    .status("error")
                    .detail("taskId", &cron_task_id)
                    .detail("statusCode", status.as_u16())
                    .detail("error", &err),
            );
            err
        })?;

    ulog_info!(
        "[sidecar] Cron task {} parsed response: success={}, error={:?}, ai_requested_exit={:?}",
        payload.task_id, result.success, result.error, result.ai_requested_exit
    );
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::BackgroundJob, "cron_execute")
            .duration_ms(elapsed_ms(cron_started))
            .session_id(Some(&session_id))
            .runtime(Some(&cron_runtime))
            .status(if result.success { "ok" } else { "error" })
            .detail("taskId", &cron_task_id)
            .detail("statusCode", status.as_u16())
            .detail("isNewSidecar", sidecar_is_new)
            .detail("aiRequestedExit", result.ai_requested_exit.unwrap_or(false)),
    );

    Ok(result)
}



// ─── Agent Runtime resolution (v0.1.59) ───

// BOM-stripping moved to crate::utils::bom (issue #170 #6) so all JSON-
// reading sites share a single helper.
use crate::utils::bom::strip_bom;

/// Look up the `runtime` field from the agent config in ~/.zhishi/config.json
/// matching the given workspace path. Returns None for "builtin" (the default).
/// Used for NEW sessions (the agent config decides the default runtime for new conversations)
/// and for IM/Agent sidecar paths that don't have a session_id yet.
fn resolve_agent_runtime_from_config(workspace_path: &std::path::Path) -> Option<String> {
    let config_path = dirs::home_dir()?.join(".zhishi").join("config.json");
    let content = std::fs::read_to_string(&config_path).ok()?;
    let cfg: serde_json::Value = serde_json::from_str(strip_bom(&content)).ok()?;

    // Gate: multi-agent runtime feature must be explicitly enabled (developer mode)
    // When off, all sidecars start as builtin regardless of agent config
    if !cfg.get("multiAgentRuntime").and_then(|v| v.as_bool()).unwrap_or(false) {
        return None;
    }

    let workspace_str = workspace_path.to_string_lossy();
    let agents = cfg.get("agents")?.as_array()?;
    for agent in agents {
        let agent_path = agent.get("workspacePath")?.as_str()?;
        // #320/F-13: config 与 session 来源的路径分隔符可能不同，禁止裸 ==
        if crate::utils::workspace_path::workspace_paths_equal(agent_path, workspace_str.as_ref()) {
            if let Some(runtime) = agent.get("runtime").and_then(|v| v.as_str()) {
                if runtime != "builtin" {
                    return Some(runtime.to_string());
                }
            }
            return None;
        }
    }
    None
}

/// Look up the `runtime` field from session metadata in ~/.zhishi/sessions.json.
/// Returns None for "builtin" or if the session is not found.
///
/// This is the authoritative source for EXISTING sessions — the session's own metadata
/// records which runtime created it, regardless of the current agent config.
/// Agent config (resolve_agent_runtime_from_config) decides the default for NEW sessions;
/// session metadata is stable once created.
fn resolve_session_runtime(session_id: &str) -> Option<String> {
    // Gate: multi-agent runtime feature must be enabled
    let config_path = dirs::home_dir()?.join(".zhishi").join("config.json");
    let config_content = std::fs::read_to_string(&config_path).ok()?;
    let cfg: serde_json::Value = serde_json::from_str(strip_bom(&config_content)).ok()?;
    if !cfg.get("multiAgentRuntime").and_then(|v| v.as_bool()).unwrap_or(false) {
        return None;
    }

    let sessions_path = dirs::home_dir()?.join(".zhishi").join("sessions.json");
    let content = std::fs::read_to_string(&sessions_path).ok()?;
    let sessions: serde_json::Value = serde_json::from_str(strip_bom(&content)).ok()?;
    let sessions_arr = sessions.as_array()?;

    for session in sessions_arr {
        if session.get("id").and_then(|v| v.as_str()) == Some(session_id) {
            if let Some(runtime) = session.get("runtime").and_then(|v| v.as_str()) {
                if runtime != "builtin" {
                    return Some(runtime.to_string());
                }
            }
            return None;
        }
    }
    None
}


/// v0.1.69 T13: Runtime invariant check on Sidecar reuse.
///
/// Under the v0.1.69 layered-snapshot model, a session's `runtime` is part of
/// its immutable identity (stamped at creation in sessions.json). The Sidecar
/// was spawned with ZHISHI_RUNTIME derived from the owner-aware priority
/// chain. These two MUST stay aligned for the lifetime of the Sidecar — a
/// cross-runtime session switch opens a new Tab (Scenario 1.5 / T12), it
/// doesn't swap the runtime under a live Sidecar.
///
/// If we detect a mismatch on a reuse path, it indicates either:
///   (a) T12's new-tab gate missed a case
///   (b) Session metadata was mutated post-creation (shouldn't happen)
///   (c) Two sessions with different runtimes ended up sharing a sidecar entry
///
/// We log loudly with `[sidecar][runtime-drift-on-reuse]` so the bug surfaces
/// in `grep` of unified logs, but do NOT kill the sidecar. Killing here could
/// orphan shared desktop owners whose SSE streams depend on it — the
/// invariant violation is worth investigating, not worth amplifying into a
/// user-visible regression. The IM-router drift check at
/// `kill_sidecar_if_runtime_differs` is still the correct place to kill, and
/// only fires when all owners are Agent-type.
fn validate_sidecar_runtime_invariant(
    session_id: &str,
    sidecar_runtime: Option<&str>,
    site: &str,
) {
    let sidecar_rt = sidecar_runtime.unwrap_or("builtin");
    let session_rt = resolve_session_runtime(session_id);
    let session_rt_str = session_rt.as_deref().unwrap_or("builtin");
    if sidecar_rt != session_rt_str {
        ulog_error!(
            "[sidecar][runtime-drift-on-reuse] session={} site={} sidecar_runtime={} session_runtime={} — T12 gate may have missed a case; not killing to avoid orphaning shared owners",
            session_id, site, sidecar_rt, session_rt_str
        );
    }
}
