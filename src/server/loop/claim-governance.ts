/**
 * 1.7.2 — 会话 Claim 治理管线（design: 1.7.2-compaction.md §7.2；
 * 蓝本：HL-Mem 写管线 + 2025 综述 Dynamics 框架）。
 *
 * Event 层（jsonl,不可变）→ LLM 提取 → 准入（纯校验）→ 去重（内容指纹）
 * → 冲突收敛（conflict_key 确定性合并）→ 落库（archive 实体 / research
 * 事件 / session-claims）→ 推进治理游标（claimsCursor）→ 审计记录。
 *
 * 管线全程幂等：游标只前进、失败不推进（下一轮从同窗口重试）；提取模型
 * 可注入（测试 fake；生产用 resolveLoopModel 的默认模型 + runLoopText）。
 * 调度：Rust TaskScheduler 定时任务（蒸馏弧同款 /cron/execute-sync 入口）。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  loadLoopSession,
  markLoopSessionClaimsCursor,
} from './session';
import {
  addEvidence,
  addFinding,
  addHypothesis,
  addQuestion,
  loadArchive,
  type ArchiveEntityKind,
  type FindingType,
} from './archive';
import {
  CLAIM_ARCHIVE_SALIENCE,
  claimContentHash,
  decaySalience,
  loadSessionClaims,
  mergeClaim,
  saveSessionClaims,
  type ClaimAuditEntry,
  type SessionClaim,
  type SessionClaimKind,
} from './session-claims';
import {
  recordResearchEvent,
  listResearchEvents,
} from '../memory/store';
import { isResearchBugClass, isResearchOutcome, isResearchTaskKind } from '../../shared/research-kinds';
import { messageText } from './context-manager';
import { resolveLoopModel } from './pi-provider';
import { runLoopText } from './loop';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 单次治理窗口（新消息条数上限）。 */
export const GOVERNANCE_WINDOW = 8;
/** 治理任务调度间隔（分钟;Rust TaskScheduler cron 同值）。 */
export const GOVERNANCE_INTERVAL_MINUTES = 30;
/** 提取模型的温度纪律:结构化提取用低温度(pi 侧 reasoning 关闭)。 */
export const GOVERNANCE_EXTRACT_MAX_CHARS = 24_000;

// ---------------------------------------------------------------------------
// 提取
// ---------------------------------------------------------------------------

export interface ExtractArchiveEntity {
  kind: ArchiveEntityKind;
  text: string;
  refs?: string[];
  findingType?: FindingType;
  /** 1.7.2 M4:事实有效时间窗（LLM 只在片段明确表达时填写）。 */
  validFrom?: string;
  validTo?: string;
}
export interface ExtractResearchEvent {
  taskKind: string;
  outcome: string;
  bugClass?: string;
  summary: string;
}
export interface ExtractClaim {
  kind: SessionClaimKind;
  text: string;
  subject?: string;
  searchTerms?: string[];
  salience?: number;
  validFrom?: string;
  validTo?: string;
}
export interface ExtractionOutput {
  archiveEntities: ExtractArchiveEntity[];
  researchEvents: ExtractResearchEvent[];
  claims: ExtractClaim[];
}
export type ExtractionResult = { ok: true; output: ExtractionOutput } | { ok: false; error: string };

export type Extractor = (messages: AgentMessage[]) => Promise<ExtractionResult>;

const EXTRACTION_SYSTEM_PROMPT = [
  '你是研究会话的记忆治理器（Event → Claim 提取）。从给定会话片段中提取结构化记忆,',
  '严格输出一个 JSON 对象（不要输出其他文字）:',
  '{',
  '  "archiveEntities": [{"kind":"hypothesis|evidence|finding|question","text":"一句话断言","refs":["H#1","V#2"],"findingType":"..."}],',
  '  "researchEvents": [{"taskKind":"binary|pentest|ai-security|redteam|malware|whitebox|intel|fuzz|ctf","outcome":"success|fail|stuck","bugClass":"...","summary":"一句话结论"}],',
  '  "claims": [{"kind":"fact|decision|dead-end|todo","text":"一句话事实","subject":"主题词","searchTerms":["检索词1"],"salience":0.8,"validFrom":"ISO时间或null","validTo":"ISO时间或null"}]',
  '}',
  '纪律:',
  '1. text 是一句话断言,不含过程细节(证据行区间由程序补,不用填);',
  '2. 只提取片段中实际出现的结论;不确定的不写;',
  '3. 关键研究产出(拿到 flag、确认根因、崩溃复现、卡住)必须进 researchEvents;',
  '4. salience 0-1:核心事实/决策 0.7-0.9,环境琐事 0.3-0.5;',
  '5. validFrom/validTo 只在片段明确表达事实时间窗时填写;',
  '6. 用户指令里的长期要求(如「以后都用 X 方法」「记得先做 Y」)提取为 todo 类 claim,subject 取主题词;',
  '7. 找不到 archiveEntities/researchEvents/claims 任一类别时,该键给空数组。',
].join('\n');

