/**
 * loop/decision.ts 单测(1.3.2 任务一)——pending 注册表 + request_decision
 * 工具。覆盖:登记/broadcast 形状、expertHits 命中与「库中无基准」标注、
 * 应答幂等、重放源、注入正文。broadcast 全注入;expert 用临时库(同
 * expert.unit.test.ts 惯例),绝不触网。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildExpertHitSummaries,
  clearDecisions,
  createDecisionTool,
  formatDecisionHit,
  formatDecisionInjectionContent,
  NO_BASELINE_MARK,
  pendingDecisions,
  REQUEST_DECISION_TOOL_NAME,
  requestDecision,
  respondDecision,
} from './decision';
import { insertEntry, openExpertStore, resetExpertStoreForTest, type ExpertEntry } from '../expert/store';
import { computeContentHash, validateEntry } from '../expert/validate';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-decision-'));
  resetExpertStoreForTest();
  clearDecisions();
});

afterEach(() => {
  resetExpertStoreForTest();
  clearDecisions();
  rmSync(dir, { recursive: true, force: true });
});

function addEntry(overrides: Record<string, unknown> = {}): ExpertEntry {
  const r = validateEntry({
    domain: 'binary',
    kind: 'technique',
    title: 'stack canary 绕过',
    applicability: '开启 canary 的栈溢出',
    content: '泄漏 canary 后覆盖返回地址',
    criteria: '控制 rip 且进程不崩',
    provenance: 'user',
    reviewer: 'alice',
    ...overrides,
  });
  if (!r.ok) throw new Error(r.errors.join());
  return insertEntry(openExpertStore(dir), r.value, computeContentHash(r.value));
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

// ===== 注册表 =====

describe('requestDecision / respondDecision(pending 表)', () => {
  it('登记 + 广播 chat:decision-request {decisionId, question, options, expertHits}', () => {
    const sent: { event: string; data: unknown }[] = [];
    const rec = requestDecision(
      {
        sessionId: 'ls-1',
        question: '继续 fuzz 还是转手动审计?',
        options: ['继续 fuzz 12h', '转手动审计 crash-03'],
        context: '已有 3 个同类崩溃',
        expertHits: [NO_BASELINE_MARK],
        expertRefs: [],
      },
      (e, d) => sent.push({ event: e, data: d }),
    );
    expect(rec.decisionId).toMatch(/^dec-/);
    expect(rec.sessionId).toBe('ls-1');
    expect(rec.resolved).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0].event).toBe('chat:decision-request');
    expect(sent[0].data).toEqual({
      decisionId: rec.decisionId,
      question: '继续 fuzz 还是转手动审计?',
      options: ['继续 fuzz 12h', '转手动审计 crash-03'],
      expertHits: [NO_BASELINE_MARK],
    });
    // context 不进广播形状,只进 pending 表
    expect(pendingDecisions()).toHaveLength(1);
    expect(pendingDecisions()[0].context).toBe('已有 3 个同类崩溃');
  });

  it('应答:登记 choice/note、标 resolved、返回完整记录;重复应答幂等', () => {
    const rec = requestDecision(
      { sessionId: 'ls-1', question: 'q', options: ['a', 'b'], expertHits: [NO_BASELINE_MARK] },
      () => {},
    );
    const r1 = respondDecision(rec.decisionId, 'a', '注意时限');
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.decision.resolved).toBe(true);
      expect(r1.decision.choice).toBe('a');
      expect(r1.decision.note).toBe('注意时限');
      expect(r1.decision.resolvedAt).toBeTruthy();
    }
    // 幂等:重复 respond → resolved,不重复登记
    expect(respondDecision(rec.decisionId, 'b')).toEqual({ ok: false, reason: 'resolved' });
    // 已 resolved 不进重放源
    expect(pendingDecisions()).toHaveLength(0);
  });

  it('未知 decisionId → reason=unknown', () => {
    expect(respondDecision('dec-nope', 'a')).toEqual({ ok: false, reason: 'unknown' });
  });
});

// ===== 摘要/正文纯函数 =====

describe('buildExpertHitSummaries / formatDecisionHit', () => {
  it('命中:摘要行带 E#N 编号(口径 = 条目 id)+ title/applicability/criteria', () => {
    const entry = addEntry();
    const { expertHits, expertRefs } = buildExpertHitSummaries([entry]);
    expect(expertRefs).toEqual([`E#${entry.id}`]);
    expect(expertHits).toHaveLength(1);
    expect(expertHits[0]).toContain(`E#${entry.id}`);
    expect(expertHits[0]).toContain('stack canary 绕过');
    expect(expertHits[0]).toContain('适用条件:');
    expect(expertHits[0]).toContain('判据:');
    expect(formatDecisionHit(entry)).toBe(expertHits[0]);
  });

  it('未命中 → 明确标注「库中无基准」(不是「库中没有」)', () => {
    const { expertHits, expertRefs } = buildExpertHitSummaries([]);
    expect(expertHits).toEqual([NO_BASELINE_MARK]);
    expect(expertHits[0]).toBe('库中无基准');
    expect(expertHits[0]).not.toContain('库中没有');
    expect(expertRefs).toEqual([]);
  });

  it('注入正文:问题/选择/备注三段,模型可读', () => {
    const content = formatDecisionInjectionContent({
      question: '继续 fuzz 还是转手动审计?',
      choice: '转手动审计 crash-03',
      note: '12 小时内出结论',
    });
    expect(content).toContain('【人的决定】');
    expect(content).toContain('问题: 继续 fuzz 还是转手动审计?');
    expect(content).toContain('选择: 转手动审计 crash-03');
    expect(content).toContain('备注: 12 小时内出结论');
  });
});

// ===== request_decision 工具 =====

describe('createDecisionTool', () => {
  it('命中:先查 expert_search,expertHits 带摘要,broadcast 带命中', async () => {
    const entry = addEntry();
    const sent: { event: string; data: unknown }[] = [];
    const tool = createDecisionTool({
      baseDir: dir,
      getSessionId: () => 'ls-turn-1',
      broadcastFn: (e, d) => sent.push({ event: e, data: d }),
    });
    expect(tool.name).toBe(REQUEST_DECISION_TOOL_NAME);
    const result = await tool.execute('t1', {
      question: 'canary 绕过走哪条路?',
      options: ['泄漏 canary', 'SROP'],
      context: '进程有 canary 保护',
    });
    expect(result.details.hitCount).toBe(1);
    expect(result.details.decisionId).toMatch(/^dec-/);
    // 广播带命中摘要
    const data = sent[0].data as { expertHits: string[] };
    expect(data.expertHits[0]).toContain(`E#${entry.id}`);
    expect(data.expertHits[0]).toContain('stack canary 绕过');
    // 工具返回值:明确指示暂停执行等决定
    const text = textOf(result);
    expect(text).toContain('决策已提交');
    expect(text).toContain('等待人的决定');
    expect(text).toContain('暂停这条线的执行');
    expect(text).toContain('user 消息注入回来');
    // 归属线 = getSessionId 快照
    expect(pendingDecisions()[0].sessionId).toBe('ls-turn-1');
  });

  it('库空/不可用:expertHits = [库中无基准],照常提请(不 throw)', async () => {
    const sent: { event: string; data: unknown }[] = [];
    const tool = createDecisionTool({
      baseDir: join(dir, 'no-such-db-dir'), // 库不存在 → 打开失败按降级
      getSessionId: () => 'ls-1',
      broadcastFn: (e, d) => sent.push({ event: e, data: d }),
    });
    const result = await tool.execute('t1', { question: 'q?', options: ['a', 'b'] });
    expect(result.details.hitCount).toBe(0);
    const data = sent[0].data as { expertHits: string[] };
    expect(data.expertHits).toEqual([NO_BASELINE_MARK]);
    expect(textOf(result)).toContain('专家库无基准');
  });

  it('非法入参 throw:缺 question / options 不足 2 项 / 含空项', async () => {
    const tool = createDecisionTool({ baseDir: dir, getSessionId: () => 'ls-1', broadcastFn: () => {} });
    await expect(tool.execute('t1', { question: '  ', options: ['a', 'b'] })).rejects.toThrow(/question/);
    await expect(tool.execute('t1', { question: 'q', options: ['a'] })).rejects.toThrow(/options/);
    await expect(tool.execute('t1', { question: 'q', options: ['a', '  '] })).rejects.toThrow(/options/);
    // 未广播任何事件(校验失败不发面板)
    expect(pendingDecisions()).toHaveLength(0);
  });
});
