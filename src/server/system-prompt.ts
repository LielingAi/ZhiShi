/**
 * Unified system prompt assembly for ZhiShi.
 *
 * Three-layer prompt architecture:
 *   L1 — Base identity (always included)
 *   L2 — Interaction channel (desktop / cron headless / security terminal, per scenario)
 *   L3 — Scenario instructions (cron-task / heartbeat, stacked as needed)
 *
 * Template content is inlined below (not loaded from filesystem) because
 * bun build hardcodes __dirname at compile time, breaking production builds.
 */

import type { RuntimeType } from '../shared/types/runtime';
import type { DistilledMemory } from './memory/distill';
import { parseActiveReminders } from './memory/distill';
import type { ResearchDistilledMemory } from './memory/distill-research';
import type { ResearchTaskKind } from './memory/store';
import { buildCliToolsAppend, buildWidgetSection } from './system-prompt-cli-tools';
import {
  buildNativeCodeSection,
  buildResearchLogSection,
  buildResearchMemorySection,
  buildSecurityCapabilitiesSection,
  buildSecurityKernelSection,
  type SecurityCapabilitiesData,
} from './system-prompt-security';
import { renderArchiveForInjection, type ArchiveSnapshot } from './loop/archive';

// ===== Scenario types =====

export type InteractionScenario =
  | { type: 'desktop' }
  | { type: 'cron'; taskId: string; intervalMinutes: number; aiCanExit: boolean }
  /**
   * 1.4.1 — auto loop agent 场景(cron 同族的 headless 通道)。与 cron 的
   * 差异:循环是 runner 逐轮自动发起的(不是心跳定时唤醒),且研究纪律里有
   * 「暂停点才提请人」(request_decision)——cron 模板的「不要向用户提问等
   * 回复」与本设计直接冲突,故独立成族而不是复用 cron 场景对象。
   */
  | { type: 'auto-run'; runId: string }
  /**
   * 安全研究员版 P1 S1 — `zhishi agent` CLI 会话场景。注入五段安全语境
   * （kernel / capabilities / native-code / research-log / research-memory，
   * 见 system-prompt-security.ts）。
   * 场景标记落在会话元数据（SessionMetadata.interactionScenario），由
   * agent-session 的 startStreamingSession 按元数据恢复——不落全局
   * currentScenario，避免与 cron 的 set/reset 时序互相覆盖。
   */
  | { type: 'security' };

// ===== Runtime display name =====
// Maps internal runtime ids to human-readable names injected into the L1 base identity
// so the AI can correctly answer "what runtime am I running on?" questions regardless
// of which CLI is driving it.
function getRuntimeDisplayName(runtime: RuntimeType | undefined): string {
  switch (runtime) {
    case 'claude-code': return 'Anthropic Claude Code CLI';
    case 'codex':       return 'OpenAI Codex CLI';
    case 'gemini':      return 'Google Gemini CLI';
    case 'builtin':
    default:
      return 'ZhiShi 内置研究引擎（pi）';
  }
}

// ===== Inline templates =====

const TMPL_BASE_IDENTITY = `<zhishi-identity>
你正运行在 ZhiShi —— 一款通用的桌面智能体应用中。用户通过 ZhiShi 调用你,
ZhiShi 负责会话管理、工具权限、定时任务、工作区文件访问等能力,
你则负责理解和执行用户的请求。

当前执行 Runtime: {{runtimeName}}

用户全局配置目录: ~/.zhishi
当对话涉及日期、时间或星期时,以会话消息与系统信息中的时间为准;需要精确当前时间且已锚定研究环境时,经 env_exec 执行 \`date\` 取环境内时间(环境时钟可能与宿主有偏差,引用时注明来源)——你没有宿主 shell,不要凭空猜日期。
</zhishi-identity>`;

const TMPL_CHANNEL_DESKTOP = `<zhishi-interaction-channel>
用户正通过 ZhiShi 桌面客户端与你对话。
</zhishi-interaction-channel>`;

const TMPL_CHANNEL_CRON = `<zhishi-interaction-channel>
本会话由定时任务触发(headless,没有实时对话方)——你的最终输出会记入任务运行日志,用户事后查看;不要向用户提问等回复,按任务目标自主推进到底。
</zhishi-interaction-channel>`;

const TMPL_CHANNEL_AUTO_RUN = `<zhishi-interaction-channel>
本会话由 auto loop 自动驱动(headless,没有实时对话方)——每轮结束系统会自动发起下一轮,不需要你逐轮请求继续;过程与结论记录在会话存档里,研究员事后回看,也会在暂停点/验收点介入。
</zhishi-interaction-channel>`;

