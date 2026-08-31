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
  HOST_SELECTION: { kind: 'host' },
  loadSelectionStore: () => ({}),
  getWorkspaceSelection: (_store: unknown, dir: string) => selectionMock(dir),
  getWorkspaceSelectionRecord: (_store: unknown, dir: string) => ({ selection: selectionMock(dir), selectedAt: '' }),
}));

// 1.1.6 #4 — 分线映射 mock:内存 Map,行键 = `规范化ws::envKey`(规范化 = 去反斜杠)。
const envSessionsData = new Map<string, { loopSessionId: string; updatedAt: string }>();
const normWs = (ws: string) => ws.replace(/\\/g, '/');
vi.mock('../environment/env-sessions', () => ({
  envKeyForSelection: (sel: { kind: string; id?: string; instanceId?: string }) =>
    sel.kind === 'env' ? `env:${sel.id}` : sel.kind === 'recipe' ? `recipe:${sel.instanceId}` : 'host',
  normalizeWorkspaceKey: (ws: string) => normWs(ws),
  envSessionLineKey: (ws: string, key: string) => `${normWs(ws)}::${key}`,
  getEnvSessionLine: (_map: unknown, ws: string, key: string) => envSessionsData.get(`${normWs(ws)}::${key}`),
  loadEnvSessionsMap: () => ({}),
  setEnvSessionLine: async (ws: string, key: string, loopSessionId: string) => {
    envSessionsData.set(`${normWs(ws)}::${key}`, { loopSessionId, updatedAt: '' });
  },
  removeEnvSessionLine: async (ws: string, key: string) => {
    envSessionsData.delete(`${normWs(ws)}::${key}`);
  },
  removeEnvSessionsForEnvId: async () => {},
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

// A1(1.3.10):invoke 零广播回归——bg 回收走可注入 mock(bg-exec 的
// envBgReap + bg-registry 的内存登记表),不碰真盘/真 SSH;默认空登记表,
// 需要回收路径的测试再往里塞条目。
const envBgReapMock = vi.fn(async (..._args: unknown[]) => ({ ok: true, outcome: 'reaped' }));
vi.mock('./bg-exec', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./bg-exec')>();
  return { ...orig, envBgReap: (...args: unknown[]) => envBgReapMock(...args) };
});
const bgRegistryListMock = vi.fn(() => [] as { tag: string; pid: number; envId: string }[]);
vi.mock('./bg-registry', () => ({
  initBgRegistry: () => ({}),
  getBgRegistry: () => ({ list: () => bgRegistryListMock(), remove: () => {} }),
}));

// 1.2.7(§三)域接线断言:1.5.1 skills 注入层已删——改钉 domain 的现存消费点
// (buildSystemPromptAppend 的 securityResearchDomain 入参),spy 记录入参。
const systemPromptAppendSpy = vi.fn();
vi.mock('../system-prompt', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../system-prompt')>();
  return {
    ...orig,
    buildSystemPromptAppend: (
      scenario: Parameters<typeof orig.buildSystemPromptAppend>[0],
      opts?: Parameters<typeof orig.buildSystemPromptAppend>[1],
    ) => {
      systemPromptAppendSpy(opts);
      return orig.buildSystemPromptAppend(scenario, opts);
    },
  };
});

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

// A1-2(1.5.4)回归:档案锚 getAnchor 闭包按 turn 上下文取值——spy 捕获每次
// buildTurnStack 注入的取值闭包(工具本体仍走真实实现,只记录不执行)。
const archiveToolOptsSpy = vi.fn();
vi.mock('./tools', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./tools')>();
  return {
    ...orig,
    createArchiveTool: (opts: { getAnchor: () => { messageId?: string } }) => {
      archiveToolOptsSpy(opts);
      return orig.createArchiveTool(opts as Parameters<typeof orig.createArchiveTool>[0]);
    },
  };
});

// A2-2(1.5.4)回归:专家注入锚——spy 捕获 collectExpertInjection 入参
// (返回 undefined 零注入,不碰真实专家库)。
const collectExpertInjectionSpy = vi.fn();
vi.mock('./expert-inject', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./expert-inject')>();
  return {
    ...orig,
    collectExpertInjection: (args: { lastUserText: string }) => {
      collectExpertInjectionSpy(args);
      return undefined;
    },
  };
});

import {
  cancelPiQueueItem,
  chatSendErrorStatus,
  ensureMetaLoopLine,
  envSwitchBlocker,
  getPiAgentState,
  getPiCurrentSessionRef,
  getPiMessages,
  getPiQueueStatus,
  getPiSystemInitInfo,
  initPiChatEngine,
  injectPiDecision,
  invokePiSession,
  isPiEngine,
  PI_NO_PROVIDER_ERROR,
  resetPiChat,
  resolveLoopEngine,
  resolveSessionEnv,
  rewindPiChat,
  forkPiChat,
  sendPiChatMessage,
  stopPiChat,
  switchEnvSession,
  switchPiSession,
} from './chat-engine';
// A1:标题钩子槽(真实现,单测里手动装 spy——invoke 线必须不触发)。
import { setPostTurnTitleHook } from '../turn-hooks';
// A2-1(1.5.4)回归:用真实估算函数算校准期望值(与实现同一口径)。
import { estimateMessagesTokens } from './context-manager';
// B10(1.2.6)回归:配置面会话标识的真实读取口(chat-engine 不经 mock 写它)。
import { getSessionId } from '../agent-session';

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
  bgRegistryListMock.mockReturnValue([]);
  envSessionsData.clear();
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

