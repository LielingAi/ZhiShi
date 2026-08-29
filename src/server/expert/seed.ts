/**
 * 内置专家知识播种（1.2.1 骨架期）——bundled-expert/<domain>/<slug>.md
 * 随包分发，sidecar 启动（deferred init，挂在环境配方 seed 之后）按
 * content_hash 幂等导入/更新 expert.db。
 *
 * 文件是发行载体不是存储——DB 是唯一事实源。纪律：
 * - provenance=builtin 强制写入（包内条目更新 = 覆盖库内同来源条目）；
 * - user/promoted 条目绝不动（seed 只碰 meta 里登记为 builtin 映射的条目 id）；
 * - 单个文件非法不阻塞：记进 errors，继续其余文件。
 *
 * 幂等键：meta 表 seed:<domain>/<slug> → { entryId, contentHash }——条目
 * 身份跟文件走而不是跟 title 走，包内条目改标题也能正确覆盖。
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { load as yamlLoad } from 'js-yaml';

import { extractFrontmatter } from '../../shared/slashCommands';
import { resolveBundledDir } from '../domains/manifest';
import { getZhiShiDataDir } from '../utils/app-dirs';
import { computeContentHash, validateEntry, type ExpertEntryInput } from './validate';
import {
  getEntryById,
  getExpertMeta,
  insertEntry,
  openExpertStore,
  setExpertMeta,
  updateEntry,
  type ExpertDb,
} from './store';

export interface ParsedExpertFile {
  /** frontmatter 原始字段（domain 来自目录名，不在文件里）。 */
  frontmatter: Record<string, unknown>;
  /** markdown 正文（条目的 content）。 */
  body: string;
}

/**
 * 解析 bundled-expert 条目文件（frontmatter + markdown 正文，SKILL.md 同款
 * 惯例）。无 frontmatter / YAML 非法 → throw（由 seed 收集进 errors）。
 */
export function parseExpertEntryMarkdown(raw: string): ParsedExpertFile {
  const extracted = extractFrontmatter(raw);
  if (!extracted) throw new Error('缺少 frontmatter（--- 包裹的 YAML 头）');
  let parsed: unknown;
  try {
    parsed = yamlLoad(extracted.frontmatterStr);
  } catch (err) {
    throw new Error(`frontmatter YAML 非法：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('frontmatter 必须是 YAML 对象');
  }
  return { frontmatter: parsed as Record<string, unknown>, body: extracted.body.trim() };
}

export interface SeedExpertResult {
  inserted: number;
  updated: number;
  unchanged: number;
  /** 逐文件的解析/校验错误（不阻塞其余文件）。 */
  errors: string[];
}

interface SeedMetaValue {
  entryId: number;
  contentHash: string;
}

function seedOneFile(db: ExpertDb, domain: string, slug: string, raw: string, now: number): 'inserted' | 'updated' | 'unchanged' {
  const { frontmatter, body } = parseExpertEntryMarkdown(raw);
  const input: ExpertEntryInput = {
    domain,
    kind: frontmatter.kind,
    title: frontmatter.title,
    applicability: frontmatter.applicability,
    content: body,
    criteria: frontmatter.criteria,
    // 内置条目 provenance 强制 builtin，文件里写了也不算（通道写入，不接受输入）。
    provenance: 'builtin',
    reviewer: frontmatter.reviewer,
    tags: frontmatter.tags,
  };
  const result = validateEntry(input);
  if (!result.ok) throw new Error(result.errors.join('；'));
  const contentHash = computeContentHash(result.value);

  const metaKey = `seed:${domain}/${slug}`;
  const existingRaw = getExpertMeta(db, metaKey);
  if (existingRaw) {
    let existing: SeedMetaValue | null = null;
    try {
      existing = JSON.parse(existingRaw) as SeedMetaValue;
    } catch {
      existing = null; // meta 损坏 → 按未播种处理（下面重插）
    }
    if (existing && existing.contentHash === contentHash && getEntryById(db, existing.entryId)) {
      return 'unchanged';
    }
    if (existing && getEntryById(db, existing.entryId)) {
      // 内容变了 → 强制覆盖内容字段（保留 enabled：用户主动停用是用户意图，
      // 内容更新不替他改回来）。
      const { enabled: _enabled, ...contentFields } = result.value;
      updateEntry(db, existing.entryId, { ...contentFields, contentHash }, now);
      setExpertMeta(db, metaKey, JSON.stringify({ entryId: existing.entryId, contentHash } satisfies SeedMetaValue));
      return 'updated';
    }
  }
  const entry = insertEntry(db, result.value, contentHash, now);
  setExpertMeta(db, metaKey, JSON.stringify({ entryId: entry.id, contentHash } satisfies SeedMetaValue));
  return 'inserted';
}

export interface SeedBundledExpertOptions {
  /** 数据目录（缺省 getZhiShiDataDir()）。测试注入临时目录。 */
  baseDir?: string;
  /** bundled-expert 目录（缺省 resolveBundledDir('bundled-expert')）。 */
  bundledDir?: string | null;
  now?: number;
}

/**
 * 幂等导入 bundled-expert。目录不存在（未随包分发/裁剪环境）→ 全零结果，
 * 不建库不报错。
 */
export function seedBundledExpert(opts: SeedBundledExpertOptions = {}): SeedExpertResult {
  const result: SeedExpertResult = { inserted: 0, updated: 0, unchanged: 0, errors: [] };
  const bundledDir = opts.bundledDir === undefined ? resolveBundledDir('bundled-expert') : opts.bundledDir;
  if (!bundledDir) return result;

  const now = opts.now ?? Date.now();
  const db = openExpertStore(opts.baseDir ?? getZhiShiDataDir());
  for (const domainEntry of readdirSync(bundledDir, { withFileTypes: true })) {
    if (!domainEntry.isDirectory()) continue;
    const domainDir = join(bundledDir, domainEntry.name);
    for (const file of readdirSync(domainDir)) {
      if (!file.endsWith('.md')) continue;
      const slug = file.replace(/\.md$/, '');
      const label = `${domainEntry.name}/${slug}`;
      try {
        const raw = readFileSync(join(domainDir, file), 'utf-8');
        const outcome = seedOneFile(db, domainEntry.name, slug, raw, now);
        result[outcome] += 1;
      } catch (err) {
        result.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return result;
}
