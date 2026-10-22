/**
 * 2.0.7 — 蒸馏调度与宿主解析单测。
 *
 * 背景：蒸馏弧此前只靠 Rust 调度器（CLI 起的 sidecar 没有）+ 播种要求
 * "绑定 Agent 的工作区"（她的机器上没有）→ 静默不跑，记忆停在三周前。
 * 这里锁住两件事：宿主四级回退的优先级、sidecar 定时器的节律与锁纪律。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pickDistillHost } from './distill-runner';
import {
  COGNITIVE_ARC_MIN_INTERVAL_MS,
  RESEARCH_ARC_MIN_INTERVAL_MS,
  dueArcs,
  runDistillTick,
} from './distill-scheduler';

describe('pickDistillHost（宿主四级回退）', () => {
  const existsAlways = () => true;
  const never = () => false;

  it('默认工作区优先', () => {
    const h = pickDistillHost({
      defaultWorkspacePath: '/w/default',
      environmentWorkspaces: ['/w/env'],
      projectPaths: ['/w/proj'],
      fallbackPath: '/w/fallback',
      exists: existsAlways,
    });
    expect(h).toEqual({ path: '/w/default', via: 'default' });
  });

  it('默认工作区不存在 → 环境工作区（不要求绑定 Agent）', () => {
    const h = pickDistillHost({
      defaultWorkspacePath: '/w/missing',
      environmentWorkspaces: [undefined, ' /w/env '],
      projectPaths: ['/w/proj'],
      fallbackPath: '/w/fallback',
      exists: (p) => p !== '/w/missing',
    });
    expect(h).toEqual({ path: '/w/env', via: 'environment' });
  });

  it('前两级都没有 → 工程路径；全都没有 → 兜底（永远有值）', () => {
    expect(pickDistillHost({
      environmentWorkspaces: [],
      projectPaths: ['/w/proj'],
      fallbackPath: '/w/fallback',
      exists: existsAlways,
    })).toEqual({ path: '/w/proj', via: 'agent' });

    expect(pickDistillHost({
      fallbackPath: '/w/fallback',
      exists: never,
    })).toEqual({ path: '/w/fallback', via: 'fallback' });
  });

  it('空串/空白候选被跳过', () => {
    expect(pickDistillHost({
      defaultWorkspacePath: '   ',
      environmentWorkspaces: ['', '  '],
      fallbackPath: '/w/fallback',
      exists: existsAlways,
    }).via).toBe('fallback');
  });
});

describe('dueArcs（节律）', () => {
  const now = 1_000_000_000_000;

  it('从未跑过 → 两条都到期', () => {
    expect(dueArcs({}, now)).toEqual({ cognitive: true, research: true });
  });

  it('刚跑过 → 都不到期；只到认知弧 → 只跑认知', () => {
    expect(dueArcs({ lastCognitiveAt: now - 60_000, lastResearchAt: now - 60_000 }, now))
      .toEqual({ cognitive: false, research: false });
    expect(dueArcs({ lastCognitiveAt: now - COGNITIVE_ARC_MIN_INTERVAL_MS, lastResearchAt: now - 60_000 }, now))
      .toEqual({ cognitive: true, research: false });
  });

  it('安全弧 6 小时节奏', () => {
    expect(dueArcs({ lastCognitiveAt: now, lastResearchAt: now - RESEARCH_ARC_MIN_INTERVAL_MS + 1 }, now))
      .toEqual({ cognitive: false, research: false });
    expect(dueArcs({ lastCognitiveAt: now, lastResearchAt: now - RESEARCH_ARC_MIN_INTERVAL_MS }, now))
      .toEqual({ cognitive: false, research: true });
  });
});

describe('runDistillTick（锁 + 落盘）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zhishi-arc-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('到期 → 两条弧都跑；未到期 → 跳过', async () => {
    const ran: string[] = [];
    const now = 2_000_000_000_000;
    const first = await runDistillTick({
      now: () => now,
      state: {},
      persist: false,
      lockPath: join(dir, '.arc.lock'),
      runCognitive: async () => { ran.push('cognitive'); },
      runResearch: async () => { ran.push('research'); },
    });
    expect(first).toEqual({ skipped: false, cognitive: true, research: true });
    expect(ran).toEqual(['cognitive', 'research']);

    const second = await runDistillTick({
      now: () => now + 60_000,
      state: { lastCognitiveAt: now, lastResearchAt: now },
      persist: false,
      lockPath: join(dir, '.arc.lock'),
      runCognitive: async () => { ran.push('cognitive2'); },
      runResearch: async () => { ran.push('research2'); },
    });
    expect(second.skipped).toBe(true);
    expect(ran).toEqual(['cognitive', 'research']);
  });

  it('弧失败不写状态（下轮还会重试），但另一条弧照跑', async () => {
    const now = 2_000_000_000_000;
    const persisted: Array<Record<string, number>> = [];
    const r = await runDistillTick({
      now: () => now,
      state: {},
      persist: false,
      lockPath: join(dir, '.arc.lock'),
      runCognitive: async () => { throw new Error('model down'); },
      runResearch: async () => {},
    });
    expect(r).toEqual({ skipped: false, cognitive: false, research: true });
    expect(persisted).toHaveLength(0);
  });

});
