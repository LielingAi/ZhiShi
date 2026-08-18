import type { AgentConfig } from '../../shared/types/agent';
import type { SessionMetadata } from '../types/session';
import type { RuntimeType } from '../../shared/types/runtime';
import { modelLooksLikeRuntime } from '../migrations/scrub-stale-runtime-config';

/**
 * Effective runtime config for a single query (v0.1.69).
 *
 * Only the fields we actually snapshot. `systemPrompt` / tool registry /
 * provider definitions are deliberately NOT here — those stay live (shared
 * by all sessions, upgraded together).
 */
export interface ResolvedSessionConfig {
  runtime: RuntimeType;
  model: string | undefined;
  permissionMode: string | undefined;
  mcpEnabledServers: string[] | undefined;
  providerId: string | undefined;
  providerEnvJson: string | undefined;
}

/**
 * The IM live-follow owner kind was removed with the IM channels; every
 * surviving owner (Desktop Tab, Cron new-task, Cron current-session) is
 * 'owned' — reads from the session snapshot with Agent as fallback.
 */
export type SessionOwnerKind = 'owned';

/**
 * Resolve the effective config for one query (D2, D7, Option C).
 *
 * Read session snapshot first; fall back to agent for any field the snapshot
 * hasn't captured yet (lazy migration for legacy sessions that predate
 * v0.1.69).
 *
 * The lazy fallback is **only a read-path concern** — it does NOT write back
 * into SessionMetadata. Backfill happens only on active writes (user sends a
 * message / changes a setting); see PRD §6.4.
 */
export function resolveSessionConfig(
  meta: SessionMetadata | null | undefined,
  agent: AgentConfig,
  _channel: undefined,
  ownerKind: SessionOwnerKind,
): ResolvedSessionConfig {
  void ownerKind;
  // owned (Desktop + Cron): session snapshot first, agent fallback per field
  const runtime = meta?.runtime ?? agent.runtime ?? 'builtin';
  // Snapshot vs agent-fallback for model. For external runtimes the snapshot
  // and agent fallback target different fields — snapshot holds the runtime
  // model (set by interactive writes + the runtime-aware snapshot helper),
  // agent fallback should read `runtimeConfig.model` not `agent.model`
  // (which is the builtin/provider field). Without this branch a fresh
  // unsnapshotted external session would read `agent.model` (Claude) and
  // hand it to Codex → 400 (issue #224).
  const rawModel = runtime === 'builtin'
    ? (meta?.model ?? agent.model)
    : (meta?.model ?? agent.runtimeConfig?.model);
  // Coerce obviously-foreign models out before they reach the runtime CLI.
  // Heals existing stale snapshots written by the pre-fix snapshot helper
  // (e.g. cron tasks created on App ≤ 0.2.19 with runtime=codex but
  // model=claude-opus-4-6). Uses the same conservative heuristic as the
  // agent-config migration — only drops values we're confident don't
  // belong, keeps unknown values intact.
  let model = rawModel;
  if (runtime !== 'builtin'
      && typeof model === 'string' && model.length > 0
      && !modelLooksLikeRuntime(model, runtime)) {
    console.warn(
      `[runtime-coerce] dropping stale session model='${model}' on runtime='${runtime}' (issue #224); falling back to runtime default. sessionId=${meta?.id ?? '<none>'} agentDir=${meta?.agentDir ?? agent.workspacePath ?? '<unknown>'}`,
    );
    model = undefined;
  }
  return {
    runtime,
    model,
    permissionMode: meta?.permissionMode ?? (runtime === 'builtin' ? agent.permissionMode : agent.runtimeConfig?.permissionMode),
    mcpEnabledServers: meta?.mcpEnabledServers ?? agent.mcpEnabledServers,
    providerId: meta?.providerId ?? agent.providerId,
    providerEnvJson: meta?.providerEnvJson ?? agent.providerEnvJson,
  };
}
