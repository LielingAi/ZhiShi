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
 *      什么工具」，配方行附正文工作流摘要（1.2.5「用」，每环境 ≤400 字符，
 *      提炼在 recipes.ts）；无引擎/无配方/无具名环境且未选现场时整段零注入。
 *      1.3.7 场景 3：选中环境带现场推导能力集合（capabilityDomains =
 *      配方绑定域 ∪ 工具探测域）时，域收窄空间放宽到整个集合，并注入
 *      「能力集合 + 集合内配方工具并集」行（探测在场证据沿用 toolCheck
 *      漂移标注口径）；无能力字段（存量零迁移）逐字节维持旧行为。
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
import {
  readResearchDistilled,
  RESEARCH_DISTILL_SECTIONS,
  RESEARCH_MEMORY_INJECT_BUDGET,
  type ResearchDistilledMemory,
} from './memory/distill-research';
import { isResearchTaskKind, keyedDistilledEntryJudgedWrong, type MemoryKind, type ResearchTaskKind } from './memory/store';
import { loadDomainManifests, type DomainManifest } from './domains/manifest';
import { getZhiShiDataDir } from './utils/app-dirs';
import { loadConfig } from './utils/admin-config';

// ===== 硬字符上限（零注入语义 + 每段硬顶，见技术方案 §3.1） =====

export const SECURITY_KERNEL_MAX_CHARS = 2400; // 1.4.4 抬顶 2000→2400：研究档案教学段并入后模板 2.2K+，2000 顶把任务模板尾部（漏洞挖掘等）静默截掉——预算已名存实亡，正式抬顶并对齐单测
export const SECURITY_CAPABILITIES_MAX_CHARS = 4000; // 1.2.5 抬顶：2000 装不下 10 配方的工作流摘要（试装机制下只见 1 条），4000 可常规见
export const NATIVE_CODE_MAX_CHARS = 1000;
// 1.2.6 抬顶 500→640：500 顶下模板正文(496)超出「硬顶−截断标记」预算，
// 段落尾部被静默截掉收尾标签——硬顶沦为模板自己的截断器。640 给足余量。
export const RESEARCH_LOG_MAX_CHARS = 640;
/**
 * 研究记忆段硬顶 = 蒸馏弧的注入预算（distill-research.ts，单一事实源）。
 * 1.2.4 修预算倒挂：蒸馏三节额度按此预算三等分推导，蒸馏没截断的产物
 * 注入侧必然装得下；本硬顶只剩「老库超顶产物」的兜底语义。
 */
export const RESEARCH_MEMORY_MAX_CHARS = RESEARCH_MEMORY_INJECT_BUDGET;

/** 截断标记——保留它，让 LLM 知道清单被裁过（不是幻觉，是边界声明）。 */
const TRUNCATION_MARKER = '\n…（清单过长，已按上限截断）';
/** 研究记忆段的截断标记：指明被裁的是哪段、权威全文在哪（丢弃可观测，不静默）。 */
const RESEARCH_MEMORY_TRUNCATION_MARKER = '\n…（研究记忆超出注入预算，已按上限截断——完整内容在记忆库 research-distill:* keyed 条目）';

/**
 * 硬字符上限：整行丢弃直到放得下，追加截断标记。静态段永远不会触发
 * （模板本身在上限内，单测断言保证）；动态段（能力清单）是真正消费者。
 */
function hardCapLines(text: string, maxChars: number, marker: string = TRUNCATION_MARKER): string {
  if (text.length <= maxChars) return text;
  const budget = maxChars - marker.length;
  const lines = text.split('\n');
  let out = '';
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length > budget) break;
    out = next;
  }
  return out + marker;
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

知识权威级：expert_search 返回专家审定知识（决策级依据，高于你的权重知识与蒸馏经验）；与你的判断冲突时以它为准，并在 research_log 记录冲突点。查不到不阻塞——未命中≠不存在，标注无先例继续。公开情报侧用 intel_search（CVE/产品指纹检索宿主情报库）——它是公共原料，给线索不给结论，结论仍由你验证。

