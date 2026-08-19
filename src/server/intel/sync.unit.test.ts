/**
 * sync 单元测试（1.1.2 情报横切）——fetch/sleep/now 全注入，不发真实网络。
 *
 * 覆盖：首次全量回填（倒序分窗 + 水位=回填起点）、增量续传（120 天分窗）、
 * 429 退避（尊重 Retry-After，睡眠注入收集）、中断可续（断点 meta 保留、
 * 跨运行水位不丢）、窗口事务回滚（半窗口数据不落库）、exploit-db 失败保留
 * 旧数据、window 模式写时过滤 + 裁剪。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  backoffDelayMs,
  BACKFILL_START,
  isValidIsoDate,
  runIntelUpdate,
  type IntelFetchFn,
  type IntelFetchResponse,
} from './sync';
import {
  countCves,
  countExploits,
  getIntelStatus,
  getMeta,
  openIntelStore,
  resetIntelStoreForTest,
  setMeta,
} from './store';

const T0 = new Date('2026-08-19T05:00:00.000Z');
const T0_ISO = T0.toISOString();

const CSV_HEADER = 'id,file,description,date_published,author,type,platform,port,date_added,date_updated,verified,codes,tags,aliases,screenshot_url,application_url,source_url';
const CSV_TEXT = [
  CSV_HEADER,
  '1,exploits/x/x.txt,"E1",2024-01-01,a,local,linux,,,,CVE-2024-0001;OSVDB-1,,,,,',
  '2,exploits/x/y.c,"E2",2024-02-01,b,dos,windows,,,,CVE-2024-0002,,,,,',
].join('\r\n');

let dir: string;
let tNow: Date;
let sleepLog: number[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-sync-'));
  resetIntelStoreForTest();
  tNow = new Date(T0);
  sleepLog = [];
});

afterEach(() => {
  resetIntelStoreForTest();
  rmSync(dir, { recursive: true, force: true });
});

function textResponse(body: string, status = 200, headers?: Record<string, string>): IntelFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: (name: string) => headers?.[name.toLowerCase()] ?? null },
  };
}

function jsonResponse(obj: unknown, status = 200): IntelFetchResponse {
  return textResponse(JSON.stringify(obj), status);
}

function nvdPage(vulnerabilities: unknown[], total: number, startIndex = 0): unknown {
  return {
    resultsPerPage: 2000,
    startIndex,
    totalResults: total,
    format: 'NVD_CVE',
    version: '2.0',
    timestamp: T0_ISO,
    vulnerabilities,
  };
}

function nvdCve(id: string, published: string, modified: string = published): unknown {
  return {
    id,
    descriptions: [{ lang: 'en', value: `${id} description` }],
    metrics: {},
    configurations: [],
    published,
    lastModified: modified,
  };
}

type Handler = (url: string) => IntelFetchResponse | Promise<IntelFetchResponse>;

function makeFetch(handler: Handler): { fetchImpl: IntelFetchFn; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: IntelFetchFn = async (url) => {
    calls.push(url);
    return handler(url);
  };
  return { fetchImpl, calls };
}

type UpdateOpts = Parameters<typeof runIntelUpdate>[0];

function opts(fetchImpl: IntelFetchFn, extra: Partial<UpdateOpts> = {}): UpdateOpts {
  return {
    baseDir: dir,
    mode: 'minimal',
    windowYears: 3,
    maxSizeMb: 1024,
    fetchImpl,
    now: () => tNow,
    sleepMs: async (ms: number) => { sleepLog.push(ms); },
    log: () => {},
    ...extra,
  };
}

/** 全 200 的通用 handler：NVD 每窗 1 条 CVE，exploit-db 回固定 CSV。 */
function happyHandler(): Handler {
  let seq = 0;
  return (url) => {
    if (url.includes('files_exploits.csv')) return textResponse(CSV_TEXT);
    seq += 1;
    return jsonResponse(nvdPage([
      { cve: nvdCve(`CVE-2024-${String(seq).padStart(4, '0')}`, '2024-01-01T00:00:00.000Z') },
    ], 1));
  };
}

