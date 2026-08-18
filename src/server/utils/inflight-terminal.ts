/**
 * Issue #289 — what to do with the in-flight mid-turn queued item when the SDK's
 * `result` (turn-end) arrives during/after an interrupt.
 *
 * Background: a message sent mid-turn is yielded to the SDK ("in-flight to CLI") — it
 * has crossed the uncancellable boundary (it is in the SDK's commandQueue). At a graceful
 * interrupt the SDK fires a `result` (terminal_reason='aborted_streaming') that routes
 * through handleMessageComplete, and post-abort the SDK's drainCommandQueue processes that
 * queued command. So whether the item should be SURFACED (shown as a user bubble — it is
 * being processed) or DROPPED from the UI (queue:cancelled) depends on the INTENT of the
 * interrupt, which the global `isInterruptingResponse` flag alone cannot express:
 *
 *  - Plain STOP: the user wants to stop; treat the in-flight item as "AI may not have
 *    seen it" and drop it from the UI (matches the long-standing stop behavior).
 *  - FORCE ("立即发送"): the user explicitly asked for THIS item to run now. force
 *    interrupts the current turn precisely so the SDK drains + processes the queued
 *    command — so it MUST be surfaced as a user bubble (the AI's reply renders under it).
 *    Dropping it is the #289 bug: "message vanishes from UI but the AI processed it".
 *  - Natural completion (not interrupting): the turn-end fallback surfaces it as well.
 *
 * Pure decision core (Functional Core / Imperative Shell): the shell passes the live
 * flags; the caller performs the broadcast. This is ONLY for the result/complete handler
 * (the item is processed there). The stop/error handlers fire when the item was lost with
 * a force-closed subprocess (rescuePendingToQueue does NOT rescue the in-flight item), so
 * those always drop and do not use this.
 */
export type InFlightTerminalAction = 'drop' | 'surface' | 'noop';

export function decideInFlightActionOnResult(opts: {
  /** An interrupt (stop or force) is in progress for this terminal result. */
  isInterrupting: boolean;
  /** This interrupt was a force-execute targeting THIS in-flight item (#289). */
  forced: boolean;
  /** inFlightMetadata is available to build the user bubble. */
  hasMeta: boolean;
}): InFlightTerminalAction {
  // Plain stop (interrupt, not a force): drop — AI may not have seen the item.
  if (opts.isInterrupting && !opts.forced) return 'drop';
  // Force-send OR natural completion: the item is/was being processed by the SDK's
  // drainCommandQueue → surface it as a user bubble (if we can build it).
  return opts.hasMeta ? 'surface' : 'noop';
}
