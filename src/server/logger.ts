/**

 * Unified Logger - Intercepts console.log/error/warn and forwards to SSE

 * 

 * This module provides automatic log forwarding from the Node Sidecar to the frontend.

 * All console.log/error/warn calls are intercepted and sent via SSE events.

 * 

 * Fixes applied based on ChatGPT/Gemini feedback:

 * 1. Debug logging to trace clients.length and broadcast calls

 * 2. Ring Buffer to cache early logs (before SSE client connects)

 * 3. getLogHistory() for sending cached logs when client connects

 */



import type { createSseClient } from './sse';

// SSE_INSTANCE_ID imported from sse-instance (the leaf module), NOT from

// sse.ts — pulling it from sse.ts would re-introduce the static cycle

// logger → sse → logger (the latter via dynamic import in connect()).

// Re-export from sse.ts is preserved for any external caller that

// already imported it from there.

import { SSE_INSTANCE_ID } from './sse-instance';

import { appendUnifiedLog } from './UnifiedLogger';

import type { LogEntry, LogLevel } from '../shared/types/log';

import { localTimestamp } from '../shared/logTime';

import { getLogContext } from './logger-context';



// Re-export types for backward compatibility

export type { LogEntry, LogLevel };



// Re-export Pattern 6 correlation helpers for callers that already import

// from './logger'. The implementation lives in `./logger-context` to avoid

// a circular import with `./UnifiedLogger`.

export {

    withLogContext,

    getLogContext,

    logContextStorage,

    setAmbientLogContext,

    clearAmbientLogContextField,

} from './logger-context';

export type { LogContext } from './logger-context';



// ==================== Ring Buffer for Log History ====================

// (Per Gemini's suggestion: cache logs before any SSE client connects)

const MAX_HISTORY = 100;

const logHistory: LogEntry[] = [];



/**

 * Get cached log history (for sending to newly connected clients)

 */

export function getLogHistory(): LogEntry[] {

    return logHistory;

}



// ==================== Original Console Methods ====================

const originalConsole = {

    log: console.log.bind(console),

    error: console.error.bind(console),

    warn: console.warn.bind(console),

    debug: console.debug.bind(console),

};



// PRD #132 — once stdio is broken, every `originalConsole.*` call below

// is another potential EPIPE → uncaughtException. The wrapper used to feed

// itself: a failed stderr write turned into uncaughtException, whose

// handler called console.error, which routed back into this wrapper, which

// called originalConsole.error again, which raised another EPIPE — fast

// loop that wrote 50–200 KB to ~/.zhishi/logs/crash/<ts>.log per

// iteration until the disk filled. After the stdio listener in index.ts

// flips the broken bit, we silently skip the originalConsole.* call and

// only keep the in-memory ring + SSE broadcast paths alive.

//

// We expose BOTH a probe (read) and a marker (write): the probe lets the

// wrapper skip writes after the async stdio listener trips the bit; the

// marker lets the sync-throw branch below set the bit immediately so we

// don't even attempt the next call (would otherwise wait for the next

// event-loop turn for the async listener to do it).

let stdioBrokenRef: () => boolean = () => false;

let markStdioBrokenRef: () => void = () => {};

export function setStdioBrokenProbe(probe: () => boolean, marker: () => void): void {

    stdioBrokenRef = probe;

    markStdioBrokenRef = marker;

}

function safeOriginal(method: 'log' | 'error' | 'warn' | 'debug', args: unknown[]): void {

    if (stdioBrokenRef()) return;

    try {

        originalConsole[method](...args);

    } catch {

        // The write itself threw (sync EPIPE on tty fd). Mark broken so we

        // stop trying. The `error` listener in index.ts also catches the

        // matching async error and sets the same flag, but we set it now

        // so the very next call short-circuits without another attempt.

        try { markStdioBrokenRef(); } catch { /* unreachable */ }

    }

}



// ==================== Broadcast Function ====================

let broadcastLog: ((entry: LogEntry) => void) | null = null;



/**

 * Format arguments to string (safely handles objects)

 */

function formatArgs(args: unknown[]): string {

    return args.map(arg => {

        if (typeof arg === 'string') return arg;

        if (arg instanceof Error) return `${arg.name}: ${arg.message}`;

        try {

            // Use simpler stringification to avoid circular reference issues

            return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);

        } catch {

            return String(arg);

        }

    }).join(' ');

}



/**

 * Create a log entry and broadcast it

 * Also stores in history buffer (Ring Buffer per Gemini's suggestion)

 */

