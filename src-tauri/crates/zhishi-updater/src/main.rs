//! ZhiShi portable USB in-place updater helper.
//!
//! This is a standalone Windows binary (`zhishi-updater.exe`) shipped inside the
//! portable ZIP. The running ZhiShi App launches it with:
//!
//! ```text
//! zhishi-updater.exe
//!     --target-dir <old app dir>
//!     --source-dir <new USB app dir>
//!     --wait-pid <old zhishi.exe PID>
//!     [--remove-orphans]
//! ```
//!
//! The helper then:
//! 1. Waits for the old process to exit.
//! 2. Backs up `.zhishi/` to `.zhishi-backup-<timestamp>/`.
//! 3. Copies new program files from `source-dir` to `target-dir`, skipping
//!    `.zhishi/`, `.data_mode`, and existing backup directories.
//! 4. Verifies that critical files exist.
//! 5. Starts the new `zhishi.exe`.
//! 6. Cleans up old backups (keeps the 3 most recent).

use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sysinfo::{ProcessStatus, System};

const APP_EXE: &str = "zhishi.exe";
const DATA_DIR: &str = ".zhishi";
const DATA_MODE_FILE: &str = ".data_mode";
const UPDATER_EXE: &str = "zhishi-updater.exe";
const BACKUP_PREFIX: &str = ".zhishi-backup-";
const LOG_DIR: &str = "logs";
const LOG_PREFIX: &str = "updater-";
const UPDATE_STATUS_FILE: &str = ".update-status";
/// Suffix used when a locked target file is renamed out of the way so the new
/// version can be written in its place. Leftovers are purged on the next run.
const STALE_SUFFIX: &str = ".zhishi-old-";
const WAIT_TIMEOUT_SECONDS: u64 = 60;
const WAIT_POLL_INTERVAL_MILLIS: u64 = 250;
const BACKUPS_TO_KEEP: usize = 3;

#[derive(Debug)]
struct Args {
    target_dir: PathBuf,
    source_dir: PathBuf,
    wait_pid: Option<usize>,
    remove_orphans: bool,
}

impl Args {
    fn parse() -> Result<Self, String> {
        let mut args = env::args().skip(1);
        let mut target_dir = None;
        let mut source_dir = None;
        let mut wait_pid = None;
        let mut remove_orphans = false;

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--target-dir" => {
                    target_dir = Some(
                        args.next()
                            .ok_or("--target-dir requires a value")?
                            .into(),
                    );
                }
                "--source-dir" => {
                    source_dir = Some(
                        args.next()
                            .ok_or("--source-dir requires a value")?
                            .into(),
                    );
                }
                "--wait-pid" => {
                    let pid_str = args.next().ok_or("--wait-pid requires a value")?;
                    wait_pid = Some(
                        pid_str
                            .parse::<usize>()
                            .map_err(|e| format!("invalid PID {}: {}", pid_str, e))?,
                    );
                }
                "--remove-orphans" => remove_orphans = true,
                "--help" | "-h" => {
                    print_help();
                    std::process::exit(0);
                }
                other => return Err(format!("unknown argument: {}", other)),
            }
        }

        let target_dir = target_dir.ok_or("missing --target-dir")?;
        let source_dir = source_dir.ok_or("missing --source-dir")?;

        Ok(Self {
            target_dir,
            source_dir,
            wait_pid,
            remove_orphans,
        })
    }
}

fn print_help() {
    println!(
        "Usage: zhishi-updater.exe --target-dir <dir> --source-dir <dir> [options]

Options:
  --target-dir <dir>    Directory of the old portable app to update in place
  --source-dir <dir>    Directory on USB containing the new portable version
  --wait-pid <pid>      PID of the old App process to wait for before replacing
  --remove-orphans      Delete files in target that do not exist in source
  -h, --help            Show this help
"
    );
}

struct Logger {
    file: Option<fs::File>,
}

