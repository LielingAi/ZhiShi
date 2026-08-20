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
  const onResize = (): void => {
    writer.resize(output.columns || 80, output.rows || 24);
  };
  output.on('resize', onResize);

  let exiting = false;
  const cleanup = (): void => {
    if (exiting) return;
    exiting = true;
    output.removeListener('resize', onResize);
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
