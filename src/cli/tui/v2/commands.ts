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
  { name: 'attach', detail: '接管环境 shell（TUI 挂起）', group: '环境' },
  { name: 'snapshot', detail: '给当前环境打快照 [名]', group: '环境' },
  { name: 'rollback', detail: '回滚到快照 <名>', group: '环境', usage: '/rollback <快照名>' },
  { name: 'extract', detail: '回收环境内文件到宿主 <路径>', group: '环境', usage: '/extract <环境内路径>' },
  { name: 'env', detail: '重新选择工作环境', group: '环境' },
  { name: 'rewind', detail: '回退到历史消息（改完重发）', group: '线程' },
  { name: 'fork', detail: '从某条消息分叉出新线程', group: '线程' },
  { name: 'queue', detail: '查看/取消排队消息', group: '线程' },
  { name: 'reset', detail: '重置对话（新会话）', group: '线程' },
  { name: 'model', detail: '切换模型 <名>', group: '配置', usage: '/model <模型名>' },
  { name: 'help', detail: '键位与命令帮助', group: '配置' },
  { name: 'quit', detail: '退出会话界面', group: '配置' },
];

export interface HelpEntry {
  keys: string;
  detail: string;
}

export const HELP_ENTRIES: HelpEntry[] = [
  { keys: 'Enter', detail: '发送；turn 进行中发送 = 纠偏注入' },
  { keys: 'Ctrl+J / Alt+Enter', detail: '多行输入' },
  { keys: '↑ / ↓', detail: '历史消息（输入为空时）' },
  { keys: 'Ctrl+R', detail: '历史搜索' },
  { keys: 'Esc', detail: '中断 turn / 关闭面板 / 回到底部' },
  { keys: 'Ctrl+Z', detail: '回退到历史消息（rewind）' },
  { keys: 'Ctrl+O', detail: '展开/收起最近工具输出' },
  { keys: 'Ctrl+L', detail: '开关本帮助' },
  { keys: 'PgUp / PgDn', detail: '回看会话（输入永不锁）' },
  { keys: 'Tab', detail: '补全 / 或 @ 引用' },
  { keys: 'Ctrl+C', detail: '清空输入；空输入时中断；空闲时退出' },
  { keys: '/', detail: '命令面板' },
  { keys: '@', detail: '引用环境 / 文件' },
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
