//! Centralized child process utilities for GUI applications.
//!
//! **All** child processes spawned from the app MUST use `process_cmd::new()`
//! instead of raw `std::process::Command::new()`. This guarantees
//! `CREATE_NO_WINDOW` (0x08000000) is set on Windows, preventing console
//! windows from flashing when spawning background processes (e.g., bun.exe
//! Sidecars, Plugin Bridge, `bun init`/`bun add`).
//!
//! This follows the same "pit of success" pattern as [`crate::local_http`]:
//! the correct platform behavior is the default — callers don't need to
//! remember per-platform flags.
//!
//! ## Usage
//!
//! ```rust,ignore
//! use crate::process_cmd;
//!
//! let mut cmd = process_cmd::new("bun");
//! cmd.arg("run").arg("script.ts");
//! let child = cmd.spawn()?;
//! ```

use std::ffi::OsStr;
use std::process::Command;

/// Create a new [`Command`] with platform-specific GUI flags applied.
///
/// On Windows: Sets `CREATE_NO_WINDOW` (0x08000000) to prevent visible
/// console windows for background child processes.
///
/// On other platforms: Equivalent to `Command::new(program)`.
pub fn new<S: AsRef<OsStr>>(program: S) -> Command {
    #[allow(unused_mut)] // mut needed on Windows for creation_flags()
    #[allow(clippy::disallowed_methods)] // this IS the wrapper — see clippy.toml
    let mut cmd = Command::new(program);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd
}
