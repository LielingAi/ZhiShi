/**

 * Unified log retention policy for `~/.zhishi/logs/`.

 *

 * Single source of truth for retention across all log sources the Sidecar

 * writes. Replaces v0.2.7's split between `UnifiedLogger.cleanupOldUnifiedLogs`

 * (unified file cleanup) and `AgentLogger.cleanupOldLogs` (per-session

 * cleanup) — those duplicated the age-cutoff logic, applied different

 * (or absent) byte budgets, and ran independently on startup so behavior

 * across sources was incoherent.

 *

 * Sources covered here:

 *

 *   - `unified`  — `unified-{date}.log` plus rotated `unified-{date}.{ts}.log`.

 *                  Captures merged React/Node/Rust output. The actively-

 *                  writing file is protected by name (the only source where

 *                  this matters; sessions never collide on filename).

 *

 *   - `session`  — `{date}-{sessionId}.log`. Per-session AgentLogger output.

 *                  v0.2.7 had **no byte budget at all** for these — a power

 *                  user with hundreds of sessions could fill disk silently.

 *                  Now bounded.

 *

 * Crash logs (`~/.zhishi/logs/crash/*.log`) are managed in

 * `index.ts` with a count-based eviction (`CRASH_LOG_MAX_FILES = 20`)

 * and are intentionally NOT touched here — they're rare, valuable, and

 * each crash file is small.

 *

 * Policy per source (each independent):

 *

 *   - `maxAgeMs`   hard age ceiling — files older than this are deleted

 *                  regardless of any other consideration. The cheap

 *                  predictable retention.

 *

 *   - `maxBytes`   total byte budget for the source. When the source is

 *                  over budget, evict oldest-by-mtime files UNTIL EITHER

 *                  total falls below budget OR every remaining file is

 *                  inside the floor (see below).

 *

 *   - `floorMs`    protected recent window. Files modified within this

 *                  window are NEVER evicted by the byte budget, even if

 *                  total exceeds it. Fundamental safety: when a user is

 *                  actively debugging, the logs they need to see are

 *                  always there. The age cutoff still applies, but it's

 *                  much larger than the floor by design (`maxAgeMs >>

 *                  floorMs`).

 *

 *   - `protectActiveFile`  when true, the actively-writing file is also

 *                  protected from byte-budget eviction (race-defense:

 *                  rotation just renamed it, mtime might be older than

 *                  expected). Required for `unified`; not for `session`

 *                  (per-session has no single "active" path — many

 *                  sessions write concurrently — and they all fall

 *                  inside the floor anyway).

 *

 * The sweep is idempotent and safe to run any time. Sidecar runs it on

 * startup and on a 1-hour timer; this catches gradual growth without

 * waiting for a 50MB rotation event (the v0.2.7 trigger), and runs even

 * when the user is light enough that no rotation ever happens.

 *

 * Issue #121 (2026-05): the v0.2.7 split + missing per-session budget

 * meant a heavy user could lose recent unified logs to silent budget

 * eviction, while session logs grew without bound. Symptoms looked like

 * "the upgrade ate my logs" because eviction happened on the next

 * Sidecar startup after the upgrade. Unifying retention makes both

 * failure modes structurally impossible.

 */



import { readdirSync, statSync, unlinkSync } from 'fs';

import { join } from 'path';

import { LOGS_DIR, ensureLogsDir } from './logUtils';



const DAY_MS = 24 * 60 * 60 * 1000;

const GB = 1024 * 1024 * 1024;



interface SourcePolicy {

  /** Stable identifier used in audit logs and result objects. */

  readonly source: string;

  /** Returns true if this filename (basename, not full path) belongs to this source. */

  readonly matches: (filename: string) => boolean;

  /** Files older than this are unconditionally deleted. */

  readonly maxAgeMs: number;

  /** Files within this window are exempt from byte-budget eviction. */

  readonly floorMs: number;

  /** Total byte cap for this source. */

  readonly maxBytes: number;

  /**

   * Match a path against the activeFilePaths set. Defaults to false (session

   * logs); unified opts in because rotation can leave the writer transiently

   * looking like the oldest file by mtime.

   */

  readonly protectActiveFile: boolean;

}



