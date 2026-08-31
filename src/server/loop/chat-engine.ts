/**
 * M4a/M4b → M4c — pi 引擎会话外壳(SDK 引擎已删,本模块是唯一生产会话路径)。
 *
 * 引擎开关(M4c 硬切):恒为 pi——ZHISHI_LOOP_ENGINE / config loopEngine
 * 仍读取仅为兼容,显式请求 'sdk' 时一次性告警并回落 pi(见
 * resolveLoopEngine)。外壳与 agent-session 同构的微型版:会话状态收拢在
 * ChatEngine 实例字段(sessionId/messages/queue/busy/abort;1.1.7 ②
 * 由模块级 let 机械收拢,文件底部默认实例 + 原签名 facade 导出),
 * 事件经同一个 sse.broadcast 通道发出——TUI/渲染器零改动。
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
 *     时 broadcast,GUI 状态行数据源。
 *   - 会话跨重启(M4b):首个用户消息时 createSession(SessionStore)并把
 *     loopSessionId 写入会话元数据;sidecar 重启后 init 时按当前选定环境
 *     的分线映射(1.1.6 #4,env-sessions.json)找回对应 loop session,
 *     loop-sessions 读全量历史,回放与续跑同一 session。
 *   - 会话按环境分线(1.1.6 #4):workspace × 环境键 → loopSessionId 存
 *     ~/.zhishi/env-sessions.json(environment/env-sessions.ts);environment/select
 *     落盘后联动 switchEnvSession 切线(busy 拒绝,rewind/fork 同口径);
 *     reset 同步清当前环境键的映射条目。
 *   - cron 独立 invoke 通道(B2,1.2.6):cron 不再经单例的
 *     sendPiChatMessage/switchPiSession——invokePiSession 按目标 loop 线
 *     读历史、跑独立 runLoop、续存回同一条线(appendLoopMessages 有文件
 *     锁,与单例并发写不丢更新),全程不碰引擎的 sessionId/messages/
 *     steering/queue/busy,不广播 TUI 事件。single_session 的上下文延续
 *     由「读任务自己的 loop 线历史」承载,不需要切换引擎会话线——B2 的
 *      steering 混入 / TUI 重接强停 cron turn / env 映射回填错位三切面
 *     随之整体消失(详见 switchPiSession 的 B2 论证注释)。
 *   - rewind(M4b):/chat/rewind 按 userMessageId 截断 loop-sessions
 *     (追加日志,截断即时间回溯)并重建内存消息。
 *   - 图片(M4b):payload.images → pi user 消息的 image 块。
 *   - refs(W1,design-spec §6.4):payload.refs → refs.ts 解析(经 env 通道),
 *     grounding 段前置进 loop prompt(用户气泡仍显示原文)。
 *   - delegate_task(W1 接回生产):锚定环境后注册,深度限 1 结构性保证;
 *     生命周期广播 chat:subagent-started/finished,子 loop 工具事件
 *     映射 chat:subagent-tool-*。
 *
 * v1 已知限制:steering 注入为纯文本(图片不随
 * steering 进队列)。1.2.6 批次 B:steering 注入同步补 wire + replay
 * 广播(B6,保 rewind/fork 序数映射 1:1);turn done 时残留 steering
 * drain 到 FIFO 队首续跑(B5,pi 只在 turn 间轮询 steering,收尾不看)。
 * fork 已实现(forkPiChat 接 /chat/fork 路由,见下文)。
 */

import { randomUUID } from 'node:crypto';

import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import { isContextOverflow } from '@earendil-works/pi-ai';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';

import { computeContextUsage } from '../../shared/contextUsage';
import type { EnvironmentEntry } from '../../shared/config-types';
import type { ImagePayload } from '../../shared/types/image';
import type { SystemInitInfo } from '../../shared/types/system';
import { broadcast } from '../sse';
import { envTagForEntry, findEnvironmentEntry, listEnvironments } from '../environment/registry';
import {
  getWorkspaceSelection,
  getWorkspaceSelectionRecord,
  loadSelectionStore,
  HOST_SELECTION,
} from '../environment/selection';
import {
  envKeyForSelection,
  getEnvSessionLine,
  loadEnvSessionsMap,
  normalizeWorkspaceKey,
  removeEnvSessionLine,
  setEnvSessionLine,
} from '../environment/env-sessions';
import { loadDistilledMemoryForPrompt } from '../memory/distill';
import { buildSystemPromptAppend, type InteractionScenario } from '../system-prompt';
import { collectResearchMemory, collectSecurityCapabilities, resolveSessionDomain, type SecurityCapabilitiesData } from '../system-prompt-security';
import type { ResearchTaskKind } from '../../shared/research-kinds';
import { loadConfig } from '../utils/admin-config';
import {
  createSession,
  getSessionMetadata,
  getSessionsByAgentDir,
  updateSessionMetadata,
} from '../SessionStore';
import type { SessionMetadata } from '../types/session';
import type { ProviderEnv } from '../agent-session';
import { getInteractionScenario, setActiveSessionId } from '../agent-session';

import { makeBoundaryHook } from './boundary';
import { makeCompactionTransform } from './compaction';
import { estimateMessagesTokens } from './context-manager';
import { runLoop } from './loop';
import { makeOutputGuardHook } from './output-guard';
import { createRecallTool, RECALL_TOOL_NAME } from './recall';
import { parseChatRefs, resolveChatRefs } from './refs';
import { firePostTurnTitleHook } from '../turn-hooks';
import { resolveLoopModel, resolveLoopModelFromEnv, type LoopModelResolution } from './pi-provider';
import {
  appendLoopMessages,
  defaultLoopSessionDir,
  loadLoopSession,
  markLoopSessionCompacted,
  newLoopSessionId,
  truncateLoopSession,
  forkLoopSession,
} from './session';
import { mapLoopEventToSse, toolResultText, type SseOut } from './sse-adapter';
import { createDelegateTaskTool, DELEGATE_TASK_TOOL_NAME } from './subagent';
import { createEnvBgTool, createEnvExecTool, createResearchLogTool, createArchiveTool, ENV_EXEC_TOOL_NAME, RESEARCH_LOG_TOOL_NAME, RESEARCH_ARCHIVE_TOOL_NAME } from './tools';
import { loadArchive, type ArchiveSnapshot } from './archive';
import { collectExpertInjection, lastUserTextOf } from './expert-inject';
import { createIntelSearchTool, INTEL_SEARCH_TOOL_NAME } from './intel';
import { createExpertDraftTool, createExpertSearchTool, EXPERT_DRAFT_TOOL_NAME, EXPERT_SEARCH_TOOL_NAME } from './expert';
import { createDecisionTool, formatDecisionInjectionContent, REQUEST_DECISION_TOOL_NAME, type DecisionMeta } from './decision';
import { createDeclareCompletionTool, DECLARE_COMPLETION_TOOL_NAME } from './declare-completion';
import { buildLoopWireMessages } from './wire-replay';
import { ENV_BG_TOOL_NAME, envBgReap } from './bg-exec';
import { getBgRegistry, initBgRegistry } from './bg-registry';
import { reapAllBgProcesses } from './bg-reap';
import { filterAgentsByDomain, loadBundledAgents } from '../agents/bundled-agents';

// ---------------------------------------------------------------------------
// Types(原 module state 段的接口 + Send 段接口,class 语法要求上移至此)
// ---------------------------------------------------------------------------

interface MessageWire {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: string;
  /** role === 'tool' 时:工具名与成败(重放工具卡用)。 */
  name?: string;
  ok?: boolean;
  /** B5(1.2.6)— 来源队列项 id(steering/FIFO 归属追踪用;
   *  仅 user 消息可能携带;不上屏、不进持久化,纯内存标签)。 */
  queueId?: string;
  attachments?: {
    id: string;
    name: string;
    mimeType: string;
    isImage?: boolean;
  }[];
  // ---- 1.3.2 决策块(additive):user 消息带 kind='decision' 时为决策记录,
  // GUI 渲染琥珀决策块;TUI 走 default 忽略,现有字段形状不变。 ----
  kind?: 'decision';
  decisionId?: string;
  choice?: string;
  note?: string;
  expertRefs?: string[];
}

interface PiQueueItem {
  queueId: string;
  input: PiSendInput;
  /** W1 — refs 解析出的 grounding 段(send 时解析,随条目走)。 */
  grounding: string;
}

export interface PiSendInput {
  text: string;
  images?: ImagePayload[];
  model?: string;
  providerEnv?: ProviderEnv;
  permissionMode?: string;
  /** W1(design-spec §6.4)— @ 引用数组(additive):[{type:'file',path}|{type:'env',id}|{type:'snapshot',name}|{type:'taskmd'}]。 */
  refs?: unknown;
  /**
   * 1.3.2 决策注入(additive):user 消息带决策记录——wire 落 kind:'decision'
   * 决策块,loop jsonl 落 decision marker(/chat/stream 重放可还原)。
   * 仅决策 respond 注入路径使用;普通 send/queue 不带。
   */
  decision?: DecisionMeta;
}

export interface PiSendResult {
  error?: string;
  queued?: boolean;
  queueId?: string;
  isInFlight?: boolean;
  /** W1 — true = 进了 steering 队列(运行中注入),区别于 FIFO 排队。 */
  steering?: boolean;
}

// ---------------------------------------------------------------------------
// 纯函数(不碰引擎实例状态,1.1.7 ② 收拢时留在 class 外)
// ---------------------------------------------------------------------------

/** 配置缺失类发送错误(缺 provider 定义/API key)——/chat/send 据此区分 400。 */
export const PI_NO_PROVIDER_ERROR = '无可用的 provider/model(pi 引擎):缺 provider 定义或 API key';

/**
 * /chat/send 错误文本 → HTTP 状态码(1.3.10 C2):配置类错误(无可用的
 * provider/model)是请求方配置问题 → 400;其余保持 429(既有限流语义,
 * 客户端按 429 退避)。
 */
