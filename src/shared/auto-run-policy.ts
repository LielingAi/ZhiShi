/**
 * 1.7.0 — auto-loop 策略（design: docs/design/1.7.0-policy-design.md）。
 *
 * 策略文件（YAML）是 run 的唯一治理来源：run 全程自主，无弹窗、无交互；
 * 人与 run 的接口只有两处——开局写策略、结束读报告。schema **无 ask**
 * （CLI 不做交互逻辑；GUI 走自己的原生流程，不经本模块）。
 *
 * 本模块是纯函数（解析/校验/缺省档），放 src/shared 供 CLI 与服务端
 * 共用同一份实现，杜绝两端漂移：
 *   - 服务端：validateAutoRunStart 解析 payload.policy → 落 record.policy；
 *   - CLI：--policy-file 读文件原文直传；不传文件时注入缺省档 YAML
 *     （DEFAULT_AUTO_RUN_POLICY_YAML）——两条路走同一条校验链。
 */

import { load as yamlLoad } from 'js-yaml';

/** 各节 action 闭集（无 ask——系统只「停」或「带原则继续」）。 */
export type PauseAction = 'stop' | 'continue';
export type BudgetAction = 'stop' | 'renew';

export interface AutoRunPolicy {
  onDecision: { action: PauseAction; principles?: string };
  onStall: { tolerance: number; action: PauseAction };
  onFailure: { streak: number; action: PauseAction };
  onBudget: { action: BudgetAction; renewLimits: number[] };
  onDeclare: { report: boolean };
}

/** 保守档——CLI 不传 --policy-file 时的缺省策略（canonical YAML 原文，随版本锁定）。 */
export const DEFAULT_AUTO_RUN_POLICY_YAML = [
  '# zhishi auto-run 缺省策略（保守档，1.7.0）',
  '# 语义：全暂停点保守停止；达成声明自动出报告 → completed。',
  'on_decision:',
  '  action: stop',
  'on_stall:',
  '  tolerance: 3',
  '  action: stop',
  'on_failure:',
  '  streak: 3',
  '  action: stop',
  'on_budget:',
  '  action: stop',
  '  renew_limits: []',
  'on_declare:',
  '  report: true',
].join('\n') + '\n';

const KNOWN_SECTIONS = ['on_decision', 'on_stall', 'on_failure', 'on_budget', 'on_declare'] as const;

export type ParsePolicyResult =
  | { ok: true; policy: AutoRunPolicy }
  | { ok: false; error: string };

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function asRecord(v: unknown, what: string): Result<Record<string, unknown>> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, error: `${what}必须是对象` };
  }
  return { ok: true, value: v as Record<string, unknown> };
}

function checkUnknownKeys(o: Record<string, unknown>, allowed: string[], section: string): Result<null> {
  const unknown = Object.keys(o).filter((k) => !allowed.includes(k));
  return unknown.length > 0
    ? { ok: false, error: `${section} 含未知键 ${unknown.join(', ')}（允许:${allowed.join('/')}）` }
    : { ok: true, value: null };
}

/** 正整数（tolerance/streak 用；非整数或 ≤0 拒绝——策略是研究员写的，从严）。 */
function positiveInt(v: unknown, key: string, section: string): Result<number> {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    return { ok: false, error: `${section}.${key} 必须是 ≥1 的整数（收到 ${JSON.stringify(v)}）` };
  }
  return { ok: true, value: v };
}

function parsePauseAction(v: unknown, section: string): Result<PauseAction> {
  if (v !== 'stop' && v !== 'continue') {
    return { ok: false, error: `${section}.action 非法 ${JSON.stringify(v)}（允许:stop/continue）` };
  }
  return { ok: true, value: v };
}