describe('chatSendErrorStatus(/chat/send 错误分类,C2)', () => {
  it('配置缺失 → 400;其余保持 429 限流语义', () => {
    expect(chatSendErrorStatus(PI_NO_PROVIDER_ERROR)).toBe(400);
    expect(chatSendErrorStatus('Message must have text or images.')).toBe(429);
    expect(chatSendErrorStatus('等待 turn 完成超时(600000ms)')).toBe(429);
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

describe('会话跨重启(1.1.6 #4 env-aware:按当前环境分线映射续接)', () => {
  it('init 按映射续接当前环境的线:历史重建 + 后续 turn 续用同一 sessionId', async () => {
    getSessionsByAgentDirMock.mockReturnValue([
      { id: 'meta-old', loopSessionId: 'ls-77', lastActiveAt: '2026-08-16T01:00:00Z' },
    ]);
    loadLoopSessionMock.mockReturnValue({
      messages: [userMsg('旧问题'), assistantMsg('旧回答'), { role: 'toolResult', toolCallId: 't', toolName: 'env_exec', content: [], isError: false, timestamp: 3 } as unknown as AgentMessage],
      meta: { model: 'k3', createdAt: 'c', updatedAt: 'u' },
    });
    resetPiChat();
    // 当前选定 host(beforeEach 缺省)→ host 分线映射指向 ls-77
    envSessionsData.set('E:/ws::host', { loopSessionId: 'ls-77', updatedAt: '' });
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

  it('无映射 → 不接「全 workspace 最新 meta」(多半串到别的环境的线),开新线', async () => {
    getSessionsByAgentDirMock.mockReturnValue([
      { id: 'meta-old', loopSessionId: 'ls-77', lastActiveAt: '2026-08-16T01:00:00Z' },
    ]);
    loadLoopSessionMock.mockReturnValue({ messages: [userMsg('旧问题')], meta: null });
    resetPiChat();
    await initPiChatEngine('E:/ws');
    expect(getPiMessages()).toEqual([]);
  });

  it('映射失效(loop 文件为空/丢失)→ 开新线', async () => {
    loadLoopSessionMock.mockReturnValue({ messages: [], meta: null });
    resetPiChat();
    envSessionsData.set('E:/ws::host', { loopSessionId: 'ls-void', updatedAt: '' });
    await initPiChatEngine('E:/ws');
    expect(getPiMessages()).toEqual([]);
  });

  it('按当前选定环境接线:env 选定 → 读 env 键映射,不碰 host 线', async () => {
    selectionMock.mockReturnValue({ kind: 'env', id: 'pwn-vm' });
    configEnvironments.mockReturnValue([VM_ENTRY]);
    getSessionsByAgentDirMock.mockReturnValue([{ id: 'meta-env', loopSessionId: 'ls-env' }]);
    loadLoopSessionMock.mockReturnValue({ messages: [userMsg('环境里的旧问题')], meta: null });
    resetPiChat();
    envSessionsData.set('E:/ws::host', { loopSessionId: 'ls-host', updatedAt: '' });
    envSessionsData.set('E:/ws::env:pwn-vm', { loopSessionId: 'ls-env', updatedAt: '' });
    await initPiChatEngine('E:/ws');
    expect(getPiMessages().map((m) => m.content)).toEqual(['环境里的旧问题']);
  });
});

describe('环境分线切换(1.1.6 #4:switchEnvSession/envSwitchBlocker)', () => {
  it('busy 拒绝(rewind/fork 同口径);别的 workspace 不拦', async () => {
    expect(envSwitchBlocker('E:/ws')).toBeNull();
    expect(envSwitchBlocker('D:/other')).toBeNull();
    const release = gateFirstTurn();
    await sendPiChatMessage({ text: 'one' });
    expect(envSwitchBlocker('E:/ws')).toContain('进行中');
    expect(envSwitchBlocker('D:/other')).toBeNull(); // 别的 workspace 的选定与本引擎无关
    const r = await switchEnvSession('E:/ws', 'env:pwn-vm');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('进行中');
    release();
    await waitTurnSettled();
  });

  it('闲时切线:有映射 → 接线(回放重建 + 旧线回填不丢 + 续跑写目标线)', async () => {
    await sendPiChatMessage({ text: 'host 线消息' });
    await waitTurnSettled();
    const hostSessionId = appendLoopMessagesMock.mock.calls[0][0] as string;
    // host 线绑定建立后映射已写(ensureSessionBound → persistEnvSessionLine)
    expect(envSessionsData.get('E:/ws::host')?.loopSessionId).toBe(hostSessionId);

    envSessionsData.set('E:/ws::env:pwn-vm', { loopSessionId: 'ls-env', updatedAt: '' });
    getSessionsByAgentDirMock.mockReturnValue([{ id: 'meta-env', loopSessionId: 'ls-env' }]);
    loadLoopSessionMock.mockReturnValue({
      messages: [userMsg('环境里的旧问题'), assistantMsg('旧回答')],
      meta: null,
    });

    const r = await switchEnvSession('E:/ws', 'env:pwn-vm');
    expect(r.ok).toBe(true);
    const wire = getPiMessages();
    expect(wire.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(wire[0].content).toBe('环境里的旧问题');
    // 旧线(host)回填仍指向原 sessionId,不丢线
    expect(envSessionsData.get('E:/ws::host')?.loopSessionId).toBe(hostSessionId);
    // 续跑写目标线
    await sendPiChatMessage({ text: '继续' });
    await waitTurnSettled();
    expect(appendLoopMessagesMock.mock.calls[1][0]).toBe('ls-env');
  });

  it('闲时切线:无映射 → 开新线(清回放;首条消息绑定后才回填映射)', async () => {
    await sendPiChatMessage({ text: 'host 线消息' });
    await waitTurnSettled();
    const r = await switchEnvSession('E:/ws', 'env:fresh-vm');
    expect(r.ok).toBe(true);
    expect(getPiMessages()).toEqual([]);
    // 新线尚无 SessionStore 绑定:不写映射,防映射指向不存在的线
    expect(envSessionsData.has('E:/ws::env:fresh-vm')).toBe(false);
    await sendPiChatMessage({ text: '新线首条' });
    await waitTurnSettled();
    const newSessionId = appendLoopMessagesMock.mock.calls[1][0] as string;
    expect(envSessionsData.get('E:/ws::env:fresh-vm')?.loopSessionId).toBe(newSessionId);
  });

  it('重选同一环境且线已就位:幂等,不重建回放', async () => {
    await sendPiChatMessage({ text: 'one' });
    await waitTurnSettled();
    loadLoopSessionMock.mockClear();
    const r = await switchEnvSession('E:/ws', 'host');
    expect(r.ok).toBe(true);
    expect(loadLoopSessionMock).not.toHaveBeenCalled();
  });

  it('别的 workspace 的切线请求:no-op(不动映射不动回放)', async () => {
    const r = await switchEnvSession('D:/other', 'env:x');
    expect(r.ok).toBe(true);
    expect(envSessionsData.size).toBe(0);
  });

  it('reset 清当前环境键的分线映射(防 reset 后旧历史按映射复活)', async () => {
    await sendPiChatMessage({ text: 'one' });
    await waitTurnSettled();
    expect(envSessionsData.has('E:/ws::host')).toBe(true);
    resetPiChat();
    expect(envSessionsData.has('E:/ws::host')).toBe(false);
  });

  it('switchPiSession 已在当前会话:幂等(不重读历史,不碰 busy)', async () => {
    await sendPiChatMessage({ text: 'one' });
    await waitTurnSettled();
    // 绑定 meta = createSessionMock 的 'meta-new'
    loadLoopSessionMock.mockClear();
    getSessionMetadataMock.mockClear();
    expect(await switchPiSession('meta-new')).toBe(true);
    expect(getSessionMetadataMock).not.toHaveBeenCalled();
    expect(loadLoopSessionMock).not.toHaveBeenCalled();
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

describe('chat:status broadcast(W1,GUI 状态行数据源)', () => {
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

  it('1.1.10(A′):finished 广播带 loopSessionId(= 子 loop details.sessionId)', async () => {
    anchorEnv();
    await sendPiChatMessage({ text: 'hi' });
    await waitTurnSettled();
    const opts = runLoopMock.mock.calls[0][0] as {
      tools: Array<{ name: string; execute: (id: string, params: { task: string }) => Promise<{ details: { sessionId: string } }> }>;
    };
    const delegate = opts.tools.find((t) => t.name === 'delegate_task')!;
    broadcastMock.mockClear();
    runLoopMock.mockImplementation(async function* () {
      for (const e of doneEvents('结论')) yield e;
    });
    const result = await delegate.execute('call-1', { task: '留档' });
    const finished = broadcastMock.mock.calls.find((c) => c[0] === 'chat:subagent-finished')![1] as {
      loopSessionId?: string;
    };
    expect(finished.loopSessionId).toBe(result.details.sessionId);
    // 子 loop 持久化到 loop-sessions 默认目录(与主会话同目录)。
    const persisted = appendLoopMessagesMock.mock.calls.find(
      (c) => c[0] === result.details.sessionId,
    );
    expect(persisted).toBeDefined();
    expect((persisted![3] as { dir: string }).dir).toContain('loop-sessions');
  });
});


describe('1.2.6 批次A 回归(B1 cron new_session / B3 串线 / B10 配置面会话标识)', () => {
  it('B1:switchPiSession 接受无 loopSessionId 绑定的 meta——当场开新线并绑定,不再 false/500', async () => {
    // cron new_session:createSession 落盘的 meta 没有 loopSessionId(唯一
    // 写入点原是 ensureSessionBound,而它以引擎已在线上是前提——死锁)。
    getSessionMetadataMock.mockReturnValue({ id: 'meta-cron' });
    const ok = await switchPiSession('meta-cron');
    expect(ok).toBe(true);
    // 新线 id 当场写进 meta.loopSessionId 绑定
    const bindCall = updateSessionMetadataMock.mock.calls.find(
      (c) => c[0] === 'meta-cron' && typeof (c[1] as { loopSessionId?: unknown }).loopSessionId === 'string',
    );
    expect(bindCall).toBeDefined();
    const newLine = (bindCall![1] as { loopSessionId: string }).loopSessionId;
    // B10 联动:配置面会话标识同步到目标 meta
    expect(getSessionId()).toBe('meta-cron');
    // 续跑:引擎已在新线上且绑定已就位——ensureSessionBound 不重复建 meta,
    // turn 收尾写进新开的线
    await sendPiChatMessage({ text: 'cron 任务内容' });
    await waitTurnSettled();
    expect(createSessionMock).not.toHaveBeenCalled();
    expect(appendLoopMessagesMock.mock.calls[0][0]).toBe(newLine);
  });

  it('B1:meta 不存在 → 仍返回 false(只有「无绑定」才愈合,「无会话」不捏造)', async () => {
    getSessionMetadataMock.mockReturnValue(null);
    expect(await switchPiSession('ghost')).toBe(false);
  });

  it('B3:busy 强停换线后,被中止 turn 的收尾写入起跑快照线,不串进新线', async () => {
    const release = gateFirstTurn();
    await sendPiChatMessage({ text: 'one' });
    const originLine = getPiSystemInitInfo()?.session_id;
    expect(originLine).toBeTruthy();
    // switchPiSession busy 强停:不等待旧 turn 收尾即换线(abort 后 loop
    // 解开窗口里到达的 done.messages 属于起跑时那条线)。
    getSessionMetadataMock.mockReturnValue({ id: 'meta-other', loopSessionId: 'ls-other' });
    loadLoopSessionMock.mockReturnValue({ messages: [userMsg('别的线的历史')], meta: null });
    expect(await switchPiSession('meta-other')).toBe(true);
    release();
    await waitTurnSettled();
    const appendedTo = appendLoopMessagesMock.mock.calls.map((c) => c[0]);
    // 旧 turn 尾部落到起跑线;新线 ls-other 零写入(串线则此断言红)
    expect(appendedTo).toContain(originLine);
    expect(appendedTo).not.toContain('ls-other');
  });

  it('B10:首条消息绑定 → getSessionId() = 新 meta id(不再恒为 initializeAgent 的随机 UUID)', async () => {
    await sendPiChatMessage({ text: 'hi' });
    await waitTurnSettled();
    expect(getSessionId()).toBe('meta-new');
  });

  it('B10:switchPiSession → getSessionId() = 目标 meta;reset → 离开旧 meta(新随机值)', async () => {
    getSessionMetadataMock.mockReturnValue({ id: 'meta-x', loopSessionId: 'ls-x' });
    loadLoopSessionMock.mockReturnValue({ messages: [userMsg('h')], meta: null });
    expect(await switchPiSession('meta-x')).toBe(true);
    expect(getSessionId()).toBe('meta-x');
    resetPiChat();
    expect(getSessionId()).not.toBe('meta-x');
  });

  it('B10:switchEnvSession——接绑定线 → 绑定 meta id;开新线 → 不再是旧 meta', async () => {
    await sendPiChatMessage({ text: 'one' });
    await waitTurnSettled();
    expect(getSessionId()).toBe('meta-new');
    // 无映射 → 开新线:配置面标识离开旧 meta(僵尸值修复)
    expect((await switchEnvSession('E:/ws', 'env:fresh-vm')).ok).toBe(true);
    expect(getSessionId()).not.toBe('meta-new');
    // 有映射且线有绑定 → 配置面标识 = 绑定的 meta
    envSessionsData.set('E:/ws::env:pwn-vm', { loopSessionId: 'ls-env', updatedAt: '' });
    getSessionsByAgentDirMock.mockReturnValue([{ id: 'meta-env', loopSessionId: 'ls-env' }]);
    loadLoopSessionMock.mockReturnValue({ messages: [userMsg('环境里的旧问题')], meta: null });
    expect((await switchEnvSession('E:/ws', 'env:pwn-vm')).ok).toBe(true);
    expect(getSessionId()).toBe('meta-env');
  });

  it('B10:启动按分线映射恢复出绑定 → getSessionId() = 恢复的 meta', async () => {
    getSessionsByAgentDirMock.mockReturnValue([{ id: 'meta-old', loopSessionId: 'ls-77' }]);
    loadLoopSessionMock.mockReturnValue({ messages: [userMsg('旧问题')], meta: null });
    resetPiChat();
    envSessionsData.set('E:/ws::host', { loopSessionId: 'ls-77', updatedAt: '' });
    await initPiChatEngine('E:/ws');
    expect(getSessionId()).toBe('meta-old');
  });
});


describe('1.2.6 批次B 回归(B2 cron invoke 通道 / B4 force 单起点 / B5 steering 孤儿+归属 / B6 wire 补写)', () => {
  describe('B2:invokePiSession 独立 invoke 通道(不碰引擎单例)', () => {
    it('引擎 busy 时 invoke 并发跑:不进 steering、不改 wire、只写目标线、cron 场景显式生效', async () => {
      const release = gateFirstTurn();
      await sendPiChatMessage({ text: 'one' });
      const wireBefore = getPiMessages().length;
      const engineLine = getPiSystemInitInfo()?.session_id;
      expect(engineLine).toBeTruthy();
      // 引擎 turn 仍挂着(gate 未释放)时并发 invoke——旧路径这里会把
      // cron prompt 当 steering 注入用户 turn(B2a)。
      const r = await invokePiSession(
        { text: 'cron 任务', providerEnv: { apiKey: 'k' } },
        { loopSessionId: 'ls-cron', scenario: { type: 'cron', taskId: 't1', intervalMinutes: 15, aiCanExit: true } },
      );
      expect(r.error).toBeUndefined();
      expect(r.text).toBe('done-text'); // gateFirstTurn:非首次调用即时完成
      expect(r.loopSessionId).toBe('ls-cron');
      // 单例零扰动:wire 不变、引擎仍 busy(它的 turn 还挂着)、无 steering 事件
      expect(getPiMessages().length).toBe(wireBefore);
      expect(getPiAgentState().sessionState).toBe('running');
      expect(broadcastMock.mock.calls.some((c) => c[0] === 'chat:steering-added')).toBe(false);
      // 续存只写目标线,引擎线零写入
      expect(appendLoopMessagesMock.mock.calls.map((c) => c[0])).toEqual(['ls-cron']);
      // cron 场景显式传入(不吃全局 scenario 时序):系统提示含 cron 段 + 自退标记
      const invokeOpts = runLoopMock.mock.calls[1][0] as { systemPrompt: string; prompt?: string };
      expect(invokeOpts.systemPrompt).toContain('zhishi-cron-task-instructions');
      expect(invokeOpts.systemPrompt).toContain('Task ID: t1');
      expect(invokeOpts.systemPrompt).toContain('[CRON_TASK_COMPLETE');
      expect(invokeOpts.prompt).toBe('cron 任务');
      release();
      await waitTurnSettled();
      // 引擎线/会话标识未被 invoke 改写
      expect(getPiSystemInitInfo()?.session_id).toBe(engineLine);
    });

    it('无 loopSessionId → 一次性新线;目标线历史作为 history 进 loop', async () => {
      loadLoopSessionMock.mockReturnValue({ messages: [userMsg('旧上下文')], meta: null });
      const r = await invokePiSession({ text: 'cron' });
      expect(r.error).toBeUndefined();
      expect(r.loopSessionId).toBeTruthy();
      const opts = runLoopMock.mock.calls[0][0] as { history?: unknown[] };
      expect(opts.history).toHaveLength(1);
      // 续存写回同一条(新)线
      expect(appendLoopMessagesMock.mock.calls[0][0]).toBe(r.loopSessionId);
    });

    it('模型解析失败 → error 且带 loopSessionId,不跑 loop', async () => {
      resolveLoopModelFromEnvMock.mockReturnValue(null);
      const r = await invokePiSession({ text: 'x', providerEnv: { apiKey: 'k' } }, { loopSessionId: 'ls-c' });
      expect(r.error).toContain('无可用的 provider/model');
      expect(r.loopSessionId).toBe('ls-c');
      expect(runLoopMock).not.toHaveBeenCalled();
    });

    it('ensureMetaLoopLine:有绑定 → 原线;无绑定 → 开新线并回写 meta;无 meta → null', async () => {
      getSessionMetadataMock.mockReturnValue({ id: 'm1', loopSessionId: 'ls-bound' });
      expect(await ensureMetaLoopLine('m1')).toBe('ls-bound');
      expect(updateSessionMetadataMock).not.toHaveBeenCalled();
      getSessionMetadataMock.mockReturnValue({ id: 'm2' });
      const healed = await ensureMetaLoopLine('m2');
      expect(healed).toBeTruthy();
      const bindCall = updateSessionMetadataMock.mock.calls.find(
        (c) => c[0] === 'm2' && (c[1] as { loopSessionId?: unknown }).loopSessionId === healed,
      );
      expect(bindCall).toBeDefined();
      getSessionMetadataMock.mockReturnValue(null);
      expect(await ensureMetaLoopLine('ghost')).toBeNull();
    });

    it('getPiCurrentSessionRef:当前线 + 绑定 meta 的只读快照', async () => {
      await sendPiChatMessage({ text: 'one' });
      await waitTurnSettled();
      const ref = getPiCurrentSessionRef();
      expect(ref.sessionMetaId).toBe('meta-new');
      expect(appendLoopMessagesMock.mock.calls[0][0]).toBe(ref.loopSessionId);
    });

    it('invoke 通道零广播:标题钩子跳过、bg 回收静默(A1 回归)', async () => {
      // 契约:headless 不广播——firePostTurnTitleHook(generateAndApplyTitle
      // 尾段 broadcast chat:session-title-changed)对 invoke 线跳过;
      // reapBgOnLifecyclePoint(broadcast:false)照常杀进程/清登记,但不广播
      // chat:bg-finished。
      const titleSpy = vi.fn();
      setPostTurnTitleHook(titleSpy);
      try {
        configEnvironments.mockReturnValue([VM_ENTRY]);
        bgRegistryListMock.mockReturnValue([{ tag: 'bg-1', pid: 42, envId: 'pwn-vm' }]);
        broadcastMock.mockClear();
        const r = await invokePiSession(
          { text: 'cron 任务', providerEnv: { apiKey: 'k' } },
          { loopSessionId: 'ls-silent' },
        );
        expect(r.error).toBeUndefined();
        expect(r.loopSessionId).toBe('ls-silent');
        // 标题钩子零触发。
        expect(titleSpy).not.toHaveBeenCalled();
        // bg 回收照做(杀 + 清登记)——等 fire-and-forget 回收链走完。
        await vi.waitFor(() => {
          expect(envBgReapMock).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'pwn-vm' }), 'bg-1', 42,
          );
        });
        await new Promise((res) => setTimeout(res, 0));
        // 全程零广播(含 bg-finished / session-title-changed)。
        expect(broadcastMock).not.toHaveBeenCalled();
      } finally {
        setPostTurnTitleHook(() => {});
      }
    });
  });

  describe('B5:steering 孤儿 drain', () => {
    it('turn done 时残留 steering 转 FIFO 队首续跑(不被注入别人的 turn)', async () => {
      let call = 0;
      let releaseFirst!: () => void;
      const gate = new Promise<void>((r) => { releaseFirst = r; });
      // 第一 turn 挂起且从不轮询 steering(模拟「最后一跳 LLM 期间到达」——
      // pi 收尾走 getFollowUpMessages,本引擎没传,steering 永远等不到注入点)。
      runLoopMock.mockImplementation(async function* (opts: { prompt?: string }) {
        call++;
        if (call === 1) await gate;
        for (const e of doneEvents(`answer-of-${opts.prompt}`)) yield e;
      });
      await sendPiChatMessage({ text: 'one' });
      const steer = await sendPiChatMessage({ text: '迟到的纠偏' });
      expect(steer.steering).toBe(true);
      releaseFirst();
      await waitTurnSettled();
      // 孤儿被 drain 到队首,作为独立 turn 开跑(prompt 原样,不混进 turn1)
      expect(runLoopMock).toHaveBeenCalledTimes(2);
      expect((runLoopMock.mock.calls[1][0] as { prompt?: string }).prompt).toBe('迟到的纠偏');
      // 离开 steering 队列有广播;队列排空
      expect(broadcastMock.mock.calls.some(
        (c) => c[0] === 'chat:steering-cancelled' && (c[1] as { queueId?: string }).queueId === steer.queueId,
      )).toBe(true);
      expect(getPiQueueStatus()).toEqual([]);
    });

  });

  describe('B6:steering 注入补 wire + replay(rewind/fork 序数 1:1)', () => {
    /** mock:turn 中等 steering 就位后注入,done.messages 含注入消息(pi 真实行为)。 */
    function steeringTurnMock() {
      runLoopMock.mockImplementation(async function* (opts: { getSteeringMessages?: () => Promise<AgentMessage[]> }) {
        await vi.waitFor(() => {
          expect(getPiQueueStatus().some((q) => q.kind === 'steering')).toBe(true);
        }, { timeout: 3000, interval: 10 });
        const injected = (await opts.getSteeringMessages!()) ?? [];
        yield { type: 'text-delta', delta: '答' };
        yield { type: 'done', messages: [userMsg('one'), ...(injected as AgentMessage[]), assistantMsg('答')] };
      });
    }

    it('注入的 steering 消息同步进 wire + replay 广播 + 清 steering 队列条目', async () => {
      steeringTurnMock();
      await sendPiChatMessage({ text: 'one' });
      const steer = await sendPiChatMessage({ text: '改方向' });
      await waitTurnSettled();
      // wire 与持久化 1:1:两条 user 同序
      const users = getPiMessages().filter((m) => m.role === 'user');
      expect(users.map((m) => m.content)).toEqual(['one', '改方向']);
      const replays = broadcastMock.mock.calls
        .filter((c) => c[0] === 'chat:message-replay')
        .map((c) => (c[1] as { message: { content: string } }).message.content);
      expect(replays).toContain('改方向');
      expect(broadcastMock.mock.calls.some(
        (c) => c[0] === 'chat:steering-cancelled' && (c[1] as { queueId?: string }).queueId === steer.queueId,
      )).toBe(true);
      // 持久化(done.messages)含注入消息,顺序一致——重启回放不再冒幽灵消息
      const appended = appendLoopMessagesMock.mock.calls[0][1] as AgentMessage[];
      expect(appended.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['one', '改方向']);
      expect(getPiQueueStatus()).toEqual([]);
    });

    it('rewind 序数映射在 steering 注入后仍准确(截到注入消息之前)', async () => {
      steeringTurnMock();
      await sendPiChatMessage({ text: 'one' });
      await sendPiChatMessage({ text: '改方向' });
      await waitTurnSettled();
      const wireUsers = getPiMessages().filter((m) => m.role === 'user');
      expect(wireUsers).toHaveLength(2);
      // loop 历史:one(0) → 改方向(1) → assistant(2)
      const loopHistory = [userMsg('one'), userMsg('改方向'), assistantMsg('答')];
      loadLoopSessionMock.mockReturnValueOnce({ messages: loopHistory, meta: null }) // rewind 读
        .mockReturnValue({ messages: loopHistory.slice(0, 1), meta: null }); // 截断后重建读
      const r = await rewindPiChat(wireUsers[1].id);
      expect(r.success).toBe(true);
      // wire 第 2 条 user(ordinal=1)→ 截到 loop 下标 1(注入消息本身被裁掉);
      // 旧实现 wire 无注入消息,序数映射错位(截点偏后、裁少了)。
      expect(truncateLoopSessionMock).toHaveBeenCalledWith(expect.any(String), 1);
      expect(getPiMessages().filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['one']);
    });
  });
});

describe('1.2.7 溢出兜底(§四:isContextOverflow → 强制压缩重试,限 1 次)', () => {
  /** stopReason=error + provider 溢出文案(命中 pi OVERFLOW_PATTERNS)。 */
  function overflowAssistant(errorMessage: string): AgentMessage {
    return {
      role: 'assistant', content: [], model: 'k3',
      usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: {} },
      stopReason: 'error', errorMessage, timestamp: 2,
    } as unknown as AgentMessage;
  }
  /** 首次溢出、其后正常完成的 runLoop mock。 */
  function overflowThen(text: string) {
    let call = 0;
    runLoopMock.mockImplementation(async function* () {
      call++;
      if (call === 1) {
        yield { type: 'error', error: 'prompt is too long' };
        yield { type: 'done', messages: [userMsg('q'), overflowAssistant('prompt is too long')] };
      } else {
        for (const e of doneEvents(text)) yield e;
      }
    });
  }

  it('溢出 → 压缩重试成功:runLoop 2 次;首 attempt 的错误条与 complete 不上屏;只续存成功 attempt', async () => {
    overflowThen('recovered');
    await sendPiChatMessage({ text: 'q' });
    await waitTurnSettled();
    expect(runLoopMock).toHaveBeenCalledTimes(2);
    expect(broadcastMock.mock.calls.some((c) => c[0] === 'chat:message-error')).toBe(false);
    expect(broadcastMock.mock.calls.filter((c) => c[0] === 'chat:message-complete')).toHaveLength(1);
    const appended = appendLoopMessagesMock.mock.calls.map((c) => c[1] as AgentMessage[]);
    expect(appended).toHaveLength(1);
    expect(appended[0].some((m) => (m as { stopReason?: string }).stopReason === 'error')).toBe(false);
    // 终态文本来自重试 attempt
    expect(getPiMessages().find((m) => m.role === 'assistant')?.content).toBe('recovered');
  });

  it('重试仍溢出 → 不再重试(runLoop 恰 2 次),错误条补播且保序在 complete 前', async () => {
    runLoopMock.mockImplementation(async function* () {
      yield { type: 'error', error: 'prompt is too long' };
      yield { type: 'done', messages: [userMsg('q'), overflowAssistant('prompt is too long')] };
    });
    await sendPiChatMessage({ text: 'q' });
    await waitTurnSettled();
    expect(runLoopMock).toHaveBeenCalledTimes(2);
    const events = broadcastMock.mock.calls.map((c) => c[0] as string);
    const errIdx = events.indexOf('chat:message-error');
    const doneIdx = events.indexOf('chat:message-complete');
    expect(errIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(errIdx);
  });

  it('非溢出错误(rate limit,命中 NON_OVERFLOW)不重试:runLoop 1 次,错误条照播', async () => {
    runLoopMock.mockImplementation(async function* () {
      yield { type: 'error', error: '429 rate limit exceeded' };
      yield {
        type: 'done',
        messages: [userMsg('q'), overflowAssistant('429 rate limit exceeded')],
      };
    });
    await sendPiChatMessage({ text: 'q' });
    await waitTurnSettled();
    expect(runLoopMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock.mock.calls.some((c) => c[0] === 'chat:message-error')).toBe(true);
  });

  it('invokePiSession(headless/cron 通道)溢出同样重试一次并返回重试结果', async () => {
    overflowThen('cron-answer');
    const r = await invokePiSession({ text: 'cron-q' });
    expect(runLoopMock).toHaveBeenCalledTimes(2);
    expect(r.text).toBe('cron-answer');
    expect(r.error).toBeUndefined();
  });
});

describe('1.2.7 域边界接线(§三:配方默认 + 内容信号动态修正 → 提示词域入参)', () => {
  it('锚定 pwn-vm(配方默认)→ binary 域,buildSystemPromptAppend 按域注入', async () => {
    await sendPiChatMessage({ text: 'q' });
    await waitTurnSettled();
    expect(systemPromptAppendSpy).toHaveBeenCalled();
    const arg = systemPromptAppendSpy.mock.calls.at(-1)![0] as { securityResearchDomain?: string };
    expect(arg.securityResearchDomain).toBe('binary');
  });

  it('内容信号强改判:binary 基线 + pentest 内容信号 ≥3 → pentest 域', async () => {
    // pentest 内容信号:nmap/sqlmap/webshell/拿 shell 共 4 命中(1.4.3 起
    // 「session N opened」是产物指纹 auxSignals,不参与裁决);binary 基线
    // 无命中 → 4 ≥ 3 且 ≥2×0 → 改判。
    loadLoopSessionMock.mockReturnValue({
      messages: [
        userMsg('q1'),
        assistantMsg('nmap 扫描目标\nsqlmap 注入探测\nwebshell 拿 shell'),
      ],
      meta: null,
    });
    await sendPiChatMessage({ text: 'q' });
    await waitTurnSettled();
    const arg = systemPromptAppendSpy.mock.calls.at(-1)![0] as { securityResearchDomain?: string };
    expect(arg.securityResearchDomain).toBe('pentest');
  });

  it('host 现场无基线且无信号 → undefined(全量注入,宁多勿缺)', async () => {
    selectionMock.mockReturnValue({ kind: 'host' });
    collectCapsMock.mockResolvedValue({
      engines: { engines: [] }, recipes: [], environments: [], selection: { kind: 'host' },
    });
    await sendPiChatMessage({ text: 'q' });
    await waitTurnSettled();
    const arg = systemPromptAppendSpy.mock.calls.at(-1)![0] as { securityResearchDomain?: string };
    expect(arg.securityResearchDomain).toBeUndefined();
  });
});

describe('1.2.7 域补丁:子代理继承会话域(delegate_task 按域收窄)', () => {
  function anchorEnv() {
    selectionMock.mockReturnValue({ kind: 'env', id: 'pwn-vm' });
    configEnvironments.mockReturnValue([VM_ENTRY]);
  }
  type DelegateTool = {
    name: string;
    execute: (id: string, params: { task: string; agent?: string }) => Promise<unknown>;
  };
  async function delegateTool(): Promise<DelegateTool> {
    await sendPiChatMessage({ text: 'hi' });
    await waitTurnSettled();
    const opts = runLoopMock.mock.calls[0][0] as { tools: DelegateTool[] };
    return opts.tools.find((t) => t.name === 'delegate_task')!;
  }

  it('binary 域(配方默认 pwn-vm):清单内子代理可派发', async () => {
    anchorEnv();
    const delegate = await delegateTool();
    // critic 在 binary 域清单内——通过校验进 spawn(runLoop mock 直接 done)。
    await expect(delegate.execute('tc', { task: 't', agent: 'critic' })).resolves.toBeDefined();
  });

  it('whitebox 域(配方 code-audit):binary 独有子代理被拒,错误列出可用清单', async () => {
    anchorEnv();
    collectCapsMock.mockResolvedValue({
      engines: { engines: [] }, recipes: [], environments: [],
      selection: { kind: 'recipe', name: 'code-audit', instanceId: 'ca-1' },
    });
    const delegate = await delegateTool();
    await expect(delegate.execute('tc', { task: 't', agent: 'fuzz-runner' }))
      .rejects.toThrow(/未知子代理 "fuzz-runner"\(可用:critic\/hypothesis-tester\/vuln-hunter\)/);
    // whitebox 清单内(vuln-hunter/hypothesis-tester/critic)仍可派发
    await expect(delegate.execute('tc2', { task: 't', agent: 'critic' })).resolves.toBeDefined();
  });
});

// ===== 1.3.2 决策面板：注入/决策块 wire/additive =====

describe('1.3.2 决策注入(injectPiDecision:同线直发/steering、跨线 invoke)', () => {
  const DEC = {
    decisionId: 'dec-1',
    sessionId: 'ls-dec', // beforeEach 后当前线是 ls-1——测试内按需改同线
    question: '继续 fuzz 还是转手动审计?',
    choice: '转手动审计 crash-03',
    note: '12h 内出结论',
    expertRefs: ['E#3'],
  };

  it('同线闲时:直发 turn——wire 决策块(additive 字段)+ prompt 带 decision marker', async () => {
    const current = getPiCurrentSessionRef().loopSessionId;
    const r = await injectPiDecision({ ...DEC, sessionId: current });
    expect(r.success).toBe(true);
    await waitTurnSettled();
    // wire 决策块:user 消息带 kind:'decision' + 决策字段
    const wire = getPiMessages().find((m) => m.role === 'user') as unknown as Record<string, unknown>;
    expect(wire.kind).toBe('decision');
    expect(wire.decisionId).toBe('dec-1');
    expect(wire.choice).toBe('转手动审计 crash-03');
    expect(wire.note).toBe('12h 内出结论');
    expect(wire.expertRefs).toEqual(['E#3']);
    expect((wire.content as string)).toContain('【人的决定】');
    // loop prompt 带 marker(随 done.messages 持久化 → 重放可还原)
    const opts = runLoopMock.mock.calls[0][0] as { messages?: Array<Record<string, unknown>> };
    expect(opts.messages).toHaveLength(1);
    expect(opts.messages![0].decision).toEqual({
      decisionId: 'dec-1',
      choice: '转手动审计 crash-03',
      note: '12h 内出结论',
      expertRefs: ['E#3'],
    });
    // live echo 广播带决策块
    const replay = broadcastMock.mock.calls.find((c) => c[0] === 'chat:message-replay');
    expect((replay![1] as { message: Record<string, unknown> }).message.kind).toBe('decision');
  });

  it('同线 busy:进 steering——注入消息带 decision marker + wire 补写', async () => {
    const release = gateFirstTurn();
    await sendPiChatMessage({ text: 'one' });
    const current = getPiCurrentSessionRef().loopSessionId;
    broadcastMock.mockClear();
    const r = await injectPiDecision({ ...DEC, sessionId: current, note: undefined });
    expect(r.success).toBe(true);
    // busy → steering 队列(chat:steering-added),不直发
    const steeringItem = getPiQueueStatus().find((i) => i.kind === 'steering');
    expect(steeringItem?.messagePreview).toContain('【人的决定】');
    // 运行中 loop 的 getSteeringMessages:注入消息带 decision marker
    const opts = runLoopMock.mock.calls[0][0] as { getSteeringMessages?: () => Promise<AgentMessage[]> };
    const injected = await opts.getSteeringMessages!();
    expect(injected).toHaveLength(1);
    expect((injected[0] as { decision?: unknown }).decision).toMatchObject({ decisionId: 'dec-1', choice: '转手动审计 crash-03' });
    // 补 wire + replay 广播(决策块字段同直发路径)
    const replay = broadcastMock.mock.calls.find((c) => c[0] === 'chat:message-replay');
    expect((replay![1] as { message: Record<string, unknown> }).message.kind).toBe('decision');
    release();
    await waitTurnSettled();
  });

  it('跨线:走 invoke 通道注入目标线(headless,不动引擎 wire、不串线)', async () => {
    const r = await injectPiDecision({ ...DEC, sessionId: 'ls-other' });
    expect(r.success).toBe(true);
    // runLoop 以 messages 形态带 marker 跑;续存写目标线 'ls-other'(不串线)
    const opts = runLoopMock.mock.calls[0][0] as { messages?: Array<Record<string, unknown>>; prompt?: string };
    expect(opts.messages).toHaveLength(1);
    expect(opts.messages![0].decision).toMatchObject({ decisionId: 'dec-1', choice: '转手动审计 crash-03' });
    expect(appendLoopMessagesMock.mock.calls[0][0]).toBe('ls-other');
    // headless:引擎 wire 没有决策块(不污染单例回放)
    expect(getPiMessages().some((m) => (m as unknown as Record<string, unknown>).kind === 'decision')).toBe(false);
  });
});

describe('1.3.2 决策块重放还原(loopMessagesToWire)', () => {
  it('loop jsonl 的 decision marker → wire kind:decision 决策块(additive)', async () => {
    getSessionsByAgentDirMock.mockReturnValue([
      { id: 'meta-dec', loopSessionId: 'ls-dec', lastActiveAt: '2026-08-16T01:00:00Z' },
    ]);
    loadLoopSessionMock.mockReturnValue({
      messages: [
        {
          role: 'user',
          content: '【人的决定】\n问题: 继续 fuzz?\n选择: 转手动',
          timestamp: 1,
          decision: { decisionId: 'dec-9', choice: '转手动', note: '备注 x', expertRefs: ['E#1', 'E#2'] },
        } as unknown as AgentMessage,
        assistantMsg('收到'),
      ],
      meta: null,
    });
    resetPiChat();
    envSessionsData.set('E:/ws::host', { loopSessionId: 'ls-dec', updatedAt: '' });
    await initPiChatEngine('E:/ws');
    const wire = getPiMessages();
    const dec = wire[0] as unknown as Record<string, unknown>;
    expect(dec.role).toBe('user');
    expect(dec.kind).toBe('decision');
    expect(dec.decisionId).toBe('dec-9');
    expect(dec.choice).toBe('转手动');
    expect(dec.note).toBe('备注 x');
    expect(dec.expertRefs).toEqual(['E#1', 'E#2']);
    // 无 marker 的普通 user 消息形状不变(不破坏现有字段)
    const normal = wire[1] as unknown as Record<string, unknown>;
    expect(normal.role).toBe('assistant');
    expect(normal.kind).toBeUndefined();
  });
});

describe('1.3.2 环境锚进 chat:init(getPiAgentState.environment)', () => {
  it('host 选定(未锚定)→ environment=null', () => {
    selectionMock.mockReturnValue({ kind: 'host' });
    expect(getPiAgentState().environment).toBeNull();
  });

  it('env 选定 → {kind:env, id, name, type=环境类型}', () => {
    selectionMock.mockReturnValue({ kind: 'env', id: 'pwn-vm' });
    configEnvironments.mockReturnValue([VM_ENTRY]);
    expect(getPiAgentState().environment).toEqual({
      kind: 'env', id: 'pwn-vm', name: 'pwn-vm', type: 'vm',
    });
  });

  it('recipe 选定 → {kind:recipe, id=实例, name=实例, type=配方 id}', () => {
    selectionMock.mockReturnValue({ kind: 'recipe', name: 'pwn', instanceId: 'zhishi-pwn-a3f2' });
    expect(getPiAgentState().environment).toEqual({
      kind: 'recipe', id: 'zhishi-pwn-a3f2', name: 'zhishi-pwn-a3f2', type: 'pwn',
    });
  });
});

describe('1.5.4 回归(A1-2 档案锚 / A2-1 校准口径 / A2-2 注入锚)', () => {
  it('A1-2:invokePiSession 不碰单例档案锚——invoke 的 getAnchor 恒 undefined,交互轮的锚不被清空', async () => {
    // 交互 turn 落地:锚 = 该轮 wire user 消息 id(buildTurnStack 每 turn 重建工具栈)。
    await sendPiChatMessage({ text: '交互轮' });
    await waitTurnSettled();
    const interactiveGetAnchor = archiveToolOptsSpy.mock.calls.at(-1)![0].getAnchor;
    const anchoredId = interactiveGetAnchor().messageId;
    expect(anchoredId).toBeTruthy();

    // headless invoke:自己的锚恒 undefined(无 wire user 消息)……
    const r = await invokePiSession({ text: 'cron 任务' }, { loopSessionId: 'ls-a12' });
    expect(r.error).toBeUndefined();
    const invokeGetAnchor = archiveToolOptsSpy.mock.calls.at(-1)![0].getAnchor;
    expect(invokeGetAnchor().messageId).toBeUndefined();
    // ……且不清空交互线的锚(旧实现直接写 this.currentTurnUserMessageId = undefined)。
    expect(interactiveGetAnchor().messageId).toBe(anchoredId);
  });

  it('A2-1:校准分母 = history + 当轮新增消息(与分子同内容相比)', async () => {
    // 语料做大,系统提示折算项不足以把两种口径压到同一钳位值。
    const history = [userMsg('h'.repeat(80_000))];
    loadLoopSessionMock.mockReturnValue({ messages: history, meta: null });
    const doneMessages = [
      userMsg('本轮问题'),
      {
        ...assistantMsg('a'.repeat(80_000)),
        usage: { input: 100_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 100_100, cost: {} },
      } as unknown as AgentMessage,
    ];
    runLoopMock.mockImplementation(async function* () {
      yield { type: 'text-delta', delta: 'x' };
      yield { type: 'done', messages: doneMessages };
    });
    await sendPiChatMessage({ text: 'q' });
    await waitTurnSettled();

    const sysChars = (runLoopMock.mock.calls[0][0] as { systemPrompt: string }).systemPrompt.length;
    const real = 100_000;
    const withDone = Math.min(6, Math.max(0.8, real / estimateMessagesTokens([...history, ...doneMessages], sysChars)));
    const withoutDone = Math.min(6, Math.max(0.8, real / estimateMessagesTokens(history, sysChars)));
    expect(withDone).not.toBe(withoutDone); // 场景可分辨(不撞钳位同值)
    const meta = appendLoopMessagesMock.mock.calls[0][2] as { tokenCalibration?: number };
    expect(meta.tokenCalibration).toBeCloseTo(withDone, 6);
  });

  it('A2-2:专家注入锚 = 当前轮用户消息(交互 + invoke 双路径,不再滞后一轮)', async () => {
    // 空 history:旧实现锚取上一条用户消息 → 首轮恒空;修复后当轮即参与打分。
    await sendPiChatMessage({ text: '交互轮话题 alpha-anchor' });
    await waitTurnSettled();
    let lastArg = collectExpertInjectionSpy.mock.calls.at(-1)![0] as { lastUserText: string };
    expect(lastArg.lastUserText).toContain('alpha-anchor');

    const r = await invokePiSession({ text: 'invoke 轮话题 beta-anchor' }, { loopSessionId: 'ls-a22' });
    expect(r.error).toBeUndefined();
    lastArg = collectExpertInjectionSpy.mock.calls.at(-1)![0] as { lastUserText: string };
    expect(lastArg.lastUserText).toContain('beta-anchor');
  });
});
