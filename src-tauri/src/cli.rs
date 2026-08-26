//! CLI mode handler for `zhishi` binary.
//!
//! When the binary is invoked with CLI arguments (mcp, model, status, --help, etc.),
//! it runs in CLI mode instead of starting the GUI. This avoids:
//! 1. Killing running sidecar processes (cleanup_stale_sidecars runs in GUI .setup())
//! 2. Triggering single-instance window focus
//! 3. Starting the full Tauri app just for a CLI query
//!
//! The CLI forwards arguments to the bundled Node.js + esbuild'd CLI script at
//! ~/.zhishi/bin/zhishi (JavaScript, shebang `#!/usr/bin/env node`). The
//! script handles argument parsing, HTTP requests to the Sidecar Admin API, and
//! output formatting.

use std::path::PathBuf;
use std::process::{Command, Stdio};

/// CLI subcommands that trigger CLI mode
///
/// Keep this list in sync with the command groups in `src/cli/zhishi.ts` TOP_HELP.
/// Missing commands silently take the GUI launch path, which looks like "my command
/// was ignored" to a terminal user — the exact failure mode this whole CLI was
/// designed to avoid for AI callers.
const CLI_COMMANDS: &[&str] = &[
    "mcp", "model", "agent", "config", "status", "reload", "version",
    "skill", "task", "widget",
    // Env / domain / research / intel / expert / help — added 2026-08-26 audit
    // (B1): these command groups exist in zhishi.ts TOP_HELP but were missing
    // here, so `ZhiShi.exe expert list` silently launched the GUI.
    "env", "domain", "research", "intel", "expert", "help",
    // Panel API / memory — added 2026-08-06 audit (F-05): these existed in
    // zhishi.ts for a long time but were missing here, so terminal invocation
    // silently launched the GUI. ("browser" was removed in the W6 subtraction —
    // the embedded browser is gone. "appcraft" removed in 1.2.3 — AppCraft
    // 桌面自动化整体退役。)
    "term", "memory",
];

/// Check if the given args indicate CLI mode.
/// Returns true if any argument is a known CLI subcommand or --help/-h.
pub fn is_cli_mode(args: &[String]) -> bool {
    args.iter().any(|a| {
        CLI_COMMANDS.contains(&a.as_str()) || a == "--help" || a == "-h"
    })
}

/// Run the CLI by forwarding args to the Node CLI script.
/// Returns the process exit code.
pub fn run(args: &[String]) -> i32 {
    // On Windows, re-attach to parent console so stdout/stderr are visible.
    // The `windows_subsystem = "windows"` attribute suppresses the console for GUI mode,
    // but CLI mode needs it.
    #[cfg(windows)]
    {
        extern "system" {
            fn AttachConsole(dwProcessId: u32) -> i32;
        }
        const ATTACH_PARENT_PROCESS: u32 = 0xFFFFFFFF;
        unsafe {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }

    // 1. Find the bundled Node.js binary (installed under resources/nodejs/)
    let node_path = match find_node_binary() {
        Some(p) => p,
        None => {
            eprintln!("Error: Cannot find bundled Node.js runtime.");
            return 1;
        }
    };

    // 2. Find the CLI script at <data-dir>/bin/zhishi
    let cli_script = match find_cli_script() {
        Some(p) => p,
        None => {
            eprintln!("Error: CLI script not found at <zhishi-data-dir>/bin/zhishi");
            eprintln!("Please launch the ZhiShi app at least once to initialize the CLI.");
            return 1;
        }
    };

    // 3. Discover the Global Sidecar port from the port file
    let port = discover_sidecar_port();

    // 4. Spawn Node.js on the CLI script with all original args.
    // NOTE: Intentionally using raw Command::new instead of process_cmd::new().
    // process_cmd applies CREATE_NO_WINDOW on Windows, but CLI mode NEEDS the
    // console for user-visible stdout/stderr output. Same exception category as
    // OS opener commands (open/explorer/xdg-open) documented in CLAUDE.md.
    #[allow(clippy::disallowed_methods)] // see comment above — CLI needs console
    let mut cmd = Command::new(&node_path);
    cmd.arg(&cli_script);
    cmd.args(args);

    // Inherit stdio so the user sees output directly
    cmd.stdin(Stdio::inherit());
    cmd.stdout(Stdio::inherit());
    cmd.stderr(Stdio::inherit());

    // Inject sidecar port if available (the Node script reads ZHISHI_PORT)
    if let Some(ref p) = port {
        cmd.env("ZHISHI_PORT", p);
    }

    // Inject data directory so CLI scripts resolve the same path
    // as the main process (critical for USB portable mode).
    if let Some(data_dir) = crate::app_dirs::zhishi_data_dir() {
        cmd.env("ZHISHI_DATA_DIR", data_dir.to_string_lossy().as_ref());
    }

    // Protect localhost from system proxy (Node's fetch() reads HTTP_PROXY)
    cmd.env("NO_PROXY", crate::proxy_config::LOCALHOST_NO_PROXY);
    cmd.env("no_proxy", crate::proxy_config::LOCALHOST_NO_PROXY);

    match cmd.status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(e) => {
            eprintln!("Error: Failed to execute CLI: {}", e);
            1
        }
    }
}

