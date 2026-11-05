/**
 * recall-pins 单测：行区间→消息下标换算、TTL、条数上限、reset 清理。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  RECALL_PIN_MAX_RANGES,
  RECALL_PIN_TTL_MS,
  clearRecallPins,
  getRecallPins,
  pinRecallLines,
  recallLinesToIndexRange,
} from './recall-pins';

afterEach(() => clearRecallPins());

describe('recall 取回钉住', () => {
  it('行区间 → 消息下标（行 1 是 meta，行 N ↔ 消息 N-2）', () => {
    expect(recallLinesToIndexRange('120-145')).toEqual({ start: 118, end: 144 });
    // 倒序容错 + 起始行 1 被钳到 2
    expect(recallLinesToIndexRange('145-120')).toEqual({ start: 118, end: 144 });
    expect(recallLinesToIndexRange('1-3')).toEqual({ start: 0, end: 2 });
    expect(recallLinesToIndexRange('abc')).toBeNull();
  });

  it('同一区间重复取回只刷新时间，不重复占位', () => {
    pinRecallLines('s1', '10-20', 1000);
    pinRecallLines('s1', '10-20', 2000);
    expect(getRecallPins('s1', 2000)).toEqual([{ start: 8, end: 19 }]);
  });

  it('超过 TTL 自动失效', () => {
    pinRecallLines('s2', '10-20', 1000);
    expect(getRecallPins('s2', 1000 + RECALL_PIN_TTL_MS - 1)).toHaveLength(1);
    expect(getRecallPins('s2', 1000 + RECALL_PIN_TTL_MS + 1)).toHaveLength(0);
  });

  it('条数上限：只留最新的 N 条', () => {
    for (let i = 0; i < RECALL_PIN_MAX_RANGES + 3; i++) {
      pinRecallLines('s3', `${10 + i * 10}-${20 + i * 10}`, 1000 + i);
    }
    expect(getRecallPins('s3', 5000)).toHaveLength(RECALL_PIN_MAX_RANGES);
    // 最新的那条一定在
    const last = RECALL_PIN_MAX_RANGES + 2;
    expect(getRecallPins('s3', 5000)).toContainEqual({ start: 8 + last * 10, end: 19 + last * 10 });
  });

  it('按会话隔离，reset 清空', () => {
    pinRecallLines('s4', '10-20', 1000);
    pinRecallLines('s5', '30-40', 1000);
    expect(getRecallPins('s4', 1000)).toHaveLength(1);
    clearRecallPins('s4');
    expect(getRecallPins('s4', 1000)).toHaveLength(0);
    expect(getRecallPins('s5', 1000)).toHaveLength(1);
    clearRecallPins();
    expect(getRecallPins('s5', 1000)).toHaveLength(0);
  });

  it('非法行区间 / 空区间不登记', () => {
    expect(pinRecallLines('s6', 'abc')).toBe(false);
    expect(pinRecallLines('s6', '1-1')).toBe(false);
    expect(getRecallPins('s6')).toHaveLength(0);
  });
});
