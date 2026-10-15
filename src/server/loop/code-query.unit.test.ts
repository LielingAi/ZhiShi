/**
 * 1.9.10 code_query —— 纯函数单测（先红后绿，设计稿 §4 验收的单元层）。
 *
 * execute 的 joern/env 通道在测试中以假 deps 注入；本文件只钉纯逻辑：
 * 结果截断纪律（Q3 教训）、joern JSON 解析、CPGQL 清洗、CPG 状态机。
 */
import { describe, expect, it } from 'vitest';

import {
  cleanCpgl,
  cpgStateFromMeta,
  parseJoernJson,
  truncateResults,
  type CqResult,
} from './code-query';

describe('truncateResults（截断纪律：top≤8 · 条≤1200字符 · 总量~10KB）', () => {
  const mk = (n: number, len = 100): CqResult[] =>
    Array.from({ length: n }, (_, i) => ({
      path: `f${i}.c`, line_start: i + 1, line_end: i + 40,
      text: 'x'.repeat(len),
    }));

  it('条数超 8 → 截到 8，末条标注丢弃', () => {
    const out = truncateResults(mk(12));
    expect(out.length).toBe(8);
    expect(out[7].text.endsWith('…[truncated]')).toBe(true);
  });

  it('单条 >1200 字符 → 截断标注', () => {
    const out = truncateResults(mk(1, 5000));
    expect(out[0].text.length).toBeLessThanOrEqual(1200 + '…[truncated]'.length + 1);
    expect(out[0].text).toContain('…[truncated]');
  });

  it('总量超 ~10KB → 尾部整丢弃并标注', () => {
    const out = truncateResults(mk(8, 1400)); // 8×1400=11.2KB
    const total = out.reduce((s, r) => s + r.text.length, 0);
    expect(total).toBeLessThanOrEqual(10_240);
    expect(out[out.length - 1].text).toContain('…[truncated]');
  });
});

describe('parseJoernJson（joern 脚本写出的 JSONL：path/line/name）', () => {
  it('正常行解析 · 坏行跳过 · 非 JSON 输入返回空', () => {
    const raw = [
      '{"path":"/src/sctp_input.c","line":1029,"name":"sctp_free_a_strmoq"}',
      'not-json',
      '{"path":"/src/sctp_out.c","line":640}',
    ].join('\n');
    const out = parseJoernJson(raw);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ path: '/src/sctp_input.c', line_start: 1029, symbol: 'sctp_free_a_strmoq' });
    expect(out[1].symbol).toBeUndefined();
    expect(parseJoernJson('')).toEqual([]);
    expect(parseJoernJson('[[[')).toEqual([]);
  });
});

describe('cleanCpgl（模型输入的查询清洗：长度闸 + 控制字符）', () => {
  it('常规 CPGQL 原样通过', () => {
    const q = 'cpg.call("memcpy").argument(2).reachableBy(cpg.call("recv"))';
    expect(cleanCpgl(q)).toBe(q);
  });
  it('CR/控制字符剥离 · 超长截断（4K 闸）', () => {
    expect(cleanCpgl('a\rb\nc')).toBe('ab\nc');
    expect(cleanCpgl('x'.repeat(5000)).length).toBe(4000);
  });
});

describe('cpgStateFromMeta（状态机：missing/building/ready/stale/failed）', () => {
  it('无元数据 → missing；building 中 → building；失败标记 → failed', () => {
    expect(cpgStateFromMeta(null, 'fp1')).toBe('missing');
    expect(cpgStateFromMeta({ state: 'building' }, 'fp1')).toBe('building');
    expect(cpgStateFromMeta({ state: 'failed', error: 'oom' }, 'fp1')).toBe('failed');
  });
  it('指纹一致 → ready；不一致 → stale', () => {
    expect(cpgStateFromMeta({ state: 'ready', fingerprint: 'fp1' }, 'fp1')).toBe('ready');
    expect(cpgStateFromMeta({ state: 'ready', fingerprint: 'fp1' }, 'fp2')).toBe('stale');
  });
});
