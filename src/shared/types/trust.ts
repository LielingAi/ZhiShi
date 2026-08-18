/**
 * Trust ledger types — mirror of `src-tauri/src/trust.rs`（serde camelCase）。
 *
 * 信任账本（宪章 §5.1）：被验证的完成是存款，返工/否决是取款；
 * 跨过阈值挂起「建议」，采纳与否永远由用户决定（账本不写 config）。
 */

export interface TrustEvent {
  ts: number;
  taskId: string;
  taskName: string;
  /** 'deposit' | 'withdrawal' | 'decision' */
  kind: string;
  delta: number;
  /** 'user_done' | 'agent_done' | 'system_done' | 'rework' | 'user_stopped'
   *  | 'suggestion_accepted_<dir>' | 'suggestion_dismissed_<dir>' */
  reason: string;
  scoreAfter: number;
}

export interface TrustSuggestion {
  /** 'upgrade' | 'downgrade' */
  direction: string;
  createdAt: number;
}

export interface TrustLedger {
  version: number;
  score: number;
  /** 上次建议被处置时的分数基准；建议只看相对增量。 */
  baselineScore: number;
  events: TrustEvent[];
  suggestion: TrustSuggestion | null;
}

/** 与 trust.rs 的阈值常量保持一致（展示用）。 */
export const TRUST_UPGRADE_THRESHOLD = 10;
export const TRUST_DOWNGRADE_THRESHOLD = -6;
