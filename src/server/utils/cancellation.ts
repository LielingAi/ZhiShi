/**
 * Cancellation Protocol — Pattern 1 (v0.2.0 structural refactors).
 *
 * A small set of helpers that turn ad-hoc "abort & hope" code into a uniform
 * protocol with **bounded-time** cancel semantics and reason propagation.
 *
 * Usage shape:
 *
 *   const result = await withAbortSignal(parentSignal, (signal) => fetch(url, { signal }), {
 *     timeoutMs: 15_000,
 *     onAbort: (reason) => console.warn('[my-tool] aborted', reason),
 *   });
 *
 * 处理子进程以外的可取消资源：HTTP fetch、SSE 流、pending promise、定时器。
 *
 * Logging convention: callers should log the cancel reason via `console.warn`
 * with a `[Module]` prefix; Pattern 6's `withLogContext` will auto-inject
 * correlation IDs (sessionId/tabId/turnId/requestId) into the LogEntry.
 */

export type CancelReason = 'user' | 'timeout' | 'upstream' | 'shutdown' | 'error';

/**
 * Bounded-time cancellable resource. `cancel(reason)` MUST resolve within an
 * implementation-specific hard deadline; it MUST NOT reject. If the underlying
 * resource refuses to release, the implementation is expected to log + degrade
 * gracefully (e.g. mark as orphaned) rather than hang `cancel()`.
 */
export interface Cancellable {
  cancel(reason: CancelReason): Promise<void>;
}

/**
 * Run `op` with an AbortSignal that is the union of `signal` (caller's parent
 * abort) and a fresh timeout (`opts.timeoutMs`, optional). The signal passed
 * into `op` is also aborted if the parent or timeout fires.
 *
 * Cleans up its own timeout on settle. `onAbort` fires once at most, with the
 * reason inferred from which trigger fired:
 *   - parent signal already aborted   → 'user'      (best guess; caller can override by reading parent.reason)
 *   - parent signal aborts mid-flight → 'user'
 *   - timeout fires                   → 'timeout'
 *
 * If `op` throws synchronously or asynchronously, the error propagates as-is.
 */
export function withAbortSignal<T>(
  signal: AbortSignal | undefined,
  op: (signal: AbortSignal) => Promise<T>,
  opts?: { timeoutMs?: number; onAbort?: (reason: CancelReason) => void },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs;
  const ctrl = new AbortController();
  let aborted = false;
  let onParentAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const trigger = (reason: CancelReason): void => {
    if (aborted) return;
    aborted = true;
    try {
      ctrl.abort();
    } catch {
      /* AbortController.abort never throws in modern Node, defensive only */
    }
    try {
      opts?.onAbort?.(reason);
    } catch {
      /* user callback swallowed — never propagate from cleanup */
    }
  };

  const cleanup = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (signal && onParentAbort) {
      try {
        signal.removeEventListener('abort', onParentAbort);
      } catch {
        /* ignore */
      }
      onParentAbort = undefined;
    }
  };

  if (signal) {
    if (signal.aborted) {
      trigger('user');
    } else {
      onParentAbort = (): void => trigger('user');
      signal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => trigger('timeout'), timeoutMs);
    timer.unref?.();
  }

  // Wrap synchronously-throwing op() in Promise.resolve().then(...) so a
  // synchronous throw in `op` still flows through `.finally(cleanup)`. The
  // pre-fix `op(ctrl.signal).finally(cleanup)` only registered cleanup once
  // op() returned a Promise — a synchronous throw bypassed it and leaked the
  // parent-abort listener + timer.
  return Promise.resolve()
    .then(() => op(ctrl.signal))
    .finally(cleanup);
}

/**
 * Convenience wrapper for the common shape: fetch() with bounded time and
 * optional parent signal. Returns the Response (caller still owns the body).
 *
 * - `parentSignal`: external cancellation source (SDK turn signal, request
 *   signal, …). May be undefined.
 * - `timeoutMs`: hard cap on the request lifetime (default 30s).
 *
 * On timeout / parent abort the underlying fetch is aborted; the caller sees
 * an `AbortError` from `fetch`.
 */
export async function cancellableFetch(
  url: string,
  init?: RequestInit,
  opts?: { parentSignal?: AbortSignal; timeoutMs?: number },
): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  return withAbortSignal(
    opts?.parentSignal,
    (signal) => fetch(url, { ...(init ?? {}), signal }),
    { timeoutMs },
  );
}
