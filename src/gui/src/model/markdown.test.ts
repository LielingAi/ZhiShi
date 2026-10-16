/**
 * looksLikeMarkdown 单测（V4-S7）——双端纪律：
 *   含结构语法必命中（标题/列表/引用/围栏/表格/行内 code·加粗·链接）；
 *   普通多行文本（日志/报错/路径/乘号星号）必不命中（误判会拆段落丢换行，
 *   比漏判伤得多——漏判只是源码直出，零信息损失）。
 */

import { describe, expect, it } from 'vitest';

import { looksLikeMarkdown } from './markdown';

describe('looksLikeMarkdown — markdown 必命中', () => {
  it('ATX 标题（行首锚定，#号不在行首不算）', () => {
    expect(looksLikeMarkdown('# 标题')).toBe(true);
    expect(looksLikeMarkdown('前言\n## 小节\n后续')).toBe(true);
    expect(looksLikeMarkdown('a # b')).toBe(false);
  });

  it('无序/有序列表（行首锚定）', () => {
    expect(looksLikeMarkdown('- foo\n- bar')).toBe(true);
    expect(looksLikeMarkdown('* foo')).toBe(true);
    expect(looksLikeMarkdown('1. 第一步\n2. 第二步')).toBe(true);
    expect(looksLikeMarkdown('a - b')).toBe(false); // 减号是行中字符
  });

  it('引用 / 代码围栏 / GFM 表格行', () => {
    expect(looksLikeMarkdown('> 引用一句')).toBe(true);
    expect(looksLikeMarkdown('```js\nconsole.log(1)\n```')).toBe(true);
    expect(looksLikeMarkdown('| a | b |\n| - | - |')).toBe(true);
  });

  it('行内强信号：code / 加粗 / 链接', () => {
    expect(looksLikeMarkdown('用 `grep` 搜')).toBe(true);
    expect(looksLikeMarkdown('这是 **重点** 内容')).toBe(true);
    expect(looksLikeMarkdown('见 [文档](https://example.com)')).toBe(true);
  });

  it('空串 → false', () => {
    expect(looksLikeMarkdown('')).toBe(false);
  });
});

describe('looksLikeMarkdown — 纯文本必不命中（防误判）', () => {
  it('日志/报错堆栈（多行但无 md 结构）', () => {
    const log = 'SIGSEGV at 0x41414141\n  rax=0x1 rbx=0x2\n段错误 (core dumped)';
    expect(looksLikeMarkdown(log)).toBe(false);
  });

  it('乘号/通配符的星号与落单 ** 不算加粗', () => {
    expect(looksLikeMarkdown('2 * 3 = 6')).toBe(false);
    expect(looksLikeMarkdown('ls *.txt')).toBe(false);
    expect(looksLikeMarkdown('这是 **落单强调符')).toBe(false);
  });

  it('路径/命令行/中文段落不命中', () => {
    expect(looksLikeMarkdown('cd /opt/app && ./run --flag')).toBe(false);
    expect(looksLikeMarkdown('今天分析了样本，结论如下：整体无异常，建议复测。')).toBe(false);
  });
});
