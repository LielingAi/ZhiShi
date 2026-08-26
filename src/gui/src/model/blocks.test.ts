/**
 * blocks 纯函数单测：徽标行 / 工具序号 / 信号提取。
 */

import { describe, expect, it } from 'vitest';

import { buildBadgeSummary, summarizeSignal, toolStepChar, thinkingTotalSeconds } from './blocks';
import type { DetailItem } from './blocks';

function th(seconds?: number, streaming = false): DetailItem {
  return { kind: 'thinking', id: 'th', text: 'x', streaming, seconds, startedAt: 0 };
}

function tool(name: string, id: string): DetailItem {
  return { kind: 'tool', id, name, argsSummary: '', state: 'done', output: '', startedAt: 0, step: 1 };
}

describe('buildBadgeSummary（⎿ ⚙ N · ⏵ Ns · ⛁ name×N）', () => {
  it('聚合工具数 / thinking 秒数 / 直方图（保持首次出现顺序）', () => {
    const details: DetailItem[] = [th(2), th(2), tool('fuzz', 'a'), tool('fuzz', 'b'), tool('env_exec', 'c')];
    const b = buildBadgeSummary(details);
    expect(b.toolCount).toBe(3);
    expect(b.thinkingSeconds).toBe(4);
    expect(b.histogram).toEqual([
      { name: 'fuzz', count: 2 },
      { name: 'env_exec', count: 1 },
    ]);
  });

  it('空细节归零', () => {
    const b = buildBadgeSummary([]);
    expect(b.toolCount).toBe(0);
    expect(b.thinkingSeconds).toBe(0);
    expect(b.histogram).toEqual([]);
  });

  it('流式 thinking 不计秒数', () => {
    expect(thinkingTotalSeconds([th(undefined, true)])).toBe(0);
  });
});

describe('toolStepChar', () => {
  it('1-10 用圈字符，超出回落数字', () => {
    expect(toolStepChar(1)).toBe('①');
    expect(toolStepChar(10)).toBe('⑩');
    expect(toolStepChar(11)).toBe('11');
  });
});

describe('summarizeSignal', () => {
  it('flag 命中', () => {
    expect(summarizeSignal('env_exec', 'flag{d0n7}')).toBe('flag 已读取');
  });
  it('SIGSEGV + 地址（失败路径）', () => {
    expect(summarizeSignal('env_exec', 'SIGSEGV at 0x41414141', { exitCode: 1 })).toBe(
      'SIGSEGV at 0x41414141',
    );
  });
  it('失败 exit 码', () => {
    expect(summarizeSignal('env_exec', 'boom', { exitCode: 1 })).toBe('exit=1');
  });
  it('CVE 命中', () => {
    expect(summarizeSignal('intel_search', 'CVE-2024-23334 受影响')).toBe('CVE 命中');
  });
  it('env_exec 成功无特征 → exit=0', () => {
    expect(summarizeSignal('env_exec', 'ok')).toBe('exit=0');
  });
});
