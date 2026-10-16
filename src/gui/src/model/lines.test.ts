/**
 * lines.test.ts — 1.8.7 P3b 研究线面板纯函数层单测（B6/B7）。
 *
 * 覆盖：parseLineList 窄化（坏载荷/缺字段行静默丢弃）、状态推导三态
 * （live+busy=running / live=idle / 非 live=cold）、归属段标签
 * （shared→「共享」/ legacy→「旧」/ 其余=owner 名）、share/unshare 动作
 * 可用性（canShare=!shared / canUnshare=shared）、formatLineUpdated
 * （今天 HH:MM / 跨天 M-D / 无法解析空串）、shortLineId 截断。
 */

import { describe, expect, it } from 'vitest';

import {
  buildLineRows,
  formatLineUpdated,
  parseLineList,
  shortLineId,
  type LineEntry,
} from './lines';

const BASE: LineEntry = {
  loopSessionId: '11111111-2222-3333-4444-555555555555',
  envKey: 'env:pwn-vm',
  segment: 'alice',
  owner: 'alice',
  shared: false,
  live: true,
  busy: true,
  active: true,
  updatedAt: '2026-10-16T08:30:00.000Z',
};

function payloadOf(lines: unknown[]): unknown {
  return { workspace: 'E:/code/ws', activeLoopSessionId: BASE.loopSessionId, lines };
}

describe('parseLineList（line/list data 窄化）', () => {
  it('坏载荷整体返回空数组（不抛）', () => {
    expect(parseLineList(null)).toEqual([]);
    expect(parseLineList('nope')).toEqual([]);
    expect(parseLineList(42)).toEqual([]);
    expect(parseLineList([BASE])).toEqual([]);
    expect(parseLineList({})).toEqual([]);
    expect(parseLineList({ lines: 'not-array' })).toEqual([]);
  });

  it('完整行解析（九字段全）', () => {
    const [e] = parseLineList(payloadOf([BASE]));
    expect(e).toEqual(BASE);
  });

  it('缺 loopSessionId / envKey 的行丢弃；缺省字段回落', () => {
    const lines = parseLineList(
      payloadOf([
        { envKey: 'env:x' }, // 无 loopSessionId
        { loopSessionId: 'a' }, // 无 envKey
        { loopSessionId: 'b', envKey: 'env:y' }, // 其余字段缺省
      ]),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      loopSessionId: 'b',
      envKey: 'env:y',
      segment: 'legacy',
      owner: null,
      shared: false,
      live: false,
      busy: false,
      active: false,
      updatedAt: undefined,
    });
  });

  it('非对象行（null / 字符串 / 数组）静默丢弃', () => {
    const lines = parseLineList(payloadOf([null, 'x', [BASE], BASE]));
    expect(lines.map((e) => e.loopSessionId)).toEqual([BASE.loopSessionId]);
  });
});

describe('buildLineRows 状态推导三态', () => {
  it('live+busy → running；live → idle；非 live → cold（busy 不翻盘）', () => {
    const rows = buildLineRows(
      [
        { ...BASE, busy: true, active: false },
        { ...BASE, busy: false, active: false },
        { ...BASE, live: false, busy: true, active: false },
      ],
      { actorName: null },
    );
    expect(rows.map((r) => r.stateDot)).toEqual(['running', 'idle', 'cold']);
  });
});

describe('buildLineRows 归属段标签', () => {
  it('segment=shared → 「共享」；legacy → 「旧」；其余 = owner 名', () => {
    const rows = buildLineRows(
      [
        { ...BASE, segment: 'shared', shared: true, active: false },
        { ...BASE, segment: 'legacy', owner: null, active: false },
        { ...BASE, segment: 'alice', owner: 'alice', active: false },
      ],
      { actorName: null },
    );
    expect(rows.map((r) => r.segLabel)).toEqual(['共享', '旧', 'alice']);
  });

  it('ownerLabel：shared → 「共享」；owner=调用方 → 「我」；他人 → owner 名；归属未知 → 「旧」', () => {
    const rows = buildLineRows(
      [
        { ...BASE, segment: 'shared', shared: true, active: false },
        { ...BASE, segment: 'alice', owner: 'alice', active: false },
        { ...BASE, segment: 'bob', owner: 'bob', active: false },
        { ...BASE, segment: 'legacy', owner: null, active: false },
      ],
      { actorName: 'alice' },
    );
    expect(rows.map((r) => r.ownerLabel)).toEqual(['共享', '我', 'bob', '旧']);
  });
});

describe('buildLineRows 动作可用性与展示字段', () => {
  it('canShare = !shared；canUnshare = shared（二者互斥；权限细化交给服务端 403）', () => {
    const [priv, shared] = buildLineRows(
      [
        { ...BASE, active: false },
        { ...BASE, segment: 'shared', shared: true, active: false },
      ],
      { actorName: null },
    );
    expect(priv.canShare).toBe(true);
    expect(priv.canUnshare).toBe(false);
    expect(shared.canShare).toBe(false);
    expect(shared.canUnshare).toBe(true);
  });

  it('id/envKey/active 透传；updatedLabel 走 formatLineUpdated', () => {
    // ts 取真实当天（本地时区构造）,避免跨零点跑测试时「今天/非今天」翻转。
    const d = new Date();
    d.setHours(8, 30, 0, 0);
    const ts = d.toISOString();
    const [row] = buildLineRows([{ ...BASE, updatedAt: ts }], { actorName: null });
    expect(row.id).toBe(BASE.loopSessionId);
    expect(row.envKey).toBe('env:pwn-vm');
    expect(row.active).toBe(true);
    expect(row.updatedLabel).toBe(formatLineUpdated(ts));
  });
});

describe('formatLineUpdated', () => {
  const now = Date.parse('2026-10-16T20:00:00');

  it('今天 → HH:MM（本地时区,零填充）', () => {
    const d = new Date(now);
    d.setHours(9, 5, 0, 0);
    expect(formatLineUpdated(d.toISOString(), now)).toBe(
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    );
  });

  it('非今天 → M-D（不补零）', () => {
    expect(formatLineUpdated('2026-10-15T23:59:59', now)).toBe('10-15');
    expect(formatLineUpdated('2026-03-08T10:00:00', now)).toBe('3-8');
  });

  it('空串 / 非法时间 → 空串', () => {
    expect(formatLineUpdated(undefined, now)).toBe('');
    expect(formatLineUpdated('not-a-date', now)).toBe('');
  });
});

describe('shortLineId', () => {
  it('8 字短线 id（loopSessionId 是全 UUID,展示/回执只取前 8 字）', () => {
    expect(shortLineId('11111111-2222-3333-4444-555555555555')).toBe('11111111');
    expect(shortLineId('abc')).toBe('abc');
  });
});
