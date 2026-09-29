/**
 * 状态栏（1.3.1 ⑦）：env 锚（宿主显性化 ①）+ phase（spinner）+ 队列 +
 * 上下文 + 后台任务段（⛁ name×N，③ 数据）+ 模型名（点击开模型选择）+
 * 主题切换（1.3.2 ③）。
 */

import type React from 'react';

import { selectCurrentSession, useGuiStore } from '../store/useGuiStore';
import { hostAnchorLabel } from '../model/access-gate';
import { bgStatusSegments } from '../model/tasks';
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
      <span className="env-anchor">{hostAnchorLabel(envKey)}</span>
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
        {segments.length > 0 && (
          <span className="bg-seg" title="后台任务/子代理（/tasks 查看详情）">
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
