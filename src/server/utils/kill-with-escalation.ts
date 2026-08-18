import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';

type KillSignal = NodeJS.Signals | number;

export interface KillEscalationOptions {
  gracefulSignal?: NodeJS.Signals;
  gracefulMs: number;
  hardSignal?: NodeJS.Signals;
  hardMs: number;
  /**
   * When `true`, escalate to the **process tree** rather than the root pid:
   *
   *   - POSIX: `process.kill(-pid, signal)` to signal the entire process group.
   *     This requires the child to have been spawned with `detached: true` so
   *     it became the leader of a new group; otherwise the negative-pid signal
   *     would be delivered to our *own* group too.
   *   - Windows: spawn `taskkill /F /T /PID <pid>` which terminates the child
   *     and all of its descendants regardless of process-group state — so on
   *     Windows the child is intentionally spawned with `detached: false`
   *     (detached + stdio:'pipe' breaks parent stdout reads on Windows; see
   *     issue #170 #3/#5).
   *
   * Required for subprocesses that fork their own helpers — without tree-kill
   * those descendants outlive the parent and the helper would falsely report
   * `exited: true, orphanRisk: false`.
   */
  killTree?: boolean;
  onStep?: (step: 'graceful' | 'hard' | 'orphan', info: { pid: number }) => void;
}

export interface KillResult {
  exited: boolean;
  signalUsed?: 'graceful' | 'hard';
  orphanRisk: boolean;
  elapsedMs: number;
}

export interface EscalatableProcess {
  readonly pid: number;
  readonly exited?: boolean;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal?: KillSignal): boolean | void;
  waitForExit?: () => Promise<unknown>;
}

function hasExited(proc: EscalatableProcess): boolean {
  if (proc.exited === true) return true;
  if (proc.exitCode !== undefined && proc.exitCode !== null) return true;
  if (proc.signalCode !== undefined && proc.signalCode !== null) return true;
  return false;
}

function waitForProcessExit(proc: EscalatableProcess): Promise<unknown> {
  if (proc.waitForExit) {
    return proc.waitForExit();
  }
  return once(proc as ChildProcess, 'exit');
}

/**
 * Best-effort tree kill — POSIX via process-group signal, Windows via
 * `taskkill /T`. Falls back to single-pid `proc.kill()` if the platform-
 * specific path fails. Never throws.
 */
function killTreeBestEffort(proc: EscalatableProcess, signal: NodeJS.Signals | number): void {
  if (process.platform === 'win32') {
    // taskkill: /F = force, /T = terminate child tree.
    // Spawn detached + unref so taskkill itself doesn't hold the event loop.
    try {
      const tk = nodeSpawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], {
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      });
      tk.unref();
    } catch {
      // taskkill not on PATH (extremely rare on Windows); fall through to
      // the single-pid kill below as a last resort.
      try { proc.kill(signal); } catch { /* ignore */ }
    }
    return;
  }
  // POSIX: signal the process group. proc.pid here MUST be the pgid
  // (i.e. the child must have been spawned with `detached: true` so it
  // became its own group leader) — otherwise the negative-pid signal
  // targets our own group too and we'd kill the sidecar. (Windows uses
  // taskkill /T above and does not enter this branch.)
  try {
    process.kill(-proc.pid, signal as NodeJS.Signals);
  } catch (err) {
    // ESRCH = group already gone. Anything else (EPERM / EINVAL): fall
    // back to a direct single-pid signal.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return;
    try { proc.kill(signal); } catch { /* ignore */ }
  }
}

async function waitForExitWithin(proc: EscalatableProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(proc)) return true;

  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref?.();
  });

  const exitPromise = waitForProcessExit(proc).then(
    () => true,
    () => true,
  );

  const exited = await Promise.race([exitPromise, timeoutPromise]);
  if (timeout) clearTimeout(timeout);
  return exited || hasExited(proc);
}

export async function killWithEscalation(
  proc: EscalatableProcess,
  opts: KillEscalationOptions,
): Promise<KillResult> {
  const start = Date.now();
  const gracefulSignal = opts.gracefulSignal ?? 'SIGTERM';
  const hardSignal = opts.hardSignal ?? 'SIGKILL';
  let signalUsed: KillResult['signalUsed'];

  const elapsedMs = (): number => Date.now() - start;

  try {
    if (hasExited(proc)) {
      return { exited: true, orphanRisk: false, elapsedMs: 0 };
    }

    opts.onStep?.('graceful', { pid: proc.pid });
    signalUsed = 'graceful';
    if (opts.killTree) {
      killTreeBestEffort(proc, gracefulSignal);
    } else {
      try {
        proc.kill(gracefulSignal);
      } catch {
        /* ignore kill failures; exit wait below remains bounded */
      }
    }

    if (await waitForExitWithin(proc, opts.gracefulMs)) {
      return { exited: true, signalUsed, orphanRisk: false, elapsedMs: elapsedMs() };
    }

    opts.onStep?.('hard', { pid: proc.pid });
    signalUsed = 'hard';
    if (opts.killTree) {
      killTreeBestEffort(proc, hardSignal);
    } else {
      try {
        proc.kill(hardSignal);
      } catch {
        /* ignore kill failures; exit wait below remains bounded */
      }
    }

    if (await waitForExitWithin(proc, opts.hardMs)) {
      return { exited: true, signalUsed, orphanRisk: false, elapsedMs: elapsedMs() };
    }

    opts.onStep?.('orphan', { pid: proc.pid });
    return { exited: false, signalUsed, orphanRisk: true, elapsedMs: elapsedMs() };
  } catch {
    opts.onStep?.('orphan', { pid: proc.pid });
    return { exited: false, signalUsed, orphanRisk: true, elapsedMs: elapsedMs() };
  }
}
