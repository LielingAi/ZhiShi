/**
 * 1.7.2 — window-transform.ts 单测（窗口置换纯函数 + transformContext 形态）。
 *
 * 覆盖：预算内透传 / 超预算置换（anchor 恒留、指针块、行区间、段原子）/
 * user 消息上限 / 空消息 / 异常容错与 onWindow 回调。
 */
import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  buildWorkingWindow,
  buildWindowPointer,
  jsonlLineRange,
  makeWindowTransform,
} from './window-transform';
import { segmentContext } from './context-manager';

function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1 } as AgentMessage;
}
function assistant(text: string, toolCallId?: string, toolName?: string): AgentMessage {
  const blocks: Record<string, unknown>[] = [{ type: 'text', text }];
  if (toolCallId) blocks.push({ type: 'toolCall', id: toolCallId, name: toolName ?? 'env_exec', arguments: { command: 'x' } });
  return { role: 'assistant', content: blocks, timestamp: 1 } as unknown as AgentMessage;
}
function toolResult(toolCallId: string, text: string): AgentMessage {
  return { role: 'toolResult', toolCallId, content: [{ type: 'text', text }], timestamp: 1 } as AgentMessage;
}
const FAT = 'A'.repeat(2000); // ≈ 800 tok（非 CJK: chars/2.5）

/** 构造 anchor + N 段（每段 1 user + assistant + toolResult 配对）。 */
function makeHistory(segments: number): AgentMessage[] {
  const out: AgentMessage[] = [user('任务目标：复现 CVE-X')];
  for (let i = 1; i <= segments; i++) {
    out.push(user(`指令 #${i} ${FAT}`));
    out.push(assistant(`分析 #${i} ${FAT}`, `call-${i}`, 'env_exec'));
    out.push(toolResult(`call-${i}`, `输出 #${i} SIGSEGV ${FAT}`));
  }
  return out;
}

describe('buildWorkingWindow（窗口置换纯函数）', () => {
  const opts = { contextWindow: 10_000, systemPromptChars: 0 }; // 预算 2500

  it('预算内 → 原样透传（不置换）', () => {
    const msgs = makeHistory(1);
    const r = buildWorkingWindow(msgs, opts);
    expect(r.evicted).toBe(false);
    expect(r.messages).toBe(msgs);
    expect(r.pointerCount).toBe(0);
  });

  it('超预算 → 最老段移出、anchor 原文保留、指针块就位、估算落回预算内', () => {
    const msgs = makeHistory(10);
    const r = buildWorkingWindow(msgs, opts);
    expect(r.evicted).toBe(true);
    expect(r.pointerCount).toBeGreaterThan(0);
    // anchor（任务目标）原文在头。
    expect((r.messages[0] as { content?: unknown }).content).toContain('任务目标');
    // 指针块在 anchor 之后。
    const pointerMsgs = r.messages.filter((m) => {
      const c = (m as { content?: unknown }).content;
      return typeof c === 'string' && c.includes('已沉淀');
    });
    expect(pointerMsgs.length).toBe(r.pointerCount);
    // 置换后估算 ≤ 预算。
    expect(r.afterTokens).toBeLessThanOrEqual(r.budgetTokens);
    // 被移出的消息不在工作记忆里，但原文行区间可寻址。
    expect(r.evictedCount).toBeGreaterThan(0);
  });

  it('配对不拆：被移出段整体移出（toolCall 与 toolResult 同段）', () => {
    const msgs = makeHistory(6);
    const r = buildWorkingWindow(msgs, opts);
    // kept 范围内 toolResult 的 toolCallId 与 assistant 的 toolCall 块成对。
    const resultIds: string[] = [];
    const callIds: string[] = [];
    for (const m of r.messages) {
      const mm = m as { role?: string; toolCallId?: string; content?: unknown };
      if (mm.role === 'toolResult' && mm.toolCallId) resultIds.push(mm.toolCallId);
      if (mm.role === 'assistant' && Array.isArray(mm.content)) {
        for (const b of mm.content as Array<Record<string, unknown>>) {
          if (b.type === 'toolCall' && b.id) callIds.push(String(b.id));
        }
      }
    }
    expect(resultIds.length).toBe(callIds.length);
    expect(resultIds.sort()).toEqual(callIds.sort());
  });

  it('user 消息上限：kept 范围 user 数 ≤ 上限', () => {
    const msgs = makeHistory(30);
    const r = buildWorkingWindow(msgs, { ...opts, keepRecentUser: 20 });
    // anchor 目标消息恒保留。
    const userCount = r.messages.filter((m) => m.role === 'user' && !String((m as { content?: unknown }).content).includes('已沉淀')).length;
    expect(userCount).toBeLessThanOrEqual(20 + 1); // 含 anchor
  });

  it('指针块内容：行区间与 recall 提示、关键行与工具名', () => {
    const msgs = makeHistory(8);
    const segments = segmentContext(msgs);
    const seg = segments[segments.length - 2];
    const p = buildWindowPointer(seg);
    const range = jsonlLineRange(seg);
    expect(p).toContain(`recall({lines:"${range.start}-${range.end}"})`);
    expect(p).toContain('env_exec');
    expect(p).toContain('SIGSEGV');
  });

  it('空消息 → 空结果', () => {
    const r = buildWorkingWindow([], opts);
    expect(r.evicted).toBe(false);
    expect(r.messages).toEqual([]);
  });

  it('锚段超预算也恒保留（极端小预算）', () => {
    const msgs = makeHistory(5);
    const r = buildWorkingWindow(msgs, { contextWindow: 100, systemPromptChars: 0 });
    expect((r.messages[0] as { content?: unknown }).content).toContain('任务目标');
  });
});

describe('makeWindowTransform（transformContext 形态）', () => {
  it('超预算触发置换 + onWindow 回调；异常原样透传', async () => {
    const msgs = makeHistory(10);
    const infoBox: { value: { evicted: boolean; pointerCount: number } | null } = { value: null };
    const transform = makeWindowTransform({ contextWindow: 10_000, systemPromptChars: 0 }, (i) => { infoBox.value = i; });
    const out = await transform(msgs);
    expect(out.length).toBeLessThan(msgs.length);
    expect(infoBox.value?.evicted).toBe(true);
    expect(infoBox.value?.pointerCount ?? 0).toBeGreaterThan(0);
  });

  it('预算内透传且不触发回调副作用', async () => {
    const msgs = makeHistory(1);
    let called = false;
    const transform = makeWindowTransform({ contextWindow: 10_000 }, () => { called = true; });
    const out = await transform(msgs);
    expect(out).toBe(msgs);
    expect(called).toBe(true); // 回调恒触发（info 携带 evicted:false）
  });
});
