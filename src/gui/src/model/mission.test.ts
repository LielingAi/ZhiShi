/**
 * mission.test.ts — 1.6.8 M1 任务形态设定面纯函数层单测。
 *
 * 覆盖：MISSION_OPTIONS（首项无类型 + shared 闭集顺序）、missionLabel
 * （中文标签/非法值回落）、missionPatchValue（'' → null 清除）。
 */
import { describe, expect, it } from 'vitest';

import { missionLabel, missionPatchValue, MISSION_OPTIONS } from './mission';

describe('MISSION_OPTIONS（形态选择器选项表）', () => {
  it('首项无类型（空串值），其余按 shared 闭集顺序带中文标签', () => {
    expect(MISSION_OPTIONS).toEqual([
      { value: '', label: '无类型' },
      { value: 'discover', label: '挖掘' },
      { value: 'exploit', label: '利用' },
      { value: 'reproduce', label: '复现' },
      { value: 'ctf', label: 'CTF' },
    ]);
  });
});

describe('missionLabel', () => {
  it('合法形态 → 中文标签；空/非法 → 无类型', () => {
    expect(missionLabel('discover')).toBe('挖掘');
    expect(missionLabel('ctf')).toBe('CTF');
    expect(missionLabel(null)).toBe('无类型');
    expect(missionLabel(undefined)).toBe('无类型');
    expect(missionLabel('nope')).toBe('无类型');
  });
});

describe('missionPatchValue', () => {
  it('合法形态原样透传；空串/非法 → null（清除）', () => {
    expect(missionPatchValue('exploit')).toBe('exploit');
    expect(missionPatchValue('')).toBeNull();
    expect(missionPatchValue('nope')).toBeNull();
  });
});
