import { describe, expect, test } from 'vitest';

import { normalizeRuntime, resolveEffectiveRuntime, getMaxPermissionForRuntime, VALID_RUNTIMES, type RuntimeType } from './runtime';

describe('normalizeRuntime', () => {
  test('passes through valid runtimes', () => {
    expect(normalizeRuntime('builtin')).toBe('builtin');
    expect(normalizeRuntime('claude-code')).toBe('claude-code');
    expect(normalizeRuntime('codex')).toBe('codex');
    expect(normalizeRuntime('gemini')).toBe('gemini');
  });

  test('falls back to builtin for missing / unknown values', () => {
    expect(normalizeRuntime(undefined)).toBe('builtin');
    expect(normalizeRuntime(null)).toBe('builtin');
    expect(normalizeRuntime('')).toBe('builtin');
    expect(normalizeRuntime('o3')).toBe('builtin');
  });
});

describe('resolveEffectiveRuntime', () => {
  // Mirrors the Rust spawn-time gate in
  // src-tauri/src/sidecar.rs::resolve_agent_runtime_from_config — keep in sync.

  test('gate OFF collapses every runtime to builtin (matches sidecar spawn)', () => {
    // This is the Gap-3 case: an agent configured for codex but the
    // multiAgentRuntime feature flag is off → the sidecar actually runs
    // builtin, so analytics must report builtin, not the configured intent.
    expect(resolveEffectiveRuntime('codex', false)).toBe('builtin');
    expect(resolveEffectiveRuntime('claude-code', false)).toBe('builtin');
    expect(resolveEffectiveRuntime('gemini', false)).toBe('builtin');
    expect(resolveEffectiveRuntime('builtin', false)).toBe('builtin');
    expect(resolveEffectiveRuntime(undefined, false)).toBe('builtin');
  });

  test('gate ON honors the configured (normalized) runtime', () => {
    expect(resolveEffectiveRuntime('codex', true)).toBe('codex');
    expect(resolveEffectiveRuntime('claude-code', true)).toBe('claude-code');
    expect(resolveEffectiveRuntime('gemini', true)).toBe('gemini');
    expect(resolveEffectiveRuntime('builtin', true)).toBe('builtin');
  });

  test('gate ON with no/unknown agent runtime is builtin', () => {
    expect(resolveEffectiveRuntime(undefined, true)).toBe('builtin');
    expect(resolveEffectiveRuntime(null, true)).toBe('builtin');
    expect(resolveEffectiveRuntime('nonsense', true)).toBe('builtin');
  });

  test('SCOPE: resolves only the agent-CONFIG dimension, NOT the session-frozen runtime', () => {
    // Documents the deliberate limitation (cross-review C1/C2): this helper has
    // no sessionId input and therefore CANNOT reproduce the runtime a still-open
    // session was spawned with. Concretely — a session created under codex whose
    // agent was later reconfigured to gemini: the server-side ai_turn_complete
    // still reports the FROZEN 'codex', but this helper (given current config)
    // returns 'gemini'. Session-scoped analytics must therefore prefer the frozen
    // `sessionRuntime` and use this only as the pre-session fallback.
    const currentAgentConfig = 'gemini';
    expect(resolveEffectiveRuntime(currentAgentConfig, true)).toBe('gemini'); // config view
    // The authoritative value for an existing session would be the frozen
    // 'codex' — which lives in session metadata, not derivable from this fn.
  });
});

describe('getMaxPermissionForRuntime — unattended max-agency mode per runtime', () => {
  // The unattended heartbeat turns inject system work (git commit,
  // file writes) and MUST run at each runtime's maximum agency so tool use never
  // blocks on an approval no human will answer. If any of these regress to a
  // non-bypass mode, an unattended turn on that runtime would hang until its
  // timeout instead of completing. (memory-update external-routing fix.)
  test('maps each runtime to its bypass / full-access mode', () => {
    expect(getMaxPermissionForRuntime('builtin')).toBe('fullAgency');
    expect(getMaxPermissionForRuntime('claude-code')).toBe('bypassPermissions');
    expect(getMaxPermissionForRuntime('codex')).toBe('no-restrictions');
    expect(getMaxPermissionForRuntime('gemini')).toBe('yolo');
  });

  test('returns a non-empty mode for every known runtime', () => {
    for (const rt of VALID_RUNTIMES as readonly RuntimeType[]) {
      const mode = getMaxPermissionForRuntime(rt);
      expect(typeof mode).toBe('string');
      expect(mode.length).toBeGreaterThan(0);
    }
  });

  test('falls back to builtin fullAgency for an unknown runtime', () => {
    expect(getMaxPermissionForRuntime('something-else' as RuntimeType)).toBe('fullAgency');
  });
});
