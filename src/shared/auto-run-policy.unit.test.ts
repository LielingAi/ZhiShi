/**
 * 1.7.0 — shared/auto-run-policy.ts 单测。
 *
 * 解析矩阵：合法（YAML 字符串 / 已解析对象 / 缺节走缺省 / 缺省档自洽）；
 * 非法（坏 YAML / 未知顶层键 / 未知节内键 / 坏枚举 / tolerance≤0 /
 * renew 空序列 / 类型错）——全部拒绝且带可读错误。
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AUTO_RUN_POLICY_YAML,
  parseAutoRunPolicy,
  type AutoRunPolicy,
} from './auto-run-policy';

const CONSERVATIVE: AutoRunPolicy = {
  onDecision: { action: 'stop' },
  onStall: { tolerance: 3, action: 'stop' },
  onFailure: { streak: 3, action: 'stop' },
  onBudget: { action: 'stop', renewLimits: [] },
  onDeclare: { report: true },
};

function ok(input: unknown): AutoRunPolicy {
  const r = parseAutoRunPolicy(input);
  expect(r.ok, r.ok ? '' : r.error).toBe(true);
  if (!r.ok) throw new Error(r.error);
  return r.policy;
}

function bad(input: unknown, re: RegExp): void {
  const r = parseAutoRunPolicy(input);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(re);
}

describe('parseAutoRunPolicy', () => {
  it('空输入（undefined/null/空串语义）→ 保守档', () => {
    expect(ok({})).toEqual(CONSERVATIVE);
    expect(ok('on_declare:\n  report: true')).toEqual(CONSERVATIVE);
  });

  it('缺省档 YAML 自洽（parse 往返 = 保守档）', () => {
    expect(ok(DEFAULT_AUTO_RUN_POLICY_YAML)).toEqual(CONSERVATIVE);
  });

  it('全节显式 → 逐字段透传', () => {
    const policy = ok([
      'on_decision:',
      '  action: continue',
      '  principles: |',
      '    - 优先推进已证伪链上最近的假设',
      'on_stall:',
      '  tolerance: 2',
      '  action: continue',
      'on_failure:',
      '  streak: 5',
      '  action: continue',
      'on_budget:',
      '  action: renew',
      '  renew_limits: [30, 20]',
      'on_declare:',
      '  report: false',
    ].join('\n'));
    expect(policy).toEqual({
      onDecision: { action: 'continue', principles: '- 优先推进已证伪链上最近的假设' },
      onStall: { tolerance: 2, action: 'continue' },
      onFailure: { streak: 5, action: 'continue' },
      onBudget: { action: 'renew', renewLimits: [30, 20] },
      onDeclare: { report: false },
    });
  });

  it('已解析对象同样走校验（record 盘上宽进外的严格面）', () => {
    expect(ok({ on_declare: { report: false } })).toEqual({ ...CONSERVATIVE, onDeclare: { report: false } });
  });

  it('非法矩阵', () => {
    bad('x: [unclosed', /YAML 解析失败/);
    bad('[]', /策略必须是/);
    bad('unknown_section:\n  x: 1', /未知键 unknown_section/);
    bad('on_stall:\n  toleranc: 3', /on_stall 含未知键 toleranc/);
    bad('on_stall:\n  action: ask', /on_stall\.action 非法 "ask"/);
    bad('on_decision:\n  action: ask', /on_decision\.action 非法/);
    bad('on_stall:\n  tolerance: 0', /tolerance 必须是 ≥1 的整数/);
    bad('on_stall:\n  tolerance: 2.5', /tolerance 必须是 ≥1 的整数/);
    bad('on_failure:\n  streak: 0', /streak 必须是 ≥1 的整数/);
    bad('on_budget:\n  action: renew\n  renew_limits: []', /renew_limits 非空/);
    bad('on_budget:\n  action: renew\n  renew_limits: [10, 0]', /renew_limits\[1\] 必须是 >0/);
    bad('on_budget:\n  action: keep', /on_budget\.action 非法 "keep"/);
    bad('on_budget:\n  renew_limits: "10"', /renew_limits 必须是数组/);
    bad('on_declare:\n  report: "yes"', /on_declare\.report 必须是布尔值/);
    bad('on_decision:\n  principles: [a]', /principles 必须是字符串/);
    bad('on_decision: [stop]', /on_decision必须是对象/);
    bad(42, /策略必须是/);
  });

  it('principles 在 stop 下允许存在（忽略不报错，设计口径）', () => {
    expect(ok('on_decision:\n  action: stop\n  principles: "x"').onDecision).toEqual({ action: 'stop', principles: 'x' });
  });

  it('principles 前后空白裁剪', () => {
    const p = ok('on_decision:\n  action: continue\n  principles: "  多行\\n原则  "');
    expect(p.onDecision.principles).toBe('多行\n原则');
  });
});
