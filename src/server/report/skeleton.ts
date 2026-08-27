/**
 * 1.2.0 — 报告骨架组装（纯函数，防幻觉红线的「事实层」）。
 *
 * 输入 = workspace 的 research_events（时间正序）+ 当前会话 transcript；
 * 输出 = 按域模板的结构化骨架。骨架里的每一个字都是代码钉死的事实
 * （事件时间线 / bug_class / summary / 证据引用 / 文件:行号原文摘录 /
 * 专家知识引用），LLM 只许围绕它写叙述（narrate.ts），永远没有改事实的机会。
 * 「引用的专家知识」节（1.2.2，factOnly）连叙述都不进——prompt 不含、回填不收。
 *
 * 子代理 transcript 本版不组装（v1 只组装主线 + 事件，design 边界）。
 */

import type { LoopTranscript, LoopTranscriptEntry } from '../loop/transcript';
import type { ResearchEvent } from '../memory/store';
import { renderArchiveForReport, type ArchiveSnapshot } from '../loop/archive';
import { selectDomainTemplate, type DomainTemplate, type ReportDomain } from './templates';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReportSection {
  key: string;
  title: string;
  /** 钉死的事实行（渲染时带 '- ' 前缀；LLM 只许引用不许改动）。 */
  facts: string[];
  /**
   * 纯事实节（1.2.2「引用的专家知识」）：不进填肉 prompt、不接受叙述回填——
   * LLM 连写引子的机会都没有，本节每个字都是代码钉死的。
   */
  factOnly?: boolean;
}

/** 专家知识引用（1.2.2）：事件 expert_refs 解析后的条目引用。 */
export interface ExpertCitation {
  entryId: number;
  /** 条目已删除/不可考时为 undefined（记录时保证存在，之后可能被删）。 */
  title?: string;
  kind?: string;
  /** 引用该条目的研究事件 id（时间正序去重）。 */
  eventIds: number[];
}

export interface EvidenceRef {
  eventId: number;
  /** 环境内路径（trajectory_ref 登记值）。 */
  guestPath: string;
}

export interface EvidenceRecovery {
  eventId: number;
  guestPath: string;
  status: 'recovered' | 'degraded';
  /** recovered：回收到的宿主路径（reportDir 相对）。 */
  savedTo?: string;
  /** degraded：降级原因（写进报告与 meta.json）。 */
  note?: string;
}

export interface ReportSkeleton {
  domain: ReportDomain;
  template: DomainTemplate;
  workspace: string;
  envId: string;
  /** ms epoch。 */
  generatedAt: number;
  /** 时间正序的事件（骨架事实的唯一来源）。 */
  events: ResearchEvent[];
  eventIds: number[];
  evidenceRefs: EvidenceRef[];
  /** 引用的专家知识（1.2.2；无引用 → 空数组，报告不出该节）。 */
  expertRefs: ExpertCitation[];
  /** transcript 摘录池（截断预算超限时砍这里，事件层不动）。 */
  excerpts: string[];
  /** 文件:行号 摘录（白盒证据定位；建骨架时从 transcript 扫出后随骨架走）。 */
  fileLineRefs: string[];
  sections: ReportSection[];
  /** 证据回收结果（withEvidenceResults 回填；未回收前为 undefined）。 */
  evidenceResults?: EvidenceRecovery[];
  /** 1.4.4 研究档案的交付投影（成果报告从档案派生——纯事实，不进叙述）。 */
  archiveMarkdown?: string;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Time formatting（本地时区；测试 pin TZ）
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 'YYYY-MM-DD HH:mm'（本地时区）。 */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 'YYYYMMDD-HHmm'（本地时区）——报告目录名用。 */
export function formatReportTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Transcript excerpts
// ---------------------------------------------------------------------------

const MAX_EXCERPTS = 24;
const MAX_EXCERPT_CHARS = 300;

/** 文件:行号 形态（白盒证据定位；对全部 transcript 文本扫描）。 */
const FILE_LINE_RE = /[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8}:\d+/g;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 关键 transcript 段：工具调用（名+参数摘要）与工具结果原文，时间序，
 * 数量/单条长度双护栏。用户/助手自由文本不进骨架（复现要的是操作证据）。
 */
export function extractTranscriptExcerpts(entries: LoopTranscriptEntry[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.role === 'assistant' && entry.toolCalls) {
      for (const tc of entry.toolCalls) {
        out.push(clip(`${tc.name} ${tc.argsSummary}`, MAX_EXCERPT_CHARS));
      }
    } else if (entry.role === 'tool') {
      const head = `[${entry.toolName ?? 'tool'}${entry.isError ? ' 错误' : ''}]`;
      out.push(clip(`${head} ${entry.text ?? ''}`, MAX_EXCERPT_CHARS));
    }
    if (out.length >= MAX_EXCERPTS) break;
  }
  return out.slice(0, MAX_EXCERPTS);
}

