/**
 * 1.5.1 — 专家知识的 harness 确定性注入（唯一注入路径；图论口径）。
 *
 * 设计（用户五轮迭代拍板，golang 轨迹取证驱动）：
 *   - 模型主动（1.4.x 实证失败——主动承认「我需要」是 LLM 不会做的判断）；
 *   - 人触发（1.5.0 /expert）——人不用=没有；
 *   - 推荐条——每条都是认知税（用户否决）；
 *   - **harness 确定性决策注入（唯一路径）**：决策归规则（同输入同输出），
 *     可见归人（注入透明标注，注错可纠正）；模型侧 expert_search 工具保留
 *     做 FTS 脆性兜底（不占人脑、零主动注入）。
 *
 * 图论口径（用户拍板：图论思想，不建持久图）：注入 = 以当前焦点节点为锚
 * 的邻域子图投影。节点 = 档案实体/专家条目/最近消息；边 = 档案焦点（证据/
 * 派生）/ 域先验 / 用户消息关键词（弱边即时计算）。预算分配 = 边类型加权
 * 取舍——证据边 > 域先验边 ≈ 关键词边。
 *
 * 纪律：
 *   - 零注入语义：邻域为空（无过阈条目）→ 静默，不注一行字；
 *   - 会话内去重：同一条目本 sidecar 生命周期内只注一次（内存态，重启
 *     重注可接受——宁可重注不可漏注）；
 *   - 宁可少注不可误注：权威级误命中是最贵失败形态，阈值只高不低；
 *   - 透明标注：注入段列明条目 #id，流内可见。
 *
 * 结构照 provision.ts：分词/锚点/打分/渲染是纯函数，collectExpertInjection
 * 是唯一 IO（读库可注入 entries，测试零真实库）。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';

import { listEntries, openExpertStore, type ExpertEntry } from '../expert/store';
import { getZhiShiDataDir } from '../utils/app-dirs';
import type { ArchiveSnapshot } from './archive';

// ---------------------------------------------------------------------------
// 常量（预算与阈值——纪律的数字化）
// ---------------------------------------------------------------------------

/** 边权重：档案焦点（pending H#/open Q#——证据/派生边）。 */
export const W_ARCHIVE = 3;
/** 边权重：域先验（条目域 = 会话域）。 */
export const W_DOMAIN = 2;
/** 边权重：用户消息关键词（最近消息边）。 */
export const W_USER = 2;
/** 注入阈值：域先验+任一命中，或两条档案边，或一条档案边+域先验（宁可少注）。 */
export const INJECT_SCORE_THRESHOLD = 4;
/** 单次注入条数上限。 */
export const MAX_INJECT_ENTRIES = 2;
/** 注入段硬字符上限（邻域投影只给判据与要点，全文在专家库）。 */
export const EXPERT_INJECT_MAX_CHARS = 1200;
/** 锚点文本单条截断（焦点节点的关键词来源）。 */
const ANCHOR_TEXT_MAX = 160;
/** 条目打分文本截断（title+applicability+tags+content 前 N 字符）。 */
const ENTRY_TEXT_MAX = 800;

// ---------------------------------------------------------------------------
// 纯函数 — 锚点（焦点节点）与分词（弱边即时计算）
// ---------------------------------------------------------------------------

/** 焦点锚点：pending 假设（≤2）+ open 问题（≤2）+ 最近用户消息（截断）。 */
export function focusAnchors(archive: ArchiveSnapshot | undefined, lastUserText: string): string[] {
  const anchors: string[] = [];
  if (archive) {
    const pending = archive.entities.filter((e) => e.kind === 'hypothesis' && e.status === 'pending').slice(-2);
    const open = archive.entities.filter((e) => e.kind === 'question' && e.status === 'open').slice(-2);
    for (const e of [...pending, ...open]) anchors.push(e.text.slice(0, ANCHOR_TEXT_MAX));
  }
  const user = lastUserText.trim().replace(/\s+/g, ' ');
  if (user) anchors.push(user.slice(0, ANCHOR_TEXT_MAX));
  return anchors;
}

