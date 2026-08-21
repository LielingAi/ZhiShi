/**
 * 专家知识检索（expert.db FTS5）——1.2.1 骨架期。
 *
 * 照 intel/store.ts 的检索纪律：FTS5 优先（词元引号包裹 + AND，用户输入
 * 不可能破坏 FTS 语法），零命中再 LIKE 兜底（中文场景 unicode61 分词
 * 命中差，兜底保召回）。只检索 enabled=1 的条目。
 */
import { getEntryById, type ExpertDb, type ExpertEntry } from './store';

/** expert_search / admin 检索的默认条数上限（设计定稿 ≤5）。 */
export const EXPERT_SEARCH_LIMIT = 5;

/** FTS5 查询串：词元按空白切分、逐个引号包裹、AND 连接（同 intel buildFtsQuery）。 */
export function buildExpertFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '""'))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' AND ');
}

export interface ExpertSearchOptions {
  /** 可选域过滤（RESEARCH_TASK_KINDS 闭集；合法性由调用方校验）。 */
  domain?: string;
  limit?: number;
}

/**
 * 检索：FTS5(title/applicability/content/tags) → 零命中 LIKE 兜底；
 * domain 过滤在 SQL 层；只命中 enabled=1。limit 由调用方钳制。
 */
export function searchExpertEntries(db: ExpertDb, query: string, opts: ExpertSearchOptions = {}): ExpertEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? EXPERT_SEARCH_LIMIT, 1), 50);
  const domainClause = opts.domain ? 'AND e.domain = ?' : '';
  const domainParams: unknown[] = opts.domain ? [opts.domain] : [];

  let ids: number[] = [];
  const ftsQuery = buildExpertFtsQuery(query);
  if (ftsQuery) {
    try {
      const rows = db.raw
        .prepare(
          `SELECT e.id FROM expert_entries_fts f JOIN expert_entries e ON e.id = f.rowid
           WHERE expert_entries_fts MATCH ? AND e.enabled = 1 ${domainClause}
           ORDER BY rank LIMIT ?`,
        )
        .all(ftsQuery, ...domainParams, limit) as Array<{ id: number }>;
      ids = rows.map((r) => r.id);
    } catch {
      ids = []; // FTS 语法意外（理论上 buildExpertFtsQuery 已杜绝）→ 落 LIKE 兜底
    }
  }
  if (ids.length === 0) {
    const like = `%${query}%`;
    const rows = db.raw
      .prepare(
        `SELECT id FROM expert_entries e
         WHERE e.enabled = 1 ${domainClause}
           AND (e.title LIKE ? OR e.applicability LIKE ? OR e.content LIKE ? OR e.tags LIKE ?)
         ORDER BY e.updated_at DESC, e.id DESC LIMIT ?`,
      )
      .all(...domainParams, like, like, like, like, limit) as Array<{ id: number }>;
    ids = rows.map((r) => r.id);
  }
  return ids
    .map((id) => getEntryById(db, id))
    .filter((e): e is ExpertEntry => e !== null && e.enabled);
}
