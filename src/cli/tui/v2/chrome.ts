/**
 * chrome — the TUI's ENTIRE visual system in one module (design-spec §3/§4).
 *
 * Everything pinned on screen is composed here as Span rows and handed to the
 * TerminalWriter, so the look stays consistent and there is exactly one place
 * to change it:
 *
 *   composeStatusBar   the full-width panel-bg status bar (1 row)
 *   composeInputBox    the boxed prompt (╭─╮│╰─╯), soft-wrap + windowing
 *   composeOverlay     boxed selection panels above the input (completion,
 *                      help, history search, rewind, queue)
 *   composeModalBox    the ONLY red box (越界确认, y/n)
 *   composeMenuRow     a full-width selectable row (gate cursor highlight)
 *
 * Width math is display-cell accurate (CJK = 2 cells) via ../ansi.ts. No I/O.
 */

import { graphemes, graphemeWidth, stringWidth } from '../ansi';
import type { Span } from './row-buffer';
import { truncateSegments } from './terminal-writer';
import type { Style } from './style';

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const BORDER: Style = { fg: 'faint' };
const PANEL: Style = { bg: 'panel' };

function spanWidth(spans: Span[]): number {
  let w = 0;
  for (const s of spans) w += stringWidth(s.text);
  return w;
}

/** Pad spans with spaces to exactly `width` cells (carries a style for bg fill). */
export function padToWidth(spans: Span[], width: number, padStyle?: Style): Span[] {
  const w = spanWidth(spans);
  if (w >= width) return spans;
  return [...spans, { text: ' '.repeat(width - w), style: padStyle }];
}

