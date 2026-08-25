/**
 * 类型化 API 封装（1.3.0 GUI MVP）。
 *
 * 服务端契约逐字段对齐（读 src/server/index.ts / admin-api.ts 核实）：
 *   - /chat/send    POST { text, images?, permissionMode?, model?, providerEnv?, refs? }
 *                   → { success, queued?, queueId?, isInFlight?, steering? }
 *   - /chat/stop    POST {} → { success, alreadyStopped? }
 *   - /chat/model   POST { model, providerId } → { success, providerId, model }
 *   - /api/session-state GET → { sessionState }
 *   - /api/admin/environment/list     → { success, data: { environments } }
 *   - /api/admin/environment/ps       → { success, data: { instances } }
 *   - /api/admin/environment/discover → { success, data: { docker, vm } }
 *   - /api/admin/environment/recipes  → { success, data: { root, recipes } }
 *   - /api/admin/environment/select   POST { workspace, selection } → { success, data? }
 *   - /api/admin/environment/add      POST EnvironmentEntryInput → { success }
 *   - /api/admin/model/list           → { success, data: [{ id, name, …, models }] }
 */

import type { GuiSidecarClient } from './sse-client';
import type { Ref } from '../model/send';

// ---------------------------------------------------------------------------
// 形状（与 server 侧契约一致的最小声明）
// ---------------------------------------------------------------------------

export interface EnvEntry {
  id: string;
  kind: 'ssh' | 'docker' | 'vm';
  name?: string;
  host?: string;
  container?: string;
  vmName?: string;
  vmx?: string;
  osFamily?: 'linux' | 'windows';
  recipeId?: string;
  address?: string;
  user?: string;
  keyPath?: string;
  /** 配方工具自检（environment/up 回写，缺 self-check 的条目无此项）。 */
  toolCheck?: { ok: boolean; missing: string[]; checkedAt: string };
}

export interface PsInstance {
  id: string;
  name?: string;
  status?: string;
  driver?: string;
}

export interface DiscoveredDocker {
  id: string;
  name?: string;
  status?: string;
}

export interface DiscoveredVm {
  driver: 'vmware' | 'hyperv' | 'vbox';
  id: string;
  name?: string;
  state?: string;
  osFamily?: 'linux' | 'windows';
}

export interface Recipe {
  id: string;
  name: string;
  description?: string;
  base?: string;
  tools: string[];
}

export interface ModelEntity {
  model: string;
  modelName?: string;
  modelSeries?: string;
  contextLength?: number;
}

export interface ModelProvider {
  id: string;
  name?: string;
  vendor?: string;
  protocol?: string;
  enabled?: boolean;
  hasApiKey?: boolean;
  status?: string;
  primaryModel?: string;
  models: ModelEntity[];
}

export type EnvSelection =
  | { kind: 'env'; id: string }
  | { kind: 'recipe'; name: string; instanceId: string }
  | { kind: 'host' };

export interface SendResult {
  success: boolean;
  error?: string;
  queued?: boolean;
  queueId?: string;
  isInFlight?: boolean;
  steering?: boolean;
}

// ---------------------------------------------------------------------------
// 封装
// ---------------------------------------------------------------------------

export function fetchEnvironmentList(client: GuiSidecarClient): Promise<EnvEntry[]> {
  return client
    .adminPost<{ success: boolean; data?: { environments?: EnvEntry[] } }>('environment/list')
    .then((r) => r.data?.environments ?? []);
}

export function fetchEnvironmentPs(client: GuiSidecarClient): Promise<PsInstance[]> {
  return client
    .adminPost<{ success: boolean; data?: { instances?: PsInstance[] } }>('environment/ps')
    .then((r) => r.data?.instances ?? []);
}

export function fetchEnvironmentDiscover(
  client: GuiSidecarClient,
): Promise<{ docker: DiscoveredDocker[]; vm: DiscoveredVm[] }> {
  return client
    .adminPost<{ success: boolean; data?: { docker?: DiscoveredDocker[]; vm?: DiscoveredVm[] } }>(
      'environment/discover',
    )
    .then((r) => ({ docker: r.data?.docker ?? [], vm: r.data?.vm ?? [] }));
}