function createAndBroadcast(level: LogLevel, args: unknown[]): void {

    // Skip if the message is from our own debug logging (prevent infinite loop)

    const message = formatArgs(args);

    if (message.includes('[sse] getClients')) return; // Avoid recursion

    // NOTE: [sse] logs are no longer filtered — they're needed for diagnosing SSE delivery issues.

    // The previous filter (`message.startsWith('[sse]')`) hid ALL broadcast logs from unified log,

    // making it impossible to verify whether events were actually sent to SSE clients.



    const entry: LogEntry = {

        // NOTE (fix #15): kept as 'bun' for backward compatibility with

        // historical log files and the renderer's `LogSource` discriminant

        // (`src/shared/types/log.ts`; the renderer UnifiedLogsPanel was deleted with the GUI

        // expect 'bun' — labelled "NODE" in the UI). v0.2.0 migrated to

        // Node.js but the wire-level token stays so old logs are still

        // queryable. Don't rename without coordinated migration of every

        // historical log file.

        source: 'bun',

        level,

        message,

        timestamp: localTimestamp(),

    };



    // Pattern 6: merge correlation fields from the surrounding ALS frame.

    // Outside any `withLogContext(...)` wrapper, getLogContext() returns

    // undefined and the entry stays correlation-free (current behaviour).

    const ctx = getLogContext();

    if (ctx) {

        if (ctx.sessionId) entry.sessionId = ctx.sessionId;

        if (ctx.tabId) entry.tabId = ctx.tabId;

        if (ctx.ownerId) entry.ownerId = ctx.ownerId;

        if (ctx.requestId) entry.requestId = ctx.requestId;

        if (ctx.turnId) entry.turnId = ctx.turnId;

        if (ctx.runtime) entry.runtime = ctx.runtime;

    }



    // Store in history buffer (Ring Buffer)

    logHistory.push(entry);

    if (logHistory.length > MAX_HISTORY) {

        logHistory.shift();

    }



    // Persist to unified log file

    appendUnifiedLog(entry);



    // Broadcast to connected clients

    if (broadcastLog) {

        try {

            broadcastLog(entry);

        } catch (e) {

            // Log error using original console to prevent infinite loops.

            // PRD #132 — `originalConsole.error` itself can EPIPE when stdio

            // is closed; route through the safe wrapper so we don't seed a

            // new recursion.

            safeOriginal('error', ['[Logger] Broadcast failed:', e]);

        }

    }

}



/**

 * Initialize the logger with SSE broadcast capability

 * @param getSseClients Function that returns all active SSE clients

 */

export function initLogger(getSseClients: () => ReturnType<typeof createSseClient>['client'][]): void {

    broadcastLog = (entry: LogEntry) => {

        const clients = getSseClients();

        for (const client of clients) {

            try {

                client.send('chat:log', entry);

            } catch (e) {

                safeOriginal('error', ['[Logger] client.send failed:', e]);

            }

        }

    };



    // Override console methods. PRD #132 — `safeOriginal` skips the write

    // when stdio is closed so we don't reseed the recursive EPIPE loop.

    console.log = (...args: unknown[]) => {

        safeOriginal('log', args);

        createAndBroadcast('info', args);

    };



    console.error = (...args: unknown[]) => {

        safeOriginal('error', args);

        createAndBroadcast('error', args);

    };



    console.warn = (...args: unknown[]) => {

        safeOriginal('warn', args);

        createAndBroadcast('warn', args);

    };



    console.debug = (...args: unknown[]) => {

        safeOriginal('debug', args);

        createAndBroadcast('debug', args);

    };



    // Mark console.log as patched (for diagnostics endpoint)

    (console.log as unknown as Record<string, boolean>).__patched_by_logger__ = true;



    safeOriginal('log', ['[Logger] Unified logging initialized']);

}



/**

 * Restore original console methods (for testing)

 */

export function restoreConsole(): void {

    console.log = originalConsole.log;

    console.error = originalConsole.error;

    console.warn = originalConsole.warn;

    console.debug = originalConsole.debug;

    broadcastLog = null;

}



/**

 * Manually send a log entry (for direct usage without console)

 */

export function sendLog(level: LogLevel, message: string, meta?: Record<string, unknown>): void {

    const entry: LogEntry = {

        source: 'bun',

        level,

        message,

        timestamp: localTimestamp(),

        meta,

    };



    // Pattern 6: same correlation merge as createAndBroadcast() — `sendLog`

    // is a back-channel for tooling that doesn't go through console.* (e.g.

    // structured emit from background workers). It still benefits from ALS.

    const ctx = getLogContext();

    if (ctx) {

        if (ctx.sessionId) entry.sessionId = ctx.sessionId;

        if (ctx.tabId) entry.tabId = ctx.tabId;

        if (ctx.ownerId) entry.ownerId = ctx.ownerId;

        if (ctx.requestId) entry.requestId = ctx.requestId;

        if (ctx.turnId) entry.turnId = ctx.turnId;

        if (ctx.runtime) entry.runtime = ctx.runtime;

    }



    // PRD #132 — route through safeOriginal so this back-channel respects

    // the same stdio-broken short-circuit as the patched `console.*`. A

    // future caller of sendLog() during a closed-pipe state would otherwise

    // re-seed the EPIPE recursion that #132 was designed to prevent.

    safeOriginal(level === 'info' ? 'log' : level, [message]);



    // Store in history

    logHistory.push(entry);

    if (logHistory.length > MAX_HISTORY) {

        logHistory.shift();

    }



    // Persist to unified log file

    appendUnifiedLog(entry);



    if (broadcastLog) {

        try {

            broadcastLog(entry);

        } catch {

            // Ignore

        }

    }

}



/**

 * Get logger diagnostics for debugging (exposed via /debug/logger endpoint)

 */

export function getLoggerDiagnostics() {

    return {

        initialized: broadcastLog !== null,

        consolePatched: (console.log as unknown as Record<string, boolean>).__patched_by_logger__ ?? false,

        historySize: logHistory.length,

        recentLogs: logHistory.slice(-5).map(l => ({ level: l.level, message: l.message.slice(0, 50) })),

        sseInstanceId: SSE_INSTANCE_ID,

    };

}

