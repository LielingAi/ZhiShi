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
 *   - tasksOpen / tasksSelected / queueOpen / queueServer（/tasks、/queue 面板）
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
 *   - MCP 管理在 SettingsPage 页签（数据映射在 model/mcp）
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
import { bootStages, buildRegisterPayload, isDiscoveredRunning, type DiscoveredLike, type RegisterExtras } from '../model/envs';
import { envRemovePlan, type EnvRemoveTarget } from '../model/env-remove';
import type { EnvDownTarget } from '../model/env-down';
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
import { parseSessionRows, type SessionMetaRow } from '../model/history';
import {
  INPUT_HISTORY_LIMIT,
  loadInputHistory,
  prependHistory,
  rankInputHistory,
  saveInputHistory,
  INPUT_HISTORY_OVERLAY_LIMIT,
} from '../model/input-history';
import { buildMentionItems, fileCacheKey, fileDirOf, MENTION_DEBOUNCE_MS, parseMentionQuery } from '../model/mention';
import { planSwitch, sessionKey } from '../model/multi-session';
import {
  applyAutoRunEvent,
  buildAutoRunStartPayload,
  isAutoRunActive,
  optimisticAutoRunEntry,
  parseBudgetLimit,
  validateAutoRunForm,
  activeAutoRunOf,
  type AutoRunEntry,
  type AutoRunFormView,
} from '../model/auto-run';
import {
  applyArchiveChanged as applyArchiveChangedPayload,
  type ArchiveSnapshot,
} from '../model/archive';
import { reduceSseEvent } from '../model/reducer';
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
import { parseExpertImport } from '../model/expert-import';
import { pickModelPickerProviders } from '../model/model-picker';
import { mergeSidebarSnapshot } from '../model/sidebar';
import * as api from '../client/api';
import type {
  AgentEntity,
  DiscoveredDocker,
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
import { GuiSidecarClient } from '../client/sse-client';

// ---------------------------------------------------------------------------
// 常量（v19 SLASH 清单，12 条）
// ---------------------------------------------------------------------------

export interface SlashCommand {
  name: string;
  detail: string;
  group: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'attach', detail: '接管环境 shell', group: '环境' },
  { name: 'snapshot', detail: '给当前环境打快照 [名]', group: '环境' },
  { name: 'rollback', detail: '回滚到快照 <名>', group: '环境' },
  { name: 'extract', detail: '回收环境内文件到宿主 <路径>', group: '环境' },
  { name: 'rewind', detail: '回退到历史消息', group: '线程' },
  { name: 'fork', detail: '从某条消息分叉出新线程', group: '线程' },
  { name: 'queue', detail: '查看/取消排队消息', group: '线程' },
  { name: 'tasks', detail: '查看子任务与后台进程', group: '线程' },
  { name: 'export', detail: '导出研究报告 [sanitize 脱敏]', group: '线程' },
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
  | 'env-detail'
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
  /** slash-args / pick-message 关联的命令名（rewind/fork/snapshot/rollback/extract/export）。 */
  command?: SlashCommandName;
  /** promote（入专家库）预填。 */
  prefill?: PromotePrefill;
  /** 1.3.7 向导 → boot：VM 配方的可选 guest 凭据（environment/up 透传）。 */
  bootOpts?: { user?: string; keyPath?: string };
  /** 1.3.7 补口：env-remove 模态的删除目标（文案/确认强度见 model/env-remove）。 */
  envRemove?: EnvRemoveTarget;
  /** 1.3.8 ①：env-down 模态的停止目标（文案见 model/env-down）。 */
  envDown?: EnvDownTarget;
  /** 1.3.8 多配方：env-detail 模态展示/管理目标（完整登记条目）。 */
  envDetail?: EnvEntry;
}

export interface DrawerState {
  toolId: string;
  name: string;
  args: string;
  output: string;
  state: 'done' | 'fail' | 'running';
  exitCode?: number;
  elapsedMs?: number;
  signal?: string;
  search: string;
}

export interface TasksSelected {
  title: string;
  detail: string;
  /** 子代理 transcript（loop-session 结构化消息）或 server task JSON 摘要。 */
  transcript: LoopTranscriptLine[] | null;
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

export type Page = 'chat' | 'settings' | 'attach' | 'history';

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
  /** 验收包模态收起标志（新 verdict-requested 重置为 false）。 */
  verdictDismissed: boolean;

