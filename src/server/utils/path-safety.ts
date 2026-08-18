/**
 * Node 镜像的 path-safety helpers — 与 Rust `src-tauri/src/commands.rs::validate_file_path`
 * 黑名单条目保持同步。
 *
 * 为什么需要镜像而不是 invoke 走 Rust：
 *
 * - dependency-cruiser 强制 `src/server/**` 不能 import Rust 代码
 * - sidecar 进程内（Node）需要在 attachment 落盘 helper 同步路径上做黑名单
 *   过滤，调 Tauri invoke 不可用（Node 不在 Webview context）
 *
 * 维护契约：本文件的黑名单条目 MUST 与 Rust validate_file_path 同步。三处同改：
 * (1) 本文件、(2) Rust commands.rs::validate_file_path、(3) 共享 fixture
 * `src/shared/path-safety-blacklist.json`。两侧各有一个测试断言「自己的条目 ==
 * fixture」（Node: path-safety-crosscheck.unit.test.ts；Rust:
 * commands.rs::path_safety_crosscheck_tests），任一处与 fixture 漂移即测试失败。
 *
 * 详见 PRD 0.2.15 §4.5 + §7.2。
 */

import { homedir, platform } from 'node:os';
import { getZhiShiDataDir } from './app-dirs';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

const HOME = homedir() || '';

const POSIX_SYSTEM_DIRS = ['/etc', '/var', '/usr', '/bin', '/sbin', '/boot', '/root', '/sys', '/proc', '/dev'];
// macOS symlinks /etc → /private/etc and /var → /private/var. With
// canonicalizeSymlinks the realpath of a symlink-escape lands in the canonical
// /private location, which the bare /etc|/var entries miss (a literal
// /private/etc path slips the lexical check too). Block both forms.
const MACOS_PRIVATE_DIRS = ['/private/etc', '/private/var'];
const WIN_SYSTEM_DIRS = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData', 'C:\\Recovery', 'C:\\$Recycle.Bin'];
const SYSTEM_BLACKLIST: readonly string[] =
  platform() === 'win32'
    ? WIN_SYSTEM_DIRS
    : platform() === 'darwin'
      ? [...POSIX_SYSTEM_DIRS, ...MACOS_PRIVATE_DIRS]
      : POSIX_SYSTEM_DIRS;

const CREDENTIAL_SUBDIRS: readonly string[] = ['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.config/op'];

const MAC_SENSITIVE_SUBDIRS: readonly string[] = [
  'Library/Keychains',
  'Library/Cookies',
  'Library/Mail',
  'Library/Messages',
  'Library/Safari',
];

const WIN_SENSITIVE_SUBDIRS: readonly string[] = ['AppData/Local/Microsoft'];

/**
 * The raw blacklist pieces, exposed for the Node↔Rust cross-check test ONLY
 * (path-safety-crosscheck.unit.test.ts). Platform-independent so the test can
 * compare every list against the shared fixture on any OS — unlike
 * SYSTEM_BLACKLIST which composes per the runtime platform. Not for runtime use.
 */
export const __blacklistForCrossCheck = {
  systemDirsPosix: POSIX_SYSTEM_DIRS,
  systemDirsMacosExtra: MACOS_PRIVATE_DIRS,
  systemDirsWindows: WIN_SYSTEM_DIRS,
  credentialSubdirs: CREDENTIAL_SUBDIRS,
  macSensitiveSubdirs: MAC_SENSITIVE_SUBDIRS,
  winSensitiveSubdirs: WIN_SENSITIVE_SUBDIRS,
} as const;

/** Trusted root for ZhiShi-owned tool attachments (relative to $HOME). */
export const TOOL_ATTACHMENT_ROOT_REL = '.zhishi/generated/tool-attachments';

export interface PathSafetyOk {
  ok: true;
  /** Resolved (.. components folded) absolute path. */
  canonical: string;
}

export interface PathSafetyErr {
  ok: false;
  reason: string;
}

export type PathSafetyResult = PathSafetyOk | PathSafetyErr;

/**
 * Validate an arbitrary absolute path is safe to READ from.
 *
 * Mirrors Rust `commands::validate_file_path` semantics:
 * - rejects non-absolute paths
 * - folds .. / . components
 * - rejects system blacklist + credential dirs + OS-specific sensitive subdirs
 *
 * Read-side hardening (CLAUDE.md red line "evil_link → /etc/passwd"):
 *   `canonicalizeSymlinks=true` (default) resolves symlinks via fs.realpath
 *   and runs the blacklist against the resolved path. Prevents a `~/.codex/
 *   sessions/evil.png → /etc/passwd` symlink from leaking secrets through
 *   the attachment endpoint.
 *
 * NOTE: existence is required when canonicalizeSymlinks=true (realpath throws
 * on missing files). Callers that need lexical-only validation (write side,
 * before file exists) pass canonicalizeSymlinks=false.
 */
