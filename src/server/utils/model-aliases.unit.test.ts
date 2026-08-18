import { describe, expect, it } from 'vitest';

import { modelAliasEnvChangesForModel, resolveSessionModelAliases } from './model-aliases';

describe('resolveSessionModelAliases', () => {
  it('rebases collapsed aliases to the active session model', () => {
    expect(resolveSessionModelAliases(
      { sonnet: 'MiniMax-M2.7', opus: 'MiniMax-M2.7', haiku: 'MiniMax-M2.7' },
      'MiniMax-M2.5',
    )).toEqual({
      sonnet: 'MiniMax-M2.5',
      opus: 'MiniMax-M2.5',
      haiku: 'MiniMax-M2.5',
    });
  });

  it('preserves intentionally split alias routing', () => {
    const aliases = {
      sonnet: 'deepseek-v4-pro',
      opus: 'deepseek-v4-pro',
      haiku: 'deepseek-v4-flash',
    };

    expect(resolveSessionModelAliases(aliases, 'deepseek-v4-pro')).toEqual(aliases);
  });

  it('does not rewrite incomplete alias tables', () => {
    const aliases = { sonnet: 'provider-sonnet' };

    expect(resolveSessionModelAliases(aliases, 'active-model')).toEqual(aliases);
  });
});

describe('modelAliasEnvChangesForModel', () => {
  it('detects when a collapsed alias table needs subprocess env reinjection', () => {
    expect(modelAliasEnvChangesForModel(
      { sonnet: 'MiniMax-M2.7', opus: 'MiniMax-M2.7', haiku: 'MiniMax-M2.7' },
      'MiniMax-M2.7',
      'MiniMax-M2.5',
    )).toBe(true);
  });

  it('ignores selected-model changes for split alias routing', () => {
    expect(modelAliasEnvChangesForModel(
      { sonnet: 'deepseek-v4-pro', opus: 'deepseek-v4-pro', haiku: 'deepseek-v4-flash' },
      'deepseek-v4-pro',
      'deepseek-v4-lite',
    )).toBe(false);
  });
});
