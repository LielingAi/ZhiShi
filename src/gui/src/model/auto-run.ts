/**
 * auto loop agent 的 GUI 纯函数层（1.4.1；1.6.0 全链路审查修订）。
 *
 * 服务端契约（auto-run runner，1.4.1 并行实施，按此消费）：
 *   - POST /chat/auto-run/start   { name, envKey, goal,
 *                                    budget:{ kind:'turns'|'tokens'|'time', limit },
 *                                    criteria[] } → { success, id }
 *     （1.6.0 注释修正：开局快照/完成报告由服务端无条件执行，载荷不含
 *     snapshot/report 字段——与 buildAutoRunStartPayload 一致。）
 *   - POST /chat/auto-run/stop    { id }
 *   - POST /chat/auto-run/budget  { id, limit }（加预算 + 续命，服务端加完续跑）
 *   - POST /chat/auto-run/verdict { id, verdict:'pass'|'fail'|'continue', note? }
 *     （验收终审三按钮。1.6.0 语义钉死：fail = 注回修正**续跑**（设计 §4，
 *     服务端 fail/continue 均注回 loop 线继续跑），不是终止；note 为终审
 *     附注（不通过理由/继续跑补充说明），服务端 resolveVerdict 已收。）
 *   - POST /chat/auto-run/list    → 全量记录（重连后恢复活跃 loop 用；
 *     1.6.0 注释修正：与 api.autoRunList 一致走 POST，不是 GET）
 *
 * SSE 事件族（reducer.ts 归约成 AutoRunDelta，本模块做登记表归并）：
 *   auto-run:started / phase-changed / turn-completed /
 *   paused { reason:'stall'|'repeated-failures'|'budget'|'decision'|'provider-error' } /
 *   budget-warning / completed /
 *   verdict-requested { id, criteria[], criteriaPrecheck[{text,status}], evidence{statement,refs[]} } /
 *   resumed { id }（1.6.0 新增：verdict 续跑/暂停恢复/预算续命恢复广播——
 *   多客户端对齐用，本地作答路径已先行翻 running，幂等）
 *
 * 口径说明：
 *   - time 预算单位按分钟（设计文档「2 小时」默认档 → limit=120）；
 *     tokens 档默认 8M；turns 档默认 50。
 *   - verdict-requested 的 criteria 支持字符串或 { text, refs?, hasEvidence? }
 *     对象两种形状；1.6.0 起优先认 criteriaPrecheck（[{text,status}]——
 *     status evidence/partial（旧枚举 hit 兼容）→ hasEvidence:true）与
 *     evidence.refs（E#N 口径，恢复路径 parseVerdictPackage 同口径）；
 *     evidence 支持字符串或 { statement? } 对象（防御解析）。
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

export type AutoRunPauseReason = 'stall' | 'repeated-failures' | 'budget' | 'provider-error' | 'decision';

/** 验收条件 × 证据预检（verdict-requested 的 GUI 侧形状）。 */
export interface VerdictCriterion {
  text: string;
  hasEvidence: boolean;
  /**
   * 研究记录引用（E#N 口径，同决策块 expertRefs 风格）。A2-6 配套判空：
   * 断线恢复路径（verdictPackage→criteriaPrecheck）无 refs 数据，字段可缺席，
   * 渲染方按 undefined → [] 处理。
   */
  refs?: string[];
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
  /** run 的 loop 线（1.4.4 研究档案按线加载——恢复时研究面板据此查档案）。 */
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

/** paused.reason 窄化（非法/缺失 → null，事件丢弃）。
 *  1.6.0：补 'decision'（模型提请决策的暂停点——服务端 AutoRunPauseReason
 *  五枚举之一，此前 GUI 窄化直接丢弃该暂停事件）。 */
export function pauseReasonOf(v: unknown): AutoRunPauseReason | null {
  const s = str(v);
  return s === 'stall' || s === 'repeated-failures' || s === 'budget' || s === 'provider-error' || s === 'decision' ? s : null;
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
// 验收包解析（verdict-requested payload → VerdictRequest）
// ---------------------------------------------------------------------------

/**
 * criteriaPrecheck.status → hasEvidence（live 与恢复路径同一口径，1.6.0）：
 * evidence（全命中）/ partial（部分命中）→ true；'hit' 是旧枚举兼容。
 */
function precheckHasEvidence(status: string): boolean {
  return status === 'evidence' || status === 'partial' || status === 'hit';
}

/**
 * evidence.refs → E#N 引用数组（1.6.0 live 证据预检接线）。服务端实况：
 * refs 是 [{ id:number, hit:boolean, summary?… }]（VerdictEvidenceRef）——
 * 只取命中的，按研究记录 E#N 口径渲染（同决策块 expertRefs 风格）；
 * 字符串数组（旧/兼容形态）原样透传。
 */
function evidenceRefsOf(evidence: unknown): string[] {
  const raw = rec(evidence).refs;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r === 'string') {
      if (r.trim()) out.push(r.trim());
      continue;
    }
    const o = rec(r);
    if (typeof o.id === 'number' && o.hit === true) out.push(`E#${o.id}`);
  }
  return out;
}

