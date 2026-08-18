/**
 * 蒸馏弧执行外壳（工作生命宪章 §4.2）。
 *
 * 两条入口：
 *
 * 1. {@link seedDistillArcTask} —— sidecar 启动时为系统播种全局唯一、
 *    不可见的内置 recurring Task「蒸馏弧」（每小时）。幂等（全局查重 +
 *    跨进程文件锁），`memory.distill.enabled=false` 时不播。宿主工作区
 *    只用于 provider/模型解析；蒸馏输入是全工作区的工作史。
 *
 * 2. {@link runDistillArc} —— cron tick 到达 /cron/execute-sync 且提示词带
 *    蒸馏哨兵时，由 index.ts 路由到这里。流程（Functional Core / Imperative
 *    Shell，纯逻辑全在 ./distill.ts）：
 *
 *      收集输入（sessions.json 近 7 天 + management API /api/task/list）
 *      → buildDistillPrompt
 *      → 一次性 headless LLM 调用（M1: src/server/loop 的 pi one-shot，
 *        无子进程/bridge；最便宜可用模型 = provider 的 haiku 别名，
 *        回退会话模型）
 *      → applyDistillResult 合并
 *      → writeDistilled 原子写盘
 *
 *    失败契约：模型不可用 / 超时 / 解析无更新 → 保留旧文件，返回
 *    success:false 让 Rust 把这次 cron run 记为失败，绝不覆盖为空。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import {
  buildDistillPrompt,
  applyDistillResult,
  isDistillEnabled,
  readDistilled,
  writeDistilled,
  buildTopicPrompt,
  applyTopicResult,
  buildRecallJudgePrompt,
  parseRecallJudgeOutput,
  DISTILL_CRON_NAME,
  DISTILL_CRON_PROMPT,
  DISTILL_INTERVAL_MINUTES,
  DISTILL_LOOKBACK_DAYS,
  DISTILL_MAX_SESSIONS,
  DISTILL_MAX_TASKS,
  type DistillSessionSummary,
  type DistillTaskSummary,
  type DistilledMemory,
  type DistillTrustEvent,
  type RecallJudgeItem,
  type TopicSessionSummary,
} from './distill';
import {
  applyResearchDistillResult,
  buildResearchDistillPrompt,
  readResearchDistilled,
  writeResearchDistilled,
  RESEARCH_DISTILL_CRON_NAME,
  RESEARCH_DISTILL_CRON_PROMPT,
  RESEARCH_DISTILL_INTERVAL_MINUTES,
  RESEARCH_DISTILL_MAX_EVENTS,
} from './distill-research';
import {
  listGapRecurrences,
  listUndistilledResearchEvents,
  listUnsettledRecalls,
  listWrongMemories,
  markResearchEventsDistilled,
  openTrustDb,
  RESEARCH_MEMORY_KINDS,
  settleRecallEvent,
  type RecallEvent,
  type ResearchEvent,
} from './store';
import {
  getSessionModel,
  getSessionProviderEnv,
  type ProviderEnv,
} from '../agent-session';
import { resolveSessionModelAliases } from '../utils/model-aliases';
import { getZhiShiDataDir } from '../utils/app-dirs';
import { ensureDirSync } from '../utils/fs-utils';
import { loadConfig, loadProjects, findAgentByWorkspacePath, findEffectiveProvider, resolveProviderEnv } from '../utils/admin-config';
import { managementApi } from '../utils/management-api';
import { withFileLock } from '../utils/file-lock';
import { workspacePathsEqual } from '../../shared/workspacePath';
import { stripBom } from '../../shared/utils';
import { oneShot } from '../loop/one-shot';
import { resolveLoopModel, resolveLoopModelFromEnv } from '../loop/pi-provider';
import type { SessionMetadata } from '../types/session';

/** 蒸馏单发 LLM 调用超时。内容是一次性压缩，5 分钟足够；超时按失败处理。 */
const DISTILL_LLM_TIMEOUT_MS = 300_000;

/** 蒸馏系统提示：契约全文在 buildDistillPrompt 的用户消息里，这里只钉住角色。 */
const DISTILL_SYSTEM_PROMPT =
  '你是 ZhiShi 的蒸馏弧执行器。严格遵守用户消息中的输出契约：只输出三个指定的 "## " 分节，不输出任何其他内容。';

/** 话题弧系统提示：同样只钉住角色与输出纪律。 */
const TOPIC_SYSTEM_PROMPT =
  '你是 ZhiShi 的话题弧执行器。严格遵守用户消息中的输出契约：只输出经验文件正文，不输出任何其他内容。';

/** 话题弧每次 tick 最多处理的工作区数（按活跃度排序取前 N）。 */
const TOPIC_MAX_WORKSPACES = 5;

// ===== 土匪回路结算参数 =====

