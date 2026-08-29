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
import { loadDomainManifests, type DomainManifest } from '../../shared/domain-manifest';
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

/** 域清单的进程内缓存(bundled-domains 只在升级时变,会话期不变)。 */
let domainManifestsCache: DomainManifest[] | null = null;

/**
 * 按会话域过滤可派发子代理(1.2.7 域边界,纯函数):子代理由主 agent 在
 * 任务中段派生,任务域在派生时刻已定——子代理继承主 agent 的会话域,不
 * 从全域清单按名自选。域命中 domain.json 的 subagents 清单 → 只保留该域
 * 子代理 ∪ 无域归属的通用子代理(不在任何域清单里的名字视为通用保留);
 * 清单名在 bundled-agents 目录不存在 → 自然跳过(容错)。无 domain / 域未
 * 被清单覆盖 → 原样返回(全量,宁多勿缺——域过滤是预算与聚焦优化,不是
 * 正确性闸门)。与 1.2.7 域边界的 skills 域过滤同一语义（1.5.1 skills
 * 注入层已删，域过滤语义由本函数与能力清单收窄继承）。
 */
export function filterAgentsByDomain<T extends { name: string }>(
  agents: T[],
  domain?: string,
  manifests?: DomainManifest[],
): T[] {
  if (!domain) return agents;
  const list = manifests ?? (domainManifestsCache ??= loadDomainManifests());
  const current = list.find((m) => m.kind === domain);
  if (!current) return agents;
  const claimed = new Set(list.flatMap((m) => m.subagents));
  const keep = new Set(current.subagents);
  return agents.filter((a) => keep.has(a.name) || !claimed.has(a.name));
}
