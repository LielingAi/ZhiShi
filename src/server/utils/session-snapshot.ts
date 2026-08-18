import type { AgentConfig } from '../../shared/types/agent';
import type { SessionMetadata } from '../types/session';

/**
 * Session config snapshot helpers (v0.1.69).
 *
 * Two independent helpers for two owner policies. **Do not** collapse them
 * into an enum-dispatched single function — the split is intentional
 * pit-of-success: each call site self-documents which snapshot policy it
 * wants, and a compile error is the only thing that can silently change
 * behavior when a new field is added.
 *
 * Callers feed the returned `Partial<SessionMetadata>` to
 * `createSessionMetadata(agentDir, snapshot)`. Hand-assembling snapshot
 * fields outside these helpers is forbidden (see PRD §6.2 Pit-of-success).
 */

/**
 * Payload set captured by the "owned session" snapshot policy. Single
 * source of truth for "what to copy from agent config into a session
 * being frozen". Referenced by `snapshotForOwnedSession()` below
 * (desktop/Cron creation path).
 *
 * `configSnapshotAt` is INTENTIONALLY EXCLUDED from this Pick — it's the
 * "this session is frozen" marker, stamped by the writer (sidecar
 * `/api/session/freeze` and Rust file-lock fallback) at write time, not
 * passed through the snapshot payload. Mixing it into the payload caused
 * TS↔Rust drift in the v0.2.14 first-cut review. (review-by-codex F2.)
 */
export type OwnedSessionSnapshot = Pick<
  SessionMetadata,
  | 'runtime'
  | 'model'
  | 'permissionMode'
  | 'mcpEnabledServers'
  | 'providerId'
  | 'providerEnvJson'
>;

/**
 * Desktop Tab / Cron owner — full-snapshot policy (D2, D3, D9).
 *
 * Desktop sessions own their config: once created, the session is self-contained
 * and is not affected by later changes to AgentConfig (D1). Cron `new_task`
 * tick creates a fresh snapshot each run (every tick reads current Agent);
 * Cron `current_session` freezes at first creation and reuses forever.
 *
 * Return shape = `OwnedSessionSnapshot` payload + the writer-stamped
 * `configSnapshotAt` marker. For the desktop-creation path, "writer" =
 * this function (we stamp `now` here). For the runtime-change freeze path,
 * the writers (`/api/session/freeze` endpoint and Rust file-lock fallback)
 * stamp `configSnapshotAt` themselves so the marker reflects when the
 * write actually committed — those callers should pass `OwnedSessionSnapshot`
 * by itself, not the return of this function.
 *
 * **Runtime-aware model/permission capture (issue #224).** `SessionMetadata.model`
 * is overloaded — for builtin runtime it holds the SDK / provider model
 * (`agent.model`), for external runtimes it holds the CLI's model id
 * (`agent.runtimeConfig.model`). The interactive write path in
 * `renderer/api/persistInputOption.ts::buildSnapshotPatch` already encodes
 * this dispatch. Snapshot creation must match: previously this helper
 * blindly captured `agent.model` even for external runtimes, leaking a
 * Claude/builtin model name into a Codex/Gemini session snapshot. The cron
 * `followAgent` resolution path then promoted that into
 * `runtimeConfig.model`, which Codex CLI rejects (issue #224).
 */
export function snapshotForOwnedSession(
  agent: AgentConfig,
): OwnedSessionSnapshot & Pick<SessionMetadata, 'configSnapshotAt'> {
  const runtime = agent.runtime ?? 'builtin';
  const isExternal = runtime !== 'builtin';
  return {
    runtime,
    model: isExternal ? agent.runtimeConfig?.model : agent.model,
    permissionMode: isExternal ? agent.runtimeConfig?.permissionMode : agent.permissionMode,
    mcpEnabledServers: agent.mcpEnabledServers ? [...agent.mcpEnabledServers] : undefined,
    providerId: agent.providerId,
    providerEnvJson: agent.providerEnvJson,
    configSnapshotAt: new Date().toISOString(),
  };
}
