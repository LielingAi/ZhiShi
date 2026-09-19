/**
 * 1.4.1 / 1.7.7 — declare_completion loop 工具 + 达成声明注册表 + 证据预检。
 *
 * 定位:auto loop 的「达成宣布」通道(design docs/design/auto-redesign.md §2
 * 判定权在 harness 的预检、陈述权在模型)。模型自认达成目标时调用
 * declare_completion:
 *   - statement:一句达成陈述(哪几条验收条件已满足、怎么满足的);
 *   - criteria:声称达成的验收条件原文(与启动锁定的条件做精确/包含匹配);
 *   - evidenceRefs:支撑陈述的证据引用——research_log 返回的 E#N 事件编号
 *     (数字)或研究档案实体编号(H#/V#/C#/Q#,字符串)。
 *
 * 1.7.7(auto-redesign):OR 语义——任一条件命中即达成。预检纯函数
 * precheckCompletionDeclaration 由 auto-run runner 消费:条件匹配 + 至少一条
 * 证据真实存在 → 达成(completed);不过 → 失败原因回注 loop 线继续推进。
 * 交互模式(campaign/security)无消费方,登记语义照旧(声明按线分桶不串)。
 *
 * 纪律:
 *   - 纯注册表 + 预检纯函数,绝不触网(evidenceRefs 的存在性由调用方注入
 *     resolveEvent/loadArchive 查证,本模块不直连 memory.db);
 *   - 注册表内存态——服务重启即失效(对齐 decision pending 的「重启即
 *     失效」纪律);声明即消费(take 后清除,防止同一条线重复触发验收);
 *   - 叶子模块(不 import auto-run/chat-engine),由 chat-engine 注册进工具集、
 *     auto-run 轮询——no-circular 红线。
 */

import { Type, type Static } from '@earendil-works/pi-ai';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';

import { loadArchive } from './archive';

export const DECLARE_COMPLETION_TOOL_NAME = 'declare_completion';

/** 证据引用:数字 = research_log 的 E#N 事件 id;字符串 = 档案实体编号(H#1/V#2…)。 */
export type EvidenceRef = number | string;

