/**
 * SQLite 驱动适配层——memory.db / expert.db / intel.db 共用的唯一加载口。
 *
 * 策略：**node:sqlite 优先，better-sqlite3 只在 node:sqlite 缺席时兜底**。
 *
 * 为什么以 node:sqlite 为主：2.1 起发行形态是 `npm i -g`，sidecar 跑用户的
 * Node，而 better-sqlite3 的 `.node` 是按内置 Node 的 ABI 预编译的
 * （src-tauri/resources/sqlite-runtime，ABI 137 / Node 24）——在用户 Node
 * （如 22.x / ABI 127）上 require 就崩在 NODE_MODULE_VERSION 不匹配。
 * Node >= 22.5 自带 `node:sqlite`（DatabaseSync），API 与本模块的消费面
 * （exec / prepare / run / get / all / close / transaction）一一对上，且
 * 不随 Node 版本换 ABI。单一引擎 = 行为可预期：FTS5、WAL、busy_timeout、
 * 命名参数都在同一实现上验证，不再有「装了什么 native 包就跑哪套语义」。
 *
 * better-sqlite3 只服务一个场景：宿主 Node < 22.5（npm 形态已被启动硬门挡住，
 * 只剩 2.0.x 桌面残留与老环境）。两者都不可用 → 抛带诊断与出路的错误。
 *
 * `ZHISHI_SQLITE_BACKEND=node|better-sqlite3` 可强制指定后端（等价性验证、
 * 现场排查用）。未知取值直接报错——宁可启动失败，也不猜。
 */
import { createRequire } from 'module';

export type SqliteBackend = 'better-sqlite3' | 'node:sqlite';

