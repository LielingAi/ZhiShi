/**
 * AppCraft SOP continuation (P2b-2 失败自动顺接 SOP 续跑, 宪章 §6.3 智能兜底):
 * 确定性回放失败且失败步骤声明了 `fallback: 'ai_vision'` 时，自动带着
 * SKILL.md 五段式上下文向当前会话注入一条续跑消息，agent 切换到 SOP 模式
 * 用全智能完成剩余步骤。
 *
 * 存在论依据：宪章 §6.3「确定性失效的，回到全智能执行——带着 skill 里的
 * 知识完成任务」。快速通道是优化，全智能是本体；本模块是两通道之间的
 * 自动接驳，不是第三条通道。
 *
 * 红线（交接文档 §3 P2b-2 → 机制）：
 *   1. 顺接只发生在 fallback:'ai_vision' 的步骤 —— isSopContinuationEligible
 *      只认 failure.requiresAiHeal；trace 作者声明 fallback 即"此步可交给
 *      AI"的预先批准（§8.2 只许做被批准过的事）。
 *   2. 高危步骤仍需批准 —— 审批门（requiresApproval）在引擎内先于
 *      requiresAiHeal 短路，到不了这里；提示词另作显式指令双保险。
 *   3. 续跑产出必须可审计 —— 注入前写 `.appcraft/sop-heals.jsonl` 审计行；
 *      续跑消息本身进入会话记录（持久化 transcript），全程可见可打断。
 *   4. 无人值守不顺接 —— 调用方（admin-api failure 分支）以 isUnattended
 *      门掉 cron / Hub 任务场景（§8.2：人不在场，AI 接管操作应用超出
 *      回放的批准范围，留给人回来定）。
 *   5. 防注入循环 —— 续跑回合若再次回放失败，不得再注入（同会话同 skill
 *      一次性闸 tryMarkSopContinuation）。一次性闸只在真正注入前消耗。
 *
 * State is a module-level Set keyed `${sessionId}:${skillId}`（Session :
 * Sidecar = 1:1，与 recorder 同一模式）；审计 writer 可注入，跑快速 unit 池。
 */
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

import type { ReplayReport } from './replay-engine';

// ---------------------------------------------------------------------------
// Eligibility + one-shot gate
// ---------------------------------------------------------------------------

/**
 * 顺接资格：只有 skill（SKILL.md 五段式是 SOP 模式的上下文本体，裸录制没有）
 * 且失败步骤声明了 ai_vision fallback。requiresApproval 的高危拦截不算——
 * 那要的是人的批准，不是 AI 接管。
 */
export function isSopContinuationEligible(
  report: ReplayReport,
  kind: 'skill' | 'recording',
): boolean {
  const failure = report.failure;
  return (
    kind === 'skill' &&
    !!failure &&
    failure.requiresAiHeal === true &&
    failure.requiresApproval !== true
  );
}

/** sessionId:skillId 已注入过的组合。 */
const attemptedContinuations = new Set<string>();

/**
 * 一次性闸：同会话同 skill 只自动顺接一次。第一次调用返回 true 并占位；
 * 后续调用返回 false（调用方据此跳过注入，仍返回原 failure 报告）。
 */
export function tryMarkSopContinuation(sessionId: string, skillId: string): boolean {
  const key = `${sessionId}:${skillId}`;
  if (attemptedContinuations.has(key)) return false;
  attemptedContinuations.add(key);
  return true;
}

/** Test-only: drop all one-shot gate state (unit-pool isolation). */
export function resetSopContinuationForTest(): void {
  attemptedContinuations.clear();
}

// ---------------------------------------------------------------------------
// Continuation prompt
// ---------------------------------------------------------------------------

export interface SopContinuationContext {
  /** Skill name（也是 .claude/skills/ 下的目录名）。 */
  skillId: string;
  /** trace.json 绝对路径 —— SKILL.md 与其同目录。 */
  tracePath: string;
  /** 回放时使用的变量（{{参数}} 替换值），续跑要保持同一组取值。 */
  vars: Record<string, string>;
  /** 引擎的结构化失败报告（含每步结果与 failure 详情）。 */
  report: ReplayReport;
}

/**
 * 构造注入会话的续跑消息（以用户消息身份进入 transcript——人在场可看、
 * 可打断、可否决，这本身就是审计的一部分）。指令对齐 app-automation
 * SKILL.md 工作流三，不在这里复制五段式内容，只指路（SKILL.md 是本体，
 * 消息是它的指针）。
 */
export function buildSopContinuationPrompt(ctx: SopContinuationContext): string {
  const { report } = ctx;
  const failure = report.failure;
  const skillDir = dirname(ctx.tracePath);
  const failedStep = failure?.stepIndex ?? -1;
  const remaining = report.stepCount - report.executedSteps;
  const lines = [
    `[AppCraft SOP 续跑] 回放「${ctx.skillId}」在第 ${failedStep + 1} 步（${failure?.action ?? '?'}）确定性执行失败：${failure?.reason ?? '未知原因'}。`,
    '',
    '这是预期内的执行路径，不是异常（app-automation 工作流三：SOP 模式）。请立即接手：',
    `1. 阅读 skill 本体：${join(skillDir, 'SKILL.md')}（目标 / 关键决策 / 参数 / 验收 / 已知坑）。`,
    `2. 前 ${report.executedSteps} 步已确定性完成，不要重复执行；从第 ${failedStep + 1} 步起，带着 SKILL.md 的知识用全智能完成剩余 ${remaining} 步（terminator/cuse 工具都在你手里）。`,
    '3. 高危步骤（删除/覆盖/外发类）必须先取得用户明确批准，不得擅自执行。',
    '4. 完成后按 SKILL.md「验收」一节自行核验；把这次的环境变化 / 新坑整理成「已知坑」回写建议，**先呈现给用户确认，确认后再写入**（宪章 §6.4）。',
  ];
  if (failure?.locator && Object.keys(failure.locator).length > 0) {
    lines.push('', `失败步骤的定位器（确定性通道失效的锚点）：${JSON.stringify(failure.locator)}`);
  }
  const varEntries = Object.entries(ctx.vars);
  if (varEntries.length > 0) {
    lines.push('', `本次回放变量：${varEntries.map(([k, v]) => `${k}=${v}`).join('，')}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Audit trail (§3 红线：续跑产出必须可审计)
// ---------------------------------------------------------------------------

export interface SopHealAuditEntry {
  ts: string;
  sessionId: string;
  skill: string;
  failedStep: number;
  action: string;
  reason: string;
  event: 'sop_continuation_started';
}

/** Injectable writer — production uses the default append; tests stay hermetic. */
export type SopHealAuditWriter = (path: string, line: string) => void;

function defaultAuditWriter(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line, 'utf-8');
}

/**
 * 追加一行审计到 `<workspace>/.appcraft/sop-heals.jsonl`。Best-effort：
 * 审计写失败只告警，绝不阻断 failure 报告的返回路径（但续跑注入也不应
 * 静默发生——写不进去时至少 unified log 留有 console.warn）。
 */
export function appendSopHealAudit(
  workspacePath: string,
  entry: SopHealAuditEntry,
  writer: SopHealAuditWriter = defaultAuditWriter,
): void {
  try {
    writer(join(workspacePath, '.appcraft', 'sop-heals.jsonl'), `${JSON.stringify(entry)}\n`);
  } catch (err) {
    console.warn(
      `[appcraft/sop-continuation] audit write failed for skill '${entry.skill}':`,
      err instanceof Error ? err.message : err,
    );
  }
}
