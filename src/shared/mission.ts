/**
 * 1.6.8 — 任务形态（mission）：打法轴，与研究域（domain，对象轴）正交。
 *
 * 挂载会话线（不挂环境——环境是场地，会话才是工作；env-sessions 分线天然
 * 成立）。缺省无类型 = 现状（域信号推导，行为零变化）。挖掘（discover）=
 * 战役形态的唯一入口（设计稿 docs/design/discovery-campaign.md §2.5）。
 */

export const MISSION_KINDS = ['discover', 'exploit', 'reproduce', 'ctf'] as const;

export type MissionKind = (typeof MISSION_KINDS)[number];

/** 无类型 = undefined（不落盘，存量零迁移）。 */
export function isMissionKind(v: unknown): v is MissionKind {
  return typeof v === 'string' && (MISSION_KINDS as readonly string[]).includes(v);
}

export const MISSION_LABELS: Record<MissionKind, string> = {
  discover: '挖掘',
  exploit: '利用',
  reproduce: '复现',
  ctf: 'CTF',
};
