/**
 * App 壳（v19 布局）：环境侧栏 + 主区（工具栏 / 会话流 + 抽屉 /
 * 设置页 / attach 视图 / 底部输入区）+ 全局面板（overlay / 模态 /
 * boundary / decision / tasks / queue / toast）。
 */

import { useEffect } from 'react';
import type React from 'react';

import { useSse } from './hooks/useSse';
import { useEsc } from './hooks/useEsc';
import { useGuiStore } from './store/useGuiStore';
import { hostAnchorLabel } from './model/access-gate';
import { EnvSidebar } from './components/EnvSidebar';
import { Stream } from './components/Stream';
import { Drawer } from './components/Drawer';
import { InputArea } from './components/InputArea';
import { StatusBar } from './components/StatusBar';
import { Overlay } from './components/Overlay';
import { Modal } from './components/Modal';
import { BoundaryModal } from './components/BoundaryModal';
import { DecisionModal } from './components/DecisionModal';
import { TasksPanel } from './components/TasksPanel';
import { QueuePanel } from './components/QueuePanel';
import { SettingsPage } from './components/SettingsPage';
import { AttachView } from './components/AttachView';
import { Toast } from './components/Toast';

function Toolbar(): React.JSX.Element {
  const envKey = useGuiStore((s) => s.currentEnvKey);
  const connectionState = useGuiStore((s) => s.connectionState);
  const connectError = useGuiStore((s) => s.connectError);
  const init = useGuiStore((s) => s.init);
  const decisions = useGuiStore((s) => s.decisions);
  const activeDecisionId = useGuiStore((s) => s.activeDecisionId);
  const openDecision = useGuiStore((s) => s.openDecision);

  // 1.3.2 ①：会话头部 pending 指示（决策模态收起后仍可点开重答）。
  const firstDecision = decisions[0] ?? null;
  const pendingDecision = decisions.length > 0 && (activeDecisionId === null || !decisions.some((d) => d.decisionId === activeDecisionId));

  return (
    <div className="app-toolbar">
      <span className="at-env">
        <span className="ok">◈</span> {hostAnchorLabel(envKey)} ·{' '}
        {connectionState === 'live' ? '就绪' : '等待 sidecar'}
      </span>
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
        ) : (
          <>
            <div className="stream-wrap">
              <Stream />
              <Drawer />
            </div>
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
      <Modal />
      <Toast />
    </div>
  );
}
