/**
 * 多会话并存状态机（1.3.2 任务三「侧栏多线切换 · A 形态」，纯函数）。
 *
 * 界面层多会话并存：sessions[key] 按环境锚分线（key = env id；宿主线键
 * 'host'），currentEnvKey 是激活指针。切换会话 = 换激活指针 + 保留目标线
 * 现有状态（含未完成渲染的流）——**不**重置目标线（重连 replay 会按
 * wire id 幂等重建/续上）。B 形态（引擎真并行）不在本版，服务端零改动。
 *
 * 纯函数：不 import store / React / client；单测覆盖切换状态机。
 */

import { emptySession, type SessionState } from './blocks';

// ---------------------------------------------------------------------------
// 键与状态机
// ---------------------------------------------------------------------------

/** GUI 侧会话键：null/undefined/''（宿主未锚定）→ 'host'。 */
export function sessionKey(envKey: string | null | undefined): string {
  return envKey ? envKey : 'host';
}

/** 确保某线有会话槽（缺则补 emptySession；已有则原样返回引用）。 */
export function ensureSessionSlot(
  sessions: Record<string, SessionState>,
  key: string,
): Record<string, SessionState> {
  if (sessions[key]) return sessions;
  return { ...sessions, [key]: emptySession() };
}

export interface SwitchPlan {
  sessions: Record<string, SessionState>;
  envKey: string | null;
  /** false = 目标线已是激活线（调用方免重连/免 server environment/select）。 */
  changed: boolean;
}

/**
 * 切换计划：目标线 = 当前线 → 无操作（changed=false）；否则确保目标线有
 * 槽位并换激活指针。**不丢任何线的本地状态**——旧激活线原样保留在
 * sessions 里，切回来时重连 replay 续上（未完成渲染的流由 chat:init
 * resync 保留壳，见 reducer.ts）。
 */
export function planSwitch(
  currentEnvKey: string | null,
  sessions: Record<string, SessionState>,
  targetEnvKey: string | null,
): SwitchPlan {
  if (targetEnvKey === currentEnvKey) {
    return { sessions, envKey: currentEnvKey, changed: false };
  }
  return {
    sessions: ensureSessionSlot(sessions, sessionKey(targetEnvKey)),
    envKey: targetEnvKey,
    changed: true,
  };
}
