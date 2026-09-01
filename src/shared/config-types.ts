// Provider and permission configuration types



/**

 * Permission mode for agent behavior（1.5.4 起撤除 'plan'——无拦截实现，见 B7 决策）

 */

export type PermissionMode = 'auto' | 'fullAgency';



/**

 * Background-agent permission policy (issue #264).

 * - 'inherit'    — background (run_in_background) sub-agents inherit only the

 *                  user's session "always allow" grants; ungranted tools denied.

 * - 'fullAgency' — background lane fully autonomous (non-interaction tools allowed).

 * See src/server/utils/background-agent-permission.ts for the decision core.

 */

export type BackgroundAgentPermissionMode = 'inherit' | 'fullAgency';



/**

 * Model entity representing a single model configuration

 */

export interface ModelEntity {

  // === 核心字段（必填）===

  model: string;         // API 代码，如 "claude-sonnet-4-6"

  modelName: string;     // 显示名称，如 "Claude Sonnet 4.6"

  modelSeries: string;   // 品牌系列，如 "claude" | "deepseek" | "zhipu"



  // === 元数据字段（可选，API 发现时填充）===

  contextLength?: number;       // 上下文窗口（token 数）

  maxOutputTokens?: number;     // 最大输出 token 数

  inputModalities?: string[];   // 输入模态 ["text", "image", "video"]

  outputModalities?: string[];  // 输出模态 ["text"]



  // === 来源标记 ===

  source?: 'preset' | 'discovered' | 'manual';

}



/**

 * Model alias mapping for non-Anthropic providers.

 * Maps SDK model aliases (sonnet/opus/haiku) to provider-specific model IDs.

 * When Claude Agent SDK sub-agents use hardcoded model aliases like "haiku",

 * the bridge translates them to the actual provider model via this mapping.

 */

export interface ModelAliases {

  sonnet?: string;  // e.g., 'deepseek-chat'

  opus?: string;    // e.g., 'deepseek-reasoner'

  haiku?: string;   // e.g., 'deepseek-chat'

}



export interface ProviderOrderSettings {

  providerOrder?: string[];

  disabledProviderIds?: string[];

}



type ProviderOrderable = {

  id: string;

  enabled?: unknown;

};



export function normalizeProviderOrder(providerIds: string[], providerOrder?: string[]): string[] {

  const known = new Set(providerIds);

  const seen = new Set<string>();

  const ordered: string[] = [];



  for (const id of providerOrder ?? []) {

    if (!known.has(id) || seen.has(id)) continue;

    seen.add(id);

    ordered.push(id);

  }



  for (const id of providerIds) {

    if (seen.has(id)) continue;

    seen.add(id);

    ordered.push(id);

  }



  return ordered;

}



export function normalizeDisabledProviderIds(providerIds: string[], disabledProviderIds?: string[]): string[] {

  const known = new Set(providerIds);

  const seen = new Set<string>();

  const disabled: string[] = [];



  for (const id of disabledProviderIds ?? []) {

    if (!known.has(id) || seen.has(id)) continue;

    seen.add(id);

    disabled.push(id);

  }



  return disabled;

}



export function applyProviderEnablementAndOrder<T extends ProviderOrderable>(

  providers: T[],

  settings?: ProviderOrderSettings,

): T[] {

  const byId = new Map(providers.map(provider => [provider.id, provider] as const));

  const orderedIds = normalizeProviderOrder(providers.map(provider => provider.id), settings?.providerOrder);

  const disabled = new Set(normalizeDisabledProviderIds(orderedIds, settings?.disabledProviderIds));



  return orderedIds

    .map(id => {

      const provider = byId.get(id);

      if (!provider) return undefined;

      const nextEnabled = !disabled.has(id);

      if (provider.enabled === nextEnabled || (nextEnabled && provider.enabled === undefined)) {

        return provider;

      }

      return { ...provider, enabled: nextEnabled };

    })

    .filter((provider): provider is T => Boolean(provider));

}



export function isProviderEnabled(provider: { enabled?: unknown } | null | undefined): boolean {

  return provider?.enabled !== false;

}



/**

 * Authentication type for API providers

 * - 'auth_token': Only set ANTHROPIC_AUTH_TOKEN

 * - 'api_key': Only set ANTHROPIC_API_KEY

 * - 'both': Set both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY (default for backward compatibility)

 * - 'auth_token_clear_api_key': Set AUTH_TOKEN and explicitly clear API_KEY (required by OpenRouter)

 */

export type ProviderAuthType = 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';



/**

 * API protocol type for provider communication

 * - 'anthropic': Native Anthropic Messages API (default)

 * - 'openai': OpenAI Chat Completions / Responses API（pi 原生直连，无 bridge 回环）

 */

export type ApiProtocol = 'anthropic' | 'openai';



/**

 * Service provider configuration

 */

export interface Provider {

  id: string;

  name: string;

  vendor: string;           // 厂商名: 'Anthropic', 'DeepSeek', etc.

  cloudProvider: string;    // 云服务商: '模型官方', '云服务商', etc.

