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
 *   本机已有 = discover 出来的、未登记（不在 list 里）的本机容器/VM；
 *              1.3.7 实机修复 A：id 之外再按 vmx/vmName/container 同族匹配——
 *              命中已登记条目的带 registeredAs 徽章（不可重复登记）
 */

export interface EnvEntryLike {
  id: string;
  kind?: string;
  name?: string;
  /** docker 条目的容器名（1.3.7 实机修复：本机发现去重的 docker 匹配键）。 */
  container?: string;
  /** vm 条目的 VM 名（1.3.7 实机修复：本机发现去重的 vmName 匹配键）。 */
  vmName?: string;
  /** vmware 条目的 vmx 路径（删除确认的驱动判定：有 vmx = 只摘登记）。 */
  vmx?: string;
  /** 配方 id（docker/vm up 回写的条目带它；启动按钮的 up 参数来源）。 */
  recipeId?: string;
  /** 1.3.7 场景 3：服务端现场推导的能力域集合（配方绑定域 ∪ 工具探测域）。 */
  capabilityDomains?: string[];
  /** capabilityDomains 的推导时间（ISO）。 */
  capabilityDerivedAt?: string;
  /** 1.4.9：能力集合内工具口径（服务端 environment/list 装饰）——
   *  total = 集合内配方工具总数；missing = 声明了但环境里没有的清单。 */
  capabilityTools?: { total: number; missing: string[] };
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
  /** vmware 条目的 vmx 路径（删除确认文案的驱动判定入参，见 model/env-remove）。 */
  vmx?: string;
  /**
   * 1.3.7 实机修复 A：该发现条目命中已登记环境（同 vmx/vmName/container）。
   * 命中后行内显「已登记为 X」徽章、不再出「登记」按钮；点击改为切入已登记条目。
   */
  registeredAs?: { key: string; label: string };
  /** 1.3.7 场景 3：现场推导的能力集合（透明展示，无声明 UI）。
   *  1.4.9：带集合内工具口径（在场/缺失——缺失是「补齐环境」入口的依据）。 */
  capability?: { domains: string[]; derivedAt?: string; toolsTotal?: number; toolsMissing?: string[] };
}

export interface SidebarGroup {
  label: '运行中' | '已停止' | '本机已有';
  items: SidebarEnvItem[];
}

/** 条目 → 能力集合（1.3.7 场景 3：无字段 = 未推导过，不是空集合）。 */
function capabilityOf(e: EnvEntryLike | undefined): SidebarEnvItem['capability'] {
  return e?.capabilityDomains?.length
    ? {
        domains: e.capabilityDomains,
        derivedAt: e.capabilityDerivedAt,
        ...(e.capabilityTools
          ? { toolsTotal: e.capabilityTools.total, toolsMissing: e.capabilityTools.missing }
          : {}),
      }
    : undefined;
}

/** 能力徽章文案（侧栏行内短形态——最多 2 个域 + 「+N」，行内不挤环境名）。
 *  1.4.9：有缺失时带「缺 N」缺口标记（名实分离的可视面）。 */
export function capabilityBadgeText(cap: NonNullable<SidebarEnvItem['capability']>): string {
  const domains = cap.domains;
  const shown = domains.slice(0, 2).join(' · ');
  const base = domains.length > 2 ? `能力：${shown} +${domains.length - 2}` : `能力：${shown}`;
  const miss = cap.toolsMissing?.length ?? 0;
  return miss > 0 ? `${base} · 缺${miss}` : base;
}

/** 能力徽章 tooltip（完整列表 + 推导时间与来源说明 + 在场/缺失明细）。 */
export function capabilityTooltip(cap: NonNullable<SidebarEnvItem['capability']>): string {
  const when = cap.derivedAt ? `，探测于 ${cap.derivedAt}` : '';
  const base = `能力：${cap.domains.join(' · ')}（现场推导：配方绑定 ∪ 工具探测${when}）`;
  if (cap.toolsTotal === undefined) return base;
  const present = cap.toolsTotal - (cap.toolsMissing?.length ?? 0);
  const missing = cap.toolsMissing?.length
    ? `\n声明了但环境里没有（${cap.toolsMissing.length}）：${cap.toolsMissing.join('、')}——可用「⋯ → 补齐环境」安装`
    : '';
  return `${base}\n工具在场 ${present}/${cap.toolsTotal}${missing}`;
}

