// Unit tests for the semantic style sheet (design-spec §4: 四色封顶, 降级链).
import { describe, expect, it } from 'vitest';

import { detectColorDepth, sgr, sgrReset, styleKey } from './style';

describe('detectColorDepth', () => {
  it('NO_COLOR wins over everything', () => {
    expect(
      detectColorDepth({
        NO_COLOR: '',
        COLORTERM: 'truecolor',
        TERM: 'xterm-256color',
      }),
    ).toBe('none');
  });

  it('COLORTERM truecolor/24bit → truecolor', () => {
    expect(detectColorDepth({ COLORTERM: 'truecolor' })).toBe('truecolor');
    expect(detectColorDepth({ COLORTERM: '24bit' })).toBe('truecolor');
  });

  it('Windows Terminal session → truecolor', () => {
    expect(detectColorDepth({ WT_SESSION: 'abc' })).toBe('truecolor');
  });

  it('TERM 256color → 256', () => {
    expect(detectColorDepth({ TERM: 'xterm-256color' })).toBe('256');
  });

  it('TERM dumb → none', () => {
    expect(detectColorDepth({ TERM: 'dumb' })).toBe('none');
  });

  it('bare TERM falls back to 16', () => {
    expect(detectColorDepth({ TERM: 'xterm' })).toBe('16');
    expect(detectColorDepth({})).toBe('16');
  });
});

describe('sgr', () => {
  it('truecolor emits 38;2;r;g;b', () => {
    expect(sgr({ fg: 'cyan' }, 'truecolor')).toBe('\x1b[38;2;86;200;216m');
  });

  it('256 emits 38;5;n', () => {
    expect(sgr({ fg: 'amber' }, '256')).toBe('\x1b[38;5;178m');
  });

  it('16 emits classic codes (amber degrades to yellow)', () => {
    expect(sgr({ fg: 'amber' }, '16')).toBe('\x1b[33m');
    expect(sgr({ fg: 'purple' }, '16')).toBe('\x1b[35m');
    expect(sgr({ fg: 'red' }, '16')).toBe('\x1b[31m');
    expect(sgr({ fg: 'green' }, '16')).toBe('\x1b[32m');
    expect(sgr({ fg: 'cyan' }, '16')).toBe('\x1b[36m');
  });

  it('grey ramp degrades to bright-black', () => {
    expect(sgr({ fg: 'muted' }, '16')).toBe('\x1b[90m');
    expect(sgr({ fg: 'faint' }, '16')).toBe('\x1b[90m');
  });

  it('combines bold/dim with color', () => {
    expect(sgr({ fg: 'red', bold: true }, '16')).toBe('\x1b[1;31m');
    expect(sgr({ fg: 'faint', dim: true }, '16')).toBe('\x1b[2;90m');
  });

  it('no color at depth none; attributes still apply', () => {
    expect(sgr({ fg: 'red' }, 'none')).toBe('');
    expect(sgr({ fg: 'red', bold: true }, 'none')).toBe('\x1b[1m');
  });

  it('empty style / text foreground → empty sequence', () => {
    expect(sgr(undefined, '16')).toBe('');
    expect(sgr({}, '16')).toBe('');
    expect(sgr({ fg: 'text' }, '16')).toBe('');
  });

  it('sgrReset is the full reset', () => {
    expect(sgrReset()).toBe('\x1b[0m');
  });
});

describe('styleKey', () => {
  it('is stable and distinguishes attributes', () => {
    expect(styleKey({ fg: 'red', bold: true })).toBe(
      styleKey({ fg: 'red', bold: true }),
    );
    expect(styleKey({ fg: 'red' })).not.toBe(
      styleKey({ fg: 'red', bold: true }),
    );
    expect(styleKey(undefined)).toBe('');
  });
});