  type: 'api';

  primaryModel: string;     // 默认模型 API 代码

  isBuiltin: boolean;

  enabled?: boolean;        // Runtime-derived: false when globally disabled by the user



  // API 配置

  config: {

    baseUrl?: string;            // ANTHROPIC_BASE_URL

    timeout?: number;            // API_TIMEOUT_MS

    disableNonessential?: boolean; // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC

  };



  // 认证方式 (默认 'both' 以保持向后兼容)

  authType?: ProviderAuthType;



  // API 协议 (默认 'anthropic')

  apiProtocol?: ApiProtocol;



  // 上游 API 格式（仅 apiProtocol === 'openai' 时生效）

  // 'chat_completions' (默认): OpenAI Chat Completions API

  // 'responses': OpenAI Responses API

  upstreamFormat?: 'chat_completions' | 'responses';



  // 最大输出 token 数限制（仅 apiProtocol === 'openai' 时生效）

  // 有值时 Bridge 向上游注入此 token limit；空/undefined = 不发送

  maxOutputTokens?: number;

  // 上游 API 的 token limit 参数名（仅 apiProtocol === 'openai' 时生效）

  // 'max_tokens' (默认，兼容大多数 provider)

  // 'max_completion_tokens' (OpenAI o1/o3/GPT-5、vLLM、OpenRouter)

  // 'max_output_tokens' (OpenAI Responses API)

  maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';



  // 官网链接 (用于"去官网"入口)

  websiteUrl?: string;



  // 模型发现端点 URL（可选覆盖）

  // 默认推导：apiProtocol === 'openai' 且 baseUrl 以 /v1 结尾 → GET {baseUrl}/models
  // （OpenAI 格式端点自带版本前缀）；否则 → GET {baseUrl}/v1/models（anthropic 主机式 baseUrl）
  // 非标准路径（如 /api/paas/v4）显式声明本字段；deepseek 的 anthropic 兼容路径
  // 不支持 /v1/models，也经此字段指向其 OpenAI 路径

  modelListUrl?: string;



  // 模型列表 - 使用新的 ModelEntity 结构

  models: ModelEntity[];



  // SDK 模型别名映射（非 Anthropic provider 的子 Agent 模型重定向）

  // SDK 内置子 Agent (如 Explore) 会硬编码 model: "haiku"，通过此映射转为实际模型

  modelAliases?: ModelAliases;



  // 用户输入的 API Key (运行时填充，不持久化到 provider 定义)

  apiKey?: string;

}



/**

 * Project/workspace configuration

 */

export interface Project {

  id: string;

  name: string;

  path: string;

  lastOpened?: string;

  // Project-specific settings (null means use default)

  providerId: string | null;

  permissionMode: PermissionMode | null;

  model?: string | null;

  // Custom permission rules for 'custom' mode

  customPermissions?: {

    allow: string[];

    deny: string[];

  };

  /** Internal projects (e.g. ~/.zhishi diagnostic workspace) hidden from Launcher */

  internal?: boolean;

  /** Custom emoji icon for display, defaults to FolderOpen if absent */

  icon?: string;

  /** Custom display name, defaults to folder name extracted from path */

  displayName?: string;

  /** Whether this workspace has been upgraded to an Agent (v0.1.41) */

  isAgent?: boolean;

  /** Associated Agent ID when isAgent=true (v0.1.41) */

  agentId?: string;

  /** Source template ID used when this workspace was created from a template. */

  templateId?: string;

  /** Template source. Built-in templates can carry product-level Agent defaults. */

  templateSource?: 'builtin' | 'user';

}







/**

 * Provider verification status (with expiry support)

 */

export interface ProviderVerifyStatus {

  status: 'valid' | 'invalid';

  verifiedAt: string; // ISO timestamp

  accountEmail?: string; // Optional account identifier for cache invalidation

}



/**

 * Network proxy protocol type

 */

export type ProxyProtocol = 'http' | 'socks5';



/**

 * Network proxy settings (General settings)

 */

export interface ProxySettings {

  enabled: boolean;

  protocol: ProxyProtocol;

  host: string;

  port: number;

}



export interface AppConfig {

  // Default settings for new projects

  defaultProviderId?: string;

  /** 默认模型（设置-模型配置的「默认模型」选择器）：后台任务（蒸馏弧/定时任务/IM）
   *  在没有会话模型时的显式选择，与 defaultProviderId 配套使用。 */
  defaultModelId?: string;

  /** M4b — 聊天会话引擎:'pi'(自研 loop,src/server/loop)。M4c 起 SDK
   *  引擎已删除,此项仅为兼容保留:'sdk' 值被忽略(告警并回落 pi)。
   *  ZHISHI_LOOP_ENGINE 环境变量优先于此项。 */
  loopEngine?: 'sdk' | 'pi';

  defaultPermissionMode: PermissionMode;

  // Background-agent permission policy (issue #264). Controls what a

  // `run_in_background` sub-agent may do when it hits a tool the SDK can't

  // auto-resolve. 'inherit' (default) = background agents inherit only the

