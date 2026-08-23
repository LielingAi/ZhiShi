/**
 * 1.2.7 场景实测（非单测断言之外,带度量输出）——用户指定的六个场景 +
 * 极端场景,全链路走真实模块:segmentContext → resolveSessionDomain →
 * compactBySegments / makeCompactionTransform → 布局产物检验。
 *
 * 六个场景(用户 2026-08-20 指定):
 *   S1  web 渗透 ↔ 代码审计 同会话来回切换
 *   S2  二进制 ↔ 代码审计 同会话来回切换
 *   S3  二进制 ↔ 代码审计切换中相位不断切换(churn)
 *   S4  消息过多、历史在头部,检验是否「压缩过剩」
 *   S5  当前数据被误判压缩 / 压缩错误
 *   S6  环境与相位判断错误 → 压缩损失
 *
 * 极端场景:
 *   E1  fuzz 崩溃刷屏(每条命中存活契约 → 必保集超阈值)
 *   E2  单巨型段(一条 500KB toolResult)
 *   E3  单段会话(anchor==当前阶段)
 *   E4  无 user 消息的退化输入
 *   E5  1M 级历史的 transform 耗时(性能上界)
 *
 * 度量口径:key 事实存活率(应 100%)、非 key 细节存活率(允许丢失,
 * 丢失量即「压缩损失」的实测量)、tool 配对闭合、域判定轨迹。
 */

import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { loadDomainManifests } from '../../shared/domain-manifest';
import { resolveSessionDomain, type SecurityCapabilitiesData } from '../system-prompt-security';
import { filterAgentsByDomain } from '../agents/bundled-agents';
import { compactBySegments, estimateMessagesTokens, segmentContext } from './context-manager';
import { makeCompactionTransform } from './compaction';
import { filterSkillsByDomain, type SkillPack } from './skills';

// ---------------------------------------------------------------------------
// 消息工厂(贴近真实 env_exec 交互形态)
// ---------------------------------------------------------------------------

let ts = 0;
const user = (text: string): AgentMessage =>
  ({ role: 'user', content: text, timestamp: ++ts }) as unknown as AgentMessage;
const assistantText = (text: string): AgentMessage =>
  ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: ++ts }) as unknown as AgentMessage;
const envExecTurn = (id: string, command: string, output: string): AgentMessage[] => [
  {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'env_exec', arguments: { command } }],
    timestamp: ++ts,
  } as unknown as AgentMessage,
  { role: 'toolResult', toolCallId: id, content: [{ type: 'text', text: output }], timestamp: ++ts } as unknown as AgentMessage,
];

/** 各域真实形态的一轮(命令 + 输出)。 */
const pentestTurn = (id: string) =>
  envExecTurn(id, 'nmap -sV 192.168.1.10', '22/tcp open ssh\n80/tcp open http\n[+] 发现了开放端口');
const pentestShellTurn = (id: string) =>
  envExecTurn(id, 'msfconsole -x exploit', 'session 1 opened\n[+] 拿到shell: meterpreter 会话已建立');
const whiteboxTurn = (id: string) =>
  envExecTurn(id, 'opengrep scan .', '12 findings\nseverity: error\nCWE-89 sql-injection at login.php:42');
const binaryCrashTurn = (id: string) =>
  envExecTurn(id, './vuln $(python -c "print(600*\'A\')")', 'Program received signal SIGSEGV at 0x41414141\ncore dumped');
const binaryAnalysisTurn = (id: string) =>
  envExecTurn(id, 'gdb -batch -ex bt ./core', '#0 0x41414141 in ?? ()\n数据流分析: 偏移 520');
const fillerTurn = (id: string, chars = 2000) =>
  envExecTurn(id, 'cat /tmp/notes', '噪声数据 '.repeat(chars / 5 | 0).slice(0, chars));

const HOST_CAPS: SecurityCapabilitiesData = {
  engines: { engines: [] }, recipes: [], environments: [], selection: { kind: 'host' },
} as unknown as SecurityCapabilitiesData;

const MANIFESTS = loadDomainManifests();

// ---------------------------------------------------------------------------
// 检验工具
// ---------------------------------------------------------------------------

