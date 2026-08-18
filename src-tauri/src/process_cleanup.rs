//! Unified process cleanup using `sysinfo` (native API).
//!
//! Replaces the legacy PowerShell/WMI-based Windows cleanup (which spawned
//! ~6 PowerShell processes per invocation, each cold-starting .NET + WMI
//! for 1–3 s) and the Unix `pgrep` path. The legacy Windows path blocked
//! Tauri `setup()` on the main thread for 5–15 s on first launch, which
//! directly caused the "frontend freeze" user reports.
//!
//! Pit-of-success property: callers pass a list of [`ProcessPattern`] and
//! get back a [`CleanupReport`]. No ad-hoc shell invocations. No forgotten
//! process-tree edge cases — matches are closed under descendants-by-PPID,
//! which catches the orphaned-child case that Windows `taskkill /T /F`
//! misses when an intermediate `cmd.exe` breaks the tree linkage.
//!
//! Performance: on a clean first launch (zero matches), the single
//! `sysinfo` enumeration completes in ~10–50 ms vs ~5–15 s for the old
//! PowerShell chain. On restarts with live children, ~50–200 ms total.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

/// A substring pattern tested against a process's full command line (the
/// `argv` array joined by space).
///
/// Patterns MUST use forward slashes for path components even when targeting
/// Windows paths — the matcher normalizes `\` → `/` before comparison so a
/// single pattern handles both separator conventions.
#[derive(Debug, Clone, Copy)]
pub struct ProcessPattern {
    pub name: &'static str,
    pub pattern: &'static str,
}

impl ProcessPattern {
    pub const fn new(name: &'static str, pattern: &'static str) -> Self {
        Self { name, pattern }
    }
}

#[derive(Debug, Default, Clone)]
pub struct CleanupReport {
    /// Processes whose own command line matched a pattern.
    pub matched_roots: usize,
    /// Additional descendants (via PPID) killed alongside matched roots.
    pub descendants: usize,
    /// Processes actually terminated successfully.
    pub killed: usize,
    /// Processes still alive after the termination deadline.
    pub residual: usize,
    /// Total wall-clock time spent in this call.
    pub elapsed: Duration,
}

impl CleanupReport {
    pub fn total_targets(&self) -> usize {
        self.matched_roots + self.descendants
    }
}

/// Normalize a command-line string or pattern for substring matching:
/// backslashes → forward slashes (so one pattern covers both separator
/// conventions), and lowercase (so we match Windows' case-insensitive
/// filesystem behavior, reproducing the prior PowerShell `-like` semantics).
fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c == '\\' {
            out.push('/');
        } else {
            for lc in c.to_lowercase() {
                out.push(lc);
            }
        }
    }
    out
}

