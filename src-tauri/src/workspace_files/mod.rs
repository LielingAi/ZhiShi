//! Workspace path safety.
//!
//! The renderer-facing `cmd_workspace_*` command layer was deleted in the W6
//! subtraction (windowless host — no IPC consumers). What remains is the
//! shared path-validation core used by live code:
//!
//! - `sidecar.rs` validates agent/workspace roots before spawning processes.
//! - `panel_api.rs` validates `/term/open` workspace paths.
//!
//! `lib.rs` historically registered each command with the FULL submodule path
//! because `tauri::generate_handler!` resolves the generated `__cmd__<name>`
//! wrapper in the defining module; with the command layer gone, only
//! `path_safety` (plus its test helper) remains.

pub mod path_safety;
#[cfg(test)]
pub(crate) mod test_support;
