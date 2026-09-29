/**
 * 1.8.7 P3b 多引擎并发——放掉一台上限的验收测试。
 *
 * 覆盖（全部 mock 边界,照 chat-engine.unit.test.ts 惯例）：
 *  - **并发证明（THE test）**：两个 actor 在两条线上各跑 turn,两个 runLoop
 *    同时在飞——线 A 的 busy 不挡线 B;
 *  - per-line busy 隔离:busy 线的第二条进**该线的** steering,他线直发;
 *  - per-actor 活跃线/controlLineGate:A 的闸不拦 B 的当前线;
 *  - 空闲回收:闲置超阈值 dispose、busy 永不回收、下次访问惰性重建;
 *  - 跨线决策注入:目标线有 live 引擎 → 那台引擎的 steering;无引擎 →
 *    headless invoke 注入目标线。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- mocks(照 chat-engine.unit.test.ts 边界,env-sessions 升级为归属段感知) ----

const broadcastMock = vi.fn();
vi.mock('../sse', () => ({
  broadcast: (...args: unknown[]) => broadcastMock(...args),
  __setLineLiveProbe: () => {},
}));

const lineOwnershipData = new Map<string, { owner?: string; shared?: boolean; updatedAt: string }>();
vi.mock('./line-ownership', () => ({
  getLineOwnership: (id: string) => lineOwnershipData.get(id),
  ensureLineOwner: async (id: string, owner: string) => {
    if (!lineOwnershipData.has(id)) lineOwnershipData.set(id, { owner, updatedAt: '' });
  },
  setLineShared: async () => {},
}));

const runLoopMock = vi.fn();
vi.mock('zhishi-loop-core/loop', async (importOriginal) => {
  const orig = await importOriginal<typeof import('zhishi-loop-core/loop')>();
  return { ...orig, runLoop: (...args: unknown[]) => runLoopMock(...args) };
});

const resolveLoopModelMock = vi.fn();
const resolveLoopModelFromEnvMock = vi.fn();
vi.mock('./pi-provider', () => ({
  resolveLoopModel: () => resolveLoopModelMock(),
  resolveLoopModelFromEnv: (...args: unknown[]) => resolveLoopModelFromEnvMock(...args),
}));

const loadLoopSessionMock = vi.fn();
const appendLoopMessagesMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock('zhishi-loop-core/session', async (importOriginal) => {
  const orig = await importOriginal<typeof import('zhishi-loop-core/session')>();
  let seq = 0;
  return {
    ...orig,
    newLoopSessionId: () => `ls-${++seq}`,
    loadLoopSession: (...args: unknown[]) => loadLoopSessionMock(...args),
    appendLoopMessages: (...args: unknown[]) => appendLoopMessagesMock(...args),
    truncateLoopSession: vi.fn(async () => {}),
    forkLoopSession: vi.fn(async () => 'fork-ls-1'),
    markLoopSessionCompacted: vi.fn(async () => {}),
  };
});

const selectionMock = vi.fn((..._args: unknown[]): unknown => ({ kind: 'host' }));
vi.mock('../environment/selection', () => ({
  HOST_SELECTION: { kind: 'host' },
  loadSelectionStore: () => ({}),
  getWorkspaceSelection: (_store: unknown, dir: string) => selectionMock(dir),
  getWorkspaceSelectionRecord: (_store: unknown, dir: string) => ({ selection: selectionMock(dir), selectedAt: '' }),
}));

// 归属段感知的分线映射 mock:解析链 = 私有键 → 共享键 → 旧键(与生产同口径)。
const envSessionsData = new Map<string, { loopSessionId: string; updatedAt: string }>();
const normWs = (ws: string) => ws.replace(/\\/g, '/');
const lineKey = (ws: string, key: string, seg?: string) =>
  seg ? `${normWs(ws)}::${seg}::${key}` : `${normWs(ws)}::${key}`;
vi.mock('../environment/env-sessions', () => ({
  envKeyForSelection: (sel: { kind: string; id?: string; instanceId?: string }) =>
    sel.kind === 'env' ? `env:${sel.id}` : sel.kind === 'recipe' ? `recipe:${sel.instanceId}` : 'host',
  normalizeWorkspaceKey: (ws: string) => normWs(ws),
  envSessionLineKey: (ws: string, key: string, seg?: string) => lineKey(ws, key, seg),
  SHARED_LINE_SEGMENT: 'shared',
  getEnvSessionLine: (_map: unknown, ws: string, key: string, opts?: { actor?: string }) => {
    if (opts?.actor) {
      const own = envSessionsData.get(lineKey(ws, key, opts.actor));
      if (own) return own;
      const shared = envSessionsData.get(lineKey(ws, key, 'shared'));
      if (shared) return shared;
    }
    return envSessionsData.get(lineKey(ws, key));
  },
  findEnvKeyForLoopSession: (_map: unknown, ws: string, loopId: string) => {
    const prefix = `${normWs(ws)}::`;
    for (const [k, l] of envSessionsData) {
      if (k.startsWith(prefix) && l.loopSessionId === loopId) {
        const suffix = k.slice(prefix.length);
        const sep = suffix.indexOf('::');
        return sep >= 0 ? suffix.slice(sep + 2) : suffix;
      }
    }
    return null;
  },
  loadEnvSessionsMap: () => ({}),
  setEnvSessionLine: async (ws: string, key: string, loopSessionId: string, _path?: string, seg?: string) => {
    envSessionsData.set(lineKey(ws, key, seg), { loopSessionId, updatedAt: '' });
  },
  removeEnvSessionLine: async (ws: string, key: string, _path?: string, seg?: string) => {
    if (seg) envSessionsData.delete(lineKey(ws, key, seg));
    envSessionsData.delete(lineKey(ws, key));
  },
  removeEnvSessionsForEnvId: async () => {},
}));

vi.mock('../utils/admin-config', () => ({
  loadConfig: () => ({ environments: [], loopEngine: undefined }),
}));

const getSessionsByAgentDirMock = vi.fn(() => [] as unknown[]);
const getSessionMetadataMock = vi.fn((..._args: unknown[]) => null as unknown);
vi.mock('../SessionStore', () => ({
  createSession: vi.fn(async () => ({ id: 'meta-new' })),
  getSessionsByAgentDir: () => getSessionsByAgentDirMock(),
  getSessionMetadata: (...args: unknown[]) => getSessionMetadataMock(...args),
  updateSessionMetadata: vi.fn(async () => {}),
}));

vi.mock('./boundary', () => ({ makeBoundaryHook: () => async () => undefined }));
vi.mock('zhishi-loop-core/output-guard', () => ({ makeOutputGuardHook: () => async () => undefined }));
vi.mock('./window-transform', () => ({ makeWindowTransform: () => async (m: unknown) => m, WINDOW_OVERFLOW_RETRY_RATIO: 0.15, WORKING_MEMORY_TARGET_RATIO: 0.25 }));
vi.mock('./bg-exec', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./bg-exec')>();
  return { ...orig, envBgReap: vi.fn(async () => ({ ok: true, outcome: 'reaped' })) };
});
vi.mock('./bg-registry', () => ({
  initBgRegistry: () => ({}),
  getBgRegistry: () => ({ list: () => [], remove: () => {} }),
}));
vi.mock('../system-prompt', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../system-prompt')>();
  return { ...orig, buildSystemPromptAppend: () => '' };
});
vi.mock('../system-prompt-security', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../system-prompt-security')>();
  return {
    ...orig,
    collectSecurityCapabilities: vi.fn(async () => ({})),
    collectResearchMemory: vi.fn(() => ({})),
  };
});
vi.mock('../memory/distill', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../memory/distill')>();
  return { ...orig, loadDistilledMemoryForPrompt: () => undefined };
});
vi.mock('./refs', () => ({
  parseChatRefs: () => ({ refs: [], invalid: [] }),
  resolveChatRefs: async () => '',
}));
vi.mock('./tools', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./tools')>();
  return orig;
});
vi.mock('./expert-inject', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./expert-inject')>();
  return { ...orig, collectExpertInjection: () => undefined };
});

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  __resetEnginesForTests,
  controlLineGate,
  getActiveLoopSessionId,
  getLiveEngineState,
  hasLiveEngine,
  initPiChatEngine,
  injectPiDecision,
  sendPiChatMessage,
  sweepIdleEngines,
} from './chat-engine';
import { withLogContext } from '../logger-context';

const RESOLUTION = {
  models: {},
  model: { id: 'k3', contextWindow: 262144, reasoning: false },
  getApiKey: () => 'fake-key',
  providerId: 'moonshot-coding',
  modelId: 'k3',
};

function userMsg(text: string, timestamp = 1): AgentMessage {
  return { role: 'user', content: text, timestamp } as AgentMessage;
}
function assistantMsg(text: string): AgentMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text }], model: 'k3',
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: {} },
    stopReason: 'stop', timestamp: 2,
  } as unknown as AgentMessage;
}
function doneEvents(text: string) {
  return [
    { type: 'text-delta', delta: text },
    { type: 'done', messages: [userMsg('q'), assistantMsg(text)] },
  ];
}

/** 前 n 次 runLoop 调用挂闸(并发在飞的证据),之后的调用即时完成——
 *  steering 孤儿 promote 出的后续 turn 不会再被闸住。返回 release-all。 */
