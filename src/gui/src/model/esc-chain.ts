/**
 * Esc 链（修正项，纯函数）。
 *
 * v19 原型是「每个 backdrop 一个 keydown 处理器、按注册顺序叠加」的双
 * 处理器方案——本实现改为单处理器（hooks/useEsc.ts 一个 window keydown），
 * 每按一次 Esc 只弹一层，优先级固定：
 *
 *   overlay（命令/@引用/历史/模型选择）＞ tasks 面板（/tasks overlay）
 *   ＞ queue 面板（/queue）＞ boundary 模态（1.3.1 ②：Esc = 收起模态不作答，
 *   ask 保持 pending，重连 replay 会重新弹出）＞ decision 模态（1.3.2 ①：
 *   Esc = 收起不作答，decision 保持 pending 并缩为会话头部待答指示）
 *   ＞ 模态（新建环境/SSH/adopt/构建/promote）＞ drawer（工具输出抽屉）
 *   ＞ 页面（设置/attach）＞ 无面板且 busy → 中断 turn
 *
 * 逻辑抽成纯函数便于单测；副作用（关面板 / POST /chat/stop）由 store 执行。
 */

/** 面板层级（存在即「打开」）。 */
export interface EscUiState {
  overlayOpen: boolean;
  /** /tasks 面板打开（overlay 形态，1.3.1 ③）。 */
  tasksOpen: boolean;
  /** /queue 面板打开（1.3.1 ④）。 */
  queueOpen: boolean;
  /** 越界 ask 模态打开（1.3.1 ②）。 */
  boundaryOpen: boolean;
  /** 决策模态打开（1.3.2 ①：activeDecisionId 非空）。 */
  decisionOpen: boolean;
  modalOpen: boolean;
  drawerOpen: boolean;
  /** 设置页或 attach 视图接管主区。 */
  pageOpen: boolean;
  /** 引擎 turn 运行中（phase === 'running'）。 */
  busy: boolean;
}

export type EscAction =
  | { type: 'close-overlay' }
  | { type: 'close-tasks' }
  | { type: 'close-queue' }
  | { type: 'close-boundary' }
  | { type: 'close-decision' }
  | { type: 'close-modal' }
  | { type: 'close-drawer' }
  | { type: 'close-page' }
  | { type: 'interrupt' }
  | { type: 'none' };

/** 单次 Esc 的目标动作：一次只弹一层。 */
export function escAction(s: EscUiState): EscAction {
  if (s.overlayOpen) return { type: 'close-overlay' };
  if (s.tasksOpen) return { type: 'close-tasks' };
  if (s.queueOpen) return { type: 'close-queue' };
  if (s.boundaryOpen) return { type: 'close-boundary' };
  if (s.decisionOpen) return { type: 'close-decision' };
  if (s.modalOpen) return { type: 'close-modal' };
  if (s.drawerOpen) return { type: 'close-drawer' };
  if (s.pageOpen) return { type: 'close-page' };
  if (s.busy) return { type: 'interrupt' };
  return { type: 'none' };
}
