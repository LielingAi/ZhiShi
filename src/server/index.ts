import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync , rmSync, renameSync } from 'fs';
import { copyFile as copyFileAsync, readdir as readdirAsync, rm, stat } from 'fs/promises';
import { spawn as subprocessSpawn } from './utils/subprocess';
import { fileResponse, sniffMime } from './utils/file-response';
import { getToolAttachmentRoot, validateExternalReadPathNode } from './utils/path-safety';
import { serve as honoServe } from '@hono/node-server';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
/**
 * Hard upper bound on a single multipart request body (aggregate of all files
 * + text fields). Sidecar lives on 127.0.0.1 so the threat model is mostly
 * local WebView / same-machine callers, but we still gate to prevent runaway
 * uploads from OOM-ing the Node.js heap. Node's standard `Request.formData()`
 * buffers the entire body before resolving — there is no streaming multipart
 * parser in the Web API — so this cap must be enforced via Content-Length
 * BEFORE calling `.formData()`.
 */
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB
/**
 * Check request Content-Length against MAX_UPLOAD_BYTES.
 * Returns a 413 Response to hand back, or null when within budget.
 * Missing Content-Length is treated as unknown — we still allow `.formData()`
 * to run, but callers should prefer Content-Length-aware clients.
 */
function rejectIfOversizedUpload(request: Request): Response | null {
  const lenHeader = request.headers.get('content-length');
  if (!lenHeader) return null;
  const len = Number(lenHeader);
  if (Number.isFinite(len) && len > MAX_UPLOAD_BYTES) {
    return jsonResponse(
      { error: `Upload too large (${len} bytes > ${MAX_UPLOAD_BYTES} limit).` },
      413,
    );
  }
  return null;
}
/**
 * Write an incoming Web `File` (multipart upload) to disk via streaming.
 *
 * NOTE: Node's `Request.formData()` already buffers the full body before
 * resolving the FormData — `file.stream()` here is reading from an
 * in-memory Blob, not from the live socket. The pipeline-to-disk still
 * helps by avoiding an extra `arrayBuffer() + Buffer.from()` copy, but
 * it does NOT bound memory during the parse itself. That bound is
 * enforced by `rejectIfOversizedUpload()` at the route edge.
 *
 * On error mid-pipeline, the partially-written destination is removed so
 * callers don't observe half-files on disk.
 */
async function streamUploadToFile(file: File, destination: string): Promise<void> {
  const webStream = file.stream() as unknown as ReadableStream<Uint8Array>;
  const nodeReadable = Readable.fromWeb(webStream as unknown as import('node:stream/web').ReadableStream<Uint8Array>);
  try {
    await pipeline(nodeReadable, createWriteStream(destination));
  } catch (err) {
    await rm(destination, { force: true }).catch(() => { /* best-effort cleanup */ });
    throw err;
  }
}
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { getZhiShiDataDir } from './utils/app-dirs';
import { randomUUID } from 'crypto';
import { elapsedMs, emitPerfTrace, nowMs } from './utils/perf-trace';
// adm-zip lazy-loaded at its call site below — saves ~30ms of module-init
// cost when the feature is never used.
import {
  extractCommandName,
  parseFullSkillContent,
  parseFullCommandContent,
  serializeSkillContent,
  serializeCommandContent,
  type SkillFrontmatter,
  type CommandFrontmatter
} from '../shared/slashCommands';
import { sanitizeFolderName, isWindowsReservedName } from '../shared/utils';
import { parseAgentFrontmatter, parseFullAgentContent, serializeAgentContent } from '../shared/agentCommands';
import { scanAgents, readWorkspaceConfig, writeWorkspaceConfig, loadEnabledAgents, readAgentMeta, writeAgentMeta, findAgent } from './agents/agent-loader';
import type { AgentFrontmatter, AgentMeta, AgentWorkspaceConfig } from '../shared/agentTypes';
import type { BackgroundAgentPermissionMode } from '../shared/config-types';
import { ensureDirSync, ensureDir } from './utils/fs-utils';
import { handleCronCheckCompletion, handleCronExecute, handleCronExecuteSync } from './cron/routes';
import {
  handleCreateSession,
  handleDeleteSession,
  handleForkSession,
  handleGenerateSessionTitle,
  handleGetSession,
  handleGetSessionSince,
  handleGetSessionStats,
  handleListSessions,
  handlePatchSession,
  handleSwitchSession,
} from './routes/sessions';
import {
  handleMcpEnable,
  handleMcpGet,
  handleMcpOauthDiscover,
  handleMcpOauthRefresh,
  handleMcpOauthStart,
  handleMcpOauthStatus,
  handleMcpOauthToken,
  handleMcpSet,
} from './routes/mcp';
// admin-api module (~2900 lines, depends on zod + full config/session/cron surface)
// is lazy-loaded on first /api/admin/* hit to shave ~150ms off sidecar cold
// start. All handlers are only used inside routeAdminApi() below.
type AdminApiModule = typeof import('./admin-api');
let _adminApi: Promise<AdminApiModule> | null = null;
const getAdminApi = (): Promise<AdminApiModule> => (_adminApi ??= import('./admin-api'));
// ============= CRASH DIAGNOSTICS =============
// Extracted to ./crash-log (pure move). installCrashDiagnostics() is called
// here, at the exact position of the original block, so process/stdio handler
// registration order relative to the rest of module init is unchanged.
installCrashDiagnostics();
// ============= END CRASH DIAGNOSTICS =============
import {
  initializeAgent,
  getMcpServers,
  setAgents,
  setSessionModel,
  setSidecarPort,
  getSessionModel,
  syncProjectUserConfig,
  setProxyConfig,
  initSocksBridgeFromEnv,
  getHistoricalSessionMessages,
} from './agent-session';
import { getHomeDirOrNull } from './utils/platform';
import {
  getAllSessionMetadata,
  getSessionData,
  getAttachmentPath,
} from './SessionStore';
import { atomicModifyConfig, findEffectiveProvider, getAllEffectiveProviders, isProviderDisabled, loadConfig, resolveKimiApiKey } from './utils/admin-config';
// 1.3.7 场景 1：存量 vm 环境条目「实例即环境」一次性迁移（幂等，失败不炸启动）。
import { runLegacyVmEntryMigration } from './environment/vm-entry-migration';
import { initLogger, getLoggerDiagnostics, withLogContext, setStdioBrokenProbe } from './logger';
// `isStdioBroken` / `markStdioBroken` live in ./crash-log (extracted from the
// crash-diagnostics block above) and are consumed by `setStdioBrokenProbe`
// below to wire the logger's safe-write wrapper to the stdio-state bit.
import { installCrashDiagnostics, isStdioBroken, markStdioBroken } from './crash-log';
export { isStdioBroken, markStdioBroken };
import {
  buildGateResponseBody,
  buildReadyResponseBody,
  markDeferredInitFailed,
  markDeferredInitReady,
  setDeferredInitPhase,
} from './readiness-state';
import { appendUnifiedLogBatch, getActiveUnifiedLogPath } from './UnifiedLogger';
import { getActiveSessionLogPath } from './AgentLogger';
import { runLogRetentionSweep, startPeriodicSweep } from './log-retention';
import { broadcast, createSseClient, getClients } from './sse';
import {
  isPiEngine,
  initPiChatEngine,
  sendPiChatMessage,
  queuePiChatMessage,
  stopPiChat,
  resetPiChat,
  rewindPiChat,
  cancelPiQueueItem,
  forcePiQueueItem,
  getPiQueueStatus,
  getPiQueueSnapshotEvents,
  getPiAgentState,
  getPiMessages,
  getPiStreamingAssistantId,
  getPiSystemInitInfo,
  getPiLogLines,
  // 1.3.2 决策面板:注入 + 当前线只读快照(boundary 应答落盘 transcript 用)。
  injectPiDecision,
  getPiCurrentSessionRef,
  // 1.3.10 C2:/chat/send 错误文本 → 状态码(配置缺失 400,其余 429)。
  chatSendErrorStatus,
} from './loop/chat-engine';
import { buildLoopTranscript } from './loop/transcript';
import { initMcpBridge } from './loop/mcp-bridge';
import { isKimiCodingProvider } from './loop/pi-provider';
import { pendingBoundaryAsks, respondBoundaryAsk } from './loop/boundary-ask';
// 1.3.2 决策面板:pending 注册表 + 重连重放。
import { pendingDecisions, respondDecision } from './loop/decision';
// 越界/决策应答落盘 transcript 的持久化通道。
import { appendLoopMessages, defaultLoopSessionDir, loadLoopSession, loopSessionFile } from './loop/session';
// 1.3.3:历史面板 wire 回放(loop jsonl → 完整 wire 消息,含决策块)。
import { buildLoopWireMessages } from './loop/wire-replay';
// 1.3.3:attach 交互式 pty 端点(WS upgrade)。
import { installTermUpgradeHandler } from './loop/term-pty';
// 1.3.3:@ 补全文件数据源——工作区目录树只读列表。
import { listWorkspaceFiles } from './workspace-files';
import { verifyProviderViaSdk } from './provider-verify';
// M4c: openai-bridge 已删除(OpenAI 协议 provider 由 pi 原生直连)。
// M4c: bridge-cache 随 bridge 删除。
// title-generator is dynamically imported in the /api/title-generate handler
// below — it value-imports the Claude Agent SDK, which is large. Pulling
// that into the Tier 0
// startup graph delayed `/health` bind on cold start (cf. v0.2.0 Tier 0
// goals) and crashed the sidecar before it could serve a 503 if the SDK
// native binary failed to load. The handler is in the post-bind path, so
// dynamic-import there is free.
import { installAutoTitleHook } from './session-title-service';
import type { ImagePayload } from '../shared/types/image';
import type { RuntimeConfig } from '../shared/types/runtime';
export type PermissionMode = 'auto' | 'plan' | 'fullAgency' | 'custom';
type SendMessagePayload = {
  text?: string;
  images?: ImagePayload[];
  permissionMode?: PermissionMode;
  // Background-agent permission policy (#264). Global app-config value the
  // renderer echoes per-send (idempotent setter); controls the builtin
  // PermissionRequest hook for run_in_background sub-agents.
  backgroundAgentPermissionMode?: BackgroundAgentPermissionMode;
  runtimeConfig?: RuntimeConfig;
  model?: string;
  // undefined/missing = "keep current provider" (safe default for IM/Cron callers)
  // object = use this specific provider
  providerEnv?: {
    baseUrl?: string;
    apiKey?: string;
    authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
    apiProtocol?: 'anthropic' | 'openai';
    maxOutputTokens?: number;
    maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
    upstreamFormat?: 'chat_completions' | 'responses';
  };
  // W1(design-spec §6.4)— @ 引用:additive 可选数组,服务端经 env 通道解析
  // 成 grounding 段前置进 prompt(契约不变,旧客户端不传即可)。
  refs?: unknown[];
};
function parseArgs(argv: string[]): { agentDir: string; initialPrompt?: string; port: number; sessionId?: string } {
  const args = argv.slice(2);
  const getArgValue = (flag: string) => {
    const index = args.indexOf(flag);
    if (index === -1) {
      return null;
    }
    return args[index + 1] ?? null;
  };
const agentDir = getArgValue('--agent-dir') ?? '';
  const initialPrompt = getArgValue('--prompt') ?? undefined;
  const port = Number(getArgValue('--port') ?? 3000);
  const sessionId = getArgValue('--session-id') ?? undefined;
if (!agentDir) {
    throw new Error('Missing required argument: --agent-dir <path>');
  }
return { agentDir, initialPrompt, port: Number.isNaN(port) ? 3000 : port, sessionId };
}
/**
 * Expand ~ to user's home directory
 */
function expandTilde(path: string): string {
  if (path.startsWith('~/') || path === '~') {
    const homeDir = getHomeDirOrNull() || '';
    return path.replace(/^~/, homeDir);
  }
  return path;
}
async function ensureAgentDir(dir: string): Promise<string> {
  const expanded = expandTilde(dir);
  const resolved = resolve(expanded);
  if (!existsSync(resolved)) {
    await ensureDir(resolved);
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error(`Agent directory is not a directory: ${resolved}`);
  }
  return resolved;
}
// ============= SKILLS CONFIG & SEED =============
// Extracted to ./skills-config (1.1.7 ③). writeSkillsConfig was folded into
// mutateSkillsConfig (withFileLock 锁内读-改-写 + tmp+rename)；调用点随之 async 化。
// ============= END SKILLS CONFIG & SEED =============
import { bumpSkillsGeneration, cleanupStalePlaywrightProfile, mutateSkillsConfig, seedBundledSkills, seedEnvironmentRecipes } from './skills-config';
import { seedBundledExpert } from './expert/seed';
/**
 * Validate that the agent directory is safe to access.
 * Prevents directory traversal attacks and access to sensitive directories.
 */
function isValidAgentDir(dir: string): { valid: boolean; reason?: string } {
  const expanded = expandTilde(dir);
  const resolved = resolve(expanded);
  const homeDir = getHomeDirOrNull() || '';
// Must be an absolute path (use isAbsolute for cross-platform correctness)
  if (!isAbsolute(resolved)) {
    return { valid: false, reason: 'Path must be absolute' };
  }
// Forbidden system directories (deny-list approach)
  const forbiddenPaths = [
    // Unix system directories
    '/etc', '/var', '/usr', '/bin', '/sbin', '/boot', '/root', '/sys', '/proc', '/dev',
    // User sensitive directories
    join(homeDir, '.ssh'),
    join(homeDir, '.gnupg'),
    join(homeDir, '.config/op'),  // 1Password
    join(homeDir, 'Library/Keychains'),
    // Windows system directories
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ];
const normalizedResolved = resolved.replace(/\\/g, '/').toLowerCase();
  for (const forbidden of forbiddenPaths) {
    const normalizedForbidden = forbidden.replace(/\\/g, '/').toLowerCase();
    if (normalizedResolved === normalizedForbidden || normalizedResolved.startsWith(normalizedForbidden + '/')) {
      return { valid: false, reason: `Access to ${forbidden} is not allowed` };
    }
  }
// Reject filesystem roots as workspace (too broad, not a real project)
  // Windows: "C:\", "D:\" etc.  Unix: "/"
  if (resolved === '/' || resolved.match(/^[A-Z]:\\?$/i)) {
    return { valid: false, reason: 'Cannot use filesystem root as workspace' };
  }
return { valid: true };
}
function resolveAgentPath(root: string, relativePath: string): string | null {
  // Strip leading slashes (both / and \ for Windows compatibility)
  const normalized = relativePath.replace(/^[/\\]+/, '');
  const resolved = resolve(root, normalized);
  // Use root + sep to prevent prefix collision (e.g. /agent matching /agent-other)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return null;
  }
  return resolved;
}
// Phase E (PRD 0.2.7): the legacy read-side helpers `isSafeReadPath`,
// `resolveReadPath`, `isPreviewableText` are removed. Their gates now live
// in Rust workspace_files (`path_safety::validate_workspace_root`,
// `resolve_existing_inside_workspace`, `read_preview::is_previewable`).
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    // 1.3.0(GUI):ACAO 放行——webview/浏览器直连 sidecar 需要;CORS 预检
    // 只覆盖 OPTIONS,不带这个头浏览器会静默拦掉一切 JSON 响应。
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
/**
 * Route /api/admin/* requests to the appropriate handler.
 * Keeps the route matching logic clean and separated from business logic (in admin-api.ts).
 */
