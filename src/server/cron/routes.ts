// ============= CRON TASK API =============
// Extracted from index.ts (1.1.7 ③ god-file strangler split — pure move).
// 1.5.4 起只剩 /cron/execute-sync 一条路由（Rust 调度器唯一调用入口）；
// /cron/execute 与 /cron/check-completion 已随 1.5.4 死路由清理删除（零调用方，
// handleCronExecute 成功路径不清 cronTaskContext 的问题随删除消失）。
import {
  setCronTaskContext,
  clearCronTaskContext,
  CRON_TASK_COMPLETE_PATTERN,
} from '../tools/cron-tools';
import {
  getSessionId,
  setInteractionScenario,
  resetInteractionScenario,
  withCronDispatchLock,
  type ProviderEnv,
} from '../agent-session';
import { createSession, getSessionMetadata } from '../SessionStore';
import {
  decodeProviderEnvSnapshot,
  findAgentByWorkspacePath,
  findProvider,
  isProviderDisabled,
  resolveProviderEnv,
} from '../utils/admin-config';
import { snapshotForOwnedSession } from '../utils/session-snapshot';
import { resolveSessionConfig } from '../utils/resolve-session-config';
import {
  ensureMetaLoopLine,
  getPiAgentState,
  getPiCurrentSessionRef,
  invokePiSession,
} from '../loop/chat-engine';
import { isDistillArcPrompt } from '../memory/distill';
import { isResearchDistillArcPrompt } from '../memory/distill-research';
// 1.3.2 任务二 #5：cron 完成结论登记(task/list 行 conclusion 的数据源)。
import { recordTaskConclusion } from './task-conclusions';
import { statSync } from 'node:fs';
import { workspacePathsEqual } from '../../shared/workspacePath';
import type { DistillArcResult } from '../memory/distill-runner';
import { resolveCronPermissionMode } from '../../shared/types/runtime';
import type { RuntimeConfig, RuntimeType } from '../../shared/types/runtime';
import type { AgentConfig } from '../../shared/types/agent';
import type { SessionMetadata } from '../types/session';
import type { PermissionMode } from '../index';
/** Matches index.ts's `jsonResponse(body, status?)` — injected to avoid a
 *  runtime circular import with the entry module. */
export type JsonResponseFn = (body: unknown, status?: number) => Response;
/**
 * PRD 0.2.9: live-resolve a per-task `providerId` into the ProviderEnv that
 * `invokePiSession` expects:
 *
 *   - api-type provider with apiKey      → ProviderEnv object
 *   - provider missing / api-type w/o key → throws (caller surfaces 400)
 */
