import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';

import { join } from 'path';

import { getZhiShiDataDir } from './utils/app-dirs';

import { getRecentLogLines } from './UnifiedLogger';

// ============= CRASH DIAGNOSTICS =============

// Pattern 6 §6.3.6: crash logs live under ~/.zhishi/logs/crash/ (NOT tmpdir,

// so they're inside the unified log export bundle). Each crash gets its own

// file; we keep the most recent CRASH_LOG_MAX_FILES and evict oldest.

const CRASH_LOG_DIR = join(getZhiShiDataDir(), 'logs', 'crash');

const CRASH_LOG_MAX_FILES = 20;

// PRD #132 — hard cap on a single crash log file. The bug was: a recursive

// EPIPE loop appended ~50–200 KB per iteration and grew a single file to

// 95–105 GB. The recursion is fixed below by ignoring stdio EPIPE + a re-

// entry guard, but a hard ceiling stays as belt-and-suspenders so any

// future regression can't fill the user's disk again. 50 MB matches the

// per-file cap used by UnifiedLogger.

const CRASH_LOG_FILE_MAX_BYTES = 50 * 1024 * 1024;

// PRD #133 — total-bytes cap on the crash directory. CRASH_LOG_MAX_FILES

// alone bounds at file COUNT (~20 × 50 MB = 1 GB worst case); a user that

// hits 20 different short-lived sidecar crashes still loses 1 GB. 200 MB

// matches an order-of-magnitude budget for crash diagnostics across many

// process lifetimes.

const CRASH_LOG_DIR_MAX_BYTES = 200 * 1024 * 1024;

// PRD #133 — repeat-exception throttle. The first N times an error

// fingerprint (name + code + first stack line) appears in the rolling

// window, the full 200-line context dump goes through. After that we

// suppress the dump for the rest of the window — the per-file ceiling

// would also stop us eventually, but this preserves the ceiling budget

// for diverse errors that might actually help debug instead of burning

// it on 1000 copies of the same trace.

const CRASH_DEDUPE_WINDOW_MS = 60_000;

const CRASH_DEDUPE_DUMP_LIMIT = 3;

// Per-process crash log path: a single file per sidecar lifetime, holding all

// the lifecycle/error events for THIS process. The filename uses the start

// time so we can sort/evict by name. We append throughout the process.

const CRASH_LOG_FILE = (() => {

  try {

    if (!existsSync(CRASH_LOG_DIR)) {

      // Best-effort directory creation. recursive:true handles parent dirs.

      // Don't reach for ensureDirSync — this IIFE runs during module init

      // before some helper's transitive deps are guaranteed warm.

      mkdirSync(CRASH_LOG_DIR, { recursive: true });

    }

  } catch { /* fall through; later writes will retry */ }

  const ts = new Date().toISOString().replace(/[:]/g, '-');

  return join(CRASH_LOG_DIR, `${ts}.log`);

})();



// PRD #132 — ceiling tracker. We checkpoint file size every Nth append (not

// every append) so the ceiling check itself is cheap: an `appendFileSync`

// that already grew the file by 200 KB is fine, the *next* one will be

// blocked. ceilingHit is sticky for this process lifetime — once tripped we

// stop appending entirely so the file stays at its current size.

let crashLogCeilingHit = false;

let crashLogAppendCount = 0;



function evictOldCrashLogs(): void {

  try {

    if (!existsSync(CRASH_LOG_DIR)) return;

    const entries = readdirSync(CRASH_LOG_DIR)

      .filter(f => f.endsWith('.log'))

      .map(f => {

        const p = join(CRASH_LOG_DIR, f);

        try {

          const st = statSync(p);

          return { path: p, mtimeMs: st.mtimeMs, size: st.size };

        } catch {

          return null;

        }

      })

      .filter((x): x is { path: string; mtimeMs: number; size: number } => x !== null)

      .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first



    // Pass 1: file-count cap (PRD #132).

    for (const e of entries.slice(CRASH_LOG_MAX_FILES)) {

      try { unlinkSync(e.path); } catch { /* ignore */ }

    }



    // Pass 2: total-bytes cap (PRD #133). Walk newest→oldest summing sizes

    // until budget exceeded, then unlink the rest. Always keep the very

    // newest file (this process's own active crash log) so we don't kill

    // what we're still appending to.

    const survivors = entries.slice(0, CRASH_LOG_MAX_FILES);

    let runningTotal = 0;

    for (let i = 0; i < survivors.length; i++) {

      runningTotal += survivors[i].size;

      if (i > 0 && runningTotal > CRASH_LOG_DIR_MAX_BYTES) {

        // Drop everything from i onwards (oldest). Skip i=0 to protect the

        // active file even if it alone is over budget — the per-file

        // ceiling already caps that case at 50 MB.

        for (let j = i; j < survivors.length; j++) {

          try { unlinkSync(survivors[j].path); } catch { /* ignore */ }

        }

        break;

      }

    }

  } catch { /* ignore */ }

}



