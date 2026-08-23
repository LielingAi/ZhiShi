// Unit tests for the terminal writer (dirty-row diff renderer).
// Asserts against a minimal virtual terminal fed with the exact ANSI bytes
// the writer emits — layout, diffing, coalescing, reflow, scrollback and
// width math are verified by final on-screen state, never by internals.
import { describe, expect, it } from 'vitest';

import { graphemes, graphemeWidth, stringWidth } from '../ansi';
import type { TimerApi } from './frame-scheduler';
import {
  overlayRight,
  TerminalWriter,
  truncateSegments,
  wrapSpans,
} from './terminal-writer';

// ---------------------------------------------------------------------------
// Minimal VT emulator: CUP, EL, ED, SGR (tracked per cell), CR/LF, auto-wrap
// with pending-wrap state, wide chars. Just what the writer emits.
// ---------------------------------------------------------------------------

interface Cell {
  ch: string;
  sgr: string;
}

class VirtualScreen {
  readonly rows: number;
  readonly cols: number;
  private grid: Cell[][];
  row = 0;
  col = 0;
  private sgr = '';
  private pendingWrap = false;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.grid = this.blank();
  }

  private blank(): Cell[][] {
    return Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => ({ ch: ' ', sgr: '' })),
    );
  }

  feed(s: string): void {
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\x1b') {
        if (s[i + 1] === '[') {
          // eslint-disable-next-line no-control-regex -- intentional ANSI CSI matching
          const m = /^\x1b\[([0-9;?]*)([A-Za-z~])/.exec(s.slice(i));
          if (!m)
            throw new Error(
              `unparsed CSI at ${i}: ${JSON.stringify(s.slice(i, i + 10))}`,
            );
          this.csi(m[1], m[2]);
          i += m[0].length;
          continue;
        }
        throw new Error(
          `unparsed ESC at ${i}: ${JSON.stringify(s.slice(i, i + 10))}`,
        );
      }
      if (ch === '\r') {
        this.col = 0;
        this.pendingWrap = false;
        i++;
        continue;
      }
      if (ch === '\n') {
        this.pendingWrap = false;
        if (this.row < this.rows - 1) this.row++;
        i++;
        continue;
      }
      const g = graphemes(s.slice(i))[0];
      this.putGrapheme(g);
      i += g.length;
    }
  }

  private csi(params: string, final: string): void {
    this.pendingWrap = false;
    const nums = params.split(';').map((p) => parseInt(p, 10) || 0);
    switch (final) {
      case 'H': {
        this.row = Math.min(Math.max((nums[0] || 1) - 1, 0), this.rows - 1);
        this.col = Math.min(Math.max((nums[1] || 1) - 1, 0), this.cols - 1);
        break;
      }
      case 'K': {
        const start = nums[0] === 2 ? 0 : this.col;
        for (let c = start; c < this.cols; c++) {
          this.grid[this.row][c] = { ch: ' ', sgr: '' };
        }
        break;
      }
      case 'J': {
        if (nums[0] === 2) this.grid = this.blank();
        break;
      }
      case 'm': {
        this.sgr = params === '' || params === '0' ? '' : params;
        break;
      }
      case 'h':
      case 'l':
        break; // private modes (?1049 / ?25) — no visual effect here
      default:
        throw new Error(`unhandled CSI ${params}${final}`);
    }
  }

  private putGrapheme(g: string): void {
    const w = graphemeWidth(g);
    if (w === 0) return;
    if (this.pendingWrap) {
      this.pendingWrap = false;
      this.col = 0;
      if (this.row < this.rows - 1) this.row++;
    }
    if (w === 2 && this.col === this.cols - 1) {
      this.col = 0;
      if (this.row < this.rows - 1) this.row++;
    }
    this.grid[this.row][this.col] = { ch: g, sgr: this.sgr };
    if (w === 2 && this.col + 1 < this.cols)
      this.grid[this.row][this.col + 1] = { ch: '', sgr: this.sgr };
    this.col += w;
    if (this.col >= this.cols) {
      this.col = this.cols - 1;
      this.pendingWrap = true;
    }
  }

  /** 0-based row, trailing blanks/continuations trimmed. */
  line(r: number): string {
    return this.grid[r]
      .map((c) => c.ch)
      .join('')
      .trimEnd();
  }

  /** SGR params active at a cell ('' = default). */
  styleAt(r: number, c: number): string {
    return this.grid[r][c].sgr;
  }

  /** All SGR params present on a row, in cell order, deduped. */
  stylesOnRow(r: number): string[] {
    return [...new Set(this.grid[r].map((c) => c.sgr).filter((s) => s !== ''))];
  }

  get cursor(): { row: number; col: number } {
    return { row: this.row, col: this.col };
  }
}

