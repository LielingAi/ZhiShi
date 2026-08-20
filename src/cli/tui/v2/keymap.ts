/**
 * keymap (plan §2.7). Raw byte chunk → a LIST of semantic Keys.
 *
 * Why a list: in raw mode one stdin chunk can carry several keys (fast typing
 * merges characters into one read). A one-chunk-one-key parser silently drops
 * input — that was a live bug. `parseKeys` tokenizes the whole chunk.
 *
 * Coverage:
 *   - printable runs (incl. CJK / emoji) → one `insert` Key carrying the run
 *   - CSI: arrows/Home/End/PgUp/PgDn/Delete + modifier form `\x1b[1;{m}X`
 *   - SS3: `\x1bOA..D`, `\x1bOH/F` (some terminals' application mode)
 *   - SGR mouse wheel: `\x1b[<64;x;yM` / `\x1b[<65;x;yM`
 *   - kitty shift+enter `\x1b[13;2u`; Alt+Enter `\x1b\r`; Ctrl+J `\n` → newline
 *   - Ctrl+letter → {char, mods:[ctrl]}; Shift+Tab `\x1b[Z`
 *   - lone `\x1b` → esc (the app applies the 30ms disambiguation timer when
 *     the kitty protocol is not active)
 *
 * Modifier encoding (xterm): the parameter is 1 + bitmask(1=shift,2=alt,4=ctrl).
 */

export type Mod = 'ctrl' | 'shift' | 'alt' | 'meta';

export interface Key {
  /** Printable text to insert (may be several characters from one chunk). */
  char?: string;
  name?:
    | 'esc'
    | 'enter'
    | 'newline' // Ctrl+J / Alt+Enter / Shift+Enter(kitty)
    | 'tab'
    | 'backspace'
    | 'delete'
    | 'up'
    | 'down'
    | 'left'
    | 'right'
    | 'home'
    | 'end'
    | 'pgup'
    | 'pgdn'
    | 'wheel-up'
    | 'wheel-down';
  mods: Mod[];
}

const CSI_FINAL = /[\x40-\x7e]/;

/** Tokenize a raw input chunk into semantic keys. */
export function parseKeys(raw: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  let text = '';
  const flushText = (): void => {
    if (text) {
      keys.push({ char: text, mods: [] });
      text = '';
    }
  };

  while (i < raw.length) {
    const ch = raw[i];

    // --- escape sequences ---
    if (ch === '\x1b') {
      // CSI
      if (raw[i + 1] === '[') {
        let j = i + 2;
        while (j < raw.length && !CSI_FINAL.test(raw[j])) j++;
        if (j >= raw.length) {
          // Incomplete sequence at chunk tail — drop (next chunk won't resume
          // it; terminals send complete sequences per read in practice).
          flushText();
          i = raw.length;
          break;
        }
        flushText();
        keys.push(parseCsi(raw.slice(i + 2, j), raw[j]));
        i = j + 1;
        continue;
      }
      // SS3
      if (raw[i + 1] === 'O' && i + 2 < raw.length) {
        flushText();
        keys.push(parseSs3(raw[i + 2]));
        i += 3;
        continue;
      }
      // Alt+key
      if (i + 1 < raw.length) {
        flushText();
        const next = raw[i + 1];
        if (next === '\r') keys.push({ name: 'newline', mods: [] }); // Alt+Enter
        else if (next === '\x7f') keys.push({ name: 'backspace', mods: ['alt'] });
        else if (next >= ' ') keys.push({ char: next, mods: ['alt'] });
        i += 2;
        continue;
      }
      // Lone Esc
      flushText();
      keys.push({ name: 'esc', mods: [] });
      i += 1;
      continue;
    }

    // --- control characters ---
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      flushText();
      if (ch === '\r') keys.push({ name: 'enter', mods: [] });
      else if (ch === '\n') keys.push({ name: 'newline', mods: [] }); // Ctrl+J
      else if (ch === '\t') keys.push({ name: 'tab', mods: [] });
      else if (code === 0x7f || code === 0x08) keys.push({ name: 'backspace', mods: [] });
      else if (code >= 1 && code <= 26) {
        keys.push({ char: String.fromCharCode(96 + code), mods: ['ctrl'] });
      }
      i += 1;
      continue;
    }

    // --- printable (accumulate the run) ---
    text += ch;
    i += 1;
  }
  flushText();
  return keys;
}

