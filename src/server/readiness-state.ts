/**
 * Pattern 4 — Readiness state machine for the Sidecar's deferred init.
 *
 * 探针两分（1.5.4 起；live/functional 已随死路由清理删除）：
 *  - /health       — 进程存活（handler running，liveness 隐含）
 *  - /health/ready — deferred init（migrations / skill seed / ...）完成
 *
 * This module owns Readiness.
 *
 * Why a state machine and not just a Promise?
 *  - The bare Promise lets callers `await` for "ready" but tells you nothing
 *    while it's pending — no phase, no error reason.
 *  - On rejection the awaiter gets a thrown error, which the route gate
 *    historically rethrew as a 500. We need a structured 503.
 *  - Multiple endpoints (/health/ready) need to *peek* at the state without
 *    awaiting it.
 *
 * The existing `__zhishiDeferredInit` Promise stays alongside (other parts
 * of the codebase await it). This module is the new source of truth for
 * health endpoints and the route gate.
 */

export type DeferredInitState =
  | { kind: 'pending' }
  | { kind: 'phase'; phase: string }
  | { kind: 'ready' }
  | { kind: 'failed'; phase: string; error: string; retryable: boolean };

let state: DeferredInitState = { kind: 'pending' };

/** Read the current state (cheap; no awaits). */
export function getDeferredInitState(): DeferredInitState {
  return state;
}

/** Mark a new phase entered. Idempotent — same phase string is a no-op. */
export function setDeferredInitPhase(phase: string): void {
  if (state.kind === 'failed' || state.kind === 'ready') {
    // Don't overwrite a terminal state.
    return;
  }
  if (state.kind === 'phase' && state.phase === phase) return;
  state = { kind: 'phase', phase };
}

/** Mark deferred init complete. Idempotent. */
export function markDeferredInitReady(): void {
  if (state.kind === 'failed') {
    // Failed is sticky until a retry resets it.
    return;
  }
  state = { kind: 'ready' };
}

/**
 * Mark deferred init as failed. `phase` is whatever phase was running when
 * the throw happened (or 'unknown' if we couldn't capture it).
 */
export function markDeferredInitFailed(phase: string, error: unknown, retryable = false): void {
  const message = error instanceof Error ? error.message : String(error);
  state = { kind: 'failed', phase, error: message, retryable };
}

/**
 * Reset to pending — test helper and building block for the retry path.
 * The /health/ready/retry endpoint uses `tryBeginDeferredInitRetry`
 * instead, which couples this reset with the concurrency guard atomically.
 */
export function resetDeferredInitForRetry(): void {
  state = { kind: 'pending' };
}

/**
 * Retry coordinator (1.6.3 debt #5 — deferred init 不可重试).
 *
 * `POST /health/ready/retry` calls `tryBeginDeferredInitRetry`; on
 * `started: true` the caller MUST re-run deferred init (from `phase`
 * onward) and call `endDeferredInitRetry` in a `finally`.
 *
 * Concurrency: the check-and-set below is synchronous, so on Node's
 * single thread two concurrent POSTs can never both observe
 * `started: true`. While a retry is in flight the original init is
 * guaranteed finished — `failed` is only ever set in the init runner's
 * terminal catch — so a phase can never run twice in parallel.
 */
let retryInProgress = false;

export type DeferredInitRetryBegin =
  | { started: true; phase: string }
  | { started: false; reason: 'already-ready' | 'init-in-progress' | 'retry-in-progress' };

export function tryBeginDeferredInitRetry(): DeferredInitRetryBegin {
  if (retryInProgress) return { started: false, reason: 'retry-in-progress' };
  if (state.kind === 'ready') return { started: false, reason: 'already-ready' };
  if (state.kind !== 'failed') return { started: false, reason: 'init-in-progress' };
  retryInProgress = true;
  const phase = state.phase;
  state = { kind: 'pending' };
  return { started: true, phase };
}

export function endDeferredInitRetry(): void {
  retryInProgress = false;
}

/**
 * Build the JSON body for /health/ready.
 *  - 200 + { state: 'ready' } when ready
 *  - 503 + structured payload otherwise
 */
export function buildReadyResponseBody(): { status: number; body: Record<string, unknown> } {
  const s = state;
  switch (s.kind) {
    case 'ready':
      return { status: 200, body: { state: 'ready' } };
    case 'pending':
      return { status: 503, body: { state: 'pending', message: 'sidecar warming up' } };
    case 'phase':
      return {
        status: 503,
        body: { state: 'phase', phase: s.phase, message: 'sidecar warming up' },
      };
    case 'failed':
      return {
        status: 503,
        body: {
          state: 'failed',
          phase: s.phase,
          error: s.error,
          retryable: s.retryable,
        },
      };
  }
}

/**
 * Build the JSON body the route gate returns when a non-health route arrives
 * before deferred init has finished. Mirrors /health/ready except the message
 * mentions the route is gated.
 */
export function buildGateResponseBody(): { status: number; body: Record<string, unknown> } | null {
  const s = state;
  if (s.kind === 'ready') return null; // pass-through
  if (s.kind === 'pending') {
    return { status: 503, body: { state: 'pending', message: 'sidecar warming up' } };
  }
  if (s.kind === 'phase') {
    return {
      status: 503,
      body: { state: 'phase', phase: s.phase, message: 'sidecar warming up' },
    };
  }
  // failed
  return {
    status: 503,
    body: {
      state: 'failed',
      phase: s.phase,
      error: s.error,
      retryable: s.retryable,
    },
  };
}

/** Test-only reset. Not exported via the barrel. */
export function __resetReadinessForTests(): void {
  state = { kind: 'pending' };
  retryInProgress = false;
}
