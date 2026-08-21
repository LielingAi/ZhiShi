/**
 * 安全研究员版 P1 T4（D17）— environment selection store unit tests.
 *
 * Covers the pure logic (selection validation, store parse/serialize,
 * per-workspace index, host default, display tag) plus the thin IO
 * (load/save round-trip against a temp dir; missing/corrupt file tolerance).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  emptySelectionStore,
  getWorkspaceSelection,
  getWorkspaceSelectionRecord,
  HOST_SELECTION,
  loadSelectionStore,
  mutateSelectionStore,
  parseSelectionStore,
  saveSelectionStore,
  selectionTag,
  serializeSelectionStore,
  setWorkspaceSelection,
  validateEnvSelection,
  type EnvSelectionStore,
} from './selection';

const WS_A = 'E:/work/target-a';
const WS_B = 'E:/work/target-b';
const STAMP = '2026-08-14T00:00:00.000Z';

describe('validateEnvSelection', () => {
  it('accepts a host selection', () => {
    const r = validateEnvSelection({ kind: 'host' });
    expect(r).toEqual({ ok: true, selection: { kind: 'host' } });
  });

  it('accepts an env selection with a non-empty id', () => {
    const r = validateEnvSelection({ kind: 'env', id: 'dev-box' });
    expect(r).toEqual({ ok: true, selection: { kind: 'env', id: 'dev-box' } });
  });

  it('accepts a recipe selection with name + instanceId', () => {
    const r = validateEnvSelection({ kind: 'recipe', name: 'pwn', instanceId: 'zhishi-pwn-a3f2b1c4' });
    expect(r).toEqual({
      ok: true,
      selection: { kind: 'recipe', name: 'pwn', instanceId: 'zhishi-pwn-a3f2b1c4' },
    });
  });

  it('rejects non-object input', () => {
    for (const bad of [null, undefined, 42, 'host', [], true]) {
      const r = validateEnvSelection(bad);
      expect(r.ok).toBe(false);
    }
  });

  it('rejects an unknown kind', () => {
    const r = validateEnvSelection({ kind: 'container', id: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('kind');
  });

  it('rejects env without a usable id', () => {
    for (const bad of [{ kind: 'env' }, { kind: 'env', id: '' }, { kind: 'env', id: '   ' }, { kind: 'env', id: 7 }]) {
      expect(validateEnvSelection(bad).ok).toBe(false);
    }
  });

  it('rejects recipe without name or instanceId', () => {
    expect(validateEnvSelection({ kind: 'recipe', name: 'pwn' }).ok).toBe(false);
    expect(validateEnvSelection({ kind: 'recipe', instanceId: 'zhishi-pwn-x' }).ok).toBe(false);
    expect(validateEnvSelection({ kind: 'recipe', name: '', instanceId: 'x' }).ok).toBe(false);
  });

  it('ignores unknown extra fields instead of failing', () => {
    const r = validateEnvSelection({ kind: 'host', note: 'future field' });
    expect(r).toEqual({ ok: true, selection: { kind: 'host' } });
  });
});

describe('workspace-indexed store (pure)', () => {
  it('empty store has version 1 and no workspaces', () => {
    expect(emptySelectionStore()).toEqual({ version: 1, workspaces: {} });
  });

  it('missing workspace defaults to host', () => {
    const store = emptySelectionStore();
    expect(getWorkspaceSelection(store, WS_A)).toEqual({ kind: 'host' });
    expect(getWorkspaceSelectionRecord(store, WS_A)).toBeUndefined();
  });

  it('set then get round-trips per workspace without mutating the input store', () => {
    const store = emptySelectionStore();
    const next = setWorkspaceSelection(store, WS_A, { kind: 'env', id: 'dev-box' }, STAMP);
    expect(store.workspaces).toEqual({}); // non-mutating
    expect(getWorkspaceSelection(next, WS_A)).toEqual({ kind: 'env', id: 'dev-box' });
    expect(getWorkspaceSelectionRecord(next, WS_A)?.selectedAt).toBe(STAMP);
    // other workspaces untouched → host default
    expect(getWorkspaceSelection(next, WS_B)).toEqual({ kind: 'host' });
  });

  it('re-selecting a workspace overwrites only that entry', () => {
    let store = emptySelectionStore();
    store = setWorkspaceSelection(store, WS_A, { kind: 'env', id: 'dev-box' }, STAMP);
    store = setWorkspaceSelection(store, WS_B, { kind: 'host' }, STAMP);
    store = setWorkspaceSelection(store, WS_A, { kind: 'recipe', name: 'pwn', instanceId: 'zhishi-pwn-a3f2' }, STAMP);
    expect(getWorkspaceSelection(store, WS_A)).toEqual({ kind: 'recipe', name: 'pwn', instanceId: 'zhishi-pwn-a3f2' });
    expect(getWorkspaceSelection(store, WS_B)).toEqual({ kind: 'host' });
  });

  it('serialize/parse round-trips', () => {
    let store = emptySelectionStore();
    store = setWorkspaceSelection(store, WS_A, { kind: 'recipe', name: 'fuzz', instanceId: 'zhishi-fuzz-b7c1' }, STAMP);
    const parsed = parseSelectionStore(serializeSelectionStore(store));
    expect(parsed).toEqual(store);
  });

  it('parse tolerates corrupt JSON and wrong shapes → empty store', () => {
    expect(parseSelectionStore('not json{')).toEqual(emptySelectionStore());
    expect(parseSelectionStore('42')).toEqual(emptySelectionStore());
    expect(parseSelectionStore('{"version":2,"workspaces":{}}')).toEqual(emptySelectionStore());
    expect(parseSelectionStore('{"version":1,"workspaces":"nope"}')).toEqual(emptySelectionStore());
  });

  it('parse drops individual corrupt workspace records but keeps valid ones', () => {
    const raw = JSON.stringify({
      version: 1,
      workspaces: {
        [WS_A]: { selection: { kind: 'env', id: 'dev-box' }, selectedAt: STAMP },
        [WS_B]: { selection: { kind: 'mystery' }, selectedAt: STAMP },
        'C:/bad': 'garbage',
      },
    });
    const store = parseSelectionStore(raw);
    expect(getWorkspaceSelection(store, WS_A)).toEqual({ kind: 'env', id: 'dev-box' });
    expect(getWorkspaceSelection(store, WS_B)).toEqual({ kind: 'host' });
    expect(getWorkspaceSelection(store, 'C:/bad')).toEqual({ kind: 'host' });
  });
});

describe('selectionTag', () => {
  it('host → host', () => {
    expect(selectionTag(HOST_SELECTION)).toBe('host');
  });

  it('env → env:<id>（具体引擎前缀由选择器按条目数据给出，这里只兜底）', () => {
    expect(selectionTag({ kind: 'env', id: 'dev-box' })).toBe('env:dev-box');
  });

  it('recipe with instanceId → docker:<instanceId>', () => {
    expect(selectionTag({ kind: 'recipe', name: 'pwn', instanceId: 'zhishi-pwn-a3f2' })).toBe('docker:zhishi-pwn-a3f2');
  });
});

describe('thin IO (load/save)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zhishi-env-selection-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('load of a missing file → empty store (no throw)', () => {
    expect(loadSelectionStore(join(dir, 'nope.json'))).toEqual(emptySelectionStore());
  });

  it('save creates parent dirs and load reads it back', () => {
    const path = join(dir, 'nested', 'env-selection.json');
    let store = emptySelectionStore();
    store = setWorkspaceSelection(store, WS_A, { kind: 'env', id: 'dev-box' }, STAMP);
    saveSelectionStore(store, path);
    expect(loadSelectionStore(path)).toEqual(store);
    // on-disk shape is stable JSON with a version field (S1 reads this file)
    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as EnvSelectionStore;
    expect(onDisk.version).toBe(1);
    expect(onDisk.workspaces[WS_A].selection).toEqual({ kind: 'env', id: 'dev-box' });
  });

  it('load of a corrupt file → empty store (no throw)', () => {
    const path = join(dir, 'env-selection.json');
    writeFileSync(path, '{{{corrupt', 'utf-8');
    expect(loadSelectionStore(path)).toEqual(emptySelectionStore());
  });
});

describe('mutateSelectionStore（withFileLock 锁内读-改-写）', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zhishi-env-selection-mutate-'));
    file = join(dir, 'env-selection.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('mutate → load round-trip；无改动（同引用返回）不落盘', async () => {
    await mutateSelectionStore((store) => setWorkspaceSelection(store, WS_A, { kind: 'env', id: 'dev-box' }, STAMP), file);
    expect(getWorkspaceSelection(loadSelectionStore(file), WS_A)).toEqual({ kind: 'env', id: 'dev-box' });

    // 无改动不写盘：对不存在的文件做恒等 mutate，文件不应被创建
    const ghost = join(dir, 'ghost.json');
    await mutateSelectionStore((store) => store, ghost);
    expect(existsSync(ghost)).toBe(false);
  });

  it('并发写串行化：两个 mutate 都不丢（锁内读-改-写）', async () => {
    await Promise.all([
      mutateSelectionStore((store) => setWorkspaceSelection(store, WS_A, { kind: 'env', id: 'dev-box' }, STAMP), file),
      mutateSelectionStore((store) => setWorkspaceSelection(store, WS_B, { kind: 'host' }, STAMP), file),
    ]);
    const store = loadSelectionStore(file);
    expect(getWorkspaceSelection(store, WS_A)).toEqual({ kind: 'env', id: 'dev-box' });
    expect(getWorkspaceSelection(store, WS_B)).toEqual({ kind: 'host' });
  });
});
