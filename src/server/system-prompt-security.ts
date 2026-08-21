/**
 * 安全研究员版 P1 S1 — security 场景的安全语境注入（harness「组织上下文」）。
 *
 * 五段注入，全部遵循零注入语义（空即不注入）+ 每段硬字符上限：
 *
 *   1. `<zhishi-security-kernel>`  — 能力空间 + 通用循环的认知语言（静态）。
 *      给 LLM 的是参照，不是锁死的流程——按设计 §3 定位用 prompt 承载，
 *      不用状态机承载。
 *   2. `<zhishi-capabilities>`     — 能力清单（动态）。事实源：E1 引擎探测
 *      （engines.ts，经 engine-detect-cache 30s 缓存）+ E4 配方清单
 *      （recipes.ts::scanRecipes，~/.zhishi/environments/）+ E3 具名环境
 *      （registry，config.json）+ T4 当前现场选择（selection.ts，
 *      env-selection.json 按 workspace 查）。按环境分组呈现「哪个现场有
 *      什么工具」；无引擎/无配方/无具名环境且未选现场时整段零注入。
 *   3. `<zhishi-native-code>`      — 代码原生语境（静态）：工具链在环境配方
 *      里、闭环通道用法、环境标记约定（E6）、行为约定、恶意样本 env≠host
 *      纪律（D14 硬闸存在，提醒而非依赖 LLM 自觉）。
 *   4. `<zhishi-research-log>`     — 研究成败信号教学段（静态，D1）：
 *      task_kind / outcome / bug_class 枚举声明 + 何时记录 + 命令用法。
 *   5. `<zhishi-research-memory>`  — 研究记忆反喂段（动态，D4）：安全蒸馏弧
 *      （distill-research.ts，D3）的 keyed 产物按「成功路径 / 失败根因 /
 *      工具组合」三分节呈现（节内「### 域」分组原样保留）；无产物整段零注入。
 *
 * 结构照 buildDistilledMemorySection 模式：段落组装是纯函数（可单测），
 * IO 只有 collectSecurityCapabilities / collectResearchMemory 两个薄函数
 * （依赖可注入）。
 */

import { detectEnvironmentEnginesCached } from './environment/engine-detect-cache';
import type { EnvironmentEnginesReport } from './environment/engines';
import {
  defaultRecipesRoot,
  scanRecipes,
  type EnvironmentRecipe,
} from './environment/recipes';
import {
  envTagForEntry,
  findEnvironmentEntry,
  listEnvironments,
  type EnvironmentEntry,
} from './environment/registry';
import {
  defaultSelectionStorePath,
  getWorkspaceSelection,
  loadSelectionStore,
  type EnvSelection,
} from './environment/selection';
import { readResearchDistilled, type ResearchDistilledMemory } from './memory/distill-research';
import { getZhiShiDataDir } from './utils/app-dirs';
import { loadConfig } from './utils/admin-config';

// ===== 硬字符上限（零注入语义 + 每段硬顶，见技术方案 §3.1） =====

export const SECURITY_KERNEL_MAX_CHARS = 2000;
export const SECURITY_CAPABILITIES_MAX_CHARS = 2000;
export const NATIVE_CODE_MAX_CHARS = 1000;
export const RESEARCH_LOG_MAX_CHARS = 500;
export const RESEARCH_MEMORY_MAX_CHARS = 2000;

/** 截断标记——保留它，让 LLM 知道清单被裁过（不是幻觉，是边界声明）。 */
const TRUNCATION_MARKER = '\n…（清单过长，已按上限截断）';

/**
 * 硬字符上限：整行丢弃直到放得下，追加截断标记。静态段永远不会触发
 * （模板本身在上限内，单测断言保证）；动态段（能力清单）是真正消费者。
 */
function hardCapLines(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const budget = maxChars - TRUNCATION_MARKER.length;
  const lines = text.split('\n');
  let out = '';
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length > budget) break;
    out = next;
  }
  return out + TRUNCATION_MARKER;
}

