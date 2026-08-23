/**
 * admin model/list 测试（1.2.9 Q1）——kimi 内置条目的 key 判定口径与
 * 「当前使用 provider/model」字段。
 *
 * 背景 bug：显示链路精确查 providerApiKeys['kimi']，运行链路
 * （resolveLoopModel）对 kimi 系模糊匹配（id 含 kimi/moonshot 且非
 * openai 协议）——用户配 moonshot-coding 能跑但显示「未配 key」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.fn(() => ({}) as Record<string, unknown>);
vi.mock('../utils/admin-config', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../utils/admin-config')>();
  return { ...orig, loadConfig: () => configMock() };
});

import { handleModelList } from '../admin-api';

interface ProviderRow {
  id: string;
  hasApiKey: boolean;
  primaryModel?: string;
}

function list() {
  const res = handleModelList() as unknown as {
    data: ProviderRow[];
    current?: { providerId?: string; modelId?: string };
  };
  return res;
}

beforeEach(() => {
  configMock.mockReturnValue({});
});

describe('model/list — kimi 内置条目 key 判定（1.2.9 Q1）', () => {
  it('moonshot-coding 键 → kimi 内置显示已配 key（与运行链路同口径）', () => {
    configMock.mockReturnValue({ providerApiKeys: { 'moonshot-coding': 'sk-x' } });
    const kimi = list().data.find((p) => p.id === 'kimi');
    expect(kimi?.hasApiKey).toBe(true);
  });

  it('moonshot preset 键（openai 协议端点）→ kimi 内置仍显示未配', () => {
    configMock.mockReturnValue({ providerApiKeys: { moonshot: 'sk-x' } });
    const kimi = list().data.find((p) => p.id === 'kimi');
    expect(kimi?.hasApiKey).toBe(false);
    // moonshot 自己的条目照常显示已配
    expect(list().data.find((p) => p.id === 'moonshot')?.hasApiKey).toBe(true);
  });

  it('空字符串 key 不算已配', () => {
    configMock.mockReturnValue({ providerApiKeys: { 'moonshot-coding': '  ' } });
    expect(list().data.find((p) => p.id === 'kimi')?.hasApiKey).toBe(false);
  });
});

describe('model/list — current（当前使用 provider/model）', () => {
  it('无 defaultProviderId 时回落 providerApiKeys 首键（同 resolveLoopModel）', () => {
    configMock.mockReturnValue({
      providerApiKeys: { 'moonshot-coding': 'sk-x' },
      providerPrimaryModels: { 'moonshot-coding': 'k3' },
    });
    const { current } = list();
    expect(current?.providerId).toBe('moonshot-coding');
    expect(current?.modelId).toBe('k3');
  });

  it('defaultProviderId/defaultModelId 优先', () => {
    configMock.mockReturnValue({
      defaultProviderId: 'deepseek',
      defaultModelId: 'deepseek-v4-flash',
      providerApiKeys: { deepseek: 'sk-y', 'moonshot-coding': 'sk-x' },
    });
    const { current } = list();
    expect(current?.providerId).toBe('deepseek');
    expect(current?.modelId).toBe('deepseek-v4-flash');
  });

  it('无任何 key → current.providerId undefined', () => {
    configMock.mockReturnValue({});
    expect(list().current?.providerId).toBeUndefined();
  });
});
