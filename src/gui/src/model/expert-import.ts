/**
 * 专家知识导入的文本解析（1.3.1 ⑥，纯函数）。
 *
 * 服务端无批量导入端点（CLI 1.2.10 的导入通道是「解析 JSON/YAML 后
 * 逐条 expert/add」）——GUI 复用同一语义：本模块把粘贴的 JSON/YAML
 * 解析成条目数组，store 逐条调 expert/add（单条失败不中断整体，见
 * store.submitExpertImport）。
 *
 * 必填字段（server/admin-api.ts validateEntry）：domain / kind / title /
 * applicability / content / criteria / reviewer。
 */

import { load as yamlLoad } from 'js-yaml';

export type ExpertImportParse =
  | { ok: true; entries: Record<string, unknown>[] }
  | { ok: false; error: string };

const REQUIRED_FIELDS = ['title', 'kind', 'domain', 'content', 'criteria', 'reviewer'] as const;
const EXPERT_KINDS = ['idea', 'technique', 'sop'];

function isPlainEntry(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 单条最小校验（与 validateEntry 的必填子集对齐；细粒度错误交服务端）。 */
export function validateImportEntry(entry: Record<string, unknown>): string | null {
  for (const f of REQUIRED_FIELDS) {
    if (typeof entry[f] !== 'string' || !(entry[f] as string).trim()) {
      return `缺必填字段 ${f}`;
    }
  }
  if (!EXPERT_KINDS.includes(String(entry.kind))) {
    return `kind 非法：${String(entry.kind)}（允许 ${EXPERT_KINDS.join('/')}）`;
  }
  return null;
}

function normalizeUnknown(v: unknown): Record<string, unknown>[] {
  if (isPlainEntry(v)) return [v];
  if (Array.isArray(v)) {
    return v.filter(isPlainEntry);
  }
  return [];
}

/**
 * 粘贴文本 → 条目数组。JSON 优先，失败回落 YAML；都解析失败返回 error。
 * 空数组也算失败（没有可导入内容）。
 */
export function parseExpertImport(raw: string): ExpertImportParse {
  const text = raw.trim();
  if (!text) return { ok: false, error: '内容为空' };
  let entries: Record<string, unknown>[] = [];
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = yamlLoad(text);
    } catch {
      return { ok: false, error: '既不是合法 JSON 也不是 YAML' };
    }
  }
  entries = normalizeUnknown(parsed);
  if (entries.length === 0) {
    return { ok: false, error: '未解析出条目（需要单条对象或对象数组）' };
  }
  for (let i = 0; i < entries.length; i++) {
    const err = validateImportEntry(entries[i]);
    if (err) return { ok: false, error: `第 ${i + 1} 条：${err}` };
  }
  return { ok: true, entries };
}
