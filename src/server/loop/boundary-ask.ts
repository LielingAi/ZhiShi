/**
 * 越界 ask 通道(design §6.6 / D14)— 边界规则的「问人」补充面。
 *
 * 定位:boundary.ts 是规则硬闸(零问人,allow/deny);本模块服务另一类
 * 动作——**人可批准的越界**(四类:写宿主/用本机凭据/改网络策略/销毁有
 * 成果环境)。流程:服务端动作发起 ask → SSE `chat:boundary-ask` → TUI
 * 红色模态 → POST /chat/boundary/respond → 本注册表 resolve。没有「永远
 * 允许」,每次越界都重新问(越界不该有惯性)。
 *
 * 纪律:
 *   - 超时(默认 5min)自动拒绝 + `chat:boundary-expired`(TUI 收模态)。
 *   - /chat/stream 每次(重)连都重放 pending ask(对齐 client.ts 的
 *     pending-permission 重放约定)——TUI 重连不丢待答模态。
 *   - 纯注册表 + 注入 broadcast,单测绝不触网。
 */

import { broadcast } from '../sse';

export type BoundaryAskKind = 'host-write' | 'local-cred' | 'net-policy' | 'destroy-env';

export interface BoundaryAskView {
  askId: string;
  kind: BoundaryAskKind;
  objects: string[];
}

interface PendingAsk extends BoundaryAskView {
  resolve: (approve: boolean) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingAsk>();

export const BOUNDARY_ASK_TIMEOUT_MS = 5 * 60_000;

export type BroadcastFn = (event: string, data: unknown) => void;

/**
 * 发起一次越界询问。resolve(人批准?)在 respond/超时前一直 pending。
 * broadcast 可注入(单测);生产用 sse.broadcast 全局扇出。
 */
export function requestBoundaryAsk(
  input: { kind: BoundaryAskKind; objects: string[]; timeoutMs?: number },
  broadcastFn: BroadcastFn = broadcast,
): Promise<boolean> {
  const askId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timeoutMs = input.timeoutMs ?? BOUNDARY_ASK_TIMEOUT_MS;
  return new Promise<boolean>((resolvePromise) => {
    const view: BoundaryAskView = { askId, kind: input.kind, objects: input.objects };
    const timer = setTimeout(() => {
      if (!pending.delete(askId)) return;
      broadcastFn('chat:boundary-expired', { askId });
      resolvePromise(false);
    }, timeoutMs);
    pending.set(askId, { ...view, resolve: resolvePromise, timer });
    broadcastFn('chat:boundary-ask', view);
  });
}

/** 人已在 TUI 作答。askId 未知/已答 → false(幂等,重复应答不炸)。 */
export function respondBoundaryAsk(askId: string, approve: boolean): boolean {
  const ask = pending.get(askId);
  if (!ask) return false;
  pending.delete(askId);
  clearTimeout(ask.timer);
  ask.resolve(approve === true);
  return true;
}

/** /chat/stream 重连重放源:当前全部待答 ask。 */
export function pendingBoundaryAsks(): BoundaryAskView[] {
  return [...pending.values()].map(({ askId, kind, objects }) => ({ askId, kind, objects }));
}

/** 测试/关闭用:清空全部 pending(按拒绝处理)。 */
export function clearBoundaryAsks(): void {
  for (const ask of pending.values()) {
    clearTimeout(ask.timer);
    ask.resolve(false);
  }
  pending.clear();
}