async function routeAdminApi(pathname: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Strip the prefix for matching
  const route = pathname.replace('/api/admin/', '');
// Lazy-load admin-api (~150ms on first hit, cached thereafter)
  const api = await getAdminApi();
// MCP commands
  if (route === 'mcp/list') return api.handleMcpList();
  if (route === 'mcp/show') return api.handleMcpShow(payload as Parameters<typeof api.handleMcpShow>[0]);
  if (route === 'mcp/add') return api.handleMcpAdd(payload as Parameters<typeof api.handleMcpAdd>[0]);
  if (route === 'mcp/remove') return api.handleMcpRemove(payload as Parameters<typeof api.handleMcpRemove>[0]);
  if (route === 'mcp/enable') return api.handleMcpEnable(payload as Parameters<typeof api.handleMcpEnable>[0]);
  if (route === 'mcp/disable') return api.handleMcpDisable(payload as Parameters<typeof api.handleMcpDisable>[0]);
  if (route === 'mcp/env') return api.handleMcpEnv(payload as Parameters<typeof api.handleMcpEnv>[0]);
  if (route === 'mcp/test') return await api.handleMcpTest(payload as Parameters<typeof api.handleMcpTest>[0]);
  if (route === 'mcp/oauth/discover') return await api.handleMcpOAuthDiscover(payload as Parameters<typeof api.handleMcpOAuthDiscover>[0]);
  if (route === 'mcp/oauth/start') return await api.handleMcpOAuthStart(payload as Parameters<typeof api.handleMcpOAuthStart>[0]);
  if (route === 'mcp/oauth/status') return await api.handleMcpOAuthStatus(payload as Parameters<typeof api.handleMcpOAuthStatus>[0]);
  if (route === 'mcp/oauth/revoke') return await api.handleMcpOAuthRevoke(payload as Parameters<typeof api.handleMcpOAuthRevoke>[0]);
  if (route === 'mcp/list-status') return await api.handleMcpListStatus();
  if (route === 'mcp/reload') return await api.handleMcpReload();
// Model commands
  if (route === 'model/list') return api.handleModelList();
  if (route === 'model/add') return api.handleModelAdd(payload as Parameters<typeof api.handleModelAdd>[0]);
  if (route === 'model/remove') return api.handleModelRemove(payload as Parameters<typeof api.handleModelRemove>[0]);
  if (route === 'model/set-key') return api.handleModelSetKey(payload as Parameters<typeof api.handleModelSetKey>[0]);
  if (route === 'model/set-default') return api.handleModelSetDefault(payload as Parameters<typeof api.handleModelSetDefault>[0]);
  if (route === 'model/verify') return await api.handleModelVerify(payload as Parameters<typeof api.handleModelVerify>[0]);
// Agent commands
  if (route === 'agent/list') return api.handleAgentList();
  if (route === 'agent/show') return api.handleAgentShow(payload as Parameters<typeof api.handleAgentShow>[0]);
  if (route === 'agent/enable') return api.handleAgentEnable(payload as Parameters<typeof api.handleAgentEnable>[0]);
  if (route === 'agent/disable') return api.handleAgentDisable(payload as Parameters<typeof api.handleAgentDisable>[0]);
  if (route === 'agent/set') return api.handleAgentSet(payload as Parameters<typeof api.handleAgentSet>[0]);
  // Environment engine probe (安全研究员版 P1 E1)
  if (route === 'environment/engines') return await api.handleEnvironmentEngines(payload as Parameters<typeof api.handleEnvironmentEngines>[0]);
// Named environments (安全研究员版 P1 E3)
  if (route === 'environment/list') return api.handleEnvironmentList();
  if (route === 'environment/add') return await api.handleEnvironmentAdd(payload as Record<string, unknown>);
  if (route === 'environment/open') return await api.handleEnvironmentOpen(payload as Parameters<typeof api.handleEnvironmentOpen>[0]);
// Environment recipes + docker lifecycle (安全研究员版 P1 E4)
  if (route === 'environment/recipes') return api.handleEnvironmentRecipes();
  if (route === 'environment/up') return await api.handleEnvironmentUp(payload as Parameters<typeof api.handleEnvironmentUp>[0]);
  if (route === 'environment/down') return await api.handleEnvironmentDown(payload as Parameters<typeof api.handleEnvironmentDown>[0]);
  if (route === 'environment/ps') return await api.handleEnvironmentPs();
  if (route === 'environment/discover') return await api.handleEnvironmentDiscover();
  // 1.3.7 场景 3：能力集合重推 + 回写（GUI 手动刷新入口）
  if (route === 'environment/capability-refresh') return await api.handleEnvironmentCapabilityRefresh(payload as Parameters<typeof api.handleEnvironmentCapabilityRefresh>[0]);
  // 1.3.8 多配方：绑定集合整体替换（含主配方，不进域裁决）
  if (route === 'environment/bind-recipes') return await api.handleEnvironmentBindRecipes(payload as Parameters<typeof api.handleEnvironmentBindRecipes>[0]);
  // 域包清单层(P2 多域抽象层)
  if (route === 'domain/list') return api.handleDomainList();
  if (route === 'domain/check') return await api.handleDomainCheck(payload as Parameters<typeof api.handleDomainCheck>[0]);
  // 1.4.4 研究档案（GUI 研究面板：查询/人纠正）
  if (route === 'archive/list') return api.handleArchiveList(payload as Parameters<typeof api.handleArchiveList>[0]);
  if (route === 'archive/correct') return await api.handleArchiveCorrect(payload as Parameters<typeof api.handleArchiveCorrect>[0]);
  if (route === 'archive/resolve') return await api.handleArchiveResolve(payload as Parameters<typeof api.handleArchiveResolve>[0]);
  if (route === 'archive/abandon') return await api.handleArchiveAbandon(payload as Parameters<typeof api.handleArchiveAbandon>[0]);
  if (route === 'environment/adopt') return await api.handleEnvironmentAdopt(payload as Parameters<typeof api.handleEnvironmentAdopt>[0]);
  if (route === 'environment/install') return await api.handleEnvironmentInstall(payload as Parameters<typeof api.handleEnvironmentInstall>[0]);
  if (route === 'environment/build') return await api.handleEnvironmentBuild(payload as Parameters<typeof api.handleEnvironmentBuild>[0]);
  if (route === 'environment/rm') return await api.handleEnvironmentRm(payload as Parameters<typeof api.handleEnvironmentRm>[0]);
  if (route === 'environment/exec') return await api.handleEnvironmentExec(payload as Parameters<typeof api.handleEnvironmentExec>[0]);
  // W1(design-spec §6.1/§6.4)— 环境快照/回滚(vmware vmrun;docker 暂未支持)
  if (route === 'environment/snapshot') return await api.handleEnvironmentSnapshot(payload as Parameters<typeof api.handleEnvironmentSnapshot>[0]);
  if (route === 'environment/rollback') return await api.handleEnvironmentRollback(payload as Parameters<typeof api.handleEnvironmentRollback>[0]);
  if (route === 'environment/extract') return await api.handleEnvironmentExtract(payload as Parameters<typeof api.handleEnvironmentExtract>[0]);
  // 1.2.0 研究交付——一键出报告（组装 → 敏感扫描 → 一次批准 → 回收 → 填肉 → 落盘）
  if (route === 'report/export') return await api.handleReportExport(payload as Parameters<typeof api.handleReportExport>[0]);
  // 1.4.1 auto loop agent（design auto-loop-design.md；runner 在 loop/auto-run.ts）
  if (route === 'auto-run/start') return await api.handleAutoRunStart(payload as Record<string, unknown>);
  if (route === 'auto-run/stop') return api.handleAutoRunStop(payload as Parameters<typeof api.handleAutoRunStop>[0]);
  if (route === 'auto-run/budget') return api.handleAutoRunBudget(payload as Parameters<typeof api.handleAutoRunBudget>[0]);
  if (route === 'auto-run/verdict') return api.handleAutoRunVerdict(payload as Parameters<typeof api.handleAutoRunVerdict>[0]);
  if (route === 'auto-run/list') return await api.handleAutoRunList(payload as Parameters<typeof api.handleAutoRunList>[0]);
// Environment selection（安全研究员版 P1 T4，D17 首屏选定的持久化）
  if (route === 'environment/select') return await api.handleEnvironmentSelect(payload as Parameters<typeof api.handleEnvironmentSelect>[0]);
  if (route === 'environment/current') return api.handleEnvironmentCurrent(payload as Parameters<typeof api.handleEnvironmentCurrent>[0]);
// Tool readme — progressive-disclosure helpers (zhishi CLI on-demand docs)
  if (route === 'readme/widget') {
    const topic = route.split('/')[1];
    return api.handleReadme({
      topic,
      modules: Array.isArray(payload.modules) ? (payload.modules as string[]) : undefined,
    });
  }
// Skill commands
  if (route === 'skill/list') return await api.handleSkillList();
  if (route === 'skill/info') return await api.handleSkillInfo(payload as Parameters<typeof api.handleSkillInfo>[0]);
  if (route === 'skill/remove') return await api.handleSkillRemove(payload as Parameters<typeof api.handleSkillRemove>[0]);
  if (route === 'skill/enable') return await api.handleSkillToggle({ name: String(payload.name ?? ''), enabled: true });
  if (route === 'skill/disable') return await api.handleSkillToggle({ name: String(payload.name ?? ''), enabled: false });
// AppCraft 已随 1.2.3 退役移除（桌面自动化整体切除）——老客户端打到这些
  // 路由时给明确错误，而不是 unknown route。
  if (route.startsWith('appcraft/')) {
    return { success: false, error: 'appcraft 已随 1.2.3 移除（AppCraft 桌面自动化整体退役）' };
  }
  // 想法流（COWORK 任务7/8）：搭子的主动提醒（附来源），经蒸馏层过滤后给 Launcher 流。
  if (route === 'memory/active-reminders') return api.handleMemoryActiveReminders();
  // 想法流反馈（阶段3）：捡起=存款 / 划走=取款（分寸）。
  if (route === 'memory/reminder-feedback') return await api.handleMemoryReminderFeedback(payload as Parameters<typeof api.handleMemoryReminderFeedback>[0]);
  // 记忆检索（阶段4）。
  if (route === 'memory/search') return await api.handleMemorySearch(payload as Parameters<typeof api.handleMemorySearch>[0]);
  if (route === 'memory/overview') return await api.handleMemoryOverview();
  // 研究成败信号（安全研究员版 P1 D1，memory.db research_events 表）。
  if (route === 'research/log') return await api.handleResearchLog(payload as Parameters<typeof api.handleResearchLog>[0]);
  if (route === 'research/list') return await api.handleResearchList(payload as Parameters<typeof api.handleResearchList>[0]);
  // 情报横切（1.1.2）：intel.db 由 sidecar 持有，更新/状态经 admin API。
  if (route === 'intel/update') return await api.handleIntelUpdate(payload as Parameters<typeof api.handleIntelUpdate>[0]);
  if (route === 'intel/status') return api.handleIntelStatus();
  // 1.3.2 任务二 #3：情报配置部分更新（PATCH 语义，回写 config.json::intel）。
  if (route === 'intel/config-update') return await api.handleIntelConfigUpdate(payload as Parameters<typeof api.handleIntelConfigUpdate>[0]);
  // 专家知识层（1.2.1 骨架期）：expert.db 管理面。
  if (route === 'expert/search') return await api.handleExpertSearch(payload as Parameters<typeof api.handleExpertSearch>[0]);
  if (route === 'expert/list') return await api.handleExpertList(payload as Parameters<typeof api.handleExpertList>[0]);
  if (route === 'expert/show') return await api.handleExpertShow(payload as Parameters<typeof api.handleExpertShow>[0]);
  if (route === 'expert/add') return await api.handleExpertAdd(payload as Record<string, unknown>);
  if (route === 'expert/update') return await api.handleExpertUpdate(payload as Record<string, unknown>);
  if (route === 'expert/rm') return await api.handleExpertRm(payload as Parameters<typeof api.handleExpertRm>[0]);
  if (route === 'expert/drafts') return await api.handleExpertDrafts(payload);
  if (route === 'expert/review') return await api.handleExpertReview(payload as Parameters<typeof api.handleExpertReview>[0]);
  if (route === 'expert/promote-prefill') return await api.handleExpertPromotePrefill(payload as Parameters<typeof api.handleExpertPromotePrefill>[0]);
  if (route.startsWith('term/')) return await api.handlePanelProxy(route, payload);
  // 全局人格层（设置页「搭子」）。
  if (route === 'persona/read' || route === 'persona/write') {
    return { success: false, error: 'persona 已随安全研究员版移除(人格层整拆)' };
  }
  // 信任账本（宪章 §5.1，memory.db）。
  if (route === 'trust/event') return await api.handleTrustEvent(payload as unknown as Parameters<typeof api.handleTrustEvent>[0]);
  if (route === 'trust/ledger') return await api.handleTrustLedger(payload as Parameters<typeof api.handleTrustLedger>[0]);
  if (route === 'trust/resolve') return await api.handleTrustResolve(payload as Parameters<typeof api.handleTrustResolve>[0]);
  if (route === 'trust/reset') return api.handleTrustReset();
  if (route === 'trust/import') return await api.handleTrustImport(payload as Parameters<typeof api.handleTrustImport>[0]);
// Config commands
  if (route === 'config/get') return api.handleConfigGet(payload as Parameters<typeof api.handleConfigGet>[0]);
  if (route === 'config/set') return api.handleConfigSet(payload as Parameters<typeof api.handleConfigSet>[0]);
// Task Center — tasks (v0.1.69)
  if (route === 'task/list') return await api.handleTaskList(payload as Parameters<typeof api.handleTaskList>[0]);
  if (route === 'task/get') return await api.handleTaskGet(payload as Parameters<typeof api.handleTaskGet>[0]);
  if (route === 'task/create-direct') return await api.handleTaskCreateDirect(payload);
  if (route === 'task/create-from-alignment') return await api.handleTaskCreateFromAlignment(payload);
  if (route === 'task/run') return await api.handleTaskRun(payload as Parameters<typeof api.handleTaskRun>[0]);
  if (route === 'task/rerun') return await api.handleTaskRerun(payload as Parameters<typeof api.handleTaskRerun>[0]);
  if (route === 'task/update') return await api.handleTaskUpdate(payload);
  if (route === 'task/update-status') return await api.handleTaskUpdateStatus(payload);
  if (route === 'task/append-session') return await api.handleTaskAppendSession(payload as Parameters<typeof api.handleTaskAppendSession>[0]);
  if (route === 'task/archive') return await api.handleTaskArchive(payload as Parameters<typeof api.handleTaskArchive>[0]);
  if (route === 'task/delete') return await api.handleTaskDelete(payload as Parameters<typeof api.handleTaskDelete>[0]);
  if (route === 'task/read-doc') return await api.handleTaskReadDoc(payload as Parameters<typeof api.handleTaskReadDoc>[0]);
  if (route === 'task/write-doc') return await api.handleTaskWriteDoc(payload as Parameters<typeof api.handleTaskWriteDoc>[0]);
// System commands
  if (route === 'status') return api.handleStatus();
  if (route === 'reload') return api.handleReload(payload.workspacePath as string | undefined);
  if (route === 'version') return api.handleVersion();
  if (route === 'help') return api.handleHelp(payload as Parameters<typeof api.handleHelp>[0]);
return { success: false, error: `Unknown admin route: ${pathname}` };
}
/**
 * Recursively copy a directory using fs/promises.
 * Every filesystem call yields to the event loop — important for HTTP handlers
 * that bulk-copy multiple folders. A sync implementation would block Bun's
 * event loop long enough for the Rust health monitor (/health with 2 s timeout,
 * 15 s interval) to declare the sidecar unresponsive and respawn it on a fresh
 * port mid-copy — which was the root cause of the "sync-from-claude crashes
 * the sidecar" report in issue #96.
 *
 * Security: Skips symbolic links to prevent following links to sensitive locations.
 */
async function copyDirRecursive(src: string, dest: string, logPrefix = '[copyDir]'): Promise<void> {
  await ensureDir(dest);
  const entries = await readdirAsync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
if (entry.isSymbolicLink()) {
      console.warn(`${logPrefix} Skipping symlink: ${srcPath}`);
      continue;
    }
if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath, logPrefix);
    } else {
      await copyFileAsync(srcPath, destPath);
    }
  }
}
async function serveStatic(pathname: string): Promise<Response | null> {
  // P4 减法（W1b）后 renderer 已删，dist/ 不再有构建源。本函数只剩一个
  // 合法服务对象：placeholder 占位页（告诉误开浏览器的人 GUI 已删）。
  // cwd/dist 若存在（旧构建残留）不再服务——它就是「已删的界面又出现」
  // 的来源。
  const distRoot = resolve(process.cwd(), 'src-tauri', 'placeholder');
  const resolvedPath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = resolve(distRoot, resolvedPath);
  // Prevent path traversal: resolved path must stay within distRoot
  if (!filePath.startsWith(distRoot + sep)) {
    return null;
  }
  const fileResp = await fileResponse(filePath, { contentType: sniffMime(filePath) });
  if (fileResp) return fileResp;
const indexPath = join(distRoot, 'index.html');
  const indexResp = await fileResponse(indexPath, { contentType: sniffMime(indexPath) });
  if (indexResp) return indexResp;
return null;
}
interface SwitchPayload {
  agentDir: string;
  initialPrompt?: string;
}
/**
 * Write a startup beacon directly to unified log file (bypasses initLogger).
 * This is critical for diagnosing Windows startup hangs where initLogger
 * may not be reached yet and zero NODE logs appear.
 */
function startupBeacon(step: string): void {
  // Write to stderr — captured by Rust drain thread → unified log
  try { process.stderr.write(`[startup] ${step}\n`); } catch { /* ignore */ }
  // Also write directly to unified log file.
  // NOTE: 内联时间戳格式而非 import localTimestamp()，因为此函数在 initLogger() 之前运行，
  // 需保持零依赖以诊断 Windows 上 initLogger 未到达的 hang 问题。
  try {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const logsDir = join(getZhiShiDataDir(), 'logs');
    ensureDirSync(logsDir);
    const filePath = join(logsDir, `unified-${y}-${m}-${d}.log`);
    const h = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    const ts = `${y}-${m}-${d} ${h}:${mi}:${s}.${ms}`;
    appendFileSync(filePath, `${ts} [NODE ] [INFO ] [startup] ${step}\n`);
  } catch { /* ignore */ }
}
async function main() {
  startupBeacon(`main() entered, pid=${process.pid}, platform=${process.platform}, argv=${process.argv.length} args`);
const { agentDir, initialPrompt, port, sessionId: initialSessionId } = parseArgs(process.argv);
  const dirDisplay = agentDir.length > 50 ? agentDir.slice(0, 3) + '...' + agentDir.slice(-44) : agentDir;
  startupBeacon(`args parsed, port=${port}, agentDir=${dirDisplay}`);
let currentAgentDir = await ensureAgentDir(agentDir);
  startupBeacon('ensureAgentDir done');
// Initialize unified logging system (intercepts console.log and sends to SSE)
  // PRD #132 — wire the stdio-broken probe + marker so the logger wrapper
  // stops calling originalConsole.* once a stdio EPIPE has marked the sink
  // dead, and so a sync write-throw can flip the bit immediately.
  setStdioBrokenProbe(isStdioBroken, markStdioBroken);
  initLogger(getClients);
  startupBeacon('initLogger done — switching to console.log');
// 1.3.7 场景 1：存量 vm 环境条目「实例即环境」一次性迁移（config.json
  // + env-sessions/env-selection 引用同步）。幂等（无旧条目零写盘）、
  // 快速（三个小 JSON）、失败不炸启动——在绑端口前跑完，保证任何
  // environment/* 处理器读到的已是新 id 口径。
  try {
    await runLegacyVmEntryMigration();
    startupBeacon('vm-entry migration done');
  } catch (err) {
    console.warn('[env-migration] 迁移异常（不影响启动）:', err instanceof Error ? err.message : String(err));
  }
// Store sidecar port BEFORE initializeAgent() so that:
  //   1. pre-warm's buildClaudeSessionEnv() reads the correct sidecarPort
  //      (OpenAI bridge loopback URL + ZHISHI_PORT injection both need it).
  //   2. setSidecarPort's process.env.ZHISHI_PORT side effect is in place
  //      before any `zhishi` CLI invocation (from pre-warm bash tools) can
  //      spawn. This eliminates a subtle timing
  //      coincidence where the old ordering depended on pre-warm's 500ms
  //      debounce outlasting the few µs between these two calls.
  setSidecarPort(port);
// ── Deferred init gate ──────────────────────────────────────────────────
  // Everything heavy (skill seed, socks bridge, initializeAgent) moves to
  // AFTER
  // honoServe() binds, so Rust's TCP health check unblocks in < 100ms
  // instead of waiting ~2s for this work to complete. Routes that need
  // agent state `await deferredInit` at the top of the fetch handler.
  //
  // /health is exempt so the sidecar becomes "healthy" from Rust's
  // perspective the moment the HTTP server accepts TCP connections —
  // letting the frontend render the Tab UI while deferred init still runs.
  let resolveDeferredInit!: () => void;
  let rejectDeferredInit!: (e: unknown) => void;
  const deferredInitPromise: Promise<void> = new Promise((res, rej) => {
    resolveDeferredInit = res;
    rejectDeferredInit = rej;
  });
  // Route handlers that need agent state call `await awaitDeferredInit()`.
  // Exposed on globalThis so the hono fetch handler (below) can reach it
  // without changing signatures.
  (globalThis as { __zhishiDeferredInit?: Promise<void> }).__zhishiDeferredInit =
    deferredInitPromise;
// M4c: openai-bridge 已删除——bridge 处理器不复存在。
console.log(`[startup] HTTP server binding to 127.0.0.1:${port}...`);
const httpServer = honoServe({
    // Explicit 127.0.0.1 for Rust proxy compatibility (IPv4).
    port,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      // Pattern 6 (HTTP request boundary): each request runs inside an ALS
      // frame so any nested console.* call automatically gets correlation
      // fields injected. Renderer-side code (`tauriClient.ts`) attaches
      // X-ZhiShi-Session-Id / X-ZhiShi-Tab-Id; the server generates a
      // fresh requestId (or honours an inbound `X-ZhiShi-Request-Id` from
      // the Rust proxy if it pre-populated one).
      const incomingRequestId = request.headers.get('x-zhishi-request-id') ?? undefined;
      const requestId = incomingRequestId ?? randomUUIDv4Short();
      const sessionId = request.headers.get('x-zhishi-session-id') ?? undefined;
      const tabId = request.headers.get('x-zhishi-tab-id') ?? undefined;
      return withLogContext({ requestId, sessionId, tabId }, () => handleRequest(request));
    },
  } as Parameters<typeof honoServe>[0]);
  // 1.3.3:attach 交互式 pty——在 node http.Server 上挂 WS upgrade
  // (HTTP fetch handler 管不到 upgrade 请求,honoServe 返回的 server 是
  // 同一实例)。
  installTermUpgradeHandler(httpServer as unknown as import('node:http').Server);
/**
   * Pattern 6 helper: short stable id for HTTP request correlation.
   * crypto.randomUUID is ~36 chars; we collapse to 8 hex for grep-ability.
   */
  function randomUUIDv4Short(): string {
    // randomUUID is imported above; we re-derive from the same 16-byte source.
    return randomUUID().replace(/-/g, '').slice(0, 8);
  }
/**
   * `/chat/stream` SSE disconnect is intentionally NOT a turn-cancellation
   * authority. When the last SSE client closes, we do NOT interrupt the
   * in-flight SDK turn. This is load-bearing — do not "optimize" it back.
   *
   * WHY (architecture: "后端优先，前端辅助" — ARCHITECTURE.md): a turn's lifecycle
   * belongs to the Rust sidecar Owner model (Tab / CronTask / BackgroundCompletion
   * / Agent), not to whether a frontend tab is currently watching. The product
   * contract is explicit: closing / navigating away from a tab while the AI is
   * running starts BackgroundCompletion and lets the turn FINISH ("AI 继续在后台
   * 完成任务"); abandoning a turn is done via the Stop button (→ 'user' interrupt),
   * not by closing the tab. So "no SSE consumer" must never mean "cancel".
   *
   * HISTORY: PRD 0.2.0 (structural refactors) specced an *owner-aware* check
   * here ("interrupt only if the owner set no longer has a Tab/Frontend owner,
   * but IM/Cron/BackgroundCompletion may still keep it alive"). The shipped impl
   * (390d38ee) instead used a raw `getClients().length === 0` grace and assumed
   * "headless turns never have an SSE client" — false the moment a user opens a
   * tab to observe a cron / session-send turn then closes it mid-turn. That
   * regressed BackgroundCompletion and delivered spurious `[ERROR turn_failed]
   * [ede_diagnostic]` back to Feishu/IM. Removing the interrupt restores the
   * owner-model boundary.
   *
   * What still governs turn lifecycle WITHOUT this interrupt:
   *   - Stop button → interruptCurrentResponse('user').
   *   - All owners released → Rust stops the sidecar → process exit ends the turn.
   *   - Hung / silent turn → the 10-min inactivity watchdog (agent-session.ts),
   *     which is SSE-independent.
   *   - Zero SSE clients is a normal, handled state: broadcast() to an empty
   *     client set is a no-op (cron/IM turns run headless this way constantly),
   *     so there is no "chunks nobody reads" leak.
   *
   * The one residual gap — a leaked `Tab` owner after an abnormal renderer/SSE
   * death keeping an event-emitting turn alive (watchdog won't fire) — is a
   * stale-owner / renderer-health problem to solve with owner leases or tab
   * cleanup, NOT by making SSE disconnect a cancellation signal.
   */
