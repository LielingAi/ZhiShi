import { describe, expect, it } from 'vitest';

import {
  isSupportedLocale,
  isUiLanguage,
  normalizeUiLanguage,
  resolveEffectiveLocale,
  resolveSupportedLocale,
} from './i18n';

describe('isSupportedLocale / isUiLanguage', () => {
  it('accepts allow-list values only', () => {
    expect(isSupportedLocale('zh-CN')).toBe(true);
    expect(isSupportedLocale('en-US')).toBe(true);
    expect(isSupportedLocale('zh')).toBe(false);
    expect(isSupportedLocale('fr-FR')).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
    expect(isSupportedLocale(42)).toBe(false);

    expect(isUiLanguage('system')).toBe(true);
    expect(isUiLanguage('zh-CN')).toBe(true);
    expect(isUiLanguage('en-US')).toBe(true);
    expect(isUiLanguage('zh')).toBe(false);
    expect(isUiLanguage(null)).toBe(false);
  });
});

describe('normalizeUiLanguage', () => {
  it('passes through valid values', () => {
    expect(normalizeUiLanguage('system')).toBe('system');
    expect(normalizeUiLanguage('zh-CN')).toBe('zh-CN');
    expect(normalizeUiLanguage('en-US')).toBe('en-US');
  });

  it('falls back to system for missing/dirty values (老配置无此字段)', () => {
    expect(normalizeUiLanguage(undefined)).toBe('system');
    expect(normalizeUiLanguage(null)).toBe('system');
    expect(normalizeUiLanguage('fr-FR')).toBe('system');
    expect(normalizeUiLanguage('')).toBe('system');
  });
});

describe('resolveSupportedLocale', () => {
  it('maps zh-prefixed OS locales to zh-CN', () => {
    expect(resolveSupportedLocale('zh-CN')).toBe('zh-CN');
    expect(resolveSupportedLocale('zh-TW')).toBe('zh-CN');
    expect(resolveSupportedLocale('zh')).toBe('zh-CN');
    expect(resolveSupportedLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(resolveSupportedLocale('ZH_cn')).toBe('zh-CN');
    expect(resolveSupportedLocale('zh_CN')).toBe('zh-CN');
  });

  it('maps every non-zh OS locale to en-US', () => {
    expect(resolveSupportedLocale('en-US')).toBe('en-US');
    expect(resolveSupportedLocale('en-GB')).toBe('en-US');
    expect(resolveSupportedLocale('ja-JP')).toBe('en-US');
    expect(resolveSupportedLocale('fr-FR')).toBe('en-US');
    expect(resolveSupportedLocale('')).toBe('zh-CN'); // 空串视同缺失
  });

  it('falls back to zh-CN when no OS locale is available at all', () => {
    expect(resolveSupportedLocale(undefined)).toBe('zh-CN');
    expect(resolveSupportedLocale(null)).toBe('zh-CN');
  });
});

describe('resolveEffectiveLocale', () => {
  it('uses explicit uiLanguage directly, ignoring OS locale', () => {
    expect(resolveEffectiveLocale('zh-CN', 'en-US')).toBe('zh-CN');
    expect(resolveEffectiveLocale('en-US', 'zh-CN')).toBe('en-US');
    expect(resolveEffectiveLocale('en-US', undefined)).toBe('en-US');
  });

  it('resolves system via OS locale', () => {
    expect(resolveEffectiveLocale('system', 'zh-CN')).toBe('zh-CN');
    expect(resolveEffectiveLocale('system', 'zh-Hant-TW')).toBe('zh-CN');
    expect(resolveEffectiveLocale('system', 'en-US')).toBe('en-US');
    expect(resolveEffectiveLocale('system', 'de-DE')).toBe('en-US');
  });

  it('treats missing/invalid uiLanguage as system', () => {
    expect(resolveEffectiveLocale(undefined, 'en-US')).toBe('en-US');
    expect(resolveEffectiveLocale('fr-FR', 'zh-CN')).toBe('zh-CN');
  });

  it('final fallback is zh-CN when system and no OS locale anywhere', () => {
    expect(resolveEffectiveLocale('system')).toBe('zh-CN');
    expect(resolveEffectiveLocale(undefined, undefined)).toBe('zh-CN');
  });
});
