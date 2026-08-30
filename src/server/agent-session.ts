/**
 * agent-session.ts — 会话运行时(M4c 裁留版)。
 *
 * M4c(D25 终章)删除了 Claude Agent SDK 引擎:原 21.6k 行模块里的
 * SDK query 主路径、messageGenerator/enqueue 排队机、mid-turn 注入、
 * canUseTool 回调链、SDK hooks(PreToolUse/PostToolUse/PermissionRequest)、
 * buildClaudeSessionEnv/resolveClaudeCodeCli/CLI 子进程生命周期、
 * rewindFiles/fork 的 SDK 依赖、permission:request 交互体系,全部退役。
 * 聊天会话由 pi 引擎承载(src/server/loop/chat-engine.ts)。
 *
 * 本文件裁留**配置面/元数据面**——pi 引擎与各子系统仍在复用的部分:
 *
 *   - ProviderEnv / PermissionMode / AgentDefinition 等共享类型
 *   - sidecar 端口、交互 scenario(配置面状态)
 *   - 会话模型/provider env 状态(distill/cron/title 读取)
 *   - MCP server / sub-agent 定义的进程内存储(admin CRUD 的状态镜像;
 *     注:M4c 后无运行时消费者——pi 引擎不挂 MCP,保留为配置面)
 *   - 代理/SOCKS5 bridge(setProxyConfig/initSocksBridgeFromEnv——影响
 *     进程级 fetch 出网,pi 与探针共用)
 *   - syncProjectUserConfig(skills/commands 软链同步)
 *   - cron 派发互斥锁(withCronDispatchLock)
 *   - initializeAgent(瘦版:工作区配置自解析 + 状态初始化,无 SDK 预热)
 *   - getSessionId/setActiveSessionId(当前会话标识,pi 引擎绑定时写入)
 *   - waitForSessionIdle(等 pi 引擎空闲,cron 同步派发用)
 *   - getHistoricalSessionMessages(会话历史读取,SessionStore/loop  backed)
 *
 * 依赖方向:本文件不 import loop/chat-engine(等待语义经轮询
 * chat-engine 暴露的状态,由 index.ts 注入 avoid cycle——见
 * waitForSessionIdle 的 idleProbe 参数)。
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ModelAliases } from '../shared/config-types';
import { getZhiShiDataDir } from './utils/app-dirs';
import { ensureDirSync, isDirEntry } from './utils/fs-utils';
import { isSkillBlockedOnPlatform } from './utils/platform';
import { startSocksBridge } from './utils/socks-bridge';
import { getSessionMetadata } from './SessionStore';
import type { InteractionScenario } from './system-prompt';

export type { InteractionScenario };

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

// Permission mode types - UI values
export type PermissionMode = 'auto' | 'plan' | 'fullAgency' | 'custom';

/** Provider environment for a model call(一次性调用与会话解析共用)。 */
export type ProviderEnv = {
  baseUrl?: string;
  apiKey?: string;
  authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
  apiProtocol?: 'anthropic' | 'openai';
  maxOutputTokens?: number;
  maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  upstreamFormat?: 'chat_completions' | 'responses';
  /** Model alias mapping:SDK 时代的子代理别名,M4c 后仅作配置面资产 */
  modelAliases?: ModelAliases;
};

/**
 * Sub-agent definition(配置面)。M4c 前来自 SDK 包的同名类型;
 * pi 引擎的 delegate_task(subagent.ts)不消费它,保留给 admin/配置 CRUD。
 */
export type AgentDefinition = {
  description?: string;
  prompt?: string;
  tools?: string[];
  model?: string;
};

// ---------------------------------------------------------------------------
// Data dir helper
// ---------------------------------------------------------------------------

export function getZhiShiUserDir(): string {
  // Use the unified data directory resolver (respects ZHISHI_DATA_DIR
  // for USB portable mode). Falls back to home/.zhishi via getZhiShiDataDir().
  return getZhiShiDataDir();
}

// ---------------------------------------------------------------------------
// Sidecar port
// ---------------------------------------------------------------------------

let sidecarPort = 0;

export function setSidecarPort(port: number): void {
  sidecarPort = port;
  if (port > 0) {
    process.env.ZHISHI_PORT = String(port);
  }
}

