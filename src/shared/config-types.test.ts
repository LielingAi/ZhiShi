import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CLAUDE_TRANSCRIPT_CLEANUP_PERIOD_DAYS,
  DEFAULT_CONFIG,
  INTEL_DEFAULTS,
  PRESET_PROVIDERS,
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

// 多模型接入（M4d）：OpenAI 格式内置供应商的预设结构合法性。
// 纯结构断言，不出网——模型列表拉取/解析的运行时行为由 server 侧
// provider-models.unit.test.ts 覆盖。
describe('PRESET_PROVIDERS（OpenAI 格式内置供应商）', () => {
  const OPENAI_PRESET_IDS = ['openai', 'moonshot', 'dashscope', 'zhipu', 'siliconflow'];

  it('五个 OpenAI 格式供应商齐全且全部 id 唯一', () => {
    const ids = PRESET_PROVIDERS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of OPENAI_PRESET_IDS) expect(ids).toContain(id);
  });

  it('每个 OpenAI 预设：type/api/isBuiltin/authType/apiProtocol/baseUrl/modelListUrl 齐全', () => {
    for (const p of PRESET_PROVIDERS.filter(p => OPENAI_PRESET_IDS.includes(p.id))) {
      expect(p.type).toBe('api');
      expect(p.isBuiltin).toBe(true);
      expect(p.authType).toBe('auth_token');
      expect(p.apiProtocol).toBe('openai');
      expect(p.config.baseUrl).toMatch(/^https:\/\//);
      expect(p.modelListUrl).toBe(`${String(p.config.baseUrl).replace(/\/+$/, '')}/models`);
    }
  });

  it('每个 OpenAI 预设：models 2-4 条且字段合法', () => {
    for (const p of PRESET_PROVIDERS.filter(p => OPENAI_PRESET_IDS.includes(p.id))) {
      expect(p.models.length).toBeGreaterThanOrEqual(2);
      expect(p.models.length).toBeLessThanOrEqual(4);
      for (const m of p.models) {
        expect(m.model).toBeTruthy();
        expect(m.modelName).toBeTruthy();
        expect(m.modelSeries).toBeTruthy();
        expect(m.contextLength ?? 0).toBeGreaterThan(0);
        expect(m.maxOutputTokens ?? 0).toBeGreaterThan(0);
        expect(Array.isArray(m.inputModalities)).toBe(true);
      }
    }
  });

  it('primaryModel 指向自家 models 目录内的条目', () => {
    for (const p of PRESET_PROVIDERS.filter(p => OPENAI_PRESET_IDS.includes(p.id))) {
      expect(p.models.some(m => m.model === p.primaryModel)).toBe(true);
    }
  });

  it('modelAliases 的 sonnet/opus/haiku 都指向目录内模型', () => {
    for (const p of PRESET_PROVIDERS.filter(p => OPENAI_PRESET_IDS.includes(p.id))) {
      const catalog = new Set(p.models.map(m => m.model));
      for (const k of ['sonnet', 'opus', 'haiku'] as const) {
        const target = p.modelAliases?.[k];
        expect(target, `${p.id}.modelAliases.${k}`).toBeTruthy();
        expect(catalog.has(target as string)).toBe(true);
      }
    }
  });

  it('既有 anthropic 系预设不受影响（无 apiProtocol；deepseek 保留 anthropic 端点 + 显式 modelListUrl）', () => {
    const anthropic = PRESET_PROVIDERS.find(p => p.id === 'anthropic-api');
    expect(anthropic?.config.baseUrl).toBe('https://api.anthropic.com');
    expect(anthropic?.apiProtocol).toBeUndefined();
    const deepseek = PRESET_PROVIDERS.find(p => p.id === 'deepseek');
    expect(deepseek?.config.baseUrl).toBe('https://api.deepseek.com/anthropic');
    expect(deepseek?.apiProtocol).toBeUndefined();
    expect(deepseek?.modelListUrl).toBe('https://api.deepseek.com/v1/models');
  });
});
