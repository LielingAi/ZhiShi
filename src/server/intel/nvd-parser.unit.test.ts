/**
 * nvd-parser 单元测试（1.1.2 情报横切）。
 *
 * 覆盖：V31/V30/V2 降级选取与 Primary 优先级、无 CVSS 的旧记录、描述
 * 英文优先、多产品去重、CPE 转义冒号、vulnerable=false 剔除、畸形 id
 * 跳过、404 错误体 → 空页（解析层绝不 throw）。
 */
import { describe, expect, it } from 'vitest';

import { parseCpeCriteria, parseNvdPage } from './nvd-parser';

/** 造一条最小 CVE（字段可按需覆盖）。 */
function cveItem(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'CVE-2021-44228',
    descriptions: [{ lang: 'en', value: 'Apache Log4j2 remote code execution' }],
    metrics: {
      cvssMetricV31: [{
        source: 'nvd@nist.gov',
        type: 'Primary',
        cvssData: { version: '3.1', baseScore: 10.0, baseSeverity: 'CRITICAL', vectorString: 'CVSS:3.1/AV:N/AC:L' },
      }],
    },
    configurations: [{
      nodes: [{
        operator: 'OR',
        cpeMatch: [{ vulnerable: true, criteria: 'cpe:2.3:a:apache:log4j:2.14.1:*:*:*:*:*:*:*' }],
      }],
    }],
    published: '2021-12-10T10:15:07.653',
    lastModified: '2022-01-01T00:00:00.000',
    ...overrides,
  };
}

function page(vulnerabilities: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    resultsPerPage: 2000,
    startIndex: 0,
    totalResults: vulnerabilities.length,
    format: 'NVD_CVE',
    version: '2.0',
    timestamp: '2026-08-19T05:00:00.000',
    vulnerabilities,
    ...extra,
  };
}

describe('parseNvdPage 基础提取', () => {
  it('V31 Primary 的 baseScore/vectorString、英文描述、产品与日期齐全', () => {
    const cves = parseNvdPage(page([{ cve: cveItem({}) }])).cves;
    expect(cves).toHaveLength(1);
    expect(cves[0]).toEqual({
      id: 'CVE-2021-44228',
      description: 'Apache Log4j2 remote code execution',
      cvssScore: 10.0,
      cvssVector: 'CVSS:3.1/AV:N/AC:L',
      published: '2021-12-10T10:15:07.653',
      modified: '2022-01-01T00:00:00.000',
      products: [{ vendor: 'apache', product: 'log4j' }],
    });
  });

  it('描述优先英文（lang=en），回落第一条', () => {
    const cn = page([{
      cve: cveItem({
        descriptions: [
          { lang: 'zh', value: '描述中文' },
          { lang: 'en', value: 'English description' },
        ],
      }),
    }]);
    expect(parseNvdPage(cn).cves[0].description).toBe('English description');
    const fallback = page([{
      cve: cveItem({ descriptions: [{ lang: 'zh', value: '只有中文' }] }),
    }]);
    expect(parseNvdPage(fallback).cves[0].description).toBe('只有中文');
  });

  it('CVSS 降级：V31 缺失走 V30，再缺失走 V2', () => {
    const v30 = page([{
      cve: cveItem({
        metrics: {
          cvssMetricV30: [{
            type: 'Primary',
            cvssData: { version: '3.0', baseScore: 7.5, vectorString: 'CVSS:3.0/AV:N/AC:L' },
          }],
        },
      }),
    }]);
    expect(parseNvdPage(v30).cves[0].cvssScore).toBe(7.5);
    expect(parseNvdPage(v30).cves[0].cvssVector).toBe('CVSS:3.0/AV:N/AC:L');
    const v2 = page([{
      cve: cveItem({
        metrics: { cvssMetricV2: [{ type: 'Primary', cvssData: { version: '2.0', baseScore: 5.0, vectorString: 'AV:N/AC:L' } }] },
      }),
    }]);
    expect(parseNvdPage(v2).cves[0].cvssScore).toBe(5.0);
    expect(parseNvdPage(v2).cves[0].cvssVector).toBe('AV:N/AC:L');
  });

  it('组内 Primary 优先于非 Primary；无 CVSS 时两个字段都 null', () => {
    const mixed = page([{
      cve: cveItem({
        metrics: {
          cvssMetricV31: [
            { type: 'Secondary', cvssData: { baseScore: 3.0, vectorString: 'CVSS:3.1/X' } },
            { type: 'Primary', cvssData: { baseScore: 9.0, vectorString: 'CVSS:3.1/P' } },
          ],
        },
      }),
    }]);
    expect(parseNvdPage(mixed).cves[0].cvssScore).toBe(9.0);
    const none = page([{ cve: cveItem({ metrics: {} }) }]);
    expect(parseNvdPage(none).cves[0].cvssScore).toBeNull();
    expect(parseNvdPage(none).cves[0].cvssVector).toBeNull();
  });

  it('多产品去重（重复 criteria 只留一条）', () => {
    const cve = cveItem({
      configurations: [{
        nodes: [{
          cpeMatch: [
            { vulnerable: true, criteria: 'cpe:2.3:a:apache:log4j:*:*:*:*:*:*:*:*' },
            { vulnerable: true, criteria: 'cpe:2.3:a:apache:log4j:*:*:*:*:*:*:*:*' },
            { vulnerable: true, criteria: 'cpe:2.3:o:linux:linux_kernel:5.4:*:*:*:*:*:*:*' },
          ],
        }],
      }],
    });
    expect(parseNvdPage(page([{ cve }])).cves[0].products).toEqual([
      { vendor: 'apache', product: 'log4j' },
      { vendor: 'linux', product: 'linux_kernel' },
    ]);
  });

  it('vulnerable=false 的 cpeMatch 不算受影响产品', () => {
    const cve = cveItem({
      configurations: [{
        nodes: [{
          cpeMatch: [{ vulnerable: false, criteria: 'cpe:2.3:a:apache:log4j:2.15.0:*:*:*:*:*:*:*' }],
        }],
      }],
    });
    expect(parseNvdPage(page([{ cve }])).cves[0].products).toEqual([]);
  });
});

