/**
 * tool-block (plan §2.3). Two-state tool card:
 *
 *   folded (default) — two lines, claude-code rhythm:
 *     ⏺ ⚙ name(arg 摘要…)           ← purple bold name, dim args, state mark
 *       ⎿ ✔ 端口 80 开放 · 1.2s      ← signal line (green 成果 / red 失败 / muted)
 *
 *   expanded (Ctrl+O) — header + full output, WINDOWED around a scroll offset
 *   so a 10k-line nmap dump never floods the scrollback; ↑↓ move the window.
 *
 * Collapse-by-default is the 附加律: process noise stays off-screen until the
 * operator explicitly asks; only the load-bearing signal survives folded.
 */

import type { Span } from '../row-buffer';
import type { SemanticColor } from '../style';
import type { ToolBlock } from '../types';
import { takeWidth } from '../chrome';

export function renderToolFolded(block: ToolBlock, width: number): Span[][] {
  const tone: SemanticColor = block.state === 'fail' ? 'red' : 'purple';
  const args = block.argsSummary ? `(${takeWidth(block.argsSummary, Math.max(8, width - block.name.length - 8))})` : '';
  const stateMark = block.state === 'running' ? ' …' : '';
  const head: Span[] = [
    { text: '⏺ ', style: { fg: tone } },
    { text: `⚙ ${block.name}`, style: { fg: tone, bold: true } },
    { text: args, style: { fg: 'muted' } },
    { text: stateMark, style: { fg: 'muted' } },
  ];
  if (block.state === 'running') return [head];

  const signalTone: SemanticColor =
    block.state === 'fail' ? 'red' : /命中|开放|✔|flag/i.test(block.signal ?? '') ? 'green' : 'muted';
  const mark = block.state === 'fail' ? '✗' : '✔';
  const elapsed = block.elapsedMs ? ` · ${(block.elapsedMs / 1000).toFixed(1)}s` : '';
  const summary = block.signal || '完成';
  const tail: Span[] = [
    { text: '  ⎿ ', style: { fg: 'faint' } },
    { text: `${mark} `, style: { fg: signalTone } },
    { text: takeWidth(`${summary}${elapsed}`, Math.max(8, width - 8)), style: { fg: signalTone } },
  ];
  return [head, tail];
}

export interface ExpandedView {
  lines: Span[][];
  /** Total output lines (for the scroll indicator + bounds). */
  total: number;
  /** First visible output line (0-based). */
  offset: number;
}

/**
 * Expanded card, windowed: `scrollOffset` selects the first visible output
 * line; `window` caps how many render. Header/footer pin around the window.
 */
export function renderToolExpanded(
  block: ToolBlock,
  width: number,
  scrollOffset: number,
  window = 14,
): ExpandedView {
  const tone: SemanticColor = block.state === 'fail' ? 'red' : 'purple';
  const outLines = (block.output ?? '').split('\n');
  const total = outLines.length;
  const offset = Math.max(0, Math.min(scrollOffset, Math.max(0, total - 1)));
  const visible = outLines.slice(offset, offset + window);

  const lines: Span[][] = [
    [
      { text: '⏺ ', style: { fg: tone } },
      { text: `⚙ ${block.name}`, style: { fg: tone, bold: true } },
      { text: `(${block.argsSummary})`, style: { fg: 'muted' } },
      { text: `   ${offset + 1}–${Math.min(offset + window, total)}/${total} 行 · Esc 收起`, style: { fg: 'faint' } },
    ],
  ];
  for (const cl of visible) {
    lines.push([
      { text: '  │ ', style: { fg: 'faint' } },
      { text: takeWidth(cl, Math.max(8, width - 5)), style: { fg: 'text', bg: 'panel' } },
    ]);
  }
  if (block.signal) {
    lines.push([
      { text: '  ⎿ ', style: { fg: 'faint' } },
      { text: block.signal, style: { fg: block.state === 'fail' ? 'red' : 'green' } },
    ]);
  }
  return { lines, total, offset };
}