/** 检索事件结算宽限期：给用户留足反驳时间再让 judge 看。 */
const RECALL_GRACE_MS = 15 * 60_000;
/** 单次 tick 最多结算的检索事件数（judge 调用成本上限）。 */
const RECALL_JUDGE_MAX = 20;
/** 超过这个年龄的事件不再等 judge（transcript 早没了），直接按 unused 结算。 */
const RECALL_MAX_AGE_MS = 7 * 24 * 3600_000;
/** judge 证据窗：引用前 5 分钟到引用后 2 小时的对话。 */
const RECALL_CONTEXT_BEFORE_MS = 5 * 60_000;
const RECALL_CONTEXT_AFTER_MS = 2 * 3600_000;

/**
 * 安全类记忆的 recall 结算参数（D3，§1.4「judge 证据窗对长 fuzz 会话不够」
 * 的兑现点）：一次 fuzz/exploit 会话可能跑十几小时，「这条安全记忆有没有
 * 用上」的证据常在数小时后才在对话里出现——认知弧的 +2h 窗会把它们全判成
 * unused。安全蒸馏弧等满 24h 再结算、看引用后 24h 的对话。
 */
const RESEARCH_RECALL_GRACE_MS = 24 * 3600_000;
const RESEARCH_RECALL_CONTEXT_AFTER_MS = 24 * 3600_000;

// ===== 输入收集 =====

/**
 * 收集近 7 天的会话摘要（全工作区——蒸馏弧是全局单弧，压的是“这个人”
 * 的全部工作史，不是某个工地的）。直接读盘（与 memory_update.rs 同一
 * 数据源），不依赖 sidecar 内存态。
 */
function collectRecentSessions(_workspacePath: string, now: number = Date.now()): DistillSessionSummary[] {
  const sessionsPath = join(getZhiShiDataDir(), 'sessions.json');
  if (!existsSync(sessionsPath)) return [];
  let all: SessionMetadata[];
  try {
    all = JSON.parse(stripBom(readFileSync(sessionsPath, 'utf-8'))) as SessionMetadata[];
  } catch (err) {
    console.warn('[distill] sessions.json 解析失败，按无会话处理:', err instanceof Error ? err.message : err);
    return [];
  }
  const cutoff = now - DISTILL_LOOKBACK_DAYS * 24 * 3600 * 1000;
  return all
    .filter((s) => {
      const t = Date.parse(s.lastActiveAt ?? '');
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))
    .slice(0, DISTILL_MAX_SESSIONS)
    .map((s) => ({
      title: s.title,
      lastMessagePreview: s.lastMessagePreview,
      messageCount: s.stats?.messageCount,
      lastActiveAt: s.lastActiveAt,
      excerpt: sessionExcerpt(s.id),
      workspaceName: s.agentDir ? (basename(s.agentDir.replace(/[/\\]+$/, '')) || undefined) : undefined,
    }));
}

/** 从 management API /api/task/list 收集近 7 天的任务（全工作区；不可用就空数组，不阻塞蒸馏）。 */
async function collectRecentTasks(_workspacePath: string, now: number = Date.now()): Promise<DistillTaskSummary[]> {
  const resp = await managementApi('/api/task/list');
  if (!resp.ok || !Array.isArray(resp.tasks)) {
    console.warn(`[distill] /api/task/list 不可用（${String(resp.error ?? 'unknown')}），仅基于会话蒸馏`);
    return [];
  }
  const cutoff = now - DISTILL_LOOKBACK_DAYS * 24 * 3600 * 1000;
  return (resp.tasks as Array<Record<string, unknown>>)
    .filter((t) => t.deleted !== true)
    .filter((t) => typeof t.updatedAt === 'number' && t.updatedAt >= cutoff)
    .sort((a, b) => (b.updatedAt as number) - (a.updatedAt as number))
    .slice(0, DISTILL_MAX_TASKS)
    .map((t) => ({
      name: typeof t.name === 'string' ? t.name : '',
      status: typeof t.status === 'string' ? t.status : undefined,
      updatedAt: t.updatedAt as number,
    }));
}

// ===== 话题弧（UPDATE_MEMORY 的后台继任者：工地知识层也归弧管） =====

/** 按工作区分组收集近 7 天的活跃会话（话题弧的原料）。 */
function collectSessionsByWorkspace(now: number = Date.now()): Map<string, TopicSessionSummary[]> {
  const sessionsPath = join(getZhiShiDataDir(), 'sessions.json');
  const byWorkspace = new Map<string, TopicSessionSummary[]>();
  if (!existsSync(sessionsPath)) return byWorkspace;
  let all: SessionMetadata[];
  try {
    all = JSON.parse(stripBom(readFileSync(sessionsPath, 'utf-8'))) as SessionMetadata[];
  } catch {
    return byWorkspace;
  }
  const cutoff = now - DISTILL_LOOKBACK_DAYS * 24 * 3600 * 1000;
  for (const s of all) {
    const t = Date.parse(s.lastActiveAt ?? '');
    if (!s.agentDir || !Number.isFinite(t) || t < cutoff) continue;
    const list = byWorkspace.get(s.agentDir) ?? [];
    list.push({
      title: s.title,
      lastMessagePreview: s.lastMessagePreview,
      messageCount: s.stats?.messageCount,
      lastActiveAt: s.lastActiveAt,
    });
    byWorkspace.set(s.agentDir, list);
  }
  return byWorkspace;
}