export function validateExternalReadPathNode(
  rawPath: string,
  opts: { canonicalizeSymlinks?: boolean } = {},
): PathSafetyResult {
  if (!rawPath) return { ok: false, reason: 'Path is empty' };
  if (!path.isAbsolute(rawPath)) return { ok: false, reason: 'Path must be absolute' };

  const canonicalize = opts.canonicalizeSymlinks ?? true;

  // First pass: lexical fold to catch attacks that don't require fs access.
  let canonical = path.normalize(rawPath);

  // Apply blacklist BEFORE realpath to catch the obvious cases without an fs hit.
  const blacklistResult = checkBlacklist(canonical);
  if (!blacklistResult.ok) return blacklistResult;

  if (canonicalize) {
    // Reject symlinks outright on the leaf — defense-in-depth even when realpath
    // resolves correctly, since `fs.realpath` doesn't fail on symlinks, it follows them.
    try {
      const lst = lstatSync(canonical);
      if (lst.isSymbolicLink()) {
        return { ok: false, reason: 'Access denied: symbolic link target not allowed' };
      }
    } catch {
      // Missing path is fine — let realpath throw with the proper error below,
      // or caller's stat() catch handle it.
    }

    // Resolve any symlinks in parent components and re-check blacklist on the
    // realpath. This catches `~/.codex/sessions/evil_link/file.png` where
    // `evil_link` → `/etc/passwd` parent.
    try {
      canonical = realpathSync(canonical);
    } catch {
      // Path doesn't exist — fine for read-side existence check by caller.
    }
    const recheck = checkBlacklist(canonical);
    if (!recheck.ok) return recheck;
  }

  return { ok: true, canonical };
}

function checkBlacklist(canonical: string): PathSafetyResult {
  for (const dir of SYSTEM_BLACKLIST) {
    if (startsWithPath(canonical, dir)) {
      return { ok: false, reason: 'Access denied: protected system directory' };
    }
  }

  if (HOME) {
    for (const name of CREDENTIAL_SUBDIRS) {
      if (startsWithPath(canonical, path.join(HOME, ...name.split('/')))) {
        return { ok: false, reason: 'Access denied: protected credential directory' };
      }
    }
    if (platform() === 'darwin') {
      for (const name of MAC_SENSITIVE_SUBDIRS) {
        if (startsWithPath(canonical, path.join(HOME, ...name.split('/')))) {
          return { ok: false, reason: 'Access denied: protected system directory' };
        }
      }
    } else if (platform() === 'win32') {
      for (const name of WIN_SENSITIVE_SUBDIRS) {
        if (startsWithPath(canonical, path.join(HOME, ...name.split('\\')))) {
          return { ok: false, reason: 'Access denied: protected system directory' };
        }
      }
    }
  }

  return { ok: true, canonical };
}

/**
 * Validate that `target` is inside the ZhiShi-owned attachment root
 * (`~/.zhishi/generated/tool-attachments/...`). Used by `saveToolAttachment`
 * to refuse writes outside the trusted root.
 */
export function validateTrustedAttachmentRoot(
  target: string,
  opts: { canonicalizeSymlinks?: boolean } = {},
): PathSafetyResult {
  const dataDir = getZhiShiDataDir();
  const root = path.join(dataDir, ...TOOL_ATTACHMENT_ROOT_REL.split('/'));
  const canonical = path.normalize(target);
  if (!startsWithPath(canonical, root)) {
    return { ok: false, reason: `Path is outside trusted attachment root (${root})` };
  }
  // Defense-in-depth: still run the system blacklist. canonicalizeSymlinks
  // defaults to false because callers pass paths that may not yet exist
  // (the file is about to be written).
  return validateExternalReadPathNode(canonical, { canonicalizeSymlinks: opts.canonicalizeSymlinks ?? false });
}

/** Get the absolute attachment root path. */
export function getToolAttachmentRoot(): string {
  return path.join(getZhiShiDataDir(), ...TOOL_ATTACHMENT_ROOT_REL.split('/'));
}

function startsWithPath(child: string, parent: string): boolean {
  if (!parent.endsWith(path.sep)) parent = parent + path.sep;
  const childSlash = child.endsWith(path.sep) ? child : child + path.sep;
  // Case-insensitive on Windows
  if (platform() === 'win32') {
    return childSlash.toLowerCase().startsWith(parent.toLowerCase());
  }
  return childSlash.startsWith(parent);
}
