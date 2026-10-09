/**
 * M1 — pi(pi-ai 0.84)模型/provider 解析层的 config 耦合半边。
 *
 * 最小拆（zhishi-loop-core 抽包）后，本文件只剩「从 config.json 自解析」的
 * 两个函数（依赖 admin-config / model-capabilities / config-types）；
 * 纯构造半边（buildLoopModel / staticApiKeyAuth / isKimiCodingProvider /
 * normalizeBaseUrl / KIMI_CODING_BASE_URL / LoopProviderEnv /
 * LoopModelResolution / BuildLoopModelOptions）已迁至
 * packages/zhishi-loop-core/src/pi-model.ts，此处 re-export 保持既有
 * `loop/pi-provider` 引用路径零改动。
 *
 * 解析语义：defaultProviderId（缺省回落 providerApiKeys 首键）→ apiKey；
 * defaultModelId → providerPrimaryModels[id] → provider.primaryModel。
 * 语义参照 resolveWorkspaceConfig（admin-config.ts）的 provider/model 解析。
 */

import {
  findEffectiveProvider,
  loadConfig,
  resolveKimiApiKey,
  type AdminAppConfig,
} from '../utils/admin-config';
import { lookupModelCapability } from '../utils/model-capabilities';
import { isProviderEnabled } from '../../shared/config-types';
import {
  buildLoopModel,
  isKimiCodingProvider,
  type LoopModelResolution,
  type LoopProviderEnv,
} from 'zhishi-loop-core/pi-model';

// 纯半边符号 re-export（最小拆：实现已迁 zhishi-loop-core/pi-model）
export {
  buildLoopModel,
  isKimiCodingProvider,
  normalizeBaseUrl,
  staticApiKeyAuth,
  KIMI_CODING_BASE_URL,
} from 'zhishi-loop-core/pi-model';
export type {
  BuildLoopModelOptions,
  LoopModelResolution,
  LoopProviderEnv,
} from 'zhishi-loop-core/pi-model';

/**
 * 从 config.json 解析默认 loop 运行时。返回 null = 无可用 provider/key
 * （调用方按「模型不可用」失败语义处理，不 throw）。
 */
export function resolveLoopModel(config?: AdminAppConfig): LoopModelResolution | null {
  const c = config ?? loadConfig();
  const keys = (c.providerApiKeys ?? {}) as Record<string, string>;

  let providerId = (c.defaultProviderId as string | undefined)
    ?? Object.keys(keys).find((id) => typeof keys[id] === 'string' && keys[id].trim() !== '');
  if (!providerId) return null;

  let apiKey = keys[providerId];
  // 1.3.0：kimi 系模糊兜底——defaultProviderId 可能是 'kimi'（内置合成
  // 条目），而 key 实际配在 moonshot-coding 等 id 下（1.2.9 显示层已按
  // 此口径，这里与 /chat/model 切换路径一起对齐）。
  if ((!apiKey || !apiKey.trim()) && isKimiCodingProvider(providerId)) {
    const kimi = resolveKimiApiKey(c);
    if (kimi) {
      providerId = kimi.providerId;
      apiKey = kimi.apiKey;
    }
  }
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

  // 1.9.6：窗口/输出预算同口径接 preset/注册表真实值（如 deepseek 1M 窗口、
  // 384K 输出）——此前 maxOutputTokens 漏接（只传了 maxOutputTokensParamName
  // 字段名），非 kimi provider 一律落 buildLoopModel 的 8192 缺省，deepseek-flash
  // 这类恒思考模型 thinking 烧穿 8192 → stopReason=length 零产出假死（轨迹实证：
  // 连续空回合、用户被迫反复手敲「继续」）。查不到才走 buildLoopModel 内部的
  // 200K/8192 兜底。
  const cap = lookupModelCapability(modelId);
  return buildLoopModel({
    providerId,
    baseUrl: providerConfig.baseUrl,
    apiKey,
    authType: provider?.authType as LoopProviderEnv['authType'],
    apiProtocol: provider?.apiProtocol as LoopProviderEnv['apiProtocol'],
    upstreamFormat: provider?.upstreamFormat as LoopProviderEnv['upstreamFormat'],
    maxOutputTokensParamName: provider?.maxOutputTokensParamName as LoopProviderEnv['maxOutputTokensParamName'],
    modelId,
    contextWindow: cap?.contextLength,
    maxOutputTokens: cap?.maxOutputTokens,
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
  // 1.9.6：maxOutputTokens 同口径（env 显式值优先，注册表兜底）。
  const cap = lookupModelCapability(modelId);
  return buildLoopModel({
    ...env,
    modelId,
    providerId,
    contextWindow: cap?.contextLength,
    maxOutputTokens: env.maxOutputTokens ?? cap?.maxOutputTokens,
  });
}
