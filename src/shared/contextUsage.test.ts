import { describe, it, expect } from 'vitest';

import { computeContextUsage, stripModelSuffix, SDK_DEFAULT_CONTEXT_WINDOW } from './contextUsage';

describe('stripModelSuffix', () => {
  it('strips the [1m] suffix (case-insensitive)', () => {
    expect(stripModelSuffix('claude-opus-4-6[1m]')).toBe('claude-opus-4-6');
    expect(stripModelSuffix('deepseek-v4-pro[1M]')).toBe('deepseek-v4-pro');
  });
  it('leaves un-suffixed ids untouched', () => {
    expect(stripModelSuffix('claude-opus-4-8')).toBe('claude-opus-4-8');
  });
  it('returns undefined for empty input', () => {
    expect(stripModelSuffix(undefined)).toBeUndefined();
    expect(stripModelSuffix(null)).toBeUndefined();
    expect(stripModelSuffix('')).toBeUndefined();
  });
});

describe('computeContextUsage', () => {
  const noLookup = () => null;

  it('prefers the runtime-reported window over registry', () => {
    const r = computeContextUsage({
      occupiedTokens: 50_000,
      runtimeWindow: 400_000,
      source: 'codex',
      model: 'gpt-5.4-codex',
      lookupWindow: () => 128_000, // registry would say 128K, but runtime wins
    });
    expect(r.contextWindow).toBe(400_000);
    expect(r.windowSource).toBe('runtime');
    expect(r.usedPercent).toBeCloseTo(12.5, 5);
  });

  it('falls back to registry when runtime window is null', () => {
    const r = computeContextUsage({
      occupiedTokens: 64_000,
      runtimeWindow: null,
      source: 'claude-code',
      model: 'deepseek-v4',
      lookupWindow: () => 128_000,
    });
    expect(r.contextWindow).toBe(128_000);
    expect(r.windowSource).toBe('registry');
    expect(r.usedPercent).toBeCloseTo(50, 5);
  });

  it('falls back to SDK default 200K when neither runtime nor registry knows', () => {
    const r = computeContextUsage({
      occupiedTokens: 100_000,
      runtimeWindow: null,
      source: 'gemini',
      model: 'some-custom-model',
      lookupWindow: noLookup,
    });
    expect(r.contextWindow).toBe(SDK_DEFAULT_CONTEXT_WINDOW);
    expect(r.windowSource).toBe('default');
    expect(r.usedPercent).toBeCloseTo(50, 5);
  });

  it('strips [1m] before the registry lookup', () => {
    const seen: (string | undefined)[] = [];
    const r = computeContextUsage({
      occupiedTokens: 10_000,
      runtimeWindow: null,
      source: 'builtin',
      model: 'claude-opus-4-6[1m]',
      lookupWindow: (m) => { seen.push(m); return 1_000_000; },
    });
    expect(seen).toEqual(['claude-opus-4-6']); // bare id, not the [1m] form
    expect(r.contextWindow).toBe(1_000_000);
    expect(r.windowSource).toBe('runtime' === r.windowSource ? r.windowSource : 'registry');
    expect(r.windowSource).toBe('registry');
  });

  it('caps usedPercent at 100 when occupancy exceeds the window', () => {
    const r = computeContextUsage({
      occupiedTokens: 250_000,
      runtimeWindow: 200_000,
      source: 'builtin',
      lookupWindow: noLookup,
    });
    expect(r.usedPercent).toBe(100);
    expect(r.contextTokens).toBe(250_000);
  });

  it('treats zero / negative / NaN occupancy as 0', () => {
    for (const bad of [0, -100, NaN]) {
      const r = computeContextUsage({
        occupiedTokens: bad,
        runtimeWindow: 200_000,
        source: 'builtin',
        lookupWindow: noLookup,
      });
      expect(r.contextTokens).toBe(0);
      expect(r.usedPercent).toBe(0);
    }
  });

  it('ignores non-positive runtime windows and falls through', () => {
    const r = computeContextUsage({
      occupiedTokens: 10_000,
      runtimeWindow: 0,
      source: 'codex',
      model: 'x',
      lookupWindow: () => 100_000,
    });
    expect(r.contextWindow).toBe(100_000);
    expect(r.windowSource).toBe('registry');
  });

  it('rounds fractional occupancy', () => {
    const r = computeContextUsage({
      occupiedTokens: 1234.7,
      runtimeWindow: 200_000,
      source: 'builtin',
      lookupWindow: noLookup,
    });
    expect(r.contextTokens).toBe(1235);
  });
});
