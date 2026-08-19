/**
 * intel_search 工具单元测试（1.1.2 情报横切）。
 *
 * 覆盖：临时库注入命中（CVE 精确 + 头部新鲜度 + exploit 标记）、索引未
 * 构建提示、未命中在线回源（mock fetch 命中/失败静默降级/超时降级）、
 * 结果行 200 字截断、空 query 按契约 throw、limit 钳制、在线回源开关。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createIntelSearchTool,
  formatIntelHit,
  formatIntelResult,
  INTEL_SEARCH_TOOL_NAME,
} from './intel';
import { openIntelStore, resetIntelStoreForTest, runInTransaction, setMeta, upsertCves } from '../intel/store';
import type { ParsedCve } from '../intel/nvd-parser';
import type { IntelFetchResponse } from '../intel/sync';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-inteltool-'));
  resetIntelStoreForTest();
});

afterEach(() => {
  resetIntelStoreForTest();
  rmSync(dir, { recursive: true, force: true });
});

function seedCve(id: string, description: string, published: string): ParsedCve {
  return {
    id,
    description,
    cvssScore: 10.0,
    cvssVector: 'CVSS:3.1/AV:N/AC:L',
    published,
    modified: published,
    products: [{ vendor: 'apache', product: 'log4j' }],
  };
}

/** 预置索引：一条 CVE + 一条同编号 exploit + lastUpdateAt。 */
function seedIndex(): void {
  const db = openIntelStore(dir);
  runInTransaction(db, () => {
    upsertCves(db, [seedCve('CVE-2021-44228', 'Apache Log4j2 remote code execution', '2021-12-10T00:00:00.000Z')]);
    db.raw.prepare(`
      INSERT INTO exploits (id, file_path, description, type, platform, cve_refs, date)
      VALUES (1, 'exploits/x/1.txt', 'Log4Shell PoC', 'remote', 'java', 'CVE-2021-44228;OSVDB-1', '2021-12-11')
    `).run();
  });
  setMeta(db, 'lastUpdateAt', '2026-08-10T00:00:00.000Z');
}

function textResponse(body: string, status = 200): IntelFetchResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function nvdResponse(cves: unknown[]): string {
  return JSON.stringify({
    resultsPerPage: 5,
    startIndex: 0,
    totalResults: cves.length,
    format: 'NVD_CVE',
    version: '2.0',
    timestamp: '2026-08-19T05:00:00.000Z',
    vulnerabilities: cves,
  });
}

function onlineCve(id: string, description: string): unknown {
  return {
    cve: {
      id,
      descriptions: [{ lang: 'en', value: description }],
      metrics: { cvssMetricV31: [{ type: 'Primary', cvssData: { baseScore: 9.8, vectorString: 'CVSS:3.1/AV:N' } }] },
      configurations: [{ nodes: [{ cpeMatch: [{ vulnerable: true, criteria: 'cpe:2.3:a:apache:log4j:*:*:*:*:*:*:*:*' }] }] }],
      published: '2021-12-10T00:00:00.000Z',
      lastModified: '2021-12-10T00:00:00.000Z',
    },
  };
}