// ---------------------------------------------------------------------------

class ManualTimer implements TimerApi {
  private queue = new Map<number, () => void>();
  private seq = 0;
  setTimeout(fn: () => void, _ms: number): unknown {
    const h = ++this.seq;
    this.queue.set(h, fn);
    return h;
  }
  clearTimeout(handle: unknown): void {
    this.queue.delete(handle as number);
  }
  runAll(): void {
    const fns = [...this.queue.values()];
    this.queue.clear();
    for (const fn of fns) fn();
  }
  get pending(): number {
    return this.queue.size;
  }
}

function makeWriter(cols: number, rows: number) {
  let buf = '';
  let writes = 0;
  const out = {
    write(s: string) {
      buf += s;
      writes++;
      return true;
    },
  };
  const timer = new ManualTimer();
  const writer = new TerminalWriter({ out, cols, rows, depth: '16', timer });
  const vt = new VirtualScreen(cols, rows);
  let fed = 0;
  return {
    writer,
    vt,
    timer,
    emitted: () => buf,
    delta(): string {
      const d = buf.slice(fed);
      fed = buf.length;
      vt.feed(d);
      return d;
    },
    sync() {
      vt.feed(buf.slice(fed));
      fed = buf.length;
    },
    writes: () => writes,
  };
}

const span = (
  text: string,
  fg?: 'cyan' | 'amber' | 'purple' | 'red' | 'green' | 'muted' | 'faint',
) => [{ text, style: fg ? { fg } : undefined }];

// ---------------------------------------------------------------------------

describe('layout & enter/exit', () => {
  it('computes three-region geometry (chrome = status 1 + input 1)', () => {
    const { writer } = makeWriter(80, 24);
    expect(writer.layout()).toEqual({
      cols: 80,
      rows: 24,
      outputTop: 1,
      outputBottom: 22,
      statusTop: 23,
      statusHeight: 1,
      inputTop: 24,
      inputHeight: 1,
      inputRow: 24,
    });
  });

  it('enter switches to the alternate screen; exit restores it', () => {
    const { writer, emitted } = makeWriter(80, 24);
    writer.enter();
    expect(emitted()).toContain('\x1b[?1049h');
    expect(emitted()).toContain('\x1b[2J');
    writer.exit();
    expect(emitted()).toContain('\x1b[?1049l');
    expect(emitted()).toContain('\x1b[?25h');
  });
});

describe('append & paint', () => {
  it('appended rows paint from the top of the output region', () => {
    const { writer, vt, delta } = makeWriter(40, 10);
    writer.enter();
    delta();
    writer.append(span('hello'));
    writer.append(span('world'));
    writer.flush();
    delta();
    expect(vt.line(0)).toBe('hello');
    expect(vt.line(1)).toBe('world');
    expect(vt.line(8)).toBe(''); // status row untouched
  });

  it('follows the tail once content overflows; chrome rows stay pinned', () => {
    const { writer, vt, delta } = makeWriter(40, 10);
    writer.enter();
    writer.setStatus([span('◐ 运行中')]);
    writer.setInput([span('pwn@docker ❯ ')], 0, stringWidth('pwn@docker ❯ '));
    delta();
    for (let i = 1; i <= 12; i++)
      writer.append(span(`l${String(i).padStart(2, '0')}`));
    writer.flush();
    delta();
    for (let i = 0; i < 8; i++)
      expect(vt.line(i)).toBe(`l${String(i + 5).padStart(2, '0')}`);
    expect(vt.line(8)).toBe('◐ 运行中');
    expect(vt.line(9)).toBe('pwn@docker ❯');
    expect(vt.cursor).toEqual({ row: 9, col: 13 });
  });
});

