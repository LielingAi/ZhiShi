/**
 * auto loop GUI 纯函数层单测（1.4.1）：表单校验 / 预算解析与格式化 /
 * 验收包构造 / 事件归约 / list 恢复。口径照 model/*.test.ts 惯例——纯函数
 * 逐分支断言，不 import store / React / client。
 */

import { describe, expect, it } from 'vitest';

import {
  autoRunEntryOf,
  turnProgressOf,
  parseVerdictPackage,
  activeAutoRunOf,
  applyAutoRunEvent,
  autoRunEntryAfterVerdictResponse,
  budgetKindOf,
  budgetUsedPct,
  buildAutoRunStartPayload,
  DEFAULT_BUDGET_LIMITS,
  formatBudget,
  formatMinutes,
  formatTokens,
  isAutoRunActive,
  optimisticAutoRunEntry,
  parseAutoRunList,
  parseBudgetLimit,
  parseVerdictRequest,
  pauseReasonOf,
  restoredAutoRunStale,
  validateAutoRunForm,
  verdictModalOpen,
  isVerdictConsumedError,
  type AutoRunEntry,
  type AutoRunFormView,
} from './auto-run';

const ENVS = [{ id: 'pwn-vm' }, { id: 'fuzz-vm' }];

function form(over: Partial<AutoRunFormView> = {}): AutoRunFormView {
  return {
    name: '拿 flag',
    envKey: 'pwn-vm',
    goal: '拿到目标机 flag',
    budgetKind: 'turns',
    budgetLimit: '50',
    criteria: ['输出 flag{…}'],
    ...over,
  };
}