/**
 * 1.3.7 实机修复 A：本机发现条目 ↔ 已登记环境 的同族匹配。
 *
 * 实机症状：同一台 VM 在侧栏出现两个身份（已登记的 fuzz 与 discover 出的
 * vmware-fuzz.vmx）——discover id 与登记 id 口径不同，单靠 id 去重漏判。
 * 匹配规则（按序，任一命中即算同族）：
 *   1. vmx 路径归一化相等（反斜杠→正斜杠、忽略大小写、去尾部分隔符）
 *   2. VM 名相等（vmware 的 discover name 是 vmx 文件名 → 去 .vmx 取 stem，
 *      大小写不敏感——hypervisor 的 VM 名本身不分大小写）
 *   3. docker 容器名相等（entry.container === discovered.name，精确匹配）
 *   4. id 精确相等（与 groupSidebar 既有去重口径一致，兜底）
 * 返回命中的已登记条目；无命中 → null。
 */
export function matchRegisteredEnv(
  d: DiscoveredLike,
  registeredEnvs: EnvEntryLike[],
): EnvEntryLike | null {
  const dVmx = d.vmx ? normalizeVmxPath(d.vmx) : '';
  const dVmName = d.driver === 'vmware' || d.driver === 'hyperv' || d.driver === 'vbox'
    ? vmNameOf(d).toLowerCase()
    : '';
  const dContainer = d.driver === 'docker' ? (d.name?.trim() ?? '') : '';
  for (const e of registeredEnvs) {
    if (dVmx && e.vmx && normalizeVmxPath(e.vmx) === dVmx) return e;
    if (dVmName && e.vmName && e.vmName.toLowerCase() === dVmName) return e;
    if (dContainer && e.container === dContainer) return e;
    if (e.id === d.id) return e;
  }
  return null;
}

