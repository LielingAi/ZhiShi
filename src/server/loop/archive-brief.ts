/**
 * 2.2.1 — 研究档案「简报」：只读派生视图，不改任何实体。
 *
 * 研究员不需要读完整账本，只需要三件事：
 *   1. 靠得住的结论（有有效证据、无反证、非待复核）
 *   2. 还缺什么（未决问题 / 存疑结论 / 待评估反证 / 断链）
 *   3. 已经死了的路（证伪 / 纠正 / 放弃，附原因——防止重访）
 *
 * 所有判定都是确定性的（证据状态 + 反证 + needsReview），不让模型参与；
 * 「该不该继续投入」仍由人决定，这里只把证据面摆清楚。
 */

import type { ArchiveEntity, ArchiveSnapshot } from './archive';

export interface ArchiveBriefItem {
  id: string;
  kind: string;
  text: string;
  status: string;
  /** 有效支持证据数（links 里 status=valid 的 V#）。 */
  support: number;
  /** 反证数（against 里存在的 V#）。 */
  against: number;
  /** 已关闭条目的原因（取最近一条 correction；没有则用状态说明）。 */
  reason?: string;
}

export interface ArchiveBrief {
  /** 靠得住的结论。 */
  solid: ArchiveBriefItem[];
  /** 还缺什么（问题 / 存疑 / 待复核 / 反证待评估 / 无有效证据）。 */
  gaps: ArchiveBriefItem[];
  /** 已排除的路径。 */
  closed: ArchiveBriefItem[];
}

const STATUS_NOTE: Record<string, string> = {
  falsified: '已证伪',
  abandoned: '已搁置',
  corrected: '已纠正',
  overturned: '已被推翻',
};

function evidenceIds(snapshot: ArchiveSnapshot): Map<string, ArchiveEntity> {
  const map = new Map<string, ArchiveEntity>();
  for (const e of snapshot.entities) {
    if (e.kind === 'evidence') map.set(e.id, e);
  }
  return map;
}

function supportCount(entity: ArchiveEntity, evidence: Map<string, ArchiveEntity>): number {
  return entity.links.filter((id) => {
    const ev = evidence.get(id);
    return ev !== undefined && ev.status === 'valid';
  }).length;
}

function againstPresent(entity: ArchiveEntity, evidence: Map<string, ArchiveEntity>): number {
  return (entity.against ?? []).filter((id) => evidence.has(id)).length;
}

function lastReason(snapshot: ArchiveSnapshot, targetId: string): string | undefined {
  // corrections 是 append-only；后写覆盖先写（取最后一条）。
  for (let i = snapshot.corrections.length - 1; i >= 0; i -= 1) {
    const c = snapshot.corrections[i]!;
    if (c.targetId === targetId && c.reason.trim()) return c.reason.trim();
  }
  return undefined;
}

function item(entity: ArchiveEntity, evidence: Map<string, ArchiveEntity>, reason?: string): ArchiveBriefItem {
  return {
    id: entity.id,
    kind: entity.kind,
    text: entity.text,
    status: entity.status,
    support: supportCount(entity, evidence),
    against: againstPresent(entity, evidence),
    ...(reason ? { reason } : {}),
  };
}

/** 从档案快照派生简报（纯函数，稳定排序）。 */
export function buildArchiveBrief(snapshot: ArchiveSnapshot): ArchiveBrief {
  const evidence = evidenceIds(snapshot);
  const solid: ArchiveBriefItem[] = [];
  const gaps: ArchiveBriefItem[] = [];
  const closed: ArchiveBriefItem[] = [];

  for (const e of snapshot.entities) {
    if (e.kind === 'finding') {
      const support = supportCount(e, evidence);
      const against = againstPresent(e, evidence);
      if (e.status === 'established' && !e.needsReview && support > 0 && against === 0) {
        solid.push(item(e, evidence));
      } else if (e.status === 'established' && (e.needsReview || against > 0 || support === 0)) {
        // 有争议/待复核/没有有效证据：不进「靠得住」，进缺口，并说明原因。
        const why = e.needsReview
          ? '待复核'
          : against > 0
            ? `有 ${against} 条反证待评估`
            : '没有有效支持证据';
        gaps.push(item(e, evidence, why));
      } else if (e.status === 'doubtful') {
        gaps.push(item(e, evidence, '存疑：需要独立复现'));
      } else if (e.status === 'corrected') {
        closed.push(item(e, evidence, lastReason(snapshot, e.id) ?? STATUS_NOTE.corrected));
      }
      continue;
    }
    if (e.kind === 'question') {
      if (e.status === 'open') gaps.push(item(e, evidence, '未决问题'));
      else if (e.status === 'abandoned') closed.push(item(e, evidence, lastReason(snapshot, e.id) ?? STATUS_NOTE.abandoned));
      continue;
    }
    if (e.kind === 'hypothesis') {
      if (e.status === 'falsified' || e.status === 'abandoned') {
        closed.push(item(e, evidence, lastReason(snapshot, e.id) ?? STATUS_NOTE[e.status] ?? e.status));
      }
      continue;
    }
    if (e.kind === 'evidence' && e.status === 'overturned') {
      closed.push(item(e, evidence, lastReason(snapshot, e.id) ?? STATUS_NOTE.overturned));
    }
  }

  const bySupport = (a: ArchiveBriefItem, b: ArchiveBriefItem): number =>
    b.support - a.support || a.id.localeCompare(b.id, 'en');
  solid.sort(bySupport);
  // 缺口排序：问题优先（决定下一步做什么），再按支持证据从少到多。
  gaps.sort((a, b) => {
    const rank = (x: ArchiveBriefItem): number => (x.kind === 'question' ? 0 : 1);
    return rank(a) - rank(b) || a.support - b.support || a.id.localeCompare(b.id, 'en');
  });
  closed.sort((a, b) => a.id.localeCompare(b.id, 'en'));

  return { solid, gaps, closed };
}
