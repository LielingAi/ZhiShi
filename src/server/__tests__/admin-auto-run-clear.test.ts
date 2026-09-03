/**
 * 1.6.3 #4 — auto-run/clear 记录清理端点的接线测试。
 *
 * 记录落盘照 admin 测试惯例走临时 HOME（~/.zhishi/auto-runs/<id>.json）；
 * 内存注册表/愈合缓存走 resetAutoRunRegistryForTest 复位，绝不真起 runner。
 *
 * 覆盖：
 *  - id 指定删单条：终态（completed/stopped）连盘删除（连带 .lock）；
 *  - 活跃（running/paused/awaiting-verdict）记录拒绝删除，4xx 可读错误，
 *    落盘文件不动；
 *  - id 不存在 → 可读错误；
 *  - 缺省全清终态：活跃记录保留，removed 回包只含终态 id；
 *  - workspace 过滤：只清指定工作区的终态记录（口径照 auto-run/list）；
 *  - 本工作区 zombie running 先经重启愈合成 stopped 再被清（1.4.6 愈合语义
 *    与清理的组合——别的工作区的 running 不愈合、拒绝删）。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleAutoRunClear } from '../admin-api';
import {
  autoRunFilePath,
  defaultAutoRunsDir,
  resetAutoRunRegistryForTest,
  saveAutoRunRecord,
  type AutoRunRecord,
  type AutoRunStatus,
} from '../loop/auto-run';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

function record(id: string, status: AutoRunStatus, workspace?: string): AutoRunRecord {
  return {
    id,
    name: `task-${id}`,
    envKey: 'env-1',
    goal: 'goal',
    budget: { kind: 'turns', limit: 10, spent: 0 },
    criteria: ['c1'],
    status,
    loopSessionId: `loop-${id}`,
    createdAt: '2026-08-25T00:00:00Z',
    updatedAt: '2026-08-25T00:00:00Z',
    ...(workspace ? { workspace } : {}),
  };
}

async function seed(...records: AutoRunRecord[]): Promise<void> {
  for (const r of records) await saveAutoRunRecord(r, { logWarn: () => {} });
}

function fileOf(id: string): string {
  return autoRunFilePath(id, defaultAutoRunsDir());
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-autorun-clear-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
  resetAutoRunRegistryForTest();
});

afterEach(() => {
  resetAutoRunRegistryForTest();
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

describe('handleAutoRunClear — id 指定删单条', () => {
  it('终态 completed → 连盘删除（连带 .lock），回包 removed 含该 id', async () => {
    await seed(record('run-a', 'completed'));
    expect(existsSync(fileOf('run-a'))).toBe(true);
    const r = await handleAutoRunClear({ id: 'run-a' });
    expect(r.success).toBe(true);
    expect((r.data as { removed: string[] }).removed).toEqual(['run-a']);
    expect(existsSync(fileOf('run-a'))).toBe(false);
    expect(existsSync(`${fileOf('run-a')}.lock`)).toBe(false);
  });

  it('终态 stopped → 删除成功', async () => {
    await seed(record('run-b', 'stopped'));
    const r = await handleAutoRunClear({ id: 'run-b' });
    expect(r.success).toBe(true);
    expect(existsSync(fileOf('run-b'))).toBe(false);
  });

  it.each(['running', 'paused', 'awaiting-verdict'] as const)(
    '活跃态 %s → 拒绝（可读错误带状态与终止引导），落盘文件不动',
    async (status) => {
      // 记录 workspace 与引擎工作区（process.cwd()）不同 → 不触发本工作区
      // 重启愈合，盘上 running/paused 保持原态（别的 sidecar 的活 run 语义）。
      await seed(record('run-live', status, '/ws/other-place'));
      const r = await handleAutoRunClear({ id: 'run-live' });
      expect(r.success).toBe(false);
      expect(r.error).toContain(status);
      expect(r.error).toContain('auto-run/stop');
      expect(existsSync(fileOf('run-live'))).toBe(true);
    },
  );

  it('id 不存在 → 可读错误', async () => {
    await seed(record('run-a', 'completed'));
    const r = await handleAutoRunClear({ id: 'run-ghost' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('run-ghost');
    expect(r.error).toContain('不存在');
    expect(existsSync(fileOf('run-a'))).toBe(true); // 不误删别的记录
  });
});

describe('handleAutoRunClear — 缺省全清终态', () => {
  it('终态全清、活跃保留；removed 只含终态 id', async () => {
    await seed(
      record('run-done', 'completed'),
      record('run-stopped', 'stopped'),
      record('run-wait', 'awaiting-verdict', '/ws/other-place'),
      record('run-live', 'running', '/ws/other-place'),
    );
    const r = await handleAutoRunClear({});
    expect(r.success).toBe(true);
    expect((r.data as { removed: string[] }).removed.sort()).toEqual(['run-done', 'run-stopped']);
    expect(existsSync(fileOf('run-done'))).toBe(false);
    expect(existsSync(fileOf('run-stopped'))).toBe(false);
    expect(existsSync(fileOf('run-wait'))).toBe(true);
    expect(existsSync(fileOf('run-live'))).toBe(true);
  });

  it('workspace 过滤：只清指定工作区的终态记录（无 workspace 归属的旧记录口径照 list——纳入）', async () => {
    await seed(
      record('run-a1', 'completed', '/ws/a'),
      record('run-b1', 'completed', '/ws/b'),
      record('run-legacy', 'stopped'), // 无 workspace 字段的旧记录
    );
    const r = await handleAutoRunClear({ workspace: '/ws/a' });
    expect(r.success).toBe(true);
    expect((r.data as { removed: string[] }).removed.sort()).toEqual(['run-a1', 'run-legacy']);
    expect(existsSync(fileOf('run-b1'))).toBe(true);
  });

  it('本工作区 zombie running 先愈合成 stopped 再被清（1.4.6 愈合 × 清理组合）', async () => {
    // 记录的 workspace = 清理请求的 workspace → listAutoRuns 的本工作区重启
    // 愈合并把它标 stopped（sidecar 已死，runner 不在内存），随后按终态清掉。
    await seed(record('run-zombie', 'running', '/ws/mine'));
    const r = await handleAutoRunClear({ workspace: '/ws/mine' });
    expect(r.success).toBe(true);
    expect((r.data as { removed: string[] }).removed).toEqual(['run-zombie']);
    expect(existsSync(fileOf('run-zombie'))).toBe(false);
  });
});