const TMPL_CHANNEL_SECURITY = `<zhishi-interaction-channel>
用户正通过 ZhiShi 研究终端(zhishi agent CLI / TUI)与你对话。
</zhishi-interaction-channel>`;

const TMPL_CRON_TASK = `<zhishi-cron-task-instructions>
你正处于心跳循环任务模式 (Task ID: {{taskId}})。每隔 {{intervalText}} 系统触发唤醒你一次。{{#if aiCanExit}}

如果任务目标已完全达成、或继续执行无意义/有害，请在最终输出中包含 \`[CRON_TASK_COMPLETE: <结论>]\` 标记结束任务——运行时检测到该标记即结清任务并停止后续触发。只有确认任务彻底完成时才用；暂时性错误请重试，不要借此脱身。{{/if}}
</zhishi-cron-task-instructions>`;

// ===== 全局人格层（乙方案：一个灵魂，注入直读 db） =====

// ===== Distilled memory (工作生命宪章 §4.1 蒸馏层) =====

/**
 * Build the `<zhishi-distilled-memory>` context section — the constant-size
 * distillation layer produced by the 蒸馏弧 (§4.2). Returns '' when no
 * distilled files exist yet — callers MUST treat that as zero injection.
 * Total size is bounded: each of the four files is hard-capped at 2000
 * chars by the distill pipeline, so this section never exceeds ~8KB no
 * matter how long the raw work history grows.
 *
 * reminders（P4 主动记忆，宪章 §7.3）注入前经 parseActiveReminders 确定性
 * 过滤：过期的、缺来源标注的一律不进上下文（红线：不许编造、过期自动清理）。
 */
export function buildDistilledMemorySection(distilled: DistilledMemory | undefined): string {
  if (!distilled) return '';
  const parts: string[] = [];
  if (distilled.userModel.trim()) parts.push(`## 它眼中的你\n${distilled.userModel.trim()}`);
  if (distilled.selfModel.trim()) parts.push(`## 它眼中的自己\n${distilled.selfModel.trim()}`);
  if (distilled.routines.trim()) parts.push(`## 老规矩\n${distilled.routines.trim()}`);
  const activeReminders = parseActiveReminders(distilled.reminders ?? '');
  if (activeReminders.length > 0) {
    parts.push(
      `## 主动提醒\n${activeReminders.join('\n')}\n\n` +
      '（以上是蒸馏弧从真实工作史里维护的提醒，每条都附来源。会话开始或任务触发前，' +
      '若其中某条与当前情境相关，主动说给用户听并附上来源——“上次这里栽过”“这个月底要交”；' +
      '不相关就保持沉默，不要逐条宣读。）',
    );
  }
  if (parts.length === 0) return '';
  return `<zhishi-distilled-memory>
以下是蒸馏记忆（工作生命宪章 §4.1 三层心智的蒸馏层）——由「蒸馏弧」定期从你们的共同工作史中压出，尺寸恒定。它是你眼中的搭档、你眼中的自己、你们的老规矩与主动提醒；据此校准你的判断与分寸。这里只有蒸馏后的认知；更具体的偏好、决定、踩坑细节存在长期记忆库里——检索通道（zhishi memory search <关键词>，可选 --kind reminder 过滤）在宿主侧、由人执行，你在当前通道里够不到：需要回忆时向用户说明要找什么、请其检索。命中会被记录，遭用户纠正的记忆会自动降权，所以放心引用、如实使用，不确定就说来自记忆。
${parts.join('\n\n')}
</zhishi-distilled-memory>`;
}

const TMPL_BROWSER_STORAGE_STATE = `<zhishi-browser-storage-instructions>
当你在浏览器中执行了登录操作或用户帮你完成了登录（输入账号密码、OAuth 授权、扫码登录等），必须在登录成功后**立即**调用 browser_storage_state 工具将登录状态保存到 ~/.zhishi/browser-storage-state.json，然后再继续执行后续任务。这样即使后续任务中断或会话异常终止，登录态也不会丢失，后续对话可以复用。
</zhishi-browser-storage-instructions>`;

// ===== Variable replacement =====
// Supports {{varName}} simple substitution + {{#if varName}}...{{else}}...{{/if}} conditional blocks

function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  // Conditional blocks: {{#if key}}...{{else}}...{{/if}} or {{#if key}}...{{/if}}
  result = result.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g,
    (_, key, ifBlock, elseBlock) => vars[key] ? ifBlock : (elseBlock ?? '')
  );
  // Simple variable substitution
  result = result.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
  return result;
}

