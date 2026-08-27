/**
 * 1.4.4 — 研究档案（研究 = 过程 + 成果 的落地载体）。
 *
 * 用户定框架（2026-08-27）：研究 = 过程 + 成果；协同研究 = 过程记录 +
 * 成果汇总；两者全程举证，可推论（过程正推成果）、可反推论（成果倒查
 * 过程）、可纠正（定位错处、级联更新，不是覆盖）。本模块就是「档案」的
 * 服务端半：实体层 + 纠正 + 持久化 + 渲染投影。
 *
 * 实体层四类 + 纠正条目（每会话一份，跨会话档案是蒸馏弧职责——不做）：
 *   - 假设 H#n：可验证的断言（pending / confirmed / falsified）
 *   - 证据 V#n：实验观察到的结果（valid / doubtful / overturned）
 *   - 结论 C#n：关于系统的断言，带类型 bug_class / primitive / constraint /
 *     fact（established / doubtful / corrected）
 *   - 未决问题 Q#n：还缺哪一环（open / resolved / abandoned）
 *   - 纠正条目 R#n：append-only（不删原文，研究记录本从不撕页）
 *
 * 每实体三要素（举证/推论/反推论/纠正的机械支撑）：
 *   - 来源锚 anchorMessageId（产生该实体的轮次 user 消息 id，GUI 互跳）
 *     + anchorLabel（模型自由标注，如「第 3 轮 env_exec 输出」）
 *   - 状态 status（上面的状态机）
 *   - 链接 links（引用其他实体 id：假设→证据→结论正着通，反着也能走）
 *
 * 纠正语义：
 *   - append-only 纠正条目 {targetId, by, reason, createdAt}；原文不动，
 *     状态翻转（conclusion→corrected / evidence→overturned / hypothesis→
 *     falsified / question→abandoned）；
 *   - 级联不连坐：引用被纠正实体的下游实体只打 needsReview（它们可能凭
 *     别的依据仍成立），重新推论后可翻案；
 *   - 权威序：人 > 专家知识 > 模型自证伪。人纠正过的实体（humanCorrected）
 *     拒绝模型再纠正——人的纠正在本会话内是终局。
 *
 * 存储：`<loop-sessions 目录>/<sessionId>.archive.json`，锁内读-改-写 +
 * tmp+rename 原子替换（withFileLock，与 session.ts 同一惯例）。缺失/损坏
 * → 空档案（读侧容错，研究不因档案 IO 故障而阻塞）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getZhiShiDataDir } from '../utils/app-dirs';
import { withFileLock } from '../utils/file-lock';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ArchiveEntityKind = 'hypothesis' | 'evidence' | 'finding' | 'question';

export type HypothesisStatus = 'pending' | 'confirmed' | 'falsified';
export type EvidenceStatus = 'valid' | 'doubtful' | 'overturned';
export type FindingStatus = 'established' | 'doubtful' | 'corrected';
export type QuestionStatus = 'open' | 'resolved' | 'abandoned';

/** 结论类型（成果面的分类，报告按此分组呈现）。 */
export type FindingType = 'bug_class' | 'primitive' | 'constraint' | 'fact';

/** 纠正者：human = 人（GUI 行内纠正 / API）；model = 模型自证伪。 */
export type CorrectionBy = 'human' | 'model';

