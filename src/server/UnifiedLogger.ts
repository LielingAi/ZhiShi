/**

 * UnifiedLogger — Pattern 6 (Buffered async writer + bounded logs).

 *

 * Persists merged React/Node/Rust logs to ~/.zhishi/logs/unified-{date}.log.

 *

 * Pattern 6 changes vs v0.1.x:

 *   - Replaced per-call sync writes (Audit F P2 finding — every entry used

 *     to open / write / close inline) with an in-memory queue drained by a

 *     100ms flusher. Bounded queue size; overflow bumps a drop counter

 *     that emits a single warning every 60s.

 *   - The flusher uses a single `openSync` + batched `writeSync` +

 *     `closeSync` per drain — far cheaper than per-entry sync write.

 *   - Per-file 50MB cap → rotate to `unified-<date>.<iso>.log`.

 *   - Directory budget + age retention live in `./log-retention.ts`

 *     (#121, 2026-05) so unified + per-session logs share one coherent

 *     policy. This module owns the active-write path (queue, flush,

 *     rotation) only.

 *   - Process exit / SIGINT / SIGTERM hook drains the queue using the

 *     same batched openSync/writeSync path, so we don't lose entries at

 *     shutdown without resorting to a per-entry sync write.

 *   - Exposes `getRecentLogLines(n)` for the crash dumper to capture

 *     last-N tail lines into the crash log bundle.

 *

 * Console.* callers are unaffected: `logger.ts::createAndBroadcast` still

 * calls `appendUnifiedLog(entry)` exactly as before.

 */



import {

  closeSync,

  existsSync,

  openSync,

  renameSync,

  statSync,

  writeSync,

} from 'fs';

import { join } from 'path';



import type { LogEntry } from '../shared/types/log';

import { LOGS_DIR, ensureLogsDir } from './logUtils';

import { localDate } from '../shared/logTime';

import { runLogRetentionSweep } from './log-retention';

import { getActiveSessionLogPath } from './AgentLogger';



// ── Tunables (Pattern 6 §6.3.5) ────────────────────────────────────────

const FLUSH_INTERVAL_MS = 100;

/** Hard cap on in-memory queue length. Overflow increments drop counter. */

const QUEUE_MAX_ENTRIES = 1000;

/** Per-file size cap before rotation. */

const PER_FILE_MAX_BYTES = 50 * 1024 * 1024; // 50MB

/** Drop-warning emit interval (only emits if dropped > 0 since last warn). */

const DROP_WARN_INTERVAL_MS = 60_000;

/** In-memory ring buffer for crash-log tail capture. */

const RECENT_LINES_CAPACITY = 200;

// Directory budget + retention floor live in `./log-retention.ts`. This

// module focuses on the active-write path (queue, flush, rotation); it

// hands off cleanup decisions to the unified retention sweep.



// ── State ───────────────────────────────────────────────────────────────

let currentDate: string | null = null;

let currentFilePath: string | null = null;

let currentFileSize = 0;



const queue: string[] = [];

let dropped = 0;

let lastDropWarnAt = 0;



let flushTimer: ReturnType<typeof setInterval> | null = null;

let exitHookInstalled = false;



/** Tail ring buffer for crash dumps (kept separate from the flush queue). */

const recentLines: string[] = [];



// ── Date / path resolution ─────────────────────────────────────────────

function getLogFilePath(): string {

  const today = localDate();

  if (currentDate !== today) {

    currentDate = today;

    currentFilePath = join(LOGS_DIR, `unified-${today}.log`);

    // Refresh size cache on day rollover.

    try {

      currentFileSize = existsSync(currentFilePath) ? statSync(currentFilePath).size : 0;

    } catch {

      currentFileSize = 0;

    }

  }

  return currentFilePath!;

}



// ── Formatting ─────────────────────────────────────────────────────────

// Map of internal discriminant → on-disk source label. The discriminant

// `'bun'` is kept as a discriminant for backward-compat parsing of pre-0.2.0

// unified-log files (see `LogSource` type in `shared/types/log.ts`), but

// from v0.2.0 the sidecar runs on Node.js and the on-disk log line MUST say

