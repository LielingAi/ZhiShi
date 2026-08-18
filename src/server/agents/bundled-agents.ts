/**
 * bundled-agents 装载——delegate_task 的子代理 prompt 定义源。
 *
 * 形态:bundled-agents/<name>/<name>.md(frontmatter: name/description/skills
 * + 正文 = 子 loop 的系统提示)。主 loop 的模型经 delegate_task 的 agent
 * 参数点名,引擎把对应正文作为子 loop 的 systemPrompt 注入——子代理定义
 * 是引擎装载的,不靠模型读宿主文件(边界下读不到)。
 *
 * skills 字段是声明(子 loop 当前不挂 skill 注入——v1 提示正文自包含;
 * 字段保留供 domain check 与未来挂载用)。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { extractFrontmatter } from '../../shared/slashCommands';
import { resolveBundledDir } from '../domains/manifest';

export interface BundledAgent {
  name: string;
  description: string;
  /** 正文(去 frontmatter)= 子 loop 系统提示。 */
  body: string;
}

export interface LoadedAgent extends BundledAgent {
  skills: string[];
}

function loadOne(dir: string, name: string): LoadedAgent | null {
  const file = join(dir, name, `${name}.md`);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf-8');
    const extracted = extractFrontmatter(raw);
    const fm = extracted?.frontmatterStr ?? '';
    const nameHit = /^name:\s*(.+)$/m.exec(fm);
    const descHit = /^description:\s*(.+)$/m.exec(fm);
    const skillsHit = /^skills:\s*$/m.exec(fm);
    let skills: string[] = [];
    if (skillsHit) {
      const after = fm.slice(skillsHit.index! + skillsHit[0].length);
      const listEnd = after.indexOf('\n\n');
      const list = (listEnd >= 0 ? after.slice(0, listEnd) : after).split('\n');
      skills = list.map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
    }
    const body = (extracted?.body ?? raw).trim();
    if (!body) return null;
    return {
      name: nameHit?.[1].trim() || name,
      description: descHit?.[1].trim() || '',
      skills,
      body,
    };
  } catch {
    return null;
  }
}

/** 列出全部 bundled-agents(容错:坏定义跳过)。 */
export function loadBundledAgents(root?: string | null): LoadedAgent[] {
  const dir = root === undefined ? resolveBundledDir('bundled-agents') : root;
  if (!dir || !existsSync(dir)) return [];
  const out: LoadedAgent[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  for (const name of names) {
    const a = loadOne(dir, name);
    if (a) out.push(a);
  }
  return out;
}

/** 按名取单个;不存在 → null。 */
export function loadBundledAgent(name: string, root?: string | null): LoadedAgent | null {
  const dir = root === undefined ? resolveBundledDir('bundled-agents') : root;
  if (!dir) return null;
  return loadOne(dir, name);
}
