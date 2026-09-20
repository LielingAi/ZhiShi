/**
 * 1.7.7 — auto loop runner(design:docs/design/auto-redesign.md;取代
 * auto-loop-design.md 与 1.7.0-policy-design.md)。
 *
 * auto run = 三输入(目标 / 验收条件 1-N 条,OR 语义 / 强制超时三选一)+
 * 可选空转推进话术的最小循环:每轮 invokePiSession(同一 loop 线,续存回
 * 同线)→ 轮数/预算记账 → 达成预检 → 下一轮,轮间不停不等。
 *
 * 模型没有自我退出权:「不可行/卡死」只是轨迹内容。停点只有四个:
 *   - 条件命中(declare_completion 附证据引用 → harness 证据预检通过)→ completed;
 *   - 强制超时(预算耗尽)→ stopped(reason=budget);
 *   - 研究员 Esc / zhishi auto-run stop → stopped;
 *   - provider 连续 N=5 次失败 → exited(reason=provider-error)。
 * 无策略文件、无暂停点、无 checkpoint、无自动报告——产出 = 轨迹 + 研究
 * 事件 + 档案(设计 §4b)。
 *
 * 分层(纯函数可单测):
 *   - 纯函数:启动校验 / 驱动文本 / 预算 / 空转检测(双信号,K=3)/ 记录编解码;
 *   - 存储:auto-runs/<id>.json,withFileLock + tmp+rename(对齐 bg-registry/
 *     loop-sessions 纪律;写失败仅告警,绝不拖死循环);
 *   - runner:runAutoRunLoop 注入全部依赖(invoke/研究事件查询/广播/落盘),
 *     不真连环境即可单测;
 *   - 生产接线:startAutoRun/stopAutoRun/listAutoRuns(admin-api 薄调用)。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { getZhiShiDataDir } from '../utils/app-dirs';
import { withFileLock, writeFileAtomic } from '../utils/file-lock';
import { isResearchOutcome } from '../../shared/research-kinds';
import type { ResearchEvent } from '../memory/store';
import { estimateMessageTokens, segmentContext, type ResearchPhase } from './context-manager';
import { takeCompletionDeclaration, clearCompletionDeclarations, precheckCompletionDeclaration } from './declare-completion';
import type { PiSendInput } from './chat-engine';
import type { InteractionScenario } from '../system-prompt';

// 生产接线依赖(函数体只在 startAutoRun 等入口使用,纯函数单测不触)。
import { broadcast } from '../sse';
import { invokePiSession, getPiAgentState, getEnvSessionBinding } from './chat-engine';
import { appendLoopMessages, loadLoopSession, newLoopSessionId } from './session';
import { loadArchive } from './archive';
import { getResearchEventById, listResearchEvents } from '../memory/store';
import { findEnvironmentEntry, listEnvironmentsWithBuiltin } from '../environment/registry';
import { envKeyForSelection } from '../environment/env-sessions';
import { loadConfig } from '../utils/admin-config';
import { workspacePathsEqual } from '../../shared/workspacePath';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 终态四枚举(设计 §1):completed 达成 / stopped 超时或 Esc / exited provider 死亡;running 活跃。 */
export type AutoRunStatus = 'running' | 'completed' | 'stopped' | 'exited';

/** 终态原因(沿用 pauseReason 字段,值收窄;Esc 无原因)。 */
export type AutoRunTerminalReason = 'budget' | 'provider-error' | 'sidecar-restart' | 'runner-error';

/** 预算三选一:turns 轮次 / tokens 估算 token / time 分钟。limit 恒为上限,spent 恒为已耗。 */
export type AutoRunBudget =
  | { kind: 'turns'; limit: number; spent?: number }
  | { kind: 'tokens'; limit: number; spent?: number }
  | { kind: 'time'; limit: number; spent?: number };

/** 达成声明(declare_completion 消费后留史的形状)。 */
export interface AutoRunDeclaration {
  statement: string;
  criteria: string[];
  evidenceRefs: Array<number | string>;
}

