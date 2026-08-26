/**
 * 模型选择器过滤（1.3.6，纯函数）：状态栏模型切换 overlay 只显示「已配
 * key 且未禁用」的 provider 模型——显示=可运行，与运行链路口径一致。
 *
 * hasApiKey 由服务端 model/list 返回（admin-api.ts 的 model/list：
 * 普通 provider 查 providerApiKeys[id]，kimi 内置条目按 1.2.9 的模糊匹配
 * resolveKimiApiKey 同款规则算出）——GUI 不再重复实现 key 判定，直接
 * 消费该字段。
 *
 * 例外：当前生效模型即使其 provider 未配 key/被禁用也保留显示
 * （用户看得见「当前在跑什么」；一切走它即从列表消失）。
 */

import type { ModelProvider } from '../client/api';

export interface ModelPickerProvider {
  id: string;
  models: Array<{ model: string; contextLength?: number }>;
}

export function pickModelPickerProviders(
  providers: ModelProvider[],
  currentModel: string | undefined,
): ModelPickerProvider[] {
  const out: ModelPickerProvider[] = [];
  for (const p of providers) {
    const hasKey = p.hasApiKey === true;
    const kept = p.models.filter(
      (m) => (p.enabled !== false && hasKey) || (currentModel !== undefined && m.model === currentModel),
    );
    if (kept.length > 0) {
      out.push({
        id: p.id,
        models: kept.map((m) => ({ model: m.model, contextLength: m.contextLength })),
      });
    }
  }
  return out;
}
