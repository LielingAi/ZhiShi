/**
 * 专家知识层（1.2.1 骨架期）——格式契约单点校验。
 *
 * `validateEntry()` 是所有写入路径（内置种子 / admin add/update / agent 草稿
 * 审定）的唯一入口：闭集枚举（kind/domain/provenance）、必填非空
 * （title/applicability/content/criteria）、reviewer 条件必填
 * （provenance≠builtin 时——权威性来源是人审这个动作）。
 *
 * 纯函数，无 IO。
 *
 * 1.2.3 起本模块从 server/expert/validate.ts 迁至 shared（issue #5）：CLI
 * 编辑器往返通道直接调 validateEntry，此前因此把 server 运行时卷进 CLI
 * bundle。server/expert/validate.ts 保留 re-export 壳，既有引用路径不变。
 */
import { createHash } from 'crypto';

import { RESEARCH_TASK_KINDS, isResearchTaskKind, type ResearchTaskKind } from './research-kinds';

export const EXPERT_ENTRY_KINDS = ['idea', 'technique', 'sop'] as const;
export type ExpertEntryKind = (typeof EXPERT_ENTRY_KINDS)[number];

export const EXPERT_PROVENANCES = ['builtin', 'user', 'promoted'] as const;
export type ExpertProvenance = (typeof EXPERT_PROVENANCES)[number];

export function isExpertEntryKind(v: string): v is ExpertEntryKind {
  return (EXPERT_ENTRY_KINDS as readonly string[]).includes(v);
}
export function isExpertProvenance(v: string): v is ExpertProvenance {
  return (EXPERT_PROVENANCES as readonly string[]).includes(v);
}

/** 校验入参（各通道的原始字段，类型未知——admin API 可被直接调用）。 */
export interface ExpertEntryInput {
  domain?: unknown;
  kind?: unknown;
  title?: unknown;
  applicability?: unknown;
  content?: unknown;
  criteria?: unknown;
  provenance?: unknown;
  reviewer?: unknown;
  sourceEventId?: unknown;
  tags?: unknown;
  enabled?: unknown;
}

/** 校验通过后的规范化条目（可直接落库）。 */
export interface ValidatedExpertEntry {
  domain: ResearchTaskKind;
  kind: ExpertEntryKind;
  title: string;
  applicability: string;
  content: string;
  criteria: string;
  provenance: ExpertProvenance;
  reviewer: string | null;
  sourceEventId: number | null;
  tags: string;
  enabled: boolean;
}

export type ValidateResult =
  | { ok: true; value: ValidatedExpertEntry }
  | { ok: false; errors: string[] };

function nonemptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * 单点校验。`opts.skipReviewer`：草稿落 drafts 表时 reviewer 尚未产生
 * （人审时才填），草稿通道用它跳过 reviewer 条件必填；其余规则不变。
 * 返回全部错误项（不遇错即停），供编辑器往返通道一次列全。
 */
export function validateEntry(input: ExpertEntryInput, opts?: { skipReviewer?: boolean }): ValidateResult {
  const errors: string[] = [];

  let domain: ResearchTaskKind | null = null;
  if (typeof input.domain !== 'string' || !isResearchTaskKind(input.domain)) {
    errors.push(`domain 非法（允许：${RESEARCH_TASK_KINDS.join(' / ')}）`);
  } else {
    domain = input.domain;
  }

  let kind: ExpertEntryKind | null = null;
  if (typeof input.kind !== 'string' || !isExpertEntryKind(input.kind)) {
    errors.push(`kind 非法（允许：${EXPERT_ENTRY_KINDS.join(' / ')}）`);
  } else {
    kind = input.kind;
  }

  const title = nonemptyString(input.title);
  if (title === null) errors.push('title 必填且非空');
  const applicability = nonemptyString(input.applicability);
  if (applicability === null) errors.push('applicability 必填且非空');
  const content = nonemptyString(input.content);
  if (content === null) errors.push('content 必填且非空');
  const criteria = nonemptyString(input.criteria);
  if (criteria === null) errors.push('criteria 必填且非空');

  let provenance: ExpertProvenance | null = null;
  if (typeof input.provenance !== 'string' || !isExpertProvenance(input.provenance)) {
    errors.push(`provenance 非法（允许：${EXPERT_PROVENANCES.join(' / ')}）`);
  } else {
    provenance = input.provenance;
  }

  let reviewer: string | null = null;
  if (input.reviewer !== undefined && input.reviewer !== null) {
    const r = nonemptyString(input.reviewer);
    if (r === null) {
      errors.push('reviewer 提供时必须是非空字符串');
    } else {
      reviewer = r;
    }
  }
  // reviewer 条件必填：provenance≠builtin 时权威性的来源就是审定人。
  if (provenance !== null && provenance !== 'builtin' && reviewer === null && !opts?.skipReviewer) {
    errors.push('provenance≠builtin 时 reviewer 必填非空（权威性的来源是人审）');
  }

  let sourceEventId: number | null = null;
  if (input.sourceEventId !== undefined && input.sourceEventId !== null) {
    const n = input.sourceEventId;
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
      errors.push('sourceEventId 提供时必须是正整数（research_events.id）');
    } else {
      sourceEventId = n;
    }
  }

  let tags = '';
  if (input.tags !== undefined && input.tags !== null) {
    if (typeof input.tags !== 'string') {
      errors.push('tags 必须是字符串（逗号分隔）');
    } else {
      tags = input.tags.trim();
    }
  }

  let enabled = true;
  if (input.enabled !== undefined && input.enabled !== null) {
    if (typeof input.enabled !== 'boolean') {
      errors.push('enabled 必须是布尔值');
    } else {
      enabled = input.enabled;
    }
  }

  if (errors.length > 0 || domain === null || kind === null || title === null
    || applicability === null || content === null || criteria === null || provenance === null) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      domain, kind, title, applicability, content, criteria,
      provenance, reviewer, sourceEventId, tags, enabled,
    },
  };
}

/**
 * 内容指纹：幂等导入 / 去重 / 变更检测的单一口径。只覆盖内容字段
 * （不含 provenance/reviewer/enabled——审定元数据变了不算内容变了）。
 */
export function computeContentHash(value: ValidatedExpertEntry): string {
  const canonical = JSON.stringify([
    value.domain, value.kind, value.title, value.applicability,
    value.content, value.criteria, value.tags,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