/** 一次达成声明(注册表条目)。 */
export interface CompletionDeclaration {
  /** 声明时所在 loop 线(turn 快照线)——runner 按此归属验收流程。 */
  sessionId: string;
  statement: string;
  /** 声称达成的验收条件原文(OR 语义;预检与启动锁定条件做精确/包含匹配)。 */
  criteria: string[];
  /** 证据引用(工具层只做形状校验,存在性由预检查证)。 */
  evidenceRefs: EvidenceRef[];
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
  criteria: string[],
  evidenceRefs: EvidenceRef[],
): CompletionDeclaration {
  const record: CompletionDeclaration = {
    sessionId,
    statement,
    criteria: [...criteria],
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

/**
 * 测试/关闭用:清空声明。带 sessionId 时只清该 loop 线的声明
 * (1.6.0 auto-run 终态按线清理,不动其他线的声明)。
 */
export function clearCompletionDeclarations(sessionId?: string): void {
  if (sessionId === undefined) {
    declarations.clear();
    return;
  }
  declarations.delete(sessionId);
}

// ---------------------------------------------------------------------------
// 达成证据预检(1.7.7 B-2;纯函数,runner 调用,可单测)
// ---------------------------------------------------------------------------

/** 预检依赖注入:证据存在性查证(生产 = memory.db + 档案;测试注入假表)。 */
export interface DeclarePrecheckResolvers {
  /** E#N → research_events 行(数字引用;查不到 = null)。 */
  resolveEvent: (id: number) => { id: number } | null;
  /** 档案实体(字符串引用 H#/V#/C#/Q#;读不到 = null)。 */
  loadArchive: (sessionId: string) => { entities: Array<{ id: string }> } | null;
}

export type DeclarePrecheckResult = { ok: true } | { ok: false; error: string };

const PRECHECK_NO_CRITERIA_ERROR = '宣称未对应任何验收条件';
const PRECHECK_NO_EVIDENCE_ERROR =
  '证据引用全部不存在——请挂真实的研究事件编号(E#N 数字)或研究档案实体编号(H#/V#/C#/Q# 字符串)';

/**
 * 达成预检(auto-redesign §2:harness 只做条件命中 + 证据存在性检查,不判
 * pass/fail、不判发现质量):
 *   (a) criteria 非空,且每条与启动锁定的条件原文匹配(精确或包含);
 *   (b) evidenceRefs 至少一条真实存在(E#N 查 research_events,档案实体查
 *       loadArchive)。
 * 两者都过 → 达成;否则返回具体失败原因(runner 回注 loop 线继续推进)。
 */
export function precheckCompletionDeclaration(
  declaration: { criteria: string[]; evidenceRefs: EvidenceRef[] },
  lockedCriteria: string[],
  resolvers: DeclarePrecheckResolvers,
  sessionId: string,
): DeclarePrecheckResult {
  const claimed = (declaration.criteria ?? []).map((c) => c.trim()).filter((c) => c.length > 0);
  if (claimed.length === 0) return { ok: false, error: PRECHECK_NO_CRITERIA_ERROR };
  for (const text of claimed) {
    const matched = lockedCriteria.some(
      (lc) => lc === text || lc.includes(text) || text.includes(lc),
    );
    if (!matched) {
      return { ok: false, error: `${PRECHECK_NO_CRITERIA_ERROR}(未匹配原文:「${text.slice(0, 80)}」)` };
    }
  }
  const archiveEntities = resolvers.loadArchive(sessionId)?.entities ?? [];
  const anyEvidenceExists = (declaration.evidenceRefs ?? []).some((ref) =>
    typeof ref === 'number'
      ? resolvers.resolveEvent(ref) !== null
      : archiveEntities.some((e) => e.id === String(ref)),
  );
  if (!anyEvidenceExists) return { ok: false, error: PRECHECK_NO_EVIDENCE_ERROR };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// declare_completion 工具(harness 原生能力,无条件注册)
// ---------------------------------------------------------------------------

const declareCompletionParameters = Type.Object({
  statement: Type.String({
    description: '达成陈述:一句/几句话说清已达成哪些验收条件、靠哪些证据支撑(引用研究事件用 E#N 编号,档案实体用 H#/V#/C#/Q# 编号)',
  }),
  criteria: Type.Optional(Type.Array(Type.String({
    description: '声称达成的验收条件原文(逐条原样列出)',
  }), { description: '声称达成的验收条件原文数组(OR 语义:任一条成立即完成;与启动锁定的条件做精确/包含匹配)' })),
  evidenceRefs: Type.Optional(Type.Array(Type.Union([
    Type.Number({
      description: 'research_log 返回的研究事件编号(E#N 的 N)',
      minimum: 1,
    }),
    Type.String({
      description: '研究档案实体编号(如 "H#1" / "V#2" / "C#3" / "Q#4")',
      minLength: 1,
    }),
  ]), { description: '支撑达成陈述的证据引用:研究事件编号(数字)或档案实体编号(字符串)' })),
});

export type DeclareCompletionParams = Static<typeof declareCompletionParameters>;

export interface CreateDeclareCompletionToolOptions {
  /** 当前 loop 线(turn 快照线)——声明归属与 runner 验收路由依据。 */
  getSessionId?: () => string;
  /** 档案存储目录(测试注入临时目录;缺省 loop-sessions 默认目录)。 */
  dir?: string;
}

/** 归一化 evidenceRefs:数字(正整数)或非空字符串,去重保序;非法抛错(工具错误语义)。 */
export function parseEvidenceRefs(raw: unknown): EvidenceRef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('declare_completion: evidenceRefs 必须是证据引用数组(如 [3, "H#1"])');
  }
  const refs: EvidenceRef[] = [];
  for (const item of raw) {
    if (typeof item === 'number') {
      if (!Number.isInteger(item) || item <= 0) {
        throw new Error(`declare_completion: evidenceRefs 含非法编号 "${String(item)}"(research_log 返回的正整数事件编号)`);
      }
      if (!refs.includes(item)) refs.push(item);
      continue;
    }
    if (typeof item === 'string') {
      const s = item.trim();
      if (!s) throw new Error('declare_completion: evidenceRefs 含空字符串档案编号');
      if (!refs.includes(s)) refs.push(s);
      continue;
    }
    throw new Error(`declare_completion: evidenceRefs 含非法引用 "${String(item)}"(数字事件编号或字符串档案实体编号)`);
  }
  return refs;
}

/**
 * 构造 declare_completion 工具。执行体只登记(判定与验收在 runner 侧
 * precheckCompletionDeclaration;交互模式无消费方,登记语义照旧)。
 */
export function createDeclareCompletionTool(
  options: CreateDeclareCompletionToolOptions = {},
): AgentTool<typeof declareCompletionParameters, CompletionToolDetails> {
  const getSessionId = options.getSessionId ?? (() => '');
  return {
    name: DECLARE_COMPLETION_TOOL_NAME,
    label: '宣布目标达成(附条件与证据)',
    description:
      '确认任一验收条件已达成(OR 语义:满足任一条即完成)时,调用本工具宣布达成——'
      + 'statement 写明达成哪些条件、证据如何支撑;criteria 原样列出声称达成的验收条件原文;'
      + 'evidenceRefs 挂证据引用:research_log 返回的研究事件编号(E#N 的 N,数字)或研究档案实体编号(H#/V#/C#/Q#,字符串)。'
      + '调用后系统做证据预检:通过即完成;不通过会把原因注回并继续推进——按注回继续工作。'
      + '纪律:验收条件由研究员定义且不可变,不得自我降级或漂移表述;没有证据支撑的条件不要宣称达成。',
    parameters: declareCompletionParameters,
    execute: async (_toolCallId, params): Promise<AgentToolResult<CompletionToolDetails>> => {
      const statement = (params.statement ?? '').trim();
      if (!statement) throw new Error('declare_completion 需要 statement(达成陈述)');
      const criteria = Array.isArray(params.criteria)
        ? params.criteria.map((c) => c.trim()).filter((c) => c.length > 0)
        : [];
      const evidenceRefs = parseEvidenceRefs(params.evidenceRefs);
      declareCompletion(getSessionId(), statement, criteria, evidenceRefs);
      // 1.4.7 证伪结案提醒:档案还有待验证假设 → 返回里带提醒(不阻塞;
      // 读侧容错——档案缺失/读取失败按无提醒)。「他也可能不会用」的轻量纪律。
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
          text: `达成声明已提交(声称 ${criteria.length} 条条件,证据引用 ${evidenceRefs.length} 条)。`
            + '系统将对照验收条件做证据预检:通过即完成;不通过会把原因注回并继续推进——请按注回继续工作。'
            + reminder,
        }],
        details: { refCount: evidenceRefs.length },
      };
    },
  };
}
