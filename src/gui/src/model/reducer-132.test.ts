/**
 * reducer 1.3.2 新增事件单测：
 *   - chat:decision-request / chat:decision-resolved（登记表增量）
 *   - chat:init → decisionRequest reset + environment 锚
 *   - kind:'decision' 的 user replay → 琥珀决策块（不落普通气泡路径）
 *   - chat:boundary-ask additive 字段（toolName/toolDescription/options）透传
 *   - buildTaskRows server 行 conclusion
 */

import { describe, expect, it } from 'vitest';

import { emptySession, type TurnBlock } from './blocks';
import { buildTaskRows } from './tasks';
import { initAnchorOf, reduceSseEvent } from './reducer';

function ev(event: string, payload: unknown) {
  return { event, payload };
}

describe('reduceSseEvent · 1.3.2 决策事件', () => {
  it('chat:decision-request → decisionRequest upsert（会话流不动）', () => {
    const session = emptySession();
    const res = reduceSseEvent(session, {
      event: 'chat:decision-request',
      payload: {
        decisionId: 'dec-1',
        question: 'A 还是 B',
        options: ['A', 'B'],
        expertHits: ['E#1 [binary/sop] t | 适用条件: x | 判据: y'],
      },
    });
    expect(res.session).toEqual(session);
    expect(res.decisionRequest).toEqual({
      type: 'upsert',
      decisionId: 'dec-1',
      question: 'A 还是 B',
      options: ['A', 'B'],
      expertHits: ['E#1 [binary/sop] t | 适用条件: x | 判据: y'],
    });
  });

  it('chat:decision-request 非字符串 options/expertHits 被滤掉；缺 decisionId 忽略', () => {
    const res = reduceSseEvent(emptySession(), {
      event: 'chat:decision-request',
      payload: { decisionId: 'dec-2', question: 'q', options: ['a', 1], expertHits: ['x', null] },
    });
    expect(res.decisionRequest).toMatchObject({ type: 'upsert', options: ['a'], expertHits: ['x'] });
    expect(
      reduceSseEvent(emptySession(), { event: 'chat:decision-request', payload: { question: 'q' } })
        .decisionRequest,
    ).toBeUndefined();
  });

  it('chat:decision-resolved → decisionResolved（store 摘除 pending）', () => {
    const res = reduceSseEvent(emptySession(), {
      event: 'chat:decision-resolved',
      payload: { decisionId: 'dec-1', choice: 'A', note: 'n', expertRefs: ['E#1'] },
    });
    expect(res.decisionResolved).toEqual({ decisionId: 'dec-1' });
  });

  it('chat:init → decisionRequest reset（重连重放先清再建）+ environment 锚', () => {
    const res = reduceSseEvent(emptySession(), {
      event: 'chat:init',
      payload: {
        agentDir: '/w',
        sessionState: 'idle',
        environment: { kind: 'env', id: 'pwn-vm', name: 'pwn-vm', type: 'vm' },
      },
    });
    expect(res.decisionRequest).toEqual({ type: 'reset' });
    expect(res.environment).toEqual({ kind: 'env', id: 'pwn-vm', name: 'pwn-vm', type: 'vm' });
  });

  it('chat:init environment: null（host 会话）≠ 字段缺失', () => {
    const host = reduceSseEvent(emptySession(), {
      event: 'chat:init',
      payload: { agentDir: '/w', environment: null },
    });
    expect(host.environment).toBeNull();

    const absent = reduceSseEvent(emptySession(), {
      event: 'chat:init',
      payload: { agentDir: '/w' },
    });
    expect('environment' in absent).toBe(false);
  });

  it('initAnchorOf：非 env/recipe 形状回落 null', () => {
    expect(initAnchorOf({ kind: 'recipe', id: 'i1', name: 'i1', type: 'pwn-vm' })).toMatchObject({
      kind: 'recipe',
      id: 'i1',
    });
    expect(initAnchorOf({ kind: 'host' })).toBeNull();
    expect(initAnchorOf(null)).toBeNull();
    expect(initAnchorOf('x')).toBeNull();
  });
});