/** 文件:行号 摘录（白盒模板的确认漏洞节）：去重、限量、保留时间序。 */
export function extractFileLineRefs(entries: LoopTranscriptEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    const texts: string[] = [];
    if (entry.text) texts.push(entry.text);
    for (const tc of entry.toolCalls ?? []) texts.push(tc.argsSummary);
    for (const text of texts) {
      for (const m of text.matchAll(FILE_LINE_RE)) {
        if (!seen.has(m[0])) {
          seen.add(m[0]);
          out.push(m[0]);
          if (out.length >= 20) return out;
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section facts（按 section.key 分派——key 是 templates.ts 的契约）
// ---------------------------------------------------------------------------

function outcomeTally(events: ResearchEvent[]): { success: number; fail: number; stuck: number } {
  const tally = { success: 0, fail: 0, stuck: 0 };
  for (const e of events) tally[e.outcome] += 1;
  return tally;
}

function scopeFacts(workspace: string, envId: string, events: ResearchEvent[]): string[] {
  const tally = outcomeTally(events);
  const sorted = [...events].sort((a, b) => a.ts - b.ts || a.id - b.id);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return [
    `工作区：${workspace}`,
    `环境：${envId}`,
    `研究事件：${events.length} 条（成功 ${tally.success} / 失败 ${tally.fail} / 卡住 ${tally.stuck}）`,
    `时间跨度：${formatDateTime(first.ts)} → ${formatDateTime(last.ts)}`,
  ];
}

function timelineFacts(events: ResearchEvent[]): string[] {
  const sorted = [...events].sort((a, b) => a.ts - b.ts || a.id - b.id);
  return sorted.map((e) => {
    const bug = e.bugClass ? ` · ${e.bugClass}` : '';
    return `[${formatDateTime(e.ts)}] #${e.id} ${e.taskKind}/${e.outcome}${bug}：${e.summary}`;
  });
}

/** 有 bug_class 的事件 = 确认发现；补上白盒的 文件:行号 摘录。 */
function findingsFacts(events: ResearchEvent[], fileLineRefs: string[]): string[] {
  const facts = events
    .filter((e) => e.bugClass !== undefined)
    .sort((a, b) => a.ts - b.ts || a.id - b.id)
    .map((e) => `${e.bugClass}（#${e.id} ${e.outcome}，${formatDateTime(e.ts)}）：${e.summary}`);
  if (fileLineRefs.length > 0) {
    facts.push(`代码定位摘录（transcript 原文）：${fileLineRefs.join('，')}`);
  }
  return facts;
}

/** 利用链 = 成功事件的时间序（SQLi→secrets→LFI→flag 这类链就是成功步骤序列）。 */
function exploitChainFacts(events: ResearchEvent[]): string[] {
  const successes = events
    .filter((e) => e.outcome === 'success')
    .sort((a, b) => a.ts - b.ts || a.id - b.id);
  return successes.map((e, i) => `步骤 ${i + 1}（#${e.id}，${formatDateTime(e.ts)}）：${e.summary}`);
}

function fixFacts(events: ResearchEvent[]): string[] {
  const classes = [...new Set(events.filter((e) => e.bugClass).map((e) => e.bugClass as string))];
  if (classes.length === 0) return ['（未记录 bug_class——修复建议以发现节的事实为准）'];
  return [`涉及漏洞类别：${classes.join(' / ')}`];
}

function summaryFacts(events: ResearchEvent[]): string[] {
  const tally = outcomeTally(events);
  return [
    `共 ${events.length} 条研究事件：成功 ${tally.success} / 失败 ${tally.fail} / 卡住 ${tally.stuck}`,
  ];
}

/** 证据节事实（回收前 = 待回收；withEvidenceResults 回填最终状态）。 */
function evidenceFacts(refs: EvidenceRef[], results?: EvidenceRecovery[]): string[] {
  if (refs.length === 0) {
    return ['（无 trajectory_ref 登记——老数据或未挂工件路径的事件按此降级）'];
  }
  return refs.map((ref) => {
    const result = results?.find((r) => r.eventId === ref.eventId && r.guestPath === ref.guestPath);
    if (!result) return `#${ref.eventId} \`${ref.guestPath}\`（待回收）`;
    if (result.status === 'recovered') {
      return `#${ref.eventId} \`${ref.guestPath}\` → 已回收至 \`${result.savedTo}\``;
    }
    return `#${ref.eventId} \`${ref.guestPath}\`（降级：${result.note}）`;
  });
}

/** 「引用的专家知识」节事实（1.2.2）：条目 + 引用它的事件，双向可追。 */
function expertRefsFacts(citations: ExpertCitation[]): string[] {
  return citations.map((c) => {
    const events = c.eventIds.map((id) => `#${id}`).join(' ');
    if (c.title === undefined) {
      return `#${c.entryId}（条目已删除或不可考）：事件 ${events} 曾引用`;
    }
    return `#${c.entryId}《${c.title}》（${c.kind}）：事件 ${events} 的决策依据`;
  });
}

function factsForSection(
  key: string,
  ctx: {
    workspace: string;
    envId: string;
    events: ResearchEvent[];
    excerpts: string[];
    fileLineRefs: string[];
    evidenceRefs: EvidenceRef[];
    expertRefs: ExpertCitation[];
    evidenceResults?: EvidenceRecovery[];
  },
): string[] {
  switch (key) {
    case 'target':
    case 'input-surface':
      return scopeFacts(ctx.workspace, ctx.envId, ctx.events);
    case 'recon':
    case 'crash-analysis':
    case 'timeline':
      return timelineFacts(ctx.events);
    case 'findings':
    case 'confirmed-vulns':
      return findingsFacts(ctx.events, ctx.fileLineRefs);
    case 'exploit-chain':
    case 'exploit-path':
      return exploitChainFacts(ctx.events);
    case 'repro':
      return ctx.excerpts;
    case 'evidence':
      return evidenceFacts(ctx.evidenceRefs, ctx.evidenceResults);
    case 'expert-refs':
      return expertRefsFacts(ctx.expertRefs);
    case 'fix':
      return fixFacts(ctx.events);
    case 'summary':
      return summaryFacts(ctx.events);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Assembly / rendering / truncation
// ---------------------------------------------------------------------------

export interface BuildSkeletonInput {
  workspace: string;
  envId: string;
  events: ResearchEvent[];
  transcript: LoopTranscript;
  /** ms epoch（注入时钟，测试可钉）。 */
  now: number;
  /**
   * 专家条目查证（1.2.2 引用追踪）：按 id 取 title/kind，查不到（已删除）
   * 返回 null。缺省 → expert_refs 一律按「不可考」渲染（纯骨架不联网不猜）。
   */
  lookupExpertEntry?: (id: number) => { title: string; kind: string } | null;
  /**
   * 1.4.4 研究档案（本会话 loop 线的档案快照）——报告 = 档案的交付投影：
   * 结论带证据锚、证伪与纠正独立成节。缺省/空档案 → 报告零变化。
   */
  archive?: ArchiveSnapshot;
}

/**
 * 组装骨架。events 任意顺序入参（内部按时间正序排）；空事件/空 transcript
 * 由调用方（export.ts）拦下报「没有可导出的研究记录」，这里不做防御性报错。
 */
export function buildReportSkeleton(input: BuildSkeletonInput): ReportSkeleton {
  const events = [...input.events].sort((a, b) => a.ts - b.ts || a.id - b.id);
  const template = selectDomainTemplate(events);
  const excerpts = extractTranscriptExcerpts(input.transcript.entries);
  const fileLineRefs = extractFileLineRefs(input.transcript.entries);
  const evidenceRefs: EvidenceRef[] = [];
  const seenRefs = new Set<string>();
  for (const e of events) {
    const ref = e.trajectoryRef?.trim();
    if (!ref) continue;
    const dedupeKey = `${e.id}:${ref}`;
    if (seenRefs.has(dedupeKey)) continue;
    seenRefs.add(dedupeKey);
    evidenceRefs.push({ eventId: e.id, guestPath: ref });
  }
  // 专家引用：事件 expert_refs → 按条目聚合（条目 id 升序，事件 id 时间序）。
  const citationsById = new Map<number, ExpertCitation>();
  for (const e of events) {
    for (const entryId of e.expertRefs ?? []) {
      const cur = citationsById.get(entryId);
      if (cur) {
        if (!cur.eventIds.includes(e.id)) cur.eventIds.push(e.id);
        continue;
      }
      const entry = input.lookupExpertEntry?.(entryId) ?? null;
      citationsById.set(entryId, {
        entryId,
        ...(entry ? { title: entry.title, kind: entry.kind } : {}),
        eventIds: [e.id],
      });
    }
  }
  const expertRefs = [...citationsById.values()].sort((a, b) => a.entryId - b.entryId);
  // 1.4.4 研究档案交付投影：纯事实（结论带证据锚/证伪与纠正/未决问题），
  // 不进叙述填肉（与 expert-refs 同纪律——档案每个字都是代码钉死的）。
  const archiveMarkdown = input.archive && input.archive.entities.length > 0
    ? renderArchiveForReport(input.archive)
    : undefined;
  const skeleton: ReportSkeleton = {
    domain: template.domain,
    template,
    workspace: input.workspace,
    envId: input.envId,
    generatedAt: input.now,
    events,
    eventIds: events.map((e) => e.id),
    evidenceRefs,
    expertRefs,
    excerpts,
    fileLineRefs,
    sections: [],
    ...(archiveMarkdown ? { archiveMarkdown } : {}),
    truncated: false,
  };
  skeleton.sections = buildSections(skeleton);
  return skeleton;
}

function buildSections(skeleton: ReportSkeleton): ReportSection[] {
  const ctx = {
    workspace: skeleton.workspace,
    envId: skeleton.envId,
    events: skeleton.events,
    excerpts: skeleton.excerpts,
    fileLineRefs: skeleton.fileLineRefs,
    evidenceRefs: skeleton.evidenceRefs,
    expertRefs: skeleton.expertRefs,
    ...(skeleton.evidenceResults ? { evidenceResults: skeleton.evidenceResults } : {}),
  };
  const sections: ReportSection[] = skeleton.template.sections.map((spec) => ({
    key: spec.key,
    title: spec.title,
    facts: factsForSection(spec.key, ctx),
  }));
  // pentest 模板无独立证据节(design 节清单)——证据引用/回收状态是硬事实，
  // 必须有家:挂到「发现」节末尾。
  if (!sections.some((s) => s.key === 'evidence')) {
    const host = sections.find((s) => s.key === 'findings') ?? sections[sections.length - 1];
    if (host) host.facts.push(...evidenceFacts(ctx.evidenceRefs, ctx.evidenceResults));
  }
  // 1.2.2「引用的专家知识」：模板通用——有引用才追加纯事实节（factOnly：
  // LLM 填肉不进这节），无引用的报告零变化。
  if (skeleton.expertRefs.length > 0) {
    sections.push({ key: 'expert-refs', title: '引用的专家知识', facts: factsForSection('expert-refs', ctx), factOnly: true });
  }
  return sections;
}

/** 证据回收完成后回填证据节事实（纯函数，返回新骨架）。 */
export function withEvidenceResults(skeleton: ReportSkeleton, results: EvidenceRecovery[]): ReportSkeleton {
  const next: ReportSkeleton = { ...skeleton, evidenceResults: results };
  next.sections = buildSections(next);
  return next;
}

export interface RenderOptions {
  /** 节叙述（narrate.ts 产出）；缺节/缺整图 → 该节/全文只有骨架事实。 */
  narration?: ReadonlyMap<string, string>;
  /** 头部降级标注（如「未经叙述润色」），逐行渲染成引用块。 */
  headerNotes?: string[];
}

/** 渲染报告 markdown：事实永远逐行在（'- ' 列表），叙述在前作引子。 */
export function renderReportMarkdown(skeleton: ReportSkeleton, options: RenderOptions = {}): string {
  const lines: string[] = [];
  lines.push(`# 安全研究报告（${skeleton.template.label}）`);
  lines.push('');
  lines.push(`- 生成时间：${formatDateTime(skeleton.generatedAt)}`);
  lines.push(`- 工作区：${skeleton.workspace}`);
  lines.push(`- 环境：${skeleton.envId}`);
  lines.push(`- 研究事件：${skeleton.eventIds.map((id) => `#${id}`).join(' ')}`);
  for (const note of options.headerNotes ?? []) {
    lines.push('');
    lines.push(`> ${note}`);
  }
  lines.push('');
  for (const section of skeleton.sections) {
    lines.push(`## ${section.title}`);
    lines.push('');
    // factOnly 节（引用的专家知识）纯事实渲染——填肉 prompt 不含此节，
    // 这里也不接受叙述回填（双重防线）。
    const narration = section.factOnly ? undefined : options.narration?.get(section.key)?.trim();
    if (narration) {
      lines.push(narration);
      lines.push('');
    }
    if (section.facts.length === 0) {
      lines.push('（本节无事实记录）');
    } else {
      for (const fact of section.facts) lines.push(`- ${fact}`);
    }
    lines.push('');
  }
  // 1.4.4 研究档案交付投影：纯事实附录（结论带证据锚/证伪与纠正/未决
  // 问题）——「报告不是另写的文案，是举证档案的投影」。
  if (skeleton.archiveMarkdown) {
    lines.push(skeleton.archiveMarkdown);
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** 骨架渲染后的字符预算（LLM 填肉的输入规模护栏；超了砍 transcript 摘录）。 */
export const MAX_SKELETON_CHARS = 48_000;

/**
 * 截断：超预算时从尾部砍 transcript 摘录（事件层/证据引用一刀不动，
 * design「保留事件层，砍原始输出」）。已是截断态或预算内 → 原样返回。
 */
export function truncateSkeleton(skeleton: ReportSkeleton, maxChars: number = MAX_SKELETON_CHARS): ReportSkeleton {
  if (renderReportMarkdown(skeleton).length <= maxChars) return skeleton;
  const excerpts = [...skeleton.excerpts];
  let next: ReportSkeleton = skeleton;
  while (excerpts.length > 0) {
    excerpts.pop();
    next = { ...skeleton, excerpts, truncated: true };
    next.sections = buildSections(next);
    if (renderReportMarkdown(next).length <= maxChars) break;
  }
  return { ...next, truncated: true };
}