// ===== 段 1：<zhishi-security-kernel>（静态认知语言） =====

const TMPL_SECURITY_KERNEL = `<zhishi-security-kernel>
你正运行在安全研究场景。定位是**实战**——0day 挖掘、1day 复现、漏洞验证与武器化为主。CTF 是补充场景：研究员需要做 CTF 时，任何环境按需适配（环境内自装工具 + 复用实战方法），不要用 CTF 套路过主线。

**人机关系：人不做驾驶员，只做授权官。** 边界之内（环境内执行、分析、留痕）你全自动推进，不等人；跨越边界的动作（写宿主/用本机凭据/改网络策略/销毁有成果环境）才停下来确认。

通用循环（认知参照，不是锁死的流程；按任务剪裁，允许跳步与回流）：
Recon 侦察 → Analyze 分析 → Construct 构造 → Execute 执行 → Evaluate 评估 → Distill 沉淀。评估结果反哺下一轮迭代，沉淀让循环越转越好。

五层认知方式（第一性原理，贯穿每个环节——不从 checklist 出发，从系统的假设裂缝出发）：
1. **深度理解**：先建心智模型——系统解决什么问题、信任边界在哪、数据怎么流、依赖哪些 invariants。别上来就追函数。
2. **对抗共情**：模拟开发者思维——时间压力下的捷径、过度自信的盲区（TODO/FIXME/HACK/"这不应该发生"）、内部接口与错误处理器（最后设防的地方）。最脆弱的代码是开发者感觉最安全的地方。
3. **溯因推理**：从「不对劲」反推，不从已知漏洞模式正推——函数名与行为矛盾、平行路径一个有检查一个没有、注释与代码矛盾。问「如果这个异常可被利用，必须满足什么条件」，从后果反推原因。
4. **认识论谦卑**：你对系统的理解是模型不是真相——识别自己最强的假设，设计「如果假设正确则应该失败」的测试去打破它；测试意外成功 = 模型与现实的裂缝 = 0-day 藏身处。
5. **远距类比**：跨域找结构相似——「这个解析器处理嵌套的方式和 HTTP chunked 一样，会不会有同类走私攻击？」不搜已知漏洞类型，问「这段代码与以前被攻破过的系统共享什么抽象结构」。

置信度校准锚点（报告发现时严格按此赋分，不要膨胀）：
- 0.90-1.00 = 确认可利用（有验证过的 PoC 路径）
- 0.80-0.89 = 高置信（攻击路径明确，需确认精确执行轨迹）
- 0.60-0.79 = 可疑模式（危险 sink 可见，数据流未完全证明）
- <0.60 = 推测噪音——**不报告**。research_log 的 summary 以置信度 0.xx 开头。

知识权威级：expert_search 返回专家审定知识（决策级依据，高于你的权重知识与蒸馏经验）；与你的判断冲突时以它为准，并在 research_log 记录冲突点。查不到不阻塞——未命中≠不存在，标注无先例继续。

执行纪律：
- **长任务走 env_bg**：预计超过 30 秒的命令（循环/长扫描/fuzz/监听）用 env_bg 后台跑再 poll——env_exec 是一次性等返回，堵住它会拖死本轮。

任务模板参照（循环的实例化）：
- 漏洞挖掘：侦察攻击面 → 分析代码/协议/解析器 → 构造触发输入 → 执行（fuzz / PoC）→ 评估崩溃与覆盖 → 沉淀漏洞模式。
- 漏洞利用：侦察目标环境 → 分析原语与约束 → 构造 exploit → 执行验证 → 评估稳定性 → 沉淀利用路径。
- 漏洞复现（1day）：拿补丁 diff 或公告 → 定位修复点 → 复现崩溃 → 判定可利用性 → 沉淀复现与利用路径。
- 渗透测试：侦察信息收集 → 分析弱点 → 构造访问链 → 执行突破/横向 → 评估影响面 → 沉淀报告与路径。
- 密码学：侦察算法与参数 → 分析数学结构 → 构造攻击 → 执行求解 → 评估正确性 → 沉淀攻击模板。
</zhishi-security-kernel>`;

