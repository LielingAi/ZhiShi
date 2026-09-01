/**
 * 环境准入闸（1.3.1 ①，纯函数）。
 *
 * 侧栏三组的点击语义（三态判定唯一事实源：model/envs.ts::resolveEnvState，
 * 1.3.8 ②——本闸只消费它推导出的 group/startable 字段）：
 *   - 运行中（run）  → 放行切换（environment/select）
 *   - 已停止（stop） → 拦截：toast「环境未启动，先启动再进入」；
 *                      docker/vm 且绑定集合非空的条目额外提供「启动」
 *                      （environment/up { recipe }——VM/docker 都走它，
 *                      见 server/admin-api.ts handleEnvironmentUp）。
 *                      1.5.10：ssh 条目无启动语义，点击直接放行进入——
 *                      可达性问题在开环境/探测时由服务端报错。
 *   - 本机已有（unreg）→ 拦截：toast「未登记，请先在新建环境里接入」。
 *
 * 宿主会话显性化：currentEnvKey 为 null/'' 时状态栏 env 锚显示
 * 「宿主 · 未锚定环境」；启动恢复时 environment/current 的 selection
 * 经 selectionToGuiKey 映射成 GUI 侧键（host → null）。
 *
 * 纯函数：不 import store / React / client；单测逐分支断言。
 */

import type { SidebarEnvItem } from './envs';
import type { InitEnvAnchor } from './reducer';

export type { InitEnvAnchor };

// ---------------------------------------------------------------------------
// 准入判定
// ---------------------------------------------------------------------------

export type GateResult =
  | { allow: true }
  | { allow: false; reason: 'not-started'; canStart: boolean }
  | { allow: false; reason: 'unregistered' };

/** 侧栏条目点击前的准入判定（可切换性 + 启动按钮可见性）。 */
export function accessGate(item: SidebarEnvItem): GateResult {
  if (item.group === 'unreg') return { allow: false, reason: 'unregistered' };
  // 1.5.10：ssh 条目无启动语义（恒在「已停止」组、startable 恒 false）——
  // 点击直接放行进入，可达性问题由服务端在 select/探测时报，不再拦「先启动」。
  if (item.group === 'stop' && item.kind === 'ssh') return { allow: true };
  if (item.group === 'stop') {
    return { allow: false, reason: 'not-started', canStart: item.startable === true };
  }
  return { allow: true };
}

/** 拦截 toast 文案（与准入闸结果一一对应）。 */
export function gateToast(item: SidebarEnvItem, gate: Exclude<GateResult, { allow: true }>): string {
  // 1.5.10：镜像行无登记语义——点击提示走「启动为环境」而不是登记引导。
  if (gate.reason === 'unregistered' && item.kind === 'docker-image') {
    return '镜像无需登记——点「启动为环境」派生容器';
  }
  if (gate.reason === 'unregistered') return '未登记，请先在新建环境里接入';
  return '环境未启动，先启动再进入';
}

// ---------------------------------------------------------------------------
// 宿主锚显性化 / 启动恢复映射
// ---------------------------------------------------------------------------

/** 状态栏 env 锚文案：null/'' = 宿主（未锚定环境）。 */
export function hostAnchorLabel(currentEnvKey: string | null | undefined): string {
  if (currentEnvKey === null || currentEnvKey === undefined || currentEnvKey === '') {
    return '宿主 · 未锚定环境';
  }
  return currentEnvKey;
}

/** environment/current 的 selection 形状（服务端 environment/selection.ts）。 */
export interface CurrentSelection {
  kind?: string;
  id?: string;
  name?: string;
  instanceId?: string;
}

/**
 * 服务端 selection → GUI 侧会话键（null = host）。
 *   - { kind:'host' }                    → null
 *   - { kind:'env', id }                 → id
 *   - { kind:'recipe', name, instanceId} → instanceId（up 回写条目 id = 实例名）
 *   未知形状回落 null（宿主线），不猜。
 */
export function selectionToGuiKey(selection: CurrentSelection | null | undefined): string | null {
  if (!selection || typeof selection !== 'object') return null;
  if (selection.kind === 'host') return null;
  if (selection.kind === 'env' && typeof selection.id === 'string' && selection.id) {
    return selection.id;
  }
  if (
    selection.kind === 'recipe' &&
    typeof selection.instanceId === 'string' &&
    selection.instanceId
  ) {
    return selection.instanceId;
  }
  return null;
}

/** chat:init environment 锚（resolveSessionEnvAnchor 形状，1.3.2 任务二 #2；
 * 类型单点在 reducer.ts::InitEnvAnchor，这里只做键映射）。 */

/**
 * chat:init environment 锚 → GUI 侧会话键（null = host）。
 *   - null（host 会话）→ null
 *   - { kind:'env', id }      → id
 *   - { kind:'recipe', id }   → id（resolveSessionEnvAnchor 的 recipe.id
 *                               即 instanceId，与 selectionToGuiKey 同口径）
 *   未知形状回落 null（宿主线），不猜。
 */
export function initAnchorToGuiKey(anchor: InitEnvAnchor | null | undefined): string | null {
  if (!anchor || typeof anchor !== 'object') return null;
  if ((anchor.kind === 'env' || anchor.kind === 'recipe') && anchor.id) return anchor.id;
  return null;
}
