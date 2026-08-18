/**
 * M4a/M4b — pi 引擎会话外壳(与 SDK 引擎并行的生产会话路径)。
 *
 * 引擎开关:ZHISHI_LOOP_ENGINE 环境变量 > config.json 的 loopEngine
 * (缺省 'sdk');pi 时 index.ts 的 /chat/* 端点路由到这里,SDK 路径
 * 一行不动。外壳与 agent-session 同构的微型版:模块级会话状态
 * (sessionId/messages/queue/busy/abort),事件经同一个 sse.broadcast
 * 通道发出——TUI/渲染器零改动。
 *
 * 接线:
 *   - env 锚定:工作区的环境选定(env-selection.json,kind='env')→
 *     config.environments 条目 → env_exec + boundary + output-guard +
 *     compaction(M1–M3 全部挂点);host 选定 → 不注册任何工具(结构性
 *     边界:宿主执行类工具根本不存在)。
 *   - 模型:payload 的 providerEnv+model → resolveLoopModelFromEnv;
 *     缺省 → resolveLoopModel(config 默认)。model.reasoning=true 时开
 *     thinking(v1 固定 'low' 档)。
 *   - 系统提示:每 turn 重组 = 基座段(env_exec 教学 + 当前锚定环境)+
 *     buildSystemPromptAppend 全量输出(chat 会话恒 security 场景,含安全
 *     五段;cron 走全局场景;蒸馏/研究记忆逐 turn 新鲜,能力清单走 30s
 *     缓存);组装失败落回基座段,不阻塞会话。
 *   - 队列(W1 改语义):busy 时 /chat/send 进 steering 队列(chat:steering-added),
 *     运行中 loop 经 pi getSteeringMessages 在 turn 间注入——纠偏直接打字;
 *     /chat/queue 保留 M4b FIFO 排队(queue:added isInFlight:false,turn done
 *     后自动接下一条)。stop 两队列同清(逐条 cancelled)。事件名/payload
 *     与 SDK 路径对齐(agent-session 的 queue:* 语义)。
 *   - chat:status(W1):turn 开始(running)/ done(idle)/ stop / reset
 *     时 broadcast,TUI 状态行数据源。
 *   - 会话跨重启(M4b):首个用户消息时 createSession(SessionStore)并把
 *     loopSessionId 写入会话元数据;sidecar 重启后 init 时找回最近一条
 *     带 loopSessionId 的会话,loop-sessions 读全量历史,回放与续跑同
 *     一 session。
 *   - rewind(M4b):/chat/rewind 按 userMessageId 截断 loop-sessions
 *     (追加日志,截断即时间回溯)并重建内存消息。
 *   - 图片(M4b):payload.images → pi user 消息的 image 块。
 *   - refs(W1,design-spec §6.4):payload.refs → refs.ts 解析(经 env 通道),
 *     grounding 段前置进 loop prompt(用户气泡仍显示原文)。
 *   - delegate_task(W1 接回生产):锚定环境后注册,深度限 1 结构性保证;
 *     生命周期广播 chat:subagent-started/finished,子 loop 工具事件
 *     映射 chat:subagent-tool-*。
 *
 * v1 已知限制:fork 不在 pi 路径;steering 注入为纯文本(图片不随
 * steering 进队列)。
 */

import { randomUUID } from 'node:crypto';

import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';

import { computeContextUsage } from '../../shared/contextUsage';
import type { EnvironmentEntry } from '../../shared/config-types';
import type { ImagePayload } from '../../shared/types/image';
import type { SystemInitInfo } from '../../shared/types/system';
import { broadcast } from '../sse';
import { envTagForEntry, findEnvironmentEntry, listEnvironments } from '../environment/registry';
import { getWorkspaceSelection, loadSelectionStore } from '../environment/selection';
import { loadDistilledMemoryForPrompt } from '../memory/distill';
import { buildSystemPromptAppend, type InteractionScenario } from '../system-prompt';
import { collectResearchMemory, collectSecurityCapabilities } from '../system-prompt-security';
import { loadConfig } from '../utils/admin-config';
import {
  createSession,
  getSessionMetadata,
  getSessionsByAgentDir,
  updateSessionMetadata,
} from '../SessionStore';
import type { SessionMetadata } from '../types/session';
import type { ProviderEnv } from '../agent-session';
import { getInteractionScenario } from '../agent-session';

import { makeBoundaryHook } from './boundary';
import { makeCompactionTransform } from './compaction';
import { runLoop } from './loop';
import { buildMcpTools } from './mcp-bridge';
import { makeOutputGuardHook } from './output-guard';
import { parseChatRefs, resolveChatRefs } from './refs';
import { firePostTurnTitleHook } from '../turn-hooks';
import { resolveLoopModel, resolveLoopModelFromEnv, type LoopModelResolution } from './pi-provider';
import {
  appendLoopMessages,
  loadLoopSession,
  markLoopSessionCompacted,
  newLoopSessionId,
  truncateLoopSession,
  forkLoopSession,
} from './session';
import { mapLoopEventToSse, toolResultText } from './sse-adapter';
import { createDelegateTaskTool, DELEGATE_TASK_TOOL_NAME } from './subagent';
import { collectEnabledSkills } from './skills';
import { createEnvBgTool, createEnvExecTool, createResearchLogTool, ENV_EXEC_TOOL_NAME, RESEARCH_LOG_TOOL_NAME } from './tools';
import { ENV_BG_TOOL_NAME } from './bg-exec';
import { loadBundledAgents } from '../agents/bundled-agents';

// ---------------------------------------------------------------------------
// Engine switch(env > config,缺省 sdk)
// ---------------------------------------------------------------------------

let sdkDeprecationWarned = false;

