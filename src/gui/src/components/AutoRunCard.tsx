/**
 * auto loop 运行态观察卡（1.4.1；1.7.7 auto-redesign 收敛）：会话视图内嵌
 * （stream 之下、状态栏之上）。
 *
 *   - 运行中：阶段指示 + 轮次计数 + 预算余量进度条 + 最近结论行 + Esc 提示
 *   - 终态（completed/stopped/exited）：结果行（达成 / 预算耗尽 / 已终止 /
 *     API 故障）+ 关闭（清 autoRun）
 *
 * 1.7.7：无暂停点、无验收终审、无预算续命——观察卡只有「观察 + Esc」两个
 * 人机接口；终态经 auto-run:completed{outcome} 归约，文案走
 * autoRunTerminalText。
 *
 * 数据源：store.autoRun（SSE auto-run:* 归约 + auto-run/list 恢复）。
 */

import { useEffect, useState } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import {
  autoRunTerminalText,
  budgetUsedPct,
  formatBudget,
  isAutoRunActive,
  turnProgressOf,
  type AutoRunEntry,
} from '../model/auto-run';

const STATUS_TEXT: Record<AutoRunEntry['status'], string> = {
  starting: '启动中',
  running: '运行中',
  completed: '已完成',
  stopped: '已停止',
  exited: '已退出',
};

/** 1.4.7 轮内进度（观察卡）：running 态显示「第 N 轮进行中 · 耗时 N s」，每秒自增。 */
function TurnProgress({ entry }: { entry: AutoRunEntry }): React.JSX.Element | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (entry.status !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [entry.status]);
  const progress = turnProgressOf(entry, now);
  if (!progress) return null;
  return <span className="ar-phase">第 {progress.turn} 轮进行中 · {progress.elapsedSec}s</span>;
}

export function AutoRunCard(): React.JSX.Element | null {
  const entry = useGuiStore((s) => s.autoRun);
  const dismissAutoRunCard = useGuiStore((s) => s.dismissAutoRunCard);

  if (!entry) return null;
  const active = isAutoRunActive(entry);
  const pct = budgetUsedPct(entry.used, entry.budget.limit);

  return (
    <div className={`ar-card ${active ? 'active' : 'done'}`}>
      <div className="ar-head">
        <span className="ar-mark">⚡</span>
        <span className="ar-name">{entry.name}</span>
        <span className={`ar-status s-${entry.status}`}>{STATUS_TEXT[entry.status]}</span>
        {entry.phase && <span className="ar-phase">阶段 · {entry.phase}</span>}
        {entry.turnCount !== undefined && (
          <span className="ar-phase">轮次 · {entry.turnCount}</span>
        )}
        <TurnProgress entry={entry} />
      </div>
      <div className="ar-meta">
        <span className="ar-budget">
          预算 <b>{formatBudget(entry.budget.kind, entry.used, entry.budget.limit)}</b>
        </span>
        <div className="ar-bar">
          <div
            className={`ar-bar-fill ${pct >= 90 ? 'warn' : ''}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      {entry.lastConclusion && (
        <div className="ar-conclusion" title={entry.lastConclusion}>
          最近结论 · {entry.lastConclusion}
        </div>
      )}

      <div className="ar-foot">
        {active ? (
          <span className="ar-esc-hint">
            <kbd>Esc</kbd> 终止 loop（二次确认）· 运行中仅观察——输入/环境切换已锁定
          </span>
        ) : (
          <span className="ar-esc-hint">
            {entry.status === 'completed' ? '✓ 完成' : entry.status === 'exited' ? '✗ 已退出' : '⏹ 已停止'}
            {' · '}{autoRunTerminalText(entry)}——loop 线可在 /tasks 回看
          </span>
        )}
        {!active && (
          <button className="btn small" onClick={dismissAutoRunCard}>关闭</button>
        )}
      </div>
    </div>
  );
}
