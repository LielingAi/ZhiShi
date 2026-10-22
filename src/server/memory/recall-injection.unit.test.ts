/**
 * 2.0.7 — 注入记账单测（recall-injection.ts）。
 *
 * 背景：`logRecallEvents` 此前只有手工检索一个调用点，注入不记账 → judge 无素材。
 * 本模块负责"注入了什么"的记账，这里锁住它的纪律：冷却期去重、单次上限、
 * best-effort（记账失败不影响流程）。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  INJECTION_RECALL_COOLDOWN_MS,
  INJECTION_RECALL_MAX_PER_CALL,
  noteInjectedMemory,
  resetInjectionRecallForTests,
} from './recall-injection';

beforeEach(() => {
  resetInjectionRecallForTests();
});

describe('noteInjectedMemory（注入即记账）', () => {
  it('首次注入：按 id 记账并带上当轮查询词', () => {
    const calls: Array<{ ids: string[]; query: string }> = [];
    const n = noteInjectedMemory(['m1', 'm2'], ' 查一下 CVE-2024-4577 ', {
      now: 1000,
      log: (ids, query) => calls.push({ ids: [...ids], query: String(query) }),
    });
    expect(n).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ids).toEqual(['m1', 'm2']);
    expect(calls[0]!.query).toContain('CVE-2024-4577');
  });

  it('冷却期内重复注入同一条 → 不重复记账；冷却后恢复', () => {
    const calls: string[][] = [];
    const log = (ids: string[]) => calls.push([...ids]);
    expect(noteInjectedMemory(['m1'], 'q', { now: 1000, log })).toBe(1);
    expect(noteInjectedMemory(['m1'], 'q', { now: 1000 + 1000, log })).toBe(0);
    expect(noteInjectedMemory(['m1'], 'q', { now: 1000 + INJECTION_RECALL_COOLDOWN_MS + 1, log })).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('部分命中冷却：只有新鲜的进账', () => {
    const calls: string[][] = [];
    const log = (ids: string[]) => calls.push([...ids]);
    noteInjectedMemory(['m1'], 'q', { now: 1000, log });
    const n = noteInjectedMemory(['m1', 'm2'], 'q', { now: 2000, log });
    expect(n).toBe(1);
    expect(calls[1]).toEqual(['m2']);
  });

  it('单次上限 + 去重 + 空 id 过滤', () => {
    const ids = ['', 'm1', 'm1', ...Array.from({ length: 20 }, (_, i) => `x${i}`)];
    const calls: string[][] = [];
    const n = noteInjectedMemory(ids, 'q', { now: 1000, log: (got) => calls.push([...got]) });
    expect(n).toBe(INJECTION_RECALL_MAX_PER_CALL);
    expect(calls[0]![0]).toBe('m1');
    expect(new Set(calls[0]!).size).toBe(calls[0]!.length);
  });

  it('超上限时轮转：下一轮把没轮上的补进来（尾巴不被饿死）', () => {
    const ids = Array.from({ length: 11 }, (_, i) => `m${i}`);
    const rounds: string[][] = [];
    const log = (got: string[]) => rounds.push([...got]);
    noteInjectedMemory(ids, 'q', { now: 1000, log });
    noteInjectedMemory(ids, 'q', { now: 2000, log });
    expect(rounds[0]).toHaveLength(8);
    expect(rounds[1]).toHaveLength(3); // 剩下 3 条补上
    expect(new Set([...rounds[0]!, ...rounds[1]!]).size).toBe(11); // 全覆盖，无重复
  });

  it('记账抛错不影响调用方（best-effort）', () => {
    const n = noteInjectedMemory(['m1'], 'q', {
      now: 1000,
      log: () => { throw new Error('db locked'); },
    });
    expect(n).toBe(1); // 已判定为"记过了"，异常被吞
  });

  it('全空 ids → 0，且不触发写入', () => {
    let called = false;
    expect(noteInjectedMemory([], 'q', { log: () => { called = true; } })).toBe(0);
    expect(called).toBe(false);
  });
});