/** vmx 路径归一化：`\`→`/`、全小写、去尾部 `/`（Windows 路径比较用）。 */
function normalizeVmxPath(p: string): string {
  return p.trim().replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

/**
 * ps 行 ↔ 登记条目的匹配键（1.3.8 B1 统一消费点）。
 * 主键：id 相等——服务端已把 docker 行 id 归一为登记条目 id（容器名），
 * ps 行与条目同一身份。兜底：docker 行 name = 容器名 === entry.container
 * （兼容归一前的短 id 行），不再让同一 docker 环境裂成「运行中短 id 行 +
 * 已停止条目行」双身份。
 */
export function psRowMatchesEntry(row: PsInstanceLike, entry: EnvEntryLike): boolean {
  if (row.id === entry.id) return true;
  return entry.kind === 'docker' && !!entry.container && row.name === entry.container;
}

// ---------------------------------------------------------------------------
// 1.3.8 ②：三态判定统一——每环境的唯一状态判定收口为单点纯函数。
// 三源输入（登记条目 / ps 运行实例 / discover 本机已有）→ 一个状态输出：
//   running      已登记且 ps 里有同 id 实例
//   stopped      已登记但不在 ps（子状态 startable：docker/vm + recipeId 可 up）
//   unregistered 未登记的本机发现条目（子状态 registeredAs 同族已登记 / localStopped）
// 消费方：groupSidebar（侧栏）、wizardDiscoveredItems（向导）；准入闸读的是
// 由本函数推导出的 group/startable/registeredAs 字段（见 access-gate.ts）。
// ---------------------------------------------------------------------------

/** 环境身份：登记条目与本机发现条目恰给一个。 */
export interface EnvStateIdentity {
  entry?: EnvEntryLike;
  discovered?: DiscoveredLike;
}

export interface ResolvedEnvState {
  state: 'running' | 'stopped' | 'unregistered';
  /** stopped 子状态：可 environment/up 启动（docker/vm 且带 recipeId）。 */
  startable: boolean;
  /** unregistered 子状态：同族命中已登记条目（vmx/vmName/container/id）。 */
  registeredAs?: { key: string; label: string };
  /** unregistered 子状态：本机条目处于停止态（exit/powered/saved）。 */
  localStopped?: boolean;
}

export function resolveEnvState(
  identity: EnvStateIdentity,
  psRows: PsInstanceLike[],
  registeredEnvs: EnvEntryLike[],
): ResolvedEnvState {
  if (identity.entry) {
    const e = identity.entry;
    if (psRows.some((r) => psRowMatchesEntry(r, e))) return { state: 'running', startable: false };
    return {
      state: 'stopped',
      startable:
        (e.kind === 'docker' || e.kind === 'vm') &&
        typeof e.recipeId === 'string' &&
        e.recipeId !== '',
    };
  }
  const d = identity.discovered;
  if (!d) return { state: 'unregistered', startable: false }; // 防御：空身份
  const dup = matchRegisteredEnv(d, registeredEnvs);
  const s = (d.state ?? '').toLowerCase();
  const localStopped = s.includes('exit') || s.includes('powered') || s.includes('saved');
  return {
    state: 'unregistered',
    startable: false,
    registeredAs: dup ? { key: dup.id, label: dup.name ?? dup.id } : undefined,
    localStopped,
  };
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
    const entry = envs.find((e) => psRowMatchesEntry(inst, e));
    runItems.push({
      // 1.3.8 B1：命中登记条目时 key 归一为条目 id（environment/select
      // 只认登记 id；短 id 行切入会落悬空 selection）。
      key: entry?.id ?? inst.id,
      label: inst.name ?? entry?.name ?? inst.id,
      group: 'run',
      detail: `${inst.driver ?? 'env'} · 运行中`,
      kind: inst.driver ?? entry?.kind ?? 'env',
      warn: false,
      startable: false,
      vmx: entry?.vmx,
      capability: capabilityOf(entry),
    });
  }

  const stopItems: SidebarEnvItem[] = [];
  for (const e of envs) {
    // 1.3.8 ②：状态判定走 resolveEnvState 单点（running 的在上方 ps 循环已入组）。
    const st = resolveEnvState({ entry: e }, running, envs);
    if (st.state !== 'stopped') continue;
    stopItems.push({
      key: e.id,
      label: e.name ?? e.id,
      group: 'stop',
      detail: `${e.kind ?? 'env'} · 已停止`,
      kind: e.kind ?? 'env',
      warn: false,
      // docker/vm 条目带 recipeId 才能 environment/up（ssh 条目无配方，不可启）。
      startable: st.startable,
      recipeId: typeof e.recipeId === 'string' ? e.recipeId : undefined,
      vmx: e.vmx,
      capability: capabilityOf(e),
    });
  }

  const unregItems: SidebarEnvItem[] = [];
  for (const d of discovered) {
    if (registeredIds.has(d.id)) continue;
    // 1.3.8 ②：同族匹配 + 停止态判定收口进 resolveEnvState——
    // 已登记的同族条目显徽章、不再出「登记」按钮，防重复登记。
    const st = resolveEnvState({ discovered: d }, running, envs);
    unregItems.push({
      key: d.id,
      label: d.name ?? d.id,
      group: 'unreg',
      detail: st.registeredAs
        ? `${d.driver ?? 'unknown'} · 已登记为 ${st.registeredAs.label}`
        : `${d.driver ?? 'unknown'} · 未登记${st.localStopped ? '（停止）' : ''}`,
      kind: d.driver ?? 'unknown',
      warn: false,
      startable: false,
      registeredAs: st.registeredAs,
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
// 1.3.5 ④：本机发现「选中即注册」——登记载荷构造
// （1.3.7 起 id 口径与服务端「实例即环境」统一；TUI 冻结，不再对齐它）
// ---------------------------------------------------------------------------

/** environment/add 的登记载荷（kind 与必填字段对齐 server registry 校验）。 */
export type RegisterInput =
  | { id: string; kind: 'docker'; container: string; user?: string; keyPath?: string; recipeId?: string }
  | {
      id: string;
      kind: 'vm';
      vmName: string;
      vmx?: string;
      name?: string;
      osFamily?: 'linux' | 'windows';
      /** 1.3.7 实机修复 B：guest 地址（exec 通道前提；缺了探测走不通）。 */
      address?: string;
      user?: string;
      keyPath?: string;
      recipeId?: string;
    };

/** 1.3.7 向导：登记时可选附加字段（绑定配方/凭据/连通地址，全可选，空不下发）。 */
export interface RegisterExtras {
  /** guest 地址——仅 VM 条目下发（docker 走容器通道，不需要）。 */
  address?: string;
  user?: string;
  keyPath?: string;
  recipeId?: string;
}

/**
 * 条目 id 合法化（server registry ID_PATTERN：字母数字开头 + [A-Za-z0-9._-]，
 * ≤64）——VM 名可含空格等非法字符，id 净化后下发，vmName 保留原名。
 * 净化后为空 → ''（调用方视为无法登记）。
 */
export function sanitizeEnvId(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[-._]+$/, '')
    .slice(0, 64);
}

/** vmware discover 的 name 是 vmx 文件名（带 .vmx 后缀）→ VM 名 = 文件 stem。 */
function vmNameOf(d: DiscoveredLike): string {
  const raw = d.name?.trim() ?? '';
  return d.driver === 'vmware' ? raw.replace(/\.vmx$/i, '') : raw;
}

/**
 * 本机发现条目 → environment/add 载荷。登记 id 口径（1.3.7「实例即环境」，
 * 与服务端统一语义对齐）：
 *   docker             → `docker-<容器名>`    { kind:'docker', container }
 *   vmware/hyperv/vbox → `<vmName>`（净化后） { kind:'vm', vmName, vmx?, osFamily? }
 * 名字缺失 / 驱动未知 / id 净化为空 → null（调用方 toast 提示）。
 * 1.3.7：extras（user/keyPath/recipeId）可选附加，逐字段空值剔除；
 * 1.3.7 实机修复 B：extras.address 仅 VM 分支透传（docker 不需要）。
 */
export function buildRegisterPayload(d: DiscoveredLike, extras?: RegisterExtras): RegisterInput | null {
  // address 不进公共 extraFields——docker 条目走容器通道，address 只对 VM 有意义
  //（vm 分支单独透传，防 docker 载荷带上语义无解的字段）。
  const extraFields = extras
    ? {
        ...(extras.user ? { user: extras.user } : {}),
        ...(extras.keyPath ? { keyPath: extras.keyPath } : {}),
        ...(extras.recipeId ? { recipeId: extras.recipeId } : {}),
      }
    : {};
  const name = d.name?.trim();
  if (!name) return null;
  if (d.driver === 'docker') {
    return { id: `docker-${name}`, kind: 'docker', container: name, ...extraFields };
  }
  if (d.driver === 'vmware' || d.driver === 'hyperv' || d.driver === 'vbox') {
    const vmName = vmNameOf(d);
    const id = sanitizeEnvId(vmName);
    if (!vmName || !id) return null;
    return {
      id,
      kind: 'vm',
      vmName,
      ...(d.driver === 'vmware' && d.vmx ? { vmx: d.vmx } : {}),
      name: vmName,
      ...(d.osFamily ? { osFamily: d.osFamily } : {}),
      // 1.3.7 实机修复 B：address 是 exec/探测通道前提，登记时一并收下。
      ...(extras?.address ? { address: extras.address } : {}),
      ...extraFields,
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
