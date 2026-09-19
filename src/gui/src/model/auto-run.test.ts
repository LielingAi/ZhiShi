/**
 * auto loop GUI 纯函数层单测（1.4.1；1.7.7 auto-redesign 收敛）：表单校验 /
 * 预算解析与格式化 / 事件归约（终态按 outcome 分派）/ list 恢复。口径照
 * model/*.test.ts 惯例——纯函数逐分支断言，不 import store / React / client。
 */

import { describe, expect, it } from 'vitest';

import {
  activeAutoRunOf,
  applyAutoRunEvent,
  autoRunEntryOf,
  autoRunTerminalText,
  budgetKindOf,
  budgetUsedPct,
  buildAutoRunStartPayload,
  formatBudget,
  formatMinutes,
  formatTokens,
  isAutoRunActive,
  optimisticAutoRunEntry,
  outcomeOf,
  parseAutoRunList,
  parseBudgetLimit,
  restoredAutoRunStale,
  turnProgressOf,
  validateAutoRunForm,
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
    stallPrompt: '',
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
  it('全字段齐 → 无错误（stallPrompt 可选不校验）', () => {
    expect(validateAutoRunForm(form(), ENVS)).toEqual([]);
    expect(validateAutoRunForm(form({ stallPrompt: '换个思路' }), ENVS)).toEqual([]);
    expect(validateAutoRunForm(form({ stallPrompt: 'off' }), ENVS)).toEqual([]);
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
    expect(parseBudgetLimit('-3')).toBeNull();
    expect(parseBudgetLimit('1.5')).toBeNull();
    expect(parseBudgetLimit('abc')).toBeNull();
    expect(parseBudgetLimit('')).toBeNull();
  });

  it('完整表单 → payload（1.7.7：无 policy；stallPrompt 空白不传）', () => {
    const payload = buildAutoRunStartPayload(form({ criteria: ['a', ' b '] }));
    expect(payload).toEqual({
      name: '拿 flag',
      envKey: 'pwn-vm',
      goal: '拿到目标机 flag',
      budget: { kind: 'turns', limit: 50 },
      criteria: ['a', 'b'],
    });
  });

  it('stallPrompt 非空 → 透传（off = 关闭常量原样传）', () => {
    expect(buildAutoRunStartPayload(form({ stallPrompt: ' 换个思路 ' }))?.stallPrompt).toBe('换个思路');
    expect(buildAutoRunStartPayload(form({ stallPrompt: 'off' }))?.stallPrompt).toBe('off');
    expect(buildAutoRunStartPayload(form({ stallPrompt: '   ' }))?.stallPrompt).toBeUndefined();
  });

  it('非法表单 → null', () => {
    expect(buildAutoRunStartPayload(form({ budgetLimit: 'x' }))).toBeNull();
    expect(buildAutoRunStartPayload(form({ name: ' ' }))).toBeNull();
    expect(buildAutoRunStartPayload(form({ criteria: [' '] }))).toBeNull();
  });
});

describe('optimisticAutoRunEntry', () => {
  it('start 回包 → starting 乐观条目；loopSessionId 透传', () => {
    const payload = buildAutoRunStartPayload(form())!;
    const e = optimisticAutoRunEntry('ar-1', payload, 1, 'ls-1');
    expect(e).toMatchObject({ id: 'ar-1', status: 'starting', loopSessionId: 'ls-1', used: 0 });
    expect(e.budget).toEqual({ kind: 'turns', limit: 50 });
  });
});

// ---------------------------------------------------------------------------
// 预算展示
// ---------------------------------------------------------------------------

