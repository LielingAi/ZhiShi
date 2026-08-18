//! Canonical workspace-path identity — Rust port of
//! `src/shared/workspacePath.ts::normalizeWorkspacePathIdentity`.
//!
//! Why this exists (#320): persisted stores legitimately disagree on
//! separator style (`projects.json` keeps backslashes from the Windows file
//! dialog; cron/task/session paths are POSIX-style). Comparing them with raw
//! `==` silently mismatches on Windows. The TS module was written as a port
//! of the (since-deleted) `cron_task.rs::normalize_path`; after the cron
//! purge neither side had the Rust half — this module restores it
//! (2026-08-06 audit F-13).
//!
//! Semantics (byte-for-byte parity with the TS port):
//!  - backslash → slash, but ONLY for Windows-style paths (drive `X:`, UNC
//!    `\\`, or `//`); POSIX paths keep literal backslashes.
//!  - trim trailing slashes, preserving the root (`C:/`, `//`, `/`).
//!  - lowercase Windows drive / UNC identities; POSIX paths stay
//!    case-sensitive.

/// Canonical lexical identity for a workspace path.
pub fn normalize_workspace_path_identity(path: &str) -> String {
    let windows_style =
        path.len() >= 2 && path.as_bytes()[1] == b':' || path.starts_with("\\\\") || path.starts_with("//");
    let mut normalized = if windows_style { path.replace('\\', "/") } else { path.to_string() };
    if normalized.is_empty() {
        return normalized;
    }

    // Protected root length so trailing-slash trimming never eats the root.
    let bytes = normalized.as_bytes();
    let min_len = if bytes.len() >= 3 && bytes[1] == b':' && bytes[2] == b'/' {
        3 // Windows drive root: C:/
    } else if normalized.starts_with("//") {
        2 // UNC / network root prefix
    } else if normalized.starts_with('/') {
        1 // POSIX root
    } else {
        0
    };
    while normalized.len() > min_len && normalized.ends_with('/') {
        normalized.pop();
    }

    let is_windows_identity =
        normalized.len() >= 2 && normalized.as_bytes()[1] == b':' || normalized.starts_with("//");
    if is_windows_identity {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

/// True when two workspace paths denote the same workspace under the
/// canonical identity above. Use this — never raw `==` — whenever paths from
/// different stores are compared (config agents vs session workspace, etc.).
pub fn workspace_paths_equal(a: &str, b: &str) -> bool {
    normalize_workspace_path_identity(a) == normalize_workspace_path_identity(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backslash_forwardslash_equivalence() {
        assert!(workspace_paths_equal("C:\\Users\\me\\proj", "C:/Users/me/proj"));
    }

    #[test]
    fn windows_case_insensitive() {
        assert!(workspace_paths_equal("c:/users/me/proj", "C:/Users/Me/Proj"));
    }

    #[test]
    fn trailing_slash_trimmed() {
        assert!(workspace_paths_equal("C:/Users/me/proj/", "C:/Users/me/proj"));
        assert!(workspace_paths_equal("/tmp/proj/", "/tmp/proj"));
    }

    #[test]
    fn root_preserved() {
        assert_eq!(normalize_workspace_path_identity("C:/"), "c:/");
        assert_eq!(normalize_workspace_path_identity("/"), "/");
        assert_eq!(normalize_workspace_path_identity("//"), "//");
    }

    #[test]
    fn posix_backslash_is_literal() {
        // POSIX keeps backslashes: /tmp/a\b is NOT /tmp/a/b
        assert!(!workspace_paths_equal("/tmp/a\\b", "/tmp/a/b"));
    }

    #[test]
    fn posix_case_sensitive() {
        assert!(!workspace_paths_equal("/tmp/Proj", "/tmp/proj"));
    }

    #[test]
    fn distinct_paths_stay_distinct() {
        assert!(!workspace_paths_equal("C:/a", "C:/b"));
    }
}
