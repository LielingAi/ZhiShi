/**
 * commands — the slash-command + help surface. ONE source of truth for what
 * the palette advertises. Hard rule: every entry maps to a REAL endpoint or
 * local action — the first cut advertised six commands that posted into the
 * void (dead endpoints, silently swallowed). If it doesn't exist, it's not here.
 *
 * Real server surface (verified against src/server/index.ts + admin-api.ts):
 *   /chat/send · /chat/stop · /chat/reset · /chat/rewind · /chat/model
 *   /chat/queue · /chat/queue/cancel · /chat/queue/status
 *   admin environment/snapshot|rollback|select|list|exec …
 */

import type { RefAttachment } from './types';

export interface CommandItem {
  /** Display + insert name (without the leading /). */
  name: string;
  detail: string;
  group: '环境' | '线程' | '配置';
  /** Usage hint shown when args are required. */
  usage?: string;
}

export const SLASH_COMMANDS: CommandItem[] = [
  { name: 'snapshot', detail: '给当前环境打快照 [名]', group: '环境' },
  { name: 'rollback', detail: '回滚到快照 <名>', group: '环境', usage: '/rollback <快照名>' },
  { name: 'extract', detail: '回收环境内文件到宿主 <路径>', group: '环境', usage: '/extract <环境内路径>' },
  { name: 'rewind', detail: '回退到历史消息（改完重发）', group: '线程' },
  { name: 'fork', detail: '从某条消息分叉出新线程', group: '线程' },
  { name: 'queue', detail: '查看/取消排队消息', group: '线程' },
  { name: 'tasks', detail: '查看子任务与后台进程', group: '线程' },
  { name: 'export', detail: '导出研究报告（report.md + evidence/）', group: '线程', usage: '/export [sanitize]' },
  { name: 'reset', detail: '重置对话（新会话）', group: '线程' },
  { name: 'model', detail: '模型配置/切换（状态卡 · set-key · use）', group: '配置', usage: '/model [set-key <供应商> | use <供应商> <模型> | <模型名>]' },
  { name: 'mcp', detail: 'MCP 服务器状态/开关', group: '配置', usage: '/mcp [enable <id> | disable <id> | -r]' },
  { name: 'help', detail: '查看全部斜杠命令', group: '配置' },
];

/** @-reference item (env entries; file refs are typed freehand). */
export interface AtItem {
  label: string;
  detail: string;
  insert: string;
  ref?: RefAttachment;
}

/** Subsequence fuzzy filter (shared scorer from history.ts). */
export function filterByQuery<T extends { label: string }>(
  items: T[],
  query: string,
  score: (q: string, c: string) => number,
): T[] {
  if (!query) return items;
  return items
    .map((it) => ({ it, s: score(query, it.label) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.it);
}