/**
 * auto-run 记录(落盘 <数据目录>/auto-runs/<id>.json,可追溯)。1.7.7 契约
 * 核心形状 + additive 服务端簿记字段;policy/verdictPackage 等旧字段不再写,
 * 读盘容错忽略。
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
  /** 空转推进话术(缺省 = 内置通用话术;STALL_PROMPT_OFF = 关闭,纯继续)。 */
  stallPrompt?: string;
  createdAt: string;
  updatedAt: string;
  // ---- additive(服务端簿记,不进启动契约):workspace 归属/轮次/声明 ----
  workspace?: string;
  turns?: number;
  declaration?: AutoRunDeclaration;
}

// ---------------------------------------------------------------------------
// 常量(设计 §8 参数定案)
// ---------------------------------------------------------------------------

/** 空转 nudge 触发阈值 K=3(连续 K 轮无新增有效研究记录且阶段未推进)。 */
export const STALL_TURNS_DEFAULT = 3;
/** provider 连击退出阈值 N=5(连续 N 次 invoke 返回 provider 类错误)。 */
export const PROVIDER_STREAK_EXIT_DEFAULT = 5;
// 1.7.7(设计 §3.3):纯 liveness 守卫——只防真挂死,不是停 run 的条件。
export const DEFAULT_TURN_TIMEOUT_MS = 24 * 60 * 60_000;
export const NEXT_TURN_TEXT_MAX_CHARS = 2000;
/** 显式关闭常量:空转推进话术 = off → 纯继续,不注入。 */
export const STALL_PROMPT_OFF = 'off';
/** 内置通用话术(设计 §1):区分死路与墙——下「不可行」结论前列可拆方案。 */
export const DEFAULT_STALL_PROMPT =
  '连续多轮未新增有效研究记录且阶段未推进。注意区分「死路」与「墙」:下「不可行」结论前,'
  + '先逐堵列出当前障碍(墙)与可拆解方案——别把眼前的墙直接写成死路;每条墙至少给出一种绕过/拆解尝试,再做结论。';

// ---------------------------------------------------------------------------
// 纯函数 — 启动校验
// ---------------------------------------------------------------------------

export interface AutoRunStartInput {
  name?: unknown;
  envKey?: unknown;
  goal?: unknown;
  budget?: unknown;
  criteria?: unknown;
  /** 空转推进话术(可选;缺省 = 内置通用话术;'off' = 关闭,纯继续)。 */
  stallPrompt?: unknown;
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

/** 解析空转话术:空白 → 缺省(内置模板);'off' → 关闭;其余原文。 */
function cleanStallPrompt(v: unknown): string | undefined {
  const t = cleanText(v);
  if (!t) return undefined;
  return t === STALL_PROMPT_OFF ? STALL_PROMPT_OFF : t;
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

  const stallPrompt = cleanStallPrompt(input.stallPrompt);
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
    ...(stallPrompt !== undefined ? { stallPrompt } : {}),
  };
  return { ok: true, record };
}

// ---------------------------------------------------------------------------
// 纯函数 — 驱动文本组装
// ---------------------------------------------------------------------------