// `[NODE ]` — both to match reality and because greps in tech_docs already

// use `[NODE ]`. (See unified log line 92 comment for the intent.)

const SOURCE_LABEL: Record<string, string> = {

  bun: 'NODE',

};



function formatLogEntry(entry: LogEntry): string {

  const level = entry.level.toUpperCase().padEnd(5);

  const labeled = SOURCE_LABEL[entry.source] ?? entry.source.toUpperCase();

  const source = labeled.padEnd(5);

  // Correlation fields are emitted as a compact bracketed suffix when

  // present — keeps existing greps for `[NODE ] [INFO ]` working while

  // making `sessionId=...` filterable. Order is fixed (sessionId → turnId

  // → requestId → tabId → runtime → ownerId) so log diffs stay stable.

  const tags: string[] = [];

  if (entry.sessionId) tags.push(`sid=${entry.sessionId}`);

  if (entry.turnId) tags.push(`turn=${entry.turnId}`);

  if (entry.requestId) tags.push(`req=${entry.requestId}`);

  if (entry.tabId) tags.push(`tab=${entry.tabId}`);

  if (entry.runtime) tags.push(`rt=${entry.runtime}`);

  if (entry.ownerId) tags.push(`owner=${entry.ownerId}`);

  const tagSuffix = tags.length ? ` [${tags.join(' ')}]` : '';

  return `${entry.timestamp} [${source}] [${level}]${tagSuffix} ${entry.message}`;

}



// ── Rotation / eviction ────────────────────────────────────────────────

function rotateIfNeeded(addBytes: number): boolean {

  if (!currentFilePath) return false;

  if (currentFileSize + addBytes <= PER_FILE_MAX_BYTES) return false;

  // Rotate: rename current to <name>.<timestamp>.log

  try {

    const ts = new Date().toISOString().replace(/[:]/g, '-');

    const dot = currentFilePath.lastIndexOf('.');

    const rotatedPath =

      dot >= 0

        ? `${currentFilePath.slice(0, dot)}.${ts}${currentFilePath.slice(dot)}`

        : `${currentFilePath}.${ts}`;

    renameSync(currentFilePath, rotatedPath);

  } catch {

    // If rotation fails, fall through — we'll keep appending.

    return false;

  }

  currentFileSize = 0;

  return true;

}



/**

 * Returns the path of the file we're currently writing to (today's

 * unified-{date}.log). Used by `log-retention` so the budget sweep never

 * evicts the file we're holding open. Null until the first flush.

 */

export function getActiveUnifiedLogPath(): string | null {

  return currentFilePath;

}



/**

 * Returns ALL active log paths the budget sweep MUST not evict — currently

 * the unified log we're appending to plus the per-session log file (when

 * AgentLogger has one open). Used by `flushNow`'s on-rotation eager sweep

 * so we don't accidentally unlink the file we're holding a WriteStream for.

 */

function getProtectedActivePaths(): ReadonlySet<string> {

  const paths = new Set<string>();

  if (currentFilePath) paths.add(currentFilePath);

  const sessionPath = getActiveSessionLogPath();

  if (sessionPath) paths.add(sessionPath);

  return paths;

}



// ── Flusher ────────────────────────────────────────────────────────────

function rememberRecent(line: string): void {

  recentLines.push(line);

  if (recentLines.length > RECENT_LINES_CAPACITY) {

    recentLines.splice(0, recentLines.length - RECENT_LINES_CAPACITY);

  }

}



function flushNow(): void {

  if (queue.length === 0) return;

  // Drain the queue atomically — new pushes during write go to a fresh queue.

  let lines: string[] = queue.splice(0, queue.length);

  const payload = lines.join('');

  // payload is already newline-terminated per-line.

  let didRotate = false;

  try {

    ensureLogsDir();

    const filePath = getLogFilePath();

    didRotate = rotateIfNeeded(payload.length);

    // Use a single open/write/close per flush — far cheaper than per-entry

    // sync writes because we batch up to 1000 entries.

    const fd = openSync(filePath, 'a');

    try {

      writeSync(fd, payload);

    } finally {

      closeSync(fd);

    }

    currentFileSize += payload.length;

  } catch {

    // Re-queue on failure? No — that risks unbounded growth if the disk is

    // dead. Drop instead and let the warn timer surface it.

    dropped += lines.length;

    lines = [];

  }

  // Eager directory-budget enforcement when we just rotated. `rotateIfNeeded`

  // resets `currentFileSize` to 0 on rotation, so we MUST trigger off the

  // rotation event itself rather than checking the post-write size — checking

  // size would only fire on a single-flush > 50MB payload, which is essentially

  // never. Sweeps are stat-only and fast.

  if (didRotate) {

    runLogRetentionSweep({

      activeFilePaths: getProtectedActivePaths(),

    });

  }

}



