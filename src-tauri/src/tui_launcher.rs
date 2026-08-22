//! TUI session launcher (1.2.3) — "click the app icon → an agent TUI terminal opens".
//!
//! The product is a windowless background host (tray + APIs); the interactive
//! surface is the CLI/TUI (`zhishi agent`). This module wires the three entry
//! points that used to dead-end in the windowless host to a real action:
//!
//! 1. App launch (non `--minimized`) — lib.rs `setup()` calls
//!    [`open_tui_session`] once the sidecar can be ensured.
//! 2. Second-instance click (taskbar/dock icon while running) — the
//!    single_instance callback calls [`spawn_open_tui`] (the old
//!    `tray::show_main_window` was a deliberate no-op with no window).
//! 3. Tray left-click / "Open Session" menu item — tray.rs calls
//!    [`spawn_open_tui`].
//!
//! It also restores the CLI install chain removed in W6: [`sync_cli_resources`]
//! mirrors `resources/cli/` into `<data-dir>/bin/` so the `zhishi` command
//! exists on a fresh machine.
//!
//! Blocking note: [`open_tui_session`] calls `start_global_sidecar`, which uses
//! `reqwest::blocking` internally — never call it on the async runtime or the
//! Tauri main thread. Use [`spawn_open_tui`] from those contexts.

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, Manager, Runtime};

use crate::app_dirs;
use crate::sidecar::{self, ManagedSidecarManager};
use crate::{ulog_error, ulog_info, ulog_warn};

/// Files mirrored from `resources/cli/` into `<data-dir>/bin/`.
/// (`source name in resources`, `installed name`).
///
/// `zhishi.js` installs as the extensionless `zhishi`: the Windows wrapper
/// (`zhishi.cmd`) invokes `"%~dp0zhishi"`, and on Unix the file IS the
/// `zhishi` command (shebang `#!/usr/bin/env node`). `package.json`
/// (`{"type":"module"}`) must sit next to it so Node treats the extensionless
/// file as ESM (1.2.3 #5 switched the bundle to ESM).
const CLI_FILES: &[(&str, &str)] = &[
    ("zhishi.js", "zhishi"),
    ("zhishi.cmd", "zhishi.cmd"),
    ("package.json", "package.json"),
];

/// Mirror `resources/cli/` into `<data-dir>/bin/`, skipping files whose
/// content already matches. Idempotent; safe to call on every launch.
///
/// Chosen over self-healing inside `cli::find_cli_script`: that path runs
/// pre-Tauri (no `AppHandle`, no reliable dev-mode `resource_dir`), while
/// `setup()` has both. cli.rs keeps its "launch the app once" error hint.
pub fn sync_cli_resources<R: Runtime>(app: &AppHandle<R>) {
    let resource_dir = match app.path().resource_dir() {
        Ok(dir) => sidecar::normalize_external_path(dir),
        Err(e) => {
            ulog_warn!("[tui-launcher] resource_dir() failed, CLI sync skipped: {}", e);
            return;
        }
    };
    let src_dir = resource_dir.join("cli");
    if !src_dir.is_dir() {
        // Dev builds don't copy bundle resources into target/debug — running
        // from the repo uses src/cli directly, so a missing dir is fine.
        ulog_warn!("[tui-launcher] {:?} not found, CLI sync skipped (dev build?)", src_dir);
        return;
    }
    let Some(data_dir) = app_dirs::zhishi_data_dir() else {
        ulog_warn!("[tui-launcher] no data dir, CLI sync skipped");
        return;
    };
    let bin_dir = data_dir.join("bin");
    if let Err(e) = std::fs::create_dir_all(&bin_dir) {
        ulog_error!("[tui-launcher] failed to create {:?}: {}", bin_dir, e);
        return;
    }
    for (src_name, dst_name) in CLI_FILES {
        let src = src_dir.join(src_name);
        let dst = bin_dir.join(dst_name);
        let Ok(content) = std::fs::read(&src) else {
            ulog_warn!("[tui-launcher] {:?} unreadable, skipped", src);
            continue;
        };
        // Content-compare skip: rewriting a ~1.4 MB bundle on every launch
        // would churn Defender scans for nothing.
        if std::fs::read(&dst).map(|old| old == content).unwrap_or(false) {
            continue;
        }
        match std::fs::write(&dst, &content) {
            Ok(()) => ulog_info!("[tui-launcher] installed CLI file {:?}", dst),
            Err(e) => {
                ulog_error!("[tui-launcher] failed to write {:?}: {}", dst, e);
                continue;
            }
        }
        // Unix: the extensionless script is executed directly → needs +x.
        #[cfg(unix)]
        if *dst_name == "zhishi" {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755));
        }
    }
}

