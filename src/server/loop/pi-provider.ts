/**
 * M1 — pi(pi-ai 0.84)模型/provider 解析层（自研 agent loop 的模型入口）。
 *
 * 两条构造路径：
 *
 * 1. {@link buildLoopModel} — 从显式 provider 描述（baseUrl/apiKey/protocol）
 *    构造 pi 运行时（Models 集合 + Model）。供携带 ProviderEnv 的一次性
 *    调用点（title-generator / distill-runner / provider-verify）使用。
 *
 * 2. {@link resolveLoopModel} — 从 config.json 自解析默认 loop 模型：
 *    defaultProviderId（缺省回落 providerApiKeys 首键）→ apiKey；
 *    defaultModelId → providerPrimaryModels[id] → provider.primaryModel。
 *    语义参照 resolveWorkspaceConfig（admin-config.ts）的 provider/model 解析。
 *
 * provider 映射规则：
 *   - kimi 系（id 含 kimi/moonshot，或 baseUrl 指向 api.kimi.com）
 *     → pi-ai 内置 kimiCodingProvider()（baseUrl https://api.kimi.com/coding，
 *     anthropic-messages，内置模型目录含 k3）；该 provider 在本仓
 *     PRESET_PROVIDERS 之外也能解析（baseUrl 已知，不依赖 provider 定义）。
 *   - 其余 anthropic 协议 → createProvider 通用 anthropic-messages，baseUrl
 *     原样透传（pi 走官方 Anthropic SDK，baseURL 语义与 ANTHROPIC_BASE_URL
 *     一致，SDK 自己拼 /v1/messages——不要手工补 /v1，AI SDK spike 的
 *     /v1 坑在 pi 侧不存在，已实测）。
 *   - openai 协议 → openai-completions / openai-responses（pi 原生讲
 *     OpenAI 协议，一次性调用不再需要 openai-bridge 回环）。
 *
 * 凭据纪律：apiKey 只进 auth.resolve 闭包 / getApiKey，绝不落日志。
 * 鉴权经 pi 的 overrides.apiKey 通道（Models.streamSimple 的
 * options.apiKey → resolveProviderAuth 显式 key 短路，见 pi-ai
 * auth/resolve.js），不碰 credential store / 环境变量。
 */

