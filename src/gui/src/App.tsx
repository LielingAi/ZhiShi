/**
 * App 壳（v19 布局）：环境侧栏 + 主区（工具栏 / 会话流 + 抽屉 /
 * 设置页 / attach 视图 / 底部输入区）+ 全局面板（overlay / 模态 / toast）。
 */

import type React from 'react';

import { useSse } from './hooks/useSse';
import { useEsc } from './hooks/useEsc';
import { useGuiStore } from './store/useGuiStore';
import { EnvSidebar } from './components/EnvSidebar';
import { Stream } from './components/Stream';
import { Drawer } from './components/Drawer';
import { InputArea } from './components/InputArea';
import { StatusBar } from './components/StatusBar';
import { Overlay } from './components/Overlay';
import { Modal } from './components/Modal';
import { SettingsPage } from './components/SettingsPage';
import { AttachView } from './components/AttachView';
import { Toast } from './components/Toast';

function Toolbar(): React.JSX.Element {
  const envKey = useGuiStore((s) => s.currentEnvKey);
  const connectionState = useGuiStore((s) => s.connectionState);
  const connectError = useGuiStore((s) => s.connectError);
  const init = useGuiStore((s) => s.init);

  return (
    <div className="app-toolbar">
      <span className="at-env">
        <span className="ok">◈</span> {envKey || '未选择环境'} ·{' '}
        {connectionState === 'live' ? '就绪' : '等待 sidecar'}
      </span>
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
      <Modal />
      <Toast />
    </div>
  );
}