/** 生产提取器:默认模型 + runLoopText;解析失败 → error(不推进游标)。 */
export function buildProductionExtractor(): Extractor {
  return async (messages) => {
    const resolution = resolveLoopModel();
    if (!resolution) return { ok: false, error: '模型不可用(无 provider/key)' };
    const transcript = messages
      .map((m, i) => `[${i}] ${m.role}: ${messageText(m).slice(0, 3000)}`)
      .join('\n');
    const prompt = `会话片段(消息下标起 ${messages.length} 条):\n${transcript}`;
    const r = await runLoopText({
      prompt,
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      model: resolution.model,
      models: resolution.models,
      getApiKey: resolution.getApiKey,
      tools: [],
      maxTokens: GOVERNANCE_EXTRACT_MAX_CHARS,
    });
    if (r.error !== undefined || !r.text) {
      return { ok: false, error: r.error ?? '提取输出为空' };
    }
    return parseExtractionJson(r.text);
  };
}

/** JSON 提取（去 code fence + 首尾平衡截取——提取物脏输入容错）。 */
export function parseExtractionJson(text: string): ExtractionResult {
  let raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf('{');
  if (start < 0) return { ok: false, error: '提取输出无 JSON 对象' };
  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) return { ok: false, error: 'JSON 括号不平衡' };
  try {
    const parsed = JSON.parse(raw.slice(start, end)) as Partial<ExtractionOutput>;
    return {
      ok: true,
      output: {
        archiveEntities: Array.isArray(parsed.archiveEntities) ? parsed.archiveEntities : [],
        researchEvents: Array.isArray(parsed.researchEvents) ? parsed.researchEvents : [],
        claims: Array.isArray(parsed.claims) ? parsed.claims : [],
      },
    };
  } catch (err) {
    return { ok: false, error: `JSON 解析失败:${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// 准入（AdmissionPolicy 纯校验）
// ---------------------------------------------------------------------------

export interface AdmittedExtraction {
  archiveEntities: ExtractArchiveEntity[];
  researchEvents: ExtractResearchEvent[];
  claims: ExtractClaim[];
}

const ARCHIVE_KINDS = new Set(['hypothesis', 'evidence', 'finding', 'question']);
const CLAIM_KINDS = new Set(['fact', 'decision', 'dead-end', 'todo']);
const FINDING_TYPES = new Set(['bug_class', 'primitive', 'constraint', 'fact']);

/** 纯校验:枚举/非空/salience 范围/时间格式——不通过静默丢弃(不计审计错误)。 */
export function admitExtraction(input: ExtractionOutput): AdmittedExtraction {
  const archiveEntities = input.archiveEntities
    .filter((e) =>
      ARCHIVE_KINDS.has(e.kind) && typeof e.text === 'string' && e.text.trim().length > 0)
    .map((e) => ({
      ...e,
      // 运行时枚举兜底:非法 findingType 剥离(只对 finding 有意义)。
      ...(e.kind === 'finding' && e.findingType !== undefined && !FINDING_TYPES.has(e.findingType)
        ? { findingType: undefined }
        : {}),
    }));
  const researchEvents = input.researchEvents.filter((e) =>
    isResearchTaskKind(e.taskKind) && isResearchOutcome(e.outcome)
    && typeof e.summary === 'string' && e.summary.trim().length > 0
    && (e.bugClass === undefined || isResearchBugClass(e.bugClass)));
  const claims = input.claims.filter((c) =>
    CLAIM_KINDS.has(c.kind) && typeof c.text === 'string' && c.text.trim().length > 0
    && (c.salience === undefined || (typeof c.salience === 'number' && c.salience >= 0 && c.salience <= 1)));
  return { archiveEntities, researchEvents, claims };
}

// ---------------------------------------------------------------------------
// 治理管线
// ---------------------------------------------------------------------------

export interface GovernanceOptions {
  /** 提取器（测试注入 fake;生产 buildProductionExtractor）。 */
  extract: Extractor;
  /** loop-sessions 目录（测试注入临时目录）。 */
  dir?: string;
  /** research 事件落库的 workspace。 */
  workspace: string;
  /** 时间注入（测试）。 */
  now?: () => number;
}

export interface GovernanceResult {
  ok: boolean;
  cursorFrom: number;
  cursorTo: number;
  extracted: number;
  admitted: number;
  deduped: number;
  superseded: number;
  archived: number;
  error?: string;
}

/** 窗口消息 → 证据行区间（jsonl 行,同 recall 口径;整窗粗粒度 v1）。 */
function windowLineRange(cursorFrom: number, windowLen: number): { start: number; end: number } {
  return { start: cursorFrom + 2, end: cursorFrom + windowLen + 1 };
}

export async function runClaimGovernance(
  sessionId: string,
  options: GovernanceOptions,
): Promise<GovernanceResult> {
  const now = options.now ?? Date.now;
  const base = {
    ok: false as boolean,
    cursorFrom: 0,
    cursorTo: 0,
    extracted: 0,
    admitted: 0,
    deduped: 0,
    superseded: 0,
    archived: 0,
  };
  try {
    const session = loadLoopSession(sessionId, options.dir ? { dir: options.dir } : undefined);
    const cursorFrom = session.meta?.claimsCursor ?? 0;
    const window = session.messages.slice(cursorFrom, cursorFrom + GOVERNANCE_WINDOW);
    if (window.length === 0) return { ...base, ok: true, cursorFrom, cursorTo: cursorFrom };

    const extracted = await options.extract(window);
    if (!extracted.ok) {
      // 提取失败不推进游标（下一轮同窗口重试）——审计留痕。
      await appendAudit(sessionId, options, {
        at: new Date(now()).toISOString(),
        cursorFrom,
        cursorTo: cursorFrom,
        extracted: 0, admitted: 0, deduped: 0, superseded: 0, archived: 0,
        error: extracted.error,
      });
      return { ...base, ok: false, cursorFrom, cursorTo: cursorFrom, error: extracted.error };
    }
    const admitted = admitExtraction(extracted.output);
    const range = windowLineRange(cursorFrom, window.length);
    const timestamp = new Date(now()).toISOString();

    // ---- claims：衰减 → 去重 → 冲突收敛 → 合并 ----
    const file = loadSessionClaims(sessionId, options.dir ? { dir: options.dir } : undefined);
    let deduped = 0;
    let supersededCount = 0;
    let archived = 0;
    // 衰减不碰 lastTouchedAt——触点只由 M6 检索注入更新（否则每 30 分钟
    // 的治理扫描会反复给触点续命,半衰期衰减被永久冻结）。
    let claims = file.claims.map((c) => {
      if (c.status !== 'active') return c;
      const decayed = decaySalience(c.salience, c.lastTouchedAt, now());
      if (decayed < CLAIM_ARCHIVE_SALIENCE) {
        archived++;
        return { ...c, salience: decayed, status: 'archived' as const, updatedAt: timestamp };
      }
      return { ...c, salience: decayed };
    });
    let seq = file.meta.nextSeq;
    for (const c of admitted.claims) {
      const text = c.text.trim();
      const hash = claimContentHash(c.kind, text);
      const dup = claims.some((e) => e.status === 'active' && claimContentHash(e.kind, e.text) === hash);
      if (dup) { deduped++; continue; }
      const claim: SessionClaim = {
        id: `S#${seq++}`,
        kind: c.kind,
        text,
        ...(c.subject?.trim() ? { subject: c.subject.trim() } : {}),
        searchTerms: (c.searchTerms ?? []).filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim()).slice(0, 8),
        lineStart: range.start,
        lineEnd: range.end,
        salience: typeof c.salience === 'number' ? c.salience : 0.5,
        ...(c.validFrom ? { validFrom: c.validFrom } : {}),
        ...(c.validTo ? { validTo: c.validTo } : {}),
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
        lastTouchedAt: timestamp,
      };
      const merged = mergeClaim(claims, claim);
      claims = merged.claims;
      supersededCount += merged.superseded.length;
    }

    // ---- archive 实体：去重（同 kind 同 text）→ 落库 ----
    const archive = loadArchive(sessionId, options.dir ? { dir: options.dir } : undefined);
    const existingTexts = new Set(archive.entities.map((e) => `${e.kind}:${e.text.trim()}`));
    for (const e of admitted.archiveEntities) {
      const key = `${e.kind}:${e.text.trim()}`;
      if (existingTexts.has(key)) { deduped++; continue; }
      existingTexts.add(key);
      const input = {
        text: e.text.trim(),
        ...(e.refs && e.refs.length > 0 ? { refs: e.refs.join(',') } : {}),
        ...(e.findingType ? { findingType: e.findingType } : {}),
        ...(e.validFrom ? { validFrom: e.validFrom } : {}),
        ...(e.validTo ? { validTo: e.validTo } : {}),
      };
      if (e.kind === 'hypothesis') await addHypothesis(sessionId, input, options.dir ? { dir: options.dir } : {});
      else if (e.kind === 'evidence') await addEvidence(sessionId, input, options.dir ? { dir: options.dir } : {});
      else if (e.kind === 'finding') await addFinding(sessionId, input, options.dir ? { dir: options.dir } : {});
      else await addQuestion(sessionId, input, options.dir ? { dir: options.dir } : {});
    }

    // ---- research 事件：窗口内去重 → 落库 ----
    const recentSummaries = new Set(
      listResearchEvents({ limit: 200, workspace: options.workspace }).map((e) => e.summary.trim()),
    );
    for (const ev of admitted.researchEvents) {
      if (recentSummaries.has(ev.summary.trim())) { deduped++; continue; }
      recentSummaries.add(ev.summary.trim());
      recordResearchEvent({
        workspace: options.workspace,
        taskKind: ev.taskKind as never,
        outcome: ev.outcome as never,
        summary: ev.summary.trim(),
        ...(ev.bugClass ? { bugClass: ev.bugClass as never } : {}),
      });
    }

    // ---- 落库 claims 文件（含审计）+ 推进游标 ----
    const admittedCount = admitted.claims.length + admitted.archiveEntities.length + admitted.researchEvents.length;
    const audit: ClaimAuditEntry = {
      at: timestamp,
      cursorFrom,
      cursorTo: cursorFrom + window.length,
      extracted: extracted.output.claims.length + extracted.output.archiveEntities.length + extracted.output.researchEvents.length,
      admitted: admittedCount,
      deduped,
      superseded: supersededCount,
      archived,
    };
    const body = {
      meta: { nextSeq: seq, updatedAt: timestamp },
      claims,
      audits: [...file.audits, audit].slice(-200), // 审计行数上限
    };
    await saveSessionClaims(sessionId, body, options.dir ? { dir: options.dir } : undefined);
    await markLoopSessionClaimsCursor(sessionId, cursorFrom + window.length, options.dir ? { dir: options.dir } : undefined);
    // 1.7.2 M7:游标推进后收割侧车 GC——已被治理覆盖的条目原文移除(Claim 层已承载)。
    try {
      const { gcHarvestEntries } = await import('./harvest');
      const removed = await gcHarvestEntries(sessionId, cursorFrom + window.length + 1, options.dir ? { dir: options.dir } : undefined);
      if (removed > 0) console.log(`[governance] ${sessionId} harvest GC removed ${removed}`);
    } catch (err) {
      console.warn(`[governance] ${sessionId} harvest GC 失败(非致命):${err instanceof Error ? err.message : String(err)}`);
    }

    console.log(
      `[governance] ${sessionId} cursor ${cursorFrom}→${cursorFrom + window.length} ` +
      `extracted=${audit.extracted} admitted=${admittedCount} deduped=${deduped} superseded=${supersededCount} archived=${archived}`,
    );
    return {
      ok: true,
      cursorFrom,
      cursorTo: cursorFrom + window.length,
      extracted: audit.extracted,
      admitted: admittedCount,
      deduped,
      superseded: supersededCount,
      archived,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[governance] ${sessionId} 管线异常(游标不推进):${message}`);
    return { ...base, ok: false, error: message };
  }
}

async function appendAudit(
  sessionId: string,
  options: GovernanceOptions,
  audit: ClaimAuditEntry,
): Promise<void> {
  try {
    const file = loadSessionClaims(sessionId, options.dir ? { dir: options.dir } : undefined);
    await saveSessionClaims(sessionId, {
      ...file,
      audits: [...file.audits, audit].slice(-200),
    }, options.dir ? { dir: options.dir } : undefined);
  } catch {
    /* 审计失败不阻断治理 */
  }
}
