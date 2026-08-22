/**
 * 安全研究员版 P1 E4 — environment recipe（环境配方）解析与注册.
 *
 * 我们不分发工具，分发「能把干净环境变成研究现场」的配方。配方目录结构：
 *
 *   <recipesRoot>/<name>/
 *     Dockerfile    # 基础镜像 + 工具集 + 服务（docker 配方必需）
 *     setup.sh      # 初始化：装依赖、部署目标、起服务、自检
 *     SKILL.md      # frontmatter: name/description/base(docker|vm)/tools[]
 *                   # 正文教方法（何时用、怎么进、结果怎么采、怎么收尾）
 *
 * 配方抽象对两类基底同构：docker 配方 = Dockerfile + setup.sh + SKILL.md；
 * VM 配方 = SKILL.md（frontmatter 可带 vm_base/vm_user/vm_snapshot/vm_engine）+
 * 初始化脚本 + 快照约定（up 由 environment/vm-lifecycle.ts 的 vmrun 驱动提供，
 * 模板 .vmx 也可由 `env up --vm-base` 现场给出）。
 *
 * frontmatter 的 tools[] 是发现环节能力清单注入的唯一事实源——不解析
 * Dockerfile；正文（何时用/怎么进/标准工作流）由 buildRecipeWorkflowSummary
 * 提炼成 ≤400 字符摘要随工具名注入（1.2.5「用」——裸工具名不够，agent 要
 * 知道打法）。结构照 `engines.ts`：frontmatter 解析、校验、清单聚合是纯
 * 函数（可单测）；目录扫描是薄 IO，根目录可注入（默认
 * `~/.zhishi/environments/`，测试传临时目录）。单个配方损坏（缺文件、
 * 非法 base）只标记该配方 invalid 并带原因，不炸整体扫描。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { load as yamlLoad } from 'js-yaml';

import { getZhiShiDataDir } from '../utils/app-dirs';

export type RecipeBase = 'docker' | 'vm';

export const RECIPE_BASES: readonly RecipeBase[] = ['docker', 'vm'];

/** VM 配方的驱动引擎（frontmatter vm_engine；缺省 vmware）。 */
export type VmEngine = 'vmware' | 'hyperv' | 'virtualbox';

export const VM_ENGINES: readonly VmEngine[] = ['vmware', 'hyperv', 'virtualbox'];

/** 从 SKILL.md frontmatter 解析出的原始字段（全部可选，缺失由校验环节报告）。 */
export interface RecipeFrontmatter {
  name?: string;
  description?: string;
  base?: RecipeBase;
  tools?: string[];
  /** vm 配方：模板 VM 的 .vmx 绝对路径（也可由 `env up --vm-base` 现场给）。 */
  vm_base?: string;
  /** vm 配方：guest SSH 用户名（地址回写 env 条目时的缺省 user）。 */
  vm_user?: string;
  /** vm 配方：快照约定名——up 时若存在则先 revertToSnapshot（干净现场）。 */
  vm_snapshot?: string;
  /** vm 配方：驱动引擎（缺省 vmware；hyperv = Export-VM 导出目录模板，virtualbox = 已注册 VM 名模板）。 */
  vm_engine?: VmEngine;
}

/** 一个已扫描的配方；invalid 配方保留已解析字段 + 原因列表。 */
export interface EnvironmentRecipe {
  /** 目录名（配方 id，CLI/API 引用用它）。 */
  id: string;
  /** 配方目录绝对路径。 */
  dir: string;
  /** frontmatter name；缺失时回退为 id。 */
  name: string;
  description?: string;
  base?: RecipeBase;
  /** 工具清单声明（发现环节唯一事实源）。 */
  tools: string[];
  /** vm 配方：模板 .vmx 路径（frontmatter vm_base；可被 env up --vm-base 覆盖）。 */
  vmBase?: string;
  /** vm 配方：guest SSH 缺省用户（frontmatter vm_user）。 */
  vmUser?: string;
  /** vm 配方：快照约定名（frontmatter vm_snapshot；up 前存在则 revert）。 */
  vmSnapshot?: string;
  /** vm 配方：驱动引擎（frontmatter vm_engine；缺省 vmware）。 */
  vmEngine?: VmEngine;
  /**
   * 正文工作流摘要（1.2.5「用」）：SKILL.md 正文（frontmatter 之后）提炼，
   * 供能力清单注入段在工具名后携带——只给裸工具名 agent 不知道何时用/怎么进。
   * 已按 RECIPE_WORKFLOW_SUMMARY_MAX_CHARS 截断；正文为空则 undefined。
   */
  workflowSummary?: string;
  valid: boolean;
  invalidReasons: string[];
}

