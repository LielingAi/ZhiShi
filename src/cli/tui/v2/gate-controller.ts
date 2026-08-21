/**
 * gate-controller（1.1.10 B：app.ts 拆分）——正门（gate）选择 + 手动 SSH
 * 三步表单，整块从 app.ts 逐字搬移。
 *
 * controller 持有正门全部状态（选项/光标/busy/重进标记/手动表单），渲染
 * 与会话切换通过 GateHost 回调回到 app（清屏/appendRaw/renderChrome/
 * enterChat/quit）。纯逻辑（选项构造/光标移动/commitGate）仍在 gate.ts。
 */

import type { SidecarClient } from '../client';
import { keyToEdit, type Key } from './keymap';
import type { LineEditor } from './editor';
import { composeMenuRow } from './chrome';
import {
  gatherGateData,
  buildGateOptions,
  moveGateCursor,
  firstEnabledIndex,
  commitGate,
  type GateOption,
} from './gate';
import type { Span } from './row-buffer';

/** app 提供给正门 controller 的能力回调。 */
export interface GateHost {
  client: SidecarClient;
  /** Workspace (= agentDir) — environment/select persistence target. */
  workspace: string;
  /** 手动三步表单复用消息编辑器做行输入。 */
  editor: LineEditor;
  /** 重进判定：当前已在 chat → /env 重进（Esc 返回 chat 而非退出）。 */
  isChatMode(): boolean;
  /** 切到 gate 模式（mode='gate' + 关 overlay）。 */
  enterGateMode(): void;
  enterChat(): void;
  /** 启动首次选择按 Esc：退出到 shell。 */
  requestQuit(): void;
  /** commitGate / 手动接入成功后写回锚定环境。 */
  setEnv(env: { name?: string; kind?: string }): void;
  clearScrollback(): void;
  appendRaw(lines: Span[][]): void;
  renderChrome(): void;
  layoutCols(): number;
}

/** 手动接入表单状态（app 的 promptLead/currentHint 也读它）。 */
export interface ManualFormState {
  step: 0 | 1 | 2;
  host: string;
  user: string;
  keyPath: string;
}

export class GateController {
  private host: GateHost;
  private options: GateOption[] = [];
  private cursor = 0;
  private busy = false;
  /** 正门来源：false=启动首次选择（Esc 退出到 shell），true=/env 重进（Esc 返回 chat）。 */
  private reentry = false;
  private form: ManualFormState | null = null;

  constructor(host: GateHost) {
    this.host = host;
  }

  /** 只读视图：app 的状态栏/输入框前导与既有测试按名读取。 */
  get gateCursor(): number {
    return this.cursor;
  }
  get gateBusy(): boolean {
    return this.busy;
  }
  get manualForm(): ManualFormState | null {
    return this.form;
  }

  async enter(): Promise<void> {
    // 重进重置（1.1.6 #2）：gateBusy 成功路径不复位，/env 二次进门会吞掉所有键。
    this.reentry = this.host.isChatMode();
    this.busy = false;
    this.host.enterGateMode();
    this.host.clearScrollback();
    this.host.appendRaw([[{ text: '  正在盘点本机环境…', style: { fg: 'faint' } }]]);
    this.host.renderChrome();
    const data = await gatherGateData(this.host.client);
    this.options = buildGateOptions(data);
    this.cursor = Math.max(0, firstEnabledIndex(this.options));
    this.render();
  }

