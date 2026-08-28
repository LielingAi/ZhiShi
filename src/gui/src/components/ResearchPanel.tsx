/**
 * 1.4.4 研究看板——研究档案的进行时投影（分屏右屏 / 小窗抽屉共用同一组件）。
 *
 * 分区按研究需要排序（不是按时间）：待答问题 → 当前假设 → 结论 → 证据
 * （默认折叠）→ 证伪与纠正（默认折叠）。行内纠正不弹窗：点行展开纠正
 * 输入；档案锚（anchorMessageId）点一下跳流；引用 chip 点一下高亮另一条
 * 实体（正反推论的交互落实）；待复核徽章悬停看理由。
 */

import { useState } from 'react';
import type React from 'react';

import {
  archiveConfirmedHypotheses,
  archiveEvidence,
  archiveFalsified,
  archiveFindings,
  archiveOpenQuestions,
  archivePendingHypotheses,
  entityRefs,
  ENTITY_STATUS_LABEL,
  FINDING_TYPE_LABEL,
  type ArchiveEntity,
} from '../model/archive';
import { useGuiStore } from '../store/useGuiStore';

function statusChip(e: ArchiveEntity): React.JSX.Element | null {
  const label = ENTITY_STATUS_LABEL[e.status];
  if (!label) return null;
  const cls =
    ['falsified', 'overturned', 'corrected', 'doubtful'].includes(e.status)
      ? 'arc-chip arc-chip-bad'
      : e.status === 'open' || e.status === 'pending'
        ? 'arc-chip arc-chip-live'
        : 'arc-chip';
  return <span className={cls}>{label}</span>;
}