// ===== Main entry =====

export interface SystemPromptOptions {
  /** Whether Playwright MCP with storage capability is enabled in this session */
  playwrightStorageEnabled?: boolean;
  /**
   * Current runtime driving this session, used to render a runtime-accurate
   * identity line in L1. Defaults to 'builtin'（ZhiShi 内置研究引擎 pi）if omitted.
   */
  runtime?: RuntimeType;
  /**
   * Append the `zhishi` CLI capability hints (cron / IM media) to the
   * prompt. pi 引擎路径（1.2.6 起）按场景传入——cron + aiCanExit 时至少
   * 注入 task-exit 段（`[CRON_TASK_COMPLETE: …]` 标记机制）；依赖宿主
   * shell 的段由 `cliHostShell` 门控（pi 无宿主 shell，默认 false 不注入）。
   *
   * Note: generative-UI widget guidance is universal across runtimes (no MCP
   * equivalent — the CLI is the only path) and is emitted unconditionally for
   * desktop scenarios via `buildWidgetSection()`.
   */
  cliToolsEnabled?: boolean;
  /**
   * 当前通道里 agent 是否有宿主 shell（可执行 zhishi CLI）。pi 内置引擎
   * 没有宿主 shell——传 false 时 CLI 附录只保留不依赖 shell 的段（cron
   * 自退标记），不教 agent 用它在当前通道里执行不了的东西。默认 true
   * （向后兼容有 shell 的外部 runtime 形态）。
   */
  cliHostShell?: boolean;
  /**
   * 蒸馏记忆（工作生命宪章 §4.1 蒸馏层 / §4.2 蒸馏弧）。调用方从
   * ~/.zhishi/memory/distilled/ 读入（loadDistilledMemoryForPrompt），
   * 三个文件全空时传 undefined = 零注入。总量恒定 ≤6000 字符。
   */
  distilledMemory?: DistilledMemory;
  /**
   * 安全研究员版 P1 S1 — security 场景的能力清单数据源（仅
   * scenario.type === 'security' 时消费）。调用方在会话启动时经
   * collectSecurityCapabilities 采集（E1 引擎探测 30s 缓存 + E4 配方 +
   * E3 注册表 + T4 现场选择）；undefined = 能力清单段零注入（kernel 与
   * native-code 静态段不受其影响）。
   */
  securityCapabilities?: SecurityCapabilitiesData;
  /**
   * 安全研究员版 P1 D4 — security 场景的研究记忆反喂数据源（仅
   * scenario.type === 'security' 时消费）。调用方在会话启动时经
   * collectResearchMemory 采集（安全蒸馏弧 D3 的 keyed 产物：成功路径 /
   * 失败根因 / 工具组合）；undefined 或三分节全空 = <zhishi-research-memory>
   * 段零注入。
   */
  securityResearchMemory?: ResearchDistilledMemory;
  /**
   * 当前会话的研究域（1.2.4 域过滤 + 1.2.7 域边界，仅 security 场景消费）。
   * 调用方经 resolveSessionResearchDomain（配方默认）/ resolveSessionDomain
   * （+ 内容信号动态修正）推导——提供时 <zhishi-research-memory> 只注入该域
   * 子节 + 跨域通用行，且 <zhishi-capabilities> 只列该域 recipes ∪ 绑定了
   * 这些配方的具名环境；undefined = 无可靠域信号（host 现场等），降级全量
   * 注入（宁多勿缺）。
   */
  securityResearchDomain?: ResearchTaskKind;
  /**
   * 1.4.4 — 研究档案实时状态段（security / auto-run 场景消费）。调用方
   * 按本 turn 的 loop 线装载（loadArchive，读侧容错）；undefined/空档案 =
   * 零注入。硬顶 ARCHIVE_INJECT_MAX_CHARS（renderArchiveForInjection）——
   * 实时状态只给「知道在哪、还缺什么」，全文在 GUI 研究面板。
   */
  researchArchive?: ArchiveSnapshot;
  /**
   * 1.5.1 — 专家知识邻域投影段（security / auto-run 场景消费）。调用方经
   * collectExpertInjection 预渲染（焦点锚点：档案 pending H#/open Q# +
   * 最近用户消息；确定性检索 + 会话内去重 + 透明标注）；'' / undefined =
   * 零注入（邻域为空静默）。
   */
  expertKnowledge?: string;
}