求助时机（1.2.1 实战校准）：专家知识是**最后的落脚点**——先尽力（你的知识、skills 方法、蒸馏经验），识别到知识缺口再查 expert_search。缺口的信号是「反复失败 / 没有把握 / 找不到先例」，**不是进展慢**——慢慢做对不需要救援。查不到不阻塞，继续。

决策点（人拍板）：方向分歧（方案互斥且代价不可逆）、关键取舍无把握、且专家库无基准时，用 request_decision 提请人决定。提请前先查 expert_search——命中可验证基准就按它走、不问人；查不到（库中无基准）才提请。提请后暂停这条线的执行，等决定以 user 消息注入回来再继续，不要边等边推进。

研究档案（研究状态的显式载体，用 research_archive 工具维护，每轮注回你的上下文——基于它继续，不从历史脑补）：①假设驱动实验——先立假设再实验，evidence 挂假设引用；②结论必须有证据支撑——finding 的 refs 必须挂已存在的 V# 证据实体，没证据会被工具拒绝；③证伪/纠错必须走 falsify/correct 操作留痕，**不要把证伪写进 finding 文本冒充成立**（排除的路也是成果，防止反复重访死路）；④目标不清先立 question（未决问题），别空转猜方向。档案只存一两句话的断言，全文在流里；anchor 标注用「env_exec #N / 命令名 / 文件:行号」，不要用「轮」（与 auto loop 轮次撞车）。

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
- 工具链在环境类型里：dev 环境一开即有 clang / python3 / gdb，宿主不装编译与安全工具——需要编译调试就先有对应环境。
- 闭环通道：你在当前通道里没有宿主 shell，开/接环境是人侧动作（人经 zhishi env up <类型> / zhishi env open <id> 选定现场）；现场锚定后你获得 env_exec（一次性执行）/ env_bg（长任务后台）工具，编译、运行、调试在同一个环境里闭环。未锚定时说明需要哪类环境、请人开出。
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

/**
 * 当前现场选中的注册表条目（1.3.7 场景 3 能力集合的载体）：
 * env 选择按 id 查；recipe 选择按 instanceId 查（1.3.7「实例即环境」起
 * up 回写的条目 id = 实例名）。host 现场 / 查不到 → undefined。
 */
export function selectedEnvironmentEntry(
  data: SecurityCapabilitiesData | undefined,
): EnvironmentEntry | undefined {
  const sel = data?.selection;
  if (!sel || sel.kind === 'host') return undefined;
  const id = sel.kind === 'env' ? sel.id : sel.instanceId;
  return findEnvironmentEntry(data?.environments ?? [], id);
}

/** 当前现场的能力集合（服务端现场推导落盘；无 → undefined = 缺省行为）。 */
export function selectedCapabilityDomains(
  data: SecurityCapabilitiesData | undefined,
): { domains: string[]; derivedAt?: string; entry: EnvironmentEntry } | undefined {
  const entry = selectedEnvironmentEntry(data);
  if (!entry?.capabilityDomains?.length) return undefined;
  return { domains: entry.capabilityDomains, derivedAt: entry.capabilityDerivedAt, entry };
}

