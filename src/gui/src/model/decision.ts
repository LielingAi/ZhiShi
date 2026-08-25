/**
 * 决策面板的展示映射与登记表归约（1.3.2 任务一，纯函数）。
 *
 * 服务端契约（src/server/loop/decision.ts）：
 *   - SSE `chat:decision-request` payload = { decisionId, question, options, expertHits }
 *     expertHits 是摘要行数组：命中行形如
 *     `E#<id> [domain/kind] title | 适用条件: … | 判据: …`；
 *     未命中 = 恰好一条「库中无基准」（库边界标注——查不到≠不存在，
 *     语义原样呈现，不改成「库中没有」）。
 *   - 应答端点 POST /chat/decision/respond { decisionId, choice, note? }
 *     unknown→404、已答→409。
 *   - SSE `chat:decision-resolved` { decisionId, choice, note?, expertRefs? }。
 *   - /chat/stream 每次(重)连重放全部 pending 决策——GUI 必须按
 *     decisionId 去重（upsert 幂等，本模块）。
 *
 * 纯函数：不 import store / React / client；单测逐函数断言。
 */

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** 库边界标注（与服务端 NO_BASELINE_MARK 同值——展示时原样呈现该语义）。 */
export const NO_BASELINE_MARK = '库中无基准';

/** pending 决策登记条目（SSE chat:decision-request 的 GUI 侧形状）。 */
export interface DecisionPending {
  decisionId: string;
  question: string;
  options: string[];
  expertHits: string[];
  /** GUI 本地登记时间（排序/展示用）。 */
  receivedAt: number;
}

/** chat:decision-request 的 payload 视图（未知字段宽进）。 */
export interface DecisionRequestView {
  decisionId?: unknown;
  question?: unknown;
  options?: unknown;
  expertHits?: unknown;
}

// ---------------------------------------------------------------------------
// 登记表归约（request → upsert / resolved → remove；重连重放按 id 去重）
// ---------------------------------------------------------------------------

/** chat:decision-request → 登记（幂等 upsert，按 decisionId——重连重放去重）。 */
export function upsertDecision(
  decisions: DecisionPending[],
  view: DecisionRequestView,
  receivedAt = Date.now(),
): DecisionPending[] {
  const decisionId = typeof view.decisionId === 'string' ? view.decisionId : '';
  if (!decisionId) return decisions;
  const entry: DecisionPending = {
    decisionId,
    question: typeof view.question === 'string' ? view.question : '',
    options: Array.isArray(view.options)
      ? view.options.filter((o): o is string => typeof o === 'string')
      : [],
    expertHits: Array.isArray(view.expertHits)
      ? view.expertHits.filter((o): o is string => typeof o === 'string')
      : [],
    receivedAt,
  };
  const existing = decisions.find((d) => d.decisionId === decisionId);
  if (existing) return decisions.map((d) => (d.decisionId === decisionId ? entry : d));
  return [...decisions, entry];
}

/** chat:decision-resolved / 本地应答成功后移除（按 decisionId，幂等）。 */
export function removeDecision(
  decisions: DecisionPending[],
  decisionId: unknown,
): DecisionPending[] {
  if (typeof decisionId !== 'string' || !decisionId) return decisions;
  return decisions.filter((d) => d.decisionId !== decisionId);
}

/** 待答列表是否包含某 decisionId（应答幂等守卫）。 */
export function hasDecision(decisions: DecisionPending[], decisionId: unknown): boolean {
  return typeof decisionId === 'string' && decisions.some((d) => d.decisionId === decisionId);
}

// ---------------------------------------------------------------------------
// 专家依据区：摘要行 → 徽章 + 文本（「库中无基准」特殊样式）
// ---------------------------------------------------------------------------

export type ExpertHit =
  | { kind: 'hit'; ref?: string; text: string }
  | { kind: 'no-baseline' };

const EXPERT_REF_RE = /^E#(\d+)\s+(.*)$/;

/**
 * 单条摘要行 → 渲染模型。
 *   - `E#12 [binary/technique] … | 适用条件: … | 判据: …` → hit（E#N 徽章 + 文本）
 *   - 恰好「库中无基准」→ no-baseline（特殊样式，语义原样）
 *   - 其它非 E# 行 → hit 无徽章、文本原样（前向兼容服务端摘要行变体）
 */
export function parseExpertHit(line: string): ExpertHit {
  const trimmed = line.trim();
  if (trimmed === NO_BASELINE_MARK) return { kind: 'no-baseline' };
  const m = EXPERT_REF_RE.exec(trimmed);
  if (m) return { kind: 'hit', ref: `E#${m[1]}`, text: m[2] };
  return { kind: 'hit', text: trimmed };
}

// ---------------------------------------------------------------------------
// 选项快捷键（a/b/c… 前 26 项；之后 1/2/3… 数字）
// ---------------------------------------------------------------------------

/** 选项快捷键标注：index 0 → 'a'，…，25 → 'z'，26+ → 数字 '27'。 */
export function optionHotkey(index: number): string {
  if (index >= 0 && index < 26) return String.fromCharCode(97 + index);
  return String(index + 1);
}

/** 按键 → 选项下标（a-z / 数字；未知键返回 null）。 */
export function optionHotkeyIndex(key: string): number | null {
  const k = key.toLowerCase();
  if (k.length === 1 && k >= 'a' && k <= 'z') return k.charCodeAt(0) - 97;
  if (/^[1-9][0-9]*$/.test(k)) {
    const n = Number(k) - 1;
    return n >= 26 ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 决策块正文解析（wire 正文 = 「【人的决定】\n问题: …\n选择: …\n备注: …」）
// ---------------------------------------------------------------------------

export interface DecisionBodyParts {
  question?: string;
  choice?: string;
  note?: string;
}

const PART_KEYS: Record<string, keyof DecisionBodyParts> = {
  问题: 'question',
  选择: 'choice',
  备注: 'note',
};

/** 决策块正文 → 结构化字段（问题/选择/备注；未识别行忽略）。 */
export function parseDecisionBody(text: string): DecisionBodyParts {
  const parts: DecisionBodyParts = {};
  for (const line of text.split('\n')) {
    const m = /^([^:：]+)[:：]\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = PART_KEYS[m[1].trim()];
    if (key) parts[key] = m[2].trim();
  }
  return parts;
}
