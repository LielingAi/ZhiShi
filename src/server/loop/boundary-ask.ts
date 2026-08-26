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
  /**
   * 1.3.2 设计稿 §6.6 契约补全(additive):触发工具名/工具说明/选项。
   * 展示文案由服务端随 payload 给出,GUI/TUI 不再依赖 kind 本地映射。
   * 全部可选——旧调用方不带时保持原形状(下游按缺省文案兜底)。
   */
  toolName?: string;
  toolDescription?: string;
  options?: string[];
}

interface PendingAsk extends BoundaryAskView {
  resolve: (approve: boolean) => void;
  timer: NodeJS.Timeout;
}

/** respondBoundaryAsk 的返回:ok + 原视图(供应答落盘 note 用)。 */
export interface BoundaryAskResponse {
  ok: boolean;
  view: BoundaryAskView | null;
}

const pending = new Map<string, PendingAsk>();

export const BOUNDARY_ASK_TIMEOUT_MS = 5 * 60_000;

export type BroadcastFn = (event: string, data: unknown) => void;

/**
 * 发起一次越界询问。resolve(人批准?)在 respond/超时前一直 pending。
 * broadcast 可注入(单测);生产用 sse.broadcast 全局扇出。
 */
export function requestBoundaryAsk(
  input: {
    kind: BoundaryAskKind;
    objects: string[];
    timeoutMs?: number;
    toolName?: string;
    toolDescription?: string;
    options?: string[];
  },
  broadcastFn: BroadcastFn = broadcast,
): Promise<boolean> {
  const askId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timeoutMs = input.timeoutMs ?? BOUNDARY_ASK_TIMEOUT_MS;
  return new Promise<boolean>((resolvePromise) => {
    const view: BoundaryAskView = {
      askId,
      kind: input.kind,
      objects: input.objects,
      ...(input.toolName ? { toolName: input.toolName } : {}),
      ...(input.toolDescription ? { toolDescription: input.toolDescription } : {}),
      ...(input.options && input.options.length > 0 ? { options: input.options } : {}),
    };
    const timer = setTimeout(() => {
      if (!pending.delete(askId)) return;
      broadcastFn('chat:boundary-expired', { askId });
      resolvePromise(false);
    }, timeoutMs);
    pending.set(askId, { ...view, resolve: resolvePromise, timer });
    broadcastFn('chat:boundary-ask', view);
  });
}

/**
 * 人已在 TUI/GUI 作答。note(可选)为人的备注——随应答返回的视图交给调用方
 * 落盘进 transcript。askId 未知/已答 → ok=false(幂等,重复应答不炸)。
 */
/**
 * 人已在 TUI/GUI 作答。返回原视图(kind/objects 等)供调用方把应答
 * (含 note)落盘进 transcript。askId 未知/已答 → ok=false(幂等)。
 */
export function respondBoundaryAsk(askId: string, approve: boolean): BoundaryAskResponse {
  const ask = pending.get(askId);
  if (!ask) return { ok: false, view: null };
  pending.delete(askId);
  clearTimeout(ask.timer);
  ask.resolve(approve === true);
  const { resolve: _resolve, timer: _timer, ...view } = ask;
  return { ok: true, view };
}

/** /chat/stream 重连重放源:当前全部待答 ask。 */
export function pendingBoundaryAsks(): BoundaryAskView[] {
  return [...pending.values()].map(({ askId, kind, objects, toolName, toolDescription, options }) => ({
    askId,
    kind,
    objects,
    ...(toolName ? { toolName } : {}),
    ...(toolDescription ? { toolDescription } : {}),
    ...(options ? { options } : {}),
  }));
}

/** 测试/关闭用:清空全部 pending(按拒绝处理)。 */
export function clearBoundaryAsks(): void {
  for (const ask of pending.values()) {
    clearTimeout(ask.timer);
    ask.resolve(false);
  }
  pending.clear();
}
