/**
 * Skills 目录扫描器（1.5.1 注入面瘦身后的裁留件）。
 *
 * 1.5.1 起提示词注入层（collectEnabledSkills / buildSkillsSection /
 * filterSkillsByDomain 及总量封顶）整体删除——SKILL.md 不再进系统提示。
 * 本模块只保留「什么是一个合法 skill 目录」的扫描口径：
 *   - resolveBundledSkillsDir:bundled-skills 目录解析（domain check 的
 *     引用完整性校验在用——domain.json 的 skills 清单要对得上目录）。
 *   - scanSkillsDir:目录 → SkillPack 的扫描（SKILL.md 存在 + frontmatter
 *     解析 + 平台屏蔽），与 agent-session 的 .claude/skills 软链同步
 *     （syncProjectUserConfig，外部 runtime 兼容面）同一定义。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { parseSkillFrontmatter, extractFrontmatter } from '../../shared/slashCommands';
import { isSkillBlockedOnPlatform } from '../utils/platform';
import { getScriptDir } from '../utils/runtime';

export interface SkillPack {
  /** 文件夹名(禁用表的键)。 */
  id: string;
  name: string;
  description: string;
  /** 去 frontmatter 的正文(已截断)。 */
  body: string;
  source: 'bundled' | 'user';
}

export const SKILL_BODY_CAP = 4000;

/** 单篇正文截断:取整行边界(硬切可能断在半句);无换行可退硬切。 */
export function truncateSkillBody(body: string, cap: number = SKILL_BODY_CAP): string {
  if (body.length <= cap) return body;
  const sliced = body.slice(0, cap);
  const lastNewline = sliced.lastIndexOf('\n');
  const cut = lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced;
  return `${cut}\n…(截断)`;
}

/**
 * bundled-skills 目录解析:脚本同级(prod)→ 向上 5 层(dev)。
 * domain check(admin-api)用它定位 bundled-skills 做引用完整性校验。
 */
export function resolveBundledSkillsDir(fromDir?: string): string | null {
  const scriptDir = fromDir ?? getScriptDir();
  const prodPath = resolve(scriptDir, 'bundled-skills');
  if (existsSync(prodPath)) return prodPath;
  let dir = scriptDir;
  for (let i = 0; i < 5; i++) {
    const devPath = resolve(dir, 'bundled-skills');
    if (existsSync(devPath)) return devPath;
    dir = dirname(dir);
  }
  return null;
}

/** 扫描 skills 目录:有 SKILL.md 且正文非空的子目录才算合法 skill(平台屏蔽除外)。 */
export function scanSkillsDir(dir: string | null, source: SkillPack['source']): Map<string, SkillPack> {
  const out = new Map<string, SkillPack>();
  if (!dir || !existsSync(dir)) return out;
  for (const folder of readdirSync(dir, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    if (isSkillBlockedOnPlatform(folder.name)) continue;
    const skillMd = join(dir, folder.name, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    let content: string;
    try {
      content = readFileSync(skillMd, 'utf-8');
    } catch {
      continue;
    }
    const meta = parseSkillFrontmatter(content);
    const extracted = extractFrontmatter(content);
    const body = (extracted?.body ?? content).trim();
    if (!body) continue;
    out.set(folder.name, {
      id: folder.name,
      name: meta.name ?? folder.name,
      description: meta.description ?? '',
      body: truncateSkillBody(body),
      source,
    });
  }
  return out;
}
