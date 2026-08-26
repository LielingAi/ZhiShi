/**
 * 1.3.3 — wire-replay（loop jsonl → wire 消息还原）unit tests.
 *
 * 覆盖:user/assistant/toolResult 三类消息的还原形状、1.3.2 决策块
 * (kind:'decision' + decisionId/choice/note/expertRefs)、thinking 段跳过、
 * 空结论 assistant 照发、图片附件、序号续传。
 * 消息对象是 pi AgentMessage 的结构化 mock(不 import pi 运行时)。
 */
import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { buildLoopWireMessages } from './wire-replay';

function userMsg(overrides: Record<string, unknown> = {}): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'hello' }],
    timestamp: '2026-08-20T10:00:00.000Z',
    ...overrides,
  } as unknown as AgentMessage;
}

describe('buildLoopWireMessages', () => {
  it('user 文本 → wire user 消息(时间戳 ISO 化)', () => {
    const [m] = buildLoopWireMessages([userMsg()]);
    expect(m.role).toBe('user');
    expect(m.content).toBe('hello');
    expect(m.timestamp).toBe('2026-08-20T10:00:00.000Z');
    expect(m.kind).toBeUndefined();
  });

  it('1.3.2 决策块:decision marker → kind/decisionId/choice/note/expertRefs 全量还原', () => {
    const [m] = buildLoopWireMessages([
      userMsg({
        content: [{ type: 'text', text: '决定:改用方案 B' }],
        decision: {
          decisionId: 'd-1',
          question: '走哪条路?',
          options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
          choice: 'B',
          note: '测试表明 B 更稳',
          expertRefs: ['exp-9'],
        },
      }),
    ]);
    expect(m.kind).toBe('decision');
    expect(m.decisionId).toBe('d-1');
    expect(m.choice).toBe('B');
    expect(m.note).toBe('测试表明 B 更稳');
    expect(m.expertRefs).toEqual(['exp-9']);
  });

  it('决策块可选字段缺省时不出现(note/expertRefs)', () => {
    const [m] = buildLoopWireMessages([
      userMsg({
        decision: {
          decisionId: 'd-2',
          question: 'q',
          options: [{ label: 'A', description: 'a' }],
          choice: 'A',
        },
      }),
    ]);
    expect(m.kind).toBe('decision');
    expect('note' in m).toBe(false);
    expect('expertRefs' in m).toBe(false);
  });

  it('assistant:thinking-only(toolCall 无文本)跳过;带文本照发;图片附件还原', () => {
    const messages: AgentMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: '先想想' },
          { type: 'toolCall', name: 'env_exec', id: 'tc-1', arguments: { command: 'id' } },
        ],
        timestamp: '2026-08-20T10:00:01.000Z',
      } as unknown as AgentMessage,
      {
        role: 'assistant',
        content: [{ type: 'text', text: '结论:找到了' }],
        timestamp: '2026-08-20T10:00:02.000Z',
      } as unknown as AgentMessage,
      userMsg({ content: [{ type: 'image', mimeType: 'image/png', data: 'x' }] }),
    ];
    const wire = buildLoopWireMessages(messages);
    expect(wire).toHaveLength(2); // thinking-only 条被跳过
    expect(wire[0].role).toBe('assistant');
    expect(wire[0].content).toBe('结论:找到了');
    expect(wire[1].role).toBe('user');
    expect(wire[1].attachments).toEqual([{ id: '0', name: 'image', mimeType: 'image/png', isImage: true }]);
  });

  it('toolResult → tool 卡(name/ok/文本);失败结果 ok:false', () => {
    const wire = buildLoopWireMessages([
      {
        role: 'toolResult',
        toolName: 'env_exec',
        isError: false,
        content: [{ type: 'text', text: 'uid=0(root)\n' }],
        timestamp: '2026-08-20T10:00:03.000Z',
      } as unknown as AgentMessage,
      {
        role: 'toolResult',
        isError: true,
        content: [{ type: 'text', text: 'connection refused' }],
        timestamp: '2026-08-20T10:00:04.000Z',
      } as unknown as AgentMessage,
    ]);
    expect(wire[0]).toMatchObject({ role: 'tool', name: 'env_exec', ok: true, content: 'uid=0(root)\n' });
    expect(wire[1]).toMatchObject({ role: 'tool', name: 'tool', ok: false, content: 'connection refused' });
  });

  it('序号:startSeq 起连续递增(空内容 assistant 也占号)', () => {
    const wire = buildLoopWireMessages(
      [
        userMsg(),
        { role: 'assistant', content: [], timestamp: '2026-08-20T10:00:05.000Z' } as unknown as AgentMessage,
        userMsg(),
      ],
      7,
    );
    expect(wire.map((m) => m.id)).toEqual(['7', '8', '9']);
  });
});
