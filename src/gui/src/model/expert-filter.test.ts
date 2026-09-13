/**
 * 1.7.3 — expert-filter.ts 单测（筛选组合 + 翻页边界）。
 */
import { describe, expect, it } from 'vitest';

import { filterExpertEntries, paginate, type ExpertEntryLike } from './expert-filter';

const entries: ExpertEntryLike[] = [
  { id: 1, domain: 'binary', kind: 'technique', title: '栈溢出诊断链', reviewer: 'j0hnexp' },
  { id: 2, domain: 'binary', kind: 'sop', title: '二进制利用决策链', reviewer: 'j0hnexp' },
  { id: 3, domain: 'pentest', kind: 'sop', title: '渗透决策链', reviewer: 'demo' },
  { id: 4, domain: 'whitebox', kind: 'idea', title: '白盒审计信任边界', reviewer: 'demo' },
  { id: 5, domain: 'whitebox', kind: 'technique', title: 'Python Web sink 速查', reviewer: 'demo' },
];

describe('filterExpertEntries（domain × kind × query 组合）', () => {
  it('全部空筛选 → 原样', () => {
    expect(filterExpertEntries(entries, {})).toEqual(entries);
  });

  it('domain 单选 → 仅该域', () => {
    const r = filterExpertEntries(entries, { domain: 'binary' });
    expect(r.map((e) => e.id)).toEqual([1, 2]);
  });

  it('kind 单选 → 仅该类型', () => {
    const r = filterExpertEntries(entries, { kind: 'technique' });
    expect(r.map((e) => e.id)).toEqual([1, 5]);
  });

  it('domain + kind 组合 → 交集', () => {
    const r = filterExpertEntries(entries, { domain: 'whitebox', kind: 'idea' });
    expect(r.map((e) => e.id)).toEqual([4]);
  });

  it('query 子串命中（大小写不敏感）', () => {
    const r = filterExpertEntries(entries, { query: 'stack' });
    expect(r).toEqual([]);
    expect(filterExpertEntries(entries, { query: 'sink' }).map((e) => e.id)).toEqual([5]);
    expect(filterExpertEntries(entries, { query: 'DEMO' }).map((e) => e.id)).toEqual([3, 4, 5]);
  });
});

describe('paginate（翻页边界）', () => {
  const items = Array.from({ length: 45 }, (_, i) => ({ id: i + 1 }));

  it('第 1 页 20 条 / 第 3 页 5 条', () => {
    expect(paginate(items, 1).items).toHaveLength(20);
    const p3 = paginate(items, 3);
    expect(p3.items).toHaveLength(5);
    expect(p3.totalPages).toBe(3);
    expect(p3.total).toBe(45);
  });

  it('page 超界 clamp 到最大页', () => {
    expect(paginate(items, 99).page).toBe(3);
  });

  it('page ≤ 0 clamp 到 1', () => {
    expect(paginate(items, 0).page).toBe(1);
    expect(paginate(items, -5).page).toBe(1);
  });

  it('空集 → 第 1 页、totalPages 1、items 空', () => {
    const r = paginate([], 1);
    expect(r).toEqual({ page: 1, totalPages: 1, total: 0, items: [] });
  });

  it('恰好整页 → 最后一页不带残页', () => {
    const full = Array.from({ length: 40 }, (_, i) => i);
    const r = paginate(full, 2);
    expect(r.totalPages).toBe(2);
    expect(r.items).toHaveLength(20);
  });
});
