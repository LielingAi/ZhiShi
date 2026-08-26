/**
 * 1.3.8 环境多配方（关联侧）——绑定集合的纯函数层。
 *
 * 口径：绑定=展示/构建来源，不进域裁决（能力集合=推导唯一真相源）。
 * 主配方 recipeId 恒在集合内，不可单独移除；缺省（无 recipeIds）等价
 * [recipeId]。整体替换经 environment/bind-recipes（服务端校验主配方恒在）。
 */

export interface RecipeBindingTarget {
  id: string;
  recipeId?: string;
  recipeIds?: string[];
}

/** 当前生效的绑定集合（缺省等价 [主配方]；无主配方则空集合）。 */
export function boundRecipeIds(target: RecipeBindingTarget): string[] {
  const ids = target.recipeIds ?? (target.recipeId ? [target.recipeId] : []);
  // 防御：recipeIds 存在但漏了主配方时补回（服务端也校验，此处兜底展示）。
  if (target.recipeId && !ids.includes(target.recipeId)) {
    return [target.recipeId, ...ids];
  }
  return [...ids];
}

/** 追加绑定（幂等去重；已存在返回原集合）。 */
export function addRecipeBinding(current: string[], recipeId: string): string[] {
  return current.includes(recipeId) ? [...current] : [...current, recipeId];
}

/** 移除绑定：主配方不可移除；目标不存在返回原集合。 */
export function removeRecipeBinding(
  current: string[],
  targetRecipeId: string,
  primaryRecipeId?: string,
): { ok: boolean; error?: string; next: string[] } {
  if (targetRecipeId === primaryRecipeId) {
    return { ok: false, error: `主配方 "${primaryRecipeId}" 不可移除（构建来源/展示锚）`, next: [...current] };
  }
  if (!current.includes(targetRecipeId)) {
    return { ok: true, next: [...current] };
  }
  return { ok: true, next: current.filter((r) => r !== targetRecipeId) };
}

/** 绑定差异显示（确认模态用）：增/减各自一行。 */
export function describeBindingDiff(before: string[], after: string[]): string[] {
  const added = after.filter((r) => !before.includes(r));
  const removed = before.filter((r) => !after.includes(r));
  const lines: string[] = [];
  for (const r of added) lines.push(`＋ 绑定 ${r}`);
  for (const r of removed) lines.push(`－ 解绑 ${r}`);
  return lines;
}