/** tool_use/tool_result 配对闭合(API 契约:缺一报 400)。 */
function toolPairsClosed(messages: AgentMessage[]): boolean {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && typeof b === 'object' && (b as { type?: string }).type === 'toolCall') {
          callIds.add(String((b as { id?: unknown }).id));
        }
      }
    }
    if (m.role === 'toolResult') {
      const id = (m as { toolCallId?: unknown }).toolCallId;
      if (typeof id === 'string') resultIds.add(id);
    }
  }
  for (const id of resultIds) if (!callIds.has(id)) return false;
  for (const id of callIds) if (!resultIds.has(id)) return false;
  return true;
}

/** 文本全集(stub 摘录也计入——测「关键信息是否还可得」)。 */
function allText(messages: AgentMessage[]): string {
  return messages
    .map((m) => {
      const c = (m as { content?: unknown }).content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        return c.map((b) => (b && typeof b === 'object' ? String((b as { text?: unknown }).text ?? '') : '')).join('\n');
      }
      return '';
    })
    .join('\n');
}

async function runTransform(messages: AgentMessage[], contextWindow: number, systemPromptChars = 14_000) {
  const infos: Array<{ prunedCount: number; stubbedSegments?: number; stillOverThreshold?: boolean }> = [];
  const transform = makeCompactionTransform({ contextWindow, systemPromptChars }, (i) => infos.push(i));
  const out = await transform(messages);
  return { out, infos, tokens: estimateMessagesTokens(out, systemPromptChars) };
}

// ---------------------------------------------------------------------------
// S1/S2 — 跨域来回切换
// ---------------------------------------------------------------------------

describe('S1/S2 跨域来回切换(web渗透↔代码审计 / 二进制↔代码审计)', () => {
  it('S1: pentest↔whitebox 切换,域判定跟随最近信号;压缩后两域关键事实均可得', async () => {
    const msgs: AgentMessage[] = [user('先对 192.168.1.10 做 web 渗透,再审计它的源码')];
    // 渗透段(侦察→拿 shell)
    for (let i = 0; i < 4; i++) msgs.push(...pentestTurn(`p${i}`));
    msgs.push(...pentestShellTurn('ps'));
    // 切到代码审计
    msgs.push(user('渗透差不多了,把源码拉下来做代码审计'));
    for (let i = 0; i < 6; i++) msgs.push(...whiteboxTurn(`w${i}`));
    // 再切回渗透
    msgs.push(user('审计发现一个注入点,回环境里验证'));
    msgs.push(...pentestShellTurn('ps2'));

    // 域判定轨迹:host 无基线,纯信号驱动
    const domainAt = (n: number) => resolveSessionDomain(msgs.slice(0, n), HOST_CAPS, MANIFESTS);
    const dPentest = domainAt(1 + 4 * 2 + 2);       // 渗透段末
    const dWhitebox = domainAt(msgs.length - 3);     // 审计段末(切回渗透前)
    const dBack = domainAt(msgs.length);             // 切回渗透后
    console.log(`[S1] 域轨迹: pentest段末=${dPentest} → whitebox段末=${dWhitebox} → 切回=${dBack}`);
    expect(dPentest).toBe('pentest');
    expect(dWhitebox).toBe('whitebox');

    // 压缩(小窗口强制触发)
    const { out, infos } = await runTransform(msgs, 20_000);
    const text = allText(out);
    // 两域关键事实都可得(原文或 stub 摘录):shell 会话 / CWE 命中
    expect(text).toContain('session 1 opened');
    expect(text).toContain('CWE-89');
    expect(toolPairsClosed(out)).toBe(true);
    console.log(`[S1] 压缩: ${msgs.length}→${out.length} 条, stub ${infos[0]?.stubbedSegments ?? 0} 段, 两域关键事实存活`);
  });

  it('S2: binary↔whitebox 切换,崩溃信号与 CWE 跨切换存活', async () => {
    const msgs: AgentMessage[] = [user('fuzz 这个二进制,同时审计配套源码')];
    for (let i = 0; i < 3; i++) msgs.push(...binaryCrashTurn(`b${i}`));
    msgs.push(user('先看源码'));
    for (let i = 0; i < 5; i++) msgs.push(...whiteboxTurn(`w${i}`));
    msgs.push(user('回二进制侧确认崩溃点'));
    for (let i = 0; i < 2; i++) msgs.push(...binaryAnalysisTurn(`ba${i}`));

    const dBinary = resolveSessionDomain(msgs.slice(0, 7), HOST_CAPS, MANIFESTS);
    const dWhitebox = resolveSessionDomain(msgs.slice(0, 8 + 10), HOST_CAPS, MANIFESTS);
    console.log(`[S2] 域轨迹: binary段末=${dBinary} → whitebox段末=${dWhitebox}`);
    expect(dBinary).toBe('binary');
    expect(dWhitebox).toBe('whitebox');

    const { out } = await runTransform(msgs, 16_000);
    const text = allText(out);
    expect(text).toContain('SIGSEGV');
    expect(text).toContain('CWE-89');
    expect(toolPairsClosed(out)).toBe(true);
    console.log(`[S2] 压缩后 SIGSEGV/CWE-89 均可得, tool 配对闭合`);
  });
});

