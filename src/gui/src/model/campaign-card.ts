/**
 * 第三批 v4 落地——战役对象卡纯函数层（CampaignCard 组件的数据面）。
 *
 * 选中战役行的详情从「信号文本列表」升级为结构化对象卡：FSM 轨道
 * （四段相位）、墙钟预算、采样摘要、崩溃类 chips、信号 feed（倒序 +
 * outcome 置顶）。全部纯函数：不 import store / React / client，可单测。
 *
 * 相位不推断历史：状态机可循环（running→plateau→running→triaging…），
 * 服务端记录只带当前态，故活跃态只标当前段 on、其余 todo（不造假进度）；
 * paused 全 todo 附 halted（渲染层标挂起待人）；completed/stopped 全 done
 * 附 terminal（渲染层用终态行替代轨道）。
 */

import { campaignSpentMs, type CampaignRecordLike, type CampaignSignalLike, type CampaignState } from './campaign';

// ---------------------------------------------------------------------------
// FSM 轨道（盲跑 → 破冰 → 分拣 → 深挖 主回路）
// ---------------------------------------------------------------------------

export type FsmTrackKey = 'running' | 'plateau' | 'triaging' | 'deepening';
export type FsmPhase = 'done' | 'on' | 'todo';

export interface FsmTrackItem {
  key: FsmTrackKey;
  /** 段中文短名（轨道节空间窄——「盲跑」而非「盲跑中」）。 */
  label: string;
  phase: FsmPhase;
}

export interface FsmTrack {
  items: FsmTrackItem[];
  /** paused：轨道全部 todo 且挂起待人。 */
  halted: boolean;
  /** completed/stopped：终态收尾（渲染层用终态行替代轨道）。 */
  terminal: boolean;
}

/** 四段固定序 = 状态机主回路顺序。 */
export const FSM_TRACK_LABELS: Record<FsmTrackKey, string> = {
  running: '盲跑',
  plateau: '破冰',
  triaging: '分拣',
  deepening: '深挖',
};

const FSM_TRACK_KEYS = Object.keys(FSM_TRACK_LABELS) as FsmTrackKey[];

export function fsmTrackOf(state: CampaignState): FsmTrack {
  // 活跃态：只标当前段 on——历史不可推断（循环态），其余保持 todo。
  if (state === 'running' || state === 'plateau' || state === 'triaging' || state === 'deepening') {
    return {
      items: FSM_TRACK_KEYS.map((key) => ({
        key,
        label: FSM_TRACK_LABELS[key],
        phase: key === state ? 'on' : 'todo',
      })),
      halted: false,
      terminal: false,
    };
  }
  // paused：预算耗尽挂起——不标任何段（续命后从恢复态重新 on）。
  if (state === 'paused') {
    return {
      items: FSM_TRACK_KEYS.map((key) => ({ key, label: FSM_TRACK_LABELS[key], phase: 'todo' })),
      halted: true,
      terminal: false,
    };
  }
  // 终态：全段 done 式收尾（相位对终态无业务含义，给渲染层一个确定形状）。
  return {
    items: FSM_TRACK_KEYS.map((key) => ({ key, label: FSM_TRACK_LABELS[key], phase: 'done' })),
    halted: false,
    terminal: true,
  };
}

// ---------------------------------------------------------------------------
// 墙钟预算
// ---------------------------------------------------------------------------

export interface WallBudget {
  /** 已耗墙钟（ms）；running 段按传入 now 续算，与 campaignSpentMs 同口径。 */
  spentMs: number;
  /** 墙钟预算（ms）；缺省 null——渲染层只显文字不画进度条。 */
  budgetMs: number | null;
  /** 已耗百分比 0-100；预算缺省/非正 → null（除零防护），超耗封顶 100。 */
  pct: number | null;
}

export function wallBudgetOf(rec: CampaignRecordLike, now: number = Date.now()): WallBudget {
  const spentMs = campaignSpentMs(rec, now);
  const budgetMs = rec.wallBudgetMs ?? null;
  const pct =
    budgetMs !== null && budgetMs > 0 ? Math.min(100, Math.max(0, Math.round((spentMs / budgetMs) * 100))) : null;
  return { spentMs, budgetMs, pct };
}

// ---------------------------------------------------------------------------
// 采样摘要 / 信号 feed / 崩溃类 chips
// ---------------------------------------------------------------------------

/**
 * 采样摘要行「路径 N · 崩溃 N · N/s」。口径与 campaign.ts::campaignDetailText
 * 的 stats 回落一致（卡片独立装配，不再走信号文本列表）。
 * lastStats 缺省（或 paths/crashes 皆空）→ 空串，组件不渲染该行。
 */
export function statsLineOf(rec: CampaignRecordLike): string {
  const s = rec.lastStats;
  if (!s || (s.paths === undefined && s.crashes === undefined)) return '';
  const parts = [`路径 ${s.paths ?? 0}`, `崩溃 ${s.crashes ?? 0}`];
  if (s.execsPerSec !== undefined) parts.push(`${s.execsPerSec}/s`);
  return parts.join(' · ');
}

export interface SignalFeed {
  /** outcome 置顶 banner（无 → null）。 */
  banner: string | null;
  /** 信号史倒序（最新在前——feed 语义同聊天流，事件驱动非轮次驱动）。 */
  items: CampaignSignalLike[];
}

export function signalFeedOf(rec: CampaignRecordLike): SignalFeed {
  return { banner: rec.outcome ?? null, items: [...rec.signalLog].reverse() };
}

/** 崩溃类指纹 chips（无 → []，组件不渲染 chips 行）。 */
export function crashChipsOf(rec: CampaignRecordLike): string[] {
  return rec.crashClasses ?? [];
}
