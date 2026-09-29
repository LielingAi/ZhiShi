/**
 * 1.8.7 P2 团队大脑——身份贯穿（设计稿 P2：每条记录都回答「谁」）。
 *
 * Actor 形状全场统一：{ name, role, source }。
 *   - source='token'：HTTP/WS 请求过了 Bearer 闸，name/role 来自 token；
 *   - source='local'：auth 关闭（本机单用户）或未鉴权的开放路由——文档化
 *     的本机行为者 LOCAL_ACTOR，保证下游消费方永远看到同一形状，且本地
 *     模式可观察行为与 1.8.6 一字节相同（只多出 additive 署名字段）。
 *
 * 传播两条路：
 *   1. 请求内：index.ts 把 actorName/actorRole 并入 ALS 日志上下文
 *     （withLogContext——沿用现有上下文系统，不另起第二套），请求处理
 *     链上 currentActor() 可取；
 *   2. turn 内：turn 起跑时（chat/send 起跑、队列 promote、cron/auto-run
 *     invoke）把当时抓到的 actor 按 loop 线登记进 turnOriginators——
 *     turn 异步跑出原请求 ALS 帧后，turn 内产物（boundary ask / 决策 /
 *     纠正 / claims / research 事件）仍按起跑人署名。
 */

import { getLogContext } from '../logger-context';
import { isAuthRole, type AuthRole } from './roles';

export interface Actor {
  name: string;
  role: AuthRole;
  source: 'token' | 'local';
}

/** 本机行为者（auth 关闭 / 开放路由）：本地模式的文档化兜底身份。 */
export const LOCAL_ACTOR: Actor = { name: 'local', role: 'reviewer', source: 'local' };

/**
 * 当前 ALS 帧里的 actor；无帧或无身份字段 → LOCAL_ACTOR。
 * （请求帧由 index.ts 在过闸后并入 actorName/actorRole。）
 */
export function currentActor(): Actor {
  const ctx = getLogContext();
  if (ctx?.actorName) {
    return {
      name: ctx.actorName,
      role: ctx.actorRole && isAuthRole(ctx.actorRole) ? ctx.actorRole : LOCAL_ACTOR.role,
      source: 'token',
    };
  }
  return LOCAL_ACTOR;
}

// ---------------------------------------------------------------------------
// turn 起跑人登记（按 loop 线；进程内一张表）
// ---------------------------------------------------------------------------

// 条线是长跑对象、条目极小（~50B），不淘汰——末次起跑人也是治理弧等
// 迟到写路径的正确归属。线换人（另一成员接线开 turn）时起跑即覆盖。
const turnOriginators = new Map<string, Actor>();

/** turn 起跑时登记起跑人（chat-engine 唯二写入点：startPiTurn / invokePiSession）。 */
export function setTurnOriginator(sessionId: string, actor: Actor): void {
  if (!sessionId) return;
  turnOriginators.set(sessionId, actor);
}

/**
 * 某条 loop 线的归属 actor：有登记 → 起跑人；无登记 → 当前 ALS actor
 * （请求内直接产物，如 admin 路由）；再兜底 LOCAL_ACTOR。
 */
export function originatorForSession(sessionId?: string): Actor {
  if (sessionId) {
    const hit = turnOriginators.get(sessionId);
    if (hit) return hit;
  }
  return currentActor();
}

/** 测试用：清起跑人表。 */
export function __resetTurnOriginatorsForTests(): void {
  turnOriginators.clear();
}
