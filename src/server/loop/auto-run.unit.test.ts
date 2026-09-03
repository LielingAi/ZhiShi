/**
 * loop/auto-run.ts 单测(1.4.1)— 纯函数(校验/驱动文本/预算/暂停点证据判定/
 * 验收包/记录编解码)+ runner 集成(全假依赖,不真连环境/不真落真库)。
 *
 * runner 集成覆盖三条主路径:达成→终审 pass 出报告、空转→harness 提请
 * (1.3.2 requestDecision)→继续跑、预算耗尽→续命→恢复;Esc 终止收尾。
 * 计时全部短轮询(pollMs=10),decision/declaration 用真实内存注册表(纯内存,
 * 不触网),记录落盘用临时目录。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import type { ResearchEvent } from '../memory/store';
import {
  autoRunFilePath,
  buildDockerTaskMd,
  buildDockerTaskMdWriteCommand,
  buildFirstTurnText,
  buildNextTurnText,
  buildVerdictPackage,
  computeBudgetSpent,
  countValidEventsSince,
  createAutoRunController,
  currentResearchPhase,
  detectRepeatedFailures,
  estimateLoopTokens,
  evaluateStall,
  findDecisionMarker,
  injectInteractiveWrapUp,
  isBudgetExhausted,
  isBudgetWarning,
  listAutoRunRecordFiles,
  loadAutoRunRecord,
  parseAutoRunRecord,
  recoverOrphanedAutoRuns,
  resetAutoRunRegistryForTest,
  resolveAutoRunVerdict,
  runAutoRunLoop,
  saveAutoRunRecord,
  serializeAutoRunRecord,
  startAutoRun,
  stopAutoRun,
  summarizeRecentToolCalls,
  validateAutoRunStart,
  verdictRequestOfRecord,
  withAutoRunDepDefaults,
  writeDockerTaskMdCheckpoint,
  type AutoRunDeps,
  type AutoRunRecord,
} from './auto-run';
import type { EnvironmentEntry } from '../../shared/config-types';
import type { EnvExec, EnvExecProcessResult } from './env-exec';
import { clearCompletionDeclarations, declareCompletion, takeCompletionDeclaration } from './declare-completion';
import { clearDecisions, pendingDecisions, requestDecision, respondDecision } from './decision';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-auto-run-'));
  clearCompletionDeclarations();
  clearDecisions();
  resetAutoRunRegistryForTest();
});

afterEach(() => {
  clearCompletionDeclarations();
  clearDecisions();
  resetAutoRunRegistryForTest();
  rmSync(dir, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<AutoRunRecord> = {}): AutoRunRecord {
  return {
    id: 'run-1',
    name: 'demo',
    envKey: 'pwn-vm',
    goal: '拿到 flag',
    budget: { kind: 'turns', limit: 50, spent: 0 },
    criteria: ['输出 flag{…}', 'PoC 稳定复现 3 次'],
    status: 'running',
    loopSessionId: 'ls-1',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    workspace: '/ws',
    ...overrides,
  };
}

function makeEvent(id: number, overrides: Partial<ResearchEvent> = {}): ResearchEvent {
  return {
    id,
    ts: 1_000_000 + id,
    workspace: '/ws',
    taskKind: 'binary',
    outcome: 'success',
    summary: `事件 #${id}`,
    ...overrides,
  };
}

function msgUser(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: Date.now() } as AgentMessage;
}

function msgToolResult(opts: { toolName?: string; isError?: boolean } = {}): AgentMessage {
  return {
    role: 'toolResult',
    toolName: opts.toolName ?? 'env_exec',
    isError: opts.isError === true,
    content: [{ type: 'text', text: 'x' }],
    timestamp: Date.now(),
  } as AgentMessage;
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface FakeDeps {
  deps: AutoRunDeps;
  invokeCount: number;
  messages: AgentMessage[];
  saved: AutoRunRecord[];
  sent: Array<{ event: string; data: unknown }>;
  appended: string[];
  events: ResearchEvent[];
}

function makeFakeDeps(overrides: Partial<AutoRunDeps> = {}): FakeDeps {
  const fake: FakeDeps = {
    deps: null as unknown as AutoRunDeps,
    invokeCount: 0,
    messages: [],
    saved: [],
    sent: [],
    appended: [],
    events: [],
  };
  fake.deps = withAutoRunDepDefaults({
    workspace: '/ws',
    invoke: async () => {
      fake.invokeCount += 1;
      return { text: `输出 ${fake.invokeCount}`, loopSessionId: 'ls-1' };
    },
    loadMessages: () => fake.messages,
    listEvents: () => fake.events,
    resolveEvent: () => null,
    appendUserMessage: async (_id, text) => { fake.appended.push(text); },
    snapshot: async () => ({ ok: true }),
    exportReport: async () => ({ ok: false, error: 'no-op' }),
    broadcast: (event, data) => { fake.sent.push({ event, data }); },
    save: (record) => { fake.saved.push(JSON.parse(JSON.stringify(record)) as AutoRunRecord); },
    now: () => Date.now(),
    log: () => {},
    pollMs: 10,
    ...overrides,
  });
  return fake;
}

const dataOf = (sent: Array<{ event: string; data: unknown }>, event: string): unknown =>
  sent.find((s) => s.event === event)?.data;

// ===== 启动校验 =====

describe('validateAutoRunStart', () => {
  const findEnv = (envKey: string) => (envKey === 'pwn-vm' ? { id: 'pwn-vm' } : undefined);

  it('合法输入 → 完整记录(预算 spent 归零)', () => {
    const r = validateAutoRunStart(
      { name: '  demo ', envKey: 'pwn-vm', goal: '拿到 flag', criteria: ['a', ' b '], budget: { kind: 'tokens', limit: 1000 } },
      { findEnv, now: () => 0, newId: () => 'run-x', loopSessionId: 'ls-x' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.id).toBe('run-x');
    expect(r.record.name).toBe('demo');
    expect(r.record.criteria).toEqual(['a', 'b']);
    expect(r.record.budget).toEqual({ kind: 'tokens', limit: 1000, spent: 0 });
    expect(r.record.loopSessionId).toBe('ls-x');
    expect(r.record.status).toBe('running');
  });

  it('环境未登记 → 可读错误', () => {
    const r = validateAutoRunStart(
      { name: 'demo', envKey: 'nope', goal: 'g', criteria: ['a'], budget: { kind: 'turns', limit: 1 } },
      { findEnv },
    );
    expect(r).toEqual({ ok: false, error: expect.stringContaining('未登记') as unknown as string });
  });

  it('缺必填/验收条件空/预算非法 → 各自可读错误', () => {
    const full = { name: 'n', envKey: 'pwn-vm', goal: 'g', criteria: ['a'], budget: { kind: 'turns', limit: 1 } };
    const expectError = (input: Record<string, unknown>, re: RegExp): void => {
      const r = validateAutoRunStart(input as never, { findEnv });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(re);
    };
    expect(validateAutoRunStart({ ...full, name: '  ' }, { findEnv }).ok).toBe(false);
    expectError({ envKey: 'pwn-vm', goal: 'g', criteria: ['a'], budget: { kind: 'turns', limit: 1 } }, /name/);
    expectError({ ...full, goal: ' ' }, /goal/);
    expectError({ ...full, criteria: [] }, /criteria/);
    expectError({ ...full, criteria: ['  '] }, /criteria/);
    expectError({ ...full, budget: { kind: 'hours', limit: 1 } }, /kind/);
    expectError({ ...full, budget: { kind: 'time', limit: 0 } }, /limit/);
  });
});

// ===== 驱动文本 =====

describe('buildFirstTurnText / buildNextTurnText', () => {
  it('首轮含目标/验收条件/研究纪律(留痕+declare_completion+request_decision)', () => {
    const text = buildFirstTurnText('拿到 flag', ['输出 flag{…}']);
    expect(text).toContain('拿到 flag');
    expect(text).toContain('输出 flag{…}');
    expect(text).toContain('research_log');
    expect(text).toContain('declare_completion');
    expect(text).toContain('request_decision');
    // 1.4.6 走查实证：档案纪律教学须进 auto-run 驱动文本(security kernel
    // 不注入 auto-run 场景,驱动文本是唯一的纪律通道——缺它档案采用率随采样漂移)。
    expect(text).toContain('research_archive');
    expect(text).toContain('V# 证据引用');
    expect(text).toContain('falsify/correct');
  });

  it('后续轮含上一轮结果截断;verdictNote 前置', () => {
    const prev = 'x'.repeat(3000);
    const text = buildNextTurnText('目标', prev, { verdictNote: '终审不通过', maxChars: 100 });
    expect(text).toContain('继续推进目标');
    expect(text).toContain('终审不通过');
    expect(text).toContain('…(截断)');
    expect(text).toContain('research_archive');
    expect(text.length).toBeLessThan(400);
  });

  it('1.5.0 确定性档案检查点：每 4 轮一插，非检查点轮不插', () => {
    // turn 从 0 起：(turn+1) % 4 === 0 → 第 4/8/12… 轮插检查点。
    expect(buildNextTurnText('目标', '上轮', { turn: 3 })).toContain('【档案检查点】');
    expect(buildNextTurnText('目标', '上轮', { turn: 7 })).toContain('【档案检查点】');
    expect(buildNextTurnText('目标', '上轮', { turn: 0 })).not.toContain('【档案检查点】');
    expect(buildNextTurnText('目标', '上轮', { turn: 1 })).not.toContain('【档案检查点】');
    expect(buildNextTurnText('目标', '上轮', { turn: 4 })).not.toContain('【档案检查点】');
    // 不传 turn → 不插（兼容旧调用）。
    expect(buildNextTurnText('目标', '上轮')).not.toContain('【档案检查点】');
    // 检查点与 verdictNote 兼容共存。
    expect(buildNextTurnText('目标', '上轮', { turn: 3, verdictNote: '继续跑' })).toContain('终审反馈');
    expect(buildNextTurnText('目标', '上轮', { turn: 3, verdictNote: '继续跑' })).toContain('【档案检查点】');
  });
});

// ===== 预算 =====

describe('computeBudgetSpent / isBudgetExhausted / isBudgetWarning / estimateLoopTokens', () => {
  it('三档口径:turns 计轮/tokens 计估算/time 计分钟', () => {
    expect(computeBudgetSpent({ kind: 'turns', limit: 9 }, { turns: 3, tokens: 0, elapsedMs: 0 })).toBe(3);
    expect(computeBudgetSpent({ kind: 'tokens', limit: 9 }, { turns: 3, tokens: 400, elapsedMs: 0 })).toBe(400);
    expect(computeBudgetSpent({ kind: 'time', limit: 9 }, { turns: 3, tokens: 0, elapsedMs: 120_000 })).toBe(2);
  });

  it('1.6.0:tokens 档 spent = 原始估算 × 校准系数(缺省 1,钳 [0.8, 6])', () => {
    expect(computeBudgetSpent({ kind: 'tokens', limit: 9 }, { turns: 0, tokens: 400, elapsedMs: 0, calibration: 2 })).toBe(800);
    // 缺省/非法 → 系数 1(原口径)。
    expect(computeBudgetSpent({ kind: 'tokens', limit: 9 }, { turns: 0, tokens: 400, elapsedMs: 0 })).toBe(400);
    expect(computeBudgetSpent({ kind: 'tokens', limit: 9 }, { turns: 0, tokens: 400, elapsedMs: 0, calibration: Number.NaN })).toBe(400);
    // 钳界照 compaction 学习侧 [0.8, 6]。
    expect(computeBudgetSpent({ kind: 'tokens', limit: 9 }, { turns: 0, tokens: 400, elapsedMs: 0, calibration: 100 })).toBe(2400);
    expect(computeBudgetSpent({ kind: 'tokens', limit: 9 }, { turns: 0, tokens: 400, elapsedMs: 0, calibration: 0.01 })).toBe(320);
    // 校准只作用 tokens 档,turns/time 不受影响。
    expect(computeBudgetSpent({ kind: 'turns', limit: 9 }, { turns: 3, tokens: 0, elapsedMs: 0, calibration: 2 })).toBe(3);
  });

  it('耗尽 = spent ≥ limit;警告 = 未耗尽且 ≥ 80%', () => {
    expect(isBudgetExhausted({ kind: 'turns', limit: 10 }, 10)).toBe(true);
    expect(isBudgetExhausted({ kind: 'turns', limit: 10 }, 9.9)).toBe(false);
    expect(isBudgetWarning({ kind: 'turns', limit: 100 }, 80)).toBe(true);
    expect(isBudgetWarning({ kind: 'turns', limit: 100 }, 100)).toBe(false);
    expect(isBudgetWarning({ kind: 'turns', limit: 100 }, 10)).toBe(false);
  });

  it('token 估算 = estimateMessageTokens 求和口径', () => {
    const tokens = estimateLoopTokens([msgUser('hello'), msgUser('世界')]);
    expect(tokens).toBe(estimateLoopTokens([msgUser('hello')]) + estimateLoopTokens([msgUser('世界')]));
    expect(estimateLoopTokens([])).toBe(0);
  });
});

// ===== 暂停点证据判定 =====

describe('countValidEventsSince(有效研究记录增量)', () => {
  it('按 sinceTs 过滤 + outcome 闭集(脏行不算)', () => {
    const events = [
      makeEvent(1, { ts: 100, outcome: 'success' }),
      makeEvent(2, { ts: 200, outcome: 'fail' }),
      makeEvent(3, { ts: 300, outcome: 'wrong' as never }), // 非法 outcome 不算
    ];
    expect(countValidEventsSince(events, 150)).toBe(1);
    expect(countValidEventsSince(events, 0)).toBe(2);
    expect(countValidEventsSince([], 0)).toBe(0);
  });
});

describe('evaluateStall(空转判定)', () => {
  it('无新增且阶段未推进 → streak 累加;达到阈值即 stalled', () => {
    expect(evaluateStall({ newValidEvents: 0, previousPhase: 'recon', phase: 'recon', stallStreak: 1 }, 2))
      .toEqual({ stallStreak: 2, stalled: true });
    expect(evaluateStall({ newValidEvents: 0, previousPhase: 'recon', phase: 'recon', stallStreak: 0 }, 6))
      .toEqual({ stallStreak: 1, stalled: false });
  });

  it('有新增/阶段推进/无基线(首轮)→ streak 清零', () => {
    expect(evaluateStall({ newValidEvents: 1, previousPhase: 'recon', phase: 'recon', stallStreak: 4 }, 6).stallStreak).toBe(0);
    expect(evaluateStall({ newValidEvents: 0, previousPhase: 'recon', phase: 'analysis', stallStreak: 4 }, 6).stallStreak).toBe(0);
    expect(evaluateStall({ newValidEvents: 0, previousPhase: undefined, phase: 'anchor', stallStreak: 4 }, 6).stallStreak).toBe(0);
  });
});

describe('detectRepeatedFailures(同类工具 isError 连击)', () => {
  it('尾部同类错误 ≥3 → 命中;非错误打断;换工具名重起组', () => {
    const three = [msgToolResult({ isError: true }), msgToolResult({ isError: true }), msgToolResult({ isError: true })];
    expect(detectRepeatedFailures(three, 3)).toEqual({ toolName: 'env_exec', streak: 3 });
    expect(detectRepeatedFailures(three.slice(0, 2), 3)).toBeNull();
    const interrupted = [msgToolResult({ isError: true }), msgToolResult(), msgToolResult({ isError: true }), msgToolResult({ isError: true })];
    expect(detectRepeatedFailures(interrupted, 2)).toEqual({ toolName: 'env_exec', streak: 2 });
    expect(detectRepeatedFailures([msgToolResult({ isError: true }), msgToolResult(), msgToolResult({ isError: true })], 2)).toBeNull();
    const mixed = [
      msgToolResult({ toolName: 'a', isError: true }),
      msgToolResult({ toolName: 'a', isError: true }),
      msgToolResult({ toolName: 'b', isError: true }),
      msgToolResult({ toolName: 'b', isError: true }),
      msgToolResult({ toolName: 'b', isError: true }),
    ];
    expect(detectRepeatedFailures(mixed, 3)).toEqual({ toolName: 'b', streak: 3 });
  });
});

describe('currentResearchPhase / summarizeRecentToolCalls(1.2.7 分类器复用)', () => {
  it('空历史 → anchor;段相位按 1.2.7 推断(末段胜出)', () => {
    expect(currentResearchPhase([])).toBe('anchor');
    const messages = [msgUser('开始'), msgUser('用 nmap 扫描子域名 枚举服务')];
    expect(currentResearchPhase(messages)).toBe('recon');
  });

  it('最近动作摘要 = 尾部消息 toolCall 名去重保序', () => {
    const assistant = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: '1', name: 'env_exec', arguments: {} }, { type: 'toolCall', id: '2', name: 'research_log', arguments: {} }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;
    expect(summarizeRecentToolCalls([assistant, assistant])).toEqual(['env_exec', 'research_log']);
  });
});

// ===== 验收包 =====

describe('buildVerdictPackage(证据预检)', () => {
  const resolveEvent = (id: number): ResearchEvent | null => (id === 1 ? makeEvent(1) : null);

  it('引用命中/未命中 → hit/miss 计数与 criteria 聚合状态', () => {
    const pkg = buildVerdictPackage({
      id: 'run-1',
      criteria: ['c1', 'c2'],
      declaration: { statement: '达成', evidenceRefs: [1, 9] },
      resolveEvent,
    });
    expect(pkg.hitCount).toBe(1);
    expect(pkg.missCount).toBe(1);
    expect(pkg.evidenceRefs[0]).toMatchObject({ id: 1, hit: true, outcome: 'success' });
    expect(pkg.evidenceRefs[1]).toEqual({ id: 9, hit: false });
    expect(pkg.criteriaPrecheck.map((c) => c.status)).toEqual(['partial', 'partial']);
  });

  it('全命中 → evidence;无引用 → none', () => {
    const all = buildVerdictPackage({ id: 'r', criteria: ['c'], declaration: { statement: 's', evidenceRefs: [1] }, resolveEvent });
    expect(all.criteriaPrecheck[0].status).toBe('evidence');
    const none = buildVerdictPackage({ id: 'r', criteria: ['c'], declaration: { statement: 's', evidenceRefs: [] }, resolveEvent });
    expect(none.criteriaPrecheck[0].status).toBe('none');
  });
});

// ===== 记录编解码 / 存储 =====

describe('serialize/parse/save/load/list/recover(存储纪律)', () => {
  it('编解码往返;坏 JSON/坏形状 → null', () => {
    const rec = makeRecord({ declaration: { statement: 's', evidenceRefs: [1] } });
    const parsed = parseAutoRunRecord(serializeAutoRunRecord(rec));
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe('run-1');
    expect(parsed?.budget).toEqual({ kind: 'turns', limit: 50, spent: 0 });
    expect(parsed?.declaration?.evidenceRefs).toEqual([1]);
    expect(parseAutoRunRecord('{bad json')).toBeNull();
    expect(parseAutoRunRecord(JSON.stringify({ id: 'x', loopSessionId: 'y', status: 'weird', budget: { kind: 'turns', limit: 1 } }))).toBeNull();
  });

  it('save → load → list;recover 把非终态标 stopped、终态不动', async () => {
    const running = makeRecord({ id: 'run-a' });
    const completed = makeRecord({ id: 'run-b', status: 'completed' });
    await saveAutoRunRecord(running, { dir });
    await saveAutoRunRecord(completed, { dir });
    expect(loadAutoRunRecord('run-a', { dir })?.status).toBe('running');
    expect(listAutoRunRecordFiles({ dir })).toHaveLength(2);
    const healed = await recoverOrphanedAutoRuns({ dir });
    expect(healed).toBe(1);
    expect(loadAutoRunRecord('run-a', { dir })?.status).toBe('stopped');
    expect(loadAutoRunRecord('run-a', { dir })?.pauseReason).toBe('sidecar-restart');
    expect(loadAutoRunRecord('run-b', { dir })?.status).toBe('completed');
    expect(autoRunFilePath('run/a', dir)).toBe(join(dir, 'runa.json'));
  });
});

// ===== 决策 marker =====

describe('findDecisionMarker(注入完成信号)', () => {
  it('命中末条决策块(取 choice);无 → null', () => {
    const messages = [
      msgUser('x'),
      { role: 'user', content: '决定', timestamp: 0, decision: { decisionId: 'dec-1', choice: '继续跑' } } as unknown as AgentMessage,
    ];
    expect(findDecisionMarker(messages, 'dec-1')).toEqual({ choice: '继续跑' });
    expect(findDecisionMarker(messages, 'dec-9')).toBeNull();
  });
});

// ===== runner 集成(全假依赖) =====

describe('runAutoRunLoop(达成→终审 pass 出报告)', () => {
  it('declare_completion → awaiting-verdict → verdict-requested → pass → completed + reportDir', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps({
      resolveEvent: (id) => (id === 1 ? makeEvent(1) : null),
      invoke: async () => {
        declareCompletion(record.loopSessionId, '全部达成,证据 #1', [1]);
        return { text: 'done', loopSessionId: record.loopSessionId };
      },
      exportReport: async () => ({ ok: true, reportDir: '/out/reports/2026' }),
    });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.sent.some((s) => s.event === 'auto-run:verdict-requested'));
    const vr = dataOf(fake.sent, 'auto-run:verdict-requested') as { criteria: string[]; evidence: { hitCount: number; missCount: number } };
    expect(vr.criteria).toEqual(record.criteria);
    expect(vr.evidence.hitCount).toBe(1);
    expect(record.status).toBe('awaiting-verdict');

    const r = ctl.resolveVerdict('pass');
    expect(r.ok).toBe(true);
    await done;
    await loop;
    expect(record.status).toBe('completed');
    expect(record.reportDir).toBe('/out/reports/2026');
    expect(dataOf(fake.sent, 'auto-run:completed')).toMatchObject({ id: 'run-1', outcome: 'passed' });
  });
});

describe('runAutoRunLoop(空转 → harness 提请 → 继续跑)', () => {
  it('连续 stallTurns 轮无新增且阶段不推进 → paused(stall)+requestDecision;继续跑恢复', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps({ stallTurns: 2 });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();

    await waitFor(() => fake.sent.some((s) => s.event === 'auto-run:paused' && (s.data as { reason: string }).reason === 'stall'));
    expect(record.status).toBe('paused');
    expect(record.pauseReason).toBe('stall');
    const paused = dataOf(fake.sent, 'auto-run:paused') as { recentTools: string[]; summary: string };
    expect(paused.recentTools).toEqual([]);
    // 1.6.0:paused 带 summary(stall = 最近动作摘要;无工具调用给占位)。
    expect(paused.summary).toBe('(无工具调用)');

    const pending = pendingDecisions().filter((d) => d.sessionId === record.loopSessionId);
    expect(pending).toHaveLength(1);
    respondDecision(pending[0].decisionId, '继续跑');
    fake.messages.push({
      role: 'user',
      content: '【人的决定】选择: 继续跑',
      timestamp: Date.now(),
      decision: { decisionId: pending[0].decisionId, choice: '继续跑' },
    } as unknown as AgentMessage);

    // 恢复推进:第 4 轮 turn-completed 的 payload.status 已回 running(事件序
    // 确定性断言,不读竞态中的 record)。stallTurns=2 时第 5 轮会再次提请,
    // 随后 requestStop 终止即可。
    await waitFor(() => fake.sent.some((s) =>
      s.event === 'auto-run:turn-completed' && (s.data as { turn: number }).turn >= 4));
    const resumed = dataOf(fake.sent, 'auto-run:turn-completed') as { status: string };
    expect(resumed.status).toBe('running');

    ctl.requestStop();
    await done;
    await loop;
    expect(record.status).toBe('stopped');
  });
});

describe('runAutoRunLoop(模型调用失败 → 人工接管，1.5.13 用户拍板)', () => {
  it('invoke 报错 → paused(provider-error)+决策提请；不静默续跑', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps({
      invoke: async () => { fake.invokeCount += 1; return { error: '503 Server Overloaded', text: '', loopSessionId: 'ls-1' }; },
    });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();

    await waitFor(() => fake.sent.some((s) =>
      s.event === 'auto-run:paused' && (s.data as { reason: string }).reason === 'provider-error'));
    expect(record.status).toBe('paused');
    expect(record.pauseReason).toBe('provider-error');
    // 1.6.0:paused 带 summary(provider-error = error 原文)。
    const paused = dataOf(fake.sent, 'auto-run:paused') as { summary: string };
    expect(paused.summary).toBe('503 Server Overloaded');
    // 只 invoke 了一次——没有静默续跑（旧形态会 sleep 后立刻第二轮）
    expect(fake.invokeCount).toBe(1);

    // 人工接管：决策面板作答「终止运行」→ stopped
    const pending = pendingDecisions().filter((d) => d.sessionId === record.loopSessionId);
    expect(pending).toHaveLength(1);
    respondDecision(pending[0].decisionId, '终止运行');
    fake.messages.push({
      role: 'user',
      content: '【人的决定】选择: 终止运行',
      timestamp: Date.now(),
      decision: { decisionId: pending[0].decisionId, choice: '终止运行' },
    } as unknown as AgentMessage);

    await done;
    await loop;
    expect(record.status).toBe('stopped');
  });
});

describe('runAutoRunLoop(预算耗尽 → 续命恢复)', () => {
  it('turns 预算耗尽 → paused(budget)+checkpoint;auto-run/budget 续命 → 恢复推进', async () => {
    const record = makeRecord({ budget: { kind: 'turns', limit: 1, spent: 0 } });
    const fake = makeFakeDeps();
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();

    await waitFor(() => fake.sent.some((s) => s.event === 'auto-run:paused' && (s.data as { reason: string }).reason === 'budget'));
    expect(record.status).toBe('paused');
    expect(record.pauseReason).toBe('budget');
    expect(record.budget.spent).toBe(1);

    // 非法续命:必须 > 已耗。
    expect(ctl.renewBudget(1).ok).toBe(false);
    const r = ctl.renewBudget(5);
    expect(r.ok).toBe(true);

    // 恢复推进:第 2 轮 turn-completed 的 payload 显示 running + 新上限(事件序
    // 确定性断言,不读竞态中的 record)。
    await waitFor(() => fake.sent.some((s) =>
      s.event === 'auto-run:turn-completed' && (s.data as { turn: number }).turn >= 2));
    const resumed = dataOf(fake.sent, 'auto-run:turn-completed') as { status: string; budget: { limit: number } };
    expect(resumed.status).toBe('running');
    expect(resumed.budget.limit).toBe(5);

    ctl.requestStop();
    await done;
    await loop;
    expect(record.status).toBe('stopped');
  });

  it('A3-1 回归:续命恢复 running 立即 persist(下一轮 invoke 还在跑,盘上已是 running)', async () => {
    const record = makeRecord({ budget: { kind: 'turns', limit: 1, spent: 0 } });
    let gate: (() => void) | undefined;
    let blocked = false;
    const fake = makeFakeDeps({
      invoke: async () => {
        fake.invokeCount += 1;
        // 第 2 轮起挂住 invoke——制造「续命后、下一轮完成前」的观察窗口。
        if (fake.invokeCount >= 2 && !blocked) {
          blocked = true;
          await new Promise<void>((r) => { gate = r; });
        }
        return { text: 'x', loopSessionId: 'ls-1' };
      },
    });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();

    await waitFor(() => fake.sent.some((s) => s.event === 'auto-run:paused' && (s.data as { reason: string }).reason === 'budget'));
    expect(ctl.renewBudget(5).ok).toBe(true);
    // 续命分支的 persist 先于下一轮 invoke——invokeCount>=2 时盘上必已有 running 快照。
    await waitFor(() => fake.invokeCount >= 2);
    expect(fake.saved.some((r) => r.status === 'running' && r.budget.limit === 5)).toBe(true);

    ctl.requestStop();
    gate?.();
    await done;
    await loop;
    expect(record.status).toBe('stopped');
  });
});

describe('runAutoRunLoop(反复失败 → paused summary,1.6.0)', () => {
  it('同类工具 isError 连击 → paused(repeated-failures),summary = 工具名+连击数', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps({ repeatedFailureStreak: 3 });
    // invoke 返回后 loadMessages 读到尾部 3 连 isError(同工具)。
    fake.messages.push(
      msgToolResult({ isError: true }),
      msgToolResult({ isError: true }),
      msgToolResult({ isError: true }),
    );
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();

    await waitFor(() => fake.sent.some((s) =>
      s.event === 'auto-run:paused' && (s.data as { reason: string }).reason === 'repeated-failures'));
    const paused = dataOf(fake.sent, 'auto-run:paused') as { toolName: string; streak: number; summary: string };
    expect(paused.toolName).toBe('env_exec');
    expect(paused.streak).toBe(3);
    expect(paused.summary).toContain('env_exec');
    expect(paused.summary).toContain('3');

    // 人工作答「终止运行」收尾。
    const pending = pendingDecisions().filter((d) => d.sessionId === record.loopSessionId);
    expect(pending).toHaveLength(1);
    respondDecision(pending[0].decisionId, '终止运行');
    fake.messages.push({
      role: 'user',
      content: '【人的决定】选择: 终止运行',
      timestamp: Date.now(),
      decision: { decisionId: pending[0].decisionId, choice: '终止运行' },
    } as unknown as AgentMessage);

    await done;
    await loop;
    expect(record.status).toBe('stopped');
  });
});

describe('runAutoRunLoop(auto-run:started 契约,1.6.0)', () => {
  it('started 广播带 criteria 数组(保留 criteriaCount 兼容)', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps();
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.invokeCount >= 1);
    const started = dataOf(fake.sent, 'auto-run:started') as { criteria: string[]; criteriaCount: number };
    expect(started.criteria).toEqual(record.criteria);
    expect(started.criteriaCount).toBe(record.criteria.length);
    ctl.requestStop();
    await done;
    await loop;
  });
});

describe('runAutoRunLoop(tokens 预算 × 校准系数,1.6.0)', () => {
  it('loadTokenCalibration=2 → spent = 原始估算 × 2', async () => {
    const record = makeRecord({ budget: { kind: 'tokens', limit: 100_000_000, spent: 0 } });
    const fake = makeFakeDeps({ loadTokenCalibration: () => 2 });
    fake.messages.push(msgUser('hello world, 一些内容让估算非零'));
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.sent.some((s) => s.event === 'auto-run:turn-completed'));
    const raw = estimateLoopTokens(fake.messages);
    expect(raw).toBeGreaterThan(0);
    expect(record.budget.spent).toBe(raw * 2);
    ctl.requestStop();
    await done;
    await loop;
  });

  it('不注入 loadTokenCalibration → 系数 1(原口径)', async () => {
    const record = makeRecord({ budget: { kind: 'tokens', limit: 100_000_000, spent: 0 } });
    const fake = makeFakeDeps();
    fake.messages.push(msgUser('hello world'));
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.sent.some((s) => s.event === 'auto-run:turn-completed'));
    expect(record.budget.spent).toBe(estimateLoopTokens(fake.messages));
    ctl.requestStop();
    await done;
    await loop;
  });
});

describe('injectInteractiveWrapUp(1.6.0 envKey 口径修复)', () => {
  function collectAppend(): { appended: Array<{ id: string; text: string }>; appendMessages: (id: string, msgs: AgentMessage[]) => Promise<void> } {
    const appended: Array<{ id: string; text: string }> = [];
    return {
      appended,
      appendMessages: async (id, msgs) => {
        appended.push({ id, text: String((msgs[0] as { content: unknown }).content) });
      },
    };
  }

  it('binding.envKey=env:<id> 而 record.envKey=裸 id → 注回真实发生', () => {
    const record = makeRecord({ envKey: 'pwn-vm', reportDir: '/out/r' });
    const { appended, appendMessages } = collectAppend();
    injectInteractiveWrapUp(record, '最终结论文本', '已通过验收', {
      getBinding: () => ({ envKey: 'env:pwn-vm', loopSessionId: 'ls-interactive' }),
      appendMessages,
    });
    expect(appended).toHaveLength(1);
    expect(appended[0].id).toBe('ls-interactive');
    expect(appended[0].text).toContain('【auto loop 收官】');
    expect(appended[0].text).toContain('/out/r');
  });

  it('跳过条件照旧:无绑定/绑定线即本 run 线/环境不匹配', () => {
    const record = makeRecord({ envKey: 'pwn-vm' });
    const { appended, appendMessages } = collectAppend();
    injectInteractiveWrapUp(record, 'x', '已终止', { getBinding: () => null, appendMessages });
    injectInteractiveWrapUp(record, 'x', '已终止', {
      getBinding: () => ({ envKey: 'env:pwn-vm', loopSessionId: record.loopSessionId }),
      appendMessages,
    });
    injectInteractiveWrapUp(record, 'x', '已终止', {
      getBinding: () => ({ envKey: 'env:other-vm', loopSessionId: 'ls-other' }),
      appendMessages,
    });
    expect(appended).toEqual([]);
  });
});

describe('runAutoRunLoop(Esc 终止)', () => {
  it('requestStop → 状态 stopped + auto-run:completed{outcome:stopped}', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps();
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.invokeCount >= 1);
    ctl.requestStop();
    await done;
    await loop;
    expect(record.status).toBe('stopped');
    expect(dataOf(fake.sent, 'auto-run:completed')).toMatchObject({ id: 'run-1', outcome: 'stopped' });
  });
});

describe('verdictRequestOfRecord（1.4.6 dogfood 实证：list 归一化）', () => {
  const record = {
    verdictPackage: {
      statement: '全部达成',
      evidenceRefs: [],
      hitCount: 2,
      missCount: 0,
      criteriaPrecheck: [
        { text: '条件一', status: 'evidence' as const },
        { text: '条件二', status: 'partial' as const },
        { text: '条件三', status: 'none' as const },
      ],
    },
  } as never;

  it('verdictPackage → 对外 verdict（evidence/partial → hasEvidence）', () => {
    const v = verdictRequestOfRecord(record)!;
    expect(v.statement).toBe('全部达成');
    // A2-6(1.5.4):criteriaPrecheck 无 refs 数据——字段缺席,不再硬填空数组。
    expect(v.criteria).toEqual([
      { text: '条件一', hasEvidence: true },
      { text: '条件二', hasEvidence: true },
      { text: '条件三', hasEvidence: false },
    ]);
  });

  it('无 verdictPackage / 空 criteriaPrecheck / 空文本 → undefined', () => {
    expect(verdictRequestOfRecord({} as never)).toBeUndefined();
    expect(verdictRequestOfRecord({ verdictPackage: { statement: 'x', evidenceRefs: [], hitCount: 0, missCount: 0, criteriaPrecheck: [] } } as never)).toBeUndefined();
    expect(verdictRequestOfRecord({ verdictPackage: { statement: 'x', evidenceRefs: [], hitCount: 0, missCount: 0, criteriaPrecheck: [{ text: '  ', status: 'evidence' as const }] } } as never)).toBeUndefined();
  });
});

describe('1.4.6 修复:预算 off-by-one + 幽灵 verdictPackage', () => {
  it('达成声明的那一轮也计入 budget.spent(声明轮不再漏算)', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps({
      resolveEvent: (id) => (id === 1 ? makeEvent(1) : null),
      invoke: async () => {
        declareCompletion(record.loopSessionId, '全部达成,证据 #1', [1]);
        return { text: 'done', loopSessionId: record.loopSessionId };
      },
      exportReport: async () => ({ ok: true, reportDir: '/out' }),
    });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.sent.some((s) => s.event === 'auto-run:verdict-requested'));
    // 声明轮(turn=1)在 verdict 前就已计入 spent——旧实现这里 spent=0。
    expect(record.budget.spent).toBe(1);
    expect(ctl.resolveVerdict('pass').ok).toBe(true);
    await done;
    await loop;
    expect(record.budget.spent).toBe(1);
  });

  it('终审作答即清 verdictPackage(恢复路径不再弹已作答的终审窗)', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps({
      resolveEvent: (id) => (id === 1 ? makeEvent(1) : null),
      invoke: async () => {
        declareCompletion(record.loopSessionId, '全部达成,证据 #1', [1]);
        return { text: 'done', loopSessionId: record.loopSessionId };
      },
      exportReport: async () => ({ ok: true, reportDir: '/out' }),
    });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.sent.some((s) => s.event === 'auto-run:verdict-requested'));
    expect(record.verdictPackage).toBeDefined();
    expect(ctl.resolveVerdict('pass').ok).toBe(true);
    await done;
    await loop;
    expect(record.verdictPackage).toBeUndefined();
    // 落盘的持久化记录里也不再有 verdictPackage。
    const lastSaved = fake.saved.at(-1)!;
    expect(lastSaved.verdictPackage).toBeUndefined();
    // declaration 陈述保留作历史。
    expect(record.declaration?.statement).toContain('全部达成');
  });
});

describe('resolveAutoRunVerdict — 孤儿记录兜底（1.4.6 走查实证）', () => {
  let dir3: string;
  beforeEach(() => {
    dir3 = mkdtempSync(join(tmpdir(), 'zhishi-ar-orphan-'));
  });
  afterEach(() => {
    rmSync(dir3, { recursive: true, force: true });
  });

  async function seedOrphan(status: AutoRunRecord['status']) {
    const record = makeRecord();
    record.status = status;
    record.verdictPackage = buildVerdictPackage({
      id: record.id,
      criteria: record.criteria,
      declaration: { statement: 's', evidenceRefs: [] },
      resolveEvent: () => null,
    });
    await saveAutoRunRecord(record, { dir: dir3 });
    return record;
  }

  it('孤儿 awaiting-verdict + pass → completed + verdictPackage 清除(落盘生效)', async () => {
    const record = await seedOrphan('awaiting-verdict');
    const r = await resolveAutoRunVerdict(record.id, 'pass', undefined, { dir: dir3 });
    expect(r.success).toBe(true);
    const saved = loadAutoRunRecord(record.id, { dir: dir3 })!;
    expect(saved.status).toBe('completed');
    expect(saved.verdictPackage).toBeUndefined();
  });

  it('孤儿 + fail → stopped;continue → 明确报错不可续跑;非 awaiting-verdict → 无需终审', async () => {
    const a = await seedOrphan('awaiting-verdict');
    expect((await resolveAutoRunVerdict(a.id, 'fail', undefined, { dir: dir3 })).success).toBe(true);
    expect(loadAutoRunRecord(a.id, { dir: dir3 })!.status).toBe('stopped');

    const b = await seedOrphan('awaiting-verdict');
    const rc = await resolveAutoRunVerdict(b.id, 'continue', undefined, { dir: dir3 });
    expect(rc.success).toBe(false);
    if (!rc.success) expect(rc.error).toContain('无法续跑');

    const c = await seedOrphan('completed');
    const rd = await resolveAutoRunVerdict(c.id, 'pass', undefined, { dir: dir3 });
    expect(rd.success).toBe(false);
    if (!rd.success) expect(rd.error).toContain('无需终审');

    const rg = await resolveAutoRunVerdict('ghost-run', 'pass', undefined, { dir: dir3 });
    expect(rg.success).toBe(false);
    if (!rg.success) expect(rg.error).toContain('不存在');
  });
});

// ===== 1.6.0 auto loop 全链路审计 S1:runner 状态机修复回归 =====

describe('1.6.0 修复①:终审按轮重置(第二轮终审可作答)', () => {
  it('第二轮 declare_completion 重新弹窗等人作答,不被旧 verdict 自动消费;同轮幂等闸不变', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps({
      invoke: async () => {
        fake.invokeCount += 1;
        // 每轮都声明达成——第二轮终审若被旧 verdict 自动消费,循环会空转刷轮。
        declareCompletion(record.loopSessionId, `第 ${fake.invokeCount} 轮达成`, []);
        return { text: 'done', loopSessionId: record.loopSessionId };
      },
    });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();

    // 第一轮终审:continue → 续跑。
    await waitFor(() => fake.sent.filter((s) => s.event === 'auto-run:verdict-requested').length === 1);
    expect(ctl.resolveVerdict('continue', '再看看').ok).toBe(true);

    // 第二轮终审弹窗:必须停在 awaiting-verdict 等人——旧实现 internals.verdict
    // 残留 'continue',wait 立即命中、旧答案被自动消费(不再弹窗等人)。
    await waitFor(() => fake.sent.filter((s) => s.event === 'auto-run:verdict-requested').length === 2);
    await new Promise((r) => setTimeout(r, 120));
    expect(record.status).toBe('awaiting-verdict');
    expect(fake.invokeCount).toBe(2); // 没有自动续跑第三轮
    expect(ctl.__getVerdict().verdict).toBeNull(); // 旧 verdict 已按轮重置

    // 同轮幂等闸不变:第一次作答后、runner 消费前的重复作答仍拒(两个同步
    // 调用在同一 tick,runner 尚未来得及消费)。
    expect(ctl.resolveVerdict('pass').ok).toBe(true);
    expect(ctl.resolveVerdict('fail').ok).toBe(false);

    await done;
    await loop;
    expect(record.status).toBe('completed');
  });
});

describe('1.6.0 修复②:决策超时语义(未答无限等 / 已答读 resolved 记录)', () => {
  it('人未答:超过 decisionWaitTimeoutMs 也保持 paused,不静默续跑', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps({ stallTurns: 1, decisionWaitTimeoutMs: 60 });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.sent.some((s) =>
      s.event === 'auto-run:paused' && (s.data as { reason: string }).reason === 'stall'));

    // 超时上限的 4 倍时间仍未答——旧实现此时已静默续跑(running + 第 3 轮)。
    await new Promise((r) => setTimeout(r, 250));
    expect(record.status).toBe('paused');
    expect(fake.invokeCount).toBe(2);

    // 人作答 + marker 落地 → 恢复推进。
    const pending = pendingDecisions().filter((d) => d.sessionId === record.loopSessionId);
    respondDecision(pending[0].decisionId, '继续跑');
    fake.messages.push({
      role: 'user',
      content: '【人的决定】选择: 继续跑',
      timestamp: Date.now(),
      decision: { decisionId: pending[0].decisionId, choice: '继续跑' },
    } as unknown as AgentMessage);
    // 恢复推进的证明 = 起了第 3 轮 invoke(stallTurns=1 时第 3 轮会立刻再
    // 空转暂停,turn-completed 不会落地,不能等它)。
    await waitFor(() => fake.invokeCount >= 3);

    ctl.requestStop();
    await done;
    await loop;
    expect(record.status).toBe('stopped');
  });

  it('人已答但 marker 未落地:超时后从 resolved 记录读 choice(不依赖 marker)', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps({ stallTurns: 1, decisionWaitTimeoutMs: 60 });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.sent.some((s) =>
      s.event === 'auto-run:paused' && (s.data as { reason: string }).reason === 'stall'));
    const pending = pendingDecisions().filter((d) => d.sessionId === record.loopSessionId);
    expect(pending).toHaveLength(1);
    respondDecision(pending[0].decisionId, '终止运行');
    // 不推 marker(模拟注入 turn 卡死)——旧实现:超时后 marker 缺失一律按
    // 「继续跑」(已答被丢弃,done 不会到来);新实现:从 resolved 记录读
    // 「终止运行」→ stopped 收官。
    await done;
    await loop;
    expect(record.status).toBe('stopped');
    expect(dataOf(fake.sent, 'auto-run:completed')).toMatchObject({ id: 'run-1', outcome: 'stopped' });
  });
});

describe('1.6.0 修复③:重启愈合保留 awaiting-verdict 孤儿终审通道', () => {
  it('awaiting-verdict 不被标 stopped,愈合后仍可孤儿结算', async () => {
    const orphan = makeRecord({ id: 'run-av', status: 'awaiting-verdict' });
    orphan.verdictPackage = buildVerdictPackage({
      id: orphan.id,
      criteria: orphan.criteria,
      declaration: { statement: 's', evidenceRefs: [] },
      resolveEvent: () => null,
    });
    const running = makeRecord({ id: 'run-run', status: 'running' });
    await saveAutoRunRecord(orphan, { dir });
    await saveAutoRunRecord(running, { dir });

    const healed = await recoverOrphanedAutoRuns({ dir });
    expect(healed).toBe(1); // 只愈合 running
    expect(loadAutoRunRecord('run-run', { dir })!.status).toBe('stopped');
    expect(loadAutoRunRecord('run-av', { dir })!.status).toBe('awaiting-verdict');

    // 孤儿终审通道仍可达(resolveOrphanedVerdict 按盘上记录结算)。
    const r = await resolveAutoRunVerdict('run-av', 'pass', undefined, { dir });
    expect(r.success).toBe(true);
    expect(loadAutoRunRecord('run-av', { dir })!.status).toBe('completed');
  });
});

describe('1.6.0 修复④:resolveVerdict 已停拒绝(Esc 竞态不静默丢弃)', () => {
  it('requestStop 后 resolveVerdict 返回明确错误,作答不写入', () => {
    const record = makeRecord({ status: 'awaiting-verdict' });
    const ctl = createAutoRunController(record);
    ctl.requestStop();
    const r = ctl.resolveVerdict('pass');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('已终止');
    expect(ctl.__getVerdict().verdict).toBeNull();
  });
});

describe('1.6.0 修复⑤:waitForWake waiters 不泄漏', () => {
  it('长暂停期间 race 落败的 waiter 被摘除(挂起 ≤1)', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps({ stallTurns: 1 });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.sent.some((s) =>
      s.event === 'auto-run:paused' && (s.data as { reason: string }).reason === 'stall'));

    // ~15 个 poll 周期(pollMs=10)——旧实现每周期泄漏一个 waiter(≈15 挂起)。
    await new Promise((r) => setTimeout(r, 150));
    expect(ctl.__waiterCount()).toBeLessThanOrEqual(1);

    // 收尾:作答继续 → Esc。
    const pending = pendingDecisions().filter((d) => d.sessionId === record.loopSessionId);
    respondDecision(pending[0].decisionId, '继续跑');
    fake.messages.push({
      role: 'user',
      content: '【人的决定】选择: 继续跑',
      timestamp: Date.now(),
      decision: { decisionId: pending[0].decisionId, choice: '继续跑' },
    } as unknown as AgentMessage);
    ctl.requestStop();
    await done;
    await loop;
  });
});

describe('1.6.0 修复⑥⑩:startAutoRun 注册表(终态摘除 + 单实例闸路径口径)', () => {
  let dataDir: string;
  let prevDataDir: string | undefined;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'zhishi-ar-registry-'));
    prevDataDir = process.env.ZHISHI_DATA_DIR;
    process.env.ZHISHI_DATA_DIR = dataDir;
    // startAutoRun 的环境校验读真实 config.json(ZHISHI_DATA_DIR 已指向临时目录)。
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ environments: [{ id: 'pwn-vm', kind: 'local' }] }));
  });
  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.ZHISHI_DATA_DIR;
    else process.env.ZHISHI_DATA_DIR = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  const startInput = { name: 't', envKey: 'pwn-vm', goal: 'g', criteria: ['c'], budget: { kind: 'turns', limit: 50 } };

  it('⑥runner 终态即从 activeRuns 摘除(stop 走「不存在」语义)', async () => {
    const fake = makeFakeDeps();
    const started = await startAutoRun(startInput, '/ws', fake.deps);
    expect(started.success).toBe(true);
    if (!started.success) return;
    const id = started.data.id;
    await waitFor(() => fake.invokeCount >= 1);
    expect(stopAutoRun(id).success).toBe(true);
    // 旧行为:终态记录永挂内存,stop 报「已终态」;新行为:摘除后报「不存在」。
    await waitFor(() => {
      const r = stopAutoRun(id);
      return !r.success && r.error.includes('不存在');
    });
  });

  it('⑩单实例闸 workspace 比较走 workspacePathsEqual(尾斜杠等价)', async () => {
    const fake = makeFakeDeps();
    const first = await startAutoRun(startInput, '/ws', fake.deps);
    expect(first.success).toBe(true);
    if (!first.success) return;
    // 旧实现 === 比较:'/ws/' ≠ '/ws',闸被绕过、第二个 run 起得来。
    const second = await startAutoRun(startInput, '/ws/', makeFakeDeps().deps);
    expect(second.success).toBe(false);
    if (!second.success) expect(second.error).toContain('已有运行中的');
    // 收尾:停掉第一个 run 并等注册表摘除(防泄漏进后续用例)。
    stopAutoRun(first.data.id);
    await waitFor(() => {
      const r = stopAutoRun(first.data.id);
      return !r.success && r.error.includes('不存在');
    });
  });
});

describe('1.6.0 修复⑦:run 终态清理本线 pending 决策与声明', () => {
  it('Esc 后本线 pending/声明清空,其他线不动', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps({
      invoke: async () => {
        fake.invokeCount += 1;
        if (fake.invokeCount === 1) {
          // 模型提请决策 → runner 进 paused(decision) 等人。
          requestDecision(
            { sessionId: record.loopSessionId, question: '方向?', options: ['a', 'b'] },
            fake.deps.broadcast,
          );
        }
        return { text: 'x', loopSessionId: record.loopSessionId };
      },
    });
    // 其他线的待答决策/声明——不应被本 run 终态清理误伤。
    requestDecision({ sessionId: 'other-line', question: 'q', options: ['a', 'b'] }, fake.deps.broadcast);
    declareCompletion('other-line', '其他线声明', []);

    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.sent.some((s) =>
      s.event === 'auto-run:paused' && (s.data as { reason: string }).reason === 'decision'));
    // 模拟终态前未被 runner 消费的晚到声明(同线)。
    declareCompletion(record.loopSessionId, '晚到的声明', []);
    ctl.requestStop();
    await done;
    await loop;

    expect(pendingDecisions().filter((d) => d.sessionId === record.loopSessionId)).toHaveLength(0);
    expect(pendingDecisions().some((d) => d.sessionId === 'other-line')).toBe(true);
    expect(takeCompletionDeclaration(record.loopSessionId)).toBeNull();
    expect(takeCompletionDeclaration('other-line')).not.toBeNull();
  });
});

describe('1.6.0 修复⑧:time 预算扣除暂停等待墙钟', () => {
  it('纯函数:pausedMs 从 elapsed 扣除(缺省 0、钳负)', () => {
    expect(computeBudgetSpent({ kind: 'time', limit: 100 }, { turns: 0, tokens: 0, elapsedMs: 70 * 60_000, pausedMs: 60 * 60_000 })).toBe(10);
    expect(computeBudgetSpent({ kind: 'time', limit: 100 }, { turns: 0, tokens: 0, elapsedMs: 120_000 })).toBe(2);
    expect(computeBudgetSpent({ kind: 'time', limit: 100 }, { turns: 0, tokens: 0, elapsedMs: 10, pausedMs: 100 })).toBe(0);
  });

  it('runner 集成:预算暂停 60 分钟虚拟墙钟,续命后 spent 不涨', async () => {
    let nowMs = 0;
    const record = makeRecord({ budget: { kind: 'time', limit: 10, spent: 0 } });
    const fake = makeFakeDeps({
      now: () => nowMs,
      invoke: async () => {
        fake.invokeCount += 1;
        // 第 2 轮开始时把墙钟推到 10 分钟——本轮收尾必触发预算耗尽暂停。
        if (fake.invokeCount === 2) nowMs = 10 * 60_000;
        return { text: 'x', loopSessionId: 'ls-1' };
      },
    });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.sent.some((s) =>
      s.event === 'auto-run:paused' && (s.data as { reason: string }).reason === 'budget'));

    nowMs += 60 * 60_000; // 暂停等人 60 分钟(虚拟墙钟)
    expect(ctl.renewBudget(1000).ok).toBe(true);

    await waitFor(() => fake.sent.some((s) =>
      s.event === 'auto-run:turn-completed' && (s.data as { turn: number }).turn >= 3));
    const tc = [...fake.sent].reverse().find((s) => s.event === 'auto-run:turn-completed')!
      .data as { budget: { spent?: number } };
    // spent = (70 总墙钟 - 60 暂停) = 10 分钟;旧口径会算成 70。
    expect(tc.budget.spent).toBe(10);
    expect(record.pausedMsTotal).toBe(60 * 60_000);

    ctl.requestStop();
    await done;
    await loop;
    expect(record.status).toBe('stopped');
  });
});

describe('1.6.0 修复⑨:provider-error 暂停 persist 前更新 budget.spent', () => {
  it('失败本轮(turn 已 +1)计入暂停快照的 spent', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps({
      invoke: async () => {
        fake.invokeCount += 1;
        return { error: '503 Server Overloaded', text: '', loopSessionId: 'ls-1' };
      },
    });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.sent.some((s) =>
      s.event === 'auto-run:paused' && (s.data as { reason: string }).reason === 'provider-error'));

    const snap = fake.saved.find((r) => r.pauseReason === 'provider-error');
    expect(snap?.turns).toBe(1);
    expect(snap?.budget.spent).toBe(1); // 旧实现:persist 时 spent 仍是 0(少一轮)

    // 收尾:作答终止 → done。
    const pending = pendingDecisions().filter((d) => d.sessionId === record.loopSessionId);
    respondDecision(pending[0].decisionId, '终止运行');
    fake.messages.push({
      role: 'user',
      content: '【人的决定】选择: 终止运行',
      timestamp: Date.now(),
      decision: { decisionId: pending[0].decisionId, choice: '终止运行' },
    } as unknown as AgentMessage);
    await done;
    await loop;
    expect(record.status).toBe('stopped');
  });
});

// ===== 1.6.3 #7:docker checkpoint 留现场(环境内 task.md) =====

describe('docker checkpoint task.md(1.6.3 #7)', () => {
  const dockerEntry = (overrides: Partial<EnvironmentEntry> = {}): EnvironmentEntry => ({
    id: 'pwn-box',
    kind: 'docker',
    container: 'zhishi-pwn-abcd1234',
    createdAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  });

  /** 从注入 exec 收到的 argv 里取 bash -lc 的命令体,解出 base64 载荷。 */
  const decodeWrittenContent = (argv: string[]): string => {
    const cmdIdx = argv.indexOf('-lc');
    expect(cmdIdx).toBeGreaterThan(-1);
    const m = /^printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > \/workspace\/task\.md$/.exec(argv[cmdIdx + 1]);
    expect(m, `命令形态不符:${argv[cmdIdx + 1]}`).not.toBeNull();
    return Buffer.from(m![1], 'base64').toString('utf-8');
  };

  it('buildDockerTaskMd:目标/验收条件/当前状态/关键上下文齐全', () => {
    const record = makeRecord({
      status: 'paused',
      pauseReason: 'budget',
      turns: 7,
      budget: { kind: 'turns', limit: 50, spent: 7 },
      reportDir: '/ws/reports/run-1',
    });
    const md = buildDockerTaskMd(record);
    expect(md).toContain('# task.md');
    expect(md).toContain('- 任务:demo(run id: run-1)');
    expect(md).toContain('- 环境:pwn-vm');
    expect(md).toContain('拿到 flag');
    expect(md).toContain('1. 输出 flag{…}');
    expect(md).toContain('2. PoC 稳定复现 3 次');
    expect(md).toContain('- 运行状态:paused(暂停原因:budget)');
    expect(md).toContain('- 已完成轮次:7');
    expect(md).toContain('- 预算:turns 已耗 7 / 上限 50');
    expect(md).toContain('- loop 轨迹线:ls-1');
    expect(md).toContain('- 宿主工作区:/ws');
    expect(md).toContain('- 报告:/ws/reports/run-1');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('buildDockerTaskMd:可缺省字段缺席时不留空行项', () => {
    const md = buildDockerTaskMd(makeRecord({ workspace: undefined, reportDir: undefined, turns: undefined }));
    expect(md).not.toContain('宿主工作区');
    expect(md).not.toContain('报告:');
    expect(md).toContain('- 已完成轮次:0');
  });

  it('buildDockerTaskMdWriteCommand:base64 往返无损(引号/换行/UTF-8)', () => {
    const content = '含 \'单引号\' 与 "双引号"\n多行\n中文内容 flag{uäg}';
    const cmd = buildDockerTaskMdWriteCommand(content);
    const m = /^printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > \/workspace\/task\.md$/.exec(cmd);
    expect(m).not.toBeNull();
    expect(Buffer.from(m![1], 'base64').toString('utf-8')).toBe(content);
  });

  it('容器在跑:docker exec 写入 /workspace/task.md → ok', async () => {
    const calls: string[][] = [];
    const exec: EnvExec = async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: '', stderr: '' } satisfies EnvExecProcessResult;
    };
    const record = makeRecord();
    const r = await writeDockerTaskMdCheckpoint(dockerEntry(), record, { exec });
    expect(r).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    // docker exec 通道(buildDockerExecArgv 形态):docker exec <container> bash -lc <cmd>
    expect(calls[0].slice(0, 3)).toEqual(['docker', 'exec', 'zhishi-pwn-abcd1234']);
    expect(decodeWrittenContent(calls[0])).toBe(buildDockerTaskMd(record));
  });

  it('容器已停止(exec 失败)+ 条目有 workspace:降级写宿主 bind-mount 源目录,告警不丢现场', async () => {
    const exec: EnvExec = async () => ({
      exitCode: 1, stdout: '', stderr: 'Error response from daemon: Container is not running',
    });
    const hostWrites: Array<{ path: string; content: string }> = [];
    const warnings: string[] = [];
    const record = makeRecord();
    const r = await writeDockerTaskMdCheckpoint(
      dockerEntry({ workspace: '/host/ws' }),
      record,
      { exec, hostWrite: (path, content) => { hostWrites.push({ path, content }); }, log: (m) => warnings.push(m) },
    );
    expect(r).toEqual({ ok: true });
    expect(hostWrites).toHaveLength(1);
    expect(hostWrites[0].path).toBe(join('/host/ws', 'task.md'));
    expect(hostWrites[0].content).toBe(buildDockerTaskMd(record));
    expect(warnings.some((w) => w.includes('降级写宿主侧'))).toBe(true);
  });

  it('容器内非零退出码(写失败)同样走降级', async () => {
    const exec: EnvExec = async () => ({ exitCode: 1, stdout: '', stderr: 'permission denied' });
    const hostWrites: string[] = [];
    const r = await writeDockerTaskMdCheckpoint(
      dockerEntry({ workspace: '/host/ws' }),
      makeRecord(),
      { exec, hostWrite: (path) => { hostWrites.push(path); }, log: () => {} },
    );
    expect(r).toEqual({ ok: true });
    expect(hostWrites).toEqual([join('/host/ws', 'task.md')]);
  });

  it('容器写不进且条目无 workspace 登记:ok:false 可读错误(run 状态不受影响由调用方口径保证)', async () => {
    const exec: EnvExec = async () => ({ exitCode: 1, stdout: '', stderr: 'not running' });
    const r = await writeDockerTaskMdCheckpoint(dockerEntry(), makeRecord(), { exec, log: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('无法降级');
      expect(r.error).toContain('not running');
    }
  });

  it('容器写不进且宿主降级写也失败:ok:false,两侧错误都在', async () => {
    const exec: EnvExec = async () => ({ exitCode: 1, stdout: '', stderr: 'not running' });
    const r = await writeDockerTaskMdCheckpoint(
      dockerEntry({ workspace: '/host/ws' }),
      makeRecord(),
      {
        exec,
        hostWrite: () => { throw new Error('EROFS: read-only file system'); },
        log: () => {},
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('not running');
      expect(r.error).toContain('EROFS');
    }
  });

  it('缺 container 定位锚的 docker 条目:execInEnvironment 解析失败也走降级/报错,不抛', async () => {
    const hostWrites: string[] = [];
    const r = await writeDockerTaskMdCheckpoint(
      dockerEntry({ container: undefined, workspace: '/host/ws' }),
      makeRecord(),
      { hostWrite: (path) => { hostWrites.push(path); }, log: () => {} },
    );
    expect(r).toEqual({ ok: true });
    expect(hostWrites).toEqual([join('/host/ws', 'task.md')]);
  });
});
