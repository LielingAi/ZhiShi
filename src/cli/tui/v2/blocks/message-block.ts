/**
 * message-block (plan §2.3). Renders user/assistant blocks into styled spans.
 * Self-rendered Markdown SUBSET (no deps): headings, **bold**, `inline code`,
 * fenced code blocks (purple bar + panel surface), lists, paragraphs.
 *
 * Layout rhythm: a blank row precedes every user message and every assistant
 * message (except at stream head) — the eye needs the gap to parse turns.
 * The streaming caret is a RENDER concern: it is appended to the last visual
 * line, never spliced into the source text (splicing corrupted code fences).
 */

import type { Span } from '../row-buffer';
import type { AssistantBlock, UserBlock } from '../types';

const USER_MARK: Span = { text: '❯ ', style: { fg: 'amber', bold: true } };
const ASSISTANT_MARK: Span = { text: '⏺ ', style: { fg: 'text' } };
const CARET: Span = { text: '▍', style: { fg: 'faint' } };

export function renderUser(block: UserBlock, first: boolean): Span[][] {
  const body = renderMarkdown(block.text);
  const out = prefixLines(body, USER_MARK);
  // 用户消息全行浅 panel 底——「你说的」与「agent 答的」一眼可分。
  const paneled = out.map((ln) =>
    ln.map((s) => ({ ...s, style: { ...s.style, bg: 'panel' as const } })),
  );
  return first ? paneled : [[], ...paneled];
}

export function renderAssistant(
  block: AssistantBlock,
  streaming: boolean,
  first: boolean,
): Span[][] {
  const body = renderMarkdown(block.text);
  if (streaming && body.length > 0) body[body.length - 1] = [...body[body.length - 1], CARET];
  const out = prefixLines(body, ASSISTANT_MARK);
  return first ? out : [[], ...out];
}

// ---------------------------------------------------------------------------
// Tiny markdown subset
// ---------------------------------------------------------------------------

export function renderMarkdown(src: string): Span[][] {
  const out: Span[][] = [];
  const lines = src.split('\n');
  let inCode = false;
  let codeBuf: string[] = [];

  const flushCode = (): void => {
    for (const cl of codeBuf) {
      out.push([
        { text: '│ ', style: { fg: 'purple', dim: true } },
        { text: cl, style: { fg: 'text', bg: 'panel' } },
      ]);
    }
    codeBuf = [];
  };

  for (const raw of lines) {
    if (raw.startsWith('```')) {
      if (inCode) flushCode();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }
    const heading = raw.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      out.push([{ text: heading[2], style: { fg: 'cyan', bold: true } }]);
      continue;
    }
    if (/^\s*[-*]\s+/.test(raw)) {
      const m = raw.match(/^\s*[-*]\s+(.*)$/);
      out.push([{ text: '  • ', style: { fg: 'muted' } }, ...renderInline(m ? m[1] : raw)]);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(raw)) {
      const m = raw.match(/^(\s*\d+\.)\s+(.*)$/);
      out.push([{ text: `${m![1]} `, style: { fg: 'muted' } }, ...renderInline(m![2])]);
      continue;
    }
    if (raw.trim() === '') {
      out.push([]);
      continue;
    }
    out.push(renderInline(raw));
  }
  flushCode();
  if (out.length === 0) out.push([]);
  return out;
}

/** Inline: `code` in purple, **bold** in bold, the rest as body text. */
function renderInline(s: string): Span[] {
  const segs: Span[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) segs.push({ text: s.slice(last, m.index) });
    if (m[1] !== undefined) segs.push({ text: m[1], style: { fg: 'purple' } });
    else segs.push({ text: m[2], style: { bold: true } });
    last = m.index + m[0].length;
  }
  if (last < s.length) segs.push({ text: s.slice(last) });
  return segs;
}

/** Hang every line under the row glyph; blank lines stay blank. */
function prefixLines(lines: Span[][], lead: Span): Span[][] {
  const indent: Span = { text: '  ' };
  return lines.map((ln, i) => (i === 0 ? [lead, ...ln] : ln.length === 0 ? [] : [indent, ...ln]));
}
