/**
 * M3(D26)— 安全场景上下文压缩。
 *
 * 接 pi 的 token 估算(estimateContextTokens,保守字符启发式),阈值判
 * 定与裁剪策略自研——安全场景的压缩是定制点:研究状态(已验证事实/
 * 当前假设/死路清单)必须在压缩中存活。v1 策略**宁可保守(多留)不
 * 可激进**:
 *
 *   保留 = 首条 user(任务锚)
 *        ∪ 所有关键消息(KEY_MESSAGE_PATTERNS:env_exec 非零 exit /
 *          error / CVE 编号 / flag / [redacted]——死路与突破口都在这里)
 *        ∪ 最近 keepRecentTurns 轮(从末尾往前数 N 个 user 消息起全留)
 *   砍掉 = 其余早期非关键消息,并在首条 user 之后插一条 user 占位消息
 *          说明省略量(模型能理解上下文空洞;占位是合法消息,不伪造
 *          assistant 发言)。
 *
 * 压缩只影响**当次 LLM 上下文**(经 runLoop 的 transformContext 透传,
 * pi 在 convertToLlm 前应用);jsonl 持久化保留全量(M2 语义不动),
 * 触发时由调用方经 {@link markLoopSessionCompacted} 在 meta 行打
 * compactedAt 标记。
 *
 * 1.2.6 深化:阈值估算纳入系统提示长度(policy.systemPromptChars,纯
 * 字符估算路径才计——usageTokens>0 时 API 实测已含);裁完仍超阈值走
 * 第二档(keepRecentTurns=1 再裁 → 逐条正文截断 → 仍超则明确日志引导
 * /reset),不留「直接 API 400」的无升级路径。
 */

import { estimateContextTokens, type AgentMessage } from '@earendil-works/pi-agent-core';

// ---------------------------------------------------------------------------
// Policy & key-message detection(纯函数)
// ---------------------------------------------------------------------------

export interface CompactionPolicy {
  /** 模型上下文窗口(token)。 */
  contextWindow: number;
  /** 触发阈值:估算 tokens > contextWindow × ratio 即压缩(默认 0.8)。 */
  thresholdRatio?: number;
  /** 完整保留的最近轮数(一轮 = 一条 user 消息起到下一条 user 前;默认 4)。 */
  keepRecentTurns?: number;
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
export const DEFAULT_KEEP_RECENT_TURNS = 4;

/**
 * 关键消息标记:研究状态存活线。exitCode≠0(死路/障碍)、error、
 * CVE 编号(目标漏洞)、flag/密钥形态(突破证据)、[redacted](审计痕迹)。
 *
 * error 不走单纯 `\berror\b`(1.2.6 收窄):"no error"/"error handling"
 * 之类的噪音会让 keep 集膨胀裁不动——改走 hasErrorSignal:逐行剥掉
 * 良性搭配(否定式「no/without/zero error」、「error handling/handler」
 * 等)后再判 error 命中,剥完仍命中才算真错误信号。
 */
export const KEY_MESSAGE_PATTERNS: ReadonlyArray<RegExp> = [
  /exit=[1-9]\d*/,
  /CVE-\d{4}-\d{4,}/i,
  /flag\{[^}]*\}/i,
  /\[redacted/,
];

const ERROR_SIGNAL = /\berror\b/i;
/** 良性 error 搭配(剥离后再判):否定式与错误处理机制名。 */
const ERROR_BENIGN = /\b(?:no|not|without|zero|0)\s+errors?\b|\berrors?\s*[-_]?(?:handling|handler|handlers|handle)\b|\berror-free\b/gi;

/** error 信号判定:逐行剥离良性搭配后仍命中 \berror\b 才算(不误裁真错误)。 */
export function hasErrorSignal(text: string): boolean {
  for (const line of text.split('\n')) {
    if (ERROR_SIGNAL.test(line.replace(ERROR_BENIGN, ''))) return true;
  }
  return false;
}

/** 提取消息的全部文本(user 字符串 content / 各类 content 块)。 */
export function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const b = block as Record<string, unknown>;
      if (typeof b.text === 'string') return b.text;
      if (typeof b.thinking === 'string') return b.thinking;
      if (b.type === 'toolCall') return `${String(b.name ?? '')} ${JSON.stringify(b.arguments ?? {})}`;
      return '';
    })
    .join('\n');
}

