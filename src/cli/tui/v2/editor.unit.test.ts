/**
 * editor unit tests — grapheme cursor accuracy (CJK), multi-line insert,
 * kill ring, history recall.
 */

import { describe, it, expect } from 'vitest';
import { LineEditor } from './editor';

describe('LineEditor', () => {
  it('inserts CJK text with a grapheme-accurate cursor cell column', () => {
    const e = new LineEditor();
    e.apply({ type: 'insert', text: '你好ab' });
    // 2 wide chars (2 cells each) + 2 ascii = 6 cells.
    expect(e.cursorCellCol(0)).toBe(6);
    e.apply({ type: 'left' });
    e.apply({ type: 'left' });
    expect(e.cursorCellCol(0)).toBe(4); // before 'a'
    // The old code sliced by code-unit index and corrupted this on CJK.
  });

  it('splits multi-line paste into lines without duplicating the tail', () => {
    const e = new LineEditor();
    e.apply({ type: 'insert', text: 'xy' });
    e.apply({ type: 'left' });
    // paste "A\nB\nC" between x and y → xA / B / Cy (tail must appear ONCE).
    e.apply({ type: 'paste', text: 'A\nB\nC' });
    expect(e.snapshot().lines).toEqual(['xA', 'B', 'Cy']);
  });

  it('backspace across a line boundary joins lines', () => {
    const e = new LineEditor();
    e.apply({ type: 'insert', text: 'ab' });
    e.apply({ type: 'newline' });
    e.apply({ type: 'insert', text: 'cd' });
    e.apply({ type: 'home' });
    e.apply({ type: 'backspace' });
    expect(e.text).toBe('abcd');
  });

  it('kill-word removes the word BEFORE the cursor (Ctrl+W semantics)', () => {
    const e = new LineEditor();
    e.apply({ type: 'insert', text: 'foo bar baz' });
    e.apply({ type: 'kill-word' });
    expect(e.text).toBe('foo bar ');
    e.apply({ type: 'yank' });
    expect(e.text).toBe('foo bar baz');
  });

  it('kill-line (Ctrl+U) kills to beginning of line, kill-to-eol (Ctrl+K) to end', () => {
    const e = new LineEditor();
    e.apply({ type: 'insert', text: 'hello world' });
    e.apply({ type: 'home' });
    e.apply({ type: 'kill-to-eol' });
    expect(e.text).toBe('');
    e.apply({ type: 'insert', text: 'hello world' });
    // cursor at end; step left over 'world' so Ctrl+U kills only 'hello '.
    for (let i = 0; i < 5; i++) e.apply({ type: 'left' });
    e.apply({ type: 'kill-line' });
    expect(e.text).toBe('world');
  });

  it('history recall walks newest-first and restores the saved draft', () => {
    const e = new LineEditor();
    e.setHistory(['one', 'two', 'three']);
    e.apply({ type: 'insert', text: 'draft' });
    e.apply({ type: 'history-prev' });
    expect(e.text).toBe('three');
    e.apply({ type: 'history-prev' });
    expect(e.text).toBe('two');
    e.apply({ type: 'history-next' });
    expect(e.text).toBe('three');
    e.apply({ type: 'history-next' });
    expect(e.text).toBe('draft'); // saved draft restored at the bottom
  });

  it('setText replaces the buffer and parks the cursor at the end', () => {
    const e = new LineEditor();
    e.setText('a\nb');
    expect(e.snapshot()).toEqual({ lines: ['a', 'b'], cursorRow: 1, cursorCol: 1 });
    expect(e.onLastLine).toBe(true);
    expect(e.onFirstLine).toBe(false);
  });

  it('word navigation jumps over punctuation then the word', () => {
    const e = new LineEditor();
    e.apply({ type: 'insert', text: 'foo -- bar' });
    e.apply({ type: 'word-left' });
    expect(e.snapshot().cursorCol).toBe(7); // start of 'bar'
    e.apply({ type: 'word-left' });
    expect(e.snapshot().cursorCol).toBe(0); // start of 'foo'
  });
});
