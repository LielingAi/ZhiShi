/**
 * 蒸馏弧（工作生命宪章 §4.2）—— 纯逻辑核心。
 *
 * 定期把原始工作史（会话 / 任务）压成四个恒定尺寸的蒸馏文件：
 *
 *   ~/.zhishi/memory/distilled/
 *     user-model.md  —— 它眼中的你：用户怎么工作（验收标准 / 偏好 / 雷区）
 *     self-model.md  —— 它眼中的自己：擅长什么、在哪栽过、已知坑
 *     routines.md    —— 老规矩：周期性任务、共同形成的惯例、进行中的长期事项
 *     reminders.md   —— 主动提醒（§7.3）：该想起的时候要想起的事，每条附来源
 *                        与日期；过期提醒注入时被确定性过滤
 *
 * 守恒约束（§4.1）：每个文件硬上限 {@link DISTILL_MAX_CHARS_PER_FILE} 字符——
 * 蒸馏质量进，窗口长度不进。工作史无限长，注入永远 ~6KB。
 *
 * 本模块是纯核心 + 薄文件 IO（unit 快池可测）：无副作用的决策逻辑全部在此，
 * LLM 调用 / cron 调度 / management API 等外壳在 distill-runner.ts。
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { getZhiShiDataDir } from '../utils/app-dirs';
import { stripBom } from '../../shared/utils';
import {
  allEntries,
  contentKey,
  latestDistilledEntry,
  listActive,
  putEntry,
  putDistilledEntry,
  retainReminders,
} from './store';

// ===== 常量 =====

/** 内置 cron 任务名（幂等种子按此名查重）。 */
export const DISTILL_CRON_NAME = '蒸馏弧';

/**
 * cron 提示词哨兵。/cron/execute-sync 据此把这次 tick 路由到确定性蒸馏管线，
 * 而不是当成普通 agent turn 投递。
 */
export const DISTILL_SENTINEL = '<zhishi-distill-arc>';

/** 种子任务的提示词——内容本身不执行，只作哨兵与档案记录。 */
export const DISTILL_CRON_PROMPT = `${DISTILL_SENTINEL}
系统内置任务「蒸馏弧」（工作生命宪章 §4.2）：定期把原始工作史压成蒸馏认知。
此消息由系统调度触发，实际执行由 sidecar 的蒸馏管线（distill-runner）完成。
</zhishi-distill-arc>`;

/** 蒸馏间隔（分钟）：每小时。比一天一次更及时；漏跑由引擎 past-due 补偿兑底。 */
export const DISTILL_INTERVAL_MINUTES = 60;

/** 每个蒸馏文件的硬上限（字符）。§4.1：什么都允许长，但长出来的只进蒸馏质量。 */
export const DISTILL_MAX_CHARS_PER_FILE = 2000;

/** 话题文件硬上限（字符）——工地经验同样只进质量不进长度。 */
export const TOPIC_MAX_CHARS = 1500;

/** 蒸馏输入回望窗口（天）。30 天——"了解一个人"需要跨工作区的长期工作史，
 *  7 天窗口会把用户在其它工作区（漏洞挖掘 / 长期项目）的积累大部分挤出窗外，
 *  导致蒸馏出的"它眼中的你"只反映最近活跃的那个工地，而不是完整的多面能力。 */
export const DISTILL_LOOKBACK_DAYS = 30;

/** 单次蒸馏喂给模型的会话 / 任务条数上限（输入有界，输出恒定）。 */
export const DISTILL_MAX_SESSIONS = 40;
export const DISTILL_MAX_TASKS = 30;

// ===== 类型 =====

export interface DistilledMemory {
  userModel: string;
  selfModel: string;
  routines: string;
  /** P4 主动记忆（宪章 §7.3）：该想起的时候要想起的事——上次在哪栽过、
   * 临近的期限、改过版的流程。每条一行 bullet 且必须附来源与日期
   * （红线：不许编造）；带「有效至」的过期提醒在注入时被确定性过滤。 */
  reminders: string;
}