impl Logger {
    fn new(target_dir: &Path) -> Self {
        let mut file = None;
        // CRITICAL: never *create* `.zhishi` under the target dir. This updater
        // is also launched for non-portable installs (which fail validation a
        // few lines later); creating `target/.zhishi/logs` here would plant an
        // empty `.zhishi` next to the exe, and the app's portable-mode data-dir
        // detection would then silently switch away from the user's home
        // `~/.zhishi` — history appears "gone" while nothing was deleted.
        // Only log inside `.zhishi` when it already exists; otherwise use the
        // system temp dir.
        let data_dir = target_dir.join(DATA_DIR);
        let log_dir = if data_dir.is_dir() {
            data_dir.join(LOG_DIR)
        } else {
            std::env::temp_dir().join("zhishi-updater")
        };
        if let Err(e) = fs::create_dir_all(&log_dir) {
            eprintln!("[updater] failed to create log dir {}: {}", log_dir.display(), e);
        } else {
            let timestamp = timestamp_string().replace(':', "-");
            let log_path = log_dir.join(format!("{}{}.log", LOG_PREFIX, timestamp));
            match fs::File::create(&log_path) {
                Ok(f) => {
                    eprintln!("[updater] log: {}", log_path.display());
                    file = Some(f);
                }
                Err(e) => eprintln!("[updater] failed to create log {}: {}", log_path.display(), e),
            }
        }
        Self { file }
    }

    fn log(&mut self, level: &str, message: &str) {
        let line = format!("[{}] [{}] {}", timestamp_string(), level, message);
        eprintln!("{}", line);
        if let Some(ref mut f) = self.file {
            let _ = writeln!(f, "{}", line);
            let _ = f.flush();
        }
    }

    fn info(&mut self, message: &str) {
        self.log("INFO", message);
    }

    fn warn(&mut self, message: &str) {
        self.log("WARN", message);
    }

    fn error(&mut self, message: &str) {
        self.log("ERROR", message);
    }
}

fn timestamp_string() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let dt = chrono::DateTime::from_timestamp(now as i64, 0)
        .unwrap_or_else(|| chrono::DateTime::UNIX_EPOCH);
    dt.format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn main() {
    let args = match Args::parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[updater] argument error: {}", e);
            print_help();
            // Can't write status here because we don't have a valid target_dir.
            std::process::exit(1);
        }
    };

    let mut logger = Logger::new(&args.target_dir);
    logger.info(&format!(
        "starting updater target={} source={} wait_pid={:?} remove_orphans={}",
        args.target_dir.display(),
        args.source_dir.display(),
        args.wait_pid,
        args.remove_orphans
    ));

    if let Err(e) = run(&args, &mut logger) {
        logger.error(&format!("update failed: {}", e));
        write_status(&args.target_dir, "failed", &e);
        // Keep the process alive briefly so the log is flushed and visible.
        thread::sleep(Duration::from_millis(200));
        std::process::exit(1);
    }

    // The success marker is written inside run() before the relaunch so the new
    // instance cannot miss it; nothing left to do here.
    logger.info("update finished successfully");
}

/// Write a `.update-status` JSON file to the target directory so the main
/// ZhiShi app can detect the outcome of the update on its next startup and
/// surface feedback (toast / dialog) to the user.
///
/// The file is a best-effort marker — a write failure is intentionally ignored
/// because the status is a UX enhancement, not a correctness requirement.
fn write_status(target_dir: &Path, status: &str, message: &str) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Manual JSON escaping — keep it dependency-free.
    let escaped = message
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r");
    let content = format!(
        r#"{{"status":"{}","message":"{}","timestamp":{}}}"#,
        status, escaped, now
    );
    if let Err(e) = fs::write(target_dir.join(UPDATE_STATUS_FILE), &content) {
        eprintln!("[updater] failed to write {}: {}", UPDATE_STATUS_FILE, e);
    }
}

fn run(args: &Args, logger: &mut Logger) -> Result<(), String> {
    validate_source_dir(&args.source_dir)?;
    validate_target_dir(&args.target_dir)?;

    wait_for_old_process(args.wait_pid, logger)?;

    // Files a previous run had to rename aside are now unlocked — clear them
    // before writing new ones so the install directory does not accumulate.
    purge_stale_files(&args.target_dir, logger);

    let backup_dir = backup_data_dir(&args.target_dir, logger)?;

    let copy_result = copy_new_version(
        &args.source_dir,
        &args.target_dir,
        args.remove_orphans,
        logger,
    );

    if let Err(ref e) = copy_result {
        logger.error(&format!(
            "copy failed, attempting rollback from backup {}: {}",
            backup_dir.display(),
            e
        ));
        if let Err(rollback_err) = restore_data_dir(&args.target_dir, &backup_dir, logger) {
            logger.error(&format!(
                "rollback also failed: {}. Manual recovery may be required.",
                rollback_err
            ));
        } else {
            logger.info("rollback completed; old program files remain intact");
        }
        return Err(e.clone());
    }

    verify_target(&args.source_dir, &args.target_dir, logger)?;

    // Write the success marker BEFORE launching. The new instance reads and
    // consumes `.update-status` during startup, and it can win that race if the
    // marker is only written after this helper finishes its cleanup pass.
    write_status(&args.target_dir, "ok", "update completed");

    if let Err(e) = launch_app(&args.target_dir, logger) {
        // Files are already in place, so the update itself succeeded; only the
        // relaunch failed. Record that distinction for the next manual start.
        write_status(&args.target_dir, "failed", &e);
        return Err(e);
    }

    cleanup_old_backups(&args.target_dir, logger);

    Ok(())
}

