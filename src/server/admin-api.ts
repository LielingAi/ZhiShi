/**

 * Admin API — Self-Configuration endpoints for the CLI tool.

 *

 * All handlers follow the same pattern:

 *   1. Validate input

 *   2. If dry-run → return preview

 *   3. Write config (atomicModifyConfig)

 *   4. Update Sidecar in-memory state

 *   5. Broadcast SSE event for frontend sync

 *   6. Return result

 */



import type { IntelConfig, McpServerDefinition } from '../shared/config-types';

import { resolveIntelConfig } from '../shared/config-types';

import { SDK_RESERVED_MCP_NAMES } from './agent-session';

import {

  loadConfig,

  atomicModifyConfig,

  getAllMcpServers,

  getEnabledMcpServerIds,

  loadProjects,

  saveProjects,

  redactSecret,

  findProvider,

  getAllEffectiveProviders,

  isProviderDisabled,

  getProvidersDir,

  type AdminAppConfig,

  type AgentConfigSlim,


} from './utils/admin-config';

import { cancellableFetch } from './utils/cancellation';

import { readLoopbackJson } from './utils/loopback-response';

import { managementApi } from './utils/management-api';



// Localhost loopback timeout for management / sidecar self-calls.

// 10s is generous for an in-process Rust handler or a same-process Hono

// route — anything slower means the backend is wedged, in which case we'd

// rather surface a CLI error than hang the user's terminal indefinitely.

const ADMIN_LOOPBACK_TIMEOUT_MS = 10_000;

import { existsSync , writeFileSync, unlinkSync, readFileSync, readdirSync, statSync } from 'fs';

import { ensureDirSync, isDirEntry } from './utils/fs-utils';

import { resolveSshTarget, execInEnvironment } from './loop/env-exec';

import { buildToolCheckCommand, parseToolCheckOutput } from './environment/recipes';

import { requestBoundaryAsk } from './loop/boundary-ask';

import { detectOsFamilyFromVmx } from './environment/os-family';

import {
  loadDomainManifests,
  resolveBundledDir,
  validateDomainManifest,
  type DomainCheckContext,
} from './domains/manifest';

import { resolveBundledSkillsDir } from './loop/skills';

import { augmentedProcessEnv, resolveCommand } from './utils/env-utils';

import { isSkillBlockedOnPlatform } from './utils/platform';

import { parseSkillFrontmatter } from '../shared/slashCommands';

import { resolve, basename, isAbsolute } from 'path';

import { setMcpServers, setAgents, getMcpServers, getSidecarPort, getSessionId } from './agent-session';
import { getPiAgentState, sendPiChatMessage } from './loop/chat-engine';
import { getMcpStatus, initMcpBridge, reloadMcpBridge } from './loop/mcp-bridge';

import { loadEnabledAgents } from './agents/agent-loader';

import { getZhiShiDataDir } from './utils/app-dirs';

import { join } from 'path';

import { broadcast } from './sse';

import { getSessionCronContext } from './tools/session-cron-context';

import { buildReadMeContent } from './tools/generative-ui-tool';

import { WIDGET_TRIGGER_GUIDANCE } from './system-prompt-cli-tools';

import { assertSafeFilePath } from './utils/safe-file-path';

import { getBundledCusePath, getBundledTerminatorPath } from './utils/runtime';

import { getEnabledBoundAppsForWorkspace } from './utils/bound-apps';

import { TerminatorClient } from './appcraft/terminator-client';

import {

  planReplay,

  planNeedsTerminator,

  planNeedsCuse,

  replayTrace,

  deriveProcessName,

} from './appcraft/replay-engine';

import {

  startRecording,

  stopRecording,

  getRecordingStatus,

  defaultCaptureKeyframe,

} from './appcraft/recorder';
import { aggregateAppcraftRunStats, appendAppcraftRun } from './appcraft/run-log';
import type { AppcraftRunStats } from './appcraft/run-log';
import { parseActiveReminders, parseReminderMeta, readDistilled } from './memory/distill';
import { findByContent, listActive, listResearchEvents, logRecallEvents, MEMORY_KINDS, recordResearchEvent, searchEntries, touchEntry, type MemoryKind, type ResearchBugClass, type ResearchOutcome, type ResearchTaskKind } from './memory/store';
// 1.1.2 情报横切：intel.db 更新/状态（sidecar 进程内直连,不经网络）。
import { runIntelUpdate, getIntelProgress } from './intel/sync';
import { getIntelStatus, hasIntelDb, openIntelStore } from './intel/store';
import {
  importTrustBuffer,
  readTrustLedger,
  recordTrustTransition,
  resetTrustLedger,
  resolveTrustSuggestion,
  type TrustTransitionInput,
} from './memory/trust';
import {
  appendSopHealAudit,
  buildSopContinuationPrompt,
  isSopContinuationEligible,
  tryMarkSopContinuation,
} from './appcraft/sop-continuation';

import { spawn as spawnSubprocess } from './utils/subprocess';

import { parseAppcraftTrace } from '../shared/appcraft-trace';

import {

  VALID_RUNTIMES,

  buildRuntimeChangePatch,

  type RuntimeType,

  type RecoveryHint,

  type RuntimeConfig,

} from '../shared/types/runtime';

import { detectEnvironmentEnginesCached } from './environment/engine-detect-cache';

import {

  addEnvironmentEntry,

  findEnvironmentEntry,

  listEnvironments,

  removeEnvironmentEntry,

  resolveEnvOpenCommand,

  envTagForEntry,

  validateEnvironmentEntry,

} from './environment/registry';

import {

  registerTerminalEnvTag,

  unregisterTerminalEnvTag,

} from './environment/terminal-tags';

import {

  defaultRecipesRoot,

  loadRecipe,

  scanRecipes,

} from './environment/recipes';

import {

  envDown,

  envPs,

  envPsAll,

  envUp,

} from './environment/docker-lifecycle';

import {

  normalizeVmxPath,

  vmEnvDown,

  vmEnvPs,

  vmEnvUp,

  type VmInstance,

} from './environment/vm-lifecycle';

import {

  rollbackVm,

  snapshotVm,

} from './environment/vm-snapshot';

import {

  hypervEnvDown,

  hypervEnvPs,

  hypervEnvRm,

  hypervEnvUp,

  hypervVmExists,

} from './environment/hyperv-lifecycle';

import {

  vboxEnvDown,

  vboxEnvPs,

  vboxEnvRm,

  vboxEnvUp,

  vboxVmExists,

} from './environment/vbox-lifecycle';

import {

  resolveVmDriver,

  routeVmTarget,

} from './environment/vm-dispatch';

import {

  vmTemplateAdopt,

} from './environment/vm-adopt';

import {

  vmGuestExec,

} from './environment/vm-guest-exec';

import {

  vmTemplateBuild,

} from './environment/vm-build';

import {

  installEngine,

} from './environment/engine-install';

import {

  getWorkspaceSelectionRecord,

  loadSelectionStore,

  saveSelectionStore,

  setWorkspaceSelection,

  validateEnvSelection,

  HOST_SELECTION,

} from './environment/selection';

// ---------------------------------------------------------------------------

// Management API forwarding (Node Sidecar → Rust) — the `managementApi()`

// loopback helper and the Hub-intervention primitives moved to the leaf

// module ./utils/management-api (PRD 0.2.36 §6.5: agent-session needs them

// too, and importing admin-api from agent-session would close an ESM cycle).

// Handlers below keep calling the same names — they are imported from there.

// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------

// Sidecar self-loopback (for thin wrappers over existing /api/skill/* routes)

// ---------------------------------------------------------------------------



async function sidecarSelf(

  path: string,

  method: 'GET' | 'POST' | 'DELETE' | 'PUT' = 'GET',

  body?: Record<string, unknown>,

  opts?: { timeoutMs?: number },

): Promise<{ status: number; json: Record<string, unknown> }> {

  const sidecarPort = getSidecarPort();

  if (!sidecarPort) {

    return { status: 500, json: { success: false, error: 'Sidecar port not initialized' } };

  }

  const url = `http://127.0.0.1:${sidecarPort}${path}`;

  const options: RequestInit = {

    method,

    headers: { 'Content-Type': 'application/json' },

  };

  if (body && (method === 'POST' || method === 'PUT')) {

    options.body = JSON.stringify(body);

  }

  try {

    const resp = await cancellableFetch(url, options, {

      timeoutMs: opts?.timeoutMs ?? ADMIN_LOOPBACK_TIMEOUT_MS,

    });

    // Issue #114 — defensive read via shared helper. Map to this caller's

    // legacy {status, json} shape (sidecarSelf has callers that branch on

    // status code, so we preserve that envelope rather than collapsing to

    // a flat error object).

    const json = await readLoopbackJson(resp, 'Sidecar self-call');

    return { status: resp.status, json };

  } catch (err) {

    const msg = err instanceof Error ? err.message : String(err);

    return { status: 500, json: { success: false, error: `Sidecar self-call failed: ${msg}` } };

  }

}



/**

 * Build an AdminResponse error from a Management API failure, preserving any

 * `recoveryHint` the helper attached (currently: unreachable-backend cases).

 *

 * Use this instead of `{ success: false, error: String(resp.error ?? 'X') }`

 * in handlers that transform the shape (e.g. list handlers that unwrap

 * `resp.tasks` / `resp.runs`) — those bypass `wrapMgmtResponse` but still

 * deserve the hint propagation. Sites that already go through

 * `wrapMgmtResponse` don't need to change.

 */

function mgmtError(resp: Record<string, unknown>, fallbackMsg: string): AdminResponse {

  const response: AdminResponse = {

    success: false,

    error: String(resp.error ?? fallbackMsg),

  };

  const hint = resp.recoveryHint;

  if (hint && typeof hint === 'object' && !Array.isArray(hint)) {

    response.recoveryHint = hint as RecoveryHint;

  }

  return response;

}



/** Convert Management API response ({ ok, ... }) to Admin API response ({ success, data, error }) */

function wrapMgmtResponse(mgmt: Record<string, unknown>): AdminResponse {

  if (mgmt.ok) {

    const { ok: _ok, recoveryHint: _rh, ...rest } = mgmt;

    return { success: true, data: rest };

  }

  const response: AdminResponse = {

    success: false,

    error: String(mgmt.error ?? 'Unknown error'),

  };

  // Propagate the `recoveryHint` if the Management API helper attached one

  // (currently only for unreachable-backend scenarios — see `managementApi`).

  const maybeHint = mgmt.recoveryHint;

  if (maybeHint && typeof maybeHint === 'object' && !Array.isArray(maybeHint)) {

    response.recoveryHint = maybeHint as RecoveryHint;

  }

  return response;

}



// ---------------------------------------------------------------------------

// Types

// ---------------------------------------------------------------------------



interface AdminResponse<T = unknown> {

  success: boolean;

  data?: T;

  error?: string;

  /**

   * Free-form success tip ("Server added.", "Restart required."). Purely

   * informational — distinct from `recoveryHint` which is a structured,

   * actionable recovery path for a failed request.

   */

  hint?: string;

  /**

   * Scope descriptor for workspace-scoped list reads (e.g. appcraft list).

   * The list silently filters to the caller's workspace, so a

   * `{data: []}` result is easy for an Agent consumer to misread

   * as "nothing exists anywhere". Echo the scope so it can tell "empty within

   * this workspace" apart from "empty everywhere". Pair with `hint` (the

   * human/LLM-readable note).

   */

  scope?: { workspacePath: string; source: 'explicit' | 'default'; visibility: string };

  /**

   * Structured recovery path for recoverable errors. The CLI renders this

   * under the error line as `→ Run: <command>` so the caller (AI or human)

   * can copy-paste to correct course without digging through --help.

   *

   * Pair a `recoveryHint` with `success: false` + `error` — never emit one

   * on a success path; use `hint` there.

   */

  recoveryHint?: RecoveryHint;

  dryRun?: boolean;

  preview?: unknown;

  [key: string]: unknown;

}



// ---------------------------------------------------------------------------

// MCP Handlers

// ---------------------------------------------------------------------------



export function handleMcpList(): AdminResponse {

  const config = loadConfig();

  const allServers = getAllMcpServers(config);

  const enabledIds = new Set(getEnabledMcpServerIds(config));



  const data = allServers.map(s => ({

    id: s.id,

    name: s.name,

    type: s.type,

    enabled: enabledIds.has(s.id),

    isBuiltin: s.isBuiltin,

    command: s.command,

    url: s.url,

    requiresConfig: s.requiresConfig,

    hasEnv: !!(s.env && Object.keys(s.env).length > 0),

  }));



  return { success: true, data };

}



/**

 * `zhishi mcp show <id>` — details for a single MCP server.

 *

 * Mirrors handleAgentShow: parses user-facing config + workspace enable state

 * into one consolidated payload the AI / user can inspect without dumping the

 * whole list. Env values are redacted so an AI transcript never leaks API keys

 * (same redaction rule the model-list endpoint already uses).

 */

export function handleMcpShow(payload: { id?: string }): AdminResponse {

  const id = payload.id;

  if (!id) {

    return {

      success: false,

      error: 'Missing required argument: <mcp-id>',

      recoveryHint: {

        recoveryCommand: 'zhishi mcp list',

        message: 'See valid MCP server ids.',

      },

    };

  }

  const config = loadConfig();

  const allServers = getAllMcpServers(config);

  const server = allServers.find(s => s.id === id);

  if (!server) {

    return {

      success: false,

      error: `MCP server '${id}' not found.`,

      recoveryHint: {

        recoveryCommand: 'zhishi mcp list',

        message: 'See valid MCP server ids.',

      },

    };

  }



  const globalEnabled = new Set(getEnabledMcpServerIds(config));

  const workspacePath = getCurrentWorkspacePath();

  let projectEnabled: boolean | null = null;

  if (workspacePath) {

    const projects = loadProjects();

    const project = projects.find(p => p.path === workspacePath);

    projectEnabled = new Set(project?.mcpEnabledServers ?? []).has(id);

  }



  // Redact env values — mirrors what `model list` does for provider api keys.

  const env = server.env ? Object.fromEntries(

    Object.entries(server.env).map(([k, v]) => [k, redactSecret(v)]),

  ) : undefined;



  return {

    success: true,

    data: {

      id: server.id,

      name: server.name,

      type: server.type,

      description: server.description,

      isBuiltin: !!server.isBuiltin,

      requiresConfig: !!server.requiresConfig,

      websiteUrl: server.websiteUrl,

      command: server.command,

      args: server.args,

      url: server.url,

      // Headers (for http/sse) and env (for stdio) — redacted values only.

      headers: server.headers ? Object.fromEntries(

        Object.entries(server.headers).map(([k, v]) => [k, redactSecret(v)]),

      ) : undefined,

      env,

      enabled: {

        global: globalEnabled.has(id),

        // null = no current workspace session → project scope n/a.

        project: projectEnabled,

      },

      workspacePath: workspacePath ?? null,

    },

  };

}



export async function handleMcpAdd(payload: {

  server: Partial<McpServerDefinition>;

  dryRun?: boolean;

}): Promise<AdminResponse> {

  const { dryRun } = payload;

  const s = payload.server;



  // Validate required fields

  if (!s.id) return { success: false, error: 'Missing required field: id' };

  if (!s.type) return { success: false, error: 'Missing required field: type' };



  // Reject SDK reserved MCP names — these cause the Claude Agent SDK to crash (exit code 1)

  // with "Invalid MCP configuration: X is a reserved MCP name."

  const normalizedId = s.id.replace(/[^a-zA-Z0-9_-]/g, '_');

  if (SDK_RESERVED_MCP_NAMES.includes(normalizedId)) {

    return { success: false, error: `MCP ID "${s.id}" 与 Claude SDK 内置保留名冲突，请使用其他名称（如 "my-${s.id}"）` };

  }



  if (s.type === 'stdio' && !s.command) {

    return { success: false, error: 'stdio type requires "command" field' };

  }

  if ((s.type === 'sse' || s.type === 'http') && !s.url) {

    return { success: false, error: `${s.type} type requires "url" field` };

  }



  const server: McpServerDefinition = {

    id: s.id,

    name: s.name || s.id,

    type: s.type,

    description: s.description,

    command: s.command,

    // Defensive: CLI may send non-array args (boolean, string) due to parsing edge cases

    args: Array.isArray(s.args) ? s.args : undefined,

    env: s.env,

    url: s.url,

    headers: s.headers,

    isBuiltin: false,

    requiresConfig: s.requiresConfig,

    websiteUrl: s.websiteUrl,

    configHint: s.configHint,

  };



  if (dryRun) {

    return { success: true, dryRun: true, preview: server };

  }



  await atomicModifyConfig(c => ({

    ...c,

    mcpServers: [...(c.mcpServers || []).filter(x => x.id !== server.id), server],

  }));



  notifyMcpChange('add', server.id);

  return {

    success: true,

    data: { id: server.id, name: server.name },

    hint: 'Server added. Use "zhishi mcp enable" to activate.',

  };

}



export async function handleMcpRemove(payload: { id: string }): Promise<AdminResponse> {

  const { id } = payload;

  if (!id) return { success: false, error: 'Missing required field: id' };



  // Check if it's a built-in preset

  const allServers = getAllMcpServers();

  const target = allServers.find(s => s.id === id);

  if (!target) return { success: false, error: `MCP server '${id}' not found` };

  if (target.isBuiltin) {

    return { success: false, error: `Cannot remove built-in MCP server '${id}'. Only custom servers can be removed.` };

  }



  await atomicModifyConfig(c => {

    const servers = (c.mcpServers || []).filter(s => s.id !== id);

    const enabled = (c.mcpEnabledServers || []).filter(s => s !== id);

    const envOverrides = { ...(c.mcpServerEnv || {}) };

    delete envOverrides[id];

    const argsOverrides = { ...(c.mcpServerArgs || {}) };

    delete argsOverrides[id];

    return { ...c, mcpServers: servers, mcpEnabledServers: enabled, mcpServerEnv: envOverrides, mcpServerArgs: argsOverrides };

  });



  notifyMcpChange('remove', id);

  return { success: true, data: { id }, hint: 'Server removed.' };

}



export async function handleMcpEnable(payload: { id: string; scope?: string }): Promise<AdminResponse> {

  const { id, scope = 'both' } = payload;

  if (!id) return { success: false, error: 'Missing required field: id' };



  // Verify server exists

  const allServers = getAllMcpServers();

  if (!allServers.find(s => s.id === id)) {

    return { success: false, error: `MCP server '${id}' not found` };

  }



  if (scope === 'global' || scope === 'both') {

    await atomicModifyConfig(c => {

      const enabled = new Set(c.mcpEnabledServers || []);

      enabled.add(id);

      return { ...c, mcpEnabledServers: Array.from(enabled) };

    });

  }



  if (scope === 'project' || scope === 'both') {

    enableMcpForCurrentProject(id);

  }



  notifyMcpChange('enable', id);

  const scopeLabel = scope === 'both' ? 'global + project' : scope;

  return { success: true, data: { id, scope: scopeLabel }, hint: `Enabled ${id} (${scopeLabel}).` };

}



export async function handleMcpDisable(payload: { id: string; scope?: string }): Promise<AdminResponse> {

  const { id, scope = 'both' } = payload;

  if (!id) return { success: false, error: 'Missing required field: id' };



  if (scope === 'global' || scope === 'both') {

    await atomicModifyConfig(c => {

      const enabled = new Set(c.mcpEnabledServers || []);

      enabled.delete(id);

      return { ...c, mcpEnabledServers: Array.from(enabled) };

    });

  }



  if (scope === 'project' || scope === 'both') {

    disableMcpForCurrentProject(id);

  }



  notifyMcpChange('disable', id);

  return { success: true, data: { id } };

}



/**

 * M4d — MCP bridge 连接状态。惰性兜底:若 sidecar 启动的 deferred init

 * 尚未跑完(或从未跑),先触发桥初始化再取状态——状态永远反映真实连接

 * (已初始化时 initMcpBridge 是幂等 no-op)。

 */

export async function handleMcpListStatus(): Promise<AdminResponse> {

  await initMcpBridge();

  return { success: true, data: { servers: getMcpStatus() } };

}



/**

 * M4d — MCP bridge 热重载:断开全部连接 → 重读磁盘配置(权威来源)→ 重连。

 * 单个 server 失败不抛(记入状态),只有配置读取失败才返回 success:false。

 */

export async function handleMcpReload(): Promise<AdminResponse> {

  try {

    const servers = await reloadMcpBridge();

    return { success: true, data: { servers } };

  } catch (err) {

    return {

      success: false,

      error: err instanceof Error ? err.message : String(err),

      recoveryHint: {

        recoveryCommand: 'zhishi mcp list',

        message: '检查 MCP 配置(config.json)后重试。',

      },

    };

  }

}



