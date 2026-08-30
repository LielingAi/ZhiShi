/**
 * / 命令 → 服务端端点映射（1.3.1 ④，纯函数）。
 *
 * 逐条对照 src/cli/zhishi.ts 的 buildRoute/buildRequestBody 与服务端
 * index.ts 路由表核实：
 *
 *   /snapshot → admin environment/snapshot { id, name? }
 *   /rollback → admin environment/rollback { id, snapshot }
 *   /extract  → admin environment/extract { id, guestPath, workspace }
 *   /rewind   → POST /chat/rewind { userMessageId }（wire 消息 id，从
 *               replay 的 user 消息 srvId 拿——见 rewindTargets）
 *   /fork     → POST /sessions/fork { messageId }（forkPiChat，busy 拒绝）
 *   /queue    → GET /chat/queue/status；取消 → POST /chat/queue/cancel { queueId }
 *   /tasks    → admin task/list + task/get；subagent transcript →
 *               GET /api/loop-session/messages?loopSessionId=
 *   /export   → admin report/export { workspace, sanitize? }（内部自带
 *               host-write 越界询问——应答走 boundary 模态）
 *
 * 纯函数：只声明「打哪 / 带什么」，不发请求；store 按返回结构执行。
 */

import type { StreamItem, TurnBlock } from './blocks';

// ---------------------------------------------------------------------------
// 命令名与端点
// ---------------------------------------------------------------------------

export type SlashCommandName =
  | 'snapshot'
  | 'rollback'
  | 'extract'
  | 'rewind'
  | 'fork'
  | 'queue'
  | 'tasks'
  | 'export'
  | 'intel'
  | 'archive'
  | 'decide';

export type SlashEndpoint =
  | { kind: 'admin'; route: string }
  | { kind: 'http'; method: 'GET' | 'POST'; path: string };

export interface SlashRoute {
  command: SlashCommandName;
  endpoint: SlashEndpoint;
  /** 是否需要当前环境（无环境锚时命令退化为 toast 提示）。 */
  needsEnv: boolean;
  /** 参数收集形态：none=直接执行 / name=必填名 / path=必填路径 / message=选消息。 */
  needsArgs: 'none' | 'optional-name' | 'name' | 'path' | 'message';
  /** 参数收集模态的标题与占位（needsArgs !== 'none' 时用）。 */
  argTitle: string;
  argPlaceholder: string;
}

export const SLASH_ROUTES: Record<SlashCommandName, SlashRoute> = {
  snapshot: {
    command: 'snapshot',
    endpoint: { kind: 'admin', route: 'environment/snapshot' },
    needsEnv: true,
    needsArgs: 'optional-name',
    argTitle: '给当前环境打快照',
    argPlaceholder: '快照名（可选，缺省服务端命名）',
  },
  rollback: {
    command: 'rollback',
    endpoint: { kind: 'admin', route: 'environment/rollback' },
    needsEnv: true,
    needsArgs: 'name',
    argTitle: '回滚到快照',
    argPlaceholder: '快照名（environment/snapshot 打的）',
  },
  extract: {
    command: 'extract',
    endpoint: { kind: 'admin', route: 'environment/extract' },
    needsEnv: true,
    needsArgs: 'path',
    argTitle: '回收环境内文件到宿主',
    argPlaceholder: '环境内绝对路径，如 /work/flag.txt',
  },
  rewind: {
    command: 'rewind',
    endpoint: { kind: 'http', method: 'POST', path: '/chat/rewind' },
    needsEnv: false,
    needsArgs: 'message',
    argTitle: '回退到哪条消息',
    argPlaceholder: '',
  },
  fork: {
    command: 'fork',
    endpoint: { kind: 'http', method: 'POST', path: '/sessions/fork' },
    needsEnv: false,
    needsArgs: 'message',
    argTitle: '从哪条消息分叉',
    argPlaceholder: '',
  },
  queue: {
    command: 'queue',
    endpoint: { kind: 'http', method: 'GET', path: '/chat/queue/status' },
    needsEnv: false,
    needsArgs: 'none',
    argTitle: '',
    argPlaceholder: '',
  },
  tasks: {
    command: 'tasks',
    endpoint: { kind: 'admin', route: 'task/list' },
    needsEnv: false,
    needsArgs: 'none',
    argTitle: '',
    argPlaceholder: '',
  },
  export: {
    command: 'export',
    endpoint: { kind: 'admin', route: 'report/export' },
    needsEnv: false,
    // 1.3.5：可选 sanitize 参数（脱敏导出，TUI /export [sanitize] 同语义）。
    needsArgs: 'optional-name',
    argTitle: '导出研究报告',
    argPlaceholder: 'sanitize（可选——脱敏导出；留空直接导出）',
  },
  // ── 1.5.0 触发权归人（研究命令；执行不走端点直调，runSlashCommand 特判） ──
  intel: {
    command: 'intel',
    endpoint: { kind: 'admin', route: 'intel/search' },
    needsEnv: false,
    needsArgs: 'optional-name',
    argTitle: '查情报库',
    argPlaceholder: 'CVE 编号或产品/关键字（留空 = 吃当前会话上下文）',
  },
  archive: {
    command: 'archive',
    endpoint: { kind: 'http', method: 'POST', path: '/chat/send' },
    needsEnv: false,
    needsArgs: 'none',
    argTitle: '',
    argPlaceholder: '',
  },
  decide: {
    command: 'decide',
    endpoint: { kind: 'http', method: 'POST', path: '/chat/send' },
    needsEnv: false,
    needsArgs: 'optional-name',
    argTitle: '给我选项（人拍板）',
    argPlaceholder: '议题（留空 = 取当前上下文焦点）',
  },
};

