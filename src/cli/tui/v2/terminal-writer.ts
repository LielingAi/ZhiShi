/**
 * Terminal writer (design-spec §9: 脏行 diff 写屏; §3: chrome 两行).
 *
 * Composes the other mini-renderer pieces into a full-screen renderer on
 * the alternate screen:
 *
 *   ┌ output region   rows 1 .. outputBottom   ← RowBuffer, windowed by Viewport
 *   ├ status row(s)   pinned                   ← setStatus()
 *   └ input row(s)    pinned, bottom           ← setInput(), cursor lives here
 *                                                  (multi-line: 1..inputHeight)
 *
 * Rendering model:
 *   - Logical rows (spans with SEMANTIC styles) are wrapped to the current
 *     width into visual lines (grapheme-aware, width math from ../ansi.ts).
 *   - Each frame, the Viewport's visible window is sliced out and DIFFED
 *     against the previous frame; only changed rows are written, by absolute
 *     cursor positioning + clear-line. No scrolling is ever used, so the
 *     pinned chrome rows are untouchable by construction.
 *   - Style names map to SGR bytes here and only here, at the probed
 *     ColorDepth (../ansi.ts primitives for cursor/erase, ./style.ts for SGR).
 *   - While scrolled up, a "↓ N 条新消息" indicator is composited onto the
 *     bottom-right of the output region (design §6.3).
 *   - Mutations schedule a coalesced frame (FrameScheduler); flush() paints
 *     immediately. resize() re-wraps everything and repaints in full.
 *
 * The write target is injected (`out`), so tests assert final on-screen
 * state through a virtual terminal. Pure ANSI — no Node/POSIX-only APIs.
 */

import {
  clearLine,
  clearScreen,
  cursorTo,
  disableMouseWheel,
  enableMouseWheel,
  enterAlternateScreen,
  exitAlternateScreen,
  graphemes,
  graphemeWidth,
  hideCursor,
  showCursor,
} from '../ansi';
import { FrameScheduler, type TimerApi } from './frame-scheduler';
import { RowBuffer, type Row, type Span } from './row-buffer';
import {
  detectColorDepth,
  sgr,
  sgrReset,
  styleKey,
  type ColorDepth,
  type Style,
} from './style';
import { Viewport } from './viewport';

export type { Row, Span };

/** Minimal injected write target — compatible with NodeJS.WritableStream. */
export interface ScreenSink {
  write(text: string): unknown;
}

/** One wrapped visual line: styled segments summing to ≤ `cols` cells. */
export interface Segment {
  text: string;
  style?: Style;
}

export interface TerminalWriterOptions {
  out: ScreenSink;
  cols: number;
  rows: number;
  /** Color capability; defaults to detectColorDepth(process.env). */
  depth?: ColorDepth;
  /** Pinned status rows above the input row (default 1). */
  statusHeight?: number;
  /** Pinned input rows at the bottom (default 1; multi-line editor raises it). */
  inputHeight?: number;
  buffer?: RowBuffer;
  /** Inject to control frame timing; a default 16ms scheduler is created. */
  scheduler?: FrameScheduler;
  /** Passthrough for the internally created scheduler (tests). */
  frameMs?: number;
  timer?: TimerApi;
}

/**
 * Runtime chrome override (W3 §0.1②). Changing statusHeight/inputHeight
 * reorganises the three regions and triggers a full reflow.
 */
export interface ChromeOverride {
  statusHeight?: number;
  inputHeight?: number;
}

/** 1-based row geometry of the three regions. */
export interface WriterLayout {
  cols: number;
  rows: number;
  outputTop: number; // always 1
  outputBottom: number; // inclusive
  statusTop: number;
  statusHeight: number;
  inputTop: number; // first input row (multi-line editor)
  inputHeight: number;
  inputRow: number; // last input row (cursor lives here)
}

export class TerminalWriter {
  private readonly out: ScreenSink;
  private readonly buffer: RowBuffer;
  private readonly scheduler: FrameScheduler;
  private readonly ownsScheduler: boolean;
  private depth: ColorDepth;
  private cols: number;
  private rows: number;
  private statusHeight: number;
  private inputHeight: number;
  private readonly viewport: Viewport;

  /** Wrap cache per row id, valid for the current width. */
  private wrapCache = new Map<string, Segment[][]>();
  /** Previous frame's painted output rows (diff baseline), keyed for equality. */
  private prevFrameKeys: string[] | null = null;
  private prevStatusKeys: string[] | null = null;
  private prevInputKeys: string[] | null = null;
  private prevCursorRow = -1;
  private prevCursorCol = -1;
  private statusLines: Span[][] = [];
  private inputLines: Span[][] = [[]]; // 1..inputHeight logical rows
  private inputCursorRow = 0; // 0-based within inputLines
  private inputCursorCol = 0;
  private entered = false;

