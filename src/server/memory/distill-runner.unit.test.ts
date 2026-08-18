/**
 * M1 — distill-runner 替换点行为测试（SDK query → pi one-shot）。
 *
 * runDistillLlmCall 是四条蒸馏路径（蒸馏弧/话题弧/土匪 judge/research
 * 蒸馏）共用的唯一 LLM 出口。mock loop/one-shot（网络出口）与
 * loop/pi-provider（解析层），断言：成功返回原文、失败/异常返回 null、
 * providerEnv 缺省回落 config 解析、system prompt 透传。
 * agent-session  mock 掉避免重模块加载。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

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