  // 1.4.4 研究档案（分屏看板数据面）。单槽设计：同一时刻只有一条活跃线
  // 在写档案（交互线或 auto-run 线——auto-run 运行中交互被锁,互斥成立）,
  // archive:changed 整包覆盖即正确;chat:init 重连用 archive/list 重锚。
  archive: ArchiveSnapshot | null;
  /** 看板高亮实体（流内「→V3」徽章点进来的定位;null = 无高亮）。 */
  archiveHighlightId: string | null;
  /** 跳流目标：档案锚 → 流内 user 消息 id（Stream 消费后即清）。 */
  archiveJumpTarget: { messageId: string; nonce: number } | null;
  /** 分屏比例（流宽占比,默认 0.6;拖动更新 + localStorage 持久化）。 */
  archivePaneRatio: number;
  /** 左右互换（档案在左、流在右）。 */
  archiveSwapped: boolean;
  /** 小窗抽屉开关（≥1280px 分屏恒在,无抽屉语义）。 */
  archiveDrawerOpen: boolean;

  // 1.3.2 ③：主题（深色默认；localStorage 持久化）
  theme: ThemeMode;

  // 1.3.3 @ 补全：工具名数据源（chat:system-init 的 info.tools，随会话绑定刷新）
  tools: string[];

  // 1.3.3 历史面板：会话清单（null = 未载入/载入失败；加载中由
  // historySessions===null 且 historyError===null 推导）
  historySessions: SessionMetaRow[] | null;
  /** 1.3.4：清单拉取失败原因（非 null 时清单展示 error 态而非「暂无会话」）。 */
  historyError: string | null;

  /** 1.3.3 @ 补全：选中后替换输入框尾部 @token 的一次性信号。 */
  mentionApply: { replace: string; nonce: number } | null;

  // 1.3.1 ③④：/tasks 与 /queue 面板
  tasksOpen: boolean;
  tasksSelected: TasksSelected | null;
  queueOpen: boolean;
  queueServer: QueueStatusItem[];

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
  toast: string | null;
  toastNonce: number;
  /** 历史 overlay 选中 → 回填输入框的一次性载荷。 */
  inputFill: { text: string; nonce: number } | null;

  // actions
  init(): void;
  dispose(): void;
  reconnect(): void;
  refreshSidebar(): Promise<void>;
  switchEnv(key: string): Promise<void>;
  startEnv(itemKey: string): Promise<void>;
  /** 1.3.7 场景 3：重推环境能力集合（environment/capability-refresh → 刷新侧栏）。 */
  refreshEnvCapability(envId: string): Promise<void>;
  /** 1.3.5 ④：本机发现条目「选中即注册」（environment/add → 入侧栏 → 运行中则切入）。 */
  registerDiscovered(itemKey: string, extras?: RegisterExtras): Promise<void>;
  /** 1.3.7 补口：侧栏「删除」入口——运行中拦截 toast，否则开确认模态。 */
  requestEnvRemove(target: EnvRemoveTarget): void;
  /** 1.3.7 补口：确认删除（environment/rm → 成功 refreshSidebar + toast；失败 toast 服务端错误原文）。 */
  confirmEnvRemove(): Promise<void>;
  /** 1.3.8 ①：侧栏运行中行「停止」入口——开确认模态（文案在 model/env-down）。 */
  requestEnvDown(target: EnvDownTarget): void;
  /** 1.3.8 ①：确认停止（environment/down → 成功 refreshSidebar + toast；失败 toast 服务端错误原文）。 */
  confirmEnvDown(): Promise<void>;
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
  openNewEnv(): void;
  /** 1.3.7 场景 1：向导「VM 配方构建」次级入口——改为认领已有 VM（adopt 模板养成）。 */
  openAdopt(recipeId: string): void;
  closeModal(): void;
  setModal(modal: ModalState | null): void;
  // 1.3.7：新建环境向导 actions（分发逻辑在 wizardExecute）
  wizardPickSource(source: WizardSource): void;
  wizardSetParam(key: keyof WizardParams, value: string): void;
  wizardNextStep(): void;
  wizardBackStep(): void;
  wizardExecute(): Promise<void>;
  submitAdopt(vmx: string, user: string, keyPath: string, password: string): Promise<void>;
  bootEnv(recipeId: string): Promise<void>;
  submitSlashArg(value: string): Promise<void>;
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
  extendAutoRunBudget(limit: number): Promise<void>;
  respondAutoRunVerdict(verdict: 'pass' | 'fail' | 'continue'): Promise<void>;
  dismissVerdict(): void;
  openVerdict(): void;
  dismissAutoRunCard(): void;
  loadAutoRunState(): Promise<void>;
  // 1.4.4 研究档案（分屏看板）
  applyArchiveChanged(payload: unknown): void;
  loadArchive(sessionId?: string): Promise<void>;
  correctArchiveEntity(id: string, reason: string): Promise<void>;
  setArchiveHighlight(id: string | null): void;
  jumpToArchiveAnchor(messageId: string): void;
  setArchivePaneRatio(ratio: number): void;
  toggleArchiveSwap(): void;
  setArchiveDrawerOpen(open: boolean): void;
  // 1.3.2 ①：promote（决策块入专家库）
  submitPromote(entry: Record<string, unknown>): Promise<{ ok: boolean; message: string }>;
  // 1.3.2 ③：主题
  toggleTheme(): void;
  setTheme(mode: ThemeMode): void;
  // 1.3.1 ③④：tasks / queue
  openTasksPanel(): Promise<void>;
  closeTasksPanel(): void;
  backToList(): void;
  selectTaskRow(key: string): Promise<void>;
  openQueuePanel(): Promise<void>;
  closeQueuePanel(): void;
  cancelQueueItem(queueId: string): Promise<void>;
  // 1.3.1 ⑥：settings
  submitExpertImport(raw: string): Promise<{ ok: boolean; message: string }>;
  openDrawer(detail: ToolDetail): void;
  closeDrawer(): void;
  setDrawerSearch(q: string): void;
  setPage(page: Page): void;
  showToast(msg: string): void;
  clearToast(): void;
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
  esc(): void;
}

