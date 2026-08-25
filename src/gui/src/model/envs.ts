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
  /** 配方 id（docker/vm up 回写的条目带它；启动按钮的 up 参数来源）。 */
  recipeId?: string;
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
  /** 1.3.5：vmware 的 vmx 绝对路径（登记 payload 用；hyperv/vbox 无）。 */
  vmx?: string;
  /** 1.3.5：guest OS 家族（登记 payload 用；缺省不传）。 */
  osFamily?: 'linux' | 'windows';
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
  /**
   * 1.3.1 ①：「启动」按钮可用 = 已登记且 docker/vm 且带 recipeId
   * （environment/up 按 recipe 幂等重 up，VM/docker 都走它）。
   */
  startable: boolean;
  /** 启动按钮的 up 配方（startable 时非空）。 */
  recipeId?: string;
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
      startable: false,
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
      // docker/vm 条目带 recipeId 才能 environment/up（ssh 条目无配方，不可启）。
      startable: (e.kind === 'docker' || e.kind === 'vm') && typeof e.recipeId === 'string' && e.recipeId !== '',
      recipeId: typeof e.recipeId === 'string' ? e.recipeId : undefined,
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
      startable: false,
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

// ---------------------------------------------------------------------------
// 1.3.5 ④：本机发现「选中即注册」——登记载荷构造（TUI gate.ts:262-298 同语义）
// ---------------------------------------------------------------------------

/** environment/add 的登记载荷（kind 与必填字段对齐 server registry 校验）。 */
export type RegisterInput =
  | { id: string; kind: 'docker'; container: string }
  | { id: string; kind: 'vm'; vmName: string; vmx?: string; name?: string; osFamily?: 'linux' | 'windows' };

/**
 * 本机发现条目 → environment/add 载荷。登记 id 口径与 TUI 一致：
 *   docker        → `docker-<容器名>`  { kind:'docker', container }
 *   vmware/hyperv/vbox → `<driver>-<名>` { kind:'vm', vmName, vmx?, osFamily? }
 * 名字缺失 / 驱动未知 → null（调用方 toast 提示）。
 */
export function buildRegisterPayload(d: DiscoveredLike): RegisterInput | null {
  const name = d.name?.trim();
  if (!name) return null;
  if (d.driver === 'docker') {
    return { id: `docker-${name}`, kind: 'docker', container: name };
  }
  if (d.driver === 'vmware') {
    return {
      id: `vmware-${name}`,
      kind: 'vm',
      vmName: name,
      ...(d.vmx ? { vmx: d.vmx } : {}),
      name,
      ...(d.osFamily ? { osFamily: d.osFamily } : {}),
    };
  }
  if (d.driver === 'hyperv' || d.driver === 'vbox') {
    return {
      id: `${d.driver}-${name}`,
      kind: 'vm',
      vmName: name,
      name,
      ...(d.osFamily ? { osFamily: d.osFamily } : {}),
    };
  }
  return null;
}

/**
 * 登记后是否尝试直接切入：docker 状态含 'up'（如 "Up 3 hours"）、
 * VM state 为 running 才算在跑（vmware discover 恒 unknown → 不切）。
 */
export function isDiscoveredRunning(d: DiscoveredLike): boolean {
  const s = (d.state ?? '').toLowerCase();
  return s.includes('up') || s.includes('running');
}

// ---------------------------------------------------------------------------
// 1.3.1 ⑤：boot 进度阶段（纯文案；进度推进由 store 轮询 environment/ps）
// ---------------------------------------------------------------------------

/**
 * environment/up 的阶段清单。服务端 up 是同步长请求（无阶段推送），
 * GUI 靠轮询 environment/ps 观察实例是否出现来推进阶段：
 *   - 实例未现 → 阶段停在「启动/构建」
 *   - 实例出现 → 跳到「工具自检」
 *   - 请求返回成功 → 全部完成
 */
export function bootStages(base: string | undefined): string[] {
  return base === 'vm'
    ? ['解析配方与模板', '启动 VM（vmrun start）', '等待 SSH 就绪', '工具自检', '回写环境条目']
    : ['解析配方与镜像', '构建容器（docker build）', '启动容器', '工具自检', '回写环境条目'];
}
