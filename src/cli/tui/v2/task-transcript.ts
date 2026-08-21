/**
 * 1.1.10(A′)— /tasks 详情页的子代理 transcript 只读视图。
 *
 * 数据源:GET /api/loop-session/messages?loopSessionId=<id> →
 * { success, transcript: { entries, truncated, totalMessages, meta } }
 * (服务端 src/server/loop/transcript.ts 的结构化契约)。这里做两件事:
 *
 *   narrowTranscript       把 unknown 响应窄化成视图模型(失败/404 → null,
 *                          调用方回退 summary 视图)——线协议边界不许 any。
 *   renderTranscriptItems  条目流 → overlay 面板行:样式向既有 tool 卡
 *                          (tool-block.ts)与消息块(message-block.ts)的
 *                          span 风格靠拢,不发明新色系。
 */

import type { Span } from './row-buffer';
import { stringWidth } from '../ansi';
import { takeWidth, type OverlayItem } from './chrome';

export interface TranscriptToolCall {
  name: string;
  argsSummary: string;
}

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'tool';
  text?: string;
  toolCalls?: TranscriptToolCall[];
  toolName?: string;
  isError?: boolean;
}

export interface TranscriptView {
  entries: TranscriptEntry[];
  /** true = 服务端大小护栏截断,尾部消息未包含。 */
  truncated: boolean;
  /** 会话文件里的消息总数(截断前)。 */
  totalMessages: number;
}

// ---------------------------------------------------------------------------
// Wire narrowing (unknown → TranscriptView | null)
// ---------------------------------------------------------------------------

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function narrowEntry(v: unknown): TranscriptEntry | null {
  const e = rec(v);
  const role = str(e.role);
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') return null;
  const toolCalls = Array.isArray(e.toolCalls)
    ? e.toolCalls
        .map((tc): TranscriptToolCall | null => {
          const t = rec(tc);
          const name = str(t.name);
          if (!name) return null;
          return { name, argsSummary: str(t.argsSummary) ?? '' };
        })
        .filter((tc): tc is TranscriptToolCall => tc !== null)
    : undefined;
  return {
    role,
    ...(str(e.text) !== undefined ? { text: str(e.text) } : {}),
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    ...(str(e.toolName) !== undefined ? { toolName: str(e.toolName) } : {}),
    ...(e.isError === true ? { isError: true } : {}),
  };
}

/**
 * 端点响应 → 视图模型。success:false(404/400)或 transcript 缺失 → null。
 * 条目逐条窄化,坏条目丢弃而不是整单失败(审计场景要的是能看多少看多少)。
 */
export function narrowTranscript(res: unknown): TranscriptView | null {
  const r = rec(res);
  if (r.success === false) return null;
  const t = rec(r.transcript);
  if (!Array.isArray(t.entries)) return null;
  const entries = t.entries
    .map(narrowEntry)
    .filter((e): e is TranscriptEntry => e !== null);
  const totalMessages = typeof t.totalMessages === 'number' ? t.totalMessages : entries.length;
  return { entries, truncated: t.truncated === true, totalMessages };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Wrap one detail line to the panel inner width (grapheme-safe, CJK-aware).
 * (app.ts 的 summary 详情行也用同一个。)
 */
export function wrapPanelLine(text: string, width: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const chunk = takeWidth(rest, width);
    if (!chunk) break;
    out.push(chunk);
    rest = rest.slice(chunk.length);
  }
  return out.length > 0 ? out : [''];
}

function item(spans: Span[]): OverlayItem {
  return { spans, selectable: false };
}

/** 多行文本 → 行组:首行带 lead span,续行悬挂缩进到 lead 边缘。 */
function textItems(text: string, width: number, lead: Span, textStyle: Span['style']): OverlayItem[] {
  const out: OverlayItem[] = [];
  const indentW = Math.max(1, stringWidth(lead.text));
  const indent: Span = { text: ' '.repeat(indentW) };
  const bodyWidth = Math.max(8, width - indentW);
  const physical = text.split('\n');
  for (let pi = 0; pi < physical.length; pi++) {
    const wrapped = wrapPanelLine(physical[pi], bodyWidth);
    for (let wi = 0; wi < wrapped.length; wi++) {
      const isFirst = pi === 0 && wi === 0;
      out.push(item([isFirst ? lead : indent, { text: wrapped[wi], style: textStyle }]));
    }
  }
  if (out.length === 0) out.push(item([lead]));
  return out;
}

/**
 * transcript → 面板行。截断时顶部钉一行「已截断（共 N 条）」。
 * 样式映射(全部复用既有色位):
 *   user       → ❯ amber bold(同 message-block USER_MARK)
 *   assistant  → ⏺ text(同 ASSISTANT_MARK)
 *   toolCall   → ⏺ ⚙ name purple bold + (argsSummary) muted(同 tool 卡头)
 *   tool 结果  → ⎿ ✔ muted / ✗ red(同 tool 卡尾行)
 */
export function renderTranscriptItems(t: TranscriptView, width: number): OverlayItem[] {
  const out: OverlayItem[] = [];
  if (t.truncated) {
    out.push(item([{ text: `已截断（共 ${t.totalMessages} 条）`, style: { fg: 'faint' } }]));
  }
  for (const e of t.entries) {
    if (e.role === 'user') {
      out.push(...textItems(e.text ?? '', width, { text: '❯ ', style: { fg: 'amber', bold: true } }, { fg: 'text' }));
      continue;
    }
    if (e.role === 'assistant') {
      if (e.text) {
        out.push(...textItems(e.text, width, { text: '⏺ ', style: { fg: 'text' } }, { fg: 'text' }));
      }
      for (const tc of e.toolCalls ?? []) {
        const args = tc.argsSummary ? `(${takeWidth(tc.argsSummary, Math.max(8, width - tc.name.length - 8))})` : '';
        out.push(item([
          { text: '⏺ ', style: { fg: 'purple' } },
          { text: `⚙ ${tc.name}`, style: { fg: 'purple', bold: true } },
          { text: args, style: { fg: 'muted' } },
        ]));
      }
      continue;
    }
    // role === 'tool':结果行,isError 标红(同 tool 卡 fail 尾行)。
    const mark = e.isError ? '✗' : '✔';
    const tone = e.isError ? 'red' : 'muted';
    out.push(...textItems(e.text ?? '', width, { text: `  ⎿ ${mark} `, style: { fg: tone } }, { fg: tone }));
  }
  if (out.length === 0) out.push(item([{ text: '（空会话）', style: { fg: 'faint' } }]));
  return out;
}
