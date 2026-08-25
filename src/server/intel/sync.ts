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
 * - nuclei（1.1.4）：projectdiscovery/nuclei-templates 根 cves.json（NDJSON）
 *   整体拉取替换（只存 CVE → 模板路径，正文在 GitHub 不拉 yaml）。数据源
 *   多源 fallback（1.1.4 鲁棒性）：本地文件（--nuclei-file，网络不通时手动
 *   导入）→ raw.githubusercontent → jsdelivr CDN → api.github.com 普通
 *   contents API（JSON { content: base64 }，sync 层解码）；拉取失败或解析出
 *   0 条保留旧数据（warnings 报告，同 exploit-db 语义）。
 * - 进度（1.1.4）：模块级进度状态（inProgress/currentWindowLabel/nvdAdded/
 *   exploitCount），update 期间每窗写标签+累计入库数，exploit 阶段写条数，
 *   结束清空。inProgress 同时是并发互斥源——update 进行中第二个 update
 *   立即被拒（handleIntelUpdate 透传错误）。intel/status 经 getIntelProgress
 *   读快照，CLI 轮询刷新进度行。
 * - 事务纪律：写入一律经 runInTransaction（窗口数据 + 水位/回填断点同
 *   事务），meta 收尾最后提交——已有数据绝不被半更新破坏。
 * - WAL：update 期间查询不受影响（存储层保证）。
 *
 * fetch 可注入（单测 mock），生产走 Node 全局 fetch；sleep 可注入，
 * 生产用真实 setTimeout（退避）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { getZhiShiDataDir } from '../utils/app-dirs';
import type { IntelMode } from '../../shared/config-types';
import { parseNvdPage, type ParsedCve } from './nvd-parser';
import { parseExploitDbCsv } from './exploitdb-parser';
import { parseNucleiCvesJson } from './nuclei-parser';
import {
  countCves,
  countExploits,
  countNucleiTemplates,
  getMeta,
  openIntelStore,
  pruneBySize,
  pruneByWindow,
  removeMeta,
  replaceExploits,
  replaceNucleiTemplates,
  runInTransaction,
  setMeta,
  upsertCves,
  type IntelDb,
} from './store';

// ===== 常量 =====

export const NVD_BASE_URL = 'https://services.nvd.nist.gov/rest/json/cves/2.0/';
export const EXPLOITDB_CSV_URL = 'https://gitlab.com/exploit-database/exploitdb/-/raw/main/files_exploits.csv';
/** nuclei-templates 根目录的 CVE → 模板路径索引（NDJSON，只拉它不拉 yaml 正文）。 */
export const NUCLEI_CVES_URL = 'https://raw.githubusercontent.com/projectdiscovery/nuclei-templates/main/cves.json';

/**
 * nuclei cves.json 数据源（按序 fallback，1.1.4 鲁棒性）。实测网络环境下
 * node fetch 对 raw.githubusercontent/github/gitlab/jsdelivr 可达性不稳，
 * api.github.com 普通 contents API 稳定（带 raw accept 的 contents 会超时，
 * 故只走普通 JSON API）：
 * 1. raw.githubusercontent——网络好时最快；
 * 2. jsdelivr CDN 镜像；
 * 3. api.github.com 普通 contents API——响应是 JSON
 *    { content: <base64>, encoding: "base64" }，sync 层解码后交给解析器
 *    （解析器保持只吃 NDJSON 文本，不感知来源形态）。
 */
export const NUCLEI_CVES_SOURCES: ReadonlyArray<{ url: string; kind: 'ndjson' | 'github-contents' }> = [
  { url: NUCLEI_CVES_URL, kind: 'ndjson' },
  { url: 'https://cdn.jsdelivr.net/gh/projectdiscovery/nuclei-templates@main/cves.json', kind: 'ndjson' },
  {
    url: 'https://api.github.com/repos/projectdiscovery/nuclei-templates/contents/cves.json',
    kind: 'github-contents',
  },
];
/** NVD 日期区间上限（实测：120 天 200、152 天 404）。 */
export const NVD_MAX_RANGE_DAYS = 120;
export const NVD_PAGE_SIZE = 2000;
/** 全量回填起点（CVE 收录自 1999 起，少量记录 published 更早，从 1988 覆盖）。 */
export const BACKFILL_START = '1988-01-01T00:00:00.000Z';

const META_LAST_UPDATE = 'lastUpdateAt';
const META_MODE = 'mode';
const META_CVE_COUNT = 'cveCount';
const META_EXPLOIT_COUNT = 'exploitCount';
const META_NUCLEI_COUNT = 'nucleiCount';
const META_WATERMARK = 'nvdWatermark';
const META_BACKFILL_END = 'nvdBackfillEnd';
const META_BACKFILL_STARTED = 'nvdBackfillStartedAt';