export interface DistillSessionSummary {
  title: string;
  lastMessagePreview?: string;
  messageCount?: number;
  lastActiveAt?: string;
  /** 会话尾部内容摘录（transcript 级原料——断点 5 修复：弧不再只吃标题）。 */
  excerpt?: string;
  /** 工作区名（从 agentDir 提取最后的目录名），让蒸馏弧能按工地区分面——
   *  同一个人的开发面 vs 安全面应该体现在 user-model 的不同小节里。 */
  workspaceName?: string;
}

/** 信任事件摘要（关系弧原料：被纠正/被信任/被否决 → 什么该问什么可自主）。 */
export interface DistillTrustEvent {
  kind: string;
  delta: number;
  reason: string;
  taskName: string;
  ts: number;
}

export interface DistillTaskSummary {
  name: string;
  status?: string;
  updatedAt?: number; // ms epoch
}

export interface DistillPromptInput {
  recentSessions: DistillSessionSummary[];
  recentTasks: DistillTaskSummary[];
  /** 关系弧原料：近期信任事件（被纠正/被信任/被否决）。 */
  trustEvents?: DistillTrustEvent[];
  /** 错记忆史（上下文学习）：曾被检索引用后遭用户纠正的记忆——写入前车之鉴。 */
  wrongMemories?: string[];
  /** 能力缺口复发计数（WORK_LOOP §5 能力雷达）：近 7 天按缺口聚合的
   *  预格式化行（"×N 缺口描述"），复发缺口是"沉淀造/提 PRD"的凭据。 */
  recentGaps?: string[];
  existing: DistilledMemory;
}

export interface DistillMergeResult {
  distilled: DistilledMemory;
  warnings: string[];
}

/** 蒸馏四分节的规范标题（提示词契约与解析器共用同一个 source of truth）。 */
const SECTION_HEADERS = {
  userModel: '## 它眼中的你（user-model）',
  selfModel: '## 它眼中的自己（self-model）',
  routines: '## 老规矩（routines）',
  reminders: '## 主动提醒（reminders）',
} as const;

const DISTILL_FILES: Record<keyof DistilledMemory, string> = {
  userModel: 'user-model.md',
  selfModel: 'self-model.md',
  routines: 'routines.md',
  reminders: 'reminders.md',
};

// ===== 哨兵与开关 =====

export function isDistillArcPrompt(prompt: string): boolean {
  return prompt.includes(DISTILL_SENTINEL);
}

/**
 * 配置开关：`memory.distill.enabled`，缺省视同 true（宪章 §4.2 默认在场，
 * 用户可显式关闭）。容忍任意 config 形状——读不到就当开启。
 */
export function isDistillEnabled(config: unknown): boolean {
  const c = config as { memory?: { distill?: { enabled?: unknown } } } | null | undefined;
  return c?.memory?.distill?.enabled !== false;
}

// ===== 提示词生成 =====