export async function handleMcpEnv(payload: {

  id: string;

  action: 'set' | 'get' | 'delete';

  env?: Record<string, string>;

}): Promise<AdminResponse> {

  const { id, action, env } = payload;

  if (!id) return { success: false, error: 'Missing required field: id' };



  if (action === 'get') {

    const config = loadConfig();

    const serverEnv = (config.mcpServerEnv ?? {})[id] ?? {};

    // Redact values for safety

    const redacted: Record<string, string> = {};

    for (const [k, v] of Object.entries(serverEnv)) {

      redacted[k] = redactSecret(v);

    }

    return { success: true, data: { id, env: redacted } };

  }



  if (action === 'set') {

    if (!env || Object.keys(env).length === 0) {

      return { success: false, error: 'No environment variables provided' };

    }

    await atomicModifyConfig(c => {

      const mcpServerEnv = { ...(c.mcpServerEnv || {}) };

      mcpServerEnv[id] = { ...(mcpServerEnv[id] || {}), ...env };

      return { ...c, mcpServerEnv };

    });

    notifyMcpChange('env', id);

    return { success: true, data: { id, keys: Object.keys(env) }, hint: 'Environment variables updated.' };

  }



  if (action === 'delete') {

    if (!env || Object.keys(env).length === 0) {

      return { success: false, error: 'No keys specified for deletion' };

    }

    await atomicModifyConfig(c => {

      const mcpServerEnv = { ...(c.mcpServerEnv || {}) };

      if (mcpServerEnv[id]) {

        // Deep-copy per-server env to avoid mutating the original config object

        const serverEnv = { ...mcpServerEnv[id] };

        for (const key of Object.keys(env)) {

          delete serverEnv[key];

        }

        if (Object.keys(serverEnv).length === 0) {

          delete mcpServerEnv[id];

        } else {

          mcpServerEnv[id] = serverEnv;

        }

      }

      return { ...c, mcpServerEnv };

    });

    notifyMcpChange('env', id);

    return { success: true, data: { id, deletedKeys: Object.keys(env) } };

  }



  return { success: false, error: `Unknown action: ${action}. Use 'set', 'get', or 'delete'.` };

}



export async function handleMcpTest(payload: { id: string }): Promise<AdminResponse> {

  const { id } = payload;

  if (!id) return { success: false, error: 'Missing required field: id' };



  const allServers = getAllMcpServers();

  const server = allServers.find(s => s.id === id);

  if (!server) return { success: false, error: `MCP server '${id}' not found` };



  // Validate config completeness

  if (server.type === 'stdio' && !server.command) {

    return { success: false, error: `MCP server '${id}' has no command configured` };

  }

  if ((server.type === 'sse' || server.type === 'http') && !server.url) {

    return { success: false, error: `MCP server '${id}' has no URL configured` };

  }



  // Built-in MCP: delegate to registry.

  // getBuiltinMcpInstance() force-loads the tool module (SDK+zod+server

  // construction) on first hit; it returns undefined only when the id isn't

  // registered in META. META registrations happen at module load before any

  // admin handler can fire — no need to force-import META here.

  if (server.command === '__builtin__') {

    const { getBuiltinMcpInstance } = await import('./tools/builtin-mcp-registry');

    const entryPromise = getBuiltinMcpInstance(server.id);

    if (!entryPromise) {

      return { success: false, error: `Built-in MCP '${server.id}' not registered` };

    }

    // Don't swallow factory/import errors — a failing `zhishi mcp test` must

    // surface as "failure" so users/agents diagnose the actual issue instead of

    // getting a false "validated" green light while the session keeps breaking.

    try {

      const entry = await entryPromise;

      if (entry.validate) {

        const validationError = await entry.validate(server.env || {});

        if (validationError) {

          const errMsg = typeof validationError === 'string' ? validationError : JSON.stringify(validationError);

          return { success: false, error: errMsg };

        }

      }

    } catch (err) {

      return {

        success: false,

        error: `Built-in MCP '${server.id}' load failed: ${err instanceof Error ? err.message : String(err)}`,

      };

    }

    return { success: true, data: { id, type: 'builtin' }, hint: 'Built-in MCP validated.' };

  }



  // Bundled cuse (computer-use) binary: resolve via runtime helper and

  // check the resolved path exists. Skip the generic `which` preflight —

  // __bundled_cuse__ is a sentinel, not a real PATH lookup. Response

  // surface deliberately omits the resolved absolute path so the sentinel

  // mapping never leaks to user-facing UI.

  if (server.command === '__bundled_cuse__') {

    const { getBundledCusePath } = await import('./utils/runtime');

    const cusePath = getBundledCusePath();

    if (!cusePath) {

      return {

        success: false,

        error: `cuse 二进制未安装 (platform=${process.platform})。macOS/Windows 构建会自动包含；开发环境请运行 scripts/download_cuse.sh。`,

      };

    }

    return { success: true, data: { id, type: 'stdio' }, hint: 'Bundled cuse validated.' };

  }



  // Bundled Terminator MCP agent (UIA desktop automation, PRD 0.2.36): same

  // pattern as cuse — resolve via runtime helper, no generic `which` preflight.

  if (server.command === '__bundled_terminator__') {

    const { getBundledTerminatorPath } = await import('./utils/runtime');

    const terminatorPath = getBundledTerminatorPath();

    if (!terminatorPath) {

      return {

        success: false,

        error: `Terminator 二进制未安装 (platform=${process.platform})。仅支持 Windows；开发环境请从 mediar-ai/terminator 构建。`,

      };

    }

    return { success: true, data: { id, type: 'stdio' }, hint: 'Bundled terminator validated.' };

  }



  // SSE/HTTP: test URL reachability

  if (server.type === 'sse' || server.type === 'http') {

    try {

      const controller = new AbortController();

      const timeout = setTimeout(() => controller.abort(), 15000);



      // Inject stored OAuth token if no explicit Authorization header

      const { resolveAuthHeaders } = await import('./mcp-oauth');

      const configHeaders = server.headers || {};

      const hasExplicitAuth = Object.keys(configHeaders).some(k => k.toLowerCase() === 'authorization');

      const oauthHeaders = hasExplicitAuth ? {} : await resolveAuthHeaders(server.id);



      const headers: Record<string, string> = {

        'Accept': server.type === 'sse' ? 'text/event-stream' : 'application/json, text/event-stream',

        'Accept-Encoding': 'identity',

        ...configHeaders,

        ...oauthHeaders,

      };



      const resp = server.type === 'http'

        ? await fetch(server.url!, {

            method: 'POST',

            headers: { ...headers, 'Content-Type': 'application/json' },

            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ZhiShi', version: '1.0' } } }),

            signal: controller.signal,

          })

        : await fetch(server.url!, { method: 'GET', headers, signal: controller.signal });



      clearTimeout(timeout);



      if (resp.status === 401 || resp.status === 403) {

        const hint = oauthHeaders['Authorization']

          ? 'OAuth token may be expired or revoked. Try re-authorizing.'

          : 'This server may require OAuth authorization. Use Settings UI or `zhishi mcp oauth start`.';

        return { success: false, error: `Authentication failed (HTTP ${resp.status}). ${hint}` };

      }

      if (!resp.ok) {

        return { success: false, error: `Server returned HTTP ${resp.status}` };

      }



      return { success: true, data: { id, type: server.type, status: resp.status }, hint: `Connection OK (HTTP ${resp.status}).` };

    } catch (err) {

      const msg = err instanceof Error ? err.message : String(err);

      if (msg.includes('abort')) return { success: false, error: 'Connection timed out (15s).' };

      return { success: false, error: `Connection failed: ${msg}` };

    }

  }



  // stdio: check command exists in PATH

  if (server.type === 'stdio' && server.command && server.command !== '__builtin__') {

    try {

      const { getShellEnv } = await import('./utils/shell');

      const checkCmd = process.platform === 'win32' ? 'where' : 'which';

      const { spawn } = await import('child_process');

      const code = await new Promise<number | null>(resolve => {

        const proc = spawn(checkCmd, [server.command!], { stdio: 'ignore', env: getShellEnv() });

        proc.on('close', resolve);

        proc.on('error', () => resolve(null));

      });

      if (code === 0) {

        return { success: true, data: { id, type: 'stdio', command: server.command }, hint: `Command '${server.command}' found.` };

      }

      return { success: false, error: `Command '${server.command}' not found in PATH.` };

    } catch (err) {

      return { success: false, error: `Failed to check command: ${err instanceof Error ? err.message : String(err)}` };

    }

  }



  return { success: true, data: { id, type: server.type }, hint: 'Configuration valid.' };

}



// ---------------------------------------------------------------------------

// MCP OAuth Handlers (CLI-facing wrappers around mcp-oauth module)

// ---------------------------------------------------------------------------



/** Resolve MCP server URL from config by ID */

function getMcpServerUrl(id: string): { url: string } | { error: string } {

  const allServers = getAllMcpServers();

  const server = allServers.find(s => s.id === id);

  if (!server) return { error: `MCP server '${id}' not found` };

  if (server.type !== 'sse' && server.type !== 'http') {

    return { error: `MCP server '${id}' is type '${server.type}' — OAuth only applies to sse/http servers.` };

  }

  if (!server.url) return { error: `MCP server '${id}' has no URL configured` };

  return { url: server.url };

}



export async function handleMcpOAuthDiscover(payload: { id: string }): Promise<AdminResponse> {

  const { id } = payload;

  if (!id) return { success: false, error: 'Missing required field: id' };

  const resolved = getMcpServerUrl(id);

  if ('error' in resolved) return { success: false, error: resolved.error };



  try {

    const { probeOAuthRequirement } = await import('./mcp-oauth');

    const result = await probeOAuthRequirement(id, resolved.url, true);

    return { success: true, data: { id, ...result } };

  } catch (err) {

    return { success: false, error: `OAuth discovery failed: ${err instanceof Error ? err.message : String(err)}` };

  }

}



export async function handleMcpOAuthStart(payload: {

  id: string;

  clientId?: string;

  clientSecret?: string;

  scopes?: string;

  callbackPort?: number;

}): Promise<AdminResponse> {

  const { id } = payload;

  if (!id) return { success: false, error: 'Missing required field: id' };

  const resolved = getMcpServerUrl(id);

  if ('error' in resolved) return { success: false, error: resolved.error };



  try {

    const { authorizeServer } = await import('./mcp-oauth');

    const manualConfig = payload.clientId ? {

      clientId: payload.clientId,

      clientSecret: payload.clientSecret,

      scopes: payload.scopes ? payload.scopes.split(/[,\s]+/).filter(Boolean) : undefined,

      callbackPort: payload.callbackPort,

    } : undefined;



    const { authUrl, waitForCompletion } = await authorizeServer(id, resolved.url, manualConfig);



    // Fire-and-forget: log completion but don't block the HTTP response.

    // CLI should poll `mcp oauth status <id>` to check completion.

    waitForCompletion.then(ok => {

      console.log(`[admin] OAuth ${ok ? 'completed' : 'failed/cancelled'} for MCP ${id}`);

    });



    return { success: true, data: { id, authUrl }, hint: 'Authorization started. Complete in browser, then check with `mcp oauth status`.' };

  } catch (err) {

    return { success: false, error: `OAuth start failed: ${err instanceof Error ? err.message : String(err)}` };

  }

}



export async function handleMcpOAuthStatus(payload: { id: string }): Promise<AdminResponse> {

  const { id } = payload;

  if (!id) return { success: false, error: 'Missing required field: id' };



  try {

    const { getOAuthStatus } = await import('./mcp-oauth');

    const result = getOAuthStatus(id);

    return { success: true, data: { id, ...result } };

  } catch (err) {

    return { success: false, error: `OAuth status check failed: ${err instanceof Error ? err.message : String(err)}` };

  }

}



export async function handleMcpOAuthRevoke(payload: { id: string }): Promise<AdminResponse> {

  const { id } = payload;

  if (!id) return { success: false, error: 'Missing required field: id' };



  try {

    const { revokeAuthorization } = await import('./mcp-oauth');

    await revokeAuthorization(id);

    return { success: true, data: { id }, hint: 'OAuth authorization revoked.' };

  } catch (err) {

    return { success: false, error: `OAuth revoke failed: ${err instanceof Error ? err.message : String(err)}` };

  }

}



// ---------------------------------------------------------------------------

// Model Provider Handlers

// ---------------------------------------------------------------------------



export function handleModelList(): AdminResponse {

  const config = loadConfig();

  const apiKeys = config.providerApiKeys ?? {};

  const verifyStatus = config.providerVerifyStatus ?? {};



  const allProviders = getAllEffectiveProviders(config);

  const data = allProviders.map(p => {

    const id = String(p.id);

    const cfg = p.config as Record<string, unknown> | undefined;

    return {

      id,

      name: String(p.name),

      vendor: p.vendor ? String(p.vendor) : undefined,

      baseUrl: cfg?.baseUrl ? String(cfg.baseUrl) : undefined,

      isBuiltin: !!p.isBuiltin,

      protocol: p.apiProtocol ? String(p.apiProtocol) : 'anthropic',

      enabled: p.enabled !== false,

      hasApiKey: !!apiKeys[id],

      status: (verifyStatus[id] as Record<string, unknown>)?.status ?? 'not-set',

    };

  });



  return { success: true, data };

}



export async function handleModelSetKey(payload: { id: string; apiKey: string }): Promise<AdminResponse> {

  const { id, apiKey } = payload;

  if (!id) return { success: false, error: 'Missing required field: id' };

  if (!apiKey) return { success: false, error: 'Missing required field: apiKey' };



  await atomicModifyConfig(c => ({

    ...c,

    providerApiKeys: { ...(c.providerApiKeys || {}), [id]: apiKey },

  }));



  broadcast('config:changed', { section: 'model', action: 'set-key', id });

  return { success: true, data: { id }, hint: `API key saved for ${id}.` };

}



export async function handleModelSetDefault(payload: { id: string }): Promise<AdminResponse> {

  const { id } = payload;

  if (!id) return { success: false, error: 'Missing required field: id' };

  if (isProviderDisabled(id)) {

    return { success: false, error: `Provider '${id}' is disabled. Re-enable it before setting it as default.` };

  }



  await atomicModifyConfig(c => ({

    ...c,

    defaultProviderId: id,

  }));



  broadcast('config:changed', { section: 'model', action: 'set-default', id });

  return { success: true, data: { id }, hint: `Default provider set to ${id}.` };

}



export async function handleModelVerify(payload: { id: string; model?: string }): Promise<AdminResponse> {

  const { id } = payload;

  if (!id) return { success: false, error: 'Missing required field: id' };



  const config = loadConfig();

  const apiKey = (config.providerApiKeys ?? {})[id];

  if (!apiKey) {

    return { success: false, error: `No API key set for provider '${id}'. Use 'zhishi model set-key' first.` };

  }



  // Look up provider config (preset or custom)

  const provider = findProvider(id);

  if (!provider) {

    return { success: false, error: `Provider '${id}' not found in presets or custom providers.` };

  }



  const providerConfig = (provider.config ?? {}) as Record<string, unknown>;

  const baseUrl = String(providerConfig.baseUrl ?? '');

  const authType = String(provider.authType ?? 'both');

  const apiProtocol = provider.apiProtocol as 'anthropic' | 'openai' | undefined;

  const userPrimary = (config.providerPrimaryModels as Record<string, string> | undefined)?.[id];

  const verifyModel = payload.model ?? userPrimary ?? String(provider.primaryModel ?? '');



  try {

    const { verifyProviderViaSdk } = await import('./provider-verify');

    const result = await verifyProviderViaSdk(

      baseUrl, apiKey, authType, verifyModel,

      apiProtocol,

      provider.maxOutputTokens ? Number(provider.maxOutputTokens) : undefined,

      provider.maxOutputTokensParamName as 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens' | undefined,

      provider.upstreamFormat as 'chat_completions' | 'responses' | undefined,

    );



    if (result.success) {

      // Persist verify status

      await atomicModifyConfig(c => ({

        ...c,

        providerVerifyStatus: {

          ...(c.providerVerifyStatus ?? {}),

          [id]: { status: 'valid', verifiedAt: new Date().toISOString() },

        },

      }));

      broadcast('config:changed', { section: 'model', action: 'verify', id });

      return { success: true, data: { id, model: verifyModel }, hint: 'Verification successful.' };

    }



    return { success: false, error: result.error ?? 'Verification failed', data: { id, detail: result.detail } };

  } catch (err) {

    return { success: false, error: `Verification error: ${err instanceof Error ? err.message : String(err)}` };

  }

}



export function handleModelAdd(payload: {

  provider: Record<string, unknown>;

  dryRun?: boolean;

}): AdminResponse {

  const { dryRun } = payload;

  const p = payload.provider;



  // Validate required fields

  if (!p.id) return { success: false, error: 'Missing required field: id' };

  if (!isValidId(String(p.id))) return { success: false, error: 'Invalid id: only alphanumeric, hyphens, and underscores allowed' };

  if (!p.name) return { success: false, error: 'Missing required field: name' };

  if (!p.baseUrl) return { success: false, error: 'Missing required field: baseUrl (API endpoint)' };

  if (!p.models || !Array.isArray(p.models) || p.models.length === 0) {

    return { success: false, error: 'Missing required field: models (at least one model ID required)' };

  }



  // Build model entities

  const modelSeries = (p.modelSeries as string) || String(p.id);

  const modelIds = p.models as string[];

  const modelNames = (p.modelNames as string[]) || modelIds;

  const models = modelIds.map((model, i) => ({

    model,

    modelName: modelNames[i] || model,

    modelSeries,

  }));



  // Build aliases

  let modelAliases: Record<string, string> | undefined;

  if (p.aliases && typeof p.aliases === 'object') {

    modelAliases = p.aliases as Record<string, string>;

  } else if (modelIds.length > 0) {

    // Default: map sonnet/opus/haiku to first model

    modelAliases = { sonnet: modelIds[0], opus: modelIds[0], haiku: modelIds[0] };

  }



  const providerObj = {

    id: String(p.id),

    name: String(p.name),

    vendor: String(p.vendor ?? p.name),

    cloudProvider: String(p.cloudProvider ?? ''),

    type: 'api' as const,

    primaryModel: String(p.primaryModel ?? modelIds[0]),

    isBuiltin: false,

    config: {

      baseUrl: String(p.baseUrl),

      ...(p.timeout ? { timeout: Number(p.timeout) } : {}),

      ...(p.disableNonessential ? { disableNonessential: true } : {}),

    },

    authType: String(p.authType ?? 'auth_token'),

    ...(p.protocol === 'openai' || p.apiProtocol === 'openai' ? {

      apiProtocol: 'openai' as const,

      ...(p.maxOutputTokens ? { maxOutputTokens: Number(p.maxOutputTokens) } : {}),

      ...(p.maxOutputTokensParamName ? { maxOutputTokensParamName: String(p.maxOutputTokensParamName) } : {}),

      upstreamFormat: String(p.upstreamFormat ?? 'chat_completions') as 'chat_completions' | 'responses',

    } : {}),

    websiteUrl: p.websiteUrl ? String(p.websiteUrl) : undefined,

    models,

    modelAliases,

  };



  if (dryRun) {

    return { success: true, dryRun: true, preview: providerObj };

  }



  // Write to ~/.zhishi/providers/{id}.json

  saveCustomProviderFile(providerObj);

  broadcast('config:changed', { section: 'model', action: 'add', id: providerObj.id });

  return {

    success: true,

    data: { id: providerObj.id, name: providerObj.name, models: modelIds },

    hint: `Provider added. Use 'zhishi model set-key ${providerObj.id} <key>' to set API key.`,

  };

}



export async function handleModelRemove(payload: { id: string }): Promise<AdminResponse> {

  const { id } = payload;

  if (!id) return { success: false, error: 'Missing required field: id' };

  if (!isValidId(id)) return { success: false, error: 'Invalid id: only alphanumeric, hyphens, and underscores allowed' };



  // Check if it's a preset

  const provider = findProvider(id);

  if (provider?.isBuiltin) {

    return { success: false, error: `Cannot remove built-in provider '${id}'. Only custom providers can be removed.` };

  }



  // Delete provider file

  if (!deleteCustomProviderFile(id)) {

    return { success: false, error: `Custom provider '${id}' not found.` };

  }



  // Clean up API key, verify status, and enablement/order stale IDs

  await atomicModifyConfig(c => {

    const apiKeys = { ...(c.providerApiKeys ?? {}) };

    delete apiKeys[id];

    const verifyStatus = { ...(c.providerVerifyStatus ?? {}) };

    delete verifyStatus[id];

    // If this was the default provider, clear it

    const defaultId = c.defaultProviderId === id ? undefined : c.defaultProviderId;

    // Strip the deleted id from providerOrder / disabledProviderIds so disk

    // state doesn't grow unbounded across delete-and-re-add cycles.

    const providerOrder = c.providerOrder?.filter(pid => pid !== id);

    const disabledProviderIds = c.disabledProviderIds?.filter(pid => pid !== id);

    return {

      ...c,

      providerApiKeys: apiKeys,

      providerVerifyStatus: verifyStatus,

      defaultProviderId: defaultId,

      providerOrder: providerOrder && providerOrder.length > 0 ? providerOrder : undefined,

      disabledProviderIds: disabledProviderIds && disabledProviderIds.length > 0 ? disabledProviderIds : undefined,

    };

  });



  broadcast('config:changed', { section: 'model', action: 'remove', id });

  return { success: true, data: { id }, hint: 'Provider removed.' };

}



