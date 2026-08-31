/**
 * 1.2.7(A)— context-manager(loop/context-manager.ts)unit tests。
 *
 * 覆盖:切分边界、相位推断(含继承粘性与打平取靠后)、标注(tokens/
 * age/工具名录/命中行摘录)、采样锚定(超阈值会话压后达标且 anchor/
 * 当前阶段/key 段全存)、stub 形态(合法 user 消息+原文摘录)、存活
 * 契约新三族(中文/exit=0 约束/fuzz 崩溃)、裁后纯估算口径、tool
 * 配对闭包在段级压缩下仍闭合。
 */
import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  buildSegmentStub,
  compactBySegments,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTextTokens,
  expandToolPairs,
  hasConstrainedFact,
  hasErrorSignal,
  inferPhase,
  isKeyMessage,
  keyHitLines,
  messageText,
  segmentContext,
  toolCallIdsOf,
  toolResultCallId,
  type ContextSegment,
} from './context-manager';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

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
function toolCall(id: string, name: string, args: unknown): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }],
    timestamp: 2,
  } as unknown as AgentMessage;
}

/**
 * 标准超阈值会话(采样锚定/布局用):
 *   seg0 anchor  任务锚(小)
 *   seg1 recon   nmap 扫描,非 key,大 → 可压缩
 *   seg2 analysis grep 审计 + exit=1 死路 → key 段(必保)
 *   seg3 construction payload 脚本,非 key,大 → 可压缩
 *   seg4 execution 运行 exploit(末尾段,当前阶段必保)
 */
function sampleSession(): AgentMessage[] {
  return [
    user('总任务:渗透 10.0.0.5'),                                     // seg0 anchor
    user('用 nmap 扫描目标端口'),                                       // seg1 recon
    toolResult(`exit=0\n22 80 443 ${'p'.repeat(3000)}`, 'c1'),
    user('grep 审计源码找漏洞'),                                        // seg2 analysis(key)
    toolResult('exit=1\n目标文件不存在,此路不通', 'c2'),
    user('写 payload 脚本'),                                           // seg3 construction
    assistant(`构造 PoC 如下 ${'r'.repeat(2000)}`),
    user('运行 exploit 拿 shell'),                                     // seg4 execution(当前阶段)
    toolResult('exit=0\n会话已开,继续', 'c3'),
  ];
}

// ---------------------------------------------------------------------------
// 切分边界(设计 §2.1)
// ---------------------------------------------------------------------------

