// ============= CRON TASK API =============
// Extracted from index.ts (1.1.7 ③ god-file strangler split — pure move).
// The three /cron/* route branches lived inside main()'s request handler;
// they are now standalone handlers. The only index-module-scope values they
// captured were `jsonResponse` and (execute only) the raw `agentDir` CLI arg,
// both passed in as parameters so no circular import with the entry is needed.

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
  getCurrentMcpServers,
  applyMcpOverrideAndAwaitReady,
  type ProviderEnv,
} from '../agent-session';

import { createSession, getSessionMetadata } from '../SessionStore';

import {
  decodeProviderEnvSnapshot,
  findAgentByWorkspacePath,
  findProvider,
  getAllMcpServers,
  getEffectiveMcpServers,
  isProviderDisabled,
  resolveProviderEnv,
} from '../utils/admin-config';

import { snapshotForOwnedSession } from '../utils/session-snapshot';

import { resolveSessionConfig } from '../utils/resolve-session-config';

import {
  ensureMetaLoopLine,
  getPiAgentState,
  getPiCurrentSessionRef,
  getPiMessages,
  invokePiSession,
} from '../loop/chat-engine';

import { isDistillArcPrompt } from '../memory/distill';

import { isResearchDistillArcPrompt } from '../memory/distill-research';

// 1.3.2 任务二 #5：cron 完成结论登记(task/list 行 conclusion 的数据源)。
import { recordTaskConclusion } from './task-conclusions';

import { resolveCronPermissionMode } from '../../shared/types/runtime';

import type { RuntimeConfig, RuntimeType } from '../../shared/types/runtime';

import type { McpServerDefinition } from '../../shared/config-types';

import type { AgentConfig } from '../../shared/types/agent';

import type { SessionMetadata } from '../types/session';

import type { PermissionMode } from '../index';

/** Matches index.ts's `jsonResponse(body, status?)` — injected to avoid a
 *  runtime circular import with the entry module. */
export type JsonResponseFn = (body: unknown, status?: number) => Response;

/**

 * #264 — Self-resolve the background-agent permission policy from disk for the

 * IM / Cron lanes. Desktop sends carry it in the chat payload (frontend is the

 * authority), but IM/Cron turns have no such payload, so per CLAUDE.md's

 * "Tab 由前端配, IM/Cron self-resolve 从磁盘读" split they read `config.json`

 * directly. Idempotent; defaults to the conservative 'inherit' on any read

 * error so a missing/corrupt config never widens the background lane.

 */

// M4c: background-agent 权限策略随 permission 体系删除(pi 引擎界内全自动)。



/**

 * PRD 0.2.9: live-resolve a per-task `providerId` into the value

 * `enqueueUserMessage` expects:

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

type CronExecutePayload = {

  taskId: string;

  prompt: string;

  /** Session ID for single_session mode (reuse existing session) */

  sessionId?: string;

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

   * provider env via `resolveProviderEnv(providerId)` at each tick — this

   * keeps API key rotation / provider switches in sync without

   * persisting credentials in the cron task. Mutually exclusive with

   * `providerEnv` (legacy explicit-snapshot path).

   *

   * Resolution outcomes:

   *   - provider not found / api-type with no apiKey → 400 (refuse to run,

   *     caller marks Task as Blocked)

   *   - api provider → effectiveProviderEnv = ResolvedProviderEnv object

   */

  providerId?: string;

  /**

   * PRD #119 / 0.2.9: explicit routing intent. Controls how the handler

   * resolves effective model + providerEnv when `providerId` is absent:

   *   - `'followAgent'` (default if absent) — snapshot-based, follows agent

   *   - `'explicit'`     — force `effectiveProviderEnv = payload.providerEnv`

   * Mirrors Rust's `cron_task::ProviderIntent`. New code prefers `providerId`.

   */

  providerIntent?: 'followAgent' | 'explicit';

  /**

   * Per-task MCP enable list override (PRD 0.2.4 §需求 4).

   * `undefined` = follow workspace MCP (`config.agents[].mcpEnabledServers`).

   * `[id, id, ...]` = enable only these MCP server ids for this task.

   * Sidecar applies via `setMcpServers()` before `enqueueUserMessage`.

   */

  mcpEnabledServers?: string[];

  /** Run mode: "single_session" (keep context) or "new_session" (fresh each time) */

  runMode?: 'single_session' | 'new_session';

  /** Task execution interval in minutes (for System Prompt context) */

  intervalMinutes?: number;

  /** Current execution number, 1-based (for System Prompt context) */

  executionNumber?: number;

};


export async function handleCronCheckCompletion(jsonResponse: JsonResponseFn): Promise<Response> {

        try {

          const messages = getPiMessages();

          const lastAssistantMessage = [...messages].reverse().find(m => m.role === 'assistant');



          if (!lastAssistantMessage) {

            return jsonResponse({ success: true, completed: false, reason: null });

          }



          // Extract text content from the message

          let textContent = '';

          // pi MessageWire.content 恒为 string(M4c 后无 ContentBlock 形态)。

          textContent = lastAssistantMessage.content;



          // Check for completion marker

          const completionMatch = textContent.match(CRON_TASK_COMPLETE_PATTERN);

          if (completionMatch) {

            return jsonResponse({

              success: true,

              completed: true,

              reason: completionMatch[1].trim()

            });

          }



          return jsonResponse({ success: true, completed: false, reason: null });

        } catch (error) {

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },

            500

          );

        }

}

