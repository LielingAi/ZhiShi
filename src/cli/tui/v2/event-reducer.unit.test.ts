/**
 * event-reducer 单元测试(1.2.8 修复路)。
 *
 * 覆盖:
 *   H1 思考块串台 — thinking-start 先落定旧块;chunk/complete 作用于最后一个
 *      streaming 思考块(findLast 语义)。
 *   H2 工具卡 isError — pi 契约 {isError:true} → fail 态。
 *   M1 queue:added isInFlight — true=promote 出队;false=入队(同 id 原地更新)。
 *   H3 重连重复上屏 — chat:init(replay 前导)清掉无 srvId 且不在流的 live 块,
 *      保留在流块与 srvId 块,replay 全量重建不重复。
 *   M4 重连对账 — chat:init 先清队列,replay 末尾快照(queue:added 形态)重建。
 */

import { describe, it, expect } from 'vitest';

import { reduceSseEvent } from './event-reducer';
import type {
  AssistantBlock,
  Block,
  SessionState,
  SseInput,
  ThinkingBlock,
  ToolBlock,
} from './types';

function makeSession(): SessionState {
  return {
    blocks: [],
    streamingId: null,
    queue: [],
    tasks: new Map(),
    status: {
      phase: 'idle',
      queueDepth: 0,
      contextPct: 0,
      model: 'test-model',
      backgroundSeg: undefined,
      envName: 'host',
      envKind: 'env',
      modalActive: false,
    },
    currentTurnId: null,
    pendingDividerId: null,
    seenSrvIds: new Set(),
    bgProcs: new Map(),
    seq: 0,
  };
}

function ev(event: string, payload: unknown): SseInput {
  return { event, payload };
}

function replay(frames: SseInput[]): SessionState {
  const s = makeSession();
  for (const f of frames) reduceSseEvent(s, f);
  return s;
}

function thinkingBlocks(s: SessionState): ThinkingBlock[] {
  return s.blocks.filter((b): b is ThinkingBlock => b.kind === 'thinking');
}

// ---------------------------------------------------------------------------
// H1 思考块串台
// ---------------------------------------------------------------------------

describe('1.2.8 H1 思考块串台', () => {
  it('thinking-start 先把仍在 streaming 的旧思考块落定再开新块', () => {
    const s = replay([
      ev('chat:thinking-start', {}),
      ev('chat:thinking-chunk', { delta: '旧' }),
      // 旧块没等到 complete,新一轮 thinking 就开始了(串台现场)。
      ev('chat:thinking-start', {}),
      ev('chat:thinking-chunk', { delta: '新' }),
    ]);
    const ts = thinkingBlocks(s);
    expect(ts).toHaveLength(2);
    // 旧块被落定:不再 streaming,文本保留,渲染从「thought…」翻到完成态。
    expect(ts[0].streaming).toBe(false);
    expect(ts[0].complete).toBe(true);
    expect(ts[0].text).toBe('旧');
    // 新块仍在流。
    expect(ts[1].streaming).toBe(true);
    expect(ts[1].text).toBe('新');
  });

  it('thinking-chunk 作用于最后一个 streaming 思考块(不是第一个)', () => {
    const s = makeSession();
    // 手工摆出两个同时在 streaming 的思考块(旧 reducer 的 find 会写进第一个)。
    s.blocks.push(
      { id: 't-1', kind: 'thinking', seq: 1, text: '', streaming: true, complete: false },
      { id: 't-2', kind: 'thinking', seq: 2, text: '', streaming: true, complete: false },
    );
    reduceSseEvent(s, ev('chat:thinking-chunk', { delta: 'x' }));
    const [t1, t2] = thinkingBlocks(s);
    expect(t1.text).toBe('');
    expect(t2.text).toBe('x');
  });

  it('thinking-complete(pi 新事件 {index})落定最后一个 streaming 思考块', () => {
    const s = makeSession();
    s.blocks.push(
      { id: 't-1', kind: 'thinking', seq: 1, text: 'a', streaming: true, complete: false },
      { id: 't-2', kind: 'thinking', seq: 2, text: 'b', streaming: true, complete: false },
    );
    const patch = reduceSseEvent(s, ev('chat:thinking-complete', { index: 1, seconds: 4 }));
    const [t1, t2] = thinkingBlocks(s);
    expect(t1.streaming).toBe(true); // 第一个不受影响
    expect(t2.streaming).toBe(false);
    expect(t2.complete).toBe(true);
    expect(t2.seconds).toBe(4);
    expect(patch.touched).toEqual(['t-2']);
  });
});