fn validate_source_dir(source_dir: &Path) -> Result<(), String> {
    if !source_dir.exists() || !source_dir.is_dir() {
        return Err(format!("source directory does not exist: {}", source_dir.display()));
    }

    let data_mode = source_dir.join(DATA_MODE_FILE);
    if !data_mode.exists() {
        return Err(format!(
            "source directory does not contain {} marker: {}",
            DATA_MODE_FILE,
            source_dir.display()
        ));
    }

    let exe = source_dir.join(APP_EXE);
    if !exe.exists() {
        return Err(format!(
            "source directory does not contain {}: {}",
            APP_EXE,
            source_dir.display()
        ));
    }

    Ok(())
}

fn validate_target_dir(target_dir: &Path) -> Result<(), String> {
    if !target_dir.exists() || !target_dir.is_dir() {
        return Err(format!("target directory does not exist: {}", target_dir.display()));
    }

    // Guard against updating a directory that is not a ZhiShi install at all:
    // the app executable must be present. `.data_mode` is intentionally NOT
    // required here — home-mode installs (data in `~/.zhishi`, no marker)
    // legitimately update through this same file-replacement path, and their
    // user data lives outside the install dir so it is never touched.
    let exe = target_dir.join(APP_EXE);
    if !exe.exists() {
        return Err(format!(
            "target directory does not contain {}; refusing to update a non-ZhiShi directory: {}",
            APP_EXE,
            target_dir.display()
        ));
    }

    Ok(())
}

fn wait_for_old_process(pid: Option<usize>, logger: &mut Logger) -> Result<(), String> {
    let Some(pid) = pid else {
        logger.warn("no --wait-pid provided, proceeding without waiting");
        return Ok(());
    };

    logger.info(&format!(
        "waiting for old process PID {} to exit (timeout {}s)",
        pid, WAIT_TIMEOUT_SECONDS
    ));

    let mut system = System::new_all();
    let deadline = SystemTime::now()
        .checked_add(Duration::from_secs(WAIT_TIMEOUT_SECONDS))
        .unwrap();

    loop {
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        match system.process(sysinfo::Pid::from(pid)) {
            Some(proc) => {
                let status = proc.status();
                if matches!(status, ProcessStatus::Dead | ProcessStatus::Zombie) {
                    logger.info("old process is dead/zombie");
                    return Ok(());
                }
            }
            None => {
                logger.info("old process no longer exists");
                return Ok(());
            }
        }

        if SystemTime::now() >= deadline {
            return Err(format!(
                "timed out waiting for PID {} to exit after {} seconds",
                pid, WAIT_TIMEOUT_SECONDS
            ));
        }

        thread::sleep(Duration::from_millis(WAIT_POLL_INTERVAL_MILLIS));
    }
}

fn backup_data_dir(target_dir: &Path, logger: &mut Logger) -> Result<PathBuf, String> {
    let data_dir = target_dir.join(DATA_DIR);
    if !data_dir.exists() {
        logger.info("no .zhishi directory to back up");
        // Return a non-existent path; restore will be a no-op.
        return Ok(target_dir.join(format!("{}{}", BACKUP_PREFIX, timestamp_string().replace(':', "-"))));
    }

    let timestamp = timestamp_string().replace(':', "-");
    let backup_dir = target_dir.join(format!("{}{}", BACKUP_PREFIX, timestamp));

    logger.info(&format!(
        "backing up {} to {}",
        data_dir.display(),
        backup_dir.display()
    ));

    copy_dir_recursive(&data_dir, &backup_dir, &default_skip_set())
        .map_err(|e| format!("failed to back up .zhishi: {}", e))?;

    logger.info("backup complete");
    Ok(backup_dir)
}

