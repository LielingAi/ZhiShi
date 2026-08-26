/**
 * 1.3.10 #6 — handleMemorySearch 的 payload.q 类型守卫接线测试。
 *
 * 修复前：非字符串 q（number/object）会一路传进 searchEntries 的
 * query.trim() 抛 TypeError（500）。修复后与 handleExpertSearch 同口径：
 * typeof 守卫 + 可读报错，空/空白 q 同样拒绝。
 *
 * 配置注入照 admin 测试惯例（临时 HOME）：q 非法时在开库之前就返回，
 * 不碰真库；合法 q 的 success 路径在临时 HOME 的空 memory.db 上跑。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleMemorySearch } from '../admin-api';
import { resetMemoryStoreForTest } from '../memory/store';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-mem-search-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
});

afterEach(() => {
  // memory.db 的连接缓存持有 WAL 锁——先关句柄再清临时目录（Windows EBUSY）。
  resetMemoryStoreForTest();
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

describe('handleMemorySearch — 1.3.10 #6 q 类型守卫', () => {
  it('非字符串 q（number）→ 可读报错，不抛 TypeError', async () => {
    const r = await handleMemorySearch({ q: 123 as unknown as string });
    expect(r.success).toBe(false);
    expect(r.error).toContain('usage: memory/search');
  });

  it('空 / 空白 q → 可读报错', async () => {
    const r1 = await handleMemorySearch({ q: '' });
    expect(r1.success).toBe(false);
    expect(r1.error).toContain('usage: memory/search');
    const r2 = await handleMemorySearch({ q: '   ' });
    expect(r2.success).toBe(false);
    expect(r2.error).toContain('usage: memory/search');
  });

  it('合法 q（空库）→ success + 空结果，语义不回归', async () => {
    const r = await handleMemorySearch({ q: 'fuzz' });
    expect(r.success).toBe(true);
    expect((r.data as { results: unknown[] }).results).toEqual([]);
  });
});
