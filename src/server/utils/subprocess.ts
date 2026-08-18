/**
 * Bun.spawn → node:child_process adapter
 *
 * Exposes a Bun.spawn-shaped interface over node:child_process.spawn, so
 * existing call sites (`proc.pid` / `proc.stdin` / `proc.stdout` / `proc.stderr`
 * / `proc.exited` / `proc.kill`) port over without per-site rewrites.
 *
 * Stream-shape compatibility:
 *   - `stdout` / `stderr` are exposed as Web ReadableStream<Uint8Array>
 *     (via Readable.toWeb), matching Bun.spawn so callers using
 *     `new Response(proc.stdout).text()` or `.getReader()` continue to work.
 *   - `stdin` is a Bun-compatible writer exposing `.write(chunk)` → Promise and
 *     `.end()` → Promise; built on top of Node Writable.
 *
 * Bun.spawn semantic parity (intentional):
 *   - `exited` resolves on Node `'close'` (not `'exit'`) — matches Bun's
 *     "stdio drained" contract, so callers reading stdout/stderr don't race
 *     with the exit handler (the pre-D20 runtime adapters relied on Bun's
 *     behavior).
 *   - Spawn errors (ENOENT / ENOEXEC / bad CPU type) are preserved in
 *     `.error` and surfaced via `exited` — callers that log `code === 0 ?
 *     'ok' : <error>` now see the actual cause instead of bare `-1`.
 *   - `stdin.write()` back-pressure is driven by Node's write callback, not
 *     by probing the synchronous `ok` return, so the Promise settles
 *     correctly on both success and EPIPE / stream-closed paths.
 */
import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions as NodeSpawnOptions,
  type StdioOptions,
} from 'node:child_process';
import { Readable, type Writable } from 'node:stream';

export interface SubprocessStdin {
  /** Write a chunk; resolves when Node's write callback fires (success or flushed). */
  write(chunk: string | Uint8Array): Promise<void>;
  /** Close the stdin stream (EOF). Resolves when the stream is fully flushed. */
  end(): Promise<void>;
  /** Expose the underlying Node Writable for callers that need full API. */
  readonly underlying: Writable;
}

export interface SubprocessHandle {
  readonly pid: number;
  readonly stdin: SubprocessStdin | null;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  /**
   * Resolves when the child process has fully exited AND stdio has drained.
   * Value is the numeric exit code (0-255), or -1 for signal-only termination
   * or pre-spawn error. Inspect `.error` / `.exitSignal` for root cause.
   */
  readonly exited: Promise<number>;
  /** Populated if the child emitted `error` (spawn failure), else undefined. */
  readonly error: Error | undefined;
  /** POSIX signal name that terminated the child, or undefined. */
  readonly exitSignal: NodeJS.Signals | undefined;
  /** Decouple the child from the parent's event loop (fire-and-forget openers). */
  unref(): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: 'pipe' | 'ignore' | 'inherit';
  stdout?: 'pipe' | 'ignore' | 'inherit';
  stderr?: 'pipe' | 'ignore' | 'inherit';
  windowsHide?: boolean;
  detached?: boolean;
}

const IS_WINDOWS = process.platform === 'win32';

/**
 * Windows-only: `child_process.spawn` cannot execute `.cmd` / `.bat` shims
 * directly without going through cmd.exe (Node ≥20.12 hard-rejects this since
 * CVE-2024-27980). npm-installed CLI binaries — `codex.cmd`, `gemini.cmd`,
 * `claude.cmd`, `npx.cmd`, plugin-bridge launchers — are exactly these shims,
 * so they silently fail to spawn unless we route them through cmd.exe.
 */