describe('reduceSseEvent · 1.3.2 决策块（kind:decision 的 user replay）', () => {
  it('决策 user 消息 → 带 decision 标记的块；后续 assistant 照常归入 conclusion', () => {
    let s = emptySession();
    s = reduceSseEvent(
      s,
      ev('chat:message-replay', {
        message: {
          id: 'm1',
          role: 'user',
          content: '【人的决定】\n问题: 方向\n选择: A\n备注: 先探',
          kind: 'decision',
          decisionId: 'dec-9',
          choice: 'A',
          note: '先探',
          expertRefs: ['E#1'],
        },
      }),
    ).session;
    const t = s.items[0] as TurnBlock;
    expect(t.kind).toBe('turn');
    expect(t.decision).toEqual({ decisionId: 'dec-9', choice: 'A', note: '先探', expertRefs: ['E#1'] });
    expect(t.userText).toContain('【人的决定】');

    s = reduceSseEvent(s, ev('chat:message-replay', { message: { id: 'm2', role: 'assistant', content: '按决定继续' } })).session;
    expect((s.items[0] as TurnBlock).conclusion).toBe('按决定继续');
  });

  it('不带 expertRefs/note 的决策消息（additive 缺省）→ 空引用/无备注', () => {
    const s = reduceSseEvent(
      emptySession(),
      ev('chat:message-replay', {
        message: { id: 'm1', role: 'user', content: '决定', kind: 'decision', decisionId: 'd', choice: 'B' },
      }),
    ).session;
    expect((s.items[0] as TurnBlock).decision).toEqual({ decisionId: 'd', choice: 'B', expertRefs: [] });
  });

  it('普通 user 消息不带 decision 标记（不误判）', () => {
    const s = reduceSseEvent(
      emptySession(),
      ev('chat:message-replay', { message: { id: 'm1', role: 'user', content: '你好' } }),
    ).session;
    expect((s.items[0] as TurnBlock).decision).toBeUndefined();
  });
});

describe('reduceSseEvent · 1.3.2 boundary additive 字段', () => {
  it('chat:boundary-ask 透传 toolName/toolDescription/options', () => {
    const res = reduceSseEvent(emptySession(), {
      event: 'chat:boundary-ask',
      payload: {
        askId: 'ask-1',
        kind: 'host-write',
        objects: ['/work/flag.txt'],
        toolName: 'environment/extract',
        toolDescription: '把环境内成果提取回宿主',
        options: ['批准写入', '拒绝'],
      },
    });
    expect(res.boundaryAsk).toEqual({
      type: 'upsert',
      askId: 'ask-1',
      kind: 'host-write',
      objects: ['/work/flag.txt'],
      toolName: 'environment/extract',
      toolDescription: '把环境内成果提取回宿主',
      options: ['批准写入', '拒绝'],
    });
  });

  it('旧形状（无 additive）保持缺省', () => {
    const res = reduceSseEvent(emptySession(), {
      event: 'chat:boundary-ask',
      payload: { askId: 'ask-2', kind: 'net-policy', objects: [] },
    });
    expect(res.boundaryAsk).toEqual({ type: 'upsert', askId: 'ask-2', kind: 'net-policy', objects: [] });
  });
});

describe('buildTaskRows · 1.3.2 server 行 conclusion', () => {
  it('task/list 行带 conclusion → 行展示（有则显示；null/非字符串不带）', () => {
    const rows = buildTaskRows([], [], [
      { id: 't1', name: '扫描任务', status: 'done', conclusion: '3 个高危端口' },
      { id: 't2', name: '无结论任务', status: 'done', conclusion: null },
      { id: 't3', name: '普通任务', status: 'done' },
    ]);
    expect(rows[0].conclusion).toBe('3 个高危端口');
    expect(rows[1].conclusion).toBeUndefined();
    expect(rows[2].conclusion).toBeUndefined();
  });
});