function Row({
  e,
  highlightId,
  onHighlight,
  onJump,
  onEdit,
  editing,
  reason,
  onReason,
  onSubmit,
  onResolve,
}: {
  e: ArchiveEntity;
  highlightId: string | null;
  onHighlight(id: string | null): void;
  onJump(messageId: string): void;
  onEdit(id: string | null): void;
  editing: boolean;
  reason: string;
  onReason(v: string): void;
  onSubmit(): void;
  /** 待验证假设专有：一键证实（终态推进，与「纠正=标错」对称）。 */
  onResolve?(): void;
}): React.JSX.Element {
  const refs = entityRefs(e);
  const typeLabel = e.findingType ? FINDING_TYPE_LABEL[e.findingType] : undefined;
  return (
    <div className={`arc-row${editing ? ' editing' : ''}${highlightId === e.id ? ' hl' : ''}`}>
      <div className="arc-row-main" onClick={() => onEdit(editing ? null : e.id)} title="点击行内纠正（不弹窗）">
        <span className="arc-id">{e.id}</span>
        {typeLabel && <span className="arc-kind">{typeLabel}</span>}
        <span className="arc-text">{e.text}</span>
        {statusChip(e)}
        {e.needsReview && (
          <span className="arc-chip arc-chip-warn" title={e.reviewReason ?? '依赖的条目被纠正'}>待复核</span>
        )}
        {e.humanCorrected && <span className="arc-chip arc-chip-human" title="人已纠正（终局）">人纠正</span>}
        {onResolve && (
          <button
            className="btn small arc-resolve"
            title="实验已证实这条假设——给它终态（已证实）"
            onClick={(ev) => {
              ev.stopPropagation();
              onResolve();
            }}
          >
            ✓ 证实
          </button>
        )}
      </div>
      {(refs.length > 0 || e.anchorMessageId || e.anchorLabel) && (
        <div className="arc-row-sub">
          {refs.map((r) => (
            <span
              key={r}
              className="arc-ref"
              title={`在档案中定位 ${r}`}
              onClick={() => onHighlight(highlightId === r ? null : r)}
            >
              {r}
            </span>
          ))}
          {e.anchorMessageId && (
            <span className="arc-anchor" title={e.anchorLabel ?? '跳到产生它的那轮对话'} onClick={() => onJump(e.anchorMessageId!)}>
              ⤴ 流
            </span>
          )}
          {e.anchorLabel && !e.anchorMessageId && <span className="arc-anchor-label">{e.anchorLabel}</span>}
        </div>
      )}
      {editing && (
        <div className="arc-edit">
          <input
            className="f-input"
            placeholder="错在哪、为什么（纠正留痕，不删除原文）"
            value={reason}
            onChange={(ev) => onReason(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' && reason.trim()) {
                ev.preventDefault();
                onSubmit();
              }
            }}
            autoFocus
          />
          <button className="btn small primary" disabled={!reason.trim()} onClick={onSubmit}>
            纠正
          </button>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  children,
  collapsible,
  open,
  onToggle,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
}): React.JSX.Element {
  if (count === 0) return <></>;
  return (
    <div className="arc-section">
      <div className="arc-section-head" onClick={collapsible ? onToggle : undefined}>
        <span className="arc-section-title">
          {title} <span className="arc-count">{count}</span>
        </span>
        {collapsible && <span className="arc-fold">{open ? '⏷' : '⏵'}</span>}
      </div>
      {(!collapsible || open) && <div className="arc-section-body">{children}</div>}
    </div>
  );
}

export function ResearchPanel(): React.JSX.Element {
  const archive = useGuiStore((s) => s.archive);
  const highlightId = useGuiStore((s) => s.archiveHighlightId);
  const setHighlight = useGuiStore((s) => s.setArchiveHighlight);
  const jump = useGuiStore((s) => s.jumpToArchiveAnchor);
  const correct = useGuiStore((s) => s.correctArchiveEntity);
  const resolve = useGuiStore((s) => s.resolveArchiveEntity);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [falsifiedOpen, setFalsifiedOpen] = useState(false);

  const openQuestions = archiveOpenQuestions(archive);
  // 当前假设 = 待验证 + 已证实（有终态的留痕不消失；证伪的在「证伪与纠正」区）。
  const hypotheses = [...archivePendingHypotheses(archive), ...archiveConfirmedHypotheses(archive)];
  const findings = archiveFindings(archive);
  const evidence = archiveEvidence(archive);
  const falsified = archiveFalsified(archive);

  if (!archive || archive.entities.length === 0) {
    return (
      <div className="arc-panel">
        <div className="arc-head">
          <span className="arc-head-title">研究档案</span>
          <span className="arc-head-sub">过程记录 + 成果汇总</span>
        </div>
        <div className="arc-empty">
          档案随研究生长——模型开始研究后，这里会长出假设、证据、结论、未决问题。结论必须有证据支撑；证伪同样留痕。
        </div>
      </div>
    );
  }

  const submit = (id: string) => {
    if (!reason.trim()) return;
    void correct(id, reason.trim());
    setEditingId(null);
    setReason('');
  };

  const rowProps = (e: ArchiveEntity) => ({
    highlightId,
    onHighlight: setHighlight,
    onJump: jump,
    editing: editingId === e.id,
    reason,
    onReason: setReason,
    onSubmit: () => submit(e.id),
    // 待验证假设给「✓ 证实」终态入口（confirmed 曾是死状态——证实无路径可达）。
    ...(e.kind === 'hypothesis' && e.status === 'pending' ? { onResolve: () => void resolve(e.id) } : {}),
  });

  return (
    <div className="arc-panel">
      <div className="arc-head">
        <span className="arc-head-title">研究档案</span>
        <span className="arc-head-sub">每轮注回模型 · 点行纠正 · 点锚跳流</span>
      </div>
      <div className="arc-scroll">
        <Section title="待答问题" count={openQuestions.length}>
          {openQuestions.map((e) => (
            <Row key={e.id} e={e} onEdit={setEditingId} {...rowProps(e)} />
          ))}
        </Section>
        <Section title="当前假设" count={hypotheses.length}>
          {hypotheses.map((e) => (
            <Row key={e.id} e={e} onEdit={setEditingId} {...rowProps(e)} />
          ))}
        </Section>
        <Section title="结论" count={findings.length}>
          {findings.map((e) => (
            <Row key={e.id} e={e} onEdit={setEditingId} {...rowProps(e)} />
          ))}
        </Section>
        <Section title="证据" count={evidence.length} collapsible open={evidenceOpen} onToggle={() => setEvidenceOpen(!evidenceOpen)}>
          {evidence.slice(-(evidenceOpen ? evidence.length : 5)).map((e) => (
            <Row key={e.id} e={e} onEdit={setEditingId} {...rowProps(e)} />
          ))}
        </Section>
        <Section title="证伪与纠正" count={falsified.length} collapsible open={falsifiedOpen} onToggle={() => setFalsifiedOpen(!falsifiedOpen)}>
          {falsified.map((row) =>
            row.correction ? (
              <div key={row.correction.id} className="arc-correction">
                <span className="arc-id">{row.correction.id}</span>
                <span className="arc-kind">{row.correction.by === 'human' ? '人纠正' : '模型自证伪'}</span>
                <span className="arc-text">{row.entity ? `${row.entity.id} ${row.entity.text}` : row.correction.targetId}</span>
                <div className="arc-correction-reason">{row.correction.reason}</div>
              </div>
            ) : row.entity ? (
              <Row key={row.entity.id} e={row.entity} onEdit={setEditingId} {...rowProps(row.entity)} />
            ) : null,
          )}
        </Section>
      </div>
    </div>
  );
}