  // user's session "always allow" grants, ungranted tools are denied with a

  // clear message; 'fullAgency' = background lane is fully autonomous (every

  // non-interaction tool allowed). Omitted/undefined ⇒ treated as 'inherit'.

  backgroundAgentPermissionMode?: BackgroundAgentPermissionMode;

  // UI preferences

  theme: 'light' | 'dark' | 'system';

  /** UI 语言（i18n 架构 §1）：'system' = 跟随 OS locale（zh* → zh-CN，其余 → en-US）。
   *  缺省视同 'system'，老配置无此字段。Rust 侧为 owner（cmd_set_ui_language 写盘 +
   *  emit ui-language-changed），renderer 经 cmd_get_ui_language_state 读取。 */
  uiLanguage?: 'system' | 'zh-CN' | 'en-US';

  minimizeToTray: boolean;

  /** 对话输入框发送键偏好。缺省视同 'enter'（Enter 发送，Shift+Enter 换行）。

   *  'modEnter' 则 ⌘/Ctrl+Enter 发送、Enter 换行。统一作用于全部"和 AI 对话"的

   *  输入：主对话框 / AI 小助理 / 问题反馈（见 utils/chatSendKey.ts）。 */

  chatSendShortcut?: 'enter' | 'modEnter';

  showDevTools: boolean; // 显示开发者工具 (Logs/System Info)

  multiAgentRuntime?: boolean; // 多 Agent Runtime 模式（开发者，默认关闭）

  experimentalSplitView?: boolean; // 实验性：文件预览在右侧分屏而非弹窗

  /** 开发者：定期从 LiteLLM (GitHub) 拉取 model_prices_and_context_window.json，

   *  作为模型 contextLength/maxOutputTokens 的最低优先级兜底数据源。缺省视同 true。

   *  抓取在 Rust 侧（启动条件检查 + 24h interval，ETag/If-None-Match 增量）。 */

  liteLLMModelDataRefresh?: boolean;

  /** 开发者：fork 走 SDK 独立 `forkSession()` 急切分叉（SDK↔SDK uuid 重映射），

   *  而非旧的 forkFrom 懒分叉状态机。缺省视同 true（默认开）；关掉则回退旧路径。

   *  详见 specs/prd/prd_0.2.27_fork_standalone_migration.md。 */

  eagerFork?: boolean;

  /** 开发者：传给 Claude 智能体 SDK `settings.cleanupPeriodDays` 的本地 transcript 保留天数。

   *  缺省视同 365，最小 1。 */

  claudeTranscriptCleanupPeriodDays?: number;

  /** 记忆子系统（工作生命宪章第七章）。 */

  memory?: {

    /** 蒸馏弧（§4.2）：定期把原始工作史压成蒸馏认知（~/.zhishi/memory/distilled/）。

     *  `enabled` 缺省视同 true；置 false 后不再播种/执行蒸馏，已有蒸馏文件保留。 */

    distill?: {

      enabled?: boolean;

    };

  };

  /** 情报横切（1.1.2）：NVD + exploit-db 本地索引。存储见 ~/.zhishi/intel.db，
   *  更新走 `zhishi intel update`，检索经 loop 的 intel_search 工具。
   *  分级：minimal 只存核心字段按大小裁剪 / window 保留最近 N 年 /
   *  full 全量（maxSizeMb 兜底）。缺省 INTEL_DEFAULTS。 */

  intel?: IntelConfig;

  // General settings

  autoStart: boolean; // 开机启动

  /** PRD 0.2.16 全局唤起快捷键。缺省视同 enabled=true + 默认键。

   *  accelerator 形如 'CmdOrCtrl+Shift+M'（Tauri accelerator 语法）。 */

  globalSummonShortcut?: {

    enabled: boolean;

    accelerator: string;

  };

  // OS-level desktop notifications. When false, ALL notification trigger

  // points are suppressed at the Rust entry point (cron complete, task

  // complete, AI turn complete, permission request, ask-user-question,

  // plan-mode review). Renamed from `cronNotifications` in 0.2.14 — the

  // legacy name was misleading because only one of the six triggers is

  // cron-related; the toggle was decorative until 0.2.14 wired it up.

  osNotifications: boolean;

  notificationSound: boolean; // 通知提醒声音（OS 通知是否播放声音）

  // API Keys for providers (stored separately for security)

  providerApiKeys?: Record<string, string>;

  // Provider verification status (persisted after API key validation)

  // Key is provider ID (e.g., 'anthropic-api', 'deepseek')

  providerVerifyStatus?: Record<string, ProviderVerifyStatus>;



  // ===== Provider Custom Models =====

  // User-added custom models for preset providers (key = provider ID)

  // These are merged with preset models at runtime, allowing users to add models

  // while keeping preset definitions unchanged (updated with app releases)

  presetCustomModels?: Record<string, ModelEntity[]>;

  // Preset models explicitly removed by user (key = provider ID, value = model IDs)

  // App upgrades won't re-add these; new models NOT in this list appear automatically

  presetRemovedModels?: Record<string, string[]>;



