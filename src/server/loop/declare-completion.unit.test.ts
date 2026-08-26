/**
 * loop/declare-completion.ts 单测(1.4.1)— 达成声明注册表 + declare_completion
 * 工具。覆盖:登记/take 即消费、evidenceRefs 归一化(去重/非法拒绝)、工具
 * execute 的声明落桶与「停等终审」返回文本。全内存,绝不触网/不触真库。
 */
import { afterEach, describe, expect, it } from 'vitest';

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