/**
 * 话题弧：给最近活跃的前 N 个工作区各维护一份 memory/topics/<name>.md。
 * Best-effort：单个工作区失败不影响其他，也不阻断认知弧的结果。
 */
async function runTopicsArc(
  model: string,
  providerEnv: ProviderEnv | undefined,
  tag: string,
  now: number = Date.now(),
): Promise<void> {
  const byWorkspace = collectSessionsByWorkspace(now);
  const active = [...byWorkspace.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, TOPIC_MAX_WORKSPACES);
  for (const [wsPath, sessions] of active) {
    try {
      const wsName = basename(wsPath.replace(/[/\\]+$/, '')) || 'workspace';
      const topicDir = join(wsPath, 'memory', 'topics');
      const topicPath = join(topicDir, `${wsName}.md`);
      const existing = existsSync(topicPath) ? readFileSync(topicPath, 'utf-8') : '';
      const prompt = buildTopicPrompt({ workspaceName: wsName, sessions, existingTopic: existing });
      const output = await runDistillLlmCall(prompt, model, providerEnv, TOPIC_SYSTEM_PROMPT);
      if (!output) {
        console.warn(`${tag} topics: LLM call failed for ${wsName} — topic file preserved`);
        continue;
      }
      const next = applyTopicResult(existing, output);
      if (!next) continue;
      mkdirSync(topicDir, { recursive: true });
      const tmp = `${topicPath}.tmp-${process.pid}`;
      writeFileSync(tmp, next, 'utf-8');
      renameSync(tmp, topicPath);
      console.log(`${tag} topics: updated ${topicPath}`);
    } catch (err) {
      console.warn(`${tag} topics: failed for ${wsPath}:`, err instanceof Error ? err.message : err);
    }
  }
}

// ===== 一次性 headless LLM 调用（镜像 title-generator 的单发路径） =====

/** 从会话文件（~/.zhishi/sessions/<id>.jsonl）取尾部内容摘录（断点 5 修复）。 */
function sessionExcerpt(sessionId: string, maxMessages = 6, maxChars = 900): string {
  try {
    const p = join(getZhiShiDataDir(), 'sessions', `${sessionId}.jsonl`);
    if (!existsSync(p)) return '';
    const lines = readFileSync(p, 'utf-8').split(/\r?\n/).filter((l) => l.trim().length > 0);
    const messages: string[] = [];
    for (const line of lines.slice(-30)) {
      try {
        const m = JSON.parse(line) as { role?: string; content?: string };
        if ((m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()) {
          const text = m.content.replace(/\s+/g, ' ').trim();
          if (text && !text.startsWith('<system-reminder>')) {
            messages.push(`${m.role === 'user' ? '用户' : 'AI'}: ${text.slice(0, 160)}`);
          }
        }
      } catch { /* skip bad line */ }
    }
    return messages.slice(-maxMessages).join('\n  ').slice(0, maxChars);
  } catch {
    return '';
  }
}

// ===== 土匪回路结算（judge 的效果门控） =====

/** 引用时间窗内的会话证据：扫全部 session 文件，取 [ts-5min, ts+evidenceAfterMs]
 *  的对话。evidenceAfterMs 参数化（默认 +2h）：安全类记忆走 24h 窗（见
 *  RESEARCH_RECALL_CONTEXT_AFTER_MS 的注释）。 */
function recallContext(ts: number, evidenceAfterMs: number = RECALL_CONTEXT_AFTER_MS): string {
  try {
    const dir = join(getZhiShiDataDir(), 'sessions');
    if (!existsSync(dir)) return '';
    const from = ts - RECALL_CONTEXT_BEFORE_MS;
    const to = ts + evidenceAfterMs;
    const messages: Array<{ t: number; line: string }> = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs < from) continue;
        for (const line of readFileSync(p, 'utf-8').split(/\r?\n/)) {
          if (!line.trim()) continue;
          const m = JSON.parse(line) as { role?: string; content?: string; timestamp?: string };
          if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
          const t = Date.parse(m.timestamp ?? '');
          if (!Number.isFinite(t) || t < from || t > to) continue;
          const text = m.content.replace(/\s+/g, ' ').trim();
          if (!text || text.startsWith('<system-reminder>')) continue;
          messages.push({ t, line: `${m.role === 'user' ? '用户' : 'AI'}: ${text.slice(0, 160)}` });
        }
      } catch { /* 单文件坏了不拖累整批 */ }
    }
    return messages
      .sort((a, b) => a.t - b.t)
      .slice(0, 12)
      .map((m) => m.line)
      .join('\n')
      .slice(0, 1500);
  } catch {
    return '';
  }
}

