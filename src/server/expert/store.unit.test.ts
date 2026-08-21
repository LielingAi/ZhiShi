/**
 * expert/store.ts 单测（1.2.1 骨架期）——临时库注入，覆盖：
 * 建库幂等、entries CRUD、builtin 删拒、drafts 增删查、meta。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteDraft,
  deleteEntry,
  getDraftById,
  getEntryById,
  getExpertMeta,
  hasExpertDb,
  insertDraft,
  insertEntry,
  listDrafts,
  listEntries,
  openExpertStore,
  resetExpertStoreForTest,
  setExpertMeta,
  updateEntry,
} from './store';
import { computeContentHash, validateEntry, type ValidatedExpertEntry } from './validate';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-expertstore-'));
  resetExpertStoreForTest();
});

afterEach(() => {
  resetExpertStoreForTest();
  rmSync(dir, { recursive: true, force: true });
});

function entry(overrides: Record<string, unknown> = {}): ValidatedExpertEntry {
  const r = validateEntry({
    domain: 'binary',
    kind: 'technique',
    title: '栈溢出 triage',
    applicability: '拿到崩溃现场',
    content: '正文',
    criteria: '判据',
    provenance: 'user',
    reviewer: 'alice',
    ...overrides,
  });
  if (!r.ok) throw new Error(r.errors.join());
  return r.value;
}

function seedEntry(overrides: Record<string, unknown> = {}) {
  const db = openExpertStore(dir);
  const v = entry(overrides);
  return insertEntry(db, v, computeContentHash(v));
}

describe('openExpertStore', () => {
  it('建库幂等：重复打开无副作用，hasExpertDb 反映文件存在', () => {
    expect(hasExpertDb(dir)).toBe(false);
    const db1 = openExpertStore(dir);
    const db2 = openExpertStore(dir);
    expect(db1).toBe(db2); // 连接缓存
    expect(hasExpertDb(dir)).toBe(true);
  });
});

describe('entries CRUD', () => {
  it('插入 → 按 id 取回全字段', () => {
    const e = seedEntry({ tags: 'pwn,栈' });
    const got = getEntryById(openExpertStore(dir), e.id);
    expect(got).not.toBeNull();
    expect(got!.title).toBe('栈溢出 triage');
    expect(got!.tags).toBe('pwn,栈');
    expect(got!.enabled).toBe(true);
    expect(got!.provenance).toBe('user');
    expect(got!.reviewer).toBe('alice');
    expect(got!.createdAt).toBe(got!.updatedAt);
    expect(got!.contentHash).toHaveLength(64);
  });

  it('getEntryById 未命中 → null', () => {
    expect(getEntryById(openExpertStore(dir), 999)).toBeNull();
  });

  it('updateEntry：可变字段更新 + contentHash 重算 + provenance 不可变；不存在 → null', () => {
    const e = seedEntry();
    const db = openExpertStore(dir);
    const updated = updateEntry(db, e.id, {
      title: '新标题',
      contentHash: computeContentHash(entry({ title: '新标题' })),
      enabled: false,
    }, e.updatedAt + 1000);
    expect(updated!.title).toBe('新标题');
    expect(updated!.enabled).toBe(false);
    expect(updated!.provenance).toBe('user'); // patch 无 provenance 字段（类型层不可变）
    expect(updated!.updatedAt).toBe(e.updatedAt + 1000);
    expect(updated!.createdAt).toBe(e.createdAt);
    expect(updateEntry(db, 999, { title: 'x' })).toBeNull();
  });

  it('listEntries：domain/kind/provenance 过滤', () => {
    seedEntry({ title: 'A' });
    seedEntry({ title: 'B', domain: 'pentest' });
    seedEntry({ title: 'C', provenance: 'builtin', reviewer: undefined, kind: 'sop' });
    const db = openExpertStore(dir);
    expect(listEntries(db)).toHaveLength(3);
    expect(listEntries(db, { domain: 'pentest' })).toHaveLength(1);
    expect(listEntries(db, { kind: 'sop' })).toHaveLength(1);
    expect(listEntries(db, { provenance: 'builtin' })).toHaveLength(1);
    expect(listEntries(db, { provenance: 'user' })).toHaveLength(2);
  });

  it('deleteEntry：user/promoted 可删；builtin 拒绝删；不存在报错', () => {
    const db = openExpertStore(dir);
    const user = seedEntry({ title: 'U' });
    const builtin = seedEntry({ title: 'B', provenance: 'builtin', reviewer: undefined });
    deleteEntry(db, user.id);
    expect(getEntryById(db, user.id)).toBeNull();
    expect(() => deleteEntry(db, builtin.id)).toThrow(/随包分发/);
    expect(getEntryById(db, builtin.id)).not.toBeNull(); // 拒绝后仍在
    expect(() => deleteEntry(db, 999)).toThrow(/不存在/);
  });
});

describe('drafts', () => {
  it('insertDraft → listDrafts/getDraftById → deleteDraft 流转', () => {
    const db = openExpertStore(dir);
    const v = entry();
    const d = insertDraft(db, v, computeContentHash(v), 'agent');
    expect(d.createdVia).toBe('agent');
    expect(listDrafts(db)).toHaveLength(1);
    expect(getDraftById(db, d.id)!.title).toBe('栈溢出 triage');
    expect(deleteDraft(db, d.id)).toBe(true);
    expect(deleteDraft(db, d.id)).toBe(false); // 已删
    expect(listDrafts(db)).toHaveLength(0);
    // drafts 与 entries 互不串表
    expect(listEntries(db)).toHaveLength(0);
  });
});

describe('meta', () => {
  it('set/get 幂等覆盖', () => {
    const db = openExpertStore(dir);
    expect(getExpertMeta(db, 'k')).toBeNull();
    setExpertMeta(db, 'k', 'v1');
    setExpertMeta(db, 'k', 'v2');
    expect(getExpertMeta(db, 'k')).toBe('v2');
  });
});
