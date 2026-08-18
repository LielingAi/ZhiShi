/**
 * chrome unit tests — the visual system: status bar, input box (wrap +
 * windowing + cursor), overlay panel scroll window, box width math (CJK).
 */

import { describe, it, expect } from 'vitest';
import { stringWidth } from '../ansi';
import {
  composeStatusBar,
  composeInputBox,
  composeOverlay,
  composeModalBox,
  overlayRow,
  boxLine,
  SPINNER_FRAMES,
  type StatusBarState,
} from './chrome';
import type { Span } from './row-buffer';

function flatText(spans: Span[]): string {
  return spans.map((s) => s.text).join('');
}

function barState(patch: Partial<StatusBarState> = {}): StatusBarState {
  return {
    phase: 'idle',
    queueDepth: 0,
    contextPct: 0,
    hint: 'Ctrl+L 帮助',
    ...patch,
  };
}

describe('composeStatusBar', () => {
  it('fills the full width (panel surface) and keeps the hint', () => {
    const bar = composeStatusBar(barState({ envName: 'pwn-vm', envKind: 'vm', model: 'k2' }), 60, 0);
    expect(stringWidth(flatText(bar))).toBe(60);
    expect(flatText(bar)).toContain('pwn-vm');
    expect(flatText(bar)).toContain('Ctrl+L 帮助');
    expect(bar.every((s) => s.style?.bg === 'panel')).toBe(true);
  });

  it('shows spinner frame + elapsed seconds while running', () => {
    const bar = composeStatusBar(barState({ phase: 'running', elapsedMs: 12_300 }), 60, 3);
    expect(flatText(bar)).toContain(SPINNER_FRAMES[3]);
    expect(flatText(bar)).toContain('12s');
  });

  it('drops the middle segments (model → ctx) before touching the hint on narrow screens', () => {
    const bar = composeStatusBar(
      barState({ phase: 'running', elapsedMs: 1000, model: 'very-long-model-name', contextPct: 42, hint: 'Esc 中断' }),
      30,
      0,
    );
    const text = flatText(bar);
    expect(text).toContain('Esc 中断');
    expect(text).not.toContain('very-long-model-name');
  });
});

describe('composeInputBox', () => {
  const lead: Span[] = [{ text: 'vm ❯ ', style: { fg: 'cyan' } }];

  it('wraps a long line instead of truncating it into invisibility', () => {
    const box = composeInputBox({
      lead,
      cols: 20,
      lines: ['x'.repeat(40)],
      cursorLine: 0,
      cursorCol: 40,
    });
    // inner = 16 cells, lead = 5 → first row fits 11 chars, then 11/row.
    const contentRows = box.rows.length - 2; // minus borders
    expect(contentRows).toBeGreaterThan(1);
    const all = box.rows.map(flatText).join('');
    expect(all.replace(/[╭╮╰╯│─\s]/g, '').replace('vm❯', '')).toBe('x'.repeat(40));
  });

  it('places the cursor on the correct wrapped row and column', () => {
    const box = composeInputBox({
      lead,
      cols: 20,
      lines: ['x'.repeat(40)],
      cursorLine: 0,
      cursorCol: 40,
    });
    // Cursor at end → last content row; col = 2 (border) + 5 (lead indent) + remainder.
    const lastContentRow = box.rows.length - 2;
    expect(box.cursorRow).toBe(lastContentRow);
    expect(box.cursorCol).toBe(2 + 5 + (40 - 33)); // 11*3=33 chars in first 3 rows
  });

  it('windows the content around the cursor beyond maxContentRows', () => {
    const box = composeInputBox({
      lead,
      cols: 20,
      lines: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      cursorLine: 9,
      cursorCol: 1,
      maxContentRows: 4,
    });
    expect(box.rows.length).toBe(4 + 2);
    expect(box.cursorRow).toBe(4); // cursor on the last visible content row
    expect(flatText(box.rows[box.cursorRow])).toContain('j');
  });

  it('is CJK-accurate: a Chinese line occupies double cells', () => {
    const box = composeInputBox({
      lead,
      cols: 20,
      lines: ['你好世界你好世界你好'], // 9 chars × 2 cells = 18 cells
      cursorLine: 0,
      cursorCol: 9,
    });
    expect(box.rows.length - 2).toBeGreaterThan(1); // wrapped
  });
});

describe('composeOverlay', () => {
  it('keeps the selected item visible inside the scroll window', () => {
    const items = Array.from({ length: 20 }, (_, i) => overlayRow(`item-${i}`, 'd', i === 15, 60));
    const rows = composeOverlay('测试', items, 15, 60, 8);
    const text = rows.map(flatText).join('\n');
    expect(text).toContain('item-15');
    expect(rows.length).toBeLessThanOrEqual(8);
  });

  it('marks the selected row with the panel surface', () => {
    const items = [overlayRow('a', '', true, 60), overlayRow('b', '', false, 60)];
    const rows = composeOverlay('t', items, 0, 60, 8);
    const selRow = rows[1]; // after boxTop
    expect(selRow.some((s) => s.style?.bg === 'panel')).toBe(true);
    expect(rows[2].some((s) => s.style?.bg === 'panel')).toBe(false);
  });
});

describe('box math', () => {
  it('boxLine pads CJK content to the exact inner width', () => {
    const line = boxLine([{ text: '你好' }], 20);
    expect(stringWidth(flatText(line))).toBe(20);
  });

  it('composeModalBox draws a red box without width overflow', () => {
    const rows = composeModalBox({ title: '写宿主', objects: ['/etc/passwd', '中文路径/文件'] }, 60);
    for (const r of rows) {
      expect(stringWidth(flatText(r))).toBeLessThanOrEqual(60);
    }
    expect(rows[0].every((s) => s.style?.fg === 'red')).toBe(true);
  });
});
