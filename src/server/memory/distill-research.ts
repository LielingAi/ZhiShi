/**
 * 安全蒸馏弧（安全研究员版 P1 D3，技术方案 §1.4）—— 纯逻辑核心。
 *
 * 与认知蒸馏弧（./distill.ts）平行的独立弧：认知弧压的是「这个人」的全局
 * 工作史，安全弧压的是「安全研究」的结构化成败信号（research_events，D1）。
 * 独立节奏（6 小时——研究事件比日常会话稀疏）、按研究域（task_kind）分隔
 * 沉淀，经验不跨域混压。
 *
 * 输出契约三个 `## ` 分节（每节内部按「### 域：<task_kind>」组织）：
 *   成功路径（success-paths）  —— 什么打法在什么 bug_class / 目标上奏效了
 *   失败根因（failure-roots）  —— 卡在哪、为什么失败、哪条路是死的
 *   工具组合（tool-combos）    —— 哪个工具组合 / 环境配方有效或无效
 *
 * 存储选择（§1.4「照现有 distilled memory 的存储模式，独立 key/表都行」）：
 * 复用 memories 表 + keyed 权威覆盖（store.putKeyedDistilledEntry）——
 * 不建新表，蒸馏产物天然继承生命周期语义（salience/usefulness/衰减/挤兑/
 * archive 残差守恒）与检索/judge 回路。分节 → (kind, key) 映射：
 *   成功路径 → (vuln-pattern, research-distill:success-paths)
 *   失败根因 → (vuln-pattern, research-distill:failure-roots)
 *   工具组合 → (tool-combo,   research-distill:tool-combos)
 * 成功路径与失败根因都是「漏洞模式 / 根因经验」，故同落 vuln-pattern 的不同
 * key；research-log 不装蒸馏产物——它是研究流水的滚动记录 kind，留给逐事件
 * 级的短寿记录，不是本弧的权威视图。
 *
 * 本模块是纯核心 + 薄 store IO（unit 快池可测）；LLM 调用 / cron 调度 /
 * 会话摘录收集等外壳在 distill-runner.ts（runResearchDistillArc）。
 */

import { getZhiShiDataDir } from '../utils/app-dirs';
import {
  latestKeyedDistilledEntry,
  putKeyedDistilledEntry,
  RESEARCH_TASK_KINDS,
  type MemoryKind,
  type ResearchEvent,
} from './store';

// ===== 常量 =====

/** 内置 cron 任务名（幂等种子按此名查重）。 */
export const RESEARCH_DISTILL_CRON_NAME = '安全蒸馏弧';

/**
 * cron 提示词哨兵。/cron/execute-sync 据此把这次 tick 路由到确定性安全蒸馏
 * 管线，而不是当成普通 agent turn 投递（与认知弧的 DISTILL_SENTINEL 并列）。
 */
export const RESEARCH_DISTILL_SENTINEL = '<zhishi-research-distill>';

/** 种子任务的提示词——内容本身不执行，只作哨兵与档案记录。 */
export const RESEARCH_DISTILL_CRON_PROMPT = `${RESEARCH_DISTILL_SENTINEL}
系统内置任务「安全蒸馏弧」（安全研究员版 §1.4）：定期把研究成败事件压成分域安全经验。
此消息由系统调度触发，实际执行由 sidecar 的安全蒸馏管线（distill-runner.runResearchDistillArc）完成。
</zhishi-research-distill>`;

/** 蒸馏间隔（分钟）：6 小时。研究事件比日常会话稀疏，每小时空转是浪费；
 *  漏跑由引擎 past-due 补偿兜底（与认知弧同一机制）。 */
export const RESEARCH_DISTILL_INTERVAL_MINUTES = 360;

/** 单次 tick 最多蒸馏的未结算事件数（输入有界，输出恒定）。 */
export const RESEARCH_DISTILL_MAX_EVENTS = 60;

/**
 * 注入预算（字符）——`<zhishi-research-memory>` 整段硬顶
 * （system-prompt-security.ts 的 RESEARCH_MEMORY_MAX_CHARS 就是它）。
 * 蒸馏侧分节额度从它推导（1.2.4 修预算倒挂：三节上限之和曾 6000 > 注入顶
 * 2000，第三节尾部被 hardCapLines 静默整行砍掉）——预算是单一事实源，
 * 蒸馏产物写得下、注入侧才装得下。
 */
export const RESEARCH_MEMORY_INJECT_BUDGET = 2000;

