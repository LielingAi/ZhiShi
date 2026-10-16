/**
 * 研究线面板（1.8.7 P3b，B6/B7，overlay 形态）：workspace 的分线清单
 * （line/list）——环境/归属/活性（live·busy 状态点）/最后活动。行点击切线
 * （/sessions/switch，先收面板让背后的流切走）；行尾共享/转私有
 * （line/share·unshare，权限 403 文案原样 toast）。Esc 进 Esc 链
 * （close-lines 层，tasks 之后、queue 之前）。
 *
 * 行装配在 model/lines.ts::buildLineRows（纯函数，已单测）；本组件只读
 * 存储（lines/linesLoading）与渲染。
 */

import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import { shortLineId } from '../model/lines';

export function LinesPanel(): React.JSX.Element | null {
  const open = useGuiStore((s) => s.linesOpen);
  const lines = useGuiStore((s) => s.lines);
  const loading = useGuiStore((s) => s.linesLoading);
  const closeLinesPanel = useGuiStore((s) => s.closeLinesPanel);
  const refreshLines = useGuiStore((s) => s.refreshLines);
  const switchToLine = useGuiStore((s) => s.switchToLine);
  const shareLine = useGuiStore((s) => s.shareLine);
  const unshareLine = useGuiStore((s) => s.unshareLine);

  if (!open) return null;

  return (
    <div className="overlay-backdrop lines-backdrop open">
      <div className="overlay-panel lines-panel">
        <div className="overlay-title">
          研究线
          <button
            className="ln-icon"
            title="刷新线清单（line/list）"
            onClick={() => void refreshLines()}
          >
            ⟳
          </button>
          <button className="tp-close" onClick={closeLinesPanel}>
            ✕
          </button>
        </div>
        <div className="ln-head">
          <span className="ln-caret" />
          <span className="ln-id">线</span>
          <span className="ln-env">环境</span>
          <span className="ln-owner">归属</span>
          <span className="ln-state">状态</span>
          <span className="ln-updated">最后活动</span>
          <span className="ln-ops" />
        </div>
        <div className="overlay-list ln-list">
          {lines.length === 0 && (
            <div className="ov-empty">
              {loading ? '拉取线清单…' : '这个 workspace 还没有线——会话会按环境自动分线'}
            </div>
          )}
          {lines.map((r) => (
            <div
              className={`ln-item ${r.active ? 'current' : ''}`}
              key={r.id}
              title={`归属段 ${r.segLabel}`}
              onClick={() => {
                if (r.active) return;
                // 先收面板让背后的流切走,再发切线（switchToLine 回执 toast）。
                closeLinesPanel();
                void switchToLine(r.id);
              }}
            >
              <span className="ln-caret">{r.active ? '▸' : ''}</span>
              <span className="ln-id">{shortLineId(r.id)}</span>
              <span className="ln-env">{r.envKey}</span>
              <span className="ln-owner">{r.ownerLabel}</span>
              <span
                className={`ln-dot ${r.stateDot}`}
                title={r.stateDot === 'running' ? '运行中' : r.stateDot === 'idle' ? '在线空闲' : '冷线（引擎未起）'}
              />
              <span className="ln-updated">{r.updatedLabel || '—'}</span>
              {/* 权限细化在服务端 403——前端按 shared 全量摆出,失败 toast 原文。 */}
              {r.canShare && (
                <button
                  className="btn small"
                  title="line/share——私有线转为共享线"
                  onClick={(e) => {
                    e.stopPropagation();
                    void shareLine(r.id);
                  }}
                >
                  共享
                </button>
              )}
              {r.canUnshare && (
                <button
                  className="btn small"
                  title="line/unshare——共享线转回私有（归属改为你）"
                  onClick={(e) => {
                    e.stopPropagation();
                    void unshareLine(r.id);
                  }}
                >
                  转私有
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