  private render(): void {
    this.host.clearScrollback();
    const cols = this.host.layoutCols();
    const envCount = this.options.filter((o) => o.envId).length;
    const recipeCount = this.options.filter((o) => o.recipeId).length;
    const discoveredCount = this.options.filter((o) => o.discoveredKind).length;
    this.host.appendRaw([
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
    this.options.forEach((opt, i) => {
      if (opt.group !== lastGroup) {
        this.host.appendRaw([[{ text: `  ${groupLabel[opt.group]}`, style: { fg: 'faint' } }]]);
        lastGroup = opt.group;
      }
      const selected = i === this.cursor;
      const reason = opt.disabled && opt.disabledReason ? `（不可用：${opt.disabledReason}）` : '';
      const spans: Span[] = [
        { text: selected ? '  ❯ ' : '    ', style: selected ? { fg: 'amber', bold: true } : { fg: 'faint' } },
        { text: opt.label, style: opt.disabled ? { fg: 'faint' } : selected ? { fg: 'text', bold: true } : { fg: 'text' } },
        { text: `  ${opt.detail}${reason}`, style: { fg: 'muted' } },
      ];
      this.host.appendRaw([composeMenuRow(spans, selected && !opt.disabled, cols)]);
    });
    if (this.options.length === 0) {
      this.host.appendRaw([[{ text: '  未发现任何环境或环境类型（sidecar 连接异常？）', style: { fg: 'red' } }]]);
    }
    this.host.appendRaw([[]]);
    this.host.renderChrome();
  }

  async onKey(key: Key): Promise<void> {
    if (this.form) {
      await this.onManualFormKey(key);
      return;
    }
    if (this.busy) return;
    if (key.name === 'up') {
      this.cursor = moveGateCursor(this.options, this.cursor, -1);
      this.render();
      return;
    }
    if (key.name === 'down') {
      this.cursor = moveGateCursor(this.options, this.cursor, 1);
      this.render();
      return;
    }
    if (key.name === 'esc') {
      // D27: 启动首次选择无 host 选项——Esc 保守退出到 shell；
      // /env 重进时 Esc 是取消，返回 chat（1.1.6 #2）。
      if (this.reentry) {
        this.host.enterChat();
      } else {
        this.host.requestQuit();
      }
      return;
    }
    if (key.name !== 'enter') return;
    const opt = this.options[this.cursor];
    if (!opt || opt.disabled) return;
    // 手动接入:进三步表单(host → user → keyPath),不走 commitGate。
    if (opt.key === 'manual:ssh') {
      this.form = { step: 0, host: '', user: '', keyPath: '' };
      this.host.editor.setText('');
      this.host.renderChrome();
      return;
    }
    this.busy = true;
    this.host.renderChrome();
    try {
      const result = await commitGate(this.host.client, opt, this.host.workspace, (line) => {
        this.host.appendRaw([[{ text: `  ${line}`, style: { fg: 'muted' } }]]);
      });
      for (const w of result.warnings) {
        this.host.appendRaw([[{ text: `  ⚠ ${w}`, style: { fg: 'amber' } }]]);
      }
      this.host.setEnv({ name: result.id, kind: result.envKind });
      this.host.enterChat();
    } catch (err) {
      this.host.appendRaw([
        [{ text: `  ✗ ${err instanceof Error ? err.message : String(err)}`, style: { fg: 'red' } }],
        [{ text: this.reentry ? '  请重新选择（Esc 返回）' : '  请重新选择（Esc 退出）', style: { fg: 'faint' } }],
      ]);
      this.busy = false;
      this.host.renderChrome();
    }
  }

  // -------------------------------------------------------------------------
  // 手动接入三步表单
  // -------------------------------------------------------------------------

  /** 手动接入三步表单:① host ② user(缺省 researcher)③ keyPath(缺省
   *  ~/.ssh/id_ed25519)。Enter 逐步,Esc 退回列表,D-T4 不碰密码。 */
  private async onManualFormKey(key: Key): Promise<void> {
    const form = this.form!;
    if (key.name === 'esc') {
      this.form = null;
      this.render();
      this.host.renderChrome();
      return;
    }
    if (key.name === 'enter') {
      const value = this.host.editor.text.trim();
      if (form.step === 0) {
        if (!value) return; // host 必填
        form.host = value;
        form.step = 1;
        this.host.editor.setText(form.user || 'researcher');
      } else if (form.step === 1) {
        form.user = value || 'researcher';
        form.step = 2;
        this.host.editor.setText(form.keyPath || `${this.homeDirSshKey()}`);
      } else {
        form.keyPath = value || this.homeDirSshKey();
        await this.submitManualForm(form);
        return;
      }
      this.host.renderChrome();
      return;
    }
    const edit = keyToEdit(key);
    if (edit) {
      this.host.editor.apply(edit);
      this.host.renderChrome();
    }
  }

  private homeDirSshKey(): string {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '~';
    return `${home}/.ssh/id_ed25519`;
  }

  private async submitManualForm(form: { host: string; user: string; keyPath: string }): Promise<void> {
    this.busy = true;
    this.host.renderChrome();
    const id = `ssh-${form.host.replace(/[^A-Za-z0-9.-]/g, '-')}`;
    const addRes = await this.host.client
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
      this.host.appendRaw([[{ text: `  ✗ 接入失败:${addRes.error}`, style: { fg: 'red' } }]]);
      this.busy = false;
      this.form = null;
      this.render();
      this.host.renderChrome();
      return;
    }
    const selRes = await this.host.client
      .adminPost<{ success?: boolean; error?: string }>('environment/select', {
        workspace: this.host.workspace,
        selection: { kind: 'env', id },
      })
      .catch((err): { success?: boolean; error?: string } => ({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    if (selRes.success === false) {
      this.host.appendRaw([[{ text: `  ✗ 选定失败:${selRes.error}`, style: { fg: 'red' } }]]);
      this.busy = false;
      this.form = null;
      this.render();
      this.host.renderChrome();
      return;
    }
    this.form = null;
    this.host.setEnv({ name: id, kind: 'ssh' });
    this.host.enterChat();
  }
}
