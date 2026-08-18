/**
 * M4a/M4b — chat-engine(loop/chat-engine.ts)unit tests.
 *
 * 引擎开关(env > config 优先级)、env 锚定、send 流程、M4b 队列语义
 * (排队/自动接/stop 清空/cancel/force/status)、会话跨重启续接、
 * rewind 截断、图片块、thinking 档位。全部 mock 边界(broadcast/
 * runLoop/pi-provider/session/selection/admin-config/SessionStore),
 * 绝无网络/ssh/真盘。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

// ---- mocks ----

const broadcastMock = vi.fn();
vi.mock('../sse', () => ({
  broadcast: (...args: unknown[]) => broadcastMock(...args),
}));

const runLoopMock = vi.fn();
vi.mock('./loop', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./loop')>();
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
const truncateLoopSessionMock = vi.fn(async (..._args: unknown[]) => {});
const forkLoopSessionMock = vi.fn(async (..._args: unknown[]) => 'fork-ls-1');
vi.mock('./session', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./session')>();
  let seq = 0;
  return {
    ...orig,
    newLoopSessionId: () => `ls-${++seq}`,
    loadLoopSession: () => loadLoopSessionMock(),
    appendLoopMessages: (...args: unknown[]) => appendLoopMessagesMock(...args),
    truncateLoopSession: (...args: unknown[]) => truncateLoopSessionMock(...args),
    forkLoopSession: (...args: unknown[]) => forkLoopSessionMock(...args),
    markLoopSessionCompacted: vi.fn(async () => {}),
  };
});

const selectionMock = vi.fn();
vi.mock('../environment/selection', () => ({
  loadSelectionStore: () => ({}),
  getWorkspaceSelection: (_store: unknown, dir: string) => selectionMock(dir),
}));

const configEnvironments = vi.fn(() => [] as unknown[]);
const configLoopEngine = vi.fn(() => undefined as 'sdk' | 'pi' | undefined);
vi.mock('../utils/admin-config', () => ({
  loadConfig: () => ({ environments: configEnvironments(), loopEngine: configLoopEngine() }),
}));

const getSessionsByAgentDirMock = vi.fn(() => [] as unknown[]);
const createSessionMock = vi.fn(async (..._args: unknown[]) => ({ id: 'meta-new' }));
const updateSessionMetadataMock = vi.fn(async (..._args: unknown[]) => {});
const getSessionMetadataMock = vi.fn((..._args: unknown[]) => null as unknown);
vi.mock('../SessionStore', () => ({
  createSession: (...args: unknown[]) => createSessionMock(...args),
  getSessionsByAgentDir: () => getSessionsByAgentDirMock(),
  getSessionMetadata: (...args: unknown[]) => getSessionMetadataMock(...args),
  updateSessionMetadata: (...args: unknown[]) => updateSessionMetadataMock(...args),
}));

vi.mock('./boundary', () => ({ makeBoundaryHook: () => async () => undefined }));
vi.mock('./output-guard', () => ({ makeOutputGuardHook: () => async () => undefined }));
vi.mock('./compaction', () => ({ makeCompactionTransform: () => async (m: unknown) => m }));

// 系统提示组装:数据采集点 mock(纯函数 buildSystemPromptAppend 走真实实现),
// 不碰真实引擎探测/蒸馏文件/memories db。
const collectCapsMock = vi.fn(async (..._args: unknown[]) => ({}));
const collectResearchMock = vi.fn((..._args: unknown[]) => ({ successPaths: '', failureRoots: '', toolCombos: '' }));
vi.mock('../system-prompt-security', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../system-prompt-security')>();
  return {
    ...orig,
    collectSecurityCapabilities: (...args: unknown[]) => collectCapsMock(...args),
    collectResearchMemory: (...args: unknown[]) => collectResearchMock(...args),
  };
});

const distilledMock = vi.fn(() => undefined as unknown);
vi.mock('../memory/distill', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../memory/distill')>();
  return { ...orig, loadDistilledMemoryForPrompt: () => distilledMock() };
});

// W1 — refs 解析 mock:grounding 由注入值控制,不真碰 env 通道。
const parseChatRefsMock = vi.fn((raw: unknown) =>
  raw ? { refs: [{ type: 'file', path: '/work/exp.py' }], invalid: [] } : { refs: [], invalid: [] });
const resolveChatRefsMock = vi.fn(async (..._args: unknown[]) => '<context ref="file:/work/exp.py">EXP</context>');
vi.mock('./refs', () => ({
  parseChatRefs: (raw: unknown) => parseChatRefsMock(raw),
  resolveChatRefs: (...args: unknown[]) => resolveChatRefsMock(...args),
}));

import {
  cancelPiQueueItem,
  forcePiQueueItem,
  getPiAgentState,
  getPiMessages,
  getPiQueueStatus,
  getPiSystemInitInfo,
  initPiChatEngine,
  isPiEngine,
  queuePiChatMessage,
  resetPiChat,
  resolveLoopEngine,
  resolveSessionEnv,
  rewindPiChat,
  forkPiChat,
  sendPiChatMessage,
  stopPiChat,
} from './chat-engine';

const RESOLUTION = {
  models: {},
  model: { id: 'k3', contextWindow: 262144, reasoning: true },
  getApiKey: () => 'fake-key',
  providerId: 'moonshot-coding',
  modelId: 'k3',
};

const VM_ENTRY = {
  id: 'pwn-vm', kind: 'vm', vmName: 'pwn-vm',
  address: '192.168.152.129', user: 'researcher', createdAt: '',
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

async function waitTurnSettled() {
  await vi.waitFor(() => {
    expect(getPiAgentState().sessionState).toBe('idle');
  }, { timeout: 3000, interval: 10 });
}

/** 门控 turn:第一次调用挂起直到 release(),之后即时完成。 */
function gateFirstTurn() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let first = true;
  runLoopMock.mockImplementation(async function* () {
    if (first) {
      first = false;
      await gate;
    }
    for (const e of doneEvents('done-text')) yield e;
  });
  return release;
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetPiChat();
  resolveLoopModelMock.mockReturnValue(RESOLUTION);
  resolveLoopModelFromEnvMock.mockReturnValue(RESOLUTION);
  loadLoopSessionMock.mockReturnValue({ messages: [], meta: null });
  selectionMock.mockReturnValue({ kind: 'host' });
  configEnvironments.mockReturnValue([]);
  configLoopEngine.mockReturnValue(undefined);
  getSessionsByAgentDirMock.mockReturnValue([]);
  getSessionMetadataMock.mockReturnValue(null);
  distilledMock.mockReturnValue(undefined);
  collectCapsMock.mockResolvedValue({
    engines: { engines: [] },
    recipes: [],
    environments: [VM_ENTRY],
    selection: { kind: 'env', id: 'pwn-vm' },
  });
  collectResearchMock.mockReturnValue({ successPaths: '', failureRoots: '', toolCombos: '' });
  runLoopMock.mockImplementation(async function* () {
    for (const e of doneEvents('主机名是 fuzz')) yield e;
  });
  await initPiChatEngine('E:/ws');
  broadcastMock.mockClear();
});

