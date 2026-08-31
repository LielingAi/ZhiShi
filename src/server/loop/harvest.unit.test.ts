/**
 * harvest.unit.test.ts — 1.5.3 收割（loop/harvest.ts）单测。
 *
 * 覆盖面：段收割提取（user 原文必保 / toolResult 关键行 / assistant
 * 摘要 / 行区间映射）、指针卡文本、侧车 IO（编号递增 / 读回 / 坏行容错 /
 * 按 id 取单条）。持久层走真临时目录。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  appendHarvestEntries,
  buildPointerCard,
  harvestSegment,
  loadHarvest,
  readHarvestEntry,
} from './harvest';
import type { ContextSegment } from './context-manager';

const DIR = mkdtempSync(join(tmpdir(), 'zhishi-harvest-test-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

type SegFixture = Pick<ContextSegment, 'index' | 'phase' | 'start' | 'end' | 'toolNames'>;

function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1 } as AgentMessage;
}
function assistant(text: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], timestamp: 2 } as unknown as AgentMessage;
}
function toolResult(text: string): AgentMessage {
  return {
    role: 'toolResult', toolCallId: 't', toolName: 'env_exec',
    content: [{ type: 'text', text }], isError: false, timestamp: 3,
  } as unknown as AgentMessage;
}

describe('harvestSegment(确定性提取)', () => {
  const seg: SegFixture = { index: 3, phase: 'execution', start: 1, end: 5, toolNames: ['env_exec'] };

  it('user 原文必保 / toolResult 关键行提取 / assistant 摘要首句', () => {
    const messages = [
      user('这条不在段内'),
      user('开始复现 V11 嵌套删除'),
      assistant('结论:V11 确认是 stack-overflow。\n细节略'),
      toolResult('exit=1\nASAN stack-overflow at src/cJSON.c:261\n杂讯行'),
      toolResult('flag{test_flag}\nexit=0'),
    ];
    const e = harvestSegment(seg, messages);
    expect(e.userTexts).toEqual(['开始复现 V11 嵌套删除']);
    expect(e.keyFacts.some((l) => l.includes('exit=1'))).toBe(true);
    expect(e.keyFacts.some((l) => l.includes('flag{test_flag}'))).toBe(true);
    expect(e.keyFacts.some((l) => l.includes('杂讯行'))).toBe(false);
    expect(e.summaries[0]).toContain('结论:V11 确认是 stack-overflow');
    expect(e.tools).toEqual(['env_exec']);
  });

  it('行区间映射:消息下标 i → jsonl 行 i+2(行 1 是 meta)', () => {
    const e = harvestSegment({ ...seg, start: 1, end: 5 }, [user('a'), user('b'), user('c'), user('d'), user('e')]);
    expect(e.lineStart).toBe(3);
    expect(e.lineEnd).toBe(6);
  });

  it('段越界容错(end > messages.length 不炸)', () => {
    const e = harvestSegment({ ...seg, start: 0, end: 99 }, [user('只有一条')]);
    expect(e.userTexts).toEqual(['只有一条']);
  });
});

describe('buildPointerCard(指针卡)', () => {
  it('含段号/相位/收割引用/recall 用法', () => {
    const card = buildPointerCard(
      { index: 2, phase: 'recon', toolNames: ['env_exec'], keyHits: ['flag{x}'] },
      'K#7',
    );
    expect(card).toContain('段#2');
    expect(card).toContain('recon');
    expect(card).toContain('K#7');
    expect(card).toContain('recall');
    expect(card).toContain('flag{x}');
  });
});

describe('侧车 IO(临时目录)', () => {
  it('追加编号递增 + 读回 + 按 id 取单条', async () => {
    const sid = 'harvest-io-1';
    const first = await appendHarvestEntries(sid, [
      { segmentIndex: 1, phase: 'recon', lineStart: 3, lineEnd: 5, userTexts: [], keyFacts: ['exit=0'], summaries: [], tools: [] },
      { segmentIndex: 2, phase: 'analysis', lineStart: 6, lineEnd: 9, userTexts: ['指令'], keyFacts: [], summaries: ['摘要'], tools: ['env_exec'] },
    ], { dir: DIR });
    expect(first.map((e) => e.id)).toEqual(['K#1', 'K#2']);
    const second = await appendHarvestEntries(sid, [
      { segmentIndex: 4, phase: 'execution', lineStart: 10, lineEnd: 12, userTexts: [], keyFacts: [], summaries: [], tools: [] },
    ], { dir: DIR });
    expect(second[0].id).toBe('K#3');

    const all = loadHarvest(sid, { dir: DIR });
    expect(all).toHaveLength(3);
    expect(readHarvestEntry(sid, 'K#2', { dir: DIR })?.userTexts).toEqual(['指令']);
    expect(readHarvestEntry(sid, 'K#99', { dir: DIR })).toBeNull();
  });

  it('缺失/坏行容错:读侧返回空数组或跳过坏行', async () => {
    expect(loadHarvest('no-such-session', { dir: DIR })).toEqual([]);
    const sid = 'harvest-badline';
    await appendHarvestEntries(sid, [
      { segmentIndex: 1, phase: 'recon', lineStart: 3, lineEnd: 5, userTexts: [], keyFacts: [], summaries: [], tools: [] },
    ], { dir: DIR });
    const file = join(DIR, `${sid}.harvest.jsonl`);
    writeFileSync(file, readFileSync(file, 'utf-8') + '{bad json\n{"id":1}\n', 'utf-8');
    const all = loadHarvest(sid, { dir: DIR });
    expect(all).toHaveLength(1); // 坏行跳过,好行存活
  });
});