// PRD #133 — exception fingerprint table. Map<fingerprint, state>. We only

// use it for `dumpCrashContext` gating; the 1-line `crashLog` is cheap and

// doesn't need throttling beyond the ceiling.

const dumpFingerprints = new Map<string, { count: number; firstSeen: number; suppressed: boolean }>();



function fingerprintError(err: unknown): string {

  if (!err) return 'null';

  if (err instanceof Error) {

    const code = (err as NodeJS.ErrnoException).code ?? '';

    const stackHead = (err.stack ?? err.message ?? '').split('\n').slice(0, 2).join('|').slice(0, 200);

    return `${err.name}:${code}:${stackHead}`;

  }

  return String(err).slice(0, 200);

}



/** PRD #133 — should we run the 200-line context dump for this error?

 *  False once we've dumped ≥ N times for the same fingerprint within the

 *  rolling window. Independent counter per fingerprint; window resets on

 *  first sighting OR after expiry. */

function shouldDumpContextFor(err: unknown): boolean {

  const fp = fingerprintError(err);

  const now = Date.now();

  // Cheap GC: when the table grows beyond a sane size, drop expired entries.

  if (dumpFingerprints.size > 50) {

    for (const [k, v] of dumpFingerprints) {

      if (now - v.firstSeen > CRASH_DEDUPE_WINDOW_MS) dumpFingerprints.delete(k);

    }

  }

  const entry = dumpFingerprints.get(fp);

  if (!entry || (now - entry.firstSeen) > CRASH_DEDUPE_WINDOW_MS) {

    dumpFingerprints.set(fp, { count: 1, firstSeen: now, suppressed: false });

    return true;

  }

  entry.count++;

  if (entry.count <= CRASH_DEDUPE_DUMP_LIMIT) return true;

  if (!entry.suppressed) {

    entry.suppressed = true;

    // One-shot transition log so a future post-mortem sees the dedup kicked in.

    appendFileSyncSafely(`[${new Date().toISOString()}] SUPPRESS_CONTEXT fingerprint=${fp.slice(0, 100)} count=${entry.count} — further dumps for this fingerprint suppressed for the next ${CRASH_DEDUPE_WINDOW_MS / 1000}s\n`);

  }

  return false;

}



/** Internal helper: append a single line to the crash log file with the

 *  same ceiling discipline as `crashLog()`, without going through its

 *  arg-formatting path. Used by helpers that already have a formatted

 *  string to avoid re-shaping. */

function appendFileSyncSafely(line: string): void {

  if (crashLogCeilingHit) return;

  try { appendFileSync(CRASH_LOG_FILE, line); } catch { /* ignore */ }

}



/** PRD #132 + #133 — re-stat current crash file and trip the ceiling +

 *  evict if either single-file or directory budget is exceeded. Called

 *  after any append by `crashLog`/`dumpCrashContext` rather than left

 *  to `dumpCrashContext` alone (which the original code did, leaving

 *  `crashLog`-only sidecar lifecycles uncapped per Codex review). */

function checkCrashLogBudgets(): void {

  if (crashLogCeilingHit) return;

  try {

    const sz = statSync(CRASH_LOG_FILE).size;

    if (sz > CRASH_LOG_FILE_MAX_BYTES) {

      crashLogCeilingHit = true;

      try {

        appendFileSync(

          CRASH_LOG_FILE,

          `[${new Date().toISOString()}] CEILING_HIT crash log capped at ${CRASH_LOG_FILE_MAX_BYTES} bytes; further events suppressed for this sidecar lifetime\n`,

        );

      } catch { /* ignore */ }

    }

  } catch { /* stat failed — keep going */ }

  // Always run directory eviction, even when single file is under cap —

  // multi-process crash bursts could violate the dir budget independently.

  evictOldCrashLogs();

}



