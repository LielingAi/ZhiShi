/**
 * bg-reap unit tests（Phase 3）— 回收编排四态 + 容错语义。
 * 注入依赖测：registry/reap/findEnv/onFinished 全部假实现，绝不真连环境。
 */

import { describe, expect, it } from 'vitest';

import type { EnvironmentEntry } from '../../shared/config-types';
import { reapAllBgProcesses } from './bg-reap';
import type { BgRegistryEntry } from './bg-registry';

const ENV: EnvironmentEntry = { id: 'pwn-vm', kind: 'ssh', host: '10.0.0.9', createdAt: '' };

function entry(tag: string, pid = 1): BgRegistryEntry {
  return { tag, pid, envId: 'pwn-vm', startedAt: Date.now(), commandPreview: `cmd-${tag}` };
}

interface Harness {
  entries: Map<string, BgRegistryEntry>;
  finished: Array<{ tag: string; status: 'killed' | 'dead' }>;
  warns: string[];
  logs: string[];
  /** envBgReap 替身逐 tag 的返回;缺省 reaped。 */
  reapOutcomes: Map<string, { ok: true; outcome: string } | { ok: false; error: string }>;
  findEnvResult: (envId: string) => EnvironmentEntry | null;
  run: () => ReturnType<typeof reapAllBgProcesses>;
}

function makeHarness(initial: BgRegistryEntry[]): Harness {
  const entries = new Map(initial.map((e) => [e.tag, e]));
  const reapOutcomes = new Map<string, { ok: true; outcome: string } | { ok: false; error: string }>();
  const finished: Array<{ tag: string; status: 'killed' | 'dead' }> = [];
  const warns: string[] = [];
  const logs: string[] = [];
  const h: Harness = {
    entries,
    finished,
    warns,
    logs,
    reapOutcomes,
    findEnvResult: (_envId: string): EnvironmentEntry | null => ENV,
    run: () => reapAllBgProcesses({
      registry: {
        list: () => [...entries.values()],
        remove: (tag) => { entries.delete(tag); },
      },
      // 经 h.findEnvResult 间接调用——测试可原地覆写该属性。
      findEnv: (envId) => h.findEnvResult(envId),
      reap: async (_env, tag, _pid) => reapOutcomes.get(tag) ?? { ok: true, outcome: `reaped:${_pid}` },
      onFinished: (tag, status) => finished.push({ tag, status }),
      onWarn: (m) => warns.push(m),
      onLog: (m) => logs.push(m),
    }),
  };
  return h;
}

describe('reapAllBgProcesses', () => {
  it('空登记 → 零动作零广播', async () => {
    const h = makeHarness([]);
    expect(await h.run()).toEqual({ killed: 0, kept: 0, dropped: 0 });
    expect(h.finished).toEqual([]);
  });

  it('杀成功(reaped)→ 清登记 + 广播 finished(killed)', async () => {
    const h = makeHarness([entry('a', 11), entry('b', 22)]);
    h.reapOutcomes.set('a', { ok: true, outcome: 'reaped:11' });
    h.reapOutcomes.set('b', { ok: true, outcome: 'reaped:22' });
    expect(await h.run()).toEqual({ killed: 2, kept: 0, dropped: 0 });
    expect(h.entries.size).toBe(0);
    expect(h.finished).toEqual([
      { tag: 'a', status: 'killed' },
      { tag: 'b', status: 'killed' },
    ]);
  });

  it('.pid 对不上(pid-mismatch)→ 不杀,清登记 + 广播 finished(dead)', async () => {
    const h = makeHarness([entry('stale', 99)]);
    h.reapOutcomes.set('stale', { ok: true, outcome: 'pid-mismatch' });
    expect(await h.run()).toEqual({ killed: 0, kept: 0, dropped: 1 });
    expect(h.entries.size).toBe(0);
    expect(h.finished).toEqual([{ tag: 'stale', status: 'dead' }]);
  });

  it('通道失败 → 登记保留(下轮再试),不广播 finished,不误报已杀', async () => {
    const h = makeHarness([entry('down', 5)]);
    h.reapOutcomes.set('down', { ok: false, error: 'ssh: connect timed out' });
    expect(await h.run()).toEqual({ killed: 0, kept: 1, dropped: 0 });
    expect(h.entries.has('down')).toBe(true);
    expect(h.finished).toEqual([]);
    expect(h.warns).toHaveLength(1);
  });

  it('reap 替身抛异常 → 按通道失败同样保守处理(永不 throw)', async () => {
    const h = makeHarness([entry('boom', 6)]);
    const summary = await reapAllBgProcesses({
      registry: { list: () => [entry('boom', 6)], remove: () => {} },
      findEnv: () => ENV,
      reap: async () => { throw new Error('spawn ENOENT'); },
      onFinished: (tag, status) => h.finished.push({ tag, status }),
      onWarn: (m) => h.warns.push(m),
    });
    expect(summary).toEqual({ killed: 0, kept: 1, dropped: 0 });
    expect(h.finished).toEqual([]);
    expect(h.warns[0]).toContain('spawn ENOENT');
  });

  it('环境条目已删(findEnv→null)→ 够不到,清登记 + 告警,不广播', async () => {
    const h = makeHarness([entry('ghost', 3)]);
    h.findEnvResult = () => null;
    expect(await h.run()).toEqual({ killed: 0, kept: 0, dropped: 1 });
    expect(h.entries.size).toBe(0);
    expect(h.finished).toEqual([]);
    expect(h.warns[0]).toContain('已不存在');
  });

  it('遍历的是 list() 快照:迭代中 remove 不影响本次遍历', async () => {
    const h = makeHarness([entry('a', 1), entry('b', 2), entry('c', 3)]);
    expect(await h.run()).toEqual({ killed: 3, kept: 0, dropped: 0 });
    expect(h.finished.map((f) => f.tag)).toEqual(['a', 'b', 'c']);
  });
});