/** 当前现场的一行描述；env 选择优先按注册表条目解析出精确标记（E6）。 */
function describeSelection(data: SecurityCapabilitiesData): string {
  const sel = data.selection;
  switch (sel.kind) {
    case 'host':
      return 'host（仅工作区控制面——尚未选定研究环境，人侧可随时 zhishi env up / env open 开出）';
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
 * 能力清单的域收窄入参（1.2.7 域边界，全部可选——不传 = 现状逐字节一致）。
 */
export interface SecurityCapabilitiesDomainOptions {
  /**
   * 当前会话研究域（调用方经 resolveSessionDomain 推导）。命中 domain.json
   * 清单时只列该域 recipes ∪ 绑定了这些配方的具名环境；undefined 或域未被
   * 任何清单覆盖 → 全量（域过滤是预算优化，不是正确性闸门，宁多勿缺）。
   */
  domain?: string;
  /** 测试注入：域清单（缺省进程内缓存的 loadDomainManifests()）。 */
  manifests?: DomainManifest[];
}

/**
 * 组装 `<zhishi-capabilities>` 段。零注入：数据缺失，或「无可用引擎 +
 * 无 valid 配方 + 无具名环境 + 未选现场（host）」——即没有任何可协作的
 * 现场可言时返回 ''。硬顶 SECURITY_CAPABILITIES_MAX_CHARS。
 */
export function buildSecurityCapabilitiesSection(
  data: SecurityCapabilitiesData | undefined,
  options: SecurityCapabilitiesDomainOptions = {},
): string {
  if (!data) return '';

  const availableEngines = data.engines.engines.filter((e) => e.available);
  let validRecipes = data.recipes.filter((r) => r.valid);
  let environments = data.environments;

  // 1.4.3 归位：能力清单段 = 环境工具面，只按环境推导的能力集合收窄
  // （配方绑定域 ∪ 工具探测域）——**不再按 resolved 研究域收窄**（研究域
  // 只决定 skills/子代理/研究记忆注入，不决定环境有什么工具）。无能力集合
  // 时不动（全量，宁多勿缺——1.2.7 红线 #5）。
  const capability = selectedCapabilityDomains(data);
  const filterKinds = capability?.domains;
  if (filterKinds) {
    const all = options.manifests ?? (domainManifestsCache ??= loadDomainManifests());
    const matched = all.filter((m) => filterKinds.includes(m.kind));
    if (matched.length > 0) {
      const allowedRecipes = new Set(matched.flatMap((m) => m.recipes));
      validRecipes = validRecipes.filter((r) => allowedRecipes.has(r.id));
      // 1.3.8 多配方：具名环境命中任一绑定配方（recipeIds ∪ recipeId ∪
      // id/vmName 同名回落）即保留。
      environments = environments.filter((e) => {
        const bound = new Set<string>([
          ...(e.recipeIds ?? []),
          ...(e.recipeId ? [e.recipeId] : []),
          e.id,
          ...(e.vmName ? [e.vmName] : []),
        ]);
        return validRecipes.some((r) => bound.has(r.id));
      });
    }
  }

  if (
    availableEngines.length === 0 &&
    validRecipes.length === 0 &&
    environments.length === 0 &&
    data.selection.kind === 'host'
  ) {
    return '';
  }

  const lines: string[] = [];

  lines.push(`当前环境：${describeSelection(data)}`);

  // 1.3.7 场景 3：能力集合现场推导结果（配方绑定域 ∪ 工具探测域）——
  // 模型需要知道这台环境里实际能用什么。工具清单 = 集合内各域配方的工具
  // 并集（去重）；在场证据标注沿用 toolCheck 漂移口径（声明了但环境里没有）。
  if (capability) {
    const capManifests = (options.manifests ?? (domainManifestsCache ??= loadDomainManifests()))
      .filter((m) => capability.domains.includes(m.kind));
    const capRecipeIds = new Set(capManifests.flatMap((m) => m.recipes));
    const capTools = [
      ...new Set(
        data.recipes.filter((r) => r.valid && capRecipeIds.has(r.id)).flatMap((r) => r.tools),
      ),
    ];
    const derivedNote = capability.derivedAt ? `，探测于 ${capability.derivedAt}` : '';
    lines.push(
      `当前环境能力集合（现场推导：配方绑定 ∪ 工具探测${derivedNote}）：${capability.domains.join(' · ')}`,
    );
    if (capTools.length > 0) {
      const missing = (capability.entry.toolCheck?.missing ?? []).filter((t) => capTools.includes(t));
      lines.push(
        `可用工具（能力集合内配方并集）：${capTools.join('、')}` +
          (missing.length > 0 ? `（声明了但环境里没有：${missing.join('、')}）` : ''),
      );
    }
  }

  if (availableEngines.length > 0) {
    const items = availableEngines.map(
      (e) => `${ENGINE_DISPLAY_NAME[e.kind] ?? e.kind}${e.version ? ` ${e.version}` : ''}`,
    );
    lines.push(`环境引擎：${items.join('；')}`);
  } else {
    lines.push('环境引擎：未检测到可用引擎（docker / 虚拟化 / ssh 均不可用——下面的环境暂开不起来，先按引擎引导装好）');
  }

  // 配方工作流摘要（1.2.5「用」）：与核心行分开收集——工具清单是核心
  // （截断也不能丢环境条目，否则发现环链路回退），摘要是增强（预算不够
  // 时逐条让位，见下方试装）。
  const summaries: Array<{ anchor: string; text: string }> = [];

  // 配方清单独立成块（1.2.6 截断顺序：超顶时先丢摘要、再丢本块清单行，
  // 具名环境条目保到最后——见函数尾部注释）。
  const recipeBlock: string[] = [];

  if (validRecipes.length > 0) {
    recipeBlock.push('环境类型（人侧 zhishi env up <id> 开出——你在通道内够不到 CLI，需要哪类说明请人开出；工具在环境里开箱即用；「工作流摘要」= 配方 SKILL.md 正文提炼，全文在配方目录 SKILL.md）：');
    for (const recipe of validRecipes) {
      const tools = recipe.tools.length > 0 ? recipe.tools.join('、') : '（未声明工具）';
      const line = `- ${recipe.id}（${recipe.base ?? '?'}）：${tools}`;
      recipeBlock.push(line);
      // recipes.ts 已按 RECIPE_WORKFLOW_SUMMARY_MAX_CHARS 截断；无摘要不出行。
      if (recipe.workflowSummary) {
        summaries.push({ anchor: line, text: `  工作流摘要：${recipe.workflowSummary}` });
      }
    }
  }

  const envBlock: string[] = [];

  if (environments.length > 0) {
    envBlock.push('具名环境（人侧 zhishi env open <id> 接入；类型绑定 = 该环境带哪些工具）：');
    for (const entry of environments) {
      // 老条目的 name 可能是 "pwn-vm（pwn-vm）" 形态——以 id 开头就不再包一层。
      const label = entry.name && entry.name !== entry.id && !entry.name.startsWith(entry.id)
        ? `${entry.id}（${entry.name}）`
        : entry.id;
      // 配方绑定：recipeIds（1.3.8 多配方集合）∪ recipeId 优先，回落
      // id/vmName 同名配方（老条目）。绑定=展示/构建来源，工具并集。
      const boundRecipeIds = new Set<string>([
        ...(entry.recipeIds ?? []),
        ...(entry.recipeId ? [entry.recipeId] : []),
        entry.id,
        ...(entry.vmName ? [entry.vmName] : []),
      ]);
      const boundRecipes = validRecipes.filter((r) => boundRecipeIds.has(r.id));
      const binding = boundRecipes.length > 0
        ? `（类型 ${boundRecipes.map((r) => r.id).join('+')}：${[
            ...new Set(boundRecipes.flatMap((r) => r.tools)),
          ].join('、')}）`
        : '（无类型绑定——手动接入/旧条目）';
      // 1.3.7 场景 3：条目带现场推导的能力集合时透明展示（推导，非声明）。
      const capNote = entry.capabilityDomains?.length
        ? `；能力：${entry.capabilityDomains.join('·')}`
        : '';
      envBlock.push(`- ${label} → ${envTagForEntry(entry)}${binding}${capNote}`);
    }
  }

  const render = (ls: string[]) => `<zhishi-capabilities>
这台机器上实际可用的研究环境（事实源：环境引擎探测 + 环境类型清单 + 具名环境注册表，会话启动时刷新）：
${ls.join('\n')}
</zhishi-capabilities>`;

  const renderAll = (recipes: string[]) => render([...lines, ...recipes, ...envBlock]);

  // 摘要逐条试装：装进「硬顶 − 截断标记」预算内的插到各自配方行后；
  // 装不下的丢弃并显式声明（丢弃可观测，不静默——与截断标记同一纪律）。
  if (summaries.length > 0) {
    const budget = SECURITY_CAPABILITIES_MAX_CHARS - TRUNCATION_MARKER.length;
    const fitted = [...recipeBlock];
    let dropped = 0;
    for (const { anchor, text } of summaries) {
      const idx = fitted.indexOf(anchor);
      if (idx === -1) continue;
      const next = [...fitted.slice(0, idx + 1), text, ...fitted.slice(idx + 1)];
      if (renderAll(next).length <= budget) {
        fitted.splice(idx + 1, 0, text);
      } else {
        dropped += 1;
      }
    }
    if (dropped > 0) {
      fitted.push(`（另有 ${dropped} 个环境类型的工作流摘要因预算未注入——全文在配方目录 SKILL.md）`);
    }
    recipeBlock.length = 0;
    recipeBlock.push(...fitted);
  }

  // 截断顺序第二档（1.2.6）：试装后仍超预算时，从配方清单块尾部整行让位
  // （环境类型清单是发现环的入口提示，具名环境条目才是现场事实——先丢
  // 配方行，环境条目保到最后；丢弃显式声明，不静默）。
  {
    const budget = SECURITY_CAPABILITIES_MAX_CHARS - TRUNCATION_MARKER.length;
    let droppedLines = 0;
    // 丢弃声明本身占预算——让位判定要把声明算进去，否则声明把环境条目
    // 顶进 hardCapLines 的尾部丢弃区（恰恰违反本档要保的东西）。
    const withDropNote = () => droppedLines > 0
      ? [...recipeBlock, `（另有 ${droppedLines} 行环境类型清单因预算未注入——全文在配方目录 SKILL.md）`]
      : recipeBlock;
    while (recipeBlock.length > 0 && renderAll(withDropNote()).length > budget) {
      recipeBlock.pop();
      droppedLines += 1;
    }
    const finalBlock = [...withDropNote()];
    recipeBlock.length = 0;
    recipeBlock.push(...finalBlock);
  }

  // 兜底硬顶：走到这说明连「头 + 具名环境」都装不下——环境条目从尾部整行
  // 让位（它们已是最后才被丢的内容）。
  return hardCapLines(renderAll(recipeBlock), SECURITY_CAPABILITIES_MAX_CHARS);
}

// ===== 段 4：<zhishi-research-log>（静态，D1 研究成败信号教学） =====

const TMPL_RESEARCH_LOG = `<zhishi-research-log>
研究成败记录（蒸馏原料）：拿到 flag / 确认根因 / fuzz 出独有崩溃 / 研判完成 / 放弃时各落一条。**agent 用 loop 的 research_log 工具落库**——别在环境里跑 zhishi CLI（够不到）。
task_kind：binary / pentest / ai-security / redteam / malware / intel / ctf；outcome：success / fail / stuck；bug_class（可空）：stack-overflow / heap-overflow / uaf / double-free / oob-read / oob-write / null-deref / int-overflow / format-string / type-confusion / other；summary 一句话。
引用口径：研究事件编号写作 E#N（如 E#6）——与档案实体（H#/V#/C#/Q#）和其他编号区分，别混用。
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
 * 分节体按域过滤（1.2.4）：保留「### 域：<task_kind>」中匹配当前会话域的
 * 子节，以及没有任何域标题的跨域通用行（ preamble ）；其余域的子节整块
 * 去掉（做 binary 任务时 pentest 经验不进 prompt 挤预算）。
 * 过滤后只剩空白 → 返回 ''（调用方按零注入处理该分节）。
 */
function filterSectionByDomain(body: string, domain: string): string {
  const kept: string[] = [];
  let keep = true; // 第一个「### 域」之前的行 = 跨域通用部分
  for (const line of body.split('\n')) {
    const m = /^###\s*域：(.+?)\s*$/.exec(line);
    if (m) {
      // ctf 子节视同跨域通用：kernel 的产品定位是「CTF 是所有域的补充场景，
      // 任何环境按需适配」，ctf 经验对任何当前域都有参考价值（也保住既有
      // 行为：binary 会话里 ctf-only 的研究记忆照常注入）。
      keep = m[1] === domain || m[1] === 'ctf';
      if (keep) kept.push(line); // 命中的域标题保留（结构可辨）
      continue;
    }
    if (keep) kept.push(line);
  }
  return kept.join('\n').trim();
}

export interface ResearchMemorySectionOptions {
  /**
   * 当前会话的研究域（1.2.4，调用方经 resolveSessionResearchDomain 从现场
   * 选择/环境配方绑定推导）。提供时按域过滤；undefined = 无可靠域信号
   * （host 现场等），降级为全量注入——宁多勿缺。
   */
  domain?: ResearchTaskKind;
}

/**
 * 组装 `<zhishi-research-memory>` 段——安全蒸馏弧（D3）产物的反喂注入，
 * 蒸馏闭环的最后一环：研究成败记录（D1）→ 安全蒸馏弧（D3）→ 反喂进
 * security 场景的 system prompt（本段）。
 *
 * 按「成功路径 / 失败根因 / 工具组合」三分节呈现；蒸馏产物节内的
 * 「### 域：<task_kind>」分组原样保留（经验不跨域混压的呈现侧）；给定
 * 会话域时按域过滤（1.2.4，见 filterSectionByDomain）。
 * 零注入：数据缺失或三分节（过滤后）全空 → 返回 ''。硬顶
 * RESEARCH_MEMORY_MAX_CHARS（整行截断 + 截断标记——丢弃可观测）。
 */
export function buildResearchMemorySection(
  memory: ResearchDistilledMemory | undefined,
  opts: ResearchMemorySectionOptions = {},
): string {
  if (!memory) return '';
  const filter = (body: string): string =>
    opts.domain ? filterSectionByDomain(body, opts.domain) : body.trim();
  const parts: string[] = [];
  const successPaths = filter(memory.successPaths);
  const failureRoots = filter(memory.failureRoots);
  const toolCombos = filter(memory.toolCombos);
  if (successPaths) parts.push(`## 成功路径\n${successPaths}`);
  if (failureRoots) parts.push(`## 失败根因\n${failureRoots}`);
  if (toolCombos) parts.push(`## 工具组合\n${toolCombos}`);
  if (parts.length === 0) return '';
  const body = `<zhishi-research-memory>
以下是安全蒸馏弧从你的研究成败记录里定期沉淀的分域经验（按研究域分组${opts.domain ? `，已按当前会话域 ${opts.domain} 过滤；条目尾部标注日期/来源/适用环境` : '；条目尾部标注日期/来源/适用环境'}）——上手新任务前先据此校准打法：复用已验证的成功路径与工具组合，别重蹈已标记的死路。
${parts.join('\n\n')}
</zhishi-research-memory>`;
  return hardCapLines(body, RESEARCH_MEMORY_MAX_CHARS, RESEARCH_MEMORY_TRUNCATION_MARKER);
}

// ===== 会话域推导（1.2.4 域过滤的信号源） =====

/** 域清单的进程内缓存（bundled-domains 只在升级时变，会话期不变）。 */
let domainManifestsCache: DomainManifest[] | null = null;
/**
 * 从能力清单数据推导当前会话的研究域（research task_kind）。信号链：
 * 现场选择（T4）→ 具名环境的配方绑定（recipeId，回落 id/vmName 同名配方，
 * 与 buildSecurityCapabilitiesSection 同一规则）→ bundled-domains/domain.json
 * 的 recipes 列表反查域（域清单的 kind 即 research task_kind）。
 *
 * 1.3.7 场景 3 基线优先：选中环境的条目带现场推导能力集合
 * （capabilityDomains）时，基线 = 集合首个 research 域（绑定域恒在集合
 * 首位——探测合并规则保序）；无能力字段（存量环境零迁移）→ 旧 recipeId 链。
 *
 * 无可靠信号 → undefined（host 现场 / 无配方绑定 / 域清单未覆盖该配方），
 * 调用方降级为全量注入——域过滤是预算优化，不是正确性闸门，宁多勿缺。
 */
export function resolveSessionResearchDomain(
  data: SecurityCapabilitiesData | undefined,
  manifests?: DomainManifest[],
): ResearchTaskKind | undefined {
  const sel = data?.selection;
  if (!sel) return undefined;
  const candidates: string[] = [];
  if (sel.kind === 'recipe') {
    // 能力集合基线（1.3.7）：实例已登记且推导过能力 → 集合首个 research 域。
    const entry = findEnvironmentEntry(data?.environments ?? [], sel.instanceId);
    const capBaseline = entry?.capabilityDomains?.find((d) => isResearchTaskKind(d));
    if (capBaseline) return capBaseline;
    candidates.push(sel.name);
  } else if (sel.kind === 'env') {
    const entry = findEnvironmentEntry(data?.environments ?? [], sel.id);
    if (!entry) return undefined;
    // 能力集合基线（1.3.7）：条目带 capabilityDomains → 集合首个 research 域。
    const capBaseline = entry.capabilityDomains?.find((d) => isResearchTaskKind(d));
    if (capBaseline) return capBaseline;
    // 配方绑定：recipeId 优先，回落 id/vmName 同名配方（同 capabilities 段）。
    for (const c of [entry.recipeId, entry.id, entry.vmName]) {
      if (c) candidates.push(c);
    }
  } else {
    return undefined; // host 现场：无环境即无域信号
  }
  if (candidates.length === 0) return undefined;
  const list = manifests ?? (domainManifestsCache ??= loadDomainManifests());
  for (const m of list) {
    if (isResearchTaskKind(m.kind) && m.recipes.some((r) => candidates.includes(r))) {
      return m.kind;
    }
  }
  return undefined;
}

// ===== 域动态修正（1.2.7 域边界：配方默认 + 内容信号动态修正） =====

/** 内容信号扫描的消息条数（从会话末尾取）。 */
export const DOMAIN_SIGNAL_RECENT_MESSAGES = 20;

/**
 * 域信号扫描消费的最小消息结构——只看 content，与 pi AgentMessage
 * 结构兼容（调用方直接传会话历史，无需转换）。role 仅为通过 TS 弱类型
 * 检查（AgentMessage 联合中 BashExecutionMessage 无 content 字段）。
 */
export interface DomainSignalMessage {
  role?: unknown;
  content?: unknown;
}

/**
 * 提取消息文本（与 loop/compaction.ts 的 messageText 同口径，本地一份
 * 避免 server → loop 的反向依赖）：字符串 content / text、thinking 块 /
 * toolCall 名+参数。
 */
function domainSignalMessageText(message: DomainSignalMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const b = block as Record<string, unknown>;
      if (typeof b.text === 'string') return b.text;
      if (typeof b.thinking === 'string') return b.thinking;
      if (b.type === 'toolCall') return `${String(b.name ?? '')} ${JSON.stringify(b.arguments ?? {})}`;
      return '';
    })
    .join('\n');
}