/**
 * 结算检索事件（框架 §4 的隐式信号回收，用 LLM-as-judge 代替人工反馈）：
 * - 太老的（transcript 已不在）→ 直接 unused；
 * - 记忆本体已消失的 → 直接 unused；
 * - 其余交 judge 裁定，按效果门控回写分值（wrong 重罚 / effective 弱正 / unused 不动）；
 * - judge 没裁的留到下个小时重试（7 天年龄上限兜底，不会无限积压）。
 */
async function settleRecalls(
  events: RecallEvent[],
  model: string,
  providerEnv: ProviderEnv | undefined,
  tag: string,
  now: number = Date.now(),
  evidenceAfterMs: number = RECALL_CONTEXT_AFTER_MS,
): Promise<void> {
  const judgeItems: RecallJudgeItem[] = [];
  for (const ev of events) {
    if (now - ev.ts > RECALL_MAX_AGE_MS || !ev.memoryContent) {
      settleRecallEvent(ev.id, 'unused');
      continue;
    }
    judgeItems.push({
      eventId: ev.id,
      query: ev.query,
      memoryContent: ev.memoryContent,
      context: recallContext(ev.ts, evidenceAfterMs),
    });
  }
  if (judgeItems.length === 0) return;
  const output = await runDistillLlmCall(buildRecallJudgePrompt(judgeItems), model, providerEnv);
  if (!output) {
    console.warn(`${tag} recall judge: LLM call failed — ${judgeItems.length} event(s) deferred to next tick`);
    return;
  }
  const verdicts = parseRecallJudgeOutput(output);
  let settled = 0;
  const chargedThisTick = new Set<string>();
  for (const item of judgeItems) {
    const verdict = verdicts.get(item.eventId);
    if (!verdict) continue;
    // 一次错误=一次结算：同 tick 内同一记忆已结过账的，后续事件只记 outcome。
    const memoryId = events.find((e) => e.id === item.eventId)?.memoryId;
    const skipDelta = memoryId !== undefined && chargedThisTick.has(memoryId);
    if (memoryId !== undefined) chargedThisTick.add(memoryId);
    settleRecallEvent(item.eventId, verdict, undefined, undefined, skipDelta);
    settled += 1;
  }
  console.log(`${tag} recall judge: settled ${settled}/${judgeItems.length} event(s)`);
}

/** 关系弧原料：近 7 天信任事件（trust_events 表）。 */
function collectTrustEvents(now: number = Date.now()): DistillTrustEvent[] {
  try {
    const cutoff = now - DISTILL_LOOKBACK_DAYS * 24 * 3600 * 1000;
    const rows = openTrustDb()
      .prepare('SELECT * FROM trust_events WHERE ts >= ? ORDER BY ts DESC LIMIT 20')
      .all(cutoff) as Array<{ ts: number; task_name: string; kind: string; delta: number; reason: string }>;
    return rows.map((r) => ({ ts: r.ts, taskName: r.task_name, kind: r.kind, delta: r.delta, reason: r.reason }));
  } catch {
    return [];
  }
}
/**
 * 当前会话可用的最便宜模型：provider 配了 sonnet/opus/haiku 别名表时取 haiku
 * （便宜档），否则回退会话模型。`resolveSessionModelAliases` 负责把"三别名塌缩
 * 成同一个"的安全网归一到会话模型。
 */
function resolveDistillModel(providerEnv: ProviderEnv | undefined): string | undefined {
  const sessionModel = getSessionModel();
  const aliases = resolveSessionModelAliases(providerEnv?.modelAliases, sessionModel);
  return aliases?.haiku ?? sessionModel;
}

/**
 * 单发蒸馏调用。M1: SDK query() 单发已替换为 src/server/loop 的 pi
 * one-shot——无子进程、无 bridge 回环（OpenAI 协议由 pi 原生支持）、
 * 无会话持久化。一次性纯文本调用天然无工具面（蒸馏输入是可被间接注入
 * 的工作史文本，与 SDK 路径 tools:[] 的注入防护等价）。返回 null = 失败/超时。
 */