/** 第一轮驱动文本:目标 + 验收条件(锁定,OR 语义)+ 研究纪律。 */
export function buildFirstTurnText(goal: string, criteria: string[]): string {
  return [
    '【auto loop 任务】你要自主推进以下研究目标,直到达成或超时。本会话由系统逐轮自动驱动(headless),每轮结束自动发起下一轮,不需要请求继续、不要每轮都停;你没有自我退出权——「不可行/卡死」只是研究结论,未达成、未到超时就继续推进。',
    `目标:${goal}`,
    '验收条件(研究员定义、启动即锁定,不可自我降级或漂移表述;OR 语义——任一条件达成即任务完成):',
    ...criteria.map((c, i) => `${i + 1}. ${c}`),
    '',
    '研究纪律:',
    '1. 关键进展/结案都用 research_log 留痕(拿到 flag、确认根因、fuzz 出崩溃、卡住、研判完成都要记)——这是达成验收的证据来源;',
    '2. 确认某条验收条件已达成且有证据时,调用 declare_completion 宣布达成:statement 写清哪条条件被哪条证据支撑;criteria 原样列出声称达成的条件原文;evidenceRefs 挂证据引用(research_log 返回的 E#N 用数字 N,档案实体用 "H#1" 形式的字符串)。系统会做证据预检:通过即完成,不通过会把原因注回并继续推进;',
    '3. 遇方向分歧/歧义:没有问询通道——自行选择最可能的路径继续,把问题与假设记进档案(Q# 未决问题),人事后回看;',
    '4. 越界动作(写宿主/用本机凭据/改网络策略/销毁环境)会被边界拦截,如实遵守拦截提示;',
    '5. 研究档案(research_archive 工具)是你的显式研究状态,随研究持续更新、每轮注回你的上下文——基于它继续,不从历史脑补:假设驱动实验(evidence 挂假设引用);结论必须挂已存在的 V# 证据引用(op=finding refs,有反证挂 against,不报反证=确认偏误);证伪/纠错走 falsify/correct,不要把证伪写进 finding 文本冒充成立;假设要有终态(resolve/falsify/abandon);目标不清立 question;anchor 标注用「env_exec #N / 命令名 / 文件:行号」,不要用「轮」。',
  ].join('\n');
}

export interface NextTurnTextOptions {
  /** declare 预检不过的前置回注(下轮继续指令)。 */
  precheckNote?: string;
  /** 空转推进话术(系统注入标注)。 */
  stallNote?: string;
  maxChars?: number;
}

/** 后续轮驱动文本:「继续推进目标,上一轮结果:<截断>」(可选前置注回块)。 */
export function buildNextTurnText(goal: string, previousText: string, options: NextTurnTextOptions = {}): string {
  const maxChars = options.maxChars ?? NEXT_TURN_TEXT_MAX_CHARS;
  const clipped = previousText.trim().length > maxChars
    ? `${previousText.trim().slice(0, maxChars)}…(截断)`
    : previousText.trim();
  return [
    `【auto loop 继续】继续推进目标:${goal}`,
    options.precheckNote ? `【系统注回·达成预检】${options.precheckNote}` : '',
    options.stallNote ? `【系统注入·空转推进话术】${options.stallNote}` : '',
    `上一轮结果(截断):${clipped || '(无输出)'}`,
    '继续自主推进;关键进展用 research_log 留痕;研究档案(research_archive)持续更新——结论挂 V# 证据引用、证伪走 falsify/correct;验收条件达成且有证据时用 declare_completion 宣布(OR 语义,附 criteria 与证据引用);遇歧义自行决策并记档案(Q# 未决问题)。',
  ].filter((line) => line.length > 0).join('\n');
}

// ---------------------------------------------------------------------------
// 纯函数 — 预算
// ---------------------------------------------------------------------------

export interface BudgetSpendInput {
  turns: number;
  tokens: number;
  elapsedMs: number;
  /** tokens 档校准系数(loop session meta 的 tokenCalibration;缺省/非法 → 1,钳 [0.8, 6])。 */
  calibration?: number;
}

export function clampTokenCalibration(calibration: number | undefined): number {
  if (typeof calibration !== 'number' || !Number.isFinite(calibration)) return 1;
  return Math.min(6, Math.max(0.8, calibration));
}

/** 预算已耗计算:turns 计轮次 / tokens 计估算×校准系数 / time 计 wall-clock 分钟。 */
export function computeBudgetSpent(budget: AutoRunBudget, input: BudgetSpendInput): number {
  switch (budget.kind) {
    case 'turns': return input.turns;
    case 'tokens': return input.tokens * clampTokenCalibration(input.calibration);
    case 'time': return Math.max(0, input.elapsedMs) / 60_000;
  }
}

export function isBudgetExhausted(budget: AutoRunBudget, spent: number): boolean {
  return spent >= budget.limit;
}

