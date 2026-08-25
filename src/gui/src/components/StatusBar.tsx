/**
 * 状态栏（1.3.1 ⑦）：env 锚（宿主显性化 ①）+ phase（spinner）+ 队列 +
 * 上下文 + 后台任务段（⛁ name×N，③ 数据）+ 模型名（点击开模型选择）。
 */

import type React from 'react';

import { selectCurrentSession, useGuiStore } from '../store/useGuiStore';
import { hostAnchorLabel } from '../model/access-gate';
import { bgStatusSegments } from '../model/tasks';

export function StatusBar(): React.JSX.Element {
  const session = useGuiStore(selectCurrentSession);
  const envKey = useGuiStore((s) => s.currentEnvKey);
  const connectionState = useGuiStore((s) => s.connectionState);
  const openOverlay = useGuiStore((s) => s.openOverlay);
  const bgTasks = useGuiStore((s) => s.bgTasks);
  const subagents = useGuiStore((s) => s.subagents);

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

  return (
    <div className="statusbar">
      <span className={`status-dot ${dotClass}`} />
      <span className="env-anchor">{hostAnchorLabel(envKey)}</span>
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
