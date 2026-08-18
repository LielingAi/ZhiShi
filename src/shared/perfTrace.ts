/**
 * Shared perf-trace vocabulary (renderer + server) — single source of truth.
 * Pure: no node / DOM deps, safe under `src/shared`.
 *
 * `src/server/utils/perf-trace.ts` imports these types and adds Node-specific
 * runtime helpers (`emitPerfTrace` / `nowMs` / `elapsedMs` / `traceAsync`)
 * that depend on `node:perf_hooks`. Rust mirrors the same field vocabulary in
 * `src-tauri/src/perf_trace.rs`. When adding a new `PerfTraceName` or field,
 * update all three sites (this file, server helpers, Rust) so the unified-log
 * `[perf]` line stays consistent across layers.
 */

export type PerfTraceName =
    | 'renderer' // front-end (WebView) interaction phases
    | 'sidecar_boot'
    | 'turn'
    | 'runtime'
    | 'storage_io'
    | 'background_job';

export type PerfTraceStatus = 'ok' | 'error' | 'timeout' | 'skipped';

export type PerfTraceDetail = Record<string, string | number | boolean | null | undefined>;

export interface PerfTraceEvent {
    trace: PerfTraceName;
    phase: string;
    durationMs?: number;
    sessionId?: string;
    tabId?: string;
    ownerId?: string;
    requestId?: string;
    turnId?: string;
    runtime?: string;
    status?: PerfTraceStatus;
    sizeBytes?: number;
    count?: number;
    detail?: PerfTraceDetail;
}

/** Front-end interaction milestones P0 measures (greppable phase names). */
export const RENDERER_PERF_PHASE = {
    firstPaint: 'first_paint',
    routeChunkLoad: 'route_chunk_load',
    newTabReveal: 'new_tab_reveal',
    tabShellPainted: 'tab_shell_painted',
    tabDataReady: 'tab_data_ready',
    streamCommit: 'stream_commit',
    tabCacheHit: 'tab_cache_hit',
    tabCacheMiss: 'tab_cache_miss',
} as const;

/**
 * Format a perf event as a stable, greppable single line for the unified log
 * (prefix `[perf]`). Pure — unit-tested. Field order is fixed so log diffs are
 * stable; undefined/null fields are omitted; `detail` keys are sorted.
 */
export function formatPerfLine(e: PerfTraceEvent): string {
    const parts = [`trace=${e.trace}`, `phase=${e.phase}`];
    if (e.durationMs !== undefined && e.durationMs !== null) parts.push(`durationMs=${e.durationMs}`);
    if (e.status) parts.push(`status=${e.status}`);
    if (e.tabId) parts.push(`tabId=${e.tabId}`);
    if (e.sessionId) parts.push(`sessionId=${e.sessionId}`);
    if (e.runtime) parts.push(`runtime=${e.runtime}`);
    if (e.count !== undefined && e.count !== null) parts.push(`count=${e.count}`);
    if (e.sizeBytes !== undefined && e.sizeBytes !== null) parts.push(`sizeBytes=${e.sizeBytes}`);
    if (e.detail) {
        for (const k of Object.keys(e.detail).sort()) {
            const v = e.detail[k];
            if (v !== undefined && v !== null) parts.push(`${k}=${v}`);
        }
    }
    return `[perf] ${parts.join(' ')}`;
}
