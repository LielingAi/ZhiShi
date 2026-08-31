import { execFile } from 'child_process';
import { join } from 'path';
import { readdirSync, existsSync } from 'fs';
import { getZhiShiDataDir } from './app-dirs';

const isWindows = process.platform === 'win32';
const PATH_SEPARATOR = isWindows ? ';' : ':';
const PATH_KEY = isWindows ? 'Path' : 'PATH';

/**
 * Common binary paths for the current platform
 */
function getFallbackPaths(): string[] {
    if (isWindows) {
        const userProfile = process.env.USERPROFILE || '';
        const localAppData = process.env.LOCALAPPDATA || '';
        const programFiles = process.env.PROGRAMFILES || '';

        return [
            // ~/.zhishi/bin — MUST be first so external runtime shell tools can find
            // the `zhishi` CLI (runtime shell subprocess inherits this PATH via
            // augmentedProcessEnv → getShellEnv). Same reason as the Unix branch below.
            join(getZhiShiDataDir(), 'bin'),
            userProfile ? join(userProfile, '.bun', 'bin') : '',
            localAppData ? join(localAppData, 'bun', 'bin') : '',
            programFiles ? join(programFiles, 'nodejs') : '',
            userProfile ? join(userProfile, 'AppData', 'Roaming', 'npm') : '',
            // Git for Windows — SDK requires git; PATH may be stale after NSIS install
            programFiles ? join(programFiles, 'Git', 'cmd') : '',
            join(process.env['PROGRAMFILES(X86)'] || '', 'Git', 'cmd'),
            localAppData ? join(localAppData, 'Programs', 'Git', 'cmd') : '',
        ].filter(Boolean);
    }

    // macOS/Linux paths — cover common package managers and version managers.
    // GUI apps don't inherit shell PATH, so we enumerate known binary directories.
    const home = process.env.HOME;
    const paths = [
        // ~/.zhishi/bin — MUST be first so external runtime (Gemini/CC/Codex) shell
        // tools can find the `zhishi` CLI. The builtin SDK path has its own
        // explicit injection in buildClaudeSessionEnv, but external runtimes rely
        // on getFallbackPaths via augmentedProcessEnv → getShellEnv.
        join(getZhiShiDataDir(), 'bin'),
        '/opt/homebrew/bin',        // macOS Apple Silicon homebrew
        '/usr/local/bin',           // macOS Intel homebrew / Linux system
        home ? `${home}/.local/bin` : '',          // Claude Code / pipx / XDG user-local
        home ? `${home}/.bun/bin` : '',            // Bun global installs
        home ? `${home}/.npm-global/bin` : '',     // npm custom global prefix
        home ? `${home}/.cargo/bin` : '',          // Rust / cargo installs
        home ? `${home}/.volta/bin` : '',          // Volta (Node version manager)
        home ? `${home}/Library/pnpm` : '',        // pnpm (macOS)
    ];

    // Attempt to resolve NVM paths manually if exists.
    // Add ALL installed versions (sorted highest-first so the newest takes PATH priority).
    // Why all versions: `zsh -l -c` doesn't source .zshrc (non-interactive), so shell PATH
    // detection misses NVM. If we only add the highest version but the user installed
    // claude/codex on a different version, detection fails.
    if (process.env.HOME) {
        const nvmDir = join(process.env.HOME, '.nvm', 'versions', 'node');
        if (existsSync(nvmDir)) {
            try {
                const versions = readdirSync(nvmDir)
                    .filter(v => v.startsWith('v'))
                    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

                for (const v of versions) {
                    paths.push(join(nvmDir, v, 'bin'));
                }
                if (versions.length > 0) {
                    console.log('[shell] Found NVM node versions:', versions.join(', '));
                }
            } catch (e) {
                console.warn('[shell] Failed to resolve NVM paths:', e);
            }
        }

        const homeDir = process.env.HOME!; // narrowed by if-guard above

        // fnm (Fast Node Manager) — ~/.local/share/fnm/aliases/default/bin
        const fnmDir = join(homeDir, '.local', 'share', 'fnm', 'aliases', 'default', 'bin');
        if (existsSync(fnmDir)) paths.push(fnmDir);

        // asdf version manager — ~/.asdf/shims
        const asdfDir = join(homeDir, '.asdf', 'shims');
        if (existsSync(asdfDir)) paths.push(asdfDir);

        // mise (formerly rtx) — ~/.local/share/mise/shims
        const miseDir = join(homeDir, '.local', 'share', 'mise', 'shims');
        if (existsSync(miseDir)) paths.push(miseDir);
    }

    return paths.filter(Boolean);
}

