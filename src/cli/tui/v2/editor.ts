/**
 * editor (plan §2.6). Multi-line line editor — pure state machine, zero I/O.
 * Grapheme-indexed cursor (CJK/emoji move as one unit), word navigation,
 * emacs kills + kill-ring, persistent-history recall, bracketed-paste insert.
 *
 * The app renders it via chrome.composeInputBox() — this module owns only the
 * buffer; wrapping/windowing is a render concern (see chrome.ts).
 */

import { graphemes, graphemeWidth } from '../ansi';

export type EditAction =
  | { type: 'insert'; text: string }
  | { type: 'paste'; text: string }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'word-left' }
  | { type: 'word-right' }
  | { type: 'newline' }
  | { type: 'kill-line' } // Ctrl+U — kill to beginning of line
  | { type: 'kill-to-eol' } // Ctrl+K
  | { type: 'kill-word' } // Ctrl+W / Alt+Backspace
  | { type: 'yank' }
  | { type: 'history-prev' }
  | { type: 'history-next' };

export interface EditorSnapshot {
  lines: string[];
  cursorRow: number;
  /** Grapheme index within the cursor line. */
  cursorCol: number;
}

const HISTORY_CAP = 1000;

export class LineEditor {
  private lines: string[] = [''];
  private row = 0;
  private col = 0; // grapheme index within lines[row]
  private killRing = '';
  private history: string[] = [];
  private historyIdx = -1;
  private savedForHistory: string[] = [];

  get text(): string {
    return this.lines.join('\n');
  }

  get isEmpty(): boolean {
    return this.lines.length === 1 && this.lines[0].length === 0;
  }

  setHistory(h: string[]): void {
    this.history = h.slice(-HISTORY_CAP);
    this.historyIdx = this.history.length;
  }

  /** Replace the whole buffer (rewind prefill, clear). Cursor → end. */
  setText(text: string): void {
    this.lines = text === '' ? [''] : text.split('\n');
    this.row = this.lines.length - 1;
    this.col = graphemes(this.lines[this.row]).length;
    this.historyIdx = this.history.length;
  }

  /** Apply a normalized edit action. Returns true if state changed. */
  apply(a: EditAction): boolean {
    switch (a.type) {
      case 'insert':
      case 'paste':
        return this.insert(a.text);
      case 'backspace':
        return this.backspace();
      case 'delete':
        return this.del();
      case 'left':
        return this.move(-1, 0);
      case 'right':
        return this.move(1, 0);
      case 'up':
        return this.move(0, -1);
      case 'down':
        return this.move(0, 1);
      case 'home':
        return this.atCol(0);
      case 'end':
        return this.atCol(this.lineLen(this.row));
      case 'word-left':
        return this.wordMove(-1);
      case 'word-right':
        return this.wordMove(1);
      case 'newline':
        return this.newline();
      case 'kill-line':
        return this.killToBol();
      case 'kill-to-eol':
        return this.killToEol();
      case 'kill-word':
        return this.killWord();
      case 'yank':
        return this.killRing ? this.insert(this.killRing) : false;
      case 'history-prev':
        return this.historyStep(-1);
      case 'history-next':
        return this.historyStep(1);
      default:
        return false;
    }
  }

  snapshot(): EditorSnapshot {
    return { lines: [...this.lines], cursorRow: this.row, cursorCol: this.col };
  }

  /**
   * Display-cell column of the cursor within its line (grapheme-accurate —
   * the old code sliced the string by code-unit index using a grapheme
   * index, which corrupts the cursor position on CJK text).
   */
  cursorCellCol(lineLeadWidth: number): number {
    const gs = graphemes(this.lines[this.row]);
    let w = lineLeadWidth;
    for (let i = 0; i < this.col && i < gs.length; i++) w += graphemeWidth(gs[i]);
    return w;
  }

  /** True when the cursor sits on the first line (app: ↑ → history recall). */
  get onFirstLine(): boolean {
    return this.row === 0;
  }

  /** True when the cursor sits on the last line. */
  get onLastLine(): boolean {
    return this.row === this.lines.length - 1;
  }

  // --- internals ---

  private lineLen(row: number): number {
    return graphemes(this.lines[row]).length;
  }

