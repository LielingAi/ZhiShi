/**
 * app (plan §2.1, design §3/§5). The orchestration layer — owns the mode FSM,
 * the SSE pump, the key router, and every overlay. Rendering is delegated:
 * scrollback rows come from blocks/*, pinned chrome from chrome.ts; the
 * TerminalWriter diffs them onto the screen.
 *
 * Modes:    gate (正门选环境) → chat (会话)
 * Overlays: completion / help / history-search / rewind / queue / tasks /
 *           drawer / modal — additive panels above the input box, one at a time.
 *
 * Invariants:
 *   - The input box is NEVER replaced by a panel (panels render above it).
 *   - Esc walks one chain only: overlay > scrollback > clear input > interrupt.
 *   - While modal is active every other key is swallowed.
 *   - The spinner timer repaints ONLY the status bar.
 */

import { TerminalWriter } from './terminal-writer';
import type { SidecarClient } from '../client';
import type { SSEEvent } from '../../../shared/sse-parser';
import { parseKeys, keyToEdit, hasMod, type Key } from './keymap';
import { LineEditor } from './editor';
import { HistoryStore } from './history';
import { reduceSseEvent, type ReduceResult } from './event-reducer';
import {
  composeStatusBar,
  composeInputBox,
  composeOverlay,
  composeModalBox,
  overlayRow,
  overlayHeader,
  type OverlayItem,
} from './chrome';
import { renderUser, renderAssistant } from './blocks/message-block';
import { renderToolFolded, renderToolExpanded } from './blocks/tool-block';
import {
  renderDivider,
  renderError,
  renderBackground,
  renderWelcome,
  renderResumeHint,
  interruptLabel,
} from './blocks/dividers';
import {
  SLASH_COMMANDS,
  filterByQuery,
  type AtItem,
} from './commands';
import type { GateResult } from './gate';
import { GateController, type ManualFormState } from './gate-controller';
import { composeBackgroundSeg } from './bg-tasks';
import { reduceHiddenLine, type HiddenLineOutcome } from './model';
import {
  narrowTranscript,
  renderTranscriptItems,
  wrapPanelLine,
  type TranscriptView,
} from './task-transcript';
import { runSnapshot, runRollback, runExtract } from './slash/env';
import { runExport } from './slash/report';
import { runModel } from './slash/model';
import { runMcp } from './slash/mcp';
import type { PushBlockInput, SlashContext } from './slash/types';
import {
  reduceOverlayKey,
  type Overlay,
  type OverlayEffect,
  type OverlayKeyEnv,
  type CompletionEntry,
} from './overlay-reducer';
import type { Block, SessionState, ModalState, RefAttachment } from './types';

// ---------------------------------------------------------------------------

export interface AppDeps {
  client: SidecarClient;
  writer: TerminalWriter;
  input: NodeJS.ReadStream;
  /** Workspace (= agentDir) — environment/select persistence target. */
  workspace: string;
  /** 预选环境——跳过正门直进 chat。1.3.5 起生产不再注入(flag 直通已移除),
   *  仅保留为单测夹具(字节链路测试直进 chat 的注入缝)。 */
  presetEnv?: GateResult | null;
  history?: HistoryStore;
}

const PANEL_MAX_ROWS = 12;
const INPUT_MAX_CONTENT = 8;
/** U5(1.1.10):drawer ←/→ 可切换的最近 tool 卡数量。 */
const DRAWER_SWITCH_RECENT = 5;

/** A′(1.1.10):/tasks 详情的 transcript 拉取缓存态。 */
type TranscriptCacheEntry =
  | { status: 'loading' }
  | { status: 'ok'; transcript: TranscriptView }
  | { status: 'error' };

export class App {
  private client: SidecarClient;
  private writer: TerminalWriter;
  private input: NodeJS.ReadStream;
  private workspace: string;
  private history: HistoryStore;

  private mode: 'gate' | 'chat';
  private overlay: Overlay | null = null;
  private state: SessionState = freshState();
  private editor = new LineEditor();
  private env: { name?: string; kind?: string } = {};
  private atItems: AtItem[] = [];

  // gate（1.1.10 B）：正门选择 + 手动 SSH 表单由 GateController 持有。
  private gate: GateController;

  /** 隐藏输入接管(/model set-key):非 null 时按键只进缓冲,不进消息编辑器。 */
  private hiddenLine: { buffer: string; prompt: string; resolve: (v: string | null) => void } | null = null;

  private showWelcome = false;
  private reconnecting = false;
  /** A′(1.1.10):loopSessionId → transcript 拉取态(同 id 不重复拉,面板关闭清空)。 */
  private transcriptCache = new Map<string, TranscriptCacheEntry>();
  private turnStartedAt = 0;
  private spinnerFrame = 0;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private escTimer: NodeJS.Timeout | null = null;
  private running = false;
  private abort = new AbortController();
  /** M11(1.2.8):bracketed paste 跨 chunk 累积缓冲(null=非粘贴模式)。 */
  private pasteBuffer: string | null = null;
  private readonly onData = (chunk: Buffer | string): void => this.onBytes(chunk);

  /** Set when the user requests exit; the entry polls this. */
  quitRequested = false;

  constructor(deps: AppDeps) {
    this.client = deps.client;
    this.writer = deps.writer;
    this.input = deps.input;
    this.workspace = deps.workspace;
    this.history = deps.history ?? new HistoryStore('agent');
    this.editor.setHistory(this.history.recentTexts());
    this.mode = deps.presetEnv ? 'chat' : 'gate';
    if (deps.presetEnv) {
      this.env = { name: deps.presetEnv.id, kind: deps.presetEnv.envKind };
    }
    this.gate = new GateController({
      client: this.client,
      workspace: this.workspace,
      editor: this.editor,
      enterGateMode: () => {
        this.mode = 'gate';
        this.overlay = null;
      },
      enterChat: () => this.enterChat(),
      requestQuit: () => {
        this.quitRequested = true;
      },
      setEnv: (env) => {
        this.env = env;
      },
      clearScrollback: () => this.writer.clear(),
      appendRaw: (lines) => this.appendRaw(lines),
      renderChrome: () => this.renderChrome(),
      layoutCols: () => this.writer.layout().cols,
    });
  }

  // gate 状态由 GateController 持有；这三个访问器保持既有读取路径
  // （currentHint / promptLead / startSpinner 与启动正门测试）不变。
  private get gateCursor(): number {
    return this.gate.gateCursor;
  }
  private get gateBusy(): boolean {
    return this.gate.gateBusy;
  }
  private get manualForm(): ManualFormState | null {
    return this.gate.manualForm;
  }

