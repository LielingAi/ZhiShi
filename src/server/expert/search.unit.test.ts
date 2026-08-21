/**
 * expert/search.ts 单测（1.2.1 骨架期）——FTS 命中、domain 过滤、enabled 过滤、
 * LIKE 兜底（中文）、≤limit 截断、FTS 查询串构造。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildExpertFtsQuery, searchExpertEntries } from './search';
import { insertEntry, openExpertStore, resetExpertStoreForTest, updateEntry } from './store';
import { computeContentHash, validateEntry, type ValidatedExpertEntry } from './validate';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-expertsearch-'));
  resetExpertStoreForTest();
});

afterEach(() => {
  resetExpertStoreForTest();
  rmSync(dir, { recursive: true, force: true });
});

function add(overrides: Record<string, unknown> = {}) {
  const r = validateEntry({
    domain: 'binary',
    kind: 'technique',
    title: '默认标题',
    applicability: '适用',
    content: '正文',
    criteria: '判据',
    provenance: 'user',
    reviewer: 'alice',
    ...overrides,
  });
  if (!r.ok) throw new Error(r.errors.join());
  const db = openExpertStore(dir);
  return insertEntry(db, r.value as ValidatedExpertEntry, computeContentHash(r.value as ValidatedExpertEntry));
}

describe('buildExpertFtsQuery', () => {
  it('词元引号包裹 + AND；内部引号转义；空串 → 空', () => {
    expect(buildExpertFtsQuery('stack canary')).toBe('"stack" AND "canary"');
    expect(buildExpertFtsQuery('  ')).toBe('');
    expect(buildExpertFtsQuery('a"b')).toBe('"a""b"');
  });
});

describe('searchExpertEntries', () => {
  it('FTS 命中 title/content/tags', () => {
    add({ title: 'stack canary 绕过手法' });
    add({ title: '堆喷笔记', content: 'heap spray 布局与占位' });
    add({ title: '无关条目', tags: 'ropchain' });
    const db = openExpertStore(dir);
    expect(searchExpertEntries(db, 'canary').map((e) => e.title)).toEqual(['stack canary 绕过手法']);
    expect(searchExpertEntries(db, 'heap').map((e) => e.title)).toEqual(['堆喷笔记']);
    expect(searchExpertEntries(db, 'ropchain').map((e) => e.title)).toEqual(['无关条目']);
  });

  it('多词元 AND 语义', () => {
    add({ title: 'stack canary' });
    add({ title: 'stack pivot' });
    const db = openExpertStore(dir);
    const hits = searchExpertEntries(db, 'stack canary');
    expect(hits.map((e) => e.title)).toEqual(['stack canary']);
  });

  it('domain 过滤在 SQL 层', () => {
    add({ title: 'canary 二进制', domain: 'binary' });
    add({ title: 'canary 渗透', domain: 'pentest' });
    const db = openExpertStore(dir);
    const hits = searchExpertEntries(db, 'canary', { domain: 'pentest' });
    expect(hits.map((e) => e.title)).toEqual(['canary 渗透']);
  });

  it('enabled=0 不命中（FTS 与兜底都不命中）', () => {
    const e = add({ title: 'disabled canary' });
    const db = openExpertStore(dir);
    updateEntry(db, e.id, { enabled: false });
    expect(searchExpertEntries(db, 'canary')).toEqual([]);
  });

  it('LIKE 兜底：FTS 零命中时按子串保召回（中文场景）', () => {
    add({ title: '通用', content: '提到一次金丝雀保护机制' });
    const db = openExpertStore(dir);
    // 「丝雀」不是完整词元，FTS 大概率不命中 → LIKE 兜底召回
    const hits = searchExpertEntries(db, '丝雀');
    expect(hits).toHaveLength(1);
  });

  it('长句自然查询放宽命中（1.2.1 对照实验钉：AND 全中才返回 = 长查询必空）', () => {
    add({
      title: 'zsrv KV 查询服务的两个 quirks',
      applicability: '黑盒测试 zsrv 时',
      content: '注释符是 ~~；系统表 _meta.tables 可直接读',
    });
    const db = openExpertStore(dir);
    // agent 的自然长句查询：「安全测试」「漏洞利用」不在条目里——AND 必空，
    // 放宽链（FTS OR / 逐词元 LIKE）必须把它捞回来。
    const hits = searchExpertEntries(db, 'zsrv KV 查询服务 安全测试 漏洞利用');
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toContain('zsrv');
  });

  it('limit 截断', () => {
    for (let i = 0; i < 8; i++) add({ title: `canary 条目 ${i}` });
    const db = openExpertStore(dir);
    expect(searchExpertEntries(db, 'canary', { limit: 5 })).toHaveLength(5);
  });

  it('空库 → 空数组（不 throw）', () => {
    const db = openExpertStore(dir);
    expect(searchExpertEntries(db, 'anything')).toEqual([]);
  });
});
