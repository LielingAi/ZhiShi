/**
 * gate (plan §2.11, design §7.1). The entry decision: choose or create an
 * environment. DATA + MODEL only — rendering lives in chrome.ts/app.ts so the
 * gate shares the session's visual system (the old gate painted its own
 * styleless full-screen clears; that era is over).
 *
 * Groups (design §7.1 + D28):
 *   running    已注册且运行中
 *   stopped    已注册未运行
 *   discovered 本机已有（未注册）— 选中即注册
 *   recipe     新建环境（选类型）
 *
 * Data degradation: any single admin path failing degrades to empty — the
 * screen never blocks on one bad source.
 *
 * Commit semantics: environment/select is the ONLY persistence ({workspace,
 * selection} — the workspace arg was missing in the first cut, so selections
 * silently never landed). Registered-but-stopped envs get a best-effort
 * environment/up (recipe-name match); failure is reported, not hidden.
 */

import type { SidecarClient } from '../client';

export interface GateOption {
  key: string;
  group: 'running' | 'stopped' | 'discovered' | 'recipe' | 'manual';
  label: string;
  detail: string;
  disabled: boolean;
  disabledReason?: string;
  envId?: string;
  envKind?: string;
  recipeId?: string;
  discoveredKind?: 'docker' | 'vm';
  discoveredDocker?: { id: string; name: string; image: string; status: string; managed: boolean };
  discoveredVm?: { driver: 'vmware' | 'hyperv' | 'vbox'; id: string; name: string; vmx?: string; state: string; osFamily?: 'linux' | 'windows' };
}

export interface GateResult {
  kind: 'env';
  id: string;
  envKind?: string;
  /** Non-fatal notes from the commit path (e.g. best-effort up failed). */
  warnings: string[];
}

interface EnvEntry {
  id: string;
  kind: string;
  user?: string;
  host?: string;
  container?: string;
  vmx?: string;
  vmName?: string;
  recipeId?: string;
}

interface PsInstance {
  name: string;
  recipe?: string;
  status?: string;
}

export interface GateData {
  environments: EnvEntry[];
  instances: PsInstance[];
  recipes: { id: string; name: string; valid: boolean; description?: string; base?: string }[];
  dockerAvailable: boolean;
  dockerUnavailableReason?: string;
  discovered: {
    docker: Array<{ id: string; name: string; image: string; status: string; managed: boolean }>;
    vm: Array<{ driver: 'vmware' | 'hyperv' | 'vbox'; id: string; name: string; vmx?: string; state: string }>;
  };
}

function safe<T>(p: Promise<T>): Promise<T | null> {
  return p.then((r) => r).catch(() => null);
}

/** Gather gate data; any failure degrades to empty (never blocks the screen). */
export async function gatherGateData(client: SidecarClient): Promise<GateData> {
  const [listRes, psRes, recipesRes, enginesRes, discoverRes] = await Promise.all([
    safe(client.adminPost<{ data?: { environments?: EnvEntry[] } }>('environment/list', {})),
    safe(client.adminPost<{ data?: { instances?: PsInstance[] } }>('environment/ps', {})),
    safe(
      client.adminPost<{ data?: { recipes?: GateData['recipes'] } }>('environment/recipes', {}),
    ),
    safe(
      client.adminPost<{
        data?: { hasContainerEngine?: boolean; engines?: Array<{ kind?: string; guidance?: string }> };
      }>('environment/engines', {}),
    ),
    safe(client.discoverEnvironments()),
  ]);
  const report = enginesRes?.data;
  const dockerAvailable = report?.hasContainerEngine === true;
  return {
    environments: listRes?.data?.environments ?? [],
    instances: psRes?.data?.instances ?? [],
    recipes: (recipesRes?.data?.recipes ?? []).map((r) => ({ ...r, base: typeof (r as Record<string, unknown>).base === 'string' ? String((r as Record<string, unknown>).base) : undefined })),
    dockerAvailable,
    dockerUnavailableReason: dockerAvailable
      ? undefined
      : report?.engines?.find((e) => e.kind === 'docker')?.guidance ?? '未检测到容器引擎',
    discovered: discoverRes ?? { docker: [], vm: [] },
  };
}

function isLive(env: EnvEntry, instances: PsInstance[]): boolean {
  return instances.some(
    (i) => i.name === env.id || (env.container && i.name === env.container) || i.recipe === env.id,
  );
}

