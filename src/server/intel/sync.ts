/**
 * intel update 编排层（1.1.2 情报横切）：拉取 → 解析 → 写库 → 裁剪。
 *
 * 流程（设计定稿）：
 * - NVD：API 2.0 分页拉取。首次（无水位）按发布时间倒序、≤120 天/窗分段
 *   拉全量（设计写「每窗如 6 个月」，实测 NVD 日期区间上限 120 天——152 天
 *   直接 404，故按 API 硬约束取 120 天）；之后增量用 lastModStartDate 水位
 *   （同样按 120 天分窗推进）。429/5xx 指数退避重试 3 次，窗口粒度写库 +
 *   推进水位（断点续传）。
 * - exploit-db：files_exploits.csv 整体拉取替换；拉取失败或解析出 0 条
 *   保留旧数据（warnings 报告）。
 * - 事务纪律：写入一律经 runInTransaction（窗口数据 + 水位/回填断点同
 *   事务），meta 收尾最后提交——已有数据绝不被半更新破坏。
 * - WAL：update 期间查询不受影响（存储层保证）。
 *
 * fetch 可注入（单测 mock），生产走 Node 全局 fetch；sleep 可注入，
 * 生产用真实 setTimeout（退避）。
 */
import { getZhiShiDataDir } from '../utils/app-dirs';
import type { IntelMode } from '../../shared/config-types';
import { parseNvdPage, type ParsedCve } from './nvd-parser';
import { parseExploitDbCsv } from './exploitdb-parser';
import {
  countCves,
  countExploits,
  getMeta,
  openIntelStore,
  pruneBySize,
  pruneByWindow,
  removeMeta,
  replaceExploits,
  runInTransaction,
  setMeta,
  upsertCves,
  type IntelDb,
} from './store';

// ===== 常量 =====

export const NVD_BASE_URL = 'https://services.nvd.nist.gov/rest/json/cves/2.0/';
export const EXPLOITDB_CSV_URL = 'https://gitlab.com/exploit-database/exploitdb/-/raw/main/files_exploits.csv';
/** NVD 日期区间上限（实测：120 天 200、152 天 404）。 */
export const NVD_MAX_RANGE_DAYS = 120;
export const NVD_PAGE_SIZE = 2000;
/** 全量回填起点（CVE 收录自 1999 起，少量记录 published 更早，从 1988 覆盖）。 */
export const BACKFILL_START = '1988-01-01T00:00:00.000Z';

const META_LAST_UPDATE = 'lastUpdateAt';
const META_MODE = 'mode';
const META_CVE_COUNT = 'cveCount';
const META_EXPLOIT_COUNT = 'exploitCount';
const META_WATERMARK = 'nvdWatermark';
const META_BACKFILL_END = 'nvdBackfillEnd';
const META_BACKFILL_STARTED = 'nvdBackfillStartedAt';

const DAY_MS = 86_400_000;

// ===== 可注入依赖（单测 mock） =====

export interface IntelFetchResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  /** Retry-After 读取（429 退避优先尊重服务端指令）。 */
  headers?: { get: (name: string) => string | null };
}

export interface IntelFetchFn {
  (url: string, init?: { signal?: AbortSignal }): Promise<IntelFetchResponse>;
}

function nodeFetch(): IntelFetchFn {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== 'function') {
    throw new Error('当前 Node 运行时不提供全局 fetch（需 Node 18+）');
  }
  return f as IntelFetchFn;
}

export interface IntelUpdateOptions {
  /** 数据目录（缺省 getZhiShiDataDir()）。测试注入临时目录。 */
  baseDir?: string;
  mode: IntelMode;
  windowYears: number;
  maxSizeMb: number;
  /** fetch 实现（缺省 Node 全局 fetch）。 */
  fetchImpl?: IntelFetchFn;
  now?: () => Date;
  /** 退避睡眠（单测注入瞬时实现）。 */
  sleepMs?: (ms: number) => Promise<void>;
  maxRetries?: number;
  requestTimeoutMs?: number;
  /** 进度日志（缺省 console.log，单测注入收集器）。 */
  log?: (msg: string) => void;
}