describe('formatTokens / formatMinutes / formatBudget / budgetUsedPct', () => {
  it('tokens 缩写', () => {
    expect(formatTokens(8_000_000)).toBe('8M');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(4800)).toBe('5K');
    expect(formatTokens(1000)).toBe('1K');
    expect(formatTokens(999)).toBe('999');
  });

  it('分钟缩写', () => {
    expect(formatMinutes(35)).toBe('35 分');
    expect(formatMinutes(120)).toBe('2 小时');
    expect(formatMinutes(90)).toBe('1 小时 30 分');
  });

  it('余量文案按 kind 口径', () => {
    expect(formatBudget('turns', 12, 50)).toBe('12 / 50 轮');
    expect(formatBudget('tokens', 8_000_000, 8_000_000)).toBe('8M / 8M tokens');
    expect(formatBudget('time', 35, 120)).toBe('35 分 / 2 小时');
  });

  it('预算百分比 0-100 钳界', () => {
    expect(budgetUsedPct(0, 50)).toBe(0);
    expect(budgetUsedPct(45, 50)).toBe(90);
    expect(budgetUsedPct(60, 50)).toBe(100);
    expect(budgetUsedPct(10, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 窄化
// ---------------------------------------------------------------------------

describe('budgetKindOf / outcomeOf', () => {
  it('kind 非法回落 turns', () => {
    expect(budgetKindOf('tokens')).toBe('tokens');
    expect(budgetKindOf('time')).toBe('time');
    expect(budgetKindOf('turns')).toBe('turns');
    expect(budgetKindOf('weeks')).toBe('turns');
    expect(budgetKindOf(undefined)).toBe('turns');
  });

  it('outcome 非法/缺失回落 passed', () => {
    expect(outcomeOf('passed')).toBe('passed');
    expect(outcomeOf('stopped')).toBe('stopped');
    expect(outcomeOf('exited')).toBe('exited');
    expect(outcomeOf('weird')).toBe('passed');
    expect(outcomeOf(undefined)).toBe('passed');
  });
});

// ---------------------------------------------------------------------------
// 事件归约
// ---------------------------------------------------------------------------

describe('applyAutoRunEvent', () => {
  it('started：无条目新建 running；同 id 乐观条目只翻状态，字段以本地为准', () => {
    const fresh = applyAutoRunEvent(null, {
      kind: 'started',
      id: 'ar-1',
      name: '拿 flag',
      envKey: 'pwn-vm',
      goal: 'g',
      budget: { kind: 'turns', limit: 50 },
      criteria: ['c'],
      loopSessionId: 'ls-1',
    });
    expect(fresh).toMatchObject({ id: 'ar-1', status: 'running', loopSessionId: 'ls-1', used: 0 });

    const optimistic = optimisticAutoRunEntry('ar-1', buildAutoRunStartPayload(form())!, 1);
    const patched = applyAutoRunEvent(optimistic, {
      kind: 'started',
      id: 'ar-1',
      name: '',
      envKey: '',
      goal: '',
      budget: { kind: 'turns', limit: 0 },
      criteria: [],
    }, 2);
    expect(patched?.name).toBe('拿 flag');
    expect(patched?.status).toBe('running');
    expect(patched?.updatedAt).toBe(2);

    // loopSessionId 缺则补。
    const kept = applyAutoRunEvent({ ...patched!, loopSessionId: 'loop-keep' }, {
      kind: 'started',
      id: 'ar-1',
      name: '',
      envKey: '',
      goal: '',
      budget: { kind: 'turns', limit: 0 },
      criteria: [],
    }, 3);
    expect(kept?.loopSessionId).toBe('loop-keep');
  });

  it('phase/turn：starting 翻 running；turn 更新轮次/预算/结论', () => {
    let e = applyAutoRunEvent(entry({ status: 'starting' }), { kind: 'phase', id: 'ar-1', phase: '侦察' }, 1);
    expect(e).toMatchObject({ status: 'running', phase: '侦察' });

    e = applyAutoRunEvent(e, { kind: 'turn', id: 'ar-1', turnCount: 4, used: 3, conclusion: 'x' }, 2);
    expect(e).toMatchObject({ turnCount: 4, used: 3, lastConclusion: 'x', updatedAt: 2 });
  });

  it('completed：passed → completed；stopped(reason=budget) → stopped+stopReason；exited → exited', () => {
    const passed = applyAutoRunEvent(entry(), { kind: 'completed', id: 'ar-1', outcome: 'passed' }, 1);
    expect(passed).toMatchObject({ status: 'completed', updatedAt: 1 });
    expect(passed?.stopReason).toBeUndefined();

    const stopped = applyAutoRunEvent(entry(), { kind: 'completed', id: 'ar-1', outcome: 'stopped', reason: 'budget' }, 2);
    expect(stopped).toMatchObject({ status: 'stopped', stopReason: 'budget' });

    const esc = applyAutoRunEvent(entry(), { kind: 'completed', id: 'ar-1', outcome: 'stopped' }, 3);
    expect(esc).toMatchObject({ status: 'stopped' });
    expect(esc?.stopReason).toBeUndefined();

    const exited = applyAutoRunEvent(entry(), { kind: 'completed', id: 'ar-1', outcome: 'exited', reason: 'provider-error' }, 4);
    expect(exited).toMatchObject({ status: 'exited', stopReason: 'provider-error' });
  });

  it('completed 终态不复活（乱序/重放残影忽略）', () => {
    const done = applyAutoRunEvent(entry(), { kind: 'completed', id: 'ar-1', outcome: 'passed' }, 1)!;
    const again = applyAutoRunEvent(done, { kind: 'completed', id: 'ar-1', outcome: 'stopped' }, 2);
    expect(again).toBe(done);
  });

  it('id 不匹配 / entry 为空 → 原样返回或 null', () => {
    const e = entry();
    expect(applyAutoRunEvent(e, { kind: 'phase', id: 'ar-2', phase: 'x' }, 1)).toBe(e);
    expect(applyAutoRunEvent(e, { kind: 'completed', id: 'ar-2', outcome: 'passed' }, 1)).toBe(e);
    expect(applyAutoRunEvent(null, { kind: 'turn', id: 'ar-1' }, 1)).toBeNull();
    expect(applyAutoRunEvent(null, { kind: 'completed', id: 'ar-1', outcome: 'passed' }, 1)).toBeNull();
  });
});

describe('isAutoRunActive / turnProgressOf / autoRunTerminalText', () => {
  it('活跃 = starting/running；终态三枚举不活跃', () => {
    expect(isAutoRunActive(entry({ status: 'starting' }))).toBe(true);
    expect(isAutoRunActive(entry({ status: 'running' }))).toBe(true);
    expect(isAutoRunActive(entry({ status: 'completed' }))).toBe(false);
    expect(isAutoRunActive(entry({ status: 'stopped' }))).toBe(false);
    expect(isAutoRunActive(entry({ status: 'exited' }))).toBe(false);
    expect(isAutoRunActive(null)).toBe(false);
  });

  it('轮内进度：running → 第 N+1 轮 + 秒数；非 running → null', () => {
    expect(turnProgressOf(entry({ turnCount: 3, updatedAt: 1000 }), 3000)).toEqual({ turn: 4, elapsedSec: 2 });
    expect(turnProgressOf(entry({ status: 'completed' }), 3000)).toBeNull();
  });

  it('终态文案：passed→达成；budget→预算耗尽；无原因→已终止；exited→API 故障', () => {
    expect(autoRunTerminalText(entry({ status: 'completed' }))).toBe('达成');
    expect(autoRunTerminalText(entry({ status: 'stopped', stopReason: 'budget' }))).toBe('预算耗尽（超时）');
    expect(autoRunTerminalText(entry({ status: 'stopped' }))).toBe('已终止');
    expect(autoRunTerminalText(entry({ status: 'exited', stopReason: 'provider-error' }))).toBe('API 故障');
    expect(autoRunTerminalText(entry())).toBe('');
  });
});

// ---------------------------------------------------------------------------
// list 恢复
// ---------------------------------------------------------------------------

describe('autoRunEntryOf（服务端 AutoRunRecord → 条目）', () => {
  it('服务端扁平形状：pauseReason → stopReason；budget.spent → used；ISO updatedAt', () => {
    const e = autoRunEntryOf({
      id: 'ar-1',
      name: '拿 flag',
      envKey: 'pwn-vm',
      goal: 'g',
      budget: { kind: 'turns', limit: 50, spent: 7 },
      criteria: ['c1'],
      status: 'stopped',
      pauseReason: 'budget',
      turns: 7,
      loopSessionId: 'ls-1',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:01:00.000Z',
    });
    expect(e).toMatchObject({
      id: 'ar-1',
      status: 'stopped',
      stopReason: 'budget',
      used: 7,
      loopSessionId: 'ls-1',
    });
    expect(e?.updatedAt).toBe(new Date('2026-08-26T00:01:00.000Z').getTime());
  });

  it('exited 终态恢复（provider-error 原因）', () => {
    const e = autoRunEntryOf({ id: 'ar-1', status: 'exited', pauseReason: 'provider-error' });
    expect(e).toMatchObject({ status: 'exited', stopReason: 'provider-error' });
  });

  it('1.7.7 旧形态窄化丢弃：paused/awaiting-verdict 状态与 paused/verdict 字段不再消费', () => {
    expect(autoRunEntryOf({ id: 'ar-1', status: 'paused', pauseReason: 'budget' })).toBeNull();
    expect(autoRunEntryOf({ id: 'ar-1', status: 'awaiting-verdict' })).toBeNull();
    const e = autoRunEntryOf({
      id: 'ar-1',
      status: 'completed',
      paused: { reason: 'budget' },
      verdict: { criteria: [], statement: 's' },
      verdictPackage: { statement: 's' },
    });
    expect(e).not.toBeNull();
    expect('stopReason' in (e ?? {})).toBe(false);
  });

  it('id/status 缺一即丢弃；updatedAt 缺失回落 now', () => {
    expect(autoRunEntryOf({})).toBeNull();
    expect(autoRunEntryOf({ id: 'ar-1' })).toBeNull();
    const e = autoRunEntryOf({ id: 'ar-1', status: 'running' }, 42);
    expect(e?.updatedAt).toBe(42);
  });
});

describe('parseAutoRunList / activeAutoRunOf / restoredAutoRunStale', () => {
  it('{data:{records:[…]}} 形状 → 条目数组（服务端 handleAutoRunList 实况）', () => {
    const list = parseAutoRunList({
      success: true,
      data: {
        records: [{ id: 'ar-1', status: 'running', loopSessionId: 'ls-1' }, { id: 'ar-2', status: 'completed' }],
      },
    });
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: 'ar-1', status: 'running', loopSessionId: 'ls-1' });
    expect(activeAutoRunOf({ success: true, data: { records: [{ id: 'ar-1', status: 'running' }] } })?.id).toBe('ar-1');
  });

  it('裸数组 / data.runs / runs 形状兼容；非法条目过滤', () => {
    expect(parseAutoRunList([{ id: 'ar-1', status: 'completed' }, { nope: true }])).toHaveLength(1);
    expect(parseAutoRunList({ data: { runs: [{ id: 'ar-1', status: 'stopped' }] } })).toHaveLength(1);
    expect(parseAutoRunList({ runs: [{ id: 'ar-1', status: 'exited' }] })).toHaveLength(1);
  });

  it('终态不再算活跃（activeAutoRunOf 只认 starting/running）', () => {
    expect(activeAutoRunOf({ data: { records: [{ id: 'ar-1', status: 'completed' }] } })).toBeNull();
  });

  it('stale 守卫：同 id 且本地更新 → 不覆盖', () => {
    expect(restoredAutoRunStale(entry({ updatedAt: 5 }), entry({ updatedAt: 3 }))).toBe(true);
    expect(restoredAutoRunStale(entry({ updatedAt: 3 }), entry({ updatedAt: 5 }))).toBe(false);
    expect(restoredAutoRunStale(null, entry())).toBe(false);
    expect(restoredAutoRunStale(entry({ id: 'a' }), entry({ id: 'b' }))).toBe(false);
  });
});