export function chatSendErrorStatus(error: string): number {
  return error === PI_NO_PROVIDER_ERROR ? 400 : 429;
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

/** 当前工作区选定对应的环境分线键(1.1.6 #4)。与 resolveSessionEnv 同一
 *  双形态兜底(无记录/env 条目悬空 → 回退另一斜杠形态),两形态都落空 → host。 */
export function resolveSessionEnvKey(dir: string): string {
  const store = loadSelectionStore();
  const keyFor = (d: string): string | null => {
    const record = getWorkspaceSelectionRecord(store, d);
    if (!record) return null; // 该形态无记录 → 回退另一形态
    const selection = record.selection;
    // env 选定但条目已删(悬空)→ 回退另一形态,与 resolveSessionEnv 同坑
    if (selection.kind === 'env' && !findEnvironmentEntry(listEnvironments(loadConfig()), selection.id)) {
      return null;
    }
    return envKeyForSelection(selection);
  };
  const key = keyFor(dir);
  if (key !== null) return key;
  const alt = dir.includes('/') ? dir.replace(/\//g, '\\') : dir.replace(/\\/g, '/');
  if (alt === dir) return envKeyForSelection(HOST_SELECTION);
  return keyFor(alt) ?? envKeyForSelection(HOST_SELECTION);
}

/**
 * 当前工作区的环境锚(1.3.2 任务二 #2)——chat:init payload 的 environment
 * 字段数据源,GUI 重连时免 environment/current 绕行。与 resolveSessionEnv
 * 同一双形态兜底。host 选定(未锚定)→ null。
 *   - env 选定 → { kind:'env', id: 条目 id, name: 条目名, type: 环境类型 }
 *   - recipe 选定 → { kind:'recipe', id: 实例 id, name: 实例 id, type: 配方 id }
 */
export function resolveSessionEnvAnchor(dir: string): {
  kind: 'env' | 'recipe';
  id: string;
  name: string;
  type: string;
} | null {
  const store = loadSelectionStore();
  const pick = (d: string): ReturnType<typeof resolveSessionEnvAnchor> => {
    const selection = getWorkspaceSelection(store, d);
    if (selection.kind === 'env') {
      const entry = findEnvironmentEntry(listEnvironments(loadConfig()), selection.id);
      return entry
        ? { kind: 'env', id: entry.id, name: entry.name ?? entry.id, type: entry.kind }
        : null;
    }
    if (selection.kind === 'recipe') {
      return { kind: 'recipe', id: selection.instanceId, name: selection.instanceId, type: selection.name };
    }
    return null;
  };
  const primary = pick(dir);
  if (primary) return primary;
  const alt = dir.includes('/') ? dir.replace(/\//g, '\\') : dir.replace(/\\/g, '/');
  if (alt === dir) return null;
  return pick(alt);
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

/**
 * 溢出重试的强制压缩预算(1.2.7 活体实测修正):0.25 × 窗口。初版用 0
 * (无视阈值往死里压),活体证据是把 226K 估压到 6K 残渣——模型只剩 stub
 * 可读,回答质量劣化;0.25 既保证重试视图远小于窗口(装得下),又保留
 * 足够的当前阶段/key 段原文。
 */
const FORCE_COMPACTION_RATIO = 0.25;

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

// ---------------------------------------------------------------------------
// Phase 3 — bg 进程回收挂载点(turn 结束 / 会话 reset)
// ---------------------------------------------------------------------------

/**
 * 回收登记表里全部 bg 进程(turn 结束 / 会话 reset 两处挂载)。
 * 决策性质、潜在问题与后续方向见 bg-reap.ts 模块头注释(暂定决策底稿)。
 * 这里是薄包装:把真实依赖(登记表单例 / config 环境解析 / envBgReap /
 * SSE 广播)接进可注入的 reapAllBgProcesses——编排本体在 bg-reap.ts 里
 * 被单测钉死,本函数只剩接线,不另测。
 *
 * broadcast 开关:invoke 通道(headless)传 false——回收照做(杀进程/清
 * 登记不变),但 chat:bg-finished 不广播(契约:headless 不往客户端发
 * 事件,与 buildTurnStack 的 broadcastEvents=false 同口径)。
 */
async function reapBgOnLifecyclePoint(
  reason: 'turn-end' | 'reset',
  opts: { broadcast?: boolean } = {},
): Promise<void> {
  const registry = getBgRegistry();
  if (!registry) return;
  const envList = listEnvironments(loadConfig());
  const doBroadcast = opts.broadcast ?? true;
  await reapAllBgProcesses({
    registry,
    findEnv: (envId) => findEnvironmentEntry(envList, envId) ?? null,
    reap: (entry, tag, pid) => envBgReap(entry, tag, pid),
    onFinished: (tag, status) => {
      if (doBroadcast) broadcast('chat:bg-finished', { tag, status });
    },
    onWarn: (msg) => console.warn(`[pi-engine] ${msg}`),
    onLog: (msg) => console.log(`[pi-engine] ${msg}(${reason})`),
  });
}

/** 某 workspace 当前选定环境的分线绑定(environment/current 的 TUI 接线数据源)。 */
export function getEnvSessionBinding(
  workspace: string,
): { envKey: string; loopSessionId: string; sessionMetaId: string | null } | null {
  const envKey = resolveSessionEnvKey(workspace);
  const line = getEnvSessionLine(loadEnvSessionsMap(), workspace, envKey);
  if (!line) return null;
  const meta = getSessionsByAgentDir(workspace).find(
    (s) => (s as { loopSessionId?: string }).loopSessionId === line.loopSessionId,
  );
  return { envKey, loopSessionId: line.loopSessionId, sessionMetaId: meta?.id ?? null };
}

/**
 * B2(1.2.6)— meta → loop 线的解析/愈合:B1 愈合逻辑的引擎无关版。
 * meta 存在且有 loopSessionId 绑定 → 返回该线;无绑定(cron new_session
 * 新建的 meta 不落 loopSessionId)→ 当场开新线并把绑定写回 meta;
 * meta 不存在 → null。不碰引擎单例的任何状态——cron invoke 通道与
 * switchPiSession 共用此解析。
 */
export async function ensureMetaLoopLine(metaId: string): Promise<string | null> {
  const meta = getSessionMetadata(metaId) as { loopSessionId?: string | null } | null;
  if (!meta) return null;
  if (meta.loopSessionId) return meta.loopSessionId;
  const loopId = newLoopSessionId();
  await updateSessionMetadata(metaId, { loopSessionId: loopId } as Partial<SessionMetadata>);
  return loopId;
}

// ---------------------------------------------------------------------------
// ChatEngine(1.1.7 ② — 原模块级 let 与导出函数的机械收拢;行为零变化)
// ---------------------------------------------------------------------------

class ChatEngine {
  // -------------------------------------------------------------------------
  // Engine switch 状态(原模块级 sdkDeprecationWarned)
  // -------------------------------------------------------------------------

  private sdkDeprecationWarned = false;

  // -------------------------------------------------------------------------
  // Instance state(原模块级 let,与 agent-session 同构的微型版)
  // -------------------------------------------------------------------------

  private agentDir = '';
  private sessionId = newLoopSessionId();
  private messages: MessageWire[] = [];
  private messageSeq = 0;
  private streamingAssistantId: string | null = null;
  /** 1.4.4 研究档案来源锚：当前轮 user 消息 id（仅交互线在 startPiTurn 写入；
   *  headless invoke 线的锚点 undefined 语义经 buildTurnStack 参数下传，
   *  不碰本字段——invoke 与交互 turn 并发时互不干扰）。 */
  private currentTurnUserMessageId: string | undefined;
  private systemInitInfo: SystemInitInfo | null = null;
  private busy = false;
  private currentAbort: AbortController | null = null;
  /** FIFO 排队入口已随 /chat/queue 路由删除（queuePiChatMessage/forcePiQueueItem
   *  已删），本队列仅由历史路径写入——当前恒空，保留 status/cancel 面向 GUI。 */
  private queue: PiQueueItem[] = [];
  /** W1 steering 队列(design-spec §6.1 纠偏档):busy 时 /chat/send 进这里,
   *  由运行中 loop 的 getSteeringMessages 在 turn 间取走注入,不排队等 turn。 */
  private steering: PiQueueItem[] = [];
  /** SessionStore 里绑定的会话元数据 id(其 loopSessionId 字段 === sessionId)。 */
  private boundSessionMetaId: string | null = null;
  /** 1.1.6 #4 — 引擎当前所在的环境分线键(随 restore/switchEnvSession 更新;
   *  不逐次重读磁盘——select 落盘→切线的窗口内磁盘已超前于引擎)。 */
  private currentEnvKey: string = envKeyForSelection(HOST_SELECTION);

  // -------------------------------------------------------------------------
  // Engine switch(M4c 硬切:恒 pi;sdk 请求一次性告警回落)
  // -------------------------------------------------------------------------

  /**
   * 引擎解析(M4c 硬切):SDK 引擎已删除,恒为 'pi'。
   * env ZHISHI_LOOP_ENGINE / config loopEngine 仍读取仅为兼容——显式请求
   * 'sdk' 时一次性告警并回落 pi(删除清单见 M4c 报告;硬切不允许残留
   * 死路径)。
   */
  resolveLoopEngine(
    env: NodeJS.ProcessEnv = process.env,
    configLoopEngine?: 'sdk' | 'pi',
  ): 'sdk' | 'pi' {
    const requested = env.ZHISHI_LOOP_ENGINE ?? configLoopEngine;
    if (requested === 'sdk' && !this.sdkDeprecationWarned) {
      this.sdkDeprecationWarned = true;
      console.warn('[pi-engine] sdk 引擎已删除(M4c),忽略 ZHISHI_LOOP_ENGINE/loopEngine=sdk,使用 pi 引擎');
    }
    return 'pi';
  }

  /** 引擎开关(M4c 后恒 true;保留签名以免路由点散改)。 */
  isPiEngine(env: NodeJS.ProcessEnv = process.env): boolean {
    return this.resolveLoopEngine(env, (loadConfig() as { loopEngine?: 'sdk' | 'pi' }).loopEngine) === 'pi';
  }

  /** W1 — GUI 状态行数据源(sse.ts 已注册 'chat:status'):状态变迁时广播。 */
  private broadcastChatStatus(): void {
    broadcast('chat:status', { sessionState: this.busy ? 'running' : 'idle' });
  }

  /** sidecar 启动时初始化;pi 引擎下尝试续接最近的 loop 会话。 */
  async initPiChatEngine(dir: string): Promise<void> {
    this.agentDir = dir;
    await this.restorePiSession();
    // Phase 3:bg 登记表落盘恢复(restore 内部读盘;文件缺失/损坏不抛错)。
    // 恢复的条目不清不杀——只是重新纳入回收链,下一次 turn 结束/reset
    // 仍能按 tag+pid 回收,不会变孤儿。不重播 chat:bg-started(TUI 侧
    // 状态行有自己的内存登记,重复广播反而制造重影)。
    initBgRegistry(dir);
  }

  getPiAgentState(): {
    agentDir: string;
    sessionState: string;
    hasInitialPrompt: boolean;
    loopEngine: string;
    /** 1.3.2 任务二 #2:环境锚(additive)——GUI 重连免 environment/current 绕行。 */
    environment: ReturnType<typeof resolveSessionEnvAnchor>;
  } {
    return {
      agentDir: this.agentDir,
      sessionState: this.busy ? 'running' : 'idle',
      hasInitialPrompt: this.messages.length > 0,
      loopEngine: 'pi',
      environment: resolveSessionEnvAnchor(this.agentDir),
    };
  }

  getPiMessages(): MessageWire[] {
    return this.messages;
  }

  getPiStreamingAssistantId(): string | null {
    return this.streamingAssistantId;
  }

  /** 1.4.4 研究档案：当前 loop 线 id（档案归属/查询按线走；未初始化 → ''）。 */
  getPiSessionId(): string {
    return this.sessionId;
  }

  getPiSystemInitInfo(): SystemInitInfo | null {
    return this.systemInitInfo;
  }

  // ---------------------------------------------------------------------------
  // 会话跨重启绑定(SessionStore.loopSessionId)
  // ---------------------------------------------------------------------------

  /** loop 消息 → 回放用 MessageWire(user/assistant/tool;thinking 段不重现)。
   *  1.3.3:还原逻辑收敛到 loop/wire-replay.ts::buildLoopWireMessages
   *  (历史面板 wire 端点 / 引擎恢复 / cold-history 三路径共用同一口径),
   *  本方法只负责实例续号。 */
  private loopMessagesToWire(loopMessages: AgentMessage[]): MessageWire[] {
    const wire = buildLoopWireMessages(loopMessages, this.messageSeq);
    this.messageSeq += wire.length;
    return wire;
  }

  /** 按 loopSessionId 反查 SessionStore 里绑定的会话元数据 id(无 → null)。 */
  private findBoundMetaId(loopId: string): string | null {
    const meta = getSessionsByAgentDir(this.agentDir).find(
      (s) => (s as { loopSessionId?: string }).loopSessionId === loopId,
    );
    return meta?.id ?? null;
  }

  /** 分线映射写盘(1.1.6 #4):「当前环境键 → 当前 loopSessionId」。只在绑定
   *  存在时写——映射永不指向没有 SessionStore 绑定的线(新线的首次写盘点在
   *  ensureSessionBound 之后;切换前的旧线回填见 switchEnvSession)。 */
  private async persistEnvSessionLine(): Promise<void> {
    if (!this.boundSessionMetaId || !this.agentDir) return;
    try {
      await setEnvSessionLine(this.agentDir, this.currentEnvKey, this.sessionId);
    } catch (err) {
      console.warn('[pi-engine] env-sessions 映射写盘失败:', err);
    }
  }

  /**
   * 启动恢复(1.1.6 #4 env-aware):按「当前选定环境」的分线映射续接对应
   * loop session;无映射/映射失效(文件没了或为空)→ 开新线。不再按「全
   * workspace 最新 meta」接线——分线语义下最新多半是别的环境的线,接了即串线。
   */
  private async restorePiSession(): Promise<void> {
    const envKey = resolveSessionEnvKey(this.agentDir);
    this.currentEnvKey = envKey;
    const line = getEnvSessionLine(loadEnvSessionsMap(), this.agentDir, envKey);
    if (!line) return;
    const stored = loadLoopSession(line.loopSessionId);
    if (stored.messages.length === 0) return;
    this.boundSessionMetaId = this.findBoundMetaId(line.loopSessionId);
    this.sessionId = line.loopSessionId;
    // B10(1.2.6):启动恢复出绑定后同步配置面会话标识——cron/sessions 路由
    // 经 getSessionId() 读它,不更新则恒为 initializeAgent 的随机 UUID(僵尸值)。
    if (this.boundSessionMetaId) setActiveSessionId(this.boundSessionMetaId);
    this.messages = this.loopMessagesToWire(stored.messages);
    console.log(`[pi-engine] 续接环境分线 ${envKey}(loop=${this.sessionId},${stored.messages.length} 条消息,meta=${this.boundSessionMetaId ?? '无'})`);
  }

  /** 首个用户消息时建 SessionStore 会话并写入 loopSessionId 绑定。 */
  private async ensureSessionBound(firstUserText: string): Promise<void> {
    if (this.boundSessionMetaId) return;
    try {
      const meta = await createSession(this.agentDir, {
        title: firstUserText.slice(0, 30) || 'pi session',
        lastMessagePreview: firstUserText.slice(0, 100),
      });
      this.boundSessionMetaId = meta.id;
      await updateSessionMetadata(meta.id, { loopSessionId: this.sessionId } as Partial<typeof meta>);
      // B10(1.2.6):绑定建立即写配置面会话标识(getSessionId 的消费者——cron
      // execute-sync 回报/skip-switch、sessions 路由 in-memory 合并——都读它)。
      setActiveSessionId(meta.id);
      // 1.1.6 #4:绑定建立后同步分线映射(新线的写盘点——确保映射指向真实
      // 存在的线,而不是切换时先写一个尚无绑定的 sessionId)。
      await this.persistEnvSessionLine();
    } catch (err) {
      console.warn('[pi-engine] SessionStore 绑定失败(会话不跨重启,其余功能正常):', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Send / queue / stop / reset / rewind
  // ---------------------------------------------------------------------------

  /**
   * refs → grounding 段(send 时经 env 通道解析;解析失败告警并降级为空,
   * 不阻塞发送——单项失败已在 refs 模块内注明)。
   */
  private async resolveInputGrounding(input: PiSendInput): Promise<string> {
    const parsed = parseChatRefs(input.refs);
    if (parsed.refs.length === 0 && parsed.invalid.length === 0) return '';
    try {
      return await resolveChatRefs(parsed, {
        env: resolveSessionEnv(this.agentDir),
        environments: listEnvironments(loadConfig()),
      });
    } catch (err) {
      console.warn('[pi-engine] refs 解析失败(按无 refs 发送):', err);
      return '';
    }
  }

  /** 模型解析 + 启动 turn(send/queue 两入口共用;调用前须确认 !busy)。 */
  private startResolvedTurn(input: PiSendInput, grounding: string, queueId?: string): PiSendResult {
    const resolution = input.providerEnv
      ? resolveLoopModelFromEnv(input.providerEnv, input.model ?? '')
      : resolveLoopModel();
    if (!resolution) {
      return { error: PI_NO_PROVIDER_ERROR };
    }
    this.startPiTurn(input, resolution, grounding, queueId);
    return { queued: false, isInFlight: true, queueId };
  }

  /**
   * /chat/send 的 pi 路径(W1 steering 语义,design-spec §6.1 纠偏档):
   * busy 时**不再 FIFO 排队**,改为注入运行中 loop 的 steering 队列
   * (chat:steering-added),pi 在 turn 间把消息注入对话,模型直接响应——
   * 「纠偏直接打字」。FIFO 排队入口(/chat/queue)已删除。
   */
  async sendPiChatMessage(input: PiSendInput): Promise<PiSendResult> {
    const text = input.text.trim();
    const hasImages = !!input.images && input.images.length > 0;
    if (!text && !hasImages) return { error: 'Message must have text or images.' };

    const grounding = await this.resolveInputGrounding(input);

    // B5(1.2.6):queueId 恒分配(直接开 turn 的也带)——steering/FIFO 排队
    // 与 wire 消息归属的关联键(queue:* 事件族按它对账)。
    const queueId = randomUUID();
    if (this.busy) {
      this.steering.push({ queueId, input, grounding });
      broadcast('chat:steering-added', { queueId, messageText: text.slice(0, 100) });
      console.log(`[pi-engine] 消息进 steering 队列 queueId=${queueId}(深度=${this.steering.length})`);
      return { queued: true, queueId, isInFlight: false, steering: true };
    }

    return this.startResolvedTurn(input, grounding, queueId);
  }

  /**
   * 每 turn 组装的完整系统提示 = 基座段 + buildSystemPromptAppend 全量输出
   * (security 场景含认知内核/能力清单/代码原生通道/research-log 教学/研究记忆
   * 反喂五段)。逐 turn 重组:蒸馏记忆与研究记忆要逐 turn 新鲜(SDK 时代即每
   * query 重组);能力清单采集走 engine-detect-cache 30s 缓存,不会每 turn 重复
   * 探测。组装失败落回基座段,不阻塞会话。
   */
  private async assemblePiSystemPrompt(
    env: EnvironmentEntry | null,
    // B2(1.2.6):调用方可显式指定场景(cron invoke 通道直接传 cron 场景,
    // 不吃全局 currentScenario 的 set/reset 时序);缺省读全局(交互 turn)。
    scenario: InteractionScenario = resolvePiScenario(),
    // 1.2.7(§三):域判定的内容信号源——最近消息扫描(配方默认 + 内容信号
    // 动态修正,见 resolveSessionDomain);缺省空数组 = 纯配方默认(1.2.4 语义)。
    // A2-2(1.5.4):调用方须把当前轮用户消息也并入(起跑加载的 history 不含
    // 本轮)——它同时是专家注入的最近用户消息锚,缺了会滞后一轮。
    historyMessages: readonly AgentMessage[] = [],
    // 1.2.7(域补丁):调用方已算好 caps/domain 时透传(同一 turn 内域判定
    // 只有一个事实源——buildTurnStack 的子代理分域与系统提示分域必须同值);
    // 缺省本函数自算(向后兼容)。
    precomputed?: { caps?: SecurityCapabilitiesData; domain?: ResearchTaskKind },
    // 1.4.4(研究档案):本 turn 的 loop 线——档案按线装载并注入实时状态段
    // (模型在显式研究状态上继续,不从历史脑补)。缺省读 this.sessionId。
    archiveSessionId?: string,
  ): Promise<string> {
    const base = buildBaseSystemPrompt(env);
    try {
      const caps = precomputed
        ? precomputed.caps
        : scenario.type === 'security'
          ? await collectSecurityCapabilities(this.agentDir)
          : undefined;
      // 1.2.7 域边界：配方默认 + 内容信号动态修正；无可靠信号 → undefined
      // 降级全量（域过滤是预算优化，不是正确性闸门，宁多勿缺）。domain 同时
      // 驱动能力清单分域收窄、子代理分域（buildTurnStack）与研究记忆过滤
      // （1.2.4）。
      const domain = precomputed
        ? precomputed.domain
        : caps ? resolveSessionDomain(historyMessages, caps) : undefined;
      // 1.4.4 研究档案：security/auto-run 场景注入实时状态段；档案缺失/空 →
      // 零注入。读侧容错（IO 失败按空档案，不阻塞会话）。
      const archiveSession = archiveSessionId ?? this.sessionId;
      let researchArchive: ArchiveSnapshot | undefined;
      if (scenario.type === 'security' || scenario.type === 'auto-run') {
        try {
          const loaded = loadArchive(archiveSession);
          researchArchive = loaded.entities.length > 0 ? loaded : undefined;
        } catch (err) {
          console.warn('[pi-engine] 研究档案装载失败,按零注入:', err instanceof Error ? err.message : String(err));
        }
      }
      // 1.5.1 专家知识邻域投影（唯一注入路径）：以档案焦点（pending H#/open
      // Q#）+ 最近用户消息为锚，harness 确定性检索注入——零注入语义、会话
      // 内去重、透明标注。security/auto-run 同规则（驱动文本即 harness 载体）。
      const expertKnowledge = scenario.type === 'security' || scenario.type === 'auto-run'
        ? collectExpertInjection({
            archive: researchArchive,
            lastUserText: lastUserTextOf(historyMessages),
            domain,
            sessionId: archiveSession,
          })
        : undefined;
      const append = buildSystemPromptAppend(scenario, {
        runtime: 'builtin',
        distilledMemory: loadDistilledMemoryForPrompt(),
        securityCapabilities: caps,
        securityResearchMemory: scenario.type === 'security'
          ? collectResearchMemory()
          : undefined,
        securityResearchDomain: domain,
        researchArchive,
        expertKnowledge,
        // 1.2.6 批次 C：pi 无宿主 shell——CLI 附录只保留不依赖 shell 的段
        // （cron + aiCanExit 时的 [CRON_TASK_COMPLETE] 自退标记），task CRUD /
        // memory search / panel 等依赖 zhishi CLI 的段不注入（cliHostShell:false）。
        cliToolsEnabled: true,
        cliHostShell: false,
      });
      return append ? `${base}\n\n${append}` : base;
    } catch (err) {
      console.warn('[pi-engine] 系统提示组装失败,落回基座段:', err);
      return base;
    }
  }

  /** 启动一个 turn(fire-and-forget);调用前须确认 !busy。
   *  queueId(B5):本条消息的来源队列项 id——记入 wire 用户消息
   *  (queue:* 事件族按它对账)。 */
  private startPiTurn(input: PiSendInput, resolution: LoopModelResolution, grounding: string, queueId?: string): void {
    const text = input.text.trim();
    this.busy = true;
    this.currentAbort = new AbortController();
    // B3(1.2.6):turn 起跑即快照 sessionId,runPiTurn 收尾(续存/压缩标记/
    // 标题钩子/缺口埋点)一律用快照,不动态读 this.sessionId。
    // 快照语义:turn 运行中 this.sessionId 的唯一合法变更路径是「先 abort 本
    // turn 再换线」(switchPiSession 的 busy 强停、resetPiChat;其余入口——
    // switchEnvSession/rewind/fork——busy 时直接拒绝,不可能改到)。即任何
    // 中途换线都以本 turn 被判死刑为前提,其产出(含 abort 后 loop 解开窗口
    // 里到达的 done.messages)属于起跑时那条线;动态读 this.sessionId 会把
    // 旧 turn 尾部追加进新会话 jsonl(串线)。
    const turnSessionId = this.sessionId;
    // W1 — 状态行数据源:turn 开始(running)。
    this.broadcastChatStatus();

    // 用户气泡:与 SDK 路径同形的 live replay echo(含图片附件形状)。
    const userMessage: MessageWire = {
      id: String(this.messageSeq++),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
      ...(queueId ? { queueId } : {}),
      ...(input.images?.length
        ? { attachments: input.images.map((img, i) => ({ id: String(i), name: img.name, mimeType: img.mimeType, isImage: true })) }
        : {}),
      // 1.3.2 决策注入:live echo 直接带决策块字段(additive)。
      ...(input.decision
        ? {
            kind: 'decision' as const,
            decisionId: input.decision.decisionId,
            choice: input.decision.choice,
            ...(input.decision.note ? { note: input.decision.note } : {}),
            ...(input.decision.expertRefs && input.decision.expertRefs.length > 0 ? { expertRefs: input.decision.expertRefs } : {}),
          }
        : {}),
    };
    this.messages.push(userMessage);
    broadcast('chat:message-replay', { message: userMessage });
    // 1.4.4 研究档案：本轮的来源锚（档案实体 anchorMessageId 指向这里）。
    this.currentTurnUserMessageId = userMessage.id;

    // 会话跨重启绑定(fire-and-forget,不阻塞 turn)。
    void this.ensureSessionBound(text).then(() => {
      if (this.boundSessionMetaId) {
        void updateSessionMetadata(this.boundSessionMetaId, { lastMessagePreview: text.slice(0, 100) }).catch(() => {});
      }
    });

    // system-init(每会话一次,形状对齐 SDK 的 chat:system-init)。
    const env = resolveSessionEnv(this.agentDir);
    // research_log 是 harness 原生能力(写自己的 research_events 库),与环境
    // 无关,始终注册;env_exec 只在锚定环境后存在(结构性边界);delegate_task
    // (W1)需要环境(子 loop 靠 env_exec 查证),同样只在锚定后注册。
    // env_bg(P2 渗透试点前置)同环境绑定:后台进程与环境同生共死。
    const toolNames = [
      ...(env ? [ENV_EXEC_TOOL_NAME, ENV_BG_TOOL_NAME, DELEGATE_TASK_TOOL_NAME] : []),
      RESEARCH_LOG_TOOL_NAME,
      // 1.4.4 研究档案：harness 原生写通道，无条件注册（与 invoke 线一致）。
      RESEARCH_ARCHIVE_TOOL_NAME,
      // intel_search 同 research_log：宿主侧 harness 原生能力，无条件注册。
      INTEL_SEARCH_TOOL_NAME,
      // 1.2.1 专家知识层：expert_search（决策级检索）/ expert_draft（起草待人审），
      // 同 intel_search 无条件注册。
      EXPERT_SEARCH_TOOL_NAME,
      EXPERT_DRAFT_TOOL_NAME,
      // 1.3.2 决策面板：request_decision 无条件注册（宿主原生，不依赖 env）。
      REQUEST_DECISION_TOOL_NAME,
      // 1.4.1 达成宣布：declare_completion 无条件注册（auto loop 验收信号；
      // 交互 turn 无 runner 消费，注册为全场景同一工具集，声明按线分桶不串）。
      DECLARE_COMPLETION_TOOL_NAME,
      // 1.5.3 指针取回：recall 无条件注册（指针卡的配套取回面,宿主原生）。
      RECALL_TOOL_NAME,
    ];
    if (!this.systemInitInfo) {
      this.systemInitInfo = {
        timestamp: new Date().toISOString(),
        cwd: this.agentDir,
        session_id: this.sessionId,
        model: resolution.modelId,
        tools: toolNames,
        permissionMode: input.permissionMode,
      };
      broadcast('chat:system-init', { info: this.systemInitInfo, sessionId: this.sessionId, runtime: 'builtin', engine: 'pi' });
    }

    // 流式 assistant 占位(/chat/stream 重放时按 id 跳过,由 live 事件重建)。
    this.streamingAssistantId = String(this.messageSeq++);
    const assistantMessage: MessageWire = {
      id: this.streamingAssistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
    };
    this.messages.push(assistantMessage);

    // W1 steering(纠偏档):pi 在每个 turn 结束、下一次 LLM 调用前轮询;
    // 取空队列即把运行中发送的消息注入对话(图片不随 steering 注入,v1 纯文本)。
    // B6(1.2.6):注入的 steering user 消息同步补 wire + 广播 replay——它们随
    // done.messages 进 loop 持久化,不进 wire 的话 rewind/fork 的「wire 第 N 条
    // user ↔ loop 第 N 条 user」序数映射错位(截点偏后、裁少了),且重启/重连
    // 回放会冒出 live 时从没上屏的幽灵用户消息。drain 即 push,顺序与持久化
    // 注入顺序一致(steering 必在本 turn 结束前注入,先于下一 turn 的 prompt),
    // 1:1 保持。
    const getSteeringMessages = async (): Promise<AgentMessage[]> => {
      if (this.steering.length === 0) return [];
      const drained = this.steering.splice(0, this.steering.length);
      console.log(`[pi-engine] steering 注入 ${drained.length} 条`);
      for (const item of drained) {
        const wireMsg: MessageWire = {
          id: String(this.messageSeq++),
          role: 'user',
          content: item.input.text.trim(),
          timestamp: new Date().toISOString(),
          queueId: item.queueId,
          // 1.3.2 决策注入(steering 路径):wire 决策块字段与直发路径同形。
          ...(item.input.decision
            ? {
                kind: 'decision' as const,
                decisionId: item.input.decision.decisionId,
                choice: item.input.decision.choice,
                ...(item.input.decision.note ? { note: item.input.decision.note } : {}),
                ...(item.input.decision.expertRefs && item.input.decision.expertRefs.length > 0
                  ? { expertRefs: item.input.decision.expertRefs }
                  : {}),
              }
            : {}),
        };
        this.messages.push(wireMsg);
        broadcast('chat:message-replay', { message: wireMsg });
        // 已离开 steering 队列(注入即消费):清 TUI 队列条目,与 stop/cancel 同事件。
        broadcast('chat:steering-cancelled', { queueId: item.queueId });
      }
      return drained.map((item) => {
        const itemText = item.input.text.trim();
        const base: AgentMessage = {
          role: 'user',
          content: item.grounding ? `${item.grounding}\n\n${itemText}` : itemText,
          timestamp: Date.now(),
        };
        // 决策 marker 随消息进 loop 持久化(done.messages → appendLoopMessages),
        // /chat/stream 重放经 loopMessagesToWire 还原决策块。
        return item.input.decision
          ? ({ ...base, decision: item.input.decision } as AgentMessage)
          : base;
      });
    };

    void this.runPiTurn(input, resolution, env, toolNames, assistantMessage, this.currentAbort, grounding, turnSessionId, getSteeringMessages)
      .catch((err) => {
        console.error('[pi-engine] turn 异常:', err);
        broadcast('chat:message-error', err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        // Phase 3:turn 结束(含 Esc 中断——abort 后 runPiTurn 正常走到这)
        // 回收所有仍在跑的 bg 进程。暂定决策,理由与后续方向见 bg-reap.ts
        // 模块头注释。放在最前:回收的快照同步取,防紧接的 promote 竞态;
        // fire-and-forget,kill 失败绝不阻塞收尾(reapAllBgProcesses 不抛)。
        void reapBgOnLifecyclePoint('turn-end');
        this.busy = false;
        this.streamingAssistantId = null;
        this.currentAbort = null;
        // B5(1.2.6):drain 残留 steering。pi 只在 turn 间轮询 steering
        // (agent-loop.js),agent 收尾走的是 getFollowUpMessages(本引擎没传)
        // ——最后一跳 LLM 期间到达的纠偏永远等不到注入点,会滞留到下一条
        // 无关消息开 turn 时被注入别人的 turn。这里把残留转到 FIFO 队首,
        // 由紧接的 promote 作为独立 turn 开跑。选队首而非队尾的取舍:
        // steering 的语义是「尽快送达的当下纠偏」,排尾会让它落后于更早
        // 排队但意图更旧的 FIFO 项;多条残留保持相互到达序(unshift 展开)。
        if (this.steering.length > 0) {
          const orphaned = this.steering.splice(0, this.steering.length);
          for (const item of orphaned) {
            broadcast('chat:steering-cancelled', { queueId: item.queueId });
          }
          this.queue.unshift(...orphaned);
          console.log(`[pi-engine] ${orphaned.length} 条 steering 未赶上注入,转 FIFO 队首续跑`);
        }
        // W1 — turn done(idle):FIFO 有待接项时不发 idle,紧接的 promote
        // 会立刻发 running,避免状态行闪变。
        if (this.queue.length === 0) this.broadcastChatStatus();
        this.promotePiQueue();
      });
  }

  /** 当前 turn done 后自动接下一条(SDK 的 promote 语义,queue:added isInFlight:true)。 */
  private promotePiQueue(): void {
    const next = this.queue.shift();
    if (!next) return;
    broadcast('queue:added', {
      queueId: next.queueId,
      messageText: next.input.text.trim().slice(0, 100),
      isInFlight: true,
    });
    console.log(`[pi-engine] 自动接下一条 queueId=${next.queueId}(剩余=${this.queue.length})`);
    // startResolvedTurn 同步返回;解析失败(模型不可用)时报错并继续 promote。
    const attempt = (): void => {
      const result = this.startResolvedTurn(next.input, next.grounding, next.queueId);
      if (result.error) {
        console.error('[pi-engine] 队列消息启动失败:', result.error);
        broadcast('chat:message-error', result.error);
        this.promotePiQueue();
      }
    };
    try {
      attempt();
    } catch (err) {
      console.error('[pi-engine] 队列消息启动失败:', err);
      broadcast('chat:message-error', err instanceof Error ? err.message : String(err));
      this.promotePiQueue();
    }
  }

  /**
   * turn 执行栈组装:工具集(env_exec/env_bg/delegate_task 仅锚定环境后注册;
   * research_log/intel/expert/request_decision 宿主原生常驻)+ boundary
   * (含幻觉工具记录,供缺口埋点)+ output-guard。runPiTurn
   * (交互 turn,broadcastEvents=true)与 invokePiSession(B2 cron 独立 invoke
   * 通道,broadcastEvents=false——headless,不往 TUI 广播 bg/subagent 事件)共用。
   * sessionId = 本 turn 的 loop 线快照(request_decision 的归属/注入路由依据)。
   */
  private buildTurnStack(
    env: EnvironmentEntry | null,
    resolution: LoopModelResolution,
    toolNames: string[],
    broadcastEvents: boolean,
    sessionId: string,
    // 1.2.7(域补丁):会话域——子代理继承主 agent 的域(派生时刻任务域已定),
    // 可派发清单按 domain.json subagents 收窄;undefined → 全量(宁多勿缺)。
    domain?: ResearchTaskKind,
    // 1.4.4 档案来源锚取值闭包:交互 turn 读引擎字段(起跑时已写入);
    // headless invoke 线传恒 undefined——全程不碰引擎单例状态(A1-2)。
    getAnchorMessageId: () => string | undefined = () => this.currentTurnUserMessageId,
  ): {
    tools: AgentTool[];
    beforeToolCall: ReturnType<typeof makeBoundaryHook>;
    afterToolCall: ReturnType<typeof makeOutputGuardHook>;
    blockedToolNames: string[];
  } {
    const tools: AgentTool[] = [
      ...(env ? [createEnvExecTool(env)] : []),
      createResearchLogTool(this.agentDir),
      // 1.4.4 研究档案：显式研究状态的写通道（宿主原生，无条件注册——
      // 档案归属本 turn 快照线；来源锚按 turn 上下文取值：交互 turn 取当前轮
      // user 消息 id，headless invoke 线恒 undefined）。广播恒开：auto-run
      // 线也要推 archive:changed 给 GUI。
      createArchiveTool({
        getSessionId: () => sessionId,
        getAnchor: () => ({ messageId: getAnchorMessageId() }),
        broadcastFn: broadcast,
      }),
      // 1.1.2 情报横切：宿主侧情报检索，无条件注册（不依赖 env）。
      createIntelSearchTool(),
      // 1.2.1 专家知识层：决策级检索 + 起草通道，同 intel_search 无条件注册。
      createExpertSearchTool(),
      createExpertDraftTool(),
      // 1.3.2 决策面板：request_decision 无条件注册；归属线 = 本 turn 快照线。
      createDecisionTool({ getSessionId: () => sessionId }),
      // 1.4.1 达成宣布：declare_completion 无条件注册；归属线 = 本 turn 快照线
      // （auto-run runner 按 loopSessionId 取走声明，交互线声明无人消费即无害）。
      createDeclareCompletionTool({ getSessionId: () => sessionId }),
      // 1.5.3 指针取回：recall 无条件注册——压缩指针卡的配套取回面
      // （归属线 = 本 turn 快照线,与收割侧车同目录）。
      createRecallTool({ getSessionId: () => sessionId }),
    ];
    if (env) {
      // W1(design-spec §8)— delegate_task 接回生产路径。深度限 1 由 subagent
      // 结构性保证(子 loop 默认工具集只有 env_exec);生命周期广播
      // chat:subagent-started/finished(finished 带结论摘要,截断 200 字,
      // 不带过程),子 loop 工具事件映射 chat:subagent-tool-*。
      tools.push(createEnvBgTool(env, broadcastEvents
        ? {
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
          }
        : {}));
      tools.push(createDelegateTaskTool({
        env,
        resolution,
        parentAllowedTools: toolNames,
        // 1.1.10(A′)— 子 loop 持久化:与主会话同一 loop-sessions 默认目录,
        // loadLoopSession 可按 sessionId 读回(transcript 只读查看)。
        storeDir: defaultLoopSessionDir(),
        // 子代理定义(bundled-agents)engine 装载——按会话域收窄(1.2.7 域补丁:
        // 子代理继承主 agent 的域,不跨域自选;无域全量)。skill 注入层 1.5.1
        // 已删——子代理提示正文自包含,frontmatter skills 字段仅声明保留。
        agents: filterAgentsByDomain(loadBundledAgents(), domain).map((a) => ({ name: a.name, body: a.body })),
        ...(broadcastEvents
          ? {
              notify: {
                started: (taskId, description) => {
                  broadcast('chat:subagent-started', { taskId, description });
                },
                finished: (taskId, description, summary, error, sessionId) => {
                  const trimmed = summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
                  broadcast('chat:subagent-finished', {
                    taskId,
                    description,
                    summary: trimmed,
                    status: error ? 'failed' : 'completed',
                    ...(error ? { error } : {}),
                    // A′ — 子 loop 的 loop-sessions id,TUI 据此拉 transcript。
                    ...(sessionId ? { loopSessionId: sessionId } : {}),
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
            }
          : {}),
      }));
    }
    // 结构性白名单——boundary 据此把幻觉工具(白名单外)拦下并记入缺口埋点。
    const effectiveToolNames = toolNames;
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
    return { tools, beforeToolCall, afterToolCall, blockedToolNames };
  }

  private async runPiTurn(
    input: PiSendInput,
    resolution: LoopModelResolution,
    env: EnvironmentEntry | null,
    toolNames: string[],
    assistantMessage: MessageWire,
    abort: AbortController,
    grounding: string,
    // B3(1.2.6):起跑时的 sessionId 快照(语义见 startPiTurn 快照点注释)。
    // 本函数内一切按线读写(历史加载/续存/压缩标记/标题钩子/缺口埋点)
    // 一律用快照,不动态读 this.sessionId——否则 busy 强停换线后,旧 turn
    // 的尾部会写进新会话的 jsonl(串线)。
    turnSessionId: string,
    // W1 steering 轮询闭包——由 startPiTurn 构造注入(闭包本体注释见构造点)。
    getSteeringMessages: () => Promise<AgentMessage[]>,
  ): Promise<void> {
    const startedAt = Date.now();
    // grounding(W1 @ 注入)只进 loop prompt,不进用户气泡(气泡显示原文)。
    const text = input.text.trim();
    const promptText = grounding ? `${grounding}\n\n${text}` : text;
    const stored = loadLoopSession(turnSessionId);
    const history = stored.messages;

    // 1.2.7(域补丁):域判定一次算出,系统提示(skills/caps/研究记忆)与
    // 执行栈(子代理清单按域收窄)共用同一 domain——同一 turn 内域只有
    // 一个事实源,不会提示说一套、可派发子代理是另一套。
    const scenario = resolvePiScenario();
    const caps = scenario.type === 'security'
      ? await collectSecurityCapabilities(this.agentDir)
      : undefined;
    const domain = caps ? resolveSessionDomain(history, caps) : undefined;
    const { tools, beforeToolCall, afterToolCall, blockedToolNames } =
      this.buildTurnStack(env, resolution, toolNames, true, turnSessionId, domain);
    // 1.2.6（C-11）：压缩阈值估算纳入系统提示——提示先于 transform 组装,
    // 系统提示按 chars/2 折算进阈值（estimateMessagesTokens 口径,中英混合
    // 保守折算;与消息体的 chars/4 启发式不同）。
    const systemPrompt = await this.assemblePiSystemPrompt(
      env,
      scenario,
      // A2-2(1.5.4):注入锚点补当前轮用户消息——history 是当轮 prompt 之前
      // 的历史,不含本轮;补上后当前话题当轮参与专家注入打分(首轮也可注入)。
      [...history, { role: 'user', content: promptText, timestamp: startedAt } as AgentMessage],
      { caps, domain },
      turnSessionId,
    );
    const contextWindow = resolution.model.contextWindow || 200_000;
    // 1.5.3:校准系数从会话 meta 读（真实 API ÷ 启发式,上轮学习落盘）;
    // 本轮是否触发过压缩由 onCompact 闭包打标——压缩过的轮次不学习
    // (锚被污染:压缩轮 usage 是裁后体量,学进去系数会塌)。
    let compactedThisTurn = false;
    const onCompactMark = () => {
      compactedThisTurn = true;
      void markLoopSessionCompacted(turnSessionId).catch(() => {});
    };
    const transformOptions = { sessionId: turnSessionId };
    const transformContext = makeCompactionTransform(
      { contextWindow, systemPromptChars: systemPrompt.length, calibration: stored.meta?.tokenCalibration },
      onCompactMark,
      transformOptions,
    );

    // 图片输入:pi user 消息的 image 块(与文本同一条消息)。
    const promptContent: (TextContent | ImageContent)[] | undefined = input.images?.length
      ? [
          { type: 'text', text: promptText },
          ...input.images.map((img): ImageContent => ({ type: 'image', data: img.data, mimeType: img.mimeType })),
        ]
      : undefined;
    // 1.3.2 决策注入:决策消息无图片,走 messages 形态带 decision marker
    // (随 done.messages 进 loop 持久化,重放经 loopMessagesToWire 还原)。
    const decisionPromptMessage: AgentMessage | undefined = input.decision && !promptContent
      ? ({ role: 'user', content: promptText, timestamp: Date.now(), decision: input.decision } as AgentMessage)
      : undefined;

    let fullText = '';
    let lastUsage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null = null;
    let doneMessages: AgentMessage[] = [];
    let failed: string | null = null;

    // 1.2.7(§四) 溢出兜底:pi agentLoop 无内建压缩重试——done 时按
    // isContextOverflow 判定(provider 错误正则/静默溢出/length 截断),命中
    // 则用强制压缩(FORCE_COMPACTION_RATIO 激进预算)重跑本 turn,
    // 每 turn 限 1 次(pi 文档的 one bounded compact-and-retry);再溢出由
    // 压缩侧 stillOver 日志引导 /reset。只对 stopReason=error 的失败 turn
    // 重试(failed 非空):静默溢出是正常完成,下一次调用的 transform 阈值
    // 判定自会压缩,重试纯属浪费。
    let overflowRetried = false;
    for (;;) {
      fullText = '';
      lastUsage = null;
      doneMessages = [];
      failed = null;
      let willRetry = false;
      // 溢出错误条延迟裁决:pi 契约里 error 恒由 agent_end 紧随 done 收尾,
      // 到 done 才能判定是否压缩重试——重试则这条错误条与本次
      // message-complete 都是噪音(重试续同一气泡),丢弃;不重试在 done
      // 前补播,保序。
      let deferredError: SseOut[] | null = null;
      const attemptTransform = overflowRetried
        ? makeCompactionTransform(
            // 强制压缩重试:ratio 0.25(活体实测修正——0 会把上下文压到
            // 几千 tok 的残渣,模型只剩 stub 可读;0.25 是「激进取舍但
            // 留出真实工作上下文」的预算)。1.5.3:溢出档与阈值档同一收割
            // 流程(同 options),裁掉的内容一样进侧车。
            { contextWindow, systemPromptChars: systemPrompt.length, thresholdRatio: FORCE_COMPACTION_RATIO },
            onCompactMark,
            transformOptions,
          )
        : transformContext;
      for await (const event of runLoop({
        ...(decisionPromptMessage
          ? { messages: [decisionPromptMessage] }
          : promptContent
            ? { messages: [{ role: 'user', content: promptContent, timestamp: Date.now() } as AgentMessage] }
            : { prompt: promptText }),
        history,
        systemPrompt,
        model: resolution.model,
        models: resolution.models,
        getApiKey: resolution.getApiKey,
        tools,
        signal: abort.signal,
        beforeToolCall,
        afterToolCall,
        transformContext: attemptTransform,
        // W1 steering(纠偏档):闭包由 startPiTurn 构造注入(B6 补 wire +
        // B5 归属登记都在构造点);pi 在 turn 间轮询,返回 [] = 无注入。
        getSteeringMessages,
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
          willRetry = !overflowRetried && !!failed && !abort.signal.aborted
            && !!lastAssistant && isContextOverflow(lastAssistant, contextWindow);
        }
        if (event.type === 'error') {
          // 用户主动中断(Esc/stop)的 turn 收尾错误不上屏——中断分隔线已告知,
          // 红色 "This operation was aborted" 错误条是纯噪音(活体实测);
          // 非中断错误延迟到 done 裁决(溢出重试则丢弃)。
          if (!abort.signal.aborted) deferredError = mapLoopEventToSse(event, { model: resolution.modelId, startedAt });
          continue;
        }
        if (event.type === 'done') {
          if (willRetry) continue;
          if (deferredError) {
            for (const sse of deferredError) broadcast(sse.event, sse.data);
            deferredError = null;
          }
        }
        for (const sse of mapLoopEventToSse(event, { model: resolution.modelId, startedAt })) {
          broadcast(sse.event, sse.data);
        }
      }
      if (!willRetry) {
        // 防御:流异常结束(无 done)时补播延迟的错误条,不吞错。
        if (deferredError) for (const sse of deferredError) broadcast(sse.event, sse.data);
        break;
      }
      overflowRetried = true;
      console.warn(`[pi-engine] 上下文溢出(${failed ?? 'unknown'}),强制压缩后重试本 turn(限 1 次)`);
    }

    // 落终态:assistant 气泡内容 + 会话续存(done.messages 只含新增,无重复)。
    // B3:续存目标 = 起跑快照线,不是 this.sessionId(中途换线不串线)。
    assistantMessage.content = fullText;
    // 1.5.3 校准学习:仅未压缩轮次(压缩轮 usage 是裁后体量,学进去系数
    // 会塌)。真实 API usage ÷ 同内容启发式估算——分子(末次 LLM 调用实测
    // input)含当轮新增消息,分母也必须含(history + doneMessages),否则
    // 口径错位比值恒 >1,工具密集轮顶到钳位。钳 [0.8, 6] 防离群,
    // 经 appendLoopMessages meta 落盘供下轮 evaluateCompaction 乘用。
    let learnedCalibration: number | undefined;
    if (lastUsage && !compactedThisTurn) {
      const heuristic = estimateMessagesTokens([...history, ...doneMessages], systemPrompt.length);
      const real = lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite;
      if (heuristic > 0 && real > 0) {
        const c = real / heuristic;
        if (Number.isFinite(c)) learnedCalibration = Math.min(6, Math.max(0.8, c));
      }
    }
    if (doneMessages.length > 0) {
      await appendLoopMessages(
        turnSessionId,
        doneMessages,
        { model: resolution.modelId, providerId: resolution.providerId, tokenCalibration: learnedCalibration },
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
    firePostTurnTitleHook(turnSessionId, resolution.modelId, input.providerEnv);
    // 2) 能力缺口事件(WORK_LOOP §5):幻觉工具被 boundary 白名单拦截 /
    //    上游报 unknown skill/tool → gap_events(懒加载 store,静默失败)。
    this.recordGapEvents(failed, blockedToolNames, turnSessionId);

    if (failed && !abort.signal.aborted) {
      console.error(`[pi-engine] turn 失败: ${failed}`);
    }
  }

  /**
   * 能力缺口埋点(对齐原 SDK turn 完成点 logGapEvent 的 schema):
   * 幻觉工具(白名单外 toolName 被拦)= 模型想要不存在的能力;
   * 上游 unknown skill/tool 错误 = provider 侧缺口。
   * B3(1.2.6):context 由调用方传入 turn 起跑快照线,不动态读 this.sessionId。
   */
  private recordGapEvents(failed: string | null, blockedToolNames: string[], turnSessionId: string): void {
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
          context: turnSessionId,
          resolution: 'abandoned',
        }))
        .catch(() => { /* 缺口记录失败静默——主流程优先 */ });
    }
  }

  /** B2(1.2.6):引擎当前线的只读快照(cron 无 sessionId 时「跟随当前线」
   *  语义的数据源)。只读——invoke 通道据此写同一条线而不动引擎状态。 */
  getPiCurrentSessionRef(): { loopSessionId: string; sessionMetaId: string | null } {
    return { loopSessionId: this.sessionId, sessionMetaId: this.boundSessionMetaId };
  }

  /**
   * 1.3.2 决策注入——把人的决定作为 user 消息注入回 loop,复用 steering/
   * 直发通道的全部既有语义(B3 turn 快照线、B6 补 wire):
   *   - 归属线 = 当前引擎线(decision.sessionId):走 sendPiChatMessage——
   *     busy 进 steering(pi 在 turn 间轮询注入,随 done.messages 持久化),
   *     闲时直发新 turn;wire 决策块 + broadcast 与普通消息同路径;
   *   - 跨线(决策来自 cron invoke 等 headless 线):走 invokePiSession 独立
   *     通道注入到那条线(jsonl 持久化,不动引擎单例,不串线)。
   */
  async injectDecision(decision: {
    decisionId: string;
    sessionId: string;
    question?: string;
    choice: string;
    note?: string;
    expertRefs?: string[];
  }): Promise<{ success: boolean; error?: string }> {
    const meta: DecisionMeta = {
      decisionId: decision.decisionId,
      choice: decision.choice,
      ...(decision.note ? { note: decision.note } : {}),
      ...(decision.expertRefs && decision.expertRefs.length > 0 ? { expertRefs: decision.expertRefs } : {}),
    };
    const text = formatDecisionInjectionContent(decision);
    if (decision.sessionId !== this.sessionId) {
      // 跨线:headless 注入到正确的那条线(读其历史、续存回同一条线)。
      const r = await invokePiSession({ text, decision: meta }, { loopSessionId: decision.sessionId });
      return { success: !r.error, ...(r.error ? { error: r.error } : {}) };
    }
    const result = await this.sendPiChatMessage({ text, decision: meta });
    if (result.error) return { success: false, error: result.error };
    return { success: true };
  }

  /**
   * B2(1.2.6)— cron 独立 invoke 通道:对指定 loop 线跑一次完整 agent turn
   * (读该线历史 → runLoop 带全套工具/边界/审计/压缩 → 新增消息续存回同一
   * 条线),全程不碰引擎单例的 sessionId/messages/steering/queue/busy,不广播
   * 任何 TUI 事件(headless)。与单例写同一条线时靠 appendLoopMessages 的
   * 文件锁串行化,无丢更新(历史快照各自为政,与旧「cron 跟随当前线」语义
   * 一致,但不再互相杀 turn、不再混 steering)。
   *
   * 与单例 turn 的差异(刻意):
   *   - 无 steering(headless 没有纠偏方)、无 SSE 广播、无 wire 回放;
   *   - scenario 由调用方显式传入(cron 场景),不吃全局 currentScenario 的
   *     set/reset 时序(异步 execute 路径旧有时序窗:reset 先于系统提示组装);
   *   - 答案取 done.messages 里最后一条 assistant 的文本(多跳 turn 拼接的
   *     fullText 只是兜底);
   *   - timeoutMs 到期按失败返回但【不中断】loop(「等结果,不是取消」
   *     语义)——loop 在后台跑完并自行续存。
   */
  async invokePiSession(
    input: PiSendInput,
    options: {
      /** 目标 loop 线;缺省 → 一次性新线(仍落盘,可审计)。 */
      loopSessionId?: string;
      /** 显式交互场景(cron 传 cron 场景);缺省读全局(与交互 turn 同)。 */
      scenario?: InteractionScenario;
      /** 调用方等待上限;到期返回 error 但 loop 继续在后台跑完。 */
      timeoutMs?: number;
    } = {},
  ): Promise<{ text: string; error?: string; loopSessionId: string }> {
    const loopSessionId = options.loopSessionId ?? newLoopSessionId();
    const resolution = input.providerEnv
      ? resolveLoopModelFromEnv(input.providerEnv, input.model ?? '')
      : resolveLoopModel();
    if (!resolution) {
      return { text: '', error: PI_NO_PROVIDER_ERROR, loopSessionId };
    }
    const env = resolveSessionEnv(this.agentDir);
    const toolNames = [
      ...(env ? [ENV_EXEC_TOOL_NAME, ENV_BG_TOOL_NAME, DELEGATE_TASK_TOOL_NAME] : []),
      RESEARCH_LOG_TOOL_NAME,
      RESEARCH_ARCHIVE_TOOL_NAME,
      INTEL_SEARCH_TOOL_NAME,
      EXPERT_SEARCH_TOOL_NAME,
      EXPERT_DRAFT_TOOL_NAME,
      REQUEST_DECISION_TOOL_NAME,
      DECLARE_COMPLETION_TOOL_NAME,
      RECALL_TOOL_NAME,
    ];
    const storedInvoke = loadLoopSession(loopSessionId);
    const history = storedInvoke.messages;
    // 1.2.7(域补丁):与交互 turn 同——域判定一次算出,执行栈与系统提示共用。
    const scenario = options.scenario ?? resolvePiScenario();
    const caps = scenario.type === 'security'
      ? await collectSecurityCapabilities(this.agentDir)
      : undefined;
    const domain = caps ? resolveSessionDomain(history, caps) : undefined;
    const { tools, beforeToolCall, afterToolCall, blockedToolNames } =
      // 1.4.4 档案来源锚:headless 线无 wire user 消息,锚恒 undefined——
      // 经参数下传,不碰引擎单例字段(A1-2)。
      this.buildTurnStack(env, resolution, toolNames, false, loopSessionId, domain, () => undefined);
    const systemPrompt = await this.assemblePiSystemPrompt(
      env,
      scenario,
      // A2-2(1.5.4):与交互 turn 同——注入锚点补当前轮用户消息。
      [...history, { role: 'user', content: input.text.trim(), timestamp: Date.now() } as AgentMessage],
      { caps, domain },
      loopSessionId,
    );
    const contextWindow = resolution.model.contextWindow || 200_000;
    // 1.5.3:与交互 turn 同一接线——meta 校准系数 + 收割 options;压缩
    // 轮次由 onCompactMark 打标,不学习(锚被污染)。
    let compactedThisTurn = false;
    const onCompactMark = () => {
      compactedThisTurn = true;
      void markLoopSessionCompacted(loopSessionId).catch(() => {});
    };
    const transformOptions = { sessionId: loopSessionId };
    const transformContext = makeCompactionTransform(
      { contextWindow, systemPromptChars: systemPrompt.length, calibration: storedInvoke.meta?.tokenCalibration },
      onCompactMark,
      transformOptions,
    );

    const run = async (): Promise<{ text: string; error?: string }> => {
      let fullText = '';
      let doneMessages: AgentMessage[] = [];
      let failed: string | null = null;
      // 1.2.7(§四) 溢出兜底:与单例 turn 同语义——isContextOverflow 命中则
      // 强制压缩(FORCE_COMPACTION_RATIO)重跑一次,限 1 次;headless 无广播要裁决。
      let overflowRetried = false;
      for (;;) {
        fullText = '';
        doneMessages = [];
        failed = null;
        const attemptTransform = overflowRetried
          ? makeCompactionTransform(
              { contextWindow, systemPromptChars: systemPrompt.length, thresholdRatio: FORCE_COMPACTION_RATIO },
              onCompactMark,
              transformOptions,
            )
          : transformContext;
        for await (const event of runLoop({
          ...(input.decision
            ? { messages: [{ role: 'user', content: input.text.trim(), timestamp: Date.now(), decision: input.decision } as AgentMessage] }
            : { prompt: input.text.trim() }),
          history,
          systemPrompt,
          model: resolution.model,
          models: resolution.models,
          getApiKey: resolution.getApiKey,
          tools,
          beforeToolCall,
          afterToolCall,
          transformContext: attemptTransform,
          reasoning: resolution.model.reasoning ? 'low' : undefined,
        })) {
          if (event.type === 'text-delta') fullText += event.delta;
          if (event.type === 'error') failed = event.error;
          if (event.type === 'done') doneMessages = event.messages;
        }
        const lastAssistantMsg = [...doneMessages].reverse().find((m) => m.role === 'assistant');
        const willRetry = !overflowRetried && !!failed && !!lastAssistantMsg
          && isContextOverflow(lastAssistantMsg, contextWindow);
        if (!willRetry) break;
        overflowRetried = true;
        console.warn(`[pi-engine] invoke 上下文溢出(${failed ?? 'unknown'}),强制压缩后重试本 turn(限 1 次)`);
      }
      // 1.5.3 校准学习（与交互 turn 同口径）：未压缩轮次才学,钳 [0.8, 6]。
      // 分子(末次调用实测 input)含当轮新增,分母同口径取 history + doneMessages。
      let learnedCalibration: number | undefined;
      const lastUsageMsg = [...doneMessages].reverse().find((m) => m.role === 'assistant');
      if (lastUsageMsg?.usage && !compactedThisTurn) {
        const heuristic = estimateMessagesTokens([...history, ...doneMessages], systemPrompt.length);
        const u = lastUsageMsg.usage;
        const real = u.input + u.cacheRead + u.cacheWrite;
        if (heuristic > 0 && real > 0) {
          const c = real / heuristic;
          if (Number.isFinite(c)) learnedCalibration = Math.min(6, Math.max(0.8, c));
        }
      }
      if (doneMessages.length > 0) {
        await appendLoopMessages(
          loopSessionId,
          doneMessages,
          { model: resolution.modelId, providerId: resolution.providerId, tokenCalibration: learnedCalibration },
        ).catch((err) => console.warn('[pi-engine] invoke 续存失败:', err));
      }
      // 与单例 turn 收尾同款的挂点(缺口埋点/bg 回收),目标都是本条线。
      // 标题钩子对 invoke 线跳过(headless 线无 SessionStore 元数据可标,
      // 且其 generateAndApplyTitle 尾段会 broadcast chat:session-title-changed
      // ——invoke 契约零广播);bg 回收照做但不广播(broadcast:false)。
      this.recordGapEvents(failed, blockedToolNames, loopSessionId);
      void reapBgOnLifecyclePoint('turn-end', { broadcast: false });
      const lastAssistant = [...doneMessages].reverse().find((m) => m.role === 'assistant');
      const text = lastAssistant
        ? lastAssistant.content.filter((c): c is TextContent => c.type === 'text').map((c) => c.text).join('\n')
        : fullText;
      return failed ? { text, error: failed } : { text };
    };

    // run 不抛(runLoop 以 error 事件收尾,续存已 catch);再包一层保险,
    // detach(超时)路径也不留 unhandled rejection。
    const safeRun = run().then(
      (r) => r,
      (err): { text: string; error: string } => ({ text: '', error: err instanceof Error ? err.message : String(err) }),
    );
    if (!options.timeoutMs) {
      return { ...(await safeRun), loopSessionId };
    }
    const outcome = await Promise.race([
      safeRun,
      new Promise<null>((r) => setTimeout(() => r(null), options.timeoutMs)),
    ]);
    if (outcome === null) {
      return { text: '', error: `等待 turn 完成超时(${options.timeoutMs}ms)`, loopSessionId };
    }
    return { ...outcome, loopSessionId };
  }

  /**
   * /sessions/switch 的 pi 路径:切到 SessionStore 里另一条会话
   * (其 loopSessionId 指向的 loop-sessions 文件),重建回放。
   * 1.2.6(B1):meta 无 loopSessionId 绑定(cron new_session 新建)时
   * 当场开新线并绑定;只有 meta 不存在才返回 false。
   *
   * B2(1.2.6)论证:本函数刻意【不】刷新 env-sessions 映射与 currentEnvKey。
   * 分线映射(workspace × envKey → loopSessionId)的所有权在环境选定流
   * (environment/select → switchEnvSession / restore / persistEnvSessionLine /
   * reset);/sessions/switch 是「按 meta 开任意会话」的显式动作,目标会话
   * 可能属于任何环境线(或 fork 线)——把它的 sessionId 钉进「当前 envKey」
   * 映射正是 B2c 的错位污染;反过来把 currentEnvKey 改成「目标线的环境」
   * 则会让环境选定落盘状态与引擎认知脱节(select 并没发生)。1.2.6 起 cron
   * 走 invokePiSession 独立通道,不再经本函数切引擎,B2b(TUI 重接幂等闸
   * 不命中 → 强停 cron turn)/B2c(旧线回填写错映射)的 cron 切面随之消失。
   */
  async switchPiSession(metaId: string): Promise<boolean> {
    // 已在当前会话:幂等返回——不重建回放、更不要 busy 强停(TUI 启动会按
    // 环境分线映射重接当前会话,误伤进行中的 turn,如 cron)。
    if (metaId === this.boundSessionMetaId) return true;
    if (this.busy) this.stopPiChat();
    // B1 愈合走 ensureMetaLoopLine(B2 抽出的引擎无关版,cron invoke 通道
    // 同用):meta 存在但无 loopSessionId 绑定(cron new_session 的
    // createSession 不落 loopSessionId,唯一写入点是 ensureSessionBound——
    // 而绑定建立以引擎已在这条线上为前提,死锁)→ 当场开新线并绑定,而非
    // 返回 false 让调用方 500。reset 解绑过的 meta 走同一路径愈合(重开新线)。
    // 分线语义(1.1.6)不变:env-sessions 映射仍只在绑定后由写盘点回填,
    // 新线等首个 turn 的 appendLoopMessages 落盘,与 ensureSessionBound 同构。
    const loopId = await ensureMetaLoopLine(metaId);
    if (!loopId) return false;
    const stored = loadLoopSession(loopId);
    this.queue = [];
    this.steering = [];
    this.sessionId = loopId;
    this.boundSessionMetaId = metaId;
    // B10(1.2.6):切换即写配置面会话标识(getSessionId 的消费者——cron
    // execute-sync 回报/skip-switch、sessions 路由 in-memory 合并——都读它)。
    setActiveSessionId(metaId);
    this.messageSeq = 0;
    this.messages = this.loopMessagesToWire(stored.messages);
    this.streamingAssistantId = null;
    this.systemInitInfo = null;
    console.log(`[pi-engine] 切换会话 → ${metaId}(loop=${this.sessionId},${stored.messages.length} 条)`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // 环境分线(1.1.6 #4):environment/select 联动切线
  // ---------------------------------------------------------------------------

  /** 切环境前置闸:目标是本引擎 workspace 且 turn 进行中 → 拒绝文案(rewind/fork
   *  同口径);其余 workspace 的选定与本引擎无关(sidecar 按 workspace 一个实例)。 */
  envSwitchBlocker(workspace: string): string | null {
    if (!this.agentDir || normalizeWorkspaceKey(workspace) !== normalizeWorkspaceKey(this.agentDir)) return null;
    return this.busy ? '响应进行中,先 Esc 停止再切换环境' : null;
  }

  /**
   * environment/select 落盘后的联动切线。有映射 → 接该 loopSessionId 的线
   * (状态重置清单对齐 switchPiSession;busy 已在入口拒绝,这里不强停);
   * 无映射/映射失效 → 开新线(不清映射——新线等 ensureSessionBound 绑定后
   * 由 persistEnvSessionLine 回填,确保映射不指向不存在的线)。
   */
  async switchEnvSession(workspace: string, envKey: string): Promise<{ ok: boolean; error?: string }> {
    // 别的 workspace 的选定,本引擎不动
    if (!this.agentDir || normalizeWorkspaceKey(workspace) !== normalizeWorkspaceKey(this.agentDir)) {
      return { ok: true };
    }
    if (this.busy) return { ok: false, error: '响应进行中,先 Esc 停止再切换环境' };
    // 重选同一环境且线已就位:幂等,不重放重建(启动 gate 重选当前环境是常态)。
    if (envKey === this.currentEnvKey && this.boundSessionMetaId) return { ok: true };
    // 旧线回填:当前线已绑定,先把「旧环境键 → 当前 sessionId」写盘,防旧线丢映射。
    await this.persistEnvSessionLine();
    // 回填写盘让出事件循环期间可能有新 turn 起跑——复查,撞车则放弃本次切换
    // (选定已落盘,返回错误由调用方上抛,重选即愈合)。
    if (this.busy) return { ok: false, error: '响应进行中,先 Esc 停止再切换环境' };
    const line = getEnvSessionLine(loadEnvSessionsMap(), this.agentDir, envKey);
    const stored = line ? loadLoopSession(line.loopSessionId) : null;
    this.queue = [];
    this.steering = [];
    this.messageSeq = 0;
    this.streamingAssistantId = null;
    this.systemInitInfo = null;
    if (line && stored && stored.messages.length > 0) {
      this.sessionId = line.loopSessionId;
      this.boundSessionMetaId = this.findBoundMetaId(line.loopSessionId);
      this.messages = this.loopMessagesToWire(stored.messages);
      console.log(`[pi-engine] 环境分线 → 接线 ${envKey}(loop=${this.sessionId},${stored.messages.length} 条)`);
    } else {
      this.sessionId = newLoopSessionId();
      this.boundSessionMetaId = null;
      this.messages = [];
      console.log(`[pi-engine] 环境分线 → 新线 ${envKey}(loop=${this.sessionId})`);
    }
    // B10(1.2.6):切线即写配置面会话标识——有绑定写 meta id,无绑定(新线/
    // 绑定丢失)置新随机值(对齐 initializeAgent 的占位语义),getSessionId()
    // 不再回报引擎已离开的僵尸会话。
    setActiveSessionId(this.boundSessionMetaId ?? randomUUID());
    this.currentEnvKey = envKey;
    return { ok: true };
  }

  /** /chat/stop 的 pi 路径:清空 FIFO 队列(逐条 queue:cancelled)+ 清空
   *  steering 队列(逐条 chat:steering-cancelled,与 FIFO 同)+ abort 当前 turn。 */
  stopPiChat(): boolean {
    let acted = false;
    for (const item of this.queue) {
      broadcast('queue:cancelled', { queueId: item.queueId });
      acted = true;
    }
    this.queue = [];
    for (const item of this.steering) {
      broadcast('chat:steering-cancelled', { queueId: item.queueId });
      acted = true;
    }
    this.steering = [];
    if (this.busy && this.currentAbort) {
      this.currentAbort.abort();
      broadcast('chat:message-stopped', null);
      acted = true;
    }
    // W1 — stop 后状态回 idle(turn 收尾的 finally 会再发一次同值,幂等)。
    if (acted) broadcast('chat:status', { sessionState: 'idle' });
    return acted;
  }

  /** /chat/queue/cancel 的 pi 路径:移除排队项(FIFO 或 steering)并广播取消。 */
  cancelPiQueueItem(queueId: string): string | null {
    const idx = this.queue.findIndex((item) => item.queueId === queueId);
    if (idx >= 0) {
      const [item] = this.queue.splice(idx, 1);
      broadcast('queue:cancelled', { queueId });
      return item.input.text;
    }
    const steeringIdx = this.steering.findIndex((item) => item.queueId === queueId);
    if (steeringIdx >= 0) {
      const [item] = this.steering.splice(steeringIdx, 1);
      broadcast('chat:steering-cancelled', { queueId });
      return item.input.text;
    }
    return null;
  }

  /** /chat/queue/status 的 pi 路径:FIFO 排队 + steering 队列(kind 区分)。 */
  getPiQueueStatus(): Array<{ id: string; messagePreview: string; kind: 'fifo' | 'steering' }> {
    return [
      ...this.queue.map((item) => ({
        id: item.queueId,
        messagePreview: item.input.text.trim().slice(0, 100),
        kind: 'fifo' as const,
      })),
      ...this.steering.map((item) => ({
        id: item.queueId,
        messagePreview: item.input.text.trim().slice(0, 100),
        kind: 'steering' as const,
      })),
    ];
  }

  /** /chat/reset 的 pi 路径:新会话 id + 清状态(loop-sessions 旧文件保留,可审计)。
   *  关键:旧元数据上的 loopSessionId 绑定必须同步摘掉——否则 /sessions/switch
   *  或 sidecar 重启的 restore 会按旧绑定把 reset 前的历史整个复活(活体发现)。 */
  resetPiChat(): void {
    if (this.currentAbort) this.currentAbort.abort();
    for (const item of this.queue) {
      broadcast('queue:cancelled', { queueId: item.queueId });
    }
    this.queue = [];
    for (const item of this.steering) {
      broadcast('chat:steering-cancelled', { queueId: item.queueId });
    }
    this.steering = [];
    if (this.boundSessionMetaId) {
      const staleMetaId = this.boundSessionMetaId;
      void updateSessionMetadata(staleMetaId, { loopSessionId: null } as unknown as Partial<SessionMetadata>).catch(
        (err) => console.warn('[pi-engine] reset 解绑旧 loopSessionId 失败:', err),
      );
    }
    // 1.1.6 #4:同步清当前环境键的分线映射——否则 reset 后按映射恢复会把
    // reset 前的历史整个复活(与上面摘 loopSessionId 绑定同一类活体事故)。
    void removeEnvSessionLine(this.agentDir, this.currentEnvKey).catch(
      (err) => console.warn('[pi-engine] reset 清 env-sessions 映射失败:', err),
    );
    this.sessionId = newLoopSessionId();
    this.boundSessionMetaId = null;
    // B10(1.2.6):reset 后引擎已离开旧 meta——配置面会话标识置新随机值
    // (对齐 initializeAgent 占位语义),cron 回报不再拿到僵尸 id。
    setActiveSessionId(randomUUID());
    this.messages = [];
    this.messageSeq = 0;
    this.streamingAssistantId = null;
    this.systemInitInfo = null;
    this.busy = false;
    this.currentAbort = null;
    // Phase 3:reset 同样回收 bg 进程。与上面 abort 触发的 turn 收尾
    // finally 钩子幂等——turn-end 回收先跑一轮,这里只处理残留(通道
    // 失败被保留的登记)。fire-and-forget,不阻塞 reset 返回。
    void reapBgOnLifecyclePoint('reset');
    // W1 — reset 后状态回 idle。
    broadcast('chat:status', { sessionState: 'idle' });
  }

  /**
   * /chat/rewind 的 pi 路径:截断到指定用户消息**之前**(SDK rewind 语义:
   * 该消息及其后全部移除,用户可改完后重发)。loop-sessions 是追加日志,
   * 截断即时间回溯;内存消息按截断后的 loop 历史重建。
   */
  async rewindPiChat(userMessageId: string): Promise<{ success: boolean; error?: string }> {
    if (this.busy) return { success: false, error: '响应进行中,先停止再 rewind' };
    const idx = this.messages.findIndex((m) => m.id === userMessageId && m.role === 'user');
    if (idx < 0) return { success: false, error: 'Message not found' };

    // wire 里第 N 条 user 消息(0 起)对应 loop 历史里第 N 条 role=user 消息。
    // B6(1.2.6)后该映射含 steering 注入:注入即补 wire(drain 顺序 = 持久化
    // 注入顺序,且必先于下一 turn 的 prompt),wire 与 loop 的 user 序列 1:1。
    const userOrdinal = this.messages.slice(0, idx).filter((m) => m.role === 'user').length;
    const loopMessages = loadLoopSession(this.sessionId).messages;
    let seen = -1;
    let cutIndex = loopMessages.length;
    for (let i = 0; i < loopMessages.length; i++) {
      if (loopMessages[i].role === 'user') {
        seen++;
        if (seen === userOrdinal) { cutIndex = i; break; }
      }
    }

    await truncateLoopSession(this.sessionId, cutIndex);
    this.messageSeq = 0;
    this.messages = this.loopMessagesToWire(loadLoopSession(this.sessionId).messages);
    this.streamingAssistantId = null;
    console.log(`[pi-engine] rewind → 截断到 ${cutIndex} 条 loop 消息(userMessageId=${userMessageId})`);
    return { success: true };
  }

  /**
   * /sessions/fork 的 pi 路径:在指定消息所在 turn 的末尾分叉——原会话不动,
   * 新 loop session 复制前半段,当前 loop 原地换血到分叉(对齐 reset 的
   * 状态重置清单)。wire→loop 的映射与 rewind 同构:user 消息按序数对应
   * (B6 后含 steering 注入的镜像,1:1;见 rewind 注释),截点 = 第 N+1 条
   * loop user 消息前(即目标消息所在 turn 结束之后)。
   */
  async forkPiChat(messageId: string): Promise<{ success: boolean; error?: string; sessionId?: string }> {
    if (this.busy) return { success: false, error: '响应进行中,先停止再 fork' };
    const idx = this.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return { success: false, error: 'Message not found' };

    const userOrdinal = this.messages.slice(0, idx + 1).filter((m) => m.role === 'user').length;
    const loopMessages = loadLoopSession(this.sessionId).messages;
    let seen = 0;
    let cutIndex = loopMessages.length;
    for (let i = 0; i < loopMessages.length; i++) {
      if (loopMessages[i].role === 'user') {
        seen++;
        if (seen > userOrdinal) { cutIndex = i; break; }
      }
    }

    const forkId = await forkLoopSession(this.sessionId, cutIndex);
    this.sessionId = forkId;
    this.boundSessionMetaId = null; // 首条消息时 ensureSessionBound 建新 meta
    // B10(1.2.6):fork 换血后尚无绑定——同 reset,配置面标识置新随机值。
    setActiveSessionId(randomUUID());
    this.messageSeq = 0;
    this.messages = this.loopMessagesToWire(loadLoopSession(forkId).messages);
    this.streamingAssistantId = null;
    this.systemInitInfo = null;
    broadcast('chat:status', { sessionState: 'idle' });
    console.log(`[pi-engine] fork → 新会话 ${forkId}(截点 ${cutIndex} 条 loop 消息)`);
    return { success: true, sessionId: forkId };
  }
}

// ---------------------------------------------------------------------------
// 默认实例 + facade(1.1.7 ②):按原签名逐个委托,调用点(admin-api/index)零改动。
// 纯函数(resolveSessionEnv/resolveSessionEnvKey/
// getEnvSessionBinding)不碰实例状态,已在上方按原样导出,不在此委托。
// ---------------------------------------------------------------------------

const defaultEngine = new ChatEngine();

export function resolveLoopEngine(
  env: NodeJS.ProcessEnv = process.env,
  configLoopEngine?: 'sdk' | 'pi',
): 'sdk' | 'pi' {
  return defaultEngine.resolveLoopEngine(env, configLoopEngine);
}

export function isPiEngine(env: NodeJS.ProcessEnv = process.env): boolean {
  return defaultEngine.isPiEngine(env);
}

export async function initPiChatEngine(dir: string): Promise<void> {
  return defaultEngine.initPiChatEngine(dir);
}

export function getPiAgentState(): ReturnType<ChatEngine['getPiAgentState']> {
  return defaultEngine.getPiAgentState();
}

/** 1.4.4 研究档案：当前 pi 会话线 id（未初始化 → ''）。 */
export function getPiSessionId(): string {
  return defaultEngine.getPiSessionId();
}

export function getPiMessages(): MessageWire[] {
  return defaultEngine.getPiMessages();
}

export function getPiStreamingAssistantId(): string | null {
  return defaultEngine.getPiStreamingAssistantId();
}

export function getPiSystemInitInfo(): SystemInitInfo | null {
  return defaultEngine.getPiSystemInitInfo();
}

export async function sendPiChatMessage(input: PiSendInput): Promise<PiSendResult> {
  return defaultEngine.sendPiChatMessage(input);
}

/** B2(1.2.6)— cron 独立 invoke 通道(不碰单例会话/steering/队列)。 */
export async function invokePiSession(
  input: PiSendInput,
  options: { loopSessionId?: string; scenario?: InteractionScenario; timeoutMs?: number } = {},
): Promise<{ text: string; error?: string; loopSessionId: string }> {
  return defaultEngine.invokePiSession(input, options);
}

/** 1.3.2 决策注入——人的决定以 user 消息注入回 loop(单例线经 steering/直发,跨线经 invoke)。 */
export function injectPiDecision(decision: {
  decisionId: string;
  sessionId: string;
  question?: string;
  choice: string;
  note?: string;
  expertRefs?: string[];
}): Promise<{ success: boolean; error?: string }> {
  return defaultEngine.injectDecision(decision);
}

/** B2(1.2.6)— 引擎当前线的只读快照(cron「跟随当前线」语义的数据源)。 */
export function getPiCurrentSessionRef(): { loopSessionId: string; sessionMetaId: string | null } {
  return defaultEngine.getPiCurrentSessionRef();
}

export async function switchPiSession(metaId: string): Promise<boolean> {
  return defaultEngine.switchPiSession(metaId);
}

export function envSwitchBlocker(workspace: string): string | null {
  return defaultEngine.envSwitchBlocker(workspace);
}

export async function switchEnvSession(workspace: string, envKey: string): Promise<{ ok: boolean; error?: string }> {
  return defaultEngine.switchEnvSession(workspace, envKey);
}

export function stopPiChat(): boolean {
  return defaultEngine.stopPiChat();
}

export function cancelPiQueueItem(queueId: string): string | null {
  return defaultEngine.cancelPiQueueItem(queueId);
}

export function getPiQueueStatus(): Array<{ id: string; messagePreview: string; kind: 'fifo' | 'steering' }> {
  return defaultEngine.getPiQueueStatus();
}

/**
 * 1.2.8(M4)重连对账:/chat/stream replay 末尾的队列快照事件——重连的 TUI
 * 错过了排队时刻的 queue:added 广播,这里按当前队列逐条生成同形事件
 * (isInFlight:false,带 kind),由 index.ts 逐条 client.send 补发。
 */
export function getPiQueueSnapshotEvents(): Array<{
  event: 'queue:added';
  data: { queueId: string; messageText: string; isInFlight: false; kind: 'fifo' | 'steering' };
}> {
  return defaultEngine.getPiQueueStatus().map((item) => ({
    event: 'queue:added' as const,
    data: {
      queueId: item.id,
      messageText: item.messagePreview,
      isInFlight: false as const,
      kind: item.kind,
    },
  }));
}

export function resetPiChat(): void {
  defaultEngine.resetPiChat();
}

export async function rewindPiChat(userMessageId: string): Promise<{ success: boolean; error?: string }> {
  return defaultEngine.rewindPiChat(userMessageId);
}

export async function forkPiChat(messageId: string): Promise<{ success: boolean; error?: string; sessionId?: string }> {
  return defaultEngine.forkPiChat(messageId);
}
