/**
 * Pattern 1 follow-up — Turn-scoped AbortController registry.
 *
 * Every user turn (one inbound user message → SDK generation → tool calls →
 * final assistant message) gets a fresh `AbortController`. Tool fetches and
 * other in-flight async work derive their `AbortSignal` from this controller
 * via `getCurrentTurnSignal()`. When the renderer presses stop, `abortTurn(
 * sessionId, reason)` aborts the controller — every fetch / stream / awaiter
 * that derived from it observes the abort within ~one event-loop tick,
 * regardless of its own per-call timeout.
 *
 * Why a module-level registry rather than `AsyncLocalStorage`:
 *   - The persistent SDK session is a long-running async generator. Tool
 *     callbacks are invoked by MCP transport plumbing from outside the
 *     `for await` frame, so an ALS frame established at turn-start would not
 *     reliably propagate into tool handlers.
 *   - `AbortController` already has well-defined fan-out semantics. A module
 *     registry keyed by `sessionId` gives every tool fetch the same primitive.
 *   - Sidecar is single-threaded and one Sidecar serves a small fixed number
 *     of sessions (Tab / IM / Cron / Background). A flat Map is sufficient.
 *
 * Why not the SDK `Options.abortController`:
 *   - That controller is *session*-scoped: aborting it terminates the entire
 *     persistent SDK subprocess. Per-turn interrupt must NOT do that — the
 *     subprocess stays alive for the next user message. We keep the SDK's
 *     cooperative `query.interrupt()` for that, and use this module's
 *     controller purely to cancel resources owned by *our* Node process
 *     (fetches, streams, timers).
 *
 * Lifecycle summary:
 *   beginTurn(sid)     → registers a fresh controller; returns its signal.
 *   getCurrentTurnSignal() → returns the most recently begun, not-yet-ended
 *                        signal. Used by tool fetches to derive parent signal.
 *   endTurn(sid)       → drops the registration WITHOUT aborting (success path).
 *                        Calling on success would force the next turn to
 *                        re-create from scratch but never observe an abort, so
 *                        we just clear the slot.
 *   abortTurn(sid, r)  → aborts the controller with `Error('turn interrupted: <r>')`
 *                        and drops the registration.
 *
 * Reason mapping (callers):
 *   - Renderer stop button       → 'user'
 *   - Unhandled error path       → 'error'
 *   - Watchdog / startup timeout → 'timeout' (optional; abortPersistentSession
 *                                  is a hard kill, the turn signal abort is
 *                                  best-effort cancellation of in-flight tools)
 */

import type { CancelReason } from './cancellation';

interface TurnAbortState {
  controller: AbortController;
  startedAt: number;
}

/**
 * Active turn registry. Keyed by sessionId. Per Sidecar process there is at
 * most one entry per session at any time. The most-recently-`begin`'d entry
 * is also exposed via `currentTurnStack` so single-session callers (tools)
 * can read the signal without knowing the sessionId.
 */
const turnAbortBySession = new Map<string, TurnAbortState>();

/**
 * Stack of session ids in begin-order. The top of the stack is the
 * "current" turn for `getCurrentTurnSignal()`. We use a stack rather than a
 * single slot because IM/Cron sessions on the same Sidecar can theoretically
 * begin a turn while a Tab turn is still active in some race configurations;
 * the stack lets `getCurrentTurnSignal()` always return the most recently
 * begun, not-yet-ended turn.
 */
const currentTurnStack: string[] = [];

/**
 * Begin a turn for `sessionId`. Returns the fresh AbortSignal.
 *
 * If a turn was already registered for this sessionId (shouldn't happen in
 * normal flow but can during error recovery), the previous controller is
 * abandoned (NOT aborted — abandoning is the safe default; the old turn's
 * fetches may still be wrapping up in the background and aborting them now
 * could double-fire `chat:message-stopped`). The previous entry is overwritten.
 */