const SOURCE_POLICIES: ReadonlyArray<SourcePolicy> = [

  {

    source: 'unified',

    matches: (f) => f.startsWith('unified-') && f.endsWith('.log'),

    maxAgeMs: 30 * DAY_MS,

    floorMs: 7 * DAY_MS,

    maxBytes: 5 * GB,

    protectActiveFile: true,

  },

  {

    source: 'session',

    // {YYYY-MM-DD}-{sessionId}.log — sessionId is uuid-ish, but the date

    // prefix is the only stable shape we can match on.

    matches: (f) => /^\d{4}-\d{2}-\d{2}-/.test(f) && f.endsWith('.log') && !f.startsWith('unified-'),

    maxAgeMs: 30 * DAY_MS,

    floorMs: 7 * DAY_MS,

    maxBytes: 2 * GB,

    // Code-review #124-followup (2026-05): a long-lived session whose log file

    // mtime drifts past the floor would be unlinked under the budget while

    // `AgentLogger`'s open WriteStream still pointed at it — broken writes

    // on Windows / macOS, ghost writes on Linux. Flip `protectActiveFile` on

    // and have callers pass the active log path in `activeFilePaths`.

    protectActiveFile: true,

  },

];



interface FileInfo {

  path: string;

  filename: string;

  mtimeMs: number;

  size: number;

}



export interface SourceSweepResult {

  source: string;

  scanned: number;

  ageDeleted: number;

  ageDeletedFiles: string[];

  budgetEvicted: number;

  budgetEvictedFiles: string[];

  bytesAfterAge: number;

  bytesAfterBudget: number;

  /**

   * Bytes still over budget after eviction completed (because everything left

   * was inside the floor). If non-zero, the warning has been emitted.

   */

  bytesOverBudgetAfterFloor: number;

}



export interface LogRetentionResult {

  sweptAt: string;

  durationMs: number;

  sources: SourceSweepResult[];

}



export interface SweepOptions {

  /**

   * Paths of files currently being actively written to. Sources whose

   * `protectActiveFile` is true will never evict files in this set, even

   * if their mtime appears oldest.

   */

  activeFilePaths?: ReadonlySet<string>;

  /**

   * Override the logs directory. Defaults to the project's LOGS_DIR

   * (`~/.zhishi/logs/`). Tests pass a scratch dir.

   */

  logsDir?: string;

  /**

   * Override "now" for deterministic tests. Defaults to Date.now().

   */

  now?: number;

}



/**

 * Run a full retention sweep across all sources.

 *

 * Idempotent. Catches its own errors per-file so one bad stat doesn't

 * abort the sweep. Returns per-source statistics so callers can audit

 * what happened.

 */

export function runLogRetentionSweep(opts: SweepOptions = {}): LogRetentionResult {

  const dir = opts.logsDir ?? LOGS_DIR;

  if (dir === LOGS_DIR) ensureLogsDir();

  const wallStart = Date.now();

  const refTime = opts.now ?? wallStart;

  const activePaths = opts.activeFilePaths ?? EMPTY_SET;



  let allFilenames: string[];

  try {

    allFilenames = readdirSync(dir);

  } catch (err) {

    // Directory walk failed entirely — best-effort; emit then return zeroed

    // per-source results so callers can iterate uniformly without special-

    // casing "did the sweep run at all".

    safeStderr(`[log-retention] readdir failed: ${(err as Error).message}`);

    allFilenames = [];

  }



  const sources: SourceSweepResult[] = [];



  for (const policy of SOURCE_POLICIES) {

    sources.push(sweepOneSource(policy, allFilenames, activePaths, refTime, dir));

  }



  return {

    sweptAt: new Date(refTime).toISOString(),

    durationMs: Date.now() - wallStart,

    sources,

  };

}



