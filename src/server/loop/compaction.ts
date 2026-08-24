/**
 * M3(D26)→1.2.7(A)— 安全场景上下文压缩(段级重写)。
 *
 * 接 pi 的 token 估算,阈值判定与压缩策略自研——安全场景的压缩是定制
 * 点:研究状态(已验证事实/当前假设/死路清单)必须在压缩中存活。
 *
 * 1.2.7 重写为段级压缩(docs/design/1.2.7-design.md §二,消费
 * context-manager.ts):超阈值时不再走固定档位,按分段构成**采样锚定**
 * ——必保 = anchor 段 ∪ 最近 N 段当前阶段段 ∪ key 段;可压缩集从最老
 * 段起逐个 stub 化直到纯估算 ≤ 目标。布局产物:anchor 原文在头、
 * stub/key 段居中、最近当前阶段段原文在尾(注意力「去中间」最小化)。
 * 仍不达标(key 段本身超阈值)→ 对保留消息做逐条正文截断(沿用 1.2.6
 * 第二档 b)→ 最终仍超则明确日志引导 /reset。
 *
 * 裁后重估口径(§2.6):裁后一律纯字符估算(estimateMessagesTokens),
 * 不吃旧 assistant 的 usage 锚——usage 锚只在未裁判定
 * ({@link evaluateCompaction} 首判)时用(API 实测最准);1.2.6 的
 * 「usage 锚定使裁后重估失效」由此修复。
 *
 * 压缩只影响**当次 LLM 上下文**(经 runLoop 的 transformContext 透传,
 * pi 在 convertToLlm 前应用);jsonl 持久化保留全量(语义不动),触发
 * 时由调用方经 markLoopSessionCompacted 在 meta 行打 compactedAt 标记。
 *
 * 存活契约(KEY_MESSAGE_PATTERNS/hasErrorSignal/isKeyMessage 等)与
 * tool 配对闭包(expandToolPairs)实现已迁到 context-manager.ts(叶子
 * 模块,no-circular 红线),此处转发导出保持既有引用兼容。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { estimateMessageTokens, estimateMessagesTokens, compactBySegments, segmentContext } from './context-manager';

export {
  KEY_MESSAGE_PATTERNS,
  expandToolPairs,
  hasConstrainedFact,
  hasErrorSignal,
  isKeyMessage,
  messageText,
  toolCallIdsOf,
  toolResultCallId,
} from './context-manager';

// ---------------------------------------------------------------------------
// Policy & 阈值判定(纯函数)
// ---------------------------------------------------------------------------

export interface CompactionPolicy {
  /** 模型上下文窗口(token)。 */
  contextWindow: number;
  /** 触发阈值:估算 tokens > contextWindow × ratio 即压缩(默认 0.8)。 */
  thresholdRatio?: number;
  /**
   * 系统提示长度(字符,1.2.6)——纳入阈值估算。pi 的字符启发式
   * (estimateTokens,chars/4)只算消息数组,系统提示是上下文的大头
   * (安全场景五段+skills)却不在其中,纯估算路径会系统性低估。
   * 仅在纯估算路径计入:usageTokens>0 时 tokens 来自 API 实测 input
   * (已含系统提示),再加会重复计数。可选,缺省 0(向后兼容)。
   */
  systemPromptChars?: number;
}

export const DEFAULT_THRESHOLD_RATIO = 0.8;

export interface CompactionEvaluation {
  compact: boolean;
  tokens: number;
  threshold: number;
}

/** 最后一条有效 assistant(usage 锚):stopReason 非 aborted/error 且 total>0。 */
function lastUsageAnchor(messages: AgentMessage[]): { index: number; total: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as {
      role?: string; stopReason?: string;
      usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    };
    if (m.role !== 'assistant' || !m.usage) continue;
    if (m.stopReason === 'aborted' || m.stopReason === 'error') continue;
    const u = m.usage;
    const total = u.totalTokens ?? ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
    if (total > 0) return { index: i, total };
  }
  return null;
}

/**
 * 阈值判定(未裁首判):usage 锚(API 实测 input,最准) + 锚后新消息的
 * CJK 校准估算。注意不能用 pi 的 estimateContextTokens——它的尾部估算是
 * chars/4,活体实测(1.2.7,K2.7):锚在早期消息时,226K 估算 vs 521878
 * 实报,低估 2.3 倍直接撞 400。无 usage 的纯估算路径同走校准口径(含
 * 系统提示折算)。裁后重估同口径,见 transform 内 estimateMessagesTokens。
 */
