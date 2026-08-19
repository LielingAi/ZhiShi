/**
 * 情报库（intel.db）——1.1.2 情报横切的存储层，SQLite（better-sqlite3）实现。
 *
 * 与 memory.db 完全独立：独立文件、独立连接，互不干扰（不碰记忆库是
 * 1.1.2 的红线）。驱动加载方式与 memory/store.ts 同构：生产走
 * sqlite-runtime/node_modules/better-sqlite3 的路径解析（getBundledSqliteEntryPoint）。
 *
 * 表结构（分级设计定稿）：
 * - cves(id PK, description, cvss_score, cvss_vector, published, modified)
 *   字段级摘要：description 存完整（FTS 检索原料），references 等重字段不落库；
 * - cve_products(cve_id, vendor, product) 复合主键 + WITHOUT ROWID——
 *   受影响产品走独立表（SQL 查询方便）且比 cves 里存 JSON 列省空间；
 * - exploits(id PK, file_path, description, type, platform, cve_refs, date)
 *   cve_refs 是 `;` 分隔的大写 CVE 编号（写入时归一），配合
 *   `(';'||cve_refs||';') LIKE '%;'||?||';%'` 做精确命中（防 CVE-1234
 *   误匹配 CVE-12345）；
 * - cves_fts：FTS5 虚拟表（description 全文）+ 触发器随 cves 增删改同步；
 * - meta(key PK, value)：lastUpdateAt / mode / cveCount / exploitCount /
 *   nvdWatermark（增量水位）/ nvdBackfillEnd（首次全量回填断点）。
 *
 * 并发模型：WAL 模式——update 长事务期间查询照常（设计红线）。
 * 写函数不带事务，调用方用 runInTransaction 组合
 * （「写入用事务、meta 最后提交」的纪律落在 sync.ts）。
 */
import { createRequire } from 'module';
import { existsSync, mkdirSync, statSync } from 'fs';
import { dirname, join } from 'path';

import { getBundledSqliteEntryPoint } from '../utils/runtime';
import type { ParsedCve, IntelProduct } from './nvd-parser';
import type { ParsedExploit } from './exploitdb-parser';

// ===== better-sqlite3 驱动加载（同 memory/store.ts 模式） =====

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

/** 打开的 intel.db 连接（baseDir 作缓存键，同 baseDir 复用同一连接）。 */
export interface IntelDb {
  raw: SqliteDatabase;
  dbPath: string;
}

const dbCache = new Map<string, IntelDb>();

/** Test-only：关闭全部缓存句柄（WAL 锁随之释放）并清空连接缓存。 */
export function resetIntelStoreForTest(): void {
  for (const db of dbCache.values()) {
    try {
      db.raw.close();
    } catch { /* ignore */ }
  }
  dbCache.clear();
}

/** 在事务里执行（better-sqlite3 transaction：throw 即回滚）。 */
export function runInTransaction<T>(db: IntelDb, fn: () => T): T {
  return db.raw.transaction(fn)();
}

/** 索引是否已存在（不建库不打开——status 用，判断「尚未初始化」）。 */
export function hasIntelDb(baseDir: string): boolean {
  return existsSync(join(baseDir, 'intel.db'));
}

/**
 * 打开（或创建）intel.db 并确保表结构就位。幂等：重复打开/建表无副作用。
 * 初始化失败（better-sqlite3 缺失等）向上抛——调用方（工具/同步）各自降级。
 */