  async start(): Promise<void> {
    this.running = true;
    this.input.on('data', this.onData);
    this.startSpinner();
    if (this.mode === 'chat') {
      this.enterChat();
    } else {
      await this.gate.enter();
    }
  }

  /** Detach stdin + abort the SSE pump + stop timers. Entry calls on shutdown. */
  dispose(): void {
    this.input.removeListener('data', this.onData);
    this.running = false;
    this.abort.abort();
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    if (this.escTimer) clearTimeout(this.escTimer);
  }

  // -------------------------------------------------------------------------
  // Chat mode entry
  // -------------------------------------------------------------------------

  private enterChat(): void {
    this.mode = 'chat';
    this.overlay = null;
    this.state = freshState();
    this.showWelcome = true;
    this.writer.clear();
    this.repaintAll();
    this.renderChrome();
    void this.refreshAtItems();
    // H4(1.2.8):先断旧泵再新泵(同 restartPump 范式)——直接 void this.pump()
    // 会让旧泵继续消费,gate→chat 每进出一次叠加一条泵。
    this.abort.abort();
    this.abort = new AbortController();
    void this.pump();
  }

  private async refreshAtItems(): Promise<void> {
    try {
      const res = await this.client.adminPost<{ data?: { environments?: { id: string; kind: string }[] } }>(
        'environment/list',
        {},
      );
      this.atItems = (res.data?.environments ?? []).map((e) => ({
        label: `@${e.id}`,
        detail: `环境 · ${e.kind}`,
        insert: e.id,
        ref: { type: 'env', id: e.id },
      }));
    } catch {
      this.atItems = [];
    }
  }

  // -------------------------------------------------------------------------
  // SSE pump
  // -------------------------------------------------------------------------

  private async pump(): Promise<void> {
    const gen = this.client.openSse('/chat/stream', {
      signal: this.abort.signal,
      onReconnect: () => {
        this.reconnecting = true;
        this.renderChrome();
      },
    });
    for await (const ev of gen) {
      if (!this.running) break;
      this.ingest(ev);
    }
  }

  private ingest(ev: SSEEvent): void {
    this.reconnecting = false;
    let payload: unknown;
    if (!ev.data) {
      payload = {};
    } else {
      try {
        payload = JSON.parse(ev.data);
      } catch {
        payload = ev.data; // bare-string payloads (e.g. message-error) must survive
      }
    }
    const name: string =
      ev.event ??
      (payload && typeof payload === 'object' ? String((payload as Record<string, unknown>).event ?? '') : '');
    const patch = reduceSseEvent(this.state, { event: name, payload });
    if (patch.status) Object.assign(this.state.status, patch.status);
    // 越界 ask(design §6.6):开红色模态,应答 POST 回服务端。
    if (patch.modal) this.openBoundaryModal(patch.modal);
    if (patch.modalExpired) this.closeBoundaryModal(patch.modalExpired, true);
    // Turn clock: starts when the phase flips to running, stops on any exit.
    if (this.state.status.phase === 'running') {
      if (!this.turnStartedAt) this.turnStartedAt = Date.now();
    } else {
      this.turnStartedAt = 0;
    }
    this.state.status.backgroundSeg = composeBackgroundSeg(this.state);
    // M5(1.2.8):gate 模式下只归约 state、不写屏——正门是 appendRaw 直排,
    // repaintBlocks/renderChrome 会把会话块与 chrome 画进正门。回 chat 时
    // enterChat 全量重绘,不丢内容。
    if (this.mode === 'gate') return;
    // H3(1.2.8):重连 replay 前导清了非 streaming 的 live 块(reducer 置
    // reset)——全量重绘,被清行立刻从屏上消失,不等下一次局部重绘。
    if (patch.reset) {
      this.repaintAll();
    } else if (patch.appended.length || patch.touched.length) this.repaintBlocks(patch);
    this.renderChrome();
  }

  // -------------------------------------------------------------------------
  // Key routing
  // -------------------------------------------------------------------------

  private onBytes(chunk: Buffer | string): void {
    // L6(1.2.8):entry 对 stdin setEncoding('utf8') 后 data 事件给 string
    // (string_decoder 处理跨 chunk 多字节);测试仍可能喂 Buffer,两者都接。
    let rest = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    // M11(1.2.8):bracketed paste 跨 chunk 缓冲——\x1b[200~ 后进缓冲模式,
    // 累积到 \x1b[201~ 才整段插入;起始/结束标记落在 chunk 中部时,标记前
    // 的普通按键照常解析。
    while (rest.length > 0) {
      if (this.pasteBuffer !== null) {
        const end = rest.indexOf('\x1b[201~');
        if (end < 0) {
          this.pasteBuffer += rest;
          return;
        }
        const body = this.pasteBuffer + rest.slice(0, end);
        this.pasteBuffer = null;
        this.applyPaste(body);
        rest = rest.slice(end + 6);
        continue;
      }
      const start = rest.indexOf('\x1b[200~');
      if (start < 0) break;
      if (start > 0) this.onPlainBytes(rest.slice(0, start));
      rest = rest.slice(start + 6);
      const end = rest.indexOf('\x1b[201~');
      if (end < 0) {
        this.pasteBuffer = rest;
        return;
      }
      this.applyPaste(rest.slice(0, end));
      rest = rest.slice(end + 6);
    }
    if (rest.length > 0) this.onPlainBytes(rest);
  }

  /** 普通按键字节:Esc 消歧 + parseKeys 逐键路由(原 onBytes 的非粘贴路径)。 */
  private onPlainBytes(raw: string): void {
    // Esc disambiguation: a lone \x1b waits 30ms for a possible CSI tail.
    if (raw === '\x1b') {
      if (this.escTimer) clearTimeout(this.escTimer);
      this.escTimer = setTimeout(() => {
        this.escTimer = null;
        this.onKey({ name: 'esc', mods: [] });
      }, 30);
      return;
    }
    for (const key of parseKeys(raw)) this.onKey(key);
  }

  /** 粘贴体整段插入(brackets 已剥离);隐藏输入中逐字符进缓冲、不回显。 */
  private applyPaste(body: string): void {
    // 隐藏输入中粘贴:逐可打印字符进缓冲(换行剥离),不渲染不回显。
    if (this.hiddenLine) {
      this.appendHiddenPaste(body);
      return;
    }
    this.editor.apply({ type: 'paste', text: body });
    this.updateLiveCompletion(); // U7a(1.1.9):粘贴与普通击键同待遇——补全联动
    this.renderChrome();
  }