describe('segmentContext — 切分边界', () => {
  it('以 user 消息为界:一条 user 起到下一条 user 前为一段', () => {
    const msgs = [user('t1'), assistant('a'), toolResult('r1'), user('t2'), assistant('b')];
    const segs = segmentContext(msgs);
    expect(segs).toHaveLength(2);
    expect([segs[0].start, segs[0].end]).toEqual([0, 3]);
    expect([segs[1].start, segs[1].end]).toEqual([3, 5]);
  });

  it('首个 user 之前的消息并入段 0;空输入返回空', () => {
    const segs = segmentContext([assistant('游离'), user('t1'), assistant('a')]);
    expect(segs).toHaveLength(1);
    expect([segs[0].start, segs[0].end]).toEqual([0, 3]);
    expect(segmentContext([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 相位推断(含继承粘性、打平取靠后)
// ---------------------------------------------------------------------------

describe('segmentContext — 相位推断', () => {
  it('五族信号各自命中:recon/analysis/construction/execution/evaluation', () => {
    expect(inferPhase('nmap 扫描 + 子域名枚举', undefined, false)).toBe('recon');
    expect(inferPhase('grep 审计数据流,readelf 反汇编', undefined, false)).toBe('analysis');
    expect(inferPhase('写 exp 和 PoC,payload 脚本', undefined, false)).toBe('construction');
    expect(inferPhase('运行 exploit,fuzz 起跑', undefined, false)).toBe('execution');
    expect(inferPhase('验证复测,flag 命中,结论判定', undefined, false)).toBe('evaluation');
  });

  it('无信号继承上一段 phase(研究阶段粘性,但不继承 anchor);首段恒 anchor', () => {
    const msgs = [
      user('用 nmap 扫描目标'),   // 首段恒 anchor,即使带侦察信号
      user('继续刚才的方向'),      // 无信号 → 不继承 anchor(任务陈述不是研究阶段),落 recon 缺省
      user('grep 审计源码'),      // analysis
      user('继续看'),             // 无信号 → 继承 analysis(粘性)
    ];
    const segs = segmentContext(msgs);
    expect(segs.map((s) => s.phase)).toEqual(['anchor', 'recon', 'analysis', 'analysis']);
  });

  it('打平取研究循环中更靠后的阶段(信号共存视为工作已推进)', () => {
    // payload(construction)与 exploit(execution)各 1 分打平 → execution
    expect(inferPhase('payload 就绪,exploit 运行', undefined, false)).toBe('execution');
  });

  it('garak 命中 recon(AI 安全侦察信号)', () => {
    expect(inferPhase('garak 跑一遍模型探针', undefined, false)).toBe('recon');
  });
});

// ---------------------------------------------------------------------------
// 标注(设计 §2.2)
// ---------------------------------------------------------------------------

describe('segmentContext — 标注', () => {
  it('tokens 按 CJK 校准口径(estimateMessageTokens 求和,1.2.7 活体校准)', () => {
    const msgs = [user('x'.repeat(400)), assistant('y'.repeat(200))];
    const segs = segmentContext(msgs);
    expect(segs[0].tokens).toBe(estimateMessageTokens(msgs[0]) + estimateMessageTokens(msgs[1]));
  });

  it('age = 距末尾段数;末段 age 0', () => {
    const segs = segmentContext([user('a'), user('b'), user('c')]);
    expect(segs.map((s) => s.age)).toEqual([2, 1, 0]);
  });

  it('工具名录:段内 toolCall 名去重保序', () => {
    const msgs = [
      user('任务'),
      toolCall('c1', 'env_exec', { command: 'ls' }),
      toolResult('exit=0\nok', 'c1'),
      toolCall('c2', 'env_exec', { command: 'pwd' }),
      toolCall('c3', 'research_log', { note: 'x' }),
    ];
    const segs = segmentContext(msgs);
    expect(segs[0].toolNames).toEqual(['env_exec', 'research_log']);
  });

  it('key 命中行摘录原文;hasKey 标记 key 段', () => {
    const segs = segmentContext(sampleSession());
    const seg2 = segs[2];
    expect(seg2.hasKey).toBe(true);
    expect(seg2.keyHits.some((l) => l.includes('exit=1'))).toBe(true);
    expect(segs[1].hasKey).toBe(false);
    expect(segs[1].keyHits).toEqual([]);
  });

  it('keyHitLines 限 3 行、每行 120 字符(stub 必须矮)', () => {
    const lines = Array.from({ length: 6 }, (_, i) => `exit=${i + 1} ${'k'.repeat(200)}`).join('\n');
    const hits = keyHitLines(lines);
    expect(hits).toHaveLength(3);
    for (const h of hits) expect(h.length).toBeLessThanOrEqual(121); // 120 + '…'
  });
});

// ---------------------------------------------------------------------------
// 存活契约扩展(设计 §2.4,三族 + error 收窄不动)
// ---------------------------------------------------------------------------

describe('isKeyMessage — 1.2.7 新三族', () => {
  it('中文突破/约束族:拿到shell/提权/复现/利用成功/突破口/不可写/拒绝访问', () => {
    expect(isKeyMessage(assistant('拿到shell, stabilized'))).toBe(true);
    expect(isKeyMessage(toolResult('exit=0\n权限提升至 root'))).toBe(true);
    expect(isKeyMessage(assistant('提权成功'))).toBe(true);
    expect(isKeyMessage(assistant('复现成功,可稳定触发'))).toBe(true);
    expect(isKeyMessage(assistant('利用成功'))).toBe(true);
    expect(isKeyMessage(assistant('找到突破口:配置目录'))).toBe(true);
    expect(isKeyMessage(toolResult('exit=0\n目标分区不可写'))).toBe(true);
    expect(isKeyMessage(toolResult('exit=0\n拒绝访问'))).toBe(true);
  });

  it('exit=0 约束事实:成功退出 + 排除性结论词才收', () => {
    expect(hasConstrainedFact('exit=0\ncp: /root/x 不可写')).toBe(true);
    expect(hasConstrainedFact('exit=0\nfile not found')).toBe(true);
    expect(hasConstrainedFact('exit=0\nservice unavailable')).toBe(true);
    expect(hasConstrainedFact('exit=0\n目标端口已关闭')).toBe(true);
    expect(isKeyMessage(toolResult('exit=0\n目标路径不存在'))).toBe(true);
    // 无排除词/非 exit=0 → 不收
    expect(hasConstrainedFact('exit=0\n一切正常')).toBe(false);
    expect(isKeyMessage(toolResult('exit=0\n--- stdout ---\nok'))).toBe(false);
    expect(hasConstrainedFact('exit=1\nnot found')).toBe(false); // exit≠0 走原 exit 族即可
  });

  it('fuzz 崩溃信号族:SIG*/ASAN/core dumped/crash', () => {
    expect(isKeyMessage(toolResult('SIGSEGV at 0xdeadbeef'))).toBe(true);
    expect(isKeyMessage(toolResult('SIGABRT (core dumped)'))).toBe(true);
    expect(isKeyMessage(toolResult('AddressSanitizer: heap-buffer-overflow'))).toBe(true);
    expect(isKeyMessage(toolResult('SUMMARY: ASAN reported 1 issue'))).toBe(true);
    expect(isKeyMessage(toolResult('the program crashed after 3 runs'))).toBe(true);
    expect(isKeyMessage(toolResult('SIGILL/SIGFPE 都出现过'))).toBe(true);
    // 常规输出不误收
    expect(isKeyMessage(toolResult('exit=0\nLinux fuzz'))).toBe(false);
    expect(isKeyMessage(user('查一下内核版本'))).toBe(false);
  });

  it('error 收窄语义不动(1.2.6):良性搭配剥离后再判', () => {
    expect(hasErrorSignal('编译通过,no error')).toBe(false);
    expect(hasErrorSignal('这条路径的 error handling 已覆盖')).toBe(false);
    expect(hasErrorSignal('Error: segfault at 0x0')).toBe(true);
    expect(hasErrorSignal('ret: no error; later: error: timeout')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stub 形态(设计 §2.5)
// ---------------------------------------------------------------------------

describe('buildSegmentStub — stub 形态', () => {
  it('合法 user 消息:段号/phase/命中行原文摘录/工具名录/存档指针', () => {
    const seg: ContextSegment = {
      index: 3, start: 0, end: 0, phase: 'recon', tokens: 100,
      toolNames: ['env_exec', 'research_log'],
      keyHits: ['exit=1 端口不可写'],
      hasKey: true, age: 5,
    };
    const stub = buildSegmentStub(seg);
    expect(stub.role).toBe('user'); // 不伪造 assistant 发言
    const text = messageText(stub);
    expect(text).toContain('段#3');
    expect(text).toContain('recon');
    expect(text).toContain('「exit=1 端口不可写」'); // 命中行是原文摘录
    expect(text).toContain('env_exec/research_log');
    expect(text).toContain('会话存档');
  });

  it('无命中/无工具时的兜底文案', () => {
    const seg: ContextSegment = {
      index: 1, start: 0, end: 0, phase: 'analysis', tokens: 10,
      toolNames: [], keyHits: [], hasKey: false, age: 2,
    };
    const text = messageText(buildSegmentStub(seg));
    expect(text).toContain('无关键命中');
    expect(text).toContain('无工具调用');
  });
});

// ---------------------------------------------------------------------------
// 采样锚定 + 布局(设计 §2.3 / §2.5)
// ---------------------------------------------------------------------------

describe('compactBySegments — 采样锚定', () => {
  it('超阈值会话:压后达标且 anchor/当前阶段/key 段原文全存', () => {
    const msgs = sampleSession();
    const segs = segmentContext(msgs);
    expect(segs.map((s) => s.phase)).toEqual([
      'anchor', 'recon', 'analysis', 'construction', 'execution',
    ]);
    const target = 500; // 必保集(anchor+key seg2+当前阶段 seg4)远小于此
    const r = compactBySegments(msgs, segs, target);
    expect(r.reachedTarget).toBe(true);
    expect(estimateMessagesTokens(r.messages)).toBeLessThanOrEqual(target);

    // anchor 原文在头
    expect(r.messages[0]).toBe(msgs[0]);
    // 可压缩段(seg1/seg3)被 stub 化:非 user 原文消失,stub 居中按段序;
    // 1.5.3:段内 user 消息原文必保(用户指令永不裁)
    expect(r.messages).toContain(msgs[1]); // seg1 的 user 原文存活
    expect(r.messages).not.toContain(msgs[2]); // seg1 的 toolResult 被裁
    expect(r.messages).toContain(msgs[5]); // seg3 的 user 原文存活
    expect(r.messages).not.toContain(msgs[6]); // seg3 的 assistant 被裁
    const stubs = r.messages.filter((m) => messageText(m).startsWith('[段#'));
    expect(stubs.map((m) => messageText(m))).toEqual([
      expect.stringContaining('[段#1 recon 已压缩]'),
      expect.stringContaining('[段#3 construction 已压缩]'),
    ]);
    // key 段(seg2)与当前阶段(seg4)原文全存,当前阶段在尾
    expect(r.messages).toContain(msgs[3]);
    expect(r.messages).toContain(msgs[4]);
    expect(r.messages).toContain(msgs[7]);
    expect(r.messages).toContain(msgs[8]);
    expect(r.messages[r.messages.length - 1]).toBe(msgs[8]);
    // stub 全是合法 user 消息
    for (const s of stubs) expect(s.role).toBe('user');
    // prunedCount = 净裁数(1.5.3:user 原文保留,净裁 = 段体量 - user 消息)
    expect(r.prunedCount).toBe(2);
    expect(r.stubbedSegments).toBe(2);
  });

  it('削减量 Δ 达标即停:不从最老段起无差别全 stub', () => {
    const msgs = sampleSession();
    const segs = segmentContext(msgs);
    // 目标宽松到只需 stub 最老的 seg1 即达标(seg3 原文保留)。
    // 1.5.3:stub 后段内 user 原文保留——实际削减 = 段 tokens - user 原文
    // - stub 卡,目标按此口径算(不是整段消失的旧口径)。
    const seg1Savings =
      segs[1].tokens
      - estimateMessageTokens(msgs[1]) // user 原文保留
      - estimateMessageTokens(buildSegmentStub(segs[1]));
    const total = estimateMessagesTokens(msgs);
    const target = total - seg1Savings + 50;
    const r = compactBySegments(msgs, segs, target);
    expect(r.stubbedSegments).toBe(1);
    expect(r.messages).toContain(msgs[5]); // seg3 原文还在
    expect(r.messages).toContain(msgs[6]);
    expect(estimateMessagesTokens(r.messages)).toBeLessThanOrEqual(target);
  });

  it('必保集本身超目标 → stub 无可压,reachedTarget=false(交给第二档)', () => {
    const msgs = [
      user(`任务 ${'x'.repeat(2000)}`),                 // anchor 本身就超
      user('nmap 扫描'),
      toolResult('exit=0\n扫完'),
    ];
    const segs = segmentContext(msgs);
    const r = compactBySegments(msgs, segs, 100);
    expect(r.reachedTarget).toBe(false);
    expect(r.messages[0]).toBe(msgs[0]); // anchor 必保不动
  });

  it('末尾 phase 的所有段都必保(当前阶段不止末段)', () => {
    const msgs = [
      user('任务'),
      user('nmap 扫描'),                                     // seg1 recon 可压缩
      toolResult(`exit=0\n${'q'.repeat(2000)}`),
      user('运行 exploit'),                                   // seg2 execution
      assistant('继续执行'),                                  // seg2 内
      user('再跑一遍'),                                       // seg3 无信号继承 execution
    ];
    const segs = segmentContext(msgs);
    expect(segs.map((s) => s.phase)).toEqual(['anchor', 'recon', 'execution', 'execution']);
    const r = compactBySegments(msgs, segs, 50); // 目标极小:可压的只有 seg1
    expect(r.messages).toContain(msgs[3]); // seg2 execution 必保
    expect(r.messages).toContain(msgs[5]); // seg3 继承 execution 同样必保
    // 1.5.3:seg1 被 stub——user 原文必保,toolResult 被裁
    expect(r.messages).toContain(msgs[1]);
    expect(r.messages).not.toContain(msgs[2]);
  });
});

// ---------------------------------------------------------------------------
// tool 配对闭包(段级压缩下仍闭合)
// ---------------------------------------------------------------------------

describe('compactBySegments — tool 配对闭包仍闭合', () => {
  it('整段取舍:被 stub 的段 call/result 同去,key 段同留', () => {
    const callOld = toolCall('c-old', 'env_exec', { command: 'nmap -sV t' });
    const resOld = toolResult('exit=0\nplain', 'c-old');
    const callKey = toolCall('c-key', 'env_exec', { command: 'cat CVE-2024-1086.txt' });
    const resKey = toolResult('exit=0\nplain', 'c-key');
    const msgs = [
      user('任务'),
      user('nmap 扫描'),       // seg1 可压缩,含完整配对
      callOld,
      resOld,
      user('看漏洞文件'),       // seg2 key(CVE 命中),含完整配对
      callKey,
      resKey,
      user('运行 exploit'),    // seg3 当前阶段
    ];
    const segs = segmentContext(msgs);
    const r = compactBySegments(msgs, segs, 5);
    // 被 stub 的段:call 与 result 一起消失,不留半对
    expect(r.messages).not.toContain(callOld);
    expect(r.messages).not.toContain(resOld);
    // key 段:call 与 result 一起存活
    expect(r.messages).toContain(callKey);
    expect(r.messages).toContain(resKey);
    // 闭包不动点校验:对全保留集跑 expandToolPairs 不再扩张
    const keptAll = new Set(r.messages.map((_, i) => i));
    expect(expandToolPairs(r.messages, keptAll).size).toBe(r.messages.length);
    // 双向成对:每个 toolResult 都能找到其 toolCall,反之亦然
    const callIds = new Set(r.messages.flatMap((m) => toolCallIdsOf(m)));
    for (let i = 0; i < r.messages.length; i++) {
      const cid = toolResultCallId(r.messages[i]);
      if (cid !== undefined) expect(callIds.has(cid)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 裁后重估口径(设计 §2.6)
// ---------------------------------------------------------------------------

describe('estimateMessagesTokens — 纯估算(CJK 校准),不吃 usage 锚', () => {
  it('assistant 携带 usage 锚时仍按纯估算', () => {
    const withUsage = {
      role: 'assistant',
      content: [{ type: 'text', text: '短回复' }],
      stopReason: 'stop',
      usage: { input: 400_000, output: 100_000, cacheRead: 0, cacheWrite: 0, totalTokens: 500_000 },
      timestamp: 2,
    } as unknown as AgentMessage;
    const msgs = [user('任务'), withUsage];
    // 纯估算:两条短消息,远低于 usage 锚的 500K
    expect(estimateMessagesTokens(msgs)).toBe(estimateMessageTokens(msgs[0]) + estimateMessageTokens(msgs[1]));
    expect(estimateMessagesTokens(msgs)).toBeLessThan(100);
    // 系统提示按 chars/2(中英混合保守口径)计入
    expect(estimateMessagesTokens(msgs, 4000)).toBe(estimateMessagesTokens(msgs) + 2000);
  });

  it('CJK 校准:中文文本估算显著高于 chars/4(活体实测低估 2.3 倍的修复)', () => {
    const cjk = estimateTextTokens('中文内容'.repeat(250)); // 1000 个 CJK 字符
    const ascii = estimateTextTokens('a'.repeat(1000));
    expect(cjk).toBe(1000);        // CJK ≈ 1 tok/字符(chars/4 只给 250)
    expect(ascii).toBe(400);       // ascii ≈ 2.5 字符/tok
  });
});

describe('段内子段切分(1.2.7 场景实测 S4/E5 修正:单任务长会话巨型段)', () => {
  it('超 MAX_SEGMENT_MESSAGES 的段在工具轮边界切子段;toolResult 永不作子段起点(配对不拆)', () => {
    const msgs: AgentMessage[] = [user('一个长任务')];
    for (let i = 0; i < 10; i++) {
      msgs.push(toolCall(`tc${i}`, 'env_exec', { command: `cat f${i}` }));
      msgs.push(toolResult(`out ${i}`, `tc${i}`));
    }
    const segs = segmentContext(msgs);
    expect(segs.length).toBeGreaterThan(1); // 21 条消息 > 12 上限 → 切子段
    for (const s of segs) {
      // 子段起点必是 user 或带 toolCall 的 assistant,绝不 toolResult
      expect(msgs[s.start].role).not.toBe('toolResult');
      // 子段内 tool 配对自闭合(toolCall 与其 toolResult 同段)
      const slice = msgs.slice(s.start, s.end);
      const calls = slice.flatMap(toolCallIdsOf);
      const results = slice.map(toolResultCallId).filter(Boolean);
      for (const id of results) expect(calls).toContain(id);
      for (const id of calls) expect(results).toContain(id);
    }
  });

  it('当前阶段全量保留收窄到最近 KEEP_CURRENT_PHASE_SEGMENTS 段,更老同相位段可 stub(长会话不再空转)', () => {
    const msgs: AgentMessage[] = [user('长期侦察任务')];
    for (let i = 0; i < 19; i++) {
      msgs.push(user(`继续第 ${i} 步`)); // 无信号 → recon(不继承 anchor)
      msgs.push(toolResult('o'.repeat(800), `x${i}`));
    }
    const segs = segmentContext(msgs);
    expect(segs.every((s) => s.phase === 'recon' || s.phase === 'anchor')).toBe(true);
    const r = compactBySegments(msgs, segs, 1_000, 0);
    expect(r.stubbedSegments).toBeGreaterThan(0);
    const texts = r.messages.map((m) => String((m as { content?: unknown }).content ?? ''));
    expect(texts[0]).toContain('长期侦察任务');       // anchor 全保
    expect(texts.some((t) => t.includes('继续第 18 步'))).toBe(true); // 最近段全保
  });
});
