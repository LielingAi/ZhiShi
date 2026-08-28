/**
 * 1.4.4 研究看板——研究档案的进行时投影（分屏右屏 / 小窗抽屉共用同一组件）。
 * 1.4.8 起：**链式投影替换类型分区**（用户拍板——N 假设/N 证据/N 结论平铺
 * 对不上号，对应关系在 links 里，看板按研究线组织而不是按类型分摞）。
 *
 * 分区：待答问题 → 研究线（假设 → 证据 → 结论/反证，终态线默认折叠）→
 * 孤儿区（断链实体显式列出——挂链纪律的结构压力）。行内纠正不弹窗：点行
 * 展开纠正输入（待验证假设/未决问题另有「搁置」——不追了≠错了）；待验证
 * 假设行内「✓ 证实」一键终态；档案锚（anchorMessageId）点一下跳流；引用
 * chip 点一下高亮另一条实体；待复核徽章悬停看理由。
 */

import { useState } from 'react';
import type React from 'react';

import {
  archiveOpenQuestions,
  archiveOrphans,
  archiveThreads,
  entityRefs,
  ENTITY_STATUS_LABEL,
  FINDING_TYPE_LABEL,
  findingEvidenceCounts,
  type ArchiveEntity,
  type ArchiveThread,
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

/** 结论的支持/反证计数徽章（+N 支持 / −M 反证——反证共存不自动推翻）。 */
function evidenceChips(e: ArchiveEntity): React.JSX.Element | null {
  if (e.kind !== 'finding') return null;
  const { supports, against } = findingEvidenceCounts(e);
  if (supports === 0 && against === 0) return null;
  return (
    <>
      {supports > 0 && <span className="arc-chip arc-chip-ok" title="支持性证据数">+{supports}</span>}
      {against > 0 && <span className="arc-chip arc-chip-bad" title="反证数——反证与支持并列，累积到动摇结论时走纠正推翻">−{against}</span>}
    </>
  );
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
  onAbandon,
  correctionReason,
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
  /** 待验证假设/未决问题专有：搁置（不追了≠错了，留痕理由）。 */
  onAbandon?(): void;
  /** 该实体最近一次纠正的理由（留痕展示，不进编辑态）。 */
  correctionReason?: string;
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
        {evidenceChips(e)}
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
          {(e.against ?? []).map((r) => (
            <span
              key={r}
              className="arc-ref arc-ref-against"
              title={`反证——在档案中定位 ${r}`}
              onClick={() => onHighlight(highlightId === r ? null : r)}
            >
              −{r}
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
      {correctionReason && <div className="arc-correction-reason">{correctionReason}</div>}
      {editing && (
        <div className="arc-edit">
          <input
            className="f-input"
            placeholder={onAbandon ? '错在哪 / 为什么不追了（留痕，不删除原文）' : '错在哪、为什么（纠正留痕，不删除原文）'}
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
          {onAbandon && (
            <button className="btn small" disabled={!reason.trim()} onClick={onAbandon} title="不追了≠错了——搁置留痕，不算证伪">
              搁置
            </button>
          )}
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
  onToggle?(): void;
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
  const abandon = useGuiStore((s) => s.abandonArchiveEntity);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [collapsedThreads, setCollapsedThreads] = useState<Record<string, boolean>>({});
  const [orphanOpen, setOrphanOpen] = useState(true);

  const openQuestions = archiveOpenQuestions(archive);
  const threads = archiveThreads(archive);
  const orphans = archiveOrphans(archive);
  const orphanCount = orphans.evidence.length + orphans.findings.length;
  // 纠正留痕：targetId → 最近一次纠正理由（线程内联展示，不进编辑态）。
  const correctionByTarget = new Map((archive?.corrections ?? []).map((c) => [c.targetId, c.reason]));

  if (!archive || archive.entities.length === 0) {
    return (
      <div className="arc-panel">
        <div className="arc-head">
          <span className="arc-head-title">研究档案</span>
          <span className="arc-head-sub">过程记录 + 成果汇总</span>
        </div>
        <div className="arc-empty">
          档案随研究生长——模型开始研究后，这里会长出研究线：假设 → 证据 → 结论。结论必须有证据支撑；反证与证伪同样留痕。
        </div>
      </div>
    );
  }

  const submitCorrect = (id: string) => {
    if (!reason.trim()) return;
    void correct(id, reason.trim());
    setEditingId(null);
    setReason('');
  };

  const submitAbandon = (id: string) => {
    if (!reason.trim()) return;
    void abandon(id, reason.trim());
    setEditingId(null);
    setReason('');
  };

  const renderRow = (e: ArchiveEntity) => (
    <Row
      key={e.id}
      e={e}
      highlightId={highlightId}
      onHighlight={setHighlight}
      onJump={jump}
      editing={editingId === e.id}
      onEdit={setEditingId}
      reason={reason}
      onReason={setReason}
      onSubmit={() => submitCorrect(e.id)}
      correctionReason={correctionByTarget.get(e.id)}
      // 待验证假设给「✓ 证实」终态入口（confirmed 曾是死状态——证实无路径可达）。
      {...(e.kind === 'hypothesis' && e.status === 'pending' ? { onResolve: () => void resolve(e.id) } : {})}
      // 待验证假设/未决问题给「搁置」入口（1.4.8 第三终态：不追了≠错了）。
      {...((e.kind === 'hypothesis' && e.status === 'pending') || (e.kind === 'question' && e.status === 'open')
        ? { onAbandon: () => submitAbandon(e.id) }
        : {})}
    />
  );

  /** 终态线（证伪/搁置）默认折叠——留痕但不占屏；待验证/证实线常开。 */
  const threadCollapsed = (t: ArchiveThread): boolean =>
    collapsedThreads[t.hypothesis.id] ?? ['falsified', 'abandoned'].includes(t.hypothesis.status);

  return (
    <div className="arc-panel">
      <div className="arc-head">
        <span className="arc-head-title">研究档案</span>
        <span className="arc-head-sub">每轮注回模型 · 点行纠正 · 点锚跳流</span>
      </div>
      <div className="arc-scroll">
        <Section title="待答问题" count={openQuestions.length}>
          {openQuestions.map(renderRow)}
        </Section>
        <Section title="研究线" count={threads.length}>
          {threads.map((t) => (
            <div className="arc-thread" key={t.hypothesis.id}>
              <div className="arc-thread-head">
                <span
                  className="arc-fold arc-thread-fold"
                  title={threadCollapsed(t) ? '展开研究线' : '折叠研究线'}
                  onClick={() =>
                    setCollapsedThreads((prev) => ({ ...prev, [t.hypothesis.id]: !threadCollapsed(t) }))
                  }
                >
                  {threadCollapsed(t) ? '⏵' : '⏷'}
                </span>
                <div className="arc-thread-hyp">{renderRow(t.hypothesis)}</div>
              </div>
              {!threadCollapsed(t) && (
                <div className="arc-thread-body">
                  {t.evidence.map(renderRow)}
                  {t.findings.map(renderRow)}
                  {t.evidence.length === 0 && t.findings.length === 0 && (
                    <div className="arc-thread-empty">还没有证据——假设待实验驱动</div>
                  )}
                </div>
              )}
            </div>
          ))}
        </Section>
        <Section title="孤儿区（断链）" count={orphanCount} collapsible open={orphanOpen} onToggle={() => setOrphanOpen(!orphanOpen)}>
          <div className="arc-orphan-hint">未挂驱动假设的证据 / 不挂研究线的结论——看得见的断链。补上引用（refs/挂回 H#）即可归线。</div>
          {orphans.evidence.map(renderRow)}
          {orphans.findings.map(renderRow)}
        </Section>
      </div>
    </div>
  );
}
