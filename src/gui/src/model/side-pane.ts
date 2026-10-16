/**
 * V4-S1 骨架壳纯函数层：右侧检查面板（SidePane，设计稿 §2 柱2 的壳）+
 * 状态行回执通道的可测逻辑。
 *
 * - 页签闭集：任务/线/档案/检查器四页签（V4-S2 起四页签全量迁入——浮层
 *   换壳为页签，能力语义原样保留，见设计稿 §6）。
 * - 宽度钳制：260px ~ 视口 60%——下限保住检查面板可读性，上限兑现
 *   「会话流永不被挤过半」（设计稿 §2 柱1）。
 * - ReceiptScheduler：回执 2200ms 自隐的 clearTimeout 语义（新回执顶掉
 *   旧计时器）——与 Toast 组件的 effect cleanup 同构；store 的 showReceipt
 *   动作委托它，抽成类便于 fake timers 单测纯时间逻辑。
 *
 * 纯函数：不 import store / React / client。
 */

import type { CampaignRecordLike } from './campaign';
import type { BgTaskEntry } from './tasks';

/** 宽屏阈值（px）——主区分屏已随决策②修订退役（V4-S3），此常量现为检查
 *  面板初始开合判定（initialSidePaneOpen）独占的口径。 */
export const WIDE_SCREEN_MIN = 1280;

/**
 * 检查面板初始开合（只在 store 初始化时判定一次）：
 * 用户记忆值（'1' 展开 / '0' 收起）永远优先——收起过一次就不再自动弹；
 * 无记忆值按屏宽默认（宽屏展开 / 窄屏收起）。窗口从窄拖宽、宽拖窄都
 * 不重判定——用户拖窗口是在腾地方看内容，不是在改面板的指令；每拖一次
 * 就弹/收一次是骚扰（WREN 真机定调）。
 */
export function initialSidePaneOpen(raw: string | null, viewportWidth: number): boolean {
  if (raw === '1') return true;
  if (raw === '0') return false;
  return viewportWidth >= WIDE_SCREEN_MIN;
}

/** 战役活性态闭集：盲跑 + 介入三态。paused（预算耗尽待人）不算活性。 */
const CAMPAIGN_LIVE_STATES: ReadonlySet<string> = new Set(['running', 'plateau', 'triaging', 'deepening']);

/**
 * 活性静态报数口径（可见性层）：后台任务有 running，或战役有活性态。
 * 状态栏 ⛁ 段转色与 SidePane 报数共用——纯查询类切换，零动画不发声；
 * 「有东西在跑」是仪器读数，不是警报。
 */
export function hasLiveActivity(
  bgTasks: readonly BgTaskEntry[],
  campaigns: readonly CampaignRecordLike[],
): boolean {
  if (bgTasks.some((t) => t.status === 'running')) return true;
  return campaigns.some((c) => CAMPAIGN_LIVE_STATES.has(c.state));
}

/** 检查面板页签 id 闭集。 */
export type SidePaneTab = 'tasks' | 'lines' | 'archive' | 'inspector';

export interface SidePaneTabDef {
  id: SidePaneTab;
  label: string;
}

/** 四页签（页签条渲染顺序 = 数组顺序）。 */
export const SIDE_PANE_TABS: readonly SidePaneTabDef[] = [
  { id: 'tasks', label: '任务' },
  { id: 'lines', label: '线' },
  { id: 'archive', label: '档案' },
  { id: 'inspector', label: '检查器' },
];

/** 面板宽度下限（px）——再窄栏内表格列就不可读了。 */
export const SIDE_PANE_MIN_WIDTH = 260;
/** 默认宽度（px；localStorage 无记录时的回落值）。 */
export const SIDE_PANE_DEFAULT_WIDTH = 320;
/** 宽度上限 = 视口宽度的 60%（会话流永不被挤过半）。 */
export const SIDE_PANE_MAX_FRACTION = 0.6;

/** 视口 → 宽度上限 px（极窄视口不低于下限，钳制永可逆）。 */
export function sidePaneMaxWidth(viewportWidth: number): number {
  return Math.max(SIDE_PANE_MIN_WIDTH, Math.floor(viewportWidth * SIDE_PANE_MAX_FRACTION));
}

/** 拖宽/持久化前的统一钳制：NaN 回落默认宽；±Infinity 视超界值夹进 [下限, 60vw]。 */
export function clampSidePaneWidth(width: number, viewportWidth: number): number {
  if (Number.isNaN(width)) return SIDE_PANE_DEFAULT_WIDTH;
  return Math.min(sidePaneMaxWidth(viewportWidth), Math.max(SIDE_PANE_MIN_WIDTH, Math.round(width)));
}

/** 回执自隐时长（ms；设计稿 §4「✓ xxx 2200ms 自隐」）。 */
export const RECEIPT_TTL_MS = 2200;

/**
 * 回执自隐调度器（store showReceipt 的计时心脏）。
 *
 * Toast 的自隐在组件 effect 里（nonce 变 → cleanup clearTimeout → 新
 * setTimeout）；回执没有组件内计时（状态行段常驻渲染），同一语义搬来
 * store 侧：每次 schedule 先 cancel 旧计时器再挂新的——连续动作回执
 * 的 2200ms 窗口从「最后一次」起算，早先挂的计时器不会提前清掉新回执。
 */
export class ReceiptScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ttlMs: number = RECEIPT_TTL_MS) {}

  /** 挂账：清旧计时器 → 新 ttlMs 后触发 onExpire（幂等，可反复调用）。 */
  schedule(onExpire: () => void): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      onExpire();
    }, this.ttlMs);
  }

  /** 作废挂账（dispose/测试清理语义；未挂账时 no-op）。 */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
