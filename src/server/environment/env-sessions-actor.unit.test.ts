/**
 * 1.8.7 P3b 双线制——env-sessions.json 行键扩展（设计稿 R3）。
 *
 * 覆盖：
 *  - 双键读写：归属段键（`ws::alice::env:X` / `ws::shared::env:X`）与旧两段
 *    式键（`ws::env:X`）各自独立读写；
 *  - R3 旧键回读：actor 解析链 = 私有键 → 共享键 → 旧键，首个命中生效
 *    （现有 22 条线的旧映射必须继续解析）；写只写新格式；
 *  - remove：归属段给出时新旧键同清（防旧键回读复活）；
 *  - retarget（line/share + line/unshare）：映射行重挂归属段；
 *  - findEnvKeyForLoopSession：三段式行键剥归属段返回同一环境键。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  emptyEnvSessionsMap,
  envSessionLineKey,
  findEnvKeyForLoopSession,
  getEnvSessionLine,
  loadEnvSessionsMap,
  removeEnvSessionLine,
  removeEnvSessionLineFromMap,
  retargetEnvSessionLines,
  retargetEnvSessionLinesInMap,
  serializeEnvSessionsMap,
  setEnvSessionLine,
  setEnvSessionLineInMap,
  SHARED_LINE_SEGMENT,
  type EnvSessionsMap,
} from './env-sessions';

const WS = 'E:/code/u-disk';

function mapWith(lines: Record<string, { loopSessionId: string; updatedAt?: string }>): EnvSessionsMap {
  const map = emptyEnvSessionsMap();
  for (const [key, line] of Object.entries(lines)) {
    map.lines[key] = { loopSessionId: line.loopSessionId, updatedAt: line.updatedAt ?? '' };
  }
  return map;
}

describe('P3b env-sessions 行键扩展(双线制)', () => {
  it('envSessionLineKey:无段 = 旧两段式;有段 = 三段式', () => {
    expect(envSessionLineKey(WS, 'env:pwn-vm')).toBe(`${WS}::env:pwn-vm`);
    expect(envSessionLineKey(WS, 'env:pwn-vm', 'alice')).toBe(`${WS}::alice::env:pwn-vm`);
    expect(envSessionLineKey(WS, 'env:pwn-vm', SHARED_LINE_SEGMENT)).toBe(`${WS}::shared::env:pwn-vm`);
  });

  it('R3 旧键回读:actor 解析链 = 私有键 → 共享键 → 旧键,首个命中生效', () => {
    const map = mapWith({
      // 旧两段式(1.8.6 时代的存量映射)——必须继续解析
      [`${WS}::env:pwn-vm`]: { loopSessionId: 'ls-legacy' },
      [`${WS}::shared::env:team-box`]: { loopSessionId: 'ls-shared' },
      [`${WS}::alice::env:pwn-vm`]: { loopSessionId: 'ls-alice' },
    });
    // alice 在 pwn-vm 上有私有线 → 私有键优先(不回退共享/旧键)
    expect(getEnvSessionLine(map, WS, 'env:pwn-vm', { actor: 'alice' })?.loopSessionId).toBe('ls-alice');
    // bob 无私有线、本环境无共享线 → 落到旧键(R3:旧映射不断)
    expect(getEnvSessionLine(map, WS, 'env:pwn-vm', { actor: 'bob' })?.loopSessionId).toBe('ls-legacy');
    // 无私有键但有共享键 → 共享线
    expect(getEnvSessionLine(map, WS, 'env:team-box', { actor: 'bob' })?.loopSessionId).toBe('ls-shared');
    // 都无 → undefined
    expect(getEnvSessionLine(map, WS, 'env:nothing', { actor: 'bob' })).toBeUndefined();
    // 无 actor(旧调用方)= 仅旧键,1.8.6 语义
    expect(getEnvSessionLine(map, WS, 'env:pwn-vm')?.loopSessionId).toBe('ls-legacy');
    expect(getEnvSessionLine(map, WS, 'env:team-box')).toBeUndefined();
  });

  it('remove:归属段给出时新旧键同清;无段仅清旧键', () => {
    const map = mapWith({
      [`${WS}::alice::host`]: { loopSessionId: 'ls-a' },
      [`${WS}::host`]: { loopSessionId: 'ls-a' },
    });
    const cleared = removeEnvSessionLineFromMap(map, WS, 'host', 'alice');
    expect(Object.keys(cleared.lines)).toEqual([]);
    // 无段 = 仅清旧键(1.8.6 语义),新键不动
    const legacyOnly = removeEnvSessionLineFromMap(map, WS, 'host');
    expect(Object.keys(legacyOnly.lines)).toEqual([`${WS}::alice::host`]);
  });

  it('retarget(share/unshare):映射行重挂归属段,workspace 与 envKey 原样保留', () => {
    const map = mapWith({
      [`${WS}::alice::env:pwn-vm`]: { loopSessionId: 'ls-x' },
      [`${WS}::host`]: { loopSessionId: 'ls-x' }, // 同线的旧键残留一并收编
      [`${WS}::alice::env:other`]: { loopSessionId: 'ls-y' },
    });
    const shared = retargetEnvSessionLinesInMap(map, 'ls-x', SHARED_LINE_SEGMENT);
    expect(Object.keys(shared.lines).sort()).toEqual([
      `${WS}::alice::env:other`,
      `${WS}::shared::env:pwn-vm`,
      `${WS}::shared::host`,
    ]);
    // unshare:重挂回调用方段
    const back = retargetEnvSessionLinesInMap(shared, 'ls-x', 'carol');
    expect(back.lines[`${WS}::carol::env:pwn-vm`]?.loopSessionId).toBe('ls-x');
    expect(back.lines[`${WS}::carol::host`]?.loopSessionId).toBe('ls-x');
    // 无命中 → 原 map(不写盘信号)
    expect(retargetEnvSessionLinesInMap(map, 'ls-no-such', 'carol')).toBe(map);
  });

  it('findEnvKeyForLoopSession:三段式行键剥归属段,返回同一环境键', () => {
    const map = mapWith({
      [`${WS}::alice::env:pwn-vm`]: { loopSessionId: 'ls-a' },
      [`${WS}::host`]: { loopSessionId: 'ls-l' },
    });
    expect(findEnvKeyForLoopSession(map, WS, 'ls-a')).toBe('env:pwn-vm');
    expect(findEnvKeyForLoopSession(map, WS, 'ls-l')).toBe('host');
    expect(findEnvKeyForLoopSession(map, WS, 'ls-none')).toBeNull();
  });
});

describe('P3b env-sessions 落盘(round-trip + R3 回读)', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zhishi-env-sessions-p3b-'));
    path = join(dir, 'env-sessions.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('写新格式键 → 读解析命中;旧键文件回读不断(R3)', async () => {
    // 旧格式文件(1.8.6 落盘的形状)——读必须继续解析
    const legacy = mapWith({ [`${WS}::env:pwn-vm`]: { loopSessionId: 'ls-legacy', updatedAt: 'u' } });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, serializeEnvSessionsMap(legacy), 'utf-8');
    const loaded = loadEnvSessionsMap(path);
    expect(getEnvSessionLine(loaded, WS, 'env:pwn-vm', { actor: 'alice' })?.loopSessionId).toBe('ls-legacy');
    // 写新格式:alice 的私有键落盘,旧键原样保留(回读兜底)
    await setEnvSessionLine(WS, 'env:pwn-vm', 'ls-alice-new', path, 'alice');
    const after = loadEnvSessionsMap(path);
    expect(after.lines[`${WS}::alice::env:pwn-vm`]?.loopSessionId).toBe('ls-alice-new');
    expect(after.lines[`${WS}::env:pwn-vm`]?.loopSessionId).toBe('ls-legacy');
    // 盘上文本只追加新键,不重写旧键格式
    const raw = readFileSync(path, 'utf-8');
    expect(raw).toContain(`${WS}::alice::env:pwn-vm`);
    expect(raw).toContain(`${WS}::env:pwn-vm`);
  });

  it('removeEnvSessionLine:归属段给出时新旧键同清(防 reset 复活)', async () => {
    await setEnvSessionLine(WS, 'host', 'ls-a', path, 'alice');
    await setEnvSessionLine(WS, 'host', 'ls-a', path); // 旧键残留
    expect(Object.keys(loadEnvSessionsMap(path).lines)).toHaveLength(2);
    await removeEnvSessionLine(WS, 'host', path, 'alice');
    expect(Object.keys(loadEnvSessionsMap(path).lines)).toHaveLength(0);
  });

  it('retargetEnvSessionLines:盘上重挂归属段(line/share 的落盘路径)', async () => {
    await setEnvSessionLine(WS, 'env:pwn-vm', 'ls-x', path, 'alice');
    await retargetEnvSessionLines('ls-x', SHARED_LINE_SEGMENT, path);
    const after = loadEnvSessionsMap(path);
    expect(after.lines[`${WS}::shared::env:pwn-vm`]?.loopSessionId).toBe('ls-x');
    expect(after.lines[`${WS}::alice::env:pwn-vm`]).toBeUndefined();
  });
});