/**
 * Builds the "fallback PATH": platform fallback directories ∪ process.env.PATH.
 * Pure string construction, always fast. Used on first access (before the
 * async shell-interactive detection completes) and as baseline prefix even
 * after detection — detected entries are appended, not replaced.
 */
function buildFallbackPath(): string {
    const fallback = getFallbackPaths().join(PATH_SEPARATOR);
    const existing = process.env[PATH_KEY] || process.env.PATH || '';
    return existing ? `${fallback}${PATH_SEPARATOR}${existing}` : fallback;
}

// Populated lazily with the fallback PATH on first sync read.
let cachedPath: string | null = null;
// Set once the async interactive-shell detection completes. Appended to
// the fallback PATH to form the enriched cached value.
let detectedUserPath: string | null = null;
// Promise guard — ensures exactly one concurrent execFile to the shell.
let warmupInFlight: Promise<void> | null = null;

/**
 * Proxy env vars captured from the user's interactive shell during warmup
 * (issue #194). When the user runs `codex` / `claude` directly in terminal,
 * THESE are the values their CLI subprocess inherits. RuntimeEnvPolicy
 * `proxy: 'terminal'` will substitute these into the external-runtime spawn
 * env so ZhiShi behaves consistently with terminal invocations.
 *
 * Each key's value is `null` while warmup hasn't completed, an empty string
 * `''` if the user's shell has the var explicitly unset, or the value otherwise.
 * `''` is intentionally distinct from null: it means "we asked, user said no".
 */
const TERMINAL_PROXY_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
] as const;
type TerminalProxyEnv = Partial<Record<typeof TERMINAL_PROXY_KEYS[number], string>>;
let detectedTerminalProxyEnv: TerminalProxyEnv | null = null;

/**
 * Synchronous PATH getter. Non-blocking by design:
 *   - First call returns the fallback PATH immediately
 *   - If background warmup has completed, returns fallback + detected user PATH
 *   - Never calls execSync (which would block the Node event loop and starve
 *     TCP accept during sidecar startup — measured 4-5s hang on slow .zshrc)
 *
 * Call `warmupShellPath()` once at process startup to kick off the async
 * interactive-shell detection.
 */
export function getShellPath(): string {
    if (cachedPath && detectedUserPath === null) {
        // Fallback-only cache. Return it; warmup may still be pending.
        return cachedPath;
    }
    if (cachedPath && detectedUserPath) {
        return cachedPath;
    }
    cachedPath = buildFallbackPath();
    return cachedPath;
}

/**
 * Returns an environment object with the corrected PATH.
 * Sync — uses whatever PATH `getShellPath()` can return right now.
 */
export function getShellEnv(): Record<string, string> {
    const path = getShellPath();
    const env = { ...process.env } as Record<string, string>;
    // Ensure single PATH key — Windows env may have Path or PATH;
    // spreading process.env into a plain object loses case-insensitivity,
    // so both casings can coexist and confuse child_process.spawn().
    delete env.PATH;
    delete env.Path;
    env[PATH_KEY] = path;
    return env;
}


/**
 * Kick off interactive-shell PATH detection in the background.
 *
 * Why not synchronous (the way this used to work):
 *   User shells with heavy .zshrc (oh-my-zsh, p10k, conda, etc.) can take
 *   3-5 seconds to spawn interactively. execSync would block the Node event
 *   loop for that entire duration — and since Node's HTTP accept is serviced
 *   on the event loop, TCP connections from Rust's health check were silently
 *   queued. Sidecar startup appeared frozen until the shell returned.
 *
 * Now: `execFile` is used with a Promise-wrapped callback, so detection runs
 * asynchronously without blocking. Startup is instant; detection finishes
 * whenever the shell returns (or times out).
 *
 * Safe to call multiple times — subsequent calls no-op while the first
 * detection is in flight or after it has completed.
 */
