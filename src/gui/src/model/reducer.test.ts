/**
 * 事件归约单测：块归属 / replay 重建 / steering / 队列 / resync。
 */

import { describe, expect, it } from 'vitest';

import { emptySession, type SessionState, type ThinkingDetail, type ToolDetail, type TurnBlock } from './blocks';
import { reduceSseEvent } from './reducer';

function ev(event: string, payload: unknown): { event: string; payload: unknown } {
  return { event, payload };
}

function lastTurn(s: SessionState): TurnBlock {
  const t = [...s.items].reverse().find((i): i is TurnBlock => i.kind === 'turn');
  if (!t) throw new Error('no turn');
  return t;
}

function replayUser(id: string, content: string, extra: Record<string, unknown> = {}) {
  return ev('chat:message-replay', { message: { id, role: 'user', content, ...extra } });
}

function replayAssistant(id: string, content: string) {
  return ev('chat:message-replay', { message: { id, role: 'assistant', content } });
}

function replayTool(id: string, name: string, content: string, ok = true) {
  return ev('chat:message-replay', { message: { id, role: 'tool', name, content, ok } });
}

describe('reduceSseEvent — 块归属（replay 重建）', () => {
  it('user replay 开新块；assistant/tool replay 归入当前块', () => {
    let s = emptySession();
    s = reduceSseEvent(s, replayUser('u1', '帮我看看崩溃')).session;
    expect(s.items).toHaveLength(1);
    const t0 = lastTurn(s);
    expect(t0.userText).toBe('帮我看看崩溃');
    expect(t0.status).toBe('running');

    s = reduceSseEvent(s, replayTool('t1', 'env_exec', 'SIGSEGV', false)).session;
    s = reduceSseEvent(s, replayAssistant('a1', 'EIP 可控')).session;
    const t1 = lastTurn(s);
    expect(t1.id).toBe(t0.id);
    expect(t1.conclusion).toBe('EIP 可控');
    expect(t1.details).toHaveLength(1);
    expect(t1.details[0].kind).toBe('tool');
    expect((t1.details[0] as ToolDetail).state).toBe('fail');

    // 下一条 user 开新块，上一块落定 complete
    s = reduceSseEvent(s, replayUser('u2', '继续')).session;
    expect(s.items).toHaveLength(2);
    expect((s.items[0] as TurnBlock).status).toBe('complete');
    expect(lastTurn(s).userText).toBe('继续');
  });

  it('replay 按 wire id 去重（重连幂等）', () => {
    let s = emptySession();
    s = reduceSseEvent(s, replayUser('u1', 'hello')).session;
    s = reduceSseEvent(s, replayAssistant('a1', 'hi')).session;
    s = reduceSseEvent(s, replayUser('u1', 'hello')).session; // 重复
    s = reduceSseEvent(s, replayAssistant('a1', 'hi')).session; // 重复
    expect(s.items).toHaveLength(1);
    expect(lastTurn(s).conclusion).toBe('hi'); // 不重复累计
  });

  it('纠偏判定按 chat:steering-added 登记(而非 queueId 存在——每条消息都带 queueId)', () => {
    // 无 steering-added 登记：即使 replay 带 queueId 也不是纠偏（1.3.0 修正）
    const plain = reduceSseEvent(emptySession(), replayUser('u1', '普通消息', { queueId: 'q-1' })).session;
    expect(lastTurn(plain).steering).toBe(false);
    // 先收到 steering-added 再 replay：同 queueId → 纠偏
    let s = reduceSseEvent(emptySession(), ev('chat:steering-added', { queueId: 'q-1', messageText: '换个思路' })).session;
    s = reduceSseEvent(s, replayUser('u2', '换个思路', { queueId: 'q-1' })).session;
    expect(lastTurn(s).steering).toBe(true);
    // 不同 queueId 不受影响
    s = reduceSseEvent(emptySession(), ev('chat:steering-added', { queueId: 'q-1' })).session;
    s = reduceSseEvent(s, replayUser('u3', '别的消息', { queueId: 'q-9' })).session;
    expect(lastTurn(s).steering).toBe(false);
  });
});

