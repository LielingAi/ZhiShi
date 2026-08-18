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

// Exported purely to satisfy the "unused" lint rule — the type-level assertion

// on this declaration is what fails the build on drift; the runtime value

// itself is inert.

export const _exhaustiveRuntimeCheck: _AssertRuntimeExhaustive = true;



/** Human-readable display names keyed by runtime type. */

export const RUNTIME_DISPLAY_NAMES: Record<RuntimeType, string> = {

  builtin: '内置 (Claude 智能体 SDK)',

  'claude-code': 'Claude Code CLI',

  codex: 'OpenAI Codex CLI',

  gemini: 'Google Gemini CLI (ACP)',

};



/**

 * Coerce an arbitrary string (agent config value, persisted state, env) into a

 * valid `RuntimeType`, defaulting to `'builtin'` for missing/unknown values.

 *

 * Single source of truth — re-exported from `@/utils/sessionOpenPlan` for

 * renderer callers. Lives in `shared/` so renderer + sidecar consume one impl.

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

 * Runtime detection result

 */

export interface RuntimeDetection {

  installed: boolean;

  version?: string;

  path?: string;

}



/**

 * All runtime detections keyed by type

 */

export type RuntimeDetections = Record<RuntimeType, RuntimeDetection>;



/**

 * Model info from an external runtime CLI

 */

export interface RuntimeModelInfo {

  value: string;        // Value passed to CLI (e.g., "sonnet", "o3")

  displayName: string;  // UI display name (e.g., "Sonnet 4.6")

  description?: string; // Optional description

  isDefault?: boolean;  // Mark as default selection

}



/**

 * Permission mode for an external runtime

 */

export interface RuntimePermissionMode {

  value: string;        // Value passed to CLI

  label: string;        // UI display label

  icon: string;         // Emoji icon

