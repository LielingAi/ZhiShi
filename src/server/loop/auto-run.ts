/**
 * 1.4.1 — auto loop agent 服务端(design:docs/design/auto-loop-design.md)。
 *
 * 目标式多 turn 自主研究循环:研究员给目标+验收条件+预算,runner 在独立
 * loop 线(复用 cron B2 的 invokePiSession 通道,headless)逐轮自动驱动,
 * 人只在暂停点介入(Esc 终止/决策面板响应/预算续命/验收终审)。
 *
 * 分层(与 1.3.2 decision 同构,纯函数可单测):
 *   - 纯函数:启动校验 / 驱动文本组装 / 预算估算与耗尽判定 / 空转判定 /
 *     反复失败连击判定 / 阶段(1.2.7 分类器复用)/ 验收包构建 / 记录编解码;
 *   - 存储:auto-runs/<id>.json,withFileLock + tmp+rename(对齐
 *     bg-registry/loop-sessions 纪律;写失败仅告警,绝不拖死循环);
 *   - runner:createAutoRunController 注入全部依赖(invoke/研究事件查询/
 *     快照/广播/落盘/报告),不真连环境即可单测;
 *   - 生产接线:startAutoRun/stopAutoRun/renewAutoRunBudget/
 *     resolveAutoRunVerdict/listAutoRuns(admin-api 薄调用)。
 *
 * 暂停点实现口径(设计 §4/§5):
 *   - 空转/反复失败:harness 直接 raise requestDecision(1.3.2 原样复用,
 *     options=['继续跑','终止运行']),人经既有 /chat/decision/respond +
 *     injectPiDecision 注入回线;runner **轮询** pendingDecisions + loop 线
 *     decision marker(注入完成信号,防双 turn 并发读同一线),决定继续/终止。
 *     选轮询而非事件驱动的理由:respond 端点不经过 runner,无现成事件钩子;
 *     轮询间隔 pollMs(默认 1s)侵入最小,且 marker 落地即保证注入 turn 已
 *     收尾(appendLoopMessages 按 turn 原子写),无跨线竞态。
 *   - 越界(boundary-ask):loop 工具链内 boundary 是纯 deny 规则(boundary.ts),
 *     boundary-ask 只由服务端动作(report/export 等)发起,不在 invoke 线内
 *     触发——runner 无需等待,1.3.2 契约天然覆盖(见交付报告)。
 *   - 预算耗尽:checkpoint(开局快照同款,best-effort)→ paused{reason:'budget'}
 *     → 人经 auto-run/budget {id, limit} 续命(预算带数值,决策面板二选一
 *     装不下,故预算走专用端点;stall/失败走决策面板,二选一即够)。
 *   - 达成:declare_completion 工具(declare-completion.ts)登记声明,runner
 *     轮询注册表(take 即消费)→ awaiting-verdict → 验收包 → verdict-requested
 *     → 人经 auto-run/verdict 终审:pass 出报告/fail|continue 注回线续跑。
 *
 * 场景:InteractionScenario 新增 {type:'auto-run'}(system-prompt.ts)——cron
 * 同族的 headless 通道,但文案纠正「不要向用户提问」为「暂停点才提请」
 * (cron 模板原文与本设计的 request_decision 纪律直接冲突,见交付报告)。
 *
 * 1.6.0 状态机修复批次(auto loop 全链路审计 S1,逐条见改动处注释):
 *   ①终审按轮重置;②决策超时语义(未答无限等/已答读 resolved 记录);
 *   ③重启愈合保留 awaiting-verdict 孤儿终审通道;④resolveVerdict 已停拒绝;
 *   ⑤waiters 泄漏;⑥activeRuns 终态摘除;⑦终态清本线 pending 决策+声明;
 *   ⑧time 预算扣除暂停等待墙钟;⑨provider-error persist 前更新 spent;
 *   ⑩单实例闸 workspace 比较走 workspacePathsEqual。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { getZhiShiDataDir } from '../utils/app-dirs';
import { withFileLock, writeFileAtomic } from '../utils/file-lock';
import { isResearchOutcome } from '../../shared/research-kinds';
import type { ResearchEvent } from '../memory/store';
import {
  estimateMessageTokens,
  segmentContext,
  toolCallNamesOf,
  type ResearchPhase,
} from './context-manager';
import { pendingDecisions, requestDecision, getDecision, clearDecisions } from './decision';
import { takeCompletionDeclaration, clearCompletionDeclarations } from './declare-completion';
import type { PiSendInput } from './chat-engine';
import type { InteractionScenario } from '../system-prompt';

// 生产接线依赖(函数体只在 startAutoRun 等入口使用,纯函数单测不触)。
import { broadcast } from '../sse';
import { invokePiSession, getPiAgentState, getEnvSessionBinding } from './chat-engine';
import { appendLoopMessages, loadLoopSession, newLoopSessionId } from './session';
import { loadArchive } from './archive';
import { getResearchEventById, listResearchEvents } from '../memory/store';
import { findEnvironmentEntry, listEnvironments } from '../environment/registry';
import { envKeyForSelection } from '../environment/env-sessions';
import { loadConfig } from '../utils/admin-config';
import { resolveVmxForEntry } from '../environment/vm-guest-exec';
import { snapshotVm } from '../environment/vm-snapshot';
import { exportReport } from '../report/export';
import { buildLoopTranscript } from './transcript';
import { requestBoundaryAsk } from './boundary-ask';
import { resolveLoopModel } from './pi-provider';
import { runLoopText } from './loop';
import { getEntryById, hasExpertDb, openExpertStore } from '../expert/store';
import { workspacePathsEqual } from '../../shared/workspacePath';
import type { EnvironmentEntry } from '../../shared/config-types';
import { execInEnvironment, type EnvExec } from './env-exec';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutoRunStatus = 'running' | 'paused' | 'awaiting-verdict' | 'completed' | 'stopped';
export type AutoRunPauseReason = 'budget' | 'stall' | 'repeated-failures' | 'decision' | 'provider-error';

/** 预算三选一:turns 轮次 / tokens 估算 token / time 分钟。limit 恒为上限,spent 恒为已耗。 */
export type AutoRunBudget =
  | { kind: 'turns'; limit: number; spent?: number }
  | { kind: 'tokens'; limit: number; spent?: number }
  | { kind: 'time'; limit: number; spent?: number };

export interface AutoRunDeclaration {
  statement: string;
  evidenceRefs: number[];
}

/** 验收包证据预检结构(设计 §6:每条 criteria × 证据引用命中/未命中)。 */
export interface VerdictEvidenceRef {
  id: number;
  hit: boolean;
  summary?: string;
  taskKind?: string;
  outcome?: string;
}

export interface VerdictCriteriaPrecheck {
  text: string;
  /** evidence:引用全命中;partial:部分命中;none:无引用或全未命中。 */
  status: 'evidence' | 'partial' | 'none';
}

export interface VerdictPackage {
  statement: string;
  evidenceRefs: VerdictEvidenceRef[];
  hitCount: number;
  missCount: number;
  criteriaPrecheck: VerdictCriteriaPrecheck[];
}

/**
 * auto-run/list 的对外 verdict 形状（与 GUI VerdictRequest 契约一致——
 * 恢复路径的终审弹窗按它渲染）。
 */
export interface VerdictRequestShape {
  criteria: Array<{
    text: string;
    hasEvidence: boolean;
    /** A2-6(1.5.4):criteriaPrecheck 不带 refs 数据,恢复路径没有可渲染的
     *  引用——字段可缺席(不再硬填空数组),渲染方判空。 */
    refs?: string[];
  }>;
  statement: string;
}

/**
 * AutoRunRecord.verdictPackage → 对外 verdict（list 归一化；1.4.6 dogfood
 * 实证：SSE 不重放 auto-run 事件族，list 是断线后终审弹窗的唯一恢复路径，
 * 缺这个归一化弹窗永远不出——run 卡死在 awaiting-verdict，人无法终审）。
 */
export function verdictRequestOfRecord(record: AutoRunRecord): VerdictRequestShape | undefined {
  const pkg = record.verdictPackage;
  if (!pkg || pkg.criteriaPrecheck.length === 0) return undefined;
  const criteria = pkg.criteriaPrecheck
    .map((c) => ({
      text: c.text.trim(),
      hasEvidence: c.status === 'evidence' || c.status === 'partial',
      // A2-6:criteriaPrecheck 无 refs 数据——不硬填空数组,字段缺席由渲染方判空。
    }))
    .filter((c) => c.text !== '');
  if (criteria.length === 0) return undefined;
  return { criteria, statement: pkg.statement };
}

/**
 * auto-run 记录(1.4.1 契约核心形状 + additive 服务端簿记字段)。
 * 落盘 <数据目录>/auto-runs/<id>.json,可追溯。
 */
export interface AutoRunRecord {
  id: string;
  name: string;
  envKey: string;
  goal: string;
  budget: AutoRunBudget;
  criteria: string[];
  status: AutoRunStatus;
  loopSessionId: string;
  pauseReason?: string;
  createdAt: string;
  updatedAt: string;
  // ---- additive(服务端簿记,不进启动契约):workspace 归属/轮次/声明/验收包/报告 ----
  workspace?: string;
  turns?: number;
  declaration?: AutoRunDeclaration;
  verdictPackage?: VerdictPackage;
  reportDir?: string;
  /** 1.6.0 修复⑧:暂停等待(终审/决策/预算续命)墙钟累计 ms——time 预算口径
   *  = elapsed - pausedMsTotal;序列化兼容缺省(旧记录无此字段按 0)。 */
  pausedMsTotal?: number;
}

// ---------------------------------------------------------------------------
// 常量(dogfood 后调参,设计 §10 挂账)
// ---------------------------------------------------------------------------

export const STALL_TURNS_DEFAULT = 6;
export const REPEATED_FAILURE_STREAK_DEFAULT = 3;
export const BUDGET_WARNING_RATIO = 0.8;
export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_POLL_MS = 1000;
export const DEFAULT_DECISION_WAIT_TIMEOUT_MS = 10 * 60_000;
export const NEXT_TURN_TEXT_MAX_CHARS = 2000;

// ---------------------------------------------------------------------------
// 纯函数 — 启动校验
// ---------------------------------------------------------------------------

export interface AutoRunStartInput {
  name?: unknown;
  envKey?: unknown;
  goal?: unknown;
  budget?: unknown;
  criteria?: unknown;
}

export interface ValidateStartOptions {
  /** envKey → 环境条目(生产 findEnvironmentEntry;测试注入假表)。 */
  findEnv: (envKey: string) => unknown;
  now?: () => number;
  newId?: () => string;
  loopSessionId?: string;
}

export type ValidateStartResult =
  | { ok: true; record: AutoRunRecord }
  | { ok: false; error: string };

