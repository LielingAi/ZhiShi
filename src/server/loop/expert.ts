/**
 * expert_search / expert_draft — 宿主侧专家知识工具（1.2.1 专家知识层·骨架期）。
 *
 * 与 research_log / intel_search 同类：harness 原生能力，不依赖 env、不依赖
 * 外部 MCP，chat-engine 的 runPiTurn 无条件注册。执行体读写 expert.db
 * （sidecar 进程持有的本地库）。
 *
 * 权威层级边界（docs/spec/expert-knowledge-plan.md §3.7，写进工具描述防混层）：
 * - expert_search：专家审定知识，**决策级依据**——与你的判断冲突时以它为准；
 * - intel_search：公共原料，线索不是结论；
 * - 蒸馏经验（memory.db）：自己的历史，参考级。
 *
 * 降级纪律同 intel_search：库不可用（better-sqlite3 缺失等）不 throw——
 * 返回可读的降级文本；空库/未命中明确标注「无专家知识（库边界，未命中≠
 * 不存在）」，不阻塞、不静默。
 */
import { Type, type Static } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

import { getZhiShiDataDir } from '../utils/app-dirs';
import { RESEARCH_TASK_KINDS, isResearchTaskKind } from '../memory/store';
import { openExpertStore, insertDraft, type ExpertEntry } from '../expert/store';
import { searchExpertEntries, EXPERT_SEARCH_LIMIT } from '../expert/search';
import { computeContentHash, validateEntry, EXPERT_ENTRY_KINDS } from '../expert/validate';

export const EXPERT_SEARCH_TOOL_NAME = 'expert_search';
export const EXPERT_DRAFT_TOOL_NAME = 'expert_draft';

/** 单条命中 content 的截断上限（截断护栏同 intel_search 纪律）。 */
export const EXPERT_CONTENT_PREVIEW_CHARS = 800;

// ===== expert_search =====

/** 字符串闭集 → Type.Union(字面量) schema（保留字面量类型，Static 推导出闭集联合）。 */
function literalUnion<T extends string>(values: readonly T[], description: string) {
  type Lit = ReturnType<typeof Type.Literal<T>>;
  return Type.Union(
    values.map((v) => Type.Literal(v)) as unknown as [Lit, ...Lit[]],
    { description },
  );
}

const expertSearchParameters = Type.Object({
  query: Type.String({
    description: '检索词：技术点 / 场景 / 问题描述（如 stack canary 绕过、WebLogic 反序列化）',
  }),
  domain: Type.Optional(literalUnion(RESEARCH_TASK_KINDS, `可选域过滤（${RESEARCH_TASK_KINDS.join(' / ')}）`)),
});

export type ExpertSearchParams = Static<typeof expertSearchParameters>;

export interface ExpertSearchToolDetails {
  hitCount: number;
  /** 库不可用（better-sqlite3 缺失等）时 true——按未命中降级。 */
  unavailable: boolean;
}

function truncate(text: string, maxChars: number): string {
  const oneLine = text.trim();
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars - 1)}…` : oneLine;
}

/** 单条命中的渲染：LLM 需要权威来源（provenance + reviewer）才能赋权。 */
export function formatExpertHit(entry: ExpertEntry): string {
  const source = entry.reviewer
    ? `${entry.provenance}（审定: ${entry.reviewer}）`
    : entry.provenance;
  return [
    `#${entry.id} [${entry.domain}/${entry.kind}] ${entry.title}`,
    `适用条件: ${truncate(entry.applicability, 200)}`,
    `内容:\n${truncate(entry.content, EXPERT_CONTENT_PREVIEW_CHARS)}`,
    `判据: ${truncate(entry.criteria, 300)}`,
    `来源: ${source}`,
  ].join('\n');
}

/** 结果文本：权威标记包裹（与 intel_search 的「线索不是结论」形成对照）。 */
export function formatExpertSearchResult(args: {
  query: string;
  hits: ExpertEntry[];
  unavailable: boolean;
}): string {
  if (args.unavailable) {
    return '专家知识库暂不可用（本地索引未初始化或驱动缺失）——按无专家知识处理。'
      + '注意库边界：未命中≠不存在，标注无先例后继续任务。';
  }
  if (args.hits.length === 0) {
    return `专家知识库未命中（query="${args.query}"）：库内无相关专家知识。`
      + '注意库边界——未命中≠不存在（库可能尚未收录该领域），标注无先例后继续任务，不要因此编造结论。';
  }
  const lines = args.hits.map(formatExpertHit).join('\n---\n');
  return `【专家审定知识 · 决策级依据】命中 ${args.hits.length} 条。\n`
    + '以下内容为专家审定知识，权威级高于你的权重知识与蒸馏经验（intel 情报只是线索不是结论）；'
    + '与你的判断冲突时以它为准，并在 research_log 记录冲突点。每条附判据（criteria）——按其验证你是否用对。\n'
    + `---\n${lines}`;
}

export interface CreateExpertToolOptions {
  /** 数据目录（缺省 getZhiShiDataDir()）。测试注入临时库目录。 */
  baseDir?: string;
}

