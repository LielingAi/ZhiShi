/**
 * campaign.test.ts — 1.6.8 M2 战役观察卡片纯函数层单测。
 *
 * 覆盖：parseCampaignRecord(s) 窄化（非法行丢弃）、状态中文标签、
 * 动作分派（paused→resume / 活跃态→stop / 终态只读）、行装配（⚔ 标题
 * 截断 / 信号副行 / 墙钟+崩溃类结论行）、详情行（信号史 + outcome）。
 */
import { describe, expect, it } from 'vitest';

import {
  buildCampaignRows,
  campaignActionOf,
  campaignDetailLines,
  campaignDetailText,
  campaignRowOf,
  campaignSpentMs,
  campaignWallText,
  CAMPAIGN_STATE_LABELS,
  parseCampaignRecord,
  parseCampaignRecords,
  type CampaignRecordLike,
} from './campaign';

const BASE: CampaignRecordLike = {
  id: 'cmp-1',
  goal: '对 libxml2 跑 AFL 战役',
  state: 'running',
  wallBudgetMs: 2 * 60 * 60_000,
  spentWallMs: 35 * 60_000,
  signalLog: [],
};

describe('parseCampaignRecord(s)（campaign/list 窄化）', () => {
  it('完整行解析（含 lastStats / signalLog / crashClasses）', () => {
    const rec = parseCampaignRecord({
      id: 'cmp-1',
      goal: 'g',
      state: 'plateau',
      wallBudgetMs: 1000,
      spentWallMs: 500,
      runningSince: '2026-09-09T00:00:00Z',
      lastStats: { paths: 120, crashes: 3, execsPerSec: 4500, at: 1 },
      signalLog: [{ ts: 't1', kind: 'fuzz:plateau', detail: '连续 3 次采样无新路径' }],
      crashClasses: ['a', 'b'],
    });
    expect(rec).toMatchObject({
      id: 'cmp-1',
      state: 'plateau',
      lastStats: { paths: 120, crashes: 3, execsPerSec: 4500 },
      crashClasses: ['a', 'b'],
    });
    expect(rec?.signalLog).toHaveLength(1);
  });

  it('缺 id / 非法 state → null；数组输入整体过滤', () => {
    expect(parseCampaignRecord({ goal: 'g', state: 'running' })).toBeNull();
    expect(parseCampaignRecord({ id: 'x', state: 'nope' })).toBeNull();
    expect(parseCampaignRecord(null)).toBeNull();
    expect(parseCampaignRecords('not-array')).toEqual([]);
    expect(
      parseCampaignRecords([{ id: 'a', state: 'running' }, { bad: true }]).map((r) => r.id),
    ).toEqual(['a']);
  });
});

describe('动作分派与状态标签', () => {
  it('paused → resume；盲跑/介入三态 → stop；终态 → null（只读）', () => {
    expect(campaignActionOf('paused')).toBe('resume');
    for (const s of ['running', 'plateau', 'triaging', 'deepening'] as const) {
      expect(campaignActionOf(s)).toBe('stop');
    }
    expect(campaignActionOf('completed')).toBeNull();
    expect(campaignActionOf('stopped')).toBeNull();
  });

  it('七态中文标签齐备', () => {
    expect(Object.keys(CAMPAIGN_STATE_LABELS)).toHaveLength(7);
    expect(CAMPAIGN_STATE_LABELS.running).toBe('盲跑中');
    expect(CAMPAIGN_STATE_LABELS.paused).toBe('预算耗尽待人');
  });
});

describe('行装配（/tasks 战役卡片）', () => {
  it('⚔ 前缀 + goal 截断 40 + 状态标签 + 墙钟结论行', () => {
    const row = campaignRowOf({
      ...BASE,
      goal: '长'.repeat(50),
      crashClasses: ['x', 'y'],
    });
    expect(row.key).toBe('campaign:cmp-1');
    expect(row.source).toBe('campaign');
    expect(row.name.startsWith('⚔ ')).toBe(true);
    expect(row.name.length).toBeLessThanOrEqual(43); // ⚔ + 空格 + 40 + …
    expect(row.status).toBe('盲跑中');
    expect(row.conclusion).toBe('墙钟 35 分 / 2 小时 · 崩溃类 2');
    expect(row.transcriptable).toBe(false); // 无信号史
    expect(row.campaignId).toBe('cmp-1');
  });

  it('副行：最近信号 detail 优先，回落 lastStats 摘要', () => {
    const withSignal = campaignDetailText({
      ...BASE,
      lastStats: { paths: 1, crashes: 2 },
      signalLog: [{ kind: 'fuzz:new-crash', detail: '新崩溃 +2（crash-7）' }],
    });
    expect(withSignal).toBe('新崩溃 +2（crash-7）');
    const statsOnly = campaignDetailText({ ...BASE, lastStats: { paths: 10, crashes: 1, execsPerSec: 3000 } });
    expect(statsOnly).toBe('路径 10 · 崩溃 1 · 3000/s');
    expect(campaignDetailText(BASE)).toBe('');
  });

  it('running 段墙钟按 now 续算；paused 不续算', () => {
    const now = Date.parse('2026-09-09T01:00:00Z');
    const running = { ...BASE, runningSince: '2026-09-09T00:30:00Z' };
    expect(campaignSpentMs(running, now)).toBe(65 * 60_000);
    expect(campaignWallText(running, now)).toBe('墙钟 1 小时 5 分 / 2 小时');
    const paused = { ...running, state: 'paused' as const };
    expect(campaignSpentMs(paused, now)).toBe(35 * 60_000);
  });

  it('buildCampaignRows 原序透传（records 已是时间倒序）', () => {
    const rows = buildCampaignRows([BASE, { ...BASE, id: 'cmp-2' }]);
    expect(rows.map((r) => r.campaignId)).toEqual(['cmp-1', 'cmp-2']);
  });
});

describe('campaignDetailLines（选中行详情）', () => {
  it('信号史逐条 + outcome 收尾；无信号史 → 空/仅 outcome', () => {
    const lines = campaignDetailLines({
      ...BASE,
      signalLog: [
        { ts: 't1', kind: 'fuzz:plateau', detail: '平台期' },
        { ts: 't2', kind: 'intervention', detail: '破冰回合' },
      ],
      outcome: '达成判据',
    });
    expect(lines).toEqual([
      { role: 'fuzz:plateau', content: 't1 平台期' },
      { role: 'intervention', content: 't2 破冰回合' },
      { role: 'outcome', content: '达成判据' },
    ]);
    expect(campaignDetailLines(BASE)).toEqual([]);
  });
});
