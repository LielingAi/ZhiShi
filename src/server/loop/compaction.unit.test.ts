/**
 * M3 → 1.2.7(A)— compaction(loop/compaction.ts)unit tests。
 *
 * 1.2.7 重写为段级压缩(消费 context-manager.ts):阈值首判(全量启发式
 * × meta 校准系数,1.5.3;usage 锚已删)、采样锚定压缩(anchor/当前阶段/
 * key 段存活,stub 居中)、裁后纯估算重估、第二档正文截断与 /reset 引导、
 * transform 异常透传、持久层不受影响(jsonl 全量 + meta compactedAt 标记)。
 * 持久层用真临时目录。切分/相位/标注/stub/存活契约新族的细粒度用例在
 * context-manager.unit.test.ts。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  evaluateCompaction,
  makeCompactionTransform,
  truncateMessageText,
} from './compaction';
import { estimateMessagesTokens, isKeyMessage, messageText } from './context-manager';
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
function toolResult(text: string, toolCallId = 't'): AgentMessage {
  return {
    role: 'toolResult', toolCallId, toolName: 'env_exec',
    content: [{ type: 'text', text }], isError: false, timestamp: 3,
  } as unknown as AgentMessage;
}

describe('isKeyMessage(存活契约经 compaction 转发导出)', () => {
  it('env_exec 非零 exit → 关键(死路);常规输出 → 非关键', () => {
    expect(isKeyMessage(toolResult('exit=1\n--- stdout ---\nnope'))).toBe(true);
    expect(isKeyMessage(toolResult('exit=0\n--- stdout ---\nok'))).toBe(false);
    expect(isKeyMessage(user('查一下内核版本'))).toBe(false);
  });
  it('CVE / flag / [redacted] / 1.2.7 新族 → 关键', () => {
    expect(isKeyMessage(assistant('目标是 CVE-2024-1086 的 UAF'))).toBe(true);
    expect(isKeyMessage(toolResult('flag{n3ll0_w0rld}'))).toBe(true);
    expect(isKeyMessage(toolResult('[redacted: …]'))).toBe(true);
    expect(isKeyMessage(assistant('拿到shell了'))).toBe(true);
    expect(isKeyMessage(toolResult('SIGSEGV (core dumped)'))).toBe(true);
    expect(isKeyMessage(toolResult('exit=0\n目标目录不可写'))).toBe(true);
  });
});

describe('evaluateCompaction(未裁首判,保留 usage 锚)', () => {
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

  it('systemPromptChars 把纯估算推过阈值;缺省 0 向后兼容', () => {
    const msgs = [user('短消息')];
    expect(evaluateCompaction(msgs, { contextWindow: 1000, thresholdRatio: 0.5 }).compact).toBe(false);
    const r = evaluateCompaction(msgs, { contextWindow: 1000, thresholdRatio: 0.5, systemPromptChars: 4000 });
    expect(r.compact).toBe(true);
    expect(r.tokens).toBeGreaterThan(1000 - 10);
  });

  it('1.5.3 校准系数：meta 持久化的 calibration 直接乘进判定值（锚失真修复）', () => {
    // 启发式全量 ≈241 tokens；真实 API 体量是其 3.3 倍（golang 事故比率）。
    const msgs = [user('任务' + 'x'.repeat(596))]; // 启发式 ≈ 241 tokens
    const base = evaluateCompaction(msgs, { contextWindow: 1000, thresholdRatio: 0.5 });
    expect(base.compact).toBe(false); // 未校准：241 < 500 不压
    const calibrated = evaluateCompaction(msgs, { contextWindow: 1000, thresholdRatio: 0.5, calibration: 3.3 });
    expect(calibrated.compact).toBe(true); // 校准后：~795 > 500 压
    expect(calibrated.tokens).toBeGreaterThan(700);
    expect(calibrated.tokens).toBeLessThan(900);
  });
});

describe('makeCompactionTransform — 段级采样锚定压缩(1.2.7)', () => {
  /**
   * seg0 anchor(小) / seg1 recon(非 key,大,可 stub) / seg2 analysis
   * (key,必保) / seg3 construction(非 key,大,可 stub) / seg4
   * execution(当前阶段,必保)。
   */
  function bigSession(): AgentMessage[] {
    return [
      user('总任务:渗透 10.0.0.5'),
      user('用 nmap 扫描目标端口'),
      toolResult(`exit=0\n22 80 443 ${'p'.repeat(3000)}`, 'c1'),
      user('grep 审计源码找漏洞'),
      toolResult('exit=1\n目标文件不存在,此路不通', 'c2'),
      user('写 payload 脚本'),
      assistant(`构造 PoC 如下 ${'r'.repeat(2000)}`),
      user('运行 exploit 拿 shell'),
      toolResult('exit=0\n会话已开,继续', 'c3'),
    ];
  }

  it('未超阈值原样透传(同一数组引用)', async () => {
    const transform = makeCompactionTransform({ contextWindow: 1_000_000 });
    const small = [user('q')];
    expect(await transform(small)).toBe(small);
  });

  it('超阈值:压后达标,anchor/key 段/当前阶段原文全存,stub 居中', async () => {
    const msgs = bigSession();
    const infos: Array<{ prunedCount: number; stubbedSegments?: number; stillOverThreshold?: boolean }> = [];
    const transform = makeCompactionTransform(
      { contextWindow: 1000, thresholdRatio: 0.5 }, // 阈值 500 tokens
      (info) => infos.push(info),
    );
    const out = await transform(msgs);
    expect(infos).toHaveLength(1);
    expect(infos[0].stillOverThreshold).toBe(false);
    expect(infos[0].stubbedSegments).toBe(2);
    // 1.5.3：用户指令永不裁——被 stub 段内的 user 消息原文保留，prunedCount
    // 是净裁口径（段体量 − 保留的 user 消息数；1.2.7 旧口径 4 = 全量计入）。
    expect(infos[0].prunedCount).toBe(2);
    // 压后纯估算达标
    expect(estimateMessagesTokens(out)).toBeLessThanOrEqual(500);
    // anchor 在头;key 段死路原文存活;当前阶段(execution)在尾
    expect(out[0]).toBe(msgs[0]);
    expect(out.some((m) => messageText(m).includes('exit=1\n目标文件不存在'))).toBe(true);
    expect(out[out.length - 1]).toBe(msgs[8]);
    // 1.5.3：被 stub 段的用户指令原文存活（「grep 审计源码找漏洞」「写 payload 脚本」）
    expect(out.some((m) => m.role === 'user' && messageText(m).includes('grep 审计源码找漏洞'))).toBe(true);
    expect(out.some((m) => m.role === 'user' && messageText(m).includes('写 payload 脚本'))).toBe(true);
    // stub 是合法 user 消息,带段号/phase/存档指针
    const stubs = out.filter((m) => messageText(m).startsWith('[段#'));
    expect(stubs).toHaveLength(2);
    for (const s of stubs) {
      expect(s.role).toBe('user');
      expect(messageText(s)).toContain('会话存档');
    }
  });

  it('A2-3:hasRecall=false(子 loop 形态)兜底 stub 不印 recall 取回指引', async () => {
    const msgs = bigSession();
    const transform = makeCompactionTransform(
      { contextWindow: 1000, thresholdRatio: 0.5 },
      undefined,
      { hasRecall: false }, // 无 sessionId → 无收割,走兜底 stub;子 loop 无 recall 工具
    );
    const out = await transform(msgs);
    const stubs = out.filter((m) => messageText(m).startsWith('[段#'));
    expect(stubs.length).toBeGreaterThan(0);
    for (const s of stubs) {
      expect(messageText(s)).not.toContain('recall');
      expect(messageText(s)).toContain('无取回工具');
    }
    // 对照:缺省(主 loop)仍印 recall 指引
    const outDefault = await makeCompactionTransform({ contextWindow: 1000, thresholdRatio: 0.5 })(msgs);
    const defaultStubs = outDefault.filter((m) => messageText(m).startsWith('[段#'));
    expect(defaultStubs.some((m) => messageText(m).includes('recall 工具按行区间取回'))).toBe(true);
  });

  it('裁后重估纯字符口径:usage 字段不参与估算(1.5.3 起 usage 锚已删)', async () => {
    // anchor 段内的旧 assistant 带大 usage(压缩前全量实测值)——1.5.3 起
    // 判定/重估一律纯估算,usage 字段完全不读;首判由启发式体量触发压缩。
    const withUsage = {
      role: 'assistant',
      content: [{ type: 'text', text: '先看版本' }],
      stopReason: 'stop',
      usage: { input: 490_000, output: 10_000, cacheRead: 0, cacheWrite: 0, totalTokens: 500_000 },
      timestamp: 2,
    } as unknown as AgentMessage;
    const msgs = [
      user('总任务:分析目标内核'),
      withUsage,                                                     // anchor 段,必保
      user('用 nmap 扫描端口'),
      toolResult(`exit=0\n${'p'.repeat(4000)}`, 'c1'),                // seg1 可 stub
      user('运行 exploit'),
      toolResult('exit=0\nok', 'c2'),                                 // 当前阶段,必保
    ];
    const infos: Array<{ stillOverThreshold?: boolean; stubbedSegments?: number }> = [];
    const transform = makeCompactionTransform(
      { contextWindow: 1000, thresholdRatio: 0.5 },
      (info) => infos.push(info),
    );
    const out = await transform(msgs);
    expect(infos).toHaveLength(1);
    expect(infos[0].stubbedSegments).toBe(1);
    // 保留的旧 assistant 仍带 500K usage 字段,纯估算口径下不误报超阈值
    expect(out).toContain(withUsage);
    expect(infos[0].stillOverThreshold).toBe(false);
    expect(estimateMessagesTokens(out)).toBeLessThanOrEqual(500);
  });

  it('第二档:必保集本身超阈值 → 逐条正文截断（user 永不裁）,仍超则 stillOverThreshold 上报', async () => {
    // 全部命中关键标记(error:)且体积巨大 → 段级 stub 无可压
    // 1.5.3：user 消息永不截断——改由 assistant 长文本承载截断断言。
    const msgs = Array.from({ length: 6 }, (_, i) => assistant(`error: 第${i}条 ${'x'.repeat(800)}`));
    const infos: Array<{ stillOverThreshold?: boolean }> = [];
    const transform = makeCompactionTransform(
      { contextWindow: 200, thresholdRatio: 0.5 }, // 阈值 100 tokens ≈ 400 字符
      (info) => infos.push(info),
    );
    const out = await transform(msgs);
    // 结构还在(key 段不丢),但每条体积被压到均摊预算内
    expect(out).toHaveLength(6);
    for (const m of out) {
      expect(messageText(m).length).toBeLessThanOrEqual(240);
      expect(messageText(m)).toContain('⟦系统注记');
    }
    // 6 × 200 字符 ≈ 300 tokens 仍超 100 → 明确上报,不留 API 400 无升级路径
    expect(infos).toHaveLength(1);
    expect(infos[0].stillOverThreshold).toBe(true);
  });

  it('transform 异常 → 原样透传(不炸 loop)', async () => {
    const transform = makeCompactionTransform({ contextWindow: Number.NaN });
    const msgs = [user('q')];
    // NaN 阈值不会触发压缩;此处主要验证不 throw
    expect(await transform(msgs)).toBe(msgs);
  });
});

describe('truncateMessageText（1.5.3 新契约：⟦⟧ 标记 + user 永不截断）', () => {
  it('user 消息永不截断（用户指令必保）', () => {
    const m = user('x'.repeat(500));
    expect(messageText(truncateMessageText(m, 100))).toBe('x'.repeat(500));
  });

  it('assistant string content 与 text 块截断（⟦⟧ 新标记）;toolCall 块不动', () => {
    const a = assistant('x'.repeat(500));
    expect(messageText(truncateMessageText(a, 100))).toContain('⟦系统注记');
    const call = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 't', name: 'env_exec', arguments: { command: 'y'.repeat(500) } }],
      timestamp: 2,
    } as unknown as AgentMessage;
    const out = truncateMessageText(call, 100);
    expect(messageText(out)).toContain('y'.repeat(500)); // toolCall 不截断
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