export interface IntelUpdateResult {
  ok: boolean;
  error?: string;
  warnings: string[];
  mode: IntelMode;
  /** 本次实际写入/覆盖的 CVE 条数。 */
  nvdAdded: number;
  /** 本次拉取到的 CVE 总数（含被 window 过滤跳过的）。 */
  nvdTotal: number;
  nvdFetchedPages: number;
  exploitCount: number;
  prunedByWindow: number;
  prunedBySize: number;
  lastUpdateAt: string;
}

// ===== 纯辅助（可单测） =====

/** 指数退避（毫秒）：2000·2^attempt + jitter（0~1000）。 */
export function backoffDelayMs(attempt: number, jitter: number = Math.random()): number {
  return 2000 * 2 ** attempt + Math.floor(jitter * 1000);
}

/** ISO 字符串是否可解析为日期。 */
export function isValidIsoDate(s: string | null): s is string {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

/** N 天前的 ISO 时刻（window 模式裁剪线）。 */
export function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

// ===== 网络层 =====

async function fetchWithTimeout(
  fetchImpl: IntelFetchFn,
  url: string,
  timeoutMs: number,
): Promise<IntelFetchResponse> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetchImpl(url, { signal });
  } catch (err) {
    if (signal.aborted) throw new Error(`请求超时（${timeoutMs}ms）: ${url}`);
    throw err;
  }
}

interface RetryContext {
  fetchImpl: IntelFetchFn;
  sleepMs: (ms: number) => Promise<void>;
  maxRetries: number;
  requestTimeoutMs: number;
  log: (msg: string) => void;
}

/** 429/5xx 指数退避重试（尊重 Retry-After，封顶 60s）；其余错误直接抛。 */
async function fetchWithRetry(ctx: RetryContext, url: string, label: string): Promise<IntelFetchResponse> {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetchWithTimeout(ctx.fetchImpl, url, ctx.requestTimeoutMs);
    if (resp.ok) return resp;
    const retryable = resp.status === 429 || resp.status >= 500;
    if (!retryable) throw new Error(`${label} HTTP ${resp.status}: ${url}`);
    if (attempt >= ctx.maxRetries) {
      throw new Error(`${label} HTTP ${resp.status} 重试 ${ctx.maxRetries} 次后仍失败: ${url}`);
    }
    const delay = retryAfterMs(resp) ?? backoffDelayMs(attempt);
    ctx.log(`${label} HTTP ${resp.status}，${delay}ms 后退避重试（第 ${attempt + 1} 次）`);
    await ctx.sleepMs(delay);
  }
}

function retryAfterMs(resp: IntelFetchResponse): number | null {
  const raw = resp.headers?.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(Math.floor(seconds * 1000), 60_000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 1000), 60_000);
  return null;
}

// ===== NVD 拉取 =====

interface WindowResult {
  cves: ParsedCve[];
  pages: number;
  totalResults: number;
}

/**
 * 拉取一个日期窗的全部页（published 窗或 lastMod 窗）。游标防呆：totalResults
 * 异常增大/接口改版导致死循环时抛错（窗口事务不会提交，断点不推进）。
 */
