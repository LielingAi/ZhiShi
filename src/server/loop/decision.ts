/**
 * 决策面板服务端半(1.3.2 任务一)——request_decision loop 工具 + pending 表。
 *
 * 定位:pi agent loop 里模型显式提请人拍板的通道。流程:模型调用
 * request_decision(question/options/context)→ 服务端生成 decisionId →
 * **先查 expert_search**(question+context 关键词)生成 expertHits → 内存
 * pending 表登记 → SSE `chat:decision-request`(GUI 琥珀决策面板)→ 人经
 * POST /chat/decision/respond 作答 → 决定作为 user 消息注入回 loop(经
 * chat-engine 的 steering/直发通道,复用 B3/B5 线语义)→ broadcast
 * `chat:decision-resolved` → pending 标记 resolved。
 *
 * 纪律:
 *   - 语义约定同 expert_search:查不到≠不存在——未命中(含库不可用)统一
 *     标注「库中无基准」(库边界标注,不是「库中没有」)。
 *   - pending 无超时(v1 不超时);服务重启即失效(内存表)。
 *   - /chat/stream 每次(重)连都重放 pending 决策(对齐 boundary-ask 的
 *     pending 重放约定)——GUI 重连不丢待答面板。
 *   - 纯注册表 + 注入 broadcast,单测绝不触网/不触真库。
 */

import { Type, type Static } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

import { broadcast } from '../sse';
import { getZhiShiDataDir } from '../utils/app-dirs';
import { openExpertStore, type ExpertEntry } from '../expert/store';
import { searchExpertEntries, EXPERT_SEARCH_LIMIT } from '../expert/search';

export type BroadcastFn = (event: string, data: unknown) => void;

export const REQUEST_DECISION_TOOL_NAME = 'request_decision';

/** 库边界标注(expert_search 语义约定:查不到≠不存在)。 */
export const NO_BASELINE_MARK = '库中无基准';

/**
 * 决策记录(pending 表条目 + wire/持久化 marker 共用形状)。
 * choice 在 respond 前为空;wire 决策块与 loop jsonl 持久化只带
 * decisionId/choice/note/expertRefs(question 进消息正文,不进 marker)。
 */
export interface DecisionMeta {
  decisionId: string;
  choice: string;
  note?: string;
  expertRefs?: string[];
}

export interface DecisionPending {
  decisionId: string;
  /** 提请时所在 loop 线(turn 快照线)——注入回这条线的路由依据。 */
  sessionId: string;
  question: string;
  options: string[];
  context?: string;
  /** 专家命中摘要行(E#N 前缀);未命中 = [库中无基准]。 */
  expertHits: string[];
  /** E#N 引用(命中时;resolved 广播与 wire 决策块按此追溯)。 */
  expertRefs: string[];
  createdAt: string;
  resolved: boolean;
  choice?: string;
  note?: string;
  resolvedAt?: string;
}

const pending = new Map<string, DecisionPending>();

// ---------------------------------------------------------------------------
// 纯函数 — 摘要/正文
// ---------------------------------------------------------------------------

function oneLine(text: string, maxChars: number): string {
  const s = text.trim();
  return s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s;
}

/**
 * 单条专家命中的决策摘要行。E#N 编号口径与 expert_search 现有输出一致
 * (N = 条目 id,即 expert_search 结果里的 #N)。字段只取 title/applicability/
 * criteria——决策面板要的是「这知识适不适用、怎么验证」,不是全文。
 */
export function formatDecisionHit(entry: ExpertEntry): string {
  return [
    `E#${entry.id} [${entry.domain}/${entry.kind}] ${oneLine(entry.title, 80)}`,
    `适用条件: ${oneLine(entry.applicability, 120)}`,
    `判据: ${oneLine(entry.criteria, 120)}`,
  ].join(' | ');
}

