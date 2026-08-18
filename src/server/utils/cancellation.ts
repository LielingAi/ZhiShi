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
 *   const merged = anySignal([signalA, signalB]);
 *
 *   await cancellableDelay(500, signal);
 *
 *   const x = await withBoundedTimeout(somePromise, 5_000, () => console.warn('timed out'));
 *
 * Composes with `killWithEscalation` (subprocess kill) — these helpers handle
 * everything that isn't a child process: HTTP fetches, SSE streams, pending
 * promises, timers.
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
 * Compose multiple AbortSignals into a single signal that aborts when ANY of
 * the inputs aborts. `undefined` entries are ignored. If all inputs are
 * already aborted, returns a pre-aborted signal.
 *
 * Prefer `AbortSignal.any` when available (Node 24+); this wrapper accepts
 * `undefined` entries which the native API rejects.
 */
export function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  const real = signals.filter((s): s is AbortSignal => s !== undefined);
  if (real.length === 0) {
    // No parents → return a never-aborting signal.
    return new AbortController().signal;
  }
  if (real.length === 1) {
    return real[0];
  }
  // Use native AbortSignal.any when present (Node 20.3+).
  if (typeof (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any === 'function') {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(real);
  }
  // Fallback: hand-rolled fan-in.
  const ctrl = new AbortController();
  const onAbort = (): void => {
    if (ctrl.signal.aborted) return;
    try {
      ctrl.abort();
    } catch {
      /* ignore */
    }
    for (const s of real) {
      s.removeEventListener('abort', onAbort);
    }
  };
  for (const s of real) {
    if (s.aborted) {
      onAbort();
      break;
    }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return ctrl.signal;
}

/**
 * `setTimeout(ms)` that respects an `AbortSignal`. Resolves after `ms` if no
 * abort; rejects with `AbortError` (DOMException-shaped) if the signal aborts
 * before the timeout. Already-aborted signal rejects synchronously (next tick).
 */
export function cancellableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    let onAbort: (() => void) | undefined;
    if (signal) {
      onAbort = (): void => {
        clearTimeout(timer);
        reject(makeAbortError(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Bound a Promise's wait time. If `p` settles within `timeoutMs`, the resolved
 * value is returned. If it doesn't, `onTimeout()` is invoked exactly once and
 * the wrapper resolves to `undefined`. **Never rejects** — the underlying
 * promise's outcome (success or failure) after timeout is silently dropped
 * (caller is responsible for any needed side-effect logging in `onTimeout`).
 *
 * Useful when waiting on a resource that *should* release but might hang
 * forever (e.g. a stuck SDK subprocess after SIGTERM).
 */
export function withBoundedTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T | undefined> {
  let settled = false;
  // Fix #16: `p.then(success, failure)` already consumes p's outcome — both
  // arms exist, so a late rejection after timeout doesn't surface as
  // unhandledRejection. We attach an extra `.catch(() => {})` here as a
  // defense-in-depth so any future refactor (e.g. someone removing the
  // failure arm) doesn't silently regress the "never rejects" contract.
  void p.catch(() => undefined);
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onTimeout();
      } catch {
        /* swallow — never propagate */
      }
      resolve(undefined);
    }, timeoutMs);
    timer.unref?.();
    p.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Translate rejection to undefined per spec ("never rejects").
        resolve(undefined);
      },
    );
  });
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

function makeAbortError(signal?: AbortSignal): Error {
  // Prefer AbortSignal.reason when present (Node 18+).
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' ? reason : 'aborted');
  err.name = 'AbortError';
  return err;
}
