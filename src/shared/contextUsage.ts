/**
 * Context 用量归一化 —— 唯一纯函数核心（PRD 0.2.32 §4.2）。
 *
 * 每个 runtime adapter 只负责喂「占用 tokens + runtime 报的窗口（可空）+ model」，
 * 窗口回退、百分比、windowSource 的判定全在这里，一处可单测。
 *
 * 依赖边界（红线）：`src/shared/**` 不得 import sidecar/renderer。窗口注册表查询
 * （`lookupModelContextLength`）通过 `lookupWindow` 注入，保持本文件纯净。
 */
import type { ContextUsage } from './types/context-usage';

/**
 * SDK `MODEL_CONTEXT_WINDOW_DEFAULT`。当 runtime 不报窗口、registry 也查不到时的兜底分母——
 * 与 sidecar 给非 Anthropic 模型回落的有效 auto-compact 窗口一致（agent-session.ts 注入
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 的同一语义）。约「窗口 − 13K」处触发自动压缩。
 */
export const SDK_DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * 去掉模型 id 的 `[1m]` 能力后缀。registry 的 key 是裸 id，查窗口前必须 strip——否则
 * 1M 窗口模型（`claude-opus-4-6[1m]` 等）查不到、错误回落 200K。与 SDK
 * `normalizeModelStringForAPI` / `applyContextWindowSuffix` 的 `[1m]` 语义对齐。
 */
export function stripModelSuffix(model: string | undefined | null): string | undefined {
  if (!model) return undefined;
  return model.replace(/\[1m\]$/i, '');
}

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export interface ComputeContextUsageInput {
  /** 当前占用 token（最近一次调用 input[+cache，按系]）。 */
  occupiedTokens: number;
  /** runtime 权威窗口（SDK `ModelUsage.contextWindow` / Codex `modelContextWindow`）；不报传 null。 */
  runtimeWindow: number | null;
  source: ContextUsage['source'];
  model?: string;
  /** 注入 `lookupModelContextLength`（返回 number | undefined）。保持 shared 纯净。 */
  lookupWindow: (model?: string) => number | null | undefined;
}

/**
 * 归一化为 `ContextUsage`。窗口优先级：runtime 自报 → registry 查到 → 200K 兜底。
 * 占用为负/NaN 视为 0；usedPercent 封顶 100（压缩前可能 >100% 的瞬时高估不外溢）。
 */
export function computeContextUsage(input: ComputeContextUsageInput): ContextUsage {
  const { occupiedTokens, runtimeWindow, source, model, lookupWindow } = input;

  const occupied = finitePositive(occupiedTokens) ? Math.round(occupiedTokens) : 0;

  let contextWindow: number;
  let windowSource: ContextUsage['windowSource'];

  const runtime = finitePositive(runtimeWindow);
  if (runtime !== null) {
    contextWindow = runtime;
    windowSource = 'runtime';
  } else {
    const looked = finitePositive(lookupWindow(stripModelSuffix(model)));
    if (looked !== null) {
      contextWindow = looked;
      windowSource = 'registry';
    } else {
      contextWindow = SDK_DEFAULT_CONTEXT_WINDOW;
      windowSource = 'default';
    }
  }

  const usedPercent = Math.min(100, (occupied / contextWindow) * 100);

  return {
    contextTokens: occupied,
    contextWindow,
    usedPercent,
    source,
    windowSource,
    model: model || undefined,
  };
}
