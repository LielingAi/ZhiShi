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
  private wrapCache = new Map<string, WrapEntry>();
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
    // P4（1.1.9）：输出区锚定顶行（outputTop 恒为 1），chrome 高度变化只在
    // 尾部增删行——prevFrameKeys 按区域内偏移索引，绝对行号不变，基线仍然有
    // 效（变短的区域多出的旧 key 不再被比较，变长的区域 prev[i] 为 undefined
    // 必然重画）；窗口平移/裁剪造成的内容变化由 key diff 自然覆盖。只有
    // status/input 的位置变了，它们的基线作废。flush 降级为 request：与紧随
    // 的 setInput 等变更合进同一帧（16ms），不再每次高度变化同步全屏刷。
    this.prevStatusKeys = null;
    this.prevInputKeys = null;
    this.prevCursorRow = -1;
    this.prevCursorCol = -1;
    this.scheduler.request();
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
    const prevSpans = this.buffer.get(id)?.spans;
    const entry = this.wrapCache.get(id);
    if (!this.buffer.update(id, spans)) return false;
    // P1: 流式「单点追加」走尾部增量重折（保留稳定行，只重折插入点所在行起
    // 的尾段）；任何疑义回退全量——删缓存，下一帧 wrapRow 懒重折全文。
    const next =
      entry && prevSpans
        ? rewrapAppended(prevSpans, spans, entry, this.cols)
        : null;
    if (next) this.wrapCache.set(id, next);
    else this.wrapCache.delete(id);
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

  /** 整页翻页(1.1.9 U6):正=向上翻一页,负=向下;页高=输出区可视行数。 */
  scrollPages(pages: number): void {
    const before = this.viewport.state().scrollOffset;
    this.viewport.scrollPages(pages);
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
    let entry = this.wrapCache.get(row.id);
    if (!entry) {
      entry = wrapSpansTracked(row.spans, this.cols);
      this.wrapCache.set(row.id, entry);
    }
    return entry.lines;
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

function spanEquals(a: Span, b: Span): boolean {
  return a.text === b.text && sameStyle(a.style, b.style);
}

/** A visual line's source position: index into spans + code-unit offset within
 *  that span's text (always a grapheme-cluster boundary, by construction). */
interface LineStart {
  span: number;
  offset: number;
}

/** Wrap cache entry: visual lines + each line's source start (for P1). */
export interface WrapEntry {
  lines: Segment[][];
  starts: LineStart[];
}

/**
 * next 中包含 offset 的 grapheme 簇的起点（offset 本身是簇边界则返回它）。
 * chunk 可能把簇切成两半（👩‍💻 的 💻 第二次才到）——追加会让新文本把插入点
 * 之前的若干码元并进一个更大的簇，此时必须从该簇的起点开始重折，否则稳定
 * 前缀里会留下半个簇（seed-20 实测：prev 末 grapheme 是孤立高代理项，next
 * 里它与前面的 👩+ZWJ 并成一簇）。
 */
function clusterFloor(text: string, index: number): number {
  let start = 0;
  for (const g of graphemes(text)) {
    const end = start + g.length;
    if (end >= index) return end === index ? index : start;
    start = end;
  }
  return index; // index >= text.length：视为边界
}

/**
 * Wrap logical-row spans into visual lines of at most `width` cells.
 * Grapheme-aware (CJK = 2 cells, emoji ZWJ clusters move as one unit).
 * C0 controls are dropped; `\n` forces a line break.
 */
export function wrapSpans(spans: Span[], width: number): Segment[][] {
  return wrapSpansCore(spans, width, null);
}

/** wrapSpans + 每条 visual line 的源起点（增量重折的定位锚）。 */
export function wrapSpansTracked(spans: Span[], width: number): WrapEntry {
  const starts: LineStart[] = [];
  const lines = wrapSpansCore(spans, width, starts);
  return { lines, starts };
}

function wrapSpansCore(
  spans: Span[],
  width: number,
  starts: LineStart[] | null,
): Segment[][] {
  const lines: Segment[][] = [[]];
  starts?.push({ span: 0, offset: 0 });
  let cur = lines[0];
  let col = 0;
  const push = (text: string, style: Style | undefined): void => {
    const last = cur[cur.length - 1];
    if (last && sameStyle(last.style, style)) last.text += text;
    else cur.push({ text, style });
  };
  for (let si = 0; si < spans.length; si++) {
    const span = spans[si];
    let offset = 0; // code-unit offset of the current grapheme's END
    for (const g of graphemes(span.text)) {
      offset += g.length;
      if (g === '\n') {
        cur = [];
        lines.push(cur);
        col = 0;
        starts?.push({ span: si, offset });
        continue;
      }
      const cp = g.codePointAt(0)!;
      if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue; // drop C0/C1
      const w = graphemeWidth(g);
      if (w > 0 && col + w > width && col > 0) {
        cur = [];
        lines.push(cur);
        col = 0;
        starts?.push({ span: si, offset: offset - g.length });
      }
      push(g, span.style);
      col += w;
    }
  }
  return lines;
}

/**
 * 流式尾部增量重折（1.1.9 P1）。entry 必须是 prev 的折行结果。
 *
 * 只接受一种形态：next = prev 的「单点追加」——存在 k 使得
 *   - next[0..k-1] 与 prev[0..k-1] 逐 span 全等（text + style）；
 *   - next[k] 与 prev[k] 同 style，且 text 是 prev[k].text 的向前增长
 *     （增长量可为 0，即纯插入）；
 *   - next 末尾与 prev[k+1..] 逐 span 全等（中间允许插入新 span——流式光标
 *     ▍ 这类恒定尾缀就是 k = 倒数第二 span、尾缀 1 个 span 的情形）。
 *
 * 此时 prev 折行结果中，重折锚点所在 visual line 之前的行逐字节稳定（折行
 * 是左到右的确定性状态机，已完结的前缀不受追加影响），只需从该行的源起点
 * 用 next 的 spans 重折尾段。锚点 = next 中包含插入点的 grapheme 簇的起点
 * （见 clusterFloor：chunk 切开的簇在追加时会与前面的码元并簇）。任何疑义
 * （缩短、中间 span 变化、style 变化）→ 返回 null，调用方回退全量
 * wrapSpans。渲染正确性优先于性能。
 */
export function rewrapAppended(
  prev: Span[],
  next: Span[],
  entry: WrapEntry,
  width: number,
): WrapEntry | null {
  if (prev.length === 0 || next.length < prev.length) return null;
  // 公共前缀 / 公共尾缀（逐 span 全等），夹出中间的变化区。
  let p = 0;
  while (p < prev.length && p < next.length && spanEquals(prev[p], next[p])) p++;
  let s = 0;
  while (
    s < prev.length - p &&
    s < next.length - p &&
    spanEquals(prev[prev.length - 1 - s], next[next.length - 1 - s])
  )
    s++;
  const oldMid = prev.length - p - s;
  let k: number; // 追加发生的 span（prev 下标）
  if (oldMid === 1) {
    k = p;
    const a = prev[k];
    const b = next[k];
    if (!sameStyle(a.style, b.style)) return null;
    if (!b.text.startsWith(a.text)) return null;
  } else if (oldMid === 0) {
    k = p - 1; // 纯插入：追加点在 prev[p-1] 末尾
    if (k < 0) return null; // 插在开头 = 全文变，直接全量
  } else {
    return null;
  }

  // 插入点（prev 坐标）。它之前的 visual line 全部稳定；找到包含插入点的
  // 行 L（最后一个起点 <= 插入点的行），从 L 的源起点用 next 重折尾段。
  // 注意追加可能让 next 把插入点前的码元并进更大的簇（ZWJ 序列），所以
  // 实际锚点是 next 中包含插入点的簇的**起点**，而非插入点本身。
  const atSpan = k;
  const atOffset =
    oldMid === 1
      ? clusterFloor(next[k].text, prev[k].text.length)
      : prev[k].text.length; // 纯插入：spans 各自独立切分，不存在跨合并
  let L = 0;
  for (let i = 0; i < entry.starts.length; i++) {
    const st = entry.starts[i];
    if (st.span < atSpan || (st.span === atSpan && st.offset <= atOffset)) L = i;
    else break;
  }
  const st = entry.starts[L];
  // st.span <= k 恒成立：st.span < k 时 next[st.span] 与 prev 全等；
  // st.span === k 时 st.offset 落在未变的前缀内（且是簇边界）。
  const src: Span[] = [
    {
      text: next[st.span].text.slice(st.offset),
      style: next[st.span].style,
    },
    ...next.slice(st.span + 1),
  ];
  const subStarts: LineStart[] = [];
  const rewrapped = wrapSpansCore(src, width, subStarts);
  return {
    lines: entry.lines.slice(0, L).concat(rewrapped),
    starts: entry.starts.slice(0, L).concat(
      subStarts.map((s2) => ({
        span: st.span + s2.span,
        offset: s2.span === 0 ? st.offset + s2.offset : s2.offset,
      })),
    ),
  };
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
