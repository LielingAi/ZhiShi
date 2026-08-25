/**
 * 1.3.3 — workspace-files（@ 补全文件数据源）unit tests.
 *
 * 纯只读遍历:临时目录 fixture,断言树形/深度护栏/条目截断/symlink 不
 * 跟随/subdir 越界拒绝。绝不访问真实工作区。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isSubdirInside, listWorkspaceFiles } from './workspace-files';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-files-test-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'src', 'nested'));
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'a.txt'), 'a');
  writeFileSync(join(root, 'src', 'b.ts'), 'b');
  writeFileSync(join(root, 'src', 'nested', 'c.ts'), 'c');
  writeFileSync(join(root, 'node_modules', 'dep.js'), 'd');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('listWorkspaceFiles', () => {
  it('树形遍历:文件/目录分类、相对路径 POSIX 正斜杠、ignoreDirs 默认排除 node_modules', () => {
    const r = listWorkspaceFiles(root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byPath = new Map(r.files.map((f) => [f.path, f.type]));
    expect(byPath.get('a.txt')).toBe('file');
    expect(byPath.get('src')).toBe('dir');
    expect(byPath.get('src/b.ts')).toBe('file');
    expect(byPath.get('src/nested/c.ts')).toBe('file');
    expect([...byPath.keys()].some((p) => p.startsWith('node_modules'))).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it('深度护栏:depth=0 只列起始目录一层;maxDepth 超上限被钳制', () => {
    const shallow = listWorkspaceFiles(root, { maxDepth: 0 });
    expect(shallow.ok).toBe(true);
    if (shallow.ok) {
      expect(shallow.files.map((f) => f.path)).toContain('src');
      expect(shallow.files.some((f) => f.path.includes('/'))).toBe(false);
    }
    // MAX_DEPTH=6 钳制:传 999 不会无限深
    const clamped = listWorkspaceFiles(root, { maxDepth: 999 });
    expect(clamped.ok).toBe(true);
  });

  it('条目上限:maxEntries 截断并标记 truncated', () => {
    const r = listWorkspaceFiles(root, { maxEntries: 3, maxDepth: 5, ignoreDirs: [] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.files).toHaveLength(3);
      expect(r.truncated).toBe(true);
    }
  });

  it('subdir:从子目录起算(path 仍相对 root,跨 dir 参数一致);越界(.. 逃逸)拒绝;不存在拒绝', () => {
    const sub = listWorkspaceFiles(root, { subdir: 'src' });
    expect(sub.ok).toBe(true);
    if (sub.ok) {
      expect(sub.files.map((f) => f.path)).toContain('src/b.ts');
      expect(sub.files.some((f) => f.path === 'a.txt')).toBe(false);
    }
    expect(listWorkspaceFiles(root, { subdir: '../outside' }).ok).toBe(false);
    expect(listWorkspaceFiles(root, { subdir: 'ghost' }).ok).toBe(false);
  });

  it('root 不存在 → ok:false(空目录的容错语义)', () => {
    const r = listWorkspaceFiles(join(root, 'ghost-root'));
    expect(r.ok).toBe(false);
  });

  it('symlink:标记 symlink 且不深入(不跟随链接)', () => {
    // Windows 建符号链接需要特权/开发者模式——建不起来就跳过断言。
    try {
      symlinkSync(join(root, 'src'), join(root, 'link-to-src'), 'dir');
      symlinkSync(join(root, 'a.txt'), join(root, 'link.txt'), 'file');
    } catch {
      return; // 环境不支持 symlink,跳过
    }
    const r = listWorkspaceFiles(root, { maxDepth: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byPath = new Map(r.files.map((f) => [f.path, f.type]));
    expect(byPath.get('link-to-src')).toBe('symlink');
    expect(byPath.get('link.txt')).toBe('symlink');
    // symlink 目录未深入:其内容不出现在列表里
    expect(r.files.some((f) => f.path.startsWith('link-to-src/'))).toBe(false);
  });

  it('ignoreDirs 可覆盖(传入空名单即不过滤)', () => {
    const r = listWorkspaceFiles(root, { ignoreDirs: [] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.files.some((f) => f.path.startsWith('node_modules/'))).toBe(true);
    }
  });
});

describe('isSubdirInside', () => {
  it('自身/子目录在界内;.. 逃逸/绝对越界在界外', () => {
    expect(isSubdirInside(root, '')).toBe(true);
    expect(isSubdirInside(root, 'src')).toBe(true);
    expect(isSubdirInside(root, 'src/nested')).toBe(true);
    expect(isSubdirInside(root, '../outside')).toBe(false);
    expect(isSubdirInside(root, '..')).toBe(false);
    expect(isSubdirInside(root, './src')).toBe(true);
  });
});
