import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, unlinkSync, writeFileSync , rmSync, renameSync } from 'fs';

import { copyFile as copyFileAsync, readdir as readdirAsync, rm, stat } from 'fs/promises';

import { spawn as subprocessSpawn } from './utils/subprocess';

import { fileResponse, sniffMime } from './utils/file-response';

import { getToolAttachmentRoot, validateExternalReadPathNode } from './utils/path-safety';

import { serve as honoServe } from '@hono/node-server';

import { createWriteStream } from 'node:fs';

import { pipeline } from 'node:stream/promises';

import { Readable } from 'node:stream';



/**

 * Hard upper bound on a single multipart request body (aggregate of all files

 * + text fields). Sidecar lives on 127.0.0.1 so the threat model is mostly

 * local WebView / same-machine callers, but we still gate to prevent runaway

 * uploads from OOM-ing the Node.js heap. Node's standard `Request.formData()`

 * buffers the entire body before resolving — there is no streaming multipart

 * parser in the Web API — so this cap must be enforced via Content-Length

 * BEFORE calling `.formData()`.

 */

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB



/**

 * Check request Content-Length against MAX_UPLOAD_BYTES.

 * Returns a 413 Response to hand back, or null when within budget.

 * Missing Content-Length is treated as unknown — we still allow `.formData()`

 * to run, but callers should prefer Content-Length-aware clients.

 */

function rejectIfOversizedUpload(request: Request): Response | null {

  const lenHeader = request.headers.get('content-length');

  if (!lenHeader) return null;

  const len = Number(lenHeader);

  if (Number.isFinite(len) && len > MAX_UPLOAD_BYTES) {

    return jsonResponse(

      { error: `Upload too large (${len} bytes > ${MAX_UPLOAD_BYTES} limit).` },

      413,

    );

  }

  return null;

}



/**

 * Write an incoming Web `File` (multipart upload) to disk via streaming.

 *

 * NOTE: Node's `Request.formData()` already buffers the full body before

 * resolving the FormData — `file.stream()` here is reading from an

 * in-memory Blob, not from the live socket. The pipeline-to-disk still

 * helps by avoiding an extra `arrayBuffer() + Buffer.from()` copy, but

 * it does NOT bound memory during the parse itself. That bound is

 * enforced by `rejectIfOversizedUpload()` at the route edge.

 *

 * On error mid-pipeline, the partially-written destination is removed so

 * callers don't observe half-files on disk.

 */

async function streamUploadToFile(file: File, destination: string): Promise<void> {

  const webStream = file.stream() as unknown as ReadableStream<Uint8Array>;

  const nodeReadable = Readable.fromWeb(webStream as unknown as import('node:stream/web').ReadableStream<Uint8Array>);

  try {

    await pipeline(nodeReadable, createWriteStream(destination));

  } catch (err) {

    await rm(destination, { force: true }).catch(() => { /* best-effort cleanup */ });

    throw err;

  }

}

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';

import { tmpdir } from 'os';

import { getZhiShiDataDir } from './utils/app-dirs';

import { randomUUID } from 'crypto';

import { elapsedMs, emitPerfTrace, nowMs } from './utils/perf-trace';

// adm-zip lazy-loaded at its call site below — saves ~30ms of module-init

// cost when the feature is never used.

import {

  extractCommandName,

  parseFullSkillContent,

  parseFullCommandContent,

  serializeSkillContent,

  serializeCommandContent,

  type SkillFrontmatter,

  type CommandFrontmatter

} from '../shared/slashCommands';

import { sanitizeFolderName, isWindowsReservedName } from '../shared/utils';

import { parseAgentFrontmatter, parseFullAgentContent, serializeAgentContent } from '../shared/agentCommands';

import { scanAgents, readWorkspaceConfig, writeWorkspaceConfig, loadEnabledAgents, readAgentMeta, writeAgentMeta, findAgent } from './agents/agent-loader';

import type { AgentFrontmatter, AgentMeta, AgentWorkspaceConfig } from '../shared/agentTypes';

import type { McpServerDefinition, BackgroundAgentPermissionMode } from '../shared/config-types';

import { ensureDirSync, ensureDir } from './utils/fs-utils';

import {

  setCronTaskContext,

  clearCronTaskContext,

  CRON_TASK_COMPLETE_PATTERN,

} from './tools/cron-tools';

// admin-api module (~2900 lines, depends on zod + full config/session/cron surface)

// is lazy-loaded on first /api/admin/* hit to shave ~150ms off sidecar cold

// start. All handlers are only used inside routeAdminApi() below.

type AdminApiModule = typeof import('./admin-api');

let _adminApi: Promise<AdminApiModule> | null = null;

const getAdminApi = (): Promise<AdminApiModule> => (_adminApi ??= import('./admin-api'));

import { getBuiltinMcpInstance } from './tools/builtin-mcp-registry';

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



// Top-level beacon: fires BEFORE main(), proves JS module loading succeeded

try { process.stderr.write(`[startup] module loaded, pid=${process.pid}\n`); } catch { /* ignore */ }



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

try { process.stdout.on('error', onStdioError('stdout')); } catch { /* ignore */ }

try { process.stderr.on('error', onStdioError('stderr')); } catch { /* ignore */ }

export function isStdioBroken(): boolean { return stdioBroken; }

export function markStdioBroken(): void { stdioBroken = true; }



process.on('exit', (code) => {

  crashLog('EXIT', `code=${code}`);

});



process.on('beforeExit', (code) => {

  crashLog('BEFORE_EXIT', `code=${code}`);

});



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

// ============= END CRASH DIAGNOSTICS =============



import {

  getSessionId,

  initializeAgent,

  setMcpServers,

  getMcpServers,

  getCurrentMcpServers,

  applyMcpOverrideAndAwaitReady,

  withCronDispatchLock,

  setAgents,

  setSessionModel,

  setInteractionScenario,

  resetInteractionScenario,

  setSidecarPort,

  getSessionModel,

  syncProjectUserConfig,

  setProxyConfig,

  initSocksBridgeFromEnv,

  getHistoricalSessionMessages,

  type ProviderEnv,

} from './agent-session';

import { getHomeDirOrNull, isSkillBlockedOnPlatform } from './utils/platform';

import { getScriptDir } from './utils/runtime';

import {

  createSession,

  deleteSession,

  getAllSessionMetadata,

  getSessionData,

  getSessionMetadata,

  getSessionsByAgentDir,

  updateSessionMetadata,

  getAttachmentPath,

  isDesktopSessionSource,

} from './SessionStore';

import { atomicModifyConfig, decodeProviderEnvSnapshot, findAgentByWorkspacePath, findProvider, getAllEffectiveProviders, getAllMcpServers, getEffectiveMcpServers, isProviderDisabled, loadConfig, resolveProviderEnv } from './utils/admin-config';

import { snapshotForOwnedSession } from './utils/session-snapshot';

import { resolveSessionConfig } from './utils/resolve-session-config';

import { resolveLastRealUserMessagePreview, shrinkSessionMessagesForClient } from './utils/session-message-preview';

import type { AgentConfig } from '../shared/types/agent';

import type { SessionMetadata } from './types/session';

import { initLogger, getLoggerDiagnostics, withLogContext, setStdioBrokenProbe } from './logger';

// `isStdioBroken` / `markStdioBroken` are defined above (in the crash-

// diagnostics block) and consumed by `setStdioBrokenProbe` below to wire

// the logger's safe-write wrapper to the stdio-state bit.

import {

  buildGateResponseBody,

  buildReadyResponseBody,

  markDeferredInitFailed,

  markDeferredInitReady,

  setDeferredInitPhase,

} from './readiness-state';

import { appendUnifiedLogBatch, getRecentLogLines, getActiveUnifiedLogPath } from './UnifiedLogger';

import { getActiveSessionLogPath } from './AgentLogger';

import { runLogRetentionSweep, startPeriodicSweep } from './log-retention';

import { createSseClient, getClients } from './sse';

import {

  isPiEngine,

  initPiChatEngine,

  sendPiChatMessage,

  queuePiChatMessage,

  stopPiChat,

  resetPiChat,

  rewindPiChat,
  forkPiChat,

  cancelPiQueueItem,

  forcePiQueueItem,

  getPiQueueStatus,

  switchPiSession,

  sendPiChatMessageAndWait,

  getPiAgentState,

  getPiMessages,

  getPiStreamingAssistantId,

  getPiSystemInitInfo,

  getPiLogLines,

} from './loop/chat-engine';

import { pendingBoundaryAsks, respondBoundaryAsk } from './loop/boundary-ask';

import { resolveBundledDir } from './domains/manifest';

import { defaultRecipesRoot } from './environment/recipes';



import { verifyProviderViaSdk } from './provider-verify';

// M4c: openai-bridge 已删除(OpenAI 协议 provider 由 pi 原生直连)。

// M4c: bridge-cache 随 bridge 删除。
import { isDistillArcPrompt } from './memory/distill';
import { isResearchDistillArcPrompt } from './memory/distill-research';

// title-generator is dynamically imported in the /api/title-generate handler

// below — it value-imports the Claude Agent SDK, which is large. Pulling

// that into the Tier 0

// startup graph delayed `/health` bind on cold start (cf. v0.2.0 Tier 0

// goals) and crashed the sidecar before it could serve a 503 if the SDK

// native binary failed to load. The handler is in the post-bind path, so

// dynamic-import there is free.

import { installAutoTitleHook } from './session-title-service';

import type { ImagePayload } from '../shared/types/image';

import { VALID_RUNTIMES, resolveCronPermissionMode } from '../shared/types/runtime';

import type { RuntimeConfig, RuntimeType } from '../shared/types/runtime';



type PermissionMode = 'auto' | 'plan' | 'fullAgency' | 'custom';



/**

 * Runtime download URLs for common MCP commands

 */

const RUNTIME_DOWNLOAD_URLS: Record<string, { name: string; url: string }> = {

  'node': { name: 'Node.js', url: 'https://nodejs.org/' },

  'npx': { name: 'Node.js', url: 'https://nodejs.org/' },

  'npm': { name: 'Node.js', url: 'https://nodejs.org/' },

  'python': { name: 'Python', url: 'https://www.python.org/downloads/' },

  'python3': { name: 'Python', url: 'https://www.python.org/downloads/' },

  'deno': { name: 'Deno', url: 'https://deno.land/' },

  'uv': { name: 'uv (Python 包管理器)', url: 'https://docs.astral.sh/uv/' },

  'uvx': { name: 'uv (Python 包管理器)', url: 'https://docs.astral.sh/uv/' },

};



/**

 * Get download info for a command

 */

function getCommandDownloadInfo(command: string): { runtimeName?: string; downloadUrl?: string } {

  const info = RUNTIME_DOWNLOAD_URLS[command];

  if (info) {

    return { runtimeName: info.name, downloadUrl: info.url };

  }

  return {};

}



type SendMessagePayload = {

  text?: string;

  images?: ImagePayload[];

  permissionMode?: PermissionMode;

  // Background-agent permission policy (#264). Global app-config value the

  // renderer echoes per-send (idempotent setter); controls the builtin

  // PermissionRequest hook for run_in_background sub-agents.

  backgroundAgentPermissionMode?: BackgroundAgentPermissionMode;

  runtimeConfig?: RuntimeConfig;

  model?: string;

  // undefined/missing = "keep current provider" (safe default for IM/Cron callers)

  // object = use this specific provider

  providerEnv?: {

    baseUrl?: string;

    apiKey?: string;

    authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';

    apiProtocol?: 'anthropic' | 'openai';

    maxOutputTokens?: number;

    maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';

    upstreamFormat?: 'chat_completions' | 'responses';

  };

  // W1(design-spec §6.4)— @ 引用:additive 可选数组,服务端经 env 通道解析
  // 成 grounding 段前置进 prompt(契约不变,旧客户端不传即可)。
  refs?: unknown[];

};




/**

 * #264 — Self-resolve the background-agent permission policy from disk for the

 * IM / Cron lanes. Desktop sends carry it in the chat payload (frontend is the

 * authority), but IM/Cron turns have no such payload, so per CLAUDE.md's

 * "Tab 由前端配, IM/Cron self-resolve 从磁盘读" split they read `config.json`

 * directly. Idempotent; defaults to the conservative 'inherit' on any read

 * error so a missing/corrupt config never widens the background lane.

 */

// M4c: background-agent 权限策略随 permission 体系删除(pi 引擎界内全自动)。



/**

 * PRD 0.2.9: live-resolve a per-task `providerId` into the value

 * `enqueueUserMessage` expects:

 *

 *   - api-type provider with apiKey      → ProviderEnv object

 *   - provider missing / api-type w/o key → throws (caller surfaces 400)

 */

function resolveCronProviderRouting(providerId: string): ProviderEnv {

  const provider = findProvider(providerId);

  if (!provider) {

    throw new Error(

      `Provider '${providerId}' not found in config — task references a provider that has been deleted. Re-select a provider in 任务编辑 → 高级配置.`,

    );

  }

  if (isProviderDisabled(providerId)) {

    throw new Error(

      `Provider '${providerId}' is disabled — re-enable it in 设置 → 模型供应商 → 启用和排序, or re-select a provider in 任务编辑 → 高级配置.`,

    );

  }

  const env = resolveProviderEnv(providerId);

  if (!env) {

    // Provider exists but has no apiKey configured.

    throw new Error(

      `Provider '${providerId}' has no API Key — open 设置 → 模型供应商 to configure it, or re-select a provider in 任务编辑 → 高级配置.`,

    );

  }

  return env;

}



// Cron task execution payload

type CronExecutePayload = {

  taskId: string;

  prompt: string;

  /** Session ID for single_session mode (reuse existing session) */

  sessionId?: string;

  isFirstExecution?: boolean;

  aiCanExit?: boolean;

  permissionMode?: PermissionMode;

  runtime?: RuntimeType;

  runtimeConfig?: RuntimeConfig;

  model?: string;

  providerEnv?: {

    baseUrl?: string;

    apiKey?: string;

    authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';

    apiProtocol?: 'anthropic' | 'openai';

    maxOutputTokens?: number;

    maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';

    upstreamFormat?: 'chat_completions' | 'responses';

  };

  /**

   * PRD 0.2.9: per-task provider id. When set, sidecar live-resolves the

   * provider env via `resolveProviderEnv(providerId)` at each tick — this

   * keeps API key rotation / provider switches in sync without

   * persisting credentials in the cron task. Mutually exclusive with

   * `providerEnv` (legacy explicit-snapshot path).

   *

   * Resolution outcomes:

   *   - provider not found / api-type with no apiKey → 400 (refuse to run,

   *     caller marks Task as Blocked)

   *   - api provider → effectiveProviderEnv = ResolvedProviderEnv object

   */

  providerId?: string;

  /**

   * PRD #119 / 0.2.9: explicit routing intent. Controls how the handler

   * resolves effective model + providerEnv when `providerId` is absent:

   *   - `'followAgent'` (default if absent) — snapshot-based, follows agent

   *   - `'explicit'`     — force `effectiveProviderEnv = payload.providerEnv`

   * Mirrors Rust's `cron_task::ProviderIntent`. New code prefers `providerId`.

   */

  providerIntent?: 'followAgent' | 'explicit';

  /**

   * Per-task MCP enable list override (PRD 0.2.4 §需求 4).

   * `undefined` = follow workspace MCP (`config.agents[].mcpEnabledServers`).

   * `[id, id, ...]` = enable only these MCP server ids for this task.

   * Sidecar applies via `setMcpServers()` before `enqueueUserMessage`.

   */

  mcpEnabledServers?: string[];

  /** Run mode: "single_session" (keep context) or "new_session" (fresh each time) */

  runMode?: 'single_session' | 'new_session';

  /** Task execution interval in minutes (for System Prompt context) */

  intervalMinutes?: number;

  /** Current execution number, 1-based (for System Prompt context) */

  executionNumber?: number;

};



function parseArgs(argv: string[]): { agentDir: string; initialPrompt?: string; port: number; sessionId?: string } {

  const args = argv.slice(2);

  const getArgValue = (flag: string) => {

    const index = args.indexOf(flag);

    if (index === -1) {

      return null;

    }

    return args[index + 1] ?? null;

  };



  const agentDir = getArgValue('--agent-dir') ?? '';

  const initialPrompt = getArgValue('--prompt') ?? undefined;

  const port = Number(getArgValue('--port') ?? 3000);

  const sessionId = getArgValue('--session-id') ?? undefined;



  if (!agentDir) {

    throw new Error('Missing required argument: --agent-dir <path>');

  }



  return { agentDir, initialPrompt, port: Number.isNaN(port) ? 3000 : port, sessionId };

}



/**

 * Expand ~ to user's home directory

 */

function expandTilde(path: string): string {

  if (path.startsWith('~/') || path === '~') {

    const homeDir = getHomeDirOrNull() || '';

    return path.replace(/^~/, homeDir);

  }

  return path;

}



async function ensureAgentDir(dir: string): Promise<string> {

  const expanded = expandTilde(dir);

  const resolved = resolve(expanded);

  if (!existsSync(resolved)) {

    await ensureDir(resolved);

  }

  const info = await stat(resolved);

  if (!info.isDirectory()) {

    throw new Error(`Agent directory is not a directory: ${resolved}`);

  }

  return resolved;

}



// ============= SKILLS CONFIG & SEED =============



interface SkillsConfig {

  seeded: string[];

  disabled: string[];

  generation: number;  // Monotonic counter — incremented on every skill CRUD operation

}



function getSkillsConfigPath(): string {

  return join(getZhiShiDataDir(), 'skills-config.json');

}



function readSkillsConfig(): SkillsConfig {

  const configPath = getSkillsConfigPath();

  const defaults: SkillsConfig = { seeded: [], disabled: [], generation: 0 };

  try {

    if (existsSync(configPath)) {

      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));

      return {

        seeded: Array.isArray(raw?.seeded) ? raw.seeded : defaults.seeded,

        disabled: Array.isArray(raw?.disabled) ? raw.disabled : defaults.disabled,

        generation: typeof raw?.generation === 'number' ? raw.generation : 0,

      };

    }

  } catch (err) {

    console.warn('[skills-config] Error reading config:', err);

  }

  return defaults;

}



function writeSkillsConfig(config: SkillsConfig): void {

  const configPath = getSkillsConfigPath();

  try {

    const dir = dirname(configPath);

    ensureDirSync(dir);

    // Auto-increment generation on every write — signals Tab Sidecars to re-sync symlinks

    config.generation = (config.generation || 0) + 1;

    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  } catch (err) {

    console.error('[skills-config] Error writing config:', err);

  }

}



/**

 * Bump skills generation counter without changing seeded/disabled lists.

 * Called after skill CRUD operations (create/update/delete/upload/import)

 * that don't go through writeSkillsConfig but DO change the available skill set.

 * Tab Sidecars detect this change and re-sync symlinks on next /api/commands fetch.

 */

function bumpSkillsGeneration(): void {

  const config = readSkillsConfig();

  writeSkillsConfig(config);

}



/**

 * Lazy skill sync: Track the last generation we synced to avoid redundant sync work.

 * When a Tab Sidecar's /api/commands is called, we compare the current

 * generation in skills-config.json against this value. Only if they differ do we run

 * syncProjectUserConfig(). This covers the case where the Global Sidecar modified

 * global skills (create/toggle/delete) without the Tab Sidecar knowing.

 */

// Phase E (PRD 0.2.7): the `syncSkillsIfNeeded` wrapper + generation-tracking

// optimization is gone. Rust `cmd_list_slash_commands` is the canonical UI

// path and runs `sync_workspace_skills` (idempotent) every call. The sidecar

// only syncs as a side-effect of skill/command CRUD via direct

// `syncProjectUserConfig(...)` calls; CRUD-time correctness is what matters

// (the picker UI lives in Rust now). `markSkillsSynced` is also gone — there's

// no longer a generation-cached fast-path to invalidate.



/**

 * Resolve bundled-skills directory.

 * - Production (macOS): Contents/Resources/bundled-skills/

 * - Production (Windows): <install-dir>/bundled-skills/

 * - Development: <project-root>/bundled-skills/

 */

function resolveBundledSkillsDir(): string | null {

  const scriptDir = getScriptDir();



  // Production: bundled-skills is alongside server-dist.js in Resources

  const prodPath = resolve(scriptDir, 'bundled-skills');

  if (existsSync(prodPath)) return prodPath;



  // Development: bundled-skills is at project root

  // In dev, scriptDir is something like <project>/src/server/utils

  // Walk up to find bundled-skills at project root

  let dir = scriptDir;

  for (let i = 0; i < 5; i++) {

    const devPath = resolve(dir, 'bundled-skills');

    if (existsSync(devPath)) return devPath;

    dir = dirname(dir);

  }



  return null;

}



/**

 * System skills — owned by the app, version-gated by the Rust side

 * (`SYSTEM_SKILLS` + `SYSTEM_SKILLS_VERSION` in `src-tauri/src/commands.rs`).

 * These are skipped by `seedBundledSkills` below because their lifecycle

 * is "force-overwrite on every version bump", not "seed once then leave

 * alone". Keep this list in sync with the Rust constant — a mismatch

 * would either double-seed (harmless but confusing logs) or skip a

 * genuine user skill named identically.

 */

const SYSTEM_SKILLS: readonly string[] = [

  'task-alignment',

  'task-implement',

  // v10: ultra-research removed — not generic enough.

  'download-anything',

  // v8: see commands.rs::SYSTEM_SKILLS — agent-browser promoted to system

  // skill so existing users get the updated command-local npm self-install

  // SKILL.md after the bundled CLI is removed.

  'agent-browser',

  // v9: zhishi-cli — global skill that exposes the entire `zhishi`

  // CLI surface (cron / task / mcp / model / agent / runtime / skill /

  // widget / im / config) to every AI session in the product.

  // Force-synced because SKILL.md must track CLI changes in lockstep.

  'zhishi-cli',

  // v19: app-automation — AppCraft（PRD 0.2.36）录制→沉淀→回放→自愈工作流，
  // 与 zhishi appcraft CLI / trace schema 同步演进，须强制覆盖。

  'app-automation',

  // v29: capability-forge 与通用生产力 skills 随安全研究员版减法删除，

  // 见 commands.rs::SYSTEM_SKILLS。

  // v30: 安全研究员版 P1 S2 —— 首批 4 个安全方法 skills（native-code-loop /

  // binary-exploit / vuln-triage / range-ops），见 commands.rs::SYSTEM_SKILLS。

  'native-code-loop',

  'binary-exploit',

  'vuln-triage',

  'range-ops',

];



/**

 * Seed bundled skills to ~/.zhishi/skills/ on first launch.

 * Only copies skills that haven't been seeded before (tracked in skills-config.json).

 *

 * System skills (SYSTEM_SKILLS above) are owned by Rust's

 * `cmd_sync_system_skills` and are skipped here — they need the

 * version-gated force-overwrite path, not the seed-once-then-hands-off

 * path. If we seeded them here AND Rust overwrote them, the interaction

 * would be harmless (Rust always wins, ordering-wise) but we'd log a

 * "skipped existing folder" every boot, and the `config.seeded` array

 * would grow stale entries users don't recognise.

 */

/**
 * Dev-side recipe seeding: Rust 宿主负责把 bundled-environments 播种到
 * ~/.zhishi/environments(ENVIRONMENT_RECIPES_VERSION 版本门控),但裸
 * sidecar 开发态没有 Rust——新增配方(code-audit)永远不会落盘。这里做
 * 「缺 id 补种」:已存在的配方目录绝不动(用户改过的配方不覆盖),只补
 * 目标目录里没有的 bundled 配方。
 */
