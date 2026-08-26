/**
 * 越界 ask 展示映射与登记表归约单测（1.3.1 ②）。
 */

import { describe, expect, it } from 'vitest';

import {
  BOUNDARY_KIND_META,
  boundaryAskMeta,
  hasBoundaryAsk,
  removeBoundaryAsk,
  upsertBoundaryAsk,
} from './boundary';

describe('boundaryAskMeta', () => {
  it('四种 kind 都有文案（title/desc/按钮）', () => {
    for (const kind of ['host-write', 'local-cred', 'net-policy', 'destroy-env']) {
      const meta = boundaryAskMeta(kind);
      expect(meta.title.length).toBeGreaterThan(0);
      expect(meta.desc.length).toBeGreaterThan(0);
      expect(meta.approveLabel.length).toBeGreaterThan(0);
    }
  });

  it('未知 kind 回落兜底文案（前向兼容）', () => {
    const meta = boundaryAskMeta('future-kind');
    expect(meta.title).toBe('越界动作待批准');
    expect(BOUNDARY_KIND_META['future-kind']).toBeUndefined();
  });
});

describe('upsertBoundaryAsk / removeBoundaryAsk', () => {
  it('chat:boundary-ask → 登记（幂等 upsert）', () => {
    const a = upsertBoundaryAsk([], { askId: 'ask-1', kind: 'host-write', objects: ['a', 'b'] }, 100);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ askId: 'ask-1', kind: 'host-write', objects: ['a', 'b'], receivedAt: 100 });

    const again = upsertBoundaryAsk(a, { askId: 'ask-1', kind: 'host-write', objects: ['c'] }, 200);
    expect(again).toHaveLength(1); // 不重复登记
    expect(again[0].objects).toEqual(['c']);
    expect(again[0].receivedAt).toBe(200);
  });

  it('缺 askId / 非字符串对象 → 忽略', () => {
    expect(upsertBoundaryAsk([], { kind: 'host-write' })).toEqual([]);
    expect(upsertBoundaryAsk([], { askId: 'x', objects: [1, 'a', null] })[0].objects).toEqual(['a']);
  });

  it('expired / 应答后移除（按 askId，幂等）', () => {
    const list = upsertBoundaryAsk([], { askId: 'ask-1', kind: 'host-write' });
    expect(removeBoundaryAsk(list, 'ask-1')).toEqual([]);
    expect(removeBoundaryAsk(list, 'ask-9')).toEqual(list);
    expect(removeBoundaryAsk(list, undefined)).toEqual(list);
  });

  it('hasBoundaryAsk 守卫', () => {
    const list = upsertBoundaryAsk([], { askId: 'ask-1', kind: 'host-write' });
    expect(hasBoundaryAsk(list, 'ask-1')).toBe(true);
    expect(hasBoundaryAsk(list, 'ask-2')).toBe(false);
  });
});
