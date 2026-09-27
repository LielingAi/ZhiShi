/**
 * M3(D26)— output-guard:afterToolCall 输出审计(反向扫描)。
 *
 * 与 boundary 同构:规则数组 + evaluate,挂在 pi 的 afterToolCall(M1
 * 已留透传点)。boundary 管「进去什么」(deny),output-guard 管「出来
 * 什么」——结果已经产生,不是 deny 而是**净化**:命中宿主敏感材料的
 * 文本块整体替换为 [redacted] 标记,模型只能看到净化后的内容。
 *
 * v1 一条规则:credential-echo——环境回传文本命中:
 *   - 私钥内容头(BEGIN ... PRIVATE KEY)
 *   - apiKey 形态字符串(sk-… 前缀、key=value 赋值形态)
 *   - ~/.zhishi 路径内容 / 宿主机用户目录路径 / providerApiKeys
 * 命中即整块净化(保守:v1 不做局部掩码——敏感材料周边上下文往往同
 * 样敏感,整块替换比掩码遗漏更安全)。
 */

import type { ImageContent, TextContent } from '@earendil-works/pi-ai';

import type { AfterToolCallHook } from './loop';

// ---------------------------------------------------------------------------
// Rule engine(与 boundary 同构)
// ---------------------------------------------------------------------------

export interface OutputGuardContext {
  toolName: string;
  isError: boolean;
}

/**
 * 单条输出审计规则:返回净化原因(label),或 undefined = 未命中。
 * 同步纯函数,无 I/O。
 */
export interface OutputGuardRule {
  name: string;
  check: (text: string, ctx: OutputGuardContext) => string | undefined;
}

export interface OutputGuardEvaluation {
  /** 净化后文本(未命中 = 原文)。 */
  text: string;
  redacted: boolean;
  /** 命中的规则名列表(审计)。 */
  reasons: string[];
}

/** 按序求值,收集全部命中(审计完整性),任一命中即净化。 */
export function evaluateOutputGuard(
  text: string,
  ctx: OutputGuardContext,
  rules: OutputGuardRule[],
): OutputGuardEvaluation {
  const reasons: string[] = [];
  for (const rule of rules) {
    const label = rule.check(text, ctx);
    if (label !== undefined) reasons.push(`[guard:${rule.name}] ${label}`);
  }
  if (reasons.length === 0) return { text, redacted: false, reasons: [] };
  return {
    text: `[redacted: 环境回传内容命中宿主敏感材料(${reasons.join(';')}),已净化——结果仍存在,但内容不进入对话。]`,
    redacted: true,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// v1 rule: credential-echo
// ---------------------------------------------------------------------------

/** 宿主敏感材料模式(环境回传方向;与 boundary 的 D14 入向扫描互补)。 */
export const CREDENTIAL_ECHO_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, label: '私钥内容头' },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/, label: 'API key 形态字符串(sk-*)' },
  { pattern: /(?:api[_-]?key|token|secret)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-+/=]{20,}/i, label: 'key/token 赋值形态' },
  { pattern: /\.zhishi\b/i, label: '~/.zhishi 应用数据路径' },
  { pattern: /[A-Za-z]:\\Users\\/i, label: '宿主机用户目录路径' },
  { pattern: /providerApiKeys/i, label: 'providerApiKeys 凭据字段' },
];

export function credentialEchoRule(): OutputGuardRule {
  return {
    name: 'credential-echo',
    check: (text) => {
      for (const { pattern, label } of CREDENTIAL_ECHO_PATTERNS) {
        if (pattern.test(text)) return label;
      }
      return undefined;
    },
  };
}

export function buildDefaultOutputGuardRules(): OutputGuardRule[] {
  return [credentialEchoRule()];
}

// ---------------------------------------------------------------------------
// Wiring — pi afterToolCall hook
// ---------------------------------------------------------------------------

/**
 * 组装 runLoop 的 afterToolCall 输出审计钩子。逐文本块扫描,命中即
 * 整块替换为 [redacted];任一文本块被净化则返回 { content } 覆盖(pi
 * 合并语义:未提供的字段保持原执行结果)。图片块原样透传。规则异常
 * 按净化处理(与 boundary 同向:宁可错杀)。
 */
export function makeOutputGuardHook(
  options: { rules?: OutputGuardRule[] } = {},
): AfterToolCallHook {
  const rules = options.rules ?? buildDefaultOutputGuardRules();
  return async ({ toolCall, result, isError }) => {
    let changed = false;
    const content: (TextContent | ImageContent)[] = [];
    for (const block of result.content) {
      if (block.type !== 'text') {
        content.push(block);
        continue;
      }
      let evaluation: OutputGuardEvaluation;
      try {
        evaluation = evaluateOutputGuard(
          block.text,
          { toolName: toolCall.name, isError },
          rules,
        );
      } catch (err) {
        evaluation = {
          text: `[redacted: 输出审计规则异常,按净化处理:${err instanceof Error ? err.message : String(err)}]`,
          redacted: true,
          reasons: ['[guard:internal]'],
        };
      }
      if (evaluation.redacted) {
        changed = true;
        console.warn(`[output-guard] redacted ${toolCall.name}: ${evaluation.reasons.join('; ')}`);
        content.push({ type: 'text', text: evaluation.text });
      } else {
        content.push(block);
      }
    }
    return changed ? { content } : undefined;
  };
}
