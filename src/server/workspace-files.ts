/**
 * 1.3.3 — 工作区文件树只读列表(@ 补全的文件数据源)。
 *
 * GUI 的 @ 补全需要工作区文件作为数据源之一;侧car 的文件 IO 端点早已
 * 整体下线(v0.2.7 Phase E),这里补一个**最小只读**端点:列目录树,
 * 深度/条目护栏防炸,不提供读内容/写能力。
 *
 * 安全纪律:
 * - 只读:readdirSync(withFileTypes) + lstat,零写操作;
 * - 不跟随 symlink:断链 symlink 与 symlink 目录都不深入(对齐 CLAUDE.md
 *   的 symlink 红线——读侧永远不穿过链接);
 * - 深度/条目上限:默认 depth 3 / 1000 条,超限截断并标记 truncated;
 * - 路径锚定:本模块只负责「给定 root 内的相对遍历」;root 的合法性
 *   (agentDir 校验)由调用方(index.ts 的 isValidAgentDir)把关。
 */

import { lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export type WorkspaceFileType = 'file' | 'dir' | 'symlink';

export interface WorkspaceFileEntry {
  /** 相对 root 的路径(POSIX 风格正斜杠,跨平台稳定)。 */
  path: string;
  type: WorkspaceFileType;
}

export interface ListWorkspaceFilesOptions {
  /** 递归深度(0 = 只列起始目录一层)。默认 3。 */
  maxDepth?: number;
  /** 条目总数上限(防大目录炸 payload)。默认 1000。 */
  maxEntries?: number;
  /** 相对 root 的起始子目录('' = root 本身)。 */
  subdir?: string;
  /** 忽略的目录名(不进入)。默认常规产物/依赖目录。 */
  ignoreDirs?: readonly string[];
}

export interface ListWorkspaceFilesResult {
  files: WorkspaceFileEntry[];
  /** true = 因 maxEntries 截断(尾部条目未包含)。 */
  truncated: boolean;
}

export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_MAX_ENTRIES = 1000;
export const MAX_DEPTH = 6;
export const DEFAULT_IGNORE_DIRS: readonly string[] = [
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build', '.next', '.cache',
];

/** `relative(root, resolve(root, subdir))` 越界判定:.. 前缀(相对逃逸)或
 *  绝对路径(win32 跨盘)都算越界。纯词法层——root 合法性由调用方把关。 */
export function isSubdirInside(root: string, subdir: string): boolean {
  const rel = relative(resolve(root), resolve(root, subdir));
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * 遍历 root 下的文件树(纯只读)。root 必须存在且是目录,否则返回空列表
 * (端点层转 404/错误);subdir 越界/不存在 → ok:false。
 */
export function listWorkspaceFiles(
  root: string,
  options: ListWorkspaceFilesOptions = {},
): ({ ok: true } & ListWorkspaceFilesResult) | { ok: false; error: string } {
  const maxDepth = Math.min(Math.max(options.maxDepth ?? DEFAULT_MAX_DEPTH, 0), MAX_DEPTH);
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const subdir = options.subdir ?? '';

  const rootResolved = resolve(root);
  if (!isSubdirInside(rootResolved, subdir)) {
    return { ok: false, error: 'dir 越界(.. 逃逸)' };
  }

  const startDir = resolve(rootResolved, subdir);
  try {
    if (!lstatSync(startDir).isDirectory()) {
      return { ok: false, error: `目录不存在:${subdir || '.'}` };
    }
  } catch {
    return { ok: false, error: `目录不存在:${subdir || '.'}` };
  }

  const files: WorkspaceFileEntry[] = [];
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 无权限/已消失——单目录容错,不炸整体。
    }
    // 排序保证跨平台确定性输出。
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      const full = join(dir, entry.name);
      const relPath = relative(rootResolved, full).split(sep).join('/');
      let type: WorkspaceFileType;
      if (entry.isSymbolicLink()) {
        type = 'symlink'; // 不跟随(读侧红线)。
      } else if (entry.isDirectory()) {
        type = 'dir';
      } else {
        type = 'file';
      }
      // 忽略目录整体跳过:不列、不进(@ 补全数据源的噪声目录)。
      if (type === 'dir' && ignoreDirs.includes(entry.name)) continue;
      files.push({ path: relPath, type });
      if (files.length >= maxEntries) {
        truncated = true;
        return;
      }
      if (type === 'dir' && depth < maxDepth) {
        walk(full, depth + 1);
      }
    }
  };

  walk(startDir, 0);
  return { ok: true, files, truncated };
}