/**
 * 注入侧包装开销的保守预留（`<zhishi-research-memory>` 标签 + 引言行 +
 * 三个「## 分节」标题行 + 空行），实测约 190 字符，预留放宽到 320。
 */
const INJECT_WRAPPER_RESERVE_CHARS = 320;

/**
 * 每个蒸馏分节的硬上限（字符）——按注入预算三等分（1.2.4 起）：
 * 三节 × 本节上限 + 包装预留 ≤ RESEARCH_MEMORY_INJECT_BUDGET，
 * 保证「蒸馏没截断的产物注入侧也绝不触发整行丢弃」。
 */
export const RESEARCH_DISTILL_MAX_CHARS_PER_SECTION = Math.floor(
  (RESEARCH_MEMORY_INJECT_BUDGET - INJECT_WRAPPER_RESERVE_CHARS) / 3,
);

// ===== 类型 =====

export interface ResearchDistilledMemory {
  /** 成功路径：什么打法在什么 bug_class / 目标上奏效了。 */
  successPaths: string;
  /** 失败根因：卡在哪、为什么失败、哪条路是死的。 */
  failureRoots: string;
  /** 工具组合：哪个工具组合 / 环境配方的有效性经验。 */
  toolCombos: string;
}

type ResearchDistillKey = keyof ResearchDistilledMemory;

/** 三分节的规范标题（提示词契约与解析器共用同一个 source of truth）。 */
const SECTION_HEADERS: Record<ResearchDistillKey, string> = {
  successPaths: '## 成功路径（success-paths）',
  failureRoots: '## 失败根因（failure-roots）',
  toolCombos: '## 工具组合（tool-combos）',
};

const KEY_ORDER: ResearchDistillKey[] = ['successPaths', 'failureRoots', 'toolCombos'];

/** 分节 → (kind, key) 存储映射（选择理由见文件头注释）。 */
const SECTION_TARGETS: Record<ResearchDistillKey, { kind: MemoryKind; key: string }> = {
  successPaths: { kind: 'vuln-pattern', key: 'research-distill:success-paths' },
  failureRoots: { kind: 'vuln-pattern', key: 'research-distill:failure-roots' },
  toolCombos: { kind: 'tool-combo', key: 'research-distill:tool-combos' },
};

/**
 * 分节存储映射的只读清单形态（1.2.4 注入侧 judge 降权用——system-prompt-security
 * 的 collectResearchMemory 按它把「被判 wrong 的分节」映射回 (kind, key) 查证）。
 */
export const RESEARCH_DISTILL_SECTIONS: ReadonlyArray<{
  key: keyof ResearchDistilledMemory;
  kind: MemoryKind;
  storeKey: string;
}> = KEY_ORDER.map((key) => ({ key, kind: SECTION_TARGETS[key].kind, storeKey: SECTION_TARGETS[key].key }));

// ===== 哨兵 =====

export function isResearchDistillArcPrompt(prompt: string): boolean {
  return prompt.includes(RESEARCH_DISTILL_SENTINEL);
}

// ===== 提示词生成 =====

export interface ResearchDistillPromptInput {
  /** 未结算的研究事件（任意顺序；函数内按域分组、域内按时间正序）。 */
  events: ResearchEvent[];
  /** 相关安全会话的 transcript 尾部摘录（轨迹原料，可选）。 */
  sessionExcerpts?: string[];
  /**
   * fail/stuck 事件的轨迹深摘（1.2.4，可选）：事件带 trajectory_ref 且宿主可读时，
   * 按 loop-sessions/文本尾部截取的关键片段（错误输出 / 最后几条命令）——
   * 「卡在哪」在轨迹中段，尾部 6 条会话摘录喂不出根因级原料。
   */
  trajectoryExcerpts?: string[];
  /**
   * expert_refs 条目标题表（1.2.2 引用追踪 → 1.2.4 闭环，可选）：
   * expert 条目 id → 标题，让事件行里的 expert 引用可读（「依据 expert #3《标题》」），
   * 蒸馏产物据此标注经验来源。
   */
  expertTitles?: Record<number, string>;
  existing: ResearchDistilledMemory;
}

/**
 * 生成安全蒸馏提示词。事件按研究域（task_kind）分组（§1.4：经验不跨域
 * 混压——二进制的 fuzz 经验和情报的关联经验分开沉淀）；输出契约
 * （三个 `## ` 分节、节内按域组织、合并语义、字符硬上限）与
 * {@link applyResearchDistillResult} 的解析器严格对应。
 */
