/**
 * 1.6.8 M2 — 战役（campaign）观察卡片纯函数层：/tasks 第四源行装配。
 *
 * 设计稿 §6：观察面 = 既有 /tasks，不做独立面板。战役行并入任务中心
 * 清单（source 'campaign'，⚔ 前缀标识）；行内动作按状态分派：
 *   - running/plateau/triaging/deepening（盲跑/介入态）→ 可「终止」
 *   - paused（预算耗尽待人）→ 可「续命」（campaign/resume）
 *   - completed/stopped（终态）→ 只读
 *
 * 端点契约（src/server/loop/campaign.ts::CampaignRecord + admin-api
 * campaign/list|stop|resume）：时间倒序 records；signalLog 是信号史
 * （{ts, kind, detail}）；lastStats 是 fuzzer_stats 采样快照。
 *
 * 纯函数：不 import store / React / client；单测断言行装配与动作分派。
 */

import { formatMinutes } from './auto-run';
import type { TaskRow } from './tasks';

// ---------------------------------------------------------------------------
// 记录窄化（admin campaign/list 的 data.records 最小面）
// ---------------------------------------------------------------------------

export type CampaignState =
  | 'running'
  | 'plateau'
  | 'triaging'
  | 'deepening'
  | 'paused'
  | 'completed'
  | 'stopped';

/** 状态中文标签（介入三态带「介入中」，paused 显性化「待人」）。 */
export const CAMPAIGN_STATE_LABELS: Record<CampaignState, string> = {
  running: '盲跑中',
  plateau: '破冰介入中',
  triaging: '分拣介入中',
  deepening: '深挖介入中',
  paused: '预算耗尽待人',
  completed: '已完成',
  stopped: '已终止',
};

export interface CampaignSignalLike {
  ts?: string;
  kind?: string;
  detail?: string;
}

export interface CampaignRecordLike {
  id: string;
  goal: string;
  state: CampaignState;
  createdAt?: string;
  updatedAt?: string;
  /** 墙钟预算（ms）。 */
  wallBudgetMs?: number;
  /** 已耗墙钟（ms；paused 段不计）。 */
  spentWallMs?: number;
  /** 当前 running 段起点（ISO——spent 累计锚）。 */
  runningSince?: string;
  lastStats?: { paths?: number; crashes?: number; execsPerSec?: number; at?: number };
  signalLog: CampaignSignalLike[];
  /** 去重崩溃类指纹数（crashClasses.length）。 */
  crashClasses?: string[];
  outcome?: string;
}

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function numOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 服务端记录 → CampaignRecordLike（形状不合返回 null，调用方过滤）。 */
export function parseCampaignRecord(raw: unknown): CampaignRecordLike | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = strOf(r.id);
  const state = strOf(r.state);
  if (!id || !state || !(state in CAMPAIGN_STATE_LABELS)) return null;
  const stats =
    r.lastStats && typeof r.lastStats === 'object' && !Array.isArray(r.lastStats)
      ? (r.lastStats as Record<string, unknown>)
      : undefined;
  return {
    id,
    goal: strOf(r.goal) ?? '',
    state: state as CampaignState,
    createdAt: strOf(r.createdAt),
    updatedAt: strOf(r.updatedAt),
    wallBudgetMs: numOf(r.wallBudgetMs),
    spentWallMs: numOf(r.spentWallMs),
    runningSince: strOf(r.runningSince),
    ...(stats
      ? {
          lastStats: {
            paths: numOf(stats.paths),
            crashes: numOf(stats.crashes),
            execsPerSec: numOf(stats.execsPerSec),
            at: numOf(stats.at),
          },
        }
      : {}),
    signalLog: Array.isArray(r.signalLog)
      ? r.signalLog
          .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && !Array.isArray(s))
          .map((s) => ({ ts: strOf(s.ts), kind: strOf(s.kind), detail: strOf(s.detail) }))
      : [],
    ...(Array.isArray(r.crashClasses)
      ? { crashClasses: r.crashClasses.filter((x): x is string => typeof x === 'string') }
      : {}),
    outcome: strOf(r.outcome),
  };
}

