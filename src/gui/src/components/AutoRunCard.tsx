/**
 * auto loop 运行态观察卡（1.4.1）：会话视图内嵌（stream 之下、状态栏之上）。
 *
 *   - 运行中：阶段指示 + 轮次计数 + 预算余量进度条 + 最近结论行 + Esc 提示
 *   - 暂停点：budget → 「加预算」输入 + 续命（auto-run/budget）；stall /
 *     repeated-failures → 摘要 + 「继续 / 终止」（继续走 verdict:'continue'，
 *     契约无独立 resume 端点；终止走终止确认模态，与 Esc 同路径）
 *   - 待终审：验收包收起后显示「待终审」指示，点开重答（verdict-requested
 *     到达即自动弹 AutoRunVerdictModal）
 *   - 完成/终止：结果行 + 关闭（清 autoRun）
 *
 * 数据源：store.autoRun（SSE auto-run:* 归约 + auto-run/list 恢复）。
 */

import { useEffect, useState } from 'react';
import type React from 'react';

import { useGuiStore } from '../store/useGuiStore';
import {
  budgetUsedPct,
  formatBudget,
  isAutoRunActive,
  parseBudgetLimit,
  turnProgressOf,
  type AutoRunEntry,
} from '../model/auto-run';

const STATUS_TEXT: Record<AutoRunEntry['status'], string> = {
  starting: '启动中',
  running: '运行中',
  paused: '已暂停',
  'awaiting-verdict': '待终审',
  completed: '已完成',
  stopped: '已终止',
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

function BudgetRow({ entry }: { entry: AutoRunEntry }): React.JSX.Element {
  const [ext, setExt] = useState('');
  const extendAutoRunBudget = useGuiStore((s) => s.extendAutoRunBudget);
  const requestStopAutoRun = useGuiStore((s) => s.requestStopAutoRun);

  if (entry.status !== 'paused' || !entry.paused || entry.paused.reason !== 'budget') return <></>;

  const limit = parseBudgetLimit(ext);
  return (
    <div className="ar-pause">
      <span className="ar-pause-title">⏸ 预算耗尽——checkpoint 已落，提请续命（agent 无权自己加）</span>
      <div className="ar-budget-row">
        <input
          className="f-input ar-budget-limit"
          placeholder="续命预算（同单位）"
          value={ext}
          onChange={(e) => setExt(e.target.value)}
        />
        <button
          className="btn primary small"
          disabled={limit === null}
          onClick={() => {
            if (limit !== null) {
              setExt('');
              void extendAutoRunBudget(limit);
            }
          }}
        >
          加预算续命
        </button>
      </div>
      <button className="btn danger small" onClick={requestStopAutoRun}>终止</button>
    </div>
  );
}

function StallPauseRow({ entry }: { entry: AutoRunEntry }): React.JSX.Element {
  const requestStopAutoRun = useGuiStore((s) => s.requestStopAutoRun);

  if (
    entry.status !== 'paused' ||
    !entry.paused ||
    (entry.paused.reason !== 'stall' && entry.paused.reason !== 'repeated-failures')
  ) {
    return <></>;
  }

  const title =
    entry.paused.reason === 'stall'
      ? '⏸ 空转检测：连续多轮无新增有效研究记录且阶段未推进'
      : '⏸ 反复失败：同类工具连续多次 isError——证据与「有把握」冲突';
  return (
    <div className="ar-pause">
      <span className="ar-pause-title">{title}</span>
      {entry.paused.summary && <div className="ar-pause-summary">{entry.paused.summary}</div>}
      {/* 1.4.1 收口：stall/反复失败由 harness 提请 requestDecision（决策面板
          弹出），作答走 /chat/decision/respond——这里只提示 + 提供终止出口。 */}
      <div className="ar-pause-hint">已在决策面板提请——请作答（继续跑 / 终止运行）</div>
      <div className="ar-pause-actions">
        <button className="btn danger small" onClick={requestStopAutoRun}>终止</button>
      </div>
    </div>
  );
}

export function AutoRunCard(): React.JSX.Element | null {
  const entry = useGuiStore((s) => s.autoRun);
  const verdictDismissed = useGuiStore((s) => s.verdictDismissed);
  const openVerdict = useGuiStore((s) => s.openVerdict);
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
        {entry.status === 'awaiting-verdict' && (
          <span className="ar-verdict-tag">⚖ 验收条件已达成——请终审</span>
        )}
      </div>
      {entry.lastConclusion && (
        <div className="ar-conclusion" title={entry.lastConclusion}>
          最近结论 · {entry.lastConclusion}
        </div>
      )}

      <StallPauseRow entry={entry} />
      <BudgetRow entry={entry} />

      {entry.status === 'awaiting-verdict' && verdictDismissed && (
        <div className="ar-pause">
          <span className="ar-pause-title">⚖ 待终审——验收包已收起</span>
          <button className="btn primary small" onClick={openVerdict}>打开验收包</button>
        </div>
      )}

      <div className="ar-foot">
        {active ? (
          <span className="ar-esc-hint">
            <kbd>Esc</kbd> 终止 loop（二次确认）· 运行中仅观察——输入/环境切换已锁定
          </span>
        ) : (
          <span className="ar-esc-hint">
            {entry.status === 'completed' ? '✓ 完成' : '⏹ 已终止'}——loop 线可在 /tasks 回看
          </span>
        )}
        {!active && (
          <button className="btn small" onClick={dismissAutoRunCard}>关闭</button>
        )}
      </div>
    </div>
  );
}
