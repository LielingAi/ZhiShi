import type { SessionMessage } from '../types/session';

export const CLIENT_MESSAGE_INLINE_MAX_BYTES = 256 * 1024;
const PREVIEW_HEAD_BYTES = 24 * 1024;
const PREVIEW_TAIL_BYTES = 8 * 1024;
const MAX_JSON_SHRINK_DEPTH = 8;

interface StructuredShrinkLimits {
  textBytes: number;
  thinkingBytes: number;
  toolStringBytes: number;
  parsedInputStringBytes: number;
  rawToolStringBytes: number;
  jsonArrayItems: number;
  omitDuplicateInput: boolean;
  minimalToolDetails: boolean;
}

const STRUCTURED_SHRINK_PASSES: StructuredShrinkLimits[] = [
  {
    textBytes: 32 * 1024,
    thinkingBytes: 8 * 1024,
    toolStringBytes: 2 * 1024,
    parsedInputStringBytes: 2 * 1024,
    rawToolStringBytes: 4 * 1024,
    jsonArrayItems: 80,
    omitDuplicateInput: true,
    minimalToolDetails: false,
  },
  {
    textBytes: 12 * 1024,
    thinkingBytes: 2 * 1024,
    toolStringBytes: 768,
    parsedInputStringBytes: 768,
    rawToolStringBytes: 1024,
    jsonArrayItems: 40,
    omitDuplicateInput: true,
    minimalToolDetails: false,
  },
  {
    textBytes: 4 * 1024,
    thinkingBytes: 1024,
    toolStringBytes: 256,
    parsedInputStringBytes: 256,
    rawToolStringBytes: 384,
    jsonArrayItems: 20,
    omitDuplicateInput: true,
    minimalToolDetails: false,
  },
  {
    textBytes: 2 * 1024,
    thinkingBytes: 512,
    toolStringBytes: 192,
    parsedInputStringBytes: 192,
    rawToolStringBytes: 256,
    jsonArrayItems: 12,
    omitDuplicateInput: true,
    minimalToolDetails: true,
  },
];