fn restore_data_dir(target_dir: &Path, backup_dir: &Path, logger: &mut Logger) -> Result<(), String> {
    if !backup_dir.exists() {
        logger.warn("backup directory does not exist; nothing to restore");
        return Ok(());
    }

    let data_dir = target_dir.join(DATA_DIR);
    if data_dir.exists() {
        logger.info(&format!(
            "removing corrupted {} before restore",
            data_dir.display()
        ));
        if let Err(e) = remove_dir_all_best_effort(&data_dir) {
            logger.warn(&format!("failed to remove corrupted data dir: {}", e));
        }
    }

    logger.info(&format!(
        "restoring {} from {}",
        data_dir.display(),
        backup_dir.display()
    ));

    copy_dir_recursive(backup_dir, &data_dir, &default_skip_set())
        .map_err(|e| format!("failed to restore .zhishi: {}", e))?;

    logger.info("restore complete");
    Ok(())
}

fn default_skip_set() -> HashSet<PathBuf> {
    let mut set = HashSet::new();
    set.insert(PathBuf::from(DATA_DIR));
    set.insert(PathBuf::from(DATA_MODE_FILE));
    set
}

fn copy_new_version(
    source_dir: &Path,
    target_dir: &Path,
    remove_orphans: bool,
    logger: &mut Logger,
) -> Result<(), String> {
    logger.info(&format!(
        "copying new version from {} to {}",
        source_dir.display(),
        target_dir.display()
    ));

    // Build the set of source entries for orphan detection.
    let source_entries: HashSet<PathBuf> = match fs::read_dir(source_dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().into())
            .collect(),
        Err(e) => return Err(format!("failed to read source dir: {}", e)),
    };

    // Collected per-file copy failures — evaluated once the whole tree has been
    // walked so the log lists every problem instead of only the first.
    let mut failures: Vec<String> = Vec::new();

    for entry in fs::read_dir(source_dir).map_err(|e| format!("failed to read source dir: {}", e))? {
        let entry = entry.map_err(|e| format!("failed to read source entry: {}", e))?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if name_str == DATA_DIR || name_str == DATA_MODE_FILE {
            continue;
        }
        if name_str.starts_with(BACKUP_PREFIX) {
            continue;
        }

        let src = entry.path();
        let dst = target_dir.join(&name);

        // `zhishi-updater.exe` is the binary currently executing — Windows
        // always holds an exclusive lock on it, so replacing it here is
        // expected to fail. Skip it explicitly instead of reporting a failure;
        // the helper is refreshed by the next full reinstall.
        if name_str == UPDATER_EXE {
            logger.info("skipping zhishi-updater.exe (currently running)");
            continue;
        }

        // Per-file failures are collected rather than aborting: some system
        // DLLs (vcruntime*.dll) may still be loaded right after the old
        // process exits. copy_with_retry already retries and falls back to
        // rename-aside, so anything landing in `failures` is a genuine problem.
        match fs::metadata(&src) {
            Ok(meta) if meta.is_dir() => copy_dir_tree_lenient(&src, &dst, &mut failures),
            Ok(_) => {
                if let Err(e) = copy_entry(&src, &dst) {
                    failures.push(format!("{}: {}", dst.display(), e));
                }
            }
            Err(e) => failures.push(format!("{}: {}", src.display(), e)),
        }
    }

    if !failures.is_empty() {
        for f in &failures {
            logger.warn(&format!("failed to copy {}", f));
        }
        // The app binary itself must always be replaceable — if it is not, the
        // installation would be a mix of a stale executable and new resources,
        // which is exactly the silent-corruption case we must refuse.
        let app_failed = failures
            .iter()
            .any(|f| f.to_lowercase().contains(&APP_EXE.to_lowercase()));
        if app_failed {
            return Err(format!(
                "failed to replace {} ({} file(s) could not be written)",
                APP_EXE,
                failures.len()
            ));
        }
        return Err(format!(
            "{} file(s) could not be written, e.g. {}",
            failures.len(),
            failures.first().cloned().unwrap_or_default()
        ));
    }

    if remove_orphans {
        logger.info("removing orphan files in target");
        for entry in fs::read_dir(target_dir)
            .map_err(|e| format!("failed to read target dir: {}", e))?
        {
            let entry = entry.map_err(|e| format!("failed to read target entry: {}", e))?;
            let name = entry.file_name();
            let name_str = name.to_string_lossy();

            if name_str == DATA_DIR
                || name_str == DATA_MODE_FILE
                || name_str.starts_with(BACKUP_PREFIX)
                || source_entries.contains(Path::new(&name))
            {
                continue;
            }

            let path = entry.path();
            if path.is_dir() {
                if let Err(e) = remove_dir_all_best_effort(&path) {
                    logger.warn(&format!("failed to remove orphan dir {}: {}", path.display(), e));
                }
            } else if let Err(e) = fs::remove_file(&path) {
                logger.warn(&format!("failed to remove orphan file {}: {}", path.display(), e));
            }
        }
    }

    logger.info("copy complete");
    Ok(())
}

