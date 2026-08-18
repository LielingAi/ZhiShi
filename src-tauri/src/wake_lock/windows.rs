//! Windows wake-lock implementation via `PowerCreateRequest` (HANDLE-based).
//!
//! ## Why not `SetThreadExecutionState`
//!
//! The simpler `SetThreadExecutionState` API is **thread-scoped** despite the
//! "Thread" name being misleading — per MSDN: "this function only affects the
//! state of the calling thread." Our `WakeLock` is acquired inside a Tauri
//! async task that crosses `.await` points; the Tokio runtime may resume
//! `Drop` on a different worker thread than the one that called `acquire()`.
//! `SetThreadExecutionState(ES_CONTINUOUS)` on the wrong thread clears that
//! thread's state (a no-op) while the original thread's
//! `ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED` remains set — silently
//! leaking the wake-lock for the rest of the process lifetime.
//!
//! `PowerCreateRequest` returns a HANDLE that is **not thread-scoped**.
//! `PowerSetRequest` + `PowerClearRequest` operate on the HANDLE from any
//! thread, so the RAII Drop works correctly regardless of which Tokio
//! worker resumes it.
//!
//! ## Flag combination
//! - `PowerRequestSystemRequired`     — prevent idle sleep
//! - `PowerRequestAwayModeRequired`   — Windows 7+ "Away Mode"（机器"睡眠"时后台任务继续）
//!
//! Lid-close and explicit user sleep are not blocked — those obey the user's
//! Power Plan, which we don't touch.

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Power::{
    PowerClearRequest, PowerCreateRequest, PowerRequestAwayModeRequired,
    PowerRequestSystemRequired, PowerSetRequest,
};
// `REASON_CONTEXT` and friends live in `Win32::System::Threading` (the
// feature `Win32_System_Threading` is already enabled in Cargo.toml for
// pid-liveness probes). `POWER_REQUEST_CONTEXT_VERSION` itself lives in
// `Win32::System::SystemServices`; rather than pulling in that feature
// just for one `0u32` constant, inline the literal value.
use windows_sys::Win32::System::Threading::{
    POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
};

use crate::{ulog_debug, ulog_warn};

/// Win32 SDK constant: `POWER_REQUEST_CONTEXT_VERSION = 0`. Inlined to
/// avoid pulling `Win32_System_SystemServices` just for one literal.
const POWER_REQUEST_CONTEXT_VERSION: u32 = 0;

pub struct PlatformImpl {
    handle: HANDLE,
    /// True iff `PowerRequestAwayModeRequired` was successfully set.
    /// Older Windows / WinPE / non-AC scenarios can refuse away-mode while
    /// accepting `SystemRequired`; we track per-request so `Drop` only
    /// clears what we actually set.
    away_mode: bool,
    /// Backing storage for the UTF-16 reason string. The Win32 documentation
    /// is ambiguous about whether `PowerCreateRequest` copies the
    /// `SimpleReasonString` buffer; holding it for the HANDLE's lifetime is
    /// the cheap-and-safe move. Reads only — never reallocated.
    _reason_buf: Vec<u16>,
}

// SAFETY: `HANDLE` is a Win32 kernel-object handle, defined in windows-sys
// as `*mut c_void`. Raw pointers are `!Send` by default, but Win32
// power-request handles are documented as thread-agnostic — MSDN allows
// `PowerSetRequest` / `PowerClearRequest` / `CloseHandle` to be called
// from any thread on the same handle. Since `WakeLock` is RAII
// single-owner (the handle never has two simultaneous accessors), Send is
// exactly what we need: a future holding `WakeLock` across `.await` must
// be `Send` for `tauri::async_runtime::spawn` to accept it, and Drop
// must work on whichever Tokio worker resumes the future. We do NOT
// implement `Sync` — concurrent `&WakeLock` access is neither needed
// nor exposed by the API.
unsafe impl Send for PlatformImpl {}

impl PlatformImpl {
    pub fn acquire(reason: &str) -> Result<Self, String> {
        // Build NUL-terminated UTF-16 reason string.
        let mut reason_buf: Vec<u16> = reason.encode_utf16().collect();
        reason_buf.push(0);

        let reason_ctx = REASON_CONTEXT {
            Version: POWER_REQUEST_CONTEXT_VERSION,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 {
                SimpleReasonString: reason_buf.as_mut_ptr(),
            },
        };

        // SAFETY: reason_ctx is a properly-initialized REASON_CONTEXT pointing
        // at a valid wide-string buffer that we own. PowerCreateRequest takes
        // *const REASON_CONTEXT (read-only) and returns a HANDLE (or NULL
        // on failure).
        let handle = unsafe { PowerCreateRequest(&reason_ctx) };
        if handle.is_null() {
            return Err(format!(
                "PowerCreateRequest failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        // SAFETY: handle is a valid power-request HANDLE returned by
        // PowerCreateRequest above; the request type is a documented constant.
        let ok_sys = unsafe { PowerSetRequest(handle, PowerRequestSystemRequired) };
        if ok_sys == 0 {
            let err = std::io::Error::last_os_error();
            // Best-effort cleanup of the orphaned handle.
            unsafe { CloseHandle(handle) };
            return Err(format!("PowerSetRequest(SystemRequired) failed: {err}"));
        }

        // AwayModeRequired is best-effort — older Windows refuses it without
        // failing the whole acquire. Track for Drop symmetry.
        // SAFETY: same as above.
        let ok_away = unsafe { PowerSetRequest(handle, PowerRequestAwayModeRequired) };
        let away_mode = ok_away != 0;
        if !away_mode {
            ulog_debug!(
                "[wake-lock] Windows AwayModeRequired refused — system-required only (reason={:?})",
                reason
            );
        }

        ulog_debug!(
            "[wake-lock] Windows assertion acquired handle={:?} away_mode={} reason={:?}",
            handle,
            away_mode,
            reason
        );

        Ok(Self {
            handle,
            away_mode,
            _reason_buf: reason_buf,
        })
    }
}

impl Drop for PlatformImpl {
    fn drop(&mut self) {
        // Clear in the reverse order we set, then close the HANDLE. All three
        // calls are thread-agnostic so the runtime is free to resume Drop on
        // any worker — this is the whole reason we use Power* instead of
        // SetThreadExecutionState.
        unsafe {
            if self.away_mode {
                let ok = PowerClearRequest(self.handle, PowerRequestAwayModeRequired);
                if ok == 0 {
                    ulog_warn!(
                        "[wake-lock] PowerClearRequest(AwayMode) failed on handle={:?}: {}",
                        self.handle,
                        std::io::Error::last_os_error()
                    );
                }
            }
            let ok = PowerClearRequest(self.handle, PowerRequestSystemRequired);
            if ok == 0 {
                ulog_warn!(
                    "[wake-lock] PowerClearRequest(SystemRequired) failed on handle={:?}: {}",
                    self.handle,
                    std::io::Error::last_os_error()
                );
            }
            let ok = CloseHandle(self.handle);
            if ok == 0 {
                ulog_warn!(
                    "[wake-lock] CloseHandle failed on handle={:?}: {}",
                    self.handle,
                    std::io::Error::last_os_error()
                );
            }
        }
        ulog_debug!("[wake-lock] Windows assertion released handle={:?}", self.handle);
    }
}