/**
   * Original Hono fetch body, unchanged except for being moved into a named
   * function so the outer wrapper can run inside `withLogContext`.
   */
  async function handleRequest(request: Request): Promise<Response> {
    {
      const url = new URL(request.url);
      const pathname = url.pathname;
// Skip logging high-frequency polling/config-sync paths to reduce unified log noise.
      // These fire every 15s (health) or on every Tab focus (commands/agents/mcp) with zero diagnostic value.
      const SILENT_PATHS = new Set([
        '/health', '/api/unified-log', '/sessions', '/api/agents/enabled',
      ]);
      if (!SILENT_PATHS.has(pathname)) {
        console.debug(`[http] ${request.method} ${pathname}`);
      }
// Handle CORS preflight requests (for browser dev mode via Vite proxy)
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          }
        });
      }
// 🩺 Health check endpoints - used by Rust sidecar manager and renderer.
      //
      // Pattern 4 splits the historical "/health = healthy" signal into three:
      //   - /health         → liveness (TCP bind succeeded; legacy alias kept
      //                       so existing Rust watchdogs keep working)
      //   - /health/live    → same as /health, explicit name
      //   - /health/ready   → deferred init complete; structured 503 + phase
      //                       while pending or failed
      //   - /health/functional → core feature can serve (sidecar mirrors live;
      //                       Plugin Bridge implements the real check)
      //
      // All four bypass the deferred-init gate below — they MUST respond
      // immediately, otherwise probes can't distinguish "still warming up"
      // from "wedged".
      if ((pathname === '/health' || pathname === '/health/live') && request.method === 'GET') {
        return jsonResponse({ status: 'ok', timestamp: Date.now() });
      }
      if (pathname === '/health/ready' && request.method === 'GET') {
        const { status, body } = buildReadyResponseBody();
        return jsonResponse(body, status);
      }
      if (pathname === '/health/functional' && request.method === 'GET') {
        // Sidecar's "functional" mirrors readiness for now — once ready, the
        // Hono handler is serving requests. Plugin Bridge has a more
        // meaningful gateway-forwarding check.
        const { status, body } = buildReadyResponseBody();
        return jsonResponse(body, status);
      }
      // (removed) `POST /health/ready/retry` — pre-0.2.0 endpoint that reset
      // DeferredInitState to `pending` and returned 202 promising a re-run,
      // but no in-process re-runner exists (the deferred init block is a
      // single IIFE). The renderer never observed progress and was misled.
      // Retry today is a process restart; if/when an extracted re-callable
      // init lands we can reintroduce a real retry endpoint.
// 📦 Pattern 2 §2.3.1 — Large-value ref retrieval. SSE / IPC payloads
      // over the spill threshold leave a `{kind:'ref', id, ...}` placeholder
      // here; consumers fetch the full body via this endpoint. Streamed via
      // createReadStream so multi-MB bodies don't get loaded into memory.
      // Bypasses the deferred-init gate — refs are independent of agent
      // state, and the /chat/* SSE consumer may be mid-replay during init.
      if (pathname.startsWith('/refs/') && request.method === 'GET') {
        const id = decodeURIComponent(pathname.slice('/refs/'.length));
        // Mirror the strict regex inside large-value-store.getRefStreamPath:
        // 8–32 lowercase hex (uuid-prefix shape). The route check used to be
        // looser (`/^[a-f0-9]+$/i`, no length cap, case-insensitive), which
        // meant attacker-style upper-case probes returned 404 from the inner
        // store after also satisfying the route — defense-in-depth without
        // observable behavior change for legitimate refs.
        if (!id || !/^[a-f0-9]{8,32}$/.test(id)) {
          return jsonResponse({ error: 'invalid ref id' }, 400);
        }
        const { getRefStreamPath } = await import('./utils/large-value-store');
        const refInfo = await getRefStreamPath(id);
        if (!refInfo) {
          return jsonResponse({ error: 'ref not found or expired' }, 404);
        }
        // Stream from disk so multi-MB bodies don't buffer into memory.
        //
        // `Access-Control-Allow-Origin: *` is the load-bearing header here
        // (issue #109 root cause). The renderer's proxyFetch pulls this URL
        // via WebKit's native `fetch()` (the spill path bypasses Tauri IPC
        // because the body is too large to ship through the invoke channel).
        // Without an explicit ACAO header, WebKit/WKWebView silently rejects
        // the response as opaque cross-origin and surfaces it to JS as the
        // notoriously diagnostic-free `TypeError: Load failed`. Other
        // sidecar paths skip CORS because they go through Tauri IPC, which
        // bypasses the browser's same-origin machinery entirely; this one
        // doesn't, so it must opt in. Use `*` (not the renderer's origin)
        // because the sidecar is bound to 127.0.0.1 and trusts everything
        // on loopback already.
        const fr = await fileResponse(refInfo.path, {
          contentType: refInfo.mimetype,
          headers: {
            'Access-Control-Allow-Origin': '*',
          },
        });
        if (!fr) {
          return jsonResponse({ error: 'ref body missing' }, 404);
        }
        return fr;
      }
// ── Deferred init gate ────────────────────────────────────────────────
      // All other routes depend on agent state (currentAgentDir, MCP servers,
      // session metadata, bridge handler). Pattern 4: instead of awaiting
      // the bare promise (which either blocks indefinitely or rethrows as a
      // 500 on failure), consult the state machine and return a structured
      // 503 if init is pending/phase/failed. Once `kind === 'ready'`, the
      // gate is a no-op (sub-µs) for steady-state requests.
      const gate = buildGateResponseBody();
      if (gate) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (gate.body.state === 'pending' || gate.body.state === 'phase') {
          headers['Retry-After'] = '1';
        }
        return new Response(JSON.stringify(gate.body), { status: gate.status, headers });
      }
// Tool attachment endpoint (PRD 0.2.15) — rich-media tool outputs (image/audio/pdf/file).
      // URL shape: GET /api/attachment/tool/<sessionId>/<turnId>/<filename>
      //
      // Resolution: trusted attachment root <home>/.zhishi/generated/
      // tool-attachments/<s>/<t>/<f> (where saved attachments land).
      //
      // Security: the resolved path is re-validated via
      // validateExternalReadPathNode (system/credential blacklist) and is by
      // construction inside the ZhiShi-owned tree.
      if (pathname.startsWith('/api/attachment/tool/') && request.method === 'GET') {
        // Codex review EP1: decodeURIComponent throws URIError on malformed
        // %xx escapes — wrap explicitly so we return 400 (with CORS) instead
        // of crashing the request and leaving the renderer with an opaque error.
        let rest: string;
        try {
          rest = decodeURIComponent(pathname.slice('/api/attachment/tool/'.length));
        } catch {
          return new Response('Bad Request', {
            status: 400,
            headers: { 'Access-Control-Allow-Origin': '*' },
          });
        }
        const segs = rest.split('/').filter(Boolean);
        if (segs.length !== 3) {
          return new Response('Bad Request', {
            status: 400,
            headers: { 'Access-Control-Allow-Origin': '*' },
          });
        }
        const [sid, tid, fname] = segs;
        // Guard against `..` / `/` / `\` / control chars in any segment.
        const hasUnsafeChar = (s: string): boolean => {
          if (s.includes('..')) return true;
          for (let i = 0; i < s.length; i++) {
            const code = s.charCodeAt(i);
            if (code < 0x20) return true;
            if (s[i] === '/' || s[i] === '\\') return true;
          }
          return false;
        };
        if (segs.some(hasUnsafeChar)) {
          return new Response('Forbidden', {
            status: 403,
            headers: { 'Access-Control-Allow-Origin': '*' },
          });
        }
        // Trusted root for saved attachments (builtin session store).
        const realPath = join(getToolAttachmentRoot(), sid, tid, fname);
        // Defense-in-depth: blacklist check (paths in registry have already passed,
        // but if a session-resume rebuild ever fed in a bad path we'd refuse here).
        const check = validateExternalReadPathNode(realPath);
        if (!check.ok) {
          return new Response('Forbidden', {
            status: 403,
            headers: { 'Access-Control-Allow-Origin': '*' },
          });
        }
        const fileResp = await fileResponse(check.canonical, {
          contentType: sniffMime(check.canonical),
          headers: {
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
          },
        });
        return fileResp ?? new Response('Not Found', {
          status: 404,
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      }
// Browser dev-mode fallback for attachment files.
      // Production uses the Tauri `zhishi://attachment/<path>` custom protocol
      // (`src-tauri/src/attachment_protocol.rs`) which serves bytes directly
      // through WebKit without round-tripping JSON. In dev (vite + browser) the
      // custom scheme isn't registered, so this route serves the same bytes
      // via a plain HTTP GET. fileResponse() streams via createReadStream to
      // avoid buffering large attachments.
      if (pathname.startsWith('/api/attachment/') && request.method === 'GET') {
        const rel = decodeURIComponent(pathname.replace('/api/attachment/', ''));
        // Reject path traversal: no `..` segments and no absolute paths.
        if (rel.includes('..') || rel.startsWith('/')) {
          return new Response('Forbidden', { status: 403 });
        }
        const absolute = getAttachmentPath(rel);
        const fileResp = await fileResponse(absolute, {
          contentType: sniffMime(absolute),
          headers: {
            'Cache-Control': 'public, max-age=31536000, immutable',
            'Access-Control-Allow-Origin': '*',
          },
        });
        return fileResp ?? new Response('Not Found', { status: 404 });
      }
// Session state endpoint - used by Rust background completion polling
      if (pathname === '/api/session-state' && request.method === 'GET') {
        const sessionState = getPiAgentState().sessionState;
        return jsonResponse({ sessionState });
      }
// Read historical session messages from SDK's persisted session files (v0.2.59+)
      // Works without an active Sidecar — reads directly from .claude/ session data
      if (pathname === '/api/session/messages' && request.method === 'GET') {
        const sdkSessionId = url.searchParams.get('sdkSessionId');
        if (!sdkSessionId) {
          return jsonResponse({ success: false, error: 'sdkSessionId is required' }, 400);
        }
        const dir = url.searchParams.get('dir') || undefined;
        const rawLimit = url.searchParams.get('limit');
        const rawOffset = url.searchParams.get('offset');
        const limit = rawLimit ? (Number.isFinite(+rawLimit) && +rawLimit >= 0 ? Math.floor(+rawLimit) : undefined) : undefined;
        const offset = rawOffset ? (Number.isFinite(+rawOffset) && +rawOffset >= 0 ? Math.floor(+rawOffset) : undefined) : undefined;
        try {
          const messages = await getHistoricalSessionMessages(sdkSessionId, dir, limit, offset);
          return jsonResponse({ success: true, messages });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to read session messages' },
            500
          );
        }
      }
      // 1.1.10(A′)— 子代理 transcript 只读查看:按 loopSessionId 返回
      // loop-sessions 的结构化消息序列(纯读;大小护栏见 loop/transcript.ts)。
      // 1.3.3:`?format=wire` 返回**完整 wire 消息**(含 1.3.2 决策块
      // kind:'decision')——GUI 历史面板只读回看用(transcript 形状会丢决策
      // 结构,wire 形状与 /chat/stream 重放逐字段对齐)。
      if (pathname === '/api/loop-session/messages' && request.method === 'GET') {
        const loopSessionId = url.searchParams.get('loopSessionId');
        if (!loopSessionId) {
          return jsonResponse({ success: false, error: 'loopSessionId is required' }, 400);
        }
        const format = url.searchParams.get('format') ?? 'transcript';
        if (format !== 'wire') {
          try {
            const transcript = buildLoopTranscript(loopSessionId);
            if (!transcript) {
              return jsonResponse({ success: false, error: `loop session '${loopSessionId}' not found` }, 404);
            }
            return jsonResponse({ success: true, transcript });
          } catch (error) {
            return jsonResponse(
              { success: false, error: error instanceof Error ? error.message : 'Failed to read loop session messages' },
              500
            );
          }
        }
        try {
          // 与 transcript 路径同源读盘(会话文件不存在 → 404)。
          if (!existsSync(loopSessionFile(loopSessionId, defaultLoopSessionDir()))) {
            return jsonResponse({ success: false, error: `loop session '${loopSessionId}' not found` }, 404);
          }
          const stored = loadLoopSession(loopSessionId);
          const all = buildLoopWireMessages(stored.messages);
          // 护栏:wire 消息可大可小,超出上限从头截断(时间序保留)并标记。
          const MAX_WIRE_MESSAGES = 2000;
          const truncated = all.length > MAX_WIRE_MESSAGES;
          return jsonResponse({
            success: true,
            messages: truncated ? all.slice(0, MAX_WIRE_MESSAGES) : all,
            totalMessages: all.length,
            truncated,
          });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to read loop session wire messages' },
            500
          );
        }
      }
// 🔍 Debug endpoint: Expose logger diagnostics via HTTP
      if (pathname === '/debug/logger' && request.method === 'GET') {
        const diagnostics = getLoggerDiagnostics();
        const clientsCount = getClients().length;
        return jsonResponse({
          ...diagnostics,
          currentClientsCount: clientsCount,
          timestamp: new Date().toISOString(),
        }, 200);
      }