// ---------------------------------------------------------------------------
// H2 工具卡 isError
// ---------------------------------------------------------------------------

describe('1.2.8 H2 工具卡 isError', () => {
  it('tool-result-complete {isError:true} → fail;{isError:false} → done', () => {
    const s = replay([
      ev('chat:tool-use-start', { id: 't1', name: 'env_exec', input: { command: 'false' } }),
      ev('chat:tool-result-complete', { toolUseId: 't1', content: 'boom', isError: true }),
      ev('chat:tool-use-start', { id: 't2', name: 'env_exec', input: { command: 'true' } }),
      ev('chat:tool-result-complete', { toolUseId: 't2', content: 'ok', isError: false }),
    ]);
    const tools = s.blocks.filter((b): b is ToolBlock => b.kind === 'tool');
    expect(tools[0].state).toBe('fail');
    expect(tools[0].output).toBe('boom');
    expect(tools[1].state).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// M1 queue:added isInFlight
// ---------------------------------------------------------------------------

describe('1.2.8 M1 queue:added isInFlight', () => {
  it('isInFlight:true → promote 语义,从队列移除该 queueId(不是 push)', () => {
    const s = replay([
      ev('queue:added', { queueId: 'q1', messageText: '第一条' }),
      ev('queue:added', { queueId: 'q2', messageText: '第二条' }),
      // q1 开跑:服务端重发 queue:added 带 isInFlight:true。
      ev('queue:added', { queueId: 'q1', messageText: '第一条', isInFlight: true }),
    ]);
    expect(s.queue.map((q) => q.id)).toEqual(['q2']);
  });

  it('isInFlight:true 对不在列的 queueId 也不入队', () => {
    const s = replay([
      ev('queue:added', { queueId: 'q9', messageText: '幽灵', isInFlight: true }),
    ]);
    expect(s.queue).toHaveLength(0);
  });

  it('isInFlight:false/缺省 同 queueId 已存在 → 原地更新不重复 push', () => {
    const s = replay([
      ev('queue:added', { queueId: 'q1', messageText: '旧文案' }),
      ev('queue:added', { queueId: 'q1', messageText: '新文案', isInFlight: false }),
    ]);
    expect(s.queue).toHaveLength(1);
    expect(s.queue[0].text).toBe('新文案');
  });
});

// ---------------------------------------------------------------------------
// H3 重连重复上屏 / M4 重连队列对账
// ---------------------------------------------------------------------------

describe('1.2.8 H3/M4 重连 replay 前导(chat:init)', () => {
  it('清掉无 srvId 且不在流的 live 块,保留 srvId 块与在流块,并打 reset 标记', () => {
    const s = makeSession();
    // 权威历史(srvId 块,来自上次 replay)。
    s.blocks.push({
      id: 'u-1', kind: 'user', seq: 1, srvId: 'srv-u1', text: '历史问题',
    } as Block);
    s.seenSrvIds.add('srv-u1');
    // live 块:message-chunk 建的 assistant(已完) + 跑完的工具卡(无 srvId)。
    reduceSseEvent(s, ev('chat:message-chunk', { delta: 'live 回答' }));
    reduceSseEvent(s, ev('chat:message-complete', {}));
    reduceSseEvent(s, ev('chat:tool-use-start', { id: 'tool-1', name: 'bash', input: {} }));
    reduceSseEvent(s, ev('chat:tool-result-complete', { toolUseId: 'tool-1', content: 'out' }));
    // 在流块:正在流式的 assistant + 正在跑的工具卡。
    reduceSseEvent(s, ev('chat:message-chunk', { delta: '正在流式' }));
    reduceSseEvent(s, ev('chat:tool-use-start', { id: 'tool-2', name: 'bash', input: {} }));

    const patch = reduceSseEvent(s, ev('chat:init', { sessionState: 'running' }));

    expect(patch.reset).toBe(true);
    const ids = s.blocks.map((b) => b.id);
    expect(ids).toContain('u-1'); // srvId 块保留
    // 已完成的 live assistant / 工具卡被清(等 replay 重建权威版本)。
    const gone = s.blocks.filter(
      (b) =>
        (b.kind === 'assistant' && (b as AssistantBlock).text === 'live 回答') ||
        (b.kind === 'tool' && b.id === 'tool-1'),
    );
    expect(gone).toHaveLength(0);
    // 在流块保留(服务端 replay 会跳过正在流式的内容)。
    const streaming = s.blocks.find((b) => b.kind === 'assistant') as AssistantBlock;
    expect(streaming.text).toBe('正在流式');
    expect(streaming.streaming).toBe(true);
    const runningTool = s.blocks.find((b) => b.id === 'tool-2') as ToolBlock;
    expect(runningTool.state).toBe('running');
    // seenSrvIds 里权威历史的 id 保留,继续去重。
    expect(s.seenSrvIds.has('srv-u1')).toBe(true);
  });

  it('首次连接的 chat:init(空状态)不打 reset 标记', () => {
    const s = makeSession();
    const patch = reduceSseEvent(s, ev('chat:init', { sessionState: 'idle' }));
    expect(patch.reset).toBeUndefined();
  });

  it('重连后 replay 全量重建:live assistant 不重复上屏', () => {
    const s = makeSession();
    // 断线前:live 流了一轮 assistant(无 srvId)。
    reduceSseEvent(s, ev('chat:message-chunk', { delta: '回答甲' }));
    reduceSseEvent(s, ev('chat:message-complete', {}));
    expect(s.blocks.filter((b) => b.kind === 'assistant')).toHaveLength(1);
    // 重连:replay 前导 + 权威历史重放(带 srvId)。
    reduceSseEvent(s, ev('chat:init', { sessionState: 'running' }));
    reduceSseEvent(s, ev('chat:message-replay', { id: 'srv-1', role: 'user', content: '问题' }));
    reduceSseEvent(s, ev('chat:message-replay', { id: 'srv-2', role: 'assistant', content: '回答甲' }));
    const assistants = s.blocks.filter((b) => b.kind === 'assistant');
    expect(assistants).toHaveLength(1); // 只有权威版本,live 残影已清
    expect((assistants[0] as AssistantBlock).srvId).toBe('srv-2');
    expect((assistants[0] as AssistantBlock).text).toBe('回答甲');
  });

  it('M4:chat:init 先清队列残影,replay 末尾快照(isInFlight 混合)重建', () => {
    const s = makeSession();
    reduceSseEvent(s, ev('queue:added', { queueId: 'old-1', messageText: '断线前残影' }));
    expect(s.queue).toHaveLength(1);

    const patch = reduceSseEvent(s, ev('chat:init', { sessionState: 'running' }));
    expect(s.queue).toHaveLength(0);
    expect(patch.status?.queueDepth).toBe(0);

    // replay 末尾的队列快照:q1 已开跑(isInFlight:true),q2 在列。
    reduceSseEvent(s, ev('queue:added', { queueId: 'q1', messageText: '开跑中', isInFlight: true }));
    reduceSseEvent(s, ev('queue:added', { queueId: 'q2', messageText: '排队中', isInFlight: false }));
    expect(s.queue.map((q) => q.id)).toEqual(['q2']);
    // 快照重放幂等:再收一次同样的快照不翻倍。
    reduceSseEvent(s, ev('queue:added', { queueId: 'q1', messageText: '开跑中', isInFlight: true }));
    reduceSseEvent(s, ev('queue:added', { queueId: 'q2', messageText: '排队中', isInFlight: false }));
    expect(s.queue).toHaveLength(1);
  });
});
