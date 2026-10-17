/**
 * 2.0-M4b 环境面板（WREN 2026-10-17 三条真机反馈的直接产物）：
 *   ① 底栏平铺太乱 → 面板收起时底栏只有一个 chip；
 *   ② 环境干完任务不知道 → 行内「在干什么/最近完成」+ auto-run 终态全局回执；
 *   ③ 切换麻烦/不知道对方在做什么 → 一行一环境，点行即切（忙碌转 PeekView），
 *      全名/状态/任务叙事都在行里。
 *
 * 位置：底栏 chip 点开的浮层（fixed 左下），点击外部或 Esc 关闭；
 * 数据：autoRun/list（打开时拉一次；终态事件推动刷新，无定时器）。
 */

import { useEffect } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import { buildEnvPanelRows } from '../model/env-panel';
import { panelGateToast, panelRowGate } from '../model/access-gate';

export function EnvPanel(): React.JSX.Element | null {
  const open = useGuiStore((s) => s.envPanelOpen);
  const envs = useGuiStore((s) => s.envs);
  const running = useGuiStore((s) => s.running);
  const currentEnvKey = useGuiStore((s) => s.currentEnvKey);
  const envRuns = useGuiStore((s) => s.envRuns);
  const campaigns = useGuiStore((s) => s.campaigns);
  const lines = useGuiStore((s) => s.lines);
  const closeEnvPanel = useGuiStore((s) => s.closeEnvPanel);
  const setPage = useGuiStore((s) => s.setPage);
  const switchEnv = useGuiStore((s) => s.switchEnv);
  const openEnvDetail = useGuiStore((s) => s.openEnvDetail);
  const loadEnvRuns = useGuiStore((s) => s.loadEnvRuns);
  const showToast = useGuiStore((s) => s.showToast);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeEnvPanel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, closeEnvPanel]);

  if (!open) return null;

  const rows = buildEnvPanelRows(envs, running.map((r) => r.id), currentEnvKey, envRuns, {
    campaigns,
    lines,
  });

  return (
    <div
      className="ep-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        closeEnvPanel();
      }}
    >
      <div className="ep-panel" onClick={(e) => e.stopPropagation()}>
        <div className="ep-head">
          环境 · 点击切换（忙碌环境=只读查看）
          <span className="ep-count">
            {running.length} 运行中 / {envs.length} 注册
          </span>
        </div>
        {rows.map((r) => (
          <div
            className={`ep-row${r.current ? ' cur' : ''}`}
            key={r.id}
            title={r.current ? '当前环境——点击看详情' : '点击切换（忙碌环境转只读查看，原线照跑）'}
            onClick={() => {
              closeEnvPanel();
              if (r.current) {
                void openEnvDetail(r.id);
                return;
              }
              // 2.0 audit P1：停止的环境不绕准入闸（与侧栏一个闸口）——
              // ssh/本机按设计放行；docker/vm 提示先启动（gateToast 文案）。
              if (r.state === 'stopped') {
                const entry = envs.find((e) => e.id === r.id);
                const gate = panelRowGate(entry ?? { id: r.id }, 'stopped');
                if (!gate.allow) {
                  showToast(panelGateToast(gate));
                  return;
                }
              }
              void switchEnv(r.id);
            }}
          >
            <div className="ep-row-top">
              <span className={`es-dot ${r.state}`} />
              {r.fullName}
              <span className="ep-state">
                {r.state === 'running' ? '运行中' : r.state === 'local' ? '内置本机' : '已停止'}
                {r.current ? ' · 当前' : ''}
              </span>
            </div>
            {r.doing && (
              <div className={`ep-doing${r.done ? ' ep-done' : ''}`}>
                {r.doing}
              </div>
            )}
          </div>
        ))}
        <div className="ep-foot">
          <span className="ep-link" onClick={() => { closeEnvPanel(); setPage('gate'); }}>
            正门（选/建/台账）
          </span>
          <span className="ep-link" onClick={() => void loadEnvRuns()}>
            ⟳ 刷新
          </span>
          <span>Ctrl+K → use 切环境</span>
        </div>
      </div>
    </div>
  );
}
