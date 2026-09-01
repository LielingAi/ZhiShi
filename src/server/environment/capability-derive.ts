/**
 * 1.3.7 场景 3 — 环境能力集合的现场推导（B 方案：纯系统推导，域不进用户界面）。
 *
 * 「一个环境承载多个能力」＝环境的能力集合由现场推导，用户不声明、不维护：
 *
 *   能力集合 = 配方绑定域 ∪ 工具探测域
 *
 *   - 配方绑定域：条目 recipeId（回落 id/vmName 同名配方，与能力清单段同一
 *     规则）→ domain.json recipes 反查。绑定是构建来源，恒在集合，不需要
 *     探测证据。
 *   - 工具探测域：探测面 = 全部 valid 配方 tools 的并集（去重），对环境跑
 *     一条批量探测命令（复用 recipes.ts 的 buildToolCheckScript 探测协议：
 *     每行 OK:<工具> / MISS:<工具>），命中的工具经「工具 → 域」反推表
 *     （全部配方 tools[] × domain.json recipes）归并出域集合。
 *
 * 落盘：EnvironmentEntry.capabilityDomains / capabilityDerivedAt（服务端派生，
 * 非用户编辑）。探测失败（ssh 不通 / docker 死了 / 通道报错）→ 返回 undefined，
 * 调用方不写能力字段（保 baseline 行为），也绝不误判空集合。
 * 1.5.7：capabilityPending（已登记待装 = 配方 firstRunTools 声明首跑安装、
 * 探测未命中的工具）随探测闭环——missing 减去 pending 不双计数，探测命中
 * 的首跑工具从 pending 摘除。
 *
 * 结构照 recipes.ts：反推表 / 探测面 / 解析 / 合并是纯函数（可单测）；
 * probeEnvironmentCapabilities 是唯一 IO（exec 可注入，测试不碰真实通道）。
 */

import type { EnvironmentEntry } from '../../shared/config-types';
import type { DomainManifest } from '../../shared/domain-manifest';
import { buildToolCheckScript } from './recipes';
import type { EnvironmentRecipe } from './recipes';

/** 能力探测的执行通道签名（与 env-exec 的 execInEnvironment 同形的最小子集；
 *  失败分支允许不带 stdout）。1.4.9：补上 exitCode/stderr 可选字段——
 *  execInEnvironment 本就返回它们，provision 链路（environment/setup）复用
 *  同一通道时要靠 exitCode 判脚本成败。 */
export type CapabilityExecFn = (
  entry: EnvironmentEntry,
  script: string,
  opts: { timeoutMs: number },
) => Promise<{ ok: boolean; stdout?: string; stderr?: string; exitCode?: number }>;

/** 能力探测超时：探测面是全配方工具并集（远宽于单配方 toolCheck），给足余量。 */
export const CAPABILITY_PROBE_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// 纯函数 — 工具 → 域反推
// ---------------------------------------------------------------------------

/** recipe id → 引用它的域 kind 列表（按 manifests 顺序，去重）。 */
export function buildRecipeDomainMap(
  manifests: readonly DomainManifest[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const m of manifests) {
    for (const recipeId of m.recipes) {
      const list = map.get(recipeId);
      if (list) {
        if (!list.includes(m.kind)) list.push(m.kind);
      } else {
        map.set(recipeId, [m.kind]);
      }
    }
  }
  return map;
}

/**
 * 工具 → 域反推表：tool → 域 kind 列表（按 manifests 顺序，去重）。
 * 只收 valid 配方（invalid 配方的工具声明未经验证，同 aggregateRecipeTools 纪律）。
 */
export function buildToolDomainIndex(
  recipes: readonly EnvironmentRecipe[],
  manifests: readonly DomainManifest[],
): Map<string, string[]> {
  const recipeDomains = buildRecipeDomainMap(manifests);
  const index = new Map<string, string[]>();
  for (const recipe of recipes) {
    if (!recipe.valid) continue;
    const domains = recipeDomains.get(recipe.id);
    if (!domains) continue;
    // 1.5.7：firstRunTools 一并入表——首跑安装完成后探测命中，应同样贡献
    // 域证据（装完就是真实在场的工具）。
    for (const tool of [...recipe.tools, ...(recipe.firstRunTools ?? [])]) {
      const list = index.get(tool);
      if (list) {
        for (const d of domains) if (!list.includes(d)) list.push(d);
      } else {
        index.set(tool, [...domains]);
      }
    }
  }
  return index;
}

