/**
 * 1.8.7 P5 团队大脑——环境占用（occupancy.ts）单测。
 *
 * 覆盖：claim/release 的 token 纪律（过期释放不摘别人的新占用）、
 * claimEnvIfFree 不踩既有占用、forceReleaseEnv 无条件摘、投影快照、
 * 警告文案（带线/不带线/loud）、重置（重启即空的设计语义）。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  __resetOccupancyForTests,
  claimEnv,
  claimEnvIfFree,
  envOccupancy,
  forceReleaseEnv,
  formatOccupancyWarning,
  occupancySnapshot,
  releaseEnv,
} from './occupancy';

beforeEach(() => __resetOccupancyForTests());

describe('claim / release 的 token 纪律', () => {
  it('claim 登记 {by, line, since}；release 持同一 token 才摘', () => {
    const t1 = claimEnv('e1', { by: 'wren', line: 'ls-abcdef123456' });
    const occ = envOccupancy('e1');
    expect(occ?.by).toBe('wren');
    expect(occ?.line).toBe('ls-abcdef123456');
    expect(occ?.since).toBeTruthy();

    // 另一路 claim 覆盖（后到的 turn 是更新的真相）；旧 token 的释放摘不掉它。
    const t2 = claimEnv('e1', { by: 'kai', line: 'ls-999999999999' });
    releaseEnv('e1', t1);
    expect(envOccupancy('e1')?.by).toBe('kai');
    releaseEnv('e1', t2);
    expect(envOccupancy('e1')).toBeUndefined();
  });

  it('claimEnvIfFree：空闲登记，占用中返回 null（不踩 turn 的线占用）', () => {
    const turn = claimEnv('e1', { by: 'wren', line: 'ls-1' });
    expect(claimEnvIfFree('e1', { by: 'kai' })).toBeNull();
    expect(envOccupancy('e1')?.by).toBe('wren');
    releaseEnv('e1', turn);
    const exec = claimEnvIfFree('e1', { by: 'kai' });
    expect(exec).not.toBeNull();
    expect(envOccupancy('e1')).toEqual(expect.objectContaining({ by: 'kai' }));
    expect(envOccupancy('e1')?.line).toBeUndefined();
    releaseEnv('e1', exec!);
    expect(envOccupancy('e1')).toBeUndefined();
  });

  it('forceReleaseEnv 无条件摘（environment/down 成功语义）', () => {
    claimEnv('e1', { by: 'wren', line: 'ls-1' });
    forceReleaseEnv('e1');
    expect(envOccupancy('e1')).toBeUndefined();
  });
});

describe('投影与文案', () => {
  it('occupancySnapshot 全量快照（不泄露内部 token）', () => {
    claimEnv('e1', { by: 'wren', line: 'ls-1' });
    claimEnv('e2', { by: 'kai' });
    const snap = occupancySnapshot();
    expect(Object.keys(snap).sort()).toEqual(['e1', 'e2']);
    expect(snap.e1).not.toHaveProperty('tag');
  });

  it('formatOccupancyWarning：带线 / 不带线 / loud', () => {
    const since = new Date().toISOString();
    const withLine = formatOccupancyWarning('zhishi-pwn-x', { by: 'wren', line: 'ab12cd34ef56', since });
    expect(withLine).toContain('env zhishi-pwn-x 正被 wren（线 ab12cd34）占用（自 ');
    expect(withLine).toMatch(/自 \d{2}:\d{2}）$/);
    const noLine = formatOccupancyWarning('e1', { by: 'kai', since });
    expect(noLine).toContain('正被 kai 占用');
    expect(noLine).not.toContain('线');
    const loud = formatOccupancyWarning('e1', { by: 'kai', since }, { loud: true });
    expect(loud).toContain('——停止将中断其进行中的工作');
  });

  it('重置即空（重启 sidecar 从空开始的设计语义；in-memory 不落盘）', () => {
    claimEnv('e1', { by: 'wren' });
    __resetOccupancyForTests();
    expect(occupancySnapshot()).toEqual({});
  });
});
