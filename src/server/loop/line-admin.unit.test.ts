/**
 * 1.8.7 P3b 双线制——研究线管理面（loop/line-admin.ts）。
 *
 * 覆盖：line/list 的归属/live/当前线投影；line/share 的权限（reviewer 或
 * owner；归属未知旧线仅 reviewer；闲人 403）与映射行重挂 shared 段；
 * line/unshare 的权限与归属改登记为调用方。全部 mock 边界（chat-engine
 * 注册表/env-sessions/line-ownership），actor 经 withLogContext 注入。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- mocks ----

const hasLiveEngineMock = vi.fn((..._args: unknown[]): boolean => false);
const getLiveEngineStateMock = vi.fn((..._args: unknown[]): unknown => undefined);
const resolveLineAddressMock = vi.fn((..._args: unknown[]): 'active' | 'known' | 'unknown' => 'known');
const getActiveLoopSessionIdMock = vi.fn((): string => 'ls-active');
vi.mock('./chat-engine', () => ({
  getActiveLoopSessionId: () => getActiveLoopSessionIdMock(),
  getLiveEngineState: (...args: unknown[]) => getLiveEngineStateMock(...args),
  hasLiveEngine: (...args: unknown[]) => hasLiveEngineMock(...args),
  resolveLineAddress: (...args: unknown[]) => resolveLineAddressMock(...args),
}));

const envSessionsLines = new Map<string, { loopSessionId: string; updatedAt: string }>();
const retargetCalls: Array<{ loopSessionId: string; segment: string }> = [];
vi.mock('../environment/env-sessions', () => ({
  SHARED_LINE_SEGMENT: 'shared',
  normalizeWorkspaceKey: (ws: string) => ws.replace(/\\/g, '/'),
  loadEnvSessionsMap: () => ({
    version: 1,
    lines: Object.fromEntries(envSessionsLines),
  }),
  retargetEnvSessionLines: async (loopSessionId: string, segment: string) => {
    retargetCalls.push({ loopSessionId, segment });
  },
}));

const ownershipData = new Map<string, { owner?: string; shared?: boolean; updatedAt: string }>();
vi.mock('./line-ownership', () => ({
  getLineOwnership: (id: string) => ownershipData.get(id),
  setLineShared: async (id: string, shared: boolean, owner?: string) => {
    const prev = ownershipData.get(id) ?? { updatedAt: '' };
    ownershipData.set(id, { ...prev, shared, ...(owner !== undefined ? { owner } : {}) });
  },
}));

import { handleLineList, handleLineShare, handleLineUnshare } from './line-admin';
import { withLogContext } from '../logger-context';

function asActor<T>(name: string, role: 'readonly' | 'operator' | 'reviewer', fn: () => T): T {
  return withLogContext({ actorName: name, actorRole: role }, fn);
}

beforeEach(() => {
  vi.clearAllMocks();
  envSessionsLines.clear();
  ownershipData.clear();
  retargetCalls.length = 0;
  resolveLineAddressMock.mockReturnValue('known');
  getActiveLoopSessionIdMock.mockReturnValue('ls-active');
});

describe('line/list(双线制清单投影)', () => {
  it('归属段/owner/shared/live/busy/当前线标记逐行投影;旧键记 legacy', () => {
    envSessionsLines.set('E:/ws::alice::env:pwn-vm', { loopSessionId: 'ls-1', updatedAt: 'u1' });
    envSessionsLines.set('E:/ws::shared::host', { loopSessionId: 'ls-2', updatedAt: 'u2' });
    envSessionsLines.set('E:/ws::env:old', { loopSessionId: 'ls-3', updatedAt: 'u3' }); // 旧两段式
    envSessionsLines.set('E:/other::host', { loopSessionId: 'ls-9', updatedAt: 'u9' }); // 别的 workspace
    ownershipData.set('ls-1', { owner: 'alice', updatedAt: '' });
    ownershipData.set('ls-2', { owner: 'alice', shared: true, updatedAt: '' });
    hasLiveEngineMock.mockImplementation((...args: unknown[]) => args[0] === 'ls-2');
    getLiveEngineStateMock.mockReturnValue({ sessionState: 'running', queue: [] });
    getActiveLoopSessionIdMock.mockReturnValue('ls-1');

    const r = handleLineList({ workspace: 'E:/ws' });
    expect(r.success).toBe(true);
    const lines = (r.data as { lines: Array<Record<string, unknown>> }).lines;
    expect(lines).toHaveLength(3);
    const byId = Object.fromEntries(lines.map((l) => [String(l.loopSessionId), l]));
    expect(byId['ls-1']).toMatchObject({ envKey: 'env:pwn-vm', segment: 'alice', owner: 'alice', shared: false, live: false, active: true });
    expect(byId['ls-2']).toMatchObject({ envKey: 'host', segment: 'shared', shared: true, live: true, busy: true, active: false });
    expect(byId['ls-3']).toMatchObject({ envKey: 'env:old', segment: 'legacy', owner: null, shared: false });
  });

  it('他人的私有线不出现在非主非 reviewer 的清单里(读权限即清单可见性)', () => {
    envSessionsLines.set('E:/ws::alice::env:pwn-vm', { loopSessionId: 'ls-1', updatedAt: 'u1' });
    envSessionsLines.set('E:/ws::shared::host', { loopSessionId: 'ls-2', updatedAt: 'u2' });
    ownershipData.set('ls-1', { owner: 'alice', updatedAt: '' });
    ownershipData.set('ls-2', { owner: 'alice', shared: true, updatedAt: '' });
    const r = asActor('bob', 'operator', () => handleLineList({ workspace: 'E:/ws' }));
    const lines = (r.data as { lines: Array<Record<string, unknown>> }).lines;
    // bob 看不到 alice 的私有线,共享线可见
    expect(lines.map((l) => l.loopSessionId)).toEqual(['ls-2']);
    // reviewer 全可见
    const r2 = asActor('carol', 'reviewer', () => handleLineList({ workspace: 'E:/ws' }));
    expect((r2.data as { lines: unknown[] }).lines).toHaveLength(2);
  });
});

describe('line/share(私有 → 共享)', () => {
  it('owner 可共享自己的线:shared 落位 + 映射重挂 shared 段 + owner 保留', async () => {
    ownershipData.set('ls-1', { owner: 'alice', updatedAt: '' });
    const r = await asActor('alice', 'operator', () => handleLineShare({ loopSessionId: 'ls-1' }));
    expect(r.success).toBe(true);
    expect(ownershipData.get('ls-1')).toMatchObject({ owner: 'alice', shared: true });
    expect(retargetCalls).toEqual([{ loopSessionId: 'ls-1', segment: 'shared' }]);
  });

  it('reviewer 可共享任何线(含归属未知旧线)', async () => {
    const r = await asActor('carol', 'reviewer', () => handleLineShare({ loopSessionId: 'ls-legacy' }));
    expect(r.success).toBe(true);
    expect(ownershipData.get('ls-legacy')?.shared).toBe(true);
  });

  it('非主非 reviewer(operator)→ forbidden;归属未知旧线仅 reviewer 可共享', async () => {
    ownershipData.set('ls-1', { owner: 'alice', updatedAt: '' });
    const r1 = await asActor('bob', 'operator', () => handleLineShare({ loopSessionId: 'ls-1' }));
    expect(r1).toMatchObject({ success: false, error: 'forbidden' });
    const r2 = await asActor('bob', 'operator', () => handleLineShare({ loopSessionId: 'ls-legacy' }));
    expect(r2).toMatchObject({ success: false, error: 'forbidden' });
    expect(retargetCalls).toEqual([]);
  });

  it('已共享 → 幂等 already;未知线 → not found;本机 actor → 放行', async () => {
    ownershipData.set('ls-1', { owner: 'alice', shared: true, updatedAt: '' });
    const r1 = await asActor('bob', 'operator', () => handleLineShare({ loopSessionId: 'ls-1' }));
    expect(r1).toMatchObject({ success: true });
    expect((r1.data as { already?: boolean }).already).toBe(true);
    resolveLineAddressMock.mockReturnValue('unknown');
    const r2 = await handleLineShare({ loopSessionId: 'ls-ghost' });
    expect(r2.success).toBe(false);
    // 本机(无 ALS 帧 = local)——单用户模式不设闸
    resolveLineAddressMock.mockReturnValue('known');
    ownershipData.set('ls-2', { owner: 'alice', updatedAt: '' });
    const r3 = await handleLineShare({ loopSessionId: 'ls-2' });
    expect(r3.success).toBe(true);
  });
});

describe('line/unshare(共享 → 私有,归属改登记为调用方)', () => {
  it('owner 取消共享:shared 落位 + owner=调用方 + 映射重挂调用方段', async () => {
    ownershipData.set('ls-1', { owner: 'alice', shared: true, updatedAt: '' });
    const r = await asActor('alice', 'operator', () => handleLineUnshare({ loopSessionId: 'ls-1' }));
    expect(r.success).toBe(true);
    expect(ownershipData.get('ls-1')).toMatchObject({ owner: 'alice', shared: false });
    expect(retargetCalls).toEqual([{ loopSessionId: 'ls-1', segment: 'alice' }]);
  });

  it('reviewer 取消他人共享的线 → 归属改登记为 reviewer 本人', async () => {
    ownershipData.set('ls-1', { owner: 'alice', shared: true, updatedAt: '' });
    const r = await asActor('carol', 'reviewer', () => handleLineUnshare({ loopSessionId: 'ls-1' }));
    expect(r.success).toBe(true);
    expect(ownershipData.get('ls-1')).toMatchObject({ owner: 'carol', shared: false });
    expect(retargetCalls).toEqual([{ loopSessionId: 'ls-1', segment: 'carol' }]);
  });

  it('非主非 reviewer → forbidden;非共享线 → 幂等 already', async () => {
    ownershipData.set('ls-1', { owner: 'alice', shared: true, updatedAt: '' });
    const r1 = await asActor('bob', 'operator', () => handleLineUnshare({ loopSessionId: 'ls-1' }));
    expect(r1).toMatchObject({ success: false, error: 'forbidden' });
    ownershipData.set('ls-2', { owner: 'alice', updatedAt: '' });
    const r2 = await asActor('bob', 'operator', () => handleLineUnshare({ loopSessionId: 'ls-2' }));
    expect((r2.data as { already?: boolean }).already).toBe(true);
  });
});