// ---------------------------------------------------------------------------
// Pure functions — frontmatter parse / validation / aggregation
// ---------------------------------------------------------------------------

/** Extract the `---`-delimited frontmatter block (same shape as slashCommands.ts). */
function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// 正文工作流摘要（1.2.5「用」——配方正文进能力清单）
// ---------------------------------------------------------------------------

/** 每环境摘要硬顶：能力清单段的预算护栏（超出的部分截断，段级硬顶见 system-prompt-security.ts）。 */
export const RECIPE_WORKFLOW_SUMMARY_MAX_CHARS = 400;

/** 摘要截断标记——保留它，让 LLM 知道摘要是截过的（与能力清单段截断标记同一语义）。 */
const WORKFLOW_SUMMARY_TRUNCATION = '…';

/** SKILL.md 正文 = frontmatter 块之后的部分；无 frontmatter 时全文即正文。 */
function extractBody(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length) : content;
}

/**
 * 从 SKILL.md 正文提炼工作流摘要（纯函数，可单测）：去 frontmatter，H1
 * 标题剥 `#` 保留（配方的一句话定位是摘要干货），小节标题（`##` 及以下）
 * 整行剔除（「何时用/怎么进」这类结构标记对 LLM 是噪音，留着白烧预算），
 * 代码围栏行剔除（围栏内命令保留——标准工作流的命令是干货）；逐行 trim
 * 后以「；」连成一段——摘要在能力清单段占一行。超过 maxChars 截断并带
 * `…` 标记；正文为空（仅 frontmatter / 全空白）返回 undefined，注入侧
 * 跳过摘要行。
 */