if (pathname === '/chat/stream' && request.method === 'GET') {
        // No onClose turn-interrupt: SSE disconnect is not a cancellation
        // authority (see the note above — turn lifecycle = Rust Owner model).
        const { client, response } = createSseClient(() => {});
        // M4a — pi 引擎:会话状态由 loop/chat-engine 服务(SDK 的
        // getAgentState/getMessages 在这条路径下为空)。事件名/形状与
        // SDK 路径逐字段对齐,客户端零改动。
        if (isPiEngine()) {
          client.send('chat:init', getPiAgentState());
          const piStreamingId = getPiStreamingAssistantId();
          getPiMessages().forEach((message) => {
            if (piStreamingId && message.id === piStreamingId) return;
            client.send('chat:message-replay', { message, replayKind: 'cold-history' });
          });
          client.send('chat:logs', { lines: getPiLogLines() });
          // 越界 ask(design §6.6):重连重放全部待答 ask——客户端重连不丢模态。
          for (const ask of pendingBoundaryAsks()) {
            client.send('chat:boundary-ask', ask);
          }
          // 1.3.2 决策面板:重连重放全部待答决策——GUI 重连不丢待答面板。
          for (const d of pendingDecisions()) {
            client.send('chat:decision-request', {
              decisionId: d.decisionId,
              question: d.question,
              options: d.options,
              expertHits: d.expertHits,
            });
          }
          const piInitInfo = getPiSystemInitInfo();
          if (piInitInfo) {
            client.send('chat:system-init', { info: piInitInfo });
          }
          // 1.2.8(M4)重连对账:队列状态快照——重连的客户端错过了排队时刻的
          // queue:added 广播,这里逐条补发 isInFlight:false 的排队项(FIFO +
          // steering,kind 带上,与 chat-engine 广播形态一致),让重连后的
          // 客户端队列与服务端一致。
          for (const snap of getPiQueueSnapshotEvents()) {
            client.send(snap.event, snap.data);
          }
          return response;
        }
}
if (pathname === '/chat/send' && request.method === 'POST') {
        let payload: SendMessagePayload;
        try {
          payload = (await request.json()) as SendMessagePayload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }
        const text = payload?.text?.trim() ?? '';
        const images = payload?.images ?? [];
        const permissionMode = payload?.permissionMode ?? 'auto';
        const model = payload?.model;
        const providerEnv = payload?.providerEnv;
        const refs = payload?.refs;
// Allow sending with just images or just text
        if (!text && images.length === 0) {
          return jsonResponse({ success: false, error: 'Message must have text or images.' }, 400);
        }
// M4c — 唯一引擎:pi(SDK 路径已删除)。
        try {
          console.log(`[chat][pi] send text="${text.slice(0, 200)}" images=${images.length} model=${model ?? 'default'}`);
          const piResult = await sendPiChatMessage({ text, images, model, providerEnv, permissionMode, refs });
          if (piResult.error) {
            return jsonResponse({ success: false, error: piResult.error }, chatSendErrorStatus(piResult.error));
          }
          return jsonResponse({
            success: true,
            queued: piResult.queued ?? false,
            queueId: piResult.queueId,
            isInFlight: piResult.isInFlight ?? false,
            // W1 — true = 进了 steering 队列(运行中注入),区别于 FIFO 排队。
            steering: piResult.steering ?? false,
          });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }
if (pathname === '/chat/model' && request.method === 'POST') {
        try {
          const payload = (await request.json()) as { model?: string; providerId?: string };
          const model = typeof payload?.model === 'string' ? payload.model.trim() : '';
          const providerIdArg = typeof payload?.providerId === 'string' ? payload.providerId.trim() : '';
          if (!model) {
            return jsonResponse({ success: false, error: '缺少 model 参数' }, 400);
          }
          const config = loadConfig();
          let providerId: string | null = null;
          if (providerIdArg) {
            // 客户端 /model use 的显式供应商语义:直接校验该供应商,不做全局反查
            // (聚合平台同名模型撞名时全局反查会错配供应商)。
            const provider = findEffectiveProvider(providerIdArg, config);
            if (!provider) {
              // kimi 内置无 preset 定义(pi 层 kimiCodingProvider 直连)——
              // resolveLoopModel 同样放行,这里保持一致的宽松语义。
              if (!isKimiCodingProvider(providerIdArg)) {
                return jsonResponse({ success: false, error: `未知供应商: ${providerIdArg}` }, 404);
              }
              providerId = providerIdArg;
            } else {
              if (isProviderDisabled(providerIdArg, config)) {
                return jsonResponse({ success: false, error: `供应商 ${providerIdArg} 已禁用` }, 400);
              }
              const rec = provider as unknown as Record<string, unknown>;
              const models = rec.models as Array<{ model: string }> | undefined;
              const aliases = (rec.modelAliases ?? {}) as Record<string, string>;
              const userPrimary = (config.providerPrimaryModels as Record<string, string> | undefined)?.[providerIdArg];
              const known =
                models?.some((m) => m.model === model) ||
                rec.primaryModel === model ||
                userPrimary === model ||
                Object.values(aliases).includes(model);
              if (!known) {
                return jsonResponse({ success: false, error: `供应商 ${providerIdArg} 无模型: ${model}` }, 404);
              }
              providerId = providerIdArg;
            }
          } else {
            // 反查 model → providerId：
            // 1) preset + custom provider 的 models/primaryModel（deepseek、anthropic…）
            // 2) 用户 providerPrimaryModels（覆盖 kimi k3 / deepseek flash 等非 preset provider）
            // 3) providerModelAliases 别名（sonnet/opus/haiku → 真实模型）
            for (const provider of getAllEffectiveProviders(config)) {
              const rec = provider as unknown as Record<string, unknown>;
              const models = rec.models as Array<{ model: string }> | undefined;
              if (models?.some((m) => m.model === model) || rec.primaryModel === model) {
                providerId = provider.id;
                break;
              }
            }
            if (!providerId) {
              for (const [pid, pm] of Object.entries((config.providerPrimaryModels as Record<string, string>) ?? {})) {
                if (pm === model) { providerId = pid; break; }
              }
            }
            if (!providerId) {
              for (const [pid, map] of Object.entries((config.providerModelAliases as Record<string, Record<string, string>>) ?? {})) {
                if (Object.values(map).some((v) => v === model)) { providerId = pid; break; }
              }
            }
          }
          if (!providerId) {
            return jsonResponse({ success: false, error: `未知模型: ${model}` }, 404);
          }
          // 无 key 的 provider 切过去会立刻让聊天不可用，先校验。
          // 1.3.0 修正：kimi 系走模糊解析（key 实际配在 moonshot-coding 等
          // id 下），并持久化真实的 key id——否则 defaultProviderId='kimi'
          // 会让 resolveLoopModel 下次解析不到 key。
          let apiKey = (config.providerApiKeys as Record<string, string>)[providerId];
          if ((!apiKey || !apiKey.trim()) && isKimiCodingProvider(providerId)) {
            const kimi = resolveKimiApiKey(config);
            if (kimi) {
              providerId = kimi.providerId;
              apiKey = kimi.apiKey;
            }
          }
          if (!apiKey || !apiKey.trim()) {
            return jsonResponse({ success: false, error: `provider ${providerId} 未配置 API key，无法切换到 ${model}` }, 400);
          }
          // 持久化默认 provider/model；resolveLoopModel 每次 turn 现读 config，下次即生效。
          const targetProviderId = providerId;
          await atomicModifyConfig((c) => {
            c.defaultProviderId = targetProviderId;
            c.defaultModelId = model;
            return c;
          });
          setSessionModel(model);
          return jsonResponse({ success: true, providerId: targetProviderId, model });
        } catch (error) {
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set model' }, 500);
        }
      }
      if (pathname === '/chat/stop' && request.method === 'POST') {
        try {
          console.log('[chat] stop');
          // M4a — pi 引擎:abort 当前 runLoop(pi signal 语义)。
          if (isPiEngine()) {
            const piStopped = stopPiChat();
            return jsonResponse(piStopped ? { success: true } : { success: true, alreadyStopped: true });
          }
          // M4c — pi 是唯一引擎,上面的分支恒命中。
          return jsonResponse({ success: true, alreadyStopped: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }
// Rewind session to a specific user message (time travel)
      if (pathname === '/chat/rewind' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const userMessageId = typeof body.userMessageId === 'string' ? body.userMessageId : '';
        if (!userMessageId) {
          return jsonResponse({ success: false, error: 'Missing userMessageId' }, 400);
        }
        // M4b — pi 引擎:loop-sessions 截断(追加日志,截断即时间回溯)。
        if (isPiEngine()) {
          return jsonResponse(await rewindPiChat(userMessageId));
        }
        // M4c — pi 是唯一引擎,上面的分支恒命中。
        return jsonResponse({ success: false, error: 'unreachable' }, 500);
      }
// Fork session at a specific assistant message (create branch)
      // (handler in ./routes/sessions — 1.1.7 ③ pure move)
      if (pathname === '/sessions/fork' && request.method === 'POST') {
        return await handleForkSession(request, jsonResponse);
      }
// Explicitly FIFO-queue a message (W1 — /chat/send busy 时走 steering,
      // 显式排队保留 M4b FIFO 语义:busy → 排队等 turn;空闲 → 直接开 turn)
      if (pathname === '/chat/queue' && request.method === 'POST') {
        let payload: SendMessagePayload;
        try {
          payload = (await request.json()) as SendMessagePayload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }
        const text = payload?.text?.trim() ?? '';
        const images = payload?.images ?? [];
        if (!text && images.length === 0) {
          return jsonResponse({ success: false, error: 'Message must have text or images.' }, 400);
        }
        try {
          const piResult = await queuePiChatMessage({
            text,
            images,
            model: payload?.model,
            providerEnv: payload?.providerEnv,
            permissionMode: payload?.permissionMode ?? 'auto',
            refs: payload?.refs,
          });
          if (piResult.error) {
            return jsonResponse({ success: false, error: piResult.error }, 429);
          }
          return jsonResponse({
            success: true,
            queued: piResult.queued ?? false,
            queueId: piResult.queueId,
            isInFlight: piResult.isInFlight ?? false,
          });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }
// Cancel a queued message
      if (pathname === '/chat/queue/cancel' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const queueId = body?.queueId as string;
        if (!queueId) {
          return jsonResponse({ success: false, error: 'queueId is required' }, 400);
        }
        // M4b — pi 引擎队列。
        if (isPiEngine()) {
          const piCancelled = cancelPiQueueItem(queueId);
          if (piCancelled === null) {
            return jsonResponse({ success: false, error: 'Queue item not found' }, 404);
          }
          return jsonResponse({ success: true, cancelledText: piCancelled });
        }
        return jsonResponse({ success: false, error: 'Queue item not found' }, 404);
      }
// Force-execute a queued message (interrupt current + run queued)
      if (pathname === '/chat/queue/force' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const queueId = body?.queueId as string;
        if (!queueId) {
          return jsonResponse({ success: false, error: 'queueId is required' }, 400);
        }
        try {
          // M4b — pi 引擎队列:中断当前,改跑指定排队项。
          if (isPiEngine()) {
            const piForced = await forcePiQueueItem(queueId);
            if (!piForced) {
              return jsonResponse({ success: false, error: 'Queue item not found' }, 404);
            }
            return jsonResponse({ success: true });
          }
          return jsonResponse({ success: false, error: 'Queue item not found' }, 404);
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }
// Get queue status
      if (pathname === '/chat/queue/status' && request.method === 'GET') {
        // M4b — pi 引擎队列。
        if (isPiEngine()) {
          return jsonResponse({ success: true, queue: getPiQueueStatus() });
        }
        return jsonResponse({ success: true, queue: getPiQueueStatus() });
      }
// Poll background task output file for live stats
      if (pathname === '/api/task/poll-background' && request.method === 'POST') {
        try {
          const body = await request.json() as { outputFile?: string; offset?: number };
          const { outputFile, offset = 0 } = body;
// Validate outputFile path: resolve to canonical path then verify it falls
          // under the user's home directory and matches expected suffix.
          // This prevents path traversal attacks (e.g., "/../../../etc/passwd.output").
          if (!outputFile || typeof outputFile !== 'string') {
            return jsonResponse({ success: false, error: 'Invalid outputFile path' }, 400);
          }
          const resolvedOutputFile = resolve(outputFile);
          const homeDir = getHomeDirOrNull() || '';
          const isUnderHome = homeDir && resolvedOutputFile.startsWith(homeDir + sep);
          if (!isUnderHome || !resolvedOutputFile.endsWith('.output')) {
            return jsonResponse({ success: false, error: 'Invalid outputFile path' }, 400);
          }
// Check file existence
          if (!existsSync(resolvedOutputFile)) {
            return jsonResponse({ success: true, stats: null, newOffset: 0, isComplete: false });
          }
const fileStat = statSync(resolvedOutputFile);
          const fileSize = fileStat.size;
// No new data
          if (offset >= fileSize) {
            return jsonResponse({ success: true, stats: null, newOffset: offset, isComplete: false });
          }
// Read incremental data (cap at 1MB)
          const MAX_READ = 1024 * 1024;
          const readEnd = Math.min(offset + MAX_READ, fileSize);
          const { open } = await import('node:fs/promises');
          const fh = await open(resolvedOutputFile, 'r');
          let text: string;
          try {
            const length = readEnd - offset;
            const buf = Buffer.alloc(length);
            await fh.read(buf, 0, length, offset);
            text = buf.toString('utf8');
          } finally {
            await fh.close();
          }
// Parse JSONL lines
          let toolCount = 0;
          let assistantCount = 0;
          let userCount = 0;
          let progressCount = 0;
          let firstTimestamp = 0;
          let lastTimestamp = 0;
          let lastLineType = '';
          let lastLineHasToolUse = false;
const lines = text.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              const ts = parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0;
              if (ts && !firstTimestamp) firstTimestamp = ts;
              if (ts) lastTimestamp = ts;
if (parsed.type === 'assistant') {
                assistantCount++;
                lastLineType = 'assistant';
                lastLineHasToolUse = false;
                // Count tool_use blocks in content
                if (Array.isArray(parsed.message?.content)) {
                  for (const block of parsed.message.content) {
                    if (block.type === 'tool_use') {
                      toolCount++;
                      lastLineHasToolUse = true;
                    }
                  }
                }
              } else if (parsed.type === 'user') {
                userCount++;
                lastLineType = 'user';
                lastLineHasToolUse = false;
              } else if (parsed.type === 'progress') {
                progressCount++;
              }
            } catch {
              // Skip truncated/invalid lines
            }
          }
const elapsed = firstTimestamp && lastTimestamp ? lastTimestamp - firstTimestamp : 0;
// Detect completion: last line is assistant with only text (no tool_use)
          const isComplete = lastLineType === 'assistant' && !lastLineHasToolUse;
return jsonResponse({
            success: true,
            stats: { toolCount, assistantCount, userCount, progressCount, elapsed },
            newOffset: readEnd,
            isComplete
          });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }
// Reset session for "new conversation" - clears all messages and state
      // 越界 ask 应答(design §6.6):客户端模态的 y/n 落点。
      if (pathname === '/chat/boundary/respond' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const askId = typeof body.askId === 'string' ? body.askId : '';
        if (!askId) {
          return jsonResponse({ success: false, error: 'Missing askId' }, 400);
        }
        // 1.3.2 缺口 1:扩字段——应答附带 note(可选),响应内容进 transcript。
        const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;
        const result = respondBoundaryAsk(askId, body.approve === true);
        if (!result.ok) {
          return jsonResponse({ success: false, error: 'ask 不存在或已作答/已过期' }, 404);
        }
        // 落盘 note:应答作为 user 消息追加进当前 loop 线的 jsonl(transcript)。
        // 仅在会话已绑定(存在首个用户消息)时落盘——不凭空造孤儿 jsonl。
        if (result.view && isPiEngine()) {
          const { loopSessionId, sessionMetaId } = getPiCurrentSessionRef();
          if (sessionMetaId) {
            const approved = body.approve === true;
            const line = `【越界应答】${result.view.kind} → ${approved ? '已批准' : '已拒绝'}`
              + (result.view.objects.length > 0 ? `\n对象: ${result.view.objects.join('、')}` : '')
              + (note ? `\n备注: ${note}` : '');
            void appendLoopMessages(loopSessionId, [
              { role: 'user', content: line, timestamp: Date.now() } as unknown as Parameters<typeof appendLoopMessages>[1][number],
            ]).catch((err) => console.warn('[chat/boundary/respond] 应答落盘失败:', err));
          }
        }
        return jsonResponse({ success: true });
      }
      // 1.3.2 决策应答:人的决定作为 user 消息注入回 loop + resolved 广播。
      if (pathname === '/chat/decision/respond' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const decisionId = typeof body.decisionId === 'string' ? body.decisionId : '';
        const choice = typeof body.choice === 'string' ? body.choice.trim() : '';
        if (!decisionId || !choice) {
          return jsonResponse({ success: false, error: 'Missing decisionId or choice' }, 400);
        }
        const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;
        const result = respondDecision(decisionId, choice, note);
        if (!result.ok) {
          return jsonResponse(
            {
              success: false,
              error: result.reason === 'resolved'
                ? '决策已作答(幂等:重复 respond 不重复注入)'
                : 'decisionId 不存在或已失效(服务重启后 pending 即失效)',
            },
            result.reason === 'resolved' ? 409 : 404,
          );
        }
        const d = result.decision;
        broadcast('chat:decision-resolved', {
          decisionId,
          choice,
          ...(d.note ? { note: d.note } : {}),
          expertRefs: d.expertRefs,
        });
        const injected = await injectPiDecision({
          decisionId: d.decisionId,
          sessionId: d.sessionId,
          question: d.question,
          choice,
          note: d.note,
          expertRefs: d.expertRefs,
        });
        return jsonResponse({
          success: true,
          data: { decisionId, injected: injected.success, ...(injected.error ? { error: injected.error } : {}) },
        });
      }
      if (pathname === '/chat/reset' && request.method === 'POST') {
        try {
          console.log('[chat] reset (new conversation)');
          // M4a — pi 引擎:新 loop 会话 id + 清内存态(旧 jsonl 保留可审计)。
          if (isPiEngine()) {
            resetPiChat();
            return jsonResponse({ success: true });
          }
          // M4c — pi 是唯一引擎,上面的分支恒命中。
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }
// ============= CRON TASK API =============
      // Handlers extracted to ./cron/routes (1.1.7 ③ — pure move). `jsonResponse`
      // and the raw `agentDir` CLI arg are passed in as params; the if-chain
      // order below preserves the original registration order (first match wins).
      // GET /cron/check-completion - Check if the last response indicates task completion
      if (pathname === '/cron/check-completion' && request.method === 'GET') {
        return await handleCronCheckCompletion(jsonResponse);
      }
      // POST /cron/execute - Execute a scheduled task
      // This endpoint wraps the user's prompt with cron-specific instructions
      // (cron 退出由 system prompt 的 zhishi cron exit 引导;exit_cron_task 工具已随 v0.2.11 退役)
      if (pathname === '/cron/execute' && request.method === 'POST') {
        return await handleCronExecute(request, jsonResponse, agentDir);
      }
      // POST /cron/execute-sync - Execute a scheduled task synchronously
      // This endpoint is used by Rust for direct Sidecar invocation without frontend
      // It waits for the execution to complete and returns the result
      if (pathname === '/cron/execute-sync' && request.method === 'POST') {
        return await handleCronExecuteSync(request, jsonResponse);
      }
// ============= GLOBAL STATS API =============
// GET /api/global-stats?range=7d|30d|60d - Aggregated token usage across all sessions
      if (pathname === '/api/global-stats' && request.method === 'GET') {
        try {
          const range = url.searchParams.get('range') || '30d';
          if (!['7d', '30d', '60d'].includes(range)) {
            return jsonResponse({ success: false, error: 'Invalid range. Use 7d, 30d, or 60d.' }, 400);
          }
const allSessions = getAllSessionMetadata();
// Filter sessions by time range using lastActiveAt as a coarse pre-filter
          const now = Date.now();
          const rangeDays = range === '7d' ? 7 : range === '30d' ? 30 : 60;
          const cutoff = now - rangeDays * 86400_000;
const sessions = allSessions.filter(s => new Date(s.lastActiveAt).getTime() >= cutoff);
// Helper: convert ISO timestamp to local date string "YYYY-MM-DD"
          const toLocalDate = (isoStr: string): string => {
            const d = new Date(isoStr);
            const y = d.getFullYear();
            const mo = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${mo}-${day}`;
          };
// Cutoff as YYYY-MM-DD for cheap string comparison against each message's local
          // date. Pre-2026-04 the summary numbers came from session-lifetime `s.stats` and
          // ignored cutoff entirely — that produced "summary says 31.5M tokens, daily chart
          // says 5M" mismatches because the summary leaked all historical totals from any
          // recently-active session. Now ALL summary/daily/byModel aggregations are derived
          // from the same in-range message walk so they stay consistent.
          const cutoffDateStr = toLocalDate(new Date(cutoff).toISOString());
const totalSessions = sessions.length;
          let messageCount = 0;
          let totalInputTokens = 0;
          let totalOutputTokens = 0;
          let totalCacheReadTokens = 0;
          let totalCacheCreationTokens = 0;
// Single pass through messages: aggregate summary + daily + byModel together so
          // they're guaranteed to agree about what falls inside the range.
          const dailyMap: Record<string, { inputTokens: number; outputTokens: number; messageCount: number }> = {};
          const byModel: Record<string, {
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            cacheCreationTokens: number;
            count: number;
          }> = {};
for (const s of sessions) {
            const sessionData = getSessionData(s.id);
            if (!sessionData) continue;
let lastUserDate = toLocalDate(s.createdAt); // fallback date for first assistant msg
for (const msg of sessionData.messages) {
              // Determine each message's local date so summary and chart agree on cutoff.
              let msgDate: string;
              if (msg.role === 'user') {
                msgDate = msg.timestamp ? toLocalDate(msg.timestamp) : lastUserDate;
                lastUserDate = msgDate;
              } else if (msg.role === 'assistant') {
                msgDate = msg.timestamp ? toLocalDate(msg.timestamp) : lastUserDate;
              } else {
                continue;
              }
              if (msgDate < cutoffDateStr) continue;
messageCount++;
if (msg.role !== 'assistant' || !msg.usage) continue;
const date = msgDate;
              totalInputTokens += msg.usage.inputTokens ?? 0;
              totalOutputTokens += msg.usage.outputTokens ?? 0;
              totalCacheReadTokens += msg.usage.cacheReadTokens ?? 0;
              totalCacheCreationTokens += msg.usage.cacheCreationTokens ?? 0;
// Daily aggregation
              if (!dailyMap[date]) {
                dailyMap[date] = { inputTokens: 0, outputTokens: 0, messageCount: 0 };
              }
              dailyMap[date].inputTokens += msg.usage.inputTokens ?? 0;
              dailyMap[date].outputTokens += msg.usage.outputTokens ?? 0;
              dailyMap[date].messageCount++;
// byModel aggregation
              if (msg.usage.modelUsage) {
                for (const [model, mu] of Object.entries(msg.usage.modelUsage)) {
                  if (!byModel[model]) {
                    byModel[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, count: 0 };
                  }
                  byModel[model].inputTokens += mu.inputTokens ?? 0;
                  byModel[model].outputTokens += mu.outputTokens ?? 0;
                  byModel[model].cacheReadTokens += mu.cacheReadTokens ?? 0;
                  byModel[model].cacheCreationTokens += mu.cacheCreationTokens ?? 0;
                  byModel[model].count++;
                }
              } else {
                const model = msg.usage.model || 'unknown';
                if (!byModel[model]) {
                  byModel[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, count: 0 };
                }
                byModel[model].inputTokens += msg.usage.inputTokens ?? 0;
                byModel[model].outputTokens += msg.usage.outputTokens ?? 0;
                byModel[model].cacheReadTokens += msg.usage.cacheReadTokens ?? 0;
                byModel[model].cacheCreationTokens += msg.usage.cacheCreationTokens ?? 0;
                byModel[model].count++;
              }
            }
          }
// Sort daily entries chronologically
          const daily = Object.entries(dailyMap)
            .map(([date, d]) => ({ date, ...d }))
            .sort((a, b) => a.date.localeCompare(b.date));
return jsonResponse({
            success: true,
            stats: {
              summary: {
                totalSessions,
                messageCount,
                totalInputTokens,
                totalOutputTokens,
                totalCacheReadTokens,
                totalCacheCreationTokens,
              },
              daily,
              byModel,
            },
          });
        } catch (error) {
          console.error('[global-stats] Error:', error);
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          }, 500);
        }
      }
// ============= SESSION API =============
      // Handlers extracted to ./routes/sessions (1.1.7 ③ — pure move);
      // `jsonResponse`/`pathname`/`url` are passed in as params. The if-chain
      // order below preserves the original registration order (first match
      // wins — /sessions/:id/since and /sessions/:id/stats stay BEFORE the
      // generic /sessions/:id).
      // GET /sessions - List all sessions or filter by agentDir
      if (pathname === '/sessions' && request.method === 'GET') {
        return await handleListSessions(url, jsonResponse);
      }
      // POST /sessions - Create a new session
      if (pathname === '/sessions' && request.method === 'POST') {
        return await handleCreateSession(request, jsonResponse);
      }
      // GET /sessions/:id/since/:lastMessageId - Incremental tail fetch
      // Called by the cron:execution-complete handler to pull only the messages
      // appended by a background task, instead of reloading the whole session.
      // Must be BEFORE the generic /sessions/:id route.
      if (pathname.match(/^\/sessions\/[^/]+\/since\/[^/]+$/) && request.method === 'GET') {
        return await handleGetSessionSince(pathname, jsonResponse);
      }
      // GET /sessions/:id/stats - Get detailed session statistics
      // NOTE: This route must be BEFORE /sessions/:id to avoid being caught by the generic route
      if (pathname.match(/^\/sessions\/[^/]+\/stats$/) && request.method === 'GET') {
        return await handleGetSessionStats(pathname, jsonResponse);
      }
      // GET /sessions/:id - Get session details
      if (pathname.startsWith('/sessions/') && request.method === 'GET') {
        return await handleGetSession(pathname, url, jsonResponse);
      }
      // DELETE /sessions/:id - Delete a session
      if (pathname.startsWith('/sessions/') && request.method === 'DELETE') {
        return await handleDeleteSession(pathname, jsonResponse);
      }
      // PATCH /sessions/:id - Update session metadata (incl. v0.1.69 config snapshot)
      if (pathname.startsWith('/sessions/') && request.method === 'PATCH') {
        return await handlePatchSession(pathname, request, jsonResponse);
      }
      // POST /sessions/switch - Switch to existing session for resume
      if (pathname === '/sessions/switch' && request.method === 'POST') {
        return await handleSwitchSession(request, jsonResponse);
      }
      // POST /api/generate-session-title - AI-generate a short session title
      if (pathname === '/api/generate-session-title' && request.method === 'POST') {
        return await handleGenerateSessionTitle(request, jsonResponse);
      }
      // ============= END SESSION API =============
// Switch agent directory at runtime (for browser development mode)
      if (pathname === '/agent/switch' && request.method === 'POST') {
        let payload: SwitchPayload;
        try {
          payload = (await request.json()) as SwitchPayload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }
const newDir = payload?.agentDir?.trim();
        if (!newDir) {
          return jsonResponse({ success: false, error: 'agentDir is required.' }, 400);
        }
// Security: validate the path before allowing access
        const validation = isValidAgentDir(newDir);
        if (!validation.valid) {
          console.warn(`[agent] blocked switch to "${newDir}": ${validation.reason}`);
          return jsonResponse({
            success: false,
            error: validation.reason || 'Invalid directory path'
          }, 403);
        }
try {
          console.log(`[agent] switch to dir="${newDir}"`);
          currentAgentDir = await ensureAgentDir(newDir);
          await initializeAgent(currentAgentDir, payload.initialPrompt);
          return jsonResponse({
            success: true,
            agentDir: currentAgentDir
          });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }
if (pathname === '/agent/upload' && request.method === 'POST') {
        const targetParam = url.searchParams.get('path') ?? '';
        const resolvedTarget =
          targetParam ? resolveAgentPath(currentAgentDir, targetParam) : currentAgentDir;
        if (!resolvedTarget) {
          return jsonResponse({ error: 'Invalid path.' }, 400);
        }
        try {
          const oversized = rejectIfOversizedUpload(request);
          if (oversized) return oversized;
          const formData = await request.formData();
          const files = Array.from(formData.values()).filter(
            (value) => typeof value !== 'string'
          ) as File[];
          if (files.length === 0) {
            return jsonResponse({ error: 'No files provided.' }, 400);
          }
          await ensureDir(resolvedTarget);
          const saved: string[] = [];
          for (const file of files) {
            const safeName = file.name.replace(/[<>:"/\\|?*]/g, '_');
            const destination = join(resolvedTarget, safeName);
            await streamUploadToFile(file, destination);
            saved.push(relative(currentAgentDir, destination));
          }
          return jsonResponse({ success: true, files: saved });
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }
// ============= FILE MANAGEMENT API =============
// GET /api/image?path=... - Serve generated images (for browser dev mode)
      if (pathname === '/api/image' && request.method === 'GET') {
        try {
          const imagePath = url.searchParams.get('path');
          if (!imagePath) {
            return jsonResponse({ success: false, error: 'Missing path parameter' }, 400);
          }
// Security: allow reading from workspace/zhishi_files/{generated_images,temp}/ or legacy paths
          const resolvedPath = resolve(imagePath);
          const legacyDir = join(getZhiShiDataDir(), 'generated');
          const legacyDirSep = legacyDir.endsWith(sep) ? legacyDir : legacyDir + sep;
          // New unified paths + backward compat with zhishi-generated/images/
          const allowedDirs = currentAgentDir ? [
            join(currentAgentDir, 'zhishi_files', 'generated_images'),
            join(currentAgentDir, 'zhishi_files', 'temp'),
            join(currentAgentDir, 'zhishi-generated', 'images'), // backward compat
          ] : [];
          const allowed = resolvedPath.startsWith(legacyDirSep)
            || allowedDirs.some(d => resolvedPath.startsWith(d.endsWith(sep) ? d : d + sep));
          if (!allowed) {
            return jsonResponse({ success: false, error: 'Access denied: path must be within generated directory' }, 403);
          }
if (!existsSync(resolvedPath)) {
            return jsonResponse({ success: false, error: 'Image not found' }, 404);
          }
const ext = resolvedPath.split('.').pop()?.toLowerCase();
          const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
const resp = await fileResponse(resolvedPath, {
            contentType: mimeType,
            headers: { 'Cache-Control': 'public, max-age=86400' },
          });
          return resp ?? jsonResponse({ success: false, error: 'Image not found' }, 404);
        } catch (error) {
          console.error('[api/image] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to serve image' },
            500
          );
        }
      }
// GET /api/audio?path=... - Serve generated audio (for browser dev mode)
      if (pathname === '/api/audio' && request.method === 'GET') {
        try {
          const audioPath = url.searchParams.get('path');
          if (!audioPath) {
            return jsonResponse({ success: false, error: 'Missing path parameter' }, 400);
          }
// Security: allow reading from workspace/zhishi_files/generated_audio/ or legacy paths
          const resolvedPath = resolve(audioPath);
          const legacyAudioDir = join(getZhiShiDataDir(), 'generated_audio');
          const legacyAudioDirSep = legacyAudioDir.endsWith(sep) ? legacyAudioDir : legacyAudioDir + sep;
          // New unified path + backward compat with zhishi-generated/audio/
          const allowedAudioDirs = currentAgentDir ? [
            join(currentAgentDir, 'zhishi_files', 'generated_audio'),
            join(currentAgentDir, 'zhishi-generated', 'audio'), // backward compat
          ] : [];
          const audioAllowed = resolvedPath.startsWith(legacyAudioDirSep)
            || allowedAudioDirs.some(d => resolvedPath.startsWith(d.endsWith(sep) ? d : d + sep));
          if (!audioAllowed) {
            return jsonResponse({ success: false, error: 'Access denied: path must be within generated_audio directory' }, 403);
          }
if (!existsSync(resolvedPath)) {
            return jsonResponse({ success: false, error: 'Audio not found' }, 404);
          }
const ext = resolvedPath.split('.').pop()?.toLowerCase();
          const mimeTypes: Record<string, string> = {
            mp3: 'audio/mpeg',
            wav: 'audio/wav',
            ogg: 'audio/ogg',
            webm: 'audio/webm',
            opus: 'audio/opus',
            aac: 'audio/aac',
            m4a: 'audio/mp4',
          };
          const mimeType = mimeTypes[ext || ''] || 'audio/mpeg';
const resp = await fileResponse(resolvedPath, {
            contentType: mimeType,
            headers: { 'Cache-Control': 'public, max-age=86400' },
          });
          return resp ?? jsonResponse({ success: false, error: 'Audio not found' }, 404);
        } catch (error) {
          console.error('[api/audio] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to serve audio' },
            500
          );
        }
      }
// ============= END FILE MANAGEMENT API =============
// ============= UNIFIED LOGGING API =============
// POST /api/unified-log - Receive frontend logs for persistence
      if (pathname === '/api/unified-log' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            entries?: Array<{
              source: 'react' | 'bun' | 'rust';
              level: 'info' | 'warn' | 'error' | 'debug';
              message: string;
              timestamp: string;
            }>;
          };
if (payload.entries && Array.isArray(payload.entries)) {
            appendUnifiedLogBatch(payload.entries);
          }
return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to log'
          }, 500);
        }
      }
// GET /api/logs/export - Export recent unified logs as zip
      if (pathname === '/api/logs/export' && request.method === 'GET') {
        try {
          const { readdirSync, statSync } = await import('fs');
          const { join: joinPath } = await import('path');
          const { homedir } = await import('os');
          const logsDir = joinPath(getZhiShiDataDir(), 'logs');
// Collect last 3 days of unified-*.log files
          const now = Date.now();
          const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
          const files = readdirSync(logsDir)
            .filter(f => f.startsWith('unified-') && f.endsWith('.log'))
            .filter(f => {
              try {
                return now - statSync(joinPath(logsDir, f)).mtimeMs < threeDaysMs;
              } catch { return false; }
            })
            .sort();
if (files.length === 0) {
            return jsonResponse({ success: false, error: '没有找到近3天的运行日志' }, 404);
          }
// Output to Desktop
          const desktopDir = joinPath(homedir(), 'Desktop');
          const timestamp = new Date().toISOString().slice(0, 10);
          const zipName = `ZhiShi-logs-${timestamp}.zip`;
          const zipPath = joinPath(desktopDir, zipName);
// Create zip using platform-appropriate command
          const isWin = process.platform === 'win32';
          const filePaths = files.map(f => joinPath(logsDir, f));
// stdout/stderr must be ignored — zip/Compress-Archive emit per-file progress
          // that can exceed the 64KB pipe buffer on large log sets and deadlock the
          // child waiting for us to read.
          if (isWin) {
            const { default: AdmZip } = await import('adm-zip');
            const zip = new AdmZip();
            for (const filePath of filePaths) {
              zip.addLocalFile(filePath);
            }
            zip.writeZip(zipPath);
          } else {
            // macOS/Linux: zip command
            const proc = subprocessSpawn(['zip', '-j', zipPath, ...filePaths], {
              stdout: 'ignore',
              stderr: 'ignore',
            });
            await proc.exited;
          }
return jsonResponse({ success: true, path: zipPath });
        } catch (error) {
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to export logs'
          }, 500);
        }
      }
// ============= PROVIDER VERIFICATION API =============
// POST /api/provider/verify - Verify API key via SDK (same path as normal chat)
      if (pathname === '/api/provider/verify' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            baseUrl?: string;
            apiKey?: string;
            model?: string;
            authType?: string;
            apiProtocol?: string;
            maxOutputTokens?: number;
            maxOutputTokensParamName?: string;
            upstreamFormat?: string;
          };
const { baseUrl, apiKey, model, authType, apiProtocol, maxOutputTokens, maxOutputTokensParamName, upstreamFormat } = payload;
if (!baseUrl || !apiKey) {
            return jsonResponse({ success: false, error: 'baseUrl and apiKey are required.' }, 400);
          }
console.log(`[api/provider/verify] =========================`);
          console.log(`[api/provider/verify] baseUrl: ${baseUrl}`);
          console.log(`[api/provider/verify] apiKey: ${apiKey.slice(0, 10)}...`);
          console.log(`[api/provider/verify] model: ${model ?? 'default'}`);
          console.log(`[api/provider/verify] authType: ${authType ?? 'both'}`);
          console.log(`[api/provider/verify] apiProtocol: ${apiProtocol ?? 'anthropic'}`);
          console.log(`[api/provider/verify] maxOutputTokens: ${maxOutputTokens ?? 'none'}`);
// Unified SDK verification for all protocols (Anthropic + OpenAI)
          // For OpenAI protocol: SDK → CLI → bridge loopback → upstream (end-to-end)
          // For Anthropic protocol: SDK → CLI → upstream (same as before)
          const result = await verifyProviderViaSdk(
            baseUrl, apiKey, authType ?? 'both', model || undefined,
            apiProtocol === 'openai' ? 'openai' : undefined,
            maxOutputTokens,
            maxOutputTokensParamName as 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens' | undefined,
            upstreamFormat === 'responses' ? 'responses' : undefined,
          );
console.log(`[api/provider/verify] result:`, JSON.stringify(result));
          console.log(`[api/provider/verify] =========================`);
return jsonResponse(result);
        } catch (error) {
          console.error('[api/provider/verify] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Verification failed' },
            500
          );
        }
      }
// GET /api/assets/qr-code - Fetch QR code image with local caching
      // Downloads from CDN on first launch and caches locally for subsequent requests
      // Cache refreshes every hour to get updated QR codes from cloud
      if (pathname === '/api/assets/qr-code' && request.method === 'GET') {
        try {
          // Public Admin Service endpoint that returns the current community QR
          // code image URL. The URL can be overridden for local/self-hosted setups.
          const QR_CODE_API_URL = process.env.ZHISHI_QR_CODE_API_URL || 'https://ticket.zhishi.help/api/v1/community-qr';
const startTime = Date.now();
// 1. Fetch current image URL from Admin Service (lightweight JSON call)
          const configController = new AbortController();
          const configTimeoutId = setTimeout(() => configController.abort(), 10000);
          const configResponse = await fetch(QR_CODE_API_URL, { signal: configController.signal });
          clearTimeout(configTimeoutId);
if (!configResponse.ok) {
            throw new Error(`配置获取失败: HTTP ${configResponse.status}`);
          }
const configData = await configResponse.json() as { image_url?: string; updated_at?: string };
          const imageUrl = configData.image_url?.trim();
          const serverUpdatedAt = configData.updated_at || '';
if (!imageUrl) {
            console.log('[api/assets/qr-code] No QR code configured on server');
            return jsonResponse({ success: false, error: '暂无二维码' }, 503);
          }
// 2. Determine MIME type from the image URL extension for correct data: URL
          const urlPath = imageUrl.split('?')[0].toLowerCase();
          let mimeType = 'image/png';
          if (urlPath.endsWith('.jpg') || urlPath.endsWith('.jpeg')) mimeType = 'image/jpeg';
          else if (urlPath.endsWith('.webp')) mimeType = 'image/webp';
          else if (urlPath.endsWith('.gif')) mimeType = 'image/gif';
// Use a cache file keyed by MIME category so format changes don't reuse wrong extension
          const ext = mimeType.split('/')[1] || 'png';
          const CACHE_DIR = join(tmpdir(), 'zhishi-cache');
          const CACHE_FILE = join(CACHE_DIR, `community-qr.${ext}`);
          const CACHE_META_FILE = `${CACHE_FILE}.meta.json`;
          const LOCK_FILE = `${CACHE_FILE}.lock`;
let needsDownload = true;
// Check if cached file exists and matches server timestamp.
          // Using updated_at from the API means the cache is valid until the
          // admin uploads a new image — no fixed TTL needed.
          if (existsSync(CACHE_FILE) && existsSync(CACHE_META_FILE)) {
            try {
              const cachedMeta = JSON.parse(readFileSync(CACHE_META_FILE, 'utf-8'));
              if (cachedMeta.updated_at && serverUpdatedAt && cachedMeta.updated_at === serverUpdatedAt) {
                needsDownload = false;
                console.log('[api/assets/qr-code] Cache valid (server timestamp unchanged)');
              } else {
                console.log('[api/assets/qr-code] Server timestamp changed, re-downloading');
              }
            } catch {
              console.log('[api/assets/qr-code] Meta cache corrupt, re-downloading');
            }
          } else {
            console.log('[api/assets/qr-code] Cache miss, downloading');
          }
// Download if needed (with file lock to prevent concurrent writes)
          if (needsDownload) {
            // Check if another process is already downloading
            if (existsSync(LOCK_FILE)) {
              const lockStats = statSync(LOCK_FILE);
              const lockAge = Date.now() - lockStats.mtimeMs;
              if (lockAge < 30000) { // Lock valid for 30s
                console.log('[api/assets/qr-code] Download in progress, waiting...');
                // Wait and use existing cache if available
                if (existsSync(CACHE_FILE)) {
                  const imageBuffer = readFileSync(CACHE_FILE);
                  const base64 = imageBuffer.toString('base64');
                  return jsonResponse({
                    success: true,
                    dataUrl: `data:${mimeType};base64,${base64}`
                  });
                }
              } else {
                // Stale lock, remove it
                rmSync(LOCK_FILE, { force: true });
              }
            }
// Acquire lock
            if (!existsSync(CACHE_DIR)) {
              ensureDirSync(CACHE_DIR);
            }
            writeFileSync(LOCK_FILE, String(Date.now()));
try {
              const downloadStartTime = Date.now();
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
const response = await fetch(imageUrl, { signal: controller.signal });
              clearTimeout(timeoutId);
if (!response.ok) {
                // If download fails but cache exists, use stale cache
                if (existsSync(CACHE_FILE)) {
                  console.warn(`[api/assets/qr-code] Download failed (HTTP ${response.status}), using stale cache`);
                } else {
                  throw new Error(`下载失败: HTTP ${response.status}`);
                }
              } else {
                // Save to cache using atomic write pattern
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                const downloadTime = Date.now() - downloadStartTime;
// Write to temp file first
                const tmpFile = `${CACHE_FILE}.${Date.now()}.tmp`;
                writeFileSync(tmpFile, buffer);
                // Atomic rename (POSIX guarantee)
                renameSync(tmpFile, CACHE_FILE);
                // Also write cache metadata so we can detect server-side updates
                if (serverUpdatedAt) {
                  const metaTmp = `${CACHE_META_FILE}.tmp`;
                  writeFileSync(metaTmp, JSON.stringify({ updated_at: serverUpdatedAt }));
                  renameSync(metaTmp, CACHE_META_FILE);
                }
                console.log(`[api/assets/qr-code] Downloaded and cached (${Math.round(buffer.length / 1024)}KB in ${downloadTime}ms)`);
              }
            } finally {
              // Release lock
              rmSync(LOCK_FILE, { force: true });
            }
          }
// Read from cache and return as base64
          if (!existsSync(CACHE_FILE)) {
            return jsonResponse({ success: false, error: 'QR code not available' }, 503);
          }
const imageBuffer = readFileSync(CACHE_FILE);
          const base64 = imageBuffer.toString('base64');
          const totalTime = Date.now() - startTime;
console.log(`[api/assets/qr-code] Request completed in ${totalTime}ms`);
return jsonResponse({
            success: true,
            dataUrl: `data:${mimeType};base64,${base64}`
          });
        } catch (error) {
          console.error('[api/assets/qr-code] Error:', error);
          const isTimeout = error instanceof Error && error.name === 'AbortError';
          return jsonResponse(
            { success: false, error: isTimeout ? '网络请求超时' : (error instanceof Error ? error.message : '加载失败') },
            isTimeout ? 504 : 503
          );
        }
      }
// ============= END PROVIDER VERIFICATION API =============
// ============= PROXY API =============
// POST /api/proxy/set - Hot-reload proxy config into this Sidecar process
      if (pathname === '/api/proxy/set' && request.method === 'POST') {
        try {
          const payload = await request.json();
          setProxyConfig(payload);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/proxy/set] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to set proxy config' },
            500
          );
        }
      }
// ============= MCP API =============
      // Handlers extracted to ./routes/mcp (1.1.7 ③ — pure move); the
      // if-chain order below preserves the original registration order.
      // POST /api/mcp/set - Set MCP servers for current workspace
      if (pathname === '/api/mcp/set' && request.method === 'POST') {
        return await handleMcpSet(request, jsonResponse);
      }
      // GET /api/mcp - Get current MCP servers
      if (pathname === '/api/mcp' && request.method === 'GET') {
        return await handleMcpGet(jsonResponse);
      }
      // POST /api/mcp/enable - Validate and enable MCP server
      // For preset MCP (npx): warmup npm/npx cache (system npx → bundled npx → bun x)
      // For custom MCP: check if command exists
      if (pathname === '/api/mcp/enable' && request.method === 'POST') {
        return await handleMcpEnable(request, jsonResponse);
      }
      // ============= MCP OAuth API =============
      // POST /api/mcp/oauth/discover - Probe MCP server for OAuth requirements
      if (pathname === '/api/mcp/oauth/discover' && request.method === 'POST') {
        return await handleMcpOauthDiscover(request, jsonResponse);
      }
      // POST /api/mcp/oauth/start - Start OAuth flow (auto or manual mode)
      if (pathname === '/api/mcp/oauth/start' && request.method === 'POST') {
        return await handleMcpOauthStart(request, jsonResponse);
      }
      // GET /api/mcp/oauth/status/:serverId - Get OAuth status
      if (pathname.startsWith('/api/mcp/oauth/status/') && request.method === 'GET') {
        return await handleMcpOauthStatus(pathname, jsonResponse);
      }
      // POST /api/mcp/oauth/refresh - Manually refresh OAuth token
      if (pathname === '/api/mcp/oauth/refresh' && request.method === 'POST') {
        return await handleMcpOauthRefresh(request, jsonResponse);
      }
      // DELETE /api/mcp/oauth/token - Revoke OAuth authorization
      if (pathname === '/api/mcp/oauth/token' && request.method === 'DELETE') {
        return await handleMcpOauthToken(request, jsonResponse);
      }
      // ============= END MCP OAuth API =============
      // ============= END MCP API =============
// ============= ADMIN API (Self-Config CLI) =============
      if (pathname.startsWith('/api/admin/') && request.method === 'POST') {
        try {
          const payload = pathname === '/api/admin/status'
            ? {}
            : await request.json().catch(() => ({})) as Record<string, unknown>;
const result = await routeAdminApi(pathname, payload);
          return jsonResponse(result, result.success ? 200 : 400);
        } catch (error) {
          console.error(`[admin] ${pathname} error:`, error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Admin API error' },
            500
          );
        }
      }
      // ============= END ADMIN API =============
// ============= SLASH COMMANDS API =============
// ============= CLAUDE.md API =============
// Security: Validate item names to prevent path traversal attacks
      // Supports Unicode (Chinese, Japanese, etc.) while maintaining security
      // Defined here (before Rules and Skills APIs) so all endpoints can use it
      const isValidItemName = (name: string): boolean => {
        // Reject empty names
        if (!name || name.trim().length === 0) {
          return false;
        }
        // Reject path separators and parent directory references (security)
        if (name.includes('/') || name.includes('\\') || name.includes('..')) {
          return false;
        }
        // Reject Windows reserved characters: < > : " | ? *
        // These cause issues on Windows file systems
        if (/[<>:"|?*]/.test(name)) {
          return false;
        }
        // Reject control characters (0x00-0x1F, 0x7F)
// eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f\x7f]/.test(name)) {
          return false;
        }
        // Reject names that are only dots (., ..) or start/end with spaces
        if (/^\.+$/.test(name) || name !== name.trim()) {
          return false;
        }
        // Reject Windows reserved file names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
        if (isWindowsReservedName(name)) {
          return false;
        }
        // Allow Unicode letters, numbers, hyphens, underscores, spaces, and common punctuation
        return true;
      };
// ============= WORKSPACE FILES API (1.3.3) =============
      // 只读目录树——@ 补全的文件数据源(最小面:列目录,无内容/写能力)。
      // GET /api/workspace/files?dir=<rel>&depth=<n>[&agentDir=<dir>]
      if (pathname === '/api/workspace/files' && request.method === 'GET') {
        try {
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const subdir = url.searchParams.get('dir') ?? '';
          const rawDepth = parseInt(url.searchParams.get('depth') ?? '', 10);
          const result = listWorkspaceFiles(targetDir, {
            subdir,
            ...(Number.isFinite(rawDepth) ? { maxDepth: Math.max(0, rawDepth) } : {}),
          });
          if (!result.ok) {
            return jsonResponse({ success: false, error: result.error }, 404);
          }
          return jsonResponse({
            success: true,
            files: result.files,
            truncated: result.truncated,
          });
        } catch (error) {
          console.error('[api/workspace/files] Error listing:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list workspace files' },
            500
          );
        }
      }
      // ============= RULES FILES API =============
      // Manage .claude/rules/*.md files (system prompt rules)
// GET /api/rules - List all rule files
      if (pathname === '/api/rules' && request.method === 'GET') {
        try {
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          if (!existsSync(rulesDir)) {
            return jsonResponse({ success: true, files: [] });
          }
          const files = readdirSync(rulesDir)
            .filter(f => f.endsWith('.md'))
            .sort();
          return jsonResponse({ success: true, files });
        } catch (error) {
          console.error('[api/rules] Error listing:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list rules' },
            500
          );
        }
      }
// POST /api/rules - Create a new rule file
      if (pathname === '/api/rules' && request.method === 'POST') {
        try {
          const payload = await request.json() as { name: string; content?: string };
          if (!payload.name || !payload.name.trim()) {
            return jsonResponse({ success: false, error: 'Name is required' }, 400);
          }
          // Ensure .md suffix
          let filename = payload.name.trim();
          if (!filename.endsWith('.md')) {
            filename = filename + '.md';
          }
          const nameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(nameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid file name' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          ensureDirSync(rulesDir);
          const filePath = join(rulesDir, filename);
          if (existsSync(filePath)) {
            return jsonResponse({ success: false, error: 'File already exists' }, 409);
          }
          writeFileSync(filePath, payload.content || '', 'utf-8');
          return jsonResponse({ success: true, filename });
        } catch (error) {
          console.error('[api/rules] Error creating:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create rule file' },
            500
          );
        }
      }
// PUT /api/rules/:filename/rename - Rename a rule file
      if (pathname.startsWith('/api/rules/') && pathname.endsWith('/rename') && request.method === 'PUT') {
        try {
          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length, -'/rename'.length));
          if (!filename || !filename.endsWith('.md')) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const oldNameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(oldNameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const payload = await request.json() as { newName: string };
          if (!payload.newName || !payload.newName.trim()) {
            return jsonResponse({ success: false, error: 'New name is required' }, 400);
          }
          let newFilename = payload.newName.trim();
          if (!newFilename.endsWith('.md')) {
            newFilename = newFilename + '.md';
          }
          const newNameWithoutExt = newFilename.replace(/\.md$/, '');
          if (!isValidItemName(newNameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid new file name' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          const oldPath = join(rulesDir, filename);
          const newPath = join(rulesDir, newFilename);
          if (!existsSync(oldPath)) {
            return jsonResponse({ success: false, error: 'File not found' }, 404);
          }
          if (existsSync(newPath)) {
            return jsonResponse({ success: false, error: 'Target filename already exists' }, 409);
          }
          renameSync(oldPath, newPath);
          return jsonResponse({ success: true, filename: newFilename });
        } catch (error) {
          console.error('[api/rules] Error renaming:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to rename rule file' },
            500
          );
        }
      }
// GET /api/rules/:filename - Read a rule file
      if (pathname.startsWith('/api/rules/') && request.method === 'GET') {
        try {
          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length));
          if (!filename || !filename.endsWith('.md')) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const nameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(nameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          const filePath = join(rulesDir, filename);
          if (!existsSync(filePath)) {
            return jsonResponse({ success: true, exists: false, content: '' });
          }
          const content = readFileSync(filePath, 'utf-8');
          return jsonResponse({ success: true, exists: true, content });
        } catch (error) {
          console.error('[api/rules] Error reading:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to read rule file' },
            500
          );
        }
      }
// PUT /api/rules/:filename - Update a rule file
      if (pathname.startsWith('/api/rules/') && request.method === 'PUT') {
        try {
          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length));
          if (!filename || !filename.endsWith('.md')) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const nameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(nameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const payload = await request.json() as { content: string };
          if (typeof payload.content !== 'string') {
            return jsonResponse({ success: false, error: 'Content must be a string' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          ensureDirSync(rulesDir);
          const filePath = join(rulesDir, filename);
          writeFileSync(filePath, payload.content, 'utf-8');
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/rules] Error updating:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update rule file' },
            500
          );
        }
      }
// DELETE /api/rules/:filename - Delete a rule file
      if (pathname.startsWith('/api/rules/') && request.method === 'DELETE') {
        try {
          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length));
          if (!filename || !filename.endsWith('.md')) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const nameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(nameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          const filePath = join(rulesDir, filename);
          if (!existsSync(filePath)) {
            return jsonResponse({ success: false, error: 'File not found' }, 404);
          }
          unlinkSync(filePath);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/rules] Error deleting:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete rule file' },
            500
          );
        }
      }
// ============= SKILLS MANAGEMENT API =============
const userSkillsBaseDir = join(getZhiShiDataDir(), 'skills');
      const userCommandsBaseDir = join(getZhiShiDataDir(), 'commands');
// Helper: Get project base directories (supports explicit agentDir parameter)
      // Security: validates agentDir to prevent path traversal attacks
      const getProjectBaseDirs = (queryAgentDir: string | null) => {
        // If explicit agentDir provided, validate it first
        if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
          // Invalid agentDir, fall back to currentAgentDir
          console.warn(`[getProjectBaseDirs] Invalid agentDir rejected: ${queryAgentDir}`);
          queryAgentDir = null;
        }
        // Use validated agentDir if provided, otherwise fall back to currentAgentDir
        const effectiveAgentDir = queryAgentDir || currentAgentDir;
        const hasValidDir = effectiveAgentDir && existsSync(effectiveAgentDir);
        return {
          skillsDir: hasValidDir ? join(effectiveAgentDir, '.claude', 'skills') : '',
          commandsDir: hasValidDir ? join(effectiveAgentDir, '.claude', 'commands') : '',
        };
      };
// Default project paths (using currentAgentDir)
      const hasValidAgentDir = currentAgentDir && existsSync(currentAgentDir);
      const projectSkillsBaseDir = hasValidAgentDir ? join(currentAgentDir, '.claude', 'skills') : '';
      const projectCommandsBaseDir = hasValidAgentDir ? join(currentAgentDir, '.claude', 'commands') : '';
// POST /api/skill/toggle-enable - Enable/disable a user-level skill
      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard
      if (pathname === '/api/skill/toggle-enable' && request.method === 'POST') {
        try {
          const { folderName, enabled } = await request.json() as { folderName: string; enabled: boolean };
          if (!folderName || typeof folderName !== 'string') {
            return jsonResponse({ success: false, error: 'Invalid folderName' }, 400);
          }
          await mutateSkillsConfig((config) => {
            if (enabled) {
              config.disabled = config.disabled.filter(n => n !== folderName);
            } else {
              if (!config.disabled.includes(folderName)) config.disabled.push(folderName);
            }
            return true;
          });
          // Re-sync project skill symlinks if this sidecar has an agentDir
          // (Global Sidecar has no agentDir; Tab Sidecars will sync on next /api/commands)
          if (agentDir) { syncProjectUserConfig(agentDir); }
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/skill/toggle-enable] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to toggle skill' },
            500
          );
        }
      }
// GET /api/skill/:name - Get skill detail
      if (pathname.startsWith('/api/skill/') && request.method === 'GET') {
        try {
          const skillName = decodeURIComponent(pathname.replace('/api/skill/', ''));
          if (!isValidItemName(skillName)) {
            return jsonResponse({ success: false, error: 'Invalid skill name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');
// Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userSkillsBaseDir : skillsDir;
          const skillPath = join(baseDir, skillName, 'SKILL.md');
if (!existsSync(skillPath)) {
            return jsonResponse({ success: false, error: 'Skill not found' }, 404);
          }
const content = readFileSync(skillPath, 'utf-8');
          const { frontmatter, body } = parseFullSkillContent(content);
return jsonResponse({
            success: true,
            skill: {
              name: frontmatter.name || skillName,
              folderName: skillName,
              path: skillPath,
              scope,
              frontmatter,
              body,
            }
          });
        } catch (error) {
          console.error('[api/skill] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to get skill' },
            500
          );
        }
      }
// PUT /api/skill/:name - Update skill (with optional folder rename)
      if (pathname.startsWith('/api/skill/') && request.method === 'PUT') {
        try {
          const skillName = decodeURIComponent(pathname.replace('/api/skill/', ''));
          if (!isValidItemName(skillName)) {
            return jsonResponse({ success: false, error: 'Invalid skill name' }, 400);
          }
          const payload = await request.json() as {
            scope: 'user' | 'project';
            frontmatter: Partial<SkillFrontmatter>;
            body: string;
            newFolderName?: string; // Optional: rename folder if provided
            agentDir?: string; // Optional: explicit project directory
          };
// Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : skillsDir;
          let currentFolderName = skillName;
          let skillDir = join(baseDir, currentFolderName);
          let skillPath = join(skillDir, 'SKILL.md');
if (!existsSync(skillPath)) {
            return jsonResponse({ success: false, error: 'Skill not found' }, 404);
          }
// Handle folder rename if newFolderName is provided and different
          if (payload.newFolderName && payload.newFolderName !== currentFolderName) {
            const newFolderName = payload.newFolderName;
// Validate new folder name
            if (!isValidItemName(newFolderName)) {
              return jsonResponse({ success: false, error: 'Invalid new folder name' }, 400);
            }
const newSkillDir = join(baseDir, newFolderName);
// Check for conflict
            if (existsSync(newSkillDir)) {
              return jsonResponse({ success: false, error: `技能文件夹 "${newFolderName}" 已存在，请使用其他名称` }, 409);
            }
// Atomic-like operation: prepare content first, then rename
            // If rename fails, nothing is lost. If write fails after rename, folder is renamed but content unchanged.
            const content = serializeSkillContent(payload.frontmatter, payload.body);
// Rename the folder
            renameSync(skillDir, newSkillDir);
            skillDir = newSkillDir;
            skillPath = join(skillDir, 'SKILL.md');
            currentFolderName = newFolderName;
// Write content to new location
            writeFileSync(skillPath, content, 'utf-8');
// User skill renamed — bump generation + re-sync to fix old dangling symlink + create new one
            if (payload.scope === 'user') {
              await bumpSkillsGeneration();
              if (agentDir) { syncProjectUserConfig(agentDir); }
            }
            return jsonResponse({
              success: true,
              path: skillPath,
              folderName: currentFolderName,
              fullPath: skillDir
            });
          }
// No rename, just update content
          const content = serializeSkillContent(payload.frontmatter, payload.body);
          writeFileSync(skillPath, content, 'utf-8');
return jsonResponse({
            success: true,
            path: skillPath,
            folderName: currentFolderName,
            fullPath: skillDir
          });
        } catch (error) {
          console.error('[api/skill] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update skill' },
            500
          );
        }
      }
// DELETE /api/skill/:name - Delete skill
      if (pathname.startsWith('/api/skill/') && request.method === 'DELETE') {
        try {
          const skillName = decodeURIComponent(pathname.replace('/api/skill/', ''));
          if (!isValidItemName(skillName)) {
            return jsonResponse({ success: false, error: 'Invalid skill name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');
// Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userSkillsBaseDir : skillsDir;
          const skillDir = join(baseDir, skillName);
if (!existsSync(skillDir)) {
            return jsonResponse({ success: false, error: 'Skill not found' }, 404);
          }
rmSync(skillDir, { recursive: true, force: true });
          // User skill deleted — bump generation + re-sync to remove dangling symlinks
          if (scope === 'user') {
            await bumpSkillsGeneration();
            if (agentDir) { syncProjectUserConfig(agentDir); }
          }
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/skill] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete skill' },
            500
          );
        }
      }
// POST /api/skill/copy-to-global - Copy a project skill to global (~/.zhishi/skills/)
      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard
      if (pathname === '/api/skill/copy-to-global' && request.method === 'POST') {
        try {
          const { folderName } = await request.json() as { folderName: string };
          if (!folderName || typeof folderName !== 'string' || !isValidItemName(folderName)) {
            return jsonResponse({ success: false, error: 'Invalid folderName' }, 400);
          }
// Validate project skills directory
          if (!projectSkillsBaseDir) {
            return jsonResponse({ success: false, error: '当前没有项目工作目录' }, 400);
          }
const srcDir = join(projectSkillsBaseDir, folderName);
          if (!existsSync(srcDir)) {
            return jsonResponse({ success: false, error: '项目技能不存在' }, 404);
          }
// Check SKILL.md exists in source
          if (!existsSync(join(srcDir, 'SKILL.md'))) {
            return jsonResponse({ success: false, error: '项目技能缺少 SKILL.md' }, 400);
          }
// Check if already exists in global
          const destDir = join(userSkillsBaseDir, folderName);
          if (existsSync(destDir)) {
            return jsonResponse({ success: false, error: '全局技能中已存在同名技能' }, 409);
          }
// Ensure global skills directory exists
          ensureDirSync(userSkillsBaseDir);
// Copy the skill folder — async variant so /health stays responsive
          // while large skills copy (see copyDirRecursive doc).
          await copyDirRecursive(srcDir, destDir, '[api/skill/copy-to-global]');
// Bump generation + sync symlinks into project
          await bumpSkillsGeneration();
          if (currentAgentDir) { syncProjectUserConfig(currentAgentDir); }
return jsonResponse({ success: true, folderName });
        } catch (error) {
          console.error('[api/skill/copy-to-global] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to copy skill to global' },
            500
          );
        }
      }
// POST /api/skill/import-folder - Import skill from a local folder path.
      // 1.3.2 验证:非 Tauri-only——webview/浏览器直连 sidecar 可达(同一条
      // handler 链、OPTIONS 预检 ACAO:* 放行 POST、jsonResponse 全响应带
      // ACAO:*、127.0.0.1 无 origin 门禁;GUI 经 GuiSidecarClient.postJson
      // 原生 fetch 直连,已在用)。旧注释「Tauri only」为过期标注。
      if (pathname === '/api/skill/import-folder' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            folderPath: string;
            scope: 'user' | 'project';
          };
if (!payload.folderPath) {
            return jsonResponse({ success: false, error: 'Folder path is required' }, 400);
          }
const sourcePath = payload.folderPath;
          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : projectSkillsBaseDir;
// Validate target directory is available
          if (!baseDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }
// Validate source folder exists
          if (!existsSync(sourcePath)) {
            return jsonResponse({ success: false, error: '指定的文件夹不存在' }, 400);
          }
// Check if it's a directory
          try {
            const stats = statSync(sourcePath);
            if (!stats.isDirectory()) {
              return jsonResponse({ success: false, error: '指定的路径不是文件夹' }, 400);
            }
          } catch {
            return jsonResponse({ success: false, error: '无法读取文件夹信息' }, 400);
          }
// Check for SKILL.md at root (case-insensitive for Windows/macOS)
          let skillMdPath = join(sourcePath, 'SKILL.md');
          if (!existsSync(skillMdPath)) {
            try {
              const entries = readdirSync(sourcePath);
              const match = entries.find((e) => e.toLowerCase() === 'skill.md');
              if (match) {
                skillMdPath = join(sourcePath, match);
              }
            } catch {
              // ignore readdir errors, fall through to the exists check below
            }
          }
          if (!existsSync(skillMdPath)) {
            return jsonResponse({ success: false, error: '文件夹中未找到 SKILL.md 文件' }, 400);
          }
// Read SKILL.md to get the skill name
          const skillMdContent = readFileSync(skillMdPath, 'utf-8');
          let folderName = basename(sourcePath);
// Try to extract name from SKILL.md frontmatter
          try {
            const parsed = parseFullSkillContent(skillMdContent);
            if (parsed.frontmatter.name) {
              folderName = parsed.frontmatter.name;
            }
          } catch {
            // Use folder name as fallback
          }
// Sanitize folder name
          folderName = sanitizeFolderName(folderName);
          const targetDir = join(baseDir, folderName);
// Check if skill already exists
          if (existsSync(targetDir)) {
            return jsonResponse({ success: false, error: `技能 "${folderName}" 已存在` }, 409);
          }
// Copy folder recursively — async so the sidecar's /health probe
          // stays responsive during large imports (see copyDirRecursive doc).
          // Keeps the hidden-file / __MACOSX filter that distinguishes this
          // path from the bulk-sync variant.
          const copyImportedSkillDir = async (src: string, dest: string): Promise<void> => {
            await ensureDir(dest);
            const entries = await readdirAsync(src, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
              if (entry.isSymbolicLink()) {
                console.warn(`[api/skill/import-folder] Skipping symlink: ${join(src, entry.name)}`);
                continue;
              }
              const srcPath = join(src, entry.name);
              const destPath = join(dest, entry.name);
              if (entry.isDirectory()) {
                await copyImportedSkillDir(srcPath, destPath);
              } else {
                await copyFileAsync(srcPath, destPath);
              }
            }
          };
await copyImportedSkillDir(sourcePath, targetDir);
if (payload.scope === 'user') {
            await bumpSkillsGeneration();
            if (agentDir) { syncProjectUserConfig(agentDir); }
          }
          return jsonResponse({
            success: true,
            folderName,
            path: targetDir,
            message: `已成功导入技能 "${folderName}"`
          });
} catch (error) {
          console.error('[api/skill/import-folder] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to import skill folder' },
            500
          );
        }
      }
// ============= COMMANDS MANAGEMENT API =============
      // GET /api/command-items - List all commands
      // Supports ?agentDir= for listing commands from a specific workspace (e.g. from Launcher)
      if (pathname === '/api/command-items' && request.method === 'GET') {
        try {
          const scope = url.searchParams.get('scope') || 'all';
          const queryAgentDir = url.searchParams.get('agentDir');
          const { commandsDir: effectiveCommandsDir } = getProjectBaseDirs(queryAgentDir);
          const commandItems: Array<{
            name: string;
            fileName: string;
            description: string;
            scope: 'user' | 'project';
            path: string;
            author?: string;
          }> = [];
const scanCommands = (dir: string, scopeType: 'user' | 'project') => {
            if (!dir || !existsSync(dir)) return;
            try {
              const files = readdirSync(dir);
              for (const file of files) {
                if (!file.endsWith('.md')) continue;
                const filePath = join(dir, file);
                const content = readFileSync(filePath, 'utf-8');
                const { frontmatter } = parseFullCommandContent(content);
                const fileName = extractCommandName(file);
                commandItems.push({
                  name: frontmatter.name || fileName,  // Prefer frontmatter name
                  fileName,  // Always include actual file name for reference
                  description: frontmatter.description || '',
                  scope: scopeType,
                  path: filePath,
                  author: frontmatter.author,
                });
              }
            } catch (scanError) {
              console.warn(`[api/command-items] Error scanning ${scopeType} commands:`, scanError);
            }
          };
const resolvedProjectCommandsDir = effectiveCommandsDir || projectCommandsBaseDir;
          if ((scope === 'all' || scope === 'project') && resolvedProjectCommandsDir) {
            scanCommands(resolvedProjectCommandsDir, 'project');
          }
          if (scope === 'all' || scope === 'user') {
            scanCommands(userCommandsBaseDir, 'user');
          }
return jsonResponse({ success: true, commands: commandItems });
        } catch (error) {
          console.error('[api/command-items] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list commands' },
            500
          );
        }
      }
// GET /api/command-item/:name - Get command detail
      if (pathname.startsWith('/api/command-item/') && request.method === 'GET') {
        try {
          const cmdName = decodeURIComponent(pathname.replace('/api/command-item/', ''));
          if (!isValidItemName(cmdName)) {
            return jsonResponse({ success: false, error: 'Invalid command name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');
// Use explicit agentDir if provided for project scope
          const { commandsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userCommandsBaseDir : commandsDir;
          const cmdPath = join(baseDir, `${cmdName}.md`);
if (!existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command not found' }, 404);
          }
const content = readFileSync(cmdPath, 'utf-8');
          const { frontmatter, body } = parseFullCommandContent(content);
return jsonResponse({
            success: true,
            command: {
              name: frontmatter.name || cmdName,  // Prefer frontmatter name over file name
              fileName: cmdName,  // Always return the actual file name for reference
              path: cmdPath,
              scope,
              frontmatter,
              body,
            }
          });
        } catch (error) {
          console.error('[api/command-item] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to get command' },
            500
          );
        }
      }
// PUT /api/command-item/:name - Update command
      if (pathname.startsWith('/api/command-item/') && request.method === 'PUT') {
        try {
          const cmdName = decodeURIComponent(pathname.replace('/api/command-item/', ''));
          if (!isValidItemName(cmdName)) {
            return jsonResponse({ success: false, error: 'Invalid command name' }, 400);
          }
          const payload = await request.json() as {
            scope: 'user' | 'project';
            frontmatter: Partial<CommandFrontmatter>;
            body: string;
            agentDir?: string; // Optional: explicit project directory
            newFileName?: string; // Optional: rename file if provided
          };
// Use explicit agentDir if provided for project scope
          const { commandsDir } = getProjectBaseDirs(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userCommandsBaseDir : commandsDir;
          let currentFileName = cmdName;
          let cmdPath = join(baseDir, `${currentFileName}.md`);
if (!existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command not found' }, 404);
          }
// Handle file rename if newFileName is provided and different
          if (payload.newFileName && payload.newFileName !== currentFileName) {
            const newFileName = payload.newFileName;
// Validate new file name
            if (!isValidItemName(newFileName)) {
              return jsonResponse({ success: false, error: 'Invalid new file name' }, 400);
            }
const newCmdPath = join(baseDir, `${newFileName}.md`);
// Check for conflict
            if (existsSync(newCmdPath)) {
              return jsonResponse({ success: false, error: `指令文件 "${newFileName}.md" 已存在，请使用其他名称` }, 409);
            }
// Atomic-like operation: prepare content first, then rename
            // If rename fails, nothing is lost. If write fails after rename, file is renamed but content unchanged.
            const content = serializeCommandContent(payload.frontmatter, payload.body);
// Rename the file
            renameSync(cmdPath, newCmdPath);
            cmdPath = newCmdPath;
            currentFileName = newFileName;
// Write content to new location
            writeFileSync(cmdPath, content, 'utf-8');
// User command renamed — re-sync to fix old dangling symlink + create new one
            if (payload.scope === 'user' && agentDir) syncProjectUserConfig(agentDir);
            return jsonResponse({
              success: true,
              path: cmdPath,
              fileName: currentFileName
            });
          }
// No rename, just update content
          const content = serializeCommandContent(payload.frontmatter, payload.body);
          writeFileSync(cmdPath, content, 'utf-8');
return jsonResponse({
            success: true,
            path: cmdPath,
            fileName: currentFileName
          });
        } catch (error) {
          console.error('[api/command-item] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update command' },
            500
          );
        }
      }
// DELETE /api/command-item/:name - Delete command
      if (pathname.startsWith('/api/command-item/') && request.method === 'DELETE') {
        try {
          const cmdName = decodeURIComponent(pathname.replace('/api/command-item/', ''));
          if (!isValidItemName(cmdName)) {
            return jsonResponse({ success: false, error: 'Invalid command name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');
// Use explicit agentDir if provided for project scope
          const { commandsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userCommandsBaseDir : commandsDir;
          const cmdPath = join(baseDir, `${cmdName}.md`);
if (!existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command not found' }, 404);
          }
rmSync(cmdPath);
          // User command deleted — re-sync to remove dangling symlinks in project
          if (scope === 'user' && agentDir) syncProjectUserConfig(agentDir);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/command-item] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete command' },
            500
          );
        }
      }
// POST /api/command-item/create - Create new command
      if (pathname === '/api/command-item/create' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            name: string;
            scope: 'user' | 'project';
            description?: string;
          };
if (!payload.name) {
            return jsonResponse({ success: false, error: 'Name is required' }, 400);
          }
// Sanitize name for filename (supports Unicode characters like Chinese)
          const fileName = sanitizeFolderName(payload.name);
          const baseDir = payload.scope === 'user' ? userCommandsBaseDir : projectCommandsBaseDir;
// Ensure directory exists
          if (!existsSync(baseDir)) {
            ensureDirSync(baseDir);
          }
const cmdPath = join(baseDir, `${fileName}.md`);
if (existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command already exists' }, 409);
          }
// Create command file with default content
          const frontmatter: Partial<CommandFrontmatter> = {
            name: payload.name,
            description: payload.description || '',
          };
          const body = `在这里编写指令的详细内容...`;
          const content = serializeCommandContent(frontmatter, body);
writeFileSync(cmdPath, content, 'utf-8');
// New user command — sync symlink into project so SDK can discover it
          if (payload.scope === 'user' && agentDir) syncProjectUserConfig(agentDir);
          return jsonResponse({ success: true, path: cmdPath, name: fileName });
        } catch (error) {
          console.error('[api/command-item/create] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create command' },
            500
          );
        }
      }
// ============= SUB-AGENTS API =============
const userAgentsBaseDir = join(getZhiShiDataDir(), 'agents');
// Helper: Get project agents directory (supports explicit agentDir parameter)
      const getProjectAgentsDir = (queryAgentDir: string | null) => {
        if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
          queryAgentDir = null;
        }
        const effectiveAgentDir = queryAgentDir || currentAgentDir;
        const hasValidDir = effectiveAgentDir && existsSync(effectiveAgentDir);
        return hasValidDir ? join(effectiveAgentDir, '.claude', 'agents') : '';
      };
// Validate an agent folderName accepted by GET/PUT/DELETE /api/agent/:name.
      //
      // Unlike `isValidItemName` (which rejects '/'), agents now use a
      // path-like identity for the 'nested' layout (e.g. `team/reviewer`).
      // Security rests on two things: each segment still flows through
      // `isValidItemName` (blocking '..', '\\', Windows reserved names,
      // control chars, reserved punctuation), and findAgent() only ever
      // returns real on-disk paths produced by scanAgents — the value we
      // receive is matched by string equality against scanned folderNames,
      // never concatenated into a path.
      const isValidAgentFolderName = (name: string): boolean => {
        if (!name || name.length > 512) return false;
        if (name.includes('\\')) return false;
// eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f\x7f]/.test(name)) return false;
        for (const seg of name.split('/')) {
          if (!seg || seg === '.' || seg === '..') return false;
          if (!isValidItemName(seg)) return false;
        }
        return true;
      };
// GET /api/agents - List all agents (with scope filter)
      if (pathname === '/api/agents' && request.method === 'GET') {
        try {
          const scope = url.searchParams.get('scope') || 'all';
          const queryAgentDir = url.searchParams.get('agentDir');
          const projAgentsDir = getProjectAgentsDir(queryAgentDir);
let agents: Array<{ name: string; description: string; scope: 'user' | 'project'; path: string; folderName: string }> = [];
if ((scope === 'all' || scope === 'project') && projAgentsDir) {
            agents = agents.concat(scanAgents(projAgentsDir, 'project'));
          }
          if (scope === 'all' || scope === 'user') {
            agents = agents.concat(scanAgents(userAgentsBaseDir, 'user'));
          }
return jsonResponse({ success: true, agents });
        } catch (error) {
          console.error('[api/agents] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list agents' },
            500
          );
        }
      }
// GET /api/agent/sync-check - Check if there are agents to sync from Claude Code
      // NOTE: Must be before /api/agent/:name to avoid wildcard capture
      //
      // Driven by `scanAgents()` so the three SDK-recognised layouts (folder /
      // flat / nested) are all counted — same rule the loader uses for runtime
      // discovery. Agents that Claude Code's SDK sees but that only have a
      // top-level `.md` file (flat) or a subdirectory path (nested) used to
      // silently disappear from the sync UI; now they're first-class.
      if (pathname === '/api/agent/sync-check' && request.method === 'GET') {
        try {
          const homeDir = getHomeDirOrNull() || '';
          const claudeAgentsDir = join(homeDir, '.claude', 'agents');
          if (!existsSync(claudeAgentsDir)) {
            return jsonResponse({ canSync: false, count: 0, folders: [] });
          }
// scanAgents handles: junctions (via realpath), all 3 layouts,
          // frontmatter validation, dedup by folderName with layout priority.
          // Scope arg ('user') only affects the returned AgentItem.scope —
          // not the scan behavior.
          const claudeAgents = scanAgents(claudeAgentsDir, 'user');
if (claudeAgents.length === 0) {
            return jsonResponse({ canSync: false, count: 0, folders: [] });
          }
const zhishiAgents = scanAgents(userAgentsBaseDir, 'user');
          const zhishiSet = new Set(zhishiAgents.map(a => a.folderName));
// folderName is the canonical agent identity (e.g. "code-reviewer"
          // for flat, "team/reviewer" for nested, "novels" for folder). The
          // client passes these back to sync-from-claude, and we re-validate
          // them against scanAgents output at that time — no raw filesystem
          // name is trusted across the request boundary.
          const allFolders = claudeAgents.map(a => a.folderName);
          const newFolders = claudeAgents.filter(a => !zhishiSet.has(a.folderName)).map(a => a.folderName);
          const conflictFolders = claudeAgents.filter(a => zhishiSet.has(a.folderName)).map(a => a.folderName);
return jsonResponse({
            canSync: allFolders.length > 0,
            count: allFolders.length,
            folders: allFolders,
            newFolders,
            conflictFolders,
          });
        } catch (error) {
          console.error('[api/agent/sync-check] Error:', error);
          return jsonResponse({ canSync: false, count: 0, folders: [], error: error instanceof Error ? error.message : 'Check failed' }, 500);
        }
      }
// POST /api/agent/sync-from-claude - Sync agents from Claude Code to ZhiShi
      // NOTE: Must be before /api/agent/:name to avoid wildcard capture
      // Supports conflict handling: mode = 'skip' (default) | 'overwrite'
      //
      // Preserves the source agent's layout:
      //   folder  (.claude/agents/foo/foo.md)        → ~/.zhishi/agents/foo/foo.md  + _meta.json
      //   flat    (.claude/agents/foo.md)            → ~/.zhishi/agents/foo.md       (no _meta.json — flat has no home for it)
      //   nested  (.claude/agents/team/reviewer.md)  → ~/.zhishi/agents/team/reviewer.md  (ditto)
      //
      // Why preserve instead of canonicalize to `folder`: `nested` folderNames
      // contain `/` (e.g. "team/reviewer"), which collapses ambiguously if
      // flattened — "team/reviewer" and just "reviewer" would collide. Keeping
      // the source layout is lossless + matches Claude Code's own storage
      // convention. `scanAgents()` (loader side) already reads all three.
      if (pathname === '/api/agent/sync-from-claude' && request.method === 'POST') {
        try {
          const payload = await request.json().catch(() => ({})) as { mode?: 'skip' | 'overwrite'; folders?: string[] };
          const conflictMode = payload.mode || 'skip';
          const selectedFolders = payload.folders; // Optional: sync only these specific folderNames
          const homeDir = getHomeDirOrNull() || '';
          const claudeAgentsDir = join(homeDir, '.claude', 'agents');
          if (!existsSync(claudeAgentsDir)) {
            return jsonResponse({ success: false, synced: 0, failed: 0, skipped: 0, overwritten: 0, error: 'Claude Code agents directory not found' }, 404);
          }
// Enumerate via the same protocol-aligned scanner that sync-check uses.
          // Index by folderName so selectedFolders can only reach agents the
          // scanner actually saw — no raw-path injection across the boundary.
          const claudeAgents = scanAgents(claudeAgentsDir, 'user');
          const claudeByName = new Map(claudeAgents.map(a => [a.folderName, a]));
const foldersToSync = selectedFolders
            ? selectedFolders.filter(f => claudeByName.has(f))
            : Array.from(claudeByName.keys());
if (foldersToSync.length === 0) {
            return jsonResponse({ success: true, synced: 0, failed: 0, skipped: 0, overwritten: 0, message: 'No agents to sync' });
          }
if (!existsSync(userAgentsBaseDir)) {
            ensureDirSync(userAgentsBaseDir);
          }
let synced = 0;
          let failed = 0;
          let skipped = 0;
          let overwritten = 0;
          const errors: string[] = [];
          const conflicts: string[] = [];
for (const folderName of foldersToSync) {
            const src = claudeByName.get(folderName);
            if (!src) continue;  // defensive, already filtered above
try {
              // Conflict probe via the SAME scanner used for sync-check, so the
              // "conflict" decision is symmetric regardless of which layout the
              // existing agent lives in on our side (folder vs flat vs nested).
              const existing = findAgent(userAgentsBaseDir, 'user', folderName);
              if (existing) {
                if (conflictMode === 'skip') {
                  skipped++;
                  conflicts.push(folderName);
                  continue;
                }
                // Overwrite: delete the existing agent's own path, which may
                // be in a different layout than the source. `rm({ recursive,
                // force })` handles both file (flat/nested .md) and directory
                // (folder layout) targets. For folder layout we strip back to
                // the folder itself to avoid leaving a ghost _meta.json.
                const existingTarget = existing.layout === 'folder'
                  ? dirname(existing.path)  // the <folderName>/ directory
                  : existing.path;          // the .md file itself
                await rm(existingTarget, { recursive: true, force: true });
                overwritten++;
              }
// Compute target path from the SOURCE's layout (preserve).
              // For folder layout, copy the whole source directory (may include
              // sibling resources like README.md, data files, etc.). For
              // flat/nested, it's a single-file copy.
              if (src.layout === 'folder') {
                const srcDir = dirname(src.path);
                const destDir = join(userAgentsBaseDir, folderName);
                await copyDirRecursive(srcDir, destDir, '[api/agent/sync-from-claude]');
// Write _meta.json (only folder layout has a stable home for it).
                // Auto-generated from frontmatter.name so the UI shows a friendly
                // displayName and recognises the agent as synced via the
                // `claude-code-sync` author marker.
                const mdPath = join(destDir, `${folderName}.md`);
                const metaPath = join(destDir, '_meta.json');
                if (existsSync(mdPath) && !existsSync(metaPath)) {
                  try {
                    const content = readFileSync(mdPath, 'utf-8');
                    const { name: agentName } = parseAgentFrontmatter(content);
                    const meta = {
                      displayName: agentName || folderName,
                      author: 'claude-code-sync',
                      createdAt: new Date().toISOString(),
                      updatedAt: new Date().toISOString(),
                    };
                    writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
                  } catch { /* _meta.json generation is optional */ }
                }
              } else {
                // flat or nested: single-file copy. For nested we need to
                // `ensureDir` the parent chain (e.g. "team/" for folderName
                // "team/reviewer"). For flat the parent is userAgentsBaseDir
                // which we already ensured above.
                //
                // folderName for flat is the stem ("foo" → "foo.md"); for
                // nested it's the POSIX stem path ("team/reviewer" →
                // "team/reviewer.md"). Joining with path.join naturally
                // produces the correct OS-specific path on Windows.
                const destPath = join(userAgentsBaseDir, `${folderName}.md`);
                await ensureDir(dirname(destPath));
                await copyFileAsync(src.path, destPath);
              }
synced++;
            } catch (copyError) {
              failed++;
              errors.push(`${folderName}: ${copyError instanceof Error ? copyError.message : 'Unknown error'}`);
              console.error(`[api/agent/sync-from-claude] Failed to sync "${folderName}":`, copyError);
            }
          }
return jsonResponse({
            success: true,
            synced,
            failed,
            skipped,
            overwritten,
            conflicts,
            errors: errors.length > 0 ? errors : undefined,
          });
        } catch (error) {
          console.error('[api/agent/sync-from-claude] Error:', error);
          return jsonResponse({ success: false, synced: 0, failed: 0, error: error instanceof Error ? error.message : 'Sync failed' }, 500);
        }
      }
// POST /api/agent/create - Create new agent
      // NOTE: Must be before /api/agent/:name to avoid wildcard capture
      if (pathname === '/api/agent/create' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            name: string;
            scope: 'user' | 'project';
            description?: string;
            agentDir?: string;
          };
if (!payload.name) {
            return jsonResponse({ success: false, error: 'Name is required' }, 400);
          }
const folderName = sanitizeFolderName(payload.name);
          const agentsDir = getProjectAgentsDir(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userAgentsBaseDir : agentsDir;
if (!baseDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }
const agentFolderDir = join(baseDir, folderName);
          if (existsSync(agentFolderDir)) {
            return jsonResponse({ success: false, error: '智能体已存在' }, 409);
          }
ensureDirSync(agentFolderDir);
const frontmatter: Partial<AgentFrontmatter> = {
            name: payload.name,
            description: payload.description || `Description for ${payload.name}`,
          };
          const body = `# ${payload.name}\n\nDescribe your agent instructions here.`;
          const content = serializeAgentContent(frontmatter, body);
const agentPath = join(agentFolderDir, `${folderName}.md`);
          writeFileSync(agentPath, content, 'utf-8');
// Create default _meta.json
          writeAgentMeta(agentFolderDir, {
            displayName: payload.name,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
return jsonResponse({ success: true, path: agentPath, folderName });
        } catch (error) {
          console.error('[api/agent/create] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to create agent' }, 500);
        }
      }
// GET /api/agents/workspace-config - Read workspace agent config
      if (pathname === '/api/agents/workspace-config' && request.method === 'GET') {
        try {
          const queryAgentDir = url.searchParams.get('agentDir');
          const effectiveDir = (queryAgentDir && isValidAgentDir(queryAgentDir).valid ? queryAgentDir : currentAgentDir) || '';
          if (!effectiveDir) {
            return jsonResponse({ success: true, config: { local: {}, global_refs: {} } });
          }
          const config = readWorkspaceConfig(effectiveDir);
          return jsonResponse({ success: true, config });
        } catch (error) {
          console.error('[api/agents/workspace-config] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to read config' }, 500);
        }
      }
// PUT /api/agents/workspace-config - Update workspace agent config
      if (pathname === '/api/agents/workspace-config' && request.method === 'PUT') {
        try {
          const payload = await request.json() as { config: AgentWorkspaceConfig; agentDir?: string };
          const effectiveDir = (payload.agentDir && isValidAgentDir(payload.agentDir).valid ? payload.agentDir : currentAgentDir) || '';
          if (!effectiveDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }
          writeWorkspaceConfig(effectiveDir, payload.config);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/agents/workspace-config] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to update config' }, 500);
        }
      }
// GET /api/agents/enabled - Get enabled agents as SDK definitions
      if (pathname === '/api/agents/enabled' && request.method === 'GET') {
        try {
          const queryAgentDir = url.searchParams.get('agentDir');
          const effectiveDir = (queryAgentDir && isValidAgentDir(queryAgentDir).valid ? queryAgentDir : currentAgentDir) || '';
          const projAgentsDir = effectiveDir ? join(effectiveDir, '.claude', 'agents') : '';
          const agents = loadEnabledAgents(projAgentsDir, userAgentsBaseDir);
          return jsonResponse({ success: true, agents });
        } catch (error) {
          console.error('[api/agents/enabled] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to load agents' }, 500);
        }
      }
// POST /api/agents/set - Set agents and trigger session resume
      if (pathname === '/api/agents/set' && request.method === 'POST') {
        try {
          const payload = await request.json() as { agents: Record<string, unknown> };
          // The payload.agents is already in SDK AgentDefinition format
          setAgents(payload.agents as Record<string, import('./agent-session').AgentDefinition>);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/agents/set] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set agents' }, 500);
        }
      }
// POST /api/model/set - Set default model for this session
      if (pathname === '/api/model/set' && request.method === 'POST') {
        try {
          const payload = await request.json() as { model?: string };
          if (!payload?.model) {
            return jsonResponse({ success: false, error: 'model is required' }, 400);
          }
          setSessionModel(payload.model);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/model/set] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set model' }, 500);
        }
      }
// POST /api/provider/set - Set provider env for this session (called by Rust IM router on sidecar creation)
      if (pathname === '/api/provider/set' && request.method === 'POST') {
        try {
          const payload = await request.json() as { providerEnv?: Record<string, unknown> };
          const { setSessionProviderEnv } = await import('./agent-session');
          // Normalize null → undefined (Rust sends { "providerEnv": null } when clearing)
          setSessionProviderEnv((payload?.providerEnv ?? undefined) as import('./agent-session').ProviderEnv | undefined);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/provider/set] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set provider' }, 500);
        }
      }
