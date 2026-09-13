/**
 * 1.7.3 — research-filter.ts 单测（记录筛选组合）。
 */
import { describe, expect, it } from 'vitest';

import { filterResearchEvents, type ResearchEventLike } from './research-filter';

const events: ResearchEventLike[] = [
  { id: 1, taskKind: 'binary', outcome: 'success', summary: 'ret2win 打通拿 flag', bugClass: 'stack-overflow' },
  { id: 2, taskKind: 'binary', outcome: 'stuck', summary: 'QEMU UAF 利用受阻', bugClass: 'uaf' },
  { id: 3, taskKind: 'pentest', outcome: 'success', summary: 'SMB 横向拿到 shell', bugClass: undefined },
  { id: 4, taskKind: 'whitebox', outcome: 'fail', summary: 'sink 排查误报', bugClass: undefined },
];

describe('filterResearchEvents（taskKind × outcome × query 组合）', () => {
  it('空筛选 → 原样', () => {
    expect(filterResearchEvents(events, {})).toEqual(events);
  });

  it('taskKind 单选', () => {
    expect(filterResearchEvents(events, { taskKind: 'binary' }).map((e) => e.id)).toEqual([1, 2]);
  });

  it('outcome 单选', () => {
    expect(filterResearchEvents(events, { outcome: 'stuck' }).map((e) => e.id)).toEqual([2]);
  });

  it('组合 → 交集', () => {
    expect(filterResearchEvents(events, { taskKind: 'binary', outcome: 'success' }).map((e) => e.id)).toEqual([1]);
  });

  it('query 命中 summary 与 bugClass（大小写不敏感）', () => {
    expect(filterResearchEvents(events, { query: 'flag' }).map((e) => e.id)).toEqual([1]);
    expect(filterResearchEvents(events, { query: 'UAF' }).map((e) => e.id)).toEqual([2]);
    expect(filterResearchEvents(events, { query: '不存在的关键词' })).toEqual([]);
  });
});
