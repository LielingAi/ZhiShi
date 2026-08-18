import { describe, it, expect } from 'vitest';
import { normalizeWorkspacePathIdentity, workspacePathsEqual } from './workspacePath';

describe('normalizeWorkspacePathIdentity', () => {
  // Mirrors the Rust `normalize_path_*` tests in src-tauri/src/cron_task.rs so
  // the renderer identity stays byte-for-byte aligned with the Rust grouping.
  it('converts Windows separators and lowercases the drive identity', () => {
    expect(normalizeWorkspacePathIdentity('C:\\Users\\me\\project\\')).toBe(
      'c:/users/me/project',
    );
    expect(normalizeWorkspacePathIdentity('C:/Users/me/project')).toBe(
      'c:/users/me/project',
    );
    expect(normalizeWorkspacePathIdentity('\\\\Server\\Share\\Project\\')).toBe(
      '//server/share/project',
    );
  });

  it('preserves roots when trimming trailing slashes', () => {
    expect(normalizeWorkspacePathIdentity('/Users/me/project/')).toBe('/Users/me/project');
    expect(normalizeWorkspacePathIdentity('/')).toBe('/');
    expect(normalizeWorkspacePathIdentity('C:\\')).toBe('c:/');
  });

  it('keeps POSIX paths case-sensitive and treats backslashes as literal', () => {
    // POSIX backslash is a valid filename char — must NOT collapse to a slash.
    expect(normalizeWorkspacePathIdentity('/tmp/a\\b')).not.toBe(
      normalizeWorkspacePathIdentity('/tmp/a/b'),
    );
    expect(normalizeWorkspacePathIdentity('/tmp/a\\b/')).toBe('/tmp/a\\b');
    expect(normalizeWorkspacePathIdentity('/Users/Me')).not.toBe(
      normalizeWorkspacePathIdentity('/users/me'),
    );
  });

  it('returns empty string unchanged', () => {
    expect(normalizeWorkspacePathIdentity('')).toBe('');
  });
});

describe('workspacePathsEqual', () => {
  // The exact #320 regression: projects.json stores backslashes, cron_tasks.json
  // stores forward slashes. Exact `===` returned false → "找不到工作区".
  it('treats Windows backslash and forward-slash forms as the same workspace (#320)', () => {
    expect(
      workspacePathsEqual(
        'C:\\Users\\Administrator\\.zhishi\\projects\\novo',
        'C:/Users/Administrator/.zhishi/projects/novo',
      ),
    ).toBe(true);
  });

  it('matches across trailing-slash and drive-case differences on Windows', () => {
    expect(workspacePathsEqual('C:\\Users\\me\\proj\\', 'c:/users/me/proj')).toBe(true);
  });

  it('does not match genuinely different workspaces', () => {
    expect(
      workspacePathsEqual('C:\\Users\\me\\projA', 'C:/Users/me/projB'),
    ).toBe(false);
  });

  it('keeps distinct POSIX workspaces distinct (case-sensitive)', () => {
    expect(workspacePathsEqual('/home/me/Proj', '/home/me/proj')).toBe(false);
    expect(workspacePathsEqual('/home/me/proj/', '/home/me/proj')).toBe(true);
  });

  it('treats a nullish side as not-equal to a real path (mirrors raw ===)', () => {
    expect(workspacePathsEqual(undefined, 'C:/Users/me/proj')).toBe(false);
    expect(workspacePathsEqual('C:/Users/me/proj', null)).toBe(false);
    expect(workspacePathsEqual(undefined, undefined)).toBe(true);
  });
});
