/**
 * 2.0-M4b：环境面板行装配单测。
 */

import { describe, expect, it } from 'vitest';

import { buildEnvPanelRows, doingTextOf, latestRunOf } from './env-panel';

const ENVS = [
  { id: 'fuzz', kind: 'docker', name: 'fuzz' },
  { id: 'egym_p14', kind: 'docker', name: 'egym_p14' },
  { id: 'local', kind: 'local', name: '本机（Windows 宿主）' },
];

const RUNS = [
  { id: 'a1', name: 'usrsctp 审计', envKey: 'env:fuzz', status: 'running' },
  { id: 'a0', name: '旧任务', envKey: 'env:fuzz', status: 'completed' },
];

describe('latestRunOf / doingTextOf', () => {
  it('取该环境第一条（新→旧序）记录；无记录 null', () => {
    expect(latestRunOf(RUNS, 'fuzz')?.id).toBe('a1');
    expect(latestRunOf(RUNS, 'egym_p14')).toBeNull();
  });

  it('文案：运行中带任务名；已完成带 ✓；无记录空串', () => {
    expect(doingTextOf(RUNS[0])).toBe('auto loop「usrsctp 审计」· 运行中');
    expect(doingTextOf({ status: 'completed' })).toBe('auto loop · ✓ 已完成');
    expect(doingTextOf(null)).toBe('');
  });
});

describe('buildEnvPanelRows', () => {
  it('排序：运行中→停止→本机；行带 doing 与 done', () => {
    const rows = buildEnvPanelRows(ENVS, ['fuzz'], 'fuzz', RUNS);
    expect(rows.map((r) => r.id)).toEqual(['fuzz', 'egym_p14', 'local']);
    expect(rows[0].current).toBe(true);
    expect(rows[0].doing).toContain('usrsctp 审计');
    expect(rows[0].done).toBe(false); // 最新 run 在跑
    expect(rows[1].doing).toBe('');
    expect(rows[2].state).toBe('local');
  });

  it('最近 run 已完成 → done=true（完成标记输入）', () => {
    const rows = buildEnvPanelRows(
      ENVS,
      [],
      null,
      [{ id: 'x', name: 't', envKey: 'env:egym_p14', status: 'completed' }],
    );
    expect(rows.find((r) => r.id === 'egym_p14')?.done).toBe(true);
  });
});
