/**
 * 类型化 API 封装（1.3.0 GUI MVP）。
 *
 * 服务端契约逐字段对齐（读 src/server/index.ts / admin-api.ts 核实）：
 *   - /chat/send    POST { text, images?, permissionMode?, model?, providerEnv?, refs? }
 *                   → { success, queued?, queueId?, isInFlight?, steering? }
 *   - /chat/stop    POST {} → { success, alreadyStopped? }
 *   - /chat/model   POST { model, providerId } → { success, providerId, model }
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
import type { ArchiveSnapshot } from '../model/archive';

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
  /** 多配方绑定集合（1.3.8 关联侧，含主配方；缺省等价 [recipeId]）。 */
  recipeIds?: string[];
  address?: string;
  user?: string;
  keyPath?: string;
  /** 配方工具自检（environment/up 回写，缺 self-check 的条目无此项）。 */
  toolCheck?: { ok: boolean; missing: string[]; checkedAt: string };
  /** 能力域集合（1.3.7 场景 3，服务端现场推导：配方绑定域 ∪ 工具探测域）。
   *  探测失败/未推导过的存量条目无此字段——缺省即「未推导」，不是空集合。 */
  capabilityDomains?: string[];
  /** capabilityDomains 的推导时间（ISO）。 */
  capabilityDerivedAt?: string;
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
  /** 1.3.5：vmware 的 vmx 绝对路径（登记 payload 用）。 */
  vmx?: string;
}