// ---------------------------------------------------------------------------

// Agent Handlers

// ---------------------------------------------------------------------------



export function handleAgentList(): AdminResponse {

  const config = loadConfig();

  const agents = (config.agents ?? []).map(a => ({

    id: a.id,

    name: a.name,

    enabled: a.enabled,

    workspacePath: a.workspacePath,

    channelCount: (a.channels ?? []).length,

    channels: (a.channels ?? []).map(ch => ({

      id: ch.id,

      type: ch.type,

      name: ch.name,

      enabled: ch.enabled,

    })),

  }));

  return { success: true, data: agents };

}



export async function handleAgentEnable(payload: { id: string }): Promise<AdminResponse> {

  const { id } = payload;

  return modifyAgent(id, agent => ({ ...agent, enabled: true }), 'enable');

}



export async function handleAgentDisable(payload: { id: string }): Promise<AdminResponse> {

  const { id } = payload;

  return modifyAgent(id, agent => ({ ...agent, enabled: false }), 'disable');

}



export async function handleAgentSet(payload: { id: string; key: string; value: unknown }): Promise<AdminResponse> {

  const { id, key, value } = payload;

  if (!id) return { success: false, error: 'Missing required field: id' };

  if (!key) return { success: false, error: 'Missing required field: key' };



  // Protect sensitive/structural fields

  const protectedFields = ['id', 'channels'];

  if (protectedFields.includes(key)) {

    return { success: false, error: `Cannot directly set field '${key}'. Use specific commands instead.` };

  }



  // `runtime` field has a cross-runtime scrub policy (see

  // buildRuntimeChangePatch doc in shared/types/runtime.ts). A blind spread

  // here would leak the previous runtime's model/permissionMode/additionalArgs

  // into the new runtime — Codex CLI then rejects e.g. a Gemini model with

  // "model is not supported when using ChatGPT account". Route through the

  // helper so the CLI `zhishi agent set <id> runtime codex` path stays in

  // lockstep with the Chat / Settings / Launcher in-app paths.

  if (key === 'runtime') {

    if (typeof value !== 'string') {

      return { success: false, error: 'runtime must be a string' };

    }

    if (!VALID_RUNTIMES.includes(value as RuntimeType)) {

      return {

        success: false,

        error: `Unknown runtime: '${value}'. Valid: ${VALID_RUNTIMES.join(', ')}.`,

      };

    }

    return modifyAgent(

      id,

      agent => {

        const patch = buildRuntimeChangePatch(

          agent.runtimeConfig as RuntimeConfig | undefined,

          value as RuntimeType,

        );

        return { ...agent, runtime: patch.runtime, runtimeConfig: patch.runtimeConfig };

      },

      'set',

    );

  }



  return modifyAgent(id, agent => ({ ...agent, [key]: value }), 'set');

}


// ---------------------------------------------------------------------------

// Config Handlers

// ---------------------------------------------------------------------------



export function handleConfigGet(payload: { key: string }): AdminResponse {

  const { key } = payload;

  if (!key) return { success: false, error: 'Missing required field: key' };



  const config = loadConfig();

  const value = getNestedValue(config, key);

  if (value === undefined) {

    return { success: false, error: `Config key '${key}' not found` };

  }



  // Redact sensitive fields recursively

  const redacted = redactSensitiveValues(key, value);

  return { success: true, data: { key, value: redacted } };

}



export async function handleConfigSet(payload: { key: string; value: unknown; dryRun?: boolean }): Promise<AdminResponse> {

  const { key, value, dryRun } = payload;

  if (!key) return { success: false, error: 'Missing required field: key' };



  // Reject dangerous key paths (prototype pollution)

  if (hasDangerousKeySegment(key)) {

    return { success: false, error: 'Invalid key path' };

  }



  // Protect structural/sensitive keys that have dedicated commands

  const protectedKeys = ['providerApiKeys', 'providerVerifyStatus', 'agents', 'mcpServers', 'mcpEnabledServers', 'mcpServerEnv', 'mcpServerArgs', 'imBotConfigs'];

  const rootKey = key.split('.')[0];

  if (protectedKeys.includes(rootKey)) {

    return { success: false, error: `Cannot set '${key}' via config set. Use dedicated commands (e.g., 'zhishi mcp', 'zhishi agent', 'zhishi model set-key').` };

  }



  if (dryRun) {

    return { success: true, dryRun: true, preview: { key, value } };

  }



  await atomicModifyConfig(c => setNestedValue(c, key, value));

  broadcast('config:changed', { section: 'config', action: 'set', key });

  return { success: true, data: { key }, hint: `Config '${key}' updated.` };

}



// ---------------------------------------------------------------------------

// Status & Reload

// ---------------------------------------------------------------------------



export function handleStatus(): AdminResponse {

  const config = loadConfig();

  const allServers = getAllMcpServers(config);

  const enabledIds = getEnabledMcpServerIds(config);

  const currentMcp = getMcpServers();



  return {

    success: true,

    data: {

      mcpServers: { total: allServers.length, enabled: enabledIds.length },

      activeMcpInSession: currentMcp ? currentMcp.length : 0,

      defaultProvider: config.defaultProviderId ?? 'not set',

      agents: (config.agents ?? []).length,

    },

  };

}



export function handleReload(workspacePath?: string): AdminResponse {

  // Re-read config from disk and push effective MCP + sub-agents to in-memory state.

  // Workspace resolution: prefer explicit arg → fall back to the session's agentDir.

  // Without this fallback, sub-agent reload would only see global agents.

  const effectiveWorkspace = workspacePath || getCurrentWorkspacePath();



  const config = loadConfig();

  const allServers = getAllMcpServers(config);

  const globalEnabled = new Set(getEnabledMcpServerIds(config));



  let effectiveServers: McpServerDefinition[];



  if (effectiveWorkspace) {

    // Filter by project if workspace is known

    const projects = loadProjects();

    const project = projects.find(p => p.path === effectiveWorkspace);

    if (project) {

      const projectEnabled = new Set(project.mcpEnabledServers ?? []);

      effectiveServers = allServers.filter(s => globalEnabled.has(s.id) && projectEnabled.has(s.id));

    } else {

      // Workspace path doesn't match any registered project (transient state

      // during project-rename, or unregistered workspace). Without this

      // branch we'd silently push ZERO MCP servers — cross-review Agent-1

      // W6. Fall back to the "no workspace" branch (globally enabled) so

      // reload is a no-op on MCP rather than a destructive clear.

      console.warn(

        `[admin-api] handleReload: workspace ${effectiveWorkspace} not found in projects; falling back to global MCP set`,

      );

      effectiveServers = allServers.filter(s => globalEnabled.has(s.id));

    }

  } else {

    // Fallback: use all globally enabled servers

    effectiveServers = allServers.filter(s => globalEnabled.has(s.id));

  }



  // Sub-agent reload: re-scan the .md files on disk so edits to frontmatter

  // (model, description, tools) take effect without restarting the app.

  // Mirror /api/agents/enabled's resolution — project dir (if any) + user dir.

  //

  // We read BOTH sources of truth (MCP from config.json + agents from .md files)

  // before mutating any in-memory state, so a scan failure doesn't leave the

  // caller with a half-applied reload (MCP pushed but agents stale).

  const userAgentsBaseDir = join(getZhiShiDataDir(), 'agents');

  const projAgentsDir = effectiveWorkspace ? join(effectiveWorkspace, '.claude', 'agents') : '';

  let agents: ReturnType<typeof loadEnabledAgents>;

  try {

    agents = loadEnabledAgents(projAgentsDir, userAgentsBaseDir);

  } catch (err) {

    const msg = err instanceof Error ? err.message : String(err);

    console.error('[admin-api] handleReload: sub-agent re-scan failed:', err);

    return {

      success: false,

      error: `Failed to reload sub-agents from disk: ${msg}`,

    };

  }



  // Both sources loaded cleanly — now commit the in-memory state atomically

  // (well, as atomically as two module-level setters allow) and trigger the

  // forced restart that applies them.

  setMcpServers(effectiveServers);

  setAgents(agents);

  const agentCount = Object.keys(agents).length;



  // Force a session restart even for snapshotted (Tab / Cron / Background)

  // sessions — reload is an explicit request, not noise from React state

  // sync. Without this the in-memory config is refreshed but the running

  // SDK subprocess keeps delegating to the old sub-agent definitions (#98).

  // M4c: pi 引擎每 turn 读最新配置,无需 SDK 会话重载(原 forceReloadActiveSession)。



  broadcast('config:changed', { section: 'all', action: 'reload' });

  return {

    success: true,

    hint: `Configuration reloaded (MCP: ${effectiveServers.length}, sub-agents: ${agentCount}). The session will restart on the next turn to apply changes.`,

  };

}



// ---------------------------------------------------------------------------

// Help text

// ---------------------------------------------------------------------------



const HELP_TEXTS: Record<string, string> = {

  mcp: `zhishi mcp — Manage MCP tool servers



Commands:

  list                     List all MCP servers

  show <id>                Show one MCP server's config + enable state (env/headers redacted)

  add                      Add a new MCP server

  remove <id>              Remove a custom MCP server

  enable <id>              Enable an MCP server

  disable <id>             Disable an MCP server

  test <id>                Validate MCP server connectivity

  env <id> <action>        Manage environment variables

  oauth <action> <id>      Manage OAuth for HTTP/SSE servers



Options for 'add':

  --id          Server ID (required)

  --name        Display name (defaults to id)

  --type        stdio | sse | http (default: stdio)

  --command     Command to run (for stdio)

  --args        Arguments (repeatable)

  --url         Endpoint URL (for sse/http)

  --env         KEY=VALUE (repeatable)

  --headers     KEY=VALUE (repeatable, for sse/http)



Options for 'enable' / 'disable':

  --scope       global | project | both (default: both)



Options for 'env':

  set KEY=VALUE [KEY2=VALUE2 ...]

  get

  delete KEY [KEY2 ...]



OAuth subcommands:

  oauth discover <id>      Probe server for OAuth requirements

  oauth start <id>         Start OAuth authorization (opens browser)

  oauth status <id>        Check OAuth status

  oauth revoke <id>        Revoke stored OAuth token



Options for 'oauth start' (manual mode):

  --client-id      OAuth client ID (skip for auto mode)

  --client-secret  OAuth client secret

  --scopes         Scopes (comma or space separated)

  --callback-port  Local callback port`,



  model: `zhishi model — Manage model providers



Commands:

  list                     List all providers (preset + custom)

  add                      Add a custom provider

  remove <id>              Remove a custom provider

  set-key <id> <api-key>   Set API key for a provider

  verify <id> [--model m]  Verify API key (sends a test message)

  set-default <id>         Set default provider



Options for 'add':

  --id            Provider ID (required)

  --name          Display name (required)

  --base-url      API endpoint URL (required)

  --models        Model IDs (repeatable, at least one)

  --model-names   Display names for models (repeatable)

  --primary-model Default model (default: first in --models)

  --auth-type     auth_token | api_key | both (default: auth_token)

  --protocol      anthropic | openai (default: anthropic)

  --upstream-format  chat_completions | responses (openai only)

  --max-output-tokens  Max output limit (openai only)

  --aliases       SDK alias mapping: sonnet=model,opus=model,haiku=model

  --vendor        Vendor name

  --website-url   Provider website`,



  config: `zhishi config — Read/write application config



Commands:

  get <key>               Read a config value

  set <key> <value>       Set a config value`,



  appcraft: `zhishi appcraft — AppCraft workspace app automation (PRD 0.2.36)



Commands:

  record start --app <appId>      Start recording this session's terminator/cuse

                                  tool calls against a bound app

  record stop                     Stop recording and write the trace to

                                  .appcraft/<recordingId>/trace.json

  record status                   Show whether this session is recording

  list                              List recordings (.appcraft/) and automation skills

                                    (.claude/skills/ with trace.json) in the current workspace

  replay <skillName|recordingDir>   Replay a trace deterministically (no LLM).

                                    Also accepts a workspace-relative or

                                    absolute path to a trace dir / trace.json.



Options for 'replay':

  --var KEY=VALUE  Variable substitution for {{KEY}} placeholders (repeatable)

  --dry-run        Preview the resolved trace + planned tool calls without executing



Notes:

  - Recording is host-side: the sidecar captures the session's

    mcp__terminator__* / mcp__cuse__* tool calls from the assistant message

    stream and maps them to trace steps (UIA semantic channel preferred,

    vision coordinates as fallback).

  - Replay drives the bundled terminator-mcp-agent step-by-step (UIA steps)

    with cuse CLI atoms for vision steps. Exit code 0 = all steps passed;

    a failed step reports its index, reason and locator for the AI self-heal

    flow (requiresAiHeal when the step declared fallback: ai_vision).



Examples:

  zhishi appcraft record start --app kingdee

  zhishi appcraft record stop

  zhishi appcraft list

  zhishi appcraft replay monthly-report --var 月份=2026-06

  zhishi appcraft replay 20260719-103000 --dry-run`,



  env: `zhishi env — Inspect execution-environment engines (P1 E1)



Commands:

  engines                         Probe docker / Hyper-V / VirtualBox / VMware /
                                  libvirt / ssh and show install guidance



Examples:

  zhishi env engines                        # which engines are available?

  zhishi env engines --fresh                # bypass the 30s detect cache

  zhishi env engines --json



Why this exists:

  Session startup and environment recipes (env up/open, later tasks) need to

  know which container engine / hypervisor / ssh client this machine has

  BEFORE offering an execution environment. Missing engines come back with a

  one-line install hint so the user (or AI) knows the exact next step.`,



  research: `zhishi research — Research outcome signals (security researcher P1 D1)

Commands:
  log     Record one research outcome event (zhishi research log --task-kind ... --outcome ... --summary ...)
  list    List recorded events, latest first

Options for 'log':
  --task-kind       binary | pentest | ai-security | redteam | malware | intel | ctf (required)
  --outcome         success | fail | stuck (required)
  --summary         One-line outcome / blocker summary (required)
  --bug-class       stack-overflow | heap-overflow | uaf | double-free | oob-read | oob-write |
                    null-deref | int-overflow | format-string | type-confusion | other
  --trajectory-ref  Workspace-relative trajectory file path
  --workspace       Workspace path (default: cwd)

Options for 'list':
  --task-kind / --outcome   Filter (same enums as log)
  --limit                   Max rows (default 50)`,

  task: `zhishi task — Manage Task Center tasks (v0.1.69+)



Commands:

  list                            List tasks (filter via --workspaceId / --status / --tag)

  get <taskId>                    Task metadata + .task/ doc paths

  create-direct <name>            Create a task with inline task.md content

  create-from-alignment <sid>     Materialize a task from an alignment session

  update <taskId>                 Patch task fields (schedule / notification /

                                  prompt / overrides). Rejected while running.

  update-status <taskId> <status> Transition state (running/verifying/done/blocked/stopped)

  append-session <taskId> <sid>   Link an SDK session id to a task

  run <taskId>                    Dispatch a todo task for execution

  rerun <taskId>                  Reset to 'todo' and dispatch

  archive <taskId>                Soft-archive (with 30d retention)

  delete <taskId>                 Hard delete (alias: 'remove' for cron-CLI parity)



Options for 'create-direct':

  --name               Task name (required; may also be the 1st positional)

  --executor           'agent' | 'user' (default: agent)

  --description        Short description

  --workspaceId        Workspace id (required)

  --workspacePath      Absolute workspace path (required)

  --taskMdFile <path>  Read task.md body from a file (preferred for multi-line

                       markdown — avoids shell-escape hell). Max 1 MB.

  --taskMdContent      Inline task.md body (use --taskMdFile instead when

                       content spans multiple lines / has backticks / quotes).

                       Exactly one of --taskMdFile / --taskMdContent must be set.

  --executionMode      'once' | 'scheduled' | 'recurring' | 'loop' (default: once)

  --runMode            'single-session' | 'new-session'

  --tags               Comma-separated tag list

  --sourceThoughtId    Link back to the originating thought



Scheduling (for executionMode = 'recurring' / 'scheduled'; omitting

--intervalMinutes on recurring silently defaults to 60 min — the CLI now

emits a warning when you do):

  --intervalMinutes <n>            Fixed interval in minutes (recurring; min 5)

  --cronExpression "0 */3 * * *"   Cron expression (recurring; takes precedence over interval)

  --cronTimezone Asia/Shanghai     IANA tz id for cronExpression

  --dispatchAt 2026-06-01T09:00:00+08:00  Epoch-ms or ISO 8601 (scheduled mode;

                                          tz offset MUST be +HH:MM, not +HH)



Desktop notification:

  --notificationDesktop true|false Desktop notification toggle (default: true)

  --notificationEvents done,blocked,endCondition  Comma-separated events filter



Per-task overrides (all optional; omit to inherit workspace defaults):

  --model              Override model (builtin runtime model id)



Options for 'create-from-alignment' (identical override flags):

  Positional: <alignmentSessionId>

  --name               Task name (required)

  --executor --description --workspaceId --workspacePath

  --executionMode --runMode --tags --sourceThoughtId

  --model              (per-task override)



Options for 'update' <taskId>:

  Accepts every create-direct flag (each optional; missing = leave unchanged).

  Additional flags for clearing overrides:

    --clearProviderOverride   Reset providerId + model to follow Agent

  Update is rejected when the task is Running/Verifying.

  Notification semantics: --notification* flags MERGE with the existing

  config (CLI reads current state, overlays your values, then writes). So

  '--notificationDesktop false' preserves botChannelId / botThread / events.

  To clear bot routing entirely, recreate the task — empty values are

  rejected at the CLI boundary to catch typos.



Options for 'update-status':

  Positional: <taskId> <status>

  --message            Optional message attached to the transition



Output:

  - Default (human-readable) mode prints a compact summary + any override echo.

  - --json returns the full structured payload (task id, overrides, overridden[],

    inheritedFromWorkspace[], nextSteps.{dispatch,inspect}).



Examples:

  zhishi task list --workspaceId my-proj

  zhishi task create-direct --name "review PR" \\

      --workspaceId my-proj --workspacePath /path/to/my-proj \\

      --taskMdContent "Review the latest PR and file findings in progress.md" \\

      --model claude-sonnet-4-6

  # Recurring with desktop notification

  zhishi task create-direct --name "issue triage" \\

      --workspaceId my-proj --workspacePath /path/to/my-proj \\

      --taskMdFile /tmp/triage-prompt.md \\

      --executionMode recurring --intervalMinutes 180

  zhishi task create-from-alignment sess_abc --name "Ship feature X"

  zhishi task run t_abc123

  zhishi task update t_abc123 --intervalMinutes 240   # change cadence after the fact

  zhishi task update-status t_abc123 done --message "shipped in v0.1.70"



Related:

  zhishi agent show <id>          Inspect an agent's effective defaults first,

                                    so you know what you are overriding.`,



  widget: `zhishi widget — Generative UI widget design guidelines

(run 'zhishi widget readme' for the full design system + modules)



Use to render inline charts / SVG / dashboards in desktop Chat replies.

IM bot sessions don't render widgets.`,



  skill: `zhishi skill — Manage ZhiShi skills (user skills live under ~/.zhishi/skills/)



Commands:

  list                       List installed skills + enabled state

  info <name>                Show one skill's manifest + description

  remove <name>              Uninstall a skill   [--scope user|project]

  enable <name>              Enable an installed skill

  disable <name>             Disable without uninstalling`,



  agent: `zhishi agent — Manage agents



Commands:

  list                            List all agents

  show <id>                       Show an agent's effective runtime/model/permissionMode defaults

  enable <id>                     Enable an agent

  disable <id>                    Disable an agent

  set <id> <key> <value>          Set agent config field





Typical flow (AI preparing a task override):

  1. zhishi agent show <id>          — learn current defaults

  2. zhishi task create-direct ... --model <m>`




};