/** Take at most `width` cells of text (grapheme-safe). */
export function takeWidth(text: string, width: number): string {
  let out = '';
  let col = 0;
  for (const g of graphemes(text)) {
    const w = graphemeWidth(g);
    if (col + w > width) break;
    out += g;
    col += w;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Box drawing (╭─ title ─╮ / │ row │ / ╰───╯) — width = cols, CJK-accurate.
// ---------------------------------------------------------------------------

export function boxTop(cols: number, title?: string, style: Style = BORDER): Span[] {
  const inner = Math.max(0, cols - 2);
  if (!title) {
    return [{ text: '╭' + '─'.repeat(inner) + '╮', style }];
  }
  const t = ` ${title} `;
  const rest = Math.max(0, inner - stringWidth(t));
  return [
    { text: '╭─', style },
    { text: t, style: { fg: 'muted', bold: true } },
    { text: '─'.repeat(Math.max(0, rest - 1)) + '╮', style },
  ];
}

export function boxBottom(cols: number, style: Style = BORDER): Span[] {
  return [{ text: '╰' + '─'.repeat(Math.max(0, cols - 2)) + '╯', style }];
}

/** One boxed content row: `│ ` + spans (truncated/padded to inner width) + ` │`. */
export function boxLine(spans: Span[], cols: number, opts?: { bg?: boolean; style?: Style }): Span[] {
  const style = opts?.style ?? BORDER;
  const inner = Math.max(1, cols - 4);
  const body = padToWidth(truncateSegments(spans, inner), inner, opts?.bg ? PANEL : undefined);
  return [
    { text: '│ ', style },
    ...(opts?.bg ? body.map((s) => ({ ...s, style: { ...s.style, bg: 'panel' as const } })) : body),
    { text: ' │', style },
  ];
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

export interface StatusBarState {
  phase: 'idle' | 'running' | 'interrupted' | 'error';
  /** ms since the current turn started (drives the "· Ns" readout). */
  elapsedMs?: number;
  queueDepth: number;
  contextPct: number;
  model?: string;
  envName?: string;
  envKind?: string;
  backgroundSeg?: string;
  /** U8(1.1.10):累计 token(input/output)——room 丢弃顺序里排最低(最先丢)。 */
  tokens?: { input: number; output: number };
  /** Right-side contextual hint, pre-computed by the app (never truncated). */
  hint: string;
  reconnecting?: boolean;
}

/** U8:token 紧凑缩写(12300 → "12.3k",850 → "850")。 */
export function formatK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function composeStatusBar(s: StatusBarState, cols: number, spinnerFrame: number): Span[] {
  const left: Span[] = [];
  if (s.reconnecting) {
    left.push({ text: ' ⟳ 重连中…', style: { fg: 'amber' } });
  } else if (s.phase === 'running') {
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    const secs = Math.max(0, Math.floor((s.elapsedMs ?? 0) / 1000));
    left.push({ text: ` ${frame} `, style: { fg: 'cyan' } });
    left.push({ text: `思考中 · ${secs}s`, style: { fg: 'text' } });
  } else if (s.phase === 'interrupted') {
    left.push({ text: ' ⏸ 已中断', style: { fg: 'amber' } });
  } else if (s.phase === 'error') {
    left.push({ text: ' ✗ 错误', style: { fg: 'red' } });
  } else {
    left.push({ text: ' ○ 空闲', style: { fg: 'muted' } });
  }
  if (s.queueDepth > 0) left.push({ text: ` · 队列 ${s.queueDepth}`, style: { fg: 'amber' } });

  const right: Span[] = [{ text: `${s.hint} `, style: { fg: 'muted' } }];

  // Middle: env · model · ctx — dropped in that order when narrow.
  const leftW = spanWidth(left);
  const rightW = spanWidth(right);
  let room = cols - leftW - rightW - 2;
  const mid: Span[] = [];
  const envLabel = s.envName ? `${s.envName}${s.envKind ? ` · ${s.envKind}` : ''}` : '';
  if (envLabel && room > stringWidth(envLabel) + 2) {
    mid.push({ text: ` ${envLabel}`, style: { fg: 'cyan' } });
    room -= stringWidth(envLabel) + 1;
  }
  if (s.backgroundSeg && room > stringWidth(s.backgroundSeg) + 2) {
    mid.push({ text: ` · ${s.backgroundSeg}`, style: { fg: 'cyan' } });
    room -= stringWidth(s.backgroundSeg) + 2;
  }
  if (s.model && room > stringWidth(s.model) + 10) {
    mid.push({ text: ` · ${s.model}`, style: { fg: 'faint' } });
    room -= stringWidth(s.model) + 2;
  }
  if (s.contextPct > 0 && room > 9) {
    mid.push({ text: ` · ctx ${s.contextPct}%`, style: { fg: 'faint' } });
    room -= 9;
  }
  // U8:token 段排最低优先级——最后尝试,room 不够第一个被丢。
  if (s.tokens && s.tokens.input + s.tokens.output > 0 && room > 12) {
    mid.push({ text: ` · ⇅ ${formatK(s.tokens.input)}/${formatK(s.tokens.output)}`, style: { fg: 'faint' } });
  }

  const bar = [...left, ...mid];
  const gap = Math.max(1, cols - spanWidth(bar) - rightW);
  const full: Span[] = [...bar, { text: ' '.repeat(gap) }, ...right];
  // The bar reads as a surface: panel bg across the full width.
  return full.map((sp) => ({ ...sp, style: { ...sp.style, bg: 'panel' as const } }));
}

// ---------------------------------------------------------------------------
// Input box
// ---------------------------------------------------------------------------

export interface InputBox {
  rows: Span[][];
  /** Row index within `rows` where the cursor lives. */
  cursorRow: number;
  /** Display-cell column (0-based) of the cursor within that row. */
  cursorCol: number;
}

export interface InputBoxOptions {
  /** Lead spans on the first content row (the prompt anchor). */
  lead: Span[];
  cols: number;
  /** Editor buffer lines + cursor (grapheme col within cursorRow). */
  lines: string[];
  cursorLine: number;
  cursorCol: number;
  /** Max content rows before windowing kicks in (default 8). */
  maxContentRows?: number;
}

/**
 * Render the editor buffer as a boxed, soft-wrapped input area. Long lines
 * wrap (never truncated into invisibility — that was a live bug); when the
 * wrapped content exceeds maxContentRows, a window around the cursor is shown.
 */
export function composeInputBox(opts: InputBoxOptions): InputBox {
  const cols = Math.max(8, opts.cols);
  const inner = cols - 4; // "│ " + content + " │"
  const leadW = spanWidth(opts.lead);
  const maxRows = Math.max(1, opts.maxContentRows ?? 8);

  // 1. Wrap each logical line into visual rows. First visual row of line 0
  //    carries the lead; every other row is hanging-indented to the lead edge.
  interface VRow {
    spans: Span[];
    /** True when the cursor sits on this visual row. */
    hasCursor: boolean;
    cursorCell?: number; // cell offset within content (before box border)
  }
  const vrows: VRow[] = [];
  for (let li = 0; li < opts.lines.length; li++) {
    const line = opts.lines[li];
    const isCursorLine = li === opts.cursorLine;
    // Hanging indent: every visual row aligns under the prompt's text edge.
    const indent = leadW;
    const firstWidth = Math.max(1, inner - indent);
    const contWidth = Math.max(1, inner - indent);
    // Split the line into wrapped chunks (grapheme-accurate).
    const gs = graphemes(line);
    const chunks: string[] = [];
    let cur = '';
    let curW = 0;
    let limit = firstWidth;
    for (const g of gs) {
      const w = graphemeWidth(g);
      if (w > 0 && curW + w > limit && curW > 0) {
        chunks.push(cur);
        cur = '';
        curW = 0;
        limit = contWidth;
      }
      cur += g;
      curW += w;
    }
    chunks.push(cur); // last (possibly empty) chunk — cursor needs a home

    // Locate the cursor chunk (grapheme col → wrapped row + cell col).
    let consumed = 0; // graphemes consumed by previous chunks of this line
    let cursorHomed = false; // 光标在本逻辑行已落位——首个命中的 chunk 胜出
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunkGs = graphemes(chunks[ci]).length;
      const isFirst = li === 0 && ci === 0;
      const leadSpans: Span[] = isFirst
        ? opts.lead
        : [{ text: ' '.repeat(indent), style: undefined }];
      // 边界归属：光标恰好落在 chunk 末尾（折行点）时归后一个 chunk——画在下
      // 一视觉行首，而不是前一满 chunk 的尾巴上；末 chunk 兜底保留空行/空尾
      // chunk 的 home 语义（见上「cursor needs a home」）。
      const hasCursor =
        isCursorLine &&
        !cursorHomed &&
        (opts.cursorCol < consumed + chunkGs || ci === chunks.length - 1);
      if (hasCursor) cursorHomed = true;
      let cursorCell: number | undefined;
      if (hasCursor) {
        const inChunk = Math.max(0, Math.min(opts.cursorCol - consumed, chunkGs));
        const seg = graphemes(chunks[ci]).slice(0, inChunk).join('');
        cursorCell = indent + stringWidth(seg);
      }
      vrows.push({
        spans: [...leadSpans, { text: chunks[ci] }],
        hasCursor,
        cursorCell,
      });
      consumed += chunkGs;
    }
  }

  // 2. Window around the cursor row.
  const cursorV = Math.max(0, vrows.findIndex((r) => r.hasCursor));
  let start = 0;
  if (vrows.length > maxRows) {
    start = Math.min(Math.max(0, cursorV - Math.floor(maxRows / 2)), vrows.length - maxRows);
  }
  const windowRows = vrows.slice(start, start + maxRows);

  // 3. Compose the box.
  const rows: Span[][] = [boxTop(cols)];
  let cursorRow = 0;
  let cursorCol = 0;
  windowRows.forEach((vr, i) => {
    rows.push(boxLine(vr.spans, cols));
    if (vr.hasCursor) {
      cursorRow = i + 1;
      cursorCol = 2 + (vr.cursorCell ?? 0); // "│ " prefix = 2 cells
    }
  });
  rows.push(boxBottom(cols));
  return { rows, cursorRow, cursorCol };
}

// ---------------------------------------------------------------------------
// Overlay panels (completion / help / history / rewind / queue)
// ---------------------------------------------------------------------------

export interface OverlayItem {
  spans: Span[];
  /** Non-selectable rows (group headers) are skipped by the selection cursor. */
  selectable?: boolean;
}

/**
 * A boxed panel rendered ABOVE the input box (the input stays visible —
 * replacing it was a live bug that made typed text vanish). Keeps the
 * selected row inside a scroll window, with ↑/↓ overflow hints.
 */
export function composeOverlay(
  title: string,
  items: OverlayItem[],
  selected: number,
  cols: number,
  maxRows: number,
): Span[][] {
  const h = Math.max(3, maxRows);
  const rows: Span[][] = [boxTop(cols, title)];
  const total = items.length;
  const contentH = Math.max(1, h - 2);
  let start = 0;
  if (total > contentH) {
    start = Math.min(Math.max(0, selected - Math.floor(contentH / 2)), total - contentH);
  }
  for (let i = start; i < Math.min(start + contentH, total); i++) {
    const it = items[i];
    if (i === start && start > 0) {
      rows.push(boxLine([{ text: `↑ 还有 ${start} 项`, style: { fg: 'faint' } }], cols));
      continue;
    }
    if (i === start + contentH - 1 && start + contentH < total) {
      rows.push(boxLine([{ text: `↓ 还有 ${total - start - contentH + 1} 项`, style: { fg: 'faint' } }], cols));
      continue;
    }
    rows.push(boxLine(it.spans, cols, { bg: i === selected && it.selectable !== false }));
  }
  rows.push(boxBottom(cols));
  return rows;
}

/** Standard item row: marker + label + detail (used by every list overlay).
 *  Without a detail the label spans the full width (queue/history/rewind —
 *  the label IS the content there). */
export function overlayRow(label: string, detail: string, selected: boolean, cols: number): OverlayItem {
  const inner = cols - 4;
  const marker: Span = selected
    ? { text: '▶ ', style: { fg: 'amber', bold: true } }
    : { text: '  ', style: { fg: 'faint' } };
  if (!detail) {
    return {
      spans: [
        marker,
        { text: takeWidth(label, inner - 2), style: selected ? { fg: 'text', bold: true } : { fg: 'text' } },
      ],
      selectable: true,
    };
  }
  const labelW = 16;
  // 按显示格截断并补齐（CJK = 2 格）——padEnd 按码元补会把 CJK 行补短。
  const labelText = takeWidth(label, labelW);
  const spans: Span[] = [
    marker,
    { text: labelText + ' '.repeat(Math.max(0, labelW - stringWidth(labelText))), style: selected ? { fg: 'text', bold: true } : { fg: 'text' } },
    { text: takeWidth(detail, Math.max(0, inner - labelW - 2)), style: { fg: 'muted' } },
  ];
  return { spans, selectable: true };
}

export function overlayHeader(text: string): OverlayItem {
  return { spans: [{ text, style: { fg: 'cyan', bold: true } }], selectable: false };
}

// ---------------------------------------------------------------------------
// Modal (design §6.6 — the ONLY red box)
// ---------------------------------------------------------------------------

export interface ModalBoxView {
  title: string;
  objects: string[];
}

export function composeModalBox(view: ModalBoxView, cols: number): Span[][] {
  const red: Style = { fg: 'red', bold: true };
  const w = Math.min(cols, 72);
  const rows: Span[][] = [];
  rows.push(boxTop(w, undefined, red));
  const line = (spans: Span[]): Span[] => boxLine(spans, w, { style: red });
  rows.push(line([{ text: `⚠ 越界确认 · ${view.title}`, style: { fg: 'red', bold: true } }]));
  rows.push(line([]));
  for (const obj of view.objects.slice(0, 4)) {
    rows.push(line([{ text: `• ${obj}`, style: { fg: 'red' } }]));
  }
  rows.push(line([]));
  rows.push(line([{ text: '[y] 批准    [n] 拒绝', style: { fg: 'red', bold: true } }]));
  rows.push(boxBottom(w, red));
  return rows;
}

// ---------------------------------------------------------------------------
// Menu row (gate cursor highlight)
// ---------------------------------------------------------------------------

/** A full-width scrollback row; when selected it carries the panel surface. */
export function composeMenuRow(spans: Span[], selected: boolean, cols: number): Span[] {
  const body = padToWidth(truncateSegments(spans, cols), cols, selected ? PANEL : undefined);
  if (!selected) return body;
  return body.map((s) => ({ ...s, style: { ...s.style, bg: 'panel' as const } }));
}
