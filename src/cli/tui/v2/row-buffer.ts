/**
 * Logical row buffer for the mini-renderer (design-spec §9: 行缓冲).
 *
 * A ROW is the unit of content: an ordered array of spans, each span a text
 * chunk with an optional SEMANTIC style (see style.ts). Rows are what the
 * session-flow layer (W3) will produce: user message, assistant paragraph,
 * folded tool card, interrupt divider…
 *
 * Rows may carry caller-supplied ids so an element can be inserted
 * optimistically and patched later — e.g. the Esc interrupt divider appears
 * instantly with "已中断", then gets updated with the final tool-kept count
 * when the server answers.
 *
 * Pure data structure: no I/O, no width math (wrapping is the writer's job,
 * at render time and at the current width). Capacity-capped; oldest rows are
 * evicted past the cap and an `evict` event is emitted so downstream caches
 * can drop their derived state.
 */

import type { Style } from './style';

export interface Span {
  text: string;
  style?: Style;
}

export interface Row {
  id: string;
  spans: Span[];
}

export type RowBufferEvent =
  | { type: 'append'; row: Row }
  | { type: 'update'; row: Row }
  | { type: 'remove'; row: Row }
  | { type: 'evict'; rows: Row[] }
  | { type: 'clear' };

export type RowBufferListener = (event: RowBufferEvent) => void;

export interface RowBufferOptions {
  /** Max retained rows; oldest are evicted beyond this (default 5000). */
  capacity?: number;
}

export const DEFAULT_CAPACITY = 5000;

export class RowBuffer {
  private readonly rowsArr: Row[] = [];
  private readonly byId = new Map<string, Row>();
  private readonly listeners = new Set<RowBufferListener>();
  private seq = 0;
  readonly capacity: number;

  constructor(opts: RowBufferOptions = {}) {
    this.capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY);
  }

  /**
   * Append a row. Pass `opts.id` for optimistic insertion (a later
   * `update(id, …)` patches it in place). Generated ids look like `row-N`;
   * caller-supplied ids must not collide with those.
   */
  append(spans: Span[], opts?: { id?: string }): Row {
    const id = opts?.id ?? `row-${++this.seq}`;
    if (this.byId.has(id)) throw new Error(`RowBuffer: duplicate row id ${id}`);
    const row: Row = { id, spans };
    this.rowsArr.push(row);
    this.byId.set(id, row);
    this.emit({ type: 'append', row });
    this.evictIfNeeded();
    return row;
  }

  /** Patch a row's spans in place (keeps its position). False if id unknown. */
  update(id: string, spans: Span[]): boolean {
    const row = this.byId.get(id);
    if (!row) return false;
    row.spans = spans;
    this.emit({ type: 'update', row });
    return true;
  }

  remove(id: string): boolean {
    const row = this.byId.get(id);
    if (!row) return false;
    this.byId.delete(id);
    this.rowsArr.splice(this.rowsArr.indexOf(row), 1);
    this.emit({ type: 'remove', row });
    return true;
  }

  get(id: string): Row | undefined {
    return this.byId.get(id);
  }

  /** All retained rows, oldest first. */
  rows(): readonly Row[] {
    return this.rowsArr;
  }

  get length(): number {
    return this.rowsArr.length;
  }

  clear(): void {
    if (this.rowsArr.length === 0) return;
    this.rowsArr.length = 0;
    this.byId.clear();
    this.emit({ type: 'clear' });
  }

  subscribe(listener: RowBufferListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private evictIfNeeded(): void {
    const over = this.rowsArr.length - this.capacity;
    if (over <= 0) return;
    const evicted = this.rowsArr.splice(0, over);
    for (const row of evicted) this.byId.delete(row.id);
    this.emit({ type: 'evict', rows: evicted });
  }

  private emit(event: RowBufferEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