export interface ResolveSessionDomainOptions {
  /** 扫描的消息条数（从末尾取，默认 DOMAIN_SIGNAL_RECENT_MESSAGES）。 */
  recentMessages?: number;
}

/**
 * 会话域推导（1.2.7 域边界；1.4.3 归位：域=研究类型，只由任务内容判定）
 * 基线 = resolveSessionResearchDomain（配方→域弱先验，候选非裁决空间），
 * 内容信号动态修正——扫描最近 N 条消息文本，对每域统计其 domain.json
 * **signals（内容特征：任务性质词/方法特征/工具使用模式）**正则命中数；
 * 某域命中 ≥2 且严格多于其他所有域 → 强信号域。裁决：
 *
 *   - 无强信号 / 信号打平 / 无命中 → 维持基线（undefined = 全量，宁多勿缺——
 *     1.2.7 红线 #5：域过滤是预算优化，不是正确性闸门）；
 *   - 无基线（host 现场）且信号强 → 采用信号域；
 *   - 基线与信号域不同 → 信号足够强（≥3 且 ≥2 倍于基线域命中数）才改判，
 *     否则维持基线（配方默认是锚，零星命中不翻盘）。
 *
 * 1.4.3：移除 1.3.7「集合外不切」硬闸——环境工具面（capabilityDomains）
 * 只约束能力清单展示，不约束研究域裁决；auxSignals（产物指纹）不参与裁决。
 *
 * 纯函数；manifests 缺省走进程内缓存。
 */