/**
 * 引擎解析(M4c 硬切):SDK 引擎已删除,恒为 'pi'。
 * env ZHISHI_LOOP_ENGINE / config loopEngine 仍读取仅为兼容——显式请求
 * 'sdk' 时一次性告警并回落 pi(删除清单见 M4c 报告;硬切不允许残留
 * 死路径)。
 */
export function resolveLoopEngine(
  env: NodeJS.ProcessEnv = process.env,
  configLoopEngine?: 'sdk' | 'pi',
): 'sdk' | 'pi' {
  const requested = env.ZHISHI_LOOP_ENGINE ?? configLoopEngine;
  if (requested === 'sdk' && !sdkDeprecationWarned) {
    sdkDeprecationWarned = true;
    console.warn('[pi-engine] sdk 引擎已删除(M4c),忽略 ZHISHI_LOOP_ENGINE/loopEngine=sdk,使用 pi 引擎');
  }
  return 'pi';
}

/** 引擎开关(M4c 后恒 true;保留签名以免路由点散改)。 */
export function isPiEngine(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveLoopEngine(env, (loadConfig() as { loopEngine?: 'sdk' | 'pi' }).loopEngine) === 'pi';
}

// ---------------------------------------------------------------------------
// Module state(与 agent-session 同构的微型版)
// ---------------------------------------------------------------------------

interface MessageWire {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: string;
  /** role === 'tool' 时:工具名与成败(重放工具卡用)。 */
  name?: string;
  ok?: boolean;
  attachments?: {
    id: string;
    name: string;
    mimeType: string;
    isImage?: boolean;
  }[];
}

interface PiQueueItem {
  queueId: string;
  input: PiSendInput;
  /** W1 — refs 解析出的 grounding 段(send 时解析,随条目走)。 */
  grounding: string;
}

let agentDir = '';
let sessionId = newLoopSessionId();
let messages: MessageWire[] = [];
let messageSeq = 0;
let streamingAssistantId: string | null = null;
let systemInitInfo: SystemInitInfo | null = null;
let busy = false;
let currentAbort: AbortController | null = null;
let queue: PiQueueItem[] = [];
/** W1 steering 队列(design-spec §6.1 纠偏档):busy 时 /chat/send 进这里,
 *  由运行中 loop 的 getSteeringMessages 在 turn 间取走注入,不排队等 turn。 */
let steering: PiQueueItem[] = [];
/** SessionStore 里绑定的会话元数据 id(其 loopSessionId 字段 === sessionId)。 */
let boundSessionMetaId: string | null = null;

/** W1 — TUI 状态行数据源(sse.ts 已注册 'chat:status'):状态变迁时广播。 */
function broadcastChatStatus(): void {
  broadcast('chat:status', { sessionState: busy ? 'running' : 'idle' });
}

/** sidecar 启动时初始化;pi 引擎下尝试续接最近的 loop 会话。 */
export async function initPiChatEngine(dir: string): Promise<void> {
  agentDir = dir;
  await restorePiSession();
}

export function getPiAgentState(): { agentDir: string; sessionState: string; hasInitialPrompt: boolean; loopEngine: string } {
  return { agentDir, sessionState: busy ? 'running' : 'idle', hasInitialPrompt: messages.length > 0, loopEngine: 'pi' };
}

export function getPiMessages(): MessageWire[] {
  return messages;
}

export function getPiStreamingAssistantId(): string | null {
  return streamingAssistantId;
}

export function getPiSystemInitInfo(): SystemInitInfo | null {
  return systemInitInfo;
}

export function getPiLogLines(): string[] {
  return [];
}

// ---------------------------------------------------------------------------
// Env anchoring(工作区环境选定 → 环境条目)
// ---------------------------------------------------------------------------