describe('reduceSseEvent — 活体事件归块', () => {
  it('chunk 聚合进当前块 conclusion，且置 running', () => {
    let s = emptySession();
    s = reduceSseEvent(s, replayUser('u1', '问')).session;
    s = reduceSseEvent(s, ev('chat:message-chunk', '你')).session;
    s = reduceSseEvent(s, ev('chat:message-chunk', '好')).session;
    expect(lastTurn(s).conclusion).toBe('你好');
    expect(s.phase).toBe('running');
  });

  it('无块时 chunk 开隐式块（引擎主动消息）', () => {
    const s = reduceSseEvent(emptySession(), ev('chat:message-chunk', 'hello')).session;
    expect(lastTurn(s).userText).toBe('');
    expect(lastTurn(s).conclusion).toBe('hello');
  });

  it('thinking 三连进细节区；新 thinking-start 落定旧块', () => {
    let s = reduceSseEvent(emptySession(), replayUser('u1', '问')).session;
    s = reduceSseEvent(s, ev('chat:thinking-start', { index: 0 })).session;
    s = reduceSseEvent(s, ev('chat:thinking-chunk', { index: 0, delta: '想' })).session;
    s = reduceSseEvent(s, ev('chat:thinking-chunk', '法')).session; // 裸字符串 delta 形态
    s = reduceSseEvent(s, ev('chat:thinking-complete', { index: 0, seconds: 3 })).session;
    const details = lastTurn(s).details;
    expect(details).toHaveLength(1);
    const th0 = details[0] as ThinkingDetail;
    expect(th0.kind).toBe('thinking');
    expect(th0.text).toBe('想法');
    expect(th0.seconds).toBe(3);
    expect(th0.streaming).toBe(false);

    // 新 thinking 开新行
    s = reduceSseEvent(s, ev('chat:thinking-start', { index: 0 })).session;
    expect(lastTurn(s).details).toHaveLength(2);
    expect((lastTurn(s).details[1] as ThinkingDetail).streaming).toBe(true);
  });

  it('工具卡归块：use-start 运行 → result-complete 落定 + 信号', () => {
    let s = reduceSseEvent(emptySession(), replayUser('u1', '打')).session;
    s = reduceSseEvent(
      s,
      ev('chat:tool-use-start', { id: 'tc-1', name: 'env_exec', input: { cmd: 'cat /work/flag.txt' } }),
    ).session;
    let d = lastTurn(s).details[0] as ToolDetail;
    expect(d.kind).toBe('tool');
    expect(d.state).toBe('running');

    s = reduceSseEvent(
      s,
      ev('chat:tool-result-complete', {
        toolUseId: 'tc-1',
        content: 'flag{d0n7_tru5t}',
        isError: false,
        exitCode: 0,
        elapsedMs: 900,
      }),
    ).session;
    d = lastTurn(s).details[0] as ToolDetail;
    expect(d.state).toBe('done');
    expect(d.output).toBe('flag{d0n7_tru5t}');
    expect(d.signal).toBe('flag 已读取');
    expect(d.elapsedMs).toBe(900);
  });

  it('工具卡 result-complete 失败 → fail + 信号（历史 {id,ok} 形态兼容）', () => {
    let s = reduceSseEvent(emptySession(), replayUser('u1', '跑')).session;
    s = reduceSseEvent(s, ev('chat:tool-use-start', { id: 'tc-2', name: 'env_exec', args: {} })).session;
    s = reduceSseEvent(
      s,
      ev('chat:tool-result-complete', { id: 'tc-2', output: 'Segmentation fault', ok: false }),
    ).session;
    expect((lastTurn(s).details[0] as ToolDetail).state).toBe('fail');
    expect((lastTurn(s).details[0] as ToolDetail).signal).toContain('Segmentation fault');
  });
});

