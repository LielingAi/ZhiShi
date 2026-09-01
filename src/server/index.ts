import { appendFileSync, existsSync } from 'fs';
import { stat } from 'fs/promises';
import { fileResponse, sniffMime } from './utils/file-response';
import { serve as honoServe } from '@hono/node-server';
import { isAbsolute, join, resolve, sep } from 'path';
import { getZhiShiDataDir } from './utils/app-dirs';
import { randomUUID } from 'crypto';
import { elapsedMs, emitPerfTrace, nowMs } from './utils/perf-trace';
import { scanAgents } from './agents/agent-loader';
import { ensureDirSync, ensureDir } from './utils/fs-utils';
import { handleCronExecuteSync } from './cron/routes';
import {
  handleDeleteSession,
  handleForkSession,
  handleGetSession,
  handleListSessions,
  handlePatchSession,
  handleSwitchSession,
} from './routes/sessions';
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
  setSessionModel,
  setSidecarPort,
  getSessionModel,
  initSocksBridgeFromEnv,
} from './agent-session';
import { getHomeDirOrNull } from './utils/platform';
import { atomicModifyConfig, findEffectiveProvider, getAllEffectiveProviders, isProviderDisabled, loadConfig, resolveKimiApiKey } from './utils/admin-config';
// 1.3.7 场景 1：存量 vm 环境条目「实例即环境」一次性迁移（幂等，失败不炸启动）。
import { runLegacyVmEntryMigration } from './environment/vm-entry-migration';
import { initLogger, withLogContext, setStdioBrokenProbe } from './logger';
// `isStdioBroken` / `markStdioBroken` live in ./crash-log (extracted from the
// crash-diagnostics block above) and are consumed by `setStdioBrokenProbe`
// below to wire the logger's safe-write wrapper to the stdio-state bit.
// (1.5.4: 曾经的 `export { isStdioBroken, markStdioBroken }` 再导出零消费方,已删。)
import { installCrashDiagnostics, isStdioBroken, markStdioBroken } from './crash-log';
import {
  buildGateResponseBody,
  buildReadyResponseBody,
  markDeferredInitFailed,
  markDeferredInitReady,
  setDeferredInitPhase,
} from './readiness-state';
import { getActiveUnifiedLogPath } from './UnifiedLogger';
import { getActiveSessionLogPath } from './AgentLogger';
import { runLogRetentionSweep, startPeriodicSweep } from './log-retention';
import { broadcast, createSseClient, getClients } from './sse';
import {
  isPiEngine,
  initPiChatEngine,
  sendPiChatMessage,
  stopPiChat,
  resetPiChat,
  rewindPiChat,
  cancelPiQueueItem,
  getPiQueueStatus,
  getPiQueueSnapshotEvents,
  getPiAgentState,
  getPiMessages,
  getPiStreamingAssistantId,
  getPiSystemInitInfo,
  // 1.3.2 决策面板:注入 + 当前线只读快照(boundary 应答落盘 transcript 用)。
  injectPiDecision,
  getPiCurrentSessionRef,
  // 1.3.10 C2:/chat/send 错误文本 → 状态码(配置缺失 400,其余 429)。
  chatSendErrorStatus,
} from './loop/chat-engine';
import { buildLoopTranscript } from './loop/transcript';
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
// M4c: openai-bridge 已删除(OpenAI 协议 provider 由 pi 原生直连)。
// M4c: bridge-cache 随 bridge 删除。
// 1.5.4: 原注释指向的 /api/title-generate 动态导入路由已不存在——标题生成
// 全部走 session-title-service 的后端 turn 钩子（installAutoTitleHook，
// 在 deferred init 里安装）。
import { installAutoTitleHook } from './session-title-service';
import type { ImagePayload } from '../shared/types/image';
import type { RuntimeConfig } from '../shared/types/runtime';
export type PermissionMode = 'auto' | 'plan' | 'fullAgency' | 'custom';
type SendMessagePayload = {
  text?: string;
  images?: ImagePayload[];
  permissionMode?: PermissionMode;
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
// Extracted to ./skills-config (1.1.7 ③)；1.5.1 起只剩环境配方 seed 与
// Playwright 锁清理（skills seed/配置写侧随注入面瘦身删除）。
// ============= END SKILLS CONFIG & SEED =============
import { cleanupStalePlaywrightProfile, seedEnvironmentRecipes, seedToolSkills } from './skills-config';
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
  if (route === 'environment/setup') return await api.handleEnvironmentSetup(payload as Parameters<typeof api.handleEnvironmentSetup>[0]);
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
  if (route === 'intel/search') return await api.handleIntelSearch(payload as Parameters<typeof api.handleIntelSearch>[0]);
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
const currentAgentDir = await ensureAgentDir(agentDir);
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
   *   - Zero SSE clients is a normal, handled state: broadcast() to an empty
   *     client set is a no-op (cron/IM turns run headless this way constantly),
   *     so there is no "chunks nobody reads" leak.
   *
   * The one residual gap — a leaked `Tab` owner after an abnormal renderer/SSE
   * death keeping an event-emitting turn alive — is a stale-owner /
   * renderer-health problem to solve with owner leases or tab cleanup,
   * NOT by making SSE disconnect a cancellation signal.
   */
/**
   * Original Hono fetch body, unchanged except for being moved into a named
   * function so the outer wrapper can run inside `withLogContext`.
   */
  async function handleRequest(request: Request): Promise<Response> {
    {
      const url = new URL(request.url);
      const pathname = url.pathname;
// Skip logging high-frequency polling paths to reduce unified log noise.
      // /health 每 15s 探活、/sessions 历史面板轮询,零诊断价值。
      const SILENT_PATHS = new Set([
        '/health', '/sessions',
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
// 🩺 Health check endpoints - used by Rust sidecar manager.
      //
      //   - /health         → liveness (TCP bind succeeded)
      //   - /health/ready   → deferred init complete; structured 503 + phase
      //                       while pending or failed
      //
      // (1.5.4: /health/live 与 /health/functional 已删——Rust 只调上面两条,
      //  全仓零消费方。)
      // Both bypass the deferred-init gate below — they MUST respond
      // immediately, otherwise probes can't distinguish "still warming up"
      // from "wedged".
      if (pathname === '/health' && request.method === 'GET') {
        return jsonResponse({ status: 'ok', timestamp: Date.now() });
      }
      if (pathname === '/health/ready' && request.method === 'GET') {
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
      // All other routes depend on agent state (currentAgentDir, session
      // metadata). Pattern 4: instead of awaiting
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
// Session state endpoint - used by Rust background completion polling
      if (pathname === '/api/session-state' && request.method === 'GET') {
        const sessionState = getPiAgentState().sessionState;
        return jsonResponse({ sessionState });
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
              // kimi preset 已就位（1.5.6）——这里的放行只服务无 provider 定义的
              // kimi 系模糊 id（如自定义的 moonshot-coding 无文件形态）；
              // resolveLoopModel 同样放行,保持一致的宽松语义。
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
// Get queue status
      if (pathname === '/chat/queue/status' && request.method === 'GET') {
        // M4b — pi 引擎队列。
        if (isPiEngine()) {
          return jsonResponse({ success: true, queue: getPiQueueStatus() });
        }
        return jsonResponse({ success: true, queue: getPiQueueStatus() });
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
        // 1.5.4(A2-4): 跨线注入(决策来自 cron invoke 等 headless 线)会经
        // invokePiSession 同步跑完整个 agent turn——分钟级。HTTP 应答不能挂起
        // 这么久:120s 内注入完成则如实回报;超时按「已受理、后台注入」返回
        // (decision-resolved 已广播,注入 promise 在后台续跑续存,不被中断)。
        const DECISION_INJECT_TIMEOUT_MS = 120_000;
        let injectTimer: ReturnType<typeof setTimeout> | undefined;
        const injectTimeout = new Promise<null>((resolveRace) => {
          injectTimer = setTimeout(() => resolveRace(null), DECISION_INJECT_TIMEOUT_MS);
          injectTimer.unref?.();
        });
        const injected = await Promise.race([
          injectPiDecision({
            decisionId: d.decisionId,
            sessionId: d.sessionId,
            question: d.question,
            choice,
            note: d.note,
            expertRefs: d.expertRefs,
          }),
          injectTimeout,
        ]);
        clearTimeout(injectTimer);
        if (injected === null) {
          console.warn(`[chat/decision/respond] 注入超过 ${DECISION_INJECT_TIMEOUT_MS}ms,按已受理返回(后台续跑) decisionId=${decisionId}`);
          return jsonResponse({
            success: true,
            data: { decisionId, injected: false, injectionPending: true },
          });
        }
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
      // Handler extracted to ./cron/routes (1.1.7 ③ — pure move).
      // (1.5.4: /cron/execute 与 /cron/check-completion 已删——Rust 调度器只调
      //  execute-sync,全仓零消费方。)
      // POST /cron/execute-sync - Execute a scheduled task synchronously
      // This endpoint is used by Rust for direct Sidecar invocation without frontend
      // It waits for the execution to complete and returns the result
      if (pathname === '/cron/execute-sync' && request.method === 'POST') {
        return await handleCronExecuteSync(request, jsonResponse);
      }
// ============= SESSION API =============
      // Handlers extracted to ./routes/sessions (1.1.7 ③ — pure move);
      // `jsonResponse`/`pathname`/`url` are passed in as params.
      // (1.5.4 死路由清理:POST /sessions、/sessions/:id/since/:lastMessageId、
      //  /sessions/:id/stats、/api/generate-session-title 已删——全仓零调用,
      //  标题已全走 session-title-service 后端钩子。)
      // GET /sessions - List all sessions or filter by agentDir
      if (pathname === '/sessions' && request.method === 'GET') {
        return await handleListSessions(url, jsonResponse);
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
      // ============= END SESSION API =============
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
// ============= END SUB-AGENTS API =============
// (1.5.4 死路由清理:rules/command-items/agent 文件管理面整区已删,全仓零调用。)
// ============= OPENAI BRIDGE (Loopback, per-token) =============
      // M4c: /bridge/* 端点已随 openai-bridge 删除(OpenAI 协议由 pi 直连)。
const staticResponse = await serveStatic(pathname);
      if (staticResponse) {
        return staticResponse;
      }
return new Response('Not Found', { status: 404 });
    }
  }
// Tauri 客户端经 Rust local_http 代理全部 /api/* + /sessions/* +
  // /chat/stream 流量到这里;`serveStatic` 兜底只服务 placeholder 占位页
  // (P4 减法后 renderer 已删,见 serveStatic 注释),告诉误开浏览器的人
  // GUI 已不存在。
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
      seedEnvironmentRecipes();
      console.log('[startup] seedEnvironmentRecipes done');
      // 1.5.1：工具侧技能本体分发（agent-browser/download-anything/zhishi-cli/
      // range-ops——注入层已删，本体分发通道保留）。失败不阻塞启动。
      try {
        seedToolSkills();
        console.log('[startup] seedToolSkills done');
      } catch (err) {
        console.warn('[startup] seedToolSkills failed (non-fatal):', err);
      }
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
// ── Sidecar Boot Banner: single-line for AI grep ──
      {
        const model = getSessionModel() || '?';
        const bridge = 'no'; // M4c: openai-bridge 已删除
        // Health signal: surface which builtin MCP META ids are registered.
        // An empty list ('none') is expected when no user-toggleable builtins
        // are registered (the gemini-image / edge-tts builtins were removed).
        const { listBuiltinMcpIds } = await import('./tools/builtin-mcp-registry');
        const builtinMcpMeta = listBuiltinMcpIds().join(',') || 'none';
        console.log(`[boot] pid=${process.pid} port=${port} node=${process.versions.node} workspace=${currentAgentDir} session=${initialSessionId ?? 'new'} resume=${!!initialSessionId} model=${model} bridge=${bridge} builtin-mcp-meta=${builtinMcpMeta}`);
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
