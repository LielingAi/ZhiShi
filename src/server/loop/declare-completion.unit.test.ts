/**
 * loop/declare-completion.ts 单测(1.4.1)— 达成声明注册表 + declare_completion
 * 工具。覆盖:登记/take 即消费、evidenceRefs 归一化(去重/非法拒绝)、工具
 * execute 的声明落桶与「停等终审」返回文本。全内存,绝不触网/不触真库。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addHypothesis, falsifyHypothesis } from './archive';

import {
  clearCompletionDeclarations,
  createDeclareCompletionTool,
  DECLARE_COMPLETION_TOOL_NAME,
  declareCompletion,
  parseEvidenceRefs,
  takeCompletionDeclaration,
} from './declare-completion';

afterEach(() => {
  clearCompletionDeclarations();
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

describe('declareCompletion / takeCompletionDeclaration(注册表)', () => {
  it('登记后按线取走;take 即消费(同一条线只触发一次验收)', () => {
    declareCompletion('ls-1', '拿到 flag,复现 3 次', [1, 2]);
    const d = takeCompletionDeclaration('ls-1');
    expect(d).not.toBeNull();
    expect(d?.statement).toBe('拿到 flag,复现 3 次');
    expect(d?.evidenceRefs).toEqual([1, 2]);
    expect(takeCompletionDeclaration('ls-1')).toBeNull();
  });

  it('不同线互不串桶', () => {
    declareCompletion('ls-1', 'a', []);
    expect(takeCompletionDeclaration('ls-2')).toBeNull();
    expect(takeCompletionDeclaration('ls-1')?.statement).toBe('a');
  });

  it('同线重复声明覆盖为最新', () => {
    declareCompletion('ls-1', 'first', [1]);
    declareCompletion('ls-1', 'second', [1, 2]);
    const d = takeCompletionDeclaration('ls-1');
    expect(d?.statement).toBe('second');
    expect(d?.evidenceRefs).toEqual([1, 2]);
  });
});

describe('parseEvidenceRefs(参数归一化)', () => {
  it('undefined/null → 空数组;数字数组去重保序', () => {
    expect(parseEvidenceRefs(undefined)).toEqual([]);
    expect(parseEvidenceRefs(null)).toEqual([]);
    expect(parseEvidenceRefs([3, 1, 3, 2])).toEqual([3, 1, 2]);
  });

  it('非法编号(非整数/≤0/非数组)抛错', () => {
    expect(() => parseEvidenceRefs('3')).toThrow(/evidenceRefs/);
    expect(() => parseEvidenceRefs([1.5])).toThrow(/非法编号/);
    expect(() => parseEvidenceRefs([0])).toThrow(/非法编号/);
    expect(() => parseEvidenceRefs([-2])).toThrow(/非法编号/);
  });
});

describe('createDeclareCompletionTool(工具)', () => {
  it('execute 登记声明到归属线并返回停等终审指令', async () => {
    const tool = createDeclareCompletionTool({ getSessionId: () => 'ls-run-1' });
    expect(tool.name).toBe(DECLARE_COMPLETION_TOOL_NAME);
    const result = await tool.execute('tc-1', {
      statement: '验收条件 1/2 已达成,证据 #3/#5',
      evidenceRefs: [3, 5],
    } as never);
    expect(textOf(result)).toContain('等待研究员终审');
    expect(result.details?.refCount).toBe(2);
    const d = takeCompletionDeclaration('ls-run-1');
    expect(d?.statement).toBe('验收条件 1/2 已达成,证据 #3/#5');
    expect(d?.evidenceRefs).toEqual([3, 5]);
  });

  it('缺 statement 抛错(工具错误语义)', async () => {
    const tool = createDeclareCompletionTool({ getSessionId: () => 'ls-run-1' });
    await expect(tool.execute('tc-1', { statement: '  ' } as never)).rejects.toThrow(/statement/);
  });
});

describe('declare_completion — 1.4.7 证伪结案提醒（档案待验证假设）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zhishi-decl-arch-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('档案有待验证假设 → 返回带提醒（声明照常登记，提醒不阻塞）', async () => {
    await addHypothesis('ls-run-1', { text: '假设一' }, { dir });
    const tool = createDeclareCompletionTool({ getSessionId: () => 'ls-run-1', dir });
    const result = await tool.execute('tc-1', { statement: '全部达成', evidenceRefs: [1] } as never);
    expect(textOf(result)).toContain('待验证假设');
    expect(textOf(result)).toContain('H#1');
    expect(textOf(result)).toContain('falsify');
    expect(takeCompletionDeclaration('ls-run-1')?.statement).toBe('全部达成');
  });

  it('假设证伪后 → 无提醒；无档案 → 无提醒（读侧容错）', async () => {
    await addHypothesis('ls-run-2', { text: '假设一' }, { dir });
    const tool = createDeclareCompletionTool({ getSessionId: () => 'ls-run-2', dir });
    const r1 = await tool.execute('tc-1', { statement: '达成' } as never);
    expect(textOf(r1)).toContain('待验证假设');
    await falsifyHypothesis('ls-run-2', 'H#1', '实验推翻', { dir });
    const r2 = await tool.execute('tc-2', { statement: '达成' } as never);
    expect(textOf(r2)).not.toContain('待验证假设');
    // 完全不存在的线（无档案文件）→ 零注入语义，无提醒不炸。
    const tool3 = createDeclareCompletionTool({ getSessionId: () => 'ls-ghost', dir });
    const r3 = await tool3.execute('tc-3', { statement: '达成' } as never);
    expect(textOf(r3)).not.toContain('待验证假设');
  });
});
