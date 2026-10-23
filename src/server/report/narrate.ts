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
  '叙述是事实的引子，不是替代品——不要重复罗列全部事实条目，概括脉络即可。' +
  '写作风格（2.1）：写给非本域读者也能读懂。缩写与专有名词首次出现时用一句中文解释；' +
  '一句话只说一件事，避免长从句；不写「综上所述」「值得注意的是」这类空话；' +
  '不要用形容词堆砌专业感。技术细节照原样保留，压缩的是叙述，不是事实。';

/** 每节的写作指令（2.1）：纯叙述节有自己的格式契约，其余节沿用通用说明。 */
function sectionInstruction(section: { key: string; title: string; narrativeOnly?: boolean }): string {
  if (section.key === 'tldr') {
    return (
      '写 3–5 条结论，动词开头、一条一句、每条不超过 40 字。' +
      '顺序：发生了什么 → 影响是什么 → 下一步做什么。' +
      '不出现未解释的缩写；不复述过程；不写「本次研究」这类开场白。'
    );
  }
  if (section.key === 'glossary') {
    return (
      '只列正文事实与叙述里确实出现过的缩写/专有名词，一行一条「- 术语：一句中文解释」，最多 8 条。' +
      '解释里不许再出现未解释的缩写。没有可解释的术语就写「无」。'
    );
  }
  return `（「${section.title}」一节的叙述）`;
}

/** 逐节列出输出格式契约 + 全量事实。factOnly 节（引用的专家知识）不进 prompt。 */
export function buildNarrationPrompt(skeleton: ReportSkeleton): string {
  const narratable = skeleton.sections.filter((s) => !s.factOnly);
  const lines: string[] = [];
  lines.push(`报告域：${skeleton.template.label}（domain=${skeleton.domain}）`);
  lines.push('');
  lines.push('输出格式（严格遵守；每节一段，节与节之间不要有多余文字）：');
  for (const section of narratable) {
    lines.push(`${sectionOpenMarker(section.key)}`);
    lines.push(sectionInstruction(section));
    lines.push(SECTION_CLOSE);
  }
  lines.push('');
  lines.push('以下是各节事实（只许引用，不许改动）：');
  lines.push('');
  for (const section of narratable) {
    lines.push(`## ${section.title}（key=${section.key}）`);
    if (section.narrativeOnly) {
      // 「先看结论」「术语表」没有事实行——不能让下游模型看到「本节无事实
      // 记录」就照着写一句占位，那是我们要避免的空话。
      lines.push('（本节不提供事实行；按上面的格式，由你基于其余各节的事实来写）');
    } else if (section.facts.length === 0) {
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
  const validKeys = new Set(skeleton.sections.filter((s) => !s.factOnly).map((s) => s.key));
  const out = new Map<string, string>();
  for (const m of text.matchAll(SECTION_BLOCK_RE)) {
    const key = m[1];
    const body = (m[2] ?? '').trim();
    if (!validKeys.has(key) || body.length === 0) continue;
    if (!out.has(key)) out.set(key, body);
  }
  return out;
}
