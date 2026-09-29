/**
 * 越界 ask 通道(design §6.6 / D14)— 边界规则的「问人」补充面。
 *
 * 定位:boundary.ts 是规则硬闸(零问人,allow/deny);本模块服务另一类
 * 动作——**人可批准的越界**(写宿主/用本机凭据/改网络策略/销毁有成果
 * 环境/改宿主系统配置——local-cred/net-policy/destroy-env 为 D14 规划
 * 占位,host-write 有 extract/report 生产者,system-config 为 1.7.8 本机
 * 环境新增、生产者在 boundary.ts 的 local 通道钩子)。流程:服务端动作
 * 发起 ask → SSE `chat:boundary-ask` → TUI 红色模态 → POST
 * /chat/boundary/respond → 本注册表 resolve。没有「永远允许」,每次越界
 * 都重新问(越界不该有惯性)。
 *
 * 纪律:
 *   - 超时(默认 5min)自动拒绝 + `chat:boundary-expired`(TUI 收模态)。
 *   - /chat/stream 每次(重)连都重放 pending ask(对齐 client.ts 的
 *     pending-permission 重放约定)——TUI 重连不丢待答模态。
 *   - 纯注册表 + 注入 broadcast,单测绝不触网。
 */

import { broadcast } from '../sse';

/** 越界动作类别;local-cred/net-policy/destroy-env 为 D14 规划占位
 *  （destroy-env/net-policy 当前无生产者——net-policy 语义 1.7.8 起并入
 *  system-config）,host-write 有 extract/report 生产者;system-config 为
 *  1.7.8 本机环境新增——宿主持久全局变更(bcdedit/reg HKLM/…),生产者
 *  在 boundary.ts 的 local 通道钩子。 */
export type BoundaryAskKind = 'host-write' | 'local-cred' | 'net-policy' | 'destroy-env' | 'system-config';

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
  /**
   * 1.8.7 P2 署名(additive)：ask 的归属（turn 起跑人/请求 actor 名）与
   * 应答人。均可选——旧调用方/旧记录无此字段，下游按缺省兜底。
   */
  requestedBy?: string;
  respondedBy?: string;
  /**
   * 1.8.7 P3a 按线寻址(additive)：ask 来源的 loop 线 id（system-config 等
   * 引擎内生产者经 makeBoundaryHook 挂入；admin 类生产者不挂）。可选——
   * 旧调用方/旧记录无此字段，下游按缺省兜底。
   */
  sessionId?: string;
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

export type BroadcastFn = (event: string, data: unknown, opts?: { line?: string }) => void;

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
    /** P2 署名：ask 归属（turn 起跑人/请求 actor 名）。 */
    requestedBy?: string;
    /** P3a 按线寻址：ask 来源的 loop 线 id（可选）。 */
    sessionId?: string;
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
      ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    };
    const timer = setTimeout(() => {
      if (!pending.delete(askId)) return;
      // P3b:expired 同样按线分流(路由元数据通道,payload 形状不动)。
      broadcastFn('chat:boundary-expired', { askId }, input.sessionId ? { line: input.sessionId } : undefined);
      resolvePromise(false);
    }, timeoutMs);
    pending.set(askId, { ...view, resolve: resolvePromise, timer });
    // P3b:按线分流——ask 属于来源线(sessionId 挂 payload 的同时做路由键)。
    broadcastFn('chat:boundary-ask', view, input.sessionId ? { line: input.sessionId } : undefined);
  });
}

/**
 * 人已在 TUI/GUI 作答。返回原视图(kind/objects 等)供调用方把应答
 * (含 note)落盘进 transcript。askId 未知/已答 → ok=false(幂等,
 * 重复应答不炸——first-answer-wins 语义不变)。responder = 应答人
 * 署名(P2 additive,落在返回视图上)。
 */
export function respondBoundaryAsk(askId: string, approve: boolean, responder?: string): BoundaryAskResponse {
  const ask = pending.get(askId);
  if (!ask) return { ok: false, view: null };
  pending.delete(askId);
  clearTimeout(ask.timer);
  ask.resolve(approve === true);
  const { resolve: _resolve, timer: _timer, ...view } = ask;
  return { ok: true, view: { ...view, ...(responder ? { respondedBy: responder } : {}) } };
}

/** /chat/stream 重连重放源:当前全部待答 ask。 */
export function pendingBoundaryAsks(): BoundaryAskView[] {
  return [...pending.values()].map(({ askId, kind, objects, toolName, toolDescription, options, requestedBy, sessionId }) => ({
    askId,
    kind,
    objects,
    ...(toolName ? { toolName } : {}),
    ...(toolDescription ? { toolDescription } : {}),
    ...(options ? { options } : {}),
    ...(requestedBy ? { requestedBy } : {}),
    ...(sessionId ? { sessionId } : {}),
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
