/**
 * 1.2.0 — 报告 LLM 填肉（纯函数：prompt 构造与输出解析；loop 调用在
 * export.ts 以注入形式进入）。
 *
 * 纪律（design「组装」节）：LLM 只写「过程叙述」段落，事实层不许碰——
 * prompt 里逐字声明「只许引用不许改动」，渲染时事实行恒由代码原样输出
 * （renderReportMarkdown），模型产出只是节前的引子段落。
 *
 * 一次 loop 调用写完所有节。分节输出标记：
 *   <<<SECTION:节key>>> ... <<<END>>>
 * 解析失败（缺节/标记残缺/空段落）→ 该节回退骨架原文，不炸；整次调用
 * 失败由 export.ts 兜底成「未经叙述润色」的纯骨架报告。
 */

import type { ReportSkeleton } from './skeleton';

export const SECTION_OPEN_PREFIX = '<<<SECTION:';
export const SECTION_CLOSE = '<<<END>>>';

export function sectionOpenMarker(key: string): string {
  return `${SECTION_OPEN_PREFIX}${key}>>>`;
}

export const NARRATION_SYSTEM_PROMPT =
  '你是安全研究报告撰写者。输入是一份报告的事实骨架（按节组织）。' +
  '为每一节写一段连贯的中文过程叙述，把该节事实串成可读的报告文字。' +
  '硬性纪律：事实字段（数字、路径、行号、flag、时间、漏洞类别、事件编号）只许引用，' +
  '不得改动、不得四舍五入、不得编造骨架里没有的新事实；拿不准就照抄原文。' +
  '叙述是事实的引子，不是替代品——不要重复罗列全部事实条目，概括脉络即可。';

/** 逐节列出输出格式契约 + 全量事实。 */
export function buildNarrationPrompt(skeleton: ReportSkeleton): string {
  const lines: string[] = [];
  lines.push(`报告域：${skeleton.template.label}（domain=${skeleton.domain}）`);
  lines.push('');
  lines.push('输出格式（严格遵守；每节一段，节与节之间不要有多余文字）：');
  for (const section of skeleton.sections) {
    lines.push(`${sectionOpenMarker(section.key)}`);
    lines.push(`（「${section.title}」一节的叙述）`);
    lines.push(SECTION_CLOSE);
  }
  lines.push('');
  lines.push('以下是各节事实（只许引用，不许改动）：');
  lines.push('');
  for (const section of skeleton.sections) {
    lines.push(`## ${section.title}（key=${section.key}）`);
    if (section.facts.length === 0) {
      lines.push('（本节无事实记录——写一句「本节无记录」即可）');
    } else {
      for (const fact of section.facts) lines.push(`- ${fact}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const SECTION_BLOCK_RE = /<<<SECTION:([\w-]+)>>>([\s\S]*?)<<<END>>>/g;

/**
 * 解析分节输出。只接受「key 在模板内 + 段落非空」的节；其余（乱标记、
 * 未知 key、空段落）静默丢弃——调用方按「缺节 → 骨架原文」处理。
 */
export function parseNarratedSections(text: string, skeleton: ReportSkeleton): Map<string, string> {
  const validKeys = new Set(skeleton.sections.map((s) => s.key));
  const out = new Map<string, string>();
  for (const m of text.matchAll(SECTION_BLOCK_RE)) {
    const key = m[1];
    const body = (m[2] ?? '').trim();
    if (!validKeys.has(key) || body.length === 0) continue;
    if (!out.has(key)) out.set(key, body);
  }
  return out;
}