/** loop 线历史 token 估算(context-manager 的 estimateMessageTokens 口径)。 */
export function estimateLoopTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

// ---------------------------------------------------------------------------
// 纯函数 — 空转证据判定(设计 §1:双信号,主信号=记录增量,辅信号=阶段推进)
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
 * 空转判定(设计 §1/§8):本轮既无新增有效研究记录、阶段也未推进 → streak+1;
 * 达到 stallTurns(缺省 K=3)即判定空转。主信号=记录增量,辅信号=阶段推进;
 * 首轮无阶段基线,不判空转(prevPhase undefined)。判定后由 runner 注入推进
 * 话术并清计数(再空转再注入)。
 */
export function evaluateStall(input: StallCheckInput, stallTurns = STALL_TURNS_DEFAULT): StallCheckOutput {
  const stalledTurn = input.previousPhase !== undefined
    && input.newValidEvents === 0
    && input.phase === input.previousPhase;
  const stallStreak = stalledTurn ? input.stallStreak + 1 : 0;
  return { stallStreak, stalled: stallStreak >= stallTurns };
}

/** 当前研究阶段:1.2.7 同一分类器(segmentContext)末段相位;空历史 → anchor。 */
export function currentResearchPhase(messages: AgentMessage[]): ResearchPhase {
  const segments = segmentContext(messages);
  return segments.length > 0 ? segments[segments.length - 1].phase : 'anchor';
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
const AUTO_RUN_STATUSES = new Set(['running', 'completed', 'stopped', 'exited']);
/** 旧暂停态(paused/awaiting-verdict)读盘归一化为 running——启动愈合统一落 stopped。 */
const LEGACY_ACTIVE_STATUSES = new Set(['paused', 'awaiting-verdict']);

export function serializeAutoRunRecord(record: AutoRunRecord): string {
  return JSON.stringify(record, null, 2) + '\n';
}

/** 反序列化:坏 JSON/形状不符 → null(容错,不炸列表)。旧字段(policy/
 *  verdictPackage/reportDir/pausedMsTotal 等)不再透传;旧暂停态归一化 running。 */
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
    !budget || typeof budget !== 'object' ||
    !AUTO_RUN_KINDS.has(String(budget.kind)) ||
    typeof budget.limit !== 'number' || !(budget.limit > 0)
  ) {
    return null;
  }
  const rawStatus = String(o.status);
  if (!AUTO_RUN_STATUSES.has(rawStatus) && !LEGACY_ACTIVE_STATUSES.has(rawStatus)) return null;
  const status = (LEGACY_ACTIVE_STATUSES.has(rawStatus) ? 'running' : rawStatus) as AutoRunStatus;
  const kind = String(budget.kind) as AutoRunBudget['kind'];
  const declaration = o.declaration && typeof o.declaration === 'object'
    ? (o.declaration as Record<string, unknown>)
    : undefined;
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
    ...(typeof o.stallPrompt === 'string' ? { stallPrompt: o.stallPrompt } : {}),
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '',
    ...(typeof o.workspace === 'string' ? { workspace: o.workspace } : {}),
    ...(typeof o.turns === 'number' ? { turns: o.turns } : {}),
    ...(declaration ? {
      declaration: {
        statement: typeof declaration.statement === 'string' ? declaration.statement : '',
        criteria: Array.isArray(declaration.criteria)
          ? declaration.criteria.filter((c): c is string => typeof c === 'string')
          : [],
        evidenceRefs: Array.isArray(declaration.evidenceRefs)
          ? declaration.evidenceRefs.filter((r): r is number | string => typeof r === 'number' || typeof r === 'string')
          : [],
      },
    } : {}),
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
 * 重启愈合:sidecar 重启后 runner 已死——盘上非新终态记录统一落 stopped
 * (reason=sidecar-restart),防「僵尸 running」永挂。**按 workspace 限定**:
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
      r.status === 'running' &&
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
    /** 1.7.1:显式环境锚(record.envKey)——headless 线不依赖工作区交互选择。 */
    envKey?: string;
    /** 1.7.5:显式工作区锚(record.workspace)——research_log 事件归属。 */
    workspaceAnchor?: string;
  }) => Promise<{ text: string; error?: string; loopSessionId: string }>;
  /** loop 线全量消息(loadLoopSession(...).messages)。 */
  loadMessages: (loopSessionId: string) => AgentMessage[];
  /** tokens 预算校准系数来源(loadLoopSession(...).meta?.tokenCalibration);不注入按系数 1。 */
  loadTokenCalibration?: (loopSessionId: string) => number | undefined;
  /** 本 run 的研究事件(按 loop 线过滤;runner 按 ts 过滤)。 */
  listEvents: () => ResearchEvent[];
  resolveEvent: (id: number) => ResearchEvent | null;
  broadcast: (event: string, data: unknown) => void;
  /** 记录落盘(生产 saveAutoRunRecord,内部已告警不抛)。 */
  save: (record: AutoRunRecord) => void;
  now: () => number;
  log: (msg: string) => void;
  turnTimeoutMs: number;
  /** provider 连击退出阈值(设计 §8:N=5)。 */
  providerStreakExit: number;
  /** 空转 nudge 阈值(设计 §8:K=3)。 */
  stallTurns: number;
}

