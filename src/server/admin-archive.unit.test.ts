/**
 * admin-archive handleArchiveOp 单测（1.8.4 桥接投影面）。
 *
 * 核心断言：handler 复用 research_archive 工具执行体——举证强度
 * （finding 必挂已存在 V# 证据）与纪律文本与 loop 内 agent 调用同口径；
 * 会话未锚定与非法 op 按业务错误返回（success=false），不 throw。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 锚定默认值的唯一来源——单测无引擎线，固定返回 '' 让「未锚定」分支确定可达
// （defaultEngine 在无会话时也可能给出非空 id，环境行为不定）。
vi.mock('./loop/chat-engine', () => ({ getPiSessionId: () => '' }));

// P3b 双线制：线归属 mock（默认无记录 = 归属未知，本机 LOCAL_ACTOR 恒放行，
// 既有用例零变化；授权用例按场景回填）。
const lineOwnershipMocks = vi.hoisted(() => ({
  getLineOwnership: vi.fn((): { owner?: string; shared?: boolean; updatedAt: string } | undefined => undefined),
}));
vi.mock('./loop/line-ownership', () => lineOwnershipMocks);

import { handleArchiveList, handleArchiveOp } from './admin-archive';
import { withLogContext } from './logger-context';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'admin-archive-op-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('handleArchiveOp', () => {
  it('hypothesis → 成功并返回实体 id', async () => {
    const r = await handleArchiveOp(
      { sessionId: 'op-test-1', op: 'hypothesis', text: '目标存在 SQL 注入' },
      { dir },
    );
    expect(r.success).toBe(true);
    expect(String(r.data?.text)).toContain('H#1');
    expect(r.data?.entityId).toBe('H#1');
  });

  it('finding 零证据引用 → 举证强度拒绝（与 loop 工具同口径）', async () => {
    const r = await handleArchiveOp(
      { sessionId: 'op-test-2', op: 'finding', text: '存在注入' },
      { dir },
    );
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('结论必须有证据支撑');
  });

  it('evidence 挂假设 → finding 挂证据，全链放行', async () => {
    await handleArchiveOp({ sessionId: 'op-test-3', op: 'hypothesis', text: 'H 假设' }, { dir });
    const ev = await handleArchiveOp(
      { sessionId: 'op-test-3', op: 'evidence', text: 'V 证据', refs: 'H#1' },
      { dir },
    );
    expect(ev.success).toBe(true);
    const fi = await handleArchiveOp(
      { sessionId: 'op-test-3', op: 'finding', text: 'C 结论', refs: 'V#1,H#1' },
      { dir },
    );
    expect(fi.success).toBe(true);
    expect(fi.data?.entityId).toBe('C#1');
  });

  it('未知 op → 业务错误（不 throw）', async () => {
    const r = await handleArchiveOp(
      { sessionId: 'op-test-4', op: 'nonsense', text: 'x' },
      { dir },
    );
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('未知操作');
  });

  it('会话未锚定（无当前线）→ 明确错误', async () => {
    // getPiSessionId 已被文件头 mock 为 ''——走未锚定分支
    const r = await handleArchiveOp({ op: 'hypothesis', text: 'x' }, { dir });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('未锚定');
  });
});

/**
 * P3b 双线制（chain-audit 2026-10-14 #2）：显式 sessionId 的 archive 操作纳入
 * 与 sessions 路由同一授权面——list 走读闸、op 走写闸；显式与默认（当前线）
 * 同口径。Bob（operator，非主）对 Alice 私有线 forbidden；owner/reviewer 放行。
 */
describe('线归属闸（archive 显式 sessionId，chain-audit #2）', () => {
  const BOB = { actorName: 'bob', actorRole: 'operator', actorSource: 'token' } as const;
  const ALICE = { actorName: 'alice', actorRole: 'operator', actorSource: 'token' } as const;
  const REVIEWER = { actorName: 'carol', actorRole: 'reviewer', actorSource: 'token' } as const;

  beforeEach(() => {
    lineOwnershipMocks.getLineOwnership.mockReturnValue({ owner: 'alice', updatedAt: '2026-10-14T00:00:00.000Z' });
  });

  it('archive/op：Bob 写 Alice 私有线 → forbidden 且不落盘', async () => {
    const r = await withLogContext(BOB, () =>
      handleArchiveOp({ sessionId: 'ls-alice', op: 'hypothesis', text: '越权假设' }, { dir }));
    expect(r.success).toBe(false);
    expect(r.error).toBe('forbidden');
  });

  it('archive/op：owner 本人写 → 放行', async () => {
    const r = await withLogContext(ALICE, () =>
      handleArchiveOp({ sessionId: 'ls-alice', op: 'hypothesis', text: '本人假设' }, { dir }));
    expect(r.success).toBe(true);
  });

  it('archive/list：Bob 读 Alice 私有线档案 → forbidden；reviewer 可读', async () => {
    const denied = withLogContext(BOB, () => handleArchiveList({ sessionId: 'ls-alice' }));
    expect(denied.success).toBe(false);
    expect(denied.error).toBe('forbidden');
    const ok = withLogContext(REVIEWER, () => handleArchiveList({ sessionId: 'ls-alice' }));
    expect(ok.success).toBe(true);
  });

  it('归属未知旧线（无记录）→ 维持旧行为放行', async () => {
    lineOwnershipMocks.getLineOwnership.mockReturnValue(undefined);
    const r = await withLogContext(BOB, () =>
      handleArchiveOp({ sessionId: 'ls-legacy', op: 'hypothesis', text: '旧线假设' }, { dir }));
    expect(r.success).toBe(true);
  });
});
