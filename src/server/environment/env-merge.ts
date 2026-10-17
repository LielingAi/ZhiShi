/**
 * 2.0-M1 台账治理：同名环境合并的守卫纯函数（admin-api 的
 * handleEnvironmentMerge 从这里取判定，单测不依赖 HTTP 层）。
 *
 * 合并语义：keep 保留、drop 只摘登记、映射迁移 keep（现存者优先）。
 * 两道守卫：
 *   1. 同名——合并只收拾"同名重复登记"（fuzz 双条目这类历史脏账），
 *      不同名条目合并会把两个不同身份搅在一起，拒绝；
 *   2. 同底层目标——两个登记解析到同一容器/VM/host 时合并无价值且危险
 *      （摘掉一条后另一条与实体状态的对应关系反而更乱），拒绝并引导
 *      逐个 environment/rm。
 */

/** 合并判定需要的条目最小面（EnvironmentEntry 的子集，测试易构造）。 */
export interface MergeEntryLike {
  id: string;
  kind?: string;
  name?: string;
  container?: string;
  vmName?: string;
  vmx?: string;
  host?: string;
}

/** 展示名归一化：name 优先、回落 id，trim + 小写。 */
export function mergeNameOf(e: MergeEntryLike): string {
  return (e.name ?? e.id).trim().toLowerCase();
}

/** 两个登记条目是否解析到同一底层目标（同容器/同 VM/同 host）。 */
export function sameUnderlyingTarget(a: MergeEntryLike, b: MergeEntryLike): boolean {
  if (a.kind !== b.kind) return false;
  const norm = (s?: string): string => (s ?? '').trim().toLowerCase();
  if (a.kind === 'docker') {
    return norm(a.container) !== '' && norm(a.container) === norm(b.container);
  }
  if (a.kind === 'vm') {
    const an = norm(a.vmName) || norm(a.vmx);
    const bn = norm(b.vmName) || norm(b.vmx);
    return an !== '' && an === bn;
  }
  if (a.kind === 'ssh') {
    return norm(a.host) !== '' && norm(a.host) === norm(b.host);
  }
  return false;
}

export interface MergeVerdict {
  ok: boolean;
  error?: string;
}

/** 合并前双守卫（id 相等/内置条目检查在 handler 层做，这里只管身份与目标）。 */
export function canMergeEntries(keep: MergeEntryLike, drop: MergeEntryLike): MergeVerdict {
  if (mergeNameOf(keep) !== mergeNameOf(drop)) {
    return {
      ok: false,
      error: `拒绝合并：两者不同名（"${mergeNameOf(keep)}" ≠ "${mergeNameOf(drop)}"）——合并只收拾同名重复登记`,
    };
  }
  if (sameUnderlyingTarget(keep, drop)) {
    return {
      ok: false,
      error: '两者指向同一底层目标（容器/VM/host 相同）——无需合并；若要清理重复登记请逐个 environment/rm',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 合并计划器（2.0 audit：handler 接线可测化——把"能不能合"从"怎么合"里剥离）
// ---------------------------------------------------------------------------

/** 合并计划：ok=true 时 keep/drop 已定位；error 文案与 handler 逐字一致。 */
export interface MergePlan {
  ok: boolean;
  error?: string;
  keep?: MergeEntryLike;
  drop?: MergeEntryLike;
}

/**
 * 合并前置计划（含 id 空/相等、内置条目、存在性、双守卫）。
 * 纯函数——handler 只管执行动作（映射迁移 + 摘登记）。
 * @param localEnvId 内置本机条目 id（registry.LOCAL_ENV_ID；参数注入避免
 *   env-merge 依赖 registry 模块，单测无需 mock 配置层）。
 */
export function planMergeEntries(
  entries: MergeEntryLike[],
  keepId: string,
  dropId: string,
  localEnvId: string,
): MergePlan {
  if (!keepId || !dropId) {
    return { ok: false, error: 'Missing required argument: <keepId, dropId>' };
  }
  if (keepId === dropId) {
    return { ok: false, error: 'keepId 与 dropId 相同——合并需要两个不同条目' };
  }
  if (keepId === localEnvId || dropId === localEnvId) {
    return { ok: false, error: `环境 "${localEnvId}" 是内置本机条目，不可参与合并` };
  }
  const keep = entries.find((e) => e.id === keepId);
  if (!keep) return { ok: false, error: `未找到环境 "${keepId}"（zhishi env list 查看已有环境）` };
  const drop = entries.find((e) => e.id === dropId);
  if (!drop) return { ok: false, error: `未找到环境 "${dropId}"（zhishi env list 查看已有环境）` };
  const verdict = canMergeEntries(keep, drop);
  if (!verdict.ok) return { ok: false, error: verdict.error };
  return { ok: true, keep, drop };
}