export interface Recipe {
  id: string;
  name: string;
  description?: string;
  base?: string;
  tools: string[];
  /** 1.3.7：vm 配方的 guest SSH 缺省用户（frontmatter vm_user；向导预填用）。 */
  vmUser?: string;
  /** 1.3.8 ③b：SKILL.md 正文打法摘要（server recipes 端点透传，向导折叠展示）。 */
  workflowSummary?: string;
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

/** 1.3.7：domain/list 的域条目（recipe→domain 映射的数据源）。 */
export interface DomainEntity {
  kind: string;
  name: string;
  recipes: string[];
  skills?: string[];
  subagents?: string[];
  signalCount?: number;
}

/** admin domain/list → { success, data: { domains } }（handleDomainList）。 */
export function fetchDomainList(client: GuiSidecarClient): Promise<DomainEntity[]> {
  return client
    .adminPost<{ success: boolean; data?: { domains?: DomainEntity[] } }>('domain/list')
    .then((r) => (Array.isArray(r.data?.domains) ? r.data.domains : []));
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
  /** 1.3.7 向导补齐：非标端口（缺省 22）。 */
  port?: number;
  name?: string;
  osFamily?: 'linux' | 'windows';
  /** 1.3.7 向导补齐：绑定的配方 id（决定域归属；server registry 可选字段）。 */
  recipeId?: string;
}

/** 1.3.5：docker/vm 登记载荷（kind 与必填字段对齐 server registry 校验）。 */
export type EnvironmentAddInput =
  | SshAddInput
  | { id: string; kind: 'docker'; container: string; user?: string; keyPath?: string; recipeId?: string }
  | {
      id: string;
      kind: 'vm';
      vmName: string;
      vmx?: string;
      name?: string;
      osFamily?: 'linux' | 'windows';
      /** 1.3.7 实机修复 B：guest 地址（exec/探测通道前提；server registry 可选字段）。 */
      address?: string;
      user?: string;
      keyPath?: string;
      recipeId?: string;
    };

export function environmentAdd(
  client: GuiSidecarClient,
  input: EnvironmentAddInput,
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

export function resetChat(client: GuiSidecarClient): Promise<{ success: boolean; error?: string }> {
  return client.postJson<{ success: boolean; error?: string }>('/chat/reset', {});
}

// ---------------------------------------------------------------------------
// 1.3.1 新增：环境生命周期（准入闸启动 / 认领）
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

/**
 * 1.3.8 ①：停止运行中环境（侧栏「停止」按钮）。服务端按条目路由：
 * vmware 关 vmx、hyperv Stop-VM、vbox acpipowerbutton、docker stop+rm
 * （src/server/admin-api.ts::handleEnvironmentDown）。
 */
export function environmentDown(
  client: GuiSidecarClient,
  input: { id: string },
): Promise<{ success: boolean; error?: string; data?: { removed?: string } }> {
  return client.adminPost('environment/down', input);
}

export function environmentAdopt(
  client: GuiSidecarClient,
  input: { recipe: string; vmx: string; user?: string; keyPath?: string; password?: string },
): Promise<{ success: boolean; error?: string }> {
  return client.adminPost('environment/adopt', input);
}

/** 1.3.7 场景 3：能力集合重推 + 回写（侧栏「刷新」按钮）。 */
export function environmentCapabilityRefresh(
  client: GuiSidecarClient,
  input: { id: string },
): Promise<{ success: boolean; error?: string; data?: { capabilityDomains?: string[]; capabilityDerivedAt?: string } }> {
  return client.adminPost('environment/capability-refresh', input);
}

/** 1.3.8 多配方：绑定集合整体替换（含主配方，主配方不可移除）。 */
export function environmentBindRecipes(
  client: GuiSidecarClient,
  input: { id: string; recipeIds: string[] },
): Promise<{ success: boolean; error?: string; data?: { id?: string; recipeIds?: string[] } }> {
  return client.adminPost('environment/bind-recipes', input);
}

/**
 * 1.3.7 补口：删除已登记环境（侧栏「删除」按钮）。服务端按 kind 分派：
 * ssh/docker 摘登记（docker 运行中拒绝）、vmware 摘登记不动 VM 文件、
 * hyperv/vbox 删 VM 实例——语义确认文案在 model/env-remove。
 */
export function environmentRemove(
  client: GuiSidecarClient,
  input: { id: string },
): Promise<{ success: boolean; error?: string; data?: { removed?: string } }> {
  return client.adminPost('environment/rm', input);
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
  data?: { reportDir?: string; evidenceCount?: number; degraded?: string[]; sanitized?: boolean };
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

// ---------------------------------------------------------------------------
// 1.3.2 ①：决策应答 / 1.3.2 任务二 #4：情报部分更新 / attach 执行
// ---------------------------------------------------------------------------

/**
 * POST /chat/decision/respond { decisionId, choice, note? }：
 * unknown→404、已答→409（JSON envelope {success:false,error}，不抛 HTTP 错）。
 * 成功回 { success, data: { decisionId, injected, error? } }。
 */
export function decisionRespond(
  client: GuiSidecarClient,
  input: { decisionId: string; choice: string; note?: string },
): Promise<{
  success: boolean;
  error?: string;
  data?: { decisionId?: string; injected?: boolean; error?: string };
}> {
  return client.postJson('/chat/decision/respond', input);
}

/** POST /api/admin/intel/config-update（部分更新，只改传入字段）。 */
export function intelConfigUpdate(
  client: GuiSidecarClient,
  patch: Record<string, unknown>,
): Promise<{ success: boolean; error?: string; data?: { config?: Record<string, unknown> } }> {
  return client.adminPost('intel/config-update', patch);
}

/** POST /api/admin/environment/exec（环境内一次性命令，挂接 shell 的执行通道）。 */
export function environmentExec(
  client: GuiSidecarClient,
  input: { id: string; command: string },
): Promise<{ success: boolean; error?: string; data?: { stdout?: string; exitCode?: number } }> {
  return client.adminPost('environment/exec', input);
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
// 1.3.3 新增：会话清单 / 管理 / wire 历史回看 / @ 补全数据源
// ---------------------------------------------------------------------------

/** GET /sessions → SessionMetadata 行数组（形状归一在 model/history.ts）。 */
export function fetchSessions(client: GuiSidecarClient): Promise<unknown[]> {
  return client
    .getJson<{ success: boolean; sessions?: unknown[] }>('/sessions')
    .then((r) => (Array.isArray(r.sessions) ? r.sessions : []));
}

export type SessionMetaPatch = {
  title?: string;
  favorite?: boolean;
  pinned?: boolean;
  archived?: boolean;
};

/**
 * PATCH /sessions/:id（部分更新：title/favorite/pinned/archived）。
 * 服务端布尔字段只持久化 true（false 存 undefined）；返回更新后的 meta。
 */
export function patchSessionMeta(
  client: GuiSidecarClient,
  id: string,
  patch: SessionMetaPatch,
): Promise<{ success: boolean; error?: string; session?: unknown }> {
  return client.patchJson<{ success: boolean; error?: string; session?: unknown }>(
    `/sessions/${encodeURIComponent(id)}`,
    patch,
  );
}

/** DELETE /sessions/:id（含 transcript——UI 必须二次确认）。 */
export function deleteSessionMeta(
  client: GuiSidecarClient,
  id: string,
): Promise<{ success: boolean; error?: string }> {
  return client.deleteJson<{ success: boolean; error?: string }>(
    `/sessions/${encodeURIComponent(id)}`,
  );
}

/** POST /sessions/switch {sessionId} → 引擎切到该会话（续跑入口）。 */
export function switchSession(
  client: GuiSidecarClient,
  sessionId: string,
): Promise<{ success: boolean; error?: string; sessionId?: string }> {
  return client.postJson<{ success: boolean; error?: string; sessionId?: string }>(
    '/sessions/switch',
    { sessionId },
  );
}

export interface WireTranscriptResult {
  success: boolean;
  error?: string;
  /** 完整 wire 消息数组（含 1.3.2 决策块 kind:'decision'）。 */
  messages?: unknown[];
  totalMessages?: number;
  /** 超出 2000 条护栏，从头截断。 */
  truncated?: boolean;
}

/**
 * GET /api/loop-session/messages?loopSessionId=..&format=wire —— 历史面板
 * 只读回看（wire 形状与 /chat/stream 重放逐字段对齐，GUI reducer 可直接
 * 归约）。loopSessionId 缺失的行不要调（服务端 404）。
 */
export function fetchSessionWire(
  client: GuiSidecarClient,
  loopSessionId: string,
): Promise<WireTranscriptResult> {
  return client.getJson<WireTranscriptResult>(
    `/api/loop-session/messages?loopSessionId=${encodeURIComponent(loopSessionId)}&format=wire`,
  );
}

export interface WorkspaceFileEntry {
  /** 相对工作区根的 POSIX 路径。 */
  path: string;
  type: 'file' | 'dir' | 'symlink';
}

export interface WorkspaceFilesResult {
  success: boolean;
  error?: string;
  files?: WorkspaceFileEntry[];
  truncated?: boolean;
}

/** GET /api/workspace/files?dir=&depth=（@ 补全文件数据源）。 */
export function fetchWorkspaceFiles(
  client: GuiSidecarClient,
  input: { dir?: string; depth?: number },
): Promise<WorkspaceFilesResult> {
  const params = new URLSearchParams();
  if (input.dir) params.set('dir', input.dir);
  if (input.depth !== undefined) params.set('depth', String(input.depth));
  const qs = params.toString();
  return client.getJson<WorkspaceFilesResult>(`/api/workspace/files${qs ? `?${qs}` : ''}`);
}

export interface AgentEntity {
  name: string;
  description?: string;
  scope: 'user' | 'project';
  path: string;
  folderName: string;
}

/** GET /api/agents（@ 补全子代理数据源）。 */
export function fetchAgents(client: GuiSidecarClient): Promise<AgentEntity[]> {
  return client
    .getJson<{ success: boolean; agents?: AgentEntity[] }>('/api/agents')
    .then((r) => (Array.isArray(r.agents) ? r.agents : []));
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

// ---------------------------------------------------------------------------
// 1.3.5 新增：MCP 管理（设置页 MCP 页签——list/状态/启停/热重载）
// ---------------------------------------------------------------------------

/** admin mcp/list 的服务器条目（全量，含 enabled/isBuiltin 标记）。 */
export interface McpServerEntity {
  id: string;
  name: string;
  type?: string;
  enabled?: boolean;
  isBuiltin?: boolean;
  command?: string;
  url?: string;
  requiresConfig?: boolean;
  hasEnv?: boolean;
}

export function fetchMcpList(client: GuiSidecarClient): Promise<McpServerEntity[]> {
  return client
    .adminPost<{ success: boolean; data?: McpServerEntity[] }>('mcp/list')
    .then((r) => (Array.isArray(r.data) ? r.data : []));
}

/** admin mcp/list-status / mcp/reload 的桥状态条目（仅已启用服务器）。 */
export interface McpStatusEntity {
  id: string;
  name: string;
  status: 'connected' | 'failed';
  toolCount?: number;
  error?: string;
}

export function fetchMcpStatus(client: GuiSidecarClient): Promise<McpStatusEntity[]> {
  return client
    .adminPost<{ success: boolean; data?: { servers?: McpStatusEntity[] } }>('mcp/list-status')
    .then((r) => (Array.isArray(r.data?.servers) ? r.data.servers : []));
}

/** admin mcp/enable | mcp/disable { id }——写盘（桥由服务端联动）。 */
export function mcpToggle(
  client: GuiSidecarClient,
  id: string,
  enabled: boolean,
): Promise<{ success: boolean; error?: string }> {
  return client.adminPost<{ success: boolean; error?: string }>(enabled ? 'mcp/enable' : 'mcp/disable', { id });
}

/** admin mcp/reload {}——桥热重载（断开 → 重读磁盘 → 重连），返回新状态。 */
export function mcpReload(
  client: GuiSidecarClient,
): Promise<{ success: boolean; error?: string; data?: { servers?: McpStatusEntity[] } }> {
  return client.adminPost<{ success: boolean; error?: string; data?: { servers?: McpStatusEntity[] } }>(
    'mcp/reload',
    {},
  );
}

// ---------------------------------------------------------------------------
// 1.4.1 新增：auto loop（auto-run runner——启动/终止/加预算/验收终审/清单）
// ---------------------------------------------------------------------------

export interface AutoRunBudgetInput {
  kind: 'turns' | 'tokens' | 'time';
  limit: number;
}

export interface AutoRunStartInput {
  name: string;
  envKey: string;
  goal: string;
  budget: AutoRunBudgetInput;
  criteria: string[];
}

/**
 * POST /chat/auto-run/start → { success, id?, error? }。
 * id 兼容顶层或 data.id 两种回包（服务端契约「→ {id}」为准，两处都读）。
 */
export function autoRunStart(
  client: GuiSidecarClient,
  input: AutoRunStartInput,
): Promise<{ success: boolean; id?: string; error?: string }> {
  return client
    .adminPost<{ success: boolean; id?: string; data?: { id?: string }; error?: string }>(
      'auto-run/start',
      input,
    )
    .then((r) => ({ success: r.success, id: r.id ?? r.data?.id, error: r.error }));
}

/** POST auto-run/stop { id }（Esc 终止确认 → 终止 loop，会话保留回普通模式）。 */
export function autoRunStop(
  client: GuiSidecarClient,
  input: { id: string },
): Promise<{ success: boolean; error?: string }> {
  return client.adminPost<{ success: boolean; error?: string }>('auto-run/stop', input);
}

/** POST auto-run/budget { id, limit }（预算耗尽暂停点 → 加预算 + 续命）。 */
export function autoRunBudget(
  client: GuiSidecarClient,
  input: { id: string; limit: number },
): Promise<{ success: boolean; error?: string }> {
  return client.adminPost<{ success: boolean; error?: string }>('auto-run/budget', input);
}

/** POST auto-run/verdict { id, verdict }（验收终审三按钮；仅 awaiting-verdict 态）。 */
export function autoRunVerdict(
  client: GuiSidecarClient,
  input: { id: string; verdict: 'pass' | 'fail' | 'continue' },
): Promise<{ success: boolean; error?: string }> {
  return client.adminPost<{ success: boolean; error?: string }>('auto-run/verdict', input);
}

/** POST auto-run/list → 原始 JSON（形状归一在 model/auto-run::parseAutoRunList）。 */
export function autoRunList(client: GuiSidecarClient): Promise<unknown> {
  return client.adminPost<unknown>('auto-run/list', {});
}

// ---------------------------------------------------------------------------
// 1.4.4 研究档案（archive/list 查询 / archive/correct 人纠正）
// ---------------------------------------------------------------------------

/** POST archive/list（缺省当前会话线；auto-run 面板按 loopSessionId 显式传）。 */
export function fetchArchiveList(
  client: GuiSidecarClient,
  input: { sessionId?: string } = {},
): Promise<{ ok: boolean; error?: string; archive: ArchiveSnapshot | null }> {
  return client
    .adminPost<{ success: boolean; error?: string; data?: { archive?: ArchiveSnapshot } }>('archive/list', input)
    .then((r) => {
      if (!r.success) return { ok: false, error: r.error ?? 'archive/list 失败', archive: null };
      return { ok: true, archive: r.data?.archive ?? null };
    })
    .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err), archive: null }));
}

/** POST archive/correct { id, reason }（行内纠正；服务端广播 archive:changed）。 */
export function postArchiveCorrect(
  client: GuiSidecarClient,
  input: { id: string; reason: string },
): Promise<{ ok: boolean; error?: string }> {
  return client
    .adminPost<{ success: boolean; error?: string }>('archive/correct', input)
    .then((r) => ({ ok: r.success, error: r.error }))
    .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
}

/** POST archive/resolve { id, note? }（假设证实/问题解决；服务端广播 archive:changed）。 */
export function postArchiveResolve(
  client: GuiSidecarClient,
  input: { id: string; note?: string },
): Promise<{ ok: boolean; error?: string }> {
  return client
    .adminPost<{ success: boolean; error?: string }>('archive/resolve', input)
    .then((r) => ({ ok: r.success, error: r.error }))
    .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
}