  // ===== Provider Primary Model (user overrides) =====

  // Maps provider ID → user's preferred primary model (overrides preset primaryModel)

  providerPrimaryModels?: Record<string, string>;



  // ===== Provider Model Aliases (user overrides) =====

  // Maps provider ID → user-configured model alias overrides (merged with preset defaults)

  providerModelAliases?: Record<string, ModelAliases>;



  // ===== Provider Enablement / Ordering =====

  // Provider IDs in user-defined display/fallback order.

  providerOrder?: string[];

  // Provider IDs hidden from selectors and runtime resolution without deleting their settings.

  disabledProviderIds?: string[];




  // ===== Network Proxy (General) =====

  // HTTP/SOCKS5 proxy settings for external network requests

  proxySettings?: ProxySettings;



  // ===== Default Workspace =====

  // Path to the default workspace shown on Launcher

  defaultWorkspacePath?: string;



  // ===== Launcher Last-Used Settings =====

  // Persisted on send from Launcher, restored on next app launch

  // Note: workspace is NOT included — always uses defaultWorkspacePath

  launcherLastUsed?: {

    providerId?: string;

    model?: string;

    permissionMode?: PermissionMode;

  };



  // ===== Agent Configuration (v0.1.41) =====

  agents?: import('./types/agent').AgentConfig[];



  // ===== Customer Service Backend =====

  customerService?: {

    baseUrl: string;

    apiKey?: string;

    enabled?: boolean;

  };



  // ===== Named execution environments (安全研究员版 P1 E3) =====

  /** 具名环境清单（`zhishi env list/add/remove/open`）。缺省视同 []——
   *  老配置无此字段。凭据规则（D-T4）：只存 keyPath 引用，不存密码。 */

  environments?: EnvironmentEntry[];

  /** VM 模板清单（P2 V6 `zhishi env adopt` 的产出）：recipeId → 模板。
   *  env up 的 vmBase 解析顺序：--vm-base 旗标 > 本表（adopt 产出，已验
   *  证已供应）> 配方 frontmatter vm_base。凭据同样只存 keyPath 引用。 */

  vmTemplates?: Record<string, VmTemplateEntry>;



}



/** 情报索引分级（1.1.2）：minimal 只存核心字段按大小裁剪 / window 保留最近

 *  windowYears 年 / full 全量（maxSizeMb 兜底）。 */

export type IntelMode = 'minimal' | 'window' | 'full';



/** config.json::intel（1.1.2 情报横切）。全部字段可缺省——resolveIntelConfig

 *  合并 INTEL_DEFAULTS。 */

export interface IntelConfig {

  /** 存储分级。缺省 'minimal'。 */

  mode?: IntelMode;

  /** window 模式保留年数。缺省 3。 */

  windowYears?: number;

  /** intel.db 大小上限（MB），update 末尾自适应裁剪。缺省 300。 */

  maxSizeMb?: number;

  /** intel_search 未命中时是否在线回源 NVD（5s 超时、失败静默降级）。

   *  缺省 true。 */

  onlineFallback?: boolean;

}



/** intel 配置缺省值（分级设计定稿：minimal / 3 年 / 300MB）。 */

export const INTEL_DEFAULTS: Required<IntelConfig> = {

  mode: 'minimal',

  windowYears: 3,

  maxSizeMb: 300,

  onlineFallback: true,

};



/** 合并缺省值；非法值回落缺省（配置来自用户可编辑的 config.json，容错优先）。 */

export function resolveIntelConfig(cfg?: IntelConfig): Required<IntelConfig> {

  const mode = cfg?.mode === 'window' || cfg?.mode === 'full' || cfg?.mode === 'minimal'

    ? cfg.mode

    : INTEL_DEFAULTS.mode;

  const windowYears = typeof cfg?.windowYears === 'number' && Number.isFinite(cfg.windowYears) && cfg.windowYears > 0

    ? cfg.windowYears

    : INTEL_DEFAULTS.windowYears;

  const maxSizeMb = typeof cfg?.maxSizeMb === 'number' && Number.isFinite(cfg.maxSizeMb) && cfg.maxSizeMb > 0

    ? cfg.maxSizeMb

    : INTEL_DEFAULTS.maxSizeMb;

  const onlineFallback = typeof cfg?.onlineFallback === 'boolean' ? cfg.onlineFallback : INTEL_DEFAULTS.onlineFallback;

  return { mode, windowYears, maxSizeMb, onlineFallback };

}


/** VM 模板条目（config.json::vmTemplates，P2 V6）。 */

export interface VmTemplateEntry {
  /** 模板 .vmx 绝对路径。 */
  vmx: string;
  /** guest 内 zhishi 运维用户。 */
  user: string;
  /** 私钥路径引用（D-T4）。 */
  keyPath: string;
  /** 干净现场快照名。 */
  snapshot: string;
  /** guest 密码外部引用(D-T4,如 env:ZHISHI_VM_PW)——断网隔离场景
   *  guest-exec 通道(vmrun 只认密码)的凭据来源。 */
  passwordRef?: string;
  createdAt: string;
}



