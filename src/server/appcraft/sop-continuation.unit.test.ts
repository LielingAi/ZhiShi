// Unit tests for the AppCraft SOP continuation module (P2b-2 失败自动顺接,
// 宪章 §6.3 智能兜底).
//
// Covers: eligibility gates (ai_vision only / skill only / approval gate wins),
// the one-shot injection guard (loop prevention), prompt content (points at
// SKILL.md, carries remaining-step scope + vars + locator, keeps the high-risk
// approval and user-confirmation red lines), and the audit writer (injectable,
// best-effort). No disk, no session — fast `unit` pool.
import { afterEach, describe, expect, it } from 'vitest';

import type { ReplayReport } from './replay-engine';
import {
  appendSopHealAudit,
  buildSopContinuationPrompt,
  isSopContinuationEligible,
  resetSopContinuationForTest,
  tryMarkSopContinuation,
  type SopHealAuditEntry,
} from './sop-continuation';

afterEach(() => {
  resetSopContinuationForTest();
});

function makeReport(overrides: Partial<ReplayReport> = {}): ReplayReport {
  return {
    status: 'failed',
    app: 'KIS',
    stepCount: 5,
    executedSteps: 2,
    durationMs: 1234,
    steps: [],
    failure: {
      stepIndex: 2,
      action: 'uia_click',
      reason: 'Element not found',
      locator: { controlType: 'Button', name: '导出' },
      fallback: 'ai_vision',
      requiresAiHeal: true,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isSopContinuationEligible
// ---------------------------------------------------------------------------

describe('isSopContinuationEligible', () => {
  it('accepts a skill replay whose failed step declared ai_vision fallback', () => {
    expect(isSopContinuationEligible(makeReport(), 'skill')).toBe(true);
  });

  it('rejects recordings (no SKILL.md 五段式 → no SOP context)', () => {
    expect(isSopContinuationEligible(makeReport(), 'recording')).toBe(false);
  });

  it('rejects steps without ai_vision fallback (顺接只发生在被批准的步骤)', () => {
    const report = makeReport({
      failure: { stepIndex: 1, action: 'key', reason: 'x', requiresAiHeal: false },
    });
    expect(isSopContinuationEligible(report, 'skill')).toBe(false);
  });

  it('rejects high-risk approval blocks (要的是人的批准，不是 AI 接管)', () => {
    const report = makeReport({
      failure: {
        stepIndex: 3,
        action: 'uia_click',
        reason: 'highRisk',
        requiresAiHeal: false,
        requiresApproval: true,
      },
    });
    expect(isSopContinuationEligible(report, 'skill')).toBe(false);
  });

  it('rejects reports without a failure payload', () => {
    const report = makeReport({ failure: undefined, status: 'completed' });
    expect(isSopContinuationEligible(report, 'skill')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tryMarkSopContinuation — 一次性闸（防注入循环）
// ---------------------------------------------------------------------------

describe('tryMarkSopContinuation', () => {
  it('allows the first continuation per session+skill, blocks repeats', () => {
    expect(tryMarkSopContinuation('s1', 'monthly-report')).toBe(true);
    expect(tryMarkSopContinuation('s1', 'monthly-report')).toBe(false);
  });

  it('scopes the gate per session and per skill independently', () => {
    expect(tryMarkSopContinuation('s1', 'a')).toBe(true);
    expect(tryMarkSopContinuation('s2', 'a')).toBe(true);
    expect(tryMarkSopContinuation('s1', 'b')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildSopContinuationPrompt
// ---------------------------------------------------------------------------

describe('buildSopContinuationPrompt', () => {
  const ctx = {
    skillId: 'monthly-report',
    tracePath: 'E:\\ws\\demo\\.claude\\skills\\monthly-report\\trace.json',
    vars: { 月份: '2026-06' },
    report: makeReport(),
  };

  it('points at the skill 本体 (SKILL.md) next to the trace', () => {
    const prompt = buildSopContinuationPrompt(ctx);
    expect(prompt).toContain('monthly-report');
    expect(prompt).toContain('SKILL.md');
    expect(prompt).toContain('.claude\\skills\\monthly-report');
  });

  it('scopes the continuation: completed steps not repeated, resume from failed step', () => {
    const prompt = buildSopContinuationPrompt(ctx);
    expect(prompt).toContain('前 2 步已确定性完成');
    expect(prompt).toContain('从第 3 步起');
    expect(prompt).toContain('剩余 3 步');
  });

  it('carries failure reason, locator, and replay vars', () => {
    const prompt = buildSopContinuationPrompt(ctx);
    expect(prompt).toContain('Element not found');
    expect(prompt).toContain('"controlType":"Button"');
    expect(prompt).toContain('月份=2026-06');
  });

  it('keeps the red lines explicit: high-risk approval + user-confirmed write-back', () => {
    const prompt = buildSopContinuationPrompt(ctx);
    expect(prompt).toContain('必须先取得用户明确批准');
    expect(prompt).toContain('先呈现给用户确认');
  });

  it('omits locator / vars sections when absent', () => {
    const report = makeReport({
      failure: { stepIndex: 0, action: 'key', reason: 'x', requiresAiHeal: true },
    });
    const prompt = buildSopContinuationPrompt({ ...ctx, vars: {}, report });
    expect(prompt).not.toContain('定位器');
    expect(prompt).not.toContain('本次回放变量');
  });
});

// ---------------------------------------------------------------------------
// appendSopHealAudit
// ---------------------------------------------------------------------------

describe('appendSopHealAudit', () => {
  const entry: SopHealAuditEntry = {
    ts: '2026-07-30T22:00:00.000Z',
    sessionId: 'sess-1',
    skill: 'monthly-report',
    failedStep: 2,
    action: 'uia_click',
    reason: 'Element not found',
    event: 'sop_continuation_started',
  };

  it('writes one JSONL line under <workspace>/.appcraft/sop-heals.jsonl', () => {
    const writes: Array<{ path: string; line: string }> = [];
    appendSopHealAudit('E:\\ws\\demo', entry, (path, line) => writes.push({ path, line }));
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('E:\\ws\\demo\\.appcraft\\sop-heals.jsonl');
    const parsed = JSON.parse(writes[0].line);
    expect(parsed).toMatchObject({ skill: 'monthly-report', failedStep: 2, event: 'sop_continuation_started' });
  });

  it('is best-effort: writer failure never throws (must not break the failure response)', () => {
    expect(() =>
      appendSopHealAudit('E:\\ws\\demo', entry, () => {
        throw new Error('disk full');
      }),
    ).not.toThrow();
  });
});
