/**
 * 块视图（核心结构）。
 *
 *   块首：你的输入（v19 user 气泡）＋ steering 徽标
 *   亮顶：结论聚合（assistant 全部文本，块内最显眼位置）
 *   徽标行：⎿ ⚙ N · ⏵ Ns · ⛁ name×N（buildBadgeSummary 纯函数算出）
 *   细节区：thinking 行 + 工具卡行（流式时自动展开，定格后折叠为徽标行）
 */

import { useState } from 'react';
import type React from 'react';

import { buildBadgeSummary, type ThinkingDetail, type TurnBlock } from '../model/blocks';
import { ToolCard } from './ToolCard';

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function ThinkingRow({ detail }: { detail: ThinkingDetail }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const label = detail.text.split('\n')[0].slice(0, 60) || '思考中…';
  return (
    <div className="thinking-wrap">
      <div
        className={`thought-card ${open ? 'expanded' : ''}`}
        onClick={() => setOpen(!open)}
      >
        {label}
        {detail.streaming ? <span className="spinner" /> : null}
        {detail.seconds !== undefined && <span className="dur"> · {detail.seconds}s</span>}
      </div>
      {open && <div className="thought-body">{detail.text || '…'}</div>}
    </div>
  );
}

function BadgeRow({ turn, expanded, onToggle }: {
  turn: TurnBlock;
  expanded: boolean;
  onToggle(): void;
}): React.JSX.Element {
  const { toolCount, thinkingSeconds, histogram } = buildBadgeSummary(turn.details);
  const segs: string[] = [];
  if (toolCount > 0) segs.push(`⚙ ${toolCount}`);
  const secs = thinkingSeconds > 0
    ? thinkingSeconds
    : turn.meta && turn.meta.durationMs > 0
      ? Math.max(1, Math.round(turn.meta.durationMs / 1000))
      : 0;
  if (secs > 0) segs.push(`⏵ ${secs}s`);
  for (const h of histogram) segs.push(`⛁ ${h.name}×${h.count}`);
  if (segs.length === 0) return <></>;
  return (
    <div className="badge-row" onClick={onToggle} title="点击展开/折叠细节">
      <span className="badge-mark">{expanded ? '⏷' : '⏵'}</span> ⎿ {segs.join(' · ')}
    </div>
  );
}

export function TurnView({ turn }: { turn: TurnBlock }): React.JSX.Element {
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? turn.status === 'running';

  const hasConclusion = turn.conclusion.length > 0;
  const emptyReply = turn.status === 'complete' && !hasConclusion;

  return (
    <div className="turn-block">
      <span className="b-time">{fmtTime(turn.createdAt)}</span>

      {/* 块首：你的输入 */}
      <div className="user-row">
        <div className="bubble">
          {turn.userText || (turn.steering ? '（纠偏）' : '（系统）')}
        </div>
        {turn.steering && <span className="steer-badge" title="运行中发送，已进纠偏队列">纠偏</span>}
      </div>

      {/* 亮顶：结论聚合 */}
      {hasConclusion && (
        <div className={`conclusion-hl ${turn.conclusionStreaming ? 'streaming' : ''}`}>
          <span className="conclusion-text">{turn.conclusion}</span>
          {turn.conclusionStreaming && <span className="cursor">▌</span>}
        </div>
      )}
      {emptyReply && <div className="empty-reply">（模型空回复）</div>}

      {/* 徽标行（定格态折叠入口） */}
      {(turn.details.length > 0 || turn.meta !== undefined) && (
        <BadgeRow
          turn={turn}
          expanded={expanded}
          onToggle={() => setUserExpanded(!expanded)}
        />
      )}

      {/* 细节区：thinking + 工具卡 */}
      {expanded && turn.details.length > 0 && (
        <div className="turn-details">
          {turn.details.map((d) =>
            d.kind === 'thinking' ? (
              <ThinkingRow key={d.id} detail={d} />
            ) : (
              <ToolCard key={d.id} detail={d} />
            ),
          )}
        </div>
      )}
    </div>
  );
}