export function handleHelp(payload: { path?: string[] }): AdminResponse {

  const path = payload.path ?? [];

  const group = path[0];



  if (group && HELP_TEXTS[group]) {

    return { success: true, data: { text: HELP_TEXTS[group] } };

  }



  // Derive the group list from HELP_TEXTS so it can't drift as new commands

  // are added (issue #205 gap #5: the previous hardcoded list claimed only

  // 8 groups existed and omitted task / runtime and several newer groups,

  // turning `zhishi task --help` into a misleading "use one of these

  // unrelated groups" message). Append the leaf commands that aren't in

  // HELP_TEXTS but are still valid top-level invocations.

  const groups = Object.keys(HELP_TEXTS).sort();

  const leafCommands = ['status', 'reload', 'version'];

  const header = group

    ? `Unknown command group "${group}".`

    : 'zhishi — Available commands';

  return {

    success: true,

    data: {

      text: `${header}



Command groups (run "zhishi <group> --help" for details):

  ${groups.join(', ')}



Leaf commands:

  ${leafCommands.join(', ')}`,

    },

  };

}



// ---------------------------------------------------------------------------

// Version

// ---------------------------------------------------------------------------



// Compile-time injected by esbuild (scripts/esbuild-bundle.mjs `define`).

// In dev (`npm run server` via tsx, no esbuild), the identifier is undefined

// at runtime — the `?? process.env.…` chain below reaches the env fallback.

declare const __ZHISHI_VERSION__: string | undefined;



export function handleVersion(): AdminResponse {

  // Resolution order:

  //   1. esbuild-injected `__ZHISHI_VERSION__` (production sidecar bundle).

  //   2. `npm_package_version` (set by npm in dev when launched via scripts).

  //   3. `ZHISHI_VERSION` env override (build system / tests).

  //   4. 'dev' sentinel — visibly NOT a release version, so anyone reading

  //      `zhishi version` knows they're on an un-stamped build instead of

  //      seeing a stale hardcoded number that lies about which build is

  //      installed (issue #149: users had no way to tell whether the dmg they

  //      reinstalled actually contained the patched CLI/sidecar — the old

  //      hardcoded '0.1.70' fallback shipped in every release).

  const version = (typeof __ZHISHI_VERSION__ !== 'undefined' ? __ZHISHI_VERSION__ : undefined)

    ?? process.env.npm_package_version

    ?? process.env.ZHISHI_VERSION

    ?? 'dev';

  return { success: true, data: { version } };

}



// ---------------------------------------------------------------------------

// Task Center forwarding (v0.1.69)

//

// Trust-boundary note: the CLI stamps `actor` + `source` from its own env

// (AI subprocess = agent/cli, user terminal = user/cli) BEFORE posting here.

// We forward these fields verbatim to the Rust Management API. The renderer-

// originated path (Tauri IPC) never reaches this module — it goes through

// `cmd_task_update_status` in Rust which stamps `user/ui` authoritatively.

// ---------------------------------------------------------------------------



function qsFrom(params: Record<string, string | number | boolean | undefined>): string {

  const parts: string[] = [];

  for (const [k, v] of Object.entries(params)) {

    if (v === undefined) continue;

    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);

  }

  return parts.length ? `?${parts.join('&')}` : '';

}



export async function handleTaskList(payload: {

  workspaceId?: string;

  status?: string;

  tag?: string;

  includeDeleted?: boolean;

}): Promise<AdminResponse> {

  const resp = await managementApi(`/api/task/list${qsFrom(payload)}`);

  if (resp.ok) {

    return { success: true, data: (resp as Record<string, unknown>).tasks ?? [] };

  }

  return mgmtError(resp, 'Failed to list tasks');

}



export async function handleTaskGet(payload: { id: string }): Promise<AdminResponse> {

  const resp = await managementApi(`/api/task/get${qsFrom({ id: payload.id })}`);

  if (resp.ok) {

    return { success: true, data: (resp as Record<string, unknown>).task };

  }

  return mgmtError(resp, 'Failed to get task');

}



/**
 * Echo helper for task-create responses: which override fields did the
 * caller explicitly set? D20: runtime / permissionMode / runtimeConfig
 * overrides were removed with the external runtimes — only `model` remains.
 */
function computeOverriddenFields(payload: Record<string, unknown>): string[] {

  const fields = ['model'];

  return fields.filter(f => {

    const v = payload[f];

    return v !== undefined && v !== null && v !== '';

  });

}



export async function handleTaskCreateDirect(

  payload: Record<string, unknown>,

): Promise<AdminResponse> {

  const overridden = computeOverriddenFields(payload);

  const resp = await managementApi('/api/task/create-direct', 'POST', payload);

  const wrapped = wrapMgmtResponse(resp);

  const enriched = enrichTaskCreateResponse(wrapped, payload, overridden);

  return enriched;

}



export async function handleTaskCreateFromAlignment(

  payload: Record<string, unknown>,

): Promise<AdminResponse> {

  const overridden = computeOverriddenFields(payload);

  const resp = await managementApi('/api/task/create-from-alignment', 'POST', payload);

  const wrapped = wrapMgmtResponse(resp);

  const enriched = enrichTaskCreateResponse(wrapped, payload, overridden);

  return enriched;

}



export async function handleTaskRun(payload: { id: string }): Promise<AdminResponse> {

  const resp = await managementApi('/api/task/run', 'POST', payload);

  const wrapped = wrapMgmtResponse(resp);

  return wrapped;

}



export async function handleTaskRerun(payload: { id: string }): Promise<AdminResponse> {

  const resp = await managementApi('/api/task/rerun', 'POST', payload);

  const wrapped = wrapMgmtResponse(resp);

  return wrapped;

}



/**

 * Enrich a successful task-create response with:

 *   - the override values **as actually persisted** (read from the returned

 *     Task record, not echoed from the request — this proves the round-trip

 *     survived serde rather than just restating what the client sent);

 *   - `overridden` — the list of override fields the caller supplied that

 *     also show up on the persisted task (so "requested but dropped" is

 *     visible as a mismatch);

 *   - `nextSteps` — the next CLI commands the caller is most likely to run.

 *

 * No-op on failed responses (leaves the existing error / recoveryHint shape

 * untouched).

 */

function enrichTaskCreateResponse(

  response: AdminResponse,

  payload: Record<string, unknown>,

  requestedOverrides: string[],

): AdminResponse {

  if (!response.success) return response;

  const existing = (response.data ?? {}) as Record<string, unknown>;

  // Rust returns `{ task: {...} }` for task creation — unwrap so we can read

  // the authoritative persisted values.

  const persistedTask =

    (existing.task as Record<string, unknown> | undefined)

    ?? existing; // fallback for older Rust shapes that returned the task inline

  const taskId =

    typeof persistedTask.id === 'string'

      ? persistedTask.id

      : typeof existing.task_id === 'string'

        ? existing.task_id

        : typeof existing.taskId === 'string'

          ? existing.taskId

          : undefined;



  // Read the overrides from the persisted Task, NOT from the request payload.

  // If serde dropped a field (e.g., prior to v0.1.69 when `TaskCreateFromAlignmentInput`

  // lacked model/permission_mode), we want the mismatch to be visible here.

  const persistedOverrides = {

    runtime: (persistedTask.runtime as string | undefined) ?? null,

    model: (persistedTask.model as string | undefined) ?? null,

    permissionMode: (persistedTask.permissionMode as string | undefined) ?? null,

    runtimeConfig: persistedTask.runtimeConfig ?? null,

  };



  // The authoritative "overridden" list: fields the caller requested AND that

  // actually landed on the persisted task. If the two diverge, the extra

  // `overridesRequested` field (below) lets the caller detect the drop.

  const fieldsWithValue = Object.entries(persistedOverrides)

    .filter(([, v]) => v !== null && v !== undefined && v !== '')

    .map(([k]) => k);



  const enriched: Record<string, unknown> = {

    ...existing,

    overrides: persistedOverrides,

    overridden: fieldsWithValue,

    // If the client requested an override that didn't land, this exposes the

    // drift (a diff between these two arrays means "server silently dropped

    // a field you sent").

    overridesRequested: requestedOverrides,

    inheritedFromWorkspace:

      ['runtime', 'model', 'permissionMode'].filter(f => !fieldsWithValue.includes(f)),

  };

  if (taskId) {

    enriched.nextSteps = {

      dispatch: `zhishi task run ${taskId}`,

      inspect: `zhishi task get ${taskId}`,

    };

  }

  return { ...response, data: enriched };

}



/**

 * Patch a Task's fields after creation. Rust handler reuses `TaskStore::update`,

 * which is rejected on Running/Verifying tasks and projects schedule /

 * notification / override changes back to the linked CronTask. The CLI accepts

 * the same flag set as `task create-direct`, and the same override validator

 * runs first so a bad `--runtime` / `--model` / `--permissionMode` is caught

 * before serde would silently drop it.

 *

 * The payload's `id` field is required by Rust (`TaskUpdateInput.id`); CLI

 * promotes the positional `taskId` into `id` so callers don't have to know

 * the wire field name.

 */

export async function handleTaskUpdate(

  payload: Record<string, unknown>,

): Promise<AdminResponse> {

  if (typeof payload.id !== 'string' || payload.id.length === 0) {

    return { success: false, error: 'task id is required' };

  }

  const resp = await managementApi('/api/task/update', 'POST', payload);

  return wrapMgmtResponse(resp);

}



export async function handleTaskUpdateStatus(

  payload: Record<string, unknown>,

): Promise<AdminResponse> {

  // Infer actor/source if caller omitted them:

  //   Inside an AI subprocess → ZHISHI_PORT is set → actor=agent, source=cli.

  //   Otherwise (user ran `zhishi` in their terminal) → actor=user, source=cli.

  // `ZHISHI_PORT` is injected by `buildClaudeSessionEnv()` into SDK subproc

  // env (see cli_architecture.md); the user's own shell does NOT have it set

  // (the user's CLI binary reads `~/.zhishi/sidecar.port` instead).

  if (payload.actor === undefined) {

    payload.actor = process.env.ZHISHI_PORT ? 'agent' : 'user';

  }

  if (payload.source === undefined) {

    payload.source = 'cli';

  }

  const resp = await managementApi('/api/task/update-status', 'POST', payload);

  const wrapped = wrapMgmtResponse(resp);

  return wrapped;

}



export async function handleTaskAppendSession(payload: {

  id: string;

  sessionId: string;

}): Promise<AdminResponse> {

  const resp = await managementApi('/api/task/append-session', 'POST', payload);

  return wrapMgmtResponse(resp);

}



export async function handleTaskArchive(payload: {

  id: string;

  message?: string;

}): Promise<AdminResponse> {

  const resp = await managementApi('/api/task/archive', 'POST', payload);

  return wrapMgmtResponse(resp);

}



export async function handleTaskDelete(payload: { id: string }): Promise<AdminResponse> {

  const resp = await managementApi('/api/task/delete', 'POST', payload);

  const wrapped = wrapMgmtResponse(resp);

  return wrapped;

}



/**

 * Read a task's markdown doc (`task.md` / `verify.md` / `progress.md` /

 * `alignment.md`). Missing files return `{ ok: true, content: "" }` so

 * CLI scripting is idempotent. Task docs live under `~/.zhishi/tasks/<id>/`

 * since v0.1.69 — this endpoint is the agent-facing read path because the

 * AI runs in the workspace cwd and can't know the user-profile dir.

 */

export async function handleTaskReadDoc(payload: {

  id: string;

  doc: string;

}): Promise<AdminResponse> {

  const resp = await managementApi(

    `/api/task/read-doc${qsFrom(payload)}`,

  );

  if (resp.ok) {

    return { success: true, data: { content: (resp as Record<string, unknown>).content ?? '' } };

  }

  return mgmtError(resp, 'Failed to read task doc');

}



/**

 * Write `task.md` or `verify.md`. `progress.md` is agent-appended during

 * runs and rejected here; `alignment.md` is written by the alignment

 * skill via direct file-system access (not through this API).

 */

export async function handleTaskWriteDoc(payload: {

  id: string;

  doc: string;

  content: string;

}): Promise<AdminResponse> {

  const resp = await managementApi('/api/task/write-doc', 'POST', payload);

  return wrapMgmtResponse(resp);

}



// ---------------------------------------------------------------------------

// Session-scoped capabilities for the zhishi CLI (v0.1.67)

//

// These handlers expose Pattern 1 (context-injected) MCP tools to the `zhishi`

// CLI so the AI can reach ZhiShi-specific capabilities through plain shell

// tool calls instead of a Claude-Agent-SDK-only MCP protocol. See prd_0.1.67.

//

// Authorization model: Sidecar is session-scoped (1 Sidecar = 1 session), so

// the ambient session context (cron context) is already

// correctly bound to the calling Sidecar — no ZHISHI_SESSION_ID plumbing.

// ---------------------------------------------------------------------------






// ---------------------------------------------------------------------------

// Tool readme lookups — progressive disclosure (v0.1.67)

//

// Skill layer pre-injects BRIEF descriptions of these tools into the system

// prompt (system-prompt-cli-tools.ts). When the AI actually needs to use one,

// it calls `zhishi X readme` to pull the full usage doc on demand.

// ---------------------------------------------------------------------------




const README_WIDGET = `zhishi widget — Generative UI widget design guidelines



WHAT

  Returns the ZhiShi widget design system (color palette, component specs, layout rules) and the output format you MUST use to embed an interactive widget in a chat reply. Widgets render inline in the conversation — charts, SVG diagrams, interactive explainers, dashboards.



WHEN TO CALL

  Before outputting your first <generative-ui-widget> tag in a desktop chat reply. Reach for a widget whenever ${WIDGET_TRIGGER_GUIDANCE}



WHEN NOT TO CALL

  - One-line answers, chitchat

  - User explicitly asked for plain text / code / markdown

  - IM bot sessions (widgets only render in the desktop client)



COMMAND

  zhishi widget readme <module1> [<module2> ...]



MODULES

  chart         Chart.js line/bar/pie patterns, palette hex values, dashboards

  diagram       SVG flowcharts, architecture diagrams, connectors, markers

  interactive   Sliders, calculators, comparison cards, data records

  dashboard     Combines chart + interactive (multi-chart layouts + controls)

  art           SVG illustration / visual metaphor



EXAMPLES

  zhishi widget readme chart

  zhishi widget readme chart interactive

  zhishi widget readme dashboard



The output begins with the required <generative-ui-widget> output format contract; do not skip reading it.`;



export function handleReadme(payload: { topic?: string; modules?: string[] }): AdminResponse {

  const topic = (payload.topic ?? '').toLowerCase();


  if (topic === 'widget' || topic === 'generative-ui' || topic === 'ui') {

    const modules = (payload.modules ?? []).filter(m => typeof m === 'string' && m.length > 0);

    if (modules.length === 0) {

      // No modules passed → return the meta-readme describing modules

      return { success: true, data: { text: README_WIDGET } };

    }

    const text = buildReadMeContent(modules);

    // buildReadMeContent returns a generic "Unknown module(s). Available: ..."

    // sentinel when it can't resolve any of the given modules. Surface that as

    // a failure so the CLI exits non-zero and the AI gets a clear error.

    if (text.startsWith('Unknown module(s)')) {

      return { success: false, error: text };

    }

    return { success: true, data: { text } };

  }

  return {

    success: false,

    error: `Unknown readme topic "${payload.topic}". Available: widget.`,

  };

}



// ---------------------------------------------------------------------------

// Skill handlers (thin wrappers over /api/skill/* self-loopback; list scans

// the user skills dir directly — the marketplace/install pipeline was removed)

// ---------------------------------------------------------------------------



/** Disabled-list from ~/.zhishi/skills-config.json (same file the toggle route writes). */

function readDisabledSkills(): string[] {

  try {

    const configPath = join(getZhiShiDataDir(), 'skills-config.json');

    if (existsSync(configPath)) {

      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));

      if (Array.isArray(raw?.disabled)) return raw.disabled as string[];

    }

  } catch (err) {

    console.warn('[skills-config] Error reading config:', err);

  }

  return [];

}



export async function handleSkillList(): Promise<AdminResponse> {

  // User-level skills (~/.zhishi/skills) only. The project-scope half of the

  // old /api/skills route rode on the Tab sidecar's currentAgentDir; that

  // route was removed with the skills install pipeline (wave 3b).

  try {

    const skillsDir = join(getZhiShiDataDir(), 'skills');

    const disabled = readDisabledSkills();

    const skills: Array<Record<string, unknown>> = [];

    if (existsSync(skillsDir)) {

      for (const folder of readdirSync(skillsDir, { withFileTypes: true })) {

        if (!isDirEntry(folder, join(skillsDir, folder.name))) continue;

        if (isSkillBlockedOnPlatform(folder.name)) continue;

        const skillMdPath = join(skillsDir, folder.name, 'SKILL.md');

        if (!existsSync(skillMdPath)) continue;

        const content = readFileSync(skillMdPath, 'utf-8');

        const { name, description, author } = parseSkillFrontmatter(content);

        skills.push({

          name: name || folder.name,

          description: description || '',

          scope: 'user',

          path: skillMdPath,

          folderName: folder.name,

          author,

          enabled: !disabled.includes(folder.name),

        });

      }

    }

    return { success: true, data: skills };

  } catch (err) {

    return { success: false, error: err instanceof Error ? err.message : 'Failed to list skills' };

  }

}



export async function handleSkillInfo(payload: { name: string; scope?: 'user' | 'project' }): Promise<AdminResponse> {

  if (!payload.name) return { success: false, error: 'name is required' };

  const scope = payload.scope ?? 'user';

  const { json } = await sidecarSelf(`/api/skill/${encodeURIComponent(payload.name)}?scope=${scope}`);

  if (json.success) {

    return { success: true, data: json.skill ?? null };

  }

  return { success: false, error: String(json.error ?? 'Skill not found') };

}



export async function handleSkillRemove(payload: { name: string; scope?: 'user' | 'project' }): Promise<AdminResponse> {

  if (!payload.name) return { success: false, error: 'name is required' };

  const scope = payload.scope ?? 'user';

  const { json } = await sidecarSelf(

    `/api/skill/${encodeURIComponent(payload.name)}?scope=${scope}`,

    'DELETE',

  );

  if (json.success) return { success: true, data: { name: payload.name } };

  return { success: false, error: String(json.error ?? 'Failed to remove skill') };

}



export async function handleSkillToggle(payload: { name: string; enabled: boolean }): Promise<AdminResponse> {

  if (!payload.name) return { success: false, error: 'name is required' };

  const { json } = await sidecarSelf('/api/skill/toggle-enable', 'POST', {

    folderName: payload.name,

    enabled: payload.enabled,

  });

  if (json.success) return { success: true, data: { name: payload.name, enabled: payload.enabled } };

  return { success: false, error: String(json.error ?? 'Failed to toggle skill') };

}



// ---------------------------------------------------------------------------

// AppCraft (PRD 0.2.36 §6.4–§6.6) — workspace app-automation recordings &
// deterministic (LLM-free) trace replay.
//

// Directory contract (specs/tech_docs/appcraft_engine_contract.md §4):

//   recordings: <workspace>/.appcraft/<recordingId>/trace.json + frames/*.png

//   skills:     <workspace>/.claude/skills/<name>/trace.json (+ SKILL.md, frames/)
//

// Replay engine (2026-07-19 re-contract, appcraft_engine_contract.md §2/§4):

// the host drives terminator-mcp-agent MCP tools step-by-step (UIA semantic

// channel) with cuse CLI atoms as the vision fallback — cuse has NO replay

// subcommand (that was the old cuse-contract assumption). Degradation is a

// hard requirement: missing terminator binary → TERMINATOR_NOT_BUNDLED; a

// pure-vision trace runs without terminator.

// ---------------------------------------------------------------------------



/** Per-terminator-call timeout; replay steps drive real UI, keep it generous. */

const TERMINATOR_STEP_TIMEOUT_MS = 60_000;

/** One cuse CLI atom (click/type/key/scroll) should finish in seconds, not minutes. */

const CUSE_ATOM_TIMEOUT_MS = 120_000;



interface AppcraftTraceSummary {

  /** 'recording' = .appcraft/<id>; 'skill' = .claude/skills/<name> with a trace.json. */

  kind: 'recording' | 'skill';

  /** Directory name (recordingId or skill name). */

  id: string;

  app: string;

  stepCount: number;

  recordedAt: string;

  tracePath: string;

  /** 作品架账本（可选）：回放/自愈聚合，见 appcraft/run-log.ts。 */

  runs?: AppcraftRunStats;

}

/** Read + parse one trace.json directory; null when missing/malformed/unreadable. */

function summarizeAppcraftTrace(dir: string, kind: AppcraftTraceSummary['kind']): AppcraftTraceSummary | null {

  const tracePath = join(dir, 'trace.json');

  if (!existsSync(tracePath)) return null;

  try {

    const trace = parseAppcraftTrace(JSON.parse(readFileSync(tracePath, 'utf-8')));

    if (!trace) return null;

    return {

      kind,

      id: basename(dir),

      app: trace.app,

      stepCount: trace.steps.length,

      recordedAt: trace.recordedAt,

      tracePath,

    };

  } catch {

    return null;

  }

}

