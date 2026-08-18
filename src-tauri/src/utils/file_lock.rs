//! Generic cross-process file lock helper (Pattern 5 — single-writer invariant).
//!
//! Mirrors `src/server/utils/file-lock.ts`. The lock primitive is atomic
//! `create_dir`; an `owner` file inside the lockdir holds the 3-tuple
//! `<runtime>:<pid>:<startMs>` (`rust:<pid>:<startMs>` here, `node:<pid>:<startMs>`
//! from Node) so other processes can probe both liveness and pid-reuse for
//! stale-recovery. The 2-tuple `<runtime>:<pid>` shape is still understood for
//! backwards compatibility with locks written by older binaries. We delegate
//! the actual blocking work to `tokio::task::spawn_blocking` so the async
//! runtime worker stays free.
//!
//! Stale-recovery rules (matching the Node helper):
//! - lockdir age > `stale_ms` AND owner pid is no longer alive (unix:
//!   `nix::sys::signal::kill(pid, None)` returns ESRCH) → forcibly remove.
//! - 3-tuple owner with start_time mismatching the live pid's actual start
//!   time → pid was recycled by an unrelated process → break.
//! - Owner format `renderer:<ts>` has no observable pid; we fall through to
//!   age-only break.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::ulog_warn;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_STALE: Duration = Duration::from_secs(30);
const DEFAULT_POLL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone)]
pub struct FileLockOptions {
    pub timeout: Duration,
    pub stale: Duration,
    pub poll: Duration,
}

impl Default for FileLockOptions {
    fn default() -> Self {
        Self {
            timeout: DEFAULT_TIMEOUT,
            stale: DEFAULT_STALE,
            poll: DEFAULT_POLL,
        }
    }
}

#[derive(Debug)]
pub enum FileLockError {
    /// Lock could not be acquired within `timeout`.
    Busy { lock_path: PathBuf, timeout: Duration },
    /// Filesystem error while attempting to acquire / release the lock.
    Io(std::io::Error),
}

impl std::fmt::Display for FileLockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FileLockError::Busy { lock_path, timeout } => write!(
                f,
                "[file-lock] File busy: could not acquire lock {} within {}ms; retry",
                lock_path.display(),
                timeout.as_millis()
            ),
            FileLockError::Io(e) => write!(f, "[file-lock] I/O error: {}", e),
        }
    }
}

impl std::error::Error for FileLockError {}

impl From<FileLockError> for String {
    fn from(e: FileLockError) -> Self {
        e.to_string()
    }
}

/// Probe whether `pid` is alive. Unix-only via `nix::sys::signal::kill(pid, 0)`.
/// On Windows we use `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` — succeeds
/// only for live processes; failure means the pid is gone (or we lack rights,
/// in which case we conservatively report unknown).
#[cfg(unix)]
fn is_pid_alive(pid: i32) -> Option<bool> {
    use nix::sys::signal;
    use nix::unistd::Pid;
    match signal::kill(Pid::from_raw(pid), None) {
        Ok(_) => Some(true),
        Err(nix::errno::Errno::ESRCH) => Some(false),
        Err(_) => None, // EPERM etc. — be conservative, don't break.
    }
}

#[cfg(target_os = "windows")]
fn is_pid_alive(pid: i32) -> Option<bool> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid <= 0 {
        return None;
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32) };
    if handle.is_null() {
        // Could be ESRCH-equivalent (gone) or access-denied. We can't cleanly
        // distinguish without GetLastError; treat null as "not observable as
        // alive" so callers fall through to the start-time/age path. In
        // practice, a recently-dead pid yields ERROR_INVALID_PARAMETER and a
        // privileged-but-live pid yields ERROR_ACCESS_DENIED — but with
        // PROCESS_QUERY_LIMITED_INFORMATION the latter is rare for our own
        // user's processes.
        return Some(false);
    }
    unsafe { CloseHandle(handle) };
    Some(true)
}

#[cfg(not(any(unix, target_os = "windows")))]
fn is_pid_alive(_pid: i32) -> Option<bool> {
    None
}

/// Best-effort: return the start time (epoch ms) of `pid`, or None if we
/// can't determine it on this platform. Used to detect pid-reuse: if the
/// owner file declared a start_time but the live pid's start_time differs,
/// the original holder is gone and a different process now owns that pid.
///
/// - macOS:  `ps -p <pid> -o lstart=` (string date), parse as system time.
/// - Linux:  `/proc/<pid>/stat` field 22 (starttime in clock ticks) +
///           `/proc/uptime` to convert to absolute ms (assume HZ=100, the
///           same approximation the Node helper uses).
/// - Windows / other: not supported — return None and the caller falls back
///   to age-only stale detection.
#[cfg(target_os = "macos")]
fn get_pid_start_time_ms(pid: i32) -> Option<u64> {
    let out = crate::process_cmd::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        return None;
    }
    // Format: "Thu Apr 25 10:23:45 2026". Use chrono if available; otherwise
    // fall back to a manual parse. We avoid adding chrono — manually parse
    // the canonical macOS format.
    parse_lstart_to_epoch_ms(&s)
}

