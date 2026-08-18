//! Workspace path resolution and traversal protection.
//!
//! All workspace file commands take an absolute `workspace_path` (the directory
//! the user is currently working inside) and a `relative` path or `target_dir`
//! the operation should affect. This module is the single chokepoint that turns
//! that pair into a validated absolute path that:
//!
//! 1. Resolves `..` and `.` components (no traversal escape).
//! 2. Stays inside `workspace_path` (no escape via symlink-aware canonicalization
//!    where the file already exists; for new paths we walk component-by-component).
//! 3. Passes the same system / credential directory blacklist used everywhere
//!    else in the app — see `commands::validate_file_path`.
//!
//! Centralizing these rules means a future "ah, also block X" only happens once.
//! Callers MUST go through `resolve_inside_workspace`; bypassing it is a bug.
//!
//! Symlink note (Phase D + Phase D.5):
//! - **Lexical resolve** (`resolve_inside_workspace`): for write-side commands
//!   (`new_file`, `new_folder`, `rename`, `move`, gitignore append, etc.) the
//!   target may not exist yet, so we resolve `..`/`.` lexically and check
//!   `starts_with(workspace_root)`. A symlink inside the workspace pointing
//!   outside is reachable — consistent with the prior sidecar behavior and
//!   with what users expect when they put a symlink in their own project.
//! - **Canonical resolve** (`resolve_existing_inside_workspace`): for read-side
//!   commands (`read_preview`, `download_file`) we canonicalize the resolved
//!   path AND the workspace root, then re-check `starts_with`. This blocks
//!   the "malicious repo with `evil_link → /etc/passwd`" attack: cloning a
//!   repo means the workspace root is trusted, but individual symlinks
//!   inside it are not. Read-only commands have no legitimate need to follow
//!   them outside.
//!
//! The same canonicalize trick can't apply to write-side commands because
//! `fs::canonicalize` fails on paths that don't exist yet.

use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::commands::validate_file_path as system_blacklist_check;

/// Errors are stringly-typed because Tauri commands serialize errors as strings
/// to the frontend; matching the existing error style avoids a translation layer.
pub type WfResult<T> = Result<T, String>;

/// Validate the workspace root itself: must be absolute, must not target a
/// blacklisted system / credential directory, must currently exist.
///
/// We require existence here (unlike validate_file_path which is read-only) so
/// that an invalid workspace_path can never silently create files in `/`.
pub fn validate_workspace_root(workspace_path: &str) -> WfResult<PathBuf> {
    let resolved = system_blacklist_check(workspace_path)?;
    if !resolved.is_dir() {
        return Err(format!(
            "Workspace path is not a directory or does not exist: {}",
            workspace_path
        ));
    }
    Ok(resolved)
}

/// Resolve a `relative` path inside `workspace_root`. The relative segment may
/// also be empty / "." — in which case the workspace root itself is returned.
///
/// Rules:
/// - `relative` MUST be relative (no leading `/` or drive letter).
/// - `..` is allowed inside the segment but cannot escape `workspace_root`.
/// - Resulting path is checked against the system blacklist as a final guard
///   (defense-in-depth in case the workspace itself sits next to a blacklisted
///   dir and the relative includes `../...`).
pub fn resolve_inside_workspace(workspace_root: &Path, relative: &str) -> WfResult<PathBuf> {
    if Path::new(relative).is_absolute() {
        return Err("Path must be relative to workspace root".to_string());
    }

    let mut resolved = workspace_root.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            Component::ParentDir => {
                if resolved == *workspace_root {
                    return Err("Path escapes workspace root".to_string());
                }
                resolved.pop();
            }
            Component::CurDir => {}
            Component::Normal(part) => resolved.push(part),
            Component::Prefix(_) | Component::RootDir => {
                return Err("Absolute / drive-letter components not allowed".to_string());
            }
        }
    }

    if !resolved.starts_with(workspace_root) {
        return Err("Path escapes workspace root".to_string());
    }

    // Final blacklist check — covers the case where the workspace itself is
    // adjacent to a sensitive dir and a malicious `relative` walked into it.
    if let Some(s) = resolved.to_str() {
        let _ = system_blacklist_check(s)?;
    }

    Ok(resolved)
}