const DEFAULT_DEP_KEYS = {
  turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
  providerStreakExit: PROVIDER_STREAK_EXIT_DEFAULT,
  stallTurns: STALL_TURNS_DEFAULT,
};

export function withAutoRunDepDefaults(partial: Partial<AutoRunDeps>): AutoRunDeps {
  return { ...DEFAULT_DEP_KEYS, ...partial } as AutoRunDeps;
}

// ---------------------------------------------------------------------------
// runner — 控制器(1.7.7 无暂停点:循环只轮询 stop 旗标,无 wake/waiters)
// ---------------------------------------------------------------------------

export interface AutoRunController {
  readonly record: AutoRunRecord;
  isStopped(): boolean;
  /** Esc 语义:终止循环(当前 invoke turn 不中断,收尾后不再起新轮)。 */
  requestStop(): void;
  /** 循环收尾(测试/关闭用)。 */
  waitUntilDone(): Promise<void>;
  /** runner 内部:循环收尾信号(等待方释放)。 */
  __finish(): void;
}

export function createAutoRunController(record: AutoRunRecord): AutoRunController {
  let stopped = false;
  let doneResolvers: Array<() => void> = [];
  return {
    record,
    isStopped: () => stopped,
    requestStop() {
      if (stopped) return;
      stopped = true;
    },
    waitUntilDone: () => new Promise<void>((resolve) => { doneResolvers.push(resolve); }),
    __finish: () => {
      const ds = doneResolvers;
      doneResolvers = [];
      for (const r of ds) r();
    },
  };
}

// ---------------------------------------------------------------------------
// runner — 主循环
// ---------------------------------------------------------------------------

/** auto-run 专用交互场景(cron 同族 headless 通道,见 system-prompt.ts)。 */
export function autoRunScenario(runId: string): InteractionScenario {
  return { type: 'auto-run', runId };
}

/** 空转话术来源优先级(设计 §1):研究员自定义 > 内置通用话术 > 关闭(纯继续)。 */
function stallPromptOf(record: AutoRunRecord): string | null {
  if (record.stallPrompt === STALL_PROMPT_OFF) return null;
  return record.stallPrompt && record.stallPrompt.trim() ? record.stallPrompt.trim() : DEFAULT_STALL_PROMPT;
}

