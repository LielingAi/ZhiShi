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
import { bootStages } from '../model/envs';
import { parseSessionRows, type SessionMetaRow } from '../model/history';
import { buildMentionItems, fileCacheKey, fileDirOf, MENTION_DEBOUNCE_MS, parseMentionQuery } from '../model/mention';
import { planSwitch, sessionKey } from '../model/multi-session';
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
import * as api from '../client/api';
import type {
  AgentEntity,
  DiscoveredDocker,
  DiscoveredVm,
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
  { name: 'export', detail: '导出研究报告', group: '线程' },
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
  | 'ssh'
  | 'adopt'
  | 'boot'
  | 'slash-args'
  | 'pick-message'
  | 'promote';

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
  /** slash-args / pick-message 关联的命令名（rewind/fork/snapshot/rollback/extract）。 */
  command?: SlashCommandName;
  /** promote（入专家库）预填。 */
  prefill?: PromotePrefill;
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
  send(text: string): Promise<void>;
  stopTurn(): Promise<void>;
  runReset(): Promise<void>;
  setModel(providerId: string, model: string): Promise<void>;
  openOverlay(kind: OverlayKind, query: string): void;
  closeOverlay(): void;
  moveOverlay(delta: number): void;
  pickOverlay(index: number): void;
  openNewEnv(): void;
  closeModal(): void;
  setModal(modal: ModalState | null): void;
  submitSsh(host: string, user: string, keyPath: string): Promise<void>;
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
/** 1.3.4：@ 补全富化防抖计时器（新查询替换旧的待发请求）。 */
let mentionTimer: ReturnType<typeof setTimeout> | null = null;

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined;
  }
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

  tools: [],

  historySessions: null,
  historyError: null,
  mentionApply: null,

  tasksOpen: false,
  tasksSelected: null,
  queueOpen: false,
  queueServer: [],

  boot: null,

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
    const [envs, running, discover, recipes] = await Promise.allSettled([
      api.fetchEnvironmentList(c),
      api.fetchEnvironmentPs(c),
      api.fetchEnvironmentDiscover(c),
      api.fetchEnvironmentRecipes(c),
    ]);
    set((s) => ({
      envs: envs.status === 'fulfilled' ? envs.value : s.envs,
      running: running.status === 'fulfilled' ? running.value : s.running,
      discoveredDocker: discover.status === 'fulfilled' ? discover.value.docker : s.discoveredDocker,
      discoveredVm: discover.status === 'fulfilled' ? discover.value.vm : s.discoveredVm,
      recipes: recipes.status === 'fulfilled' ? recipes.value : s.recipes,
    }));
  },

  // ── 环境切换（1.3.2 ③ A 形态：换激活指针，不丢任何线的本地状态） ──

  async switchEnv(key: string) {
    const state = get();
    const c = client;
    if (!c) {
      state.showToast('未连接 sidecar');
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

  // ── 发送 / 纠偏 / 中断 / 重置 ───────────────────────────────────────

  async send(text: string) {
    const c = client;
    if (!c) {
      get().showToast('未连接 sidecar');
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
      const list = s.history[key] ?? [];
      const items = list
        .filter((h) => !query || h.includes(query))
        .slice(0, 8)
        .map((h) => ({ name: h }));
      set({ overlay: { kind, title: `历史 · ${query || '全部'}`, items, sel: 0 } });
      return;
    }
    if (kind === 'model') {
      const curModel = currentSession(s).model;
      const items: OverlayItem[] = [];
      for (const p of s.models) {
        if (p.enabled === false) continue;
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
      set({ overlay: { kind, title: '选择模型', items, sel: 0 } });
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
    set({ modal: { kind: 'new-env' } });
  },

  closeModal() {
    set({ modal: null });
  },

  setModal(modal) {
    set({ modal });
  },

  async submitSsh(host: string, user: string, keyPath: string) {
    const c = client;
    if (!c) return;
    const id = `${user}@${host}`;
    const res = await api.environmentAdd(c, {
      id,
      kind: 'ssh',
      host,
      user: user || undefined,
      keyPath: keyPath || undefined,
    });
    if (!res.success) {
      get().showToast(`SSH 接入失败：${res.error ?? '未知错误'}`);
      return;
    }
    set({ modal: null });
    void get().refreshSidebar();
    get().showToast(`✓ 已登记 ${id}`);
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
      });
      stopBootPolling();
      if (!res.success) {
        set({ boot: { recipeId, base: recipe?.base, stage: stages.length - 1, status: 'failed', error: res.error } });
        state.showToast(`构建失败：${res.error ?? '未知错误'}`);
        return;
      }
      set({ boot: { recipeId, base: recipe?.base, stage: stages.length, status: 'done' } });
      void state.refreshSidebar();
      state.showToast(`✓ 环境 ${recipeId} 构建完成`);
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
    set((s) => {
      const list = [text, ...(s.history[key] ?? [])].slice(0, 200);
      return { history: { ...s.history, [key]: list } };
    });
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
      modalOpen: s.modal !== null,
      drawerOpen: s.drawer !== null,
      pageOpen: s.page !== 'chat',
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
      case 'close-modal':
        set({ modal: null });
        break;
      case 'close-drawer':
        set({ drawer: null });
        break;
      case 'close-page':
        set({ page: 'chat' });
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

async function loadModels(
  get: () => GuiState,
  set: (partial: Partial<GuiState>) => void,
): Promise<void> {
  const c = client;
  if (!c) return;
  try {
    const { providers, current } = await api.fetchModelList(c);
    if (get().models.length === 0) set({ models: providers });
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
      if (!s.workspace) {
        s.showToast('/export：工作区尚未就绪（等待 chat:init）');
        return;
      }
      const payload = slashPayload(route, { envKey: s.currentEnvKey, workspace: s.workspace });
      if (!payload) {
        s.showToast(noEnvToast(route.command));
        return;
      }
      const c = client;
      if (!c) {
        s.showToast('未连接 sidecar');
        return;
      }
      s.showToast('⏳ 组装报告（含越界批准与证据回收）…');
      try {
        const res = await api.reportExport(c, payload as { workspace: string });
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

/** 参数收集完成后的执行（snapshot/rollback/extract/rewind/fork）。 */
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
