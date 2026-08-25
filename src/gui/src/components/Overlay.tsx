/**
 * 通用 overlay（命令 / @引用 / 历史 / 模型选择）——v19 面板样式。
 * 键盘导航（↑↓/Enter/Esc）在 useEsc 全局处理器里。
 */

import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';

export function Overlay(): React.JSX.Element | null {
  const overlay = useGuiStore((s) => s.overlay);
  const pickOverlay = useGuiStore((s) => s.pickOverlay);

  if (!overlay) return null;

  return (
    <div className="overlay-backdrop open">
      <div className="overlay-panel">
        <div className="overlay-title">{overlay.title}</div>
        <div className="overlay-list">
          {overlay.items.length === 0 && (
            <div className="ov-empty">无匹配项</div>
          )}
          {overlay.items.map((it, i) => (
            <div
              className={`ov-item ${i === overlay.sel ? 'sel' : ''}`}
              key={`${it.name}-${i}`}
              onClick={() => pickOverlay(i)}
            >
              <span className="ov-name">{it.name}</span>
              {it.detail && <span className="ov-detail">{it.detail}</span>}
              {it.tag && <span className="ov-tag">{it.tag}</span>}
              {it.cur && <span className="ov-cur">● 当前</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
