/**
 * 1.7.2 — session-claims：会话级 Claim 快照（design: 1.7.2-compaction.md §7.2）。
 *
 * 定位（HL-Mem 的 Claim 层会话投影）：异步治理管线从 Event 层（jsonl）提取的
 * 结构化事实/决策/死路/待办——工作记忆的「Event 索引」数据源与 M6 自动检索的
 * 命中源。research_events 表无会话键（只有 workspace），本文件是会话级索引。
 *
 * 文件：loop-sessions/<id>.claims.json（与 archive/harvest 同目录同纪律：
 * 锁内读-改-写 + tmp+rename）。条目带双时间（M4）、salience（M5 衰减/归档）、
 * searchTerms（M6 检索词）。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getZhiShiDataDir } from '../utils/app-dirs';
import { withFileLock, writeFileAtomic } from '../utils/file-lock';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionClaimKind = 'fact' | 'decision' | 'dead-end' | 'todo';
export type SessionClaimStatus = 'active' | 'superseded' | 'archived';

export interface SessionClaim {
  id: string;
  kind: SessionClaimKind;
  /** 一句话断言（Claim 行要短；证据在行区间里）。 */
  text: string;
  /** 冲突键第二维（同 kind + 同 subject 视为同一事实的演化）。 */
  subject?: string;
  /** M6 检索词（LLM 提取时产出——避开中文分词,程序按词命中）。 */
  searchTerms: string[];
  /** 证据行区间（jsonl 行,同 recall 口径;无 → 未挂证据）。 */
  lineStart?: number;
  lineEnd?: number;
  /** M5 显著性 0-1（LLM 初评,治理时按半衰期衰减）。 */
  salience: number;
  /** M4 双时间:事实有效时间窗（可空 = 未知/无限）。 */
  validFrom?: string;
  validTo?: string;
  status: SessionClaimStatus;
  /** 被本条目取代的旧条目 id（conflict 收敛记录）。 */
  supersedes?: string;
  createdAt: string;
  updatedAt: string;
  lastTouchedAt: string;
}

export interface ClaimAuditEntry {
  at: string;
  cursorFrom: number;
  cursorTo: number;
  extracted: number;
  admitted: number;
  deduped: number;
  superseded: number;
  archived: number;
  error?: string;
}

export interface SessionClaimsFile {
  meta: { nextSeq: number; updatedAt: string };
  claims: SessionClaim[];
  audits: ClaimAuditEntry[];
}

export interface SessionClaimsStoreOptions {
  dir?: string;
}

export const SESSION_CLAIM_KINDS: ReadonlyArray<SessionClaimKind> = ['fact', 'decision', 'dead-end', 'todo'];
export const SESSION_CLAIM_STATUSES: ReadonlyArray<SessionClaimStatus> = ['active', 'superseded', 'archived'];

/** M5:显著性半衰期（ms）。 */
export const CLAIM_SALIENCE_HALF_LIFE_MS = 30 * 24 * 3600_000;
/** M5:归档阈值（衰减后低于此值移出工作记忆注入面）。 */
export const CLAIM_ARCHIVE_SALIENCE = 0.15;

// ---------------------------------------------------------------------------
// 文件编解码
// ---------------------------------------------------------------------------

export function claimsFile(sessionId: string, dir: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '');
  return join(dir, `${safe}.claims.json`);
}

function claimsDir(options?: SessionClaimsStoreOptions): string {
  return options?.dir ?? join(getZhiShiDataDir(), 'loop-sessions');
}

export function emptyClaimsFile(): SessionClaimsFile {
  return { meta: { nextSeq: 1, updatedAt: '' }, claims: [], audits: [] };
}

function parseBody(raw: string): SessionClaimsFile | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SessionClaimsFile>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      meta: {
        nextSeq: typeof parsed.meta?.nextSeq === 'number' ? parsed.meta.nextSeq : 1,
        updatedAt: typeof parsed.meta?.updatedAt === 'string' ? parsed.meta.updatedAt : '',
      },
      claims: Array.isArray(parsed.claims) ? (parsed.claims as SessionClaim[]) : [],
      audits: Array.isArray(parsed.audits) ? (parsed.audits as ClaimAuditEntry[]) : [],
    };
  } catch {
    return null;
  }
}

/** 读（缺失/损坏 → 空文件——读侧容错,治理不因文件故障阻塞）。 */
export function loadSessionClaims(sessionId: string, options?: SessionClaimsStoreOptions): SessionClaimsFile {
  const file = claimsFile(sessionId, claimsDir(options));
  if (!existsSync(file)) return emptyClaimsFile();
  try {
    return parseBody(readFileSync(file, 'utf-8')) ?? emptyClaimsFile();
  } catch {
    return emptyClaimsFile();
  }
}

