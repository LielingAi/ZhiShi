/**
 * 新建环境向导（1.3.7 场景 2，纯函数层）。
 *
 * D17 纪律：建只有人（来源与参数人确认）、一键发起（Step 4 一个按钮）、
 * 构建全自动（Step 4 直接调端点，复用 BootModal 轮询）、零动手（参数全
 * 带默认值可跳过）。
 *
 * 四步状态机：
 *   Step 1 选来源（docker 配方 / VM 配方 / 本机已有 / 手动 SSH）
 *   Step 2 按类型收参（全带默认值；校验只挡真必填）
 *   Step 3 确认页（基底/配方/工具清单/域绑定——domain/list 映射 recipe→domain）
 *   Step 4 执行（payload 构造见 buildWizardPayload；分发在 store）
 *
 * 端点形状已对齐 src/server/admin-api.ts（只读核实）：
 *   environment/up      { recipe, workspace?, vmBase?, user?, keyPath? }
 *   environment/add     registry 校验：id 限 [A-Za-z0-9][A-Za-z0-9._-]{0,63}，
 *                       ssh 必填 host；可选 name/user/keyPath/osFamily/recipeId/port(1-65535)
 *   environment/recipes data.recipes: EnvironmentRecipe（id/name/base/tools/vmUser…）
 *   domain/list         data.domains: [{ kind, name, recipes, skills, subagents, … }]
 */

import type { DiscoveredDocker, DiscoveredVm, Recipe, EnvEntry, PsInstance } from '../client/api';
import { matchRegisteredEnv, type DiscoveredLike, type EnvEntryLike } from './envs';

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

export type WizardSource = 'docker-recipe' | 'vm-recipe' | 'discovered' | 'ssh';

export interface WizardSourceCard {
  source: WizardSource;
  title: string;
  detail: string;
}

export const WIZARD_SOURCE_CARDS: WizardSourceCard[] = [
  { source: 'docker-recipe', title: 'Docker 配方构建', detail: '选配方 → environment/up 全自动构建容器' },
  { source: 'vm-recipe', title: 'VM 配方构建', detail: '选配方 + guest 凭据 → environment/up 起虚拟机' },
  { source: 'discovered', title: '接入本机已有', detail: 'discover 扫描结果勾选即登记（environment/add）' },
  { source: 'ssh', title: '手动 SSH', detail: 'host/用户/密钥 + 可选端口与配方绑定' },
];

export interface WizardParams {
  /** docker/vm 配方来源：选中的配方 id。 */
  recipeId: string;
  /** vm 配方：guest 用户（预填 recipe.vmUser）。 */
  vmUser: string;
  /** vm 配方：私钥路径。 */
  vmKeyPath: string;
  /** 本机已有：勾选的 discover 条目键（docker id / vm id）。 */
  discoveredKey: string;
  /** 本机已有（VM 条目）：guest 地址——exec/探测通道前提，登记 payload 附带。 */
  discoveredAddress: string;
  /** 本机已有：可选补充的 guest 用户（登记 payload 附带）。 */
  discoveredUser: string;
  /** 本机已有：可选补充的私钥路径（登记 payload 附带）。 */
  discoveredKeyPath: string;
  /** 本机已有：可选绑定的配方 id（决定域归属，登记 payload 附带）。 */
  discoveredRecipeId: string;
  sshHost: string;
  sshUser: string;
  sshKeyPath: string;
  /** 字符串表单值；payload 构造时转 number（空 = 缺省 22，不下发）。 */
  sshPort: string;
  sshName: string;
  sshOsFamily: '' | 'linux' | 'windows';
  /** SSH/本机已有可选绑定的配方（决定域归属）。 */
  sshRecipeId: string;
}

export interface EnvWizardState {
  step: 1 | 2 | 3 | 4;
  source: WizardSource | null;
  params: WizardParams;
}

