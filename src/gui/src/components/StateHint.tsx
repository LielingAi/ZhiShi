/**
 * 1.3.4 统一状态提示组件（loading / empty / error 三态一口径）。
 *
 * 历史面板（清单/只读查看器）、attach 视图（终端连接/执行）、设置页
 * 各页签的空态/加载态/错误态统一走这里——替代此前散落的
 * ov-empty / at-out / at-exit / sr-desc 内联写法。
 *
 * - loading：spinner + 文案（沿用全局 .spinner）。
 * - empty  ：淡色占位（无会话/无条目/无输出）。
 * - error  ：红色 ✗ 前缀 + 文案 + 可选次级说明（hint）。
 * - center ：大空白区居中占位（如历史查看器 hv-empty 位置）。
 */

import type React from 'react';

export type StateHintKind = 'loading' | 'empty' | 'error';

export interface StateHintProps {
  kind: StateHintKind;
  /** 主文案。 */
  text: string;
  /** 次级说明（可选；另起一行的小字）。 */
  hint?: string;
  /** 居中模式（flex 容器内铺满的占位区）。 */
  center?: boolean;
}

export function StateHint({ kind, text, hint, center }: StateHintProps): React.JSX.Element {
  return (
    <div className={`state-hint ${kind}${center ? ' center' : ''}`}>
      <div className="sh-line">
        {kind === 'loading' && <span className="spinner" />}
        {kind === 'error' && <span className="err-mark">✗</span>}
        <span>{text}</span>
      </div>
      {hint && <div className="sh-hint">{hint}</div>}
    </div>
  );
}
