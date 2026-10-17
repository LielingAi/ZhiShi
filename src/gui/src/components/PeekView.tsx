/**
 * 2.0-M2 注视语义：只读查看他线（PeekView）。
 *
 * 场景：当前线 busy（turn 进行中）时，切执行现场被服务端拒绝
 * （「响应进行中，先 Esc」）——但注视切换永远允许。本视图用 peek 查到
 * 目标环境的 loopSessionId，渲染其 wire transcript，**全程不触引擎**：
 * 原线继续跑，这里只是看；Esc / 返回按钮退出，一切原样。
 *
 * 键盘：Esc 走本组件的 capture（不落 Esc 链——链是"操作语境"的语义，
 * 只读查看是瞬态视图，同 CommandPalette 的处理方式）。
 */

import { useEffect } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import type { LoopTranscriptLine } from '../client/api';

function PeekLine({ line, i }: { line: LoopTranscriptLine; i: number }): React.JSX.Element {
  const role = line.role ?? 'unknown';
  const text =
    typeof line.content === 'string'
      ? line.content
      : line.content !== undefined
        ? JSON.stringify(line.content)
        : '';
  const clipped = text.length > 600 ? `${text.slice(0, 600)}…` : text;
  const cls = role === 'user' ? 'user' : role === 'tool' || role === 'toolResult' ? 'tool' : 'assistant';
  const label =
    role === 'user' ? '你' : role === 'tool' || role === 'toolResult' ? line.name ?? 'tool' : 'assistant';
  return (
    <div className={`pk-line ${cls}`} key={i}>
      <span className="pk-role">{label}</span> {clipped}
    </div>
  );
}

export function PeekView(): React.JSX.Element | null {
  const peekView = useGuiStore((s) => s.peekView);
  const exitPeek = useGuiStore((s) => s.exitPeek);

  useEffect(() => {
    if (!peekView) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        exitPeek();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [peekView, exitPeek]);

  if (!peekView) return null;

  return (
    <div className="pk-wrap">
      <div className="pk-banner">
        <span className="pk-eyebrow">👁 只读查看</span>
        <span className="pk-target">
          {peekView.envKey} · line/{peekView.loopSessionId}
        </span>
        <span className="pk-note">原线运行中——这里只看不动；Esc 返回</span>
        <button className="btn small" onClick={exitPeek}>
          返回
        </button>
      </div>
      <div className="pk-body">
        {peekView.lines.length === 0 && <div className="ov-empty">这条线还没有消息</div>}
        {peekView.lines.map((l, i) => (
          <PeekLine line={l} i={i} key={i} />
        ))}
      </div>
    </div>
  );
}
