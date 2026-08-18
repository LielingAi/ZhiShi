//! Centralized system binary discovery for GUI applications.
//!
//! **All** system binary lookups MUST use `system_binary::find()` instead of
//! raw `which::which()`. Tauri apps launched from Finder/launchd don't inherit
//! shell PATH (no `/opt/homebrew/bin`, `/usr/local/bin`, etc.), so bare
//! `which::which("npm")` fails even when npm is installed.
//!
//! This follows the same "pit of success" pattern as [`crate::local_http`]
//! and [`crate::process_cmd`]: the correct behavior is the default — callers
//! don't need to remember platform-specific PATH augmentation.
//!
//! ## Usage
//!
//! ```rust,ignore
//! use crate::system_binary;
//!
//! if let Some(npm) = system_binary::find("npm") {
//!     let mut cmd = process_cmd::new(&npm);
//!     cmd.arg("install").arg("some-package");
//! }
//! ```

use std::path::PathBuf;

/// Common binary directories that may be missing from the GUI process PATH.
/// macOS: Finder launch inherits only `/usr/bin:/bin:/usr/sbin:/sbin`.
/// These entries are appended (not prepended) to preserve existing PATH priority.
#[cfg(not(target_os = "windows"))]
const EXTRA_SEARCH_DIRS: &[&str] = &[
    "/opt/homebrew/bin",   // macOS Apple Silicon homebrew
    "/opt/homebrew/sbin",
    "/usr/local/bin",      // macOS Intel homebrew / Linux manual installs
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
];

/// User-relative directories that require $HOME expansion at runtime.
/// e.g., `~/.local/bin` is where `claude` (Claude Code CLI) is installed globally.
#[cfg(not(target_os = "windows"))]
const USER_RELATIVE_DIRS: &[&str] = &[
    ".local/bin",          // Claude Code CLI global install (`claude`)
    ".bun/bin",            // Bun global installs
];

/// Find a system binary by name, searching both the process PATH and common
/// system directories that GUI apps may miss.
///
/// Returns the full path to the binary, or `None` if not found anywhere.
pub fn find(binary_name: &str) -> Option<PathBuf> {
    // Build augmented search path: process PATH + platform-specific extras
    let search_path = augmented_path();

    which::which_in(binary_name, Some(&search_path), ".")
        .ok()
}

/// Build an augmented PATH string that includes common system binary directories.
/// Useful when spawning subprocesses that need the full search path.
pub fn augmented_path() -> std::ffi::OsString {
    let system_path = std::env::var("PATH").unwrap_or_default();
    let sep = if cfg!(windows) { ";" } else { ":" };
    // mut needed on non-Windows (EXTRA_SEARCH_DIRS / USER_RELATIVE_DIRS push below)
    #[allow(unused_mut)]
    let mut parts: Vec<String> = system_path.split(sep).map(|s| s.to_string()).collect();

    #[cfg(not(target_os = "windows"))]
    {
        // Static system directories
        for dir in EXTRA_SEARCH_DIRS {
            let d = dir.to_string();
            if !parts.contains(&d) {
                parts.push(d);
            }
        }

        // User-relative directories (expand $HOME)
        if let Some(home) = dirs::home_dir() {
            for rel in USER_RELATIVE_DIRS {
                let abs = home.join(rel).to_string_lossy().to_string();
                if !parts.contains(&abs) {
                    parts.push(abs);
                }
            }
        }

        // Shell-detected PATH: covers custom directories from .zshrc/.bashrc
        // (NVM, fnm, Codex.app, custom PATHs, etc.) that the fixed list above misses.
        if let Some(shell_path) = detect_shell_path() {
            for dir in shell_path.split(':') {
                let d = dir.to_string();
                if !d.is_empty() && !parts.contains(&d) {
                    parts.push(d);
                }
            }
        }
    }

    std::env::join_paths(parts).unwrap_or_default()
}

/// Detect the user's full shell PATH by spawning an interactive login shell.
///
/// GUI apps (Tauri/Finder) inherit a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`).
/// Tools installed via NVM, fnm, app bundles (e.g., `/Applications/Codex.app/...`),
/// or custom PATH entries in .zshrc are invisible to the hardcoded directory list.
///
/// This mirrors the TypeScript `getShellPath()` in `src/server/utils/shell.ts`:
/// spawns `$SHELL -i -l -c 'echo $PATH'` with marker extraction to handle
/// noisy .zshrc output (p10k, oh-my-zsh banners, conda, etc.).
///
/// Cached via `OnceLock` — only spawns once per process lifetime.
#[cfg(not(target_os = "windows"))]
fn detect_shell_path() -> Option<String> {
    use std::sync::OnceLock;
    static CACHED: OnceLock<Option<String>> = OnceLock::new();

    CACHED.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let marker = format!("__ZHISHI_PATH_{}__", std::process::id());
        // NOTE: ${PATH} (braced) is required — unbraced $PATH__MARKER__ would be
        // parsed as a single variable name because underscores are valid identifiers.
        let script = format!("echo \"{marker}${{PATH}}{marker}\"");

        // Spawn with timeout to guard against .zshrc that launches tmux/screen.
        let mut child = match crate::process_cmd::new(&shell)
            .args(["-i", "-l", "-c", &script])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => return None,
        };

        // 3-second timeout (matches TypeScript getShellPath)
        let output = {
            use std::time::{Duration, Instant};
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break child.wait_with_output(),
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return None;
                    }
                }
            }
        };

        match output {
            Ok(out) if out.status.success() => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                // Extract PATH from between markers (immune to noisy shell output)
                let start_tag = &marker;
                let end_tag = &marker;
                if let Some(start) = stdout.find(start_tag) {
                    let after_start = start + start_tag.len();
                    if let Some(end) = stdout[after_start..].find(end_tag) {
                        let path = &stdout[after_start..after_start + end];
                        if path.len() > 10 {
                            return Some(path.to_string());
                        }
                    }
                }
                None
            }
            _ => None,
        }
    }).clone()
}
