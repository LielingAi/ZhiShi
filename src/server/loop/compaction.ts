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
 * 阈值判定与裁后重估口径(§2.6):一律纯字符估算(estimateMessagesTokens)
 * ——1.5.3 起未裁首判也不吃旧 assistant 的 usage 锚(锚失真:压缩轮的
 * usage 是裁后体量,锚+增量 ≠ 全量历史,golang 会话事故实锤),改用
 * 「全量启发式 × meta 持久化校准系数」({@link evaluateCompaction});
 * 裁后重估同为纯估算。
 *
 * 压缩只影响**当次 LLM 上下文**(经 runLoop 的 transformContext 透传,
 * pi 在 convertToLlm 前应用);jsonl 持久化保留全量(语义不动),触发
 * 时由调用方经 markLoopSessionCompacted 在 meta 行打 compactedAt 标记。
 *
 * 存活契约(KEY_MESSAGE_PATTERNS/hasErrorSignal/isKeyMessage 等)与
 * tool 配对闭包(expandToolPairs)实现在 context-manager.ts(叶子
 * 模块,no-circular 红线),消费方直接从那里 import。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { estimateMessagesTokens, segmentContext, selectSegmentsToStub, applySegmentStubs, buildSegmentStub, messageText, type ContextSegment } from './context-manager';
import { appendHarvestEntries, buildPointerCard, harvestSegment } from './harvest';

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
   * 可选,缺省 0(向后兼容)。
   */
  systemPromptChars?: number;
  /** 1.5.3:token 校准系数（会话 meta 持久化；缺省 1 = 纯启发式）。
   *  学习写入侧在 chat-engine（未压缩轮次才学——压缩轮锚被污染不学）。 */
  calibration?: number;
}

export const DEFAULT_THRESHOLD_RATIO = 0.8;

export interface CompactionEvaluation {
  compact: boolean;
  tokens: number;
  threshold: number;
}

/** 1.5.3：usage 锚函数已随 evaluateCompaction 改为 meta 持久化校准系数
 *  而删除（锚失真：压缩轮次的锚是压缩后体量，锚+增量 ≠ 全量历史）。 */

/**
 * 阈值判定(未裁首判):**校准的全量估算**（1.5.3 修复锚失真——见下）。
 * 旧路径 anchor.total + 锚后增量在「上一次压缩过」后失真：锚的
 * totalTokens 是压缩后上下文的实测,锚 + 增量 ≠ 全量历史的真实体量——
 * 压缩过一次后判定永久偏低,直到 API 400（golang 会话事故实锤:估算
 * 348K vs 实际 1.14M,偏低 3.3 倍）。
 *
 * 校准:policy.calibration（每轮未压缩时学习并持久化在会话 meta:
 * 真实 API usage ÷ 当轮启发式全量）× 全量启发式 = 判定值——把工具
 * schema/系统提示/CJK 比率的盲区一次性折算进来。系数缺省 1（向后
 * 兼容）。压缩过的轮次不学习（锚被污染——写入侧在 chat-engine 把关）。
 */
