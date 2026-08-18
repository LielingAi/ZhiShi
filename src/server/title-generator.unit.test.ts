/**
 * M1 — title-generator 替换点行为测试（SDK query → pi one-shot）。
 *
 * mock loop/one-shot（唯一网络出口）与 loop/pi-provider（解析层，避免
 * 读真 config），断言：成功时清洗后的标题（去引号/尾标点）、失败/超时
 * 静默 null、providerEnv 驱动解析且 model/system/prompt 正确传递。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const oneShotMock = vi.fn();
const resolveLoopModelFromEnvMock = vi.fn();
const resolveLoopModelMock = vi.fn();

vi.mock('./loop/one-shot', () => ({
  oneShot: (...args: unknown[]) => oneShotMock(...args),
}));
vi.mock('./loop/pi-provider', () => ({
  resolveLoopModelFromEnv: (...args: unknown[]) => resolveLoopModelFromEnvMock(...args),
  resolveLoopModel: (...args: unknown[]) => resolveLoopModelMock(...args),
}));

import { generateTitle } from './title-generator';

const ROUNDS = [
  { user: '帮我看看 #215 的 Ctrl+F 搜索导航问题', assistant: '好的，先定位搜索框组件…' },
  { user: '跳转下一个结果不滚动', assistant: '问题在 scrollIntoView 的调用时机…' },
];

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

describe('generateTitle（pi one-shot 路径）', () => {
  it('成功：返回清洗后的标题（去引号/尾标点）', async () => {
    oneShotMock.mockResolvedValue('"#215 搜索导航修复。"');
    const title = await generateTitle(ROUNDS, 'k3', { apiKey: 'k', baseUrl: 'https://api.kimi.com/coding' });
    expect(title).toBe('#215 搜索导航修复');
  });

  it('providerEnv 驱动解析；model/system/prompt 正确传递', async () => {
    oneShotMock.mockResolvedValue('标题');
    await generateTitle(ROUNDS, 'k3', { apiKey: 'k', baseUrl: 'https://api.kimi.com/coding' });
    expect(resolveLoopModelFromEnvMock).toHaveBeenCalledWith(
      { apiKey: 'k', baseUrl: 'https://api.kimi.com/coding' },
      'k3',
    );
    const call = oneShotMock.mock.calls[0][0];
    expect(call.model).toBe(RESOLUTION.model);
    expect(call.models).toBe(RESOLUTION.models);
    expect(call.apiKey).toBe('fake-key');
    expect(call.system).toContain('session title generator');
    expect(call.prompt).toContain('#215');
    expect(call.prompt).toContain('[Round 2]');
  });

  it('无 providerEnv → 回落 config 默认解析（resolveLoopModel）', async () => {
    oneShotMock.mockResolvedValue('标题');
    await generateTitle(ROUNDS, 'k3');
    expect(resolveLoopModelMock).toHaveBeenCalled();
    expect(resolveLoopModelFromEnvMock).not.toHaveBeenCalled();
  });

  it('one-shot 失败（null）→ 静默 null', async () => {
    oneShotMock.mockResolvedValue(null);
    expect(await generateTitle(ROUNDS, 'k3', { apiKey: 'k' })).toBeNull();
  });

  it('one-shot 抛错 → 静默 null（不向上 throw）', async () => {
    oneShotMock.mockRejectedValue(new Error('boom'));
    expect(await generateTitle(ROUNDS, 'k3', { apiKey: 'k' })).toBeNull();
  });

  it('解析不出 provider/model → 静默 null，不发起调用', async () => {
    resolveLoopModelFromEnvMock.mockReturnValue(null);
    expect(await generateTitle(ROUNDS, 'k3', { apiKey: 'k' })).toBeNull();
    expect(oneShotMock).not.toHaveBeenCalled();
  });

  it('错误串标题被 isLikelyErrorTitle 拦截 → null', async () => {
    oneShotMock.mockResolvedValue('API Error: 401 authentication failed');
    expect(await generateTitle(ROUNDS, 'k3', { apiKey: 'k' })).toBeNull();
  });
});