describe('dirty-row diffing', () => {
  it('a frame writes only the rows that changed', () => {
    const { writer, delta } = makeWriter(40, 10);
    writer.enter();
    writer.append(span('one'));
    writer.append(span('two'));
    writer.flush();
    delta();
    writer.append(span('three'));
    writer.flush();
    const d = delta();
    expect(d).toContain('\x1b[3;1H'); // row 3 written
    expect(d).not.toContain('\x1b[1;1H'); // rows 1-2 untouched
    expect(d).not.toContain('\x1b[2;1H');
  });

  it('a no-op flush writes nothing at all', () => {
    const { writer, delta, writes } = makeWriter(40, 10);
    writer.enter();
    writer.append(span('stable'));
    writer.setStatus([span('S')]);
    writer.setInput([span('❯ ')], 0, 2);
    writer.flush();
    delta();
    const before = writes();
    writer.flush();
    expect(writes()).toBe(before);
  });

  it('updating a row rewrites only that row (optimistic divider)', () => {
    const { writer, vt, delta } = makeWriter(60, 10);
    writer.enter();
    writer.append(span('before'));
    writer.append([{ text: '── ⏸ 已中断 14:32 ──', style: { fg: 'amber' } }], {
      id: 'div',
    });
    writer.flush();
    delta();
    writer.updateRow('div', [
      {
        text: '── ⏸ 已中断 14:32 · 3 个工具结果已保留 ──',
        style: { fg: 'amber' },
      },
    ]);
    writer.flush();
    const d = delta();
    expect(d).toContain('\x1b[2;1H');
    expect(d).not.toContain('\x1b[1;1H');
    expect(vt.line(1)).toBe('── ⏸ 已中断 14:32 · 3 个工具结果已保留 ──');
    expect(vt.stylesOnRow(1)).toEqual(['33']); // amber → yellow on 16-color
  });
});

describe('frame coalescing', () => {
  it('a burst of appends merges into one frame', () => {
    const { writer, timer, delta, writes } = makeWriter(40, 10);
    writer.enter();
    delta();
    const afterEnter = writes();
    for (let i = 0; i < 5; i++) writer.append(span(`burst-${i}`));
    expect(writes()).toBe(afterEnter); // nothing written yet
    expect(timer.pending).toBe(1); // one merged frame pending
    timer.runAll();
    expect(writes()).toBe(afterEnter + 1);
  });

  it('flush() paints immediately, ahead of the scheduled frame', () => {
    const { writer, timer, vt, delta } = makeWriter(40, 10);
    writer.enter();
    delta();
    writer.append(span('now'));
    writer.flush(); // Esc optimistic path: no 16ms wait
    delta();
    expect(vt.line(0)).toBe('now');
    expect(timer.pending).toBe(0);
  });
});

describe('scrollback (design §6.3 无模式回看)', () => {
  function filled() {
    const ctx = makeWriter(40, 10); // output rows 0..7
    ctx.writer.enter();
    for (let i = 1; i <= 12; i++)
      ctx.writer.append(span(`l${String(i).padStart(2, '0')}`));
    ctx.writer.flush();
    ctx.delta();
    return ctx;
  }

  it('scrolling up freezes the view; new rows do not drag it', () => {
    const { writer, vt, delta } = filled();
    writer.scrollBy(3);
    writer.flush();
    delta();
    expect(vt.line(0)).toBe('l02');
    expect(vt.line(7)).toBe('l09');

    writer.append(span('l13'));
    writer.append(span('l14'));
    writer.flush();
    delta();
    expect(vt.line(0)).toBe('l02'); // still the same content
    expect(vt.line(7)).not.toBe('l09'); // indicator badge overlaid bottom-right
    expect(vt.line(7)).toContain('↓ 2 条新消息');
    expect(vt.stylesOnRow(7)).toContain('33'); // amber badge
  });

  it('scrolling back to the bottom resumes tail-following and clears the badge', () => {
    const { writer, vt, delta } = filled();
    writer.scrollBy(3);
    writer.append(span('l13'));
    writer.flush();
    delta();
    writer.scrollToTail();
    writer.flush();
    delta();
    expect(vt.line(7)).toBe('l13');
    expect(vt.line(7)).not.toContain('新消息');
    expect(writer.viewportState().following).toBe(true);

    writer.append(span('l14'));
    writer.flush();
    delta();
    expect(vt.line(7)).toBe('l14'); // dragged again — we're following
  });
});

