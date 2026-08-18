/**
 * Logger context — Pattern 6 (Observability — Correlation IDs).
 *
 * `AsyncLocalStorage` carries correlation fields across `await` boundaries
 * inside a single Node task. Wrap any async unit-of-work with
 * `withLogContext({ ... }, fn)` and every `console.*` call inside (including
 * deeply nested awaits) automatically gets those fields injected by
 * `logger.ts::createAndBroadcast` when it builds the `LogEntry`.
 *
 * The whole point of this module: existing call sites such as
 *   console.warn('[claude-code] timeout')
 * stay byte-for-byte unchanged. The CAPTURE path (in `logger.ts`) is the
 * only thing that reads the store. There is no `sendLog(level, message,
 * meta)` migration — that would violate the "console.* is the unified
 * entry" rule documented in `specs/tech_docs/unified_logging.md` §最佳实践 #1.
 *
 * Three generation points wrap context (see PRD §6.2.1 item 2):
 *   - HTTP request handler in `index.ts`            → requestId/sessionId/tabId
 *   - SDK turn boundary in `agent-session.ts`       → turnId
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
    sessionId?: string;
    tabId?: string;
    ownerId?: string;
    requestId?: string;
    turnId?: string;
    /** Runtime label e.g. 'claude-code' | 'codex' | 'gemini' | 'builtin'. */
    runtime?: string;
}

/**
 * Module-singleton ALS. `getStore()` returns `undefined` outside any
 * `withLogContext(...)` wrapper, in which case logs are emitted without
 * correlation fields (current behaviour).
 */
export const logContextStorage = new AsyncLocalStorage<LogContext>();

/**
 * Run `fn` inside an ALS frame populated with `ctx`. If a parent frame
 * already exists, fields from `ctx` shallow-merge on top (so nested
 * `withLogContext({ turnId })` inside `withLogContext({ sessionId })`
 * yields a frame containing both). `undefined` values in `ctx` do NOT
 * clobber parent fields.
 *
 * Callers may pass either sync or async `fn` — TypeScript infers the
 * return type. The store is automatically torn down when the awaited
 * promise settles or the sync function returns.
 */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
    const parent = logContextStorage.getStore();
    const merged: LogContext = parent ? { ...parent } : {};
    for (const k of Object.keys(ctx) as (keyof LogContext)[]) {
        const v = ctx[k];
        if (v !== undefined) {
            // TS: index signature wants string | undefined per key, but every
            // key is `string | undefined` in our schema → cast through unknown.
            (merged as Record<string, string | undefined>)[k as string] = v;
        }
    }
    return logContextStorage.run(merged, fn);
}

/**
 * Per-owner ambient context map — Pattern 6 SDK-turn fallback (FIXED).
 *
 * The persistent SDK session in `agent-session.ts` runs a `while(true)`
 * `messageGenerator` that yields user messages back into SDK-internal
 * code paths. ALS frames don't survive that yield/resume cycle cleanly
 * (the SDK callback that emits `chat:log` etc. runs outside our wrapping
 * function), so we stamp `turnId` as ambient for the duration of a turn
 * and clear it when the turn ends.
 *
 * **Cross-owner contamination fix (review-by-cc + review-by-codex):**
 * The previous module-level singleton was shared by every Owner (Tab/IM/
 * Cron) inside a single sidecar. Two concurrent turns on different
 * sessions would clobber each other's ambient `turnId`, causing logs to
 * be tagged with the wrong correlation IDs. We now key the ambient slice
 * by `sessionId` (or owner-constructed key) — the ALS frame that wraps
 * each turn knows its own session, looks up the right slice.
 *
 * Use ALS (`withLogContext`) for short-lived frames where call-stack
 * propagation works; use ambient ONLY for long-lived turn-scoped state
 * that crosses generator boundaries.
 */
const ambientByKey = new Map<string, LogContext>();

/** Sentinel for legacy callers that don't supply an owner key. */
const LEGACY_SINGLETON_KEY = '__legacy_singleton__';
let legacyWarnEmitted = false;

function resolveOwnerKey(ctx: LogContext | undefined, explicitKey?: string): string {
    if (explicitKey && explicitKey.length > 0) return explicitKey;
    if (ctx?.sessionId) return ctx.sessionId;
    if (ctx?.ownerId) return ctx.ownerId;
    if (!legacyWarnEmitted) {
        legacyWarnEmitted = true;
        // Surface the gap once per process — caller didn't supply a key, so
        // we fall through to the global singleton slot. Cross-owner
        // contamination may still bite that path; this warning makes it
        // discoverable in unified logs without breaking existing sites.
        console.warn('[logger-context] setAmbientLogContext called without sessionId/ownerId — falling back to global slot. This may cause cross-owner log tagging.');
    }
    return LEGACY_SINGLETON_KEY;
}