  constructor(opts: TerminalWriterOptions) {
    this.out = opts.out;
    this.cols = Math.max(2, opts.cols);
    this.rows = Math.max(3, opts.rows);
    this.statusHeight = Math.min(
      Math.max(1, opts.statusHeight ?? 1),
      this.rows - 2,
    );
    this.inputHeight = Math.min(
      Math.max(1, opts.inputHeight ?? 1),
      this.rows - this.statusHeight - 1,
    );
    this.depth = opts.depth ?? detectColorDepth(process.env);
    this.buffer = opts.buffer ?? new RowBuffer();
    this.viewport = new Viewport({
      width: this.cols,
      height: this.layout().outputBottom,
    });
    if (opts.scheduler) {
      this.scheduler = opts.scheduler;
      this.ownsScheduler = false;
    } else {
      this.scheduler = new FrameScheduler(() => this.renderFrame(), {
        frameMs: opts.frameMs,
        timer: opts.timer,
      });
      this.ownsScheduler = true;
    }
    this.buffer.subscribe((event) => {
      if (event.type === 'evict')
        for (const row of event.rows) this.wrapCache.delete(row.id);
      if (event.type === 'remove') this.wrapCache.delete(event.row.id);
      if (event.type === 'clear') this.wrapCache.clear();
    });
  }

  layout(): WriterLayout {
    const statusH = this.statusHeight;
    const inputH = this.inputHeight;
    const inputTop = this.rows - inputH + 1;
    return {
      cols: this.cols,
      rows: this.rows,
      outputTop: 1,
      outputBottom: inputTop - statusH - 1,
      statusTop: inputTop - statusH,
      statusHeight: statusH,
      inputTop,
      inputHeight: inputH,
      inputRow: this.rows,
    };
  }

  /**
   * Runtime chrome override (W3 §0.1②). Adjusting statusHeight/inputHeight
   * re-partitions the screen and forces a full reflow on the next frame.
   */
  setChrome(override: ChromeOverride): void {
    let changed = false;
    if (override.statusHeight !== undefined) {
      const v = Math.min(Math.max(1, override.statusHeight), this.rows - 2);
      if (v !== this.statusHeight) {
        this.statusHeight = v;
        changed = true;
      }
    }
    if (override.inputHeight !== undefined) {
      const maxH = this.rows - this.statusHeight - 1;
      const v = Math.min(Math.max(1, override.inputHeight), maxH);
      if (v !== this.inputHeight) {
        this.inputHeight = v;
        if (this.inputCursorRow >= v) this.inputCursorRow = v - 1;
        changed = true;
      }
    }
    if (!changed) return;
    this.viewport.resize({ width: this.cols, height: this.layout().outputBottom });
    this.invalidateFrame();
    this.scheduler.flush();
  }

