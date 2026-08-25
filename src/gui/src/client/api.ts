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