export function initialWizardParams(): WizardParams {
  return {
    recipeId: '',
    vmUser: '',
    vmKeyPath: '',
    discoveredKey: '',
    discoveredAddress: '',
    discoveredUser: '',
    discoveredKeyPath: '',
    discoveredRecipeId: '',
    sshHost: '',
    sshUser: '',
    sshKeyPath: '',
    sshPort: '',
    sshName: '',
    sshOsFamily: '',
    sshRecipeId: '',
  };
}

export function initialWizardState(): EnvWizardState {
  return { step: 1, source: null, params: initialWizardParams() };
}

/** 来源对应的配方子集：docker 配方 = base 非 vm；VM 配方 = base === 'vm'。 */
export function recipesForSource(source: WizardSource, recipes: Recipe[]): Recipe[] {
  if (source === 'docker-recipe') return recipes.filter((r) => r.base !== 'vm');
  if (source === 'vm-recipe') return recipes.filter((r) => r.base === 'vm');
  return recipes;
}

/**
 * 选来源时的默认预填（零动手）：配方来源预填该类的第一个配方；
 * VM 配方顺带预填 vmUser（server 配方 frontmatter vm_user）。
 */
export function defaultParamsForSource(source: WizardSource, recipes: Recipe[]): Partial<WizardParams> {
  if (source === 'docker-recipe' || source === 'vm-recipe') {
    const list = recipesForSource(source, recipes);
    const first = list[0];
    return {
      recipeId: first?.id ?? '',
      vmUser: source === 'vm-recipe' ? first?.vmUser ?? '' : '',
    };
  }
  return {};
}

export function wizardSelectSource(state: EnvWizardState, source: WizardSource, recipes: Recipe[]): EnvWizardState {
  return {
    step: 2,
    source,
    params: { ...state.params, ...defaultParamsForSource(source, recipes) },
  };
}

/** 每步前进校验：返回错误文案，null = 可前进。 */
export function wizardStepError(state: EnvWizardState): string | null {
  if (state.step === 1) return state.source ? null : '请选择来源类型';
  if (state.step === 2) {
    const p = state.params;
    if (state.source === 'docker-recipe' || state.source === 'vm-recipe') {
      return p.recipeId ? null : '请选择一个配方';
    }
    if (state.source === 'discovered') return p.discoveredKey ? null : '请勾选一个本机条目';
    if (state.source === 'ssh') {
      if (!p.sshHost.trim() || !p.sshUser.trim() || !p.sshKeyPath.trim()) {
        return 'host / 用户 / 密钥路径 必填';
      }
      if (p.sshPort.trim()) {
        const port = Number(p.sshPort.trim());
        if (!Number.isInteger(port) || port < 1 || port > 65535) return '端口必须是 1-65535 的整数';
      }
    }
  }
  return null;
}

export function wizardNext(state: EnvWizardState): EnvWizardState {
  if (wizardStepError(state) !== null) return state;
  return { ...state, step: Math.min(4, state.step + 1) as EnvWizardState['step'] };
}

export function wizardBack(state: EnvWizardState): EnvWizardState {
  return { ...state, step: Math.max(1, state.step - 1) as EnvWizardState['step'] };
}

// ---------------------------------------------------------------------------
// 「本机已有」步骤的条目视图模型（1.3.7 实机修复 A/B）
// ---------------------------------------------------------------------------

export interface WizardDiscoveredItem {
  key: string;
  label: string;
  detail: string;
  /** VM 条目（补收 address/user/keyPath——exec 通道前提）；docker 不需要。 */
  isVm: boolean;
  /** 同族命中已登记环境（vmx/vmName/container，见 envs.matchRegisteredEnv）
   *  → 勾选禁用 + 行内标注，值 = 已登记条目展示名。 */
  registeredAs?: string;
}