fn copy_entry(src: &Path, dst: &Path) -> io::Result<()> {
    let metadata = fs::metadata(src)?;
    if metadata.is_dir() {
        copy_dir_recursive(src, dst, &HashSet::new())
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        copy_with_retry(src, dst)?;
        Ok(())
    }
}

/// Copy a file with retries and backoff, handling transient "in use" errors.
///
/// On Windows, a just-exited process may still have DLLs loaded (e.g.,
/// `vcruntime140.dll`), causing `fs::copy` to fail with error 32 (file in
/// use). We retry up to 5 times with 200ms delay between attempts, which
/// is enough for the OS to release the file handles.
///
/// If the file is *still* locked after all retries, we fall back to the
/// standard Windows replace-in-use trick: `MoveFile` (rename) succeeds on a
/// file that is open by another process, whereas overwriting it does not. The
/// locked file is renamed to `<name>.zhishi-old-<ts>` and the new version is
/// written to the now-free path; the stale rename is purged on the next run.
/// Without this fallback a single loaded DLL silently leaves the installation
/// on a mix of old and new files.
fn copy_with_retry(src: &Path, dst: &Path) -> io::Result<()> {
    const MAX_RETRIES: u32 = 5;
    const RETRY_DELAY_MS: u64 = 200;

    let mut last_err: Option<io::Error> = None;

    for attempt in 0..MAX_RETRIES {
        match fs::copy(src, dst) {
            Ok(_) => return Ok(()),
            Err(e) => {
                let retryable = matches!(
                    e.kind(),
                    io::ErrorKind::PermissionDenied | io::ErrorKind::AlreadyExists
                );
                if attempt + 1 < MAX_RETRIES && retryable {
                    // On Windows, ERROR_SHARING_VIOLATION maps to PermissionDenied.
                    // Wait a bit and retry — the old process may still be releasing
                    // DLL file handles.
                    thread::sleep(Duration::from_millis(RETRY_DELAY_MS));
                    last_err = Some(e);
                    continue;
                }
                last_err = Some(e);
                break;
            }
        }
    }

    // Last resort: move the locked file aside, then copy into the freed path.
    if dst.exists() {
        let stale = stale_path_for(dst);
        if fs::rename(dst, &stale).is_ok() {
            match fs::copy(src, dst) {
                Ok(_) => return Ok(()),
                Err(e) => {
                    // Put the original back so the installation is not left
                    // missing a file we could neither replace nor restore.
                    let _ = fs::rename(&stale, dst);
                    return Err(e);
                }
            }
        }
    }

    Err(last_err.unwrap_or_else(|| io::Error::other("copy failed for an unknown reason")))
}

/// Build a unique `<path>.zhishi-old-<nanos>` sidecar path for a locked file.
fn stale_path_for(dst: &Path) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = dst
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    dst.with_file_name(format!("{}{}{}", file_name, STALE_SUFFIX, nanos))
}

/// Delete `*.zhishi-old-*` leftovers from a previous update where a locked file
/// had to be renamed aside. Best-effort: files still held open are skipped and
/// retried on the next update.
fn purge_stale_files(dir: &Path, logger: &mut Logger) {
    let removed = purge_stale_files_in(dir);
    if removed > 0 {
        logger.info(&format!(
            "purged {} stale file(s) left by a previous update",
            removed
        ));
    }
}

