/**
 * 专家知识检索（expert.db FTS5）——1.2.1 骨架期。
 *
 * 检索分级放宽链（1.2.1 对照实验实战修正）：① FTS AND（精确多词）→
 * ② FTS OR + bm25 排名（部分词命中）→ ③ 逐词元 LIKE OR 兜底（unicode61
 * 不切 CJK——中文词在索引里是长 token，必须子串兜底）。词元引号包裹，
 * 用户输入不可能破坏 FTS 语法。只检索 enabled=1 的条目。
 *
 * 为什么不能用 AND 一刀切：agent 的自然查询是多词长句（"zsrv KV 查询服务
 * 安全测试 漏洞利用"），AND 全命中才返回 = 几乎必空，专家知识在命中的
 * 条目上失声（1.2.1 活体实测：长查询 0 命中、短查询命中）。
 */
import { getEntryById, type ExpertDb, type ExpertEntry } from './store';

/** expert_search / admin 检索的默认条数上限（设计定稿 ≤5）。 */
export const EXPERT_SEARCH_LIMIT = 5;

/** 词元切分（空白切分、引号转义、去空），供 FTS 构造与 LIKE 兜底共用。 */
export function expertQueryTokens(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '""'))
    .filter((t) => t.length > 0);
}

/** FTS5 查询串：词元逐个引号包裹，按 joiner（AND/OR）连接。 */
export function buildExpertFtsQuery(query: string, joiner: 'AND' | 'OR' = 'AND'): string {
  const tokens = expertQueryTokens(query);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(` ${joiner} `);
}

export interface ExpertSearchOptions {
  /** 可选域过滤（RESEARCH_TASK_KINDS 闭集；合法性由调用方校验）。 */
  domain?: string;
  limit?: number;
}

/**
 * 检索：FTS AND → FTS OR（bm25 排名）→ 逐词元 LIKE OR 兜底；
 * domain 过滤在 SQL 层；只命中 enabled=1。limit 由调用方钳制。
 */
export function searchExpertEntries(db: ExpertDb, query: string, opts: ExpertSearchOptions = {}): ExpertEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? EXPERT_SEARCH_LIMIT, 1), 50);
  const domainClause = opts.domain ? 'AND e.domain = ?' : '';
  const domainParams: unknown[] = opts.domain ? [opts.domain] : [];

  let ids: number[] = [];
  const fts = (joiner: 'AND' | 'OR'): number[] => {
    const q = buildExpertFtsQuery(query, joiner);
    if (!q) return [];
    try {
      const rows = db.raw
        .prepare(
          `SELECT e.id FROM expert_entries_fts f JOIN expert_entries e ON e.id = f.rowid
           WHERE expert_entries_fts MATCH ? AND e.enabled = 1 ${domainClause}
           ORDER BY rank LIMIT ?`,
        )
        .all(q, ...domainParams, limit) as Array<{ id: number }>;
      return rows.map((r) => r.id);
    } catch {
      return []; // FTS 语法意外（理论上词元已引号包裹）→ 落下一级
    }
  };

  ids = fts('AND');
  if (ids.length === 0) ids = fts('OR');
  if (ids.length === 0) {
    // 逐词元 LIKE OR：CJK 子串兜底（unicode61 不切中文，整段长 token）
    const tokens = expertQueryTokens(query);
    if (tokens.length > 0) {
      const perToken = tokens.map(() => '(e.title LIKE ? OR e.applicability LIKE ? OR e.content LIKE ? OR e.tags LIKE ?)').join(' OR ');
      const rows = db.raw
        .prepare(
          `SELECT id FROM expert_entries e
           WHERE e.enabled = 1 ${domainClause} AND (${perToken})
           ORDER BY e.updated_at DESC, e.id DESC LIMIT ?`,
        )
        .all(...domainParams, ...tokens.flatMap((t) => Array(4).fill(`%${t}%`)), limit) as Array<{ id: number }>;
      ids = rows.map((r) => r.id);
    }
  }
  return ids
    .map((id) => getEntryById(db, id))
    .filter((e): e is ExpertEntry => e !== null && e.enabled);
}
