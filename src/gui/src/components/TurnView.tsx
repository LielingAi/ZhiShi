/**
 * 块视图（核心结构）。
 *
 *   块首：你的输入（v19 user 气泡）＋ steering 徽标
 *   亮顶：结论聚合（assistant 全部文本，块内最显眼位置）
 *   徽标行：⎿ ⚙ N · ⏵ Ns · ⛁ name×N（buildBadgeSummary 纯函数算出）
 *   细节区：thinking 行 + 工具卡行（流式时自动展开，定格后折叠为徽标行）
 */

import { useMemo, useState } from 'react';
import type React from 'react';

import { buildBadgeSummary, type ThinkingDetail, type TurnBlock } from '../model/blocks';
import { parseDecisionBody } from '../model/decision';
import { useGuiStore } from '../store/useGuiStore';
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

/**
 * 1.3.2 ①：决策块首（kind:'decision' 的 user 消息）——琥珀结构化卡，不按
 * 普通 user 气泡渲染：选择/备注/expertRefs（E#N 徽章）+ 正文；块上有
 * promote 入口（「入专家库」→ 预填小表单 → expert/add）。
 */
function DecisionBlock({ turn }: { turn: TurnBlock }): React.JSX.Element {
  const setModal = useGuiStore((s) => s.setModal);
  const d = turn.decision;
  if (!d) return <></>;
  const parts = parseDecisionBody(turn.userText);
  const promote = () => {
    setModal({
      kind: 'promote',
      prefill: {
        title: parts.question ?? '',
        applicability: '',
        criteria: `选择: ${d.choice}${d.note ? `\n备注: ${d.note}` : ''}`,
        content: turn.userText,
      },
    });
  };
  return (
    <div className="decision-block">
      <div className="db-head">
        <span className="db-title">⚖ 人的决定</span>
        <span className="db-choice">{d.choice}</span>
        <button
          className="btn small db-promote"
          title="把这条决策沉淀为专家知识基准（expert/add）"
          onClick={promote}
        >
          入专家库
        </button>
      </div>
      {parts.question && <div className="db-question">问题：{parts.question}</div>}
      {d.note && <div className="db-note">备注：{d.note}</div>}
      {d.expertRefs.length > 0 && (
        <div className="db-refs">
          {d.expertRefs.map((r) => (
            <span className="dc-badge" key={r}>{r}</span>
          ))}
        </div>
      )}
      <div className="db-body">{turn.userText}</div>
    </div>
  );
}

export function TurnView({ turn }: { turn: TurnBlock }): React.JSX.Element {
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? turn.status === 'running';

  // 1.4.4 研究档案：本块产生的档案实体（anchorMessageId 落在本块 srvIds）
  // ——流内「→V3」归档标记，点一下在档案里定位（反推论的交互落实）。
  const archive = useGuiStore((s) => s.archive);
  const setHighlight = useGuiStore((s) => s.setArchiveHighlight);
  const setDrawerOpen = useGuiStore((s) => s.setArchiveDrawerOpen);
  const anchors = useMemo(
    () =>
      archive
        ? archive.entities.filter(
            (e) => e.anchorMessageId && turn.srvIds.includes(e.anchorMessageId),
          )
        : [],
    [archive, turn.srvIds],
  );

  const hasConclusion = turn.conclusion.length > 0;
  const emptyReply = turn.status === 'complete' && !hasConclusion;

  return (
    <div className="turn-block">
      <span className="b-time">{fmtTime(turn.createdAt)}</span>

      {/* 块首：你的输入（1.3.2 ①：决策消息渲染琥珀决策卡，不按普通气泡） */}
      {turn.decision ? (
        <DecisionBlock turn={turn} />
      ) : (
        <div className="user-row">
          <div className="bubble">
            {turn.userText || (turn.steering ? '（纠偏）' : '（系统）')}
          </div>
          {turn.steering && <span className="steer-badge" title="运行中发送，已进纠偏队列">纠偏</span>}
        </div>
      )}

      {/* 1.4.4 归档标记：本块产出的档案实体（点一下在档案中定位）。 */}
      {anchors.length > 0 && (
        <div className="arc-turn-badges">
          {anchors.map((e) => (
            <span
              key={e.id}
              className="arc-turn-badge"
              title={`${e.text}（点击在档案中定位）`}
              onClick={() => {
                setHighlight(e.id);
                setDrawerOpen(true);
              }}
            >
              → {e.id}
            </span>
          ))}
        </div>
      )}

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