export interface SqliteStatement {
  run: (...args: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
}

export interface SqliteDatabase {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
  /** better-sqlite3 语义：`db.transaction(fn)()`。嵌套用 SAVEPOINT。 */
  transaction: <T>(fn: () => T) => () => T;
}

export type SqliteFactory = (path: string) => SqliteDatabase;

export interface SqliteBackendResolution {
  factory: SqliteFactory;
  backend: SqliteBackend;
  /** 回落 better-sqlite3 时，node:sqlite 的失败原因（诊断用）。 */
  fallbackReason?: string;
}

export const SQLITE_BACKEND_ENV = 'ZHISHI_SQLITE_BACKEND';

// ===== better-sqlite3 =====

function loadBetterSqliteFactory(entry: string): SqliteFactory {
  const nodeRequire = createRequire(import.meta.url);
  const loaded = nodeRequire(entry) as unknown;
  // CJS 导出的是构造函数本身；个别打包形态会挂在 default 上。
  const ctor =
    typeof loaded === 'function'
      ? loaded
      : (loaded as { default?: unknown } | null)?.default;
  if (typeof ctor !== 'function') {
    throw new Error(`${entry} 的导出不是 better-sqlite3 构造函数`);
  }
  return ((path: string) => (ctor as (p: string) => SqliteDatabase)(path)) as SqliteFactory;
}

// ===== node:sqlite =====

interface NodeSqliteStatement {
  run: (...args: unknown[]) => { changes?: number | bigint; lastInsertRowid?: number | bigint };
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
}

interface NodeSqliteDatabase {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => NodeSqliteStatement;
  close: () => void;
}

/** better-sqlite3 返回普通对象；node:sqlite 返回 null 原型对象——统一成普通对象。 */
function plainRow(row: unknown): unknown {
  if (row === null || typeof row !== 'object') return row;
  return { ...(row as Record<string, unknown>) };
}

/** better-sqlite3 默认 busy_timeout=5000，node:sqlite 没有默认值——对齐。 */
const NODE_SQLITE_BUSY_TIMEOUT_MS = 5000;

function narrowId(value: number | bigint | undefined): number | bigint {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(-Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  }
  return value ?? 0;
}

function adaptStatement(stmt: NodeSqliteStatement): SqliteStatement {
  return {
    run: (...args: unknown[]) => {
      const result = stmt.run(...args);
      const changes = result?.changes;
      return {
        changes: typeof changes === 'bigint' ? Number(changes) : (changes ?? 0),
        lastInsertRowid: narrowId(result?.lastInsertRowid),
      };
    },
    get: (...args: unknown[]) => plainRow(stmt.get(...args)),
    all: (...args: unknown[]) => (stmt.all(...args) as unknown[]).map(plainRow),
  };
}

function createTransaction(db: NodeSqliteDatabase): <T>(fn: () => T) => () => T {
  let depth = 0;
  return <T>(fn: () => T) => () => {
    const savepoint = `zhishi_sp_${depth}`;
    if (depth === 0) db.exec('BEGIN');
    else db.exec(`SAVEPOINT ${savepoint}`);
    depth += 1;
    try {
      const result = fn();
      depth -= 1;
      if (depth === 0) db.exec('COMMIT');
      else db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      depth -= 1;
      try {
        if (depth === 0) db.exec('ROLLBACK');
        else db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      } catch {
        // 回滚失败时以原始错误为准（连接已坏，再抛回滚错会掩盖根因）
      }
      throw err;
    }
  };
}

/**
 * `node:sqlite` 首次加载会打一条 ExperimentalWarning。这不是问题，但在启动日志
 * 与测试输出里是纯噪声——只在加载这一刻拦掉这条特定警告，其余照常透传。
 */
function requireNodeSqlite(): { DatabaseSync: new (path: string) => NodeSqliteDatabase } {
  const nodeRequire = createRequire(import.meta.url);
  const original = process.emitWarning;
  const filtered = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning?.message ?? '';
    if (/sqlite/i.test(text) && /experimental/i.test(text)) return;
    return (original as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
  process.emitWarning = filtered;
  try {
    return nodeRequire('node:sqlite') as { DatabaseSync: new (path: string) => NodeSqliteDatabase };
  } finally {
    process.emitWarning = original;
  }
}

function loadNodeSqliteFactory(): SqliteFactory {
  const mod = requireNodeSqlite();
  const DatabaseSync = mod?.DatabaseSync;
  if (typeof DatabaseSync !== 'function') {
    throw new Error(`当前 Node（${process.versions.node}）不提供 node:sqlite DatabaseSync（需要 >= 22.5）`);
  }
  return (path: string) => {
    const raw = new DatabaseSync(path);
    try {
      raw.exec(`PRAGMA busy_timeout = ${NODE_SQLITE_BUSY_TIMEOUT_MS}`);
    } catch {
      // busy_timeout 设不上不是致命问题，继续用默认行为
    }
    const transaction = createTransaction(raw);
    return {
      exec: (sql: string) => raw.exec(sql),
      prepare: (sql: string) => adaptStatement(raw.prepare(sql)),
      close: () => raw.close(),
      transaction,
    };
  };
}

// ===== 入口 =====

function forcedBackend(): SqliteBackend | null {
  const raw = process.env[SQLITE_BACKEND_ENV]?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'node' || raw === 'node:sqlite' || raw === 'nodejs' || raw === 'node-sqlite') {
    return 'node:sqlite';
  }
  if (raw === 'better' || raw === 'better-sqlite3' || raw === 'native') {
    return 'better-sqlite3';
  }
  throw new Error(
    `未知的 ${SQLITE_BACKEND_ENV}=${raw}（可选值：better-sqlite3 | node；不设则自动选择）`,
  );
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * 解析可用的 SQLite 工厂（进程内缓存由调用方负责——三处 store 各自缓存）。
 *
 * @param options.betterSqliteEntry better-sqlite3 入口（lib/index.js）；null = 未找到
 * @param options.force 覆盖环境变量（测试用）
 */
export function resolveSqliteBackend(
  options: { betterSqliteEntry?: string | null; force?: SqliteBackend | null } = {},
): SqliteBackendResolution {
  const force = options.force ?? forcedBackend();
  const entry = options.betterSqliteEntry ?? null;

  let nodeError: Error | null = null;
  if (force !== 'better-sqlite3') {
    try {
      return { factory: loadNodeSqliteFactory(), backend: 'node:sqlite' };
    } catch (err) {
      nodeError = toError(err);
    }
  }

  if (force === 'node:sqlite') {
    throw new Error(
      `已强制 ${SQLITE_BACKEND_ENV}=node，但 node:sqlite 不可用：${nodeError?.message ?? 'unknown'}`,
    );
  }

  const betterFailure = entry
    ? (() => {
        try {
          return { factory: loadBetterSqliteFactory(entry), error: null as Error | null };
        } catch (err) {
          return { factory: null, error: toError(err) };
        }
      })()
    : { factory: null, error: new Error('未找到 better-sqlite3 入口（sqlite-runtime 与 node_modules 均无）') };

  if (betterFailure.factory) {
    return {
      factory: betterFailure.factory,
      backend: 'better-sqlite3',
      ...(nodeError ? { fallbackReason: nodeError.message } : {}),
    };
  }

  throw new Error(
    `SQLite 驱动不可用：node:sqlite（${nodeError?.message ?? '未尝试'}）；` +
      `better-sqlite3（${betterFailure.error?.message ?? '未尝试'}）。Node ${process.versions.node}。` +
      `出路：升级到 Node >= 22.5（npm 形态的硬要求），或安装 ABI 与当前 Node 匹配的 better-sqlite3。`,
  );
}
