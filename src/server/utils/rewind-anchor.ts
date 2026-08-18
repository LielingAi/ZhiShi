/**
 * PRD 0.2.27 — Rewind cross-reload durability ("window B" reconcile).
 * See specs/prd/prd_0.2.27_rewind_reload_durability.md.
 *
 * Problem: a rewind truncates our ZhiShi store immediately, but the SDK-side
 * truncation rides on an in-memory anchor (`pendingResumeSessionAt`) that is
 * consumed at the next pre-warm and never persisted. If the process dies after a
 * rewind but BEFORE a new turn materialized the truncated branch into the SDK
 * transcript (close tab / switch session / app restart), a cold reload does a bare
 * `resume` and Claude Code reconstructs the conversation from the newest-timestamp
 * non-sidechain leaf — which is still the *pre-rewind* tail. Result: the UI shows
 * the truncated history while the AI sees the full history.
 *
 * Fix: on a cold reload, derive a `resumeSessionAt` anchor from OUR store's tail so
 * the SDK is pinned to exactly what the UI shows. This is the pure decision core
 * (Functional Core / Imperative Shell): the shell in agent-session.ts feeds it the
 * loaded `messages` + the known-valid `currentSessionUuids` and folds the result
 * into `effectiveResumeAt`.
 */

/** Minimal shape this decision needs — keeps the core decoupled + unit-testable. */
export interface ReloadAnchorMessage {
  role: 'user' | 'assistant';
  /** SDK-assigned UUID (for resumeSessionAt). Absent on rows the SDK hasn't stamped. */
  sdkUuid?: string;
}

/**
 * Derive the cold-reload `resumeSessionAt` anchor, or `undefined` to leave the SDK
 * on a bare resume.
 *
 * Returns the tail message's `sdkUuid` IFF ALL hold:
 *  - the tail is an `assistant` (decision 3 — gate to tail-is-assistant). A tail
 *    `user` row is an UNANSWERED turn (a normal direct-send persists the user row
 *    before the SDK answer exists); anchoring to an earlier assistant would slice
 *    that pending turn out of the SDK history. Rewind always truncates to end on an
 *    assistant, so this gate covers window B without harming the normal case.
 *  - the tail has an `sdkUuid` (resumeSessionAt requires an SDKAssistantMessage.uuid).
 *  - that uuid is known-valid (`currentSessionUuids`) — decision 4, so we don't send
 *    a guaranteed-stale anchor and eat a doomed resume + restart.
 *
 * No-op by construction in the normal case: when the tail == the SDK's newest leaf,
 * slicing the reconstructed chain at the tail returns the whole chain.
 */
export function deriveReloadResumeAnchor(
  messages: readonly ReloadAnchorMessage[],
  currentSessionUuids: ReadonlySet<string>,
): string | undefined {
  if (messages.length === 0) return undefined;
  const tail = messages[messages.length - 1];
  if (tail.role !== 'assistant') return undefined;       // decision 3
  if (!tail.sdkUuid) return undefined;
  if (!currentSessionUuids.has(tail.sdkUuid)) return undefined;  // decision 4
  return tail.sdkUuid;
}

export interface EffectiveResumeAtInputs {
  forkMode: boolean;
  /** In-process rewind anchor (pendingResumeSessionAt). */
  rewindResumeAt?: string;
  /** Fork-point anchor (only meaningful in fork mode). */
  forkResumeAt?: string;
  /** Cold-reload anchor (deriveReloadResumeAnchor); must already be gated to undefined
   *  in fork mode / when a rewind anchor exists by the caller. */
  reloadAnchor?: string;
}

/**
 * Resolve the single `resumeSessionAt` value sent to the SDK, encoding the fixed
 * priority. Pure so the priority invariant is locked by a test — the fork-migration
 * PRD (prd_0.2.27_fork_standalone_migration.md) is explicitly warned not to regress
 * this fold when it removes `forkResumeAt`.
 *  - fork mode: an in-process rewind wins over the fork point; the cold-reload anchor
 *    is NEVER used (a fork carries its own truncation semantics).
 *  - normal: an in-process rewind wins over the cold-reload anchor (so existing rewind
 *    behavior is byte-for-byte unchanged; reloadAnchor is strictly the lowest priority).
 */
export function resolveEffectiveResumeAt(i: EffectiveResumeAtInputs): string | undefined {
  return i.forkMode
    ? (i.rewindResumeAt ?? i.forkResumeAt)
    : (i.rewindResumeAt ?? i.reloadAnchor);
}
