/**
 * M1 — provider-verify 替换点行为测试（SDK query → pi one-shot）。
 *
 * mock：agent-session（避免重模块加载）、loop/one-shot（网络出口）、
 * provider-probe 的两个真实探测函数（诊断探测绝不真出网；分类/组合
 * 纯函数保持真实实现）。断言：anthropic 协议直连成功/上游错误分类/
 * 解析失败三类行为与原 SDK 路径一致。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const oneShotResultMock = vi.fn();

vi.mock('./agent-session', () => ({
  startOneShotBridge: vi.fn(),
  getSidecarPort: () => 0,
}));
vi.mock('./loop/one-shot', () => ({
  oneShotResult: (...args: unknown[]) => oneShotResultMock(...args),
}));
vi.mock('./provider-probe', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./provider-probe')>();
  return {
    ...orig,
    probeAnthropicProviderDirect: vi.fn(async () => undefined),
  };
});

import { verifyProviderViaSdk } from './provider-verify';

beforeEach(() => {
  oneShotResultMock.mockReset();
});

describe('verifyProviderViaSdk（pi one-shot 路径）', () => {
  it('anthropic 协议：one-shot 成功 → success:true', async () => {
    oneShotResultMock.mockResolvedValue({ ok: true, text: '1' });
    const r = await verifyProviderViaSdk('https://api.kimi.com/coding', 'fake-key', 'both', 'k3');
    expect(r.success).toBe(true);
    // 测试提示词与原 SDK 路径一致
    expect(oneShotResultMock.mock.calls[0][0].prompt).toContain('directly reply "1"');
  });

  it('上游 401 → success:false，错误经 parseProviderError 分类', async () => {
    oneShotResultMock.mockResolvedValue({ ok: false, error: 'HTTP 401: authentication failed' });
    const r = await verifyProviderViaSdk('https://api.kimi.com/coding', 'fake-key', 'both', 'k3');
    expect(r.success).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('上游 429 → success:false（限流分类，不当成功）', async () => {
    oneShotResultMock.mockResolvedValue({ ok: false, error: 'HTTP 429: rate limit exceeded' });
    const r = await verifyProviderViaSdk('https://api.kimi.com/coding', 'fake-key', 'both', 'k3');
    expect(r.success).toBe(false);
  });

  it('model 缺省 → success:false（不发请求）', async () => {
    const r = await verifyProviderViaSdk('https://api.kimi.com/coding', 'fake-key', 'both', undefined);
    expect(r.success).toBe(false);
    expect(oneShotResultMock).not.toHaveBeenCalled();
  });

});