function seedEnvironmentRecipes(): void {
  try {
    const bundledDir = resolveBundledDir('bundled-environments');
    if (!bundledDir) return;
    const root = defaultRecipesRoot();
    ensureDirSync(root);
    for (const entry of readdirSync(bundledDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = join(bundledDir, entry.name);
      const dst = join(root, entry.name);
      if (existsSync(dst)) continue; // 已存在(含用户改过的)不动
      cpSync(src, dst, { recursive: true });
      console.log(`[seed] recipe seeded: ${entry.name}`);
    }
  } catch (err) {
    console.warn('[seed] environment recipes seeding failed (non-fatal):', err);
  }
}

function seedBundledSkills(): void {

  try {

    const bundledDir = resolveBundledSkillsDir();

    if (!bundledDir) {

      console.log('[seed] Bundled skills directory not found, skipping seed');

      return;

    }



    const config = readSkillsConfig();

    const userSkillsDir = join(getZhiShiDataDir(), 'skills');



    ensureDirSync(userSkillsDir);



    const bundledFolders = readdirSync(bundledDir, { withFileTypes: true })

      .filter(d => d.isDirectory())

      .map(d => d.name);



    let changed = false;

    for (const folder of bundledFolders) {

      if (SYSTEM_SKILLS.includes(folder)) {

        // Owned by Rust version gate — skip silently.

        continue;

      }

      if (isSkillBlockedOnPlatform(folder)) {

        console.log(`[seed] Skipping ${folder} on ${process.platform} (platform blocked)`);

        continue;

      }

      const dst = join(userSkillsDir, folder);



      // Detect broken symlinks at dst BEFORE any operation that resolves the

      // path. Node v24's cpSync C++ implementation calls

      // `std::filesystem::equivalent(src, dst)` for src/dst equality

      // detection; on a broken symlink that throws an uncaught C++ exception

      // (`libc++abi: ... filesystem error: in equivalent: Operation not

      // supported`) which terminates the entire sidecar — JS try/catch

      // cannot intercept it. existsSync follows the link and returns false,

      // hiding the symlink from every guard below, so we must lstat first.

      // Repro: `node -e 'fs.cpSync("/tmp/src", "/tmp/dangling", {recursive:true})'`

      // where /tmp/dangling -> /nonexistent. Reported as user crash on v0.2.5

      // (~/.zhishi/skills/docx pointed at a deleted target).

      let dstLstat: ReturnType<typeof lstatSync> | null = null;

      try {

        dstLstat = lstatSync(dst);

      } catch {

        // dst doesn't exist — fall through to seed path

      }

      const dstExists = existsSync(dst); // follows symlinks

      const isBrokenSymlink = dstLstat?.isSymbolicLink() && !dstExists;



      if (isBrokenSymlink) {

        try {

          unlinkSync(dst);

          console.warn(`[seed] Removed broken symlink at ${dst} so the bundled skill can seed`);

        } catch (err) {

          console.warn(`[seed] Failed to remove broken symlink ${dst}, skipping:`, err);

          continue;

        }

      }



      // Re-seed if marked as seeded but directory was deleted (or was a broken symlink we just cleared)

      if (config.seeded.includes(folder) && dstExists) continue;



      const src = join(bundledDir, folder);

      // Packaging guard (issue #321, mirrors Rust cmd_sync_system_skills):

      // only treat a bundled folder as a seedable skill if it carries a

      // SKILL.md. An empty / SKILL.md-less source dir is a packaging defect —

      // seeding it would copy an empty directory that every SKILL.md-gated

      // scanner (Settings panel, slash picker, SDK runtime) ignores, and

      // marking it `seeded` would freeze that broken state so a corrected

      // bundle never re-seeds. Skip without marking seeded → retries next launch.

      if (!existsSync(join(src, 'SKILL.md'))) {

        console.warn(`[seed] Bundled skill incomplete (no SKILL.md), skipping: ${folder}`);

        continue;

      }

      // Skip if destination already exists (don't overwrite user's custom content)

      if (dstExists) {

        config.seeded.push(folder);

        changed = true;

        console.log(`[seed] Skipped existing folder: ${folder}`);

        continue;

      }

      try {

        cpSync(src, dst, { recursive: true });

        console.log(`[seed] Seeded skill: ${folder}`);

      } catch (err) {

        console.warn(`[seed] Failed to seed skill ${folder}:`, err);

        continue;

      }



      config.seeded.push(folder);

      changed = true;

    }



    if (changed) {

      writeSkillsConfig(config);

    }

  } catch (err) {

    console.error('[seed] Error seeding bundled skills:', err);

  }

}



/**

 * Clean up stale Playwright MCP profile lock files left by a crashed Chromium.

 *

 * Independent of the agent-browser bundle removal — this exists because

 * Chromium leaves SingletonLock / SingletonSocket / SingletonCookie files in

 * the user-data-dir when the process crashes (or the OS kills it on app exit

 * without a clean shutdown). Subsequent Chromium launches with the same

 * user-data-dir refuse to start with "ProfileInUse" until the locks clear.

 *

 * Playwright's own startup mostly handles this, but the legacy

 * `~/.playwright-mcp-profile/` directory pre-dates Playwright MCP's improved

 * recovery paths and we've seen real "Chromium hangs forever" reports tied to

 * stale locks here. Cheap idempotent cleanup at sidecar boot.

 */

function cleanupStalePlaywrightProfile(): void {

  try {

    const homeDir = getHomeDirOrNull();

    if (!homeDir) return;



    const profileDir = join(homeDir, '.playwright-mcp-profile');

    const lockPath = join(profileDir, 'SingletonLock');



    if (!existsSync(lockPath)) return;



    // SingletonLock content: "hostname-pid" (POSIX symlink target on macOS/Linux,

    // regular file content on Windows).

    let linkTarget: string;

    try {

      linkTarget = readlinkSync(lockPath);

    } catch {

      try {

        linkTarget = readFileSync(lockPath, 'utf-8').trim();

      } catch {

        return; // Can't read — bail

      }

    }



    const pidMatch = linkTarget.match(/-(\d+)$/);

    if (!pidMatch) return;

    const pid = parseInt(pidMatch[1], 10);



    // Probe pid liveness; if the process is alive, leave its locks alone.

    try {

      process.kill(pid, 0);

      return;

    } catch {

      // Process is dead → safe to clean up

    }



    for (const file of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {

      const filePath = join(profileDir, file);

      try {

        if (existsSync(filePath)) {

          unlinkSync(filePath);

        }

      } catch { /* best effort */ }

    }



    console.log(`[startup] Cleaned up stale Playwright MCP profile lock (pid ${pid} dead)`);

  } catch (err) {

    console.warn('[startup] Playwright profile cleanup failed:', err);

  }

}



// ============= END SKILLS CONFIG & SEED =============



/**

 * Validate that the agent directory is safe to access.

 * Prevents directory traversal attacks and access to sensitive directories.

 */

function isValidAgentDir(dir: string): { valid: boolean; reason?: string } {

  const expanded = expandTilde(dir);

  const resolved = resolve(expanded);

  const homeDir = getHomeDirOrNull() || '';



  // Must be an absolute path (use isAbsolute for cross-platform correctness)

  if (!isAbsolute(resolved)) {

    return { valid: false, reason: 'Path must be absolute' };

  }



  // Forbidden system directories (deny-list approach)

  const forbiddenPaths = [

    // Unix system directories

    '/etc', '/var', '/usr', '/bin', '/sbin', '/boot', '/root', '/sys', '/proc', '/dev',

    // User sensitive directories

    join(homeDir, '.ssh'),

    join(homeDir, '.gnupg'),

    join(homeDir, '.config/op'),  // 1Password

    join(homeDir, 'Library/Keychains'),

    // Windows system directories

    'C:\\Windows',

    'C:\\Program Files',

    'C:\\Program Files (x86)',

  ];



  const normalizedResolved = resolved.replace(/\\/g, '/').toLowerCase();

  for (const forbidden of forbiddenPaths) {

    const normalizedForbidden = forbidden.replace(/\\/g, '/').toLowerCase();

    if (normalizedResolved === normalizedForbidden || normalizedResolved.startsWith(normalizedForbidden + '/')) {

      return { valid: false, reason: `Access to ${forbidden} is not allowed` };

    }

  }



  // Reject filesystem roots as workspace (too broad, not a real project)

  // Windows: "C:\", "D:\" etc.  Unix: "/"

  if (resolved === '/' || resolved.match(/^[A-Z]:\\?$/i)) {

    return { valid: false, reason: 'Cannot use filesystem root as workspace' };

  }



  return { valid: true };

}



function resolveAgentPath(root: string, relativePath: string): string | null {

  // Strip leading slashes (both / and \ for Windows compatibility)

  const normalized = relativePath.replace(/^[/\\]+/, '');

  const resolved = resolve(root, normalized);

  // Use root + sep to prevent prefix collision (e.g. /agent matching /agent-other)

  if (resolved !== root && !resolved.startsWith(root + sep)) {

    return null;

  }

  return resolved;

}



// Phase E (PRD 0.2.7): the legacy read-side helpers `isSafeReadPath`,

// `resolveReadPath`, `isPreviewableText` are removed. Their gates now live

// in Rust workspace_files (`path_safety::validate_workspace_root`,

// `resolve_existing_inside_workspace`, `read_preview::is_previewable`).



function jsonResponse(body: unknown, status = 200): Response {

  return new Response(JSON.stringify(body), {

    status,

    headers: { 'Content-Type': 'application/json' }

  });

}



/**

 * Strip credential-bearing fields from a SessionMetadata before returning to clients.

 * Replaces providerEnvJson with '[redacted]' when present (so the client can still tell

 * a provider override exists without seeing the raw API key). Used by GET /sessions,

 * GET /sessions/:id, and PATCH /sessions/:id response shapes — zero-trust parity.

 */

function redactSessionMetadata<T extends { providerEnvJson?: string }>(meta: T): T {

  if (meta.providerEnvJson === undefined) return meta;

  return { ...meta, providerEnvJson: '[redacted]' };

}



function isGenericSessionTitle(title: string | undefined): boolean {

  const trimmed = (title ?? '').trim();

  return trimmed === '' || trimmed === 'New Chat' || trimmed === 'New Tab';

}



function normalizeSessionListPreview(meta: SessionMetadata): SessionMetadata {

  if (!isGenericSessionTitle(meta.title)) return meta;

  if (!meta.runtime || meta.runtime === 'builtin') return meta;



  const data = getSessionData(meta.id);

  const resolved = data

    ? resolveLastRealUserMessagePreview(data.messages)

    : { found: false as const };

  if (resolved.found) {

    return { ...meta, lastMessagePreview: resolved.preview };

  }



  // v0.2.22 external runtimes stored assistant text in lastMessagePreview.

  // For generic-title rows that have no real user preview, prefer "New Chat"

  // over carrying that stale assistant snippet into every list surface.

  if (meta.lastMessagePreview) {

    return { ...meta, lastMessagePreview: undefined };

  }



  return meta;

}



/**

 * Route /api/admin/* requests to the appropriate handler.

 * Keeps the route matching logic clean and separated from business logic (in admin-api.ts).

 */

async function routeAdminApi(pathname: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {

  // Strip the prefix for matching

  const route = pathname.replace('/api/admin/', '');



  // Lazy-load admin-api (~150ms on first hit, cached thereafter)

  const api = await getAdminApi();



  // MCP commands

  if (route === 'mcp/list') return api.handleMcpList();

  if (route === 'mcp/show') return api.handleMcpShow(payload as Parameters<typeof api.handleMcpShow>[0]);

  if (route === 'mcp/add') return api.handleMcpAdd(payload as Parameters<typeof api.handleMcpAdd>[0]);

  if (route === 'mcp/remove') return api.handleMcpRemove(payload as Parameters<typeof api.handleMcpRemove>[0]);

  if (route === 'mcp/enable') return api.handleMcpEnable(payload as Parameters<typeof api.handleMcpEnable>[0]);

  if (route === 'mcp/disable') return api.handleMcpDisable(payload as Parameters<typeof api.handleMcpDisable>[0]);

  if (route === 'mcp/env') return api.handleMcpEnv(payload as Parameters<typeof api.handleMcpEnv>[0]);

  if (route === 'mcp/test') return await api.handleMcpTest(payload as Parameters<typeof api.handleMcpTest>[0]);

  if (route === 'mcp/oauth/discover') return await api.handleMcpOAuthDiscover(payload as Parameters<typeof api.handleMcpOAuthDiscover>[0]);

  if (route === 'mcp/oauth/start') return await api.handleMcpOAuthStart(payload as Parameters<typeof api.handleMcpOAuthStart>[0]);

  if (route === 'mcp/oauth/status') return await api.handleMcpOAuthStatus(payload as Parameters<typeof api.handleMcpOAuthStatus>[0]);

  if (route === 'mcp/oauth/revoke') return await api.handleMcpOAuthRevoke(payload as Parameters<typeof api.handleMcpOAuthRevoke>[0]);



  // Model commands

  if (route === 'model/list') return api.handleModelList();

  if (route === 'model/add') return api.handleModelAdd(payload as Parameters<typeof api.handleModelAdd>[0]);

  if (route === 'model/remove') return api.handleModelRemove(payload as Parameters<typeof api.handleModelRemove>[0]);

  if (route === 'model/set-key') return api.handleModelSetKey(payload as Parameters<typeof api.handleModelSetKey>[0]);

  if (route === 'model/set-default') return api.handleModelSetDefault(payload as Parameters<typeof api.handleModelSetDefault>[0]);

  if (route === 'model/verify') return await api.handleModelVerify(payload as Parameters<typeof api.handleModelVerify>[0]);



  // Agent commands

  if (route === 'agent/list') return api.handleAgentList();

  if (route === 'agent/show') return api.handleAgentShow(payload as Parameters<typeof api.handleAgentShow>[0]);

  if (route === 'agent/enable') return api.handleAgentEnable(payload as Parameters<typeof api.handleAgentEnable>[0]);

  if (route === 'agent/disable') return api.handleAgentDisable(payload as Parameters<typeof api.handleAgentDisable>[0]);

  if (route === 'agent/set') return api.handleAgentSet(payload as Parameters<typeof api.handleAgentSet>[0]);

  // Environment engine probe (安全研究员版 P1 E1)

  if (route === 'environment/engines') return await api.handleEnvironmentEngines(payload as Parameters<typeof api.handleEnvironmentEngines>[0]);



  // Named environments (安全研究员版 P1 E3)

  if (route === 'environment/list') return api.handleEnvironmentList();

  if (route === 'environment/add') return await api.handleEnvironmentAdd(payload as Record<string, unknown>);

  if (route === 'environment/remove') return await api.handleEnvironmentRemove(payload as Parameters<typeof api.handleEnvironmentRemove>[0]);

  if (route === 'environment/open') return await api.handleEnvironmentOpen(payload as Parameters<typeof api.handleEnvironmentOpen>[0]);



  // Environment recipes + docker lifecycle (安全研究员版 P1 E4)

  if (route === 'environment/recipes') return api.handleEnvironmentRecipes();

  if (route === 'environment/up') return await api.handleEnvironmentUp(payload as Parameters<typeof api.handleEnvironmentUp>[0]);

  if (route === 'environment/down') return await api.handleEnvironmentDown(payload as Parameters<typeof api.handleEnvironmentDown>[0]);

  if (route === 'environment/ps') return await api.handleEnvironmentPs();

  if (route === 'environment/discover') return await api.handleEnvironmentDiscover();

  // 域包清单层(P2 多域抽象层)
  if (route === 'domain/list') return api.handleDomainList();
  if (route === 'domain/check') return await api.handleDomainCheck(payload as Parameters<typeof api.handleDomainCheck>[0]);

  if (route === 'environment/adopt') return await api.handleEnvironmentAdopt(payload as Parameters<typeof api.handleEnvironmentAdopt>[0]);

  if (route === 'environment/install') return await api.handleEnvironmentInstall(payload as Parameters<typeof api.handleEnvironmentInstall>[0]);

  if (route === 'environment/build') return await api.handleEnvironmentBuild(payload as Parameters<typeof api.handleEnvironmentBuild>[0]);

  if (route === 'environment/rm') return await api.handleEnvironmentRm(payload as Parameters<typeof api.handleEnvironmentRm>[0]);

  if (route === 'environment/exec') return await api.handleEnvironmentExec(payload as Parameters<typeof api.handleEnvironmentExec>[0]);

  // W1(design-spec §6.1/§6.4)— 环境快照/回滚(vmware vmrun;docker 暂未支持)

  if (route === 'environment/snapshot') return await api.handleEnvironmentSnapshot(payload as Parameters<typeof api.handleEnvironmentSnapshot>[0]);

  if (route === 'environment/rollback') return await api.handleEnvironmentRollback(payload as Parameters<typeof api.handleEnvironmentRollback>[0]);
  if (route === 'environment/extract') return await api.handleEnvironmentExtract(payload as Parameters<typeof api.handleEnvironmentExtract>[0]);



  // Environment selection（安全研究员版 P1 T4，D17 首屏选定的持久化）

  if (route === 'environment/select') return api.handleEnvironmentSelect(payload as Parameters<typeof api.handleEnvironmentSelect>[0]);

  if (route === 'environment/current') return api.handleEnvironmentCurrent(payload as Parameters<typeof api.handleEnvironmentCurrent>[0]);




  // Tool readme — progressive-disclosure helpers (zhishi CLI on-demand docs)

  if (route === 'readme/widget') {

    const topic = route.split('/')[1];

    return api.handleReadme({

      topic,

      modules: Array.isArray(payload.modules) ? (payload.modules as string[]) : undefined,

    });

  }



  // Skill commands

  if (route === 'skill/list') return await api.handleSkillList();

  if (route === 'skill/info') return await api.handleSkillInfo(payload as Parameters<typeof api.handleSkillInfo>[0]);

  if (route === 'skill/remove') return await api.handleSkillRemove(payload as Parameters<typeof api.handleSkillRemove>[0]);

  if (route === 'skill/enable') return await api.handleSkillToggle({ name: String(payload.name ?? ''), enabled: true });

  if (route === 'skill/disable') return await api.handleSkillToggle({ name: String(payload.name ?? ''), enabled: false });



  // AppCraft (PRD 0.2.36 §6.4-6.6) — workspace app-automation recordings + replay

  if (route === 'appcraft/list') return await api.handleAppcraftList(payload as Parameters<typeof api.handleAppcraftList>[0]);

  if (route === 'appcraft/replay') return await api.handleAppcraftReplay(payload as Parameters<typeof api.handleAppcraftReplay>[0]);

  if (route === 'appcraft/record/start') return await api.handleAppcraftRecordStart(payload as Parameters<typeof api.handleAppcraftRecordStart>[0]);

  if (route === 'appcraft/record/stop') return await api.handleAppcraftRecordStop();

  if (route === 'appcraft/record/status') return await api.handleAppcraftRecordStatus();

  // 想法流（COWORK 任务7/8）：搭子的主动提醒（附来源），经蒸馏层过滤后给 Launcher 流。
  if (route === 'memory/active-reminders') return api.handleMemoryActiveReminders();

  // 想法流反馈（阶段3）：捡起=存款 / 划走=取款（分寸）。
  if (route === 'memory/reminder-feedback') return await api.handleMemoryReminderFeedback(payload as Parameters<typeof api.handleMemoryReminderFeedback>[0]);

  // 记忆检索（阶段4）。
  if (route === 'memory/search') return await api.handleMemorySearch(payload as Parameters<typeof api.handleMemorySearch>[0]);
  if (route === 'memory/overview') return await api.handleMemoryOverview();

  // 研究成败信号（安全研究员版 P1 D1，memory.db research_events 表）。
  if (route === 'research/log') return await api.handleResearchLog(payload as Parameters<typeof api.handleResearchLog>[0]);
  if (route === 'research/list') return await api.handleResearchList(payload as Parameters<typeof api.handleResearchList>[0]);
  if (route.startsWith('term/')) return await api.handlePanelProxy(route, payload);

  // 全局人格层（设置页「搭子」）。
  if (route === 'persona/read' || route === 'persona/write') {
    return { success: false, error: 'persona 已随安全研究员版移除(人格层整拆)' };
  }

  // 信任账本（宪章 §5.1，memory.db）。
  if (route === 'trust/event') return await api.handleTrustEvent(payload as unknown as Parameters<typeof api.handleTrustEvent>[0]);
  if (route === 'trust/ledger') return await api.handleTrustLedger(payload as Parameters<typeof api.handleTrustLedger>[0]);
  if (route === 'trust/resolve') return await api.handleTrustResolve(payload as Parameters<typeof api.handleTrustResolve>[0]);
  if (route === 'trust/reset') return api.handleTrustReset();
  if (route === 'trust/import') return await api.handleTrustImport(payload as Parameters<typeof api.handleTrustImport>[0]);

  if (route === 'appcraft/app/approve') return await api.handleAppcraftAppApprove(payload as Parameters<typeof api.handleAppcraftAppApprove>[0]);



  // Config commands

  if (route === 'config/get') return api.handleConfigGet(payload as Parameters<typeof api.handleConfigGet>[0]);

  if (route === 'config/set') return api.handleConfigSet(payload as Parameters<typeof api.handleConfigSet>[0]);



  // Task Center — tasks (v0.1.69)

  if (route === 'task/list') return await api.handleTaskList(payload as Parameters<typeof api.handleTaskList>[0]);

  if (route === 'task/get') return await api.handleTaskGet(payload as Parameters<typeof api.handleTaskGet>[0]);

  if (route === 'task/create-direct') return await api.handleTaskCreateDirect(payload);

  if (route === 'task/create-from-alignment') return await api.handleTaskCreateFromAlignment(payload);

  if (route === 'task/run') return await api.handleTaskRun(payload as Parameters<typeof api.handleTaskRun>[0]);

  if (route === 'task/rerun') return await api.handleTaskRerun(payload as Parameters<typeof api.handleTaskRerun>[0]);

  if (route === 'task/update') return await api.handleTaskUpdate(payload);

  if (route === 'task/update-status') return await api.handleTaskUpdateStatus(payload);

  if (route === 'task/append-session') return await api.handleTaskAppendSession(payload as Parameters<typeof api.handleTaskAppendSession>[0]);

  if (route === 'task/archive') return await api.handleTaskArchive(payload as Parameters<typeof api.handleTaskArchive>[0]);

  if (route === 'task/delete') return await api.handleTaskDelete(payload as Parameters<typeof api.handleTaskDelete>[0]);

  if (route === 'task/read-doc') return await api.handleTaskReadDoc(payload as Parameters<typeof api.handleTaskReadDoc>[0]);

  if (route === 'task/write-doc') return await api.handleTaskWriteDoc(payload as Parameters<typeof api.handleTaskWriteDoc>[0]);




  // System commands

  if (route === 'status') return api.handleStatus();

  if (route === 'reload') return api.handleReload(payload.workspacePath as string | undefined);

  if (route === 'version') return api.handleVersion();

  if (route === 'help') return api.handleHelp(payload as Parameters<typeof api.handleHelp>[0]);



  return { success: false, error: `Unknown admin route: ${pathname}` };

}





/**

 * Recursively copy a directory using fs/promises.

 * Every filesystem call yields to the event loop — important for HTTP handlers

 * that bulk-copy multiple folders. A sync implementation would block Bun's

 * event loop long enough for the Rust health monitor (/health with 2 s timeout,

 * 15 s interval) to declare the sidecar unresponsive and respawn it on a fresh

 * port mid-copy — which was the root cause of the "sync-from-claude crashes

 * the sidecar" report in issue #96.

 *

 * Security: Skips symbolic links to prevent following links to sensitive locations.

 */

async function copyDirRecursive(src: string, dest: string, logPrefix = '[copyDir]'): Promise<void> {

  await ensureDir(dest);

  const entries = await readdirAsync(src, { withFileTypes: true });

  for (const entry of entries) {

    const srcPath = join(src, entry.name);

    const destPath = join(dest, entry.name);



    if (entry.isSymbolicLink()) {

      console.warn(`${logPrefix} Skipping symlink: ${srcPath}`);

      continue;

    }



    if (entry.isDirectory()) {

      await copyDirRecursive(srcPath, destPath, logPrefix);

    } else {

      await copyFileAsync(srcPath, destPath);

    }

  }

}



async function serveStatic(pathname: string): Promise<Response | null> {

  // P4 减法（W1b）后 renderer 已删，dist/ 不再有构建源。本函数只剩一个

  // 合法服务对象：placeholder 占位页（告诉误开浏览器的人 GUI 已删）。

  // cwd/dist 若存在（旧构建残留）不再服务——它就是「已删的界面又出现」

  // 的来源。

  const distRoot = resolve(process.cwd(), 'src-tauri', 'placeholder');

  const resolvedPath = pathname === '/' ? 'index.html' : pathname.slice(1);

  const filePath = resolve(distRoot, resolvedPath);

  // Prevent path traversal: resolved path must stay within distRoot

  if (!filePath.startsWith(distRoot + sep)) {

    return null;

  }

  const fileResp = await fileResponse(filePath, { contentType: sniffMime(filePath) });

  if (fileResp) return fileResp;



  const indexPath = join(distRoot, 'index.html');

  const indexResp = await fileResponse(indexPath, { contentType: sniffMime(indexPath) });

  if (indexResp) return indexResp;



  return null;

}



interface SwitchPayload {

  agentDir: string;

  initialPrompt?: string;

}





/**

 * Write a startup beacon directly to unified log file (bypasses initLogger).

 * This is critical for diagnosing Windows startup hangs where initLogger

 * may not be reached yet and zero NODE logs appear.

 */

function startupBeacon(step: string): void {

  // Write to stderr — captured by Rust drain thread → unified log

  try { process.stderr.write(`[startup] ${step}\n`); } catch { /* ignore */ }

  // Also write directly to unified log file.

  // NOTE: 内联时间戳格式而非 import localTimestamp()，因为此函数在 initLogger() 之前运行，

  // 需保持零依赖以诊断 Windows 上 initLogger 未到达的 hang 问题。

  try {

    const now = new Date();

    const y = now.getFullYear();

    const m = String(now.getMonth() + 1).padStart(2, '0');

    const d = String(now.getDate()).padStart(2, '0');

    const logsDir = join(getZhiShiDataDir(), 'logs');

    ensureDirSync(logsDir);

    const filePath = join(logsDir, `unified-${y}-${m}-${d}.log`);

    const h = String(now.getHours()).padStart(2, '0');

    const mi = String(now.getMinutes()).padStart(2, '0');

    const s = String(now.getSeconds()).padStart(2, '0');

    const ms = String(now.getMilliseconds()).padStart(3, '0');

    const ts = `${y}-${m}-${d} ${h}:${mi}:${s}.${ms}`;

    appendFileSync(filePath, `${ts} [NODE ] [INFO ] [startup] ${step}\n`);

  } catch { /* ignore */ }

}



async function main() {

  startupBeacon(`main() entered, pid=${process.pid}, platform=${process.platform}, argv=${process.argv.length} args`);



  const { agentDir, initialPrompt, port, sessionId: initialSessionId } = parseArgs(process.argv);

  const dirDisplay = agentDir.length > 50 ? agentDir.slice(0, 3) + '...' + agentDir.slice(-44) : agentDir;

  startupBeacon(`args parsed, port=${port}, agentDir=${dirDisplay}`);



  let currentAgentDir = await ensureAgentDir(agentDir);

  startupBeacon('ensureAgentDir done');



  // Initialize unified logging system (intercepts console.log and sends to SSE)

  // PRD #132 — wire the stdio-broken probe + marker so the logger wrapper

  // stops calling originalConsole.* once a stdio EPIPE has marked the sink

  // dead, and so a sync write-throw can flip the bit immediately.

  setStdioBrokenProbe(isStdioBroken, markStdioBroken);

  initLogger(getClients);

  startupBeacon('initLogger done — switching to console.log');



  // Store sidecar port BEFORE initializeAgent() so that:

  //   1. pre-warm's buildClaudeSessionEnv() reads the correct sidecarPort

  //      (OpenAI bridge loopback URL + ZHISHI_PORT injection both need it).

  //   2. setSidecarPort's process.env.ZHISHI_PORT side effect is in place

  //      before any `zhishi` CLI invocation (from pre-warm bash tools) can

  //      spawn. This eliminates a subtle timing

  //      coincidence where the old ordering depended on pre-warm's 500ms

  //      debounce outlasting the few µs between these two calls.

  setSidecarPort(port);



  // ── Deferred init gate ──────────────────────────────────────────────────

  // Everything heavy (skill seed, socks bridge, initializeAgent) moves to

  // AFTER

  // honoServe() binds, so Rust's TCP health check unblocks in < 100ms

  // instead of waiting ~2s for this work to complete. Routes that need

  // agent state `await deferredInit` at the top of the fetch handler.

  //

  // /health is exempt so the sidecar becomes "healthy" from Rust's

  // perspective the moment the HTTP server accepts TCP connections —

  // letting the frontend render the Tab UI while deferred init still runs.

  let resolveDeferredInit!: () => void;

  let rejectDeferredInit!: (e: unknown) => void;

  const deferredInitPromise: Promise<void> = new Promise((res, rej) => {

    resolveDeferredInit = res;

    rejectDeferredInit = rej;

  });

  // Route handlers that need agent state call `await awaitDeferredInit()`.

  // Exposed on globalThis so the hono fetch handler (below) can reach it

  // without changing signatures.

  (globalThis as { __zhishiDeferredInit?: Promise<void> }).__zhishiDeferredInit =

    deferredInitPromise;



  // M4c: openai-bridge 已删除——bridge 处理器不复存在。



  console.log(`[startup] HTTP server binding to 127.0.0.1:${port}...`);



  honoServe({

    // Explicit 127.0.0.1 for Rust proxy compatibility (IPv4).

    port,

    hostname: '127.0.0.1',

    fetch: async (request) => {

      // Pattern 6 (HTTP request boundary): each request runs inside an ALS

      // frame so any nested console.* call automatically gets correlation

      // fields injected. Renderer-side code (`tauriClient.ts`) attaches

      // X-ZhiShi-Session-Id / X-ZhiShi-Tab-Id; the server generates a

      // fresh requestId (or honours an inbound `X-ZhiShi-Request-Id` from

      // the Rust proxy if it pre-populated one).

      const incomingRequestId = request.headers.get('x-zhishi-request-id') ?? undefined;

      const requestId = incomingRequestId ?? randomUUIDv4Short();

      const sessionId = request.headers.get('x-zhishi-session-id') ?? undefined;

      const tabId = request.headers.get('x-zhishi-tab-id') ?? undefined;

      return withLogContext({ requestId, sessionId, tabId }, () => handleRequest(request));

    },

  } as Parameters<typeof honoServe>[0]);



  /**

   * Pattern 6 helper: short stable id for HTTP request correlation.

   * crypto.randomUUID is ~36 chars; we collapse to 8 hex for grep-ability.

   */

  function randomUUIDv4Short(): string {

    // randomUUID is imported above; we re-derive from the same 16-byte source.

    return randomUUID().replace(/-/g, '').slice(0, 8);

  }



  /**

   * `/chat/stream` SSE disconnect is intentionally NOT a turn-cancellation

   * authority. When the last SSE client closes, we do NOT interrupt the

   * in-flight SDK turn. This is load-bearing — do not "optimize" it back.

   *

   * WHY (architecture: "后端优先，前端辅助" — ARCHITECTURE.md): a turn's lifecycle

   * belongs to the Rust sidecar Owner model (Tab / CronTask / BackgroundCompletion

   * / Agent), not to whether a frontend tab is currently watching. The product

   * contract is explicit: closing / navigating away from a tab while the AI is

   * running starts BackgroundCompletion and lets the turn FINISH ("AI 继续在后台

   * 完成任务"); abandoning a turn is done via the Stop button (→ 'user' interrupt),

   * not by closing the tab. So "no SSE consumer" must never mean "cancel".

   *

   * HISTORY: PRD 0.2.0 (structural refactors) specced an *owner-aware* check

   * here ("interrupt only if the owner set no longer has a Tab/Frontend owner,

   * but IM/Cron/BackgroundCompletion may still keep it alive"). The shipped impl

   * (390d38ee) instead used a raw `getClients().length === 0` grace and assumed

   * "headless turns never have an SSE client" — false the moment a user opens a

   * tab to observe a cron / session-send turn then closes it mid-turn. That

   * regressed BackgroundCompletion and delivered spurious `[ERROR turn_failed]

   * [ede_diagnostic]` back to Feishu/IM. Removing the interrupt restores the

   * owner-model boundary.

   *

   * What still governs turn lifecycle WITHOUT this interrupt:

   *   - Stop button → interruptCurrentResponse('user').

   *   - All owners released → Rust stops the sidecar → process exit ends the turn.

   *   - Hung / silent turn → the 10-min inactivity watchdog (agent-session.ts),

   *     which is SSE-independent.

   *   - Zero SSE clients is a normal, handled state: broadcast() to an empty

   *     client set is a no-op (cron/IM turns run headless this way constantly),

   *     so there is no "chunks nobody reads" leak.

   *

   * The one residual gap — a leaked `Tab` owner after an abnormal renderer/SSE

   * death keeping an event-emitting turn alive (watchdog won't fire) — is a

   * stale-owner / renderer-health problem to solve with owner leases or tab

   * cleanup, NOT by making SSE disconnect a cancellation signal.

   */



  /**

   * Original Hono fetch body, unchanged except for being moved into a named

   * function so the outer wrapper can run inside `withLogContext`.

   */

  async function handleRequest(request: Request): Promise<Response> {

    {

      const url = new URL(request.url);

      const pathname = url.pathname;



      // Skip logging high-frequency polling/config-sync paths to reduce unified log noise.

      // These fire every 15s (health) or on every Tab focus (commands/agents/mcp) with zero diagnostic value.

      const SILENT_PATHS = new Set([

        '/health', '/api/unified-log', '/sessions', '/api/agents/enabled',

      ]);

      if (!SILENT_PATHS.has(pathname)) {

        console.debug(`[http] ${request.method} ${pathname}`);

      }



      // Handle CORS preflight requests (for browser dev mode via Vite proxy)

      if (request.method === 'OPTIONS') {

        return new Response(null, {

          status: 204,

          headers: {

            'Access-Control-Allow-Origin': '*',

            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',

            'Access-Control-Allow-Headers': 'Content-Type, Authorization',

          }

        });

      }



      // 🩺 Health check endpoints - used by Rust sidecar manager and renderer.

      //

      // Pattern 4 splits the historical "/health = healthy" signal into three:

      //   - /health         → liveness (TCP bind succeeded; legacy alias kept

      //                       so existing Rust watchdogs keep working)

      //   - /health/live    → same as /health, explicit name

      //   - /health/ready   → deferred init complete; structured 503 + phase

      //                       while pending or failed

      //   - /health/functional → core feature can serve (sidecar mirrors live;

      //                       Plugin Bridge implements the real check)

      //

      // All four bypass the deferred-init gate below — they MUST respond

      // immediately, otherwise probes can't distinguish "still warming up"

      // from "wedged".

      if ((pathname === '/health' || pathname === '/health/live') && request.method === 'GET') {

        return jsonResponse({ status: 'ok', timestamp: Date.now() });

      }

      if (pathname === '/health/ready' && request.method === 'GET') {

        const { status, body } = buildReadyResponseBody();

        return jsonResponse(body, status);

      }

      if (pathname === '/health/functional' && request.method === 'GET') {

        // Sidecar's "functional" mirrors readiness for now — once ready, the

        // Hono handler is serving requests. Plugin Bridge has a more

        // meaningful gateway-forwarding check.

        const { status, body } = buildReadyResponseBody();

        return jsonResponse(body, status);

      }

      // (removed) `POST /health/ready/retry` — pre-0.2.0 endpoint that reset

      // DeferredInitState to `pending` and returned 202 promising a re-run,

      // but no in-process re-runner exists (the deferred init block is a

      // single IIFE). The renderer never observed progress and was misled.

      // Retry today is a process restart; if/when an extracted re-callable

      // init lands we can reintroduce a real retry endpoint.



      // 📦 Pattern 2 §2.3.1 — Large-value ref retrieval. SSE / IPC payloads

      // over the spill threshold leave a `{kind:'ref', id, ...}` placeholder

      // here; consumers fetch the full body via this endpoint. Streamed via

      // createReadStream so multi-MB bodies don't get loaded into memory.

      // Bypasses the deferred-init gate — refs are independent of agent

      // state, and the /chat/* SSE consumer may be mid-replay during init.

      if (pathname.startsWith('/refs/') && request.method === 'GET') {

        const id = decodeURIComponent(pathname.slice('/refs/'.length));

        // Mirror the strict regex inside large-value-store.getRefStreamPath:

        // 8–32 lowercase hex (uuid-prefix shape). The route check used to be

        // looser (`/^[a-f0-9]+$/i`, no length cap, case-insensitive), which

        // meant attacker-style upper-case probes returned 404 from the inner

        // store after also satisfying the route — defense-in-depth without

        // observable behavior change for legitimate refs.

        if (!id || !/^[a-f0-9]{8,32}$/.test(id)) {

          return jsonResponse({ error: 'invalid ref id' }, 400);

        }

        const { getRefStreamPath } = await import('./utils/large-value-store');

        const refInfo = await getRefStreamPath(id);

        if (!refInfo) {

          return jsonResponse({ error: 'ref not found or expired' }, 404);

        }

        // Stream from disk so multi-MB bodies don't buffer into memory.

        //

        // `Access-Control-Allow-Origin: *` is the load-bearing header here

        // (issue #109 root cause). The renderer's proxyFetch pulls this URL

        // via WebKit's native `fetch()` (the spill path bypasses Tauri IPC

        // because the body is too large to ship through the invoke channel).

        // Without an explicit ACAO header, WebKit/WKWebView silently rejects

        // the response as opaque cross-origin and surfaces it to JS as the

        // notoriously diagnostic-free `TypeError: Load failed`. Other

        // sidecar paths skip CORS because they go through Tauri IPC, which

        // bypasses the browser's same-origin machinery entirely; this one

        // doesn't, so it must opt in. Use `*` (not the renderer's origin)

        // because the sidecar is bound to 127.0.0.1 and trusts everything

        // on loopback already.

        const fr = await fileResponse(refInfo.path, {

          contentType: refInfo.mimetype,

          headers: {

            'Access-Control-Allow-Origin': '*',

          },

        });

        if (!fr) {

          return jsonResponse({ error: 'ref body missing' }, 404);

        }

        return fr;

      }



      // ── Deferred init gate ────────────────────────────────────────────────

      // All other routes depend on agent state (currentAgentDir, MCP servers,

      // session metadata, bridge handler). Pattern 4: instead of awaiting

      // the bare promise (which either blocks indefinitely or rethrows as a

      // 500 on failure), consult the state machine and return a structured

      // 503 if init is pending/phase/failed. Once `kind === 'ready'`, the

      // gate is a no-op (sub-µs) for steady-state requests.

      const gate = buildGateResponseBody();

      if (gate) {

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };

        if (gate.body.state === 'pending' || gate.body.state === 'phase') {

          headers['Retry-After'] = '1';

        }

        return new Response(JSON.stringify(gate.body), { status: gate.status, headers });

      }



      // Tool attachment endpoint (PRD 0.2.15) — rich-media tool outputs (image/audio/pdf/file).

      // URL shape: GET /api/attachment/tool/<sessionId>/<turnId>/<filename>

      //

      // Resolution: trusted attachment root <home>/.zhishi/generated/

      // tool-attachments/<s>/<t>/<f> (where saved attachments land).

      //

      // Security: the resolved path is re-validated via

      // validateExternalReadPathNode (system/credential blacklist) and is by

      // construction inside the ZhiShi-owned tree.

      if (pathname.startsWith('/api/attachment/tool/') && request.method === 'GET') {

        // Codex review EP1: decodeURIComponent throws URIError on malformed

        // %xx escapes — wrap explicitly so we return 400 (with CORS) instead

        // of crashing the request and leaving the renderer with an opaque error.

        let rest: string;

        try {

          rest = decodeURIComponent(pathname.slice('/api/attachment/tool/'.length));

        } catch {

          return new Response('Bad Request', {

            status: 400,

            headers: { 'Access-Control-Allow-Origin': '*' },

          });

        }

        const segs = rest.split('/').filter(Boolean);

        if (segs.length !== 3) {

          return new Response('Bad Request', {

            status: 400,

            headers: { 'Access-Control-Allow-Origin': '*' },

          });

        }

        const [sid, tid, fname] = segs;

        // Guard against `..` / `/` / `\` / control chars in any segment.

        const hasUnsafeChar = (s: string): boolean => {

          if (s.includes('..')) return true;

          for (let i = 0; i < s.length; i++) {

            const code = s.charCodeAt(i);

            if (code < 0x20) return true;

            if (s[i] === '/' || s[i] === '\\') return true;

          }

          return false;

        };

        if (segs.some(hasUnsafeChar)) {

          return new Response('Forbidden', {

            status: 403,

            headers: { 'Access-Control-Allow-Origin': '*' },

          });

        }

        // Trusted root for saved attachments (builtin session store).

        const realPath = join(getToolAttachmentRoot(), sid, tid, fname);

        // Defense-in-depth: blacklist check (paths in registry have already passed,

        // but if a session-resume rebuild ever fed in a bad path we'd refuse here).

        const check = validateExternalReadPathNode(realPath);

        if (!check.ok) {

          return new Response('Forbidden', {

            status: 403,

            headers: { 'Access-Control-Allow-Origin': '*' },

          });

        }

        const fileResp = await fileResponse(check.canonical, {

          contentType: sniffMime(check.canonical),

          headers: {

            'Cache-Control': 'public, max-age=31536000, immutable',

            'Access-Control-Allow-Origin': '*',

          },

        });

        return fileResp ?? new Response('Not Found', {

          status: 404,

          headers: { 'Access-Control-Allow-Origin': '*' },

        });

      }



      // Browser dev-mode fallback for attachment files.

      // Production uses the Tauri `zhishi://attachment/<path>` custom protocol

      // (`src-tauri/src/attachment_protocol.rs`) which serves bytes directly

      // through WebKit without round-tripping JSON. In dev (vite + browser) the

      // custom scheme isn't registered, so this route serves the same bytes

      // via a plain HTTP GET. fileResponse() streams via createReadStream to

      // avoid buffering large attachments.

      if (pathname.startsWith('/api/attachment/') && request.method === 'GET') {

        const rel = decodeURIComponent(pathname.replace('/api/attachment/', ''));

        // Reject path traversal: no `..` segments and no absolute paths.

        if (rel.includes('..') || rel.startsWith('/')) {

          return new Response('Forbidden', { status: 403 });

        }

        const absolute = getAttachmentPath(rel);

        const fileResp = await fileResponse(absolute, {

          contentType: sniffMime(absolute),

          headers: {

            'Cache-Control': 'public, max-age=31536000, immutable',

            'Access-Control-Allow-Origin': '*',

          },

        });

        return fileResp ?? new Response('Not Found', { status: 404 });

      }



      // Session state endpoint - used by Rust background completion polling

      if (pathname === '/api/session-state' && request.method === 'GET') {

        const sessionState = getPiAgentState().sessionState;

        return jsonResponse({ sessionState });

      }



      // Read historical session messages from SDK's persisted session files (v0.2.59+)

      // Works without an active Sidecar — reads directly from .claude/ session data

      if (pathname === '/api/session/messages' && request.method === 'GET') {

        const sdkSessionId = url.searchParams.get('sdkSessionId');

        if (!sdkSessionId) {

          return jsonResponse({ success: false, error: 'sdkSessionId is required' }, 400);

        }

        const dir = url.searchParams.get('dir') || undefined;

        const rawLimit = url.searchParams.get('limit');

        const rawOffset = url.searchParams.get('offset');

        const limit = rawLimit ? (Number.isFinite(+rawLimit) && +rawLimit >= 0 ? Math.floor(+rawLimit) : undefined) : undefined;

        const offset = rawOffset ? (Number.isFinite(+rawOffset) && +rawOffset >= 0 ? Math.floor(+rawOffset) : undefined) : undefined;

        try {

          const messages = await getHistoricalSessionMessages(sdkSessionId, dir, limit, offset);

          return jsonResponse({ success: true, messages });

        } catch (error) {

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to read session messages' },

            500

          );

        }

      }



      // 🔍 Debug endpoint: Expose logger diagnostics via HTTP

      if (pathname === '/debug/logger' && request.method === 'GET') {

        const diagnostics = getLoggerDiagnostics();

        const clientsCount = getClients().length;

        return jsonResponse({

          ...diagnostics,

          currentClientsCount: clientsCount,

          timestamp: new Date().toISOString(),

        }, 200);

      }



      if (pathname === '/chat/stream' && request.method === 'GET') {

        // No onClose turn-interrupt: SSE disconnect is not a cancellation

        // authority (see the note above — turn lifecycle = Rust Owner model).

        const { client, response } = createSseClient(() => {});

        // M4a — pi 引擎:会话状态由 loop/chat-engine 服务(SDK 的

        // getAgentState/getMessages 在这条路径下为空)。事件名/形状与

        // SDK 路径逐字段对齐,TUI 零改动。

        if (isPiEngine()) {

          client.send('chat:init', getPiAgentState());

          const piStreamingId = getPiStreamingAssistantId();

          getPiMessages().forEach((message) => {

            if (piStreamingId && message.id === piStreamingId) return;

            client.send('chat:message-replay', { message, replayKind: 'cold-history' });

          });

          client.send('chat:logs', { lines: getPiLogLines() });

          // 越界 ask(design §6.6):重连重放全部待答 ask——TUI 重连不丢模态。
          for (const ask of pendingBoundaryAsks()) {
            client.send('chat:boundary-ask', ask);
          }

          const piInitInfo = getPiSystemInitInfo();

          if (piInitInfo) {

            client.send('chat:system-init', { info: piInitInfo });

          }

          return response;

        }


      }



      if (pathname === '/chat/send' && request.method === 'POST') {

        let payload: SendMessagePayload;

        try {

          payload = (await request.json()) as SendMessagePayload;

        } catch {

          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);

        }

        const text = payload?.text?.trim() ?? '';

        const images = payload?.images ?? [];

        const permissionMode = payload?.permissionMode ?? 'auto';

        const model = payload?.model;

        const providerEnv = payload?.providerEnv;

        const refs = payload?.refs;



        // Allow sending with just images or just text

        if (!text && images.length === 0) {

          return jsonResponse({ success: false, error: 'Message must have text or images.' }, 400);

        }



        // M4c — 唯一引擎:pi(SDK 路径已删除)。

        try {

          console.log(`[chat][pi] send text="${text.slice(0, 200)}" images=${images.length} model=${model ?? 'default'}`);

          const piResult = await sendPiChatMessage({ text, images, model, providerEnv, permissionMode, refs });

          if (piResult.error) {

            return jsonResponse({ success: false, error: piResult.error }, 429);

          }

          return jsonResponse({

            success: true,

            queued: piResult.queued ?? false,

            queueId: piResult.queueId,

            isInFlight: piResult.isInFlight ?? false,

            // W1 — true = 进了 steering 队列(运行中注入),区别于 FIFO 排队。

            steering: piResult.steering ?? false,

          });

        } catch (error) {

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },

            500

          );

        }

      }



      if (pathname === '/chat/model' && request.method === 'POST') {
        try {
          const payload = (await request.json()) as { model?: string };
          const model = typeof payload?.model === 'string' ? payload.model.trim() : '';
          if (!model) {
            return jsonResponse({ success: false, error: '缺少 model 参数' }, 400);
          }

          // 反查 model → providerId：
          // 1) preset + custom provider 的 models/primaryModel（deepseek、anthropic…）
          // 2) 用户 providerPrimaryModels（覆盖 kimi k3 / deepseek flash 等非 preset provider）
          // 3) providerModelAliases 别名（sonnet/opus/haiku → 真实模型）
          const config = loadConfig();
          let providerId: string | null = null;
          for (const provider of getAllEffectiveProviders(config)) {
            const rec = provider as unknown as Record<string, unknown>;
            const models = rec.models as Array<{ model: string }> | undefined;
            if (models?.some((m) => m.model === model) || rec.primaryModel === model) {
              providerId = provider.id;
              break;
            }
          }
          if (!providerId) {
            for (const [pid, pm] of Object.entries((config.providerPrimaryModels as Record<string, string>) ?? {})) {
              if (pm === model) { providerId = pid; break; }
            }
          }
          if (!providerId) {
            for (const [pid, map] of Object.entries((config.providerModelAliases as Record<string, Record<string, string>>) ?? {})) {
              if (Object.values(map).some((v) => v === model)) { providerId = pid; break; }
            }
          }
          if (!providerId) {
            return jsonResponse({ success: false, error: `未知模型: ${model}` }, 404);
          }

          // 无 key 的 provider 切过去会立刻让聊天不可用，先校验。
          const apiKey = (config.providerApiKeys as Record<string, string>)[providerId];
          if (!apiKey || !apiKey.trim()) {
            return jsonResponse({ success: false, error: `provider ${providerId} 未配置 API key，无法切换到 ${model}` }, 400);
          }

          // 持久化默认 provider/model；resolveLoopModel 每次 turn 现读 config，下次即生效。
          const targetProviderId = providerId;
          await atomicModifyConfig((c) => {
            c.defaultProviderId = targetProviderId;
            c.defaultModelId = model;
            return c;
          });

          setSessionModel(model);

          return jsonResponse({ success: true, providerId: targetProviderId, model });
        } catch (error) {
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set model' }, 500);
        }
      }

      if (pathname === '/chat/stop' && request.method === 'POST') {

        try {

          console.log('[chat] stop');

          // M4a — pi 引擎:abort 当前 runLoop(pi signal 语义)。

          if (isPiEngine()) {

            const piStopped = stopPiChat();

            return jsonResponse(piStopped ? { success: true } : { success: true, alreadyStopped: true });

          }

          // M4c — pi 是唯一引擎,上面的分支恒命中。

          return jsonResponse({ success: true, alreadyStopped: true });

        } catch (error) {

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },

            500

          );

        }

      }


      // Rewind session to a specific user message (time travel)

      if (pathname === '/chat/rewind' && request.method === 'POST') {

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

        const userMessageId = typeof body.userMessageId === 'string' ? body.userMessageId : '';

        if (!userMessageId) {

          return jsonResponse({ success: false, error: 'Missing userMessageId' }, 400);

        }

        // M4b — pi 引擎:loop-sessions 截断(追加日志,截断即时间回溯)。

        if (isPiEngine()) {

          return jsonResponse(await rewindPiChat(userMessageId));

        }

        // M4c — pi 是唯一引擎,上面的分支恒命中。

        return jsonResponse({ success: false, error: 'unreachable' }, 500);

      }



      // Fork session at a specific assistant message (create branch)

      if (pathname === '/sessions/fork' && request.method === 'POST') {

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

        const messageId = typeof body.messageId === 'string' ? body.messageId : '';

        if (!messageId) {

          return jsonResponse({ success: false, error: 'Missing messageId' }, 400);

        }

        // pi 引擎:fork 已实现(forkPiChat——复制前半段到新 loop session,
        // 当前 loop 原地换血)。

        return jsonResponse(await forkPiChat(messageId));

      }



      // Explicitly FIFO-queue a message (W1 — /chat/send busy 时走 steering,
      // 显式排队保留 M4b FIFO 语义:busy → 排队等 turn;空闲 → 直接开 turn)
      if (pathname === '/chat/queue' && request.method === 'POST') {

        let payload: SendMessagePayload;

        try {

          payload = (await request.json()) as SendMessagePayload;

        } catch {

          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);

        }

        const text = payload?.text?.trim() ?? '';

        const images = payload?.images ?? [];

        if (!text && images.length === 0) {

          return jsonResponse({ success: false, error: 'Message must have text or images.' }, 400);

        }

        try {

          const piResult = await queuePiChatMessage({

            text,

            images,

            model: payload?.model,

            providerEnv: payload?.providerEnv,

            permissionMode: payload?.permissionMode ?? 'auto',

            refs: payload?.refs,

          });

          if (piResult.error) {

            return jsonResponse({ success: false, error: piResult.error }, 429);

          }

          return jsonResponse({

            success: true,

            queued: piResult.queued ?? false,

            queueId: piResult.queueId,

            isInFlight: piResult.isInFlight ?? false,

          });

        } catch (error) {

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },

            500

          );

        }

      }



      // Cancel a queued message

      if (pathname === '/chat/queue/cancel' && request.method === 'POST') {

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

        const queueId = body?.queueId as string;

        if (!queueId) {

          return jsonResponse({ success: false, error: 'queueId is required' }, 400);

        }

        // M4b — pi 引擎队列。

        if (isPiEngine()) {

          const piCancelled = cancelPiQueueItem(queueId);

          if (piCancelled === null) {

            return jsonResponse({ success: false, error: 'Queue item not found' }, 404);

          }

          return jsonResponse({ success: true, cancelledText: piCancelled });

        }

        return jsonResponse({ success: false, error: 'Queue item not found' }, 404);

      }



      // Force-execute a queued message (interrupt current + run queued)

      if (pathname === '/chat/queue/force' && request.method === 'POST') {

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

        const queueId = body?.queueId as string;

        if (!queueId) {

          return jsonResponse({ success: false, error: 'queueId is required' }, 400);

        }

        try {

          // M4b — pi 引擎队列:中断当前,改跑指定排队项。

          if (isPiEngine()) {

            const piForced = await forcePiQueueItem(queueId);

            if (!piForced) {

              return jsonResponse({ success: false, error: 'Queue item not found' }, 404);

            }

            return jsonResponse({ success: true });

          }

          return jsonResponse({ success: false, error: 'Queue item not found' }, 404);

        } catch (error) {

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },

            500

          );

        }

      }



      // Get queue status

      if (pathname === '/chat/queue/status' && request.method === 'GET') {

        // M4b — pi 引擎队列。

        if (isPiEngine()) {

          return jsonResponse({ success: true, queue: getPiQueueStatus() });

        }

        return jsonResponse({ success: true, queue: getPiQueueStatus() });

      }



      // Poll background task output file for live stats

      if (pathname === '/api/task/poll-background' && request.method === 'POST') {

        try {

          const body = await request.json() as { outputFile?: string; offset?: number };

          const { outputFile, offset = 0 } = body;



          // Validate outputFile path: resolve to canonical path then verify it falls

          // under the user's home directory and matches expected suffix.

          // This prevents path traversal attacks (e.g., "/../../../etc/passwd.output").

          if (!outputFile || typeof outputFile !== 'string') {

            return jsonResponse({ success: false, error: 'Invalid outputFile path' }, 400);

          }

          const resolvedOutputFile = resolve(outputFile);

          const homeDir = getHomeDirOrNull() || '';

          const isUnderHome = homeDir && resolvedOutputFile.startsWith(homeDir + sep);

          if (!isUnderHome || !resolvedOutputFile.endsWith('.output')) {

            return jsonResponse({ success: false, error: 'Invalid outputFile path' }, 400);

          }



          // Check file existence

          if (!existsSync(resolvedOutputFile)) {

            return jsonResponse({ success: true, stats: null, newOffset: 0, isComplete: false });

          }



          const fileStat = statSync(resolvedOutputFile);

          const fileSize = fileStat.size;



          // No new data

          if (offset >= fileSize) {

            return jsonResponse({ success: true, stats: null, newOffset: offset, isComplete: false });

          }



          // Read incremental data (cap at 1MB)

          const MAX_READ = 1024 * 1024;

          const readEnd = Math.min(offset + MAX_READ, fileSize);

          const { open } = await import('node:fs/promises');

          const fh = await open(resolvedOutputFile, 'r');

          let text: string;

          try {

            const length = readEnd - offset;

            const buf = Buffer.alloc(length);

            await fh.read(buf, 0, length, offset);

            text = buf.toString('utf8');

          } finally {

            await fh.close();

          }



          // Parse JSONL lines

          let toolCount = 0;

          let assistantCount = 0;

          let userCount = 0;

          let progressCount = 0;

          let firstTimestamp = 0;

          let lastTimestamp = 0;

          let lastLineType = '';

          let lastLineHasToolUse = false;



          const lines = text.split('\n');

          for (const line of lines) {

            const trimmed = line.trim();

            if (!trimmed) continue;

            try {

              const parsed = JSON.parse(trimmed);

              const ts = parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0;

              if (ts && !firstTimestamp) firstTimestamp = ts;

              if (ts) lastTimestamp = ts;



              if (parsed.type === 'assistant') {

                assistantCount++;

                lastLineType = 'assistant';

                lastLineHasToolUse = false;

                // Count tool_use blocks in content

                if (Array.isArray(parsed.message?.content)) {

                  for (const block of parsed.message.content) {

                    if (block.type === 'tool_use') {

                      toolCount++;

                      lastLineHasToolUse = true;

                    }

                  }

                }

              } else if (parsed.type === 'user') {

                userCount++;

                lastLineType = 'user';

                lastLineHasToolUse = false;

              } else if (parsed.type === 'progress') {

                progressCount++;

              }

            } catch {

              // Skip truncated/invalid lines

            }

          }



          const elapsed = firstTimestamp && lastTimestamp ? lastTimestamp - firstTimestamp : 0;



          // Detect completion: last line is assistant with only text (no tool_use)

          const isComplete = lastLineType === 'assistant' && !lastLineHasToolUse;



          return jsonResponse({

            success: true,

            stats: { toolCount, assistantCount, userCount, progressCount, elapsed },

            newOffset: readEnd,

            isComplete

          });

        } catch (error) {

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },

            500

          );

        }

      }



      // Reset session for "new conversation" - clears all messages and state

      // 越界 ask 应答(design §6.6):TUI 红色模态的 y/n 落点。
      if (pathname === '/chat/boundary/respond' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const askId = typeof body.askId === 'string' ? body.askId : '';
        if (!askId) {
          return jsonResponse({ success: false, error: 'Missing askId' }, 400);
        }
        const found = respondBoundaryAsk(askId, body.approve === true);
        if (!found) {
          return jsonResponse({ success: false, error: 'ask 不存在或已作答/已过期' }, 404);
        }
        return jsonResponse({ success: true });
      }

      if (pathname === '/chat/reset' && request.method === 'POST') {

        try {

          console.log('[chat] reset (new conversation)');

          // M4a — pi 引擎:新 loop 会话 id + 清内存态(旧 jsonl 保留可审计)。

          if (isPiEngine()) {

            resetPiChat();

            return jsonResponse({ success: true });

          }

          // M4c — pi 是唯一引擎,上面的分支恒命中。

          return jsonResponse({ success: true });

        } catch (error) {

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },

            500

          );

        }

      }



      // ============= CRON TASK API =============



      // GET /cron/check-completion - Check if the last response indicates task completion

      if (pathname === '/cron/check-completion' && request.method === 'GET') {

        try {

          const messages = getPiMessages();

          const lastAssistantMessage = [...messages].reverse().find(m => m.role === 'assistant');



          if (!lastAssistantMessage) {

            return jsonResponse({ success: true, completed: false, reason: null });

          }



          // Extract text content from the message

          let textContent = '';

          // pi MessageWire.content 恒为 string(M4c 后无 ContentBlock 形态)。

          textContent = lastAssistantMessage.content;



          // Check for completion marker

          const completionMatch = textContent.match(CRON_TASK_COMPLETE_PATTERN);

          if (completionMatch) {

            return jsonResponse({

              success: true,

              completed: true,

              reason: completionMatch[1].trim()

            });

          }



          return jsonResponse({ success: true, completed: false, reason: null });

        } catch (error) {

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },

            500

          );

        }

      }



      // POST /cron/execute - Execute a scheduled task

      // This endpoint wraps the user's prompt with cron-specific instructions

      // and enables the exit_cron_task custom tool

      if (pathname === '/cron/execute' && request.method === 'POST') {

        let payload: CronExecutePayload;

        try {

          payload = (await request.json()) as CronExecutePayload;

        } catch {

          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);

        }



        const { taskId, prompt, aiCanExit, model, providerEnv, intervalMinutes, executionNumber } = payload;



        if (!taskId || !prompt) {

          return jsonResponse({ success: false, error: 'taskId and prompt are required.' }, 400);

        }



        // Get current session ID for context isolation

        const currentSessionId = getSessionId();



        // Set cron task context so the exit_cron_task tool knows which task is running

        // Pass sessionId for proper isolation between concurrent tasks

        setCronTaskContext(taskId, aiCanExit ?? false, currentSessionId);



        // Set interaction scenario for cron task (L1 + L2-desktop + L3-cron)

        setInteractionScenario({

          type: 'cron',

          taskId,

          intervalMinutes: intervalMinutes ?? 15,

          aiCanExit: aiCanExit ?? false,

        });



        try {

          console.log(`[cron] execute taskId=${taskId} sessionId=${currentSessionId} interval=${intervalMinutes}min exec#=${executionNumber} aiCanExit=${aiCanExit ?? false} prompt="${prompt.slice(0, 100)}..."`);

          // Wrap cron prompt so AI recognizes it as system-triggered (not a real-time human message)

          const wrappedPrompt = `<system-reminder>\n<CRON_TASK>\n${prompt}\n</CRON_TASK>\n</system-reminder>`;



          // PRD #119: intent-driven resolution — see /cron/execute-sync for

          // the full design comment. This endpoint runs against whatever

          // session is already loaded (no session switch), so the snapshot

          // path operates on the current session's metadata. For Explicit

          // intents we bypass the snapshot entirely and use the

          // payload's values directly.

          // PRD 0.2.9: provider routing precedence:

          //   1. payload.providerId (new) — live-resolve from config.json on

          //      every tick. This is the path used by Task Center + the

          //      collapsed Launcher/Chat/IM-cron writers (PRD 0.2.9 R7).

          //   2. payload.providerIntent (legacy #119 path) — kept for in-flight

          //      cron tasks persisted by 0.2.8 and earlier.

          //   3. neither — followAgent (snapshot resolve from session meta).

          const intent = payload.providerIntent ?? 'followAgent';

          let effectiveModel = model;

          let effectiveProviderEnv: ProviderEnv | undefined = providerEnv;

          let effectiveRuntimeConfig = payload.runtimeConfig;



          if (payload.providerId) {

            // PRD 0.2.9 — Per-tick live-resolve. Throws on missing provider /

            // missing apiKey; we surface as 400 and let Rust mark Task Blocked.

            try {

              effectiveProviderEnv = resolveCronProviderRouting(payload.providerId);

            } catch (e) {

              const errMsg = e instanceof Error ? e.message : String(e);

              console.error(`[cron] execute: provider resolution failed for '${payload.providerId}': ${errMsg}`);

              clearCronTaskContext(currentSessionId);

              resetInteractionScenario();

              return jsonResponse({ success: false, error: errMsg }, 400);

            }

            if (payload.model) effectiveModel = payload.model;

            // Issue #204: defense-in-depth for tasks landing

            // on a non-followAgent intent. Always construct (not gated on

            // existence), and let canonical `runtimeConfig.model` win over

            // CLI-shorthand `payload.model` over any pre-existing value.

            effectiveRuntimeConfig = {

              ...(payload.runtimeConfig ?? {}),

              model: payload.runtimeConfig?.model ?? payload.model ?? effectiveRuntimeConfig?.model,

              permissionMode: payload.runtimeConfig?.permissionMode ?? payload.permissionMode ?? effectiveRuntimeConfig?.permissionMode,

            };

            console.log(`[cron] execute providerId=${payload.providerId} resolved=${effectiveProviderEnv?.baseUrl ?? 'anthropic'} model=${effectiveModel ?? 'default'}`);

          } else if (intent === 'followAgent') {

            if (currentSessionId) {

              const sessionMeta = getSessionMetadata(currentSessionId);

              const agent = findAgentByWorkspacePath(agentDir) as AgentConfig | undefined;

              if (sessionMeta && agent) {

                const resolved = resolveSessionConfig(sessionMeta, agent, undefined, 'owned');

                if (resolved.model !== undefined) effectiveModel = resolved.model;

                if (resolved.providerEnvJson) {

                  // Snapshot gate: disabled providers must not bypass the global enablement

                  // contract via stale providerEnvJson. decodeProviderEnvSnapshot returns

                  // undefined → caller fails loud (cron Task → Blocked at next layer).

                  const decoded = decodeProviderEnvSnapshot(resolved.providerEnvJson, resolved.providerId);

                  if (decoded) {

                    effectiveProviderEnv = decoded as ProviderEnv;

                  } else if (resolved.providerId && isProviderDisabled(resolved.providerId)) {

                    console.warn(`[cron] execute followAgent: provider ${resolved.providerId} is globally disabled — refusing frozen snapshot for session ${currentSessionId}`);

                  } else {

                    console.warn(`[cron] execute followAgent: failed to decode providerEnvJson for session ${currentSessionId}, falling back to task-frozen value`);

                  }

                } else if (resolved.providerId) {

                  // Issue #197 — agent persists `providerId` (post-PRD 0.2.9

                  // canonical state) but rarely a frozen `providerEnvJson`,

                  // so the snapshot path was dropping provider context for

                  // CLI/legacy crons that came in with intent=FollowAgent.

                  // Live-resolve env from providerId so the SDK gets the

                  // right ANTHROPIC_API_KEY/BASE_URL instead of falling

                  // back to no provider (apiKeySource=none, model=

                  // claude-sonnet-4-6 default).

                  try {

                    const env = resolveProviderEnv(resolved.providerId);

                    if (env) {

                      effectiveProviderEnv = env as ProviderEnv;

                      // Pair model with provider when neither snapshot nor

                      // agent has one — without this, SDK uses its default.

                      if (effectiveModel === undefined) {

                        const provider = findProvider(resolved.providerId);

                        const primary = provider

                          ? (provider as Record<string, unknown>).primaryModel as string | undefined

                          : undefined;

                        if (primary) effectiveModel = primary;

                      }

                    }

                  } catch (e) {

                    console.warn(`[cron] execute followAgent: failed to live-resolve providerId='${resolved.providerId}' for session ${currentSessionId}`, e);

                  }

                }

              }

            }

            // Backward-compat with the pre-#119 pragmatic fix — see /cron/execute-sync above.

            if (payload.model) effectiveModel = payload.model;

            if (payload.providerEnv) effectiveProviderEnv = payload.providerEnv;

          } else if (intent === 'explicit') {

            if (!payload.providerEnv) {

              console.error(`[cron] execute intent=explicit but payload.providerEnv is missing — refusing to run`);

              clearCronTaskContext(currentSessionId);

              resetInteractionScenario();

              return jsonResponse({

                success: false,

                error: 'Cron task has explicit provider intent but no providerEnv — task data is malformed.',

              }, 400);

            }

            effectiveProviderEnv = payload.providerEnv;

            if (payload.model) effectiveModel = payload.model;

            // Issue #204: defense-in-depth for tasks landing

            // on a non-followAgent intent. Always construct (not gated on

            // existence), and let canonical `runtimeConfig.model` win over

            // CLI-shorthand `payload.model` over any pre-existing value.

            effectiveRuntimeConfig = {

              ...(payload.runtimeConfig ?? {}),

              model: payload.runtimeConfig?.model ?? payload.model ?? effectiveRuntimeConfig?.model,

              permissionMode: payload.runtimeConfig?.permissionMode ?? payload.permissionMode ?? effectiveRuntimeConfig?.permissionMode,

            };

          }



          // Cron tasks are unattended — "user didn't pick" must map to the

          // runtime's MAX permission (not its interactive default), or

          // WebSearch / Bash / mcp__* sit in the approval queue until the

          // 10-minute deadline kills the run. Sentinels for "didn't pick" are

          // undefined and empty string. PRD 0.2.5 R2 / regression of 07bc560d.

          const effectivePermissionMode = resolveCronPermissionMode(

            payload.permissionMode,

            effectiveRuntimeConfig?.permissionMode,

            'builtin',

          );



          // M4c: backgroundAgentPermissionMode 随 permission 体系删除。

          // M4c: cron 会话执行迁移到 pi 引擎(原 SDK enqueueUserMessage)。

          await sendPiChatMessage({ text: wrappedPrompt, model: effectiveModel, providerEnv: effectiveProviderEnv, permissionMode: effectivePermissionMode });

          // Reset scenario after enqueue — already consumed at turn start

          resetInteractionScenario();

          return jsonResponse({ success: true });

        } catch (error) {

          // Clear context on error

          clearCronTaskContext(currentSessionId);

          resetInteractionScenario();

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },

            500

          );

        }

      }



      // POST /cron/execute-sync - Execute a scheduled task synchronously

      // This endpoint is used by Rust for direct Sidecar invocation without frontend

      // It waits for the execution to complete and returns the result

      if (pathname === '/cron/execute-sync' && request.method === 'POST') {

        console.log('[cron] execute-sync: endpoint matched');



        let payload: CronExecutePayload;

        try {

          payload = (await request.json()) as CronExecutePayload;

          console.log('[cron] execute-sync: payload parsed', { taskId: payload.taskId, hasPrompt: !!payload.prompt, runMode: payload.runMode });

        } catch (e) {

          console.error('[cron] execute-sync: JSON parse error', e);

          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);

        }



        const { taskId, prompt, sessionId, aiCanExit, model, providerEnv, runMode, intervalMinutes, executionNumber } = payload;



        if (!taskId || !prompt) {

          return jsonResponse({ success: false, error: 'taskId and prompt are required.' }, 400);

        }



        // Wrap the entire cron handler body in `withCronDispatchLock` so two

        // concurrent ticks within a single sidecar can't interleave on

        // shared global state — `currentMcpServers`, the active session,

        // `cronTaskContext`, `interactionScenario`. Without this, request

        // A's session switch / scenario could be silently overwritten by

        // request B before A reaches `enqueueUserMessage`. PRD 0.2.4 §3.6

        // (cross-review B7).

        return await withCronDispatchLock(async () => {

        // Handle session setup based on runMode

        const effectiveRunMode = runMode ?? 'single_session';

        const { agentDir } = getPiAgentState();



        // 蒸馏弧（工作生命宪章 §4.2）— 系统播种的内置 cron 任务带蒸馏哨兵，

        // 路由到确定性蒸馏管线（输入收集 → 单发 LLM → 合并写盘），不走普通

        // agent turn。动态 import 保持冷启动不为这条每日一次的路径付费。

        if (isDistillArcPrompt(prompt)) {

          const { runDistillArc } = await import('./memory/distill-runner');

          const distillResult = await runDistillArc({ workspacePath: agentDir, taskId });

          return jsonResponse(distillResult.body, distillResult.status);

        }



        // 安全蒸馏弧（安全研究员版 P1 D3，§1.4）— 与认知弧并列的独立弧：

        // 哨兵命中时路由到确定性安全蒸馏管线（未结算 research_events → 单发

        // LLM → keyed 覆盖写库 → 标记事件已蒸馏），不走普通 agent turn。

        if (isResearchDistillArcPrompt(prompt)) {

          const { runResearchDistillArc } = await import('./memory/distill-runner');

          const researchDistillResult = await runResearchDistillArc({ workspacePath: agentDir, taskId });

          return jsonResponse(researchDistillResult.body, researchDistillResult.status);

        }



        // Clear any existing cron context before switching sessions

        // This prevents context pollution when sessions change

        clearCronTaskContext();



        let effectiveSessionId = sessionId;



        if (effectiveRunMode === 'new_session') {

          // Create a fresh session for each execution (no memory of previous runs).

          // v0.1.69: Cron new_task ticks are structurally 'owned' — every tick reads the

          // current Agent and freezes a snapshot into the new SessionMetadata. Per-tick

          // freshness keeps "live-follow" semantics for cron without inventing a third

          // owner kind in resolveSessionConfig (PRD D4 footnote).

          const cronAgent = findAgentByWorkspacePath(agentDir) as AgentConfig | undefined;

          const cronSnapshot: Partial<SessionMetadata> = cronAgent ? snapshotForOwnedSession(cronAgent) : {};

          // PRD #119: stamp the cron's explicit routing intent into the

          // freshly-built snapshot. For Explicit intents,

          // the snapshot reflects the cron's own provider — NOT the agent's

          // — so other readers (session details panel, history view) see

          // an accurate record of what config the run actually used. This

          // also lets the unified `resolveSessionConfig` path read back the

          // right values without intent-aware branching at read time.

          // PRD 0.2.9 — When `providerId` is set on the payload, the

          // session metadata snapshot tracks it (so the resolved env can

                  // be re-derived per tick by the runtime resolver), and

          // pre-#119 fields are explicitly cleared. This precedence runs

          // BEFORE the legacy intent path below so a corrupt payload

          // carrying both `providerId` and `providerEnv` can't poison the

          // snapshot with the latter (Codex P2.1 finding).

          if (payload.providerId) {

            cronSnapshot.providerId = payload.providerId;

            cronSnapshot.providerEnvJson = undefined;

            if (payload.model) cronSnapshot.model = payload.model;

          } else {

            const cronIntent = payload.providerIntent ?? 'followAgent';

            if (cronIntent === 'explicit' && payload.providerEnv) {

              cronSnapshot.providerId = undefined;

              cronSnapshot.providerEnvJson = JSON.stringify(payload.providerEnv);

              if (payload.model) cronSnapshot.model = payload.model;

            }

            // FollowAgent (legacy): cronSnapshot keeps the agent's values verbatim.

          }

          // D20: builtin is the only runtime. An explicit per-task override is

          // preserved on disk verbatim (config compat) but ignored at run time.

          if (payload.runtime) cronSnapshot.runtime = payload.runtime;

          // PRD 0.2.4 §需求 4 — stamp per-task MCP override into the new

          // session's metadata BEFORE creation, so the session is born with

          // the right MCP set. The setMcpServers() call further down still

          // runs for safety, but for new_session mode it's typically a

          // no-op because the snapshot already matches the override.

          if (payload.mcpEnabledServers !== undefined) {

            cronSnapshot.mcpEnabledServers = payload.mcpEnabledServers;

          }

          // Rust rotates a fresh UUID per tick for new_session mode (see

          // cron_task.rs::rotate_new_session_id) and passes it as

          // payload.sessionId. Honour that id here — if we generated our

          // own instead, Rust's ManagedSidecar registry would be keyed by

          // the Rust-chosen id while the actual running session used a

          // different Bun-chosen id, and opening the session via history

          // would spawn a duplicate read-only sidecar (Bug A, v0.1.69).

          //

          // Fallback to a fresh random id only when payload.sessionId is

          // missing — keeps backward-compat with older Rust builds that

          // didn't pre-generate the id.

          if (sessionId) {

            cronSnapshot.id = sessionId;

          }

          const newSession = await createSession(agentDir, cronSnapshot);

          const switched = await switchPiSession(newSession.id);

          if (!switched) {

            console.error(`[cron] execute-sync taskId=${taskId} failed to switch to new session ${newSession.id}`);

            return jsonResponse({ success: false, error: 'Failed to create new session for execution.' }, 500);

          }

          effectiveSessionId = newSession.id;

          console.log(`[cron] execute-sync taskId=${taskId} new_session mode: created fresh session ${newSession.id} (from=${sessionId ? 'rust-payload' : 'bun-fallback'})`);

        } else if (sessionId) {

          // single_session mode: switch to the task's stored session (keeps context)

          // If already in the target session, skip switchToSession to avoid aborting

          // an active AI response and clearing the message queue.

          const currentSessionId = getSessionId();

          if (currentSessionId === sessionId) {

            console.log(`[cron] execute-sync taskId=${taskId} single_session mode: already in session ${sessionId}, skipping switch`);

          } else {

            console.log(`[cron] execute-sync taskId=${taskId} attempting to switch to session ${sessionId}`);

            const switched = await switchPiSession(sessionId);

            if (!switched) {

              console.warn(`[cron] execute-sync taskId=${taskId} failed to switch to session ${sessionId}, will use current session instead`);

              // Log current session state for debugging

              const currentState = getPiAgentState();

              console.log(`[cron] execute-sync taskId=${taskId} current session state: agentDir=${currentState.agentDir}, sessionState=${currentState.sessionState}, hasInitialPrompt=${currentState.hasInitialPrompt}`);

            } else {

              console.log(`[cron] execute-sync taskId=${taskId} single_session mode: switched to session ${sessionId}`);

            }

          }

        } else {

          console.log(`[cron] execute-sync taskId=${taskId} no sessionId provided, using current session`);

        }



        // ── Intent-driven resolution (PRD #119, 2026-05) ──────────────────

        //

        // Cron tasks declare their routing intent explicitly. Three branches:

        //

        //   - `explicit` — cron uses the captured `providerEnv` regardless of

        //     what the agent currently looks like. effectiveProviderEnv is

        //     forced to payload.providerEnv; agent's `providerEnvJson` is

        //     IGNORED. effectiveModel comes from payload.

        //

        //   - `explicit`     — cron uses its own captured providerEnv. Snapshot

        //     is bypassed entirely. effectiveModel + effectiveProviderEnv come

        //     from payload, atomic. (Pre-#119 the handler re-resolved from the

        //     agent snapshot, which silently overwrote providerEnv with the

        //     agent's even though model came from the cron — model+endpoint

        //     mismatch → 400 + silent empty output.)

        //

        //   - `followAgent`  — pre-#119 default. Read the session snapshot,

        //     fall back to agent for unset fields. Behavior preserved for

        //     legacy crons (those persisted before #119 deserialize as

        //     `followAgent` via serde default).

        //

        // The snapshot itself was already updated above for new_session mode

        // to match intent, so a future read still returns coherent values —

        // but we don't rely on that here; we drive directly from intent +

        // payload so single_session and new_session behave identically.

        //

        // permissionMode override is intent-independent: it overrides the

        // resolved value if payload.permissionMode is set, else falls back

        // to the resolver / runtime default.

        // PRD 0.2.9: provider routing precedence — see /cron/execute above

        // for the full design comment. providerId (new) > providerIntent

        // (legacy #119) > followAgent (default).

        const intent = payload.providerIntent ?? 'followAgent';



        let effectiveModel = model;

        let effectiveProviderEnv: ProviderEnv | undefined = providerEnv;

        let effectiveRuntimeConfig = payload.runtimeConfig;



        if (payload.providerId) {

          // PRD 0.2.9 — Per-tick live-resolve.

          try {

            effectiveProviderEnv = resolveCronProviderRouting(payload.providerId);

          } catch (e) {

            const errMsg = e instanceof Error ? e.message : String(e);

            console.error(`[cron] execute-sync: provider resolution failed for '${payload.providerId}': ${errMsg}`);

            clearCronTaskContext(effectiveSessionId);

            resetInteractionScenario();

            return jsonResponse({ success: false, error: errMsg }, 400);

          }

          if (payload.model) effectiveModel = payload.model;

          // Issue #204: defense-in-depth for tasks landing

          // on a non-followAgent intent. Always construct (not gated on

          // existence), and let canonical `runtimeConfig.model` win over

          // CLI-shorthand `payload.model` over any pre-existing value.

          effectiveRuntimeConfig = {

            ...(payload.runtimeConfig ?? {}),

            model: payload.runtimeConfig?.model ?? payload.model ?? effectiveRuntimeConfig?.model,

            permissionMode: payload.runtimeConfig?.permissionMode ?? payload.permissionMode ?? effectiveRuntimeConfig?.permissionMode,

          };

          console.log(`[cron] execute-sync providerId=${payload.providerId} resolved=${effectiveProviderEnv?.baseUrl ?? 'anthropic'} runMode=${effectiveRunMode} model=${effectiveModel ?? 'default'}`);

        } else if (intent === 'followAgent') {

          // Legacy snapshot-based resolution.

          const snapshotSessionId = effectiveSessionId ?? getSessionId();

          if (snapshotSessionId) {

            const sessionMeta = getSessionMetadata(snapshotSessionId);

            const agent = findAgentByWorkspacePath(agentDir) as AgentConfig | undefined;

            if (sessionMeta && agent) {

              const resolved = resolveSessionConfig(sessionMeta, agent, undefined, 'owned');

              if (resolved.model !== undefined) effectiveModel = resolved.model;

              if (resolved.providerEnvJson) {

                // Snapshot gate: see /cron/execute above. decodeProviderEnvSnapshot

                // refuses the snapshot when providerId is globally disabled.

                const decoded = decodeProviderEnvSnapshot(resolved.providerEnvJson, resolved.providerId);

                if (decoded) {

                  effectiveProviderEnv = decoded as ProviderEnv;

                } else if (resolved.providerId && isProviderDisabled(resolved.providerId)) {

                  console.warn(`[cron] execute-sync followAgent: provider ${resolved.providerId} is globally disabled — refusing frozen snapshot for session ${snapshotSessionId}`);

                } else {

                  console.warn(`[cron] execute-sync followAgent: failed to decode providerEnvJson for session ${snapshotSessionId}, falling back to task-frozen value`);

                }

              } else if (resolved.providerId) {

                // Issue #197 — see /cron/execute above for the full rationale.

                // Agent persists `providerId` (post-PRD 0.2.9 canonical state)

                // but rarely a frozen `providerEnvJson`. Live-resolve env from

                // providerId so the SDK gets the right credentials instead of

                // falling back to no provider with empty apiKey.

                try {

                  const env = resolveProviderEnv(resolved.providerId);

                  if (env) {

                    effectiveProviderEnv = env as ProviderEnv;

                    if (effectiveModel === undefined) {

                      const provider = findProvider(resolved.providerId);

                      const primary = provider

                        ? (provider as Record<string, unknown>).primaryModel as string | undefined

                        : undefined;

                      if (primary) effectiveModel = primary;

                    }

                  }

                } catch (e) {

                  console.warn(`[cron] execute-sync followAgent: failed to live-resolve providerId='${resolved.providerId}' for session ${snapshotSessionId}`, e);

                }

              }

              console.log(`[cron] execute-sync intent=followAgent session=${snapshotSessionId} runMode=${effectiveRunMode} snapshotLocked=${Boolean(sessionMeta.configSnapshotAt)} model=${effectiveModel ?? 'default'}`);

            }

          }

          // #119 followAgent backward-compat: pre-#119 the pragmatic fix

          // (commit 502f89c3) re-applied payload.model + payload.providerEnv

          // AFTER snapshot resolve so legacy crons that captured those at

          // schedule time still won the model+provider-bundle race against

          // a later-changed agent. We preserve that behavior here for any

          // cron that deserialized as `followAgent` (legacy default) but

          // still has explicit payload.* values — without it, those tasks

          // regress to following the agent snapshot they explicitly tried

          // to override.

          if (payload.model) effectiveModel = payload.model;

          if (payload.providerEnv) effectiveProviderEnv = payload.providerEnv;

        } else if (intent === 'explicit') {

          // Cron explicitly wants its captured provider — never inherit from agent.

          // payload.providerEnv MUST be present. A missing providerEnv with

          // explicit intent is a malformed task — fail closed rather than

          // silently routing the cron's model to a different upstream

          // (agent snapshot). This is the #119 root cause:

          // model and provider are an atomic routing bundle.

          if (!payload.providerEnv) {

            console.error(`[cron] execute-sync intent=explicit but payload.providerEnv is missing — refusing to run (would mismatch model+endpoint)`);

            clearCronTaskContext(effectiveSessionId);

            resetInteractionScenario();

            return jsonResponse({

              success: false,

              error: 'Cron task has explicit provider intent but no providerEnv — task data is malformed. Re-create the task.',

            }, 400);

          }

          effectiveProviderEnv = payload.providerEnv;

          if (payload.model) effectiveModel = payload.model;

          // Issue #204: defense-in-depth for tasks landing

          // on a non-followAgent intent. Always construct (not gated on

          // existence), and let canonical `runtimeConfig.model` win over

          // CLI-shorthand `payload.model` over any pre-existing value.

          effectiveRuntimeConfig = {

            ...(payload.runtimeConfig ?? {}),

            model: payload.runtimeConfig?.model ?? payload.model ?? effectiveRuntimeConfig?.model,

            permissionMode: payload.runtimeConfig?.permissionMode ?? payload.permissionMode ?? effectiveRuntimeConfig?.permissionMode,

          };

          // Type-narrow for the log: the explicit branch can only land on a

          // ProviderEnv object (assigned just above from `payload.providerEnv`,

          // which the early-return refuses to be undefined). Mirror the

          // shape used at the providerId branch for consistency, including

          // the `'anthropic'` fallback when `baseUrl` is omitted.

          console.log(`[cron] execute-sync intent=explicit runMode=${effectiveRunMode} model=${effectiveModel ?? 'default'} provider=${(effectiveProviderEnv as ProviderEnv | undefined)?.baseUrl ?? 'anthropic'}`);

        }



        // Permission mode override is intent-independent.

        if (payload.permissionMode) {

          effectiveRuntimeConfig = {

            ...(effectiveRuntimeConfig ?? {}),

            permissionMode: payload.permissionMode,

          };

        }



        // Set cron task context so the exit_cron_task tool knows which task is running

        // Pass sessionId for proper isolation between concurrent tasks

        setCronTaskContext(taskId, aiCanExit ?? false, effectiveSessionId);

        console.log(`[cron] execute-sync: cron context set for taskId=${taskId}`);



        // Set System Prompt append for cron task context

        // Set interaction scenario for cron task (L1 + L2-desktop + L3-cron)

        try {

          setInteractionScenario({

            type: 'cron',

            taskId,

            intervalMinutes: intervalMinutes ?? 15,

            aiCanExit: aiCanExit ?? false,

          });

          console.log('[cron] execute-sync: interaction scenario set');

        } catch (e) {

          console.error('[cron] execute-sync: error setting interaction scenario', e);

          clearCronTaskContext(effectiveSessionId);

          return jsonResponse({ success: false, error: `System prompt error: ${e}` }, 500);

        }



        try {

          console.log(`[cron] execute-sync taskId=${taskId} runMode=${effectiveRunMode} interval=${intervalMinutes}min exec#${executionNumber} aiCanExit=${aiCanExit ?? false} prompt="${prompt.slice(0, 100)}..."`);



          // Enqueue the message (this starts the async execution)

          // Wrap cron prompt so AI recognizes it as system-triggered (not a real-time human message)

          const wrappedPrompt = `<system-reminder>\n<CRON_TASK>\n${prompt}\n</CRON_TASK>\n</system-reminder>`;

          console.log('[cron] execute-sync: about to enqueue user message');



          let textContent = '';



          // PRD 0.2.5 R2 — unified "user didn't pick → runtime max" resolver.

          // Sentinels for "didn't pick" are undefined and empty string.

          // Concrete values (auto/plan/fullAgency/default/etc.) are respected

          // literally. See src/shared/types/runtime.ts::resolveCronPermissionMode.

          const effectivePermissionMode = resolveCronPermissionMode(

            payload.permissionMode,

            effectiveRuntimeConfig?.permissionMode,

            'builtin',

          );



          // ─── Builtin runtime (D20: external branch removed) ───

          {



            // PRD 0.2.4 §需求 4 — reconcile MCP set + run the turn under

            // a single locked critical section so two concurrent cron

            // ticks never interleave their abort/restart with each

            // other's in-flight turn (cross-review B5).

            //

            // Target MCP set:

            //   1. Task carries an override → apply that exact list.

            //   2. Task has no override ("follow Agent") → reconcile to

            //      the workspace's effective MCP. This is critical because

            //      `currentMcpServers` is module-global state that the

            //      previous task's override may have mutated. Without an

            //      explicit reset, "follow Agent" silently inherits the

            //      previous task's override (cross-review B1).

            //

            // The helper is fingerprint-gated, so when the desired set

            // already matches `currentMcpServers` it's a cheap no-op.

            let target: McpServerDefinition[];

            if (payload.mcpEnabledServers !== undefined) {

              const overrideIds = new Set(payload.mcpEnabledServers);

              // Prefer `currentMcpServers` (set by frontend's /api/mcp/set)

              // when its IDs cover all override IDs. Sidecar's

              // `getAllMcpServers()` and the renderer's mcpService produce

              // McpServerDefinition objects with subtly different env/args

              // shapes, and feeding sidecar-shaped definitions back through

              // `applyMcpOverrideAndAwaitReady` triggers a fingerprint

              // mismatch → abort+restart that wastes ~5s on the launcher

              // cron handoff. When the frontend already pushed shapes that

              // cover the override set, reusing those keeps the fingerprint

              // stable and the call becomes a cheap no-op.

              const fromCurrent = (getCurrentMcpServers() ?? []).filter(

                (s) => overrideIds.has(s.id),

              );

              if (fromCurrent.length === overrideIds.size) {

                target = fromCurrent;

              } else {

                const allServers = getAllMcpServers();

                target = allServers.filter((s) => overrideIds.has(s.id));

              }

              console.log(

                `[cron] execute-sync taskId=${taskId} applying task MCP override: [${

                  target.map((s) => s.id).join(',') || '(empty)'

                }]`,

              );

            } else {

              // No override → reconcile to workspace effective MCP so a

              // previous task's override doesn't leak into this run.

              target = getEffectiveMcpServers(agentDir);

            }



            // Apply MCP set first (this may abort + restart the session;

            // the outer `withCronDispatchLock` keeps two concurrent ticks

            // from interleaving across the abort/restart window).

            await applyMcpOverrideAndAwaitReady(target);



            // PRD 0.2.5 R2: effectivePermissionMode resolved above via

            // resolveCronPermissionMode.

            // T15: effectiveModel / effectiveProviderEnv come from the session snapshot

            //      (single_session) or payload defaults (new_session / fallback).

            // M4c: cron 同步执行迁移到 pi 引擎(send-and-wait,含完成等待)。

            const piRun = await sendPiChatMessageAndWait(

              { text: wrappedPrompt, model: effectiveModel, providerEnv: effectiveProviderEnv, permissionMode: effectivePermissionMode },

              3600000,

            );

            console.log('[cron] execute-sync: pi turn done, textLen:', piRun.text.length, 'error:', piRun.error ?? 'none');



            // pi send-and-wait 已含完成等待;超时/错误在此收尾。

            if (piRun.error) {

              console.warn(`[cron] execute-sync taskId=${taskId} failed: ${piRun.error}`);

              clearCronTaskContext(effectiveSessionId);

              resetInteractionScenario();

              return jsonResponse({ success: false, error: piRun.error }, 408);

            }

            textContent = piRun.text;

          }



          // Check if AI requested exit (works for both runtimes — checks text patterns)

          let aiRequestedExit = false;

          let exitReason: string | undefined;



          if (textContent) {

            const completionMatch = textContent.match(CRON_TASK_COMPLETE_PATTERN);

            if (completionMatch) {

              aiRequestedExit = true;

              exitReason = completionMatch[1].trim();

            }

          }



          // Clear cron task context after execution

          clearCronTaskContext(effectiveSessionId);

          // Reset scenario — already consumed by startStreamingSession() at session creation

          resetInteractionScenario();



          console.log(`[cron] execute-sync taskId=${taskId} completed, aiRequestedExit=${aiRequestedExit}, exitReason=${exitReason}`);



          // Return the Sidecar session ID (our internal storage key) so Rust can

          // pass it to frontend for loading conversation data from our message store.

          const actualSessionId = getSessionId();



          const response = {

            success: true,

            aiRequestedExit,

            exitReason,

            outputText: textContent || undefined,

            sessionId: actualSessionId,

          };

          console.log(`[cron] execute-sync taskId=${taskId} returning response:`, JSON.stringify(response));

          return jsonResponse(response);

        } catch (error) {

          // Clear context on error

          clearCronTaskContext(effectiveSessionId);

          resetInteractionScenario();

          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          console.error(`[cron] execute-sync taskId=${taskId} error:`, error);

          const errorResponse = { success: false, error: errorMessage };

          console.log(`[cron] execute-sync taskId=${taskId} returning error response:`, JSON.stringify(errorResponse));

          return jsonResponse(errorResponse, 500);

        }

        }); // end withCronDispatchLock

      }



      // ============= GLOBAL STATS API =============



      // GET /api/global-stats?range=7d|30d|60d - Aggregated token usage across all sessions

      if (pathname === '/api/global-stats' && request.method === 'GET') {

        try {

          const range = url.searchParams.get('range') || '30d';

          if (!['7d', '30d', '60d'].includes(range)) {

            return jsonResponse({ success: false, error: 'Invalid range. Use 7d, 30d, or 60d.' }, 400);

          }



          const allSessions = getAllSessionMetadata();



          // Filter sessions by time range using lastActiveAt as a coarse pre-filter

          const now = Date.now();

          const rangeDays = range === '7d' ? 7 : range === '30d' ? 30 : 60;

          const cutoff = now - rangeDays * 86400_000;



          const sessions = allSessions.filter(s => new Date(s.lastActiveAt).getTime() >= cutoff);



          // Helper: convert ISO timestamp to local date string "YYYY-MM-DD"

          const toLocalDate = (isoStr: string): string => {

            const d = new Date(isoStr);

            const y = d.getFullYear();

            const mo = String(d.getMonth() + 1).padStart(2, '0');

            const day = String(d.getDate()).padStart(2, '0');

            return `${y}-${mo}-${day}`;

          };



          // Cutoff as YYYY-MM-DD for cheap string comparison against each message's local

          // date. Pre-2026-04 the summary numbers came from session-lifetime `s.stats` and

          // ignored cutoff entirely — that produced "summary says 31.5M tokens, daily chart

          // says 5M" mismatches because the summary leaked all historical totals from any

          // recently-active session. Now ALL summary/daily/byModel aggregations are derived

          // from the same in-range message walk so they stay consistent.

          const cutoffDateStr = toLocalDate(new Date(cutoff).toISOString());



          const totalSessions = sessions.length;

          let messageCount = 0;

          let totalInputTokens = 0;

          let totalOutputTokens = 0;

          let totalCacheReadTokens = 0;

          let totalCacheCreationTokens = 0;



          // Single pass through messages: aggregate summary + daily + byModel together so

          // they're guaranteed to agree about what falls inside the range.

          const dailyMap: Record<string, { inputTokens: number; outputTokens: number; messageCount: number }> = {};

          const byModel: Record<string, {

            inputTokens: number;

            outputTokens: number;

            cacheReadTokens: number;

            cacheCreationTokens: number;

            count: number;

          }> = {};



          for (const s of sessions) {

            const sessionData = getSessionData(s.id);

            if (!sessionData) continue;



            let lastUserDate = toLocalDate(s.createdAt); // fallback date for first assistant msg



            for (const msg of sessionData.messages) {

              // Determine each message's local date so summary and chart agree on cutoff.

              let msgDate: string;

              if (msg.role === 'user') {

                msgDate = msg.timestamp ? toLocalDate(msg.timestamp) : lastUserDate;

                lastUserDate = msgDate;

              } else if (msg.role === 'assistant') {

                msgDate = msg.timestamp ? toLocalDate(msg.timestamp) : lastUserDate;

              } else {

                continue;

              }

              if (msgDate < cutoffDateStr) continue;



              messageCount++;



              if (msg.role !== 'assistant' || !msg.usage) continue;



              const date = msgDate;

              totalInputTokens += msg.usage.inputTokens ?? 0;

              totalOutputTokens += msg.usage.outputTokens ?? 0;

              totalCacheReadTokens += msg.usage.cacheReadTokens ?? 0;

              totalCacheCreationTokens += msg.usage.cacheCreationTokens ?? 0;



              // Daily aggregation

              if (!dailyMap[date]) {

                dailyMap[date] = { inputTokens: 0, outputTokens: 0, messageCount: 0 };

              }

              dailyMap[date].inputTokens += msg.usage.inputTokens ?? 0;

              dailyMap[date].outputTokens += msg.usage.outputTokens ?? 0;

              dailyMap[date].messageCount++;



              // byModel aggregation

              if (msg.usage.modelUsage) {

                for (const [model, mu] of Object.entries(msg.usage.modelUsage)) {

                  if (!byModel[model]) {

                    byModel[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, count: 0 };

                  }

                  byModel[model].inputTokens += mu.inputTokens ?? 0;

                  byModel[model].outputTokens += mu.outputTokens ?? 0;

                  byModel[model].cacheReadTokens += mu.cacheReadTokens ?? 0;

                  byModel[model].cacheCreationTokens += mu.cacheCreationTokens ?? 0;

                  byModel[model].count++;

                }

              } else {

                const model = msg.usage.model || 'unknown';

                if (!byModel[model]) {

                  byModel[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, count: 0 };

                }

                byModel[model].inputTokens += msg.usage.inputTokens ?? 0;

                byModel[model].outputTokens += msg.usage.outputTokens ?? 0;

                byModel[model].cacheReadTokens += msg.usage.cacheReadTokens ?? 0;

                byModel[model].cacheCreationTokens += msg.usage.cacheCreationTokens ?? 0;

                byModel[model].count++;

              }

            }

          }



          // Sort daily entries chronologically

          const daily = Object.entries(dailyMap)

            .map(([date, d]) => ({ date, ...d }))

            .sort((a, b) => a.date.localeCompare(b.date));



          return jsonResponse({

            success: true,

            stats: {

              summary: {

                totalSessions,

                messageCount,

                totalInputTokens,

                totalOutputTokens,

                totalCacheReadTokens,

                totalCacheCreationTokens,

              },

              daily,

              byModel,

            },

          });

        } catch (error) {

          console.error('[global-stats] Error:', error);

          return jsonResponse({

            success: false,

            error: error instanceof Error ? error.message : 'Unknown error',

          }, 500);

        }

      }



      // ============= SESSION API =============



      // GET /sessions - List all sessions or filter by agentDir

      if (pathname === '/sessions' && request.method === 'GET') {

        try {

          const agentDirParam = url.searchParams.get('agentDir');

          const sessions = agentDirParam

            ? getSessionsByAgentDir(agentDirParam)

            : getAllSessionMetadata().filter(s => isDesktopSessionSource(s.source));

          // Zero-trust: strip providerEnvJson before handing to clients.

          // Matches PATCH response behavior (see PATCH /sessions/:id).

          const safeSessions = sessions

            .map(normalizeSessionListPreview)

            .map(redactSessionMetadata);

          return jsonResponse({ success: true, sessions: safeSessions });

        } catch (error) {

          console.error('[sessions] Error in GET /sessions:', error);

          return jsonResponse({

            success: false,

            error: error instanceof Error ? error.message : 'Unknown error in SessionStore'

          }, 500);

        }

      }



      // POST /sessions - Create a new session

      if (pathname === '/sessions' && request.method === 'POST') {

        let payload: { agentDir: string; runtime?: string; scenario?: string };

        try {

          payload = (await request.json()) as { agentDir: string; runtime?: string; scenario?: string };

        } catch {

          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);

        }



        const agentDirValue = payload?.agentDir?.trim();

        if (!agentDirValue) {

          return jsonResponse({ success: false, error: 'agentDir is required.' }, 400);

        }



        // Use the shared VALID_RUNTIMES constant — same list that drives

        // admin-api validation and HELP_TEXTS. A local literal here used to

        // silently drift when new runtimes landed.

        const runtimeValue = (VALID_RUNTIMES as readonly string[]).includes(payload?.runtime as string)

          ? (payload.runtime as import('../shared/types/runtime').RuntimeType)

          : undefined;

        // v0.1.69 Desktop session = owned snapshot. Capture model/permission/mcp/provider

        // from AgentConfig so the session is self-contained from creation onward.

        // D20: a runtime override in the payload is preserved on disk verbatim

        // (config compat) but has no effect — builtin is the only runtime.

        const agent = findAgentByWorkspacePath(agentDirValue) as AgentConfig | undefined;

        const baseSnapshot: Partial<SessionMetadata> = agent ? snapshotForOwnedSession(agent) : {};

        if (runtimeValue) baseSnapshot.runtime = runtimeValue;

        // 安全研究员版 P1 S1 — `zhishi agent` CLI 在 payload 里声明
        // scenario:'security'；落进会话元数据（snapshot），startStreamingSession
        // 每个 turn 按元数据恢复 InteractionScenario（不落全局 currentScenario）。
        // 未知/缺失的 scenario 值静默忽略 = desktop 场景（现状不变）。

        if (payload?.scenario === 'security') baseSnapshot.interactionScenario = 'security';

        const session = await createSession(agentDirValue, baseSnapshot);

        return jsonResponse({ success: true, session });

      }



      // GET /sessions/:id/since/:lastMessageId - Incremental tail fetch

      // Called by the cron:execution-complete handler to pull only the messages

      // appended by a background task, instead of reloading the whole session.

      // This is what keeps a foreground tab responsive after a background cron

      // task completes: the old full-reload path bundled P0+P1 penalties

      // (base64 attachments + Virtuoso remount) into a single freeze spike.

      // Must be BEFORE the generic /sessions/:id route.

      if (pathname.match(/^\/sessions\/[^/]+\/since\/[^/]+$/) && request.method === 'GET') {

        const match = pathname.match(/^\/sessions\/([^/]+)\/since\/([^/]+)$/);

        if (!match) {

          return jsonResponse({ success: false, error: 'Invalid path.' }, 400);

        }

        const sessionId = decodeURIComponent(match[1]);

        const lastMessageId = decodeURIComponent(match[2]);



        const session = getSessionData(sessionId);

        if (!session) {

          return jsonResponse({ success: false, error: 'Session not found.' }, 404);

        }



        const idx = session.messages.findIndex(m => m.id === lastMessageId);

        // idx === -1 signals "caller's baseline is gone" (session was rewound,

        // compacted, or otherwise rewritten). Caller falls back to full reload.

        if (idx === -1) {

          return jsonResponse({ success: true, fromIndex: -1, messages: [] });

        }



        const tail = shrinkSessionMessagesForClient(session.messages.slice(idx + 1));

        // Same metadata-only shape as GET /sessions/:id (P0) — previews are

        // resolved via the zhishi:// custom protocol on the client.

        return jsonResponse({ success: true, fromIndex: idx, messages: tail });

      }



      // GET /sessions/:id/stats - Get detailed session statistics

      // NOTE: This route must be BEFORE /sessions/:id to avoid being caught by the generic route

      if (pathname.match(/^\/sessions\/[^/]+\/stats$/) && request.method === 'GET') {

        const sessionId = pathname.replace('/sessions/', '').replace('/stats', '');

        if (!sessionId) {

          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);

        }



        const session = getSessionData(sessionId);

        if (!session) {

          return jsonResponse({ success: false, error: 'Session not found.' }, 404);

        }



        // Group stats by model

        const byModel: Record<string, {

          inputTokens: number;

          outputTokens: number;

          cacheReadTokens: number;

          cacheCreationTokens: number;

          count: number;

        }> = {};



        // Build message details

        const messageDetails: Array<{

          userQuery: string;

          model?: string;

          inputTokens: number;

          outputTokens: number;

          cacheReadTokens?: number;

          cacheCreationTokens?: number;

          toolCount?: number;

          durationMs?: number;

        }> = [];



        let currentUserQuery = '';

        for (const msg of session.messages) {

          if (msg.role === 'user') {

            currentUserQuery = typeof msg.content === 'string'

              ? msg.content.slice(0, 100)

              : JSON.stringify(msg.content).slice(0, 100);

          } else if (msg.role === 'assistant' && msg.usage) {

            // Use modelUsage for per-model breakdown if available, fallback to single model

            if (msg.usage.modelUsage) {

              for (const [model, stats] of Object.entries(msg.usage.modelUsage)) {

                if (!byModel[model]) {

                  byModel[model] = {

                    inputTokens: 0,

                    outputTokens: 0,

                    cacheReadTokens: 0,

                    cacheCreationTokens: 0,

                    count: 0,

                  };

                }

                byModel[model].inputTokens += stats.inputTokens ?? 0;

                byModel[model].outputTokens += stats.outputTokens ?? 0;

                byModel[model].cacheReadTokens += stats.cacheReadTokens ?? 0;

                byModel[model].cacheCreationTokens += stats.cacheCreationTokens ?? 0;

                byModel[model].count++;

              }

            } else {

              // Fallback for older messages without modelUsage

              const model = msg.usage.model || 'unknown';

              if (!byModel[model]) {

                byModel[model] = {

                  inputTokens: 0,

                  outputTokens: 0,

                  cacheReadTokens: 0,

                  cacheCreationTokens: 0,

                  count: 0,

                };

              }

              byModel[model].inputTokens += msg.usage.inputTokens ?? 0;

              byModel[model].outputTokens += msg.usage.outputTokens ?? 0;

              byModel[model].cacheReadTokens += msg.usage.cacheReadTokens ?? 0;

              byModel[model].cacheCreationTokens += msg.usage.cacheCreationTokens ?? 0;

              byModel[model].count++;

            }



            // Message details always use aggregate values

            messageDetails.push({

              userQuery: currentUserQuery,

              model: msg.usage.model,

              inputTokens: msg.usage.inputTokens ?? 0,

              outputTokens: msg.usage.outputTokens ?? 0,

              cacheReadTokens: msg.usage.cacheReadTokens,

              cacheCreationTokens: msg.usage.cacheCreationTokens,

              toolCount: msg.toolCount,

              durationMs: msg.durationMs,

            });

          }

        }



        const metadata = getSessionMetadata(sessionId);

        return jsonResponse({

          success: true,

          stats: {

            summary: metadata?.stats ?? {

              messageCount: 0,

              totalInputTokens: 0,

              totalOutputTokens: 0,

            },

            byModel,

            messageDetails,

          },

        });

      }



      // GET /sessions/:id - Get session details

      if (pathname.startsWith('/sessions/') && request.method === 'GET') {

        const sessionId = pathname.replace('/sessions/', '');

        if (!sessionId) {

          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);

        }



        const session = getSessionData(sessionId);

        if (!session) {

          // An active session may not yet have on-disk metadata: builtin can

          // race in the window between Tab open and first persisted turn.

          // Treat the active session as an empty session-in-progress instead

          // of 404 (which the frontend retries, producing log noise).

          if (sessionId === getSessionId()) {

            return jsonResponse({

              success: true,

              session: {

                id: sessionId,

                runtime: 'builtin',

                messages: [],

                liveStreamingMessage: null,

                liveSessionState: undefined,

                totalCount: 0,

                hasMoreBefore: false,

              },

            });

          }

          return jsonResponse({ success: false, error: 'Session not found.' }, 404);

        }



        // Pagination: `?limit=N` returns only the most recent N messages,

        // keeping the first-paint JSON body tiny even for 600-message sessions.

        // `?before=<messageId>` loads the N messages immediately older than the

        // given id, used by the MessageList startReached handler to lazily

        // fetch history as the user scrolls up.

        //

        // Clamp limit to [1, 500]. 0 / missing means "full load" (preserved for

        // callers that genuinely need all messages, e.g. sessions/fork UI).

        const rawLimit = parseInt(url.searchParams.get('limit') ?? '0', 10);

        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 0;

        const before = url.searchParams.get('before');



        const liveStreamingMessage: {

          id: string;

          role: 'assistant';

          content: string;

          timestamp: string;

          sdkUuid?: string;

        } | null = null;



        // If this is the currently active session, merge in-memory messages.

        // In-memory messages include the current turn's in-progress content

        // (thinking, text, tool_use) that hasn't been persisted to disk yet.

        // This is critical for shared Sidecar: when a Tab opens an IM session

        // mid-turn, it needs to see the partial assistant response.

        let mergedMessages = session.messages;

        if (sessionId === getSessionId()) {

          const inMemory = getPiMessages();

          if (inMemory.length > 0) {

            const diskIds = new Set(session.messages.map(m => m.id));

            const newMessages = inMemory
              // tool 消息只进 /chat/stream 回放;本 API(SessionMessage)契约不变。
              .filter(m => !diskIds.has(m.id) && m.role !== 'tool')
              .map(m => ({

                id: m.id,

                role: m.role as 'user' | 'assistant',

                content: m.content,

                timestamp: m.timestamp,

                attachments: m.attachments?.map(a => ({

                  id: a.id,

                  name: a.name,

                  mimeType: a.mimeType,

                  path: '',

                })),

              }));

            if (newMessages.length > 0) {

              mergedMessages = [...session.messages, ...newMessages];

            }

          }

        }



        // Apply pagination slice. hasMoreBefore tells the client whether there

        // are older messages on disk that it could fetch with ?before=.

        const totalCount = mergedMessages.length;

        let paginatedMessages = mergedMessages;

        let hasMoreBefore = false;

        if (limit > 0) {

          if (before) {

            const beforeIdx = mergedMessages.findIndex(m => m.id === before);

            // beforeIdx < 0 is a stale cursor — the client's baseline is gone,

            // so return an empty page and let the client fall back to full load.

            if (beforeIdx < 0) {

              paginatedMessages = [];

              hasMoreBefore = false;

            } else {

              const start = Math.max(0, beforeIdx - limit);

              paginatedMessages = mergedMessages.slice(start, beforeIdx);

              hasMoreBefore = start > 0;

            }

          } else {

            const start = Math.max(0, totalCount - limit);

            paginatedMessages = mergedMessages.slice(start);

            hasMoreBefore = start > 0;

          }

        }



        // Attachments ship as metadata only. Binary previews are served by the

        // Tauri `zhishi://attachment/<path>` custom protocol (zero-copy, no JSON

        // round-trip), keeping the JSON body small even for sessions with dozens

        // of screenshots. Browser dev mode uses the /api/attachment/* fallback

        // route below.

        const sessionWithPreview = {

          ...redactSessionMetadata(session),

          liveStreamingMessage,

          liveSessionState: undefined,

          messages: shrinkSessionMessagesForClient(paginatedMessages),

          totalCount,

          hasMoreBefore,

        };



        return jsonResponse({ success: true, session: sessionWithPreview });

      }



      // DELETE /sessions/:id - Delete a session

      if (pathname.startsWith('/sessions/') && request.method === 'DELETE') {

        const sessionId = pathname.replace('/sessions/', '');

        if (!sessionId) {

          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);

        }



        const deleted = await deleteSession(sessionId);

        if (!deleted) {

          return jsonResponse({ success: false, error: 'Session not found.' }, 404);

        }



        return jsonResponse({ success: true });

      }



      // PATCH /sessions/:id - Update session metadata (incl. v0.1.69 config snapshot)

      if (pathname.startsWith('/sessions/') && request.method === 'PATCH') {

        const sessionId = pathname.replace('/sessions/', '');

        if (!sessionId) {

          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);

        }



        // Snapshot fields (v0.1.69): send `null` to clear (revert to agent fallback);

        // omit a field to leave it unchanged.

        interface PatchPayload {

          title?: string;

          titleSource?: 'default' | 'auto' | 'user';

          /** Pin/unpin to the 收藏 filter view. Storage convention: only

           *  `true` is persisted; `false` is stored as `undefined` so a

           *  freshly toggled-off session matches "never favorited" exactly

           *  on disk. */

          favorite?: boolean;

          model?: string | null;

          permissionMode?: string | null;

          mcpEnabledServers?: string[] | null;

          providerId?: string | null;

          providerEnvJson?: string | null;

        }



        let payload: PatchPayload;

        try {

          payload = (await request.json()) as PatchPayload;

        } catch {

          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);

        }



        // `lastActiveAt` is the recency signal that drives history sort

        // order. Bumping it on EVERY PATCH means a pure-UI flag change

        // (favorite toggle) makes an old session jump to the top of the

        // dropdown — confusing UX (Codex round-4 caught). Only the fields

        // that genuinely represent "session was used" should refresh it.

        const RECENCY_BUMP_FIELDS = new Set([

          'title',           // user-edited title implies engagement

          'titleSource',

          'model',

          'permissionMode',

          'mcpEnabledServers',

          'providerId',

          'providerEnvJson',

        ]);

        const touchedRecencyField = (Object.keys(payload) as Array<keyof PatchPayload>)

          .filter((k) => payload[k] !== undefined)

          .some((k) => RECENCY_BUMP_FIELDS.has(k));



        const updates: Record<string, unknown> = touchedRecencyField

          ? { lastActiveAt: new Date().toISOString() }

          : {};

        if (payload.title !== undefined) updates.title = String(payload.title).slice(0, 100);

        if (payload.titleSource !== undefined) updates.titleSource = payload.titleSource;

        if (payload.favorite !== undefined) {

          // Convert false → undefined so the on-disk shape stays minimal

          // (the JSON serializer drops undefined keys).

          updates.favorite = payload.favorite === true ? true : undefined;

        }



        // Snapshot fields: null → clear (undefined in stored JSON); value → set.

        // `undefined` in stored metadata is how the resolver recognizes "fall back to agent".

        const snapshotKeys = [

          'model',

          'permissionMode',

          'mcpEnabledServers',

          'providerId',

          'providerEnvJson',

        ] as const;

        let wroteSnapshotField = false;

        for (const key of snapshotKeys) {

          const v = payload[key];

          if (v === undefined) continue;

          updates[key] = v === null ? undefined : v;

          wroteSnapshotField = true;

        }



        // Stamp configSnapshotAt on the first snapshot write (lazy migration).

        // Also bumps on subsequent writes — harmless, useful for debugging.

        if (wroteSnapshotField) {

          updates.configSnapshotAt = new Date().toISOString();

        }



        const updated = await updateSessionMetadata(sessionId, updates);



        if (!updated) {

          return jsonResponse({ success: false, error: 'Session not found.' }, 404);

        }



        // Zero-trust: redact credential-bearing fields from the echo payload.

        // The client already owns what it sent; no need to round-trip secrets.

        return jsonResponse({ success: true, session: redactSessionMetadata(updated) });

      }



      // POST /sessions/switch - Switch to existing session for resume

      if (pathname === '/sessions/switch' && request.method === 'POST') {

        let payload: { sessionId?: string };

        try {

          payload = (await request.json()) as { sessionId?: string };

        } catch {

          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);

        }



        if (!payload.sessionId) {

          return jsonResponse({ success: false, error: 'sessionId is required.' }, 400);

        }



        const success = await switchPiSession(payload.sessionId);

        if (!success) {

          return jsonResponse({ success: false, error: 'Session not found.' }, 404);

        }



        console.log(`[sessions] Switched to session: ${payload.sessionId}`);

        return jsonResponse({ success: true, sessionId: payload.sessionId });

      }



      // POST /api/generate-session-title - AI-generate a short session title

      // Accepts `rounds` array (3+ QA rounds) for rich context.

      // Also accepts legacy `userMessage`/`assistantReply` for backward compatibility.

      if (pathname === '/api/generate-session-title' && request.method === 'POST') {

        let payload: {

          sessionId: string;

          rounds?: Array<{ user: string; assistant: string }>;

          // Legacy fields (single-round fallback)

          userMessage?: string;

          assistantReply?: string;

          model: string;

          providerEnv?: ProviderEnv;

        };

        try {

          payload = (await request.json()) as typeof payload;

        } catch {

          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);

        }



        if (!payload.sessionId) {

          return jsonResponse({ success: false, error: 'sessionId is required.' }, 400);

        }



        // Build rounds from payload — prefer `rounds` array, fall back to legacy fields

        let rounds: Array<{ user: string; assistant: string }>;

        if (payload.rounds && Array.isArray(payload.rounds) && payload.rounds.length > 0) {

          // Cap to 10 rounds max, validate shape, enforce length limits

          rounds = payload.rounds.slice(0, 10)

            .filter((r: unknown): r is Record<string, unknown> => r !== null && typeof r === 'object')

            .map(r => ({

              user: (typeof r.user === 'string' ? r.user : '').slice(0, 500),

              assistant: (typeof r.assistant === 'string' ? r.assistant : '').slice(0, 500),

            }));

          if (rounds.length === 0) {

            return jsonResponse({ success: false, error: 'rounds must contain valid entries.' }, 400);

          }

        } else if (payload.userMessage) {

          // Legacy single-round format

          rounds = [{

            user: payload.userMessage.slice(0, 1000),

            assistant: (payload.assistantReply || '').slice(0, 1000),

          }];

        } else {

          return jsonResponse({ success: false, error: 'rounds or userMessage is required.' }, 400);

        }



        payload.model = (payload.model || '').slice(0, 200);



        // Skip if session not found or user has manually renamed

        const meta = getSessionMetadata(payload.sessionId);

        if (!meta) {

          return jsonResponse({ success: false, error: 'Session not found.' }, 404);

        }

        if (meta.titleSource === 'user') {

          return jsonResponse({ success: false, skipped: true });

        }



        // Manual trigger. Delegates to the backend Title Service core

        // (TOCTOU re-check + persist + broadcast), the SAME path the post-turn

        // auto trigger uses — see session-title-service.ts. Model/providerEnv

        // come from the request; agentDir is passed as workspace context.

        const { generateAndApplyTitle } = await import('./session-title-service');

        const title = await generateAndApplyTitle(

          payload.sessionId,

          rounds,

          payload.model || '',

          payload.providerEnv,

          meta.agentDir,

        );

        return title ? jsonResponse({ success: true, title }) : jsonResponse({ success: false });

      }



      // ============= END SESSION API =============



      // Switch agent directory at runtime (for browser development mode)

      if (pathname === '/agent/switch' && request.method === 'POST') {

        let payload: SwitchPayload;

        try {

          payload = (await request.json()) as SwitchPayload;

        } catch {

          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);

        }



        const newDir = payload?.agentDir?.trim();

        if (!newDir) {

          return jsonResponse({ success: false, error: 'agentDir is required.' }, 400);

        }



        // Security: validate the path before allowing access

        const validation = isValidAgentDir(newDir);

        if (!validation.valid) {

          console.warn(`[agent] blocked switch to "${newDir}": ${validation.reason}`);

          return jsonResponse({

            success: false,

            error: validation.reason || 'Invalid directory path'

          }, 403);

        }



        try {

          console.log(`[agent] switch to dir="${newDir}"`);

          currentAgentDir = await ensureAgentDir(newDir);

          await initializeAgent(currentAgentDir, payload.initialPrompt);

          return jsonResponse({

            success: true,

            agentDir: currentAgentDir

          });

        } catch (error) {

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },

            500

          );

        }

      }

















      if (pathname === '/agent/upload' && request.method === 'POST') {

        const targetParam = url.searchParams.get('path') ?? '';

        const resolvedTarget =

          targetParam ? resolveAgentPath(currentAgentDir, targetParam) : currentAgentDir;

        if (!resolvedTarget) {

          return jsonResponse({ error: 'Invalid path.' }, 400);

        }

        try {

          const oversized = rejectIfOversizedUpload(request);

          if (oversized) return oversized;

          const formData = await request.formData();

          const files = Array.from(formData.values()).filter(

            (value) => typeof value !== 'string'

          ) as File[];

          if (files.length === 0) {

            return jsonResponse({ error: 'No files provided.' }, 400);

          }

          await ensureDir(resolvedTarget);

          const saved: string[] = [];

          for (const file of files) {

            const safeName = file.name.replace(/[<>:"/\\|?*]/g, '_');

            const destination = join(resolvedTarget, safeName);

            await streamUploadToFile(file, destination);

            saved.push(relative(currentAgentDir, destination));

          }

          return jsonResponse({ success: true, files: saved });

        } catch (error) {

          return jsonResponse(

            { error: error instanceof Error ? error.message : 'Unknown error' },

            500

          );

        }

      }





















      // ============= FILE MANAGEMENT API =============











      // GET /api/image?path=... - Serve generated images (for browser dev mode)

      if (pathname === '/api/image' && request.method === 'GET') {

        try {

          const imagePath = url.searchParams.get('path');

          if (!imagePath) {

            return jsonResponse({ success: false, error: 'Missing path parameter' }, 400);

          }



          // Security: allow reading from workspace/zhishi_files/{generated_images,temp}/ or legacy paths

          const resolvedPath = resolve(imagePath);

          const legacyDir = join(getZhiShiDataDir(), 'generated');

          const legacyDirSep = legacyDir.endsWith(sep) ? legacyDir : legacyDir + sep;

          // New unified paths + backward compat with zhishi-generated/images/

          const allowedDirs = currentAgentDir ? [

            join(currentAgentDir, 'zhishi_files', 'generated_images'),

            join(currentAgentDir, 'zhishi_files', 'temp'),

            join(currentAgentDir, 'zhishi-generated', 'images'), // backward compat

          ] : [];

          const allowed = resolvedPath.startsWith(legacyDirSep)

            || allowedDirs.some(d => resolvedPath.startsWith(d.endsWith(sep) ? d : d + sep));

          if (!allowed) {

            return jsonResponse({ success: false, error: 'Access denied: path must be within generated directory' }, 403);

          }



          if (!existsSync(resolvedPath)) {

            return jsonResponse({ success: false, error: 'Image not found' }, 404);

          }



          const ext = resolvedPath.split('.').pop()?.toLowerCase();

          const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';



          const resp = await fileResponse(resolvedPath, {

            contentType: mimeType,

            headers: { 'Cache-Control': 'public, max-age=86400' },

          });

          return resp ?? jsonResponse({ success: false, error: 'Image not found' }, 404);

        } catch (error) {

          console.error('[api/image] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to serve image' },

            500

          );

        }

      }



      // GET /api/audio?path=... - Serve generated audio (for browser dev mode)

      if (pathname === '/api/audio' && request.method === 'GET') {

        try {

          const audioPath = url.searchParams.get('path');

          if (!audioPath) {

            return jsonResponse({ success: false, error: 'Missing path parameter' }, 400);

          }



          // Security: allow reading from workspace/zhishi_files/generated_audio/ or legacy paths

          const resolvedPath = resolve(audioPath);

          const legacyAudioDir = join(getZhiShiDataDir(), 'generated_audio');

          const legacyAudioDirSep = legacyAudioDir.endsWith(sep) ? legacyAudioDir : legacyAudioDir + sep;

          // New unified path + backward compat with zhishi-generated/audio/

          const allowedAudioDirs = currentAgentDir ? [

            join(currentAgentDir, 'zhishi_files', 'generated_audio'),

            join(currentAgentDir, 'zhishi-generated', 'audio'), // backward compat

          ] : [];

          const audioAllowed = resolvedPath.startsWith(legacyAudioDirSep)

            || allowedAudioDirs.some(d => resolvedPath.startsWith(d.endsWith(sep) ? d : d + sep));

          if (!audioAllowed) {

            return jsonResponse({ success: false, error: 'Access denied: path must be within generated_audio directory' }, 403);

          }



          if (!existsSync(resolvedPath)) {

            return jsonResponse({ success: false, error: 'Audio not found' }, 404);

          }



          const ext = resolvedPath.split('.').pop()?.toLowerCase();

          const mimeTypes: Record<string, string> = {

            mp3: 'audio/mpeg',

            wav: 'audio/wav',

            ogg: 'audio/ogg',

            webm: 'audio/webm',

            opus: 'audio/opus',

            aac: 'audio/aac',

            m4a: 'audio/mp4',

          };

          const mimeType = mimeTypes[ext || ''] || 'audio/mpeg';



          const resp = await fileResponse(resolvedPath, {

            contentType: mimeType,

            headers: { 'Cache-Control': 'public, max-age=86400' },

          });

          return resp ?? jsonResponse({ success: false, error: 'Audio not found' }, 404);

        } catch (error) {

          console.error('[api/audio] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to serve audio' },

            500

          );

        }

      }



      // ============= END FILE MANAGEMENT API =============



      // ============= UNIFIED LOGGING API =============



      // POST /api/unified-log - Receive frontend logs for persistence

      if (pathname === '/api/unified-log' && request.method === 'POST') {

        try {

          const payload = await request.json() as {

            entries?: Array<{

              source: 'react' | 'bun' | 'rust';

              level: 'info' | 'warn' | 'error' | 'debug';

              message: string;

              timestamp: string;

            }>;

          };



          if (payload.entries && Array.isArray(payload.entries)) {

            appendUnifiedLogBatch(payload.entries);

          }



          return jsonResponse({ success: true });

        } catch (error) {

          return jsonResponse({

            success: false,

            error: error instanceof Error ? error.message : 'Failed to log'

          }, 500);

        }

      }



      // GET /api/logs/export - Export recent unified logs as zip

      if (pathname === '/api/logs/export' && request.method === 'GET') {

        try {

          const { readdirSync, statSync } = await import('fs');

          const { join: joinPath } = await import('path');

          const { homedir } = await import('os');

          const logsDir = joinPath(getZhiShiDataDir(), 'logs');



          // Collect last 3 days of unified-*.log files

          const now = Date.now();

          const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

          const files = readdirSync(logsDir)

            .filter(f => f.startsWith('unified-') && f.endsWith('.log'))

            .filter(f => {

              try {

                return now - statSync(joinPath(logsDir, f)).mtimeMs < threeDaysMs;

              } catch { return false; }

            })

            .sort();



          if (files.length === 0) {

            return jsonResponse({ success: false, error: '没有找到近3天的运行日志' }, 404);

          }



          // Output to Desktop

          const desktopDir = joinPath(homedir(), 'Desktop');

          const timestamp = new Date().toISOString().slice(0, 10);

          const zipName = `ZhiShi-logs-${timestamp}.zip`;

          const zipPath = joinPath(desktopDir, zipName);



          // Create zip using platform-appropriate command

          const isWin = process.platform === 'win32';

          const filePaths = files.map(f => joinPath(logsDir, f));



          // stdout/stderr must be ignored — zip/Compress-Archive emit per-file progress

          // that can exceed the 64KB pipe buffer on large log sets and deadlock the

          // child waiting for us to read.

          if (isWin) {

            const { default: AdmZip } = await import('adm-zip');

            const zip = new AdmZip();

            for (const filePath of filePaths) {

              zip.addLocalFile(filePath);

            }

            zip.writeZip(zipPath);

          } else {

            // macOS/Linux: zip command

            const proc = subprocessSpawn(['zip', '-j', zipPath, ...filePaths], {

              stdout: 'ignore',

              stderr: 'ignore',

            });

            await proc.exited;

          }



          return jsonResponse({ success: true, path: zipPath });

        } catch (error) {

          return jsonResponse({

            success: false,

            error: error instanceof Error ? error.message : 'Failed to export logs'

          }, 500);

        }

      }



      // ============= PROVIDER VERIFICATION API =============



      // POST /api/provider/verify - Verify API key via SDK (same path as normal chat)

      if (pathname === '/api/provider/verify' && request.method === 'POST') {

        try {

          const payload = await request.json() as {

            baseUrl?: string;

            apiKey?: string;

            model?: string;

            authType?: string;

            apiProtocol?: string;

            maxOutputTokens?: number;

            maxOutputTokensParamName?: string;

            upstreamFormat?: string;

          };



          const { baseUrl, apiKey, model, authType, apiProtocol, maxOutputTokens, maxOutputTokensParamName, upstreamFormat } = payload;



          if (!baseUrl || !apiKey) {

            return jsonResponse({ success: false, error: 'baseUrl and apiKey are required.' }, 400);

          }



          console.log(`[api/provider/verify] =========================`);

          console.log(`[api/provider/verify] baseUrl: ${baseUrl}`);

          console.log(`[api/provider/verify] apiKey: ${apiKey.slice(0, 10)}...`);

          console.log(`[api/provider/verify] model: ${model ?? 'default'}`);

          console.log(`[api/provider/verify] authType: ${authType ?? 'both'}`);

          console.log(`[api/provider/verify] apiProtocol: ${apiProtocol ?? 'anthropic'}`);

          console.log(`[api/provider/verify] maxOutputTokens: ${maxOutputTokens ?? 'none'}`);



          // Unified SDK verification for all protocols (Anthropic + OpenAI)

          // For OpenAI protocol: SDK → CLI → bridge loopback → upstream (end-to-end)

          // For Anthropic protocol: SDK → CLI → upstream (same as before)

          const result = await verifyProviderViaSdk(

            baseUrl, apiKey, authType ?? 'both', model || undefined,

            apiProtocol === 'openai' ? 'openai' : undefined,

            maxOutputTokens,

            maxOutputTokensParamName as 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens' | undefined,

            upstreamFormat === 'responses' ? 'responses' : undefined,

          );



          console.log(`[api/provider/verify] result:`, JSON.stringify(result));

          console.log(`[api/provider/verify] =========================`);



          return jsonResponse(result);

        } catch (error) {

          console.error('[api/provider/verify] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Verification failed' },

            500

          );

        }

      }







      // GET /api/assets/qr-code - Fetch QR code image with local caching

      // Downloads from CDN on first launch and caches locally for subsequent requests

      // Cache refreshes every hour to get updated QR codes from cloud

      if (pathname === '/api/assets/qr-code' && request.method === 'GET') {

        try {

          // Public Admin Service endpoint that returns the current community QR
          // code image URL. The URL can be overridden for local/self-hosted setups.

          const QR_CODE_API_URL = process.env.ZHISHI_QR_CODE_API_URL || 'https://ticket.zhishi.help/api/v1/community-qr';



          const startTime = Date.now();



          // 1. Fetch current image URL from Admin Service (lightweight JSON call)

          const configController = new AbortController();

          const configTimeoutId = setTimeout(() => configController.abort(), 10000);

          const configResponse = await fetch(QR_CODE_API_URL, { signal: configController.signal });

          clearTimeout(configTimeoutId);



          if (!configResponse.ok) {

            throw new Error(`配置获取失败: HTTP ${configResponse.status}`);

          }



          const configData = await configResponse.json() as { image_url?: string; updated_at?: string };

          const imageUrl = configData.image_url?.trim();
          const serverUpdatedAt = configData.updated_at || '';



          if (!imageUrl) {

            console.log('[api/assets/qr-code] No QR code configured on server');

            return jsonResponse({ success: false, error: '暂无二维码' }, 503);

          }



          // 2. Determine MIME type from the image URL extension for correct data: URL

          const urlPath = imageUrl.split('?')[0].toLowerCase();

          let mimeType = 'image/png';

          if (urlPath.endsWith('.jpg') || urlPath.endsWith('.jpeg')) mimeType = 'image/jpeg';

          else if (urlPath.endsWith('.webp')) mimeType = 'image/webp';

          else if (urlPath.endsWith('.gif')) mimeType = 'image/gif';



          // Use a cache file keyed by MIME category so format changes don't reuse wrong extension

          const ext = mimeType.split('/')[1] || 'png';

          const CACHE_DIR = join(tmpdir(), 'zhishi-cache');

          const CACHE_FILE = join(CACHE_DIR, `community-qr.${ext}`);

          const CACHE_META_FILE = `${CACHE_FILE}.meta.json`;

          const LOCK_FILE = `${CACHE_FILE}.lock`;



          let needsDownload = true;



          // Check if cached file exists and matches server timestamp.

          // Using updated_at from the API means the cache is valid until the

          // admin uploads a new image — no fixed TTL needed.

          if (existsSync(CACHE_FILE) && existsSync(CACHE_META_FILE)) {

            try {

              const cachedMeta = JSON.parse(readFileSync(CACHE_META_FILE, 'utf-8'));

              if (cachedMeta.updated_at && serverUpdatedAt && cachedMeta.updated_at === serverUpdatedAt) {

                needsDownload = false;

                console.log('[api/assets/qr-code] Cache valid (server timestamp unchanged)');

              } else {

                console.log('[api/assets/qr-code] Server timestamp changed, re-downloading');

              }

            } catch {

              console.log('[api/assets/qr-code] Meta cache corrupt, re-downloading');

            }

          } else {

            console.log('[api/assets/qr-code] Cache miss, downloading');

          }



          // Download if needed (with file lock to prevent concurrent writes)

          if (needsDownload) {

            // Check if another process is already downloading

            if (existsSync(LOCK_FILE)) {

              const lockStats = statSync(LOCK_FILE);

              const lockAge = Date.now() - lockStats.mtimeMs;

              if (lockAge < 30000) { // Lock valid for 30s

                console.log('[api/assets/qr-code] Download in progress, waiting...');

                // Wait and use existing cache if available

                if (existsSync(CACHE_FILE)) {

                  const imageBuffer = readFileSync(CACHE_FILE);

                  const base64 = imageBuffer.toString('base64');

                  return jsonResponse({

                    success: true,

                    dataUrl: `data:${mimeType};base64,${base64}`

                  });

                }

              } else {

                // Stale lock, remove it

                rmSync(LOCK_FILE, { force: true });

              }

            }



            // Acquire lock

            if (!existsSync(CACHE_DIR)) {

              ensureDirSync(CACHE_DIR);

            }

            writeFileSync(LOCK_FILE, String(Date.now()));



            try {

              const downloadStartTime = Date.now();

              const controller = new AbortController();

              const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout



              const response = await fetch(imageUrl, { signal: controller.signal });

              clearTimeout(timeoutId);



              if (!response.ok) {

                // If download fails but cache exists, use stale cache

                if (existsSync(CACHE_FILE)) {

                  console.warn(`[api/assets/qr-code] Download failed (HTTP ${response.status}), using stale cache`);

                } else {

                  throw new Error(`下载失败: HTTP ${response.status}`);

                }

              } else {

                // Save to cache using atomic write pattern

                const arrayBuffer = await response.arrayBuffer();

                const buffer = Buffer.from(arrayBuffer);

                const downloadTime = Date.now() - downloadStartTime;



                // Write to temp file first

                const tmpFile = `${CACHE_FILE}.${Date.now()}.tmp`;

                writeFileSync(tmpFile, buffer);

                // Atomic rename (POSIX guarantee)

                renameSync(tmpFile, CACHE_FILE);

                // Also write cache metadata so we can detect server-side updates

                if (serverUpdatedAt) {

                  const metaTmp = `${CACHE_META_FILE}.tmp`;

                  writeFileSync(metaTmp, JSON.stringify({ updated_at: serverUpdatedAt }));

                  renameSync(metaTmp, CACHE_META_FILE);

                }

                console.log(`[api/assets/qr-code] Downloaded and cached (${Math.round(buffer.length / 1024)}KB in ${downloadTime}ms)`);

              }

            } finally {

              // Release lock

              rmSync(LOCK_FILE, { force: true });

            }

          }



          // Read from cache and return as base64

          if (!existsSync(CACHE_FILE)) {

            return jsonResponse({ success: false, error: 'QR code not available' }, 503);

          }



          const imageBuffer = readFileSync(CACHE_FILE);

          const base64 = imageBuffer.toString('base64');

          const totalTime = Date.now() - startTime;



          console.log(`[api/assets/qr-code] Request completed in ${totalTime}ms`);



          return jsonResponse({

            success: true,

            dataUrl: `data:${mimeType};base64,${base64}`

          });

        } catch (error) {

          console.error('[api/assets/qr-code] Error:', error);

          const isTimeout = error instanceof Error && error.name === 'AbortError';

          return jsonResponse(

            { success: false, error: isTimeout ? '网络请求超时' : (error instanceof Error ? error.message : '加载失败') },

            isTimeout ? 504 : 503

          );

        }

      }



      // ============= END PROVIDER VERIFICATION API =============



      // ============= PROXY API =============



      // POST /api/proxy/set - Hot-reload proxy config into this Sidecar process

      if (pathname === '/api/proxy/set' && request.method === 'POST') {

        try {

          const payload = await request.json();

          setProxyConfig(payload);

          return jsonResponse({ success: true });

        } catch (error) {

          console.error('[api/proxy/set] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to set proxy config' },

            500

          );

        }

      }



      // ============= MCP API =============



      // POST /api/mcp/set - Set MCP servers for current workspace

      if (pathname === '/api/mcp/set' && request.method === 'POST') {

        try {

          const payload = await request.json() as { servers?: McpServerDefinition[] };

          const servers = payload?.servers ?? [];

          setMcpServers(servers);

          return jsonResponse({ success: true, servers: servers.map(s => s.id) });

        } catch (error) {

          console.error('[api/mcp/set] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to set MCP servers' },

            500

          );

        }

      }



      // GET /api/mcp - Get current MCP servers

      if (pathname === '/api/mcp' && request.method === 'GET') {

        try {

          const servers = getMcpServers();

          return jsonResponse({ success: true, servers });

        } catch (error) {

          console.error('[api/mcp] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to get MCP servers' },

            500

          );

        }

      }



      // POST /api/mcp/enable - Validate and enable MCP server

      // For preset MCP (npx): warmup npm/npx cache (system npx → bundled npx → bun x)

      // For custom MCP: check if command exists

      if (pathname === '/api/mcp/enable' && request.method === 'POST') {

        try {

          const payload = await request.json() as {

            server: McpServerDefinition;

          };



          const server = payload.server;

          if (!server) {

            return jsonResponse({ success: false, error: 'Missing server' }, 400);

          }



          // Resolve sentinel commands to display names for logs, so

          // __bundled_cuse__ / __builtin__ never leak into unified logs or

          // user-facing error surfaces.

          const displayCommand = server.command === '__builtin__'

            ? '(builtin)'

            : server.command === '__bundled_cuse__' ? 'cuse'

            : server.command === '__bundled_terminator__' ? 'terminator' : server.command;

          console.log(`[api/mcp/enable] Enabling MCP: ${server.id}, type: ${server.type}, command: ${displayCommand}`);



          // Built-in MCP (in-process) — delegate validation to registry.

          // getBuiltinMcpInstance() force-loads the tool module (SDK+zod) on

          // first hit; subsequent enables for the same id hit the cached entry.

          if (server.command === '__builtin__') {

            const entryPromise = getBuiltinMcpInstance(server.id);

            if (entryPromise) {

              const entry = await entryPromise;

              if (entry.validate) {

                const error = await entry.validate(server.env || {});

                if (error) {

                  return jsonResponse({ success: false, error });

                }

              }

            }

            console.log(`[api/mcp/enable] Built-in MCP: ${server.id} — enabled`);

            return jsonResponse({ success: true });

          }



          // Bundled cuse (computer-use) binary — resolve the sentinel to

          // the real path via runtime helper. This is the primary enable

          // path hit by the Settings UI toggle, so it MUST short-circuit

          // the generic `which` preflight below (which would fail with a

          // sentinel-leaking "命令 __bundled_cuse__ 未找到" error).

          if (server.command === '__bundled_cuse__') {

            const { getBundledCusePath } = await import('./utils/runtime');

            const cusePath = getBundledCusePath();

            if (!cusePath) {

              return jsonResponse({

                success: false,

                error: {

                  type: 'command_not_found',

                  command: 'cuse',

                  message: `Cuse 二进制未安装 (platform=${process.platform})。仅支持 macOS 与 Windows。`,

                },

              });

            }

            console.log(`[api/mcp/enable] Bundled cuse: ${server.id} — resolved to ${cusePath}`);

            return jsonResponse({ success: true });

          }



          // Bundled Terminator MCP agent (UIA desktop automation, PRD 0.2.36) —

          // same short-circuit as cuse: resolve the sentinel before the generic

          // `which` preflight.

          if (server.command === '__bundled_terminator__') {

            const { getBundledTerminatorPath } = await import('./utils/runtime');

            const terminatorPath = getBundledTerminatorPath();

            if (!terminatorPath) {

              return jsonResponse({

                success: false,

                error: {

                  type: 'command_not_found',

                  command: 'terminator',

                  message: `Terminator 二进制未安装 (platform=${process.platform})。仅支持 Windows。`,

                },

              });

            }

            console.log(`[api/mcp/enable] Bundled terminator: ${server.id} — resolved to ${terminatorPath}`);

            return jsonResponse({ success: true });

          }



          // SSE/HTTP types: validate remote URL is reachable and protocol matches

          if (server.type === 'sse' || server.type === 'http') {

            if (!server.url) {

              return jsonResponse({

                success: false,

                error: { type: 'connection_failed', message: '缺少服务器 URL' }

              });

            }



            try {

              const controller = new AbortController();

              const timeout = setTimeout(() => controller.abort(), 15000);



              const headers: Record<string, string> = {

                // Streamable HTTP 规范要求同时声明两种格式；SSE 只需 event-stream

                'Accept': server.type === 'sse' ? 'text/event-stream' : 'application/json, text/event-stream',

                // Request uncompressed response to avoid ZlibError.

                // Some servers (e.g., behind WAF/CDN like Huawei Cloud) return

                // content-encoding: gzip with a non-compressed body, causing Bun's

                // fetch() auto-decompression to crash. Validation doesn't need compression.

                'Accept-Encoding': 'identity',

                ...(server.headers || {}),

              };



              let response: Response;



              if (server.type === 'http') {

                // Streamable HTTP: send MCP initialize JSON-RPC request

                response = await fetch(server.url, {

                  method: 'POST',

                  headers: { ...headers, 'Content-Type': 'application/json' },

                  body: JSON.stringify({

                    jsonrpc: '2.0',

                    id: 1,

                    method: 'initialize',

                    params: {

                      protocolVersion: '2025-03-26',

                      capabilities: {},

                      clientInfo: { name: 'ZhiShi', version: '0.1.29' },

                    },

                  }),

                  signal: controller.signal,

                });

              } else {

                // SSE: send GET request to check if endpoint is reachable

                response = await fetch(server.url, {

                  method: 'GET',

                  headers,

                  signal: controller.signal,

                });

              }



              clearTimeout(timeout);



              // Helper: abort the underlying connection to prevent resource leaks

              // (especially important for SSE — the response is an infinite stream).

              const cleanup = () => { try { controller.abort(); } catch { /* ignore abort errors */ } };



              // Check HTTP status

              if (response.status === 401 || response.status === 403) {

                cleanup();

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'connection_failed',

                    message: `认证失败 (HTTP ${response.status})，请检查 Headers 配置`,

                  }

                });

              }



              if (response.status === 404) {

                cleanup();

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'connection_failed',

                    message: `端点不存在 (HTTP 404)，请检查 URL 是否正确`,

                  }

                });

              }



              if (response.status === 405) {

                // 405 Method Not Allowed: protocol mismatch

                cleanup();

                const hint = server.type === 'sse'

                  ? '。该端点不支持 GET，可能是 Streamable HTTP 端点，请尝试切换传输协议'

                  : '。该端点不支持 POST，可能是 SSE 端点，请尝试切换传输协议';

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'connection_failed',

                    message: `请求方法不被允许 (HTTP 405)${hint}`,

                  }

                });

              }



              if (!response.ok) {

                // 尝试读取 response body 以获取更具体的错误信息

                let detail = '';

                try {

                  const body = await response.json() as Record<string, unknown>;

                  const raw = String(body.message || body.msg || body.error || '');

                  detail = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;

                } catch { /* body 不是 JSON，忽略 */ }

                cleanup();

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'connection_failed',

                    message: `服务器返回错误 (HTTP ${response.status})${detail ? '：' + detail : ''}`,

                  }

                });

              }



              // Protocol-specific validation

              const contentType = response.headers.get('content-type') || '';



              if (server.type === 'sse') {

                // SSE validation only needs headers — abort the infinite stream immediately

                cleanup();



                // SSE endpoint should return text/event-stream

                if (!contentType.includes('text/event-stream')) {

                  // If the URL returns JSON, it's likely a Streamable HTTP endpoint

                  const hint = contentType.includes('application/json') || contentType.includes('text/html')

                    ? '。该 URL 可能是 Streamable HTTP 端点，请尝试切换传输协议为 "Streamable HTTP"'

                    : '';

                  return jsonResponse({

                    success: false,

                    error: {

                      type: 'connection_failed',

                      message: `服务器返回的内容类型不是 SSE (${contentType || 'unknown'})${hint}`,

                    }

                  });

                }

              } else {

                // Streamable HTTP: server may respond with JSON or SSE (both valid per spec)

                // (response.ok is guaranteed here — non-ok statuses returned above)

                if (contentType.includes('text/event-stream')) {

                  // SSE response to POST — valid per MCP Streamable HTTP spec.

                  // Read enough to extract the first JSON-RPC message from SSE data lines.

                  try {

                    const text = await response.text();

                    cleanup();

                    const dataLine = text.split('\n').find(l => l.startsWith('data:'));

                    if (dataLine) {

                      const body = JSON.parse(dataLine.slice(5));

                      if (!body.jsonrpc && !body.result && !body.error) {

                        return jsonResponse({

                          success: false,

                          error: {

                            type: 'connection_failed',

                            message: '服务器 SSE 响应中的数据不是有效的 JSON-RPC 格式',

                          }

                        });

                      }

                    }

                    // SSE stream with valid data or empty (server might send events later) — accept

                  } catch {

                    cleanup();

                    return jsonResponse({

                      success: false,

                      error: {

                        type: 'connection_failed',

                        message: '无法解析服务器的 SSE 响应，请检查 URL 和传输协议',

                      }

                    });

                  }

                } else {

                  // JSON response — original path

                  try {

                    const body = await response.json();

                    cleanup();

                    if (!body.jsonrpc && !body.result && !body.error) {

                      return jsonResponse({

                        success: false,

                        error: {

                          type: 'connection_failed',

                          message: '服务器响应不是有效的 JSON-RPC 格式，请检查 URL 和传输协议',

                        }

                      });

                    }

                  } catch {

                    cleanup();

                    return jsonResponse({

                      success: false,

                      error: {

                        type: 'connection_failed',

                        message: `服务器响应不是有效的 JSON 格式 (${contentType || 'unknown'})`,

                      }

                    });

                  }

                }

              }



              console.log(`[api/mcp/enable] Remote MCP validated: ${server.id} (${server.type}) → ${server.url}`);

              return jsonResponse({ success: true });



            } catch (err: unknown) {

              const error = err instanceof Error ? err : new Error(String(err));

              console.error(`[api/mcp/enable] Remote MCP validation failed: ${server.id}`, error.message);



              let message: string;

              if (error.name === 'AbortError') {

                message = '连接超时（15秒），请检查 URL 是否正确或服务器是否可达';

              } else if (error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {

                message = 'DNS 解析失败，请检查 URL 域名是否正确';

              } else if (error.message.includes('ECONNREFUSED')) {

                message = '连接被拒绝，请检查服务器是否在运行';

              } else if (error.message.includes('ECONNRESET')) {

                message = '连接被重置，请检查网络或服务器状态';

              } else if (error.message.includes('certificate') || error.message.includes('SSL') || error.message.includes('TLS')) {

                message = 'SSL/TLS 证书错误，请检查服务器证书配置';

              } else if (error.message.includes('Zlib') || error.message.includes('Decompression')) {

                // WAF/CDN may return content-encoding: gzip with non-compressed body.

                // Bun's fetch auto-decompression crashes. Skip validation and let SDK handle it.

                console.warn(`[api/mcp/enable] ZlibError during validation (WAF/CDN issue), allowing MCP: ${server.id}`);

                return jsonResponse({ success: true });

              } else {

                message = `连接失败: ${error.message}`;

              }



              return jsonResponse({

                success: false,

                error: { type: 'connection_failed', message }

              });

            }

          }



          // stdio type: validate command

          if (server.type === 'stdio' && server.command) {

            const command = server.command;



            // Preset MCP (isBuiltin: true) with npx → warmup to download and cache package

            if (server.isBuiltin && command === 'npx') {

              const { getBundledNodeDir, getSystemNpxPaths, findExistingPath } = await import('./utils/runtime');

              // M4c: pinMcpPackageVersions(SDK-ism)已删除,args 恒等透传。

              const args = server.args || [];



              // Route through utils/subprocess.spawn — on Windows the bundled

              // and system npx are both `npx.cmd` shims. Calling .cmd via raw

              // `child_process.spawn` returns EINVAL on Node ≥20.12 (CVE-2024-27980),

              // and Node's own `shell: true` workaround does NOT escape inner

              // quotes / metachars in args. The wrapper handles both — see

              // utils/subprocess.ts::spawn for the cmd.exe wrapping + cross-spawn

              // escape algorithm.

              const { spawn: wrappedSpawn } = await import('./utils/subprocess');

              const { getShellEnv } = await import('./utils/shell');

              const baseEnv = getShellEnv();



              // Priority: system npx → bundled Node.js npx → hard fail.

              // v0.2.0+ removed the "bun x" emergency branch — bundled Node is always present

              // in release builds, and dev builds fall back to system node via runtime.ts.

              const systemNpx = findExistingPath(getSystemNpxPaths());

              const nodeDir = getBundledNodeDir();

              let warmupCmd: string;

              let warmupArgs: string[];



              if (systemNpx) {

                // 1. System npx available — most reliable, user-maintained

                warmupCmd = systemNpx;

                warmupArgs = ['-y', ...args, '--help'];



                // Ensure system npx's directory is in PATH (GUI-launched apps may have minimal PATH)

                const { dirname } = await import('path');

                const npxDir = dirname(systemNpx);

                const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';

                const sep = process.platform === 'win32' ? ';' : ':';

                if (!(baseEnv[pathKey] || '').includes(npxDir)) {

                  baseEnv[pathKey] = npxDir + sep + (baseEnv[pathKey] || '');

                }



                console.log(`[api/mcp/enable] Warming up with system npx: ${warmupArgs.join(' ')}`);

              } else if (nodeDir) {

                // 2. Fallback to bundled Node.js npx

                const npxPath = process.platform === 'win32'

                  ? join(nodeDir, 'npx.cmd')

                  : join(nodeDir, 'npx');

                warmupCmd = npxPath;

                warmupArgs = ['-y', ...args, '--help'];



                // Ensure bundled Node.js bin dir is in PATH for npx to find node

                const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';

                const sep = process.platform === 'win32' ? ';' : ':';

                baseEnv[pathKey] = nodeDir + sep + (baseEnv[pathKey] || '');



                console.log(`[api/mcp/enable] Warming up with bundled npx: ${warmupArgs.join(' ')}`);

              } else {

                // 3. Neither system nor bundled Node.js found — hard fail.

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'runtime_error',

                    message: '运行时不可用（系统/内置 Node.js 均未找到）',

                  }

                });

              }



              const handle = wrappedSpawn([warmupCmd, ...warmupArgs], {

                env: baseEnv,

                stdin: 'ignore',

                stdout: 'pipe',

                stderr: 'pipe',

              });



              // Drain stderr — wrappedSpawn exposes it as a Web ReadableStream

              // (Bun.spawn-shape parity), not a Node Readable, so we read with

              // the Web reader API.

              let stderr = '';

              const stderrDone = (async () => {

                if (!handle.stderr) return;

                const reader = handle.stderr.getReader();

                const decoder = new TextDecoder();

                try {

                  while (true) {

                    const { done, value } = await reader.read();

                    if (done) break;

                    stderr += decoder.decode(value, { stream: true });

                  }

                } catch { /* ignore — process exit will settle handle.exited */ }

                finally {

                  reader.releaseLock();

                }

              })();



              // 2 min timeout (was the old `timeout` spawn option). If npx

              // hangs (e.g. tarball download stalled), kill the wrapper +

              // surface a warmup failure instead of leaving the request open.

              let timedOut = false;

              const timer = setTimeout(() => {

                timedOut = true;

                try { handle.kill('SIGTERM'); } catch { /* ignore */ }

              }, 120000);



              const code = await handle.exited;

              clearTimeout(timer);

              await stderrDone; // make sure all stderr bytes are captured before classifying



              // Spawn-failure path (ENOENT / bad arch / EINVAL): handle.error

              // is populated and code === -1.

              if (handle.error) {

                console.error('[api/mcp/enable] Warmup error:', handle.error);

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'warmup_failed',

                    message: `预热失败: ${handle.error.message}`,

                  },

                });

              }



              if (timedOut) {

                console.warn('[api/mcp/enable] Warmup timed out after 120s');

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'warmup_failed',

                    message: '预热超时（120s），请检查网络或代理设置',

                  },

                });

              }



              console.log(`[api/mcp/enable] Warmup exited with code ${code}`);

              // Code 0 or 1 is acceptable (--help may return 1 for some packages)

              // Check stderr for real errors (package not found, network issues, etc.)

              const stderrLower = stderr.toLowerCase();

              const networkKeywords = [

                'enotfound',     // DNS resolution failed

                'etimedout',     // Connection timeout

                'econnrefused',  // Connection refused

                'econnreset',    // Connection reset

                'proxy error',   // Proxy failures

                'proxy authentication', // Proxy auth required

                'bad gateway',   // Proxy 502

                'socket hang up',// Connection dropped

              ];

              const packageKeywords = [

                '404',                // HTTP 404 not found

                'package not found',  // npm/npx package resolution

                'module not found',   // Module resolution failure

                'err!',               // npm error indicator

              ];

              const isNetworkError = networkKeywords.some(kw => stderrLower.includes(kw));

              const isPackageError = packageKeywords.some(kw => stderrLower.includes(kw));



              if (isNetworkError) {

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'warmup_failed',

                    message: '网络连接失败，请检查网络或代理设置',

                  },

                });

              }

              if (isPackageError) {

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'package_not_found',

                    message: '包不存在或无法下载，请检查包名',

                  },

                });

              }

              if (code !== 0 && code !== 1) {

                return jsonResponse({

                  success: false,

                  error: {

                    type: 'warmup_failed',

                    message: `预热异常退出 (code ${code})`,

                  },

                });

              }

              return jsonResponse({ success: true });

            }



            // Custom MCP or non-npx command → check if command exists in user's shell PATH

            const { spawn } = await import('child_process');

            const { getShellEnv } = await import('./utils/shell');

            const checkCmd = process.platform === 'win32' ? 'where' : 'which';



            return new Promise<Response>((resolve) => {

              const proc = spawn(checkCmd, [command], { stdio: 'ignore', env: getShellEnv() });



              proc.on('error', () => {

                resolve(jsonResponse({

                  success: false,

                  error: {

                    type: 'command_not_found',

                    command,

                    message: `命令 "${command}" 未找到`,

                    ...getCommandDownloadInfo(command),

                  }

                }));

              });



              proc.on('close', (code) => {

                if (code === 0) {

                  resolve(jsonResponse({ success: true }));

                } else {

                  resolve(jsonResponse({

                    success: false,

                    error: {

                      type: 'command_not_found',

                      command,

                      message: `命令 "${command}" 未找到`,

                      ...getCommandDownloadInfo(command),

                    }

                  }));

                }

              });

            });

          }



          // Default: allow

          return jsonResponse({ success: true });

        } catch (error) {

          console.error('[api/mcp/enable] Error:', error);

          return jsonResponse({

            success: false,

            error: {

              type: 'unknown',

              message: error instanceof Error ? error.message : '启用失败',

            }

          }, 500);

        }

      }



      // M4c: permission:request / ask-user-question / plan-mode 应答端点随

      // SDK 权限交互体系删除(pi 引擎边界是规则,零问人交互)。


      // ============= MCP OAuth API =============



      // POST /api/mcp/oauth/discover - Probe MCP server for OAuth requirements

      if (pathname === '/api/mcp/oauth/discover' && request.method === 'POST') {

        try {

          const payload = await request.json() as { serverId: string; mcpUrl: string; forceRefresh?: boolean };

          if (!payload.serverId || !payload.mcpUrl) {

            return jsonResponse({ success: false, error: 'Missing serverId or mcpUrl' }, 400);

          }

          const { probeOAuthRequirement } = await import('./mcp-oauth');

          const result = await probeOAuthRequirement(payload.serverId, payload.mcpUrl, payload.forceRefresh);

          return jsonResponse({ success: true, ...result });

        } catch (error) {

          console.error('[api/mcp/oauth/discover] Error:', error);

          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Discovery failed' }, 500);

        }

      }



      // POST /api/mcp/oauth/start - Start OAuth flow (auto or manual mode)

      if (pathname === '/api/mcp/oauth/start' && request.method === 'POST') {

        try {

          const payload = await request.json() as {

            serverId: string;

            serverUrl: string;

            // Manual mode fields (all optional — omit for auto mode)

            clientId?: string;

            clientSecret?: string;

            scopes?: string[];

            callbackPort?: number;

            authorizationUrl?: string;

            tokenUrl?: string;

          };



          if (!payload.serverId || !payload.serverUrl) {

            return jsonResponse({ success: false, error: 'Missing serverId or serverUrl' }, 400);

          }



          const { authorizeServer } = await import('./mcp-oauth');

          const manualConfig = payload.clientId ? {

            clientId: payload.clientId,

            clientSecret: payload.clientSecret,

            scopes: payload.scopes,

            callbackPort: payload.callbackPort,

            authorizationUrl: payload.authorizationUrl,

            tokenUrl: payload.tokenUrl,

          } : undefined;



          const { authUrl, waitForCompletion } = await authorizeServer(

            payload.serverId,

            payload.serverUrl,

            manualConfig,

          );



          // Don't await completion — return the auth URL immediately

          waitForCompletion.then((success) => {

            if (success) {

              console.log(`[api/mcp/oauth] Authorization completed for ${payload.serverId}`);

            } else {

              console.warn(`[api/mcp/oauth] Authorization failed or cancelled for ${payload.serverId}`);

            }

          });



          return jsonResponse({ success: true, authUrl });

        } catch (error) {

          console.error('[api/mcp/oauth/start] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to start OAuth flow' },

            500

          );

        }

      }



      // GET /api/mcp/oauth/status/:serverId - Get OAuth status

      if (pathname.startsWith('/api/mcp/oauth/status/') && request.method === 'GET') {

        try {

          const serverId = decodeURIComponent(pathname.slice('/api/mcp/oauth/status/'.length));

          const { getOAuthStatus } = await import('./mcp-oauth');

          const result = getOAuthStatus(serverId);

          return jsonResponse({

            success: true,

            status: result.status,

            hasToken: result.status === 'connected' || result.status === 'expired',

            expiresAt: result.expiresAt,

            scope: result.scope,

          });

        } catch (error) {

          console.error('[api/mcp/oauth/status] Error:', error);

          return jsonResponse({ success: false, error: String(error) }, 500);

        }

      }



      // POST /api/mcp/oauth/refresh - Manually refresh OAuth token

      if (pathname === '/api/mcp/oauth/refresh' && request.method === 'POST') {

        try {

          const payload = await request.json() as { serverId: string };

          const { manualRefreshToken } = await import('./mcp-oauth');

          const refreshed = await manualRefreshToken(payload.serverId);

          return jsonResponse({ success: refreshed, refreshed });

        } catch (error) {

          console.error('[api/mcp/oauth/refresh] Error:', error);

          return jsonResponse({ success: false, error: String(error) }, 500);

        }

      }



      // DELETE /api/mcp/oauth/token - Revoke OAuth authorization

      if (pathname === '/api/mcp/oauth/token' && request.method === 'DELETE') {

        try {

          const payload = await request.json() as { serverId: string };

          const { revokeAuthorization } = await import('./mcp-oauth');

          await revokeAuthorization(payload.serverId);

          return jsonResponse({ success: true });

        } catch (error) {

          console.error('[api/mcp/oauth/token] Error:', error);

          return jsonResponse({ success: false, error: String(error) }, 500);

        }

      }



      // ============= END MCP OAuth API =============



      // ============= END MCP API =============



      // ============= ADMIN API (Self-Config CLI) =============

      if (pathname.startsWith('/api/admin/') && request.method === 'POST') {

        try {

          const payload = pathname === '/api/admin/status'

            ? {}

            : await request.json().catch(() => ({})) as Record<string, unknown>;



          const result = await routeAdminApi(pathname, payload);

          return jsonResponse(result, result.success ? 200 : 400);

        } catch (error) {

          console.error(`[admin] ${pathname} error:`, error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Admin API error' },

            500

          );

        }

      }

      // ============= END ADMIN API =============






      // ============= SLASH COMMANDS API =============



      // ============= CLAUDE.md API =============





      // Security: Validate item names to prevent path traversal attacks

      // Supports Unicode (Chinese, Japanese, etc.) while maintaining security

      // Defined here (before Rules and Skills APIs) so all endpoints can use it

      const isValidItemName = (name: string): boolean => {

        // Reject empty names

        if (!name || name.trim().length === 0) {

          return false;

        }

        // Reject path separators and parent directory references (security)

        if (name.includes('/') || name.includes('\\') || name.includes('..')) {

          return false;

        }

        // Reject Windows reserved characters: < > : " | ? *

        // These cause issues on Windows file systems

        if (/[<>:"|?*]/.test(name)) {

          return false;

        }

        // Reject control characters (0x00-0x1F, 0x7F)

         

        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f\x7f]/.test(name)) {

          return false;

        }

        // Reject names that are only dots (., ..) or start/end with spaces

        if (/^\.+$/.test(name) || name !== name.trim()) {

          return false;

        }

        // Reject Windows reserved file names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)

        if (isWindowsReservedName(name)) {

          return false;

        }

        // Allow Unicode letters, numbers, hyphens, underscores, spaces, and common punctuation

        return true;

      };



      // ============= RULES FILES API =============

      // Manage .claude/rules/*.md files (system prompt rules)



      // GET /api/rules - List all rule files

      if (pathname === '/api/rules' && request.method === 'GET') {

        try {

          const queryAgentDir = url.searchParams.get('agentDir');

          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {

            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);

          }

          const targetDir = queryAgentDir || currentAgentDir;

          const rulesDir = join(targetDir, '.claude', 'rules');

          if (!existsSync(rulesDir)) {

            return jsonResponse({ success: true, files: [] });

          }

          const files = readdirSync(rulesDir)

            .filter(f => f.endsWith('.md'))

            .sort();

          return jsonResponse({ success: true, files });

        } catch (error) {

          console.error('[api/rules] Error listing:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to list rules' },

            500

          );

        }

      }



      // POST /api/rules - Create a new rule file

      if (pathname === '/api/rules' && request.method === 'POST') {

        try {

          const payload = await request.json() as { name: string; content?: string };

          if (!payload.name || !payload.name.trim()) {

            return jsonResponse({ success: false, error: 'Name is required' }, 400);

          }

          // Ensure .md suffix

          let filename = payload.name.trim();

          if (!filename.endsWith('.md')) {

            filename = filename + '.md';

          }

          const nameWithoutExt = filename.replace(/\.md$/, '');

          if (!isValidItemName(nameWithoutExt)) {

            return jsonResponse({ success: false, error: 'Invalid file name' }, 400);

          }

          const queryAgentDir = url.searchParams.get('agentDir');

          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {

            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);

          }

          const targetDir = queryAgentDir || currentAgentDir;

          const rulesDir = join(targetDir, '.claude', 'rules');

          ensureDirSync(rulesDir);

          const filePath = join(rulesDir, filename);

          if (existsSync(filePath)) {

            return jsonResponse({ success: false, error: 'File already exists' }, 409);

          }

          writeFileSync(filePath, payload.content || '', 'utf-8');

          return jsonResponse({ success: true, filename });

        } catch (error) {

          console.error('[api/rules] Error creating:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to create rule file' },

            500

          );

        }

      }



      // PUT /api/rules/:filename/rename - Rename a rule file

      if (pathname.startsWith('/api/rules/') && pathname.endsWith('/rename') && request.method === 'PUT') {

        try {

          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length, -'/rename'.length));

          if (!filename || !filename.endsWith('.md')) {

            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);

          }

          const oldNameWithoutExt = filename.replace(/\.md$/, '');

          if (!isValidItemName(oldNameWithoutExt)) {

            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);

          }

          const payload = await request.json() as { newName: string };

          if (!payload.newName || !payload.newName.trim()) {

            return jsonResponse({ success: false, error: 'New name is required' }, 400);

          }

          let newFilename = payload.newName.trim();

          if (!newFilename.endsWith('.md')) {

            newFilename = newFilename + '.md';

          }

          const newNameWithoutExt = newFilename.replace(/\.md$/, '');

          if (!isValidItemName(newNameWithoutExt)) {

            return jsonResponse({ success: false, error: 'Invalid new file name' }, 400);

          }

          const queryAgentDir = url.searchParams.get('agentDir');

          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {

            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);

          }

          const targetDir = queryAgentDir || currentAgentDir;

          const rulesDir = join(targetDir, '.claude', 'rules');

          const oldPath = join(rulesDir, filename);

          const newPath = join(rulesDir, newFilename);

          if (!existsSync(oldPath)) {

            return jsonResponse({ success: false, error: 'File not found' }, 404);

          }

          if (existsSync(newPath)) {

            return jsonResponse({ success: false, error: 'Target filename already exists' }, 409);

          }

          renameSync(oldPath, newPath);

          return jsonResponse({ success: true, filename: newFilename });

        } catch (error) {

          console.error('[api/rules] Error renaming:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to rename rule file' },

            500

          );

        }

      }



      // GET /api/rules/:filename - Read a rule file

      if (pathname.startsWith('/api/rules/') && request.method === 'GET') {

        try {

          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length));

          if (!filename || !filename.endsWith('.md')) {

            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);

          }

          const nameWithoutExt = filename.replace(/\.md$/, '');

          if (!isValidItemName(nameWithoutExt)) {

            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);

          }

          const queryAgentDir = url.searchParams.get('agentDir');

          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {

            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);

          }

          const targetDir = queryAgentDir || currentAgentDir;

          const rulesDir = join(targetDir, '.claude', 'rules');

          const filePath = join(rulesDir, filename);

          if (!existsSync(filePath)) {

            return jsonResponse({ success: true, exists: false, content: '' });

          }

          const content = readFileSync(filePath, 'utf-8');

          return jsonResponse({ success: true, exists: true, content });

        } catch (error) {

          console.error('[api/rules] Error reading:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to read rule file' },

            500

          );

        }

      }



      // PUT /api/rules/:filename - Update a rule file

      if (pathname.startsWith('/api/rules/') && request.method === 'PUT') {

        try {

          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length));

          if (!filename || !filename.endsWith('.md')) {

            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);

          }

          const nameWithoutExt = filename.replace(/\.md$/, '');

          if (!isValidItemName(nameWithoutExt)) {

            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);

          }

          const payload = await request.json() as { content: string };

          if (typeof payload.content !== 'string') {

            return jsonResponse({ success: false, error: 'Content must be a string' }, 400);

          }

          const queryAgentDir = url.searchParams.get('agentDir');

          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {

            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);

          }

          const targetDir = queryAgentDir || currentAgentDir;

          const rulesDir = join(targetDir, '.claude', 'rules');

          ensureDirSync(rulesDir);

          const filePath = join(rulesDir, filename);

          writeFileSync(filePath, payload.content, 'utf-8');

          return jsonResponse({ success: true });

        } catch (error) {

          console.error('[api/rules] Error updating:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to update rule file' },

            500

          );

        }

      }



      // DELETE /api/rules/:filename - Delete a rule file

      if (pathname.startsWith('/api/rules/') && request.method === 'DELETE') {

        try {

          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length));

          if (!filename || !filename.endsWith('.md')) {

            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);

          }

          const nameWithoutExt = filename.replace(/\.md$/, '');

          if (!isValidItemName(nameWithoutExt)) {

            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);

          }

          const queryAgentDir = url.searchParams.get('agentDir');

          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {

            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);

          }

          const targetDir = queryAgentDir || currentAgentDir;

          const rulesDir = join(targetDir, '.claude', 'rules');

          const filePath = join(rulesDir, filename);

          if (!existsSync(filePath)) {

            return jsonResponse({ success: false, error: 'File not found' }, 404);

          }

          unlinkSync(filePath);

          return jsonResponse({ success: true });

        } catch (error) {

          console.error('[api/rules] Error deleting:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to delete rule file' },

            500

          );

        }

      }



      // ============= SKILLS MANAGEMENT API =============



      const userSkillsBaseDir = join(getZhiShiDataDir(), 'skills');

      const userCommandsBaseDir = join(getZhiShiDataDir(), 'commands');



      // Helper: Get project base directories (supports explicit agentDir parameter)

      // Security: validates agentDir to prevent path traversal attacks

      const getProjectBaseDirs = (queryAgentDir: string | null) => {

        // If explicit agentDir provided, validate it first

        if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {

          // Invalid agentDir, fall back to currentAgentDir

          console.warn(`[getProjectBaseDirs] Invalid agentDir rejected: ${queryAgentDir}`);

          queryAgentDir = null;

        }

        // Use validated agentDir if provided, otherwise fall back to currentAgentDir

        const effectiveAgentDir = queryAgentDir || currentAgentDir;

        const hasValidDir = effectiveAgentDir && existsSync(effectiveAgentDir);

        return {

          skillsDir: hasValidDir ? join(effectiveAgentDir, '.claude', 'skills') : '',

          commandsDir: hasValidDir ? join(effectiveAgentDir, '.claude', 'commands') : '',

        };

      };



      // Default project paths (using currentAgentDir)

      const hasValidAgentDir = currentAgentDir && existsSync(currentAgentDir);

      const projectSkillsBaseDir = hasValidAgentDir ? join(currentAgentDir, '.claude', 'skills') : '';

      const projectCommandsBaseDir = hasValidAgentDir ? join(currentAgentDir, '.claude', 'commands') : '';



      // POST /api/skill/toggle-enable - Enable/disable a user-level skill

      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard

      if (pathname === '/api/skill/toggle-enable' && request.method === 'POST') {

        try {

          const { folderName, enabled } = await request.json() as { folderName: string; enabled: boolean };

          if (!folderName || typeof folderName !== 'string') {

            return jsonResponse({ success: false, error: 'Invalid folderName' }, 400);

          }

          const config = readSkillsConfig();

          if (enabled) {

            config.disabled = config.disabled.filter(n => n !== folderName);

          } else {

            if (!config.disabled.includes(folderName)) config.disabled.push(folderName);

          }

          writeSkillsConfig(config);

          // Re-sync project skill symlinks if this sidecar has an agentDir

          // (Global Sidecar has no agentDir; Tab Sidecars will sync on next /api/commands)

          if (agentDir) { syncProjectUserConfig(agentDir); }

          return jsonResponse({ success: true });

        } catch (error) {

          console.error('[api/skill/toggle-enable] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to toggle skill' },

            500

          );

        }

      }



      // GET /api/skill/:name - Get skill detail

      if (pathname.startsWith('/api/skill/') && request.method === 'GET') {

        try {

          const skillName = decodeURIComponent(pathname.replace('/api/skill/', ''));

          if (!isValidItemName(skillName)) {

            return jsonResponse({ success: false, error: 'Invalid skill name' }, 400);

          }

          const scope = url.searchParams.get('scope') || 'project';

          const queryAgentDir = url.searchParams.get('agentDir');



          // Use explicit agentDir if provided for project scope

          const { skillsDir } = getProjectBaseDirs(queryAgentDir);

          const baseDir = scope === 'user' ? userSkillsBaseDir : skillsDir;

          const skillPath = join(baseDir, skillName, 'SKILL.md');



          if (!existsSync(skillPath)) {

            return jsonResponse({ success: false, error: 'Skill not found' }, 404);

          }



          const content = readFileSync(skillPath, 'utf-8');

          const { frontmatter, body } = parseFullSkillContent(content);



          return jsonResponse({

            success: true,

            skill: {

              name: frontmatter.name || skillName,

              folderName: skillName,

              path: skillPath,

              scope,

              frontmatter,

              body,

            }

          });

        } catch (error) {

          console.error('[api/skill] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to get skill' },

            500

          );

        }

      }



      // PUT /api/skill/:name - Update skill (with optional folder rename)

      if (pathname.startsWith('/api/skill/') && request.method === 'PUT') {

        try {

          const skillName = decodeURIComponent(pathname.replace('/api/skill/', ''));

          if (!isValidItemName(skillName)) {

            return jsonResponse({ success: false, error: 'Invalid skill name' }, 400);

          }

          const payload = await request.json() as {

            scope: 'user' | 'project';

            frontmatter: Partial<SkillFrontmatter>;

            body: string;

            newFolderName?: string; // Optional: rename folder if provided

            agentDir?: string; // Optional: explicit project directory

          };



          // Use explicit agentDir if provided for project scope

          const { skillsDir } = getProjectBaseDirs(payload.agentDir || null);

          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : skillsDir;

          let currentFolderName = skillName;

          let skillDir = join(baseDir, currentFolderName);

          let skillPath = join(skillDir, 'SKILL.md');



          if (!existsSync(skillPath)) {

            return jsonResponse({ success: false, error: 'Skill not found' }, 404);

          }



          // Handle folder rename if newFolderName is provided and different

          if (payload.newFolderName && payload.newFolderName !== currentFolderName) {

            const newFolderName = payload.newFolderName;



            // Validate new folder name

            if (!isValidItemName(newFolderName)) {

              return jsonResponse({ success: false, error: 'Invalid new folder name' }, 400);

            }



            const newSkillDir = join(baseDir, newFolderName);



            // Check for conflict

            if (existsSync(newSkillDir)) {

              return jsonResponse({ success: false, error: `技能文件夹 "${newFolderName}" 已存在，请使用其他名称` }, 409);

            }



            // Atomic-like operation: prepare content first, then rename

            // If rename fails, nothing is lost. If write fails after rename, folder is renamed but content unchanged.

            const content = serializeSkillContent(payload.frontmatter, payload.body);



            // Rename the folder

            renameSync(skillDir, newSkillDir);

            skillDir = newSkillDir;

            skillPath = join(skillDir, 'SKILL.md');

            currentFolderName = newFolderName;



            // Write content to new location

            writeFileSync(skillPath, content, 'utf-8');



            // User skill renamed — bump generation + re-sync to fix old dangling symlink + create new one

            if (payload.scope === 'user') {

              bumpSkillsGeneration();

              if (agentDir) { syncProjectUserConfig(agentDir); }

            }

            return jsonResponse({

              success: true,

              path: skillPath,

              folderName: currentFolderName,

              fullPath: skillDir

            });

          }



          // No rename, just update content

          const content = serializeSkillContent(payload.frontmatter, payload.body);

          writeFileSync(skillPath, content, 'utf-8');



          return jsonResponse({

            success: true,

            path: skillPath,

            folderName: currentFolderName,

            fullPath: skillDir

          });

        } catch (error) {

          console.error('[api/skill] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to update skill' },

            500

          );

        }

      }



      // DELETE /api/skill/:name - Delete skill

      if (pathname.startsWith('/api/skill/') && request.method === 'DELETE') {

        try {

          const skillName = decodeURIComponent(pathname.replace('/api/skill/', ''));

          if (!isValidItemName(skillName)) {

            return jsonResponse({ success: false, error: 'Invalid skill name' }, 400);

          }

          const scope = url.searchParams.get('scope') || 'project';

          const queryAgentDir = url.searchParams.get('agentDir');



          // Use explicit agentDir if provided for project scope

          const { skillsDir } = getProjectBaseDirs(queryAgentDir);

          const baseDir = scope === 'user' ? userSkillsBaseDir : skillsDir;

          const skillDir = join(baseDir, skillName);



          if (!existsSync(skillDir)) {

            return jsonResponse({ success: false, error: 'Skill not found' }, 404);

          }



          rmSync(skillDir, { recursive: true, force: true });

          // User skill deleted — bump generation + re-sync to remove dangling symlinks

          if (scope === 'user') {

            bumpSkillsGeneration();

            if (agentDir) { syncProjectUserConfig(agentDir); }

          }

          return jsonResponse({ success: true });

        } catch (error) {

          console.error('[api/skill] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to delete skill' },

            500

          );

        }

      }



      // POST /api/skill/copy-to-global - Copy a project skill to global (~/.zhishi/skills/)

      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard

      if (pathname === '/api/skill/copy-to-global' && request.method === 'POST') {

        try {

          const { folderName } = await request.json() as { folderName: string };

          if (!folderName || typeof folderName !== 'string' || !isValidItemName(folderName)) {

            return jsonResponse({ success: false, error: 'Invalid folderName' }, 400);

          }



          // Validate project skills directory

          if (!projectSkillsBaseDir) {

            return jsonResponse({ success: false, error: '当前没有项目工作目录' }, 400);

          }



          const srcDir = join(projectSkillsBaseDir, folderName);

          if (!existsSync(srcDir)) {

            return jsonResponse({ success: false, error: '项目技能不存在' }, 404);

          }



          // Check SKILL.md exists in source

          if (!existsSync(join(srcDir, 'SKILL.md'))) {

            return jsonResponse({ success: false, error: '项目技能缺少 SKILL.md' }, 400);

          }



          // Check if already exists in global

          const destDir = join(userSkillsBaseDir, folderName);

          if (existsSync(destDir)) {

            return jsonResponse({ success: false, error: '全局技能中已存在同名技能' }, 409);

          }



          // Ensure global skills directory exists

          ensureDirSync(userSkillsBaseDir);



          // Copy the skill folder — async variant so /health stays responsive

          // while large skills copy (see copyDirRecursive doc).

          await copyDirRecursive(srcDir, destDir, '[api/skill/copy-to-global]');



          // Bump generation + sync symlinks into project

          bumpSkillsGeneration();

          if (currentAgentDir) { syncProjectUserConfig(currentAgentDir); }



          return jsonResponse({ success: true, folderName });

        } catch (error) {

          console.error('[api/skill/copy-to-global] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to copy skill to global' },

            500

          );

        }

      }



      // POST /api/skill/import-folder - Import skill from a local folder path (Tauri only)

      if (pathname === '/api/skill/import-folder' && request.method === 'POST') {

        try {

          const payload = await request.json() as {

            folderPath: string;

            scope: 'user' | 'project';

          };



          if (!payload.folderPath) {

            return jsonResponse({ success: false, error: 'Folder path is required' }, 400);

          }



          const sourcePath = payload.folderPath;

          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : projectSkillsBaseDir;



          // Validate target directory is available

          if (!baseDir) {

            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);

          }



          // Validate source folder exists

          if (!existsSync(sourcePath)) {

            return jsonResponse({ success: false, error: '指定的文件夹不存在' }, 400);

          }



          // Check if it's a directory

          try {

            const stats = statSync(sourcePath);

            if (!stats.isDirectory()) {

              return jsonResponse({ success: false, error: '指定的路径不是文件夹' }, 400);

            }

          } catch {

            return jsonResponse({ success: false, error: '无法读取文件夹信息' }, 400);

          }



          // Check for SKILL.md at root (case-insensitive for Windows/macOS)

          let skillMdPath = join(sourcePath, 'SKILL.md');

          if (!existsSync(skillMdPath)) {

            try {

              const entries = readdirSync(sourcePath);

              const match = entries.find((e) => e.toLowerCase() === 'skill.md');

              if (match) {

                skillMdPath = join(sourcePath, match);

              }

            } catch {

              // ignore readdir errors, fall through to the exists check below

            }

          }

          if (!existsSync(skillMdPath)) {

            return jsonResponse({ success: false, error: '文件夹中未找到 SKILL.md 文件' }, 400);

          }



          // Read SKILL.md to get the skill name

          const skillMdContent = readFileSync(skillMdPath, 'utf-8');

          let folderName = basename(sourcePath);



          // Try to extract name from SKILL.md frontmatter

          try {

            const parsed = parseFullSkillContent(skillMdContent);

            if (parsed.frontmatter.name) {

              folderName = parsed.frontmatter.name;

            }

          } catch {

            // Use folder name as fallback

          }



          // Sanitize folder name

          folderName = sanitizeFolderName(folderName);

          const targetDir = join(baseDir, folderName);



          // Check if skill already exists

          if (existsSync(targetDir)) {

            return jsonResponse({ success: false, error: `技能 "${folderName}" 已存在` }, 409);

          }



          // Copy folder recursively — async so the sidecar's /health probe

          // stays responsive during large imports (see copyDirRecursive doc).

          // Keeps the hidden-file / __MACOSX filter that distinguishes this

          // path from the bulk-sync variant.

          const copyImportedSkillDir = async (src: string, dest: string): Promise<void> => {

            await ensureDir(dest);

            const entries = await readdirAsync(src, { withFileTypes: true });

            for (const entry of entries) {

              if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;

              if (entry.isSymbolicLink()) {

                console.warn(`[api/skill/import-folder] Skipping symlink: ${join(src, entry.name)}`);

                continue;

              }

              const srcPath = join(src, entry.name);

              const destPath = join(dest, entry.name);

              if (entry.isDirectory()) {

                await copyImportedSkillDir(srcPath, destPath);

              } else {

                await copyFileAsync(srcPath, destPath);

              }

            }

          };



          await copyImportedSkillDir(sourcePath, targetDir);



          if (payload.scope === 'user') {

            bumpSkillsGeneration();

            if (agentDir) { syncProjectUserConfig(agentDir); }

          }

          return jsonResponse({

            success: true,

            folderName,

            path: targetDir,

            message: `已成功导入技能 "${folderName}"`

          });



        } catch (error) {

          console.error('[api/skill/import-folder] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to import skill folder' },

            500

          );

        }

      }



      // ============= COMMANDS MANAGEMENT API =============

      // GET /api/command-items - List all commands

      // Supports ?agentDir= for listing commands from a specific workspace (e.g. from Launcher)

      if (pathname === '/api/command-items' && request.method === 'GET') {

        try {

          const scope = url.searchParams.get('scope') || 'all';

          const queryAgentDir = url.searchParams.get('agentDir');

          const { commandsDir: effectiveCommandsDir } = getProjectBaseDirs(queryAgentDir);

          const commandItems: Array<{

            name: string;

            fileName: string;

            description: string;

            scope: 'user' | 'project';

            path: string;

            author?: string;

          }> = [];



          const scanCommands = (dir: string, scopeType: 'user' | 'project') => {

            if (!dir || !existsSync(dir)) return;

            try {

              const files = readdirSync(dir);

              for (const file of files) {

                if (!file.endsWith('.md')) continue;

                const filePath = join(dir, file);

                const content = readFileSync(filePath, 'utf-8');

                const { frontmatter } = parseFullCommandContent(content);

                const fileName = extractCommandName(file);

                commandItems.push({

                  name: frontmatter.name || fileName,  // Prefer frontmatter name

                  fileName,  // Always include actual file name for reference

                  description: frontmatter.description || '',

                  scope: scopeType,

                  path: filePath,

                  author: frontmatter.author,

                });

              }

            } catch (scanError) {

              console.warn(`[api/command-items] Error scanning ${scopeType} commands:`, scanError);

            }

          };



          const resolvedProjectCommandsDir = effectiveCommandsDir || projectCommandsBaseDir;

          if ((scope === 'all' || scope === 'project') && resolvedProjectCommandsDir) {

            scanCommands(resolvedProjectCommandsDir, 'project');

          }

          if (scope === 'all' || scope === 'user') {

            scanCommands(userCommandsBaseDir, 'user');

          }



          return jsonResponse({ success: true, commands: commandItems });

        } catch (error) {

          console.error('[api/command-items] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to list commands' },

            500

          );

        }

      }



      // GET /api/command-item/:name - Get command detail

      if (pathname.startsWith('/api/command-item/') && request.method === 'GET') {

        try {

          const cmdName = decodeURIComponent(pathname.replace('/api/command-item/', ''));

          if (!isValidItemName(cmdName)) {

            return jsonResponse({ success: false, error: 'Invalid command name' }, 400);

          }

          const scope = url.searchParams.get('scope') || 'project';

          const queryAgentDir = url.searchParams.get('agentDir');



          // Use explicit agentDir if provided for project scope

          const { commandsDir } = getProjectBaseDirs(queryAgentDir);

          const baseDir = scope === 'user' ? userCommandsBaseDir : commandsDir;

          const cmdPath = join(baseDir, `${cmdName}.md`);



          if (!existsSync(cmdPath)) {

            return jsonResponse({ success: false, error: 'Command not found' }, 404);

          }



          const content = readFileSync(cmdPath, 'utf-8');

          const { frontmatter, body } = parseFullCommandContent(content);



          return jsonResponse({

            success: true,

            command: {

              name: frontmatter.name || cmdName,  // Prefer frontmatter name over file name

              fileName: cmdName,  // Always return the actual file name for reference

              path: cmdPath,

              scope,

              frontmatter,

              body,

            }

          });

        } catch (error) {

          console.error('[api/command-item] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to get command' },

            500

          );

        }

      }



      // PUT /api/command-item/:name - Update command

      if (pathname.startsWith('/api/command-item/') && request.method === 'PUT') {

        try {

          const cmdName = decodeURIComponent(pathname.replace('/api/command-item/', ''));

          if (!isValidItemName(cmdName)) {

            return jsonResponse({ success: false, error: 'Invalid command name' }, 400);

          }

          const payload = await request.json() as {

            scope: 'user' | 'project';

            frontmatter: Partial<CommandFrontmatter>;

            body: string;

            agentDir?: string; // Optional: explicit project directory

            newFileName?: string; // Optional: rename file if provided

          };



          // Use explicit agentDir if provided for project scope

          const { commandsDir } = getProjectBaseDirs(payload.agentDir || null);

          const baseDir = payload.scope === 'user' ? userCommandsBaseDir : commandsDir;

          let currentFileName = cmdName;

          let cmdPath = join(baseDir, `${currentFileName}.md`);



          if (!existsSync(cmdPath)) {

            return jsonResponse({ success: false, error: 'Command not found' }, 404);

          }



          // Handle file rename if newFileName is provided and different

          if (payload.newFileName && payload.newFileName !== currentFileName) {

            const newFileName = payload.newFileName;



            // Validate new file name

            if (!isValidItemName(newFileName)) {

              return jsonResponse({ success: false, error: 'Invalid new file name' }, 400);

            }



            const newCmdPath = join(baseDir, `${newFileName}.md`);



            // Check for conflict

            if (existsSync(newCmdPath)) {

              return jsonResponse({ success: false, error: `指令文件 "${newFileName}.md" 已存在，请使用其他名称` }, 409);

            }



            // Atomic-like operation: prepare content first, then rename

            // If rename fails, nothing is lost. If write fails after rename, file is renamed but content unchanged.

            const content = serializeCommandContent(payload.frontmatter, payload.body);



            // Rename the file

            renameSync(cmdPath, newCmdPath);

            cmdPath = newCmdPath;

            currentFileName = newFileName;



            // Write content to new location

            writeFileSync(cmdPath, content, 'utf-8');



            // User command renamed — re-sync to fix old dangling symlink + create new one

            if (payload.scope === 'user' && agentDir) syncProjectUserConfig(agentDir);

            return jsonResponse({

              success: true,

              path: cmdPath,

              fileName: currentFileName

            });

          }



          // No rename, just update content

          const content = serializeCommandContent(payload.frontmatter, payload.body);

          writeFileSync(cmdPath, content, 'utf-8');



          return jsonResponse({

            success: true,

            path: cmdPath,

            fileName: currentFileName

          });

        } catch (error) {

          console.error('[api/command-item] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to update command' },

            500

          );

        }

      }



      // DELETE /api/command-item/:name - Delete command

      if (pathname.startsWith('/api/command-item/') && request.method === 'DELETE') {

        try {

          const cmdName = decodeURIComponent(pathname.replace('/api/command-item/', ''));

          if (!isValidItemName(cmdName)) {

            return jsonResponse({ success: false, error: 'Invalid command name' }, 400);

          }

          const scope = url.searchParams.get('scope') || 'project';

          const queryAgentDir = url.searchParams.get('agentDir');



          // Use explicit agentDir if provided for project scope

          const { commandsDir } = getProjectBaseDirs(queryAgentDir);

          const baseDir = scope === 'user' ? userCommandsBaseDir : commandsDir;

          const cmdPath = join(baseDir, `${cmdName}.md`);



          if (!existsSync(cmdPath)) {

            return jsonResponse({ success: false, error: 'Command not found' }, 404);

          }



          rmSync(cmdPath);

          // User command deleted — re-sync to remove dangling symlinks in project

          if (scope === 'user' && agentDir) syncProjectUserConfig(agentDir);

          return jsonResponse({ success: true });

        } catch (error) {

          console.error('[api/command-item] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to delete command' },

            500

          );

        }

      }



      // POST /api/command-item/create - Create new command

      if (pathname === '/api/command-item/create' && request.method === 'POST') {

        try {

          const payload = await request.json() as {

            name: string;

            scope: 'user' | 'project';

            description?: string;

          };



          if (!payload.name) {

            return jsonResponse({ success: false, error: 'Name is required' }, 400);

          }



          // Sanitize name for filename (supports Unicode characters like Chinese)

          const fileName = sanitizeFolderName(payload.name);

          const baseDir = payload.scope === 'user' ? userCommandsBaseDir : projectCommandsBaseDir;



          // Ensure directory exists

          if (!existsSync(baseDir)) {

            ensureDirSync(baseDir);

          }



          const cmdPath = join(baseDir, `${fileName}.md`);



          if (existsSync(cmdPath)) {

            return jsonResponse({ success: false, error: 'Command already exists' }, 409);

          }



          // Create command file with default content

          const frontmatter: Partial<CommandFrontmatter> = {

            name: payload.name,

            description: payload.description || '',

          };

          const body = `在这里编写指令的详细内容...`;

          const content = serializeCommandContent(frontmatter, body);



          writeFileSync(cmdPath, content, 'utf-8');



          // New user command — sync symlink into project so SDK can discover it

          if (payload.scope === 'user' && agentDir) syncProjectUserConfig(agentDir);

          return jsonResponse({ success: true, path: cmdPath, name: fileName });

        } catch (error) {

          console.error('[api/command-item/create] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to create command' },

            500

          );

        }

      }



      // ============= SUB-AGENTS API =============



      const userAgentsBaseDir = join(getZhiShiDataDir(), 'agents');



      // Helper: Get project agents directory (supports explicit agentDir parameter)

      const getProjectAgentsDir = (queryAgentDir: string | null) => {

        if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {

          queryAgentDir = null;

        }

        const effectiveAgentDir = queryAgentDir || currentAgentDir;

        const hasValidDir = effectiveAgentDir && existsSync(effectiveAgentDir);

        return hasValidDir ? join(effectiveAgentDir, '.claude', 'agents') : '';

      };



      // Validate an agent folderName accepted by GET/PUT/DELETE /api/agent/:name.

      //

      // Unlike `isValidItemName` (which rejects '/'), agents now use a

      // path-like identity for the 'nested' layout (e.g. `team/reviewer`).

      // Security rests on two things: each segment still flows through

      // `isValidItemName` (blocking '..', '\\', Windows reserved names,

      // control chars, reserved punctuation), and findAgent() only ever

      // returns real on-disk paths produced by scanAgents — the value we

      // receive is matched by string equality against scanned folderNames,

      // never concatenated into a path.

      const isValidAgentFolderName = (name: string): boolean => {

        if (!name || name.length > 512) return false;

        if (name.includes('\\')) return false;

         

        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f\x7f]/.test(name)) return false;

        for (const seg of name.split('/')) {

          if (!seg || seg === '.' || seg === '..') return false;

          if (!isValidItemName(seg)) return false;

        }

        return true;

      };



      // GET /api/agents - List all agents (with scope filter)

      if (pathname === '/api/agents' && request.method === 'GET') {

        try {

          const scope = url.searchParams.get('scope') || 'all';

          const queryAgentDir = url.searchParams.get('agentDir');

          const projAgentsDir = getProjectAgentsDir(queryAgentDir);



          let agents: Array<{ name: string; description: string; scope: 'user' | 'project'; path: string; folderName: string }> = [];



          if ((scope === 'all' || scope === 'project') && projAgentsDir) {

            agents = agents.concat(scanAgents(projAgentsDir, 'project'));

          }

          if (scope === 'all' || scope === 'user') {

            agents = agents.concat(scanAgents(userAgentsBaseDir, 'user'));

          }



          return jsonResponse({ success: true, agents });

        } catch (error) {

          console.error('[api/agents] Error:', error);

          return jsonResponse(

            { success: false, error: error instanceof Error ? error.message : 'Failed to list agents' },

            500

          );

        }

      }



      // GET /api/agent/sync-check - Check if there are agents to sync from Claude Code

      // NOTE: Must be before /api/agent/:name to avoid wildcard capture

      //

      // Driven by `scanAgents()` so the three SDK-recognised layouts (folder /

      // flat / nested) are all counted — same rule the loader uses for runtime

      // discovery. Agents that Claude Code's SDK sees but that only have a

      // top-level `.md` file (flat) or a subdirectory path (nested) used to

      // silently disappear from the sync UI; now they're first-class.

      if (pathname === '/api/agent/sync-check' && request.method === 'GET') {

        try {
          const homeDir = getHomeDirOrNull() || '';
          const claudeAgentsDir = join(homeDir, '.claude', 'agents');
          if (!existsSync(claudeAgentsDir)) {

            return jsonResponse({ canSync: false, count: 0, folders: [] });

          }



          // scanAgents handles: junctions (via realpath), all 3 layouts,

          // frontmatter validation, dedup by folderName with layout priority.

          // Scope arg ('user') only affects the returned AgentItem.scope —

          // not the scan behavior.

          const claudeAgents = scanAgents(claudeAgentsDir, 'user');



          if (claudeAgents.length === 0) {

            return jsonResponse({ canSync: false, count: 0, folders: [] });

          }



          const zhishiAgents = scanAgents(userAgentsBaseDir, 'user');

          const zhishiSet = new Set(zhishiAgents.map(a => a.folderName));



          // folderName is the canonical agent identity (e.g. "code-reviewer"

          // for flat, "team/reviewer" for nested, "novels" for folder). The

          // client passes these back to sync-from-claude, and we re-validate

          // them against scanAgents output at that time — no raw filesystem

          // name is trusted across the request boundary.

          const allFolders = claudeAgents.map(a => a.folderName);

          const newFolders = claudeAgents.filter(a => !zhishiSet.has(a.folderName)).map(a => a.folderName);

          const conflictFolders = claudeAgents.filter(a => zhishiSet.has(a.folderName)).map(a => a.folderName);



          return jsonResponse({

            canSync: allFolders.length > 0,

            count: allFolders.length,

            folders: allFolders,

            newFolders,

            conflictFolders,

          });

        } catch (error) {

          console.error('[api/agent/sync-check] Error:', error);

          return jsonResponse({ canSync: false, count: 0, folders: [], error: error instanceof Error ? error.message : 'Check failed' }, 500);

        }

      }



      // POST /api/agent/sync-from-claude - Sync agents from Claude Code to ZhiShi

      // NOTE: Must be before /api/agent/:name to avoid wildcard capture

      // Supports conflict handling: mode = 'skip' (default) | 'overwrite'

      //

      // Preserves the source agent's layout:

      //   folder  (.claude/agents/foo/foo.md)        → ~/.zhishi/agents/foo/foo.md  + _meta.json

      //   flat    (.claude/agents/foo.md)            → ~/.zhishi/agents/foo.md       (no _meta.json — flat has no home for it)

      //   nested  (.claude/agents/team/reviewer.md)  → ~/.zhishi/agents/team/reviewer.md  (ditto)

      //

      // Why preserve instead of canonicalize to `folder`: `nested` folderNames

      // contain `/` (e.g. "team/reviewer"), which collapses ambiguously if

      // flattened — "team/reviewer" and just "reviewer" would collide. Keeping

      // the source layout is lossless + matches Claude Code's own storage

      // convention. `scanAgents()` (loader side) already reads all three.

      if (pathname === '/api/agent/sync-from-claude' && request.method === 'POST') {

        try {

          const payload = await request.json().catch(() => ({})) as { mode?: 'skip' | 'overwrite'; folders?: string[] };

          const conflictMode = payload.mode || 'skip';

          const selectedFolders = payload.folders; // Optional: sync only these specific folderNames
          const homeDir = getHomeDirOrNull() || '';
          const claudeAgentsDir = join(homeDir, '.claude', 'agents');
          if (!existsSync(claudeAgentsDir)) {

            return jsonResponse({ success: false, synced: 0, failed: 0, skipped: 0, overwritten: 0, error: 'Claude Code agents directory not found' }, 404);

          }



          // Enumerate via the same protocol-aligned scanner that sync-check uses.

          // Index by folderName so selectedFolders can only reach agents the

          // scanner actually saw — no raw-path injection across the boundary.

          const claudeAgents = scanAgents(claudeAgentsDir, 'user');

          const claudeByName = new Map(claudeAgents.map(a => [a.folderName, a]));



          const foldersToSync = selectedFolders

            ? selectedFolders.filter(f => claudeByName.has(f))

            : Array.from(claudeByName.keys());



          if (foldersToSync.length === 0) {

            return jsonResponse({ success: true, synced: 0, failed: 0, skipped: 0, overwritten: 0, message: 'No agents to sync' });

          }



          if (!existsSync(userAgentsBaseDir)) {

            ensureDirSync(userAgentsBaseDir);

          }



          let synced = 0;

          let failed = 0;

          let skipped = 0;

          let overwritten = 0;

          const errors: string[] = [];

          const conflicts: string[] = [];



          for (const folderName of foldersToSync) {

            const src = claudeByName.get(folderName);

            if (!src) continue;  // defensive, already filtered above



            try {

              // Conflict probe via the SAME scanner used for sync-check, so the

              // "conflict" decision is symmetric regardless of which layout the

              // existing agent lives in on our side (folder vs flat vs nested).

              const existing = findAgent(userAgentsBaseDir, 'user', folderName);

              if (existing) {

                if (conflictMode === 'skip') {

                  skipped++;

                  conflicts.push(folderName);

                  continue;

                }

                // Overwrite: delete the existing agent's own path, which may

                // be in a different layout than the source. `rm({ recursive,

                // force })` handles both file (flat/nested .md) and directory

                // (folder layout) targets. For folder layout we strip back to

                // the folder itself to avoid leaving a ghost _meta.json.

                const existingTarget = existing.layout === 'folder'

                  ? dirname(existing.path)  // the <folderName>/ directory

                  : existing.path;          // the .md file itself

                await rm(existingTarget, { recursive: true, force: true });

                overwritten++;

              }



              // Compute target path from the SOURCE's layout (preserve).

              // For folder layout, copy the whole source directory (may include

              // sibling resources like README.md, data files, etc.). For

              // flat/nested, it's a single-file copy.

              if (src.layout === 'folder') {

                const srcDir = dirname(src.path);

                const destDir = join(userAgentsBaseDir, folderName);

                await copyDirRecursive(srcDir, destDir, '[api/agent/sync-from-claude]');



                // Write _meta.json (only folder layout has a stable home for it).

                // Auto-generated from frontmatter.name so the UI shows a friendly

                // displayName and recognises the agent as synced via the

                // `claude-code-sync` author marker.

                const mdPath = join(destDir, `${folderName}.md`);

                const metaPath = join(destDir, '_meta.json');

                if (existsSync(mdPath) && !existsSync(metaPath)) {

                  try {

                    const content = readFileSync(mdPath, 'utf-8');

                    const { name: agentName } = parseAgentFrontmatter(content);

                    const meta = {

                      displayName: agentName || folderName,

                      author: 'claude-code-sync',

                      createdAt: new Date().toISOString(),

                      updatedAt: new Date().toISOString(),

                    };

                    writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

                  } catch { /* _meta.json generation is optional */ }

                }

              } else {

                // flat or nested: single-file copy. For nested we need to

                // `ensureDir` the parent chain (e.g. "team/" for folderName

                // "team/reviewer"). For flat the parent is userAgentsBaseDir

                // which we already ensured above.

                //

                // folderName for flat is the stem ("foo" → "foo.md"); for

                // nested it's the POSIX stem path ("team/reviewer" →

                // "team/reviewer.md"). Joining with path.join naturally

                // produces the correct OS-specific path on Windows.

                const destPath = join(userAgentsBaseDir, `${folderName}.md`);

                await ensureDir(dirname(destPath));

                await copyFileAsync(src.path, destPath);

              }



              synced++;

            } catch (copyError) {

              failed++;

              errors.push(`${folderName}: ${copyError instanceof Error ? copyError.message : 'Unknown error'}`);

              console.error(`[api/agent/sync-from-claude] Failed to sync "${folderName}":`, copyError);

            }

          }



          return jsonResponse({

            success: true,

            synced,

            failed,

            skipped,

            overwritten,

            conflicts,

            errors: errors.length > 0 ? errors : undefined,

          });

        } catch (error) {

          console.error('[api/agent/sync-from-claude] Error:', error);

          return jsonResponse({ success: false, synced: 0, failed: 0, error: error instanceof Error ? error.message : 'Sync failed' }, 500);

        }

      }



      // POST /api/agent/create - Create new agent

      // NOTE: Must be before /api/agent/:name to avoid wildcard capture

      if (pathname === '/api/agent/create' && request.method === 'POST') {

        try {

          const payload = await request.json() as {

            name: string;

            scope: 'user' | 'project';

            description?: string;

            agentDir?: string;

          };



          if (!payload.name) {

            return jsonResponse({ success: false, error: 'Name is required' }, 400);

          }



          const folderName = sanitizeFolderName(payload.name);

          const agentsDir = getProjectAgentsDir(payload.agentDir || null);

          const baseDir = payload.scope === 'user' ? userAgentsBaseDir : agentsDir;



          if (!baseDir) {

            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);

          }



          const agentFolderDir = join(baseDir, folderName);

          if (existsSync(agentFolderDir)) {

            return jsonResponse({ success: false, error: '智能体已存在' }, 409);

          }



          ensureDirSync(agentFolderDir);



          const frontmatter: Partial<AgentFrontmatter> = {

            name: payload.name,

            description: payload.description || `Description for ${payload.name}`,

          };

          const body = `# ${payload.name}\n\nDescribe your agent instructions here.`;

          const content = serializeAgentContent(frontmatter, body);



          const agentPath = join(agentFolderDir, `${folderName}.md`);

          writeFileSync(agentPath, content, 'utf-8');



          // Create default _meta.json

          writeAgentMeta(agentFolderDir, {

            displayName: payload.name,

            createdAt: new Date().toISOString(),

            updatedAt: new Date().toISOString(),

          });



          return jsonResponse({ success: true, path: agentPath, folderName });

        } catch (error) {

          console.error('[api/agent/create] Error:', error);

          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to create agent' }, 500);

        }

      }



      // GET /api/agents/workspace-config - Read workspace agent config

      if (pathname === '/api/agents/workspace-config' && request.method === 'GET') {

        try {

          const queryAgentDir = url.searchParams.get('agentDir');

          const effectiveDir = (queryAgentDir && isValidAgentDir(queryAgentDir).valid ? queryAgentDir : currentAgentDir) || '';

          if (!effectiveDir) {

            return jsonResponse({ success: true, config: { local: {}, global_refs: {} } });

          }

          const config = readWorkspaceConfig(effectiveDir);

          return jsonResponse({ success: true, config });

        } catch (error) {

          console.error('[api/agents/workspace-config] Error:', error);

          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to read config' }, 500);

        }

      }



      // PUT /api/agents/workspace-config - Update workspace agent config

      if (pathname === '/api/agents/workspace-config' && request.method === 'PUT') {

        try {

          const payload = await request.json() as { config: AgentWorkspaceConfig; agentDir?: string };

          const effectiveDir = (payload.agentDir && isValidAgentDir(payload.agentDir).valid ? payload.agentDir : currentAgentDir) || '';

          if (!effectiveDir) {

            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);

          }

          writeWorkspaceConfig(effectiveDir, payload.config);

          return jsonResponse({ success: true });

        } catch (error) {

          console.error('[api/agents/workspace-config] Error:', error);

          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to update config' }, 500);

        }

      }



      // GET /api/agents/enabled - Get enabled agents as SDK definitions

      if (pathname === '/api/agents/enabled' && request.method === 'GET') {

        try {

          const queryAgentDir = url.searchParams.get('agentDir');

          const effectiveDir = (queryAgentDir && isValidAgentDir(queryAgentDir).valid ? queryAgentDir : currentAgentDir) || '';

          const projAgentsDir = effectiveDir ? join(effectiveDir, '.claude', 'agents') : '';

          const agents = loadEnabledAgents(projAgentsDir, userAgentsBaseDir);

          return jsonResponse({ success: true, agents });

        } catch (error) {

          console.error('[api/agents/enabled] Error:', error);

          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to load agents' }, 500);

        }

      }



      // POST /api/agents/set - Set agents and trigger session resume

      if (pathname === '/api/agents/set' && request.method === 'POST') {

        try {

          const payload = await request.json() as { agents: Record<string, unknown> };

          // The payload.agents is already in SDK AgentDefinition format

          setAgents(payload.agents as Record<string, import('./agent-session').AgentDefinition>);

          return jsonResponse({ success: true });

        } catch (error) {

          console.error('[api/agents/set] Error:', error);

          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set agents' }, 500);

        }

      }





      // POST /api/model/set - Set default model for this session

      if (pathname === '/api/model/set' && request.method === 'POST') {

        try {

          const payload = await request.json() as { model?: string };

          if (!payload?.model) {

            return jsonResponse({ success: false, error: 'model is required' }, 400);

          }

          setSessionModel(payload.model);

          return jsonResponse({ success: true });

        } catch (error) {

          console.error('[api/model/set] Error:', error);

          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set model' }, 500);

        }

      }



      // POST /api/provider/set - Set provider env for this session (called by Rust IM router on sidecar creation)

      if (pathname === '/api/provider/set' && request.method === 'POST') {

        try {

          const payload = await request.json() as { providerEnv?: Record<string, unknown> };

          const { setSessionProviderEnv } = await import('./agent-session');

          // Normalize null → undefined (Rust sends { "providerEnv": null } when clearing)

          setSessionProviderEnv((payload?.providerEnv ?? undefined) as import('./agent-session').ProviderEnv | undefined);

          return jsonResponse({ success: true });

        } catch (error) {

          console.error('[api/provider/set] Error:', error);

          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set provider' }, 500);

        }

      }



      // POST /api/session/permission-mode - Set permission mode for this session (called by Rust IM router)

      if (pathname === '/api/session/permission-mode' && request.method === 'POST') {

        try {

          const payload = await request.json() as { permissionMode?: string };

          if (!payload?.permissionMode) {

            return jsonResponse({ success: false, error: 'permissionMode is required' }, 400);

          }

          // M4c: SDK 会话权限模式随删——pi 引擎不按会话切权限模式,此端点只应答成功(配置面由 /api/config 管理)。

          console.log('[api/session/permission-mode] M4c: no-op (pi 引擎边界是规则,非会话权限)');

          return jsonResponse({ success: true });

        } catch (error) {

          console.error('[api/session/permission-mode] Error:', error);

          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set permission mode' }, 500);

        }

      }

      // GET /api/session/config - Read sidecar's current config state

      // Used by Tabs joining an existing sidecar (e.g. IM Bot session) to adopt

      // the session's config instead of pushing their own.

      if (pathname === '/api/session/config' && request.method === 'GET') {

        try {

          const { getSessionModel, getMcpServers, getAgents } = await import('./agent-session');

          const model = getSessionModel();

          const mcpServers = getMcpServers();

          const agents = getAgents();

          const permissionMode = null; // M4c: 会话权限模式随 SDK 删除

          return jsonResponse({

            success: true,

            runtime: 'builtin',

            model: model ?? null,

            mcpServerIds: mcpServers?.map(s => s.id) ?? null,

            agentNames: agents ? Object.keys(agents) : null,

            permissionMode,

          });

        } catch (error) {

          console.error('[api/session/config] Error:', error);

          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to get session config' }, 500);

        }

      }



      // GET /api/agent/:name - Get agent detail

      //

      // `folderName` is the UI-facing stable id (see agent-loader.ts for its

      // computation rules). We can't hard-assemble the path as

      // `<base>/<folderName>/<folderName>.md` anymore — flat/nested layouts

      // live elsewhere — so we scan and look up by folderName, reusing

      // `AgentItem.path` / `.layout` from there.

      if (pathname.startsWith('/api/agent/') && request.method === 'GET') {

        try {

          const agentName = decodeURIComponent(pathname.replace('/api/agent/', ''));

          if (!isValidAgentFolderName(agentName)) {

            return jsonResponse({ success: false, error: 'Invalid agent name' }, 400);

          }

          const scope = (url.searchParams.get('scope') || 'project') as 'user' | 'project';

          const queryAgentDir = url.searchParams.get('agentDir');

          const agentsDir = getProjectAgentsDir(queryAgentDir);

          const baseDir = scope === 'user' ? userAgentsBaseDir : agentsDir;



          const item = findAgent(baseDir, scope, agentName);

          if (!item) {

            return jsonResponse({ success: false, error: '智能体不存在' }, 404);

          }



          const content = readFileSync(item.path, 'utf-8');

          const { frontmatter, body } = parseFullAgentContent(content);



          return jsonResponse({

            success: true,

            agent: {

              name: frontmatter.name || item.folderName,

              folderName: item.folderName,

              path: item.path,

              scope,

              layout: item.layout,

              frontmatter,

              body,

              ...(item.meta ? { meta: item.meta } : {}),

            }

          });

        } catch (error) {

          console.error('[api/agent] Error:', error);

          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to get agent' }, 500);

        }

      }



      // PUT /api/agent/:name - Update agent (with optional folder rename for

      // 'folder' layout only)

      //

      // Lookup is by (folderName, scope) via findAgent(); we never reassemble

      // the path. Rename stays restricted to the canonical 'folder' layout:

      //   - flat agents live next to siblings and would collide on rename

      //   - nested agents belong to a user-managed directory tree (Claude

      //     Code plugin, synced-in content, etc.) — renaming would mutate

      //     their container out from under them

      // Callers can relocate such agents by hand; UI should hide the rename

      // affordance when `layout !== 'folder'`.

      if (pathname.startsWith('/api/agent/') && request.method === 'PUT') {

        try {

          const agentName = decodeURIComponent(pathname.replace('/api/agent/', ''));

          if (!isValidAgentFolderName(agentName)) {

            return jsonResponse({ success: false, error: 'Invalid agent name' }, 400);

          }

          const payload = await request.json() as {

            scope: 'user' | 'project';

            frontmatter: Partial<AgentFrontmatter>;

            body: string;

            newFolderName?: string;

            agentDir?: string;

            meta?: AgentMeta;

          };



          const agentsDir = getProjectAgentsDir(payload.agentDir || null);

          const baseDir = payload.scope === 'user' ? userAgentsBaseDir : agentsDir;



          const item = findAgent(baseDir, payload.scope, agentName);

          if (!item) {

            return jsonResponse({ success: false, error: '智能体不存在' }, 404);

          }



          let currentFolderName = item.folderName;

          let agentPath = item.path;

          let agentFolderDir = dirname(item.path);



          // Rename is only meaningful for the 'folder' layout

          if (payload.newFolderName && payload.newFolderName !== currentFolderName) {

            if (item.layout !== 'folder') {

              return jsonResponse({

                success: false,

                error: `当前智能体布局为 ${item.layout}，不支持重命名。请手动调整文件结构后再试。`,

              }, 400);

            }

            const newFolderName = payload.newFolderName;

            if (!isValidItemName(newFolderName)) {

              return jsonResponse({ success: false, error: 'Invalid new folder name' }, 400);

            }

            const newAgentDir = join(baseDir, newFolderName);

            if (existsSync(newAgentDir)) {

              return jsonResponse({ success: false, error: `智能体文件夹 "${newFolderName}" 已存在，请使用其他名称` }, 409);

            }



            const content = serializeAgentContent(payload.frontmatter, payload.body);

            renameSync(agentFolderDir, newAgentDir);

            agentFolderDir = newAgentDir;

            currentFolderName = newFolderName;



            // Rename the .md file inside to match new folder name

            const oldMdPath = join(agentFolderDir, `${item.folderName}.md`);

            agentPath = join(agentFolderDir, `${newFolderName}.md`);

            if (existsSync(oldMdPath)) {

              renameSync(oldMdPath, agentPath);

            }



            writeFileSync(agentPath, content, 'utf-8');

            const existingMeta = readAgentMeta(agentFolderDir);

            const updatedMeta = { ...existingMeta, ...payload.meta, displayName: payload.frontmatter.name || newFolderName, updatedAt: new Date().toISOString() };

            writeAgentMeta(agentFolderDir, updatedMeta);

            return jsonResponse({ success: true, path: agentPath, folderName: currentFolderName });

          }



          // No rename — update content in place regardless of layout

          const content = serializeAgentContent(payload.frontmatter, payload.body);

          writeFileSync(agentPath, content, 'utf-8');



          // _meta.json only lives next to 'folder' layout agents. For flat /

          // nested, skip — there's no unambiguous place for it.

          if (item.layout === 'folder') {

            const existingMeta = readAgentMeta(agentFolderDir);

            if (payload.meta || (payload.frontmatter.name && payload.frontmatter.name !== existingMeta?.displayName)) {

              const updatedMeta = { ...existingMeta, ...payload.meta, updatedAt: new Date().toISOString() };

              if (payload.frontmatter.name) updatedMeta.displayName = payload.frontmatter.name;

              writeAgentMeta(agentFolderDir, updatedMeta);

            }

          }

          return jsonResponse({ success: true, path: agentPath, folderName: currentFolderName });

        } catch (error) {

          console.error('[api/agent] Error:', error);

          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to update agent' }, 500);

        }

      }



      // DELETE /api/agent/:name - Delete agent

      //

      // Deletion shape depends on layout:

      //   - folder: remove the whole <base>/<folderName>/ directory

      //   - flat:   remove the single <base>/<folderName>.md file

      //   - nested: remove only the .md file, leave the surrounding directory

      //             structure alone (it's user- or plugin-managed)

      if (pathname.startsWith('/api/agent/') && request.method === 'DELETE') {

        try {

          const agentName = decodeURIComponent(pathname.replace('/api/agent/', ''));

          if (!isValidAgentFolderName(agentName)) {

            return jsonResponse({ success: false, error: 'Invalid agent name' }, 400);

          }

          const scope = (url.searchParams.get('scope') || 'project') as 'user' | 'project';

          const queryAgentDir = url.searchParams.get('agentDir');

          const agentsDir = getProjectAgentsDir(queryAgentDir);

          const baseDir = scope === 'user' ? userAgentsBaseDir : agentsDir;



          const item = findAgent(baseDir, scope, agentName);

          if (!item) {

            return jsonResponse({ success: false, error: '智能体不存在' }, 404);

          }



          if (item.layout === 'folder') {

            rmSync(dirname(item.path), { recursive: true, force: true });

          } else {

            rmSync(item.path, { force: true });

          }

          return jsonResponse({ success: true });

        } catch (error) {

          console.error('[api/agent] Error:', error);

          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to delete agent' }, 500);

        }

      }



      // ============= END SLASH COMMANDS API =============



      // ============= OPENAI BRIDGE (Loopback, per-token) =============

      // M4c: /bridge/* 端点已随 openai-bridge 删除(OpenAI 协议由 pi 直连)。


      const staticResponse = await serveStatic(pathname);

      if (staticResponse) {

        return staticResponse;

      }



      return new Response('Not Found', { status: 404 });

    }

  }



  // The same HTTP server serves both purposes — Tauri client proxies all

  // /api/* + /sessions/* + /chat/stream traffic here via Rust local_http;

  // browser dev mode (`./scripts/dev/start_dev.sh`) additionally hits the `serveStatic`

  // fallback to load the React `dist/` bundle. Naming reflects the

  // production primary role.

  console.log(`[startup] Sidecar HTTP server ready on http://127.0.0.1:${port}`);



  // Pattern 2 §2.3.1 — Start the periodic GC for spilled large-value refs.

  // Runs every 60s; reaps any ref past its TTL (default 1h). The timer is

  // unref'd inside startRefsGc, so it doesn't keep the event loop alive.

  void import('./utils/large-value-store').then(({ startRefsGc }) => {

    startRefsGc(60_000);

  }).catch((err) => {

    console.warn(`[refs] failed to start GC: ${err instanceof Error ? err.message : String(err)}`);

  });



  // ── Deferred heavy init ─────────────────────────────────────────────────

  // Runs AFTER honoServe has bound the port. Rust's TCP health check now

  // passes within ~50ms instead of waiting ~2s for all this work to finish.

  // Routes (except /health) `await __zhishiDeferredInit` before running,

  // so correctness is preserved: anything that needs agent state (MCP,

  // model, file watcher, bridge) waits for this block to finish.

  //

  // Order within this block still matters:

  //   1. migrations/cleanup — best-effort, can interleave

  //   2. socks bridge BEFORE initializeAgent (pre-warm spawns SDK which

  //      reads HTTP_PROXY env vars set by initSocksBridgeFromEnv)

  //   3. initializeAgent — the big one

  //   4. boot banner — prints with fully resolved state

  // Pattern 4: track which phase is running so /health/ready can report

  // {phase: 'migration' | 'skill-seed' | 'sdk-init' | ...} on failure.

  let currentInitPhase = 'startup';

  const deferredInitStarted = nowMs();

  let initPhaseStarted = deferredInitStarted;

  const emitDeferredPhaseDone = (phase: string) => {

    emitPerfTrace({

      trace: 'sidecar_boot',

      phase: 'deferred_init_phase_done',

      durationMs: elapsedMs(initPhaseStarted),

      status: 'ok',

      detail: { phase, port },

    });

  };

  emitPerfTrace({

    trace: 'sidecar_boot',

    phase: 'deferred_init_start',

    status: 'ok',

    detail: { port, sessionId: initialSessionId ?? 'new' },

  });

  (async () => {

    try {

      currentInitPhase = 'cleanup';

      setDeferredInitPhase(currentInitPhase);

      initPhaseStarted = nowMs();

      // Unified retention sweep (#121) — replaces v0.2.7's split between

      // cleanupOldLogs (per-session) + cleanupOldUnifiedLogs (unified). One

      // policy module covers age cutoff, byte budget, and the recent-data

      // floor across all sources. Per-session logs gained a byte budget

      // here for the first time.

      //

      // The active-file set protects BOTH the unified log we're appending

      // to AND the per-session log file (if AgentLogger has one open) from

      // budget eviction — without this, a long-lived session log past the

      // 7-day floor could be unlinked while the WriteStream is still open.

      const collectActivePaths = (): ReadonlySet<string> => {

        const paths = new Set<string>();

        const u = getActiveUnifiedLogPath();

        if (u) paths.add(u);

        const s = getActiveSessionLogPath();

        if (s) paths.add(s);

        return paths;

      };

      runLogRetentionSweep({ activeFilePaths: collectActivePaths() });

      // Hourly background sweep — bounds gradual growth without waiting

      // for the next 50MB rotation event. Active-file getter is invoked

      // at each sweep so day-rollovers are reflected.

      startPeriodicSweep(collectActivePaths);

      cleanupStalePlaywrightProfile();



      // Issue #194 follow-up — one-time scrub for stale agent.runtimeConfig

      // fields from before buildRuntimeChangePatch existed. Idempotent via

      // per-agent `_runtimeConfigScrubV1` marker; subsequent boots short-

      // circuit per agent. See doc comment in the migration module.

      try {

        const { scrubStaleRuntimeConfig } = await import('./migrations/scrub-stale-runtime-config');

        const result = await scrubStaleRuntimeConfig();

        if (result.scannedAgents > 0) {

          console.log(`[migration] runtimeConfig scrub: scanned=${result.scannedAgents} scrubbed=${result.scrubbedAgents}`);

          for (const d of result.details) {

            console.log(`[migration] runtimeConfig scrub: agent=${d.agentId} runtime=${d.runtime} dropped=${JSON.stringify(d.dropped)}`);

          }

        }

      } catch (err) {

        console.warn('[migration] runtimeConfig scrub failed (non-fatal):', err instanceof Error ? err.message : String(err));

      }

      emitDeferredPhaseDone('cleanup');



      currentInitPhase = 'skill-seed';

      setDeferredInitPhase(currentInitPhase);

      initPhaseStarted = nowMs();

      seedBundledSkills();
      seedEnvironmentRecipes();

      console.log('[startup] seedBundledSkills done');



      // 蒸馏弧（宪章 §4.2）— 幂等播种内置 recurring cron 任务「蒸馏弧」

      // （每小时）与「安全蒸馏弧」（D3，每 6 小时）。fire-and-forget：

      // management API 未就绪或播种失败都不阻塞启动，下次 sidecar 启动会重试。

      void import('./memory/distill-runner')

        .then(async (m) => {

          await m.seedDistillArcTask(currentAgentDir);

          // 安全蒸馏弧（D3）：同一哨兵模式的独立弧，6 小时节奏，一并幂等播种。

          await m.seedResearchDistillArcTask(currentAgentDir);

        })

        .catch((err) => console.warn('[distill] seed failed (non-fatal):', err instanceof Error ? err.message : err));



      // #296 — install the backend auto-title trigger into the turn-hooks slot

      // BEFORE any turn can complete (initializeAgent / pre-warm run below).

      installAutoTitleHook();



      emitDeferredPhaseDone('skill-seed');



      currentInitPhase = 'socks-bridge';

      setDeferredInitPhase(currentInitPhase);

      initPhaseStarted = nowMs();

      await initSocksBridgeFromEnv();

      emitDeferredPhaseDone('socks-bridge');



      currentInitPhase = 'sdk-init';

      setDeferredInitPhase(currentInitPhase);

      initPhaseStarted = nowMs();

      await initializeAgent(currentAgentDir, initialPrompt, initialSessionId);

      console.log('[startup] initializeAgent done');

      // M4a — pi 引擎外壳初始化(env 锚定按工作区读 env-selection.json;

      // M4b 起为 async:pi 引擎下续接最近的 loop 会话)。

      await initPiChatEngine(currentAgentDir);

      console.log(`[startup] loop engine: ${isPiEngine() ? 'pi (M4c 默认)' : 'sdk (default)'}`);

      emitDeferredPhaseDone('sdk-init');



      // ── Sidecar Boot Banner: single-line for AI grep ──

      {

        const model = getSessionModel() || '?';

        const mcpList = getMcpServers();

        const mcpNames = mcpList ? Object.keys(mcpList).join(',') || 'none' : 'none';

        const bridge = 'no'; // M4c: openai-bridge 已删除

        // Health signal: surface which builtin MCP META ids are registered.

        // An empty list ('none') is expected when no user-toggleable builtins

        // are registered (the gemini-image / edge-tts builtins were removed).

        const { listBuiltinMcpIds } = await import('./tools/builtin-mcp-registry');

        const builtinMcpMeta = listBuiltinMcpIds().join(',') || 'none';

        console.log(`[boot] pid=${process.pid} port=${port} node=${process.versions.node} workspace=${currentAgentDir} session=${initialSessionId ?? 'new'} resume=${!!initialSessionId} model=${model} bridge=${bridge} mcp=${mcpNames} builtin-mcp-meta=${builtinMcpMeta}`);

      }



      markDeferredInitReady();

      resolveDeferredInit();

      emitPerfTrace({

        trace: 'sidecar_boot',

        phase: 'deferred_init_done',

        durationMs: elapsedMs(deferredInitStarted),

        status: 'ok',

        detail: { port, sessionId: initialSessionId ?? 'new' },

      });

    } catch (err) {

      console.error('[startup] Deferred init failed:', err);

      console.warn(`[health-state] Deferred init failed in phase=${currentInitPhase}: ${err instanceof Error ? err.message : String(err)}`);

      emitPerfTrace({

        trace: 'sidecar_boot',

        phase: 'deferred_init_failed',

        durationMs: elapsedMs(deferredInitStarted),

        status: 'error',

        detail: {

          phase: currentInitPhase,

          port,

          error: err instanceof Error ? err.message : String(err),

        },

      });

      // Pattern 4: capture the phase for /health/ready's structured 503.

      // retryable=false until we have a real re-runner (TODO above).

      markDeferredInitFailed(currentInitPhase, err, false);

      rejectDeferredInit(err);

      // Don't re-throw — the server stays up so /health/* keeps responding

      // and the renderer can render the failure state instead of timing out.

    }

  })();



  // Kick off interactive-shell PATH detection in the background.

  // `warmupShellPath()` uses async `execFile` so it never blocks the event loop

  // (unlike the old `execSync` path, which starved TCP accept for 3–5s while

  // zsh -i -l sourced a heavy .zshrc — Rust's sidecar health check would retry

  // 15× before finally connecting).

  //

  // Startup returns immediately; detected PATH is applied whenever the shell

  // finishes. `getShellEnv()` keeps returning the platform fallback PATH until

  // then — sufficient for common binary lookups (.zhishi/bin, homebrew, nvm,

  // fnm, volta, pnpm, cargo all in fallback).

  import('./utils/shell').then(({ warmupShellPath, getShellPath }) => {

    warmupShellPath().then(() => {

      console.log('[server] Startup PATH:', getShellPath());

    });

  });

}



main().catch((error) => {

  console.error(error instanceof Error ? error.message : error);

  process.exit(1);

});