// 模块级单例（连接生命周期跨 action 存在；不进 state 避免渲染抖动）。
let client: GuiSidecarClient | null = null;
let abortController: AbortController | null = null;
let connecting = false;
let lifecycleGen = 0;
/** 启动环境恢复只做一次（chat:init 的 workspace 到达后）。 */
let envRestoreDone = false;
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

// 1.4.4 研究档案分屏偏好（比例/左右互换;localStorage 持久化,记住用户习惯）。
const ARCHIVE_RATIO_KEY = 'zhishi.gui.archiveRatio';
const ARCHIVE_SWAP_KEY = 'zhishi.gui.archiveSwapped';

function readArchiveRatio(): number {
  const raw = browserStorage()?.getItem(ARCHIVE_RATIO_KEY);
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0.3 && n <= 0.85 ? n : 0.6;
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
  verdictDismissed: false,

  // 1.4.4 研究档案（分屏看板）
  archive: null,
  archiveHighlightId: null,
  archiveJumpTarget: null,
  archivePaneRatio: readArchiveRatio(),
  archiveSwapped: browserStorage()?.getItem(ARCHIVE_SWAP_KEY) === '1',
  archiveDrawerOpen: false,

  tools: [],

  historySessions: null,
  historyError: null,
  mentionApply: null,

  tasksOpen: false,
  tasksSelected: null,
  queueOpen: false,
  queueServer: [],

  boot: null,

  wizard: null,
  domains: [],

  overlay: null,
  modal: null,
  drawer: null,
  page: 'chat',
  toast: null,
  toastNonce: 0,
  inputFill: null,

  // ── 连接 ────────────────────────────────────────────────────────────

  init() {
    if (connecting || client) return;
    connecting = true;
    const gen = ++lifecycleGen;
    envRestoreDone = false;
    void (async () => {
      const { invoke } = tauriInvoke();
      const search = typeof window !== 'undefined' ? window.location.search : '';
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
      client = new GuiSidecarClient({ base: `http://127.0.0.1:${port}` });
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
      try {
        for await (const input of c.openSse('/chat/stream', {
          signal: ac.signal,
          onReconnect: (_attempt, _cause) => {
            set({ connectionState: 'reconnecting' });
          },
        })) {
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
              // 新验收包到达 → 自动弹（收起态重置）。
              if (res.autoRun.kind === 'verdict' && next?.verdict) {
                patch.verdictDismissed = false;
              }
              // 暂停 / 完成 → toast（暂停点提示 + 完成回报）。
              if (res.autoRun.kind === 'paused' && next) {
                patch.toast =
                  res.autoRun.reason === 'budget'
                    ? '⏸ auto loop 暂停：预算耗尽——加预算或终止'
                    : '⏸ auto loop 暂停（空转/反复失败）——继续或终止';
                patch.toastNonce = s.toastNonce + 1;
              }
              if (res.autoRun.kind === 'completed' && next) {
                patch.toast = '✓ auto loop 完成';
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
          // 1.4.4 研究档案：archive:changed 整包快照（单槽设计——同一时刻
          // 只有一条活跃线写档案,直接覆盖;高亮指针若被纠正清空则复位）。
          if (input.event === 'archive:changed') {
            get().applyArchiveChanged(input.payload);
            const snap = get().archive;
            if (snap && get().archiveHighlightId && !snap.entities.some((e) => e.id === get().archiveHighlightId)) {
              set({ archiveHighlightId: null });
            }
          }
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
    get().showToast(`◈ 已切换到 ${key} 的会话线`);
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
    const recipe = entry.recipeId ?? entry.id;
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
      state.showToast(`✓ ${entry.id} 已启动`);
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
      state.showToast(`✓ ${envId} 能力：${domains.join(' · ') || '（无）'}`);
    } catch (err) {
      state.showToast(`能力重推失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── 1.3.5 ④：本机发现「选中即注册」（TUI gate.ts:262-298 同语义） ──

  async registerDiscovered(itemKey: string, extras?: RegisterExtras) {
    const c = client;
    const state = get();
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    const item = findDiscoveredItem(state, itemKey);
    if (!item) {
      state.showToast('未找到该本机条目');
      return;
    }
    const payload = buildRegisterPayload(item, extras);
    if (!payload) {
      state.showToast('该条目缺少登记所需信息（名字/驱动）');
      return;
    }
    state.showToast(`⏳ 登记 ${payload.id}…`);
    try {
      const res = await api.environmentAdd(c, payload);
      if (!res.success) {
        state.showToast(`登记失败：${res.error ?? '未知错误'}`);
        return;
      }
      void state.refreshSidebar();
      state.showToast(`✓ 已登记 ${payload.id}`);
      // 运行中才尝试切入（docker Up / VM running）；停着的只入侧栏
      //（无配方的已停止条目切过去是死线，等启动后再进）。
      if (isDiscoveredRunning(item)) {
        await state.switchEnv(payload.id);
      }
    } catch (err) {
      state.showToast(`登记失败：${err instanceof Error ? err.message : String(err)}`);
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
      state.showToast(`✓ 已删除 ${target.label}`);
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
      state.showToast(`✓ 已停止 ${target.label}`);
    } catch (err) {
      state.showToast(`停止失败：${err instanceof Error ? err.message : String(err)}`);
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
      state.showToast(`✓ 已更新 ${target.id} 的配方绑定`);
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
      if (outcome === 'steering') get().showToast(`↳ 已插入纠偏：${text}`);
      else if (outcome === 'fifo-queued') get().showToast(`已排队（FIFO）：${text}`);
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
      get().showToast('对话已重置');
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
      get().showToast(`已切换模型：${model}`);
    } catch (err) {
      get().showToast(`切换模型失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── overlay ─────────────────────────────────────────────────────────

  openOverlay(kind, query) {
    const s = get();
    if (kind === 'slash') {
      const q = query.trim();
      const items = SLASH_COMMANDS.filter((c) => c.name.startsWith(q)).map((c) => ({
        name: `/${c.name}`,
        detail: c.detail,
        tag: c.group,
      }));
      set({ overlay: { kind, title: '命令', items, sel: 0 } });
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
        const cmd = item.name.replace(/^\//, '');
        void runSlashCommand(get, set, cmd);
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
      state.showToast('✓ 决定已提交——回注会话流继续');
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
      set({
        modal: null,
        autoRun: optimisticAutoRunEntry(res.id, payload),
        verdictDismissed: false,
      });
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
      state.showToast('⏹ auto loop 已终止——会话回到普通模式');
    } catch (err) {
      state.showToast(`终止失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async extendAutoRunBudget(limit: number) {
    const c = client;
    const state = get();
    const id = state.autoRun?.id;
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    if (!id || parseBudgetLimit(String(limit)) === null) {
      state.showToast('预算须为正整数');
      return;
    }
    try {
      const res = await api.autoRunBudget(c, { id, limit });
      if (!res.success) {
        state.showToast(`加预算失败：${res.error ?? '未知错误'}`);
        return;
      }
      // 服务端加完预算自动续跑——本地同步翻 running + 清暂停点。
      set((s) =>
        s.autoRun && s.autoRun.id === id
          ? {
              autoRun: {
                ...s.autoRun,
                budget: { ...s.autoRun.budget, limit },
                status: 'running',
                paused: undefined,
                updatedAt: Date.now(),
              },
            }
          : {},
      );
      state.showToast('✓ 预算已加——loop 继续');
    } catch (err) {
      state.showToast(`加预算失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async respondAutoRunVerdict(verdict: 'pass' | 'fail' | 'continue') {
    const c = client;
    const state = get();
    const id = state.autoRun?.id;
    if (!c) {
      state.showToast('未连接 sidecar');
      return;
    }
    if (!id) return;
    try {
      const res = await api.autoRunVerdict(c, { id, verdict });
      if (!res.success) {
        state.showToast(`提交失败：${res.error ?? '未知错误'}`);
        return;
      }
      if (verdict === 'continue') {
        // 继续跑（验收包「继续」或 stall/repeated-failures 暂停点「继续」）。
        set((s) =>
          s.autoRun && s.autoRun.id === id
            ? {
                autoRun: {
                  ...s.autoRun,
                  status: 'running',
                  paused: undefined,
                  verdict: undefined,
                  updatedAt: Date.now(),
                },
                verdictDismissed: true,
              }
            : {},
        );
        state.showToast('▶ 继续跑');
        return;
      }
      // 终审 pass/fail：本地就地定稿（服务端 completed 事件到达时幂等复写）。
      set((s) =>
        s.autoRun && s.autoRun.id === id
          ? {
              autoRun: {
                ...s.autoRun,
                status: verdict === 'pass' ? 'completed' : 'stopped',
                updatedAt: Date.now(),
              },
              verdictDismissed: true,
            }
          : {},
      );
      state.showToast(verdict === 'pass' ? '✓ 验收通过——auto loop 完成' : '⏹ 验收不通过——loop 已终止');
    } catch (err) {
      state.showToast(`提交失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  dismissVerdict() {
    // Esc 语义：收起不作答——loop 保持 awaiting-verdict，观察卡「待终审」
    // 指示可点开重答（与 decision 模态同族口径）。
    set({ verdictDismissed: true });
  },

  openVerdict() {
    set({ verdictDismissed: false });
  },

  dismissAutoRunCard() {
    // completed/stopped 后的观察卡关闭（活跃 loop 无此入口——只能 Esc 终止）。
    set({ autoRun: null, verdictDismissed: false });
  },

  async loadAutoRunState() {
    const c = client;
    if (!c) return;
    try {
      const raw = await api.autoRunList(c);
      const restored = activeAutoRunOf(raw);
      const cur = get().autoRun;
      // 同 id 且本地更新 → 不覆盖（list 快照落后于在飞 SSE 事件）。
      if (restored && cur && restored.id === cur.id && cur.updatedAt > restored.updatedAt) {
        return;
      }
      set({
        autoRun: restored,
        verdictDismissed: restored?.verdict ? false : get().verdictDismissed,
      });
    } catch {
      // 静默——恢复失败保持本地状态（list 端点未接线时不阻塞会话）。
    }
  },

  // ── 1.4.4 研究档案（分屏看板） ─────────────────────────────────────

  /** archive:changed 整包快照（SSE 事件;单槽设计——活跃线互斥,整包覆盖正确）。 */
  applyArchiveChanged(payload: unknown) {
    set({ archive: applyArchiveChangedPayload(payload) });
  },

  /** archive/list 重锚（chat:init 重连/切环境后;auto-run 面板按 run 线显式传）。 */
  async loadArchive(sessionId?: string) {
    const c = client;
    if (!c) return;
    try {
      const res = await api.fetchArchiveList(c, sessionId ? { sessionId } : {});
      if (res.ok && res.archive) set({ archive: res.archive });
      else if (res.ok) set({ archive: null });
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
    set({
      archiveHighlightId: null,
      toast: `已纠正 ${id}——下游已标待复核`,
      toastNonce: get().toastNonce + 1,
    });
  },

  setArchiveHighlight(id: string | null) {
    set({ archiveHighlightId: id });
  },

  /** 档案锚 → 流跳转（Stream 消费 archiveJumpTarget 后即清）。 */
  jumpToArchiveAnchor(messageId: string) {
    set({
      archiveJumpTarget: { messageId, nonce: (get().archiveJumpTarget?.nonce ?? 0) + 1 },
      archiveDrawerOpen: true, // 小窗抽屉形态：跳流时档案侧保持可用
    });
  },

  setArchivePaneRatio(ratio: number) {
    const clamped = Math.min(0.85, Math.max(0.3, ratio));
    set({ archivePaneRatio: clamped });
    browserStorage()?.setItem(ARCHIVE_RATIO_KEY, String(clamped));
  },

  toggleArchiveSwap() {
    const next = !get().archiveSwapped;
    set({ archiveSwapped: next });
    browserStorage()?.setItem(ARCHIVE_SWAP_KEY, next ? '1' : '0');
  },

  setArchiveDrawerOpen(open: boolean) {
    set({ archiveDrawerOpen: open });
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

  // ── 1.3.1 ③④：/tasks 面板 ──────────────────────────────────────────

  async openTasksPanel() {
    const c = client;
    set({ tasksOpen: true, tasksSelected: null });
    if (!c) return;
    try {
      serverTaskCache = (await api.taskList(c)) as ServerTaskLike[];
    } catch {
      serverTaskCache = [];
    }
  },

  closeTasksPanel() {
    set({ tasksOpen: false, tasksSelected: null });
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
      get().showToast('已取消排队消息');
      const fresh = await api.fetchQueueStatus(c).catch(() => null);
      set({ queueServer: fresh?.queue ?? get().queueServer.filter((q) => q.id !== queueId) });
    } catch (err) {
      get().showToast(`取消失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── 模态 / 抽屉 / 页面 ──────────────────────────────────────────────

  openNewEnv() {
    if (get().recipes.length === 0) void get().refreshSidebar();
    // 1.3.7：新建入口 = 一个四步向导（状态机重置在 model/env-wizard.ts）。
    set({ modal: { kind: 'new-env' }, wizard: initialWizardState() });
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
      set({ wizard: null, modal: null });
      await get().registerDiscovered(key, extras);
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
      get().showToast(`✓ 已登记 ${payload.input.id}`);
    } catch (err) {
      state.showToast(`SSH 接入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async submitAdopt(vmx: string, user: string, keyPath: string, password: string) {
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
      });
      if (!res.success) {
        state.showToast(`认领失败：${res.error ?? '未知错误'}`);
        return;
      }
      set({ modal: null });
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
      state.showToast(`✓ 环境 ${recipeId} 构建完成`);
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
        signal: detail.signal,
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
      set({ historySessions: rows, historyError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ historySessions: null, historyError: message });
      get().showToast(`会话清单加载失败：${message}`);
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
                r.id === id ? { ...r, title: t, titleSource: 'user' as const } : r,
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
      state.showToast('✓ 会话已删除（含 transcript）');
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
      state.showToast('当前 turn 运行中——Esc 中断后再载回（避免与活跃会话流冲突）');
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
      get().showToast('✓ 已载回会话——续跑从最新消息开始');
    } catch (err) {
      state.showToast(`载回失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── Esc 链（单处理器入口） ──────────────────────────────────────────

  esc() {
    const s = get();
    const action = escAction({
      overlayOpen: s.overlay !== null,
      tasksOpen: s.tasksOpen,
      queueOpen: s.queueOpen,
      boundaryOpen: s.boundaryAsks.length > 0,
      decisionOpen: s.decisions.length > 0 && s.activeDecisionId !== null,
      // 1.4.1：验收包模态（autoRun.verdict 存在且未收起）。
      verdictOpen: s.autoRun?.verdict !== undefined && !s.verdictDismissed,
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
      case 'close-tasks':
        set({ tasksOpen: false, tasksSelected: null });
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
      case 'dismiss-verdict':
        // 1.4.1：验收包收起不作答——loop 保持 awaiting-verdict，观察卡
        // 「待终审」可重开。
        set({ verdictDismissed: true });
        break;
      case 'close-modal':
        // G-02（1.3.10）：boot 构建进行中 Esc 不关模态（与 ✕ disabled 对齐）
        // ——不做 abort（bootEnv 无 AbortController，environment/up 继续跑），
        // 完成后 BootModal 自显结果；toast 提示构建仍在进行。
        if (get().modal?.kind === 'boot' && get().boot?.status === 'running') {
          get().showToast('构建进行中');
          break;
        }
        // G-05（1.3.10）：复用 closeModal——modal 与 wizard 一并清（原分支只
        // 清 modal，与 closeModal 语义分裂）。
        get().closeModal();
        break;
      case 'close-drawer':
        set({ drawer: null });
        break;
      case 'close-page':
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

function tauriInvoke(): { invoke?: (cmd: string) => Promise<unknown> } {
  const w =
    typeof window !== 'undefined'
      ? (window as unknown as {
          __TAURI__?: { core?: { invoke?: (cmd: string) => Promise<unknown> } };
        })
      : undefined;
  const invoke = w?.__TAURI__?.core?.invoke;
  return invoke ? { invoke: (cmd: string) => invoke(cmd) } : {};
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
  if (guiKey === get().currentEnvKey) return;
  const key = sessionKey(guiKey);
  set({
    currentEnvKey: guiKey,
    sessions: { ...get().sessions, [key]: get().sessions[key] ?? emptySession() },
    page: 'chat',
  });
  get().reconnect();
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
 * /tasks 面板行装配（bg + subagent + 服务端任务中心三源合一）。
 * 1.3.1 实机修正：必须返回**稳定引用**——React useSyncExternalStore 的
 * getSnapshot 契约要求缓存，每次新数组会触发无限渲染（实机黑屏
 * 「Maximum update depth exceeded」）。按输入引用相等缓存。
 */
let taskRowsCache: { bg: unknown; sub: unknown; server: unknown; rows: TaskRow[] } | null = null;
export function selectTaskRows(s: GuiState): TaskRow[] {
  if (
    taskRowsCache &&
    taskRowsCache.bg === s.bgTasks &&
    taskRowsCache.sub === s.subagents &&
    taskRowsCache.server === serverTaskCache
  ) {
    return taskRowsCache.rows;
  }
  const rows = buildTaskRows(s.bgTasks, s.subagents, serverTaskCache);
  taskRowsCache = { bg: s.bgTasks, sub: s.subagents, server: serverTaskCache, rows };
  return rows;
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
        sessions: { ...get().sessions, [key ?? 'host']: emptySession() },
      });
      get().reconnect();
    }
  } catch {
    // 静默——恢复失败保持宿主线。
  }
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
      await s.openTasksPanel();
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
    case 'extract': {
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
        s.showToast(`/${cmd}：当前会话没有可回退/分叉的消息`);
        return;
      }
      set({ modal: { kind: 'pick-message', command: route.command } });
      return;
    }
  }
}

/** 参数收集完成后的执行（snapshot/rollback/extract/rewind/fork/export）。 */
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
      const res = await c.adminPost<{ success: boolean; error?: string }>(route.endpoint.route, payload);
      if (!res.success) {
        s.showToast(`/${command} 失败：${res.error ?? '未知错误'}`);
        return;
      }
      toastSlashSuccess(s, command, arg);
    } else {
      if (route.command === 'rewind') {
        const res = await api.chatRewind(c, String(payload.userMessageId));
        if (!res.success) {
          s.showToast(`/rewind 失败：${res.error ?? '未知错误'}`);
          return;
        }
        s.showToast('已回退——重连重建该线程历史');
        s.reconnect();
        return;
      }
      if (route.command === 'fork') {
        const res = await api.forkSession(c, String(payload.messageId));
        if (!res.success) {
          s.showToast(`/fork 失败：${res.error ?? '未知错误'}`);
          return;
        }
        s.showToast('已分叉新线程');
        s.reconnect();
      }
    }
  } catch (err) {
    s.showToast(`/${command} 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

function toastSlashSuccess(s: GuiState, command: SlashCommandName, arg: string): void {
  if (command === 'snapshot') {
    s.showToast(arg.trim() ? `✓ 快照 ${arg.trim()} 已建立` : '✓ 快照已建立');
    return;
  }
  if (command === 'rollback') {
    s.showToast(`✓ 已回滚到快照 ${arg.trim()}（回滚后自动恢复运行）`);
    return;
  }
  if (command === 'extract') {
    s.showToast(`✓ 已回收 ${arg.trim()} 到宿主 output/extracted/`);
  }
}