function gateFirstTurns(n: number): () => void {
  const releases: Array<() => void> = [];
  runLoopMock.mockImplementation(async function* () {
    if (releases.length < n) {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      releases.push(release);
      await gate;
    }
    for (const e of doneEvents('done-text')) yield e;
  });
  return () => releases.forEach((release) => release());
}

function asActor<T>(name: string, role: 'readonly' | 'operator' | 'reviewer', fn: () => T): T {
  return withLogContext({ actorName: name, actorRole: role }, fn);
}

async function waitLineIdle(line: string) {
  await vi.waitFor(() => {
    expect(getLiveEngineState(line)?.sessionState).toBe('idle');
  }, { timeout: 3000, interval: 10 });
}

beforeEach(async () => {
  vi.clearAllMocks();
  envSessionsData.clear();
  lineOwnershipData.clear();
  __resetEnginesForTests();
  resolveLoopModelMock.mockReturnValue(RESOLUTION);
  resolveLoopModelFromEnvMock.mockReturnValue(RESOLUTION);
  loadLoopSessionMock.mockReturnValue({ messages: [], meta: null });
  selectionMock.mockReturnValue({ kind: 'host' });
  runLoopMock.mockImplementation(async function* () {
    for (const e of doneEvents('主机名是 fuzz')) yield e;
  });
  await initPiChatEngine('E:/ws');
  broadcastMock.mockClear();
});