/**
 * discover 两源（docker/VM）→ 向导勾选列表。已登记同族条目带 registeredAs
 * 标注且不可勾选（防 1.3.7 实机反馈的「同一 VM 两个身份」重复登记）。
 */
export function wizardDiscoveredItems(
  docker: DiscoveredDocker[],
  vm: DiscoveredVm[],
  envs: EnvEntryLike[],
): WizardDiscoveredItem[] {
  const rows: Array<{ like: DiscoveredLike; isVm: boolean; fallbackDetail: string }> = [
    ...docker.map((d) => ({
      like: { id: d.id, name: d.name, state: d.status, driver: 'docker' },
      isVm: false,
      fallbackDetail: `docker · ${d.status ?? 'unknown'}`,
    })),
    ...vm.map((v) => ({
      like: { id: v.id, name: v.name, state: v.state, driver: v.driver, vmx: v.vmx },
      isVm: true,
      fallbackDetail: `${v.driver} · ${v.state ?? 'unknown'}`,
    })),
  ];
  return rows.map(({ like, isVm, fallbackDetail }) => {
    const dup = matchRegisteredEnv(like, envs);
    return {
      key: like.id,
      label: like.name ?? like.id,
      detail: dup ? `${fallbackDetail} · 已登记为 ${dup.name ?? dup.id}` : fallbackDetail,
      isVm,
      registeredAs: dup ? (dup.name ?? dup.id) : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// payload 构造（Step 4 分发用）
// ---------------------------------------------------------------------------

export type WizardPayload =
  | { type: 'up'; input: { recipe: string; user?: string; keyPath?: string } }
  | {
      type: 'register';
      itemKey: string;
      /** registerDiscovered 的附加登记字段（address/user/keyPath/recipeId，全可选）。 */
      extras?: { address?: string; user?: string; keyPath?: string; recipeId?: string };
    }
  | {
      type: 'ssh-add';
      input: {
        id: string;
        kind: 'ssh';
        host: string;
        user?: string;
        keyPath?: string;
        port?: number;
        name?: string;
        osFamily?: 'linux' | 'windows';
        recipeId?: string;
      };
    };

/**
 * SSH 登记 id（server registry ID_PATTERN：字母数字开头 + [A-Za-z0-9._-]，≤64）。
 * 注意：旧入口的 `user@host` 含 '@' 会被服务端拒——这里净化为合法 id。
 */
export function buildSshEnvId(host: string, user: string): string {
  const raw = `ssh-${user}-${host}`.toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/-+/g, '-');
  // 注意：[.-_] 里 .-_ 是字符区间（46-95，含数字）——必须用 [-._]。
  const id = cleaned.replace(/[-._]+$/, '').slice(0, 64);
  // host/user 全是非法字符时只剩前缀 'ssh'——兜底一个合法 id。
  return id && id !== 'ssh' ? id : 'ssh-env';
}

/** 向导状态 → 端点载荷。前置校验失败（wizardStepError 非空）时返回 null。 */
export function buildWizardPayload(state: EnvWizardState): WizardPayload | null {
  if (state.step < 2 || !state.source) return null;
  const p = state.params;
  if (state.source === 'docker-recipe' || state.source === 'vm-recipe') {
    if (!p.recipeId) return null;
    return {
      type: 'up',
      input: {
        recipe: p.recipeId,
        ...(p.vmUser.trim() ? { user: p.vmUser.trim() } : {}),
        ...(p.vmKeyPath.trim() ? { keyPath: p.vmKeyPath.trim() } : {}),
      },
    };
  }
  if (state.source === 'discovered') {
    if (!p.discoveredKey) return null;
    const extras = {
      ...(p.discoveredAddress.trim() ? { address: p.discoveredAddress.trim() } : {}),
      ...(p.discoveredUser.trim() ? { user: p.discoveredUser.trim() } : {}),
      ...(p.discoveredKeyPath.trim() ? { keyPath: p.discoveredKeyPath.trim() } : {}),
      ...(p.discoveredRecipeId ? { recipeId: p.discoveredRecipeId } : {}),
    };
    return {
      type: 'register',
      itemKey: p.discoveredKey,
      ...(Object.keys(extras).length > 0 ? { extras } : {}),
    };
  }
  // ssh
  const host = p.sshHost.trim();
  const user = p.sshUser.trim();
  const keyPath = p.sshKeyPath.trim();
  if (!host || !user || !keyPath) return null;
  const port = p.sshPort.trim() ? Number(p.sshPort.trim()) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
  return {
    type: 'ssh-add',
    input: {
      id: buildSshEnvId(host, user),
      kind: 'ssh',
      host,
      user,
      keyPath,
      ...(port !== undefined ? { port } : {}),
      ...(p.sshName.trim() ? { name: p.sshName.trim() } : {}),
      ...(p.sshOsFamily ? { osFamily: p.sshOsFamily } : {}),
      ...(p.sshRecipeId ? { recipeId: p.sshRecipeId } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// 域映射 + 确认页
// ---------------------------------------------------------------------------

/** domain/list 的域条目（src/server/admin-api.ts::handleDomainList 实际形状）。 */
export interface DomainLike {
  kind: string;
  name: string;
  recipes: string[];
}

/** recipe → 域：domain.recipes 含该 recipeId 即归属；找不到 → null（确认页显「未绑定」）。 */
export function domainForRecipe(recipeId: string, domains: DomainLike[]): DomainLike | null {
  if (!recipeId) return null;
  return domains.find((d) => Array.isArray(d.recipes) && d.recipes.includes(recipeId)) ?? null;
}

export interface WizardSummaryRow {
  label: string;
  value: string;
}

/** 1.3.7 场景 3：确认页展示推导能力集合所需的最小条目形状。 */
export interface EnvCapabilityLike {
  id: string;
  name?: string;
  container?: string;
  vmName?: string;
  capabilityDomains?: string[];
  capabilityDerivedAt?: string;
}

/** 能力集合确认页行值：「binary · pentest（探测于 …）」。 */
function capabilityRowValue(e: EnvCapabilityLike): string {
  const when = e.capabilityDerivedAt ? `（探测于 ${e.capabilityDerivedAt}）` : '';
  return `${(e.capabilityDomains ?? []).join(' · ')}${when}`;
}

/** 已有环境（已登记条目）的推导能力集合行；未登记/未推导 → null（不出行）。 */
export function capabilityRowFor(
  match: (e: EnvCapabilityLike) => boolean,
  envs: EnvCapabilityLike[] | undefined,
): WizardSummaryRow | null {
  const hit = envs?.find(match);
  if (!hit?.capabilityDomains?.length) return null;
  return { label: '能力集合（推导）', value: capabilityRowValue(hit) };
}

/** Step 3 确认页行：基底/配方/工具清单/域绑定（拿不到域显示「未绑定」）。
 *  1.3.7 场景 3：新环境（配方来源）展示配方工具清单（静态）；已有环境
 *  （本机已有/手动 SSH 命中已登记条目）展示推导能力集合。 */
export function wizardSummaryRows(
  state: EnvWizardState,
  ctx: { recipes: Recipe[]; domains: DomainLike[]; envs?: EnvCapabilityLike[] },
): WizardSummaryRow[] {
  const rows: WizardSummaryRow[] = [];
  const card = WIZARD_SOURCE_CARDS.find((c) => c.source === state.source);
  rows.push({ label: '来源', value: card?.title ?? '—' });
  if (state.source === 'docker-recipe' || state.source === 'vm-recipe') {
    const recipe = ctx.recipes.find((r) => r.id === state.params.recipeId);
    rows.push({ label: '基底', value: state.source === 'vm-recipe' ? 'vm' : recipe?.base ?? 'docker' });
    rows.push({ label: '配方', value: state.params.recipeId || '—' });
    rows.push({ label: '工具清单', value: recipe?.tools.join(' · ') || '（无声明）' });
    if (state.source === 'vm-recipe') {
      if (state.params.vmUser.trim()) rows.push({ label: 'guest 用户', value: state.params.vmUser.trim() });
      if (state.params.vmKeyPath.trim()) rows.push({ label: '密钥路径', value: state.params.vmKeyPath.trim() });
    }
    const domain = domainForRecipe(state.params.recipeId, ctx.domains);
    rows.push({ label: '域绑定', value: domain ? `${domain.name}（${domain.kind}）` : '未绑定' });
  } else if (state.source === 'discovered') {
    rows.push({ label: '本机条目', value: state.params.discoveredKey || '—' });
    rows.push({ label: '动作', value: '登记入侧栏（environment/add）；运行中则自动切入' });
    const capRow = capabilityRowFor(
      (e) =>
        e.id === state.params.discoveredKey ||
        e.container === state.params.discoveredKey ||
        e.vmName === state.params.discoveredKey ||
        e.name === state.params.discoveredKey,
      ctx.envs,
    );
    if (capRow) rows.push(capRow);
    if (state.params.discoveredAddress.trim()) rows.push({ label: 'guest 地址', value: state.params.discoveredAddress.trim() });
    if (state.params.discoveredUser.trim()) rows.push({ label: 'guest 用户', value: state.params.discoveredUser.trim() });
    if (state.params.discoveredKeyPath.trim()) rows.push({ label: '密钥路径', value: state.params.discoveredKeyPath.trim() });
    if (state.params.discoveredRecipeId) rows.push({ label: '绑定配方', value: state.params.discoveredRecipeId });
    const domain = domainForRecipe(state.params.discoveredRecipeId, ctx.domains);
    rows.push({ label: '域绑定', value: domain ? `${domain.name}（${domain.kind}）` : '未绑定' });
  } else if (state.source === 'ssh') {
    const p = state.params;
    rows.push({ label: '主机', value: `${p.sshUser.trim()}@${p.sshHost.trim()}${p.sshPort.trim() ? `:${p.sshPort.trim()}` : ''}` });
    rows.push({ label: '密钥路径', value: p.sshKeyPath.trim() });
    const capRow = capabilityRowFor(
      (e) => e.id === buildSshEnvId(p.sshHost, p.sshUser),
      ctx.envs,
    );
    if (capRow) rows.push(capRow);
    if (p.sshName.trim()) rows.push({ label: '名称', value: p.sshName.trim() });
    if (p.sshOsFamily) rows.push({ label: 'OS 家族', value: p.sshOsFamily });
    if (p.sshRecipeId) {
      rows.push({ label: '绑定配方', value: p.sshRecipeId });
      const domain = domainForRecipe(p.sshRecipeId, ctx.domains);
      rows.push({ label: '域绑定', value: domain ? `${domain.name}（${domain.kind}）` : '未绑定' });
    } else {
      rows.push({ label: '域绑定', value: '未绑定' });
    }
  }
  return rows;
}

/**
 * boot（environment/up）完成后的自动切换目标：仅当环境运行中才切。
 * 1.3.7「实例即环境」：条目 id = 实例名（vmware = vmx stem），不再等于
 * recipe.id——匹配走条目的 recipeId 字段（up 回写时带入）。
 * 找不到运行中实例 → null（只入侧栏，不切换）。
 */
export function findRunningEnvForRecipe(
  recipeId: string,
  envs: EnvEntry[],
  running: PsInstance[],
): string | null {
  if (!recipeId) return null;
  const runningIds = new Set(running.map((r) => r.id));
  const entry = envs.find((e) => e.id === recipeId || e.recipeId === recipeId);
  if (entry && runningIds.has(entry.id)) return entry.id;
  if (runningIds.has(recipeId)) return recipeId;
  return null;
}
