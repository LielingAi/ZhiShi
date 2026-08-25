/**
 * 环境侧栏分组（纯函数）。
 *
 * 数据源（三个 admin 接口，纯读）：
 *   - environment/list   → 已登记环境条目（EnvironmentEntry：id/kind/…）
 *   - environment/ps     → 运行中实例（docker/vm/hyperv/vbox，status 字段）
 *   - environment/discover → 本机已有（docker 全量含已退出 + 各 hypervisor VM）
 *
 * 三组语义（照 v19）：
 *   运行中   = ps 里 status=running 的实例（优先用登记条目的名字）
 *   已停止   = 已登记但不在运行中的条目
 *   本机已有 = discover 出来的、未登记（不在 list 里）的本机容器/VM
 */

export interface EnvEntryLike {
  id: string;
  kind?: string;
  name?: string;
}

export interface PsInstanceLike {
  id: string;
  name?: string;
  status?: string;
  driver?: string;
}

export interface DiscoveredLike {
  id: string;
  name?: string;
  state?: string;
  driver?: string;
}

export interface SidebarEnvItem {
  key: string;
  label: string;
  /** run / stop / unreg（对应 v19 的状态点颜色与分组语义）。 */
  group: 'run' | 'stop' | 'unreg';
  detail: string;
  kind: string;
  /** 运行中 VM 的警告（不可达等）——MVP 从 state 推导，缺省 false。 */
  warn: boolean;
}

export interface SidebarGroup {
  label: '运行中' | '已停止' | '本机已有';
  items: SidebarEnvItem[];
}

export function groupSidebar(
  envs: EnvEntryLike[],
  running: PsInstanceLike[],
  discovered: DiscoveredLike[],
): SidebarGroup[] {
  const registeredIds = new Set(envs.map((e) => e.id));
  const runningIds = new Set<string>();

  const runItems: SidebarEnvItem[] = [];
  for (const inst of running) {
    if (!inst.id) continue;
    runningIds.add(inst.id);
    const entry = envs.find((e) => e.id === inst.id);
    runItems.push({
      key: inst.id,
      label: inst.name ?? entry?.name ?? inst.id,
      group: 'run',
      detail: `${inst.driver ?? 'env'} · 运行中`,
      kind: inst.driver ?? entry?.kind ?? 'env',
      warn: false,
    });
  }

  const stopItems: SidebarEnvItem[] = [];
  for (const e of envs) {
    if (runningIds.has(e.id)) continue;
    stopItems.push({
      key: e.id,
      label: e.name ?? e.id,
      group: 'stop',
      detail: `${e.kind ?? 'env'} · 已停止`,
      kind: e.kind ?? 'env',
      warn: false,
    });
  }

  const unregItems: SidebarEnvItem[] = [];
  for (const d of discovered) {
    if (registeredIds.has(d.id)) continue;
    const state = (d.state ?? '').toLowerCase();
    const stopped = state.includes('exit') || state.includes('powered') || state.includes('saved');
    unregItems.push({
      key: d.id,
      label: d.name ?? d.id,
      group: 'unreg',
      detail: `${d.driver ?? 'unknown'} · 未登记${stopped ? '（停止）' : ''}`,
      kind: d.driver ?? 'unknown',
      warn: false,
    });
  }

  const groups: SidebarGroup[] = [
    { label: '运行中', items: runItems },
    { label: '已停止', items: stopItems },
    { label: '本机已有', items: unregItems },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** 侧栏条目是否可切换（unreg 组不可切换——未登记，点了只提示）。 */
export function isSwitchable(item: SidebarEnvItem): boolean {
  return item.group !== 'unreg';
}