export function warmupShellPath(): Promise<void> {
    if (warmupInFlight) return warmupInFlight;
    if (detectedUserPath !== null) return Promise.resolve(); // already done

    // Windows: no interactive-shell detection, just prime the fallback cache.
    if (isWindows) {
        detectedUserPath = '';
        cachedPath = buildFallbackPath();
        console.log('[shell] Windows PATH configured (fallback only)');
        return Promise.resolve();
    }

    warmupInFlight = new Promise<void>((resolve) => {
        const shell = process.env.SHELL || '/bin/zsh';
        const pathMarker = `__ZHISHI_PATH_${process.pid}__`;
        const proxyMarker = `__ZHISHI_PROXY_${process.pid}__`;
        // Compose one shell invocation that captures BOTH the user's PATH and
        // their proxy-related env vars (issue #194). Cheaper than two shell
        // spawns; each var emitted between dedicated markers so we can parse
        // them out regardless of MOTD / p10k banner noise. `${VAR:-}` ensures
        // unset vars still produce empty output rather than aborting the echo.
        //
        // CRITICAL: each proxy line MUST be wrapped in `echo "..."` — without
        // it, `__MARKER__KEY=VALUE__MARKER__` parses as a shell *assignment*,
        // not output, so the entire proxy capture silently produces nothing
        // (Codex review #1 catch — would have made `proxy: 'terminal'` behave
        // identically to `direct` for everyone).
        const proxyEcho = TERMINAL_PROXY_KEYS
            .map(k => `echo "${proxyMarker}${k}=\${${k}:-}${proxyMarker}"`)
            .join(';');
        const cmd = `echo "${pathMarker}\${PATH}${pathMarker}";${proxyEcho}`;

        // -i interactive + -l login → sources both .zprofile and .zshrc (where
        // NVM/fnm/pnpm typically live). Marker isolates $PATH from noisy output
        // (MOTD, p10k banners, conda activation msgs).
        execFile(
            shell,
            ['-i', '-l', '-c', cmd],
            {
                encoding: 'utf-8',
                timeout: 5000,
                maxBuffer: 1024 * 1024,
            },
            (error, stdout) => {
                try {
                    if (error) {
                        console.warn(
                            '[shell] Interactive PATH detection failed, staying on fallback:',
                            error.message,
                        );
                        return;
                    }
                    const pathMatch = stdout.match(new RegExp(`${pathMarker}(.+?)${pathMarker}`));
                    if (pathMatch && pathMatch[1].length > 10) {
                        detectedUserPath = pathMatch[1];
                        cachedPath = `${buildFallbackPath()}${PATH_SEPARATOR}${detectedUserPath}`;
                        console.log('[shell] Detected user PATH via interactive shell');
                    }
                    // Parse proxy env vars — each `${proxyMarker}KEY=VALUE${proxyMarker}`.
                    // Capture both case spellings; both can coexist in user rc files.
                    const captured: TerminalProxyEnv = {};
                    const proxyRe = new RegExp(`${proxyMarker}([A-Z_a-z]+)=([^]*?)${proxyMarker}`, 'g');
                    let m: RegExpExecArray | null;
                    while ((m = proxyRe.exec(stdout)) !== null) {
                        const key = m[1] as typeof TERMINAL_PROXY_KEYS[number];
                        if (TERMINAL_PROXY_KEYS.includes(key)) {
                            captured[key] = m[2]; // empty string means "user has no value set"
                        }
                    }
                    detectedTerminalProxyEnv = captured;
                    const present = (Object.entries(captured) as Array<[string, string]>)
                        .filter(([_, v]) => v.length > 0)
                        .map(([k]) => k);
                    if (present.length > 0) {
                        console.log(`[shell] Detected terminal proxy env: ${present.join(', ')}`);
                    } else {
                        console.log('[shell] No terminal-shell proxy env detected (user has none)');
                    }
                } finally {
                    // Make sure we don't leave warmupInFlight dangling; future
                    // sync callers still work off the fallback even if detection
                    // produced nothing useful.
                    detectedUserPath = detectedUserPath ?? '';
                    // Empty-object fallback so getDetectedTerminalProxy() never
                    // returns null after warmup, distinguishing "not yet warmed"
                    // from "warmed, user has nothing".
                    detectedTerminalProxyEnv = detectedTerminalProxyEnv ?? {};
                    warmupInFlight = null;
                    resolve();
                }
            },
        );
    });
    return warmupInFlight;
}

/**
 * Return the proxy env vars detected from the user's interactive shell during
 * `warmupShellPath()` (issue #194).
 *
 * Return value semantics:
 *  - `null`: warmup hasn't run yet. Caller should treat as "no info".
 *  - `{}`: warmup ran but user has no proxy env set. Distinct from null —
 *     caller can safely strip ZhiShi-injected proxy vars from the subprocess
 *     env in this case (terminal-parity = unset).
 *  - `{ HTTP_PROXY: '…', … }`: real values to inject into subprocess env.
 *     Always check both upper- and lower-case keys when applying.
 */
export function getDetectedTerminalProxyEnv(): TerminalProxyEnv | null {
    return detectedTerminalProxyEnv;
}
