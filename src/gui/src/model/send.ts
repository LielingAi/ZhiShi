/**
 * 发送 / 纠偏（steering）语义（纯函数）。
 *
 * 关键契约（读 src/server/loop/chat-engine.ts 核实，2026-08）：
 *   - POST /chat/send 的 body **没有** steering 字段——`PiSendInput` 只有
 *     { text, images?, model?, providerEnv?, permissionMode?, refs? }。
 *   - 纠偏是**服务端裁决**的：busy 时 /chat/send 自动进 steering 队列
 *     （W1 语义，design-spec §6.1），响应回 { queued: true, steering: true,
 *     queueId }；空闲时直接开 turn，回 { isInFlight: true }。
 *   - 客户端在 busy 时按 Enter 就是「纠偏」语义：照常 POST /chat/send，
 *     由响应里的 steering 标记决定视觉（纠偏徽标 + toast），不做任何
 *     特殊 body。
 *
 * 本模块把「请求构造 + 响应分类」抽成纯函数供单测。
 */

/** @ 引用（对齐 PiSendInput.refs 的 additive 形态）。 */
export type Ref =
  | { type: 'env'; id: string }
  | { type: 'file'; path: string }
  | { type: 'snapshot'; name: string };

export interface SendBody {
  text: string;
  refs?: Ref[];
}

/** 构造 /chat/send body；refs 空数组时不带字段（服务端 additive 语义）。 */
export function buildSendBody(text: string, refs: Ref[]): SendBody {
  const body: SendBody = { text: text.trim() };
  if (refs.length > 0) body.refs = refs;
  return body;
}

export type SendOutcome = 'started' | 'steering' | 'fifo-queued';

/** /chat/send 响应 → 去向分类。 */
export function classifySendResponse(res: {
  queued?: boolean;
  steering?: boolean;
  isInFlight?: boolean;
}): SendOutcome {
  if (res.steering === true) return 'steering';
  if (res.isInFlight === true) return 'started';
  if (res.queued === true) return 'fifo-queued';
  return 'started';
}

/** 发送成功后的用户可见提示文案（steering 时）。 */
export function steeringToast(text: string): string {
  return `↳ 已插入纠偏：${text}`.slice(0, 120);
}