export interface ArchiveEntity {
  id: string;
  kind: ArchiveEntityKind;
  /** 实体正文（一句话断言/观察/问题——档案行要短，全文在流与证据里）。 */
  text: string;
  status: string;
  /** 来源锚：产生本实体的轮次 user 消息 id（GUI 点锚跳流）。 */
  anchorMessageId?: string;
  /** 来源锚自由标注（模型写，如「第 3 轮 env_exec 输出」）。 */
  anchorLabel?: string;
  /** 链接：引用其他实体 id（如 "Q#1,C#2" → ["Q#1","C#2"]）。 */
  links: string[];
  /** 结论类型（仅 finding）。 */
  findingType?: FindingType;
  /** 级联标记：依赖的实体被纠正 → 待复核（不连坐，见文件头）。 */
  needsReview?: boolean;
  reviewReason?: string;
  /** 人已纠正过（模型不得再纠正——权威序）。 */
  humanCorrected?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CorrectionEntry {
  id: string;
  targetId: string;
  by: CorrectionBy;
  reason: string;
  createdAt: string;
}

export interface ArchiveSnapshot {
  sessionId: string;
  entities: ArchiveEntity[];
  corrections: CorrectionEntry[];
  updatedAt: string;
}

export interface ArchiveStoreOptions {
  /** 存储目录（测试注入临时目录；默认 loop-sessions 目录）。 */
  dir?: string;
}

/** 空档案（无文件/损坏时的读侧容错产物）。 */
export function emptyArchive(sessionId: string): ArchiveSnapshot {
  return { sessionId, entities: [], corrections: [], updatedAt: '' };
}

// ---------------------------------------------------------------------------
// id / 文件路径
// ---------------------------------------------------------------------------

const ID_PREFIX: Record<ArchiveEntityKind, string> = {
  hypothesis: 'H',
  evidence: 'V',
  finding: 'C',
  question: 'Q',
};

/** 档案文件名（sessionId 与 loop-sessions 同目录并存）。 */
export function archiveFile(id: string, dir: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '');
  return join(dir, `${safe}.archive.json`);
}

function archiveDir(options?: ArchiveStoreOptions): string {
  return options?.dir ?? join(getZhiShiDataDir(), 'loop-sessions');
}

// ---------------------------------------------------------------------------
// 持久化（锁内读-改-写 + tmp+rename）
// ---------------------------------------------------------------------------

interface ArchiveFileBody {
  meta: { counters: Record<string, number>; updatedAt: string };
  entities: ArchiveEntity[];
  corrections: CorrectionEntry[];
}

function parseBody(raw: string): ArchiveFileBody | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ArchiveFileBody>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      meta: {
        counters: (parsed.meta?.counters && typeof parsed.meta.counters === 'object')
          ? parsed.meta.counters
          : {},
        updatedAt: typeof parsed.meta?.updatedAt === 'string' ? parsed.meta.updatedAt : '',
      },
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      corrections: Array.isArray(parsed.corrections) ? parsed.corrections : [],
    };
  } catch {
    return null;
  }
}

function serializeBody(body: ArchiveFileBody): string {
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** 读档案（缺失/损坏 → 空档案；IO 容错，研究不因档案故障阻塞）。 */
export function loadArchive(sessionId: string, options?: ArchiveStoreOptions): ArchiveSnapshot {
  const file = archiveFile(sessionId, archiveDir(options));
  if (!existsSync(file)) return emptyArchive(sessionId);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return emptyArchive(sessionId);
  }
  const body = parseBody(raw);
  if (!body) return emptyArchive(sessionId);
  return {
    sessionId,
    entities: body.entities,
    corrections: body.corrections,
    updatedAt: body.meta.updatedAt,
  };
}

/**
 * 锁内读-改-写：fn 拿到的 draft 是文件当前真相（或空档案），返回新 body。
 * 串行化并发写（与 session.ts 同纪律）；tmp+rename 原子替换。
 */
async function mutateArchive(
  sessionId: string,
  fn: (draft: ArchiveFileBody) => ArchiveFileBody,
  options?: ArchiveStoreOptions,
): Promise<ArchiveFileBody> {
  const dir = archiveDir(options);
  mkdirSync(dir, { recursive: true });
  const file = archiveFile(sessionId, dir);
  let next!: ArchiveFileBody;
  await withFileLock({ lockPath: `${file}.lock` }, async () => {
    const existing = loadArchive(sessionId, options);
    const draft: ArchiveFileBody = {
      meta: { counters: {}, updatedAt: existing.updatedAt },
      entities: existing.entities,
      corrections: existing.corrections,
    };
    // counters 不随实体区走——从现有 id 反推最大序数（缺失文件时零起步）。
    const maxSeq = (prefix: string): number => {
      let m = 0;
      for (const e of existing.entities) {
        const hit = new RegExp(`^${prefix}#(\\d+)$`).exec(e.id);
        if (hit) m = Math.max(m, Number(hit[1]));
      }
      for (const c of existing.corrections) {
        const hit = /^R#(\d+)$/.exec(c.id);
        if (hit) m = Math.max(m, Number(hit[1]));
      }
      return m;
    };
    draft.meta.counters = {
      H: maxSeq('H'),
      V: maxSeq('V'),
      C: maxSeq('C'),
      Q: maxSeq('Q'),
      R: maxSeq('R'),
    };
    next = fn(draft);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, serializeBody(next), 'utf-8');
    renameSync(tmp, file);
  });
  return next;
}