/// Validate that an arbitrary absolute path (e.g. a file the user dragged from
/// Finder) is safe to read from. Used by `read_files_b64` and `copy_paths`.
pub fn validate_external_read_path(absolute_path: &str) -> WfResult<PathBuf> {
    system_blacklist_check(absolute_path)
}

/// Stricter variant of `resolve_inside_workspace` for **read-side** commands:
/// resolves any symlinks via `fs::canonicalize` and verifies the canonical
/// path is still inside the canonical workspace root — OR inside a trusted
/// ZhiShi-managed directory (see `is_trusted_managed_target`). Blocks the
/// "malicious `evil_link → /etc/passwd` checked into a repo" attack from
/// leaking content out of the workspace, while still allowing the
/// junctions / symlinks we sync ourselves from `~/.zhishi/skills` etc.
/// into `<workspace>/.claude/skills/` (see `agent-session.ts:syncProjectSkillSymlinks`).
///
/// Behavior:
/// - If the resolved path doesn't exist, returns `Err("File not found")` (the
///   read command was going to error anyway — surfacing the same error here
///   makes the failure mode uniform regardless of whether the path is missing
///   or rejected for being a symlink escape).
/// - If the path exists but resolves outside the workspace via symlink AND
///   isn't under a trusted ZhiShi-managed root, returns
///   `Err("Path escapes workspace root via symlink")`.
/// - If the workspace root itself isn't canonicalizable (rare — race with
///   directory deletion), returns `Err("Workspace root canonicalize failed")`
///   rather than silently downgrading to lexical-only.
///
/// **Do not** use for write/create commands — `fs::canonicalize` fails on
/// paths that don't exist, so `new_file`/`new_folder` etc. must use the
/// lexical helper.
pub fn resolve_existing_inside_workspace(workspace_root: &Path, relative: &str) -> WfResult<PathBuf> {
    // Lexical pre-check first — same `..`/absolute/blacklist rules.
    let lexical = resolve_inside_workspace(workspace_root, relative)?;

    // Canonicalize the workspace root once. If this fails the workspace was
    // moved/deleted under us — fail closed rather than fall through.
    let canonical_root = fs::canonicalize(workspace_root)
        .map_err(|_| "Workspace root canonicalize failed".to_string())?;

    // Canonicalize the candidate. Failure means the path doesn't exist (or is
    // unreadable for permission reasons) — the caller would surface an error
    // either way, so collapse this branch into a uniform "not found".
    let canonical = fs::canonicalize(&lexical)
        .map_err(|_| "File not found".to_string())?;

    if !canonical.starts_with(&canonical_root)
        && !is_trusted_managed_target(&canonical, &trusted_managed_roots())
    {
        return Err("Path escapes workspace root via symlink".to_string());
    }

    Ok(canonical)
}

/// Canonicalized roots of ZhiShi-managed directories that we sync into
/// workspaces via junctions/symlinks. Targets under any of these roots are
/// safe to follow from in-workspace links because ZhiShi owns the source —
/// users can edit them through the Settings UI but they're not attacker-
/// controlled like an arbitrary file in a cloned repo.
///
/// Non-existent subdirs are skipped (some users won't have `agents/` etc.
/// yet). Result is recomputed each call rather than cached so newly-created
/// dirs become trusted without a sidecar restart; the work is three
/// `fs::canonicalize` calls, dwarfed by the file read that follows.
fn trusted_managed_roots() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    let zhishi = home.join(".zhishi");
    ["skills", "commands", "agents"]
        .iter()
        .filter_map(|sub| fs::canonicalize(zhishi.join(sub)).ok())
        .collect()
}

/// Returns `true` iff `canonical` is inside one of the trusted roots. Pure
/// function so tests can inject their own root set via [`trusted_managed_roots`]
/// or a literal `Vec<PathBuf>`.
fn is_trusted_managed_target(canonical: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| canonical.starts_with(root))
}