/**
 * 主循环编排(fire-and-forget;所有依赖注入,不真连环境)。轮次推进 + 达成
 * 预检 + provider 连击退出 + 空转话术注入 + 预算耗尽判定全部在此;轮间
 * 不停不等,没有暂停点。
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
  let providerStreak = 0;
  let pendingPrecheckNote: string | undefined;
  let pendingStallNote: string | undefined;

  const persist = (): void => {
    record.updatedAt = new Date(deps.now()).toISOString();
    deps.save(record);
  };
  /** 预算已耗同步(轮边界统一口径;tokens/time 需 messages 重算,失败轮无 messages 用缺省)。 */
  const syncSpent = (messages?: AgentMessage[]): number => {
    const calibration = deps.loadTokenCalibration?.(loopSessionId);
    const spent = computeBudgetSpent(record.budget, {
      turns: turn,
      tokens: estimateLoopTokens(messages ?? deps.loadMessages(loopSessionId)),
      elapsedMs: deps.now() - startedAtMs,
      ...(calibration !== undefined ? { calibration } : {}),
    });
    record.budget.spent = spent;
    return spent;
  };
  /** 终态统一收尾:persist + 广播(现状 payload 形状,outcome=passed/stopped/exited)+ 注回交互线。 */
  const finishTerminal = (status: 'completed' | 'stopped' | 'exited', reason: string | undefined, outcomeText: string): void => {
    record.status = status;
    if (reason !== undefined) record.pauseReason = reason;
    else delete record.pauseReason;
    persist();
    deps.broadcast('auto-run:completed', {
      id: record.id,
      outcome: status === 'completed' ? 'passed' : status,
      ...(reason !== undefined ? { reason } : {}),
    });
    injectInteractiveWrapUp(record, lastText, outcomeText);
  };

  deps.broadcast('auto-run:started', {
    id: record.id,
    name: record.name,
    envKey: record.envKey,
    goal: record.goal,
    budget: record.budget,
    criteria: record.criteria,
    criteriaCount: record.criteria.length,
    loopSessionId,
  });

  while (!ctl.isStopped()) {
    // ---- 1. 驱动文本(前置注回块:达成预检不过 / 空转话术)+ invoke 本轮 ----
    const text = turn === 0
      ? buildFirstTurnText(record.goal, record.criteria)
      : buildNextTurnText(record.goal, lastText, {
          precheckNote: pendingPrecheckNote,
          stallNote: pendingStallNote,
        });
    pendingPrecheckNote = undefined;
    pendingStallNote = undefined;
    deps.log(`[auto-run] ${record.id} 第 ${turn + 1} 轮`);
    let result: { text: string; error?: string };
    try {
      result = await deps.invoke(
        { text },
        { loopSessionId, scenario: autoRunScenario(record.id), timeoutMs: deps.turnTimeoutMs, envKey: record.envKey, workspaceAnchor: record.workspace },
      );
    } catch (err) {
      result = { text: '', error: err instanceof Error ? err.message : String(err) };
    }
    lastText = result.text ?? '';
    turn += 1;
    record.turns = turn;
    syncSpent();

    // ---- 2. provider 连击(设计 §1:连续 N 次 → exited;任何成功 invoke 清计数;
    //        工具级 isError 是研究信号,不计数、不退出) ----
    if (result.error) {
      providerStreak += 1;
      deps.log(`[auto-run] ${record.id} 模型调用失败(${providerStreak}/${deps.providerStreakExit}):${result.error.slice(0, 200)}`);
      if (providerStreak >= deps.providerStreakExit) {
        finishTerminal('exited', 'provider-error', `已退出(provider 连续 ${providerStreak} 次失败)`);
        break;
      }
      continue;
    }
    providerStreak = 0;
    if (ctl.isStopped()) break;

    const messages = deps.loadMessages(loopSessionId);
    syncSpent(messages);

    // ---- 3. 达成信号(declare_completion)→ 证据预检(OR 条件命中)→ completed / 回注继续 ----
    const declaration = takeCompletionDeclaration(loopSessionId);
    if (declaration) {
      record.declaration = {
        statement: declaration.statement,
        criteria: declaration.criteria,
        evidenceRefs: declaration.evidenceRefs,
      };
      const precheck = precheckCompletionDeclaration(
        declaration,
        record.criteria,
        { resolveEvent: deps.resolveEvent, loadArchive: (sid) => loadArchive(sid) },
        loopSessionId,
      );
      if (precheck.ok) {
        finishTerminal('completed', undefined, `已达成(共 ${turn} 轮)`);
        break;
      }
      pendingPrecheckNote = `上轮达成宣称未通过证据预检:${precheck.error}。继续推进。`;
      deps.log(`[auto-run] ${record.id} 达成宣称预检不过:${precheck.error}`);
    }

    // ---- 4. 空转检测(K 轮无新增有效研究记录且阶段未推进 → 注入推进话术) ----
    const events = deps.listEvents();
    const validCount = countValidEventsSince(events, startedAtMs);
    const phase = currentResearchPhase(messages);
    const phaseBefore = prevPhase;
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
      const stalledStreak = stallEval.stallStreak;
      stallStreak = 0; // 每次检测注入一次并清计数,再空转再注入(设计 §8)
      const prompt = stallPromptOf(record);
      if (prompt) pendingStallNote = prompt;
      deps.log(`[auto-run] ${record.id} 空转检测(连续 ${stalledStreak} 轮)${prompt ? '→ 注入推进话术' : '(话术关闭)→ 纯继续'}`);
    }

    // ---- 5. 阶段推进:拍肩膀(阶段边界不暂停,设计 §1) ----
    if (phaseBefore !== undefined && phase !== phaseBefore) {
      deps.broadcast('auto-run:phase-changed', { id: record.id, phase, previousPhase: phaseBefore });
    }

    // ---- 6. 预算耗尽 → stopped(无 checkpoint、无报告,产出见设计 §4b) ----
    if (isBudgetExhausted(record.budget, syncSpent(messages))) {
      finishTerminal('stopped', 'budget', `已停止(预算耗尽,共 ${turn} 轮)`);
      break;
    }

    // ---- 7. 轮次收尾 ----
    persist();
    deps.broadcast('auto-run:turn-completed', {
      id: record.id,
      turn,
      phase,
      budget: record.budget,
      status: record.status,
    });
  }

  // Esc 收尾(状态未定终态才写 stopped)。
  if (ctl.isStopped() && record.status === 'running') {
    syncSpent();
    finishTerminal('stopped', undefined, `已终止(跑了 ${turn} 轮)`);
  }
  // 终态清理本 loop 线遗留的达成声明(防残留被下一条同线 run 误消费)。
  clearCompletionDeclarations(loopSessionId);
  ctl.requestStop(); // 幂等;确保 isStopped 归位(waitUntilDone 依赖)
  ctl.__finish();
}

