/**
 * entry (plan §0.3, 入口切换点). Wires the process to the App:
 *   TTY check → SidecarClient → session bind (latest or fresh security
 *   session) → TerminalWriter (alternate screen) → App (gate → chat).
 *
 * The App owns the gate screen, the SSE pump and the key loop; this module
 * owns only process-level concerns: raw mode, resize, suspend/resume for
 * /attach, and clean teardown (alternate screen + raw mode restored).
 *
 * Non-TTY (CI/pipes): prints a hint and returns cleanly — no alt screen.
 */

import { SidecarClient, type FetchLike } from '../client';
import { TerminalWriter } from './terminal-writer';
import { App } from './app';
import { resolveFlag, type GateResult } from './gate';
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

export interface AgentLoopOptions {
  /** Sidecar ROOT base URL (no /api/admin), e.g. `http://127.0.0.1:19100`. */
  base: string;
  /** Agent workspace dir — typically process.cwd(). */
  agentDir: string;
  /** `--env <id>` — skip the gate screen, select named env. */
  envId?: string;
  /** `--new-env <recipe>` — skip the gate screen, build from recipe. */
  newEnvRecipe?: string;
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

  const client = new SidecarClient({ base: opts.base, fetchImpl: opts.fetchImpl });

  // --env / --new-env short-circuit the gate; failures abort before entering
  // the alternate screen so the error reads in the normal scrollback.
  let presetEnv: GateResult | null = null;
  try {
    presetEnv = await resolveFlag(client, opts.agentDir, opts.envId, opts.newEnvRecipe);
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

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

  // /attach terminal hand-off: leave the alternate screen and restore cooked
  // mode so the spawned shell owns the TTY; re-enter + reflow on child exit.
  const wasRaw = (input as NodeJS.ReadStream & { isRaw?: boolean }).isRaw ?? false;
  const suspend = (): void => {
    writer.exit();
    input.setRawMode?.(false);
  };
  const resume = (): void => {
    input.setRawMode?.(true);
    writer.enter();
    writer.resize(output.columns || 80, output.rows || 24);
  };

  const app = new App({
    client,
    writer,
    input,
    workspace: opts.agentDir,
    presetEnv,
    suspend,
    resume,
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

  writer.enter();
  await app.start();

  // Keep the process alive until the user quits (Esc at the gate, /quit, or
  // Ctrl+C on an empty idle line sets app.quitRequested).
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      cleanup();
      resolve();
    };
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    const poll = setInterval(() => {
      if (app.quitRequested) {
        clearInterval(poll);
        finish();
      }
    }, 40);
  });
}