function formatSessionLine(s: DistillSessionSummary): string {
  const parts = [`《${s.title || '(无标题)'}》`];
  if (s.workspaceName) parts.push(`工地 ${s.workspaceName}`);
  if (typeof s.messageCount === 'number') parts.push(`消息数 ${s.messageCount}`);
  if (s.lastActiveAt) parts.push(`最后活跃 ${s.lastActiveAt}`);
  const preview = (s.lastMessagePreview ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (preview) parts.push(`最近一条: ${preview}`);
  if (s.excerpt) parts.push(`\n  内容摘录: ${s.excerpt}`);
  return `- ${parts.join('｜')}`;
}

function formatTrustEventLine(e: DistillTrustEvent): string {
  const date = new Date(e.ts).toISOString().slice(0, 10);
  const sign = e.delta > 0 ? '存款' : e.delta < 0 ? '取款' : '中性';
  const label: Record<string, string> = {
    user_done: '验收通过',
    agent_done: '完成声明',
    system_done: '自动完成',
    rework: '返工',
    user_stopped: '被叫停',
  };
  return `- ${date}｜${sign}｜${label[e.reason] ?? e.reason}｜任务《${e.taskName}》`;
}

function formatTaskLine(t: DistillTaskSummary): string {
  const parts = [`《${t.name || '(无名任务)'}》`];
  if (t.status) parts.push(`状态 ${t.status}`);
  if (typeof t.updatedAt === 'number') parts.push(`更新于 ${new Date(t.updatedAt).toISOString()}`);
  return `- ${parts.join('｜')}`;
}

function existingSection(title: string, body: string): string {
  const trimmed = body.trim();
  return `${title}\n${trimmed || '（尚无）'}`;
}

/**
 * 生成三弧蒸馏提示词。输入是裁剪后的工作史摘要 + 已有蒸馏内容；
 * 输出契约（三个 `## ` 分节、合并语义、2000 字符硬上限）写死在提示词里，
 * 与 {@link applyDistillResult} 的解析器严格对应。
 */
export function buildDistillPrompt(input: DistillPromptInput): string {
  const sessionLines = input.recentSessions.length > 0
    ? input.recentSessions.map(formatSessionLine).join('\n')
    : '（近 7 天无会话）';
  const taskLines = input.recentTasks.length > 0
    ? input.recentTasks.map(formatTaskLine).join('\n')
    : '（近 7 天无任务）';
  const trustLines = (input.trustEvents ?? []).length > 0
    ? (input.trustEvents ?? []).map(formatTrustEventLine).join('\n')
    : '（近 7 天无信任事件）';
  const wrongLines = (input.wrongMemories ?? []).filter((w) => w.trim()).slice(0, 8);
  const wrongSection = wrongLines.length > 0
    ? `\n\n# 曾被判错的记忆（写入前车之鉴）\n以下记忆被检索引用后遭用户纠正——写新认知时避免重蹈覆辙（同类内容要么不写，要么按纠正后的版本写）：\n${wrongLines.map((w) => `- ${w.replace(/\s+/g, ' ').trim().slice(0, 200)}`).join('\n')}`
    : '';
  const gapLines = (input.recentGaps ?? []).filter((g) => g.trim()).slice(0, 10);
  const gapSection = gapLines.length > 0
    ? `\n\n# 反复出现的能力缺口（能力雷达，WORK_LOOP §5）\n以下是近 7 天反复撞上的能力缺口（缺工具/缺技能），按复发次数排序。复发 ≥2 的缺口值得在「老规矩」或「主动提醒」里提议沉淀造（造工具/造插件，只提议不自动）：\n${gapLines.map((g) => `- ${g.replace(/\s+/g, ' ').trim().slice(0, 200)}`).join('\n')}`
    : '';

  return `你是 ZhiShi 的「蒸馏弧」执行者（工作生命宪章 §4.2）。你的任务：把最近的原始工作史压成蒸馏认知——不是流水账，是决策级的"懂"。原始记录是原料，蒸馏物才是它。

# 三条蒸馏弧
1. 任务弧：从最近完成的会话/任务中提炼——这类任务怎么做成的、用户的验收标准是什么。
2. 关系弧：从被纠正/被信任/被否决的痕迹中提炼——什么该请示、什么可以自主（自主分寸）。
3. 能力弧：反复出现的工作 → 可沉淀为 skill 的候选；执行中踩过的坑 → "已知坑"。

# 输出契约（严格遵守）
只输出以下四个 Markdown 分节，标题一字不差，不要输出任何其他内容（不要前言、不要总结、不要代码块围栏）：

${SECTION_HEADERS.userModel}
（第一人称叙事：用户怎么工作——验收标准、偏好、雷区。
**多面结构**：同一个人的不同工作区/领域面，用一个"## 面：xxx"第三级标题分开写
（从会话的「工地 xxx」标注推断领域；无法归类的单独一段放在最前面）。
没有多面的单工地就用旧格式。每面 1-3 句话，非流水账。）

${SECTION_HEADERS.selfModel}
（第一人称叙事：我擅长什么、在哪栽过、已知坑。）

${SECTION_HEADERS.routines}
（周期性任务、共同形成的惯例、进行中的长期事项。）

${SECTION_HEADERS.reminders}
（主动提醒（宪章 §7.3）：该想起的时候要想起的事——上次在哪栽过、临近的期限、改过版的流程。每条一行 bullet，格式：
- 提醒内容（来源：任务《名》或会话《名》｜日期：YYYY-MM-DD｜有效至：YYYY-MM-DD 或 长期）
铁律：只写上面工作史原料里有据可查的事，绝不编造；每条必须附来源与日期，没有来源的提醒是幻觉。滚动维护——删掉已过期的、已兑现的，保留仍然相关的；没有值得提醒的事就写"（暂无）"。）

# 合并语义
- 下方给出已有蒸馏内容。你的输出是**更新**，不是重写：保留仍然成立的认知，用新证据修正或增补，删掉被证伪的。
- 只写决策级事实："为什么这么做 / 坑 / 偏好 / 验收标准"。不写流水账（"某天开了个会"），不抄原始记录里能直接查到的事实清单。
- 每个分节硬上限 ${DISTILL_MAX_CHARS_PER_FILE} 字符：蒸馏质量进，窗口长度不进。写不下时优先保留被反复验证过的与被纠正过的认知。
- 某一节没有新证据时，原样保留旧内容即可。

# 已有蒸馏内容

${existingSection(SECTION_HEADERS.userModel, input.existing.userModel)}

${existingSection(SECTION_HEADERS.selfModel, input.existing.selfModel)}

${existingSection(SECTION_HEADERS.routines, input.existing.routines)}

${existingSection(SECTION_HEADERS.reminders, input.existing.reminders)}

# 最近 ${DISTILL_LOOKBACK_DAYS} 天的会话（工作史原料，含内容摘录）

${sessionLines}

# 最近 ${DISTILL_LOOKBACK_DAYS} 天的任务（工作史原料）

${taskLines}

# 最近 ${DISTILL_LOOKBACK_DAYS} 天的信任事件（关系弧原料：验收/返工/叫停）

${trustLines}${wrongSection}${gapSection}`;
}

// ===== 土匪回路 judge（检索效果的验收工序，框架 §4 的 LLM-as-judge） =====

/** judge 的输入：一条待裁定的检索事件 + 引用发生后的对话片段。 */
export interface RecallJudgeItem {
  eventId: number;
  query: string | null;
  memoryContent: string;
  /** 引用时间窗内的会话摘录（用户/AI 原文，judge 的唯一证据）。 */
  context: string;
}

/**
 * 生成记忆效果裁定提示词。判定保守优先：证据不足一律 unused——
 * 宁可不奖不罚，不可错奖错罚（错罚会把好记忆压死，错奖会让幻觉复利）。
 */
export function buildRecallJudgePrompt(items: RecallJudgeItem[]): string {
  const blocks = items.map((it) => {
    const query = it.query ? `检索词："${it.query.replace(/\s+/g, ' ').trim().slice(0, 80)}"` : '（无检索词）';
    const memory = it.memoryContent.replace(/\s+/g, ' ').trim().slice(0, 300);
    const context = it.context.trim() || '（引用后无对话记录）';
    return `[id=${it.eventId}] ${query}\n记忆内容：${memory}\n引用后的对话：\n${context}`;
  });
  return `你是记忆效果裁定员（蒸馏弧的验收工序）。下面是 agent 检索引用过的长期记忆，以及引用发生后的真实对话片段。逐条裁定这条记忆的实际效果。

# 判定标准
- effective：记忆被真正用上且对话顺利推进（用户未反驳、基于它的回答被接受）
- wrong：记忆造成了错误——用户纠正了它，或基于它的说法被推翻
- unused：记忆虽被检索出来，但对话里并未真正用上；或证据不足、判不准

# 输出契约（严格遵守）
每条记忆输出一行，格式：
<id> | effective|wrong|unused | 一句理由
不要输出任何其他内容（不要前言、不要总结、不要代码块围栏）。判不准就写 unused——保守优先。

# 待裁定记忆

${blocks.join('\n\n')}`;
}

/** 解析 judge 输出为 eventId → 裁定结果。认不出的行直接跳过（容错优先）。 */
export function parseRecallJudgeOutput(text: string): Map<number, 'effective' | 'wrong' | 'unused'> {
  const verdicts = new Map<number, 'effective' | 'wrong' | 'unused'>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*[|｜]\s*(effective|wrong|unused)\b/i);
    if (!m) continue;
    const id = Number(m[1]);
    if (!Number.isFinite(id) || verdicts.has(id)) continue;
    verdicts.set(id, m[2].toLowerCase() as 'effective' | 'wrong' | 'unused');
  }
  return verdicts;
}

