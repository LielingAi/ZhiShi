/**
 * auto loop agent 的 GUI 纯函数层（1.4.1）。
 *
 * 服务端契约（auto-run runner，1.4.1 并行实施，按此消费）：
 *   - POST /chat/auto-run/start   { name, envKey, goal,
 *                                    budget:{ kind:'turns'|'tokens'|'time', limit },
 *                                    criteria[], snapshot?, report? } → { success, id }
 *   - POST /chat/auto-run/stop    { id }
 *   - POST /chat/auto-run/budget  { id, limit }（加预算 + 续命，服务端加完续跑）
 *   - POST /chat/auto-run/verdict { id, verdict:'pass'|'fail'|'continue' }
 *     （验收终审三按钮；'continue' 同时是 stall/repeated-failures 暂停点的
 *     「继续」通道——契约未给独立 resume 端点）
 *   - GET  /chat/auto-run/list    → 全量记录（重连后恢复活跃 loop 用）
 *
 * SSE 事件族（reducer.ts 归约成 AutoRunDelta，本模块做登记表归并）：
 *   auto-run:started / phase-changed / turn-completed /
 *   paused { reason:'stall'|'repeated-failures'|'budget', summary? } /
 *   budget-warning / completed / verdict-requested { id, criteria[], evidence }
 *
 * 口径说明：
 *   - time 预算单位按分钟（设计文档「2 小时」默认档 → limit=120）；
 *     tokens 档默认 8M；turns 档默认 50。
 *   - verdict-requested 的 criteria 支持字符串或 { text, refs?, hasEvidence? }
 *     对象两种形状；evidence 支持字符串或 { statement? } 对象（防御解析，
 *     服务端字段定稿后仍兼容）。
 *   - 「运行中只能观察」的口径：isAutoRunActive = starting/running/paused/
 *     awaiting-verdict——只有 completed/stopped 才解锁输入与环境切换。
 *
 * 纯函数：不 import store / React / client；单测见 auto-run.test.ts。
 */

// ---------------------------------------------------------------------------
// 基础类型
// ---------------------------------------------------------------------------

export type AutoRunBudgetKind = 'turns' | 'tokens' | 'time';

export interface AutoRunBudget {
  kind: AutoRunBudgetKind;
  limit: number;
}

export type AutoRunStatus =
  | 'starting'
  | 'running'
  | 'paused'
  | 'awaiting-verdict'
  | 'completed'
  | 'stopped';

export type AutoRunPauseReason = 'stall' | 'repeated-failures' | 'budget';

/** 验收条件 × 证据预检（verdict-requested 的 GUI 侧形状）。 */
export interface VerdictCriterion {
  text: string;
  hasEvidence: boolean;
  /** 研究记录引用（E#N 口径，同决策块 expertRefs 风格）。 */
  refs: string[];
}

/** 验收包（verdict-requested 归约结果）。 */
export interface VerdictRequest {
  criteria: VerdictCriterion[];
  /** 模型陈述：哪条证据支撑哪条条件。 */
  statement: string;
}