describe('本地命中', () => {
  it('CVE 精确命中：CVSS/受影响产品/公开 exploit + 索引新鲜度头', async () => {
    seedIndex();
    const tool = createIntelSearchTool({
      baseDir: dir,
      resolveConfig: () => ({ onlineFallback: false }),
    });
    expect(tool.name).toBe(INTEL_SEARCH_TOOL_NAME);
    const result = await tool.execute('tc1', { query: 'CVE-2021-44228' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('情报索引最后更新于 2026-08-10');
    expect(text).toContain('CVE-2021-44228');
    expect(text).toContain('CVSS 10.0');
    expect(text).toContain('受影响: apache log4j');
    expect(text).toContain('公开 exploit: 有');
    expect(result.details).toEqual({ hitCount: 1, online: false });
  });

  it('工具描述写明使用纪律', () => {
    const tool = createIntelSearchTool({ baseDir: dir });
    expect(tool.description).toContain('情报是线索不是结论');
    expect(tool.description).toContain('不要每步都查');
  });

  it('未命中且关闭在线回源 → 明确「未找到」', async () => {
    seedIndex();
    const tool = createIntelSearchTool({
      baseDir: dir,
      resolveConfig: () => ({ onlineFallback: false }),
    });
    const result = await tool.execute('tc2', { query: 'CVE-1999-9999' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('未找到');
    expect(result.details).toEqual({ hitCount: 0, online: false });
  });

  it('索引未构建（无 lastUpdateAt）→ 提示运行 zhishi intel update', async () => {
    const tool = createIntelSearchTool({
      baseDir: dir,
      resolveConfig: () => ({ onlineFallback: false }),
    });
    const result = await tool.execute('tc3', { query: 'apache' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('运行 zhishi intel update');
  });
});

describe('在线回源', () => {
  it('未命中回源 NVD keywordSearch，结果标注在线', async () => {
    seedIndex();
    let seenUrl = '';
    const fetchImpl = async (url: string): Promise<IntelFetchResponse> => {
      seenUrl = url;
      return textResponse(nvdResponse([onlineCve('CVE-2024-9999', 'Test product flaw')]));
    };
    const tool = createIntelSearchTool({
      baseDir: dir,
      fetchImpl,
      resolveConfig: () => ({ onlineFallback: true }),
    });
    const result = await tool.execute('tc4', { query: 'test product' });
    const text = (result.content[0] as { text: string }).text;
    expect(seenUrl).toContain('keywordSearch=test+product');
    expect(text).toContain('CVE-2024-9999');
    expect(text).toContain('在线回源');
    expect(result.details).toEqual({ hitCount: 1, online: true });
  });

  it('回源失败（网络/HTTP 错）静默降级为「未找到」，不 throw', async () => {
    seedIndex();
    const tool = createIntelSearchTool({
      baseDir: dir,
      fetchImpl: async () => textResponse('server error', 500),
      resolveConfig: () => ({ onlineFallback: true }),
    });
    const result = await tool.execute('tc5', { query: 'no-such-product-xyz' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('未找到');
    expect(result.details).toEqual({ hitCount: 0, online: false });
  });

  it('回源超时（5s 封顶，注入小超时验证）降级为「未找到」', async () => {
    seedIndex();
    const fetchImpl = (_url: string, init?: { signal?: AbortSignal }): Promise<IntelFetchResponse> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const tool = createIntelSearchTool({
      baseDir: dir,
      fetchImpl,
      resolveConfig: () => ({ onlineFallback: true }),
      onlineTimeoutMs: 50,
    });
    const result = await tool.execute('tc6', { query: 'slow-product' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('未找到');
  });
});

describe('输入校验与截断', () => {
  it('空 query 按 AgentTool 契约 throw', async () => {
    const tool = createIntelSearchTool({ baseDir: dir });
    await expect(tool.execute('tc7', { query: '   ' })).rejects.toThrow('需要 query');
  });

  it('limit 钳制到 5（schema 已限,再兜底一次）', async () => {
    seedIndex();
    const tool = createIntelSearchTool({
      baseDir: dir,
      resolveConfig: () => ({ onlineFallback: false }),
    });
    // 99 超上限 → 钳到 5 不报错
    const result = await tool.execute('tc8', { query: 'log4j', limit: 99 });
    expect(result.details?.hitCount).toBeLessThanOrEqual(5);
  });

  it('formatIntelHit 单条 ≤200 字（超长截断带省略号）', () => {
    const long = 'x'.repeat(500);
    const line = formatIntelHit({
      id: 'CVE-2024-1234',
      description: long,
      cvssScore: 7.5,
      cvssVector: null,
      published: null,
      modified: null,
      products: [{ vendor: 'a', product: 'b' }],
      exploitCount: 0,
    });
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line.endsWith('…')).toBe(true);
  });

  it('formatIntelResult：头部 + 命中行；exploitCount<0 显示未知', () => {
    const text = formatIntelResult({
      query: 'q',
      hits: [{
        id: 'CVE-2024-1234',
        description: 'd',
        cvssScore: null,
        cvssVector: null,
        published: null,
        modified: null,
        products: [],
        exploitCount: -1,
      }],
      lastUpdateAt: '2026-08-01T00:00:00.000Z',
      indexUnavailable: false,
      onlineUsed: false,
    });
    expect(text).toContain('情报索引最后更新于 2026-08-01');
    expect(text).toContain('CVSS N/A');
    expect(text).toContain('公开 exploit: 未知');
  });
});