export function fetchEnvironmentRecipes(client: GuiSidecarClient): Promise<Recipe[]> {
  return client
    .adminPost<{ success: boolean; data?: { recipes?: Recipe[] } }>('environment/recipes')
    .then((r) => r.data?.recipes ?? []);
}

export interface ModelListResult {
  providers: ModelProvider[];
  current?: { providerId?: string; modelId?: string };
}

export function fetchModelList(client: GuiSidecarClient): Promise<ModelListResult> {
  return client
    .adminPost<{
      success: boolean;
      data?: ModelProvider[];
      current?: { providerId?: string; modelId?: string };
    }>('model/list')
    .then((r) => ({ providers: r.data ?? [], current: r.current }));
}

export function environmentSelect(
  client: GuiSidecarClient,
  workspace: string,
  selection: EnvSelection,
): Promise<{ success: boolean; error?: string }> {
  return client.adminPost<{ success: boolean; error?: string }>('environment/select', {
    workspace,
    selection,
  });
}

export interface SshAddInput {
  id: string;
  kind: 'ssh';
  host: string;
  user?: string;
  keyPath?: string;
}

export function environmentAdd(
  client: GuiSidecarClient,
  input: SshAddInput,
): Promise<{ success: boolean; error?: string }> {
  return client.adminPost<{ success: boolean; error?: string }>('environment/add', input);
}

export function sendChatMessage(
  client: GuiSidecarClient,
  body: { text: string; refs?: Ref[] },
): Promise<SendResult> {
  return client.postJson<SendResult>('/chat/send', body);
}

export function stopChat(client: GuiSidecarClient): Promise<{ success: boolean }> {
  return client.postJson<{ success: boolean }>('/chat/stop', {});
}

export function setModel(
  client: GuiSidecarClient,
  model: string,
  providerId: string,
): Promise<{ success: boolean; error?: string }> {
  return client.postJson<{ success: boolean; error?: string }>('/chat/model', { model, providerId });
}

export function getSessionState(
  client: GuiSidecarClient,
): Promise<{ sessionState?: string }> {
  return client.getJson<{ sessionState?: string }>('/api/session-state');
}

export function resetChat(client: GuiSidecarClient): Promise<{ success: boolean; error?: string }> {
  return client.postJson<{ success: boolean; error?: string }>('/chat/reset', {});
}

// ---------------------------------------------------------------------------
// 1.3.1 新增：环境生命周期（准入闸启动 / 快照 / 回滚 / 提取 / 认领）
// ---------------------------------------------------------------------------

export interface EnvUpInput {
  recipe: string;
  workspace?: string;
  vmBase?: string;
  user?: string;
  keyPath?: string;
}

export function environmentUp(
  client: GuiSidecarClient,
  input: EnvUpInput,
): Promise<{ success: boolean; error?: string; data?: Record<string, unknown> }> {
  return client.adminPost('environment/up', input);
}

export function environmentAdopt(
  client: GuiSidecarClient,
  input: { recipe: string; vmx: string; user?: string; keyPath?: string; password?: string },
): Promise<{ success: boolean; error?: string }> {
  return client.adminPost('environment/adopt', input);
}

export function environmentSnapshot(
  client: GuiSidecarClient,
  input: { id: string; name?: string },
): Promise<{ success: boolean; error?: string; data?: { snapshot?: string } }> {
  return client.adminPost('environment/snapshot', input);
}

export function environmentRollback(
  client: GuiSidecarClient,
  input: { id: string; snapshot: string },
): Promise<{ success: boolean; error?: string }> {
  return client.adminPost('environment/rollback', input);
}

export function environmentExtract(
  client: GuiSidecarClient,
  input: { id: string; guestPath: string; workspace?: string },
): Promise<{ success: boolean; error?: string; data?: { savedTo?: string } }> {
  return client.adminPost('environment/extract', input);
}

export interface CurrentEnvResult {
  success: boolean;
  error?: string;
  data?: { selection?: unknown; sessionId?: string | null };
}