// ---------------------------------------------------------------------------
// 纯函数 — 编号 / 状态机 / 级联
// ---------------------------------------------------------------------------

function nextId(kind: ArchiveEntityKind, counters: Record<string, number>): string {
  const prefix = ID_PREFIX[kind];
  counters[prefix] = (counters[prefix] ?? 0) + 1;
  return `${prefix}#${counters[prefix]}`;
}

function nextCorrectionId(counters: Record<string, number>): string {
  counters.R = (counters.R ?? 0) + 1;
  return `R#${counters.R}`;
}

/** 实体被纠正时的状态翻转表（问题有独立 resolve 路径，不走纠正）。 */
const CORRECTED_STATUS: Partial<Record<ArchiveEntityKind, string>> = {
  hypothesis: 'falsified',
  evidence: 'overturned',
  finding: 'corrected',
};

/** 解析逗号分隔的实体 id 列表（"Q#1,C#2" → ["Q#1","C#2"]；非法 token 抛错）。 */
export function parseEntityRefs(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const token of raw.split(',')) {
    const t = token.trim();
    if (!t) continue;
    if (!/^[HVCQ]#\d+$/.test(t)) {
      throw new Error(`实体引用含非法 id "${token.trim()}"（H#/V#/C#/Q# 编号，逗号分隔）`);
    }
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** 级联：所有 links 含 targetId 的实体打待复核标记（不连坐、不翻转）。 */
function markDependentsForReview(entities: ArchiveEntity[], targetId: string, reason: string): void {
  for (const e of entities) {
    if (e.id === targetId) continue;
    if (e.links.includes(targetId)) {
      e.needsReview = true;
      e.reviewReason = `依赖被纠正（${targetId}：${reason.slice(0, 120)}）`;
      e.updatedAt = new Date().toISOString();
    }
  }
}

// ---------------------------------------------------------------------------
// 写操作（模型写 / 人纠正的统一入口；全部返回新快照）
// ---------------------------------------------------------------------------

export type BroadcastFn = (event: string, data: unknown) => void;

/** 归档变更 SSE 事件名（GUI 整包刷新档案）。 */
export const ARCHIVE_CHANGED_EVENT = 'archive:changed';

/** 变更广播（mutation 后调用；测试注入 no-op）。字面量发射——SSE 双向对账
 *  （sse-whitelist-crosscheck）按 broadcastFn('…') 字面量扫描发射点。 */
function broadcastArchive(snapshot: ArchiveSnapshot, broadcastFn?: BroadcastFn): void {
  if (!broadcastFn) return;
  broadcastFn('archive:changed', {
    sessionId: snapshot.sessionId,
    entities: snapshot.entities,
    corrections: snapshot.corrections,
    updatedAt: snapshot.updatedAt,
  });
}

function toSnapshot(sessionId: string, body: ArchiveFileBody): ArchiveSnapshot {
  return {
    sessionId,
    entities: body.entities,
    corrections: body.corrections,
    updatedAt: body.meta.updatedAt,
  };
}

function freshTimestamp(): string {
  return new Date().toISOString();
}

export interface ArchiveMutationOptions {
  dir?: string;
  broadcastFn?: BroadcastFn;
}

export interface AddEntityInput {
  text: string;
  /** 逗号分隔实体 id（链接）。 */
  refs?: string;
  anchorMessageId?: string;
  anchorLabel?: string;
  findingType?: FindingType;
}

function buildEntity(
  id: string,
  kind: ArchiveEntityKind,
  input: AddEntityInput,
  links: string[],
  status: string,
  now: string,
): ArchiveEntity {
  const entity: ArchiveEntity = {
    id,
    kind,
    text: input.text.trim(),
    status,
    links,
    createdAt: now,
    updatedAt: now,
  };
  if (input.anchorMessageId) entity.anchorMessageId = input.anchorMessageId;
  if (input.anchorLabel) entity.anchorLabel = input.anchorLabel.trim();
  if (kind === 'finding' && input.findingType) entity.findingType = input.findingType;
  return entity;
}

/** 新增假设（pending）。refs = 派生依据（未决问题/结论 id）。 */
export async function addHypothesis(
  sessionId: string,
  input: AddEntityInput,
  options: ArchiveMutationOptions = {},
): Promise<ArchiveSnapshot> {
  const body = await mutateArchive(sessionId, (draft) => {
    const id = nextId('hypothesis', draft.meta.counters);
    draft.entities.push(buildEntity(id, 'hypothesis', input, parseEntityRefs(input.refs), 'pending', freshTimestamp()));
    draft.meta.updatedAt = freshTimestamp();
    return draft;
  }, { dir: options.dir });
  const snapshot = toSnapshot(sessionId, body);
  broadcastArchive(snapshot, options.broadcastFn);
  return snapshot;
}

/** 新增证据（valid）。refs = 由哪个假设驱动（producedBy）。 */
export async function addEvidence(
  sessionId: string,
  input: AddEntityInput,
  options: ArchiveMutationOptions = {},
): Promise<ArchiveSnapshot> {
  const body = await mutateArchive(sessionId, (draft) => {
    const id = nextId('evidence', draft.meta.counters);
    draft.entities.push(buildEntity(id, 'evidence', input, parseEntityRefs(input.refs), 'valid', freshTimestamp()));
    draft.meta.updatedAt = freshTimestamp();
    return draft;
  }, { dir: options.dir });
  const snapshot = toSnapshot(sessionId, body);
  broadcastArchive(snapshot, options.broadcastFn);
  return snapshot;
}

/** 新增结论（established）。refs = 证据引用（V#N，反推论的锚）。 */
export async function addFinding(
  sessionId: string,
  input: AddEntityInput,
  options: ArchiveMutationOptions = {},
): Promise<ArchiveSnapshot> {
  const body = await mutateArchive(sessionId, (draft) => {
    const id = nextId('finding', draft.meta.counters);
    draft.entities.push(buildEntity(id, 'finding', input, parseEntityRefs(input.refs), 'established', freshTimestamp()));
    draft.meta.updatedAt = freshTimestamp();
    return draft;
  }, { dir: options.dir });
  const snapshot = toSnapshot(sessionId, body);
  broadcastArchive(snapshot, options.broadcastFn);
  return snapshot;
}

/** 新增未决问题（open）。 */
export async function addQuestion(
  sessionId: string,
  input: AddEntityInput,
  options: ArchiveMutationOptions = {},
): Promise<ArchiveSnapshot> {
  const body = await mutateArchive(sessionId, (draft) => {
    const id = nextId('question', draft.meta.counters);
    draft.entities.push(buildEntity(id, 'question', input, parseEntityRefs(input.refs), 'open', freshTimestamp()));
    draft.meta.updatedAt = freshTimestamp();
    return draft;
  }, { dir: options.dir });
  const snapshot = toSnapshot(sessionId, body);
  broadcastArchive(snapshot, options.broadcastFn);
  return snapshot;
}

export interface CorrectInput {
  id: string;
  by: CorrectionBy;
  reason: string;
  /** 纠正的同时把状态翻到指定值（缺省按 CORRECTED_STATUS 表）。 */
  statusOverride?: string;
}

/**
 * 纠正（一等操作，append-only）：
 *   - 目标实体状态翻转（缺省按类型表）；人纠正（by=human）后打
 *     humanCorrected——模型再纠正被拒（权威序：人 > 专家 > 模型）；
 *   - 追加 R#n 纠正条目；引用该实体的下游打 needsReview（不连坐）。
 */
export async function correctEntity(
  sessionId: string,
  input: CorrectInput,
  options: ArchiveMutationOptions = {},
): Promise<ArchiveSnapshot> {
  const reason = input.reason.trim();
  if (!reason) throw new Error('纠正必须带 reason（错在哪、为什么）');
  const body = await mutateArchive(sessionId, (draft) => {
    const target = draft.entities.find((e) => e.id === input.id);
    if (!target) throw new Error(`实体 ${input.id} 不存在（无法纠正）`);
    if (input.by === 'model' && target.humanCorrected) {
      throw new Error(`实体 ${input.id} 已被人纠正过——人纠正的实体模型不得再纠正`);
    }
    const now = freshTimestamp();
    target.status = input.statusOverride ?? CORRECTED_STATUS[target.kind] ?? target.status;
    target.updatedAt = now;
    if (input.by === 'human') target.humanCorrected = true;
    // 人纠正 = 终局：清掉遗留的待复核标记（人对结果负责，不再等复核）。
    if (input.by === 'human') {
      target.needsReview = false;
      delete target.reviewReason;
    }
    markDependentsForReview(draft.entities, target.id, reason);
    const rid = nextCorrectionId(draft.meta.counters);
    draft.corrections.push({ id: rid, targetId: target.id, by: input.by, reason, createdAt: now });
    draft.meta.updatedAt = now;
    return draft;
  }, { dir: options.dir });
  const snapshot = toSnapshot(sessionId, body);
  broadcastArchive(snapshot, options.broadcastFn);
  return snapshot;
}

/** 模型证伪自己的假设（falsify 的专门入口，by=model 的纠正别名）。 */
export async function falsifyHypothesis(
  sessionId: string,
  id: string,
  reason: string,
  options: ArchiveMutationOptions = {},
): Promise<ArchiveSnapshot> {
  return correctEntity(sessionId, { id, by: 'model', reason }, options);
}

export interface ResolveInput {
  id: string;
  note?: string;
}

/** 未决问题 → resolved（问题的推进是研究进展，不是纠正）。 */
export async function resolveQuestion(
  sessionId: string,
  input: ResolveInput,
  options: ArchiveMutationOptions = {},
): Promise<ArchiveSnapshot> {
  const body = await mutateArchive(sessionId, (draft) => {
    const target = draft.entities.find((e) => e.id === input.id && e.kind === 'question');
    if (!target) throw new Error(`未决问题 ${input.id} 不存在（无法解决）`);
    const now = freshTimestamp();
    target.status = 'resolved';
    target.updatedAt = now;
    if (input.note?.trim()) target.links = [...target.links, `note:${input.note.trim().slice(0, 200)}`];
    draft.meta.updatedAt = now;
    return draft;
  }, { dir: options.dir });
  const snapshot = toSnapshot(sessionId, body);
  broadcastArchive(snapshot, options.broadcastFn);
  return snapshot;
}

// ---------------------------------------------------------------------------
// 投影 — 注入段（每轮注回模型，紧凑、硬顶）
// ---------------------------------------------------------------------------

/** 注入段硬字符上限（实时状态只给「知道在哪」，不给全文——全文在档案里）。 */
export const ARCHIVE_INJECT_MAX_CHARS = 1600;

const INJECT_TRUNCATION_MARKER = '…（档案超出注入预算，已截断——完整档案在 GUI 研究面板）';

function oneLineText(t: string, max: number): string {
  const s = t.trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 紧凑实时状态段：待答问题 / 当前假设 / 最新证据 / 已确立结论 / 待复核。
 * 每分组限量 + 整段硬顶；空档案 → ''（零注入语义）。模型基于它继续，
 * 不从历史脑补状态。
 */
export function renderArchiveForInjection(snapshot: ArchiveSnapshot | undefined, maxChars = ARCHIVE_INJECT_MAX_CHARS): string {
  if (!snapshot || snapshot.entities.length === 0) return '';
  const byKind = <T extends ArchiveEntity>(kind: ArchiveEntityKind): T[] =>
    snapshot.entities.filter((e) => e.kind === kind) as T[];
  const open = byKind('question').filter((e) => e.status === 'open').slice(0, 4);
  const pendingHyp = byKind<ArchiveEntity>('hypothesis').filter((e) => e.status === 'pending').slice(0, 4);
  const recentEvidence = byKind<ArchiveEntity>('evidence').slice(-3).reverse();
  const findings = byKind<ArchiveEntity>('finding').filter((e) => e.status !== 'corrected').slice(-3).reverse();
  const needsReview = snapshot.entities.filter((e) => e.needsReview).slice(0, 4);

  const lines: string[] = [];
  const group = (title: string, items: ArchiveEntity[]): void => {
    if (items.length === 0) return;
    lines.push(`${title}：`);
    for (const e of items) {
      const refs = e.links.filter((l) => /^[HVCQ]#\d+$/.test(l));
      lines.push(`  ${e.id} ${oneLineText(e.text, 90)}${refs.length > 0 ? `（${refs.join(' ')}）` : ''}`);
    }
  };
  group('待答问题', open);
  group('当前假设', pendingHyp);
  group('最新证据', recentEvidence);
  group('已确立结论', findings);
  group('待复核', needsReview);

  const header = '<zhishi-research-archive>\n研究档案（本会话显式研究状态，随研究持续更新）——你每轮基于它继续，不要从历史脑补；有进展/证伪/新结论时用 research_archive 工具更新它：';
  const footer = '</zhishi-research-archive>';
  let body = `${header}\n${lines.join('\n')}\n${footer}`;
  if (body.length > maxChars) {
    // 整行让位直到放得下「截断标记 + 收尾标签」，丢弃显式声明（不静默）。
    const budget = maxChars - INJECT_TRUNCATION_MARKER.length - footer.length - 2;
    let trimmed = header;
    for (const line of lines) {
      const next = `${trimmed}\n${line}`;
      if (next.length > budget) break;
      trimmed = next;
    }
    body = `${trimmed}\n${INJECT_TRUNCATION_MARKER}\n${footer}`;
  }
  return body;
}

// ---------------------------------------------------------------------------
// 投影 — 报告（交付投影：成果章节带证据锚、过程章节含证伪）
// ---------------------------------------------------------------------------

/**
 * 报告侧 markdown 渲染（成果报告从档案派生——「报告不是另写的文案，
 * 是举证档案的投影」）。空档案 → ''（报告里不出现空章节）。
 */
export function renderArchiveForReport(snapshot: ArchiveSnapshot | undefined): string {
  if (!snapshot || snapshot.entities.length === 0) return '';
  const parts: string[] = [];

  const findings = snapshot.entities.filter((e) => e.kind === 'finding');
  if (findings.length > 0) {
    const lines = findings.map((e) => {
      const refs = e.links.filter((l) => /^V#\d+$/.test(l));
      const statusMark = e.status === 'corrected' ? '（已纠正）' : e.needsReview ? '（待复核）' : '';
      const type = e.findingType ? `[${e.findingType}] ` : '';
      return `- ${e.id} ${type}${oneLineText(e.text, 300)}${refs.length > 0 ? ` —— 证据：${refs.join('、')}` : ''}${statusMark}`;
    });
    parts.push(`## 研究结论\n\n${lines.join('\n')}`);
  }

  const falsified = snapshot.entities.filter((e) => e.kind === 'hypothesis' && e.status === 'falsified');
  const otherCorrected = snapshot.entities.filter(
    (e) => e.kind !== 'hypothesis' && ['overturned', 'corrected'].includes(e.status),
  );
  if (falsified.length > 0 || otherCorrected.length > 0 || snapshot.corrections.length > 0) {
    const lines: string[] = [];
    for (const e of [...falsified, ...otherCorrected]) {
      const corr = snapshot.corrections.filter((c) => c.targetId === e.id).at(-1);
      const by = corr ? (corr.by === 'human' ? '人纠正' : '模型自证伪') : '状态已翻转';
      lines.push(`- ${e.id} ${oneLineText(e.text, 200)} —— ${by}${corr ? `：${oneLineText(corr.reason, 200)}` : ''}`);
    }
    parts.push(`## 证伪与纠正\n\n${lines.join('\n')}`);
  }

  const openQuestions = snapshot.entities.filter((e) => e.kind === 'question' && e.status === 'open');
  if (openQuestions.length > 0) {
    parts.push(`## 未决问题\n\n${openQuestions.map((e) => `- ${e.id} ${oneLineText(e.text, 200)}`).join('\n')}`);
  }

  const evidence = snapshot.entities.filter((e) => e.kind === 'evidence');
  if (evidence.length > 0) {
    parts.push(`## 证据清单\n\n${evidence.map((e) => `- ${e.id} ${oneLineText(e.text, 200)}`).join('\n')}`);
  }

  return parts.join('\n\n');
}