export interface AutoRunEntry {
  id: string;
  name: string;
  envKey: string;
  goal: string;
  budget: AutoRunBudget;
  /** 已消耗量（轮次 / tokens / 分钟，按 budget.kind 口径）。 */
  used: number;
  /** 启动即锁定的验收条件原文。 */
  criteria: string[];
  status: AutoRunStatus;
  /** 研究阶段（锚定/侦察/分析/构造/执行/评估，phase-changed 推）。 */
  phase?: string;
  turnCount?: number;
  /** 最近结论行（turn-completed 的摘要，拍肩膀回报）。 */
  lastConclusion?: string;
  paused?: { reason: AutoRunPauseReason; summary?: string };
  verdict?: VerdictRequest;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// 窄化小工具（wire 是 unknown：防御解析）
// ---------------------------------------------------------------------------

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** budget.kind 窄化（非法值回落 'turns'）。 */
export function budgetKindOf(v: unknown): AutoRunBudgetKind {
  const s = str(v);
  return s === 'tokens' || s === 'time' ? s : 'turns';
}

/** paused.reason 窄化（非法/缺失 → null，事件丢弃）。 */
export function pauseReasonOf(v: unknown): AutoRunPauseReason | null {
  const s = str(v);
  return s === 'stall' || s === 'repeated-failures' || s === 'budget' ? s : null;
}

// ---------------------------------------------------------------------------
// 启动表单：校验 / payload 构造
// ---------------------------------------------------------------------------

export const DEFAULT_BUDGET_LIMITS: Record<AutoRunBudgetKind, number> = {
  turns: 50,
  tokens: 8_000_000,
  time: 120, // 分钟（2 小时）
};

/** 预算档展示名（表单 radio）。 */
export const BUDGET_KIND_LABELS: Record<AutoRunBudgetKind, string> = {
  turns: '轮次',
  tokens: 'Token',
  time: '时间（分钟）',
};

/** 表单视图（budgetLimit 是输入原文，提交前解析）。 */
export interface AutoRunFormView {
  name: string;
  envKey: string;
  goal: string;
  budgetKind: AutoRunBudgetKind;
  budgetLimit: string;
  criteria: string[];
}

export interface AutoRunFormError {
  field: 'name' | 'envKey' | 'goal' | 'budgetLimit' | 'criteria';
  message: string;
}

/** 预算数值解析：正整数（"50" → 50；"0"/"-3"/"1.5"/"abc" → null）。 */
export function parseBudgetLimit(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 表单校验（环境=当前环境锁定，不可选——只查非空）。 */
export function validateAutoRunForm(
  form: AutoRunFormView,
  envs?: ReadonlyArray<{ id: string }>,
): AutoRunFormError[] {
  void envs; // 1.4.1 用户拍板：环境锁定当前环境——列表命中校验已无意义，保留参数兼容。
  const errors: AutoRunFormError[] = [];
  if (!form.name.trim()) errors.push({ field: 'name', message: '任务名必填' });
  if (!form.envKey) {
    errors.push({ field: 'envKey', message: '当前未选环境——先在侧栏选择环境（一切操作都在环境内）' });
  }
  if (!form.goal.trim()) errors.push({ field: 'goal', message: '目标必填（驱动循环的锚）' });
  if (parseBudgetLimit(form.budgetLimit) === null) {
    errors.push({ field: 'budgetLimit', message: '预算须为正整数' });
  }
  const criteria = form.criteria.map((c) => c.trim()).filter(Boolean);
  if (criteria.length === 0) {
    errors.push({ field: 'criteria', message: '验收条件至少一条（每条一条可验证陈述）' });
  }
  return errors;
}

/** POST auto-run/start 的载荷（校验通过后调用；校验失败返回 null）。
 *  1.4.1 收口：开局快照/完成报告由服务端无条件执行（v1 无开关），
 *  载荷不含这两个字段。 */
export interface AutoRunStartPayload {
  name: string;
  envKey: string;
  goal: string;
  budget: AutoRunBudget;
  criteria: string[];
}

export function buildAutoRunStartPayload(form: AutoRunFormView): AutoRunStartPayload | null {
  const limit = parseBudgetLimit(form.budgetLimit);
  const criteria = form.criteria.map((c) => c.trim()).filter(Boolean);
  if (
    limit === null ||
    !form.name.trim() ||
    !form.envKey ||
    !form.goal.trim() ||
    criteria.length === 0
  ) {
    return null;
  }
  return {
    name: form.name.trim(),
    envKey: form.envKey,
    goal: form.goal.trim(),
    budget: { kind: form.budgetKind, limit },
    criteria,
  };
}

/** start 响应后、SSE auto-run:started 到达前的乐观条目（观察卡立即出现）。 */
export function optimisticAutoRunEntry(
  id: string,
  payload: AutoRunStartPayload,
  now = Date.now(),
): AutoRunEntry {
  return {
    id,
    name: payload.name,
    envKey: payload.envKey,
    goal: payload.goal,
    budget: payload.budget,
    used: 0,
    criteria: payload.criteria,
    status: 'starting',
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// 预算展示
// ---------------------------------------------------------------------------

/** tokens 数值缩写：>=1M → "8.0M"；>=1K → "800K"；否则原文。 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** 分钟缩写：<60 → "35 分"；>=60 → "2 小时" / "1 小时 30 分"。 */
export function formatMinutes(n: number): string {
  if (n < 60) return `${n} 分`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

/** 「余量」文案（按 kind 口径）。 */
export function formatBudget(kind: AutoRunBudgetKind, used: number, limit: number): string {
  if (kind === 'turns') return `${used} / ${limit} 轮`;
  if (kind === 'tokens') return `${formatTokens(used)} / ${formatTokens(limit)} tokens`;
  return `${formatMinutes(used)} / ${formatMinutes(limit)}`;
}

/** 预算消耗百分比（0-100，limit<=0 回落 0；NaN 防护）。 */
export function budgetUsedPct(used: number, limit: number): number {
  if (!(limit > 0) || !(used > 0)) return 0;
  const pct = Math.round((used / limit) * 100);
  return Math.max(0, Math.min(100, pct));
}

// ---------------------------------------------------------------------------
// 验收包解析（verdict-requested payload → VerdictRequest）
// ---------------------------------------------------------------------------

/**
 * criteria：字符串（无证据标记）或对象 { text, refs?, hasEvidence? }。
 * evidence：字符串（模型陈述原文）或对象 { statement? }。
 * 缺失字段防御回落，不炸。
 */
export function parseVerdictRequest(payload: unknown): VerdictRequest {
  const p = rec(payload);
  const criteria: VerdictCriterion[] = [];
  const raw = p.criteria;
  if (Array.isArray(raw)) {
    for (const c of raw) {
      if (typeof c === 'string') {
        const text = c.trim();
        if (text) criteria.push({ text, hasEvidence: false, refs: [] });
        continue;
      }
      if (c && typeof c === 'object') {
        const r = rec(c);
        const text = (str(r.text) ?? str(r.criterion) ?? str(r.condition) ?? '').trim();
        if (!text) continue;
        const refs = strArray(r.refs ?? r.expertRefs);
        const hasEvidence = bool(r.hasEvidence) ?? refs.length > 0;
        criteria.push({ text, hasEvidence, refs });
      }
    }
  }
  const evidence = p.evidence;
  const statement =
    typeof evidence === 'string'
      ? evidence
      : (str(rec(evidence).statement) ?? str(rec(evidence).text) ?? '');
  return { criteria, statement };
}

// ---------------------------------------------------------------------------
// 事件归约（reducer.ts 发 AutoRunDelta → 本函数 merge 登记表）
// ---------------------------------------------------------------------------

export type AutoRunDelta =
  | {
      kind: 'started';
      id: string;
      name: string;
      envKey: string;
      goal: string;
      budget: AutoRunBudget;
      criteria: string[];
    }
  | { kind: 'phase'; id: string; phase: string }
  | { kind: 'turn'; id: string; turnCount?: number; used?: number; conclusion?: string }
  | { kind: 'paused'; id: string; reason: AutoRunPauseReason; summary?: string }
  | { kind: 'budget'; id: string; used?: number; limit?: number }
  | { kind: 'completed'; id: string; summary?: string }
  | { kind: 'verdict'; id: string; verdict: VerdictRequest };

/**
 * 登记表归并：活跃 loop 只有一条（autoRun 顶层单条，非数组）。
 *   - started：已有同 id（乐观条目）→ 只翻 running 状态，字段以本地为准
 *     （防服务端 payload 缺字段覆盖掉表单原文）；无 → 用事件建新条目。
 *   - 其余事件：id 不匹配（旧 loop 残影）→ 原样返回；entry 为空 → null。
 *   - phase/turn 事件同时把 starting 翻成 running（乐观条目无独立 running
 *     事件，靠首次活动事件转正）。
 */
export function applyAutoRunEvent(
  entry: AutoRunEntry | null,
  delta: AutoRunDelta,
  now = Date.now(),
): AutoRunEntry | null {
  switch (delta.kind) {
    case 'started': {
      if (entry && entry.id === delta.id) {
        return { ...entry, status: 'running', updatedAt: now };
      }
      return {
        id: delta.id,
        name: delta.name,
        envKey: delta.envKey,
        goal: delta.goal,
        budget: delta.budget,
        used: 0,
        criteria: delta.criteria,
        status: 'running',
        updatedAt: now,
      };
    }
    case 'phase': {
      if (!entry || entry.id !== delta.id) return entry;
      return {
        ...entry,
        phase: delta.phase,
        status: entry.status === 'starting' ? 'running' : entry.status,
        updatedAt: now,
      };
    }
    case 'turn': {
      if (!entry || entry.id !== delta.id) return entry;
      return {
        ...entry,
        status: entry.status === 'starting' ? 'running' : entry.status,
        ...(delta.turnCount !== undefined ? { turnCount: delta.turnCount } : {}),
        ...(delta.used !== undefined ? { used: delta.used } : {}),
        ...(delta.conclusion ? { lastConclusion: delta.conclusion } : {}),
        updatedAt: now,
      };
    }
    case 'paused': {
      if (!entry || entry.id !== delta.id) return entry;
      return {
        ...entry,
        status: 'paused',
        paused: { reason: delta.reason, summary: delta.summary },
        updatedAt: now,
      };
    }
    case 'budget': {
      if (!entry || entry.id !== delta.id) return entry;
      return {
        ...entry,
        ...(delta.used !== undefined ? { used: delta.used } : {}),
        ...(delta.limit !== undefined && delta.limit > 0
          ? { budget: { ...entry.budget, limit: delta.limit } }
          : {}),
        updatedAt: now,
      };
    }
    case 'completed': {
      if (!entry || entry.id !== delta.id) return entry;
      return {
        ...entry,
        status: 'completed',
        ...(delta.summary ? { lastConclusion: delta.summary } : {}),
        updatedAt: now,
      };
    }
    case 'verdict': {
      if (!entry || entry.id !== delta.id) return entry;
      return { ...entry, status: 'awaiting-verdict', verdict: delta.verdict, updatedAt: now };
    }
  }
}

/** 活跃 = 运行期锁定生效（输入/环境切换禁用、Esc 语义切换）。 */
export function isAutoRunActive(entry: AutoRunEntry | null): boolean {
  if (!entry) return false;
  return (
    entry.status === 'starting' ||
    entry.status === 'running' ||
    entry.status === 'paused' ||
    entry.status === 'awaiting-verdict'
  );
}

// ---------------------------------------------------------------------------
// auto-run/list 解析（重连恢复活跃 loop）
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES: AutoRunStatus[] = [
  'starting',
  'running',
  'paused',
  'awaiting-verdict',
];

function narrowStatus(v: unknown): AutoRunStatus | null {
  const s = str(v);
  if (!s) return null;
  const all: AutoRunStatus[] = [...ACTIVE_STATUSES, 'completed', 'stopped'];
  return (all as string[]).includes(s) ? (s as AutoRunStatus) : null;
}

/** list 条目 → AutoRunEntry（id/status 缺一即丢弃）。 */
export function autoRunEntryOf(v: unknown, now = Date.now()): AutoRunEntry | null {
  const p = rec(v);
  const id = str(p.id);
  const status = narrowStatus(p.status);
  if (!id || !status) return null;
  const paused = p.paused !== undefined ? rec(p.paused) : null;
  const pausedReason = paused ? pauseReasonOf(paused.reason) : null;
  const pausedSummary = paused ? str(paused.summary) : undefined;
  const verdict = p.verdict !== undefined ? parseVerdictRequest(p.verdict) : undefined;
  return {
    id,
    name: str(p.name) ?? id,
    envKey: str(p.envKey) ?? '',
    goal: str(p.goal) ?? '',
    budget: { kind: budgetKindOf(rec(p.budget).kind), limit: num(rec(p.budget).limit) ?? 0 },
    used: num(p.used) ?? 0,
    criteria: strArray(p.criteria),
    status,
    ...(str(p.phase) ? { phase: str(p.phase) } : {}),
    ...(num(p.turnCount) !== undefined ? { turnCount: num(p.turnCount) } : {}),
    ...(str(p.lastConclusion) ?? str(p.summary)
      ? { lastConclusion: str(p.lastConclusion) ?? str(p.summary) }
      : {}),
    ...(pausedReason ? { paused: { reason: pausedReason, summary: pausedSummary } } : {}),
    ...(verdict ? { verdict } : {}),
    updatedAt: num(p.updatedAt) ?? now,
  };
}

/** 原始 list 响应（裸数组 / {data:[…]} / {data:{runs:[…]}} / {runs:[…]}）→ 条目。 */
export function parseAutoRunList(raw: unknown): AutoRunEntry[] {
  const out: AutoRunEntry[] = [];
  const pushAll = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      const e = autoRunEntryOf(item);
      if (e) out.push(e);
    }
  };
  if (Array.isArray(raw)) {
    pushAll(raw);
    return out;
  }
  const v = rec(raw);
  const data = rec(v.data);
  pushAll(Array.isArray(v.runs) ? v.runs : Array.isArray(data.runs) ? data.runs : data);
  return out;
}

/** 活跃条目（重连恢复目标；无活跃条目 → null）。 */
export function activeAutoRunOf(raw: unknown): AutoRunEntry | null {
  return parseAutoRunList(raw).find((e) => isAutoRunActive(e)) ?? null;
}
