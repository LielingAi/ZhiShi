//! Linux wake-lock implementation via `systemd-inhibit`.
//!
//! Spawns `systemd-inhibit --what=idle:sleep --mode=block ... sleep infinity`
//! and holds the child PID. systemd-logind keeps the inhibit lock alive
//! until the child exits; killing the child on Drop releases it.
//!
//! ## Why a subprocess instead of D-Bus
//!
//! The standard programmatic path is `org.freedesktop.login1.Manager.Inhibit`
//! over D-Bus, but that requires pulling in `zbus` (~30 transitive deps).
//! Shelling out to `systemd-inhibit` is the documented user-facing way to
//! do exactly the same thing and costs zero new dependencies — we already
//! have `process_cmd::new()` and `system_binary::find()`.
//!
//! ## Fallback
//!
//! Non-systemd Linux (Alpine, Void minimal, some containers) lacks
//! `systemd-inhibit`. In that case we return a no-op handle — the cron
//! task still runs, just without idle-sleep protection. This matches the
//! pre-wake-lock behavior, so there's no regression.

use std::process::{Child, Stdio};
use std::sync::Mutex;

use crate::{process_cmd, system_binary, ulog_debug, ulog_warn};

pub struct PlatformImpl {
    // `Mutex` only because `Drop` needs `&mut self` access to the child
    // handle but the lock itself is uncontended (single-owner RAII type).
    // `None` means "no inhibit binary available, no-op fallback".
    child: Mutex<Option<Child>>,
}

impl PlatformImpl {
    pub fn acquire(reason: &str) -> Result<Self, String> {
        let inhibit_bin = match system_binary::find("systemd-inhibit") {
            Some(p) => p,
            None => {
                ulog_debug!(
                    "[wake-lock] Linux: systemd-inhibit not found, running as no-op (reason={:?})",
                    reason
                );
                return Ok(Self {
                    child: Mutex::new(None),
                });
            }
        };

        // `sleep infinity` is BusyBox/coreutils-compatible (BusyBox accepts
        // "inf"/"infinity"). On the rare Linux without `sleep infinity`
        // support, the spawn succeeds but the child exits immediately and
        // the inhibit releases — same as the no-systemd fallback above.
        //
        // `proxy_config::apply_to_subprocess` is intentionally skipped:
        // systemd-inhibit + sleep do zero network I/O, so the HTTP_PROXY
        // inheritance the helper guards against is irrelevant here.
        let mut cmd = process_cmd::new(&inhibit_bin);
        cmd.arg("--what=idle:sleep")
            .arg("--who=ZhiShi")
            .arg(format!("--why={}", reason.replace('"', "'")))
            .arg("--mode=block")
            .arg("sleep")
            .arg("infinity")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let child = cmd
            .spawn()
            .map_err(|e| format!("spawn systemd-inhibit: {e}"))?;

        ulog_debug!(
            "[wake-lock] Linux assertion acquired: pid={} reason={:?}",
            child.id(),
            reason
        );

        Ok(Self {
            child: Mutex::new(Some(child)),
        })
    }
}

impl Drop for PlatformImpl {
    fn drop(&mut self) {
        let mut guard = match self.child.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(mut child) = guard.take() {
            let pid = child.id();
            // Kill the holder; systemd-logind releases the inhibit once
            // it observes the child exit. ALWAYS reap with wait() afterwards,
            // even if kill() failed — kill() can legitimately return ESRCH
            // (child already exited on its own, e.g. logind kicked it),
            // in which case there's still a zombie waiting to be reaped.
            // Skipping wait() on the kill-error path would leak that zombie.
            let kill_result = child.kill();
            let wait_result = child.wait();
            if let Err(e) = kill_result {
                ulog_warn!("[wake-lock] kill on systemd-inhibit pid={pid}: {e} (proceeded to wait)");
            }
            if let Err(e) = wait_result {
                ulog_warn!("[wake-lock] wait on systemd-inhibit pid={pid}: {e}");
            }
            ulog_debug!("[wake-lock] Linux assertion released: pid={pid}");
        }
    }
}