export function buildRecipeWorkflowSummary(
  content: string,
  maxChars: number = RECIPE_WORKFLOW_SUMMARY_MAX_CHARS,
): string | undefined {
  const lines = extractBody(content)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('```') && !/^#{2,6}\s/.test(line))
    .map((line) => line.replace(/^#\s+/, ''));
  if (lines.length === 0) return undefined;
  const text = lines.join('；');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - WORKFLOW_SUMMARY_TRUNCATION.length)}${WORKFLOW_SUMMARY_TRUNCATION}`;
}

/**
 * Parse SKILL.md frontmatter into recipe fields. Never throws — malformed
 * YAML / wrong-typed fields land in `errors` (Chinese, user-facing).
 */
export function parseRecipeFrontmatter(content: string): {
  frontmatter: RecipeFrontmatter;
  errors: string[];
} {
  const errors: string[] = [];
  const frontmatter: RecipeFrontmatter = {};

  const block = extractFrontmatter(content);
  if (block === null) return { frontmatter, errors };

  let parsed: unknown;
  try {
    parsed = yamlLoad(block);
  } catch (err) {
    errors.push(`SKILL.md frontmatter YAML 解析失败：${err instanceof Error ? err.message : String(err)}`);
    return { frontmatter, errors };
  }
  if (!parsed || typeof parsed !== 'object') return { frontmatter, errors };
  const source = parsed as Record<string, unknown>;

  if (typeof source.name === 'string' && source.name.trim()) {
    frontmatter.name = source.name.trim();
  }
  if (typeof source.description === 'string' && source.description.trim()) {
    frontmatter.description = source.description.trim();
  }

  if (source.base !== undefined) {
    if (typeof source.base === 'string' && RECIPE_BASES.includes(source.base as RecipeBase)) {
      frontmatter.base = source.base as RecipeBase;
    } else {
      errors.push(`非法 base：${JSON.stringify(source.base)}（可选：${RECIPE_BASES.join(' / ')}）`);
    }
  }

  if (source.tools !== undefined) {
    if (
      Array.isArray(source.tools) &&
      source.tools.every((t) => typeof t === 'string' && t.trim())
    ) {
      frontmatter.tools = source.tools.map((t) => (t as string).trim());
    } else {
      errors.push('tools 必须是非空字符串数组（工具清单声明，发现环节唯一事实源）');
    }
  }

  for (const key of ['vm_base', 'vm_user', 'vm_snapshot'] as const) {
    const raw = source[key];
    if (raw === undefined) continue;
    if (typeof raw === 'string' && raw.trim()) {
      frontmatter[key] = raw.trim();
    } else {
      errors.push(`${key} 必须是非空字符串（vm 配方字段）`);
    }
  }

  if (source.vm_engine !== undefined) {
    if (typeof source.vm_engine === 'string' && VM_ENGINES.includes(source.vm_engine as VmEngine)) {
      frontmatter.vm_engine = source.vm_engine as VmEngine;
    } else {
      errors.push(`非法 vm_engine：${JSON.stringify(source.vm_engine)}（可选：${VM_ENGINES.join(' / ')}；缺省 vmware）`);
    }
  }

  return { frontmatter, errors };
}

/**
 * Validate one recipe's parsed frontmatter against the files present in its
 * directory. Returns invalid reasons ([] = valid). docker 配方必须有
 * Dockerfile；vm 配方无额外文件要求（模板 .vmx 由 frontmatter vm_base 或
 * `env up --vm-base` 现场给出，up 时才校验存在性）。
 */
export function validateRecipe(
  frontmatter: RecipeFrontmatter,
  presentFiles: ReadonlySet<string>,
): string[] {
  const reasons: string[] = [];
  if (!frontmatter.name) reasons.push('SKILL.md frontmatter 缺少 name');
  if (!frontmatter.base) reasons.push('SKILL.md frontmatter 缺少 base（docker | vm）');
  if (frontmatter.base === 'docker' && !presentFiles.has('Dockerfile')) {
    reasons.push('docker 配方缺少 Dockerfile');
  }
  return reasons;
}

/**
 * Combine parse + validate into a recipe record. `skillContent === null`
 * means SKILL.md itself is missing. Pure: IO (read/readdir) happens in the
 * scanners below.
 */
export function buildRecipe(
  id: string,
  dir: string,
  skillContent: string | null,
  presentFiles: ReadonlySet<string>,
): EnvironmentRecipe {
  if (skillContent === null) {
    return {
      id,
      dir,
      name: id,
      tools: [],
      valid: false,
      invalidReasons: ['缺少 SKILL.md（配方定义文件）'],
    };
  }
  const { frontmatter, errors } = parseRecipeFrontmatter(skillContent);
  const reasons = [...errors, ...validateRecipe(frontmatter, presentFiles)];
  return {
    id,
    dir,
    name: frontmatter.name ?? id,
    description: frontmatter.description,
    base: frontmatter.base,
    tools: frontmatter.tools ?? [],
    workflowSummary: buildRecipeWorkflowSummary(skillContent),
    vmBase: frontmatter.vm_base,
    vmUser: frontmatter.vm_user,
    vmSnapshot: frontmatter.vm_snapshot,
    vmEngine: frontmatter.vm_engine,
    valid: reasons.length === 0,
    invalidReasons: reasons,
  };
}

/**
 * 清单聚合：tool → 声明了它的 valid 配方 id 列表。供发现环节能力清单注入
 * 用——SKILL.md 的 tools[] 是唯一事实源（不解析 Dockerfile）。invalid 配方
 * 的工具声明未经验证，跳过。按工具名排序，输出稳定。
 */
export function aggregateRecipeTools(
  recipes: readonly EnvironmentRecipe[],
): Array<{ tool: string; recipeIds: string[] }> {
  const byTool = new Map<string, string[]>();
  for (const recipe of recipes) {
    if (!recipe.valid) continue;
    for (const tool of recipe.tools) {
      const list = byTool.get(tool);
      if (list) list.push(recipe.id);
      else byTool.set(tool, [recipe.id]);
    }
  }
  return [...byTool.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tool, recipeIds]) => ({ tool, recipeIds }));
}

// ---------------------------------------------------------------------------
// Thin IO — directory scanning (root injectable for tests)
// ---------------------------------------------------------------------------

/** 默认配方根目录：~/.zhishi/environments/（Rust 侧播种落点）。 */
export function defaultRecipesRoot(): string {
  return join(getZhiShiDataDir(), 'environments');
}

/**
 * 播种备份目录（`<配方>.bak-<YYYYMMDD>` 或 `-N` 后缀，见
 * skills-config.ts 的配方内容哈希同步）不是配方——里面虽含 SKILL.md，
 * 扫描时必须跳过，否则旧版备份会以新 id 混进配方清单。
 */
export function isRecipeBackupDir(name: string): boolean {
  return /\.bak-\d{8}(-\d+)?$/.test(name);
}

/**
 * Scan the recipes root. Missing root → []. Non-directory entries (e.g. a
 * README.md at the root) are ignored. Invalid recipes stay in the list with
 * their reasons — one broken recipe never fails the whole scan.
 * Sorted by id for stable CLI/API output.
 */
export function scanRecipes(rootDir: string = defaultRecipesRoot()): EnvironmentRecipe[] {
  if (!existsSync(rootDir)) return [];
  const entries = readdirSync(rootDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !isRecipeBackupDir(d.name))
    .map((d) => d.name)
    .sort();

  return entries.map((id) => {
    const dir = join(rootDir, id);
    const presentFiles = new Set(
      readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name),
    );
    const skillContent = presentFiles.has('SKILL.md')
      ? readFileSync(join(dir, 'SKILL.md'), 'utf-8')
      : null;
    return buildRecipe(id, dir, skillContent, presentFiles);
  });
}

/** Load one recipe by id (directory name). Undefined when absent. */
export function loadRecipe(
  rootDir: string,
  id: string,
): EnvironmentRecipe | undefined {
  const dir = join(rootDir, id);
  if (!existsSync(dir)) return undefined;
  return scanRecipes(rootDir).find((r) => r.id === id);
}

// ---------------------------------------------------------------------------
// 配方工具自检（声明 vs 实装的机器校验——发现环从「信声明」升级到「信证据」）
// ---------------------------------------------------------------------------

/** 一条命令逐个验声明工具真实存在（ssh/docker 通道通用，sh 语义）。 */
export function buildToolCheckCommand(tools: string[]): string {
  const quoted = tools.map((t) => `'${t}'`).join(' ');
  return `for t in ${quoted}; do command -v "$t" >/dev/null 2>&1 && echo "OK:$t" || echo "MISS:$t"; done`;
}

/**
 * 声明词 → 探测命令映射（1.2.5「配」——词汇错位修正）。
 *
 * 配方 SKILL.md 的 tools[] 允许两种形态，本表只收后者：
 * - 真实二进制名（rg、gdb、semgrep……）——直接 `command -v <名>`，不进表；
 * - 包/能力名（pwntools、universal-ctags……）——二进制名与包名不同，
 *   或根本不是二进制（python 包），`command -v` 必假 MISS。
 *
 * 探测命令以退出码判有无（0 = 有）。注意 pwndbg 用 `gdb -batch`：
 * 非 batch 模式下 `pi import` 抛错 gdb 仍继续并以 0 退出（假 OK）；
 * -batch 遇命令错误以非零退出，才是可用的判据。
 */
export const TOOL_PROBE_COMMANDS: Readonly<Record<string, string>> = {
  pwntools: 'python3 -c "import pwn"',
  pwndbg: 'gdb -q -batch -ex "pi import pwndbg"',
  ripgrep: 'command -v rg',
  'universal-ctags': 'command -v ctags',
  ghidra: 'command -v analyzeHeadless',
  binutils: 'command -v objdump',
  nodejs: 'command -v node',
};

/**
 * 完整自检脚本：统一 PATH 前缀（非交互 ssh 不读 ~/.profile，~/.local/bin
 * 不在 PATH——pip --user 装的 pwntools 等会假 MISS；docker bash -lc 下
 * 无害），然后逐工具探测：映射表命中的用映射命令，未命中的复用
 * buildToolCheckCommand 的 `command -v` 循环。输出协议不变——每行
 * `OK:<声明词>` / `MISS:<声明词>`，由 parseToolCheckOutput 解析。
 */
export function buildToolCheckScript(tools: string[]): string {
  const parts: string[] = ['export PATH="$HOME/.local/bin:$PATH"'];
  const unmapped: string[] = [];
  for (const tool of tools) {
    const probe = TOOL_PROBE_COMMANDS[tool];
    if (probe === undefined) {
      unmapped.push(tool);
    } else {
      parts.push(`${probe} >/dev/null 2>&1 && echo "OK:${tool}" || echo "MISS:${tool}"`);
    }
  }
  if (unmapped.length > 0) parts.push(buildToolCheckCommand(unmapped));
  return parts.join('; ');
}

export interface ToolCheckResult {
  ok: boolean;
  missing: string[];
}

/** 解析自检输出。空工具清单 → ok（无声明无需验）。 */
export function parseToolCheckOutput(stdout: string, declared: string[]): ToolCheckResult {
  if (declared.length === 0) return { ok: true, missing: [] };
  const seen = new Set<string>();
  for (const line of stdout.split('\n')) {
    const m = /^(OK|MISS):(.+)$/.exec(line.trim());
    if (m) seen.add(`${m[1]}:${m[2]}`);
  }
  const missing = declared.filter((t) => !seen.has(`OK:${t}`));
  return { ok: missing.length === 0, missing };
}