export function beginTurn(sessionId: string): { signal: AbortSignal } {
  if (!sessionId) {
    // Defensive: callers should always pass a non-empty session id, but during
    // very early startup `sessionId` may still be empty. Fall back to a
    // never-aborting controller; tools simply won't see a turn signal.
    const ctrl = new AbortController();
    return { signal: ctrl.signal };
  }
  // If a stale entry exists, drop it from the stack first so the new top is
  // unambiguous. Don't abort it — the previous turn likely already ended via
  // endTurn/abortTurn; if it didn't, leaving its controller live until GC is
  // safer than a surprise abort.
  if (turnAbortBySession.has(sessionId)) {
    const idx = currentTurnStack.lastIndexOf(sessionId);
    if (idx >= 0) currentTurnStack.splice(idx, 1);
  }
  const controller = new AbortController();
  turnAbortBySession.set(sessionId, { controller, startedAt: Date.now() });
  currentTurnStack.push(sessionId);
  return { signal: controller.signal };
}

/**
 * End a turn for `sessionId` without aborting (normal success / stop path).
 * Idempotent — calling on a session with no registration is a no-op.
 */
export function endTurn(sessionId: string): void {
  if (!sessionId) return;
  turnAbortBySession.delete(sessionId);
  const idx = currentTurnStack.lastIndexOf(sessionId);
  if (idx >= 0) currentTurnStack.splice(idx, 1);
}

/**
 * Abort the turn for `sessionId` with the given reason. Idempotent — calling
 * on a session with no registration is a no-op. After abort, the registration
 * is dropped (subsequent calls to `getCurrentTurnSignal()` won't see it).
 *
 * The abort reason is wrapped in an `Error` so AbortSignal.reason exposes a
 * stable shape (`reason instanceof Error && reason.message includes(<reason>)`).
 */
export function abortTurn(sessionId: string, reason: CancelReason): void {
  if (!sessionId) return;
  const state = turnAbortBySession.get(sessionId);
  if (!state) return;
  try {
    state.controller.abort(new Error(`turn interrupted: ${reason}`));
  } catch {
    /* AbortController.abort never throws in modern Node; defensive only */
  }
  turnAbortBySession.delete(sessionId);
  const idx = currentTurnStack.lastIndexOf(sessionId);
  if (idx >= 0) currentTurnStack.splice(idx, 1);
}

/**
 * Return the AbortSignal for the active turn.
 *
 * Pattern A Wave 4 fragility guard: under the documented Sidecar:Session = 1:1
 * invariant the stack holds at most one entry, so the "most recently begun"
 * choice is unambiguous. If a future change ever multiplexes sessions inside
 * one Sidecar (sub-agent tool execution, parallel turns, …), the stack would
 * grow beyond one and tool fetches could silently route to the *wrong*
 * AbortController. The optional `sessionId` parameter lets a caller that
 * does know its own session ask explicitly; the invariant warning below
 * surfaces an unexpected multi-session state in logs so the regression is
 * loud rather than silent.
 *
 * Returns `undefined` when no turn is active (or the requested session has
 * no live turn).
 */
export function getCurrentTurnSignal(sessionId?: string): AbortSignal | undefined {
  if (sessionId) {
    const state = turnAbortBySession.get(sessionId);
    return state?.controller.signal;
  }
  if (currentTurnStack.length > 1) {
    // Stack overflow vs. design invariant — log once per process spike. In
    // practice this fires only if someone added a new owner type that calls
    // beginTurn() without endTurn() before another beginTurn(). The "most
    // recently begun" fallback below is the legacy behavior; the invariant
    // warning is what flags the regression.
    if (!multiSessionWarned) {
      multiSessionWarned = true;
      console.warn(
        `[turn-abort] currentTurnStack length=${currentTurnStack.length} ` +
          `(expected ≤1 under Sidecar:Session = 1:1). Active sessions: ${currentTurnStack.join(',')}. ` +
          `Tool fetches may attach to the wrong AbortController — pass sessionId to ` +
          `getCurrentTurnSignal() or fix the missing endTurn() at the source.`,
      );
    }
  }
  for (let i = currentTurnStack.length - 1; i >= 0; i--) {
    const sid = currentTurnStack[i];
    const state = turnAbortBySession.get(sid);
    if (state) return state.controller.signal;
  }
  return undefined;
}
let multiSessionWarned = false;

/**
 * Test-only: clear all registrations. Useful between unit tests to avoid
 * cross-test leakage.
 */
export function __resetTurnAbortRegistryForTests(): void {
  turnAbortBySession.clear();
  currentTurnStack.length = 0;
  multiSessionWarned = false;
}
