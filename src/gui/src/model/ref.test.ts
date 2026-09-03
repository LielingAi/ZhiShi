/**
 * refs 大值外溢消费端单测（1.6.3 debt #2，纯函数）。
 * 覆盖：{kind:'ref'} 占位识别、占位行落/摘（全文取回替换）、GC 后 404
 * 降级（expired/failed 留行展示 preview）、与 reducer 组合的时序语义
 * （占位先到位、真 payload 原位归约、不重排）。
 */

import { describe, expect, it } from 'vitest';

import { emptySession, type TurnBlock } from './blocks';
import {
  appendRefPlaceholder,
  formatRefSize,
  isLargeValueRef,
  resolveRefPlaceholder,
  type LargeValueRef,
} from './ref';
import { reduceSseEvent } from './reducer';

function makeRef(over: Partial<LargeValueRef> = {}): LargeValueRef {
  return {
    kind: 'ref',
    id: 'ab12cd34',
    sizeBytes: 300 * 1024,
    mimetype: 'application/json',
    preview: '{"toolUseId":"t1","content":"HEAD…',
    expiresAt: Date.now() + 3_600_000,
    ...over,
  };
}

describe('isLargeValueRef（{kind:\'ref\'} 占位识别）', () => {
  it('完整形状 → true', () => {
    expect(isLargeValueRef(makeRef())).toBe(true);
  });
  it('kind 非 ref / 缺字段 / 数组 / null → false', () => {
    expect(isLargeValueRef({ ...makeRef(), kind: 'inline' })).toBe(false);
    expect(isLargeValueRef({ kind: 'ref', id: 'ab12cd34' })).toBe(false);
    expect(isLargeValueRef([makeRef()])).toBe(false);
    expect(isLargeValueRef(null)).toBe(false);
    expect(isLargeValueRef('ref')).toBe(false);
  });
  it('id 不过路由正则（大写/过短）→ false（必 400 的 id 不制造取回）', () => {
    expect(isLargeValueRef(makeRef({ id: 'AB12CD34' }))).toBe(false);
    expect(isLargeValueRef(makeRef({ id: 'abc' }))).toBe(false);
  });
});

describe('formatRefSize', () => {
  it('KB / MB 分档', () => {
    expect(formatRefSize(300 * 1024)).toBe('300 KB');
    expect(formatRefSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
    expect(formatRefSize(100)).toBe('1 KB');
  });
});

describe('appendRefPlaceholder / resolveRefPlaceholder', () => {
  it('占位行落流尾（保序：占据事件到达位），不可变更新', () => {
    const s0 = emptySession();
    const ref = makeRef();
    const s1 = appendRefPlaceholder(s0, 'chat:tool-result-complete', ref);
    expect(s0.items).toHaveLength(0); // 原 session 不被改
    expect(s1.items).toHaveLength(1);
    const item = s1.items[0];
    expect(item).toMatchObject({
      kind: 'ref',
      id: 'ref-ab12cd34',
      event: 'chat:tool-result-complete',
      refId: 'ab12cd34',
      sizeBytes: 300 * 1024,
      state: 'loading',
    });
    expect(s1.seq).toBe(1);
  });

  it("done → 摘除占位行；expired/failed → 留行降级（preview 仍在）", () => {
    const s1 = appendRefPlaceholder(emptySession(), 'chat:tool-result-complete', makeRef());
    const done = resolveRefPlaceholder(s1, 'ab12cd34', 'done');
    expect(done.items).toHaveLength(0);

    const expired = resolveRefPlaceholder(s1, 'ab12cd34', 'expired');
    expect(expired.items).toHaveLength(1);
    expect(expired.items[0]).toMatchObject({ kind: 'ref', state: 'expired', preview: makeRef().preview });

    const failed = resolveRefPlaceholder(s1, 'ab12cd34', 'failed');
    expect(failed.items[0]).toMatchObject({ kind: 'ref', state: 'failed' });
  });

  it('找不到对应占位行 → 原样返回（引用相等）', () => {
    const s1 = appendRefPlaceholder(emptySession(), 'e', makeRef());
    expect(resolveRefPlaceholder(s1, 'ffffffff', 'done')).toBe(s1);
    expect(resolveRefPlaceholder(s1, 'ffffffff', 'expired')).toBe(s1);
  });
});

describe('时序语义：占位先到位、全文原位归约、不重排', () => {
  it('tool-result-complete 外溢：占位 → 真 payload 原位更新工具卡 → 摘占位', () => {
    // ① 工具开始（running 卡）
    let s = reduceSseEvent(emptySession(), {
      event: 'chat:tool-use-start',
      payload: { id: 't1', name: 'env_exec', input: { cmd: 'fuzz' } },
    }).session;
    // ② 结果外溢 → 占位行落流尾（不重排：占位在 turn 之后）
    const ref = makeRef();
    s = appendRefPlaceholder(s, 'chat:tool-result-complete', ref);
    expect(s.items.map((i) => i.kind)).toEqual(['turn', 'ref']);
    // ③ 全文取回 → 按原事件名归约：原位更新工具卡 output（不新增/不移动条目）
    s = reduceSseEvent(s, {
      event: 'chat:tool-result-complete',
      payload: { toolUseId: 't1', content: 'FULL OUTPUT', ok: true, exitCode: 0 },
    }).session;
    expect(s.items.map((i) => i.kind)).toEqual(['turn', 'ref']); // 顺序不变
    const turn = s.items[0] as TurnBlock;
    const tool = turn.details[0];
    expect(tool.kind === 'tool' && tool.output).toBe('FULL OUTPUT');
    expect(tool.kind === 'tool' && tool.state).toBe('done');
    // ④ 占位行摘除——流里只剩真事件 UI
    s = resolveRefPlaceholder(s, ref.id, 'done');
    expect(s.items.map((i) => i.kind)).toEqual(['turn']);
  });

  it('GC 后 404：占位转 expired，后续事件照常归约（降级不卡流）', () => {
    let s = reduceSseEvent(emptySession(), {
      event: 'chat:tool-use-start',
      payload: { id: 't1', name: 'env_exec' },
    }).session;
    s = appendRefPlaceholder(s, 'chat:tool-result-complete', makeRef());
    s = resolveRefPlaceholder(s, 'ab12cd34', 'expired');
    expect(s.items[1]).toMatchObject({ kind: 'ref', state: 'expired' });
    // 后续 message-complete 照常落定相位（占位不阻断归约管线）
    s = reduceSseEvent(s, { event: 'chat:message-complete', payload: { sessionState: 'idle' } }).session;
    expect(s.phase).toBe('idle');
    expect(s.items.map((i) => i.kind)).toEqual(['turn', 'ref']);
  });
});