/// Find the bundled Node.js binary, shipped as a resource alongside the app.
/// macOS: /Applications/ZhiShi.app/Contents/Resources/nodejs/bin/node
/// Windows: <install-dir>/resources/nodejs/node.exe
/// Linux (AppImage / deb): <install-dir>/resources/nodejs/bin/node
///
/// Only used by [`run`] to spawn the bundled Node.js on the CLI script.
fn find_node_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;

    // macOS: Contents/MacOS/app → Contents/Resources/nodejs/bin/node
    #[cfg(target_os = "macos")]
    {
        let macos_node = dir
            .parent()
            .map(|p| p.join("Resources").join("nodejs").join("bin").join("node"))
            .unwrap_or_else(|| dir.join("Resources").join("nodejs").join("bin").join("node"));
        if macos_node.exists() {
            return Some(macos_node);
        }
    }

    // Windows: <install-dir>/resources/nodejs/node.exe (or sibling when layout differs)
    #[cfg(target_os = "windows")]
    {
        let win_node = dir.join("resources").join("nodejs").join("node.exe");
        if win_node.exists() {
            return Some(win_node);
        }
        let sibling = dir.join("nodejs").join("node.exe");
        if sibling.exists() {
            return Some(sibling);
        }
    }

    // Linux + Unix fallback (skipped on macOS + Windows — each platform's branch above
    // returns early on success; those platforms don't have this layout).
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let linux_node = dir.join("resources").join("nodejs").join("bin").join("node");
        if linux_node.exists() {
            return Some(linux_node);
        }
        let sibling_unix = dir.join("nodejs").join("bin").join("node");
        if sibling_unix.exists() {
            return Some(sibling_unix);
        }
    }

    None
}

/// Find the CLI script at `<data-dir>/bin/zhishi`.
/// The script is the esbuild bundle of src/cli/, installed by
/// `cli_launcher::sync_cli_resources` at app startup (the old in-app
/// `cmd_sync_cli` sync path was removed in W6; restored in 1.2.3).
///
/// Resolves via `app_dirs::zhishi_data_dir()` so USB portable mode finds the
/// exe-side install; falls back to `~/.zhishi/bin` for installs written before
/// the data-dir-aware sync existed.
fn find_cli_script() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = crate::app_dirs::zhishi_data_dir() {
        dirs.push(dir);
    }
    if let Some(home) = dirs::home_dir() {
        let legacy = home.join(".zhishi");
        if !dirs.contains(&legacy) {
            dirs.push(legacy);
        }
    }

    for dir in dirs {
        let bin = dir.join("bin");
        // Primary: <dir>/bin/zhishi
        let script = bin.join("zhishi");
        if script.exists() {
            return Some(script);
        }
        // Windows: <dir>/bin/zhishi.cmd
        #[cfg(windows)]
        {
            let cmd_script = bin.join("zhishi.cmd");
            if cmd_script.exists() {
                return Some(cmd_script);
            }
        }
    }

    None
}

/// Read the Global Sidecar port from `<data-dir>/sidecar.port`.
/// This file is written by sidecar.rs when the Global Sidecar starts.
/// Validates the port is a valid u16 to guard against stale/corrupt files.
fn discover_sidecar_port() -> Option<String> {
    let port_file = crate::app_dirs::zhishi_data_dir()?.join("sidecar.port");
    let content = std::fs::read_to_string(port_file).ok()?;
    let port = content.trim().to_string();
    // Validate: must be a valid port number (1-65535)
    if port.parse::<u16>().is_ok() {
        Some(port)
    } else {
        None
    }
}
