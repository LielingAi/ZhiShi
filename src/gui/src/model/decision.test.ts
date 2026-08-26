/**
 * 决策面板纯函数单测（1.3.2 ①）：
 * 登记表去重（重连重放）/ 专家摘要行解析（E#N 徽章 + 库中无基准原样）/
 * 选项快捷键 / 决策块正文解析。
 */

import { describe, expect, it } from 'vitest';

import {
  hasDecision,
  NO_BASELINE_MARK,
  optionHotkey,
  optionHotkeyIndex,
  parseDecisionBody,
  parseExpertHit,
  removeDecision,
  upsertDecision,
} from './decision';

describe('upsertDecision / removeDecision（重连重放按 decisionId 去重）', () => {
  const view = {
    decisionId: 'dec-1',
    question: '走 A 还是 B？',
    options: ['A', 'B'],
    expertHits: ['E#12 [binary/technique] 堆喷 | 适用条件: x | 判据: y'],
  };

  it('登记；同 decisionId 重放不重复（幂等 upsert，内容刷新）', () => {
    const a = upsertDecision([], view, 100);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ decisionId: 'dec-1', question: '走 A 还是 B？', options: ['A', 'B'], receivedAt: 100 });

    const again = upsertDecision(a, { ...view, options: ['A', 'B', 'C'] }, 200);
    expect(again).toHaveLength(1); // 不重复登记
    expect(again[0].options).toEqual(['A', 'B', 'C']);
    expect(again[0].receivedAt).toBe(200);
  });

  it('缺 decisionId / 非字符串选项被滤掉', () => {
    expect(upsertDecision([], { question: 'x' })).toEqual([]);
    expect(upsertDecision([], { decisionId: 'd', options: ['a', 1, null] })[0].options).toEqual(['a']);
  });

  it('resolved / 应答后移除（幂等）', () => {
    const list = upsertDecision([], view);
    expect(removeDecision(list, 'dec-1')).toEqual([]);
    expect(removeDecision(list, 'dec-9')).toEqual(list);
    expect(removeDecision(list, undefined)).toEqual(list);
  });

  it('hasDecision 守卫', () => {
    const list = upsertDecision([], view);
    expect(hasDecision(list, 'dec-1')).toBe(true);
    expect(hasDecision(list, 'dec-2')).toBe(false);
  });
});

describe('parseExpertHit（专家依据区）', () => {
  it('E#N 命中行 → 徽章 + 文本', () => {
    const hit = parseExpertHit('E#12 [binary/technique] 堆喷占位 | 适用条件: glibc | 判据: chunk');
    expect(hit).toEqual({ kind: 'hit', ref: 'E#12', text: '[binary/technique] 堆喷占位 | 适用条件: glibc | 判据: chunk' });
  });

  it('「库中无基准」→ 特殊样式（语义原样，不改成「库中没有」）', () => {
    const hit = parseExpertHit(NO_BASELINE_MARK);
    expect(hit).toEqual({ kind: 'no-baseline' });
    expect(NO_BASELINE_MARK).toBe('库中无基准');
  });

  it('非 E# 行 → 无徽章原样（前向兼容）', () => {
    expect(parseExpertHit('某条旧格式摘要')).toEqual({ kind: 'hit', text: '某条旧格式摘要' });
  });
});

describe('optionHotkey / optionHotkeyIndex', () => {
  it('前 26 项 a-z，之后数字', () => {
    expect(optionHotkey(0)).toBe('a');
    expect(optionHotkey(25)).toBe('z');
    expect(optionHotkey(26)).toBe('27');
  });

  it('按键 → 下标（大小写不敏感 / 数字）', () => {
    expect(optionHotkeyIndex('a')).toBe(0);
    expect(optionHotkeyIndex('B')).toBe(1);
    expect(optionHotkeyIndex('z')).toBe(25);
    expect(optionHotkeyIndex('1')).toBeNull(); // 1-9 与 a-i 冲突，数字只在 26+ 启用
    expect(optionHotkeyIndex('27')).toBe(26);
    expect(optionHotkeyIndex('Escape')).toBeNull();
  });
});

describe('parseDecisionBody（决策块正文）', () => {
  it('问题/选择/备注 三字段', () => {
    const parts = parseDecisionBody('【人的决定】\n问题: 方向 A 还是 B\n选择: 方向 A\n备注: 证据不足先探');
    expect(parts).toEqual({ question: '方向 A 还是 B', choice: '方向 A', note: '证据不足先探' });
  });

  it('缺失行忽略；全角冒号兼容', () => {
    expect(parseDecisionBody('【人的决定】\n选择：B')).toEqual({ choice: 'B' });
    expect(parseDecisionBody('')).toEqual({});
  });
});
