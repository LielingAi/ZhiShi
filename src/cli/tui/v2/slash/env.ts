/**
 * /snapshot /rollback /extract — 环境运维命令（admin environment/*）。
 * 从 app.ts 逐字搬移（1.1.10 B），`this.*` 依赖改由 SlashContext 提供。
 */

import type { SlashContext } from './types';

export async function runSnapshot(ctx: SlashContext, name: string): Promise<void> {
  if (!ctx.env.name) {
    ctx.pushBlock({ kind: 'error', text: '未锚定环境' });
    return;
  }
  ctx.pushBlock({ kind: 'divider', label: `正在为 ${ctx.env.name} 打快照…`, tone: 'info' });
  const res = await ctx.client
    .adminPost<{ success?: boolean; error?: string; data?: { snapshot?: string } }>('environment/snapshot', {
      id: ctx.env.name,
      ...(name.trim() ? { name: name.trim() } : {}),
    })
    .catch((err): { success?: boolean; error?: string; data?: { snapshot?: string } } => ({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }));
  if (res.success === false) ctx.pushBlock({ kind: 'error', text: `快照失败：${res.error}` });
  else ctx.pushBlock({ kind: 'divider', label: `快照已打：${res.data?.snapshot ?? name}`, tone: 'info' });
}

export async function runRollback(ctx: SlashContext, name: string): Promise<void> {
  if (!ctx.env.name) {
    ctx.pushBlock({ kind: 'error', text: '未锚定环境' });
    return;
  }
  if (!name.trim()) {
    ctx.pushBlock({ kind: 'error', text: '用法：/rollback <快照名>' });
    return;
  }
  ctx.pushBlock({ kind: 'divider', label: `回滚 ${ctx.env.name} → ${name.trim()}…`, tone: 'info' });
  const res = await ctx.client
    .adminPost<{ success?: boolean; error?: string; data?: { restarted?: boolean } }>('environment/rollback', {
      id: ctx.env.name,
      snapshot: name.trim(),
    })
    .catch((err): { success?: boolean; error?: string; data?: { restarted?: boolean } } => ({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }));
  if (res.success === false) ctx.pushBlock({ kind: 'error', text: `回滚失败：${res.error}` });
  else ctx.pushBlock({ kind: 'divider', label: `已回滚到 ${name.trim()}${res.data?.restarted ? '（环境已重启）' : ''}`, tone: 'info' });
}

/**
 * /extract <环境内路径> — 成果回收(design §6.4)。服务端走越界 ask 通道:
 * 这个 adminPost 会一直 pending 到人在红色模态里回答 y/n。
 */
export async function runExtract(ctx: SlashContext, arg: string): Promise<void> {
  if (!ctx.env.name) {
    ctx.pushBlock({ kind: 'error', text: '未锚定环境' });
    return;
  }
  if (!arg.trim()) {
    ctx.pushBlock({ kind: 'error', text: '用法：/extract <环境内绝对路径>' });
    return;
  }
  ctx.pushBlock({ kind: 'divider', label: `请求提取 ${ctx.env.name}:${arg.trim()}(需越界批准)…`, tone: 'info' });
  const res = await ctx.client
    .adminPost<{ success?: boolean; error?: string; data?: { savedTo?: string } }>('environment/extract', {
      id: ctx.env.name,
      guestPath: arg.trim(),
      workspace: ctx.workspace,
    })
    .catch((err): { success?: boolean; error?: string; data?: { savedTo?: string } } => ({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }));
  if (res.success === false) ctx.pushBlock({ kind: 'error', text: `提取失败:${res.error}` });
  else ctx.pushBlock({ kind: 'divider', label: `已回收到宿主:${res.data?.savedTo ?? 'output/extracted/'}`, tone: 'info' });
}
