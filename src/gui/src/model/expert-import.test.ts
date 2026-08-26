/**
 * 专家知识导入解析单测（1.3.1 ⑥）：JSON/YAML → 条目数组 + 最小校验。
 */

import { describe, expect, it } from 'vitest';

import { parseExpertImport, validateImportEntry } from './expert-import';

const validEntry = {
  title: '堆喷占位经验',
  kind: 'technique',
  domain: 'binary',
  applicability: 'glibc 2.3x 堆题',
  content: '做法正文',
  criteria: '判定条件',
  reviewer: '我',
};

describe('validateImportEntry', () => {
  it('全字段通过', () => {
    expect(validateImportEntry({ ...validEntry })).toBeNull();
  });

  it('缺必填 / kind 非法 → 报错', () => {
    expect(validateImportEntry({ ...validEntry, title: '' })).toContain('title');
    expect(validateImportEntry({ ...validEntry, kind: 'sop' })).toBeNull();
    expect(validateImportEntry({ ...validEntry, kind: 'recipe' })).toContain('kind 非法');
  });
});

describe('parseExpertImport', () => {
  it('空输入 → 报错', () => {
    expect(parseExpertImport('  ').ok).toBe(false);
  });

  it('JSON 单条', () => {
    const r = parseExpertImport(JSON.stringify(validEntry));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries).toHaveLength(1);
  });

  it('JSON 数组批量', () => {
    const r = parseExpertImport(JSON.stringify([validEntry, { ...validEntry, title: '第二条' }]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries).toHaveLength(2);
  });

  it('YAML 单条 / 数组', () => {
    const yaml = [
      'title: SQLite UNION 注入标准链',
      'kind: sop',
      'domain: pentest',
      'applicability: 有回显的查询',
      'content: 正文',
      'criteria: 判定',
      'reviewer: 我',
    ].join('\n');
    expect(parseExpertImport(yaml).ok).toBe(true);

    const yamlArr = ['- title: 条目一', '  kind: idea', '  domain: ai-security', '  applicability: x', '  content: c', '  criteria: r', '  reviewer: 我', '- title: 条目二', '  kind: technique', '  domain: binary', '  applicability: y', '  content: c2', '  criteria: r2', '  reviewer: 我'].join('\n');
    const r = parseExpertImport(yamlArr);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries).toHaveLength(2);
  });

  it('缺必填的条目 → 报错并指明条目序号', () => {
    const r = parseExpertImport(JSON.stringify([validEntry, { ...validEntry, title: '' }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('第 2 条');
  });

  it('既非 JSON 也非 YAML → 报错', () => {
    expect(parseExpertImport('{{{ not json or yaml').ok).toBe(false);
  });

  it('非对象/数组 → 报错', () => {
    expect(parseExpertImport('42').ok).toBe(false);
  });
});
