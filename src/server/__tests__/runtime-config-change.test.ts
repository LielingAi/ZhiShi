// Tests for the cross-runtime-switch scrub helper and migration.
// Issue #194 follow-up — locks the contract documented in
// shared/types/runtime.ts::buildRuntimeChangePatch and
// migrations/scrub-stale-runtime-config.ts.

import { describe, it, expect } from 'vitest';
import { buildRuntimeChangePatch } from '../../shared/types/runtime';

describe('buildRuntimeChangePatch', () => {
  it('returns runtimeConfig: undefined when current is undefined', () => {
    const patch = buildRuntimeChangePatch(undefined, 'codex');
    expect(patch).toEqual({ runtime: 'codex', runtimeConfig: undefined });
  });

  it('scrubs model / permissionMode / additionalArgs', () => {
    const patch = buildRuntimeChangePatch(
      {
        model: 'gemini-3.1-pro-preview',
        permissionMode: 'autoEdit',
        additionalArgs: ['--acp'],
      },
      'codex',
    );
    expect(patch.runtime).toBe('codex');
    expect(patch.runtimeConfig).toBeUndefined();  // all fields were per-runtime → empty → undefined
  });

  it('preserves envPolicy across runtime switches', () => {
    const patch = buildRuntimeChangePatch(
      {
        model: 'gemini-3.1-pro-preview',
        envPolicy: { proxy: 'terminal' },
      },
      'codex',
    );
    expect(patch.runtime).toBe('codex');
    expect(patch.runtimeConfig).toEqual({ envPolicy: { proxy: 'terminal' } });
  });

  it('returns runtimeConfig: undefined when scrub leaves an empty object', () => {
    const patch = buildRuntimeChangePatch(
      { model: 'gemini-3.1-pro-preview' },
      'codex',
    );
    expect(patch.runtimeConfig).toBeUndefined();
  });

  it('does not mutate the input runtimeConfig', () => {
    const input = {
      model: 'gemini-3.1-pro-preview',
      envPolicy: { proxy: 'terminal' as const },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    buildRuntimeChangePatch(input, 'codex');
    expect(input).toEqual(snapshot);
  });
});
