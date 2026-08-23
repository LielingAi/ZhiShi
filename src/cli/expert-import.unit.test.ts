/**
 * expert-import（CLI 批量导入）单元测试（1.2.10）。
 *
 * 解析纯函数：parseExpertImport / validateImportEntry（无 IO 直接断言）。
 * 执行侧 importExpertEntries 注入 poster——不起 HTTP、不碰服务端；
 * 校验走服务端同款单点 validateEntry（口径一致性顺便验证）。
 *
 * 覆盖：JSON/YAML、单对象/数组、扩展名优先与内容嗅探、缺字段/非法枚举/
 * 缺 reviewer 报错跳过、--reviewer 兜底、provenance 强制 user、
 * 混合批量部分成功（含服务端拒绝）、全部失败汇总。
 */
import { describe, expect, it } from 'vitest';

import {
  importExpertEntries,
  parseExpertImport,
  validateImportEntry,
  type ImportPoster,
} from './expert-import';

const VALID = {
  domain: 'binary',
  kind: 'technique',
  title: '栈溢出 triage',
  applicability: '拿到崩溃现场',
  content: '先定界再定位',
  criteria: '判据',
  reviewer: 'alice',
  tags: 'pwn, stack',
};

/** 记录请求体的 poster 替身；failOn 里的标题模拟服务端拒绝。 */
function makePoster(failOn: string[] = []) {
  const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
  const post: ImportPoster = async (route, body) => {
    calls.push({ route, body });
    if (failOn.includes(String(body.title))) {
      return { success: false, error: '服务端拒绝：content_hash 重复' };
    }
    return { success: true, data: { entry: { id: calls.length } } };
  };
  return { calls, post };
}

describe('parseExpertImport', () => {
  it('JSON 单对象归一为单元素数组', () => {
    const r = parseExpertImport(JSON.stringify(VALID), 'a.json');
    expect(r).toEqual({ ok: true, entries: [VALID] });
  });

  it('JSON 数组原样返回', () => {
    const arr = [VALID, { ...VALID, title: '另一条' }];
    const r = parseExpertImport(JSON.stringify(arr), 'a.json');
    expect(r).toEqual({ ok: true, entries: arr });
  });

  it('YAML 数组解析', () => {
    const yaml = `- title: 条目一\n  kind: sop\n  domain: pentest\n  applicability: a\n  content: c\n  criteria: j\n  reviewer: bob\n`;
    const r = parseExpertImport(yaml, 'a.yaml');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toHaveLength(1);
      expect((r.entries[0] as Record<string, unknown>).title).toBe('条目一');
    }
  });

  it('.yml 扩展名同 YAML', () => {
    const r = parseExpertImport('title: x\nkind: idea\n', 'a.yml');
    expect(r.ok).toBe(true);
  });

  it('.json 扩展名强制 JSON：YAML 内容按 JSON 解析报错', () => {
    const r = parseExpertImport('title: x\n', 'a.json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('JSON 解析失败');
  });

  it('无扩展名内容嗅探：JSON 优先', () => {
    const r = parseExpertImport(JSON.stringify(VALID), 'noext');
    expect(r).toEqual({ ok: true, entries: [VALID] });
  });

  it('无扩展名内容嗅探：回退 YAML', () => {
    const r = parseExpertImport('title: x\nkind: idea\n', 'noext');
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.entries[0] as Record<string, unknown>).title).toBe('x');
  });

  it('空数组报错', () => {
    const r = parseExpertImport('[]', 'a.json');
    expect(r).toEqual({ ok: false, error: '文件中没有条目（空数组）' });
  });

  it('YAML 语法错误报错', () => {
    const r = parseExpertImport('- a\n- b\n  - 缩进错乱: [', 'a.yaml');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('YAML 解析失败');
  });
});