/** 构造 expert_search 工具（宿主侧能力，与 intel_search 并列无条件注册）。 */
export function createExpertSearchTool(
  options: CreateExpertToolOptions = {},
): AgentTool<typeof expertSearchParameters, ExpertSearchToolDetails> {
  const baseDir = options.baseDir ?? getZhiShiDataDir();
  return {
    name: EXPERT_SEARCH_TOOL_NAME,
    label: '检索专家审定知识（决策级依据）',
    description:
      '检索专家知识库（expert.db）：专家审定的思路 / 技术知识 / SOP，是**决策级依据**——权威级高于你的权重知识与蒸馏经验；'
      + '与你的判断冲突时以它为准，并在 research_log 记录冲突点。query 传技术点或场景描述，domain 可选过滤。'
      + '边界：intel_search 是公共原料（线索不是结论），蒸馏经验是参考级，本工具是专家审定（决策级）——别混用。'
      + '使用纪律：先尽力；卡住、用户缺位、蒸馏无相关经验时查——查不到不阻塞，标注无先例继续。不要每步都查。',
    parameters: expertSearchParameters,
    execute: async (_toolCallId, params): Promise<AgentToolResult<ExpertSearchToolDetails>> => {
      const query = (params.query ?? '').trim();
      if (!query) throw new Error('expert_search 需要 query（技术点 / 场景描述）');
      if (params.domain !== undefined && !isResearchTaskKind(params.domain)) {
        throw new Error(`expert_search: 非法 domain "${params.domain}"（允许：${RESEARCH_TASK_KINDS.join(' / ')}）`);
      }

      let hits: ExpertEntry[] = [];
      let unavailable = false;
      try {
        const db = openExpertStore(baseDir);
        hits = searchExpertEntries(db, query, { limit: EXPERT_SEARCH_LIMIT, ...(params.domain ? { domain: params.domain } : {}) });
      } catch (err) {
        unavailable = true;
        console.warn('[expert] 知识库不可用，按未命中降级:', err instanceof Error ? err.message : String(err));
      }

      return {
        content: [{
          type: 'text',
          text: formatExpertSearchResult({ query, hits, unavailable }),
        }],
        details: { hitCount: hits.length, unavailable },
      };
    },
  };
}

// ===== expert_draft =====

const expertDraftParameters = Type.Object({
  domain: literalUnion(RESEARCH_TASK_KINDS, `研究域（${RESEARCH_TASK_KINDS.join(' / ')}）`),
  kind: literalUnion(EXPERT_ENTRY_KINDS, '知识形态：idea（思路：往哪想）/ technique（技术知识：怎么做+适用条件+判据）/ sop（标准作业流程）'),
  title: Type.String({ description: '标题（一句话说清这是什么知识）' }),
  applicability: Type.String({ description: '适用条件：什么时候该用它（必填）' }),
  content: Type.String({ description: 'markdown 正文：知识本体（必填）' }),
  criteria: Type.String({ description: '判据：怎么验证用对了（必填——校准闭环的关键）' }),
  tags: Type.Optional(Type.String({ description: '逗号分隔标签（可选）' })),
});

export type ExpertDraftParams = Static<typeof expertDraftParameters>;

export interface ExpertDraftToolDetails {
  draftId: number | null;
}

/**
 * 构造 expert_draft 工具（agent 起草通道）。起草不是生效——草稿进
 * expert_drafts 表，研究员审定（zhishi expert review）通过才进 entries。
 */
export function createExpertDraftTool(
  options: CreateExpertToolOptions = {},
): AgentTool<typeof expertDraftParameters, ExpertDraftToolDetails> {
  const baseDir = options.baseDir ?? getZhiShiDataDir();
  return {
    name: EXPERT_DRAFT_TOOL_NAME,
    label: '起草专家知识（待人审，不直接生效）',
    description:
      '把一段经验起草为专家知识候选。这是**起草不是生效**：草稿进待审队列，研究员审定通过后才会进专家知识库；'
      + '审定前不要把草稿当作已生效知识引用。仅当研究员明确说「存为专家知识」或等价意图时调用。'
      + '字段纪律：applicability（何时用）与 criteria（怎么验证用对）必填——没有判据的经验不配进库。',
    parameters: expertDraftParameters,
    execute: async (_toolCallId, params): Promise<AgentToolResult<ExpertDraftToolDetails>> => {
      // 草稿 provenance 暂记 user（人审通道的归口）；reviewer 在审定时才填，
      // 故草稿校验跳过 reviewer 条件必填，其余契约不变。
      const result = validateEntry({
        domain: params.domain,
        kind: params.kind,
        title: params.title,
        applicability: params.applicability,
        content: params.content,
        criteria: params.criteria,
        provenance: 'user',
        tags: params.tags,
      }, { skipReviewer: true });
      if (!result.ok) {
        throw new Error(`expert_draft 草稿不符合格式契约：${result.errors.join('；')}`);
      }
      let draftId: number;
      try {
        const db = openExpertStore(baseDir);
        const draft = insertDraft(db, result.value, computeContentHash(result.value), 'agent');
        draftId = draft.id;
      } catch (err) {
        throw new Error(`expert_draft 提交失败（知识库不可用）：${err instanceof Error ? err.message : String(err)}`);
      }
      return {
        content: [{
          type: 'text',
          text: `草稿已提交（draft #${draftId}），待研究员审定后生效——审定通过前不会进 expert.db，`
            + '也不要在本轮把它当作已生效的专家知识引用。',
        }],
        details: { draftId },
      };
    },
  };
}