// ===== LLM 输出解析与合并 =====

type DistillKey = keyof DistilledMemory;

/** 按标题把分节归类到四个蒸馏键；认不出返回 null。 */
function classifySectionHeader(header: string): DistillKey | null {
  if (/它眼中的你|user[- ]?model/i.test(header)) return 'userModel';
  if (/它眼中的自己|self[- ]?model/i.test(header)) return 'selfModel';
  if (/老规矩|routines?/i.test(header)) return 'routines';
  if (/主动提醒|reminders?/i.test(header)) return 'reminders';
  return null;
}

const KEY_ORDER: DistillKey[] = ['userModel', 'selfModel', 'routines', 'reminders'];

function capSection(body: string, key: DistillKey, warnings: string[]): string {
  const trimmed = body.trim();
  if (trimmed.length <= DISTILL_MAX_CHARS_PER_FILE) return trimmed;
  warnings.push(`分节 ${key} 超过 ${DISTILL_MAX_CHARS_PER_FILE} 字符（${trimmed.length}），已截断`);
  return trimmed.slice(0, DISTILL_MAX_CHARS_PER_FILE);
}

/**
 * 解析 LLM 输出并与已有蒸馏内容合并。
 *
 * 合并语义（残差守恒 §4.3 的工程化）：
 * - 解析成功的分节 → 采用新内容（截断到 2000 字符）；
 * - 缺失 / 为空的分节 → 保留原文并告警；
 * - 整体解析失败（一个 `## ` 分节都没有）→ 三个文件全部保留原文并告警，
 *   调用方据此可以不写盘——绝不把旧认知覆盖为空。
 */