export function resolveSessionDomain(
  messages: readonly DomainSignalMessage[],
  data: SecurityCapabilitiesData | undefined,
  manifests?: DomainManifest[],
  options: ResolveSessionDomainOptions = {},
): ResearchTaskKind | undefined {
  const list = manifests ?? (domainManifestsCache ??= loadDomainManifests());
  const baseline = resolveSessionResearchDomain(data, list);

  // 每域内容信号命中数（非法正则跳过——读侧容错，与 validateDomainManifest 同纪律）。
  const recent = messages.slice(-(options.recentMessages ?? DOMAIN_SIGNAL_RECENT_MESSAGES));
  const text = recent.map(domainSignalMessageText).join('\n');
  const counts = new Map<string, number>();
  for (const m of list) {
    if (!isResearchTaskKind(m.kind)) continue;
    let n = 0;
    for (const rule of m.signals) {
      try {
        n += text.match(new RegExp(rule.re, 'gi'))?.length ?? 0;
      } catch {
        /* 非法正则不计 */
      }
    }
    counts.set(m.kind, n);
  }

  // 强信号域：命中 ≥2 且严格多于其他所有域（打平不算强信号）。
  let signalDomain: ResearchTaskKind | undefined;
  let signalHits = 0;
  let runnerUpHits = 0;
  for (const [kind, n] of counts) {
    if (n > signalHits) {
      runnerUpHits = signalHits;
      signalHits = n;
      signalDomain = kind as ResearchTaskKind;
    } else if (n > runnerUpHits) {
      runnerUpHits = n;
    }
  }
  if (!signalDomain || signalHits < 2 || signalHits === runnerUpHits) {
    return baseline;
  }

  if (!baseline || signalDomain === baseline) return signalDomain ?? baseline;
  const baselineHits = counts.get(baseline) ?? 0;
  if (signalHits >= 3 && signalHits >= 2 * baselineHits) return signalDomain;
  return baseline;
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
  /**
   * judge 判错查证（1.2.4 D4 深化，recall judge 的 wrong 反馈接入注入侧）：
   * 返回 true 的分节本轮不注入。默认仅在 read 未注入时启用真实查证
   * （store.keyedDistilledEntryJudgedWrong）——注入自定义 read 的测试不碰库。
   */
  judgedWrong?: (kind: MemoryKind, storeKey: string, baseDir: string) => boolean;
}