/** Get the current sidecar port (used by admin-api for self-loopback) */
export function getSidecarPort(): number {
  return sidecarPort;
}

// ---------------------------------------------------------------------------
// Active session identity(配置面;pi 引擎绑定时经 setActiveSessionId 写入)
// ---------------------------------------------------------------------------

let activeSessionId: string = randomUUID();

export function getSessionId(): string {
  return activeSessionId;
}

/** pi 引擎绑定/切换/重置会话时写入;initializeAgent 初始化时置新。 */
export function setActiveSessionId(id: string): void {
  activeSessionId = id;
}

// ---------------------------------------------------------------------------
// Session model / provider env state(distill/cron/title 读取)
// ---------------------------------------------------------------------------

let currentModel: string | undefined = undefined;
let currentProviderEnv: ProviderEnv | undefined = undefined;

export function setSessionModel(model: string): void {
  currentModel = model;
}

export function getSessionModel(): string | undefined {
  return currentModel;
}

export function setSessionProviderEnv(providerEnv: ProviderEnv | undefined): void {
  currentProviderEnv = providerEnv;
}

export function getSessionProviderEnv(): ProviderEnv | undefined {
  return currentProviderEnv;
}

// ---------------------------------------------------------------------------
// Interaction scenario(配置面状态;pi 引擎 system prompt 固定,scenario
// 仅作 cron/IM 上下文标记保留)
// ---------------------------------------------------------------------------

let currentScenario: InteractionScenario = { type: 'desktop' };

export function setInteractionScenario(scenario: InteractionScenario): void {
  currentScenario = scenario;
}

export function resetInteractionScenario(): void {
  currentScenario = { type: 'desktop' };
}

export function getInteractionScenario(): InteractionScenario {
  return currentScenario;
}

// ---------------------------------------------------------------------------
// Sub-agent definitions(进程内配置镜像)
// ---------------------------------------------------------------------------

let currentAgentDefinitions: Record<string, AgentDefinition> | null = null;

export function setAgents(agents: Record<string, AgentDefinition>): void {
  currentAgentDefinitions = agents;
}

export function getAgents(): Record<string, AgentDefinition> | null {
  return currentAgentDefinitions;
}

// ---------------------------------------------------------------------------
// Proxy / SOCKS5 bridge(进程级出网配置,pi 与探针共用)
// ---------------------------------------------------------------------------

/** Shared NO_PROXY value — comprehensive list of localhost addresses to bypass proxy */
const PROXY_NO_PROXY_VAL = 'localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1,[::1]';

const PROXY_VARS_LIST = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
                         'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'] as const;

// Capture system proxy state at sidecar startup (before any setProxyConfig call),
// so setProxyConfig(disabled) restores the inherited state instead of force-clearing.
const proxyWasInjectedByRust = process.env.ZHISHI_PROXY_INJECTED === '1';
delete process.env.ZHISHI_PROXY_INJECTED;

const inheritedProxySnapshot: Record<string, string | undefined> = {};
if (!proxyWasInjectedByRust) {
  for (const v of PROXY_VARS_LIST) {
    inheritedProxySnapshot[v] = process.env[v];
  }
}

let proxyConfigGeneration = 0; // Guards against stale async SOCKS5 callbacks

function applyProxyEnvVars(proxyUrl: string, noProxyVal: string): void {
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.http_proxy = proxyUrl;
  process.env.https_proxy = proxyUrl;
  process.env.NO_PROXY = noProxyVal;
  process.env.no_proxy = noProxyVal;
  delete process.env.ALL_PROXY;
  delete process.env.all_proxy;
}

