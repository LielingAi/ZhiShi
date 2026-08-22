/**
 * M3 — subagent(loop/subagent.ts)unit tests.
 *
 * 收窄语义(子白名单 ⊆ 父、delegate_task 深度限 1、envId 授权)、
 * delegate_task 结果回注、子 loop 独立 sessionId。全部用注入的 spawn
 * 假实现/真 spawn+mock 不行——这里用 spawn 注入,绝无网络/ssh。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnvironmentEntry } from '../../shared/config-types';

// B8(1.2.6)回归:直接驱动真 spawnSubLoop 时 mock runLoop 边界(绝无网络/ssh)。
const runLoopMock = vi.fn();
vi.mock('./loop', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./loop')>();
  return { ...orig, runLoop: (...args: unknown[]) => runLoopMock(...args) };
});

import {
  assertNarrowedWhitelist,
  createDelegateTaskTool,
  DELEGATE_TASK_TOOL_NAME,
  spawnSubLoop,
  type SubLoopResult,
} from './subagent';
import type { LoopModelResolution } from './pi-provider';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

const VM_ENV: EnvironmentEntry = {
  id: 'pwn-vm',
  kind: 'vm',
  vmName: 'pwn-vm',
  address: '192.168.152.129',
  user: 'researcher',
  createdAt: '2026-01-01T00:00:00Z',
};

const RESOLUTION = {
  models: {},
  model: { id: 'k3' },
  getApiKey: () => 'fake-key',
  providerId: 'moonshot-coding',
  modelId: 'k3',
} as unknown as LoopModelResolution;

const PARENT_TOOLS = ['env_exec', 'delegate_task'];

function fakeSpawn(result: Partial<SubLoopResult> = {}) {
  const calls: { prompt: string; allowedTools?: string[]; tools?: { name: string }[]; systemPrompt?: string }[] = [];
  const spawn = async (opts: { prompt: string; allowedTools?: string[]; tools?: { name: string }[]; systemPrompt?: string }): Promise<SubLoopResult> => {
    calls.push(opts);
    return {
      text: result.text ?? 'gcc 15.0.1',
      messages: result.messages ?? ([] as AgentMessage[]),
      sessionId: result.sessionId ?? 'sub-session-1',
      error: result.error,
    };
  };
  return { spawn, calls };
}

describe('assertNarrowedWhitelist(收窄硬约束)', () => {
  it('子 ⊂ 父 → 通过', () => {
    expect(() => assertNarrowedWhitelist(PARENT_TOOLS, ['env_exec'])).not.toThrow();
    expect(() => assertNarrowedWhitelist(PARENT_TOOLS, [])).not.toThrow();
  });

  it('子含父没有的工具 → throw(只能收窄不能扩大)', () => {
    expect(() => assertNarrowedWhitelist(PARENT_TOOLS, ['env_exec', 'bash'])).toThrow('越权');
  });

  it('子含 delegate_task → throw(深度限 1)', () => {
    expect(() => assertNarrowedWhitelist(PARENT_TOOLS, ['env_exec', 'delegate_task'])).toThrow('深度限 1');
    expect(() => assertNarrowedWhitelist(PARENT_TOOLS, ['delegate_task'])).toThrow('深度限 1');
  });
});

describe('createDelegateTaskTool', () => {
  it('工具形态:name/schema/description', () => {
    const { spawn } = fakeSpawn();
    const tool = createDelegateTaskTool({ env: VM_ENV, resolution: RESOLUTION, parentAllowedTools: PARENT_TOOLS, spawn });
    expect(tool.name).toBe(DELEGATE_TASK_TOOL_NAME);
    expect(tool.description).toContain('子代理');
  });

  it('构造期收窄断言:childAllowedTools 越权即 throw', () => {
    expect(() =>
      createDelegateTaskTool({
        env: VM_ENV,
        resolution: RESOLUTION,
        parentAllowedTools: PARENT_TOOLS,
        childAllowedTools: ['env_exec', 'bash'],
      }),
    ).toThrow('越权');
  });

  it('execute:派发子任务并回注结论摘要(含子 sessionId)', async () => {
    const { spawn, calls } = fakeSpawn({ text: 'gcc 15.0.1', sessionId: 'sub-42' });
    const tool = createDelegateTaskTool({ env: VM_ENV, resolution: RESOLUTION, parentAllowedTools: PARENT_TOOLS, spawn });
    const r = await tool.execute('tc1', { task: '查 gcc 版本' });
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toBe('查 gcc 版本');
    // 子白名单默认收窄为 [env_exec](比父少 delegate_task)
    expect(calls[0].allowedTools).toEqual(['env_exec']);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('gcc 15.0.1');
    expect(text).toContain('sub-42');
    expect(r.details?.sessionId).toBe('sub-42');
  });

  it('envId 与父绑定不符 → throw(子任务不能跳环境)', async () => {
    const { spawn, calls } = fakeSpawn();
    const tool = createDelegateTaskTool({ env: VM_ENV, resolution: RESOLUTION, parentAllowedTools: PARENT_TOOLS, spawn });
    await expect(tool.execute('tc2', { task: 'x', envId: 'other-env' })).rejects.toThrow('未授权');
    expect(calls).toHaveLength(0);
  });

  it('agent 参数:按名注入子代理正文;未知名 throw', async () => {
    const { spawn, calls } = fakeSpawn();
    const tool = createDelegateTaskTool({
      env: VM_ENV,
      resolution: RESOLUTION,
      parentAllowedTools: PARENT_TOOLS,
      spawn,
      agents: [{ name: 'vuln-hunter', body: '# vuln-hunter\n假设驱动深挖。' }],
    });
    await tool.execute('tc9', { task: '审 x 模块', agent: 'vuln-hunter' });
    expect(calls[0].systemPrompt).toContain('假设驱动深挖');
    await expect(tool.execute('tc10', { task: 'x', agent: 'ghost' })).rejects.toThrow('未知子代理');
    // 不传 agent → 默认 systemPrompt(undefined)
    await tool.execute('tc11', { task: 'y' });
    expect(calls[1].systemPrompt).toBeUndefined();
  });

  it('envId 匹配父绑定 → 放行', async () => {
    const { spawn, calls } = fakeSpawn();
    const tool = createDelegateTaskTool({ env: VM_ENV, resolution: RESOLUTION, parentAllowedTools: PARENT_TOOLS, spawn });
    await tool.execute('tc3', { task: 'x', envId: 'pwn-vm' });
    expect(calls).toHaveLength(1);
  });

  it('子 loop 失败:错误摘要回注,不向上 throw', async () => {
    const { spawn } = fakeSpawn({ text: '', error: 'LLM call error' });
    const tool = createDelegateTaskTool({ env: VM_ENV, resolution: RESOLUTION, parentAllowedTools: PARENT_TOOLS, spawn });
    const r = await tool.execute('tc4', { task: 'x' });
    expect((r.content[0] as { text: string }).text).toContain('子任务执行失败');
    expect(r.details?.error).toBe('LLM call error');
  });
});

describe('W1 生命周期通知 + 子 loop 事件出口', () => {
  it('notify.started/finished 同 taskId;finished 带摘要;details 带 taskId', async () => {
    const { spawn } = fakeSpawn({ text: '结论 A', sessionId: 'sub-7' });
    const events: Array<{ kind: string; taskId: string; summary?: string; error?: string }> = [];
    const tool = createDelegateTaskTool({
      env: VM_ENV,
      resolution: RESOLUTION,
      parentAllowedTools: PARENT_TOOLS,
      spawn,
      notify: {
        started: (taskId, description) => events.push({ kind: `started:${description}`, taskId }),
        finished: (taskId, _d, summary, error) => events.push({ kind: 'finished', taskId, summary, error }),
      },
    });
    const r = await tool.execute('tc5', { task: '干活' });
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ kind: 'started:干活', taskId: events[0].taskId });
    expect(events[1].kind).toBe('finished');
    expect(events[1].summary).toBe('结论 A');
    expect(events[1].error).toBeUndefined();
    expect(events[1].taskId).toBe(events[0].taskId);
    expect(r.details?.taskId).toBe(events[0].taskId);
  });

  it('子 loop 失败:finished 带 error;spawn 抛异常:finished 兜底后向上 throw', async () => {
    const { spawn } = fakeSpawn({ text: '', error: 'LLM call error' });
    const finished: Array<{ summary: string; error?: string }> = [];
    const tool = createDelegateTaskTool({
      env: VM_ENV,
      resolution: RESOLUTION,
      parentAllowedTools: PARENT_TOOLS,
      spawn,
      notify: { started: () => {}, finished: (_t, _d, summary, error) => finished.push({ summary, error }) },
    });
    await tool.execute('tc6', { task: 'x' });
    expect(finished[0].error).toBe('LLM call error');

    const boom = async (): Promise<SubLoopResult> => { throw new Error('spawn boom'); };
    const finished2: Array<{ error?: string }> = [];
    const tool2 = createDelegateTaskTool({
      env: VM_ENV,
      resolution: RESOLUTION,
      parentAllowedTools: PARENT_TOOLS,
      spawn: boom,
      notify: { started: () => {}, finished: (_t, _d, _s, error) => finished2.push({ error }) },
    });
    await expect(tool2.execute('tc7', { task: 'x' })).rejects.toThrow('spawn boom');
    expect(finished2[0].error).toBe('spawn boom');
  });

  it('onLoopEvent 透传(带 taskId 包装进 spawn options)', async () => {
    const seen: Array<{ taskId: string; type: string }> = [];
    const spawn = async (opts: { onLoopEvent?: (e: { type: string }) => void }): Promise<SubLoopResult> => {
      opts.onLoopEvent?.({ type: 'tool-call' });
      opts.onLoopEvent?.({ type: 'done' });
      return { text: 'ok', messages: [] as AgentMessage[], sessionId: 'sub-9' };
    };
    const tool = createDelegateTaskTool({
      env: VM_ENV,
      resolution: RESOLUTION,
      parentAllowedTools: PARENT_TOOLS,
      spawn: spawn as never,
      onLoopEvent: (taskId, event) => seen.push({ taskId, type: (event as { type: string }).type }),
    });
    await tool.execute('tc8', { task: 'x' });
    expect(seen.map((s) => s.type)).toEqual(['tool-call', 'done']);
    expect(seen[0].taskId).toBe(seen[1].taskId);
    expect(seen[0].taskId).toBeTruthy();
  });
});


describe('B8(1.2.6):子 loop 接 abort + 压缩', () => {
  beforeEach(() => {
    runLoopMock.mockReset();
  });

  it('execute 第三参 signal 透传 spawn options(主 turn 中止 → 子 loop 同步中止)', async () => {
    let seen: { signal?: AbortSignal } | undefined;
    const spawn = async (opts: { signal?: AbortSignal }): Promise<SubLoopResult> => {
      seen = opts;
      return { text: 'ok', messages: [] as AgentMessage[], sessionId: 'sub-abort' };
    };
    const tool = createDelegateTaskTool({ env: VM_ENV, resolution: RESOLUTION, parentAllowedTools: PARENT_TOOLS, spawn });
    const ac = new AbortController();
    await tool.execute('tc-b8', { task: 'x' }, ac.signal);
    expect(seen?.signal).toBe(ac.signal);
    // 无第三参(旧调用形)不挂 signal
    await tool.execute('tc-b8b', { task: 'y' });
    expect(seen?.signal).toBeUndefined();
  });

  it('spawnSubLoop:signal 与主 loop 同款压缩 transformContext 透传 runLoop', async () => {
    runLoopMock.mockImplementation(async function* () {
      yield { type: 'done', messages: [] };
    });
    const ac = new AbortController();
    const r = await spawnSubLoop({
      prompt: '查证 x',
      env: VM_ENV,
      resolution: RESOLUTION,
      parentAllowedTools: PARENT_TOOLS,
      signal: ac.signal,
    });
    expect(r.sessionId).toBeTruthy();
    expect(runLoopMock).toHaveBeenCalledTimes(1);
    const opts = runLoopMock.mock.calls[0][0] as {
      signal?: AbortSignal;
      transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
    };
    // abort 透传:pi 层收到同一个 signal
    expect(opts.signal).toBe(ac.signal);
    // 压缩挂载点存在(主 loop 同款 makeCompactionTransform);未超阈值原样透传
    expect(typeof opts.transformContext).toBe('function');
    const msgs = [{ role: 'user', content: '短', timestamp: 1 } as AgentMessage];
    expect(await opts.transformContext!(msgs)).toEqual(msgs);
  });

  it('spawnSubLoop:缺省 signal 也能跑(向后兼容旧调用形)', async () => {
    runLoopMock.mockImplementation(async function* () {
      yield { type: 'done', messages: [] };
    });
    const r = await spawnSubLoop({
      prompt: 'x',
      env: VM_ENV,
      resolution: RESOLUTION,
      parentAllowedTools: PARENT_TOOLS,
    });
    expect(r.error).toBeUndefined();
    const opts = runLoopMock.mock.calls[0][0] as { signal?: AbortSignal };
    expect(opts.signal).toBeUndefined();
  });
});
