/**
 * Shared log types for the unified logging system
 */

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

/**
 * v0.2.0+: Sidecar runs on Node.js, but the discriminant `'bun'` is kept
 * so pre-0.2.0 unified-log files (`~/.zhishi/logs/unified-YYYY-MM-DD.log`)
 * parse correctly after an upgrade. The UI displays "NODE" for this key —
 * see `UnifiedLogsPanel.tsx::SOURCE_LABELS`.
 */
export type LogSource = 'bun' | 'rust' | 'react';

export interface LogEntry {
    source: LogSource;
    level: LogLevel;
    message: string;
    timestamp: string;
    meta?: Record<string, unknown>;
    // ── Pattern 6 correlation fields ───────────────────────────────────
    // Optional structured fields auto-populated from a context store
    // (Node `AsyncLocalStorage` / Renderer module-level current-tab /
    // Rust `tokio::task_local!`). Existing `console.*` callsites keep
    // working unchanged — capture path now reads context and merges
    // these in. Used to filter unified logs across processes by
    // `sessionId`, `tabId`, `turnId`, `requestId`, `runtime`, `ownerId`.
    sessionId?: string;
    tabId?: string;
    ownerId?: string;
    requestId?: string;
    turnId?: string;
    /** Runtime label e.g. 'claude-code' | 'codex' | 'gemini' | 'builtin'. */
    runtime?: string;
}
