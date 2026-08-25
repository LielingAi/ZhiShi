/**
 * entry (plan §0.3, 入口切换点). Wires the process to the App:
 *   TTY check → SidecarClient → session bind (latest or fresh security
 *   session) → TerminalWriter (alternate screen) → App (gate → chat).
 *
 * The App owns the gate screen, the SSE pump and the key loop; this module
 * owns only process-level concerns: raw mode, resize, and clean teardown
 * (alternate screen + raw mode restored).
 *
 * 1.3.5:/attach 终端挂起已移除(GUI AttachView/WS pty 替代),suspend/resume
 * 接线随之删除;--env/--new-env 直通也移除,环境选择统一走启动正门 gate。
 *
 * Non-TTY (CI/pipes): prints a hint and returns cleanly — no alt screen.
 */

import { SidecarClient, type FetchLike } from '../client';
import { TerminalWriter } from './terminal-writer';
import { App } from './app';
import { detectColorDepth } from './style';
import type { TimerApi } from './frame-scheduler';

const globalTimer: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface ResizeDebouncerOptions {
  /** 读最新终端尺寸（事件只代表「变了」，尺寸以触发时为准）。 */
  measure: () => { cols: number; rows: number };
  /** 防抖到期后一次性应用（entry 里是 writer.resize —— 全量重折行 + 重绘）。 */
  apply: (cols: number, rows: number) => void;
  /** 静默窗口（默认 50ms）：拖窗口一秒几十个事件，合成一次 reflow。 */
  debounceMs?: number;
  timer?: TimerApi;
}

/**
 * P5（1.1.9）：resize 防抖。拖动/缩放窗口时 resize 事件以每秒几十个的频率
 * 到达，每个都同步 writer.resize()（全量重折行 + 同步重绘）会把主线程打满。
 * 这里只记「有未应用的尺寸」，静默 debounceMs 后一次性取最新尺寸应用。
 * trailing-only：最后一次事件后必有一次 apply，不会停在中间尺寸。
 */
export function createResizeDebouncer(opts: ResizeDebouncerOptions): {
  onResize: () => void;
  cancel: () => void;
} {
  const ms = Math.max(1, opts.debounceMs ?? 50);
  const timer = opts.timer ?? globalTimer;
  let pending: unknown = null;
  const fire = (): void => {
    pending = null;
    const { cols, rows } = opts.measure();
    opts.apply(cols, rows);
  };
  return {
    onResize: () => {
      if (pending !== null) timer.clearTimeout(pending);
      pending = timer.setTimeout(fire, ms);
    },
    cancel: () => {
      if (pending !== null) {
        timer.clearTimeout(pending);
        pending = null;
      }
    },
  };
}

/**
 * H8(1.2.8):致命异常兜底。任何 uncaughtException/unhandledRejection 先恢复
 * 终端(退 alt screen + 回 raw mode,复用 cleanup 序列)再非零退出——否则
 * 崩溃会把用户的 shell 留在 alt screen + raw mode(终端「花屏卡死」)。
 */
