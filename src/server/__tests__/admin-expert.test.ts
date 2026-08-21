/**
 * admin expert 路由 handler 测试（1.2.1 骨架期）——临时库经 deps.baseDir 注入。
 *
 * 覆盖正常链路（add/list/show/search/update/rm/drafts/review/promote-prefill）
 * 与错误路径（缺参 / 非法枚举 / builtin 删拒 / 草稿不存在 / 事件不存在）。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  handleExpertAdd,
  handleExpertDrafts,
  handleExpertList,
  handleExpertPromotePrefill,
  handleExpertReview,
  handleExpertRm,
  handleExpertSearch,
  handleExpertShow,
  handleExpertUpdate,
} from '../admin-api';
import { resetExpertStoreForTest } from '../expert/store';
import { recordResearchEvent, resetMemoryStoreForTest } from '../memory/store';

let dir: string;
const deps = () => ({ baseDir: dir, memoryBaseDir: dir });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-adminexpert-'));
  resetExpertStoreForTest();
  resetMemoryStoreForTest();
});

afterEach(() => {
  resetExpertStoreForTest();
  resetMemoryStoreForTest();
  rmSync(dir, { recursive: true, force: true });
});

const VALID = {
  domain: 'binary',
  kind: 'technique',
  title: '栈溢出 triage',
  applicability: '拿到崩溃现场',
  content: '正文',
  criteria: '判据',
  reviewer: 'alice',
};

async function addOne(overrides: Record<string, unknown> = {}) {
  const r = await handleExpertAdd({ ...VALID, ...overrides }, deps());
  if (!r.success) throw new Error(r.error);
  return (r.data as { entry: { id: number } }).entry;
}

describe('expert/add + show + list + search', () => {
  it('add → show 全文 / list 摘要（无 content 全文）/ search 命中', async () => {
    const entry = await addOne();
    const show = await handleExpertShow({ id: entry.id }, deps());
    expect(show.success).toBe(true);
    const full = (show.data as { entry: Record<string, unknown> }).entry;
    expect(full.content).toBe('正文');
    expect(full.provenance).toBe('user');
    expect(full.reviewer).toBe('alice');

    const list = await handleExpertList({}, deps());
    expect(list.success).toBe(true);
    const rows = (list.data as { entries: Array<Record<string, unknown>> }).entries;
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBeUndefined();
    expect(rows[0].contentPreview).toBeDefined();

    const search = await handleExpertSearch({ query: 'triage' }, deps());
    expect(search.success).toBe(true);
    expect((search.data as { results: unknown[] }).results).toHaveLength(1);
  });

  it('add 缺 reviewer / 非法枚举 → 拒', async () => {
    const noReviewer = await handleExpertAdd({ ...VALID, reviewer: undefined }, deps());
    expect(noReviewer.success).toBe(false);
    expect(noReviewer.error).toContain('reviewer 必填');
    const badKind = await handleExpertAdd({ ...VALID, kind: 'nope' }, deps());
    expect(badKind.success).toBe(false);
    expect(badKind.error).toContain('kind 非法');
    const badDomain = await handleExpertAdd({ ...VALID, domain: 'web3' }, deps());
    expect(badDomain.success).toBe(false);
  });

  it('search 缺 query / 非法 domain → 拒；list 非法过滤值 → 拒', async () => {
    expect((await handleExpertSearch({}, deps())).success).toBe(false);
    const badDomain = await handleExpertSearch({ query: 'x', domain: 'nope' }, deps());
    expect(badDomain.success).toBe(false);
    expect(badDomain.error).toContain('非法 domain');
    expect((await handleExpertList({ kind: 'nope' }, deps())).success).toBe(false);
    expect((await handleExpertList({ provenance: 'auto' }, deps())).success).toBe(false);
    expect((await handleExpertList({ domain: 'nope' }, deps())).success).toBe(false);
  });

  it('show 缺 id / 不存在 → 拒', async () => {
    expect((await handleExpertShow({}, deps())).success).toBe(false);
    const missing = await handleExpertShow({ id: 42 }, deps());
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('不存在');
  });
});

describe('expert/update + rm', () => {
  it('update 可变字段生效、provenance 不变；不存在 → 拒', async () => {
    const entry = await addOne();
    const updated = await handleExpertUpdate({ id: entry.id, title: '新标题', enabled: false }, deps());
    expect(updated.success).toBe(true);
    const e = (updated.data as { entry: Record<string, unknown> }).entry;
    expect(e.title).toBe('新标题');
    expect(e.enabled).toBe(false);
    expect(e.provenance).toBe('user');
    expect((await handleExpertUpdate({ id: 99, title: 'x' }, deps())).success).toBe(false);
    expect((await handleExpertUpdate({ title: 'x' }, deps())).success).toBe(false);
  });

  it('update 校验失败（title 置空）→ 拒', async () => {
    const entry = await addOne();
    const r = await handleExpertUpdate({ id: entry.id, title: '  ' }, deps());
    expect(r.success).toBe(false);
    expect(r.error).toContain('校验失败');
  });

  it('rm：user 可删；builtin 删拒（提示随包分发）；不存在 → 拒', async () => {
    const entry = await addOne();
    expect((await handleExpertRm({ id: entry.id }, deps())).success).toBe(true);
    expect((await handleExpertShow({ id: entry.id }, deps())).success).toBe(false);

    // builtin 条目只能经 seed 进库——测试里直接走 store 插一条
    const { openExpertStore, insertEntry } = await import('../expert/store');
    const { validateEntry, computeContentHash } = await import('../expert/validate');
    const v = validateEntry({ ...VALID, title: '内置条目', provenance: 'builtin', reviewer: undefined });
    if (!v.ok) throw new Error('unreachable');
    const builtin = insertEntry(openExpertStore(dir), v.value, computeContentHash(v.value));
    const denied = await handleExpertRm({ id: builtin.id }, deps());
    expect(denied.success).toBe(false);
    expect(denied.error).toContain('随包分发');
    expect((await handleExpertRm({ id: 12345 }, deps())).success).toBe(false);
  });
});

describe('expert/drafts + review', () => {
  async function addDraft() {
    const { openExpertStore, insertDraft } = await import('../expert/store');
    const { validateEntry, computeContentHash } = await import('../expert/validate');
    const v = validateEntry({ ...VALID, provenance: 'user', reviewer: undefined }, { skipReviewer: true });
    if (!v.ok) throw new Error('unreachable');
    return insertDraft(openExpertStore(dir), v.value, computeContentHash(v.value), 'agent');
  }

  it('drafts 列表 → review approve（edited.reviewer）→ 进 entries 删草稿', async () => {
    const draft = await addDraft();
    const list = await handleExpertDrafts({}, deps());
    expect((list.data as { drafts: unknown[] }).drafts).toHaveLength(1);

    // approve 缺 reviewer → 拒（人审是权威性来源）
    const noReviewer = await handleExpertReview({ draftId: draft.id, action: 'approve' }, deps());
    expect(noReviewer.success).toBe(false);
    expect(noReviewer.error).toContain('reviewer 必填');

    const approved = await handleExpertReview({
      draftId: draft.id,
      action: 'approve',
      edited: { reviewer: 'carol', title: '审定后标题' },
    }, deps());
    expect(approved.success).toBe(true);
    const entry = (approved.data as { entry: Record<string, unknown> }).entry;
    expect(entry.title).toBe('审定后标题');
    expect(entry.reviewer).toBe('carol');
    expect(entry.provenance).toBe('user');

    const draftsAfter = (await handleExpertDrafts({}, deps())).data as { drafts: unknown[] };
    expect(draftsAfter.drafts).toHaveLength(0);
    const entries = (await handleExpertList({}, deps())).data as { entries: unknown[] };
    expect(entries.entries).toHaveLength(1);
  });

  it('review discard → 删草稿不进 entries；草稿不存在 / 非法 action → 拒', async () => {
    const draft = await addDraft();
    const discarded = await handleExpertReview({ draftId: draft.id, action: 'discard' }, deps());
    expect(discarded.success).toBe(true);
    expect(((await handleExpertDrafts({}, deps())).data as { drafts: unknown[] }).drafts).toHaveLength(0);
    expect(((await handleExpertList({}, deps())).data as { entries: unknown[] }).entries).toHaveLength(0);

    expect((await handleExpertReview({ draftId: 777, action: 'approve' }, deps())).success).toBe(false);
    const badAction = await handleExpertReview({ draftId: 1, action: 'merge' }, deps());
    expect(badAction.success).toBe(false);
    expect(badAction.error).toContain('非法 action');
    expect((await handleExpertReview({ action: 'approve' }, deps())).success).toBe(false);
  });
});

describe('expert/promote-prefill', () => {
  it('取 research_events 事件 → 预填字段（domain=task_kind、轨迹引用、provenance=promoted）', async () => {
    const event = recordResearchEvent({
      workspace: 'ws',
      taskKind: 'pentest',
      outcome: 'success',
      summary: 'WebLogic 反序列化直连利用成功',
      trajectoryRef: 'traj/abc.jsonl',
    }, dir);
    const r = await handleExpertPromotePrefill({ eventId: event.id }, deps());
    expect(r.success).toBe(true);
    const prefill = (r.data as { prefill: Record<string, unknown> }).prefill;
    expect(prefill.domain).toBe('pentest');
    expect(prefill.provenance).toBe('promoted');
    expect(prefill.sourceEventId).toBe(event.id);
    expect(String(prefill.content)).toContain('WebLogic 反序列化直连利用成功');
    expect(String(prefill.content)).toContain('traj/abc.jsonl');
  });

  it('事件不存在 / 缺 eventId → 拒', async () => {
    const missing = await handleExpertPromotePrefill({ eventId: 4242 }, deps());
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('不存在');
    expect((await handleExpertPromotePrefill({}, deps())).success).toBe(false);
  });
});
