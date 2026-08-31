/**
 * drawer-highlight 单测（A2-7 回归）：搜索定位在纯文本上做，
 * 搜 class 名片段（'hl'/'span'/'flag' 的非输出命中）不得产出破 HTML。
 */

import { describe, expect, it } from 'vitest';

import { drawerOutputHtml, highlight, locateMatch } from './drawer-highlight';

describe('highlight', () => {
  it('flag{} / SIGSEGV / 0x 地址 / CVE 上高亮标签', () => {
    expect(highlight('got flag{a}')).toContain('<span class="hl-flag">flag{a}</span>');
    expect(highlight('SIGSEGV')).toContain('<span class="hl-red">SIGSEGV</span>');
    expect(highlight('at 0x4141')).toContain('<span class="hl-cyan">0x4141</span>');
    expect(highlight('CVE-2024-23334')).toContain('<span class="hl-amber">CVE-2024-23334</span>');
  });

  it('先 escapeHtml 再上标签（输出里的 < 不注入）', () => {
    expect(highlight('a<b>')).toBe('a&lt;b&gt;');
  });
});

describe('locateMatch（纯文本定位）', () => {
  it('命中返回三段切片；大小写不敏感', () => {
    expect(locateMatch('hello FLAG world', 'flag')).toEqual({ before: 'hello ', match: 'FLAG', after: ' world' });
  });

  it('无命中 / 空查询 → undefined', () => {
    expect(locateMatch('hello', 'zzz')).toBeUndefined();
    expect(locateMatch('hello', '  ')).toBeUndefined();
  });
});

describe('drawerOutputHtml（A2-7 回归）', () => {
  it('搜 "flag"：命中输出里的 flag{…} 本体，mark 不切标签', () => {
    const html = drawerOutputHtml('read ok flag{d0n7} done', 'flag{');
    expect(html).toContain('<mark class="h-search">flag{</mark>');
    // mark 之后的高亮段仍是合法 span（不被截断成 "<span cl" 之类）。
    expect(html).not.toMatch(/<span(?![ >])/);
    expect((html.match(/<span /g) ?? []).length).toBe((html.match(/<\/span>/g) ?? []).length);
  });

  it('搜 class 名片段 "hl"/"span"/"mark"：纯文本无命中 → 与无搜索输出一致（不出破 HTML）', () => {
    const raw = 'flag{a} SIGSEGV at 0x41';
    const base = highlight(raw);
    expect(drawerOutputHtml(raw, 'hl')).toBe(base);
    expect(drawerOutputHtml(raw, 'span')).toBe(base);
    expect(drawerOutputHtml(raw, 'mark')).toBe(base);
  });

  it('命中段 HTML 转义（查询含 < 不注入标签）', () => {
    const html = drawerOutputHtml('x <b> y', '<b>');
    expect(html).toContain('<mark class="h-search">&lt;b&gt;</mark>');
  });

  it('无命中走整段高亮', () => {
    expect(drawerOutputHtml('plain text', 'nomatch')).toBe(highlight('plain text'));
  });
});