export function buildSystemPromptAppend(scenario: InteractionScenario, options?: SystemPromptOptions): string {
  const parts: string[] = [];

  // L1: Base identity (always) — rendered with current runtime's display name.
  parts.push(renderTemplate(TMPL_BASE_IDENTITY, {
    runtimeName: getRuntimeDisplayName(options?.runtime),
  }));

  // L2: Interaction channel (按场景分述——cron/auto-run 是 headless 触发，没有实时对话方)
  parts.push(
    scenario.type === 'cron' ? TMPL_CHANNEL_CRON
    : scenario.type === 'auto-run' ? TMPL_CHANNEL_AUTO_RUN
    : scenario.type === 'security' ? TMPL_CHANNEL_SECURITY
    : TMPL_CHANNEL_DESKTOP,
  );

  // L3: Scenario instructions (stacked as needed)
  if (scenario.type === 'cron') {
    const intervalText = scenario.intervalMinutes >= 60
      ? `${Math.floor(scenario.intervalMinutes / 60)} 小时${scenario.intervalMinutes % 60 > 0 ? ` ${scenario.intervalMinutes % 60} 分钟` : ''}`
      : `${scenario.intervalMinutes} 分钟`;
    parts.push(renderTemplate(TMPL_CRON_TASK, {
      taskId: scenario.taskId,
      intervalText,
      aiCanExit: scenario.aiCanExit ? 'true' : '',  // non-empty = truthy for {{#if}}
    }));
  }

  // L3: Generative UI widget guidance — universal across runtimes for desktop
  // scenarios. Both builtin SDK and external CLIs load the design contract via
  // `zhishi widget readme <module>` invoked through their shell tool.
  const widgetSection = buildWidgetSection(scenario);
  if (widgetSection) parts.push(widgetSection);

  // L3: Distilled memory (宪章 §4.1) — constant-size cognitive layer.
  // Zero injection when no distilled
  // files exist yet (first-run installs, fresh workspaces).
  const distilledMemorySection = buildDistilledMemorySection(options?.distilledMemory);
  if (distilledMemorySection) parts.push(distilledMemorySection);

  // L3: security 场景段（安全研究员版 P1 S1 + D1 + D4）——认知内核 + 动态能力
  // 清单 + 代码原生通道 + 研究成败信号教学 + 研究记忆反喂（蒸馏闭环的最后
  // 一环）。全部零注入语义 + 每段硬字符上限（见 system-prompt-security.ts）。
  if (scenario.type === 'security') {
    const kernelSection = buildSecurityKernelSection();
    if (kernelSection) parts.push(kernelSection);
    const capabilitiesSection = buildSecurityCapabilitiesSection(
      options?.securityCapabilities,
      { domain: options?.securityResearchDomain },
    );
    if (capabilitiesSection) parts.push(capabilitiesSection);
    const nativeCodeSection = buildNativeCodeSection();
    if (nativeCodeSection) parts.push(nativeCodeSection);
    const researchLogSection = buildResearchLogSection();
    if (researchLogSection) parts.push(researchLogSection);
    const researchMemorySection = buildResearchMemorySection(
      options?.securityResearchMemory,
      { domain: options?.securityResearchDomain },
    );
    if (researchMemorySection) parts.push(researchMemorySection);
  }

  // L3: 研究档案实时状态段（1.4.4，security / auto-run）——模型在显式研究
  // 状态上继续工作，不从历史脑补。零注入语义 + 硬顶（renderArchiveForInjection）。
  if (scenario.type === 'security' || scenario.type === 'auto-run') {
    const archiveSection = renderArchiveForInjection(options?.researchArchive);
    if (archiveSection) parts.push(archiveSection);
    // 1.5.1 专家知识邻域投影（唯一注入路径）——harness 确定性检索注入，
    // 预渲染段非空才追加（零注入语义；透明标注列 #id）。
    if (options?.expertKnowledge) parts.push(options.expertKnowledge);
  }

  // L3: Browser storage state save instruction (when Playwright with --caps=storage is active)
  if (options?.playwrightStorageEnabled) {
    parts.push(TMPL_BROWSER_STORAGE_STATE);
  }

  // L4: CLI-backed capability hints — gated by cliToolsEnabled; sections that
  // require a host shell (task CRUD / memory search / panels) are additionally
  // gated by cliHostShell so prompt 不教 agent 用当前通道执行不了的东西。
  // pi 内置引擎（无宿主 shell）只保留 cron 自退标记段。
  if (options?.cliToolsEnabled) {
    const cliTools = buildCliToolsAppend(scenario, { hostShell: options?.cliHostShell ?? true });
    if (cliTools) parts.push(cliTools);
  }

  return parts.join('\n\n');
}