export function buildResearchDistillPrompt(input: ResearchDistillPromptInput): string {
  // expert_refs 进事件行（1.2.4）：id + 条目标题（有标题时），闭上
  // 「专家知识 → 事件 → 蒸馏经验」的追溯环。
  const formatEventLine = (e: ResearchEvent): string => {
    const date = new Date(e.ts).toISOString().slice(0, 10);
    const parts = [date, e.outcome];
    if (e.bugClass) parts.push(e.bugClass);
    parts.push(e.summary.replace(/\s+/g, ' ').trim().slice(0, 200));
    if (e.trajectoryRef) parts.push(`轨迹 ${e.trajectoryRef}`);
    if (e.expertRefs && e.expertRefs.length > 0) {
      const refs = e.expertRefs.map((id) => {
        const title = input.expertTitles?.[id]?.trim();
        return title ? `#${id}《${title}》` : `#${id}`;
      });
      parts.push(`依据 expert ${refs.join('、')}`);
    }
    return `- ${parts.join('｜')}`;
  };

  // 按域分组：域序固定按 RESEARCH_TASK_KINDS 枚举序（稳定输出，便于比对），
  // 无事件的域不出现。
  const byDomain = new Map<string, ResearchEvent[]>();
  for (const e of [...input.events].sort((a, b) => a.ts - b.ts || a.id - b.id)) {
    const list = byDomain.get(e.taskKind) ?? [];
    list.push(e);
    byDomain.set(e.taskKind, list);
  }
  const eventSection = input.events.length === 0
    ? '（无未结算研究事件）'
    : RESEARCH_TASK_KINDS
      .filter((k) => byDomain.has(k))
      .map((k) => `### 域：${k}\n${byDomain.get(k)!.map(formatEventLine).join('\n')}`)
      .join('\n');

  const excerpts = (input.sessionExcerpts ?? []).filter((x) => x.trim().length > 0);
  const excerptSection = excerpts.length > 0
    ? excerpts.map((x) => `- ${x.replace(/\s+/g, ' ').trim().slice(0, 400)}`).join('\n')
    : '（无相关会话摘录）';

  const trajectories = (input.trajectoryExcerpts ?? []).filter((x) => x.trim().length > 0);
  const trajectorySection = trajectories.length > 0
    ? trajectories.map((x) => `- ${x.trim().slice(0, 800)}`).join('\n')
    : '（无轨迹深摘——fail/stuck 事件未挂宿主可读的轨迹文件）';

  function existingSection(title: string, body: string): string {
    const trimmed = body.trim();
    return `${title}\n${trimmed || '（尚无）'}`;
  }

  return `你是 ZhiShi 的「安全蒸馏弧」执行者（安全研究员版 §1.4）。你的任务：把安全研究的结构化成败事件压成分域安全经验——不是流水账，是下次上手就能用的决策级经验。

# 输出契约（严格遵守）
只输出以下三个 Markdown 分节，标题一字不差，不要输出任何其他内容（不要前言、不要总结、不要代码块围栏）：

${SECTION_HEADERS.successPaths}
（什么打法奏效了：bug_class × 利用路径 × 关键步骤 × 适用条件。）

${SECTION_HEADERS.failureRoots}
（卡在哪、为什么失败、哪条路是死的——根因与教训，不抄事件原文。）

${SECTION_HEADERS.toolCombos}
（哪个工具组合 / 环境类型在什么场景下有效或无效。）

每节内部按研究域组织：每个域一个「### 域：<task_kind>」子节（task_kind 用原料里的枚举值），无内容的域不写。

# 合并语义
- 下方给出已有蒸馏内容。你的输出是**更新**，不是重写：保留仍然成立的经验，用新证据修正或增补，删掉被证伪的。
- 经验不跨域混压：某域的经验只写进该域的子节。
- 只写下方原料里有据可查的事，绝不编造；每条经验尽量带 bug_class 或工具名等可检索锚点。
- 每个分节硬上限 ${RESEARCH_DISTILL_MAX_CHARS_PER_SECTION} 字符：蒸馏质量进，窗口长度不进。写不下时优先保留被反复验证过的经验。
- 某一节没有新证据时，原样保留旧内容即可。
- 时效与溯源标注（1.2.4 治理）：每条经验尾部带日期标注（YYYY-MM-DD，取支持它的最新事件日期）；依据了专家知识（事件行带「依据 expert #N」）的经验再标注「（源自 expert #N）」；环境相关的经验带环境锚点（如「vm:fuzz-vm」「VMware /mnt/hgfs 只读」），写清适用环境。
- 去重即置信：同一目标 / 同一 bug_class 反复出现的同类事件 = 置信加强——合并成一条经验并标注次数（如「×3 次复现」），不要拆成多条经验。

# 已有蒸馏内容

${existingSection(SECTION_HEADERS.successPaths, input.existing.successPaths)}

${existingSection(SECTION_HEADERS.failureRoots, input.existing.failureRoots)}

${existingSection(SECTION_HEADERS.toolCombos, input.existing.toolCombos)}

# 未结算的研究事件（原料，按研究域分组）

${eventSection}

# 相关安全会话的尾部摘录（轨迹原料）

${excerptSection}

# 失败/卡住事件的轨迹深摘（根因级原料：错误输出 / 最后几条命令）

${trajectorySection}`;
}

