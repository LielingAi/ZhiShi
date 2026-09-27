/**
 * M1 — 一次性 LLM 调用（one-shot）：pi-ai completeSimple 的薄包装。
 *
 * 替代原 Claude Agent SDK query() 单发路径（title-generator /
 * distill-runner / provider-verify）：无子进程、无 bridge 回环、无会话
 * 持久化——一次 HTTP 调用拿最终文本。pi 对 OpenAI 协议 provider 原生
 * 支持，原 SDK 路径的 one-shot bridge 机制在本路径整体退役。
 *
 * 错误语义：
 * - {@link oneShotResult} 返回 { ok:true, text } | { ok:false, error }，
 *   error 携带上游错误文本（供 provider-verify 分类）。
 * - {@link oneShot} 是便捷封装：失败/超时 → null（title/distill 语义）。
 * - pi 把 LLM 失败编码为 stopReason "error" 的 AssistantMessage
 *   （不 throw），这里统一翻出成 error 分支。
 */

import type { Api, Model, Models } from '@earendil-works/pi-ai';

export interface OneShotOptions {
  prompt: string;
  system?: string;
  model: Model<Api>;
  /** pi Models 集合（与 model 同出 resolveLoopModel / buildLoopModel）。 */
  models: Models;
  apiKey?: string;
  maxTokens?: number;
  /** 调用方超时控制（Promise.race 之外的真实中断）。 */
  signal?: AbortSignal;
}

export type OneShotResult = { ok: true; text: string } | { ok: false; error: string };

/** 从 AssistantMessage content 提取全部 text 块。 */
export function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

export async function oneShotResult(options: OneShotOptions): Promise<OneShotResult> {
  try {
    const message = await options.models.completeSimple(
      options.model,
      {
        systemPrompt: options.system,
        messages: [{ role: 'user', content: options.prompt, timestamp: Date.now() }],
      },
      {
        apiKey: options.apiKey,
        maxTokens: options.maxTokens,
        signal: options.signal,
      },
    );
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      return { ok: false, error: message.errorMessage ?? `LLM call ${message.stopReason}` };
    }
    const text = extractText(message.content);
    if (!text.trim()) {
      return { ok: false, error: `empty response (stopReason=${message.stopReason})` };
    }
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 便捷封装：成功返回文本，任何失败返回 null（静默语义，同 SDK 单发路径）。 */
export async function oneShot(options: OneShotOptions): Promise<string | null> {
  const result = await oneShotResult(options);
  return result.ok ? result.text : null;
}
