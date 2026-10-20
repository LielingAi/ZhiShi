/**
 * zustand store（1.3.1 GUI 迭代——组装层）。
 *
 * 分工：纯逻辑（事件归约 / Esc 链 / 准入闸 / 命令路由 / 任务登记表）
 * 全部在 src/gui/src/model/* 纯函数模块里；本文件只做 I/O 与状态组装——
 * SSE 消费、admin 接口调用、overlay/模态/抽屉/页面/面板的开关。
 *
 * 会话按环境分线：sessions[key]（key = env id；null = 宿主线，用 'host' 键）；
 * 切环境 = 重置目标线 + 重连 SSE，由服务端 replay 全量重建该线历史。
 *
 * 1.3.1 新增状态：
 *   - currentEnvKey: string | null（null = 宿主未锚定；启动时 environment/current 恢复）
 *   - boundaryAsks / bgTasks / subagents（SSE 事件登记表，纯函数归约在 model/）
 *   - tasksSelected / queueOpen / queueServer（/queue 面板；V4-S2 起 /tasks 内容
 *     驻 SidePane「任务」页签，overlay 开关 tasksOpen 随壳退役）
 *   - boot（environment/up 真进度：请求 + 轮询 environment/ps）
 *
 * 1.3.2 新增状态：
 *   - decisions / activeDecisionId（决策面板登记表 + 当前弹窗指针，①）
 *   - theme（深浅色，localStorage 持久化，③）
 *   - 多线切换 A 形态：switchEnv 换激活指针、不丢任何线本地状态（③）
 *   - chat:init environment 锚直接锚定环境（任务二 #2，免 environment/current 绕行）
 *
 * 1.3.5 新增状态（GUI 补齐四缺口）：
 *   - 输入历史 per-env localStorage 落盘 + 子序列模糊评分（model/input-history）
 *   - /export [sanitize] 脱敏导出（slash-args 模态收参）
 *   - registerDiscovered：本机发现条目「选中即注册」（environment/add）
 */

import { create } from 'zustand';

import { emptySession, type SessionState, type ToolDetail } from '../model/blocks';
import { initAnchorToGuiKey, selectionToGuiKey, type InitEnvAnchor } from '../model/access-gate';
import {
  removeBoundaryAsk,
  upsertBoundaryAsk,
  type BoundaryAsk,
} from '../model/boundary';
import {
  hasDecision,
  removeDecision,
  upsertDecision,
  type DecisionPending,
} from '../model/decision';
import { escAction } from '../model/esc-chain';
import { bootStages, buildRegisterPayload, imageStartRecipe, isDiscoveredRunning, startRecipeFor, type DiscoveredLike, type RegisterExtras } from '../model/envs';
import { envRemovePlan, type EnvRemoveTarget } from '../model/env-remove';
import type { EnvDownTarget } from '../model/env-down';
import type { EnvRebuildTarget, EnvResetTarget } from '../model/env-rebuild';
import {
  buildWizardPayload,
  findRunningEnvForRecipe,
  initialWizardState,
  wizardBack,
  wizardNext,
  wizardSelectSource,
  type EnvWizardState,
  type WizardParams,
  type WizardSource,
} from '../model/env-wizard';
import { parseSessionRows, autoRunRowsOf, mergeAutoRunRows, applySessionTitleChange, type SessionMetaRow } from '../model/history';
import { missionLabel, missionPatchValue, MISSION_OPTIONS } from '../model/mission';
import {
  INPUT_HISTORY_LIMIT,
  loadInputHistory,
  prependHistory,
  rankInputHistory,
  saveInputHistory,
  INPUT_HISTORY_OVERLAY_LIMIT,
} from '../model/input-history';
import { buildMentionItems, fileCacheKey, fileDirOf, MENTION_DEBOUNCE_MS, parseMentionQuery } from '../model/mention';
import { ensureSessionSlot, planSwitch, sessionKey } from '../model/multi-session';
import {
  applyAutoRunEvent,
  buildAutoRunStartPayload,
  isAutoRunActive,
  optimisticAutoRunEntry,
  restoredAutoRunStale,
  validateAutoRunForm,
  activeAutoRunOf,
  parseAutoRunList,
  type AutoRunEntry,
  type AutoRunFormView,
} from '../model/auto-run';
import {
  applyArchiveChanged as applyArchiveChangedPayload,
  isArchiveSnapshotForLine,
  type ArchiveSnapshot,
} from '../model/archive';
import { reduceSseEvent } from '../model/reducer';
import type { EnvRunLike } from '../model/env-panel';
import {
  appendRefPlaceholder,
  isLargeValueRef,
  resolveRefPlaceholder,
  type LargeValueRef,
} from '../model/ref';
import { buildSendBody, classifySendResponse, type Ref } from '../model/send';
import {
  buildTaskRows,
  applyBgEvent,
  applySubagentEvent,
  type BgTaskEntry,
  type ServerTaskLike,
  type SubagentEntry,
  type TaskRow,
} from '../model/tasks';
import { loadTheme, nextTheme, THEME_STORAGE_KEY, type ThemeMode } from '../model/theme';
import {
  exportResultToast,
  forkTargets,
  noEnvToast,
  rewindTargets,
  slashPayload,
  slashRoute,
  SLASH_ROUTES,
  type SlashCommandName,
} from '../model/slash-routes';
import {
  ARCHIVE_INSTRUCTION,
  buildDecideInstruction,
  buildIntelInjectText,
  effectiveQuery,
} from '../model/slash-research';
import { acceptsInlineArgs, isKnownCommand, parseSlashInput, slashNameSegment } from '../model/slash-input';
import { slashObjectItems } from '../model/slash-objects';
import {
  buildCampaignRows,
  parseCampaignRecords,
  type CampaignRecordLike,
} from '../model/campaign';
import { buildLineRows, parseLineList, shortLineId, type LineRow } from '../model/lines';
import {
  clampSidePaneWidth,
  initialSidePaneOpen,
  ReceiptScheduler,
  SIDE_PANE_DEFAULT_WIDTH,
  SIDE_PANE_MIN_WIDTH,
  WIDE_SCREEN_MIN,
  type SidePaneTab,
} from '../model/side-pane';
import {
  loadPaletteHistory,
  paletteItems as buildPaletteItems,
  pushPaletteHistoryList,
  savePaletteHistory,
  type PaletteItem,
  type PaletteSources,
} from '../model/command-palette';
import { parseCrashEvents, evidencePayloadOf, type CrashEvent } from '../model/crash-events';
import { parseExpertImport } from '../model/expert-import';
import { pickModelPickerProviders } from '../model/model-picker';
import { mergeSidebarSnapshot } from '../model/sidebar';
import * as api from '../client/api';
import type {
  AgentEntity,
  DiscoveredDocker,
  DiscoveredDockerImage,
  DiscoveredVm,
  DomainEntity,
  EnvEntry,
  LoopTranscriptLine,
  ModelProvider,
  PsInstance,
  QueueStatusItem,
  Recipe,
  WorkspaceFileEntry,
} from '../client/api';
import { resolvePort } from '../client/port';
import { GuiHttpError, GuiSidecarClient, type SseInput } from '../client/sse-client';
import { loadConnection, normalizeServerUrl, pollRemoteRelayPort } from '../model/connection';

// ---------------------------------------------------------------------------
// 常量（v19 SLASH 清单，15 条——v4 增 resume/kill/mission 三动词，带对象补全）
// ---------------------------------------------------------------------------

export interface SlashCommand {
  name: string;
  detail: string;
  group: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'use', detail: '切环境 <环境id>（对象补全=环境注册表）', group: '环境' },
  { name: 'xfer', detail: '跨环境传产物 <源:路径> <目标:路径>', group: '环境' },
  { name: 'gate', detail: '正门（选/建环境）', group: '环境' },
  { name: 'attach', detail: '接管环境 shell', group: '环境' },
  { name: 'snapshot', detail: '给当前环境打快照 [名]', group: '环境' },
  { name: 'rollback', detail: '回滚到快照 <名>', group: '环境' },
  { name: 'extract', detail: '回收环境内文件到宿主 <路径>', group: '环境' },
  { name: 'push', detail: '传入宿主文件到环境 <宿主路径> <环境内路径>', group: '环境' },
  { name: 'rewind', detail: '回退到历史消息', group: '线程' },
  { name: 'fork', detail: '从某条消息分叉出新线程', group: '线程' },
  { name: 'queue', detail: '查看/取消排队消息', group: '线程' },
  { name: 'tasks', detail: '查看子任务与后台进程', group: '线程' },
  { name: 'export', detail: '导出研究报告 [sanitize 脱敏]', group: '线程' },
  { name: 'intel', detail: '查情报库 [CVE/关键字，留空吃上下文]', group: '研究' },
  { name: 'archive', detail: '整理研究档案（近期进展立实体/收尾终态）', group: '研究' },
  { name: 'decide', detail: '给我选项（人拍板）[议题，留空取上下文焦点]', group: '研究' },
  { name: 'resume', detail: '切线（resume 有成本）<线id>', group: '线' },
  { name: 'kill', detail: '终止战役 <id>', group: '战役' },
  { name: 'mission', detail: '改任务形态 <挖掘|利用|复现|ctf|无类型>', group: '形态' },
  { name: 'reset', detail: '重置对话（新会话）', group: '线程' },
  { name: 'model', detail: '选择模型', group: '配置' },
  { name: 'help', detail: '键位与命令帮助', group: '配置' },
];

// ---------------------------------------------------------------------------
// UI 状态类型
// ---------------------------------------------------------------------------

export type OverlayKind = 'slash' | 'at' | 'history' | 'model';

export interface OverlayItem {
  name: string;
  detail?: string;
  tag?: string;
  cur?: boolean;
  providerId?: string;
  model?: string;
  /**
   * 1.3.3 @ 补全：选中后落 chips 的 ref（kind=env/file；见 model/send.ts
   * Ref——服务端解析 grounding 段）。
   */
  ref?: Ref;
  /**
   * 1.3.3 @ 补全：选中后替换输入框尾部 @token 的纯文本（子代理/工具名；
   * 目录行是 `@path/` 续触发）。
   */
  insert?: string;
  /** 1.3.3 @ 补全：分节标题（环境/文件/子代理/工具），Overlay 分组渲染。 */
  section?: string;
}

export interface OverlayState {
  kind: OverlayKind;
  title: string;
  items: OverlayItem[];
  sel: number;
  /** 1.5.2：slash overlay 的 inline 参数段（/intel CVE-2024-1234 的
   *  CVE-2024-1234——选中执行时随命令直发，不再丢）。 */
  slashArgs?: string;
  /** v4 对象补全：对象模式下已解析出的命令名（items 的 name 是对象 id 而非
   *  /命令——pickOverlay 据此恢复 cmd，对象 id 走 slashArgs 参数）。 */
  slashObjCommand?: string;
}

export type ModalKind =
  | 'new-env'
  | 'adopt'
  | 'boot'
  | 'slash-args'
  | 'pick-message'
  | 'promote'
  | 'env-remove'
  | 'env-down'
  | 'env-provision'
  | 'env-detail'
  | 'env-rebuild'
  | 'env-reset'
  | 'env-rename'
  | 'env-registering'
  | 'campaign-stop'
  | 'auto-run-start'
  | 'auto-run-stop';

/** promote（入专家库）预填：决策块 → 专家条目草稿。 */
export interface PromotePrefill {
  /** title = question。 */
  title: string;
  /** applicability = 场景（用户补）。 */
  applicability: string;
  /** criteria = 选择+备注 草稿。 */
  criteria: string;
  /** content = 决策块正文。 */
  content: string;
}

export interface ModalState {
  kind: ModalKind;
  /** boot/adopt 关联的配方 id。 */
  recipeId?: string;
  /** slash-args / pick-message 关联的命令名（rewind/fork/snapshot/rollback/extract/push/export）。 */
  command?: SlashCommandName;
  /** promote（入专家库）预填。 */
  prefill?: PromotePrefill;
  /** 1.3.7 向导 → boot：VM 配方的可选 guest 凭据（environment/up 透传）。 */
  bootOpts?: { user?: string; keyPath?: string };
  /** 1.6.14：登记失败的定格错误（env-registering 模态的错误态）。 */
  registerError?: string;
  /** 1.3.7 补口：env-remove 模态的删除目标（文案/确认强度见 model/env-remove）。 */
  envRemove?: EnvRemoveTarget;
  /** 1.3.8 ①：env-down 模态的停止目标（文案见 model/env-down）。 */
  envDown?: EnvDownTarget;
  /** 1.4.9：env-provision 模态的补齐目标（重放配方安装脚本）。 */
  envProvision?: { id: string; label: string; missing: string[] };
  /** 1.3.8 多配方：env-detail 模态展示/管理目标（完整登记条目）。 */
  envDetail?: EnvEntry;
  /** 1.5.10：env-rebuild 模态的重建目标（文案见 model/env-rebuild）。 */
  envRebuild?: EnvRebuildTarget;
  /** 1.5.10：env-reset 模态的重置目标（文案见 model/env-rebuild）。 */
  envReset?: EnvResetTarget;
  /** 1.6.6：env-rename 模态的改名目标（name = 当前别名，预填用；空则预填 id）。 */
  envRename?: { id: string; label: string; name?: string };
  /** 1.6.8 M2：campaign-stop 模态的终止目标（/tasks 战役卡片「终止」二次确认）。 */
  campaignStop?: { id: string; goal: string };
}

export interface DrawerState {
  toolId: string;
  name: string;
  args: string;
  output: string;
  state: 'done' | 'fail' | 'running';
  exitCode?: number;
  elapsedMs?: number;
  search: string;
}

export interface TasksSelected {
  title: string;
  detail: string;
  /** 子代理 transcript（loop-session 结构化消息）或 server task JSON 摘要。 */
  transcript: LoopTranscriptLine[] | null;
  /** 第三批 v4：战役对象卡指针——选中战役行时面板按 id 自取 record 渲染 CampaignCard。 */
  campaignId?: string;
}

/** boot 进度（environment/up 真链路）。 */
export interface BootState {
  recipeId: string;
  base: string | undefined;
  stage: number;
  /** null=进行中；'done' / 'failed'。 */
  status: 'running' | 'done' | 'failed';
  error?: string;
}

export type Page = 'chat' | 'settings' | 'attach' | 'history' | 'gate';

