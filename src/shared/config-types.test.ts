import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CLAUDE_TRANSCRIPT_CLEANUP_PERIOD_DAYS,
  DEFAULT_CONFIG,
  INTEL_DEFAULTS,
  normalizeClaudeTranscriptCleanupPeriodDays,
  normalizeProviderOrder,
  resolveIntelConfig,
} from './config-types';

// normalizeProviderOrder reconciles a persisted provider order against the set
// of providers that actually exist now: honor the saved order, drop stale/
// unknown ids, dedupe, then append any known providers the order didn't mention
// (newly added). Drift here scrambles or drops providers from the picker.
describe('normalizeProviderOrder', () => {
  it('honors the saved order, then appends known providers missing from it', () => {
    expect(normalizeProviderOrder(['a', 'b', 'c'], ['c', 'a'])).toEqual(['c', 'a', 'b']);
  });

  it('drops ids in the order that are no longer known', () => {
    expect(normalizeProviderOrder(['a', 'b'], ['stale', 'a'])).toEqual(['a', 'b']);
  });

  it('dedupes repeated ids in the saved order', () => {
    expect(normalizeProviderOrder(['a', 'b'], ['a', 'a', 'b', 'b'])).toEqual(['a', 'b']);
  });

  it('falls back to the known order when no saved order is given', () => {
    expect(normalizeProviderOrder(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(normalizeProviderOrder(['a', 'b'], [])).toEqual(['a', 'b']);
  });

  it('returns empty for no known providers', () => {
    expect(normalizeProviderOrder([], ['a', 'b'])).toEqual([]);
  });
});

describe('normalizeClaudeTranscriptCleanupPeriodDays', () => {
  it('uses a one-year default for missing or invalid values', () => {
    expect(DEFAULT_CONFIG.claudeTranscriptCleanupPeriodDays).toBe(DEFAULT_CLAUDE_TRANSCRIPT_CLEANUP_PERIOD_DAYS);
    expect(DEFAULT_CLAUDE_TRANSCRIPT_CLEANUP_PERIOD_DAYS).toBe(365);
    expect(normalizeClaudeTranscriptCleanupPeriodDays(undefined)).toBe(365);
    expect(normalizeClaudeTranscriptCleanupPeriodDays(Number.NaN)).toBe(365);
    expect(normalizeClaudeTranscriptCleanupPeriodDays('bad')).toBe(365);
  });

  it('passes a positive integer day count to the SDK settings layer', () => {
    expect(normalizeClaudeTranscriptCleanupPeriodDays(30)).toBe(30);
    expect(normalizeClaudeTranscriptCleanupPeriodDays('180')).toBe(180);
    expect(normalizeClaudeTranscriptCleanupPeriodDays(30.9)).toBe(30);
    expect(normalizeClaudeTranscriptCleanupPeriodDays(0)).toBe(1);
    expect(normalizeClaudeTranscriptCleanupPeriodDays(-12)).toBe(1);
  });
});

describe('resolveIntelConfig', () => {
  it('缺省合并 INTEL_DEFAULTS（minimal / 3 年 / 300MB / 在线回源开）', () => {
    expect(resolveIntelConfig(undefined)).toEqual(INTEL_DEFAULTS);
    expect(resolveIntelConfig({})).toEqual(INTEL_DEFAULTS);
    expect(INTEL_DEFAULTS).toEqual({ mode: 'minimal', windowYears: 3, maxSizeMb: 300, onlineFallback: true });
  });

  it('合法值透传，非法值回落缺省（config.json 用户可编辑，容错优先）', () => {
    expect(resolveIntelConfig({ mode: 'window', windowYears: 5, maxSizeMb: 100, onlineFallback: false }))
      .toEqual({ mode: 'window', windowYears: 5, maxSizeMb: 100, onlineFallback: false });
    expect(resolveIntelConfig({ mode: 'bogus' as never })).toEqual(INTEL_DEFAULTS);
    expect(resolveIntelConfig({ windowYears: 0 })).toEqual(INTEL_DEFAULTS);
    expect(resolveIntelConfig({ windowYears: Number.NaN })).toEqual(INTEL_DEFAULTS);
    expect(resolveIntelConfig({ maxSizeMb: -1 })).toEqual(INTEL_DEFAULTS);
    expect(resolveIntelConfig({ onlineFallback: 'yes' as never })).toEqual(INTEL_DEFAULTS);
  });
});
