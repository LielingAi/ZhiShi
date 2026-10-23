/**
 * 2.1 — 报告目录化：单漏洞文件 + index 目录。
 *
 * 数据源是**研究档案**（ArchiveSnapshot）：结论 C#n 是唯一有状态、有证据
 * 链接（links/against）、可纠正的成果实体。这里只做确定性渲染——不推断
 * 严重度、不补 CVSS：档案没记录的字段就不出现在报告里，宁缺不编。
 *
 * 目录形态（export.ts 落盘）：
 *   index.md            摘要 + 漏洞清单（链接到单文件）+ 目录
 *   report.md           完整报告（叙述 + 事实骨架）
 *   findings/C-001.md   每条结论一份
 *   evidence/           证据原文件
 *   meta.json
 *   report.zip
 */

import type { ArchiveEntity, ArchiveSnapshot } from '../loop/archive';
import { formatDateTime, type ReportSkeleton } from './skeleton';

export interface FindingDoc {
  /** 档案实体 id（C#n）。 */
  id: string;
  /** 文件名（相对报告目录），如 findings/C-001.md。 */
  filename: string;
  /** 一句话结论（实体 text 原文，不改写）。 */
  title: string;
  status: string;
  /** 结论类型（档案未标注 → undefined）。 */
  findingType?: string;
  /** 支持证据条数（links 里 V# 的数量）。 */
  evidenceCount: number;
  /** 2.2 结构化评级（研究员视角；缺失 → 报告标「未评定」）。 */
  severity?: string;
  cvss?: number;
  cvssVector?: string;
  asset?: string;
  impact?: string;
  remediation?: string;
  markdown: string;
}

const FINDING_STATUS: Record<string, string> = {
  established: '已确立',
  doubtful: '存疑',
  corrected: '已纠正',
};

const EVIDENCE_STATUS: Record<string, string> = {
  valid: '有效',
  doubtful: '存疑',
  overturned: '已被推翻',
};

const FINDING_TYPE: Record<string, string> = {
  bug_class: '漏洞类别',
  primitive: '利用原语',
  constraint: '限制条件',
  fact: '事实',
};

const SEVERITY: Record<string, string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
  info: '信息',
};

function severityLabel(value: string | undefined): string {
  if (!value) return '未评定';
  return SEVERITY[value] ?? value;
}

function label(map: Record<string, string>, value: string | undefined): string {
  if (!value) return '未标注';
  return map[value] ?? value;
}

/** 表格单元格转义：结论正文里可能有 `|`，不转义会把表拆坏。 */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

/** C#12 → C-012（文件名排序稳定）。 */
function findingFilename(id: string): string {
  const m = /^C#(\d+)$/.exec(id);
  if (!m) return `findings/${id.replace(/[^\w-]+/g, '-')}.md`;
  return `findings/C-${m[1]!.padStart(3, '0')}.md`;
}

function entityLine(id: string, byId: Map<string, ArchiveEntity>): string {
  const entity = byId.get(id);
  if (!entity) return `- ${id}（档案中已不存在）`;
  return `- ${id} · ${label(EVIDENCE_STATUS, entity.status)}：${entity.text}`;
}

/** 每条结论一份 markdown（纯事实：结论/状态/来源/证据/反证/纠正标记）。 */
export function renderFindingDocs(snapshot?: ArchiveSnapshot): FindingDoc[] {
  if (!snapshot || snapshot.entities.length === 0) return [];
  const byId = new Map(snapshot.entities.map((e) => [e.id, e]));
  const findings = snapshot.entities.filter((e) => e.kind === 'finding');
  return findings.map((f) => {
    const filename = findingFilename(f.id);
    const lines: string[] = [];
    lines.push(`# ${f.id} · ${f.text}`);
    lines.push('');
    lines.push(`- 结论类型：${label(FINDING_TYPE, f.findingType)}`);
    lines.push(`- 状态：${label(FINDING_STATUS, f.status)}`);
    const cvss = typeof f.cvss === 'number'
      ? ` · CVSS ${f.cvss.toFixed(1)}${f.cvssVector ? `（${f.cvssVector}）` : ''}`
      : '';
    lines.push(`- 严重度：${severityLabel(f.severity)}${cvss}`);
    if (f.asset) lines.push(`- 受影响资产：${f.asset}`);
    if (f.impact) lines.push(`- 影响：${f.impact}`);
    if (f.remediation) lines.push(`- 修复建议：${f.remediation}`);
    if (f.anchorLabel) lines.push(`- 来源：${f.anchorLabel}`);
    else if (f.anchorMessageId) lines.push(`- 来源消息：${f.anchorMessageId}`);
    if (f.validFrom || f.validTo) {
      lines.push(`- 事实有效期：${f.validFrom ?? '未知'} → ${f.validTo ?? '至今'}`);
    }
    if (f.needsReview) lines.push(`- 待复核：${f.reviewReason ?? '依赖的实体已被纠正'}`);
    if (f.humanCorrected) lines.push('- 已由人工纠正（以本文件状态为准）');
    lines.push('');
    lines.push('## 支持证据');
    lines.push('');
    const supportive = f.links.filter((id) => id.startsWith('V#'));
    lines.push(...(supportive.length > 0 ? supportive.map((id) => entityLine(id, byId)) : ['- （未挂支持证据）']));
    if (f.against && f.against.length > 0) {
      lines.push('');
      lines.push('## 反证');
      lines.push('');
      lines.push(...f.against.map((id) => entityLine(id, byId)));
    }
    lines.push('');
    lines.push('## 关联');
    lines.push('');
    const related = f.links.filter((id) => !id.startsWith('V#'));
    lines.push(...(related.length > 0 ? related.map((id) => entityLine(id, byId)) : ['- （无）']));
    lines.push('');
    if (!f.severity && typeof f.cvss !== 'number') {
      lines.push('> 评级未记录（严重度 / CVSS 未评定）——本文件只陈述档案中已举证的事实。');
      lines.push('');
    }
    return {
      id: f.id,
      filename,
      title: f.text,
      status: f.status,
      ...(f.findingType ? { findingType: f.findingType } : {}),
      evidenceCount: supportive.length,
      ...(f.severity ? { severity: f.severity } : {}),
      ...(typeof f.cvss === 'number' ? { cvss: f.cvss } : {}),
      ...(f.cvssVector ? { cvssVector: f.cvssVector } : {}),
      ...(f.asset ? { asset: f.asset } : {}),
      ...(f.impact ? { impact: f.impact } : {}),
      ...(f.remediation ? { remediation: f.remediation } : {}),
      markdown: `${lines.join('\n').trimEnd()}\n`,
    };
  });
}