/// Linux CLK_TCK lookup, cached for the process lifetime. Read at first
/// call via `sysconf(_SC_CLK_TCK)` (libc::sysconf), falling back to 100
/// (universal default) if the lookup fails. Without this, an HZ=250 /
/// HZ=1000 kernel would skew our derived start-time enough to false-break
/// a long-running live config-write holder under the 60s age fallback.
#[cfg(target_os = "linux")]
fn linux_clk_tck() -> f64 {
    use std::sync::OnceLock;
    static CACHED: OnceLock<f64> = OnceLock::new();
    *CACHED.get_or_init(|| {
        // SAFETY: sysconf is a thread-safe libc function. _SC_CLK_TCK is the
        // standard sysconf constant for the clock-tick frequency.
        let v = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if v > 0 && v <= 10_000 { v as f64 } else { 100.0 }
    })
}

#[cfg(target_os = "linux")]
fn get_pid_start_time_ms(pid: i32) -> Option<u64> {
    let stat = fs::read_to_string(format!("/proc/{}/stat", pid)).ok()?;
    // Field 2 is `(comm)` which can contain spaces — split after the closing paren.
    let close_paren = stat.rfind(')')?;
    let after = &stat[close_paren + 2..];
    let fields: Vec<&str> = after.split_whitespace().collect();
    // After the comm field: state=fields[0], ppid=fields[1], …
    // starttime is original index 22 → fields[19].
    let startticks: u64 = fields.get(19)?.parse().ok()?;
    let uptime_str = fs::read_to_string("/proc/uptime").ok()?;
    let uptime_sec: f64 = uptime_str.split_whitespace().next()?.parse().ok()?;
    let hz = linux_clk_tck();
    let start_sec_ago = uptime_sec - (startticks as f64) / hz;
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    let offset_ms = (start_sec_ago * 1000.0).round() as i128;
    let result = now_ms as i128 - offset_ms;
    if result < 0 { None } else { Some(result as u64) }
}

#[cfg(target_os = "windows")]
fn get_pid_start_time_ms(pid: i32) -> Option<u64> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid <= 0 {
        return None;
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32) };
    if handle.is_null() {
        return None;
    }
    let mut creation = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut exit = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut kernel = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut user = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let ok = unsafe {
        GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user)
    };
    unsafe { CloseHandle(handle) };
    if ok == 0 {
        return None;
    }
    // FILETIME = 100ns intervals since 1601-01-01 UTC; convert to ms since 1970.
    let ft = ((creation.dwHighDateTime as u64) << 32) | (creation.dwLowDateTime as u64);
    const EPOCH_OFFSET_100NS: u64 = 116_444_736_000_000_000; // 1601 → 1970 in 100ns
    if ft < EPOCH_OFFSET_100NS {
        return None;
    }
    Some((ft - EPOCH_OFFSET_100NS) / 10_000)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn get_pid_start_time_ms(_pid: i32) -> Option<u64> {
    // Other Unix-likes (FreeBSD etc.): not supported. Fall back to age-only.
    None
}

