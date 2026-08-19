/**
 * store 单元测试（1.1.2 情报横切）——临时目录建真实 intel.db。
 *
 * 覆盖：建表幂等、upsert 幂等（同 id 覆盖 + 产品表先清后插）、minPublished
 * 写入过滤、exploits 整体替换、精确/FTS/LIKE 检索、CVE 命中 exploit 的
 * 分隔符精确匹配、窗口裁剪、大小裁剪、meta 水位读写、状态快照。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ParsedCve } from './nvd-parser';
import {
  buildFtsQuery,
  countCves,
  countExploits,
  extractCveId,
  getCveById,
  getDbFileSize,
  getIntelStatus,
  getMeta,
  hasIntelDb,
  openIntelStore,
  pruneBySize,
  pruneByWindow,
  removeMeta,
  replaceExploits,
  resetIntelStoreForTest,
  runInTransaction,
  searchCves,
  setMeta,
  upsertCves,
  type IntelDb,
} from './store';
import type { ParsedExploit } from './exploitdb-parser';

let dir: string;
let db: IntelDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-intel-'));
  resetIntelStoreForTest();
  db = openIntelStore(dir);
});

afterEach(() => {
  // SQLite（WAL）持有文件锁——先关句柄再删目录，否则 Windows EBUSY。
  resetIntelStoreForTest();
  rmSync(dir, { recursive: true, force: true });
});

function cve(id: string, published: string, description = `${id} description`): ParsedCve {
  return {
    id,
    description,
    cvssScore: 7.5,
    cvssVector: 'CVSS:3.1/AV:N/AC:L',
    published,
    modified: published,
    products: [{ vendor: 'apache', product: 'log4j' }],
  };
}

function exploit(id: number, cveRefs: string[]): ParsedExploit {
  return {
    id,
    filePath: `exploits/x/${id}.txt`,
    description: `exploit ${id}`,
    type: 'local',
    platform: 'linux',
    cveRefs,
    date: '2024-01-01',
  };
}

describe('建表 / meta', () => {
  it('打开即建表（幂等：重复打开不炸），hasIntelDb 探测不建库', () => {
    expect(hasIntelDb(dir)).toBe(true);
    expect(openIntelStore(dir)).toBe(db); // 缓存复用同一连接
    expect(getMeta(db, 'lastUpdateAt')).toBeNull();
  });

  it('meta 读写与删除', () => {
    setMeta(db, 'nvdWatermark', '2026-08-01T00:00:00.000Z');
    expect(getMeta(db, 'nvdWatermark')).toBe('2026-08-01T00:00:00.000Z');
    setMeta(db, 'nvdWatermark', '2026-08-02T00:00:00.000Z');
    expect(getMeta(db, 'nvdWatermark')).toBe('2026-08-02T00:00:00.000Z');
    removeMeta(db, 'nvdWatermark');
    expect(getMeta(db, 'nvdWatermark')).toBeNull();
  });
});

describe('upsertCves', () => {
  it('写入 + 同 id 覆盖（产品表先清后插，不重复）', () => {
    expect(runInTransaction(db, () => upsertCves(db, [cve('CVE-2024-0001', '2024-01-01')]))).toBe(1);
    const second: ParsedCve = {
      ...cve('CVE-2024-0001', '2024-01-01', 'updated description'),
      products: [{ vendor: 'linux', product: 'linux_kernel' }],
    };
    runInTransaction(db, () => upsertCves(db, [second]));
    expect(countCves(db)).toBe(1);
    const hit = getCveById(db, 'CVE-2024-0001');
    expect(hit?.description).toBe('updated description');
    expect(hit?.products).toEqual([{ vendor: 'linux', product: 'linux_kernel' }]);
  });

  it('minPublished 过滤：早于线或无日期的跳过', () => {
    const list = [
      cve('CVE-2024-0001', '2024-01-01'),
      cve('CVE-2010-0001', '2010-01-01'),
      cve('CVE-2025-0001', null as unknown as string),
    ];
    const added = runInTransaction(db, () => upsertCves(db, list, { minPublished: '2020-01-01T00:00:00.000Z' }));
    expect(added).toBe(1);
    expect(countCves(db)).toBe(1);
    expect(getCveById(db, 'CVE-2024-0001')).not.toBeNull();
    expect(getCveById(db, 'CVE-2010-0001')).toBeNull();
  });
});

describe('replaceExploits / exploit 命中', () => {
  it('整体替换（重复调用不叠加）', () => {
    runInTransaction(db, () => replaceExploits(db, [exploit(1, ['CVE-2024-0001'])]));
    expect(countExploits(db)).toBe(1);
    runInTransaction(db, () => replaceExploits(db, [exploit(2, ['CVE-2024-0002'])]));
    expect(countExploits(db)).toBe(1);
  });

  it('CVE 命中按分隔符精确匹配（CVE-2024-0001 不误匹配 CVE-2024-00012）', () => {
    runInTransaction(db, () => replaceExploits(db, [exploit(1, ['CVE-2024-0001', 'CVE-2024-00012'])]));
    runInTransaction(db, () => upsertCves(db, [cve('CVE-2024-0001', '2024-01-01'), cve('CVE-2024-00012', '2024-01-02'), cve('CVE-2024-0003', '2024-01-03')]));
    expect(getCveById(db, 'CVE-2024-0001')?.exploitCount).toBe(1);
    expect(getCveById(db, 'CVE-2024-00012')?.exploitCount).toBe(1);
    // 无 exploit 命中的 CVE 计数为 0（分隔符匹配没有误伤）
    expect(getCveById(db, 'CVE-2024-0003')?.exploitCount).toBe(0);
  });
});

describe('检索', () => {
  beforeEach(() => {
    const list = [
      { ...cve('CVE-2021-44228', '2021-12-10', 'Apache Log4j2 remote code execution in lookup mechanism') },
      { ...cve('CVE-2014-0160', '2014-04-07', 'OpenSSL TLS heartbeat information disclosure') },
      { ...cve('CVE-2023-0001', '2023-01-01', '示例 远程代码执行 漏洞') },
    ];
    runInTransaction(db, () => upsertCves(db, list));
  });

  it('CVE 编号精确查询（大小写不敏感，查询串带杂文也走精确路径）', () => {
    const hits = searchCves(db, 'cve-2021-44228 详情', 5);
    expect(hits.map((h) => h.id)).toEqual(['CVE-2021-44228']);
  });

  it('FTS 模糊：多词 AND 命中', () => {
    expect(searchCves(db, 'apache log4j', 5).map((h) => h.id)).toEqual(['CVE-2021-44228']);
    expect(searchCves(db, 'openssl', 5).map((h) => h.id)).toEqual(['CVE-2014-0160']);
    expect(searchCves(db, 'log4j openssl', 5)).toEqual([]); // 两词不同时出现
  });

  it('FTS 零命中落 LIKE 兜底（中文串召回）', () => {
    expect(searchCves(db, '远程代码执行', 5).map((h) => h.id)).toEqual(['CVE-2023-0001']);
  });

  it('limit 生效', () => {
    const hits = searchCves(db, 'CVE', 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('未知 id → 空；结果含产品与 exploit 计数', () => {
    expect(searchCves(db, 'CVE-1999-9999', 5)).toEqual([]);
    const hit = searchCves(db, 'log4j', 5)[0];
    expect(hit.products).toEqual([{ vendor: 'apache', product: 'log4j' }]);
    expect(hit.exploitCount).toBe(0);
  });
});

describe('buildFtsQuery / extractCveId', () => {
  it('词元引号包裹 + AND 连接，内部引号转义', () => {
    expect(buildFtsQuery('apache log4j')).toBe('"apache" AND "log4j"');
    expect(buildFtsQuery('say "hi" now')).toBe('"say" AND """hi""" AND "now"');
    expect(buildFtsQuery('   ')).toBe('');
  });

  it('CVE 编号抽取', () => {
    expect(extractCveId('CVE-2024-1234')).toBe('CVE-2024-1234');
    expect(extractCveId('看 cve-2024-12345 这条')).toBe('CVE-2024-12345');
    expect(extractCveId('没有编号')).toBeNull();
  });
});

describe('裁剪', () => {
  it('窗口裁剪：早于线或无日期的删除', () => {
    const list = [
      cve('CVE-2024-0001', '2024-01-01'),
      cve('CVE-2010-0001', '2010-01-01'),
      cve('CVE-2025-0001', null as unknown as string),
    ];
    runInTransaction(db, () => upsertCves(db, list));
    const deleted = runInTransaction(db, () => pruneByWindow(db, '2020-01-01T00:00:00.000Z'));
    expect(deleted).toBe(2);
    expect(countCves(db)).toBe(1);
    expect(getCveById(db, 'CVE-2024-0001')).not.toBeNull();
  });

  it('大小裁剪：超限按最旧先删，达标即停', () => {
    const list = [
      cve('CVE-2010-0001', '2010-01-01'),
      cve('CVE-2015-0001', '2015-01-01'),
      cve('CVE-2024-0001', '2024-01-01'),
    ];
    runInTransaction(db, () => upsertCves(db, list));
    // 上限给空库大小（schema 占的空间）→ 数据行全删，schema 删不掉即停
    const deleted = pruneBySize(db, getDbFileSize(db));
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(countCves(db)).toBe(0);
    // 上限充足 → 一条不删
    runInTransaction(db, () => upsertCves(db, list));
    expect(pruneBySize(db, 10 * 1024 * 1024 * 1024)).toBe(0);
    expect(countCves(db)).toBe(3);
  });
});

describe('状态快照', () => {
  it('getIntelStatus 汇总 meta 与计数', () => {
    setMeta(db, 'mode', 'window');
    setMeta(db, 'lastUpdateAt', '2026-08-19T05:00:00.000Z');
    runInTransaction(db, () => upsertCves(db, [cve('CVE-2024-0001', '2024-01-01')]));
    runInTransaction(db, () => replaceExploits(db, [exploit(1, ['CVE-2024-0001'])]));
    const status = getIntelStatus(db);
    expect(status).toMatchObject({
      dbExists: true,
      mode: 'window',
      lastUpdateAt: '2026-08-19T05:00:00.000Z',
      cveCount: 1,
      exploitCount: 1,
      nvdWatermark: null,
    });
    expect(status.dbFileSizeBytes).toBeGreaterThan(0);
  });
});
