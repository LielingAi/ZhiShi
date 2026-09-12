/**
 * 1.7.2 — 工作记忆窗口置换（design: docs/design/1.7.2-compaction.md §7.1）。
 *
 * 取代 1.2.7 段级压缩（stub/truncate）的**置换**机制：不摘录、不写摘要——
 * 工作记忆（每轮 LLM 上下文）按 token 预算保留最近窗口；被移出的最老部分
 * 以「目录指针块」形态留在上下文（段号/阶段/关键行/行区间/recall 取回），
 * 原文永远在 jsonl（Event 层全量不动）。
 *
 * 职责切分（§3 架构定案）：
 *   - 置换 = 纯函数、程序决定、零 LLM 调用、零供应商假设；
 *   - 语义保真 = Claim 层（archive/session-claims，治理管线与检查点保证）；
 *   - 信息不丢 = jsonl 全量 + recall 行区间取回（Event 层）。
 *
 * 全局接线：chat-engine 两处 transformContext 装配点（交互 1282 / invoke 1622）
 * 均替换为本模块；子 loop 经 buildTurnStack 恒有 recall（chat-engine.ts:1130）。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import {
  estimateMessagesTokens,
  messageText,
  segmentContext,
  type ContextSegment,
} from './context-manager';
import {
  isClaimExpired,
  loadSessionClaims,
  touchClaims,
  type SessionClaim,
} from './session-claims';

// ---------------------------------------------------------------------------
// 常量（dogfood 后调参）
// ---------------------------------------------------------------------------

/** 工作记忆目标 = contextWindow × 本比率（1M 窗口 → 250k 估算）。 */
export const WORKING_MEMORY_TARGET_RATIO = 0.25;
/** 工作记忆内 user 消息原文保留上限（超出的最老 user 消息随段移出）。 */
export const KEEP_RECENT_USER_MESSAGES = 20;
/** 溢出兜底重试的更紧预算（同 1.2.7 FORCE 口径，改走窗口置换）。 */
export const WINDOW_OVERFLOW_RETRY_RATIO = 0.15;
/** M6 自动检索注入:单轮最多注入条数 / 字符预算 / 新鲜度窗口。 */
export const CLAIM_INJECT_MAX = 8;
export const CLAIM_INJECT_MAX_CHARS = 2000;
export const CLAIM_FRESH_DAYS = 30;

// ---------------------------------------------------------------------------
// M6 自动检索注入（纯函数;工作记忆组装时以当前轮内容检索 session-claims）
// ---------------------------------------------------------------------------