/// Directory the spawned TUI terminal starts in — this IS the session
/// workspace: `zhishi agent` uses `process.cwd()` as `agentDir`
/// (src/cli/zhishi.ts), and the sidecar binds the session to it.
///
/// Resolution: first `enabled` agent's `workspacePath` from config.json that
/// still exists on disk (an agent IS "an upgraded workspace" — the most
/// meaningful default we have); otherwise the user's home directory (neutral,
/// always writable). There is no reliable "most recently active project"
/// signal left in the windowless host, so we don't guess one.
fn default_workspace_dir() -> PathBuf {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PartialAgent {
        enabled: Option<bool>,
        workspace_path: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct PartialConfig {
        agents: Option<Vec<PartialAgent>>,
    }

    if let Some(dir) = app_dirs::zhishi_data_dir() {
        if let Ok(content) = std::fs::read_to_string(dir.join("config.json")) {
            if let Ok(cfg) =
                serde_json::from_str::<PartialConfig>(crate::utils::bom::strip_bom(&content))
            {
                if let Some(agents) = cfg.agents {
                    for agent in agents {
                        if agent.enabled.unwrap_or(false) {
                            if let Some(ws) = agent.workspace_path {
                                let path = PathBuf::from(ws);
                                if path.is_dir() {
                                    return path;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Spawn the open-TUI flow on a blocking worker. Safe from the Tauri main
/// thread (tray events, single_instance callback) and from async tasks.
pub fn spawn_open_tui<R: Runtime>(app: AppHandle<R>, manager: ManagedSidecarManager, reason: &'static str) {
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            open_tui_session(&app, &manager, reason);
        })
        .await;
        if let Err(e) = result {
            ulog_error!("[tui-launcher] open_tui worker join failed: {}", e);
        }
    });
}

/// Ensure the Global Sidecar is running, then open an OS terminal window
/// running `zhishi agent` against it. Blocking — see module docs.
///
/// The TUI only needs the Global Sidecar: it POSTs `/sessions` there and the
/// session is created in-process (src/server/routes/sessions.ts), so no
/// per-workspace `ensure_session_sidecar` is required on this path.
pub fn open_tui_session<R: Runtime>(app: &AppHandle<R>, manager: &ManagedSidecarManager, reason: &str) {
    ulog_info!("[tui-launcher] opening TUI session (reason: {})", reason);

    // Idempotent: returns the existing healthy port when already running.
    let port = match sidecar::start_global_sidecar(app, manager) {
        Ok(port) => port,
        Err(e) => {
            ulog_error!("[tui-launcher] global sidecar unavailable, TUI not opened: {}", e);
            return;
        }
    };

    let Some(bin_dir) = app_dirs::zhishi_data_dir().map(|d| d.join("bin")) else {
        ulog_error!("[tui-launcher] no data dir, TUI not opened");
        return;
    };
    if let Err(e) = sync_check_installed(&bin_dir) {
        ulog_error!("[tui-launcher] CLI not installed ({}), TUI not opened", e);
        return;
    }

    let cwd = default_workspace_dir();
    match spawn_terminal(&bin_dir, &cwd, port) {
        Ok(()) => ulog_info!("[tui-launcher] TUI terminal spawned (port {}, cwd {:?})", port, cwd),
        Err(e) => ulog_error!("[tui-launcher] failed to spawn terminal: {}", e),
    }
}

/// The launcher only works against an installed CLI — refuse to open a
/// terminal that would instantly die with "file not found".
fn sync_check_installed(bin_dir: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    let launcher = bin_dir.join("zhishi.cmd");
    #[cfg(not(windows))]
    let launcher = bin_dir.join("zhishi");
    if launcher.is_file() {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("{:?} missing", launcher),
        ))
    }
}

/// Environment shared by all platform spawns: sidecar port, data dir
/// (portable mode), and localhost proxy protection — mirrors cli.rs::run().
fn apply_cli_env(cmd: &mut Command, port: u16) {
    cmd.env("ZHISHI_PORT", port.to_string());
    if let Some(data_dir) = app_dirs::zhishi_data_dir() {
        cmd.env("ZHISHI_DATA_DIR", data_dir.to_string_lossy().as_ref());
    }
    cmd.env("NO_PROXY", crate::proxy_config::LOCALHOST_NO_PROXY);
    cmd.env("no_proxy", crate::proxy_config::LOCALHOST_NO_PROXY);
}

/// Open an OS terminal window running the agent TUI. Returns after the
/// launcher process is spawned (the terminal window is independent).
#[cfg(windows)]
fn spawn_terminal(bin_dir: &Path, cwd: &Path, port: u16) -> std::io::Result<()> {
    // `cmd /c start` allocates a NEW console window for the TUI — the inverse
    // of the cli.rs "CLI mode NEEDS the console" note: here the console window
    // is the whole point. Raw Command (not process_cmd) for the same reason —
    // CREATE_NO_WINDOW would defeat it.
    //
    // `cmd /k` keeps the window open if the CLI exits immediately (missing
    // provider config etc.), so the error stays readable instead of flashing.
    let zhishi_cmd = bin_dir.join("zhishi.cmd");
    let line = format!(
        "start \"ZhiShi Agent\" /D \"{}\" cmd /k \"\"{}\" agent\"",
        cwd.display(),
        zhishi_cmd.display()
    );
    #[allow(clippy::disallowed_methods)] // see comment above — we WANT a console window
    let mut cmd = Command::new("cmd");
    cmd.arg("/c").arg(line);
    apply_cli_env(&mut cmd, port);
    // zhishi.cmd locates node.exe via PATH — inject the bundled runtime dir.
    if let Some(node) = crate::cli::find_node_binary() {
        if let Some(node_dir) = node.parent() {
            let path = std::env::var("PATH").unwrap_or_default();
            cmd.env("PATH", format!("{};{}", node_dir.display(), path));
        }
    }
    cmd.spawn().map(|_| ())
}

/// macOS: ask Terminal.app to run the TUI. NOT verified on real hardware in
/// this change (dev machine is Windows) — the AppleScript quoting is the part
/// to check first.
#[cfg(target_os = "macos")]
fn spawn_terminal(bin_dir: &Path, cwd: &Path, port: u16) -> std::io::Result<()> {
    let zhishi = bin_dir.join("zhishi");
    let shell_line = format!(
        "cd {} && ZHISHI_PORT={} {} exec {} agent",
        shell_quote(cwd),
        port,
        data_dir_assignment(),
        shell_quote(&zhishi),
    );
    // Escape for embedding inside an AppleScript "..." literal.
    let escaped = shell_line.replace('\\', "\\\\").replace('"', "\\\"");
    #[allow(clippy::disallowed_methods)] // OS opener — same exception as open/explorer/xdg-open
    let mut cmd = Command::new("osascript");
    cmd.arg("-e")
        .arg(format!("tell application \"Terminal\" to do script \"{}\"", escaped));
    apply_cli_env(&mut cmd, port);
    cmd.spawn().map(|_| ())
}

/// Linux: first available terminal emulator. NOT verified on real hardware in
/// this change (dev machine is Windows).
#[cfg(all(not(windows), not(target_os = "macos")))]
fn spawn_terminal(bin_dir: &Path, cwd: &Path, port: u16) -> std::io::Result<()> {
    let zhishi = bin_dir.join("zhishi");
    let shell_line = format!(
        "cd {} && ZHISHI_PORT={} {} exec {} agent",
        shell_quote(cwd),
        port,
        data_dir_assignment(),
        shell_quote(&zhishi),
    );
    // (binary, takes `-e sh -c <line>` style args)
    const CANDIDATES: &[&str] = &["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"];
    let mut last_err: Option<std::io::Error> = None;
    for term in CANDIDATES {
        #[allow(clippy::disallowed_methods)] // OS opener — same exception as xdg-open
        let mut cmd = Command::new(term);
        cmd.arg("-e").arg("sh").arg("-c").arg(&shell_line);
        apply_cli_env(&mut cmd, port);
        match cmd.spawn() {
            Ok(_) => return Ok(()),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "no terminal emulator found")
    }))
}

/// Minimal POSIX single-quote escaping for paths embedded in shell lines.
#[cfg(unix)]
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

/// `ZHISHI_DATA_DIR='...' ` prefix for the unix shell line (portable mode).
#[cfg(unix)]
fn data_dir_assignment() -> String {
    app_dirs::zhishi_data_dir()
        .map(|d| format!("ZHISHI_DATA_DIR={} ", shell_quote(&d)))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    // default_workspace_dir picks the first enabled agent whose workspace
    // exists; disabled agents and dead paths are skipped. (Uses a temp data
    // dir via ZHISHI_DATA_DIR — the resolver's highest-priority source.)
    #[test]
    fn default_workspace_prefers_enabled_agent() {
        let data = tempfile::tempdir().unwrap();
        let ws_disabled = tempfile::tempdir().unwrap();
        let ws_enabled = tempfile::tempdir().unwrap();
        std::fs::write(
            data.path().join("config.json"),
            format!(
                r#"{{"agents":[
                    {{"enabled":false,"workspacePath":"{}"}},
                    {{"enabled":true,"workspacePath":"/nonexistent/dead-path"}},
                    {{"enabled":true,"workspacePath":"{}"}}
                ]}}"#,
                ws_disabled.path().display().to_string().replace('\\', "\\\\"),
                ws_enabled.path().display().to_string().replace('\\', "\\\\"),
            ),
        )
        .unwrap();
        std::env::set_var("ZHISHI_DATA_DIR", data.path());
        let picked = default_workspace_dir();
        std::env::remove_var("ZHISHI_DATA_DIR");
        assert_eq!(picked, ws_enabled.path());
    }

    // No agents at all → home dir fallback (never panics, never empty).
    #[test]
    fn default_workspace_falls_back_to_home() {
        let data = tempfile::tempdir().unwrap();
        std::fs::write(data.path().join("config.json"), r#"{"agents":[]}"#).unwrap();
        std::env::set_var("ZHISHI_DATA_DIR", data.path());
        let picked = default_workspace_dir();
        std::env::remove_var("ZHISHI_DATA_DIR");
        assert_eq!(picked, dirs::home_dir().unwrap());
    }
}
