/**
 * 专家知识库（expert.db）——1.2.1 专家知识层（骨架期）的存储层，
 * SQLite（better-sqlite3）实现，照 intel.db 范式。
 *
 * 与 intel.db / memory.db 物理独立 = 语义独立：intel.db（公共原料，线索
 * 不是结论）/ memory.db（LLM 自身经验，参考级）/ expert.db（专家审定，
 * 决策级）三库三权威级，永不混写。
 *
 * 表结构（docs/expert-knowledge-plan.md §3.1 定稿）：
 * - expert_entries：审定生效的专家知识（idea/technique/sop × 8 研究域）；
 * - expert_drafts：agent 起草待人审的草稿（同构 + created_via）——起草不
 *   是生效，人审通过才进 entries；
 * - expert_entries_fts：FTS5(title, applicability, content, tags) +
 *   触发器随 entries 增删改同步；
 * - meta(key PK, value)：seed 映射（seed:<domain>/<slug> → 条目 id +
 *   content_hash）等。
 *
 * 并发模型：WAL。驱动加载与 intel/store.ts 同构。
 */
import { createRequire } from 'module';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

import { getBundledSqliteEntryPoint } from '../utils/runtime';
import type { ResearchTaskKind } from '../memory/store';
import type { ExpertEntryKind, ExpertProvenance, ValidatedExpertEntry } from './validate';

// ===== better-sqlite3 驱动加载（同 intel/store.ts 模式） =====

