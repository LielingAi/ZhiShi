/**
 * App 壳（v19 布局）：环境侧栏 + 主区（工具栏 / 会话流 + 抽屉 /
 * 设置页 / attach 视图 / 底部输入区）+ 全局面板（overlay / 模态 /
 * boundary / decision / tasks / queue / toast）。
 */

import { useEffect, useRef, useState } from 'react';
import type React from 'react';

import { useSse } from './hooks/useSse';
import { useEsc } from './hooks/useEsc';
import { useGuiStore } from './store/useGuiStore';
import { hostAnchorLabel } from './model/access-gate';
import { isAutoRunActive } from './model/auto-run';
import { archiveBadgeCount } from './model/archive';
import { EnvSidebar } from './components/EnvSidebar';
import { Stream } from './components/Stream';
import { Drawer } from './components/Drawer';
import { InputArea } from './components/InputArea';
import { StatusBar } from './components/StatusBar';
import { Overlay } from './components/Overlay';
import { Modal } from './components/Modal';
import { BoundaryModal } from './components/BoundaryModal';
import { DecisionModal } from './components/DecisionModal';
import { AutoRunCard } from './components/AutoRunCard';
import { AutoRunVerdictModal } from './components/AutoRunVerdictModal';
import { TasksPanel } from './components/TasksPanel';
import { QueuePanel } from './components/QueuePanel';
import { SettingsPage } from './components/SettingsPage';
import { AttachView } from './components/AttachView';
import { HistoryPanel } from './components/HistoryPanel';
import { ResearchPanel } from './components/ResearchPanel';
import { Toast } from './components/Toast';

/** 1.4.4 分屏阈值：≥1280px 真分屏（6/4 可拖可互换），以下退单屏 + 抽屉。 */
const SPLIT_MIN_WIDTH = 1280;

