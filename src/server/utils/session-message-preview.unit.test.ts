import { describe, expect, it } from 'vitest';

import {
  CLIENT_MESSAGE_INLINE_MAX_BYTES,
  resolveLastRealUserMessagePreview,
  shrinkSessionMessageForClient,
  shrinkReplayContentForClient,
} from './session-message-preview';
import type { SessionMessage } from '../types/session';

function msg(content: string): SessionMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content,
    timestamp: '2026-05-25T00:00:00.000Z',
  };
}

describe('session-message-preview', () => {
  it('keeps normal history messages unchanged by reference', () => {
    const input = msg('short message');
    expect(shrinkSessionMessageForClient(input)).toBe(input);
  });

  it('replaces oversized content with a bounded display preview', () => {
    const original = `HEAD-${'a'.repeat(CLIENT_MESSAGE_INLINE_MAX_BYTES)}-TAIL`;
    const output = shrinkSessionMessageForClient(msg(original));

    expect(output.content).not.toBe(original);
    expect(output.content).toContain('too large for inline display');
    expect(output.content).toContain('HEAD-');
    expect(output.content).toContain('-TAIL');
    expect(Buffer.byteLength(output.content, 'utf8')).toBeLessThan(80 * 1024);
  });

  it('keeps UTF-8 preview slices within budget without dropping the tail marker', () => {
    const original = `开头${'界'.repeat(CLIENT_MESSAGE_INLINE_MAX_BYTES)}结尾`;
    const output = shrinkSessionMessageForClient(msg(original));

    expect(output.content).toContain('开头');
    expect(output.content).toContain('结尾');
    expect(Buffer.byteLength(output.content, 'utf8')).toBeLessThan(90 * 1024);
  });

  it('preserves oversized structured assistant history as parseable content blocks', () => {
    const inputJson = JSON.stringify({
      command: 'npm test',
      cwd: '/tmp/project',
      large: 'input-'.repeat(20_000),
    }, null, 2);
    const resultJson = JSON.stringify({
      stdout: 'output-'.repeat(CLIENT_MESSAGE_INLINE_MAX_BYTES),
      stderr: '',
      exitCode: 0,
    }, null, 2);
    const original = JSON.stringify([
      {
        type: 'thinking',
        thinking: 'thought-'.repeat(20_000),
        isComplete: true,
      },
      {
        type: 'tool_use',
        tool: {
          id: 'call_1',
          name: 'Bash',
          input: JSON.parse(inputJson),
          inputJson,
          parsedInput: JSON.parse(inputJson),
          result: resultJson,
          isLoading: false,
        },
      },
      {
        type: 'text',
        text: 'final answer',
      },
    ]);

    const output = shrinkSessionMessageForClient(msg(original));

    expect(output.content).not.toBe(original);
    expect(output.content.startsWith('[')).toBe(true);
    expect(Buffer.byteLength(output.content, 'utf8')).toBeLessThan(CLIENT_MESSAGE_INLINE_MAX_BYTES);

    const parsed = JSON.parse(output.content) as Array<{
      type: string;
      thinking?: string;
      text?: string;
      tool?: {
        id?: string;
        name?: string;
        input?: unknown;
        inputJson?: string;
        parsedInput?: unknown;
        result?: string;
      };
    }>;
    expect(parsed.map((block) => block.type)).toEqual(['thinking', 'tool_use', 'text']);
    expect(parsed[0].thinking).toContain('history display truncated');
    expect(parsed[1].tool?.id).toBe('call_1');
    expect(parsed[1].tool?.name).toBe('Bash');
    expect(parsed[1].tool?.input).toBeUndefined();
    expect(parsed[1].tool?.inputJson).toBeDefined();
    expect(parsed[1].tool?.parsedInput).toBeDefined();
    expect(JSON.parse(parsed[1].tool?.result ?? '{}')).toMatchObject({
      stderr: '',
      exitCode: 0,
    });
    expect(JSON.parse(parsed[1].tool?.result ?? '{}').stdout).toContain('history display truncated');
    expect(parsed[2].text).toBe('final answer');
  });

  it('falls back to plain preview when oversized JSON-looking content is malformed', () => {
    const original = `[{"type":"text","text":"${'x'.repeat(CLIENT_MESSAGE_INLINE_MAX_BYTES)}"`;
    const output = shrinkSessionMessageForClient(msg(original));

    expect(output.content.startsWith('This history message is too large')).toBe(true);
    expect(output.content).toContain('--- Beginning ---');
    expect(() => JSON.parse(output.content)).toThrow();
  });

  it('extracts last real user preview instead of the trailing assistant response', () => {
    const result = resolveLastRealUserMessagePreview([
      { role: 'user', content: '用户真正的问题', id: 'u1', timestamp: 't1' } as SessionMessage,
      { role: 'assistant', content: '我会先处理这个问题', id: 'a1', timestamp: 't2' } as SessionMessage,
    ]);

    expect(result).toEqual({ found: true, preview: '用户真正的问题' });
  });

  it('skips pure system reminders but keeps mixed user-visible text', () => {
    const result = resolveLastRealUserMessagePreview([
      {
        role: 'user',
        content: '<system-reminder><HEARTBEAT>A schedule fired</HEARTBEAT></system-reminder>',
        id: 'system',
        timestamp: 't1',
      } as SessionMessage,
      {
        role: 'user',
        content: '<system-reminder>context</system-reminder>用户群聊消息',
        id: 'mixed',
        timestamp: 't2',
      } as SessionMessage,
      { role: 'assistant', content: 'assistant', id: 'a1', timestamp: 't3' } as SessionMessage,
    ]);

    expect(result).toEqual({ found: true, preview: '用户群聊消息' });
  });

  it('extracts the first non-empty cron task line from system reminders', () => {
    const result = resolveLastRealUserMessagePreview([
      {
        role: 'user',
        content: '<system-reminder>\n<CRON_TASK>\n\n执行任务：# GitHub Issue 自动化处理\n\n每 6 小时自动 triage\n</CRON_TASK>\n</system-reminder>',
        id: 'cron',
        timestamp: 't1',
      } as SessionMessage,
      { role: 'assistant', content: 'assistant', id: 'a1', timestamp: 't2' } as SessionMessage,
    ]);

    expect(result).toEqual({ found: true, preview: '执行任务：# GitHub Issue 自动化处理' });
  });

  // ── shrinkReplayContentForClient (PRD 0.2.27 — /chat/stream replay 256KB cap) ──
  describe('shrinkReplayContentForClient', () => {
    it('passes through small string content by reference', () => {
      const s = 'short reply';
      expect(shrinkReplayContentForClient(s)).toBe(s);
    });

    it('passes through small ContentBlock[] content by reference', () => {
      const blocks = [{ type: 'text', text: 'hi' }];
      expect(shrinkReplayContentForClient(blocks)).toBe(blocks);
    });

    it('shrinks an oversized ContentBlock[] but KEEPS the array shape (renderer needs blocks)', () => {
      // Mirrors a Codex sub-agent fan-out turn: many tool blocks with huge results.
      const blocks = Array.from({ length: 400 }, (_, i) => ({
        type: 'tool_use',
        tool: { id: `call_${i}`, name: 'Bash', result: 'output-'.repeat(2000), isLoading: false },
      }));
      const out = shrinkReplayContentForClient(blocks);

      expect(Array.isArray(out)).toBe(true); // shape preserved — NOT a JSON string
      const arr = out as Array<{ type: string; tool?: { id?: string; name?: string } }>;
      expect(arr[0].type).toBe('tool_use');
      expect(arr[0].tool?.name).toBe('Bash');
      // Whole serialized payload is now under the inline cap → safe to ship as one SSE event.
      expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(CLIENT_MESSAGE_INLINE_MAX_BYTES);
    });

    it('guarantees under-cap (array shape) even at extreme block counts where minimal blocks alone exceed the cap', () => {
      // 900 tool blocks: even the minimal per-block form (id/name/result≤256B) sums
      // > 256KB. This is the real 757-block Codex fan-out class that the first fix
      // pass missed (Codex review HIGH). Must still come back under cap AS AN ARRAY.
      const blocks = Array.from({ length: 900 }, (_, i) => ({
        type: 'tool_use',
        tool: { id: `call_${i}`, name: 'Bash', result: 'output-'.repeat(2000), isLoading: false },
      }));
      const out = shrinkReplayContentForClient(blocks);

      expect(Array.isArray(out)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(CLIENT_MESSAGE_INLINE_MAX_BYTES);
      // An omission marker block is present so the user knows content was dropped.
      const arr = out as Array<{ type: string; text?: string }>;
      expect(arr.some(b => b.type === 'text' && (b.text ?? '').includes('blocks omitted'))).toBe(true);
    });

    it('shrinks oversized plain string content to a bounded preview string', () => {
      const big = `HEAD-${'z'.repeat(CLIENT_MESSAGE_INLINE_MAX_BYTES)}-TAIL`;
      const out = shrinkReplayContentForClient(big);
      expect(typeof out).toBe('string');
      expect(out as string).toContain('too large for inline display');
      expect(Buffer.byteLength(out as string, 'utf8')).toBeLessThan(CLIENT_MESSAGE_INLINE_MAX_BYTES);
    });
  });

  it('keeps heartbeat and memory-update system reminders out of previews', () => {
    const result = resolveLastRealUserMessagePreview([
      {
        role: 'user',
        content: '<system-reminder><HEARTBEAT>A schedule fired</HEARTBEAT></system-reminder>',
        id: 'heartbeat',
        timestamp: 't1',
      } as SessionMessage,
      {
        role: 'user',
        content: '<system-reminder><MEMORY_UPDATE>remember this</MEMORY_UPDATE></system-reminder>',
        id: 'memory',
        timestamp: 't2',
      } as SessionMessage,
      { role: 'assistant', content: 'assistant', id: 'a1', timestamp: 't3' } as SessionMessage,
    ]);

    expect(result).toEqual({ found: false });
  });
});
