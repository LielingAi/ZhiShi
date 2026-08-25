/**
 * 块数据模型（1.3.0 GUI MVP）。
 *
 * 「块」（TurnBlock）= 一条用户输入 → 该轮全部产出的容器：
 *
 *   块首   userText（v19 的 user 气泡样式，右对齐琥珀色）
 *   亮顶   conclusion（assistant 全部文本聚合，块内最显眼的位置）
 *   徽标行 ⎿ ⚙ 2 · ⏵ 4s · ⛁ fuzz×3（由 buildBadgeSummary 从 details 算出）
 *   细节区 details：thinking 行 + 工具卡行（按事件到达顺序混合）
 *
 * 流式期间 conclusion 打字机式增长、details 实时出现；turn 结束
 * （chat:message-complete）后块定格为「结论亮顶 + 徽标行」。
 *
 * 本文件只放类型与纯函数——不 import store / React / client，归约逻辑见
 * reducer.ts，两者都必须是可单测的纯逻辑（红线：把决策逻辑抽成纯函数）。
 */

// ---------------------------------------------------------------------------
// 基本状态
// ---------------------------------------------------------------------------

/** 会话流级相位（状态栏 + spinner 驱动）。 */
export type Phase = 'idle' | 'running' | 'interrupted' | 'error';

export type ToolState = 'running' | 'done' | 'fail';

export type TurnStatus = 'running' | 'complete' | 'stopped';

/** thinking 细节行（细节区的一员）。不在 wire 里，重连 replay 不重建。 */
export interface ThinkingDetail {
  kind: 'thinking';
  id: string;
  text: string;
  streaming: boolean;
  /** thinking-complete 携带的秒数（可选）。 */
  seconds?: number;
  startedAt: number;
}

/** 工具卡细节行（细节区的一员）。id = 服务端 toolUseId（与 wire 消息 id 同源）。 */
export interface ToolDetail {
  kind: 'tool';
  id: string;
  name: string;
  argsSummary: string;
  state: ToolState;
  output: string;
  startedAt: number;
  elapsedMs?: number;
  exitCode?: number;
  /** 从工具名+输出提取的关键信号（如 "flag 已读取" / "SIGSEGV at 0x…"）。 */
  signal?: string;
  /** turn 内工具序号（① ② ③ …）。 */
  step: number;
}

export type DetailItem = ThinkingDetail | ToolDetail;

/** message-complete 的 usage 聚合（状态栏累计用）。 */
export interface TurnMeta {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  toolCount: number;
  durationMs: number;
}

export interface TurnBlock {
  kind: 'turn';
  id: string;
  seq: number;
  /** 块首：你的输入。 */
  userText: string;
  /** 纠偏标记：busy 时发送、进了服务端 steering 队列的消息。 */
  steering: boolean;
  /** 结论聚合：assistant 全部文本。 */
  conclusion: string;
  conclusionStreaming: boolean;
  details: DetailItem[];
  status: TurnStatus;
  meta?: TurnMeta;
  /**
   * 本块消费过的 replay 消息 id（user/assistant/tool wire id）。
   * 重连 resync（chat:init）时非流式块整体丢弃并把这些 id 从 seenSrvIds
   * 摘除，让服务端 replay 全量重建——与 TUI 1.2.8(H3) 同语义。
   */
  srvIds: string[];
  createdAt: number;
}

// ---------------------------------------------------------------------------
// 流级条目（非块）
// ---------------------------------------------------------------------------

/** 中断分隔行（chat:message-stopped 落流级）。 */
export interface DividerItem {
  kind: 'divider';
  id: string;
  seq: number;
  text: string;
}

/** 错误行（chat:message-error 落流级）。 */
export interface ErrorItem {
  kind: 'error';
  id: string;
  seq: number;
  text: string;
}

/** 系统提示行（就绪行 / 切环境提示，本地产生）。 */
export interface SysItem {
  kind: 'sys';
  id: string;
  seq: number;
  text: string;
}

export type StreamItem = TurnBlock | DividerItem | ErrorItem | SysItem;

