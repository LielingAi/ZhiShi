/**
 * SSE instance identity — extracted into its own leaf module to break a
 * dependency-cruiser-flagged cycle between `sse.ts` and `logger.ts`.
 *
 * The cycle:
 *   - logger.ts statically imports SSE_INSTANCE_ID from sse.ts (used to
 *     tag every log entry so the renderer can detect Sidecar restarts —
 *     a new id ⇒ a new Sidecar instance ⇒ replay needed).
 *   - sse.ts dynamically imports './logger' inside `connect()` (to drain
 *     the early-log ring buffer to newly connected clients).
 *
 * The dynamic import was an intentional cycle-breaker at module-load time
 * — it doesn't run until the first SSE connect — but dep-cruiser flags
 * the static-graph cycle anyway. Moving the constant to this leaf file
 * removes the static edge logger → sse, leaving only the (deferred)
 * dynamic edge sse → logger, which is no longer a cycle.
 *
 * One module-load cost: a single Math.random() call. Constant lives for
 * the Sidecar process lifetime.
 */
export const SSE_INSTANCE_ID = Math.random().toString(16).slice(2);