// ===== 段 3：<zhishi-native-code>（静态代码原生语境） =====

const TMPL_NATIVE_CODE = `<zhishi-native-code>
代码原生通道（一等路径，不是裸 shell 的临时组合）：
- 工具链在环境类型里：dev 环境一开即有 clang / python3 / gdb，宿主不装编译与安全工具——需要编译调试就先开对应环境。
- 闭环通道：zhishi env up <类型> 开出新环境，zhishi env open <id> 接入已有环境，zhishi term --cmd "<命令>" 在环境里执行——编译、运行、调试在同一个环境终端里闭环。
- 环境标记约定：host / docker:<容器> / vm:<名称> / range:<主机>；终端与操作按标记归属环境，跨界动作走边界确认。
- 行为约定：写完 C/汇编直接在环境里编译跑，不要绕脚本语言重新实现；代码写在工作区、挂载进环境执行、产物落回工作区。
- 恶意样本必须在 env≠host 的环境里操作（D14 硬闸会拦，但这是纪律，不是靠闸兜底）。
</zhishi-native-code>`;

// ===== 段 2：<zhishi-capabilities>（动态能力清单） =====

/**
 * 能力清单的数据源快照。四个字段各对一个已有模块（见文件头），
 * collectSecurityCapabilities 负责采集；纯函数只消费这个结构。
 */
export interface SecurityCapabilitiesData {
  engines: EnvironmentEnginesReport;
  recipes: EnvironmentRecipe[];
  environments: EnvironmentEntry[];
  /** 当前 workspace 的现场选择（缺省 host = 仅工作区控制面）。 */
  selection: EnvSelection;
}

const ENGINE_DISPLAY_NAME: Record<string, string> = {
  docker: 'Docker（容器环境）',
  hyperv: 'Hyper-V（VM 环境）',
  virtualbox: 'VirtualBox（VM 环境）',
  vmware: 'VMware（VM 环境）',
  libvirt: 'libvirt（VM 环境）',
  ssh: 'ssh（远程/靶场接入）',
};

/** 当前现场的一行描述；env 选择优先按注册表条目解析出精确标记（E6）。 */
function describeSelection(data: SecurityCapabilitiesData): string {
  const sel = data.selection;
  switch (sel.kind) {
    case 'host':
      return 'host（仅工作区控制面——尚未选定研究环境，zhishi env up / env open 可随时开）';
    case 'recipe':
      return `docker:${sel.instanceId}（类型 ${sel.name} 的实例）`;
    case 'env': {
      const entry = findEnvironmentEntry(data.environments, sel.id);
      const tag = entry ? envTagForEntry(entry) : `env:${sel.id}`;
      return `${tag}（具名环境 ${sel.id}）`;
    }
  }
}

/**
 * 组装 `<zhishi-capabilities>` 段。零注入：数据缺失，或「无可用引擎 +
 * 无 valid 配方 + 无具名环境 + 未选现场（host）」——即没有任何可协作的
 * 现场可言时返回 ''。硬顶 SECURITY_CAPABILITIES_MAX_CHARS。
 */
