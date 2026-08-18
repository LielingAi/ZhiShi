// Shared environment utilities for server-side subprocesses.
// Relocated from runtimes/env-utils.ts (D20: external runtimes removed);
// consumers are now the environment layer (docker / VM lifecycle, engine
// binaries). The external-runtime-only helpers (resolveAgentEnvPolicy,
// stripAnsi) were dropped with the runtimes.

import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import type { RuntimeEnvPolicy } from '../../shared/types/runtime';
import { getShellEnv, getShellPath, getDetectedTerminalProxyEnv } from './shell';

const PROXY_KEYS_UPPER = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'] as const;
const PROXY_KEYS_LOWER = ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'] as const;
const PROXY_KEYS_ALL = [...PROXY_KEYS_UPPER, ...PROXY_KEYS_LOWER] as const;

/**
 * Lightweight PATH-based command lookup.
 *
 * On Windows, honours PATHEXT (.EXE, .CMD, .BAT, etc.) so .cmd shims from
 * npm-global installs are found. Absolute paths bypass PATH and are verified
 * via `statSync` directly.
 */
function which(command: string, opts?: { PATH?: string }): string | null {
  const pathStr = opts?.PATH ?? process.env.PATH ?? '';
  if (!pathStr) return null;
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())
    : [''];
  // Absolute path bypass: if caller passed an absolute executable, just verify it.
  if (command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) {
    try {
      if (statSync(command).isFile()) return command;
    } catch { /* not found */ }
    return null;
  }
  for (const dir of pathStr.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* skip */ }
    }
  }
  return null;
}

/**
 * Build an augmented env for spawning subprocesses (environment engines,
 * VM tooling, etc.).
 *
 * Delegates to getShellEnv() which already handles:
 * - Windows: system PATH + npm global (%APPDATA%\npm), Git, Bun, Node.js
 * - macOS: shell -l PATH detection + homebrew, NVM, pnpm, Bun
 * - PATH key normalization (Windows Path vs Unix PATH)
 *
 * NOTE: The Sidecar process already has NO_PROXY injected by Rust's
 * proxy_config::apply_to_subprocess(). getShellEnv() spreads process.env,
 * so subprocesses spawned here are also protected.
 *
 * Issue #194 — `policy.proxy` selects how proxy env reaches the subprocess:
 *  - `zhishi` (default): inherit Sidecar's process.env proxy vars (Rust
 *    injects ZhiShi-configured proxy into the Sidecar's env at spawn).
 *  - `terminal`: replace the inherited proxy vars with whatever the user's
 *    interactive shell exports (detected during shell.ts warmup). If warmup
 *    found nothing, all proxy vars are stripped — that's terminal parity for
 *    users who don't export proxies in their rc, which also serves the
 *    Clash-TUN / VPN case (system-level routing handles networking, no
 *    application proxy needed).
 */
export function augmentedProcessEnv(
  policy?: RuntimeEnvPolicy,
): Record<string, string | undefined> {
  const env = getShellEnv();

  // Defense-in-depth: only act on the explicit allowlist. An unknown value
  // (forward-compat: a future policy literal not yet implemented here, a
  // deprecated literal like the removed `'direct'`, or a malformed config
  // that slipped past upstream validation) MUST behave as `'zhishi'` —
  // i.e. don't strip the user's proxy env on a guess.
  const rawPolicy = policy?.proxy;
  const proxyPolicy: 'zhishi' | 'terminal' =
    rawPolicy === 'terminal' ? 'terminal' : 'zhishi';

  if (proxyPolicy === 'zhishi') {
    // Legacy / default — leave inherited proxy vars in place. Rust's
    // `apply_to_subprocess` already populated them in the Sidecar's env.
    return env;
  }

  // 'terminal' — strip every inherited proxy var, then restore whatever the
  // user's interactive shell would set. Drop the ZhiShi-injected marker
  // too so downstream code doesn't mistake a stripped env for a ZhiShi-
  // controlled one.
  for (const k of PROXY_KEYS_ALL) delete env[k];
  delete env.ZHISHI_PROXY_INJECTED;

  const detected = getDetectedTerminalProxyEnv();
  if (detected) {
    for (const [k, v] of Object.entries(detected)) {
      // Skip empty values — those mean "user has the var unset". The strip
      // above already removed inherited values, so leaving them out is the
      // correct terminal-parity outcome (and also serves Clash-TUN / VPN
      // users whose shell typically has no proxy set).
      if (v && v.length > 0) {
        env[k] = v;
      }
    }
  }
  // If warmup hasn't completed yet, `detected` is null → env stays stripped.

  return env;
}

/**
 * Resolve a command to its full executable path.
 *
 * Uses our local `which()` with the augmented PATH (from `getShellPath()`)
 * on ALL platforms.
 *
 * Why this is needed everywhere (not just Windows):
 * - Windows: npm global installs create `.cmd` wrappers; `spawn()` via libuv
 *   doesn't resolve PATH extensions (.CMD/.BAT) → ENOENT. See: #70
 * - macOS/Linux: `spawn()` uses posix_spawnp which searches the CALLER's PATH,
 *   not the env passed to the child. GUI apps (Tauri/Finder) have minimal PATH
 *   that lacks NVM/fnm/volta/asdf paths. Even though augmentedProcessEnv() builds
 *   a correct PATH, the bare command name won't be found by posix_spawnp.
 *   Pre-resolving to a full path bypasses PATH lookup entirely.
 */
export function resolveCommand(command: string): string {
  const resolved = which(command, { PATH: getShellPath() });
  if (resolved) return resolved;
  // Fallback: return as-is and let spawn fail with a clear error
  return command;
}