describe('width math (ansi.ts contract)', () => {
  it('wraps CJK rows on cell boundaries', () => {
    const { writer, vt, delta } = makeWriter(4, 10);
    writer.enter();
    writer.append(span('ab你好cd')); // ab(2)+你(2) | 好(2)+cd(2)
    writer.flush();
    delta();
    expect(vt.line(0)).toBe('ab你');
    expect(vt.line(1)).toBe('好cd');
  });

  it('wraps emoji ZWJ / VS16 clusters as single 2-cell units', () => {
    const { writer, vt, delta } = makeWriter(4, 10);
    writer.enter();
    writer.append(span('✈️✈️x')); // 2+2 | 1
    writer.flush();
    delta();
    expect(vt.line(0)).toBe('✈️✈️');
    expect(vt.line(1)).toBe('x');
  });

  it('never splits a wide char across the right edge', () => {
    const { writer, vt, delta } = makeWriter(4, 10);
    writer.enter();
    writer.append(span('abc你好')); // abc(3) + 你(2) doesn't fit in 4 → wraps
    writer.flush();
    delta();
    expect(vt.line(0)).toBe('abc');
    expect(vt.line(1)).toBe('你好');
  });

  it('positions the input cursor by display cells for CJK input', () => {
    const { writer, vt, delta } = makeWriter(20, 8);
    writer.enter();
    writer.setInput([[{ text: '❯ 你好' }]], 0, stringWidth('❯ 你')); // caret after 你
    writer.flush();
    delta();
    expect(vt.line(7)).toBe('❯ 你好');
    expect(vt.cursor).toEqual({ row: 7, col: 4 });
  });

  it('truncates overlong status lines to the screen width', () => {
    const { writer, vt, delta } = makeWriter(10, 6);
    writer.enter();
    writer.setStatus([span('x'.repeat(30))]);
    writer.flush();
    delta();
    expect(vt.line(4)).toBe('x'.repeat(10));
  });
});

describe('resize reflow', () => {
  it('re-wraps all rows at the new width and repaints in full', () => {
    const { writer, vt, delta } = makeWriter(20, 10);
    writer.enter();
    writer.append(span('a'.repeat(25)));
    writer.flush();
    delta();
    expect(vt.line(0)).toBe('a'.repeat(20));
    expect(vt.line(1)).toBe('aaaaa');

    writer.resize(10, 10);
    delta();
    expect(vt.line(0)).toBe('a'.repeat(10));
    expect(vt.line(1)).toBe('a'.repeat(10));
    expect(vt.line(2)).toBe('aaaaa');
  });

  it('keeps a scrolled reader on the same content across reflow', () => {
    const { writer, vt, delta } = makeWriter(10, 8); // output 6 rows
    writer.enter();
    for (let i = 1; i <= 10; i++) writer.append(span(`r${i}`));
    writer.flush();
    writer.scrollBy(2); // window [2,8) → r3..r8 on screen
    writer.flush();
    delta();
    expect(vt.line(0)).toBe('r3');
    expect(vt.line(5)).toBe('r8');

    writer.resize(20, 8); // rows still 1 visual line each; geometry unchanged
    delta();
    expect(vt.line(0)).toBe('r3');
    expect(vt.line(5)).toBe('r8');
  });

  it('shrinking height clamps the window and keeps chrome pinned', () => {
    const { writer, vt, delta } = makeWriter(40, 24);
    writer.enter();
    for (let i = 1; i <= 30; i++) writer.append(span(`row${i}`));
    writer.setStatus([span('S')]);
    writer.setInput([span('❯ ')], 0, 2);
    writer.flush();
    delta();
    writer.resize(40, 10);
    delta();
    expect(vt.line(0)).toBe('row23'); // last 8 rows follow the tail
    expect(vt.line(7)).toBe('row30');
    expect(vt.line(8)).toBe('S');
    expect(vt.line(9)).toBe('❯');
    expect(vt.cursor).toEqual({ row: 9, col: 2 });
  });
});