/// Reject filenames that would break on Windows or hide the file (`.`, `..`,
/// names beginning with whitespace, names containing path separators, NTFS
/// reserved names, and the Windows reserved character set).
///
/// This is the Rust equivalent of the sidecar's `isValidItemName`.
pub fn validate_item_name(name: &str) -> WfResult<()> {
    if name.is_empty() || name.trim().is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    if name != name.trim() {
        return Err("Name cannot start or end with whitespace".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("Name cannot contain path separators or '..'".to_string());
    }
    if name.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')) {
        return Err("Name contains invalid characters".to_string());
    }
    if name.chars().any(|c| (c as u32) < 0x20 || c == '\x7f') {
        return Err("Name contains control characters".to_string());
    }
    if name.chars().all(|c| c == '.') {
        return Err("Name cannot be only dots".to_string());
    }
    if is_windows_reserved_name(name) {
        return Err(format!("'{}' is a reserved Windows filename", name));
    }
    Ok(())
}

fn is_windows_reserved_name(name: &str) -> bool {
    // Windows silently strips trailing dots and spaces from filenames during
    // normalization, so `CON.`, `CON `, `CON. ` all resolve to the device
    // `CON`. Strip them before comparing the stem. (NUL bytes / control chars
    // in the stem are caught earlier by `validate_item_name`.)
    let stem_raw = name.split_once('.').map(|(s, _)| s).unwrap_or(name);
    let stem = stem_raw
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
            | "COM1" | "COM2" | "COM3" | "COM4" | "COM5"
            | "COM6" | "COM7" | "COM8" | "COM9"
            | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5"
            | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    )
}

/// Atomically write `bytes` to `target`. Writes a same-directory temp file
/// first, then `fs::rename`s it onto the target — `rename` is atomic on
/// POSIX (and Windows handles the dir-local case correctly). The temp name
/// is unique per process via a monotonic counter; `pid + counter` is enough
/// for the only realistic concurrency (one save modal per tab; AI CLAUDE.md
/// edits are sequential).
///
/// The target's parent must already exist (callers are responsible for
/// `create_dir_all` if their UX needs implicit-dir-create — `save_file.rs`
/// requires the file to exist anyway, so its parent does too).
pub fn atomic_write_file(target: &Path, bytes: &[u8]) -> Result<(), String> {
    atomic_write_file_inner(target, bytes, None)
}

/// Atomically write `bytes` only if the current target bytes still match
/// `expected_current`. The comparison runs after the tmp file is written and
/// immediately before the final rename, keeping stale autosaves from committing
/// over a newer external edit in the normal UI/AI interleaving.
pub fn atomic_write_file_if_current(
    target: &Path,
    bytes: &[u8],
    expected_current: &[u8],
) -> Result<(), String> {
    atomic_write_file_inner(target, bytes, Some(expected_current))
}

fn atomic_write_file_inner(
    target: &Path,
    bytes: &[u8],
    expected_current: Option<&[u8]>,
) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Cannot determine parent directory".to_string())?;
    let file_name = target
        .file_name()
        .ok_or_else(|| "Cannot determine filename".to_string())?
        .to_string_lossy()
        .to_string();

    static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_name = format!(
        ".{}.zhishi-{}-{}.tmp",
        file_name,
        std::process::id(),
        n
    );
    let tmp_path = parent.join(&tmp_name);

    {
        let mut tmp_file = fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create tmp file: {}", e))?;
        tmp_file
            .write_all(bytes)
            .map_err(|e| format!("Failed to write tmp file: {}", e))?;
        // Drop the file handle before rename — Windows requires this.
    }

    if let Some(expected) = expected_current {
        let current = match read_prefix(target, expected.len().saturating_add(1)) {
            Ok(current) => current,
            Err(err) => {
                let _ = fs::remove_file(&tmp_path);
                return Err(err);
            }
        };
        if current != expected {
            let _ = fs::remove_file(&tmp_path);
            return Err("File changed externally".to_string());
        }
    }

    if let Err(e) = fs::rename(&tmp_path, target) {
        // Best-effort cleanup so a failed rename doesn't leak a tmp file.
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to commit write: {}", e));
    }
    Ok(())
}

