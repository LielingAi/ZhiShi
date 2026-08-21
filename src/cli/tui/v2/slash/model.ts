/**
 * /model — 模型配置闭环（子流程完整，自成文件）。从 app.ts 逐字搬移
 * （1.1.10 B），`this.*` 依赖改由 SlashContext 提供；纯逻辑（参数解析/
 * 状态卡行构造）仍在 ../model。
 */

import {
  parseModelArgs,
  composeModelCardRows,
  type ModelProviderInfo,
} from '../model';
import type { SlashContext } from './types';

/**
 * /model — 模型配置闭环:
 *   无参 → 状态卡(供应商/已配 key/默认模型/模型数 + 当前默认);
 *   set-key <供应商id> → 隐藏输入填 key → admin model/set-key(自动发现模型);
 *   use <供应商id> <模型名> → 带供应商语义切换(防重名);
 *   <模型名> → 旧语法直接切换(向后兼容)。
 */
export async function runModel(ctx: SlashContext, arg: string): Promise<void> {
  const args = parseModelArgs(arg);
  switch (args.kind) {
    case 'error':
      ctx.pushBlock({ kind: 'error', text: args.message });
      return;
    case 'status':
      await showModelStatus(ctx);
      return;
    case 'set-key':
      await runModelSetKey(ctx, args.providerId);
      return;
    case 'use':
      await runModelUse(ctx, args.providerId, args.model);
      return;
    case 'switch':
      await runModelSwitch(ctx, args.model);
      return;
  }
}

/** /model(无参)——供应商状态卡。数据来自 admin model/list(全量目录)。 */
async function showModelStatus(ctx: SlashContext): Promise<void> {
  const res = await ctx.client
    .adminPost<{ success?: boolean; error?: string; data?: ModelProviderInfo[] }>('model/list', {})
    .catch((): { success?: boolean; error?: string; data?: ModelProviderInfo[] } => ({
      success: false,
      error: '无法连接 sidecar',
    }));
  if (res.success === false) {
    ctx.pushBlock({ kind: 'error', text: res.error ?? '模型状态获取失败' });
    return;
  }
  const providers = res.data ?? [];
  for (const row of composeModelCardRows(providers, ctx.state.status.model)) {
    ctx.pushBlock({ kind: 'divider', label: row.label, follow: row.follow, tone: row.tone });
  }
}

/** /model set-key <供应商id> — 隐藏输入填 key → 保存 → 自动拉模型目录。 */
async function runModelSetKey(ctx: SlashContext, providerId: string): Promise<void> {
  // 先在目录里确认供应商存在(含 kimi 内置合成条目),顺带拿显示名。
  const list = await ctx.client
    .adminPost<{ success?: boolean; data?: ModelProviderInfo[] }>('model/list', {})
    .catch((): { success?: boolean; data?: ModelProviderInfo[] } => ({ success: false }));
  const provider = (list.data ?? []).find((p) => p.id === providerId);
  if (!provider) {
    ctx.pushBlock({ kind: 'error', text: `未知供应商: ${providerId}（/model 查看可配供应商）` });
    return;
  }
  const apiKey = await ctx.startHiddenLine(
    `输入 ${provider.name} API key（隐藏输入，Enter 确认，Esc 取消）`,
  );
  if (apiKey === null) {
    ctx.pushBlock({ kind: 'divider', label: `已取消（未保存 ${providerId} key）`, tone: 'info' });
    return;
  }
  const res = await ctx.client
    .adminPost<{ success?: boolean; error?: string; data?: { modelsFetched?: number; modelsFetchError?: string } }>(
      'model/set-key',
      { id: providerId, apiKey },
    )
    .catch((): { success?: boolean; error?: string; data?: { modelsFetched?: number; modelsFetchError?: string } } => ({
      success: false,
      error: '无法连接 sidecar',
    }));
  if (res.success === false) {
    ctx.pushBlock({ kind: 'error', text: `保存失败：${res.error ?? '未知错误'}` });
    return;
  }
  const fetched = res.data?.modelsFetched;
  const fetchErr = res.data?.modelsFetchError;
  const follow = fetched !== undefined
    ? `自动发现 ${fetched} 个模型`
    : fetchErr
      ? `模型列表拉取失败（key 已保存）：${fetchErr}`
      : '已保存';
  ctx.pushBlock({ kind: 'divider', label: `✓ 已保存 ${providerId} API key`, follow, tone: 'ok' });
  await showModelStatus(ctx);
}

/** /model use <供应商id> <模型名> — 带供应商前缀的切换(撞名不误配)。 */
async function runModelUse(ctx: SlashContext, providerId: string, model: string): Promise<void> {
  const res = await ctx.client
    .postJson<{ success?: boolean; error?: string; providerId?: string; model?: string }>('/chat/model', {
      model,
      providerId,
    })
    .catch((): { success?: boolean; error?: string; providerId?: string; model?: string } => ({
      success: false,
      error: '无法连接 sidecar',
    }));
  if (!res.success) {
    ctx.pushBlock({ kind: 'error', text: res.error ?? '切换模型失败' });
    return;
  }
  ctx.state.status.model = res.model ?? model;
  ctx.pushBlock({ kind: 'divider', label: `模型已切换：${providerId}/${res.model ?? model}`, tone: 'ok' });
}

/** /model <模型名>(向后兼容)——无供应商语义,由服务端反查归属。 */
async function runModelSwitch(ctx: SlashContext, model: string): Promise<void> {
  const res = await ctx.client
    .postJson<{ success?: boolean; error?: string; providerId?: string; model?: string }>('/chat/model', { model })
    .catch((): { success?: boolean; error?: string; providerId?: string; model?: string } => ({
      success: false,
      error: '无法连接 sidecar',
    }));
  if (res.success) {
    ctx.state.status.model = res.model ?? model;
    ctx.pushBlock({ kind: 'divider', label: `模型已切换：${res.model ?? model}`, tone: 'ok' });
  } else {
    ctx.pushBlock({ kind: 'error', text: res.error ?? '切换模型失败' });
  }
}
