/**
 * 1.1.10(A′)— 子代理 transcript 只读查看:按 loopSessionId 把 loop-sessions
 * 的消息序列结构化成 TUI 可直接渲染的条目数组(纯读盘,不写;不做任何
 * 会话状态变更——子代理运行语义零改动)。
 *
 * 条目形状(对应设计契约「role/工具调用/结果/文本」):
 *   - user/assistant → { role, text? };assistant 带 toolCalls(名+参数摘要)
 *   - toolResult    → { role:'tool', toolName, isError, text(截断) }
 *
 * 大小护栏(transcript 可能很长):条目数超 MAX_ENTRIES 或累计文本超
 * MAX_BYTES 即停止并置 truncated=true(保留从头起的时间序——审计场景
 * 要的是证据链前段);单字段另有字符上限(文本/结果/参数摘要各自截断)。
 */

import { existsSync } from 'node:fs';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';

import {
  defaultLoopSessionDir,
  loadLoopSession,
  loopSessionFile,
  type LoopSessionMeta,
  type LoopSessionStoreOptions,
} from './session';

export interface LoopTranscriptToolCall {
  name: string;
  /** JSON 序列化后的参数摘要(截断 MAX_ARGS_CHARS)。 */
  argsSummary: string;
}

export interface LoopTranscriptEntry {
  role: 'user' | 'assistant' | 'tool';
  text?: string;
  /** assistant 消息的工具调用块(名 + 参数摘要)。 */
  toolCalls?: LoopTranscriptToolCall[];
  /** role='tool' 时的工具名。 */
  toolName?: string;
  /** role='tool' 时是否错误结果。 */
  isError?: boolean;
}

export interface LoopTranscript {
  loopSessionId: string;
  entries: LoopTranscriptEntry[];
  /** true = 因大小护栏截断,尾部消息未包含。 */
  truncated: boolean;
  /** 会话文件里的消息总数(截断前)。 */
  totalMessages: number;
  meta: LoopSessionMeta | null;
}

const MAX_ENTRIES = 200;
const MAX_BYTES = 100 * 1024;
const MAX_TEXT_CHARS = 4000;
const MAX_RESULT_CHARS = 2000;
const MAX_ARGS_CHARS = 200;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function textOf(content: UserMessage['content'] | AssistantMessage['content'] | ToolResultMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: 'text'; text: string } => c?.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

function toEntry(message: AgentMessage): LoopTranscriptEntry | null {
  if (message.role === 'user') {
    return { role: 'user', text: clip(textOf((message as UserMessage).content), MAX_TEXT_CHARS) };
  }
  if (message.role === 'assistant') {
    const m = message as AssistantMessage;
    const toolCalls = m.content
      .filter((c): c is ToolCall => c.type === 'toolCall')
      .map((c) => {
        let argsSummary: string;
        try {
          argsSummary = clip(JSON.stringify(c.arguments ?? {}), MAX_ARGS_CHARS);
        } catch {
          argsSummary = '(参数不可序列化)';
        }
        return { name: c.name, argsSummary };
      });
    const text = textOf(m.content);
    return {
      role: 'assistant',
      ...(text ? { text: clip(text, MAX_TEXT_CHARS) } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
  if (message.role === 'toolResult') {
    const m = message as ToolResultMessage;
    return {
      role: 'tool',
      toolName: m.toolName || 'tool',
      isError: m.isError === true,
      text: clip(textOf(m.content), MAX_RESULT_CHARS),
    };
  }
  return null;
}

/**
 * 读回一个 loop session 的结构化 transcript。会话文件不存在 → null
 * (端点据此回 404;空会话返回 entries:[] 而非 null——文件在就是存在)。
 */
export function buildLoopTranscript(
  id: string,
  options?: LoopSessionStoreOptions,
): LoopTranscript | null {
  const dir = options?.dir ?? defaultLoopSessionDir();
  if (!existsSync(loopSessionFile(id, dir))) return null;

  const { messages, meta } = loadLoopSession(id, options);
  const entries: LoopTranscriptEntry[] = [];
  let bytes = 0;
  let truncated = false;
  for (const message of messages) {
    const entry = toEntry(message);
    if (!entry) continue;
    const size = (entry.text?.length ?? 0)
      + (entry.toolCalls ?? []).reduce((sum, tc) => sum + tc.argsSummary.length, 0);
    if (entries.length >= MAX_ENTRIES || bytes + size > MAX_BYTES) {
      truncated = true;
      break;
    }
    entries.push(entry);
    bytes += size;
  }
  return { loopSessionId: id, entries, truncated, totalMessages: messages.length, meta };
}