// POST /api/session/permission-mode - Set permission mode for this session (called by Rust IM router)
      if (pathname === '/api/session/permission-mode' && request.method === 'POST') {
        try {
          const payload = await request.json() as { permissionMode?: string };
          if (!payload?.permissionMode) {
            return jsonResponse({ success: false, error: 'permissionMode is required' }, 400);
          }
          // M4c: SDK 会话权限模式随删——pi 引擎不按会话切权限模式,此端点只应答成功(配置面由 /api/config 管理)。
          console.log('[api/session/permission-mode] M4c: no-op (pi 引擎边界是规则,非会话权限)');
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/session/permission-mode] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set permission mode' }, 500);
        }
      }
      // GET /api/session/config - Read sidecar's current config state
      // Used by Tabs joining an existing sidecar (e.g. IM Bot session) to adopt
      // the session's config instead of pushing their own.
      if (pathname === '/api/session/config' && request.method === 'GET') {
        try {
          const { getSessionModel, getMcpServers, getAgents } = await import('./agent-session');
          const model = getSessionModel();
          const mcpServers = getMcpServers();
          const agents = getAgents();
          const permissionMode = null; // M4c: 会话权限模式随 SDK 删除
          return jsonResponse({
            success: true,
            runtime: 'builtin',
            model: model ?? null,
            mcpServerIds: mcpServers?.map(s => s.id) ?? null,
            agentNames: agents ? Object.keys(agents) : null,
            permissionMode,
          });
        } catch (error) {
          console.error('[api/session/config] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to get session config' }, 500);
        }
      }
