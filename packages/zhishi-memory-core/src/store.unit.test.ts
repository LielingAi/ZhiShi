// Unit tests for the memory store (宪章 §7.1/§7.2 存储层).
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  contentKey,
  effectiveScore,
  findByContent,
  listActive,
  listUnsettledRecalls,
  listWrongMemories,
  logRecallEvents,
  putEntry,
  recencyDecay,
  resetMemoryStoreForTest,
  searchEntries,
  settleRecallEvent,
  touchEntry,
} from './store';

let dir: string;
const NOW = Date.parse('2026-07-31T12:00:00Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-memstore-'));
  resetMemoryStoreForTest();
});

afterEach(() => {
  // SQLite（WAL）持有文件锁——先关句柄再删目录，否则 Windows EBUSY。
  resetMemoryStoreForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('recencyDecay / effectiveScore', () => {
  it('半衰期整倍数处衰减为 0.5 的幂', () => {
    const t0 = NOW - 14 * 86_400_000;
    expect(recencyDecay(t0, 14, NOW)).toBeCloseTo(0.5, 5);
    expect(recencyDecay(NOW, 14, NOW)).toBe(1);
  });

  it('有效分 = salience × decay × usefulness', () => {
    const e = {
      id: 'x', kind: 'reminder' as const, content: 'c', createdAt: NOW, lastTouchedAt: NOW,
      salience: 0.8, usefulness: 2,
    };
    expect(effectiveScore(e, NOW)).toBeCloseTo(1.6, 5);
  });
});

describe('putEntry / listActive', () => {
  it('写入并按有效分排序', () => {
    putEntry({ kind: 'reminder', content: 'b', salience: 0.4 }, dir, NOW);
    putEntry({ kind: 'reminder', content: 'a', salience: 0.9 }, dir, NOW);
    const list = listActive('reminder', dir, NOW);
    expect(list.map((e) => e.content)).toEqual(['a', 'b']);
  });

  it('同 contentKey 合并而非新增（touch + salience 取高）', () => {
    putEntry({ kind: 'reminder', content: '同一件事', salience: 0.4 }, dir, NOW - 1000);
    putEntry({ kind: 'reminder', content: '  同一件事 ', salience: 0.6 }, dir, NOW);
    const list = listActive('reminder', dir, NOW);
    expect(list).toHaveLength(1);
    expect(list[0].salience).toBe(0.6);
    expect(list[0].lastTouchedAt).toBe(NOW);
  });

  it('过期条目不出现（§7.3 红线）', () => {
    putEntry({ kind: 'reminder', content: '已过期', expiresAt: NOW - 1 }, dir, NOW - 1000);
    putEntry({ kind: 'reminder', content: '长期', salience: 0.5 }, dir, NOW);
    const list = listActive('reminder', dir, NOW);
    expect(list.map((e) => e.content)).toEqual(['长期']);
  });

  it('超 kind 上限挤掉最低分并进 archive（残差守恒）', () => {
    for (let i = 0; i < 65; i++) {
      putEntry({ kind: 'reminder', content: `r${i}`, salience: i / 100 }, dir, NOW + i);
    }
    const list = listActive('reminder', dir, NOW + 100);
    expect(list.length).toBe(60);
  });

  it('持久化：重开后状态仍在', () => {
    putEntry({ kind: 'self-model', content: '我在金蝶上栽过' }, dir, NOW);
    resetMemoryStoreForTest();
    const list = listActive('self-model', dir, NOW);
    expect(list).toHaveLength(1);
  });
});

describe('touchEntry / findByContent / searchEntries', () => {
  it('touch 刷新 lastTouched 并调整 usefulness/salience', () => {
    const e = putEntry({ kind: 'reminder', content: 'x', salience: 0.5 }, dir, NOW - 1000);
    touchEntry(e.id, { usefulnessDelta: 0.5, salienceDelta: 0.1 }, dir, NOW);
    const after = listActive('reminder', dir, NOW)[0];
    expect(after.lastTouchedAt).toBe(NOW);
    expect(after.usefulness).toBeCloseTo(1.5, 5);
    expect(after.salience).toBeCloseTo(0.6, 5);
  });

  it('findByContent 用归一化内容键定位', () => {
    putEntry({ kind: 'reminder', content: '报表要先核数' }, dir, NOW);
    expect(findByContent('reminder', '  报表要先核数 ', dir)?.content).toBe('报表要先核数');
  });

  it('searchEntries 支持 kind 过滤 + 来源匹配', () => {
    putEntry({ kind: 'reminder', content: '月底要交报表', source: '任务《月度报表》' }, dir, NOW);
    putEntry({ kind: 'routines', content: '每周一 09:00 周报' }, dir, NOW);
    expect(searchEntries('报表', {}, dir, NOW)).toHaveLength(1);
    expect(searchEntries('月度报表', {}, dir, NOW)[0].content).toBe('月底要交报表');
    expect(searchEntries('', { kinds: ['routines'] }, dir, NOW)).toHaveLength(1);
  });

  it('contentKey 归一化（大小写/空白/截断）', () => {
    expect(contentKey('  A  B\tC ')).toBe('a b c');
  });
});


describe('土匪回路：logRecallEvents / listUnsettledRecalls / settleRecallEvent / listWrongMemories', () => {
  const GRACE = 15 * 60_000;

  it('命中落日志；宽限期内不结算，过期后出现且带记忆内容', () => {
    const e = putEntry({ kind: 'reminder', content: '报价先核库存', salience: 0.5 }, dir, NOW - 3600_000);
    logRecallEvents([e.id], '报价', dir, NOW - GRACE - 1000);
    logRecallEvents([e.id], '报价', dir, NOW); // 这条还在宽限期内
    const pending = listUnsettledRecalls(GRACE, 20, dir, NOW);
    expect(pending).toHaveLength(1);
    expect(pending[0].memoryId).toBe(e.id);
    expect(pending[0].memoryContent).toBe('报价先核库存');
    expect(pending[0].query).toBe('报价');
  });

  it('effective：弱正（usefulness +0.2）且事件结算不再出现', () => {
    const e = putEntry({ kind: 'reminder', content: 'x', salience: 0.5 }, dir, NOW - 3600_000);
    logRecallEvents([e.id], 'q', dir, NOW - GRACE - 1000);
    const [ev] = listUnsettledRecalls(GRACE, 20, dir, NOW);
    settleRecallEvent(ev.id, 'effective', dir, NOW);
    expect(listActive('reminder', dir, NOW)[0].usefulness).toBeCloseTo(1.2, 5);
    expect(listUnsettledRecalls(GRACE, 20, dir, NOW)).toHaveLength(0);
  });

  it('wrong：重罚（usefulness -1.0 / salience -0.2）并进错记忆史', () => {
    const e = putEntry({ kind: 'reminder', content: '用户喜欢甜口', salience: 0.5 }, dir, NOW - 3600_000);
    logRecallEvents([e.id], '口味', dir, NOW - GRACE - 1000);
    const [ev] = listUnsettledRecalls(GRACE, 20, dir, NOW);
    settleRecallEvent(ev.id, 'wrong', dir, NOW);
    const after = listActive('reminder', dir, NOW)[0];
    expect(after.usefulness).toBeCloseTo(0.2, 5); // 1 - 1.0 触底 clamp 0.2
    expect(after.salience).toBeCloseTo(0.3, 5);
    const wrong = listWrongMemories(8, dir);
    expect(wrong).toHaveLength(1);
    expect(wrong[0].content).toBe('用户喜欢甜口');
  });

  it('unused：不动分（时间衰减自会收拾它）', () => {
    const e = putEntry({ kind: 'reminder', content: 'x', salience: 0.5 }, dir, NOW - 3600_000);
    logRecallEvents([e.id], 'q', dir, NOW - GRACE - 1000);
    const [ev] = listUnsettledRecalls(GRACE, 20, dir, NOW);
    settleRecallEvent(ev.id, 'unused', dir, NOW);
    const after = listActive('reminder', dir, NOW)[0];
    expect(after.usefulness).toBeCloseTo(1, 5);
    expect(after.salience).toBeCloseTo(0.5, 5);
    expect(after.lastTouchedAt).toBe(NOW - 3600_000); // 未刷新——衰减继续
  });

  it('重复结算幂等：已结算事件第二次 settle 不再动分', () => {
    const e = putEntry({ kind: 'reminder', content: 'x', salience: 0.5 }, dir, NOW - 3600_000);
    logRecallEvents([e.id], 'q', dir, NOW - GRACE - 1000);
    const [ev] = listUnsettledRecalls(GRACE, 20, dir, NOW);
    settleRecallEvent(ev.id, 'effective', dir, NOW);
    settleRecallEvent(ev.id, 'wrong', dir, NOW); // 应被忽略
    expect(listActive('reminder', dir, NOW)[0].usefulness).toBeCloseTo(1.2, 5);
  });

  it('错记忆史按记忆去重、最新在前，且能读到已归档记忆的内容', () => {
    const a = putEntry({ kind: 'reminder', content: '错记忆A', salience: 0.5 }, dir, NOW - 7200_000);
    const b = putEntry({ kind: 'reminder', content: '错记忆B', salience: 0.5 }, dir, NOW - 7200_000);
    for (const [id, t] of [[a.id, 3000], [a.id, 2000], [b.id, 1000]] as Array<[string, number]>) {
      logRecallEvents([id], 'q', dir, NOW - GRACE - t);
    }
    for (const ev of listUnsettledRecalls(GRACE, 20, dir, NOW)) {
      settleRecallEvent(ev.id, 'wrong', dir, NOW);
    }
    const wrong = listWrongMemories(8, dir);
    expect(wrong.map((w) => w.content)).toEqual(['错记忆B', '错记忆A']); // B 的末次判错更新；A 两次事件去重成一条
  });

  it('skipDelta：同一记忆同 tick 只结一次账（一次错误=一次结算）', () => {
    const e = putEntry({ kind: 'reminder', content: 'x', salience: 0.5 }, dir, NOW - 3600_000);
    logRecallEvents([e.id], 'q1', dir, NOW - GRACE - 2000);
    logRecallEvents([e.id], 'q2', dir, NOW - GRACE - 1000);
    const [ev1, ev2] = listUnsettledRecalls(GRACE, 20, dir, NOW);
    settleRecallEvent(ev1.id, 'wrong', dir, NOW);
    settleRecallEvent(ev2.id, 'wrong', dir, NOW, true); // 已结过账 → 只记 outcome
    const after = listActive('reminder', dir, NOW)[0];
    expect(after.usefulness).toBeCloseTo(0.2, 5); // 只罚了一次（1 - 1.0 触底）
    expect(after.salience).toBeCloseTo(0.3, 5);   // 0.5 - 0.2 只扣一次
    expect(listUnsettledRecalls(GRACE, 20, dir, NOW)).toHaveLength(0);
  });
});
