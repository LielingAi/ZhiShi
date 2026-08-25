/**
 * zustand store（1.3.0 GUI MVP 的组装层）。
 *
 * 分工：纯逻辑（事件归约 / Esc 链 / 发送语义 / 侧栏分组）全部在
 * src/gui/src/model/* 纯函数模块里；本文件只做 I/O 与状态组装——
 * SSE 消费、admin 接口调用、overlay/模态/抽屉/页面的开关。
 *
 * 会话按环境分线：sessions[key]（key = env id），每环境独立块列表与
 * replay 去重集合；切环境 = 重置目标线 + 重连 SSE，由服务端 replay 全量
 * 重建该线历史（「切环境=重新加载该环境的会话流」）。
 */

import { create } from 'zustand';

import { emptySession, type SessionState, type ToolDetail } from '../model/blocks';
import { escAction } from '../model/esc-chain';
import { reduceSseEvent } from '../model/reducer';
import { buildSendBody, classifySendResponse, type Ref } from '../model/send';
import * as api from '../client/api';
import type {
  DiscoveredDocker,
  DiscoveredVm,
  EnvEntry,
  ModelProvider,
  PsInstance,
  Recipe,
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
}

export interface OverlayState {
  kind: OverlayKind;
  title: string;
  items: OverlayItem[];
  sel: number;
}

export type ModalKind = 'new-env' | 'ssh' | 'adopt' | 'boot';

export interface ModalState {
  kind: ModalKind;
  /** boot/adopt 关联的配方 id。 */
  recipeId?: string;
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

export type Page = 'chat' | 'settings' | 'attach';

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
  currentEnvKey: string;

  // 会话（per-env）
  sessions: Record<string, SessionState>;

  // 输入历史（per-env）
  history: Record<string, string[]>;

  // 输入区 @ 引用 chips
  refs: Ref[];

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
  openDrawer(detail: ToolDetail): void;
  closeDrawer(): void;
  setDrawerSearch(q: string): void;
  setPage(page: Page): void;
  showToast(msg: string): void;
  clearToast(): void;
  addRef(ref: Ref): void;
  removeRef(index: number): void;
  addHistory(text: string): void;
  esc(): void;
}

// 模块级单例（连接生命周期跨 action 存在；不进 state 避免渲染抖动）。
let client: GuiSidecarClient | null = null;
let abortController: AbortController | null = null;
let connecting = false;
let lifecycleGen = 0;

function browserStorage(): { getItem(k: string): string | null } | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

function currentSession(s: GuiState): SessionState {
  // 1.3.0 修正：键口径与 reducer/setModel 统一（currentEnvKey || 'host'），
  // 否则 currentEnvKey 为 null 时读写 sessions[null]，永远空会话。
  return s.sessions[s.currentEnvKey || 'host'] ?? emptySession();
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
  currentEnvKey: '',

  sessions: {},
  history: {},
  refs: [],

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
          onReconnect: (attempt, cause) => {
            set({ connectionState: 'reconnecting' });
          },
        })) {
          const state = get();
          const key = state.currentEnvKey || 'host';
          const session = state.sessions[key] ?? emptySession();
          const { session: next, workspace, toast } = reduceSseEvent(session, input);
          set((s) => {
            const patch: Partial<GuiState> = {
              sessions: { ...s.sessions, [key]: next },
              connectionState: 'live',
              connectError: null,
            };
            if (workspace) patch.workspace = workspace;
            if (toast) {
              patch.toast = toast;
              patch.toastNonce = s.toastNonce + 1;
            }
            return patch;
          });
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

  // ── 环境切换（切换即换流） ──────────────────────────────────────────

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
    if (key === state.currentEnvKey) return;
    const res = await api.environmentSelect(c, state.workspace, { kind: 'env', id: key });
    if (!res.success) {
      state.showToast(`切换失败：${res.error ?? '未知错误'}`);
      return;
    }
    set((s) => ({
      currentEnvKey: key,
      sessions: { ...s.sessions, [key]: emptySession() },
      drawer: null,
      overlay: null,
      page: 'chat',
    }));
    get().reconnect();
    void get().refreshSidebar();
    get().showToast(`◈ 已切换到 ${key} 的会话线`);
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
      const key = get().currentEnvKey || 'host';
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
      const key = get().currentEnvKey || 'host';
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
      const items: OverlayItem[] = s.envs.map((e) => ({
        name: e.id,
        detail: `${e.kind} · 环境引用`,
        tag: '环境',
      }));
      if (items.length === 0) {
        items.push({ name: '（无已登记环境）', detail: '@ 引用在 MVP 支持已登记环境', tag: '环境' });
      }
      set({ overlay: { kind, title: '引用环境对象', items, sel: 0 } });
      return;
    }
    if (kind === 'history') {
      const key = s.currentEnvKey || 'host';
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
    set({ overlay: null });
    if (!item) return;

    switch (ov.kind) {
      case 'slash': {
        const cmd = item.name.replace(/^\//, '');
        void runSlashCommand(get, cmd);
        break;
      }
      case 'at': {
        if (s.envs.some((e) => e.id === item.name)) {
          s.addRef({ type: 'env', id: item.name });
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
    const key = get().currentEnvKey || 'host';
    set((s) => {
      const list = [text, ...(s.history[key] ?? [])].slice(0, 200);
      return { history: { ...s.history, [key]: list } };
    });
  },

  // ── Esc 链（单处理器入口） ──────────────────────────────────────────

  esc() {
    const s = get();
    const action = escAction({
      overlayOpen: s.overlay !== null,
      modalOpen: s.modal !== null,
      drawerOpen: s.drawer !== null,
      pageOpen: s.page !== 'chat',
      busy: currentSession(s).phase === 'running',
    });
    switch (action.type) {
      case 'close-overlay':
        set({ overlay: null });
        break;
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
      const key = get().currentEnvKey || 'host';
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

async function runSlashCommand(get: () => GuiState, cmd: string): Promise<void> {
  const s = get();
  switch (cmd) {
    case 'attach':
      s.setPage('attach');
      break;
    case 'model':
      s.openOverlay('model', '');
      break;
    case 'reset':
      await s.runReset();
      break;
    case 'help':
      s.showToast('/help：Esc 中断（busy）· Ctrl+R 历史 · ↑ 空输入历史 · Enter 发送（运行中发送=纠偏）');
      break;
    case 'snapshot':
    case 'rollback':
    case 'extract':
    case 'rewind':
    case 'fork':
    case 'queue':
    case 'tasks':
    case 'export':
      s.showToast(`/${cmd}：MVP 占位（v19 演示语义，待接 admin 接口）`);
      break;
    default:
      s.showToast(`/${cmd}：未知命令`);
  }
}

// ---------------------------------------------------------------------------
// 派生选择器（组件直接调用）
// ---------------------------------------------------------------------------

/** 当前会话派生状态（busy / phase / queue 深度）。 */
export function selectCurrentSession(s: GuiState): SessionState {
  return s.sessions[s.currentEnvKey || 'host'] ?? FALLBACK_SESSION;
}

/** 稳定的空会话单例：sessions 缺条目时兜底，避免 selector 每次返回新引用。 */
const FALLBACK_SESSION = emptySession();
