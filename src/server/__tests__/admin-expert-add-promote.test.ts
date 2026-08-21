/**
 * expert/add 的 promote 变体测试（1.2.1 骨架期）——CLI `zhishi expert promote`
 * 编辑器审定后的落库通道。临时库经 deps.baseDir 注入（同 admin-expert.test.ts）。
 *
 * 覆盖：promoted 正常链路（provenance/sourceEventId 落库）、sourceEventId
 * 缺失/不存在拒、非法 provenance（builtin/api 直输）拒、promoted 缺 reviewer 拒
 * （validateEntry 单点）、显式 user 与缺省行为不变（sourceEventId 不尾随）。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleExpertAdd, handleExpertShow } from '../admin-api';
import { resetExpertStoreForTest } from '../expert/store';
import { recordResearchEvent, resetMemoryStoreForTest } from '../memory/store';

let dir: string;
const deps = () => ({ baseDir: dir, memoryBaseDir: dir });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-expertpromote-'));
  resetExpertStoreForTest();
  resetMemoryStoreForTest();
});

afterEach(() => {
  resetExpertStoreForTest();
  resetMemoryStoreForTest();
  rmSync(dir, { recursive: true, force: true });
});

const VALID = {
  domain: 'binary',
  kind: 'technique',
  title: 'fastbin dup 拿 flag',
  applicability: 'glibc tcache 无 double-free 检测版本',
  content: '正文',
  criteria: '判据',
  reviewer: 'alice',
};

function addEvent() {
  return recordResearchEvent({
    workspace: 'ws',
    taskKind: 'binary',
    outcome: 'success',
    summary: 'hacknote fastbin dup 拿 flag',
  }, dir);
}

describe('expert/add promote 变体', () => {
  it('provenance=promoted + 有效 sourceEventId → 落库（provenance/sourceEventId 正确）', async () => {
    const event = addEvent();
    const r = await handleExpertAdd({ ...VALID, provenance: 'promoted', sourceEventId: event.id }, deps());
    expect(r.success).toBe(true);
    const entry = (r.data as { entry: Record<string, unknown> }).entry;
    expect(entry.provenance).toBe('promoted');
    expect(entry.sourceEventId).toBe(event.id);
    expect(entry.reviewer).toBe('alice');
  });

  it('promoted 缺 sourceEventId / 事件不存在 → 拒', async () => {
    const missing = await handleExpertAdd({ ...VALID, provenance: 'promoted' }, deps());
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('sourceEventId 必填');

    const ghost = await handleExpertAdd({ ...VALID, provenance: 'promoted', sourceEventId: 4242 }, deps());
    expect(ghost.success).toBe(false);
    expect(ghost.error).toContain('不存在');
  });

  it('promoted 缺 reviewer → 拒（validateEntry 单点：人审是权威性来源）', async () => {
    const event = addEvent();
    const r = await handleExpertAdd(
      { ...VALID, reviewer: undefined, provenance: 'promoted', sourceEventId: event.id },
      deps(),
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain('reviewer 必填');
  });

  it('非法 provenance（builtin / 其他）→ 拒；显式 user 与缺省一致且 sourceEventId 不尾随', async () => {
    const builtin = await handleExpertAdd({ ...VALID, provenance: 'builtin' }, deps());
    expect(builtin.success).toBe(false);
    expect(builtin.error).toContain('非法 provenance');

    const weird = await handleExpertAdd({ ...VALID, provenance: 'auto' }, deps());
    expect(weird.success).toBe(false);

    // 显式 user 正常；user 通道即使带了 sourceEventId 也不落（通道语义：user 无来源事件）
    const event = addEvent();
    const user = await handleExpertAdd({ ...VALID, provenance: 'user', sourceEventId: event.id }, deps());
    expect(user.success).toBe(true);
    const entry = (user.data as { entry: Record<string, unknown> }).entry;
    expect(entry.provenance).toBe('user');
    expect(entry.sourceEventId).toBeNull();

    const show = await handleExpertShow({ id: entry.id as number }, deps());
    expect(((show.data as { entry: Record<string, unknown> }).entry).sourceEventId).toBeNull();
  });
});