/** 确定性分词：拉丁/数字 token（len≥2，小写化）+ CJK 连续段 bigram。 */
export function tokenize(text: string): string[] {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_][a-z0-9_.-]{1,}/g)) out.add(m[0]);
  for (const m of text.matchAll(/[一-鿿]+/g)) {
    const run = m[0];
    if (run.length === 1) out.add(run);
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return [...out];
}

/** 高频低信息量 token（命中不计分——防「这个/什么/怎么」类噪音边）。 */
const STOP_TOKENS = new Set([
  '的', '了', '是', '在', '我', '你', '他', '这', '那', '有', '和', '就', '不', '也', '都', '与', '或',
  '什么', '怎么', '如何', '这个', '那个', '我们', '你们', '可以', '没有', '一下', '现在', '还是',
  'the', 'a', 'an', 'is', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'not', 'no',
]);

function scoreTokens(text: string): Set<string> {
  return new Set(tokenize(text).filter((t) => !STOP_TOKENS.has(t)));
}

// ---------------------------------------------------------------------------
// 纯函数 — 打分（边类型加权）与取舍（预算分配）
// ---------------------------------------------------------------------------

export interface ExpertScore {
  entry: ExpertEntry;
  score: number;
  /** 命中分解（透明标注与测试断言用）。 */
  archiveHits: number;
  domainHit: boolean;
  userHits: number;
}

/** 条目对焦点锚点打分（确定性：同输入同输出）。 */
export function scoreExpertEntry(
  entry: ExpertEntry,
  archiveAnchorTokens: ReadonlySet<string>,
  userTokens: ReadonlySet<string>,
  domain: string | undefined,
): ExpertScore {
  const entryTokens = scoreTokens(
    `${entry.title} ${entry.applicability} ${entry.tags} ${entry.content.slice(0, ENTRY_TEXT_MAX)}`.slice(0, ENTRY_TEXT_MAX * 2),
  );
  let archiveHits = 0;
  for (const t of archiveAnchorTokens) if (entryTokens.has(t)) archiveHits++;
  let userHits = 0;
  for (const t of userTokens) if (entryTokens.has(t)) userHits++;
  const domainHit = domain !== undefined && entry.domain === domain;
  const score = W_ARCHIVE * archiveHits + W_DOMAIN * (domainHit ? 1 : 0) + W_USER * userHits;
  return { entry, score, archiveHits, domainHit, userHits };
}

/** 邻域取舍：过阈 + 去重 + top N（分数降序，同分按 id 升序——输出稳定）。 */
export function pickExpertInjections(
  entries: readonly ExpertEntry[],
  anchors: { archiveAnchorTokens: ReadonlySet<string>; userTokens: ReadonlySet<string> },
  domain: string | undefined,
  alreadyInjected: ReadonlySet<number>,
): ExpertScore[] {
  const scored = entries
    .filter((e) => e.enabled && !alreadyInjected.has(e.id))
    .map((e) => scoreExpertEntry(e, anchors.archiveAnchorTokens, anchors.userTokens, domain))
    .filter((s) => s.score >= INJECT_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.entry.id - b.entry.id);
  return scored.slice(0, MAX_INJECT_ENTRIES);
}

// ---------------------------------------------------------------------------
// 纯函数 — 渲染（透明标注 + 硬顶）
// ---------------------------------------------------------------------------

const EXPERT_INJECT_HEADER = '<zhishi-expert-knowledge>';
const EXPERT_INJECT_FOOTER = '</zhishi-expert-knowledge>';

