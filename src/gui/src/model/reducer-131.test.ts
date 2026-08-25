/**
 * reducer 1.3.1 新增事件单测：boundary-ask / boundary-expired /
 * bg-started / bg-finished / subagent-started / subagent-finished /
 * subagent-tool-use（登记表增量走 ReduceResult，不落会话流）。
 */

import { describe, expect, it } from 'vitest';

import { reduceSseEvent } from './reducer';
import { emptySession } from './blocks';

describe('reduceSseEvent · 1.3.1 事件', () => {
  it('chat:boundary-ask → boundaryAsk upsert（会话流不动）', () => {
    const session = emptySession();
    const res = reduceSseEvent(session, {
      event: 'chat:boundary-ask',
      payload: { askId: 'ask-1', kind: 'host-write', objects: ['a', 'b'] },
    });
    expect(res.session).toEqual(session);
    expect(res.boundaryAsk).toEqual({
      type: 'upsert',
      askId: 'ask-1',
      kind: 'host-write',
      objects: ['a', 'b'],
    });
  });

  it('chat:boundary-ask 非字符串对象被滤掉；缺 askId 忽略', () => {
    const res = reduceSseEvent(emptySession(), {
      event: 'chat:boundary-ask',
      payload: { askId: 'ask-2', kind: 'net-policy', objects: ['x', 1, null] },
    });
    expect(res.boundaryAsk).toMatchObject({ type: 'upsert', askId: 'ask-2', objects: ['x'] });
    expect(
      reduceSseEvent(emptySession(), { event: 'chat:boundary-ask', payload: { kind: 'host-write' } }).boundaryAsk,
    ).toBeUndefined();
  });

  it('chat:boundary-expired → boundaryAsk remove', () => {
    const res = reduceSseEvent(emptySession(), {
      event: 'chat:boundary-expired',
      payload: { askId: 'ask-1' },
    });
    expect(res.boundaryAsk).toEqual({ type: 'remove', askId: 'ask-1' });
  });

  it('chat:bg-started / bg-finished → bgEvent（payload 形状对齐 chat-engine 广播点）', () => {
    const started = reduceSseEvent(emptySession(), {
      event: 'chat:bg-started',
      payload: { tag: 'fuzz', pid: 123, commandPreview: 'afl-fuzz' },
    });
    expect(started.bgEvent).toEqual({ kind: 'started', tag: 'fuzz', pid: 123, commandPreview: 'afl-fuzz' });

    const finished = reduceSseEvent(emptySession(), {
      event: 'chat:bg-finished',
      payload: { tag: 'fuzz', status: 'done', exitCode: 0 },
    });
    expect(finished.bgEvent).toEqual({ kind: 'finished', tag: 'fuzz', status: 'done', exitCode: 0 });
  });

  it('chat:subagent-started → subagentEvent started', () => {
    const res = reduceSseEvent(emptySession(), {
      event: 'chat:subagent-started',
      payload: { taskId: 't1', description: '崩溃去重' },
    });
    expect(res.subagentEvent).toEqual({ kind: 'started', taskId: 't1', description: '崩溃去重' });
  });

  it('chat:subagent-finished → 结论摘要/状态/loopSessionId 透传', () => {
    const res = reduceSseEvent(emptySession(), {
      event: 'chat:subagent-finished',
      payload: { taskId: 't1', description: 'd', summary: '3 个真崩溃', status: 'completed', loopSessionId: 'loop-9' },
    });
    expect(res.subagentEvent).toEqual({
      kind: 'finished',
      taskId: 't1',
      description: 'd',
      summary: '3 个真崩溃',
      status: 'completed',
      error: undefined,
      loopSessionId: 'loop-9',
    });
  });

  it('chat:subagent-tool-use → tool-use（subagentId 字段对齐广播点）', () => {
    const res = reduceSseEvent(emptySession(), {
      event: 'chat:subagent-tool-use',
      payload: { subagentId: 't1', id: 'tu-1', name: 'env_exec', input: {} },
    });
    expect(res.subagentEvent).toEqual({ kind: 'tool-use', taskId: 't1', name: 'env_exec' });
  });

  it('缺关键 id 的事件被忽略（不产出增量）', () => {
    expect(reduceSseEvent(emptySession(), { event: 'chat:bg-started', payload: {} }).bgEvent).toBeUndefined();
    expect(reduceSseEvent(emptySession(), { event: 'chat:subagent-finished', payload: { summary: 'x' } }).subagentEvent).toBeUndefined();
  });
});
