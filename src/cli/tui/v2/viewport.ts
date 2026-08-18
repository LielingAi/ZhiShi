/**
 * Viewport state machine (design-spec §6.3: 无模式回看).
 *
 * Works over VISUAL rows (content already wrapped at the current width);
 * the terminal-writer feeds it append/reflow events and reads back the
 * visible window. Pure state machine — no I/O, no timers, no content.
 *
 * Contract (chat-app semantics, not less):
 *   - scrollOffset === 0 means FOLLOW THE TAIL: the window always ends at
 *     the newest row when appends arrive.
 *   - Any upward scroll pauses following. Appends then keep the viewed
 *     content still (new rows never drag you down) and are counted.
 *   - Scrolling back to the very bottom resumes following and clears the
 *     "↓ N 条新消息" count.
 *   - Width changes must be followed by `syncTotal()` once content has been
 *     re-wrapped (reflow); a follower stays glued to the tail, a reader
 *     keeps their offset (clamped).
 */

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ViewportState {
  width: number;
  height: number;
  /** Total visual rows of content. */
  total: number;
  /** Visual rows above the tail; 0 = pinned to bottom. */
  scrollOffset: number;
  /** Rows appended while scrolled away from the tail. */
  newCount: number;
  /** Whether the window tracks the tail (scrollOffset === 0). */
  following: boolean;
}

export interface VisibleWindow {
  /** First visible visual row, 0-based, inclusive. */
  start: number;
  /** One past the last visible visual row. */
  end: number;
}

export class Viewport {
  private width: number;
  private height: number;
  private total = 0;
  private offset = 0;
  private newRows = 0;

  constructor(size: ViewportSize) {
    this.width = Math.max(1, size.width);
    this.height = Math.max(1, size.height);
  }

  /** Notify that `visualRows` rows were appended to the content. */
  appendRows(visualRows: number): void {
    if (visualRows <= 0) return;
    this.total += visualRows;
    if (this.offset > 0) {
      // Offset is measured from the tail: it must grow with each append so
      // the viewed content stands still (新行不拽) and the count accrues.
      this.offset += visualRows;
      this.newRows += visualRows;
    }
    // Following needs no bookkeeping: window() derives the tail from total.
  }

  /**
   * Re-sync the total visual-row count after a reflow (rewrap on width
   * change) or an in-place content update that changed row heights.
   * Followers stay at the tail; readers keep (clamped) offset.
   */
  syncTotal(total: number): void {
    this.total = Math.max(0, total);
    this.offset = Math.min(this.offset, this.maxOffset());
  }

  /** Positive delta scrolls UP (towards older rows); negative scrolls down. */
  scrollBy(delta: number): void {
    if (delta === 0) return;
    const next = Math.min(Math.max(this.offset + delta, 0), this.maxOffset());
    this.offset = next;
    if (this.offset === 0) this.newRows = 0;
  }

  scrollPages(pages: number): void {
    this.scrollBy(pages * this.height);
  }

  scrollToTail(): void {
    this.offset = 0;
    this.newRows = 0;
  }

  /** Full reset: forget all content (used on /reset and cold replays). */
  reset(): void {
    this.total = 0;
    this.offset = 0;
    this.newRows = 0;
  }

  scrollToTop(): void {
    this.offset = this.maxOffset();
  }

  resize(size: ViewportSize): void {
    this.width = Math.max(1, size.width);
    this.height = Math.max(1, size.height);
    this.offset = Math.min(this.offset, this.maxOffset());
  }

  /** Currently visible slice of visual rows. */
  window(): VisibleWindow {
    const end = this.total - this.offset;
    const start = Math.max(0, end - this.height);
    return { start, end };
  }

  /** Indicator count for "↓ N 条新消息" — 0 when following (nothing to show). */
  pendingCount(): number {
    return this.offset > 0 ? this.newRows : 0;
  }

  state(): ViewportState {
    return {
      width: this.width,
      height: this.height,
      total: this.total,
      scrollOffset: this.offset,
      newCount: this.pendingCount(),
      following: this.offset === 0,
    };
  }

  private maxOffset(): number {
    return Math.max(0, this.total - this.height);
  }
}