describe('setInput 窗口（1.2.8 M7）', () => {
  it('超出 inputHeight 时保尾丢头，光标行同步换算', () => {
    const { writer, vt, delta } = makeWriter(20, 10);
    writer.enter();
    writer.setChrome({ inputHeight: 2 });
    // 3 行内容、光标在最后一行——保头会把光标行裁出可视区。
    writer.setInput([span('p1'), span('p2'), span('❯ tail')], 2, 3);
    writer.flush();
    delta();
    const top0 = writer.layout().inputTop - 1; // 0-based
    expect(vt.line(top0)).toBe('p2'); // p1 被裁掉
    expect(vt.line(top0 + 1)).toBe('❯ tail');
    expect(vt.cursor).toEqual({ row: top0 + 1, col: 3 });
  });
});

describe('resize 高度夹取与挂起守卫（1.2.8 M8/M9）', () => {
  it('resize 后重新夹取 input 高度，不写出 ≤0 行号的 CUP', () => {
    const { writer, emitted } = makeWriter(40, 24);
    writer.enter();
    writer.setChrome({ inputHeight: 10 });
    writer.flush();
    writer.resize(40, 6); // 旧行为：inputHeight 不夹 → inputTop = -3
    const l = writer.layout();
    expect(l.inputHeight).toBe(4); // 6 - status(1) - output(1)
    expect(l.statusTop).toBeGreaterThanOrEqual(1);
    expect(l.inputTop).toBeGreaterThanOrEqual(1);
    // eslint-disable-next-line no-control-regex -- intentional ANSI CSI matching
    expect(emitted()).not.toMatch(/\x1b\[(0|-)\d*;/);
  });

  it('行高继续缩时 statusHeight 也被夹回', () => {
    const { writer } = makeWriter(40, 24);
    writer.setChrome({ statusHeight: 4, inputHeight: 10 });
    writer.resize(40, 6);
    let l = writer.layout();
    expect(l.statusHeight).toBe(4);
    expect(l.inputHeight).toBe(1); // 6 - 4 - 1
    expect(l.statusTop).toBe(2);
    writer.resize(40, 3);
    l = writer.layout();
    expect(l.statusHeight).toBe(1); // rows - 2
    expect(l.inputHeight).toBe(1);
    expect(l.inputTop).toBeGreaterThanOrEqual(1);
  });

  it('挂起期 resize 只记尺寸不写屏，resume 后按新尺寸重画', () => {
    const { writer, vt, delta, writes } = makeWriter(40, 10);
    writer.enter();
    writer.append(span('before'));
    writer.flush();
    delta();
    writer.exit(); // /attach 让出 TTY
    const base = writes();
    writer.resize(20, 8);
    expect(writes()).toBe(base); // 挂起期间没有清屏/重画
    expect(writer.layout().cols).toBe(20); // 但尺寸已记下
    writer.enter(); // resume：清屏 + 全量重画
    delta();
    expect(vt.line(0)).toBe('before');
    writer.exit();
    writer.dispose();
  });
});

describe('suspend/resume (/attach)', () => {
  it('exit() keeps the frame pump alive — enter() 后照样出帧', () => {
    const { writer, vt, delta } = makeWriter(60, 10);
    writer.enter();
    writer.append([{ text: 'before' }]);
    writer.flush();
    delta();
    expect(vt.line(0)).toBe('before');
    // /attach: exit → (child shell owns the TTY) → enter — 之后必须还能画。
    writer.exit();
    writer.enter();
    writer.append([{ text: 'after' }]);
    writer.flush();
    delta();
    expect(vt.line(1)).toBe('after');
    writer.exit();
    writer.dispose(); // final teardown kills the scheduler
  });
});

describe('styling', () => {  it('maps semantic colors to SGR at render time (content stays semantic)', () => {
    const { writer, vt, delta } = makeWriter(60, 10);
    writer.enter();
    writer.append([{ text: '✗ 工具被边界规则拒绝', style: { fg: 'red' } }]);
    writer.append([{ text: '⚙ env_exec · ✔ done', style: { fg: 'purple' } }]);
    writer.append([{ text: 'plain body' }]);
    writer.flush();
    delta();
    expect(vt.stylesOnRow(0)).toEqual(['31']); // red
    expect(vt.stylesOnRow(1)).toEqual(['35']); // purple
    expect(vt.stylesOnRow(2)).toEqual([]); // unstyled
  });

  it('resets styles between differently-styled spans on one row', () => {
    const { writer, vt, delta } = makeWriter(60, 10);
    writer.enter();
    writer.append([
      { text: '⏵ thought · 4s', style: { fg: 'faint' } },
      { text: ' tail' },
    ]);
    writer.flush();
    delta();
    expect(vt.stylesOnRow(0)).toEqual(['90']);
    expect(vt.styleAt(0, 14)).toBe(''); // ' tail' back to default
  });
});

describe('pure helpers', () => {
  it('wrapSpans breaks exact-width content without a trailing empty line', () => {
    const lines = wrapSpans([{ text: 'a'.repeat(10) }], 10);
    expect(lines).toHaveLength(1);
    expect(lines[0].map((s) => s.text).join('')).toBe('a'.repeat(10));
  });

  it('wrapSpans honours embedded newlines and drops control chars', () => {
    const lines = wrapSpans([{ text: 'ab\tcd\nef' }], 80);
    expect(lines.map((l) => l.map((s) => s.text).join(''))).toEqual([
      'abcd',
      'ef',
    ]);
  });

  it('wrapSpans merges adjacent same-style graphemes, splits on style change', () => {
    const lines = wrapSpans(
      [{ text: 'ab', style: { fg: 'red' } }, { text: 'cd' }],
      80,
    );
    expect(lines[0]).toEqual([
      { text: 'ab', style: { fg: 'red' } },
      { text: 'cd', style: undefined },
    ]);
  });

  it('truncateSegments cuts at the width without splitting wide chars', () => {
    const line = truncateSegments([{ text: 'ab你cd' }], 3); // 你(2) doesn't fit after ab
    expect(line.map((s) => s.text).join('')).toBe('ab');
  });

  it('overlayRight right-aligns the badge and truncates the base line', () => {
    const base = [{ text: 'x'.repeat(30) }];
    const badge = [{ text: ' ↓ 2 条新消息 ', style: { fg: 'amber' as const } }];
    const out = overlayRight(base, badge, 20);
    const text = out.map((s) => s.text).join('');
    expect(stringWidth(text)).toBe(20);
    expect(text.endsWith(' ↓ 2 条新消息 ')).toBe(true);
    expect(out[out.length - 1].style).toEqual({ fg: 'amber' });
  });
});

describe('chrome height change (1.1.9 P4)', () => {
  it('inputHeight 变化后输出区内容逐行不变、且不重画；status/input 照常重画', () => {
    const { writer, vt, delta } = makeWriter(40, 12); // 输出区 1-based 行 1..10
    writer.enter();
    for (let i = 1; i <= 8; i++) writer.append(span(`row${i}`));
    writer.setStatus([span('S')]);
    writer.setInput([span('❯ a')], 0, 3);
    writer.flush();
    delta();
    const before: string[] = [];
    for (let r = 0; r < 10; r++) before.push(vt.line(r));

    // 补全面板张开：input 1 → 3 行（输出区缩 2 行）。
    writer.setChrome({ inputHeight: 3 });
    writer.setInput([span('p1'), span('p2'), span('❯ a')], 2, 3);
    writer.flush();
    const d = delta();
    // 输出区 0..7 行（0-based）内容不变，且这 8 行一个字节都没重画。
    for (let r = 0; r < 8; r++) expect(vt.line(r)).toBe(before[r]);
    for (let row = 1; row <= 8; row++)
      expect(d).not.toContain(`\x1b[${row};1H`);
    // status 移到 1-based 第 9 行；input 占 10..12 行。
    expect(vt.line(8)).toBe('S');
    expect(vt.line(9)).toBe('p1');
    expect(vt.line(10)).toBe('p2');
    expect(vt.line(11)).toBe('❯ a');
    expect(vt.cursor).toEqual({ row: 11, col: 3 });

    // 面板收起：input 3 → 1 行（输出区长回 10 行），新暴露的行要重画。
    writer.setChrome({ inputHeight: 1 });
    writer.setInput([span('❯ a')], 0, 3);
    writer.flush();
    delta();
    for (let r = 0; r < 10; r++) expect(vt.line(r)).toBe(before[r]);
    expect(vt.line(10)).toBe('S');
    expect(vt.line(11)).toBe('❯ a');
    expect(vt.cursor).toEqual({ row: 11, col: 3 });
  });

  it('setChrome 不再同步 flush：高度变化走 16ms 合帧', () => {
    const { writer, timer, writes } = makeWriter(40, 12);
    writer.enter();
    writer.append(span('x'));
    writer.flush();
    const base = writes();
    writer.setChrome({ inputHeight: 2 });
    expect(writes()).toBe(base); // 没有同步上屏
    expect(timer.pending).toBe(1); // 合并为一帧
    timer.runAll();
    expect(writes()).toBe(base + 1);
  });
});

describe('streaming incremental wrap (1.1.9 P1)', () => {
  it('chunked updateRow 与一次性全文上屏逐行一致（含 CJK/emoji/多 style）', () => {
    const final = [
      { text: '## 标题', style: { fg: 'cyan' as const, bold: true } },
      { text: '\n' },
      { text: '正文 ' },
      { text: 'code', style: { fg: 'purple' as const } },
      { text: ' 混排 ✈️👩‍💻🎯 中文宽字符折行压力测试，长度足够跨越多行 visual line。' },
      { text: '\n' },
      { text: '尾部', style: { fg: 'amber' as const } },
    ];
    const total = final.map((s) => s.text).join('');
    const width = 20;

    const a = makeWriter(width, 30);
    a.writer.enter();
    // 码元级 7B chunk 流式（允许切断簇/代理对），镜像 app 的 flatten 后单 span 序列。
    let text = '';
    for (let i = 0; i < total.length; i += 7) {
      text = total.slice(0, i + 7);
      const spans = overlayStyles(text); // 重新生成整段 spans（模拟 markdown 重渲染）
      if (!a.writer.updateRow('s', spans)) a.writer.append(spans, { id: 's' });
      a.writer.flush();
    }
    a.delta();

    const b = makeWriter(width, 30);
    b.writer.enter();
    b.writer.append(overlayStyles(total), { id: 's' });
    b.writer.flush();
    b.delta();

    for (let r = 0; r < 28; r++) expect(a.vt.line(r)).toBe(b.vt.line(r));

    // 按固定样式边界把 text 切回 spans（与 final 的 span/样式结构一致）。
    function overlayStyles(t: string) {
      const out: { text: string; style?: (typeof final)[number]['style'] }[] = [];
      let rest = 0;
      for (const seg of final) {
        const take = Math.min(seg.text.length, Math.max(0, t.length - rest));
        if (take > 0) out.push({ text: seg.text.slice(0, take), style: seg.style });
        rest += seg.text.length;
      }
      return out;
    }
  });
});