// ---------------------------------------------------------------------------
// 生产接线(admin-api 薄调用;单测不触)
// ---------------------------------------------------------------------------

/** 生产依赖组装(workspace = 引擎锚定工作区;测试注入 Partial 覆盖)。 */
export function buildProductionAutoRunDeps(workspace: string, overrides: Partial<AutoRunDeps> = {}, loopSessionId?: string): AutoRunDeps {
  const deps: AutoRunDeps = {
    workspace,
    invoke: async (input, options) => invokePiSession(input, options),
    loadMessages: (id) => loadLoopSession(id).messages,
    loadTokenCalibration: (id) => loadLoopSession(id).meta?.tokenCalibration,
    // 1.7.5:事件按【线】过滤(loopSessionId),不按 workspace——同一工作区串行
    // 跑 N 条 run(CVE 批跑常态)时,工作区过滤会把别条 run 的事件喂进本 run
    // 的空转判定。无 loopSessionId(测试/兜底)回落旧的工作区过滤。
    listEvents: () =>
      loopSessionId
        ? listResearchEvents({ limit: 1000, loopSessionId })
        : listResearchEvents({ limit: 1000, workspace }),
    resolveEvent: (id) => getResearchEventById(id),
    broadcast: (event, data) => broadcast(event, data),
    save: (record) => { void saveAutoRunRecord(record); },
    now: () => Date.now(),
    log: (msg) => console.log(msg),
    ...DEFAULT_DEP_KEYS,
  };
  return { ...deps, ...overrides };
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
    if (n > 0) console.log(`[auto-run] 重启愈合:${n} 条本工作区 running 记录标记 stopped(sidecar-restart)`);
  } catch (err) {
    console.warn('[auto-run] 重启愈合失败(非致命):', err);
  }
}