// ===== LLM 输出解析与合并 =====

/** 按标题把分节归类到三个蒸馏键；认不出返回 null。 */
function classifySectionHeader(header: string): ResearchDistillKey | null {
  if (/成功路径|success[- ]?paths?/i.test(header)) return 'successPaths';
  if (/失败根因|failure[- ]?roots?/i.test(header)) return 'failureRoots';
  if (/工具组合|tool[- ]?combos?/i.test(header)) return 'toolCombos';
  return null;
}

export interface ResearchDistillMergeResult {
  distilled: ResearchDistilledMemory;
  warnings: string[];
}

function capSection(body: string, key: ResearchDistillKey, warnings: string[]): string {
  const trimmed = body.trim();
  if (trimmed.length <= RESEARCH_DISTILL_MAX_CHARS_PER_SECTION) return trimmed;
  warnings.push(`分节 ${key} 超过 ${RESEARCH_DISTILL_MAX_CHARS_PER_SECTION} 字符（${trimmed.length}），已截断`);
  return trimmed.slice(0, RESEARCH_DISTILL_MAX_CHARS_PER_SECTION);
}

/**
 * 解析 LLM 输出并与已有蒸馏内容合并。合并语义与认知弧的 applyDistillResult
 * 同构（残差守恒 §4.3 的工程化）：
 * - 解析成功的分节 → 采用新内容（截断到硬上限）；
 * - 缺失 / 为空的分节 → 保留原文并告警；
 * - 整体解析失败（一个 `## ` 分节都没有）→ 全部保留原文并告警，调用方据此
 *   不写盘、不结算事件——绝不把旧经验覆盖为空。
 */
export function applyResearchDistillResult(
  existing: ResearchDistilledMemory,
  llmOutput: string,
): ResearchDistillMergeResult {
  const warnings: string[] = [];

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

  const parsed: Partial<Record<ResearchDistillKey, string>> = {};
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
    warnings.push('三个分节标题均无法识别，已按出现顺序映射到 success-paths / failure-roots / tool-combos');
    KEY_ORDER.forEach((key, i) => { parsed[key] = orderFallback[i]; });
  }

  const distilled: ResearchDistilledMemory = { ...existing };
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

// ===== 存取（薄 store IO：keyed 权威覆盖，选择理由见文件头注释） =====

/** 读三分节蒸馏产物；缺失的分节返回空串。baseDir 默认 ~/.zhishi。 */
export function readResearchDistilled(baseDir: string = getZhiShiDataDir()): ResearchDistilledMemory {
  const read = (key: ResearchDistillKey): string => {
    const target = SECTION_TARGETS[key];
    return latestKeyedDistilledEntry(target.kind, target.key, baseDir)?.content ?? '';
  };
  return { successPaths: read('successPaths'), failureRoots: read('failureRoots'), toolCombos: read('toolCombos') };
}

/**
 * 写蒸馏产物：非空分节按 (kind, key) 权威覆盖（旧版进 archive）；空分节不写
 * （零产出语义——解析合并层已保证空节=保留原文，到这里还有空节就是没东西可写）。
 */
export function writeResearchDistilled(d: ResearchDistilledMemory, baseDir: string = getZhiShiDataDir()): void {
  try {
    for (const key of KEY_ORDER) {
      const body = d[key].trim();
      if (!body) continue;
      const target = SECTION_TARGETS[key];
      const capped = body.length > RESEARCH_DISTILL_MAX_CHARS_PER_SECTION
        ? body.slice(0, RESEARCH_DISTILL_MAX_CHARS_PER_SECTION)
        : body;
      putKeyedDistilledEntry({ kind: target.kind, content: capped, salience: 0.8 }, target.key, baseDir);
    }
  } catch (err) {
    console.warn('[research-distill] memory store write failed:', err instanceof Error ? err.message : err);
  }
}
