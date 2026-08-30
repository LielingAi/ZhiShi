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
import type { EnvironmentEntry, IntelConfig, ModelEntity } from '../shared/config-types';
import { resolveIntelConfig } from '../shared/config-types';
import {
  loadConfig,
  atomicModifyConfig,
  redactSecret,
  findProvider,
  getAllEffectiveProviders,
  isProviderDisabled,
  getProvidersDir,
  type AdminAppConfig,
  type AgentConfigSlim,
} from './utils/admin-config';
import { managementApi } from './utils/management-api';
// 1.3.2 任务二 #5：task/list 行 conclusion 字段的数据源（cron 结论登记）。
import { taskConclusionFor } from './cron/task-conclusions';
// Localhost loopback timeout for management / sidecar self-calls.
import { existsSync , mkdirSync, writeFileSync, unlinkSync, readFileSync, readdirSync } from 'fs';
import { ensureDirSync } from './utils/fs-utils';
import { resolveSshTarget, execInEnvironment, buildScpArgv } from './loop/env-exec';
import { buildToolCheckScript, parseToolCheckOutput } from './environment/recipes';
import {
  CAPABILITY_PROBE_TIMEOUT_MS,
  boundDomainsForEntry,
  buildToolDomainIndex,
  capabilityMissingInScope,
  collectProbeSurface,
  mergeCapabilityDomains,
  parseProbePresentTools,
  probedDomainsForTools,
  probeEnvironmentCapabilities,
  type CapabilityExecFn,
} from './environment/capability-derive';
import { provisionEnvironment } from './environment/provision';
import { requestBoundaryAsk } from './loop/boundary-ask';
// 1.4.1 auto loop agent(design docs/design/auto-loop-design.md)。
import {
  listAutoRuns,
  renewAutoRunBudget,
  resolveAutoRunVerdict,
  startAutoRun,
  stopAutoRun,
  verdictRequestOfRecord,
} from './loop/auto-run';
import { detectOsFamilyFromVmx } from './environment/os-family';
import {
  loadDomainManifests,
  resolveBundledDir,
  validateDomainManifest,
  type DomainCheckContext,
} from './domains/manifest';
import { augmentedProcessEnv, resolveCommand } from './utils/env-utils';
import { resolve } from 'path';
import { connect } from 'net';
import { setAgents } from './agent-session';
import { getPiAgentState, envSwitchBlocker, getEnvSessionBinding, switchEnvSession, resolveSessionEnv, resolveSessionEnvKey } from './loop/chat-engine';
import { loadArchive } from './loop/archive';
import { envKeyForSelection, getEnvSessionLine, loadEnvSessionsMap, removeEnvSessionsForEnvId } from './environment/env-sessions';
import { resolveLoopModel } from './loop/pi-provider';
import { runLoopText } from './loop/loop';
import { buildLoopTranscript } from './loop/transcript';
import { exportReport } from './report/export';
import { workspacePathsEqual } from '../shared/workspacePath';
import { KIMI_CODING_MODELS } from '@earendil-works/pi-ai/providers/kimi-coding.models';
import { loadEnabledAgents } from './agents/agent-loader';
import { getZhiShiDataDir } from './utils/app-dirs';
import { join } from 'path';
import { broadcast } from './sse';
import { buildReadMeContent } from './tools/generative-ui-tool';
import { WIDGET_TRIGGER_GUIDANCE } from './system-prompt-cli-tools';
import { parseActiveReminders, parseReminderMeta, readDistilled } from './memory/distill';
import { findByContent, getResearchEventById, isResearchTaskKind, listActive, listResearchEvents, logRecallEvents, MEMORY_KINDS, recordResearchEvent, RESEARCH_TASK_KINDS, searchEntries, touchEntry, type MemoryKind, type ResearchBugClass, type ResearchOutcome, type ResearchTaskKind } from './memory/store';
// 1.2.1 专家知识层：expert.db（sidecar 进程内直连,不经网络）。
import {
  deleteDraft,
  deleteEntry,
  getDraftById,
  getEntryById,
  hasExpertDb,
  insertEntry,
  listDrafts,
  listEntries,
  openExpertStore,
  updateEntry,
  type ExpertEntry,
} from './expert/store';
import { searchExpertEntries, EXPERT_SEARCH_LIMIT } from './expert/search';
import { createIntelSearchTool } from './loop/intel';
import { computeContentHash, validateEntry, EXPERT_ENTRY_KINDS, EXPERT_PROVENANCES } from './expert/validate';
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
import { spawn as spawnSubprocess } from './utils/subprocess';
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
  type EnvironmentRecipe,
} from './environment/recipes';
import {
  dockerContainerRunning,
  envDown,
  envPs,
  envPsAll,
  envUp,
  type DiscoveredDocker,
  type EnvInstance,
  type EnvResult,
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
  hypervEnvPsAll,
  hypervEnvRm,
  hypervEnvUp,
  hypervVmExists,
  type HypervInstance,
} from './environment/hyperv-lifecycle';
import {
  vboxEnvDown,
  vboxEnvPs,
  vboxEnvPsAll,
  vboxEnvRm,
  vboxEnvUp,
  vboxVmExists,
  type VboxInstance,
} from './environment/vbox-lifecycle';
import {
  resolveVmDriver,
  routeVmTarget,
} from './environment/vm-dispatch';
import {
  vmTemplateAdopt,
} from './environment/vm-adopt';
import {
  resolveVmxForEntry,
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
  mutateSelectionStore,
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
   * Scope descriptor for workspace-scoped list reads.
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
// Model Provider Handlers
// ---------------------------------------------------------------------------
export function handleModelList(): AdminResponse {
  const config = loadConfig();
  const apiKeys = config.providerApiKeys ?? {};
  const verifyStatus = config.providerVerifyStatus ?? {};
  const presetCustomModels = (config.presetCustomModels ?? {}) as Record<string, unknown>;
const allProviders = getAllEffectiveProviders(config);
  const data: Array<Record<string, unknown>> = allProviders.map(p => {
    const id = String(p.id);
    const cfg = p.config as Record<string, unknown> | undefined;
    // 模型目录 = 预设 models ∪ set-key 拉取发现的 presetCustomModels
    // （按 model 去重，发现条目优先——对齐 model-capabilities 的 first-wins 语义）。
    const presetModels = Array.isArray(p.models) ? (p.models as ModelEntity[]) : [];
    const discovered = Array.isArray(presetCustomModels[id]) ? (presetCustomModels[id] as ModelEntity[]) : [];
    const merged = new Map<string, ModelEntity>();
    for (const m of presetModels) merged.set(m.model, m);
    for (const m of discovered) merged.set(m.model, m);
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
      primaryModel: p.primaryModel ? String(p.primaryModel) : undefined,
      models: [...merged.values()],
    };
  });
// kimi 内置(pi 层 kimiCodingProvider,api.kimi.com/coding):不在
  // PRESET_PROVIDERS、也不走 set-key 拉目录——模型目录随 pi-ai 内置。
  // 补一条合成条目,客户端 /model 状态卡与 /chat/model 的 kimi 反查闭环
  // 才能覆盖它;目录从 pi-ai 内置目录取,不硬编码避免漂移。
  // 1.2.9(Q1):key 判定对齐运行链路口径——resolveLoopModel 对 kimi 系是
  // 模糊匹配(id 含 kimi/moonshot 且非 openai 协议定义即走 kimi-coding),
  // 显示链路此前只认精确键 'kimi',用户配的 'moonshot-coding' 显示「未配
  // key」但实际可用。hasKimiUsableKey 与运行判定同规则。
  const hasKimiUsableKey = Object.entries(apiKeys).some(([kid, k]) => {
    if (!k || !String(k).trim()) return false;
    const lid = kid.toLowerCase();
    if (!lid.includes('kimi') && !lid.includes('moonshot')) return false;
    const def = allProviders.find((p) => String(p.id) === kid);
    const proto = def?.apiProtocol ? String(def.apiProtocol) : 'anthropic';
    return proto === 'anthropic'; // moonshot preset 是 openai 协议,不进 kimi-coding 路径
  });
  data.push(kimiBuiltinProviderEntry(apiKeys, verifyStatus, hasKimiUsableKey));
  // 1.2.9(Q1):当前生效的 provider/model(与 resolveLoopModel 同回落规则)
  // ——状态卡此前只显示目录,用户无法判断「现在在用哪家」。
  const currentProviderId = (config.defaultProviderId as string | undefined)
    ?? Object.keys(apiKeys).find((kid) => typeof apiKeys[kid] === 'string' && apiKeys[kid].trim() !== '');
  const currentModelId = currentProviderId
    ? ((config.defaultModelId as string | undefined)
      ?? (config.providerPrimaryModels as Record<string, string> | undefined)?.[currentProviderId]
      ?? (() => {
        const def = allProviders.find((p) => String(p.id) === currentProviderId);
        return def?.primaryModel ? String(def.primaryModel) : undefined;
      })())
    : undefined;
  return { success: true, data, current: { providerId: currentProviderId, modelId: currentModelId } };
}
/** kimi 内置合成条目:模型目录取自 pi-ai 的 kimi-coding 内置目录。
 *  hasKimiUsableKey(1.2.9):由调用方按运行链路口径算出(id 含
 *  kimi/moonshot 且非 openai 协议定义),不再精确查 apiKeys['kimi']——
 *  用户实际配的键是 moonshot-coding,精确匹配会误显「未配 key」。 */
