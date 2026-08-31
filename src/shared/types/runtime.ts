// Multi-Agent Runtime types (v0.1.59)

// Defines runtime types and metadata for external CLI agent integration



/**

 * Available Agent Runtime types

 * - builtin: Built-in Claude 智能体 SDK (current default)

 * - claude-code: Claude Code CLI (user-installed `claude`)

 * - codex: OpenAI Codex CLI (user-installed `codex`)

 * - gemini: Google Gemini CLI in ACP mode (user-installed `gemini`, v0.1.66+)

 */

export type RuntimeType = 'builtin' | 'claude-code' | 'codex' | 'gemini';



/**

 * Canonical runtime type list — single source of truth.

 *

 * Used by:

 *   - Server-side validation (admin-api.ts task creation guards).

 *   - CLI help-text generation (admin-api.ts HELP_TEXTS).

 *   - Factory / runtime switch statements.

 *

 * Adding a runtime? Update the `RuntimeType` union above, then extend

 * this tuple. The `_exhaustiveRuntimeCheck` helper below makes typecheck

 * fail if the two drift — so you don't get a stale list that compiles

 * silently and produces an incomplete `--help` / validator allowlist.

 */

export const VALID_RUNTIMES = [

  'builtin',

  'claude-code',

  'codex',

  'gemini',

] as const satisfies readonly RuntimeType[];



/**

 * Compile-time exhaustiveness gate: fails `npm run typecheck` if a new

 * `RuntimeType` variant is added to the union without adding the same string

 * to `VALID_RUNTIMES`. The type-level assertion at the bottom never runs at

 * runtime — it just blocks the build on drift.

 */

type _VALID_RUNTIMES_UNION = (typeof VALID_RUNTIMES)[number];

type _AssertRuntimeExhaustive = RuntimeType extends _VALID_RUNTIMES_UNION

  ? _VALID_RUNTIMES_UNION extends RuntimeType

    ? true

    : ['VALID_RUNTIMES has strings not in RuntimeType']

  : ['RuntimeType has variants missing from VALID_RUNTIMES'];

// 编译期断言：VALID_RUNTIMES 与 RuntimeType 漂移时上面的类型断言会让 typecheck 失败。

// 无运行期消费者，故不导出（tsconfig 未开 noUnusedLocals，模块内保留即可）。

const _exhaustiveRuntimeCheck: _AssertRuntimeExhaustive = true;



/**
 * Coerce an arbitrary string (agent config value, persisted state, env) into a
 * valid `RuntimeType`, defaulting to `'builtin'` for missing/unknown values.
 *
 * 唯一实现，供 server / CLI / GUI 共同消费。
 */

export function normalizeRuntime(value: string | null | undefined): RuntimeType {

  return VALID_RUNTIMES.includes(value as RuntimeType) ? (value as RuntimeType) : 'builtin';

}



/**

 * Resolve the **agent-config** effective runtime, gated by the `multiAgentRuntime`

 * developer flag: when it is OFF, everything collapses to `builtin` regardless of

 * the agent's configured runtime.

 *

 * SCOPE — this is the spawn runtime for a NEW session (and the pre-session

 * fallback), NOT the authoritative runtime of an EXISTING session. It mirrors

 * only the **config fallback** leg of the Rust spawn decision in

 * `src-tauri/src/sidecar.rs::resolve_agent_runtime_from_config` (gate check +

 * builtin fallback). The Rust spawn path for an existing Tab/Cron sidecar

 * resolves `resolve_session_runtime(session_id)` FIRST (the frozen runtime the

 * session was created with), and only falls back to agent config when there is

 * no session yet. That frozen value — surfaced to the frontend as

 * `chat:system-init.payload.runtime` / session metadata — is what the

 * server-side `ai_turn_complete.runtime` reports.

 *

 * Therefore **session-scoped analytics** (`session_new` / `message_send` /

 * `message_complete` / `history_open`) MUST prefer the frozen session runtime

 * (`sessionRuntime ?? resolveEffectiveRuntime(agentConfig, gate)`, the canonical

 * precedence in `Chat.tsx` `currentRuntime`); using this helper alone would

 * diverge from `ai_turn_complete` once a user changes an agent's runtime after

 * session creation. Only genuinely config-level callers (`workspace_open` for a

 * brand-new session, `app_launch` adoption snapshot) may use this directly.

 *

 * Keep the gate + builtin-fallback semantics in sync with the Rust function

 * above (and vice-versa).

 */