export function applyDistillResult(existing: DistilledMemory, llmOutput: string): DistillMergeResult {
  const warnings: string[] = [];

  // 按 `## ` 标题切分（标题行本身不进正文）。
  const headingRe = /^##[ \t]+(.+?)[ \t]*$/gm;
  const headings: Array<{ header: string; start: number; bodyStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(llmOutput)) !== null) {
    headings.push({ header: m[1], start: m.index, bodyStart: m.index + m[0].length });
  }

  if (headings.length === 0) {
    warnings.push('解析失败：LLM 输出中未找到任何 "## " 分节，全部保留原文');
    return { distilled: { ...existing }, warnings };
  }

  const parsed: Partial<Record<DistillKey, string>> = {};
  const orderFallback: string[] = [];
  for (let i = 0; i < headings.length; i++) {
    const bodyEnd = i + 1 < headings.length ? headings[i + 1].start : llmOutput.length;
    const body = llmOutput.slice(headings[i].bodyStart, bodyEnd);
    const key = classifySectionHeader(headings[i].header);
    if (key) {
      // 同名分节重复出现时后者覆盖前者（模型偶尔复读）。
      parsed[key] = body;
    }
    orderFallback.push(body);
  }

  // 兜底：分节数恰好等于蒸馏键数但一个都认不出标题 → 按出现顺序映射并告警。
  if (Object.keys(parsed).length === 0 && orderFallback.length === KEY_ORDER.length) {
    warnings.push('四个分节标题均无法识别，已按出现顺序映射到 user-model / self-model / routines / reminders');
    KEY_ORDER.forEach((key, i) => { parsed[key] = orderFallback[i]; });
  }

  const distilled: DistilledMemory = { ...existing };
  for (const key of KEY_ORDER) {
    const body = parsed[key];
    if (body !== undefined && body.trim().length > 0) {
      distilled[key] = capSection(body, key, warnings);
    } else if (body !== undefined) {
      warnings.push(`分节 ${key} 内容为空，保留原文`);
    } else {
      warnings.push(`分节 ${key} 缺失，保留原文`);
    }
  }

  return { distilled, warnings };
}

