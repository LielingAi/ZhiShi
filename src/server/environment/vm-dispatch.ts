/**
 * 安全研究员版 P2 B3 — VM 驱动分发纯函数.
 *
 * vm 配方按 frontmatter `vm_engine`（缺省 vmware）分发到三个生命周期驱动：
 * vmware（vm-lifecycle.ts，vmrun）/ hyperv（hyperv-lifecycle.ts，PowerShell）
 * / vbox（vbox-lifecycle.ts，VBoxManage）。down/rm 的目标路由同样引擎无关：
 * 按「vmware 实例目录命中 → Hyper-V 名字命中 → VirtualBox 名字命中 →
 * docker 兜底」的固定顺序裁定，探测结果由调用方（admin-api）以容错方式
 * 收集后传入，本模块不碰任何 I/O。
 */

import type { EnvironmentRecipe } from './recipes';

export type VmDriverKind = 'vmware' | 'hyperv' | 'vbox';

/** vm 配方 → 驱动。frontmatter 缺省 vmware（历史行为不变）。 */
export function resolveVmDriver(recipe: Pick<EnvironmentRecipe, 'vmEngine'>): VmDriverKind {
  if (recipe.vmEngine === 'hyperv') return 'hyperv';
  if (recipe.vmEngine === 'virtualbox') return 'vbox';
  return 'vmware';
}

export type DownRouteTarget = VmDriverKind | 'docker';

/** down/rm 路由所需的探测结果（调用方容错收集：引擎没装 → false）。 */
export interface VmRouteProbes {
  /** id 以 .vmx 结尾（直停），或登记条目 kind=vm 且带 vmx（D22 直连）。 */
  vmwareInstance: boolean;
  /** Hyper-V 里存在名为 id 的 VM（Get-VM 命中）。 */
  hypervVm: boolean;
  /** VirtualBox 里存在名为 id 的 VM（showvminfo 命中）。 */
  vboxVm: boolean;
}

/**
 * down/rm 目标路由：vmware → hyperv → vbox → docker 兜底。优先级固定——
 * 三个 VM 引擎的命名空间理论上可撞名（都允许 zhishi-<recipe>-<shortid>），
 * 撞名时按探测顺序先到先得，与 ps 的列出顺序一致。
 */
export function routeVmTarget(probes: VmRouteProbes): DownRouteTarget {
  if (probes.vmwareInstance) return 'vmware';
  if (probes.hypervVm) return 'hyperv';
  if (probes.vboxVm) return 'vbox';
  return 'docker';
}
