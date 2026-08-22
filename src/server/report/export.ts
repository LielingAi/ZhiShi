/**
 * 1.2.0 — 报告导出编排（exportReport）。
 *
 * 状态机（admin handler 的组织顺序即此）：
 *
 *   组装（骨架）
 *     → 敏感扫描（骨架全文）
 *     → 一次边界批准（落点 + N 个证据文件 + 敏感项计数，全列清）
 *     → 证据回收（已批准前提下的批量 scp；失败/docker/不可达 → 降级标注）
 *     → LLM 填肉（一次性 loop；不可用/失败 → 整份退化为纯骨架）
 *     → 落盘（report.md + meta.json）
 *
 * 任一前置失败（无记录/无历史/批准拒绝）→ 直接 error 返回，不落盘。
 * 回收与填肉的失败是「降级」不是「失败」——报告必须出得来。
 *
 * 纯编排 + 注入：所有 IO（事件查询/transcript/批准/回收/填肉/写盘）都是
 * deps，单测全假；真实接线在 admin-api.ts::handleReportExport。
 */

import { join } from 'node:path';

import type { EnvironmentEntry } from '../../shared/config-types';
import type { EnvExec } from '../loop/env-exec';
import type { LoopTranscript } from '../loop/transcript';
import type { ResearchEvent } from '../memory/store';
import { recoverEvidenceBatch } from './evidence';
import { buildNarrationPrompt, NARRATION_SYSTEM_PROMPT, parseNarratedSections } from './narrate';
import { formatSensitiveSummary, sanitizeSensitiveText, scanSensitiveHits } from './sensitive';
import {
  buildReportSkeleton,
  formatReportTimestamp,
  renderReportMarkdown,
  truncateSkeleton,
  withEvidenceResults,
} from './skeleton';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReportEnvContext {
  /** 目录名/meta 用的环境标识（无锚定 → 'host'）。 */
  envId: string;
  /** 当前锚定的环境条目（证据回收目标；null → 回收整批降级）。 */
  entry: EnvironmentEntry | null;
}

export interface NarrationOutcome {
  text?: string;
  error?: string;
}

export interface ExportReportDeps {
  /** workspace 的研究事件（调用方负责按 workspace 过滤；任意序）。 */
  listWorkspaceEvents(workspace: string): ResearchEvent[];
  /** 当前环境线的 loopSessionId（env-sessions 映射；无映射 → undefined）。 */
  findLoopSessionId(workspace: string): string | undefined;
  loadTranscript(loopSessionId: string): LoopTranscript | null;
  /** 一次边界批准（host-write）；objects 已列全，拒绝/超时 → false。 */
  requestApproval(objects: string[]): Promise<boolean>;
  /** 一次性叙述 loop（无工具、独立 session）；不可用/失败 → { error }。 */
  narrate(prompt: string, systemPrompt: string): Promise<NarrationOutcome>;
  /** meta.json 的模型标识（如 'provider/model'；无可用模型 → null）。 */
  modelId: string | null;
  /** 落盘（report.md / meta.json；目录由实现侧 mkdir -p）。 */
  writeOutputs(reportDir: string, files: Record<string, string>): void;
  /** 证据回收 exec 注入（测试）；缺省 defaultEnvExec。 */
  exec?: EnvExec;
  /** 时钟注入（测试钉目录名与生成时间）。 */
  now?: () => number;
  /**
   * 专家条目查证（1.2.2 引用追踪）：事件 expert_refs → title/kind。
   * 缺省/查不到 → 引用节按「条目已删除或不可考」渲染，不阻塞导出。
   */
  lookupExpertEntry?: (id: number) => { title: string; kind: string } | null;
}

export interface ExportReportInput {
  workspace: string;
  sanitize?: boolean;
  env: ReportEnvContext;
}

export interface ExportReportData {
  reportDir: string;
  /** 成功回收到 evidence/ 的文件数（去重后）。 */
  evidenceCount: number;
  /** 降级标注（回收失败/docker/不可达/未润色……），同步进 meta.json。 */
  degraded: string[];
  sanitized: boolean;
}

export type ExportReportResult =
  | { success: true; data: ExportReportData }
  | { success: false; error: string };