function cleanText(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/** 解析并校验启动表单 → AutoRunRecord(校验失败给可读错误,4xx 语义)。 */
export function validateAutoRunStart(
  input: AutoRunStartInput,
  options: ValidateStartOptions,
): ValidateStartResult {
  const name = cleanText(input.name);
  if (!name) return { ok: false, error: '缺少必填字段 name(任务名)' };
  const goal = cleanText(input.goal);
  if (!goal) return { ok: false, error: '缺少必填字段 goal(目标陈述)' };
  const envKey = cleanText(input.envKey);
  if (!envKey) return { ok: false, error: '缺少必填字段 envKey(绑定环境)' };
  if (!options.findEnv(envKey)) {
    return { ok: false, error: `环境 "${envKey}" 未登记(zhishi env list 查看已登记环境)` };
  }

  const criteria = Array.isArray(input.criteria)
    ? (input.criteria as unknown[]).map((c) => cleanText(c)).filter((c): c is string => c !== null)
    : [];
  if (criteria.length === 0) {
    return { ok: false, error: '验收条件 criteria 必填且至少 1 条非空(研究员定义、不可变)' };
  }

  const budget = input.budget as { kind?: unknown; limit?: unknown } | undefined;
  const budgetKind = typeof budget?.kind === 'string' ? budget.kind : '';
  if (budgetKind !== 'turns' && budgetKind !== 'tokens' && budgetKind !== 'time') {
    return { ok: false, error: `预算 kind 必须是 turns / tokens / time 之一(收到 "${String(budget?.kind ?? '')}")` };
  }
  const limit = typeof budget?.limit === 'number' ? budget.limit : Number(budget?.limit);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { ok: false, error: '预算 limit 必须是 > 0 的数值' };
  }

  const now = (options.now ?? Date.now)();
  const record: AutoRunRecord = {
    id: options.newId ? options.newId() : `run-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
    name,
    envKey,
    goal,
    budget: { kind: budgetKind as AutoRunBudget['kind'], limit, spent: 0 },
    criteria,
    status: 'running',
    loopSessionId: options.loopSessionId ?? newLoopSessionId(),
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  return { ok: true, record };
}

// ---------------------------------------------------------------------------
// 纯函数 — 驱动文本组装
// ---------------------------------------------------------------------------

/** 第一轮驱动文本:目标 + 验收条件(锁定)+ 研究纪律。 */
export function buildFirstTurnText(goal: string, criteria: string[]): string {
  return [
    '【auto loop 任务】你要自主推进以下研究目标,直到达成或暂停点触发。本会话由系统逐轮自动驱动(headless),每轮结束自动发起下一轮,不需要请求继续、不要每轮都停。',
    `目标:${goal}`,
    '验收条件(研究员定义、启动即锁定,不可自我降级或漂移表述):',
    ...criteria.map((c, i) => `${i + 1}. ${c}`),
    '',
    '研究纪律:',
    '1. 关键进展/结案都用 research_log 留痕(拿到 flag、确认根因、fuzz 出崩溃、卡住、研判完成都要记)——这是验收证据的来源;',
    '2. 确认全部验收条件已达成且每条都有研究记录证据支撑时,调用 declare_completion 宣布达成(statement 写清哪条条件被哪条证据支撑,evidenceRefs 挂 research_log 返回的事件编号 E#N),然后停下等研究员终审;',
    '3. 方向分歧/关键取舍无把握、且 expert_search 无基准时,用 request_decision 提请人拍板,提请后停等决定注入;平时自主推进,不逐轮请示;',
    '4. 越界动作(写宿主/用本机凭据/改网络策略/销毁环境)会被边界拦截,如实遵守拦截提示;',
    '5. 研究档案(research_archive 工具)是你的显式研究状态,随研究持续更新、每轮注回你的上下文——基于它继续,不从历史脑补:假设驱动实验(evidence 挂假设引用);结论必须挂已存在的 V# 证据引用(op=finding refs,有反证挂 against,不报反证=确认偏误);证伪/纠错走 falsify/correct,不要把证伪写进 finding 文本冒充成立;假设要有终态(resolve/falsify/abandon);目标不清立 question;anchor 标注用「env_exec #N / 命令名 / 文件:行号」,不要用「轮」。**每 4 轮有档案检查点(驱动文本会标注「档案检查点」),届时按上列纪律整理**;',
  ].join('\n');
}

export interface NextTurnTextOptions {
  verdictNote?: string;
  maxChars?: number;
  /** 当前轮号（0 起）——1.5.0 确定性档案检查点用；不传不插检查点。 */
  turn?: number;
}

/** 1.5.0 确定性档案检查点间隔（每 N 轮一插——「第 N 轮该做」，不是
 *  「你想起来就做」。触发权归人的配套：auto loop 无人触发，由 harness
 *  按轮次确定性驱动）。 */
export const ARCHIVE_CHECKPOINT_INTERVAL = 4;

/** 档案检查点文本（确定轮到时的本轮任务追加）。 */
export const ARCHIVE_CHECKPOINT_TEXT =
  '【档案检查点】本轮结束前用 research_archive 整理研究状态：在验假设继续推进实验；'
  + '已证实/推翻/不追的假设给终态(resolve/falsify/abandon)；新实验结果记 evidence(挂假设引用)；'
  + '确认的结论 op=finding(refs 挂 V# 证据引用,有反证挂 against)；缺什么立 question。';

/** 后续轮驱动文本:「继续推进目标,上一轮结果:<截断>」(可选附人终审反馈)。
 *  1.5.0：带 turn 时每 ARCHIVE_CHECKPOINT_INTERVAL 轮追加档案检查点
 *  （确定性驱动，不靠模型自觉）。 */
export function buildNextTurnText(goal: string, previousText: string, options: NextTurnTextOptions = {}): string {
  const maxChars = options.maxChars ?? NEXT_TURN_TEXT_MAX_CHARS;
  const clipped = previousText.trim().length > maxChars
    ? `${previousText.trim().slice(0, maxChars)}…(截断)`
    : previousText.trim();
  const checkpoint = options.turn !== undefined && (options.turn + 1) % ARCHIVE_CHECKPOINT_INTERVAL === 0;
  return [
    `【auto loop 继续】继续推进目标:${goal}`,
    options.verdictNote ? `人终审反馈:${options.verdictNote}` : '',
    `上一轮结果(截断):${clipped || '(无输出)'}`,
    '继续自主推进;关键进展用 research_log 留痕;研究档案(research_archive)持续更新——结论挂 V# 证据引用、证伪走 falsify/correct;全部验收条件达成且有证据时调用 declare_completion;无把握的取舍用 request_decision。',
    checkpoint ? ARCHIVE_CHECKPOINT_TEXT : '',
  ].filter((line) => line.length > 0).join('\n');
}

// ---------------------------------------------------------------------------
// 纯函数 — 预算
// ---------------------------------------------------------------------------

export interface BudgetSpendInput {
  turns: number;
  tokens: number;
  elapsedMs: number;
  /**
   * 1.6.0:tokens 档校准系数(loop session meta 的 tokenCalibration——
   * 1.5.3 学习侧写盘的真实/估算比)。缺省/非法 → 1;钳界 [0.8, 6] 与
   * 学习侧(compaction 口径)一致。
   */
  calibration?: number;
  /** 1.6.0 修复⑧:暂停等待墙钟累计 ms(缺省 0)——time 档从 elapsed 扣除,
   *  暂停等人(终审/决策/预算续命)不算消耗。 */
  pausedMs?: number;
}

/** 1.6.0:校准系数钳界——与 1.5.3 学习侧写入时的 [0.8, 6] 同口径。 */
export function clampTokenCalibration(calibration: number | undefined): number {
  if (typeof calibration !== 'number' || !Number.isFinite(calibration)) return 1;
  return Math.min(6, Math.max(0.8, calibration));
}

/** 预算已耗计算:turns 计轮次 / tokens 计估算×校准系数 / time 计 wall-clock 分钟。 */
export function computeBudgetSpent(budget: AutoRunBudget, input: BudgetSpendInput): number {
  switch (budget.kind) {
    case 'turns': return input.turns;
    // 1.6.0:tokens 档 spent = 原始估算 × 校准系数(缺省 1)——估算系统性
    // 偏低/偏高时预算不再失准(校准来源见 BudgetSpendInput.calibration)。
    case 'tokens': return input.tokens * clampTokenCalibration(input.calibration);
    // 1.6.0 修复⑧:暂停等待墙钟不计入 time 消耗(暂停段由 runner 累加进
    // record.pausedMsTotal 传入;钳 0 防 pausedMs > elapsed 的脏数据出负值)。
    case 'time': return Math.max(0, input.elapsedMs - (input.pausedMs ?? 0)) / 60_000;
  }
}

export function isBudgetExhausted(budget: AutoRunBudget, spent: number): boolean {
  return spent >= budget.limit;
}

/** 余量 ≤ 20% 时警告(未耗尽才算,耗尽走暂停路径)。 */
export function isBudgetWarning(budget: AutoRunBudget, spent: number): boolean {
  return !isBudgetExhausted(budget, spent) && spent >= budget.limit * BUDGET_WARNING_RATIO;
}

/** loop 线历史 token 估算(context-manager 的 estimateMessageTokens 口径)。 */
export function estimateLoopTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

// ---------------------------------------------------------------------------
// 纯函数 — 暂停点证据判定
// ---------------------------------------------------------------------------

/**
 * 自启动以来新增的**有效**研究记录数。有效 = outcome 在闭集内
 * (RESEARCH_OUTCOMES;写库已校验,这里是读侧兜底——非法/脏行不算进展)。
 */
export function countValidEventsSince(events: ResearchEvent[], sinceTs: number): number {
  let count = 0;
  for (const e of events) {
    if (e.ts >= sinceTs && isResearchOutcome(e.outcome)) count++;
  }
  return count;
}

export interface StallCheckInput {
  /** 本轮新增的有效研究记录数(相对上一轮末的快照;=0 表示本轮无新增)。 */
  newValidEvents: number;
  /** 上一轮末的阶段(undefined = 尚无阶段基线,首轮不判空转)。 */
  previousPhase: ResearchPhase | undefined;
  /** 本轮末的阶段(1.2.7 分类器)。 */
  phase: ResearchPhase;
  /** 连续空转轮数(本轮判定前的值)。 */
  stallStreak: number;
}

export interface StallCheckOutput {
  stallStreak: number;
  stalled: boolean;
}

/**
 * 空转判定(设计 §5):本轮既无新增有效研究记录、阶段也未推进 → streak+1;
 * 达到 stallTurns(默认 6)即判定空转。主信号=记录增量,辅信号=阶段推进;
 * 首轮无阶段基线,不判空转(prevPhase undefined)。
 */
export function evaluateStall(input: StallCheckInput, stallTurns = STALL_TURNS_DEFAULT): StallCheckOutput {
  const stalledTurn = input.previousPhase !== undefined
    && input.newValidEvents === 0
    && input.phase === input.previousPhase;
  const stallStreak = stalledTurn ? input.stallStreak + 1 : 0;
  return { stallStreak, stalled: stallStreak >= stallTurns };
}

export interface RepeatedFailure {
  toolName: string;
  streak: number;
}

/**
 * 反复失败判定:loop 线最近 toolResult 的 isError 连击 ≥ minStreak(同类
 * 工具名)。从尾部倒扫:非错误结果打断连击;换工具名重新起组。
 */
export function detectRepeatedFailures(messages: AgentMessage[], minStreak = REPEATED_FAILURE_STREAK_DEFAULT): RepeatedFailure | null {
  let current: string | null = null;
  let streak = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; isError?: unknown; toolName?: unknown };
    if (m.role !== 'toolResult') continue;
    if (m.isError !== true) break;
    const name = typeof m.toolName === 'string' && m.toolName ? m.toolName : 'tool';
    if (current === null) {
      current = name;
      streak = 1;
    } else if (current === name) {
      streak++;
    } else {
      current = name;
      streak = 1;
    }
    if (streak >= minStreak) return { toolName: current, streak };
  }
  return null;
}

/** 当前研究阶段:1.2.7 同一分类器(segmentContext)末段相位;空历史 → anchor。 */
export function currentResearchPhase(messages: AgentMessage[]): ResearchPhase {
  const segments = segmentContext(messages);
  return segments.length > 0 ? segments[segments.length - 1].phase : 'anchor';
}

/** 最近动作摘要(loop 线尾部消息的 toolCall 名,去重保序)——暂停事件的诊断附注。 */
export function summarizeRecentToolCalls(messages: AgentMessage[], maxMessages = 30): string[] {
  const names: string[] = [];
  const tail = messages.slice(-maxMessages);
  for (const m of tail) {
    for (const name of toolCallNamesOf(m)) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// 纯函数 — 验收包(设计 §6)
// ---------------------------------------------------------------------------

export interface BuildVerdictPackageInput {
  id: string;
  criteria: string[];
  declaration: AutoRunDeclaration;
  /** 研究记录引用解析(getResearchEventById;测试注入假表)。 */
  resolveEvent: (id: number) => ResearchEvent | null;
}

/**
 * 验收包构建:每条证据引用做存在性预检(命中/未命中);每条 criteria 的
 * 预检状态按引用命中聚合(evidence=全命中/partial=部分命中/none=无引用
 * 或全未命中)。终审权在人——harness 只做证据预检(设计 §6)。
 */
export function buildVerdictPackage(input: BuildVerdictPackageInput): VerdictPackage {
  const evidenceRefs: VerdictEvidenceRef[] = input.declaration.evidenceRefs.map((id) => {
    const ev = input.resolveEvent(id);
    return {
      id,
      hit: ev !== null,
      ...(ev ? { summary: ev.summary } : {}),
      ...(ev ? { taskKind: ev.taskKind } : {}),
      ...(ev ? { outcome: ev.outcome } : {}),
    };
  });
  const hitCount = evidenceRefs.filter((r) => r.hit).length;
  const missCount = evidenceRefs.length - hitCount;
  const statusFor = (): VerdictCriteriaPrecheck['status'] => {
    if (hitCount > 0 && missCount === 0) return 'evidence';
    if (hitCount > 0) return 'partial';
    return 'none';
  };
  const criteriaPrecheck: VerdictCriteriaPrecheck[] = input.criteria.map((text) => ({
    text,
    status: statusFor(),
  }));
  return {
    statement: input.declaration.statement,
    evidenceRefs,
    hitCount,
    missCount,
    criteriaPrecheck,
  };
}

// ---------------------------------------------------------------------------
// 纯函数 — 记录编解码 / 存储
// ---------------------------------------------------------------------------

export function defaultAutoRunsDir(dir?: string): string {
  return dir ?? join(getZhiShiDataDir(), 'auto-runs');
}

/** 记录文件名(防路径穿越:id 只留字母数字/下划线/连字符)。 */
export function autoRunFilePath(id: string, dir: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '');
  return join(dir, `${safe}.json`);
}

const AUTO_RUN_KINDS = new Set(['turns', 'tokens', 'time']);
const AUTO_RUN_STATUSES = new Set(['running', 'paused', 'awaiting-verdict', 'completed', 'stopped']);

export function serializeAutoRunRecord(record: AutoRunRecord): string {
  return JSON.stringify(record, null, 2) + '\n';
}

/** 反序列化:坏 JSON/形状不符 → null(容错,不炸列表)。 */
export function parseAutoRunRecord(content: string): AutoRunRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const budget = o.budget as Record<string, unknown> | undefined;
  if (
    typeof o.id !== 'string' || o.id.length === 0 ||
    typeof o.loopSessionId !== 'string' || o.loopSessionId.length === 0 ||
    !AUTO_RUN_STATUSES.has(String(o.status)) ||
    !budget || typeof budget !== 'object' ||
    !AUTO_RUN_KINDS.has(String(budget.kind)) ||
    typeof budget.limit !== 'number' || !(budget.limit > 0)
  ) {
    return null;
  }
  const status = String(o.status) as AutoRunStatus;
  const kind = String(budget.kind) as AutoRunBudget['kind'];
  return {
    id: o.id,
    name: typeof o.name === 'string' ? o.name : '',
    envKey: typeof o.envKey === 'string' ? o.envKey : '',
    goal: typeof o.goal === 'string' ? o.goal : '',
    budget: { kind, limit: budget.limit, ...(typeof budget.spent === 'number' ? { spent: budget.spent } : {}) },
    criteria: Array.isArray(o.criteria) ? o.criteria.filter((c): c is string => typeof c === 'string') : [],
    status,
    loopSessionId: o.loopSessionId,
    ...(typeof o.pauseReason === 'string' ? { pauseReason: o.pauseReason } : {}),
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '',
    ...(typeof o.workspace === 'string' ? { workspace: o.workspace } : {}),
    ...(typeof o.turns === 'number' ? { turns: o.turns } : {}),
    ...(typeof o.reportDir === 'string' ? { reportDir: o.reportDir } : {}),
    // 1.6.0 修复⑧:序列化兼容缺省(旧记录无 pausedMsTotal → 字段缺席,消费侧 ?? 0)。
    ...(typeof o.pausedMsTotal === 'number' ? { pausedMsTotal: o.pausedMsTotal } : {}),
    ...(o.declaration && typeof o.declaration === 'object'
      ? { declaration: o.declaration as AutoRunDeclaration }
      : {}),
    ...(o.verdictPackage && typeof o.verdictPackage === 'object'
      ? { verdictPackage: o.verdictPackage as VerdictPackage }
      : {}),
  };
}

export interface AutoRunStoreOptions {
  dir?: string;
  logWarn?: (msg: string) => void;
}

/**
 * 落盘:withFileLock + tmp+rename 原子整写(对齐 bg-registry/loop-sessions)。
 * 写失败仅 logWarn——记录不是真相,丢写不拖死循环(1.4.1 稳定性红线)。
 */
export async function saveAutoRunRecord(record: AutoRunRecord, options: AutoRunStoreOptions = {}): Promise<void> {
  const dir = defaultAutoRunsDir(options.dir);
  const logWarn = options.logWarn ?? ((msg: string) => console.warn(msg));
  try {
    mkdirSync(dir, { recursive: true });
    const file = autoRunFilePath(record.id, dir);
    await withFileLock({ lockPath: `${file}.lock` }, async () => {
      writeFileAtomic(file, serializeAutoRunRecord(record));
    });
  } catch (err) {
    logWarn(`[auto-run] 记录落盘失败(内存态继续,重启后本记录不可恢复):${err instanceof Error ? err.message : String(err)}`);
  }
}

export function loadAutoRunRecord(id: string, options: AutoRunStoreOptions = {}): AutoRunRecord | null {
  const file = autoRunFilePath(id, defaultAutoRunsDir(options.dir));
  if (!existsSync(file)) return null;
  try {
    return parseAutoRunRecord(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/** 全量记录(时间倒序);坏文件跳过。 */
export function listAutoRunRecordFiles(options: AutoRunStoreOptions = {}): AutoRunRecord[] {
  const dir = defaultAutoRunsDir(options.dir);
  if (!existsSync(dir)) return [];
  const out: AutoRunRecord[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const rec = loadAutoRunRecord(f.slice(0, -'.json'.length), options);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * 重启愈合:sidecar 重启后 runner 已死(对齐 decision pending 的「服务重启
 * 即失效」)——盘上 running/paused 记录标记 stopped,防「僵尸 running」永挂。
 * 1.6.0 修复③:awaiting-verdict **不愈合**——保留孤儿终审通道
 * (resolveOrphanedVerdict 按盘上记录结算 pass/fail);标 stopped 会让
 * 「弹得出但答不了」的终审连兜底结算都走不到。**按 workspace 限定**:
 * ~/.zhishi/auto-runs 是多工作区共享目录(Tab-scoped sidecar 各一个),本进程
 * 只愈合自己工作区的孤儿,不动别的 sidecar 的活 run;skipIds 由调用方传内存
 * 活动 run 的 id,防本进程自己的活 run 被盘上愈合误标。返回愈合条数。
 */
export async function recoverOrphanedAutoRuns(
  options: AutoRunStoreOptions & { workspace?: string; skipIds?: ReadonlySet<string> } = {},
): Promise<number> {
  const skip = options.skipIds ?? new Set<string>();
  const orphaned = listAutoRunRecordFiles(options).filter(
    (r) =>
      (r.status === 'running' || r.status === 'paused') &&
      !skip.has(r.id) &&
      (options.workspace === undefined ||
        (typeof r.workspace === 'string' && workspacePathsEqual(r.workspace, options.workspace))),
  );
  const now = new Date().toISOString();
  for (const r of orphaned) {
    await saveAutoRunRecord({
      ...r,
      status: 'stopped',
      pauseReason: 'sidecar-restart',
      updatedAt: now,
    }, options);
  }
  return orphaned.length;
}

// ---------------------------------------------------------------------------
// runner — 依赖注入面(纯函数单测之外,runner 测试也全假依赖)
// ---------------------------------------------------------------------------

export interface AutoRunDeps {
  workspace: string;
  invoke: (input: PiSendInput, options: {
    loopSessionId: string;
    scenario: InteractionScenario;
    timeoutMs?: number;
  }) => Promise<{ text: string; error?: string; loopSessionId: string }>;
  /** loop 线全量消息(loadLoopSession(...).messages)。 */
  loadMessages: (loopSessionId: string) => AgentMessage[];
  /**
   * 1.6.0:tokens 预算校准系数来源(loadLoopSession(...).meta?.tokenCalibration)。
   * 可选——不注入按系数 1(原口径);返回 undefined 同样按 1。
   */
  loadTokenCalibration?: (loopSessionId: string) => number | undefined;
  /** 本 workspace 的研究事件(任意序;runner 按 ts 过滤)。 */
  listEvents: () => ResearchEvent[];
  resolveEvent: (id: number) => ResearchEvent | null;
  /** 终审注回:把 verdict/应答作为 user 消息追加进 loop 线(jsonl 可追溯)。 */
  appendUserMessage: (loopSessionId: string, text: string) => Promise<void>;
  /**
   * 开局/checkpoint 留现场(best-effort:失败告警不阻断)。vm 走 vmrun 快照;
   * docker 无快照机制,写环境内 task.md(1.6.3 #7,设计 §4「现场在环境快照
   * + task.md」)——内容来自 record(目标/验收条件/当前状态/关键上下文),
   * 故第二参带 record。
   */
  snapshot: (envKey: string, record: AutoRunRecord) => Promise<{ ok: boolean; error?: string }>;
  /** verdict=pass 时自动出报告(复用 report/export 链路)。 */
  exportReport: (record: AutoRunRecord) => Promise<{ ok: boolean; reportDir?: string; error?: string }>;
  broadcast: (event: string, data: unknown) => void;
  /** 记录落盘(生产 saveAutoRunRecord,内部已告警不抛)。 */
  save: (record: AutoRunRecord) => void;
  now: () => number;
  log: (msg: string) => void;
  turnTimeoutMs: number;
  pollMs: number;
  /** 决策注入 marker 等待上限(注入 turn 卡死兜底)。 */
  decisionWaitTimeoutMs: number;
  stallTurns: number;
  repeatedFailureStreak: number;
}

const DEFAULT_DEP_KEYS = {
  turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
  pollMs: DEFAULT_POLL_MS,
  decisionWaitTimeoutMs: DEFAULT_DECISION_WAIT_TIMEOUT_MS,
  stallTurns: STALL_TURNS_DEFAULT,
  repeatedFailureStreak: REPEATED_FAILURE_STREAK_DEFAULT,
};

export function withAutoRunDepDefaults(partial: Partial<AutoRunDeps>): AutoRunDeps {
  return { ...DEFAULT_DEP_KEYS, ...partial } as AutoRunDeps;
}

// ---------------------------------------------------------------------------
// runner — 控制器(事件驱动 wake + 注册表轮询兜底)
// ---------------------------------------------------------------------------

export type VerdictChoice = 'pass' | 'fail' | 'continue';

/**
 * waitForWake 返回句柄(1.6.0 修复⑤):Promise + cancel——调用方在
 * Promise.race 中 sleep 胜出时 cancel 摘除本 waiter,防 internals.waiters
 * 只增不减(长暂停期间每 pollMs 泄漏一个)。cancel 幂等。
 */
export type WakeHandle = Promise<void> & { cancel: () => void };

export interface AutoRunController {
  readonly record: AutoRunRecord;
  isStopped(): boolean;
  /** Esc 语义:终止循环(当前 invoke turn 不中断,收尾后不再起新轮)。 */
  requestStop(): void;
  /** 预算续命(仅 paused+reason=budget;新上限必须 > 已耗)。 */
  renewBudget(limit: number): { ok: boolean; error?: string };
  /** 验收终审(仅 awaiting-verdict;1.6.0:run 已停拒绝——防作答被静默丢弃)。 */
  resolveVerdict(verdict: VerdictChoice, note?: string): { ok: boolean; error?: string };
  /** 端点到来的唤醒信号(事件驱动面;返回句柄带 cancel,见 WakeHandle)。 */
  waitForWake(): WakeHandle;
  /** 循环收尾(测试/关闭用)。 */
  waitUntilDone(): Promise<void>;
  /** 测试注入:读终审选择。 */
  __getVerdict(): { verdict: VerdictChoice | null; note?: string };
  /** runner 内部:消费终审后按轮重置(1.6.0 修复①)——下一轮 declare_completion
   *  能重新弹窗等人作答;幂等闸不受影响(本轮内重复作答仍拒)。 */
  __resetVerdict(): void;
  /** 测试注入:当前挂起的 wake waiter 数(1.6.0 修复⑤泄漏回归用)。 */
  __waiterCount(): number;
  /** runner 内部:循环收尾信号(等待方释放)。 */
  __finish(): void;
}

interface ControllerInternals {
  stopped: boolean;
  verdict: VerdictChoice | null;
  verdictNote?: string;
  renewedLimit: number | null;
  waiters: Array<() => void>;
  doneResolvers: Array<() => void>;
}

export function createAutoRunController(record: AutoRunRecord): AutoRunController {
  const internals: ControllerInternals = {
    stopped: false,
    verdict: null,
    renewedLimit: null,
    waiters: [],
    doneResolvers: [],
  };
  const wake = (): void => {
    const ws = internals.waiters;
    internals.waiters = [];
    for (const r of ws) r();
  };
  const finish = (): void => {
    const ds = internals.doneResolvers;
    internals.doneResolvers = [];
    for (const r of ds) r();
    wake();
  };
  return {
    record,
    isStopped: () => internals.stopped,
    requestStop() {
      if (internals.stopped) return;
      internals.stopped = true;
      wake();
    },
    renewBudget(limit) {
      if (record.status !== 'paused' || record.pauseReason !== 'budget') {
        return { ok: false, error: '仅预算耗尽暂停态可续命(auto-run/budget)' };
      }
      if (!Number.isFinite(limit) || limit <= 0) {
        return { ok: false, error: 'limit 必须是 > 0 的数值' };
      }
      if (limit <= (record.budget.spent ?? 0)) {
        return { ok: false, error: `新预算 ${limit} 必须大于已耗 ${Math.round((record.budget.spent ?? 0) * 100) / 100}(否则立即再次耗尽)` };
      }
      record.budget = { ...record.budget, limit };
      record.updatedAt = new Date().toISOString();
      internals.renewedLimit = limit;
      wake();
      return { ok: true };
    },
    resolveVerdict(verdict, note) {
      // 1.6.0 修复④:Esc/停止竞态——runner 已停(wait 已死)时再作答会被静默
      // 丢弃(internals.verdict 写入无人消费),前置拒绝让调用方拿到明确错误。
      if (internals.stopped) {
        return { ok: false, error: 'run 已终止,终审通道已关闭(作答不会被消费)' };
      }
      if (record.status !== 'awaiting-verdict') {
        return { ok: false, error: '仅 awaiting-verdict 态可终审(auto-run/verdict)' };
      }
      if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'continue') {
        return { ok: false, error: `verdict 必须是 pass / fail / continue(收到 "${String(verdict)}")` };
      }
      if (internals.verdict !== null) {
        return { ok: false, error: '终审已作答(幂等:重复 respond 不重复处理)' };
      }
      internals.verdict = verdict;
      if (note && note.trim()) internals.verdictNote = note.trim();
      wake();
      return { ok: true };
    },
    waitForWake: () => {
      let waiter: () => void = () => {};
      const promise = new Promise<void>((resolve) => {
        waiter = resolve;
        internals.waiters.push(waiter);
      }) as WakeHandle;
      // 1.6.0 修复⑤:race 落败方由调用方 cancel 摘除(幂等:wake 胜出时
      // waiters 已整体清空,indexOf 落空为 no-op)。
      promise.cancel = () => {
        const i = internals.waiters.indexOf(waiter);
        if (i >= 0) internals.waiters.splice(i, 1);
      };
      return promise;
    },
    waitUntilDone: () => new Promise<void>((resolve) => { internals.doneResolvers.push(resolve); }),
    __getVerdict: () => ({ verdict: internals.verdict, ...(internals.verdictNote ? { note: internals.verdictNote } : {}) }),
    __resetVerdict: () => { internals.verdict = null; internals.verdictNote = undefined; },
    __waiterCount: () => internals.waiters.length,
    __finish: () => finish(),
  };
}

// ---------------------------------------------------------------------------
// runner — 主循环
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** auto-run 专用交互场景(cron 同族 headless 通道,见 system-prompt.ts)。 */
export function autoRunScenario(runId: string): InteractionScenario {
  return { type: 'auto-run', runId };
}

/** 决策注入 marker:loop 线里某 decisionId 对应的 user 决策块(注入完成信号)。 */
export function findDecisionMarker(messages: AgentMessage[], decisionId: string): { choice?: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const d = (messages[i] as { decision?: { decisionId?: string; choice?: string } }).decision;
    if (d && d.decisionId === decisionId) {
      return { ...(d.choice ? { choice: d.choice } : {}) };
    }
  }
  return null;
}

const STOP_CHOICE_RE = /终止|停止|停掉|\bstop\b|\babort\b/i;

/**
 * 主循环编排(fire-and-forget;所有依赖注入,不真连环境)。轮次推进 +
 * 暂停点检查 + 达成/终审/预算续命/决策等待全部在此。
 */
export async function runAutoRunLoop(
  record: AutoRunRecord,
  ctl: AutoRunController,
  deps: AutoRunDeps,
): Promise<void> {
  const startedAtMs = deps.now();
  const loopSessionId = record.loopSessionId;
  let turn = record.turns ?? 0;
  let lastText = '';
  let stallStreak = 0;
  let prevPhase: ResearchPhase | undefined;
  let prevValidCount = 0;
  let budgetWarned = false;
  let verdictNote: string | undefined;

  const persist = (): void => deps.save(record);
  // wait 只在暂停点(终审/预算续命)使用——1.6.0 修复⑧:进出差额累加进
  // record.pausedMsTotal,time 预算口径 = elapsed - pausedMsTotal。
  const wait = async (pred: () => boolean): Promise<boolean> => {
    const pauseStartMs = deps.now();
    try {
      while (!pred() && !ctl.isStopped()) {
        const handle = ctl.waitForWake();
        await Promise.race([handle, sleep(deps.pollMs)]);
        handle.cancel(); // 1.6.0 修复⑤:sleep 胜出时摘除 waiter(幂等)
      }
      return !ctl.isStopped();
    } finally {
      record.pausedMsTotal = (record.pausedMsTotal ?? 0) + Math.max(0, deps.now() - pauseStartMs);
    }
  };

  deps.broadcast('auto-run:started', {
    id: record.id,
    name: record.name,
    envKey: record.envKey,
    goal: record.goal,
    budget: record.budget,
    // 1.6.0:发完整 criteria 数组(GUI 恢复路径渲染用);criteriaCount 保留兼容。
    criteria: record.criteria,
    criteriaCount: record.criteria.length,
    loopSessionId,
  });

  // 开局快照(best-effort:失败告警不阻断,设计 §3)。
  try {
    const snap = await deps.snapshot(record.envKey, record);
    if (!snap.ok) deps.log(`[auto-run] 开局快照失败(继续运行):${snap.error ?? 'unknown'}`);
  } catch (err) {
    deps.log(`[auto-run] 开局快照异常(继续运行):${err instanceof Error ? err.message : String(err)}`);
  }
  if (ctl.isStopped()) {
    record.status = 'stopped';
    record.updatedAt = new Date(deps.now()).toISOString();
    persist();
    deps.broadcast('auto-run:completed', { id: record.id, outcome: 'stopped' });
    return;
  }

  while (!ctl.isStopped()) {
    // ---- 1. 驱动文本 + invoke 本轮 ----
    const text = turn === 0
      ? buildFirstTurnText(record.goal, record.criteria)
      : buildNextTurnText(record.goal, lastText, { ...(verdictNote ? { verdictNote } : {}), turn });
    verdictNote = undefined;
    deps.log(`[auto-run] ${record.id} 第 ${turn + 1} 轮`);
    let result: { text: string; error?: string };
    try {
      result = await deps.invoke(
        { text },
        { loopSessionId, scenario: autoRunScenario(record.id), timeoutMs: deps.turnTimeoutMs },
      );
    } catch (err) {
      result = { text: '', error: err instanceof Error ? err.message : String(err) };
    }
    lastText = result.text ?? '';
    turn += 1;
    record.turns = turn;

    // 1.5.13 用户拍板：模型调用失败（供应商过载 503/挂起/中断/超时）不静默
    // 续跑（原形态：sleep 后下一轮，供应商标配故障时等于空转烧预算）——
    // 暂停 + 人工接管（决策点：继续/终止）。
    // 注意：超时失败的 invoke 其后台 turn 可能仍在跑（detach 语义）——人工
    // 作答的耗时通常已覆盖其残余生命；appendLoopMessages 有文件锁兜底。
    if (result.error) {
      record.status = 'paused';
      record.pauseReason = 'provider-error';
      record.updatedAt = new Date(deps.now()).toISOString();
      // 1.6.0 修复⑨:失败本轮 turn 已 +1,persist 前先同步 budget.spent——
      // 盘上暂停快照不留「少一轮」的旧值(恢复/续命判断以盘上 spent 为准)。
      const errCalibration = deps.loadTokenCalibration?.(loopSessionId);
      record.budget.spent = computeBudgetSpent(record.budget, {
        turns: turn,
        tokens: estimateLoopTokens(deps.loadMessages(loopSessionId)),
        elapsedMs: deps.now() - startedAtMs,
        pausedMs: record.pausedMsTotal ?? 0,
        ...(errCalibration !== undefined ? { calibration: errCalibration } : {}),
      });
      persist();
      deps.broadcast('auto-run:paused', {
        id: record.id,
        reason: 'provider-error',
        error: result.error,
        // 1.6.0:summary = error 原文(GUI reducer 读 p.summary 展示)。
        summary: result.error,
      });
      const stopNow = await raisePauseDecision(
        `模型调用失败（${result.error.slice(0, 200)}）——供应商过载/挂起/中断。怎么处理？`,
        `错误原文：${result.error.slice(0, 300)}`,
        ctl,
        deps,
      );
      if (stopNow === null) break;
      record.status = stopNow ? 'stopped' : 'running';
      record.pauseReason = undefined;
      record.updatedAt = new Date(deps.now()).toISOString();
      persist();
      if (stopNow) {
        deps.broadcast('auto-run:completed', { id: record.id, outcome: 'stopped' });
        break;
      }
      // 1.6.0：恢复广播——GUI 观察卡靠它从 paused 翻回 running（此前只有
      // persist 无事件，观察卡永久停 paused）。
      deps.broadcast('auto-run:resumed', { id: record.id });
      continue;
    }
    if (ctl.isStopped()) break;

    const messages = deps.loadMessages(loopSessionId);
    // 1.6.0:tokens 预算校准——读 loop session meta 的 tokenCalibration
    // (1.5.3 学习侧写盘),spent = 原始估算 × 系数(缺省 1,钳 [0.8,6])。
    const tokenCalibration = deps.loadTokenCalibration?.(loopSessionId);

    // 1.4.6 修复：预算消耗在声明分支前更新——达成声明的那一轮也计入 spent
    // （此前声明轮直接进 awaiting-verdict、跳过下方预算段,spent 永远少 1;
    //  下方步骤 6 的重算幂等,普通轮次不受影响）。
    record.budget.spent = computeBudgetSpent(record.budget, {
      turns: turn,
      tokens: estimateLoopTokens(messages),
      elapsedMs: deps.now() - startedAtMs,
      pausedMs: record.pausedMsTotal ?? 0, // 1.6.0 修复⑧:time 档扣除暂停等待墙钟
      ...(tokenCalibration !== undefined ? { calibration: tokenCalibration } : {}),
    });

    // ---- 2. 达成信号(declare_completion)→ awaiting-verdict ----
    const declaration = takeCompletionDeclaration(loopSessionId);
    if (declaration) {
      record.declaration = { statement: declaration.statement, evidenceRefs: declaration.evidenceRefs };
      record.verdictPackage = buildVerdictPackage({
        id: record.id,
        criteria: record.criteria,
        declaration: record.declaration,
        resolveEvent: deps.resolveEvent,
      });
      record.status = 'awaiting-verdict';
      record.updatedAt = new Date(deps.now()).toISOString();
      persist();
      deps.broadcast('auto-run:verdict-requested', {
        id: record.id,
        criteria: record.criteria,
        criteriaPrecheck: record.verdictPackage.criteriaPrecheck,
        evidence: {
          statement: record.verdictPackage.statement,
          refs: record.verdictPackage.evidenceRefs,
          hitCount: record.verdictPackage.hitCount,
          missCount: record.verdictPackage.missCount,
        },
      });
      // 等人终审(事件驱动:auto-run/verdict → ctl.resolveVerdict → wake)。
      const alive = await wait(() => ctl.__getVerdict().verdict !== null);
      if (!alive) break;
      const decision = ctl.__getVerdict();
      // 1.6.0 修复①:终审按轮重置——runner 消费后即清零,下一轮 declare_completion
      // 能重新弹窗等人作答(旧形态残留 verdict 会被下一轮 wait 立即命中、旧答案
      // 被自动消费)。幂等闸语义不变:本轮内重复作答仍被 resolveVerdict 拒。
      ctl.__resetVerdict();
      // 1.4.6 修复：终审作答即清 verdictPackage——残留会让恢复路径反复弹
      // 已作答的终审窗(幽灵弹窗,实机实证:作答后第二次点开报「仅 awaiting-
      // verdict 态可终审」)。declaration 陈述保留作历史。
      record.verdictPackage = undefined;
      if (decision.verdict === 'pass') {
        record.status = 'completed';
        record.pauseReason = undefined;
        record.updatedAt = new Date(deps.now()).toISOString();
        persist();
        deps.broadcast('auto-run:completed', { id: record.id, outcome: 'passed' });
        // 自动出报告(复用 report/export 链路;失败降级告警,不撤销 completed)。
        try {
          const rep = await deps.exportReport(record);
          if (rep.ok && rep.reportDir) {
            record.reportDir = rep.reportDir;
            persist();
          } else {
            deps.log(`[auto-run] 自动出报告失败(completed 不受影响):${rep.error ?? 'unknown'}`);
          }
        } catch (err) {
          deps.log(`[auto-run] 自动出报告异常(completed 不受影响):${err instanceof Error ? err.message : String(err)}`);
        }
        // 1.5.13：收官注回交互线——人工在同环境继续时模型上下文带 loop 成果
        // （放在报告导出后，reportDir 进注回文本）。
        injectInteractiveWrapUp(record, lastText, '已通过验收');
        break;
      }
      // fail/continue:注回 loop 线,继续跑(设计 §4「不通过/继续跑」均续跑)。
      const verdictLine = decision.verdict === 'fail'
        ? `【验收终审】不通过。理由:${decision.note ?? '(未填写)'}。请针对未通过的验收条件继续推进,修正后再 declare_completion。`
        : `【验收终审】继续跑。补充说明:${decision.note ?? '(无)'}。继续推进目标。`;
      await deps.appendUserMessage(loopSessionId, verdictLine).catch((err) => {
        deps.log(`[auto-run] 终审注回落盘失败(继续运行):${err instanceof Error ? err.message : String(err)}`);
      });
      verdictNote = decision.verdict === 'fail' ? `终审不通过:${decision.note ?? ''}` : `终审:继续跑${decision.note ? `(${decision.note})` : ''}`;
      record.status = 'running';
      record.pauseReason = undefined;
      stallStreak = 0;
      record.updatedAt = new Date(deps.now()).toISOString();
      persist();
      // 1.6.0：恢复广播（verdict 续跑）。
      deps.broadcast('auto-run:resumed', { id: record.id });
      continue;
    }

    // ---- 3. 模型提请的决策(request_decision)→ 等待人作答再继续 ----
    const pendingIds = pendingDecisions()
      .filter((d) => d.sessionId === loopSessionId)
      .map((d) => d.decisionId);
    if (pendingIds.length > 0) {
      record.status = 'paused';
      record.pauseReason = 'decision';
      record.updatedAt = new Date(deps.now()).toISOString();
      persist();
      deps.broadcast('auto-run:paused', {
        id: record.id,
        reason: 'decision',
        decisionIds: pendingIds,
      });
      const resumed = await waitForDecisionInjection(pendingIds, ctl, deps);
      if (!resumed) break;
      record.status = 'running';
      record.pauseReason = undefined;
      record.updatedAt = new Date(deps.now()).toISOString();
      persist();
      // 1.6.0：恢复广播（模型提请决策作答后续跑）。
      deps.broadcast('auto-run:resumed', { id: record.id });
      continue;
    }

    // ---- 4. 空转检测(有效研究记录增量 + 阶段推进,双信号;设计 §5) ----
    const events = deps.listEvents();
    const validCount = countValidEventsSince(events, startedAtMs);
    const phase = currentResearchPhase(messages);
    const phaseBefore = prevPhase;
    const phaseChanged = phaseBefore !== undefined && phase !== phaseBefore;
    const stallEval = evaluateStall({
      newValidEvents: validCount - prevValidCount,
      previousPhase: phaseBefore,
      phase,
      stallStreak,
    }, deps.stallTurns);
    stallStreak = stallEval.stallStreak;
    prevPhase = phase;
    prevValidCount = validCount;
    if (stallEval.stalled) {
      record.status = 'paused';
      record.pauseReason = 'stall';
      record.updatedAt = new Date(deps.now()).toISOString();
      persist();
      const summary = summarizeRecentToolCalls(messages).slice(0, 8);
      deps.broadcast('auto-run:paused', {
        id: record.id,
        reason: 'stall',
        consecutiveTurns: stallStreak,
        recentTools: summary,
        // 1.6.0:summary = 最近动作摘要(GUI reducer 读 p.summary 展示)。
        summary: summary.length > 0 ? summary.join(' / ') : '(无工具调用)',
      });
      const stopNow = await raisePauseDecision(
        `auto loop 连续 ${stallStreak} 轮无新增有效研究记录且阶段未推进(疑似空转),怎么处理?`,
        `最近动作:${summary.length > 0 ? summary.join(' / ') : '(无工具调用)'}`,
        ctl,
        deps,
      );
      if (stopNow === null) break; // Esc
      stallStreak = 0;
      record.status = stopNow ? 'stopped' : 'running';
      record.pauseReason = undefined;
      if (stopNow) {
        record.updatedAt = new Date(deps.now()).toISOString();
        persist();
        deps.broadcast('auto-run:completed', { id: record.id, outcome: 'stopped' });
        break;
      }
      record.updatedAt = new Date(deps.now()).toISOString();
      persist();
      // 1.6.0：恢复广播（暂停点决策「继续跑」）。
      deps.broadcast('auto-run:resumed', { id: record.id });
      continue;
    }

    // ---- 5. 反复失败(同类工具 isError 连击 ≥3) ----
    const failure = detectRepeatedFailures(messages, deps.repeatedFailureStreak);
    if (failure) {
      record.status = 'paused';
      record.pauseReason = 'repeated-failures';
      record.updatedAt = new Date(deps.now()).toISOString();
      persist();
      deps.broadcast('auto-run:paused', {
        id: record.id,
        reason: 'repeated-failures',
        toolName: failure.toolName,
        streak: failure.streak,
        // 1.6.0:summary = 工具名 + 连击数(GUI reducer 读 p.summary 展示)。
        summary: `${failure.toolName} ×${failure.streak}`,
      });
      const stopNow = await raisePauseDecision(
        `工具 ${failure.toolName} 连续失败 ${failure.streak} 次(模型说「有把握」,证据说「反复失败」),怎么处理?`,
        `最近失败工具:${failure.toolName}(连续 ${failure.streak} 次 isError)`,
        ctl,
        deps,
      );
      if (stopNow === null) break;
      record.status = stopNow ? 'stopped' : 'running';
      record.pauseReason = undefined;
      if (stopNow) {
        record.updatedAt = new Date(deps.now()).toISOString();
        persist();
        deps.broadcast('auto-run:completed', { id: record.id, outcome: 'stopped' });
        break;
      }
      record.updatedAt = new Date(deps.now()).toISOString();
      persist();
      // 1.6.0：恢复广播（暂停点决策「继续跑」）。
      deps.broadcast('auto-run:resumed', { id: record.id });
      continue;
    }

    // ---- 6. 预算:估算 → 耗尽(暂停+checkpoint)/ 余量警告 ----
    const spent = computeBudgetSpent(record.budget, {
      turns: turn,
      tokens: estimateLoopTokens(messages),
      elapsedMs: deps.now() - startedAtMs,
      pausedMs: record.pausedMsTotal ?? 0, // 1.6.0 修复⑧:time 档扣除暂停等待墙钟
      ...(tokenCalibration !== undefined ? { calibration: tokenCalibration } : {}),
    });
    record.budget.spent = spent;
    if (isBudgetExhausted(record.budget, spent)) {
      // checkpoint:开局快照同款(best-effort,失败告警)。
      try {
        const snap = await deps.snapshot(record.envKey, record);
        if (!snap.ok) deps.log(`[auto-run] checkpoint 快照失败:${snap.error ?? 'unknown'}`);
      } catch (err) {
        deps.log(`[auto-run] checkpoint 快照异常:${err instanceof Error ? err.message : String(err)}`);
      }
      if (ctl.isStopped()) break;
      record.status = 'paused';
      record.pauseReason = 'budget';
      record.updatedAt = new Date(deps.now()).toISOString();
      persist();
      deps.broadcast('auto-run:paused', {
        id: record.id,
        reason: 'budget',
        budget: record.budget,
      });
      // 续命走 auto-run/budget 端点(数值输入,决策面板装不下)——事件驱动 wake;
      // renewBudget 直接改写 record.budget.limit,以 limit 变化为续命完成信号。
      const oldLimit = record.budget.limit;
      const alive = await wait(() => record.budget.limit !== oldLimit);
      if (!alive) break;
      record.status = 'running';
      record.pauseReason = undefined;
      // A3-1(1.5.4):续命恢复 running 也要落盘(对齐其余四个恢复分支)——
      // 否则崩溃窗口内盘上仍是 paused,恢复路径误判。
      record.updatedAt = new Date(deps.now()).toISOString();
      persist();
      // 1.6.0：恢复广播（预算续命续跑）。
      deps.broadcast('auto-run:resumed', { id: record.id });
      deps.log(`[auto-run] ${record.id} 预算续命到 ${record.budget.limit}(${record.budget.kind})`);
      budgetWarned = false;
      continue;
    }
    if (!budgetWarned && isBudgetWarning(record.budget, spent)) {
      budgetWarned = true;
      deps.broadcast('auto-run:budget-warning', {
        id: record.id,
        budget: record.budget,
      });
    }

    // ---- 7. 阶段推进:拍肩膀(阶段边界不暂停,设计 §5) ----
    if (phaseChanged) {
      deps.broadcast('auto-run:phase-changed', { id: record.id, phase, previousPhase: phaseBefore });
    }

    // ---- 8. 轮次收尾 ----
    record.updatedAt = new Date(deps.now()).toISOString();
    persist();
    deps.broadcast('auto-run:turn-completed', {
      id: record.id,
      turn,
      phase,
      budget: record.budget,
      status: record.status,
    });
  }

  // Esc/异常路径的统一收尾(status 未定终态才写 stopped)。
  if (ctl.isStopped() && record.status !== 'stopped' && record.status !== 'completed') {
    record.status = 'stopped';
    record.pauseReason = undefined;
    record.updatedAt = new Date(deps.now()).toISOString();
    persist();
    deps.broadcast('auto-run:completed', { id: record.id, outcome: 'stopped' });
    // 1.5.13：终止也注回交互线（中途成果+终止事实进交互上下文）。
    injectInteractiveWrapUp(record, lastText, `已终止（跑了 ${turn} 轮）`);
  }
  // 1.6.0 修复⑦:run 终态清理本 loop 线遗留的 pending 决策与达成声明——
  // 防残留被恢复路径/下同一条线的 run 误消费(按 loopSessionId 过滤,
  // 不动其他线的待答项)。
  clearDecisions(loopSessionId);
  clearCompletionDeclarations(loopSessionId);
  ctl.requestStop(); // 幂等;确保 isStopped 归位(waitUntilDone 依赖)
  ctl.__finish();
}

/**
 * 等待决策注入完成:全部 decisionId 已 resolved 且 loop 线出现对应 marker
 * (注入 turn 的原子 append 落地 = 注入完成;防 runner 与注入 turn 并发读线)。
 * 1.6.0 修复② 超时语义——区分「人未答」与「已答但注入 turn 卡死」:
 *   - 人未答:不设超时,无限等(对齐预算续命 wait() 的人控节奏)——消除
 *     「未答超时静默续跑」;
 *   - 已答但 marker 未落地:从全部 resolved 起计 decisionWaitTimeoutMs 兜底,
 *     超时放行,由调用方(raisePauseDecision)从 resolved pending 记录读
 *     choice——消除「已答被丢弃 + 10 分钟暂停循环」。
 */
async function waitForDecisionInjection(
  decisionIds: string[],
  ctl: AutoRunController,
  deps: AutoRunDeps,
): Promise<boolean> {
  let allResolvedAtMs: number | null = null;
  const alive = await waitWhile(async () => {
    const allResolved = decisionIds.every((id) =>
      pendingDecisions().every((d) => d.decisionId !== id));
    // 人未答:无限等(不启动超时计时)。
    if (!allResolved) return false;
    if (allResolvedAtMs === null) allResolvedAtMs = deps.now();
    const messages = deps.loadMessages(ctl.record.loopSessionId);
    const markersLanded = decisionIds.every((id) => findDecisionMarker(messages, id) !== null);
    if (markersLanded) return true;
    if (deps.now() - allResolvedAtMs > deps.decisionWaitTimeoutMs) {
      deps.log(`[auto-run] 决策已作答但注入 turn 卡死(${deps.decisionWaitTimeoutMs}ms 未见 marker),按已答 choice 恢复推进`);
      return true;
    }
    return false;
  }, ctl, deps);
  return alive;
}

// waitWhile 只在决策暂停等待(waitForDecisionInjection)使用——1.6.0 修复⑧:
// 暂停段墙钟累加进 record.pausedMsTotal,不计入 time 预算消耗。
async function waitWhile(
  pred: () => boolean | Promise<boolean>,
  ctl: AutoRunController,
  deps: AutoRunDeps,
): Promise<boolean> {
  const pauseStartMs = deps.now();
  try {
    while (!(await pred()) && !ctl.isStopped()) {
      const handle = ctl.waitForWake();
      await Promise.race([handle, sleep(deps.pollMs)]);
      handle.cancel(); // 1.6.0 修复⑤:sleep 胜出时摘除 waiter(幂等)
    }
    return !ctl.isStopped();
  } finally {
    const rec = ctl.record;
    rec.pausedMsTotal = (rec.pausedMsTotal ?? 0) + Math.max(0, deps.now() - pauseStartMs);
  }
}

/**
 * harness 主动提请(设计 §5「提请」= 1.3.2 request_decision 原样复用)。
 * 返回:true=人选择终止;false=继续跑;null=Esc/停止。
 */
async function raisePauseDecision(
  question: string,
  context: string,
  ctl: AutoRunController,
  deps: AutoRunDeps,
): Promise<boolean | null> {
  const rec = requestDecision(
    {
      sessionId: ctl.record.loopSessionId,
      question,
      options: ['继续跑', '终止运行'],
      context,
    },
    deps.broadcast,
  );
  const alive = await waitForDecisionInjection([rec.decisionId], ctl, deps);
  if (!alive) return null;
  const messages = deps.loadMessages(ctl.record.loopSessionId);
  const marker = findDecisionMarker(messages, rec.decisionId);
  if (marker && marker.choice) return STOP_CHOICE_RE.test(marker.choice);
  // 1.6.0 修复②:marker 缺失 = 注入 turn 卡死兜底路径——人已作答,从 resolved
  // pending 记录读 choice(getDecision 含 resolved 条目),不依赖 marker;
  // 记录也读不到(理论上不应发生)按「继续跑」处理,不卡死循环。
  const resolved = getDecision(rec.decisionId);
  return resolved?.resolved && resolved.choice ? STOP_CHOICE_RE.test(resolved.choice) : false;
}

// ---------------------------------------------------------------------------
// docker 留现场(1.6.3 #7:task.md;设计 §4「现场在环境快照 + task.md」)
// ---------------------------------------------------------------------------

/**
 * docker 环境没有 vmrun 快照机制——auto-run 的「开局/checkpoint 留现场」
 * 对 docker 落成容器内 /workspace/task.md:任务目标 + 验收条件 + 当前状态
 * + 关键上下文。恢复侧走既有 taskmd 通道读回(refs.ts 探测序列含
 * ./task.md,容器 WORKDIR 即 /workspace),不发明新机制。
 * 格式:设计文档无约定,人可读 markdown 分节(目标/验收条件/当前状态/
 * 关键上下文),对齐档案投影的分节风格。
 */
export function buildDockerTaskMd(record: AutoRunRecord): string {
  const budget = record.budget;
  const lines = [
    '# task.md — auto loop 留现场(zhishi auto-run)',
    '',
    '> 本文件由 zhishi auto-run 在开局/checkpoint 自动写入——docker 环境无快照机制,',
    '> 现场 = 容器文件系统(容器持久,stop/start 续上)+ 本文件',
    '> (设计 docs/design/auto-loop-design.md §4「现场在环境快照 + task.md」)。',
    '> 恢复:重新发起 auto run,或普通会话用 @taskmd 引用本文件继续。',
    '',
    `- 任务:${record.name}(run id: ${record.id})`,
    `- 环境:${record.envKey}`,
    `- 更新时间:${record.updatedAt}`,
    '',
    '## 目标',
    '',
    record.goal,
    '',
    '## 验收条件(研究员定义、启动即锁定)',
    '',
    ...record.criteria.map((c, i) => `${i + 1}. ${c}`),
    '',
    '## 当前状态',
    '',
    `- 运行状态:${record.status}${record.pauseReason ? `(暂停原因:${record.pauseReason})` : ''}`,
    `- 已完成轮次:${record.turns ?? 0}`,
    `- 预算:${budget.kind} 已耗 ${budget.spent ?? 0} / 上限 ${budget.limit}`,
    '',
    '## 关键上下文',
    '',
    `- loop 轨迹线:${record.loopSessionId}(宿主侧 loop-sessions;recall 工具/历史回看可查)`,
    ...(record.workspace ? [`- 宿主工作区:${record.workspace}`] : []),
    ...(record.reportDir ? [`- 报告:${record.reportDir}`] : []),
  ];
  return `${lines.join('\n')}\n`;
}

/** 容器内写 task.md 的命令:base64 传输(引号/换行/UTF-8 全免疫)经 bash -lc 落盘。 */
export function buildDockerTaskMdWriteCommand(content: string): string {
  const b64 = Buffer.from(content, 'utf-8').toString('base64');
  return `printf '%s' '${b64}' | base64 -d > /workspace/task.md`;
}

export interface DockerTaskMdCheckpointOptions {
  /** 测试注入:env 通道(生产 defaultEnvExec 经 execInEnvironment)。 */
  exec?: EnvExec;
  /** 测试注入:宿主侧降级写(默认 writeFileSync)。 */
  hostWrite?: (path: string, content: string) => void;
  /** 测试注入:告警通道(默认 console.warn)。 */
  log?: (msg: string) => void;
}

/**
 * docker checkpoint:往容器内 /workspace 写 task.md。容器可能已停止
 * (checkpoint 发生在长跑后,容器随时可能被 down)——写不进去走降级:
 * docker 的 /workspace 是宿主 bind mount(entry.workspace 是 1.5.10 登记
 * 的宿主源目录),直接写宿主侧同一文件,效果与容器内写一致;只告警不丢
 * 状态。两条路都不通才 ok:false(run 状态本就不受影响——记录已落盘,
 * 调用方对 snapshot 失败也只告警)。
 */
export async function writeDockerTaskMdCheckpoint(
  entry: EnvironmentEntry,
  record: AutoRunRecord,
  options: DockerTaskMdCheckpointOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  const log = options.log ?? ((msg: string) => console.warn(msg));
  const hostWrite = options.hostWrite ?? ((p: string, c: string) => writeFileSync(p, c, 'utf-8'));
  const content = buildDockerTaskMd(record);
  let reason: string;
  try {
    const r = await execInEnvironment(entry, buildDockerTaskMdWriteCommand(content), {
      ...(options.exec ? { exec: options.exec } : {}),
    });
    if (r.ok && r.exitCode === 0) return { ok: true };
    reason = r.ok ? `容器内写入退出码 ${r.exitCode}:${r.stderr.trim().slice(0, 200)}` : r.error;
  } catch (err) {
    reason = `环境执行异常:${err instanceof Error ? err.message : String(err)}`;
  }
  if (entry.workspace) {
    const hostPath = join(entry.workspace, 'task.md');
    try {
      hostWrite(hostPath, content);
      log(`[auto-run] docker checkpoint 容器内写 task.md 失败(${reason})——已降级写宿主侧 ${hostPath}(bind mount 同一文件)`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `容器内写 task.md 失败(${reason});宿主侧降级写 ${hostPath} 也失败:${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { ok: false, error: `容器内写 task.md 失败(${reason}),且条目无 workspace 登记(宿主源目录未知)无法降级——run 状态不受影响(记录已落盘)` };
}

// ---------------------------------------------------------------------------
// 生产接线(admin-api 薄调用;单测不触)
// ---------------------------------------------------------------------------

/** 生产依赖组装(workspace = 引擎锚定工作区;测试注入 Partial 覆盖)。 */
export function buildProductionAutoRunDeps(workspace: string, overrides: Partial<AutoRunDeps> = {}): AutoRunDeps {
  const now = () => Date.now();
  const deps: AutoRunDeps = {
    workspace,
    invoke: async (input, options) => invokePiSession(input, options),
    loadMessages: (id) => loadLoopSession(id).messages,
    // 1.6.0:tokens 预算校准系数 = loop session meta 的 tokenCalibration。
    loadTokenCalibration: (id) => loadLoopSession(id).meta?.tokenCalibration,
    // 1.6.3 修复(#6):workspace 过滤前置进 store(limit 在过滤后生效)——
    // 全局事件超 limit 后 stall 判定不再基于截断错样本。
    listEvents: () =>
      listResearchEvents({ limit: 1000, workspace }),
    resolveEvent: (id) => getResearchEventById(id),
    appendUserMessage: async (id, text) => {
      await appendLoopMessages(id, [
        { role: 'user', content: text, timestamp: Date.now() } as AgentMessage,
      ]);
    },
    snapshot: async (envKey, record) => {
      const config = loadConfig();
      const entry = findEnvironmentEntry(listEnvironments(config), envKey);
      if (!entry) return { ok: false, error: `环境 "${envKey}" 未登记` };
      if (entry.kind === 'docker') {
        // 1.6.3 #7:docker 无快照机制——留现场 = 容器内 /workspace/task.md
        // (容器持久,stop/start 续现场,1.5.10 三层模型;设计 §4)。
        return writeDockerTaskMdCheckpoint(entry, record);
      }
      const resolved = entry.kind === 'vm'
        ? resolveVmxForEntry(entry, { templates: config.vmTemplates })
        : undefined;
      if (!resolved || !resolved.ok) {
        return { ok: false, error: resolved?.error ?? `环境 "${envKey}" 解析不到 .vmx,快照仅支持可解析 vmx 的 vm 环境` };
      }
      const r = await snapshotVm(resolved.vmx, `auto-run-${now()}`);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    exportReport: (record) => exportRunReport(record, workspace),
    broadcast: (event, data) => broadcast(event, data),
    save: (record) => { void saveAutoRunRecord(record); },
    now,
    log: (msg) => console.log(msg),
    ...DEFAULT_DEP_KEYS,
  };
  return { ...deps, ...overrides };
}

/** verdict=pass 的自动出报告(复用 report/export 链路的真实接线,口径对齐
 *  handleReportExport;loop 线用 run 自己的 loopSessionId 而非 env-sessions)。 */
async function exportRunReport(
  record: AutoRunRecord,
  workspace: string,
): Promise<{ ok: boolean; reportDir?: string; error?: string }> {
  const entry = findEnvironmentEntry(listEnvironments(loadConfig()), record.envKey) ?? null;
  // 1.6.0:record.envKey 是裸环境 id(validate 经 findEnvironmentEntry 按
  // e.id 校验),不是 env:<id> 形式的 selection 键——删掉此前的死前缀剥离。
  const envId = entry?.id ?? record.envKey;
  const resolution = resolveLoopModel();
  const modelId = resolution ? `${resolution.providerId ?? 'custom'}/${resolution.modelId}` : null;
  const result = await exportReport(
    { workspace, sanitize: false, env: { envId, entry } },
    {
      listWorkspaceEvents: (ws) =>
        listResearchEvents({ limit: 1000, workspace: ws }),
      findLoopSessionId: () => record.loopSessionId,
      loadTranscript: (loopSessionId) => buildLoopTranscript(loopSessionId),
      // 1.4.4 研究档案交付投影：auto-run 线同样从档案派生成果章节。
      loadArchive: (loopSessionId) => loadArchive(loopSessionId),
      requestApproval: (objects) => requestBoundaryAsk({
        kind: 'host-write',
        objects,
        toolName: 'auto-run/verdict',
        toolDescription: '终审通过后自动出报告(把证据与报告落回宿主)',
        options: ['批准写入', '拒绝'],
      }),
      narrate: async (prompt, systemPrompt) => {
        if (!resolution) return { error: '模型不可用(无 provider/key)' };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 180_000);
        try {
          const { text, error } = await runLoopText({
            prompt,
            systemPrompt,
            model: resolution.model,
            models: resolution.models,
            getApiKey: resolution.getApiKey,
            tools: [],
            signal: controller.signal,
          });
          if (error !== undefined) return { error };
          return { text };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        } finally {
          clearTimeout(timer);
        }
      },
      modelId,
      writeOutputs: (reportDir, files) => {
        mkdirSync(reportDir, { recursive: true });
        for (const [name, content] of Object.entries(files)) {
          writeFileSync(join(reportDir, name), content, 'utf-8');
        }
      },
      lookupExpertEntry: (id) => {
        const baseDir = getZhiShiDataDir();
        if (!hasExpertDb(baseDir)) return null;
        const expert = getEntryById(openExpertStore(baseDir), id);
        return expert ? { title: expert.title, kind: expert.kind } : null;
      },
    },
  );
  return result.success
    ? { ok: true, reportDir: result.data.reportDir }
    : { ok: false, error: result.error };
}

// ---------------------------------------------------------------------------
// 注册表(进程内一张表:活动 run;盘上记录 = 可追溯真相)
// ---------------------------------------------------------------------------

interface ActiveRun {
  ctl: AutoRunController;
  record: AutoRunRecord;
}

const activeRuns = new Map<string, ActiveRun>();
const healedWorkspaces = new Set<string>();

async function ensureOrphanRecovery(workspace: string): Promise<void> {
  if (healedWorkspaces.has(workspace)) return;
  healedWorkspaces.add(workspace);
  try {
    const n = await recoverOrphanedAutoRuns({
      workspace,
      skipIds: new Set(activeRuns.keys()),
    });
    // 1.6.0 修复③:口径对齐——awaiting-verdict 不再愈合(保留孤儿终审通道)。
    if (n > 0) console.log(`[auto-run] 重启愈合:${n} 条本工作区 running/paused 记录标记 stopped(sidecar-restart;awaiting-verdict 保留孤儿终审通道)`);
  } catch (err) {
    console.warn('[auto-run] 重启愈合失败(非致命):', err);
  }
}

/** 引擎锚定工作区(生产依赖的缺省 workspace 数据源)。 */
function engineWorkspace(): string {  return getPiAgentState().agentDir || process.cwd();
}

/**
 * 1.5.13：收官注回交互线（人工继续的上下文共享）——run 终态时把
 * 目标/结果/报告/轨迹线写进同工作区当前环境的交互会话线
 * （appendLoopMessages 落盘——下一个交互轮次的模型上下文即带 loop 成果）。
 * 无绑定 / 绑定线即本 run 线 / 当前选定环境不是 run 的环境 → 静默跳过
 * （不串线）。失败只告警，不影响终态。
 *
 * 1.6.0 修复：envKey 口径统一——record.envKey 是裸环境 id（validate 经
 * findEnvironmentEntry 按 e.id 校验），binding.envKey 是 selection 键
 * （env:<id>，env-sessions.ts envKeyForSelection 口径）；此前裸比恒不等，
 * 注回永远静默跳过。getBinding/appendMessages 可注入（测试钉死口径）。
 */
export interface WrapUpInjectDeps {
  getBinding?: (workspace: string) => { envKey: string; loopSessionId: string } | null;
  appendMessages?: (loopSessionId: string, messages: AgentMessage[]) => Promise<unknown>;
}

export function injectInteractiveWrapUp(
  record: AutoRunRecord,
  lastText: string,
  outcome: string,
  depsOverride: WrapUpInjectDeps = {},
): void {
  const getBinding = depsOverride.getBinding ?? getEnvSessionBinding;
  const appendMessages = depsOverride.appendMessages
    ?? ((id: string, msgs: AgentMessage[]) => appendLoopMessages(id, msgs));
  try {
    const ws = record.workspace ?? engineWorkspace();
    const binding = getBinding(ws);
    if (!binding || binding.loopSessionId === record.loopSessionId) return;
    // 1.6.0:裸 id → selection 键再比(env:<id> 口径,见函数头注释)。
    if (binding.envKey !== envKeyForSelection({ kind: 'env', id: record.envKey })) return;
    const summary = lastText.trim().slice(0, 600) || '（无）';
    const text = [
      `【auto loop 收官】「${record.name}」${outcome}。`,
      `目标：${record.goal}`,
      `结论摘要：${summary}`,
      `验收条件：${record.criteria.length} 条（启动即锁定，全程未改）。`,
      record.reportDir ? `报告：${record.reportDir}` : '报告：未生成',
      `loop 轨迹线：${record.loopSessionId}（细节用 recall 工具或历史回看查）。`,
    ].join('\n');
    void appendMessages(binding.loopSessionId, [
      { role: 'user', content: text, timestamp: Date.now() } as AgentMessage,
    ]).catch((err) => console.warn('[auto-run] 收官注回交互线失败（不影响终态）:', err));
  } catch (err) {
    console.warn('[auto-run] 收官注回交互线异常（不影响终态）:', err);
  }
}

export type AutoRunApiResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string };

/** 启动(校验 → 落盘 → 异步跑)。同一 workspace 同时只允许一个非终态 run。 */
export async function startAutoRun(
  input: AutoRunStartInput,
  workspace: string,
  depsOverride?: Partial<AutoRunDeps>,
): Promise<AutoRunApiResult<{ id: string; record: AutoRunRecord }>> {
  await ensureOrphanRecovery(workspace);
  const validated = validateAutoRunStart(input, {
    findEnv: (envKey) => findEnvironmentEntry(listEnvironments(loadConfig()), envKey),
    loopSessionId: newLoopSessionId(),
  });
  if (!validated.ok) return { success: false, error: validated.error };
  const record: AutoRunRecord = { ...validated.record, workspace };

  // 单实例闸:同 workspace 已有非终态 run → 拒绝(先 Esc 再启动新 run)。
  // 1.6.0 修复⑩:workspace 比较走 workspacePathsEqual(与同文件 listAutoRuns
  // 口径一致)——原始 === 会把尾斜杠/分隔符差异当不同工作区,闸被绕过。
  const conflict = [...activeRuns.values()].find((a) =>
    a.record.workspace !== undefined && workspacePathsEqual(a.record.workspace, workspace) &&
    (a.record.status === 'running' || a.record.status === 'paused' || a.record.status === 'awaiting-verdict'));
  if (conflict) {
    return { success: false, error: `已有运行中的 auto run "${conflict.record.name}"(id=${conflict.record.id}),先 Esc 终止再启动新 run` };
  }

  const deps = buildProductionAutoRunDeps(workspace, depsOverride);
  const ctl = createAutoRunController(record);
  activeRuns.set(record.id, { ctl, record });
  deps.save(record);
  // fire-and-forget:runner 自持异常兜底(异常 → 落 stopped,不抛 unhandled)。
  void runAutoRunLoop(record, ctl, deps).catch((err) => {
    console.error('[auto-run] 循环异常(落 stopped):', err);
    record.status = 'stopped';
    record.pauseReason = 'runner-error';
    record.updatedAt = new Date().toISOString();
    deps.save(record);
    deps.broadcast('auto-run:completed', { id: record.id, outcome: 'stopped' });
  }).finally(() => {
    // 1.6.0 修复⑥:runner 终态(正常收官/停止/异常兜底)即从活动注册表摘除——
    // 防终态记录永挂内存(stop/renew/verdict 之后走盘上记录语义,与重启后一致)。
    activeRuns.delete(record.id);
  });
  return { success: true, data: { id: record.id, record } };
}

export function stopAutoRun(id: string): AutoRunApiResult<{ id: string }> {
  const active = activeRuns.get(id);
  if (!active) return { success: false, error: `auto run "${id}" 不存在(或已随 sidecar 重启终止)` };
  if (active.record.status === 'completed' || active.record.status === 'stopped') {
    return { success: false, error: `auto run "${id}" 已终态(${active.record.status})` };
  }
  active.ctl.requestStop();
  return { success: true, data: { id } };
}

export function renewAutoRunBudget(id: string, limit: unknown): AutoRunApiResult<{ id: string }> {
  const active = activeRuns.get(id);
  if (!active) return { success: false, error: `auto run "${id}" 不存在(或已随 sidecar 重启终止)` };
  const r = active.ctl.renewBudget(typeof limit === 'number' ? limit : Number(limit));
  if (!r.ok) return { success: false, error: r.error ?? '续命失败' };
  return { success: true, data: { id } };
}

/**
 * 孤儿记录的终审兜底（1.4.6 走查实证）：sidecar 重启后内存 runner 消亡,
 * 盘上 awaiting-verdict 记录变成「弹得出但永远答不了」的终审——按盘上
 * 记录直接结算:pass → completed / fail → stopped(均清 verdictPackage,
 * declaration 陈述留史;自动出报告跳过,提示手动 /export);continue → 明确
 * 报错(孤儿不可续跑)。
 */
async function resolveOrphanedVerdict(
  id: string,
  verdict: unknown,
  note?: string,
  options: AutoRunStoreOptions = {},
): Promise<AutoRunApiResult<{ id: string }>> {
  const record = loadAutoRunRecord(id, options);
  if (!record) return { success: false, error: `auto run "${id}" 不存在` };
  if (record.status !== 'awaiting-verdict') {
    return { success: false, error: `run "${id}" 已处于 ${record.status} 态,无需终审` };
  }
  if (verdict === 'continue') {
    return { success: false, error: 'run 已随 sidecar 重启终止,无法续跑——请重新发起;已有成果可手动 /export 导出报告' };
  }
  if (verdict !== 'pass' && verdict !== 'fail') {
    return { success: false, error: `verdict 必须是 pass / fail / continue(收到 "${String(verdict)}")` };
  }
  record.status = verdict === 'pass' ? 'completed' : 'stopped';
  record.verdictPackage = undefined;
  record.updatedAt = new Date().toISOString();
  await saveAutoRunRecord(record, options);
  return { success: true, data: { id } };
}

export async function resolveAutoRunVerdict(
  id: string,
  verdict: unknown,
  note?: string,
  options: AutoRunStoreOptions = {},
): Promise<AutoRunApiResult<{ id: string }>> {
  const active = activeRuns.get(id);
  if (!active) return resolveOrphanedVerdict(id, verdict, note, options);
  const r = active.ctl.resolveVerdict(
    verdict === 'pass' || verdict === 'fail' || verdict === 'continue' ? verdict : String(verdict) as VerdictChoice,
    note,
  );
  if (!r.ok) return { success: false, error: r.error ?? '终审失败' };
  return { success: true, data: { id } };
}

/** 记录列表(时间倒序;含盘上历史,可按 workspace 过滤)。 */
export async function listAutoRuns(workspace?: string): Promise<AutoRunRecord[]> {
  await ensureOrphanRecovery(workspace ?? engineWorkspace());
  const disk = listAutoRunRecordFiles();
  // 盘上记录与内存活动记录合并(内存可能有尚未落盘的最新字段)。
  const merged = new Map<string, AutoRunRecord>();
  for (const r of disk) merged.set(r.id, r);
  for (const { record } of activeRuns.values()) merged.set(record.id, record);
  const out = [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!workspace) return out;
  return out.filter((r) => !r.workspace || workspacePathsEqual(r.workspace, workspace));
}

/** 测试复位(照 bg-registry 的 reset 惯例)。 */
export function resetAutoRunRegistryForTest(): void {
  activeRuns.clear();
  healedWorkspaces.clear();
}
