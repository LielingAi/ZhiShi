/**
 * 专家知识层（1.2.10）—— `zhishi expert import <file>` 批量导入的解析与执行。
 *
 * 文件格式：JSON 或 YAML（扩展名优先、内容嗅探兜底），单对象或对象数组；
 * 字段同 expert/add 契约（title/kind/domain/applicability/content/criteria
 * 必填，tags/reviewer 可选）。通道纪律同编辑器往返：
 * - provenance 强制 user（builtin 服务端拒收；promoted 只能走 promote 通道）；
 * - reviewer 取条目字段、--reviewer 兜底，两者皆无 → 该条报错跳过
 *   （权威性的来源是人审这个动作）；
 * - 逐条校验逐条入库：单条非法不阻塞其余条目（seed 管线同款先例）。
 *
 * 纪律：解析是纯函数无 IO；执行侧注入 poster（= zhishi.ts 的 callApi），
 * 单测不起 HTTP。服务端零改动——复用 expert/add 路由。
 */
import { extname } from 'node:path';

import { load as yamlLoad } from 'js-yaml';

import { validateEntry, type ValidatedExpertEntry } from '../shared/expert-validate';

// ---------------------------------------------------------------------------
// 解析（纯函数）
// ---------------------------------------------------------------------------

/** 导入条目原始形态（解析后的 JSON/YAML 值，类型未知，交给 validateEntry 判）。 */
export type RawImportEntry = unknown;

export type ImportParseResult =
  | { ok: true; entries: RawImportEntry[] }
  | { ok: false; error: string };

/**
 * 解析导入文件：扩展名优先（.json / .yaml / .yml），无扩展名时内容嗅探
 * （先试 JSON，失败按 YAML 解析——YAML 是 JSON 超集，顺序不能反）。单对象
 * 归一为单元素数组；数组为空 / 顶层是标量 → 报错（调用方整体失败）。
 */
export function parseExpertImport(raw: string, fileName = ''): ImportParseResult {
  const ext = extname(fileName).toLowerCase();
  let parsed: unknown;
  if (ext === '.json') {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` };
    }
  } else if (ext === '.yaml' || ext === '.yml') {
    try {
      parsed = yamlLoad(raw);
    } catch (err) {
      return { ok: false, error: `YAML 解析失败：${err instanceof Error ? err.message : String(err)}` };
    }
  } else {
    try {
      parsed = JSON.parse(raw);
    } catch {
      try {
        parsed = yamlLoad(raw);
      } catch (err) {
        return { ok: false, error: `无法识别格式（既非 JSON 也非 YAML）：${err instanceof Error ? err.message : String(err)}` };
      }
    }
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.length === 0) return { ok: false, error: '文件中没有条目（空数组）' };
  return { ok: true, entries };
}

/**
 * 单条归一 + 校验：provenance 强制 user；reviewer 条目字段优先、
 * fallbackReviewer（--reviewer）兜底，皆无 → 报错跳过（不发 API）。
 */
export function validateImportEntry(
  entry: RawImportEntry,
  fallbackReviewer?: string,
): { ok: true; value: ValidatedExpertEntry } | { ok: false; error: string } {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, error: '条目必须是对象（字段：title/kind/domain/applicability/content/criteria，可选 tags/reviewer）' };
  }
  const fields = entry as Record<string, unknown>;
  const own = typeof fields.reviewer === 'string' && fields.reviewer.trim() ? fields.reviewer.trim() : undefined;
  const reviewer = own ?? fallbackReviewer;
  if (!reviewer) {
    return { ok: false, error: '缺 reviewer（条目字段与 --reviewer 均未提供——权威性的来源是人审）' };
  }
  const v = validateEntry({ ...fields, provenance: 'user', reviewer });
  if (!v.ok) return { ok: false, error: v.errors.join('；') };
  return { ok: true, value: v.value };
}

// ---------------------------------------------------------------------------
// 执行（注入 poster）
// ---------------------------------------------------------------------------

/** admin API 调用形态（= zhishi.ts 的 callApi；注入以便单测不起 HTTP）。 */
export type ImportPoster = (route: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface ImportOkItem {
  /** 1 起始序号（= 文件中第几条，汇总输出直接用）。 */
  index: number;
  title: string;
  /** 服务端返回的入库 id（响应形态异常时缺省）。 */
  id?: number;
}

export interface ImportFailedItem {
  index: number;
  title: string;
  error: string;
}

export interface ExpertImportResult {
  ok: ImportOkItem[];
  failed: ImportFailedItem[];
}

/** 提取条目标题（汇总输出用；缺标题时给占位）。 */
function entryTitle(entry: RawImportEntry): string {
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const t = (entry as Record<string, unknown>).title;
    if (typeof t === 'string' && t.trim()) return t.trim();
  }
  return `（无标题）`;
}

/**
 * 逐条校验 + 逐条入库：单条失败（校验不过 / 服务端拒绝）记进 failed 继续，
 * 不阻塞其余条目。请求体与 `expert new` 同款（不带 provenance——服务端
 * add 缺省 user）。
 */
export async function importExpertEntries(
  entries: RawImportEntry[],
  opts: { reviewer?: string; post: ImportPoster },
): Promise<ExpertImportResult> {
  const result: ExpertImportResult = { ok: [], failed: [] };
  for (let i = 0; i < entries.length; i++) {
    const index = i + 1;
    const title = entryTitle(entries[i]);
    const v = validateImportEntry(entries[i], opts.reviewer);
    if (!v.ok) {
      result.failed.push({ index, title, error: v.error });
      continue;
    }
    const res = await opts.post('expert/add', {
      domain: v.value.domain,
      kind: v.value.kind,
      title: v.value.title,
      applicability: v.value.applicability,
      content: v.value.content,
      criteria: v.value.criteria,
      reviewer: v.value.reviewer,
      tags: v.value.tags,
    });
    if (res.success !== true) {
      result.failed.push({ index, title, error: String(res.error ?? 'unknown error') });
      continue;
    }
    const entry = ((res.data as Record<string, unknown> | undefined)?.entry ?? {}) as Record<string, unknown>;
    const id = typeof entry.id === 'number' ? entry.id : undefined;
    result.ok.push(id !== undefined ? { index, title, id } : { index, title });
  }
  return result;
}
