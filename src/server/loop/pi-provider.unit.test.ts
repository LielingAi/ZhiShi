/**
 * M1 — pi-provider（loop/pi-provider.ts）unit tests.
 *
 * 覆盖：kimi 内置命中（无 provider 定义也解析）/ 模型 id 优先级
 * （defaultModelId > providerPrimaryModels > primaryModel）/ 缺 key → null /
 * 禁用 provider → null / 通用 anthropic+openai 构造（baseUrl 规整、api 类型）/
 * staticApiKeyAuth 的 Bearer 头语义。全部纯构造断言，绝无网络。
 * apiKey 用假值，且断言不打印。
 */
import { describe, expect, it } from 'vitest';

import type { AdminAppConfig } from '../utils/admin-config';
import {
  buildLoopModel,
  isKimiCodingProvider,
  normalizeBaseUrl,
  resolveLoopModel,
  resolveLoopModelFromEnv,
  staticApiKeyAuth,
  KIMI_CODING_BASE_URL,
} from './pi-provider';

function config(partial: Record<string, unknown>): AdminAppConfig {
  return partial as AdminAppConfig;
}

describe('isKimiCodingProvider', () => {
  it('按 providerId 命中 kimi/moonshot', () => {
    expect(isKimiCodingProvider('moonshot-coding')).toBe(true);
    expect(isKimiCodingProvider('kimi-for-coding')).toBe(true);
    expect(isKimiCodingProvider('deepseek')).toBe(false);
  });
  it('按 baseUrl 命中 api.kimi.com', () => {
    expect(isKimiCodingProvider('custom-x', 'https://api.kimi.com/coding')).toBe(true);
    expect(isKimiCodingProvider('custom-x', 'https://api.deepseek.com/anthropic')).toBe(false);
  });
});

describe('normalizeBaseUrl', () => {
  it('去尾部斜杠', () => {
    expect(normalizeBaseUrl('https://api.kimi.com/coding/')).toBe('https://api.kimi.com/coding');
    expect(normalizeBaseUrl('https://api.anthropic.com//')).toBe('https://api.anthropic.com');
  });
});

describe('staticApiKeyAuth', () => {
  const fakeKey = 'test-key-not-real';

  it('解析显式 key；auth_token 系补 Bearer 头', async () => {
    const auth = staticApiKeyAuth(fakeKey, 'auth_token');
    const result = await auth.resolve({ ctx: undefined as never, credential: undefined, signal: undefined as never });
    expect(result?.auth.apiKey).toBe(fakeKey);
    expect(result?.auth.headers?.authorization).toBe(`Bearer ${fakeKey}`);
  });

  it('both 同样补 Bearer（对齐 buildClaudeSessionEnv 双发语义）', async () => {
    const auth = staticApiKeyAuth(fakeKey, 'both');
    const result = await auth.resolve({ ctx: undefined as never, credential: undefined, signal: undefined as never });
    expect(result?.auth.headers?.authorization).toBe(`Bearer ${fakeKey}`);
  });

  it('api_key / 缺省不加 Bearer（仅 x-api-key）', async () => {
    for (const t of ['api_key', undefined] as const) {
      const auth = staticApiKeyAuth(fakeKey, t);
      const result = await auth.resolve({ ctx: undefined as never, credential: undefined, signal: undefined as never });
      expect(result?.auth.apiKey).toBe(fakeKey);
      expect(result?.auth.headers?.authorization).toBeUndefined();
    }
  });

  it('overrides 通道的 credential.key 优先', async () => {
    const auth = staticApiKeyAuth(fakeKey, undefined);
    const result = await auth.resolve({
      ctx: undefined as never,
      credential: { type: 'api_key', key: 'override-key' },
      signal: undefined as never,
    });
    expect(result?.auth.apiKey).toBe('override-key');
  });
});

