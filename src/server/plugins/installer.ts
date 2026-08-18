/**
 * installer.ts — Decide where in a fetched tree the plugin root lives and
 * write the filtered subtree to ~/.zhishi/plugins/<name>/.
 *
 * Single entry: `analysePluginTree(tree, subPathHint?)` → returns either the
 * resolved plugin manifest + the slice of the tree to write, or one of the
 * specific failure modes:
 *
 *   - 'no-plugin'         no `.claude-plugin/plugin.json` anywhere in tree
 *   - 'multi-plugin'      multiple plugin roots — v0.2.17 refuses (marketplace
 *                         install lands here; user must point at a single
 *                         sub-directory)
 *   - 'marketplace'       has `.claude-plugin/marketplace.json` only — also
 *                         not supported in v0.2.17 (give a friendly error)
 *
 * Disk writing uses the zip-slip-guarded `writeSkillFiles` helper below —
 * one audited write path (moved in-tree from the removed skills installer).
 */

import { existsSync, rmSync, unlinkSync, lstatSync, writeFileSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';

import type { ExtractedTree } from './tarball-fetcher';
import { ensureDirSync } from '../utils/fs-utils';
import { parsePluginManifest } from './manifest';
import type { PluginManifest } from '../../shared/types/plugin';
import { isBrokenSymlink } from './fetcher';

/**
 * One candidate in a multi-plugin tree. Manifest is parsed eagerly so the
 * inspect endpoint can surface name/version/description to the UI without a
 * second round-trip. `manifestError` is set instead of throwing when an
 * individual candidate's plugin.json is malformed — the rest of the picker
 * should still work.
 */
export interface MultiPluginCandidate {
  rootPath: string;
  manifest?: PluginManifest;
  manifestError?: string;
}

export type PluginAnalysis =
  | { mode: 'plugin'; manifest: PluginManifest; rootPath: string }
  | { mode: 'marketplace'; marketplaceName?: string; pluginNames: string[] }
  | { mode: 'multi-plugin'; candidates: MultiPluginCandidate[] }
  | { mode: 'no-plugin' };

export class PluginInstallError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(message: string, code: string, statusCode = 400) {
    super(message);
    this.name = 'PluginInstallError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const MANIFEST_REL = '.claude-plugin/plugin.json';
const MARKETPLACE_REL = '.claude-plugin/marketplace.json';

/**
 * Walk an ExtractedTree and decide which mode this install is in.
 *
 * If `subPathHint` is supplied (e.g. the user passed a /tree/<ref>/sub/path
 * GitHub URL), we restrict the search to that prefix — useful for monorepo
 * plugins where the user wants to install only one of N siblings.
 */
export function analysePluginTree(
  tree: ExtractedTree,
  subPathHint?: string,
): PluginAnalysis {
  const prefix = subPathHint ? subPathHint.replace(/\/+$/, '') + '/' : '';

  // Find every plugin.json
  const pluginRoots: string[] = [];
  for (const key of tree.files.keys()) {
    if (!key.endsWith(MANIFEST_REL)) continue;
    // Strip the trailing `.claude-plugin/plugin.json` segment to get root path
    const root = key.slice(0, key.length - MANIFEST_REL.length).replace(/\/+$/, '');
    if (prefix && root !== prefix.replace(/\/+$/, '') && !root.startsWith(prefix)) continue;
    if (!prefix && root !== '' && root.includes('/')) {
      // Allow deeply-nested only if it's the sole one — surfaced via
      // pluginRoots.length check below.
    }
    pluginRoots.push(root);
  }

  // Marketplace detection (only meaningful if no plugin.json found at top)
  if (pluginRoots.length === 0) {
    const mpKeys = [...tree.files.keys()].filter(k => k.endsWith(MARKETPLACE_REL));
    if (mpKeys.length > 0) {
      // Parse to list plugin names for a friendlier error
      let mpName: string | undefined;
      const names: string[] = [];
      try {
        const buf = tree.files.get(mpKeys[0]);
        if (buf) {
          const parsed = JSON.parse(buf.toString('utf-8')) as {
            name?: string;
            plugins?: Array<{ name?: string }>;
          };
          mpName = typeof parsed.name === 'string' ? parsed.name : undefined;
          if (Array.isArray(parsed.plugins)) {
            for (const p of parsed.plugins) {
              if (typeof p?.name === 'string') names.push(p.name);
            }
          }
        }
      } catch {
        /* ignore — empty pluginNames is fine */
      }
      return { mode: 'marketplace', marketplaceName: mpName, pluginNames: names };
    }
    return { mode: 'no-plugin' };
  }

  if (pluginRoots.length > 1) {
    // Parse each candidate's manifest eagerly. The inspect endpoint hands
    // this straight back to the renderer; a single bad manifest in a
    // 13-plugin marketplace shouldn't blow up the whole picker.
    const sorted = pluginRoots.sort();
    const candidates: MultiPluginCandidate[] = sorted.map(rootPath => {
      const manifestKey = rootPath === '' ? MANIFEST_REL : `${rootPath}/${MANIFEST_REL}`;
      const buf = tree.files.get(manifestKey);
      if (!buf) {
        return { rootPath, manifestError: 'plugin.json 缺失' };
      }
      try {
        return { rootPath, manifest: parsePluginManifest(buf.toString('utf-8')) };
      } catch (err) {
        return {
          rootPath,
          manifestError: err instanceof Error ? err.message : 'manifest 解析失败',
        };
      }
    });
    return { mode: 'multi-plugin', candidates };
  }

  // Single plugin — read & validate manifest
  const rootPath = pluginRoots[0];
  const manifestKey = rootPath === '' ? MANIFEST_REL : `${rootPath}/${MANIFEST_REL}`;
  const buf = tree.files.get(manifestKey);
  if (!buf) {
    return { mode: 'no-plugin' };
  }
  const manifest = parsePluginManifest(buf.toString('utf-8'));
  return { mode: 'plugin', manifest, rootPath };
}

/**
 * Materialize the plugin subtree under `installPath`.
 *
 * Pre-conditions:
 *   - `installPath` does NOT exist (caller checks)
 *   - tree has been validated via analysePluginTree → mode: 'plugin'
 *
 * The write uses the local writeSkillFiles helper which enforces zip-slip
 * (resolved paths must remain inside installPath).
 */
export function writePluginToDisk(
  installPath: string,
  tree: ExtractedTree,
  rootPath: string,
): void {
  const prefix = rootPath === '' ? '' : rootPath.replace(/\/+$/, '') + '/';
  const filtered = new Map<string, Buffer>();
  for (const [path, buf] of tree.files) {
    if (prefix === '') {
      filtered.set(path, buf);
    } else if (path.startsWith(prefix)) {
      const rel = path.slice(prefix.length);
      if (rel) filtered.set(rel, buf);
    }
  }
  if (filtered.size === 0) {
    throw new PluginInstallError('过滤后插件子树为空', 'EMPTY_TREE', 422);
  }
  // Parent must exist; installPath must not (handled by caller)
  ensureDirSync(dirname(installPath));
  writeSkillFiles(installPath, filtered);
}

/**
 * Remove an installation directory atomically.
 *
 * Defends against the v0.2.5 broken-symlink failure: a dangling symlink at
 * `target` would make Node's cpSync abort the sidecar via C++ exception.
 * We lstat first, unlink any symlink leaf (broken or otherwise), then
 * rmSync the directory.
 */
export function removeInstallPath(target: string): void {
  if (!existsSync(target)) {
    // existsSync follows symlinks, so this may still be a broken link.
    if (isBrokenSymlink(target)) {
      try { unlinkSync(target); } catch { /* best-effort */ }
    }
    return;
  }
  let lst;
  try {
    lst = lstatSync(target);
  } catch {
    return;
  }
  if (lst.isSymbolicLink()) {
    try { unlinkSync(target); } catch (err) {
      throw new PluginInstallError(
        `无法删除 symlink：${target} (${(err as Error).message})`,
        'REMOVE_FAILED', 500,
      );
    }
    return;
  }
  if (lst.isDirectory()) {
    rmSync(target, { recursive: true, force: true });
    return;
  }
  // Regular file at the path — shouldn't happen but be safe
  try { unlinkSync(target); } catch { /* ignore */ }
}

/**
 * Pre-flight: if the install path is a broken symlink, clear it so the write
 * step doesn't crash via Node v24's cpSync C++ exception path.
 */
export function clearBrokenSymlinkAt(target: string): void {
  if (isBrokenSymlink(target)) {
    try { unlinkSync(target); } catch { /* best-effort */ }
  }
}

/** Compose the install path for a plugin name. Caller passes the plugins root. */
export function makeInstallPath(pluginsRoot: string, pluginName: string): string {
  return join(pluginsRoot, pluginName);
}

/**
 * Write an in-memory tree to disk with zip-slip protection.
 * (Moved from the removed skills/installer.ts — one audited write path.)
 */
export function writeSkillFiles(skillDir: string, files: Map<string, Buffer>): void {
  ensureDirSync(skillDir);
  for (const [rel, data] of files) {
    const fullPath = resolve(join(skillDir, rel));
    // Zip-slip: resolved path MUST stay within skillDir
    if (!fullPath.startsWith(skillDir + sep) && fullPath !== skillDir) {
      console.warn(`[writeSkillFiles] Blocked zip-slip path: ${rel}`);
      continue;
    }
    const dir = dirname(fullPath);
    ensureDirSync(dir);
    writeFileSync(fullPath, data);
  }
}
