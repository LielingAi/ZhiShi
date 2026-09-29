/**
 * 1.8.7 P3b 团队大脑——研究线读写权限判定（双线制，设计稿「研究线双线制」表）。
 *
 * 规则（actor 形状见 auth/actor.ts；归属元数据见 loop/line-ownership.ts）：
 *
 *   | 线型               | 读                     | 写                |
 *   |--------------------|------------------------|-------------------|
 *   | 私有线（默认）      | owner + reviewer       | 仅 owner          |
 *   | 共享线             | 全体成员               | operator+         |
 *   | 归属未知（旧线）    | 全体成员               | operator+         |
 *
 * 归属未知 = line-ownership.json 无记录（1.8.6 时代及 P3a 前的旧线）——文档化
 * 缺省：升级后旧线行为与之前一致，不把人锁在自己的历史线外。
 *
 * 本机模式（source='local'，auth 关闭）一切放行——单用户行为与 1.8.6 一字节
 * 相同；auth 关闭时的远端连接同样是 local actor（文档化信任模型：token 是
 * 鉴权不是加密，没配 auth 就是信任整网）。
 */

import type { Actor } from './actor';
import { roleAtLeast } from './roles';
import type { LineOwnership } from '../loop/line-ownership';

/** 读权限：私有 = owner + reviewer；共享/归属未知 = 全体成员；本机恒放行。 */
export function canReadLine(actor: Actor, ownership: LineOwnership | undefined): boolean {
  if (actor.source === 'local') return true;
  if (!ownership || ownership.shared) return true;
  if (!ownership.owner) return true; // 归属未知旧线：人人可读
  return ownership.owner === actor.name || roleAtLeast(actor.role, 'reviewer');
}

/** 写权限：私有 = 仅 owner（路由角色闸另算）；共享/归属未知 = operator+；
 *  本机恒放行。 */
export function canWriteLine(actor: Actor, ownership: LineOwnership | undefined): boolean {
  if (actor.source === 'local') return true;
  if (!ownership || !ownership.owner || ownership.shared) {
    return roleAtLeast(actor.role, 'operator');
  }
  return ownership.owner === actor.name;
}

/**
 * 审批应答权限（boundary/decision respond——「respond 角色死结」的 B 案，
 * WREN 2026-09-29 定）：
 *   - reviewer → 任何线的 pending 都可答（审批是权威动作，跨人也归它管）；
 *   - operator → 仅可答**自己名下私有线**上的 pending（「自己的线自己批」——
 *     单机体验的自然延伸）；
 *   - 共享线 / 归属未知旧线 / 不属于任何 chat 线的 admin 类 ask（无 ownership）
 *     → 维持 reviewer-only；
 *   - 本机（auth 关闭）恒放行——单用户行为与 1.8.6 一字节相同。
 */
export function canRespondToPending(actor: Actor, ownership: LineOwnership | undefined): boolean {
  if (actor.source === 'local') return true;
  if (roleAtLeast(actor.role, 'reviewer')) return true;
  if (!ownership || ownership.shared || !ownership.owner) return false;
  return ownership.owner === actor.name;
}