/** Parse a CSI body (without the leading `\x1b[`) + final byte into a Key. */
function parseCsi(body: string, final: string): Key {
  // SGR mouse（1.1.6 #3）：只放行滚轮（码 64/65，bit6 置位）——wheel-up/
  // wheel-down 进回看翻历史；点击/拖拽仍吞掉，绝不能回退成 Esc（旧实现把
  // 点击当 Esc：运行中点输入框=中断）。
  if (body.startsWith('<') && (final === 'M' || final === 'm')) {
    const code = parseInt(body.slice(1).split(';')[0] ?? '', 10);
    if (final === 'M' && Number.isFinite(code) && (code & 64) !== 0) {
      return { name: (code & 1) === 0 ? 'wheel-up' : 'wheel-down', mods: [] };
    }
    return { char: '', mods: [] }; // 吞掉,不产生任何语义键
  }

  // kitty keyboard protocol: {key};{mods}u — we only care about Enter.
  if (final === 'u') {
    const [keyCode, modParam] = body.split(';');
    if (keyCode === '13') {
      const mods = parseMods(parseInt(modParam ?? '1', 10));
      return mods.includes('shift') ? { name: 'newline', mods: [] } : { name: 'enter', mods: [] };
    }
    return { char: '', mods: [] };
  }

  const parts = body.split(';');
  const first = parts[0] ?? '';
  const mods = parseMods(parseInt(parts[1] ?? '1', 10));

  const byLetter: Record<string, Key['name']> = {
    A: 'up',
    B: 'down',
    C: 'right',
    D: 'left',
    H: 'home',
    F: 'end',
    E: 'home', // some terminals
  };
  if (byLetter[final] && (first === '' || first === '1')) {
    return { name: byLetter[final], mods };
  }
  if (final === 'Z') return { name: 'tab', mods: ['shift'] };
  if (final === '~') {
    const byNum: Record<string, Key['name']> = {
      '1': 'home',
      '3': 'delete',
      '4': 'end',
      '5': 'pgup',
      '6': 'pgdn',
      '7': 'home',
      '8': 'end',
    };
    if (byNum[first]) return { name: byNum[first], mods };
  }
  return { char: '', mods: [] }; // unknown CSI — ignored
}

function parseSs3(final: string): Key {
  const map: Record<string, Key['name']> = {
    A: 'up',
    B: 'down',
    C: 'right',
    D: 'left',
    H: 'home',
    F: 'end',
  };
  return map[final] ? { name: map[final], mods: [] } : { char: '', mods: [] };
}

/** xterm modifier parameter: 1 + bitmask(1=shift, 2=alt, 4=ctrl). */
function parseMods(n: number): Mod[] {
  const bits = Math.max(0, n - 1);
  const mods: Mod[] = [];
  if (bits & 1) mods.push('shift');
  if (bits & 2) mods.push('alt');
  if (bits & 4) mods.push('ctrl');
  return mods;
}

export function hasMod(k: Key, m: Mod): boolean {
  return k.mods.includes(m);
}

/** Single-key convenience wrapper (tests + callers that hold one chunk = one key). */
export function resolveKey(raw: string): Key | null {
  const keys = parseKeys(raw);
  return keys.length > 0 ? keys[0] : null;
}

/**
 * Build an EditAction from a Key for the editor (input mode). The app owns
 * enter/newline/tab/esc/wheel + mode routing; everything else lands here.
 */
export function keyToEdit(k: Key): import('./editor').EditAction | null {
  const ctrl = hasMod(k, 'ctrl');
  if (k.name !== undefined && k.char === undefined) {
    switch (k.name) {
      case 'backspace':
        return { type: 'backspace' };
      case 'delete':
        return { type: 'delete' };
      case 'left':
        return ctrl ? { type: 'word-left' } : { type: 'left' };
      case 'right':
        return ctrl ? { type: 'word-right' } : { type: 'right' };
      case 'up':
        return ctrl ? { type: 'history-prev' } : { type: 'up' };
      case 'down':
        return ctrl ? { type: 'history-next' } : { type: 'down' };
      case 'home':
        return { type: 'home' };
      case 'end':
        return { type: 'end' };
      default:
        return null; // enter/newline/tab/esc/wheel/pgup/pgdn — app-level
    }
  }
  if (ctrl && k.char) {
    switch (k.char) {
      case 'a':
        return { type: 'home' };
      case 'e':
        return { type: 'end' };
      case 'u':
        return { type: 'kill-line' };
      case 'k':
        return { type: 'kill-to-eol' };
      case 'w':
        return { type: 'kill-word' };
      case 'y':
        return { type: 'yank' };
      case 'h':
        return { type: 'backspace' };
      default:
        return null; // other Ctrl+letter combos are app-level (c/l/o/z/r/…)
    }
  }
  if (hasMod(k, 'alt') && k.name === 'backspace') return { type: 'kill-word' };
  if (k.char) return { type: 'insert', text: k.char };
  return null;
}