describe('validateImportEntry', () => {
  it('合法条目过校验，provenance 强制 user', () => {
    const v = validateImportEntry(VALID);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.provenance).toBe('user');
  });

  it('条目声明 builtin 也被强制为 user（reviewer 仍必填）', () => {
    const v = validateImportEntry({ ...VALID, provenance: 'builtin' });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.provenance).toBe('user');
  });

  it('缺必填字段：列出 validateEntry 错误', () => {
    const { criteria: _omit, ...rest } = VALID;
    const v = validateImportEntry(rest);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('criteria 必填且非空');
  });

  it('非法枚举 kind 报错', () => {
    const v = validateImportEntry({ ...VALID, kind: 'xxx' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('kind 非法');
  });

  it('缺 reviewer（条目与兜底皆无）报错跳过', () => {
    const { reviewer: _omit, ...rest } = VALID;
    const v = validateImportEntry(rest);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('缺 reviewer');
  });

  it('缺条目 reviewer 时 --reviewer 兜底', () => {
    const { reviewer: _omit, ...rest } = VALID;
    const v = validateImportEntry(rest, 'carol');
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.reviewer).toBe('carol');
  });

  it('条目 reviewer 优先于 --reviewer', () => {
    const v = validateImportEntry(VALID, 'carol');
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.reviewer).toBe('alice');
  });

  it('非对象条目（数组/标量/null）报错', () => {
    for (const bad of [[1, 2], 'str', null, 42]) {
      const v = validateImportEntry(bad);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error).toContain('条目必须是对象');
    }
  });
});

describe('importExpertEntries', () => {
  it('全部合法：逐条调 expert/add，body 与 expert new 同款（无 provenance）', async () => {
    const { calls, post } = makePoster();
    const r = await importExpertEntries([VALID, { ...VALID, title: '第二条' }], { post });
    expect(r.failed).toEqual([]);
    expect(r.ok).toHaveLength(2);
    expect(r.ok[0]).toEqual({ index: 1, title: '栈溢出 triage', id: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[0].route).toBe('expert/add');
    expect(calls[0].body).toEqual({
      domain: 'binary',
      kind: 'technique',
      title: '栈溢出 triage',
      applicability: '拿到崩溃现场',
      content: '先定界再定位',
      criteria: '判据',
      reviewer: 'alice',
      tags: 'pwn, stack',
    });
  });

  it('混合批量：校验失败的条目不发 API，其余继续（部分成功）', async () => {
    const { calls, post } = makePoster();
    const bad1 = { ...VALID, kind: 'xxx', title: '坏枚举' };
    const { reviewer: _r, ...noReviewer } = VALID;
    const bad2 = { ...noReviewer, title: '缺审定人' };
    const notObj = 'just a string';
    const r = await importExpertEntries([bad1, VALID, bad2, notObj], { post });
    expect(r.ok).toEqual([{ index: 2, title: '栈溢出 triage', id: 1 }]);
    expect(r.failed.map((f) => f.index)).toEqual([1, 3, 4]);
    expect(r.failed[0].title).toBe('坏枚举');
    expect(r.failed[1].error).toContain('缺 reviewer');
    expect(r.failed[2].error).toContain('条目必须是对象');
    expect(calls).toHaveLength(1); // 只有合法那条发了 API
  });

  it('服务端拒绝记 failed（带标题与原因），不阻塞后续', async () => {
    const { post } = makePoster(['被拒的']);
    const r = await importExpertEntries(
      [{ ...VALID, title: '被拒的' }, { ...VALID, title: '正常的' }],
      { post },
    );
    expect(r.failed).toEqual([{ index: 1, title: '被拒的', error: '服务端拒绝：content_hash 重复' }]);
    expect(r.ok).toEqual([{ index: 2, title: '正常的', id: 2 }]);
  });

  it('全部失败：ok 为空、failed 全列', async () => {
    const { post } = makePoster();
    const r = await importExpertEntries([{ kind: 'xxx' }, 'nope'], { post });
    expect(r.ok).toEqual([]);
    expect(r.failed).toHaveLength(2);
    expect(r.failed[0].title).toBe('（无标题）');
  });

  it('--reviewer 兜底贯穿批量执行', async () => {
    const { calls, post } = makePoster();
    const { reviewer: _omit, ...rest } = VALID;
    const r = await importExpertEntries([rest], { reviewer: 'carol', post });
    expect(r.ok).toHaveLength(1);
    expect(calls[0].body.reviewer).toBe('carol');
  });
});