interface SqliteStatement {
  run: (...args: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
}

interface SqliteDatabase {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
  transaction: <T>(fn: () => T) => () => T;
}

type SqliteFactory = (path: string) => SqliteDatabase;

let sqliteFactory: SqliteFactory | null = null;
let sqliteLoadError: Error | null = null;

function loadSqlite(): SqliteFactory {
  if (sqliteFactory) return sqliteFactory;
  if (sqliteLoadError) throw sqliteLoadError;
  const entry = getBundledSqliteEntryPoint();
  if (!entry) {
    sqliteLoadError = new Error(
      'better-sqlite3 not found — expected sqlite-runtime/node_modules/better-sqlite3 (production) or node_modules/better-sqlite3 (dev).',
    );
    throw sqliteLoadError;
  }
  try {
    const nodeRequire = createRequire(import.meta.url);
    sqliteFactory = nodeRequire(entry) as SqliteFactory;
    return sqliteFactory;
  } catch (err) {
    sqliteLoadError = err instanceof Error ? err : new Error(String(err));
    throw sqliteLoadError;
  }
}

/** 打开的 expert.db 连接（baseDir 作缓存键，同 baseDir 复用同一连接）。 */
export interface ExpertDb {
  raw: SqliteDatabase;
  dbPath: string;
}

const dbCache = new Map<string, ExpertDb>();

/** Test-only：关闭全部缓存句柄（WAL 锁随之释放）并清空连接缓存。 */
export function resetExpertStoreForTest(): void {
  for (const db of dbCache.values()) {
    try {
      db.raw.close();
    } catch { /* ignore */ }
  }
  dbCache.clear();
}

/** 索引是否已存在（不建库不打开）。 */
export function hasExpertDb(baseDir: string): boolean {
  return existsSync(join(baseDir, 'expert.db'));
}

/**
 * 打开（或创建）expert.db 并确保表结构就位。幂等。初始化失败
 * （better-sqlite3 缺失等）向上抛——调用方（工具/seed/admin）各自降级。
 */
export function openExpertStore(baseDir: string): ExpertDb {
  const cached = dbCache.get(baseDir);
  if (cached) return cached;
  const Database = loadSqlite();
  const dbPath = join(baseDir, 'expert.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = Database(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS expert_entries (
      id INTEGER PRIMARY KEY,
      domain TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      applicability TEXT NOT NULL,
      content TEXT NOT NULL,
      criteria TEXT NOT NULL,
      provenance TEXT NOT NULL,
      reviewer TEXT,
      source_event_id INTEGER,
      tags TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS expert_entries_fts USING fts5(title, applicability, content, tags);
    -- 触发器 DROP+CREATE 而非 CREATE IF NOT EXISTS：同 intel/store.ts 注释
    -- （FTS5 'delete' 特殊命令在普通内容表上不可用，走 rowid 直删；DROP+CREATE
    -- 自愈旧版本遗留的坏触发器）。
    DROP TRIGGER IF EXISTS expert_entries_fts_ai;
    CREATE TRIGGER expert_entries_fts_ai AFTER INSERT ON expert_entries BEGIN
      INSERT INTO expert_entries_fts(rowid, title, applicability, content, tags)
      VALUES (new.rowid, new.title, new.applicability, new.content, new.tags);
    END;
    DROP TRIGGER IF EXISTS expert_entries_fts_ad;
    CREATE TRIGGER expert_entries_fts_ad AFTER DELETE ON expert_entries BEGIN
      DELETE FROM expert_entries_fts WHERE rowid = old.rowid;
    END;
    DROP TRIGGER IF EXISTS expert_entries_fts_au;
    CREATE TRIGGER expert_entries_fts_au AFTER UPDATE ON expert_entries BEGIN
      DELETE FROM expert_entries_fts WHERE rowid = old.rowid;
      INSERT INTO expert_entries_fts(rowid, title, applicability, content, tags)
      VALUES (new.rowid, new.title, new.applicability, new.content, new.tags);
    END;
    CREATE TABLE IF NOT EXISTS expert_drafts (
      id INTEGER PRIMARY KEY,
      domain TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      applicability TEXT NOT NULL,
      content TEXT NOT NULL,
      criteria TEXT NOT NULL,
      provenance TEXT NOT NULL,
      reviewer TEXT,
      source_event_id INTEGER,
      tags TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL,
      created_via TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  const expertDb: ExpertDb = { raw: db, dbPath };
  dbCache.set(baseDir, expertDb);
  return expertDb;
}

// ===== meta =====

export function getExpertMeta(db: ExpertDb, key: string): string | null {
  const row = db.raw.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setExpertMeta(db: ExpertDb, key: string, value: string): void {
  db.raw.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ===== 行映射 =====

export interface ExpertEntry {
  id: number;
  domain: ResearchTaskKind;
  kind: ExpertEntryKind;
  title: string;
  applicability: string;
  content: string;
  criteria: string;
  provenance: ExpertProvenance;
  reviewer: string | null;
  sourceEventId: number | null;
  tags: string;
  contentHash: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ExpertDraft extends Omit<ExpertEntry, 'enabled'> {
  createdVia: string;
}

interface EntryRow {
  id: number;
  domain: string;
  kind: string;
  title: string;
  applicability: string;
  content: string;
  criteria: string;
  provenance: string;
  reviewer: string | null;
  source_event_id: number | null;
  tags: string;
  content_hash: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function toEntry(r: EntryRow): ExpertEntry {
  return {
    id: r.id,
    domain: r.domain as ResearchTaskKind,
    kind: r.kind as ExpertEntryKind,
    title: r.title,
    applicability: r.applicability,
    content: r.content,
    criteria: r.criteria,
    provenance: r.provenance as ExpertProvenance,
    reviewer: r.reviewer,
    sourceEventId: r.source_event_id,
    tags: r.tags,
    contentHash: r.content_hash,
    enabled: r.enabled !== 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toDraft(r: EntryRow & { created_via: string }): ExpertDraft {
  const { enabled: _enabled, ...rest } = toEntry(r);
  return { ...rest, createdVia: r.created_via };
}

// ===== entries CRUD =====

/** 插入一条已校验条目（校验是 validateEntry 的职责，这里不落脏数据的防线在调用方）。 */
export function insertEntry(
  db: ExpertDb,
  value: ValidatedExpertEntry,
  contentHash: string,
  now: number = Date.now(),
): ExpertEntry {
  db.raw.prepare(`
    INSERT INTO expert_entries
      (domain, kind, title, applicability, content, criteria, provenance, reviewer,
       source_event_id, tags, content_hash, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    value.domain, value.kind, value.title, value.applicability, value.content, value.criteria,
    value.provenance, value.reviewer, value.sourceEventId, value.tags, contentHash,
    value.enabled ? 1 : 0, now, now,
  );
  const id = (db.raw.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
  return getEntryById(db, id)!;
}

export function getEntryById(db: ExpertDb, id: number): ExpertEntry | null {
  const row = db.raw.prepare('SELECT * FROM expert_entries WHERE id = ?').get(id) as EntryRow | undefined;
  return row ? toEntry(row) : null;
}

/** 可变字段（admin update / seed 覆盖）：id 与 provenance 不可变——来源通道写入即定型。 */
export type ExpertEntryPatch = Partial<Omit<ValidatedExpertEntry, 'provenance'>> & { contentHash?: string };

/** 更新条目可变字段；条目不存在返回 null。contentHash 由调用方按新内容重算。 */
export function updateEntry(
  db: ExpertDb,
  id: number,
  patch: ExpertEntryPatch,
  now: number = Date.now(),
): ExpertEntry | null {
  const existing = getEntryById(db, id);
  if (!existing) return null;
  const next = {
    domain: patch.domain ?? existing.domain,
    kind: patch.kind ?? existing.kind,
    title: patch.title ?? existing.title,
    applicability: patch.applicability ?? existing.applicability,
    content: patch.content ?? existing.content,
    criteria: patch.criteria ?? existing.criteria,
    reviewer: patch.reviewer !== undefined ? patch.reviewer : existing.reviewer,
    sourceEventId: patch.sourceEventId !== undefined ? patch.sourceEventId : existing.sourceEventId,
    tags: patch.tags ?? existing.tags,
    enabled: patch.enabled ?? existing.enabled,
    contentHash: patch.contentHash ?? existing.contentHash,
  };
  db.raw.prepare(`
    UPDATE expert_entries SET
      domain = ?, kind = ?, title = ?, applicability = ?, content = ?, criteria = ?,
      reviewer = ?, source_event_id = ?, tags = ?, content_hash = ?, enabled = ?, updated_at = ?
    WHERE id = ?
  `).run(
    next.domain, next.kind, next.title, next.applicability, next.content, next.criteria,
    next.reviewer, next.sourceEventId, next.tags, next.contentHash, next.enabled ? 1 : 0, now, id,
  );
  return getEntryById(db, id);
}

export interface ListEntriesFilter {
  domain?: string;
  kind?: string;
  provenance?: string;
  limit?: number;
}

/** 管理面列表（含 disabled——管理需要看到全量；检索侧才过滤 enabled）。 */
export function listEntries(db: ExpertDb, filter: ListEntriesFilter = {}): ExpertEntry[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.domain) { clauses.push('domain = ?'); params.push(filter.domain); }
  if (filter.kind) { clauses.push('kind = ?'); params.push(filter.kind); }
  if (filter.provenance) { clauses.push('provenance = ?'); params.push(filter.provenance); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  const rows = db.raw
    .prepare(`SELECT * FROM expert_entries ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(...params, limit) as EntryRow[];
  return rows.map(toEntry);
}

/**
 * 删除条目。builtin 拒绝删（随包分发，删了下个包版本还会回来——要下线
 * 走 enabled=0）；条目不存在同样报错。user/promoted 正常删。
 */
export function deleteEntry(db: ExpertDb, id: number): void {
  const existing = getEntryById(db, id);
  if (!existing) throw new Error(`expert: 条目 #${id} 不存在`);
  if (existing.provenance === 'builtin') {
    throw new Error(`expert: 条目 #${id} 是内置条目（随包分发），不可删除——要停用请置 enabled=false`);
  }
  db.raw.prepare('DELETE FROM expert_entries WHERE id = ?').run(id);
}

/**
 * 批量查证条目 id 是否存在于 expert.db（1.2.2 引用追踪：research_events
 * 落库前校验 expert_refs）。expert.db 尚不存在 → 全部 id 视为缺失。
 * 返回缺失的 id 列表（保持入参序）；空输入 → 空数组（不碰库）。
 */
export function findMissingExpertEntryIds(baseDir: string, ids: number[]): number[] {
  if (ids.length === 0) return [];
  if (!hasExpertDb(baseDir)) return [...ids];
  const db = openExpertStore(baseDir);
  return ids.filter((id) => getEntryById(db, id) === null);
}

// ===== drafts =====

export function insertDraft(
  db: ExpertDb,
  value: ValidatedExpertEntry,
  contentHash: string,
  createdVia: string,
  now: number = Date.now(),
): ExpertDraft {
  db.raw.prepare(`
    INSERT INTO expert_drafts
      (domain, kind, title, applicability, content, criteria, provenance, reviewer,
       source_event_id, tags, content_hash, created_via, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    value.domain, value.kind, value.title, value.applicability, value.content, value.criteria,
    value.provenance, value.reviewer, value.sourceEventId, value.tags, contentHash,
    createdVia, now, now,
  );
  const id = (db.raw.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
  return getDraftById(db, id)!;
}

export function getDraftById(db: ExpertDb, id: number): ExpertDraft | null {
  const row = db.raw.prepare('SELECT * FROM expert_drafts WHERE id = ?').get(id) as (EntryRow & { created_via: string }) | undefined;
  return row ? toDraft(row) : null;
}

export function listDrafts(db: ExpertDb, limit = 200): ExpertDraft[] {
  const rows = db.raw
    .prepare('SELECT * FROM expert_drafts ORDER BY created_at ASC, id ASC LIMIT ?')
    .all(limit) as Array<EntryRow & { created_via: string }>;
  return rows.map(toDraft);
}

export function deleteDraft(db: ExpertDb, id: number): boolean {
  return db.raw.prepare('DELETE FROM expert_drafts WHERE id = ?').run(id).changes > 0;
}
