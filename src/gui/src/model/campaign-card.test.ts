/**
 * campaign-card.test.ts — 第三批 v4 战役对象卡纯函数层单测。
 *
 * 覆盖：FSM 轨道七态相位（活跃态仅当前段 on、循环态不推断历史）、
 * paused 全 todo + halted、终态全 done + terminal、墙钟预算（预算缺省
 * pct=null、running 段按 now 续算、超耗封顶）、采样摘要行（缺省回落
 * 空串）、信号 feed 倒序 + outcome 置顶 banner、崩溃类 chips。
 */
import { describe, expect, it } from 'vitest';

import type { CampaignRecordLike } from './campaign';
import { crashChipsOf, fsmTrackOf, signalFeedOf, statsLineOf, wallBudgetOf } from './campaign-card';

const BASE: CampaignRecordLike = {
  id: 'cmp-1',
  goal: '对 libxml2 跑 AFL 战役',
  state: 'running',
  wallBudgetMs: 2 * 60 * 60_000,
  spentWallMs: 35 * 60_000,
  signalLog: [
    { ts: 't1', kind: 'fuzz:start', detail: '起爆' },
    { ts: 't2', kind: 'fuzz:plateau', detail: '平台期' },
    { ts: 't3', kind: 'intervention', detail: '破冰回合' },
  ],
};

describe('fsmTrackOf（FSM 轨道相位）', () => {
  it('活跃四态：仅当前段 on、其余 todo，不 halted 不 terminal', () => {
    const cases: Array<[CampaignRecordLike['state'], string]> = [
      ['running', 'running'],
      ['plateau', 'plateau'],
      ['triaging', 'triaging'],
      ['deepening', 'deepening'],
    ];
    for (const [state, onKey] of cases) {
      const track = fsmTrackOf(state);
      expect(track.halted).toBe(false);
      expect(track.terminal).toBe(false);
      expect(track.items.map((i) => i.key)).toEqual(['running', 'plateau', 'triaging', 'deepening']);
      for (const item of track.items) {
        expect(item.phase).toBe(item.key === onKey ? 'on' : 'todo');
      }
    }
  });

  it('循环态不推断历史：triaging 时前后段都 todo、无一标 done', () => {
    const track = fsmTrackOf('triaging');
    expect(track.items.find((i) => i.key === 'running')?.phase).toBe('todo');
    expect(track.items.find((i) => i.key === 'plateau')?.phase).toBe('todo');
    expect(track.items.find((i) => i.key === 'deepening')?.phase).toBe('todo');
    expect(track.items.every((i) => i.phase !== 'done')).toBe(true);
  });

  it('paused：全部 todo + halted（挂起待人），不 terminal', () => {
    const track = fsmTrackOf('paused');
    expect(track.halted).toBe(true);
    expect(track.terminal).toBe(false);
    expect(track.items.every((i) => i.phase === 'todo')).toBe(true);
  });

  it('completed/stopped：全部 done 式收尾 + terminal，不 halted', () => {
    for (const state of ['completed', 'stopped'] as const) {
      const track = fsmTrackOf(state);
      expect(track.terminal).toBe(true);
      expect(track.halted).toBe(false);
      expect(track.items.every((i) => i.phase === 'done')).toBe(true);
    }
  });

  it('段标签是中文短名（盲跑/破冰/分拣/深挖）', () => {
    expect(fsmTrackOf('running').items.map((i) => i.label)).toEqual(['盲跑', '破冰', '分拣', '深挖']);
  });
});

describe('wallBudgetOf（墙钟预算）', () => {
  it('spent 与 campaignSpentMs 同口径：running 段按 now 续算，pct 四舍五入', () => {
    const now = Date.parse('2026-09-09T01:00:00Z');
    const rec = { ...BASE, runningSince: '2026-09-09T00:30:00Z' };
    // 35 分 + 30 分 = 65 分；65/120 ≈ 54.2% → 54
    expect(wallBudgetOf(rec, now)).toEqual({
      spentMs: 65 * 60_000,
      budgetMs: 2 * 60 * 60_000,
      pct: 54,
    });
  });

  it('预算缺省：budgetMs=null、pct=null（组件只显文字不画条）', () => {
    const rec: CampaignRecordLike = { ...BASE, wallBudgetMs: undefined };
    const wall = wallBudgetOf(rec, 0);
    expect(wall.spentMs).toBe(35 * 60_000);
    expect(wall.budgetMs).toBeNull();
    expect(wall.pct).toBeNull();
  });

  it('预算非正：pct=null（除零防护）', () => {
    expect(wallBudgetOf({ ...BASE, wallBudgetMs: 0 }, 0).pct).toBeNull();
  });

  it('超耗封顶 100（paused 过冲不溢出进度条）', () => {
    const wall = wallBudgetOf({ ...BASE, spentWallMs: 130 * 60_000 }, 0);
    expect(wall.pct).toBe(100);
  });
});

describe('statsLineOf（采样摘要行）', () => {
  it('lastStats 齐备：「路径 N · 崩溃 N · N/s」', () => {
    expect(statsLineOf({ ...BASE, lastStats: { paths: 12, crashes: 3, execsPerSec: 4500 } })).toBe(
      '路径 12 · 崩溃 3 · 4500/s',
    );
  });

  it('缺 execsPerSec 省略速率段；lastStats 缺省/空 → 空串', () => {
    expect(statsLineOf({ ...BASE, lastStats: { paths: 12, crashes: 3 } })).toBe('路径 12 · 崩溃 3');
    expect(statsLineOf({ ...BASE, lastStats: undefined })).toBe('');
    expect(statsLineOf({ ...BASE, lastStats: {} })).toBe('');
  });
});

describe('signalFeedOf（信号 feed）', () => {
  it('signalLog 倒序（最新在前）', () => {
    const feed = signalFeedOf(BASE);
    expect(feed.items.map((s) => s.ts)).toEqual(['t3', 't2', 't1']);
  });

  it('outcome 置顶 banner；无 outcome → null', () => {
    expect(signalFeedOf({ ...BASE, outcome: '达成判据' }).banner).toBe('达成判据');
    expect(signalFeedOf(BASE).banner).toBeNull();
  });

  it('空信号史 → 空 feed（组件侧走 ov-empty 空态）', () => {
    const feed = signalFeedOf({ ...BASE, signalLog: [] });
    expect(feed.items).toEqual([]);
    expect(feed.banner).toBeNull();
  });
});

describe('crashChipsOf（崩溃类 chips）', () => {
  it('透传 crashClasses；无则 []（组件不渲染 chips 行）', () => {
    expect(crashChipsOf({ ...BASE, crashClasses: ['crash-7', 'crash-9'] })).toEqual(['crash-7', 'crash-9']);
    expect(crashChipsOf(BASE)).toEqual([]);
  });
});