/** 环境条目 kind：ssh=远程主机；docker=本地容器；vm=hypervisor 虚拟机。 */

export type EnvironmentKind = 'ssh' | 'docker' | 'vm';



/** 具名环境条目（config.json::environments）。
 *
 *  - `ssh`：必填 host；可选 user / keyPath → `ssh [-i keyPath] [user@]host`
 *  - `docker`：必填 container → `docker exec -it <container> bash`
 *  - `vm`：必填 vmName（1.3.7「实例即环境」：条目 id 恒 = vmName）；
 *    可选 address / user / keyPath——有 address 时按 ssh
 *    接入，无 address 时 open 报错指向 guest-exec 通道（P2 B2 `zhishi env exec`）。
 *
 *  凭据规则（D-T4）：只存 keyPath（私钥路径引用），不存密码。 */

export interface EnvironmentEntry {

  id: string;

  kind: EnvironmentKind;

  name?: string;

  /** ssh：目标主机（必填）。 */

  host?: string;

  /** docker：容器名/id（必填）。 */

  container?: string;

  /** vm：hypervisor 内 VM 名（必填）。 */

  vmName?: string;

  /** vm：可达地址；缺省时 open 报错指向 guest-exec 通道（P2 B2）。 */

  address?: string;

  /** vm：.vmx 定位辅助（vmware 直连 VM 的 down/rm/ps/快照/回滚 解析锚；
   *  1.3.7「实例即环境」起不再决定 id 语义——id 恒为 VM 实例名 vmName；
   *  缺省时由 resolveVmxForEntry 回落 vmName→vmTemplates 探测）。 */

  vmx?: string;

  /** ssh / vm：SSH 端口；缺省 22（P2 B5：非标端口支持）。 */

  port?: number;

  user?: string;

  /** 私钥路径引用（D-T4：不存密码）。 */

  keyPath?: string;

  /** guest 密码的外部引用（D-T4：不存密码本体）——断网隔离 VM 的
   *  guest-exec 通道（vmrun 只认密码认证）用。v1 形态:`env:VAR_NAME`
   *  (从宿主环境变量现场取,不落盘)。wincred/1Password 引用形态待评估。 */

  passwordRef?: string;

  /** guest OS 家族（OS 抽象层，二进制/恶意软件域的 Windows 执行面）：
   *  linux=sh 包装（缺省，存量条目不写即此） / windows=powershell 包装。
   *  adopt 探测写入；手工登记（environment/add）可显式给。 */

  osFamily?: 'linux' | 'windows';

  /** 配方工具自检结果（env up 构建后跑一次；domain check 可刷新）。
   *  声明了但环境里没有的工具 = 能力清单与现场漂移的证据。 */

  toolCheck?: { ok: boolean; missing: string[]; checkedAt: string };

  /** 配方绑定：本环境出自哪个配方（up/adopt 写入；display 层查找时
   *  缺省回落到 id/vmName 同名配方——正门详情与能力清单段的展示源）。 */

  recipeId?: string;

  /** 多配方绑定集合（1.3.8 关联侧）：含主配方（recipeId 恒在集合内，不可
   *  单独移除）。绑定=展示/构建来源，**不进域裁决**（能力集合=推导唯一真相源，
   *  见 capabilityDomains）。缺省时等价 [recipeId]。消费面：能力清单段工具
   *  并集与漂移报告覆盖集合、GUI 环境详情模态的绑定管理。 */

  recipeIds?: string[];

  /** 能力域集合（1.3.7 场景 3，B 方案纯系统推导）：配方绑定域 ∪ 工具探测域
   *  （环境里实际装了哪些已知工具 → 工具→配方→域反推）。服务端派生字段，
   *  非用户编辑；探测失败时不写（保 baseline 行为），绝不落空集合。
   *
   *  1.4.3 概念归位：本字段是**工具面标签**（这台环境能干什么），不是研究域
   *  裁决依据——研究域只由任务内容判定（resolveSessionDomain 内容信号）。
   *  消费面：能力清单段工具并集展示（filterKinds）+ resolveSessionResearchDomain
   *  弱先验基线（[0]）+ GUI 能力徽章；不参与裁决空间收窄（集合外不切已移除）。 */

  capabilityDomains?: string[];

  /** capabilityDomains 的推导时间（ISO 时间戳，server 侧探测完成时盖章）。 */

  capabilityDerivedAt?: string;

  /** 能力探测的 MISS 清单（1.4.9：探测面中声明了但环境里没有的工具，
   *  全集落盘——展示侧按「集合内配方工具并集」过滤）。与 capabilityDomains
   *  同次探测产出、同探测时间戳；探测失败时不写（保留旧值）。此前 MISS
   *  只在 env up 的 toolCheck 里落盘，adopt 环境永远看不到缺失——模型把
   *  配方声明当在场证据（1.4.8 实机事故）。 */

  capabilityMissing?: string[];

