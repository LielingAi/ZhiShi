// renderError 的宽度数学（1.2.8 L4）：按显示格截断（CJK = 2 格），不切代理对。
import { describe, expect, it } from 'vitest';

import { stringWidth } from '../../ansi';
import { renderError } from './dividers';
import type { ErrorBlock } from '../types';

const block = (text: string): ErrorBlock => ({
  id: 'e1',
  kind: 'error',
  seq: 0,
  text,
});

describe('renderError', () => {
  it('CJK 文本按显示格截断，整行不超宽', () => {
    // 旧实现按码元 slice：60 码元的 CJK 截到 15 码元 = 30 格，远超 width。
    const rows = renderError(block('出错了'.repeat(20)), 20);
    const text = rows[0].map((s) => s.text).join('');
    expect(stringWidth(text)).toBeLessThanOrEqual(20);
    expect(text.endsWith('…')).toBe(true);
  });

  it('截断不切开代理对（emoji 按 grapheme 走）', () => {
    const rows = renderError(block('🙂'.repeat(30)), 11);
    const text = rows[0].map((s) => s.text).join('');
    expect(stringWidth(text)).toBeLessThanOrEqual(11);
    // 无孤立高/低代理项
    expect(text).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it('短文本原样保留', () => {
    const rows = renderError(block('boom'), 20);
    expect(rows[0][1].text).toBe('boom');
  });
});
