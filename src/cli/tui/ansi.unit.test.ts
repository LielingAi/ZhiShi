// Unit tests for the ANSI sequence + display-width primitives (P1-T1).
// Pure functions — no I/O, safe for the parallel unit pool.
import { describe, expect, it } from 'vitest';

import {
  charWidth,
  clearLine,
  clearScreen,
  clearToEndOfLine,
  cursorBack,
  cursorDown,
  cursorForward,
  cursorTo,
  cursorUp,
  enterAlternateScreen,
  exitAlternateScreen,
  graphemes,
  graphemeWidth,
  hideCursor,
  resetScrollRegion,
  restoreCursor,
  saveCursor,
  setScrollRegion,
  showCursor,
  stringWidth,
} from './ansi';

describe('cursor / erase / region sequences', () => {
  it('addresses the cursor 1-based (row;col)', () => {
    expect(cursorTo(1, 1)).toBe('\x1b[1;1H');
    expect(cursorTo(24, 80)).toBe('\x1b[24;80H');
  });

  it('generates relative cursor moves', () => {
    expect(cursorUp(3)).toBe('\x1b[3A');
    expect(cursorDown(2)).toBe('\x1b[2B');
    expect(cursorForward(5)).toBe('\x1b[5C');
    expect(cursorBack(1)).toBe('\x1b[1D');
  });

  it('generates erase sequences', () => {
    expect(clearScreen()).toBe('\x1b[2J');
    expect(clearLine()).toBe('\x1b[2K');
    expect(clearToEndOfLine()).toBe('\x1b[K');
  });

  it('generates DECSTBM scroll-region sequences (1-based, inclusive)', () => {
    expect(setScrollRegion(1, 22)).toBe('\x1b[1;22r');
    expect(resetScrollRegion()).toBe('\x1b[r');
  });

  it('generates alternate-screen + cursor-visibility sequences', () => {
    expect(enterAlternateScreen()).toBe('\x1b[?1049h');
    expect(exitAlternateScreen()).toBe('\x1b[?1049l');
    expect(hideCursor()).toBe('\x1b[?25l');
    expect(showCursor()).toBe('\x1b[?25h');
  });

  it('generates DEC save/restore cursor', () => {
    expect(saveCursor()).toBe('\x1b7');
    expect(restoreCursor()).toBe('\x1b8');
  });
});

describe('charWidth', () => {
  it('treats ASCII printable as 1', () => {
    expect(charWidth('a'.codePointAt(0)!)).toBe(1);
    expect(charWidth('~'.codePointAt(0)!)).toBe(1);
  });

  it('treats CJK ideographs and full-width punctuation as 2', () => {
    expect(charWidth('你'.codePointAt(0)!)).toBe(2);
    expect(charWidth('。'.codePointAt(0)!)).toBe(2);
    expect(charWidth('，'.codePointAt(0)!)).toBe(2);
    expect(charWidth('Ａ'.codePointAt(0)!)).toBe(2); // fullwidth latin A
    expect(charWidth('あ'.codePointAt(0)!)).toBe(2); // hiragana
    expect(charWidth('가'.codePointAt(0)!)).toBe(2); // hangul syllable
  });

  it('treats combining marks as 0', () => {
    expect(charWidth(0x0301)).toBe(0); // COMBINING ACUTE ACCENT
    expect(charWidth(0x20d0)).toBe(0); // COMBINING LEFT HARPOON
  });

  it('treats control characters as 0', () => {
    expect(charWidth(0x07)).toBe(0);
    expect(charWidth(0x1b)).toBe(0);
    expect(charWidth(0x7f)).toBe(0);
  });

  it('treats most emoji as 2', () => {
    expect(charWidth(0x1f600)).toBe(2); // 😀
    expect(charWidth(0x1f44d)).toBe(2); // 👍
  });
});

describe('graphemes', () => {
  it('splits plain text into code points', () => {
    expect(graphemes('abc')).toEqual(['a', 'b', 'c']);
  });

  it('keeps base + combining mark as one grapheme', () => {
    expect(graphemes('éb')).toEqual(['é', 'b']);
  });

  it('keeps ZWJ emoji sequences as one grapheme', () => {
    const family = '👨‍👩‍👧';
    expect(graphemes(family)).toEqual([family]);
  });

  it('keeps regional-indicator flags as one grapheme', () => {
    const flag = '🇨🇳';
    expect(graphemes(flag)).toEqual([flag]);
  });
});

describe('graphemeWidth / stringWidth', () => {
  it('measures plain ASCII', () => {
    expect(stringWidth('hello')).toBe(5);
    expect(stringWidth('')).toBe(0);
  });

  it('measures CJK as double width', () => {
    expect(stringWidth('你好')).toBe(4);
    expect(stringWidth('a你b')).toBe(4);
  });

  it('measures base+combining as the base width', () => {
    expect(stringWidth('é')).toBe(1);
    expect(stringWidth('éx')).toBe(2);
  });

  it('measures emoji graphemes as 2 (incl. ZWJ sequences and VS16 forms)', () => {
    expect(graphemeWidth('👍')).toBe(2);
    expect(graphemeWidth('👨‍👩‍👧')).toBe(2);
    expect(graphemeWidth('✈️')).toBe(2); // U+2708 U+FE0F
    expect(stringWidth('a👍b')).toBe(4);
  });

  it('measures skin-tone-modified emoji as 2', () => {
    expect(graphemeWidth('👍🏽')).toBe(2);
  });

  it('graphemeWidth matches a sum over graphemes of stringWidth', () => {
    const s = 'ab你é👨‍👩‍👧🇨🇳';
    expect(graphemes(s).reduce((w, g) => w + graphemeWidth(g), 0)).toBe(stringWidth(s));
  });
});