/**
 * 探测面：全部 valid 配方 tools 的并集（去重，字典序排序——输出稳定，
 * 探测脚本可缓存对比）。无域归属的配方工具也在探测面内（探测的是工具，
 * 域反推时才按表归并——表外工具自然不落任何域）。
 * 1.5.7：firstRunTools 并入探测面——首跑工具必须被探测，装完后才能从
 * capabilityPending 摘除闭环（不在探测面里就永远是 pending）。
 */
export function collectProbeSurface(recipes: readonly EnvironmentRecipe[]): string[] {
  const set = new Set<string>();
  for (const recipe of recipes) {
    if (!recipe.valid) continue;
    for (const tool of recipe.tools) set.add(tool);
    for (const tool of recipe.firstRunTools ?? []) set.add(tool);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** 探测输出 → 在场工具集合（OK:<工具> 行；MISS 行与噪音行忽略）。 */
export function parseProbePresentTools(stdout: string): Set<string> {
  const present = new Set<string>();
  for (const line of stdout.split('\n')) {
    const m = /^OK:(.+)$/.exec(line.trim());
    if (m) present.add(m[1]);
  }
  return present;
}

/**
 * 配方绑定域（恒在集合）：条目 recipeIds ∪ recipeId（回落 id/vmName 同名
 * 配方，与 buildSecurityCapabilitiesSection / resolveSessionResearchDomain
 * 同一绑定规则）→ domain.json recipes 反查。按 manifests 顺序，去重。
 * 1.4.9：候选补上 recipeIds（多配方）——1.3.8 加多配方绑定时这里漏改，
 * 辅配方对能力集合曾零贡献（pwn-vm 的 whitebox 靠探测命中撑着）。
 */
export function boundDomainsForEntry(
  entry: Pick<EnvironmentEntry, 'id' | 'recipeId' | 'recipeIds' | 'vmName'>,
  manifests: readonly DomainManifest[],
): string[] {
  const candidates = [...(entry.recipeIds ?? []), entry.recipeId, entry.id, entry.vmName].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );
  const out: string[] = [];
  for (const m of manifests) {
    if (m.recipes.some((r) => candidates.includes(r)) && !out.includes(m.kind)) {
      out.push(m.kind);
    }
  }
  return out;
}

/**
 * 合并能力集合：绑定域在前（域推导链基线取 [0]，绑定 = 构建来源优先），
 * 探测域按 manifests 顺序追加，整体去重。
 */
export function mergeCapabilityDomains(
  bound: readonly string[],
  probed: readonly string[],
): string[] {
  const out: string[] = [];
  for (const d of [...bound, ...probed]) {
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

/** 在场工具 → 探测命中的域（按 manifests 顺序，去重）。 */
export function probedDomainsForTools(
  presentTools: ReadonlySet<string>,
  index: ReadonlyMap<string, readonly string[]>,
  manifests: readonly DomainManifest[],
): string[] {
  const hit = new Set<string>();
  for (const tool of presentTools) {
    for (const d of index.get(tool) ?? []) hit.add(d);
  }
  return manifests.map((m) => m.kind).filter((k) => hit.has(k));
}

/**
 * 能力集合内的工具口径（1.4.9，与能力清单段同一规则）：集合内域 →
 * manifests recipes → valid 配方 tools 并集（去重，字典序）。
 * 用途：GUI「在场 M/N」与缺失清单的计数口径——capabilityMissing 是全探测面
 * 落盘（67 个工具级），展示只关心「这个环境声明的能力所涉及的工具」。
 */
export function capabilityScopeTools(
  domains: readonly string[],
  recipes: readonly EnvironmentRecipe[],
  manifests: readonly DomainManifest[],
): string[] {
  const recipeIds = new Set(
    manifests.filter((m) => domains.includes(m.kind)).flatMap((m) => m.recipes),
  );
  return [
    ...new Set(
      recipes.filter((r) => r.valid && recipeIds.has(r.id)).flatMap((r) => r.tools),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

/** 集合内缺失（toolCheck.missing ∪ capabilityMissing ∩ 集合内工具）。
 *  1.5.7：减去 capabilityPending——已登记待装的首跑工具正在后台安装，
 *  不进 missing 双计数。 */
export function capabilityMissingInScope(
  entry: Pick<EnvironmentEntry, 'capabilityDomains' | 'capabilityMissing' | 'capabilityPending' | 'toolCheck'>,
  recipes: readonly EnvironmentRecipe[],
  manifests: readonly DomainManifest[],
): { total: number; missing: string[] } | undefined {
  if (!entry.capabilityDomains?.length) return undefined;
  const scope = capabilityScopeTools(entry.capabilityDomains, recipes, manifests);
  if (scope.length === 0) return undefined;
  const pending = new Set(entry.capabilityPending ?? []);
  const missing = [
    ...new Set([...(entry.toolCheck?.missing ?? []), ...(entry.capabilityMissing ?? [])]),
  ].filter((t) => scope.includes(t) && !pending.has(t));
  return { total: scope.length, missing };
}

// ---------------------------------------------------------------------------
// 薄 IO — 一次性批量探测（exec 可注入，测试不碰真实环境）
// ---------------------------------------------------------------------------

export interface CapabilityProbeDeps {
  /** 全部已扫描配方（探测面 + 反推表的事实源）。 */
  recipes: readonly EnvironmentRecipe[];
  /** 全部域清单（绑定反查 + 域顺序）。 */
  manifests: readonly DomainManifest[];
  /** 执行通道（生产 = env-exec 统一分派；测试注入假通道）。 */
  exec: CapabilityExecFn;
  /** 时间戳源（测试可固定）。 */
  now?: () => Date;
}

export interface CapabilityProbeResult {
  capabilityDomains: string[];
  capabilityDerivedAt: string;
  /** 探测面中缺失的工具（surface − 在场 − pending，字典序；1.4.9 MISS 落盘，
   *  1.5.7 起减去已登记待装——pending 工具不进 missing 双计数）。
   *  探测未执行（空探测面 bound-only）时为 undefined——与「探测了但零
   *  缺失」区分。 */
  capabilityMissing?: string[];
  /** 1.5.7：重推后的待装清单 = 条目 capabilityPending − 本次探测在场
   *  （命中的首跑工具装完了，摘除；空数组 = 全部装完，调用方删字段）。
   *  探测未执行时为 undefined（调用方不动 pending）。 */
  capabilityPending?: string[];
}

/**
 * 对环境跑一次能力探测并推导能力集合。一条批量探测命令（探测面 = 全配方
 * 工具并集），命中工具 → 域集合与绑定域合并。
 *
 * 返回 undefined 的情形（调用方不写能力字段，保 baseline 行为）：
 *   - 通道失败（ssh 不通 / docker 死了 / exec 抛错）；
 *   - 探测面为空（无任何 valid 配方工具可探）且条目无配方绑定；
 *   - 探测成功但零命中且条目无配方绑定（不误判空集合）。
 */
export async function probeEnvironmentCapabilities(
  entry: EnvironmentEntry,
  deps: CapabilityProbeDeps,
): Promise<CapabilityProbeResult | undefined> {
  const bound = boundDomainsForEntry(entry, deps.manifests);
  const surface = collectProbeSurface(deps.recipes);
  let probed: string[] = [];
  let missing: string[] | undefined;
  let pending: string[] | undefined;
  if (surface.length > 0) {
    let stdout: string;
    try {
      const r = await deps.exec(entry, buildToolCheckScript(surface), {
        timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS,
      });
      if (!r.ok) return undefined; // 通道失败 → 不写能力字段（pending 同样不动）
      stdout = r.stdout ?? '';
    } catch {
      return undefined;
    }
    const present = parseProbePresentTools(stdout);
    probed = probedDomainsForTools(
      present,
      buildToolDomainIndex(deps.recipes, deps.manifests),
      deps.manifests,
    );
    // 1.4.9：MISS 清单随探测落盘——「声明了但环境里没有」是元数据可信的
    // 另一半（adopt 环境此前永远看不到缺失）。
    // 1.5.7：减去已登记待装（capabilityPending）——首跑工具正在后台安装，
    // 不进 missing 双计数；同时重算 pending = 旧 pending − 本次在场
    // （首跑装完的工具摘除闭环；空数组交给调用方删字段）。
    const oldPending = entry.capabilityPending ?? [];
    const pendingSet = new Set(oldPending);
    missing = surface.filter((t) => !present.has(t) && !pendingSet.has(t));
    if (oldPending.length > 0) {
      pending = oldPending.filter((t) => !present.has(t));
    }
  }
  const domains = mergeCapabilityDomains(bound, probed);
  if (domains.length === 0) return undefined;
  return {
    capabilityDomains: domains,
    capabilityDerivedAt: (deps.now?.() ?? new Date()).toISOString(),
    ...(missing !== undefined ? { capabilityMissing: missing } : {}),
    ...(pending !== undefined ? { capabilityPending: pending } : {}),
  };
}
