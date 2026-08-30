/**
 * 1.5.2 — / 命令输入解析（纯函数层）。
 *
 * 背景（用户实机三连痛点，代码层实锤）：
 *   ① doSend 对 '/' 输入零解析——overlay 关了 Enter 就原样发 LLM；
 *   ② overlay 过滤把「/ 之后全部文本」按命令名前缀匹配——带参数输入
 *      （/intel CVE-2024-1234）面板必空；
 *   ③ overlay 选中只传命令名——参数被丢弃、输入框不清。
 *
 * 本模块把「/ 输入 → 命令名 + 参数段」的解析抽成纯函数：overlay 过滤、
 * 选中执行、doSend 直输执行三处共用同一事实源。
 */

import { SLASH_ROUTES, type SlashCommandName } from './slash-routes';

/** 本地命令（不走 SLASH_ROUTES 端点路由——runSlashCommand 特判的四个）。 */
export const LOCAL_COMMANDS = ['attach', 'model', 'reset', 'help'] as const;

/** 可吃 inline 参数直发的命令（跳过 slash-args 模态）。rewind/fork 需要
 *  消息选择器，不在此列；queue/tasks/export 参数形态特殊，export 的
 *  sanitize 字面量走模态。 */
export const INLINE_ARG_COMMANDS: ReadonlySet<string> = new Set<SlashCommandName>([
  'snapshot',
  'rollback',
  'extract',
  'intel',
  'decide',
]);

export interface SlashInput {
  /** 命令名（/ 之后第一个 token，小写化前）。 */
  name: string;
  /** 参数段（第一个空白之后的全部文本，trim 后；可为空串）。 */
  args: string;
}

/** 解析 '/name args…' → {name, args}；不以 '/' 开头或无命令名 → null。 */
export function parseSlashInput(raw: string): SlashInput | null {
  if (!raw.startsWith('/')) return null;
  const body = raw.slice(1);
  if (!body.trim()) return null;
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body);
  if (!m) return null;
  return { name: m[1], args: (m[2] ?? '').trim() };
}

/** overlay 过滤段：只取命令名 token（参数段不参与过滤——/intel CVE 按 intel 过滤）。 */
export function slashNameSegment(raw: string): string {
  return parseSlashInput(raw)?.name ?? '';
}

/** 是否已知命令（端点路由表 + 本地特判）。 */
export function isKnownCommand(name: string): boolean {
  return name in SLASH_ROUTES || (LOCAL_COMMANDS as readonly string[]).includes(name);
}

/** 命令是否可吃 inline 参数直发（跳过参数收集模态）。 */
export function acceptsInlineArgs(name: string): boolean {
  return INLINE_ARG_COMMANDS.has(name);
}
