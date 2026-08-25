/**
 * 主题模式纯函数单测（1.3.2 ③）：切换 / 守卫 / 持久化读取（非法回落深色）。
 */

import { describe, expect, it } from 'vitest';

import { isThemeMode, loadTheme, nextTheme, THEME_STORAGE_KEY } from './theme';

describe('theme', () => {
  it('nextTheme dark ↔ light', () => {
    expect(nextTheme('dark')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
  });

  it('isThemeMode 只认 dark/light', () => {
    expect(isThemeMode('dark')).toBe(true);
    expect(isThemeMode('light')).toBe(true);
    expect(isThemeMode('system')).toBe(false);
    expect(isThemeMode(undefined)).toBe(false);
  });

  it('loadTheme：合法值读取；非法/缺失回落 dark（深色为默认）', () => {
    expect(loadTheme({ getItem: () => 'light' })).toBe('light');
    expect(loadTheme({ getItem: () => 'dark' })).toBe('dark');
    expect(loadTheme({ getItem: () => 'solarized' })).toBe('dark');
    expect(loadTheme({ getItem: () => null })).toBe('dark');
    expect(loadTheme(undefined)).toBe('dark');
    expect(loadTheme(null)).toBe('dark');
  });

  it('loadTheme 存储异常静默回落 dark', () => {
    expect(
      loadTheme({
        getItem: () => {
          throw new Error('denied');
        },
      }),
    ).toBe('dark');
  });

  it('持久化键口径固定', () => {
    expect(THEME_STORAGE_KEY).toBe('zhishi.gui.theme');
  });
});