function serializeBody(body: SessionClaimsFile): string {
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** 写（锁内读-改-写 + tmp+rename——与 archive/harvest 同纪律）。 */
export async function saveSessionClaims(
  sessionId: string,
  body: SessionClaimsFile,
  options?: SessionClaimsStoreOptions,
): Promise<void> {
  const dir = claimsDir(options);
  mkdirSync(dir, { recursive: true });
  const file = claimsFile(sessionId, dir);
  await withFileLock({ lockPath: `${file}.lock` }, async () => {
    writeFileAtomic(file, serializeBody(body));
  });
}

// ---------------------------------------------------------------------------
// 纯函数 — 去重 / 冲突 / 衰减（治理管线的确定性段）
// ---------------------------------------------------------------------------

/** 内容指纹（去重口径：kind + text 归一）。 */
export function claimContentHash(kind: SessionClaimKind, text: string): string {
  return `${kind}:${text.trim()}`;
}

/** 冲突键：同 kind + 同 subject（无 subject 的条目不参与冲突收敛）。 */
export function claimConflictKey(c: Pick<SessionClaim, 'kind' | 'subject'>): string | null {
  return c.subject?.trim() ? `${c.kind}:${c.subject.trim()}` : null;
}

/**
 * M5 显著性衰减：半衰期 30 天（幂衰减——高显著性条目衰减慢,低显著性快速
 * 逼近归档阈值）。纯函数,注入 now 供测试。
 */
export function decaySalience(salience: number, lastTouchedAt: string, now: number): number {
  const t = Date.parse(lastTouchedAt);
  if (!Number.isFinite(t) || t >= now) return salience;
  const elapsed = now - t;
  return salience * Math.pow(0.5, elapsed / CLAIM_SALIENCE_HALF_LIFE_MS);
}

/**
 * 冲突收敛（确定性合并 v1）：同 conflictKey 的新条目取代旧条目——
 * 旧条目 status → superseded,新条目记 supersedes。返回更新后的 claims 数组
 * 与被取代的旧条目列表（供审计）。
 */
export function mergeClaim(
  claims: SessionClaim[],
  incoming: SessionClaim,
): { claims: SessionClaim[]; superseded: SessionClaim[] } {
  const key = claimConflictKey(incoming);
  if (!key) return { claims: [...claims, incoming], superseded: [] };
  const hits = claims.filter((c) => claimConflictKey(c) === key && c.status === 'active');
  if (hits.length === 0) return { claims: [...claims, incoming], superseded: [] };
  const now = incoming.updatedAt;
  const next = claims.map((c) => {
    if (claimConflictKey(c) !== key || c.status !== 'active') return c;
    return { ...c, status: 'superseded' as const, updatedAt: now };
  });
  next.push({ ...incoming, supersedes: hits.map((h) => h.id).join(',') });
  return { claims: next, superseded: hits };
}

/** 已过有效期的条目判定（M4:validTo < now → 事实已失效,投影侧标过期）。 */
export function isClaimExpired(c: SessionClaim, now: number): boolean {
  if (!c.validTo) return false;
  const t = Date.parse(c.validTo);
  return Number.isFinite(t) && t < now;
}

/** M5 遗忘（人侧入口 `zhishi claim forget`）：条目置 archived + 审计行保留。 */
export async function forgetClaim(
  sessionId: string,
  claimId: string,
  options?: SessionClaimsStoreOptions,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const file = loadSessionClaims(sessionId, options);
    const target = file.claims.find((c) => c.id === claimId);
    if (!target) return { ok: false, error: `claim ${claimId} 不存在（会话 ${sessionId}）` };
    if (target.status === 'archived') return { ok: true };
    const now = new Date().toISOString();
    await saveSessionClaims(sessionId, {
      meta: { ...file.meta, updatedAt: now },
      claims: file.claims.map((c) => c.id === claimId
        ? { ...c, status: 'archived' as const, updatedAt: now }
        : c),
      audits: [
        ...file.audits,
        { at: now, cursorFrom: -1, cursorTo: -1, extracted: 0, admitted: 0, deduped: 0, superseded: 0, archived: 1 },
      ],
    }, options);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * M5 触点刷新（M6 检索注入的写回面）：被注入工作记忆的条目刷新
 * lastTouchedAt——半衰期衰减从「最近一次被使用」计时,治理扫描不续命。
 * best-effort（失败静默,只影响衰减速率不影响正确性）。
 */
export async function touchClaims(
  sessionId: string,
  claimIds: string[],
  options?: SessionClaimsStoreOptions,
): Promise<void> {
  if (claimIds.length === 0) return;
  try {
    const file = loadSessionClaims(sessionId, options);
    const ids = new Set(claimIds);
    if (!file.claims.some((c) => ids.has(c.id))) return;
    const now = new Date().toISOString();
    await saveSessionClaims(sessionId, {
      meta: { ...file.meta, updatedAt: now },
      claims: file.claims.map((c) => ids.has(c.id) ? { ...c, lastTouchedAt: now } : c),
      audits: file.audits,
    }, options);
  } catch {
    /* 触点刷新失败静默——只影响衰减速率 */
  }
}
