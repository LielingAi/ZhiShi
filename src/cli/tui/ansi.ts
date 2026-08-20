/**
 * ANSI escape-sequence generators + display-width measurement (P1-T1).
 *
 * Pure functions only — no I/O, no state. Everything the TUI layer writes to
 * the terminal is built from these primitives so the geometry logic in
 * screen.ts stays testable against a virtual screen.
 *
 * Width rules (wcwidth-style, what Windows Terminal / ConPTY and mainstream
 * POSIX terminals actually do):
 *   - CJK wide / full-width code points render as TWO cells.
 *   - Combining marks, control chars, ZWJ and variation selectors are 0.
 *   - Everything else is 1.
 * Widths are measured per GRAPHEME cluster (Intl.Segmenter), because cursor
 * positioning is only correct when base+combining / emoji ZWJ sequences move
 * as one unit.
 */

// ---------------------------------------------------------------------------
// Cursor movement
// ---------------------------------------------------------------------------

/** Move cursor to an absolute position. Rows/cols are 1-based. */
export function cursorTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

export function cursorUp(n = 1): string {
  return `\x1b[${n}A`;
}

export function cursorDown(n = 1): string {
  return `\x1b[${n}B`;
}

export function cursorForward(n = 1): string {
  return `\x1b[${n}C`;
}

export function cursorBack(n = 1): string {
  return `\x1b[${n}D`;
}

/** DECSC / DECRC — save & restore cursor position. */
export function saveCursor(): string {
  return '\x1b7';
}

export function restoreCursor(): string {
  return '\x1b8';
}

// ---------------------------------------------------------------------------
// Erasing
// ---------------------------------------------------------------------------

export function clearScreen(): string {
  return '\x1b[2J';
}

export function clearLine(): string {
  return '\x1b[2K';
}

export function clearToEndOfLine(): string {
  return '\x1b[K';
}

// ---------------------------------------------------------------------------
// Scroll region (DECSTBM) — the mechanism that keeps output scrolling
// contained while status/input rows stay pinned.
// ---------------------------------------------------------------------------

/** Restrict scrolling to rows [top, bottom] (1-based, inclusive). */
export function setScrollRegion(top: number, bottom: number): string {
  return `\x1b[${top};${bottom}r`;
}

export function resetScrollRegion(): string {
  return '\x1b[r';
}

// ---------------------------------------------------------------------------
// Screen / cursor modes
// ---------------------------------------------------------------------------

export function enterAlternateScreen(): string {
  return '\x1b[?1049h';
}

export function exitAlternateScreen(): string {
  return '\x1b[?1049l';
}

export function hideCursor(): string {
  return '\x1b[?25l';
}

/** 滚轮上报（1.1.6 #3）：?1000h 按钮上报 + ?1006h SGR 扩展格式。
 *  键位层只放行 wheel 码（64/65），点击/拖拽仍被吞掉。
 *  取舍：?1000h 会接管按下事件，终端原生拖选需按住 Shift（主流终端均支持）。 */
export function enableMouseWheel(): string {
  return '\x1b[?1000h\x1b[?1006h';
}

export function disableMouseWheel(): string {
  return '\x1b[?1006l\x1b[?1000l';
}

export function showCursor(): string {
  return '\x1b[?25h';
}

// ---------------------------------------------------------------------------
// Display width
// ---------------------------------------------------------------------------

/**
 * East-Asian Wide/Full-width ranges (the terminal renders these as 2 cells).
 * Condensed from the standard wcwidth table; covers CJK ideographs, kana,
 * hangul, full-width forms and the emoji planes in common use.
 */
const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK Radicals .. CJK Symbols (approx)
  [0x3041, 0x33ff], // Hiragana .. CJK Compatibility
  [0x3400, 0x4dbf], // CJK Ext A
  [0x4e00, 0x9fff], // CJK Unified
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe52], // CJK Compatibility Forms
  [0xfe54, 0xfe66], // Small Form Variants
  [0xfe68, 0xfe6b], // Small Form Variants
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f000, 0x1faff], // Emoji & pictographs (broad: Mahjong .. Symbols Suppl.)
  [0x20000, 0x2fffd], // CJK Ext B..
  [0x30000, 0x3fffd], // CJK Ext G..
];

/** Marks / format chars that add no cells of their own. */
const ZERO_WIDTH_RE = /[\p{Mn}\p{Me}\p{Cf}]/u;

const VARIATION_SELECTOR_16 = 0xfe0f;
const ZERO_WIDTH_JOINER = 0x200d;

/**
 * Width of a single code point in terminal cells: 0, 1 or 2.
 * Note: width of *text* must go through graphemes()/graphemeWidth() — a bare
 * combining mark is 0 here but its cluster carries the base char's width.
 */
export function charWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 0; // C0/C1 controls
  const ch = String.fromCodePoint(cp);
  if (ZERO_WIDTH_RE.test(ch)) return 0;
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return 2;
  }
  return 1;
}

/** Split text into grapheme clusters (user-perceived characters). */
export function graphemes(text: string): string[] {
  if (text === '') return [];
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(seg.segment(text), (s) => s.segment);
}

/**
 * Width of one grapheme cluster in cells.
 * A cluster is wide if it contains any wide code point, an emoji variation
 * selector (✈ + U+FE0F renders wide), or a ZWJ joining emoji.
 */
export function graphemeWidth(cluster: string): number {
  let sawWide = false;
  let baseWidth = 0;
  for (const ch of cluster) {
    const cp = ch.codePointAt(0)!;
    if (cp === VARIATION_SELECTOR_16 || cp === ZERO_WIDTH_JOINER) {
      sawWide = sawWide || cp === VARIATION_SELECTOR_16;
      continue;
    }
    const w = charWidth(cp);
    if (w === 2) sawWide = true;
    else if (w === 1 && baseWidth === 0) baseWidth = 1;
  }
  if (sawWide) return 2;
  return baseWidth;
}

/** Total display width of a string, in terminal cells. */
export function stringWidth(text: string): number {
  let w = 0;
  for (const g of graphemes(text)) w += graphemeWidth(g);
  return w;
}