function sweepOneSource(

  policy: SourcePolicy,

  allFilenames: ReadonlyArray<string>,

  activePaths: ReadonlySet<string>,

  now: number,

  dir: string,

): SourceSweepResult {

  const result: SourceSweepResult = {

    source: policy.source,

    scanned: 0,

    ageDeleted: 0,

    ageDeletedFiles: [],

    budgetEvicted: 0,

    budgetEvictedFiles: [],

    bytesAfterAge: 0,

    bytesAfterBudget: 0,

    bytesOverBudgetAfterFloor: 0,

  };



  const files: FileInfo[] = [];

  for (const filename of allFilenames) {

    if (!policy.matches(filename)) continue;

    const path = join(dir, filename);

    try {

      const s = statSync(path);

      files.push({ path, filename, mtimeMs: s.mtimeMs, size: s.size });

    } catch {

      // skip — file may have been unlinked between readdir and stat

    }

  }

  result.scanned = files.length;



  // ── Step 1: age-based deletion ──

  const survivors: FileInfo[] = [];

  for (const f of files) {

    if (now - f.mtimeMs > policy.maxAgeMs) {

      try {

        unlinkSync(f.path);

        result.ageDeleted++;

        result.ageDeletedFiles.push(f.filename);

      } catch {

        survivors.push(f);

      }

    } else {

      survivors.push(f);

    }

  }

  result.bytesAfterAge = survivors.reduce((acc, f) => acc + f.size, 0);



  // ── Step 2: byte-budget eviction ──

  if (result.bytesAfterAge <= policy.maxBytes) {

    result.bytesAfterBudget = result.bytesAfterAge;

  } else {

    const floorCutoff = now - policy.floorMs;

    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

    let total = result.bytesAfterAge;



    for (const f of survivors) {

      if (total <= policy.maxBytes) break;

      if (policy.protectActiveFile && activePaths.has(f.path)) continue;

      if (f.mtimeMs >= floorCutoff) continue; // protected window

      try {

        unlinkSync(f.path);

        total -= f.size;

        result.budgetEvicted++;

        result.budgetEvictedFiles.push(f.filename);

      } catch {

        // skip

      }

    }

    result.bytesAfterBudget = total;

    if (total > policy.maxBytes) {

      result.bytesOverBudgetAfterFloor = total - policy.maxBytes;

    }

  }



  // ── Audit logging ──

  // Every non-trivial decision goes to stderr so a future "where did my logs

  // go" investigation finds the answer in the same unified log it would

  // search anyway. Direct stderr (not console.log) so this never recurses

  // back into the unified-log writer queue.

  if (result.ageDeleted > 0 || result.budgetEvicted > 0) {

    const parts: string[] = [];

    if (result.ageDeleted > 0) {

      parts.push(`age-deleted ${result.ageDeleted} (>${days(policy.maxAgeMs)}d)`);

    }

    if (result.budgetEvicted > 0) {

      parts.push(

        `budget-evicted ${result.budgetEvicted} ` +

        `(over ${gb(policy.maxBytes)}GB cap, oldest first; floor=${days(policy.floorMs)}d): ` +

        result.budgetEvictedFiles.join(', '),

      );

    }

    safeStderr(`[log-retention] ${policy.source}: ${parts.join('; ')}`);

  }



  if (result.bytesOverBudgetAfterFloor > 0) {

    safeStderr(

      `[log-retention] ${policy.source}: ${gb(result.bytesAfterBudget).toFixed(2)}GB ` +

      `exceeds ${gb(policy.maxBytes)}GB budget but every remaining file is within the ` +

      `${days(policy.floorMs)}-day retention floor; not evicting recent diagnostics. ` +

      `If this persists, raise the cap, narrow the floor, or compress old data.`,

    );

  }



  return result;

}



const EMPTY_SET: ReadonlySet<string> = new Set();



function safeStderr(line: string): void {

  try {

    process.stderr.write(line + '\n');

  } catch {

    /* ignore */

  }

}



function gb(bytes: number): number {

  return bytes / GB;

}



function days(ms: number): number {

  return Math.round(ms / DAY_MS);

}



// ── Periodic sweep ────────────────────────────────────────────────────────



/** Hourly. Frequent enough to bound surprises, cheap (just stat calls). */

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;



let sweepTimer: ReturnType<typeof setInterval> | null = null;



/**

 * Start a recurring background sweep in addition to whatever startup sweep

 * the caller runs synchronously. Idempotent — safe to call repeatedly.

 *

 * The provided `activeFilePaths` getter is invoked at each sweep, so it

 * reflects the current set of writers (e.g., today's unified file may be

 * different from yesterday's by the time the timer fires). The getter

 * should NOT do expensive work; it's called every hour.

 *

 * The timer is `unref`'d so it never blocks process exit.

 */

export function startPeriodicSweep(

  getActivePaths: () => ReadonlySet<string>,

): void {

  if (sweepTimer) return;

  sweepTimer = setInterval(() => {

    try {

      runLogRetentionSweep({ activeFilePaths: getActivePaths() });

    } catch (err) {

      safeStderr(`[log-retention] periodic sweep error: ${(err as Error).message}`);

    }

  }, SWEEP_INTERVAL_MS);

  if (typeof sweepTimer === 'object' && sweepTimer && 'unref' in sweepTimer) {

    (sweepTimer as { unref?: () => void }).unref?.();

  }

}



/** Test / shutdown helper. */

