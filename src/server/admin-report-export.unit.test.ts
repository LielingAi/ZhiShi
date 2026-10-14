/**
 * report/export 接线单测（chain-audit 2026-10-14 #4）。
 *
 * 缺陷：导出读端调 getEnvSessionLine 不带 actor，命中不了三段式归属键
 * （workspace::actor/shared::env），新会话导出落空；且被导出线不过读闸。
 *
 * 钉死契约：findLoopSessionId 与会话选择同一 actor/线解析契约（带上
 * currentActor）；被导出线先过 canReadLine——私有线非主（且非 reviewer）
 * 导出返回 forbidden（routeAdminApi 映到 403），不调 exportReport。
 *
 * exportReport 本体是纯注入（report/export.unit.test.ts 已覆盖），这里只测
 * admin-api 的接线：env-sessions 用真实解析函数 + 注入内存 map，exportReport
 * 全 mock 捕获 deps。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const WS = 'E:/code/u-disk';
const ENV_KEY = 'env:test-env';

interface LineRec { loopSessionId: string; updatedAt: string }
type TestMap = { version: 1; lines: Record<string, LineRec> };

const envSessionsMocks = vi.hoisted(() => ({
  map: { version: 1 as const, lines: {} as Record<string, { loopSessionId: string; updatedAt: string }> } as TestMap,
}));
const lineOwnershipMocks = vi.hoisted(() => ({
  getLineOwnership: vi.fn((): { owner?: string; shared?: boolean; updatedAt: string } | undefined => undefined),
}));
const exportMocks = vi.hoisted(() => ({ exportReport: vi.fn() }));

vi.mock('./loop/chat-engine', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSessionEnv: () => undefined,
  resolveSessionEnvKey: () => ENV_KEY,
}));
vi.mock('./loop/pi-provider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveLoopModel: () => null,
}));
vi.mock('./environment/env-sessions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadEnvSessionsMap: () => envSessionsMocks.map,
}));
vi.mock('./loop/line-ownership', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLineOwnership: lineOwnershipMocks.getLineOwnership,
}));
vi.mock('./report/export', () => exportMocks);

import { handleReportExport } from './admin-api';
import { withLogContext } from './logger-context';

const ALICE = { actorName: 'alice', actorRole: 'operator', actorSource: 'token' } as const;
const BOB = { actorName: 'bob', actorRole: 'operator', actorSource: 'token' } as const;

function mapWith(lines: Record<string, string>): TestMap {
  const map: TestMap = { version: 1, lines: {} };
  for (const [key, loopSessionId] of Object.entries(lines)) {
    map.lines[key] = { loopSessionId, updatedAt: '2026-10-14T00:00:00.000Z' };
  }
  return map;
}

let capturedDeps: { findLoopSessionId: (ws: string) => string | undefined } | null;

beforeEach(() => {
  vi.clearAllMocks();
  capturedDeps = null;
  envSessionsMocks.map = mapWith({});
  lineOwnershipMocks.getLineOwnership.mockReturnValue(undefined);
  exportMocks.exportReport.mockImplementation(async (_args: unknown, deps: unknown) => {
    capturedDeps = deps as typeof capturedDeps;
    return { success: true, data: {} };
  });
});

describe('handleReportExport 线解析（chain-audit #4）', () => {
  it('仅有三段式新键（workspace::alice::env）时，带 actor 命中归属线', async () => {
    envSessionsMocks.map = mapWith({ [`${WS}::alice::${ENV_KEY}`]: 'ls-alice' });

    const r = await withLogContext(ALICE, () => handleReportExport({ workspace: WS }));

    expect(r.success).toBe(true);
    expect(exportMocks.exportReport).toHaveBeenCalledOnce();
    expect(capturedDeps!.findLoopSessionId(WS)).toBe('ls-alice');
  });

  it('旧两段式键落到 Alice 私有线（R3 回读）→ Bob 导出 forbidden，不调 exportReport', async () => {
    // 升级期混合态：旧键还在，但线已有归属记录——Bob 的解析链会落到这条
    // 私有线上，必须过读闸拦截（私有线 = owner + reviewer）。
    envSessionsMocks.map = mapWith({ [`${WS}::${ENV_KEY}`]: 'ls-alice' });
    lineOwnershipMocks.getLineOwnership.mockReturnValue({ owner: 'alice', updatedAt: '2026-10-14T00:00:00.000Z' });

    const r = await withLogContext(BOB, () => handleReportExport({ workspace: WS }));

    expect(r.success).toBe(false);
    expect(r.error).toBe('forbidden');
    expect(exportMocks.exportReport).not.toHaveBeenCalled();
  });

  it('归属未知旧线（两段式键 + 无归属记录）→ 维持旧行为放行', async () => {
    envSessionsMocks.map = mapWith({ [`${WS}::${ENV_KEY}`]: 'ls-legacy' });

    const r = await withLogContext(BOB, () => handleReportExport({ workspace: WS }));

    expect(r.success).toBe(true);
    expect(capturedDeps!.findLoopSessionId(WS)).toBe('ls-legacy');
  });

  it('reviewer 可读他人私有线 → 放行导出同一条线', async () => {
    envSessionsMocks.map = mapWith({ [`${WS}::${ENV_KEY}`]: 'ls-alice' });
    lineOwnershipMocks.getLineOwnership.mockReturnValue({ owner: 'alice', updatedAt: '2026-10-14T00:00:00.000Z' });
    const CAROL = { actorName: 'carol', actorRole: 'reviewer', actorSource: 'token' } as const;

    const r = await withLogContext(CAROL, () => handleReportExport({ workspace: WS }));

    expect(r.success).toBe(true);
    expect(capturedDeps!.findLoopSessionId(WS)).toBe('ls-alice');
  });
});