describe('reduceSseEvent — turn 终结', () => {
  it('message-complete 定格：complete + meta + 相位回落', () => {
    let s = reduceSseEvent(emptySession(), replayUser('u1', '问')).session;
    s = reduceSseEvent(s, ev('chat:message-chunk', '答')).session;
    s = reduceSseEvent(
      s,
      ev('chat:message-complete', {
        model: 'deepseek-v4-pro',
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 5,
        cache_creation_tokens: 1,
        tool_count: 2,
        duration_ms: 1200,
        sessionState: 'idle',
      }),
    ).session;
    const t = lastTurn(s);
    expect(t.status).toBe('complete');
    expect(t.conclusionStreaming).toBe(false);
    expect(t.meta).toMatchObject({ inputTokens: 10, outputTokens: 20, toolCount: 2, durationMs: 1200 });
    expect(s.phase).toBe('idle');
    expect(s.streamingTurnId).toBeNull();
  });

  it('message-complete 无当前块（A3-3 窄窗口）：相位与流指针照常落定', () => {
    const running = { ...emptySession(), phase: 'running' as const };
    const s = reduceSseEvent(running, ev('chat:message-complete', { sessionState: 'idle' })).session;
    expect(s.phase).toBe('idle');
    expect(s.streamingTurnId).toBeNull();
    expect(s.items).toHaveLength(0); // 不造空块
  });

  it('message-stopped 落流级分隔（payload null 安全）+ 相位 interrupted', () => {
    let s = reduceSseEvent(emptySession(), replayUser('u1', '问')).session;
    s = reduceSseEvent(s, ev('chat:message-chunk', '答')).session;
    s = reduceSseEvent(s, ev('chat:message-stopped', null)).session;
    expect(lastTurn(s).status).toBe('stopped');
    const div = s.items[s.items.length - 1] as { kind: 'divider'; text: string };
    expect(div.kind).toBe('divider');
    expect(div.text).toContain('已中断');
    expect(s.phase).toBe('interrupted');
  });

  it('message-error 落流级错误行 + 相位 error', () => {
    let s = reduceSseEvent(emptySession(), replayUser('u1', '问')).session;
    s = reduceSseEvent(s, ev('chat:message-error', '引擎炸了')).session;
    expect(s.items[s.items.length - 1].kind).toBe('error');
    expect(s.phase).toBe('error');
  });
});

describe('reduceSseEvent — steering / 队列', () => {
  it('steering-added 入队 + toast；steering-cancelled 出队', () => {
    let r = reduceSseEvent(emptySession(), ev('chat:steering-added', { queueId: 'q1', messageText: '换个思路' }));
    expect(r.session.queue).toHaveLength(1);
    expect(r.session.queue[0].kind).toBe('steering');
    expect(r.toast).toContain('纠偏');
    r = reduceSseEvent(r.session, ev('chat:steering-cancelled', { queueId: 'q1' }));
    expect(r.session.queue).toHaveLength(0);
  });

  it('queue:added isInFlight 即 promote（移除而非入队）；普通入队去重', () => {
    let s = reduceSseEvent(emptySession(), ev('queue:added', { queueId: 'q1', messageText: 'a', isInFlight: false })).session;
    expect(s.queue).toHaveLength(1);
    s = reduceSseEvent(s, ev('queue:added', { queueId: 'q1', messageText: 'a2', isInFlight: false })).session;
    expect(s.queue).toHaveLength(1);
    expect(s.queue[0].text).toBe('a2');
    s = reduceSseEvent(s, ev('queue:added', { queueId: 'q1', isInFlight: true })).session;
    expect(s.queue).toHaveLength(0);
  });
});