describe('P3b 多引擎并发(放掉一台上限)', () => {
  it('并发证明:两个 actor 在两条线上各跑 turn,两个 runLoop 同时在飞', async () => {
    // alice/bob 各自的私有分线映射(host 环境键)
    envSessionsData.set('E:/ws::alice::host', { loopSessionId: 'ls-alice', updatedAt: '' });
    envSessionsData.set('E:/ws::bob::host', { loopSessionId: 'ls-bob', updatedAt: '' });
    const releaseAll = gateFirstTurns(2);

    const r1 = await asActor('alice', 'operator', () => sendPiChatMessage({ text: 'A 线开工' }));
    const r2 = await asActor('bob', 'operator', () => sendPiChatMessage({ text: 'B 线开工' }));
    expect(r1).toMatchObject({ isInFlight: true });
    expect(r2).toMatchObject({ isInFlight: true });
    // THE PROOF:两台引擎各自 busy,两个 runLoop 同时在飞——线 A 的 busy 没挡线 B。
    expect(runLoopMock).toHaveBeenCalledTimes(2);
    expect(getLiveEngineState('ls-alice')?.sessionState).toBe('running');
    expect(getLiveEngineState('ls-bob')?.sessionState).toBe('running');

    releaseAll();
    await waitLineIdle('ls-alice');
    await waitLineIdle('ls-bob');
    // 两线的续存各回各线,不串线
    const appended = appendLoopMessagesMock.mock.calls.map((c) => c[0]);
    expect(appended).toContain('ls-alice');
    expect(appended).toContain('ls-bob');
    // 事件按线带路由键(第三参 {line})
    const replayCalls = broadcastMock.mock.calls.filter(
      (c) => c[0] === 'chat:message-replay' && (c[2] as { line?: string } | undefined)?.line === 'ls-bob',
    );
    expect(replayCalls.length).toBeGreaterThan(0);
  });

  it('per-line busy 隔离:busy 线的第二条进该线 steering;他线直发不排队', async () => {
    envSessionsData.set('E:/ws::alice::host', { loopSessionId: 'ls-alice', updatedAt: '' });
    envSessionsData.set('E:/ws::bob::host', { loopSessionId: 'ls-bob', updatedAt: '' });
    const releaseAll = gateFirstTurns(2);

    await asActor('alice', 'operator', () => sendPiChatMessage({ text: 'A1' }));
    // alice 的线 busy → 她的第二条进 steering(今日语义,per-line)
    const s2 = await asActor('alice', 'operator', () => sendPiChatMessage({ text: 'A2' }));
    expect(s2).toMatchObject({ queued: true, steering: true });
    // bob 的线闲 → 直发,不被 alice 的 busy 阻塞(一台上限已放掉)
    const s3 = await asActor('bob', 'operator', () => sendPiChatMessage({ text: 'B1' }));
    expect(s3).toMatchObject({ isInFlight: true });
    expect(s3.steering).toBeUndefined();
    expect(runLoopMock).toHaveBeenCalledTimes(2);

    releaseAll();
    await waitLineIdle('ls-alice');
    await waitLineIdle('ls-bob');
  });

  it('per-actor 活跃线/controlLineGate:A 的闸不拦 B 的当前线', async () => {
    envSessionsData.set('E:/ws::alice::host', { loopSessionId: 'ls-alice', updatedAt: '' });
    envSessionsData.set('E:/ws::bob::host', { loopSessionId: 'ls-bob', updatedAt: '' });
    asActor('alice', 'operator', () => {
      expect(controlLineGate('ls-alice')).toBeNull(); // 自己的当前线放行
      expect(controlLineGate(undefined)).toBeNull();
      expect(controlLineGate('ls-bob')).toMatchObject({ error: 'line_not_active', activeSessionId: 'ls-alice' });
    });
    asActor('bob', 'operator', () => {
      expect(controlLineGate('ls-bob')).toBeNull();
      expect(controlLineGate('ls-alice')).toMatchObject({ error: 'line_not_active', activeSessionId: 'ls-bob' });
    });
    // 本机 actor(local):启动线即当前线,与 P3a 逐字节相同
    expect(getActiveLoopSessionId()).not.toBe('ls-alice');
    expect(controlLineGate('ls-alice')).toMatchObject({ error: 'line_not_active' });
  });

  it('空闲回收:闲置超阈值 dispose,busy 永不回收,下次访问惰性重建', async () => {
    envSessionsData.set('E:/ws::alice::host', { loopSessionId: 'ls-alice', updatedAt: '' });
    envSessionsData.set('E:/ws::bob::host', { loopSessionId: 'ls-bob', updatedAt: '' });
    const releaseAll = gateFirstTurns(1);
    await asActor('alice', 'operator', () => sendPiChatMessage({ text: 'A1' })); // gated → busy
    expect(hasLiveEngine('ls-alice')).toBe(true);

    // busy 永不回收
    const future = Date.now() + 31 * 60_000;
    let evicted = sweepIdleEngines(future);
    expect(evicted).not.toContain('ls-alice');
    expect(hasLiveEngine('ls-alice')).toBe(true);

    // turn 跑完(打戳)后仍闲置 → 超阈值回收
    releaseAll();
    await waitLineIdle('ls-alice');
    evicted = sweepIdleEngines(Date.now() + 31 * 60_000);
    expect(evicted).toContain('ls-alice');
    expect(hasLiveEngine('ls-alice')).toBe(false);

    // 惰性重建:回收后再 send,引擎按线重建(transcript 从盘上装载)并跑 turn
    const r = await asActor('alice', 'operator', () => sendPiChatMessage({ text: 'A2' }));
    expect(r).toMatchObject({ isInFlight: true });
    expect(hasLiveEngine('ls-alice')).toBe(true);
    expect(loadLoopSessionMock.mock.calls.some((c) => c[0] === 'ls-alice')).toBe(true);
    await waitLineIdle('ls-alice');
  });

  it('跨线决策注入:目标线有 live 引擎 → 那台引擎的 steering(不是调用方当前线)', async () => {
    envSessionsData.set('E:/ws::alice::host', { loopSessionId: 'ls-alice', updatedAt: '' });
    const releaseAll = gateFirstTurns(1);
    await asActor('alice', 'operator', () => sendPiChatMessage({ text: 'A1' })); // ls-alice busy
    broadcastMock.mockClear();

    // bob 应答属于 alice 线的决策——注入目标是 ls-alice 的引擎(steering),
    // 与 bob 自己的当前线无关。
    const r = await asActor('bob', 'reviewer', () =>
      injectPiDecision({ decisionId: 'dec-1', sessionId: 'ls-alice', choice: '方案一' }),
    );
    expect(r.success).toBe(true);
    const steeringAdded = broadcastMock.mock.calls.filter(
      (c) => c[0] === 'chat:steering-added'
        && (c[1] as { sessionId?: string }).sessionId === 'ls-alice'
        && (c[2] as { line?: string } | undefined)?.line === 'ls-alice',
    );
    expect(steeringAdded).toHaveLength(1);
    releaseAll();
    await waitLineIdle('ls-alice');
  });

  it('跨线决策注入:目标线无 live 引擎 → headless invoke 注入该线(jsonl 续存)', async () => {
    const r = await injectPiDecision({ decisionId: 'dec-2', sessionId: 'ls-headless', choice: '方案二' });
    expect(r.success).toBe(true);
    expect(appendLoopMessagesMock.mock.calls.some((c) => c[0] === 'ls-headless')).toBe(true);
    // headless 路径不起交互引擎
    expect(hasLiveEngine('ls-headless')).toBe(false);
  });
});
