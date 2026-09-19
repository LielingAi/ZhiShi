/**
 * auto loop agent 的 GUI 纯函数层（1.4.1；1.7.7 auto-redesign 收敛）。
 *
 * 1.7.7 服务端契约（按 loop/auto-run.ts 落盘形状消费）：
 *   - POST auto-run/start { name, envKey, goal, budget:{kind,limit}, criteria[],
 *     stallPrompt? } → { success, id, loopSessionId }
 *     （stallPrompt 可选：留空 = 内置默认话术；'off' = 关闭，纯继续）
 *   - POST auto-run/stop    { id }
 *   - POST auto-run/list    → 全量记录（重连后恢复活跃 loop 用）
 *
 * SSE 事件族（1.7.7 收缩后）：started / phase-changed / turn-completed /
 * completed { id, outcome:'passed'|'stopped'|'exited', reason? }。
 * 终态四枚举：running / completed（达成）/ stopped（超时或 Esc）/ exited
 * （provider 连击 5 次死亡）。无 paused、无 verdict、无 budget 续命。
 *
 * 口径说明：
 *   - time 预算单位按分钟；tokens 档默认 8M；turns 档默认 50。
 *   - 「运行中只能观察」：isAutoRunActive = starting/running——只有终态
 *     才解锁输入与环境切换。
 *   - list 恢复：updatedAt 双形态解析（ISO 字符串 / number），restoredAutoRunStale
 *     守卫防 list 快照覆盖在飞 SSE 事件。
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

/** 1.7.7 终态枚举（服务端 AutoRunStatus 同形状；starting 是本地乐观态）。 */
export type AutoRunStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'stopped'
  | 'exited';

/** auto-run:completed 的 outcome（1.7.7 终态广播契约）。 */
export type AutoRunOutcome = 'passed' | 'stopped' | 'exited';

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
  /** 终态原因（服务端 pauseReason 字段：budget=预算耗尽/provider-error=API
   *  故障/sidecar-restart/runner-error；Esc 无原因）。 */
  stopReason?: string;
  /** run 的 loop 线（研究档案按线加载——恢复时研究面板据此查档案）。 */
  loopSessionId?: string;
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

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** budget.kind 窄化（非法值回落 'turns'）。 */
export function budgetKindOf(v: unknown): AutoRunBudgetKind {
  const s = str(v);
  return s === 'tokens' || s === 'time' ? s : 'turns';
}