const DAY_MS = 86_400_000;

// ===== 进度状态（1.1.4：intel/status 轮询 + 并发互斥同源） =====

/** update 进度快照（intel/status 的 progress 段）。 */
export interface IntelProgress {
  inProgress: boolean;
  currentWindowLabel: string | null;
  nvdAdded: number;
  exploitCount: number;
}

/** 进程内唯一进度状态（单进程 sidecar 内 update 是唯一写者）。 */
let progressState: IntelProgress = { inProgress: false, currentWindowLabel: null, nvdAdded: 0, exploitCount: 0 };

/** 读取进度快照（intel/status 用）。返回拷贝——外部改不到内部状态。 */
export function getIntelProgress(): IntelProgress {
  return { ...progressState };
}

/**
 * 置更新进行中（并发互斥源）：已在跑返回 false——调用方（runIntelUpdate）
 * 据此立即拒绝第二个 update。JS 单线程内检查+置位之间无 await，天然原子。
 */
export function tryBeginIntelUpdate(): boolean {
  if (progressState.inProgress) return false;
  progressState.inProgress = true;
  return true;
}

/** 更新进行中写进度字段（窗口提交后 / exploit 阶段）。 */
function setIntelProgress(patch: Partial<Omit<IntelProgress, 'inProgress'>>): void {
  progressState = { ...progressState, ...patch };
}

/** 更新结束清进度（inProgress=false + 计数复位）。 */
function endIntelUpdate(): void {
  progressState = { inProgress: false, currentWindowLabel: null, nvdAdded: 0, exploitCount: 0 };
}

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
  /** 1.3.6 丢数据修复：window 模式的「存量裁剪」开关。true 才在更新末尾
   *  删除窗口外（published 早于窗口线/无日期）的历史 CVE；false/缺省只做
   *  写时过滤（新数据不进窗口外），已入库的历史保留。只有「持久化配置已
   *  提交 window」的调用方（handleIntelUpdate 按 cfg.mode 判定）传 true——
   *  一次性 mode 覆盖（GUI 更新按钮 / CLI --mode）不得裁剪：裁掉的记录
   *  因增量水位无法找回，是永久丢数据。 */
  pruneWindow?: boolean;
  /** fetch 实现（缺省 Node 全局 fetch）。 */
  fetchImpl?: IntelFetchFn;
  now?: () => Date;
  /** 退避睡眠（单测注入瞬时实现）。 */
  sleepMs?: (ms: number) => Promise<void>;
  maxRetries?: number;
  requestTimeoutMs?: number;
  /** nuclei 本地 cves.json 文件路径（zhishi intel update --nuclei-file）：
   *  网络不通时手动导入，nuclei 阶段优先读它；不存在/读失败按源失败处理
   *  进 warnings。 */
  nucleiFile?: string;
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
  /** 本次写入的 nuclei 检测模板条数（CVE → 模板路径对）。 */
  nucleiCount: number;
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

/** 429/5xx 指数退避重试（尊重 Retry-After，封顶 60s）；网络错误/超时/响应体读取失败同样退避重试。
 *  返回已读取的响应文本——body 读取必须在重试循环内，NVD 大页（6MB+）慢网络下读取超时是常态。 */
