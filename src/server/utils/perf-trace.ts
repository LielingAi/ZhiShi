import { performance } from 'node:perf_hooks';

// PRD 0.2.32 §6.6 — PerfTrace 词汇表。1.5.4 起内联在本文件：renderer 已删,
// 共享壳（原 src/shared/perfTrace.ts）失去存在意义（depcruise 不算 type-only
// 边,纯类型文件被误判孤儿）。Rust 在 src-tauri/src/perf_trace.rs 镜像同一
// 字段词汇——新增 PerfTraceName 或字段时两处同步,保证统一日志 [perf] 行
// 跨层一致。

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
