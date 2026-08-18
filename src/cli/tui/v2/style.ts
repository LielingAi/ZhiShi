/**
 * Semantic style sheet for the mini-renderer (design-spec §4).
 *
 * Content layers (rows, status, input) carry SEMANTIC color names only —
 * never hardcoded ANSI. The mapping to SGR bytes happens here, at render
 * time, with TrueColor → 256 → 16 degradation. No italics / no rounding /
 * no shadows: terminals are unreliable and the instrument look forbids it.
 *
 * Accent budget (四色封顶): cyan = 现场/连接, amber = 你/中断, purple = 工具,
 * red = 越界·错误 (scarce), green = 成果 (scarce). Everything else is grey.
 *
 * Backgrounds: `panel` is the ONE structural background (status bar, selected
 * rows, code blocks, overlay panels) — a dark slate that reads as "surface",
 * not as an accent. At 16/none depth it degrades to no-background (the fg
 * accents still carry the structure).
 */

export type SemanticColor =
  | 'cyan'
  | 'amber'
  | 'purple'
  | 'red'
  | 'green'
  /** Secondary text ( folded summaries, timestamps ). */
  | 'muted'
  /** Tertiary text ( dividers, hints ). */
  | 'faint'
  /** Default terminal foreground (body text). */
  | 'text';

export type SemanticBg = 'panel';

export interface Style {
  fg?: SemanticColor;
  bg?: SemanticBg;
  bold?: boolean;
  dim?: boolean;
}

export type ColorDepth = 'truecolor' | '256' | '16' | 'none';

// ---------------------------------------------------------------------------
// Palette — one entry per semantic color, per depth.
// ---------------------------------------------------------------------------

const TRUECOLOR: Record<
  Exclude<SemanticColor, 'text'>,
  [number, number, number]
> = {
  cyan: [86, 200, 216],
  amber: [224, 160, 48],
  purple: [176, 133, 245],
  red: [224, 82, 82],
  green: [76, 175, 109],
  muted: [158, 158, 158],
  faint: [97, 97, 97],
};

/** The single structural background: dark slate surface. */
const PANEL_BG_TRUECOLOR: [number, number, number] = [38, 42, 54];

const XTERM256: Record<Exclude<SemanticColor, 'text'>, number> = {
  cyan: 44, // #00d7d7
  amber: 178, // #d7af00
  purple: 141, // #af87ff
  red: 167, // #d75f5f
  green: 71, // #5faf5f
  muted: 245, // #8a8a8a
  faint: 240, // #585858
};

const PANEL_BG_256 = 236; // #303030

const ANSI16: Record<Exclude<SemanticColor, 'text'>, number> = {
  cyan: 36,
  amber: 33, // yellow is the 16-color stand-in for amber
  purple: 35,
  red: 31,
  green: 32,
  muted: 90,
  faint: 90,
};

// ---------------------------------------------------------------------------
// Environment detection (injectable)
// ---------------------------------------------------------------------------

export interface ColorEnv {
  [key: string]: string | undefined;
}

/**
 * Probe color capability from environment variables. Pass `process.env` in
 * production; tests inject a stub. NO_COLOR wins over everything.
 */
export function detectColorDepth(env: ColorEnv): ColorDepth {
  if (env.NO_COLOR !== undefined) return 'none';
  const colorTerm = env.COLORTERM?.toLowerCase();
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return 'truecolor';
  if (env.WT_SESSION) return 'truecolor'; // Windows Terminal
  const term = env.TERM?.toLowerCase() ?? '';
  if (term.includes('256color') || term.includes('direct')) return '256';
  if (term === 'dumb') return 'none';
  return '16';
}

// ---------------------------------------------------------------------------
// SGR generation
// ---------------------------------------------------------------------------

const SGR_RESET = '\x1b[0m';

export function sgrReset(): string {
  return SGR_RESET;
}

/**
 * Opening SGR sequence for a style at a given depth. Returns '' when the
 * style carries no attributes or the depth has no color — callers then know
 * no reset is needed after the text either.
 */
export function sgr(style: Style | undefined, depth: ColorDepth): string {
  if (!style) return '';
  const codes: string[] = [];
  if (style.bold) codes.push('1');
  if (style.dim) codes.push('2');
  const fg = style.fg;
  if (fg && fg !== 'text' && depth !== 'none') {
    if (depth === 'truecolor') {
      const [r, g, b] = TRUECOLOR[fg];
      codes.push(`38;2;${r};${g};${b}`);
    } else if (depth === '256') {
      codes.push(`38;5;${XTERM256[fg]}`);
    } else {
      codes.push(String(ANSI16[fg]));
    }
  }
  if (style.bg === 'panel') {
    if (depth === 'truecolor') {
      const [r, g, b] = PANEL_BG_TRUECOLOR;
      codes.push(`48;2;${r};${g};${b}`);
    } else if (depth === '256') {
      codes.push(`48;5;${PANEL_BG_256}`);
    }
    // 16/none: no background — structure degrades to fg accents only.
  }
  if (codes.length === 0) return '';
  return `\x1b[${codes.join(';')}m`;
}

/** Stable serialization for diffing — two segments with equal keys paint identically. */
export function styleKey(style: Style | undefined): string {
  if (!style) return '';
  return `${style.fg ?? ''}|${style.bg ?? ''}|${style.bold ? 'b' : ''}${style.dim ? 'd' : ''}`;
}
