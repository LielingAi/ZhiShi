// i18n 核心模型 — 双端镜像的唯一事实源（TS 侧）。
// Rust 侧镜像见 src-tauri/src/i18n.rs（并行开发）。
// 架构定案：specs/tech_docs/i18n_architecture.md §1。
//
// 两个概念严格分离：
//   UiLanguage      用户配置（存 config.json::uiLanguage，缺省 system）
//   SupportedLocale 实际渲染 locale（allow-list）

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const UI_LANGUAGE_OPTIONS = ['system', ...SUPPORTED_LOCALES] as const;
export type UiLanguage = (typeof UI_LANGUAGE_OPTIONS)[number];

const SUPPORTED_LOCALE_SET = new Set<string>(SUPPORTED_LOCALES);
const UI_LANGUAGE_SET = new Set<string>(UI_LANGUAGE_OPTIONS);

function normalizeLocaleToken(value: string): string {
  return value.trim().replace(/_/g, '-');
}

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && SUPPORTED_LOCALE_SET.has(value);
}

export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === 'string' && UI_LANGUAGE_SET.has(value);
}

/** 老配置无 uiLanguage 字段 / 脏值 → 一律按 'system' 处理。 */
export function normalizeUiLanguage(value: unknown): UiLanguage {
  if (isUiLanguage(value)) return value;
  return 'system';
}

/**
 * OS locale → 渲染 locale：zh 开头 → zh-CN，其余一律 → en-US。
 * 完全拿不到 OS locale（Rust command 与 navigator.languages 均不可用）→ zh-CN
 * （中文先行产品的最终兜底，架构文档 §1）。
 */
export function resolveSupportedLocale(locale: string | null | undefined): SupportedLocale {
  if (!locale) return 'zh-CN';
  const normalized = normalizeLocaleToken(locale).toLowerCase();
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN';
  return 'en-US';
}

/**
 * 解析规则的唯一事实源：
 *   uiLanguage = 'zh-CN' | 'en-US' → 直接用
 *   uiLanguage = 'system'          → 按 OS locale 映射（resolveSupportedLocale）
 */
export function resolveEffectiveLocale(
  uiLanguage: unknown,
  osLocale?: string | null,
): SupportedLocale {
  const normalized = normalizeUiLanguage(uiLanguage);
  if (normalized !== 'system') return normalized;
  return resolveSupportedLocale(osLocale);
}
