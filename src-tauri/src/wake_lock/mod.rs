//! Cross-platform wake-lock to prevent idle sleep during long-running tasks.
//!
//! Cron tasks (especially long-running ones like `/issue-triage`) can stall
//! when the host enters idle sleep: TCP streams to the Anthropic API die,
//! the SDK never detects the dead socket, and the 10-minute watchdog kills
//! the turn. Real incident: 2026-05-19 19:11–19:26, see
//! `~/.zhishi/logs/unified-2026-05-19.log`.
//!
//! ## What this prevents
//!
//! Only **idle sleep** — the OS deciding the user is idle and putting the
//! machine to sleep on its own. User-initiated sleep (closing the lid,
//! pressing the power button, choosing Sleep from the menu) is **not**
//! blockable on any of the three platforms without elevated privileges,
//! and we don't try.
//!
//! ## Per-platform behavior
//!
//! | Platform | Mechanism | Limit |
//! |----------|-----------|-------|
//! | macOS    | `IOPMAssertionCreateWithName` with `kIOPMAssertionTypePreventUserIdleSystemSleep` | Lid close still sleeps |
//! | Windows  | `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED \| ES_AWAYMODE_REQUIRED)` | Power Plan lid setting wins |
//! | Linux    | `systemd-inhibit --what=idle:sleep --mode=block <holder>` child | Requires systemd-logind; otherwise no-op |
//! | other    | No-op | — |
//!
//! ## Usage
//!
//! ```rust,ignore
//! use crate::wake_lock::WakeLock;
//!
//! async fn run_cron(task: &CronTask) {
//!     let _lock = WakeLock::acquire(&format!("cron task {}", task.id)).ok();
//!     // _lock is dropped at end of scope, releasing the assertion.
//!     do_work().await;
//! }
//! ```
//!
//! `.ok()` is intentional — wake-lock failure should never abort the caller.
//! A non-acquired lock is functionally identical to "just running without
//! wake-lock", which is what we had before this module.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "macos")]
use macos::PlatformImpl;
#[cfg(target_os = "windows")]
use windows::PlatformImpl;
#[cfg(target_os = "linux")]
use linux::PlatformImpl;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod noop {
    pub struct PlatformImpl;
    impl PlatformImpl {
        pub fn acquire(_reason: &str) -> Result<Self, String> {
            Ok(Self)
        }
    }
}
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
use noop::PlatformImpl;

/// RAII handle to a system-level "stay awake" assertion.
///
/// Hold an instance for as long as the wake-lock should be active. Drop
/// releases it automatically. Cloning is not supported — multiple
/// concurrent holders should each call [`acquire`](Self::acquire).
pub struct WakeLock {
    // Underscore-prefixed because the value's role is its Drop side effect,
    // not anything the caller reads. Suppresses the unused-field warning
    // on platforms whose impl is zero-sized.
    #[allow(dead_code)]
    _inner: PlatformImpl,
}

impl WakeLock {
    /// Acquire a wake-lock. `reason` is a human-readable string surfaced
    /// to the OS (visible in `pmset -g assertions` on macOS, etc.).
    pub fn acquire(reason: &str) -> Result<Self, String> {
        let inner = PlatformImpl::acquire(reason)?;
        Ok(Self { _inner: inner })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test: acquire + drop should not crash on any supported
    /// platform. Does not assert the OS-level effect (that requires
    /// `pmset -g assertions` on macOS, `powercfg /requests` on Windows,
    /// `systemd-inhibit --list` on Linux — out of scope for cargo test).
    #[test]
    fn acquire_and_release_smoke() {
        let lock = WakeLock::acquire("cargo test smoke")
            .expect("acquire should succeed on a healthy platform");
        // Drop point: explicit so the test name reads top-to-bottom.
        drop(lock);
    }

    /// Holding two locks concurrently must not interfere — each gets its
    /// own assertion / inhibit handle and releases independently.
    #[test]
    fn multiple_concurrent_locks() {
        let a = WakeLock::acquire("smoke A").expect("A");
        let b = WakeLock::acquire("smoke B").expect("B");
        drop(a);
        drop(b);
    }
}
