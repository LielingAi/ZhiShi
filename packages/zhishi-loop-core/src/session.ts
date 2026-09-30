/**
 * M2(D26)— loop 会话持久化/恢复。
 *
 * 存储:`~/.zhishi/loop-sessions/<sessionId>.jsonl`,一行一条 JSON:
 *   - 首行元数据:{ kind:'meta', model?, providerId?, createdAt, updatedAt }
 *   - 其余每行一条 pi AgentMessage(user/assistant/toolResult)
 *   - 或一条文件级记录:{ kind:'system-prompt', hash, content, at }
 *     (轨迹完整性:模型当轮实际看到的系统提示,hash 去重;不是消息,
 *     不进 messages——runLoop 永远看不到,老读者按未知行容错跳过)
 *
 * 持久化前归一化({@link normalizeMessagesForPersist}):pi 的自定义消息
 * 类型(如 BashExecutionMessage)不落盘——与 M1 convertToLlm 的过滤同
 * 一集合,保证 load 出的 messages 直接可作 runLoop 输入。
 *
 * 写路径:整文件读-改-写 + tmp+rename 原子替换,全程 withFileLock
 * (src/server/utils/file-lock.ts,与 SessionStore 同一惯例)。锁内先读
 * 最新内容再全量写回,多进程追加被串行化,无丢更新。坏行容错:单条
 * 损坏行跳过,不炸整会话。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { getZhiShiDataDir } from './paths.js';
import { withFileLock, writeFileAtomic } from './file-lock.js';

// 1.7.2：截断标记自 compaction.ts 迁入（旧段级压缩已退役删除,持久化剥离
// 仍需要认旧形态——1.5.3 及更早的 jsonl 里可能存在两类标记）。
/** 新形态（持久化剥离时两类都认）。 */
export const TRUNCATION_MARKER_CURRENT = '\n⟦系统注记：以下内容已省略，勿复现⟧';
/** 旧形态（1.5.3 之前）。 */
export const TRUNCATION_MARKER_LEGACY = '…[已截断]';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoopSessionMeta {
  model?: string;
  providerId?: string;
  createdAt: string;
  updatedAt: string;
  /** M3:最近一次压缩触发时间(只打标记;jsonl 永远保留全量消息)。 */
  compactedAt?: string;
  /** 1.5.3:token 校准系数（真实 API usage ÷ 启发式估算,每轮未压缩时
   *  学习并持久化——压缩过的轮次不学习（锚被污染）;evaluateCompaction
   *  判定值 = 全量启发式 × 本系数）。 */
  tokenCalibration?: number;
  /** 1.7.2:Claim 治理游标——已治理的消息下标（缺省 0 = 尚未治理；
   *  消息 i ↔ jsonl 行 i+2,与 recall 行区间同口径）。 */
  claimsCursor?: number;
}

/**
 * 系统提示记录（轨迹完整性）：`{"kind":"system-prompt",hash,content,at}`。
 * 组装的系统提示按 sha256 去重落盘——轨迹要能回答「模型当轮实际看到了
 * 什么」（提示是动态的：环境/mission/注入记忆/域逐 turn 变）。kind 记录
 * 不是消息：不进 messages（runLoop 永远看不到），老读者按未知行容错跳过。
 */
export interface LoopSessionSystemPromptRecord {
  /** sha256(content)——变化检测键。 */
  hash: string;
  /** 当轮组装的完整系统提示原文。 */
  content: string;
  /** 落盘时间 ISO。 */
  at: string;
  /** 文件内位置：排在它之前的 message 条数（记录与消息的事件序据此还原；
   *  turn 起跑写入时 pos = 当轮 user 消息之前——记录先于本批消息）。 */
  pos: number;
}

export interface LoopSession {
  messages: AgentMessage[];
  meta: LoopSessionMeta | null;
  /** 系统提示记录（文件序；无记录的旧轨迹 = []）。 */
  systemPrompts: LoopSessionSystemPromptRecord[];
}

export interface LoopSessionStoreOptions {
  /** 存储目录(测试注入临时目录;默认 ~/.zhishi/loop-sessions)。 */
  dir?: string;
}