/** auto-run:completed 的 outcome 窄化（非法/缺失回落 'passed'——保守按达成显示）。 */
export function outcomeOf(v: unknown): AutoRunOutcome {
  const s = str(v);
  return s === 'stopped' || s === 'exited' ? s : 'passed';
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
  /** 1.7.7 可选空转推进话术（留空 = 内置默认话术；'off' = 关闭，纯继续）。 */
  stallPrompt: string;
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

/** 表单校验（环境=当前环境锁定，不可选——只查非空；stallPrompt 可选不校验）。 */
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
 *  1.7.7：无 policy、无快照/报告开关；stallPrompt 可选透传。 */
export interface AutoRunStartPayload {
  name: string;
  envKey: string;
  goal: string;
  budget: AutoRunBudget;
  criteria: string[];
  stallPrompt?: string;
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
  const stallPrompt = form.stallPrompt.trim();
  return {
    name: form.name.trim(),
    envKey: form.envKey,
    goal: form.goal.trim(),
    budget: { kind: form.budgetKind, limit },
    criteria,
    ...(stallPrompt ? { stallPrompt } : {}),
  };
}

/** start 响应后、SSE auto-run:started 到达前的乐观条目（观察卡立即出现）。
 *  1.5.13：loopSessionId 随 start 回包下发即带上——观察流轮询依赖它。 */
export function optimisticAutoRunEntry(
  id: string,
  payload: AutoRunStartPayload,
  now = Date.now(),
  loopSessionId?: string,
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
    ...(loopSessionId ? { loopSessionId } : {}),
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
// 终态文案（1.7.7：completed 按 outcome 分派）
// ---------------------------------------------------------------------------

/**
 * 终态显示文案：passed → 达成；stopped（reason=budget）→ 预算耗尽（超时）；
 * stopped（无原因）→ 已终止（Esc/stop）；exited → API 故障（provider 连击）。
 */
export function autoRunTerminalText(entry: AutoRunEntry): string {
  if (entry.status === 'completed') return '达成';
  if (entry.status === 'exited') return 'API 故障';
  if (entry.status === 'stopped') {
    return entry.stopReason === 'budget' ? '预算耗尽（超时）' : '已终止';
  }
  return '';
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
      /** 1.5.13：started 事件带 loopSessionId——观察流轮询 run 线依赖它。 */
      loopSessionId?: string;
    }
  | { kind: 'phase'; id: string; phase: string }
  | { kind: 'turn'; id: string; turnCount?: number; used?: number; conclusion?: string }
  | {
      kind: 'completed';
      id: string;
      outcome: AutoRunOutcome;
      /** 终态原因（服务端 pauseReason：budget / provider-error 等）。 */
      reason?: string;
      summary?: string;
    };

/**
 * 登记表归并：活跃 loop 只有一条（autoRun 顶层单条，非数组）。
 *   - started：已有同 id（乐观条目）→ 只翻 running 状态，字段以本地为准
 *     （防服务端 payload 缺字段覆盖掉表单原文）；无 → 用事件建新条目。
 *   - 其余事件：id 不匹配（旧 loop 残影）→ 原样返回；entry 为空 → null。
 *   - phase/turn 事件同时把 starting 翻成 running（乐观条目无独立 running
 *     事件，靠首次活动事件转正）。
 *   - completed：按 outcome 分派终态——passed → completed；stopped/exited
 *     带 reason 落 stopReason；终态不复活（迟到的旧事件整条忽略）。
 */
export function applyAutoRunEvent(
  entry: AutoRunEntry | null,
  delta: AutoRunDelta,
  now = Date.now(),
): AutoRunEntry | null {
  switch (delta.kind) {
    case 'started': {
      if (entry && entry.id === delta.id) {
        // 1.5.13：乐观条目已有字段以本地为准，但 loopSessionId 缺则补上
        // （乐观条目早于 start 回包/started 事件的旧形态）。
        return {
          ...entry,
          status: 'running',
          loopSessionId: entry.loopSessionId ?? delta.loopSessionId,
          updatedAt: now,
        };
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
        ...(delta.loopSessionId ? { loopSessionId: delta.loopSessionId } : {}),
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
    case 'completed': {
      if (!entry || entry.id !== delta.id) return entry;
      // 终态不复活——迟到的 completed 残影（乱序/重放）整条忽略。
      if (entry.status === 'completed' || entry.status === 'stopped' || entry.status === 'exited') {
        return entry;
      }
      const status: AutoRunStatus = delta.outcome === 'passed' ? 'completed' : delta.outcome;
      return {
        ...entry,
        status,
        ...(delta.outcome !== 'passed' && delta.reason ? { stopReason: delta.reason } : {}),
        ...(delta.summary ? { lastConclusion: delta.summary } : {}),
        updatedAt: now,
      };
    }
  }
}

/** 活跃 = 运行期锁定生效（输入/环境切换禁用、Esc 语义切换）。 */
export function isAutoRunActive(entry: AutoRunEntry | null): boolean {
  if (!entry) return false;
  return entry.status === 'starting' || entry.status === 'running';
}

// ---------------------------------------------------------------------------
// auto-run/list 解析（重连恢复活跃 loop）
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES: AutoRunStatus[] = ['starting', 'running'];

function narrowStatus(v: unknown): AutoRunStatus | null {
  const s = str(v);
  if (!s) return null;
  const all: AutoRunStatus[] = [...ACTIVE_STATUSES, 'completed', 'stopped', 'exited'];
  return (all as string[]).includes(s) ? (s as AutoRunStatus) : null;
}

/** 1.6.0：updatedAt 双形态解析——服务端记录落 ISO 字符串（serializeAutoRunRecord
 *  输出形态，new Date().toISOString()），旧 GUI 形态是 number；Date.parse 失败 → undefined。 */
function timestampOf(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

/** list 条目 → AutoRunEntry（id/status 缺一即丢弃）。
 *  1.7.7：终态原因读服务端扁平 pauseReason 字段（stopReason）；旧形态的
 *  paused/verdict/verdictPackage 字段不再消费（服务端已不写）。 */
export function autoRunEntryOf(v: unknown, now = Date.now()): AutoRunEntry | null {
  const p = rec(v);
  const id = str(p.id);
  const status = narrowStatus(p.status);
  if (!id || !status) return null;
  return {
    id,
    name: str(p.name) ?? id,
    envKey: str(p.envKey) ?? '',
    goal: str(p.goal) ?? '',
    budget: { kind: budgetKindOf(rec(p.budget).kind), limit: num(rec(p.budget).limit) ?? 0 },
    // 1.4.6 走查实证：记录存 budget.spent，entry 曾只读 p.used——恢复路径
    // 预算恒 0（观察卡 0/N 错示）。
    used: num(p.used) ?? num(rec(p.budget).spent) ?? 0,
    criteria: strArray(p.criteria),
    status,
    ...(str(p.phase) ? { phase: str(p.phase) } : {}),
    ...(num(p.turnCount) !== undefined ? { turnCount: num(p.turnCount) } : {}),
    ...(str(p.lastConclusion) ?? str(p.summary)
      ? { lastConclusion: str(p.lastConclusion) ?? str(p.summary) }
      : {}),
    ...(str(p.pauseReason) ? { stopReason: str(p.pauseReason) } : {}),
    ...(str(p.loopSessionId) ? { loopSessionId: str(p.loopSessionId) } : {}),
    // 1.6.0：ISO 字符串也认——此前只认 number，服务端记录恒回落 now，
    // loadAutoRunState 的 stale 守卫（cur.updatedAt > restored.updatedAt）
    // 因此从不生效（restored.updatedAt 永远是「刚恢复的时刻」）。
    updatedAt: timestampOf(p.updatedAt) ?? now,
  };
}

/**
 * 1.6.0：list 恢复 stale 守卫（loadAutoRunState 用）——同 id 且本地条目
 * 比恢复快照新（updatedAt 更大）时不覆盖（list 快照落后于在飞 SSE 事件）。
 * 配合 autoRunEntryOf 的 ISO 解析才真正生效。
 */
export function restoredAutoRunStale(
  cur: AutoRunEntry | null,
  restored: AutoRunEntry | null,
): boolean {
  return !!(restored && cur && restored.id === cur.id && cur.updatedAt > restored.updatedAt);
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
  // 1.4.6 dogfood 实证：服务端 handleAutoRunList 的真实形状是
  // { success, data: { records: [...] } }——只认 runs/裸数组会静默返回空，
  // 恢复路径（档案/观察卡）整体失效。
  pushAll(
    Array.isArray(v.runs) ? v.runs
      : Array.isArray(data.runs) ? data.runs
      : Array.isArray(data.records) ? data.records
      : Array.isArray(v.records) ? v.records
      : data,
  );
  return out;
}

/** 活跃条目（重连恢复目标；无活跃条目 → null）。 */
export function activeAutoRunOf(raw: unknown): AutoRunEntry | null {
  return parseAutoRunList(raw).find((e) => isAutoRunActive(e)) ?? null;
}

/** 1.4.7 轮内进度（观察卡）：当前轮号 = 已完成轮数 + 1；轮内耗时 =
 *  now − updatedAt（上轮完成时刻近似）。非 running 态 → null（不显示）。 */
export function turnProgressOf(entry: AutoRunEntry, now = Date.now()): { turn: number; elapsedSec: number } | null {
  if (entry.status !== 'running') return null;
  return {
    turn: (entry.turnCount ?? 0) + 1,
    elapsedSec: Math.max(0, Math.round((now - entry.updatedAt) / 1000)),
  };
}
