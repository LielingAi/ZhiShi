/**
 * slash-research.test.ts — 1.5.0 研究四命令模型层单测。
 *
 * 覆盖：上下文缺省提取（最近用户消息/截断/空态）、显式参数优先、
 * 注入文本形态（查询词+结果+人请求标注）、/decide 议题缺省、/archive 固化指令。
 */
import { describe, expect, it } from 'vitest';

import type { StreamItem } from './blocks';
import {
  ARCHIVE_INSTRUCTION,
  buildDecideInstruction,
  buildExpertInjectText,
  buildIntelInjectText,
  contextQueryFallback,
  effectiveQuery,
} from './slash-research';

function turn(userText: string): StreamItem {
  return { kind: 'turn', userText } as unknown as StreamItem;
}

describe('contextQueryFallback（通吃上下文——最近用户消息）', () => {
  it('取最后一条用户消息文本；空白压缩', () => {
    const items = [turn('第一个问题'), turn('wasm 编码器   writeOpcode\n有多写字节吗')];
    expect(contextQueryFallback(items)).toBe('wasm 编码器 writeOpcode 有多写字节吗');
  });

  it('超长截断 160 字带省略号', () => {
    const items = [turn('x'.repeat(200))];
    const q = contextQueryFallback(items);
    expect(q.length).toBe(161);
    expect(q.endsWith('…')).toBe(true);
  });

  it('无用户消息 → 空串（调用方提示需要查询词）', () => {
    expect(contextQueryFallback([])).toBe('');
  });
});

describe('effectiveQuery（显式参数优先，留空吃上下文）', () => {
  it('显式参数优先', () => {
    expect(effectiveQuery('CVE-2024-1234', [turn('别的问题')])).toBe('CVE-2024-1234');
  });
  it('留空吃上下文', () => {
    expect(effectiveQuery('  ', [turn('cJSON 解析路径')])).toBe('cJSON 解析路径');
  });
});

describe('注入文本形态（人请求的上下文块）', () => {
  it('/expert：查询词 + 结果 + 人请求标注', () => {
    const t = buildExpertInjectText('opengrep 污点规则', '【专家审定知识】命中 1 条');
    expect(t).toContain('【/expert 专家知识 · 查询：opengrep 污点规则】');
    expect(t).toContain('命中 1 条');
    expect(t).toContain('应我请求检索');
  });

  it('/intel：标注线索不是结论', () => {
    const t = buildIntelInjectText('CVE-2024-1234', 'CVE-2024-1234 | CVSS 9.8');
    expect(t).toContain('【/intel 情报检索 · 查询：CVE-2024-1234】');
    expect(t).toContain('线索不是结论');
  });
});

describe('/archive /decide 固化指令', () => {
  it('ARCHIVE_INSTRUCTION：四实体 + 终态 + 只整理不开新工', () => {
    expect(ARCHIVE_INSTRUCTION).toContain('research_archive');
    expect(ARCHIVE_INSTRUCTION).toContain('resolve/falsify/abandon');
    expect(ARCHIVE_INSTRUCTION).toContain('against');
    expect(ARCHIVE_INSTRUCTION).toContain('不要开始新的工作');
  });

  it('/decide：显式议题 vs 上下文焦点缺省；提请后停等', () => {
    expect(buildDecideInstruction('要不要换 joern')).toContain('议题：要不要换 joern');
    expect(buildDecideInstruction(' ')).toContain('你先判断是什么');
    expect(buildDecideInstruction('')).toContain('request_decision');
    expect(buildDecideInstruction('')).toContain('停下等我的决定');
  });
});