/// Enumerate, terminate, and confirm death of all processes whose command
/// line matches any of `patterns`, plus their descendants by PPID.
///
/// This is the one and only process-cleanup entry point in the app. Use
/// it for both startup-time stale cleanup and shutdown-time orphan
/// cleanup. Always excludes the current process PID.
///
/// Wait budget for confirmed termination: **3 s**. Any process still alive
/// after that is counted in `residual` and logged by callers.
pub fn kill_stale_processes(patterns: &[ProcessPattern]) -> CleanupReport {
    let started = Instant::now();
    let mut system = System::new();
    // Refresh with CMD info so Process::cmd() is populated.
    // `remove_dead_processes=true` — IMPORTANT: when false, sysinfo keeps
    // stale entries in the map even after the process has exited, and our
    // later liveness polling loop would always see "alive" and wait the
    // full deadline. Verified against sysinfo 0.33 source (common/system.rs).
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(sysinfo::UpdateKind::Always),
    );

    let self_pid = Pid::from_u32(std::process::id());

    // Build PPID → children map once (sysinfo gives us flat list).
    let mut children_of: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, proc) in system.processes() {
        if let Some(parent) = proc.parent() {
            children_of.entry(parent).or_default().push(*pid);
        }
    }

    // Pre-normalize patterns once — saves per-process string allocation.
    let norm_patterns: Vec<String> = patterns.iter().map(|p| normalize(p.pattern)).collect();

    // Find root matches by command-line pattern.
    let mut roots: HashSet<Pid> = HashSet::new();
    for (pid, proc) in system.processes() {
        if *pid == self_pid {
            continue;
        }
        let cmd_raw: String = proc
            .cmd()
            .iter()
            .map(|os| os.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        if cmd_raw.is_empty() {
            continue;
        }
        let cmd_norm = normalize(&cmd_raw);
        for np in &norm_patterns {
            if cmd_norm.contains(np.as_str()) {
                roots.insert(*pid);
                break;
            }
        }
    }
    let matched_roots = roots.len();

    // BFS: collect all descendants of matched roots.
    let mut to_kill: HashSet<Pid> = roots.clone();
    let mut queue: Vec<Pid> = roots.iter().copied().collect();
    while let Some(p) = queue.pop() {
        if let Some(kids) = children_of.get(&p) {
            for kid in kids {
                if *kid == self_pid {
                    continue;
                }
                if to_kill.insert(*kid) {
                    queue.push(*kid);
                }
            }
        }
    }
    let descendants = to_kill.len().saturating_sub(matched_roots);

    if to_kill.is_empty() {
        return CleanupReport {
            elapsed: started.elapsed(),
            ..Default::default()
        };
    }

    // Terminate: TerminateProcess on Windows / SIGKILL on Unix.
    let mut killed = 0;
    for pid in &to_kill {
        if let Some(proc) = system.process(*pid) {
            if proc.kill() {
                killed += 1;
            }
        }
    }

    // Confirm death. TerminateProcess is synchronous in theory but the
    // kernel handle-closure finalizer can lag a few ms. 3 s deadline
    // covers worst-case; in practice this loop exits in <50 ms.
    //
    // CRITICAL: `remove_dead_processes=true` in the refresh call — sysinfo
    // otherwise keeps dead PIDs in its internal HashMap and every poll
    // would see the process as still present, forcing us to wait the full
    // deadline on every real cleanup run. With `true`, dead PIDs are
    // purged from the map and `system.process(pid)` correctly returns
    // None once the kernel releases the handle.
    let deadline = started + Duration::from_secs(3);
    let kill_slice: Vec<Pid> = to_kill.iter().copied().collect();
    let residual: usize;
    loop {
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&kill_slice),
            true,
            ProcessRefreshKind::nothing(),
        );
        let alive = kill_slice
            .iter()
            .filter(|pid| system.process(**pid).is_some())
            .count();
        if alive == 0 || Instant::now() >= deadline {
            residual = alive;
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    CleanupReport {
        matched_roots,
        descendants,
        killed,
        residual,
        elapsed: started.elapsed(),
    }
}

/// Test if any live process still matches any of `patterns` (excluding self).
///
/// Used by the update-shutdown path to verify an earlier termination pass
/// actually completed before handing control off to the NSIS installer.
pub fn has_matching_processes(patterns: &[ProcessPattern]) -> bool {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(sysinfo::UpdateKind::Always),
    );
    let self_pid = Pid::from_u32(std::process::id());
    let norm_patterns: Vec<String> = patterns.iter().map(|p| normalize(p.pattern)).collect();
    for (pid, proc) in system.processes() {
        if *pid == self_pid {
            continue;
        }
        let cmd_raw: String = proc
            .cmd()
            .iter()
            .map(|os| os.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        if cmd_raw.is_empty() {
            continue;
        }
        let cmd_norm = normalize(&cmd_raw);
        if norm_patterns.iter().any(|np| cmd_norm.contains(np.as_str())) {
            return true;
        }
    }
    false
}

/// Query whether a specific PID corresponds to a ZhiShi process.
/// Uses the executable path (`GetModuleFileNameExW` underneath), so it is
/// reliable whether the process was spawned via shortcut, installer, or
/// direct path. Case-insensitive substring match to absorb Windows
/// filesystem case quirks (`ZhiShi` vs `zhishi`).
pub fn is_zhishi_pid(pid: u32) -> bool {
    let mut system = System::new();
    let only: [Pid; 1] = [Pid::from_u32(pid)];
    // remove_dead_processes=true so that a dead PID returns None from
    // system.process() below rather than a stale entry.
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&only),
        true,
        ProcessRefreshKind::nothing(),
    );
    let Some(proc) = system.process(Pid::from_u32(pid)) else {
        return false;
    };
    // Prefer exe_path (full path) — sysinfo falls back to name() internally.
    let haystack: String = proc
        .exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| proc.name().to_string_lossy().into_owned());
    let lower = haystack.to_ascii_lowercase();
    lower.contains("zhishi")
}
