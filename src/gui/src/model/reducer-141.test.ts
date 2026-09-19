/**
 * auto-run:* 事件族归约单测（1.4.1；1.7.7 事件族收缩）——reducer 只做
 * payload 窄化出 ReduceResult.autoRun 增量，登记表 merge 在
 * model/auto-run.ts（单测见 auto-run.test.ts）。
 *
 * 1.7.7 事件族：started / phase-changed / turn-completed / completed{outcome}。
 * paused / budget-warning / verdict-requested / resumed 已随暂停点与终审
 * 机制整体删除（服务端不再发射）。
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

describe('auto-run:completed 归约（1.7.7：终态按 outcome 分派）', () => {
  it('outcome=passed → completed 增量', () => {
    expect(run('auto-run:completed', { id: 'ar-1', outcome: 'passed' }).autoRun).toEqual({
      kind: 'completed',
      id: 'ar-1',
      outcome: 'passed',
    });
  });

  it('outcome=stopped + reason=budget → 带终态原因', () => {
    expect(run('auto-run:completed', { id: 'ar-1', outcome: 'stopped', reason: 'budget' }).autoRun).toEqual({
      kind: 'completed',
      id: 'ar-1',
      outcome: 'stopped',
      reason: 'budget',
    });
  });

  it('outcome=exited + reason=provider-error → 带终态原因', () => {
    expect(run('auto-run:completed', { id: 'ar-1', outcome: 'exited', reason: 'provider-error' }).autoRun).toEqual({
      kind: 'completed',
      id: 'ar-1',
      outcome: 'exited',
      reason: 'provider-error',
    });
  });

  it('outcome 非法/缺失回落 passed（保守按达成显示）', () => {
    expect(run('auto-run:completed', { id: 'ar-1', outcome: 'weird' }).autoRun).toMatchObject({ outcome: 'passed' });
    expect(run('auto-run:completed', { id: 'ar-1' }).autoRun).toMatchObject({ outcome: 'passed' });
  });

  it('缺 id → 不产出', () => {
    expect(run('auto-run:completed', {}).autoRun).toBeUndefined();
  });
});

describe('1.7.7 已删事件族 → 不产出增量（防御：旧 sidecar 残影不误伤登记表）', () => {
  it.each(['auto-run:paused', 'auto-run:budget-warning', 'auto-run:verdict-requested', 'auto-run:resumed'] as const)(
    '%s → autoRun undefined',
    (event) => {
      expect(run(event, { id: 'ar-1', reason: 'budget', summary: 'x' }).autoRun).toBeUndefined();
    },
  );
});