export async function runDistillLlmCall(
  prompt: string,
  model: string,
  providerEnv: ProviderEnv | undefined,
  systemPrompt: string = DISTILL_SYSTEM_PROMPT,
): Promise<string | null> {
  try {
    // providerEnv 缺省时回落 config.json 的默认 loop 模型（同 title-gen）。
    const resolution = providerEnv
      ? resolveLoopModelFromEnv(providerEnv, model)
      : resolveLoopModel();
    if (!resolution) {
      console.warn('[distill] 无可用 provider/model（缺 provider 定义或 API key）');
      return null;
    }

    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), DISTILL_LLM_TIMEOUT_MS);
    });

    return await Promise.race([
      oneShot({
        prompt,
        system: systemPrompt,
        model: resolution.model,
        models: resolution.models,
        apiKey: resolution.getApiKey(),
      }),
      timeoutPromise,
    ]);
  } catch (err) {
    console.warn('[distill] LLM 调用失败:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ===== 蒸馏执行 =====

export interface DistillArcResult {
  status: number;
  body: Record<string, unknown>;
}

function ok(outputText: string): DistillArcResult {
  return { status: 200, body: { success: true, outputText } };
}

function fail(error: string, status = 500): DistillArcResult {
  return { status, body: { success: false, error } };
}

/**
 * 系统级 provider 回落（蒸馏弧专用）：launcherLastUsed.providerId 优先，
 * 其次任何配了 API key 的 provider；模型取该 provider 的 haiku 别名或第一个模型。
 */
function resolveDistillFallbackProvider(): { env: ProviderEnv; model: string } | null {
  const config = loadConfig();
  const candidates: string[] = [];
  // 显式默认（设置-模型配置「默认模型」选择器写入的 defaultProviderId）
  // 优先于最近使用——402/额度类故障时用户有显式手段改道。
  const explicitDefault = (config as { defaultProviderId?: string }).defaultProviderId;
  if (explicitDefault) candidates.push(explicitDefault);
  const lastUsed = (config as { launcherLastUsed?: { providerId?: string } }).launcherLastUsed?.providerId;
  if (lastUsed && !candidates.includes(lastUsed)) candidates.push(lastUsed);
  const apiKeys = (config as { providerApiKeys?: Record<string, string> }).providerApiKeys ?? {};
  for (const id of Object.keys(apiKeys)) {
    if (!candidates.includes(id)) candidates.push(id);
  }
  for (const id of candidates) {
    const env = resolveProviderEnv(id, config);
    if (!env) continue;
    const provider = findEffectiveProvider(id, config);
    const aliases = resolveSessionModelAliases(
      (provider as { modelAliases?: Record<string, string> } | null | undefined)?.modelAliases,
      undefined,
    );
    const models = ((provider as { models?: Array<{ id?: string } | string> } | null | undefined)?.models) ?? [];
    const first = models[0];
    const firstId = typeof first === 'string' ? first : first?.id;
    // 选中的正好是显式默认 provider 且配了默认模型 → 用它。
    const configuredModel = id === explicitDefault
      ? (config as { defaultModelId?: string }).defaultModelId
      : undefined;
    const model = configuredModel ?? aliases?.haiku ?? firstId;
    if (model) return { env: env as ProviderEnv, model };
  }
  return null;
}

/**
 * 弧任务的模型/Provider 解析（认知弧与安全蒸馏弧共用）：会话配置优先；
 * 系统任务不能依赖宿主会话恰好配了模型——宿主工作区 agent 未配模型时，
 * 回落到系统级默认（launcherLastUsed.providerId → 任何配了 API key 的 provider）。
 */
function resolveArcModelProvider(tag: string): { providerEnv: ProviderEnv | undefined; model: string } | null {
  let providerEnv = getSessionProviderEnv();
  let model = resolveDistillModel(providerEnv);
  if (!model) {
    const fallback = resolveDistillFallbackProvider();
    if (fallback) {
      providerEnv = fallback.env;
      model = fallback.model;
      console.log(`${tag} session model unavailable, fell back to system provider (model=${model})`);
    }
  }
  return model ? { providerEnv, model } : null;
}

/**
 * 跑一次蒸馏弧。由 /cron/execute-sync 的哨兵分支调用（cron tick 已经把
 * 工作区 sidecar ensure 起来了，这里直接复用该进程的会话配置）。
 */
export async function runDistillArc(opts: { workspacePath: string; taskId?: string }): Promise<DistillArcResult> {
  const tag = `[distill]${opts.taskId ? ` task=${opts.taskId}` : ''}`;
  try {
    if (!isDistillEnabled(loadConfig())) {
      return ok('distill skipped: memory.distill.enabled=false');
    }

    const recentSessions = collectRecentSessions(opts.workspacePath);
    const recentTasks = await collectRecentTasks(opts.workspacePath);
    if (recentSessions.length === 0 && recentTasks.length === 0) {
      return ok('distill skipped: no recent activity in the last 7 days');
    }

    const existing: DistilledMemory = readDistilled();
    const trustEvents = collectTrustEvents();
    // 错记忆史（B）：曾被 judge 判 wrong 的记忆注入主提示词——写入取舍的上下文学习。
    const wrongMemories = listWrongMemories(8).map((w) => w.content);
    // 能力雷达（WORK_LOOP §5）：复发 ≥2 的能力缺口注入主提示词——
    // 蒸馏弧把反复撞上的缺口提炼成"提议沉淀造"的提醒（只提议不自动）。
    const recentGaps = listGapRecurrences({ minCount: 2, limit: 10 })
      .map((g) => `×${g.count} ${g.latestDetail?.trim() || g.gapKey}`);
    const prompt = buildDistillPrompt({ recentSessions, recentTasks, trustEvents, wrongMemories, recentGaps, existing });

    // 模型解析（真机修复）：蒸馏弧是系统任务，不能依赖宿主会话恰好配了
    // 模型——会话 agent 未配模型时，回落到系统级默认：
    // launcherLastUsed.providerId → 任何配了 API key 的 provider。
    const resolved = resolveArcModelProvider(tag);
    if (!resolved) {
      return fail('distill aborted: no model available (session and system fallback both empty)');
    }
    const { providerEnv, model } = resolved;

    // 土匪回路结算（A）：先把过宽限期的检索事件交 judge 裁定效果，再蒸馏——
    // best-effort，失败不影响认知弧主流程。安全类记忆（research-log /
    // vuln-pattern / tool-combo）的 recall 不在这里结——它们的证据窗是 24h
    // （长 fuzz 会话），归安全蒸馏弧结算（runResearchDistillArc）。
    try {
      const pending = listUnsettledRecalls(RECALL_GRACE_MS, RECALL_JUDGE_MAX, undefined, undefined, { exclude: RESEARCH_MEMORY_KINDS });
      if (pending.length > 0) {
        await settleRecalls(pending, model, providerEnv, tag);
      }
    } catch (err) {
      console.warn(`${tag} recall settle failed (non-fatal):`, err instanceof Error ? err.message : err);
    }

    console.log(`${tag} starting: ${recentSessions.length} session(s), ${recentTasks.length} task(s), model=${model}`);
    const llmOutput = await runDistillLlmCall(prompt, model, providerEnv);
    if (!llmOutput) {
      return fail('distill failed: LLM call returned no output (timeout or transport error) — old files preserved');
    }

    const { distilled, warnings } = applyDistillResult(existing, llmOutput);
    for (const w of warnings) console.warn(`${tag} ${w}`);

    // 残差守恒（§4.3）：一个分节都没更新 = 解析失败，保留旧文件不写盘。
    const changed = (Object.keys(distilled) as Array<keyof DistilledMemory>)
      .some((k) => distilled[k] !== existing[k]);
    if (!changed) {
      return fail('distill failed: parse produced no section updates — old files preserved');
    }

    writeDistilled(distilled);
    console.log(`${tag} done: distilled memory written (warnings=${warnings.length})`);

    // 话题弧（UPDATE_MEMORY 的后台继任者）：认知蒸馏成功后，顺带把最近活跃
    // 工地的经验文件也维护掉——best-effort，失败不影响认知弧的成果。
    await runTopicsArc(model, providerEnv, tag);

    return ok('distill completed');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${tag} error:`, err);
    return fail(`distill error: ${message}`);
  }
}

// ===== 安全蒸馏弧（D3，§1.4：独立弧，不扩展现有弧） =====

/** 安全蒸馏系统提示：契约全文在 buildResearchDistillPrompt 的用户消息里，这里只钉住角色。 */
const RESEARCH_DISTILL_SYSTEM_PROMPT =
  '你是 ZhiShi 的安全蒸馏弧执行器。严格遵守用户消息中的输出契约：只输出三个指定的 "## " 分节，不输出任何其他内容。';

/** 单次 tick 最多取摘录的安全会话数（按最后活跃排序取前 N）。 */
const RESEARCH_DISTILL_MAX_SESSION_EXCERPTS = 10;

/**
 * 安全蒸馏弧的会话原料：未结算事件涉及的工作区里，最近活跃会话的尾部摘录
 * （transcript 级原料——事件只有一句话 summary，打法细节在会话里）。
 */
function collectResearchSessionExcerpts(events: ResearchEvent[]): string[] {
  const workspaces = new Set(events.map((e) => e.workspace));
  const sessionsPath = join(getZhiShiDataDir(), 'sessions.json');
  if (!existsSync(sessionsPath)) return [];
  let all: SessionMetadata[];
  try {
    all = JSON.parse(stripBom(readFileSync(sessionsPath, 'utf-8'))) as SessionMetadata[];
  } catch {
    return [];
  }
  return all
    .filter((s) => s.agentDir && [...workspaces].some((w) => workspacePathsEqual(s.agentDir as string, w)))
    .sort((a, b) => (Date.parse(b.lastActiveAt ?? '') || 0) - (Date.parse(a.lastActiveAt ?? '') || 0))
    .slice(0, RESEARCH_DISTILL_MAX_SESSION_EXCERPTS)
    .map((s) => sessionExcerpt(s.id))
    .filter((x) => x.trim().length > 0);
}

/**
 * 跑一次安全蒸馏弧。由 /cron/execute-sync 的 RESEARCH_DISTILL_SENTINEL 分支调用。
 * 结构与 runDistillArc 同构，三个参数化点不同：
 *   输入源  = 未结算的 research_events（按域分组）+ 相关安全会话 transcript 尾部；
 *   prompt  = 「成功路径 / 失败根因 / 工具组合」三节契约（buildResearchDistillPrompt）；
 *   输出    = SQLite keyed 权威覆盖（writeResearchDistilled，见 distill-research.ts 头注释）。
 * 结算语义照 recall 结算（写库即结算）：产物落库成功才标记本批事件已蒸馏；
 * LLM/解析失败不标记——事件留队列，下个 tick 重试。
 */
export async function runResearchDistillArc(opts: { workspacePath: string; taskId?: string }): Promise<DistillArcResult> {
  const tag = `[research-distill]${opts.taskId ? ` task=${opts.taskId}` : ''}`;
  try {
    if (!isDistillEnabled(loadConfig())) {
      return ok('research distill skipped: memory.distill.enabled=false');
    }

    const events = listUndistilledResearchEvents({ limit: RESEARCH_DISTILL_MAX_EVENTS });
    if (events.length === 0) {
      // 空输入零产出：无未结算事件 = 本轮没有新经验可压，直接跳过（不调 LLM）。
      return ok('research distill skipped: no undistilled research events');
    }

    const existing = readResearchDistilled();
    const sessionExcerpts = collectResearchSessionExcerpts(events);
    const prompt = buildResearchDistillPrompt({ events, sessionExcerpts, existing });

    const resolved = resolveArcModelProvider(tag);
    if (!resolved) {
      return fail('research distill aborted: no model available (session and system fallback both empty)');
    }
    const { providerEnv, model } = resolved;

    // 安全类记忆的 recall 结算（24h 证据窗——参数化见 RESEARCH_RECALL_CONTEXT_AFTER_MS
    // 的注释）。best-effort，失败不影响蒸馏主流程。
    try {
      const pending = listUnsettledRecalls(RESEARCH_RECALL_GRACE_MS, RECALL_JUDGE_MAX, undefined, undefined, { include: RESEARCH_MEMORY_KINDS });
      if (pending.length > 0) {
        await settleRecalls(pending, model, providerEnv, tag, undefined, RESEARCH_RECALL_CONTEXT_AFTER_MS);
      }
    } catch (err) {
      console.warn(`${tag} recall settle failed (non-fatal):`, err instanceof Error ? err.message : err);
    }

    console.log(`${tag} starting: ${events.length} event(s), ${sessionExcerpts.length} excerpt(s), model=${model}`);
    const llmOutput = await runDistillLlmCall(prompt, model, providerEnv, RESEARCH_DISTILL_SYSTEM_PROMPT);
    if (!llmOutput) {
      return fail('research distill failed: LLM call returned no output (timeout or transport error) — events NOT settled, old memory preserved');
    }

    const { distilled, warnings } = applyResearchDistillResult(existing, llmOutput);
    for (const w of warnings) console.warn(`${tag} ${w}`);

    // 残差守恒：一个分节都没更新 = 解析失败，不写盘、不结算事件。
    const changed = (Object.keys(distilled) as Array<keyof typeof distilled>)
      .some((k) => distilled[k] !== existing[k]);
    if (!changed) {
      return fail('research distill failed: parse produced no section updates — events NOT settled, old memory preserved');
    }

    writeResearchDistilled(distilled);
    // 写库即结算：产物落库成功，标记本批输入事件已蒸馏（幂等）。
    markResearchEventsDistilled(events.map((e) => e.id));
    console.log(`${tag} done: research memory written, ${events.length} event(s) settled (warnings=${warnings.length})`);

    return ok('research distill completed');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${tag} error:`, err);
    return fail(`research distill error: ${message}`);
  }
}

// ===== 内置任务种子 =====

/**
 * 为系统播种全局唯一、不可见的内置 recurring Task「蒸馏弧」。幂等：
 * - `memory.distill.enabled=false` → 不播；
 * - 已有同名系统任务 → 不播（全局查重，含 includeSystem）。
 *
 * 设计（2026-07-31 真机复盘）：
 * - 全局单弧：蒸馏层是关于“这个人”的关系层资产，不属于任何工作区；
 *   播种用的 host workspace 只是执行宿主（provider/模型解析用），
 *   输入收集是全工作区的。
 * - 不可见（dispatchOrigin: 'system'）：蒸馏是记忆机器的内部节律，
 *   不是用户功能——可见的应该是信息（它想起了什么），不是配置。
 * - 每小时：比一天一次更及时；漏跑由引擎的 past-due 补偿兜底
 *   （恢复后 +5s 补跑），天然抗关机。
 *
 * 蒸馏哨兵放在 task.md 里：tick 时 build_dispatch_prompt 把 task.md
 * 带进 prompt，execute-sync 的哨兵短路照旧路由到确定性蒸馏管线。
 */
export async function seedDistillArcTask(_workspacePath: string): Promise<void> {
  await seedArcTask({
    cronName: DISTILL_CRON_NAME,
    cronPrompt: DISTILL_CRON_PROMPT,
    intervalMinutes: DISTILL_INTERVAL_MINUTES,
    logTag: '[distill]',
  });
}

/**
 * 安全蒸馏弧的种子（D3）：与认知弧同一哨兵模式、同一幂等语义，独立任务、
 * 独立节奏（6 小时——研究事件稀疏）。
 */
export async function seedResearchDistillArcTask(_workspacePath: string): Promise<void> {
  await seedArcTask({
    cronName: RESEARCH_DISTILL_CRON_NAME,
    cronPrompt: RESEARCH_DISTILL_CRON_PROMPT,
    intervalMinutes: RESEARCH_DISTILL_INTERVAL_MINUTES,
    logTag: '[research-distill]',
  });
}

/** 两条蒸馏弧共用的播种实现（参数化：任务名 / 哨兵提示词 / 节奏 / 日志标签）。 */
async function seedArcTask(opts: {
  cronName: string;
  cronPrompt: string;
  intervalMinutes: number;
  logTag: string;
}): Promise<void> {
  const { cronName, cronPrompt, intervalMinutes, logTag } = opts;
  try {
    if (!isDistillEnabled(loadConfig())) return;

    // 宿主工作区：仅用于 provider/模型解析。优先默认工作区，否则第一个
    // 绑定了 Agent 的工作区；都没有则放弃（没有模型可用，蒸馏无意义）。
    const host = resolveDistillHostWorkspace();
    if (!host) return;

    // 锁文件的父目录在全新机器上可能还不存在（蒸馏从未跑过时 writeDistilled
    // 才会创建它）——先确保存在，否则 ENOENT 静默失败（真机发现的既有 bug）。
    ensureDirSync(join(getZhiShiDataDir(), 'memory', 'distilled'));
    const lockPath = join(getZhiShiDataDir(), 'memory', 'distilled', '.seed.lock');
    await withFileLock({ lockPath }, async () => {
      const list = await managementApi('/api/task/list?includeSystem=true');
      if (!list.ok || !Array.isArray(list.tasks)) return; // management API 未就绪——下次启动再播
      const exists = (list.tasks as Array<{ name?: unknown; deleted?: unknown; dispatchOrigin?: unknown }>)
        .some((t) => t?.name === cronName && t?.deleted !== true && t?.dispatchOrigin === 'system');
      if (exists) return;

      const project = loadProjects().find((p) => workspacePathsEqual(p.path, host));
      const created = await managementApi('/api/task/create-direct', 'POST', {
        name: cronName,
        executor: 'agent',
        workspaceId: project?.id ?? '',
        workspacePath: host,
        taskMdContent: cronPrompt,
        executionMode: 'recurring',
        intervalMinutes,
        runMode: 'new-session',
        dispatchOrigin: 'system',
      });
      const taskId = (created.task as { id?: unknown } | undefined)?.id;
      if (!created.ok || typeof taskId !== 'string') {
        console.warn(`${logTag} task seed failed: ${String(created.error ?? 'unknown')}`);
        return;
      }
      // 武装：todo → running + 起调度器（arm_task 路径）。
      const run = await managementApi('/api/task/run', 'POST', { id: taskId });
      if (run.ok) {
        console.log(`${logTag} seeded global recurring task 「${cronName}」 (every ${intervalMinutes}min, host=${host})`);
      } else {
        console.warn(`${logTag} task seed arming failed: ${String(run.error ?? 'unknown')}`);
      }
    });
  } catch (err) {
    console.warn(`${logTag} seed error (non-fatal):`, err instanceof Error ? err.message : err);
  }
}

/** 蒸馏宿主工作区：默认工作区优先，否则第一个有 Agent 的工作区。 */
function resolveDistillHostWorkspace(): string | null {
  try {
    const config = loadConfig() as { defaultWorkspacePath?: string };
    if (config.defaultWorkspacePath && findAgentByWorkspacePath(config.defaultWorkspacePath)) {
      return config.defaultWorkspacePath;
    }
    for (const p of loadProjects()) {
      if (findAgentByWorkspacePath(p.path)) return p.path;
    }
  } catch { /* fall through */ }
  return null;
}
