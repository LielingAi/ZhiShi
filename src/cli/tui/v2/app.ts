/**
 * app (plan §2.1, design §3/§5). The orchestration layer — owns the mode FSM,
 * the SSE pump, the key router, and every overlay. Rendering is delegated:
 * scrollback rows come from blocks/*, pinned chrome from chrome.ts; the
 * TerminalWriter diffs them onto the screen.
 *
 * Modes:    gate (正门选环境) → chat (会话)
 * Overlays: completion / help / history-search / rewind / queue / drawer /
 *           modal — additive panels above the input box, one at a time.
 *
 * Invariants:
 *   - The input box is NEVER replaced by a panel (panels render above it).
 *   - Esc walks one chain only: overlay > scrollback > clear input > interrupt.
 *   - While modal is active every other key is swallowed.
 *   - The spinner timer repaints ONLY the status bar.
 */

import { TerminalWriter } from './terminal-writer';
import type { SidecarClient } from '../client';
import type { SSEEvent } from '../../../server/utils/sse-parser';
import { parseKeys, keyToEdit, hasMod, type Key } from './keymap';
import { LineEditor } from './editor';
import { HistoryStore } from './history';
import { reduceSseEvent, type ReduceResult } from './event-reducer';
import {
  composeStatusBar,
  composeInputBox,
  composeOverlay,
  composeModalBox,
  composeMenuRow,
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
  HELP_ENTRIES,
  filterByQuery,
  type AtItem,
} from './commands';
import {
  gatherGateData,
  buildGateOptions,
  moveGateCursor,
  firstEnabledIndex,
  commitGate,
  type GateOption,
  type GateResult,
} from './gate';
import { targetForEnv, spawnAttach, type AttachTarget } from './attach';
import { composeBackgroundSeg } from './bg-tasks';
import {
  parseModelArgs,
  parseMcpArgs,
  reduceHiddenLine,
  composeModelCardRows,
  composeMcpCardRows,
  type ModelProviderInfo,
  type McpBridgeRow,
  type McpServerRow,
  type HiddenLineOutcome,
} from './model';
import type { Block, SessionState, ModalState, RefAttachment } from './types';

// ---------------------------------------------------------------------------

export interface AppDeps {
  client: SidecarClient;
  writer: TerminalWriter;
  input: NodeJS.ReadStream;
  /** Workspace (= agentDir) — environment/select persistence target. */
  workspace: string;
  /** Pre-resolved env (--env/--new-env) — skips the gate. */
  presetEnv?: GateResult | null;
  history?: HistoryStore;
  /** /attach terminal hand-off (injected by the entry). */
  suspend?: () => void;
  resume?: () => void;
  /** 测试注入:替换真实 spawn(接管子进程)。生产缺省 attach.spawnAttach。 */
  spawnAttachImpl?: (target: AttachTarget) => Promise<number>;
}

type Overlay =
  | { kind: 'completion'; source: '/' | '@'; items: CompletionEntry[]; sel: number }
  | { kind: 'help'; sel: number }
  | { kind: 'history'; query: string; results: string[]; sel: number }
  | { kind: 'rewind'; action: 'rewind' | 'fork'; candidates: { srvId: string; label: string }[]; sel: number }
  | { kind: 'queue'; items: { id: string; preview: string; kindLabel: string }[]; sel: number }
  | { kind: 'drawer'; blockId: string; offset: number }
  | { kind: 'modal'; state: ModalState };

interface CompletionEntry {
  label: string;
  detail: string;
  group: string;
  insert: string;
  ref?: RefAttachment;
}

const PANEL_MAX_ROWS = 12;
const INPUT_MAX_CONTENT = 8;

export class App {
  private client: SidecarClient;
  private writer: TerminalWriter;
  private input: NodeJS.ReadStream;
  private workspace: string;
  private history: HistoryStore;
  private suspend?: () => void;
  private resume?: () => void;
  private spawnAttachImpl?: (target: AttachTarget) => Promise<number>;

  private mode: 'gate' | 'chat';
  private overlay: Overlay | null = null;
  private state: SessionState = freshState();
  private editor = new LineEditor();
  private env: { name?: string; kind?: string } = {};
  private atItems: AtItem[] = [];

  // gate
  private gateOptions: GateOption[] = [];
  private gateCursor = 0;
  private gateBusy = false;
  private manualForm: { step: 0 | 1 | 2; host: string; user: string; keyPath: string } | null = null;

  /** 隐藏输入接管(/model set-key):非 null 时按键只进缓冲,不进消息编辑器。 */
  private hiddenLine: { buffer: string; prompt: string; resolve: (v: string | null) => void } | null = null;

