import { describe, expect, it, vi } from 'vitest';

vi.mock('./utils/admin-config', () => ({
  loadConfig: () => ({ providerApiKeys: { deepseek: 'sk-test', nope: 'sk-test' } }),
  getAllEffectiveProviders: () => [{ id: 'deepseek' }, { id: 'openai' }],
  findProvider: (id: string) => (id === 'deepseek' ? { id: 'deepseek' } : null),
  atomicModifyConfig: vi.fn(async () => undefined),
}));

vi.mock('./utils/provider-models', () => ({
  discoverProviderModels: vi.fn(async () => ({ modelsFetched: 3 })),
}));

import { refreshModelCatalogs } from './model-refresh';

describe('refreshModelCatalogs', () => {
  it('指定 provider：用已保存的 key 发现目录，不写 key', async () => {
    const outcome = await refreshModelCatalogs('deepseek');
    expect(outcome.error).toBeUndefined();
    expect(outcome.results).toEqual([{ id: 'deepseek', modelsFetched: 3 }]);
  });

  it('未知 provider：单条 error，不影响整体结构', async () => {
    const outcome = await refreshModelCatalogs('nope');
    expect(outcome.results[0]).toMatchObject({ id: 'nope' });
    expect(outcome.results[0]!.error).toContain('not found');
  });

  it('不指定 id：只刷已配置 key 的供应商', async () => {
    const outcome = await refreshModelCatalogs();
    // deepseek 有 key；openai 没有 → 不在结果里。
    expect(outcome.results.map((r) => r.id)).toEqual(['deepseek']);
  });
});
