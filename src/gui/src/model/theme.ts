/**
 * 主题模式（1.3.2 任务三「深浅色切换」，纯逻辑）。
 *
 * styles.css 已有 `body.light` 变量覆盖（浅色变量组）；切换 = 给 body 挂
 * `.light` class + localStorage 持久化。深色为默认（:root 变量即深色）。
 * DOM 副作用（挂 class / 读写 localStorage 的兜底）由 store 执行，本模块
 * 只放可单测的判定函数。
 */

export type ThemeMode = 'dark' | 'light';

/** localStorage 持久化键（与 1.3.0 样式占位一致的口径）。 */
export const THEME_STORAGE_KEY = 'zhishi.gui.theme';

/** 切换下一主题（dark ↔ light）。 */
export function nextTheme(theme: ThemeMode): ThemeMode {
  return theme === 'dark' ? 'light' : 'dark';
}

/** 未知值守卫（localStorage 可能是任意字符串）。 */
export function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'dark' || v === 'light';
}

/**
 * 读持久化主题：非法/缺失一律回落 'dark'（深色是默认）。
 * storage 可注入（单测）；读写异常静默回落（隐私模式等）。
 */
export function loadTheme(storage?: { getItem(k: string): string | null } | null): ThemeMode {
  try {
    const v = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeMode(v) ? v : 'dark';
  } catch {
    return 'dark';
  }
}