export function resolveEffectiveRuntime(

  agentRuntime: string | null | undefined,

  multiAgentRuntimeEnabled: boolean,

): RuntimeType {

  if (!multiAgentRuntimeEnabled) return 'builtin';

  return normalizeRuntime(agentRuntime);

}



/**

 * Structured hint for recoverable CLI errors.

 *

 * Emitted by Admin-API handlers when they reject a request for a reason that

 * the caller (AI agent or human) can fix by running one more command. The CLI

 * surfaces `recoveryCommand` as `→ Run: <cmd>` under the error line so the

 * reader can copy-paste to correct course without digging through --help.

 *

 * Design note: kept separate from the existing `AdminResponse.hint: string`

 * field — that one is a free-form success tip ("Server added."), this one is

 * specifically about recovering from failure.

 */

export interface RecoveryHint {

  /** Exact CLI command that will help the caller retry correctly. */

  recoveryCommand?: string;

  /** Short explanatory text shown alongside the command. */

  message?: string;

}



/**

 * Proxy policy for external-runtime subprocess env (issue #194).

 *

 * - `zhishi` (default, legacy) — ZhiShi unconditionally injects its own

 *    `proxySettings` into the runtime's env, overriding whatever the parent

 *    shell or system has configured. Best for "ZhiShi proxy is THE proxy"

 *    setups.

 * - `terminal` — Drop ZhiShi-injected proxy vars; restore whatever proxy

 *    the user's interactive shell would export (HTTP_PROXY / HTTPS_PROXY /

 *    ALL_PROXY / NO_PROXY, lowercase + UPPERCASE). Best for "I run codex /

 *    claude from terminal and want ZhiShi to behave the same."

 * - `direct` — Strip all proxy vars. Best when system-level proxy (Clash

 *    TUN, transparent proxy) handles routing.

 */

export type RuntimeProxyPolicy = 'zhishi' | 'terminal';



/**

 * Per-agent env policy for external-runtime subprocesses (issue #194).

 *

 * Today only `proxy` matters; the structure is extensible because the same

 * dimension (override vs inherit) is likely to apply to other env surfaces

 * (locale, XDG, custom Codex-specific env) as needs surface.

 *

 * Historical note: 0.2.16 dev shipped a third `'direct'` literal that stripped

 * every proxy var (for users on Clash TUN / VPN). It was removed before

 * 0.2.16 release — the UI was confusing and `'terminal'` already covers the

 * case (a user on TUN typically has no proxy var set in their shell, so

 * `terminal` mode = no proxy injected = same result). Disk values of

 * `'direct'` on existing installs fall through `resolveAgentEnvPolicy`'s

 * validator and default to `'zhishi'`; users who relied on stripping

 * ZhiShi proxy can pick `terminal` from the UI.

 */

export interface RuntimeEnvPolicy {

  proxy?: RuntimeProxyPolicy;

}



/**

 * Runtime-specific configuration stored in AgentConfig

 */

export interface RuntimeConfig {

  model?: string;            // Runtime-specific model selection

  permissionMode?: string;   // Runtime-specific permission mode

  additionalArgs?: string[]; // Extra CLI arguments

  /**

   * Issue #194 — per-agent env policy. When omitted, runtime treats it as

   * `{ proxy: 'zhishi' }` (the legacy behaviour) for backwards compat.

   */

  envPolicy?: RuntimeEnvPolicy;

}



/**

 * Field families on RuntimeConfig grouped by "are they portable across

 * runtimes". Used by `buildRuntimeChangePatch` and the startup migration to

 * decide what to scrub when `agent.runtime` changes.

 *

 *  - **NOT portable**: model / permissionMode / additionalArgs — model lists

 *    and permission vocabularies are wholly disjoint between Codex (`gpt-*`,

 *    `suggest/auto-edit/full-auto`), Claude Code (`sonnet/opus/haiku`,

 *    `default/acceptEdits/bypassPermissions`), and Gemini (`gemini-*`,

 *    `default/autoEdit/yolo/plan`). Carrying a value from one runtime to

 *    another guarantees the new runtime either rejects it (Codex CLI:

 *    "model is not supported when using ChatGPT account") or silently

 *    falls back to defaults — both worse than starting clean.

 *  - **Portable**: envPolicy — per-agent network routing choice that has

 *    nothing to do with which CLI is in use.

 *

 * The split lives here (single source of truth) so the migration and the

 * write-time helper can't drift.

 */