fn purge_stale_files_in(dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        // User data and backups are never touched by the replace-in-use path.
        if name_str == DATA_DIR || name_str.starts_with(BACKUP_PREFIX) {
            continue;
        }
        let path = entry.path();
        if name_str.contains(STALE_SUFFIX) {
            let result = if path.is_dir() {
                remove_dir_all_best_effort(&path)
            } else {
                fs::remove_file(&path)
            };
            if result.is_ok() {
                removed += 1;
            }
            continue;
        }
        if path.is_dir() {
            removed += purge_stale_files_in(&path);
        }
    }
    removed
}

fn copy_dir_recursive(src: &Path, dst: &Path, skip: &HashSet<PathBuf>) -> io::Result<()> {
    fs::create_dir_all(dst)?;

    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        // Skip entries in the explicit skip set, backup directories, and
        // updater log files. The updater's own log file (`updater-*.log`) is
        // open for writing by the Logger during backup; trying to fs::copy it
        // on Windows causes a sharing violation that aborts the entire update.
        if skip.contains(Path::new(&name))
            || name_str.starts_with(BACKUP_PREFIX)
            || name_str.starts_with(LOG_PREFIX)
        {
            continue;
        }

        let src_path = entry.path();
        let dst_path = dst.join(&name);

        let metadata = fs::metadata(&src_path)?;
        if metadata.is_dir() {
            copy_dir_recursive(&src_path, &dst_path, skip)?;
        } else {
            if let Some(parent) = dst_path.parent() {
                fs::create_dir_all(parent)?;
            }
            copy_with_retry(&src_path, &dst_path)?;
        }
    }

    Ok(())
}

/// Recursively copy `src` into `dst`, tolerating per-file failures.
///
/// Unlike [`copy_dir_recursive`], a single unreadable/locked file does not
/// abort the traversal. Failures are appended to `failures` so the caller can
/// decide whether the update is still viable. This matters because the program
/// tree contains thousands of files (`resources/`, `node_modules/`), and the
/// previous fail-fast behaviour meant one locked file silently left the whole
/// subtree on the old version while the update still reported success.
fn copy_dir_tree_lenient(src: &Path, dst: &Path, failures: &mut Vec<String>) {
    if let Err(e) = fs::create_dir_all(dst) {
        failures.push(format!("{}: {}", dst.display(), e));
        return;
    }

    let entries = match fs::read_dir(src) {
        Ok(e) => e,
        Err(e) => {
            failures.push(format!("{}: {}", src.display(), e));
            return;
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                failures.push(format!("{}: {}", src.display(), e));
                continue;
            }
        };

        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with(BACKUP_PREFIX)
            || name_str.starts_with(LOG_PREFIX)
            || name_str.contains(STALE_SUFFIX)
        {
            continue;
        }

        let src_path = entry.path();
        let dst_path = dst.join(&name);

        match fs::metadata(&src_path) {
            Ok(meta) if meta.is_dir() => copy_dir_tree_lenient(&src_path, &dst_path, failures),
            Ok(_) => {
                if let Err(e) = copy_with_retry(&src_path, &dst_path) {
                    failures.push(format!("{}: {}", dst_path.display(), e));
                }
            }
            Err(e) => failures.push(format!("{}: {}", src_path.display(), e)),
        }
    }
}

fn remove_dir_all_best_effort(path: &Path) -> io::Result<()> {
    // On Windows, read-only files can block remove_dir_all. Clear read-only flags first.
    fn clear_readonly(dir: &Path) -> io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let metadata = fs::metadata(&path)?;
            let mut permissions = metadata.permissions();
            if permissions.readonly() {
                permissions.set_readonly(false);
                fs::set_permissions(&path, permissions)?;
            }
            if path.is_dir() {
                clear_readonly(&path)?;
            }
        }
        Ok(())
    }

    if cfg!(windows) {
        let _ = clear_readonly(path);
    }
    fs::remove_dir_all(path)
}

