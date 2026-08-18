/**
 * Sidecar root-path HTTP client (P1-T2).
 *
 * The CLI's existing `callApi` (zhishi.ts) only targets `/api/admin/*`; the
 * agent session endpoints (`/sessions`, `/chat/*`, `/api/permission/respond`)
 * live on the sidecar ROOT. This client covers that root surface:
 *
 *   postJson(path, body)  — POST JSON, returns the parsed envelope. Non-2xx
 *                           JSON envelopes are RETURNED (callers check
 *                           `success`), matching callApi semantics; non-JSON
 *                           error bodies throw SidecarHttpError.
 *   getJson(path)         — GET JSON (path carries its own query string).
 *   openSse(path, opts)   — async generator of parsed SSE frames with
 *                           automatic reconnect. The server replays
 *                           chat:init + cold-history + pending permission
 *                           requests on every (re)connect, so consumers must
 *                           treat replayed frames idempotently (the
 *                           agent-events reducer owns that policy).
 *
 * fetch is injectable (`fetchImpl`) so tests drive REST/SSE without a server.
 * Errors: transport failures (fetch failed / ECONNREFUSED / …) surface as
 * SidecarConnectionError naming the base URL; HTTP-level failures as
 * SidecarHttpError carrying the status code.
 */

import { SSEParser, type SSEEvent } from '../../server/utils/sse-parser';

// ---------------------------------------------------------------------------
// Minimal structural fetch types (DOM-lib free; Node 18+ global fetch satisfies
// them structurally).
// ---------------------------------------------------------------------------

export interface FetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface SseStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<unknown>;
}

export interface SseStreamBody {
  getReader(): SseStreamReader;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  body: SseStreamBody | null;
}

export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SidecarError extends Error {}

/** Transport-level failure — the sidecar is down or unreachable. */
export class SidecarConnectionError extends SidecarError {}

/** HTTP-level failure with a non-JSON (or SSE-refused) response. */
export class SidecarHttpError extends SidecarError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isTransportFailure(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return false;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('fetch failed') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNRESET')
  );
}

function normalizeTransportError(err: unknown, base: string): unknown {
  if (isTransportFailure(err)) {
    return new SidecarConnectionError(
      `Cannot connect to ZhiShi sidecar at ${base}. Is the app running? (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return err;
}

// ---------------------------------------------------------------------------
// Abort helpers
// ---------------------------------------------------------------------------

const ABORTED = Symbol('aborted');

/** Race a promise against an AbortSignal; resolves ABORTED when the signal fires. */
function raceWithAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface SidecarClientOptions {
  /** Root base URL, e.g. `http://127.0.0.1:${ZHISHI_PORT}` (no /api/admin). */
  base: string;
  fetchImpl?: FetchLike;
}

export interface OpenSseOptions {
  signal?: AbortSignal;
  /** Base retry delay in ms (default 1000); actual delay grows linearly, capped at 5s. */
  retryDelayMs?: number;
  /** Called before each reconnect attempt (1-based), after EOF or failure. */
  onReconnect?: (attempt: number, cause?: unknown) => void;
}

export class SidecarClient {
  readonly base: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: SidecarClientOptions) {
    this.base = opts.base.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  private url(path: string): string {
    return `${this.base}${path.startsWith('/') ? path : `/${path}`}`;
  }

  async getJson<T = Record<string, unknown>>(path: string): Promise<T> {
    let res: FetchResponseLike;
    try {
      res = await this.fetchImpl(this.url(path), { method: 'GET' });
    } catch (err) {
      throw normalizeTransportError(err, this.base);
    }
    return this.parseJsonResponse<T>(res);
  }

  async postJson<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
    let res: FetchResponseLike;
    try {
      res = await this.fetchImpl(this.url(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
    } catch (err) {
      throw normalizeTransportError(err, this.base);
    }
    return this.parseJsonResponse<T>(res);
  }

  /**
   * Admin API convenience (P1-T4): POST /api/admin/<route>. Same envelope
   * semantics as postJson — `{success:false}` is returned, not thrown.
   */
  async adminPost<T = Record<string, unknown>>(route: string, body: unknown = {}): Promise<T> {
    return this.postJson<T>(`/api/admin/${route.replace(/^\/+/, '')}`, body);
  }

  /**
   * D28 自动发现：POST /api/admin/environment/discover。返回宿主机已有的 docker
   * 容器（全量含已退出）与 VM（vmware/hyperv/vbox 全量）。只读，不写配置。
   */
  async discoverEnvironments(): Promise<{
    docker: Array<{ id: string; name: string; image: string; status: string; managed: boolean }>;
    vm: Array<{ driver: 'vmware' | 'hyperv' | 'vbox'; id: string; name: string; vmx?: string; state: string; osFamily?: 'linux' | 'windows' }>;
  }> {
    const res = await this.adminPost<{ success: boolean; data?: { docker?: unknown[]; vm?: unknown[] } }>(
      'environment/discover',
      {},
    );
    const data = res.data ?? {};
    return {
      docker: (data.docker ?? []) as Array<{ id: string; name: string; image: string; status: string; managed: boolean }>,
      vm: (data.vm ?? []) as Array<{ driver: 'vmware' | 'hyperv' | 'vbox'; id: string; name: string; vmx?: string; state: string; osFamily?: 'linux' | 'windows' }>,
    };
  }

  /**
   * Non-JSON error bodies (e.g. plain-text 4xx) would crash .json() — throw a
   * SidecarHttpError carrying status + text instead. Non-2xx JSON envelopes
   * are returned as-is: the `{success:false,error}` shape is meaningful to
   * callers (same contract as the admin API).
   */
  private async parseJsonResponse<T>(res: FetchResponseLike): Promise<T> {
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const text = (await res.text()).trim();
      throw new SidecarHttpError(res.status, text ? `HTTP ${res.status}: ${text}` : `HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Open an SSE stream as an async generator of parsed frames. Reconnects
   * automatically after EOF or failure until `signal` aborts; `onReconnect`
   * fires before each retry so the UI can note the gap. The server replays
   * chat:init + history + pending requests on every connect — consumers must
   * handle replays idempotently.
   */
  async *openSse(path: string, opts: OpenSseOptions = {}): AsyncGenerator<SSEEvent, void, void> {
    const { signal, retryDelayMs = 1000, onReconnect } = opts;
    let attempt = 0;
    while (!signal?.aborted) {
      let cause: unknown;
      try {
        const res = await this.fetchImpl(this.url(path), {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
          signal,
        });
        if (!res.ok) {
          throw new SidecarHttpError(res.status, `SSE ${path} refused: HTTP ${res.status} ${res.statusText}`);
        }
        if (!res.body) {
          throw new SidecarError(`SSE ${path}: response has no body`);
        }
        attempt = 0; // healthy connect resets the backoff ladder
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SSEParser();
        try {
          for (;;) {
            const chunk = await raceWithAbort(reader.read(), signal);
            if (chunk === ABORTED) return;
            if (chunk.done) break;
            for (const ev of parser.feed(decoder.decode(chunk.value, { stream: true }))) yield ev;
          }
          // Flush any trailing bytes held by the streaming decoder.
          for (const ev of parser.feed(decoder.decode())) yield ev;
        } finally {
          await reader.cancel().catch(() => {});
        }
        // Clean EOF: server closed the stream — treat like a failure and reconnect.
      } catch (err) {
        if (signal?.aborted) return;
        cause = err;
      }
      if (signal?.aborted) return;
      attempt++;
      onReconnect?.(attempt, cause);
      await sleepAbortable(Math.min(retryDelayMs * attempt, 5000), signal);
    }
  }
}