function needsWindowsShell(cmd: string): boolean {
  if (!IS_WINDOWS) return false;
  const lower = cmd.toLowerCase();
  return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

// cmd.exe metacharacters that need ^-escaping outside double quotes.
// Source: cross-spawn (battle-tested across the npm ecosystem) — see
// https://github.com/moxystudio/node-cross-spawn/blob/master/lib/util/escape.js
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

// `node_modules/.bin/<name>.cmd` shims internally re-invoke cmd.exe, which
// consumes the ^-escapes a second time — those need double-escaping. Globally
// installed shims at `%APPDATA%\npm\<name>.cmd` (and our own bundled launchers)
// don't, so single-escape is correct for them.
const CMD_SHIM_REGEX = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

/**
 * Quote one arg for safe interpolation into a `cmd.exe /d /s /c "<cmdline>"`
 * command line. Naive `shell: true` does NOT do this — it space-joins args
 * verbatim, which means any arg containing `"` (e.g. Codex's
 * `-c project_doc_fallback_filenames=["CLAUDE.md"]` or Claude Code's
 * `--append-system-prompt "<text with quotes>"`) gets mangled when the .cmd
 * shim re-parses argv via MSVCRT rules — the inner quotes are stripped before
 * the target binary sees them, breaking TOML / shell-arg semantics.
 *
 * Algorithm (mirrors cross-spawn):
 *   1. Backslash-escape each `"` (also doubling preceding backslashes)
 *   2. Double trailing backslashes so they don't escape the closing quote
 *   3. Wrap in `"..."`
 *   4. ^-escape cmd.exe metacharacters (so they survive cmd.exe's first pass)
 *   5. (For local node_modules/.bin shims only) ^-escape a second time
 */
function escapeWindowsCmdArg(arg: string, doubleEscapeMetaChars: boolean, argIndex?: number): string {
  let s = String(arg);
  // cmd.exe-wrapped commands inherit the host's command-line parser, which
  // treats `\r` / `\n` as command boundaries even inside the `/c "<cmdline>"`
  // quoting context. The arg is not technically escapable — the only honest
  // fix is to route multi-line content through stdin / env / a temp file (see
  // claude-code.ts:writeSystemPromptFile for a worked example). We still
  // forward the arg here so callers' behaviour doesn't change on this hot
  // path, but a loud warning is emitted so the next person to hit this
  // doesn't burn a week reverse-engineering "why are random args getting
  // dropped on Windows only". Linux/macOS callers never reach this function,
  // so they don't get spurious warns.
  //
  // The warning intentionally does NOT include arg content (it might be a
  // system prompt, PEM block, env blob, or pasted user text — none of which
  // belong in a unified log streamed to the renderer over SSE). argIndex +
  // length + line count + a hash give enough fingerprint to identify the
  // call site without leaking secrets. The whole block is `try`-guarded
  // because a failing logger path must never alter spawn behaviour.
  if (/[\r\n]/.test(s)) {
    try {
      const lineCount = (s.match(/\r\n|\r|\n/g) || []).length + 1;
      // FNV-1a 32-bit — non-cryptographic, just enough to correlate repeat
      // offenders across log lines without printing the content.
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      }
      console.warn(
        `[subprocess] cmd.exe-wrapped argument contains \\r or \\n ` +
        `(argIndex=${argIndex ?? '?'}, length=${s.length}, lines=${lineCount}, fp=${h.toString(16).padStart(8, '0')}). ` +
        `cmd.exe will silently truncate the command at the first newline, dropping all ` +
        `subsequent arguments. Pass multi-line content via stdin, env var, or a temp file ` +
        `(e.g. --foo-file <path>) instead.`
      );
    } catch { /* diagnostic-only; never let logging failure change spawn behaviour */ }
  }
  // Greedy `(\\*)` so 2+ consecutive backslashes preceding `"` (or end-of-arg)
  // are all doubled. Earlier draft used lazy `(\\+?)?` which captured at most
  // one backslash and silently emitted `…\\\\"` (4 BS + bare quote) for input
  // `…\\"`, which cmd.exe then reads as a string terminator → arg truncation.
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  s = s.replace(/(\\*)$/, '$1$1');
  s = `"${s}"`;
  s = s.replace(CMD_META_CHARS, '^$1');
  if (doubleEscapeMetaChars) s = s.replace(CMD_META_CHARS, '^$1');
  return s;
}

function escapeWindowsCmdCommand(cmd: string): string {
  return cmd.replace(CMD_META_CHARS, '^$1');
}

export function spawn(argv: string[], options: SpawnOptions = {}): SubprocessHandle {
  if (!argv.length) throw new Error('spawn: argv must be non-empty');
  const [cmd, ...args] = argv;

  const stdio: StdioOptions = [
    options.stdin ?? 'pipe',
    options.stdout ?? 'pipe',
    options.stderr ?? 'pipe',
  ];

  const nodeOpts: NodeSpawnOptions = {
    cwd: options.cwd,
    env: options.env,
    stdio,
    windowsHide: options.windowsHide,
    detached: options.detached,
  };

  // CVE-2024-27980 / Node ≥20.12 hardening: .cmd/.bat cannot be invoked
  // directly. The previous `nodeOpts.shell = true` path delegated to Node's
  // built-in shell wrapping, but that wrapping does NOT escape `"`, spaces, or
  // cmd.exe metacharacters in args — by design (`windowsVerbatimArguments`).
  // That broke any callers passing structured-text args, e.g.:
  //   codex -c 'project_doc_fallback_filenames=["CLAUDE.md"]'
  //   claude --append-system-prompt '<system text with quotes>'
  // Instead, we manually wrap via `cmd.exe /d /s /c "<escaped cmdline>"` with
  // the full cross-spawn escape algorithm, which preserves quoting through
  // both cmd.exe's parser and the .cmd shim's MSVCRT-style re-parse.
  if (needsWindowsShell(cmd)) {
    const doubleEscape = CMD_SHIM_REGEX.test(cmd);
    const escapedCmd = escapeWindowsCmdCommand(cmd);
    const escapedArgs = args.map((a, i) => escapeWindowsCmdArg(a, doubleEscape, i));
    const cmdLine = [escapedCmd, ...escapedArgs].join(' ');
    nodeOpts.windowsVerbatimArguments = true;
    // Default windowsHide:true on the cmd.exe wrap path — wrapping IS the
    // exact situation where a brief console window would otherwise pop. Lets
    // call sites omit `windowsHide` without leaking a flash, the same
    // pit-of-success shape as `local_http` / `process_cmd` / `apply_to_subprocess`.
    if (options.windowsHide === undefined) nodeOpts.windowsHide = true;
    const comspec = process.env.comspec || 'cmd.exe';
    const child = nodeSpawn(comspec, ['/d', '/s', '/c', `"${cmdLine}"`], nodeOpts);
    return wrapChildProcess(child);
  }

  const child = nodeSpawn(cmd, args, nodeOpts);
  return wrapChildProcess(child);
}