export function evaluateCompaction(messages: AgentMessage[], policy: CompactionPolicy): CompactionEvaluation {
  const ratio = policy.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
  const threshold = Math.floor(policy.contextWindow * ratio);
  const anchor = lastUsageAnchor(messages);
  if (anchor) {
    // usage 锚的 total 已含系统提示(API 实测 input),只补锚后新消息。
    let trailing = 0;
    for (let i = anchor.index + 1; i < messages.length; i++) trailing += estimateMessageTokens(messages[i]);
    const tokens = anchor.total + trailing;
    return { compact: tokens > threshold, tokens, threshold };
  }
  const tokens = estimateMessagesTokens(messages, policy.systemPromptChars ?? 0);
  return { compact: tokens > threshold, tokens, threshold };
}

export interface CompactionTransformInfo extends CompactionEvaluation {
  prunedCount: number;
  /** 被 stub 化的段数(1.2.7 段级压缩)。 */
  stubbedSegments?: number;
  /**
   * 第二档(逐条正文截断)走完仍超阈值——压缩已尽力,下一次 LLM 调用
   * 仍可能 API 400;调用方/日志据此引导用户 /reset 开新会话。
   */
  stillOverThreshold?: boolean;
}

/** 单条消息正文截断(string content 与 text/thinking 块;toolCall 不动)。 */
export function truncateMessageText(message: AgentMessage, maxChars: number): AgentMessage {
  const marker = '\n…[已截断]';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    if (content.length <= maxChars) return message;
    return { ...message, content: content.slice(0, maxChars) + marker } as AgentMessage;
  }
  if (!Array.isArray(content)) return message;
  const blocks = content.map((block) => {
    if (!block || typeof block !== 'object') return block;
    const b = block as Record<string, unknown>;
    if (typeof b.text === 'string' && b.text.length > maxChars) {
      return { ...b, text: b.text.slice(0, maxChars) + marker };
    }
    if (typeof b.thinking === 'string' && b.thinking.length > maxChars) {
      return { ...b, thinking: b.thinking.slice(0, maxChars) + marker };
    }
    return block;
  });
  return { ...message, content: blocks } as AgentMessage;
}

// ---------------------------------------------------------------------------
// Transform(接 runLoop 的 transformContext)
// ---------------------------------------------------------------------------

/**
 * 组装 runLoop 的 transformContext:未超阈值原样透传;超阈值走段级
 * 采样锚定压缩(context-manager)。裁后重估一律纯字符估算(§2.6);
 * 仍超阈值走第二档:对保留消息逐条正文截断(按阈值反推字符预算均摊),
 * 依旧装不下时打明确日志引导 /reset——不留「直接 API 400」的无升级
 * 路径。onCompact 回调(可选)用于审计/meta 标记——同步调用,不
 * await。裁剪绝不 throw:任何异常原样返回输入(丢上下文比炸 loop
 * 安全)。
 */
export function makeCompactionTransform(
  policy: CompactionPolicy,
  onCompact?: (info: CompactionTransformInfo) => void,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  return async (messages) => {
    try {
      const evaluation = evaluateCompaction(messages, policy);
      if (!evaluation.compact) return messages;

      const systemPromptChars = policy.systemPromptChars ?? 0;
      const segments = segmentContext(messages);
      const compacted = compactBySegments(messages, segments, evaluation.threshold, systemPromptChars);
      let pruned = compacted.messages;
      let after = estimateMessagesTokens(pruned, systemPromptChars);
      if (after > evaluation.threshold) {
        // 第二档 b:逐条正文截断——保留集(anchor/当前阶段/key 段)不动
        // 结构,只压每条的体积;预算按保守口径从阈值反推(×2 字符/tok,
        // 中英混合偏保守,1.2.7 活体校准)、均摊到每条(阈值含系统提示,
        // 先扣除再折算字符)。
        const tokenBudget = Math.max(1, evaluation.threshold - Math.ceil(systemPromptChars / 2));
        const perMessageCap = Math.max(200, Math.floor((tokenBudget * 2) / Math.max(1, pruned.length)));
        pruned = pruned.map((m) => truncateMessageText(m, perMessageCap));
        after = estimateMessagesTokens(pruned, systemPromptChars);
      }
      const stillOver = after > evaluation.threshold;
      console.warn(
        `[compaction] context ${evaluation.tokens} tokens > threshold ${evaluation.threshold} ` +
        `→ stubbed ${compacted.stubbedSegments} segments (pruned ${compacted.prunedCount} messages, kept ${pruned.length})` +
        (stillOver ? `;仍超阈值(${after} > ${evaluation.threshold})` : ''),
      );
      if (stillOver) {
        console.error(
          `[compaction] 第二档截断后仍超阈值(${after} > ${evaluation.threshold})——` +
          '下一次 LLM 调用可能因上下文过长被 API 拒绝(400),建议 /reset 开新会话再续。',
        );
      }
      onCompact?.({
        ...evaluation,
        prunedCount: compacted.prunedCount,
        stubbedSegments: compacted.stubbedSegments,
        stillOverThreshold: stillOver,
      });
      return pruned;
    } catch (err) {
      console.warn(`[compaction] transform 异常,原样透传:${err instanceof Error ? err.message : String(err)}`);
      return messages;
    }
  };
}
