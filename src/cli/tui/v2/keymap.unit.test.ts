/**
 * keymap unit tests — chunk tokenization, modifier decoding, mouse wheel.
 */

import { describe, it, expect } from 'vitest';
import { parseKeys, resolveKey, keyToEdit } from './keymap';

describe('parseKeys', () => {
  it('splits a merged chunk of printable characters into ONE insert key', () => {
    // Fast typing merges chars into a single read — a one-chunk-one-key parser
    // silently dropped input (live bug in the first cut).
    const keys = parseKeys('ab你');
    expect(keys).toEqual([{ char: 'ab你', mods: [] }]);
  });

  it('parses arrow keys and keeps following text', () => {
    const keys = parseKeys('\x1b[A\x1b[Bx');
    expect(keys.map((k) => k.name ?? k.char)).toEqual(['up', 'down', 'x']);
  });

  it('decodes Ctrl+arrows (CSI 1;5X) with the ctrl modifier', () => {
    expect(resolveKey('\x1b[1;5D')).toEqual({ name: 'left', mods: ['ctrl'] });
    expect(resolveKey('\x1b[1;5C')).toEqual({ name: 'right', mods: ['ctrl'] });
    // modifier param = 1 + bitmask(shift=1, alt=2, ctrl=4)
    expect(resolveKey('\x1b[1;2A')).toEqual({ name: 'up', mods: ['shift'] });
    expect(resolveKey('\x1b[1;6A')).toEqual({ name: 'up', mods: ['shift', 'ctrl'] });
  });

  it('SGR mouse 事件被吞掉(鼠标捕获已关,点击绝不伪造成 Esc)', () => {
    expect(resolveKey('\x1b[<64;10;5M')).toEqual({ char: '', mods: [] });
    expect(resolveKey('\x1b[<0;10;5M')).toEqual({ char: '', mods: [] }); // 点击不再是 Esc
  });

  it('maps Enter / Ctrl+J / Alt+Enter / kitty shift+enter correctly', () => {
    expect(resolveKey('\r')).toEqual({ name: 'enter', mods: [] });
    expect(resolveKey('\n')).toEqual({ name: 'newline', mods: [] });
    expect(resolveKey('\x1b\r')).toEqual({ name: 'newline', mods: [] });
    expect(resolveKey('\x1b[13;2u')).toEqual({ name: 'newline', mods: [] });
  });

  it('parses SS3 arrows (application mode)', () => {
    expect(resolveKey('\x1bOA')).toEqual({ name: 'up', mods: [] });
    expect(resolveKey('\x1bOD')).toEqual({ name: 'left', mods: [] });
  });

  it('parses shift+tab, delete, pgup/pgdn, home/end', () => {
    expect(resolveKey('\x1b[Z')).toEqual({ name: 'tab', mods: ['shift'] });
    expect(resolveKey('\x1b[3~')).toEqual({ name: 'delete', mods: [] });
    expect(resolveKey('\x1b[5~')).toEqual({ name: 'pgup', mods: [] });
    expect(resolveKey('\x1b[6~')).toEqual({ name: 'pgdn', mods: [] });
    expect(resolveKey('\x1b[H')).toEqual({ name: 'home', mods: [] });
    expect(resolveKey('\x1b[F')).toEqual({ name: 'end', mods: [] });
  });

  it('maps Ctrl+letter to a ctrl-modified char key', () => {
    expect(resolveKey('\x03')).toEqual({ char: 'c', mods: ['ctrl'] });
    expect(resolveKey('\x1a')).toEqual({ char: 'z', mods: ['ctrl'] });
  });

  it('lone escape resolves to esc', () => {
    expect(resolveKey('\x1b')).toEqual({ name: 'esc', mods: [] });
  });
});

describe('keyToEdit', () => {
  it('routes plain text to insert', () => {
    expect(keyToEdit({ char: 'a', mods: [] })).toEqual({ type: 'insert', text: 'a' });
  });

  it('routes Ctrl+arrows to word moves', () => {
    expect(keyToEdit({ name: 'left', mods: ['ctrl'] })).toEqual({ type: 'word-left' });
  });

  it('keeps enter/newline/tab app-level (null here)', () => {
    expect(keyToEdit({ name: 'enter', mods: [] })).toBeNull();
    expect(keyToEdit({ name: 'newline', mods: [] })).toBeNull();
    expect(keyToEdit({ name: 'tab', mods: [] })).toBeNull();
  });

  it('maps emacs kills', () => {
    expect(keyToEdit({ char: 'u', mods: ['ctrl'] })).toEqual({ type: 'kill-line' });
    expect(keyToEdit({ char: 'k', mods: ['ctrl'] })).toEqual({ type: 'kill-to-eol' });
    expect(keyToEdit({ char: 'w', mods: ['ctrl'] })).toEqual({ type: 'kill-word' });
  });
});
