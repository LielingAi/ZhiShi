//! Test-only helper to allocate a temp workspace directory that does NOT
//! collide with the system-directory blacklist applied by
//! `path_safety::validate_workspace_root`.
//!
//! Why this exists: macOS `std::env::temp_dir()` returns paths under
//! `/var/folders/...` and `/var` is a blacklisted root (correctly — sidecar
//! must not write to system locations). Using `~/Library/Caches/<sub>` (or
//! the platform equivalent of `dirs::cache_dir`) gives every test a
//! per-process / per-counter directory that satisfies validation while
//! still being a "scratch" location the OS reclaims.
//!
//! Each test cleans up its own directory; we don't share state across tests.

#![cfg(test)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Allocate a fresh test workspace directory rooted under the user's cache
/// dir. Callers MUST `remove_dir_all` after they finish.
pub fn make_test_workspace(scope: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let root = dirs::cache_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join(".cache")))
        .expect("no home dir for test scratch space");
    let dir = root.join("zhishi-tests").join(format!(
        "{}_{}_{}",
        scope,
        std::process::id(),
        n
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create scratch dir");
    dir
}