function crashLog(prefix: string, ...args: unknown[]) {

  if (crashLogCeilingHit) return;

  try {

    const msg = args.map(a => {

      if (a instanceof Error) return `${a.message}\n${a.stack}`;

      if (typeof a === 'object') return JSON.stringify(a);

      return String(a);

    }).join(' ');

    appendFileSync(CRASH_LOG_FILE, `[${new Date().toISOString()}] ${prefix} ${msg}\n`);

    // Budget check every 32 appends (cheap, but frequent enough that an

    // append that overshoots by a few KB is bounded). PRD #133 — also

    // run this for crashLog-only call paths (STDIO_CLOSED, EXIT,

    // BEFORE_EXIT, SIGTERM, EPIPE fast-path); previously these bypassed

    // eviction entirely because evictOldCrashLogs was only called from

    // dumpCrashContext, leaving short-lived sidecars to accumulate

    // unlimited .log files.

    if ((++crashLogAppendCount & 0x1f) === 0) {

      checkCrashLogBudgets();

    }

  } catch { /* ignore */ }

}



/**

 * On a hard crash (uncaughtException / unhandledRejection / fatal signal),

 * snapshot the last ~200 unified log lines into the crash file so post-mortem

 * has cross-process context, not just the bare error.

 *

 * PRD #133 — guarded by `shouldDumpContextFor(err)` so a recurring non-EPIPE

 * exception (e.g. a runtime/model misconfiguration that keeps re-throwing

 * the same error) doesn't burn the entire 50 MB single-file budget on 200

 * copies of the same trace. After writing, re-stat to trip the ceiling

 * immediately if a single oversized dump pushed us over (a 200-line sample

 * with rare jumbo log lines can be 10s of MB).

 */

function dumpCrashContext(reason: string, errForFingerprint?: unknown): void {

  if (crashLogCeilingHit) return;

  if (errForFingerprint !== undefined && !shouldDumpContextFor(errForFingerprint)) return;

  try {

    const lines = getRecentLogLines(200);

    if (lines.length === 0) return;

    const banner = `\n--- crash context (${reason}, last ${lines.length} unified lines) ---\n`;

    appendFileSync(CRASH_LOG_FILE, banner + lines.join('') + '--- end crash context ---\n');

    // Re-check budgets immediately after dump — a single jumbo dump can

    // shoot past the per-file ceiling on its own and would otherwise wait

    // for the next 32-append crashLog window to notice.

    checkCrashLogBudgets();

  } catch { /* ignore */ }

}


// PRD #132 — silence stdio EPIPE before it can become an uncaughtException.

//

// When Tauri kills the sidecar's stdout/stderr pipe but the sidecar keeps

// running (orphaned via SIGKILL of parent, helper sidecar outliving owner,

// dev-server reload not killing children cleanly), the next write fails

// with EPIPE. Without an 'error' listener Node turns the unhandled stream

// error into uncaughtException, which our handler responded to by calling

// console.error → another EPIPE → another uncaughtException → a recursive

// loop that wrote 50–200 KB to the crash log per iteration at SSD-bound

// rate, growing a single file to 95–105 GB in minutes (issue #132).

//

// Installing 'error' listeners that swallow EPIPE/EBADF/ENOTCONN cuts the

// loop at the source: the failed write resolves to a no-op instead of

// fanning out into the fault handler. Other stdio errors keep their

// existing behavior so we still notice non-pipe-closure faults. Once the

// stdio sink is broken we mark `stdioBroken` and the wrapper console below

// stops attempting to write to it — defense in depth against any code path

// that bypasses our listener.

let stdioBroken = false;

const STDIO_BENIGN_CLOSE_CODES = new Set(['EPIPE', 'EBADF', 'ENOTCONN', 'ECONNRESET']);

function onStdioError(stream: 'stdout' | 'stderr') {

  return (err: NodeJS.ErrnoException) => {

    if (STDIO_BENIGN_CLOSE_CODES.has(err.code ?? '')) {

      if (!stdioBroken) {

        stdioBroken = true;

        // Best-effort note in crash log; this MUST NOT call console.* (which

        // would re-enter the same broken pipe and re-trigger the loop).

        try {

          crashLog('STDIO_CLOSED', `${stream} ${err.code ?? 'unknown'} — disabling future stdio writes for this sidecar`);

        } catch { /* ignore */ }

      }

      return; // swallow

    }

    // Non-pipe-closure error — record once, do not propagate.

    try { crashLog('STDIO_ERROR', `${stream} ${err.code ?? ''} ${err.message ?? ''}`); } catch { /* ignore */ }

  };

}
export function isStdioBroken(): boolean { return stdioBroken; }

