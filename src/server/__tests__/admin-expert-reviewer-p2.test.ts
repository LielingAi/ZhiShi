/**
 * expert reviewer 覆盖/缺省规则测试（1.8.7 P2）：
 *  - auth 启用（token actor，ALS 模拟）：reviewer 一律取连接身份——
 *    payload/edited 里的 reviewer 被忽略（表单字段不能冒签他人）；
 *  - auth 关闭（本地模式，无 ALS 身份）：原契约不变——add 的 payload.reviewer
 *    必填、review 用 edited.reviewer ?? 草稿值、update 沿用传入/原值。
 * 临时库经 deps.baseDir 注入；token 身份经 withLogContext 模拟（与 index.ts
 * 过闸后并入 ALS 的字段同形）。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleExpertAdd, handleExpertReview, handleExpertUpdate } from '../admin-api';
import { insertDraft, openExpertStore, resetExpertStoreForTest } from '../expert/store';
import { computeContentHash, validateEntry } from '../expert/validate';
import { resetMemoryStoreForTest } from '../memory/store';
import { withLogContext } from '../logger-context';

let dir: string;
const deps = () => ({ baseDir: dir, memoryBaseDir: dir });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-adminexpert-p2-'));
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

/** 以 token 成员 alice(reviewer) 的身份执行（模拟过闸后的 ALS 帧）。 */
function asAlice<T>(fn: () => T): T {
  return withLogContext({ actorName: 'alice', actorRole: 'reviewer' }, fn);
}

async function addDraft() {
  const v = validateEntry({ ...VALID, provenance: 'user', reviewer: undefined }, { skipReviewer: true });
  if (!v.ok) throw new Error('unreachable');
  return insertDraft(openExpertStore(dir), v.value, computeContentHash(v.value), 'agent');
}

describe('token 模式：reviewer 由连接身份覆盖', () => {
  it('expert/add：payload.reviewer 被 actor 名覆盖（不能冒签）；缺 reviewer 也不再报错', async () => {
    const r = await asAlice(() => handleExpertAdd({ ...VALID, reviewer: 'mallory' }, deps()));
    expect(r.success).toBe(true);
    expect((r.data as { entry: Record<string, unknown> }).entry.reviewer).toBe('alice');

    // token 模式下 payload 不带 reviewer 同样落库（= 连接身份）
    const r2 = await asAlice(() => handleExpertAdd({ ...VALID, reviewer: undefined, title: '另一条' }, deps()));
    expect(r2.success).toBe(true);
    expect((r2.data as { entry: Record<string, unknown> }).entry.reviewer).toBe('alice');
  });

  it('expert/update：显式传 reviewer 被覆盖；不传则沿用原值（编辑不转嫁审定人）', async () => {
    const added = await handleExpertAdd({ ...VALID, reviewer: 'bob' }, deps()); // 本地模式加 bob 的条目
    const id = (added.data as { entry: { id: number } }).entry.id;

    const overridden = await asAlice(() => handleExpertUpdate({ id, reviewer: 'mallory', title: '改标题' }, deps()));
    expect(overridden.success).toBe(true);
    expect((overridden.data as { entry: Record<string, unknown> }).entry.reviewer).toBe('alice');

    const kept = await asAlice(() => handleExpertUpdate({ id, title: '再改标题' }, deps()));
    expect(kept.success).toBe(true);
    expect((kept.data as { entry: Record<string, unknown> }).entry.reviewer).toBe('alice'); // 上一步已改;这里验证不传不覆盖回别人
  });

  it('expert/review approve：edited.reviewer 被覆盖为连接身份', async () => {
    const draft = await addDraft();
    const approved = await asAlice(() =>
      handleExpertReview({ draftId: draft.id, action: 'approve', edited: { reviewer: 'mallory' } }, deps()),
    );
    expect(approved.success).toBe(true);
    expect((approved.data as { entry: Record<string, unknown> }).entry.reviewer).toBe('alice');
  });
});

describe('本地模式：原契约一字节不变', () => {
  it('expert/add：payload.reviewer 必填且原样落库（CLI --reviewer 行为不变）', async () => {
    const missing = await handleExpertAdd({ ...VALID, reviewer: undefined }, deps());
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('reviewer 必填');

    const ok = await handleExpertAdd({ ...VALID, reviewer: 'carol' }, deps());
    expect(ok.success).toBe(true);
    expect((ok.data as { entry: Record<string, unknown> }).entry.reviewer).toBe('carol');
  });

  it('expert/review approve：edited.reviewer 原样采用；缺 reviewer 仍拒', async () => {
    const draft = await addDraft();
    const noReviewer = await handleExpertReview({ draftId: draft.id, action: 'approve' }, deps());
    expect(noReviewer.success).toBe(false);
    expect(noReviewer.error).toContain('reviewer 必填');

    const approved = await handleExpertReview({ draftId: draft.id, action: 'approve', edited: { reviewer: 'carol' } }, deps());
    expect(approved.success).toBe(true);
    expect((approved.data as { entry: Record<string, unknown> }).entry.reviewer).toBe('carol');
  });

  it('expert/update：传入 reviewer 原样采用', async () => {
    const added = await handleExpertAdd({ ...VALID, reviewer: 'bob' }, deps());
    const id = (added.data as { entry: { id: number } }).entry.id;
    const updated = await handleExpertUpdate({ id, reviewer: 'carol' }, deps());
    expect(updated.success).toBe(true);
    expect((updated.data as { entry: Record<string, unknown> }).entry.reviewer).toBe('carol');
  });
});
