/**
 * V4-S1 右侧检查面板容器（设计稿 §2 柱2 的壳）：页签条（任务/线/档案/
 * 检查器）+ 内容体 + 左分割条（drag 调宽 260px~60vw、dblclick 收起/展开）。
 *
 * V4-S2 四页签全量迁入：线（S1）、任务、档案、检查器——三浮层换壳为页签
 * （overlay backdrop/✕ 壳退役，行为语义原样保留；Esc 链 close-tasks /
 * close-inspector 层同步摘除）。分割条收起态留 5px 细轨：dblclick 从收起
 * 态展开，不留打不开的死角。
 */

import { useRef } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import { SIDE_PANE_TABS } from '../model/side-pane';
import { shortLineId } from '../model/lines';
import { SidePaneTasks } from './SidePaneTasks';
import { SidePaneArchive } from './SidePaneArchive';
import { SidePaneInspector } from './SidePaneInspector';

/**
 * 「线」页签内容（原浮层 LinesPanel 的清单体原样迁入：行装配/共享转私有/
 * 切线动作零改动）。行点击仍先收面板再切线——沿用浮层时代语义（切线后
 * 线清单下一次打开重拉，active 标记不留 stale 可见态）。
 */
function SidePaneLines(): React.JSX.Element {
  const lines = useGuiStore((s) => s.lines);
  const loading = useGuiStore((s) => s.linesLoading);
  const refreshLines = useGuiStore((s) => s.refreshLines);
  const switchToLine = useGuiStore((s) => s.switchToLine);
  const shareLine = useGuiStore((s) => s.shareLine);
  const unshareLine = useGuiStore((s) => s.unshareLine);

  return (
    <div className="sp-lines">
      <div className="sp-lines-head">
        <span className="sp-lines-title">线</span>
        <button
          className="ln-icon"
          title="刷新线清单（line/list）"
          onClick={() => void refreshLines()}
        >
          ⟳
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
      <div className="ln-list sp-lines-list">
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
              // 2.0 修复：面板保持常驻——切线只换主区现场，右侧面板是你正在
              // 用的工具面（浮层时代"先收面板"的顺序在这里是反用户直觉的）。
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
  );
}

export function SidePane(): React.JSX.Element {
  const open = useGuiStore((s) => s.sidePaneOpen);
  const tab = useGuiStore((s) => s.sidePaneTab);
  const width = useGuiStore((s) => s.sidePaneWidth);
  const setSidePaneTab = useGuiStore((s) => s.setSidePaneTab);
  const toggleSidePane = useGuiStore((s) => s.toggleSidePane);
  const closeSidePane = useGuiStore((s) => s.closeSidePane);
  const setSidePaneWidth = useGuiStore((s) => s.setSidePaneWidth);
  // V4-S2 活性报数：任何 running 线 → 「线」页签挂静态 accent 小圆点
  //（类切换，零动画——报数不是警报）。
  const hasRunningLine = useGuiStore((s) => s.lines.some((r) => r.stateDot === 'running'));
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  // 分割条拖拽：面板在右，鼠标左移加宽。钳制+持久化走 setSidePaneWidth
  // （与 MainArea 分屏条同构，宽度口径换成 px）。
  const onSplitterDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    drag.current = { startX: e.clientX, startWidth: width };
    const onMove = (ev: MouseEvent) => {
      if (!drag.current) return;
      setSidePaneWidth(drag.current.startWidth + (drag.current.startX - ev.clientX));
    };
    const onUp = () => {
      drag.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <>
      <div
        className={`sp-splitter${open ? ' open' : ''}`}
        title={open ? '拖动调整宽度；双击收起' : '双击展开检查面板'}
        onMouseDown={open ? onSplitterDown : undefined}
        onDoubleClick={toggleSidePane}
      />
      {open && (
        <aside className="sidepane" style={{ width }}>
          <div className="sp-tabs" role="tablist">
            {SIDE_PANE_TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={`sp-tab${tab === t.id ? ' on' : ''}`}
                onClick={() => setSidePaneTab(t.id)}
              >
                {t.label}
                {t.id === 'lines' && hasRunningLine && (
                  <i className="sp-tab-dot" title="有运行中的线" />
                )}
              </button>
            ))}
            <button className="sp-close" title="收起检查面板（页签与宽度保留）" onClick={closeSidePane}>
              ✕
            </button>
          </div>
          <div className="sp-body">
            {/* V4-S2 四页签全量：线（S1）/任务/档案/检查器——浮层内容换壳落位。 */}
            {tab === 'tasks' && <SidePaneTasks />}
            {tab === 'lines' && <SidePaneLines />}
            {tab === 'archive' && <SidePaneArchive />}
            {tab === 'inspector' && <SidePaneInspector />}
          </div>
        </aside>
      )}
    </>
  );
}