export function fetchEnvironmentCurrent(
  client: GuiSidecarClient,
  workspace: string,
): Promise<CurrentEnvResult> {
  return client.adminPost<CurrentEnvResult>('environment/current', { workspace });
}

// ---------------------------------------------------------------------------
// 1.3.1 新增：线程命令（rewind / fork / queue / export）
// ---------------------------------------------------------------------------

export function chatRewind(
  client: GuiSidecarClient,
  userMessageId: string,
): Promise<{ success: boolean; error?: string }> {
  return client.postJson<{ success: boolean; error?: string }>('/chat/rewind', { userMessageId });
}

export function forkSession(
  client: GuiSidecarClient,
  messageId: string,
): Promise<{ success: boolean; error?: string; sessionId?: string }> {
  return client.postJson<{ success: boolean; error?: string; sessionId?: string }>(
    '/sessions/fork',
    { messageId },
  );
}

export interface QueueStatusItem {
  id: string;
  messagePreview: string;
  kind: 'fifo' | 'steering';
}

export function fetchQueueStatus(
  client: GuiSidecarClient,
): Promise<{ success: boolean; queue?: QueueStatusItem[] }> {
  return client.getJson<{ success: boolean; queue?: QueueStatusItem[] }>('/chat/queue/status');
}

export function cancelQueueItem(
  client: GuiSidecarClient,
  queueId: string,
): Promise<{ success: boolean; error?: string; cancelledText?: string }> {
  return client.postJson<{ success: boolean; error?: string; cancelledText?: string }>(
    '/chat/queue/cancel',
    { queueId },
  );
}

export function reportExport(
  client: GuiSidecarClient,
  input: { workspace: string; sanitize?: boolean },
): Promise<{
  success: boolean;
  error?: string;
  data?: { reportDir?: string; evidenceCount?: number; degraded?: boolean; sanitized?: boolean };
}> {
  return client.adminPost('report/export', input);
}

// ---------------------------------------------------------------------------
// 1.3.1 新增：越界应答 / 任务中心 / 子代理 transcript
// ---------------------------------------------------------------------------

export function boundaryRespond(
  client: GuiSidecarClient,
  input: { askId: string; approve: boolean; note?: string },
): Promise<{ success: boolean; error?: string }> {
  return client.postJson<{ success: boolean; error?: string }>('/chat/boundary/respond', input);
}

export function taskList(client: GuiSidecarClient): Promise<unknown[]> {
  return client
    .adminPost<{ success: boolean; data?: unknown[] }>('task/list')
    .then((r) => (Array.isArray(r.data) ? r.data : []));
}

export function taskGet(client: GuiSidecarClient, id: string): Promise<unknown> {
  return client
    .adminPost<{ success: boolean; data?: unknown }>('task/get', { id })
    .then((r) => r.data);
}

export interface LoopTranscriptLine {
  role?: string;
  content?: unknown;
  name?: string;
  ok?: boolean;
  isError?: boolean;
  timestamp?: string;
}

export function fetchLoopTranscript(
  client: GuiSidecarClient,
  loopSessionId: string,
): Promise<LoopTranscriptLine[] | null> {
  return client
    .getJson<{ success: boolean; transcript?: LoopTranscriptLine[] | null }>(
      `/api/loop-session/messages?loopSessionId=${encodeURIComponent(loopSessionId)}`,
    )
    .then((r) => r.transcript ?? null);
}

// ---------------------------------------------------------------------------
// 1.3.1 新增：设置页（skills / intel / expert / research / model key）
// ---------------------------------------------------------------------------

export interface SkillEntity {
  name: string;
  description?: string;
  scope?: string;
  folderName?: string;
  author?: string;
  enabled: boolean;
}

export function fetchSkillList(client: GuiSidecarClient): Promise<SkillEntity[]> {
  return client
    .adminPost<{ success: boolean; data?: SkillEntity[] }>('skill/list')
    .then((r) => (Array.isArray(r.data) ? r.data : []));
}

export function skillToggle(
  client: GuiSidecarClient,
  name: string,
  enabled: boolean,
): Promise<{ success: boolean; error?: string; data?: { name: string; enabled: boolean } }> {
  return client.adminPost(enabled ? 'skill/enable' : 'skill/disable', { name });
}