export type ConnectionState = 'discovering' | 'connecting' | 'live' | 'reconnecting' | 'failed';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface GuiState {
  // 连接
  connectionState: ConnectionState;
  connectError: string | null;

  // 侧栏数据
  envs: EnvEntry[];
  running: PsInstance[];
  discoveredDocker: DiscoveredDocker[];
  discoveredVm: DiscoveredVm[];
  /** 1.5.10：zhishi-env-* 镜像发现条目（discover 第三键 images）。 */
  discoveredImages: DiscoveredDockerImage[];
  recipes: Recipe[];
  models: ModelProvider[];
  workspace: string | null;
  /** null = 宿主（未锚定环境）；否则为环境 id（侧栏键）。 */
  currentEnvKey: string | null;

  // 会话（per-env；宿主线键 'host'）
  sessions: Record<string, SessionState>;

  // 输入历史（per-env）
  history: Record<string, string[]>;

  // 输入区 @ 引用 chips
  refs: Ref[];

  // 1.3.1 ②③：SSE 事件登记表
  boundaryAsks: BoundaryAsk[];
  bgTasks: BgTaskEntry[];
  subagents: SubagentEntry[];

  // 1.3.2 ①：决策面板登记表 + 当前弹窗指针
  decisions: DecisionPending[];
  /** 当前决策模态展示的 decisionId；null = 全部收起（会话头部待答指示）。 */
  activeDecisionId: string | null;

  // 1.4.1：auto loop（auto-run runner）登记表——活跃 loop 只有一条。
  autoRun: AutoRunEntry | null;

  // 1.4.4 研究档案（分屏看板数据面）。单槽设计：同一时刻只有一条活跃线
  // 在写档案（交互线或 auto-run 线——auto-run 运行中交互被锁,互斥成立）,
  // archive:changed 整包覆盖即正确;chat:init 重连用 archive/list 重锚。
  archive: ArchiveSnapshot | null;
  /** 档案锚线（2.0.2）：档案视图归属的线 id——跨线 archive:changed 快照一律
   *  丢弃（GUI 全量订阅；busy 安全切换后旧线仍在写档案，不过滤会被旧线
   *  快照反复盖掉 = 「切环境档案丢失」）。 */
  archiveSessionId: string | null;
  /** 看板高亮实体（流内「→V3」徽章点进来的定位;null = 无高亮）。 */
  archiveHighlightId: string | null;
  /** 跳流目标：档案锚 → 流内 user 消息 id（一次性信号——Stream 按 nonce
   *  消费触发滚动，store 侧只写不清；重复跳同一锚靠 nonce 递增再触发）。 */
  archiveJumpTarget: { messageId: string; nonce: number } | null;
  // 决策②修订（V4-S3）：档案分屏/抽屉/flash 全退役——档案唯一落位 SidePane
  // 「档案」页签；archivePaneRatio/archiveSwapped/archiveDrawerOpen 随之移除
  //（localStorage 旧键不再读取，自然作废）。

  // 1.3.2 ③：主题（深色默认；localStorage 持久化）
  theme: ThemeMode;

  // 1.3.3 @ 补全：工具名数据源（chat:system-init 的 info.tools，随会话绑定刷新）
  tools: string[];

  // 1.3.3 历史面板：会话清单（null = 未载入/载入失败；加载中由
  // historySessions===null 且 historyError===null 推导）
  historySessions: SessionMetaRow[] | null;
  /** 1.3.4：清单拉取失败原因（非 null 时清单展示 error 态而非「暂无会话」）。 */
  historyError: string | null;

  /** 1.6.11：当前会话线的任务形态（session/mission 线态直读，无需会话绑定；
   *  null = 未连接/未读——选择器禁用态仅看连接）。 */
  mission: { kind: string | null } | null;

  /** 1.3.3 @ 补全：选中后替换输入框尾部 @token 的一次性信号。 */
  mentionApply: { replace: string; nonce: number } | null;

  // 1.3.1 ③④：/tasks 与 /queue 面板（V4-S2：tasks overlay 壳退役——内容驻
  // SidePane「任务」页签，由 sidePaneTab==='tasks' 驱动；数据节奏见
  // refreshTasksTab。queue 保留 overlay 形态）
  tasksSelected: TasksSelected | null;
  queueOpen: boolean;
  queueServer: QueueStatusItem[];
  /** 1.6.8 M2：战役观察卡片数据源（campaign/list；/tasks 第四源，开面板刷新）。 */
  campaigns: CampaignRecordLike[];

  // 1.8.7 P3b：研究线清单（line/list；B6/B7 线一等对象视图）。V4-S1 起线面板
  // 驻 SidePane「线」页签（见下方 sidePaneOpen/sidePaneTab），linesOpen 浮层
  // 开关随浮层退役，数据面（lines/linesLoading）不动。
  /** 展示行（model/lines::buildLineRows 装配——归属段/live·busy 都在装配期定型）。 */
  lines: LineRow[];
  linesLoading: boolean;

  // V4-S1 骨架壳：右侧检查面板（SidePane——设计稿 §2 柱2 的壳；S2 起能力迁入）
  sidePaneOpen: boolean;
  sidePaneTab: SidePaneTab;
  /** 2.0-M2 注视语义：只读查看中的他线（null=未查看）。 */
  peekView: { envKey: string; loopSessionId: string; lines: LoopTranscriptLine[] } | null;
  /** 2.0-M4b：环境面板（底栏单入口点开；行内带在干什么/最近完成）。 */
  envPanelOpen: boolean;
  envRuns: EnvRunLike[];
  /** 面板宽（px；钳制 260~60vw 后持久化 localStorage）。 */
  sidePaneWidth: number;

  // 第四批 v4：崩溃件检查器（crash 对象 → research/list 的 fuzz 分拣结论；
  // V4-S2 起内容驻 SidePane「检查器」页签——overlay 开关 inspectorOpen 随壳
  // 退役，过滤指纹 inspectorFilter 留 store，入口动作 openCrashInspector 驱动页签）
  /** 过滤指纹（crashClass；null = 全量）。 */
  inspectorFilter: string | null;
  crashEvents: CrashEvent[];
  crashEventsLoading: boolean;

  // 1.3.1 ⑤：boot 进度
  boot: BootState | null;

  // 1.3.7：新建环境向导（状态机纯函数在 model/env-wizard.ts）+ 域清单
  wizard: EnvWizardState | null;
  /** domain/list 结果（确认页 recipe→domain 映射；拉取失败保持 []）。 */
  domains: DomainEntity[];

  // UI 面板
  overlay: OverlayState | null;
  modal: ModalState | null;
  drawer: DrawerState | null;
  page: Page;
  /** 打开设置页时的初始页签（StatusBar 的模式角标 → 'connection'；默认 'model'）。 */
  settingsTab: string;
  toast: string | null;
  toastNonce: number;
  /** V4-S1 状态行回执通道（✓ 动作确认；nonce 变化驱动 StatusBar 短暂高亮）。 */
  receipt: { text: string; nonce: number } | null;
  /** 历史 overlay 选中 → 回填输入框的一次性载荷。 */
  inputFill: { text: string; nonce: number } | null;

  // V4-S3 命令中枢（Ctrl+K）——独立面板面，不动 OverlayState（一门两窗：
  // 输入行 `/` 仍走 overlay，Ctrl+K 走本面；执行统一 execSlashCommand 出口）。
  paletteOpen: boolean;
  paletteText: string;
  paletteSel: number;
  /** 当前候选（setPaletteText 内重算；推导见 model/command-palette）。 */
  paletteItems: PaletteItem[];
  /** 执行历史（LRU 8 条；openPalette 时从 localStorage 载，成功后落盘）。 */
  paletteHistory: string[];

  // actions
  init(): void;
  dispose(): void;
  reconnect(): void;
  refreshSidebar(): Promise<void>;
  switchEnv(key: string): Promise<void>;
  /** 2.0-M2 注视语义：只读查看某环境的线（忙碌环境切执行现场被拒时的归宿）。 */
  peekEnv(envKey: string): Promise<void>;
  exitPeek(): void;
  /** 2.0-M4b：环境面板开合 + 记录拉取（auto-run/list → 在干什么/最近完成）。 */
  toggleEnvPanel(): void;
  closeEnvPanel(): void;
  loadEnvRuns(): Promise<void>;
  startEnv(itemKey: string): Promise<void>;
  /** 1.3.7 场景 3：重推环境能力集合（environment/capability-refresh → 刷新侧栏）。 */
  refreshEnvCapability(envId: string): Promise<void>;
  requestEnvProvision(target: { id: string; label: string; missing: string[] }): void;
  confirmEnvProvision(): Promise<void>;
  /** 1.3.5 ④：本机发现条目「选中即注册」（environment/add → 入侧栏 → 运行中则切入）。
   *  1.6.14：返回结果（失败带错误文案）——向导 busy 模态据此定格错误。 */
  registerDiscovered(itemKey: string, extras?: RegisterExtras): Promise<{ ok: boolean; error?: string }>;
  /** 1.3.7 补口：侧栏「删除」入口——运行中拦截 toast，否则开确认模态。 */
  requestEnvRemove(target: EnvRemoveTarget): void;
  /** 1.3.7 补口：确认删除（environment/rm → 成功 refreshSidebar + toast；失败 toast 服务端错误原文）。 */
  confirmEnvRemove(): Promise<void>;
  /** 1.3.8 ①：侧栏运行中行「停止」入口——开确认模态（文案在 model/env-down）。 */
  requestEnvDown(target: EnvDownTarget): void;
  /** 1.3.8 ①：确认停止（environment/down → 成功 refreshSidebar + toast；失败 toast 服务端错误原文）。 */
  confirmEnvDown(): Promise<void>;
  /** 1.5.10：镜像行「启动为环境」（environment/up {recipe}——镜像在则秒开 + 服务端回写登记）。 */
  startImageEnv(itemKey: string): Promise<void>;
  /** 1.5.10：环境行 ⋯「重新构建…」入口——开确认模态（文案在 model/env-rebuild）。 */
  requestEnvRebuild(target: EnvRebuildTarget): void;
  /** 1.5.10：确认重建（environment/rebuild → 成功 refreshSidebar + toast；失败保留模态）。 */
  confirmEnvRebuild(): Promise<void>;
  /** 1.5.10：docker 环境行 ⋯「重置容器…」入口——开确认模态（文案在 model/env-rebuild）。 */
  requestEnvReset(target: EnvResetTarget): void;
  /** 1.5.10：确认重置（environment/reset → 成功 refreshSidebar + toast；失败保留模态）。 */
  confirmEnvReset(): Promise<void>;
  /** 1.6.6：环境行 ⋯「重命名…」入口——开改名模态（只动 name 显示名，id 身份不变）。 */
  requestEnvRename(target: { id: string; label: string; name?: string }): void;
  /** 1.6.6：确认改名（environment/rename → 成功用 data.environments 刷新 + toast；失败保留模态）。 */
  confirmEnvRename(name: string): Promise<void>;
  /** 2.0-M1 台账治理：同名重复登记合并（keepId 保留、dropId 只摘登记）。 */
  mergeEnv(keepId: string, dropId: string): Promise<void>;
  /** 2.0-M1 僵尸清理：拉候选（只读；组件侧给模态用）。失败返回空表。 */
  fetchPruneCandidates(): Promise<api.PruneCandidate[]>;
  /** 2.0-M1 僵尸清理：勾选执行（逐个环境 rm，失败聚合 toast）。 */
  applyPrune(ids: string[]): Promise<void>;
  /** 1.3.8 多配方：侧栏 ℹ 入口——开环境详情模态（登记条目快照）。 */
  openEnvDetail(envId: string): void;
  /** 1.3.8 多配方：应用绑定集合（environment/bind-recipes → 成功关模态 + refreshSidebar + toast）。 */
  applyEnvBindings(recipeIds: string[]): Promise<void>;
  send(text: string): Promise<void>;
  stopTurn(): Promise<void>;
  runReset(): Promise<void>;
  setModel(providerId: string, model: string): Promise<void>;
  openOverlay(kind: OverlayKind, query: string): void;
  closeOverlay(): void;
  moveOverlay(delta: number): void;
  pickOverlay(index: number): void;
  openNewEnv(prefill?: { discoveredKey?: string }): void;
  /** 1.3.7 场景 1：向导「VM 配方构建」次级入口——改为认领已有 VM（adopt 模板养成）。 */
  openAdopt(recipeId: string): void;
  closeModal(): void;
  setModal(modal: ModalState | null): void;
  // 1.3.7：新建环境向导 actions（分发逻辑在 wizardExecute）
  wizardPickSource(source: WizardSource): void;
  wizardSetParam(key: keyof WizardParams, value: string | string[]): void;
  wizardNextStep(): void;
  wizardBackStep(): void;
  wizardExecute(): Promise<void>;
  submitAdopt(vmx: string, user: string, keyPath: string, password: string, passwordRef?: string): Promise<void>;
  bootEnv(recipeId: string): Promise<void>;
  submitSlashArg(value: string): Promise<void>;
  /** 1.5.2：输入区直输 / 命令（doSend 的命令解析入口——isKnownCommand 判定
   *  在调用侧，本 action 只管执行；inlineArgs 可空）。 */
  execSlashCommand(cmd: string, inlineArgs?: string): Promise<void>;
  /** 1.5.2：Tab 补全——slash overlay 当前项回填输入框（不执行，继续输参数）。 */
  completeSlashOverlay(): void;
  pickMessageTarget(id: string): Promise<void>;
  // 1.3.1 ②：boundary
  respondBoundaryAsk(askId: string, approve: boolean, note?: string): Promise<void>;
  dismissBoundaryAsk(askId: string): void;
  // 1.3.2 ①：decision
  respondDecision(decisionId: string, choice: string, note?: string): Promise<void>;
  dismissDecision(decisionId: string): void;
  openDecision(decisionId: string): void;
  // 1.4.1：auto loop
  openAutoRunStart(): void;
  submitAutoRun(input: AutoRunFormView): Promise<void>;
  requestStopAutoRun(): void;
  confirmStopAutoRun(): Promise<void>;
  dismissAutoRunCard(): void;
  loadAutoRunState(): Promise<void>;
  // 1.4.4 研究档案（分屏看板）
  applyArchiveChanged(payload: unknown): void;
  loadArchive(sessionId?: string): Promise<void>;
  correctArchiveEntity(id: string, reason: string): Promise<void>;
  resolveArchiveEntity(id: string): Promise<void>;
  abandonArchiveEntity(id: string, reason: string): Promise<void>;
  setArchiveHighlight(id: string | null): void;
  /** 档案锚 → 流跳转（只写不清：nonce 递增驱动 Stream 滚动消费）。跳流时
      把 SidePane「档案」页签开到前台——锚的上下文保持可见（决策②修订：原
      archiveDrawerOpen 语义整体搬进 SidePane）。 */
  jumpToArchiveAnchor(messageId: string): void;
  // 1.3.2 ①：promote（决策块入专家库）
  submitPromote(entry: Record<string, unknown>): Promise<{ ok: boolean; message: string }>;
  // 1.3.2 ③：主题
  toggleTheme(): void;
  setTheme(mode: ThemeMode): void;
  // 1.3.1 ③④：tasks / queue
  /** V4-S2：「任务」页签数据节奏——切到该页签重拉 taskList + campaignList。 */
  refreshTasksTab(): Promise<void>;
  backToList(): void;
  selectTaskRow(key: string): Promise<void>;
  /** 1.6.8 M2：战役卡片「终止」——开二次确认模态（campaign/stop）。 */
  requestCampaignStop(target: { id: string; goal: string }): void;
  /** 1.6.8 M2：确认终止（成功关模态 + 重拉 campaign 行 + toast；失败保留模态）。 */
  confirmCampaignStop(): Promise<void>;
  /** 1.6.8 M2：战役卡片「续命」（campaign/resume，仅 paused 态；成功重拉 + toast）。 */
  resumeCampaign(id: string): Promise<void>;
  // 1.8.7 P3b：研究线动作（B6/B7——line/list 一等对象视图；面板壳见 SidePane）
  /** 重拉线清单（不置 open；「线」页签打开 / share/unshare 成功后复用同一路径）。 */
  refreshLines(): Promise<void>;
  /** 切到指定线（/sessions/switch 同 resumeSession 语义；busy 类错误服务端裁决,
   *  文案原样 toast——与 resumeSession 的本地闸不同,切线交给服务端排它）。 */
  switchToLine(loopSessionId: string): Promise<void>;
  /** 私有线 → 共享线（line/share；无权时服务端 403,toast 原文）。 */
  shareLine(loopSessionId: string): Promise<void>;
  /** 共享线 → 私有线（line/unshare,归属改登记为调用方）。 */
  unshareLine(loopSessionId: string): Promise<void>;
  // 第四批 v4：崩溃件检查器（research/list fuzz 桶——crash 对象双击进入；
  // V4-S2：动作名保留、驱动 SidePane「检查器」页签）
  /** 打开「检查器」页签；filter = crashClass 指纹（缺省 null = 全量）。crashEvents 为空
   *  且非 loading 时惰性拉一次 researchList——只此一次不造定时器。 */
  openCrashInspector(filter?: string | null): void;
  /** 重拉 fuzz 分拣事件（面板 ⟳ 用；失败保持空清单不阻塞——lines 同款静默）。 */
  refreshCrashEvents(): Promise<void>;
  /** 1.9.20 挂证据到档案：崩溃事件 → archive/op evidence 入参一键落 V# 实体。
   *  成功回执（带新实体 id）；失败 toast 服务端 error 原文。返回成功与否供
   *  按钮本地「已挂」标注。 */
  attachEvidence(evId: number | null): Promise<boolean>;
  openQueuePanel(): Promise<void>;
  closeQueuePanel(): void;
  cancelQueueItem(queueId: string): Promise<void>;
  // 1.3.1 ⑥：settings
  submitExpertImport(raw: string): Promise<{ ok: boolean; message: string }>;
  openDrawer(detail: ToolDetail): void;
  closeDrawer(): void;
  setDrawerSearch(q: string): void;
  setPage(page: Page): void;
  /** 打开设置页并指定初始页签（模式角标直达「连接」）。 */
  openSettingsTab(tab: string): void;
  showToast(msg: string): void;
  clearToast(): void;
  /** V4-S1 回执通道：动作确认沉底状态行（✓ 文本，2200ms 自隐——调用点 S5 全量接线）。 */
  showReceipt(text: string): void;
  // V4-S1 骨架壳：右侧检查面板（SidePane）开关/页签/宽度
  /** 打开面板；tab 缺省保持当前页签。切到「线」页签沿用浮层时代的数据节奏（重拉 line/list）。
      开合即持久化（V4-S2：收起过一次就永远记住）。 */
  openSidePane(tab?: SidePaneTab): void;
  closeSidePane(): void;
  /** 分割条 dblclick 的同一入口（收起 ↔ 展开）。 */
  toggleSidePane(): void;
  setSidePaneTab(tab: SidePaneTab): void;
  setSidePaneWidth(width: number): void;
  // V4-S3 命令中枢（Ctrl+K）：开/关/输入/导航/选中/历史。
  /** 开面板：清输入、载历史（localStorage）、重算目录态候选。 */
  openPalette(): void;
  closePalette(): void;
  /** 输入变化：重算候选 + 选中归零（同 openOverlay 逐键重推节奏）。 */
  setPaletteText(t: string): void;
  movePaletteSel(delta: number): void;
  /** 统一出口：动词未带参 → 回填 /verb 继续输参（同 Tab 语义）；带参/
      对象/历史 → execSlashCommand 直执行 + 记历史 + 关面板。at 供鼠标点选。 */
  pickPalette(at?: number): void;
  pushPaletteHistory(cmdline: string): void;
  addRef(ref: Ref): void;
  removeRef(index: number): void;
  addHistory(text: string): void;
  // 1.3.3 历史面板：清单 / 会话管理 / 载回续跑
  openHistoryPanel(force?: boolean): Promise<void>;
  closeHistoryPanel(): void;
  renameSession(id: string, title: string): Promise<void>;
  toggleSessionPinned(id: string): Promise<void>;
  toggleSessionArchived(id: string): Promise<void>;
  deleteSessionRow(id: string): Promise<void>;
  resumeSession(id: string): Promise<void>;
  /** 1.6.11：chat:init 后锚定当前会话线的任务形态（admin session/mission
   *  线态直读——未绑定会话也可读，派任务前先定形态）。 */
  loadMission(): Promise<void>;
  /** 1.6.11：设定当前会话任务形态（session/mission {mission}；null = 清除回无类型）。 */
  setMission(kind: string | null): Promise<void>;
  esc(): void;
}

// 模块级单例（连接生命周期跨 action 存在；不进 state 避免渲染抖动）。
let client: GuiSidecarClient | null = null;
let abortController: AbortController | null = null;
let connecting = false;
let lifecycleGen = 0;
/** 启动环境恢复只做一次（chat:init 的 workspace 到达后）。 */
let envRestoreDone = false;
/** V4-S4 决策④：启动路由只判定一次——初始环境解析落定后烧掉，不随后续
 *  状态（中途删环境/掉宿主等）自动跳正门；中途进出正门全是显式动作。 */
let gateRouteDone = false;
/** boot 轮询句柄（dispose / 重复 boot 时清理）。 */
let bootPollTimer: ReturnType<typeof setInterval> | null = null;

// 1.3.3 @ 补全数据源缓存（模块级；不在 state 里避免渲染抖动）。
/** 子代理清单（GET /api/agents，首个 @ 补全拉取后缓存）。 */
let agentsCache: AgentEntity[] | null = null;
/** 文件树缓存：dir 前缀 → 条目（workspace/files 按目录前缀缓存）。 */
const filesCache = new Map<string, WorkspaceFileEntry[]>();
/** @ 补全异步富化代次（关闭/换查询后过期结果丢弃）。 */
let mentionGen = 0;
/** 侧栏刷新代次（1.3.10：并发 refreshSidebar 旧轮快照后写防护，照 mentionGen）。 */
let sidebarGen = 0;
/** 1.3.4：@ 补全富化防抖计时器（新查询替换旧的待发请求）。 */
let mentionTimer: ReturnType<typeof setTimeout> | null = null;

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

// 1.4.4 研究档案分屏偏好已随决策②修订退役（V4-S3）：archiveRatio/archiveSwapped
// 的 localStorage 读取点一并删除——旧键留盘不读，自然作废。

// V4-S1 检查面板宽度偏好（localStorage 持久化,照 archiveRatio 的做法）。
const SIDE_PANE_WIDTH_KEY = 'zhishi.gui.sidePaneWidth';
// V4-S2 纠偏：开合偏好持久化（'1' 展开 / '0' 收起；无键 = 未表态，按屏宽默认）。
const SIDE_PANE_OPEN_KEY = 'zhishi.gui.sidePaneOpen';

/** 回执自隐调度器（模块级单例：clearTimeout 语义见 model/side-pane.ts）。 */
const receiptScheduler = new ReceiptScheduler();

function readSidePaneWidth(): number {
  const raw = browserStorage()?.getItem(SIDE_PANE_WIDTH_KEY);
  const n = Number(raw);
  return Number.isFinite(n) && n >= SIDE_PANE_MIN_WIDTH ? Math.round(n) : SIDE_PANE_DEFAULT_WIDTH;
}

function persistSidePaneOpen(open: boolean): void {
  browserStorage()?.setItem(SIDE_PANE_OPEN_KEY, open ? '1' : '0');
}

/** 命令中枢候选推导的数据源快照（store 状态 → 纯函数 ctx）。 */
function paletteCtx(s: GuiState): PaletteSources {
  return {
    lines: s.lines,
    campaigns: s.campaigns,
    missions: MISSION_OPTIONS,
    envs: s.envs,
    runningIds: runningIdsOf(s),
    slashCommands: SLASH_COMMANDS,
    history: s.paletteHistory,
  };
}

/** 运行中环境 id 集合（EnvEntry 无 state 字段——运行态以 ps 现场列表为准）。 */
function runningIdsOf(s: GuiState): ReadonlySet<string> {
  return new Set(s.running.map((r) => r.id).filter((id): id is string => typeof id === 'string' && !!id));
}

function currentSession(s: GuiState): SessionState {
  return s.sessions[s.currentEnvKey ?? 'host'] ?? emptySession();
}

