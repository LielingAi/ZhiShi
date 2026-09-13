/**
 * 1.7.3 — 专家知识页筛选 + 翻页（design: 1.7.3-gui.md §3）。
 *
 * 纯函数、组件本地状态——服务端搜索语义（expert/search）不动，
 * 筛选作用于当前结果集（domain × kind × query 组合）。
 */

export interface ExpertEntryLike {
  id: number;
  domain?: string;
  kind?: string;
  title?: string;
  reviewer?: string;
  /** builtin/user/promoted——筛选不消费,渲染保留。 */
  provenance?: string;
}

export interface ExpertFilterState {
  /** domain 闭集值或 undefined（全部）。 */
  domain?: string;
  /** kind 闭集值或 undefined（全部）。 */
  kind?: string;
  /** 关键词（标题/reviewer 子串命中，大小写不敏感）。 */
  query?: string;
}

export function filterExpertEntries(
  entries: ExpertEntryLike[],
  filter: ExpertFilterState,
): ExpertEntryLike[] {
  const q = filter.query?.trim().toLowerCase() ?? '';
  return entries.filter((e) => {
    if (filter.domain && e.domain !== filter.domain) return false;
    if (filter.kind && e.kind !== filter.kind) return false;
    if (q) {
      const hay = `${e.title ?? ''} ${e.reviewer ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// 翻页
// ---------------------------------------------------------------------------

export const SETTINGS_PAGE_SIZE = 20;

export interface PaginationResult<T> {
  /** clamp 后的当前页（1 起）。 */
  page: number;
  totalPages: number;
  total: number;
  items: T[];
}

export function paginate<T>(items: T[], page: number, size = SETTINGS_PAGE_SIZE): PaginationResult<T> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const clamped = Math.min(Math.max(1, page), totalPages);
  const start = (clamped - 1) * size;
  return { page: clamped, totalPages, total, items: items.slice(start, start + size) };
}
