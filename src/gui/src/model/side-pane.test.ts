/**
 * V4-S1 骨架壳纯函数层单测：右侧检查面板（SidePane）+ 状态行回执通道。
 *
 * 覆盖：页签闭集（任务/线/档案/检查器四页签）、宽度钳制（260px ~ 视口
 * 60%——设计稿 §2 柱1「会话流永不被挤」的下限/上限）、回执自隐调度器
 * （2200ms 自隐；连续两次 showReceipt 时旧计时器被 clearTimeout——
 * 与 Toast 组件的 effect cleanup 同语义）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CampaignRecordLike, CampaignState } from './campaign';
import type { BgTaskEntry } from './tasks';
import {
  clampSidePaneWidth,
  hasLiveActivity,
  initialSidePaneOpen,
  RECEIPT_TTL_MS,
  ReceiptScheduler,
  SIDE_PANE_DEFAULT_WIDTH,
  SIDE_PANE_MAX_FRACTION,
  SIDE_PANE_MIN_WIDTH,
  SIDE_PANE_TABS,
  sidePaneMaxWidth,
  WIDE_SCREEN_MIN,
  type SidePaneTab,
} from './side-pane';

describe('SIDE_PANE_TABS（页签闭集）', () => {
  it('任务/线/档案/检查器四页签，id 与 label 成对', () => {
    const ids = SIDE_PANE_TABS.map((t) => t.id);
    expect(ids).toEqual(['tasks', 'lines', 'archive', 'inspector'] satisfies SidePaneTab[]);
    expect(SIDE_PANE_TABS.map((t) => t.label)).toEqual(['任务', '线', '档案', '检查器']);
  });
});

describe('clampSidePaneWidth（260px ~ 视口 60%）', () => {
  const vw = 1280;

  it('下限：小于 260px 钳到 260px', () => {
    expect(clampSidePaneWidth(100, vw)).toBe(SIDE_PANE_MIN_WIDTH);
    expect(clampSidePaneWidth(259, vw)).toBe(SIDE_PANE_MIN_WIDTH);
  });

  it('上限：超过视口 60% 钳到 60vw', () => {
    expect(clampSidePaneWidth(2000, vw)).toBe(Math.floor(vw * SIDE_PANE_MAX_FRACTION));
    expect(clampSidePaneWidth(769, vw)).toBe(Math.floor(vw * SIDE_PANE_MAX_FRACTION));
  });

  it('区间内取整保留', () => {
    expect(clampSidePaneWidth(320.6, vw)).toBe(321);
    expect(clampSidePaneWidth(SIDE_PANE_MIN_WIDTH, vw)).toBe(SIDE_PANE_MIN_WIDTH);
  });

  it('非法值（NaN/Infinity）回落默认宽', () => {
    expect(clampSidePaneWidth(Number.NaN, vw)).toBe(SIDE_PANE_DEFAULT_WIDTH);
    expect(clampSidePaneWidth(Number.POSITIVE_INFINITY, vw)).toBe(
      sidePaneMaxWidth(vw),
    );
  });

  it('极窄视口：上限不低于下限（钳制永可逆）', () => {
    expect(sidePaneMaxWidth(200)).toBe(SIDE_PANE_MIN_WIDTH);
    expect(clampSidePaneWidth(9999, 200)).toBe(SIDE_PANE_MIN_WIDTH);
  });
});

describe('initialSidePaneOpen（默认展开 + 收起记住）', () => {
  it('无记忆值：宽屏默认展开，窄屏默认收起（≥1280 口径）', () => {
    expect(initialSidePaneOpen(null, WIDE_SCREEN_MIN)).toBe(true);
    expect(initialSidePaneOpen(null, WIDE_SCREEN_MIN + 1)).toBe(true);
    expect(initialSidePaneOpen(null, WIDE_SCREEN_MIN - 1)).toBe(false);
  });

  it('用户记忆值优先于屏宽（宽屏收起过 → 保持收起；窄屏展开过 → 保持展开）', () => {
    expect(initialSidePaneOpen('0', 2560)).toBe(false);
    expect(initialSidePaneOpen('1', 800)).toBe(true);
  });

  it('脏值（非 0/1）回落屏宽判定', () => {
    expect(initialSidePaneOpen('yes', WIDE_SCREEN_MIN)).toBe(true);
    expect(initialSidePaneOpen('2', WIDE_SCREEN_MIN - 1)).toBe(false);
    expect(initialSidePaneOpen('', WIDE_SCREEN_MIN - 1)).toBe(false);
  });
});

describe('hasLiveActivity（活性静态报数口径）', () => {
  const bg = (status: 'running' | 'finished'): BgTaskEntry => ({ tag: 'fuzz', status });
  const cmp = (state: CampaignState): CampaignRecordLike => ({ id: 'c1', goal: '挖崩溃面', state, signalLog: [] });

  it('全空 → false', () => {
    expect(hasLiveActivity([], [])).toBe(false);
  });

  it('仅 bgTasks 有 running → true；全 finished → false', () => {
    expect(hasLiveActivity([bg('running')], [])).toBe(true);
    expect(hasLiveActivity([bg('finished'), bg('finished')], [])).toBe(false);
  });

  it('战役四活性态（running/plateau/triaging/deepening）→ true', () => {
    const liveStates: CampaignState[] = ['running', 'plateau', 'triaging', 'deepening'];
    for (const state of liveStates) {
      expect(hasLiveActivity([], [cmp(state)])).toBe(true);
    }
  });

  it('paused（待人）/completed/stopped（终态）不算活性', () => {
    expect(hasLiveActivity([], [cmp('paused')])).toBe(false);
    expect(hasLiveActivity([], [cmp('completed'), cmp('stopped')])).toBe(false);
  });

  it('混合口径：bg 全停 + 战役无活性 → false（不误报）', () => {
    expect(hasLiveActivity([bg('finished')], [cmp('paused'), cmp('completed')])).toBe(false);
    expect(hasLiveActivity([bg('finished')], [cmp('running')])).toBe(true);
  });
});

describe('ReceiptScheduler（回执 2200ms 自隐）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('单次挂账：2200ms 后触发 onExpire', () => {
    const scheduler = new ReceiptScheduler();
    const onExpire = vi.fn();
    scheduler.schedule(onExpire);
    vi.advanceTimersByTime(RECEIPT_TTL_MS - 1);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('连续两次 showReceipt：旧计时器被清，只有最后一次到期才清回执', () => {
    const scheduler = new ReceiptScheduler();
    const onExpire = vi.fn();
    scheduler.schedule(onExpire);
    vi.advanceTimersByTime(1000);
    // 新回执顶掉旧计时器——窗口从第二次挂账重新起算（Toast effect 同语义）。
    scheduler.schedule(onExpire);
    vi.advanceTimersByTime(RECEIPT_TTL_MS - 1);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('cancel：挂账未到期即作废，永不触发', () => {
    const scheduler = new ReceiptScheduler();
    const onExpire = vi.fn();
    scheduler.schedule(onExpire);
    scheduler.cancel();
    vi.advanceTimersByTime(RECEIPT_TTL_MS * 2);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('到期后内部状态复位：可再次挂账', () => {
    const scheduler = new ReceiptScheduler();
    const onExpire = vi.fn();
    scheduler.schedule(onExpire);
    vi.advanceTimersByTime(RECEIPT_TTL_MS);
    expect(onExpire).toHaveBeenCalledTimes(1);
    // 到期回调里通常 set({receipt:null})——同一调度器复用不能留死状态。
    scheduler.schedule(onExpire);
    vi.advanceTimersByTime(RECEIPT_TTL_MS);
    expect(onExpire).toHaveBeenCalledTimes(2);
  });
});
