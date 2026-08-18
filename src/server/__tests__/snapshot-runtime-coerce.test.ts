// Tests for issue #224: cron task with runtime=codex was carrying a Claude
// builtin model name in the session snapshot. Two sibling fixes:
//   1. snapshotForOwnedSession captures the runtime-appropriate model field
//   2. resolveSessionConfig coerces obviously-foreign stale snapshot values
//      back to undefined so the runtime CLI falls back to its default
//
// The dual-layer defense keeps existing stale snapshots from re-firing the
// bug on next execution (layer 2) while preventing new bad snapshots from
// being written (layer 1).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { snapshotForOwnedSession } from '../utils/session-snapshot';
import { resolveSessionConfig } from '../utils/resolve-session-config';
import type { AgentConfig } from '../../shared/types/agent';
import type { SessionMetadata } from '../types/session';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    enabled: true,
    workspacePath: '/tmp/agent',
    permissionMode: 'auto',
    channels: [],
    ...overrides,
  };
}

describe('snapshotForOwnedSession (issue #224)', () => {
  it('captures agent.model for builtin runtime', () => {
    const agent = makeAgent({
      runtime: 'builtin',
      model: 'claude-opus-4-6',
      runtimeConfig: undefined,
    });
    const snap = snapshotForOwnedSession(agent);
    expect(snap.runtime).toBe('builtin');
    expect(snap.model).toBe('claude-opus-4-6');
  });

  it('captures runtimeConfig.model for codex (NOT agent.model)', () => {
    const agent = makeAgent({
      runtime: 'codex',
      // Stale leftover from when the agent was on builtin. The bug was that
      // this used to leak into the cron `effectiveRuntimeConfig.model`.
      model: 'claude-opus-4-6',
      runtimeConfig: { model: 'gpt-5.5-codex' },
    });
    const snap = snapshotForOwnedSession(agent);
    expect(snap.runtime).toBe('codex');
    expect(snap.model).toBe('gpt-5.5-codex');
  });

  it('captures runtimeConfig.model for gemini (NOT agent.model)', () => {
    const agent = makeAgent({
      runtime: 'gemini',
      model: 'claude-opus-4-6',
      runtimeConfig: { model: 'gemini-3.1-pro-preview' },
    });
    const snap = snapshotForOwnedSession(agent);
    expect(snap.runtime).toBe('gemini');
    expect(snap.model).toBe('gemini-3.1-pro-preview');
  });

  it('snapshot.model is undefined when runtimeConfig.model is unset on external runtime', () => {
    const agent = makeAgent({
      runtime: 'codex',
      model: 'claude-opus-4-6',
      // runtimeConfig.model unset — user has not picked a codex model yet
      runtimeConfig: undefined,
    });
    const snap = snapshotForOwnedSession(agent);
    // Critical: we DO NOT fall back to agent.model for external runtimes —
    // letting the runtime CLI use its own default is safer than feeding it
    // a builtin model name it will reject.
    expect(snap.model).toBeUndefined();
  });

  it('permissionMode dispatches on runtime (builtin → agent, external → runtimeConfig)', () => {
    expect(snapshotForOwnedSession(makeAgent({
      runtime: 'builtin',
      permissionMode: 'auto',
      runtimeConfig: { permissionMode: 'full-auto' },
    })).permissionMode).toBe('auto');

    expect(snapshotForOwnedSession(makeAgent({
      runtime: 'codex',
      permissionMode: 'auto',  // stale builtin value, ignored
      runtimeConfig: { permissionMode: 'full-auto' },
    })).permissionMode).toBe('full-auto');
  });
});

describe('resolveSessionConfig — runtime-aware coercion (issue #224)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  function meta(partial: Partial<SessionMetadata> = {}): SessionMetadata {
    return {
      id: 'session-1',
      agentDir: '/tmp/agent',
      title: 't',
      createdAt: '2026-05-21T00:00:00Z',
      lastActiveAt: '2026-05-21T00:00:00Z',
      runtime: 'builtin',
      ...partial,
    };
  }

  it('owned/builtin: reads agent.model fallback unchanged', () => {
    const r = resolveSessionConfig(undefined, makeAgent({
      runtime: 'builtin',
      model: 'claude-opus-4-6',
    }), undefined, 'owned');
    expect(r.runtime).toBe('builtin');
    expect(r.model).toBe('claude-opus-4-6');
  });

  it('owned/external: snapshot model is the runtime model (e.g. gpt-5.5-codex)', () => {
    const r = resolveSessionConfig(meta({
      runtime: 'codex',
      model: 'gpt-5.5-codex',  // a correctly-snapshotted runtime model
    }), makeAgent({ runtime: 'codex' }), undefined, 'owned');
    expect(r.runtime).toBe('codex');
    expect(r.model).toBe('gpt-5.5-codex');
  });

  it('owned/external: stale claude model in snapshot is coerced to undefined (issue #224 repro)', () => {
    // This is the exact field state the bug reporter had: cron session
    // snapshot frozen with runtime=codex but model=claude-opus-4-6 (leaked
    // from agent.model by the pre-fix snapshotForOwnedSession).
    const r = resolveSessionConfig(meta({
      runtime: 'codex',
      model: 'claude-opus-4-6',
    }), makeAgent({
      runtime: 'codex',
      model: 'claude-opus-4-6',  // stale builtin value on agent too
      runtimeConfig: undefined,
    }), undefined, 'owned');
    expect(r.runtime).toBe('codex');
    expect(r.model).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[runtime-coerce]'),
    );
  });

  it('owned/external: agent fallback reads runtimeConfig.model (not agent.model) when snapshot is empty', () => {
    const r = resolveSessionConfig(meta({
      runtime: 'codex',
      model: undefined,
    }), makeAgent({
      runtime: 'codex',
      model: 'claude-opus-4-6',
      runtimeConfig: { model: 'gpt-5.5-codex' },
    }), undefined, 'owned');
    expect(r.model).toBe('gpt-5.5-codex');
  });

  it('owned/external: claude-opus-4-6[1m] (1M suffix) is still recognized as Claude → coerced on codex', () => {
    const r = resolveSessionConfig(meta({
      runtime: 'codex',
      model: 'claude-opus-4-6[1m]',
    }), makeAgent({ runtime: 'codex' }), undefined, 'owned');
    expect(r.model).toBeUndefined();
  });

  it('owned/external: unknown model id passes through (conservative heuristic)', () => {
    const r = resolveSessionConfig(meta({
      runtime: 'codex',
      model: 'kimi-k2.5-preview',  // unknown — heuristic returns true → keep
    }), makeAgent({ runtime: 'codex' }), undefined, 'owned');
    expect(r.model).toBe('kimi-k2.5-preview');
  });

  it('owned/gemini: gpt-* is coerced (cross-runtime drift)', () => {
    const r = resolveSessionConfig(meta({
      runtime: 'gemini',
      model: 'gpt-5.5-codex',
    }), makeAgent({ runtime: 'gemini' }), undefined, 'owned');
    expect(r.model).toBeUndefined();
  });

  it('owned/claude-code: gemini-* is coerced', () => {
    const r = resolveSessionConfig(meta({
      runtime: 'claude-code',
      model: 'gemini-3.1-pro-preview',
    }), makeAgent({ runtime: 'claude-code' }), undefined, 'owned');
    expect(r.model).toBeUndefined();
  });
});
