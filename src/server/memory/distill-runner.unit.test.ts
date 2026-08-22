/**
 * M1 — distill-runner 替换点行为测试（SDK query → pi one-shot）。
 *
 * runDistillLlmCall 是四条蒸馏路径（蒸馏弧/话题弧/土匪 judge/research
 * 蒸馏）共用的唯一 LLM 出口。mock loop/one-shot（网络出口）与
 * loop/pi-provider（解析层），断言：成功返回原文、失败/异常返回 null、
 * providerEnv 缺省回落 config 解析、system prompt 透传。
 * agent-session  mock 掉避免重模块加载。
 */
import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';

const oneShotMock = vi.fn();
const resolveLoopModelFromEnvMock = vi.fn();
const resolveLoopModelMock = vi.fn();

vi.mock('../loop/one-shot', () => ({
  oneShot: (...args: unknown[]) => oneShotMock(...args),
}));
vi.mock('../loop/pi-provider', () => ({
  resolveLoopModelFromEnv: (...args: unknown[]) => resolveLoopModelFromEnvMock(...args),
  resolveLoopModel: (...args: unknown[]) => resolveLoopModelMock(...args),
}));
vi.mock('../agent-session', () => ({
  getSessionModel: () => 'session-model',
  getSessionProviderEnv: () => undefined,
}));

import { runDistillLlmCall } from './distill-runner';

const RESOLUTION = {
  model: { id: 'k3' },
  models: {},
  getApiKey: () => 'fake-key',
  providerId: 'moonshot-coding',
  modelId: 'k3',
};

beforeEach(() => {
  oneShotMock.mockReset();
  resolveLoopModelFromEnvMock.mockReset().mockReturnValue(RESOLUTION);
  resolveLoopModelMock.mockReset().mockReturnValue(RESOLUTION);
});

describe('runDistillLlmCall（pi one-shot 路径）', () => {
  it('成功：返回模型原文；system prompt 与 prompt 透传', async () => {
    oneShotMock.mockResolvedValue('## 蒸馏认知\n内容');
    const out = await runDistillLlmCall('蒸馏输入', 'k3', { apiKey: 'k' }, 'SYS');
    expect(out).toBe('## 蒸馏认知\n内容');
    const call = oneShotMock.mock.calls[0][0];
    expect(call.prompt).toBe('蒸馏输入');
    expect(call.system).toBe('SYS');
    expect(call.model).toBe(RESOLUTION.model);
  });

  it('providerEnv 缺省 → 回落 config 默认解析', async () => {
    oneShotMock.mockResolvedValue('x');
    await runDistillLlmCall('p', 'k3', undefined);
    expect(resolveLoopModelMock).toHaveBeenCalled();
    expect(resolveLoopModelFromEnvMock).not.toHaveBeenCalled();
  });

  it('one-shot 失败（null）→ null', async () => {
    oneShotMock.mockResolvedValue(null);
    expect(await runDistillLlmCall('p', 'k3', { apiKey: 'k' })).toBeNull();
  });

  it('one-shot 抛错 → null（不向上 throw）', async () => {
    oneShotMock.mockRejectedValue(new Error('boom'));
    expect(await runDistillLlmCall('p', 'k3', { apiKey: 'k' })).toBeNull();
  });

  it('解析不出 provider/model → null，不发起调用', async () => {
    resolveLoopModelFromEnvMock.mockReturnValue(null);
    expect(await runDistillLlmCall('p', 'k3', { apiKey: 'k' })).toBeNull();
    expect(oneShotMock).not.toHaveBeenCalled();
  });
});

// ===== 1.2.4 深化：fail/stuck 轨迹深摘（collectTrajectoryExcerpts） =====

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { collectTrajectoryExcerpts } from './distill-runner';
import type { ResearchEvent } from './store';

function trajEvent(overrides: Partial<ResearchEvent>): ResearchEvent {
  return {
    id: 1,
    ts: 0,
    workspace: WS_DIR,
    taskKind: 'binary',
    outcome: 'fail',
    summary: 's',
    ...overrides,
  };
}

let WS_DIR = '';
const cleanup: string[] = [];

function freshWorkspace(): string {
  const d = mkdtempSync(join(tmpdir(), 'zhishi-traj-'));
  cleanup.push(d);
  return d;
}

describe('collectTrajectoryExcerpts（1.2.4 轨迹深摘）', () => {
  it('loop-session jsonl：取末段消息，事件行前缀带事件定位', () => {
    WS_DIR = freshWorkspace();
    mkdirSync(join(WS_DIR, 'traj'), { recursive: true });
    const lines = [
      JSON.stringify({ kind: 'meta', createdAt: '', updatedAt: '' }),
      ...Array.from({ length: 12 }, (_, i) =>
        JSON.stringify({ role: i % 2 === 0 ? 'user' : 'assistant', content: `第 ${i} 步`, timestamp: i })),
      JSON.stringify({ role: 'toolResult', content: [{ type: 'text', text: '*** stack smashing detected ***' }] }),
    ];
    writeFileSync(join(WS_DIR, 'traj', 's.jsonl'), lines.join('\n') + '\n', 'utf-8');
    const out = collectTrajectoryExcerpts([trajEvent({ id: 7, trajectoryRef: 'traj/s.jsonl' })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('事件#7（binary/fail）轨迹末段');
    expect(out[0]).toContain('stack smashing detected');
    // 只取末段（8 条）：最早的消息不进深摘。
    expect(out[0]).not.toContain('第 0 步');
  });

  it('纯文本轨迹：取尾部；success 事件不摘', () => {
    WS_DIR = freshWorkspace();
    writeFileSync(join(WS_DIR, 'notes.md'), '开头\n中段\n结尾：真正的卡点在这里', 'utf-8');
    const out = collectTrajectoryExcerpts([
      trajEvent({ id: 1, outcome: 'success', trajectoryRef: 'notes.md' }),
      trajEvent({ id: 2, outcome: 'stuck', trajectoryRef: 'notes.md' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('事件#2（binary/stuck）');
    expect(out[0]).toContain('真正的卡点在这里');
  });

  it('宿主读不到的轨迹（环境内路径/不存在/路径穿越）静默跳过', () => {
    WS_DIR = freshWorkspace();
    expect(collectTrajectoryExcerpts([trajEvent({ trajectoryRef: '/work/env-only/crash.poc' })])).toEqual([]);
    expect(collectTrajectoryExcerpts([trajEvent({ trajectoryRef: 'missing.jsonl' })])).toEqual([]);
    expect(collectTrajectoryExcerpts([trajEvent({ trajectoryRef: '../../outside.txt' })])).toEqual([]);
    expect(collectTrajectoryExcerpts([trajEvent({})])).toEqual([]); // 无 trajectoryRef
  });

  it('总预算截断：超出 RESEARCH_TRAJECTORY_TOTAL_CHARS 后的事件不再摘', () => {
    WS_DIR = freshWorkspace();
    writeFileSync(join(WS_DIR, 'big.txt'), 'x'.repeat(5000), 'utf-8');
    // 单事件 600 上限 × 多条，总预算 2400 → 至多 4 条（3×~650 < 2400，第 5 条超）。
    const events = Array.from({ length: 8 }, (_, i) =>
      trajEvent({ id: i + 1, outcome: 'fail', trajectoryRef: 'big.txt' }));
    const out = collectTrajectoryExcerpts(events);
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out.length).toBeLessThan(8);
    expect(out.join('\n').length).toBeLessThanOrEqual(2400);
  });
});

afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});
