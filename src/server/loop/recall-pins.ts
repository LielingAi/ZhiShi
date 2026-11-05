/**
 * recall 取回钉住（2026-11-05 实机）。
 *
 * 病：长会话里模型每轮先 `recall` 取回几段原文，取回来的内容下一轮就被窗口
 * 置换挤出去，于是它再取一次——「取回 → 挤出 → 再取回」自循环，正文永远
 * 只剩 2.5k token，模型表现为一直在「对账」不干活。
 *
 * 药：取回的行区间转成消息下标区间记成 pin，窗口置换时命中的段强制保留、
 * 且不参与剪枝；pin 有时间上限（默认 20 分钟）和条数上限（默认 4 条），
 * 免得越钉越多把预算吃死。
 */

import { parseRecallLineRange } from './recall';

export interface RecallPin {
  /** 消息下标区间（闭开 [start, end)）。 */
  start: number;
  end: number;
  /** 登记时刻（毫秒）。 */
  at: number;
}

/** pin 存活时长：够模型在接下来几轮里用上取回的内容，又不至于永久占位。 */
export const RECALL_PIN_TTL_MS = 20 * 60_000;
/** 同时钉住的区间上限（超出丢最老的）。 */
export const RECALL_PIN_MAX_RANGES = 4;

const pins = new Map<string, RecallPin[]>();

/** 行区间 → 消息下标区间（jsonl 行 1 是 meta，行 N ↔ 消息 N-2）。 */
export function recallLinesToIndexRange(lines: string): { start: number; end: number } | null {
  const range = parseRecallLineRange(lines);
  if (!range) return null;
  return { start: range.start - 2, end: range.end - 1 };
}

/** recall 成功后登记一条 pin（同一区间重复取回只刷新时间）。 */
export function pinRecallLines(sessionId: string, lines: string, now = Date.now()): boolean {
  const range = recallLinesToIndexRange(lines);
  if (!range || range.end <= range.start) return false;
  const list = (pins.get(sessionId) ?? []).filter(
    (p) => !(p.start === range.start && p.end === range.end) && now - p.at < RECALL_PIN_TTL_MS,
  );
  list.push({ ...range, at: now });
  // 超上限丢最老的
  list.sort((a, b) => a.at - b.at);
  pins.set(sessionId, list.slice(-RECALL_PIN_MAX_RANGES));
  return true;
}

/** 当前仍有效的钉住区间（窗口置换每次调用时现取）。 */
export function getRecallPins(sessionId: string, now = Date.now()): Array<{ start: number; end: number }> {
  const list = pins.get(sessionId);
  if (!list) return [];
  const alive = list.filter((p) => now - p.at < RECALL_PIN_TTL_MS);
  if (alive.length === 0) {
    pins.delete(sessionId);
    return [];
  }
  if (alive.length !== list.length) pins.set(sessionId, alive);
  return alive.map(({ start, end }) => ({ start, end }));
}

/** 清空（会话 reset / 测试用）。不传 sessionId = 全清。 */
export function clearRecallPins(sessionId?: string): void {
  if (sessionId === undefined) pins.clear();
  else pins.delete(sessionId);
}