describe('首次全量回填 → 增量续传', () => {
  it('回填按 pubStartDate 倒序分窗拉取，完成后水位=回填起点、断点清除', async () => {
    const { fetchImpl, calls } = makeFetch(happyHandler());
    const result = await runIntelUpdate(opts(fetchImpl));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    // 1988→2026 每 120 天一窗 ≈ 118 窗，每窗 1 请求；加 exploit-db 1 请求
    expect(calls.length).toBeGreaterThan(100);
    expect(calls[0]).toContain('pubStartDate=');
    const status = getIntelStatus(openIntelStore(dir));
    expect(status.cveCount).toBe(result.nvdAdded);
    expect(status.cveCount).toBeGreaterThan(100);
    expect(result.exploitCount).toBe(2);
    expect(status.nvdWatermark).toBe(T0_ISO); // 回填起点（追账窗口）
    expect(getMeta(openIntelStore(dir), 'nvdBackfillEnd')).toBeNull();
  });

  it('有水位后走 lastModStartDate 增量，窗口完成推进水位', async () => {
    await runIntelUpdate(opts(makeFetch(happyHandler()).fetchImpl)); // 首次回填
    const before = getIntelStatus(openIntelStore(dir));

    // 时间前进 1 天：增量应为 1 个 120 天窗（水位→now）
    tNow = new Date(T0.getTime() + 86_400_000);
    const inc = makeFetch((url) => {
      if (url.includes('files_exploits.csv')) return textResponse(CSV_TEXT);
      return jsonResponse(nvdPage([
        { cve: nvdCve('CVE-2025-0001', '2025-01-01T00:00:00.000Z', tNow.toISOString()) },
        { cve: nvdCve('CVE-2025-0002', '2025-01-02T00:00:00.000Z', tNow.toISOString()) },
      ], 2));
    });
    const result = await runIntelUpdate(opts(inc.fetchImpl));
    expect(result.ok).toBe(true);
    expect(inc.calls[0]).toContain('lastModStartDate=');
    expect(result.nvdAdded).toBe(2);
    const after = getIntelStatus(openIntelStore(dir));
    expect(after.cveCount).toBe(before.cveCount + 2);
    expect(after.nvdWatermark).toBe(tNow.toISOString());
  });
});

describe('中断可续 / 失败回滚', () => {
  it('回填中断：断点 meta 保留，续跑完成且水位=首次回填起点', async () => {
    // 第 3 个请求起网络故障（前 2 个窗口已提交）
    let n = 0;
    const failing = makeFetch((url) => {
      if (url.includes('files_exploits.csv')) return textResponse(CSV_TEXT);
      n += 1;
      if (n >= 3) return Promise.reject(new Error('network down'));
      return jsonResponse(nvdPage([{ cve: nvdCve(`CVE-2024-${String(n).padStart(4, '0')}`, '2024-01-01T00:00:00.000Z') }], 1));
    });
    const r1 = await runIntelUpdate(opts(failing.fetchImpl));
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('network down');
    const db = openIntelStore(dir);
    expect(getMeta(db, 'nvdBackfillEnd')).not.toBeNull(); // 断点已落
    expect(getMeta(db, 'nvdBackfillStartedAt')).toBe(T0_ISO);
    expect(r1.nvdAdded).toBe(2); // 前两个窗口已提交

    // 续跑：全 200
    const r2 = await runIntelUpdate(opts(makeFetch(happyHandler()).fetchImpl));
    expect(r2.ok).toBe(true);
    const status = getIntelStatus(openIntelStore(dir));
    expect(status.cveCount).toBeGreaterThan(100);
    // 水位 = 首次回填开始时刻（跨运行保留，追账不丢）
    expect(status.nvdWatermark).toBe(T0_ISO);
    expect(getMeta(db, 'nvdBackfillEnd')).toBeNull();
  });

  it('增量窗口内失败：该窗口事务不提交，水位不推进', async () => {
    // 先完成一次回填
    await runIntelUpdate(opts(makeFetch(happyHandler()).fetchImpl));
    const before = getIntelStatus(openIntelStore(dir));

    tNow = new Date(T0.getTime() + 86_400_000);
    // 窗口第 1 页 OK（totalResults=2），第 2 页网络故障
    let page = 0;
    const bad = makeFetch((url) => {
      if (url.includes('files_exploits.csv')) return textResponse(CSV_TEXT);
      page += 1;
      if (page === 2) return Promise.reject(new Error('connection reset'));
      return jsonResponse(nvdPage([
        { cve: nvdCve('CVE-2025-0001', '2025-01-01T00:00:00.000Z', tNow.toISOString()) },
      ], 2, 0));
    });
    const r = await runIntelUpdate(opts(bad.fetchImpl));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('connection reset');
    const after = getIntelStatus(openIntelStore(dir));
    // 半窗口数据不落库：计数与水位都不动
    expect(after.cveCount).toBe(before.cveCount);
    expect(after.nvdWatermark).toBe(before.nvdWatermark);
  });
});

