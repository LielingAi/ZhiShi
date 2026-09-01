/**
 * 侧栏快照归并（1.3.10，纯函数）。
 *
 * refreshSidebar 是 5 请求 Promise.allSettled 的全量快照，触发面 7 处
 * （init / 切环境 / 启停 / 删 / 绑定 / 能力刷新 / 构建完成……）。并发调用
 * 时旧轮结果后写会覆盖新轮快照——用代次令牌（照 @ 补全富化的 mentionGen
 * 模式）判定过期，过期即整体丢弃；字段级回退仍保留：单请求失败不清空
 * 旧数据（fulfilled 才覆盖对应字段）。
 *
 * 纯函数：不 import store / React / client 运行时；单测逐字段断言。
 */

import type {
  DiscoveredDocker,
  DiscoveredDockerImage,
  DiscoveredVm,
  DomainEntity,
  EnvEntry,
  PsInstance,
  Recipe,
} from '../client/api';

/** 侧栏五源快照（store 顶层状态里对应字段的形状）。
 *  1.5.10：discoveredImages = zhishi-env-* 镜像发现条目（discover 第三键）。 */
export interface SidebarSnapshot {
  envs: EnvEntry[];
  running: PsInstance[];
  discoveredDocker: DiscoveredDocker[];
  discoveredVm: DiscoveredVm[];
  discoveredImages: DiscoveredDockerImage[];
  recipes: Recipe[];
  domains: DomainEntity[];
}

/** 一轮刷新五个请求的 settled 结果（rejected → 字段缺省 = 回退旧值）。 */
export interface SidebarMergeResults {
  envs?: EnvEntry[];
  running?: PsInstance[];
  discover?: { docker: DiscoveredDocker[]; vm: DiscoveredVm[]; images?: DiscoveredDockerImage[] };
  recipes?: Recipe[];
  domains?: DomainEntity[];
}

/**
 * 代次校验 + 快照归并：token 过期（已有更新的刷新轮）→ 返回 null，调用方
 * 丢弃本轮全部结果；否则 fulfilled 字段覆盖、失败/缺失字段回退 prev。
 */
export function mergeSidebarSnapshot(
  token: number,
  latestToken: number,
  prev: SidebarSnapshot,
  results: SidebarMergeResults,
): SidebarSnapshot | null {
  if (token !== latestToken) return null;
  return {
    envs: results.envs ?? prev.envs,
    running: results.running ?? prev.running,
    discoveredDocker: results.discover?.docker ?? prev.discoveredDocker,
    discoveredVm: results.discover?.vm ?? prev.discoveredVm,
    // 1.5.10：镜像源独立归并（discover 请求整体失败时三键一起回退旧值）。
    discoveredImages: results.discover?.images ?? prev.discoveredImages,
    recipes: results.recipes ?? prev.recipes,
    domains: results.domains ?? prev.domains,
  };
}
