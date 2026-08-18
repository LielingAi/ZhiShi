// Canonical workspace-path identity — the single renderer-side comparator for
// "do these two paths denote the same workspace?".
//
// Why this exists (#320): the persisted stores legitimately disagree on
// separator style. `projects.json` keeps the raw path from the Windows native
// file dialog (`C:\Users\…`, BACKSLASHES) while a cron/task `workspacePath` is
// stored POSIX-style (`C:/Users/…`, forward slashes). Comparing them with `===`
// made EVERY Windows legacy-cron upgrade fail with "找不到工作区", and the same
// mismatch silently breaks every task/cron card that resolves its Project by
// workspace path (the Rust upgrade copies the cron's forward-slash path straight
// into the new Task, so the divergence propagates forward).
//
// Rust already treats the two forms as one workspace: `CronTaskManager::
// get_tasks_for_workspace` groups tasks via `normalize_path`
// (`src-tauri/src/cron_task.rs`). This module is the byte-for-byte TS port of
// that function, so the renderer resolves "which Project owns this path" with
// the SAME identity Rust used to group the tasks — the two sides agree by
// construction instead of by remembering to `.replace(/\\/g,'/')` at each call
// site (a safety step that, per the project's pit-of-success rule, WILL be
// forgotten somewhere — exactly how #320 happened).

/**
 * Canonical lexical identity for a workspace path. Mirrors the Rust
 * `normalize_path` in `src-tauri/src/cron_task.rs` (see its `normalize_path_*`
 * unit tests for the authoritative cases).
 *
 * Semantics:
 *  - backslash → slash, but ONLY for Windows-style paths (drive `X:`, UNC `\\`,
 *    or `//`); POSIX paths keep literal backslashes (a valid filename char) so
 *    `/tmp/a\b` stays distinct from `/tmp/a/b`.
 *  - trim trailing slashes, preserving the root (`C:/`, `//`, `/`).
 *  - lowercase Windows drive / UNC identities (the Windows FS is
 *    case-insensitive); POSIX paths stay case-sensitive.
 */
export function normalizeWorkspacePathIdentity(path: string): string {
  const windowsStyle =
    (path.length >= 2 && path[1] === ':') ||
    path.startsWith('\\\\') ||
    path.startsWith('//');
  let normalized = windowsStyle ? path.replace(/\\/g, '/') : path;
  if (normalized.length === 0) return normalized;

  // Determine the protected root length so trailing-slash trimming never eats
  // the root marker.
  let minLen = 0;
  if (normalized.length >= 3 && normalized[1] === ':' && normalized[2] === '/') {
    minLen = 3; // Windows drive root: C:/
  } else if (normalized.startsWith('//')) {
    minLen = 2; // UNC / network root prefix
  } else if (normalized.startsWith('/')) {
    minLen = 1; // POSIX root
  }
  while (normalized.length > minLen && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  const isWindowsIdentity =
    (normalized.length >= 2 && normalized[1] === ':') || normalized.startsWith('//');
  return isWindowsIdentity ? normalized.toLowerCase() : normalized;
}

/**
 * True when two workspace paths denote the same workspace under the canonical
 * identity above. Use this — never raw `===` — whenever a `Project.path` is
 * compared against a path that may originate from a different store
 * (`CronTask.workspacePath`, `Task.workspacePath`, session `agentDir`, config
 * `defaultWorkspacePath`). See #320.
 *
 * Accepts nullish on either side (many of these paths are optional config
 * fields) and treats it as the empty identity, mirroring how the previous raw
 * `===` comparisons silently yielded `false` against an `undefined` path.
 */
export function workspacePathsEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return normalizeWorkspacePathIdentity(a ?? '') === normalizeWorkspacePathIdentity(b ?? '');
}