fn verify_target(source_dir: &Path, target_dir: &Path, logger: &mut Logger) -> Result<(), String> {
    logger.info("verifying target");

    // The app binary must always be present. `.data_mode` is NOT required:
    // it only exists in portable installs, while home-mode installs (no marker)
    // update through this same path and must not be forced to gain a marker.
    let required = [APP_EXE];
    for name in &required {
        let path = target_dir.join(name);
        if !path.exists() {
            return Err(format!("verification failed: missing {}", path.display()));
        }
    }

    // The old verification only checked that zhishi.exe still existed, which
    // passed even when entire resource subtrees had been skipped — the app then
    // started into a broken state (or not at all). Every top-level entry the
    // package ships must now be present in the target.
    let mut missing: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(source_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str == DATA_DIR
                || name_str == DATA_MODE_FILE
                || name_str == UPDATER_EXE
                || name_str.starts_with(BACKUP_PREFIX)
                || name_str.starts_with(LOG_PREFIX)
            {
                continue;
            }
            if !target_dir.join(&name).exists() {
                missing.push(name_str.to_string());
            }
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "verification failed: {} package entr(ies) missing after copy: {}",
            missing.len(),
            missing.join(", ")
        ));
    }

    // A zero-byte executable means the copy was interrupted mid-write.
    match fs::metadata(target_dir.join(APP_EXE)) {
        Ok(meta) if meta.len() == 0 => {
            return Err(format!("verification failed: {} is empty", APP_EXE));
        }
        Err(e) => return Err(format!("verification failed: cannot stat {}: {}", APP_EXE, e)),
        _ => {}
    }

    let data_dir = target_dir.join(DATA_DIR);
    if !data_dir.exists() {
        // NEVER manufacture an empty `.zhishi` here. The copy step preserves it
        // by skipping it; if it is missing after a successful copy, the update
        // must not silently create one — an empty dir next to the exe would
        // hijack the app's data-dir resolution on the next boot (same trap as
        // Logger::new). Log and leave it as-is.
        logger.warn("target .zhishi directory is missing after update (left as-is)");
    }

    logger.info("verification passed");
    Ok(())
}

/// Launch the freshly installed app.
///
/// On Windows the child must survive this helper exiting. A plain `spawn()`
/// inherits the console/job context of the updater (which itself was spawned by
/// the app being replaced), so the new instance could be torn down along with
/// it. We therefore request `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`, plus
/// `CREATE_BREAKAWAY_FROM_JOB` when the job object permits it, and fall back
/// progressively if a flag combination is rejected.
fn launch_app(target_dir: &Path, logger: &mut Logger) -> Result<(), String> {
    let exe = target_dir.join(APP_EXE);
    logger.info(&format!("launching new app: {}", exe.display()));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

        let attempts: [u32; 3] = [
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB,
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
            0,
        ];

        let mut last_err = String::new();
        for (i, flags) in attempts.iter().enumerate() {
            let mut cmd = Command::new(&exe);
            cmd.current_dir(target_dir)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            if *flags != 0 {
                cmd.creation_flags(*flags);
            }
            match cmd.spawn() {
                Ok(child) => {
                    logger.info(&format!(
                        "new app launched (pid {}, creation_flags=0x{:08x})",
                        child.id(),
                        flags
                    ));
                    // Give the new process a moment to get past image loading
                    // so an immediate crash is visible in this helper's log.
                    thread::sleep(Duration::from_millis(300));
                    return Ok(());
                }
                Err(e) => {
                    last_err = format!("creation_flags=0x{:08x}: {}", flags, e);
                    if i + 1 < attempts.len() {
                        logger.warn(&format!("launch attempt failed ({}), retrying", last_err));
                    }
                }
            }
        }
        return Err(format!("failed to launch {}: {}", exe.display(), last_err));
    }

    #[cfg(not(windows))]
    {
        Command::new(&exe)
            .current_dir(target_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("failed to launch {}: {}", exe.display(), e))?;

        logger.info("new app launched");
        Ok(())
    }
}