export function buildSecurityCapabilitiesSection(
  data: SecurityCapabilitiesData | undefined,
): string {
  if (!data) return '';

  const availableEngines = data.engines.engines.filter((e) => e.available);
  const validRecipes = data.recipes.filter((r) => r.valid);

  if (
    availableEngines.length === 0 &&
    validRecipes.length === 0 &&
    data.environments.length === 0 &&
    data.selection.kind === 'host'
  ) {
    return '';
  }

  const lines: string[] = [];

  lines.push(`当前环境：${describeSelection(data)}`);

  if (availableEngines.length > 0) {
    const items = availableEngines.map(
      (e) => `${ENGINE_DISPLAY_NAME[e.kind] ?? e.kind}${e.version ? ` ${e.version}` : ''}`,
    );
    lines.push(`环境引擎：${items.join('；')}`);
  } else {
    lines.push('环境引擎：未检测到可用引擎（docker / 虚拟化 / ssh 均不可用——下面的环境暂开不起来，先按引擎引导装好）');
  }

  if (validRecipes.length > 0) {
    lines.push('环境类型（zhishi env up <id> 即开出该环境，工具在环境里开箱即用）：');
    for (const recipe of validRecipes) {
      const tools = recipe.tools.length > 0 ? recipe.tools.join('、') : '（未声明工具）';
      lines.push(`- ${recipe.id}（${recipe.base ?? '?'}）：${tools}`);
    }
  }

  if (data.environments.length > 0) {
    lines.push('具名环境（zhishi env open <id> 接入；类型绑定 = 该环境带哪些工具）：');
    for (const entry of data.environments) {
      // 老条目的 name 可能是 "pwn-vm（pwn-vm）" 形态——以 id 开头就不再包一层。
      const label = entry.name && entry.name !== entry.id && !entry.name.startsWith(entry.id)
        ? `${entry.id}（${entry.name}）`
        : entry.id;
      // 配方绑定:entry.recipeId 优先,回落 id/vmName 同名配方(老条目)。
      const recipe = validRecipes.find(
        (r) => r.id === entry.recipeId || r.id === entry.id || r.id === entry.vmName,
      );
      const binding = recipe
        ? `（类型 ${recipe.id}：${recipe.tools.length > 0 ? recipe.tools.join('、') : '未声明工具'}）`
        : '（无类型绑定——手动接入/旧条目）';
      lines.push(`- ${label} → ${envTagForEntry(entry)}${binding}`);
    }
  }

  const body = `<zhishi-capabilities>
这台机器上实际可用的研究环境（事实源：环境引擎探测 + 环境类型清单 + 具名环境注册表，会话启动时刷新）：
${lines.join('\n')}
</zhishi-capabilities>`;

  return hardCapLines(body, SECURITY_CAPABILITIES_MAX_CHARS);
}

// ===== 段 4：<zhishi-research-log>（静态，D1 研究成败信号教学） =====

const TMPL_RESEARCH_LOG = `<zhishi-research-log>
研究成败记录（蒸馏原料）：拿到 flag / 确认根因 / fuzz 出独有崩溃 / 研判完成 / 放弃时各落一条。**agent 用 loop 的 research_log 工具落库**——别在环境里跑 zhishi CLI（够不到）。
task_kind：binary / pentest / ai-security / redteam / malware / intel / ctf；outcome：success / fail / stuck；bug_class（可空）：stack-overflow / heap-overflow / uaf / double-free / oob-read / oob-write / null-deref / int-overflow / format-string / type-confusion / other；summary 一句话。
人侧查询/补记：zhishi research list / zhishi research log。
</zhishi-research-log>`;

// ===== 静态段出口（套硬顶；模板在上限内由单测断言） =====

export function buildSecurityKernelSection(): string {
  return hardCapLines(TMPL_SECURITY_KERNEL, SECURITY_KERNEL_MAX_CHARS);
}

export function buildNativeCodeSection(): string {
  return hardCapLines(TMPL_NATIVE_CODE, NATIVE_CODE_MAX_CHARS);
}

export function buildResearchLogSection(): string {
  return hardCapLines(TMPL_RESEARCH_LOG, RESEARCH_LOG_MAX_CHARS);
}

// ===== 段 5：<zhishi-research-memory>（动态，D4 研究记忆反喂） =====