export function openIntelStore(baseDir: string): IntelDb {
  const cached = dbCache.get(baseDir);
  if (cached) return cached;
  const Database = loadSqlite();
  const dbPath = join(baseDir, 'intel.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = Database(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS cves (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      cvss_score REAL,
      cvss_vector TEXT,
      published TEXT,
      modified TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cves_published ON cves(published);
    CREATE TABLE IF NOT EXISTS cve_products (
      cve_id TEXT NOT NULL,
      vendor TEXT NOT NULL,
      product TEXT NOT NULL,
      PRIMARY KEY (cve_id, vendor, product)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS exploits (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL,
      description TEXT NOT NULL,
      type TEXT,
      platform TEXT,
      cve_refs TEXT,
      date TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS cves_fts USING fts5(description, id UNINDEXED);
    -- 触发器用 DROP+CREATE 而非 CREATE IF NOT EXISTS：FTS5 的 'delete' 特殊
    -- 命令只支持 contentless/external-content 表（本版本 SQLite 实测对普通
    -- 内容表报 SQL logic error），普通表走 rowid 直删即可；DROP+CREATE 还能
    -- 自愈旧版本（若有）遗留的坏触发器定义。
    DROP TRIGGER IF EXISTS cves_fts_ai;
    CREATE TRIGGER cves_fts_ai AFTER INSERT ON cves BEGIN
      INSERT INTO cves_fts(rowid, description, id) VALUES (new.rowid, new.description, new.id);
    END;
    DROP TRIGGER IF EXISTS cves_fts_ad;
    CREATE TRIGGER cves_fts_ad AFTER DELETE ON cves BEGIN
      DELETE FROM cves_fts WHERE rowid = old.rowid;
    END;
    DROP TRIGGER IF EXISTS cves_fts_au;
    CREATE TRIGGER cves_fts_au AFTER UPDATE ON cves BEGIN
      DELETE FROM cves_fts WHERE rowid = old.rowid;
      INSERT INTO cves_fts(rowid, description, id) VALUES (new.rowid, new.description, new.id);
    END;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  const intelDb: IntelDb = { raw: db, dbPath };
  dbCache.set(baseDir, intelDb);
  return intelDb;
}

// ===== meta / 水位 =====

export function getMeta(db: IntelDb, key: string): string | null {
  const row = db.raw.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/** 无事务包装的 meta 写（由 runInTransaction 组合；单条调用也可直接用）。 */
export function setMeta(db: IntelDb, key: string, value: string): void {
  db.raw.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function removeMeta(db: IntelDb, key: string): void {
  db.raw.prepare('DELETE FROM meta WHERE key = ?').run(key);
}

// ===== 写入（无事务包装——调用方组合） =====

/**
 * upsert 一批 CVE（幂等：同 id 覆盖，产品表先清后插）。
 * opts.minPublished：window 模式写入过滤——早于该时间戳（或无日期）的记录
 * 直接跳过不落库，省掉写后删的往返。返回实际写入条数。
 */
export function upsertCves(db: IntelDb, cves: ParsedCve[], opts: { minPublished?: string } = {}): number {
  const upsert = db.raw.prepare(`
    INSERT INTO cves (id, description, cvss_score, cvss_vector, published, modified)
    VALUES (@id, @description, @cvssScore, @cvssVector, @published, @modified)
    ON CONFLICT(id) DO UPDATE SET
      description = excluded.description,
      cvss_score = excluded.cvss_score,
      cvss_vector = excluded.cvss_vector,
      published = excluded.published,
      modified = excluded.modified
  `);
  const delProducts = db.raw.prepare('DELETE FROM cve_products WHERE cve_id = ?');
  const insProduct = db.raw.prepare('INSERT OR IGNORE INTO cve_products (cve_id, vendor, product) VALUES (?, ?, ?)');
  let count = 0;
  for (const cve of cves) {
    if (opts.minPublished && (cve.published === null || cve.published < opts.minPublished)) continue;
    upsert.run({
      id: cve.id,
      description: cve.description,
      cvssScore: cve.cvssScore,
      cvssVector: cve.cvssVector,
      published: cve.published,
      modified: cve.modified,
    });
    delProducts.run(cve.id);
    for (const p of cve.products) insProduct.run(cve.id, p.vendor, p.product);
    count += 1;
  }
  return count;
}

/** 整体替换 exploits（拉取即替换语义；解析出 0 条时调用方不要调它）。 */
export function replaceExploits(db: IntelDb, exploits: ParsedExploit[]): number {
  db.raw.prepare('DELETE FROM exploits').run();
  const ins = db.raw.prepare(`
    INSERT INTO exploits (id, file_path, description, type, platform, cve_refs, date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const e of exploits) {
    ins.run(
      e.id,
      e.filePath,
      e.description,
      e.type,
      e.platform,
      e.cveRefs.length > 0 ? e.cveRefs.join(';') : null,
      e.date,
    );
  }
  return exploits.length;
}

// ===== 查询 =====

/** 命中结果（工具侧渲染原料）。exploitCount < 0 表示未知（在线回源）。 */
export interface IntelHit {
  id: string;
  description: string;
  cvssScore: number | null;
  cvssVector: string | null;
  published: string | null;
  modified: string | null;
  products: IntelProduct[];
  exploitCount: number;
}

interface CveRow {
  id: string;
  description: string;
  cvss_score: number | null;
  cvss_vector: string | null;
  published: string | null;
  modified: string | null;
}

function exploitCountFor(db: IntelDb, cveId: string): number {
  const row = db.raw
    .prepare("SELECT COUNT(*) AS n FROM exploits WHERE (';' || cve_refs || ';') LIKE '%;' || ? || ';%'")
    .get(cveId) as { n: number };
  return row.n;
}

/** 单条精确查询（id 大小写不敏感，统一大写落库）。 */
export function getCveById(db: IntelDb, id: string): IntelHit | null {
  const row = db.raw.prepare('SELECT * FROM cves WHERE id = ?').get(id.toUpperCase()) as CveRow | undefined;
  if (!row) return null;
  const products = db.raw
    .prepare('SELECT vendor, product FROM cve_products WHERE cve_id = ? ORDER BY vendor, product')
    .all(row.id) as IntelProduct[];
  return {
    id: row.id,
    description: row.description,
    cvssScore: row.cvss_score,
    cvssVector: row.cvss_vector,
    published: row.published,
    modified: row.modified,
    products,
    exploitCount: exploitCountFor(db, row.id),
  };
}

/** 从查询串里捞出 CVE 编号（出现即走精确路径）。 */
export function extractCveId(query: string): string | null {
  const m = /CVE-\d{4}-\d{4,}/i.exec(query);
  return m ? m[0].toUpperCase() : null;
}

/**
 * FTS5 查询串：词元按空白切分、逐个引号包裹（内部引号按 "" 转义）、
 * AND 连接——用户输入不可能破坏 FTS 语法。无词元返回 ''（走 LIKE 兜底）。
 */
export function buildFtsQuery(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '""'))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' AND ');
}

/**
 * 检索：CVE 编号 → 精确主表查询；否则 FTS5 模糊，FTS 零命中再 LIKE 兜底
 * （中文/符号场景 unicode61 分词命中差，兜底保召回）。limit 由调用方钳制。
 */
export function searchCves(db: IntelDb, query: string, limit: number): IntelHit[] {
  const cveId = extractCveId(query);
  if (cveId) {
    const hit = getCveById(db, cveId);
    return hit ? [hit] : [];
  }
  let ids: string[] = [];
  const ftsQuery = buildFtsQuery(query);
  if (ftsQuery) {
    try {
      const rows = db.raw
        .prepare('SELECT id FROM cves_fts WHERE cves_fts MATCH ? LIMIT ?')
        .all(ftsQuery, limit) as Array<{ id: string }>;
      ids = rows.map((r) => r.id);
    } catch {
      ids = []; // FTS 语法意外（理论上 buildFtsQuery 已杜绝）→ 落 LIKE 兜底
    }
  }
  if (ids.length === 0) {
    const rows = db.raw
      .prepare('SELECT id FROM cves WHERE description LIKE ? LIMIT ?')
      .all(`%${query}%`, limit) as Array<{ id: string }>;
    ids = rows.map((r) => r.id);
  }
  return ids.map((id) => getCveById(db, id)).filter((h): h is IntelHit => h !== null);
}

// ===== 裁剪 =====

/** WAL checkpoint（TRUNCATE）：把 WAL 并回主文件，裁剪按主文件大小判断。 */
function checkpoint(db: IntelDb): void {
  try {
    db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch { /* 只读场景等失败不影响裁剪判断 */ }
}

/** intel.db 主文件字节数（不存在计 0）。 */
export function getDbFileSize(db: IntelDb): number {
  try {
    return statSync(db.dbPath).size;
  } catch {
    return 0;
  }
}

/** window 模式裁剪：删掉 published 早于 cutoff（含无日期）的记录。 */
export function pruneByWindow(db: IntelDb, cutoffIso: string): number {
  return db.raw.prepare('DELETE FROM cves WHERE published IS NULL OR published < ?').run(cutoffIso).changes;
}

/**
 * 自适应裁剪：主文件超 maxBytes 时按 published 升序（最旧的先删，NULL 最旧）
 * 分批删到达标或表空。返回删除条数。
 */
export function pruneBySize(db: IntelDb, maxBytes: number): number {
  let deleted = 0;
  checkpoint(db);
  for (let guard = 0; guard < 2000; guard++) {
    if (getDbFileSize(db) <= maxBytes) break;
    const del = db.raw
      .prepare('DELETE FROM cves WHERE id IN (SELECT id FROM cves ORDER BY published ASC, id ASC LIMIT 500)')
      .run().changes;
    deleted += del;
    if (del === 0) break;
    checkpoint(db);
  }
  return deleted;
}

// ===== 统计 / 状态 =====

export function countCves(db: IntelDb): number {
  return (db.raw.prepare('SELECT COUNT(*) AS n FROM cves').get() as { n: number }).n;
}

export function countExploits(db: IntelDb): number {
  return (db.raw.prepare('SELECT COUNT(*) AS n FROM exploits').get() as { n: number }).n;
}

export interface IntelStatus {
  dbExists: boolean;
  lastUpdateAt: string | null;
  mode: string | null;
  cveCount: number;
  exploitCount: number;
  nvdWatermark: string | null;
  dbFileSizeBytes: number;
}

/** 索引状态快照（zhishi intel status / 工具头）。 */
export function getIntelStatus(db: IntelDb): IntelStatus {
  return {
    dbExists: true,
    lastUpdateAt: getMeta(db, 'lastUpdateAt'),
    mode: getMeta(db, 'mode'),
    cveCount: countCves(db),
    exploitCount: countExploits(db),
    nvdWatermark: getMeta(db, 'nvdWatermark'),
    dbFileSizeBytes: getDbFileSize(db),
  };
}