export async function handleCronExecute(request: Request, jsonResponse: JsonResponseFn, agentDir: string): Promise<Response> {

        let payload: CronExecutePayload;

        try {

          payload = (await request.json()) as CronExecutePayload;

        } catch {

          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);

        }



        const { taskId, prompt, aiCanExit, model, providerEnv, intervalMinutes, executionNumber } = payload;



        if (!taskId || !prompt) {

          return jsonResponse({ success: false, error: 'taskId and prompt are required.' }, 400);

        }



        // Get current session ID for context isolation

        const currentSessionId = getSessionId();



        // Set cron task context so the exit_cron_task tool knows which task is running

        // Pass sessionId for proper isolation between concurrent tasks

        setCronTaskContext(taskId, aiCanExit ?? false, currentSessionId);



        // Set interaction scenario for cron task (L1 + L2-desktop + L3-cron)

        setInteractionScenario({

          type: 'cron',

          taskId,

          intervalMinutes: intervalMinutes ?? 15,

          aiCanExit: aiCanExit ?? false,

        });



        try {

          console.log(`[cron] execute taskId=${taskId} sessionId=${currentSessionId} interval=${intervalMinutes}min exec#=${executionNumber} aiCanExit=${aiCanExit ?? false} prompt="${prompt.slice(0, 100)}..."`);

          // Wrap cron prompt so AI recognizes it as system-triggered (not a real-time human message)

          const wrappedPrompt = `<system-reminder>\n<CRON_TASK>\n${prompt}\n</CRON_TASK>\n</system-reminder>`;



          // PRD #119: intent-driven resolution — see /cron/execute-sync for

          // the full design comment. This endpoint runs against whatever

          // session is already loaded (no session switch), so the snapshot

          // path operates on the current session's metadata. For Explicit

          // intents we bypass the snapshot entirely and use the

          // payload's values directly.

          // PRD 0.2.9: provider routing precedence:

          //   1. payload.providerId (new) — live-resolve from config.json on

          //      every tick. This is the path used by Task Center + the

          //      collapsed Launcher/Chat/IM-cron writers (PRD 0.2.9 R7).

          //   2. payload.providerIntent (legacy #119 path) — kept for in-flight

          //      cron tasks persisted by 0.2.8 and earlier.

          //   3. neither — followAgent (snapshot resolve from session meta).

          const intent = payload.providerIntent ?? 'followAgent';

          let effectiveModel = model;

          let effectiveProviderEnv: ProviderEnv | undefined = providerEnv;

          let effectiveRuntimeConfig = payload.runtimeConfig;



          if (payload.providerId) {

            // PRD 0.2.9 — Per-tick live-resolve. Throws on missing provider /

            // missing apiKey; we surface as 400 and let Rust mark Task Blocked.

            try {

              effectiveProviderEnv = resolveCronProviderRouting(payload.providerId);

            } catch (e) {

              const errMsg = e instanceof Error ? e.message : String(e);

              console.error(`[cron] execute: provider resolution failed for '${payload.providerId}': ${errMsg}`);

              clearCronTaskContext(currentSessionId);

              resetInteractionScenario();

              return jsonResponse({ success: false, error: errMsg }, 400);

            }

            if (payload.model) effectiveModel = payload.model;

            // Issue #204: defense-in-depth for tasks landing

            // on a non-followAgent intent. Always construct (not gated on

            // existence), and let canonical `runtimeConfig.model` win over

            // CLI-shorthand `payload.model` over any pre-existing value.

            effectiveRuntimeConfig = {

              ...(payload.runtimeConfig ?? {}),

              model: payload.runtimeConfig?.model ?? payload.model ?? effectiveRuntimeConfig?.model,

              permissionMode: payload.runtimeConfig?.permissionMode ?? payload.permissionMode ?? effectiveRuntimeConfig?.permissionMode,

            };

            console.log(`[cron] execute providerId=${payload.providerId} resolved=${effectiveProviderEnv?.baseUrl ?? 'anthropic'} model=${effectiveModel ?? 'default'}`);

          } else if (intent === 'followAgent') {

            if (currentSessionId) {

              const sessionMeta = getSessionMetadata(currentSessionId);

              const agent = findAgentByWorkspacePath(agentDir) as AgentConfig | undefined;

              if (sessionMeta && agent) {

                const resolved = resolveSessionConfig(sessionMeta, agent, undefined, 'owned');

                if (resolved.model !== undefined) effectiveModel = resolved.model;

                if (resolved.providerEnvJson) {

                  // Snapshot gate: disabled providers must not bypass the global enablement

                  // contract via stale providerEnvJson. decodeProviderEnvSnapshot returns

                  // undefined → caller fails loud (cron Task → Blocked at next layer).

                  const decoded = decodeProviderEnvSnapshot(resolved.providerEnvJson, resolved.providerId);

                  if (decoded) {

                    effectiveProviderEnv = decoded as ProviderEnv;

                  } else if (resolved.providerId && isProviderDisabled(resolved.providerId)) {

                    console.warn(`[cron] execute followAgent: provider ${resolved.providerId} is globally disabled — refusing frozen snapshot for session ${currentSessionId}`);

                  } else {

                    console.warn(`[cron] execute followAgent: failed to decode providerEnvJson for session ${currentSessionId}, falling back to task-frozen value`);

                  }

                } else if (resolved.providerId) {

                  // Issue #197 — agent persists `providerId` (post-PRD 0.2.9

                  // canonical state) but rarely a frozen `providerEnvJson`,

                  // so the snapshot path was dropping provider context for

                  // CLI/legacy crons that came in with intent=FollowAgent.

                  // Live-resolve env from providerId so the SDK gets the

                  // right ANTHROPIC_API_KEY/BASE_URL instead of falling

                  // back to no provider (apiKeySource=none, model=

                  // claude-sonnet-4-6 default).

                  try {

                    const env = resolveProviderEnv(resolved.providerId);

                    if (env) {

                      effectiveProviderEnv = env as ProviderEnv;

                      // Pair model with provider when neither snapshot nor

                      // agent has one — without this, SDK uses its default.

                      if (effectiveModel === undefined) {

                        const provider = findProvider(resolved.providerId);

                        const primary = provider

                          ? (provider as Record<string, unknown>).primaryModel as string | undefined

                          : undefined;

                        if (primary) effectiveModel = primary;

                      }

                    }

                  } catch (e) {

                    console.warn(`[cron] execute followAgent: failed to live-resolve providerId='${resolved.providerId}' for session ${currentSessionId}`, e);

                  }

                }

              }

            }

            // Backward-compat with the pre-#119 pragmatic fix — see /cron/execute-sync above.

            if (payload.model) effectiveModel = payload.model;

            if (payload.providerEnv) effectiveProviderEnv = payload.providerEnv;

          } else if (intent === 'explicit') {

            if (!payload.providerEnv) {

              console.error(`[cron] execute intent=explicit but payload.providerEnv is missing — refusing to run`);

              clearCronTaskContext(currentSessionId);

              resetInteractionScenario();

              return jsonResponse({

                success: false,

                error: 'Cron task has explicit provider intent but no providerEnv — task data is malformed.',

              }, 400);

            }

            effectiveProviderEnv = payload.providerEnv;

            if (payload.model) effectiveModel = payload.model;

            // Issue #204: defense-in-depth for tasks landing

            // on a non-followAgent intent. Always construct (not gated on

            // existence), and let canonical `runtimeConfig.model` win over

            // CLI-shorthand `payload.model` over any pre-existing value.

            effectiveRuntimeConfig = {

              ...(payload.runtimeConfig ?? {}),

              model: payload.runtimeConfig?.model ?? payload.model ?? effectiveRuntimeConfig?.model,

              permissionMode: payload.runtimeConfig?.permissionMode ?? payload.permissionMode ?? effectiveRuntimeConfig?.permissionMode,

            };

          }



          // Cron tasks are unattended — "user didn't pick" must map to the

          // runtime's MAX permission (not its interactive default), or

          // WebSearch / Bash / mcp__* sit in the approval queue until the

          // 10-minute deadline kills the run. Sentinels for "didn't pick" are

          // undefined and empty string. PRD 0.2.5 R2 / regression of 07bc560d.

          const effectivePermissionMode = resolveCronPermissionMode(

            payload.permissionMode,

            effectiveRuntimeConfig?.permissionMode,

            'builtin',

          );



          // M4c: backgroundAgentPermissionMode 随 permission 体系删除。

          // M4c: cron 会话执行迁移到 pi 引擎(原 SDK enqueueUserMessage)。
          // B2(1.2.6):改走独立 invoke 通道——不切引擎会话线、不进 steering
          // 队列(busy 时旧路径会把 cron prompt 注入用户正在进行的 turn)。
          // 「跟随当前选定环境的线」语义保留:目标线 = 引擎当前线的只读快照,
          // invoke 读其历史、跑完续存回同一条线(appendLoopMessages 文件锁
          // 串行化,与用户 turn 并发写不丢更新)。fire-and-forget(旧语义:
          // 端点只负责起跑,完成检测由调度方轮询)。
          const cronScenario = {
            type: 'cron' as const,
            taskId,
            intervalMinutes: intervalMinutes ?? 15,
            aiCanExit: aiCanExit ?? false,
          };
          const currentLine = getPiCurrentSessionRef();
          void invokePiSession(
            { text: wrappedPrompt, model: effectiveModel, providerEnv: effectiveProviderEnv, permissionMode: effectivePermissionMode },
            { loopSessionId: currentLine.loopSessionId, scenario: cronScenario },
          ).then((r) => {
            if (r.error) {
              console.warn(`[cron] execute taskId=${taskId} invoke 失败: ${r.error}`);
              recordTaskConclusion(taskId, r.error);
            } else {
              recordTaskConclusion(taskId, r.text);
            }
          }).catch((err) => console.error(`[cron] execute taskId=${taskId} invoke 异常:`, err));

          // Reset scenario after enqueue — already consumed at turn start

          resetInteractionScenario();

          return jsonResponse({ success: true });

        } catch (error) {

          // Clear context on error

          clearCronTaskContext(currentSessionId);

          resetInteractionScenario();

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },

            500

          );

        }

}

