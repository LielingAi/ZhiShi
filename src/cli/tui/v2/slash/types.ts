/**
 * slash 命令 handler 的上下文（1.1.10 B：app.ts 拆分）。
 *
 * handler 不持有 App——app 在分发时现取一份 SlashContext（client + 明确的
 * 能力回调：pushBlock 回显 / startHiddenLine 隐藏输入 / suspend·resume
 * 终端交接 / repaint），handler 只编排 admin/POST 调用与结果块回显。
 * env/state 用 getter 暴露：gate 选定、/reset 都会重赋值，现取不滞留。
 */

import type { SidecarClient } from '../../client';
import type { AttachTarget } from '../attach';
import type { DividerBlock, SessionState } from '../types';

/**
 * pushBlock 的按 kind 精确入参(H3):divider/error/background 各有明确字段,
 * 不再用 `as unknown as Block` 绕类型检查。
 */
export type PushBlockInput =
  | { kind: 'divider'; label: string; follow?: string; tone: DividerBlock['tone'] }
  | { kind: 'error'; text: string }
  | { kind: 'background'; taskId: string; summary: string; switchHook?: boolean };

export interface SlashContext {
  client: SidecarClient;
  /** Workspace (= agentDir) — /extract 的落盘目标。 */
  workspace: string;
  /** 当前锚定环境（gate 选定后才有 name/kind）。 */
  readonly env: { name?: string; kind?: string };
  /** 会话状态（/model use|switch 回写 status.model）。 */
  readonly state: SessionState;
  pushBlock(input: PushBlockInput): string;
  /** 隐藏输入接管(/model set-key):Enter 提交值,Esc / Ctrl+C 返回 null。 */
  startHiddenLine(prompt: string): Promise<string | null>;
  /** /attach 终端交接（entry 注入；缺省则 /attach 直接不可用）。 */
  suspend?: () => void;
  resume?: () => void;
  /** 测试注入:替换真实 spawn(接管子进程)。生产缺省 attach.spawnAttach。 */
  spawnAttachImpl?: (target: AttachTarget) => Promise<number>;
  repaintAll(): void;
  renderChrome(): void;
}