/** 关键消息判定:toolResult 一律先看内容;任何角色文本命中标记即关键。 */
export function isKeyMessage(message: AgentMessage): boolean {
  const text = messageText(message);
  if (!text) return false;
  return KEY_MESSAGE_PATTERNS.some((p) => p.test(text)) || hasErrorSignal(text);
}

// ---------------------------------------------------------------------------
// Prune(保守裁剪,纯函数)
// ---------------------------------------------------------------------------

export interface PruneResult {
  messages: AgentMessage[];
  /** 被省略的消息数(0 = 未裁剪)。 */
  prunedCount: number;
}

/** 最近 N 轮的起始下标(从末尾往前数第 N 条 user 消息;不足则 0)。 */
export function recentTurnsStartIndex(messages: AgentMessage[], keepRecentTurns: number): number {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      seen++;
      if (seen >= keepRecentTurns) return i;
    }
  }
  return 0;
}

/** 消息里 toolCall 块的 id 集合(assistant)。 */
export function toolCallIdsOf(message: AgentMessage): string[] {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: 'toolCall'; id: string } =>
      !!b && typeof b === 'object' && (b as { type?: string }).type === 'toolCall' && typeof (b as { id?: unknown }).id === 'string')
    .map((b) => b.id);
}

/** toolResult 消息对应的 toolCallId。 */
export function toolResultCallId(message: AgentMessage): string | undefined {
  if (message.role !== 'toolResult') return undefined;
  const id = (message as { toolCallId?: unknown }).toolCallId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * tool 配对闭包:tool_use 与 tool_result 必须成对存活——只留一半会让
 * Anthropic API 报 "tool_call_id is not found"(实测)。反复扩张直到
 * 不动点:kept toolResult ⇒ 其 toolCall 所在 assistant 也 keep;
 * kept toolCall ⇒ 其 toolResult 也 keep。
 */
export function expandToolPairs(messages: AgentMessage[], keep: Set<number>): Set<number> {
  const result = new Set(keep);
  let changed = true;
  while (changed) {
    changed = false;
    const keptCallIds = new Set<string>();
    for (const i of result) {
      for (const id of toolCallIdsOf(messages[i])) keptCallIds.add(id);
    }
    for (let i = 0; i < messages.length; i++) {
      const callId = toolResultCallId(messages[i]);
      if (callId === undefined) continue;
      const hasResult = result.has(i);
      const hasCall = keptCallIds.has(callId);
      if (hasResult && !hasCall) {
        // 找回携带该 toolCall 的 assistant 消息
        for (let j = 0; j < messages.length; j++) {
          if (!result.has(j) && toolCallIdsOf(messages[j]).includes(callId)) {
            result.add(j);
            changed = true;
          }
        }
      } else if (!hasResult && hasCall) {
        result.add(i);
        changed = true;
      }
    }
  }
  return result;
}

/**
 * 保守裁剪:任务锚(首条 user)+ 关键消息 + 最近 N 轮的并集(经
 * tool 配对闭包补全),相对顺序不变;砍掉的部分用一条 user 占位消息
 * 说明(插在保留序列最前、首条 user 之后)。不砍则原样返回
 * (prunedCount=0)。
 */
export function pruneLoopContext(
  messages: AgentMessage[],
  policy: { keepRecentTurns?: number } = {},
): PruneResult {
  const keepRecentTurns = policy.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
  const recentStart = recentTurnsStartIndex(messages, keepRecentTurns);
  const firstUserIndex = messages.findIndex((m) => m.role === 'user');

  const seeds = new Set<number>();
  if (firstUserIndex >= 0) seeds.add(firstUserIndex);
  for (let i = 0; i < messages.length; i++) {
    if (i >= recentStart || isKeyMessage(messages[i])) seeds.add(i);
  }
  const keep = expandToolPairs(messages, seeds);

  const prunedCount = messages.length - keep.size;
  if (prunedCount <= 0) return { messages, prunedCount: 0 };

  const kept = messages.filter((_, i) => keep.has(i));
  // 占位文案对齐真实契约(1.2.6):保留的是「任务锚 + 命中关键标记的消息 +
  // 最近 N 轮」——不命中标记的早期细节(含可能的突破口)确实会被省略,
  // 不过度承诺「均保留」。
  const placeholder: AgentMessage = {
    role: 'user',
    content:
      `[compaction: 为控制上下文长度,已省略 ${prunedCount} 条早期消息;` +
      '保留的是任务锚、命中关键标记(非零 exit/错误信号/CVE/flag/[redacted])的消息与最近几轮——' +
      '未命中标记的早期细节不在上下文中,需要时查会话存档。]',
    timestamp: Date.now(),
  } as AgentMessage;
  // 占位插在首条 user 之后(若首条 user 存在且在保留序列首位)。
  const insertAt = firstUserIndex >= 0 && kept[0] === messages[firstUserIndex] ? 1 : 0;
  kept.splice(insertAt, 0, placeholder);
  return { messages: kept, prunedCount };
}

// ---------------------------------------------------------------------------
// Threshold + transform(接 runLoop 的 transformContext)
// ---------------------------------------------------------------------------

export interface CompactionEvaluation {
  compact: boolean;
  tokens: number;
  threshold: number;
}

/** 阈值判定:pi estimateContextTokens 估算(纯估算路径补系统提示) > contextWindow × ratio。 */
export function evaluateCompaction(messages: AgentMessage[], policy: CompactionPolicy): CompactionEvaluation {
  const ratio = policy.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
  const threshold = Math.floor(policy.contextWindow * ratio);
  const est = estimateContextTokens(messages);
  // usageTokens>0 = API 实测 input(已含系统提示),不重复计;否则按 chars/4
  // 同一启发式补系统提示估算。
  const systemTokens = est.usageTokens > 0 ? 0 : Math.ceil((policy.systemPromptChars ?? 0) / 4);
  const tokens = est.tokens + systemTokens;
  return { compact: tokens > threshold, tokens, threshold };
}

export interface CompactionTransformInfo extends CompactionEvaluation {
  prunedCount: number;
  /**
   * 第二档(激进截断)走完仍超阈值(1.2.6)——压缩已尽力,下一次 LLM 调用
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

/**
 * 组装 runLoop 的 transformContext:未超阈值原样透传;超阈值保守裁剪。
 * 裁完仍超阈值走第二档(1.2.6):keepRecentTurns 压到 1 再裁,仍超则对
 * 保留消息做逐条正文截断(按阈值反推字符预算均摊),依旧装不下时打
 * 明确日志引导 /reset——不留「直接 API 400」的无升级路径。
 * onCompact 回调(可选)用于审计/meta 标记——同步调用,不 await。
 * 裁剪绝不 throw:任何异常原样返回输入(丢上下文比炸 loop 安全)。
 */
export function makeCompactionTransform(
  policy: CompactionPolicy,
  onCompact?: (info: CompactionTransformInfo) => void,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  return async (messages) => {
    try {
      const evaluation = evaluateCompaction(messages, policy);
      if (!evaluation.compact) return messages;
      let { messages: pruned, prunedCount } = pruneLoopContext(messages, {
        keepRecentTurns: policy.keepRecentTurns,
      });
      let after = evaluateCompaction(pruned, policy);
      if (after.compact) {
        // 第二档 a:最近轮数压到 1 再裁(关键消息存活线不动)。
        const tighter = pruneLoopContext(messages, { keepRecentTurns: 1 });
        if (tighter.messages.length < pruned.length) {
          pruned = tighter.messages;
          prunedCount = tighter.prunedCount;
        }
        after = evaluateCompaction(pruned, policy);
      }
      if (after.compact) {
        // 第二档 b:逐条正文截断——保留集(任务锚/关键消息/最近轮)不动结构,
        // 只压每条的体积;预算按 chars/4 启发式从阈值反推、均摊到每条。
        const charBudget = Math.max(1, after.threshold * 4);
        const perMessageCap = Math.max(200, Math.floor(charBudget / Math.max(1, pruned.length)));
        pruned = pruned.map((m) => truncateMessageText(m, perMessageCap));
        after = evaluateCompaction(pruned, policy);
      }
      const stillOver = after.compact;
      console.warn(
        `[compaction] context ${evaluation.tokens} tokens > threshold ${evaluation.threshold} ` +
        `→ pruned ${prunedCount} non-key messages (kept ${pruned.length})` +
        (stillOver ? `;仍超阈值(${after.tokens} > ${after.threshold})` : ''),
      );
      if (stillOver) {
        console.error(
          `[compaction] 第二档截断后仍超阈值(${after.tokens} > ${after.threshold})——` +
          '下一次 LLM 调用可能因上下文过长被 API 拒绝(400),建议 /reset 开新会话再续。',
        );
      }
      onCompact?.({ ...evaluation, prunedCount, stillOverThreshold: stillOver });
      return pruned;
    } catch (err) {
      console.warn(`[compaction] transform 异常,原样透传:${err instanceof Error ? err.message : String(err)}`);
      return messages;
    }
  };
}