export function setProxyConfig(proxySettings: {
  enabled: boolean;
  protocol?: string;
  host?: string;
  port?: number;
} | null): void {
  const PROXY_VARS = [...PROXY_VARS_LIST];
  const generation = ++proxyConfigGeneration;
  const oldProxyUrl = process.env.HTTP_PROXY || '';
  const rawProxyUrl = proxySettings?.enabled
    ? `${proxySettings.protocol || 'http'}://${proxySettings.host || '127.0.0.1'}:${proxySettings.port || 7890}`
    : '';
  const isSocks5 = proxySettings?.protocol === 'socks5';

  if (proxySettings?.enabled) {
    if (isSocks5) {
      // SOCKS5: start bridge asynchronously, set env vars after bridge is ready
      const host = proxySettings.host || '127.0.0.1';
      const port = proxySettings.port || 7890;
      startSocksBridge(host, port).then((bridgePort) => {
        if (generation !== proxyConfigGeneration) return;
        const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
        applyProxyEnvVars(bridgeUrl, PROXY_NO_PROXY_VAL);
        console.log(`[agent] SOCKS5 bridge active: ${rawProxyUrl} → ${bridgeUrl}`);
      }).catch((err) => {
        console.error('[agent] Failed to start SOCKS5 bridge:', err);
      });
      // Optimistically set ALL_PROXY so immediate traffic attempts SOCKS
      for (const v of PROXY_VARS) delete process.env[v];
      process.env.ALL_PROXY = rawProxyUrl;
      process.env.all_proxy = rawProxyUrl;
    } else {
      applyProxyEnvVars(rawProxyUrl, PROXY_NO_PROXY_VAL);
    }
  } else {
    // Disabled: restore inherited snapshot (or clear when Rust injected)
    for (const v of PROXY_VARS) {
      if (proxyWasInjectedByRust) {
        delete process.env[v];
      } else {
        const inherited = inheritedProxySnapshot[v];
        if (inherited === undefined) delete process.env[v];
        else process.env[v] = inherited;
      }
    }
  }

  if (oldProxyUrl !== rawProxyUrl) {
    console.log(`[agent] Proxy config changed: ${oldProxyUrl || 'none'} → ${rawProxyUrl || 'none'}`);
  }
}

