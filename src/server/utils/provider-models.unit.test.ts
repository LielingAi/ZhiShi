/**
 * M4d — provider-models（utils/provider-models.ts）unit tests。
 *
 * 覆盖：模型列表端点推导（显式覆盖 / OpenAI /v1 形态 / anthropic 主机形态）/
 * 上游响应解析（OpenAI {data:[{id}]} 与 anthropic {data:[{id,display_name}]}
 * 双格式 + 非法形状容错）/ fetch 成功与失败分支（mock undici，绝无网络）/
 * discoverProviderModels 的触发门与 persist 编排。全部纯构造断言，apiKey 用假值。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const undiciFetchMock = vi.fn();

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => undiciFetchMock(...args),
  ProxyAgent: class {
    close = async (): Promise<void> => {};
  },
}));
vi.mock('./proxy-for-url', () => ({
  getProxyForUrl: (): string | undefined => undefined,
}));

import {
  MODEL_LIST_MAX_ENTRIES,
  discoverProviderModels,
  fetchProviderModels,
  parseProviderModelsResponse,
  resolveModelListUrl,
} from './provider-models';

function okResponse(body: unknown): { status: number; text: () => Promise<string> } {
  return { status: 200, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  undiciFetchMock.mockReset();
});

describe('resolveModelListUrl', () => {
  it('显式 modelListUrl 优先且去尾斜杠', () => {
    expect(resolveModelListUrl('https://api.x.com', 'https://list.x.com/models/')).toBe('https://list.x.com/models');
  });

  it('anthropic 主机式 baseUrl → 补 /v1/models', () => {
    expect(resolveModelListUrl('https://api.anthropic.com', undefined)).toBe('https://api.anthropic.com/v1/models');
    expect(resolveModelListUrl('https://api.deepseek.com/anthropic/', undefined)).toBe('https://api.deepseek.com/anthropic/v1/models');
  });

  it('OpenAI 格式 baseUrl（/v1 结尾）→ 补 /models（不重复 /v1）', () => {
    expect(resolveModelListUrl('https://api.openai.com/v1', undefined)).toBe('https://api.openai.com/v1/models');
    expect(resolveModelListUrl('https://api.siliconflow.cn/v1/', undefined)).toBe('https://api.siliconflow.cn/v1/models');
  });

  it('无 baseUrl 且无显式端点 → null', () => {
    expect(resolveModelListUrl(undefined, undefined)).toBeNull();
  });
});

describe('parseProviderModelsResponse', () => {
  it('OpenAI 格式 {data:[{id,...}]} → ModelEntity（source: discovered）', () => {
    const models = parseProviderModelsResponse(
      { object: 'list', data: [{ id: 'gpt-5.4', object: 'model', created: 1, owned_by: 'openai' }, { id: 'gpt-5.4-mini', object: 'model' }] },
      'openai',
    );
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({ model: 'gpt-5.4', modelName: 'gpt-5.4', modelSeries: 'openai', source: 'discovered' });
    expect(models[1].model).toBe('gpt-5.4-mini');
  });

  it('anthropic 原生格式：display_name 作显示名', () => {
    const models = parseProviderModelsResponse(
      { data: [{ id: 'claude-sonnet-4-6', type: 'model', display_name: 'Claude Sonnet 4.6' }] },
      'anthropic-api',
    );
    expect(models).toEqual([
      { model: 'claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6', modelSeries: 'anthropic-api', source: 'discovered' },
    ]);
  });

  it('display_name 空白时回落 name', () => {
    const models = parseProviderModelsResponse({
      data: [
        { id: 'm1', display_name: '   ' },
        { id: 'm2', display_name: ' ', name: 'M2 Name' },
      ],
    });
    expect(models[0].modelName).toBe('m1');
    expect(models[1].modelName).toBe('M2 Name');
  });

  it('缺 id / 非数组 data / 非对象 body → 空列表', () => {
    expect(parseProviderModelsResponse(undefined)).toEqual([]);
    expect(parseProviderModelsResponse('oops')).toEqual([]);
    expect(parseProviderModelsResponse({ data: 'nope' })).toEqual([]);
    expect(parseProviderModelsResponse({ data: [{ object: 'model' }, null, 'x'] })).toEqual([]);
  });
});

describe('fetchProviderModels', () => {
  it('2xx + OpenAI JSON → 解析出的 models + status；GET/Bearer/不跟随重定向', async () => {
    undiciFetchMock.mockResolvedValue(okResponse({ data: [{ id: 'gpt-5.4' }] }));
    const r = await fetchProviderModels({ url: 'https://api.openai.com/v1/models', apiKey: 'sk-test', authType: 'auth_token' });
    expect(r.status).toBe(200);
    expect(r.models.map(m => m.model)).toEqual(['gpt-5.4']);
    const [url, init] = undiciFetchMock.mock.calls[0] as [string, { method: string; redirect: string; headers: Record<string, string> }];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect(init.headers.authorization).toBe('Bearer sk-test');
  });

  it('api_key 型 → x-api-key 头', async () => {
    undiciFetchMock.mockResolvedValue(okResponse({ data: [] }));
    await fetchProviderModels({ url: 'https://x/v1/models', apiKey: 'k', authType: 'api_key' });
    const [, init] = undiciFetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers['x-api-key']).toBe('k');
  });

  it('非 2xx → throw（含状态码与截断 body）', async () => {
    undiciFetchMock.mockResolvedValue({ status: 401, text: async () => 'invalid api key' });
    await expect(fetchProviderModels({ url: 'https://x/models', apiKey: 'k' })).rejects.toThrow(/HTTP 401/);
  });

  it('非法 JSON → throw', async () => {
    undiciFetchMock.mockResolvedValue({ status: 200, text: async () => '<html>bad gateway</html>' });
    await expect(fetchProviderModels({ url: 'https://x/models', apiKey: 'k' })).rejects.toThrow(/not valid JSON/);
  });

  it('条目数超上限 → 截断到 MODEL_LIST_MAX_ENTRIES', async () => {
    const entries = Array.from({ length: MODEL_LIST_MAX_ENTRIES + 50 }, (_, i) => ({ id: `m${i}` }));
    undiciFetchMock.mockResolvedValue(okResponse({ data: entries }));
    const r = await fetchProviderModels({ url: 'https://x/models', apiKey: 'k' });
    expect(r.models).toHaveLength(MODEL_LIST_MAX_ENTRIES);
  });

  it('fetch 抛错（网络/超时）→ 原样上抛', async () => {
    undiciFetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(fetchProviderModels({ url: 'https://x/models', apiKey: 'k' })).rejects.toThrow('ECONNREFUSED');
  });
});

describe('discoverProviderModels（set-key 后编排）', () => {
  const openaiProvider = {
    apiProtocol: 'openai',
    authType: 'auth_token',
    config: { baseUrl: 'https://api.openai.com/v1' },
  };

  it('OpenAI 协议 provider → 拉取并入（persist 收到解析结果）', async () => {
    undiciFetchMock.mockResolvedValue(okResponse({ data: [{ id: 'gpt-5.4' }, { id: 'gpt-5.4-mini' }] }));
    const persist = vi.fn(async () => {});
    const r = await discoverProviderModels({ provider: openaiProvider, apiKey: 'sk-test', persist });
    expect(r).toEqual({ modelsFetched: 2 });
    expect(persist).toHaveBeenCalledTimes(1);
    expect((persist.mock.calls[0] as unknown[][])[0].map((m) => (m as { model: string }).model)).toEqual(['gpt-5.4', 'gpt-5.4-mini']);
  });

  it('显式 modelListUrl 的非 openai provider（deepseek）同样触发', async () => {
    undiciFetchMock.mockResolvedValue(okResponse({ data: [{ id: 'deepseek-v4-pro' }] }));
    const persist = vi.fn(async () => {});
    const r = await discoverProviderModels({
      provider: { authType: 'auth_token', modelListUrl: 'https://api.deepseek.com/v1/models', config: { baseUrl: 'https://api.deepseek.com/anthropic' } },
      apiKey: 'k',
      persist,
    });
    expect(r.modelsFetched).toBe(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('anthropic 协议且无显式 modelListUrl → 不触发（persist 不被调用）', async () => {
    const persist = vi.fn(async () => {});
    const r = await discoverProviderModels({
      provider: { authType: 'both', config: { baseUrl: 'https://api.anthropic.com' } },
      apiKey: 'k',
      persist,
    });
    expect(r).toEqual({});
    expect(undiciFetchMock).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('空目录 → modelsFetched:0 且不 persist', async () => {
    undiciFetchMock.mockResolvedValue(okResponse({ data: [] }));
    const persist = vi.fn(async () => {});
    const r = await discoverProviderModels({ provider: openaiProvider, apiKey: 'k', persist });
    expect(r).toEqual({ modelsFetched: 0 });
    expect(persist).not.toHaveBeenCalled();
  });

  it('拉取失败 → { error } 且不 persist（set-key 降级语义）', async () => {
    undiciFetchMock.mockResolvedValue({ status: 403, text: async () => 'forbidden' });
    const persist = vi.fn(async () => {});
    const r = await discoverProviderModels({ provider: openaiProvider, apiKey: 'k', persist });
    expect(r.modelsFetched).toBeUndefined();
    expect(r.error).toMatch(/HTTP 403/);
    expect(persist).not.toHaveBeenCalled();
  });

  it('端点不可推导（openai 协议无 baseUrl 无显式端点）→ error', async () => {
    const persist = vi.fn(async () => {});
    const r = await discoverProviderModels({ provider: { apiProtocol: 'openai' }, apiKey: 'k', persist });
    expect(r.error).toContain('端点');
    expect(undiciFetchMock).not.toHaveBeenCalled();
  });
});