async function fetchWithRetry(ctx: RetryContext, url: string, label: string): Promise<{ resp: IntelFetchResponse; text: string }> {
  for (let attempt = 0; ; attempt++) {
    let resp: IntelFetchResponse;
    try {
      resp = await fetchWithTimeout(ctx.fetchImpl, url, ctx.requestTimeoutMs);
    } catch (err) {
      if (attempt >= ctx.maxRetries) {
        throw new Error(
          `${label} 请求失败（网络/超时）重试 ${ctx.maxRetries} 次后仍失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const delay = backoffDelayMs(attempt);
      ctx.log(`${label} 网络错误（${err instanceof Error ? err.message : String(err)}），${delay}ms 后退避重试（第 ${attempt + 1} 次）`);
      await ctx.sleepMs(delay);
      continue;
    }
    if (!resp.ok) {
      const retryable = resp.status === 429 || resp.status >= 500;
      if (!retryable) throw new Error(`${label} HTTP ${resp.status}: ${url}`);
      if (attempt >= ctx.maxRetries) {
        throw new Error(`${label} HTTP ${resp.status} 重试 ${ctx.maxRetries} 次后仍失败: ${url}`);
      }
      const delay = retryAfterMs(resp) ?? backoffDelayMs(attempt);
      ctx.log(`${label} HTTP ${resp.status}，${delay}ms 后退避重试（第 ${attempt + 1} 次）`);
      await ctx.sleepMs(delay);
      continue;
    }
    try {
      const text = await resp.text();
      return { resp, text };
    } catch (err) {
      if (attempt >= ctx.maxRetries) {
        throw new Error(
          `${label} 响应读取失败重试 ${ctx.maxRetries} 次后仍失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const delay = backoffDelayMs(attempt);
      ctx.log(`${label} 响应读取失败（${err instanceof Error ? err.message : String(err)}），${delay}ms 后退避重试（第 ${attempt + 1} 次）`);
      await ctx.sleepMs(delay);
    }
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
    const { text } = await fetchWithRetry(ctx, url, 'NVD');
    // body 已在重试循环内读取完毕——此处只剩 JSON 解析失败归类。
    let page;
    try {
      page = parseNvdPage(JSON.parse(text));
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
    const startIso = new Date(current).toISOString();
    const endIso = new Date(endMs).toISOString();
    setIntelProgress({ currentWindowLabel: `${startIso}~${endIso}` });
    const win = await fetchNvdWindow(ctx, {
      startIso,
      endIso,
      published: false,
    });
    runInTransaction(ctx.db, () => {
      ctx.stats.added += upsertCves(ctx.db, win.cves);
      ctx.stats.total += win.cves.length;
      ctx.stats.pages += win.pages;
      setMeta(ctx.db, META_WATERMARK, endIso);
    });
    setIntelProgress({ currentWindowLabel: `${startIso}~${endIso}`, nvdAdded: ctx.stats.added });
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
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();
    setIntelProgress({ currentWindowLabel: `${startIso}~${endIso}` });
    const win = await fetchNvdWindow(ctx, {
      startIso,
      endIso,
      published: true,
    });
    runInTransaction(ctx.db, () => {
      ctx.stats.added += upsertCves(ctx.db, win.cves, { minPublished: ctx.minPublished });
      ctx.stats.total += win.cves.length;
      ctx.stats.pages += win.pages;
      setMeta(ctx.db, META_BACKFILL_END, startIso);
    });
    setIntelProgress({ currentWindowLabel: `${startIso}~${endIso}`, nvdAdded: ctx.stats.added });
    cursorMs = startMs;
  }
  // 全量拉完：水位 = 回填开始时刻（增量从此刻追账），清回填断点
  runInTransaction(ctx.db, () => {
    setMeta(ctx.db, META_WATERMARK, backfillStartedAt);
    removeMeta(ctx.db, META_BACKFILL_END);
    removeMeta(ctx.db, META_BACKFILL_STARTED);
  });
}

// ===== nuclei 拉取（1.1.4 鲁棒性：本地文件优先 + 多源 fallback） =====

/** 本地文件源：existsSync 校验 + 同步读 UTF-8（better-sqlite3 同款同步风格）。 */
function readNucleiFileSync(path: string): string {
  if (!existsSync(path)) throw new Error(`文件不存在: ${path}`);
  return readFileSync(path, 'utf8');
}

/**
 * 单个数据源的响应体 → NDJSON 文本。ndjson 源原样透传；github-contents 源
 * （api.github.com 普通 contents API）响应是 JSON { content: base64,
 * encoding: "base64" }——在此解码成文本，解析器不感知来源形态。
 */
function decodeNucleiSource(source: (typeof NUCLEI_CVES_SOURCES)[number], text: string): string {
  if (source.kind === 'ndjson') return text;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new Error(`GitHub contents 响应非 JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error('GitHub contents 响应形态异常（非对象）');
  }
  const row = obj as Record<string, unknown>;
  if (row.encoding !== undefined && row.encoding !== 'base64') {
    throw new Error(`GitHub contents 不支持编码 "${String(row.encoding)}"`);
  }
  const content = typeof row.content === 'string' ? row.content : '';
  if (!content) throw new Error('GitHub contents 响应缺少 content 字段');
  // Buffer.from(…, 'base64') 忽略换行等非法字符——contents API 的 base64 自带换行。
  return Buffer.from(content, 'base64').toString('utf8');
}

/**
 * 拿到 nuclei cves.json 的 NDJSON 文本。顺序：本地文件（nucleiFile）→
 * NUCLEI_CVES_SOURCES 按序尝试。每个源失败打 log 换下一个；全部失败抛错
 * （错误信息带每个源的失败摘要，由 nuclei 阶段收进 warnings）。
 */
async function fetchNucleiText(ctx: SyncContext, nucleiFile: string | undefined): Promise<string> {
  const failures: string[] = [];
  if (nucleiFile) {
    try {
      const text = readNucleiFileSync(nucleiFile);
      ctx.log(`nuclei 使用本地文件 ${nucleiFile}`);
      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(`nuclei 本地文件失败（${msg}），转网络源`);
      failures.push(`本地文件: ${msg}`);
    }
  }
  for (let i = 0; i < NUCLEI_CVES_SOURCES.length; i++) {
    const source = NUCLEI_CVES_SOURCES[i]!;
    const label = `nuclei 源${i + 1}`;
    try {
      const { text } = await fetchWithRetry(ctx, source.url, label);
      return decodeNucleiSource(source, text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(`${label} 失败（${msg}），尝试下一个源`);
      failures.push(`${label}: ${msg}`);
    }
  }
  throw new Error(`全部 ${failures.length} 个数据源失败（${failures.join('；')}）`);
}

// ===== 入口 =====

/**
 * 执行一次情报更新（带并发互斥与进度簿记）。互斥标记与进度状态同源
 * （progressState.inProgress）：进行中第二个调用立即返回 ok=false，不碰
 * intel.db 锁；无论成功/失败/抛错，finally 都清进度（inProgress=false）。
 */
export async function runIntelUpdate(opts: IntelUpdateOptions): Promise<IntelUpdateResult> {
  if (!tryBeginIntelUpdate()) {
    return {
      ok: false,
      error: '已有更新在跑（情报索引更新中）',
      warnings: [],
      mode: opts.mode,
      nvdAdded: 0,
      nvdTotal: 0,
      nvdFetchedPages: 0,
      exploitCount: 0,
      nucleiCount: 0,
      prunedByWindow: 0,
      prunedBySize: 0,
      lastUpdateAt: (opts.now ?? (() => new Date()))().toISOString(),
    };
  }
  try {
    return await runIntelUpdateInner(opts);
  } finally {
    endIntelUpdate();
  }
}

/**
 * 更新执行体。失败语义：NVD 阶段失败 → ok=false 且未提交的当前窗口丢弃
 * （已提交窗口保留，断点可续）；exploit-db / nuclei 失败不致命（保留旧
 * 数据进 warnings）。meta 收尾最后提交。
 */
async function runIntelUpdateInner(opts: IntelUpdateOptions): Promise<IntelUpdateResult> {
  const baseDir = opts.baseDir ?? getZhiShiDataDir();
  const fetchImpl = opts.fetchImpl ?? nodeFetch();
  const sleepMs = opts.sleepMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((msg: string) => console.log(`[intel] ${msg}`));
  const maxRetries = opts.maxRetries ?? 3;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
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
    nucleiCount: 0,
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
  // 新一轮开始：复位计数（inProgress 已由 tryBegin 置位）
  setIntelProgress({ currentWindowLabel: null, nvdAdded: 0, exploitCount: 0 });

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

  // ===== window 裁剪（1.3.6 丢数据修复：仅 pruneWindow=true 执行） =====
  // 写时过滤（minPublished）已保证新数据不落窗口外；存量裁剪是破坏性操作
  // （删掉的记录因增量水位无法找回），必须由「已提交 window 配置」的调用
  // 方显式开启——一次性 mode 覆盖只过滤不裁剪。
  if (ctx.minPublished && opts.pruneWindow === true) {
    try {
      result.prunedByWindow = runInTransaction(db, () => pruneByWindow(db, ctx.minPublished as string));
    } catch (err) {
      warnings.push(`window 裁剪失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ===== exploit-db 阶段（失败保留旧数据，不致命） =====
  try {
    const { text } = await fetchWithRetry(ctx, EXPLOITDB_CSV_URL, 'exploit-db');
    const exploits = parseExploitDbCsv(text);
    if (exploits.length === 0) {
      warnings.push('exploit-db 解析出 0 条，保留旧数据');
    } else {
      result.exploitCount = runInTransaction(db, () => replaceExploits(db, exploits));
      setIntelProgress({ exploitCount: result.exploitCount });
      log(`exploit-db 已替换 ${exploits.length} 条`);
    }
  } catch (err) {
    warnings.push(`exploit-db 更新失败，保留旧数据: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ===== nuclei 阶段（1.1.4，失败保留旧数据，不致命——同 exploit-db 语义；
  // 只拉 cves.json 目录索引，模板正文在 GitHub 不拉 yaml。1.1.4 鲁棒性：
  // 本地文件（--nuclei-file）优先 → 多源 fallback，全部失败才进 warnings） =====
  try {
    const text = await fetchNucleiText(ctx, opts.nucleiFile);
    const templates = parseNucleiCvesJson(text);
    if (templates.length === 0) {
      warnings.push('nuclei cves.json 解析出 0 条，保留旧数据');
    } else {
      result.nucleiCount = runInTransaction(db, () => replaceNucleiTemplates(db, templates));
      log(`nuclei 检测模板已替换 ${templates.length} 条`);
    }
  } catch (err) {
    warnings.push(`nuclei 更新失败，保留旧数据: ${err instanceof Error ? err.message : String(err)}`);
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
    setMeta(db, META_NUCLEI_COUNT, String(countNucleiTemplates(db)));
  });
  log(`完成 mode=${opts.mode} nvd+${result.nvdAdded} exploits=${result.exploitCount} nuclei=${result.nucleiCount}`);
  return result;
}
