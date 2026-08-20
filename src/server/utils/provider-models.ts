/**
 * Provider 模型目录拉取与解析（M4d — 多模型接入：填 key 即用）。
 *
 * set-key 后自动调用：GET provider 的 /models 端点，把上游目录解析为
 * ModelEntity[]（source: 'discovered'），由调用方并入 config.presetCustomModels
 * （模型能力注册表 model-capabilities.ts 的第二优先级来源，见其数据源说明）。
 *
 * 两种上游响应形状统一容错解析（按条目字段，不按协议分支）：
 *   - OpenAI 格式兼容端点（OpenAI/DeepSeek/Moonshot/DashScope/GLM/SiliconFlow）：
 *     { object: 'list', data: [{ id, object, created, owned_by }] }
 *   - Anthropic 原生 /v1/models：{ data: [{ id, type, display_name, created_at }] }
 *
 * 失败语义：非 2xx / 网络失败 / 超时 / JSON 非法 → throw，由调用方降级
 * （set-key 的 key 保存不受拉列表失败影响）。
 */

import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';
import type { ModelEntity } from '../../shared/config-types';
import { anthropicAuthHeaders } from '../provider-probe';
import { withAbortSignal } from './cancellation';
import { getProxyForUrl } from './proxy-for-url';

/** 拉列表超时（set-key 的等待上界；失败不阻塞 key 保存）。 */
export const MODEL_LIST_TIMEOUT_MS = 10_000;

/** 单次并入 presetCustomModels 的条目上限（聚合平台 /models 可达千条）。 */
export const MODEL_LIST_MAX_ENTRIES = 200;

/** 模型列表端点推导：显式 modelListUrl 优先；否则按 baseUrl 形态补路径。 */
export function resolveModelListUrl(
  baseUrl: string | undefined,
  modelListUrl: string | undefined,
): string | null {
  if (modelListUrl) return modelListUrl.replace(/\/+$/, '');
  if (!baseUrl) return null;
  const normalized = baseUrl.replace(/\/+$/, '');
  // OpenAI 格式 baseUrl 通常自带 /v1（api.openai.com/v1 等）→ 直接补 /models；
  // anthropic 主机式 baseUrl（api.anthropic.com）→ 补 /v1/models。
  // 非标准版本前缀（如智谱 /api/paas/v4）需在 preset 里显式声明 modelListUrl。
  return normalized.endsWith('/v1') ? `${normalized}/models` : `${normalized}/v1/models`;
}

/** 把上游 /models 响应解析为 ModelEntity[]（有 id 即收录；display_name/name 作显示名）。 */
export function parseProviderModelsResponse(
  body: unknown,
  providerId?: string,
): ModelEntity[] {
  const models: ModelEntity[] = [];
  if (!body || typeof body !== 'object') return models;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return models;
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const model = typeof e.id === 'string' ? e.id.trim() : '';
    if (!model) continue;
    const displayName = typeof e.display_name === 'string' && e.display_name.trim()
      ? e.display_name.trim()
      : typeof e.name === 'string' && e.name.trim()
        ? e.name.trim()
        : undefined;
    models.push({
      model,
      modelName: displayName ?? model,
      modelSeries: providerId ?? 'custom',
      source: 'discovered',
    });
  }
  return models;
}

export type ModelListAuthType = 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';

export interface FetchProviderModelsResult {
  models: ModelEntity[];
  /** 上游 HTTP 状态码（2xx）。 */
  status: number;
}

/** GET /models 拉取模型目录（undici 直连，代理感知；超时经 withAbortSignal 上限）。 */
export async function fetchProviderModels(args: {
  url: string;
  apiKey: string;
  authType?: ModelListAuthType;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<FetchProviderModelsResult> {
  const { url, apiKey, authType, signal } = args;
  const timeoutMs = args.timeoutMs ?? MODEL_LIST_TIMEOUT_MS;
  // One-shot ProxyAgent——finally 关闭，重复失败的 set-key 不泄漏连接池
  // （与 provider-probe 的探测探针同一纪律）。
  let agent: ProxyAgent | undefined;
  try {
    return await withAbortSignal(
      signal,
      async (listSignal): Promise<FetchProviderModelsResult> => {
        const proxyUrl = getProxyForUrl(url);
        const init: Parameters<typeof undiciFetch>[1] & { dispatcher?: Dispatcher } = {
          method: 'GET',
          // auth 头与 SDK 探测一致（auth_token → Bearer；api_key → x-api-key；both 双发）。
          headers: anthropicAuthHeaders(authType, apiKey),
          signal: listSignal,
          // 与 provider-probe 同一安全纪律：不跟随重定向（防 https → 内网地址跳转）。
          redirect: 'error',
        };
        if (proxyUrl) {
          agent = new ProxyAgent(proxyUrl);
          init.dispatcher = agent;
        }
        const resp = await undiciFetch(url, init);
        const text = await resp.text();
        if (resp.status < 200 || resp.status >= 300) {
          throw new Error(`model list HTTP ${resp.status}: ${text.slice(0, 200)}`);
        }
        let body: unknown;
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          throw new Error('model list response is not valid JSON');
        }
        const models = parseProviderModelsResponse(body).slice(0, MODEL_LIST_MAX_ENTRIES);
        return { models, status: resp.status };
      },
      { timeoutMs },
    );
  } finally {
    if (agent) { try { await agent.close(); } catch { /* already closed */ } }
  }
}

export interface DiscoverProviderModelsResult {
  /** 并入条目数；undefined = 未触发（provider 不适用自动拉取）。 */
  modelsFetched?: number;
  /** 拉取/并入失败原因（降级提示用，不翻转 set-key 结果）。 */
  error?: string;
}

/**
 * set-key 后的模型目录发现编排：
 * 1. 仅显式声明 modelListUrl（deepseek 等）或 apiProtocol === 'openai' 的
 *    provider 触发——anthropic-api 等人工维护目录的 preset 不覆盖；
 * 2. 端点不可推导 → { }（调用方不提示）；
 * 3. 拉取失败 / 空目录 → { modelsFetched, error? }；
 * 4. 成功 → 经 persist 回调并入（原子写由调用方经 atomicModifyConfig 保证）。
 */
export async function discoverProviderModels(args: {
  provider: { modelListUrl?: unknown; apiProtocol?: unknown; authType?: unknown; config?: unknown };
  apiKey: string;
  persist: (models: ModelEntity[]) => Promise<void>;
  signal?: AbortSignal;
}): Promise<DiscoverProviderModelsResult> {
  const providerConfig = (args.provider.config ?? {}) as Record<string, unknown>;
  const baseUrl = typeof providerConfig.baseUrl === 'string' ? providerConfig.baseUrl : undefined;
  const explicit = typeof args.provider.modelListUrl === 'string' ? args.provider.modelListUrl : undefined;
  if (!explicit && args.provider.apiProtocol !== 'openai') return {};
  const listUrl = resolveModelListUrl(baseUrl, explicit);
  if (!listUrl) return { error: '无法推导模型列表端点' };
  try {
    const { models } = await fetchProviderModels({
      url: listUrl,
      apiKey: args.apiKey,
      authType: typeof args.provider.authType === 'string'
        ? (args.provider.authType as ModelListAuthType)
        : undefined,
      signal: args.signal,
    });
    if (models.length > 0) await args.persist(models);
    return { modelsFetched: models.length };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