/** 检索词打分:searchTerms/subject/text 任一命中当前轮查询词 → 加分。 */
export function rankClaimsForQuery(
  claims: SessionClaim[],
  query: string,
  now: number,
): SessionClaim[] {
  const q = query.toLowerCase();
  const freshCut = now - CLAIM_FRESH_DAYS * 24 * 3600_000;
  return claims
    .filter((c) => c.status === 'active' && !isClaimExpired(c, now))
    .filter((c) => {
      const touched = Date.parse(c.lastTouchedAt);
      return !Number.isFinite(touched) || touched >= freshCut;
    })
    .map((c) => {
      let score = c.salience;
      const terms = [...c.searchTerms, ...(c.subject ? [c.subject] : []), c.text];
      for (const t of terms) {
        if (t && t.length > 1 && q.includes(t.toLowerCase())) { score += 0.5; break; }
      }
      return { c, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, CLAIM_INJECT_MAX)
    .map((s) => s.c);
}

/** 注入块文本（带来源标注——行区间供 recall 原文取回）。 */
export function renderClaimInjection(claims: SessionClaim[]): string {
  if (claims.length === 0) return '';
  const lines = claims.map((c) => {
    const range = c.lineStart !== undefined && c.lineEnd !== undefined ? `（行 ${c.lineStart}-${c.lineEnd}）` : '';
    return `- [${c.id} ${c.kind}] ${c.text}${range}`;
  });
  return `[会话记忆索引(治理提取;需要原文时 recall 行区间取回)]\n${lines.join('\n')}`;
}

/** 当前轮查询串:最近 user 消息 + 最近 toolResult 文本(各截 400 字符)。 */
export function buildClaimQuery(messages: AgentMessage[]): string {
  const parts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && parts.length < 2; i--) {
    const m = messages[i];
    if (m.role === 'user' || m.role === 'toolResult') parts.push(messageText(m).slice(0, 400));
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// 纯函数 — 窗口选择
// ---------------------------------------------------------------------------

export interface WorkingWindowOptions {
  /** 模型上下文窗口（token）。 */
  contextWindow: number;
  /** 工作记忆目标比率（缺省 WORKING_MEMORY_TARGET_RATIO）。 */
  targetRatio?: number;
  /** kept 范围 user 消息上限（缺省 KEEP_RECENT_USER_MESSAGES）。 */
  keepRecentUser?: number;
  /** 系统提示字符数——预算先行扣除（与 estimateMessagesTokens 同口径 chars/2）。 */
  systemPromptChars?: number;
}

export interface WorkingWindowResult {
  /** 最终进 LLM 的消息数组：[指针块…] + kept 尾段（anchor 恒在头）。 */
  messages: AgentMessage[];
  /** 被移出工作记忆的消息条数（原文仍全量在 jsonl）。 */
  evictedCount: number;
  /** 指针块数量。 */
  pointerCount: number;
  /** 是否发生了置换（false = 预算内原样透传）。 */
  evicted: boolean;
  /** 置换后估算（纯估算口径，含系统提示折算）。 */
  afterTokens: number;
  /** 预算（目标值）。 */
  budgetTokens: number;
}

/** jsonl 行区间（消息下标 i ↔ jsonl 行 i+2，与 harvest/recall 同口径）。 */
export function jsonlLineRange(seg: ContextSegment): { start: number; end: number } {
  return { start: seg.start + 2, end: seg.end - 1 + 2 };
}

/**
 * 目录指针块文本（语义不在指针里——关键行只作目录提示，语义在 Claim 层）。
 * 行区间直接印在卡上：模型可 recall({lines:"x-y"}) 取回原文。
 */
export function buildWindowPointer(seg: ContextSegment): string {
  const keys = seg.keyHits.length > 0 ? seg.keyHits.map((l) => `「${l}」`).join(' ') : '无关键行命中';
  const tools = seg.toolNames.length > 0 ? seg.toolNames.join('/') : '无工具调用';
  const range = jsonlLineRange(seg);
  return (
    `[段#${seg.index} ${seg.phase} 已沉淀] 关键行:${keys};工具:${tools};` +
    `原文在会话存档第 ${range.start}-${range.end} 行（recall({lines:"${range.start}-${range.end}"}) 按行区间取回）。`
  );
}

/**
 * 窗口选择（纯函数）：从最新消息起按段原子向前累积，估算 ≤ 预算即停；
 * kept 范围 user 消息超上限 → 继续向前整段移出直到达标。anchor 段（段 0，
 * 任务目标）恒保留原文。
 */
export function buildWorkingWindow(
  messages: AgentMessage[],
  options: WorkingWindowOptions,
): WorkingWindowResult {
  const targetRatio = options.targetRatio ?? WORKING_MEMORY_TARGET_RATIO;
  const keepRecentUser = options.keepRecentUser ?? KEEP_RECENT_USER_MESSAGES;
  const budgetTokens = Math.floor(options.contextWindow * targetRatio);
  const systemPromptTokens = Math.ceil((options.systemPromptChars ?? 0) / 2);
  const messageBudget = Math.max(1, budgetTokens - systemPromptTokens);

  if (messages.length === 0) {
    return { messages, evictedCount: 0, pointerCount: 0, evicted: false, afterTokens: systemPromptTokens, budgetTokens };
  }
  const total = estimateMessagesTokens(messages, options.systemPromptChars ?? 0);
  if (total <= budgetTokens) {
    // 预算内原样透传——不置换。
    return { messages, evictedCount: 0, pointerCount: 0, evicted: false, afterTokens: total, budgetTokens };
  }

  const segments = segmentContext(messages);
  // anchor 段（段 0，任务目标）恒保留原文——其 tokens 与 user 计数先入账。
  const anchor = segments[0];
  const anchorUser = messages.slice(anchor.start, anchor.end).filter((m) => m.role === 'user').length;
  let keptTokens = anchor.tokens;
  let keptUserCount = anchorUser;
  // 从最新段起向前累积 kept 段（段 0 不参与循环——已强制保留）。
  const kept: ContextSegment[] = [];
  for (let i = segments.length - 1; i >= 1; i--) {
    const seg = segments[i];
    const segUser = messages.slice(seg.start, seg.end).filter((m) => m.role === 'user').length;
    const wouldUser = keptUserCount + segUser;
    if (keptTokens + seg.tokens > messageBudget || wouldUser > keepRecentUser) break;
    kept.push(seg);
    keptTokens += seg.tokens;
    keptUserCount = wouldUser;
  }
  let evicted = segments.filter((s) => s.index > 0 && !kept.some((k) => k.index === s.index));

  // 第二遍收缩：指针块本身占 token（每块 ~55-130）——kept + 指针总量
  // 必须 ≤ 预算；超支则从 kept 最老段起再移出一段（-段体量 + +一块指针，
  // 单步净减），直到达标或 kept 清空。
  const buildOut = (keptSegs: ContextSegment[], evictedSegs: ContextSegment[]): AgentMessage[] => {
    const pointers = evictedSegs.map((seg) => ({
      role: 'user',
      content: buildWindowPointer(seg),
      timestamp: Date.now(),
    }) as AgentMessage);
    const keptSorted = [...keptSegs].sort((a, b) => a.index - b.index);
    const out: AgentMessage[] = [];
    out.push(...messages.slice(anchor.start, anchor.end));
    out.push(...pointers);
    for (const seg of keptSorted) out.push(...messages.slice(seg.start, seg.end));
    return out;
  };
  let keptMutable = [...kept];
  let result = buildOut(keptMutable, evicted);
  while (result.length > 0
    && estimateMessagesTokens(result, options.systemPromptChars ?? 0) > budgetTokens
    && keptMutable.length > 0) {
    keptMutable = keptMutable.slice(0, -1); // 去掉最老 kept 段
    evicted = segments.filter((s) => s.index > 0 && !keptMutable.some((k) => k.index === s.index));
    result = buildOut(keptMutable, evicted);
  }

  const pointers = result.filter((m) => {
    const c = (m as { content?: unknown }).content;
    return typeof c === 'string' && c.includes('已沉淀');
  });
  const evictedCount = evicted.reduce((n, s) => n + (s.end - s.start), 0) - pointers.length;
  return {
    messages: result,
    evictedCount: Math.max(0, evictedCount),
    pointerCount: pointers.length,
    evicted: true,
    afterTokens: estimateMessagesTokens(result, options.systemPromptChars ?? 0),
    budgetTokens,
  };
}

// ---------------------------------------------------------------------------
// transformContext 形态（runLoop 的 transformContext 契约——直接替换原压缩装配点）
// ---------------------------------------------------------------------------

export interface WindowTransformPolicy {
  contextWindow: number;
  targetRatio?: number;
  keepRecentUser?: number;
  systemPromptChars?: number;
  /** M6 自动检索注入:提供则按当前轮内容检索该会话的 session-claims。 */
  sessionId?: string;
  /** 测试注入:claims 目录(缺省 ~/.zhishi/loop-sessions)。 */
  claimsDir?: string;
}

export interface WindowTransformInfo {
  tokens: number;
  budgetTokens: number;
  evicted: boolean;
  evictedCount: number;
  pointerCount: number;
  injectedClaims: number;
}

/**
 * 组装 runLoop 的 transformContext：预算内原样透传；超预算走窗口置换。
 * 置换绝不 throw：任何异常原样返回输入（丢上下文比炸 loop 安全——沿袭
 * 1.2.7 纪律）。onWindow 回调（可选）用于 meta 打标。
 * 1.7.2 M6:sessionId 提供时,以当前轮内容检索 session-claims,相关条目
 * 作为「会话记忆索引」注入(锚段之后、指针块之前)。
 */
export function makeWindowTransform(
  policy: WindowTransformPolicy,
  onWindow?: (info: WindowTransformInfo) => void,
): (messages: AgentMessage[], _signal?: AbortSignal) => Promise<AgentMessage[]> {
  return async (messages) => {
    try {
      const before = estimateMessagesTokens(messages, policy.systemPromptChars ?? 0);
      const result = buildWorkingWindow(messages, policy);
      let injectedClaims = 0;
      if (policy.sessionId && result.messages.length > 0) {
        try {
          const query = buildClaimQuery(messages);
          const file = loadSessionClaims(policy.sessionId, policy.claimsDir ? { dir: policy.claimsDir } : undefined);
          const hits = rankClaimsForQuery(file.claims, query, Date.now());
          const text = renderClaimInjection(hits);
          if (text && text.length <= CLAIM_INJECT_MAX_CHARS) {
            const injection = { role: 'user', content: text, timestamp: Date.now() } as AgentMessage;
            result.messages.splice(1, 0, injection); // 锚段之后
            injectedClaims = hits.length;
            // M5 触点刷新：被注入的条目 lastTouchedAt 更新（衰减从使用计时）。
            void touchClaims(policy.sessionId, hits.map((h) => h.id), policy.claimsDir ? { dir: policy.claimsDir } : undefined)
              .catch(() => {});
          }
        } catch (err) {
          console.warn(`[window] claim 注入失败(继续):${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (result.evicted) {
        console.warn(
          `[window] context ${before} tokens > working budget ${result.budgetTokens} ` +
          `→ evicted ${result.evictedCount} messages (pointers ${result.pointerCount}, claims ${injectedClaims}), after ${result.afterTokens}`,
        );
      }
      onWindow?.({
        tokens: before,
        budgetTokens: result.budgetTokens,
        evicted: result.evicted,
        evictedCount: result.evictedCount,
        pointerCount: result.pointerCount,
        injectedClaims,
      });
      return result.messages;
    } catch (err) {
      console.warn(`[window] transform 异常,原样透传:${err instanceof Error ? err.message : String(err)}`);
      return messages;
    }
  };
}