// GET /api/agent/:name - Get agent detail
      //
      // `folderName` is the UI-facing stable id (see agent-loader.ts for its
      // computation rules). We can't hard-assemble the path as
      // `<base>/<folderName>/<folderName>.md` anymore — flat/nested layouts
      // live elsewhere — so we scan and look up by folderName, reusing
      // `AgentItem.path` / `.layout` from there.
      if (pathname.startsWith('/api/agent/') && request.method === 'GET') {
        try {
          const agentName = decodeURIComponent(pathname.replace('/api/agent/', ''));
          if (!isValidAgentFolderName(agentName)) {
            return jsonResponse({ success: false, error: 'Invalid agent name' }, 400);
          }
          const scope = (url.searchParams.get('scope') || 'project') as 'user' | 'project';
          const queryAgentDir = url.searchParams.get('agentDir');
          const agentsDir = getProjectAgentsDir(queryAgentDir);
          const baseDir = scope === 'user' ? userAgentsBaseDir : agentsDir;
const item = findAgent(baseDir, scope, agentName);
          if (!item) {
            return jsonResponse({ success: false, error: '智能体不存在' }, 404);
          }
const content = readFileSync(item.path, 'utf-8');
          const { frontmatter, body } = parseFullAgentContent(content);
return jsonResponse({
            success: true,
            agent: {
              name: frontmatter.name || item.folderName,
              folderName: item.folderName,
              path: item.path,
              scope,
              layout: item.layout,
              frontmatter,
              body,
              ...(item.meta ? { meta: item.meta } : {}),
            }
          });
        } catch (error) {
          console.error('[api/agent] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to get agent' }, 500);
        }
      }