export const useGuiStore = create<GuiState>()((set, get) => ({
  connectionState: 'discovering',
  connectError: null,

  envs: [],
  running: [],
  discoveredDocker: [],
  discoveredVm: [],
  discoveredImages: [],
  recipes: [],
  models: [],
  workspace: null,
  currentEnvKey: null,

  sessions: {},
  history: {},
  refs: [],

  boundaryAsks: [],
  bgTasks: [],
  subagents: [],

  decisions: [],
  activeDecisionId: null,
  theme: loadTheme(browserStorage()),

  autoRun: null,

  // 1.4.4 研究档案（分屏看板）
  archive: null,
  archiveSessionId: null,
  archiveHighlightId: null,
  archiveJumpTarget: null,

  tools: [],

  historySessions: null,
  historyError: null,
  mission: null,
  mentionApply: null,

  tasksSelected: null,
  campaigns: [],  queueOpen: false,
  queueServer: [],

  // 1.8.7 P3b：研究线清单（面板壳 = SidePane「线」页签）
  lines: [],
  linesLoading: false,

  // V4-S1 骨架壳：右侧检查面板（默认开合按屏宽判定一次——宽屏展开/窄屏收起；
  // 用户收起/展开过一次则以记忆值为准，见 model/side-pane.ts::initialSidePaneOpen）
  sidePaneOpen: initialSidePaneOpen(
    browserStorage()?.getItem(SIDE_PANE_OPEN_KEY) ?? null,
    typeof window !== 'undefined' ? window.innerWidth : WIDE_SCREEN_MIN,
  ),
  sidePaneTab: 'lines',
  peekView: null,
  envPanelOpen: false,
  envRuns: [],
  sidePaneWidth: readSidePaneWidth(),

  // 第四批 v4：崩溃件检查器（过滤指纹；内容壳 = SidePane「检查器」页签）
  inspectorFilter: null,
  crashEvents: [],
  crashEventsLoading: false,

  boot: null,

  wizard: null,
  domains: [],

  overlay: null,
  modal: null,
  drawer: null,
  page: 'chat',
  settingsTab: 'model',
  toast: null,
  toastNonce: 0,
  receipt: null,
  inputFill: null,

  // V4-S3 命令中枢（Ctrl+K）——初始关闭；历史惰性到 openPalette 才载
  //（启动不背 localStorage 读）。
  paletteOpen: false,
  paletteText: '',
  paletteSel: 0,
  paletteItems: [],
  paletteHistory: [],

  // ── 连接 ────────────────────────────────────────────────────────────

  init() {
    if (connecting || client) return;
    connecting = true;
    const gen = ++lifecycleGen;
    envRestoreDone = false;
    gateRouteDone = false; // 新连接生命周期 = 新的启动路由判定窗口
    void (async () => {
      const { invoke } = tauriInvoke();
      const search = typeof window !== 'undefined' ? window.location.search : '';

      // ── 1.8.7 P0.5 团队大脑（远端模式）──────────────────────────────
      // 连接设置持久化在 localStorage（model/connection.ts）。远端分支：
      // base = 归一化后的 server URL（设置回显与错误文案都用真实地址）；
      // 2.0.3 起 Tauri 成员的流量走本机回环中继（remote_relay——内建
      // 等价 ssh -L 的哑 TCP 管道，绕开 webview 混合内容/CORS 双闸）：
      // client 实际打 http://127.0.0.1:<relayPort>，由 Rust spawn 的
      // relay.cjs 转发到团队大脑。浏览器 dev 无 Rust 可依赖，维持直连
      // （混合内容拦截依旧，可自架 ssh -L / portproxy，见用户指南 §10）。
      const conn = loadConnection(browserStorage());
      if (conn.mode === 'remote') {
        let base: string;
        try {
          base = normalizeServerUrl(conn.serverUrl);
        } catch {
          connecting = false;
          set({
            connectionState: 'failed',
            connectError: `团队大脑地址非法：${conn.serverUrl || '（空）'}（设置 → 连接 修改，例：http://10.0.0.8:7411）`,
          });
          return;
        }
        let clientBase = base;
        if (invoke) {
          // spawn 抑制信号 + 中继端口经同一 IPC（幂等 ensure，稳态一次锁内
          // 比较）；未就绪返回 null 继续等，超时进失败态——绝不静默回落本机。
          const relayPort = await pollRemoteRelayPort((cmd, args) => invoke(cmd, args), base);
          if (gen !== lifecycleGen) return; // dispose / re-init 竞态
          if (relayPort === null) {
            connecting = false;
            set({
              connectionState: 'failed',
              connectError: `本地中继启动失败（团队大脑 ${base}）——详见日志（~/.zhishi/logs/unified-*.log），点「重试」`,
            });
            return;
          }
          clientBase = `http://127.0.0.1:${relayPort}`;
        }
        set({ connectionState: 'connecting', connectError: null });
        client = new GuiSidecarClient({ base: clientBase, token: conn.token.trim() ? conn.token.trim() : undefined });
        const probe = await client.probeHealth();
        if (gen !== lifecycleGen) return;
        if (!probe.ok) {
          connecting = false;
          client = null;
          set({
            connectionState: 'failed',
            // probe 传输层消息里嵌的是中继地址——换回升维前的真实大脑地址，
            // 用户照此排查网络/token，而不是对着 127.0.0.1 发愣。
            connectError: `无法连接团队大脑（${base}）：${probe.error.replaceAll(clientBase, base)}`,
          });
          return;
        }
        void get().refreshSidebar();
        void loadModels(get, set);
        get().reconnect();
        return;
      }

      // ── 本机模式（默认，零变更路径）────────────────────────────────
      const port = await resolvePort({
        invoke,
        storage: browserStorage(),
        search,
      });
      if (gen !== lifecycleGen) return; // dispose / re-init 竞态
      if (!port) {
        connecting = false;
        set({
          connectionState: 'failed',
          connectError: '未发现 sidecar 端口（应用就绪后点「重试」）',
        });
        return;
      }
      set({ connectionState: 'connecting', connectError: null });
      // 2.0.5：本机模式同样携带连接设置里的 token——auth 开启后本机
      // sidecar 一样过鉴权闸（回环无豁免），本机模式客户端此前不带
      // token 导致 401 死循环「连接中」。auth 未启用时多一个请求头无害
      // （服务端忽略）。
      client = new GuiSidecarClient({
        base: `http://127.0.0.1:${port}`,
        token: conn.token.trim() ? conn.token.trim() : undefined,
      });
      void get().refreshSidebar();
      void loadModels(get, set);
      get().reconnect();
    })();
  },

  dispose() {
    lifecycleGen++;
    abortController?.abort();
    abortController = null;
    client = null;
    connecting = false;
    stopBootPolling();
  },

  reconnect() {
    const c = client;
    if (!c) return;
    abortController?.abort();
    const ac = new AbortController();
    abortController = ac;
    void (async () => {
      // 单事件归约管线（原 SSE 循环体原样抽成闭包）——1.6.3 refs 外溢占位
      // 取回全文后按原事件名重走同一管线，真假 payload 归约口径一致。
      const handleInput = (input: SseInput): void => {
          const state = get();
          const key = state.currentEnvKey ?? 'host';
          const session = state.sessions[key] ?? emptySession();
          const res = reduceSseEvent(session, input);
          set((s) => {
            const patch: Partial<GuiState> = {
              sessions: { ...s.sessions, [key]: res.session },
              connectionState: 'live',
              connectError: null,
            };
            if (res.workspace) {
              patch.workspace = res.workspace;
              // 1.3.2 任务二 #2：chat:init 带 environment 锚时走锚定路径
              // （下方 applyInitEnvAnchor），旧 environment/current 仅兜底。
              if (res.environment === undefined) void restoreEnvSelection(get, set, res.workspace);
            }
            if (res.toast) {
              patch.toast = res.toast;
              patch.toastNonce = s.toastNonce + 1;
            }
            if (res.boundaryAsk) {
              patch.boundaryAsks =
                res.boundaryAsk.type === 'upsert'
                  ? upsertBoundaryAsk(s.boundaryAsks, {
                      askId: res.boundaryAsk.askId,
                      kind: res.boundaryAsk.kind,
                      objects: res.boundaryAsk.objects,
                      toolName: res.boundaryAsk.toolName,
                      toolDescription: res.boundaryAsk.toolDescription,
                      options: res.boundaryAsk.options,
                    })
                  : removeBoundaryAsk(s.boundaryAsks, res.boundaryAsk.askId);
            }
            if (res.bgEvent) patch.bgTasks = applyBgEvent(s.bgTasks, res.bgEvent);
            if (res.subagentEvent) patch.subagents = applySubagentEvent(s.subagents, res.subagentEvent);
            // 1.4.1：auto loop 登记表（auto-run:* → applyAutoRunEvent 归并）。
            if (res.autoRun) {
              const next = applyAutoRunEvent(s.autoRun, res.autoRun);
              patch.autoRun = next;
              // 终态到达 → toast（按 outcome 回报）。
              if (res.autoRun.kind === 'completed' && next) {
                patch.toast =
                  res.autoRun.outcome === 'passed'
                    ? '✓ auto loop 达成'
                    : res.autoRun.outcome === 'exited'
                      ? '✗ auto loop 已退出（provider 故障）'
                      : '⏹ auto loop 已停止（预算耗尽或 Esc）';
                patch.toastNonce = s.toastNonce + 1;
              }
            }
            // 1.3.3 @ 补全：chat:system-init 广播的工具名清单。
            if (res.tools) patch.tools = res.tools;
            // 1.3.2 ①：决策登记表（init reset → replay upsert → resolved remove）
            if (res.decisionRequest || res.decisionResolved) {
              let decisions = s.decisions;
              if (res.decisionRequest?.type === 'reset') decisions = [];
              if (res.decisionRequest?.type === 'upsert') {
                decisions = upsertDecision(decisions, res.decisionRequest);
              }
              if (res.decisionResolved) {
                decisions = removeDecision(decisions, res.decisionResolved.decisionId);
              }
              patch.decisions = decisions;
              // 新决策到达且当前无弹窗 → 自动弹（重连重放 upsert 同此路径；
              // 按 decisionId 去重，不会重复弹）。
              if (res.decisionRequest?.type === 'upsert' && s.activeDecisionId === null) {
                patch.activeDecisionId = res.decisionRequest.decisionId;
              }
              // 激活指针再验证：展示中的决策已不在登记表 → 弹下一个（或收起）。
              if (s.activeDecisionId !== null && !hasDecision(decisions, s.activeDecisionId)) {
                patch.activeDecisionId = decisions[0]?.decisionId ?? null;
              }
            }
            return patch;
          });
          // 1.3.2 任务二 #2：chat:init 环境锚（免 environment/current 绕行）。
          if (res.environment !== undefined) {
            applyInitEnvAnchor(get, set, res.environment);
          }
          // 1.4.1：每次(重)连的 chat:init 前导 → 用 auto-run/list 恢复活跃
          // loop 快照（SSE 不重放 auto-run 事件族，断线期间的阶段/暂停/验收
          // 状态只能从 list 端点补回）。
          if (input.event === 'chat:init') void get().loadAutoRunState();
          // 1.4.4 研究档案：chat:init 重锚当前线的档案（SSE 不重放 archive
          // 事件——断线期间的变更由 archive/list 补回）。
          if (input.event === 'chat:init') void get().loadArchive();
          // 1.6.11：chat:init 重锚当前线的任务形态（session/mission 线态
          // 直读——切换/重连/reset 后选择器与徽章跟着走）。
          if (input.event === 'chat:init') void get().loadMission();
          // 1.6.11：chat:mission-changed——形态变更广播（setMission 回包之外
          // 的来源：CLI/其他客户端），本地状态即时跟进，不等重连。
          if (input.event === 'chat:mission-changed') {
            const p = input.payload as { mission?: unknown } | null;
            const m = p && typeof p.mission === 'string' ? p.mission : null;
            set({ mission: { kind: m } });
          }
          // 1.4.4 研究档案：archive:changed 整包快照（单槽设计——同一时刻
          // 只有一条活跃线写档案,直接覆盖;高亮指针若被纠正清空则复位）。
          if (input.event === 'archive:changed') {
            get().applyArchiveChanged(input.payload);
            const snap = get().archive;
            if (snap && get().archiveHighlightId && !snap.entities.some((e) => e.id === get().archiveHighlightId)) {
              set({ archiveHighlightId: null });
            }
          }
          // 2.0-M4b（WREN 反馈②：环境干完任务不知道）：auto-run 终态全局广播
          // → 状态行回执（无论哪个环境收口都看得见）；环境面板开着就顺手刷新
          // 行内「最近完成」。
          if (input.event === 'auto-run:completed') {
            const p = input.payload as { outcome?: unknown } | null;
            const outcome = p && typeof p.outcome === 'string' ? p.outcome : '';
            const label = outcome === 'passed' ? '已通过' : outcome === 'stopped' ? '已终止' : '已退出';
            get().showReceipt(`auto loop 结束：${label}`);
            if (get().envPanelOpen) void get().loadEnvRuns();
          }
          // 1.4.7 SSE 漏面收口：chat:session-title-changed——auto-titler/人改
          // 标题后，已加载的历史行就地换标题（不重拉清单）。
          if (input.event === 'chat:session-title-changed') {
            const rows = get().historySessions;
            if (rows) {
              const next = applySessionTitleChange(rows, input.payload as { sessionId?: unknown; title?: unknown });
              if (next !== rows) set({ historySessions: next });
            }
          }
      };
      // 1.6.3 refs 大值外溢（debt #2 消费端）：payload 为 {kind:'ref'} 占位时——
      //   ① 占位行同步落流位置（时序红线：占位先到位、全文后填充，不重排）；
      //   ② 异步 GET /refs/:id 取回全文，按原事件名重走 handleInput 原位归约
      //      （tool-result-complete 按 toolUseId 原位更新；auto-run/archive 等
      //      登记表按 id 归并，均与到达先后无关）；
      //   ③ 404（GC/TTL 过期）→ 占位行转 expired 降级展示 preview；传输错误
      //      → failed。abort（重连/卸载）后到达的结果直接丢弃——重连 replay
      //      会重建该线。
      const handleRefPayload = (event: string, ref: LargeValueRef): void => {
        const key = get().currentEnvKey ?? 'host';
        set((s) => ({
          sessions: {
            ...s.sessions,
            [key]: appendRefPlaceholder(s.sessions[key] ?? emptySession(), event, ref),
          },
        }));
        void (async () => {
          try {
            const text = await c.getRefText(ref.id);
            if (ac.signal.aborted) return;
            let payload: unknown;
            try {
              payload = JSON.parse(text);
            } catch {
              payload = text; // 非 JSON 原文兜底（与 sse-client toInput 同口径）
            }
            handleInput({ event, payload });
            set((s) => ({
              sessions: {
                ...s.sessions,
                [key]: resolveRefPlaceholder(s.sessions[key] ?? emptySession(), ref.id, 'done'),
              },
            }));
          } catch (err) {
            if (ac.signal.aborted) return;
            const outcome = err instanceof GuiHttpError && err.status === 404 ? 'expired' : 'failed';
            console.warn(
              `[refs] 全文取回失败 event=${event} ref=${ref.id}（${outcome}）:`,
              err instanceof Error ? err.message : String(err),
            );
            set((s) => ({
              sessions: {
                ...s.sessions,
                [key]: resolveRefPlaceholder(s.sessions[key] ?? emptySession(), ref.id, outcome),
              },
            }));
          }
        })();
      };
      try {
        for await (const input of c.openSse('/chat/stream', {
          signal: ac.signal,
          onReconnect: (_attempt, _cause) => {
            set({ connectionState: 'reconnecting' });
          },
        })) {
          // refs 外溢占位：不走 reduceSseEvent（payload 里没有可归约字段），
          // 由 handleRefPayload 落占位 + 异步取回后重放真 payload。
          if (isLargeValueRef(input.payload)) {
            handleRefPayload(input.event, input.payload);
            continue;
          }
          handleInput(input);
        }
      } catch (err) {
        if (!ac.signal.aborted) {
          set({
            connectionState: 'failed',
            connectError: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
  },

  // ── 侧栏数据 ────────────────────────────────────────────────────────

  async refreshSidebar() {
    const c = client;
    if (!c) return;
    // 1.3.10：代次治理（照 enrichMention 的 mentionGen 模式）——触发面 7 处
    // 并发调用时，旧轮快照后写会覆盖新轮快照；本轮令牌过期即整体丢弃
    // （归并判定在 model/sidebar.ts 的 mergeSidebarSnapshot）。
    const token = ++sidebarGen;
    const [envs, running, discover, recipes, domains] = await Promise.allSettled([
      api.fetchEnvironmentList(c),
      api.fetchEnvironmentPs(c),
      api.fetchEnvironmentDiscover(c),
      api.fetchEnvironmentRecipes(c),
      api.fetchDomainList(c),
    ]);
    const merged = mergeSidebarSnapshot(token, sidebarGen, get(), {
      envs: envs.status === 'fulfilled' ? envs.value : undefined,
      running: running.status === 'fulfilled' ? running.value : undefined,
      discover: discover.status === 'fulfilled' ? discover.value : undefined,
      recipes: recipes.status === 'fulfilled' ? recipes.value : undefined,
      domains: domains.status === 'fulfilled' ? domains.value : undefined,
    });
    if (!merged) return; // 已有更新的刷新轮——过期快照丢弃
    set({ ...merged });
  },

  // ── 环境切换（1.3.2 ③ A 形态：换激活指针，不丢任何线的本地状态） ──

  async switchEnv(key: string) {
    const state = get();
    const c = client;
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    // 1.4.1：auto loop 运行期环境锁定（启动即锁定，运行中不可换）。
    if (isAutoRunActive(state.autoRun)) {
      state.showToast('auto loop 运行中——环境已锁定（Esc 终止 loop 后再切换）');
      return;
    }
    if (!state.workspace) {
      state.showToast('工作区尚未就绪（等待 chat:init）');
      return;
    }
    const plan = planSwitch(state.currentEnvKey, state.sessions, key);
    if (!plan.changed) return; // 目标线已是激活线
    const res = await api.environmentSelect(c, state.workspace, { kind: 'env', id: key });
    if (!res.success) {
      state.showToast(`切换失败：${res.error ?? '未知错误'}`);
      return;
    }
    // A 形态：保留目标线现有会话状态（含未完成渲染的流）——重连 replay
    // 按 wire id 幂等续上；旧激活线原样冻结在 sessions 里，切回即续。
    set({
      currentEnvKey: plan.envKey,
      sessions: plan.sessions,
      drawer: null,
      overlay: null,
      page: 'chat',
    });
    get().reconnect();
    void get().refreshSidebar();
    // S5 双轨：动作成功 → 状态行回执（toast 轨道留给错误/需留意）。
    get().showReceipt(`已切环境 ${key}`);
  },

  /** 2.0-M2 注视语义：只读查看任意环境的线——peek 查线 + 拉 wire transcript，
   *  全程不触引擎（不 switchEnvSession、不开新线）。忙碌环境切执行现场被拒时
   *  由 switchEnv 转入本路径；原线继续跑，看完 exitPeek 回，现场无损。 */
  async peekEnv(envKey) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    if (!state.workspace) {
      state.showToast('工作区尚未就绪（等待 chat:init）');
      return;
    }
    try {
      const res = await api.environmentPeek(c, { workspace: state.workspace, envKey });
      const loopSessionId = res.success ? res.data?.loopSessionId ?? null : null;
      if (!loopSessionId) {
        state.showToast(`环境 ${envKey} 还没有线——切过去开一条即可（当前线运行中的话等它跑完）`);
        return;
      }
      const lines = (await api.fetchLoopTranscript(c, loopSessionId)) ?? [];
      set({ peekView: { envKey, loopSessionId, lines } });
    } catch (err) {
      state.showToast(`只读查看失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  exitPeek() {
    set({ peekView: null });
  },

  /** 2.0-M4b 环境面板：开=拉记录（auto-run/list 全量，行内"在干什么/最近
   *  完成"的数据源）；关=零成本。 */
  toggleEnvPanel() {
    const next = !get().envPanelOpen;
    set({ envPanelOpen: next });
    if (next) void get().loadEnvRuns();
  },

  closeEnvPanel() {
    set({ envPanelOpen: false });
  },

  async loadEnvRuns() {
    const c = client;
    const state = get();
    if (!c) return;
    // 战役叙事（audit P3）：campaign 记录无 envKey，靠 lines 的 envKey 映射——
    // lines 未载时先拉一次（面板打开一次的代价，换"在干什么"完整）。
    if (state.lines.length === 0) void state.refreshLines();
    const [runsRes, campRes] = await Promise.all([
      api.autoRunList(c).catch(() => null),
      api.campaignList(c, state.workspace ?? undefined).catch(() => null),
    ]);
    try {
      const res = runsRes as { success?: boolean; data?: { records?: unknown } } | null;
      const records = Array.isArray(res?.data?.records) ? res.data.records : [];
      const runs = records
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r))
        .map((r) => ({
          id: typeof r.id === 'string' ? r.id : undefined,
          name: typeof r.name === 'string' ? r.name : undefined,
          envKey: typeof r.envKey === 'string' ? r.envKey : undefined,
          status: typeof r.status === 'string' ? r.status : undefined,
        }));
      const patch: Partial<GuiState> = { envRuns: runs };
      const camp = campRes as { success?: boolean; data?: { records?: unknown } } | null;
      if (camp?.success) patch.campaigns = parseCampaignRecords(camp.data?.records);
      set(patch);
    } catch {
      /* 记录拉取失败不阻塞面板（行内"在干什么"留空即降级） */
    }
  },

  // ── 1.3.1 ①：启动已停止环境（docker/vm 都走 environment/up） ──────

  async startEnv(itemKey: string) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    const entry = state.envs.find((e) => e.id === itemKey);
    if (!entry) {
      state.showToast('未找到该环境条目');
      return;
    }
    // 1.5.10：主配方缺省 = 绑定集合首项（登记 + 只绑配方的条目也能启动）；
    // entry.id 回落保留旧语义（服务端 recipes 找不到会报错，不改）。
    const recipe = startRecipeFor(entry);
    state.showToast(`▶ 启动 ${entry.id}（${recipe}）…`);
    try {
      const res = await api.environmentUp(c, {
        recipe,
        workspace: state.workspace ?? undefined,
      });
      if (!res.success) {
        state.showToast(`启动失败：${res.error ?? '未知错误'}`);
        return;
      }
      void state.refreshSidebar();
      state.showReceipt(`已启动 ${entry.id}`);
    } catch (err) {
      state.showToast(`启动失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── 1.3.7 场景 3：能力集合手动刷新（重推 + 回写，透明展示推导结果） ──

  async refreshEnvCapability(envId: string) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    state.showToast(`⏳ 重推 ${envId} 能力集合…`);
    try {
      const res = await api.environmentCapabilityRefresh(c, { id: envId });
      if (!res.success) {
        state.showToast(`能力重推失败：${res.error ?? '未知错误'}`);
        return;
      }
      void state.refreshSidebar();
      const domains = res.data?.capabilityDomains ?? [];
      // S5 双发：回执给确认感（短），toast 给详情（能力域清单）——信息量大
      // 的动作是双轨的正确用法，不是冗余。
      state.showReceipt(`能力已重推 ${envId}`);
      state.showToast(`✓ ${envId} 能力：${domains.join(' · ') || '（无）'}`);
    } catch (err) {
      state.showToast(`能力重推失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  /** 1.4.9 补齐链路：对已有环境重放配方安装脚本（确认模态在
   *  Modal/EnvProvisionModal——改机器状态的显式动作）。成功后服务端已
   *  自动重推能力，这里刷新侧栏即可。 */
  requestEnvProvision(target) {
    set({ modal: { kind: 'env-provision', envProvision: target } });
  },

  async confirmEnvProvision() {
    const c = client;
    const state = get();
    const target = state.modal?.envProvision;
    if (!target) return;
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    try {
      const res = await api.environmentSetup(c, { id: target.id });
      if (!res.success) {
        const tail = res.data?.results?.find((r) => r.ok === false)?.logTail;
        // 失败保留模态（可重试/取消），toast 服务端错误原文 + 日志尾部。
        state.showToast(`补齐失败：${res.error ?? '未知错误'}${tail ? `\n${tail.slice(-300)}` : ''}`);
        return;
      }
      set({ modal: null });
      void state.refreshSidebar();
      const missing = res.data?.capabilityMissing;
      // S5 双发：回执短句确认；「仍缺 N 项」是后续要留意的信息，走 toast。
      state.showReceipt(`${target.label} 补齐完成`);
      state.showToast(
        `✓ ${target.label} 补齐完成${missing?.length ? `——探测面仍缺 ${missing.length} 项` : '，探测面全在场'}`,
      );
    } catch (err) {
      state.showToast(`补齐失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── 1.3.5 ④：本机发现「选中即注册」（TUI gate.ts:262-298 同语义） ──

  async registerDiscovered(itemKey: string, extras?: RegisterExtras) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return { ok: false, error: '未连接 sidecar' };
    }
    const item = findDiscoveredItem(state, itemKey);
    if (!item) {
      state.showToast('未找到该本机条目');
      return { ok: false, error: '未找到该本机条目' };
    }
    const payload = buildRegisterPayload(item, extras);
    if (!payload) {
      state.showToast('该条目缺少登记所需信息（名字/驱动）');
      return { ok: false, error: '该条目缺少登记所需信息（名字/驱动）' };
    }
    state.showToast(`⏳ 登记 ${payload.id}…`);
    try {
      const res = await api.environmentAdd(c, payload);
      if (!res.success) {
        const errText = `登记失败：${res.error ?? '未知错误'}`;
        state.showToast(errText);
        return { ok: false, error: errText };
      }
      void state.refreshSidebar();
      state.showReceipt(`已登记 ${payload.id}`);
      // 运行中才尝试切入（docker Up / VM running）；停着的只入侧栏
      //（无配方的已停止条目切过去是死线，等启动后再进）。
      if (isDiscoveredRunning(item)) {
        await state.switchEnv(payload.id);
      }
      return { ok: true };
    } catch (err) {
      const errText = `登记失败：${err instanceof Error ? err.message : String(err)}`;
      state.showToast(errText);
      return { ok: false, error: errText };
    }
  },

  // ── 1.3.7 补口：删除已登记环境（environment/rm；确认模态文案在 model/env-remove） ──

  requestEnvRemove(target) {
    const plan = envRemovePlan(target);
    if (!plan.allowed) {
      get().showToast(plan.blockToast ?? '该环境暂不可删除');
      return;
    }
    set({ modal: { kind: 'env-remove', envRemove: target } });
  },

  async confirmEnvRemove() {
    const c = client;
    const state = get();
    const target = state.modal?.envRemove;
    if (!target) return;
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    try {
      const res = await api.environmentRemove(c, { id: target.id });
      if (!res.success) {
        // 失败保留模态（可重试/取消），toast 服务端错误原文。
        state.showToast(`删除失败：${res.error ?? '未知错误'}`);
        return;
      }
      set({ modal: null });
      void state.refreshSidebar();
      state.showReceipt(`已删除 ${target.label}`);
    } catch (err) {
      state.showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── 1.3.8 ①：停止运行中环境（environment/down；确认模态文案在 model/env-down） ──

  requestEnvDown(target) {
    set({ modal: { kind: 'env-down', envDown: target } });
  },

  async confirmEnvDown() {
    const c = client;
    const state = get();
    const target = state.modal?.envDown;
    if (!target) return;
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    try {
      const res = await api.environmentDown(c, { id: target.id });
      if (!res.success) {
        // 失败保留模态（可重试/取消），toast 服务端错误原文。
        state.showToast(`停止失败：${res.error ?? '未知错误'}`);
        return;
      }
      set({ modal: null });
      void state.refreshSidebar();
      state.showReceipt(`已停止 ${target.label}`);
    } catch (err) {
      state.showToast(`停止失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── 1.6.6 环境别名：重命名（environment/rename——只动 name 显示名，id 身份不变） ──

  requestEnvRename(target) {
    set({ modal: { kind: 'env-rename', envRename: target } });
  },

  async confirmEnvRename(name) {
    const c = client;
    const state = get();
    const target = state.modal?.envRename;
    if (!target) return;
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    const trimmed = name.trim();
    try {
      const res = await api.environmentRename(c, { id: target.id, name: trimmed });
      if (!res.success) {
        // 失败保留模态（可重试/取消），toast 服务端错误原文。
        state.showToast(`改名失败：${res.error ?? '未知错误'}`);
        return;
      }
      set({ modal: null });
      // 服务端返回最新全量列表——直接写回环境状态（同 environment/list 口径）；
      // 缺 data 的旧 sidecar 回落 refreshSidebar。
      if (res.data?.environments) set({ envs: res.data.environments });
      else void state.refreshSidebar();
      state.showReceipt(trimmed ? `已改名 ${trimmed}` : '已清除别名');
    } catch (err) {
      state.showToast(`改名失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  /** 2.0-M1 台账治理：同名重复登记合并——keep 保留、drop 只摘登记（服务端
   *  双守卫：同名/同目标）。成功后 refreshSidebar 让正门列表即时收敛。 */
  async mergeEnv(keepId, dropId) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    if (!keepId || !dropId || keepId === dropId) {
      state.showToast('合并参数无效（需要两个不同条目）');
      return;
    }
    try {
      const res = await api.environmentMerge(c, { keepId, dropId });
      if (!res.success) {
        state.showToast(`合并失败：${res.error ?? '未知错误'}`);
        return;
      }
      void state.refreshSidebar();
      state.showReceipt(`已合并 ${dropId} → ${keepId}`);
    } catch (err) {
      state.showToast(`合并失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  /** 2.0-M1 僵尸清理：候选清单（只读）。组件侧模态直接消费返回值，
   *  不进全局状态——一次性数据不常驻（同 /tasks 的"看一眼即散"纪律）。 */
  async fetchPruneCandidates() {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return [];
    }
    try {
      const res = await api.environmentPruneList(c);
      if (!res.success) {
        state.showToast(`清理候选加载失败：${res.error ?? '未知错误'}`);
        return [];
      }
      return res.data?.candidates ?? [];
    } catch (err) {
      state.showToast(`清理候选加载失败：${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  },

  /** 2.0-M1 僵尸清理执行：服务端逐个走 environment/rm 完整语义
   *  （D14：删除的实体级后果在服务端 rm 内按 kind 分派），这里只回报结果。 */
  async applyPrune(ids) {
    const c = client;
    const state = get();
    if (!c || ids.length === 0) {
      if (!c) state.showToast('未连接 sidecar');
      return;
    }
    try {
      const res = await api.environmentPruneApply(c, ids);
      const removed = res.data?.removed ?? [];
      if (res.success) {
        state.showReceipt(`已清理 ${removed.length} 个环境`);
      } else {
        state.showToast(`清理部分失败：${res.error ?? '未知错误'}`);
      }
      void state.refreshSidebar();
    } catch (err) {
      state.showToast(`清理失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── 1.5.10：镜像行「启动为环境」+ 显式重建/重置（镜像为主三层模型） ──

  async startImageEnv(itemKey: string) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    const img = state.discoveredImages.find((d) => d.id === itemKey);
    const recipe = img ? imageStartRecipe(img) : null;
    if (!img || !recipe) {
      state.showToast('该镜像缺少配方归属（recipeId），无法启动');
      return;
    }
    // 镜像行 = 从镜像派生新容器（fresh=true——不激活同配方的已停止老容器，
    // 老容器现场不动；1.5.10 语义修正，用户拍板）。
    state.showToast(`▶ 从镜像 ${img.name ?? img.id} 启动环境（${recipe}）…`);
    try {
      const res = await api.environmentUp(c, {
        recipe,
        workspace: state.workspace ?? undefined,
        fresh: true,
      });
      if (!res.success) {
        state.showToast(`启动失败：${res.error ?? '未知错误'}`);
        return;
      }
      void state.refreshSidebar();
      state.showReceipt(`已启动 ${recipe}（镜像）`);
    } catch (err) {
      state.showToast(`启动失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  requestEnvRebuild(target) {
    set({ modal: { kind: 'env-rebuild', envRebuild: target } });
  },

  async confirmEnvRebuild() {
    const c = client;
    const state = get();
    const target = state.modal?.envRebuild;
    if (!target) return;
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    state.showToast(`⏳ 重新构建 ${target.recipe}（docker build，可能要几分钟）…`);
    try {
      const res = await api.environmentRebuild(c, {
        recipe: target.recipe,
        workspace: state.workspace ?? undefined,
      });
      if (!res.success) {
        // 失败保留模态（可重试/取消），toast 服务端错误原文。
        state.showToast(`重建失败：${res.error ?? '未知错误'}`);
        return;
      }
      set({ modal: null });
      void state.refreshSidebar();
      state.showReceipt(`已重建 ${target.label}`);
    } catch (err) {
      state.showToast(`重建失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  requestEnvReset(target) {
    set({ modal: { kind: 'env-reset', envReset: target } });
  },

  async confirmEnvReset() {
    const c = client;
    const state = get();
    const target = state.modal?.envReset;
    if (!target) return;
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    try {
      const res = await api.environmentReset(c, {
        id: target.id,
        workspace: state.workspace ?? undefined,
      });
      if (!res.success) {
        state.showToast(`重置失败：${res.error ?? '未知错误'}`);
        return;
      }
      set({ modal: null });
      void state.refreshSidebar();
      state.showReceipt(`已重置 ${target.label}`);
    } catch (err) {
      state.showToast(`重置失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── 1.3.8 多配方：环境详情模态（绑定=展示/构建来源；主配方不可移除） ──

  openEnvDetail(envId: string) {
    const state = get();
    const entry = state.envs.find((e) => e.id === envId);
    if (!entry) {
      state.showToast(`未找到环境 "${envId}"`);
      return;
    }
    set({ modal: { kind: 'env-detail', envDetail: entry } });
  },

  async applyEnvBindings(recipeIds: string[]) {
    const c = client;
    const state = get();
    const target = state.modal?.envDetail;
    if (!target) return;
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    try {
      const res = await api.environmentBindRecipes(c, { id: target.id, recipeIds });
      if (!res.success) {
        state.showToast(`绑定更新失败：${res.error ?? '未知错误'}`);
        return;
      }
      set({ modal: null });
      void state.refreshSidebar();
      state.showReceipt('已更新配方绑定');
    } catch (err) {
      state.showToast(`绑定更新失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── 发送 / 纠偏 / 中断 / 重置 ───────────────────────────────────────

  async send(text: string) {
    const c = client;
    if (!c) {
      get().showToast('未连接 sidecar');
      return;
    }
    // 1.4.1：auto loop 运行期仅观察——输入区已禁用，这里是兜底闸。
    if (isAutoRunActive(get().autoRun)) {
      get().showToast('auto loop 运行中，仅观察');
      return;
    }
    // 1.4.0 补充修复：一切操作都在环境内——未锚定环境（host）不发任何消息。
    if (!get().currentEnvKey) {
      get().showToast('请先选择环境——研究只发生在环境内');
      return;
    }
    const refs = get().refs;
    const body = buildSendBody(text, refs);
    get().addHistory(text);
    set({ refs: [] });
    try {
      const res = await api.sendChatMessage(c, body);
      if (!res.success) {
        get().showToast(`发送失败：${res.error ?? '未知错误'}`);
        return;
      }
      const outcome = classifySendResponse(res);
      // S5：发送被接受（纠偏/FIFO）= 动作成功的回执——原文案回显消息文本，
      // 消息本身在流里可见，回执不必复述（≤16 字）。
      if (outcome === 'steering') get().showReceipt('已插入纠偏');
      else if (outcome === 'fifo-queued') get().showReceipt('已排队（FIFO）');
    } catch (err) {
      get().showToast(`发送失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async stopTurn() {
    const c = client;
    if (!c) return;
    try {
      await api.stopChat(c);
    } catch (err) {
      get().showToast(`中断失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async runReset() {
    const c = client;
    if (!c) return;
    try {
      const res = await api.resetChat(c);
      if (!res.success) {
        get().showToast(`重置失败：${res.error ?? '未知错误'}`);
        return;
      }
      const key = get().currentEnvKey ?? 'host';
      set((s) => ({ sessions: { ...s.sessions, [key]: emptySession() } }));
      get().reconnect();
      get().showReceipt('对话已重置');
    } catch (err) {
      get().showToast(`重置失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async setModel(providerId: string, model: string) {
    const c = client;
    if (!c) return;
    try {
      const res = await api.setModel(c, model, providerId);
      if (!res.success) {
        get().showToast(`切换模型失败：${res.error ?? '未知错误'}`);
        return;
      }
      const key = get().currentEnvKey ?? 'host';
      set((s) => ({ sessions: { ...s.sessions, [key]: { ...currentSession(s), model } } }));
      get().showReceipt(`已切模型 ${model}`);
    } catch (err) {
      get().showToast(`切换模型失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── overlay ─────────────────────────────────────────────────────────

  openOverlay(kind, query) {
    const s = get();
    if (kind === 'slash') {
      // 1.5.2 实锤修复②：过滤只按命令名段（/intel CVE-2024-1234 按 intel
      // 过滤——此前把参数段一起前缀匹配，带参数输入面板必空）；参数段存进
      // overlay.slashArgs（选中执行时直发，修复③）。
      const nameSeg = slashNameSegment(`/${query}`);
      const slashArgs = parseSlashInput(`/${query}`)?.args ?? '';
      // v4 对象补全：命令名已输完（精确命中已知命令）且该命令有对象表 →
      // items 换成对象过滤结果（/resume muz 直接选线，不再背 id）；中途
      // （/res）仍走下面的命令名前缀过滤。
      if (nameSeg && isKnownCommand(nameSeg)) {
        const objects = slashObjectItems({ name: nameSeg, args: slashArgs }, {
          lines: s.lines,
          campaigns: s.campaigns,
          missions: MISSION_OPTIONS,
          envs: s.envs,
          runningIds: runningIdsOf(s),
        });
        if (objects !== null) {
          // 对象源明显过期（清单为空）时惰性拉一次——openOverlay 随击键重入，
          // 模块级闸保证不每击键一发 campaign/list（参照 refreshTasksTab 拉法）。
          if (nameSeg === 'resume' && s.lines.length === 0) {
            ensureSlashObjectsHydrated('lines', () => void get().refreshLines());
          }
          if (nameSeg === 'kill' && s.campaigns.length === 0) {
            ensureSlashObjectsHydrated('campaigns', () => void refreshCampaigns(get, set));
          }
          set({ overlay: { kind, title: `命令 /${nameSeg} · 选对象`, items: objects, sel: 0, slashArgs, slashObjCommand: nameSeg } });
          return;
        }
      }
      const items = SLASH_COMMANDS.filter((c) => c.name.startsWith(nameSeg)).map((c) => ({
        name: `/${c.name}`,
        detail: c.detail,
        tag: c.group,
      }));
      set({ overlay: { kind, title: '命令', items, sel: 0, slashArgs } });
      return;
    }
    if (kind === 'at') {
      // 1.3.3 @ 补全：触发解析 + 四源合一（envs 同步出；agents/tools 已缓存
      // 即同步出；files 按目录前缀缓存/异步补）。1.3.4：files 缓存键带环境
      // 作用域（防跨环境串线），异步富化改防抖调度（大目录输入节流）。
      const mq = parseMentionQuery(query);
      const items: OverlayItem[] = buildMentionItems(mq, {
        envs: s.envs,
        agents: agentsCache ?? [],
        tools: s.tools,
        files: mq.isFileDir ? filesCache.get(fileCacheKey(s.currentEnvKey, fileDirOf(mq))) ?? [] : [],
      }).map(toOverlayItem);
      if (items.length === 0 && !mq.isFileDir) {
        items.push({ name: '（无匹配引用）', detail: '@ 引用数据源：环境 / 子代理 / 工具', tag: '引用' });
      }
      if (items.length === 0 && mq.isFileDir) {
        items.push({ name: '（读取文件树…）', detail: `/api/workspace/files dir=${fileDirOf(mq) || '.'}`, tag: '文件', section: '文件' });
      }
      set({ overlay: { kind, title: '引用', items, sel: 0 } });
      scheduleMentionEnrich(get, set, mq);
      return;
    }
    if (kind === 'history') {
      const key = s.currentEnvKey ?? 'host';
      // 1.3.5：内存列表优先；重启后首次召回从 localStorage 惰性补读
      // （per-env 键，见 model/input-history.ts）。过滤从 includes 换成
      // 子序列评分排序（TUI 同源 scorer）。
      const list = s.history[key] ?? loadInputHistory(browserStorage(), key);
      const items = rankInputHistory(list, query, INPUT_HISTORY_OVERLAY_LIMIT).map((h) => ({ name: h }));
      set({ overlay: { kind, title: `历史 · ${query || '全部'}`, items, sel: 0 } });
      return;
    }
    if (kind === 'model') {
      // 1.3.6：只显示「已配 key 且未禁用」的 provider 模型（显示=可运行），
      // 当前生效模型即使异常也保留显示——过滤口径在 model/model-picker.ts。
      // 1.3.10：打开即重拉 model/list（设置页配 key 后 hasApiKey 已变，旧
      // 缓存会漏掉新可用模型）——先出当前快照，拉回后 loadModels 原地刷新。
      set({ overlay: { kind, title: '选择模型', items: modelOverlayItems(s), sel: 0 } });
      void loadModels(get, set);
    }
  },

  closeOverlay() {
    cancelMentionPending();
    set({ overlay: null });
  },

  moveOverlay(delta) {
    set((s) => {
      if (!s.overlay || s.overlay.items.length === 0) return {};
      const sel = (s.overlay.sel + delta + s.overlay.items.length) % s.overlay.items.length;
      return { overlay: { ...s.overlay, sel } };
    });
  },

  pickOverlay(index) {
    const s = get();
    const ov = s.overlay;
    if (!ov) return;
    const item = ov.items[index];
    cancelMentionPending(); // 选中即关 overlay——待发的 @ 富化请求一并作废
    set({ overlay: null });
    if (!item) return;

    switch (ov.kind) {
      case 'slash': {
        // 1.5.2 实锤修复③：inline 参数随命令直发 + 清空输入框。
        // v4 对象补全：对象模式 items 的 name 是对象 id（不是 /命令）——cmd
        // 取 overlay 记住的命令名，对象 id 走 slashArgs 参数；执行出口仍只有
        // runSlashCommand 这一条（与 doSend 直输同路径）。
        const cmd = ov.slashObjCommand ?? item.name.replace(/^\//, '');
        const args = ov.slashObjCommand ? item.name : ov.slashArgs;
        set({ inputFill: { text: '', nonce: (s.inputFill?.nonce ?? 0) + 1 } });
        void runSlashCommand(get, set, cmd, args);
        break;
      }
      case 'at': {
        // 1.3.3：ref → chips；insert → 替换输入框尾部 @token；旧环境行兜底。
        const nonce = (s.mentionApply?.nonce ?? 0) + 1;
        if (item.ref) {
          s.addRef(item.ref);
          set({ mentionApply: { replace: '', nonce } });
        } else if (item.insert !== undefined) {
          set({ mentionApply: { replace: item.insert, nonce } });
        } else if (s.envs.some((e) => e.id === item.name)) {
          s.addRef({ type: 'env', id: item.name });
          set({ mentionApply: { replace: '', nonce } });
        }
        break;
      }
      case 'history': {
        set({ inputFill: { text: item.name, nonce: (s.inputFill?.nonce ?? 0) + 1 } });
        break;
      }
      case 'model': {
        if (item.providerId && item.model) void s.setModel(item.providerId, item.model);
        break;
      }
    }
  },

  // ── 1.3.1 ②：boundary 应答 ─────────────────────────────────────────

  async respondBoundaryAsk(askId: string, approve: boolean, note?: string) {
    const c = client;
    const state = get();
    if (!state.boundaryAsks.some((a) => a.askId === askId)) return; // 幂等守卫
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    try {
      const res = await api.boundaryRespond(c, { askId, approve, note });
      if (!res.success && res.error?.includes('不存在') === false) {
        state.showToast(`应答失败：${res.error ?? '未知错误'}`);
      }
      // 404（已答/已过期）与成功都收模态——服务端注册表已无此 ask。
      set((s) => ({ boundaryAsks: removeBoundaryAsk(s.boundaryAsks, askId) }));
    } catch (err) {
      state.showToast(`应答失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  dismissBoundaryAsk(askId: string) {
    // Esc 语义：收起该 ask 的模态不作答——ask 保持 pending，服务端重连
    // replay 会重弹。本地摘除，避免模态一直挡住界面。
    set((s) => ({ boundaryAsks: removeBoundaryAsk(s.boundaryAsks, askId) }));
  },

  // ── 1.3.2 ①：决策应答 / 收起 / 重开 ───────────────────────────────

  async respondDecision(decisionId: string, choice: string, note?: string) {
    const c = client;
    const state = get();
    if (!hasDecision(state.decisions, decisionId)) return; // 幂等守卫
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    try {
      const res = await api.decisionRespond(c, { decisionId, choice, note });
      if (!res.success) {
        // 404（未知/已失效）/409（已答）：服务端注册表已无此决策——
        // 提示 + 摘除本地 + 重连重放刷新 pending 状态。
        state.showToast(`应答失败：${res.error ?? '未知错误'}`);
        set((s) => ({
          decisions: removeDecision(s.decisions, decisionId),
          activeDecisionId: s.activeDecisionId === decisionId ? null : s.activeDecisionId,
        }));
        get().reconnect();
        return;
      }
      set((s) => ({
        decisions: removeDecision(s.decisions, decisionId),
        activeDecisionId: s.activeDecisionId === decisionId ? null : s.activeDecisionId,
      }));
      state.showReceipt('决定已提交');
    } catch (err) {
      state.showToast(`应答失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  dismissDecision(decisionId: string) {
    // Esc 语义：收起不作答——decision 保持 pending，缩为会话头部待答
    // 指示（可点开重答）。注意：与 boundary-ask 不同，这里**不摘除**
    // 登记条目（重连 replay 会按 decisionId 去重，不会重复弹）。
    set((s) => (s.activeDecisionId === decisionId ? { activeDecisionId: null } : {}));
  },

  openDecision(decisionId: string) {
    if (hasDecision(get().decisions, decisionId)) {
      set({ activeDecisionId: decisionId });
    }
  },

  // ── 1.4.1：auto loop（启动 / 终止 / 加预算 / 验收终审 / 清单恢复） ──

  openAutoRunStart() {
    if (isAutoRunActive(get().autoRun)) {
      get().showToast('已有 auto loop 运行中——先观察或 Esc 终止');
      return;
    }
    set({ modal: { kind: 'auto-run-start' } });
  },

  async submitAutoRun(input: AutoRunFormView) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    const errors = validateAutoRunForm(input, state.envs);
    if (errors.length > 0) {
      state.showToast(errors[0].message);
      return;
    }
    const payload = buildAutoRunStartPayload(input);
    if (!payload) {
      state.showToast('表单不完整');
      return;
    }
    try {
      const res = await api.autoRunStart(c, payload);
      if (!res.success || !res.id) {
        state.showToast(`启动失败：${res.error ?? '未知错误'}`);
        return;
      }
      // 乐观条目（status starting）——观察卡立即出现；SSE auto-run:started
      // 到达后转正（applyAutoRunEvent 同 id 只翻状态，字段以本地为准）。
      // 1.5.13：loopSessionId 随回包带上（观察流轮询 run 线靠它）。
      set({
        modal: null,
        autoRun: optimisticAutoRunEntry(res.id, payload, undefined, res.loopSessionId),
      });
      // S5 双发：回执给确认感；loop 名是用户起的 goal，走 toast 留名。
      state.showReceipt('auto loop 已启动');
      state.showToast(`✓ auto loop 已启动：${payload.name}`);
    } catch (err) {
      state.showToast(`启动失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  requestStopAutoRun() {
    if (!get().autoRun) return;
    set({ modal: { kind: 'auto-run-stop' } });
  },

  async confirmStopAutoRun() {
    const c = client;
    const state = get();
    const id = state.autoRun?.id;
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    if (!id) return;
    try {
      const res = await api.autoRunStop(c, { id });
      if (!res.success) {
        state.showToast(`终止失败：${res.error ?? '未知错误'}`);
        return;
      }
      // 服务端无 'stopped' 事件（事件族只有 completed）——本地就地翻停，
      // 观察卡显示「已终止」，下次 chat:init 用 list 对账。
      set((s) => ({
        modal: null,
        autoRun:
          s.autoRun && s.autoRun.id === id
            ? { ...s.autoRun, status: 'stopped', updatedAt: Date.now() }
            : s.autoRun,
      }));
      state.showReceipt('auto loop 已终止');
    } catch (err) {
      state.showToast(`终止失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  dismissAutoRunCard() {
    // 终态后的观察卡关闭（活跃 loop 无此入口——只能 Esc 终止）。
    set({ autoRun: null });
  },

  async loadAutoRunState() {
    const c = client;
    if (!c) return;
    try {
      const raw = await api.autoRunList(c);
      const restored = activeAutoRunOf(raw);
      // 同 id 且本地更新 → 不覆盖（list 快照落后于在飞 SSE 事件）。
      // 1.6.0：守卫收口到 restoredAutoRunStale；配合 autoRunEntryOf 的 ISO
      // 解析（服务端记录 updatedAt 是 ISO 字符串）才真正生效。
      if (restoredAutoRunStale(get().autoRun, restored)) {
        return;
      }
      set({ autoRun: restored });
      // 1.4.6 dogfood 实证：恢复 active run 时按 run 的 loop 线加载研究档案——
      // 缺这步，auto-run 场景研究面板查的是引擎当前会话（空档案，面板恒空）。
      // （已完成 run 的档案不在此恢复——历史档案在历史回看中查看。）
      if (restored?.loopSessionId) void get().loadArchive(restored.loopSessionId);
    } catch {
      // 静默——恢复失败保持本地状态（list 端点未接线时不阻塞会话）。
    }
  },

  // ── 1.4.4 研究档案（分屏看板） ─────────────────────────────────────

  /** archive:changed 整包快照（2.0.2：按锚线过滤——GUI 是全量订阅，旧线
   *  （busy 安全切换后还在跑）的档案事件照样到达；不过滤会被旧线快照反复
   *  盖掉 = 「切环境档案丢失」。payload.sessionId ≠ 锚线 → 丢弃。）。 */
  applyArchiveChanged(payload: unknown) {
    if (!isArchiveSnapshotForLine(get().archiveSessionId, payload)) return;
    set({ archive: applyArchiveChangedPayload(payload) });
  },

  /** archive/list 重锚（chat:init 重连/切环境后;auto-run 面板按 run 线显式传）。 */
  async loadArchive(sessionId?: string) {
    const c = client;
    if (!c) return;
    try {
      // 1.4.6 dogfood 实证：active run 存在时缺省也锚 run 的 loop 线——
      // 否则 chat:init 的默认重锚会拿引擎当前会话的空档案覆盖 run 的档案。
      // （已完成 run 的档案不进面板——历史档案在历史回看中查看，1.4.6 用户拍板：
      // 面板 = 活的研究，完成的进历史。）
      const sid = sessionId
        ?? (isAutoRunActive(get().autoRun) && get().autoRun?.loopSessionId
          ? get().autoRun!.loopSessionId
          : undefined);
      const res = await api.fetchArchiveList(c, sid ? { sessionId: sid } : {});
      // 2.0.2 立锚：显式 sid > 回包 sessionId（服务端按调用方当前线解析）>
      // null。锚是跨线快照过滤的唯一事实源。
      const anchorId = sid ?? res.archive?.sessionId ?? null;
      if (res.ok && res.archive) set({ archive: res.archive, archiveSessionId: anchorId });
      else if (res.ok) set({ archive: null, archiveSessionId: anchorId });
      // 失败静默——档案缺失不阻塞会话（零注入语义同侧）。
    } catch {
      /* 静默 */
    }
  },

  /** 行内纠正（人 > 专家知识 > 模型自证伪;服务端广播 archive:changed 回来）。 */
  async correctArchiveEntity(id: string, reason: string) {
    const c = client;
    if (!c) return;
    const res = await api.postArchiveCorrect(c, { id, reason });
    if (!res.ok) {
      set({ toast: res.error ?? '纠正失败', toastNonce: get().toastNonce + 1 });
      return;
    }
    // S5：行内纠正成功 → 状态行回执；「下游标待复核」的详情语义留注释即可
    //（看板行自己会翻待复核态）。
    set({ archiveHighlightId: null });
    get().showReceipt(`已纠正 ${id}`);
  },

  /** 假设证实/问题解决（终态推进;服务端广播 archive:changed 回来）。 */
  async resolveArchiveEntity(id: string) {
    const c = client;
    if (!c) return;
    const res = await api.postArchiveResolve(c, { id });
    if (!res.ok) {
      set({ toast: res.error ?? '操作失败', toastNonce: get().toastNonce + 1 });
      return;
    }
    set({ archiveHighlightId: null });
    get().showReceipt(`${id} 已有终态`);
  },

  /** 搁置假设/问题（不追了≠错了;服务端广播 archive:changed 回来）。 */
  async abandonArchiveEntity(id: string, reason: string) {
    const c = client;
    if (!c) return;
    const res = await api.postArchiveAbandon(c, { id, reason });
    if (!res.ok) {
      set({ toast: res.error ?? '搁置失败', toastNonce: get().toastNonce + 1 });
      return;
    }
    // 「不追了≠错了，已留痕」是详情注记；确认感走回执。
    set({ archiveHighlightId: null });
    get().showReceipt(`${id} 已搁置`);
  },

  setArchiveHighlight(id: string | null) {
    set({ archiveHighlightId: id });
  },

  /** 档案锚 → 流跳转（只写不清：nonce 递增驱动 Stream 滚动消费）。 */
  jumpToArchiveAnchor(messageId: string) {
    set({
      archiveJumpTarget: { messageId, nonce: (get().archiveJumpTarget?.nonce ?? 0) + 1 },
    });
    // 决策②修订：档案唯一落位 SidePane「档案」页签——跳流时把页签开到前台，
    // 锚的上下文保持可见（原 archiveDrawerOpen:true 语义的整体搬迁）。
    get().openSidePane('archive');
  },

  // ── 1.3.2 ①：promote（决策块 → expert/add 入专家库） ─────────────

  async submitPromote(entry: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
    const c = client;
    if (!c) return { ok: false, message: '未连接 sidecar' };
    try {
      const res = await api.expertAdd(c, entry);
      if (res.success) return { ok: true, message: '✓ 已入专家库（provenance=user，reviewer 留档）' };
      return { ok: false, message: res.error ?? '入专家库失败' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  },

  // ── 1.3.2 ③：主题 ─────────────────────────────────────────────────

  toggleTheme() {
    const next = nextTheme(get().theme);
    set({ theme: next });
    applyThemeClass(next);
    persistTheme(next);
  },

  setTheme(mode: ThemeMode) {
    set({ theme: mode });
    applyThemeClass(mode);
    persistTheme(mode);
  },

  // ── 1.3.1 ③④：/tasks 面板（V4-S2 起内容驻 SidePane「任务」页签）/ /queue ──

  // V4-S2：原 openTasksPanel 的拉取逻辑原样搬此——「切到任务页签」即重拉
  // taskList + campaignList（开面板重拉节奏不变；失败保旧/置空不阻塞面板）。
  async refreshTasksTab() {
    const c = client;
    if (!c) return;
    try {
      serverTaskCache = (await api.taskList(c)) as ServerTaskLike[];
    } catch {
      serverTaskCache = [];
    }
    // 1.6.8 M2：战役观察卡片随页签切入同节奏刷新（复用既有「开面板重拉」，
    // 不新造定时器；拉取失败保持旧清单不阻塞面板）。
    try {
      const res = await api.campaignList(c, get().workspace ?? undefined);
      if (res.success) set({ campaigns: parseCampaignRecords(res.data?.records) });
    } catch {
      /* campaign/list 失败不阻塞任务中心 */
    }
  },

  backToList() {
    set({ tasksSelected: null });
  },

  async selectTaskRow(key: string) {
    const c = client;
    const state = get();
    if (!c) return;
    const row = selectTaskRows(state).find((r) => r.key === key);
    if (!row) return;
    // 第三批 v4：选中行只留对象卡指针——transcript 不再装配信号文本列表
    // （CampaignCard 按 campaignId 自取 record 自渲染 feed）；记录缺失时
    // transcript=null，面板回落原 transcript 渲染。
    if (row.campaignId) {
      set({
        tasksSelected: {
          title: row.name,
          detail: row.detail,
          transcript: null,
          campaignId: row.campaignId,
        },
      });
      return;
    }
    try {
      if (row.loopSessionId) {
        const transcript = await api.fetchLoopTranscript(c, row.loopSessionId);
        set({ tasksSelected: { title: row.name, detail: row.detail, transcript } });
      } else if (row.serverTaskId) {
        const detail = await api.taskGet(c, row.serverTaskId);
        const lines: LoopTranscriptLine[] = [];
        const rec = detail as Record<string, unknown> | null;
        if (rec && typeof rec === 'object') {
          for (const [k, v] of Object.entries(rec)) {
            if (k === 'status_history') continue;
            lines.push({ role: k, content: typeof v === 'string' ? v : JSON.stringify(v) });
          }
        }
        set({ tasksSelected: { title: row.name, detail: row.detail, transcript: lines } });
      } else {
        set({
          tasksSelected: {
            title: row.name,
            detail: row.detail,
            transcript: null,
          },
        });
      }
    } catch (err) {
      state.showToast(`取任务详情失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── 1.6.8 M2：战役卡片行内动作（campaign/stop|resume） ────────────────

  requestCampaignStop(target) {
    set({ modal: { kind: 'campaign-stop', campaignStop: target } });
  },

  async confirmCampaignStop() {
    const c = client;
    const state = get();
    const target = state.modal?.campaignStop;
    if (!target) return;
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    try {
      const res = await api.campaignStop(c, target.id);
      if (!res.success) {
        // 失败保留模态（可重试/取消），toast 服务端错误原文。
        state.showToast(`终止战役失败：${res.error ?? '未知错误'}`);
        return;
      }
      set({ modal: null });
      await refreshCampaigns(get, set);
      state.showReceipt('战役已终止');
    } catch (err) {
      state.showToast(`终止战役失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async resumeCampaign(id) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    try {
      const res = await api.campaignResume(c, id);
      if (!res.success) {
        state.showToast(`续命失败：${res.error ?? '未知错误'}`);
        return;
      }
      await refreshCampaigns(get, set);
      // 「预算重置起算」是后续要留意的信息，双发留 toast。
      state.showReceipt('战役已续命');
      state.showToast('✓ 战役已续命（paused → running，预算重置起算）');
    } catch (err) {
      state.showToast(`续命失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── V4-S1 骨架壳：右侧检查面板（SidePane）+ 状态行回执通道 ──────────────

  openSidePane(tab) {
    const patch: Partial<GuiState> = { sidePaneOpen: true };
    if (tab) patch.sidePaneTab = tab;
    set(patch);
    persistSidePaneOpen(true); // 开合即记住：下次启动/换屏宽都以此为准
    // 页签数据节奏沿用浮层时代语义：「线」打开即重拉 line/list（loading 即刻
    // 可见，拉取不阻塞面板）；「任务」重拉 taskList + campaignList。
    const target = tab ?? get().sidePaneTab;
    if (target === 'lines') void get().refreshLines();
    if (target === 'tasks') void get().refreshTasksTab();
  },

  closeSidePane() {
    set({ sidePaneOpen: false });
    persistSidePaneOpen(false); // 收起过一次就永远记住（不再自动弹）
  },

  toggleSidePane() {
    if (get().sidePaneOpen) get().closeSidePane();
    else get().openSidePane();
  },

  setSidePaneTab(tab) {
    set({ sidePaneTab: tab });
    if (tab === 'lines') void get().refreshLines();
    if (tab === 'tasks') void get().refreshTasksTab();
  },

  setSidePaneWidth(width) {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const clamped = clampSidePaneWidth(width, vw);
    set({ sidePaneWidth: clamped });
    browserStorage()?.setItem(SIDE_PANE_WIDTH_KEY, String(clamped));
  },

  showReceipt(text) {
    set((s) => ({ receipt: { text, nonce: (s.receipt?.nonce ?? 0) + 1 } }));
    // 新回执顶掉旧计时器——2200ms 窗口从最后一次动作起算（Toast effect 同语义）。
    receiptScheduler.schedule(() => set({ receipt: null }));
  },

  // ── V4-S3 命令中枢（Ctrl+K）─────────────────────────────────────────

  openPalette() {
    const history = loadPaletteHistory(browserStorage());
    set({
      paletteOpen: true,
      paletteText: '',
      paletteSel: 0,
      paletteHistory: history,
      paletteItems: buildPaletteItems('', { ...paletteCtx(get()), history }),
    });
  },

  closePalette() {
    set({ paletteOpen: false });
  },

  setPaletteText(t) {
    set({
      paletteText: t,
      paletteSel: 0,
      paletteItems: buildPaletteItems(t, paletteCtx(get())),
    });
  },

  movePaletteSel(delta) {
    set((s) => {
      if (s.paletteItems.length === 0) return {};
      const sel = (s.paletteSel + delta + s.paletteItems.length) % s.paletteItems.length;
      return { paletteSel: sel };
    });
  },

  pickPalette(at) {
    const s = get();
    const item = s.paletteItems[at ?? s.paletteSel];
    if (!item) return;
    const parsed = parseSlashInput(item.runCmdline);
    // 动词未带参 → 回填 /verb 继续输参（同 slash overlay 的 Tab 语义）。已
    // 在 /verb 态再选中同一动词（文本 trim 后 == runCmdline）则放行执行——
    // 否则无对象表的动词（/model 等）会在回填上死循环。
    if (item.kind === 'verb' && parsed && !parsed.args && s.paletteText.trim() !== item.runCmdline) {
      get().setPaletteText(`${item.runCmdline} `);
      return;
    }
    get().pushPaletteHistory(item.runCmdline);
    set({ paletteOpen: false });
    // 一门两窗的执行引擎出口：与输入行 / 直输同一 runSlashCommand 管线。
    if (parsed) void get().execSlashCommand(parsed.name, parsed.args);
  },

  pushPaletteHistory(cmdline) {
    const next = pushPaletteHistoryList(get().paletteHistory, cmdline);
    set({ paletteHistory: next });
    savePaletteHistory(browserStorage(), next);
  },

  // ── 1.8.7 P3b：研究线面板（line/list|share|unshare，B6/B7） ───────────

  async refreshLines() {
    const c = client;
    if (!c) return;
    // V4-S1：loading 置位收进本动作（浮层时代由 openLinesPanel 代劳）——
    // 「线」页签 ⟳ 刷新也要有拉取中提示。
    set({ linesLoading: true });
    const workspace = get().workspace;
    if (!workspace) {
      // chat:init 未至（workspace 未到）——清单置空等下一次拉取。
      set({ lines: [], linesLoading: false });
      return;
    }
    try {
      const res = await api.fetchLineList(c, workspace);
      // 失败保持空清单不阻塞面板（campaign/list 同款静默——权限/连接问题
      // 在 share/unshare/switch 的动作回执里会显形）。
      if (!res.success) {
        set({ lines: [], linesLoading: false });
        return;
      }
      set({
        lines: buildLineRows(parseLineList(res.data), { actorName: null }),
        linesLoading: false,
      });
    } catch {
      set({ lines: [], linesLoading: false });
    }
  },

  async switchToLine(loopSessionId: string) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    try {
      const res = await api.switchSession(c, loopSessionId);
      if (!res.success) {
        // busy/越权类错误文案原样展示（服务端裁决,前端不预判——切线无本地闸）。
        state.showToast(`切线失败：${res.error ?? '未知错误'}`);
        return;
      }
      set({ page: 'chat', drawer: null, overlay: null });
      get().reconnect();
      void get().refreshSidebar();
      get().showReceipt(`已切到线 ${shortLineId(loopSessionId)}`);
    } catch (err) {
      state.showToast(`切线失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async shareLine(loopSessionId: string) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    try {
      const res = await api.lineShare(c, loopSessionId);
      if (!res.success) {
        // 权限细化在服务端（403 forbidden）——文案原样 toast,前端不挡。
        state.showToast(`共享失败：${res.error ?? '未知错误'}`);
        return;
      }
      await get().refreshLines();
      get().showReceipt(`已共享线 ${shortLineId(loopSessionId)}`);
    } catch (err) {
      state.showToast(`共享失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async unshareLine(loopSessionId: string) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    try {
      const res = await api.lineUnshare(c, loopSessionId);
      if (!res.success) {
        state.showToast(`转私有失败：${res.error ?? '未知错误'}`);
        return;
      }
      await get().refreshLines();
      get().showReceipt(`已转私有 ${shortLineId(loopSessionId)}`);
    } catch (err) {
      state.showToast(`转私有失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── 第四批 v4：崩溃件检查器（research/list 的 fuzz 分拣结论桶） ────────

  openCrashInspector(filter = null) {
    // V4-S2：检查器从浮层迁入 SidePane「检查器」页签——动作名保留（CampaignCard
    // chips / 「显全部」入口零改动），驱动页签而非 overlay；筛选语义不变。
    set({ inspectorFilter: filter ?? null });
    get().openSidePane('inspector');
    // 惰性拉一次：crashEvents 为空且非 loading 才发请求（research/list 无
    // 轮询义务——数据靠面板 ⟳ 手动刷新;失败保持空,下次打开自然重试）。
    const s = get();
    if (s.crashEvents.length === 0 && !s.crashEventsLoading) {
      void get().refreshCrashEvents();
    }
  },

  async refreshCrashEvents() {
    const c = client;
    if (!c) return;
    set({ crashEventsLoading: true });
    try {
      const rows = await api.researchList(c);
      set({ crashEvents: parseCrashEvents(rows), crashEventsLoading: false });
    } catch {
      // 失败保持空清单不阻塞面板（campaign/lines 同款静默——权限/连接
      // 问题不该卡死 overlay 的开关）。
      set({ crashEvents: [], crashEventsLoading: false });
    }
  },

  async attachEvidence(evId) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return false;
    }
    const ev = state.crashEvents.find((e) => e.id === evId);
    if (!ev) {
      state.showToast('未找到该崩溃事件');
      return false;
    }
    const payload = evidencePayloadOf(ev);
    if (!payload.text) {
      // 指纹/结论双缺的事件没有可挂内容（parse 层已挡大部分，这是兜底）。
      state.showToast('该事件缺指纹与结论，无可挂内容');
      return false;
    }
    const res = await api.archiveOp(c, payload);
    if (!res.ok) {
      // 工具执行期校验（举证强度/终态门等）的纪律文本原样给人。
      state.showToast(`挂证据失败：${res.error ?? '未知错误'}`);
      return false;
    }
    // 服务端广播 archive:changed 会自动刷新研究面板——这里不重拉档案，
    // 只给确认感（有新实体 id 就报 id）。
    state.showReceipt(res.entityId ? `已挂证据 ${res.entityId}` : '已挂证据到档案');
    return true;
  },

  // ── 1.3.1 ④：/queue 面板 ────────────────────────────────────────────

  async openQueuePanel() {
    const c = client;
    set({ queueOpen: true, queueServer: [] });
    if (!c) return;
    try {
      const res = await api.fetchQueueStatus(c);
      set({ queueServer: res.queue ?? [] });
    } catch {
      set({ queueServer: [] });
    }
  },

  closeQueuePanel() {
    set({ queueOpen: false, queueServer: [] });
  },

  async cancelQueueItem(queueId: string) {
    const c = client;
    if (!c) return;
    try {
      const res = await api.cancelQueueItem(c, queueId);
      if (!res.success) {
        get().showToast(`取消失败：${res.error ?? '未知错误'}`);
        return;
      }
      get().showReceipt('已取消排队');
      const fresh = await api.fetchQueueStatus(c).catch(() => null);
      set({ queueServer: fresh?.queue ?? get().queueServer.filter((q) => q.id !== queueId) });
    } catch (err) {
      get().showToast(`取消失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── 模态 / 抽屉 / 页面 ──────────────────────────────────────────────

  openNewEnv(prefill) {
    if (get().recipes.length === 0) void get().refreshSidebar();
    // 1.3.7：新建入口 = 一个四步向导（状态机重置在 model/env-wizard.ts）。
    // 1.5.10：侧栏「本机已有」VM 条目的登记入口分流到向导 discovered 分支
    // 并预勾选该条目（直登拿不到 address，而探测/exec 通道需要它）。
    const wizard = initialWizardState();
    if (prefill?.discoveredKey) {
      wizard.step = 2;
      wizard.source = 'discovered';
      wizard.params.discoveredKey = prefill.discoveredKey;
    }
    set({ modal: { kind: 'new-env' }, wizard });
  },

  closeModal() {
    set({ modal: null, wizard: null });
  },

  // adopt 是模板养成（写 vmTemplates），与环境接入是两件事——从向导切过去
  // 时关掉向导态，认领会话的配方取当前向导所选（缺省 'vm'）。
  openAdopt(recipeId) {
    set({ wizard: null, modal: { kind: 'adopt', recipeId: recipeId || 'vm' } });
  },

  setModal(modal) {
    set({ modal });
  },

  // ── 1.3.7：新建环境向导（选源/收参/确认/执行；状态机在 model/env-wizard） ──

  wizardPickSource(source) {
    const s = get();
    if (!s.wizard) return;
    set({ wizard: wizardSelectSource(s.wizard, source, s.recipes) });
  },

  wizardSetParam(key, value) {
    const s = get();
    if (!s.wizard) return;
    set({ wizard: { ...s.wizard, params: { ...s.wizard.params, [key]: value } } });
  },

  wizardNextStep() {
    const s = get();
    if (!s.wizard) return;
    set({ wizard: wizardNext(s.wizard) });
  },

  wizardBackStep() {
    const s = get();
    if (!s.wizard) return;
    set({ wizard: wizardBack(s.wizard) });
  },

  async wizardExecute() {
    const state = get();
    const w = state.wizard;
    if (!w) return;
    const payload = buildWizardPayload(w);
    if (!payload) {
      state.showToast('向导参数不完整');
      return;
    }
    if (payload.type === 'up') {
      // 复用 BootModal 的进度轮询：换模态即触发 bootEnv（bootOpts 透传 VM 凭据）。
      set({
        wizard: null,
        modal: {
          kind: 'boot',
          recipeId: payload.input.recipe,
          bootOpts: { user: payload.input.user, keyPath: payload.input.keyPath },
        },
      });
      return;
    }
    if (payload.type === 'register') {
      const key = payload.itemKey;
      const extras = payload.extras;
      // 1.6.14：登记过程可视化——密码引导的密钥配置可能几十秒，toast 会
      // 自动消失，此前看起来「没反应」（实机反馈）。busy 模态撑到结果出来；
      // 失败时错误定格在模态里（不再一闪而过）。
      set({
        wizard: null,
        modal: { kind: 'env-registering' },
      });
      const r = await get().registerDiscovered(key, extras);
      if (get().modal?.kind === 'env-registering') {
        if (r.ok) set({ modal: null });
        else set({ modal: { kind: 'env-registering', registerError: r.error ?? '登记失败' } });
      }
      return;
    }
    // ssh-add：environment/add 真实落盘（host/user/keyPath 必填已在状态机校验）。
    const c = client;
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    try {
      const res = await api.environmentAdd(c, payload.input);
      if (!res.success) {
        state.showToast(`SSH 接入失败：${res.error ?? '未知错误'}`);
        return;
      }
      set({ wizard: null, modal: null });
      void get().refreshSidebar();
      get().showReceipt(`已登记 ${payload.input.id}`);
    } catch (err) {
      state.showToast(`SSH 接入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async submitAdopt(vmx: string, user: string, keyPath: string, password: string, passwordRef?: string) {
    const c = client;
    const state = get();
    if (!c) return;
    const recipeId = state.modal?.recipeId ?? '';
    state.showToast(`⏳ 认领模板 ${recipeId}（连通 → 初始化 → 快照）…`);
    try {
      const res = await api.environmentAdopt(c, {
        recipe: recipeId,
        vmx,
        user: user || undefined,
        keyPath: keyPath || undefined,
        password: password || undefined,
        // 1.5.10：凭据引用（不落盘）——服务端透传进 vmTemplates 模板。
        passwordRef: passwordRef || undefined,
      });
      if (!res.success) {
        state.showToast(`认领失败：${res.error ?? '未知错误'}`);
        return;
      }
      set({ modal: null });
      // 「快照 zhishi-clean」是详情，双发留 toast。
      state.showReceipt('模板已养成');
      state.showToast(`✓ 模板 ${recipeId} 已养成（快照 zhishi-clean）`);
    } catch (err) {
      state.showToast(`认领失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── 1.3.1 ⑤：boot 真链路（up + 轮询 ps 推阶段） ────────────────────

  async bootEnv(recipeId: string) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    const recipe = state.recipes.find((r) => r.id === recipeId);
    const stages = bootStages(recipe?.base);
    // 1.3.7：向导带入的 VM 凭据（environment/up 的 user/keyPath，空不下发）。
    const bootOpts = state.modal?.kind === 'boot' ? state.modal.bootOpts : undefined;
    stopBootPolling();
    set({ boot: { recipeId, base: recipe?.base, stage: 0, status: 'running' } });
    const advance = (to: number) => {
      set((s) =>
        s.boot && s.boot.status === 'running' && s.boot.stage < to
          ? { boot: { ...s.boot, stage: Math.min(to, stages.length - 1) } }
          : {},
      );
    };
    // 轮询 environment/ps：实例出现 → 跳到「工具自检」阶段（倒二）。
    const seenIds = new Set(state.running.map((r) => r.id));
    bootPollTimer = setInterval(() => {
      void api.fetchEnvironmentPs(c).then((instances) => {
        if (instances.some((i) => i.id && !seenIds.has(i.id))) {
          advance(stages.length - 2);
          stopBootPolling();
        }
      }).catch(() => { /* 轮询失败不阻断——up 结果为准 */ });
    }, 2000);
    try {
      const res = await api.environmentUp(c, {
        recipe: recipeId,
        workspace: state.workspace ?? undefined,
        ...(bootOpts?.user ? { user: bootOpts.user } : {}),
        ...(bootOpts?.keyPath ? { keyPath: bootOpts.keyPath } : {}),
      });
      stopBootPolling();
      if (!res.success) {
        set({ boot: { recipeId, base: recipe?.base, stage: stages.length - 1, status: 'failed', error: res.error } });
        state.showToast(`构建失败：${res.error ?? '未知错误'}`);
        return;
      }
      set({ boot: { recipeId, base: recipe?.base, stage: stages.length, status: 'done' } });
      await state.refreshSidebar();
      state.showReceipt(`构建完成 ${recipeId}`);
      // 1.3.7：完成入侧栏后，仅当环境运行中才自动切入（workspace 就绪前提）。
      if (get().workspace) {
        const target = findRunningEnvForRecipe(recipeId, get().envs, get().running);
        if (target) await get().switchEnv(target);
      }
    } catch (err) {
      stopBootPolling();
      set({
        boot: { recipeId, base: recipe?.base, stage: stages.length - 1, status: 'failed', error: err instanceof Error ? err.message : String(err) },
      });
      state.showToast(`构建失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── 1.3.1 ④：slash 参数收集与执行 ──────────────────────────────────

  async submitSlashArg(value: string) {
    const state = get();
    const command = state.modal?.command;
    if (!command) return;
    set({ modal: null });
    await executeSlash(get, set, command, value);
  },

  /** 1.5.2：doSend 的命令解析出口——/ 开头且匹配已知命令时执行（含 inline
   *  参数直发），不匹配由调用方按普通文本发送。 */
  async execSlashCommand(cmd, inlineArgs) {
    await runSlashCommand(get, set, cmd, inlineArgs);
  },

  /** Tab 补全：slash overlay 当前项回填「/name 」到输入框（不执行——继续
   *  输参数，Enter 才执行；inputFill 通道带回焦点）。v4 对象补全：对象
   *  模式回填「/命令 id 」——裸 id 会失去 / 前缀被当普通文本发给 LLM。 */
  completeSlashOverlay() {
    const ov = get().overlay;
    if (!ov || ov.kind !== 'slash') return;
    const item = ov.items[ov.sel];
    const text = ov.slashObjCommand
      ? item
        ? `/${ov.slashObjCommand} ${item.name} `
        : `/${ov.slashObjCommand} `
      : item
        ? `${item.name} `
        : '/';
    set({
      overlay: null,
      inputFill: { text, nonce: (get().inputFill?.nonce ?? 0) + 1 },
    });
  },

  async pickMessageTarget(id: string) {
    const state = get();
    const command = state.modal?.command;
    if (!command) return;
    set({ modal: null });
    await executeSlash(get, set, command, id);
  },

  // ── 1.3.1 ⑥：专家导入（解析后逐条 expert/add） ─────────────────────

  async submitExpertImport(raw: string) {
    const c = client;
    const parsed = parseExpertImport(raw);
    if (!parsed.ok) return { ok: false, message: parsed.error };
    if (!c) return { ok: false, message: '未连接 sidecar' };
    let okCount = 0;
    const failures: string[] = [];
    for (const entry of parsed.entries) {
      const res = await api.expertAdd(c, entry);
      if (res.success) okCount++;
      else failures.push(typeof entry.title === 'string' ? entry.title : res.error ?? '未知错误');
    }
    if (failures.length === 0) return { ok: true, message: `✓ 导入成功：${okCount} 条已入库` };
    return {
      ok: okCount > 0,
      message: `导入完成：${okCount} 条成功，${failures.length} 条失败（${failures.slice(0, 3).join('；')}）`,
    };
  },

  openDrawer(detail: ToolDetail) {
    set({
      drawer: {
        toolId: detail.id,
        name: detail.name,
        args: detail.argsSummary,
        output: detail.output,
        state: detail.state,
        exitCode: detail.exitCode,
        elapsedMs: detail.elapsedMs,
        search: '',
      },
    });
  },

  closeDrawer() {
    set({ drawer: null });
  },

  setDrawerSearch(q: string) {
    set((s) => (s.drawer ? { drawer: { ...s.drawer, search: q } } : {}));
  },

  setPage(page) {
    set({ page });
  },

  openSettingsTab(tab) {
    set({ page: 'settings', settingsTab: tab });
  },

  showToast(msg) {
    set((s) => ({ toast: msg, toastNonce: s.toastNonce + 1 }));
  },

  clearToast() {
    set({ toast: null });
  },

  addRef(ref) {
    set((s) => {
      if (s.refs.some((r) => r.type === ref.type && 'id' in ref && 'id' in r && r.id === ref.id)) {
        return {};
      }
      return { refs: [...s.refs, ref] };
    });
  },

  removeRef(index) {
    set((s) => ({ refs: s.refs.filter((_, i) => i !== index) }));
  },

  addHistory(text) {
    const key = get().currentEnvKey ?? 'host';
    // 1.3.5：per-env 落盘——内存列表优先，首次写入前从 localStorage 补读
    // 该环境的历史作底，写回时持久化（重启不丢；TUI 的 jsonl 不复用）。
    const base = get().history[key] ?? loadInputHistory(browserStorage(), key);
    const list = prependHistory(base, text, INPUT_HISTORY_LIMIT);
    set((s) => ({ history: { ...s.history, [key]: list } }));
    saveInputHistory(browserStorage(), key, list);
  },

  // ── 1.3.3 历史面板：清单 / 会话管理 / 载回续跑 ─────────────────────

  /**
   * 打开历史面板并载会话清单（已载过不重复拉；force=true 强制重拉，
   * 供面板「⟳ 刷新」按钮）。1.3.4：拉取失败保留 historySessions=null +
   * 落 historyError——面板据此展示 error 态（旧实现落 []，会把「载入
   * 失败」伪装成「暂无会话」）。
   */
  async openHistoryPanel(force?: boolean) {
    set({ page: 'history' });
    if (!force && get().historySessions !== null) return;
    set({ historyError: null });
    const c = client;
    if (!c) {
      set({ historySessions: null, historyError: '未连接 sidecar' });
      return;
    }
    try {
      const rows = parseSessionRows(await api.fetchSessions(c));
      // 1.4.6 历史研究档案：auto-run 记录合成行并入（invoke 通道无会话元
      // 绑定——run 的 loop 会话不进 sessions 清单，合成行使轨迹/档案可达）。
      let merged = rows;
      try {
        const runs = parseAutoRunList(await api.autoRunList(c));
        merged = mergeAutoRunRows(rows, autoRunRowsOf(runs));
      } catch {
        /* auto-run 清单失败不阻塞历史面板 */
      }
      set({ historySessions: merged, historyError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ historySessions: null, historyError: message });
      get().showToast(`线清单加载失败：${message}`);
    }
  },

  closeHistoryPanel() {
    set({ page: 'chat' });
  },

  async renameSession(id: string, title: string) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    const t = title.trim().slice(0, 100);
    if (!t) {
      state.showToast('标题不能为空');
      return;
    }
    try {
      const res = await api.patchSessionMeta(c, id, { title: t });
      if (!res.success) {
        state.showToast(`重命名失败：${res.error ?? '未知错误'}`);
        return;
      }
      set((s) =>
        s.historySessions
          ? {
              historySessions: s.historySessions.map((r) =>
                r.id === id ? { ...r, title: t } : r,
              ),
            }
          : {},
      );
    } catch (err) {
      state.showToast(`重命名失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async toggleSessionPinned(id: string) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    const row = state.historySessions?.find((r) => r.id === id);
    if (!row) return;
    const next = row.pinned !== true;
    try {
      const res = await api.patchSessionMeta(c, id, { pinned: next });
      if (!res.success) {
        state.showToast(`置顶失败：${res.error ?? '未知错误'}`);
        return;
      }
      set((s) =>
        s.historySessions
          ? {
              historySessions: s.historySessions.map((r) =>
                r.id === id ? { ...r, pinned: next || undefined } : r,
              ),
            }
          : {},
      );
    } catch (err) {
      state.showToast(`置顶失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async toggleSessionArchived(id: string) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    const row = state.historySessions?.find((r) => r.id === id);
    if (!row) return;
    const next = row.archived !== true;
    try {
      const res = await api.patchSessionMeta(c, id, { archived: next });
      if (!res.success) {
        state.showToast(`归档失败：${res.error ?? '未知错误'}`);
        return;
      }
      set((s) =>
        s.historySessions
          ? {
              historySessions: s.historySessions.map((r) =>
                r.id === id ? { ...r, archived: next || undefined } : r,
              ),
            }
          : {},
      );
    } catch (err) {
      state.showToast(`归档失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async deleteSessionRow(id: string) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    try {
      const res = await api.deleteSessionMeta(c, id);
      if (!res.success) {
        state.showToast(`删除失败：${res.error ?? '未知错误'}`);
        return;
      }
      set((s) =>
        s.historySessions
          ? { historySessions: s.historySessions.filter((r) => r.id !== id) }
          : {},
      );
      state.showReceipt('线已删除');
    } catch (err) {
      state.showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  /**
   * 1.3.3 载回续跑：POST /sessions/switch → 引擎切到目标会话（replay 全量
   * 重建），随后走 reconnect 同族流（关面板回 chat + 重连）。已知取舍：
   * switch 不刷新 env-sessions 分线映射（服务端 B2 决策），chat:init 的
   * environment 锚仍报工作区选定——若与目标会话 envKey 不同，重连后
   * applyInitEnvAnchor 会再切到选定线（内容照常回放，只是分组标签差异）。
   *
   * 1.3.4：busy 前置闸——turn 运行中切换会话会与活跃流打架（replay 重建
   * 期间旧线还在写），先明确提示中断（Esc）再载回；busy 口径与 esc 链
   * 一致（phase === 'running'）。
   */
  async resumeSession(id: string) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    if (currentSession(state).phase === 'running') {
      state.showToast('当前 turn 运行中——Esc 中断后再载回（避免与活跃线视图冲突）');
      return;
    }
    try {
      const res = await api.switchSession(c, id);
      if (!res.success) {
        state.showToast(`载回失败：${res.error ?? '未知错误'}`);
        return;
      }
      set({ page: 'chat', drawer: null, overlay: null });
      get().reconnect();
      void get().refreshSidebar();
      get().showReceipt('已载回线');
    } catch (err) {
      state.showToast(`载回失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── 1.6.11：任务形态（mission）设定面（session/mission 线态直读/直设） ──

  async loadMission() {
    const c = client;
    if (!c) {
      set({ mission: null });
      return;
    }
    try {
      // 线态优先于 meta（服务端恢复/切线时已从 meta 回填）——未绑定会话
      // 也可读，不再需要 environment/current 的绑定 meta id 绕行。
      const res = await api.sessionMissionGet(c);
      if (res.success) set({ mission: { kind: res.data?.mission ?? null } });
    } catch {
      /* 形态读取失败不阻塞会话——选择器维持原值 */
    }
  },

  async setMission(kind) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    try {
      const res = await api.sessionMissionSet(c, kind);
      if (!res.success) {
        state.showToast(`任务形态设置失败：${res.error ?? '未知错误'}`);
        return;
      }
      // 线态即时生效（chat:mission-changed 广播同值到达时幂等覆盖）。
      const applied = res.data?.mission ?? kind;
      set({ mission: { kind: applied } });
      state.showReceipt(applied ? `任务形态：${missionLabel(applied)}` : '已清除任务形态');
    } catch (err) {
      state.showToast(`任务形态设置失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── Esc 链（单处理器入口） ──────────────────────────────────────────

  esc() {
    const s = get();
    const action = escAction({
      overlayOpen: s.overlay !== null,
      queueOpen: s.queueOpen,
      boundaryOpen: s.boundaryAsks.length > 0,
      decisionOpen: s.decisions.length > 0 && s.activeDecisionId !== null,
      modalOpen: s.modal !== null,
      drawerOpen: s.drawer !== null,
      pageOpen: s.page !== 'chat',
      // 1.4.1：auto loop 活跃 → Esc 弹终止确认（在 busy 中断之前截胡）。
      autoRunActive: isAutoRunActive(s.autoRun),
      busy: currentSession(s).phase === 'running',
    });
    switch (action.type) {
      case 'close-overlay':
        set({ overlay: null });
        break;
      case 'close-queue':
        set({ queueOpen: false, queueServer: [] });
        break;
      case 'close-boundary': {
        const first = get().boundaryAsks[0];
        if (first) get().dismissBoundaryAsk(first.askId);
        break;
      }
      case 'close-decision': {
        // Esc 收起不作答：decision 保持 pending，缩为会话头部待答指示。
        set({ activeDecisionId: null });
        break;
      }
      case 'close-modal':
        // 1.5.9：boot 构建期 Esc = 收起模态（不再是拦截）——构建在服务端
        // 继续（bootEnv 无 AbortController），完成/失败均有 toast，侧栏
        // 「构建中」行可重开进度。
        // G-05（1.3.10）：复用 closeModal——modal 与 wizard 一并清（原分支只
        // 清 modal，与 closeModal 语义分裂）。
        get().closeModal();
        break;
      case 'close-drawer':
        set({ drawer: null });
        break;
      case 'close-page':
        // 决策④：正门是无环境场景的「家」——gate 且无环境时 Esc 无处可回，
        // 停在正门（no-op，不报错也不 dump 进无环境的 chat）；有环境则回
        // 工作区（page 层原语义）。escAction 纯函数不动，闸在执行层。
        if (get().page === 'gate' && !get().currentEnvKey) break;
        set({ page: 'chat' });
        break;
      case 'confirm-stop-auto-run':
        // 1.4.1：auto loop 活跃时 Esc = 弹「终止 auto loop？」确认（二次确认
        // 防误触；确认模态打开后 Esc 走 modal 层 = 取消）。
        get().requestStopAutoRun();
        break;
      case 'interrupt':
        void get().stopTurn();
        break;
      case 'none':
        break;
    }
  },
}));

// ── 1.3.4 ①：模块加载即应用持久化主题（DOM class 先于首渲染就位） ─────
// AttachView 在挂载/主题切换 effect 里读 CSS 变量；子组件 effect 先于 App
// 的 body.light 同步 effect 执行——若只靠 App effect，首挂载（持久化浅色）
// 会读到旧变量。这里在 store 创建后立即同步 class（action 里 toggleTheme/
// setTheme 也同步调 applyThemeClass），保证任意 effect 读到的都是当前主题。
applyThemeClass(useGuiStore.getState().theme);

// ── 1.3.4 ②：环境切换 → @ 补全文件树缓存失效 ────────────────────────────
// workspace/files 服务端按 currentAgentDir 出列表（随环境变），旧环境条目
// 会串线——环境键一变即清缓存 + 作废在飞/待发富化（代次递增 + 防抖取消）。
// 复合缓存键（fileCacheKey 带环境作用域）兜底防串线，这里负责明确失效。
useGuiStore.subscribe((state, prev) => {
  if (state.currentEnvKey !== prev.currentEnvKey) {
    filesCache.clear();
    mentionGen++;
    cancelMentionPending();
  }
});

// ---------------------------------------------------------------------------
// 辅助（模块级，不暴露为 action）
// ---------------------------------------------------------------------------

function tauriInvoke(): { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } {
  const w =
    typeof window !== 'undefined'
      ? (window as unknown as {
          __TAURI__?: { core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
        })
      : undefined;
  const invoke = w?.__TAURI__?.core?.invoke;
  return invoke ? { invoke: (cmd, args) => invoke(cmd, args) } : {};
}

function stopBootPolling(): void {
  if (bootPollTimer) {
    clearInterval(bootPollTimer);
    bootPollTimer = null;
  }
}

/** 1.3.5：侧栏本机发现条目键 → DiscoveredLike（docker/vm 两个数据源合一）。 */
function findDiscoveredItem(state: GuiState, itemKey: string): DiscoveredLike | null {
  const docker = state.discoveredDocker.find((d) => d.id === itemKey);
  if (docker) return { id: docker.id, name: docker.name, state: docker.status, driver: 'docker' };
  const vm = state.discoveredVm.find((v) => v.id === itemKey);
  if (vm) {
    return {
      id: vm.id,
      name: vm.name,
      state: vm.state,
      driver: vm.driver,
      vmx: vm.vmx,
      osFamily: vm.osFamily,
    };
  }
  return null;
}

/**
 * 1.3.2 任务二 #2：chat:init 环境锚 → 直接锚定当前环境（免
 * environment/current 绕行；旧路径 restoreEnvSelection 仅在锚字段缺失时
 * 兜底）。锚定完成置 envRestoreDone，避免两条路径互相打架。
 */
function applyInitEnvAnchor(
  get: () => GuiState,
  set: (partial: Partial<GuiState>) => void,
  anchor: InitEnvAnchor | null,
): void {
  envRestoreDone = true;
  const guiKey = initAnchorToGuiKey(anchor);
  if (guiKey !== get().currentEnvKey) {
    const key = sessionKey(guiKey);
    set({
      currentEnvKey: guiKey,
      sessions: { ...get().sessions, [key]: get().sessions[key] ?? emptySession() },
      page: 'chat',
    });
    get().reconnect();
  }
  // 决策④：锚落定（currentEnvKey 已就位）= 启动路由的判定时刻。
  routeStartupPage(get, set);
}

/**
 * 决策④启动路由（只判定一次）：初始环境解析落定——有环境不回写（初始
 * page 即 'chat'，天然回昨天现场）；无环境落 'gate'（正门：无环境/新建
 * 场景的家）。只判定一次是因为「现场」只在启动瞬间有意义：之后 currentEnvKey
 * 的一切变化（切环境/删环境/掉宿主）都是用户动作的结果，不该触发页面
 * 自动跳转——否则中途操作会被路由劫持（sidePaneOpen 初始化同一纪律）。
 */
function routeStartupPage(
  get: () => GuiState,
  set: (partial: Partial<GuiState>) => void,
): void {
  if (gateRouteDone) return;
  gateRouteDone = true;
  if (!get().currentEnvKey) set({ page: 'gate' });
}

/** 主题 → body.light class（styles.css 的浅色变量组开关）。 */
function applyThemeClass(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  document.body.classList.toggle('light', mode === 'light');
}

/** 主题持久化（localStorage；失败静默——隐私模式等）。 */
function persistTheme(mode: ThemeMode): void {
  try {
    browserStorage()?.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 静默。
  }
}

/**
 * 设置页等组件的 sidecar client 通道（连接生命周期内非空；未连接返回
 * null，页面显示空态）。client 本体是模块私有单例。
 */
export function getSettingsClient(): GuiSidecarClient | null {
  return client;
}

/** 服务端任务中心快照（task/list；不进 state，tasks 面板打开时读）。 */
let serverTaskCache: ServerTaskLike[] = [];

// ---------------------------------------------------------------------------
// 派生选择器（组件直接调用）
// ---------------------------------------------------------------------------

/** 当前会话派生状态（busy / phase / queue 深度）。 */
export function selectCurrentSession(s: GuiState): SessionState {
  return s.sessions[s.currentEnvKey ?? 'host'] ?? FALLBACK_SESSION;
}

/**
 * /tasks 面板行装配（战役 + bg + subagent + 服务端任务中心四源合一）。
 * 1.3.1 实机修正：必须返回**稳定引用**——React useSyncExternalStore 的
 * getSnapshot 契约要求缓存，每次新数组会触发无限渲染（实机黑屏
 * 「Maximum update depth exceeded」）。按输入引用相等缓存。
 */
let taskRowsCache: { bg: unknown; sub: unknown; server: unknown; campaigns: unknown; rows: TaskRow[] } | null = null;
export function selectTaskRows(s: GuiState): TaskRow[] {
  if (
    taskRowsCache &&
    taskRowsCache.bg === s.bgTasks &&
    taskRowsCache.sub === s.subagents &&
    taskRowsCache.server === serverTaskCache &&
    taskRowsCache.campaigns === s.campaigns
  ) {
    return taskRowsCache.rows;
  }
  // 1.6.8 M2：战役行置顶（观察面焦点），其余三源维持 v19 顺序。
  const rows = [...buildCampaignRows(s.campaigns), ...buildTaskRows(s.bgTasks, s.subagents, serverTaskCache)];
  taskRowsCache = { bg: s.bgTasks, sub: s.subagents, server: serverTaskCache, campaigns: s.campaigns, rows };
  return rows;
}

/** 1.6.8 M2：重拉战役清单（stop/resume 后刷新 /tasks 战役行；失败静默保旧）。 */
async function refreshCampaigns(
  get: () => GuiState,
  set: (partial: Partial<GuiState>) => void,
): Promise<void> {
  const c = client;
  if (!c) return;
  try {
    const res = await api.campaignList(c, get().workspace ?? undefined);
    if (res.success) set({ campaigns: parseCampaignRecords(res.data?.records) });
  } catch {
    /* 刷新失败保旧清单 */
  }
}

/**
 * v4 对象补全的对象源惰性拉取闸：每个源页面生命周期内只拉一次。
 * openOverlay('slash') 随每个按键重入——没有闸，输 /resume 的四个按键
 * 就是四发 line/list；只拉一次的代价是极端滞后（拉后新建线），面板/
 * 动作路径的刷新会兜底。
 */
const slashObjHydrated = new Set<'lines' | 'campaigns'>();

function ensureSlashObjectsHydrated(source: 'lines' | 'campaigns', pull: () => void): void {
  if (slashObjHydrated.has(source)) return;
  slashObjHydrated.add(source);
  pull();
}

/** 稳定的空会话单例：sessions 缺条目时兜底，避免 selector 每次返回新引用。 */
const FALLBACK_SESSION = emptySession();

/**
 * 1.3.1 ①：chat:init 携带 workspace 后一次性恢复当前环境选定
 * （environment/current → selectionToGuiKey）。选定与 GUI 当前线不同才切线
 * （避免重复重连）；恢复失败静默落宿主线（不阻塞会话）。
 * 1.3.2 任务二 #2：chat:init 带 environment 锚时走 applyInitEnvAnchor
 * （免绕行），本函数仅作锚字段缺失时的兜底路径。
 */
async function restoreEnvSelection(
  get: () => GuiState,
  set: (partial: Partial<GuiState>) => void,
  workspace: string,
): Promise<void> {
  if (envRestoreDone) return;
  envRestoreDone = true;
  const c = client;
  if (!c) return;
  try {
    const res = await api.fetchEnvironmentCurrent(c, workspace);
    const selection = (res.data?.selection ?? null) as Record<string, unknown> | null;
    const key = selectionToGuiKey(selection as { kind?: string; id?: string; instanceId?: string } | null);
    if (key !== get().currentEnvKey) {
      set({
        currentEnvKey: key,
        // A2-8：与锚路径（applyInitEnvAnchor）同口径——只补缺槽，不覆盖既有会话槽。
        sessions: ensureSessionSlot(get().sessions, key ?? 'host'),
      });
      get().reconnect();
    }
  } catch {
    // 静默——恢复失败保持宿主线。
  }
  // 决策④：兜底路径的启动路由判定（锚路径已在 applyInitEnvAnchor 烧掉闸）。
  routeStartupPage(get, set);
}

/** 模型切换 overlay 条目（1.3.6 过滤口径；1.3.10 抽公共供打开与刷新复用）。 */
function modelOverlayItems(s: GuiState): OverlayItem[] {
  const curModel = currentSession(s).model;
  const items: OverlayItem[] = [];
  for (const p of pickModelPickerProviders(s.models, curModel)) {
    for (const m of p.models) {
      items.push({
        name: m.model,
        detail: `${p.id} · ${
          m.contextLength ? `${Math.round(m.contextLength / 1000)}K ctx` : 'ctx 未知'
        }`,
        tag: p.id,
        cur: curModel !== undefined && m.model === curModel,
        providerId: p.id,
        model: m.model,
      });
    }
  }
  return items;
}

async function loadModels(
  get: () => GuiState,
  set: (partial: Partial<GuiState>) => void,
): Promise<void> {
  const c = client;
  if (!c) return;
  try {
    const { providers, current } = await api.fetchModelList(c);
    // 1.3.10：每次拉取都覆盖 models（1.3.6 起只初始化一次——设置页配 key
    // 后 hasApiKey 变化，模型 overlay 过滤不刷新；现在打开即重拉保证
    // 「显示=可运行」契约）。
    set({ models: providers });
    // 模型 overlay 仍开着 → 原地刷新条目（新配 key 的模型立即可见）。
    const ov = get().overlay;
    if (ov?.kind === 'model') {
      const items = modelOverlayItems(get());
      set({ overlay: { ...ov, items, sel: Math.min(ov.sel, Math.max(items.length - 1, 0)) } });
    }
    // 1.3.0 修正：新会话在首个 turn 前不会有 chat:system-init——状态栏
    // 模型名用 model/list 的 current 兜底（1.2.9 服务端字段）。
    if (current?.modelId) {
      const key = get().currentEnvKey ?? 'host';
      const session = get().sessions[key];
      if (!session?.model) {
        set({
          sessions: {
            ...get().sessions,
            [key]: { ...(session ?? emptySession()), model: current.modelId },
          },
        });
      }
    }
  } catch {
    // 模型列表拉取失败不阻塞会话（对齐 server「失败降级不阻塞」）。
  }
}

// ---------------------------------------------------------------------------
// 1.3.3 @ 补全：数据源富化（模块级辅助）
// ---------------------------------------------------------------------------

/** MentionItem → OverlayItem（ref/insert/section 透传；分节标题替代行内 tag）。 */
function toOverlayItem(item: {
  kind: string;
  label: string;
  detail?: string;
  id?: string;
  path?: string;
  insert?: string;
  section: string;
}): OverlayItem {
  return {
    name: item.label,
    detail: item.detail,
    section: item.section,
    ...(item.id ? { ref: { type: 'env', id: item.id } as Ref } : {}),
    ...(item.path ? { ref: { type: 'file', path: item.path } as Ref } : {}),
    ...(item.insert !== undefined ? { insert: item.insert } : {}),
  };
}

/**
 * @ 补全异步富化：agents 拉一次缓存；files 按「环境作用域 + 目录前缀」
 * 复合键拉取缓存（1.3.4：环境切换后旧环境条目绝不串线）。结果回填前
 * 校验代次与 overlay 仍是同一次 'at' 会话（防竞态：换查询/关面板/切
 * 环境后过期结果丢弃）。
 */
async function enrichMention(
  get: () => GuiState,
  set: (partial: Partial<GuiState>) => void,
  mq: ReturnType<typeof parseMentionQuery>,
): Promise<void> {
  const c = client;
  if (!c) return;
  const gen = ++mentionGen;
  const dir = mq.isFileDir ? fileDirOf(mq) : null;
  // 环境键在发请求时快照——切环境后清缓存 + 代次递增（见订阅），
  // 这里的缓存键/代次校验共同保证旧环境结果不落盘到新环境。
  const cacheKey = dir !== null ? fileCacheKey(get().currentEnvKey, dir) : null;

  const tasks: Promise<void>[] = [];
  if (agentsCache === null) {
    tasks.push(
      api.fetchAgents(c).then((agents) => {
        agentsCache = agents;
      }).catch(() => {
        agentsCache = [];
      }),
    );
  }
  if (dir !== null && cacheKey !== null && !filesCache.has(cacheKey)) {
    tasks.push(
      api.fetchWorkspaceFiles(c, { dir, depth: 2 }).then((res) => {
        filesCache.set(cacheKey, res.files ?? []);
      }).catch(() => {
        filesCache.set(cacheKey, []);
      }),
    );
  }
  await Promise.all(tasks);

  const s = get();
  if (gen !== mentionGen) return; // 查询已换/面板已关/环境已切
  const ov = s.overlay;
  if (!ov || ov.kind !== 'at') return;
  const items = buildMentionItems(mq, {
    envs: s.envs,
    agents: agentsCache ?? [],
    tools: s.tools,
    files: cacheKey !== null ? filesCache.get(cacheKey) ?? [] : [],
  }).map(toOverlayItem);
  if (items.length > 0) set({ overlay: { ...ov, items } });
}

/**
 * 1.3.4：@ 补全富化防抖调度。输入连续变化时只对「最后一次」查询发请求
 * （~200ms 静默窗口，MENTION_DEBOUNCE_MS）；新查询取消旧的待发请求。
 * 代次防竞态仍在 enrichMention 内（gen 快照），防抖不改变该语义。
 */
function scheduleMentionEnrich(
  get: () => GuiState,
  set: (partial: Partial<GuiState>) => void,
  mq: ReturnType<typeof parseMentionQuery>,
): void {
  cancelMentionPending();
  mentionTimer = setTimeout(() => {
    mentionTimer = null;
    void enrichMention(get, set, mq);
  }, MENTION_DEBOUNCE_MS);
}

/** 取消待发的 @ 富化请求（关面板/选中/切环境时调用）。 */
function cancelMentionPending(): void {
  if (mentionTimer) {
    clearTimeout(mentionTimer);
    mentionTimer = null;
  }
}

/** 1.3.1 ④：slash 命令分发（GUI 本地命令先处理；其余按路由表）。 */
async function runSlashCommand(
  get: () => GuiState,
  set: (partial: Partial<GuiState>) => void,
  cmd: string,
  inlineArgs?: string,
): Promise<void> {
  const s = get();
  // 本地命令（不在 server 路由表里）
  if (cmd === 'attach') {
    s.setPage('attach');
    return;
  }
  if (cmd === 'model') {
    s.openOverlay('model', '');
    return;
  }
  if (cmd === 'reset') {
    await s.runReset();
    return;
  }
  if (cmd === 'help') {
    s.showToast('/help：Esc 中断（busy）· Ctrl+R 历史 · ↑ 空输入历史 · Enter 发送（运行中发送=纠偏）');
    return;
  }
  // ── v4 动词（对象补全见 openOverlay('slash')；LOCAL_COMMANDS 同步登记——
  //    走这里特判，不进 SLASH_ROUTES 端点路由） ──────────────────────────
  // /gate：正门（选/建环境）——V4-S4 EnvSidebar 退常驻后的显式入口。
  if (cmd === 'gate') {
    s.setPage('gate');
    s.showReceipt('已开正门');
    return;
  }
  // /use <环境id>：中途切环境（V4-S4——正门只做无环境/新建，中途换环境 ≤2
  // 次输入）。id 必须在本地注册表命中：对象补全是 id 的唯一事实源。
  if (cmd === 'use') {
    const id = inlineArgs?.trim() ?? '';
    const env = id ? s.envs.find((e) => e.id === id) : undefined;
    if (!env) {
      s.showToast('`/use <环境id>`——可先输 /use 看对象补全');
      return;
    }
    await s.switchEnv(env.id);
    return;
  }
  // /xfer <envA:路径> <envB:路径>：2.0-M3 跨环境传产物——服务端编排
  // extract→暂存→put（两段各取第一个 ':' 切分；环境内路径从 '/' 起）。
  if (cmd === 'xfer') {
    const parts = (inlineArgs ?? '').trim().split(/\s+/).filter(Boolean);
    const parse = (tok: string): { id: string; path: string } | null => {
      const i = tok.indexOf(':');
      if (i <= 0 || i >= tok.length - 1) return null;
      return { id: tok.slice(0, i), path: tok.slice(i + 1) };
    };
    const a = parts[0] ? parse(parts[0]) : null;
    const b = parts[1] ? parse(parts[1]) : null;
    if (!a || !b) {
      s.showToast('`/xfer <源环境:源路径> <目标环境:目标路径>`——例：/xfer fuzz:/work/crash-01 pwn:/tmp/');
      return;
    }
    const c2 = client;
    if (!c2) {
      s.showToast('未连接 sidecar');
      return;
    }
    const res = await api.environmentXfer(c2, { fromId: a.id, fromPath: a.path, toId: b.id, toPath: b.path });
    if (res.success) {
      const size = res.data?.bytes !== undefined ? `（${Math.round(res.data.bytes / 1024)}KB · ${res.data.via ?? ''}）` : '';
      s.showReceipt(`已传 ${res.data?.name ?? a.path} → ${b.id}${size}`);
    } else {
      s.showToast(`xfer 失败：${res.error ?? '未知错误'}`);
    }
    return;
  }
  // /resume <线id>：切线（resume 有成本——服务端要重跑该线引擎）。id 必须在
  // 本地线清单命中：对象补全/线面板是 id 的唯一事实源，不命中引导回补全。
  if (cmd === 'resume') {
    const id = inlineArgs?.trim() ?? '';
    const line = id ? s.lines.find((l) => l.id === id) : undefined;
    if (!line) {
      s.showToast('`/resume <线id>`——可先输 /resume 看对象补全');
      return;
    }
    await s.switchToLine(line.id);
    return;
  }
  // /kill <id>：终止战役。命中才弹既有二次确认模态（confirmCampaignStop
  // 真正发 campaign/stop——破坏性动作的终审权在人，这里不直接发请求）。
  if (cmd === 'kill') {
    const q = inlineArgs?.trim() ?? '';
    const campaign = q ? s.campaigns.find((c) => c.id === q || c.goal === q) : undefined;
    if (!campaign) {
      s.showToast(q ? `/kill：未找到战役 "${q}"——可先输 /kill 看对象补全` : '`/kill <id>`——可先输 /kill 看对象补全');
      return;
    }
    s.requestCampaignStop({ id: campaign.id, goal: campaign.goal });
    return;
  }
  // /mission <标签>：改任务形态（挖掘|利用|复现|ctf|无类型）。复用 Toolbar
  // 选择器的 store 动作（session/mission 直设 + 线态回写 + 回执 toast）。
  if (cmd === 'mission') {
    const label = inlineArgs?.trim() ?? '';
    const option = label ? MISSION_OPTIONS.find((o) => o.label.toLowerCase() === label.toLowerCase()) : undefined;
    if (!option) {
      s.showToast('`/mission <挖掘|利用|复现|ctf|无类型>`——可先输 /mission 看对象补全');
      return;
    }
    await s.setMission(missionPatchValue(option.value));
    return;
  }
  // 1.5.2 实锤修复④：可吃 inline 参数的命令带参直发（跳过 slash-args 模态
  // ——/snapshot myname /intel CVE-2024-1234 选中即执行）。
  if (inlineArgs?.trim() && acceptsInlineArgs(cmd)) {
    await executeSlash(get, set, cmd as SlashCommandName, inlineArgs.trim());
    return;
  }
  const route = slashRoute(cmd);
  if (!route) {
    s.showToast(`/${cmd}：未知命令`);
    return;
  }
  switch (route.command) {
    case 'queue':
      await s.openQueuePanel();
      return;
    case 'tasks':
      // V4-S2：内容驻 SidePane「任务」页签——打开面板并切页签（拉取在
      // openSidePane('tasks') 路径内，与浮层时代开面板重拉同节奏）。
      s.openSidePane('tasks');
      return;
    case 'export': {
      // 1.3.5：/export [sanitize]——先闸工作区，再走 slash-args 模态收
      // 可选 sanitize 参数（与 snapshot/rollback/extract 同一惯例）。
      if (!s.workspace) {
        s.showToast('/export：工作区尚未就绪（等待 chat:init）');
        return;
      }
      set({ modal: { kind: 'slash-args', command: 'export' } });
      return;
    }
    case 'snapshot':
    case 'rollback':
    case 'extract':
    case 'push': {
      set({
        modal: {
          kind: 'slash-args',
          command: route.command,
        },
      });
      return;
    }
    case 'rewind':
    case 'fork': {
      const key = s.currentEnvKey ?? 'host';
      const session = s.sessions[key] ?? emptySession();
      const targets = route.command === 'rewind' ? rewindTargets(session.items) : forkTargets(session.items);
      if (targets.length === 0) {
        s.showToast(`/${cmd}：当前线没有可回退/分叉的消息`);
        return;
      }
      set({ modal: { kind: 'pick-message', command: route.command } });
      return;
    }
    // 1.5.0 触发权归人（研究命令）：archive 无参直接执行；intel/
    // decide 走 slash-args 模态收可选参数（留空 = 吃当前会话上下文）。
    case 'archive': {
      await executeSlash(get, set, 'archive', '');
      return;
    }
    case 'intel':
    case 'decide': {
      set({ modal: { kind: 'slash-args', command: route.command } });
      return;
    }
  }
}

/** 参数收集完成后的执行（snapshot/rollback/extract/push/rewind/fork/export）。 */
async function executeSlash(
  get: () => GuiState,
  _set: (partial: Partial<GuiState>) => void,
  command: SlashCommandName,
  arg: string,
): Promise<void> {
  const s = get();
  const c = client;
  if (!c) {
    s.showToast('未连接 sidecar');
    return;
  }
  // 1.5.0 触发权归人（研究命令）：查询 → 拼注入文本 → s.send（正常 turn
  // 语义，闸门/排队/纠偏全复用）。通吃上下文：参数留空取最近用户消息。
  if (command === 'intel' || command === 'archive' || command === 'decide') {
    if (command === 'archive') {
      await s.send(ARCHIVE_INSTRUCTION);
      return;
    }
    if (command === 'decide') {
      await s.send(buildDecideInstruction(arg));
      return;
    }
    const key = s.currentEnvKey ?? 'host';
    const session = s.sessions[key] ?? emptySession();
    const query = effectiveQuery(arg, session.items);
    if (!query) {
      s.showToast(`/${command}：需要查询词（当前线还没有上下文可吃）`);
      return;
    }
    s.showToast(`⏳ 检索情报库：${query.slice(0, 60)}${query.length > 60 ? '…' : ''}`);
    try {
      const res = await api.intelSearch(c, query);
      if (!res.success || !res.data?.text) {
        s.showToast(`情报检索失败：${res.error ?? '空结果'}`);
        return;
      }
      await s.send(buildIntelInjectText(query, res.data.text));
    } catch (err) {
      s.showToast(`检索失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  // 1.3.5：/export [sanitize]——用法校验 + 脱敏 payload 透传（TUI
  // src/cli/tui/v2/slash/report.ts:22-53 同语义：只认字面量 sanitize）。
  if (command === 'export') {
    const word = arg.trim();
    if (word && word !== 'sanitize') {
      s.showToast('用法：/export [sanitize]');
      return;
    }
    const payload = slashPayload(SLASH_ROUTES.export, { envKey: s.currentEnvKey, workspace: s.workspace }, word);
    if (!payload) {
      s.showToast('/export：工作区尚未就绪（等待 chat:init）');
      return;
    }
    s.showToast(`⏳ 组装报告${word === 'sanitize' ? '（脱敏版）' : ''}（含越界批准与证据回收）…`);
    try {
      const res = await api.reportExport(c, payload as { workspace: string; sanitize?: boolean });
      if (!res.success) {
        s.showToast(`导出失败：${res.error ?? '未知错误'}`);
        return;
      }
      s.showToast(exportResultToast(res.data as Record<string, unknown> | undefined));
    } catch (err) {
      s.showToast(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  const route = SLASH_ROUTES[command];
  const payload = slashPayload(route, { envKey: s.currentEnvKey, workspace: s.workspace }, arg);
  if (!payload) {
    s.showToast(noEnvToast(command));
    return;
  }
  if (route.needsArgs === 'name' && !String(payload.snapshot ?? payload.guestPath ?? '').trim()) {
    s.showToast(`/${command}：参数必填`);
    return;
  }
  try {
    if (route.endpoint.kind === 'admin') {
      const res = await c.adminPost<{
        success: boolean;
        error?: string;
        /** /push 成功返回（environment/push 契约）：目标路径与通道。 */
        data?: { pushedTo?: string; via?: 'scp' | 'vmrun' };
      }>(route.endpoint.route, payload);
      if (!res.success) {
        s.showToast(`/${command} 失败：${res.error ?? '未知错误'}`);
        return;
      }
      receiptSlashSuccess(s, command, arg, res.data);
    } else {
      if (route.command === 'rewind') {
        const res = await api.chatRewind(c, String(payload.userMessageId));
        if (!res.success) {
          s.showToast(`/rewind 失败：${res.error ?? '未知错误'}`);
          return;
        }
        s.showReceipt('已回退，重连重建中');
        s.reconnect();
        return;
      }
      if (route.command === 'fork') {
        const res = await api.forkSession(c, String(payload.messageId));
        if (!res.success) {
          s.showToast(`/fork 失败：${res.error ?? '未知错误'}`);
          return;
        }
        s.showReceipt('已分叉新线程');
        s.reconnect();
      }
    }
  } catch (err) {
    s.showToast(`/${command} 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** slash 环境动词成功回执（S5 双轨：确认感走状态行回执短句；这批动作
 *  的详情——快照名/路径/传输通道——价值低，不再双发 toast，回执即全部）。 */
function receiptSlashSuccess(
  s: GuiState,
  command: SlashCommandName,
  arg: string,
  data?: { pushedTo?: string; via?: 'scp' | 'vmrun' },
): void {
  if (command === 'snapshot') {
    s.showReceipt(arg.trim() ? `快照 ${arg.trim()} 已建立` : '快照已建立');
    return;
  }
  if (command === 'rollback') {
    s.showReceipt(`已回滚到 ${arg.trim()}`);
    return;
  }
  if (command === 'extract') {
    s.showReceipt(`已回收 ${arg.trim()}`);
    return;
  }
  if (command === 'push') {
    s.showReceipt(`已传入 ${data?.pushedTo ?? '环境'}`);
  }
}
