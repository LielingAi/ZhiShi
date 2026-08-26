/**
 * auto-run:* 事件族归约单测（1.4.1）——reducer 只做 payload 窄化出
 * ReduceResult.autoRun 增量，登记表 merge 在 model/auto-run.ts（单测见
 * auto-run.test.ts）。事件契约照 docs/design/auto-loop-design.md §7 + 1.4.1
 * 服务端并行实施口径。
 */

import { describe, expect, it } from 'vitest';

import { emptySession, type SessionState } from './blocks';
import { reduceSseEvent } from './reducer';

function run(event: string, payload: unknown, session: SessionState = emptySession()) {
  return reduceSseEvent(session, { event, payload });
}

describe('auto-run:started 归约（1.4.1）', () => {
  it('完整 payload → started 增量（budget/criteria 逐字段）', () => {
    const session = emptySession();
    const res = run(
      'auto-run:started',
      {
        id: 'ar-1',
        name: '拿 flag',
        envKey: 'pwn-vm',
        goal: '拿到目标机 flag',
        budget: { kind: 'turns', limit: 50 },
        criteria: ['输出 flag{…}', 'PoC 连续 3 次稳定复现'],
      },
      session,
    );
    expect(res.autoRun).toEqual({
      kind: 'started',
      id: 'ar-1',
      name: '拿 flag',
      envKey: 'pwn-vm',
      goal: '拿到目标机 flag',
      budget: { kind: 'turns', limit: 50 },
      criteria: ['输出 flag{…}', 'PoC 连续 3 次稳定复现'],
    });
    expect(res.session).toBe(session);
  });

  it('缺 id → 不产出增量', () => {
    expect(run('auto-run:started', { name: 'x', budget: { kind: 'turns', limit: 1 } }).autoRun).toBeUndefined();
  });

  it('budget.kind 非法回落 turns；criteria 非字符串过滤', () => {
    const res = run('auto-run:started', {
      id: 'ar-2',
      budget: { kind: 'weeks', limit: 9 },
      criteria: ['a', 42, null, 'b'],
    });
    expect(res.autoRun).toMatchObject({ budget: { kind: 'turns', limit: 9 }, criteria: ['a', 'b'] });
  });
});

describe('auto-run:phase-changed 归约（1.4.1）', () => {
  it('id+phase → phase 增量', () => {
    expect(run('auto-run:phase-changed', { id: 'ar-1', phase: '构造' }).autoRun).toEqual({
      kind: 'phase',
      id: 'ar-1',
      phase: '构造',
    });
  });

  it('缺 id 或 phase → 不产出', () => {
    expect(run('auto-run:phase-changed', { phase: '分析' }).autoRun).toBeUndefined();
    expect(run('auto-run:phase-changed', { id: 'ar-1' }).autoRun).toBeUndefined();
  });
});

describe('auto-run:turn-completed 归约（1.4.1）', () => {
  it('turnCount/used/conclusion 可选透传', () => {
    const res = run('auto-run:turn-completed', {
      id: 'ar-1',
      turnCount: 12,
      used: 4800,
      conclusion: '侦察完成：发现 X，进分析',
    });
    expect(res.autoRun).toEqual({
      kind: 'turn',
      id: 'ar-1',
      turnCount: 12,
      used: 4800,
      conclusion: '侦察完成：发现 X，进分析',
    });
  });

  it('只有 id 时其余字段缺省', () => {
    expect(run('auto-run:turn-completed', { id: 'ar-1' }).autoRun).toEqual({ kind: 'turn', id: 'ar-1' });
  });

  it('缺 id → 不产出', () => {
    expect(run('auto-run:turn-completed', { turnCount: 3 }).autoRun).toBeUndefined();
  });
});

describe('auto-run:paused 归约（1.4.1）', () => {
  it('reason=budget + summary → paused 增量', () => {
    expect(
      run('auto-run:paused', { id: 'ar-1', reason: 'budget', summary: '50 轮耗尽' }).autoRun,
    ).toEqual({ kind: 'paused', id: 'ar-1', reason: 'budget', summary: '50 轮耗尽' });
  });

  it('reason=stall / repeated-failures 窄化通过', () => {
    expect(run('auto-run:paused', { id: 'ar-1', reason: 'stall' }).autoRun).toMatchObject({
      reason: 'stall',
    });
    expect(run('auto-run:paused', { id: 'ar-1', reason: 'repeated-failures' }).autoRun).toMatchObject({
      reason: 'repeated-failures',
    });
  });

  it('reason 非法/缺失 → 事件丢弃', () => {
    expect(run('auto-run:paused', { id: 'ar-1', reason: 'whatever' }).autoRun).toBeUndefined();
    expect(run('auto-run:paused', { id: 'ar-1' }).autoRun).toBeUndefined();
  });
});

describe('auto-run:budget-warning 归约（1.4.1）', () => {
  it('used/limit 可选透传', () => {
    expect(run('auto-run:budget-warning', { id: 'ar-1', used: 45, limit: 50 }).autoRun).toEqual({
      kind: 'budget',
      id: 'ar-1',
      used: 45,
      limit: 50,
    });
  });

  it('缺 id → 不产出', () => {
    expect(run('auto-run:budget-warning', { used: 1 }).autoRun).toBeUndefined();
  });
});

describe('auto-run:completed 归约（1.4.1）', () => {
  it('summary 可选透传', () => {
    expect(run('auto-run:completed', { id: 'ar-1', summary: '达成' }).autoRun).toEqual({
      kind: 'completed',
      id: 'ar-1',
      summary: '达成',
    });
  });

  it('缺 id → 不产出', () => {
    expect(run('auto-run:completed', {}).autoRun).toBeUndefined();
  });
});

describe('auto-run:verdict-requested 归约（1.4.1）', () => {
  it('criteria 字符串数组 + evidence 字符串 → verdict 增量', () => {
    const res = run('auto-run:verdict-requested', {
      id: 'ar-1',
      criteria: ['输出 flag{…}'],
      evidence: 'E#12 记录了 flag 读取成功',
    });
    expect(res.autoRun).toEqual({
      kind: 'verdict',
      id: 'ar-1',
      verdict: {
        criteria: [{ text: '输出 flag{…}', hasEvidence: false, refs: [] }],
        statement: 'E#12 记录了 flag 读取成功',
      },
    });
  });

  it('criteria 对象形状（text/refs/hasEvidence）透传', () => {
    const res = run('auto-run:verdict-requested', {
      id: 'ar-1',
      criteria: [{ text: 'PoC 稳定复现', refs: ['E#7'], hasEvidence: true }],
      evidence: { statement: 'E#7 覆盖复现' },
    });
    expect(res.autoRun?.kind).toBe('verdict');
    if (res.autoRun?.kind !== 'verdict') throw new Error('unreachable');
    expect(res.autoRun.verdict.criteria).toEqual([
      { text: 'PoC 稳定复现', refs: ['E#7'], hasEvidence: true },
    ]);
    expect(res.autoRun.verdict.statement).toBe('E#7 覆盖复现');
  });

  it('缺 id → 不产出', () => {
    expect(run('auto-run:verdict-requested', { criteria: [] }).autoRun).toBeUndefined();
  });
});
