/**
 * 1.3.5 输入历史：子序列模糊评分 + per-env localStorage 落盘（纯函数层）。
 *
 * 评分器逐字移植自 TUI src/cli/tui/v2/history.ts:72-90 的
 * HistoryStore.score（fzf-lite 子序列评分：连续命中加成 + 词首/前缀命中
 * 加成；0 = 不匹配），仅把 `this.*` 静态方法改成纯函数导出。
 *
 * 落盘口径（评估报告 §4.4#5）：GUI **不复用** TUI 的 jsonl 文件，从自己的
 * localStorage 起步——按环境键分键存储（`zhishi.gui.inputHistory.<envKey>`），
 * 与 model/theme.ts 的持久化口径一致（读写异常静默回落）。
 *
 * 纯函数：不 import store / React / client；DOM 副作用（读写 localStorage）
 * 由 store 执行，这里只声明可注入 storage 的读写与评分。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 单环境输入历史条数上限（与 1.3.x GUI 内存版 200 条同口径）。 */
export const INPUT_HISTORY_LIMIT = 200;

/** 历史 overlay 一次最多展示条数。 */
export const INPUT_HISTORY_OVERLAY_LIMIT = 8;

const STORAGE_PREFIX = 'zhishi.gui.inputHistory';

/** localStorage 存储接口最小面（可注入单测）。 */
export interface HistoryStorage {
  getItem(key: string): string | null;
  setItem?(key: string, value: string): void;
}

/** per-env 存储键（env 键原样拼接；'host' 即宿主线）。 */
export function inputHistoryKey(envKey: string): string {
  return `${STORAGE_PREFIX}.${envKey}`;
}

// ---------------------------------------------------------------------------
// 模糊评分（TUI 移植，来源见文件头）
// ---------------------------------------------------------------------------

/**
 * 子序列模糊评分（fzf-lite）：高分优先。0 = 不匹配。
 * 加成：连续命中（run +2 递增）、词首命中（空白/:/@/- 之后 +3）、前缀命中。
 */
export function scoreHistory(query: string, candidate: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let qi = 0;
  let score = 0;
  let run = 0;
  let prevMatch = -2;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] === q[qi]) {
      run = prevMatch === i - 1 ? run + 2 : 0;
      score += 1 + run;
      if (i === 0 || /[\s/:@-]/.test(c[i - 1])) score += 3;
      prevMatch = i;
      qi++;
    }
  }
  return qi === q.length ? score : 0;
}

/**
 * 历史列表 → 按评分降序的候选（截断到 limit）。
 * - 空查询：全部命中（分数 1），保持原始顺序（列表为最新在前 → 最近优先）；
 * - 非空：只留 score > 0，高分在前；同分靠稳定排序保持最近优先。
 */
export function rankInputHistory(list: string[], query: string, limit: number): string[] {
  const q = query.trim();
  const scored: Array<{ text: string; score: number }> = [];
  for (const text of list) {
    const s = scoreHistory(q, text);
    if (s > 0) scored.push({ text, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.text);
}

// ---------------------------------------------------------------------------
// 落盘（per-env 键；读写异常静默——隐私模式等）
// ---------------------------------------------------------------------------

/** 读某环境的历史（非法 JSON / 非数组 / 非字符串条目一律回落空数组）。 */
export function loadInputHistory(
  storage: HistoryStorage | null | undefined,
  envKey: string,
): string[] {
  try {
    const raw = storage?.getItem(inputHistoryKey(envKey));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    return [];
  }
}

/** 写某环境的历史（失败静默）。 */
export function saveInputHistory(
  storage: HistoryStorage | null | undefined,
  envKey: string,
  list: string[],
): void {
  try {
    storage?.setItem?.(inputHistoryKey(envKey), JSON.stringify(list));
  } catch {
    // 静默。
  }
}

/** 前插新条目并截断到 limit（trim 后为空不入库——与 TUI append 同口径）。 */
export function prependHistory(list: string[], text: string, limit: number): string[] {
  const t = text.trim();
  if (!t) return list;
  return [t, ...list].slice(0, limit);
}
