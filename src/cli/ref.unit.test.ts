/**
 * refs 大值外溢消费端单测（CLI 侧，1.6.3 debt #2）。
 * 覆盖：{kind:'ref'} 占位识别、printResult 深扫（嵌套/去重/深度封顶）、
 * 取回指引文案、fetchRefBody（200 全文 / 404 GC 降级 / 非法 id 短路 /
 * 传输失败）——fetch 全注入，不碰真实网络。
 */

import { describe, expect, it } from 'vitest';

import {
  collectRefs,
  fetchRefBody,
  formatRefHints,
  isLargeValueRef,
  isValidRefId,
  type LargeValueRef,
  type RefFetch,
} from './ref';

function makeRef(over: Partial<LargeValueRef> = {}): LargeValueRef {
  return {
    kind: 'ref',
    id: 'ab12cd34',
    sizeBytes: 300 * 1024,
    mimetype: 'application/json',
    preview: 'HEAD…',
    expiresAt: Date.now() + 3_600_000,
    ...over,
  };
}

describe('isLargeValueRef / isValidRefId', () => {
  it('完整形状 → true；kind/字段/id 形状不合 → false', () => {
    expect(isLargeValueRef(makeRef())).toBe(true);
    expect(isLargeValueRef({ ...makeRef(), kind: 'inline' })).toBe(false);
    expect(isLargeValueRef({ kind: 'ref', id: 'ab12cd34' })).toBe(false);
    expect(isLargeValueRef(makeRef({ id: 'AB12CD34' }))).toBe(false);
    expect(isLargeValueRef(null)).toBe(false);
    expect(isLargeValueRef([makeRef()])).toBe(false);
  });
  it('id 口径 = /refs/:id 路由（8–32 位小写 hex）', () => {
    expect(isValidRefId('ab12cd34')).toBe(true);
    expect(isValidRefId('a'.repeat(32))).toBe(true);
    expect(isValidRefId('abc')).toBe(false);
    expect(isValidRefId('AB12CD34')).toBe(false);
    expect(isValidRefId('../etc')).toBe(false);
  });
});

describe('collectRefs（printResult 深扫）', () => {
  it('嵌套对象/数组里的占位全部扫出', () => {
    const result = {
      success: true,
      data: {
        rows: [{ output: makeRef() }, { nested: { deep: makeRef({ id: 'ff00ff00' }) } }],
      },
    };
    const refs = collectRefs(result);
    expect(refs.map((r) => r.id).sort()).toEqual(['ab12cd34', 'ff00ff00']);
  });
  it('按 id 去重；非占位对象不误报', () => {
    const dup = makeRef();
    const refs = collectRefs({ a: dup, b: [dup, { kind: 'ref-ish', id: 'ab12cd34' }] });
    expect(refs).toHaveLength(1);
    expect(collectRefs({ kind: 'ref', id: 'AB12CD34' })).toHaveLength(0);
    expect(collectRefs(null)).toHaveLength(0);
    expect(collectRefs('ref')).toHaveLength(0);
  });
  it('深度封顶 8 层（畸形嵌套不炸栈、不漏扫浅层）', () => {
    let deep: unknown = makeRef();
    for (let i = 0; i < 12; i++) deep = { next: deep };
    expect(collectRefs(deep)).toHaveLength(0);
    let shallow: unknown = makeRef();
    for (let i = 0; i < 4; i++) shallow = { next: shallow };
    expect(collectRefs(shallow)).toHaveLength(1);
  });
});

describe('formatRefHints', () => {
  it('指引含 ref id / 体积 / 取回命令', () => {
    const [line] = formatRefHints([makeRef()]);
    expect(line).toContain('ref=ab12cd34');
    expect(line).toContain('300 KB');
    expect(line).toContain('zhishi refs get ab12cd34');
  });
});

describe('fetchRefBody（GET /refs/:id）', () => {
  const okFetch = (body: string, seen: { url?: string }): RefFetch =>
    async (url) => {
      seen.url = url;
      return {
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/json' },
        text: async () => body,
      };
    };

  it('200 → 返回全文（URL = 根路径 /refs/<id>，base 尾斜杠去重）', async () => {
    const seen: { url?: string } = {};
    const res = await fetchRefBody('http://127.0.0.1:3199/', 'ab12cd34', okFetch('FULL', seen));
    expect(seen.url).toBe('http://127.0.0.1:3199/refs/ab12cd34');
    expect(res).toEqual({ ok: true, body: 'FULL', contentType: 'application/json' });
  });

  it('404（GC/TTL 过期）→ ok:false + expired 语义', async () => {
    const fetch404: RefFetch = async () => ({
      status: 404,
      statusText: 'Not Found',
      headers: { get: () => 'application/json' },
      text: async () => '{"error":"ref not found or expired"}',
    });
    const res = await fetchRefBody('http://x', 'dead0000', fetch404);
    expect(res).toEqual({ ok: false, status: 404, error: 'ref not found or expired' });
  });

  it('非法 id → 400 语义短路（不发请求）', async () => {
    let called = false;
    const spy: RefFetch = async () => {
      called = true;
      throw new Error('unreachable');
    };
    const res = await fetchRefBody('http://x', 'ZZ!!', spy);
    expect(called).toBe(false);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });

  it('传输层失败（连接拒绝）→ status 0 + 错误原文', async () => {
    const boom: RefFetch = async () => {
      throw new Error('fetch failed');
    };
    const res = await fetchRefBody('http://x', 'ab12cd34', boom);
    expect(res).toEqual({ ok: false, status: 0, error: 'fetch failed' });
  });

  it('非 2xx 非 404 → HTTP 状态透传', async () => {
    const f500: RefFetch = async () => ({
      status: 500,
      statusText: 'Internal Server Error',
      headers: { get: () => null },
      text: async () => '',
    });
    const res = await fetchRefBody('http://x', 'ab12cd34', f500);
    expect(res).toEqual({ ok: false, status: 500, error: 'HTTP 500 Internal Server Error' });
  });
});