/** 注入段渲染：命中条目 + #id 透明标注（流内可见，注错人可纠正）。 */
export function renderExpertInjection(picks: readonly ExpertScore[], maxChars = EXPERT_INJECT_MAX_CHARS): string {
  if (picks.length === 0) return '';
  const lines: string[] = [
    EXPERT_INJECT_HEADER,
    `专家审定知识（harness 按当前焦点自动检索注入，命中 ${picks.length} 条：${picks.map((p) => `#${p.entry.id}`).join(' ')}）——决策级依据，与你的判断冲突时以它为准并 research_log 记录冲突点；按其判据验证是否适用；不适用/注错了请无视并继续。`,
  ];
  for (const p of picks) {
    const e = p.entry;
    lines.push(`#${e.id} [${e.domain}/${e.kind}] ${e.title}`);
    lines.push(`适用条件: ${e.applicability.slice(0, 200)}`);
    lines.push(`要点: ${e.content.slice(0, 400)}`);
    lines.push(`判据: ${e.criteria.slice(0, 300)}`);
  }
  lines.push(EXPERT_INJECT_FOOTER);
  let body = lines.join('\n');
  if (body.length > maxChars) {
    body = `${body.slice(0, maxChars - EXPERT_INJECT_FOOTER.length - 20)}…（截断）\n${EXPERT_INJECT_FOOTER}`;
  }
  return body;
}

// ---------------------------------------------------------------------------
// 会话内去重（内存态——sidecar 生命周期内同条目只注一次）
// ---------------------------------------------------------------------------

const injectedBySession = new Map<string, Set<number>>();

/** 已注集合（测试与调用方读）。 */
export function injectedExpertIds(sessionId: string): ReadonlySet<number> {
  return injectedBySession.get(sessionId) ?? new Set<number>();
}

/** 测试复位（生产不调）。 */
export function __resetExpertInjectedForTests(): void {
  injectedBySession.clear();
}

// ---------------------------------------------------------------------------
// 唯一 IO — 邻域投影（读库 → 打分 → 去重登记 → 渲染）
// ---------------------------------------------------------------------------

export interface ExpertInjectInput {
  /** 当前档案（焦点节点：pending H#/open Q#）；无档案 → 只用用户消息锚。 */
  archive?: ArchiveSnapshot;
  /** 最近用户消息（焦点节点）。 */
  lastUserText: string;
  /** 会话研究域（域先验边）。 */
  domain?: string;
  /** 去重键（loop 线 sessionId）。 */
  sessionId: string;
  /** 测试注入：候选条目（缺省读 expert.db 全部 enabled）。 */
  entries?: readonly ExpertEntry[];
  /** 数据目录（测试注入临时目录）。 */
  baseDir?: string;
}

/** 最近用户消息文本提取（AgentMessage 防御式——content 字符串/数组两形）。 */
export function lastUserTextOf(messages: readonly AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return (m.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join(' ');
    }
    return '';
  }
  return '';
}

/**
 * 邻域投影：焦点锚点 → 候选打分 → 过阈去重 → 登记 → 渲染。
 * 读侧容错：库不可用/空 → ''（零注入语义，研究不因知识库故障阻塞）。
 */
export function collectExpertInjection(input: ExpertInjectInput): string {
  try {
    const entries = input.entries ?? listEntries(openExpertStore(input.baseDir ?? getZhiShiDataDir()), { limit: 1000 });
    if (entries.length === 0) return '';
    const anchorTexts = focusAnchors(input.archive, input.lastUserText);
    if (anchorTexts.length === 0) return '';
    const archiveAnchorTokens = scoreTokens(anchorTexts.slice(0, -1).join(' '));
    const userTokens = scoreTokens(anchorTexts[anchorTexts.length - 1] ?? '');
    const picks = pickExpertInjections(
      entries,
      { archiveAnchorTokens, userTokens },
      input.domain,
      injectedExpertIds(input.sessionId),
    );
    if (picks.length === 0) return '';
    let set = injectedBySession.get(input.sessionId);
    if (!set) {
      set = new Set<number>();
      injectedBySession.set(input.sessionId, set);
    }
    for (const p of picks) set.add(p.entry.id);
    return renderExpertInjection(picks);
  } catch (err) {
    console.warn('[expert-inject] 邻域投影失败,按零注入:', err instanceof Error ? err.message : String(err));
    return '';
  }
}