function envTag(e: EnvEntry): string {
  if (e.kind === 'ssh') return `ssh · ${e.user ? `${e.user}@` : ''}${e.host ?? '?'}`;
  if (e.kind === 'docker') return `docker · ${e.container ?? '?'}`;
  // vm：显示定位锚（vmx 文件名 / 主机），而不是重复一遍 "vm"。
  if (e.vmx) return `vm · ${e.vmx.split(/[\\/]/).pop()}`;
  if (e.host) return `vm · ${e.host}`;
  return 'vm';
}

export function buildGateOptions(data: GateData): GateOption[] {
  const options: GateOption[] = [];
  for (const e of data.environments) {
    const live = isLive(e, data.instances);
    // 配方绑定:recipeId 优先,回落 id/vmName 同名配方(老条目)——选环境时
    // 一眼知道它出自哪个配方、带哪些工具。
    const recipe = data.recipes.find(
      (r) => r.id === e.recipeId || r.id === e.id || r.id === e.vmName,
    );
    const binding = recipe ? ` · 类型 ${recipe.id}` : ' · 无类型绑定';
    options.push({
      key: `env:${e.id}`,
      group: live ? 'running' : 'stopped',
      label: e.id,
      detail: `${envTag(e)}${binding}`,
      disabled: false,
      envId: e.id,
      envKind: e.kind,
    });
  }
  // D28 本机已有（未注册）：从发现列表剔除已注册项。
  const registeredContainers = new Set(
    data.environments.filter((e) => e.kind === 'docker').map((e) => e.container),
  );
  const registeredVmx = new Set(
    data.environments.map((e) => e.vmx).filter((v): v is string => Boolean(v)),
  );
  const registeredIds = new Set(data.environments.map((e) => e.id));
  for (const d of data.discovered.docker) {
    if (d.managed || registeredContainers.has(d.name) || registeredContainers.has(d.id)) continue;
    options.push({
      key: `discovered-docker:${d.id}`,
      group: 'discovered',
      label: d.name,
      detail: `docker · ${d.image} · ${d.status}`,
      disabled: false,
      discoveredKind: 'docker',
      discoveredDocker: d,
    });
  }
  for (const v of data.discovered.vm) {
    if (registeredIds.has(v.id) || (v.vmx && registeredVmx.has(v.vmx))) continue;
    options.push({
      key: `discovered-vm:${v.id}`,
      group: 'discovered',
      label: v.name,
      detail: `${v.driver} · ${v.state}`,
      disabled: false,
      discoveredKind: 'vm',
      discoveredVm: v,
    });
  }
  for (const r of data.recipes) {
    if (!r.valid) continue;
    // 只有 docker 基底配方受 docker 缺失影响——VM 配方跑 hypervisor,
    // 本机有 VMware 就该能建(实测:没 Docker 时 VM 配方也被禁,正门没法建环境)。
    const reason = !data.dockerAvailable && r.base === 'docker' ? data.dockerUnavailableReason : undefined;
    options.push({
      key: `recipe:${r.id}`,
      group: 'recipe',
      label: `新建 ${r.name}`,
      detail: r.description ?? '',
      disabled: reason !== undefined,
      disabledReason: reason,
      recipeId: r.id,
    });
  }
  // 手动接入(已有机器的账号/密钥流程,D-T4 不落密码):
  options.push({
    key: 'manual:ssh',
    group: 'manual',
    label: '手动接入 SSH 主机…',
    detail: 'host / 用户 / 密钥路径（密码不走正门——keyPath 引用,D-T4）',
    disabled: false,
  });
  return options;
}

// ---------------------------------------------------------------------------
// Selection model (pure)
// ---------------------------------------------------------------------------

/** Move the cursor over enabled options, wrapping at the ends. */
export function moveGateCursor(options: GateOption[], cursor: number, delta: 1 | -1): number {
  const n = options.length;
  if (n === 0) return cursor;
  for (let s = 1; s <= n; s++) {
    const i = (((cursor + s * delta) % n) + n) % n;
    if (!options[i].disabled) return i;
  }
  return cursor;
}

