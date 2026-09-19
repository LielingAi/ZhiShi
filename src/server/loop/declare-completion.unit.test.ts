/**
 * loop/declare-completion.ts 单测(1.4.1 / 1.7.7)— 达成声明注册表 +
 * declare_completion 工具 + 达成证据预检(B-2)。覆盖:登记/take 即消费、
 * evidenceRefs 归一化(数字/字符串,去重/非法拒绝)、工具 execute 的声明落桶
 * 与「预检不过回注继续」返回文本、预检纯函数(OR 条件命中 + 证据存在性)。
 * 全内存,绝不触网/不触真库。
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
  precheckCompletionDeclaration,
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
    declareCompletion('ls-1', '拿到 flag,复现 3 次', ['输出 flag'], [1, 2]);
    const d = takeCompletionDeclaration('ls-1');
    expect(d).not.toBeNull();
    expect(d?.statement).toBe('拿到 flag,复现 3 次');
    expect(d?.criteria).toEqual(['输出 flag']);
    expect(d?.evidenceRefs).toEqual([1, 2]);
    expect(takeCompletionDeclaration('ls-1')).toBeNull();
  });

  it('不同线互不串桶;criteria 可空(交互模式声明无消费方,登记语义照旧)', () => {
    declareCompletion('ls-1', 'a', [], []);
    expect(takeCompletionDeclaration('ls-2')).toBeNull();
    const d = takeCompletionDeclaration('ls-1');
    expect(d?.statement).toBe('a');
    expect(d?.criteria).toEqual([]);
  });

  it('同线重复声明覆盖为最新', () => {
    declareCompletion('ls-1', 'first', ['c1'], [1]);
    declareCompletion('ls-1', 'second', ['c2'], [1, 'H#1']);
    const d = takeCompletionDeclaration('ls-1');
    expect(d?.statement).toBe('second');
    expect(d?.criteria).toEqual(['c2']);
    expect(d?.evidenceRefs).toEqual([1, 'H#1']);
  });
});

describe('parseEvidenceRefs(参数归一化)', () => {
  it('undefined/null → 空数组;数字与字符串混合去重保序', () => {
    expect(parseEvidenceRefs(undefined)).toEqual([]);
    expect(parseEvidenceRefs(null)).toEqual([]);
    expect(parseEvidenceRefs([3, 1, 3, 2])).toEqual([3, 1, 2]);
    expect(parseEvidenceRefs([3, 'H#1', 'H#1', ' V#2 '])).toEqual([3, 'H#1', 'V#2']);
  });

  it('非法编号(非整数/≤0/空串/非数组)抛错', () => {
    expect(() => parseEvidenceRefs('3')).toThrow(/evidenceRefs/);
    expect(() => parseEvidenceRefs([1.5])).toThrow(/非法编号/);
    expect(() => parseEvidenceRefs([0])).toThrow(/非法编号/);
    expect(() => parseEvidenceRefs([-2])).toThrow(/非法编号/);
    expect(() => parseEvidenceRefs(['  '])).toThrow(/空字符串/);
    expect(() => parseEvidenceRefs([{}])).toThrow(/非法引用/);
  });
});

describe('createDeclareCompletionTool(工具)', () => {
  it('execute 登记声明到归属线并返回预检语义文本', async () => {
    const tool = createDeclareCompletionTool({ getSessionId: () => 'ls-run-1' });
    expect(tool.name).toBe(DECLARE_COMPLETION_TOOL_NAME);
    const result = await tool.execute('tc-1', {
      statement: '验收条件 1 已达成,证据 #3/#5',
      criteria: ['验收条件 1'],
      evidenceRefs: [3, 5],
    } as never);
    expect(textOf(result)).toContain('证据预检');
    expect(textOf(result)).toContain('不通过会把原因注回并继续推进');
    expect(result.details?.refCount).toBe(2);
    const d = takeCompletionDeclaration('ls-run-1');
    expect(d?.statement).toBe('验收条件 1 已达成,证据 #3/#5');
    expect(d?.criteria).toEqual(['验收条件 1']);
    expect(d?.evidenceRefs).toEqual([3, 5]);
  });

  it('缺 statement 抛错(工具错误语义);criteria 缺省为空数组', async () => {
    const tool = createDeclareCompletionTool({ getSessionId: () => 'ls-run-1' });
    await expect(tool.execute('tc-1', { statement: '  ' } as never)).rejects.toThrow(/statement/);
    await tool.execute('tc-2', { statement: '达成' } as never);
    expect(takeCompletionDeclaration('ls-run-1')?.criteria).toEqual([]);
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

// ===== 1.7.7 B-2:达成证据预检(纯函数,runner 消费) =====

const LOCKED = ['输出 flag{…}', 'PoC 稳定复现 3 次'];
const noArchive = () => null;

function precheck(
  declaration: { criteria: string[]; evidenceRefs: Array<number | string> },
  overrides: Partial<Parameters<typeof precheckCompletionDeclaration>[2]> = {},
) {
  return precheckCompletionDeclaration(
    declaration,
    LOCKED,
    {
      resolveEvent: (id) => (id === 1 ? { id: 1 } : null),
      loadArchive: () => ({ entities: [{ id: 'H#1' }, { id: 'V#2' }] }),
      ...overrides,
    },
    'ls-pre',
  );
}

describe('precheckCompletionDeclaration(OR 条件命中 + 证据存在性)', () => {
  it('条件精确匹配 + 事件证据存在 → ok(任一条件命中即达成)', () => {
    expect(precheck({ criteria: ['输出 flag{…}'], evidenceRefs: [1] }).ok).toBe(true);
    expect(precheck({ criteria: ['PoC 稳定复现 3 次'], evidenceRefs: [1] }).ok).toBe(true);
  });

  it('条件包含匹配(声称文本包含锁定原文)→ ok', () => {
    expect(precheck({ criteria: ['已达成「输出 flag{…}」这条'], evidenceRefs: [1] }).ok).toBe(true);
  });

  it('档案实体引用(H#1)存在 → ok;与事件引用混合同口径', () => {
    expect(precheck({ criteria: ['输出 flag{…}'], evidenceRefs: ['H#1'] }).ok).toBe(true);
    expect(precheck({ criteria: ['输出 flag{…}'], evidenceRefs: [999, 'V#2'] }).ok).toBe(true);
  });

  it('criteria 为空 → 失败原因「宣称未对应任何验收条件」', () => {
    const r = precheck({ criteria: [], evidenceRefs: [1] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('宣称未对应任何验收条件');
  });

  it('宣称条件未匹配任何锁定条件 → 失败,带未匹配原文', () => {
    const r = precheck({ criteria: ['不存在的条件'], evidenceRefs: [1] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('宣称未对应任何验收条件');
      expect(r.error).toContain('不存在的条件');
    }
    // 多条中只要有一条未匹配即拒绝(预检不过 → 回注继续,模型下一轮重declare)。
    const mixed = precheck({ criteria: ['输出 flag{…}', '幽灵条件'], evidenceRefs: [1] });
    expect(mixed.ok).toBe(false);
  });

  it('证据引用全部不存在 → 失败,给可操作原因', () => {
    const r = precheck({ criteria: ['输出 flag{…}'], evidenceRefs: [999] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('证据引用全部不存在');
      expect(r.error).toContain('E#N');
    }
    const empty = precheck({ criteria: ['输出 flag{…}'], evidenceRefs: [] });
    expect(empty.ok).toBe(false);
  });

  it('注入假表:事件查无 / 档案缺失按不存在处理(容错不炸)', () => {
    const r = precheck(
      { criteria: ['输出 flag{…}'], evidenceRefs: ['H#9', 2] },
      { resolveEvent: () => null, loadArchive: noArchive },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('证据引用全部不存在');
  });
});