function wrapStdin(w: Writable | null): SubprocessStdin | null {
  if (!w) return null;
  return {
    underlying: w,
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        // Node's callback fires on both flush success and error paths — this
        // avoids the `ok=true` branch that previously left drain listeners hanging.
        w.write(chunk, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    end() {
      return new Promise<void>((resolve) => {
        // `finish` fires after last byte flushes; `end` synchronously queues
        // the close. We resolve via the finish event so graceful-shutdown callers
        // know stdin was drained.
        w.once('finish', () => resolve());
        w.once('error', () => resolve()); // already-closed / EPIPE is benign here
        w.end();
      });
    },
  };
}

/** Wrap an existing ChildProcess in the SubprocessHandle shape. */
export function wrapChildProcess(child: ChildProcess): SubprocessHandle {
  // Track state mutated by event handlers; readers expose them as handle props.
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | undefined;
  let spawnError: Error | undefined;

  const exited = new Promise<number>((resolve) => {
    let settled = false;
    const settle = (value: number): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // 'exit' captures code/signal (fires before 'close').
    child.once('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal ?? undefined;
    });
    // 'close' fires after stdio has fully drained — Bun.spawn.exited semantics.
    child.once('close', (code, signal) => {
      // code/signal on 'close' mirror the earlier 'exit' event; prefer the
      // captured values if 'exit' already ran, else use 'close' args.
      const finalCode = exitCode !== null ? exitCode : code;
      if (exitSignal === undefined && signal) exitSignal = signal;
      settle(finalCode ?? -1);
    });
    child.once('error', (err) => {
      spawnError = err;
      // 'error' can fire without 'exit'/'close' (spawn failed before fork).
      // Settle to -1 so callers unblock; caller inspects .error for details.
      settle(-1);
    });
  });

  // Readable.toWeb locks the underlying Readable — must cache the Web wrappers
  // so repeated .stdout / .stderr access returns the same stream.
  let cachedStdin: SubprocessStdin | null | undefined;
  let cachedStdout: ReadableStream<Uint8Array> | null | undefined;
  let cachedStderr: ReadableStream<Uint8Array> | null | undefined;

  return {
    get pid() {
      return child.pid ?? -1;
    },
    get stdin() {
      if (cachedStdin === undefined) cachedStdin = wrapStdin(child.stdin);
      return cachedStdin;
    },
    get stdout() {
      if (cachedStdout === undefined) {
        cachedStdout = child.stdout
          ? (Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>)
          : null;
      }
      return cachedStdout;
    },
    get stderr() {
      if (cachedStderr === undefined) {
        cachedStderr = child.stderr
          ? (Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>)
          : null;
      }
      return cachedStderr;
    },
    exited,
    get error() {
      return spawnError;
    },
    get exitSignal() {
      return exitSignal;
    },
    unref() {
      child.unref();
    },
    kill(signal) {
      // Node's child.kill accepts both names and numbers at runtime; TS type is too narrow.
      return child.kill(signal as NodeJS.Signals);
    },
  };
}

export type Subprocess = SubprocessHandle;

/**
 * One-shot, detached spawn with all stdio ignored — for GUI openers
 * (`open -R`, `explorer /select`, `xdg-open`, etc.) where we don't care
 * about the child's output or exit status, only that it starts.
 *
 * Unlike a bare `spawn()` followed by discarding the handle, this:
 *  - Doesn't create pipes that nobody reads (Bun.spawn pre-migration didn't
 *    either, but subprocess.spawn defaults to 'pipe' for Bun-API parity).
 *  - Detaches + unrefs so the child doesn't block Node event loop exit.
 *  - Silently swallows spawn errors (caller has no channel to react anyway).
 */
export function fireAndForget(argv: string[]): void {
  try {
    const handle = spawn(argv, {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      detached: true,
    });
    handle.unref();
    // If the underlying spawn failed asynchronously (ENOENT, bad arch, etc.),
    // Node emits 'error' before our handle settles. Surface a one-line warn
    // so users clicking "Reveal in Finder" / "Open in system editor" don't
    // silently fail — they'll at least see a log entry in the unified log.
    handle.exited.then((code) => {
      if (handle.error) {
        console.warn(`[fireAndForget] ${argv[0]} spawn failed: ${handle.error.message}`);
      } else if (code !== 0) {
        console.warn(`[fireAndForget] ${argv[0]} exited with code ${code}`);
      }
    }).catch(() => { /* settled via catch — error already logged via handle.error */ });
  } catch (err) {
    console.warn(`[fireAndForget] synchronous spawn error for ${argv[0]}:`, err instanceof Error ? err.message : err);
  }
}