function resolveCronProviderRouting(providerId: string): ProviderEnv {
  const provider = findProvider(providerId);
  if (!provider) {
    throw new Error(
      `Provider '${providerId}' not found in config — task references a provider that has been deleted. Re-select a provider in 任务编辑 → 高级配置.`,
    );
  }
  if (isProviderDisabled(providerId)) {
    throw new Error(
      `Provider '${providerId}' is disabled — re-enable it in 设置 → 模型供应商 → 启用和排序, or re-select a provider in 任务编辑 → 高级配置.`,
    );
  }
  const env = resolveProviderEnv(providerId);
  if (!env) {
    // Provider exists but has no apiKey configured.
    throw new Error(
      `Provider '${providerId}' has no API Key — open 设置 → 模型供应商 to configure it, or re-select a provider in 任务编辑 → 高级配置.`,
    );
  }
  return env;
}
// Cron task execution payload
// S5：导出给 `task/scheduler.ts` 的缺省执行器做字段映射（调度器 → 本路由）。
export type CronExecutePayload = {
  taskId: string;
  prompt: string;
  /** Session ID for single_session mode (reuse existing session) */
  sessionId?: string;
  /**
   * 本 tick 的工作区（S5 新增）。Rust 时代靠"每任务一个 cwd=任务 workspace 的
   * sidecar"隐式传工作区身份；下沉到 Node 后这条通道没了，只能显式带。
   * 空/目录不存在 → 回落到 sidecar 启动工作区（打 warn）。
   */
  workspacePath?: string;
  /**
   * Rust 每 tick 都发；服务端从不读（历史遗留字段）。S5 的调度器也发，
   * 仅为与旧 Rust 壳保持同一份 wire 形状。
   */
  isFirstExecution?: boolean;
  aiCanExit?: boolean;
  permissionMode?: PermissionMode;
  runtime?: RuntimeType;
  runtimeConfig?: RuntimeConfig;
  model?: string;
  providerEnv?: {
    baseUrl?: string;
    apiKey?: string;
    authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
    apiProtocol?: 'anthropic' | 'openai';
    maxOutputTokens?: number;
    maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
    upstreamFormat?: 'chat_completions' | 'responses';
  };
  /**
   * PRD 0.2.9: per-task provider id. When set, sidecar live-resolves the
   * provider env via `resolveProviderEnv(providerId)` at each tick — keeps
   * API key rotation / provider switches in sync without persisting
   * credentials. Mutually exclusive with `providerEnv` (legacy snapshot path).
   */
  providerId?: string;
  /**
   * PRD #119 / 0.2.9: explicit routing intent. Controls how the handler
   * resolves effective model + providerEnv when `providerId` is absent:
   *   - `'followAgent'` (default) — snapshot-based, follows agent
   *   - `'explicit'`     — force `effectiveProviderEnv = payload.providerEnv`
   */
  providerIntent?: 'followAgent' | 'explicit';
  /** Run mode: "single_session" (keep context) or "new_session" (fresh each time) */
  runMode?: 'single_session' | 'new_session';
  /** Task execution interval in minutes (for System Prompt context) */
  intervalMinutes?: number;
  /** Current execution number, 1-based (for System Prompt context) */
  executionNumber?: number;
};
// ============= 编排函数（S5） =============
//
// `runCronExecuteSync` 是**唯一的一 tick 执行入口**：HTTP 壳（给旧 Rust 调度器 /
// CLI 用）与 Node 侧调度器（`task/scheduler.ts` 的缺省执行器）共用它。
//
// 为什么必须抽出来：S5 之前它只能从 HTTP 调，而 Node 调度器要内调；照抄一份会
// 让"包 system-reminder / 解析会话线 / provider 优先级 / 派发锁"这些契约出现
// 两份实现，迟早分叉。这里把 HTTP 相关的东西（request.json / jsonResponse）留在
// 壳里，其余逐段原样搬进来。

/** 一 tick 的执行结果：HTTP 壳原样转成 `jsonResponse(body, status)`。 */
export interface CronExecuteResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * 可注入端口（缺省全部指向真实实现）。
 *
 * 为什么要端口化：单测要断言"蒸馏哨兵不创建会话""new/single 的会话解析"
 * "workspacePath 透传"，这些都不能真起引擎、真跑 turn（几十秒 + 要 API key）。
 * 全部是可选的，生产路径不传 = 行为与抽取前一致。
 */
export interface CronExecuteDeps {
  /** sidecar 启动工作区（缺省 `getPiAgentState().agentDir`）。 */
  getAgentDir?: () => string;
  createSession?: (agentDir: string, snapshot?: Partial<SessionMetadata>) => Promise<SessionMetadata>;
  ensureMetaLoopLine?: (metaId: string) => Promise<string | null>;
  invokePiSession?: typeof invokePiSession;
  runDistillArc?: (opts: { workspacePath: string; taskId?: string }) => Promise<DistillArcResult>;
  runResearchDistillArc?: (opts: { workspacePath: string; taskId?: string }) => Promise<DistillArcResult>;
  runWithArcLock?: <T>(fn: () => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false }>;
  logger?: CronLogger;
}

interface CronLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * 本 tick 的工作区（S5 的核心修复）。
 *
 * 背景：Rust 时代每个任务 tick 会开一个 **cwd = 任务 workspace** 的 sidecar，
 * 工作区身份是隐式传的。下沉到 Node 后这条通道没了 —— `cron/routes.ts` 一直用
 * `getPiAgentState().agentDir`（sidecar 的启动工作区），于是"任务在 A 工程跑、
 * 用的是 B 工程的 agent 快照/模型/provider/环境"：不报错，静默错。
 *
 * 现在的口径：
 *   - payload 带 `workspacePath` 且目录存在 → 用它（与启动工作区不同则 info 一行）
 *   - 空 / 目录不存在 → 回落启动工作区 + **warn**（不静默）
 */
