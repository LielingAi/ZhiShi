/**
 * /attach — 终端接管（ssh/docker exec）。从 app.ts 逐字搬移（1.1.10 B），
 * `this.*` 依赖改由 SlashContext 提供。
 */

import { targetForEnv, spawnAttach } from '../attach';
import type { SlashContext } from './types';

export async function runAttach(ctx: SlashContext): Promise<void> {
  if (!ctx.suspend || !ctx.resume) return;
  // Resolve connection metadata fresh (the gate only carries id+kind).
  let target;
  try {
    const res = await ctx.client.adminPost<{ data?: { environments?: Record<string, unknown>[] } }>(
      'environment/list',
      {},
    );
    const entry = (res.data?.environments ?? []).find((e) => e.id === ctx.env.name) ?? {};
    target = targetForEnv({
      kind: (entry.kind as string) ?? ctx.env.kind,
      sshUser: (entry.user as string) ?? undefined,
      sshAddress: ((entry.host ?? entry.address) as string) ?? undefined,
      sshKeyPath: (entry.keyPath as string) ?? undefined,
      container: (entry.container as string) ?? undefined,
    });
  } catch {
    target = targetForEnv({ kind: ctx.env.kind });
  }
  if (target.kind === 'local') {
    ctx.pushBlock({ kind: 'error', text: '该环境不支持接管（缺少 ssh/docker 连接信息）' });
    return;
  }
  ctx.suspend();
  try {
    await (ctx.spawnAttachImpl ?? spawnAttach)(target);
  } finally {
    ctx.resume();
    ctx.repaintAll();
    ctx.renderChrome();
  }
}