/** 引擎队列条目（statusbar 队列计数）。 */
export interface QueueItem {
  id: string;
  text: string;
  kind: 'steering' | 'fifo';
  addedAt: number;
}

// ---------------------------------------------------------------------------
// 会话状态（每个环境一条会话线 → 一份 SessionState）
// ---------------------------------------------------------------------------

export interface SessionState {
  items: StreamItem[];
  seq: number;
  /** replay 去重集合：重连时服务端重放整段历史，按 wire id 幂等。 */
  seenSrvIds: Set<string>;
  phase: Phase;
  model?: string;
  contextPct?: number;
  queue: QueueItem[];
  /** 当前流式中的块 id；null = 无活体流。 */
  streamingTurnId: string | null;
  /**
   * 纠偏队列 id 集合（1.3.0 修正）：wire 里**每条** user 消息都带
   * queueId（发送管线必发），不能靠「有没有 queueId」判纠偏——以
   * chat:steering-added 广播为准登记，replay 时按 id 查。
   * 边界：重连后集合清空，历史纠偏徽标不恢复（已知取舍）。
   */
  steeringIds: string[];
}

export function emptySession(): SessionState {
  return {
    items: [],
    seq: 0,
    seenSrvIds: new Set(),
    phase: 'idle',
    queue: [],
    streamingTurnId: null,
    steeringIds: [],
  };
}

// ---------------------------------------------------------------------------
// 纯函数：徽标行 / 信号提取 / 工具序号
// ---------------------------------------------------------------------------

export interface BadgeSummary {
  toolCount: number;
  thinkingSeconds: number;
  /** 工具名 → 次数直方图（保持首次出现顺序）。 */
  histogram: Array<{ name: string; count: number }>;
}

const TOOL_STEP_CHARS = '①②③④⑤⑥⑦⑧⑨⑩';

/** turn 内工具序号字符（1 → ①；>10 回落阿拉伯数字）。 */
export function toolStepChar(step: number): string {
  return step >= 1 && step <= TOOL_STEP_CHARS.length
    ? TOOL_STEP_CHARS[step - 1]
    : String(step);
}

/** 徽标行数据：`⎿ ⚙ N · ⏵ Ns · ⛁ name×N`。 */
export function buildBadgeSummary(details: DetailItem[]): BadgeSummary {
  let toolCount = 0;
  let thinkingSeconds = 0;
  const histogram: Array<{ name: string; count: number }> = [];
  for (const d of details) {
    if (d.kind === 'thinking') {
      if (typeof d.seconds === 'number') thinkingSeconds += d.seconds;
      continue;
    }
    toolCount++;
    const entry = histogram.find((h) => h.name === d.name);
    if (entry) entry.count++;
    else histogram.push({ name: d.name, count: 1 });
  }
  return { toolCount, thinkingSeconds, histogram };
}

/** thinking 合计秒数（⏵ 段）。 */
export function thinkingTotalSeconds(details: DetailItem[]): number {
  return buildBadgeSummary(details).thinkingSeconds;
}

/**
 * 工具卡关键信号（v19 的 sig 列）——从工具名 + 输出提取一行摘要。
 * 轻量版：不引入 TUI 的 signal-extract 全家，只覆盖最常见的几种。
 */
export function summarizeSignal(
  name: string,
  output: string,
  opts: { isError?: boolean; exitCode?: number } = {},
): string | undefined {
  if (opts.isError || (opts.exitCode !== undefined && opts.exitCode !== 0)) {
    const segv = /(SIGSEGV|Segmentation fault)/i.exec(output);
    if (segv) return `${segv[1]} at ${/0x[0-9a-fA-F]+/.exec(output)?.[0] ?? '…'}`;
    return opts.exitCode !== undefined ? `exit=${opts.exitCode}` : '失败';
  }
  const flag = /flag\{[^}]*\}/i.exec(output);
  if (flag) return 'flag 已读取';
  if (/\d+\/tcp\s+open/i.test(output)) return '端口开放';
  if (/CVE-\d{4}-\d+/i.test(output)) return 'CVE 命中';
  if (name === 'env_exec') return 'exit=0';
  return undefined;
}