// ===== 主动提醒的注入期过滤（P4，宪章 §7.3 红线） =====

/** YYYY-MM-DD（本地时区），字典序即可比较。 */
function localDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 单条提醒的结构化解析（提醒溯源，COWORK 任务8）。 */
export interface ReminderMeta {
  /** 去掉 bullet 前缀与标注后的提醒正文。 */
  text: string;
  /** 「来源：X」标注（红线：无来源的提醒不成立，解析不到返回 null）。 */
  source: string;
  date: string | null;
  validUntil: string | null;
}

/**
 * 解析一条 reminder bullet：
 * `- 提醒内容（来源：任务《X》｜日期：YYYY-MM-DD｜有效至：YYYY-MM-DD 或 长期）`
 * 无来源标注返回 null（不许编造的确定性兑底）。
 */
export function parseReminderMeta(line: string): ReminderMeta | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('-')) return null;
  const source = /来源：([^｜）]+)/.exec(trimmed)?.[1]?.trim();
  if (!source) return null;
  const date = /日期：(\d{4}-\d{2}-\d{2})/.exec(trimmed)?.[1] ?? null;
  const validUntil = /有效至：(\d{4}-\d{2}-\d{2})/.exec(trimmed)?.[1] ?? null;
  // 正文 = 去掉 bullet 前缀，再去掉末尾的标注括号。
  const text = trimmed
    .replace(/^-\s*/, '')
    .replace(/（来源：[^）]*）\s*$/, '')
    .trim();
  return text ? { text, source, date, validUntil } : null;
}

/**
 * 从 reminders 文本中筛出「此刻仍然有效」的提醒行。两条红线在这里做
 * 确定性兑底（不完全信任 LLM 自觉）：
 *   1. 不许编造 —— 没有「来源：」标注的行直接丢弃；
 *   2. 过期自动清理 —— 「有效至：YYYY-MM-DD」早于今天的行丢弃
 *     （「长期」或无有效至标注的保留）。
 * 返回保序的有效 bullet 行；输入为空 / 全部失效时返回空数组（零注入）。
 */
export function parseActiveReminders(text: string, now: Date = new Date()): string[] {
  const today = localDateString(now);
  const kept: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const meta = parseReminderMeta(line);
    if (!meta) continue;
    if (meta.validUntil && meta.validUntil < today) continue;
    kept.push(line);
  }
  return kept;
}

// ===== 文件读写（薄 IO，原子 tmp+rename） =====

function distilledDir(baseDir: string): string {
  return join(baseDir, 'memory', 'distilled');
}

function readOne(dir: string, file: string): string {
  try {
    return readFileSync(join(dir, file), 'utf-8');
  } catch {
    return '';
  }
}

