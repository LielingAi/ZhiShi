/**
 * M3 — compaction(loop/compaction.ts)unit tests.
 *
 * 阈值触发、关键消息存活(exit≠0/error/CVE/flag/[redacted])、最近 N 轮
 * 保留、任务锚保留、占位消息、transform 异常兜底、持久层不受影响
 * (jsonl 全量 + meta compactedAt 标记)。持久层用真临时目录。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  evaluateCompaction,
  isKeyMessage,
  makeCompactionTransform,
  messageText,
  pruneLoopContext,
  recentTurnsStartIndex,
} from './compaction';
import {
  appendLoopMessages,
  loadLoopSession,
  markLoopSessionCompacted,
} from './session';

const DIR = mkdtempSync(join(tmpdir(), 'zhishi-loop-compaction-test-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function user(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1 } as AgentMessage;
}
function assistant(text: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], timestamp: 2 } as unknown as AgentMessage;
}
function toolResult(text: string): AgentMessage {
  return {
    role: 'toolResult', toolCallId: 't', toolName: 'env_exec',
    content: [{ type: 'text', text }], isError: false, timestamp: 3,
  } as unknown as AgentMessage;
}

describe('messageText / isKeyMessage(关键标记存活线)', () => {
  it('env_exec 非零 exit → 关键(死路)', () => {
    expect(isKeyMessage(toolResult('exit=1\n--- stdout ---\nnope'))).toBe(true);
    expect(isKeyMessage(toolResult('exit=0\n--- stdout ---\nok'))).toBe(false);
  });
  it('error / CVE / flag / [redacted] → 关键', () => {
    expect(isKeyMessage(assistant('grep failed with error code 2'))).toBe(true);
    expect(isKeyMessage(assistant('目标是 CVE-2024-1086 的 UAF'))).toBe(true);
    expect(isKeyMessage(toolResult('flag{n3ll0_w0rld}'))).toBe(true);
    expect(isKeyMessage(toolResult('[redacted: …]'))).toBe(true);
  });
  it('常规输出 → 非关键', () => {
    expect(isKeyMessage(toolResult('exit=0\nLinux fuzz'))).toBe(false);
    expect(isKeyMessage(user('查一下内核版本'))).toBe(false);
  });
  it('toolCall 块的命令文本参与判定', () => {
    const call = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 't', name: 'env_exec', arguments: { command: 'cat CVE-2024-1086.txt' } }],
      timestamp: 2,
    } as unknown as AgentMessage;
    expect(messageText(call)).toContain('CVE-2024-1086');
    expect(isKeyMessage(call)).toBe(true);
  });
});

describe('recentTurnsStartIndex', () => {
  it('从末尾数第 N 条 user 起', () => {
    const msgs = [user('t1'), assistant('a'), user('t2'), assistant('b'), user('t3'), assistant('c')];
    expect(recentTurnsStartIndex(msgs, 1)).toBe(4);
    expect(recentTurnsStartIndex(msgs, 2)).toBe(2);
    expect(recentTurnsStartIndex(msgs, 99)).toBe(0);
  });
});

describe('pruneLoopContext(保守裁剪)', () => {
  const msgs = [
    user('总任务:分析目标内核'),            // 0 任务锚
    assistant('先看版本'),                   // 1 早期非关键
    toolResult('exit=0\n7.0.0-28-generic'), // 2 早期非关键
    toolResult('exit=1\ngdb: not found'),   // 3 关键(死路)
    assistant('假设:CVE-2024-1086 可利用'), // 4 关键(CVE)
    user('继续查 gdb'),                     // 5 最近轮
    assistant('装 gdb'),                    // 6 最近轮
    toolResult('exit=0\nGNU gdb 15.1'),     // 7 最近轮
  ];

  it('任务锚 + 关键消息 + 最近轮存活,其余省略并插占位', () => {
    const { messages: out, prunedCount } = pruneLoopContext(msgs, { keepRecentTurns: 1 });
    expect(prunedCount).toBe(2); // 下标 1、2 被砍
    expect(out[0]).toBe(msgs[0]); // 任务锚在最前
    expect((out[1] as { content: string }).content).toContain('[compaction:');
    expect((out[1] as { content: string }).content).toContain('2 条');
    expect(out).toContain(msgs[3]); // 死路存活
    expect(out).toContain(msgs[4]); // CVE 假设存活
    expect(out).toContain(msgs[5]); // 最近轮存活
    expect(out).not.toContain(msgs[1]);
    expect(out).not.toContain(msgs[2]);
  });

  it('全部命中保留条件 → 不砍(prunedCount=0,原数组)', () => {
    const short = [user('q'), assistant('a')];
    const r = pruneLoopContext(short, { keepRecentTurns: 4 });
    expect(r.prunedCount).toBe(0);
    expect(r.messages).toBe(short);
  });

  it('tool 配对闭包:关键 toolResult 找回其 toolCall(反之亦然),不拆对', () => {
    const call = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'env_exec', arguments: { command: 'ls /x' } }],
      timestamp: 2,
    } as unknown as AgentMessage;
    const result = {
      role: 'toolResult', toolCallId: 'call-1', toolName: 'env_exec',
      content: [{ type: 'text', text: 'exit=2\nno such dir' }], isError: false, timestamp: 3,
    } as unknown as AgentMessage;
    const msgs = [
      user('任务'),
      call,          // 非关键,但持有关键 toolResult 的 toolCall
      result,        // 关键(exit≠0)
      assistant('普通一句'), // 非关键
      user('最近一轮'),
    ];
    const { messages: out, prunedCount } = pruneLoopContext(msgs, { keepRecentTurns: 1 });
    // call 必须随 result 一起存活(API 要求 tool_use/tool_result 成对)
    expect(out).toContain(call);
    expect(out).toContain(result);
    expect(out).not.toContain(msgs[3]);
    expect(prunedCount).toBe(1);
    // toolCall 关键时 toolResult 也被找回
    const cveCall = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-2', name: 'env_exec', arguments: { command: 'cat CVE-2024-1086.txt' } }],
      timestamp: 2,
    } as unknown as AgentMessage;
    const cveResult = {
      role: 'toolResult', toolCallId: 'call-2', toolName: 'env_exec',
      content: [{ type: 'text', text: 'exit=0\nplain' }], isError: false, timestamp: 3,
    } as unknown as AgentMessage;
    const msgs2 = [user('任务'), cveCall, cveResult, assistant('非关键'), user('最近')];
    const out2 = pruneLoopContext(msgs2, { keepRecentTurns: 1 });
    expect(out2.messages).toContain(cveCall);
    expect(out2.messages).toContain(cveResult);
  });

  it('keepRecentTurns 调大 → 砍得更少(保守可调)', () => {
    const wide = pruneLoopContext(msgs, { keepRecentTurns: 99 });
    expect(wide.prunedCount).toBe(0);
  });
});

describe('evaluateCompaction / makeCompactionTransform', () => {
  it('未超阈值 → 不触发', () => {
    const r = evaluateCompaction([user('短')], { contextWindow: 1_000_000 });
    expect(r.compact).toBe(false);
    expect(r.tokens).toBeLessThan(r.threshold);
  });

  it('超阈值 → 触发(阈值 = contextWindow × ratio)', () => {
    const big = [user('x'.repeat(10_000))];
    const r = evaluateCompaction(big, { contextWindow: 100, thresholdRatio: 0.5 });
    expect(r.compact).toBe(true);
    expect(r.threshold).toBe(50);
  });

  it('transform:未超阈值原样,超阈值裁剪并回调 onCompact', async () => {
    const long = Array.from({ length: 30 }, (_, i) => user(`第${i}轮 ${'y'.repeat(500)}`));
    long.splice(10, 0, toolResult('exit=9\n关键死路'));
    const infos: unknown[] = [];
    const transform = makeCompactionTransform(
      { contextWindow: 200, thresholdRatio: 0.5, keepRecentTurns: 2 },
      (info) => infos.push(info),
    );
    const out = await transform(long);
    expect(infos).toHaveLength(1);
    expect(out.length).toBeLessThan(long.length);
    // 关键消息在低阈值裁剪下仍然存活
    expect(out.some((m) => messageText(m).includes('关键死路'))).toBe(true);
    // 未超阈值时原样返回
    const small = [user('q')];
    expect(await transform(small)).toBe(small);
  });

  it('transform 异常 → 原样透传(不炸 loop)', async () => {
    const transform = makeCompactionTransform({ contextWindow: Number.NaN });
    const msgs = [user('q')];
    // NaN 阈值不会触发压缩;此处主要验证不 throw
    expect(await transform(msgs)).toBe(msgs);
  });
});

describe('持久层不受影响(jsonl 全量 + compactedAt 标记)', () => {
  it('压缩后 jsonl 仍全量;markLoopSessionCompacted 只改 meta', async () => {
    const id = `compact-${Date.now().toString(36)}`;
    const full = [user('t1'), toolResult('exit=1\n死路'), assistant('a'), user('t2'), assistant('b')];
    await appendLoopMessages(id, full, { model: 'k3' }, { dir: DIR });

    await markLoopSessionCompacted(id, { dir: DIR });
    const s = loadLoopSession(id, { dir: DIR });
    expect(s.messages).toHaveLength(full.length); // 全量未动
    expect(s.meta?.compactedAt).toBeTruthy();
    expect(s.meta?.model).toBe('k3');

    // 后续追加不丢 compactedAt 标记
    await appendLoopMessages(id, [assistant('c')], undefined, { dir: DIR });
    const s2 = loadLoopSession(id, { dir: DIR });
    expect(s2.messages).toHaveLength(full.length + 1);
    expect(s2.meta?.compactedAt).toBe(s.meta?.compactedAt);
  });

  it('mark 不存在的会话 → 静默无操作(不建文件)', async () => {
    await markLoopSessionCompacted('no-such-session', { dir: DIR });
    expect(loadLoopSession('no-such-session', { dir: DIR }).messages).toEqual([]);
  });
});

// ===== 1.2.6 批次 C 深化 =====

describe('isKeyMessage — error 信号收窄（1.2.6）', () => {
  it('良性搭配不再误判:否定式与错误处理机制名 → 非关键', async () => {
    const { isKeyMessage } = await import('./compaction');
    expect(isKeyMessage(toolResult('exit=0\n编译通过,no error'))).toBe(false);
    expect(isKeyMessage(assistant('这条路径的 error handling 已覆盖'))).toBe(false);
    expect(isKeyMessage(assistant('解析器自带 error handler,0 errors 返回'))).toBe(false);
  });
  it('真错误信号不误裁:Error:/error code/同行情良+真错误仍关键', async () => {
    const { isKeyMessage } = await import('./compaction');
    expect(isKeyMessage(toolResult('Error: segfault at 0x0'))).toBe(true);
    expect(isKeyMessage(assistant('grep failed with error code 2'))).toBe(true);
    // 同一行里既有良性搭配又有真错误 —— 剥掉良性后仍命中
    expect(isKeyMessage(toolResult('ret: no error; later: error: timeout'))).toBe(true);
  });
});

describe('pruneLoopContext — 占位消息对齐真实契约（1.2.6）', () => {
  it('不再过度承诺「均保留」,声明保留口径与省略风险', () => {
    const msgs = [
      user('任务'),
      assistant('早期细节:某个不命中标记的突破口线索'),
      user('最近一轮'),
      assistant('最近回复'),
    ];
    const { messages: out } = pruneLoopContext(msgs, { keepRecentTurns: 1 });
    const placeholder = out[1] as { content: string };
    expect(placeholder.content).toContain('[compaction:');
    expect(placeholder.content).toContain('1 条');
    expect(placeholder.content).toContain('命中关键标记');
    expect(placeholder.content).not.toContain('均保留');
  });
});

describe('evaluateCompaction — 系统提示纳入估算（1.2.6）', () => {
  it('systemPromptChars 把纯估算推过阈值;缺省 0 向后兼容', async () => {
    const { evaluateCompaction } = await import('./compaction');
    const msgs = [user('短消息')];
    // 无系统提示:远低于阈值
    expect(evaluateCompaction(msgs, { contextWindow: 1000, thresholdRatio: 0.5 }).compact).toBe(false);
    // 系统提示 4000 字符 ≈ 1000 tokens > 500 阈值
    const r = evaluateCompaction(msgs, { contextWindow: 1000, thresholdRatio: 0.5, systemPromptChars: 4000 });
    expect(r.compact).toBe(true);
    expect(r.tokens).toBeGreaterThan(1000 - 10);
  });
});

describe('makeCompactionTransform — 第二档升级路径（1.2.6）', () => {
  it('保守裁剪后仍超阈值 → 逐条正文截断,仍超则 stillOverThreshold 上报', async () => {
    const { makeCompactionTransform, messageText } = await import('./compaction');
    // 全部命中关键标记(error:)且体积巨大 → 保守裁剪裁不动
    const msgs = Array.from({ length: 6 }, (_, i) => user(`error: 第${i}条 ${'x'.repeat(800)}`));
    const infos: Array<{ stillOverThreshold?: boolean }> = [];
    const transform = makeCompactionTransform(
      { contextWindow: 200, thresholdRatio: 0.5 }, // 阈值 100 tokens ≈ 400 字符
      (info) => infos.push(info),
    );
    const out = await transform(msgs);
    // 结构还在(关键消息不丢),但每条体积被压到均摊预算内
    expect(out).toHaveLength(6);
    for (const m of out) {
      expect(messageText(m).length).toBeLessThanOrEqual(220);
      expect(messageText(m)).toContain('[已截断]');
    }
    // 6 × 200 字符 ≈ 300 tokens 仍超 100 → 明确上报,不留 API 400 无升级路径
    expect(infos).toHaveLength(1);
    expect(infos[0].stillOverThreshold).toBe(true);
  });

  it('第二档收紧最近轮数能压回阈值内时 stillOverThreshold=false', async () => {
    const { makeCompactionTransform } = await import('./compaction');
    // 非关键消息堆量:第一档(保留 4 轮)裁完仍超,第二档(1 轮)压回阈值内
    const msgs = Array.from({ length: 9 }, (_, i) => user(`第${i}轮 ${'x'.repeat(800)}`));
    const infos: Array<{ stillOverThreshold?: boolean; prunedCount: number }> = [];
    const transform = makeCompactionTransform(
      { contextWindow: 1000, thresholdRatio: 0.5 }, // 阈值 500 tokens
      (info) => infos.push(info),
    );
    const out = await transform(msgs);
    // 第二档:任务锚 + 最近 1 轮 + 占位 = 3 条
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(msgs[0]);
    expect((out[1] as { content: string }).content).toContain('[compaction:');
    expect(out[2]).toBe(msgs[8]);
    expect(infos).toHaveLength(1);
    expect(infos[0].stillOverThreshold).toBe(false);
    expect(infos[0].prunedCount).toBe(7);
  });
});