  description: string;  // Description text

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



// ─── Claude Code permission modes ───



export const CC_PERMISSION_MODES: RuntimePermissionMode[] = [

  {

    value: 'default',

    label: 'Default',

    icon: '\u{1F6E1}',  // 🛡

    description: '每次工具调用都需要确认',

  },

  {

    value: 'plan',

    label: 'Plan',

    icon: '\u{1F4CB}',  // 📋

    description: '规划模式，只读不执行',

  },

  {

    value: 'acceptEdits',

    label: 'Accept Edits',

    icon: '\u{1F4DD}',  // 📝

    description: '自动接受文件编辑，其他需确认',

  },

  {

    value: 'bypassPermissions',

    label: 'Bypass Permissions',

    icon: '\u26A1',      // ⚡

    description: '跳过所有权限确认',

  },

];



// ─── Gemini CLI permission modes (ACP session modes, v0.1.66) ───

//

// These map 1:1 to Gemini CLI's ACP session/new response `modes.availableModes[]`:

//   default  → "Prompts for approval"

//   autoEdit → "Auto-approves edit tools"

//   yolo     → "Auto-approves all tools"

//   plan     → "Read-only mode"

// We keep the internal value equal to Gemini's modeId to avoid a mapping table.



export const GEMINI_PERMISSION_MODES: RuntimePermissionMode[] = [

  {

    value: 'default',

    label: 'Default',

    icon: '\u{1F6E1}',  // 🛡

    description: '每次工具调用都需要确认',

  },

  {

    value: 'autoEdit',

    label: 'Auto Edit',

    icon: '\u{1F4DD}',  // 📝

    description: '自动接受文件编辑,其他需确认',

  },

  {

    value: 'yolo',

    label: 'YOLO',

    icon: '\u26A1',      // ⚡

    description: '跳过所有工具确认',

  },

  {

    value: 'plan',

    label: 'Plan',

    icon: '\u{1F4CB}',  // 📋

    description: '规划模式,只读不执行',

  },

];



// ─── Built-in Claude 智能体 SDK permission modes ───

//

// These mirror the `PermissionMode` string union in `src/server/agent-session.ts`

// (`'auto' | 'plan' | 'fullAgency' | 'custom'`). Exposing them here lets

// `zhishi runtime describe builtin` show the same allowlist other runtimes

// expose — otherwise the discovery flow returns an empty permissionModes list

// for builtin and the AI caller has no way to know what values `--permissionMode`

// accepts without reading source code.

export const BUILTIN_PERMISSION_MODES: RuntimePermissionMode[] = [

  {

    value: 'auto',

    label: 'Auto',

    icon: '\u{1F916}',  // 🤖

    description: '默认模式，工具按需申请权限',

  },

  {

    value: 'plan',

    label: 'Plan',

    icon: '\u{1F4CB}',  // 📋

    description: '规划模式，只读不执行',

  },

  {

    value: 'fullAgency',

    label: 'Full Agency',

    icon: '\u26A1',      // ⚡

    description: '跳过所有权限确认（Cron 任务默认）',

  },

  {

    value: 'custom',

    label: 'Custom',

    icon: '\u{1F527}',  // 🔧

    description: '用户自定义的权限规则',

  },

];



// ─── Codex permission modes (pre-defined for v2) ───



export const CODEX_PERMISSION_MODES: RuntimePermissionMode[] = [

  {

    value: 'suggest',

    label: 'Suggest',

    icon: '\u{1F50D}',  // 🔍

    description: '仅信任的命令自动执行，其他需确认',

  },

  {

    value: 'auto-edit',

    label: 'Auto-Edit',

    icon: '\u{1F4DD}',  // 📝

    description: '自动编辑文件，沙箱内执行命令',

  },

  {

    value: 'full-auto',

    label: 'Full Auto',

    icon: '\u26A1',      // ⚡

    description: '沙箱内自主执行，按需询问',

  },

  {

    value: 'no-restrictions',

    label: 'No Restrictions',

    icon: '\u{1F513}',  // 🔓

    description: '跳过所有审批和沙箱限制',

  },

];



/**

 * Get permission modes for a given runtime type

 *

 * Returns the exhaustive allowlist for every runtime — including builtin —

 * so callers (UI dropdowns, `runtime describe`, validators) don't have to

 * special-case the builtin path.

 */

export function getRuntimePermissionModes(runtime: RuntimeType): RuntimePermissionMode[] {

  switch (runtime) {

    case 'claude-code': return CC_PERMISSION_MODES;

    case 'codex': return CODEX_PERMISSION_MODES;

    case 'gemini': return GEMINI_PERMISSION_MODES;

    case 'builtin': return BUILTIN_PERMISSION_MODES;

    default: return [];

  }

}



// ─── Claude Code model list (canonical, shared) ───



export const CC_MODELS: RuntimeModelInfo[] = [

  { value: '', displayName: '默认', isDefault: true },

  { value: 'sonnet', displayName: 'Sonnet' },

  { value: 'opus', displayName: 'Opus' },

  { value: 'haiku', displayName: 'Haiku' },

];



// Note: no static GEMINI_MODELS export (unlike CC_MODELS). Gemini's model

// list is fetched dynamically via /api/runtime/models?type=gemini →

// GeminiRuntime.queryModels() → short-lived `gemini --acp` handshake that

// reads `result.models.availableModels` from the session/new response.

// Launcher.tsx and Chat.tsx hold their own `geminiModels` useState seeded

// to [] and populated on the first mount.



/**

 * Get default permission mode for a given runtime type

 */

export function getDefaultRuntimePermissionMode(runtime: RuntimeType): string {

  switch (runtime) {

    case 'claude-code': return 'default';

    case 'codex': return 'full-auto';

    case 'gemini': return 'autoEdit';  // D5: desktop default = Auto Edit

    case 'builtin': return 'auto';

    default: return '';

  }

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



// ─── Runtime diagnostics (issue #194) ───

//

// Diagnostic snapshot collected at session start for external runtimes (Codex /

// Claude Code / Gemini). Renderer surfaces this to make 「为什么我看不到 X 工具？」

// debuggable without grepping unified log. Codex fills all four sections via

// RPC after thread/start; other runtimes contribute the subset they expose.

//

// IMPORTANT — privacy: never put secrets (API keys, OAuth tokens, full proxy URL

// with embedded credentials) into this payload. It's sent over SSE to the

// renderer and persisted in chat history. Use boolean presence for sensitive

// env vars (e.g. `hasOpenaiApiKey: true`) not the value.



/**

 * Auth state as reported by the runtime CLI itself.

 *

 * `authMethod` mirrors Codex's `AuthMode` (`apiKey` / `chatGptToken` / ...) or

 * CC's keychain/OAuth labels. `null` means runtime hasn't told us (e.g. Codex

 * `getAuthStatus` returned null) — distinct from "not authenticated".

 */

export interface RuntimeAuthStatus {

  authMethod: string | null;

  /** True when this account needs to complete sign-in before tools work. */

  requiresLogin?: boolean;

  /** Free-form display text, runtime-specific. */

  details?: string;

}



/**

 * Single feature flag as reported by the runtime. For Codex: `[features]` table

 * in config.toml + experimentalFeature/list RPC. `defaultEnabled` differs from

 * `enabled` when the user explicitly toggled it (e.g. `artifact = true` in a

 * stage-`underDevelopment` flag).

 */

export interface RuntimeFeatureFlag {

  name: string;

  enabled: boolean;

  defaultEnabled: boolean;

  /** Codex: 'beta' | 'underDevelopment' | 'stable' | 'deprecated' | 'removed'. */

  stage?: string;

}



/**

 * One MCP server as the runtime sees it. `state` follows Codex's

 * `McpServerStartupState`; CC uses its own labels. `authStatus` is a runtime-

 * defined string (e.g. 'oauth-required', 'authenticated').

 */

export interface RuntimeMcpServerInfo {

  name: string;

  toolCount: number;

  resourceCount?: number;

  state?: string;

  authStatus?: string;

}



/**

 * One "App" / connector / plugin the runtime sees. Codex's `app/list` populates

 * this (artifact-tool, github, computer-use, etc.). `isAccessible: false` is

 * the most actionable signal for issue #194 — it tells the user the runtime

 * tried to discover the app and couldn't (auth / network / discovery error).

 */

export interface RuntimeAppInfo {

  id: string;

  name?: string;

  description?: string;

  isAccessible?: boolean;

  isEnabled?: boolean;

  needsAuth?: boolean;

  installUrl?: string | null;

}



/**

 * Per-call status. `'ok'` = runtime returned a payload. `'unsupported'` = the

 * runtime doesn't have the corresponding RPC (e.g. CC has no app/list).

 * `{ error }` = the RPC was tried and failed; carries a short reason.

 */

export type RuntimeDiagnosticsCallStatus =

  | 'ok'

  | 'unsupported'

  | { error: string };



export interface RuntimeDiagnosticsStatus {

  auth?: RuntimeDiagnosticsCallStatus;

  features?: RuntimeDiagnosticsCallStatus;

  mcpServers?: RuntimeDiagnosticsCallStatus;

  apps?: RuntimeDiagnosticsCallStatus;

}



export interface RuntimeDiagnosticIssue {

  code: string;

  severity: 'info' | 'warn' | 'error';

  title: string;

  message: string;

  hint?: string;

}



/**

 * Effective env snapshot for the runtime subprocess. Sanitised for display:

 *  - `proxy.http/https/all` are URLs without embedded credentials.

 *  - `pathHead` is the first 5 entries of PATH (full PATH is logged, not shown).

 *  - sensitive vars surface only as `has<NAME>: boolean` presence checks.

 *

 * `proxyPolicy` is filled in Phase 2 when RuntimeEnvPolicy lands; today it's

 * always `'zhishi'` (the legacy behaviour).

 */

export interface RuntimeEffectiveEnv {

  cwd: string;

  proxy?: {

    http?: string;

    https?: string;

    all?: string;

    no?: string;

  } | null;

  proxyPolicy?: RuntimeProxyPolicy;

  /** First few PATH entries for visibility (full PATH would be too noisy). */

  pathHead?: string[];

  /** True when ZHISHI_PROXY_INJECTED=1 reached the runtime. */

  zhishiProxyInjected?: boolean;

  /** Codex-only sandbox probe used to diagnose loopback proxy/network blocks. */

  codexSandbox?: {

    detected?: boolean;

    networkDisabled?: boolean;

    proxyProbe?: {

      url: string;

      reachable: boolean;

      error?: string;

    };

  };

  /** Presence-only flags for sensitive env vars. */

  hasOpenaiApiKey?: boolean;

  hasAnthropicApiKey?: boolean;

  hasCodexHome?: boolean;

  hasXdgConfigHome?: boolean;

}



/**

 * Combined runtime diagnostics payload. Delivered as a UnifiedEvent

 * (`runtime_diagnostics`) shortly after session_init; consumed by the renderer

 * to show "what the runtime sees" in a Chat header strip / details panel.

 */

export interface RuntimeDiagnostics {

  runtime: RuntimeType;

  effectiveEnv: RuntimeEffectiveEnv;

  auth?: RuntimeAuthStatus;

  features?: RuntimeFeatureFlag[];

  mcpServers?: RuntimeMcpServerInfo[];

  apps?: RuntimeAppInfo[];

  status: RuntimeDiagnosticsStatus;

  issues?: RuntimeDiagnosticIssue[];

  /** ISO-8601 UTC string. */

  timestamp: string;

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