  /** 已登记待装工具（1.5.7）：配方 firstRunTools 声明「首跑安装」、探测
   *  未命中的工具——容器首跑钩子（/opt/zhishi/first-run.sh）正在后台装。
   *  pending 工具不进 missing 双计数（capabilityMissing 与
   *  capabilityMissingInScope 都会减去）；重推/setup 闭环探测命中时摘除
   *  （空则删字段）。与 capabilityMissing 同一纪律：探测失败不动本字段。 */

  capabilityPending?: string[];

  /** ISO 时间戳，server 侧写入时盖章。 */

  createdAt: string;

}



// Preset providers with ModelEntity structure

/** Anthropic 官方预设模型（订阅和 API 共用）

 *  contextLength / maxOutputTokens：来源 LiteLLM model_prices_and_context_window.json (2026-04)

 *  inputModalities：来源 OpenRouter `architecture.input_modalities` (2026-04 验证)

 *  Sonnet/Opus 4.x 系列支持 1M 上下文（带 [1m] suffix / context-1m beta header 时启用） */

const ANTHROPIC_MODELS: ModelEntity[] = [

  // contextLength: Anthropic Sonnet 4.6 wire-default is 200K. The 1M tier requires

  // the `context-1m-2025-08-07` beta header AND either Tier-4 API spend OR a paid

  // "extra usage" toggle on subscription plans. Defaulting to 1M here forced the

  // SDK's `[1m]` 1M code path for everyone, and subscription users hit

  // `Extra usage is required for 1M context · enable extra usage at

  // claude.ai/settings/usage, or use --model to switch to standard context`

  // on every turn (reproduced 2026-05-07). Opus 4.x stays at 1M because

  // Anthropic enables 1M-by-default on Opus subscription tiers.

  { model: 'claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6', modelSeries: 'claude', contextLength: 200_000, maxOutputTokens: 64_000, inputModalities: ['text', 'image'] },

  { model: 'claude-opus-4-8', modelName: 'Claude Opus 4.8', modelSeries: 'claude', contextLength: 1_000_000, maxOutputTokens: 128_000, inputModalities: ['text', 'image'] },

  { model: 'claude-opus-4-7', modelName: 'Claude Opus 4.7', modelSeries: 'claude', contextLength: 1_000_000, maxOutputTokens: 128_000, inputModalities: ['text', 'image'] },

  { model: 'claude-opus-4-6', modelName: 'Claude Opus 4.6', modelSeries: 'claude', contextLength: 1_000_000, maxOutputTokens: 128_000, inputModalities: ['text', 'image'] },

  { model: 'claude-haiku-4-5', modelName: 'Claude Haiku 4.5', modelSeries: 'claude', contextLength: 200_000, maxOutputTokens: 64_000, inputModalities: ['text', 'image'] },

];



/** Anthropic 官方默认别名（对齐 SDK 0.3.158 内置默认：opus48/sonnet46/haiku45）。

 *  显式 pin 可避免未来 SDK 默认变动时用户体验突变。 */

const ANTHROPIC_ALIASES = {

  sonnet: 'claude-sonnet-4-6',

  opus: 'claude-opus-4-8',

  haiku: 'claude-haiku-4-5',

} as const;



