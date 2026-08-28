/**
 * M2(D26)— loop 会话持久化/恢复。
 *
 * 存储:`~/.zhishi/loop-sessions/<sessionId>.jsonl`,一行一条 JSON:
 *   - 首行元数据:{ kind:'meta', model?, providerId?, createdAt, updatedAt }
 *   - 其余每行一条 pi AgentMessage(user/assistant/toolResult)
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
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { getZhiShiDataDir } from '../utils/app-dirs';
import { withFileLock, writeFileAtomic } from '../utils/file-lock';

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
}

export interface LoopSession {
  messages: AgentMessage[];
  meta: LoopSessionMeta | null;
}

export interface LoopSessionStoreOptions {
  /** 存储目录(测试注入临时目录;默认 ~/.zhishi/loop-sessions)。 */
  dir?: string;
}

const META_KIND = 'meta';
const VALID_ROLES = new Set(['user', 'assistant', 'toolResult']);

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
 */
export function normalizeMessagesForPersist(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(
    (m): m is AgentMessage =>
      !!m && typeof m === 'object' && VALID_ROLES.has((m as { role?: string }).role ?? ''),
  );
}

/** 解析一行为 meta 或 message;坏行/非法 role → null(容错跳过)。 */
export function parseLoopSessionLine(line: string): { kind: 'meta'; meta: LoopSessionMeta } | { kind: 'msg'; message: AgentMessage } | null {
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
      },
    };
  }
  if (VALID_ROLES.has(rec.role as string)) {
    return { kind: 'msg', message: parsed as AgentMessage };
  }
  return null;
}

/** 序列化:meta 首行 + 每消息一行。 */
export function serializeLoopSession(meta: LoopSessionMeta, messages: AgentMessage[]): string {
  const lines = [JSON.stringify({ kind: META_KIND, ...meta })];
  for (const m of normalizeMessagesForPersist(messages)) {
    lines.push(JSON.stringify(m));
  }
  return lines.join('\n') + '\n';
}

/** 反序列化整文件(坏行跳过)。 */
export function parseLoopSession(content: string): LoopSession {
  const messages: AgentMessage[] = [];
  let meta: LoopSessionMeta | null = null;
  for (const line of content.split('\n')) {
    const parsed = parseLoopSessionLine(line);
    if (!parsed) continue;
    if (parsed.kind === 'meta') meta = parsed.meta;
    else messages.push(parsed.message);
  }
  return { messages, meta };
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

/** 加载会话;不存在/损坏 → 空会话(messages:[], meta:null)。 */
export function loadLoopSession(id: string, options?: LoopSessionStoreOptions): LoopSession {
  const file = loopSessionFile(id, storeDir(options));
  if (!existsSync(file)) return { messages: [], meta: null };
  let content: string;
  try {
    content = readFileSync(file, 'utf-8');
  } catch {
    return { messages: [], meta: null };
  }
  return parseLoopSession(content);
}

/**
 * 追加消息并刷新 meta。锁内读-改-全量写(tmp+rename 原子替换):
 * 并发追加被串行化,无丢更新;meta.createdAt 取既有值,updatedAt 刷新。
 */
export async function appendLoopMessages(
  id: string,
  messages: AgentMessage[],
  meta?: { model?: string; providerId?: string; compactedAt?: string },
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
    };
    const merged = [...existing.messages, ...normalizeMessagesForPersist(messages)];
    writeFileAtomic(file, serializeLoopSession(nextMeta, merged));
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
    };
    const kept = existing.messages.slice(0, Math.max(0, keepCount));
    writeFileAtomic(dstFile, serializeLoopSession(meta, kept));
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
    };
    const kept = existing.messages.slice(0, Math.max(0, keepCount));
    writeFileAtomic(file, serializeLoopSession(nextMeta, kept));
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
    };
    writeFileAtomic(file, serializeLoopSession(nextMeta, existing.messages));
  });
}
