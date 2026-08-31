/**
 * 记忆库（memory store）——宪章 §7.1/§7.2 的存储层，SQLite 实现（memory.db）。
 *
 * 与 KEYO memory.db 同构的思路：存储引擎负责查询与索引，语义（kind/来源/
 * salience/有效期/touch/usefulness/遗忘排序）活在条目上。此前是
 * entries.jsonl（原子整写）；规模化与多维检索后引擎从文件换成 SQLite，
 * 公共 API 完全不变（消费方零改动）。
 *
 * 生命周期（§7.2 + KEYO 遗忘曲线）：
 * - salience：情感重量（0..1），写入时定（来源越痛越高）；
 * - 有效分 = salience × recencyDecay(lastTouchedAt) × usefulness：常用的上浮，
 *   久不碰的自然下沉（decay 半衰期按 kind 分档）；
 * - expiresAt：过期自动剔除（注入期与列表期双重过滤，绝不进上下文）；
 * - usefulness：被用上/帮了忙的反馈计数（§6.2 学习循环的原料质量）。
 *
 * 残差守恒（§4.3）：条目上限按 kind 封顶；被挤掉的进 archive 表——
 * 遗忘是压缩，不是删除。
 */
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { createRequire } from 'module';

import { getZhiShiDataDir } from '../utils/app-dirs';
import { getBundledSqliteEntryPoint } from '../utils/runtime';
// 1.2.2 引用追踪：recordResearchEvent 落库前查证 expert_refs 存在于 expert.db。
// expert/store 对本模块只有 type-only 引用（ResearchTaskKind），无运行时环。
import { findMissingExpertEntryIds } from '../expert/store';
// 1.2.3：研究信号枚举迁至 shared（issue #5，CLI 共用），此处 re-export 保持既有引用路径。
import {
  isResearchBugClass,
  isResearchOutcome,
  isResearchTaskKind,
  RESEARCH_BUG_CLASSES,
  RESEARCH_OUTCOMES,
  RESEARCH_TASK_KINDS,
} from '../../shared/research-kinds';
import type { ResearchBugClass, ResearchOutcome, ResearchTaskKind } from '../../shared/research-kinds';

// ===== Types =====

/**
 * 全部 memory kind（穷举的单一事实源——caps/半衰期/存量去重/总览统计都从这展开）。
 * 前四类是认知层（§7.1）；后三类是安全经验层（安全研究员版 P1 D2，技术方案 §1.4）：
 * - research-log：研究流水（短寿滚动记录）；
 * - vuln-pattern：漏洞模式 / 根因经验（含安全蒸馏弧的成功路径与失败根因两节）；
 * - tool-combo：工具组合 / 环境配方的有效性经验。
 */
export const MEMORY_KINDS = [
  'user-model', 'self-model', 'routines', 'reminder',
  'research-log', 'vuln-pattern', 'tool-combo',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * 安全经验 kinds（D2 的三类）。recall 结算按这组 kind 分流：认知类走主蒸馏弧
 * （-5min~+2h 证据窗），安全类走安全蒸馏弧（24h 窗——长 fuzz 会话的证据来得慢）。
 */
export const RESEARCH_MEMORY_KINDS: readonly MemoryKind[] = ['research-log', 'vuln-pattern', 'tool-combo'];

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  content: string;
  /** 来源（哪次任务/哪天）。reminder 必填（§7.3 红线：不许编造）。 */
  source?: string;
  /** 提醒产生日期 YYYY-MM-DD（投影保真：还原标注用）。 */
  date?: string;
  createdAt: number;
  lastTouchedAt: number;
  /** ms epoch；undefined = 长期。 */
  expiresAt?: number;
  /** 情感重量 0..1（越痛的教训越高）。 */
  salience: number;
  /** 被用上/帮了忙的反馈计数。 */
  usefulness: number;
}

export interface PutEntryInput {
  kind: MemoryKind;
  content: string;
  source?: string;
  /** 提醒产生日期 YYYY-MM-DD。 */
  date?: string;
  expiresAt?: number;
  salience?: number;
}

/** 每 kind 条目上限（被挤掉的进 archive，残差守恒）。 */
const KIND_CAPS: Record<MemoryKind, number> = {
  'user-model': 4,
  'self-model': 4,
  routines: 8,
  reminder: 60,
  'research-log': 60,
  'vuln-pattern': 20,
  'tool-combo': 20,
};

/** recencyDecay 半衰期（天）：叙事类记忆长寿，提醒与研究流水短寿，
 *  漏洞模式是长期经验（90 天），工具组合随生态演进（60 天）。 */
const HALF_LIFE_DAYS: Record<MemoryKind, number> = {
  'user-model': 90,
  'self-model': 90,
  routines: 60,
  reminder: 14,
  'research-log': 14,
  'vuln-pattern': 90,
  'tool-combo': 60,
};

// ===== Pure helpers（可测，不依赖引擎） =====

/** 时间衰减系数：1 → 0.5 → 0.25…（按半衰期）。 */
export function recencyDecay(lastTouchedAt: number, halfLifeDays: number, now: number): number {
  const elapsedDays = Math.max(0, (now - lastTouchedAt) / 86_400_000);
  return Math.pow(0.5, elapsedDays / halfLifeDays);
}

/** 有效分：上浮下沉的排序依据。 */
export function effectiveScore(e: MemoryEntry, now: number): number {
  return e.salience * recencyDecay(e.lastTouchedAt, HALF_LIFE_DAYS[e.kind], now) * e.usefulness;
}

export function isExpired(e: MemoryEntry, now: number): boolean {
  return typeof e.expiresAt === 'number' && e.expiresAt < now;
}

/** 内容的稳定去重键（同义重复合并用）：小写、去空白、截前 80。 */
export function contentKey(content: string): string {
  return content.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * 字符级相似度（Dice 系数 on bigrams）：语言无关，对中文同样有效。
 * 范围 0~1。用于「近似去重」——精确 contentKey 之外的兜底，
 * 让「…验收二字表明…」与「…验收表明…：用…」这类近义记忆合并而非并存。
 */
export function diceSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const sa = norm(a);
  const sb = norm(b);
  if (sa === sb) return 1;
  if (!sa || !sb) return 0;
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const A = bigrams(sa);
  const B = bigrams(sb);
  let overlap = 0;
  for (const [g, ca] of A) {
    const cb = B.get(g);
    if (cb) overlap += Math.min(ca, cb);
  }
  return (2 * overlap) / (sa.length - 1 + (sb.length - 1));
}