export const PRESET_PROVIDERS: Provider[] = [

  {

    id: 'anthropic-api',

    name: 'Anthropic (API)',

    vendor: 'Anthropic',

    cloudProvider: '官方',

    type: 'api',

    primaryModel: 'claude-sonnet-4-6',

    isBuiltin: true,

    authType: 'both',

    config: {

      baseUrl: 'https://api.anthropic.com',

    },

    modelAliases: { ...ANTHROPIC_ALIASES },

    models: ANTHROPIC_MODELS,

  },

  {

    id: 'deepseek',

    name: 'DeepSeek',

    vendor: 'DeepSeek',

    cloudProvider: '模型官方',

    type: 'api',

    primaryModel: 'deepseek-v4-pro',

    isBuiltin: true,

    authType: 'auth_token',

    websiteUrl: 'https://platform.deepseek.com',

    modelListUrl: 'https://api.deepseek.com/v1/models',

    config: {

      baseUrl: 'https://api.deepseek.com/anthropic',

      timeout: 600000,

      disableNonessential: true,

    },

    modelAliases: { sonnet: 'deepseek-v4-pro', opus: 'deepseek-v4-pro', haiku: 'deepseek-v4-flash' },

    models: [

      // DeepSeek V4 系纯文本；视觉能力在独立的 DeepSeek-VL2 / Janus 模型族。

      // deepseek-chat / deepseek-reasoner 已退化为 v4-flash 的别名且 2026-07-24 硬下线，故移除。

      { model: 'deepseek-v4-pro', modelName: 'DeepSeek V4 Pro', modelSeries: 'deepseek', contextLength: 1_000_000, maxOutputTokens: 384_000, inputModalities: ['text'] },

      { model: 'deepseek-v4-flash', modelName: 'DeepSeek V4 Flash', modelSeries: 'deepseek', contextLength: 1_000_000, maxOutputTokens: 384_000, inputModalities: ['text'] },

    ],

  },

  // ===== 多模型接入（M4d）—— OpenAI 格式内置供应商 =====
  // 共同点：apiProtocol 'openai' → pi 原生走 openai-completions（model.api 显式选择，
  // 非 baseUrl 探测）；authType 'auth_token' → Authorization: Bearer；
  // modelListUrl = {baseUrl}/models，set-key 后自动拉取目录并入 presetCustomModels。

  {
    id: 'openai',

    name: 'OpenAI',

    vendor: 'OpenAI',

    cloudProvider: '模型官方',

    type: 'api',

    primaryModel: 'gpt-5.4',

    isBuiltin: true,

    authType: 'auth_token',

    apiProtocol: 'openai',

    websiteUrl: 'https://platform.openai.com',

    modelListUrl: 'https://api.openai.com/v1/models',

    config: {

      baseUrl: 'https://api.openai.com/v1',

      timeout: 600000,

    },

    modelAliases: { sonnet: 'gpt-5.4', opus: 'gpt-5.4', haiku: 'gpt-5.4-mini' },

    models: [

      // GPT-5 系多模态（text+image）；上下文 400K / 输出 128K 为 5.x 通用口径。

      { model: 'gpt-5.4', modelName: 'GPT-5.4', modelSeries: 'gpt', contextLength: 400_000, maxOutputTokens: 128_000, inputModalities: ['text', 'image'] },

      { model: 'gpt-5.4-mini', modelName: 'GPT-5.4 mini', modelSeries: 'gpt', contextLength: 400_000, maxOutputTokens: 128_000, inputModalities: ['text', 'image'] },

      { model: 'gpt-5.4-nano', modelName: 'GPT-5.4 nano', modelSeries: 'gpt', contextLength: 400_000, maxOutputTokens: 128_000, inputModalities: ['text', 'image'] },

    ],

  },

  {
    id: 'moonshot',

    name: 'Kimi (Moonshot)',

    vendor: 'Moonshot AI',

    cloudProvider: '模型官方',

    type: 'api',

    primaryModel: 'kimi-k2-0905-preview',

    isBuiltin: true,

    authType: 'auth_token',

    apiProtocol: 'openai',

    websiteUrl: 'https://platform.moonshot.cn',

    modelListUrl: 'https://api.moonshot.cn/v1/models',

    config: {

      baseUrl: 'https://api.moonshot.cn/v1',

      timeout: 600000,

    },

    modelAliases: { sonnet: 'kimi-k2-0905-preview', opus: 'kimi-k2-0905-preview', haiku: 'kimi-k2-turbo-preview' },

    models: [

      // K2 系纯文本；注意与 pi 内置 kimiCodingProvider（api.kimi.com/coding，anthropic 协议）
      // 区分：本预设走 api.moonshot.cn 的 OpenAI 兼容端点，pi-provider 按 apiProtocol 分流。

      { model: 'kimi-k2-0905-preview', modelName: 'Kimi K2 (0905)', modelSeries: 'kimi', contextLength: 256_000, maxOutputTokens: 32_768, inputModalities: ['text'] },

      { model: 'kimi-k2-0711-preview', modelName: 'Kimi K2 (0711)', modelSeries: 'kimi', contextLength: 256_000, maxOutputTokens: 32_768, inputModalities: ['text'] },

      { model: 'kimi-k2-turbo-preview', modelName: 'Kimi K2 Turbo', modelSeries: 'kimi', contextLength: 256_000, maxOutputTokens: 32_768, inputModalities: ['text'] },

    ],

  },

  {
    id: 'kimi',

    name: 'Kimi Code（官方）',

    vendor: 'Moonshot AI',

    cloudProvider: '模型官方',

    type: 'api',

    primaryModel: 'k3',

    isBuiltin: true,

    authType: 'auth_token',

    apiProtocol: 'anthropic',

    websiteUrl: 'https://www.kimi.com/coding',

    config: {

      baseUrl: 'https://api.kimi.com/coding',

      timeout: 600000,

    },

    models: [

      // 1.5.6：kimi 内置合成条目收编为标准 preset（原合成逻辑见 git 历史
      // admin-api kimiBuiltinProviderEntry——为测试闭环而生，display/verify/
      // runtime 三条链路各打补丁,不如一个 preset 统一）。模型目录镜像 pi-ai
      // 内置 kimi-coding 目录（运行链路 buildLoopModel 用 kimiCodingProvider()
      // .getModels()）——本表服务显示/verify,目录漂移可接受。

      { model: 'k3', modelName: 'Kimi K3', modelSeries: 'kimi', contextLength: 1_048_576, maxOutputTokens: 131_072, inputModalities: ['text', 'image'] },

      { model: 'k3-256k', modelName: 'Kimi K3-256K', modelSeries: 'kimi', contextLength: 262_144, maxOutputTokens: 131_072, inputModalities: ['text', 'image'] },

      { model: 'kimi-for-coding', modelName: 'Kimi K2.7 Code', modelSeries: 'kimi', contextLength: 262_144, maxOutputTokens: 32_768, inputModalities: ['text', 'image'] },

      { model: 'kimi-for-coding-highspeed', modelName: 'Kimi For Coding HighSpeed', modelSeries: 'kimi', contextLength: 262_144, maxOutputTokens: 32_768, inputModalities: ['text', 'image'] },

    ],

  },

  {
    id: 'dashscope',

    name: '通义千问 (DashScope)',

    vendor: '阿里云',

    cloudProvider: '云服务商',

    type: 'api',

    primaryModel: 'qwen3.5-max',

    isBuiltin: true,

    authType: 'auth_token',

    apiProtocol: 'openai',

    websiteUrl: 'https://bailian.console.aliyun.com',

    modelListUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',

    config: {

      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',

      timeout: 600000,

    },

    modelAliases: { sonnet: 'qwen3.5-max', opus: 'qwen3.5-max', haiku: 'qwen3.5-turbo' },

    models: [

      { model: 'qwen3.5-max', modelName: 'Qwen3.5 Max', modelSeries: 'qwen', contextLength: 256_000, maxOutputTokens: 64_000, inputModalities: ['text', 'image'] },

      { model: 'qwen3.5-plus', modelName: 'Qwen3.5 Plus', modelSeries: 'qwen', contextLength: 256_000, maxOutputTokens: 64_000, inputModalities: ['text', 'image'] },

      { model: 'qwen3.5-turbo', modelName: 'Qwen3.5 Turbo', modelSeries: 'qwen', contextLength: 256_000, maxOutputTokens: 64_000, inputModalities: ['text', 'image'] },

    ],

  },

  {
    id: 'zhipu',

    name: '智谱 GLM',

    vendor: '智谱 AI',

    cloudProvider: '模型官方',

    type: 'api',

    primaryModel: 'glm-5',

    isBuiltin: true,

    authType: 'auth_token',

    apiProtocol: 'openai',

    websiteUrl: 'https://open.bigmodel.cn',

    // baseUrl 以 /v4 结尾（非 /v1 约定），显式声明模型列表端点。

    modelListUrl: 'https://open.bigmodel.cn/api/paas/v4/models',

    config: {

      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',

      timeout: 600000,

    },

    modelAliases: { sonnet: 'glm-5', opus: 'glm-5', haiku: 'glm-5-air' },

    models: [

      // 1.2.7：GLM-5 系窗口口径按 1M 对齐（GLM-5.2/5.3 官方文档 1M；
      // 聚合站对 5.0/5.1 有 200K 分歧——偏高方向的误差由溢出兜底
      // （isContextOverflow → 强制压缩重试）接住，偏低方向是窗口浪费）。

      { model: 'glm-5', modelName: 'GLM-5', modelSeries: 'glm', contextLength: 1_000_000, maxOutputTokens: 96_000, inputModalities: ['text', 'image'] },

      { model: 'glm-5-air', modelName: 'GLM-5 Air', modelSeries: 'glm', contextLength: 1_000_000, maxOutputTokens: 96_000, inputModalities: ['text', 'image'] },

      { model: 'glm-5-flash', modelName: 'GLM-5 Flash', modelSeries: 'glm', contextLength: 1_000_000, maxOutputTokens: 96_000, inputModalities: ['text', 'image'] },

    ],

  },

  {
    id: 'siliconflow',

    name: '硅基流动 SiliconFlow',

    vendor: 'SiliconFlow',

    cloudProvider: '云服务商',

    type: 'api',

    primaryModel: 'deepseek-ai/DeepSeek-V4-Pro',

    isBuiltin: true,

    authType: 'auth_token',

    apiProtocol: 'openai',

    websiteUrl: 'https://siliconflow.cn',

    modelListUrl: 'https://api.siliconflow.cn/v1/models',

    config: {

      baseUrl: 'https://api.siliconflow.cn/v1',

      timeout: 600000,

    },

    modelAliases: { sonnet: 'deepseek-ai/DeepSeek-V4-Pro', opus: 'deepseek-ai/DeepSeek-V4-Pro', haiku: 'Qwen/Qwen3.5-Turbo' },

    models: [

      // 聚合平台：org/Model 命名空间；haiku 档由 Qwen Turbo 承担。

      { model: 'deepseek-ai/DeepSeek-V4-Pro', modelName: 'DeepSeek V4 Pro', modelSeries: 'deepseek', contextLength: 1_000_000, maxOutputTokens: 384_000, inputModalities: ['text'] },

      { model: 'deepseek-ai/DeepSeek-V4-Flash', modelName: 'DeepSeek V4 Flash', modelSeries: 'deepseek', contextLength: 1_000_000, maxOutputTokens: 384_000, inputModalities: ['text'] },

      { model: 'Qwen/Qwen3.5-Max', modelName: 'Qwen3.5 Max', modelSeries: 'qwen', contextLength: 256_000, maxOutputTokens: 64_000, inputModalities: ['text', 'image'] },

      { model: 'Qwen/Qwen3.5-Turbo', modelName: 'Qwen3.5 Turbo', modelSeries: 'qwen', contextLength: 256_000, maxOutputTokens: 64_000, inputModalities: ['text', 'image'] },

    ],

  },

];