fn read_prefix(target: &Path, max_bytes: usize) -> Result<Vec<u8>, String> {
    let file = fs::File::open(target).map_err(|_| "File not found".to_string())?;
    let mut current = Vec::with_capacity(max_bytes.min(64 * 1024));
    file.take(max_bytes as u64)
        .read_to_end(&mut current)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(current)
}

/// Sanitize a filename for filesystem write — strips Windows-illegal chars by
/// replacing them with `_`. Different from `validate_item_name`, which rejects
/// rather than fixes (used at the API boundary for explicit user-typed names).
/// This one is for "user uploaded a file called `foo<bar>.pdf`" — fix not reject.
pub fn sanitize_filename(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "untitled".to_string();
    }
    trimmed
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
                || (c as u32) < 0x20
                || c == '\x7f'
            {
                '_'
            } else {
                c
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;
    use std::fs;

    fn make_tmp_workspace() -> PathBuf {
        make_test_workspace("path_safety")
    }

    #[test]
    fn rejects_relative_workspace_root() {
        assert!(validate_workspace_root("relative/path").is_err());
    }

    #[test]
    fn accepts_existing_dir() {
        let ws = make_tmp_workspace();
        let resolved = validate_workspace_root(ws.to_str().unwrap()).unwrap();
        assert_eq!(resolved, ws);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_blacklisted_dir() {
        // /etc exists on macOS/Linux; on Windows fall back to C:\Windows
        #[cfg(not(windows))]
        let blacklisted = "/etc";
        #[cfg(windows)]
        let blacklisted = "C:\\Windows";
        assert!(validate_workspace_root(blacklisted).is_err());
    }

    #[test]
    fn resolve_simple_relative() {
        let ws = make_tmp_workspace();
        let resolved = resolve_inside_workspace(&ws, "sub/file.txt").unwrap();
        assert_eq!(resolved, ws.join("sub").join("file.txt"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn resolve_dot_returns_root() {
        let ws = make_tmp_workspace();
        let resolved = resolve_inside_workspace(&ws, "").unwrap();
        assert_eq!(resolved, ws);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_absolute_relative() {
        let ws = make_tmp_workspace();
        assert!(resolve_inside_workspace(&ws, "/etc/passwd").is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_traversal_escape() {
        let ws = make_tmp_workspace();
        assert!(resolve_inside_workspace(&ws, "../etc").is_err());
        assert!(resolve_inside_workspace(&ws, "a/../../etc").is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn allows_internal_traversal() {
        let ws = make_tmp_workspace();
        // a/b/.. == a — legal
        let resolved = resolve_inside_workspace(&ws, "a/b/../c").unwrap();
        assert_eq!(resolved, ws.join("a").join("c"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn validate_item_name_allows_unicode() {
        assert!(validate_item_name("说明.md").is_ok());
        assert!(validate_item_name("file_1-2.txt").is_ok());
    }

    #[test]
    fn validate_item_name_rejects_separators() {
        assert!(validate_item_name("a/b").is_err());
        assert!(validate_item_name("a\\b").is_err());
        assert!(validate_item_name("..").is_err());
    }

    #[test]
    fn validate_item_name_rejects_windows_reserved() {
        assert!(validate_item_name("CON").is_err());
        assert!(validate_item_name("con.txt").is_err());
        assert!(validate_item_name("LPT1.log").is_err());
    }

    // Cross-review regression guard: Windows normalizes `CON.`, `CON `,
    // `COM1   . ` etc. to the underlying device. The reserved-name check
    // must trim trailing dots/spaces before comparing the stem, otherwise a
    // user-typed name slips past validation but still resolves to the
    // device on Windows.
    #[test]
    fn validate_item_name_rejects_windows_reserved_with_trailing_chars() {
        assert!(validate_item_name("CON.").is_err());
        assert!(validate_item_name("CON ").is_err());
        assert!(validate_item_name("COM1.").is_err());
        assert!(validate_item_name("PRN. .").is_err());
        // Make sure regular names with trailing dot in stem still pass the
        // reserved-name gate (other rules may still reject them, but not
        // this one). `foo.txt` has stem "foo" which trims to "foo".
        // `foo.` has stem "foo" too — should pass reserved-name gate.
        assert!(validate_item_name("foo.").is_ok());
    }

    #[test]
    fn validate_item_name_rejects_control_chars() {
        assert!(validate_item_name("a\x00b").is_err());
        assert!(validate_item_name("\tfoo").is_err());
    }

    #[test]
    fn sanitize_strips_illegal_chars() {
        assert_eq!(sanitize_filename("foo<bar>.pdf"), "foo_bar_.pdf");
        assert_eq!(sanitize_filename("a:b/c"), "a_b_c");
    }

    #[test]
    fn sanitize_falls_back_to_untitled() {
        assert_eq!(sanitize_filename(""), "untitled");
        assert_eq!(sanitize_filename("   "), "untitled");
    }

    #[test]
    fn atomic_write_if_current_cleans_tmp_when_current_read_fails() {
        let ws = make_tmp_workspace();
        let target = ws.join("missing.md");

        let res = atomic_write_file_if_current(&target, b"new content", b"old content");

        assert!(res.is_err());
        let leftovers: Vec<String> = fs::read_dir(&ws)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".zhishi-"))
            .collect();
        assert!(leftovers.is_empty(), "tmp leftovers: {:?}", leftovers);
        let _ = fs::remove_dir_all(&ws);
    }

    // ── resolve_existing_inside_workspace — Phase D.5 symlink hardening ──

    #[test]
    fn resolve_existing_finds_real_file() {
        let ws = make_tmp_workspace();
        fs::write(ws.join("foo.txt"), "x").unwrap();
        let resolved = resolve_existing_inside_workspace(&ws, "foo.txt").unwrap();
        // Both should canonicalize to the same path.
        assert_eq!(resolved, fs::canonicalize(ws.join("foo.txt")).unwrap());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn resolve_existing_rejects_missing() {
        let ws = make_tmp_workspace();
        let res = resolve_existing_inside_workspace(&ws, "nope.txt");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("File not found"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn resolve_existing_rejects_traversal() {
        let ws = make_tmp_workspace();
        let res = resolve_existing_inside_workspace(&ws, "../etc");
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    // The headline regression guard: a malicious symlink inside the
    // workspace pointing outside (e.g. cloned repo with `evil_link → /etc`)
    // must be rejected by read-side commands. Lexical resolve passes — the
    // link IS at `<ws>/evil_link` which starts_with workspace — so we rely
    // on the canonicalize check to catch the escape.
    #[cfg(unix)]
    #[test]
    fn resolve_existing_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_workspace();
        // Target outside the workspace.
        let outside_dir = std::env::temp_dir().join(format!(
            "ws_outside_{}",
            std::process::id()
        ));
        fs::create_dir_all(&outside_dir).unwrap();
        let outside_file = outside_dir.join("secret.txt");
        fs::write(&outside_file, "secret").unwrap();
        // Symlink inside ws → outside file.
        symlink(&outside_file, ws.join("evil_link")).unwrap();

        let res = resolve_existing_inside_workspace(&ws, "evil_link");
        assert!(res.is_err());
        assert!(
            res.unwrap_err().contains("symlink"),
            "expected symlink-escape error"
        );
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&outside_dir);
    }

    // Symlinks INSIDE the workspace pointing to other files INSIDE the
    // workspace should still be allowed — they're a legitimate user pattern
    // (e.g. linking `current → builds/v3`). Canonicalize collapses them but
    // both ends remain inside the canonical root.
    #[cfg(unix)]
    #[test]
    fn resolve_existing_allows_internal_symlink() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_workspace();
        fs::write(ws.join("real.txt"), "ok").unwrap();
        symlink(ws.join("real.txt"), ws.join("link.txt")).unwrap();
        let resolved = resolve_existing_inside_workspace(&ws, "link.txt").unwrap();
        // Should resolve to the real file (canonicalize follows the link).
        assert_eq!(resolved, fs::canonicalize(ws.join("real.txt")).unwrap());
        let _ = fs::remove_dir_all(&ws);
    }

    // Broken symlink inside workspace — canonicalize fails → "File not found".
    // This is the right behavior: the read commands would error on read
    // anyway, and surfacing it here is uniform.
    #[cfg(unix)]
    #[test]
    fn resolve_existing_handles_broken_symlink() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_workspace();
        symlink("/nonexistent/target", ws.join("broken")).unwrap();
        let res = resolve_existing_inside_workspace(&ws, "broken");
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    // ── is_trusted_managed_target — Phase E skill-junction whitelist ──

    #[test]
    fn trusted_target_matches_root() {
        let root = std::env::temp_dir().join(format!("trusted_root_{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let canonical_root = fs::canonicalize(&root).unwrap();
        let child = canonical_root.join("baoyu-imagine").join("SKILL.md");
        assert!(is_trusted_managed_target(&child, &[canonical_root.clone()]));
        // Sibling-of-prefix must NOT match — `starts_with` works on path
        // components, so `/tmp/trusted` does not pretend to contain
        // `/tmp/trusted_evil` even though the string starts the same.
        let evil = canonical_root.parent().unwrap().join(format!(
            "{}_evil",
            canonical_root.file_name().unwrap().to_string_lossy()
        ));
        assert!(!is_trusted_managed_target(&evil, &[canonical_root]));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn trusted_target_empty_roots_rejects_everything() {
        // Defence: if `trusted_managed_roots()` returns empty (no `.zhishi`
        // dir yet), the whitelist degrades closed — `is_trusted_managed_target`
        // returns false for any path so the original symlink-escape rejection
        // still fires.
        let p = Path::new("/anywhere");
        assert!(!is_trusted_managed_target(p, &[]));
    }

    // Headline whitelist test: a junction-like symlink in the workspace
    // pointing into a trusted root MUST resolve successfully even though the
    // target is outside the canonical workspace. This unblocks Windows users
    // hitting "文件预览失败" on user-level skill links synced by
    // `agent-session.ts:syncProjectSkillSymlinks`.
    #[cfg(unix)]
    #[test]
    fn resolve_existing_allows_symlink_into_trusted_root() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_workspace();
        // Stand in for `~/.zhishi/skills/`.
        let managed = std::env::temp_dir().join(format!(
            "managed_skills_{}",
            std::process::id()
        ));
        let managed_skill = managed.join("baoyu-imagine");
        fs::create_dir_all(&managed_skill).unwrap();
        let real_md = managed_skill.join("SKILL.md");
        fs::write(&real_md, "skill content").unwrap();

        // Mirror the prod symlink shape: `<ws>/.claude/skills/baoyu-imagine`
        // points at the managed skill dir.
        let link_parent = ws.join(".claude").join("skills");
        fs::create_dir_all(&link_parent).unwrap();
        symlink(&managed_skill, link_parent.join("baoyu-imagine")).unwrap();

        let canonical_managed = fs::canonicalize(&managed).unwrap();

        // Direct: bypass `trusted_managed_roots()` (which reads real
        // `~/.zhishi/`) and inject our tmp root via the pure helper.
        let lexical = resolve_inside_workspace(
            &ws,
            ".claude/skills/baoyu-imagine/SKILL.md",
        )
        .unwrap();
        let canonical = fs::canonicalize(&lexical).unwrap();
        assert!(
            is_trusted_managed_target(&canonical, &[canonical_managed]),
            "skill target under managed root should be trusted: {:?}",
            canonical
        );
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&managed);
    }
}
