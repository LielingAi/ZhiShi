/**
 * Esc 链（修正项，纯函数）。
 *
 * v19 原型是「每个 backdrop 一个 keydown 处理器、按注册顺序叠加」的双
 * 处理器方案——本实现改为单处理器（hooks/useEsc.ts 一个 window keydown），
 * 每按一次 Esc 只弹一层，优先级固定：
 *
 *   overlay（命令/@引用/历史/模型选择）＞ 模态（新建环境/SSH/adopt/构建）
 *   ＞ drawer（工具输出抽屉）＞ 页面（设置/attach）＞ 无面板且 busy → 中断 turn
 *
 * 逻辑抽成纯函数便于单测；副作用（关面板 / POST /chat/stop）由 store 执行。
 */

/** 面板层级（存在即「打开」）。 */
export interface EscUiState {
  overlayOpen: boolean;
  modalOpen: boolean;
  drawerOpen: boolean;
  /** 设置页或 attach 视图接管主区。 */
  pageOpen: boolean;
  /** 引擎 turn 运行中（phase === 'running'）。 */
  busy: boolean;
}

export type EscAction =
  | { type: 'close-overlay' }
  | { type: 'close-modal' }
  | { type: 'close-drawer' }
  | { type: 'close-page' }
  | { type: 'interrupt' }
  | { type: 'none' };

/** 单次 Esc 的目标动作：一次只弹一层。 */
export function escAction(s: EscUiState): EscAction {
  if (s.overlayOpen) return { type: 'close-overlay' };
  if (s.modalOpen) return { type: 'close-modal' };
  if (s.drawerOpen) return { type: 'close-drawer' };
  if (s.pageOpen) return { type: 'close-page' };
  if (s.busy) return { type: 'interrupt' };
  return { type: 'none' };
}
