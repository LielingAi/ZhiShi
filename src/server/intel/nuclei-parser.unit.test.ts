/**
 * nuclei-parser 单元测试（1.1.4 情报横切 × pentest 域）。
 *
 * 覆盖：正常 NDJSON 解析（多行 + 同 CVE 多模板 + 大写归一 + 去重）、
 * 空文本、坏 JSON 行跳过、字段缺失/非 CVE 的 ID 过滤、混合行只留合法项。
 */
import { describe, expect, it } from 'vitest';

import { parseNucleiCvesJson } from './nuclei-parser';

function line(id: string, path: string): string {
  return JSON.stringify({ ID: id, Info: { Name: 'x' }, file_path: path });
}

describe('parseNucleiCvesJson', () => {
  it('正常 NDJSON：摘 ID + file_path，ID 大写归一', () => {
    const text = [
      line('CVE-2021-44228', 'http/cves/2021/CVE-2021-44228.yaml'),
      line('cve-2024-1234', 'network/cves/2024/CVE-2024-1234.yaml'),
    ].join('\n');
    expect(parseNucleiCvesJson(text)).toEqual([
      { cveId: 'CVE-2021-44228', templatePath: 'http/cves/2021/CVE-2021-44228.yaml' },
      { cveId: 'CVE-2024-1234', templatePath: 'network/cves/2024/CVE-2024-1234.yaml' },
    ]);
  });

  it('同一 CVE 多模板：全部保留；重复行去重（首行胜出）', () => {
    const text = [
      line('CVE-2024-0001', 'http/a.yaml'),
      line('CVE-2024-0001', 'http/b.yaml'),
      line('CVE-2024-0001', 'http/a.yaml'), // 重复
    ].join('\n');
    const parsed = parseNucleiCvesJson(text);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((p) => p.templatePath)).toEqual(['http/a.yaml', 'http/b.yaml']);
  });

  it('空文本 → 0 条（sync 据此保留旧数据）', () => {
    expect(parseNucleiCvesJson('')).toEqual([]);
    expect(parseNucleiCvesJson('\n\n  \n')).toEqual([]);
  });

  it('坏 JSON 行跳过：全坏 → 0 条', () => {
    const text = 'not-json\n{"ID":\n{broken\n';
    expect(parseNucleiCvesJson(text)).toEqual([]);
  });

  it('字段缺失 / 非 CVE 的 ID / 空路径过滤；混合行只留合法项', () => {
    const text = [
      line('CVE-2024-0001', 'http/a.yaml'),
      JSON.stringify({ Info: {}, file_path: 'http/no-id.yaml' }), // 无 ID
      JSON.stringify({ ID: 'OSVDB-1234', file_path: 'http/x.yaml' }), // 非 CVE
      JSON.stringify({ ID: 'CVE-2024-0002', file_path: '' }), // 空路径
      JSON.stringify('just a string'), // 行是标量
      line('CVE-2024-0003', 'http/c.yaml'),
    ].join('\n');
    const parsed = parseNucleiCvesJson(text);
    expect(parsed.map((p) => p.cveId)).toEqual(['CVE-2024-0001', 'CVE-2024-0003']);
  });
});