/**
 * criteria：字符串（无证据标记）或对象 { text, refs?, hasEvidence? }。
 * criteriaPrecheck：1.6.0 接线——服务端 live 广播的真实预检形状
 * [{ text, status:'evidence'|'partial'|'none' }]，在场时优先（criteria
 * 字符串数组不带预检信息，只用它会全部 ✗）；命中引用的 E#N 徽章挂到
 * 有证据的条件上（服务端预检聚合是全局口径，逐条件 refs 数据不存在）。
 * evidence：字符串（模型陈述原文）或对象 { statement?, refs? }。
 * 缺失字段防御回落，不炸。
 */
export function parseVerdictRequest(payload: unknown): VerdictRequest {
  const p = rec(payload);
  const evidence = p.evidence;
  const statement =
    typeof evidence === 'string'
      ? evidence
      : (str(rec(evidence).statement) ?? str(rec(evidence).text) ?? '');
  const hitRefs = evidenceRefsOf(evidence);
  const criteria: VerdictCriterion[] = [];
  // 1.6.0：criteriaPrecheck 优先（live 真实 wire 形状）。
  const precheck = p.criteriaPrecheck;
  if (Array.isArray(precheck) && precheck.length > 0) {
    for (const c of precheck) {
      const r = rec(c);
      const text = (str(r.text) ?? '').trim();
      if (!text) continue;
      const hasEvidence = precheckHasEvidence(str(r.status) ?? '');
      criteria.push({ text, hasEvidence, refs: hasEvidence ? hitRefs : [] });
    }
    return { criteria, statement };
  }
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
  return { criteria, statement };
}

/**
 * 盘上记录的 verdictPackage 形状（auto-run/list 恢复路径）→ VerdictRequest。
 * 1.4.6 dogfood 实证：断线/重启后终审弹窗必须能从 list 恢复——记录存的是
 * verdictPackage（statement + criteriaPrecheck[{text,status}]），与 SSE
 * verdict-requested 的 verdict 形状不同；缺这个解析，弹窗永远不出
 * （auto loop 卡死在 awaiting-verdict，人无法终审）。
 * 1.6.0：status 口径与 parseVerdictRequest 对齐——partial（部分命中）
 * 也算有证据（此前只认 evidence/hit，partial 条件在恢复路径错标 ✗）。
 */