function entry(over: Partial<AutoRunEntry> = {}): AutoRunEntry {
  return {
    id: 'ar-1',
    name: '拿 flag',
    envKey: 'pwn-vm',
    goal: '拿到目标机 flag',
    budget: { kind: 'turns', limit: 50 },
    used: 0,
    criteria: ['输出 flag{…}'],
    status: 'running',
    updatedAt: 100,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 表单校验
// ---------------------------------------------------------------------------

describe('validateAutoRunForm', () => {
  it('全字段齐 → 无错误', () => {
    expect(validateAutoRunForm(form(), ENVS)).toEqual([]);
  });

  it('任务名 / 目标 / 环境必填', () => {
    expect(validateAutoRunForm(form({ name: '  ' }), ENVS)).toContainEqual({
      field: 'name',
      message: '任务名必填',
    });
    expect(validateAutoRunForm(form({ goal: '' }), ENVS)).toContainEqual({
      field: 'goal',
      message: '目标必填（驱动循环的锚）',
    });
    expect(validateAutoRunForm(form({ envKey: '' }), ENVS)).toContainEqual({
      field: 'envKey',
      message: '当前未选环境——先在侧栏选择环境（一切操作都在环境内）',
    });
  });

  it('环境锁定当前环境（1.4.1 用户拍板）：不再校验登记列表命中', () => {
    expect(validateAutoRunForm(form({ envKey: 'ghost' }), ENVS)).toEqual([]);
  });

  it('预算非法（0/负数/小数/空/非数字）→ 报错', () => {
    for (const budgetLimit of ['0', '-3', '1.5', '', 'abc', '12abc']) {
      expect(validateAutoRunForm(form({ budgetLimit }), ENVS)).toContainEqual({
        field: 'budgetLimit',
        message: '预算须为正整数',
      });
    }
    expect(validateAutoRunForm(form({ budgetLimit: '50' }), ENVS)).toEqual([]);
  });

  it('验收条件：全空/纯空白 → 报错；空白行过滤后仍有效', () => {
    expect(validateAutoRunForm(form({ criteria: [] }), ENVS)).toContainEqual({
      field: 'criteria',
      message: '验收条件至少一条（每条一条可验证陈述）',
    });
    expect(validateAutoRunForm(form({ criteria: ['  '] }), ENVS)).toContainEqual({
      field: 'criteria',
      message: '验收条件至少一条（每条一条可验证陈述）',
    });
    expect(validateAutoRunForm(form({ criteria: ['  ', 'PoC 复现'] }), ENVS)).toEqual([]);
  });
});

describe('parseBudgetLimit / buildAutoRunStartPayload', () => {
  it('正整数解析；非法回落 null', () => {
    expect(parseBudgetLimit('50')).toBe(50);
    expect(parseBudgetLimit(' 8000000 ')).toBe(8_000_000);
    expect(parseBudgetLimit('0')).toBeNull();
    expect(parseBudgetLimit('-1')).toBeNull();
    expect(parseBudgetLimit('1.5')).toBeNull();
    expect(parseBudgetLimit('')).toBeNull();
    expect(parseBudgetLimit('NaN')).toBeNull();
  });

  it('payload 构造：trim + 过滤空白条件（快照/报告由服务端无条件执行，不进载荷）', () => {
    const p = buildAutoRunStartPayload(
      form({ name: ' 拿 flag ', criteria: [' 输出 flag ', '   ', '复现 3 次'] }),
    );
    expect(p).toEqual({
      name: '拿 flag',
      envKey: 'pwn-vm',
      goal: '拿到目标机 flag',
      budget: { kind: 'turns', limit: 50 },
      criteria: ['输出 flag', '复现 3 次'],
    });
  });

  it('校验不过 → null（不发请求）', () => {
    expect(buildAutoRunStartPayload(form({ budgetLimit: 'x' }))).toBeNull();
    expect(buildAutoRunStartPayload(form({ criteria: [' '] }))).toBeNull();
    expect(buildAutoRunStartPayload(form({ envKey: '' }))).toBeNull();
  });
});

describe('optimisticAutoRunEntry', () => {
  it('start 响应后乐观条目：status starting、used 0、字段同表单', () => {
    const p = buildAutoRunStartPayload(form())!;
    expect(optimisticAutoRunEntry('ar-9', p, 42)).toEqual({
      id: 'ar-9',
      name: '拿 flag',
      envKey: 'pwn-vm',
      goal: '拿到目标机 flag',
      budget: { kind: 'turns', limit: 50 },
      used: 0,
      criteria: ['输出 flag{…}'],
      status: 'starting',
      updatedAt: 42,
    });
  });
});

// ---------------------------------------------------------------------------
// 预算格式化
// ---------------------------------------------------------------------------

describe('formatTokens / formatMinutes / formatBudget / budgetUsedPct', () => {
  it('tokens 缩写（M/K/原文）', () => {
    expect(formatTokens(8_000_000)).toBe('8M');
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(800_000)).toBe('800K');
    expect(formatTokens(999)).toBe('999');
  });

  it('分钟缩写（<60 → 分；>=60 → 小时）', () => {
    expect(formatMinutes(35)).toBe('35 分');
    expect(formatMinutes(120)).toBe('2 小时');
    expect(formatMinutes(90)).toBe('1 小时 30 分');
  });

  it('formatBudget 按 kind 口径', () => {
    expect(formatBudget('turns', 12, 50)).toBe('12 / 50 轮');
    expect(formatBudget('tokens', 4_000_000, 8_000_000)).toBe('4M / 8M tokens');
    expect(formatBudget('time', 35, 120)).toBe('35 分 / 2 小时');
  });

  it('budgetUsedPct 钳制 0-100，limit<=0 回落 0', () => {
    expect(budgetUsedPct(45, 50)).toBe(90);
    expect(budgetUsedPct(60, 50)).toBe(100);
    expect(budgetUsedPct(-1, 50)).toBe(0);
    expect(budgetUsedPct(5, 0)).toBe(0);
    expect(budgetUsedPct(0, 50)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 验收包解析
// ---------------------------------------------------------------------------

describe('parseVerdictRequest', () => {
  it('字符串 criteria → 无证据标记；evidence 字符串 → statement', () => {
    expect(
      parseVerdictRequest({ criteria: ['a', ' b '], evidence: '陈述' }),
    ).toEqual({
      criteria: [
        { text: 'a', hasEvidence: false, refs: [] },
        { text: 'b', hasEvidence: false, refs: [] },
      ],
      statement: '陈述',
    });
  });

  it('对象 criteria（text/refs/hasEvidence）与 evidence.statement', () => {
    expect(
      parseVerdictRequest({
        criteria: [{ text: 'PoC', refs: ['E#7'], hasEvidence: true }],
        evidence: { statement: 'E#7 支撑' },
      }),
    ).toEqual({
      criteria: [{ text: 'PoC', hasEvidence: true, refs: ['E#7'] }],
      statement: 'E#7 支撑',
    });
  });

  it('refs 非空即视为有证据（hasEvidence 缺省）', () => {
    const v = parseVerdictRequest({ criteria: [{ text: 'x', refs: ['E#1'] }] });
    expect(v.criteria[0]).toEqual({ text: 'x', hasEvidence: true, refs: ['E#1'] });
  });

  it('空/畸形 payload 不炸', () => {
    expect(parseVerdictRequest(null)).toEqual({ criteria: [], statement: '' });
    expect(parseVerdictRequest({ criteria: 'nope', evidence: 42 })).toEqual({
      criteria: [],
      statement: '',
    });
  });
});

// ---------------------------------------------------------------------------
// 事件归约
// ---------------------------------------------------------------------------

describe('applyAutoRunEvent', () => {
  it('started：无条目 → 新建（status running）', () => {
    expect(
      applyAutoRunEvent(null, {
        kind: 'started',
        id: 'ar-1',
        name: '拿 flag',
        envKey: 'pwn-vm',
        goal: 'g',
        budget: { kind: 'turns', limit: 50 },
        criteria: ['c'],
      }, 7),
    ).toMatchObject({ id: 'ar-1', status: 'running', used: 0, updatedAt: 7 });
  });

  it('1.5.13：started 带 loopSessionId——新条目与既有条目都拿到线（观察流轮询依赖）', () => {
    // 新条目：事件建条目时带线
    const fresh = applyAutoRunEvent(null, {
      kind: 'started',
      id: 'ar-9',
      name: 'n',
      envKey: 'pwn-vm',
      goal: 'g',
      budget: { kind: 'turns', limit: 10 },
      criteria: [],
      loopSessionId: 'loop-9',
    }, 1);
    expect(fresh?.loopSessionId).toBe('loop-9');
    // 既有乐观条目缺线（旧回包形态）→ started 事件补线
    const optimistic = autoRunEntryOf({ id: 'ar-9', status: 'starting' })!;
    expect(optimistic.loopSessionId).toBeUndefined();
    const patched = applyAutoRunEvent(optimistic, {
      kind: 'started',
      id: 'ar-9',
      name: 'n',
      envKey: 'pwn-vm',
      goal: 'g',
      budget: { kind: 'turns', limit: 10 },
      criteria: [],
      loopSessionId: 'loop-9',
    }, 2);
    expect(patched?.loopSessionId).toBe('loop-9');
    // 已有线不被覆盖（本地为准）
    const kept = applyAutoRunEvent({ ...patched!, loopSessionId: 'loop-keep' }, {
      kind: 'started',
      id: 'ar-9',
      name: 'n',
      envKey: 'pwn-vm',
      goal: 'g',
      budget: { kind: 'turns', limit: 10 },
      criteria: [],
      loopSessionId: 'loop-9',
    }, 3);
    expect(kept?.loopSessionId).toBe('loop-keep');
  });

  it('started：已有同 id（乐观条目）→ 只翻 running，字段以本地为准', () => {
    const local = entry({ status: 'starting', budget: { kind: 'time', limit: 120 } });
    const next = applyAutoRunEvent(local, {
      kind: 'started',
      id: 'ar-1',
      name: '',
      envKey: '',
      goal: '',
      budget: { kind: 'turns', limit: 0 },
      criteria: [],
    }, 9);
    expect(next).toMatchObject({
      status: 'running',
      name: '拿 flag',
      budget: { kind: 'time', limit: 120 },
      updatedAt: 9,
    });
  });

  it('phase/turn：starting 转正 running；turn 字段可选更新', () => {
    let e = applyAutoRunEvent(entry({ status: 'starting' }), {
      kind: 'phase',
      id: 'ar-1',
      phase: '侦察',
    }, 1);
    expect(e).toMatchObject({ status: 'running', phase: '侦察' });
    e = applyAutoRunEvent(e, {
      kind: 'turn',
      id: 'ar-1',
      turnCount: 3,
      used: 12,
      conclusion: '发现 X',
    }, 2);
    expect(e).toMatchObject({ turnCount: 3, used: 12, lastConclusion: '发现 X' });
    // 空 conclusion 不覆盖已有结论行
    e = applyAutoRunEvent(e, { kind: 'turn', id: 'ar-1', turnCount: 4 }, 3);
    expect(e).toMatchObject({ turnCount: 4, lastConclusion: '发现 X' });
  });

  it('paused：写 paused + 状态；budget-warning：更新 used/limit', () => {
    let e = applyAutoRunEvent(entry(), {
      kind: 'paused',
      id: 'ar-1',
      reason: 'budget',
      summary: '耗尽',
    }, 1);
    expect(e).toMatchObject({
      status: 'paused',
      paused: { reason: 'budget', summary: '耗尽' },
    });
    e = applyAutoRunEvent(e, { kind: 'budget', id: 'ar-1', used: 50, limit: 80 }, 2);
    expect(e).toMatchObject({ used: 50, budget: { kind: 'turns', limit: 80 } });
  });

  it('verdict：awaiting-verdict + 验收包；completed：completed + summary', () => {
    let e = applyAutoRunEvent(entry(), {
      kind: 'verdict',
      id: 'ar-1',
      verdict: { criteria: [], statement: 's' },
    }, 1);
    expect(e).toMatchObject({
      status: 'awaiting-verdict',
      verdict: { criteria: [], statement: 's' },
    });
    e = applyAutoRunEvent(e, { kind: 'completed', id: 'ar-1', summary: '达成' }, 2);
    expect(e).toMatchObject({ status: 'completed', lastConclusion: '达成' });
  });

  it('id 不匹配 → 原样返回（旧 loop 残影不落）', () => {
    const e = entry();
    expect(applyAutoRunEvent(e, { kind: 'phase', id: 'ar-2', phase: 'x' }, 1)).toBe(e);
    expect(applyAutoRunEvent(e, { kind: 'completed', id: 'ar-2' }, 1)).toBe(e);
  });

  it('entry 为空且非 started → null（乱序事件丢弃，等 list 恢复）', () => {
    expect(applyAutoRunEvent(null, { kind: 'turn', id: 'ar-1' }, 1)).toBeNull();
    expect(applyAutoRunEvent(null, { kind: 'completed', id: 'ar-1' }, 1)).toBeNull();
  });
});

describe('isAutoRunActive', () => {
  it('活跃四态锁定；completed/stopped/null 解锁', () => {
    for (const status of ['starting', 'running', 'paused', 'awaiting-verdict'] as const) {
      expect(isAutoRunActive(entry({ status }))).toBe(true);
    }
    expect(isAutoRunActive(entry({ status: 'completed' }))).toBe(false);
    expect(isAutoRunActive(entry({ status: 'stopped' }))).toBe(false);
    expect(isAutoRunActive(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 窄化 / list 解析
// ---------------------------------------------------------------------------

describe('budgetKindOf / pauseReasonOf', () => {
  it('budget kind 窄化（非法回落 turns）', () => {
    expect(budgetKindOf('turns')).toBe('turns');
    expect(budgetKindOf('tokens')).toBe('tokens');
    expect(budgetKindOf('time')).toBe('time');
    expect(budgetKindOf('weeks')).toBe('turns');
    expect(budgetKindOf(null)).toBe('turns');
  });

  it('pause reason 窄化（非法 → null；1.5.13 含 provider-error；1.6.0 含 decision）', () => {
    expect(pauseReasonOf('stall')).toBe('stall');
    expect(pauseReasonOf('repeated-failures')).toBe('repeated-failures');
    expect(pauseReasonOf('budget')).toBe('budget');
    expect(pauseReasonOf('provider-error')).toBe('provider-error');
    // 1.6.0：'decision'（模型 request_decision 提请的暂停点）补齐——此前
    // 窄化丢弃，SSE auto-run:paused{reason:'decision'} 与恢复路径双双不可见。
    expect(pauseReasonOf('decision')).toBe('decision');
    expect(pauseReasonOf('x')).toBeNull();
    expect(pauseReasonOf(undefined)).toBeNull();
  });
});

describe('parseAutoRunList / activeAutoRunOf', () => {
  // 1.6.0：fixture 改用服务端真实 wire 形状（serializeAutoRunRecord 输出形态——
  // 扁平 pauseReason 字符串 + ISO updatedAt），不再用旧 GUI 形态 p.paused{}。
  const row = {
    id: 'ar-1',
    name: '拿 flag',
    envKey: 'pwn-vm',
    goal: 'g',
    budget: { kind: 'turns', limit: 50, spent: 5 },
    criteria: ['c'],
    status: 'paused',
    phase: '分析',
    pauseReason: 'budget',
    updatedAt: '2026-09-01T01:00:00.000Z',
  };

  it('{data:{runs:[…]}} 形状 → 条目数组（paused/phase 恢复）', () => {
    const list = parseAutoRunList({ data: { runs: [row] } });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'ar-1',
      status: 'paused',
      phase: '分析',
      paused: { reason: 'budget' },
      used: 5,
      updatedAt: Date.parse('2026-09-01T01:00:00.000Z'),
    });
  });

  it('裸数组 / {runs:[…]} 形状同样可解析', () => {
    expect(parseAutoRunList([row])).toHaveLength(1);
    expect(parseAutoRunList({ runs: [row] })).toHaveLength(1);
  });

  it('非法条目（缺 id/status）丢弃；活跃条目选取', () => {
    const list = parseAutoRunList({
      data: { runs: [row, { id: 'ar-2', status: 'completed' }, { status: 'running' }, 'junk'] },
    });
    expect(list).toHaveLength(2);
    expect(activeAutoRunOf({ data: { runs: [row] } })?.id).toBe('ar-1');
    expect(activeAutoRunOf({ data: { runs: [{ id: 'ar-2', status: 'completed' }] } })).toBeNull();
    expect(activeAutoRunOf('nope')).toBeNull();
  });

  it('旧 GUI 形态 p.paused{reason,summary} 兼容保留（1.6.0 双形）', () => {
    const list = parseAutoRunList({
      data: { runs: [{ ...row, pauseReason: undefined, paused: { reason: 'budget', summary: '耗尽' } }] },
    });
    expect(list[0].paused).toEqual({ reason: 'budget', summary: '耗尽' });
  });

  it('verdict 字段在 list 条目中恢复', () => {
    const list = parseAutoRunList({
      data: {
        runs: [
          {
            id: 'ar-3',
            status: 'awaiting-verdict',
            verdict: { criteria: [{ text: 'x', refs: ['E#1'] }], evidence: 's' },
          },
        ],
      },
    });
    expect(list[0]).toMatchObject({
      id: 'ar-3',
      status: 'awaiting-verdict',
      verdict: {
        criteria: [{ text: 'x', hasEvidence: true, refs: ['E#1'] }],
        statement: 's',
      },
    });
    expect(activeAutoRunOf({ data: { runs: list } })?.id).toBe('ar-3');
  });
});

describe('DEFAULT_BUDGET_LIMITS', () => {
  it('默认保守档：50 轮 / 8M tokens / 2 小时', () => {
    expect(DEFAULT_BUDGET_LIMITS).toEqual({ turns: 50, tokens: 8_000_000, time: 120 });
  });
});

describe('parseVerdictPackage（1.4.6 dogfood 实证：断线后终审弹窗从 list 恢复）', () => {
  const pkg = {
    statement: '全部验收条件达成，证据齐全。',
    evidenceRefs: [10, 11],
    hitCount: 2,
    missCount: 0,
    criteriaPrecheck: [
      { text: '条件一：攻击面枚举完成', status: 'evidence' },
      { text: '条件二：每候选有证据', status: 'evidence' },
      { text: '条件三：fuzz 实跑', status: 'missing' },
    ],
  };

  it('verdictPackage 形状 → VerdictRequest（criteriaPrecheck.status → hasEvidence）', () => {
    const v = parseVerdictPackage(pkg)!;
    expect(v.statement).toContain('验收条件达成');
    expect(v.criteria).toHaveLength(3);
    expect(v.criteria[0]).toMatchObject({ text: '条件一：攻击面枚举完成', hasEvidence: true });
    expect(v.criteria[2].hasEvidence).toBe(false);
  });

  it('autoRunEntryOf：verdictPackage 恢复（缺 criteriaPrecheck → undefined；空文本行丢弃）', () => {
    const entry = autoRunEntryOf({ id: 'ar-1', status: 'awaiting-verdict', verdictPackage: pkg, loopSessionId: 'ls-1' });
    expect(entry?.verdict?.criteria).toHaveLength(3);
    expect(entry?.loopSessionId).toBe('ls-1');
    expect(autoRunEntryOf({ id: 'ar-2', status: 'awaiting-verdict', verdictPackage: { statement: 'x' } })?.verdict).toBeUndefined();
    expect(autoRunEntryOf({ id: 'ar-3', status: 'awaiting-verdict', verdictPackage: { criteriaPrecheck: [{ text: '  ', status: 'evidence' }] } })?.verdict).toBeUndefined();
  });

  it('verdict 优先于 verdictPackage（SSE 形状在场时走 SSE 解析）', () => {
    const entry = autoRunEntryOf({
      id: 'ar-1', status: 'awaiting-verdict',
      verdict: { criteria: [{ text: 'SSE 条件', hasEvidence: true }], evidence: { statement: 'SSE 陈述' } },
      verdictPackage: pkg,
    });
    expect(entry?.verdict?.statement).toBe('SSE 陈述');
  });
});

describe('parseAutoRunList — 服务端真实形状（1.4.6 dogfood 实证）', () => {
  it('{success:true, data:{records:[…]}} → 条目恢复（records 键）', () => {
    const list = parseAutoRunList({
      success: true,
      data: {
        records: [{
          id: 'ar-1', name: 'n', envKey: 'pwn-vm', goal: 'g',
          budget: { kind: 'turns', limit: 40, spent: 1 },
          criteria: ['c1'], status: 'awaiting-verdict',
          loopSessionId: 'ls-1',
          verdictPackage: { statement: 's', criteriaPrecheck: [{ text: 'c1', status: 'evidence' }] },
        }],
      },
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'ar-1', status: 'awaiting-verdict', loopSessionId: 'ls-1' });
    expect(list[0].verdict?.criteria[0].hasEvidence).toBe(true);
    expect(activeAutoRunOf({ success: true, data: { records: [{ id: 'ar-1', status: 'awaiting-verdict' }] } })?.id).toBe('ar-1');
  });
});

describe('autoRunEntryOf — 预算恢复（1.4.6 走查实证）', () => {
  it('记录存 budget.spent → entry.used 恢复正确（不再恒 0）', () => {
    const entry = autoRunEntryOf({
      id: 'run-1', status: 'awaiting-verdict',
      budget: { kind: 'turns', limit: 40, spent: 1 },
    });
    expect(entry?.used).toBe(1);
    expect(entry?.budget).toEqual({ kind: 'turns', limit: 40 });
  });
});

describe('turnProgressOf（1.4.7 观察卡轮内进度）', () => {
  it('running → 当前轮号 = turnCount+1，耗时 = now − updatedAt', () => {
    const e = autoRunEntryOf({ id: 'r', status: 'running', turnCount: 3, updatedAt: 10_000 });
    expect(turnProgressOf(e!, 16_000)).toEqual({ turn: 4, elapsedSec: 6 });
  });

  it('非 running（paused/awaiting-verdict/completed）→ null（不显示）；turnCount 缺省按 0', () => {
    const paused = autoRunEntryOf({ id: 'r', status: 'paused', updatedAt: 0, paused: { reason: 'budget' } });
    expect(turnProgressOf(paused!)).toBeNull();
    const fresh = autoRunEntryOf({ id: 'r', status: 'running', updatedAt: 1000 });
    expect(turnProgressOf(fresh!, 2500)).toEqual({ turn: 1, elapsedSec: 2 });
  });
});

describe('verdictModalOpen（A3-2：Esc 链与终审弹窗渲染同一口径）', () => {
  const awaiting = autoRunEntryOf({
    id: 'ar-1', status: 'awaiting-verdict',
    verdict: { criteria: [{ text: 'c1', hasEvidence: true }], evidence: 's' },
  })!;

  it('verdict 存在 + 未收起 + awaiting-verdict → 开', () => {
    expect(verdictModalOpen(awaiting, false)).toBe(true);
  });

  it('已收起 → 关（观察卡「待终审」可重开）', () => {
    expect(verdictModalOpen(awaiting, true)).toBe(false);
  });

  it('孤儿记录（status 非 awaiting-verdict，verdict 残留）→ 关——Esc 不再被静默吞', () => {
    const orphan = { ...awaiting, status: 'stopped' as const };
    expect(verdictModalOpen(orphan, false)).toBe(false);
  });

  it('无 loop / 无 verdict → 关', () => {
    expect(verdictModalOpen(null, false)).toBe(false);
    expect(verdictModalOpen(autoRunEntryOf({ id: 'ar-2', status: 'running' })!, false)).toBe(false);
  });
});

describe('isVerdictConsumedError（1.5.13：终审已被消费的错误形态 → 关窗重新对齐）', () => {
  it('「仅 awaiting-verdict 态可终审」/「终审已作答」→ true（消费态）', () => {
    expect(isVerdictConsumedError('仅 awaiting-verdict 态可终审(auto-run/verdict)')).toBe(true);
    expect(isVerdictConsumedError('终审已作答(幂等:重复 respond 不重复处理)')).toBe(true);
  });

  it('其他错误（网络/未知/缺参）→ false（不关窗，保留人重试）', () => {
    expect(isVerdictConsumedError(undefined)).toBe(false);
    expect(isVerdictConsumedError('未连接 sidecar')).toBe(false);
    expect(isVerdictConsumedError('run "x" 不存在')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 1.6.0 全链路审查回归（G 面：② live 证据预检 / ① fail 语义 / ③ paused 形状 /
// ④ ISO updatedAt + stale 守卫 / ⑤ resumed / ⑥ 终态不复活）
// ---------------------------------------------------------------------------

describe('parseVerdictRequest — criteriaPrecheck live 接线（1.6.0 ②）', () => {
  it('live 真实 wire（criteria 字符串数组 + criteriaPrecheck + evidence.refs）→ 逐条 ✓/✗ 正确', () => {
    // 服务端 auto-run:verdict-requested 广播实况（server/loop/auto-run.ts）。
    const v = parseVerdictRequest({
      id: 'ar-1',
      criteria: ['条件一', '条件二', '条件三'],
      criteriaPrecheck: [
        { text: '条件一', status: 'evidence' },
        { text: '条件二', status: 'partial' },
        { text: '条件三', status: 'none' },
      ],
      evidence: {
        statement: 'E#1/E#2 支撑条件一',
        refs: [
          { id: 1, hit: true, summary: 's1' },
          { id: 2, hit: true },
          { id: 3, hit: false },
        ],
        hitCount: 2,
        missCount: 1,
      },
    });
    expect(v.statement).toBe('E#1/E#2 支撑条件一');
    // evidence / partial → ✓（hasEvidence）；none → ✗；命中引用 E#N 挂有证据条件。
    expect(v.criteria).toEqual([
      { text: '条件一', hasEvidence: true, refs: ['E#1', 'E#2'] },
      { text: '条件二', hasEvidence: true, refs: ['E#1', 'E#2'] },
      { text: '条件三', hasEvidence: false, refs: [] },
    ]);
  });

  it('旧枚举 hit → hasEvidence true（与 parseVerdictPackage 同口径）；status 缺失 → false；空文本行丢弃', () => {
    const v = parseVerdictRequest({
      criteriaPrecheck: [
        { text: 'c1', status: 'hit' },
        { text: 'c2' },
        { text: '  ', status: 'evidence' },
      ],
    });
    expect(v.criteria).toEqual([
      { text: 'c1', hasEvidence: true, refs: [] },
      { text: 'c2', hasEvidence: false, refs: [] },
    ]);
  });

  it('criteriaPrecheck 空数组 → 回退 legacy criteria 解析', () => {
    const v = parseVerdictRequest({
      criteria: [{ text: 'x', refs: ['E#1'] }],
      criteriaPrecheck: [],
    });
    expect(v.criteria).toEqual([{ text: 'x', hasEvidence: true, refs: ['E#1'] }]);
  });

  it('evidence.refs 字符串数组（兼容形态）原样透传；非数组/缺 hit 防御', () => {
    const v = parseVerdictRequest({
      criteriaPrecheck: [{ text: 'c', status: 'evidence' }],
      evidence: { statement: 's', refs: ['E#7', ' E#8 '] },
    });
    expect(v.criteria[0].refs).toEqual(['E#7', 'E#8']);
    const noRefs = parseVerdictRequest({
      criteriaPrecheck: [{ text: 'c', status: 'evidence' }],
      evidence: { statement: 's', refs: [{ id: 'x' }, { id: 1, hit: false }] },
    });
    expect(noRefs.criteria[0].refs).toEqual([]);
  });
});

describe('parseVerdictPackage — partial 同口径（1.6.0 ② 恢复路径）', () => {
  it('status partial（部分命中）→ hasEvidence true（此前只认 evidence/hit，恢复路径错标 ✗）', () => {
    const v = parseVerdictPackage({
      statement: 's',
      criteriaPrecheck: [
        { text: 'c1', status: 'partial' },
        { text: 'c2', status: 'none' },
      ],
    })!;
    expect(v.criteria[0].hasEvidence).toBe(true);
    expect(v.criteria[1].hasEvidence).toBe(false);
  });
});

describe('autoRunEntryAfterVerdictResponse（1.6.0 ①：fail = 注回修正续跑）', () => {
  const awaiting = entry({
    status: 'awaiting-verdict',
    verdict: { criteria: [], statement: 's' },
  });

  it('fail → running（清 verdict/paused），不再本地翻 stopped', () => {
    const next = autoRunEntryAfterVerdictResponse(awaiting, 'fail', 42);
    expect(next).toMatchObject({ status: 'running', updatedAt: 42 });
    expect(next.verdict).toBeUndefined();
    expect(next.paused).toBeUndefined();
  });

  it('continue → running（清 verdict/paused）；pass → completed', () => {
    const cont = autoRunEntryAfterVerdictResponse(awaiting, 'continue', 42);
    expect(cont.status).toBe('running');
    expect(cont.verdict).toBeUndefined();
    const pass = autoRunEntryAfterVerdictResponse(awaiting, 'pass', 42);
    expect(pass.status).toBe('completed');
    // pass 保留 verdict 数据（completed 事件幂等复写前的展示态）。
    expect(pass.verdict).toBeDefined();
  });
});

describe('autoRunEntryOf — 服务端真实 wire 形状（1.6.0 ③④）', () => {
  // serializeAutoRunRecord 输出形态：扁平 pauseReason 字符串 + ISO 时间戳。
  const serverRecord = {
    id: 'ar-1',
    name: 'n',
    envKey: 'pwn-vm',
    goal: 'g',
    budget: { kind: 'turns', limit: 50, spent: 50 },
    criteria: ['c1'],
    status: 'paused',
    loopSessionId: 'ls-1',
    pauseReason: 'budget',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T01:00:00.000Z',
    turns: 50,
  };

  it('扁平 pauseReason=budget → paused 还原（此前只认 p.paused{}，恒丢）', () => {
    const e = autoRunEntryOf(serverRecord)!;
    expect(e.paused).toEqual({ reason: 'budget', summary: undefined });
    expect(e.updatedAt).toBe(Date.parse('2026-09-01T01:00:00.000Z'));
  });

  it('stall / provider-error / decision 扁平 pauseReason 同样还原', () => {
    for (const reason of ['stall', 'provider-error', 'decision'] as const) {
      const e = autoRunEntryOf({ ...serverRecord, pauseReason: reason })!;
      expect(e.paused?.reason).toBe(reason);
    }
  });

  it('扁平 pauseReason 优先于 p.paused 旧形；非枚举簿记值（sidecar-restart）→ 无 paused', () => {
    const e = autoRunEntryOf({
      ...serverRecord,
      pauseReason: 'stall',
      paused: { reason: 'budget', summary: '旧形' },
    })!;
    expect(e.paused?.reason).toBe('stall');
    const other = autoRunEntryOf({ ...serverRecord, pauseReason: 'sidecar-restart' })!;
    expect(other.paused).toBeUndefined();
  });

  it('updatedAt：number 双形态保留；非法/缺失回落 now（④）', () => {
    expect(autoRunEntryOf({ id: 'r', status: 'running', updatedAt: 123 })!.updatedAt).toBe(123);
    expect(autoRunEntryOf({ id: 'r', status: 'running', updatedAt: 'not-a-date' }, 999)!.updatedAt).toBe(999);
    expect(autoRunEntryOf({ id: 'r', status: 'running' }, 999)!.updatedAt).toBe(999);
  });
});

describe('restoredAutoRunStale（1.6.0 ④：stale 守卫纯函数）', () => {
  it('同 id 且本地更新 → stale（不覆盖）', () => {
    const cur = entry({ updatedAt: 200 });
    const restored = entry({ updatedAt: 100 });
    expect(restoredAutoRunStale(cur, restored)).toBe(true);
  });

  it('恢复快照更新 / 同刻 / 不同 id / 无本地或无恢复 → 不 stale', () => {
    expect(restoredAutoRunStale(entry({ updatedAt: 100 }), entry({ updatedAt: 200 }))).toBe(false);
    expect(restoredAutoRunStale(entry({ updatedAt: 100 }), entry({ updatedAt: 100 }))).toBe(false);
    expect(restoredAutoRunStale(entry({ id: 'a' }), entry({ id: 'b', updatedAt: 0 }))).toBe(false);
    expect(restoredAutoRunStale(null, entry())).toBe(false);
    expect(restoredAutoRunStale(entry(), null)).toBe(false);
  });

  it('ISO 恢复 + 本地较新 → 守卫真正生效（④ 回归：此前 ISO 恒回落 now 致守卫失效）', () => {
    const restored = autoRunEntryOf({
      id: 'ar-1',
      status: 'running',
      updatedAt: '2026-09-01T00:00:00.000Z',
    })!;
    const cur = entry({ id: 'ar-1', updatedAt: Date.parse('2026-09-01T01:00:00.000Z') });
    expect(restoredAutoRunStale(cur, restored)).toBe(true);
  });
});

describe('applyAutoRunEvent — resumed / 终态不复活（1.6.0 ⑤⑥）', () => {
  it('resumed：paused → running 清暂停点', () => {
    const pausedEntry = applyAutoRunEvent(entry(), {
      kind: 'paused',
      id: 'ar-1',
      reason: 'budget',
      summary: '耗尽',
    }, 1)!;
    const next = applyAutoRunEvent(pausedEntry, { kind: 'resumed', id: 'ar-1' }, 2)!;
    expect(next.status).toBe('running');
    expect(next.paused).toBeUndefined();
    expect(next.updatedAt).toBe(2);
  });

  it('resumed：awaiting-verdict → running 清验收包（fail/continue 续跑对齐）', () => {
    const awaiting = entry({
      status: 'awaiting-verdict',
      verdict: { criteria: [], statement: 's' },
    });
    const next = applyAutoRunEvent(awaiting, { kind: 'resumed', id: 'ar-1' }, 2)!;
    expect(next.status).toBe('running');
    expect(next.verdict).toBeUndefined();
  });

  it('resumed：completed/stopped 不复活；running 只刷 updatedAt；id 不匹配/null 原样', () => {
    const done = entry({ status: 'completed' });
    expect(applyAutoRunEvent(done, { kind: 'resumed', id: 'ar-1' }, 9)).toBe(done);
    const stopped = entry({ status: 'stopped' });
    expect(applyAutoRunEvent(stopped, { kind: 'resumed', id: 'ar-1' }, 9)).toBe(stopped);
    const running = applyAutoRunEvent(entry(), { kind: 'resumed', id: 'ar-1' }, 9)!;
    expect(running).toMatchObject({ status: 'running', updatedAt: 9 });
    const e = entry();
    expect(applyAutoRunEvent(e, { kind: 'resumed', id: 'ar-2' }, 9)).toBe(e);
    expect(applyAutoRunEvent(null, { kind: 'resumed', id: 'ar-1' }, 9)).toBeNull();
  });

  it('completed/stopped 态不复活：迟到的 paused/verdict 整条忽略（⑥）', () => {
    const done = entry({ status: 'completed' });
    expect(applyAutoRunEvent(done, { kind: 'paused', id: 'ar-1', reason: 'budget' }, 5)).toBe(done);
    expect(
      applyAutoRunEvent(done, { kind: 'verdict', id: 'ar-1', verdict: { criteria: [], statement: '' } }, 5),
    ).toBe(done);
    const stopped = entry({ status: 'stopped' });
    expect(applyAutoRunEvent(stopped, { kind: 'paused', id: 'ar-1', reason: 'stall' }, 5)).toBe(stopped);
    expect(
      applyAutoRunEvent(stopped, { kind: 'verdict', id: 'ar-1', verdict: { criteria: [], statement: '' } }, 5),
    ).toBe(stopped);
  });
});