/** Enumerate a parent dir (.appcraft/ or .claude/skills/) for trace-bearing subdirs. */

function listAppcraftTraces(parentDir: string, kind: AppcraftTraceSummary['kind']): AppcraftTraceSummary[] {

  if (!existsSync(parentDir)) return [];

  let entries: Array<{ name: string; isDirectory(): boolean }>;

  try {

    entries = readdirSync(parentDir, { withFileTypes: true });

  } catch {

    return [];

  }

  const summaries: AppcraftTraceSummary[] = [];

  for (const entry of entries) {

    if (!entry.isDirectory()) continue;

    const summary = summarizeAppcraftTrace(join(parentDir, entry.name), kind);

    if (summary) summaries.push(summary);

  }

  // Newest first — matches how a user thinks about "my latest recording".

  return summaries.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));

}

/** Resolve the workspace in scope: explicit payload path, else the current sidecar session's workspace. */

function resolveAppcraftWorkspace(payload: { workspacePath?: string }): { workspacePath: string } | { error: AdminResponse } {

  const workspacePath = payload.workspacePath ?? getCurrentWorkspacePath();

  if (!workspacePath) {

    return {

      error: {

        success: false,

        error: 'No workspace in scope: pass workspacePath or run from a session bound to a workspace.',

      },

    };

  }

  return { workspacePath };

}



export async function handleAppcraftList(payload: { workspacePath?: string }): Promise<AdminResponse> {

  const resolved = resolveAppcraftWorkspace(payload);

  if ('error' in resolved) return resolved.error;

  const { workspacePath } = resolved;



  const recordings = listAppcraftTraces(join(workspacePath, '.appcraft'), 'recording');

  const skills = listAppcraftTraces(join(workspacePath, '.claude', 'skills'), 'skill');

  // 作品架账本（COWORK 任务5）：每个 skill/recording 附上成长叙事
  // （替你跑过几次 / 顺利几次 / 它自己修好过几次）。
  const runStats = aggregateAppcraftRunStats(workspacePath);
  for (const s of [...recordings, ...skills]) {
    const stats = runStats.get(s.id);
    if (stats && (stats.totalRuns > 0 || stats.heals > 0)) s.runs = stats;
  }



  return {

    success: true,

    data: { workspacePath, recordings, skills },

    scope: {

      workspacePath,

      source: payload.workspacePath ? 'explicit' : 'default',

      visibility: 'workspace',

    },

  };

}



interface CuseRunResult {

  code: number;

  stdout: string;

  stderr: string;

  timedOut: boolean;

  spawnError?: string;

}

/** Spawn cuse, capture stdout/stderr, kill on timeout. Never throws — spawn errors land in the result. */

async function runCuse(cusePath: string, args: string[], timeoutMs: number): Promise<CuseRunResult> {

  let proc: ReturnType<typeof spawnSubprocess>;

  try {

    proc = spawnSubprocess([cusePath, ...args], {

      stdin: 'ignore',

      stdout: 'pipe',

      stderr: 'pipe',

      windowsHide: true,

    });

  } catch (err) {

    return {

      code: -1,

      stdout: '',

      stderr: '',

      timedOut: false,

      spawnError: err instanceof Error ? err.message : String(err),

    };

  }



  const stdoutPromise = new Response(proc.stdout).text();

  const stderrPromise = new Response(proc.stderr).text();

  let timedOut = false;

  const timer = setTimeout(() => {

    timedOut = true;

    proc.kill();

  }, timeoutMs);

  try {

    const code = await proc.exited;

    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

    return { code, stdout, stderr, timedOut, spawnError: proc.error?.message };

  } finally {

    clearTimeout(timer);

  }

}

/** Resolve <skillName|recordingDir|path> to a concrete trace.json path within the workspace. */

function resolveAppcraftTraceTarget(

  target: string,

  workspacePath: string,

): { tracePath: string; kind: AppcraftTraceSummary['kind']; id: string } | { error: string } {

  // Bare name (no path separators, not a .json file): try skill name, then recording id.

  if (!/[/\\]/.test(target) && !target.endsWith('.json') && !target.includes('..')) {

    const skillTrace = join(workspacePath, '.claude', 'skills', target, 'trace.json');

    if (existsSync(skillTrace)) return { tracePath: skillTrace, kind: 'skill', id: target };

    const recordingTrace = join(workspacePath, '.appcraft', target, 'trace.json');

    if (existsSync(recordingTrace)) return { tracePath: recordingTrace, kind: 'recording', id: target };

    return { error: `No AppCraft skill or recording named '${target}' in this workspace.` };

  }



  // Explicit path (absolute or workspace-relative). Confined to the workspace

  // root via assertSafeFilePath — same guard IM media sending uses for

  // AI-supplied paths.

  try {

    const candidate = isAbsolute(target) ? target : resolve(workspacePath, target);

    const safe = assertSafeFilePath(candidate, { workspacePath, extraRoots: [] });

    const tracePath = statSync(safe).isDirectory() ? join(safe, 'trace.json') : safe;

    if (!existsSync(tracePath) || !isAppcraftTraceFileName(tracePath)) {

      return { error: `Path '${target}' does not resolve to an AppCraft trace.json.` };

    }

    return { tracePath, kind: 'skill', id: basename(resolve(tracePath, '..')) };

  } catch (err) {

    return { error: err instanceof Error ? err.message : String(err) };

  }

}



function isAppcraftTraceFileName(p: string): boolean {

  return basename(p) === 'trace.json';

}



/**
 * 想法流数据源（COWORK 任务7/8）：搭子的主动提醒——记忆库中未过期的
 * reminder 条目（按有效分排序），每条附来源（§7.3 红线）。
 */
export async function handleMemoryActiveReminders(): Promise<AdminResponse> {
  const distilled = readDistilled();
  const reminders = parseActiveReminders(distilled.reminders)
    .map((line) => parseReminderMeta(line))
    .filter((m): m is NonNullable<typeof m> => m !== null);
  return { success: true, data: { reminders } };
}

/**
 * 想法流反馈（阶段3 语义上线，KEYO 分寸工艺）：
 * - 'discuss'（捡起聊）→ usefulness 存款：这条提醒帮了忙，以后多浮；
 * - 'dismiss'（划走）  → salience 取款：被推开过就更克制，以后少浮。
 * UI 侧只有文本——按归一化内容键路由回库内条目。
 */
export async function handleMemoryReminderFeedback(payload: {
  text?: string;
  action?: 'discuss' | 'dismiss';
}): Promise<AdminResponse> {
  const text = typeof payload.text === 'string' ? payload.text : '';
  const action = payload.action;
  if (!text.trim() || (action !== 'discuss' && action !== 'dismiss')) {
    return { success: false, error: 'usage: memory/reminder-feedback { text, action: discuss|dismiss }' };
  }
  const entry = findByContent('reminder', text);
  if (!entry) return { success: true, data: { matched: false } };
  if (action === 'discuss') {
    touchEntry(entry.id, { usefulnessDelta: 0.3, salienceDelta: 0.05 });
  } else {
    touchEntry(entry.id, { salienceDelta: -0.15 });
  }
  return { success: true, data: { matched: true } };
}

/** 记忆检索（阶段4）：kind 过滤 + 文本/来源匹配 + 有效分排序。
 *  土匪回路入口：命中结果落 recall 日志——被展示≠有效，此处不动分，
 *  价值结算由蒸馏弧 judge 做效果门控（见 memory/distill-runner）。 */
export async function handleMemorySearch(payload: {
  q?: string;
  kinds?: MemoryKind[];
  limit?: number;
}): Promise<AdminResponse> {
  const results = searchEntries(payload.q ?? '', {
    kinds: Array.isArray(payload.kinds) ? payload.kinds : undefined,
    limit: typeof payload.limit === 'number' ? payload.limit : undefined,
  });
  try {
    logRecallEvents(results.map((r) => r.id), payload.q ?? '');
  } catch { /* 日志失败不阻塞检索 */ }
  return { success: true, data: { results } };
}

/** 搭子页的「它的样子」数据源：成长层一览（蒸馏认知 + 记忆统计 + 信任分）。 */
export async function handleMemoryOverview(): Promise<AdminResponse> {
  const distilled = readDistilled();
  const kinds: MemoryKind[] = [...MEMORY_KINDS];
  const counts: Record<string, number> = {};
  let recent: Array<{ kind: MemoryKind; content: string; lastTouchedAt: number }> = [];
  for (const k of kinds) {
    const list = listActive(k);
    counts[k] = list.length;
    recent.push(...list.map((e) => ({ kind: e.kind, content: e.content, lastTouchedAt: e.lastTouchedAt })));
  }
  recent = recent
    .sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)
    .slice(0, 3)
    .map((r) => ({ ...r, content: r.content.replace(/\s+/g, ' ').slice(0, 80) }));
  const ledger = readTrustLedger(1);
  return {
    success: true,
    data: {
      userModel: distilled.userModel,
      selfModel: distilled.selfModel,
      counts,
      recent,
      trustScore: ledger.score,
    },
  };
}

/**
 * 研究成败信号写入（安全研究员版 P1 D1）：LLM 自助记录入口
 * （zhishi research log）。枚举在 CLI 侧已校验，这里落库前由
 * recordResearchEvent 再校验一次（admin API 可被直接调用）。
 *
 * 确定性钩子（cron 终态）评估结论：cron 任务的状态迁移载荷（trust/event
 * 的 taskId/taskName/from/to）不携带 task_kind / bug_class / 轨迹指针等
 * 研究元数据，无法把一次 cron 完成/失败可靠关联到某个研究任务——硬做只会
 * 靠任务名关键词猜，落一堆脏数据。所以 D1 只做 LLM 自助入口；后续若 cron
 * 任务带上研究元数据（如 D3 安全蒸馏弧的 recurring Task），再比照
 * recordTrustTransition 在终态回调点加一行调用。
 */