/**
 * 组装 `<zhishi-research-memory>` 段——安全蒸馏弧（D3）产物的反喂注入，
 * 蒸馏闭环的最后一环：研究成败记录（D1）→ 安全蒸馏弧（D3）→ 反喂进
 * security 场景的 system prompt（本段）。
 *
 * 按「成功路径 / 失败根因 / 工具组合」三分节呈现；蒸馏产物节内的
 * 「### 域：<task_kind>」分组原样保留（经验不跨域混压的呈现侧）。
 * 零注入：数据缺失或三分节全空 → 返回 ''。硬顶 RESEARCH_MEMORY_MAX_CHARS
 * （整行截断 + 截断标记）。
 */
export function buildResearchMemorySection(memory: ResearchDistilledMemory | undefined): string {
  if (!memory) return '';
  const parts: string[] = [];
  if (memory.successPaths.trim()) parts.push(`## 成功路径\n${memory.successPaths.trim()}`);
  if (memory.failureRoots.trim()) parts.push(`## 失败根因\n${memory.failureRoots.trim()}`);
  if (memory.toolCombos.trim()) parts.push(`## 工具组合\n${memory.toolCombos.trim()}`);
  if (parts.length === 0) return '';
  const body = `<zhishi-research-memory>
以下是安全蒸馏弧从你的研究成败记录里定期沉淀的分域经验（按研究域分组）——上手新任务前先据此校准打法：复用已验证的成功路径与工具组合，别重蹈已标记的死路。
${parts.join('\n\n')}
</zhishi-research-memory>`;
  return hardCapLines(body, RESEARCH_MEMORY_MAX_CHARS);
}

// ===== 薄 IO — 会话启动时的数据采集（依赖可注入，测试不碰真实环境） =====

export interface CollectSecurityCapabilitiesDeps {
  /** 引擎探测（默认走 30s 缓存版）。 */
  detectEngines?: () => Promise<EnvironmentEnginesReport>;
  /** 配方根目录（默认 ~/.zhishi/environments/）。 */
  recipesRoot?: string;
  /** config.json 内容（默认 loadConfig()）。 */
  config?: { environments?: EnvironmentEntry[]; [key: string]: unknown };
  /** env-selection.json 路径（默认 ~/.zhishi/env-selection.json）。 */
  selectionPath?: string;
}

/**
 * 采集能力清单数据源。只在 security 场景的会话启动路径调用——引擎探测
 * 带 30s 缓存，配方/注册表/选择都是本地小文件读，成本可控。
 */
export async function collectSecurityCapabilities(
  workspace: string,
  deps: CollectSecurityCapabilitiesDeps = {},
): Promise<SecurityCapabilitiesData> {
  const engines = await (deps.detectEngines ?? detectEnvironmentEnginesCached)();
  const recipes = scanRecipes(deps.recipesRoot ?? defaultRecipesRoot());
  const environments = listEnvironments(deps.config ?? loadConfig());
  const selection = getWorkspaceSelection(
    loadSelectionStore(deps.selectionPath ?? defaultSelectionStorePath()),
    workspace,
  );
  return { engines, recipes, environments, selection };
}

export interface CollectResearchMemoryDeps {
  /** 蒸馏产物读取函数（默认 readResearchDistilled——memories 表 keyed 条目）。 */
  read?: (baseDir: string) => ResearchDistilledMemory;
  /** 数据根目录（默认 ~/.zhishi）。 */
  baseDir?: string;
}

/**
 * 采集研究记忆反喂数据源（D4）。只在 security 场景的会话启动路径调用——
 * 三次 keyed 条目查询（本地 db 小读），成本可忽略。三分节全空时
 * buildResearchMemorySection 零注入。
 */
export function collectResearchMemory(deps: CollectResearchMemoryDeps = {}): ResearchDistilledMemory {
  return (deps.read ?? readResearchDistilled)(deps.baseDir ?? getZhiShiDataDir());
}
