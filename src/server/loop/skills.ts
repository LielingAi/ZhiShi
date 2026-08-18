/**
 * Skills 装载（提示词级能力包）— harness 的扩展面，v1 只做 skills。
 *
 * 模型:
 *   - 两个来源合并:bundled-skills(随产品发行,含安全方法四件:
 *     native-code-loop / binary-exploit / vuln-triage / range-ops)+ 用户库
 *     ~/.zhishi/skills(seed/自装)。同名用户库覆盖 bundled(用户优先)。
 *   - 禁用表 ~/.zhishi/skills-config.json 的 disabled 数组按文件夹名
 *     过滤两个来源(zhishi skill disable 对 bundled 同样生效)。
 *   - 平台屏蔽(isSkillBlockedOnPlatform)与 skill/list 同口径。
 *
 * 注入语义:SKILL.md 全文进系统提示——这是结构性必然,不是偷懒:
 * 研究环境边界(D14)下模型读不到宿主文件,「按名索引、按需再读」的
 * 惰性模式在本产品不成立,能力包必须随提示词直给。为防止失控,
 * 单个 skill 截断 4000 字符,总量封顶 12000,超出按序丢弃。
 *
 * 零注入:无启用 skill 时整段不出现。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { parseSkillFrontmatter, extractFrontmatter } from '../../shared/slashCommands';
import { getZhiShiDataDir } from '../utils/app-dirs';
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
export const SKILLS_TOTAL_CAP = 12000;

export interface CollectSkillsOptions {
  /** 测试注入:用户库目录(缺省 ~/.zhishi/skills)。 */
  userSkillsDir?: string;
  /** 测试注入:bundled 目录(缺省 resolveBundledSkillsDir())。 */
  bundledDir?: string | null;
  /** 测试注入:数据目录(禁用表所在,缺省 ~/.zhishi)。 */
  dataDir?: string;
}

/**
 * bundled-skills 目录解析(与 index.ts 的 resolveBundledSkillsDir 同策略,
 * 独立一份以避免从服务器入口反向依赖):脚本同级(prod)→ 向上 5 层(dev)。
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

function readDisabledSkills(dataDir: string): Set<string> {
  try {
    const configPath = join(dataDir, 'skills-config.json');
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (Array.isArray(raw?.disabled)) return new Set(raw.disabled as string[]);
    }
  } catch {
    /* 禁用表读不动 = 无禁用(读侧容错,与 skill/list 同) */
  }
  return new Set();
}

function scanSkillsDir(dir: string | null, source: SkillPack['source']): Map<string, SkillPack> {
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
      body: body.length > SKILL_BODY_CAP ? `${body.slice(0, SKILL_BODY_CAP)}\n…(截断)` : body,
      source,
    });
  }
  return out;
}

/** 合并收集启用的 skills(bundled 先,用户库覆盖同名;禁用表过滤)。 */
export function collectEnabledSkills(options: CollectSkillsOptions = {}): SkillPack[] {
  const dataDir = options.dataDir ?? getZhiShiDataDir();
  const disabled = readDisabledSkills(dataDir);
  const bundledDir = options.bundledDir === undefined ? resolveBundledSkillsDir() : options.bundledDir;
  const userDir = options.userSkillsDir ?? join(dataDir, 'skills');

  const merged = scanSkillsDir(bundledDir, 'bundled');
  for (const [id, pack] of scanSkillsDir(userDir, 'user')) {
    merged.set(id, pack); // 用户库覆盖同名 bundled
  }
  return [...merged.values()].filter((p) => !disabled.has(p.id));
}

/**
 * 渲染系统提示的 skills 段。零注入语义:空数组 → ''。总量封顶
 * SKILLS_TOTAL_CAP,按序(安全四件与用户库按文件夹名序)取舍。
 */
export function buildSkillsSection(skills: SkillPack[] | undefined): string {
  if (!skills || skills.length === 0) return '';
  const lines: string[] = [
    '<skills>',
    '以下能力包已启用,其内容即操作指南——涉及环境内动作时经 env_exec 落实,研究留痕用 research_log。',
    '',
  ];
  let total = 0;
  let included = 0;
  for (const s of skills) {
    const chunk = `## ${s.name}${s.description ? ` — ${s.description}` : ''}\n\n${s.body}\n`;
    if (total + chunk.length > SKILLS_TOTAL_CAP) break;
    lines.push(chunk);
    total += chunk.length;
    included++;
  }
  if (included < skills.length) {
    lines.push(`(另有 ${skills.length - included} 个已启用 skill 因总量上限未注入——用 zhishi skill list 查看,可 disable 腾位)`);
  }
  lines.push('</skills>');
  return lines.join('\n');
}