export interface RenderIndexInput {
  skeleton: ReportSkeleton;
  findings: FindingDoc[];
  /** 叙述（tldr 用；没有就回落到事件计数）。 */
  narration?: ReadonlyMap<string, string>;
  headerNotes?: string[];
}

/** index.md：摘要 + 漏洞清单（单文件链接）+ 目录。 */
export function renderReportIndex(input: RenderIndexInput): string {
  const { skeleton, findings } = input;
  const lines: string[] = [];
  lines.push(`# 安全研究报告（${skeleton.template.label}）`);
  lines.push('');
  lines.push(`- 生成时间：${formatDateTime(skeleton.generatedAt)}`);
  lines.push(`- 工作区：${skeleton.workspace}`);
  lines.push(`- 环境：${skeleton.envId}`);
  lines.push(`- 研究事件：${skeleton.eventIds.length} 条`);
  lines.push(`- 已举证结论：${findings.length} 条`);
  for (const note of input.headerNotes ?? []) {
    lines.push('');
    lines.push(`> ${note}`);
  }
  lines.push('');

  lines.push('## 先看结论');
  lines.push('');
  const tldr = input.narration?.get('tldr')?.trim();
  if (tldr) {
    lines.push(tldr);
  } else {
    // 降级：没有叙述时给确定性统计，不留空节。
    const events = skeleton.events;
    const success = events.filter((e) => e.outcome === 'success').length;
    const classes = [...new Set(events.filter((e) => e.bugClass).map((e) => e.bugClass as string))];
    lines.push(`- 共 ${events.length} 条研究事件，成功 ${success} 条`);
    lines.push(`- ${classes.length > 0 ? `涉及漏洞类别：${classes.join(' / ')}` : '未记录漏洞类别'}`);
    lines.push('- 结论摘要未生成（本次导出未经叙述润色），请以「完整报告」中的事实为准');
  }
  lines.push('');

  lines.push('## 漏洞清单');
  lines.push('');
  if (findings.length > 0) {
    lines.push('| 编号 | 结论 | 类型 | 严重度 | CVSS | 状态 | 支持证据 |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const f of findings) {
      const type = f.findingType ? label(FINDING_TYPE, f.findingType) : '—';
      const cvss = typeof f.cvss === 'number' ? f.cvss.toFixed(1) : '—';
      lines.push(
        `| [${f.id}](${f.filename}) | ${escapeCell(f.title)} | ${type} | ${severityLabel(f.severity)} | ${cvss} | ${label(FINDING_STATUS, f.status)} | ${f.evidenceCount} |`,
      );
    }
    lines.push('');
    lines.push('> 评级为档案记录值；未记录的标「未评定」，不补默认值。');
  } else {
    const bugEvents = skeleton.events.filter((e) => e.bugClass);
    if (bugEvents.length === 0) {
      lines.push('- 档案中无已举证结论，研究事件也未记录漏洞类别');
    } else {
      for (const e of bugEvents) {
        lines.push(`- [#${e.id}](${'report.md'}) · ${e.bugClass}：${e.summary}`);
      }
      lines.push('');
      lines.push('> 这些是研究事件里的漏洞类别记录，尚未形成带证据链的档案结论。');
    }
  }
  lines.push('');

  lines.push('## 目录');
  lines.push('');
  lines.push('- [完整报告（叙述 + 事实骨架）](report.md)');
  if (findings.length > 0) lines.push(`- [单条结论（${findings.length} 份）](findings/)`);
  if (skeleton.evidenceRefs.length > 0) lines.push(`- [证据文件（${skeleton.evidenceRefs.length} 项）](evidence/)`);
  lines.push('- [导出元数据](meta.json)');
  lines.push('- [打包下载](report.zip)');
  lines.push('');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