/** 未知命令 → null（调用方 toast）。 */
export function slashRoute(command: string): SlashRoute | null {
  return SLASH_ROUTES[command as SlashCommandName] ?? null;
}

// ---------------------------------------------------------------------------
// rewind / fork 的消息目标提取（wire id 来源：replay 消息的 srvId）
// ---------------------------------------------------------------------------

export interface MessageTarget {
  /** wire 消息 id（/chat/rewind 的 userMessageId / fork 的 messageId）。 */
  id: string;
  /** 展示标签（用户文本截断）。 */
  label: string;
}

function turnWireId(t: TurnBlock): string | undefined {
  return t.srvIds.find((id) => id !== '') ?? t.srvIds[0];
}

function turns(items: StreamItem[]): TurnBlock[] {
  return items.filter((i): i is TurnBlock => i.kind === 'turn');
}

/** /rewind 目标：user 消息（截断即回到该消息之前/之后——服务端按该 user 消息截断）。 */
export function rewindTargets(items: StreamItem[]): MessageTarget[] {
  const out: MessageTarget[] = [];
  for (const t of turns(items)) {
    const id = turnWireId(t);
    if (!id || !t.userText.trim()) continue;
    const label = t.userText.length > 40 ? `${t.userText.slice(0, 40)}…` : t.userText;
    out.push({ id, label });
  }
  return out;
}

/** /fork 目标：user 消息（fork 后保留该消息及之前全部内容）。 */
export function forkTargets(items: StreamItem[]): MessageTarget[] {
  return rewindTargets(items);
}

// ---------------------------------------------------------------------------
// payload 构造
// ---------------------------------------------------------------------------

export interface SlashCtx {
  /** 当前环境 id（null = 宿主，未锚定）。 */
  envKey: string | null;
  /** 工作区路径（chat:init 的 agentDir；export 必填）。 */
  workspace: string | null;
}

/** needsEnv 命令在无环境锚时的提示文案。 */
export function noEnvToast(command: SlashCommandName): string {
  return `/${command}：宿主未锚定环境——先在侧栏切换到运行中的环境`;
}

/**
 * 构造命令 payload（参数已收集）。返回 null 表示缺环境/缺工作区，
 * 调用方按 noEnvToast 提示。
 */
export function slashPayload(
  route: SlashRoute,
  ctx: SlashCtx,
  arg?: string,
): Record<string, unknown> | null {
  if (route.needsEnv && !ctx.envKey) return null;
  switch (route.command) {
    case 'snapshot': {
      const payload: Record<string, unknown> = { id: ctx.envKey };
      if (arg && arg.trim()) payload.name = arg.trim();
      return payload;
    }
    case 'rollback':
      return { id: ctx.envKey, snapshot: arg?.trim() ?? '' };
    case 'extract':
      return { id: ctx.envKey, guestPath: arg?.trim() ?? '', workspace: ctx.workspace ?? undefined };
    case 'rewind':
      return { userMessageId: arg?.trim() ?? '' };
    case 'fork':
      return { messageId: arg?.trim() ?? '' };
    case 'queue':
    case 'tasks':
      return {};
    case 'intel':
    case 'archive':
    case 'decide':
      // 1.5.0 研究命令：执行不走 slashPayload（查询/注入编排在 store 的
      // executeSlash 特判），这里仅为穷尽性保底。
      return {};
    case 'export': {
      if (!ctx.workspace) return null;
      // 1.3.5：可选 sanitize（脱敏导出）——只认 'sanitize' 一个字面量，
      // 其余非法值由调用方（store 的用法校验）拦截，这里不透传。
      const payload: Record<string, unknown> = { workspace: ctx.workspace };
      if (arg && arg.trim() === 'sanitize') payload.sanitize = true;
      return payload;
    }
  }
}

/** export 成功后的 toast 文案（res.data 形状见 server/report/export.ts）。 */
export function exportResultToast(data: Record<string, unknown> | undefined): string {
  const dir = typeof data?.reportDir === 'string' ? data.reportDir : 'report';
  const evidence = typeof data?.evidenceCount === 'number' ? ` · 证据 ${data.evidenceCount} 件` : '';
  const degraded =
    Array.isArray(data?.degraded) && data.degraded.length > 0 ? ` · 降级 ${data.degraded.length} 项` : '';
  const sanitized = data?.sanitized === true ? ' · 已脱敏' : '';
  return `报告已导出：${dir}${evidence}${degraded}${sanitized}`;
}