  private onKey(key: Key): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    // Swallow the placeholder keys the parser emits for unknown sequences.
    if (key.char === '' && key.name === undefined) return;
    // 隐藏输入接管:接管期间所有按键路由到隐藏缓冲,不进编辑器/补全/消息流。
    if (this.hiddenLine) {
      this.onHiddenLineKey(key);
      return;
    }
    // Modal swallows everything but y/n (design §6.6 — 越界无惯性)。
    // M5(1.2.8):modal 检查必须先于 gate 路由——gate 模式下开着 boundary modal
    // 时 y/n 会被 gate 吞掉,模态永远等不到应答(死锁)。
    if (this.overlay?.kind === 'modal') {
      const ans = key.char === 'y' || key.char === 'Y' ? 'y' : key.char === 'n' || key.char === 'N' ? 'n' : null;
      if (ans) {
        const st = this.overlay.state;
        this.overlay = null;
        st.resolve?.(ans === 'y');
        this.renderChrome();
      }
      return;
    }
    if (this.mode === 'gate') {
      void this.gate.onKey(key);
      return;
    }
    if (hasMod(key, 'ctrl') && key.char === 'c') return this.onCtrlC();
    if (this.overlay) return this.onOverlayKey(key);
    return this.onInputKey(key);
  }

  private onCtrlC(): void {
    if (!this.editor.isEmpty) {
      this.editor.setText('');
      this.closeOverlay();
      this.renderChrome();
      return;
    }
    if (this.state.status.phase === 'running') {
      void this.stop();
      return;
    }
    this.quitRequested = true;
  }

  // --- hidden line input (readHiddenLine) ---

  /**
   * 隐藏输入(readHiddenLine):返回 Promise<string | null>——Enter 提交值,
   * Esc / Ctrl+C 取消返回 null。接管期间 onKey 全部路由到 onHiddenLineKey,
   * 字符只进缓冲、不渲染不回显,消息编辑流完全不参与。
   */
  private startHiddenLine(prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.closeOverlay();
      this.editor.setText('');
      this.hiddenLine = { buffer: '', prompt, resolve };
      this.renderChrome();
    });
  }

  /** 隐藏输入按键路由:可打印字符进缓冲,退格回删,Enter 提交,Esc 取消。 */
  private onHiddenLineKey(key: Key): void {
    const hl = this.hiddenLine;
    if (!hl) return;
    let out: HiddenLineOutcome;
    if (key.name === 'enter') out = reduceHiddenLine(hl.buffer, { type: 'submit' });
    else if (key.name === 'esc' || (hasMod(key, 'ctrl') && key.char === 'c')) out = reduceHiddenLine(hl.buffer, { type: 'cancel' });
    else if (key.name === 'backspace') out = reduceHiddenLine(hl.buffer, { type: 'backspace' });
    else if (typeof key.char === 'string' && key.char.length === 1 && !hasMod(key, 'ctrl') && !hasMod(key, 'alt')) out = reduceHiddenLine(hl.buffer, { type: 'char', char: key.char });
    else return; // 方向键/功能键等忽略——隐藏输入只吃可打印字符
    if (!out.done) {
      hl.buffer = out.buffer;
      this.renderChrome();
      return;
    }
    this.hiddenLine = null;
    this.renderChrome();
    hl.resolve(out.cancelled ? null : out.value);
  }

  /** 隐藏输入中的粘贴(夹带在 bracketed-paste 序列里):逐字符进缓冲。 */
  private appendHiddenPaste(body: string): void {
    const hl = this.hiddenLine;
    if (!hl) return;
    for (const ch of body.replace(/[\r\n]/g, '')) {
      const out = reduceHiddenLine(hl.buffer, { type: 'char', char: ch });
      if (out.done) break; // 满长拒绝后不再追加
      hl.buffer = out.buffer;
    }
    this.renderChrome();
  }

  // --- input mode ---

  private onInputKey(key: Key): void {
    if (key.name === 'esc') {
      if (this.scrollActive) {
        this.scrollActive = false;
        this.writer.scrollToTail();
      } else if (!this.editor.isEmpty) {
        // 1.3.5:Esc 清草稿后 ↑/Ctrl+Y 恢复的一次性草稿槽已移除(瘦身砍项)。
        this.editor.setText('');
      } else if (this.state.status.phase === 'running') {
        void this.stop();
      }
      this.renderChrome();
      return;
    }
    if (key.name === 'pgup' || key.name === 'pgdn') {
      // U6(1.1.9):整页翻页(页高=输出区可视行数),取代固定 ±10 行。
      this.writer.scrollPages(key.name === 'pgup' ? 1 : -1);
      this.renderChrome();
      return;
    }
    if (key.name === 'home' && hasMod(key, 'ctrl')) {
      // U6(1.1.9):Ctrl+Home 跳到最早一行;回底保持 Esc/滚到底语义。
      this.writer.scrollToTop();
      this.renderChrome();
      return;
    }
    if (key.name === 'wheel-up' || key.name === 'wheel-down') {
      this.writer.scrollBy(key.name === 'wheel-up' ? 3 : -3);
      this.renderChrome();
      return;
    }
    if (hasMod(key, 'ctrl') && key.char === 'o') return this.toggleDrawer();
    if (hasMod(key, 'ctrl') && key.char === 'z') return this.openRewind();
    if (hasMod(key, 'ctrl') && key.char === 'r') return this.openHistorySearch();
    if (key.name === 'tab') {
      // 1.2.9(Q3):Tab 唤起补全。overlay 存在时键在 :406 已被 onOverlayKey
      // 路由(那里的 tab=接受选中项),本函数只在无 overlay 时可达——此前
      // 这里的 completion 分支是不可达死代码,无 overlay 时 Tab 是纯无操作。
      // 改为:输入以 / 或 @ 开头(单行)时 Tab 主动唤起补全面板(shell 式
      // 唤起,与帮助文案「Tab 补全」口径一致);其余输入 updateLiveCompletion
      // 自然无操作。
      this.updateLiveCompletion();
      this.renderChrome();
      return;
    }
    if (key.name === 'enter') {
      void this.submit();
      return;
    }
    if (key.name === 'newline') {
      this.editor.apply({ type: 'newline' });
      this.renderChrome();
      return;
    }
    // ↑/↓: completion navigation > history recall (empty/on-edge) > editor move.
    if (key.name === 'up' || key.name === 'down') {
      if (this.editor.isEmpty || (key.name === 'up' && this.editor.onFirstLine) || (key.name === 'down' && this.editor.onLastLine)) {
        this.editor.apply({ type: key.name === 'up' ? 'history-prev' : 'history-next' });
      } else {
        this.editor.apply({ type: key.name });
      }
      this.renderChrome();
      return;
    }
    const edit = keyToEdit(key);
    if (edit) {
      this.editor.apply(edit);
      this.updateLiveCompletion();
      this.renderChrome();
    }
  }

  private get scrollActive(): boolean {
    return this.writer.viewportState().following === false;
  }
  private set scrollActive(v: boolean) {
    if (!v) this.writer.scrollToTail();
  }

  // --- overlays ---

  private onOverlayKey(key: Key): void {
    const ov = this.overlay;
    if (!ov) return;
    // 状态变更全部在 overlay-reducer 纯归约；这里只执行副作用 + 重绘。
    const { overlay, effect } = reduceOverlayKey(ov, key, this.overlayKeyEnv(ov));
    this.overlay = overlay;
    // A′:tasks 面板关掉(或换成别的 overlay)即清 transcript 缓存。
    if (ov.kind === 'tasks' && overlay?.kind !== 'tasks') this.transcriptCache.clear();
    if (effect) this.applyOverlayEffect(effect);
    this.renderChrome();
  }

  /** reducer 判定数据的现取注入（只算当前 overlay 种类需要的）。 */
  private overlayKeyEnv(ov: Overlay): OverlayKeyEnv {
    let drawerTotal: number | null = null;
    if (ov.kind === 'drawer') {
      const blk = this.state.blocks.find((b) => b.id === ov.blockId);
      if (blk && blk.kind === 'tool') drawerTotal = (blk.output ?? '').split('\n').length;
    }
    return {
      editorText: this.editor.text,
      historyTexts: ov.kind === 'history' ? this.history.recentTexts().reverse() : [],
      taskRowCount: ov.kind === 'tasks' ? this.collectTaskRows().length : 0,
      taskDetailTotal:
        ov.kind === 'tasks' && ov.detail
          ? this.taskDetailItems(ov, this.writer.layout().cols).items.length
          : 0,
      drawerTotal,
      drawerToolIds: ov.kind === 'drawer' ? this.recentToolBlockIds() : [],
      helpRowCount: ov.kind === 'help' ? SLASH_COMMANDS.length : 0,
    };
  }

  /** U5:最近 N 个 tool 块 id(旧→新)——drawer ←/→ 的切换候选环。 */
  private recentToolBlockIds(): string[] {
    const ids: string[] = [];
    for (const b of this.state.blocks) if (b.kind === 'tool') ids.push(b.id);
    return ids.slice(-DRAWER_SWITCH_RECENT);
  }

  /** overlay reducer 归约出的副作用在这里统一执行。 */
  private applyOverlayEffect(effect: OverlayEffect): void {
    switch (effect.type) {
      case 'accept-completion':
        this.acceptCompletion();
        return;
      case 'submit':
        void this.submit();
        return;
      case 'editor-edit':
        this.editor.apply(effect.edit);
        this.updateLiveCompletion();
        return;
      case 'history-pick':
        if (effect.text) this.editor.setText(effect.text);
        return;
      case 'rewind-go':
        if (effect.action === 'fork') void this.doFork(effect.srvId);
        else void this.doRewind(effect.srvId);
        return;
      case 'queue-cancel':
        void this.client.postJson('/chat/queue/cancel', { queueId: effect.id }).catch(() => {});
        return;
      case 'tasks-open-detail':
        this.maybeFetchTaskTranscript();
        return;
      case 'drawer-repaint': {
        // U5:切换目标时旧卡也要重绘(收起展开态)。
        const touched = effect.prevBlockId ? [effect.prevBlockId, effect.blockId] : [effect.blockId];
        this.repaintBlocks({ touched, appended: [] });
        return;
      }
    }
  }

  private closeOverlay(): void {
    this.overlay = null;
  }

  // --- overlay openers ---

  /** /help:命令帮助面板(1.3.5 起只列斜杠命令——键位帮助表已随 Ctrl+L 移除)。 */
  private openHelp(): void {
    this.overlay = { kind: 'help', sel: 0 };
    this.renderChrome();
  }

  private toggleDrawer(): void {
    if (this.overlay?.kind === 'drawer') {
      const id = this.overlay.blockId;
      this.closeOverlay();
      this.repaintBlocks({ touched: [id], appended: [] });
      this.renderChrome();
      return;
    }
    // The LATEST tool block (the first cut expanded the first one — dead UI).
    const tool = [...this.state.blocks].reverse().find((b) => b.kind === 'tool');
    if (!tool) return;
    this.overlay = { kind: 'drawer', blockId: tool.id, offset: 0 };
    this.repaintBlocks({ touched: [tool.id], appended: [] });
    this.renderChrome();
  }

  private openRewind(action: 'rewind' | 'fork' = 'rewind'): void {
    // rewind 只能以 user 消息为锚(服务端 rewindPiChat 语义);fork 任意消息可分叉。
    const candidates = this.state.blocks
      .filter((b) => {
        if (b.kind === 'user') return Boolean(b.srvId);
        if (action === 'fork' && b.kind === 'assistant') return Boolean((b as import('./types').AssistantBlock).srvId);
        return false;
      })
      .map((b) => ({
        srvId: (b as import('./types').UserBlock).srvId!,
        label: `${b.kind === 'user' ? '❯' : '⏺'} ${(b as import('./types').UserBlock).text.replace(/\n/g, ' ')}`,
      }))
      .reverse();
    if (candidates.length === 0) return;
    this.overlay = { kind: 'rewind', action, candidates, sel: 0 };
    this.renderChrome();
  }

  private async doRewind(srvId: string): Promise<void> {
    const res = await this.client
      .postJson<{ success?: boolean; error?: string }>('/chat/rewind', { userMessageId: srvId })
      .catch((err): { success?: boolean; error?: string } => ({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    if (res.success === false) {
      this.pushBlock({ kind: 'error', text: `回退失败：${res.error ?? '未知错误'}` });
      return;
    }
    // Server truncated; mirror locally: drop the target user message and
    // everything after it, and prefill the editor for the re-send.
    const idx = this.state.blocks.findIndex((b) => b.kind === 'user' && (b as import('./types').UserBlock).srvId === srvId);
    if (idx >= 0) {
      const target = this.state.blocks[idx] as import('./types').UserBlock;
      this.editor.setText(target.text);
      this.state.blocks.splice(idx);
      // H6(1.2.8):服务端 rewind 后 messageSeq=0、id 从 0 全量复用——只删被移除
      // user 块的 srvId 不够(assistant/tool 旧 id 也会撞新消息),整个集合作废。
      this.state.seenSrvIds.clear();
      this.repaintAll();
    }
    this.renderChrome();
  }

  /**
   * fork(线程分叉):服务端把目标消息所在 turn 的末尾之前复制成新 loop
   * 会话并原地换血;客户端清本地态 + 重启 SSE 泵(重连即重放分叉历史)。
   */
  private async doFork(srvId: string): Promise<void> {
    const res = await this.client
      .postJson<{ success?: boolean; error?: string }>('/sessions/fork', { messageId: srvId })
      .catch((err): { success?: boolean; error?: string } => ({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    if (res.success === false) {
      this.pushBlock({ kind: 'error', text: `分叉失败：${res.error ?? '未知错误'}` });
      return;
    }
    this.pushBlock({ kind: 'divider', label: '已分叉到新线程（原线程不动）', tone: 'info' });
    this.restartPump();
  }

  /** 断泵 → 新 AbortController → 重泵(/chat/stream 重连重放分叉后的历史)。 */
  private restartPump(): void {
    this.abort.abort();
    this.abort = new AbortController();
    this.state = freshState();
    this.showWelcome = false; // 分叉历史马上重放,不再要欢迎卡
    this.repaintAll();
    this.renderChrome();
    void this.pump();
  }

  private openHistorySearch(): void {
    const texts = this.history.recentTexts().reverse(); // newest first
    this.overlay = { kind: 'history', query: '', results: texts, sel: 0 };
    this.renderChrome();
  }

  private async openQueue(): Promise<void> {
    const res = await this.client
      .getJson<{ success?: boolean; queue?: { id: string; messagePreview: string; kind: string }[] }>('/chat/queue/status')
      .catch(() => null);
    const items = (res?.queue ?? []).map((q) => ({
      id: q.id,
      preview: q.messagePreview,
      kindLabel: q.kind === 'steering' ? '纠偏' : '排队',
    }));
    if (items.length === 0) {
      this.pushBlock({ kind: 'divider', label: '队列为空', tone: 'info' });
      return;
    }
    this.overlay = { kind: 'queue', items, sel: 0 };
    this.renderChrome();
  }

  /** /tasks(U2 1.1.9):子任务 + 后台进程面板。数据直读 state,事件重绘即刷新。 */
  private openTasks(): void {
    this.overlay = { kind: 'tasks', sel: 0, detail: false, offset: 0 };
    this.renderChrome();
  }

  /** 面板行数据:subagent 任务在前,长驻进程在后(均为 Map 插入序)。 */
  private collectTaskRows(): { label: string; lines: string[]; taskId?: string }[] {
    const rows: { label: string; lines: string[]; taskId?: string }[] = [];
    for (const t of this.state.tasks.values()) {
      rows.push({
        taskId: t.id,
        label: t.done
          ? `✓ ${t.description}${t.latestConclusion ? ` — ${t.latestConclusion}` : ''}`
          : `… ${t.description} · 输出 ${t.outputCount}`,
        lines: [
          `描述：${t.description}`,
          `状态：${t.done ? '已完成' : '运行中'}`,
          `输出：${t.outputCount}`,
          `结论：${t.latestConclusion ?? '（暂无）'}`,
        ],
      });
    }
    for (const b of this.state.bgProcs.values()) {
      rows.push({
        label: `⚙ ${b.tag}${b.pid !== undefined ? ` · pid ${b.pid}` : ''} · ${b.commandPreview}`,
        lines: [
          `Tag：${b.tag}`,
          ...(b.pid !== undefined ? [`PID：${b.pid}`] : []),
          `命令：${b.commandPreview}`,
          '状态：运行中',
        ],
      });
    }
    return rows;
  }

  /** 详情页选中的 subagent 任务(后台进程行/越界 → undefined)。 */
  private detailTask(ov: Extract<Overlay, { kind: 'tasks' }>): import('./types').BackgroundTask | undefined {
    const rows = this.collectTaskRows();
    const row = rows[Math.max(0, Math.min(ov.sel, rows.length - 1))];
    return row?.taskId ? this.state.tasks.get(row.taskId) : undefined;
  }

  /**
   * A′(1.1.10):打开详情时按需拉子代理 transcript。状态机:
   * 无 loopSessionId(旧任务/后台进程) → 不拉,详情页落 summary;
   * 缓存 miss → loading(「读取中…」)+ 异步 GET;200 → ok 渲染条目流;
   * 404/失败 → error,落回 summary。同一 sessionId 重复打开不重复拉。
   */
  private maybeFetchTaskTranscript(): void {
    const ov = this.overlay;
    if (ov?.kind !== 'tasks' || !ov.detail) return;
    const sessionId = this.detailTask(ov)?.loopSessionId;
    if (!sessionId || this.transcriptCache.has(sessionId)) return;
    this.transcriptCache.set(sessionId, { status: 'loading' });
    void this.client
      .getJson(`/api/loop-session/messages?loopSessionId=${encodeURIComponent(sessionId)}`)
      .then((res) => {
        const transcript = narrowTranscript(res);
        this.transcriptCache.set(sessionId, transcript ? { status: 'ok', transcript } : { status: 'error' });
      })
      .catch(() => {
        this.transcriptCache.set(sessionId, { status: 'error' });
      })
      .finally(() => {
        // 异步到达必须触发重绘(「读取中…」→ transcript / summary 回退)。
        this.renderChrome();
      });
  }

  /**
   * /tasks 详情页内容(transcript 条目流 / 读取中 / summary 回退)。渲染与
   * overlayKeyEnv(taskDetailTotal)共用这一条路径,滚动夹紧的上界永远与
   * 实际渲染行数一致。followSel 喂给 composeOverlay 的滚动窗口(-1 = 顶)。
   */
  private taskDetailItems(
    ov: Extract<Overlay, { kind: 'tasks' }>,
    cols: number,
  ): { title: string; items: OverlayItem[]; followSel: number } {
    const rows = this.collectTaskRows();
    const inner = Math.max(8, cols - 4);
    const task = this.detailTask(ov);
    const sessionId = task?.loopSessionId;
    if (sessionId) {
      const cached = this.transcriptCache.get(sessionId);
      if (cached?.status === 'ok') {
        const items = renderTranscriptItems(cached.transcript, inner);
        return {
          title: `工作史（↑↓ 滚动 · Enter/Esc 返回）`,
          items,
          followSel: Math.min(ov.offset, items.length - 1),
        };
      }
      if (!cached || cached.status === 'loading') {
        return {
          title: '工作史（Enter/Esc 返回）',
          items: [{ spans: [{ text: '读取中…', style: { fg: 'faint' as const } }], selectable: false }],
          followSel: -1,
        };
      }
      // error → 落回 summary 视图。
    }
    const row = rows[Math.max(0, Math.min(ov.sel, rows.length - 1))];
    const items = (row?.lines ?? [])
      .flatMap((ln) => wrapPanelLine(ln, inner))
      .map((ln): OverlayItem => ({ spans: [{ text: ln, style: { fg: 'text' as const } }], selectable: false }));
    return { title: '详情（Enter/Esc 返回）', items, followSel: -1 };
  }

  /** Live / and @ completion driven by the editor content. */
  private updateLiveCompletion(): void {
    const txt = this.editor.text;
    if (this.overlay && this.overlay.kind !== 'completion') return;
    if (txt.startsWith('/') && !txt.includes('\n')) {
      const q = txt.slice(1);
      const entries: CompletionEntry[] = SLASH_COMMANDS.map((c) => ({
        label: `/${c.name}`,
        detail: c.detail,
        group: c.group,
        insert: c.name,
      }));
      const items = filterByQuery(entries, q, HistoryStore.score);
      this.overlay = { kind: 'completion', source: '/', items, sel: 0 };
      return;
    }
    if (txt.startsWith('@') && !txt.includes('\n')) {
      const q = txt.slice(1);
      const items = filterByQuery(this.atItems, q, HistoryStore.score).map((a) => ({
        label: a.label,
        detail: a.detail,
        group: '环境',
        insert: a.insert,
        ref: a.ref,
      }));
      this.overlay = { kind: 'completion', source: '@', items, sel: 0 };
      return;
    }
    if (this.overlay?.kind === 'completion') this.closeOverlay();
  }

  private acceptCompletion(): void {
    if (this.overlay?.kind !== 'completion') return;
    const { source, items, sel } = this.overlay;
    const item = items[sel];
    this.closeOverlay();
    if (!item) return;
    this.editor.setText(`${source}${item.insert} `);
    // Commands that take no arguments run straight away (claude-code menu
    // semantics); commands WITH a usage hint stay in the editor for the arg.
    if (source === '/') {
      const cmd = SLASH_COMMANDS.find((c) => c.name === item.insert);
      if (cmd && !cmd.usage) {
        void this.submit();
        return;
      }
    }
    this.renderChrome();
  }

  // -------------------------------------------------------------------------
  // Boundary modal (design §6.6 — 越界 ask 通道)
  // -------------------------------------------------------------------------

  private openBoundaryModal(signal: { kind: ModalState['kind']; objects: string[]; askId?: string }): void {
    const askId = signal.askId;
    this.overlay = {
      kind: 'modal',
      state: {
        active: true,
        kind: signal.kind,
        objects: signal.objects,
        askId,
        resolve: (approve) => {
          if (askId) {
            void this.client.postJson('/chat/boundary/respond', { askId, approve }).catch(() => {});
          }
          this.pushBlock({
            kind: 'divider',
            label: `越界${approve ? '已批准' : '已拒绝'}:${signal.objects[0] ?? modalTitle(signal.kind)}`,
            tone: 'info',
          });
        },
      },
    };
  }

  private closeBoundaryModal(askId: string, expired: boolean): void {
    if (this.overlay?.kind !== 'modal') return;
    if (this.overlay.state.askId !== askId) return;
    this.overlay = null;
    if (expired) {
      this.pushBlock({ kind: 'divider', label: '越界询问已超时(按拒绝处理)', tone: 'info' });
    }
  }

  // -------------------------------------------------------------------------
  // Submit / stop / slash
  // -------------------------------------------------------------------------

  private async submit(): Promise<void> {
    const text = this.editor.text;
    if (!text.trim()) return;
    this.closeOverlay();
    // L10(1.2.8):多行文本即使以 / 开头也按消息发送,不当命令解析
    // (与 updateLiveCompletion 的 `!txt.includes('\n')` 口径一致)。
    if (text.startsWith('/') && !text.includes('\n')) {
      const [verb, ...rest] = text.slice(1).split(/\s+/);
      this.editor.setText('');
      await this.runSlash(verb, rest.join(' '));
      this.renderChrome();
      return;
    }
    this.history.append(text, this.env.name ?? 'agent');
    this.editor.setHistory(this.history.recentTexts());
    this.editor.setText('');
    const res = await this.client
      .postJson<{ success?: boolean; error?: string; steering?: boolean }>('/chat/send', {
        text,
        refs: this.collectRefs(text),
      })
      .catch((err): { success?: boolean; error?: string; steering?: boolean } => ({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    if (res.success === false) {
      this.pushBlock({ kind: 'error', text: res.error ?? '发送失败' });
    }
    // L1(1.2.8):steering 提示行以 SSE chat:steering-added 为准(broadcast 发所有
    // 连接含发送者,reducer 已插)——本地再插一行就是双提示,不再本地插。
    this.renderChrome();
  }

  private collectRefs(text: string): RefAttachment[] | undefined {
    const out: RefAttachment[] = [];
    for (const m of text.matchAll(/@([^\s]+)/g)) {
      const tok = m[1];
      const envHit = this.atItems.find((a) => a.insert === tok);
      if (envHit?.ref) out.push(envHit.ref);
      else out.push({ type: 'file', path: tok });
    }
    return out.length ? out : undefined;
  }

  /**
   * slash handler 的上下文(1.1.10 B):每次分发现取一份——env/state 会被
   * gate 选定、/reset、fork 重赋值,getter 保证 handler 拿到的是活的。
   */
  private slashContext(): SlashContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- getter 闭包需要词法捕获；alias 是该模式的最简形态
    const app = this;
    return {
      client: this.client,
      workspace: this.workspace,
      get env() {
        return app.env;
      },
      get state() {
        return app.state;
      },
      pushBlock: (input) => this.pushBlock(input),
      startHiddenLine: (prompt) => this.startHiddenLine(prompt),
      repaintAll: () => this.repaintAll(),
      renderChrome: () => this.renderChrome(),
    };
  }

  private async runSlash(verb: string, arg: string): Promise<void> {
    const ctx = this.slashContext();
    switch (verb) {
      case 'snapshot':
        await runSnapshot(ctx, arg);
        break;
      case 'rollback':
        await runRollback(ctx, arg);
        break;
      case 'extract':
        await runExtract(ctx, arg);
        break;
      case 'export':
        await runExport(ctx, arg);
        break;
      case 'rewind':
        this.openRewind('rewind');
        break;
      case 'fork':
        this.openRewind('fork');
        break;
      case 'queue':
        await this.openQueue();
        break;
      case 'tasks':
        this.openTasks();
        break;
      case 'reset': {
        await this.client.postJson('/chat/reset', {}).catch(() => {});
        this.state = freshState();
        this.showWelcome = true;
        this.repaintAll();
        break;
      }
      case 'model':
        await runModel(ctx, arg);
        break;
      case 'mcp':
        await runMcp(ctx, arg);
        break;
      case 'help':
        this.openHelp();
        break;
      default:
        this.pushBlock({ kind: 'error', text: `未知命令: /${verb}（/help 查看命令）` });
        break;
    }
    this.renderChrome();
  }

  private async stop(): Promise<void> {
    // Optimistic interrupt divider (server confirms via chat:message-stopped).
    this.state.pendingDividerId = this.pushBlock({
      kind: 'divider',
      label: interruptLabel(),
      tone: 'interrupt',
    });
    this.writer.flush();
    const res = await this.client
      .postJson<{ success?: boolean; alreadyStopped?: boolean }>('/chat/stop', {})
      .catch(() => null);
    // L2(1.2.8):服务端空闲(acted=false → alreadyStopped,不再广播
    // chat:message-stopped)时乐观分隔条永远等不到确认——主动撤下。
    if (res?.alreadyStopped && this.state.pendingDividerId) {
      const id = this.state.pendingDividerId;
      this.state.pendingDividerId = null;
      const idx = this.state.blocks.findIndex((b) => b.id === id);
      if (idx >= 0) this.state.blocks.splice(idx, 1);
      this.repaintAll();
      this.renderChrome();
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private pushBlock(input: PushBlockInput): string {
    const seq = ++this.state.seq;
    const id = `${input.kind}-${seq}-${Date.now()}`;
    const block: Block = { ...input, id, seq };
    this.state.blocks.push(block);
    this.repaintAll();
    return id;
  }

  private appendRaw(lines: import('./row-buffer').Span[][]): void {
    for (const ln of lines) this.writer.append(ln);
  }

  private renderBlockSpans(blk: Block, width: number): import('./row-buffer').Span[] {
    let lines: import('./row-buffer').Span[][] = [];
    const first = this.state.blocks[0]?.id === blk.id && !this.showWelcome;
    switch (blk.kind) {
      case 'user':
        lines = renderUser(blk, first);
        break;
      case 'assistant':
        lines = renderAssistant(blk, blk.id === this.state.streamingId, first);
        break;
      case 'thinking': {
        const t = blk as import('./types').ThinkingBlock;
        const label = t.streaming ? '⏵ thought…' : `⏵ thought · ${typeof t.seconds === 'number' ? `${t.seconds}s` : '完成'}`;
        lines = [[{ text: label, style: { fg: 'faint' } }]];
        break;
      }
      case 'tool': {
        const drawer = this.overlay?.kind === 'drawer' && this.overlay.blockId === blk.id;
        if (drawer) lines = renderToolExpanded(blk, width, (this.overlay as Extract<Overlay, { kind: 'drawer' }>).offset).lines;
        else lines = renderToolFolded(blk, width);
        break;
      }
      case 'divider':
        lines = renderDivider(blk, width);
        break;
      case 'error':
        lines = renderError(blk, width);
        break;
      case 'background':
        lines = renderBackground(blk);
        break;
    }
    return flattenLines(lines);
  }

  private repaintBlocks(patch: ReduceResult): void {
    const width = this.writer.layout().cols;
    for (const blk of this.state.blocks) {
      if (patch.touched.includes(blk.id) || patch.appended.some((a) => a.id === blk.id)) {
        const spans = this.renderBlockSpans(blk, width);
        if (!this.writer.updateRow(blk.id, spans)) this.writer.append(spans, { id: blk.id });
      }
    }
    if (!this.scrollActive) this.writer.scrollToTail();
  }

  private repaintAll(): void {
    this.writer.clear();
    const width = this.writer.layout().cols;
    for (const blk of this.state.blocks) {
      this.writer.append(this.renderBlockSpans(blk, width), { id: blk.id });
    }
    if (this.showWelcome) {
      // 欢迎卡挂在会话流**末尾**——此前挂在开头,冷历史一回放就被顶出
      // 视口(用户实测「欢迎卡好像没有」)。有历史时折叠为一行「已恢复」,
      // 空会话才放全卡。
      if (this.state.blocks.length === 0) {
        this.appendRaw(renderWelcome(this.env.name, this.env.kind, this.state.status.model));
      } else {
        this.appendRaw(renderResumeHint(this.env.name, this.env.kind, this.state.status.model, width));
      }
    }
    if (!this.scrollActive) this.writer.scrollToTail();
  }

  /** 状态栏 compose 单一来源(H2):renderChrome 与 spinner 回调共用,入参不再抄两遍。 */
  private composeStatusBarLine(): import('./row-buffer').Span[] {
    return composeStatusBar(
      {
        phase: this.state.status.phase,
        elapsedMs: this.turnStartedAt ? Date.now() - this.turnStartedAt : undefined,
        queueDepth: this.state.queue.length,
        contextPct: this.state.status.contextPct ?? 0,
        model: this.state.status.model,
        envName: this.mode === 'chat' ? this.env.name : undefined,
        envKind: this.mode === 'chat' ? this.env.kind : undefined,
        backgroundSeg: this.state.status.backgroundSeg,
        hint: this.currentHint(),
        reconnecting: this.reconnecting,
      },
      this.writer.layout().cols,
      this.spinnerFrame,
    );
  }

  /** Repaint the pinned chrome: status bar + (overlay panel) + input box. */
  private renderChrome(): void {
    const l = this.writer.layout();
    const cols = l.cols;

    // 1. status bar
    this.writer.setStatus([this.composeStatusBarLine()]);

    // 2. input region: (overlay panel) + input box / modal box
    if (this.overlay?.kind === 'modal') {
      const m = this.overlay.state;
      const rows = composeModalBox({ title: modalTitle(m.kind), objects: m.objects }, cols);
      this.writer.setChrome({ inputHeight: rows.length });
      this.writer.setInput(rows, 0, 0);
      return;
    }

    const snap = this.editor.snapshot();
    const box = composeInputBox({
      lead: this.promptLead(),
      cols,
      lines: snap.lines,
      cursorLine: snap.cursorRow,
      cursorCol: snap.cursorCol,
      maxContentRows: INPUT_MAX_CONTENT,
    });

    let panelRows: import('./row-buffer').Span[][] = [];
    const ov = this.overlay;
    if (ov && ov.kind !== 'drawer') {
      panelRows = this.renderOverlayPanel(ov, cols);
    }
    const rows = [...panelRows, ...box.rows];
    const cursorRow = panelRows.length + box.cursorRow;
    this.writer.setChrome({ inputHeight: rows.length });
    this.writer.setInput(rows, cursorRow, box.cursorCol);
  }

  private renderOverlayPanel(ov: Exclude<Overlay, { kind: 'modal' | 'drawer' }>, cols: number): import('./row-buffer').Span[][] {
    let title = '';
    let items: OverlayItem[] = [];
    let flatSel = 0;
    switch (ov.kind) {
      case 'completion': {
        title = ov.source === '/' ? '命令' : '引用';
        let idx = 0;
        let lastGroup = '';
        for (const it of ov.items) {
          if (it.group !== lastGroup) {
            items.push(overlayHeader(it.group));
            lastGroup = it.group;
          }
          if (idx === ov.sel) flatSel = items.length;
          items.push(overlayRow(it.label, it.detail, idx === ov.sel, cols));
          idx++;
        }
        if (ov.items.length === 0) items = [{ spans: [{ text: '无匹配', style: { fg: 'faint' } }], selectable: false }];
        break;
      }
      case 'help':
        // 1.3.5:键位帮助表随 Ctrl+L 移除,/help 改为列斜杠命令(命令列表即帮助)。
        title = '帮助';
        items = SLASH_COMMANDS.map((c, i) => overlayRow(`/${c.name}`, c.detail, i === ov.sel, cols));
        flatSel = ov.sel;
        break;
      case 'history':
        title = `历史搜索 ${ov.query ? `· ${ov.query}` : ''}`;
        items = ov.results.length
          ? ov.results.slice(0, 50).map((t, i) => overlayRow(t.replace(/\n/g, ' '), '', i === ov.sel, cols))
          : [{ spans: [{ text: '无匹配历史', style: { fg: 'faint' } }], selectable: false }];
        flatSel = ov.sel;
        break;
      case 'rewind':
        title = ov.action === 'fork'
          ? '从这条消息分叉出新线程（原线程不动）'
          : '回退到…（选定后该消息及之后移除，可改完重发）';
        items = ov.candidates.map((c, i) => overlayRow(c.label, '', i === ov.sel, cols));
        flatSel = ov.sel;
        break;
      case 'queue':
        title = '排队消息（x 取消）';
        items = ov.items.map((q, i) => overlayRow(q.preview, q.kindLabel, i === ov.sel, cols));
        flatSel = ov.sel;
        break;
      case 'tasks': {
        const rows = this.collectTaskRows();
        if (rows.length === 0) {
          title = '子任务与后台进程';
          items = [{ spans: [{ text: '暂无子任务或后台进程', style: { fg: 'faint' } }], selectable: false }];
          break;
        }
        // 事件会增删行(bg-finished 移除进程):渲染时夹紧选中,详情目标消失则退回列表。
        ov.sel = Math.max(0, Math.min(ov.sel, rows.length - 1));
        if (ov.detail) {
          // A′(1.1.10):有 loopSessionId 且已拉到 → transcript 条目流(offset
          // 经 followSel 驱动 composeOverlay 的滚动窗口);否则读取中/summary。
          const view = this.taskDetailItems(ov, cols);
          title = view.title;
          items = view.items;
          flatSel = view.followSel;
        } else {
          title = '子任务与后台进程（Enter 详情）';
          items = rows.map((r, i) => overlayRow(r.label, '', i === ov.sel, cols));
          flatSel = ov.sel;
        }
        break;
      }
    }
    return composeOverlay(title, items, flatSel, cols, PANEL_MAX_ROWS);
  }

  private promptLead(): import('./row-buffer').Span[] {
    // 隐藏输入(/model set-key):提示语进输入框前导,内容永不渲染。
    if (this.hiddenLine) {
      return [{ text: `${this.hiddenLine.prompt} `, style: { fg: 'cyan', bold: true } }];
    }
    // 手动接入表单的逐步标签(home/user/keyPath)。
    if (this.manualForm) {
      const labels = ['主机', '用户', '密钥路径'];
      return [{ text: `${labels[this.manualForm.step]} `, style: { fg: 'cyan', bold: true } }];
    }
    const anchor = this.env.name ? `${this.env.name}${this.env.kind ? `@${this.env.kind}` : ''}` : 'agent';
    return [{ text: `${anchor} ❯ `, style: { fg: 'cyan', bold: true } }];
  }

  private currentHint(): string {
    if (this.hiddenLine) return 'API key 隐藏输入 · Enter 确认 · Esc 取消';
    if (this.manualForm) {
      const labels = ['接入主机地址(IP/域名)', 'SSH 用户(缺省 researcher)', '私钥路径(缺省 ~/.ssh/id_ed25519)'];
      return `${labels[this.manualForm.step]} · Enter 下一步 · Esc 返回`;
    }
    if (this.mode === 'gate') return this.gateBusy ? '请稍候…' : '↑↓ 选择 · Enter 确认 · Esc 退出';
    const ov = this.overlay;
    if (ov) {
      switch (ov.kind) {
        case 'modal':
          return 'y 批准 · n 拒绝';
        case 'drawer':
          // U5(1.1.10):有多张工具卡时补 ←/→ 切换提示。
          return this.recentToolBlockIds().length > 1
            ? '↑↓ 滚动 · ←→ 切换工具卡 · Esc 收起'
            : '↑↓ 滚动 · Esc 收起';
        case 'queue':
          return 'x 取消 · Esc 关闭';
        case 'tasks':
          return ov.detail ? '↑↓ 滚动 · Enter/Esc 返回' : '↑↓ 选择 · Enter 详情 · Esc 关闭';
        case 'history':
          return '输入筛选 · Enter 采用 · Esc 关闭';
        default:
          return '↑↓ 选择 · Tab 补全 · Esc 关闭';
      }
    }
    if (this.scrollActive) return 'Esc 回底';
    if (this.state.status.phase === 'running') return 'Esc 中断 · 输入即纠偏';
    // 1.3.5:/quit 已移除——退出走 Ctrl+C(空输入空闲)或正门 Esc。
    return 'Ctrl+C 退出 · / 命令 · @ 引用';
  }

  // -------------------------------------------------------------------------
  // Spinner (status bar only — 单 spinner 律)
  // -------------------------------------------------------------------------

  private startSpinner(): void {
    this.spinnerTimer = setInterval(() => {
      if (!this.running) return;
      const active =
        this.state.status.phase === 'running' || this.gateBusy || this.reconnecting;
      if (!active) return;
      this.spinnerFrame++;
      this.writer.setStatus([this.composeStatusBarLine()]);
    }, 100);
  }
}

// ---------------------------------------------------------------------------

function flattenLines(lines: import('./row-buffer').Span[][]): import('./row-buffer').Span[] {
  const out: import('./row-buffer').Span[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) out.push({ text: '\n' });
    out.push(...lines[i]);
  }
  return out;
}

function freshState(): SessionState {
  return {
    blocks: [],
    streamingId: null,
    queue: [],
    tasks: new Map(),
    bgProcs: new Map(),
    status: { phase: 'idle', queueDepth: 0, contextPct: 0 },
    currentTurnId: null,
    pendingDividerId: null,
    seenSrvIds: new Set(),
    seq: 0,
  };
}

function modalTitle(kind: ModalState['kind']): string {
  const labels: Record<ModalState['kind'], string> = {
    'host-write': '写宿主',
    'local-cred': '用本机凭据',
    'net-policy': '改网络策略',
    'destroy-env': '销毁有成果环境',
  };
  return labels[kind];
}