describe('parseNvdPage 宽容处理（绝不 throw）', () => {
  it('id 缺失或形状非法跳过', () => {
    const bad = page([
      { cve: cveItem({ id: 'not-a-cve' }) },
      { cve: cveItem({ id: 'CVE-123-45' }) },
      { cve: { descriptions: [] } },
      { cve: cveItem({}) },
    ]);
    const parsed = parseNvdPage(bad);
    expect(parsed.cves.map((c) => c.id)).toEqual(['CVE-2021-44228']);
  });

  it('404 错误体 / 非对象 → 空页且 meta 归零', () => {
    expect(parseNvdPage({ message: 'Resource not found' }).cves).toEqual([]);
    expect(parseNvdPage(null).cves).toEqual([]);
    expect(parseNvdPage(null).meta.totalResults).toBe(0);
  });

  it('分页 meta 原样透出（sync 游标数据源）', () => {
    const parsed = parseNvdPage(page([{ cve: cveItem({}) }], { totalResults: 999, startIndex: 2000 }));
    expect(parsed.meta).toEqual({ totalResults: 999, startIndex: 2000, resultsPerPage: 2000 });
  });
});

describe('parseCpeCriteria', () => {
  it('标准 CPE 2.3 提取 vendor/product', () => {
    expect(parseCpeCriteria('cpe:2.3:a:microsoft:edge:109.0:*:*:*:*:*:*:*')).toEqual({
      vendor: 'microsoft', product: 'edge',
    });
  });

  it('转义冒号（\\:）不切段、反斜杠解转义', () => {
    expect(parseCpeCriteria('cpe:2.3:a:vendor\\:name:prod\\:uct:1.0:*:*:*:*:*:*:*')).toEqual({
      vendor: 'vendor:name', product: 'prod:uct',
    });
  });

  it('形状不符返回 null（不足 6 段 / 非 cpe 前缀）', () => {
    expect(parseCpeCriteria('cpe:2.3:a:only')).toBeNull();
    expect(parseCpeCriteria('cpe:/a:vendor:product')).toBeNull();
    expect(parseCpeCriteria('')).toBeNull();
  });
});