// ---------------------------------------------------------------------------
// S3 — 相位 churn(来回切换中相位不断变)
// ---------------------------------------------------------------------------

describe('S3 相位 churn(二进制↔审计来回切,相位持续变化)', () => {
  it('相位每段都变:布局重排后 tool 配对仍闭合、anchor/当前阶段完整', async () => {
    const msgs: AgentMessage[] = [user('二进制和代码审计交替推进')];
    // recon → analysis → execution → evaluation 交替,制造 churn;
    // 每步之间插 user 指令(真实多指令会话形态——段以 user 为界)。
    for (let i = 0; i < 4; i++) {
      msgs.push(user(`第 ${i} 轮:先扫一遍`));
      msgs.push(...pentestTurn(`c${i}a`));       // recon(nmap)
      msgs.push(user('切到源码审计'));
      msgs.push(...whiteboxTurn(`c${i}b`));      // analysis(审计)
      msgs.push(user('回环境验证利用'));
      msgs.push(...pentestShellTurn(`c${i}c`));  // execution(拿shell)
      msgs.push(user('看下崩溃的数据流'));
      msgs.push(...binaryAnalysisTurn(`c${i}d`));// analysis(数据流)
    }
    const segments = segmentContext(msgs);
    const phases = segments.map((s) => s.phase);
    console.log(`[S3] 相位序列: ${phases.join(' → ')}`);
    expect(new Set(phases).size).toBeGreaterThan(2); // 确实 churn

    const { out } = await runTransform(msgs, 24_000);
    expect(toolPairsClosed(out)).toBe(true);
    // anchor 在头
    expect((out[0] as { content?: unknown }).content).toContain('二进制和代码审计交替推进');
    // 尾段(当前阶段)原文完整保留
    const tail = allText(out.slice(-2));
    expect(tail).toContain('数据流分析');
    console.log(`[S3] churn 下配对闭合 / anchor 在头 / 当前阶段完整`);
  });
});

// ---------------------------------------------------------------------------
// S4 — 消息过多,检验「压缩过剩」
// ---------------------------------------------------------------------------

describe('S4 消息过多(历史在头部),压缩是否过剩', () => {
  it('300 段历史:达标即停(不多压)、key 事实 100% 存活、非 key 细节丢失可量化', async () => {
    const msgs: AgentMessage[] = [user('长期研究任务:渗透一个大型靶场')];
    const KEY_FACTS = 30;
    for (let i = 0; i < 300; i++) {
      if (i % 10 === 0 && i / 10 < KEY_FACTS) {
        // 每 10 段埋一个 key 事实(flag 形态命中存活契约)
        msgs.push(...envExecTurn(`k${i}`, 'cat flag.txt', `flag{fact-${i}}`));
      } else {
        msgs.push(...fillerTurn(`f${i}`));
      }
    }
    const before = estimateMessagesTokens(msgs, 14_000);
    // 窗口给到「只需压掉约 1/4」的位置:检验达标即停(不过剩压缩)
    const contextWindow = Math.floor(before / 0.8 / 1.33);
    const { out, infos, tokens } = await runTransform(msgs, contextWindow);
    const threshold = Math.floor(contextWindow * 0.8);
    const text = allText(out);

    let keySurvived = 0;
    for (let i = 0; i < 300; i += 10) {
      if (text.includes(`flag{fact-${i}}`)) keySurvived++;
    }
    const stubbed = infos[0]?.stubbedSegments ?? 0;
    console.log(
      `[S4] ${before} tok → ${tokens} tok(阈值 ${threshold});` +
      `stub ${stubbed}/300 段;key 事实存活 ${keySurvived}/${KEY_FACTS}`,
    );
    expect(tokens).toBeLessThanOrEqual(threshold);
    expect(keySurvived).toBe(KEY_FACTS);          // key 100% 存活
    expect(stubbed).toBeLessThan(300);            // 没有全压(过剩)
    expect(stubbed).toBeGreaterThan(0);
    expect(toolPairsClosed(out)).toBe(true);
    // 达标即停:stub 数应远小于可压段数(只需削 ~1/4)
    expect(stubbed).toBeLessThan(150);
  });
});

