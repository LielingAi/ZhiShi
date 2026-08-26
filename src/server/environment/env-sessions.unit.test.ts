/**
 * 1.1.6 #4 — env-sessions（会话按环境分线映射）unit tests.
 *
 * 覆盖纯逻辑（环境键、workspace 规范化、行键、parse/serialize、行变换）
 * 与薄 IO（set/remove/清残留 对临时目录的 round-trip；缺失/损坏容错；
 * withFileLock 串行写不丢更新）。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  emptyEnvSessionsMap,
  envKeyForSelection,
  envSessionLineKey,
  findEnvKeyForLoopSession,
  getEnvSessionLine,
  loadEnvSessionsMap,
  normalizeWorkspaceKey,
  parseEnvSessionsMap,
  removeEnvSessionLine,
  removeEnvSessionLineFromMap,
  removeEnvSessionsForEnvId,
  removeEnvSessionsForEnvIdFromMap,
  serializeEnvSessionsMap,
  setEnvSessionLine,
  setEnvSessionLineInMap,
  type EnvSessionsMap,
} from './env-sessions';

const WS_A = 'E:/work/target-a';
const WS_B = 'E:/work/target-b';
const STAMP = '2026-08-20T00:00:00.000Z';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'env-sessions-test-'));
  file = join(dir, 'env-sessions.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('envKeyForSelection（环境键）', () => {
  it('env → env:<id>；recipe → recipe:<instanceId>；host → host', () => {
    expect(envKeyForSelection({ kind: 'env', id: 'pwn-vm' })).toBe('env:pwn-vm');
    expect(envKeyForSelection({ kind: 'recipe', name: 'pwn', instanceId: 'zhishi-pwn-a3f2' }))
      .toBe('recipe:zhishi-pwn-a3f2');
    expect(envKeyForSelection({ kind: 'host' })).toBe('host');
  });
});

describe('normalizeWorkspaceKey（斜杠漂移治本）', () => {
  it('resolve + 统一正斜杠；正/反斜杠两形态殊途同归', () => {
    expect(normalizeWorkspaceKey(WS_A)).toBe(resolve(WS_A).replace(/\\/g, '/'));
    // 活体坑（chat-engine resolveSessionEnv 双形态兜底）：两形态必须出同一个键
    expect(normalizeWorkspaceKey('E:\\work\\target-a')).toBe(normalizeWorkspaceKey('E:/work/target-a'));
  });
});

describe('envSessionLineKey（行键）', () => {
  it('`${规范化workspace}::${环境键}`', () => {
    expect(envSessionLineKey(WS_A, 'env:pwn-vm'))
      .toBe(`${normalizeWorkspaceKey(WS_A)}::env:pwn-vm`);
    // 反斜杠形态出同一行键
    expect(envSessionLineKey('E:\\work\\target-a', 'host')).toBe(envSessionLineKey(WS_A, 'host'));
  });
});

describe('parse/serialize', () => {
  it('round-trip；损坏 JSON / 顶层形状错 → 空表；坏行丢弃', () => {
    const map: EnvSessionsMap = {
      version: 1,
      lines: {
        [envSessionLineKey(WS_A, 'env:pwn-vm')]: { loopSessionId: 'ls-1', updatedAt: STAMP },
      },
    };
    const parsed = parseEnvSessionsMap(serializeEnvSessionsMap(map));
    expect(parsed).toEqual(map);

    expect(parseEnvSessionsMap('not json')).toEqual(emptyEnvSessionsMap());
    expect(parseEnvSessionsMap('{"version":2,"lines":{}}')).toEqual(emptyEnvSessionsMap());
    expect(parseEnvSessionsMap('{"version":1,"lines":[]}')).toEqual(emptyEnvSessionsMap());

    const withBadLines = JSON.stringify({
      version: 1,
      lines: {
        good: { loopSessionId: 'ls-9', updatedAt: STAMP },
        'no-id': { updatedAt: STAMP },
        'wrong-type': 'ls-x',
      },
    });
    const cleaned = parseEnvSessionsMap(withBadLines);
    expect(Object.keys(cleaned.lines)).toEqual(['good']);
    expect(cleaned.lines.good.loopSessionId).toBe('ls-9');
  });
});

describe('行变换（纯函数）', () => {
  it('set/get/remove；remove 未命中返回原表（引用不变）', () => {
    let map = emptyEnvSessionsMap();
    map = setEnvSessionLineInMap(map, WS_A, 'env:pwn-vm', 'ls-1', STAMP);
    map = setEnvSessionLineInMap(map, WS_A, 'host', 'ls-2', STAMP);
    expect(getEnvSessionLine(map, WS_A, 'env:pwn-vm')?.loopSessionId).toBe('ls-1');
    expect(getEnvSessionLine(map, WS_A, 'host')?.loopSessionId).toBe('ls-2');
    expect(getEnvSessionLine(map, WS_B, 'host')).toBeUndefined();

    const removed = removeEnvSessionLineFromMap(map, WS_A, 'env:pwn-vm');
    expect(getEnvSessionLine(removed, WS_A, 'env:pwn-vm')).toBeUndefined();
    expect(getEnvSessionLine(removed, WS_A, 'host')?.loopSessionId).toBe('ls-2');
    expect(removeEnvSessionLineFromMap(removed, WS_A, 'env:pwn-vm')).toBe(removed);
  });

  it('removeEnvSessionsForEnvIdFromMap：清所有 workspace 的 env:<id> 行，别的不动', () => {
    let map = emptyEnvSessionsMap();
    map = setEnvSessionLineInMap(map, WS_A, 'env:pwn-vm', 'ls-1', STAMP);
    map = setEnvSessionLineInMap(map, WS_B, 'env:pwn-vm', 'ls-2', STAMP);
    map = setEnvSessionLineInMap(map, WS_A, 'env:pwn-vm2', 'ls-3', STAMP); // 前缀相近,不许误删
    map = setEnvSessionLineInMap(map, WS_A, 'host', 'ls-4', STAMP);
    const cleaned = removeEnvSessionsForEnvIdFromMap(map, 'pwn-vm');
    expect(Object.keys(cleaned.lines)).toEqual([
      envSessionLineKey(WS_A, 'env:pwn-vm2'),
      envSessionLineKey(WS_A, 'host'),
    ]);
    // 无命中 → 原表（引用不变）
    expect(removeEnvSessionsForEnvIdFromMap(cleaned, 'ghost')).toBe(cleaned);
  });

  it('findEnvKeyForLoopSession（1.3.3 历史面板反查）：命中/无映射/跨 workspace', () => {
    let map = emptyEnvSessionsMap();
    map = setEnvSessionLineInMap(map, WS_A, 'env:pwn-vm', 'ls-1', STAMP);
    map = setEnvSessionLineInMap(map, WS_A, 'host', 'ls-2', STAMP);
    map = setEnvSessionLineInMap(map, WS_B, 'env:pwn-vm', 'ls-3', STAMP);

    expect(findEnvKeyForLoopSession(map, WS_A, 'ls-1')).toBe('env:pwn-vm');
    expect(findEnvKeyForLoopSession(map, WS_A, 'ls-2')).toBe('host');
    // 跨 workspace 隔离:同一 loopSessionId 在别的 workspace 命中的行不算
    expect(findEnvKeyForLoopSession(map, WS_A, 'ls-3')).toBeNull();
    expect(findEnvKeyForLoopSession(map, WS_B, 'ls-3')).toBe('env:pwn-vm');
    expect(findEnvKeyForLoopSession(map, WS_A, 'ghost')).toBeNull();
    // 反斜杠形态 workspace 殊途同归
    expect(findEnvKeyForLoopSession(map, 'E:\\work\\target-a', 'ls-1')).toBe('env:pwn-vm');
  });
});

describe('IO（withFileLock + tmp+rename）', () => {
  it('set → load round-trip；缺文件 → 空表；损坏文件 → 空表', async () => {
    expect(loadEnvSessionsMap(file)).toEqual(emptyEnvSessionsMap());

    await setEnvSessionLine(WS_A, 'env:pwn-vm', 'ls-1', file);
    await setEnvSessionLine(WS_A, 'host', 'ls-2', file);
    const map = loadEnvSessionsMap(file);
    expect(getEnvSessionLine(map, WS_A, 'env:pwn-vm')?.loopSessionId).toBe('ls-1');
    expect(getEnvSessionLine(map, WS_A, 'host')?.loopSessionId).toBe('ls-2');
    // updatedAt 自动打戳
    expect(getEnvSessionLine(map, WS_A, 'host')?.updatedAt).toBeTruthy();

    writeFileSync(file, 'corrupted{', 'utf-8');
    expect(loadEnvSessionsMap(file)).toEqual(emptyEnvSessionsMap());
  });

  it('removeEnvSessionLine：删掉对应行；未命中不建文件', async () => {
    await setEnvSessionLine(WS_A, 'env:pwn-vm', 'ls-1', file);
    await removeEnvSessionLine(WS_A, 'env:pwn-vm', file);
    expect(loadEnvSessionsMap(file).lines).toEqual({});

    await removeEnvSessionLine(WS_B, 'host', file); // 未命中
    expect(loadEnvSessionsMap(file).lines).toEqual({});
  });

  it('removeEnvSessionsForEnvId：清残留；无残留时不落盘', async () => {
    await removeEnvSessionsForEnvId('ghost', file);
    expect(existsSync(file)).toBe(false);

    await setEnvSessionLine(WS_A, 'env:pwn-vm', 'ls-1', file);
    await setEnvSessionLine(WS_B, 'env:pwn-vm', 'ls-2', file);
    await setEnvSessionLine(WS_A, 'host', 'ls-3', file);
    await removeEnvSessionsForEnvId('pwn-vm', file);
    const rest = loadEnvSessionsMap(file);
    expect(Object.keys(rest.lines)).toEqual([envSessionLineKey(WS_A, 'host')]);
  });

  it('并发写串行化：两个 set 都不丢（锁内读-改-写）', async () => {
    await Promise.all([
      setEnvSessionLine(WS_A, 'env:a', 'ls-a', file),
      setEnvSessionLine(WS_A, 'env:b', 'ls-b', file),
    ]);
    const map = loadEnvSessionsMap(file);
    expect(getEnvSessionLine(map, WS_A, 'env:a')?.loopSessionId).toBe('ls-a');
    expect(getEnvSessionLine(map, WS_A, 'env:b')?.loopSessionId).toBe('ls-b');
  });
});