/** 命中条目 → 摘要行 + E#N 引用。 */
export function buildExpertHitSummaries(hits: ExpertEntry[]): { expertHits: string[]; expertRefs: string[] } {
  return {
    expertHits: hits.length > 0 ? hits.map(formatDecisionHit) : [NO_BASELINE_MARK],
    expertRefs: hits.map((h) => `E#${h.id}`),
  };
}

/** 注入回 loop 的 user 消息正文(模型可读;决定以 user 消息回来继续)。 */
export function formatDecisionInjectionContent(d: { question?: string; choice: string; note?: string }): string {
  const lines = ['【人的决定】'];
  if (d.question) lines.push(`问题: ${d.question}`);
  lines.push(`选择: ${d.choice}`);
  if (d.note) lines.push(`备注: ${d.note}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 注册表 — 登记/应答/重放
// ---------------------------------------------------------------------------

/**
 * 发起一次决策请求:生成 decisionId、登记 pending、broadcast
 * `chat:decision-request`。broadcast 可注入(单测);生产用 sse.broadcast。
 */
export function requestDecision(
  input: {
    sessionId: string;
    question: string;
    options: string[];
    context?: string;
    expertHits?: string[];
    expertRefs?: string[];
  },
  broadcastFn: BroadcastFn = broadcast,
): DecisionPending {
  const decisionId = `dec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const record: DecisionPending = {
    decisionId,
    sessionId: input.sessionId,
    question: input.question,
    options: [...input.options],
    ...(input.context ? { context: input.context } : {}),
    expertHits: input.expertHits && input.expertHits.length > 0 ? input.expertHits : [NO_BASELINE_MARK],
    expertRefs: input.expertRefs ?? [],
    createdAt: new Date().toISOString(),
    resolved: false,
  };
  pending.set(decisionId, record);
  broadcastFn('chat:decision-request', {
    decisionId,
    question: record.question,
    options: record.options,
    expertHits: record.expertHits,
  });
  return record;
}

export type RespondDecisionResult =
  | { ok: true; decision: DecisionPending }
  | { ok: false; reason: 'unknown' | 'resolved' };

/**
 * 人已作答:登记 choice/note 并标记 resolved。幂等——同一 decisionId 的
 * 重复 respond 返回 reason='resolved',调用方不得重复注入。
 */
export function respondDecision(decisionId: string, choice: string, note?: string): RespondDecisionResult {
  const d = pending.get(decisionId);
  if (!d) return { ok: false, reason: 'unknown' };
  if (d.resolved) return { ok: false, reason: 'resolved' };
  d.resolved = true;
  d.choice = choice;
  if (note) d.note = note;
  d.resolvedAt = new Date().toISOString();
  return { ok: true, decision: d };
}

/** /chat/stream 重连重放源:当前全部待答决策(不含已 resolved)。 */
export function pendingDecisions(): DecisionPending[] {
  return [...pending.values()].filter((d) => !d.resolved);
}

/**
 * 按 id 读决策记录(含 resolved)——1.6.0 auto-run 决策注入超时兜底:
 * 人已作答但注入 turn 卡死(marker 未落地)时,从 resolved 记录读 choice,
 * 不依赖 marker。
 */
export function getDecision(decisionId: string): DecisionPending | undefined {
  return pending.get(decisionId);
}

/**
 * 测试/关闭用:清空 pending。带 sessionId 时只清该 loop 线的条目
 * (1.6.0 auto-run 终态按线清理,不动其他线的待答决策)。
 */
export function clearDecisions(sessionId?: string): void {
  if (sessionId === undefined) {
    pending.clear();
    return;
  }
  for (const [id, d] of pending) {
    if (d.sessionId === sessionId) pending.delete(id);
  }
}

// ---------------------------------------------------------------------------
// request_decision 工具(harness 原生能力,无条件注册)
// ---------------------------------------------------------------------------

const requestDecisionParameters = Type.Object({
  question: Type.String({ description: '要人拍板的问题(一句话说清方向分歧/关键取舍点)' }),
  options: Type.Array(Type.String({ description: '候选方向' }), {
    minItems: 2,
    description: '候选方向,至少 2 项(每个方向一句话,人能直接选)',
  }),
  context: Type.Optional(Type.String({ description: '背景(可选):已确认事实/各方向代价/你的倾向与理由' })),
});

export type RequestDecisionParams = Static<typeof requestDecisionParameters>;

export interface DecisionToolDetails {
  decisionId: string;
  hitCount: number;
}

export interface CreateDecisionToolOptions {
  /** 数据目录(缺省 getZhiShiDataDir())。测试注入临时库目录。 */
  baseDir?: string;
  /** 当前 loop 线(turn 快照线)——决策归属与注入路由依据。 */
  getSessionId?: () => string;
  /** 事件扇出(缺省 sse.broadcast)。测试注入。 */
  broadcastFn?: BroadcastFn;
}

/**
 * 构造 request_decision 工具。执行体先查 expert_search(question+context
 * 关键词):命中出摘要行 + E#N 引用;未命中/库不可用统一标注「库中无基准」。
 * 库不可用不 throw(降级纪律同 expert_search)。
 */
export function createDecisionTool(
  options: CreateDecisionToolOptions = {},
): AgentTool<typeof requestDecisionParameters, DecisionToolDetails> {
  const baseDir = options.baseDir ?? getZhiShiDataDir();
  const getSessionId = options.getSessionId ?? (() => '');
  const broadcastFn = options.broadcastFn ?? broadcast;
  return {
    name: REQUEST_DECISION_TOOL_NAME,
    label: '提请人拍板(方向分歧/关键取舍)',
    description:
      '把需要人拍板的决策提请出来:方向分歧(方案互斥且代价不可逆)、关键取舍无把握、且专家知识库无基准时用。'
      + '纪律:提请前先查 expert_search——命中可验证基准就按它走、不问人;查不到(库中无基准)才提请。'
      + 'options 至少 2 个互斥方向;context 写清已确认事实/代价/你的倾向。'
      + '提请后暂停这条线的执行,等决定以 user 消息注入回来再继续——不要边等边推进。',
    parameters: requestDecisionParameters,
    execute: async (_toolCallId, params): Promise<AgentToolResult<DecisionToolDetails>> => {
      const question = (params.question ?? '').trim();
      if (!question) throw new Error('request_decision 需要 question(要人拍板的问题)');
      const options = params.options ?? [];
      if (!Array.isArray(options) || options.length < 2 || options.some((o) => typeof o !== 'string' || !o.trim())) {
        throw new Error('request_decision 需要 options(≥2 个非空候选方向)');
      }
      const context = typeof params.context === 'string' && params.context.trim() ? params.context.trim() : undefined;

      // 先查 expert_search(question + context 关键词)——命中可验证则不问人。
      const query = `${question} ${context ?? ''}`.trim();
      let hits: ExpertEntry[] = [];
      try {
        hits = searchExpertEntries(openExpertStore(baseDir), query, { limit: EXPERT_SEARCH_LIMIT });
      } catch (err) {
        // 库不可用 → 按未命中降级(库边界标注,不 throw、不阻塞提请)。
        console.warn('[decision] expert 知识库不可用,按库中无基准处理:', err instanceof Error ? err.message : String(err));
      }
      const { expertHits, expertRefs } = buildExpertHitSummaries(hits);

      const record = requestDecision(
        { sessionId: getSessionId(), question, options, context, expertHits, expertRefs },
        broadcastFn,
      );
      return {
        content: [{
          type: 'text',
          text: `决策已提交(${record.decisionId}),等待人的决定。收到决定前暂停这条线的执行,`
            + '不要继续推进本方向——决定会作为 user 消息注入回来,届时严格按决定继续。'
            + (hits.length > 0 ? `(附专家基准 ${expertRefs.join('、')},人可参考)` : '(专家库无基准——已如实标注)'),
        }],
        details: { decisionId: record.decisionId, hitCount: hits.length },
      };
    },
  };
}