function kimiBuiltinProviderEntry(
  apiKeys: Record<string, string>,
  verifyStatus: Record<string, unknown>,
  hasKimiUsableKey?: boolean,
): Record<string, unknown> {
  const catalog = KIMI_CODING_MODELS as unknown as Record<
    string,
    { id: string; name: string; contextWindow?: number; maxTokens?: number }
  >;
  const models: ModelEntity[] = Object.values(catalog).map((m) => ({
    model: m.id,
    modelName: m.name,
    modelSeries: 'kimi',
    contextLength: m.contextWindow,
    maxOutputTokens: m.maxTokens,
  }));
  return {
    id: 'kimi',
    name: 'Kimi (内置)',
    vendor: 'Moonshot AI',
    isBuiltin: true,
    protocol: 'anthropic',
    enabled: true,
    hasApiKey: hasKimiUsableKey ?? !!apiKeys['kimi'],
    status: (verifyStatus['kimi'] as Record<string, unknown>)?.status ?? 'not-set',
    primaryModel: models[0]?.model,
    models,
  };
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
// M4d 多模型接入：填 key 后自动拉取模型目录（显式 modelListUrl 或 OpenAI 协议
  // provider）并入 presetCustomModels（source: 'discovered'）。拉取失败只降级
  // 提示——key 已保存，verify / set-default / 会话链路不受影响。
  let modelsFetched: number | undefined;
  let modelsFetchError: string | undefined;
  const provider = findProvider(id);
  if (provider) {
    const { discoverProviderModels } = await import('./utils/provider-models');
    const result = await discoverProviderModels({
      provider,
      apiKey,
      persist: async (models) => {
        await atomicModifyConfig(c => ({
          ...c,
          presetCustomModels: {
            ...((c.presetCustomModels ?? {}) as Record<string, unknown>),
            [id]: models,
          },
        }));
      },
    });
    modelsFetched = result.modelsFetched;
    modelsFetchError = result.error;
  }
return {
    success: true,
    data: { id, modelsFetched, modelsFetchError },
    hint: modelsFetchError
      ? `API key saved for ${id}. Model list refresh failed: ${modelsFetchError}`
      : modelsFetched !== undefined
        ? `API key saved for ${id}. ${modelsFetched} model(s) discovered.`
        : `API key saved for ${id}.`,
  };
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
  const protectedKeys = ['providerApiKeys', 'providerVerifyStatus', 'agents', 'imBotConfigs'];
  const rootKey = key.split('.')[0];
  if (protectedKeys.includes(rootKey)) {
    return { success: false, error: `Cannot set '${key}' via config set. Use dedicated commands (e.g., 'zhishi agent', 'zhishi model set-key').` };
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
return {
    success: true,
    data: {
      defaultProvider: config.defaultProviderId ?? 'not set',
      agents: (config.agents ?? []).length,
    },
  };
}
export function handleReload(workspacePath?: string): AdminResponse {
  // Re-read sub-agent definitions from disk and push them to in-memory state.
  // Workspace resolution: prefer explicit arg → fall back to the session's agentDir.
  // Without this fallback, sub-agent reload would only see global agents.
  const effectiveWorkspace = workspacePath || getCurrentWorkspacePath();
// Sub-agent reload: re-scan the .md files on disk so edits to frontmatter
  // (model, description, tools) take effect without restarting the app.
  // Mirror /api/agents/enabled's resolution — project dir (if any) + user dir.
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
// Scan loaded cleanly — commit the in-memory state.
  setAgents(agents);
  const agentCount = Object.keys(agents).length;
// M4c: pi 引擎每 turn 读最新配置,无需 SDK 会话重载(原 forceReloadActiveSession)。
broadcast('config:changed', { section: 'all', action: 'reload' });
  return {
    success: true,
    hint: `Configuration reloaded (sub-agents: ${agentCount}). The session will restart on the next turn to apply changes.`,
  };
}
// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------
const HELP_TEXTS: Record<string, string> = {
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
  expert: `zhishi expert — 专家知识库（1.2.1 骨架期：专家审定，决策级依据）
Commands:
  list [--domain X] [--kind Y] [--provenance Z]   条目摘要列表（id/kind/domain/reviewer/标题/摘要）
  show <id>                                       单条全文
  search <query> [--domain X]                     FTS 检索（≤5 条，title/kind/applicability 摘要）
  new <标题> [--reviewer X]                       编辑器往返新建：模板临时文件 → $EDITOR → 校验 → 落库
  edit <id>                                       导出全文到编辑器往返 → 校验 → 更新
  rm <id>                                         删除（builtin 条目随包分发，服务端拒删）
  review                                          逐条交互审批草稿：[a]批准/[e]编辑后批准/[d]丢弃/[s]跳过
  review --approve <draftId> --reviewer X         非交互批准草稿（脚本/非 TTY）
  review --discard <draftId>                      非交互丢弃草稿
  promote <eventId> [--reviewer X]                从 research_events 事件预填 → 编辑器审定 → 晋升入库
                                                  （provenance=promoted + sourceEventId 关联）
格式契约：frontmatter（domain/kind/title/applicability/criteria/reviewer/tags）+ markdown 正文。
  kind 闭集：idea（思路）/ technique（技术知识）/ sop（标准作业流程）
  domain 闭集：binary / pentest / ai-security / redteam / malware / whitebox / intel / ctf
  reviewer 必填非空——权威性的来源是人审这个动作。
编辑器：$EDITOR ?? $VISUAL ??（Windows ? notepad : vi），可带参数（如 "code --wait"）。
  文件未动 / 编辑器退出码非零 → 不落库；校验失败列全部错误可重开。`,
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
    // 1.3.2 任务二 #5：行补 conclusion 字段(有结论就带,没有 → null)。
    // Rust Task 无此字段;结论来自 sidecar 的 cron 执行登记(task-conclusions)。
    const rawTasks = (resp as Record<string, unknown>).tasks;
    if (Array.isArray(rawTasks)) {
      const tasks = rawTasks.map((t) => {
        const row = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
        const id = typeof row.id === 'string' ? row.id : '';
        return { ...row, conclusion: id ? taskConclusionFor(id) : null };
      });
      return { success: true, data: tasks };
    }
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
// The CLI-tools appendix pre-injects BRIEF descriptions of these tools into
// the system prompt (system-prompt-cli-tools.ts). When the AI actually needs
// to use one, it calls `zhishi X readme` to pull the full usage doc on demand.
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
  // 1.3.10 #6：payload.q 缺类型守卫时非字符串会一路传进 searchEntries 的
  // query.trim() 抛 TypeError（500）——与 handleExpertSearch 同口径的
  // typeof 守卫 + 可读报错。
  const query = typeof payload?.q === 'string' ? payload.q.trim() : '';
  if (!query) return { success: false, error: 'usage: memory/search { q, kinds?, limit? }' };
  const results = searchEntries(query, {
    kinds: Array.isArray(payload.kinds) ? payload.kinds : undefined,
    limit: typeof payload.limit === 'number' ? payload.limit : undefined,
  });
  try {
    logRecallEvents(results.map((r) => r.id), query);
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

// 1.4.7 god file 绞杀续拆：archive/list + archive/correct 已抽到 './admin-archive'——re-export 保持既有调用点不动。
export { handleArchiveList, handleArchiveCorrect, handleArchiveResolve, handleArchiveAbandon } from './admin-archive';
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
      // 1.3.6 丢数据修复：只有「持久化配置已提交 window」才允许存量裁剪。
      // 一次性 mode 覆盖（GUI 更新按钮选中档 / CLI --mode window）只做写时
      // 过滤，不删已入库的历史 CVE——裁掉后增量水位无法找回，是永久丢数据。
      pruneWindow: mode === 'window' && cfg.mode === 'window',
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
/**
 * 情报配置部分更新（zhishi intel config，1.3.2 任务二 #3）——PATCH 语义：
 * 只更新传入字段并回写 config.json::intel（atomicModifyConfig 锁内读-改-写，
 * 与 MCP/provider 等配置写同一条纪律）。未传字段保持原值；非法值 400 式
 * 拒绝（不回写）。返回回写后的 resolveIntelConfig 合并值（含缺省）。
 */
export async function handleIntelConfigUpdate(payload: {
  mode?: unknown;
  windowYears?: unknown;
  maxSizeMb?: unknown;
  onlineFallback?: unknown;
}): Promise<AdminResponse> {
  const patch: Partial<IntelConfig> = {};
  if (payload.mode !== undefined) {
    if (payload.mode !== 'minimal' && payload.mode !== 'window' && payload.mode !== 'full') {
      return { success: false, error: `intel/config: 非法 mode "${String(payload.mode)}"（允许 minimal / window / full）` };
    }
    patch.mode = payload.mode;
  }
  if (payload.windowYears !== undefined) {
    if (typeof payload.windowYears !== 'number' || !Number.isFinite(payload.windowYears) || payload.windowYears <= 0) {
      return { success: false, error: 'intel/config: windowYears 需为正数（年）' };
    }
    patch.windowYears = payload.windowYears;
  }
  if (payload.maxSizeMb !== undefined) {
    if (typeof payload.maxSizeMb !== 'number' || !Number.isFinite(payload.maxSizeMb) || payload.maxSizeMb <= 0) {
      return { success: false, error: 'intel/config: maxSizeMb 需为正数（MB）' };
    }
    patch.maxSizeMb = payload.maxSizeMb;
  }
  if (payload.onlineFallback !== undefined) {
    if (typeof payload.onlineFallback !== 'boolean') {
      return { success: false, error: 'intel/config: onlineFallback 需为布尔值' };
    }
    patch.onlineFallback = payload.onlineFallback;
  }
  if (Object.keys(patch).length === 0) {
    return { success: false, error: 'intel/config: 没有可更新的字段（mode / windowYears / maxSizeMb / onlineFallback）' };
  }
  try {
    const saved = await atomicModifyConfig((config) => {
      const intel = (config.intel ?? {}) as IntelConfig;
      return { ...config, intel: { ...intel, ...patch } };
    });
    return { success: true, data: { config: resolveIntelConfig((saved as { intel?: IntelConfig }).intel) } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
// ===== 专家知识层（1.2.1 骨架期）—— expert.db 管理面 =====
// 所有写入路径（add/update/review-approve）过 validateEntry 单点校验；
// provenance 通道写入（add 缺省 user，promote 变体显式 promoted；review 用
// 草稿的；builtin 只走 seed）——除 add 的 user/promoted 二选一外不接受
// 调用方指定。deps.baseDir 仅供测试注入。
export interface ExpertAdminDeps {
  /** expert.db 数据目录（缺省 getZhiShiDataDir()）。 */
  baseDir?: string;
  /** memory.db 数据目录（promote-prefill 查 research_events；缺省同 baseDir）。 */
  memoryBaseDir?: string;
}
/** 管理面列表的条目摘要：不带 content 全文，带截断摘要。 */
function toExpertEntrySummary(entry: ExpertEntry): Record<string, unknown> {
  const preview = entry.content.length > 120 ? `${entry.content.slice(0, 119)}…` : entry.content;
  return {
    id: entry.id,
    domain: entry.domain,
    kind: entry.kind,
    title: entry.title,
    applicability: entry.applicability,
    contentPreview: preview,
    criteria: entry.criteria,
    provenance: entry.provenance,
    reviewer: entry.reviewer,
    sourceEventId: entry.sourceEventId,
    tags: entry.tags,
    enabled: entry.enabled,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}
/** expert/search {query, domain?} → 命中条目数组（FTS，≤5）。 */
export async function handleExpertSearch(payload: {
  query?: string;
  domain?: string;
}, deps: ExpertAdminDeps = {}): Promise<AdminResponse> {
  const query = typeof payload?.query === 'string' ? payload.query.trim() : '';
  if (!query) return { success: false, error: 'usage: expert/search { query, domain? }' };
  if (payload.domain !== undefined && !isResearchTaskKind(String(payload.domain))) {
    return { success: false, error: `expert/search: 非法 domain "${payload.domain}"（允许：${RESEARCH_TASK_KINDS.join(' / ')}）` };
  }
  try {
    const db = openExpertStore(deps.baseDir ?? getZhiShiDataDir());
    const results = searchExpertEntries(db, query, {
      limit: EXPERT_SEARCH_LIMIT,
      ...(payload.domain ? { domain: payload.domain } : {}),
    });
    return { success: true, data: { results } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** `intel/search { query, limit? }` — 1.5.0 /intel 斜杠命令的执行面：
 *  直接驱动 loop 的 intel_search 工具执行体（本地索引 + 在线回源同语义），
 *  返回格式化注入文本（GUI 不复刻格式）。 */
export async function handleIntelSearch(payload: {
  query?: string;
  limit?: number;
}): Promise<AdminResponse> {
  const query = typeof payload?.query === 'string' ? payload.query.trim() : '';
  if (!query) return { success: false, error: 'usage: intel/search { query, limit? }' };
  try {
    const tool = createIntelSearchTool();
    const result = await tool.execute('admin-intel-search', {
      query,
      ...(typeof payload.limit === 'number' ? { limit: payload.limit } : {}),
    } as never);
    const text = result.content.find((c) => c.type === 'text')?.text ?? '';
    return { success: true, data: { text, hitCount: result.details?.hitCount ?? 0 } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
/** expert/list {domain?, kind?, provenance?} → 条目摘要（不含 content 全文）。 */
export async function handleExpertList(payload: {
  domain?: string;
  kind?: string;
  provenance?: string;
}, deps: ExpertAdminDeps = {}): Promise<AdminResponse> {
  if (payload?.domain !== undefined && !isResearchTaskKind(String(payload.domain))) {
    return { success: false, error: `expert/list: 非法 domain "${payload.domain}"（允许：${RESEARCH_TASK_KINDS.join(' / ')}）` };
  }
  if (payload?.kind !== undefined && !(EXPERT_ENTRY_KINDS as readonly string[]).includes(String(payload.kind))) {
    return { success: false, error: `expert/list: 非法 kind "${payload.kind}"（允许：${EXPERT_ENTRY_KINDS.join(' / ')}）` };
  }
  if (payload?.provenance !== undefined && !(EXPERT_PROVENANCES as readonly string[]).includes(String(payload.provenance))) {
    return { success: false, error: `expert/list: 非法 provenance "${payload.provenance}"（允许：${EXPERT_PROVENANCES.join(' / ')}）` };
  }
  try {
    const db = openExpertStore(deps.baseDir ?? getZhiShiDataDir());
    const entries = listEntries(db, {
      ...(payload.domain ? { domain: payload.domain } : {}),
      ...(payload.kind ? { kind: payload.kind } : {}),
      ...(payload.provenance ? { provenance: payload.provenance } : {}),
    });
    return { success: true, data: { entries: entries.map(toExpertEntrySummary) } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
/** expert/show {id} → 单条全文。 */
export async function handleExpertShow(payload: { id?: number }, deps: ExpertAdminDeps = {}): Promise<AdminResponse> {
  const id = Number(payload?.id);
  if (!Number.isInteger(id) || id <= 0) return { success: false, error: 'usage: expert/show { id }' };
  try {
    const db = openExpertStore(deps.baseDir ?? getZhiShiDataDir());
    const entry = getEntryById(db, id);
    if (!entry) return { success: false, error: `expert/show: 条目 #${id} 不存在` };
    return { success: true, data: { entry } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
/**
 * expert/add {entry 字段} → validate → 插入（reviewer 必填）。
 * provenance 缺省 user；promote 变体（provenance='promoted'，CLI
 * `zhishi expert promote` 编辑器审定后调用）要求 sourceEventId 为正整数且
 * 对应的 research_events 事件存在——晋升即跨界，来源事件是审计锚点。
 * builtin 不接受 API 输入（随包 seed 写入）。validateEntry 单点不变。
 */
export async function handleExpertAdd(payload: Record<string, unknown>, deps: ExpertAdminDeps = {}): Promise<AdminResponse> {
  const rawProvenance = payload?.provenance;
  if (rawProvenance !== undefined && rawProvenance !== 'user' && rawProvenance !== 'promoted') {
    return { success: false, error: `expert/add: 非法 provenance "${String(rawProvenance)}"（允许 user / promoted；builtin 随包 seed 写入，不接受 API 输入）` };
  }
  const provenance = rawProvenance === 'promoted' ? 'promoted' : 'user';
  let sourceEventId: number | undefined;
  if (provenance === 'promoted') {
    const n = Number(payload?.sourceEventId);
    if (!Number.isInteger(n) || n <= 0) {
      return { success: false, error: 'expert/add: provenance=promoted 时 sourceEventId 必填（正整数 research_events.id）' };
    }
    try {
      const event = getResearchEventById(n, deps.memoryBaseDir ?? deps.baseDir ?? getZhiShiDataDir());
      if (!event) return { success: false, error: `expert/add: sourceEventId #${n} 在 research_events 不存在` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    sourceEventId = n;
  }
  // 1.5.1 判据化硬校验（四必填之一）：reviewer 必填——每条都要有名有姓的
  // 审定人（权威级可追溯：「以它为准」的前提是知道谁拍的板）。
  const reviewer = typeof payload?.reviewer === 'string' && payload.reviewer.trim()
    ? payload.reviewer.trim()
    : null;
  if (!reviewer) {
    return { success: false, error: 'expert/add: reviewer 必填（谁审定的——判据化契约，权威级可追溯）' };
  }
  const result = validateEntry({
    domain: payload?.domain,
    kind: payload?.kind,
    title: payload?.title,
    applicability: payload?.applicability,
    content: payload?.content,
    criteria: payload?.criteria,
    provenance,
    reviewer,
    sourceEventId,
    tags: payload?.tags,
  });
  if (!result.ok) return { success: false, error: `expert/add 校验失败：${result.errors.join('；')}` };
  try {
    const db = openExpertStore(deps.baseDir ?? getZhiShiDataDir());
    const entry = insertEntry(db, result.value, computeContentHash(result.value));
    return { success: true, data: { entry } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
/** expert/update {id, 可变字段} → validate（provenance 不可变，沿用原值）。 */
export async function handleExpertUpdate(payload: Record<string, unknown>, deps: ExpertAdminDeps = {}): Promise<AdminResponse> {
  const id = Number(payload?.id);
  if (!Number.isInteger(id) || id <= 0) return { success: false, error: 'usage: expert/update { id, ...可变字段 }' };
  try {
    const db = openExpertStore(deps.baseDir ?? getZhiShiDataDir());
    const existing = getEntryById(db, id);
    if (!existing) return { success: false, error: `expert/update: 条目 #${id} 不存在` };
    const result = validateEntry({
      domain: payload.domain ?? existing.domain,
      kind: payload.kind ?? existing.kind,
      title: payload.title ?? existing.title,
      applicability: payload.applicability ?? existing.applicability,
      content: payload.content ?? existing.content,
      criteria: payload.criteria ?? existing.criteria,
      provenance: existing.provenance,
      reviewer: payload.reviewer !== undefined ? payload.reviewer : existing.reviewer,
      sourceEventId: payload.sourceEventId !== undefined ? payload.sourceEventId : existing.sourceEventId,
      tags: payload.tags ?? existing.tags,
      enabled: payload.enabled !== undefined ? payload.enabled : existing.enabled,
    });
    if (!result.ok) return { success: false, error: `expert/update 校验失败：${result.errors.join('；')}` };
    const entry = updateEntry(db, id, { ...result.value, contentHash: computeContentHash(result.value) });
    return { success: true, data: { entry } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
/** expert/rm {id}：user/promoted 可删；builtin 拒绝删（随包分发）。 */
export async function handleExpertRm(payload: { id?: number }, deps: ExpertAdminDeps = {}): Promise<AdminResponse> {
  const id = Number(payload?.id);
  if (!Number.isInteger(id) || id <= 0) return { success: false, error: 'usage: expert/rm { id }' };
  try {
    const db = openExpertStore(deps.baseDir ?? getZhiShiDataDir());
    deleteEntry(db, id);
    return { success: true, data: { removed: id } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
/** expert/drafts → 待审草稿列表。 */
export async function handleExpertDrafts(_payload: unknown, deps: ExpertAdminDeps = {}): Promise<AdminResponse> {
  try {
    const db = openExpertStore(deps.baseDir ?? getZhiShiDataDir());
    return { success: true, data: { drafts: listDrafts(db) } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
/**
 * expert/review {draftId, action:'approve'|'discard', edited?}：
 * approve——草稿（或被 edited 覆盖后的字段）过 validateEntry 后进 entries
 * （provenance 用草稿的，reviewer 必填），删草稿；discard——删草稿。
 */
export async function handleExpertReview(payload: {
  draftId?: number;
  action?: string;
  edited?: Record<string, unknown>;
}, deps: ExpertAdminDeps = {}): Promise<AdminResponse> {
  const draftId = Number(payload?.draftId);
  if (!Number.isInteger(draftId) || draftId <= 0) {
    return { success: false, error: 'usage: expert/review { draftId, action: approve|discard, edited? }' };
  }
  if (payload?.action !== 'approve' && payload?.action !== 'discard') {
    return { success: false, error: `expert/review: 非法 action "${payload?.action}"（允许 approve / discard）` };
  }
  try {
    const db = openExpertStore(deps.baseDir ?? getZhiShiDataDir());
    const draft = getDraftById(db, draftId);
    if (!draft) return { success: false, error: `expert/review: 草稿 #${draftId} 不存在` };
    if (payload.action === 'discard') {
      deleteDraft(db, draftId);
      return { success: true, data: { discarded: draftId } };
    }
    const edited = payload.edited ?? {};
    const result = validateEntry({
      domain: edited.domain ?? draft.domain,
      kind: edited.kind ?? draft.kind,
      title: edited.title ?? draft.title,
      applicability: edited.applicability ?? draft.applicability,
      content: edited.content ?? draft.content,
      criteria: edited.criteria ?? draft.criteria,
      provenance: draft.provenance,
      reviewer: edited.reviewer ?? draft.reviewer,
      sourceEventId: edited.sourceEventId ?? draft.sourceEventId,
      tags: edited.tags ?? draft.tags,
    });
    if (!result.ok) return { success: false, error: `expert/review 审定校验失败：${result.errors.join('；')}` };
    const entry = insertEntry(db, result.value, computeContentHash(result.value));
    deleteDraft(db, draftId);
    return { success: true, data: { entry } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
/**
 * expert/promote-prefill {eventId} → 从 research_events 取该事件，返回预填
 * 字段（title/content 骨架/轨迹引用/domain=task_kind）供 CLI 打开编辑器。
 * 只读——不落任何数据（晋升落库走 expert/add 或编辑器往返，由人审定）。
 */
export async function handleExpertPromotePrefill(payload: { eventId?: number }, deps: ExpertAdminDeps = {}): Promise<AdminResponse> {
  const eventId = Number(payload?.eventId);
  if (!Number.isInteger(eventId) || eventId <= 0) return { success: false, error: 'usage: expert/promote-prefill { eventId }' };
  try {
    const event = getResearchEventById(eventId, deps.memoryBaseDir ?? deps.baseDir ?? getZhiShiDataDir());
    if (!event) return { success: false, error: `expert/promote-prefill: research_events #${eventId} 不存在` };
    const trajectoryLine = event.trajectoryRef ? `\n\n## 轨迹引用\n${event.trajectoryRef}` : '';
    return {
      success: true,
      data: {
        prefill: {
          domain: event.taskKind,
          kind: 'technique',
          title: event.summary.slice(0, 60),
          applicability: '',
          content: `## 背景\n${event.summary}\n\n## 经验\n（在此补充：怎么做、为什么有效）${trajectoryLine}`,
          criteria: '',
          tags: '',
          provenance: 'promoted',
          sourceEventId: event.id,
        },
      },
    };
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
      recoveryHint: {
        recoveryCommand: 'zhishi env engines --fresh',
        message: 'Bypass the 30s detect cache and re-probe.',
      },
    };
  }
}
// ---------------------------------------------------------------------------
// 安全研究员版 P1 E3 — named-environment registry (config.json::environments)
// ---------------------------------------------------------------------------
/** `environment/list` — list all registered environments (legacy configs → []).
 *  1.4.9：附带集合内工具口径（capabilityTools = {total, missing}）——GUI
 *  「在场 M/N」与缺失清单的数据源（capabilityMissing 是全探测面落盘，
 *  展示只关心能力集合涉及的工具）。 */
export function handleEnvironmentList(): AdminResponse {
  const entries = listEnvironments(loadConfig());
  const recipes = scanRecipes(defaultRecipesRoot());
  const manifests = loadDomainManifests();
  const environments = entries.map((e) => {
    const scope = capabilityMissingInScope(e, recipes, manifests);
    return scope ? { ...e, capabilityTools: scope } : e;
  });
  return { success: true, data: { environments } };
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
  // 能力集合顺手探测(1.3.7 场景 3):有可用通道的条目(ssh 有 host /
  // docker 有 container / vm 有 address)登记前试推一次「配方绑定域 ∪
  // 工具探测域」。探测是锦上添花不是门槛——失败静默,不阻塞登记。
  const probeable =
    (entry.kind === 'ssh' && entry.host) ||
    (entry.kind === 'docker' && entry.container) ||
    (entry.kind === 'vm' && entry.address);
  if (probeable) {
    const probed = await probeEnvironmentCapabilities(entry, {
      recipes: scanRecipes(defaultRecipesRoot()),
      manifests: loadDomainManifests(),
      exec: (e, script, opts) => capabilityExecImpl(e, script, opts),
    });
    if (probed) Object.assign(entry, probed);
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
/** `environment/open` — resolve the entry to an access command and open it in
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
  // 1.3.7「实例即环境」：三驱动统一 id = 实例名（vmware = vmx stem，
  // hyperv/vbox = 派生实例名），up 后回写 env 条目（kind: vm，
  // vmx 只是 vmware 条目的定位辅助），幂等重 up。
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
    // 1.3.7「实例即环境」：三驱动统一 id = 实例名（vmware = vmx 文件 stem，
    // hyperv/vbox = 派生实例名）。vmx 退化为纯定位辅助（down/rm/ps/快照/
    // 回滚 的解析锚），不再决定 id 语义。vmware 无论是否拿到 address 都
    // 登记（断网 VM 走 guest-exec 通道）；hyperv/vbox 仍只在拿到地址时
    // 回写。幂等重 up：同 id 条目先摘再加（刷新 address / vmx），不报「已存在」。
    if (driver === 'vmware' || instance.address) {
      try {
        const entryVmx = driver === 'vmware' ? (instance as VmInstance).vmx : undefined;
        const entry = {
              id: instance.name,
              kind: 'vm' as const,
              name: `${recipe.name}（${recipe.id}）`,
              recipeId: recipe.id,
              // 1.3.8 多配方：up 回写初始化绑定集合 [主配方]。
              recipeIds: [recipe.id],
              vmName: instance.name,
              ...(entryVmx ? { vmx: entryVmx } : {}),
              // OS 家族:vmx 静态判定(guestOS 字段),读不到缺省 linux。
              ...(entryVmx && detectOsFamilyFromVmx(entryVmx)
                ? { osFamily: detectOsFamilyFromVmx(entryVmx)! }
                : {}),
              ...(instance.address ? { address: instance.address } : {}),
              ...(user ? { user } : {}),
              ...(keyPath ? { keyPath } : {}),
              ...(passwordRef ? { passwordRef } : {}),
              createdAt: new Date().toISOString(),
            };
        // 探测全集自检(1.3.7 场景 3,与 docker 路径对齐):拿到地址的 VM
        // 回写前当场跑一条批量探测(全配方工具并集)——声明工具漂移证据落
        // toolCheck,在场工具→域 ∪ 配方绑定域落 capabilityDomains;无地址
        // (断网/未就绪)或通道失败 → 降级为无自检无能力字段,不阻断 up。
        if (instance.address) {
          Object.assign(entry, await runEnvProbeWithCapabilities(entry, recipe.tools));
        }
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
      // 1.3.8 多配方：up 回写初始化绑定集合 [主配方]。
      recipeIds: [recipe.id],
      container: result.instance.name,
      // 探测全集自检(1.3.7 场景 3):构建后当场跑一条批量探测(全配方工具
      // 并集)——声明工具漂移证据落 toolCheck,在场工具→域 ∪ 配方绑定域落
      // capabilityDomains;失败降级为无自检无能力字段,不阻断 up。
      // 注意 stub 条目必须带 recipeId——绑定域反查(candidate)靠它。
      ...(await runEnvProbeWithCapabilities(
        {
          id: result.instance.name,
          kind: 'docker',
          container: result.instance.name,
          recipeId: recipe.id,
          createdAt: '',
        },
        recipe.tools,
      )),
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
/** 配方工具自检(env up 构建后 + domain check 用):按条目 kind 选通道
 *  ——docker 走 docker exec,vm/ssh 走 ssh(env-exec 统一分派),逐个探测
 *  声明工具。通道失败(容器死了/ssh 不通/VM 未就绪)→ null(降级为无自检)。 */
export async function runRecipeToolCheck(
  entry: EnvironmentEntry,
  tools: string[],
): Promise<{ toolCheck?: { ok: boolean; missing: string[]; checkedAt: string } }> {
  if (tools.length === 0) return {};
  try {
    const r = await execInEnvironment(
      entry,
      buildToolCheckScript(tools),
      { timeoutMs: 30_000 },
    );
    if (!r.ok) return {};
    const result = parseToolCheckOutput(r.stdout, tools);
    return { toolCheck: { ...result, checkedAt: new Date().toISOString() } };
  } catch {
    return {};
  }
}
// ---------------------------------------------------------------------------
// 1.3.7 场景 3 — 能力集合现场推导（B 方案：配方绑定域 ∪ 工具探测域）
// ---------------------------------------------------------------------------
/**
 * 能力探测的执行通道（生产 = env-exec 统一分派）。模块级可替换——up/add/
 * capability-refresh 的接线测试注入假通道，绝不真连环境。
 */
const defaultCapabilityExec: CapabilityExecFn = (entry, script, opts) =>
  execInEnvironment(entry, script, opts);
let capabilityExecImpl: CapabilityExecFn = defaultCapabilityExec;
/** 测试注入能力探测通道（传 null 复位为生产通道）。 */
export function __setCapabilityExecForTests(fn: CapabilityExecFn | null): void {
  capabilityExecImpl = fn ?? defaultCapabilityExec;
}
/**
 * 探测全集自检（1.3.7：把 env up 的 toolCheck 步骤扩成「探测全集」）——
 * 一条批量探测命令覆盖「全配方工具并集 ∪ 本配方声明工具」，一份输出两吃：
 *   - toolCheck：parseToolCheckOutput(stdout, 本配方声明)（漂移证据，语义不变）；
 *   - 能力集合：OK 行工具 → 工具→域反推 ∪ 配方绑定域（capability-derive.ts）。
 * 通道失败 → {}（不写能力字段也不写 toolCheck，保 baseline 行为，不阻断 up）。
 * 空探测面（1.3.10 #4）：也走 bound 分支——与 probeEnvironmentCapabilities
 * 对齐，「绑定域恒在」不因无工具可探而丢能力字段。
 */
export async function runEnvProbeWithCapabilities(
  entry: EnvironmentEntry,
  recipeTools: string[],
): Promise<{
  toolCheck?: { ok: boolean; missing: string[]; checkedAt: string };
  capabilityDomains?: string[];
  capabilityDerivedAt?: string;
  capabilityMissing?: string[];
}> {
  const recipes = scanRecipes(defaultRecipesRoot());
  const surface = [...new Set([...collectProbeSurface(recipes), ...recipeTools])].sort((a, b) =>
    a.localeCompare(b),
  );
  if (surface.length === 0) {
    // 对齐 probeEnvironmentCapabilities 的空 surface 语义：无工具可探仍出
    // 绑定域（bound-only）；条目无绑定域才保持 {}（不写能力字段）。
    const bound = boundDomainsForEntry(entry, loadDomainManifests());
    if (bound.length === 0) return {};
    return { capabilityDomains: bound, capabilityDerivedAt: new Date().toISOString() };
  }
  try {
    const r = await capabilityExecImpl(entry, buildToolCheckScript(surface), {
      timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS,
    });
    if (!r.ok) return {};
    const stdout = r.stdout ?? '';
    const now = new Date().toISOString();
    const out: {
      toolCheck?: { ok: boolean; missing: string[]; checkedAt: string };
      capabilityDomains?: string[];
      capabilityDerivedAt?: string;
      capabilityMissing?: string[];
    } = {};
    if (recipeTools.length > 0) {
      out.toolCheck = { ...parseToolCheckOutput(stdout, recipeTools), checkedAt: now };
    }
    // 1.4.9：MISS 清单随探测落盘（全集——展示侧按集合内配方过滤）。
    out.capabilityMissing = surface.filter((t) => !parseProbePresentTools(stdout).has(t));
    const manifests = loadDomainManifests();
    const domains = mergeCapabilityDomains(
      boundDomainsForEntry(entry, manifests),
      probedDomainsForTools(
        parseProbePresentTools(stdout),
        buildToolDomainIndex(recipes, manifests),
        manifests,
      ),
    );
    if (domains.length > 0) {
      out.capabilityDomains = domains;
      out.capabilityDerivedAt = now;
    }
    return out;
  } catch {
    return {};
  }
}
/**
 * 能力重推 + 回写（environment/capability-refresh 与 domain/check 顺带刷新共用）。
 * 探测失败 → null（调用方保留旧能力字段，不清空）。
 */
export async function refreshEntryCapabilities(
  entry: EnvironmentEntry,
): Promise<{ capabilityDomains: string[]; capabilityDerivedAt: string; capabilityMissing?: string[] } | null> {
  const probed = await probeEnvironmentCapabilities(entry, {
    recipes: scanRecipes(defaultRecipesRoot()),
    manifests: loadDomainManifests(),
    exec: (e, script, opts) => capabilityExecImpl(e, script, opts),
  });
  if (!probed) return null;
  try {
    await atomicModifyConfig((config) => {
      const entries = listEnvironments(config).map((e) =>
        e.id === entry.id
          ? {
              ...e,
              capabilityDomains: probed.capabilityDomains,
              capabilityDerivedAt: probed.capabilityDerivedAt,
              // 1.4.9：MISS 清单随重推落盘；探测未执行（bound-only）时清掉
              // 旧缺失——缺失真相跟着最近一次真探测走。
              capabilityMissing: probed.capabilityMissing ?? [],
            }
          : e,
      );
      return { ...config, environments: entries };
    });
  } catch (err) {
    console.warn(`[environment/capability] 能力字段回写失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return probed;
}
/** `environment/capability-refresh` — 重推一个登记环境的能力集合并回写
 *  （GUI 手动刷新入口）。探测通道不可用 → success:false，旧能力字段不动。 */
export async function handleEnvironmentCapabilityRefresh(payload: {
  id?: string;
}): Promise<AdminResponse> {
  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (!id) return { success: false, error: 'Missing required argument: <id>' };
  const entry = findEnvironmentEntry(listEnvironments(loadConfig()), id);
  if (!entry) {
    return {
      success: false,
      error: `未找到环境 "${id}"`,
      recoveryHint: { recoveryCommand: 'zhishi env list', message: 'See registered environment ids.' },
    };
  }
  const probed = await refreshEntryCapabilities(entry);
  if (!probed) {
    return {
      success: false,
      error: `环境 "${id}" 能力探测失败（ssh 不通 / 容器未运行 / 无已知工具命中）——能力字段未改动`,
    };
  }
  return {
    success: true,
    data: { id, capabilityDomains: probed.capabilityDomains, capabilityDerivedAt: probed.capabilityDerivedAt, capabilityMissing: probed.capabilityMissing ?? [] },
  };
}
/** `environment/setup` — 1.4.9 已有环境补齐：对登记环境重放配方安装脚本
 *  （VM→setup.sh / docker→provision.sh）。探测只读不装（重推职责），补齐
 *  是显式动作（本端点）；成功后自动重推能力（MISS 清单同步刷新——闭环）。
 *  payload.recipe 缺省 = 绑定集合中全部可 provision 的配方依次执行；
 *  失败即停（后续配方在同一台机器上，先让人看清楚第一个失败）。 */
export async function handleEnvironmentSetup(payload: {
  id?: string;
  recipe?: string;
}): Promise<AdminResponse> {
  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (!id) return { success: false, error: 'Missing required argument: <id>' };
  const entry = findEnvironmentEntry(listEnvironments(loadConfig()), id);
  if (!entry) {
    return {
      success: false,
      error: `未找到环境 "${id}"`,
      recoveryHint: { recoveryCommand: 'zhishi env list', message: 'See registered environment ids.' },
    };
  }
  const reachable =
    (entry.kind === 'ssh' && entry.host) ||
    (entry.kind === 'docker' && entry.container) ||
    (entry.kind === 'vm' && entry.address);
  if (!reachable) {
    return { success: false, error: `环境 "${id}" 无可用执行通道（需要 ssh host / docker 容器 / vm address）` };
  }
  const recipes = scanRecipes(defaultRecipesRoot());
  const want = typeof payload.recipe === 'string' && payload.recipe.trim() ? payload.recipe.trim() : null;
  if (want && !recipes.some((r) => r.id === want)) {
    return { success: false, error: `未找到配方 "${want}"` };
  }
  // 绑定集合（与能力清单段同一回落规则：recipeIds ∪ recipeId ∪ id/vmName）。
  const boundIds = [
    ...new Set([
      ...(entry.recipeIds ?? []),
      ...(entry.recipeId ? [entry.recipeId] : []),
      entry.id,
      ...(entry.vmName ? [entry.vmName] : []),
    ]),
  ];
  const targets = (want ? [want] : boundIds)
    .map((rid) => recipes.find((r) => r.id === rid))
    .filter((r): r is EnvironmentRecipe => !!r);
  if (targets.length === 0) {
    return { success: false, error: `环境 "${id}" 没有可补齐的绑定配方` };
  }
  const results: Array<Record<string, unknown>> = [];
  for (const recipe of targets) {
    if (!recipe.valid) {
      results.push({ recipe: recipe.id, ok: false, error: `配方无效：${recipe.invalidReasons.join('；')}` });
      break;
    }
    const r = await provisionEnvironment(entry, recipe, {
      exec: (e, cmd, opts) => capabilityExecImpl(e, cmd, opts),
    });
    results.push({ recipe: recipe.id, ...r });
    if (!r.ok) break;
  }
  const failed = results.find((r) => r.ok === false);
  if (failed) {
    return { success: false, error: `补齐失败（${failed.recipe}）：${failed.error}`, data: { id, results } };
  }
  // 闭环：补齐后自动重推（capabilityDomains + capabilityMissing 同步刷新）。
  const probed = await refreshEntryCapabilities(entry);
  return {
    success: true,
    data: {
      id,
      results,
      ...(probed ? { capabilityDomains: probed.capabilityDomains, capabilityMissing: probed.capabilityMissing ?? [] } : {}),
    },
  };
}
/** `environment/bind-recipes` — 1.3.8 多配方关联侧：整体替换环境的多配方
 *  绑定集合（绑定=展示/构建来源，不进域裁决——能力集合仍以推导为准）。
 *  主配方 recipeId 恒在集合内；空集合拒绝；成功后尽力重推一次能力探测
 *  （best-effort，失败不阻断——绑定本身已落盘）。 */
export async function handleEnvironmentBindRecipes(payload: {
  id?: string;
  recipeIds?: string[];
}): Promise<AdminResponse> {
  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (!id) return { success: false, error: 'Missing required argument: <id>' };
  const raw = payload.recipeIds;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { success: false, error: 'recipeIds 必须是非空字符串数组（含主配方）' };
  }
  const ids: string[] = [];
  for (const r of raw) {
    if (typeof r !== 'string' || !r.trim()) {
      return { success: false, error: 'recipeIds 必须是非空字符串数组（含主配方）' };
    }
    const trimmed = r.trim();
    if (!ids.includes(trimmed)) ids.push(trimmed);
  }
  const entry = findEnvironmentEntry(listEnvironments(loadConfig()), id);
  if (!entry) {
    return {
      success: false,
      error: `未找到环境 "${id}"`,
      recoveryHint: { recoveryCommand: 'zhishi env list', message: 'See registered environment ids.' },
    };
  }
  if (entry.recipeId && !ids.includes(entry.recipeId)) {
    return { success: false, error: `绑定集合必须包含主配方 "${entry.recipeId}"（主配方不可移除）` };
  }
  let updated: EnvironmentEntry | undefined;
  try {
    await atomicModifyConfig((config) => {
      const entries = listEnvironments(config);
      const target = findEnvironmentEntry(entries, id);
      if (!target) throw new Error(`未找到环境 "${id}"`);
      const next: EnvironmentEntry = { ...target, recipeIds: ids };
      updated = next;
      return { ...config, environments: entries.map((e) => (e.id === id ? next : e)) };
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  // 尽力重推能力（绑定集合变了，工具漂移与能力集合可能变）——失败静默。
  if (updated) {
    try {
      await refreshEntryCapabilities(updated);
    } catch {
      /* best-effort */
    }
  }
  return { success: true, data: { id, recipeIds: ids } };
}
/** `environment/down` — 停一个实例。路由顺序（P2 B3 + 1.3.7）：登记条目
 * kind=vm 且 resolveVmxForEntry 解析出 vmx → vmware（id → vmx 解析在本层
 * 做，vm-lifecycle 不读 config）；Hyper-V 名字命中 → Stop-VM；
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
  // 1.3.7「实例即环境」：删除「id 以 .vmx 结尾」启发式路由——vmware 命中
  // 只看登记条目（kind=vm），id → vmx 统一走 resolveVmxForEntry（条目 vmx
  // 字段优先，缺省回落 vmName → vmTemplates 探测；vm-lifecycle 不读 config）。
  const downConfig = loadConfig();
  const downEntry = findEnvironmentEntry(listEnvironments(downConfig), id);
  // 1.3.8 B12：ssh 直连条目无实体可停——明确报错（此前落到 docker 兜底，
  // 报「docker rm 失败」之类的误导错误）。放在引擎探测前，不碰 hyperv/vbox。
  if (downEntry?.kind === 'ssh') {
    return {
      success: false,
      error: `环境 "${id}" 是 ssh 直连条目，无实体可停（停止只适用于 docker/VM 环境）`,
    };
  }
  const resolved = downEntry?.kind === 'vm'
    ? resolveVmxForEntry(downEntry, { templates: downConfig.vmTemplates })
    : undefined;
  const vmwareVmx = resolved?.ok ? resolved.vmx : undefined;
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
/** W1 — snapshot/rollback 的条目解析:登记 vm 环境 + vmx 定位(1.3.7 起
 * 统一走 resolveVmxForEntry:条目 vmx 字段优先,缺省回落 vmName→vmTemplates
 * 探测);docker 明确「暂未支持」,其余形态给可读错误。 */
function resolveSnapshotTarget(id: string): { vmx: string } | { error: string } {
  const config = loadConfig();
  const entry = findEnvironmentEntry(listEnvironments(config), id);
  if (!entry) return { error: `环境 "${id}" 未登记(zhishi env list 查看)` };
  if (entry.kind === 'docker') {
    return {
      error:
        `docker 环境 "${id}" 的快照/回滚暂未支持——` +
        '留现场请用环境内 task.md + 越界提取,或改用 VM 环境(vmrun 快照)',
    };
  }
  const resolved = entry.kind === 'vm'
    ? resolveVmxForEntry(entry, { templates: config.vmTemplates })
    : undefined;
  if (!resolved || !resolved.ok) {
    return {
      error: `环境 "${id}" 解析不到 .vmx 定位(kind=${entry.kind}),快照仅支持可解析 vmx 的 vm 环境`,
    };
  }
  return { vmx: resolved.vmx };
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
    // 配方工具自检(现场证据):域内每个配方有在跑/可达的环境就验一次。
    // 覆盖 docker(在跑容器)与 vm(拿到地址的条目,ssh 通道);断网 VM
    // (无 address)没有可用通道,跳过(1.2.5「配」)。
    const runnableEntries = listEnvironments(loadConfig()).filter(
      (e) => (e.kind === 'docker' && e.container) || (e.kind === 'vm' && e.address),
    );
    const recipes = scanRecipes(defaultRecipesRoot());
    for (const recipeId of m.recipes) {
      const recipe = recipes.find((r) => r.id === recipeId);
      const entry = runnableEntries.find((e) => e.container === recipeId || e.name?.includes(recipeId));
      if (!recipe || !entry || recipe.tools.length === 0) continue;
      // 1.3.7 场景 3：探测全集一次两吃——漂移证据照报，能力集合顺带刷新回写
      // （capability-refresh 的批量形态；探测失败的条目不动旧能力字段）。
      const check = await runEnvProbeWithCapabilities(entry, recipe.tools);
      if (check.capabilityDomains) {
        try {
          await atomicModifyConfig((config) => ({
            ...config,
            environments: listEnvironments(config).map((e) =>
              e.id === entry.id
                ? {
                    ...e,
                    capabilityDomains: check.capabilityDomains,
                    capabilityDerivedAt: check.capabilityDerivedAt,
                    // 1.4.9：MISS 清单同步刷新（此前丢字段——域是新的、缺失是
                    // 旧的，两栏自相矛盾）。
                    capabilityMissing: check.capabilityMissing ?? [],
                  }
                : e,
            ),
          }));
        } catch (err) {
          console.warn(`[domain/check] 能力字段回写失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
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
/** domain check 的引用上下文:现有配方 id + subagent 目录名。 */
function buildDomainCheckContext(): DomainCheckContext {
  const recipeIds = new Set(scanRecipes(defaultRecipesRoot()).map((r) => r.id));
  const subagentIds = new Set<string>();
  const agentsDir = resolveBundledDir('bundled-agents');
  if (agentsDir && existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir, { withFileTypes: true })) {
      if (f.isDirectory()) subagentIds.add(f.name);
    }
  }
  return { recipeIds, subagentIds };
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
 * <envId>/`。这是「写宿主」类越界——先过 boundary-ask 通道问人(GUI 红
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
  // 越界询问:写宿主。人批准前 HTTP 请求一直 pending(客户端模态在等)。
  // 1.3.2 契约补全:带工具名/说明/选项,展示文案由服务端给出。
  const approved = await requestBoundaryAsk({
    kind: 'host-write',
    objects: [`${id}:${guestPath}`, `→ 宿主 ${destDir}`],
    toolName: 'environment/extract',
    toolDescription: '把环境内成果提取回宿主',
    options: ['批准写入', '拒绝'],
  });
  if (!approved) return { success: false, error: '越界提取已被拒绝或超时(写宿主需人批准)' };
  ensureDirSync(destDir);
  const argv = buildScpArgv(target, guestPath, destDir);
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
/** `report/export` — 1.2.0 研究交付：一键出报告（design 1.2.0）。
 * 编排本体在 report/export.ts（纯注入，可单测）；这里只做真实接线：
 * research_events 查询（按 workspace 过滤）/ env-sessions 当前环境线 /
 * transcript / 一次边界批准 / 批量证据回收 / 一次性叙述 loop / 落盘。
 * 叙述 loop 无工具、独立 sessionId 语义（runLoopText 一次性调用，不碰
 * 引擎单例会话线）；模型取工作区当前配置（resolveLoopModel）。 */
export async function handleReportExport(payload: {
  workspace?: string;
  sanitize?: boolean;
}): Promise<AdminResponse> {
  const workspace = typeof payload.workspace === 'string' ? payload.workspace.trim() : '';
  if (!workspace) return { success: false, error: 'Missing required argument: <workspace>' };
  const sanitize = payload.sanitize === true;
  const entry = resolveSessionEnv(workspace);
  const envKey = resolveSessionEnvKey(workspace);
  const envId = entry?.id ?? envKey.replace(/^(env|recipe):/, '');
  const resolution = resolveLoopModel();
  const modelId = resolution ? `${resolution.providerId ?? 'custom'}/${resolution.modelId}` : null;
  const result = await exportReport(
    { workspace, sanitize, env: { envId, entry } },
    {
      listWorkspaceEvents: (ws) =>
        listResearchEvents({ limit: 1000 }).filter((e) => workspacePathsEqual(e.workspace, ws)),
      findLoopSessionId: (ws) =>
        getEnvSessionLine(loadEnvSessionsMap(), ws, envKey)?.loopSessionId,
      loadTranscript: (loopSessionId) => buildLoopTranscript(loopSessionId),
      // 1.4.4 研究档案交付投影（loadArchive 读侧容错：缺失/损坏 → 空档案）。
      loadArchive: (loopSessionId) => loadArchive(loopSessionId),
      requestApproval: (objects) => requestBoundaryAsk({
        kind: 'host-write',
        objects,
        toolName: 'report/export',
        toolDescription: '把证据与报告落回宿主',
        options: ['批准写入', '拒绝'],
      }),
      narrate: async (prompt, systemPrompt) => {
        if (!resolution) return { error: '模型不可用（无 provider/key）' };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 180_000);
        try {
          const { text, error } = await runLoopText({
            prompt,
            systemPrompt,
            model: resolution.model,
            models: resolution.models,
            getApiKey: resolution.getApiKey,
            tools: [],
            signal: controller.signal,
          });
          if (error !== undefined) return { error };
          return { text };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        } finally {
          clearTimeout(timer);
        }
      },
      modelId,
      writeOutputs: (reportDir, files) => {
        mkdirSync(reportDir, { recursive: true });
        for (const [name, content] of Object.entries(files)) {
          writeFileSync(join(reportDir, name), content, 'utf-8');
        }
      },
      // 1.2.2 引用追踪：事件 expert_refs → expert.db 查 title/kind；库不存在/
      // 条目已删 → null（骨架按「不可考」渲染，不阻塞导出）。
      lookupExpertEntry: (id) => {
        const baseDir = getZhiShiDataDir();
        if (!hasExpertDb(baseDir)) return null;
        const entry = getEntryById(openExpertStore(baseDir), id);
        return entry ? { title: entry.title, kind: entry.kind } : null;
      },
    },
  );
  return result;
}
// ===== 1.4.1 auto loop agent（design docs/design/auto-loop-design.md）=====
// runner 本体在 loop/auto-run.ts（纯函数+注入依赖）；这里只做薄校验与调用。
/** `auto-run/start` — 校验失败返回 4xx 可读错误（routeAdminApi 统一映射）。 */
export async function handleAutoRunStart(payload: Record<string, unknown>): Promise<AdminResponse> {
  const workspace = typeof payload.workspace === 'string' && payload.workspace.trim()
    ? payload.workspace.trim()
    : (getPiAgentState().agentDir || process.cwd());
  const result = await startAutoRun(payload, workspace);
  if (!result.success) return { success: false, error: result.error };
  return { success: true, data: { id: result.data.id } };
}
/** `auto-run/stop` — Esc 语义终止循环。 */
export function handleAutoRunStop(payload: { id?: unknown }): AdminResponse {
  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (!id) return { success: false, error: 'Missing required argument: <id>' };
  const result = stopAutoRun(id);
  return result.success ? { success: true, data: result.data } : { success: false, error: result.error };
}
/** `auto-run/budget` — 预算续命（仅 paused+reason=budget；新上限 > 已耗）。 */
export function handleAutoRunBudget(payload: { id?: unknown; limit?: unknown }): AdminResponse {
  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (!id) return { success: false, error: 'Missing required argument: <id>' };
  const result = renewAutoRunBudget(id, payload.limit);
  return result.success ? { success: true, data: result.data } : { success: false, error: result.error };
}
/** `auto-run/verdict` — 验收终审：pass 出报告 / fail|continue 注回线续跑。
 *  1.4.6：孤儿记录（sidecar 重启后内存 runner 消亡）走盘上兜底结算。 */
export async function handleAutoRunVerdict(payload: { id?: unknown; verdict?: unknown; note?: unknown }): Promise<AdminResponse> {
  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (!id) return { success: false, error: 'Missing required argument: <id>' };
  const result = await resolveAutoRunVerdict(
    id,
    payload.verdict,
    typeof payload.note === 'string' ? payload.note : undefined,
  );
  return result.success ? { success: true, data: result.data } : { success: false, error: result.error };
}
/** `auto-run/list` — 记录列表（时间倒序；可选 workspace 过滤）。 */
export async function handleAutoRunList(payload: { workspace?: unknown }): Promise<AdminResponse> {
  const workspace = typeof payload.workspace === 'string' && payload.workspace.trim()
    ? payload.workspace.trim()
    : undefined;
  const records = await listAutoRuns(workspace);
  // 1.4.6 dogfood 实证修复：records 带 verdict 归一化字段（verdictPackage →
  // 对外 verdict 形状）——断线后终审弹窗的唯一恢复路径。
  return {
    success: true,
    data: {
      records: records.map((r) => {
        const verdict = verdictRequestOfRecord(r);
        return verdict ? { ...r, verdict } : r;
      }),
    },
  };
}
/** `environment/rm` — 拆除环境（P2 B4 / B3 多驱动 + D22）。vmware 直连
 * 语义：rm = 只摘登记（removeEnvironmentEntry），**绝不删用户 VM 文件**——
 * 这是真实 VM 不是一次性拷贝；运行中拒绝（先 down）。.vmx 直传 → 报错
 * 引导（env rm 只对登记条目）。Hyper-V 名字命中 → hypervEnvRm（Remove-VM
 * + 删实例目录）；VirtualBox 名字命中 → vboxEnvRm（unregistervm --delete）。
 * 1.3.7 补口：ssh 条目只摘登记（远端机器不受影响，无实体可删）；docker
 * 条目容器运行中拒绝（docker ps 探测，口径照 vm「运行中拒绝」），停着
 * 只摘登记——容器实体的删除仍归 env down（stop + rm），不走 rm。
 * 1.3.8 B2：已登记的 hyperv/vbox 条目（kind=vm 且解析不出 vmx）按条目 id
 * 回落实体删除（hypervEnvRm/vboxEnvRm，自带运行中拒绝）+ 摘登记——此前
 * 直接摘登记，与 GUI 的「永久删除 VM 实例」警示相反。 */
/** rm 的 docker 运行探测通道（生产 = dockerContainerRunning 实查）。
 *  模块级可替换——admin 接线测试注入假探测，绝不真调 docker。 */
export type RmDockerProbe = (container: string) => Promise<{ ok: boolean; running?: boolean }>;
const defaultRmDockerProbe: RmDockerProbe = async (container) => {
  const r = await dockerContainerRunning(container);
  return r.ok ? { ok: true, running: r.running } : { ok: false };
};
let rmDockerProbeImpl: RmDockerProbe = defaultRmDockerProbe;
/** 测试注入 docker 运行探测（传 null 复位为生产探测）。 */
export function __setRmDockerProbeForTests(fn: RmDockerProbe | null): void {
  rmDockerProbeImpl = fn ?? defaultRmDockerProbe;
}
/** rm 的 hyperv/vbox 实体删除通道（生产 = 各 lifecycle 实查）。
 *  模块级可替换——admin 接线测试注入假通道，绝不真连 Hyper-V/VirtualBox。 */
export interface RmVmEntityOps {
  hypervExists: (name: string) => Promise<boolean>;
  hypervRm: (name: string) => Promise<EnvResult<{ removed: string }>>;
  vboxExists: (name: string) => Promise<boolean>;
  vboxRm: (name: string) => Promise<EnvResult<{ removed: string }>>;
}
const defaultRmVmEntityOps: RmVmEntityOps = {
  hypervExists: (name) => hypervVmExists(name),
  hypervRm: (name) => hypervEnvRm(name),
  vboxExists: (name) => vboxVmExists(name),
  vboxRm: (name) => vboxEnvRm(name),
};
let rmVmEntityOpsImpl: RmVmEntityOps = defaultRmVmEntityOps;
/** 测试注入 hyperv/vbox 实体删除通道（传 null 复位为生产通道）。 */
export function __setRmVmEntityOpsForTests(ops: RmVmEntityOps | null): void {
  rmVmEntityOpsImpl = ops ?? defaultRmVmEntityOps;
}
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
  const rmEntry = findEnvironmentEntry(listEnvironments(loadConfig()), id);
  // D22 直连：.vmx 直传没有登记语境——env rm 只对登记条目，VM 文件用户自管。
  // 1.3.7 修复：先查登记条目——id 恰好以 .vmx 结尾的已登记条目（旧发现登记
  // 流的 id 形态 `<driver>-<名>.vmx`）是合法登记条目，走正常删除；只有
  // 查不到登记条目的 .vmx 直传才拒绝。
  if (!rmEntry && /\.vmx$/i.test(id)) {
    return {
      success: false,
      error: 'env rm 只对登记条目生效（只摘登记，不动 VM 文件）；VM 文件请自行管理',
    };
  }
  // 1.1.6 #4：环境删除成功后顺手清会话分线映射里该 envId 的残留条目
  // （所有 workspace 的 env:<id> 行）；失败只告警，不影响 rm 结果。
  const cleanEnvSessionLines = async (): Promise<void> => {
    try {
      await removeEnvSessionsForEnvId(id);
    } catch (err) {
      console.warn('[env-rm] 清 env-sessions 映射残留失败:', err);
    }
  };
  // 摘登记公共尾段（ssh/docker 分支共用）：atomicModifyConfig 落盘 +
  // cleanEnvSessionLines；vm/hyperv/vbox 分支各有实体操作，不走这里。
  const unregisterEntry = async (): Promise<AdminResponse> => {
    try {
      await atomicModifyConfig((config) => {
        const removed = removeEnvironmentEntry(listEnvironments(config), id);
        if (!removed.ok) throw new Error(removed.error);
        return { ...config, environments: removed.entries };
      });
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    await cleanEnvSessionLines();
    return { success: true, data: { removed: id } };
  };
  // 1.3.7 补口：ssh 条目只摘登记——远端机器不受影响（无实体可删）。
  if (rmEntry?.kind === 'ssh') {
    return unregisterEntry();
  }
  // 1.3.7 补口：docker 条目容器运行中拒绝（口径照 vm「运行中拒绝」：
  // 探测失败视为不在跑，放行摘登记）；停着只摘登记——容器实体的删除
  // 仍归 env down（stop + rm），不在这里做。
  if (rmEntry?.kind === 'docker') {
    const container = rmEntry.container ?? rmEntry.id;
    const probe = await rmDockerProbeImpl(container);
    if (probe.ok && probe.running) {
      return {
        success: false,
        error: `环境 "${id}" 的容器 "${container}" 还在运行——先 zhishi env down ${id}，确认不要了再 rm`,
      };
    }
    return unregisterEntry();
  }
  if (rmEntry?.kind === 'vm') {
    // 运行中拒绝：先 down（真实 VM 的现场可能比登记值钱）。
    // id → vmx 统一走 resolveVmxForEntry（条目 vmx 优先，缺省 vmName→
    // vmTemplates 探测）。
    const rmVmx = resolveVmxForEntry(rmEntry, { templates: loadConfig().vmTemplates });
    if (rmVmx.ok) {
      const ps = await vmEnvPs();
      if (ps.ok && ps.vmxes.some((v) => normalizeVmxPath(v) === normalizeVmxPath(rmVmx.vmx))) {
        return {
          success: false,
          error: `环境 "${id}" 的 VM 还在运行——先 zhishi env down ${id}，确认不要了再 rm`,
        };
      }
      // vmware 条目：只摘登记（VM 文件是用户的真实系统，绝不删——见函数头注释）。
    } else {
      // 1.3.8 B2：vmx 解析不出 = hyperv/vbox 回写条目形态（id = 实例名）。
      // 承诺与行为对齐——按条目 id 回落实体删除（hypervEnvRm/vboxEnvRm 自带
      // 运行中拒绝），实体删除成功后摘登记；两侧都未命中才只摘登记。
      if (await rmVmEntityOpsImpl.hypervExists(id)) {
        const r = await rmVmEntityOpsImpl.hypervRm(id);
        if (!r.ok) return { success: false, error: r.error };
        return unregisterEntry();
      }
      if (await rmVmEntityOpsImpl.vboxExists(id)) {
        const r = await rmVmEntityOpsImpl.vboxRm(id);
        if (!r.ok) return { success: false, error: r.error };
        return unregisterEntry();
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
    await cleanEnvSessionLines();
    return { success: true, data: { removed: id } };
  }
  if (await hypervVmExists(id)) {
    const hypervResult = await hypervEnvRm(id);
    if (!hypervResult.ok) return { success: false, error: hypervResult.error };
    await cleanEnvSessionLines();
    return { success: true, data: { removed: hypervResult.removed } };
  }
  if (await vboxVmExists(id)) {
    const vboxResult = await vboxEnvRm(id);
    if (!vboxResult.ok) return { success: false, error: vboxResult.error };
    await cleanEnvSessionLines();
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
 * Hyper-V（Get-VM 'zhishi-*' ∩ Running，1.3.8 B4）+ VirtualBox
 * （list runningvms ∩ zhishi-）。单侧引擎缺席不拖垮其余——只有全部失败
 * 才报错。1.3.8 B1：docker 行 id 归一为登记条目 id（容器名），不再产出
 * 孤儿短 id 行。 */
/** environment/ps 的四源实例采集（生产 = 各 lifecycle 实查）。
 *  模块级可替换——admin 接线测试注入假源，绝不真连 docker/vmrun/hyperv/vbox。 */
export interface PsSources {
  dockerPs: () => Promise<EnvResult<{ instances: EnvInstance[] }>>;
  vmPs: () => Promise<EnvResult<{ vmxes: string[] }>>;
  hypervPs: () => Promise<EnvResult<{ instances: HypervInstance[] }>>;
  vboxPs: () => Promise<EnvResult<{ instances: VboxInstance[] }>>;
}
const defaultPsSources: PsSources = {
  dockerPs: () => envPs(),
  vmPs: () => vmEnvPs(),
  hypervPs: () => hypervEnvPs(),
  vboxPs: () => vboxEnvPs(),
};
let psSourcesImpl: PsSources = defaultPsSources;
/** 测试注入 ps 四源（传 null 复位为生产源；Partial 可只换单侧）。 */
export function __setPsSourcesForTests(sources: Partial<PsSources> | null): void {
  psSourcesImpl = { ...defaultPsSources, ...(sources ?? {}) };
}
/** ps 手动条目的 TCP 存活探测通道（生产 = probeTcp 实连）。 */
export type PsTcpProbe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;
let psTcpProbeImpl: PsTcpProbe = probeTcp;
/** 测试注入 TCP 探测（传 null 复位为生产探测）。 */
export function __setPsTcpProbeForTests(fn: PsTcpProbe | null): void {
  psTcpProbeImpl = fn ?? probeTcp;
}
export async function handleEnvironmentPs(): Promise<AdminResponse> {
  const [dockerResult, vmResult, hypervResult, vboxResult] = await Promise.all([
    psSourcesImpl.dockerPs(),
    psSourcesImpl.vmPs(),
    psSourcesImpl.hypervPs(),
    psSourcesImpl.vboxPs(),
  ]);
  if (!dockerResult.ok && !vmResult.ok && !hypervResult.ok && !vboxResult.ok) {
    return {
      success: false,
      error: [dockerResult, vmResult, hypervResult, vboxResult]
        .map((r) => (r.ok ? '' : r.error))
        .filter(Boolean)
        .join('\n'),
      recoveryHint: {
        recoveryCommand: 'zhishi env engines',
        message: 'See which engines are available.',
      },
    };
  }
  const psConfig = loadConfig();
  const psEntries = listEnvironments(psConfig);
  // 1.3.10 #3：vmTemplates 一次 load，逐条目 resolveVmxForEntry 复用——
  // 与 down/snapshot/rollback/guest-exec/rm 同一解析点（条目 vmx 优先，
  // 缺省 vmName → vmTemplates 探测）。
  const vmTemplates = psConfig.vmTemplates;
  // D22 直连：vmrun list 的运行中 vmx ∩ 登记条目（kind=vm 且 resolveVmxForEntry
  // 解析出 vmx）→ 运行中环境（路径比较统一规整：大小写 / 斜杠方向不敏感）。
  // 未登记的 running VM 不列——那是用户在 Workstation 里手动起的机器，不归 zhishi 管。
  const vmInstances = vmResult.ok
    ? psEntries
        .flatMap((e) => {
          if (e.kind !== 'vm') return [];
          const resolved = resolveVmxForEntry(e, { templates: vmTemplates });
          if (!resolved.ok) return [];
          const running = vmResult.vmxes.some((v) => normalizeVmxPath(v) === normalizeVmxPath(resolved.vmx));
          if (!running) return [];
          return [{
            id: e.id,
            name: e.name ?? e.id,
            vmx: resolved.vmx,
            address: e.address,
            status: 'running',
            recipe: e.name ?? '',
            workspace: '',
            driver: 'vm' as const,
          }];
        })
    : [];
  // 1.3.8 B1：docker ps 行的 id 本是 12 位短容器 id，与登记条目 id（容器名）
  // 双身份——同一环境在侧栏同时落「运行中」（孤儿短 id 行）与「已停止」。
  // 按容器名 ∩ 登记条目回联，行 id 归一为条目 id（docker stop/rm 同样接受
  // 容器名，down 不受影响）；未登记容器保持短 id 原样。
  const dockerEntries = psEntries.filter((e) => e.kind === 'docker');
  const dockerInstances = dockerResult.ok
    ? dockerResult.instances.map((i) => {
        const entry = dockerEntries.find((e) => e.container === i.name || e.id === i.name);
        return { ...i, id: entry?.id ?? i.id, driver: 'docker' as const };
      })
    : [];
  // 1.3.0(GUI 环境侧栏)：手动接入条目（kind=ssh，或 kind=vm 但无 vmx 的
  // 地址型条目）不被 vmrun/docker 覆盖——做 TCP 存活探测补进 instances，
  // 否则这些条目永远落在「已停止」分组（环境实际在跑）。
  // 1.3.8 B3：ssh 条目的连通字段是 host（不是 address），端口用条目 port
  // （缺省 22）——此前探测 e.address:22，ssh 环境永远「已停止」。
  const manualEntries = psEntries.filter((e) =>
    e.kind === 'ssh' ? !!(e.host ?? e.address) : e.kind === 'vm' && !e.vmx && !!e.address,
  );
  const probedManual = await Promise.all(
    manualEntries.map(async (e) => {
      const target = (e.kind === 'ssh' ? e.host ?? e.address : e.address)!;
      const alive = await psTcpProbeImpl(target, e.port ?? 22, 1500);
      if (!alive) return null;
      return {
        id: e.id,
        name: e.name ?? e.id,
        address: e.address ?? target,
        status: 'running',
        recipe: e.name ?? '',
        workspace: '',
        driver: (e.kind === 'ssh' ? 'ssh' : 'vm') as 'ssh' | 'vm',
      };
    }),
  );
  // 1.3.8 B7：同 id 多源行去重（hyperv 已登记条目运行且端口可达时，引擎行
  // 与手动探测行同 id 双行）——保序保留首个（引擎行优先于探测行）。
  const seen = new Set<string>();
  const instances = [
    ...dockerInstances,
    ...vmInstances,
    ...(hypervResult.ok ? hypervResult.instances.map((i) => ({ ...i, driver: 'hyperv' as const })) : []),
    ...(vboxResult.ok ? vboxResult.instances.map((i) => ({ ...i, driver: 'vbox' as const })) : []),
    ...probedManual.filter((x): x is NonNullable<typeof x> => x !== null),
  ].filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  return { success: true, data: { instances } };
}
/**
 * `environment/discover` — D28 自动发现本机环境（只读，不写配置）。
 *
 * 并行扫描宿主机：docker 全量容器（含已退出，去掉 zhishi.env 过滤）+ VMware
 * 运行中 vmx（vmrun list 只有运行中口径，无全量枚举 API）+ Hyper-V 全量 VM
 * （Get-VM 无过滤，1.3.8 B5）+ VirtualBox 全量 VM（list vms，1.3.8 B5）。
 * 任一引擎缺席/不可用都走 safe 降级（该侧返回空数组），绝不抛错、绝不拖垮
 * 其它侧。结果只用于 gate 的「本机已有」分组，**从不回写 config.json**
 * （D28 约束①）。全量口径会扫出用户无关 VM——与已登记条目的去重由 1.3.7
 * matchRegisteredEnv（GUI 侧）兜住。
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
/** environment/discover 的四源枚举通道（生产 = 各 lifecycle 实查）。
 *  模块级可替换——admin 接线测试注入假源，绝不真连 docker/vmrun/hyperv/vbox。 */
export interface DiscoverSources {
  dockerPsAll: () => Promise<EnvResult<{ instances: DiscoveredDocker[] }>>;
  vmPs: () => Promise<EnvResult<{ vmxes: string[] }>>;
  hypervPsAll: () => Promise<EnvResult<{ instances: HypervInstance[] }>>;
  vboxPsAll: () => Promise<EnvResult<{ instances: VboxInstance[] }>>;
}
const defaultDiscoverSources: DiscoverSources = {
  dockerPsAll: () => envPsAll(),
  vmPs: () => vmEnvPs(),
  hypervPsAll: () => hypervEnvPsAll(),
  vboxPsAll: () => vboxEnvPsAll(),
};
let discoverSourcesImpl: DiscoverSources = defaultDiscoverSources;
/** 测试注入 discover 四源（传 null 复位为生产源；Partial 可只换单侧）。 */
export function __setDiscoverSourcesForTests(sources: Partial<DiscoverSources> | null): void {
  discoverSourcesImpl = { ...defaultDiscoverSources, ...(sources ?? {}) };
}
export async function handleEnvironmentDiscover(): Promise<AdminResponse> {
  const [dockerResult, vmResult, hypervResult, vboxResult] = await Promise.all([
    discoverSourcesImpl.dockerPsAll(),
    discoverSourcesImpl.vmPs(),
    discoverSourcesImpl.hypervPsAll(),
    discoverSourcesImpl.vboxPsAll(),
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
 *
 * 1.1.6 #4 会话按环境分线：落盘后联动引擎切会话线（switchEnvSession）。
 * turn 进行中整体拒绝（rewind/fork 同口径）且先于落盘——选定落了而线
 * 没切，锚定工具（env 通道逐 turn 读选定）会与历史线串扰。
 */
export async function handleEnvironmentSelect(payload: {
  workspace?: string;
  selection?: unknown;
}): Promise<AdminResponse> {
  const workspace = typeof payload.workspace === 'string' ? payload.workspace.trim() : '';
  if (!workspace) return { success: false, error: 'Missing required argument: <workspace>' };
  const validated = validateEnvSelection(payload.selection);
  if (!validated.ok) return { success: false, error: validated.error };
  // 1.1.6 #4：busy 拒绝（仅当目标是本 sidecar 引擎的 workspace；其余 workspace 只落盘）
  const blocker = envSwitchBlocker(workspace);
  if (blocker) return { success: false, error: blocker };
  try {
    const selectedAt = new Date().toISOString();
    // 1.1.7 ①：锁内读-改-写（多实例共用数据目录时裸 load+save 有丢更新窗口）
    await mutateSelectionStore((store) => setWorkspaceSelection(store, workspace, validated.selection, selectedAt));
    // 落盘后联动引擎切线（非本引擎 workspace 时 no-op）。若与 turn 起跑
    // 撞车（前置闸之后的竞态），切换失败但选定已落盘——返回错误，重选即愈合。
    const switched = await switchEnvSession(workspace, envKeyForSelection(validated.selection));
    if (!switched.ok) return { success: false, error: switched.error ?? '环境会话线切换失败' };
    return { success: true, data: { workspace, selection: validated.selection, selectedAt } };
  } catch (err) {
    return { success: false, error: `Environment selection save failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
/** `environment/current` — 查询某 workspace 的当前选定；从未选定 → host。
 *  1.1.6 #4：附带该环境分线绑定的 SessionStore 会话 id（客户端启动接线用，
 *  additive 字段；无映射/映射无绑定会话 → null）。 */
export function handleEnvironmentCurrent(payload: {
  workspace?: string;
}): AdminResponse {
  const workspace = typeof payload.workspace === 'string' ? payload.workspace.trim() : '';
  if (!workspace) return { success: false, error: 'Missing required argument: <workspace>' };
  const record = getWorkspaceSelectionRecord(loadSelectionStore(), workspace);
  const binding = getEnvSessionBinding(workspace);
  return {
    success: true,
    data: {
      workspace,
      selection: record?.selection ?? HOST_SELECTION,
      selectedAt: record?.selectedAt ?? null,
      sessionId: binding?.sessionMetaId ?? null,
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
const SENSITIVE_TOP_KEYS = new Set(['providerApiKeys']);
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
/** 1.3.0(GUI)：TCP 连通性探测（手动接入条目的存活判定）。 */
function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveP) => {
    const sock = connect({ host, port, timeout: timeoutMs });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolveP(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.once('timeout', () => done(false));
    // 保险：connect 的 timeout 选项在 Windows 上未必触发，外部兜底。
    setTimeout(() => done(false), timeoutMs + 500).unref?.();
  });
}