export async function initSocksBridgeFromEnv(): Promise<void> {
  const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || '';
  if (!proxyUrl.startsWith('socks5://')) return;

  try {
    const url = new URL(proxyUrl);
    const host = url.hostname || '127.0.0.1';
    const port = parseInt(url.port) || 1080;

    const bridgePort = await startSocksBridge(host, port);
    const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
    applyProxyEnvVars(bridgeUrl, PROXY_NO_PROXY_VAL);
    console.log(`[agent] SOCKS5 bridge initialized at startup: ${proxyUrl} → ${bridgeUrl}`);
  } catch (err) {
    console.error(`[agent] Failed to initialize SOCKS5 bridge from env: ${err instanceof Error ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// Cron dispatch mutex(严格串行,cron tick 不交错)
// ---------------------------------------------------------------------------

let cronDispatchQueue: Promise<unknown> = Promise.resolve();

/**
 * Run `fn()` under the cron-dispatch mutex. Used by `/cron/execute-sync`
 * to atomically execute a cron tick — session switch, MCP reconcile,
 * enqueue, wait-for-idle — so two concurrent ticks can't interleave on
 * shared global state.
 */
export async function withCronDispatchLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = cronDispatchQueue.catch(() => undefined).then(() => fn());
  cronDispatchQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

// ---------------------------------------------------------------------------
// waitForSessionIdle(cron 同步派发;idleProbe 由调用方注入——M4c 后由
// index.ts 注入 pi 引擎的空闲探针,避免本文件反向依赖 chat-engine)
// ---------------------------------------------------------------------------

export async function waitForSessionIdle(
  timeoutMs: number = 600000,
  pollIntervalMs: number = 500,
  idleProbe?: () => boolean,
): Promise<boolean> {
  const startTime = Date.now();
  const isIdle = idleProbe ?? (() => true);

  // Brief wait to allow async operations to start (prevents false early return)
  await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, 500)));

  while (!isIdle()) {
    if (Date.now() - startTime > timeoutMs) {
      console.warn(`[agent] waitForSessionIdle: timeout after ${timeoutMs}ms`);
      return false;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return true;
}

// ---------------------------------------------------------------------------
// initializeAgent(M4c 瘦版:工作区配置自解析 + 状态初始化,无 SDK 预热)
// ---------------------------------------------------------------------------

let agentDir = '';
let hasInitialPrompt = false;

export function getAgentDir(): string {
  return agentDir;
}

/**
 * M4c 瘦版初始化:设置工作区、生成会话标识、自解析 provider/model
 * 配置镜像(供 distill/cron/admin 读取),不做任何 SDK 会话预热。
 * 聊天会话的初始化由 loop/chat-engine 的 initPiChatEngine 负责(调用方
 * 在 index.ts 启动序列里紧邻其后调用)。
 */
export async function initializeAgent(
  nextAgentDir: string,
  initialPrompt?: string | null,
  initialSessionId?: string,
): Promise<void> {
  agentDir = nextAgentDir;
  hasInitialPrompt = Boolean(initialPrompt && initialPrompt.trim());
  activeSessionId = initialSessionId ?? randomUUID();

  // 工作区配置自解析(provider/model 镜像;会话元数据快照优先的语义
  // 在 resolveWorkspaceConfig 内)。失败不致命——pi 引擎每次 send 自行解析。
  try {
    const { resolveWorkspaceConfig } = await import('./utils/admin-config');
    const initMeta = initialSessionId ? getSessionMetadata(initialSessionId) : null;
    const resolved = resolveWorkspaceConfig(agentDir, initMeta);
    if (resolved.providerEnv) {
      currentProviderEnv = resolved.providerEnv;
      console.log(`[agent] self-resolved provider: ${resolved.providerEnv.baseUrl ?? 'anthropic'}`);
    }
    if (resolved.model) {
      currentModel = resolved.model;
      console.log(`[agent] self-resolved model: ${resolved.model}`);
    }
  } catch (err) {
    console.warn('[agent] initializeAgent: workspace config self-resolve failed (non-fatal):', err instanceof Error ? err.message : err);
  }

  console.log(`[agent] init dir=${agentDir} initialPrompt=${hasInitialPrompt ? 'yes' : 'no'} sessionId=${activeSessionId} (pi engine)`);
}

export function hasInitialPromptSet(): boolean {
  return hasInitialPrompt;
}

// ---------------------------------------------------------------------------
// syncProjectUserConfig(skills/commands 软链同步,逐字保留自 M4c 前实现)
// ---------------------------------------------------------------------------

export function syncProjectUserConfig(projectDir: string): void {
  const zhishiDir = getZhiShiUserDir();
  const isWin = process.platform === 'win32';

  // ===== SKILLS SYNC =====
  const userSkillsDir = join(zhishiDir, 'skills');
  const projectSkillsDir = join(projectDir, '.claude', 'skills');

  if (existsSync(userSkillsDir)) {
    ensureDirSync(projectSkillsDir);

    // Read disabled list from skills-config.json
    let disabled: string[] = [];
    try {
      const configPath = join(zhishiDir, 'skills-config.json');
      if (existsSync(configPath)) {
        const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
        disabled = Array.isArray(raw?.disabled) ? raw.disabled : [];
      }
    } catch {
      // Ignore read errors — treat all skills as enabled
    }

    // Track which skill names we manage (enabled or disabled) so we can detect dangling symlinks
    const managedSkillNames = new Set<string>();

    for (const entry of readdirSync(userSkillsDir, { withFileTypes: true })) {
      // isDirEntry follows symlinks + Windows junctions (issue #104).
      const target = join(userSkillsDir, entry.name);
      if (!isDirEntry(entry, target)) continue;
      if (entry.name.startsWith('.')) continue;
      if (isSkillBlockedOnPlatform(entry.name)) continue;
      // Require SKILL.md to match scanSkills/scanSkillsDir's definition of a "valid skill".
      if (!existsSync(join(target, 'SKILL.md'))) continue;

      managedSkillNames.add(entry.name);
      const linkPath = join(projectSkillsDir, entry.name);

      if (disabled.includes(entry.name)) {
        // Disabled: remove symlink if we created one (never remove real dirs)
        try {
          if (existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink()) {
            // recursive: true needed on Windows — junctions are directories, rmSync() alone throws EPERM
            rmSync(linkPath, { recursive: true });
          }
        } catch { /* ignore */ }
        continue;
      }

      // Skip if a real (non-symlink) directory exists — don't overwrite project skills
      try {
        if (existsSync(linkPath)) {
          if (!lstatSync(linkPath).isSymbolicLink()) continue; // real dir, skip
          rmSync(linkPath, { recursive: true }); // recursive for Windows junctions
        }
      } catch { /* doesn't exist, create it */ }

      try {
        symlinkSync(target, linkPath, isWin ? 'junction' : undefined);
      } catch (err) {
        console.warn(`[skill-sync] Failed to symlink skill ${entry.name}:`, err);
      }
    }

    // Cleanup: remove dangling symlinks left by deleted/renamed user skills
    // Only removes symlinks pointing into our userSkillsDir — never touches real project dirs
    try {
      for (const entry of readdirSync(projectSkillsDir, { withFileTypes: true })) {
        const linkPath = join(projectSkillsDir, entry.name);
        try {
          if (!lstatSync(linkPath).isSymbolicLink()) continue;
          const target = readlinkSync(linkPath);
          const resolvedTarget = resolve(projectSkillsDir, target);
          if (resolvedTarget.startsWith(userSkillsDir + sep) && !managedSkillNames.has(entry.name)) {
            rmSync(linkPath, { recursive: true });
          }
        } catch { /* ignore individual errors */ }
      }
    } catch { /* ignore — projectSkillsDir may have been removed externally */ }
  }

  // ===== COMMANDS SYNC =====
  const userCommandsDir = join(zhishiDir, 'commands');
  const projectCommandsDir = join(projectDir, '.claude', 'commands');

  if (existsSync(userCommandsDir)) {
    ensureDirSync(projectCommandsDir);

    // Track managed command filenames for dangling symlink cleanup
    const managedCommandFiles = new Set<string>();

    for (const entry of readdirSync(userCommandsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (entry.name.startsWith('.')) continue;

      managedCommandFiles.add(entry.name);
      const linkPath = join(projectCommandsDir, entry.name);
      const target = join(userCommandsDir, entry.name);

      // Skip if a real (non-symlink) file exists — don't overwrite project commands
      try {
        if (existsSync(linkPath)) {
          if (!lstatSync(linkPath).isSymbolicLink()) continue; // real file, skip
          rmSync(linkPath, { recursive: true }); // stale symlink, recreate
        }
      } catch { /* doesn't exist, create it */ }

      try {
        // Note: file symlinks on Windows require Developer Mode (unlike junction for directories).
        symlinkSync(target, linkPath);
      } catch (err) {
        console.warn(`[command-sync] Failed to symlink command ${entry.name}:`, err);
      }
    }

    // Cleanup: remove dangling symlinks left by deleted/renamed user commands
    try {
      for (const entry of readdirSync(projectCommandsDir, { withFileTypes: true })) {
        const linkPath = join(projectCommandsDir, entry.name);
        try {
          if (!lstatSync(linkPath).isSymbolicLink()) continue;
          const target = readlinkSync(linkPath);
          const resolvedTarget = resolve(projectCommandsDir, target);
          if (resolvedTarget.startsWith(userCommandsDir + sep) && !managedCommandFiles.has(entry.name)) {
            rmSync(linkPath, { recursive: true });
          }
        } catch { /* ignore individual errors */ }
      }
    } catch { /* ignore */ }
  }
  // （人格同步已随人格层整拆移除——安全研究 harness 无陪伴人格，身份由
  //  安全认知内核承载,见 system-prompt-security.ts。）
}

// ---------------------------------------------------------------------------
// getHistoricalSessionMessages(/sessions/:id/messages REST)
// ---------------------------------------------------------------------------

/**
 * 会话历史读取。M4c 前读 SDK transcript jsonl;M4c 后读 SessionStore 的
 * 会话消息(SDK 时代会话仍可读——SessionStore jsonl 独立存续;pi 会话
 * 由 chat-engine 经 loop-sessions 提供,见 index.ts 端点实现)。
 */
export async function getHistoricalSessionMessages(
  sessionId: string,
  _dir?: string,
  limit?: number,
  offset?: number,
): Promise<Array<{ type: string; uuid: string; session_id: string; message: unknown }>> {
  const { getSessionData } = await import('./SessionStore');
  const data = getSessionData(sessionId);
  const all = (data?.messages ?? []) as unknown as Array<Record<string, unknown>>;
  const sliced = all.slice(offset ?? 0, limit !== undefined ? (offset ?? 0) + limit : undefined);
  return sliced.map((m, i) => ({
    type: String(m.role ?? 'unknown'),
    uuid: String(m.id ?? i),
    session_id: sessionId,
    message: { role: m.role, content: m.content },
  }));
}