fn cleanup_old_backups(target_dir: &Path, logger: &mut Logger) {
    let mut backups: Vec<(PathBuf, SystemTime)> = Vec::new();

    let entries = match fs::read_dir(target_dir) {
        Ok(e) => e,
        Err(e) => {
            logger.warn(&format!("failed to list target dir for backup cleanup: {}", e));
            return;
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                logger.warn(&format!("failed to read entry: {}", e));
                continue;
            }
        };

        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with(BACKUP_PREFIX) && entry.path().is_dir() {
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(UNIX_EPOCH);
            backups.push((entry.path(), modified));
        }
    }

    if backups.len() <= BACKUPS_TO_KEEP {
        return;
    }

    backups.sort_by(|a, b| b.1.cmp(&a.1)); // newest first

    for (path, _) in backups.iter().skip(BACKUPS_TO_KEEP) {
        logger.info(&format!("removing old backup: {}", path.display()));
        if let Err(e) = remove_dir_all_best_effort(path) {
            logger.warn(&format!("failed to remove old backup {}: {}", path.display(), e));
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn test_args_parse_valid() {
        let args = vec![
            "zhishi-updater.exe".to_string(),
            "--target-dir".to_string(),
            "C:\\old".to_string(),
            "--source-dir".to_string(),
            "D:\\new".to_string(),
            "--wait-pid".to_string(),
            "1234".to_string(),
            "--remove-orphans".to_string(),
        ];
        let parsed = Args::parse_from(&args).unwrap();
        assert_eq!(parsed.target_dir, PathBuf::from("C:\\old"));
        assert_eq!(parsed.source_dir, PathBuf::from("D:\\new"));
        assert_eq!(parsed.wait_pid, Some(1234));
        assert!(parsed.remove_orphans);
    }

    #[test]
    fn test_args_parse_missing_source() {
        let args = vec![
            "zhishi-updater.exe".to_string(),
            "--target-dir".to_string(),
            "C:\\old".to_string(),
        ];
        assert!(Args::parse_from(&args).is_err());
    }

    impl Args {
        fn parse_from(input: &[String]) -> Result<Self, String> {
            // Override env::args() for tests
            let mut args = input.iter().skip(1).cloned();
            let mut target_dir = None;
            let mut source_dir = None;
            let mut wait_pid = None;
            let mut remove_orphans = false;

            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--target-dir" => {
                        target_dir = Some(args.next().ok_or("--target-dir requires a value")?.into());
                    }
                    "--source-dir" => {
                        source_dir = Some(args.next().ok_or("--source-dir requires a value")?.into());
                    }
                    "--wait-pid" => {
                        let pid_str = args.next().ok_or("--wait-pid requires a value")?;
                        wait_pid = Some(pid_str.parse::<usize>().map_err(|e| format!("invalid PID {}: {}", pid_str, e))?);
                    }
                    "--remove-orphans" => remove_orphans = true,
                    other => return Err(format!("unknown argument: {}", other)),
                }
            }

            Ok(Self {
                target_dir: target_dir.ok_or("missing --target-dir")?,
                source_dir: source_dir.ok_or("missing --source-dir")?,
                wait_pid,
                remove_orphans,
            })
        }
    }

    #[test]
    fn test_timestamp_string_format() {
        let ts = timestamp_string();
        assert!(ts.contains('T'));
        assert_eq!(ts.len(), "2026-06-12T22:36:41".len());
    }

    #[test]
    fn test_copy_dir_recursive() {
        let tmp = std::env::temp_dir().join(format!("zhishi_updater_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let src = tmp.join("src");
        let dst = tmp.join("dst");

        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.txt"), "a").unwrap();
        std::fs::write(src.join("sub").join("b.txt"), "b").unwrap();

        copy_dir_recursive(&src, &dst, &HashSet::new()).unwrap();

        assert!(dst.join("a.txt").exists());
        assert!(dst.join("sub").join("b.txt").exists());
        assert_eq!(std::fs::read_to_string(dst.join("a.txt")).unwrap(), "a");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_copy_dir_recursive_skips_excluded() {
        let tmp = std::env::temp_dir().join(format!("zhishi_updater_skip_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let src = tmp.join("src");
        let dst = tmp.join("dst");

        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("keep.txt"), "keep").unwrap();
        std::fs::create_dir(src.join(".zhishi")).unwrap();
        std::fs::write(src.join(".zhishi").join("data.txt"), "data").unwrap();

        let mut skip = HashSet::new();
        skip.insert(PathBuf::from(".zhishi"));
        copy_dir_recursive(&src, &dst, &skip).unwrap();

        assert!(dst.join("keep.txt").exists());
        assert!(!dst.join(".zhishi").exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_remove_dir_all_best_effort_readonly() {
        let tmp = std::env::temp_dir().join(format!("zhishi_updater_ro_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let ro_file = tmp.join("ro.txt");

        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(&ro_file, "x").unwrap();
        let mut perm = std::fs::metadata(&ro_file).unwrap().permissions();
        perm.set_readonly(true);
        std::fs::set_permissions(&ro_file, perm).unwrap();

        remove_dir_all_best_effort(&tmp).unwrap();
        assert!(!tmp.exists());
    }
}