/** 技能导入走 sidecar 直连路由（非 admin）：POST /api/skill/import-folder。 */
export function skillImportFolder(
  client: GuiSidecarClient,
  folderPath: string,
  scope: 'user' | 'project' = 'user',
): Promise<{ success: boolean; error?: string }> {
  return client.postJson<{ success: boolean; error?: string }>('/api/skill/import-folder', {
    folderPath,
    scope,
  });
}

export interface IntelStatusData {
  status?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export function fetchIntelStatus(client: GuiSidecarClient): Promise<IntelStatusData> {
  return client
    .adminPost<{ success: boolean; data?: IntelStatusData }>('intel/status')
    .then((r) => r.data ?? {});
}

export function intelUpdate(
  client: GuiSidecarClient,
  mode?: string,
): Promise<{ success: boolean; error?: string; data?: unknown }> {
  return client.adminPost('intel/update', mode ? { mode } : {});
}

export interface ExpertSummary {
  id: number;
  domain?: string;
  kind?: string;
  title?: string;
  applicability?: string;
  contentPreview?: string;
  criteria?: string;
  provenance?: string;
  reviewer?: string;
  tags?: string[];
  enabled?: boolean;
  createdAt?: string;
}

export function expertSearch(
  client: GuiSidecarClient,
  query: string,
): Promise<{ success: boolean; error?: string; data?: { results?: ExpertSummary[] } }> {
  return client.adminPost('expert/search', { query });
}

export function expertList(
  client: GuiSidecarClient,
): Promise<{ success: boolean; error?: string; data?: { entries?: ExpertSummary[] } }> {
  return client.adminPost('expert/list', {});
}

export function expertShow(
  client: GuiSidecarClient,
  id: number,
): Promise<{ success: boolean; error?: string; data?: { entry?: Record<string, unknown> } }> {
  return client.adminPost('expert/show', { id });
}

export function expertAdd(
  client: GuiSidecarClient,
  entry: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  return client.adminPost('expert/add', entry);
}

export function expertRm(
  client: GuiSidecarClient,
  id: number,
): Promise<{ success: boolean; error?: string }> {
  return client.adminPost('expert/rm', { id });
}

export interface ExpertDraft {
  id: number;
  domain?: string;
  kind?: string;
  title?: string;
  content?: string;
  reviewer?: string;
  createdAt?: string;
}

export function expertDrafts(
  client: GuiSidecarClient,
): Promise<{ success: boolean; error?: string; data?: { drafts?: ExpertDraft[] } }> {
  return client.adminPost('expert/drafts', {});
}

export function expertReview(
  client: GuiSidecarClient,
  input: { draftId: number; action: 'approve' | 'discard'; edited?: Record<string, unknown> },
): Promise<{ success: boolean; error?: string }> {
  return client.adminPost('expert/review', input);
}

export interface ResearchEventRow {
  id?: number;
  workspace?: string;
  taskKind?: string;
  outcome?: string;
  summary?: string;
  bugClass?: string;
  createdAt?: string;
}

export function researchList(client: GuiSidecarClient): Promise<ResearchEventRow[]> {
  return client
    .adminPost<{ success: boolean; data?: { results?: ResearchEventRow[] } }>('research/list', {
      limit: 100,
    })
    .then((r) => (Array.isArray(r.data?.results) ? r.data.results : []));
}

export function modelSetKey(
  client: GuiSidecarClient,
  id: string,
  apiKey: string,
): Promise<{ success: boolean; error?: string; hint?: string }> {
  return client.adminPost('model/set-key', { id, apiKey });
}

export function modelSetDefault(
  client: GuiSidecarClient,
  id: string,
): Promise<{ success: boolean; error?: string }> {
  return client.adminPost('model/set-default', { id });
}

export function modelVerify(
  client: GuiSidecarClient,
  id: string,
  model?: string,
): Promise<{ success: boolean; error?: string; hint?: string }> {
  return client.adminPost('model/verify', { id, model });
}