export async function handleCronExecuteSync(request: Request, jsonResponse: JsonResponseFn): Promise<Response> {

        console.log('[cron] execute-sync: endpoint matched');



        let payload: CronExecutePayload;

        try {

          payload = (await request.json()) as CronExecutePayload;

          console.log('[cron] execute-sync: payload parsed', { taskId: payload.taskId, hasPrompt: !!payload.prompt, runMode: payload.runMode });

        } catch (e) {

          console.error('[cron] execute-sync: JSON parse error', e);

          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);

        }



        const { taskId, prompt, sessionId, aiCanExit, model, providerEnv, runMode, intervalMinutes, executionNumber } = payload;



        if (!taskId || !prompt) {

          return jsonResponse({ success: false, error: 'taskId and prompt are required.' }, 400);

        }



        // Wrap the entire cron handler body in `withCronDispatchLock` so two

        // concurrent ticks within a single sidecar can't interleave on

        // shared global state — `currentMcpServers`, the active session,

        // `cronTaskContext`, `interactionScenario`. Without this, request

        // A's session switch / scenario could be silently overwritten by

        // request B before A reaches `enqueueUserMessage`. PRD 0.2.4 §3.6

        // (cross-review B7).

        return await withCronDispatchLock(async () => {

        // Handle session setup based on runMode

        const effectiveRunMode = runMode ?? 'single_session';

        const { agentDir } = getPiAgentState();



        // 蒸馏弧（工作生命宪章 §4.2）— 系统播种的内置 cron 任务带蒸馏哨兵，

        // 路由到确定性蒸馏管线（输入收集 → 单发 LLM → 合并写盘），不走普通

        // agent turn。动态 import 保持冷启动不为这条每日一次的路径付费。

        if (isDistillArcPrompt(prompt)) {

          const { runDistillArc } = await import('../memory/distill-runner');

          const distillResult = await runDistillArc({ workspacePath: agentDir, taskId });

          return jsonResponse(distillResult.body, distillResult.status);

        }



        // 安全蒸馏弧（安全研究员版 P1 D3，§1.4）— 与认知弧并列的独立弧：

        // 哨兵命中时路由到确定性安全蒸馏管线（未结算 research_events → 单发

        // LLM → keyed 覆盖写库 → 标记事件已蒸馏），不走普通 agent turn。

        if (isResearchDistillArcPrompt(prompt)) {

          const { runResearchDistillArc } = await import('../memory/distill-runner');

          const researchDistillResult = await runResearchDistillArc({ workspacePath: agentDir, taskId });

          return jsonResponse(researchDistillResult.body, researchDistillResult.status);

        }



        // Clear any existing cron context before switching sessions

        // This prevents context pollution when sessions change

        clearCronTaskContext();



        let effectiveSessionId = sessionId;

        // B2(1.2.6):本 tick 的目标 loop 线。cron 走 invokePiSession 独立
        // 通道,不再切引擎会话线——按 runMode 解析出目标线即可。
        let invokeLoopSessionId: string | undefined;



        if (effectiveRunMode === 'new_session') {

          // Create a fresh session for each execution (no memory of previous runs).

          // v0.1.69: Cron new_task ticks are structurally 'owned' — every tick reads the

          // current Agent and freezes a snapshot into the new SessionMetadata. Per-tick

          // freshness keeps "live-follow" semantics for cron without inventing a third

          // owner kind in resolveSessionConfig (PRD D4 footnote).

          const cronAgent = findAgentByWorkspacePath(agentDir) as AgentConfig | undefined;

          const cronSnapshot: Partial<SessionMetadata> = cronAgent ? snapshotForOwnedSession(cronAgent) : {};

          // PRD #119: stamp the cron's explicit routing intent into the

          // freshly-built snapshot. For Explicit intents,

          // the snapshot reflects the cron's own provider — NOT the agent's

          // — so other readers (session details panel, history view) see

          // an accurate record of what config the run actually used. This

          // also lets the unified `resolveSessionConfig` path read back the

          // right values without intent-aware branching at read time.

          // PRD 0.2.9 — When `providerId` is set on the payload, the

          // session metadata snapshot tracks it (so the resolved env can

                  // be re-derived per tick by the runtime resolver), and

          // pre-#119 fields are explicitly cleared. This precedence runs

          // BEFORE the legacy intent path below so a corrupt payload

          // carrying both `providerId` and `providerEnv` can't poison the

          // snapshot with the latter (Codex P2.1 finding).

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

          // PRD 0.2.4 §需求 4 — stamp per-task MCP override into the new

          // session's metadata BEFORE creation, so the session is born with

          // the right MCP set. The setMcpServers() call further down still

          // runs for safety, but for new_session mode it's typically a

          // no-op because the snapshot already matches the override.

          if (payload.mcpEnabledServers !== undefined) {

            cronSnapshot.mcpEnabledServers = payload.mcpEnabledServers;

          }

          // Rust rotates a fresh UUID per tick for new_session mode (see

          // cron_task.rs::rotate_new_session_id) and passes it as

          // payload.sessionId. Honour that id here — if we generated our

          // own instead, Rust's ManagedSidecar registry would be keyed by

          // the Rust-chosen id while the actual running session used a

          // different Bun-chosen id, and opening the session via history

          // would spawn a duplicate read-only sidecar (Bug A, v0.1.69).

          //

          // Fallback to a fresh random id only when payload.sessionId is

          // missing — keeps backward-compat with older Rust builds that

          // didn't pre-generate the id.

          if (sessionId) {

            cronSnapshot.id = sessionId;

          }

          const newSession = await createSession(agentDir, cronSnapshot);

          // B2(1.2.6):不再 switchPiSession 切引擎会话线——为新 meta 当场开
          // loop 线并把绑定写回 meta(ensureMetaLoopLine,B1 愈合的引擎无关
          // 版),invoke 通道直接对该新线跑,引擎单例全程不动。
          const newLine = await ensureMetaLoopLine(newSession.id);

          if (!newLine) {

            console.error(`[cron] execute-sync taskId=${taskId} failed to open loop line for new session ${newSession.id}`);

            return jsonResponse({ success: false, error: 'Failed to create new session for execution.' }, 500);

          }

          invokeLoopSessionId = newLine;

          effectiveSessionId = newSession.id;

          console.log(`[cron] execute-sync taskId=${taskId} new_session mode: created fresh session ${newSession.id} loop=${newLine} (from=${sessionId ? 'rust-payload' : 'bun-fallback'})`);

        } else if (sessionId) {

          // single_session mode: 解析任务存量会话的 loop 线(keep context)。
          // B2(1.2.6):不再切引擎——上下文延续由「invoke 读该线历史、续存回
          // 该线」承载;无绑定的 meta 当场愈合开新线(与 B1 同路径);meta
          // 不存在则回退引擎当前线(旧「switch 失败用当前会话」语义)。
          const loopLine = await ensureMetaLoopLine(sessionId);

          if (!loopLine) {

            console.warn(`[cron] execute-sync taskId=${taskId} session ${sessionId} not found, falling back to current session line`);

            const currentState = getPiAgentState();

            console.log(`[cron] execute-sync taskId=${taskId} current session state: agentDir=${currentState.agentDir}, sessionState=${currentState.sessionState}, hasInitialPrompt=${currentState.hasInitialPrompt}`);

            invokeLoopSessionId = getPiCurrentSessionRef().loopSessionId;

          } else {

            invokeLoopSessionId = loopLine;

            console.log(`[cron] execute-sync taskId=${taskId} single_session mode: invoke on session ${sessionId} (loop=${loopLine})`);

          }

        } else {

          // B2(1.2.6):无 sessionId —— 跟随引擎当前线(只读快照,不动引擎)。
          invokeLoopSessionId = getPiCurrentSessionRef().loopSessionId;

          console.log(`[cron] execute-sync taskId=${taskId} no sessionId provided, invoke on current line ${invokeLoopSessionId}`);

        }



        // ── Intent-driven resolution (PRD #119, 2026-05) ──────────────────

        //

        // Cron tasks declare their routing intent explicitly. Three branches:

        //

        //   - `explicit` — cron uses the captured `providerEnv` regardless of

        //     what the agent currently looks like. effectiveProviderEnv is

        //     forced to payload.providerEnv; agent's `providerEnvJson` is

        //     IGNORED. effectiveModel comes from payload.

        //

        //   - `explicit`     — cron uses its own captured providerEnv. Snapshot

        //     is bypassed entirely. effectiveModel + effectiveProviderEnv come

        //     from payload, atomic. (Pre-#119 the handler re-resolved from the

        //     agent snapshot, which silently overwrote providerEnv with the

        //     agent's even though model came from the cron — model+endpoint

        //     mismatch → 400 + silent empty output.)

        //

        //   - `followAgent`  — pre-#119 default. Read the session snapshot,

        //     fall back to agent for unset fields. Behavior preserved for

        //     legacy crons (those persisted before #119 deserialize as

        //     `followAgent` via serde default).

        //

        // The snapshot itself was already updated above for new_session mode

        // to match intent, so a future read still returns coherent values —

        // but we don't rely on that here; we drive directly from intent +

        // payload so single_session and new_session behave identically.

        //

        // permissionMode override is intent-independent: it overrides the

        // resolved value if payload.permissionMode is set, else falls back

        // to the resolver / runtime default.

        // PRD 0.2.9: provider routing precedence — see /cron/execute above

        // for the full design comment. providerId (new) > providerIntent

        // (legacy #119) > followAgent (default).

        const intent = payload.providerIntent ?? 'followAgent';



        let effectiveModel = model;

        let effectiveProviderEnv: ProviderEnv | undefined = providerEnv;

        let effectiveRuntimeConfig = payload.runtimeConfig;



        if (payload.providerId) {

          // PRD 0.2.9 — Per-tick live-resolve.

          try {

            effectiveProviderEnv = resolveCronProviderRouting(payload.providerId);

          } catch (e) {

            const errMsg = e instanceof Error ? e.message : String(e);

            console.error(`[cron] execute-sync: provider resolution failed for '${payload.providerId}': ${errMsg}`);

            clearCronTaskContext(effectiveSessionId);

            resetInteractionScenario();

            return jsonResponse({ success: false, error: errMsg }, 400);

          }

          if (payload.model) effectiveModel = payload.model;

          // Issue #204: defense-in-depth for tasks landing

          // on a non-followAgent intent. Always construct (not gated on

          // existence), and let canonical `runtimeConfig.model` win over

          // CLI-shorthand `payload.model` over any pre-existing value.

          effectiveRuntimeConfig = {

            ...(payload.runtimeConfig ?? {}),

            model: payload.runtimeConfig?.model ?? payload.model ?? effectiveRuntimeConfig?.model,

            permissionMode: payload.runtimeConfig?.permissionMode ?? payload.permissionMode ?? effectiveRuntimeConfig?.permissionMode,

          };

          console.log(`[cron] execute-sync providerId=${payload.providerId} resolved=${effectiveProviderEnv?.baseUrl ?? 'anthropic'} runMode=${effectiveRunMode} model=${effectiveModel ?? 'default'}`);

        } else if (intent === 'followAgent') {

          // Legacy snapshot-based resolution.

          const snapshotSessionId = effectiveSessionId ?? getSessionId();

          if (snapshotSessionId) {

            const sessionMeta = getSessionMetadata(snapshotSessionId);

            const agent = findAgentByWorkspacePath(agentDir) as AgentConfig | undefined;

            if (sessionMeta && agent) {

              const resolved = resolveSessionConfig(sessionMeta, agent, undefined, 'owned');

              if (resolved.model !== undefined) effectiveModel = resolved.model;

              if (resolved.providerEnvJson) {

                // Snapshot gate: see /cron/execute above. decodeProviderEnvSnapshot

                // refuses the snapshot when providerId is globally disabled.

                const decoded = decodeProviderEnvSnapshot(resolved.providerEnvJson, resolved.providerId);

                if (decoded) {

                  effectiveProviderEnv = decoded as ProviderEnv;

                } else if (resolved.providerId && isProviderDisabled(resolved.providerId)) {

                  console.warn(`[cron] execute-sync followAgent: provider ${resolved.providerId} is globally disabled — refusing frozen snapshot for session ${snapshotSessionId}`);

                } else {

                  console.warn(`[cron] execute-sync followAgent: failed to decode providerEnvJson for session ${snapshotSessionId}, falling back to task-frozen value`);

                }

              } else if (resolved.providerId) {

                // Issue #197 — see /cron/execute above for the full rationale.

                // Agent persists `providerId` (post-PRD 0.2.9 canonical state)

                // but rarely a frozen `providerEnvJson`. Live-resolve env from

                // providerId so the SDK gets the right credentials instead of

                // falling back to no provider with empty apiKey.

                try {

                  const env = resolveProviderEnv(resolved.providerId);

                  if (env) {

                    effectiveProviderEnv = env as ProviderEnv;

                    if (effectiveModel === undefined) {

                      const provider = findProvider(resolved.providerId);

                      const primary = provider

                        ? (provider as Record<string, unknown>).primaryModel as string | undefined

                        : undefined;

                      if (primary) effectiveModel = primary;

                    }

                  }

                } catch (e) {

                  console.warn(`[cron] execute-sync followAgent: failed to live-resolve providerId='${resolved.providerId}' for session ${snapshotSessionId}`, e);

                }

              }

              console.log(`[cron] execute-sync intent=followAgent session=${snapshotSessionId} runMode=${effectiveRunMode} snapshotLocked=${Boolean(sessionMeta.configSnapshotAt)} model=${effectiveModel ?? 'default'}`);

            }

          }

          // #119 followAgent backward-compat: pre-#119 the pragmatic fix

          // (commit 502f89c3) re-applied payload.model + payload.providerEnv

          // AFTER snapshot resolve so legacy crons that captured those at

          // schedule time still won the model+provider-bundle race against

          // a later-changed agent. We preserve that behavior here for any

          // cron that deserialized as `followAgent` (legacy default) but

          // still has explicit payload.* values — without it, those tasks

          // regress to following the agent snapshot they explicitly tried

          // to override.

          if (payload.model) effectiveModel = payload.model;

          if (payload.providerEnv) effectiveProviderEnv = payload.providerEnv;

        } else if (intent === 'explicit') {

          // Cron explicitly wants its captured provider — never inherit from agent.

          // payload.providerEnv MUST be present. A missing providerEnv with

          // explicit intent is a malformed task — fail closed rather than

          // silently routing the cron's model to a different upstream

          // (agent snapshot). This is the #119 root cause:

          // model and provider are an atomic routing bundle.

          if (!payload.providerEnv) {

            console.error(`[cron] execute-sync intent=explicit but payload.providerEnv is missing — refusing to run (would mismatch model+endpoint)`);

            clearCronTaskContext(effectiveSessionId);

            resetInteractionScenario();

            return jsonResponse({

              success: false,

              error: 'Cron task has explicit provider intent but no providerEnv — task data is malformed. Re-create the task.',

            }, 400);

          }

          effectiveProviderEnv = payload.providerEnv;

          if (payload.model) effectiveModel = payload.model;

          // Issue #204: defense-in-depth for tasks landing

          // on a non-followAgent intent. Always construct (not gated on

          // existence), and let canonical `runtimeConfig.model` win over

          // CLI-shorthand `payload.model` over any pre-existing value.

          effectiveRuntimeConfig = {

            ...(payload.runtimeConfig ?? {}),

            model: payload.runtimeConfig?.model ?? payload.model ?? effectiveRuntimeConfig?.model,

            permissionMode: payload.runtimeConfig?.permissionMode ?? payload.permissionMode ?? effectiveRuntimeConfig?.permissionMode,

          };

          // Type-narrow for the log: the explicit branch can only land on a

          // ProviderEnv object (assigned just above from `payload.providerEnv`,

          // which the early-return refuses to be undefined). Mirror the

          // shape used at the providerId branch for consistency, including

          // the `'anthropic'` fallback when `baseUrl` is omitted.

          console.log(`[cron] execute-sync intent=explicit runMode=${effectiveRunMode} model=${effectiveModel ?? 'default'} provider=${(effectiveProviderEnv as ProviderEnv | undefined)?.baseUrl ?? 'anthropic'}`);

        }



        // Permission mode override is intent-independent.

        if (payload.permissionMode) {

          effectiveRuntimeConfig = {

            ...(effectiveRuntimeConfig ?? {}),

            permissionMode: payload.permissionMode,

          };

        }



        // Set cron task context so the exit_cron_task tool knows which task is running

        // Pass sessionId for proper isolation between concurrent tasks

        setCronTaskContext(taskId, aiCanExit ?? false, effectiveSessionId);

        console.log(`[cron] execute-sync: cron context set for taskId=${taskId}`);



        // Set System Prompt append for cron task context

        // Set interaction scenario for cron task (L1 + L2-desktop + L3-cron)

        try {

          setInteractionScenario({

            type: 'cron',

            taskId,

            intervalMinutes: intervalMinutes ?? 15,

            aiCanExit: aiCanExit ?? false,

          });

          console.log('[cron] execute-sync: interaction scenario set');

        } catch (e) {

          console.error('[cron] execute-sync: error setting interaction scenario', e);

          clearCronTaskContext(effectiveSessionId);

          return jsonResponse({ success: false, error: `System prompt error: ${e}` }, 500);

        }



        try {

          console.log(`[cron] execute-sync taskId=${taskId} runMode=${effectiveRunMode} interval=${intervalMinutes}min exec#${executionNumber} aiCanExit=${aiCanExit ?? false} prompt="${prompt.slice(0, 100)}..."`);



          // Enqueue the message (this starts the async execution)

          // Wrap cron prompt so AI recognizes it as system-triggered (not a real-time human message)

          const wrappedPrompt = `<system-reminder>\n<CRON_TASK>\n${prompt}\n</CRON_TASK>\n</system-reminder>`;

          console.log('[cron] execute-sync: about to enqueue user message');



          let textContent = '';



          // PRD 0.2.5 R2 — unified "user didn't pick → runtime max" resolver.

          // Sentinels for "didn't pick" are undefined and empty string.

          // Concrete values (auto/plan/fullAgency/default/etc.) are respected

          // literally. See src/shared/types/runtime.ts::resolveCronPermissionMode.

          const effectivePermissionMode = resolveCronPermissionMode(

            payload.permissionMode,

            effectiveRuntimeConfig?.permissionMode,

            'builtin',

          );



          // ─── Builtin runtime (D20: external branch removed) ───

          {



            // PRD 0.2.4 §需求 4 — reconcile MCP set + run the turn under

            // a single locked critical section so two concurrent cron

            // ticks never interleave their abort/restart with each

            // other's in-flight turn (cross-review B5).

            //

            // Target MCP set:

            //   1. Task carries an override → apply that exact list.

            //   2. Task has no override ("follow Agent") → reconcile to

            //      the workspace's effective MCP. This is critical because

            //      `currentMcpServers` is module-global state that the

            //      previous task's override may have mutated. Without an

            //      explicit reset, "follow Agent" silently inherits the

            //      previous task's override (cross-review B1).

            //

            // The helper is fingerprint-gated, so when the desired set

            // already matches `currentMcpServers` it's a cheap no-op.

            let target: McpServerDefinition[];

            if (payload.mcpEnabledServers !== undefined) {

              const overrideIds = new Set(payload.mcpEnabledServers);

              // Prefer `currentMcpServers` (set by frontend's /api/mcp/set)

              // when its IDs cover all override IDs. Sidecar's

              // `getAllMcpServers()` and the renderer's mcpService produce

              // McpServerDefinition objects with subtly different env/args

              // shapes, and feeding sidecar-shaped definitions back through

              // `applyMcpOverrideAndAwaitReady` triggers a fingerprint

              // mismatch → abort+restart that wastes ~5s on the launcher

              // cron handoff. When the frontend already pushed shapes that

              // cover the override set, reusing those keeps the fingerprint

              // stable and the call becomes a cheap no-op.

              const fromCurrent = (getCurrentMcpServers() ?? []).filter(

                (s) => overrideIds.has(s.id),

              );

              if (fromCurrent.length === overrideIds.size) {

                target = fromCurrent;

              } else {

                const allServers = getAllMcpServers();

                target = allServers.filter((s) => overrideIds.has(s.id));

              }

              console.log(

                `[cron] execute-sync taskId=${taskId} applying task MCP override: [${

                  target.map((s) => s.id).join(',') || '(empty)'

                }]`,

              );

            } else {

              // No override → reconcile to workspace effective MCP so a

              // previous task's override doesn't leak into this run.

              target = getEffectiveMcpServers(agentDir);

            }



            // Apply MCP set first (this may abort + restart the session;

            // the outer `withCronDispatchLock` keeps two concurrent ticks

            // from interleaving across the abort/restart window).

            await applyMcpOverrideAndAwaitReady(target);



            // PRD 0.2.5 R2: effectivePermissionMode resolved above via

            // resolveCronPermissionMode.

            // T15: effectiveModel / effectiveProviderEnv come from the session snapshot

            //      (single_session) or payload defaults (new_session / fallback).

            // M4c: cron 同步执行迁移到 pi 引擎(send-and-wait,含完成等待)。
            // B2(1.2.6):改走 invokePiSession 独立通道——不碰引擎单例的会话/
            // steering/队列(旧路径 busy 时 cron prompt 会被当 steering 注入
            // 用户正在进行的 turn;send-and-wait 还可能在等待期间被用户的
            // turn 推进而错拿答案)。场景显式传入,不吃全局 scenario 时序。

            const piRun = await invokePiSession(

              { text: wrappedPrompt, model: effectiveModel, providerEnv: effectiveProviderEnv, permissionMode: effectivePermissionMode },

              {
                loopSessionId: invokeLoopSessionId,
                scenario: {
                  type: 'cron',
                  taskId,
                  intervalMinutes: intervalMinutes ?? 15,
                  aiCanExit: aiCanExit ?? false,
                },
                timeoutMs: 3600000,
              },

            );

            console.log('[cron] execute-sync: pi turn done, textLen:', piRun.text.length, 'error:', piRun.error ?? 'none');



            // pi send-and-wait 已含完成等待;超时/错误在此收尾。

            if (piRun.error) {

              console.warn(`[cron] execute-sync taskId=${taskId} failed: ${piRun.error}`);

              clearCronTaskContext(effectiveSessionId);

              resetInteractionScenario();

              return jsonResponse({ success: false, error: piRun.error }, 408);

            }

            textContent = piRun.text;

          }



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



          console.log(`[cron] execute-sync taskId=${taskId} completed, aiRequestedExit=${aiRequestedExit}, exitReason=${exitReason}`);

          // 1.3.2 任务二 #5：登记本 tick 结论(exitReason 优先,回落输出文本摘要;
          // task/list 行据此补 conclusion 字段)。
          recordTaskConclusion(taskId, exitReason ?? textContent ?? '');



          // Return the Sidecar session ID (our internal storage key) so Rust can

          // pass it to frontend for loading conversation data from our message store.
          // B2(1.2.6):cron 不再切引擎,getSessionId() 只作无 sessionId 分支的
          // 兜底;其余分支回报本 tick 解析出的任务会话(effectiveSessionId)。

          const actualSessionId = effectiveSessionId ?? getSessionId();



          const response = {

            success: true,

            aiRequestedExit,

            exitReason,

            outputText: textContent || undefined,

            sessionId: actualSessionId,

          };

          console.log(`[cron] execute-sync taskId=${taskId} returning response:`, JSON.stringify(response));

          return jsonResponse(response);

        } catch (error) {

          // Clear context on error

          clearCronTaskContext(effectiveSessionId);

          resetInteractionScenario();

          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          console.error(`[cron] execute-sync taskId=${taskId} error:`, error);

          const errorResponse = { success: false, error: errorMessage };

          console.log(`[cron] execute-sync taskId=${taskId} returning error response:`, JSON.stringify(errorResponse));

          return jsonResponse(errorResponse, 500);

        }

        }); // end withCronDispatchLock

}