export function firstEnabledIndex(options: GateOption[]): number {
  return options.findIndex((o) => !o.disabled);
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

async function selectEnv(
  client: SidecarClient,
  workspace: string,
  id: string,
): Promise<string | null> {
  const res = await safe(
    client.adminPost<{ success?: boolean; error?: string }>('environment/select', {
      workspace,
      selection: { kind: 'env', id },
    }),
  );
  return res && res.success === false ? (res.error ?? 'select failed') : null;
}

/** Resolve a chosen option: persist selection, boot what needs booting. */
export async function commitGate(
  client: SidecarClient,
  option: GateOption,
  workspace: string,
  onProgress?: (line: string) => void,
): Promise<GateResult> {
  const warnings: string[] = [];
  const note = (s: string): void => onProgress?.(s);

  if (option.recipeId) {
    note(`按环境类型构建环境 ${option.recipeId}…（首次构建需要几分钟）`);
    const res = await client.adminPost<{ success?: boolean; error?: string; data?: { instance?: { name?: string } } }>(
      'environment/up',
      { recipe: option.recipeId, workspace },
    );
    if (res.success === false) throw new Error(res.error ?? `环境 ${option.recipeId} 构建失败`);
    const id = res.data?.instance?.name ?? option.recipeId;
    const selErr = await selectEnv(client, workspace, id);
    if (selErr) throw new Error(selErr);
    return { kind: 'env', id, warnings };
  }

  if (option.discoveredKind === 'docker' && option.discoveredDocker) {
    const d = option.discoveredDocker;
    const id = `docker-${d.name}`;
    note(`登记本机容器 ${d.name}…`);
    const addRes = await safe(
      client.adminPost<{ success?: boolean; error?: string }>('environment/add', {
        id,
        kind: 'docker',
        container: d.name,
      }),
    );
    if (addRes?.success === false) warnings.push(addRes.error ?? '登记失败(可能已存在)');
    const selErr = await selectEnv(client, workspace, id);
    if (selErr) throw new Error(selErr);
    return { kind: 'env', id, envKind: 'docker', warnings };
  }

  if (option.discoveredKind === 'vm' && option.discoveredVm) {
    const v = option.discoveredVm;
    const id = `${v.driver}-${v.name}`;
    note(`登记本机虚拟机 ${v.name}…`);
    // kind 必须是合法 EnvironmentKind('vm')——driver(vmware/hyperv/vbox)是
    // 驱动细节不是 kind;kind=vm 还要求 vmName(注册表校验)。
    const addRes = await safe(
      client.adminPost<{ success?: boolean; error?: string }>('environment/add', {
        id,
        kind: 'vm',
        vmName: v.name,
        vmx: v.vmx,
        name: v.name,
        osFamily: v.osFamily,
      }),
    );
    if (addRes?.success === false) warnings.push(addRes.error ?? '登记失败(可能已存在)');
    const selErr = await selectEnv(client, workspace, id);
    if (selErr) throw new Error(selErr);
    return { kind: 'env', id, envKind: v.driver, warnings };
  }

  // 已注册环境：落盘选定；未运行的尽力拉起（同名为配方时有效），失败明示不隐藏。
  const id = option.envId!;
  const selErr = await selectEnv(client, workspace, id);
  if (selErr) throw new Error(selErr);
  if (option.group === 'stopped') {
    note(`拉起环境 ${id}…`);
    const up = await safe(
      client.adminPost<{ success?: boolean; error?: string }>('environment/up', {
        recipe: id,
        workspace,
      }),
    );
    if (!up || up.success === false) {
      warnings.push(`环境未能自动拉起（${up?.error ?? '无同名环境类型'}）——进入后可在 shell 手动启动`);
    }
  }
  return { kind: 'env', id, envKind: option.envKind, warnings };
}

/** Flag short-circuit: --env selects, --new-env builds; no screen. */
export async function resolveFlag(
  client: SidecarClient,
  workspace: string,
  envId: string | undefined,
  newEnvRecipe: string | undefined,
): Promise<GateResult | null> {
  if (envId) {
    const res = await safe(client.adminPost<{ data?: { environments?: EnvEntry[] } }>('environment/list', {}));
    const entry = (res?.data?.environments ?? []).find((e) => e.id === envId);
    if (!entry) throw new Error(`环境 "${envId}" 未登记（zhishi env list 查看）`);
    const selErr = await selectEnv(client, workspace, envId);
    if (selErr) throw new Error(selErr);
    return { kind: 'env', id: envId, envKind: entry.kind, warnings: [] };
  }
  if (newEnvRecipe) {
    const res = await client.adminPost<{ success?: boolean; error?: string; data?: { instance?: { name?: string } } }>(
      'environment/up',
      { recipe: newEnvRecipe, workspace },
    );
    if (res.success === false) throw new Error(res.error ?? `环境 ${newEnvRecipe} 构建失败`);
    const id = res.data?.instance?.name ?? newEnvRecipe;
    const selErr = await selectEnv(client, workspace, id);
    if (selErr) throw new Error(selErr);
    return { kind: 'env', id, warnings: [] };
  }
  return null;
}
