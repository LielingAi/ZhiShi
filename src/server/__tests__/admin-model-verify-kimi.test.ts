/**
 * admin model/verify — kimi preset 的 verify 链路（1.5.5 发现 / 1.5.6 收编）。
 *
 * 背景 bug（新机器实机报错）：kimi 曾是合成条目（pi 层 kimiCodingProvider
 * 直连 api.kimi.com/coding），不在 PRESET_PROVIDERS 也不在自定义 provider
 * 文件里——handleModelVerify 的 findProvider('kimi') 返回 null，报
 * 「Provider 'kimi' not found in presets or custom providers.」。
 * 1.5.6 收编：kimi 成为标准 preset（config-types.ts），verify 走统一
 * findProvider 路径无特例；key 判定保留 resolveKimiApiKey 模糊口径
 * （moonshot-coding 键也算配了——与运行/显示链路一致）。
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

describe('model/verify — kimi preset 统一链路（1.5.6）', () => {
  it('kimi 不再报 not found——preset 描述走 verify（端点/协议/鉴权/模型）', async () => {
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

  it('kimi 无任何 key → 报未配 key（不进 verify）', async () => {
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
