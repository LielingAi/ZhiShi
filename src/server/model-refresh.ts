/**
 * 2.2.3 — 模型目录刷新（不重写 key）。
 *
 * 背景：内置预设随版本走；供应商新增模型只有两条路能看到——`model set-key`
 * 时自动发现，或手工 `model add --models`。研究员不想为了刷新目录再把 key
 * 传一遍（shell history 泄露面），所以给一个只读 key、只打 `/models` 的入口。
 *
 * 行为：
 *   - 指定 id：只刷该供应商（必须已配置 key）
 *   - 不指定：刷新所有已配置 key 的供应商
 *   - 发现失败只记 error，不影响其它供应商；成功的目录原子写回
 *     presetCustomModels（与 set-key 同一持久化口径）
 */

import { atomicModifyConfig, findProvider, getAllEffectiveProviders, loadConfig } from './utils/admin-config';
import { discoverProviderModels } from './utils/provider-models';

export interface ModelRefreshResult {
  id: string;
  modelsFetched?: number;
  error?: string;
}

export interface ModelRefreshOutcome {
  results: ModelRefreshResult[];
  error?: string;
}

/** 用已保存的 key 刷新单个供应商的模型目录。 */
export async function refreshProviderModels(
  id: string,
  apiKey: string,
): Promise<{ modelsFetched?: number; error?: string }> {
  const provider = findProvider(id);
  if (!provider) return { error: `Provider '${id}' not found in presets or custom providers` };
  const result = await discoverProviderModels({
    provider,
    apiKey,
    persist: async (models) => {
      await atomicModifyConfig((c) => ({
        ...c,
        presetCustomModels: {
          ...((c.presetCustomModels ?? {}) as Record<string, unknown>),
          [id]: models,
        },
      }));
    },
  });
  return {
    ...(result.modelsFetched !== undefined ? { modelsFetched: result.modelsFetched } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

/** 刷新模型目录：指定 id 或全部已配置供应商。 */
export async function refreshModelCatalogs(id?: string): Promise<ModelRefreshOutcome> {
  const config = loadConfig();
  const apiKeys = (config.providerApiKeys ?? {}) as Record<string, string>;
  const known = getAllEffectiveProviders(config).map((p) => String(p.id));
  const requested = typeof id === 'string' ? id.trim() : '';
  const ids = requested
    ? [requested]
    : known.filter((pid) => typeof apiKeys[pid] === 'string' && apiKeys[pid]!.trim() !== '');
  if (ids.length === 0) return { results: [], error: '没有已配置 API key 的供应商可刷新' };

  const results: ModelRefreshResult[] = [];
  for (const pid of ids) {
    const key = apiKeys[pid];
    if (!key || !key.trim()) {
      results.push({ id: pid, error: '未配置 API key' });
      continue;
    }
    const r = await refreshProviderModels(pid, key);
    results.push({
      id: pid,
      ...(r.modelsFetched !== undefined ? { modelsFetched: r.modelsFetched } : {}),
      ...(r.error !== undefined ? { error: r.error } : {}),
    });
  }
  return { results };
}