const META_KIND = 'meta';
/** 系统提示记录 kind（文件级记录,不是消息——绕开 VALID_ROLES 过滤）。 */
export const SYSTEM_PROMPT_RECORD_KIND = 'system-prompt';
const VALID_ROLES = new Set(['user', 'assistant', 'toolResult']);

/** 系统提示内容的变化检测键（sha256;引擎快路径与落盘去重同一口径）。 */
export function loopSystemPromptHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Pure — id / line codec / normalization
// ---------------------------------------------------------------------------

/** 时间序前缀 + 随机后缀(可排序、无外部依赖)。 */
export function newLoopSessionId(): string {
  return `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

/** 会话文件名(防路径穿越:id 只留字母数字/下划线/连字符)。 */
export function loopSessionFile(id: string, dir: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '');
  return join(dir, `${safe}.jsonl`);
}

/**
 * 归一化:只保留标准 LLM 消息(user/assistant/toolResult)。pi 自定义
 * 消息类型在此过滤(与 M1 convertToLlm 同一集合),返回新数组。
 *
 * 1.5.3:剥离截断标记（新 ⟦⟧ 与旧 …[已截断] 两种形态）——标记是
 * harness 元数据不是研究内容,落盘后会被下次注入当语料复现（golang
 * 会话雪崩实证:L1393 模型自产标记）。只剥块末尾的标记后缀,
 * 正文原样。
 */
export function normalizeMessagesForPersist(messages: AgentMessage[]): AgentMessage[] {
  return messages
    .filter(
      (m): m is AgentMessage =>
        !!m && typeof m === 'object' && VALID_ROLES.has((m as { role?: string }).role ?? ''),
    )
    .map(stripTruncationMarkers);
}

/** 剥块内的截断标记（text/thinking 字符串与 string content；无标记原样返回）。
 *  全量替换而非只剥末尾:golang 会话实证模型会把标记当语料**复现到正文
 *  中间**(雪崩),只剥末尾断不了环。 */
function stripTruncationMarkers(message: AgentMessage): AgentMessage {
  const strip = (s: string): string =>
    s.split(TRUNCATION_MARKER_CURRENT).join('').split(TRUNCATION_MARKER_LEGACY).join('');
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    const stripped = strip(content);
    return stripped === content ? message : ({ ...message, content: stripped } as AgentMessage);
  }
  if (!Array.isArray(content)) return message;
  let changed = false;
  const blocks = content.map((block) => {
    if (!block || typeof block !== 'object') return block;
    const b = block as Record<string, unknown>;
    if (typeof b.text === 'string') {
      const stripped = strip(b.text);
      if (stripped !== b.text) { changed = true; return { ...b, text: stripped }; }
    }
    if (typeof b.thinking === 'string') {
      const stripped = strip(b.thinking);
      if (stripped !== b.thinking) { changed = true; return { ...b, thinking: stripped }; }
    }
    return block;
  });
  return changed ? ({ ...message, content: blocks } as AgentMessage) : message;
}

/** 解析一行为 meta / message / 系统提示记录;坏行/非法 role/未知 kind → null(容错跳过)。 */
export function parseLoopSessionLine(line: string):
  | { kind: 'meta'; meta: LoopSessionMeta }
  | { kind: 'msg'; message: AgentMessage }
  | { kind: 'system-prompt'; record: Omit<LoopSessionSystemPromptRecord, 'pos'> }
  | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.kind === META_KIND) {
    return {
      kind: 'meta',
      meta: {
        model: typeof rec.model === 'string' ? rec.model : undefined,
        providerId: typeof rec.providerId === 'string' ? rec.providerId : undefined,
        createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : '',
        updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : '',
        compactedAt: typeof rec.compactedAt === 'string' ? rec.compactedAt : undefined,
        tokenCalibration: typeof rec.tokenCalibration === 'number' ? rec.tokenCalibration : undefined,
        claimsCursor: typeof rec.claimsCursor === 'number' ? rec.claimsCursor : undefined,
      },
    };
  }
  // 系统提示记录:additive——老读者走到这里按未知行返回 null 跳过(容错不变)。
  if (rec.kind === SYSTEM_PROMPT_RECORD_KIND) {
    if (typeof rec.hash !== 'string' || typeof rec.content !== 'string') return null;
    return {
      kind: 'system-prompt',
      record: {
        hash: rec.hash,
        content: rec.content,
        at: typeof rec.at === 'string' ? rec.at : '',
      },
    };
  }
  if (VALID_ROLES.has(rec.role as string)) {
    return { kind: 'msg', message: parsed as AgentMessage };
  }
  return null;
}

/** 序列化:meta 首行 + 消息/系统提示记录按 pos 交错(记录排在其 pos
 *  计数的消息之前;无记录时与旧版逐字节一致)。 */
export function serializeLoopSession(
  meta: LoopSessionMeta,
  messages: AgentMessage[],
  systemPrompts: LoopSessionSystemPromptRecord[] = [],
): string {
  const lines = [JSON.stringify({ kind: META_KIND, ...meta })];
  const normalized = normalizeMessagesForPersist(messages);
  const byPos = new Map<number, LoopSessionSystemPromptRecord[]>();
  for (const r of systemPrompts) {
    const pos = Math.max(0, Math.min(r.pos, normalized.length));
    const bucket = byPos.get(pos) ?? [];
    bucket.push(r);
    byPos.set(pos, bucket);
  }
  for (let i = 0; i <= normalized.length; i++) {
    for (const r of byPos.get(i) ?? []) {
      lines.push(JSON.stringify({ kind: SYSTEM_PROMPT_RECORD_KIND, hash: r.hash, content: r.content, at: r.at }));
    }
    if (i < normalized.length) lines.push(JSON.stringify(normalized[i]));
  }
  return lines.join('\n') + '\n';
}

/** 反序列化整文件(坏行/未知行跳过;记录的 pos = 它之前已读出的消息条数)。 */
export function parseLoopSession(content: string): LoopSession {
  const messages: AgentMessage[] = [];
  const systemPrompts: LoopSessionSystemPromptRecord[] = [];
  let meta: LoopSessionMeta | null = null;
  for (const line of content.split('\n')) {
    const parsed = parseLoopSessionLine(line);
    if (!parsed) continue;
    if (parsed.kind === 'meta') meta = parsed.meta;
    else if (parsed.kind === 'system-prompt') systemPrompts.push({ ...parsed.record, pos: messages.length });
    else messages.push(parsed.message);
  }
  return { messages, meta, systemPrompts };
}

// ---------------------------------------------------------------------------
// I/O — load / append(锁 + 原子写)
// ---------------------------------------------------------------------------

/** loop-sessions 默认存储目录(~/.zhishi/loop-sessions,主/子会话同目录)。 */
export function defaultLoopSessionDir(): string {
  return join(getZhiShiDataDir(), 'loop-sessions');
}

function storeDir(options?: LoopSessionStoreOptions): string {
  return options?.dir ?? defaultLoopSessionDir();
}

/** 加载会话;不存在/损坏 → 空会话(messages:[], meta:null)。
 *  1.5.3:读侧同样剥截断标记——旧会话盘上带着事故期烤进去的标记
 *  (含模型复现到正文中间的),不剥会在下次注入时继续喂雪崩语料。 */
export function loadLoopSession(id: string, options?: LoopSessionStoreOptions): LoopSession {
  const file = loopSessionFile(id, storeDir(options));
  if (!existsSync(file)) return { messages: [], meta: null, systemPrompts: [] };
  let content: string;
  try {
    content = readFileSync(file, 'utf-8');
  } catch {
    return { messages: [], meta: null, systemPrompts: [] };
  }
  const parsed = parseLoopSession(content);
  return { messages: parsed.messages.map(stripTruncationMarkers), meta: parsed.meta, systemPrompts: parsed.systemPrompts };
}

/**
 * 追加消息并刷新 meta。锁内读-改-全量写(tmp+rename 原子替换):
 * 并发追加被串行化,无丢更新;meta.createdAt 取既有值,updatedAt 刷新。
 */
export async function appendLoopMessages(
  id: string,
  messages: AgentMessage[],
  meta?: { model?: string; providerId?: string; compactedAt?: string; tokenCalibration?: number },
  options?: LoopSessionStoreOptions,
): Promise<void> {
  const dir = storeDir(options);
  mkdirSync(dir, { recursive: true });
  const file = loopSessionFile(id, dir);

  await withFileLock({ lockPath: `${file}.lock` }, async () => {
    const existing = loadLoopSession(id, options);
    const now = new Date().toISOString();
    const nextMeta: LoopSessionMeta = {
      model: meta?.model ?? existing.meta?.model,
      providerId: meta?.providerId ?? existing.meta?.providerId,
      createdAt: existing.meta?.createdAt || now,
      updatedAt: now,
      compactedAt: meta?.compactedAt ?? existing.meta?.compactedAt,
      tokenCalibration: meta?.tokenCalibration ?? existing.meta?.tokenCalibration,
    };
    const merged = [...existing.messages, ...normalizeMessagesForPersist(messages)];
    // 系统提示记录随读-改-写全程保留(本函数只加消息,不动记录)。
    writeFileAtomic(file, serializeLoopSession(nextMeta, merged, existing.systemPrompts));
  });
}

/**
 * 系统提示记录落盘(轨迹完整性):组装的系统提示按内容 hash 与文件末条
 * 记录去重——不变不写(完成轮 jsonl 与旧版逐字节一致,只多记录行),变了/
 * 新线才写。与 appendLoopMessages 同一锁 + tmp+rename 纪律;kind 记录不
 * 是消息,绕开 role 过滤,也不进 messages(runLoop 永远看不到)。
 * pos:记录的事件序位置(排在 pos 条消息之前);调用方(引擎)传「当轮
 * user 消息之前」的下标,缺省 = 当前文件末尾。返回 true = 写了新记录。
 */
export async function appendLoopSystemPrompt(
  id: string,
  content: string,
  options?: LoopSessionStoreOptions & { pos?: number },
): Promise<boolean> {
  const hash = loopSystemPromptHash(content);
  const dir = storeDir(options);
  mkdirSync(dir, { recursive: true });
  const file = loopSessionFile(id, dir);

  return withFileLock({ lockPath: `${file}.lock` }, async () => {
    const existing = loadLoopSession(id, options);
    // 文件是真相:锁内对末条记录再核一遍(并发写者/别的进程兜底)。
    const last = existing.systemPrompts[existing.systemPrompts.length - 1];
    if (last?.hash === hash) return false;
    const now = new Date().toISOString();
    const nextMeta: LoopSessionMeta = {
      model: existing.meta?.model,
      providerId: existing.meta?.providerId,
      createdAt: existing.meta?.createdAt || now,
      updatedAt: now,
      compactedAt: existing.meta?.compactedAt,
      tokenCalibration: existing.meta?.tokenCalibration,
      claimsCursor: existing.meta?.claimsCursor,
    };
    const record: LoopSessionSystemPromptRecord = {
      hash,
      content,
      at: now,
      pos: options?.pos ?? existing.messages.length,
    };
    writeFileAtomic(file, serializeLoopSession(nextMeta, existing.messages, [...existing.systemPrompts, record]));
    return true;
  });
}

/**
 * fork:把会话前 keepCount 条消息复制成一个**新** loop session(原会话
 * 不动——分叉不是截断)。锁内读源、写新文件(tmp+rename 原子)。
 * 返回新会话 id。
 */
export async function forkLoopSession(
  srcId: string,
  keepCount: number,
  options?: LoopSessionStoreOptions,
): Promise<string> {
  const dir = storeDir(options);
  mkdirSync(dir, { recursive: true });
  const srcFile = loopSessionFile(srcId, dir);
  const newId = newLoopSessionId();
  const dstFile = loopSessionFile(newId, dir);

  await withFileLock({ lockPath: `${srcFile}.lock` }, async () => {
    const existing = loadLoopSession(srcId, options);
    const now = new Date().toISOString();
    const meta: LoopSessionMeta = {
      model: existing.meta?.model,
      providerId: existing.meta?.providerId,
      createdAt: now,
      updatedAt: now,
      compactedAt: existing.meta?.compactedAt,
      tokenCalibration: existing.meta?.tokenCalibration,
    };
    const kept = existing.messages.slice(0, Math.max(0, keepCount));
    // 系统提示记录:截点前的随副本保留(pos ≤ keepCount 的记录排在保留
    // 消息区间内;截点后的属于被裁掉的轮次,不带进分叉)。
    const keptRecords = existing.systemPrompts.filter((r) => r.pos <= kept.length);
    writeFileAtomic(dstFile, serializeLoopSession(meta, kept, keptRecords));
  });
  return newId;
}

/**
 * M4b rewind:截断到前 keepCount 条消息(锁内读-改-写;meta 保留,
 * updatedAt 刷新)。loop-sessions 的 rewind 语义天然成立——历史就是
 * 追加日志,截断即时间回溯。
 */
export async function truncateLoopSession(
  id: string,
  keepCount: number,
  options?: LoopSessionStoreOptions,
): Promise<void> {
  const dir = storeDir(options);
  const file = loopSessionFile(id, dir);
  if (!existsSync(file)) return;

  await withFileLock({ lockPath: `${file}.lock` }, async () => {
    const existing = loadLoopSession(id, options);
    const now = new Date().toISOString();
    const nextMeta: LoopSessionMeta = {
      model: existing.meta?.model,
      providerId: existing.meta?.providerId,
      createdAt: existing.meta?.createdAt || now,
      updatedAt: now,
      compactedAt: existing.meta?.compactedAt,
      tokenCalibration: existing.meta?.tokenCalibration,
    };
    const kept = existing.messages.slice(0, Math.max(0, keepCount));
    const keptRecords = existing.systemPrompts.filter((r) => r.pos <= kept.length);
    writeFileAtomic(file, serializeLoopSession(nextMeta, kept, keptRecords));
  });
}

/**
 * M3:在 meta 行打 compactedAt 标记(压缩只影响当次 LLM 上下文,
 * jsonl 全量不动——本函数只改 meta,不碰消息)。锁内读-改-写。
 */
export async function markLoopSessionCompacted(
  id: string,
  options?: LoopSessionStoreOptions,
): Promise<void> {
  const dir = storeDir(options);
  const file = loopSessionFile(id, dir);
  if (!existsSync(file)) return;

  await withFileLock({ lockPath: `${file}.lock` }, async () => {
    const existing = loadLoopSession(id, options);
    const now = new Date().toISOString();
    const nextMeta: LoopSessionMeta = {
      model: existing.meta?.model,
      providerId: existing.meta?.providerId,
      createdAt: existing.meta?.createdAt || now,
      updatedAt: existing.meta?.updatedAt || now,
      compactedAt: now,
      tokenCalibration: existing.meta?.tokenCalibration,
      claimsCursor: existing.meta?.claimsCursor,
    };
    writeFileAtomic(file, serializeLoopSession(nextMeta, existing.messages, existing.systemPrompts));
  });
}

/**
 * 1.7.2:推进 Claim 治理游标(claimsCursor = 已治理消息下标)。锁内读-改-写,
 * 只改 meta 不碰消息;与 markLoopSessionCompacted 同纪律。
 */
export async function markLoopSessionClaimsCursor(
  id: string,
  cursor: number,
  options?: LoopSessionStoreOptions,
): Promise<void> {
  const dir = storeDir(options);
  const file = loopSessionFile(id, dir);
  if (!existsSync(file)) return;

  await withFileLock({ lockPath: `${file}.lock` }, async () => {
    const existing = loadLoopSession(id, options);
    const now = new Date().toISOString();
    const nextMeta: LoopSessionMeta = {
      model: existing.meta?.model,
      providerId: existing.meta?.providerId,
      createdAt: existing.meta?.createdAt || now,
      updatedAt: existing.meta?.updatedAt || now,
      compactedAt: existing.meta?.compactedAt,
      tokenCalibration: existing.meta?.tokenCalibration,
      claimsCursor: Math.max(existing.meta?.claimsCursor ?? 0, cursor),
    };
    writeFileAtomic(file, serializeLoopSession(nextMeta, existing.messages, existing.systemPrompts));
  });
}