// PUT /api/agent/:name - Update agent (with optional folder rename for
      // 'folder' layout only)
      //
      // Lookup is by (folderName, scope) via findAgent(); we never reassemble
      // the path. Rename stays restricted to the canonical 'folder' layout:
      //   - flat agents live next to siblings and would collide on rename
      //   - nested agents belong to a user-managed directory tree (Claude
      //     Code plugin, synced-in content, etc.) — renaming would mutate
      //     their container out from under them
      // Callers can relocate such agents by hand; UI should hide the rename
      // affordance when `layout !== 'folder'`.
      if (pathname.startsWith('/api/agent/') && request.method === 'PUT') {
        try {
          const agentName = decodeURIComponent(pathname.replace('/api/agent/', ''));
          if (!isValidAgentFolderName(agentName)) {
            return jsonResponse({ success: false, error: 'Invalid agent name' }, 400);
          }
          const payload = await request.json() as {
            scope: 'user' | 'project';
            frontmatter: Partial<AgentFrontmatter>;
            body: string;
            newFolderName?: string;
            agentDir?: string;
            meta?: AgentMeta;
          };
const agentsDir = getProjectAgentsDir(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userAgentsBaseDir : agentsDir;
const item = findAgent(baseDir, payload.scope, agentName);
          if (!item) {
            return jsonResponse({ success: false, error: '智能体不存在' }, 404);
          }
let currentFolderName = item.folderName;
          let agentPath = item.path;
          let agentFolderDir = dirname(item.path);
// Rename is only meaningful for the 'folder' layout
          if (payload.newFolderName && payload.newFolderName !== currentFolderName) {
            if (item.layout !== 'folder') {
              return jsonResponse({
                success: false,
                error: `当前智能体布局为 ${item.layout}，不支持重命名。请手动调整文件结构后再试。`,
              }, 400);
            }
            const newFolderName = payload.newFolderName;
            if (!isValidItemName(newFolderName)) {
              return jsonResponse({ success: false, error: 'Invalid new folder name' }, 400);
            }
            const newAgentDir = join(baseDir, newFolderName);
            if (existsSync(newAgentDir)) {
              return jsonResponse({ success: false, error: `智能体文件夹 "${newFolderName}" 已存在，请使用其他名称` }, 409);
            }
const content = serializeAgentContent(payload.frontmatter, payload.body);
            renameSync(agentFolderDir, newAgentDir);
            agentFolderDir = newAgentDir;
            currentFolderName = newFolderName;
// Rename the .md file inside to match new folder name
            const oldMdPath = join(agentFolderDir, `${item.folderName}.md`);
            agentPath = join(agentFolderDir, `${newFolderName}.md`);
            if (existsSync(oldMdPath)) {
              renameSync(oldMdPath, agentPath);
            }
writeFileSync(agentPath, content, 'utf-8');
            const existingMeta = readAgentMeta(agentFolderDir);
            const updatedMeta = { ...existingMeta, ...payload.meta, displayName: payload.frontmatter.name || newFolderName, updatedAt: new Date().toISOString() };
            writeAgentMeta(agentFolderDir, updatedMeta);
            return jsonResponse({ success: true, path: agentPath, folderName: currentFolderName });
          }
// No rename — update content in place regardless of layout
          const content = serializeAgentContent(payload.frontmatter, payload.body);
          writeFileSync(agentPath, content, 'utf-8');
// _meta.json only lives next to 'folder' layout agents. For flat /
          // nested, skip — there's no unambiguous place for it.
          if (item.layout === 'folder') {
            const existingMeta = readAgentMeta(agentFolderDir);
            if (payload.meta || (payload.frontmatter.name && payload.frontmatter.name !== existingMeta?.displayName)) {
              const updatedMeta = { ...existingMeta, ...payload.meta, updatedAt: new Date().toISOString() };
              if (payload.frontmatter.name) updatedMeta.displayName = payload.frontmatter.name;
              writeAgentMeta(agentFolderDir, updatedMeta);
            }
          }
          return jsonResponse({ success: true, path: agentPath, folderName: currentFolderName });
        } catch (error) {
          console.error('[api/agent] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to update agent' }, 500);
        }
      }
