/**
 * 1.4.1 — declare_completion loop 工具 + 达成声明注册表。
 *
 * 定位:auto loop 的「达成宣布」通道(design §6 判定权在 harness、
 * 陈述权在模型)。模型自认达成目标时调用 declare_completion:
 *   - statement:一句达成陈述(哪几条验收条件已满足、怎么满足的);
 *   - evidenceRefs:支撑陈述的研究记录引用(research_log 返回的 E#N 事件 id,
 *     即 research_events 行 id——与决策块 expertRefs 同「引用而非断言」
 *     风格)。
 *
 * 服务端只登记不判定:声明落内存注册表(按 loop 线分桶),auto-run runner
 * 在每轮收尾轮询本表——命中即转 awaiting-verdict、构建验收包并提请人终审。
 * 工具返回文本让模型停下等终审(不继续推进、不自我降级验收条件)。
 *
 * 纪律:
 *   - 纯注册表 + 工具工厂,绝不触网/不触真库(evidenceRefs 的存在性预检在
 *     runner 的 buildVerdictPackage 里做,本模块不查证);
 *   - 注册表内存态——服务重启即失效(对齐 decision pending 的「重启即
 *     失效」纪律);声明即消费(take 后清除,防止同一条线重复触发验收);
 *   - 叶子模块(不 import auto-run/chat-engine),由 chat-engine 注册进工具集、
 *     auto-run 轮询——no-circular 红线。
 */

import { Type, type Static } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

import { loadArchive } from './archive';

export const DECLARE_COMPLETION_TOOL_NAME = 'declare_completion';

/** 一次达成声明(注册表条目)。 */
export interface CompletionDeclaration {
  /** 声明时所在 loop 线(turn 快照线)——runner 按此归属验收流程。 */
  sessionId: string;
  statement: string;
  /** research_events 行 id(正整数;工具层校验,不查存在性)。 */
  evidenceRefs: number[];
  createdAt: string;
}

export interface CompletionToolDetails {
  refCount: number;
}

const declarations = new Map<string, CompletionDeclaration>();

/** 登记一次达成声明(同一条线覆盖式:重复声明以最新为准)。 */
export function declareCompletion(
  sessionId: string,
  statement: string,
  evidenceRefs: number[],
): CompletionDeclaration {
  const record: CompletionDeclaration = {
    sessionId,
    statement,
    evidenceRefs: [...evidenceRefs],
    createdAt: new Date().toISOString(),
  };
  declarations.set(sessionId, record);
  return record;
}

/** 取走某条线的达成声明(消费即清除——一次声明只触发一次验收)。 */
export function takeCompletionDeclaration(sessionId: string): CompletionDeclaration | null {
  const d = declarations.get(sessionId);
  if (!d) return null;
  declarations.delete(sessionId);
  return d;
}

/** 测试/关闭用:清空全部声明。 */
export function clearCompletionDeclarations(): void {
  declarations.clear();
}

// ---------------------------------------------------------------------------
// declare_completion 工具(harness 原生能力,无条件注册)
// ---------------------------------------------------------------------------

const declareCompletionParameters = Type.Object({
  statement: Type.String({
    description: '达成陈述:一句/几句话说清已达成哪些验收条件、靠哪些证据支撑(引用证据时用 E#N 指研究事件编号——E#N 是研究事件专属口径,别与档案实体(H#/V#/C#/Q#)或其他编号混用)',
  }),
  evidenceRefs: Type.Optional(Type.Array(Type.Number({
    description: 'research_log 返回的研究事件编号(E#N 的 N)',
    minimum: 1,
  }), { description: '支撑达成陈述的研究记录引用(research_events 事件 id 数组)' })),
});

export type DeclareCompletionParams = Static<typeof declareCompletionParameters>;

export interface CreateDeclareCompletionToolOptions {
  /** 当前 loop 线(turn 快照线)——声明归属与 runner 验收路由依据。 */
  getSessionId?: () => string;
  /** 档案存储目录(测试注入临时目录;缺省 loop-sessions 默认目录)。 */
  dir?: string;
}

/** 归一化 evidenceRefs:数字数组 → 去重正整数;非整数/≤0 抛错(工具错误语义)。 */
export function parseEvidenceRefs(raw: unknown): number[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('declare_completion: evidenceRefs 必须是研究事件编号数组(如 [3, 7])');
  }
  const ids: number[] = [];
  for (const item of raw) {
    const n = typeof item === 'number' ? item : Number(item);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`declare_completion: evidenceRefs 含非法编号 "${String(item)}"(research_log 返回的正整数事件编号)`);
    }
    if (!ids.includes(n)) ids.push(n);
  }
  return ids;
}

/**
 * 构造 declare_completion 工具。执行体只登记 + 返回「停等终审」指令;
 * 判定与验收全在 runner(harness)侧。
 */
export function createDeclareCompletionTool(
  options: CreateDeclareCompletionToolOptions = {},
): AgentTool<typeof declareCompletionParameters, CompletionToolDetails> {
  const getSessionId = options.getSessionId ?? (() => '');
  return {
    name: DECLARE_COMPLETION_TOOL_NAME,
    label: '宣布目标达成(提请验收终审)',
    description:
      '确认目标已达成、且所有验收条件都有研究记录证据支撑时,调用本工具宣布达成——'
      + 'statement 写明达成哪些验收条件、证据如何支撑;evidenceRefs 挂上 research_log 返回的研究事件编号(#N)。'
      + '调用后立即停止推进,等待研究员的验收终审;终审通过才叫完成。'
      + '纪律:验收条件由研究员定义且不可变,不得自我降级或漂移表述;没有证据支撑的条件不要宣称达成。',
    parameters: declareCompletionParameters,
    execute: async (_toolCallId, params): Promise<AgentToolResult<CompletionToolDetails>> => {
      const statement = (params.statement ?? '').trim();
      if (!statement) throw new Error('declare_completion 需要 statement(达成陈述)');
      const evidenceRefs = parseEvidenceRefs(params.evidenceRefs);
      declareCompletion(getSessionId(), statement, evidenceRefs);
      // 1.4.7 证伪结案提醒:档案还有待验证假设 → 返回里带提醒(不阻塞;
      // 读侧容错——档案缺失/读取失败按无提醒)。「他可也能不会用」的轻量纪律。
      let reminder = '';
      try {
        const pending = loadArchive(getSessionId(), { dir: options.dir }).entities
          .filter((e) => e.kind === 'hypothesis' && e.status === 'pending');
        if (pending.length > 0) {
          reminder = ` 提醒:档案里还有 ${pending.length} 条待验证假设(${pending.map((e) => e.id).join('、')})——确认达成前给它们终态:证实(resolve)、证伪(falsify)或搁置(abandon)。`;
        }
      } catch {
        /* 档案读取失败不阻塞声明 */
      }
      return {
        content: [{
          type: 'text',
          text: `达成声明已提交(证据引用 ${evidenceRefs.length} 条)。等待研究员终审——`
            + '终审通过前不要继续推进、不要再调用工具;终审决定会作为消息回来,届时严格按决定执行。'
            + reminder,
        }],
        details: { refCount: evidenceRefs.length },
      };
    },
  };
}