function utf8Size(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function sliceUtf8(value: string, maxBytes: number, fromEnd = false): string {
  if (maxBytes <= 0 || value.length === 0) return '';
  if (utf8Size(value) <= maxBytes) return value;

  let lo = 0;
  let hi = value.length;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = fromEnd ? value.slice(value.length - mid) : value.slice(0, mid);
    if (utf8Size(candidate) <= maxBytes) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return fromEnd ? value.slice(value.length - best) : value.slice(0, best);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function truncateStringForHistory(value: string, maxBytes: number): string {
  const size = utf8Size(value);
  if (size <= maxBytes) return value;

  const marker = `\n\n... [history display truncated: original ${formatBytes(size)}; full content is preserved in the local session file]`;
  const markerBytes = utf8Size(marker);
  const headBytes = Math.max(0, maxBytes - markerBytes);
  return `${sliceUtf8(value, headBytes)}${marker}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStructuredBlockArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((block) => isRecord(block) && typeof block.type === 'string');
}

function parseStructuredBlocks(content: string): Record<string, unknown>[] | null {
  if (!content.startsWith('[') || !content.includes('"type"')) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    return isStructuredBlockArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractTextPreview(content: string, maxLen: number): string {
  const blocks = parseStructuredBlocks(content);
  if (blocks) {
    return blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('')
      .slice(0, maxLen);
  }
  return content.slice(0, maxLen);
}

function stripSystemReminderPrefix(text: string): string | null {
  if (text.includes('<HEARTBEAT>') || text.includes('<MEMORY_UPDATE>')) {
    return null;
  }
  if (!text.startsWith('<system-reminder>')) {
    return text;
  }

  const closeTag = '</system-reminder>';
  const closeIdx = text.indexOf(closeTag);
  if (closeIdx < 0) return null;

  const tail = text.slice(closeIdx + closeTag.length).trim();
  if (tail) return tail;

  const inner = text.slice('<system-reminder>'.length, closeIdx).trim();
  if (!inner.includes('<CRON_TASK>')) return null;

  const withoutCronTags = inner.replace(/<\/?CRON_TASK>/g, ' ');
  return withoutCronTags
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?? null;
}

export function resolveLastRealUserMessagePreview(
  messages: Pick<SessionMessage, 'role' | 'content'>[],
  maxLen = 60,
): { found: boolean; preview?: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const visibleText = stripSystemReminderPrefix(msg.content);
    if (visibleText === null) continue;
    return {
      found: true,
      preview: extractTextPreview(visibleText, maxLen) || undefined,
    };
  }

  return { found: false };
}

function shrinkJsonValueForHistory(value: unknown, maxStringBytes: number, maxArrayItems: number, depth = 0): unknown {
  if (typeof value === 'string') {
    return truncateStringForHistory(value, maxStringBytes);
  }
  if (typeof value !== 'object' || value === null) return value;

  if (depth >= MAX_JSON_SHRINK_DEPTH) {
    return '[history display truncated: nested value too deep; full content is preserved in the local session file]';
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, maxArrayItems)
      .map((item) => shrinkJsonValueForHistory(item, maxStringBytes, maxArrayItems, depth + 1));
    if (value.length > maxArrayItems) {
      items.push(`[history display truncated: omitted ${value.length - maxArrayItems} array items]`);
    }
    return items;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = shrinkJsonValueForHistory(child, maxStringBytes, maxArrayItems, depth + 1);
  }
  return output;
}

function shrinkJsonStringForHistory(value: string, maxStringBytes: number, maxArrayItems: number, rawStringBytes: number): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    return JSON.stringify(shrinkJsonValueForHistory(parsed, maxStringBytes, maxArrayItems), null, 2);
  } catch {
    return truncateStringForHistory(value, rawStringBytes);
  }
}

function shrinkToolForHistory(tool: Record<string, unknown>, limits: StructuredShrinkLimits): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(tool)) {
    if (limits.minimalToolDetails && (key === 'input' || key === 'parsedInput' || key === 'inputJson')) {
      continue;
    }

    if (limits.omitDuplicateInput && key === 'input' && typeof tool.inputJson === 'string') {
      continue;
    }

    if (key === 'result' || key === 'inputJson') {
      output[key] = typeof value === 'string'
        ? shrinkJsonStringForHistory(value, limits.toolStringBytes, limits.jsonArrayItems, limits.rawToolStringBytes)
        : shrinkJsonValueForHistory(value, limits.toolStringBytes, limits.jsonArrayItems);
      continue;
    }

    if (key === 'parsedInput' || key === 'input' || key === 'subagentCalls') {
      output[key] = shrinkJsonValueForHistory(value, limits.parsedInputStringBytes, limits.jsonArrayItems);
      continue;
    }

    if (typeof value === 'string') {
      output[key] = truncateStringForHistory(value, limits.rawToolStringBytes);
    } else if (typeof value === 'object' && value !== null) {
      output[key] = shrinkJsonValueForHistory(value, limits.toolStringBytes, limits.jsonArrayItems);
    } else {
      output[key] = value;
    }
  }

  return output;
}

function shrinkStructuredBlocksForHistory(
  blocks: Record<string, unknown>[],
  limits: StructuredShrinkLimits,
): Record<string, unknown>[] {
  return blocks.map((block) => {
    const output: Record<string, unknown> = { ...block };

    if (typeof output.text === 'string') {
      output.text = truncateStringForHistory(output.text, limits.textBytes);
    }
    if (typeof output.thinking === 'string') {
      output.thinking = truncateStringForHistory(output.thinking, limits.thinkingBytes);
    }
    if (isRecord(output.tool)) {
      output.tool = shrinkToolForHistory(output.tool, limits);
    }

    return output;
  });
}

function shrinkStructuredContentForClient(content: string): string | null {
  const blocks = parseStructuredBlocks(content);
  if (!blocks) return null;

  for (const limits of STRUCTURED_SHRINK_PASSES) {
    const shrunk = JSON.stringify(shrinkStructuredBlocksForHistory(blocks, limits));
    if (utf8Size(shrunk) <= CLIENT_MESSAGE_INLINE_MAX_BYTES) {
      return shrunk;
    }
  }

  const minimalBlocks = blocks.map((block) => {
    const output: Record<string, unknown> = { type: block.type };
    if (typeof block.text === 'string') {
      output.text = truncateStringForHistory(block.text, 1024);
    }
    if (typeof block.thinking === 'string') {
      output.thinking = truncateStringForHistory(block.thinking, 512);
      output.isComplete = block.isComplete;
      output.thinkingDurationMs = block.thinkingDurationMs;
    }
    if (isRecord(block.tool)) {
      const tool: Record<string, unknown> = {};
      for (const key of ['id', 'name', 'isLoading', 'isError', 'isStopped', 'isFailed', 'streamIndex']) {
        if (key in block.tool) tool[key] = block.tool[key];
      }
      if (typeof block.tool.result === 'string') {
        tool.result = truncateStringForHistory(block.tool.result, 256);
      }
      output.tool = tool;
    }
    return output;
  });

  const minimalStr = JSON.stringify(minimalBlocks);
  if (utf8Size(minimalStr) <= CLIENT_MESSAGE_INLINE_MAX_BYTES) return minimalStr;

  // Extreme block COUNT (e.g. a Codex sub-agent fan-out turn with 700+ tool
  // blocks): even minimal per-block content sums above the cap. Drop a middle
  // window of blocks — keep a leading + trailing slice plus an omission marker —
  // so the result stays a structured block ARRAY AND is guaranteed under cap.
  // Without this final guard, callers would ship an over-cap payload and the
  // SSE/IPC transport would break exactly as the original bug did.
  const capped = capBlockCountForHistory(minimalBlocks, CLIENT_MESSAGE_INLINE_MAX_BYTES);
  const cappedStr = JSON.stringify(capped);
  // Defensive: if even the capped window somehow exceeds the cap, return null so
  // the caller falls back to the plain head/tail preview (always under cap).
  return utf8Size(cappedStr) <= CLIENT_MESSAGE_INLINE_MAX_BYTES ? cappedStr : null;
}

/**
 * Keep a leading + trailing slice of already-minimal blocks that fits under
 * `maxBytes`, with a marker block recording how many were omitted. Greedy from
 * both ends against a 90% budget (leaves headroom for the marker + array commas).
 */
function capBlockCountForHistory(
  blocks: Record<string, unknown>[],
  maxBytes: number,
): Record<string, unknown>[] {
  const budget = Math.floor(maxBytes * 0.9);
  const sizeOf = (b: Record<string, unknown>) => utf8Size(JSON.stringify(b)) + 1; // +1 for the comma
  const head: Record<string, unknown>[] = [];
  const tail: Record<string, unknown>[] = [];
  let used = 2; // the surrounding []
  let lo = 0;
  let hi = blocks.length - 1;
  let takeHead = true;
  while (lo <= hi) {
    const block = takeHead ? blocks[lo] : blocks[hi];
    const cost = sizeOf(block);
    if (used + cost > budget) break;
    used += cost;
    if (takeHead) { head.push(block); lo++; } else { tail.unshift(block); hi--; }
    takeHead = !takeHead; // alternate so we keep both the start and the end of the turn
  }
  const omitted = hi - lo + 1;
  if (omitted <= 0) return [...head, ...tail];
  const marker: Record<string, unknown> = {
    type: 'text',
    text: `\n... [history display truncated: ${omitted} of ${blocks.length} blocks omitted to fit the UI; full content is preserved in the local session file] ...\n`,
  };
  return [...head, marker, ...tail];
}

function shrinkPlainContentForClient(content: string, size: number): string {
  const head = sliceUtf8(content, PREVIEW_HEAD_BYTES);
  const tail = sliceUtf8(content, PREVIEW_TAIL_BYTES, true);
  const omitted = Math.max(0, size - utf8Size(head) - utf8Size(tail));
  return [
    `This history message is too large for inline display and was truncated for the UI (original ${formatBytes(size)}, inline limit ${formatBytes(CLIENT_MESSAGE_INLINE_MAX_BYTES)}).`,
    'The complete content is still preserved in the local session file. Showing only the beginning and end avoids freezing history loading.',
    '',
    '--- Beginning ---',
    head,
    '',
    `--- Omitted ${formatBytes(omitted)} ---`,
    '',
    '--- End ---',
    tail,
  ].join('\n');
}

export function shrinkSessionMessageForClient(message: SessionMessage): SessionMessage {
  const size = utf8Size(message.content);
  if (size <= CLIENT_MESSAGE_INLINE_MAX_BYTES) return message;

  const structuredContent = shrinkStructuredContentForClient(message.content);
  const content = structuredContent ?? shrinkPlainContentForClient(message.content, size);

  return { ...message, content };
}

export function shrinkSessionMessagesForClient(messages: SessionMessage[]): SessionMessage[] {
  return messages.map(shrinkSessionMessageForClient);
}

/**
 * Shrink a `/chat/stream` replay message's `content` to the same
 * CLIENT_MESSAGE_INLINE_MAX_BYTES the REST `/sessions/:id` path enforces, while
 * PRESERVING the shape: a structured `ContentBlock[]` stays an array (so the
 * renderer keeps its block UI), a plain string stays a string.
 *
 * Why this exists: the cold-restore SSE replay (`chat:message-replay`) ships each
 * persisted message in full. A multi-MB single message — e.g. a Codex sub-agent
 * fan-out turn with hundreds of tool blocks — would cross the SSE → Rust proxy →
 * Tauri-IPC boundary as ONE oversized event, breaking the stream so every later
 * message is lost and restored history truncates at the first oversized message.
 * The REST path already caps via `shrinkSessionMessageForClient` (string-shaped);
 * this is the shape-preserving sibling for the replay path.
 */
export function shrinkReplayContentForClient(content: string | unknown[]): string | unknown[] {
  let serialized: string;
  try {
    serialized = typeof content === 'string' ? content : JSON.stringify(content);
  } catch {
    return content; // un-serializable (shouldn't happen for stored content) — leave as-is
  }
  if (utf8Size(serialized) <= CLIENT_MESSAGE_INLINE_MAX_BYTES) return content;

  if (Array.isArray(content)) {
    // Structured blocks: reuse the string shrinker (progressive passes + minimal
    // fallback), then re-parse so the renderer still receives a block ARRAY.
    const shrunk = shrinkStructuredContentForClient(serialized);
    if (shrunk !== null) {
      try {
        const reparsed = JSON.parse(shrunk) as unknown;
        if (Array.isArray(reparsed)) return reparsed;
      } catch { /* fall through to plain preview */ }
    }
    return shrinkPlainContentForClient(serialized, utf8Size(serialized));
  }

  // Plain string content (or structured-as-string): mirror shrinkSessionMessageForClient.
  return shrinkStructuredContentForClient(content) ?? shrinkPlainContentForClient(content, utf8Size(content));
}