export function evaluateCompaction(messages: AgentMessage[], policy: CompactionPolicy): CompactionEvaluation {
  const ratio = policy.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
  const threshold = Math.floor(policy.contextWindow * ratio);
  const full = estimateMessagesTokens(messages, policy.systemPromptChars ?? 0);
  const calibration = policy.calibration ?? 1;
  const tokens = Math.round(full * calibration);
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

/** 1.5.3 收割接线选项（transform 的副作用面——全部可选,缺省走 1.2.7
 *  旧形态：无收割、兜底 stub）。 */
export interface CompactionTransformOptions {
  /** 收割落盘的会话线（有了才收割+指针卡；没有走旧形态）。 */
  sessionId?: string;
  /** 收割目录（测试注入临时目录；缺省 loop-sessions）。 */
  harvestDir?: string;
  /** 1.5.4(A2-3)：调用方上下文是否有 recall 工具（缺省 true——主 loop
   *  恒注册；子 loop 无 recall,传 false 让兜底 stub 不印取回指引）。 */
  hasRecall?: boolean;
}

/** 1.5.3 标记形态：方头括号 + 「勿复现」指令——旧形态「…[已截断]」被模型
 *  当语料复现（golang 会话雪崩实证：模型不知它是 harness 元数据）。 */
const TRUNCATION_MARKER_NEW = '\n⟦系统注记：以下内容已省略，勿复现⟧';
/** 旧形态（持久化剥离时两类都认）。 */
export const TRUNCATION_MARKER_LEGACY = '…[已截断]';
/** 新形态导出（持久化剥离用——session.ts 与本处同一事实源）。 */
export const TRUNCATION_MARKER_CURRENT = TRUNCATION_MARKER_NEW;

/** 单条消息正文截断（string content 与 text/thinking 块；toolCall 不动）。
 *  1.5.3 分级：user 消息**永不截断**（用户指令必保，压缩两档同纪律）；
 *  thinking 块按 cap 裁（过程性内容，历史价值最低）；text 块按 cap 裁。 */
export function truncateMessageText(message: AgentMessage, maxChars: number): AgentMessage {
  const marker = TRUNCATION_MARKER_NEW;
  // 用户指令永不裁（1.5.3 硬钉死——golang 会话「遗忘」事故的根因之一）。
  if ((message as { role?: string }).role === 'user') return message;
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
 * 1.5.3 收割接线（transform 层）：选段 → 收割（确定性提取进侧车）→ 落
 * 指针卡（带 harvest 引用 + recall 用法）。收割 IO 失败 → 回退兜底 stub
 * （buildSegmentStub），压缩不因收割故障阻塞。
 */
async function harvestStubbedSegments(
  messages: AgentMessage[],
  segments: ContextSegment[],
  stubIdx: ReadonlySet<number>,
  options?: CompactionTransformOptions,
): Promise<((seg: ContextSegment) => string) | undefined> {
  if (!options?.sessionId || stubIdx.size === 0) return undefined;
  try {
    const stubbed = segments.filter((s) => stubIdx.has(s.index));
    const entries = stubbed.map((seg) => harvestSegment(seg, messages));
    const assigned = await appendHarvestEntries(options.sessionId, entries, { dir: options.harvestDir });
    const byIndex = new Map(assigned.map((e) => [e.segmentIndex, e]));
    return (seg) => {
      const entry = byIndex.get(seg.index);
      // 指针卡带 jsonl 行区间（A1-3）——模型可直接 recall({lines}) 取原文。
      return entry ? buildPointerCard(seg, entry.id, entry) : String((buildSegmentStub(seg) as { content?: unknown }).content ?? '');
    };
  } catch (err) {
    console.warn(`[compaction] 收割失败,回退兜底 stub:${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * tier-2 截断前的全文收割（长文不丢——治本「裁掉先沉淀」的第二档形态）。
 * 被截消息的全文按类归并进一条收割物（userTexts 永不截不进这里——它们
 * 本就不裁）。返回收割 id（无收割面 → undefined，标记里不写引用）。
 */
async function harvestTruncatedFulltexts(
  messages: AgentMessage[],
  maxChars: number,
  options?: CompactionTransformOptions,
): Promise<string | undefined> {
  if (!options?.sessionId) return undefined;
  const over = messages.filter((m) => {
    const role = (m as { role?: string }).role ?? '';
    if (role === 'user') return false; // user 永不裁,无需收割
    const t = messageText(m);
    return t.length > maxChars;
  });
  if (over.length === 0) return undefined;
  try {
    const assigned = await appendHarvestEntries(
      options.sessionId,
      [{
        segmentIndex: -1,
        phase: 'tier2-fulltext',
        lineStart: 0,
        lineEnd: 0,
        userTexts: [],
        keyFacts: over.map((m) => messageText(m).slice(0, 2000)),
        summaries: [],
        tools: [],
      }],
      { dir: options.harvestDir },
    );
    return assigned[0]?.id;
  } catch (err) {
    console.warn(`[compaction] tier-2 全文收割失败（截断照走）:${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * 组装 runLoop 的 transformContext:未超阈值原样透传;超阈值走段级
 * 采样锚定压缩(context-manager)。裁后重估一律纯字符估算(§2.6);
 * 仍超阈值走第二档:对保留消息逐条正文截断(按阈值反推字符预算均摊),
 * 依旧装不下时打明确日志引导 /reset——不留「直接 API 400」的无升级
 * 路径。onCompact 回调(可选)用于审计/meta 标记——同步调用,不
 * await。裁剪绝不 throw:任何异常原样返回输入(丢上下文比炸 loop
 * 安全)。
 *
 * 1.5.3 治本：超阈值时先收割（被裁段的关键事实进侧车）再落指针卡
 * （带 harvest 引用 + jsonl 行区间 + recall 用法）；第二档截断前全文
 * 进收割物。options.sessionId 缺失 → 1.2.7 旧形态（无收割,兜底 stub）。
 */
export function makeCompactionTransform(
  policy: CompactionPolicy,
  onCompact?: (info: CompactionTransformInfo) => void,
  options?: CompactionTransformOptions,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  return async (messages) => {
    try {
      const evaluation = evaluateCompaction(messages, policy);
      if (!evaluation.compact) return messages;

      const systemPromptChars = policy.systemPromptChars ?? 0;
      const segments = segmentContext(messages);
      // 1.5.3：先选段 → 收割 → 指针卡（无收割面时回退兜底 stub 文案;
      // A2-3:兜底文案按 options.hasRecall 分形态——子 loop 无 recall 工具,
      // 不印取回指引。stubIdx 已按同参数选好,与旧 compactBySegments 路径
      // 等价——后者只是同参重跑 select+apply）。
      const stubIdx = selectSegmentsToStub(messages, segments, evaluation.threshold, systemPromptChars);
      const harvestedStubFn = await harvestStubbedSegments(messages, segments, stubIdx, options);
      const stubTextFn = harvestedStubFn
        ?? ((seg: ContextSegment) => String((buildSegmentStub(seg, { hasRecall: options?.hasRecall }) as { content?: unknown }).content ?? ''));
      const compacted = applySegmentStubs(messages, segments, stubIdx, stubTextFn);
      let pruned = compacted.messages;
      let after = estimateMessagesTokens(pruned, systemPromptChars);
      if (after > evaluation.threshold) {
        // 第二档:逐条正文截断（1.5.3：截断前全文进收割物,长文不丢）。
        const tokenBudget = Math.max(1, evaluation.threshold - Math.ceil(systemPromptChars / 2));
        const perMessageCap = Math.max(200, Math.floor((tokenBudget * 2) / Math.max(1, pruned.length)));
        await harvestTruncatedFulltexts(pruned, perMessageCap, options);
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