/**
 * Read the current correlation context (or `undefined` outside any
 * `withLogContext` frame). Used by `logger.ts::createAndBroadcast`.
 *
 * If no ALS frame is active, falls back to the per-owner ambient context
 * keyed by `sessionId`/`ownerId`. Ambient is needed for the SDK turn
 * boundary — the persistent `messageGenerator` yields back into SDK code
 * that runs outside our ALS frames, so logs emitted from the SDK callback
 * path would lose `turnId` without an ambient fallback.
 *
 * Field-level merge: ALS wins per-field, but any field NOT set in ALS
 * picks up its value from the ambient slice belonging to the ALS frame's
 * owner key. This lets us stamp `turnId` ambiently for the duration of a
 * turn while still letting an HTTP request frame supply
 * `requestId/sessionId/tabId` independently. Two concurrent turns on
 * different sessions never see each other's ambient slots.
 */
export function getLogContext(): LogContext | undefined {
    const als = logContextStorage.getStore();

    // Resolve which ambient slot (if any) to mix in:
    //  - Prefer the ALS frame's sessionId/ownerId — that's the turn's owner.
    //  - Fall back to legacy singleton only when no ALS context at all.
    let ambient: LogContext | undefined;
    if (als) {
        if (als.sessionId) ambient = ambientByKey.get(als.sessionId);
        if (!ambient && als.ownerId) ambient = ambientByKey.get(als.ownerId);
    }
    if (!ambient && ambientByKey.size > 0) {
        ambient = ambientByKey.get(LEGACY_SINGLETON_KEY);
    }

    if (!als && !ambient) return undefined;
    if (!ambient) return als;
    if (!als) return ambient;
    // Both present — ALS overrides per field that's set there.
    return {
        sessionId: als.sessionId ?? ambient.sessionId,
        tabId: als.tabId ?? ambient.tabId,
        ownerId: als.ownerId ?? ambient.ownerId,
        requestId: als.requestId ?? ambient.requestId,
        turnId: als.turnId ?? ambient.turnId,
        runtime: als.runtime ?? ambient.runtime,
    };
}

/**
 * Set or clear the ambient correlation slot for a given owner.
 *
 * Two call shapes (back-compat preserved):
 *   - `setAmbientLogContext(ctx)`             — legacy (uses legacy singleton key
 *                                                + emits a one-shot warn)
 *   - `setAmbientLogContext(key, ctx)`        — preferred; `key` is sessionId/ownerId
 *
 * Pass `ctx === undefined` to clear the slot for that key entirely.
 */
export function setAmbientLogContext(
    keyOrCtx: string | LogContext | undefined,
    maybeCtx?: LogContext | undefined,
): void {
    let key: string;
    let ctx: LogContext | undefined;

    if (typeof keyOrCtx === 'string') {
        key = keyOrCtx;
        ctx = maybeCtx;
    } else {
        // Legacy 1-arg form: derive a key from the ctx's sessionId/ownerId.
        ctx = keyOrCtx;
        key = resolveOwnerKey(ctx);
    }

    if (!ctx) {
        ambientByKey.delete(key);
        return;
    }

    // Merge into existing ambient slot — undefined fields don't clobber.
    const existing = ambientByKey.get(key);
    const merged: LogContext = existing ? { ...existing } : {};
    for (const k of Object.keys(ctx) as (keyof LogContext)[]) {
        const v = ctx[k];
        if (v !== undefined) {
            (merged as Record<string, string | undefined>)[k as string] = v;
        }
    }
    ambientByKey.set(key, merged);
}

/**
 * Clear a single field from a given owner's ambient slot. If the slot
 * becomes empty after removal, the slot itself is dropped.
 *
 * Two call shapes:
 *   - `clearAmbientLogContextField(field)`        — legacy singleton key
 *   - `clearAmbientLogContextField(key, field)`   — preferred per-owner form
 */
export function clearAmbientLogContextField(
    keyOrField: string,
    maybeField?: keyof LogContext,
): void {
    let key: string;
    let field: keyof LogContext;

    if (maybeField !== undefined) {
        key = keyOrField;
        field = maybeField;
    } else {
        key = LEGACY_SINGLETON_KEY;
        field = keyOrField as keyof LogContext;
    }

    const slot = ambientByKey.get(key);
    if (!slot) return;
    delete slot[field];
    if (Object.keys(slot).length === 0) {
        ambientByKey.delete(key);
    } else {
        ambientByKey.set(key, slot);
    }
}

/**
 * Test-only: drop all ambient slots. Not exported via index.ts; tests can
 * still import it directly to isolate cross-test bleed.
 */
export function __resetAmbientForTests(): void {
    ambientByKey.clear();
    legacyWarnEmitted = false;
}