describe('429 退避重试', () => {
  it('尊重 Retry-After，重试后成功；睡眠注入收集', async () => {
    let n = 0;
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('files_exploits.csv')) return textResponse(CSV_TEXT);
      n += 1;
      if (n <= 2) return textResponse(JSON.stringify({ message: 'rate limited' }), 429, { 'retry-after': '1' });
      return jsonResponse(nvdPage([
        { cve: nvdCve('CVE-2025-0009', '2025-01-01T00:00:00.000Z', tNow.toISOString()) },
      ], 1));
    });
    // 直接灌水位走增量（避免 118 窗的回填铺底）
    setMeta(openIntelStore(dir), 'nvdWatermark', new Date(T0.getTime() - 86_400_000).toISOString());
    const r = await runIntelUpdate(opts(fetchImpl, { maxRetries: 3 }));
    expect(r.ok).toBe(true);
    // Retry-After: 1 秒 → 两次各睡 1000ms
    expect(sleepLog).toEqual([1000, 1000]);
  });

  it('backoffDelayMs 纯函数：2000·2^attempt（jitter=0）', () => {
    expect(backoffDelayMs(0, 0)).toBe(2000);
    expect(backoffDelayMs(1, 0)).toBe(4000);
    expect(backoffDelayMs(2, 0)).toBe(8000);
    expect(backoffDelayMs(1, 0.5)).toBe(4500);
  });
});

describe('exploit-db 失败保留旧数据', () => {
  it('拉取失败进 warnings，不致命，旧数据保留', async () => {
    await runIntelUpdate(opts(makeFetch(happyHandler()).fetchImpl));
    expect(countExploits(openIntelStore(dir))).toBe(2);

    // 第二轮：NVD 全 200，exploit-db 500
    let nvdOk = 0;
    const bad = makeFetch((url) => {
      if (url.includes('files_exploits.csv')) return textResponse('boom', 500);
      nvdOk += 1;
      return jsonResponse(nvdPage([{ cve: nvdCve(`CVE-2024-${String(nvdOk).padStart(4, '0')}`, '2024-01-01T00:00:00.000Z') }], 1));
    });
    const r = await runIntelUpdate(opts(bad.fetchImpl));
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('保留旧数据'))).toBe(true);
    expect(countExploits(openIntelStore(dir))).toBe(2);
  });
});

describe('window 模式', () => {
  it('写时过滤窗口外记录（回填起点=窗口线，省请求），老记录不落库', async () => {
    // 每窗两条：一条 2024 老记录（应被过滤）、一条 2026 新记录（保留）
    let seq = 0;
    const { fetchImpl, calls } = makeFetch((url) => {
      if (url.includes('files_exploits.csv')) return textResponse(CSV_TEXT);
      seq += 1;
      return jsonResponse(nvdPage([
        { cve: nvdCve(`CVE-2024-${String(seq).padStart(4, '0')}`, '2024-01-01T00:00:00.000Z') },
        { cve: nvdCve(`CVE-2026-${String(seq).padStart(4, '0')}`, '2026-01-01T00:00:00.000Z') },
      ], 2));
    });
    const r = await runIntelUpdate(opts(fetchImpl, { mode: 'window', windowYears: 1 }));
    expect(r.ok).toBe(true);
    const status = getIntelStatus(openIntelStore(dir));
    // 只保留 2026 的；窗口外的不落库
    expect(status.cveCount).toBe(r.nvdAdded);
    expect(r.nvdAdded).toBeGreaterThan(0);
    // 回填起点 = 一年前（不是 1988）→ 窗数约 4（+exploit-db 1 请求）
    expect(calls.length).toBeLessThan(20);
    expect(status.cveCount).toBeLessThan(10);
    // 落库的全是 2026 年记录
    expect(status.cveCount).toBeGreaterThan(0);
    expect(countCves(openIntelStore(dir))).toBe(status.cveCount);
  });
});

describe('纯辅助', () => {
  it('isValidIsoDate 判据', () => {
    expect(isValidIsoDate('2026-08-01T00:00:00.000Z')).toBe(true);
    expect(isValidIsoDate('not-a-date')).toBe(false);
    expect(isValidIsoDate(null)).toBe(false);
  });

  it('BACKFILL_START 常量固定（全量回填起点）', () => {
    expect(BACKFILL_START).toBe('1988-01-01T00:00:00.000Z');
  });
});