/** 近似去重阈值：取 0.82。实测数据中 0.846 的「进行中事项」近义对会被合并，
 *  而 0.72 的 user-model、0.70/0.43 的 self-model 近义对被保留（确为不同记忆），
 *  余量充足，不会误合并。 */
export const SIMILARITY_THRESHOLD = 0.82;

// ===== SQLite engine =====

interface SqliteStatement {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
}

interface SqliteDatabase {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
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

const dbCache = new Map<string, SqliteDatabase>();

/**
 * 启动探测（1.4.6 环境坑防护）：better-sqlite3 可加载性检查——ABI 不匹配
 * （如用系统 node 而非 bundled node 起 sidecar,cJSON dogfood 第 2 轮实证:
 * 137/127 不匹配导致 research_log 全挂）时在启动期显式暴露,不再等第一次
 * research_log/情报查询调用才暴雷。同一 .node 构建,本探测覆盖 memory /
 * expert / intel 三库的加载前提。
 */
export function probeSqliteAvailable(): { ok: boolean; error?: string } {
  try {
    loadSqlite();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function openDb(baseDir: string): SqliteDatabase {
  const cached = dbCache.get(baseDir);
  if (cached) return cached;
  const Database = loadSqlite();
  const dbPath = join(baseDir, 'memory.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = Database(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT,
      date TEXT,
      created_at INTEGER NOT NULL,
      last_touched_at INTEGER NOT NULL,
      expires_at INTEGER,
      salience REAL NOT NULL,
      usefulness REAL NOT NULL,
      content_key TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind, expires_at);
    CREATE INDEX IF NOT EXISTS idx_memories_content_key ON memories(kind, content_key);
    CREATE TABLE IF NOT EXISTS archive (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT,
      date TEXT,
      created_at INTEGER NOT NULL,
      last_touched_at INTEGER NOT NULL,
      expires_at INTEGER,
      salience REAL NOT NULL,
      usefulness REAL NOT NULL,
      content_key TEXT NOT NULL,
      evicted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS trust_events (
      ts INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      task_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      score_after INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trust_ts ON trust_events(ts);
    CREATE TABLE IF NOT EXISTS trust_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS recall_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      memory_id TEXT NOT NULL,
      query TEXT,
      settled INTEGER NOT NULL DEFAULT 0,
      outcome TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recall_settled ON recall_events(settled, ts);
    CREATE INDEX IF NOT EXISTS idx_recall_memory ON recall_events(memory_id);
    CREATE TABLE IF NOT EXISTS gap_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      gap_key TEXT NOT NULL,
      detail TEXT,
      context TEXT,
      resolution TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gap_key ON gap_events(gap_key, ts);
    CREATE TABLE IF NOT EXISTS research_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      workspace TEXT NOT NULL,
      task_kind TEXT NOT NULL,
      outcome TEXT NOT NULL,
      bug_class TEXT,
      summary TEXT NOT NULL,
      trajectory_ref TEXT,
      distilled_at INTEGER,
      expert_refs TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_research_events_query ON research_events(task_kind, outcome, ts);
    INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
  `);
  // D3：research_events 加蒸馏结算列——老库（D1 时期建的表）走 ALTER，新库 CREATE 已含。幂等。
  try {
    const cols = db.prepare('PRAGMA table_info(research_events)').all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some((c) => c.name === 'distilled_at')) {
      db.exec('ALTER TABLE research_events ADD COLUMN distilled_at INTEGER');
    }
  } catch (err) {
    console.warn('[memory/store] research_events.distilled_at migration failed (non-fatal):', err);
  }
  // 1.2.2：research_events 加专家引用列（expert_refs，逗号分隔条目 id）——同
  // distilled_at 的幂等 ALTER 先例：老库走 ALTER，新库 CREATE 已含。
  try {
    const cols = db.prepare('PRAGMA table_info(research_events)').all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some((c) => c.name === 'expert_refs')) {
      db.exec('ALTER TABLE research_events ADD COLUMN expert_refs TEXT');
    }
  } catch (err) {
    console.warn('[memory/store] research_events.expert_refs migration failed (non-fatal):', err);
  }
  migrateLegacy(baseDir, db);
  dbCache.set(baseDir, db);
  return db;
}

/** Test-only: close all cached handles（WAL 锁随之释放）并清空连接缓存。
 *  不删数据——持久化语义就是数据必须活过连接重置。 */
export function resetMemoryStoreForTest(): void {
  for (const db of dbCache.values()) {
    try {
      db.close();
    } catch { /* ignore */ }
  }
  dbCache.clear();
}

// ===== Row mapping =====

interface Row {
  id: string;
  kind: MemoryKind;
  content: string;
  source: string | null;
  date: string | null;
  created_at: number;
  last_touched_at: number;
  expires_at: number | null;
  salience: number;
  usefulness: number;
  content_key: string;
}

function toEntry(r: Row): MemoryEntry {
  return {
    id: r.id,
    kind: r.kind,
    content: r.content,
    ...(r.source != null ? { source: r.source } : {}),
    ...(r.date != null ? { date: r.date } : {}),
    createdAt: r.created_at,
    lastTouchedAt: r.last_touched_at,
    ...(r.expires_at != null ? { expiresAt: r.expires_at } : {}),
    salience: r.salience,
    usefulness: r.usefulness,
  };
}

let idCounter = 0;
function newId(kind: MemoryKind): string {
  return `mem-${kind}-${Date.now().toString(36)}-${(++idCounter).toString(36)}`;
}

// ===== Public API（与 entries.jsonl 时代完全同构） =====

/**
 * 覆盖式写入一条"权威文档"类记忆（蒸馏弧的 user-model / self-model / routines）。
 *
 * 与 putEntry（多条竞争、近似合并、kind 上限挤占）语义不同：蒸馏物是每次整体
 * 重写的单一权威视图——新版本完全取代旧版本，旧版本没有"并存被 search/judge
 * 继续召回"的价值。因此写入新版本前，先把该 kind 现存条目整体归档进 archive
 * （残差守恒：不是丢弃，是压缩），保证该 kind 恒有且只有一条活跃条目。
 *
 * 这样 readDistilled 取该 kind 唯一一条 = 蒸馏弧最新产出，天然不受 usefulness
 * 反馈干扰（judge 只会作用于当前权威，不会喂给过时条目）。
 */
export function putDistilledEntry(
  input: PutEntryInput,
  baseDir: string = getZhiShiDataDir(),
  now: number = Date.now(),
): MemoryEntry {
  const db = openDb(baseDir);
  // 1. 归档该 kind 现存所有条目（新版本取代旧版本，旧版进 archive 而非删除）。
  const rows = db.prepare('SELECT * FROM memories WHERE kind = ?').all(input.kind) as Row[];
  if (rows.length > 0) {
    const insertArchive = db.prepare(
      `INSERT OR REPLACE INTO archive (id, kind, content, source, date, created_at, last_touched_at, expires_at, salience, usefulness, content_key, evicted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const deleteRow = db.prepare('DELETE FROM memories WHERE id = ?');
    for (const r of rows.map(toEntry)) {
      insertArchive.run(
        r.id, r.kind, r.content, r.source ?? null, r.date ?? null,
        r.createdAt, r.lastTouchedAt, r.expiresAt ?? null, r.salience, r.usefulness,
        contentKey(r.content), now,
      );
      deleteRow.run(r.id);
    }
  }
  // 2. 该 kind 已空，putEntry 必然走 INSERT（新建），恒 1 条。
  return putEntry(input, baseDir, now);
}

/**
 * 按 key 覆盖式写入一条蒸馏记忆（安全蒸馏弧 D3 的存储模式，§1.4）。
 *
 * 与 putDistilledEntry 同哲学——新版本完全取代旧版本，旧版进 archive（残差
 * 守恒）；差别在覆盖范围：putDistilledEntry 按 kind 整体覆盖（该 kind 恒 1 条），
 * 这里按 (kind, key) 覆盖——同一 kind 下允许不同 key 的权威条目并存
 * （如 vuln-pattern 下「成功路径」与「失败根因」两个蒸馏分节）。key 存 source 列。
 *
 * 刻意跳过 putEntry 的 contentKey/近似合并：蒸馏写入是权威替换，不该被同 kind
 * 其它 key 的相似内容"合并"掉（那会把两个分节压成一条）。
 */
export function putKeyedDistilledEntry(
  input: PutEntryInput,
  key: string,
  baseDir: string = getZhiShiDataDir(),
  now: number = Date.now(),
): MemoryEntry {
  const db = openDb(baseDir);
  // 1. 归档同 (kind, key) 现存条目（旧版进 archive 而非删除）。
  const rows = db.prepare('SELECT * FROM memories WHERE kind = ? AND source = ?').all(input.kind, key) as Row[];
  if (rows.length > 0) {
    const insertArchive = db.prepare(
      `INSERT OR REPLACE INTO archive (id, kind, content, source, date, created_at, last_touched_at, expires_at, salience, usefulness, content_key, evicted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const deleteRow = db.prepare('DELETE FROM memories WHERE id = ?');
    for (const r of rows.map(toEntry)) {
      insertArchive.run(
        r.id, r.kind, r.content, r.source ?? null, r.date ?? null,
        r.createdAt, r.lastTouchedAt, r.expiresAt ?? null, r.salience, r.usefulness,
        contentKey(r.content), now,
      );
      deleteRow.run(r.id);
    }
  }
  // 2. 直接 INSERT 新版本（权威替换，不走近似合并）。
  const entry: MemoryEntry = {
    id: newId(input.kind),
    kind: input.kind,
    content: input.content,
    source: key,
    ...(input.date !== undefined ? { date: input.date } : {}),
    createdAt: now,
    lastTouchedAt: now,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    salience: input.salience ?? 0.5,
    usefulness: 1.0,
  };
  db.prepare(
    `INSERT INTO memories (id, kind, content, source, date, created_at, last_touched_at, expires_at, salience, usefulness, content_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id, entry.kind, entry.content, key, entry.date ?? null,
    entry.createdAt, entry.lastTouchedAt, entry.expiresAt ?? null,
    entry.salience, entry.usefulness, contentKey(entry.content),
  );
  // 3. kind 上限挤兑照 putEntry（新条目参与竞争，最低分进 archive）。
  //    与 putEntry 的挤兑块同构——刻意复制而非抽公共：putEntry 是热路径，
  //    不为这条冷路径改动它。
  const sameKind = (db.prepare('SELECT * FROM memories WHERE kind = ?').all(input.kind) as Row[]).map(toEntry);
  const cap = KIND_CAPS[input.kind];
  if (sameKind.length > cap) {
    const sorted = [...sameKind].sort((a, b) => effectiveScore(a, now) - effectiveScore(b, now));
    const evicted = sorted.slice(0, sameKind.length - cap);
    const insertArchive = db.prepare(
      `INSERT OR REPLACE INTO archive (id, kind, content, source, date, created_at, last_touched_at, expires_at, salience, usefulness, content_key, evicted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const deleteRow = db.prepare('DELETE FROM memories WHERE id = ?');
    for (const e of evicted) {
      insertArchive.run(
        e.id, e.kind, e.content, e.source ?? null, e.date ?? null,
        e.createdAt, e.lastTouchedAt, e.expiresAt ?? null, e.salience, e.usefulness,
        contentKey(e.content), now,
      );
      deleteRow.run(e.id);
    }
  }
  return entry;
}

/** 取某 kind 下指定 key 的当前权威条目（最近一次写入）——安全蒸馏产物的读取口。 */
export function latestKeyedDistilledEntry(
  kind: MemoryKind,
  key: string,
  baseDir: string = getZhiShiDataDir(),
): MemoryEntry | undefined {
  const rows = db(baseDir)
    .prepare('SELECT * FROM memories WHERE kind = ? AND source = ? ORDER BY created_at DESC LIMIT 1')
    .all(kind, key) as Row[];
  return rows.length > 0 ? toEntry(rows[0]) : undefined;
}

/**
 * 写入/合并一条记忆。同 kind + 同 contentKey 的条目合并（刷新内容、
 * touch、取 salience 高值）；超 kind 上限时按有效分挤掉最低者（进 archive）。
 */
export function putEntry(input: PutEntryInput, baseDir: string = getZhiShiDataDir(), now: number = Date.now()): MemoryEntry {
  const db = openDb(baseDir);
  const key = contentKey(input.content);
  let existing = db
    .prepare('SELECT * FROM memories WHERE kind = ? AND content_key = ? LIMIT 1')
    .get(input.kind, key) as Row | undefined;

  // 近似去重：精确键未命中时，扫描同 kind 的现存记忆，找出最相似的；
  // 超过阈值则视为同一条，合并而非新增（保留信息更完整的一方）。
  if (!existing) {
    const rows = db.prepare('SELECT * FROM memories WHERE kind = ?').all(input.kind) as Row[];
    let best: Row | undefined;
    let bestSim = SIMILARITY_THRESHOLD;
    for (const r of rows) {
      const sim = diceSimilarity(input.content, r.content);
      if (sim >= bestSim) {
        bestSim = sim;
        best = r;
      }
    }
    existing = best;
  }

  let entry: MemoryEntry;
  if (existing) {
    const salience = input.salience !== undefined ? Math.max(existing.salience, input.salience) : existing.salience;
    // 近似合并时保留信息更完整的一方（内容更长者），避免较短的覆盖较长的。
    const mergedContent = input.content.length >= existing.content.length ? input.content : existing.content;
    db.prepare(
      `UPDATE memories SET content = ?, last_touched_at = ?, source = ?, date = ?, expires_at = ?, salience = ? WHERE id = ?`,
    ).run(
      mergedContent,
      now,
      input.source ?? existing.source,
      input.date ?? existing.date,
      input.expiresAt !== undefined ? input.expiresAt : existing.expires_at,
      salience,
      existing.id,
    );
    entry = {
      ...toEntry(existing),
      content: mergedContent,
      lastTouchedAt: now,
      salience,
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.date !== undefined ? { date: input.date } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
  } else {
    entry = {
      id: newId(input.kind),
      kind: input.kind,
      content: input.content,
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.date !== undefined ? { date: input.date } : {}),
      createdAt: now,
      lastTouchedAt: now,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      salience: input.salience ?? 0.5,
      usefulness: 1.0,
    };
    db.prepare(
      `INSERT INTO memories (id, kind, content, source, date, created_at, last_touched_at, expires_at, salience, usefulness, content_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.id,
      entry.kind,
      entry.content,
      entry.source ?? null,
      entry.date ?? null,
      entry.createdAt,
      entry.lastTouchedAt,
      entry.expiresAt ?? null,
      entry.salience,
      entry.usefulness,
      key,
    );
  }

  // kind 上限：挤掉有效分最低者（新条目本身参与竞争），进 archive。
  const sameKind = (db.prepare('SELECT * FROM memories WHERE kind = ?').all(input.kind) as Row[]).map(toEntry);
  const cap = KIND_CAPS[input.kind];
  if (sameKind.length > cap) {
    const sorted = [...sameKind].sort((a, b) => effectiveScore(a, now) - effectiveScore(b, now));
    const evicted = sorted.slice(0, sameKind.length - cap);
    const insertArchive = db.prepare(
      `INSERT OR REPLACE INTO archive (id, kind, content, source, date, created_at, last_touched_at, expires_at, salience, usefulness, content_key, evicted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const deleteRow = db.prepare('DELETE FROM memories WHERE id = ?');
    for (const e of evicted) {
      insertArchive.run(
        e.id, e.kind, e.content, e.source ?? null, e.date ?? null,
        e.createdAt, e.lastTouchedAt, e.expiresAt ?? null, e.salience, e.usefulness,
        contentKey(e.content), now,
      );
      deleteRow.run(e.id);
    }
  }

  return entry;
}

/**
 * 一次性存量去重：对库中现存记忆做同 kind 两两近似比对，把超过阈值的近义
 * 条目合并（保留更长内容、max salience、刷新 touch），删除被合并者。
 * 用于清理历史上精确键未能拦住的重复（如 8-01 蒸馏弧写入的近似记忆）。
 * 在 migrateLegacy 里调用一次即可，幂等。
 */
export function consolidateMemories(baseDir: string = getZhiShiDataDir(), now: number = Date.now(), database?: SqliteDatabase): number {
  const db = database ?? openDb(baseDir);
  // 只对四类认知 kind 做存量近似去重。安全类（research-log/vuln-pattern/
  // tool-combo）刻意排除：安全蒸馏弧的 keyed 权威条目同 kind 并存多条
  // （如 vuln-pattern 下的「成功路径」与「失败根因」两节），近似合并会把
  // 两个分节压成一条，破坏 keyed 覆盖不变量。
  const kinds: MemoryKind[] = ['user-model', 'self-model', 'routines', 'reminder'];
  let merged = 0;
  for (const kind of kinds) {
    const rows = db.prepare('SELECT * FROM memories WHERE kind = ?').all(kind) as Row[];
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i];
      if (!a) continue;
      for (let j = i + 1; j < rows.length; j++) {
        const b = rows[j];
        if (!b) continue;
        const sim = diceSimilarity(a.content, b.content);
        if (sim < SIMILARITY_THRESHOLD) continue;
        // 合并 b → a：保留更长内容、更高 salience、更新 touch。
        const keep = a.content.length >= b.content.length ? a : b;
        const drop = keep === a ? b : a;
        const salience = Math.max(a.salience, b.salience);
        const mergedContent = keep.content;
        db
          .prepare('UPDATE memories SET content = ?, last_touched_at = ?, salience = ? WHERE id = ?')
          .run(mergedContent, now, salience, keep.id);
        db.prepare('DELETE FROM memories WHERE id = ?').run(drop.id);
        // 标记被删的那个为 undefined，外层循环跳过。
        if (drop === a) rows[i] = undefined as unknown as Row;
        else rows[j] = undefined as unknown as Row;
        merged++;
      }
    }
  }
  if (merged > 0) console.log(`[memory/store] consolidated ${merged} duplicate memorie(s)`);
  return merged;
}

/** 某 kind 的活跃条目（未过期），按有效分降序。 */
export function listActive(kind: MemoryKind, baseDir: string = getZhiShiDataDir(), now: number = Date.now()): MemoryEntry[] {
  const rows = db(baseDir)
    .prepare('SELECT * FROM memories WHERE kind = ? AND (expires_at IS NULL OR expires_at >= ?)')
    .all(kind, now) as Row[];
  return rows.map(toEntry).sort((a, b) => effectiveScore(b, now) - effectiveScore(a, now));
}

/**
 * 取蒸馏物（user-model / self-model / routines）的当前权威条目。
 *
 * 蒸馏物是每次整体重写的单一权威——新版本完全取代旧版本。权威 = **蒸馏弧最近
 * 写入的那条**（created_at 最大），而非 effectiveScore 最高（那会把 judge 反馈攒
 * 高的旧条目选上来，旧版已不反映当前认知）。
 *
 * putDistilledEntry 保证写入后每 kind 恒 1 条，created_at 即最近写入时刻；这里
 * 用 created_at 取最新是对遗留多条数据（旧版本未归档期）的兜底，也让语义自洽：
 * "权威 = 最近一次蒸馏产出"。
 */
export function latestDistilledEntry(
  kind: 'user-model' | 'self-model' | 'routines',
  baseDir: string = getZhiShiDataDir(),
): MemoryEntry | undefined {
  const rows = db(baseDir)
    .prepare('SELECT * FROM memories WHERE kind = ? ORDER BY created_at DESC LIMIT 1')
    .all(kind) as Row[];
  return rows.length > 0 ? toEntry(rows[0]) : undefined;
}

/** 反馈：touch（刷新 lastTouched）+ usefulness/salience 反馈（§6.2 学习循环）。 */
export function touchEntry(
  id: string,
  opts: { usefulnessDelta?: number; salienceDelta?: number } = {},
  baseDir: string = getZhiShiDataDir(),
  now: number = Date.now(),
): void {
  const database = db(baseDir);
  const row = database.prepare('SELECT * FROM memories WHERE id = ? LIMIT 1').get(id) as Row | undefined;
  if (!row) return;
  const usefulness = opts.usefulnessDelta
    ? Math.max(0.2, Math.min(5, row.usefulness + opts.usefulnessDelta))
    : row.usefulness;
  const salience = opts.salienceDelta
    ? Math.max(0, Math.min(1, row.salience + opts.salienceDelta))
    : row.salience;
  database
    .prepare('UPDATE memories SET last_touched_at = ?, usefulness = ?, salience = ? WHERE id = ?')
    .run(now, usefulness, salience, id);
}

/** 按 contentKey 查找某 kind 的条目（反馈路由用——UI 侧只有文本）。 */
export function findByContent(kind: MemoryKind, content: string, baseDir: string = getZhiShiDataDir()): MemoryEntry | undefined {
  const row = db(baseDir)
    .prepare('SELECT * FROM memories WHERE kind = ? AND content_key = ? LIMIT 1')
    .get(kind, contentKey(content)) as Row | undefined;
  return row ? toEntry(row) : undefined;
}

/** 记忆检索（阶段4）：kind 过滤 + 文本/来源匹配 + 有效分排序。 */
export function searchEntries(
  query: string,
  opts: { kinds?: MemoryKind[]; limit?: number } = {},
  baseDir: string = getZhiShiDataDir(),
  now: number = Date.now(),
): MemoryEntry[] {
  const q = query.trim().toLowerCase();
  const limit = opts.limit ?? 10;
  const rows = db(baseDir)
    .prepare('SELECT * FROM memories WHERE (expires_at IS NULL OR expires_at >= ?)')
    .all(now) as Row[];
  let entries = rows.map(toEntry);
  if (opts.kinds) entries = entries.filter((e) => opts.kinds!.includes(e.kind));
  if (q.length > 0) {
    entries = entries.filter(
      (e) => e.content.toLowerCase().includes(q) || (e.source ?? '').toLowerCase().includes(q),
    );
  }
  return entries.sort((a, b) => effectiveScore(b, now) - effectiveScore(a, now)).slice(0, limit);
}

/** 按 contentKey 保留 reminders——蒸馏弧的全量重写是滚动维护的权威视图：
 *  从输出里消失的提醒视为已兑现/过时，移出（进 archive，残差守恒）。 */
export function retainReminders(keys: Set<string>, baseDir: string = getZhiShiDataDir(), now: number = Date.now()): void {
  const database = db(baseDir);
  const rows = database.prepare('SELECT * FROM memories WHERE kind = ?').all('reminder') as Row[];
  const evicted = rows.filter((r) => !keys.has(r.content_key));
  if (evicted.length === 0) return;
  const insertArchive = database.prepare(
    `INSERT OR REPLACE INTO archive (id, kind, content, source, date, created_at, last_touched_at, expires_at, salience, usefulness, content_key, evicted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteRow = database.prepare('DELETE FROM memories WHERE id = ?');
  for (const e of evicted.map(toEntry)) {
    insertArchive.run(
      e.id, e.kind, e.content, e.source ?? null, e.date ?? null,
      e.createdAt, e.lastTouchedAt, e.expiresAt ?? null, e.salience, e.usefulness,
      contentKey(e.content), now,
    );
    deleteRow.run(e.id);
  }
}

/** 全量快照（迁移/调试）。 */
export function allEntries(baseDir: string = getZhiShiDataDir()): MemoryEntry[] {
  const rows = db(baseDir).prepare('SELECT * FROM memories').all() as Row[];
  return rows.map(toEntry);
}

// ===== 土匪回路（recall loop）：检索命中 → 日志 → 效果门控结算 =====
// 原则（memory_distill_llm_rl.md §3）：被展示≠有效——命中只记日志不动分；
// 结算由蒸馏弧 judge 做：wrong 重罚（>effective 的奖）、effective 弱正、
// unused 不动（recencyDecay 的时间衰减就是"没用"的价）。

export type RecallOutcome = 'effective' | 'wrong' | 'unused';

export interface RecallEvent {
  id: number;
  ts: number;
  memoryId: string;
  query: string | null;
  outcome: RecallOutcome | null;
  /** 联表带出的记忆内容（含已归档的；记忆本体被物理删除时为空）。 */
  memoryContent?: string;
}

interface RecallRow {
  id: number;
  ts: number;
  memory_id: string;
  query: string | null;
  outcome: string | null;
  content: string | null;
}

function toRecallEvent(r: RecallRow): RecallEvent {
  return {
    id: r.id,
    ts: r.ts,
    memoryId: r.memory_id,
    query: r.query,
    outcome: (r.outcome as RecallOutcome | null) ?? null,
    ...(r.content != null ? { memoryContent: r.content } : {}),
  };
}

/** 检索命中落日志（每次 search 返回什么就记什么——展示本身不改变任何分值）。 */
export function logRecallEvents(
  memoryIds: string[],
  query: string,
  baseDir: string = getZhiShiDataDir(),
  now: number = Date.now(),
): void {
  if (memoryIds.length === 0) return;
  const insert = db(baseDir).prepare(
    'INSERT INTO recall_events (ts, memory_id, query) VALUES (?, ?, ?)',
  );
  for (const id of memoryIds) insert.run(now, id, query || null);
}

/** 蒸馏弧 judge 原料：过了宽限期（用户来得及反驳）仍未结算的事件，带记忆内容。
 *  kindFilter：按记忆 kind 分流（D3）——认知弧传 exclude 安全类、安全蒸馏弧传
 *  include 安全类，两条弧各结各的账（安全类要 24h 证据窗，主弧的 2h 窗对长
 *  fuzz 会话不够）。记忆本体已物理删除（kind 未知）的事件不受 exclude 影响，
 *  仍交给「无内容 → unused」的兜底分支。 */
export function listUnsettledRecalls(
  graceMs: number,
  limit: number = 20,
  baseDir: string = getZhiShiDataDir(),
  now: number = Date.now(),
  kindFilter?: { include?: readonly MemoryKind[]; exclude?: readonly MemoryKind[] },
): RecallEvent[] {
  const clauses = ['r.settled = 0', 'r.ts <= ?'];
  const params: unknown[] = [now - graceMs];
  const kindExpr = 'COALESCE(m.kind, a.kind)';
  if (kindFilter?.include?.length) {
    clauses.push(`${kindExpr} IN (${kindFilter.include.map(() => '?').join(',')})`);
    params.push(...kindFilter.include);
  }
  if (kindFilter?.exclude?.length) {
    clauses.push(`(${kindExpr} IS NULL OR ${kindExpr} NOT IN (${kindFilter.exclude.map(() => '?').join(',')}))`);
    params.push(...kindFilter.exclude);
  }
  const rows = db(baseDir)
    .prepare(
      `SELECT r.id, r.ts, r.memory_id, r.query, r.outcome,
              COALESCE(m.content, a.content) AS content
       FROM recall_events r
       LEFT JOIN memories m ON m.id = r.memory_id
       LEFT JOIN archive a ON a.id = r.memory_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY r.ts ASC
       LIMIT ?`,
    )
    .all(...params, limit) as RecallRow[];
  return rows.map(toRecallEvent);
}

/** 效果门控结算：wrong 重罚 / effective 弱正 / unused 不动分（衰减自会收拾它）。
 *  skipDelta：同一记忆在同一 tick 已结过账时，只记 outcome 不重复罚/奖
 *  （一次错误=一次结算——N 条检索事件指向同一条记忆，不能按 N 倍罚）。 */
export function settleRecallEvent(
  eventId: number,
  outcome: RecallOutcome,
  baseDir: string = getZhiShiDataDir(),
  now: number = Date.now(),
  skipDelta: boolean = false,
): void {
  const database = db(baseDir);
  const row = database
    .prepare('SELECT memory_id FROM recall_events WHERE id = ? AND settled = 0 LIMIT 1')
    .get(eventId) as { memory_id: string } | undefined;
  if (!row) return;
  database
    .prepare('UPDATE recall_events SET settled = 1, outcome = ? WHERE id = ?')
    .run(outcome, eventId);
  if (skipDelta) return;
  if (outcome === 'effective') {
    touchEntry(row.memory_id, { usefulnessDelta: 0.2 }, baseDir, now);
  } else if (outcome === 'wrong') {
    // recalledButWrong 的惩罚必须重于 recalledAndEffective 的奖励（框架 §3）：
    // 写错一条会被未来无数次引用、持续反塑行为，比漏记危险得多。
    touchEntry(row.memory_id, { usefulnessDelta: -1.0, salienceDelta: -0.2 }, baseDir, now);
  }
}

/** 错记忆史（judge / 蒸馏的上下文学习原料）：曾被判错的记忆，最新在前、按记忆去重。 */
export function listWrongMemories(
  limit: number = 8,
  baseDir: string = getZhiShiDataDir(),
): Array<{ memoryId: string; content: string; ts: number }> {
  const rows = db(baseDir)
    .prepare(
      `SELECT r.memory_id, MAX(r.ts) AS ts, COALESCE(m.content, a.content) AS content
       FROM recall_events r
       LEFT JOIN memories m ON m.id = r.memory_id
       LEFT JOIN archive a ON a.id = r.memory_id
       WHERE r.outcome = 'wrong'
       GROUP BY r.memory_id
       ORDER BY ts DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ memory_id: string; ts: number; content: string | null }>;
  return rows
    .filter((r) => r.content != null)
    .map((r) => ({ memoryId: r.memory_id, content: r.content as string, ts: r.ts }));
}

/**
 * judge 判错查询（1.2.4 D4 深化，注入侧降权用）：keyed 蒸馏产物的当前版本
 * 是否被 recall judge 判过 wrong。两条证据路径：
 * - live 条目本身有 wrong 结算（recall_events 直接指着当前版本）；
 * - 当前内容与某个被判 wrong 的 archive 旧版内容一致（content_key 相同——
 *   判错后蒸馏弧没改掉这段内容，它仍在反喂错误经验）。
 * 条目不存在 / 无 wrong 记录 → false（不误伤未判过的分节）。
 */
export function keyedDistilledEntryJudgedWrong(
  kind: MemoryKind,
  key: string,
  baseDir: string = getZhiShiDataDir(),
): boolean {
  const live = latestKeyedDistilledEntry(kind, key, baseDir);
  if (!live) return false;
  const database = db(baseDir);
  const liveWrong = database
    .prepare("SELECT COUNT(*) AS c FROM recall_events WHERE memory_id = ? AND outcome = 'wrong'")
    .get(live.id) as { c: number };
  if (liveWrong.c > 0) return true;
  const archivedSame = database
    .prepare(
      `SELECT COUNT(*) AS c FROM recall_events r
       JOIN archive a ON a.id = r.memory_id
       WHERE r.outcome = 'wrong' AND a.kind = ? AND a.source = ? AND a.content_key = ?`,
    )
    .get(kind, key, contentKey(live.content)) as { c: number };
  return archivedSame.c > 0;
}

// ===== 能力缺口（gap_events）：缺工具/缺能力事件 → 复发计数 → 阶梯升级凭据 =====
// WORK_LOOP §5/§7：缺口是环上的一等事件。记录本身不改任何分值——价值在
// 复发计数：同一个 gap_key 反复出现 = "沉淀造/提 PRD"的凭据（不靠感觉）。
// 结算不需要 LLM judge（resolution 在记录时就是事实），所以这里没有
// settle 循环，只有"记 + 数"。

export type GapResolution = 'searched' | 'improvised' | 'abandoned';

export interface GapRecurrence {
  gapKey: string;
  count: number;
  latestTs: number;
  /** 最近一次事件的细节（报错/描述原文），给蒸馏/提议当人话原料。 */
  latestDetail: string | null;
}

/** 记一条能力缺口事件。gapKey 由调用方给出语义化描述（如
 *  `unknown-skill:xxx`），内部过 contentKey 归一化保证同义合并。 */
export function logGapEvent(
  gap: { gapKey: string; detail?: string; context?: string; resolution?: GapResolution },
  baseDir: string = getZhiShiDataDir(),
  now: number = Date.now(),
): void {
  const key = contentKey(gap.gapKey);
  if (!key) return;
  db(baseDir)
    .prepare('INSERT INTO gap_events (ts, gap_key, detail, context, resolution) VALUES (?, ?, ?, ?, ?)')
    .run(now, key, gap.detail ?? null, gap.context ?? null, gap.resolution ?? null);
}

/** 复发计数：窗口内按 gap_key 聚合，按次数降序。蒸馏弧/提议层的原料——
 *  "这个缺口出现了 N 次"就是能力雷达。 */
export function listGapRecurrences(opts?: {
  windowMs?: number;
  minCount?: number;
  limit?: number;
  baseDir?: string;
  now?: number;
}): GapRecurrence[] {
  const windowMs = opts?.windowMs ?? 7 * 24 * 3600_000;
  const minCount = opts?.minCount ?? 1;
  const limit = opts?.limit ?? 20;
  const now = opts?.now ?? Date.now();
  const baseDir = opts?.baseDir ?? getZhiShiDataDir();
  const rows = db(baseDir)
    .prepare(
      `SELECT gap_key, COUNT(*) AS count, MAX(ts) AS latest_ts,
              (SELECT detail FROM gap_events g2
                WHERE g2.gap_key = g.gap_key ORDER BY ts DESC LIMIT 1) AS latest_detail
       FROM gap_events g
       WHERE ts >= ?
       GROUP BY gap_key
       HAVING COUNT(*) >= ?
       ORDER BY count DESC, latest_ts DESC
       LIMIT ?`,
    )
    .all(now - windowMs, minCount, limit) as Array<{
      gap_key: string; count: number; latest_ts: number; latest_detail: string | null;
    }>;
  return rows.map((r) => ({
    gapKey: r.gap_key,
    count: r.count,
    latestTs: r.latest_ts,
    latestDetail: r.latest_detail,
  }));
}

// ===== 研究成败信号（research_events，安全研究员版 P1 D1） =====
// 安全蒸馏闭环的原料：「拿 flag 成功/失败、卡在哪、哪个工具组合有效」
// 从自由文本落成结构化记录。记录本身不改任何分值——价值在聚合（哪种
// task_kind 卡得多、哪个 bug_class 收成好），所以这里没有 settle 循环，
// 只有"记 + 查"。
// 枚举定义在 shared/research-kinds.ts（1.2.3 迁移，issue #5）；这里 re-export
// 保持既有引用路径（admin-api / loop / report / CLI 之外的全部消费方）零改动。

export {
  isResearchBugClass,
  isResearchOutcome,
  isResearchTaskKind,
  RESEARCH_BUG_CLASSES,
  RESEARCH_OUTCOMES,
  RESEARCH_TASK_KINDS,
};
export type { ResearchBugClass, ResearchOutcome, ResearchTaskKind };

export interface ResearchEvent {
  id: number;
  ts: number;
  workspace: string;
  taskKind: ResearchTaskKind;
  outcome: ResearchOutcome;
  bugClass?: ResearchBugClass;
  summary: string;
  /** 轨迹文件指针（工作区相对路径）。 */
  trajectoryRef?: string;
  /** 依据的专家条目 id 列表（1.2.2 引用追踪；expert.db 条目 id，落库时已查证存在）。 */
  expertRefs?: number[];
}

export interface RecordResearchEventInput {
  workspace: string;
  taskKind: ResearchTaskKind;
  outcome: ResearchOutcome;
  bugClass?: ResearchBugClass;
  summary: string;
  trajectoryRef?: string;
  expertRefs?: number[];
}

interface ResearchEventRow {
  id: number;
  ts: number;
  workspace: string;
  task_kind: string;
  outcome: string;
  bug_class: string | null;
  summary: string;
  trajectory_ref: string | null;
  expert_refs: string | null;
}

/** expert_refs 列（逗号分隔 id 串）→ id 数组；空/NULL → undefined。 */
function parseExpertRefs(raw: string | null): number[] | undefined {
  if (!raw) return undefined;
  const ids = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : undefined;
}

function toResearchEvent(r: ResearchEventRow): ResearchEvent {
  const expertRefs = parseExpertRefs(r.expert_refs);
  return {
    id: r.id,
    ts: r.ts,
    workspace: r.workspace,
    taskKind: r.task_kind as ResearchTaskKind,
    outcome: r.outcome as ResearchOutcome,
    ...(r.bug_class != null ? { bugClass: r.bug_class as ResearchBugClass } : {}),
    summary: r.summary,
    ...(r.trajectory_ref != null ? { trajectoryRef: r.trajectory_ref } : {}),
    ...(expertRefs ? { expertRefs } : {}),
  };
}

/** 记一条研究成败事件。非法枚举/空 workspace/空 summary 抛错（不落脏数据）。 */
export function recordResearchEvent(
  input: RecordResearchEventInput,
  baseDir: string = getZhiShiDataDir(),
  now: number = Date.now(),
): ResearchEvent {
  if (!input.workspace.trim()) throw new Error('research_events: workspace 不能为空');
  if (!isResearchTaskKind(input.taskKind)) {
    throw new Error(`research_events: 非法 task_kind "${input.taskKind}"（允许：${RESEARCH_TASK_KINDS.join(' / ')}）`);
  }
  if (!isResearchOutcome(input.outcome)) {
    throw new Error(`research_events: 非法 outcome "${input.outcome}"（允许：${RESEARCH_OUTCOMES.join(' / ')}）`);
  }
  if (input.bugClass !== undefined && !isResearchBugClass(input.bugClass)) {
    throw new Error(`research_events: 非法 bug_class "${input.bugClass}"（允许：${RESEARCH_BUG_CLASSES.join(' / ')}）`);
  }
  if (!input.summary.trim()) throw new Error('research_events: summary 不能为空');
  if (input.expertRefs !== undefined) {
    if (input.expertRefs.some((id) => !Number.isInteger(id) || id <= 0)) {
      throw new Error('research_events: expert_refs 必须是正整数条目 id 列表');
    }
    // record 层查证：引用的条目 id 必须存在于 expert.db（引用追踪的可审计性
    // 依赖这一拒——不存在的 id 落库等于假引用）。库不存在 → 全部缺失。
    const missing = findMissingExpertEntryIds(baseDir, input.expertRefs);
    if (missing.length > 0) {
      throw new Error(`research_events: expert_refs 含不存在的专家条目 id：${missing.join(', ')}（expert.db 中查无此条目）`);
    }
  }
  const database = db(baseDir);
  database.prepare(
    'INSERT INTO research_events (ts, workspace, task_kind, outcome, bug_class, summary, trajectory_ref, expert_refs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    now, input.workspace, input.taskKind, input.outcome, input.bugClass ?? null,
    input.summary, input.trajectoryRef ?? null,
    input.expertRefs && input.expertRefs.length > 0 ? input.expertRefs.join(',') : null,
  );
  const id = (database.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
  return toResearchEvent({
    id, ts: now, workspace: input.workspace, task_kind: input.taskKind, outcome: input.outcome,
    bug_class: input.bugClass ?? null, summary: input.summary, trajectory_ref: input.trajectoryRef ?? null,
    expert_refs: input.expertRefs && input.expertRefs.length > 0 ? input.expertRefs.join(',') : null,
  });
}

/** 按 id 取单条研究事件（只读；1.2.1 专家知识 promote-prefill 用）。 */
export function getResearchEventById(
  id: number,
  baseDir: string = getZhiShiDataDir(),
): ResearchEvent | null {
  const row = db(baseDir)
    .prepare('SELECT * FROM research_events WHERE id = ?')
    .get(id) as ResearchEventRow | undefined;
  return row ? toResearchEvent(row) : null;
}

/** 查询研究事件：taskKind/outcome 过滤，按时间倒序，limit 截断（默认 50）。 */
export function listResearchEvents(opts?: {
  taskKind?: ResearchTaskKind;
  outcome?: ResearchOutcome;
  limit?: number;
  baseDir?: string;
}): ResearchEvent[] {
  const limit = opts?.limit ?? 50;
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts?.taskKind) { clauses.push('task_kind = ?'); params.push(opts.taskKind); }
  if (opts?.outcome) { clauses.push('outcome = ?'); params.push(opts.outcome); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db(opts?.baseDir ?? getZhiShiDataDir())
    .prepare(`SELECT * FROM research_events ${where} ORDER BY ts DESC, id DESC LIMIT ?`)
    .all(...params, limit) as ResearchEventRow[];
  return rows.map(toResearchEvent);
}

/** 安全蒸馏弧（D3）原料：未结算（未蒸馏）的研究事件，按时间正序——老的先蒸馏。 */
export function listUndistilledResearchEvents(opts?: {
  limit?: number;
  baseDir?: string;
}): ResearchEvent[] {
  const limit = opts?.limit ?? 100;
  const rows = db(opts?.baseDir ?? getZhiShiDataDir())
    .prepare('SELECT * FROM research_events WHERE distilled_at IS NULL ORDER BY ts ASC, id ASC LIMIT ?')
    .all(limit) as ResearchEventRow[];
  return rows.map(toResearchEvent);
}

/**
 * 结算语义照认知弧的 recall 结算（写库即结算）：安全蒸馏弧把产物落库成功后，
 * 把本批输入事件标记已蒸馏（distilled_at）。LLM 调用/解析失败不标记——事件
 * 留在未结算队列里，下个 tick 重试。重复标记幂等（WHERE distilled_at IS NULL）。
 */
export function markResearchEventsDistilled(
  ids: number[],
  baseDir: string = getZhiShiDataDir(),
  now: number = Date.now(),
): void {
  if (ids.length === 0) return;
  const stmt = db(baseDir).prepare('UPDATE research_events SET distilled_at = ? WHERE id = ? AND distilled_at IS NULL');
  for (const id of ids) stmt.run(now, id);
}

// ===== 内部小工具 =====

function db(baseDir: string): SqliteDatabase {
  return openDb(baseDir);
}

/** trust.ts 等兄弟模块共用的 db 入口（同一 memory.db，同一连接缓存）。 */
export function openTrustDb(baseDir: string = getZhiShiDataDir()): SqliteDatabase {
  return openDb(baseDir);
}

export type { SqliteDatabase };

function migrateLegacy(baseDir: string, db: SqliteDatabase): void {
  // entries.jsonl → memories
  try {
    const count = (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c;
    const legacyPath = join(baseDir, 'memory', 'entries.jsonl');
    if (count === 0 && existsSync(legacyPath)) {
      const rows = readFileSync(legacyPath, 'utf-8')
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as MemoryEntry & { date?: string });
      const insert = db.prepare(
        `INSERT OR IGNORE INTO memories (id, kind, content, source, date, created_at, last_touched_at, expires_at, salience, usefulness, content_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const e of rows) {
        insert.run(
          e.id, e.kind, e.content, e.source ?? null, e.date ?? null,
          e.createdAt, e.lastTouchedAt, e.expiresAt ?? null, e.salience, e.usefulness,
          contentKey(e.content),
        );
      }
      if (rows.length > 0) console.log(`[memory/store] migrated ${rows.length} entries from entries.jsonl`);
    }
  } catch (err) {
    console.warn('[memory/store] entries.jsonl migration failed (non-fatal):', err);
  }

  // trust.json → trust_events（合并回填：DB 非空也把缓冲里缺失的事件补进来，
  // 避免 sidecar 离线期间 Rust 写进 trust.json 的记账被永久丢弃）。
  try {
    const trustPath = join(baseDir, 'trust.json');
    if (existsSync(trustPath)) {
      const ledger = JSON.parse(readFileSync(trustPath, 'utf-8')) as {
        score?: number;
        baselineScore?: number;
        events?: Array<{ ts: number; taskId: string; taskName: string; kind: string; delta: number; reason: string; scoreAfter: number }>;
      };
      const events = ledger.events ?? [];
      if (events.length > 0) {
        const have = db.prepare(
          'SELECT COUNT(*) AS c FROM trust_events WHERE ts = ? AND task_id = ? AND reason = ?',
        );
        const insert = db.prepare(
          'INSERT INTO trust_events (ts, task_id, task_name, kind, delta, reason, score_after) VALUES (?, ?, ?, ?, ?, ?, ?)',
        );
        let added = 0;
        for (const e of events) {
          if ((have.get(e.ts, e.taskId, e.reason) as { c: number }).c > 0) continue;
          insert.run(e.ts, e.taskId, e.taskName, e.kind, e.delta, e.reason, e.scoreAfter);
          added++;
        }
        if (added > 0) {
          const row = db.prepare('SELECT MAX(score_after) AS m FROM trust_events').get() as { m: number | null };
          if (row.m != null) db.prepare('INSERT OR REPLACE INTO trust_meta (key, value) VALUES (?, ?)').run('score', String(row.m));
          console.log(`[memory/store] merged ${added} trust events from trust.json`);
        }
      }
      if (ledger.baselineScore != null) {
        const b = (db.prepare("SELECT value FROM trust_meta WHERE key = 'baselineScore'").get() as { value: string } | undefined)?.value;
        if (!b) db.prepare('INSERT OR REPLACE INTO trust_meta (key, value) VALUES (?, ?)').run('baselineScore', String(ledger.baselineScore));
      }
    }
  } catch (err) {
    console.warn('[memory/store] trust.json migration failed (non-fatal):', err);
  }

  // 存量近似去重：清理历史上精确键漏网的近义记忆（幂等，可多次调用）。
  try {
    consolidateMemories(baseDir, Date.now(), db);
  } catch (err) {
    console.warn('[memory/store] consolidateMemories failed (non-fatal):', err);
  }
}