export function markStdioBroken(): void { stdioBroken = true; }


// PRD #132 — uncaughtException re-entry guard + EPIPE-aware short circuit.

//

// Even with the stdio listeners above, an in-flight async write may still

// emit an EPIPE that becomes uncaughtException (timing window between the

// write call and the listener being invoked). Two defenses:

//   1. Re-entry guard: if the handler is already running (sync or

//      promise-resumed), drop subsequent fires until it returns. Prevents

//      a deep stack of nested handlers from forming.

//   2. EPIPE fast path: skip dumpCrashContext (the 200-line dump is what

//      grew the file by 50–200 KB per iteration) and skip the console.error

//      "feedback" line (the original recursion seed). Just record one

//      bare line so post-mortem still sees we hit it.

let inUncaughtHandler = false;

function isStdioPipeError(e: unknown): boolean {

  if (!e || typeof e !== 'object') return false;

  const code = (e as NodeJS.ErrnoException).code;

  if (code && STDIO_BENIGN_CLOSE_CODES.has(code)) return true;

  const msg = (e as Error).message ?? '';

  return /\bwrite\s+(EPIPE|EBADF|ENOTCONN)\b/i.test(msg);

}


export function installCrashDiagnostics(): void {

// Top-level beacon: fires BEFORE main(), proves JS module loading succeeded

try { process.stderr.write(`[startup] module loaded, pid=${process.pid}\n`); } catch { /* ignore */ }


try { process.stdout.on('error', onStdioError('stdout')); } catch { /* ignore */ }

try { process.stderr.on('error', onStdioError('stderr')); } catch { /* ignore */ }


process.on('exit', (code) => {

  crashLog('EXIT', `code=${code}`);

});



process.on('beforeExit', (code) => {

  crashLog('BEFORE_EXIT', `code=${code}`);

});


process.on('uncaughtException', (err) => {

  if (inUncaughtHandler) {

    // Re-entry — drop. Recording even one line here would risk re-triggering.

    return;

  }

  inUncaughtHandler = true;

  try {

    if (isStdioPipeError(err)) {

      // Lightweight path: one line, no context dump, no console.error.

      // The stdio listeners above mark stdioBroken which makes the rest

      // of the process drop console writes anyway.

      crashLog('UNCAUGHT_EPIPE', err);

      stdioBroken = true;

      return;

    }

    crashLog('UNCAUGHT_EXCEPTION', err);

    dumpCrashContext('uncaughtException', err);

    if (!stdioBroken) {

      try { console.error('[process] uncaughtException:', err); } catch { /* ignore */ }

    }

  } finally {

    inUncaughtHandler = false;

  }

});



process.on('unhandledRejection', (reason) => {

  if (inUncaughtHandler) return;

  inUncaughtHandler = true;

  try {

    if (isStdioPipeError(reason)) {

      crashLog('UNHANDLED_REJECTION_EPIPE', reason);

      stdioBroken = true;

      return;

    }

    crashLog('UNHANDLED_REJECTION', reason);

    dumpCrashContext('unhandledRejection', reason);

    if (!stdioBroken) {

      try { console.error('[process] unhandledRejection:', reason); } catch { /* ignore */ }

    }

  } finally {

    inUncaughtHandler = false;

  }

});



process.on('SIGTERM', () => {

  crashLog('SIGNAL', 'SIGTERM');

  if (!stdioBroken) {

    try { console.log('[process] SIGTERM received, shutting down...'); } catch { /* ignore */ }

  }

  process.exit(0);  // Trigger SDK's process.on('exit') handler → SIGTERM CLI subprocess

});



process.on('SIGINT', () => {

  crashLog('SIGNAL', 'SIGINT');

  if (!stdioBroken) {

    try { console.log('[process] SIGINT received, shutting down...'); } catch { /* ignore */ }

  }

  process.exit(0);

});



crashLog('STARTUP', 'Server starting...');

}

// ============= END CRASH DIAGNOSTICS =============

