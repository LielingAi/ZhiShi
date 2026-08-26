/**
 * GUI SSE/HTTP 客户端（1.3.0 GUI MVP）。
 *
 * 复用 TUI client.ts 的契约与模式（服务端零改动），但为 GUI 独立实现：
 *   - fetch 可注入（fetchImpl），单测友好；
 *   - openSse 自动重连（线性退避，上限 5s），服务端每次连接都 replay
 *     chat:init + 全量历史 + 队列快照——归约层按 wire id 幂等（reducer.ts）。
 *   - 复用 src/shared/sse-parser（纯模块，无进程依赖）。
 *
 * 事件 payload 是 JSON 文本（sse.ts::formatSse 用 JSON.stringify 序列化），
 * 解析失败（理论不会发生）时按裸字符串兜底。
 */

import { SSEParser, type SSEEvent } from '../../../shared/sse-parser';

// ---------------------------------------------------------------------------
// 最小结构化 fetch 类型（DOM-lib 无关，Node 18+ 全局 fetch 结构满足）
// ---------------------------------------------------------------------------

export interface GuiFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface GuiStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<unknown>;
}

export interface GuiFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  body: { getReader(): GuiStreamReader } | null;
}

export type GuiFetch = (url: string, init?: GuiFetchInit) => Promise<GuiFetchResponse>;

export class GuiClientError extends Error {}

/** HTTP 层错误（非 2xx 且非 JSON envelope）。 */
export class GuiHttpError extends GuiClientError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 传输层错误（sidecar 未就绪 / 拒绝连接）。 */
export class GuiConnectionError extends GuiClientError {}

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

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export interface GuiSidecarClientOptions {
  /** 根 base URL，如 `http://127.0.0.1:${port}`（不含 /api/admin）。 */
  base: string;
  fetchImpl?: GuiFetch;
}

export interface OpenSseOptions {
  signal?: AbortSignal;
  retryDelayMs?: number;
  onReconnect?: (attempt: number, cause?: unknown) => void;
}

export class GuiSidecarClient {
  readonly base: string;
  private readonly fetchImpl: GuiFetch;

  constructor(opts: GuiSidecarClientOptions) {
    this.base = opts.base.replace(/\/+$/, '');
    // 1.3.0 实机修正：裸 fetch 存成方法再调用会丢 this 绑定——浏览器里
    // 直接抛 TypeError: Illegal invocation（Node 不受影响，单测全绿没暴露）。
    // 必须显式绑定（globalThis = window/Node 两用）。
    this.fetchImpl = opts.fetchImpl ?? (fetch.bind(globalThis) as unknown as GuiFetch);
  }

  private url(path: string): string {
    return `${this.base}${path.startsWith('/') ? path : `/${path}`}`;
  }

  async getJson<T = Record<string, unknown>>(path: string): Promise<T> {
    let res: GuiFetchResponse;
    try {
      res = await this.fetchImpl(this.url(path), { method: 'GET' });
    } catch (err) {
      throw this.normalizeTransport(err);
    }
    return this.parseJson<T>(res);
  }

  async postJson<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
    let res: GuiFetchResponse;
    try {
      res = await this.fetchImpl(this.url(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
    } catch (err) {
      throw this.normalizeTransport(err);
    }
    return this.parseJson<T>(res);
  }

  /** 1.3.3 会话管理：PATCH（title/favorite/pinned/archived 部分更新）。 */
  async patchJson<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
    let res: GuiFetchResponse;
    try {
      res = await this.fetchImpl(this.url(path), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
    } catch (err) {
      throw this.normalizeTransport(err);
    }
    return this.parseJson<T>(res);
  }

  /** 1.3.3 会话管理：DELETE（删除会话 + transcript）。 */
  async deleteJson<T = Record<string, unknown>>(path: string): Promise<T> {
    let res: GuiFetchResponse;
    try {
      res = await this.fetchImpl(this.url(path), { method: 'DELETE' });
    } catch (err) {
      throw this.normalizeTransport(err);
    }
    return this.parseJson<T>(res);
  }

  /** Admin API 便捷方法：POST /api/admin/<route>，`{success:false}` 返回而非抛错。 */
  async adminPost<T = Record<string, unknown>>(route: string, body: unknown = {}): Promise<T> {
    return this.postJson<T>(`/api/admin/${route.replace(/^\/+/, '')}`, body);
  }

  private normalizeTransport(err: unknown): GuiClientError {
    if (isTransportFailure(err)) {
      return new GuiConnectionError(
        `无法连接 ZhiShi sidecar（${this.base}）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return err instanceof GuiClientError ? err : new GuiClientError(String(err));
  }

  private async parseJson<T>(res: GuiFetchResponse): Promise<T> {
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const text = (await res.text()).trim();
      throw new GuiHttpError(
        res.status,
        text ? `HTTP ${res.status}: ${text}` : `HTTP ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as T;
  }

  /**
   * 打开 SSE 流（async generator，自动重连）。事件 payload 已 JSON.parse；
   * 解析失败回退为原始字符串。`signal` abort 时干净退出。
   */
  async *openSse(path: string, opts: OpenSseOptions = {}): AsyncGenerator<SseInput, void, void> {
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
          throw new GuiHttpError(res.status, `SSE ${path} refused: HTTP ${res.status} ${res.statusText}`);
        }
        if (!res.body) throw new GuiClientError(`SSE ${path}: response has no body`);
        attempt = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SSEParser();
        try {
          for (;;) {
            const chunk = await raceAbort(reader.read(), signal);
            if (chunk === ABORTED) return;
            if (chunk.done) break;
            for (const ev of parser.feed(decoder.decode(chunk.value, { stream: true }))) {
              yield toInput(ev);
            }
          }
          for (const ev of parser.feed(decoder.decode())) yield toInput(ev);
        } finally {
          await reader.cancel().catch(() => {});
        }
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

// ---------------------------------------------------------------------------
// 纯 helper（可单测）
// ---------------------------------------------------------------------------

export interface SseInput {
  event: string;
  payload: unknown;
}

/** SSEEvent → {event, payload}：data 是 JSON 文本（裸字符串兜底）。 */
export function toInput(ev: SSEEvent): SseInput {
  const raw = ev.data;
  try {
    return { event: ev.event ?? '', payload: JSON.parse(raw) as unknown };
  } catch {
    return { event: ev.event ?? '', payload: raw };
  }
}

const ABORTED = Symbol('aborted');

function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
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