  private showWelcome = false;
  private reconnecting = false;
  private turnStartedAt = 0;
  private spinnerFrame = 0;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private escTimer: NodeJS.Timeout | null = null;
  private running = false;
  private abort = new AbortController();
  private readonly onData = (chunk: Buffer): void => this.onBytes(chunk);

  /** Set when the user requests exit; the entry polls this. */
  quitRequested = false;

  constructor(deps: AppDeps) {
    this.client = deps.client;
    this.writer = deps.writer;
    this.input = deps.input;
    this.workspace = deps.workspace;
    this.history = deps.history ?? new HistoryStore('agent');
    this.suspend = deps.suspend;
    this.resume = deps.resume;
    this.spawnAttachImpl = deps.spawnAttachImpl;
    this.editor.setHistory(this.history.recentTexts());
    this.mode = deps.presetEnv ? 'chat' : 'gate';
    if (deps.presetEnv) {
      this.env = { name: deps.presetEnv.id, kind: deps.presetEnv.envKind };
    }
  }

  async start(): Promise<void> {
    this.running = true;
    this.input.on('data', this.onData);
    this.startSpinner();
    if (this.mode === 'chat') {
      this.enterChat();
    } else {
      await this.enterGate();
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
  // Gate (正门)
  // -------------------------------------------------------------------------

  private async enterGate(): Promise<void> {
    this.mode = 'gate';
    this.overlay = null;
    this.writer.clear();
    this.appendRaw([[{ text: '  正在盘点本机环境…', style: { fg: 'faint' } }]]);
    this.renderChrome();
    const data = await gatherGateData(this.client);
    this.gateOptions = buildGateOptions(data);
    this.gateCursor = Math.max(0, firstEnabledIndex(this.gateOptions));
    this.renderGate();
  }

  private renderGate(): void {
    this.writer.clear();
    const cols = this.writer.layout().cols;
    const envCount = this.gateOptions.filter((o) => o.envId).length;
    const recipeCount = this.gateOptions.filter((o) => o.recipeId).length;
    const discoveredCount = this.gateOptions.filter((o) => o.discoveredKind).length;
    this.appendRaw([
      [],
      [{ text: '  选择本次会话的工作环境', style: { fg: 'cyan', bold: true } }],
      [{
        text: `  已登记 ${envCount} · 本机发现 ${discoveredCount} · 环境类型 ${recipeCount}`,
        style: { fg: 'faint' },
      }],
      [],
    ]);
    let lastGroup: GateOption['group'] | null = null;
    const groupLabel: Record<GateOption['group'], string> = {
      running: '运行中',
      stopped: '已停止',
      discovered: '本机已有（未注册 · 选中即登记）',
      recipe: '新建环境（选类型）',
      manual: '手动接入',
    };
    this.gateOptions.forEach((opt, i) => {
      if (opt.group !== lastGroup) {
        this.appendRaw([[{ text: `  ${groupLabel[opt.group]}`, style: { fg: 'faint' } }]]);
        lastGroup = opt.group;
      }
      const selected = i === this.gateCursor;
      const reason = opt.disabled && opt.disabledReason ? `（不可用：${opt.disabledReason}）` : '';
      const spans: import('./row-buffer').Span[] = [
        { text: selected ? '  ❯ ' : '    ', style: selected ? { fg: 'amber', bold: true } : { fg: 'faint' } },
        { text: opt.label, style: opt.disabled ? { fg: 'faint' } : selected ? { fg: 'text', bold: true } : { fg: 'text' } },
        { text: `  ${opt.detail}${reason}`, style: { fg: 'muted' } },
      ];
      this.appendRaw([composeMenuRow(spans, selected && !opt.disabled, cols)]);
    });
    if (this.gateOptions.length === 0) {
      this.appendRaw([[{ text: '  未发现任何环境或环境类型（sidecar 连接异常？）', style: { fg: 'red' } }]]);
    }
    this.appendRaw([[]]);
    this.renderChrome();
  }

  private async onGateKey(key: Key): Promise<void> {
    if (this.manualForm) {
      await this.onManualFormKey(key);
      return;
    }
    if (this.gateBusy) return;
    if (key.name === 'up') {
      this.gateCursor = moveGateCursor(this.gateOptions, this.gateCursor, -1);
      this.renderGate();
      return;
    }
    if (key.name === 'down') {
      this.gateCursor = moveGateCursor(this.gateOptions, this.gateCursor, 1);
      this.renderGate();
      return;
    }
    if (key.name === 'esc') {
      // D27: 无 host 选项——Esc 保守退出到 shell。
      this.quitRequested = true;
      return;
    }
    if (key.name !== 'enter') return;
    const opt = this.gateOptions[this.gateCursor];
    if (!opt || opt.disabled) return;
    // 手动接入:进三步表单(host → user → keyPath),不走 commitGate。
    if (opt.key === 'manual:ssh') {
      this.manualForm = { step: 0, host: '', user: '', keyPath: '' };
      this.editor.setText('');
      this.renderChrome();
      return;
    }
    this.gateBusy = true;
    this.renderChrome();
    try {
      const result = await commitGate(this.client, opt, this.workspace, (line) => {
        this.appendRaw([[{ text: `  ${line}`, style: { fg: 'muted' } }]]);
      });
      for (const w of result.warnings) {
        this.appendRaw([[{ text: `  ⚠ ${w}`, style: { fg: 'amber' } }]]);
      }
      this.env = { name: result.id, kind: result.envKind };
      this.enterChat();
    } catch (err) {
      this.appendRaw([
        [{ text: `  ✗ ${err instanceof Error ? err.message : String(err)}`, style: { fg: 'red' } }],
        [{ text: '  请重新选择（Esc 退出）', style: { fg: 'faint' } }],
      ]);
      this.gateBusy = false;
      this.renderChrome();
    }
  }

  // -------------------------------------------------------------------------
  // Chat mode entry
  // -------------------------------------------------------------------------

  /** 手动接入三步表单:① host ② user(缺省 researcher)③ keyPath(缺省
   *  ~/.ssh/id_ed25519)。Enter 逐步,Esc 退回列表,D-T4 不碰密码。 */
  private async onManualFormKey(key: Key): Promise<void> {
    const form = this.manualForm!;
    if (key.name === 'esc') {
      this.manualForm = null;
      this.renderGate();
      this.renderChrome();
      return;
    }
    if (key.name === 'enter') {
      const value = this.editor.text.trim();
      if (form.step === 0) {
        if (!value) return; // host 必填
        form.host = value;
        form.step = 1;
        this.editor.setText(form.user || 'researcher');
      } else if (form.step === 1) {
        form.user = value || 'researcher';
        form.step = 2;
        this.editor.setText(form.keyPath || `${this.homeDirSshKey()}`);
      } else {
        form.keyPath = value || this.homeDirSshKey();
        await this.submitManualForm(form);
        return;
      }
      this.renderChrome();
      return;
    }
    const edit = keyToEdit(key);
    if (edit) {
      this.editor.apply(edit);
      this.renderChrome();
    }
  }

  private homeDirSshKey(): string {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '~';
    return `${home}/.ssh/id_ed25519`;
  }

  private async submitManualForm(form: { host: string; user: string; keyPath: string }): Promise<void> {
    this.gateBusy = true;
    this.renderChrome();
    const id = `ssh-${form.host.replace(/[^A-Za-z0-9.-]/g, '-')}`;
    const addRes = await this.client
      .adminPost<{ success?: boolean; error?: string }>('environment/add', {
        id,
        kind: 'ssh',
        host: form.host,
        user: form.user,
        keyPath: form.keyPath,
      })
      .catch((err): { success?: boolean; error?: string } => ({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    if (addRes.success === false) {
      this.appendRaw([[{ text: `  ✗ 接入失败:${addRes.error}`, style: { fg: 'red' } }]]);
      this.gateBusy = false;
      this.manualForm = null;
      this.renderGate();
      this.renderChrome();
      return;
    }
    const selRes = await this.client
      .adminPost<{ success?: boolean; error?: string }>('environment/select', {
        workspace: this.workspace,
        selection: { kind: 'env', id },
      })
      .catch((err): { success?: boolean; error?: string } => ({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    if (selRes.success === false) {
      this.appendRaw([[{ text: `  ✗ 选定失败:${selRes.error}`, style: { fg: 'red' } }]]);
      this.gateBusy = false;
      this.manualForm = null;
      this.renderGate();
      this.renderChrome();
      return;
    }
    this.manualForm = null;
    this.env = { name: id, kind: 'ssh' };
    this.enterChat();
  }

  private enterChat(): void {
    this.mode = 'chat';
    this.overlay = null;
    this.state = freshState();
    this.showWelcome = true;
    this.writer.clear();
    this.repaintAll();
    this.renderChrome();
    void this.refreshAtItems();
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
    if (patch.appended.length || patch.touched.length) this.repaintBlocks(patch);
    this.renderChrome();
  }

  // -------------------------------------------------------------------------
  // Key routing
  // -------------------------------------------------------------------------

  private onBytes(chunk: Buffer): void {
    const raw = chunk.toString('utf8');
    // Bracketed paste → insert whole body, no per-key handling.
    if (raw.startsWith('\x1b[200~')) {
      const end = raw.indexOf('\x1b[201~');
      const body = end >= 0 ? raw.slice(6, end) : raw.slice(6);
      // 隐藏输入中粘贴:逐可打印字符进缓冲(换行剥离),不渲染不回显。
      if (this.hiddenLine) {
        this.appendHiddenPaste(body);
        return;
      }
      this.editor.apply({ type: 'paste', text: body });
      this.renderChrome();
      return;
    }
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
    if (this.mode === 'gate') {
      void this.onGateKey(key);
      return;
    }
    // Modal swallows everything but y/n (design §6.6 — 越界无惯性).
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
        this.editor.setText('');
      } else if (this.state.status.phase === 'running') {
        void this.stop();
      }
      this.renderChrome();
      return;
    }
    if (key.name === 'pgup' || key.name === 'pgdn') {
      this.writer.scrollBy(key.name === 'pgup' ? 10 : -10);
      this.renderChrome();
      return;
    }
    if (key.name === 'wheel-up' || key.name === 'wheel-down') {
      this.writer.scrollBy(key.name === 'wheel-up' ? 3 : -3);
      this.renderChrome();
      return;
    }
    if (hasMod(key, 'ctrl') && key.char === 'l') return this.toggleHelp();
    if (hasMod(key, 'ctrl') && key.char === 'o') return this.toggleDrawer();
    if (hasMod(key, 'ctrl') && key.char === 'z') return this.openRewind();
    if (hasMod(key, 'ctrl') && key.char === 'r') return this.openHistorySearch();
    if (key.name === 'tab') {
      if (this.overlay?.kind === 'completion') this.acceptCompletion();
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
    const ov = this.overlay!;
    if (key.name === 'esc') {
      this.closeOverlay();
      this.renderChrome();
      return;
    }
    switch (ov.kind) {
      case 'completion':
        if (key.name === 'up') ov.sel = Math.max(0, ov.sel - 1);
        else if (key.name === 'down') ov.sel = Math.min(ov.items.length - 1, ov.sel + 1);
        else if (key.name === 'tab') return this.acceptCompletion();
        else if (key.name === 'enter') {
          // Enter = accept the highlighted completion ONLY while the user is
          // still typing the bare command. Once args begin (a space follows
          // the verb) or nothing matches, Enter must SUBMIT the text — the
          // first cut swallowed '/snapshot tui-live' into the void here.
          const txt = this.editor.text;
          if (ov.items.length === 0 || /\s/.test(txt.slice(1))) {
            this.closeOverlay();
            void this.submit();
            return;
          }
          return this.acceptCompletion();
        } else {
          // typing continues into the editor, live-filtering the panel
          const edit = keyToEdit(key);
          if (edit) {
            this.editor.apply(edit);
            this.updateLiveCompletion();
          }
        }
        break;
      case 'help':
        if (key.name === 'up') ov.sel = Math.max(0, ov.sel - 1);
        else if (key.name === 'down') ov.sel = Math.min(HELP_ENTRIES.length - 1, ov.sel + 1);
        else if (hasMod(key, 'ctrl') && key.char === 'l') this.closeOverlay();
        break;
      case 'history':
        if (key.name === 'up') ov.sel = Math.max(0, ov.sel - 1);
        else if (key.name === 'down') ov.sel = Math.min(ov.results.length - 1, ov.sel + 1);
        else if (key.name === 'enter') {
          const pick = ov.results[ov.sel];
          this.closeOverlay();
          if (pick) this.editor.setText(pick);
        } else if (key.name === 'backspace') {
          ov.query = ov.query.slice(0, -1);
          this.refilterHistory(ov);
        } else if (key.char && !hasMod(key, 'ctrl')) {
          ov.query += key.char;
          this.refilterHistory(ov);
        }
        break;
      case 'rewind':
        if (key.name === 'up') ov.sel = Math.max(0, ov.sel - 1);
        else if (key.name === 'down') ov.sel = Math.min(ov.candidates.length - 1, ov.sel + 1);
        else if (key.name === 'enter' && ov.candidates[ov.sel]) {
          const sel = ov.candidates[ov.sel];
          const action = ov.action;
          this.closeOverlay();
          if (action === 'fork') void this.doFork(sel.srvId);
          else void this.doRewind(sel.srvId);
        }
        break;
      case 'queue':
        if (key.name === 'up') ov.sel = Math.max(0, ov.sel - 1);
        else if (key.name === 'down') ov.sel = Math.min(ov.items.length - 1, ov.sel + 1);
        else if ((key.char === 'x' || key.name === 'enter') && ov.items[ov.sel]) {
          const item = ov.items[ov.sel];
          void this.client.postJson('/chat/queue/cancel', { queueId: item.id }).catch(() => {});
          ov.items.splice(ov.sel, 1);
          ov.sel = Math.max(0, Math.min(ov.sel, ov.items.length - 1));
          if (ov.items.length === 0) this.closeOverlay();
        }
        break;
      case 'drawer': {
        const blk = this.state.blocks.find((b) => b.id === ov.blockId);
        if (!blk || blk.kind !== 'tool') {
          this.closeOverlay();
          break;
        }
        const total = (blk.output ?? '').split('\n').length;
        if (hasMod(key, 'ctrl') && key.char === 'o') this.closeOverlay();
        else if (key.name === 'up') ov.offset = Math.max(0, ov.offset - 1);
        else if (key.name === 'down') ov.offset = Math.min(total - 1, ov.offset + 1);
        else if (key.name === 'pgup') ov.offset = Math.max(0, ov.offset - 10);
        else if (key.name === 'pgdn') ov.offset = Math.min(total - 1, ov.offset + 10);
        this.repaintBlocks({ touched: [ov.blockId], appended: [] });
        break;
      }
    }
    this.renderChrome();
  }

  private closeOverlay(): void {
    this.overlay = null;
  }

  // --- overlay openers ---

  private toggleHelp(): void {
    if (this.overlay?.kind === 'help') {
      this.closeOverlay();
    } else {
      this.overlay = { kind: 'help', sel: 0 };
    }
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
      const removed = this.state.blocks.splice(idx);
      for (const b of removed) {
        if (b.kind === 'user' && b.srvId) this.state.seenSrvIds.delete(b.srvId);
      }
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

  private refilterHistory(ov: Extract<Overlay, { kind: 'history' }>): void {
    const texts = this.history.recentTexts().reverse();
    ov.results = ov.query
      ? texts.filter((t) => HistoryStore.score(ov.query, t) > 0)
      : texts;
    ov.sel = 0;
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
    if (text.startsWith('/')) {
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
    } else if (res.steering) {
      this.pushBlock({ kind: 'background', taskId: '', summary: `↳ 已插入纠偏：${text.slice(0, 120)}` });
    }
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

  private async runSlash(verb: string, arg: string): Promise<void> {
    switch (verb) {
      case 'attach':
        await this.runAttach();
        break;
      case 'snapshot':
        await this.runSnapshot(arg);
        break;
      case 'rollback':
        await this.runRollback(arg);
        break;
      case 'extract':
        await this.runExtract(arg);
        break;
      case 'env':
        await this.enterGate();
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
      case 'reset': {
        await this.client.postJson('/chat/reset', {}).catch(() => {});
        this.state = freshState();
        this.showWelcome = true;
        this.repaintAll();
        break;
      }
      case 'model':
        await this.runModel(arg);
        break;
      case 'mcp':
        await this.runMcp(arg);
        break;
      case 'help':
        this.toggleHelp();
        break;
      case 'quit':
      case 'exit':
        this.quitRequested = true;
        break;
      default:
        this.pushBlock({ kind: 'error', text: `未知命令: /${verb}（Ctrl+L 查看帮助）` });
        break;
    }
    this.renderChrome();
  }

  private async runSnapshot(name: string): Promise<void> {
    if (!this.env.name) {
      this.pushBlock({ kind: 'error', text: '未锚定环境' });
      return;
    }
    this.pushBlock({ kind: 'divider', label: `正在为 ${this.env.name} 打快照…`, tone: 'info' });
    const res = await this.client
      .adminPost<{ success?: boolean; error?: string; data?: { snapshot?: string } }>('environment/snapshot', {
        id: this.env.name,
        ...(name.trim() ? { name: name.trim() } : {}),
      })
      .catch((err): { success?: boolean; error?: string; data?: { snapshot?: string } } => ({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    if (res.success === false) this.pushBlock({ kind: 'error', text: `快照失败：${res.error}` });
    else this.pushBlock({ kind: 'divider', label: `快照已打：${res.data?.snapshot ?? name}`, tone: 'info' });
  }

  private async runRollback(name: string): Promise<void> {
    if (!this.env.name) {
      this.pushBlock({ kind: 'error', text: '未锚定环境' });
      return;
    }
    if (!name.trim()) {
      this.pushBlock({ kind: 'error', text: '用法：/rollback <快照名>' });
      return;
    }
    this.pushBlock({ kind: 'divider', label: `回滚 ${this.env.name} → ${name.trim()}…`, tone: 'info' });
    const res = await this.client
      .adminPost<{ success?: boolean; error?: string; data?: { restarted?: boolean } }>('environment/rollback', {
        id: this.env.name,
        snapshot: name.trim(),
      })
      .catch((err): { success?: boolean; error?: string; data?: { restarted?: boolean } } => ({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    if (res.success === false) this.pushBlock({ kind: 'error', text: `回滚失败：${res.error}` });
    else this.pushBlock({ kind: 'divider', label: `已回滚到 ${name.trim()}${res.data?.restarted ? '（环境已重启）' : ''}`, tone: 'info' });
  }

  /**
   * /extract <环境内路径> — 成果回收(design §6.4)。服务端走越界 ask 通道:
   * 这个 adminPost 会一直 pending 到人在红色模态里回答 y/n。
   */
  private async runExtract(arg: string): Promise<void> {
    if (!this.env.name) {
      this.pushBlock({ kind: 'error', text: '未锚定环境' });
      return;
    }
    if (!arg.trim()) {
      this.pushBlock({ kind: 'error', text: '用法：/extract <环境内绝对路径>' });
      return;
    }
    this.pushBlock({ kind: 'divider', label: `请求提取 ${this.env.name}:${arg.trim()}(需越界批准)…`, tone: 'info' });
    const res = await this.client
      .adminPost<{ success?: boolean; error?: string; data?: { savedTo?: string } }>('environment/extract', {
        id: this.env.name,
        guestPath: arg.trim(),
        workspace: this.workspace,
      })
      .catch((err): { success?: boolean; error?: string; data?: { savedTo?: string } } => ({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    if (res.success === false) this.pushBlock({ kind: 'error', text: `提取失败:${res.error}` });
    else this.pushBlock({ kind: 'divider', label: `已回收到宿主:${res.data?.savedTo ?? 'output/extracted/'}`, tone: 'info' });
  }

  /**
   * /model — 模型配置闭环:
   *   无参 → 状态卡(供应商/已配 key/默认模型/模型数 + 当前默认);
   *   set-key <供应商id> → 隐藏输入填 key → admin model/set-key(自动发现模型);
   *   use <供应商id> <模型名> → 带供应商语义切换(防重名);
   *   <模型名> → 旧语法直接切换(向后兼容)。
   */
  private async runModel(arg: string): Promise<void> {
    const args = parseModelArgs(arg);
    switch (args.kind) {
      case 'error':
        this.pushBlock({ kind: 'error', text: args.message });
        return;
      case 'status':
        await this.showModelStatus();
        return;
      case 'set-key':
        await this.runModelSetKey(args.providerId);
        return;
      case 'use':
        await this.runModelUse(args.providerId, args.model);
        return;
      case 'switch':
        await this.runModelSwitch(args.model);
        return;
    }
  }

  /** /model(无参)——供应商状态卡。数据来自 admin model/list(全量目录)。 */
  private async showModelStatus(): Promise<void> {
    const res = await this.client
      .adminPost<{ success?: boolean; error?: string; data?: ModelProviderInfo[] }>('model/list', {})
      .catch((): { success?: boolean; error?: string; data?: ModelProviderInfo[] } => ({
        success: false,
        error: '无法连接 sidecar',
      }));
    if (res.success === false) {
      this.pushBlock({ kind: 'error', text: res.error ?? '模型状态获取失败' });
      return;
    }
    const providers = res.data ?? [];
    for (const row of composeModelCardRows(providers, this.state.status.model)) {
      this.pushBlock({ kind: 'divider', label: row.label, follow: row.follow, tone: row.tone });
    }
  }

  /** /model set-key <供应商id> — 隐藏输入填 key → 保存 → 自动拉模型目录。 */
  private async runModelSetKey(providerId: string): Promise<void> {
    // 先在目录里确认供应商存在(含 kimi 内置合成条目),顺带拿显示名。
    const list = await this.client
      .adminPost<{ success?: boolean; data?: ModelProviderInfo[] }>('model/list', {})
      .catch((): { success?: boolean; data?: ModelProviderInfo[] } => ({ success: false }));
    const provider = (list.data ?? []).find((p) => p.id === providerId);
    if (!provider) {
      this.pushBlock({ kind: 'error', text: `未知供应商: ${providerId}（/model 查看可配供应商）` });
      return;
    }
    const apiKey = await this.startHiddenLine(
      `输入 ${provider.name} API key（隐藏输入，Enter 确认，Esc 取消）`,
    );
    if (apiKey === null) {
      this.pushBlock({ kind: 'divider', label: `已取消（未保存 ${providerId} key）`, tone: 'info' });
      return;
    }
    const res = await this.client
      .adminPost<{ success?: boolean; error?: string; data?: { modelsFetched?: number; modelsFetchError?: string } }>(
        'model/set-key',
        { id: providerId, apiKey },
      )
      .catch((): { success?: boolean; error?: string; data?: { modelsFetched?: number; modelsFetchError?: string } } => ({
        success: false,
        error: '无法连接 sidecar',
      }));
    if (res.success === false) {
      this.pushBlock({ kind: 'error', text: `保存失败：${res.error ?? '未知错误'}` });
      return;
    }
    const fetched = res.data?.modelsFetched;
    const fetchErr = res.data?.modelsFetchError;
    const follow = fetched !== undefined
      ? `自动发现 ${fetched} 个模型`
      : fetchErr
        ? `模型列表拉取失败（key 已保存）：${fetchErr}`
        : '已保存';
    this.pushBlock({ kind: 'divider', label: `✓ 已保存 ${providerId} API key`, follow, tone: 'ok' });
    await this.showModelStatus();
  }

  /** /model use <供应商id> <模型名> — 带供应商前缀的切换(撞名不误配)。 */
  private async runModelUse(providerId: string, model: string): Promise<void> {
    const res = await this.client
      .postJson<{ success?: boolean; error?: string; providerId?: string; model?: string }>('/chat/model', {
        model,
        providerId,
      })
      .catch((): { success?: boolean; error?: string; providerId?: string; model?: string } => ({
        success: false,
        error: '无法连接 sidecar',
      }));
    if (!res.success) {
      this.pushBlock({ kind: 'error', text: res.error ?? '切换模型失败' });
      return;
    }
    this.state.status.model = res.model ?? model;
    this.pushBlock({ kind: 'divider', label: `模型已切换：${providerId}/${res.model ?? model}`, tone: 'ok' });
  }

  /** /model <模型名>(向后兼容)——无供应商语义,由服务端反查归属。 */
  private async runModelSwitch(model: string): Promise<void> {
    const res = await this.client
      .postJson<{ success?: boolean; error?: string; providerId?: string; model?: string }>('/chat/model', { model })
      .catch((): { success?: boolean; error?: string; providerId?: string; model?: string } => ({
        success: false,
        error: '无法连接 sidecar',
      }));
    if (res.success) {
      this.state.status.model = res.model ?? model;
      this.pushBlock({ kind: 'divider', label: `模型已切换：${res.model ?? model}`, tone: 'ok' });
    } else {
      this.pushBlock({ kind: 'error', text: res.error ?? '切换模型失败' });
    }
  }

  /**
   * /mcp — MCP 桥状态展示(含启用标注)/ -r 热重载 / enable|disable <id>
   * 开关。开关走 admin mcp/enable|disable 写盘 → mcp/reload 桥重载,
   * 当前会话立即生效(磁盘为权威来源)。
   */
  private async runMcp(arg: string): Promise<void> {
    const args = parseMcpArgs(arg);
    switch (args.kind) {
      case 'error':
        this.pushBlock({ kind: 'error', text: args.message });
        return;
      case 'enable':
      case 'disable':
        await this.runMcpToggle(args.kind, args.id);
        return;
      case 'reload':
        await this.showMcpStatus(true);
        return;
      case 'status':
        await this.showMcpStatus(false);
        return;
    }
  }

  /** 展示 MCP 状态。reload=true 时先走 mcp/reload(热重载后拿新状态)。 */
  private async showMcpStatus(reload: boolean): Promise<void> {
    if (reload) this.pushBlock({ kind: 'divider', label: 'MCP 重连中…', tone: 'info' });
    const statusRes = await this.client
      .adminPost<{ success?: boolean; error?: string; data?: { servers?: McpBridgeRow[] } }>(
        reload ? 'mcp/reload' : 'mcp/list-status',
        {},
      )
      .catch((): { success?: boolean; error?: string; data?: { servers?: McpBridgeRow[] } } => ({
        success: false,
        error: '无法连接 sidecar',
      }));
    if (statusRes.success === false) {
      this.pushBlock({ kind: 'error', text: statusRes.error ?? 'MCP 状态获取失败' });
      return;
    }
    const statuses = statusRes.data?.servers ?? [];
    // 无参展示要标注启用状态:mcp/list 给全量(含 enabled 标记),桥状态只有
    // 已启用服务器的连接结果——两侧合并。清单拉取失败降级为只列桥状态。
    let servers: McpServerRow[] = [];
    if (!reload) {
      const listRes = await this.client
        .adminPost<{ success?: boolean; data?: McpServerRow[] }>('mcp/list', {})
        .catch((): { success?: boolean; data?: McpServerRow[] } => ({ success: false }));
      servers = listRes.data ?? [];
    }
    const summary = composeMcpCardRows(servers, statuses);
    if (summary.rows.length === 0) {
      this.pushBlock({ kind: 'divider', label: 'MCP 服务器状态', follow: '0 台(无已启用服务器)', tone: 'info' });
      return;
    }
    this.pushBlock({
      kind: 'divider',
      label: reload ? 'MCP 已重载' : 'MCP 服务器状态',
      follow: `${summary.total} 台 · 启用 ${summary.enabledCount}`,
      tone: 'info',
    });
    for (const row of summary.rows) {
      this.pushBlock({ kind: 'divider', label: row.label, follow: row.follow, tone: row.tone });
    }
  }

  /** /mcp enable|disable <id> — 写盘 → 桥热重载,显示结果与当前工具数。 */
  private async runMcpToggle(kind: 'enable' | 'disable', id: string): Promise<void> {
    const verb = kind === 'enable' ? '启用' : '停用';
    this.pushBlock({ kind: 'divider', label: `MCP ${verb} ${id}…`, tone: 'info' });
    const res = await this.client
      .adminPost<{ success?: boolean; error?: string }>(`mcp/${kind}`, { id })
      .catch((): { success?: boolean; error?: string } => ({ success: false, error: '无法连接 sidecar' }));
    if (res.success === false) {
      this.pushBlock({ kind: 'error', text: `${verb}失败：${res.error ?? '未知错误'}` });
      return;
    }
    // 配置已写盘;桥热重载让变更在当前会话立即生效。
    const reloadRes = await this.client
      .adminPost<{ success?: boolean; error?: string; data?: { servers?: McpBridgeRow[] } }>('mcp/reload', {})
      .catch((): { success?: boolean; error?: string; data?: { servers?: McpBridgeRow[] } } => ({
        success: false,
        error: '无法连接 sidecar',
      }));
    if (reloadRes.success === false) {
      this.pushBlock({ kind: 'error', text: `配置已写入但桥重载失败：${reloadRes.error ?? '未知错误'}` });
      return;
    }
    const target = (reloadRes.data?.servers ?? []).find((s) => s.id === id);
    if (kind === 'enable') {
      if (target?.status === 'connected') {
        this.pushBlock({
          kind: 'divider',
          label: `✓ 已启用 ${id}`,
          follow: `connected · ${target.toolCount ?? 0} 工具`,
          tone: 'ok',
        });
      } else {
        this.pushBlock({
          kind: 'divider',
          label: `✓ 已启用 ${id}（连接失败）`,
          follow: target?.error ?? '未连接',
          tone: 'fail',
        });
      }
    } else {
      this.pushBlock({ kind: 'divider', label: `✓ 已停用 ${id}`, follow: '已从当前会话移除', tone: 'ok' });
    }
  }

  private async stop(): Promise<void> {
    // Optimistic interrupt divider (server confirms via chat:message-stopped).
    this.state.pendingDividerId = this.pushBlock({
      kind: 'divider',
      label: interruptLabel(),
      tone: 'interrupt',
    });
    this.writer.flush();
    await this.client.postJson('/chat/stop', {}).catch(() => {});
  }

  private async runAttach(): Promise<void> {
    if (!this.suspend || !this.resume) return;
    // Resolve connection metadata fresh (the gate only carries id+kind).
    let target;
    try {
      const res = await this.client.adminPost<{ data?: { environments?: Record<string, unknown>[] } }>(
        'environment/list',
        {},
      );
      const entry = (res.data?.environments ?? []).find((e) => e.id === this.env.name) ?? {};
      target = targetForEnv({
        kind: (entry.kind as string) ?? this.env.kind,
        sshUser: (entry.user as string) ?? undefined,
        sshAddress: ((entry.host ?? entry.address) as string) ?? undefined,
        sshKeyPath: (entry.keyPath as string) ?? undefined,
        container: (entry.container as string) ?? undefined,
      });
    } catch {
      target = targetForEnv({ kind: this.env.kind });
    }
    if (target.kind === 'local') {
      this.pushBlock({ kind: 'error', text: '该环境不支持接管（缺少 ssh/docker 连接信息）' });
      return;
    }
    this.suspend();
    try {
      await (this.spawnAttachImpl ?? spawnAttach)(target);
    } finally {
      this.resume();
      this.repaintAll();
      this.renderChrome();
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private pushBlock(partial: { kind: Block['kind'] } & Record<string, unknown>): string {
    const id = `${partial.kind}-${++this.state.seq}-${Date.now()}`;
    this.state.blocks.push({ ...partial, id, seq: this.state.seq } as unknown as Block);
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

  /** Repaint the pinned chrome: status bar + (overlay panel) + input box. */
  private renderChrome(): void {
    const l = this.writer.layout();
    const cols = l.cols;

    // 1. status bar
    const bar = composeStatusBar(
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
      cols,
      this.spinnerFrame,
    );
    this.writer.setStatus([bar]);

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
        title = '帮助';
        items = HELP_ENTRIES.map((h, i) => overlayRow(h.keys, h.detail, i === ov.sel, cols));
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
          return '↑↓ 滚动 · Esc 收起';
        case 'queue':
          return 'x 取消 · Esc 关闭';
        case 'history':
          return '输入筛选 · Enter 采用 · Esc 关闭';
        default:
          return '↑↓ 选择 · Tab 补全 · Esc 关闭';
      }
    }
    if (this.scrollActive) return 'Esc 回底';
    if (this.state.status.phase === 'running') return 'Esc 中断 · 输入即纠偏';
    return 'Ctrl+L 帮助 · / 命令 · @ 引用';
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
      const l = this.writer.layout();
      const bar = composeStatusBar(
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
        l.cols,
        this.spinnerFrame,
      );
      this.writer.setStatus([bar]);
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