/// Parse a macOS `ps -o lstart=` string (e.g. "Thu Apr 25 10:23:45 2026")
/// to epoch ms. Avoids pulling in chrono.
#[cfg(target_os = "macos")]
fn parse_lstart_to_epoch_ms(s: &str) -> Option<u64> {
    // Format pieces split by whitespace: [Day, Mon, Day, HH:MM:SS, Year]
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 5 { return None; }
    let mon = parts[1];
    let day: u32 = parts[2].parse().ok()?;
    let time_parts: Vec<&str> = parts[3].split(':').collect();
    if time_parts.len() != 3 { return None; }
    let hour: u32 = time_parts[0].parse().ok()?;
    let min: u32 = time_parts[1].parse().ok()?;
    let sec: u32 = time_parts[2].parse().ok()?;
    let year: i32 = parts[4].parse().ok()?;
    let month: u32 = match mon {
        "Jan" => 1, "Feb" => 2, "Mar" => 3, "Apr" => 4, "May" => 5, "Jun" => 6,
        "Jul" => 7, "Aug" => 8, "Sep" => 9, "Oct" => 10, "Nov" => 11, "Dec" => 12,
        _ => return None,
    };
    // Compute days since Unix epoch using a Howard Hinnant-style civil_from_days
    // inverse. Avoids chrono.
    let y = if month <= 2 { year - 1 } else { year } as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m = month as i64;
    let d = day as i64;
    let doy: u64 = ((153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1) as u64;
    let doe: u64 = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days_since_epoch: i64 = era * 146097 + doe as i64 - 719468;
    let secs_since_epoch: i64 = days_since_epoch * 86400
        + hour as i64 * 3600
        + min as i64 * 60
        + sec as i64;
    if secs_since_epoch < 0 { return None; }
    Some(secs_since_epoch as u64 * 1000)
}

/// Our own start time, computed once on first call. Used to write the
/// 3-tuple owner file `rust:<pid>:<startMs>` so peer processes can detect
/// pid reuse against us.
fn our_start_time_ms() -> u64 {
    use std::sync::OnceLock;
    static OUR_START: OnceLock<u64> = OnceLock::new();
    *OUR_START.get_or_init(|| {
        get_pid_start_time_ms(std::process::id() as i32)
            .unwrap_or_else(|| {
                // Fall back to "now" — better than 0; means the first writer
                // in a process gets a start_time stamp roughly equal to its
                // first lock acquisition. Peer pid-reuse detection still
                // works (a different recycled pid will have a different
                // observed start_time).
                SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
            })
    })
}

/// Race-safe break: atomically rename the lockdir to a per-process tombstone
/// path and then `remove_dir_all`. Two concurrent waiters detecting the lock
/// as stale can't both succeed — only the rename winner ends up with a
/// tombstone, so a third process that has by then taken a fresh lock under
/// the original path stays untouched. Mirrors `breakLockSafely` in
/// `src/server/utils/file-lock.ts`.
fn break_lock_safely(lock_path: &Path) -> bool {
    let nonce: u32 = {
        // Cheap, unique enough for collision avoidance between waiters in the
        // same millisecond — combine with our pid + a wall-clock millis stamp.
        let now_ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        now_ns ^ std::process::id()
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let tombstone = lock_path.with_file_name(format!(
        "{}.stale-{}-{}-{:08x}",
        lock_path.file_name().and_then(|n| n.to_str()).unwrap_or("lock"),
        std::process::id(),
        now_ms,
        nonce,
    ));
    match fs::rename(lock_path, &tombstone) {
        Ok(()) => {
            let _ = fs::remove_dir_all(&tombstone);
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Another waiter already broke (and may have re-acquired) it. From
            // our perspective the stale state is gone — caller should retry.
            true
        }
        Err(_) => false,
    }
}

/// Try to break a stale lockdir if its owner pid is dead and age > `stale`.
/// Returns `true` if we removed it (caller should retry mkdir immediately).
fn try_break_stale_lock(lock_path: &Path, stale: Duration) -> bool {
    let metadata = match fs::metadata(lock_path) {
        Ok(m) => m,
        Err(_) => return true, // gone — retry mkdir
    };

    let age = match metadata.modified().ok().and_then(|t| t.elapsed().ok()) {
        Some(a) => a,
        None => return false,
    };
    if age <= stale {
        return false;
    }

    let owner = fs::read_to_string(lock_path.join("owner"))
        .unwrap_or_default()
        .trim()
        .to_string();

    // Owner shapes:
    //   node:<pid>           (legacy 2-tuple)
    //   node:<pid>:<startMs> (current 3-tuple, written by Node fix #4)
    //   rust:<pid>           (legacy)
    //   rust:<pid>:<startMs> (current — Rust now also writes this)
    //   renderer:<ts>        (no observable pid; falls through to age-only break)
    //
    // For node:/rust: owners we probe pid liveness; if the owner declared a
    // start_time, we additionally verify the live pid actually has that
    // start_time. A live pid with a mismatched start_time means the pid was
    // recycled by an unrelated process — the original holder is gone.
    if let Some(rest) = owner.strip_prefix("node:").or_else(|| owner.strip_prefix("rust:")) {
        let parts: Vec<&str> = rest.split(':').collect();
        if let Some(pid_str) = parts.first() {
            if let Ok(pid) = pid_str.parse::<i32>() {
                let declared_start: Option<u64> = parts.get(1).and_then(|s| s.parse().ok());

                match is_pid_alive(pid) {
                    Some(true) => {
                        // Pid alive — verify start_time if declared.
                        if let Some(declared) = declared_start {
                            if let Some(live) = get_pid_start_time_ms(pid) {
                                let skew = live.abs_diff(declared);
                                // Allow ~2s skew (mirrors Node helper).
                                if skew > 2000 {
                                    ulog_warn!(
                                        "[file-lock] pid {} reused (declaredStart={} liveStart={} skew={}ms); breaking lock {}",
                                        pid, declared, live, skew, lock_path.display()
                                    );
                                    // Fall through to break_lock_safely below.
                                } else {
                                    // start_time matches → owner genuinely alive.
                                    return false;
                                }
                            } else {
                                // Live start_time unknown on this platform → fall through to age-only.
                                if age <= Duration::from_secs(60) { return false; }
                                // Age >60s: break despite live pid (cross-platform parity with Node).
                            }
                        } else {
                            // No declared start_time (legacy 2-tuple) → age-only override.
                            if age <= Duration::from_secs(60) { return false; }
                        }
                    }
                    Some(false) => { /* dead — proceed to break */ }
                    None => return false, // unknown — be conservative
                }
            }
        }
    }
    // For renderer:<ts> or unrecognized owners we fall through and break by age.

    ulog_warn!(
        "[file-lock] Breaking stale lock {} (age={}ms owner={})",
        lock_path.display(),
        age.as_millis(),
        if owner.is_empty() { "unknown" } else { &owner }
    );
    break_lock_safely(lock_path)
}

/// Build our own owner token: `rust:<pid>:<startMs>`. Used at acquisition
/// time to write the sentinel and at release time to verify we still own
/// the lock dir (cf. release-race fix below).
fn our_owner_token() -> String {
    format!("rust:{}:{}", std::process::id(), our_start_time_ms())
}

/// Synchronous lock acquisition + release wrapping `mutator`. Designed to be
/// called from `spawn_blocking` (or any blocking context). For async sites use
/// [`with_file_lock`] which delegates here under `spawn_blocking`.
pub fn with_file_lock_blocking<F, T>(
    lock_path: &Path,
    opts: FileLockOptions,
    mutator: F,
) -> Result<T, FileLockError>
where
    F: FnOnce() -> Result<T, FileLockError>,
{
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent).map_err(FileLockError::Io)?;
    }

    let our_token = our_owner_token();

    let start = Instant::now();
    loop {
        match fs::create_dir(lock_path) {
            Ok(()) => {
                let owner_path = lock_path.join("owner");
                let _ = fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(&owner_path)
                    .and_then(|mut f| writeln!(f, "{}", our_token));
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if try_break_stale_lock(lock_path, opts.stale) {
                    continue; // retry mkdir immediately
                }
                if start.elapsed() >= opts.timeout {
                    return Err(FileLockError::Busy {
                        lock_path: lock_path.to_path_buf(),
                        timeout: opts.timeout,
                    });
                }
                std::thread::sleep(opts.poll);
            }
            Err(e) => return Err(FileLockError::Io(e)),
        }
    }

    let result = mutator();

    // Release-race guard (Pattern 5 fix #4): another process may have broken
    // our lock as stale (e.g. we paused past stale_ms) and acquired its own
    // lock under the same path. Verify ownership before removing — mirror of
    // Node `file-lock.ts` and required for cross-process parity.
    let owner_path = lock_path.join("owner");
    match fs::read_to_string(&owner_path) {
        Ok(s) if s.trim() == our_token => {
            let _ = fs::remove_dir_all(lock_path);
        }
        Ok(other) => {
            ulog_warn!(
                "[file-lock] our lock at {} was broken as stale; not deleting current holder's lock (owner={})",
                lock_path.display(),
                other.trim()
            );
        }
        Err(_) => {
            // Owner file missing or unreadable (lock dir may already be gone or
            // another process is mid-write). Treat as ours — best-effort cleanup
            // so we don't leak the dir. If the dir was already removed,
            // remove_dir_all returns NotFound which we ignore.
            let _ = fs::remove_dir_all(lock_path);
        }
    }
    result
}

/// Async wrapper — runs the blocking lock acquisition + the mutator on a tokio
/// blocking-thread so the async runtime stays free.
pub async fn with_file_lock<F, T>(
    lock_path: &Path,
    opts: FileLockOptions,
    mutator: F,
) -> Result<T, FileLockError>
where
    F: FnOnce() -> Result<T, FileLockError> + Send + 'static,
    T: Send + 'static,
{
    let lock_path = lock_path.to_path_buf();
    tokio::task::spawn_blocking(move || with_file_lock_blocking(&lock_path, opts, mutator))
        .await
        .map_err(|join_err| {
            FileLockError::Io(std::io::Error::other(
                format!("file-lock join error: {}", join_err),
            ))
        })?
}