async function fetchNvdWindow(
  ctx: RetryContext,
  range: { startIso: string; endIso: string; published: boolean },
): Promise<WindowResult> {
  const dateParams: Record<string, string> = range.published
    ? { pubStartDate: range.startIso, pubEndDate: range.endIso }
    : { lastModStartDate: range.startIso, lastModEndDate: range.endIso };
  const cves: ParsedCve[] = [];
  let startIndex = 0;
  let totalResults = -1;
  let pages = 0;
  for (;;) {
    const params = new URLSearchParams({
      resultsPerPage: String(NVD_PAGE_SIZE),
      startIndex: String(startIndex),
      ...dateParams,
    });
    const url = `${NVD_BASE_URL}?${params.toString()}`;
    const resp = await fetchWithRetry(ctx, url, 'NVD');
    let page;
    try {
      page = parseNvdPage(JSON.parse(await resp.text()));
    } catch (err) {
      throw new Error(`NVD 响应解析失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    pages += 1;
    if (totalResults < 0) totalResults = page.meta.totalResults;
    cves.push(...page.cves);
    ctx.log(
      `NVD 窗口 ${range.startIso}~${range.endIso}: 已取 ${Math.min(startIndex + page.cves.length, page.meta.totalResults)}/${page.meta.totalResults}`,
    );
    if (page.cves.length === 0 || startIndex + page.cves.length >= page.meta.totalResults) break;
    startIndex += page.cves.length;
    if (startIndex > totalResults + NVD_PAGE_SIZE) {
      throw new Error(`NVD 分页游标异常（startIndex=${startIndex} > totalResults=${totalResults}）`);
    }
  }
  return { cves, pages, totalResults: Math.max(totalResults, 0) };
}

// ===== 同步阶段 =====

interface SyncContext {
  db: IntelDb;
  fetchImpl: IntelFetchFn;
  sleepMs: (ms: number) => Promise<void>;
  maxRetries: number;
  requestTimeoutMs: number;
  log: (msg: string) => void;
  now: () => Date;
  /** window 模式写入过滤线（其余模式 undefined）。 */
  minPublished?: string;
  /** 累计计数（结果回填用）。 */
  stats: { added: number; total: number; pages: number };
}

/** 增量：水位 → now，按 ≤120 天分窗推进；窗口完成才推进水位（断点续传）。 */
async function syncIncremental(ctx: SyncContext, watermark: string): Promise<void> {
  const nowMs = ctx.now().getTime();
  let current = Date.parse(watermark);
  while (current < nowMs) {
    const endMs = Math.min(current + NVD_MAX_RANGE_DAYS * DAY_MS, nowMs);
    const win = await fetchNvdWindow(ctx, {
      startIso: new Date(current).toISOString(),
      endIso: new Date(endMs).toISOString(),
      published: false,
    });
    runInTransaction(ctx.db, () => {
      ctx.stats.added += upsertCves(ctx.db, win.cves);
      ctx.stats.total += win.cves.length;
      ctx.stats.pages += win.pages;
      setMeta(ctx.db, META_WATERMARK, new Date(endMs).toISOString());
    });
    current = endMs;
  }
}

/** 首次全量：发布时间倒序分窗拉取，断点（nvdBackfillEnd）续传。 */
async function syncBackfill(ctx: SyncContext, nowIso: string): Promise<void> {
  // 回填起点：window 模式只回填窗口内（省请求）；其余模式从 1988 起
  const fromMs = Math.max(Date.parse(BACKFILL_START), ctx.minPublished ? Date.parse(ctx.minPublished) : 0);
  // 断点续传：上次完成的窗口下界（倒序推进）；无断点从 now 开始
  const resume = getMeta(ctx.db, META_BACKFILL_END);
  let cursorMs = resume && isValidIsoDate(resume) ? Date.parse(resume) : Date.parse(nowIso);
  // 覆盖「回填期间记录被修改」的追账起点：首次回填开始时刻（跨运行保留）
  if (!getMeta(ctx.db, META_BACKFILL_STARTED)) {
    setMeta(ctx.db, META_BACKFILL_STARTED, nowIso);
  }
  const backfillStartedAt = getMeta(ctx.db, META_BACKFILL_STARTED) ?? nowIso;
  while (cursorMs > fromMs) {
    const endMs = cursorMs;
    const startMs = Math.max(endMs - NVD_MAX_RANGE_DAYS * DAY_MS, fromMs);
    const win = await fetchNvdWindow(ctx, {
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(endMs).toISOString(),
      published: true,
    });
    runInTransaction(ctx.db, () => {
      ctx.stats.added += upsertCves(ctx.db, win.cves, { minPublished: ctx.minPublished });
      ctx.stats.total += win.cves.length;
      ctx.stats.pages += win.pages;
      setMeta(ctx.db, META_BACKFILL_END, new Date(startMs).toISOString());
    });
    cursorMs = startMs;
  }
  // 全量拉完：水位 = 回填开始时刻（增量从此刻追账），清回填断点
  runInTransaction(ctx.db, () => {
    setMeta(ctx.db, META_WATERMARK, backfillStartedAt);
    removeMeta(ctx.db, META_BACKFILL_END);
    removeMeta(ctx.db, META_BACKFILL_STARTED);
  });
}

// ===== 入口 =====

/**
 * 执行一次情报更新。失败语义：NVD 阶段失败 → ok=false 且未提交的当前
 * 窗口丢弃（已提交窗口保留，断点可续）；exploit-db 失败不致命（保留旧
 * 数据进 warnings）。meta 收尾最后提交。
 */
export async function runIntelUpdate(opts: IntelUpdateOptions): Promise<IntelUpdateResult> {
  const baseDir = opts.baseDir ?? getZhiShiDataDir();
  const fetchImpl = opts.fetchImpl ?? nodeFetch();
  const sleepMs = opts.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((msg: string) => console.log(`[intel] ${msg}`));
  const maxRetries = opts.maxRetries ?? 3;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  const warnings: string[] = [];
  const nowIso = now().toISOString();
  const result: IntelUpdateResult = {
    ok: true,
    warnings,
    mode: opts.mode,
    nvdAdded: 0,
    nvdTotal: 0,
    nvdFetchedPages: 0,
    exploitCount: 0,
    prunedByWindow: 0,
    prunedBySize: 0,
    lastUpdateAt: nowIso,
  };

  const db = openIntelStore(baseDir);
  const ctx: SyncContext = {
    db,
    fetchImpl,
    sleepMs,
    maxRetries,
    requestTimeoutMs,
    log,
    now,
    minPublished: opts.mode === 'window' ? isoDaysAgo(now(), opts.windowYears * 365) : undefined,
    stats: { added: 0, total: 0, pages: 0 },
  };

  // ===== NVD 阶段 =====
  try {
    const watermark = getMeta(db, META_WATERMARK);
    const backfillEnd = getMeta(db, META_BACKFILL_END);
    if (backfillEnd && isValidIsoDate(backfillEnd)) {
      // 上次全量回填中断 → 先续回填（完成后会设水位）
      log('续接上次未完成的全量回填');
      await syncBackfill(ctx, nowIso);
    } else if (watermark && isValidIsoDate(watermark)) {
      log(`增量更新：lastModStartDate=${watermark}`);
      await syncIncremental(ctx, watermark);
    } else {
      log('首次更新：按发布时间倒序分段拉全量');
      await syncBackfill(ctx, nowIso);
    }
  } catch (err) {
    return {
      ...result,
      ok: false,
      nvdAdded: ctx.stats.added,
      nvdTotal: ctx.stats.total,
      nvdFetchedPages: ctx.stats.pages,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  result.nvdAdded = ctx.stats.added;
  result.nvdTotal = ctx.stats.total;
  result.nvdFetchedPages = ctx.stats.pages;

  // ===== window 裁剪（写时已过滤，这里兜掉存量与增量带进来的老记录） =====
  if (ctx.minPublished) {
    try {
      result.prunedByWindow = runInTransaction(db, () => pruneByWindow(db, ctx.minPublished as string));
    } catch (err) {
      warnings.push(`window 裁剪失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ===== exploit-db 阶段（失败保留旧数据，不致命） =====
  try {
    const resp = await fetchWithRetry(ctx, EXPLOITDB_CSV_URL, 'exploit-db');
    const text = await resp.text();
    const exploits = parseExploitDbCsv(text);
    if (exploits.length === 0) {
      warnings.push('exploit-db 解析出 0 条，保留旧数据');
    } else {
      result.exploitCount = runInTransaction(db, () => replaceExploits(db, exploits));
      log(`exploit-db 已替换 ${exploits.length} 条`);
    }
  } catch (err) {
    warnings.push(`exploit-db 更新失败，保留旧数据: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ===== 自适应裁剪（maxSizeMb 兜底，全模式） =====
  try {
    result.prunedBySize = pruneBySize(db, opts.maxSizeMb * 1024 * 1024);
  } catch (err) {
    warnings.push(`大小裁剪失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ===== meta 收尾（最后提交） =====
  runInTransaction(db, () => {
    setMeta(db, META_MODE, opts.mode);
    setMeta(db, META_LAST_UPDATE, result.lastUpdateAt);
    setMeta(db, META_CVE_COUNT, String(countCves(db)));
    setMeta(db, META_EXPLOIT_COUNT, String(countExploits(db)));
  });
  log(`完成 mode=${opts.mode} nvd+${result.nvdAdded} exploits=${result.exploitCount}`);
  return result;
}