import {
  createModels,
  createProvider,
  type Api,
  type ApiKeyAuth,
  type Model,
  type Models,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { kimiCodingProvider } from '@earendil-works/pi-ai/providers/kimi-coding';

import {
  findEffectiveProvider,
  loadConfig,
  type AdminAppConfig,
} from '../utils/admin-config';
import { lookupModelContextLength } from '../utils/model-capabilities';
import { isProviderEnabled } from '../../shared/config-types';

/** kimi for coding 固定端点（与 pi-ai 内置 kimi-coding provider 一致）。 */
export const KIMI_CODING_BASE_URL = 'https://api.kimi.com/coding';

/** ProviderEnv 的结构子集（与 agent-session.ts::ProviderEnv 结构对齐，避免反向依赖）。 */
export interface LoopProviderEnv {
  baseUrl?: string;
  apiKey?: string;
  authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
  apiProtocol?: 'anthropic' | 'openai';
  maxOutputTokens?: number;
  maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  upstreamFormat?: 'chat_completions' | 'responses';
}

export interface LoopModelResolution {
  /** 含已解析 provider 的 pi Models 集合——streamFn / completeSimple 的来源。 */
  models: Models;
  model: Model<Api>;
  /** 每次 LLM 调用前解析 key（pi agentLoop 的 getApiKey 契约）。 */
  getApiKey: () => string | undefined;
  providerId?: string;
  modelId: string;
}

/** kimi 系判定：providerId 或 baseUrl 命中即走内置 kimi-coding。 */
export function isKimiCodingProvider(providerId?: string, baseUrl?: string): boolean {
  const id = (providerId ?? '').toLowerCase();
  if (id.includes('kimi') || id.includes('moonshot')) return true;
  return !!baseUrl && baseUrl.includes('api.kimi.com');
}

/** baseUrl 规整：去尾部斜杠（pi 透传给 SDK，双斜杠会拼出坏路径）。 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * 静态 apiKey 的 ApiKeyAuth。pi 的 overrides.apiKey 通道会把显式 key 包成
 * credential 传给 resolve——直接回吐，不读环境变量 / credential store。
 * authType 'auth_token'/'both' 的 Bearer 语义经 ModelAuth.headers 补
 * （pi anthropic 默认只发 x-api-key；zhishi 的 auth_token 系 provider
 * 需要 Authorization: Bearer——与 buildClaudeSessionEnv 的语义对应）。
 */
export function staticApiKeyAuth(
  apiKey: string,
  authType?: LoopProviderEnv['authType'],
): ApiKeyAuth {
  const needsBearer = authType === 'auth_token' || authType === 'both' || authType === 'auth_token_clear_api_key';
  return {
    name: 'configured API key',
    resolve: async ({ credential }) => {
      const key = credential?.key ?? apiKey;
      if (!key) return undefined;
      return {
        auth: {
          apiKey: key,
          ...(needsBearer ? { headers: { authorization: `Bearer ${key}` } } : {}),
        },
      };
    },
  };
}

export interface BuildLoopModelOptions extends LoopProviderEnv {
  modelId: string;
  providerId?: string;
  /** 上下文窗口（来自 provider 模型目录；缺省给保守值）。 */
  contextWindow?: number;
}

/**
 * 从显式 provider 描述构造 pi 运行时。baseUrl 缺省时：kimi → 内置端点，
 * openai → api.openai.com/v1，其余 → api.anthropic.com。
 */
export function buildLoopModel(opts: BuildLoopModelOptions): LoopModelResolution {
  const protocol = opts.apiProtocol ?? 'anthropic';
  const kimi = protocol === 'anthropic' && isKimiCodingProvider(opts.providerId, opts.baseUrl);
  const models = createModels();

  if (kimi) {
    const provider = kimiCodingProvider();
    models.setProvider(provider);
    // 内置目录含 k3 等；配置的 modelId 不在目录时克隆首条目改 id
    // （目录字段——baseUrl/compat/上下文窗口——比凭空构造可靠）。
    const catalog = provider.getModels();
    const found = catalog.find((m) => m.id === opts.modelId);
    const model = (found ?? { ...catalog[0], id: opts.modelId, name: opts.modelId }) as Model<Api>;
    return { models, model, getApiKey: () => opts.apiKey, providerId: opts.providerId ?? 'kimi-coding', modelId: opts.modelId };
  }

  const baseUrl = normalizeBaseUrl(
    opts.baseUrl ?? (protocol === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'),
  );
  const providerId = opts.providerId ?? 'custom';
  const api = protocol === 'openai'
    ? (opts.upstreamFormat === 'responses' ? 'openai-responses' : 'openai-completions')
    : 'anthropic-messages';

  const model: Model<Api> = {
    id: opts.modelId,
    name: opts.modelId,
    api,
    provider: providerId,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: opts.contextWindow ?? 200_000,
    maxTokens: opts.maxOutputTokens ?? 8_192,
  } as Model<Api>;

  const provider = createProvider({
    id: providerId,
    baseUrl,
    auth: { apiKey: staticApiKeyAuth(opts.apiKey ?? '', opts.authType) },
    models: [model],
    api: api === 'anthropic-messages'
      ? anthropicMessagesApi()
      : api === 'openai-responses'
        ? openAIResponsesApi()
        : openAICompletionsApi(),
  });
  models.setProvider(provider);
  return { models, model, getApiKey: () => opts.apiKey, providerId, modelId: opts.modelId };
}

/**
 * 从 config.json 解析默认 loop 运行时。返回 null = 无可用 provider/key
 * （调用方按「模型不可用」失败语义处理，不 throw）。
 */
export function resolveLoopModel(config?: AdminAppConfig): LoopModelResolution | null {
  const c = config ?? loadConfig();
  const keys = (c.providerApiKeys ?? {}) as Record<string, string>;

  const providerId = (c.defaultProviderId as string | undefined)
    ?? Object.keys(keys).find((id) => typeof keys[id] === 'string' && keys[id].trim() !== '');
  if (!providerId) return null;

  const apiKey = keys[providerId];
  if (!apiKey || !apiKey.trim()) return null;

  // provider 定义（preset/custom）可能不存在——kimi 系无定义也能解析。
  const provider = findEffectiveProvider(providerId, c);
  if (provider && !isProviderEnabled(provider)) return null;

  const providerConfig = (provider?.config ?? {}) as { baseUrl?: string };
  const primaryModels = (c as { providerPrimaryModels?: Record<string, string> }).providerPrimaryModels;
  const modelId = (c.defaultModelId as string | undefined)
    ?? primaryModels?.[providerId]
    ?? (provider?.primaryModel as string | undefined);
  if (!modelId) return null;

  return buildLoopModel({
    providerId,
    baseUrl: providerConfig.baseUrl,
    apiKey,
    authType: provider?.authType as LoopProviderEnv['authType'],
    apiProtocol: provider?.apiProtocol as LoopProviderEnv['apiProtocol'],
    upstreamFormat: provider?.upstreamFormat as LoopProviderEnv['upstreamFormat'],
    maxOutputTokensParamName: provider?.maxOutputTokensParamName as LoopProviderEnv['maxOutputTokensParamName'],
    modelId,
    // 1.2.7：窗口口径接 preset/注册表真实值（如 deepseek 1M），
    // 查不到才走 buildLoopModel 内部的 200K 兜底。
    contextWindow: lookupModelContextLength(modelId),
  });
}

/**
 * 从 ProviderEnv（一次性调用点携带的显式 provider）构造解析结果。
 * env 缺 apiKey 时返回 null（与 resolveProviderEnv 的空白 key 拒绝一致）。
 */
export function resolveLoopModelFromEnv(
  env: LoopProviderEnv | undefined,
  modelId: string,
  providerId?: string,
): LoopModelResolution | null {
  if (!env?.apiKey || !env.apiKey.trim()) return null;
  // 1.2.7：env 不携带窗口——同样接注册表，保持与 resolveLoopModel 同口径。
  return buildLoopModel({ ...env, modelId, providerId, contextWindow: lookupModelContextLength(modelId) });
}