export function parseVerdictPackage(payload: unknown): VerdictRequest | undefined {
  const p = rec(payload);
  const statement = str(p.statement) ?? '';
  const raw = p.criteriaPrecheck;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const criteria: VerdictCriterion[] = [];
  for (const c of raw) {
    const r = rec(c);
    const text = (str(r.text) ?? '').trim();
    if (!text) continue;
    criteria.push({ text, hasEvidence: precheckHasEvidence(str(r.status) ?? ''), refs: [] });
  }
  if (criteria.length === 0) return undefined;
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
      /** 1.5.13：started 事件带 loopSessionId——观察流轮询 run 线依赖它。 */
      loopSessionId?: string;
    }
  | { kind: 'phase'; id: string; phase: string }
  | { kind: 'turn'; id: string; turnCount?: number; used?: number; conclusion?: string }
  | { kind: 'paused'; id: string; reason: AutoRunPauseReason; summary?: string }
  | { kind: 'budget'; id: string; used?: number; limit?: number }
  | { kind: 'completed'; id: string; summary?: string }
  | { kind: 'verdict'; id: string; verdict: VerdictRequest }
  | { kind: 'resumed'; id: string };

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
    case 'paused': {
      if (!entry || entry.id !== delta.id) return entry;
      // 1.6.0：completed/stopped 终态不复活——迟到的 paused 事件（乱序/重放）
      // 只可能是残影，整条忽略（此前会把已完成的 loop 翻回 paused）。
      if (entry.status === 'completed' || entry.status === 'stopped') return entry;
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
      // 1.6.0：completed/stopped 终态不复活——迟到的 verdict-requested 残影
      // 不再把终态翻回 awaiting-verdict（幽灵弹窗同源）。
      if (entry.status === 'completed' || entry.status === 'stopped') return entry;
      return { ...entry, status: 'awaiting-verdict', verdict: delta.verdict, updatedAt: now };
    }
    case 'resumed': {
      if (!entry || entry.id !== delta.id) return entry;
      // 1.6.0：auto-run:resumed——verdict 续跑/暂停恢复/预算续命恢复的统一
      // 恢复广播。本地作答路径已先行翻 running（幂等）；多客户端/断线漏事件
      // 的对齐靠它：paused → running 清暂停点；awaiting-verdict → running
      // 清验收包（fail/continue 续跑语义）。终态（completed/stopped）不复活。
      if (entry.status === 'paused') {
        return { ...entry, status: 'running', paused: undefined, updatedAt: now };
      }
      if (entry.status === 'awaiting-verdict') {
        return { ...entry, status: 'running', verdict: undefined, updatedAt: now };
      }
      if (entry.status === 'completed' || entry.status === 'stopped') return entry;
      return { ...entry, updatedAt: now };
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

/**
 * 终审弹窗可见口径（A3-2：Esc 链与 AutoRunVerdictModal 渲染共用单点）——
 * verdict 存在 + 未收起 + loop 仍在 awaiting-verdict。孤儿记录（sidecar
 * 重启后 runner 消亡、verdictPackage 残留）不算「开」，Esc 不再被静默吞。
 */
export function verdictModalOpen(entry: AutoRunEntry | null | undefined, dismissed: boolean): boolean {
  return entry?.verdict !== undefined && !dismissed && entry.status === 'awaiting-verdict';
}

/**
 * 1.5.13 实机修复：终审「已被消费」的服务端错误形态（仅 awaiting-verdict
 * 态可终审 / 终审已作答）——出现即说明这次终审在服务端已生效（继续跑/定稿
 * 都已发生），客户端必须关窗 + 重新对齐状态，而不是把已消费的终审窗留在
 * 原地让人反复点（实机：第一次「继续跑」成功后模态残留/重开，第二次点
 * 任何按钮都撞这个错误）。
 */
export function isVerdictConsumedError(error: string | undefined): boolean {
  if (!error) return false;
  return error.includes('仅 awaiting-verdict 态可终审') || error.includes('终审已作答');
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

/** 1.6.0：updatedAt 双形态解析——服务端记录落 ISO 字符串（serializeAutoRunRecord
 *  输出形态，new Date().toISOString()），旧 GUI 形态是 number；Date.parse 失败 → undefined。 */
function timestampOf(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

/** list 条目 → AutoRunEntry（id/status 缺一即丢弃）。 */
export function autoRunEntryOf(v: unknown, now = Date.now()): AutoRunEntry | null {
  const p = rec(v);
  const id = str(p.id);
  const status = narrowStatus(p.status);
  if (!id || !status) return null;
  // 1.6.0 paused 形状修复：服务端真实 wire 是扁平 p.pauseReason（字符串，
  // AutoRunRecord 字段）——优先认；p.paused.reason 是旧 GUI 形态，保留兼容。
  // 此前只认 p.paused 对象，恢复路径 paused 字段恒丢（budget/stall/
  // provider-error/decision 暂停点全部还原不出来）。
  const paused = p.paused !== undefined ? rec(p.paused) : null;
  const pausedReason = pauseReasonOf(p.pauseReason) ?? (paused ? pauseReasonOf(paused.reason) : null);
  const pausedSummary = paused ? str(paused.summary) : undefined;
  const verdict = p.verdict !== undefined
    ? parseVerdictRequest(p.verdict)
    : p.verdictPackage !== undefined
      ? parseVerdictPackage(p.verdictPackage)
      : undefined;
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
    ...(pausedReason ? { paused: { reason: pausedReason, summary: pausedSummary } } : {}),
    ...(verdict ? { verdict } : {}),
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

/**
 * 1.6.0：终审作答成功后的本地状态迁移（respondAutoRunVerdict 用，纯函数
 * 便于回归）。语义钉死（设计 §4）：fail = 注回修正**续跑**——与 continue
 * 同回 running（清暂停点/验收包），不再本地翻 stopped；pass → completed
 * （服务端 completed 事件到达时幂等复写）。
 */
export function autoRunEntryAfterVerdictResponse(
  entry: AutoRunEntry,
  verdict: 'pass' | 'fail' | 'continue',
  now = Date.now(),
): AutoRunEntry {
  if (verdict === 'pass') {
    return { ...entry, status: 'completed', updatedAt: now };
  }
  return { ...entry, status: 'running', paused: undefined, verdict: undefined, updatedAt: now };
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
  // 恢复路径（弹窗/档案/观察卡）整体失效。
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
