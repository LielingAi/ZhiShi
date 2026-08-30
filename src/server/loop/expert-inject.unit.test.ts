/**
 * expert-inject.unit.test.ts — 1.5.1 专家知识邻域投影单测。
 *
 * 覆盖：分词（CJK bigram/拉丁 token/停用词）、焦点锚点（pending H#/open Q#/
 * 最近用户消息）、打分权重（档案边 > 域先验 ≈ 用户边）、过阈取舍（零注入
 * 语义/去重/top N/输出稳定）、渲染（透明标注 #id/硬顶）、collect 全链
 * （注入 entries 假库 + 去重跨调用 + 读侧容错）。
 */
import { describe, expect, it, beforeEach } from 'vitest';

import type { ExpertEntry } from '../expert/store';
import type { ArchiveSnapshot } from './archive';
import {
  collectExpertInjection,
  focusAnchors,
  injectedExpertIds,
  lastUserTextOf,
  pickExpertInjections,
  renderExpertInjection,
  scoreExpertEntry,
  tokenize,
  __resetExpertInjectedForTests,
  EXPERT_INJECT_MAX_CHARS,
  INJECT_SCORE_THRESHOLD,
  W_ARCHIVE,
  W_DOMAIN,
} from './expert-inject';

function entry(id: number, over: Partial<ExpertEntry> = {}): ExpertEntry {
  return {
    id,
    domain: 'whitebox',
    kind: 'sop',
    title: '栈溢出从崩溃到控制流的最小判定链',
    applicability: '二进制域拿到崩溃现场（SIGSEGV、core dump）',
    content: '确认崩溃地址是否可控：cyclic 定位偏移 → RIP 覆盖验证 → 判定可控性。',
    criteria: '能用 cyclic 唯一确定偏移且 RIP 被 pattern 覆盖',
    provenance: 'builtin',
    reviewer: 'zhishi',
    sourceEventId: null,
    tags: '栈溢出 控制流 cyclic RIP',
    contentHash: 'h',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function archiveWith(entities: ArchiveSnapshot['entities']): ArchiveSnapshot {
  return { sessionId: 's', entities, corrections: [], updatedAt: '' };
}

beforeEach(() => {
  __resetExpertInjectedForTests();
});

describe('tokenize（确定性分词）', () => {
  it('拉丁 token 小写化 + CJK bigram', () => {
    const t = tokenize('Wasm writeOpcode 编码器');
    expect(t).toContain('wasm');
    expect(t).toContain('writeopcode');
    expect(t).toContain('编码');
    expect(t).toContain('码器');
  });
});

describe('focusAnchors（焦点节点）', () => {
  it('pending 假设 + open 问题 + 用户消息；终态实体不取', () => {
    const a = focusAnchors(
      archiveWith([
        { id: 'H#1', kind: 'hypothesis', text: '扩展段多写字节', status: 'pending', links: [], createdAt: '', updatedAt: '' },
        { id: 'H#2', kind: 'hypothesis', text: '已证伪的', status: 'falsified', links: [], createdAt: '', updatedAt: '' },
        { id: 'Q#1', kind: 'question', text: '编码是否符合规范', status: 'open', links: [], createdAt: '', updatedAt: '' },
      ]),
      '看看 wasm 编码',
    );
    expect(a).toHaveLength(3);
    expect(a[0]).toContain('扩展段多写字节');
    expect(a[1]).toContain('编码是否符合规范');
    expect(a[2]).toBe('看看 wasm 编码');
  });

  it('无档案 → 只有用户消息锚', () => {
    expect(focusAnchors(undefined, 'cJSON 审计')).toEqual(['cJSON 审计']);
  });
});

describe('scoreExpertEntry / pickExpertInjections（边权重与取舍）', () => {
  it('档案边权重最高：一条档案命中即可过阈（W_ARCHIVE=3 ≥ 阈值需组合）', () => {
    const s = scoreExpertEntry(entry(1), new Set(['rip']), new Set(), undefined);
    expect(s.archiveHits).toBe(1);
    expect(s.score).toBe(W_ARCHIVE);
    expect(s.score).toBeLessThan(INJECT_SCORE_THRESHOLD); // 单档案边不过阈
  });

  it('域先验 + 一命中 = 过阈（W_DOMAIN + W_ARCHIVE ≥ 4）', () => {
    const s = scoreExpertEntry(entry(1), new Set(['rip']), new Set(), 'whitebox');
    expect(s.domainHit).toBe(true);
    expect(s.score).toBe(W_ARCHIVE + W_DOMAIN);
    expect(s.score).toBeGreaterThanOrEqual(INJECT_SCORE_THRESHOLD);
  });

  it('取舍：去重 + 过阈 + top 2 + 稳定排序', () => {
    const entries = [
      entry(1, { title: 'cyclic RIP 判定' }),
      entry(2, { title: 'cyclic RIP 判定' }),
      entry(3, { title: 'cyclic RIP 判定' }),
      entry(4, { title: '无关条目', applicability: '无关', content: '无关', tags: '', criteria: '无' }),
    ];
    const picks = pickExpertInjections(entries, { archiveAnchorTokens: new Set(['cyclic']), userTokens: new Set(['cyclic']) }, undefined, new Set([2]));
    expect(picks.map((p) => p.entry.id)).toEqual([1, 3]); // #2 已注被去重，#4 不过阈，top 2
  });

  it('邻域为空 → 空数组（零注入语义）', () => {
    const picks = pickExpertInjections([entry(4, { title: '完全不同', applicability: 'x', content: 'y', tags: '', criteria: 'z' })], { archiveAnchorTokens: new Set(['qqq']), userTokens: new Set(['www']) }, undefined, new Set());
    expect(picks).toEqual([]);
  });
});

describe('renderExpertInjection（透明标注 + 硬顶）', () => {
  it('列明条目 #id 与判据；空 picks → 空串', () => {
    expect(renderExpertInjection([])).toBe('');
    const s = renderExpertInjection([{ entry: entry(8), score: 5, archiveHits: 1, domainHit: true, userHits: 0 }]);
    expect(s).toContain('<zhishi-expert-knowledge>');
    expect(s).toContain('#8');
    expect(s).toContain('判据');
    expect(s).toContain('冲突时以它为准');
  });

  it('超硬顶截断保收尾标签', () => {
    const big = entry(9, { content: 'x'.repeat(3000) });
    const s = renderExpertInjection([{ entry: big, score: 9, archiveHits: 3, domainHit: false, userHits: 0 }]);
    expect(s.length).toBeLessThanOrEqual(EXPERT_INJECT_MAX_CHARS);
    expect(s).toContain('</zhishi-expert-knowledge>');
  });
});

describe('collectExpertInjection（全链 + 去重 + 容错）', () => {
  it('命中 → 注入段；再次调用同条目去重（零注入）', () => {
    const entries = [entry(8)];
    const input = {
      archive: archiveWith([{ id: 'H#1', kind: 'hypothesis' as const, text: 'RIP 可被 cyclic pattern 覆盖', status: 'pending', links: [], createdAt: '', updatedAt: '' }]),
      lastUserText: '',
      domain: 'whitebox',
      sessionId: 's-1',
      entries,
    };
    const first = collectExpertInjection(input);
    expect(first).toContain('#8');
    expect(injectedExpertIds('s-1').has(8)).toBe(true);
    // 第二次：同条目已注 → 零注入
    expect(collectExpertInjection(input)).toBe('');
  });

  it('无锚点/无命中/库空 → 零注入', () => {
    expect(collectExpertInjection({ lastUserText: '', sessionId: 's-2', entries: [entry(1)] })).toBe('');
    expect(collectExpertInjection({ lastUserText: 'zzz', sessionId: 's-3', entries: [] })).toBe('');
  });

  it('读库失败 → 零注入不炸（读侧容错）', () => {
    expect(collectExpertInjection({ lastUserText: 'cyclic rip', sessionId: 's-4', baseDir: '/nonexistent/dir/x' })).toBe('');
  });

  it('lastUserTextOf：字符串与数组两形态', () => {
    expect(lastUserTextOf([{ role: 'user', content: '文本形' } as never])).toBe('文本形');
    expect(lastUserTextOf([{ role: 'user', content: [{ type: 'text', text: '数组形' }] } as never])).toBe('数组形');
    expect(lastUserTextOf([])).toBe('');
  });
});