/** 解析并校验策略：YAML 字符串或已解析对象；缺节 = 缺省保守值；未知键/非法值 → 拒绝。 */
export function parseAutoRunPolicy(input: unknown): ParsePolicyResult {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = yamlLoad(input);
    } catch (err) {
      return { ok: false, error: `YAML 解析失败:${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (raw === undefined || raw === null) return { ok: false, error: '策略为空' };
  const root = asRecord(raw, '策略');
  if (!root.ok) return root;
  const o = root.value;
  const unknownTop = checkUnknownKeys(o, [...KNOWN_SECTIONS], '策略');
  if (!unknownTop.ok) return unknownTop;

  // on_decision（缺省 stop；principles 仅 continue 时注入——stop 时忽略不报错）
  const onDecision: AutoRunPolicy['onDecision'] = { action: 'stop' };
  if (o.on_decision !== undefined) {
    const sec = asRecord(o.on_decision, 'on_decision');
    if (!sec.ok) return sec;
    const s = sec.value;
    const unknown = checkUnknownKeys(s, ['action', 'principles'], 'on_decision');
    if (!unknown.ok) return unknown;
    if (s.action !== undefined) {
      const a = parsePauseAction(s.action, 'on_decision');
      if (!a.ok) return a;
      onDecision.action = a.value;
    }
    if (s.principles !== undefined) {
      if (typeof s.principles !== 'string') return { ok: false, error: 'on_decision.principles 必须是字符串' };
      onDecision.principles = s.principles.trim();
    }
  }

  // on_stall（缺省 tolerance 3 / stop）
  const onStall: AutoRunPolicy['onStall'] = { tolerance: 3, action: 'stop' };
  if (o.on_stall !== undefined) {
    const sec = asRecord(o.on_stall, 'on_stall');
    if (!sec.ok) return sec;
    const s = sec.value;
    const unknown = checkUnknownKeys(s, ['tolerance', 'action'], 'on_stall');
    if (!unknown.ok) return unknown;
    if (s.tolerance !== undefined) {
      const t = positiveInt(s.tolerance, 'tolerance', 'on_stall');
      if (!t.ok) return t;
      onStall.tolerance = t.value;
    }
    if (s.action !== undefined) {
      const a = parsePauseAction(s.action, 'on_stall');
      if (!a.ok) return a;
      onStall.action = a.value;
    }
  }

  // on_failure（缺省 streak 3 / stop）
  const onFailure: AutoRunPolicy['onFailure'] = { streak: 3, action: 'stop' };
  if (o.on_failure !== undefined) {
    const sec = asRecord(o.on_failure, 'on_failure');
    if (!sec.ok) return sec;
    const s = sec.value;
    const unknown = checkUnknownKeys(s, ['streak', 'action'], 'on_failure');
    if (!unknown.ok) return unknown;
    if (s.streak !== undefined) {
      const t = positiveInt(s.streak, 'streak', 'on_failure');
      if (!t.ok) return t;
      onFailure.streak = t.value;
    }
    if (s.action !== undefined) {
      const a = parsePauseAction(s.action, 'on_failure');
      if (!a.ok) return a;
      onFailure.action = a.value;
    }
  }

  // on_budget（缺省 stop / renew_limits []；renew 要求非空正向序列）
  const onBudget: AutoRunPolicy['onBudget'] = { action: 'stop', renewLimits: [] };
  if (o.on_budget !== undefined) {
    const sec = asRecord(o.on_budget, 'on_budget');
    if (!sec.ok) return sec;
    const s = sec.value;
    const unknown = checkUnknownKeys(s, ['action', 'renew_limits'], 'on_budget');
    if (!unknown.ok) return unknown;
    if (s.action !== undefined) {
      if (s.action !== 'stop' && s.action !== 'renew') {
        return { ok: false, error: `on_budget.action 非法 ${JSON.stringify(s.action)}（允许:stop/renew）` };
      }
      onBudget.action = s.action;
    }
    if (s.renew_limits !== undefined) {
      if (!Array.isArray(s.renew_limits)) return { ok: false, error: 'on_budget.renew_limits 必须是数组' };
      const limits: number[] = [];
      for (const [i, v] of s.renew_limits.entries()) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
          return { ok: false, error: `on_budget.renew_limits[${i}] 必须是 >0 的数值（收到 ${JSON.stringify(v)}）` };
        }
        limits.push(v);
      }
      onBudget.renewLimits = limits;
    }
    if (onBudget.action === 'renew' && onBudget.renewLimits.length === 0) {
      return { ok: false, error: 'on_budget.action=renew 要求 renew_limits 非空（每次续命上限的序列）' };
    }
  }

  // on_declare（缺省 report:true）
  const onDeclare: AutoRunPolicy['onDeclare'] = { report: true };
  if (o.on_declare !== undefined) {
    const sec = asRecord(o.on_declare, 'on_declare');
    if (!sec.ok) return sec;
    const s = sec.value;
    const unknown = checkUnknownKeys(s, ['report'], 'on_declare');
    if (!unknown.ok) return unknown;
    if (s.report !== undefined) {
      if (typeof s.report !== 'boolean') return { ok: false, error: 'on_declare.report 必须是布尔值' };
      onDeclare.report = s.report;
    }
  }

  return { ok: true, policy: { onDecision, onStall, onFailure, onBudget, onDeclare } };
}
