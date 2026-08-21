/**
 * 1.1.10(A′)— transcript(loop/transcript.ts)unit tests。
 *
 * 全部落真临时目录(绝不碰 ~/.zhishi)。覆盖:读回结构化条目(user/
 * assistant 文本 + 工具调用摘要/tool 结果)、单字段截断、条目数与字节
 * 护栏(truncated 标记)、不存在会话 → null(端点 404 路径)。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { appendLoopMessages } from './session';
import { buildLoopTranscript } from './transcript';

const DIR = mkdtempSync(join(tmpdir(), 'zhishi-loop-transcript-test-'));

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1 } as AgentMessage;
}
function assistantWithToolCall(text: string, name: string, args: Record<string, unknown>): AgentMessage {
  return {
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      { type: 'toolCall', id: 'tc-1', name, arguments: args },
    ],
    stopReason: 'toolUse',
    timestamp: 2,
  } as unknown as AgentMessage;
}
function assistantText(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    timestamp: 4,
  } as unknown as AgentMessage;
}
function toolResult(toolName: string, text: string, isError = false): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 'tc-1',
    toolName,
    isError,
    content: [{ type: 'text', text }],
    timestamp: 3,
  } as unknown as AgentMessage;
}

describe('buildLoopTranscript', () => {
  it('读回:user/assistant(文本+工具调用摘要)/tool 结果 结构化', async () => {
    await appendLoopMessages('t-read', [
      user('查主机名'),
      assistantWithToolCall('我来查', 'env_exec', { command: 'hostname' }),
      toolResult('env_exec', 'pwn-vm'),
      assistantText('主机名是 pwn-vm'),
    ], undefined, { dir: DIR });

    const t = buildLoopTranscript('t-read', { dir: DIR });
    expect(t).not.toBeNull();
    expect(t!.loopSessionId).toBe('t-read');
    expect(t!.truncated).toBe(false);
    expect(t!.totalMessages).toBe(4);
    expect(t!.entries).toHaveLength(4);
    expect(t!.entries[0]).toEqual({ role: 'user', text: '查主机名' });
    expect(t!.entries[1]).toEqual({
      role: 'assistant',
      text: '我来查',
      toolCalls: [{ name: 'env_exec', argsSummary: '{"command":"hostname"}' }],
    });
    expect(t!.entries[2]).toEqual({ role: 'tool', toolName: 'env_exec', isError: false, text: 'pwn-vm' });
    expect(t!.entries[3]).toEqual({ role: 'assistant', text: '主机名是 pwn-vm' });
  });

  it('单字段截断:长 tool 结果(2000 字)与长参数摘要(200 字)带省略号', async () => {
    await appendLoopMessages('t-clip', [
      assistantWithToolCall('', 'env_exec', { command: 'y'.repeat(500) }),
      toolResult('env_exec', 'z'.repeat(3000), true),
    ], undefined, { dir: DIR });

    const t = buildLoopTranscript('t-clip', { dir: DIR })!;
    const call = t.entries[0];
    expect(call.toolCalls![0].argsSummary).toHaveLength(201);
    expect(call.toolCalls![0].argsSummary.endsWith('…')).toBe(true);
    expect(call.text).toBeUndefined(); // 无文本的 assistant 不留空 text 字段
    const result = t.entries[1];
    expect(result.isError).toBe(true);
    expect(result.text).toHaveLength(2001);
    expect(result.text!.endsWith('…')).toBe(true);
  });

  it('条目数护栏:超 200 条截断,truncated=true,totalMessages 保留全量', async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 250; i++) messages.push(user(`m${i}`));
    await appendLoopMessages('t-many', messages, undefined, { dir: DIR });

    const t = buildLoopTranscript('t-many', { dir: DIR })!;
    expect(t.truncated).toBe(true);
    expect(t.entries).toHaveLength(200);
    expect(t.totalMessages).toBe(250);
    expect(t.entries[0].text).toBe('m0'); // 保留从头起的时间序
  });

  it('字节护栏:累计文本超 ~100KB 截断并标记', async () => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 30; i++) messages.push(user('a'.repeat(4000))); // 单条 ≤ MAX_TEXT_CHARS
    await appendLoopMessages('t-bytes', messages, undefined, { dir: DIR });

    const t = buildLoopTranscript('t-bytes', { dir: DIR })!;
    expect(t.truncated).toBe(true);
    expect(t.entries.length).toBeLessThan(30);
    expect(t.totalMessages).toBe(30);
    const bytes = t.entries.reduce((sum, e) => sum + (e.text?.length ?? 0), 0);
    expect(bytes).toBeLessThanOrEqual(100 * 1024);
  });

  it('不存在 id → null(端点回 404);空会话 → entries:[] 而非 null', async () => {
    expect(buildLoopTranscript('no-such-session', { dir: DIR })).toBeNull();
    await appendLoopMessages('t-empty', [], undefined, { dir: DIR });
    const t = buildLoopTranscript('t-empty', { dir: DIR })!;
    expect(t.entries).toEqual([]);
    expect(t.truncated).toBe(false);
  });
});