  private insert(text: string): boolean {
    if (text === '') return false;
    // Strip CR — bracketed paste can carry CRLF; the buffer is \n-only.
    const clean = text.replace(/\r\n?/g, '\n');
    const gs = graphemes(this.lines[this.row]);
    const before = gs.slice(0, this.col).join('');
    const after = gs.slice(this.col).join('');
    if (!clean.includes('\n')) {
      this.lines[this.row] = before + clean + after;
      this.col += graphemes(clean).length;
      return true;
    }
    const parts = clean.split('\n');
    const rebuilt: string[] = [before + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + after];
    this.lines.splice(this.row, 1, ...rebuilt);
    this.row += rebuilt.length - 1;
    this.col = graphemes(parts[parts.length - 1]).length;
    return true;
  }

  private backspace(): boolean {
    if (this.col > 0) {
      const gs = graphemes(this.lines[this.row]);
      this.lines[this.row] = gs.slice(0, this.col - 1).join('') + gs.slice(this.col).join('');
      this.col -= 1;
      return true;
    }
    if (this.row > 0) {
      const prev = this.lines[this.row - 1];
      this.lines[this.row - 1] = prev + this.lines[this.row];
      this.lines.splice(this.row, 1);
      this.row -= 1;
      this.col = graphemes(prev).length;
      return true;
    }
    return false;
  }

  private del(): boolean {
    const gs = graphemes(this.lines[this.row]);
    if (this.col < gs.length) {
      this.lines[this.row] = gs.slice(0, this.col).join('') + gs.slice(this.col + 1).join('');
      return true;
    }
    if (this.row < this.lines.length - 1) {
      this.lines[this.row] += this.lines[this.row + 1];
      this.lines.splice(this.row + 1, 1);
      return true;
    }
    return false;
  }

  private move(dCol: number, dRow: number): boolean {
    if (dRow !== 0) {
      const nr = this.row + dRow;
      if (nr < 0 || nr >= this.lines.length) return false;
      this.row = nr;
      this.col = Math.min(this.col, this.lineLen(nr));
      return true;
    }
    const nc = this.col + dCol;
    if (nc < 0 || nc > this.lineLen(this.row)) return false;
    this.col = nc;
    return true;
  }

  private atCol(c: number): boolean {
    if (this.col === c) return false;
    this.col = c;
    return true;
  }

  private wordMove(dir: number): boolean {
    const gs = graphemes(this.lines[this.row]);
    const isWord = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
    let i = this.col;
    if (dir < 0) {
      while (i > 0 && !isWord(gs[i - 1])) i--;
      while (i > 0 && isWord(gs[i - 1])) i--;
    } else {
      while (i < gs.length && !isWord(gs[i])) i++;
      while (i < gs.length && isWord(gs[i])) i++;
    }
    if (i === this.col) return false;
    this.col = i;
    return true;
  }

  private newline(): boolean {
    const gs = graphemes(this.lines[this.row]);
    const before = gs.slice(0, this.col).join('');
    const after = gs.slice(this.col).join('');
    this.lines[this.row] = before;
    this.lines.splice(this.row + 1, 0, after);
    this.row += 1;
    this.col = 0;
    return true;
  }

  private killToBol(): boolean {
    const gs = graphemes(this.lines[this.row]);
    if (this.col === 0) return false;
    this.killRing = gs.slice(0, this.col).join('');
    this.lines[this.row] = gs.slice(this.col).join('');
    this.col = 0;
    return true;
  }

  private killToEol(): boolean {
    const gs = graphemes(this.lines[this.row]);
    if (this.col >= gs.length) return false;
    this.killRing = gs.slice(this.col).join('');
    this.lines[this.row] = gs.slice(0, this.col).join('');
    return true;
  }

  private killWord(): boolean {
    const gs = graphemes(this.lines[this.row]);
    const isWord = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
    let i = this.col;
    while (i > 0 && !isWord(gs[i - 1])) i--;
    while (i > 0 && isWord(gs[i - 1])) i--;
    if (i === this.col) return false;
    this.killRing = gs.slice(i, this.col).join('');
    this.lines[this.row] = gs.slice(0, i).join('') + gs.slice(this.col).join('');
    this.col = i;
    return true;
  }

  private historyStep(dir: number): boolean {
    if (this.history.length === 0) return false;
    if (this.historyIdx === this.history.length) {
      this.savedForHistory = [...this.lines];
    }
    const ni = Math.max(0, Math.min(this.history.length, this.historyIdx + dir));
    if (ni === this.historyIdx) return false;
    this.historyIdx = ni;
    this.lines = ni === this.history.length ? [...this.savedForHistory] : this.history[ni].split('\n');
    this.row = this.lines.length - 1;
    this.col = this.lineLen(this.row);
    return true;
  }
}
