/**
 * 状态栏（1.3.1 ⑦）：env 锚（宿主显性化 ①）+ phase（spinner）+ 队列 +
 * 上下文 + 后台任务段（⛁ name×N，③ 数据）+ 模型名（点击开模型选择）+
 * 主题切换（1.3.2 ③）+ V4-S1 回执段（✓ 动作确认，nonce 变化短暂高亮）。
 */

import type React from 'react';

import { selectCurrentSession, useGuiStore } from '../store/useGuiStore';
import { hostAnchorLabel } from '../model/access-gate';
import { bgStatusSegments } from '../model/tasks';
import { shortLineId } from '../model/lines';
import { hasLiveActivity } from '../model/side-pane';
import { loadConnection } from '../model/connection';

export function StatusBar(): React.JSX.Element {
  const session = useGuiStore(selectCurrentSession);
  const envKey = useGuiStore((s) => s.currentEnvKey);
  const connectionState = useGuiStore((s) => s.connectionState);
  const connectError = useGuiStore((s) => s.connectError);
  const openSettingsTab = useGuiStore((s) => s.openSettingsTab);
  const openOverlay = useGuiStore((s) => s.openOverlay);
  const bgTasks = useGuiStore((s) => s.bgTasks);
  const subagents = useGuiStore((s) => s.subagents);
  const theme = useGuiStore((s) => s.theme);
  const toggleTheme = useGuiStore((s) => s.toggleTheme);
  // 1.8.7 P3b：研究线入口——当前线短线 id + 状态点；V4-S1 起点击开
  // SidePane「线」页签（浮层 LinesPanel 退役，Esc 链 close-lines 层摘除）。
  const lines = useGuiStore((s) => s.lines);
  const openSidePane = useGuiStore((s) => s.openSidePane);
  // V4-S2 纠偏入口层：env 锚点击开环境详情（复用侧栏 ℹ 同一动作；宿主
  // 未锚定则无详情可看，不可点）。
  const openEnvDetail = useGuiStore((s) => s.openEnvDetail);
  // V4-S2 活性静态报数：campaigns 参与 ⛁ 段活性判定（bgTasks 外第二数据源）。
  const campaigns = useGuiStore((s) => s.campaigns);
  // V4-S1 回执通道：store showReceipt 写 receipt + nonce（2200ms 自隐）；
  // key=nonce 让同段连击时重挂载，CSS 动画随之重放（短暂高亮）。
  const receipt = useGuiStore((s) => s.receipt);

  const phase = session.phase;
  const phaseText =
    phase === 'running'
      ? '思考中'
      : phase === 'interrupted'
        ? '已中断'
        : phase === 'error'
          ? '错误'
          : '空闲';
  const dotClass =
    phase === 'running'
      ? 'running'
      : phase === 'error'
        ? 'error'
        : 'idle';

  const segments = bgStatusSegments(bgTasks, subagents);
  // V4-S2 活性静态报数口径：⛁ 段有 running 后台/活性战役 → .live 转 accent 色。
  const live = hasLiveActivity(bgTasks, campaigns);

  // 1.8.7 P3b：当前研究线（line/list 的 active 行——面板开过即有数据）。
  const activeLine = lines.find((r) => r.active);

  // 模式角标（1.8.7——「我当前是团队模式还是单机模式」必须在界面上有明确
  // 表示，不然使用者会忘记自己在哪个大脑上操作。本机=dim；团队大脑连上=
  // cyan；连接失败=amber；点击直达设置→连接）。
  const conn = loadConnection(typeof window !== 'undefined' ? window.localStorage : undefined);
  const brainHost = conn.serverUrl.replace(/^https?:\/\//, '');
  const modeBadge = conn.mode !== 'remote'
    ? {
        text: '本机',
        cls: 'local',
        title: '当前：单机模式（本机 sidecar）——点击改连接',
      }
    : connectionState === 'live'
      ? {
          text: `团队大脑 · ${brainHost}`,
          cls: 'remote',
          title: `当前：团队模式（远端大脑 ${conn.serverUrl}）——点击改连接`,
        }
      : connectionState === 'failed'
        ? {
            text: '团队大脑 · 连接失败',
            cls: 'failed',
            title: `${connectError ?? '连接失败'}——点击改连接`,
          }
        : {
            text: '团队大脑 · 连接中…',
            cls: 'remote',
            title: `正在连接团队大脑（${conn.serverUrl}）`,
          };

  return (
    <div className="statusbar">
      <span className={`status-dot ${dotClass}`} />
      {/* V4-S2 入口层：env 锚可点（有锚定环境时）——直达环境详情模态。 */}
      <span
        className={`env-anchor${envKey ? ' clickable' : ''}`}
        title={envKey ? '当前环境——点击查看详情（登记条目快照）' : '宿主（未锚定环境）'}
        onClick={envKey ? () => openEnvDetail(envKey) : undefined}
      >
        {hostAnchorLabel(envKey)}
      </span>
      <span
        className="seg clickable ln-anchor"
        title="研究线——点击打开 SidePane「线」页签（line/list）"
        onClick={() => openSidePane('lines')}
      >
        · 线 <span className={`ln-dot ${activeLine?.stateDot ?? 'cold'}`} />
        <span className="ln-anchor-id">{activeLine ? shortLineId(activeLine.id) : '—'}</span>
      </span>
      <span
        className={`mode-badge ${modeBadge.cls}`}
        title={modeBadge.title}
        onClick={() => openSettingsTab('connection')}
      >
        {modeBadge.text}
      </span>
      <span className="seg">
        <b>{phaseText}</b>
      </span>
      <span className="seg">· 队列 {session.queue.length}</span>
      {session.contextPct !== undefined && (
        <span className="seg">
          · 上下文 <b>{session.contextPct}%</b>
        </span>
      )}
      <span
        className="seg clickable"
        title="点击切换模型"
        onClick={() => openOverlay('model', '')}
      >
        · <span className="model-label">{session.model ?? '未设置'}</span>{' '}
        <span className="caret">▾</span>
      </span>
      <div className="right">
        {receipt && (
          <span key={receipt.nonce} className="receipt-seg" title="动作回执">
            ✓ {receipt.text}
          </span>
        )}
        {segments.length > 0 && (
          // V4-S2 入口层：⛁ 段可点 → SidePane「任务」页签；活性时 .live 转 accent 色。
          <span
            className={`bg-seg${live ? ' live' : ''}`}
            title="任务与后台进程——打开 SidePane「任务」页签"
            onClick={() => openSidePane('tasks')}
          >
            ⛁ {segments.map((g) => `${g.name}×${g.count}`).join(' · ')}
          </span>
        )}
        <span
          className="seg clickable theme-toggle"
          title={theme === 'dark' ? '切换浅色主题' : '切换深色主题'}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? '☾ 深色' : '☀ 浅色'}
        </span>
        {connectionState !== 'live' && (
          <span className="conn-state">
            {connectionState === 'reconnecting'
              ? '⏳ 重连中'
              : connectionState === 'failed'
                ? '✗ 连接失败'
                : connectionState === 'connecting'
                  ? '⏳ 连接中'
                  : '⏳ 发现端口'}
          </span>
        )}
      </div>
    </div>
  );
}