describe('resolveLoopModel（config 自解析）', () => {
  it('kimi 系无 provider 定义也解析（内置 kimi-coding，目录含 k3）', () => {
    const r = resolveLoopModel(config({
      defaultProviderId: 'moonshot-coding',
      defaultModelId: 'k3',
      providerApiKeys: { 'moonshot-coding': 'fake-key' },
    }));
    expect(r).not.toBeNull();
    expect(r!.model.id).toBe('k3');
    expect(r!.model.api).toBe('anthropic-messages');
    expect(r!.model.provider).toBe('kimi-coding');
    expect(r!.model.baseUrl).toBe(KIMI_CODING_BASE_URL);
    expect(r!.getApiKey()).toBe('fake-key');
    // 内置目录条目（不是凭空构造）：k3 的上下文窗口来自 pi 目录
    expect(r!.model.contextWindow).toBeGreaterThan(0);
  });

  it('defaultProviderId 缺省时回落 providerApiKeys 首键', () => {
    const r = resolveLoopModel(config({
      providerApiKeys: { 'moonshot-coding': 'fake-key' },
      defaultModelId: 'k3',
    }));
    expect(r?.providerId).toBe('moonshot-coding');
  });

  it('modelId 优先级：defaultModelId > providerPrimaryModels > provider.primaryModel', () => {
    const withDefault = resolveLoopModel(config({
      defaultProviderId: 'deepseek',
      defaultModelId: 'explicit-model',
      providerPrimaryModels: { deepseek: 'primary-model' },
      providerApiKeys: { deepseek: 'fake-key' },
    }));
    expect(withDefault?.modelId).toBe('explicit-model');

    const withPrimary = resolveLoopModel(config({
      defaultProviderId: 'deepseek',
      providerPrimaryModels: { deepseek: 'primary-model' },
      providerApiKeys: { deepseek: 'fake-key' },
    }));
    expect(withPrimary?.modelId).toBe('primary-model');

    const withPreset = resolveLoopModel(config({
      defaultProviderId: 'deepseek',
      providerApiKeys: { deepseek: 'fake-key' },
    }));
    // deepseek 是 PRESET_PROVIDER，回落其 primaryModel
    expect(withPreset?.modelId).toBe('deepseek-v4-pro');
  });

  it('preset provider 的 baseUrl/authType 进入 model 构造', () => {
    const r = resolveLoopModel(config({
      defaultProviderId: 'deepseek',
      providerApiKeys: { deepseek: 'fake-key' },
    }));
    expect(r?.model.baseUrl).toBe('https://api.deepseek.com/anthropic');
    expect(r?.model.api).toBe('anthropic-messages');
  });

  it('缺 key / 空白 key → null', () => {
    expect(resolveLoopModel(config({ defaultProviderId: 'deepseek', providerApiKeys: {} }))).toBeNull();
    expect(resolveLoopModel(config({ defaultProviderId: 'deepseek', providerApiKeys: { deepseek: '  ' } }))).toBeNull();
  });

  it('全局禁用的 provider → null', () => {
    const r = resolveLoopModel(config({
      defaultProviderId: 'deepseek',
      providerApiKeys: { deepseek: 'fake-key' },
      disabledProviderIds: ['deepseek'],
    }));
    expect(r).toBeNull();
  });

  it('无 key 无任何 provider → null', () => {
    expect(resolveLoopModel(config({}))).toBeNull();
  });
});

describe('buildLoopModel（显式 provider）', () => {
  it('通用 anthropic：baseUrl 原样透传（不补 /v1），规整尾斜杠', () => {
    const r = buildLoopModel({ modelId: 'm1', providerId: 'custom', baseUrl: 'https://example.com/anthropic/', apiKey: 'k' });
    expect(r.model.api).toBe('anthropic-messages');
    expect(r.model.baseUrl).toBe('https://example.com/anthropic');
  });

  it('openai 协议 → openai-completions；responses 格式 → openai-responses', () => {
    const chat = buildLoopModel({ modelId: 'm1', apiProtocol: 'openai', baseUrl: 'https://x.com/v1', apiKey: 'k' });
    expect(chat.model.api).toBe('openai-completions');
    const responses = buildLoopModel({ modelId: 'm1', apiProtocol: 'openai', upstreamFormat: 'responses', baseUrl: 'https://x.com/v1', apiKey: 'k' });
    expect(responses.model.api).toBe('openai-responses');
  });

  it('kimi 目录未收录的 modelId 克隆目录首条目（保 baseUrl/compat）', () => {
    const r = buildLoopModel({ modelId: 'k3-future', providerId: 'moonshot-coding', apiKey: 'k' });
    expect(r.model.id).toBe('k3-future');
    expect(r.model.baseUrl).toBe(KIMI_CODING_BASE_URL);
    expect(r.model.provider).toBe('kimi-coding');
  });

  it('Models 集合含解析出的 provider（streamSimple 的 dispatch 目标）', () => {
    const r = buildLoopModel({ modelId: 'm1', providerId: 'custom-p', baseUrl: 'https://example.com', apiKey: 'k' });
    expect(r.models.getProvider('custom-p')).toBeDefined();
    expect(r.models.getModel('custom-p', 'm1')?.id).toBe('m1');
  });
});

describe('resolveLoopModelFromEnv', () => {
  it('缺 apiKey / 空白 key → null', () => {
    expect(resolveLoopModelFromEnv(undefined, 'm')).toBeNull();
    expect(resolveLoopModelFromEnv({ apiKey: ' ' }, 'm')).toBeNull();
  });

  it('携带 env 的 baseUrl/protocol 进入构造', () => {
    const r = resolveLoopModelFromEnv(
      { apiKey: 'k', baseUrl: 'https://example.com/anthropic', authType: 'auth_token' },
      'model-x',
    );
    expect(r?.model.id).toBe('model-x');
    expect(r?.model.baseUrl).toBe('https://example.com/anthropic');
    expect(r?.getApiKey()).toBe('k');
  });
});
