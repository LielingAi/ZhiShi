/**
 * fetcher.ts — Resolve a ResolvedPluginSource into an in-memory ExtractedTree.
 *
 * For remote sources we reuse ./tarball-fetcher.ts (GitHub or raw zip,
 * SSRF-guarded, size-capped, manual-redirect-validated). For local sources
 * we walk the directory and produce the same `ExtractedTree` shape so the
 * downstream installer can stay source-agnostic.
 *
 * Local-directory limits mirror the tarball limits (50MB / 2000 files / 5MB
 * per file) to keep "drop a project folder by mistake" failures predictable.
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from 'fs';
import { basename, dirname, join, relative, sep } from 'path';

import {
  fetchSkillZip,
  TarballFetchError,
  type ExtractedTree,
} from './tarball-fetcher';
import type { ResolvedPluginSource } from './url-resolver';

// Local-dir scan limits (mirror tarball-fetcher constants for behavioural parity)
const LOCAL_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const LOCAL_MAX_FILES = 2000;
const LOCAL_MAX_FILE_BYTES = 5 * 1024 * 1024;

export class PluginFetchError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'PluginFetchError';
    this.statusCode = statusCode;
  }
}

/** Single entrypoint — discharges any source into an ExtractedTree. */
export async function fetchPluginTree(src: ResolvedPluginSource): Promise<ExtractedTree> {
  if (src.kind === 'remote') {
    try {
      return await fetchSkillZip(src.tarball);
    } catch (err) {
      if (err instanceof TarballFetchError) {
        throw new PluginFetchError(err.message, err.statusCode);
      }
      throw err;
    }
  }
  return readLocalDirTree(src.absolutePath);
}

// -----------------------------------------------------------------------------
// Local directory → ExtractedTree
// -----------------------------------------------------------------------------

function readLocalDirTree(absRootInput: string): ExtractedTree {
  // Defense against the "parent-symlink escape" boundary attack: attacker
  // plants `~/safe/escape → /etc`, user is told to `install file:///~/safe/escape/X`.
  // Strict-equality realpath would falsely reject macOS's system-wide
  // `/tmp → /private/tmp` and `/var → /private/var` aliases too. The
  // correct semantic: realpath(parent) + basename(input) must equal
  // realpath(input). This passes when ancestor symlinks resolve
  // consistently (system aliases) but rejects when the LEAF is a symlink
  // OR when an ancestor symlink renames into a different leaf (the attack
  // shape).
  //
  // /tmp/foo:                   parent=realpath(/tmp)=/private/tmp;
  //                             join+basename = /private/tmp/foo;
  //                             realpath(/tmp/foo) = /private/tmp/foo  → EQUAL ✓
  //
  // /Users/me/safe/escape (→ /etc):
  //                             parent=realpath(/Users/me/safe)=/Users/me/safe;
  //                             join+basename = /Users/me/safe/escape;
  //                             realpath(/Users/me/safe/escape) = /etc  → NOT EQUAL → reject
  let absRoot: string;
  try {
    const parentCanonical = realpathSync(dirname(absRootInput));
    const leafCanonical = realpathSync(absRootInput);
    if (join(parentCanonical, basename(absRootInput)) !== leafCanonical) {
      throw new PluginFetchError(
        `路径含 symlink 改写，拒绝安装：${absRootInput} → ${leafCanonical}。请直接传入真实路径`,
        400,
      );
    }
    absRoot = leafCanonical;
  } catch (err) {
    if (err instanceof PluginFetchError) throw err;
    throw new PluginFetchError(`本地路径不存在：${absRootInput}`, 404);
  }

  let rootStat;
  try {
    rootStat = lstatSync(absRoot);
  } catch {
    throw new PluginFetchError(`本地路径不存在：${absRoot}`, 404);
  }
  // Defense in depth — realpath already rejected leaf symlinks, but
  // recheck explicitly so a TOCTOU window between realpath and lstat
  // can't swap a symlink in.
  if (rootStat.isSymbolicLink()) {
    throw new PluginFetchError('拒绝从 symlink 安装：请使用 symlink 指向的真实路径', 400);
  }
  if (!rootStat.isDirectory()) {
    throw new PluginFetchError(`本地路径不是目录：${absRoot}`, 400);
  }

  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  let fileCount = 0;

  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch (err) {
      throw new PluginFetchError(`读取目录失败：${dir} (${(err as Error).message})`, 500);
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      // Skip hidden dotdirs except .claude-plugin / .mcp.json / .lsp.json
      if (
        entry.name.startsWith('.') &&
        entry.name !== '.claude-plugin' &&
        entry.name !== '.mcp.json' &&
        entry.name !== '.lsp.json'
      ) {
        continue;
      }
      // Skip common noise users might accidentally include
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === '__MACOSX' ||
        entry.name === '.DS_Store'
      ) {
        continue;
      }

      // Always lstat — never follow symlinks while walking
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        // Per Claude Code's marketplace symlink rules: skip externally-targeted
        // symlinks for safety. We can't validate "stays inside same marketplace"
        // for a local dir, so we skip ALL symlinks during local install.
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;

      if (st.size > LOCAL_MAX_FILE_BYTES) {
        throw new PluginFetchError(
          `文件过大：${relative(absRoot, full)} (${Math.round(st.size / 1024 / 1024)} MB > 5 MB)`,
          413,
        );
      }
      totalBytes += st.size;
      fileCount += 1;
      if (totalBytes > LOCAL_MAX_TOTAL_BYTES) {
        throw new PluginFetchError(
          `目录总大小超限 (${Math.round(totalBytes / 1024 / 1024)} MB > 50 MB)`,
          413,
        );
      }
      if (fileCount > LOCAL_MAX_FILES) {
        throw new PluginFetchError(`文件数过多 (>${LOCAL_MAX_FILES})`, 413);
      }

      let buf: Buffer;
      try {
        buf = readFileSync(full);
      } catch (err) {
        throw new PluginFetchError(
          `读取文件失败：${relative(absRoot, full)} (${(err as Error).message})`,
          500,
        );
      }
      // Normalize to POSIX-style relative path
      const rel = relative(absRoot, full).split(sep).join('/');
      files.set(rel, buf);
    }
  };

  walk(absRoot);

  if (files.size === 0) {
    throw new PluginFetchError('目录为空或没有可用文件', 422);
  }

  return {
    files,
    sourceUrl: `file://${absRoot}`,
  };
}

/** Lightweight existence check (used by store to detect "directory was deleted externally") */
export function pluginInstallPathExists(installPath: string): boolean {
  try {
    return statSync(installPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check whether `installPath` is currently a "broken symlink" — exists per
 * lstat but the target is gone. We MUST unlink before any write/cp operation
 * because Node v24's cpSync calls std::filesystem::equivalent which throws
 * an uncaught C++ exception on dangling symlinks and aborts the sidecar
 * (see CLAUDE.md "断链 symlink" red-line for the v0.2.5 repro).
 */
export function isBrokenSymlink(p: string): boolean {
  let lst;
  try {
    lst = lstatSync(p);
  } catch {
    return false;
  }
  if (!lst.isSymbolicLink()) return false;
  // exists() follows symlinks — if it returns false on a symlink, it's broken
  return !existsSync(p);
}
