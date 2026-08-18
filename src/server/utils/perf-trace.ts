import { performance } from 'node:perf_hooks';

// PRD 0.2.32 §6.6 — PerfTrace TS types have a single source of truth in
// `src/shared/perfTrace.ts`. This file keeps only Node-specific runtime
// helpers (nowMs / elapsedMs / emitPerfTrace / traceAsync) that depend on
// `node:perf_hooks` and therefore cannot live under `src/shared` (which must
// stay pure for renderer bundling).
import type {
  PerfTraceDetail,
  PerfTraceEvent,
  PerfTraceName,
  PerfTraceStatus,
} from '../../shared/perfTrace';

// Re-export so existing call sites importing types from this module keep
// working. `verbatimModuleSyntax` requires type-only re-exports to be marked.
export type { PerfTraceDetail, PerfTraceEvent, PerfTraceName, PerfTraceStatus };

function safeValue(value: string | number | boolean | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return String(Math.round(value * 1000) / 1000);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, '_')
    .slice(0, 160);
}

export function emitPerfTrace(event: PerfTraceEvent): void {
  const fields: Array<[string, string | number | boolean | null | undefined]> = [
    ['trace', event.trace],
    ['phase', event.phase],
    ['durationMs', event.durationMs],
    ['status', event.status],
    ['runtime', event.runtime],
    ['sessionId', event.sessionId],
    ['tabId', event.tabId],
    ['ownerId', event.ownerId],
    ['requestId', event.requestId],
    ['turnId', event.turnId],
    ['sizeBytes', event.sizeBytes],
    ['count', event.count],
  ];

  if (event.detail) {
    for (const [key, value] of Object.entries(event.detail)) {
      fields.push([`detail.${key}`, value]);
    }
  }

  const suffix = fields
    .map(([key, value]) => {
      const safe = safeValue(value);
      return safe === undefined ? undefined : `${key}=${safe}`;
    })
    .filter((part): part is string => !!part)
    .join(' ');

  console.log(`[perf] ${suffix}`);
}

export function nowMs(): number {
  return performance.now();
}

export function elapsedMs(startMs: number): number {
  return Math.round((performance.now() - startMs) * 1000) / 1000;
}

export async function traceAsync<T>(
  event: Omit<PerfTraceEvent, 'durationMs' | 'status'>,
  fn: () => Promise<T>,
): Promise<T> {
  const start = nowMs();
  try {
    const result = await fn();
    emitPerfTrace({ ...event, durationMs: elapsedMs(start), status: 'ok' });
    return result;
  } catch (error) {
    emitPerfTrace({ ...event, durationMs: elapsedMs(start), status: 'error' });
    throw error;
  }
}