export const RUNTIME_CONFIG_PER_RUNTIME_FIELDS = [

  'model',

  'permissionMode',

  'additionalArgs',

] as const satisfies readonly (keyof RuntimeConfig)[];



/**

 * Build the `{ runtime, runtimeConfig }` patch to apply when an agent's

 * runtime is being changed. Centralizes the "drop non-portable fields"

 * policy so every callsite (in-chat switch, Settings panel, Launcher

 * selector, `zhishi agent set runtime <v>` CLI) behaves identically.

 *

 * Returns `runtimeConfig: undefined` instead of `{}` when scrubbing empties

 * the object so the caller's atomic-merge logic doesn't persist a noise

 * `runtimeConfig: {}` entry.

 *

 * Cross-bugfix for issue #194 follow-up: pre-existing bug class where Gemini's

 * persisted `runtimeConfig.model` would leak into Codex sessions after a

 * runtime switch. Activated by commit `8020803e` (May 2) when

 * persistInputOption.ts started correctly writing external-runtime model to

 * `runtimeConfig.model` (previously it was wrongly going to `agent.model`,

 * masking the bug). See commit message of the migration commit for the full

 * archaeology.

 */

export function buildRuntimeChangePatch(

  currentRuntimeConfig: RuntimeConfig | undefined,

  newRuntime: RuntimeType,

): { runtime: RuntimeType; runtimeConfig: RuntimeConfig | undefined } {

  if (!currentRuntimeConfig) {

    return { runtime: newRuntime, runtimeConfig: undefined };

  }

  const next: RuntimeConfig = { ...currentRuntimeConfig };

  for (const k of RUNTIME_CONFIG_PER_RUNTIME_FIELDS) {

    delete next[k];

  }

  const hasFields = Object.keys(next).length > 0;

  return { runtime: newRuntime, runtimeConfig: hasFields ? next : undefined };

}



/**

 * Get the highest-permission mode for the given runtime.

 *

 * Used in unattended contexts (cron task dispatch, agent task execution) where

 * "user didn't pick anything" should mean "give me whatever lets the AI

 * actually run without blocking on a human approval that never comes".

 *

 * Distinct from getDefaultRuntimePermissionMode() which returns each runtime's

 * INTERACTIVE default (auto/default/autoEdit/full-auto). Those defaults are

 * correct for chat tabs but pathological for cron — they leave WebSearch /

 * Bash / mcp__* in a pending-approval state that times out on a 10-minute

 * deadline.

 *

 * Per-runtime mapping:

 *   - builtin     → 'fullAgency'        (mapToSdkPermissionMode → bypassPermissions)

 *   - claude-code → 'bypassPermissions' (CC CLI native value, no translation)

 *   - codex       → 'no-restrictions'   (Codex sandbox: skip approvals + sandbox)

 *   - gemini      → 'yolo'              (Gemini ACP: skip all confirmations)

 */

export function getMaxPermissionForRuntime(runtime: RuntimeType): string {

  switch (runtime) {

    case 'builtin':     return 'fullAgency';

    case 'claude-code': return 'bypassPermissions';

    case 'codex':       return 'no-restrictions';

    case 'gemini':      return 'yolo';

    default:            return 'fullAgency';

  }

}



/**

 * Resolve the effective permissionMode for a cron / unattended task tick.

 *

 * Semantics:

 *   - undefined / '' (sentinel "user didn't pick") → runtime max permission

 *   - any other literal value → respected as user's explicit choice

 *

 * Crucially, 'auto' / 'default' / 'autoEdit' / 'full-auto' are NOT treated as

 * "user didn't pick" — they're the runtime's interactive defaults but if a

 * user has them in their cron config, that's a literal value we honor. The

 * only sentinel for "use max" is empty/undefined.

 *

 * (Historical note: pre-v0.2.5, cron config persisted 'auto' as a silent

 * default even when the user never picked anything. The v0.2.5 migration in

 * src-tauri/src/cron_task.rs::load_from_disk clears those values to empty

 * string before they reach this resolver.)

 */

export function resolveCronPermissionMode(

  payloadMode: string | null | undefined,

  snapshotMode: string | null | undefined,

  runtime: RuntimeType,

): string {

  const userMode = (payloadMode || snapshotMode || '').trim();

  if (!userMode) return getMaxPermissionForRuntime(runtime);

  return userMode;

}