/** 当前工作区选定的环境条目;host 选定/无选定/条目缺失 → null(不注册工具)。 */
export function resolveSessionEnv(dir: string): EnvironmentEntry | null {
  const store = loadSelectionStore();
  const findEntry = (d: string): EnvironmentEntry | null => {
    const selection = getWorkspaceSelection(store, d);
    if (selection.kind !== 'env') return null;
    return findEnvironmentEntry(listEnvironments(loadConfig()), selection.id) ?? null;
  };
  const entry = findEntry(dir);
  if (entry) return entry;
  // Windows 路径写法漂移:sidecar 的 agentDir 经 path.resolve 是反斜杠,
  // TUI/CLI 选定落盘可能是正斜杠(或反之)。两种形态都要查——且不只是
  // 「无选定」时:选定指向已删除条目(悬空)同样要回退到另一形态,否则
  // 活体实测的坑:反斜杠形态选了已拆除的 vmware-fuzz.vmx,正斜杠形态的
  // pwn-vm 永远轮不到,工具集退化成只剩 research_log。
  const alt = dir.includes('/') ? dir.replace(/\//g, '\\') : dir.replace(/\\/g, '/');
  if (alt === dir) return null;
  return findEntry(alt);
}

// ---------------------------------------------------------------------------
// 会话跨重启绑定(SessionStore.loopSessionId)
// ---------------------------------------------------------------------------

/** loop 消息 → 回放用 MessageWire(user/assistant/tool;thinking 段不重现)。
 *  工具结果重放为 tool 卡;空结论的 assistant 照发空 content——由 TUI 转
 *  分隔行兜底(工具在前的说「看上方工具卡」),历史不再悬空。 */
function loopMessagesToWire(loopMessages: AgentMessage[]): MessageWire[] {
  const wire: MessageWire[] = [];
  for (const m of loopMessages) {
    if (m.role === 'user') {
      const text = typeof m.content === 'string'
        ? m.content
        : m.content.filter((c): c is TextContent => c.type === 'text').map((c) => c.text).join('\n');
      const images = typeof m.content === 'string'
        ? []
        : m.content.filter((c): c is ImageContent => c.type === 'image');
      wire.push({
        id: String(messageSeq++),
        role: 'user',
        content: text,
        timestamp: new Date(m.timestamp || Date.now()).toISOString(),
        ...(images.length > 0
          ? { attachments: images.map((img, i) => ({ id: String(i), name: 'image', mimeType: img.mimeType, isImage: true })) }
          : {}),
      });
    } else if (m.role === 'assistant') {
      const text = m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      // 工具调用前的 thinking 段不重放(紧随的 tool 卡代表这轮动作);
      // 纯空结论照发空 content,TUI 端转分隔行,冷历史不再漂悬空问题。
      if (!text && m.content.some((c) => c.type === 'toolCall')) continue;
      wire.push({
        id: String(messageSeq++),
        role: 'assistant',
        content: text,
        timestamp: new Date(m.timestamp || Date.now()).toISOString(),
      });
    } else if (m.role === 'toolResult') {
      const text = m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      wire.push({
        id: String(messageSeq++),
        role: 'tool',
        name: typeof m.toolName === 'string' && m.toolName ? m.toolName : 'tool',
        ok: m.isError !== true,
        content: text,
        timestamp: new Date(m.timestamp || Date.now()).toISOString(),
      });
    }
  }
  return wire;
}

/** 启动恢复:找最近一条带 loopSessionId 的会话元数据,续接同一 loop session。 */
async function restorePiSession(): Promise<void> {
  const candidates = getSessionsByAgentDir(agentDir)
    .filter((s) => typeof (s as { loopSessionId?: string }).loopSessionId === 'string')
    .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
  const latest = candidates[0] as { id: string; loopSessionId?: string } | undefined;
  if (!latest?.loopSessionId) return;
  const stored = loadLoopSession(latest.loopSessionId);
  if (stored.messages.length === 0) return;
  boundSessionMetaId = latest.id;
  sessionId = latest.loopSessionId;
  messages = loopMessagesToWire(stored.messages);
  console.log(`[pi-engine] 续接 loop 会话 ${sessionId}(${stored.messages.length} 条消息,meta=${latest.id})`);
}

/** 首个用户消息时建 SessionStore 会话并写入 loopSessionId 绑定。 */
async function ensureSessionBound(firstUserText: string): Promise<void> {
  if (boundSessionMetaId) return;
  try {
    const meta = await createSession(agentDir, {
      title: firstUserText.slice(0, 30) || 'pi session',
      lastMessagePreview: firstUserText.slice(0, 100),
    });
    boundSessionMetaId = meta.id;
    await updateSessionMetadata(meta.id, { loopSessionId: sessionId } as Partial<typeof meta>);
  } catch (err) {
    console.warn('[pi-engine] SessionStore 绑定失败(会话不跨重启,其余功能正常):', err);
  }
}

// ---------------------------------------------------------------------------
// Send / queue / stop / reset / rewind
// ---------------------------------------------------------------------------

export interface PiSendInput {
  text: string;
  images?: ImagePayload[];
  model?: string;
  providerEnv?: ProviderEnv;
  permissionMode?: string;
  /** W1(design-spec §6.4)— @ 引用数组(additive):[{type:'file',path}|{type:'env',id}|{type:'snapshot',name}|{type:'taskmd'}]。 */
  refs?: unknown;
}

export interface PiSendResult {
  error?: string;
  queued?: boolean;
  queueId?: string;
  isInFlight?: boolean;
  /** W1 — true = 进了 steering 队列(运行中注入),区别于 FIFO 排队。 */
  steering?: boolean;
}

/**
 * refs → grounding 段(send 时经 env 通道解析;解析失败告警并降级为空,
 * 不阻塞发送——单项失败已在 refs 模块内注明)。
 */
async function resolveInputGrounding(input: PiSendInput): Promise<string> {
  const parsed = parseChatRefs(input.refs);
  if (parsed.refs.length === 0 && parsed.invalid.length === 0) return '';
  try {
    return await resolveChatRefs(parsed, {
      env: resolveSessionEnv(agentDir),
      environments: listEnvironments(loadConfig()),
    });
  } catch (err) {
    console.warn('[pi-engine] refs 解析失败(按无 refs 发送):', err);
    return '';
  }
}

/** 模型解析 + 启动 turn(send/queue 两入口共用;调用前须确认 !busy)。 */
function startResolvedTurn(input: PiSendInput, grounding: string): PiSendResult {
  const resolution = input.providerEnv
    ? resolveLoopModelFromEnv(input.providerEnv, input.model ?? '')
    : resolveLoopModel();
  if (!resolution) {
    return { error: '无可用的 provider/model(pi 引擎):缺 provider 定义或 API key' };
  }
  startPiTurn(input, resolution, grounding);
  return { queued: false, isInFlight: true };
}

/**
 * /chat/send 的 pi 路径(W1 steering 语义,design-spec §6.1 纠偏档):
 * busy 时**不再 FIFO 排队**,改为注入运行中 loop 的 steering 队列
 * (chat:steering-added),pi 在 turn 间把消息注入对话,模型直接响应——
 * 「纠偏直接打字」。要 FIFO 排队走 /chat/queue(queuePiChatMessage)。
 */
export async function sendPiChatMessage(input: PiSendInput): Promise<PiSendResult> {
  const text = input.text.trim();
  const hasImages = !!input.images && input.images.length > 0;
  if (!text && !hasImages) return { error: 'Message must have text or images.' };

  const grounding = await resolveInputGrounding(input);

  if (busy) {
    const queueId = randomUUID();
    steering.push({ queueId, input, grounding });
    broadcast('chat:steering-added', { queueId, messageText: text.slice(0, 100) });
    console.log(`[pi-engine] 消息进 steering 队列 queueId=${queueId}(深度=${steering.length})`);
    return { queued: true, queueId, isInFlight: false, steering: true };
  }

  return startResolvedTurn(input, grounding);
}

/**
 * /chat/queue 的 pi 路径(显式排队):busy 时 FIFO 排队(M4b 语义不变,
 * queue:added isInFlight:false),空闲时直接开 turn——即 W1 之前的
 * /chat/send 行为。
 */
export async function queuePiChatMessage(input: PiSendInput): Promise<PiSendResult> {
  const text = input.text.trim();
  const hasImages = !!input.images && input.images.length > 0;
  if (!text && !hasImages) return { error: 'Message must have text or images.' };

  const grounding = await resolveInputGrounding(input);

  if (busy) {
    const queueId = randomUUID();
    queue.push({ queueId, input, grounding });
    broadcast('queue:added', { queueId, messageText: text.slice(0, 100), isInFlight: false });
    console.log(`[pi-engine] 消息已排队 queueId=${queueId}(深度=${queue.length})`);
    return { queued: true, queueId, isInFlight: false };
  }

  return startResolvedTurn(input, grounding);
}

/**
 * 基座身份段:pi 引擎自己的身份 + env_exec 教学 + 当前锚定环境(动态拼,
 * 模型要知道自己在哪)。完整系统提示 = 基座段 + buildSystemPromptAppend
 * 输出,见 assemblePiSystemPrompt。
 */
const PI_SYSTEM_PROMPT =
  '你是安全研究助手,工作在选定的研究环境(隔离 VM/SSH 主机)里。' +
  '查/改环境内的事实必须用 env_exec——命令在环境内部执行,不是宿主机;不要猜测环境事实。' +
  '无法执行的请求(边界规则拦截)如实告知用户。';

/** 基座段:静态身份 + 当前锚定环境的明确信息(env id/kind/address)。 */
function buildBaseSystemPrompt(env: EnvironmentEntry | null): string {
  if (!env) {
    return PI_SYSTEM_PROMPT +
      '当前未锚定研究环境(host 选定):本会话没有 env_exec 工具,涉及环境内事实时请用户先锚定环境。';
  }
  const locator = env.address ?? env.host ?? env.container ?? env.vmName ?? '';
  return PI_SYSTEM_PROMPT +
    `当前锚定环境:${envTagForEntry(env)}(id=${env.id}, kind=${env.kind}${locator ? `, address=${locator}` : ''})` +
    '——env_exec 的命令就在这个环境里执行。';
}

/**
 * 当前会话的交互场景。cron 心跳等显式设置的全局场景(agent-session
 * currentScenario,非 desktop)优先;否则恒为 security——pi 是安全研究员
 * harness 的唯一引擎,zhishi agent CLI 会话即安全研究场景(SDK 时代靠
 * 会话元数据 interactionScenario 恢复;pi 的绑定会话由引擎自建、不经
 * CLI 的 POST /sessions 元数据,故默认即 security,五段不再依赖元数据)。
 */
function resolvePiScenario(): InteractionScenario {
  const globalScenario = getInteractionScenario();
  return globalScenario.type === 'desktop' ? { type: 'security' } : globalScenario;
}

/**
 * 每 turn 组装的完整系统提示 = 基座段 + buildSystemPromptAppend 全量输出
 * (security 场景含认知内核/能力清单/代码原生通道/research-log 教学/研究记忆
 * 反喂五段)。逐 turn 重组:蒸馏记忆与研究记忆要逐 turn 新鲜(SDK 时代即每
 * query 重组);能力清单采集走 engine-detect-cache 30s 缓存,不会每 turn 重复
 * 探测。组装失败落回基座段,不阻塞会话。
 */
async function assemblePiSystemPrompt(env: EnvironmentEntry | null): Promise<string> {
  const base = buildBaseSystemPrompt(env);
  try {
    const scenario = resolvePiScenario();
    const append = buildSystemPromptAppend(scenario, {
      runtime: 'builtin',
      distilledMemory: loadDistilledMemoryForPrompt(),
      skills: collectEnabledSkills(),
      securityCapabilities: scenario.type === 'security'
        ? await collectSecurityCapabilities(agentDir)
        : undefined,
      securityResearchMemory: scenario.type === 'security'
        ? collectResearchMemory()
        : undefined,
    });
    return append ? `${base}\n\n${append}` : base;
  } catch (err) {
    console.warn('[pi-engine] 系统提示组装失败,落回基座段:', err);
    return base;
  }
}

/** 启动一个 turn(fire-and-forget);调用前须确认 !busy。 */
function startPiTurn(input: PiSendInput, resolution: LoopModelResolution, grounding: string): void {
  const text = input.text.trim();
  busy = true;
  currentAbort = new AbortController();
  // W1 — 状态行数据源:turn 开始(running)。
  broadcastChatStatus();

  // 用户气泡:与 SDK 路径同形的 live replay echo(含图片附件形状)。
  const userMessage: MessageWire = {
    id: String(messageSeq++),
    role: 'user',
    content: text,
    timestamp: new Date().toISOString(),
    ...(input.images?.length
      ? { attachments: input.images.map((img, i) => ({ id: String(i), name: img.name, mimeType: img.mimeType, isImage: true })) }
      : {}),
  };
  messages.push(userMessage);
  broadcast('chat:message-replay', { message: userMessage });

  // 会话跨重启绑定(fire-and-forget,不阻塞 turn)。
  void ensureSessionBound(text).then(() => {
    if (boundSessionMetaId) {
      void updateSessionMetadata(boundSessionMetaId, { lastMessagePreview: text.slice(0, 100) }).catch(() => {});
    }
  });

  // system-init(每会话一次,形状对齐 SDK 的 chat:system-init)。
  const env = resolveSessionEnv(agentDir);
  // research_log 是 harness 原生能力(写自己的 research_events 库),与环境
  // 无关,始终注册;env_exec 只在锚定环境后存在(结构性边界);delegate_task
  // (W1)需要环境(子 loop 靠 env_exec 查证),同样只在锚定后注册。
  // env_bg(P2 渗透试点前置)同环境绑定:后台进程与环境同生共死。
  const toolNames = [
    ...(env ? [ENV_EXEC_TOOL_NAME, ENV_BG_TOOL_NAME, DELEGATE_TASK_TOOL_NAME] : []),
    RESEARCH_LOG_TOOL_NAME,
  ];
  if (!systemInitInfo) {
    systemInitInfo = {
      timestamp: new Date().toISOString(),
      cwd: agentDir,
      session_id: sessionId,
      model: resolution.modelId,
      tools: toolNames,
      permissionMode: input.permissionMode,
    };
    broadcast('chat:system-init', { info: systemInitInfo, sessionId, runtime: 'builtin', engine: 'pi' });
  }

  // 流式 assistant 占位(/chat/stream 重放时按 id 跳过,由 live 事件重建)。
  streamingAssistantId = String(messageSeq++);
  const assistantMessage: MessageWire = {
    id: streamingAssistantId,
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString(),
  };
  messages.push(assistantMessage);

  void runPiTurn(input, resolution, env, toolNames, assistantMessage, currentAbort, grounding)
    .catch((err) => {
      console.error('[pi-engine] turn 异常:', err);
      broadcast('chat:message-error', err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      busy = false;
      streamingAssistantId = null;
      currentAbort = null;
      turnSeq++;
      // W1 — turn done(idle):FIFO 有待接项时不发 idle,紧接的 promote
      // 会立刻发 running,避免状态行闪变。
      if (queue.length === 0) broadcastChatStatus();
      promotePiQueue();
    });
}

/** 当前 turn done 后自动接下一条(SDK 的 promote 语义,queue:added isInFlight:true)。 */
function promotePiQueue(): void {
  const next = queue.shift();
  if (!next) return;
  broadcast('queue:added', {
    queueId: next.queueId,
    messageText: next.input.text.trim().slice(0, 100),
    isInFlight: true,
  });
  console.log(`[pi-engine] 自动接下一条 queueId=${next.queueId}(剩余=${queue.length})`);
  // startResolvedTurn 同步返回;解析失败(模型不可用)时报错并继续 promote。
  const attempt = (): void => {
    const result = startResolvedTurn(next.input, next.grounding);
    if (result.error) {
      console.error('[pi-engine] 队列消息启动失败:', result.error);
      broadcast('chat:message-error', result.error);
      promotePiQueue();
    }
  };
  try {
    attempt();
  } catch (err) {
    console.error('[pi-engine] 队列消息启动失败:', err);
    broadcast('chat:message-error', err instanceof Error ? err.message : String(err));
    promotePiQueue();
  }
}

async function runPiTurn(
  input: PiSendInput,
  resolution: LoopModelResolution,
  env: EnvironmentEntry | null,
  toolNames: string[],
  assistantMessage: MessageWire,
  abort: AbortController,
  grounding: string,
): Promise<void> {
  const startedAt = Date.now();
  // grounding(W1 @ 注入)只进 loop prompt,不进用户气泡(气泡显示原文)。
  const text = input.text.trim();
  const promptText = grounding ? `${grounding}\n\n${text}` : text;
  const history = loadLoopSession(sessionId).messages;

  const tools: AgentTool[] = [
    ...(env ? [createEnvExecTool(env)] : []),
    createResearchLogTool(agentDir),
  ];
  if (env) {
    // W1(design-spec §8)— delegate_task 接回生产路径。深度限 1 由 subagent
    // 结构性保证(子 loop 默认工具集只有 env_exec);生命周期广播
    // chat:subagent-started/finished(finished 带结论摘要,截断 200 字,
    // 不带过程),子 loop 工具事件映射 chat:subagent-tool-*。
    tools.push(createEnvBgTool(env, {
      onLifecycle: (ev) => {
        if (ev.kind === 'started') {
          broadcast('chat:bg-started', { tag: ev.tag, pid: ev.pid, commandPreview: ev.commandPreview });
        } else {
          broadcast('chat:bg-finished', {
            tag: ev.tag,
            status: ev.status,
            ...(ev.exitCode !== undefined ? { exitCode: ev.exitCode } : {}),
          });
        }
      },
    }));
    tools.push(createDelegateTaskTool({
      env,
      resolution,
      parentAllowedTools: toolNames,
      // 子代理定义(bundled-agents)engine 装载——模型按名派发,v1 不挂 skill 注入。
      agents: loadBundledAgents().map((a) => ({ name: a.name, body: a.body })),
      notify: {
        started: (taskId, description) => {
          broadcast('chat:subagent-started', { taskId, description });
        },
        finished: (taskId, description, summary, error) => {
          const trimmed = summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
          broadcast('chat:subagent-finished', {
            taskId,
            description,
            summary: trimmed,
            status: error ? 'failed' : 'completed',
            ...(error ? { error } : {}),
          });
        },
      },
      onLoopEvent: (taskId, event) => {
        if (event.type === 'tool-call') {
          broadcast('chat:subagent-tool-use', {
            subagentId: taskId,
            id: event.toolCallId,
            name: event.toolName,
            input: event.args ?? {},
          });
        } else if (event.type === 'tool-result') {
          broadcast('chat:subagent-tool-result-complete', {
            subagentId: taskId,
            toolUseId: event.toolCallId,
            content: toolResultText(event.result),
            isError: event.isError,
          });
        }
      },
    }));
  }
  // M4d — MCP 工具(宿主侧能力,不依赖 env)。tools 数组每 turn 重建,
  // mcp/reload 重连后下一 turn 自动用新工具集(热重载零成本)。
  const mcpTools = buildMcpTools();
  tools.push(...mcpTools);
  // 结构性白名单同步扩进 MCP 工具名——否则 boundary 会把真实 MCP 工具
  // 当幻觉工具 deny(缺口埋点逻辑同样据此区分)。
  const effectiveToolNames = [...toolNames, ...mcpTools.map((t) => t.name)];
  const baseBoundary = makeBoundaryHook(env, { allowedTools: effectiveToolNames });
  // 包装 boundary:记录幻觉工具(白名单外被拦)供 turn 完成点的缺口埋点。
  const blockedToolNames: string[] = [];
  const beforeToolCall: typeof baseBoundary = async (ctx, signal) => {
    const r = await baseBoundary(ctx, signal);
    if (r?.block && !effectiveToolNames.includes(ctx.toolCall.name)) {
      blockedToolNames.push(ctx.toolCall.name);
    }
    return r;
  };
  const afterToolCall = makeOutputGuardHook();
  const transformContext = makeCompactionTransform(
    { contextWindow: resolution.model.contextWindow || 200_000 },
    () => { void markLoopSessionCompacted(sessionId).catch(() => {}); },
  );

  // 图片输入:pi user 消息的 image 块(与文本同一条消息)。
  const promptContent: (TextContent | ImageContent)[] | undefined = input.images?.length
    ? [
        { type: 'text', text: promptText },
        ...input.images.map((img): ImageContent => ({ type: 'image', data: img.data, mimeType: img.mimeType })),
      ]
    : undefined;

  let fullText = '';
  let lastUsage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null = null;
  let doneMessages: AgentMessage[] = [];
  let failed: string | null = null;

  for await (const event of runLoop({
    ...(promptContent
      ? { messages: [{ role: 'user', content: promptContent, timestamp: Date.now() } as AgentMessage] }
      : { prompt: promptText }),
    history,
    systemPrompt: await assemblePiSystemPrompt(env),
    model: resolution.model,
    models: resolution.models,
    getApiKey: resolution.getApiKey,
    tools,
    signal: abort.signal,
    beforeToolCall,
    afterToolCall,
    transformContext,
    // W1 steering(纠偏档):pi 在每个 turn 结束、下一次 LLM 调用前轮询;
    // 取空队列即把运行中发送的消息注入对话(图片不随 steering 注入,v1 纯文本)。
    getSteeringMessages: async () => {
      if (steering.length === 0) return [];
      const drained = steering.splice(0, steering.length);
      console.log(`[pi-engine] steering 注入 ${drained.length} 条`);
      return drained.map((item) => {
        const itemText = item.input.text.trim();
        return {
          role: 'user',
          content: item.grounding ? `${item.grounding}\n\n${itemText}` : itemText,
          timestamp: Date.now(),
        } as AgentMessage;
      });
    },
    // k3 等 reasoning 模型开 thinking(v1 固定 low 档;thinkingLevelMap 在 pi 目录)。
    reasoning: resolution.model.reasoning ? 'low' : undefined,
  })) {
    if (event.type === 'text-delta') fullText += event.delta;
    if (event.type === 'error') failed = event.error;
    if (event.type === 'done') {
      doneMessages = event.messages;
      const lastAssistant = [...event.messages].reverse().find((m) => m.role === 'assistant');
      if (lastAssistant?.usage) {
        const u = lastAssistant.usage;
        lastUsage = { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite };
      }
    }
    for (const sse of mapLoopEventToSse(event, { model: resolution.modelId, startedAt })) {
      // 用户主动中断(Esc/stop)的 turn 收尾错误不上屏——中断分隔线已告知,
      // 红色 "This operation was aborted" 错误条是纯噪音(活体实测)。
      if (event.type === 'error' && abort.signal.aborted) continue;
      broadcast(sse.event, sse.data);
    }
  }

  // 落终态:assistant 气泡内容 + 会话续存(done.messages 只含新增,无重复)。
  assistantMessage.content = fullText;
  if (doneMessages.length > 0) {
    await appendLoopMessages(
      sessionId,
      doneMessages,
      { model: resolution.modelId, providerId: resolution.providerId },
    ).catch((err) => console.warn('[pi-engine] 会话续存失败:', err));
  }

  // context-usage(与 SDK 路径同一事件、同一 computeContextUsage 归一化)。
  if (lastUsage) {
    const usage = computeContextUsage({
      occupiedTokens: lastUsage.input + lastUsage.cacheRead,
      runtimeWindow: resolution.model.contextWindow || null,
      source: 'builtin',
      model: resolution.modelId,
      lookupWindow: () => resolution.model.contextWindow || null,
    });
    broadcast('chat:context-usage', usage);
  }

  // M4c — turn 完成点挂点(蒸馏弧/标题;原 SDK turn 完成处的同等埋点)。
  // 1) 自动标题:火 forget,失败不影响 turn(turn-hooks 契约)。
  firePostTurnTitleHook(sessionId, resolution.modelId, input.providerEnv);
  // 2) 能力缺口事件(WORK_LOOP §5):幻觉工具被 boundary 白名单拦截 /
  //    上游报 unknown skill/tool → gap_events(懒加载 store,静默失败)。
  recordGapEvents(failed, blockedToolNames);

  if (failed && !abort.signal.aborted) {
    console.error(`[pi-engine] turn 失败: ${failed}`);
  }
}

/**
 * 能力缺口埋点(对齐原 SDK turn 完成点 logGapEvent 的 schema):
 * 幻觉工具(白名单外 toolName 被拦)= 模型想要不存在的能力;
 * 上游 unknown skill/tool 错误 = provider 侧缺口。
 */
function recordGapEvents(failed: string | null, blockedToolNames: string[]): void {
  const gaps: Array<{ gapKey: string; detail: string }> = [];
  for (const name of blockedToolNames) {
    gaps.push({ gapKey: `hallucinated-tool:${name}`, detail: `模型调用了未注册工具 "${name}"(boundary 白名单拦截)` });
  }
  if (failed) {
    const unknownCap = /unknown\s+(skill|tool)\s*[:\s]\s*([^\s;.'"()]+)/i.exec(failed);
    const toolNotFound = /tool\s+not\s+found/i.test(failed);
    if (unknownCap) {
      gaps.push({ gapKey: `unknown-${unknownCap[1].toLowerCase()}:${unknownCap[2]}`, detail: failed.slice(0, 500) });
    } else if (toolNotFound) {
      gaps.push({ gapKey: `tool-not-found:${failed.slice(0, 60)}`, detail: failed.slice(0, 500) });
    }
  }
  for (const gap of gaps) {
    void import('../memory/store')
      .then((m) => m.logGapEvent({
        gapKey: gap.gapKey,
        detail: gap.detail,
        context: sessionId,
        resolution: 'abandoned',
      }))
      .catch(() => { /* 缺口记录失败静默——主流程优先 */ });
  }
}

/** turn 完成计数(cron/headless 等待点;每个 turn 收尾 +1)。 */
let turnSeq = 0;

/**
 * cron 定时任务等 headless 调用(M4c 自 SDK enqueueUserMessage 迁移):
 * 发消息并等 turn 完成(含排队轮次),返回最终 assistant 文本。
 * 超时按失败处理(不中断 turn——cron 语义是等结果,不是取消)。
 */
export async function sendPiChatMessageAndWait(
  input: PiSendInput,
  timeoutMs = 10 * 60_000,
): Promise<{ text: string; error?: string }> {
  const before = turnSeq;
  const result = await sendPiChatMessage(input);
  if (result.error) return { text: '', error: result.error };
  const start = Date.now();
  for (;;) {
    // 等 busy 回落且队列排空,且至少完成一个新 turn(自己那条)。
    if (!busy && queue.length === 0 && turnSeq > before) {
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
      return { text: lastAssistant?.content ?? '' };
    }
    if (Date.now() - start > timeoutMs) {
      return { text: '', error: `等待 turn 完成超时(${timeoutMs}ms)` };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * /sessions/switch 的 pi 路径:切到 SessionStore 里另一条绑定会话
 * (其 loopSessionId 指向的 loop-sessions 文件),重建回放。
 */
export async function switchPiSession(metaId: string): Promise<boolean> {
  if (busy) stopPiChat();
  const meta = getSessionMetadata(metaId) as { loopSessionId?: string } | null;
  if (!meta?.loopSessionId) return false;
  const stored = loadLoopSession(meta.loopSessionId);
  queue = [];
  steering = [];
  sessionId = meta.loopSessionId;
  boundSessionMetaId = metaId;
  messageSeq = 0;
  messages = loopMessagesToWire(stored.messages);
  streamingAssistantId = null;
  systemInitInfo = null;
  console.log(`[pi-engine] 切换会话 → ${metaId}(loop=${sessionId},${stored.messages.length} 条)`);
  return true;
}

/** /chat/stop 的 pi 路径:清空 FIFO 队列(逐条 queue:cancelled)+ 清空
 *  steering 队列(逐条 chat:steering-cancelled,与 FIFO 同)+ abort 当前 turn。 */
export function stopPiChat(): boolean {
  let acted = false;
  for (const item of queue) {
    broadcast('queue:cancelled', { queueId: item.queueId });
    acted = true;
  }
  queue = [];
  for (const item of steering) {
    broadcast('chat:steering-cancelled', { queueId: item.queueId });
    acted = true;
  }
  steering = [];
  if (busy && currentAbort) {
    currentAbort.abort();
    broadcast('chat:message-stopped', null);
    acted = true;
  }
  // W1 — stop 后状态回 idle(turn 收尾的 finally 会再发一次同值,幂等)。
  if (acted) broadcast('chat:status', { sessionState: 'idle' });
  return acted;
}

/** /chat/queue/cancel 的 pi 路径:移除排队项(FIFO 或 steering)并广播取消。 */
export function cancelPiQueueItem(queueId: string): string | null {
  const idx = queue.findIndex((item) => item.queueId === queueId);
  if (idx >= 0) {
    const [item] = queue.splice(idx, 1);
    broadcast('queue:cancelled', { queueId });
    return item.input.text;
  }
  const steeringIdx = steering.findIndex((item) => item.queueId === queueId);
  if (steeringIdx >= 0) {
    const [item] = steering.splice(steeringIdx, 1);
    broadcast('chat:steering-cancelled', { queueId });
    return item.input.text;
  }
  return null;
}

/** /chat/queue/force 的 pi 路径:中断当前 turn,改跑指定排队项。 */
export async function forcePiQueueItem(queueId: string): Promise<boolean> {
  const idx = queue.findIndex((item) => item.queueId === queueId);
  if (idx < 0) return false;
  const [item] = queue.splice(idx, 1);
  if (busy && currentAbort) {
    currentAbort.abort();
    broadcast('chat:message-stopped', null);
    // 等当前 turn 收尾(finally 会 promote——但队列已不含本项,不会抢跑)。
    for (let i = 0; i < 100 && busy; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  broadcast('queue:added', {
    queueId: item.queueId,
    messageText: item.input.text.trim().slice(0, 100),
    isInFlight: true,
  });
  const result = startResolvedTurn(item.input, item.grounding);
  return !result.error;
}

/** /chat/queue/status 的 pi 路径:FIFO 排队 + steering 队列(kind 区分)。 */
export function getPiQueueStatus(): Array<{ id: string; messagePreview: string; kind: 'fifo' | 'steering' }> {
  return [
    ...queue.map((item) => ({
      id: item.queueId,
      messagePreview: item.input.text.trim().slice(0, 100),
      kind: 'fifo' as const,
    })),
    ...steering.map((item) => ({
      id: item.queueId,
      messagePreview: item.input.text.trim().slice(0, 100),
      kind: 'steering' as const,
    })),
  ];
}

/** /chat/reset 的 pi 路径:新会话 id + 清状态(loop-sessions 旧文件保留,可审计)。
 *  关键:旧元数据上的 loopSessionId 绑定必须同步摘掉——否则 /sessions/switch
 *  或 sidecar 重启的 restore 会按旧绑定把 reset 前的历史整个复活(活体发现)。 */
export function resetPiChat(): void {
  if (currentAbort) currentAbort.abort();
  for (const item of queue) {
    broadcast('queue:cancelled', { queueId: item.queueId });
  }
  queue = [];
  for (const item of steering) {
    broadcast('chat:steering-cancelled', { queueId: item.queueId });
  }
  steering = [];
  if (boundSessionMetaId) {
    const staleMetaId = boundSessionMetaId;
    void updateSessionMetadata(staleMetaId, { loopSessionId: null } as unknown as Partial<SessionMetadata>).catch(
      (err) => console.warn('[pi-engine] reset 解绑旧 loopSessionId 失败:', err),
    );
  }
  sessionId = newLoopSessionId();
  boundSessionMetaId = null;
  messages = [];
  messageSeq = 0;
  streamingAssistantId = null;
  systemInitInfo = null;
  busy = false;
  currentAbort = null;
  // W1 — reset 后状态回 idle。
  broadcast('chat:status', { sessionState: 'idle' });
}

/**
 * /chat/rewind 的 pi 路径:截断到指定用户消息**之前**(SDK rewind 语义:
 * 该消息及其后全部移除,用户可改完后重发)。loop-sessions 是追加日志,
 * 截断即时间回溯;内存消息按截断后的 loop 历史重建。
 */
export async function rewindPiChat(userMessageId: string): Promise<{ success: boolean; error?: string }> {
  if (busy) return { success: false, error: '响应进行中,先停止再 rewind' };
  const idx = messages.findIndex((m) => m.id === userMessageId && m.role === 'user');
  if (idx < 0) return { success: false, error: 'Message not found' };

  // wire 里第 N 条 user 消息(0 起)对应 loop 历史里第 N 条 role=user 消息
  // (每个 turn 恰一条 prompt user 消息)。
  const userOrdinal = messages.slice(0, idx).filter((m) => m.role === 'user').length;
  const loopMessages = loadLoopSession(sessionId).messages;
  let seen = -1;
  let cutIndex = loopMessages.length;
  for (let i = 0; i < loopMessages.length; i++) {
    if (loopMessages[i].role === 'user') {
      seen++;
      if (seen === userOrdinal) { cutIndex = i; break; }
    }
  }

  await truncateLoopSession(sessionId, cutIndex);
  messageSeq = 0;
  messages = loopMessagesToWire(loadLoopSession(sessionId).messages);
  streamingAssistantId = null;
  console.log(`[pi-engine] rewind → 截断到 ${cutIndex} 条 loop 消息(userMessageId=${userMessageId})`);
  return { success: true };
}

/**
 * /sessions/fork 的 pi 路径:在指定消息所在 turn 的末尾分叉——原会话不动,
 * 新 loop session 复制前半段,当前 loop 原地换血到分叉(对齐 reset 的
 * 状态重置清单)。wire→loop 的映射与 rewind 同构:user 消息按序数对应
 * (每 turn 恰一条 prompt user 消息),截点 = 第 N+1 条 loop user 消息前
 * (即目标消息所在 turn 结束之后)。
 */
export async function forkPiChat(messageId: string): Promise<{ success: boolean; error?: string; sessionId?: string }> {
  if (busy) return { success: false, error: '响应进行中,先停止再 fork' };
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx < 0) return { success: false, error: 'Message not found' };

  const userOrdinal = messages.slice(0, idx + 1).filter((m) => m.role === 'user').length;
  const loopMessages = loadLoopSession(sessionId).messages;
  let seen = 0;
  let cutIndex = loopMessages.length;
  for (let i = 0; i < loopMessages.length; i++) {
    if (loopMessages[i].role === 'user') {
      seen++;
      if (seen > userOrdinal) { cutIndex = i; break; }
    }
  }

  const forkId = await forkLoopSession(sessionId, cutIndex);
  sessionId = forkId;
  boundSessionMetaId = null; // 首条消息时 ensureSessionBound 建新 meta
  messageSeq = 0;
  messages = loopMessagesToWire(loadLoopSession(forkId).messages);
  streamingAssistantId = null;
  systemInitInfo = null;
  broadcast('chat:status', { sessionState: 'idle' });
  console.log(`[pi-engine] fork → 新会话 ${forkId}(截点 ${cutIndex} 条 loop 消息)`);
  return { success: true, sessionId: forkId };
}