/** data.records → 记录数组（非法行静默丢弃）。 */
export function parseCampaignRecords(raw: unknown): CampaignRecordLike[] {
  if (!Array.isArray(raw)) return [];
  const out: CampaignRecordLike[] = [];
  for (const item of raw) {
    const rec = parseCampaignRecord(item);
    if (rec) out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 行装配 + 动作分派
// ---------------------------------------------------------------------------

/** 行内动作分派：介入/盲跑态 → stop；paused → resume；终态 → null（只读）。 */
export function campaignActionOf(state: CampaignState): 'stop' | 'resume' | null {
  if (state === 'paused') return 'resume';
  if (state === 'completed' || state === 'stopped') return null;
  return 'stop';
}

/** 已耗墙钟（ms）——running 段进行中的部分按 now 续算（server campaignWallSpent 同口径）。 */
export function campaignSpentMs(r: CampaignRecordLike, now: number = Date.now()): number {
  const base = r.spentWallMs ?? 0;
  if (r.state === 'running' && r.runningSince) {
    const since = Date.parse(r.runningSince);
    if (Number.isFinite(since) && now > since) return base + (now - since);
  }
  return base;
}

/** 墙钟行值：「墙钟 35 分 / 2 小时」（预算缺省只显已耗）。 */
export function campaignWallText(r: CampaignRecordLike, now: number = Date.now()): string {
  const spent = formatMinutes(Math.round(campaignSpentMs(r, now) / 60000));
  const budget = r.wallBudgetMs !== undefined ? formatMinutes(Math.round(r.wallBudgetMs / 60000)) : undefined;
  return budget !== undefined ? `墙钟 ${spent} / ${budget}` : `墙钟 ${spent}`;
}

/** 采样/信号副行：最近一条信号 detail 优先，回落 lastStats 摘要。 */
export function campaignDetailText(r: CampaignRecordLike): string {
  const last = r.signalLog[r.signalLog.length - 1];
  if (last?.detail) return last.detail;
  const s = r.lastStats;
  if (s && (s.paths !== undefined || s.crashes !== undefined)) {
    const parts = [`路径 ${s.paths ?? 0}`, `崩溃 ${s.crashes ?? 0}`];
    if (s.execsPerSec !== undefined) parts.push(`${s.execsPerSec}/s`);
    return parts.join(' · ');
  }
  return '';
}

/** 战役记录 → /tasks 行（⚔ 前缀；标题 = goal 截断 40；conclusion = 墙钟 + 崩溃类数）。 */
export function campaignRowOf(r: CampaignRecordLike, now: number = Date.now()): TaskRow {
  const goal = r.goal.trim();
  const crashes = r.crashClasses?.length ?? 0;
  const wall = campaignWallText(r, now);
  return {
    key: `campaign:${r.id}`,
    source: 'campaign',
    name: `⚔ ${goal.length > 40 ? `${goal.slice(0, 40)}…` : goal}`,
    detail: campaignDetailText(r),
    status: CAMPAIGN_STATE_LABELS[r.state],
    conclusion: crashes > 0 ? `${wall} · 崩溃类 ${crashes}` : wall,
    transcriptable: r.signalLog.length > 0,
    campaignId: r.id,
    campaignState: r.state,
  };
}

/** 战役行集合（records 已是时间倒序，原序透传）。 */
export function buildCampaignRows(records: CampaignRecordLike[], now: number = Date.now()): TaskRow[] {
  return records.map((r) => campaignRowOf(r, now));
}

/**
 * 战役行详情（选中行的 transcript 视图内容）：信号史逐条 + 结果行，
 * 本地装配不走网络（信号史随 campaign/list 全量下发）。
 */
export function campaignDetailLines(r: CampaignRecordLike): Array<{ role: string; content: string }> {
  const lines = r.signalLog.map((s) => ({
    role: s.kind ?? 'signal',
    content: `${s.ts ?? ''} ${s.detail ?? ''}`.trim(),
  }));
  if (r.outcome) lines.push({ role: 'outcome', content: r.outcome });
  return lines;
}
