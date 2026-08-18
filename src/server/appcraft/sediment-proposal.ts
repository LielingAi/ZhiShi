/**
 * AppCraft sediment-proposal (P2b-1 回溯式沉淀入口, 宪章 §6.1/§6.2 学习循环):
 * 回合内 terminator/cuse 动作类工具调用的轻量追踪器 + 「存成 skill」提议的
 * 防抖判定。
 *
 * 存在论依据：宪章 §6.1「每次完成任务，都问一句：这个以后还会做吗？」——
 * 本模块回答的是"该不该问"，提问本身由前端 banner 完成，沉淀本身永远由
 * 用户确认后 agent 走 app-automation 工作流一完成（§8.4 禁止静默越权：
 * 这里只产出提议事件，绝不触发任何沉淀动作）。
 *
 * 与 recorder 的关系：recorder 只在用户显式「开始录制」时追踪；本模块始终
 * 追踪（开销 = 每 tool_use 块一次谓词判断 + Map set），与 recorder 共用同
 * 一份"动作类工具"口径（isAppcraftActionTool → mapToolCallToStep）。挂在
 * agent-session.ts 与录制钩子相同的三个位置：turn 开始重置、assistant
 * tool_use 记录、is_error tool_result 剔除（失败的选择器试探是噪声，与
 * dropRecordedStep 同一哲学）。
 *
 * 防抖红线（交接文档 §3 P2b-1）：同会话只提议一次。builtin 回合没有"任务"
 * 身份可挂靠，per-session-once 是满足"绝不重复骚扰"的最保守口径。
 *
 * State is module-level keyed by sessionId (Session : Sidecar = 1:1)，与
 * recorder 同一模式；纯函数 + 注入友好，跑在快速 unit vitest 池。
 */
import { getRecordingStatus, isAppcraftActionTool } from './recorder';

/** 提议门槛：本回合成功完成的动作类工具调用数（交接文档 §3：≥2）。 */
export const SEDIMENT_ACTION_THRESHOLD = 2;

export interface SedimentProposalInfo {
  /** 本回合捕获到的动作类工具调用数（展示给用户："包含 N 步应用操作"）。 */
  actionCount: number;
}

/** sessionId → (toolUseId → toolName)，只装本回合的动作类调用。 */
const turnActionTools = new Map<string, Map<string, string>>();

/** 已提议过的会话 —— 同会话防抖，只提一次。 */
const proposedSessions = new Set<string>();

/** 无 tool_use_id 时的合成 key 计数器（见 noteSedimentActionTool）。 */
let syntheticKeyCounter = 0;

/** Test-only: drop all tracking + debounce state (unit-pool isolation). */
export function resetSedimentProposalForTest(): void {
  turnActionTools.clear();
  proposedSessions.clear();
}

/** Turn-start hook: 清空上一回合的追踪（与 resetTurnUsage 同点调用）。 */
export function resetSedimentTurnTracking(sessionId: string): void {
  turnActionTools.delete(sessionId);
}

/**
 * Assistant tool_use hook: 记录一次动作类工具调用。非动作类工具（感知/
 * 生命周期/非 AppCraft）直接忽略。toolUseId 缺失时用合成 key，避免多次
 * 无 id 调用在 Map 里塌缩成一条。
 */
export function noteSedimentActionTool(
  sessionId: string,
  toolUseId: string | undefined,
  toolName: string,
): void {
  if (!isAppcraftActionTool(toolName)) return;
  let tools = turnActionTools.get(sessionId);
  if (!tools) {
    tools = new Map();
    turnActionTools.set(sessionId, tools);
  }
  tools.set(toolUseId ?? `noid-${++syntheticKeyCounter}`, toolName);
}

/**
 * tool_result is_error hook: 失败的调用从计数中剔除——失败的选择器试探
 * 不构成"成功完成的做法"（与 recorder 的 dropRecordedStep 同一过滤哲学）。
 */
export function dropSedimentActionTool(sessionId: string, toolUseId: string): void {
  turnActionTools.get(sessionId)?.delete(toolUseId);
}

/**
 * Turn-complete 判定：该不该向用户提议「存成 skill」。调用方负责另外两个
 * 门（回合成功完成 + desktop 交互场景）；这里只判三件事：
 *   1. 同会话没提议过（防抖红线）；
 *   2. 会话不在录制中（用户已在走显式录制流，再提议是噪声）；
 *   3. 本回合成功的动作类调用 ≥ SEDIMENT_ACTION_THRESHOLD。
 * 返回非空即提议，并把会话记入防抖集（只在真正提议时记，未达标不消耗名额）。
 */
export function evaluateSedimentProposal(sessionId: string): SedimentProposalInfo | null {
  if (proposedSessions.has(sessionId)) return null;
  if (getRecordingStatus(sessionId).recording) return null;
  const actionCount = turnActionTools.get(sessionId)?.size ?? 0;
  if (actionCount < SEDIMENT_ACTION_THRESHOLD) return null;
  proposedSessions.add(sessionId);
  return { actionCount };
}
