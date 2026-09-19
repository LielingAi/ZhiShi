/**
 * loop/auto-run.ts 单测(1.7.7 auto-redesign)——纯函数(启动校验/驱动文本/
 * 预算/空转检测 K=3/记录编解码)+ runner 集成(全假依赖,不真连环境/
 * 不真落真库)。
 *
 * runner 集成覆盖四停点:declare 证据预检通过 → completed、预检不过 → 回注
 * 继续、provider 连击 N=5 → exited、预算耗尽 → stopped、Esc → stopped;
 * 工具级 isError 不计数;空转话术注入(K=3,重复注入,自定义/内置/关闭);
 * 互斥闸与僵尸愈合。declaration 用真实内存注册表(纯内存,不触网)。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import type { ResearchEvent } from '../memory/store';
import {
  autoRunFilePath,
  buildFirstTurnText,
  buildNextTurnText,
  computeBudgetSpent,
  countValidEventsSince,
  createAutoRunController,
  currentResearchPhase,
  DEFAULT_STALL_PROMPT,
  estimateLoopTokens,
  evaluateStall,
  injectInteractiveWrapUp,
  isBudgetExhausted,
  listAutoRunRecordFiles,
  loadAutoRunRecord,
  parseAutoRunRecord,
  PROVIDER_STREAK_EXIT_DEFAULT,
  recoverOrphanedAutoRuns,
  resetAutoRunRegistryForTest,
  runAutoRunLoop,
  saveAutoRunRecord,
  serializeAutoRunRecord,
  STALL_PROMPT_OFF,
  STALL_TURNS_DEFAULT,
  startAutoRun,
  stopAutoRun,
  validateAutoRunStart,
  withAutoRunDepDefaults,
  type AutoRunDeps,
  type AutoRunRecord,
} from './auto-run';
import { clearCompletionDeclarations, declareCompletion, takeCompletionDeclaration } from './declare-completion';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-auto-run-'));
  clearCompletionDeclarations();
  resetAutoRunRegistryForTest();
});

afterEach(() => {
  clearCompletionDeclarations();
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
  invokeTexts: string[];
  invokeOptions: Array<Parameters<AutoRunDeps['invoke']>[1]>;
  messages: AgentMessage[];
  saved: AutoRunRecord[];
  sent: Array<{ event: string; data: unknown }>;
  events: ResearchEvent[];
}

function makeFakeDeps(overrides: Partial<AutoRunDeps> = {}): FakeDeps {
  const fake: FakeDeps = {
    deps: null as unknown as AutoRunDeps,
    invokeCount: 0,
    invokeTexts: [],
    invokeOptions: [],
    messages: [],
    saved: [],
    sent: [],
    events: [],
  };
  fake.deps = withAutoRunDepDefaults({
    workspace: '/ws',
    invoke: async (input, options) => {
      fake.invokeCount += 1;
      fake.invokeTexts.push(input.text);
      fake.invokeOptions.push(options);
      // 每轮让出事件循环:fake invoke 是纯微任务,不让出的话 runner 会以微任务
      // 循环饿死 macrotask(waitFor 的 setTimeout 轮询/requestStop 永不触发)。
      await new Promise((r) => setTimeout(r, 0));
      return { text: `输出 ${fake.invokeCount}`, loopSessionId: 'ls-1' };
    },
    loadMessages: () => fake.messages,
    listEvents: () => fake.events,
    resolveEvent: () => null,
    // 快照式广播(对齐生产 formatSse 即时序列化):payload 里有活引用
    // (record.budget)时,断言读到的仍是发射时刻的值,不受后续轮次改写影响。
    broadcast: (event, data) => { fake.sent.push({ event, data: JSON.parse(JSON.stringify(data)) }); },
    save: (record) => { fake.saved.push(JSON.parse(JSON.stringify(record)) as AutoRunRecord); },
    now: () => Date.now(),
    log: () => {},
    ...overrides,
  });
  return fake;
}

const dataOf = (sent: Array<{ event: string; data: unknown }>, event: string): unknown =>
  sent.find((s) => s.event === event)?.data;

// ===== 启动校验 =====

describe('validateAutoRunStart', () => {
  const findEnv = (envKey: string) => (envKey === 'pwn-vm' ? { id: 'pwn-vm' } : undefined);

  it('合法输入 → 完整记录(预算 spent 归零;无 stallPrompt 不写字段)', () => {
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
    expect(r.record.stallPrompt).toBeUndefined();
  });

  it('stallPrompt:空白 → 缺省(不写);原文保留;off → 关闭常量', () => {
    const base = { name: 'n', envKey: 'pwn-vm', goal: 'g', criteria: ['a'], budget: { kind: 'turns', limit: 1 } };
    const a = validateAutoRunStart({ ...base, stallPrompt: '   ' }, { findEnv });
    expect(a.ok && a.record.stallPrompt).toBeUndefined();
    const b = validateAutoRunStart({ ...base, stallPrompt: ' 换个思路 ' }, { findEnv });
    expect(b.ok && b.record.stallPrompt).toBe('换个思路');
    const c = validateAutoRunStart({ ...base, stallPrompt: STALL_PROMPT_OFF }, { findEnv });
    expect(c.ok && c.record.stallPrompt).toBe(STALL_PROMPT_OFF);
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
  it('首轮含目标/验收条件/研究纪律;1.7.7 无 request_decision、无档案检查点', () => {
    const text = buildFirstTurnText('拿到 flag', ['输出 flag{…}']);
    expect(text).toContain('拿到 flag');
    expect(text).toContain('输出 flag{…}');
    expect(text).toContain('research_log');
    expect(text).toContain('declare_completion');
    expect(text).toContain('research_archive');
    expect(text).toContain('V# 证据引用');
    expect(text).toContain('falsify/correct');
    // OR 语义与「没有自我退出权」入文案。
    expect(text).toContain('任一条件');
    expect(text).toContain('自我退出权');
    // 删除清单:decision 提请与档案检查点不再出现。
    expect(text).not.toContain('request_decision');
    expect(text).not.toContain('档案检查点');
  });

  it('后续轮含上一轮结果截断;注回块前置(达成预检/空转话术,标注系统注入)', () => {
    const prev = 'x'.repeat(3000);
    const text = buildNextTurnText('目标', prev, {
      precheckNote: '上轮达成宣称未通过证据预检:宣称未对应任何验收条件。继续推进。',
      stallNote: '换个思路',
      maxChars: 100,
    });
    expect(text).toContain('继续推进目标');
    expect(text).toContain('【系统注回·达成预检】');
    expect(text).toContain('【系统注入·空转推进话术】');
    expect(text).toContain('…(截断)');
    expect(text).toContain('research_archive');
    expect(text.length).toBeLessThan(600);
    // 无注回块 → 无标注。
    const plain = buildNextTurnText('目标', '上轮');
    expect(plain).not.toContain('系统注回');
    expect(plain).not.toContain('系统注入');
  });
});

// ===== 预算 =====

describe('computeBudgetSpent / isBudgetExhausted / estimateLoopTokens', () => {
  it('三档口径:turns 计轮/tokens 计估算/time 计分钟', () => {
    expect(computeBudgetSpent({ kind: 'turns', limit: 9 }, { turns: 3, tokens: 0, elapsedMs: 0 })).toBe(3);
    expect(computeBudgetSpent({ kind: 'tokens', limit: 9 }, { turns: 3, tokens: 400, elapsedMs: 0 })).toBe(400);
    expect(computeBudgetSpent({ kind: 'time', limit: 9 }, { turns: 3, tokens: 0, elapsedMs: 120_000 })).toBe(2);
  });

  it('tokens 档 spent = 原始估算 × 校准系数(缺省 1,钳 [0.8, 6])', () => {
    expect(computeBudgetSpent({ kind: 'tokens', limit: 9 }, { turns: 0, tokens: 400, elapsedMs: 0, calibration: 2 })).toBe(800);
    expect(computeBudgetSpent({ kind: 'tokens', limit: 9 }, { turns: 0, tokens: 400, elapsedMs: 0 })).toBe(400);
    expect(computeBudgetSpent({ kind: 'tokens', limit: 9 }, { turns: 0, tokens: 400, elapsedMs: 0, calibration: Number.NaN })).toBe(400);
    expect(computeBudgetSpent({ kind: 'tokens', limit: 9 }, { turns: 0, tokens: 400, elapsedMs: 0, calibration: 100 })).toBe(2400);
    expect(computeBudgetSpent({ kind: 'tokens', limit: 9 }, { turns: 0, tokens: 400, elapsedMs: 0, calibration: 0.01 })).toBe(320);
  });

  it('耗尽 = spent ≥ limit', () => {
    expect(isBudgetExhausted({ kind: 'turns', limit: 10 }, 10)).toBe(true);
    expect(isBudgetExhausted({ kind: 'turns', limit: 10 }, 9.9)).toBe(false);
  });

  it('token 估算 = estimateMessageTokens 求和口径', () => {
    const tokens = estimateLoopTokens([msgUser('hello'), msgUser('世界')]);
    expect(tokens).toBe(estimateLoopTokens([msgUser('hello')]) + estimateLoopTokens([msgUser('世界')]));
    expect(estimateLoopTokens([])).toBe(0);
  });
});

// ===== 空转证据判定 =====

describe('countValidEventsSince(有效研究记录增量)', () => {
  it('按 sinceTs 过滤 + outcome 闭集(脏行不算)', () => {
    const events = [
      makeEvent(1, { ts: 100, outcome: 'success' }),
      makeEvent(2, { ts: 200, outcome: 'fail' }),
      makeEvent(3, { ts: 300, outcome: 'wrong' as never }),
    ];
    expect(countValidEventsSince(events, 150)).toBe(1);
    expect(countValidEventsSince(events, 0)).toBe(2);
    expect(countValidEventsSince([], 0)).toBe(0);
  });
});

describe('evaluateStall(空转判定,K=3)', () => {
  it('无新增且阶段未推进 → streak 累加;缺省阈值 K=3 达到即 stalled', () => {
    expect(evaluateStall({ newValidEvents: 0, previousPhase: 'recon', phase: 'recon', stallStreak: 2 }))
      .toEqual({ stallStreak: 3, stalled: true });
    expect(evaluateStall({ newValidEvents: 0, previousPhase: 'recon', phase: 'recon', stallStreak: 1 }))
      .toEqual({ stallStreak: 2, stalled: false });
    expect(STALL_TURNS_DEFAULT).toBe(3);
  });

  it('显式阈值覆盖缺省', () => {
    expect(evaluateStall({ newValidEvents: 0, previousPhase: 'recon', phase: 'recon', stallStreak: 1 }, 2))
      .toEqual({ stallStreak: 2, stalled: true });
  });

  it('有新增/阶段推进/无基线(首轮)→ streak 清零', () => {
    expect(evaluateStall({ newValidEvents: 1, previousPhase: 'recon', phase: 'recon', stallStreak: 4 }).stallStreak).toBe(0);
    expect(evaluateStall({ newValidEvents: 0, previousPhase: 'recon', phase: 'analysis', stallStreak: 4 }).stallStreak).toBe(0);
    expect(evaluateStall({ newValidEvents: 0, previousPhase: undefined, phase: 'anchor', stallStreak: 4 }).stallStreak).toBe(0);
  });
});

describe('currentResearchPhase(1.2.7 分类器复用)', () => {
  it('空历史 → anchor;段相位按 1.2.7 推断(末段胜出)', () => {
    expect(currentResearchPhase([])).toBe('anchor');
    const messages = [msgUser('开始'), msgUser('用 nmap 扫描子域名 枚举服务')];
    expect(currentResearchPhase(messages)).toBe('recon');
  });
});

// ===== 记录编解码 / 存储 =====

describe('serialize/parse/save/load/list/recover(存储纪律)', () => {
  it('编解码往返;坏 JSON/坏形状 → null', () => {
    const rec = makeRecord({ declaration: { statement: 's', criteria: ['输出 flag{…}'], evidenceRefs: [1, 'H#1'] } });
    const parsed = parseAutoRunRecord(serializeAutoRunRecord(rec));
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe('run-1');
    expect(parsed?.budget).toEqual({ kind: 'turns', limit: 50, spent: 0 });
    expect(parsed?.declaration?.evidenceRefs).toEqual([1, 'H#1']);
    expect(parseAutoRunRecord('{bad json')).toBeNull();
    expect(parseAutoRunRecord(JSON.stringify({ id: 'x', loopSessionId: 'y', status: 'weird', budget: { kind: 'turns', limit: 1 } }))).toBeNull();
  });

  it('旧字段容错:旧暂停态归一化 running;policy/verdictPackage 不透传', () => {
    const legacy = {
      ...makeRecord(),
      status: 'awaiting-verdict',
      policy: { onStall: { tolerance: 2, action: 'stop' } },
      verdictPackage: { statement: 's', criteriaPrecheck: [] },
      reportDir: '/out/r',
      pausedMsTotal: 123,
    };
    const parsed = parseAutoRunRecord(JSON.stringify(legacy));
    expect(parsed?.status).toBe('running');
    expect('policy' in (parsed ?? {})).toBe(false);
    expect('verdictPackage' in (parsed ?? {})).toBe(false);
    expect('reportDir' in (parsed ?? {})).toBe(false);
  });

  it('save → load → list;recover 把 running 标 stopped(sidecar-restart)、终态不动', async () => {
    const running = makeRecord({ id: 'run-a' });
    const completed = makeRecord({ id: 'run-b', status: 'completed' });
    const exited = makeRecord({ id: 'run-c', status: 'exited', pauseReason: 'provider-error' });
    await saveAutoRunRecord(running, { dir });
    await saveAutoRunRecord(completed, { dir });
    await saveAutoRunRecord(exited, { dir });
    expect(loadAutoRunRecord('run-a', { dir })?.status).toBe('running');
    expect(listAutoRunRecordFiles({ dir })).toHaveLength(3);
    const healed = await recoverOrphanedAutoRuns({ dir });
    expect(healed).toBe(1);
    expect(loadAutoRunRecord('run-a', { dir })?.status).toBe('stopped');
    expect(loadAutoRunRecord('run-a', { dir })?.pauseReason).toBe('sidecar-restart');
    expect(loadAutoRunRecord('run-b', { dir })?.status).toBe('completed');
    expect(loadAutoRunRecord('run-c', { dir })?.status).toBe('exited');
    expect(autoRunFilePath('run/a', dir)).toBe(join(dir, 'runa.json'));
  });
});

// ===== runner 集成(全假依赖) =====

describe('runAutoRunLoop(达成预检通过 → completed)', () => {
  it('declare 附条件与证据 → 预检过 → completed + 广播 outcome=passed;无 verdict/paused 事件', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps({
      resolveEvent: (id) => (id === 1 ? makeEvent(1) : null),
      invoke: async () => {
        declareCompletion(record.loopSessionId, '条件一达成,证据 #1', ['输出 flag{…}'], [1]);
        return { text: 'done', loopSessionId: record.loopSessionId };
      },
    });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    await ctl.waitUntilDone();
    await loop;
    expect(record.status).toBe('completed');
    expect(record.pauseReason).toBeUndefined();
    expect(record.declaration?.statement).toBe('条件一达成,证据 #1');
    expect(dataOf(fake.sent, 'auto-run:completed')).toMatchObject({ id: 'run-1', outcome: 'passed' });
    expect(dataOf(fake.sent, 'auto-run:verdict-requested')).toBeUndefined();
    expect(dataOf(fake.sent, 'auto-run:paused')).toBeUndefined();
    // 声明轮也计入预算 spent(不再漏算)。
    expect(record.budget.spent).toBe(1);
  });
});

describe('runAutoRunLoop(达成预检不过 → 回注继续)', () => {
  it('宣称未对应任何验收条件 → 下一轮驱动文本前置回注,循环继续', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps({
      invoke: async (input) => {
        fake.invokeCount += 1;
        fake.invokeTexts.push(input.text);
        if (fake.invokeCount === 1) {
          declareCompletion(record.loopSessionId, '随便达成', ['不存在的条件'], []);
        }
        await new Promise((r) => setTimeout(r, 0)); // 让出事件循环(waitFor 轮询可交错)
        return { text: 'x', loopSessionId: record.loopSessionId };
      },
    });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.invokeTexts.length >= 2);
    expect(fake.invokeTexts[1]).toContain('【系统注回·达成预检】');
    expect(fake.invokeTexts[1]).toContain('上轮达成宣称未通过证据预检');
    expect(fake.invokeTexts[1]).toContain('宣称未对应任何验收条件');
    expect(record.status).toBe('running');
    ctl.requestStop();
    await done;
    await loop;
    expect(record.status).toBe('stopped');
  });

  it('证据引用全部不存在 → 回注具体失败原因,继续推进', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps({
      resolveEvent: () => null,
      invoke: async (input) => {
        fake.invokeCount += 1;
        fake.invokeTexts.push(input.text);
        if (fake.invokeCount === 1) {
          declareCompletion(record.loopSessionId, '达成', ['输出 flag{…}'], [99]);
        }
        await new Promise((r) => setTimeout(r, 0)); // 让出事件循环(waitFor 轮询可交错)
        return { text: 'x', loopSessionId: record.loopSessionId };
      },
    });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.invokeTexts.length >= 2);
    expect(fake.invokeTexts[1]).toContain('证据引用全部不存在');
    ctl.requestStop();
    await done;
    await loop;
    expect(record.status).toBe('stopped');
  });
});

describe('runAutoRunLoop(provider 连击 N=5 → exited)', () => {
  it('invoke 连续 5 次返回 provider 类错误 → exited(reason=provider-error),如实广播', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps({
      invoke: async () => { fake.invokeCount += 1; return { error: '503 Server Overloaded', text: '', loopSessionId: 'ls-1' }; },
    });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    await ctl.waitUntilDone();
    await loop;
    expect(fake.invokeCount).toBe(PROVIDER_STREAK_EXIT_DEFAULT);
    expect(record.status).toBe('exited');
    expect(record.pauseReason).toBe('provider-error');
    expect(dataOf(fake.sent, 'auto-run:completed')).toMatchObject({
      id: 'run-1',
      outcome: 'exited',
      reason: 'provider-error',
    });
    expect(dataOf(fake.sent, 'auto-run:paused')).toBeUndefined();
    // 失败中断轮也计入 budget.spent(盘上快照同口径)。
    expect(record.turns).toBe(5);
    expect(record.budget.spent).toBe(5);
    expect(fake.saved.at(-1)?.budget.spent).toBe(5);
  });

  it('任何成功 invoke 清连击计数(未满 N 次失败后恢复继续跑)', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps({
      invoke: async () => {
        fake.invokeCount += 1;
        await new Promise((r) => setTimeout(r, 0)); // 让出事件循环(waitFor 轮询可交错)
        if (fake.invokeCount <= 4) return { error: 'timeout', text: '', loopSessionId: 'ls-1' };
        return { text: '恢复', loopSessionId: 'ls-1' };
      },
    });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.invokeCount >= 6);
    expect(record.status).toBe('running');
    ctl.requestStop();
    await done;
    await loop;
    expect(record.status).toBe('stopped');
  });
});

describe('runAutoRunLoop(工具级 isError 是研究信号,不计数不退出)', () => {
  it('尾部 3 连工具错误 + invoke 成功 → 继续推进,无 exited', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps();
    fake.messages.push(
      msgToolResult({ isError: true }),
      msgToolResult({ isError: true }),
      msgToolResult({ isError: true }),
    );
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.invokeCount >= 3);
    expect(record.status).toBe('running');
    expect(dataOf(fake.sent, 'auto-run:completed')).toBeUndefined();
    ctl.requestStop();
    await done;
    await loop;
    expect(record.status).toBe('stopped');
  });
});

describe('runAutoRunLoop(预算耗尽 → stopped)', () => {
  it('turns 预算耗尽 → stopped(reason=budget);无 checkpoint、无 paused、无报告调用', async () => {
    const record = makeRecord({ budget: { kind: 'turns', limit: 1, spent: 0 } });
    const fake = makeFakeDeps();
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    await ctl.waitUntilDone();
    await loop;
    expect(fake.invokeCount).toBe(1);
    expect(record.status).toBe('stopped');
    expect(record.pauseReason).toBe('budget');
    expect(record.budget.spent).toBe(1);
    expect(dataOf(fake.sent, 'auto-run:paused')).toBeUndefined();
    expect(dataOf(fake.sent, 'auto-run:completed')).toMatchObject({ id: 'run-1', outcome: 'stopped', reason: 'budget' });
  });
});

describe('runAutoRunLoop(空转话术注入,K=3)', () => {
  it('连续 K 轮空转 → 下轮注入内置通用话术(标注系统注入);每次检测注入一次', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps({ stallTurns: 3 });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    // 首轮无基线不判;第 2/3/4 轮连空转 → 第 4 轮末判定 → 第 5 轮文本注入。
    await waitFor(() => fake.invokeTexts.length >= 6);
    const injected = fake.invokeTexts.filter((t) => t.includes('【系统注入·空转推进话术】'));
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain(DEFAULT_STALL_PROMPT);
    expect(injected[0]).toContain('「墙」');
    expect(record.status).toBe('running');
    ctl.requestStop();
    await done;
    await loop;
  });

  it('研究员自定义话术优先于内置;off → 纯继续不注入', async () => {
    const record = makeRecord({ stallPrompt: '换个思路再试' });
    const fake = makeFakeDeps({ stallTurns: 3 });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.invokeTexts.length >= 6);
    const injected = fake.invokeTexts.filter((t) => t.includes('【系统注入·空转推进话术】'));
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain('换个思路再试');
    ctl.requestStop();
    await done;
    await loop;
  });

  it('STALL_PROMPT_OFF → 空转不注入,纯继续(浪费由超时封顶)', async () => {
    const record = makeRecord({ stallPrompt: STALL_PROMPT_OFF });
    const fake = makeFakeDeps({ stallTurns: 3 });
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.invokeTexts.length >= 6);
    expect(fake.invokeTexts.every((t) => !t.includes('系统注入'))).toBe(true);
    expect(record.status).toBe('running');
    ctl.requestStop();
    await done;
    await loop;
  });
});

describe('runAutoRunLoop(started / turn-completed 契约)', () => {
  it('started 广播带 criteria 数组与 loopSessionId;turn-completed 带轮次/预算/状态', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps();
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.sent.some((s) => s.event === 'auto-run:turn-completed'));
    const started = dataOf(fake.sent, 'auto-run:started') as { criteria: string[]; criteriaCount: number; loopSessionId: string };
    expect(started.criteria).toEqual(record.criteria);
    expect(started.criteriaCount).toBe(record.criteria.length);
    expect(started.loopSessionId).toBe('ls-1');
    // 广播 payload 的 budget 是 record.budget 活引用(生产侧 formatSse 同步
    // 序列化无此问题)——fake 只存引用,深拷贝冻结首轮广播时的快照再断言。
    const tc = JSON.parse(JSON.stringify(dataOf(fake.sent, 'auto-run:turn-completed'))) as { turn: number; status: string; budget: { spent?: number } };
    expect(tc.turn).toBe(1);
    expect(tc.status).toBe('running');
    expect(tc.budget.spent).toBe(1);
    ctl.requestStop();
    await done;
    await loop;
  });
});

describe('runAutoRunLoop(tokens 预算 × 校准系数)', () => {
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
});

describe('runAutoRunLoop(Esc 终止)', () => {
  it('requestStop → stopped + auto-run:completed{outcome:stopped};spent 计入中断轮', async () => {
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
    expect(record.pauseReason).toBeUndefined();
    expect(dataOf(fake.sent, 'auto-run:completed')).toMatchObject({ id: 'run-1', outcome: 'stopped' });
    expect(record.turns).toBeGreaterThanOrEqual(1);
    expect(record.budget.spent).toBe(record.turns);
    expect(fake.saved.at(-1)?.budget.spent).toBe(record.turns);
  });
});

describe('runAutoRunLoop(终态清理本线声明,不动其他线)', () => {
  it('Esc 后本线声明清空,其他线不动', async () => {
    const record = makeRecord();
    const fake = makeFakeDeps();
    declareCompletion('other-line', '其他线声明', [], []);
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    const done = ctl.waitUntilDone();
    await waitFor(() => fake.invokeCount >= 1);
    declareCompletion(record.loopSessionId, '晚到的声明', [], []);
    ctl.requestStop();
    await done;
    await loop;
    expect(takeCompletionDeclaration(record.loopSessionId)).toBeNull();
    expect(takeCompletionDeclaration('other-line')).not.toBeNull();
  });
});

describe('runAutoRunLoop(1.7.5 显式锚传递)', () => {
  it('invoke 收到环境锚(envKey)+工作区锚(workspaceAnchor)+线 id', async () => {
    const record = makeRecord({ budget: { kind: 'turns', limit: 1, spent: 0 } });
    const fake = makeFakeDeps();
    const ctl = createAutoRunController(record);
    const loop = runAutoRunLoop(record, ctl, fake.deps);
    await ctl.waitUntilDone();
    await loop;
    expect(fake.invokeOptions.length).toBe(1);
    expect(fake.invokeOptions[0]).toMatchObject({
      loopSessionId: 'ls-1',
      envKey: 'pwn-vm',
      workspaceAnchor: '/ws',
    });
  });
});

describe('injectInteractiveWrapUp(收官注回交互线)', () => {
  function collectAppend(): { appended: Array<{ id: string; text: string }>; appendMessages: (id: string, msgs: AgentMessage[]) => Promise<void> } {
    const appended: Array<{ id: string; text: string }> = [];
    return {
      appended,
      appendMessages: async (id, msgs) => {
        appended.push({ id, text: String((msgs[0] as { content: unknown }).content) });
      },
    };
  }

  it('binding.envKey=env:<id> 而 record.envKey=裸 id → 注回真实发生(不再提报告)', () => {
    const record = makeRecord({ envKey: 'pwn-vm' });
    const { appended, appendMessages } = collectAppend();
    injectInteractiveWrapUp(record, '最终结论文本', '已达成', {
      getBinding: () => ({ envKey: 'env:pwn-vm', loopSessionId: 'ls-interactive' }),
      appendMessages,
    });
    expect(appended).toHaveLength(1);
    expect(appended[0].id).toBe('ls-interactive');
    expect(appended[0].text).toContain('【auto loop 收官】');
    expect(appended[0].text).toContain('ls-1');
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

// ===== 注册表:startAutoRun 互斥闸 / 终态摘除 =====

describe('startAutoRun(单实例闸 + 注册表)', () => {
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

  it('同 workspace → 拒绝;终态摘除后 stop 走「不存在」语义', async () => {
    const fake = makeFakeDeps();
    const started = await startAutoRun(startInput, '/ws', fake.deps);
    expect(started.success).toBe(true);
    if (!started.success) return;
    const id = started.data.id;
    await waitFor(() => fake.invokeCount >= 1);
    const second = await startAutoRun(startInput, '/ws/', makeFakeDeps().deps);
    expect(second.success).toBe(false);
    if (!second.success) expect(second.error).toContain('已有运行中的');
    expect(stopAutoRun(id).success).toBe(true);
    // 终态即从 activeRuns 摘除——stop 报「不存在」。
    await waitFor(() => {
      const r = stopAutoRun(id);
      return !r.success && r.error.includes('不存在');
    });
  });

  it('envKey 互斥闸:异 workspace 同 envKey → 拒绝;异 envKey → 放行', async () => {
    const fake = makeFakeDeps();
    const first = await startAutoRun(startInput, '/ws-a', fake.deps);
    expect(first.success).toBe(true);
    if (!first.success) return;
    const second = await startAutoRun(startInput, '/ws-b', makeFakeDeps().deps);
    expect(second.success).toBe(false);
    if (!second.success) {
      expect(second.error).toContain('已被运行中的 auto run');
      expect(second.error).toContain('pwn-vm');
    }
    stopAutoRun(first.data.id);
    await waitFor(() => {
      const r = stopAutoRun(first.data.id);
      return !r.success && r.error.includes('不存在');
    });
    // 收尾后可再起。
    const third = await startAutoRun({ ...startInput, envKey: 'pwn-vm' }, '/ws-b', makeFakeDeps().deps);
    expect(third.success).toBe(true);
    if (third.success) stopAutoRun(third.data.id);
  });

  it('start 载荷 stallPrompt 进 record;愈合缓存按 workspace 一次生效', async () => {
    const fake = makeFakeDeps();
    const started = await startAutoRun({ ...startInput, stallPrompt: 'custom' }, '/ws-heal', fake.deps);
    expect(started.success).toBe(true);
    if (!started.success) {
      return;
    }
    expect(started.data.record.stallPrompt).toBe('custom');
    expect(started.data.record.status).toBe('running');
    await waitFor(() => fake.invokeCount >= 1);
    stopAutoRun(started.data.id);
  });
});
