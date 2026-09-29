/**
 * 1.8.7 P3b 双线制——线归属元数据 store（line-ownership.json）。
 *
 * 覆盖：parse 容错（坏 JSON/坏行）、ensureLineOwner 只补登不覆盖、
 * setLineShared 的 share/unshare（unshare 改归属）、round-trip 落盘。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureLineOwner,
  getLineOwnership,
  loadLineOwnershipStore,
  parseLineOwnershipStore,
  serializeLineOwnershipStore,
  setLineShared,
  upsertLineOwnershipInStore,
  emptyLineOwnershipStore,
} from './line-ownership';

describe('line-ownership parse/serialize', () => {
  it('坏 JSON / 顶层形状错 → 空店;单行坏 → 丢该行', () => {
    expect(parseLineOwnershipStore('not json').lines).toEqual({});
    expect(parseLineOwnershipStore('{"version":2,"lines":{}}').lines).toEqual({});
    const store = parseLineOwnershipStore(JSON.stringify({
      version: 1,
      lines: {
        'ls-1': { owner: 'alice', shared: false, updatedAt: 'u1' },
        'ls-2': 'garbage',
        'ls-3': { shared: true, updatedAt: 'u3' },
      },
    }));
    expect(store.lines['ls-1']).toEqual({ owner: 'alice', updatedAt: 'u1' });
    expect(store.lines['ls-2']).toBeUndefined();
    expect(store.lines['ls-3']).toEqual({ shared: true, updatedAt: 'u3' });
  });

  it('round-trip:serialize → parse 逐字段还原(shared 只持久化 true)', () => {
    const store = emptyLineOwnershipStore();
    const next = upsertLineOwnershipInStore(store, 'ls-1', { owner: 'alice', shared: true }, 't');
    const parsed = parseLineOwnershipStore(serializeLineOwnershipStore(next));
    expect(parsed.lines['ls-1']).toEqual({ owner: 'alice', shared: true, updatedAt: 't' });
    // shared:false 存为缺省(absent = 私有,与 favorite 同口径)
    const priv = upsertLineOwnershipInStore(store, 'ls-2', { owner: 'bob', shared: false }, 't');
    expect(serializeLineOwnershipStore(priv)).not.toContain('"shared"');
    expect(parseLineOwnershipStore(serializeLineOwnershipStore(priv)).lines['ls-2']).toEqual({ owner: 'bob', updatedAt: 't' });
  });
});

describe('line-ownership IO(临时目录)', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zhishi-line-own-'));
    path = join(dir, 'line-ownership.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('ensureLineOwner:首次补登;已有归属不覆盖', async () => {
    await ensureLineOwner('ls-1', 'alice', path);
    expect(getLineOwnership('ls-1', path)).toMatchObject({ owner: 'alice' });
    await ensureLineOwner('ls-1', 'bob', path); // 不覆盖
    expect(getLineOwnership('ls-1', path)?.owner).toBe('alice');
  });

  it('setLineShared:share 保留 owner;unshare 改归属为调用方(shared 落缺省)', async () => {
    await ensureLineOwner('ls-1', 'alice', path);
    await setLineShared('ls-1', true, undefined, path);
    expect(getLineOwnership('ls-1', path)).toMatchObject({ owner: 'alice', shared: true });
    await setLineShared('ls-1', false, 'carol', path);
    const after = getLineOwnership('ls-1', path);
    expect(after?.owner).toBe('carol');
    expect(after?.shared).toBeUndefined(); // false 存为缺省 = 私有
  });

  it('无记录 → undefined(归属未知旧线的判定源);文件缺失 → 空店', () => {
    expect(getLineOwnership('ls-never', path)).toBeUndefined();
    expect(loadLineOwnershipStore(path).lines).toEqual({});
  });

  it('落盘文本可读(tmp+rename 后的最终内容)', async () => {
    await ensureLineOwner('ls-1', 'alice', path);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { version: number; lines: Record<string, unknown> };
    expect(raw.version).toBe(1);
    expect(raw.lines['ls-1']).toBeDefined();
  });

  it('并发写不丢更新(withFileLock 串行化)', async () => {
    writeFileSync(path, serializeLineOwnershipStore(emptyLineOwnershipStore()), 'utf-8');
    await Promise.all([
      ensureLineOwner('ls-a', 'alice', path),
      ensureLineOwner('ls-b', 'bob', path),
      ensureLineOwner('ls-c', 'carol', path),
    ]);
    const store = loadLineOwnershipStore(path);
    expect(Object.keys(store.lines).sort()).toEqual(['ls-a', 'ls-b', 'ls-c']);
  });
});
