import { describe, expect, it } from 'vitest';

import { resolveSessionModelAliases } from './model-aliases';

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