describe('reduceSseEvent — 重连 resync（chat:init）', () => {
  it('清非流式块并摘 srvIds 让 replay 重建；保留流式块壳', () => {
    let s = emptySession();
    // 历史：一块完整 turn（replay 建成，无活体）
    s = reduceSseEvent(s, replayUser('u1', '第一问')).session;
    s = reduceSseEvent(s, replayAssistant('a1', '答一')).session;
    s = reduceSseEvent(s, replayUser('u2', '第二问')).session;
    // 第二块流式中：有活体 chunk + 一个已完成工具卡 + 一个 running 工具卡
    s = reduceSseEvent(s, ev('chat:message-chunk', '正在回答')).session;
    s = reduceSseEvent(s, ev('chat:tool-use-start', { id: 't1', name: 'env_exec', input: {} })).session;
    s = reduceSseEvent(s, ev('chat:tool-result-complete', { toolUseId: 't1', content: 'ok', isError: false })).session;
    s = reduceSseEvent(s, ev('chat:tool-use-start', { id: 't2', name: 'fuzz', input: {} })).session;

    const r = reduceSseEvent(s, ev('chat:init', { agentDir: '/work', sessionState: 'running', model: 'm1' }));
    expect(r.workspace).toBe('/work');

    const kept = r.session.items.filter((i): i is TurnBlock => i.kind === 'turn');
    expect(kept).toHaveLength(1); // 只剩流式块
    const live = kept[0];
    expect(live.userText).toBe('第二问');
    expect(live.conclusion).toBe('正在回答'); // 活体结论保留
    expect(live.details).toHaveLength(1); // done 工具卡丢弃、running 保留
    expect(live.details[0].id).toBe('t2');

    // 被清块的 user srvId 已摘除 → replay 重建
    expect(r.session.seenSrvIds.has('u1')).toBe(false);
    expect(r.session.seenSrvIds.has('u2')).toBe(true); // 保留块的 id 仍在

    // replay 重建第一块
    const s2 = reduceSseEvent(r.session, replayUser('u1', '第一问')).session;
    expect(s2.items.some((i) => i.kind === 'turn' && i.userText === '第一问')).toBe(true);
  });

  it('chat:init 携带模型与相位', () => {
    const r = reduceSseEvent(
      emptySession(),
      ev('chat:init', { agentDir: '/w', sessionState: 'idle', model: 'claude-sonnet-4-6' }),
    );
    expect(r.session.phase).toBe('idle');
    expect(r.session.model).toBe('claude-sonnet-4-6');
  });
});

describe('reduceSseEvent — 状态事件', () => {
  it('context-usage 钳制 0-100 并带模型', () => {
    let s = reduceSseEvent(emptySession(), ev('chat:context-usage', { usedPercent: 142, model: 'm' })).session;
    expect(s.contextPct).toBe(100);
    s = reduceSseEvent(s, ev('chat:context-usage', { usedPercent: -5 })).session;
    expect(s.contextPct).toBe(0);
  });

  it('system-init 取模型', () => {
    const s = reduceSseEvent(emptySession(), ev('chat:system-init', { info: { model: 'deepseek-v4-pro' } })).session;
    expect(s.model).toBe('deepseek-v4-pro');
  });

  it('chat:status 字符串形态驱动相位', () => {
    const s = reduceSseEvent(emptySession(), ev('chat:status', { sessionState: 'running' })).session;
    expect(s.phase).toBe('running');
  });

  it('未知事件忽略（契约红线：不发明事件）', () => {
    const before = emptySession();
    const after = reduceSseEvent(before, ev('chat:something-new', {})).session;
    expect(after).toBe(before);
  });
});

describe('auto-run:turn-completed — server 真实形状（1.4.6 走查实证）', () => {
  it('server 发 turn/budget.spent → turnCount/used 正确映射（字段名不再错位）', () => {
    const started = reduceSseEvent(emptySession(), {
      event: 'auto-run:started',
      payload: { id: 'run-1', name: 'n', envKey: 'pwn-vm', goal: 'g', budget: { kind: 'turns', limit: 40 }, criteria: ['c'] },
    }).autoRun;
    expect(started).toBeDefined();
    const res = reduceSseEvent(emptySession(), {
      event: 'auto-run:turn-completed',
      payload: { id: 'run-1', turn: 1, phase: 'recon', budget: { kind: 'turns', limit: 40, spent: 1 }, status: 'running' },
    });
    expect(res.autoRun).toMatchObject({ kind: 'turn', id: 'run-1', turnCount: 1, used: 1 });
  });

  it('auto-run:budget-warning 同口径（budget.spent/limit 映射）', () => {
    const res = reduceSseEvent(emptySession(), {
      event: 'auto-run:budget-warning',
      payload: { id: 'run-1', budget: { kind: 'turns', limit: 40, spent: 34 } },
    });
    expect(res.autoRun).toMatchObject({ kind: 'budget', id: 'run-1', used: 34, limit: 40 });
  });
});