function maybeWarnDrop(): void {

  if (dropped <= 0) return;

  const now = Date.now();

  if (now - lastDropWarnAt < DROP_WARN_INTERVAL_MS) return;

  lastDropWarnAt = now;

  // Use stderr directly so the warning itself can't recurse into the queue.

  try {

    process.stderr.write(`[UnifiedLogger] dropped ${dropped} log entries (queue saturated)\n`);

  } catch { /* ignore */ }

  dropped = 0;

}



function ensureFlusher(): void {

  if (flushTimer) return;

  flushTimer = setInterval(() => {

    flushNow();

    maybeWarnDrop();

  }, FLUSH_INTERVAL_MS);

  // Don't keep the event loop alive solely for the flusher.

  if (typeof flushTimer === 'object' && flushTimer && 'unref' in flushTimer) {

    (flushTimer as { unref?: () => void }).unref?.();

  }

  installExitHooks();

}



function installExitHooks(): void {

  if (exitHookInstalled) return;

  exitHookInstalled = true;

  const drain = () => {

    try {

      if (queue.length === 0) return;

      // Same batched open/write/close as the regular flusher path, just

      // run synchronously now because the process is exiting.

      const payload = queue.splice(0, queue.length).join('');

      ensureLogsDir();

      const fd = openSync(getLogFilePath(), 'a');

      try {

        writeSync(fd, payload);

      } finally {

        closeSync(fd);

      }

    } catch { /* best effort */ }

  };

  process.on('exit', drain);

  process.on('beforeExit', drain);

  process.once('SIGINT', () => { drain(); });

  process.once('SIGTERM', () => { drain(); });

}



// ── Public API ────────────────────────────────────────────────────────



/**

 * Append a log entry — non-blocking. Enqueues to an in-memory buffer

 * drained by the 100ms flusher. Drops on overflow with a counter.

 */

export function appendUnifiedLog(entry: LogEntry): void {

  const line = formatLogEntry(entry) + '\n';

  rememberRecent(line);

  if (queue.length >= QUEUE_MAX_ENTRIES) {

    dropped++;

    return;

  }

  queue.push(line);

  ensureFlusher();

}



/**

 * Append multiple log entries (batch enqueue). Same overflow semantics.

 */

export function appendUnifiedLogBatch(entries: LogEntry[]): void {

  if (entries.length === 0) return;

  for (const entry of entries) {

    const line = formatLogEntry(entry) + '\n';

    rememberRecent(line);

    if (queue.length >= QUEUE_MAX_ENTRIES) {

      dropped++;

      continue;

    }

    queue.push(line);

  }

  ensureFlusher();

}



/**

 * Internal-test hook: drain the queue synchronously. Tests use this to

 * avoid waiting on the 100ms timer.

 */

export function _flushUnifiedLogForTests(): void {

  flushNow();

}



/**

 * Drop counter accessor for tests / diagnostics. Resets to 0 once read by

 * the warn timer; tests should call before that fires.

 */

export function _getDroppedCount(): number {

  return dropped;

}



/**

 * Last-N tail lines (already newline-terminated). Used by the crash dumper

 * (`index.ts::writeCrashLog`) to embed recent unified context in the crash

 * bundle. Capacity is fixed at RECENT_LINES_CAPACITY.

 */

export function getRecentLogLines(n: number = RECENT_LINES_CAPACITY): string[] {

  if (n >= recentLines.length) return recentLines.slice();

  return recentLines.slice(recentLines.length - n);

}

