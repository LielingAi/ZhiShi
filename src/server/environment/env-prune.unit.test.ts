/**
 * 2.0-M1：僵尸清理候选选择器单测（纯函数——handler 只做世界状态采样）。
 */

import { describe, expect, it } from 'vitest';

import { selectPruneCandidates, type PruneInputs } from './env-prune';

const env = (id: string, kind = 'docker', extra: Record<string, string> = {}) => ({
  id,
  kind,
  name: id,
  ...extra,
});

function inputs(over: Partial<PruneInputs> = {}): PruneInputs {
  return {
    entries: [env('a', 'docker', { container: 'ca' }), env('v', 'vm', { vmName: 'vm1' })],
    usedEnvRefs: new Set(),
    activeRunEnvs: new Set(),
    occupiedIds: new Set(),
    probe: { a: 'stopped', v: 'stopped' },
    ...over,
  };
}

describe('selectPruneCandidates（fail-closed 口径）', () => {
  it('停止 + 零使用 + 非占用 + 探活确认 → 候选', () => {
    const out = selectPruneCandidates(inputs(), 'local');
    expect(out.map((c) => c.id)).toEqual(['a', 'v']);
    expect(out[0].reason).toContain('无使用痕迹');
  });

  it('内置本机 / ssh / local → 排除（ssh 探活成本高保守不列）', () => {
    const out = selectPruneCandidates(
      inputs({
        entries: [env('local', 'local'), env('h', 'ssh'), env('l', 'local')],
        probe: { local: 'stopped', h: 'stopped', l: 'stopped' },
      }),
      'local',
    );
    expect(out).toEqual([]);
  });

  it('有分线映射 / 活跃 auto-run / 占用中 → 排除（在用不是僵尸）', () => {
    const out = selectPruneCandidates(
      inputs({
        usedEnvRefs: new Set(['env:a']),
        activeRunEnvs: new Set(['env:v']),
      }),
      'local',
    );
    expect(out).toEqual([]);

    const out2 = selectPruneCandidates(
      inputs({ occupiedIds: new Set(['a', 'v']) }),
      'local',
    );
    expect(out2).toEqual([]);
  });

  it('探活 running → 排除；unknown（探测失败）→ fail-closed 排除', () => {
    const out = selectPruneCandidates(
      inputs({ probe: { a: 'running', v: 'unknown' } }),
      'local',
    );
    expect(out).toEqual([]);
    // 缺省也没有探活结果 → unknown → 排除
    const out2 = selectPruneCandidates(inputs({ probe: {} }), 'local');
    expect(out2).toEqual([]);
  });
});