// DELETE /api/agent/:name - Delete agent
      //
      // Deletion shape depends on layout:
      //   - folder: remove the whole <base>/<folderName>/ directory
      //   - flat:   remove the single <base>/<folderName>.md file
      //   - nested: remove only the .md file, leave the surrounding directory
      //             structure alone (it's user- or plugin-managed)
      if (pathname.startsWith('/api/agent/') && request.method === 'DELETE') {
        try {
          const agentName = decodeURIComponent(pathname.replace('/api/agent/', ''));
          if (!isValidAgentFolderName(agentName)) {
            return jsonResponse({ success: false, error: 'Invalid agent name' }, 400);
          }
          const scope = (url.searchParams.get('scope') || 'project') as 'user' | 'project';
          const queryAgentDir = url.searchParams.get('agentDir');
          const agentsDir = getProjectAgentsDir(queryAgentDir);
          const baseDir = scope === 'user' ? userAgentsBaseDir : agentsDir;
const item = findAgent(baseDir, scope, agentName);
          if (!item) {
            return jsonResponse({ success: false, error: '智能体不存在' }, 404);
          }
if (item.layout === 'folder') {
            rmSync(dirname(item.path), { recursive: true, force: true });
          } else {
            rmSync(item.path, { force: true });
          }
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/agent] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to delete agent' }, 500);
        }
      }
// ============= END SLASH COMMANDS API =============
// ============= OPENAI BRIDGE (Loopback, per-token) =============
      // M4c: /bridge/* 端点已随 openai-bridge 删除(OpenAI 协议由 pi 直连)。
const staticResponse = await serveStatic(pathname);
      if (staticResponse) {
        return staticResponse;
      }
return new Response('Not Found', { status: 404 });
    }
  }
// The same HTTP server serves both purposes — Tauri client proxies all
  // /api/* + /sessions/* + /chat/stream traffic here via Rust local_http;
  // browser dev mode (`./scripts/dev/start_dev.sh`) additionally hits the `serveStatic`
  // fallback to load the React `dist/` bundle. Naming reflects the
  // production primary role.
  console.log(`[startup] Sidecar HTTP server ready on http://127.0.0.1:${port}`);
// Pattern 2 §2.3.1 — Start the periodic GC for spilled large-value refs.
  // Runs every 60s; reaps any ref past its TTL (default 1h). The timer is
  // unref'd inside startRefsGc, so it doesn't keep the event loop alive.
  void import('./utils/large-value-store').then(({ startRefsGc }) => {
    startRefsGc(60_000);
  }).catch((err) => {
    console.warn(`[refs] failed to start GC: ${err instanceof Error ? err.message : String(err)}`);
  });
// ── Deferred heavy init ─────────────────────────────────────────────────
  // Runs AFTER honoServe has bound the port. Rust's TCP health check now
  // passes within ~50ms instead of waiting ~2s for all this work to finish.
  // Routes (except /health) `await __zhishiDeferredInit` before running,
  // so correctness is preserved: anything that needs agent state (MCP,
  // model, file watcher, bridge) waits for this block to finish.
  //
  // Order within this block still matters:
  //   1. migrations/cleanup — best-effort, can interleave
  //   2. socks bridge BEFORE initializeAgent (pre-warm spawns SDK which
  //      reads HTTP_PROXY env vars set by initSocksBridgeFromEnv)
  //   3. initializeAgent — the big one
  //   4. boot banner — prints with fully resolved state
  // Pattern 4: track which phase is running so /health/ready can report
  // {phase: 'migration' | 'skill-seed' | 'sdk-init' | ...} on failure.
  let currentInitPhase = 'startup';
  const deferredInitStarted = nowMs();
  let initPhaseStarted = deferredInitStarted;
  const emitDeferredPhaseDone = (phase: string) => {
    emitPerfTrace({
      trace: 'sidecar_boot',
      phase: 'deferred_init_phase_done',
      durationMs: elapsedMs(initPhaseStarted),
      status: 'ok',
      detail: { phase, port },
    });
  };
  emitPerfTrace({
    trace: 'sidecar_boot',
    phase: 'deferred_init_start',
    status: 'ok',
    detail: { port, sessionId: initialSessionId ?? 'new' },
  });
  (async () => {
    try {
      currentInitPhase = 'cleanup';
      setDeferredInitPhase(currentInitPhase);
      initPhaseStarted = nowMs();
      // 1.4.6 环境坑防护：better-sqlite3 ABI 启动探测——系统 node 起 sidecar
      // 时（137/127 不匹配）research_log/记忆库/情报库全挂,启动即显式报错,
      // 不再等第一次调用才暴雷（cJSON dogfood 第 2 轮实证）。
      {
        const { probeSqliteAvailable } = await import('./memory/store');
        const probe = probeSqliteAvailable();
        if (!probe.ok) {
          console.error(
            `[boot] better-sqlite3 不可用：${probe.error} —— research_log / 记忆库 / 情报库调用将全部报错。` +
              '请用内置 Node 启动 sidecar（src-tauri/resources/nodejs/node.exe 或安装版 nodejs/node.exe——' +
              'sqlite-runtime 预编译按内置 Node ABI 构建，系统 Node 与其不匹配）。',
          );
        }
      }
      // Unified retention sweep (#121) — replaces v0.2.7's split between
      // cleanupOldLogs (per-session) + cleanupOldUnifiedLogs (unified). One
      // policy module covers age cutoff, byte budget, and the recent-data
      // floor across all sources. Per-session logs gained a byte budget
      // here for the first time.
      //
      // The active-file set protects BOTH the unified log we're appending
      // to AND the per-session log file (if AgentLogger has one open) from
      // budget eviction — without this, a long-lived session log past the
      // 7-day floor could be unlinked while the WriteStream is still open.
      const collectActivePaths = (): ReadonlySet<string> => {
        const paths = new Set<string>();
        const u = getActiveUnifiedLogPath();
        if (u) paths.add(u);
        const s = getActiveSessionLogPath();
        if (s) paths.add(s);
        return paths;
      };
      runLogRetentionSweep({ activeFilePaths: collectActivePaths() });
      // Hourly background sweep — bounds gradual growth without waiting
      // for the next 50MB rotation event. Active-file getter is invoked
      // at each sweep so day-rollovers are reflected.
      startPeriodicSweep(collectActivePaths);
      cleanupStalePlaywrightProfile();
// Issue #194 follow-up — one-time scrub for stale agent.runtimeConfig
      // fields from before buildRuntimeChangePatch existed. Idempotent via
      // per-agent `_runtimeConfigScrubV1` marker; subsequent boots short-
      // circuit per agent. See doc comment in the migration module.
      try {
        const { scrubStaleRuntimeConfig } = await import('./migrations/scrub-stale-runtime-config');
        const result = await scrubStaleRuntimeConfig();
        if (result.scannedAgents > 0) {
          console.log(`[migration] runtimeConfig scrub: scanned=${result.scannedAgents} scrubbed=${result.scrubbedAgents}`);
          for (const d of result.details) {
            console.log(`[migration] runtimeConfig scrub: agent=${d.agentId} runtime=${d.runtime} dropped=${JSON.stringify(d.dropped)}`);
          }
        }
      } catch (err) {
        console.warn('[migration] runtimeConfig scrub failed (non-fatal):', err instanceof Error ? err.message : String(err));
      }
      emitDeferredPhaseDone('cleanup');
currentInitPhase = 'skill-seed';
      setDeferredInitPhase(currentInitPhase);
      initPhaseStarted = nowMs();
      await seedBundledSkills();
      seedEnvironmentRecipes();
      console.log('[startup] seedBundledSkills done');
// 1.2.1 专家知识层：bundled-expert 幂等导入 expert.db（按 content_hash；
      // 内置条目强制覆盖，user/promoted 条目绝不动）。失败不阻塞启动。
      try {
        const seedResult = seedBundledExpert();
        console.log(`[startup] seedBundledExpert done (inserted=${seedResult.inserted} updated=${seedResult.updated} unchanged=${seedResult.unchanged} errors=${seedResult.errors.length})`);
        for (const seedErr of seedResult.errors) {
          console.warn(`[startup] seedBundledExpert: ${seedErr}`);
        }
      } catch (err) {
        console.warn('[startup] seedBundledExpert failed (non-fatal):', err instanceof Error ? err.message : String(err));
      }
// 蒸馏弧（宪章 §4.2）— 幂等播种内置 recurring cron 任务「蒸馏弧」
      // （每小时）与「安全蒸馏弧」（D3，每 6 小时）。fire-and-forget：
      // management API 未就绪或播种失败都不阻塞启动，下次 sidecar 启动会重试。
      void import('./memory/distill-runner')
        .then(async (m) => {
          await m.seedDistillArcTask(currentAgentDir);
          // 安全蒸馏弧（D3）：同一哨兵模式的独立弧，6 小时节奏，一并幂等播种。
          await m.seedResearchDistillArcTask(currentAgentDir);
        })
        .catch((err) => console.warn('[distill] seed failed (non-fatal):', err instanceof Error ? err.message : err));
// #296 — install the backend auto-title trigger into the turn-hooks slot
      // BEFORE any turn can complete (initializeAgent / pre-warm run below).
      installAutoTitleHook();
emitDeferredPhaseDone('skill-seed');
currentInitPhase = 'socks-bridge';
      setDeferredInitPhase(currentInitPhase);
      initPhaseStarted = nowMs();
      await initSocksBridgeFromEnv();
      emitDeferredPhaseDone('socks-bridge');
currentInitPhase = 'sdk-init';
      setDeferredInitPhase(currentInitPhase);
      initPhaseStarted = nowMs();
      await initializeAgent(currentAgentDir, initialPrompt, initialSessionId);
      console.log('[startup] initializeAgent done');
      // M4a — pi 引擎外壳初始化(env 锚定按工作区读 env-selection.json;
      // M4b 起为 async:pi 引擎下续接最近的 loop 会话)。
      await initPiChatEngine(currentAgentDir);
      console.log(`[startup] loop engine: ${isPiEngine() ? 'pi (M4c 默认)' : 'sdk (default)'}`);
      emitDeferredPhaseDone('sdk-init');
// M4d — MCP bridge:连接全部启用的 MCP server 供 loop 工具集使用。
      // 单个 server 连接失败不抛(记入桥状态),整段非致命——桥挂了只影响
      // MCP 工具可用性,sidecar 其余能力不受影响。
      currentInitPhase = 'mcp-bridge';
      setDeferredInitPhase(currentInitPhase);
      initPhaseStarted = nowMs();
      try {
        await initMcpBridge();
        console.log('[startup] MCP bridge ready');
      } catch (err) {
        console.warn(`[startup] MCP bridge init failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
      emitDeferredPhaseDone('mcp-bridge');
// ── Sidecar Boot Banner: single-line for AI grep ──
      {
        const model = getSessionModel() || '?';
        const mcpList = getMcpServers();
        const mcpNames = mcpList ? Object.keys(mcpList).join(',') || 'none' : 'none';
        const bridge = 'no'; // M4c: openai-bridge 已删除
        // Health signal: surface which builtin MCP META ids are registered.
        // An empty list ('none') is expected when no user-toggleable builtins
        // are registered (the gemini-image / edge-tts builtins were removed).
        const { listBuiltinMcpIds } = await import('./tools/builtin-mcp-registry');
        const builtinMcpMeta = listBuiltinMcpIds().join(',') || 'none';
        console.log(`[boot] pid=${process.pid} port=${port} node=${process.versions.node} workspace=${currentAgentDir} session=${initialSessionId ?? 'new'} resume=${!!initialSessionId} model=${model} bridge=${bridge} mcp=${mcpNames} builtin-mcp-meta=${builtinMcpMeta}`);
      }
markDeferredInitReady();
      resolveDeferredInit();
      emitPerfTrace({
        trace: 'sidecar_boot',
        phase: 'deferred_init_done',
        durationMs: elapsedMs(deferredInitStarted),
        status: 'ok',
        detail: { port, sessionId: initialSessionId ?? 'new' },
      });
    } catch (err) {
      console.error('[startup] Deferred init failed:', err);
      console.warn(`[health-state] Deferred init failed in phase=${currentInitPhase}: ${err instanceof Error ? err.message : String(err)}`);
      emitPerfTrace({
        trace: 'sidecar_boot',
        phase: 'deferred_init_failed',
        durationMs: elapsedMs(deferredInitStarted),
        status: 'error',
        detail: {
          phase: currentInitPhase,
          port,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      // Pattern 4: capture the phase for /health/ready's structured 503.
      // retryable=false until we have a real re-runner (TODO above).
      markDeferredInitFailed(currentInitPhase, err, false);
      rejectDeferredInit(err);
      // Don't re-throw — the server stays up so /health/* keeps responding
      // and the renderer can render the failure state instead of timing out.
    }
  })();
// Kick off interactive-shell PATH detection in the background.
  // `warmupShellPath()` uses async `execFile` so it never blocks the event loop
  // (unlike the old `execSync` path, which starved TCP accept for 3–5s while
  // zsh -i -l sourced a heavy .zshrc — Rust's sidecar health check would retry
  // 15× before finally connecting).
  //
  // Startup returns immediately; detected PATH is applied whenever the shell
  // finishes. `getShellEnv()` keeps returning the platform fallback PATH until
  // then — sufficient for common binary lookups (.zhishi/bin, homebrew, nvm,
  // fnm, volta, pnpm, cargo all in fallback).
  import('./utils/shell').then(({ warmupShellPath, getShellPath }) => {
    warmupShellPath().then(() => {
      console.log('[server] Startup PATH:', getShellPath());
    });
  });
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
