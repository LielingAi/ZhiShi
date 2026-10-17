/**
 * 2.0-M4：状态栏多环境任务栏段行装配单测。
 */

import { describe, expect, it } from 'vitest';

import { buildEnvStrip, shortEnvLabel } from './env-strip';

const ENVS = [
  { id: 'fuzz', kind: 'docker', name: 'fuzz' },
  { id: 'egym_p14', kind: 'docker', name: 'egym_p14' },
  { id: 'pwn-lab', kind: 'vm', name: 'pwn-lab' },
  { id: 'local', kind: 'local', name: '本机（Windows 宿主）' },
];

describe('shortEnvLabel', () => {
  it('取前 3 字符；local 恒「本机」；空名回落 id 前 3', () => {
    expect(shortEnvLabel({ id: 'fuzz', name: 'fuzz' })).toBe('fuz');
    expect(shortEnvLabel({ id: 'x', kind: 'local', name: '本机（Windows 宿主）' })).toBe('本机');
    expect(shortEnvLabel({ id: 'abcdef' })).toBe('abc');
  });
});

describe('buildEnvStrip', () => {
  it('排序：运行中 → 已停止 → 本机钉底；同组按 id', () => {
    const { rows, overflow } = buildEnvStrip(ENVS, ['fuzz', 'pwn-lab'], 'fuzz', [], 6);
    expect(overflow).toBe(0);
    expect(rows.map((r) => r.id)).toEqual(['fuzz', 'pwn-lab', 'egym_p14', 'local']);
    expect(rows[0].current).toBe(true);
    expect(rows[3].state).toBe('local');
  });

  it('活性计数：auto-run envKey（env:<id>）命中 → activity=1', () => {
    const { rows } = buildEnvStrip(ENVS, ['fuzz'], null, ['env:fuzz']);
    expect(rows.find((r) => r.id === 'fuzz')?.activity).toBe(1);
    expect(rows.find((r) => r.id === 'egym_p14')?.activity).toBe(0);
  });

  it('溢出折叠：> maxVisible → 前 N + overflow 计数', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `e${i}`, kind: 'docker', name: `e${i}` }));
    const { rows, overflow } = buildEnvStrip(many, [], null, [], 6);
    expect(rows.length).toBe(6);
    expect(overflow).toBe(3);
  });

  it('当前环境在已停止组时不置顶（点击目标不漂移）', () => {
    const { rows } = buildEnvStrip(ENVS, ['fuzz'], 'pwn-lab', [], 6);
    expect(rows[0].id).toBe('fuzz'); // 运行中仍在排头
    expect(rows.find((r) => r.id === 'pwn-lab')?.current).toBe(true);
  });
});