export function createFatalHandler(deps: {
  restore: () => void;
  log: (msg: string) => void;
  exit: (code: number) => void;
}): (err: unknown) => void {
  return (err) => {
    try {
      deps.restore();
    } catch {
      // 恢复本身失败也要继续退出流程。
    }
    deps.log(`✗ TUI 致命异常:${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    deps.exit(1);
  };
}

export interface AgentLoopOptions {
  /** Sidecar ROOT base URL (no /api/admin), e.g. `http://127.0.0.1:19100`. */
  base: string;
  /** Agent workspace dir — typically process.cwd(). */
  agentDir: string;
  fetchImpl?: FetchLike;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/**
 * Attach to this workspace's session for the CURRENT selected environment
 * (1.1.6 #4 会话按环境分线):the sidecar keeps a workspace × 环境键 →
 * loop session mapping; `environment/current` returns the SessionStore
 * session bound to that line. The old "list all workspace sessions and walk
 * newest→oldest trying switch" is abolished — it crossed env lines (the
 * newest session usually belongs to another environment).
 *
 * Stale mapping (meta deleted, switch 404s) or no mapping at all → fall
 * through to a fresh session (security scenario — the scenario chain is the
 * context-injection switch; dropping it silently degrades the system prompt).
 */
export async function ensureAgentSession(client: SidecarClient, agentDir: string): Promise<string> {
  const current = await client.adminPost<{
    success?: boolean;
    error?: string;
    data?: { sessionId?: string | null };
  }>('environment/current', { workspace: agentDir });
  if (current.success === false) {
    throw new Error(`environment/current failed: ${current.error ?? 'unknown error'}`);
  }
  const mappedId = typeof current.data?.sessionId === 'string' ? current.data.sessionId : null;
  if (mappedId) {
    const res = await client.postJson<{ success?: boolean; error?: string }>('/sessions/switch', {
      sessionId: mappedId,
    });
    if (res.success !== false) return mappedId;
  }
  const created = await client.postJson<{ success?: boolean; error?: string; session?: { id?: string } }>(
    '/sessions',
    { agentDir, scenario: 'security' },
  );
  if (created.success === false || !created.session?.id) {
    throw new Error(`POST /sessions failed: ${created.error ?? 'unknown error'}`);
  }
  return String(created.session.id);
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  // CI / piped shells: no alternate-screen TUI possible — exit cleanly.
  if (!input.isTTY || !output.isTTY) {
    console.error('zhishi agent 需要交互式终端（TTY）；当前环境无 TTY，未启动会话界面。');
    return;
  }

  // L6(1.2.8):setEncoding 内部走 string_decoder——跨 chunk 的多字节字符
  // (CJK/emoji)不再被 Buffer#toString 逐 chunk 截断成 �。
  input.setEncoding('utf8');

  const client = new SidecarClient({ base: opts.base, fetchImpl: opts.fetchImpl });

  try {
    await ensureAgentSession(client, opts.agentDir);
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const writer = new TerminalWriter({
    out: { write: (t: string) => output.write(t) },
    cols: output.columns || 80,
    rows: output.rows || 24,
    depth: detectColorDepth(process.env),
  });

  const wasRaw = (input as NodeJS.ReadStream & { isRaw?: boolean }).isRaw ?? false;

  const app = new App({
    client,
    writer,
    input,
    workspace: opts.agentDir,
  });

  input.setRawMode?.(true);
  // P5：resize 防抖（~50ms），期间只记最新尺寸，静默后一次性 reflow。
  const resizeDebouncer = createResizeDebouncer({
    measure: () => ({ cols: output.columns || 80, rows: output.rows || 24 }),
    apply: (cols, rows) => writer.resize(cols, rows),
  });
  const onResize = resizeDebouncer.onResize;
  output.on('resize', onResize);

  let exiting = false;
  const cleanup = (): void => {
    if (exiting) return;
    exiting = true;
    output.removeListener('resize', onResize);
    resizeDebouncer.cancel(); // 退出后不再补刀一次 reflow
    app.dispose();
    writer.exit();
    writer.dispose(); // final teardown — kills the frame scheduler's timer
    input.setRawMode?.(wasRaw);
  };

  // H8(1.2.8):致命异常兜底——先恢复终端(cleanup 序列)再非零退出;
  // exit 钩子覆盖未走 cleanup 的非常规退出(幂等)。
  const fatal = createFatalHandler({
    restore: cleanup,
    log: (msg) => console.error(msg),
    exit: (code) => process.exit(code),
  });
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  process.on('exit', () => {
    if (exiting) return;
    try {
      writer.exit();
      input.setRawMode?.(wasRaw);
    } catch {
      /* 退出阶段不再抛错 */
    }
  });

  writer.enter();
  await app.start();

  // Keep the process alive until the user quits. 1.3.5:/quit 已移除——退出路径
  // 为:正门 Esc、chat 空闲时 Ctrl+C(空输入,onCtrlC → quitRequested)、以及
  // SIGINT/SIGTERM 信号。finish 幂等(cleanup 的 exiting 标记),重复触发无副作用。
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      cleanup();
      resolve();
    };
    process.on('SIGINT', finish);
    process.once('SIGTERM', finish);
    const poll = setInterval(() => {
      if (app.quitRequested) {
        clearInterval(poll);
        finish();
      }
    }, 40);
  });
}