const NO_RECORDS_ERROR = '没有可导出的研究记录（当前工作区无研究事件或无会话历史）';

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function exportReport(
  input: ExportReportInput,
  deps: ExportReportDeps,
): Promise<ExportReportResult> {
  const now = deps.now ?? Date.now;
  const sanitize = input.sanitize === true;

  // ---- 1. 组装 ---------------------------------------------------------
  const events = deps.listWorkspaceEvents(input.workspace);
  if (events.length === 0) return { success: false, error: NO_RECORDS_ERROR };

  const loopSessionId = deps.findLoopSessionId(input.workspace);
  const transcript = loopSessionId ? deps.loadTranscript(loopSessionId) : null;
  if (!transcript || transcript.entries.length === 0) {
    return { success: false, error: NO_RECORDS_ERROR };
  }

  let skeleton = buildReportSkeleton({
    workspace: input.workspace,
    envId: input.env.envId,
    events,
    transcript,
    now: now(),
    ...(deps.lookupExpertEntry ? { lookupExpertEntry: deps.lookupExpertEntry } : {}),
  });
  skeleton = truncateSkeleton(skeleton);

  const reportDir = join(
    input.workspace,
    'output',
    'reports',
    `${formatReportTimestamp(skeleton.generatedAt)}-${input.env.envId}`,
  );
  const evidenceDir = join(reportDir, 'evidence');

  // ---- 2. 敏感扫描（骨架全文）------------------------------------------
  const baselineMarkdown = renderReportMarkdown(skeleton);
  const hits = scanSensitiveHits(baselineMarkdown);

  // ---- 3. 一次边界批准（落点 + 全部证据文件 + 敏感项计数）--------------
  const objects: string[] = [
    `报告落点：${reportDir}`,
    ...(skeleton.evidenceRefs.length === 0
      ? ['证据回收：无（无 trajectory_ref 登记）']
      : [
          `证据回收：${skeleton.evidenceRefs.length} 个文件 → ${evidenceDir}`,
          ...skeleton.evidenceRefs.map((ref) => `  #${ref.eventId} ${ref.guestPath}`),
        ]),
    `敏感项命中：${formatSensitiveSummary(hits)}`,
  ];
  const approved = await deps.requestApproval(objects);
  if (!approved) {
    return { success: false, error: '导出已被拒绝或超时（写宿主需人批准）' };
  }

  const degraded: string[] = [];

  // ---- 4. 证据回收（已批准前提；失败一律降级不炸）-----------------------
  let evidenceCount = 0;
  if (skeleton.evidenceRefs.length > 0) {
    const results = await recoverEvidenceBatch(input.env.entry, skeleton.evidenceRefs, evidenceDir, deps.exec);
    skeleton = withEvidenceResults(skeleton, results);
    evidenceCount = new Set(
      results.filter((r) => r.status === 'recovered').map((r) => r.guestPath),
    ).size;
    for (const r of results) {
      if (r.status === 'degraded') degraded.push(`证据 #${r.eventId} ${r.guestPath}：${r.note}`);
    }
  }

  // ---- 5. LLM 填肉（失败 → 纯骨架 + 未经润色标注）-----------------------
  let narration: Map<string, string> | undefined;
  const headerNotes: string[] = [];
  if (!deps.modelId) {
    degraded.push('模型不可用——报告未经叙述润色（纯事实骨架）');
  } else {
    const outcome = await deps.narrate(buildNarrationPrompt(skeleton), NARRATION_SYSTEM_PROMPT);
    if (outcome.error !== undefined || outcome.text === undefined) {
      degraded.push(`叙述润色失败（${outcome.error ?? '无文本产出'}）——报告未经叙述润色（纯事实骨架）`);
    } else {
      narration = parseNarratedSections(outcome.text, skeleton);
    }
  }
  const unpolished = degraded.find((d) => d.includes('未经叙述润色'));
  if (unpolished) headerNotes.push(unpolished);
  if (skeleton.truncated) headerNotes.push('骨架超预算已截断：事件层完整保留，transcript 原始摘录从尾部裁减');

  // ---- 6. 落盘 ----------------------------------------------------------
  let markdown = renderReportMarkdown(skeleton, {
    ...(narration ? { narration } : {}),
    headerNotes,
  });
  if (sanitize) {
    markdown = sanitizeSensitiveText(markdown).text;
  }

  const meta = {
    generatedAt: new Date(skeleton.generatedAt).toISOString(),
    workspace: input.workspace,
    envId: input.env.envId,
    model: deps.modelId,
    eventIds: skeleton.eventIds,
    ...(skeleton.expertRefs.length > 0
      ? {
          expertRefs: skeleton.expertRefs.map((c) => ({
            entryId: c.entryId,
            ...(c.title !== undefined ? { title: c.title } : {}),
            ...(c.kind !== undefined ? { kind: c.kind } : {}),
            eventIds: c.eventIds,
          })),
        }
      : {}),
    degraded,
    truncated: skeleton.truncated,
    sanitized: sanitize,
    evidence: {
      recovered: evidenceCount,
      degraded: skeleton.evidenceRefs.length - (skeleton.evidenceResults ?? []).filter((r) => r.status === 'recovered').length,
      ...(sanitize && evidenceCount > 0 ? { note: 'evidence 文件本体未脱敏（脱敏只作用于 report.md 文本）' } : {}),
    },
  };

  deps.writeOutputs(reportDir, {
    'report.md': markdown,
    'meta.json': `${JSON.stringify(meta, null, 2)}\n`,
  });

  return { success: true, data: { reportDir, evidenceCount, degraded, sanitized: sanitize } };
}
