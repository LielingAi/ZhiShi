/**
 * 1.6.8 M2 — 战役本体（campaign.ts）+ 运行时（campaign-runtime.ts）单测。
 *
 * 纯函数层：状态机转移表 / 墙钟预算（扣暂停）/ 平台期判定 / 新崩溃游标 /
 * 信号史上限 / 存储 roundtrip。运行时层：tick 的四个分支（新崩溃 → triaging
 * 介入、平台期 streak 达阈 → plateau 介入、墙钟耗尽 → paused、采样通道失败
 * 跳过不误判）+ 介入回合结束回 running + 单实例闸/幂等起跑 + stop/resume。
 * 全部注入假依赖，零真通道零真模型零真盘（存储用临时目录）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  appendCampaignSignal,
  campaignWallSpent,
  CAMPAIGN_SIGNAL_LOG_MAX,
  canTransition,
  createCampaignRecord,
  isCampaignWallExhausted,
  judgeNewCrashes,
  judgePlateau,
  listCampaignRecords,
  loadCampaignRecord,
  parseCampaignRecord,
  PLATEAU_STREAK_THRESHOLD,
  saveCampaignRecord,
  transitionCampaign,
  type CampaignRecord,
} from './campaign';
import {
  buildCrashInterventionText,
  buildPlateauInterventionText,
  maybeStartCampaign,
  parseFuzzerStats,
  resetCampaignRegistryForTest,
  resumeCampaign,
  startCampaign,
  stopCampaign,
  activeCampaignForLine,
  type CampaignRuntimeDeps,
} from './campaign-runtime';

const tempDirs: string[] = [];
function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'zhishi-campaign-test-'));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  resetCampaignRegistryForTest();
});
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<CampaignRecord> = {}): CampaignRecord {
  // overrides 是记录级覆盖（createCampaignRecord 的输入白名单不管这些字段）
  return {
    ...createCampaignRecord({ workspace: '/w', envId: 'e1', loopSessionId: 'ls-1', goal: '挖 cJSON' }),
    ...overrides,
  };
}

describe('campaign 状态机（纯函数）', () => {
  it('合法转移表：running 全向；介入态回 running；终态无出边', () => {
    expect(canTransition('running', 'plateau')).toBe(true);
    expect(canTransition('plateau', 'running')).toBe(true);
    expect(canTransition('triaging', 'deepening')).toBe(true);
    expect(canTransition('paused', 'running')).toBe(true);
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('stopped', 'running')).toBe(false);
  });

  it('非法转移抛错（不停机）', () => {
    const r = makeRecord({ state: 'completed' });
    expect(() => transitionCampaign(r, 'running')).toThrow('非法状态转移');
  });

  it('墙钟记账：离开 running 结算、paused 不计、再进 running 开新锚', () => {
    const t0 = '2026-09-09T00:00:00Z';
    const t1 = '2026-09-09T01:00:00Z'; // +1h
    const t2 = '2026-09-09T03:00:00Z'; // +2h（paused 段）
    const t3 = '2026-09-09T04:30:00Z'; // +1.5h
    let r = makeRecord({ startedAt: t0, runningSince: t0 });
    r = transitionCampaign(r, 'paused', { ts: t1 });
    expect(r.spentWallMs).toBe(3_600_000);
    expect(r.runningSince).toBeUndefined();
    // paused 段不计
    expect(campaignWallSpent(r, new Date(t2).getTime())).toBe(3_600_000);
    r = transitionCampaign(r, 'running', { ts: t2 });
    expect(campaignWallSpent(r, new Date(t3).getTime())).toBe(3_600_000 + 5_400_000);
  });

  it('预算耗尽判定（含进行中 running 段）', () => {
    const t0 = Date.now() - 25 * 60 * 60_000;
    const r = makeRecord({ wallBudgetMs: 24 * 60 * 60_000, startedAt: new Date(t0).toISOString(), runningSince: new Date(t0).toISOString() });
    expect(isCampaignWallExhausted(r)).toBe(true);
  });
});

describe('平台期/新崩溃判定（纯函数）', () => {
  it('judgePlateau：paths 涨清零，不涨累加，达阈触发', () => {
    let r = makeRecord();
    r = { ...r, lastStats: { paths: 10, crashes: 0, execsPerSec: 200, at: 1 } };
    let j = judgePlateau(r, { paths: 10, crashes: 0, execsPerSec: 200, at: 2 });
    expect(j).toEqual({ streak: 1, plateau: false });
    r = { ...r, plateauStreak: PLATEAU_STREAK_THRESHOLD - 1 };
    j = judgePlateau(r, { paths: 10, crashes: 0, execsPerSec: 200, at: 3 });
    expect(j.plateau).toBe(true);
    // 有进展清零
    j = judgePlateau(r, { paths: 11, crashes: 0, execsPerSec: 200, at: 4 });
    expect(j).toEqual({ streak: 0, plateau: false });
  });

  it('judgeNewCrashes：游标增量；倒退为零', () => {
    const r = makeRecord({ crashCursor: 3 });
    expect(judgeNewCrashes(r, 5)).toBe(2);
    expect(judgeNewCrashes(r, 2)).toBe(0);
  });

  it('信号史上限：超出截尾保留最新', () => {
    let log: CampaignRecord['signalLog'] = [];
    for (let i = 0; i < CAMPAIGN_SIGNAL_LOG_MAX + 10; i++) {
      log = appendCampaignSignal(log, { ts: String(i), kind: 'manual', detail: `s${i}` });
    }
    expect(log).toHaveLength(CAMPAIGN_SIGNAL_LOG_MAX);
    expect(log[log.length - 1]!.detail).toBe(`s${CAMPAIGN_SIGNAL_LOG_MAX + 9}`);
  });
});

describe('campaign 存储（薄 IO roundtrip）', () => {
  it('save → load → list；损坏文件不炸整表；非法记录 parse 拒绝', async () => {
    const dir = makeDir();
    const rec = makeRecord();
    await saveCampaignRecord(rec, { dir });
    expect(loadCampaignRecord(rec.id, { dir })?.goal).toBe('挖 cJSON');
    expect(listCampaignRecords({ dir })).toHaveLength(1);
    expect(parseCampaignRecord('{"id": 42}')).toBeNull();
    expect(parseCampaignRecord('not json')).toBeNull();
  });
});

describe('campaign-runtime（假依赖驱动）', () => {
  function makeDeps(overrides: Partial<CampaignRuntimeDeps> = {}): CampaignRuntimeDeps & { rounds: string[] } {
    const rounds: string[] = [];
    return {
      rounds,
      findEnv: () => null,
      envExec: () => Promise.resolve({ ok: false }),
      invokeRound: (input) => { rounds.push(input.text); return Promise.resolve({}); },
      pollMs: 10,
      ...overrides,
    };
  }

  it('起跑幂等（单实例闸：同线第二发返回 null）+ 注册表可见', async () => {
    const dir = makeDir();
    const deps = makeDeps({ storeDir: dir });
    const rec = await startCampaign(
      { workspace: '/w', envId: 'e1', loopSessionId: 'ls-1', goal: 'g' },
      deps,
    );
    expect(rec.state).toBe('running');
    expect(activeCampaignForLine('ls-1')?.id).toBe(rec.id);
    const again = await maybeStartCampaign(
      { workspace: '/w', envId: 'e1', loopSessionId: 'ls-1', goal: 'g2' },
      deps,
    );
    expect(again).toBeNull();
  });

  it('介入文本：平台期带计数/目标/判据；新崩溃带游标与委派指引', () => {
    const r = makeRecord({ plateauStreak: 3, lastStats: { paths: 42, crashes: 0, execsPerSec: 200, at: 1 }, baseTag: 'campaign-base' });
    const p = buildPlateauInterventionText(r);
    expect(p).toContain('平台期');
    expect(p).toContain('paths=42');
    expect(p).toContain('挖 cJSON');
    const c = buildCrashInterventionText(makeRecord({ crashCursor: 2 }), 3);
    expect(c).toContain('新增 3 个');
    expect(c).toContain('crash-triager');
    expect(c).toContain('delegate_task');
  });

  it('stop：活跃战役转 stopped + 注册表摘除 + 落盘；历史记录终态拒绝', async () => {
    const dir = makeDir();
    const deps = makeDeps({ storeDir: dir });
    const rec = await startCampaign({ workspace: '/w', envId: 'e1', loopSessionId: 'ls-9', goal: 'g' }, deps);
    const r = await stopCampaign(rec.id, { dir });
    expect(r.ok).toBe(true);
    expect(activeCampaignForLine('ls-9')).toBeUndefined();
    const saved = loadCampaignRecord(rec.id, { dir });
    expect(saved?.state).toBe('stopped');
    expect(saved?.signalLog.some((s) => s.kind === 'manual')).toBe(true);
    // 终态再停 → 拒绝
    const again = await stopCampaign(rec.id, { dir });
    expect(again.ok).toBe(false);
  });

  it('resume：非 paused 拒绝', async () => {
    const dir = makeDir();
    const deps = makeDeps({ storeDir: dir });
    const rec = await startCampaign({ workspace: '/w', envId: 'e1', loopSessionId: 'ls-10', goal: 'g' }, deps);
    const r = await resumeCampaign(rec.id, { dir });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不在暂停态');
  });

  it('tick：平台期 streak 达阈 → plateau 介入回合 → 回合结束回 running', async () => {
    const dir = makeDir();
    const entry = { id: 'e1', kind: 'vm' as const, vmName: 'v', address: '10.0.0.1', createdAt: '' };
    const statsText = 'saved_items     : 42\nsaved_crashes   : 0\nexecs_per_sec   : 204.42\n';
    const deps = makeDeps({
      storeDir: dir,
      findEnv: () => entry,
      envExec: (_e, cmd) => Promise.resolve(
        cmd.startsWith('cat ') ? { ok: true, stdout: statsText } : { ok: true, stdout: '0' },
      ),
      pollMs: 5,
    });
    const rec = await startCampaign({ workspace: '/w', envId: 'e1', loopSessionId: 'ls-tick', goal: '挖 cJSON' }, deps);
    // paths 恒 42（无新路径）→ streak 累加，达阈（3）触发 plateau 介入
    await new Promise((r) => setTimeout(r, 200));
    expect(deps.rounds.some((t) => t.includes('平台期'))).toBe(true);
    expect(deps.rounds.some((t) => t.includes('挖 cJSON'))).toBe(true);
    // 回合结束后回 running
    expect(activeCampaignForLine('ls-tick')?.state).toBe('running');
    const saved = loadCampaignRecord(rec.id, { dir });
    expect(saved?.signalLog.some((s) => s.kind === 'fuzz:plateau')).toBe(true);
    expect(saved?.signalLog.some((s) => s.kind === 'intervention')).toBe(true);
    await stopCampaign(rec.id, { dir });
  });

  it('tick：新崩溃 → triaging 介入（文本带委派 crash-triager 指引）', async () => {
    const dir = makeDir();
    const entry = { id: 'e1', kind: 'vm' as const, vmName: 'v', address: '10.0.0.1', createdAt: '' };
    const statsText = 'saved_items     : 42\nsaved_crashes   : 2\nexecs_per_sec   : 204\n';
    const deps = makeDeps({
      storeDir: dir,
      findEnv: () => entry,
      envExec: (_e, cmd) => Promise.resolve(
        cmd.startsWith('cat ') ? { ok: true, stdout: statsText } : { ok: true, stdout: '2' },
      ),
      pollMs: 5,
    });
    const rec = await startCampaign({ workspace: '/w', envId: 'e1', loopSessionId: 'ls-crash', goal: 'g' }, deps);
    await new Promise((r) => setTimeout(r, 200));
    expect(deps.rounds.some((t) => t.includes('新崩溃'))).toBe(true);
    expect(deps.rounds.some((t) => t.includes('crash-triager'))).toBe(true);
    await stopCampaign(rec.id, { dir });
  });

  it('tick：采样通道失败（stats/crashes 全 null）→ 跳过不误判（无介入）', async () => {
    const dir = makeDir();
    const deps = makeDeps({ storeDir: dir, pollMs: 5 }); // findEnv → null
    const rec = await startCampaign({ workspace: '/w', envId: 'ghost', loopSessionId: 'ls-skip', goal: 'g' }, deps);
    await new Promise((r) => setTimeout(r, 100));
    expect(deps.rounds).toHaveLength(0);
    expect(activeCampaignForLine('ls-skip')?.state).toBe('running');
    await stopCampaign(rec.id, { dir });
  });

  it('tick：墙钟耗尽 → paused + 介入通知', async () => {
    const dir = makeDir();
    const deps = makeDeps({ storeDir: dir, pollMs: 5 });
    const rec = await startCampaign(
      { workspace: '/w', envId: 'e1', loopSessionId: 'ls-budget', goal: 'g', wallBudgetMs: 1 },
      deps,
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(activeCampaignForLine('ls-budget')?.state).toBe('paused');
    expect(deps.rounds.some((t) => t.includes('预算耗尽'))).toBe(true);
    await stopCampaign(rec.id, { dir });
  });
});

describe('parseFuzzerStats（afl fuzzer_stats 文本解析）', () => {
  it('关键字段齐 → 快照；缺字段 → null', () => {
    const s = parseFuzzerStats('saved_items     : 42\nsaved_crashes   : 3\nexecs_per_sec   : 204.42\n', 100);
    expect(s).toEqual({ paths: 42, crashes: 3, execsPerSec: 204, at: 100 });
    expect(parseFuzzerStats('saved_items: 1\n', 1)).toBeNull();
  });
});