// ---------------------------------------------------------------------------
// S5 — 当前数据被误判压缩 / 压缩错误
// ---------------------------------------------------------------------------

describe('S5 当前数据误判压缩的边界', () => {
  it('尾段(当前工作)即使零关键词也永不压缩;中段误判时关键行进 stub 摘录', async () => {
    const msgs: AgentMessage[] = [user('研究目标 X')];
    // 中段:无关键词、无存活契约命中的「普通工作段」——会被 stub(实测损失形态)
    msgs.push(...envExecTurn('m1', './probe --deep /target', '探针返回: 42 个端点, 延迟分布见附表, 全部 200'));
    // 中段:无关键词但带关键行(exit 非零)——stub 摘录必须带上
    msgs.push(...envExecTurn('m2', './probe --auth /target', 'auth probe exit=1\n拒绝访问: token 失效'));
    // 尾段:当前工作,零关键词零命中——当前阶段必保,永不压缩
    msgs.push(user('把刚才的探针结果汇总成结论'));
    msgs.push(assistantText('正在汇总 42 个端点的延迟分布与鉴权失败原因'));

    const { out } = await runTransform(msgs, 8_000); // 小窗口强制触发
    const text = allText(out);
    // 当前工作(尾段)完整在
    expect(text).toContain('正在汇总 42 个端点');
    // 中段关键行进 stub 摘录(「exit=1」/「拒绝访问」命中存活契约)
    expect(text).toMatch(/exit=1|拒绝访问/);
    // 非关键细节(延迟分布附表)被 stub 掉——实测损失形态,记录在案
    console.log(`[S5] 尾段完整 / 中段关键行入 stub / 非关键细节丢失(设计内取舍)`);
    expect(toolPairsClosed(out)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// S6 — 环境与相位判断错误 → 压缩损失
// ---------------------------------------------------------------------------

describe('S6 域/相位误判下的实际损失', () => {
  it('域误判(二进制会话混入大量 CWE 文本)→ skills/子代理收窄到错域,但通用保留、压缩存活不受影响', async () => {
    const msgs: AgentMessage[] = [user('分析这个 crash 样本')];
    msgs.push(...binaryCrashTurn('b0'));
    // 误判源:正文中大量 CWE 引用(比如粘贴了一份审计报告)
    for (let i = 0; i < 6; i++) {
      msgs.push(...whiteboxTurn(`w${i}`));
    }
    const domain = resolveSessionDomain(msgs, HOST_CAPS, MANIFESTS);
    console.log(`[S6] 域判定(二进制意图 + CWE 刷屏): ${domain}`);

    const skills: SkillPack[] = [
      { id: 'binary-exploit', name: 'binary-exploit', description: '', body: '', source: 'bundled' },
      { id: 'pentest', name: 'pentest', description: '', body: '', source: 'bundled' },
      { id: 'task-alignment', name: 'task-alignment', description: '', body: '', source: 'bundled' },
    ];
    const kept = filterSkillsByDomain(skills, domain, MANIFESTS).map((s) => s.id);
    const agents = filterAgentsByDomain(
      [{ name: 'crash-triager' }, { name: 'vuln-hunter' }, { name: 'critic' }], domain, MANIFESTS,
    ).map((a) => a.name);
    console.log(`[S6] 误判为 ${domain} 后: skills 保留=${kept.join('/')} 子代理=${agents.join('/')}`);
    // 误判的实测代价:binary 专属被滤掉,但通用(task-alignment)保留
    expect(kept).toContain('task-alignment');
    // 压缩存活与域判定解耦:crash 事实仍可压缩后得
    const { out } = await runTransform(msgs, 12_000);
    expect(allText(out)).toContain('SIGSEGV');
    console.log(`[S6] 域误判不影响压缩存活(SIGSEGV 可得)——注入收窄是唯一代价,方向是窄不是错`);
  });
});

// ---------------------------------------------------------------------------
// 极端场景
// ---------------------------------------------------------------------------

describe('极端场景', () => {
  it('E1 fuzz 崩溃刷屏:每条命中存活契约 → 必保集超阈值,走截断 + stillOver,不炸不丢配对', async () => {
    const msgs: AgentMessage[] = [user('fuzz 长跑崩溃分拣')];
    for (let i = 0; i < 120; i++) {
      msgs.push(...binaryCrashTurn(`e${i}`));
      msgs.push(...fillerTurn(`ef${i}`, 3000));
    }
    const { out, infos, tokens } = await runTransform(msgs, 30_000);
    const threshold = Math.floor(30_000 * 0.8);
    console.log(
      `[E1] 崩溃刷屏: stub ${infos[0]?.stubbedSegments ?? 0} 段, ` +
      `压后 ${tokens} tok(阈值 ${threshold}), stillOver=${infos[0]?.stillOverThreshold === true}`,
    );
    expect(toolPairsClosed(out)).toBe(true);
    // 不管压没压下去:进程不炸、配对闭合、结果有界可报
    expect(out.length).toBeGreaterThan(0);
  });

  it('E2 单巨型段:一条 500KB toolResult → 段级不可拆,第二档截断兜底', async () => {
    const msgs: AgentMessage[] = [
      user(' dump 全量内存看看'),
      ...envExecTurn('big', 'xxd dump.bin', 'AB'.repeat(250_000)),
      user('分析这个 dump'),
      assistantText('正在分析内存转储'),
    ];
    const { out, infos } = await runTransform(msgs, 10_000);
    console.log(`[E2] 单巨型段: ${msgs.length}→${out.length} 条, stillOver=${infos[0]?.stillOverThreshold === true}`);
    expect(out.length).toBeGreaterThan(0); // 不炸
    expect(toolPairsClosed(out)).toBe(true);
  });

  it('E3 单段会话(anchor==当前阶段):无可压,原样或截断,绝不空转误删', async () => {
    const msgs: AgentMessage[] = [user('第一个任务'), ...pentestTurn('s1')];
    const { out, infos } = await runTransform(msgs, 100); // 窗口极小
    expect(out.length).toBeGreaterThan(0);
    expect(allText(out)).toContain('第一个任务');
    console.log(`[E3] 单段: anchor 原文存活, stubbed=${infos[0]?.stubbedSegments ?? 0}`);
  });

  it('E4 无 user 消息的退化输入:整体一段,不炸', async () => {
    const msgs: AgentMessage[] = [assistantText('孤儿回复'), ...pentestTurn('o1')];
    const { out } = await runTransform(msgs, 100);
    expect(out.length).toBeGreaterThan(0);
    console.log('[E4] 无 user 退化输入:整体一段,正常产出');
  });

  it('E5 1M 级历史的 transform 耗时上界(性能)', async () => {
    const msgs: AgentMessage[] = [user('超长会话')];
    // ~80 万 tokens(≈3.2M 字符)——1M 窗口的 80% 触发线
    for (let i = 0; i < 800; i++) msgs.push(...fillerTurn(`p${i}`, 4000));
    const started = Date.now();
    const segments = segmentContext(msgs);
    const result = compactBySegments(msgs, segments, 640_000, 14_000);
    const ms = Date.now() - started;
    console.log(`[E5] 800 段/~80 万 tok: 切分+压缩 ${ms}ms, stub ${result.stubbedSegments} 段`);
    expect(ms).toBeLessThan(3000); // 宽上界,防 O(n²) 回归
    expect(result.reachedTarget).toBe(true);
  });
});
