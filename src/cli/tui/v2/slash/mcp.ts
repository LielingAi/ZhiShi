/**
 * /mcp — MCP 桥状态/热重载/启停（子流程完整，自成文件）。从 app.ts 逐字
 * 搬移（1.1.10 B），`this.*` 依赖改由 SlashContext 提供；纯逻辑（参数
 * 解析/状态卡行构造）仍在 ../model。
 */

import {
  parseMcpArgs,
  composeMcpCardRows,
  type McpBridgeRow,
  type McpServerRow,
} from '../model';
import type { SlashContext } from './types';

/**
 * /mcp — MCP 桥状态展示(含启用标注)/ -r 热重载 / enable|disable <id>
 * 开关。开关走 admin mcp/enable|disable 写盘 → mcp/reload 桥重载,
 * 当前会话立即生效(磁盘为权威来源)。
 */
export async function runMcp(ctx: SlashContext, arg: string): Promise<void> {
  const args = parseMcpArgs(arg);
  switch (args.kind) {
    case 'error':
      ctx.pushBlock({ kind: 'error', text: args.message });
      return;
    case 'enable':
    case 'disable':
      await runMcpToggle(ctx, args.kind, args.id);
      return;
    case 'reload':
      await showMcpStatus(ctx, true);
      return;
    case 'status':
      await showMcpStatus(ctx, false);
      return;
  }
}

/** 展示 MCP 状态。reload=true 时先走 mcp/reload(热重载后拿新状态)。 */
async function showMcpStatus(ctx: SlashContext, reload: boolean): Promise<void> {
  if (reload) ctx.pushBlock({ kind: 'divider', label: 'MCP 重连中…', tone: 'info' });
  const statusRes = await ctx.client
    .adminPost<{ success?: boolean; error?: string; data?: { servers?: McpBridgeRow[] } }>(
      reload ? 'mcp/reload' : 'mcp/list-status',
      {},
    )
    .catch((): { success?: boolean; error?: string; data?: { servers?: McpBridgeRow[] } } => ({
      success: false,
      error: '无法连接 sidecar',
    }));
  if (statusRes.success === false) {
    ctx.pushBlock({ kind: 'error', text: statusRes.error ?? 'MCP 状态获取失败' });
    return;
  }
  const statuses = statusRes.data?.servers ?? [];
  // 无参展示要标注启用状态:mcp/list 给全量(含 enabled 标记),桥状态只有
  // 已启用服务器的连接结果——两侧合并。清单拉取失败降级为只列桥状态。
  let servers: McpServerRow[] = [];
  if (!reload) {
    const listRes = await ctx.client
      .adminPost<{ success?: boolean; data?: McpServerRow[] }>('mcp/list', {})
      .catch((): { success?: boolean; data?: McpServerRow[] } => ({ success: false }));
    servers = listRes.data ?? [];
  }
  const summary = composeMcpCardRows(servers, statuses);
  if (summary.rows.length === 0) {
    ctx.pushBlock({ kind: 'divider', label: 'MCP 服务器状态', follow: '0 台(无已启用服务器)', tone: 'info' });
    return;
  }
  ctx.pushBlock({
    kind: 'divider',
    label: reload ? 'MCP 已重载' : 'MCP 服务器状态',
    follow: `${summary.total} 台 · 启用 ${summary.enabledCount}`,
    tone: 'info',
  });
  for (const row of summary.rows) {
    ctx.pushBlock({ kind: 'divider', label: row.label, follow: row.follow, tone: row.tone });
  }
}

/** /mcp enable|disable <id> — 写盘 → 桥热重载,显示结果与当前工具数。 */
async function runMcpToggle(ctx: SlashContext, kind: 'enable' | 'disable', id: string): Promise<void> {
  const verb = kind === 'enable' ? '启用' : '停用';
  ctx.pushBlock({ kind: 'divider', label: `MCP ${verb} ${id}…`, tone: 'info' });
  const res = await ctx.client
    .adminPost<{ success?: boolean; error?: string }>(`mcp/${kind}`, { id })
    .catch((): { success?: boolean; error?: string } => ({ success: false, error: '无法连接 sidecar' }));
  if (res.success === false) {
    ctx.pushBlock({ kind: 'error', text: `${verb}失败：${res.error ?? '未知错误'}` });
    return;
  }
  // 配置已写盘;桥热重载让变更在当前会话立即生效。
  const reloadRes = await ctx.client
    .adminPost<{ success?: boolean; error?: string; data?: { servers?: McpBridgeRow[] } }>('mcp/reload', {})
    .catch((): { success?: boolean; error?: string; data?: { servers?: McpBridgeRow[] } } => ({
      success: false,
      error: '无法连接 sidecar',
    }));
  if (reloadRes.success === false) {
    ctx.pushBlock({ kind: 'error', text: `配置已写入但桥重载失败：${reloadRes.error ?? '未知错误'}` });
    return;
  }
  const target = (reloadRes.data?.servers ?? []).find((s) => s.id === id);
  if (kind === 'enable') {
    if (target?.status === 'connected') {
      ctx.pushBlock({
        kind: 'divider',
        label: `✓ 已启用 ${id}`,
        follow: `connected · ${target.toolCount ?? 0} 工具`,
        tone: 'ok',
      });
    } else {
      ctx.pushBlock({
        kind: 'divider',
        label: `✓ 已启用 ${id}（连接失败）`,
        follow: target?.error ?? '未连接',
        tone: 'fail',
      });
    }
  } else {
    ctx.pushBlock({ kind: 'divider', label: `✓ 已停用 ${id}`, follow: '已从当前会话移除', tone: 'ok' });
  }
}