describe('引擎开关(M4c 硬切:恒 pi,sdk 请求告警回落)', () => {
  it('resolveLoopEngine:任何输入恒 pi', () => {
    expect(resolveLoopEngine({ ZHISHI_LOOP_ENGINE: 'pi' } as NodeJS.ProcessEnv, 'sdk')).toBe('pi');
    expect(resolveLoopEngine({ ZHISHI_LOOP_ENGINE: 'sdk' } as NodeJS.ProcessEnv, 'pi')).toBe('pi');
    expect(resolveLoopEngine({} as NodeJS.ProcessEnv, 'pi')).toBe('pi');
    expect(resolveLoopEngine({} as NodeJS.ProcessEnv, 'sdk')).toBe('pi');
    expect(resolveLoopEngine({} as NodeJS.ProcessEnv, undefined)).toBe('pi');
  });

  it('isPiEngine:恒 true(含显式 sdk 请求)', () => {
    configLoopEngine.mockReturnValue('pi');
    expect(isPiEngine({} as NodeJS.ProcessEnv)).toBe(true);
    configLoopEngine.mockReturnValue('sdk');
    expect(isPiEngine({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isPiEngine({ ZHISHI_LOOP_ENGINE: 'sdk' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isPiEngine({ ZHISHI_LOOP_ENGINE: 'pi' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('getPiAgentState 携带 loopEngine=pi(TUI 状态区)', () => {
    expect(getPiAgentState().loopEngine).toBe('pi');
  });
});

describe('resolveSessionEnv(env 锚定)', () => {
  it('host → null;env 命中 → 条目;缺失 → null', () => {
    expect(resolveSessionEnv('E:/ws')).toBeNull();
    selectionMock.mockReturnValue({ kind: 'env', id: 'pwn-vm' });
    configEnvironments.mockReturnValue([VM_ENTRY]);
    expect(resolveSessionEnv('E:/ws')?.id).toBe('pwn-vm');
    selectionMock.mockReturnValue({ kind: 'env', id: 'ghost' });
    expect(resolveSessionEnv('E:/ws')).toBeNull();
  });

  it('Windows 斜杠形态漂移:反斜杠 host/无记录 → 正斜杠形态兜底命中', () => {
    configEnvironments.mockReturnValue([VM_ENTRY]);
    selectionMock.mockImplementation((dir: string) =>
      dir.includes('\\') ? { kind: 'host' } : { kind: 'env', id: 'pwn-vm' });
    // 反斜杠(agentDir 经 path.resolve 的形态)兜底到正斜杠命中
    expect(resolveSessionEnv('E:\\ws')?.id).toBe('pwn-vm');
    // 两形态都 host → null
    selectionMock.mockReturnValue({ kind: 'host' });
    expect(resolveSessionEnv('E:\\ws')).toBeNull();
    expect(resolveSessionEnv('E:/ws')).toBeNull();
  });

  it('悬空选定(条目已删)同样回退到另一斜杠形态(活体:vmware-fuzz.vmx 坑)', () => {
    configEnvironments.mockReturnValue([VM_ENTRY]); // 只有 pwn-vm
    selectionMock.mockImplementation((dir: string) =>
      dir.includes('\\') ? { kind: 'env', id: 'ghost-vm' } : { kind: 'env', id: 'pwn-vm' });
    // 反斜杠形态选定存在但条目已删 → 必须回退到正斜杠形态,而非 null。
    expect(resolveSessionEnv('E:\\ws')?.id).toBe('pwn-vm');
    // 两形态都悬空 → null
    selectionMock.mockReturnValue({ kind: 'env', id: 'ghost-vm' });
    expect(resolveSessionEnv('E:\\ws')).toBeNull();
  });
});

describe('send 流程(基础)', () => {
  it('完整 turn:echo → system-init → SSE → 续存;thinking 档位传递', async () => {
    const r = await sendPiChatMessage({ text: '查 hostname', model: 'k3', providerEnv: { apiKey: 'k' } });
    expect(r).toMatchObject({ queued: false, isInFlight: true });
    await waitTurnSettled();

    const events = broadcastMock.mock.calls.map((c) => [c[0], c[1]] as const);
    // W1 — 首个事件是 chat:status running(turn 开始),随后才是用户气泡 echo。
    expect(events[0][0]).toBe('chat:status');
    expect(events[1][0]).toBe('chat:message-replay');
    expect(events.some(([e]) => e === 'chat:system-init')).toBe(true);
    expect(events.some(([e, d]) => e === 'chat:message-chunk' && d === '主机名是 fuzz')).toBe(true);
    expect(events.some(([e]) => e === 'chat:message-complete')).toBe(true);
    expect(events.some(([e]) => e === 'chat:context-usage')).toBe(true);
    // model.reasoning=true → reasoning: 'low' 传给 runLoop
    const opts = runLoopMock.mock.calls[0][0] as { reasoning?: string };
    expect(opts.reasoning).toBe('low');
    // SessionStore 绑定:createSession + loopSessionId 写入
    expect(createSessionMock).toHaveBeenCalled();
    expect(updateSessionMetadataMock.mock.calls.some(
      (c) => (c[1] as { loopSessionId?: string }).loopSessionId !== undefined,
    )).toBe(true);
  });

  it('解析失败 → error,不进入 busy', async () => {
    resolveLoopModelFromEnvMock.mockReturnValue(null);
    const r = await sendPiChatMessage({ text: 'hi', providerEnv: { apiKey: 'k' } });
    expect(r.error).toContain('无可用的 provider/model');
    expect(getPiAgentState().sessionState).toBe('idle');
  });

  it('图片输入:pi 消息带 image 块,气泡带 attachments', async () => {
    await sendPiChatMessage({
      text: '看这张图',
      images: [{ name: 'shot.png', mimeType: 'image/png', data: 'aGVsbG8=' }],
    });
    await waitTurnSettled();
    const opts = runLoopMock.mock.calls[0][0] as { messages?: AgentMessage[] };
    expect(opts.messages).toHaveLength(1);
    const content = (opts.messages![0] as { content: Array<{ type: string; data?: string; mimeType?: string }> }).content;
    expect(content[0]).toEqual({ type: 'text', text: '看这张图' });
    expect(content[1]).toEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
    const wire = getPiMessages().find((m) => m.role === 'user');
    expect(wire?.attachments?.[0]).toMatchObject({ name: 'shot.png', isImage: true });
  });
});

describe('队列语义(M4b FIFO,经 /chat/queue 入口 queuePiChatMessage)', () => {
  it('busy → 排队(queue:added isInFlight:false + queueId)', async () => {
    const release = gateFirstTurn();
    const first = await queuePiChatMessage({ text: 'one' });
    expect(first.isInFlight).toBe(true);
    const second = await queuePiChatMessage({ text: 'two' });
    expect(second.queued).toBe(true);
    expect(second.queueId).toBeTruthy();
    expect(second.isInFlight).toBe(false);
    const added = broadcastMock.mock.calls.find(
      (c) => c[0] === 'queue:added' && (c[1] as { isInFlight: boolean }).isInFlight === false,
    );
    expect(added).toBeDefined();
    expect((added![1] as { queueId: string }).queueId).toBe(second.queueId);
    release();
    await waitTurnSettled();
  });

  it('done 后自动接下一条(queue:added isInFlight:true,依序两 turn)', async () => {
    const release = gateFirstTurn();
    await queuePiChatMessage({ text: 'one' });
    const second = await queuePiChatMessage({ text: 'two' });
    expect(getPiQueueStatus()).toEqual([{ id: second.queueId, messagePreview: 'two', kind: 'fifo' }]);
    release();
    await vi.waitFor(() => expect(runLoopMock).toHaveBeenCalledTimes(2), { timeout: 3000, interval: 10 });
    await waitTurnSettled();
    const promoted = broadcastMock.mock.calls.find(
      (c) => c[0] === 'queue:added' && (c[1] as { isInFlight: boolean }).isInFlight === true,
    );
    expect((promoted![1] as { queueId: string }).queueId).toBe(second.queueId);
    // FIFO:第二 turn 的 prompt 是 'two'
    const secondCall = runLoopMock.mock.calls[1][0] as { prompt?: string };
    expect(secondCall.prompt).toBe('two');
    expect(getPiQueueStatus()).toEqual([]);
  });

  it('stop:清空队列(逐条 queue:cancelled)+ abort,不再自动接', async () => {
    const release = gateFirstTurn();
    await queuePiChatMessage({ text: 'one' });
    const q2 = await queuePiChatMessage({ text: 'two' });
    const q3 = await queuePiChatMessage({ text: 'three' });
    expect(stopPiChat()).toBe(true);
    const cancelled = broadcastMock.mock.calls
      .filter((c) => c[0] === 'queue:cancelled')
      .map((c) => (c[1] as { queueId: string }).queueId);
    expect(cancelled).toEqual(expect.arrayContaining([q2.queueId, q3.queueId]));
    expect(getPiQueueStatus()).toEqual([]);
    release();
    await waitTurnSettled();
    // 队列已清空:gate 释放后不再有新 turn
    expect(runLoopMock).toHaveBeenCalledTimes(1);
  });

  it('cancelPiQueueItem:移除并广播;不存在 → null', async () => {
    const release = gateFirstTurn();
    await queuePiChatMessage({ text: 'one' });
    const q2 = await queuePiChatMessage({ text: 'two' });
    expect(cancelPiQueueItem(q2.queueId!)).toBe('two');
    expect(getPiQueueStatus()).toEqual([]);
    expect(cancelPiQueueItem('nope')).toBeNull();
    release();
    await waitTurnSettled();
    expect(runLoopMock).toHaveBeenCalledTimes(1);
  });

  it('forcePiQueueItem:中断当前,改跑指定项', async () => {
    let firstSignal: AbortSignal | undefined;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => { releaseFirst = r; });
    let call = 0;
    runLoopMock.mockImplementation(async function* (opts: { signal?: AbortSignal }) {
      call++;
      if (call === 1) {
        firstSignal = opts.signal;
        await Promise.race([gate, new Promise<void>((r) => opts.signal?.addEventListener('abort', () => r()))]);
        if (opts.signal?.aborted) return;
      }
      for (const e of doneEvents('forced')) yield e;
    });
    await sendPiChatMessage({ text: 'one' });
    const q2 = await queuePiChatMessage({ text: 'urgent' });
    const ok = await forcePiQueueItem(q2.queueId!);
    expect(ok).toBe(true);
    expect(firstSignal?.aborted).toBe(true);
    await waitTurnSettled();
    const urgentCall = runLoopMock.mock.calls[call - 1][0] as { prompt?: string };
    expect(urgentCall.prompt).toBe('urgent');
    releaseFirst();
  });
});

describe('会话跨重启(M4b)', () => {
  it('init 续接最近的 loop 会话:历史重建 + 后续 turn 续用同一 sessionId', async () => {
    getSessionsByAgentDirMock.mockReturnValue([
      { id: 'meta-old', loopSessionId: 'ls-77', lastActiveAt: '2026-08-16T01:00:00Z' },
    ]);
    loadLoopSessionMock.mockReturnValue({
      messages: [userMsg('旧问题'), assistantMsg('旧回答'), { role: 'toolResult', toolCallId: 't', toolName: 'env_exec', content: [], isError: false, timestamp: 3 } as unknown as AgentMessage],
      meta: { model: 'k3', createdAt: 'c', updatedAt: 'u' },
    });
    resetPiChat();
    await initPiChatEngine('E:/ws');
    // 回放重建:toolResult 重放为 tool 卡(带 name/ok),空结论不再悬空
    const wire = getPiMessages();
    expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(wire[0].content).toBe('旧问题');
    expect((wire[2] as { name?: string; ok?: boolean }).name).toBe('env_exec');
    expect((wire[2] as { name?: string; ok?: boolean }).ok).toBe(true);
    // 续跑:history 来自 ls-77,续存也写 ls-77
    await sendPiChatMessage({ text: '继续' });
    await waitTurnSettled();
    expect(appendLoopMessagesMock.mock.calls[0][0]).toBe('ls-77');
  });

  it('无绑定会话 → init 后为空会话', async () => {
    resetPiChat();
    await initPiChatEngine('E:/ws');
    expect(getPiMessages()).toEqual([]);
  });
});

describe('rewind(M4b)', () => {
  it('截断到指定用户消息之前,内存按截断后历史重建', async () => {
    // 两个 turn 造两条用户消息
    await sendPiChatMessage({ text: 'q1' });
    await waitTurnSettled();
    await sendPiChatMessage({ text: 'q2' });
    await waitTurnSettled();

    const wireUsers = getPiMessages().filter((m) => m.role === 'user');
    // loop 历史:q1 turn(user+assistant)+ q2 turn(user+assistant)
    const loopHistory = [userMsg('q1'), assistantMsg('a1'), userMsg('q2'), assistantMsg('a2')];
    loadLoopSessionMock.mockReturnValue({ messages: loopHistory, meta: null });
    loadLoopSessionMock.mockReturnValueOnce({ messages: loopHistory, meta: null }) // rewind 读
      .mockReturnValue({ messages: loopHistory.slice(0, 2), meta: null }); // 截断后重建读

    const r = await rewindPiChat(wireUsers[1].id);
    expect(r.success).toBe(true);
    // 第 2 条 user(ordinal=1)→ loop 截到下标 2(q2 之前)
    expect(truncateLoopSessionMock).toHaveBeenCalledWith(expect.any(String), 2);
    expect(getPiMessages().filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['q1']);
  });

  it('busy 中拒绝;消息不存在 → error', async () => {
    const release = gateFirstTurn();
    await sendPiChatMessage({ text: 'one' });
    expect((await rewindPiChat('x')).error).toContain('进行中');
    release();
    await waitTurnSettled();
    expect((await rewindPiChat('nope')).error).toBe('Message not found');
  });
});

describe('fork(分叉)', () => {
  it('在指定消息所在 turn 末尾分叉:原会话不动,当前换血到新 loop 会话', async () => {
    await sendPiChatMessage({ text: 'q1' });
    await waitTurnSettled();
    await sendPiChatMessage({ text: 'q2' });
    await waitTurnSettled();

    const wire = getPiMessages();
    const forkedHistory = [userMsg('q1'), assistantMsg('a1'), userMsg('q2'), assistantMsg('a2')];
    loadLoopSessionMock.mockReturnValue({ messages: forkedHistory, meta: null });

    // 在 q1 的 assistant 回答上分叉 → 截点在 q2 之前(keepCount=2)
    const asstId = wire.find((m) => m.role === 'assistant')!.id;
    const r = await forkPiChat(asstId);
    expect(r.success).toBe(true);
    expect(r.sessionId).toBe('fork-ls-1');
    expect(forkLoopSessionMock).toHaveBeenCalledWith(expect.any(String), 2);
    // 原会话历史未被截断
    expect(truncateLoopSessionMock).not.toHaveBeenCalled();
  });

  it('busy 中拒绝;消息不存在 → error', async () => {
    const release = gateFirstTurn();
    await sendPiChatMessage({ text: 'one' });
    expect((await forkPiChat('x')).error).toContain('进行中');
    release();
    await waitTurnSettled();
    expect((await forkPiChat('nope')).error).toBe('Message not found');
  });
});


describe('系统提示组装(buildSystemPromptAppend 接入)', () => {
  function lastSystemPrompt(): string {
    const calls = runLoopMock.mock.calls;
    return (calls[calls.length - 1][0] as { systemPrompt: string }).systemPrompt;
  }

  it('chat 会话恒 security:五段全进 prompt(含 research-log 教学),基座段在最前', async () => {
    collectResearchMock.mockReturnValue({
      successPaths: '### 域：ctf\nret2win 直接覆盖返回地址',
      failureRoots: '',
      toolCombos: '',
    });
    await sendPiChatMessage({ text: '开始' });
    await waitTurnSettled();
    const prompt = lastSystemPrompt();
    expect(prompt).toContain('你是安全研究助手');
    expect(prompt).toContain('<zhishi-identity>');
    expect(prompt).toContain('<zhishi-security-kernel>');
    expect(prompt).toContain('<zhishi-capabilities>');
    expect(prompt).toContain('<zhishi-native-code>');
    expect(prompt).toContain('<zhishi-research-log>');
    expect(prompt).toContain('zhishi research log');
    expect(prompt).toContain('<zhishi-research-memory>');
    expect(prompt.indexOf('你是安全研究助手')).toBeLessThan(prompt.indexOf('<zhishi-identity>'));
    // 能力清单按当前工作区采集;研究记忆已采集
    expect(collectCapsMock).toHaveBeenCalledWith('E:/ws');
    expect(collectResearchMock).toHaveBeenCalled();
  });

  it('锚定环境:基座段带 env id/kind/address', async () => {
    selectionMock.mockReturnValue({ kind: 'env', id: 'pwn-vm' });
    configEnvironments.mockReturnValue([VM_ENTRY]);
    await sendPiChatMessage({ text: 'hi' });
    await waitTurnSettled();
    const prompt = lastSystemPrompt();
    expect(prompt).toContain('id=pwn-vm');
    expect(prompt).toContain('kind=vm');
    expect(prompt).toContain('address=192.168.152.129');
  });

  it('蒸馏记忆:有内容进 prompt;undefined 零注入(无文件无段)', async () => {
    await sendPiChatMessage({ text: 'one' });
    await waitTurnSettled();
    expect(lastSystemPrompt()).not.toContain('<zhishi-distilled-memory>');

    distilledMock.mockReturnValue({ userModel: '夜猫子研究员', selfModel: '', routines: '', reminders: '' });
    await sendPiChatMessage({ text: 'two' });
    await waitTurnSettled();
    const prompt = lastSystemPrompt();
    expect(prompt).toContain('<zhishi-distilled-memory>');
    expect(prompt).toContain('夜猫子研究员');
  });

  it('组装异常:落回基座段,turn 正常完成', async () => {
    distilledMock.mockImplementation(() => { throw new Error('disk boom'); });
    await sendPiChatMessage({ text: 'hi' });
    await waitTurnSettled();
    const prompt = lastSystemPrompt();
    expect(prompt).toContain('你是安全研究助手');
    expect(prompt).not.toContain('<zhishi-identity>');
    expect(broadcastMock.mock.calls.some((c) => c[0] === 'chat:message-complete')).toBe(true);
  });
});

describe('chat:status broadcast(W1,TUI 状态行数据源)', () => {
  it('turn 开始 running → done idle(首尾各一次)', async () => {
    await sendPiChatMessage({ text: 'hi' });
    await waitTurnSettled();
    const statuses = broadcastMock.mock.calls
      .filter((c) => c[0] === 'chat:status')
      .map((c) => (c[1] as { sessionState: string }).sessionState);
    expect(statuses[0]).toBe('running');
    expect(statuses[statuses.length - 1]).toBe('idle');
  });

  it('stop 广播 idle;reset 广播 idle', async () => {
    const release = gateFirstTurn();
    await sendPiChatMessage({ text: 'one' });
    broadcastMock.mockClear();
    expect(stopPiChat()).toBe(true);
    expect(broadcastMock.mock.calls.some(
      (c) => c[0] === 'chat:status' && (c[1] as { sessionState: string }).sessionState === 'idle',
    )).toBe(true);
    release();
    await waitTurnSettled();
    broadcastMock.mockClear();
    resetPiChat();
    expect(broadcastMock.mock.calls.some(
      (c) => c[0] === 'chat:status' && (c[1] as { sessionState: string }).sessionState === 'idle',
    )).toBe(true);
  });
});

describe('steering(W1:/chat/send busy → steering 队列,不再 FIFO)', () => {
  it('busy → steering:true + chat:steering-added;getSteeringMessages 取走注入并清空', async () => {
    const release = gateFirstTurn();
    await sendPiChatMessage({ text: 'one' });
    const second = await sendPiChatMessage({ text: '改方向' });
    expect(second).toMatchObject({ queued: true, isInFlight: false, steering: true });
    const added = broadcastMock.mock.calls.find((c) => c[0] === 'chat:steering-added');
    expect(added).toBeDefined();
    expect((added![1] as { queueId: string }).queueId).toBe(second.queueId);
    expect(getPiQueueStatus()).toEqual([{ id: second.queueId, messagePreview: '改方向', kind: 'steering' }]);
    // 运行中 loop 的 getSteeringMessages:返回注入消息并清空队列
    const opts = runLoopMock.mock.calls[0][0] as { getSteeringMessages?: () => Promise<AgentMessage[]> };
    expect(typeof opts.getSteeringMessages).toBe('function');
    const injected = await opts.getSteeringMessages!();
    expect(injected).toHaveLength(1);
    expect(injected[0].role).toBe('user');
    expect((injected[0] as { content: unknown }).content).toBe('改方向');
    expect(getPiQueueStatus()).toEqual([]);
    expect(await opts.getSteeringMessages!()).toEqual([]);
    release();
    await waitTurnSettled();
  });

  it('stop:steering 队列与 FIFO 同清(逐条 chat:steering-cancelled)', async () => {
    const release = gateFirstTurn();
    await sendPiChatMessage({ text: 'one' });
    const s2 = await sendPiChatMessage({ text: 'steer-two' });
    expect(stopPiChat()).toBe(true);
    const cancelled = broadcastMock.mock.calls
      .filter((c) => c[0] === 'chat:steering-cancelled')
      .map((c) => (c[1] as { queueId: string }).queueId);
    expect(cancelled).toEqual([s2.queueId]);
    expect(getPiQueueStatus()).toEqual([]);
    release();
    await waitTurnSettled();
  });

  it('cancelPiQueueItem 命中 steering 项(广播 chat:steering-cancelled)', async () => {
    const release = gateFirstTurn();
    await sendPiChatMessage({ text: 'one' });
    const s2 = await sendPiChatMessage({ text: 'steer-two' });
    expect(cancelPiQueueItem(s2.queueId!)).toBe('steer-two');
    expect(broadcastMock.mock.calls.some(
      (c) => c[0] === 'chat:steering-cancelled' && (c[1] as { queueId: string }).queueId === s2.queueId,
    )).toBe(true);
    expect(getPiQueueStatus()).toEqual([]);
    release();
    await waitTurnSettled();
  });
});

describe('@ refs 注入(W1,grounding 前置进 prompt)', () => {
  it('refs → grounding 段前置;用户气泡保持原文', async () => {
    await sendPiChatMessage({ text: '分析它', refs: [{ type: 'file', path: '/work/exp.py' }] });
    await waitTurnSettled();
    expect(parseChatRefsMock).toHaveBeenCalled();
    expect(resolveChatRefsMock).toHaveBeenCalled();
    const opts = runLoopMock.mock.calls[0][0] as { prompt?: string };
    expect(opts.prompt).toBe('<context ref="file:/work/exp.py">EXP</context>\n\n分析它');
    const wire = getPiMessages().find((m) => m.role === 'user');
    expect(wire?.content).toBe('分析它');
  });

  it('无 refs → 不调解析,prompt 原文', async () => {
    await sendPiChatMessage({ text: 'plain' });
    await waitTurnSettled();
    expect(resolveChatRefsMock).not.toHaveBeenCalled();
    const opts = runLoopMock.mock.calls[0][0] as { prompt?: string };
    expect(opts.prompt).toBe('plain');
  });
});

describe('delegate_task 接回生产(W1)', () => {
  function anchorEnv() {
    selectionMock.mockReturnValue({ kind: 'env', id: 'pwn-vm' });
    configEnvironments.mockReturnValue([VM_ENTRY]);
  }

  it('锚定环境:tools + system-init 白名单含 delegate_task', async () => {
    anchorEnv();
    await sendPiChatMessage({ text: 'hi' });
    await waitTurnSettled();
    const opts = runLoopMock.mock.calls[0][0] as { tools: Array<{ name: string }> };
    expect(opts.tools.map((t) => t.name)).toContain('delegate_task');
    expect(getPiSystemInitInfo()?.tools).toContain('delegate_task');
  });

  it('host 选定:无 delegate_task(结构性边界)', async () => {
    await sendPiChatMessage({ text: 'hi' });
    await waitTurnSettled();
    const opts = runLoopMock.mock.calls[0][0] as { tools: Array<{ name: string }> };
    expect(opts.tools.map((t) => t.name)).not.toContain('delegate_task');
  });

  it('execute:广播 started/tool-use/tool-result/finished(摘要,同 taskId)', async () => {
    anchorEnv();
    await sendPiChatMessage({ text: 'hi' });
    await waitTurnSettled();
    const opts = runLoopMock.mock.calls[0][0] as {
      tools: Array<{ name: string; execute: (id: string, params: { task: string }) => Promise<{ details: { taskId: string } }> }>;
    };
    const delegate = opts.tools.find((t) => t.name === 'delegate_task')!;
    broadcastMock.mockClear();
    // 子 loop(runLoop 第二次调用):带工具事件 + 最终结论
    runLoopMock.mockImplementation(async function* () {
      yield { type: 'tool-call', toolCallId: 'tc1', toolName: 'env_exec', args: { command: 'hostname' } };
      yield {
        type: 'tool-result', toolCallId: 'tc1', toolName: 'env_exec',
        result: { content: [{ type: 'text', text: 'pwn-vm' }] }, isError: false,
      };
      for (const e of doneEvents('子任务最终结论')) yield e;
    });
    const result = await delegate.execute('call-1', { task: '查主机名' });
    const events = broadcastMock.mock.calls.map((c) => c[0]);
    expect(events).toEqual(expect.arrayContaining([
      'chat:subagent-started', 'chat:subagent-tool-use',
      'chat:subagent-tool-result-complete', 'chat:subagent-finished',
    ]));
    const started = broadcastMock.mock.calls.find((c) => c[0] === 'chat:subagent-started')![1] as {
      taskId: string; description: string;
    };
    expect(started.description).toBe('查主机名');
    const finished = broadcastMock.mock.calls.find((c) => c[0] === 'chat:subagent-finished')![1] as {
      taskId: string; summary: string; status: string;
    };
    expect(finished.taskId).toBe(started.taskId);
    expect(finished.summary).toBe('子任务最终结论');
    expect(finished.status).toBe('completed');
    const toolUse = broadcastMock.mock.calls.find((c) => c[0] === 'chat:subagent-tool-use')![1] as {
      subagentId: string; name: string;
    };
    expect(toolUse.subagentId).toBe(started.taskId);
    expect(toolUse.name).toBe('env_exec');
    expect(result.details.taskId).toBe(started.taskId);
  });

  it('finished 摘要截断 200 字(带省略号),不带过程', async () => {
    anchorEnv();
    await sendPiChatMessage({ text: 'hi' });
    await waitTurnSettled();
    const opts = runLoopMock.mock.calls[0][0] as {
      tools: Array<{ name: string; execute: (id: string, params: { task: string }) => Promise<unknown> }>;
    };
    const delegate = opts.tools.find((t) => t.name === 'delegate_task')!;
    broadcastMock.mockClear();
    const longText = 'x'.repeat(250);
    runLoopMock.mockImplementation(async function* () {
      for (const e of doneEvents(longText)) yield e;
    });
    await delegate.execute('call-1', { task: '长结论' });
    const finished = broadcastMock.mock.calls.find((c) => c[0] === 'chat:subagent-finished')![1] as {
      summary: string;
    };
    expect(finished.summary.length).toBe(201);
    expect(finished.summary.endsWith('…')).toBe(true);
  });
});
