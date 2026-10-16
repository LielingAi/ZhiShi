/**
 * App 壳（V4-S1 骨架壳 + S2 浮层迁入 + S3 档案归位/命令中枢 + S4 正门，
 * 设计稿 gui-v4-skeleton-design.md §2）：主区（menubar 细栏 / 会话流 /
 * 设置页 / attach / 历史 / 正门 / 底部状态行 + 输入区）+ 右侧检查面板
 * SidePane（四页签全量）+ 全局面板（overlay / 模态 / boundary / decision /
 * queue / 命令中枢 / toast）。EnvSidebar 已退常驻（S4）——唯一挂载点是
 * GatePage 正门。
 *
 * page 分支逐字保守（chat/settings/attach/history/gate）；布局集中在
 * shell 层：main（menubar + MainArea + 底区）+ SidePane + 分割条。
 */

import { useEffect } from 'react';
import type React from 'react';

import { useSse } from './hooks/useSse';
import { useEsc } from './hooks/useEsc';
import { useGuiStore } from './store/useGuiStore';
import { isAutoRunActive } from './model/auto-run';
import { Stream } from './components/Stream';
import { Drawer } from './components/Drawer';
import { InputArea } from './components/InputArea';
import { StatusBar } from './components/StatusBar';
import { Menubar } from './components/Menubar';
import { SidePane } from './components/SidePane';
import { GatePage } from './components/GatePage';
import { CommandPalette } from './components/CommandPalette';
import { Overlay } from './components/Overlay';
import { Modal } from './components/Modal';
import { BoundaryModal } from './components/BoundaryModal';
import { DecisionModal } from './components/DecisionModal';
import { AutoRunCard } from './components/AutoRunCard';
import { QueuePanel } from './components/QueuePanel';
import { SettingsPage } from './components/SettingsPage';
import { AttachView } from './components/AttachView';
import { HistoryPanel } from './components/HistoryPanel';
import { AutoRunStream } from './components/AutoRunStream';
import { Toast } from './components/Toast';

/**
 * 主区（决策②修订——V4-S3）：档案分屏/抽屉整体退役，会话流回归单流——
 * 中心唯一主角兑现设计稿 §2 柱1（流永不被挤），档案唯一落位 SidePane
 * 「档案」页签（宽屏窄屏同一形态，不再两份渲染）。工具输出 Drawer 不受影响。
 * auto loop 观察流保留（1.4.6：左过程右成果语义在 auto-run 下成立）。
 */
function MainArea(): React.JSX.Element {
  const autoRunActive = useGuiStore((s) => isAutoRunActive(s.autoRun));
  return (
    <div className="stream-wrap">
      {autoRunActive ? <AutoRunStream /> : <Stream />}
      <Drawer />
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
      {/* V4-S4：常驻环境侧栏摘除——shell 回归 menubar + main + SidePane 三列，
          会话流获得原侧栏宽度；环境管理的唯一落位 = 正门（GatePage）。 */}
      <main className="main">
        <Menubar />
        {page === 'settings' ? (
          <SettingsPage />
        ) : page === 'attach' ? (
          <AttachView />
        ) : page === 'history' ? (
          <HistoryPanel />
        ) : page === 'gate' ? (
          <GatePage />
        ) : (
          <>
            <MainArea />
            <AutoRunCard />
            <div className="bottom-area">
              <StatusBar />
              <InputArea />
            </div>
          </>
        )}
      </main>
      {/* V4-S1：右侧检查面板（页签容器，V4-S2 四页签全量）——main 的同辈
          flex 成员，四页签路由与 page 分支互不干涉；分割条在 SidePane 内部
          自带。任务/检查器浮层壳已退役（S2），queue 保留浮层。 */}
      <SidePane />
      {/* V4-S3 命令中枢（Ctrl+K）——独立面板面，Esc/方向键自管（capture 拦
          在 useEsc 之前），不进 Esc 链。 */}
      <CommandPalette />
      <Overlay />
      <QueuePanel />
      <BoundaryModal />
      <DecisionModal />
      <Modal />
      <Toast />
    </div>
  );
}