/** 引擎锚定工作区(生产依赖的缺省 workspace 数据源)。 */
function engineWorkspace(): string {  return getPiAgentState().agentDir || process.cwd();
}

/**
 * 收官注回交互线(人工继续的上下文共享)——run 终态时把目标/结果/轨迹线写进
 * 同工作区当前环境的交互会话线(appendLoopMessages 落盘——下一个交互轮次的
 * 模型上下文即带 loop 成果)。无绑定 / 绑定线即本 run 线 / 当前选定环境不是
 * run 的环境 → 静默跳过(不串线)。失败只告警,不影响终态。
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
    if (binding.envKey !== envKeyForSelection({ kind: 'env', id: record.envKey })) return;
    const summary = lastText.trim().slice(0, 600) || '（无）';
    const text = [
      `【auto loop 收官】「${record.name}」${outcome}。`,
      `目标：${record.goal}`,
      `结论摘要：${summary}`,
      `验收条件：${record.criteria.length} 条（启动即锁定，全程未改）。`,
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

/** 启动(校验 → 落盘 → 异步跑)。同一 workspace 或同 envKey 只允许一个活跃 run。 */
export async function startAutoRun(
  input: AutoRunStartInput,
  workspace: string,
  depsOverride?: Partial<AutoRunDeps>,
): Promise<AutoRunApiResult<{ id: string; record: AutoRunRecord }>> {
  await ensureOrphanRecovery(workspace);
  const validated = validateAutoRunStart(input, {
    // 1.7.8：含内置本机条目——local 选定的 workspace 跑 auto-run 时找得到条目。
    findEnv: (envKey) => findEnvironmentEntry(listEnvironmentsWithBuiltin(loadConfig()), envKey),
    loopSessionId: newLoopSessionId(),
  });
  if (!validated.ok) return { success: false, error: validated.error };
  const record: AutoRunRecord = { ...validated.record, workspace };

  // 单实例闸:同 workspace **或**同 envKey 已有活跃 run → 拒绝(先 Esc 再启动新 run)。
  // workspace 比较走 workspacePathsEqual(尾斜杠/分隔符差异不算不同工作区)。
  const conflict = [...activeRuns.values()].find((a) => {
    if (a.record.status !== 'running') return false;
    if (a.record.workspace !== undefined && workspacePathsEqual(a.record.workspace, workspace)) return true;
    return a.record.envKey === validated.record.envKey;
  });
  if (conflict) {
    const sameWorkspace = conflict.record.workspace !== undefined
      && workspacePathsEqual(conflict.record.workspace, workspace);
    const error = sameWorkspace
      ? `已有运行中的 auto run "${conflict.record.name}"(id=${conflict.record.id}),先 Esc 终止再启动新 run`
      : `环境 "${validated.record.envKey}" 已被运行中的 auto run "${conflict.record.name}"(id=${conflict.record.id}) 占用,先 Esc 终止再启动`;
    return { success: false, error };
  }

  const deps = buildProductionAutoRunDeps(workspace, depsOverride, record.loopSessionId);
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
    deps.broadcast('auto-run:completed', { id: record.id, outcome: 'stopped', reason: 'runner-error' });
  }).finally(() => {
    // runner 终态(正常收官/停止/异常兜底)即从活动注册表摘除——防终态记录
    // 永挂内存(stop/list 之后走盘上记录语义,与重启后一致)。
    activeRuns.delete(record.id);
  });
  return { success: true, data: { id: record.id, record } };
}

export function stopAutoRun(id: string): AutoRunApiResult<{ id: string }> {
  const active = activeRuns.get(id);
  if (!active) return { success: false, error: `auto run "${id}" 不存在(或已随 sidecar 重启终止)` };
  if (active.record.status !== 'running') {
    return { success: false, error: `auto run "${id}" 已终态(${active.record.status})` };
  }
  active.ctl.requestStop();
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
