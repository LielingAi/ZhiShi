/**
 * admin model/verify — kimi 内置条目的 verify 链路（1.5.5 回归）。
 *
 * 背景 bug（新机器实机报错）：kimi 内置是合成条目（pi 层 kimiCodingProvider
 * 直连 api.kimi.com/coding），不在 PRESET_PROVIDERS 也不在自定义 provider
 * 文件里——handleModelVerify 的 findProvider('kimi') 返回 null，报
 * 「Provider 'kimi' not found in presets or custom providers.」。
 * 修复：verify 合成 kimi 描述（端点/anthropic 协议/Bearer/内置目录首条目），
 * key 判定走 resolveKimiApiKey 模糊口径（moonshot-coding 键也算配了）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.fn(() => ({}) as Record<string, unknown>);
const verifyMock = vi.fn(async (..._args: unknown[]) => ({ success: true as boolean, error: undefined as string | undefined }));

vi.mock('../utils/admin-config', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../utils/admin-config')>();
  return {
    ...orig,
    loadConfig: () => configMock(),
    atomicModifyConfig: async (fn: (c: Record<string, unknown>) => Record<string, unknown>) => {
      fn({});
    },
  };
});
vi.mock('../provider-verify', () => ({
  verifyProviderViaSdk: (baseUrl: unknown, apiKey: unknown, authType: unknown, model: unknown, protocol: unknown) =>
    verifyMock(baseUrl, apiKey, authType, model, protocol),
}));

import { handleModelVerify } from '../admin-api';

beforeEach(() => {
  configMock.mockReturnValue({});
  verifyMock.mockClear();
  verifyMock.mockResolvedValue({ success: true, error: undefined });
});

describe('model/verify — kimi 内置合成描述（1.5.5）', () => {
  it('kimi 不再报 not found——合成描述走 verify（端点/协议/鉴权/模型）', async () => {
    configMock.mockReturnValue({ providerApiKeys: { kimi: 'sk-kimi-x' } });
    const res = await handleModelVerify({ id: 'kimi' });
    expect(res.success).toBe(true);
    expect(verifyMock).toHaveBeenCalledOnce();
    const [baseUrl, apiKey, authType, model, protocol] = verifyMock.mock.calls[0] as unknown[];
    expect(baseUrl).toBe('https://api.kimi.com/coding');
    expect(apiKey).toBe('sk-kimi-x');
    expect(authType).toBe('auth_token');
    expect(protocol).toBe('anthropic');
    expect(typeof model).toBe('string');
    expect((model as string).length).toBeGreaterThan(0);
  });

  it('key 配在 moonshot-coding 下也能 verify kimi（与运行/显示链路同口径）', async () => {
    configMock.mockReturnValue({ providerApiKeys: { 'moonshot-coding': 'sk-mc-x' } });
    const res = await handleModelVerify({ id: 'kimi' });
    expect(res.success).toBe(true);
    expect(verifyMock.mock.calls[0] as unknown[]).toBeDefined();
    expect((verifyMock.mock.calls[0] as unknown[])[1]).toBe('sk-mc-x');
  });

  it('kimi 无任何 key → 报未配 key（不误进合成描述）', async () => {
    configMock.mockReturnValue({ providerApiKeys: {} });
    const res = await handleModelVerify({ id: 'kimi' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('No API key');
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('不存在的 provider 仍报 not found（合成只覆盖 kimi）', async () => {
    configMock.mockReturnValue({ providerApiKeys: { ghost: 'sk-x' } });
    const res = await handleModelVerify({ id: 'ghost' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('not found');
  });
});