  /** Force the next frame to repaint every region (used after setChrome/resize). */
  private invalidateFrame(): void {
    this.prevFrameKeys = null;
    this.prevStatusKeys = null;
    this.prevInputKeys = null;
    this.prevCursorCol = -1;
    this.prevCursorRow = -1;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** 鼠标捕获策略（1.1.6 #3 修订）：只开滚轮上报（?1000h+?1006h），键位层
   *  只放行 wheel 码 64/65——点击/拖拽序列仍被吞掉（旧实现把点击误判成
   *  Esc：运行中点输入框 = 中断，这个保护保留）。
   *  已知取舍：?1000h 接管按下事件后，终端原生拖选需按住 Shift；
   *  2026-08-17 曾为此整体移除捕获，本次按产品决策受控恢复滚轮。 */

  /** Enter the alternate screen and paint the first frame. */
  enter(): void {
    this.entered = true;
    this.out.write(enterAlternateScreen() + enableMouseWheel() + clearScreen());
    this.renderFrame();
  }

  /** Restore the primary screen. The scheduler STAYS alive — /attach uses
   *  exit()→enter() to hand the TTY to a child shell and back; disposing here
   *  permanently killed the frame pump (input looked dead after resume). */
  exit(): void {
    this.out.write(disableMouseWheel() + showCursor() + exitAlternateScreen());
    this.entered = false;
  }

  /** Final teardown (process exit) — disposes the frame scheduler. */
  dispose(): void {
    if (this.ownsScheduler) this.scheduler.dispose();
  }

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

  /** Append a logical row; pass `id` for optimistic insertion (see RowBuffer). */
  append(spans: Span[], opts?: { id?: string }): Row {
    const row = this.buffer.append(spans, opts);
    this.viewport.appendRows(this.wrapRow(row).length);
    this.scheduler.request();
    return row;
  }

  /** Patch an optimistic row (Esc divider, streaming card…). */
  updateRow(id: string, spans: Span[]): boolean {
    if (!this.buffer.update(id, spans)) return false;
    this.wrapCache.delete(id);
    this.scheduler.request();
    return true;
  }

  /**
   * Scroll the output region. Positive = up/older, negative = down/newer.
   * Scrolling up pauses tail-following; reaching the bottom resumes it.
   */
  scrollBy(delta: number): void {
    const before = this.viewport.state().scrollOffset;
    this.viewport.scrollBy(delta);
    if (this.viewport.state().scrollOffset !== before) this.scheduler.request();
  }

  scrollToTail(): void {
    this.viewport.scrollToTail();
    this.scheduler.request();
  }

  scrollToTop(): void {
    this.viewport.scrollToTop();
    this.scheduler.request();
  }

  viewportState() {
    return this.viewport.state();
  }

  /**
   * Full reset of the output region: drop all rows, reset the viewport and
   * repaint from scratch. Used by the app on /reset and on cold replays.
   */
  clear(): void {
    this.buffer.clear();
    this.viewport.reset();
    this.invalidateFrame();
    this.scheduler.flush();
  }

  /** Set the pinned status row(s) (1..statusHeight lines of spans). */
  setStatus(lines: Span[][]): void {
    this.statusLines = lines.slice(0, this.statusHeight);
    this.scheduler.request();
  }

  /**
   * Set the pinned input area. `lines` is 1..inputHeight logical rows (the
   * editor passes the wrapped/truncated visual lines). `cursorRow`/`cursorCol`
   * are 0-based display coordinates within the input area — compute them with
   * stringWidth over the spans left of / above the caret.
   */
  setInput(lines: Span[][], cursorRow = 0, cursorCol = 0): void {
    this.inputLines = lines.slice(0, this.inputHeight);
    while (this.inputLines.length < 1) this.inputLines.push([]);
    this.inputCursorRow = Math.max(0, Math.min(cursorRow, this.inputLines.length - 1));
    this.inputCursorCol = Math.max(0, cursorCol);
    this.scheduler.request();
  }

  /** Full reflow at a new size: re-wrap all rows, repaint everything. */
  resize(cols: number, rows: number): void {
    this.cols = Math.max(2, cols);
    this.rows = Math.max(3, rows);
    this.wrapCache.clear();
    this.viewport.resize({
      width: this.cols,
      height: this.layout().outputBottom,
    });
    // Screen is cleared below: invalidate every diff baseline.
    this.invalidateFrame();
    this.out.write(clearScreen());
    this.renderFrame();
  }

  /** Paint a frame immediately (Esc optimistic path). */
  flush(): void {
    this.scheduler.flush();
  }

  // -------------------------------------------------------------------------
  // Frame rendering
  // -------------------------------------------------------------------------

  /** Render one frame: diff the visible window + chrome against last paint. */
  renderFrame(): void {
    if (!this.entered) return;
    const l = this.layout();
    const outputHeight = l.outputBottom;

    // 1. Flatten logical rows → visual lines (cached per row) and re-sync.
    const flat: Segment[][] = [];
    for (const row of this.buffer.rows()) {
      for (const line of this.wrapRow(row)) flat.push(line);
    }
    this.viewport.syncTotal(flat.length);

    // 2. Slice the visible window, pad to full height, composite indicator.
    const { start, end } = this.viewport.window();
    const visible: Segment[][] = [];
    for (let i = 0; i < outputHeight; i++) {
      visible.push(start + i < end ? flat[start + i] : []);
    }
    const pending = this.viewport.pendingCount();
    if (pending > 0 && outputHeight > 0) {
      const badge: Segment[] = [
        { text: ` ↓ ${pending} 条新消息 `, style: { fg: 'amber' } },
      ];
      visible[outputHeight - 1] = overlayRight(
        visible[outputHeight - 1],
        badge,
        this.cols,
      );
    }

    // 3. Diff & write changed output rows only.
    const keys = visible.map(lineKey);
    let out = hideCursor();
    const prev = this.prevFrameKeys;
    for (let i = 0; i < outputHeight; i++) {
      if (prev && prev[i] === keys[i]) continue;
      out +=
        cursorTo(l.outputTop + i, 1) +
        clearLine() +
        this.renderSegments(visible[i]);
    }
    this.prevFrameKeys = keys;

    // 4. Status rows (diffed separately).
    const prevStatus = this.prevStatusKeys;
    const statusKeys: string[] = [];
    for (let i = 0; i < this.statusHeight; i++) {
      const line = truncateSegments(this.statusLines[i] ?? [], this.cols);
      statusKeys.push(lineKey(line));
      if (prevStatus && prevStatus[i] === statusKeys[i]) continue;
      out +=
        cursorTo(l.statusTop + i, 1) + clearLine() + this.renderSegments(line);
    }
    this.prevStatusKeys = statusKeys;

    // 5. Input area (1..inputHeight rows) + cursor.
    const prevInput = this.prevInputKeys;
    const inputKeys: string[] = [];
    for (let i = 0; i < this.inputHeight; i++) {
      const line = truncateSegments(this.inputLines[i] ?? [], this.cols);
      inputKeys.push(lineKey(line));
      if (prevInput && prevInput[i] === inputKeys[i]) continue;
      out +=
        cursorTo(l.inputTop + i, 1) + clearLine() + this.renderSegments(line);
    }
    this.prevInputKeys = inputKeys;
    const cursorCol = Math.min(this.inputCursorCol, this.cols - 1);
    const cursorRow = Math.min(this.inputCursorRow, this.inputHeight - 1);
    if (
      cursorRow !== this.prevCursorRow ||
      cursorCol !== this.prevCursorCol
    ) {
      out += cursorTo(l.inputTop + cursorRow, cursorCol + 1);
      this.prevCursorRow = cursorRow;
      this.prevCursorCol = cursorCol;
    }
    out += showCursor();

    if (out !== hideCursor() + showCursor()) this.out.write(out);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private wrapRow(row: Row): Segment[][] {
    let lines = this.wrapCache.get(row.id);
    if (!lines) {
      lines = wrapSpans(row.spans, this.cols);
      this.wrapCache.set(row.id, lines);
    }
    return lines;
  }

  /** Emit segments with minimal SGR churn; style mapping happens here only. */
  private renderSegments(segs: Segment[]): string {
    let out = '';
    let open = '';
    for (const seg of segs) {
      const next = sgr(seg.style, this.depth);
      if (next !== open) {
        out += sgrReset() + next;
        open = next;
      }
      out += seg.text;
    }
    if (open !== '') out += sgrReset();
    return out;
  }
}

// ---------------------------------------------------------------------------
// Wrapping & truncation (width math from ../ansi.ts — the shared contract)
// ---------------------------------------------------------------------------

/** Diff key for a visual line: identical keys paint identically. */
function lineKey(segs: Segment[]): string {
  return segs.map((s) => `${styleKey(s.style)}${s.text}`).join('');
}

function segmentsWidth(segs: Segment[]): number {
  let w = 0;
  for (const seg of segs)
    for (const g of graphemes(seg.text)) w += graphemeWidth(g);
  return w;
}

function sameStyle(a: Style | undefined, b: Style | undefined): boolean {
  return styleKey(a) === styleKey(b);
}

/**
 * Wrap logical-row spans into visual lines of at most `width` cells.
 * Grapheme-aware (CJK = 2 cells, emoji ZWJ clusters move as one unit).
 * C0 controls are dropped; `\n` forces a line break.
 */
export function wrapSpans(spans: Span[], width: number): Segment[][] {
  const lines: Segment[][] = [[]];
  let cur = lines[0];
  let col = 0;
  const push = (text: string, style: Style | undefined): void => {
    const last = cur[cur.length - 1];
    if (last && sameStyle(last.style, style)) last.text += text;
    else cur.push({ text, style });
  };
  for (const span of spans) {
    for (const g of graphemes(span.text)) {
      if (g === '\n') {
        cur = [];
        lines.push(cur);
        col = 0;
        continue;
      }
      const cp = g.codePointAt(0)!;
      if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue; // drop C0/C1
      const w = graphemeWidth(g);
      if (w > 0 && col + w > width && col > 0) {
        cur = [];
        lines.push(cur);
        col = 0;
      }
      push(g, span.style);
      col += w;
    }
  }
  return lines;
}

/** Truncate spans to a single visual line of at most `width` cells. */
export function truncateSegments(spans: Span[], width: number): Segment[] {
  const out: Segment[] = [];
  let col = 0;
  const push = (text: string, style: Style | undefined): void => {
    const last = out[out.length - 1];
    if (last && sameStyle(last.style, style)) last.text += text;
    else out.push({ text, style });
  };
  for (const span of spans) {
    for (const g of graphemes(span.text)) {
      if (g === '\n') return out;
      const cp = g.codePointAt(0)!;
      if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue;
      const w = graphemeWidth(g);
      if (w > 0 && col + w > width) return out;
      push(g, span.style);
      col += w;
    }
  }
  return out;
}

/**
 * Right-align `overlay` on top of `line` within `width` cells (the
 * "↓ N 条新消息" badge). The base line is truncated to make room.
 */
export function overlayRight(
  line: Segment[],
  overlay: Segment[],
  width: number,
): Segment[] {
  const ow = segmentsWidth(overlay);
  if (ow >= width) return truncateSegments(overlay, width);
  const room = width - ow;
  const head = truncateSegments(line, room);
  const headW = segmentsWidth(head);
  const pad = room - headW;
  const out = [...head];
  if (pad > 0) out.push({ text: ' '.repeat(pad) });
  out.push(...overlay);
  return out;
}
