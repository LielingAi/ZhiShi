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
  estimateMessageTokens,
  hasConstrainedFact,
  hasErrorSignal,
  inferPhase,
  isKeyMessage,
  keyHitLines,
  segmentContext,
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
