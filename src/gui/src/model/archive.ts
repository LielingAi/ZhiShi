/**
 * 1.4.4 研究档案 — GUI 侧纯模型层（与 server loop/archive.ts 契约逐字段对齐）。
 *
 * 分屏看板的数据面：类型（服务端快照的最小声明）、事件归约（archive:changed
 * 整包快照，按 sessionId 键控）、分组选择器（待答问题/当前假设/结论/证据/
 * 证伪）、徽章计数（未决问题 + 待复核）。零 IO——请求/广播消费在 store。
 */

// ---------------------------------------------------------------------------
// 形状（服务端 ArchiveSnapshot 的最小声明）
// ---------------------------------------------------------------------------

export type ArchiveEntityKind = 'hypothesis' | 'evidence' | 'finding' | 'question';

export interface ArchiveEntity {
  id: string;
  kind: ArchiveEntityKind;
  text: string;
  status: string;
  /** 产生本实体的轮次 user 消息 id（点锚跳流）。 */
  anchorMessageId?: string;
  anchorLabel?: string;
  /** 引用其他实体 id（H#/V#/C#/Q#）。 */
  links: string[];
  /** 反证证据 id（V#N，仅 finding——1.4.8 反证结构）。 */
  against?: string[];
  findingType?: string;
  needsReview?: boolean;
  reviewReason?: string;
  humanCorrected?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ArchiveCorrection {
  id: string;
  targetId: string;
  by: 'human' | 'model';
  reason: string;
  createdAt: string;
}

export interface ArchiveSnapshot {
  sessionId: string;
  entities: ArchiveEntity[];
  corrections: ArchiveCorrection[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 事件归约（archive:changed → 整包快照）
// ---------------------------------------------------------------------------

/** 事件 payload 归一化（读侧容错：坏字段丢弃不炸——SSE 事件不因脏数据崩 UI）。 */
export function applyArchiveChanged(payload: unknown): ArchiveSnapshot {
  const p = (payload ?? {}) as Record<string, unknown>;
  const entities = Array.isArray(p.entities)
    ? (p.entities as Array<Record<string, unknown>>)
      .filter((e) => typeof e?.id === 'string' && typeof e?.text === 'string' && typeof e?.kind === 'string')
      .map((e) => ({
        id: e.id as string,
        kind: e.kind as ArchiveEntityKind,
        text: e.text as string,
        status: typeof e.status === 'string' ? (e.status as string) : '',
        ...(typeof e.anchorMessageId === 'string' ? { anchorMessageId: e.anchorMessageId } : {}),
        ...(typeof e.anchorLabel === 'string' ? { anchorLabel: e.anchorLabel } : {}),
        links: Array.isArray(e.links) ? (e.links as string[]).filter((l) => typeof l === 'string') : [],
        ...(Array.isArray(e.against) ? { against: (e.against as string[]).filter((l) => typeof l === 'string') } : {}),
        ...(typeof e.findingType === 'string' ? { findingType: e.findingType } : {}),
        ...(e.needsReview === true ? { needsReview: true } : {}),
        ...(typeof e.reviewReason === 'string' ? { reviewReason: e.reviewReason } : {}),
        ...(e.humanCorrected === true ? { humanCorrected: true } : {}),
        createdAt: typeof e.createdAt === 'string' ? e.createdAt : '',
        updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : '',
      }))
    : [];
  const corrections = Array.isArray(p.corrections)
    ? (p.corrections as Array<Record<string, unknown>>)
      .filter((c) => typeof c?.id === 'string' && typeof c?.targetId === 'string')
      .map((c) => ({
        id: c.id as string,
        targetId: c.targetId as string,
        by: (c.by === 'human' ? 'human' : 'model') as 'human' | 'model',
        reason: typeof c.reason === 'string' ? c.reason : '',
        createdAt: typeof c.createdAt === 'string' ? c.createdAt : '',
      }))
    : [];
  return {
    sessionId: typeof p.sessionId === 'string' ? p.sessionId : '',
    entities,
    corrections,
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : '',
  };
}

// ---------------------------------------------------------------------------
// 分组选择器（看板分区：按研究需要排序，不是按时间）
// ---------------------------------------------------------------------------

const REF_ID_RE = /^[HVCQ]#\d+$/;

/** 实体引用的其他实体 id（links 里过滤出 H#/V#/C#/Q# 形态）。 */
export function entityRefs(e: ArchiveEntity): string[] {
  return e.links.filter((l) => REF_ID_RE.test(l));
}

/** 待答问题（open question，看板顶部——还缺哪一环）。 */
export function archiveOpenQuestions(s: ArchiveSnapshot | null): ArchiveEntity[] {
  return s ? s.entities.filter((e) => e.kind === 'question' && e.status === 'open') : [];
}

/** 当前假设（pending——正在验证什么）。 */
export function archivePendingHypotheses(s: ArchiveSnapshot | null): ArchiveEntity[] {
  return s ? s.entities.filter((e) => e.kind === 'hypothesis' && e.status === 'pending') : [];
}

/** 结论（全部 finding；被纠正/待复核的带徽章留在原地——成果的完整史）。 */
export function archiveFindings(s: ArchiveSnapshot | null): ArchiveEntity[] {
  return s ? s.entities.filter((e) => e.kind === 'finding') : [];
}

/** 证据（evidence 全部；看板默认折叠到最近几条）。 */
export function archiveEvidence(s: ArchiveSnapshot | null): ArchiveEntity[] {
  return s ? s.entities.filter((e) => e.kind === 'evidence') : [];
}

/** 证伪与纠正区：证伪的假设 + 被推翻的证据 + 纠正条目（排除的路也是成果）。 */
export function archiveFalsified(s: ArchiveSnapshot | null): Array<{ entity?: ArchiveEntity; correction?: ArchiveCorrection }> {
  if (!s) return [];
  const byId = new Map(s.entities.map((e) => [e.id, e]));
  const rows: Array<{ entity?: ArchiveEntity; correction?: ArchiveCorrection }> = [];
  for (const c of s.corrections) {
    rows.push({ entity: byId.get(c.targetId), correction: c });
  }
  for (const e of s.entities) {
    if ((e.kind === 'hypothesis' && e.status === 'falsified') || (e.kind === 'evidence' && e.status === 'overturned')) {
      if (!s.corrections.some((c) => c.targetId === e.id)) rows.push({ entity: e });
    }
  }
  return rows;
}

/** 徽章计数：未决问题 + 待复核（工具栏图标上——档案永不真正消失）。 */
export function archiveBadgeCount(s: ArchiveSnapshot | null): number {
  if (!s) return 0;
  return archiveOpenQuestions(s).length + s.entities.filter((e) => e.needsReview).length;
}

// ---------------------------------------------------------------------------
// 1.4.8 链式投影（替换类型分区——对应关系从 links 反向索引派生，不是存储）
// ---------------------------------------------------------------------------

/** 一条研究线：假设 → 由它驱动的证据 → 链上结论（含反证挂边）。 */
export interface ArchiveThread {
  hypothesis: ArchiveEntity;
  /** 由本假设驱动的证据（V 的 links 挂本 H#）。 */
  evidence: ArchiveEntity[];
  /** 链上结论：直挂本 H#，或 refs 经链上证据反推（C → V → H）。 */
  findings: ArchiveEntity[];
}

/** 断链实体（挂链纪律收紧前的存量 + 模型偷懒的新增——显式列出，装不了不知道）。 */
export interface ArchiveOrphans {
  /** 未挂驱动假设的证据（「顺手观察」语义合法，但断链要看得见）。 */
  evidence: ArchiveEntity[];
  /** 不挂在任何研究线上的结论。 */
  findings: ArchiveEntity[];
}

const EVIDENCE_ID_RE = /^V#\d+$/;

function computeChains(s: ArchiveSnapshot | null): { threads: ArchiveThread[]; orphans: ArchiveOrphans } {
  const empty = { threads: [], orphans: { evidence: [], findings: [] } };
  if (!s) return empty;
  const hypotheses = s.entities.filter((e) => e.kind === 'hypothesis');
  const allEvidence = s.entities.filter((e) => e.kind === 'evidence');
  const allFindings = s.entities.filter((e) => e.kind === 'finding');
  const threads: ArchiveThread[] = [];
  const assignedEvidence = new Set<string>();
  const assignedFindings = new Set<string>();
  for (const h of hypotheses) {
    const evidence = allEvidence.filter((e) => e.links.includes(h.id));
    for (const e of evidence) assignedEvidence.add(e.id);
    const evIds = new Set(evidence.map((e) => e.id));
    // 结论认领规则（确定性）：直挂本 H# 优先，其次经链上 V# 反推；
    // 跨线结论被先扫到的线认领（实体序 = 时序）。
    const findings = allFindings.filter(
      (f) => !assignedFindings.has(f.id) && (f.links.includes(h.id) || f.links.some((l) => evIds.has(l))),
    );
    for (const f of findings) assignedFindings.add(f.id);
    threads.push({ hypothesis: h, evidence, findings });
  }
  return {
    threads,
    orphans: {
      evidence: allEvidence.filter((e) => !assignedEvidence.has(e.id)),
      findings: allFindings.filter((f) => !assignedFindings.has(f.id)),
    },
  };
}

/** 研究线列表（按假设时序）。 */
export function archiveThreads(s: ArchiveSnapshot | null): ArchiveThread[] {
  return computeChains(s).threads;
}

/** 断链实体（孤儿区）。 */
export function archiveOrphans(s: ArchiveSnapshot | null): ArchiveOrphans {
  return computeChains(s).orphans;
}

/** 结论的支持/反证计数（看板「+N / −M」徽章）。 */
export function findingEvidenceCounts(e: ArchiveEntity): { supports: number; against: number } {
  return {
    supports: e.links.filter((l) => EVIDENCE_ID_RE.test(l)).length,
    against: (e.against ?? []).filter((l) => EVIDENCE_ID_RE.test(l)).length,
  };
}

/** 状态 → 中文标签（看板徽章）。 */
export const ENTITY_STATUS_LABEL: Record<string, string> = {
  pending: '待验证',
  confirmed: '已证实',
  falsified: '已证伪',
  valid: '有效',
  doubtful: '存疑',
  overturned: '被推翻',
  established: '成立',
  corrected: '被纠正',
  open: '打开',
  resolved: '已解决',
  abandoned: '放弃',
};

/** 结论类型 → 中文标签。 */
export const FINDING_TYPE_LABEL: Record<string, string> = {
  bug_class: '漏洞类别',
  primitive: '原语',
  constraint: '约束',
  fact: '事实',
};
