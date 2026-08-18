/**
 * turn-hooks.ts — leaf hook slot decoupling the runtime paths from post-turn
 * side-effects (#296).
 *
 * Why this exists: `agent-session.ts` needs to trigger
 * auto session titling after a successful turn, but the Title Service reaches
 * `title-generator.ts`, which imports CLI/env/bridge helpers back from
 * `agent-session.ts`. A direct (even dynamic) import from the runtime files to
 * the service would therefore form an import cycle
 * (agent-session → service → title-generator → agent-session) that
 * dependency-cruiser rejects — bare `import('./x')` edges are still counted.
 *
 * Dependency inversion breaks it cleanly: the runtime files depend only on this
 * leaf (they call `firePostTurnTitleHook`); the service registers the
 * implementation at boot via `setPostTurnTitleHook`. This module imports nothing
 * at runtime (the type imports are erased — dep-cruiser runs with
 * tsPreCompilationDeps:false), so it sits outside every cycle.
 *
 * Keep it titling-specific and tiny: a single function slot, not a generic event
 * bus. Add a sibling slot if a second post-turn side-effect ever needs the same
 * decoupling.
 */

import type { ProviderEnv } from './agent-session';

export type PostTurnTitleHook = (
  sessionId: string,
  model: string | undefined,
  providerEnv?: ProviderEnv,
) => void;

let titleHook: PostTurnTitleHook | null = null;

/** Install the auto-title implementation. Called once at sidecar boot by the
 *  Title Service; later calls replace the slot (last writer wins). */
export function setPostTurnTitleHook(hook: PostTurnTitleHook): void {
  titleHook = hook;
}

/**
 * Fire the post-turn title hook from a runtime path. No-op until the service has
 * installed its implementation. Never throws — a titling failure must never
 * affect the turn that triggered it (red-line: title-gen is best-effort).
 */
export function firePostTurnTitleHook(
  sessionId: string,
  model: string | undefined,
  providerEnv?: ProviderEnv,
): void {
  if (!titleHook) return;
  try {
    titleHook(sessionId, model, providerEnv);
  } catch {
    /* best-effort: swallow so the turn is never affected */
  }
}