/** YYYY-MM-DD（本地时区）→ 当日结束时刻（ms）；无效输入返回 undefined。 */
function validUntilToMs(validUntil: string | null): number | undefined {
  if (!validUntil) return undefined;
  const d = new Date(`${validUntil}T23:59:59`);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/** DB → 注入用 reminders 文本（bullet 行重建，来源/日期/有效至标注还原）。 */
function renderRemindersFromDb(baseDir: string): string {
  return listActive('reminder', baseDir)
    .map((e) => {
      const until = e.expiresAt ? `｜有效至：${localDateString(new Date(e.expiresAt))}` : '｜有效至：长期';
      const date = e.date ? `｜日期：${e.date}` : '';
      const src = e.source ? `（来源：${e.source}${date}${until}）` : '';
      return `- ${e.content}${src}`;
    })
    .join('\n');
}

/** 一次性迁移：库为空且旧 md 文件有内容时导入（reminders 逐条解析）。 */
let legacyImportDone = false;
function importLegacyDistilledIfNeeded(baseDir: string): void {
  if (legacyImportDone) return;
  legacyImportDone = true;
  if (allEntries(baseDir).length > 0) return;
  const legacy = readDistilledFromFiles(baseDir);
  if (!hasDistilledContent(legacy)) return;
  if (legacy.userModel.trim()) putEntry({ kind: 'user-model', content: legacy.userModel.trim(), salience: 0.9 }, baseDir);
  if (legacy.selfModel.trim()) putEntry({ kind: 'self-model', content: legacy.selfModel.trim(), salience: 0.9 }, baseDir);
  if (legacy.routines.trim()) putEntry({ kind: 'routines', content: legacy.routines.trim(), salience: 0.8 }, baseDir);
  for (const line of parseActiveReminders(legacy.reminders)) {
    const meta = parseReminderMeta(line);
    if (!meta) continue;
    putEntry({
      kind: 'reminder',
      content: meta.text,
      source: meta.source,
      date: meta.date ?? undefined,
      expiresAt: validUntilToMs(meta.validUntil),
      salience: 0.6,
    }, baseDir);
  }
  console.log('[distill] legacy md → memory store migration done');
}

/** 读四个蒸馏文件；缺失的文件返回空串。baseDir 默认 ~/.zhishi。 */
export function readDistilled(baseDir: string = getZhiShiDataDir()): DistilledMemory {
  importLegacyDistilledIfNeeded(baseDir);
  // DB 为体（§7.2 生命周期语义），md 为相（缓存/兼容）。库中有任何内容时
  // 以库为准；空库回落旧文件（未迁移环境）。
  const dbHasAny =
    latestDistilledEntry('user-model', baseDir) !== undefined ||
    latestDistilledEntry('self-model', baseDir) !== undefined ||
    latestDistilledEntry('routines', baseDir) !== undefined ||
    listActive('reminder', baseDir).length > 0;
  if (dbHasAny) {
    return {
      // 蒸馏物 = 权威视图：取蒸馏弧最近写入的一条（created_at 最大），
      // 而非 effectiveScore 最高——judge 反馈会让旧条目 useful分高，但那不代表
      // 它反映当前认知。putDistilledEntry 保证写入后每 kind 恒 1 条。
      userModel: latestDistilledEntry('user-model', baseDir)?.content ?? '',
      selfModel: latestDistilledEntry('self-model', baseDir)?.content ?? '',
      routines: latestDistilledEntry('routines', baseDir)?.content ?? '',
      reminders: renderRemindersFromDb(baseDir),
    };
  }
  return readDistilledFromFiles(baseDir);
}

/** 直接从四个 md 文件读取（旧路径，现为回落与迁移源）。 */
function readDistilledFromFiles(baseDir: string = getZhiShiDataDir()): DistilledMemory {
  const dir = distilledDir(baseDir);
  return {
    userModel: stripBom(readOne(dir, DISTILL_FILES.userModel)),
    selfModel: stripBom(readOne(dir, DISTILL_FILES.selfModel)),
    routines: stripBom(readOne(dir, DISTILL_FILES.routines)),
    reminders: stripBom(readOne(dir, DISTILL_FILES.reminders)),
  };
}

export function hasDistilledContent(d: DistilledMemory): boolean {
  return Boolean(d.userModel.trim() || d.selfModel.trim() || d.routines.trim() || d.reminders.trim());
}

/**
 * 写蒸馏物（无文件化 2026-08-01）：唯一去向是记忆库（DB 为体）。
 * md 投影已删除——灵魂/认知层只有 SQLite，没有文件影子；
 * 旧 md 仅作一次性迁移源（importLegacyDistilledIfNeeded）。
 */
export function writeDistilled(d: DistilledMemory, baseDir: string = getZhiShiDataDir()): void {
  writeDistilledToStore(d, baseDir);
}

/** 记忆库写入：叙事类（user-model/self-model/routines）按 kind 覆盖式单条沉淀
 *  （putDistilledEntry——旧版归档、恒 1 条权威）；reminders 逐条（附来源/有效期），
 *  滚动维护——从本次输出里消失的提醒移出（进 archive）。 */
function writeDistilledToStore(d: DistilledMemory, baseDir: string): void {
  try {
    const cap = (s: string) =>
      s.length > DISTILL_MAX_CHARS_PER_FILE ? s.slice(0, DISTILL_MAX_CHARS_PER_FILE) : s;
    if (d.userModel.trim()) putDistilledEntry({ kind: 'user-model', content: cap(d.userModel.trim()), salience: 0.9 }, baseDir);
    if (d.selfModel.trim()) putDistilledEntry({ kind: 'self-model', content: cap(d.selfModel.trim()), salience: 0.9 }, baseDir);
    if (d.routines.trim()) putDistilledEntry({ kind: 'routines', content: cap(d.routines.trim()), salience: 0.8 }, baseDir);
    const keys = new Set<string>();
    for (const line of parseActiveReminders(d.reminders)) {
      const meta = parseReminderMeta(line);
      if (!meta) continue;
      putEntry({
        kind: 'reminder',
        content: meta.text,
        source: meta.source,
        date: meta.date ?? undefined,
        expiresAt: validUntilToMs(meta.validUntil),
        salience: 0.6,
      }, baseDir);
      keys.add(contentKey(meta.text));
    }
    // 空输出不触发整批清除（空 ≠ 权威视图）；非空输出才是滚动维护的权威视图。
    if (keys.size > 0) retainReminders(keys, baseDir);
  } catch (err) {
    console.warn('[distill] memory store write failed:', err instanceof Error ? err.message : err);
  }
}

// ===== 话题弧（UPDATE_MEMORY 的后台继任者） =====

export interface TopicSessionSummary {
  title: string;
  lastMessagePreview?: string;
  messageCount?: number;
  lastActiveAt?: string;
}

/**
 * 话题弧提示词：维护一个工作区的经验文件 memory/topics/<name>.md。
 * 与认知弧同一哲学（合并语义、决策级事实、尺寸硬上限），但对象是
 * 「这个工地」而不是「这个人」——工地知识层，每工作区一份。
 */
export function buildTopicPrompt(input: {
  workspaceName: string;
  sessions: TopicSessionSummary[];
  existingTopic: string;
}): string {
  const lines = input.sessions.length > 0
    ? input.sessions.map(formatSessionLine).join('\n')
    : '（近 7 天无会话）';
  return `你是 ZhiShi 的「话题弧」执行者（工作生命宪章 §4.2/§4.3）。维护工作区「${input.workspaceName}」的经验文件——不是流水账，是这个工地的做法与状态。

# 写什么
- 状态与下一步：进行到哪了、接下来该做什么
- 关键事实：这个工地的结构、入口、数据在哪
- 做成了什么：最近完成的事（附日期 YYYY-MM-DD）
- 坑与决策：为什么这么做、在哪栽过、怎么绕开的

# 规矩（严格遵守）
- 输出**只写经验文件正文**，不要标题、不要前言、不要代码块围栏。
- 合并语义：下方已有内容是**更新**不是重写——保留仍成立的，用新证据修正增补，删掉被证伪的。
- 硬上限 ${TOPIC_MAX_CHARS} 字符：写不下时优先保留被反复验证过的与被纠正过的。
- 只写有原料依据的：不虚构细节，没有证据就写「（暂无新证据，保留原样）」。

# 已有经验文件

${input.existingTopic.trim() || '（尚无）'}

# 近 7 天这个工地的会话（原料）

${lines}`;
}

/** 话题弧输出处理：修剪 + 硬截断；空输出返回 null（保留原文）。 */
export function applyTopicResult(existing: string, llmOutput: string): string | null {
  const trimmed = llmOutput.trim();
  if (!trimmed || trimmed === existing.trim()) return null;
  return trimmed.length > TOPIC_MAX_CHARS ? trimmed.slice(0, TOPIC_MAX_CHARS) : trimmed;
}

/**
 * 系统提示注入用的读取入口：四个文件全为空时返回 undefined（零注入）。
 */
export function loadDistilledMemoryForPrompt(baseDir: string = getZhiShiDataDir()): DistilledMemory | undefined {
  const d = readDistilled(baseDir);
  return hasDistilledContent(d) ? d : undefined;
}