function resolveTickWorkspace(
  requested: string | undefined,
  agentDir: string,
  log: CronLogger
): string {
  const want = typeof requested === 'string' ? requested.trim() : '';
  if (want === '') {
    log.warn(`[cron] 任务未声明工作区，沿用 sidecar 启动工作区 ${agentDir}`);
    return agentDir;
  }
  let isDir = false;
  try {
    isDir = statSync(want).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    log.warn(`[cron] 任务工作区不存在（${want}），沿用 sidecar 启动工作区 ${agentDir}`);
    return agentDir;
  }
  if (!workspacePathsEqual(want, agentDir)) {
    log.log(`[cron] 本 tick 使用任务工作区 ${want}（sidecar 启动工作区 ${agentDir}）`);
  }
  return want;
}

/**
 * 执行一 tick（会话线解析 → provider 解析 → invoke → 结论登记）。
 *
 * 调用方：`handleCronExecuteSync`（HTTP）与调度器缺省执行器（内调）。
 * 返回 `{status, body}` 而不是直接写响应 —— 内调方没有 Response。
 */
export async function runCronExecuteSync(
  payload: CronExecutePayload,
  deps: CronExecuteDeps = {}
): Promise<CronExecuteResult> {
  const log = deps.logger ?? console;
  const { taskId, prompt, sessionId, aiCanExit, model, providerEnv, runMode, intervalMinutes, executionNumber } =
    payload;
  if (!taskId || !prompt) {
    return { status: 400, body: { success: false, error: 'taskId and prompt are required.' } };
  }

  // 整段包在派发锁里：同一 sidecar 内两个 tick 不能交错（共享的是当前会话状态、
  // cronTaskContext、interactionScenario）。PRD 0.2.4 §3.6（交叉评审 B7）。
  return withCronDispatchLock(async () => {
    const agentDir = (deps.getAgentDir ?? (() => getPiAgentState().agentDir))();
    // S5：本 tick 的工作区意图。蒸馏弧 / agent 快照 / 新会话归属 / research_log
    // 锚点全部跟着它走，而不是跟着 sidecar 的启动工作区。
    const workspacePath = resolveTickWorkspace(payload.workspacePath, agentDir, log);

    // 蒸馏弧（工作生命宪章 §4.2）— 系统播种的内置 cron 任务带蒸馏哨兵，路由到
    // 确定性蒸馏管线，不走普通 agent turn。**必须在开任何会话之前**：这条路径
    // 不需要会话，先开会话等于每 tick 白造一个 meta + loop 线。
    if (isDistillArcPrompt(prompt)) {
      const runDistillArc =
        deps.runDistillArc ??
        (async (opts: { workspacePath: string; taskId?: string }) =>
          (await import('../memory/distill-runner')).runDistillArc(opts));
      const runWithArcLock =
        deps.runWithArcLock ?? (await import('../memory/distill-scheduler')).runWithArcLock;
      // 2.0.7：与 sidecar 定时器共锁——同一弧不并发两份。
      const locked = await runWithArcLock(() => runDistillArc({ workspacePath, taskId }));
      if (!locked.ok) return { status: 200, body: { success: true, skipped: 'arc-locked' } };
      return { status: locked.value.status, body: locked.value.body };
    }

    // 安全蒸馏弧（安全研究员版 P1 D3，§1.4）— 与认知弧并列的独立弧。
    if (isResearchDistillArcPrompt(prompt)) {
      const runResearchDistillArc =
        deps.runResearchDistillArc ??
        (async (opts: { workspacePath: string; taskId?: string }) =>
          (await import('../memory/distill-runner')).runResearchDistillArc(opts));
      const runWithArcLock =
        deps.runWithArcLock ?? (await import('../memory/distill-scheduler')).runWithArcLock;
      const locked = await runWithArcLock(() => runResearchDistillArc({ workspacePath, taskId }));
      if (!locked.ok) return { status: 200, body: { success: true, skipped: 'arc-locked' } };
      return { status: locked.value.status, body: locked.value.body };
    }

    // Clear any existing cron context before switching sessions
    // This prevents context pollution when sessions change
    clearCronTaskContext();

    let effectiveSessionId = sessionId;
    // B2(1.2.6):本 tick 的目标 loop 线。cron 走 invokePiSession 独立通道,
    // 不再切引擎会话线——按 runMode 解析出目标线即可。
    let invokeLoopSessionId: string | undefined;

    const runModeValue = runMode ?? 'single_session';
    const createSessionFn = deps.createSession ?? createSession;
    const ensureMetaLoopLineFn = deps.ensureMetaLoopLine ?? ensureMetaLoopLine;

    if (runModeValue === 'new_session') {
      // Create a fresh session for each execution (no memory of previous runs).
      // v0.1.69: Cron new_task ticks are structurally 'owned' — every tick reads the
      // current Agent and freezes a snapshot into the new SessionMetadata. Per-tick
      // freshness keeps "live-follow" semantics for cron without inventing a third
      // owner kind in resolveSessionConfig (PRD D4 footnote).
      //
      // S5：快照按 **任务工作区** 找 agent（不是启动工作区）——否则 A 工程的任务
      // 会继承 B 工程的模型/provider 快照，正是"静默错"的那一半。
      const cronAgent = findAgentByWorkspacePath(workspacePath) as AgentConfig | undefined;
      const cronSnapshot: Partial<SessionMetadata> = cronAgent ? snapshotForOwnedSession(cronAgent) : {};
      // PRD 0.2.9 — When `providerId` is set on the payload, the session metadata
      // snapshot tracks it (so the resolved env can be re-derived per tick), and
      // pre-#119 fields are explicitly cleared. This precedence runs BEFORE the
      // legacy intent path below so a corrupt payload carrying both `providerId`
      // and `providerEnv` can't poison the snapshot with the latter (Codex P2.1).
      if (payload.providerId) {
        cronSnapshot.providerId = payload.providerId;
        cronSnapshot.providerEnvJson = undefined;
        if (payload.model) cronSnapshot.model = payload.model;
      } else {
        const cronIntent = payload.providerIntent ?? 'followAgent';
        if (cronIntent === 'explicit' && payload.providerEnv) {
          cronSnapshot.providerId = undefined;
          cronSnapshot.providerEnvJson = JSON.stringify(payload.providerEnv);
          if (payload.model) cronSnapshot.model = payload.model;
        }
        // FollowAgent (legacy): cronSnapshot keeps the agent's values verbatim.
      }
      // D20: builtin is the only runtime. An explicit per-task override is
      // preserved on disk verbatim (config compat) but ignored at run time.
      if (payload.runtime) cronSnapshot.runtime = payload.runtime;
      // Rust rotates a fresh UUID per tick for new_session mode and passes it as
      // payload.sessionId. Honour that id here — if we generated our own instead,
      // the registry would be keyed by a different id than the running session
      // (Bug A, v0.1.69). Fallback to a fresh id only when payload.sessionId is
      // missing (older Rust builds).
      if (sessionId) {
        cronSnapshot.id = sessionId;
      }
      // S5：新会话的归属目录 = 任务工作区（否则会话落在启动工作区里）。
      const newSession = await createSessionFn(workspacePath, cronSnapshot);
      const newLine = await ensureMetaLoopLineFn(newSession.id);
      if (!newLine) {
        log.error(`[cron] execute-sync taskId=${taskId} failed to open loop line for new session ${newSession.id}`);
        return { status: 500, body: { success: false, error: 'Failed to create new session for execution.' } };
      }
      invokeLoopSessionId = newLine;
      effectiveSessionId = newSession.id;
      log.log(
        `[cron] execute-sync taskId=${taskId} new_session mode: created fresh session ${newSession.id} loop=${newLine} workspace=${workspacePath} (from=${sessionId ? 'payload' : 'fallback'})`
      );
    } else if (sessionId) {
      // single_session mode: 解析任务存量会话的 loop 线(keep context)。
      // B2(1.2.6):不再切引擎——上下文延续由「invoke 读该线历史、续存回该线」
      // 承载;无绑定的 meta 当场愈合开新线(与 B1 同路径);meta 不存在则回退引擎
      // 当前线(旧「switch 失败用当前会话」语义)。
      const loopLine = await ensureMetaLoopLineFn(sessionId);
      if (!loopLine) {
        log.warn(
          `[cron] execute-sync taskId=${taskId} session ${sessionId} not found, falling back to current session line`
        );
        invokeLoopSessionId = getPiCurrentSessionRef().loopSessionId;
      } else {
        invokeLoopSessionId = loopLine;
        log.log(`[cron] execute-sync taskId=${taskId} single_session mode: invoke on session ${sessionId} (loop=${loopLine})`);
      }
    } else {
      // B2(1.2.6):无 sessionId —— 跟随引擎当前线(只读快照,不动引擎)。
      invokeLoopSessionId = getPiCurrentSessionRef().loopSessionId;
      log.log(`[cron] execute-sync taskId=${taskId} no sessionId provided, invoke on current line ${invokeLoopSessionId}`);
    }

    // ── Intent-driven resolution (PRD #119 / 0.2.9) ──────────────────
    //
    // provider 优先级：providerId（新）> providerIntent（legacy #119）> followAgent（缺省）。
    //   1. payload.providerId — 每 tick 从 config.json 现场解析（凭据轮换/换 provider
    //      无需重存，任务里不留凭据副本）。
    //   2. payload.providerIntent — 0.2.8 及更早写入的 in-flight 任务用。
    //   3. neither — followAgent（按会话快照解析）。
    const intent = payload.providerIntent ?? 'followAgent';
    let effectiveModel = model;
    let effectiveProviderEnv: ProviderEnv | undefined = providerEnv;
    let effectiveRuntimeConfig = payload.runtimeConfig;

    if (payload.providerId) {
      try {
        effectiveProviderEnv = resolveCronProviderRouting(payload.providerId);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        log.error(`[cron] execute-sync: provider resolution failed for '${payload.providerId}': ${errMsg}`);
        clearCronTaskContext(effectiveSessionId);
        resetInteractionScenario();
        // 错误串以 `Provider '` 开头是契约：调度器靠这个前缀把任务转 blocked
        // （Rust task_scheduler.rs 的 is_provider_resolution_failure 同款判定）。
        return { status: 400, body: { success: false, error: errMsg } };
      }
      if (payload.model) effectiveModel = payload.model;
      // 1.5.4(A3-5)：runtimeConfig.model 是 write-only 死存储（全函数只读
      // permissionMode），已删除——model 只走 effectiveModel。
      effectiveRuntimeConfig = {
        ...(payload.runtimeConfig ?? {}),
        permissionMode:
          payload.runtimeConfig?.permissionMode ?? payload.permissionMode ?? effectiveRuntimeConfig?.permissionMode,
      };
      log.log(
        `[cron] execute-sync providerId=${payload.providerId} resolved=${effectiveProviderEnv?.baseUrl ?? 'anthropic'} runMode=${runModeValue} model=${effectiveModel ?? 'default'}`
      );
    } else if (intent === 'followAgent') {
      // Legacy snapshot-based resolution.
      const snapshotSessionId = effectiveSessionId ?? getSessionId();
      if (snapshotSessionId) {
        const sessionMeta = getSessionMetadata(snapshotSessionId);
        // S5：按任务工作区找 agent（见 new_session 分支的同类说明）。
        const agent = findAgentByWorkspacePath(workspacePath) as AgentConfig | undefined;
        if (sessionMeta && agent) {
          const resolved = resolveSessionConfig(sessionMeta, agent, undefined, 'owned');
          if (resolved.model !== undefined) effectiveModel = resolved.model;
          if (resolved.providerEnvJson) {
            // Snapshot gate: disabled providers must not bypass the global
            // enablement contract via stale providerEnvJson.
            const decoded = decodeProviderEnvSnapshot(resolved.providerEnvJson, resolved.providerId);
            if (decoded) {
              effectiveProviderEnv = decoded as ProviderEnv;
            } else if (resolved.providerId && isProviderDisabled(resolved.providerId)) {
              log.warn(
                `[cron] execute-sync followAgent: provider ${resolved.providerId} is globally disabled — refusing frozen snapshot for session ${snapshotSessionId}`
              );
            } else {
              log.warn(
                `[cron] execute-sync followAgent: failed to decode providerEnvJson for session ${snapshotSessionId}, falling back to task-frozen value`
              );
            }
          } else if (resolved.providerId) {
            // Issue #197 — agent persists `providerId` but rarely a frozen
            // `providerEnvJson`, so the snapshot path was dropping provider
            // context. Live-resolve env from providerId.
            try {
              const env = resolveProviderEnv(resolved.providerId);
              if (env) {
                effectiveProviderEnv = env as ProviderEnv;
                if (effectiveModel === undefined) {
                  const provider = findProvider(resolved.providerId);
                  const primary = provider
                    ? ((provider as Record<string, unknown>).primaryModel as string | undefined)
                    : undefined;
                  if (primary) effectiveModel = primary;
                }
              }
            } catch (e) {
              log.warn(
                `[cron] execute-sync followAgent: failed to live-resolve providerId='${resolved.providerId}' for session ${snapshotSessionId}`,
                e
              );
            }
          }
          log.log(
            `[cron] execute-sync intent=followAgent session=${snapshotSessionId} runMode=${runModeValue} snapshotLocked=${Boolean(sessionMeta.configSnapshotAt)} model=${effectiveModel ?? 'default'}`
          );
        }
      }
      // #119 followAgent backward-compat: pre-#119 the pragmatic fix (commit
      // 502f89c3) re-applied payload.model + payload.providerEnv AFTER snapshot
      // resolve so legacy crons that captured those at schedule time still won
      // the model+provider-bundle race against a later-changed agent.
      if (payload.model) effectiveModel = payload.model;
      if (payload.providerEnv) effectiveProviderEnv = payload.providerEnv;
    } else if (intent === 'explicit') {
      // Cron explicitly wants its captured provider — never inherit from agent.
      // payload.providerEnv MUST be present; a missing one is a malformed task →
      // fail closed rather than silently routing the cron's model to a different
      // upstream (#119 root cause).
      if (!payload.providerEnv) {
        log.error(
          '[cron] execute-sync intent=explicit but payload.providerEnv is missing — refusing to run (would mismatch model+endpoint)'
        );
        clearCronTaskContext(effectiveSessionId);
        resetInteractionScenario();
        return {
          status: 400,
          body: {
            success: false,
            error:
              'Cron task has explicit provider intent but no providerEnv — task data is malformed. Re-create the task.',
          },
        };
      }
      effectiveProviderEnv = payload.providerEnv;
      if (payload.model) effectiveModel = payload.model;
      // 1.5.4(A3-5)：同 providerId 分支——只保留 permissionMode 归并。
      effectiveRuntimeConfig = {
        ...(payload.runtimeConfig ?? {}),
        permissionMode:
          payload.runtimeConfig?.permissionMode ?? payload.permissionMode ?? effectiveRuntimeConfig?.permissionMode,
      };
      log.log(
        `[cron] execute-sync intent=explicit runMode=${runModeValue} model=${effectiveModel ?? 'default'} provider=${(effectiveProviderEnv as ProviderEnv | undefined)?.baseUrl ?? 'anthropic'}`
      );
    }

    // Permission mode override is intent-independent.
    if (payload.permissionMode) {
      effectiveRuntimeConfig = {
        ...(effectiveRuntimeConfig ?? {}),
        permissionMode: payload.permissionMode,
      };
    }

    // Set cron task context so the cron exit 判定链(handleCronExit/permission gate)知道当前任务
    setCronTaskContext(taskId, aiCanExit ?? false, effectiveSessionId);

    // Set interaction scenario for cron task (L1 + L2-desktop + L3-cron)
    try {
      setInteractionScenario({
        type: 'cron',
        taskId,
        intervalMinutes: intervalMinutes ?? 15,
        aiCanExit: aiCanExit ?? false,
      });
    } catch (e) {
      log.error('[cron] execute-sync: error setting interaction scenario', e);
      clearCronTaskContext(effectiveSessionId);
      return { status: 500, body: { success: false, error: `System prompt error: ${e}` } };
    }

    try {
      log.log(
        `[cron] execute-sync taskId=${taskId} runMode=${runModeValue} interval=${intervalMinutes}min exec#${executionNumber} aiCanExit=${aiCanExit ?? false} workspace=${workspacePath} prompt="${prompt.slice(0, 100)}..."`
      );

      // Wrap cron prompt so AI recognizes it as system-triggered (not a real-time human message)
      const wrappedPrompt = `<system-reminder>\n<CRON_TASK>\n${prompt}\n</CRON_TASK>\n</system-reminder>`;

      // PRD 0.2.5 R2 — unified "user didn't pick → runtime max" resolver.
      const effectivePermissionMode = resolveCronPermissionMode(
        payload.permissionMode,
        effectiveRuntimeConfig?.permissionMode,
        'builtin',
      );

      // M4c: cron 同步执行走 pi 引擎(send-and-wait,含完成等待)。
      // B2(1.2.6):走 invokePiSession 独立通道——不碰引擎单例的会话/steering/队列。
      const invoke = deps.invokePiSession ?? invokePiSession;
      const piRun = await invoke(
        {
          text: wrappedPrompt,
          model: effectiveModel,
          providerEnv: effectiveProviderEnv,
          permissionMode: effectivePermissionMode,
        },
        {
          loopSessionId: invokeLoopSessionId,
          scenario: {
            type: 'cron',
            taskId,
            intervalMinutes: intervalMinutes ?? 15,
            aiCanExit: aiCanExit ?? false,
          },
          timeoutMs: 3600000,
          // S5：research_log 事件归属锚也必须是任务工作区。缺这个参数，headless
          // 线会落到引擎自己的 agentDir（对 cron 就是 sidecar 启动工作区），
          // 于是 A 工程任务的研究档案被戳到 B 工程名下 —— 报告导出/空转检测
          // 按工作区过滤时永远 0 条。
          workspaceAnchor: workspacePath,
          // S6：**环境锚**也换成任务工作区。上面那个只解决 research_log 归属；
          // envs 解析（env-sessions 映射 + 工作区环境选定）原来吃引擎的
          // `this.agentDir` —— 任务在 A、sidecar 起在 B 时 env_exec/env_bg 会挂到
          // B 的环境上，占用登记也跟着错（不报错、静默错）。
          workspace: workspacePath,
        },
      );

      // pi send-and-wait 已含完成等待;超时/错误在此收尾。
      if (piRun.error) {
        log.warn(`[cron] execute-sync taskId=${taskId} failed: ${piRun.error}`);
        clearCronTaskContext(effectiveSessionId);
        resetInteractionScenario();
        return { status: 408, body: { success: false, error: piRun.error } };
      }

      const textContent = piRun.text;

      // Check if AI requested exit (works for both runtimes — checks text patterns)
      let aiRequestedExit = false;
      let exitReason: string | undefined;
      if (textContent) {
        const completionMatch = textContent.match(CRON_TASK_COMPLETE_PATTERN);
        if (completionMatch) {
          aiRequestedExit = true;
          exitReason = completionMatch[1].trim();
        }
      }

      // Clear cron task context after execution
      clearCronTaskContext(effectiveSessionId);
      // Reset scenario — already consumed by startStreamingSession() at session creation
      resetInteractionScenario();

      log.log(`[cron] execute-sync taskId=${taskId} completed, aiRequestedExit=${aiRequestedExit}, exitReason=${exitReason}`);

      // 1.3.2 任务二 #5：登记本 tick 结论(exitReason 优先,回落输出文本摘要;
      // task/list 行据此补 conclusion 字段)。
      recordTaskConclusion(taskId, exitReason ?? textContent ?? '');

      // Return the session ID (our internal storage key).
      // B2(1.2.6):cron 不再切引擎,getSessionId() 只作无 sessionId 分支的兜底。
      const actualSessionId = effectiveSessionId ?? getSessionId();

      return {
        status: 200,
        body: {
          success: true,
          aiRequestedExit,
          exitReason,
          outputText: textContent || undefined,
          sessionId: actualSessionId,
        },
      };
    } catch (error) {
      // Clear context on error
      clearCronTaskContext(effectiveSessionId);
      resetInteractionScenario();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error(`[cron] execute-sync taskId=${taskId} error:`, error);
      return { status: 500, body: { success: false, error: errorMessage } };
    }
  }); // end withCronDispatchLock
}

/**
 * HTTP 壳 —— 只做 `request.json()` + `jsonResponse`。
 *
 * 保留它是因为旧 Rust 调度器 / 外部调用方仍走 `/cron/execute-sync`；Node 侧
 * 调度器直接调 `runCronExecuteSync`，不经过 HTTP。
 */
export async function handleCronExecuteSync(request: Request, jsonResponse: JsonResponseFn): Promise<Response> {
  let payload: CronExecutePayload;
  try {
    payload = (await request.json()) as CronExecutePayload;
    console.log('[cron] execute-sync: payload parsed', {
      taskId: payload.taskId,
      hasPrompt: !!payload.prompt,
      runMode: payload.runMode,
      workspacePath: payload.workspacePath,
    });
  } catch (e) {
    console.error('[cron] execute-sync: JSON parse error', e);
    return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
  }
  const result = await runCronExecuteSync(payload);
  return jsonResponse(result.body, result.status);
}