function useWideScreen(): boolean {
  const [wide, setWide] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia(`(min-width: ${SPLIT_MIN_WIDTH}px)`).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${SPLIT_MIN_WIDTH}px)`);
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return wide;
}

/**
 * 1.4.4 主区分屏：左流右档案（6/4 默认，分隔条可拖，左右可互换）。
 * 研究 = 过程 + 成果的空间投影——左屏过程（对话流），右屏成果（档案）。
 */
function MainArea({ wide }: { wide: boolean }): React.JSX.Element {
  const ratio = useGuiStore((s) => s.archivePaneRatio);
  const swapped = useGuiStore((s) => s.archiveSwapped);
  const drawerOpen = useGuiStore((s) => s.archiveDrawerOpen);
  const setRatio = useGuiStore((s) => s.setArchivePaneRatio);
  const setDrawerOpen = useGuiStore((s) => s.setArchiveDrawerOpen);
  const drag = useRef<{ startX: number; startRatio: number } | null>(null);

  const onDividerDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = e.currentTarget.parentElement as HTMLElement | null;
    if (!container) return;
    drag.current = { startX: e.clientX, startRatio: ratio };
    const onMove = (ev: MouseEvent) => {
      if (!drag.current) return;
      const total = container.clientWidth;
      if (total <= 0) return;
      const delta = ev.clientX - drag.current.startX;
      const next = swapped
        ? drag.current.startRatio - delta / total
        : drag.current.startRatio + delta / total;
      setRatio(next);
    };
    const onUp = () => {
      drag.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (!wide) {
    return (
      <>
        <div className="stream-wrap">
          <Stream />
          <Drawer />
        </div>
        {drawerOpen && (
          <div className="arc-drawer-backdrop" onClick={() => setDrawerOpen(false)}>
            <div className="arc-drawer" onClick={(e) => e.stopPropagation()}>
              <div className="arc-drawer-head">
                <span className="arc-drawer-title">研究档案</span>
                <button className="btn small" onClick={() => setDrawerOpen(false)}>关闭</button>
              </div>
              <ResearchPanel />
            </div>
          </div>
        )}
      </>
    );
  }

  const stream = (
    <div className="stream-wrap" style={{ flexBasis: `${ratio * 100}%` }}>
      <Stream />
      <Drawer />
    </div>
  );
  const pane = (
    <div className="arc-pane" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
      <ResearchPanel />
    </div>
  );
  return (
    <div className={`main-split${swapped ? ' swapped' : ''}`}>
      {swapped ? pane : stream}
      <div className="arc-divider" onMouseDown={onDividerDown} title="拖动调整分屏比例" />
      {swapped ? stream : pane}
    </div>
  );
}

function Toolbar(): React.JSX.Element {
  const envKey = useGuiStore((s) => s.currentEnvKey);
  const connectionState = useGuiStore((s) => s.connectionState);
  const connectError = useGuiStore((s) => s.connectError);
  const init = useGuiStore((s) => s.init);
  const decisions = useGuiStore((s) => s.decisions);
  const activeDecisionId = useGuiStore((s) => s.activeDecisionId);
  const openDecision = useGuiStore((s) => s.openDecision);
  const openHistoryPanel = useGuiStore((s) => s.openHistoryPanel);
  const autoRunActive = useGuiStore((s) => isAutoRunActive(s.autoRun));
  const openAutoRunStart = useGuiStore((s) => s.openAutoRunStart);
  // 1.4.4 研究档案：小窗抽屉入口（未决问题 + 待复核徽章）；分屏态由 CSS 隐藏。
  const archive = useGuiStore((s) => s.archive);
  const setArchiveDrawerOpen = useGuiStore((s) => s.setArchiveDrawerOpen);
  const archiveBadge = archiveBadgeCount(archive);

  // 1.3.2 ①：会话头部 pending 指示（决策模态收起后仍可点开重答）。
  const firstDecision = decisions[0] ?? null;
  const pendingDecision = decisions.length > 0 && (activeDecisionId === null || !decisions.some((d) => d.decisionId === activeDecisionId));

  return (
    <div className="app-toolbar">
      <span className="at-env">
        <span className="ok">◈</span> {hostAnchorLabel(envKey)} ·{' '}
        {connectionState === 'live' ? '就绪' : '等待 sidecar'}
      </span>
      <button
        className="btn small"
        title="历史会话（清单 / 只读回看 / 载回续跑）"
        onClick={() => void openHistoryPanel()}
      >
        ▤ 历史
      </button>
      <button
        className="btn small"
        disabled={autoRunActive || !envKey}
        title={
          autoRunActive
            ? 'auto loop 运行中——先观察或 Esc 终止'
            : !envKey
              ? '先选择环境——一切操作都在环境内'
              : '启动 auto loop（目标式研究循环：侦察→分析→构造→执行→评估）'
        }
        onClick={openAutoRunStart}
      >
        ⚡ auto loop
      </button>
      <button
        className="btn small ar-toolbar-btn"
        title="研究档案（过程记录 + 成果汇总——假设/证据/结论/未决问题，点行纠正）"
        onClick={() => setArchiveDrawerOpen(true)}
      >
        ▦ 研究{archiveBadge > 0 ? ` ${archiveBadge}` : ''}
      </button>
      {pendingDecision && firstDecision && (
        <button
          className="toolbar-decision pending"
          title={`${decisions.length} 个决策待答——点开重答`}
          onClick={() => openDecision(firstDecision.decisionId)}
        >
          ⚖ 决策待答 {decisions.length}
        </button>
      )}
      {connectionState === 'failed' && (
        <>
          <span className="conn-err" title={connectError ?? ''}>
            {connectError ?? '连接失败'}
          </span>
          <button className="btn small" onClick={init}>重试</button>
        </>
      )}
    </div>
  );
}

export function App(): React.JSX.Element {
  useSse();
  useEsc();
  const page = useGuiStore((s) => s.page);
  const theme = useGuiStore((s) => s.theme);
  const wide = useWideScreen();

  // 1.3.2 ③：主题 → body.light class（styles.css 的浅色变量组开关）。
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('light', theme === 'light');
  }, [theme]);

  return (
    <div className="shell">
      <EnvSidebar />
      <main className="main">
        <Toolbar />
        {page === 'settings' ? (
          <SettingsPage />
        ) : page === 'attach' ? (
          <AttachView />
        ) : page === 'history' ? (
          <HistoryPanel />
        ) : (
          <>
            <MainArea wide={wide} />
            <AutoRunCard />
            <div className="bottom-area">
              <StatusBar />
              <InputArea />
            </div>
          </>
        )}
      </main>
      <Overlay />
      <TasksPanel />
      <QueuePanel />
      <BoundaryModal />
      <DecisionModal />
      <AutoRunVerdictModal />
      <Modal />
      <Toast />
    </div>
  );
}