export async function handleResearchLog(payload: {
  workspace?: string;
  taskKind?: string;
  outcome?: string;
  bugClass?: string;
  summary?: string;
  trajectoryRef?: string;
}): Promise<AdminResponse> {
  if (!payload || typeof payload.taskKind !== 'string' || typeof payload.outcome !== 'string' || typeof payload.summary !== 'string') {
    return { success: false, error: 'usage: research/log { workspace, taskKind, outcome, summary, bugClass?, trajectoryRef? }' };
  }
  try {
    const event = recordResearchEvent({
      workspace: typeof payload.workspace === 'string' && payload.workspace.trim() ? payload.workspace : '',
      taskKind: payload.taskKind as ResearchTaskKind,
      outcome: payload.outcome as ResearchOutcome,
      ...(typeof payload.bugClass === 'string' && payload.bugClass ? { bugClass: payload.bugClass as ResearchBugClass } : {}),
      summary: payload.summary,
      ...(typeof payload.trajectoryRef === 'string' && payload.trajectoryRef ? { trajectoryRef: payload.trajectoryRef } : {}),
    });
    return { success: true, data: { event } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 研究事件查询（zhishi research list）：taskKind/outcome 过滤 + limit。 */
export async function handleResearchList(payload: {
  taskKind?: string;
  outcome?: string;
  limit?: number;
}): Promise<AdminResponse> {
  const results = listResearchEvents({
    ...(typeof payload?.taskKind === 'string' && payload.taskKind ? { taskKind: payload.taskKind as ResearchTaskKind } : {}),
    ...(typeof payload?.outcome === 'string' && payload.outcome ? { outcome: payload.outcome as ResearchOutcome } : {}),
    ...(typeof payload?.limit === 'number' ? { limit: payload.limit } : {}),
  });
  return { success: true, data: { results } };
}

/** 情报索引更新（zhishi intel update）。mode 旗标 > config.json::intel.mode
 *  > INTEL_DEFAULTS；windowYears/maxSizeMb 恒取 config（无旗标）。长任务
 *  （首次全量回填）同步执行——CLI 侧等待期间 WAL 保证查询不受影响。 */
export async function handleIntelUpdate(payload: { mode?: string; nucleiFile?: string }): Promise<AdminResponse> {
  const intelCfg = (loadConfig() as { intel?: IntelConfig }).intel;
  const cfg = resolveIntelConfig(intelCfg);
  const requested = typeof payload?.mode === 'string' && payload.mode.trim() ? payload.mode.trim() : undefined;
  if (requested !== undefined && requested !== 'minimal' && requested !== 'window' && requested !== 'full') {
    return { success: false, error: `intel/update: 非法 mode "${requested}"（允许 minimal / window / full）` };
  }
  const mode = requested ?? cfg.mode;
  // nuclei 本地导入（zhishi intel update --nuclei-file）：网络不通时喂宿主机
  // curl 下载好的 cves.json；路径透传给 sync 的 nuclei 阶段（优先读，失败进 warnings）。
  const nucleiFile = typeof payload?.nucleiFile === 'string' && payload.nucleiFile.trim() ? payload.nucleiFile.trim() : undefined;
  try {
    const result = await runIntelUpdate({
      mode,
      windowYears: cfg.windowYears,
      maxSizeMb: cfg.maxSizeMb,
      ...(nucleiFile ? { nucleiFile } : {}),
    });
    if (!result.ok) {
      return { success: false, error: result.error ?? 'intel update 失败', data: { result } };
    }
    return { success: true, data: { result } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}


/** 情报索引状态（zhishi intel status）。未初始化返回 dbExists=false 不建库。
 *  progress 段来自 sync 模块的进度快照（1.1.4）：update 未跑时 inProgress=false；
 *  与 update 的并发互斥同源（inProgress）。 */
export function handleIntelStatus(): AdminResponse {
  try {
    const baseDir = getZhiShiDataDir();
    const cfg = resolveIntelConfig((loadConfig() as { intel?: IntelConfig }).intel);
    const dbExists = hasIntelDb(baseDir);
    const progress = getIntelProgress();
    const status = dbExists
      ? { ...getIntelStatus(openIntelStore(baseDir)), progress }
      : {
          dbExists: false,
          lastUpdateAt: null,
          mode: null,
          cveCount: 0,
          exploitCount: 0,
          nucleiCount: 0,
          nvdWatermark: null,
          dbFileSizeBytes: 0,
          progress,
        };
    return { success: true, data: { status, config: cfg } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
// ===== AI 面板控制（term）—— Rust panel_api 的薄代理 =====
// AI 经 CLI 驱动用户可见的内嵌终端（共事不代劳：操作发生在用户眼前）。
// 执行体是 Rust panel_api（127.0.0.1，端口在 panel-api.port）；sidecar 只做
// 转发，让 CLI 维持单端口约定（ZHISHI_PORT）。
// （W6 减法：browser/* 路由随无窗口宿主删除——子 webview 没有父窗口可依附。）

const PANEL_API_ROUTES = new Set([
  'term/open', 'term/list', 'term/write', 'term/read', 'term/close',
]);

export async function handlePanelProxy(route: string, payload: unknown): Promise<AdminResponse> {
  if (!PANEL_API_ROUTES.has(route)) {
    return { success: false, error: `unknown panel route: ${route}` };
  }
  let port: string;
  try {
    port = readFileSync(join(getZhiShiDataDir(), 'panel-api.port'), 'utf-8').trim();
  } catch {
    return {
      success: false,
      error: 'panel-api 未启动（app 未就绪或面板服务未运行）：未找到 panel-api.port',
    };
  }
  if (!port || !/^\d+$/.test(port)) {
    return {
      success: false,
      error: `panel-api 未启动（端口文件无效）: panel-api.port=${JSON.stringify(port)}`,
    };
  }
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(35_000), // eval 最长 30s + 余量
    });
    const text = await resp.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // Rust/axum 在反序列化失败等情况下会返回纯文本（如 "Failed to deserialize ..."），
      // 不应把整段响应当 JSON 解析失败抛给用户，而是透出原始文本与 HTTP 状态。
      return {
        success: false,
        error: `panel-api 返回非 JSON 响应 (HTTP ${resp.status}): ${text.slice(0, 300)}`,
      };
    }
    if (!resp.ok) {
      const msg =
        data && typeof data === 'object' && 'error' in data
          ? String((data as Record<string, unknown>).error)
          : `HTTP ${resp.status}`;
      return { success: false, error: `panel-api 调用失败: ${msg}` };
    }
    // D14 边界标记登记（P1 E6）：term/open 带 env 字段时在 sidecar 侧缓存
    // terminalId → envTag，供 agent-session 边界门控（classifyBoundary 的
    // envLookup）查询；term/close 注销。Rust TerminalManager 是持久载体，
    // 这里只是查询缓存，登记失败不阻塞开门。
    if (route === 'term/open' && data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      const env = (payload as Record<string, unknown> | null)?.env;
      if (typeof d.terminalId === 'string' && typeof env === 'string' && env.trim()) {
        registerTerminalEnvTag(d.terminalId, env.trim());
      }
    }
    if (route === 'term/close') {
      const terminalId = (payload as Record<string, unknown> | null)?.terminalId;
      if (typeof terminalId === 'string') unregisterTerminalEnvTag(terminalId);
    }
    return { success: true, data: data as Record<string, unknown> };
  } catch (err) {
    return {
      success: false,
      error: `panel-api unavailable（app 未就绪或端口 ${port} 不可达）: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * 信任账本写入口（宪章 §5.1）：Rust TaskStore 的状态迁移钩子经这里记账。
 * 缓冲兼容：sidecar 不在场时 Rust 落 trust.json，恢复后走 trust/import 补账。
 */
export async function handleTrustEvent(payload: TrustTransitionInput): Promise<AdminResponse> {
  if (!payload || typeof payload.taskId !== 'string' || typeof payload.from !== 'string' || typeof payload.to !== 'string') {
    return { success: false, error: 'usage: trust/event { taskId, taskName, from, to, actor, source? }' };
  }
  const recorded = recordTrustTransition(payload);
  return { success: true, data: { recorded } };
}

export async function handleTrustLedger(payload: { limit?: number }): Promise<AdminResponse> {
  return { success: true, data: readTrustLedger(payload.limit ?? 200) };
}

export async function handleTrustResolve(payload: { accepted?: boolean }): Promise<AdminResponse> {
  return { success: true, data: resolveTrustSuggestion(payload.accepted === true) };
}

export async function handleTrustReset(): Promise<AdminResponse> {
  return { success: true, data: resetTrustLedger() };
}

export async function handleTrustImport(payload: Parameters<typeof importTrustBuffer>[0]): Promise<AdminResponse> {
  importTrustBuffer(payload ?? {});
  return { success: true };
}

export async function handleAppcraftReplay(payload: {

  target?: string;

  vars?: Record<string, string>;

  workspacePath?: string;

  dryRun?: boolean;

  /** Explicit approval to run highRisk-marked steps (PRD §6.8, `--yes-high-risk`). */

  allowHighRisk?: boolean;

}): Promise<AdminResponse> {

  // 1. Validate input ---------------------------------------------------------

  const target = typeof payload.target === 'string' ? payload.target.trim() : '';

  if (!target) {

    return {

      success: false,

      error: 'Missing required argument: <skillName|recordingDir>',

      recoveryHint: {

        recoveryCommand: 'zhishi appcraft list',

        message: 'See available AppCraft recordings and skills.',

      },

    };

  }



  const resolvedWorkspace = resolveAppcraftWorkspace(payload);

  if ('error' in resolvedWorkspace) return resolvedWorkspace.error;

  const { workspacePath } = resolvedWorkspace;



  const vars: Record<string, string> =

    payload.vars && typeof payload.vars === 'object' && !Array.isArray(payload.vars)

      ? payload.vars

      : {};



  // 2. Resolve + parse the trace BEFORE spawning anything --------------------

  const resolved = resolveAppcraftTraceTarget(target, workspacePath);

  if ('error' in resolved) {

    return {

      success: false,

      error: resolved.error,

      recoveryHint: {

        recoveryCommand: 'zhishi appcraft list',

        message: 'See available AppCraft recordings and skills.',

      },

    };

  }



  let traceJson: unknown;

  try {

    traceJson = JSON.parse(readFileSync(resolved.tracePath, 'utf-8'));

  } catch (err) {

    return {

      success: false,

      error: `Failed to read trace file ${resolved.tracePath}: ${err instanceof Error ? err.message : String(err)}`,

    };

  }

  const trace = parseAppcraftTrace(traceJson);

  if (!trace) {

    return {

      success: false,

      error: `${resolved.tracePath} is not a valid AppCraft trace (missing numeric version / steps array).`,

    };

  }

  if (trace.steps.length === 0) {

    return { success: false, error: 'Trace contains no steps — nothing to replay.' };

  }



  // 3. Plan the replay — variable substitution + step→tool mapping (no spawn). -

  const boundApps = getEnabledBoundAppsForWorkspace(workspacePath);

  const plan = planReplay(trace, vars, boundApps);

  const needsTerminator = planNeedsTerminator(plan);

  const needsCuse = planNeedsCuse(plan);



  const terminatorPath = needsTerminator ? getBundledTerminatorPath() : null;

  if (needsTerminator && !terminatorPath) {

    return {

      success: false,

      code: 'TERMINATOR_NOT_BUNDLED',

      error: 'terminator-mcp-agent binary not bundled (non-Windows platform or incomplete install) — this trace has UIA steps that need it.',

    };

  }

  const cusePath = needsCuse ? getBundledCusePath() : null;

  if (needsCuse && !cusePath) {

    return {

      success: false,

      code: 'CUSE_NOT_BUNDLED',

      error: 'Bundled cuse binary not found (unsupported platform or incomplete install) — this trace has vision steps that need it.',

    };

  }



  // 4. Dry-run → preview (no spawn) -------------------------------------------

  if (payload.dryRun) {

    return {

      success: true,

      dryRun: true,

      preview: {

        tracePath: resolved.tracePath,

        kind: resolved.kind,

        id: resolved.id,

        app: trace.app,

        stepCount: trace.steps.length,

        vars,

        requiresTerminator: needsTerminator,

        requiresCuse: needsCuse,

        steps: plan.map((p) => ({

          stepIndex: p.stepIndex,

          action: p.action,

          channel: p.channel,

          call: p.call,

        })),

      },

    };

  }



  // 5. Unattended approval gate (design C): cron replays may only
  // operate apps the user has approved (a boundApp with matching process/exe in
  // the workspace). Interactive sessions are exempt by definition.
  // (Hub-task detection removed with the Team Hub client, 2026-08-06.)
  const isUnattended = !!getSessionCronContext();
  if (isUnattended) {
    const traceProcess = trace.appInfo?.process;
    const approved = boundApps.some(
      (a) => traceProcess && deriveProcessName(a.exe).toLowerCase() === traceProcess.toLowerCase(),
    );
    if (!approved) {
      return {
        success: false,
        code: 'APPCRAFT_REPLAY_UNAPPROVED_APP',
        error:
          `无人值守回放需要先批准目标应用（${traceProcess ?? trace.app}）。` +
          '在会话里运行该流程并点「允许并记住」，或在工作区设置中手动绑定该应用。',
        data: {
          requiresAppApproval: true,
          app: {
            process: traceProcess ?? trace.app,
            exe: trace.appInfo?.exe,
            windowTitle: trace.appInfo?.windowTitle,
          },
          tracePath: resolved.tracePath,
          kind: resolved.kind,
          id: resolved.id,
        },
      };
    }
  }

  // 6. Execute — one terminator MCP session reused for the whole replay; cuse

  // CLI atoms spawned per vision step. The structured report carries per-step

  // results and, on failure, the failed step index + reason + locator for the

  // AI self-heal flow (PRD §6.7).

  let terminator: TerminatorClient | undefined;

  try {

    if (terminatorPath) terminator = await TerminatorClient.start({ binaryPath: terminatorPath });

    const report = await replayTrace({

      trace,

      vars,

      boundApps,

      terminator,

      runCuse: cusePath ? (args) => runCuse(cusePath, args, CUSE_ATOM_TIMEOUT_MS) : undefined,

      toolTimeoutMs: TERMINATOR_STEP_TIMEOUT_MS,

      allowHighRisk: payload.allowHighRisk === true,

    });

    // 作品架账本（COWORK 任务5）：每次回放记一笔——成功失败都记，
    // 「替你跑过几次」是能力成长叙事的原料。best-effort，不影响回放结果。
    appendAppcraftRun(workspacePath, {
      ts: new Date().toISOString(),
      id: resolved.id,
      kind: resolved.kind,
      success: report.status === 'completed',
      executedSteps: report.executedSteps,
      stepCount: report.stepCount,
      ...(report.failure ? { failedStep: report.failure.stepIndex } : {}),
    });

    if (report.status === 'failed') {

      const failure = report.failure;

      const code = failure?.requiresApproval
        ? 'APPCRAFT_REPLAY_APPROVAL_REQUIRED'
        : failure?.requiresAiHeal
          ? 'APPCRAFT_REPLAY_NEEDS_AI_HEAL'
          : 'APPCRAFT_REPLAY_FAILED';

      // P2b-2 失败自动顺接 SOP 续跑（宪章 §6.3 智能兜底）：确定性失败且失败
      // 步骤声明了 fallback:'ai_vision' → 自动带着 SKILL.md 五段式上下文向本
      // 会话注入续跑消息，agent 切 SOP 模式完成剩余步骤。红线：高危拦截
      // （requiresApproval）到不了这里；无人值守（cron/Hub）不顺接（§8.2）；
      // 同会话同 skill 只注入一次（防续跑回合再失败形成注入循环）；注入前写
      // 审计行，续跑消息本身进会话记录（全程可见可打断）。failure 报告照常
      // 返回——UI 需要它展示失败详情。
      if (
        !isUnattended &&
        isSopContinuationEligible(report, resolved.kind) &&
        tryMarkSopContinuation(getSessionId(), resolved.id)
      ) {
        appendSopHealAudit(workspacePath, {
          ts: new Date().toISOString(),
          sessionId: getSessionId(),
          skill: resolved.id,
          failedStep: failure?.stepIndex ?? -1,
          action: failure?.action ?? '?',
          reason: failure?.reason ?? 'unknown',
          event: 'sop_continuation_started',
        });
        // M4c: SOP 续跑注入迁移到 pi 引擎(fire-and-forget 同语义)。
        void sendPiChatMessage({
          text: buildSopContinuationPrompt({
            skillId: resolved.id,
            tracePath: resolved.tracePath,
            vars,
            report,
          }),
        }).then((res) => {
          if (res?.error) {
            console.warn(`[appcraft/sop-continuation] continuation message rejected: ${res.error}`);
          }
        }).catch((err: unknown) => {
          console.warn('[appcraft/sop-continuation] continuation message inject failed:', err);
        });
      }

      return {

        success: false,

        code,

        error: `Replay failed at step ${failure?.stepIndex ?? '?'} (${failure?.action ?? '?'}): ${failure?.reason ?? 'unknown'}`,

        data: { ...report, tracePath: resolved.tracePath, kind: resolved.kind, id: resolved.id },

      };

    }

    return {

      success: true,

      data: { ...report, tracePath: resolved.tracePath, kind: resolved.kind, id: resolved.id },

    };

  } catch (err) {

    return {

      success: false,

      code: 'APPCRAFT_REPLAY_ENGINE_ERROR',

      error: `Replay engine error: ${err instanceof Error ? err.message : String(err)}`,

      data: { tracePath: resolved.tracePath, kind: resolved.kind, id: resolved.id },

    };

  } finally {

    if (terminator) await terminator.close().catch(() => undefined);

  }

}



// ---------------------------------------------------------------------------

// AppCraft recording (PRD 0.2.36 §6.4) — host-side capture of the session's

// terminator/cuse tool calls into .appcraft/<recordingId>/trace.json.

//

// Recording state is keyed by the sidecar's session (Session : Sidecar = 1:1);

// the actual capture happens in agent-session.ts's assistant-message hook.

// ---------------------------------------------------------------------------



export async function handleAppcraftRecordStart(payload: {

  appId?: string;

  workspacePath?: string;

}): Promise<AdminResponse> {

  // appId is OPTIONAL (design C zero-config): omit it to record whatever the
  // agent touches — the recorder captures the target process from the first
  // tool call. Passing an explicit appId still validates against boundApps.
  const appId = typeof payload.appId === 'string' ? payload.appId.trim() : '';

  const resolved = resolveAppcraftWorkspace(payload);

  if ('error' in resolved) return resolved.error;

  const { workspacePath } = resolved;



  const result = startRecording(getSessionId(), workspacePath, appId, {
    captureKeyframe: defaultCaptureKeyframe,
  });

  if (!result.ok) {

    return { success: false, code: 'APPCRAFT_RECORD_START_FAILED', error: result.error };

  }

  return {

    success: true,

    data: { recordingId: result.recordingId, appId, workspacePath },

  };

}



export async function handleAppcraftRecordStop(): Promise<AdminResponse> {

  const result = await stopRecording(getSessionId());

  if (!result.ok) {

    return { success: false, code: 'APPCRAFT_RECORD_STOP_FAILED', error: result.error };

  }

  return {

    success: true,

    data: { recordingId: result.recordingId, tracePath: result.tracePath, stepCount: result.stepCount },

  };

}



export async function handleAppcraftRecordStatus(): Promise<AdminResponse> {

  return { success: true, data: getRecordingStatus(getSessionId()) };

}






/**

 * 安全研究员版 P1 E1 — probe local execution-environment engines

 * (docker / Hyper-V / VirtualBox / VMware / libvirt / ssh) and return the

 * structured report with per-engine install guidance. Cached for 30s;

 * `forceFresh: true` (CLI `--fresh`) bypasses the cache for a real re-probe.

 */

export async function handleEnvironmentEngines(payload: {

  forceFresh?: boolean;

}): Promise<AdminResponse> {

  try {

    const report = await detectEnvironmentEnginesCached(undefined, {

      forceFresh: payload.forceFresh === true,

    });

    return { success: true, data: report };

  } catch (err) {

    return {

      success: false,

      error: `Environment engine probe failed: ${err instanceof Error ? err.message : String(err)}`,

    };

  }

}



// ---------------------------------------------------------------------------

// 安全研究员版 P1 E3 — named-environment registry (config.json::environments)

// ---------------------------------------------------------------------------



/** `environment/list` — list all registered environments (legacy configs → []). */

export function handleEnvironmentList(): AdminResponse {

  return { success: true, data: { environments: listEnvironments(loadConfig()) } };

}



/** `environment/add` — validate then persist a new entry (id must be unique). */

export async function handleEnvironmentAdd(

  payload: Record<string, unknown>,

): Promise<AdminResponse> {

  const validated = validateEnvironmentEntry(payload);

  if (!validated.ok) return { success: false, error: validated.error };

  const entry = { ...validated.entry, createdAt: new Date().toISOString() };

  // OS 家族自动判定:vm 条目带 vmx 且未显式声明 → 读 .vmx 的 guestOS
  // (纯宿主文件读,VM 关着也能判;os-family.ts)。读不到保持缺省 linux。
  if (entry.kind === 'vm' && entry.vmx && !entry.osFamily) {

    const detected = detectOsFamilyFromVmx(entry.vmx);

    if (detected) entry.osFamily = detected;

  }

  try {

    const saved = await atomicModifyConfig((config) => {

      const added = addEnvironmentEntry(listEnvironments(config), entry);

      if (!added.ok) throw new Error(added.error);

      return { ...config, environments: added.entries };

    });

    return { success: true, data: { environments: saved.environments, added: entry } };

  } catch (err) {

    return { success: false, error: err instanceof Error ? err.message : String(err) };

  }

}



/** `environment/remove` — remove an entry by id. */

export async function handleEnvironmentRemove(payload: {

  id?: string;

}): Promise<AdminResponse> {

  const id = typeof payload.id === 'string' ? payload.id.trim() : '';

  if (!id) return { success: false, error: 'Missing required argument: <id>' };

  try {

    let removedId = '';

    const saved = await atomicModifyConfig((config) => {

      const removed = removeEnvironmentEntry(listEnvironments(config), id);

      if (!removed.ok) throw new Error(removed.error);

      removedId = removed.removed.id;

      return { ...config, environments: removed.entries };

    });

    return { success: true, data: { environments: saved.environments, removed: removedId } };

  } catch (err) {

    return { success: false, error: err instanceof Error ? err.message : String(err) };

  }

}



/**

 * `environment/open` — resolve the entry to an access command and open it in

 * the embedded terminal via the same panel proxy path as `term open --cmd`.

 * Response carries the panel's data (terminalId) plus the resolved command.

 */

export async function handleEnvironmentOpen(payload: {

  id?: string;

  workspacePath?: string;

  rows?: number;

  cols?: number;

}): Promise<AdminResponse> {

  const id = typeof payload.id === 'string' ? payload.id.trim() : '';

  if (!id) {

    return {

      success: false,

      error: 'Missing required argument: <id>',

      recoveryHint: {

        recoveryCommand: 'zhishi env list',

        message: 'See registered environment ids.',

      },

    };

  }

  const entry = findEnvironmentEntry(listEnvironments(loadConfig()), id);

  if (!entry) {

    return {

      success: false,

      error: `未找到环境 "${id}"`,

      recoveryHint: {

        recoveryCommand: 'zhishi env list',

        message: 'See registered environment ids.',

      },

    };

  }

  const resolved = resolveEnvOpenCommand(entry);

  if (!resolved.ok) return { success: false, error: resolved.error };

  // D14 边界标记（P1 E6）：按条目 kind 生成 envTag（docker:<c> / vm:<name> /

  // range:<host>），随 term/open 透传到 Rust 会话并登记进 sidecar 查询缓存——

  // 之后 agent 对该终端的 write/read 被边界门控判为 in-env，自动放行。

  const envTag = envTagForEntry(entry);

  const opened = await handlePanelProxy('term/open', {

    workspacePath: payload.workspacePath || process.cwd(),

    rows: payload.rows,

    cols: payload.cols,

    cmd: resolved.cmd,

    env: envTag,

  });

  if (!opened.success) return opened;

  return {

    success: true,

    data: { ...(opened.data as Record<string, unknown>), envId: entry.id, cmd: resolved.cmd },

  };

}



// ---------------------------------------------------------------------------

// 安全研究员版 P1 E4 — environment recipes（环境配方）+ docker 生命周期

// ---------------------------------------------------------------------------



/** `environment/recipes` — 扫描配方根目录；invalid 配方带原因列出，不炸整体。 */

export function handleEnvironmentRecipes(): AdminResponse {

  try {

    const root = defaultRecipesRoot();

    return { success: true, data: { root, recipes: scanRecipes(root) } };

  } catch (err) {

    return {

      success: false,

      error: `Environment recipes scan failed: ${err instanceof Error ? err.message : String(err)}`,

    };

  }

}



/** `environment/up` — build + 起常驻容器（docker 配方）/ 拷贝模板 + 起 VM（vm 配方，P2 vmrun 驱动）。 */

export async function handleEnvironmentUp(payload: {

  recipe?: string;

  workspace?: string;

  vmBase?: string;

  user?: string;

  keyPath?: string;

  passwordRef?: string;

}): Promise<AdminResponse> {

  const id = typeof payload.recipe === 'string' ? payload.recipe.trim() : '';

  if (!id) {

    return {

      success: false,

      error: 'Missing required argument: <recipe>',

      recoveryHint: {

        recoveryCommand: 'zhishi env recipes',

        message: 'See available environment recipes.',

      },

    };

  }

  const recipe = loadRecipe(defaultRecipesRoot(), id);

  if (!recipe) {

    return {

      success: false,

      error: `未找到环境类型 "${id}"`,

      recoveryHint: {

        recoveryCommand: 'zhishi env recipes',

        message: 'See available environment recipes.',

      },

    };

  }

  if (!recipe.valid) {

    return {

      success: false,

      error: `环境类型 "${id}" 无效：${recipe.invalidReasons.join('；')}`,

    };

  }

  const workspace = typeof payload.workspace === 'string' && payload.workspace.trim()

    ? payload.workspace.trim()

    : process.cwd();

  // VM 配方（P2）：按 frontmatter vm_engine 分发驱动（缺省 vmware）。
  // vmware 走 D22 直连：vmTemplates 条目就是环境本身，up 后回写 env 条目
  // （id = recipe.id，kind: vm，vmx 为 down/rm/ps 定位锚），幂等重 up。
  // hyperv/vbox 仍是派生实例模型（id = 实例名，拿到地址才回写条目）。
  // vmBase 解析顺序（P2 V6）：--vm-base 旗标 > 配方 frontmatter vm_base >
  // config.json::vmTemplates（env adopt 的产出）。vmTemplates 回落只对
  // vmware 生效（P2 B3）——hyperv/vbox 的模板引用只走 vm_base/--vm-base，
  // 缺模板时由驱动报「adopt/build 暂只支持 vmware」的引导。
  if (recipe.base === 'vm') {

    const driver = resolveVmDriver(recipe);

    const template = driver === 'vmware' ? loadConfig().vmTemplates?.[recipe.id] : undefined;

    const vmBase = typeof payload.vmBase === 'string' && payload.vmBase.trim()

      ? payload.vmBase.trim()

      : template?.vmx;

    const user = typeof payload.user === 'string' && payload.user.trim()

      ? payload.user.trim()

      : template?.user ?? recipe.vmUser;

    const keyPath = typeof payload.keyPath === 'string' && payload.keyPath.trim()

      ? payload.keyPath.trim()

      : template?.keyPath;

    // guest-exec 凭据引用(D-T4):旗标 > 模板;断网 VM 的执行通道靠它。
    const passwordRef = typeof payload.passwordRef === 'string' && payload.passwordRef.trim()

      ? payload.passwordRef.trim()

      : template?.passwordRef;

    const result = driver === 'hyperv'

      ? await hypervEnvUp(recipe, workspace, { vmBase })

      : driver === 'vbox'

        ? await vboxEnvUp(recipe, workspace, { vmBase })

        : await vmEnvUp(recipe, workspace, { vmBase });

    if (!result.ok) return { success: false, error: result.error };

    const instance = result.instance;

    // D22：vmware 条目 id = recipe.id（一台 VM 一个条目），vmx 是定位锚，
    // 无论是否拿到 address 都登记（down/rm/ps 靠 vmx）。幂等重 up：同 id
    // 条目先摘再加（刷新 address / vmx），不报「已存在」。hyperv/vbox 仍
    // 是派生实例模型：id = 实例名，只在拿到地址时回写。
    if (driver === 'vmware' || instance.address) {

      try {

        const entry = driver === 'vmware'

          ? {

              id: recipe.id,

              kind: 'vm' as const,

              name: `${recipe.name}（${recipe.id}）`,

              recipeId: recipe.id,

              vmName: recipe.id,

              vmx: (instance as VmInstance).vmx,

              // OS 家族:vmx 静态判定(guestOS 字段),读不到缺省 linux。
              ...((instance as VmInstance).vmx && detectOsFamilyFromVmx((instance as VmInstance).vmx)
                ? { osFamily: detectOsFamilyFromVmx((instance as VmInstance).vmx)! }
                : {}),

              ...(instance.address ? { address: instance.address } : {}),

              ...(user ? { user } : {}),

              ...(keyPath ? { keyPath } : {}),

              ...(passwordRef ? { passwordRef } : {}),

              createdAt: new Date().toISOString(),

            }

          : {

              id: instance.name,

              kind: 'vm' as const,

              name: `${recipe.name}（${recipe.id}）`,

              recipeId: recipe.id,

              vmName: instance.name,

              ...(instance.address ? { address: instance.address } : {}),

              ...(user ? { user } : {}),

              ...(keyPath ? { keyPath } : {}),

              ...(passwordRef ? { passwordRef } : {}),

              createdAt: new Date().toISOString(),

            };

        await atomicModifyConfig((config) => {

          let entries = listEnvironments(config);

          if (findEnvironmentEntry(entries, entry.id)) {

            const removed = removeEnvironmentEntry(entries, entry.id);

            if (!removed.ok) throw new Error(removed.error);

            entries = removed.entries;

          }

          const added = addEnvironmentEntry(entries, entry);

          if (!added.ok) throw new Error(added.error);

          return { ...config, environments: added.entries };

        });

      } catch (err) {

        console.warn(`[environment/up] VM 已启动但 env 条目回写失败：${err instanceof Error ? err.message : String(err)}`);

      }

    }

    return { success: true, data: { instance } };

  }

  const result = await envUp(recipe, workspace, {

    logDir: join(getZhiShiDataDir(), 'logs', 'environments'),

  });

  if (!result.ok) return { success: false, error: result.error };

  // docker 配方回写注册表条目（与 VM 路径对齐）：id = 容器名，container 是
  // 执行通道（docker exec）与 ps/down 的定位锚。幂等重 up：同 id 先摘再加。
  // 此前 docker up 不回写 → 环境选不进、env_exec 无条目可解析（断点修复）。
  try {

    const entry = {

      id: result.instance.name,

      kind: 'docker' as const,

      name: `${recipe.name}（${recipe.id}）`,

      recipeId: recipe.id,

      container: result.instance.name,

      // 配方工具自检:构建后当场验声明工具真实存在(声明与实装的漂移
      // 证据落进条目;失败降级为无自检,不阻断 up)。
      ...(await runRecipeToolCheck(result.instance.name, recipe.tools)),

      createdAt: new Date().toISOString(),

    };

    await atomicModifyConfig((config) => {

      let entries = listEnvironments(config);

      if (findEnvironmentEntry(entries, entry.id)) {

        const removed = removeEnvironmentEntry(entries, entry.id);

        if (!removed.ok) throw new Error(removed.error);

        entries = removed.entries;

      }

      const added = addEnvironmentEntry(entries, entry);

      if (!added.ok) throw new Error(added.error);

      return { ...config, environments: added.entries };

    });

  } catch (err) {

    console.warn(`[environment/up] docker 已启动但 env 条目回写失败：${err instanceof Error ? err.message : String(err)}`);

  }

  return { success: true, data: { instance: result.instance } };

}



/** 配方工具自检(env up 构建后 + domain check 用):docker exec 进容器逐
 *  个 command -v。通道失败(容器死了/引擎没了)→ null(降级为无自检)。 */
export async function runRecipeToolCheck(
  container: string,
  tools: string[],
): Promise<{ toolCheck?: { ok: boolean; missing: string[]; checkedAt: string } }> {
  if (tools.length === 0) return {};
  try {
    const r = await execInEnvironment(
      { id: container, kind: 'docker', container, createdAt: '' },
      buildToolCheckCommand(tools),
      { timeoutMs: 30_000 },
    );
    if (!r.ok) return {};
    const result = parseToolCheckOutput(r.stdout, tools);
    return { toolCheck: { ...result, checkedAt: new Date().toISOString() } };
  } catch {
    return {};
  }
}

/** `environment/down` — 停一个实例。路由顺序（P2 B3 + D22）：id 以 .vmx
 * 结尾 → vmware 直停；登记条目 kind=vm 且带 vmx → vmware（id → vmx 解析
 * 在本层做，vm-lifecycle 不读 config）；Hyper-V 名字命中 → Stop-VM；
 * VirtualBox 名字命中 → controlvm acpipowerbutton；否则按 docker 容器处理
 * （stop + rm）。引擎探测失败容错（没装不炸路由，落到下一个）。 */

export async function handleEnvironmentDown(payload: {

  id?: string;

}): Promise<AdminResponse> {

  const id = typeof payload.id === 'string' ? payload.id.trim() : '';

  if (!id) {

    return {

      success: false,

      error: 'Missing required argument: <id>',

      recoveryHint: {

        recoveryCommand: 'zhishi env ps',

        message: 'See running environment instances.',

      },

    };

  }

  // D22 直连：vmware 命中规则 = id 以 .vmx 结尾（直停），或登记条目
  // kind=vm 且带 vmx（在这里把 env id 解析成 vmx）。

  const downEntry = findEnvironmentEntry(listEnvironments(loadConfig()), id);

  const vmwareVmx = /\.vmx$/i.test(id)

    ? id

    : downEntry?.kind === 'vm' && downEntry.vmx

      ? downEntry.vmx

      : undefined;

  const vmwareHit = vmwareVmx !== undefined;

  const target = routeVmTarget({

    vmwareInstance: vmwareHit,

    hypervVm: vmwareHit ? false : await hypervVmExists(id),

    vboxVm: vmwareHit ? false : await vboxVmExists(id),

  });

  if (target === 'vmware') {

    const vmResult = await vmEnvDown(vmwareVmx!);

    if (!vmResult.ok) return { success: false, error: vmResult.error };

    return { success: true, data: { removed: vmResult.stopped } };

  }

  if (target === 'hyperv') {

    const hypervResult = await hypervEnvDown(id);

    if (!hypervResult.ok) return { success: false, error: hypervResult.error };

    return { success: true, data: { removed: hypervResult.stopped } };

  }

  if (target === 'vbox') {

    const vboxResult = await vboxEnvDown(id);

    if (!vboxResult.ok) return { success: false, error: vboxResult.error };

    return { success: true, data: { removed: vboxResult.stopped } };

  }

  const result = await envDown(id);

  if (!result.ok) return { success: false, error: result.error };

  return { success: true, data: { removed: result.removed } };

}



/** W1 — snapshot/rollback 的条目解析:登记 vm 环境 + vmx 定位;docker

 * 明确「暂未支持」,其余形态给可读错误。 */

function resolveSnapshotTarget(id: string): { vmx: string } | { error: string } {

  const entry = findEnvironmentEntry(listEnvironments(loadConfig()), id);

  if (!entry) return { error: `环境 "${id}" 未登记(zhishi env list 查看)` };

  if (entry.kind === 'docker') {

    return {

      error:

        `docker 环境 "${id}" 的快照/回滚暂未支持——` +

        '留现场请用环境内 task.md + 越界提取,或改用 VM 环境(vmrun 快照)',

    };

  }

  if (entry.kind !== 'vm' || !entry.vmx) {

    return {

      error: `环境 "${id}" 不是带 vmx 定位的 VM 条目(kind=${entry.kind}),快照仅支持登记了 vmx 的 vm 环境`,

    };

  }

  return { vmx: entry.vmx };

}



/** `domain/list` — 域包清单(P2 多域抽象层):全部已装载的 domain.json。 */

export function handleDomainList(): AdminResponse {

  const manifests = loadDomainManifests();

  return {
    success: true,
    data: {
      domains: manifests.map((m) => ({
        kind: m.kind,
        name: m.name,
        recipes: m.recipes,
        skills: m.skills,
        subagents: m.subagents,
        signalCount: m.signals.length,
        acceptance: m.acceptance,
      })),
    },
  };

}

/** `domain/check` — 就绪自检(「先补齐能力再测」的机器可验形态):
 *  引用完整性(配方/skill/subagent 存在)+ 信号正则可编译 + 验收清单非空。 */

export async function handleDomainCheck(payload: { id?: string }): Promise<AdminResponse> {

  const manifests = loadDomainManifests();

  const target = typeof payload.id === 'string' ? payload.id.trim() : '';

  const ctx = buildDomainCheckContext();

  const checkOne = async (m: ReturnType<typeof loadDomainManifests>[number]) => {
    const issues = validateDomainManifest(m, ctx);
    // 配方工具自检(现场证据):域内每个配方的 docker 环境在跑就验一次。
    const dockerEntries = listEnvironments(loadConfig()).filter(
      (e) => e.kind === 'docker' && e.container,
    );
    const recipes = scanRecipes(defaultRecipesRoot());
    for (const recipeId of m.recipes) {
      const recipe = recipes.find((r) => r.id === recipeId);
      const entry = dockerEntries.find((e) => e.container === recipeId || e.name?.includes(recipeId));
      if (!recipe || !entry?.container || recipe.tools.length === 0) continue;
      const check = await runRecipeToolCheck(entry.container, recipe.tools);
      if (check.toolCheck && !check.toolCheck.ok) {
        issues.push({
          level: 'error',
          message: `配方 "${recipeId}" 工具漂移:声明了但环境里没有:${check.toolCheck.missing.join('、')}`,
        });
      }
    }
    return {
      kind: m.kind,
      name: m.name,
      ok: issues.filter((i) => i.level === 'error').length === 0,
      issues,
      acceptance: m.acceptance,
    };
  };

  if (target) {
    const m = manifests.find((x) => x.kind === target || x.name === target);
    if (!m) return { success: false, error: `未找到域 "${target}"(zhishi domain list 查看)` };
    return { success: true, data: await checkOne(m) };
  }
  const results = [];
  for (const m of manifests) results.push(await checkOne(m));
  return { success: true, data: { domains: results } };

}

/** domain check 的引用上下文:现有配方 id + skill 文件夹名(bundled+用户库)
 *  + subagent 目录名。 */
function buildDomainCheckContext(): DomainCheckContext {
  const recipeIds = new Set(scanRecipes(defaultRecipesRoot()).map((r) => r.id));
  const skillIds = new Set<string>();
  const skillsDirs = [resolveBundledSkillsDir(), join(getZhiShiDataDir(), 'skills')];
  for (const d of skillsDirs) {
    if (!d || !existsSync(d)) continue;
    for (const f of readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) skillIds.add(f.name);
    }
  }
  const subagentIds = new Set<string>();
  const agentsDir = resolveBundledDir('bundled-agents');
  if (agentsDir && existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir, { withFileTypes: true })) {
      if (f.isDirectory()) subagentIds.add(f.name);
    }
  }
  return { recipeIds, skillIds, subagentIds };
}

/** `environment/snapshot` — W1(design-spec §6.4 `/snapshot [名]`):对登记

 * vm 环境的 vmx 打 vmrun snapshot,名称缺省 zhishi-<ts>。 */

export async function handleEnvironmentSnapshot(payload: {

  id?: string;

  name?: string;

}): Promise<AdminResponse> {

  const id = typeof payload.id === 'string' ? payload.id.trim() : '';

  if (!id) {

    return { success: false, error: 'Missing required argument: <id>' };

  }

  const target = resolveSnapshotTarget(id);

  if ('error' in target) return { success: false, error: target.error };

  const result = await snapshotVm(target.vmx, typeof payload.name === 'string' ? payload.name : undefined);

  if (!result.ok) return { success: false, error: result.error };

  return { success: true, data: { id, snapshot: result.name } };

}



/** `environment/rollback` — W1(design-spec §6.1「回现场」`/rollback @snap`):

 * vmrun revertToSnapshot;运行中先 stop soft(失败补 hard),原本在跑则

 * revert 后 start nogui 恢复可用——语义对齐 env up 的 revert。 */

export async function handleEnvironmentRollback(payload: {

  id?: string;

  snapshot?: string;

}): Promise<AdminResponse> {

  const id = typeof payload.id === 'string' ? payload.id.trim() : '';

  if (!id) {

    return { success: false, error: 'Missing required argument: <id>' };

  }

  const snapshot = typeof payload.snapshot === 'string' ? payload.snapshot.trim() : '';

  if (!snapshot) {

    return { success: false, error: 'Missing required argument: <snapshot>(快照名,environment/snapshot 可打)' };

  }

  const target = resolveSnapshotTarget(id);

  if ('error' in target) return { success: false, error: target.error };

  const result = await rollbackVm(target.vmx, snapshot);

  if (!result.ok) return { success: false, error: result.error };

  return { success: true, data: { id, snapshot: result.snapshot, restarted: result.restarted } };

}



/** `environment/extract` — 成果回收(design §6.4 收尾 / §6.6 越界模态的
 * 首个真实触发面):把环境内文件 scp 回宿主 `<workspace>/output/extracted/
 * <envId>/`。这是「写宿主」类越界——先过 boundary-ask 通道问人(TUI 红
 * 色模态),批准才动手,拒绝/超时即中止。凭据纪律:只用 keyPath(D-T4)。 */

export async function handleEnvironmentExtract(payload: {

  id?: string;

  guestPath?: string;

  workspace?: string;

}): Promise<AdminResponse> {

  const id = typeof payload.id === 'string' ? payload.id.trim() : '';

  if (!id) return { success: false, error: 'Missing required argument: <id>' };

  const guestPath = typeof payload.guestPath === 'string' ? payload.guestPath.trim() : '';

  if (!guestPath) return { success: false, error: 'Missing required argument: <guestPath>(环境内绝对路径)' };

  const entry = findEnvironmentEntry(listEnvironments(loadConfig()), id);

  if (!entry) return { success: false, error: `未找到环境 "${id}"` };

  const resolved = resolveSshTarget(entry);

  if (!resolved.ok) return { success: false, error: resolved.error };

  const { target } = resolved;

  const workspace = typeof payload.workspace === 'string' && payload.workspace.trim()

    ? payload.workspace.trim()

    : process.cwd();

  const destDir = join(workspace, 'output', 'extracted', id);

  // 越界询问:写宿主。人批准前 HTTP 请求一直 pending(TUI 模态在等)。
  const approved = await requestBoundaryAsk({

    kind: 'host-write',

    objects: [`${id}:${guestPath}`, `→ 宿主 ${destDir}`],

  });

  if (!approved) return { success: false, error: '越界提取已被拒绝或超时(写宿主需人批准)' };

  ensureDirSync(destDir);
  const argv = [

    'scp',

    '-o', 'StrictHostKeyChecking=accept-new',

    '-o', 'BatchMode=yes',

    ...(target.keyPath ? ['-i', target.keyPath] : []),

    ...(target.port ? ['-P', String(target.port)] : []),

    `${target.destination}:${guestPath}`,

    destDir,

  ];

  const proc = spawnSubprocess([resolveCommand(argv[0]), ...argv.slice(1)], {

    env: augmentedProcessEnv(),

    stdin: 'ignore',

    stdout: 'pipe',

    stderr: 'pipe',

    windowsHide: true,

  });

  const stderrPromise = new Response(proc.stderr).text();

  const timer = setTimeout(() => proc.kill(), 120_000);

  try {

    const exitCode = await proc.exited;

    const stderr = await stderrPromise;

    if (exitCode !== 0) {

      return { success: false, error: `scp 提取失败(exit=${exitCode}):\n${stderr.trim().split('\n').slice(-3).join('\n')}` };

    }

    const base = guestPath.replace(/\/+$/, '').split('/').pop() ?? 'extracted';

    return { success: true, data: { savedTo: join(destDir, base) } };

  } finally {

    clearTimeout(timer);

  }

}



/** `environment/rm` — 拆除环境（P2 B4 / B3 多驱动 + D22）。vmware 直连
 * 语义：rm = 只摘登记（removeEnvironmentEntry），**绝不删用户 VM 文件**——
 * 这是真实 VM 不是一次性拷贝；运行中拒绝（先 down）。.vmx 直传 → 报错
 * 引导（env rm 只对登记条目）。Hyper-V 名字命中 → hypervEnvRm（Remove-VM
 * + 删实例目录）；VirtualBox 名字命中 → vboxEnvRm（unregistervm --delete）。
 * docker 实例的删除已含在 env down 里，不走 rm。 */

export async function handleEnvironmentRm(payload: {

  id?: string;

}): Promise<AdminResponse> {

  const id = typeof payload.id === 'string' ? payload.id.trim() : '';

  if (!id) {

    return {

      success: false,

      error: 'Missing required argument: <id>',

      recoveryHint: {

        recoveryCommand: 'zhishi env ps',

        message: 'See running environment instances.',

      },

    };

  }

  // D22 直连：.vmx 直传没有登记语境——env rm 只对登记条目，VM 文件用户自管。

  if (/\.vmx$/i.test(id)) {

    return {

      success: false,

      error: 'env rm 只对登记条目生效（只摘登记，不动 VM 文件）；VM 文件请自行管理',

    };

  }

  const rmEntry = findEnvironmentEntry(listEnvironments(loadConfig()), id);

  if (rmEntry?.kind === 'vm') {

    // 运行中拒绝：先 down（真实 VM 的现场可能比登记值钱）

    if (rmEntry.vmx) {

      const ps = await vmEnvPs();

      if (ps.ok && ps.vmxes.some((v) => normalizeVmxPath(v) === normalizeVmxPath(rmEntry.vmx!))) {

        return {

          success: false,

          error: `环境 "${id}" 的 VM 还在运行——先 zhishi env down ${id}，确认不要了再 rm`,

        };

      }

    }

    try {

      await atomicModifyConfig((config) => {

        const removed = removeEnvironmentEntry(listEnvironments(config), id);

        if (!removed.ok) throw new Error(removed.error);

        return { ...config, environments: removed.entries };

      });

    } catch (err) {

      return { success: false, error: err instanceof Error ? err.message : String(err) };

    }

    return { success: true, data: { removed: id } };

  }

  if (await hypervVmExists(id)) {

    const hypervResult = await hypervEnvRm(id);

    if (!hypervResult.ok) return { success: false, error: hypervResult.error };

    return { success: true, data: { removed: hypervResult.removed } };

  }

  if (await vboxVmExists(id)) {

    const vboxResult = await vboxEnvRm(id);

    if (!vboxResult.ok) return { success: false, error: vboxResult.error };

    return { success: true, data: { removed: vboxResult.removed } };

  }

  return {

    success: false,

    error: `env rm 只对 VM 环境条目生效；"${id}" 未命中登记条目 / Hyper-V / VirtualBox（zhishi env list 查看已有环境）`,

  };

}



/** `environment/exec` — guest-exec 通道（P2 B2）：对 kind=vm 且无 address 的
 * 断网隔离 VM，经 vmrun 客户机通道（runProgramInGuest + copyFileFromGuest）
 * 执行一次性命令并取回 stdout/exitCode。guestPassword 是 CLI 现场输入的瞬传
 * 值（vmrun 只认密码），只用于本次调用，绝不落盘（D-T4）。 */

export async function handleEnvironmentExec(payload: {

  id?: string;

  command?: string;

  guestUser?: string;

  guestPassword?: string;

}): Promise<AdminResponse> {

  const id = typeof payload.id === 'string' ? payload.id.trim() : '';

  if (!id) {

    return {

      success: false,

      error: 'Missing required argument: <id>',

      recoveryHint: {

        recoveryCommand: 'zhishi env list',

        message: 'See named environments.',

      },

    };

  }

  const command = typeof payload.command === 'string' ? payload.command : '';

  if (!command.trim()) {

    return {
      success: false,
      error: 'Missing required argument: <command>（zhishi env exec <env-id> -- <command...>）',
    };

  }

  const entry = findEnvironmentEntry(listEnvironments(loadConfig()), id);

  if (!entry) {

    return { success: false, error: `未找到环境 "${id}"（zhishi env list 查看已有环境）` };

  }

  const result = await vmGuestExec(entry, command, {

    guestUser: typeof payload.guestUser === 'string' && payload.guestUser.trim() ? payload.guestUser.trim() : undefined,

    guestPassword: typeof payload.guestPassword === 'string' && payload.guestPassword ? payload.guestPassword : undefined,

  }, { templates: loadConfig().vmTemplates });

  if (!result.ok) return { success: false, error: result.error };

  return { success: true, data: { stdout: result.stdout, exitCode: result.exitCode } };

}



/** `environment/ps` — 运行中实例合集（P2 B3 四源 + D22）：docker 容器
 * （zhishi.env label）+ vmware 环境（vmrun list ∩ 登记条目 vmx）+
 * Hyper-V（Get-VM 'zhishi-*'）+ VirtualBox（list runningvms ∩ zhishi-）。
 * 单侧引擎缺席不拖垮其余——只有全部失败才报错。 */

export async function handleEnvironmentPs(): Promise<AdminResponse> {

  const [dockerResult, vmResult, hypervResult, vboxResult] = await Promise.all([

    envPs(),

    vmEnvPs(),

    hypervEnvPs(),

    vboxEnvPs(),

  ]);

  if (!dockerResult.ok && !vmResult.ok && !hypervResult.ok && !vboxResult.ok) {

    return {

      success: false,

      error: [dockerResult, vmResult, hypervResult, vboxResult]

        .map((r) => (r.ok ? '' : r.error))

        .filter(Boolean)

        .join('\n'),

    };

  }

  // D22 直连：vmrun list 的运行中 vmx ∩ 登记条目（kind=vm 且有 vmx）→
  // 运行中环境（路径比较统一规整：大小写 / 斜杠方向不敏感）。未登记的
  // running VM 不列——那是用户在 Workstation 里手动起的机器，不归 zhishi 管。

  const vmInstances = vmResult.ok

    ? listEnvironments(loadConfig())

        .filter((e) => e.kind === 'vm' && e.vmx && vmResult.vmxes.some((v) => normalizeVmxPath(v) === normalizeVmxPath(e.vmx!)))

        .map((e) => ({

          id: e.id,

          name: e.name ?? e.id,

          vmx: e.vmx!,

          address: e.address,

          status: 'running',

          recipe: e.name ?? '',

          workspace: '',

          driver: 'vm' as const,

        }))

    : [];

  const instances = [

    ...(dockerResult.ok ? dockerResult.instances.map((i) => ({ ...i, driver: 'docker' as const })) : []),

    ...vmInstances,

    ...(hypervResult.ok ? hypervResult.instances.map((i) => ({ ...i, driver: 'hyperv' as const })) : []),

    ...(vboxResult.ok ? vboxResult.instances.map((i) => ({ ...i, driver: 'vbox' as const })) : []),

  ];

  return { success: true, data: { instances } };

}

/**
 * `environment/discover` — D28 自动发现本机环境（只读，不写配置）。
 *
 * 并行扫描宿主机：docker 全量容器（含已退出，去掉 zhishi.env 过滤）+ VMware
 * 全量 vmx + Hyper-V 全量 VM + VirtualBox 全量 VM。任一引擎缺席/不可用都走
 * safe 降级（该侧返回空数组），绝不抛错、绝不拖垮其它侧。结果只用于 gate 的
 * 「本机已有」分组，**从不回写 config.json**（D28 约束①）。
 */
export interface DiscoveredVm {
  driver: 'vmware' | 'hyperv' | 'vbox';
  id: string;
  name: string;
  /** VMware 的 vmx 绝对路径（hyperv/vbox 无此项，用 name 作唯一键）。 */
  vmx?: string;
  state: string;
  /** guest OS 家族（vmware 从 vmx 静态判定；其余缺省 linux）。 */
  osFamily?: 'linux' | 'windows';
}

export async function handleEnvironmentDiscover(): Promise<AdminResponse> {
  const [dockerResult, vmResult, hypervResult, vboxResult] = await Promise.all([
    envPsAll(),
    vmEnvPs(),
    hypervEnvPs(),
    vboxEnvPs(),
  ]);

  const docker = dockerResult.ok ? dockerResult.instances : [];

  const vm: DiscoveredVm[] = [
    ...(vmResult.ok
      ? vmResult.vmxes.map((v) => {
          const norm = normalizeVmxPath(v);
          return {
            driver: 'vmware' as const,
            id: norm,
            name: v.split(/[\\/]/).pop() ?? v,
            vmx: norm,
            state: 'unknown',
            // OS 家族顺带判定(vmx 静态读,VM 关着也能判)——gate 选中即
            // 带正确家族,三通道分派自动走对包装。
            osFamily: detectOsFamilyFromVmx(norm) ?? 'linux',
          };
        })
      : []),
    ...(hypervResult.ok
      ? hypervResult.instances.map((i) => ({
          driver: 'hyperv' as const,
          id: i.name,
          name: i.name,
          state: i.status ?? 'unknown',
        }))
      : []),
    ...(vboxResult.ok
      ? vboxResult.instances.map((i) => ({
          driver: 'vbox' as const,
          id: i.name,
          name: i.name,
          state: i.status ?? 'unknown',
        }))
      : []),
  ];

  return { success: true, data: { docker, vm } };
}



/** `environment/adopt` — 模板认领（P2 V6）：把一台已有系统的 VM 自动养成
 * 配方模板（连通 → guest 初始化 → setup.sh → 关机 → 快照），产出落
 * config.json::vmTemplates，之后 `env up <vm 配方>` 免 --vm-base。
 * password 是 CLI 现场输入的瞬传值，只用于本次 SSH 通道，绝不落盘（D-T4）。 */

export async function handleEnvironmentAdopt(payload: {

  recipe?: string;

  vmx?: string;

  user?: string;

  keyPath?: string;

  password?: string;

  passwordRef?: string;

}): Promise<AdminResponse> {

  const id = typeof payload.recipe === 'string' ? payload.recipe.trim() : '';

  if (!id) {

    return {

      success: false,

      error: 'Missing required argument: <recipe>',

      recoveryHint: {

        recoveryCommand: 'zhishi env recipes',

        message: 'See available environment recipes.',

      },

    };

  }

  const vmx = typeof payload.vmx === 'string' ? payload.vmx.trim() : '';

  if (!vmx) {

    return { success: false, error: 'Missing required argument: --vm <模板.vmx>' };

  }

  const recipe = loadRecipe(defaultRecipesRoot(), id);

  if (!recipe) {

    return { success: false, error: `未找到环境类型 "${id}"` };

  }

  if (!recipe.valid) {

    return { success: false, error: `环境类型 "${id}" 无效：${recipe.invalidReasons.join('；')}` };

  }

  const result = await vmTemplateAdopt(recipe, {

    vmx,

    user: typeof payload.user === 'string' && payload.user.trim() ? payload.user.trim() : undefined,

    keyPath: typeof payload.keyPath === 'string' && payload.keyPath.trim() ? payload.keyPath.trim() : undefined,

    password: typeof payload.password === 'string' && payload.password ? payload.password : undefined,

  });

  if (!result.ok) return { success: false, error: result.error };

  const template = {

    ...result.template,

    // guest-exec 凭据引用(D-T4):--password-ref 透传到模板,up 时回落进条目。
    ...(typeof payload.passwordRef === 'string' && payload.passwordRef.trim()

      ? { passwordRef: payload.passwordRef.trim() }

      : {}),

    createdAt: new Date().toISOString(),

  };

  try {

    await atomicModifyConfig((config) => ({

      ...config,

      vmTemplates: { ...(config.vmTemplates ?? {}), [recipe.id]: template },

    }));

  } catch (err) {

    return {

      success: false,

      error: `模板已养成但写入配置失败：${err instanceof Error ? err.message : String(err)}（快照已完成，可手动在 config.json 的 vmTemplates 补 "${recipe.id}" 条目）`,

    };

  }

  return {

    success: true,

    data: {

      template,

      address: result.address,

      channel: result.channel,

    },

  };

}



/** `environment/install` — 引擎缺失时的自动安装引导（P1 E1b）：检测 →
 * 已可用直接报「已就绪」；缺失则机器执行（docker 下载+验签+启动安装器 /
 * hyperv dism 启用），GUI/UAC/重启部分仍由人走完。 */

export async function handleEnvironmentInstall(payload: {

  engine?: string;

}): Promise<AdminResponse> {

  const engine = typeof payload.engine === 'string' ? payload.engine.trim() : '';

  if (engine !== 'docker' && engine !== 'hyperv') {

    return {

      success: false,

      error: 'Missing or invalid argument: <engine>（支持 docker | hyperv）',

      recoveryHint: {

        recoveryCommand: 'zhishi env engines',

        message: 'See which engines are available.',

      },

    };

  }

  const result = await installEngine(engine);

  if (!result.ok) return { success: false, error: result.error };

  return {

    success: true,

    data: {

      engine: result.engine,

      alreadyAvailable: result.alreadyAvailable === true,

      installerPath: result.installerPath,

      message: result.message,

    },

  };

}



/** `environment/build` — 模板构建（P2 V7）：从零自动构建 VM 模板（Ubuntu
 * Server ISO 无人值守安装 → setup.sh → 关机 → 快照），产出与 adopt 同形态，
 * 落 config.json::vmTemplates，之后 `env up <vm 配方>` 免 --vm-base。
 * 数字参数（diskGb/memMb/cpus）CLI 侧是字符串，这里统一收敛。 */

export async function handleEnvironmentBuild(payload: {

  recipe?: string;

  isoPath?: string;

  diskGb?: number | string;

  memMb?: number | string;

  cpus?: number | string;

}): Promise<AdminResponse> {

  const id = typeof payload.recipe === 'string' ? payload.recipe.trim() : '';

  if (!id) {

    return {

      success: false,

      error: 'Missing required argument: <recipe>',

      recoveryHint: {

        recoveryCommand: 'zhishi env recipes',

        message: 'See available environment recipes.',

      },

    };

  }

  const recipe = loadRecipe(defaultRecipesRoot(), id);

  if (!recipe) {

    return { success: false, error: `未找到环境类型 "${id}"` };

  }

  if (!recipe.valid) {

    return { success: false, error: `环境类型 "${id}" 无效：${recipe.invalidReasons.join('；')}` };

  }

  if (recipe.base !== 'vm') {

    return { success: false, error: `配方 "${id}" 不是 VM 配方（base: ${recipe.base ?? '?'}），env build 只服务 VM 配方` };

  }

  const toPositiveInt = (v: number | string | undefined): number | undefined => {

    const n = typeof v === 'string' ? Number(v) : v;

    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;

  };

  const result = await vmTemplateBuild(recipe, {

    isoPath: typeof payload.isoPath === 'string' && payload.isoPath.trim() ? payload.isoPath.trim() : undefined,

    diskGb: toPositiveInt(payload.diskGb),

    memMb: toPositiveInt(payload.memMb),

    cpus: toPositiveInt(payload.cpus),

  });

  if (!result.ok) return { success: false, error: result.error };

  const template = { ...result.template, createdAt: new Date().toISOString() };

  try {

    await atomicModifyConfig((config) => ({

      ...config,

      vmTemplates: { ...(config.vmTemplates ?? {}), [recipe.id]: template },

    }));

  } catch (err) {

    return {

      success: false,

      error: `模板已构建但写入配置失败：${err instanceof Error ? err.message : String(err)}（快照已完成，可手动在 config.json 的 vmTemplates 补 "${recipe.id}" 条目）`,

    };

  }

  return {

    success: true,

    data: {

      template,

      address: result.address,

    },

  };

}



// ---------------------------------------------------------------------------

// 安全研究员版 P1 T4（D17）— environment selection（首屏选定状态）

// ---------------------------------------------------------------------------



/**
 * `environment/select` — 持久化某 workspace 的环境选定（首屏选择器 / --env
 * / --new-env 的落点）。存 `~/.zhishi/env-selection.json`，结构是 S1 能力
 * 清单注入的读取契约（见 environment/selection.ts）。
 */

export function handleEnvironmentSelect(payload: {

  workspace?: string;

  selection?: unknown;

}): AdminResponse {

  const workspace = typeof payload.workspace === 'string' ? payload.workspace.trim() : '';

  if (!workspace) return { success: false, error: 'Missing required argument: <workspace>' };

  const validated = validateEnvSelection(payload.selection);

  if (!validated.ok) return { success: false, error: validated.error };

  try {

    const store = loadSelectionStore();

    const selectedAt = new Date().toISOString();

    saveSelectionStore(setWorkspaceSelection(store, workspace, validated.selection, selectedAt));

    return { success: true, data: { workspace, selection: validated.selection, selectedAt } };

  } catch (err) {

    return { success: false, error: `Environment selection save failed: ${err instanceof Error ? err.message : String(err)}` };

  }

}



/** `environment/current` — 查询某 workspace 的当前选定；从未选定 → host。 */

export function handleEnvironmentCurrent(payload: {

  workspace?: string;

}): AdminResponse {

  const workspace = typeof payload.workspace === 'string' ? payload.workspace.trim() : '';

  if (!workspace) return { success: false, error: 'Missing required argument: <workspace>' };

  const record = getWorkspaceSelectionRecord(loadSelectionStore(), workspace);

  return {

    success: true,

    data: {

      workspace,

      selection: record?.selection ?? HOST_SELECTION,

      selectedAt: record?.selectedAt ?? null,

    },

  };

}



/**

 * Show one agent's effective defaults so the AI can decide whether a given

 * task override is a no-op (same as workspace default) or meaningful.

 */

export function handleAgentShow(payload: { id?: string }): AdminResponse {

  const id = payload.id;

  if (!id) {

    return {

      success: false,

      error: 'Missing required argument: <agent-id>',

      recoveryHint: {

        recoveryCommand: 'zhishi agent list',

        message: 'See valid agent ids.',

      },

    };

  }

  const config = loadConfig();

  const agent = (config.agents ?? []).find(a => a.id === id);

  if (!agent) {

    return {

      success: false,

      error: `Agent '${id}' not found.`,

      recoveryHint: {

        recoveryCommand: 'zhishi agent list',

        message: 'See valid agent ids.',

      },

    };

  }



  // AgentConfigSlim is intentionally permissive (`[key: string]: unknown`) —

  // runtime / permissionMode / runtimeConfig exist on the full AgentConfig

  // but not on the slim shape. Extract defensively.

  const runtime = (agent.runtime as RuntimeType | undefined) ?? 'builtin';

  const agentPermissionMode = (agent.permissionMode as string | undefined) ?? '';

  const runtimeConfig = (agent.runtimeConfig as Record<string, unknown> | undefined) ?? undefined;



  // D20: builtin is the only runtime — effective model / permissionMode are

  // always the top-level agent fields. A stale `runtime` / `runtimeConfig`

  // from a removed external runtime is reported verbatim (config compat)

  // but has no effect.

  const effectiveModel = agent.model as string | undefined;

  const effectivePermissionMode = agentPermissionMode;



  return {

    success: true,

    data: {

      id: agent.id,

      name: agent.name,

      enabled: agent.enabled,

      workspacePath: agent.workspacePath,

      effectiveDefaults: {

        runtime,

        model: effectiveModel || null,

        permissionMode: effectivePermissionMode || null,

        providerId: agent.providerId ?? null,

        runtimeConfig: runtimeConfig ?? null,

      },

      channelCount: (agent.channels ?? []).length,

    },

  };

}





// ---------------------------------------------------------------------------

// Internal helpers

// ---------------------------------------------------------------------------



/** Validate that an ID is safe for use as a filename (prevent path traversal) */

function isValidId(id: string): boolean {

  return /^[a-zA-Z0-9_-]+$/.test(id);

}



/** Reject dangerous property names to prevent prototype pollution */

function hasDangerousKeySegment(key: string): boolean {

  return key.split('.').some(p => p === '__proto__' || p === 'constructor' || p === 'prototype');

}



// ---------------------------------------------------------------------------

// Provider file I/O (~/.zhishi/providers/{id}.json)

// ---------------------------------------------------------------------------



// findProvider, getProvidersDir, loadCustomProviderFiles → imported from admin-config.ts



/** Save a custom provider JSON file */

function saveCustomProviderFile(provider: Record<string, unknown>): void {

  const dir = getProvidersDir();

  ensureDirSync(dir);

  const filePath = resolve(dir, `${provider.id}.json`);

  writeFileSync(filePath, JSON.stringify(provider, null, 2), 'utf-8');

}



/** Delete a custom provider file. Returns true if file existed. */

function deleteCustomProviderFile(id: string): boolean {

  const filePath = resolve(getProvidersDir(), `${id}.json`);

  if (!existsSync(filePath)) return false;

  unlinkSync(filePath);

  return true;

}



// ---------------------------------------------------------------------------

// MCP helpers

// ---------------------------------------------------------------------------



/** Update Sidecar MCP state and notify frontend after config change.

 *  Respects project-scope: only servers enabled both globally AND in the

 *  current workspace project are pushed to the session. */

function notifyMcpChange(action: string, id: string): void {

  const workspacePath = getCurrentWorkspacePath();

  const config = loadConfig();

  const allServers = getAllMcpServers(config);

  const globalEnabled = new Set(getEnabledMcpServerIds(config));



  let effectiveServers: McpServerDefinition[];

  if (workspacePath) {

    const projects = loadProjects();

    const project = projects.find(p => p.path === workspacePath);

    const projectEnabled = new Set(project?.mcpEnabledServers ?? []);

    effectiveServers = allServers.filter(s => globalEnabled.has(s.id) && projectEnabled.has(s.id));

  } else {

    effectiveServers = allServers.filter(s => globalEnabled.has(s.id));

  }



  setMcpServers(effectiveServers);

  broadcast('config:changed', { section: 'mcp', action, id });

}



/** Enable MCP for the current workspace project */

function enableMcpForCurrentProject(serverId: string): void {

  // The workspace path is set via process-global; use it to find the project

  const workspacePath = getCurrentWorkspacePath();

  if (!workspacePath) return;



  const projects = loadProjects();

  const idx = projects.findIndex(p => p.path === workspacePath);

  if (idx < 0) return;



  const project = projects[idx];

  const enabled = new Set(project.mcpEnabledServers ?? []);

  enabled.add(serverId);

  projects[idx] = { ...project, mcpEnabledServers: Array.from(enabled) };

  saveProjects(projects);

}



/** Disable MCP for the current workspace project */

function disableMcpForCurrentProject(serverId: string): void {

  const workspacePath = getCurrentWorkspacePath();

  if (!workspacePath) return;



  const projects = loadProjects();

  const idx = projects.findIndex(p => p.path === workspacePath);

  if (idx < 0) return;



  const project = projects[idx];

  const enabled = new Set(project.mcpEnabledServers ?? []);

  enabled.delete(serverId);

  projects[idx] = { ...project, mcpEnabledServers: Array.from(enabled) };

  saveProjects(projects);

}



/** Get workspace path from agent-session (set during session init) */

function getCurrentWorkspacePath(): string | undefined {

  const state = getPiAgentState();

  return state.agentDir || undefined;

}



/** Modify an agent in config by ID */

async function modifyAgent(

  id: string,

  modifier: (agent: AgentConfigSlim) => AgentConfigSlim,

  action: string,

): Promise<AdminResponse> {

  // Pre-check existence (fast-fail before acquiring write)

  const config = loadConfig();

  if (!(config.agents ?? []).some(a => a.id === id)) {

    return { success: false, error: `Agent '${id}' not found` };

  }



  // Find by ID inside the modifier to avoid TOCTOU stale-index bugs

  await atomicModifyConfig(c => {

    const updated = [...(c.agents ?? [])];

    const freshIdx = updated.findIndex(a => a.id === id);

    if (freshIdx < 0) return c; // agent disappeared between reads — no-op

    updated[freshIdx] = modifier(updated[freshIdx]);

    return { ...c, agents: updated };

  });



  broadcast('config:changed', { section: 'agent', action, id });

  return { success: true, data: { id } };

}



/** Keys and patterns that contain secrets and must be redacted in config get */

const SENSITIVE_KEY_PATTERNS = /apikey|api_key|secret|token|password/i;

const SENSITIVE_TOP_KEYS = new Set(['providerApiKeys', 'mcpServerEnv']);



/** Recursively redact sensitive values in config output */

function redactSensitiveValues(key: string, value: unknown): unknown {

  const rootKey = key.split('.')[0];



  // Top-level known sensitive maps

  if (SENSITIVE_TOP_KEYS.has(rootKey) && typeof value === 'object' && value !== null) {

    return deepRedact(value);

  }



  // Any key path containing sensitive patterns

  if (SENSITIVE_KEY_PATTERNS.test(key) && typeof value === 'string') {

    return redactSecret(value);

  }



  // For arrays/objects that may contain sensitive nested fields (e.g., agents, imBotConfigs)

  if (typeof value === 'object' && value !== null) {

    return deepRedact(value);

  }



  return value;

}



/** Recursively walk an object and redact string values whose keys match sensitive patterns */

function deepRedact(obj: unknown): unknown {

  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') return obj;

  if (Array.isArray(obj)) return obj.map(item => deepRedact(item));

  if (typeof obj === 'object') {

    const result: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {

      if (typeof v === 'string' && SENSITIVE_KEY_PATTERNS.test(k)) {

        result[k] = redactSecret(v);

      } else if (typeof v === 'object' && v !== null) {

        result[k] = deepRedact(v);

      } else {

        result[k] = v;

      }

    }

    return result;

  }

  return obj;

}



/** Get nested value from object by dot-separated key */

function getNestedValue(obj: Record<string, unknown>, key: string): unknown {

  const parts = key.split('.');

  let current: unknown = obj;

  for (const part of parts) {

    if (current === null || current === undefined || typeof current !== 'object') return undefined;

    current = (current as Record<string, unknown>)[part];

  }

  return current;

}



/** Set nested value in object by dot-separated key */

function setNestedValue(obj: AdminAppConfig, key: string, value: unknown): AdminAppConfig {

  const parts = key.split('.');

  if (parts.length === 1) {

    return { ...obj, [key]: value };

  }

  const [first, ...rest] = parts;

  const child = (obj[first] ?? {}) as Record<string, unknown>;

  return { ...obj, [first]: setNestedValue(child as AdminAppConfig, rest.join('.'), value) };

}



// ---------------------------------------------------------------------------
// AppCraft: approve an app for unattended replay (design C — trust-on-first-use)
// ---------------------------------------------------------------------------

/**
 * Approve an app for unattended replay by writing it into the workspace's
 * boundApps (origin 'approved'). Idempotent by process name: an existing entry
 * with the same exe-derived process name is left untouched.
 */
export async function handleAppcraftAppApprove(payload: {
  workspacePath?: string;
  app?: { name?: string; process?: string; exe?: string; windowTitle?: string; dataDir?: string };
}): Promise<AdminResponse> {
  const resolved = resolveAppcraftWorkspace(payload);
  if ('error' in resolved) return resolved.error;
  const { workspacePath } = resolved;

  const app = payload.app;
  const processName = typeof app?.process === 'string' ? app.process.trim() : '';
  if (!processName) {
    return { success: false, error: 'Missing required argument: app.process (process name of the app to approve).' };
  }

  const projects = loadProjects();
  const project = projects.find(
    (p) => typeof p.path === 'string' && p.path.replace(/\\/g, '/') === workspacePath.replace(/\\/g, '/'),
  );
  if (!project) {
    return { success: false, error: `Workspace not found in projects.json: ${workspacePath}` };
  }

  const existing = (project.boundApps ?? []).find(
    (a) => deriveProcessName(a.exe).toLowerCase() === processName.toLowerCase(),
  );
  if (existing) {
    return { success: true, data: { boundApp: existing, created: false } };
  }

  const exe = typeof app?.exe === 'string' && app.exe ? app.exe : `${processName}.exe`;
  const boundApp = {
    id: processName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `app-${Date.now()}`,
    name: app?.name ?? processName,
    exe,
    windowTitle: app?.windowTitle ?? `*${processName}*`,
    ...(app?.dataDir ? { dataDir: app.dataDir } : {}),
    enabled: true,
  };

  project.boundApps = [...(project.boundApps ?? []), boundApp];
  saveProjects(projects);

  return { success: true, data: { boundApp, created: true } };
}
