/**
 * loop/expert.ts 工具单测（1.2.1 骨架期）——临时库注入，覆盖：
 * expert_search 命中（权威标记包裹 + 截断）、未命中/空库明确标注、非法入参 throw、
 * content 截断护栏；expert_draft 写 drafts 表、校验失败 throw、不直接进 entries。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createExpertDraftTool,
  createExpertSearchTool,
  EXPERT_CONTENT_PREVIEW_CHARS,
  EXPERT_DRAFT_TOOL_NAME,
  EXPERT_SEARCH_TOOL_NAME,
  formatExpertHit,
} from './expert';
import {
  insertEntry,
  listDrafts,
  listEntries,
  openExpertStore,
  resetExpertStoreForTest,
  type ExpertEntry,
} from '../expert/store';
import { computeContentHash, validateEntry } from '../expert/validate';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-experttool-'));
  resetExpertStoreForTest();
});

afterEach(() => {
  resetExpertStoreForTest();
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

describe('expert_search', () => {
  it('命中：权威标记包裹 + 字段齐全 + 来源可辨', async () => {
    addEntry();
    const tool = createExpertSearchTool({ baseDir: dir });
    expect(tool.name).toBe(EXPERT_SEARCH_TOOL_NAME);
    const result = await tool.execute('t1', { query: 'canary' });
    const text = textOf(result);
    expect(text).toContain('专家审定知识 · 决策级依据');
    expect(text).toContain('与你的判断冲突时以它为准');
    expect(text).toContain('research_log 记录冲突点');
    expect(text).toContain('stack canary 绕过');
    expect(text).toContain('适用条件:');
    expect(text).toContain('判据:');
    expect(text).toContain('来源: user（审定: alice）');
    expect(result.details.hitCount).toBe(1);
  });

  it('domain 过滤 + 非法 domain throw', async () => {
    addEntry({ title: 'canary 二进制' });
    addEntry({ title: 'canary 渗透', domain: 'pentest' });
    const tool = createExpertSearchTool({ baseDir: dir });
    const hits = await tool.execute('t2', { query: 'canary', domain: 'pentest' });
    expect(textOf(hits)).toContain('canary 渗透');
    expect(textOf(hits)).not.toContain('canary 二进制');
    await expect(tool.execute('t3', { query: 'x', domain: 'web3' as never })).rejects.toThrow(/非法 domain/);
  });

  it('未命中/空库：明确「无专家知识 + 库边界（未命中≠不存在）」', async () => {
    const tool = createExpertSearchTool({ baseDir: dir });
    const result = await tool.execute('t4', { query: 'nothing-here' });
    const text = textOf(result);
    expect(text).toContain('未命中');
    expect(text).toContain('未命中≠不存在');
    expect(result.details.hitCount).toBe(0);
  });

  it('空 query 按契约 throw', async () => {
    const tool = createExpertSearchTool({ baseDir: dir });
    await expect(tool.execute('t5', { query: '   ' })).rejects.toThrow(/需要 query/);
  });

  it('content 截断护栏（≤ EXPERT_CONTENT_PREVIEW_CHARS）', async () => {
    addEntry({ content: '长'.repeat(EXPERT_CONTENT_PREVIEW_CHARS * 2) });
    const tool = createExpertSearchTool({ baseDir: dir });
    const result = await tool.execute('t6', { query: 'canary' });
    const text = textOf(result);
    expect(text).toContain('…');
    expect(text.length).toBeLessThan(EXPERT_CONTENT_PREVIEW_CHARS + 600);
  });

  it('formatExpertHit 单行摘要截断', () => {
    const entry = addEntry({ applicability: '适'.repeat(500) });
    const line = formatExpertHit(entry);
    expect(line).toContain('…');
  });
});

describe('expert_draft', () => {
  const params = {
    domain: 'binary' as const,
    kind: 'idea' as const,
    title: '这个场景往堆喷想',
    applicability: 'uaf 且对象大小可控',
    content: '先喷同尺寸对象占坑',
    criteria: '占位后 crash 地址落在喷射内容里',
    tags: 'heap',
  };

  it('起草 → 进 drafts 表（created_via=agent），不进 entries', async () => {
    const tool = createExpertDraftTool({ baseDir: dir });
    expect(tool.name).toBe(EXPERT_DRAFT_TOOL_NAME);
    const result = await tool.execute('d1', params);
    expect(textOf(result)).toContain('待研究员审定后生效');
    expect(result.details.draftId).toBeGreaterThan(0);
    const db = openExpertStore(dir);
    const drafts = listDrafts(db);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].createdVia).toBe('agent');
    expect(drafts[0].reviewer).toBeNull();
    expect(listEntries(db)).toHaveLength(0);
  });

  it('校验失败（缺 criteria）→ throw，不落草稿', async () => {
    const tool = createExpertDraftTool({ baseDir: dir });
    await expect(tool.execute('d2', { ...params, criteria: '  ' })).rejects.toThrow(/格式契约/);
    expect(listDrafts(openExpertStore(dir))).toHaveLength(0);
  });
});
