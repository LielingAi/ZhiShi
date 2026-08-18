/**
 * M2(D26)— 边界规则引擎(纯函数)+ pi beforeToolCall 接线。
 *
 * 用户定调:边界是**规则**(硬闸),不是权限审批体系——不做任何「问
 * 人」交互,规则就两种结果:allow / deny+reason(reason 经 pi 回注模
 * 型)。界内(env_exec 在研究环境内执行)全自动;结构性保证 = loop 里
 * 只注册环境侧工具,宿主执行类工具根本不存在。
 *
 * 规则是数据({@link BoundaryRule} 数组,每条 { name, check }),可测试
 * 可扩展;{@link evaluateBoundary} 按序求值,首个 deny 胜出。v1 规则:
 *
 *   a. tool-whitelist(结构性):注册表外 toolName 一律 deny——防模型幻
 *      觉出不存在的工具,也防未来宿主工具混入边界。
 *   b. env-ready:env_exec 的目标必须是已登记且可解析的环境——无 env
 *      entry / 解析失败 → deny「环境未就绪」。
 *   c. credential-leak(D14):command 文本命中宿主敏感材料模式
 *      (C:\Users\... 路径、~/.zhishi、私钥内容头、providerApiKeys)
 *      → deny+reason。凭据绝不进研究环境。
 *
 * 接线:{@link makeBoundaryHook} 返回 pi beforeToolCall 回调,挂在
 * runLoop 的 beforeToolCall 透传点(M1 已留);deny → { block:true,
 * reason }(pi 转成 isError tool result 回注模型)。
 */

import type { EnvironmentEntry } from '../../shared/config-types';
import { resolveExecTarget } from './env-exec';
import { ENV_BG_TOOL_NAME } from './bg-exec';
import { ENV_EXEC_TOOL_NAME } from './tools';
import type { BeforeToolCallHook } from './loop';

// ---------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------

export interface BoundaryContext {
  toolName: string;
  args: unknown;
  /** 当前 loop 绑定的环境条目(env_exec 的目标);未绑定时为 null。 */
  env: EnvironmentEntry | null;
}

export type BoundaryDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string };

/**
 * 单条规则:返回 deny reason 字符串,或 undefined = 通过。
 * 规则必须是同步纯函数(beforeToolCall 是同步拦截点,规则不做 I/O)。
 */
export interface BoundaryRule {
  name: string;
  check: (ctx: BoundaryContext) => string | undefined;
}

export const ALLOW: BoundaryDecision = { decision: 'allow' };

/** 按序求值,首个 deny 胜出;全过 → allow。 */
export function evaluateBoundary(ctx: BoundaryContext, rules: BoundaryRule[]): BoundaryDecision {
  for (const rule of rules) {
    const reason = rule.check(ctx);
    if (reason !== undefined) {
      return { decision: 'deny', reason: `[boundary:${rule.name}] ${reason}` };
    }
  }
  return ALLOW;
}

// ---------------------------------------------------------------------------
// v1 rules
// ---------------------------------------------------------------------------

/** a. 工具白名单(结构性)。 */
export function toolWhitelistRule(allowedTools: string[]): BoundaryRule {
  const allowed = new Set(allowedTools);
  return {
    name: 'tool-whitelist',
    check: (ctx) =>
      allowed.has(ctx.toolName)
        ? undefined
        : `工具 "${ctx.toolName}" 不在本 loop 的注册表内(结构性白名单:${[...allowed].join(', ')})。`,
  };
}

/** b. env_exec 目标必须是已登记且可解析的环境。 */
export function envReadyRule(): BoundaryRule {
  return {
    name: 'env-ready',
    check: (ctx) => {
      if (ctx.toolName !== ENV_EXEC_TOOL_NAME && ctx.toolName !== ENV_BG_TOOL_NAME) return undefined;
      if (!ctx.env) {
        return '环境未就绪:本 loop 未绑定研究环境,先 zhishi env up / 选定环境。';
      }
      // 三通道同判:vm/ssh 走 ssh 解析,docker 走 container 定位锚,
      // 断网 VM 走 guest 通道。guest 通道要求 passwordRef 在场(vmrun 只认
      // 密码认证)——早 deny 给指引,比 exec 时才失败省一轮往返。
      const resolved = resolveExecTarget(ctx.env);
      if (!resolved.ok) {
        return `环境未就绪:${resolved.error}`;
      }
      const t = resolved.execTarget;
      if (t.channel === 'guest' && !t.entry.passwordRef) {
        return '环境未就绪:断网隔离 VM 的 guest-exec 需要密码引用——给环境条目配 passwordRef(如 env:ZHISHI_VM_PW)并设好该环境变量(D-T4:不落盘)。';
      }
      return undefined;
    },
  };
}

/** D14 凭据/宿主敏感材料模式(command 文本命中即 deny)。 */
export const CREDENTIAL_LEAK_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /[A-Za-z]:\\Users\\/i, label: '宿主机用户目录路径' },
  { pattern: /\.zhishi\b/i, label: '~/.zhishi 应用数据路径' },
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, label: '私钥内容头' },
  { pattern: /providerApiKeys/i, label: 'providerApiKeys 凭据字段' },
];

/** c. 凭据不泄进环境(D14)。 */
export function credentialLeakRule(): BoundaryRule {
  return {
    name: 'credential-leak',
    check: (ctx) => {
      if (ctx.toolName !== ENV_EXEC_TOOL_NAME && ctx.toolName !== ENV_BG_TOOL_NAME) return undefined;
      const command = (ctx.args as { command?: unknown } | undefined)?.command;
      if (typeof command !== 'string') return undefined;
      for (const { pattern, label } of CREDENTIAL_LEAK_PATTERNS) {
        if (pattern.test(command)) {
          return `命令文本命中宿主敏感材料(${label}),凭据/宿主路径绝不进研究环境(D14)。`;
        }
      }
      return undefined;
    },
  };
}

export interface DefaultBoundaryOptions {
  /** 当前 loop 注册的工具名(默认仅 env_exec)。 */
  allowedTools?: string[];
}

/** v1 默认规则集(就这三条,别扩)。 */
export function buildDefaultBoundaryRules(options: DefaultBoundaryOptions = {}): BoundaryRule[] {
  return [
    toolWhitelistRule(options.allowedTools ?? [ENV_EXEC_TOOL_NAME, ENV_BG_TOOL_NAME]),
    envReadyRule(),
    credentialLeakRule(),
  ];
}

// ---------------------------------------------------------------------------
// Wiring — pi beforeToolCall hook
// ---------------------------------------------------------------------------

/**
 * 组装 runLoop 的 beforeToolCall 边界钩子。deny → { block:true, reason }
 * (pi 回注模型);allow → undefined(放行)。规则求值绝不 throw——
 * 规则异常按 deny 处理(硬闸宁可错杀)。
 */
export function makeBoundaryHook(
  env: EnvironmentEntry | null,
  options: DefaultBoundaryOptions & { rules?: BoundaryRule[] } = {},
): BeforeToolCallHook {
  const rules = options.rules ?? buildDefaultBoundaryRules(options);
  return async ({ toolCall, args }) => {
    let decision: BoundaryDecision;
    try {
      decision = evaluateBoundary({ toolName: toolCall.name, args, env }, rules);
    } catch (err) {
      decision = {
        decision: 'deny',
        reason: `[boundary:internal] 规则求值异常,按 deny 处理:${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (decision.decision === 'deny') {
      console.warn(`[boundary] deny ${toolCall.name}: ${decision.reason}`);
      return { block: true, reason: decision.reason };
    }
    return undefined;
  };
}