/**
 * 采集研究记忆反喂数据源（D4）。只在 security 场景的会话启动路径调用——
 * 三次 keyed 条目查询（本地 db 小读），成本可忽略。三分节全空时
 * buildResearchMemorySection 零注入。
 *
 * 1.2.4 judge 降权：某分节的当前版本被 recall judge 判过 wrong（judge 结算
 * 存储在 recall_events + memories/archive，查证逻辑见 store.keyedDistilledEntryJudgedWrong）
 * 时，该分节本轮不注入——写错的经验持续反喂比缺经验更危险（框架 §3 罚重于奖
 * 的同一权衡）。降权不删库：下轮蒸馏修正内容后（content_key 变化）自动恢复注入。
 */
export function collectResearchMemory(deps: CollectResearchMemoryDeps = {}): ResearchDistilledMemory {
  const baseDir = deps.baseDir ?? getZhiShiDataDir();
  const memory = (deps.read ?? readResearchDistilled)(baseDir);
  const judgedWrong = deps.judgedWrong ?? (deps.read ? undefined : keyedDistilledEntryJudgedWrong);
  if (!judgedWrong) return memory;
  const out = { ...memory };
  for (const { key, kind, storeKey } of RESEARCH_DISTILL_SECTIONS) {
    if (!out[key].trim()) continue;
    try {
      if (judgedWrong(kind, storeKey, baseDir)) {
        console.warn(`[research-memory] 分节 ${key}（${storeKey}）曾被 recall judge 判 wrong，本轮不注入，待下轮蒸馏修正`);
        out[key] = '';
      }
    } catch (err) {
      // 查证失败不阻塞注入（降权是增强，不是闸门）。
      console.warn('[research-memory] judge 判错查证失败（按未判错处理）:', err instanceof Error ? err.message : err);
    }
  }
  return out;
}
