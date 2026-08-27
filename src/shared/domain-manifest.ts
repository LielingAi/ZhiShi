/**
 * 域包清单层（domain manifest）——P2 多域扩展的抽象层。
 *
 * 定调（2026-08-17 用户拍板）：方向定稿不单独做，一个抽象层 + 每域适配。
 * 不合并既有目录（bundled-environments / bundled-skills / bundled-agents 各有
 * 生命周期与工具链），清单只做**链接**：domain.json 指认该域的内容物,
 * 引擎/TUI 读清单驱动行为。加一个域 = 写一份 domain.json + 在既有目录填
 * 内容,零引擎改动。
 *
 * 首个回写域:binary(存量内容声明,验证 schema)。
 *
 * 1.2.3 起本模块从 server/domains/manifest.ts 迁至 shared（issue #5）：TUI
 * signal-extract 直接消费清单信号规则，此前因此把 server 运行时卷进 CLI
 * bundle。server/domains/manifest.ts 保留 re-export 壳，既有引用路径不变。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { getScriptDir } from './script-dir';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** 域级信号规则：正则 + 展示标签。1.4.3 起分主辅——
 *  signals = 内容特征（研究在做什么，域裁决主信号）；
 *  auxSignals = 产物指纹（研究产出的标志物，不参与域裁决）。 */
export interface DomainSignalRule {
  /** 正则(字符串形态,loader 编译;非法正则在校验时报)。 */
  re: string;
  /** 摘要标签(显示用)。 */
  label: string;
  /** 命中后摘要尾部是否附匹配本体(如端口号/CVE 号)。 */
  appendMatch?: boolean;
}

export interface DomainManifest {
  /** research kind(binary/pentest/ai-security/redteam/malware/intel/ctf)。 */
  kind: string;
  name: string;
  /** 引用 bundled-environments 的配方 id。 */
  recipes: string[];
  /** 引用 bundled-skills 的 skill 文件夹名。 */
  skills: string[];
  /** 引用 bundled-agents 的 subagent 名。 */
  subagents: string[];
  /** 域级内容信号（1.4.3 重定义）：任务性质词/方法特征/工具使用模式——
   *  研究内容的特征，resolveSessionDomain 的域裁决主信号。 */
  signals: DomainSignalRule[];
  /** 域级产物指纹（1.4.3 降级为辅助证据）：崩溃信号/会话已开/garak 输出
   *  形态等产物标志物——不参与域裁决，保留供能力清单摘要/未来展示用。 */
  auxSignals?: DomainSignalRule[];
  /** 就绪验收清单(domain check 的展示面,人工读)。 */
  acceptance: string[];
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** bundled-domains 目录解析(与 bundled-skills 同策略:同级→向上 5 层)。 */
export function resolveBundledDomainsDir(fromDir?: string): string | null {
  return resolveBundledDir('bundled-domains', fromDir);
}

/** 通用 bundled-* 目录解析(prod 同级 → dev 向上 5 层)。 */
export function resolveBundledDir(name: string, fromDir?: string): string | null {
  const scriptDir = fromDir ?? getScriptDir();
  const prodPath = resolve(scriptDir, name);
  if (existsSync(prodPath)) return prodPath;
  let dir = scriptDir;
  for (let i = 0; i < 5; i++) {
    const devPath = resolve(dir, name);
    if (existsSync(devPath)) return devPath;
    dir = dirname(dir);
  }
  return null;
}

/** 读单份清单;文件缺失/JSON 非法/缺必填字段 → null(读侧容错)。 */
export function loadDomainManifest(dir: string): DomainManifest | null {
  const file = join(dir, 'domain.json');
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<DomainManifest>;
    if (typeof raw.kind !== 'string' || !raw.kind) return null;
    if (typeof raw.name !== 'string' || !raw.name) return null;
    return {
      kind: raw.kind,
      name: raw.name,
      recipes: Array.isArray(raw.recipes) ? raw.recipes : [],
      skills: Array.isArray(raw.skills) ? raw.skills : [],
      subagents: Array.isArray(raw.subagents) ? raw.subagents : [],
      signals: Array.isArray(raw.signals) ? raw.signals : [],
      auxSignals: Array.isArray(raw.auxSignals) ? raw.auxSignals : [],
      acceptance: Array.isArray(raw.acceptance) ? raw.acceptance : [],
    };
  } catch {
    return null;
  }
}

/** 收集全部域清单(root 缺省 bundled-domains 解析)。 */
export function loadDomainManifests(root?: string | null): DomainManifest[] {
  const dir = root === undefined ? resolveBundledDomainsDir() : root;
  if (!dir || !existsSync(dir)) return [];
  const out: DomainManifest[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  for (const name of names) {
    // 非目录/缺 domain.json 的项被 loadDomainManifest 自然跳过。
    const m = loadDomainManifest(join(dir, name));
    if (m) out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 校验(domain check 的核心)
// ---------------------------------------------------------------------------

export interface DomainCheckContext {
  /** 存在的配方 id 集合。 */
  recipeIds: Set<string>;
  /** 存在的 skill 文件夹名集合(bundled + 用户库)。 */
  skillIds: Set<string>;
  /** 存在的 subagent 名集合。 */
  subagentIds: Set<string>;
}

export interface DomainCheckIssue {
  level: 'error' | 'warn';
  message: string;
}

/** 校验一份清单:引用完整 + 信号正则可编译。 */
export function validateDomainManifest(m: DomainManifest, ctx: DomainCheckContext): DomainCheckIssue[] {
  const issues: DomainCheckIssue[] = [];
  for (const r of m.recipes) {
    if (!ctx.recipeIds.has(r)) issues.push({ level: 'error', message: `配方 "${r}" 不存在` });
  }
  for (const s of m.skills) {
    if (!ctx.skillIds.has(s)) issues.push({ level: 'error', message: `skill "${s}" 不存在` });
  }
  for (const a of m.subagents) {
    if (!ctx.subagentIds.has(a)) issues.push({ level: 'error', message: `subagent "${a}" 不存在` });
  }
  for (const sig of m.signals) {
    try {
      new RegExp(sig.re, 'i');
    } catch {
      issues.push({ level: 'error', message: `信号规则正则非法:${sig.re}` });
    }
  }
  for (const sig of m.auxSignals ?? []) {
    try {
      new RegExp(sig.re, 'i');
    } catch {
      issues.push({ level: 'error', message: `辅助信号规则正则非法:${sig.re}` });
    }
  }
  if (m.acceptance.length === 0) {
    issues.push({ level: 'warn', message: '验收清单为空(acceptance 至少一条,否则无法判断就绪)' });
  }
  return issues;
}

/** 全部清单的信号规则并集(signal-extract 用;域间并集无害——模式不互斥)。 */
export function collectDomainSignals(manifests: DomainManifest[]): DomainSignalRule[] {
  return manifests.flatMap((m) => m.signals);
}
