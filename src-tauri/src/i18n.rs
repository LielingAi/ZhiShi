//! i18n Rust-side foundation (specs/tech_docs/i18n_architecture.md §1/§5).
//!
//! W6 subtraction: the language-switching command chain
//! (`cmd_set_ui_language` → persist → tray relabel → renderer broadcast) was
//! deleted with the windowless host — there is no settings page and no
//! renderer to broadcast to. What remains is the read-only resolution chain
//! (config.json `uiLanguage` → OS locale → `SupportedLocale`) plus the tiny
//! native-chrome match table, used to label the tray's Exit item.
//!
//! `resolve_effective_locale` mirrors `src/shared/i18n.ts::resolveEffectiveLocale`
//! — keep the two in lockstep when adding locales (spec §7 checklist).

use serde::{Deserialize, Serialize};

use crate::utils::bom::strip_bom;
use crate::ulog_debug;

/// Locales the product actually renders in (allow-list, spec §1).
/// Serde strings match the BCP-47-ish ids used on disk and on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SupportedLocale {
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en-US")]
    EnUs,
}

impl SupportedLocale {
    pub fn as_str(self) -> &'static str {
        match self {
            SupportedLocale::ZhCn => "zh-CN",
            SupportedLocale::EnUs => "en-US",
        }
    }
}

/// User-configured UI language, persisted as `config.json::uiLanguage`.
/// `System` (the default) follows the OS locale; legacy configs without the
/// field are treated as `System`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[derive(Default)]
pub enum UiLanguage {
    #[serde(rename = "system")]
    #[default]
    System,
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en-US")]
    EnUs,
}


impl UiLanguage {
    pub fn as_str(self) -> &'static str {
        match self {
            UiLanguage::System => "system",
            UiLanguage::ZhCn => "zh-CN",
            UiLanguage::EnUs => "en-US",
        }
    }
}

/// Partial view of config.json — serde tolerates every other field, so this
/// stays compatible with whatever shape `src/shared/config-types.ts` grows.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PartialI18nConfig {
    ui_language: Option<String>,
}

/// Unknown/unsupported values fall back to `System` rather than failing the
/// whole read — a hand-edited config must not wedge language resolution.
pub fn normalize_ui_language(value: &str) -> UiLanguage {
    match value {
        "zh-CN" => UiLanguage::ZhCn,
        "en-US" => UiLanguage::EnUs,
        _ => UiLanguage::System,
    }
}

/// Map an OS locale string onto the allow-list: anything starting with `zh`
/// (zh, zh-CN, zh-Hans, zh_TW, …) → zh-CN, everything else → en-US.
fn resolve_os_locale(os_locale: Option<&str>) -> SupportedLocale {
    let Some(value) = os_locale else {
        // 完全拿不到 OS locale 时兜底 zh-CN（中文先行产品：现有用户全中文，
        // 宁可在罕见的无 locale 英文环境显中文，不让中文用户突然见英文）。
        return SupportedLocale::ZhCn;
    };
    let normalized = value.trim().replace('_', "-").to_lowercase();
    if normalized == "zh" || normalized.starts_with("zh-") {
        SupportedLocale::ZhCn
    } else {
        SupportedLocale::EnUs
    }
}

/// Single source of truth for the system→locale mapping (mirrors TS
/// `resolveEffectiveLocale`). Explicit user choice always wins.
pub fn resolve_effective_locale(
    ui_language: UiLanguage,
    os_locale: Option<&str>,
) -> SupportedLocale {
    match ui_language {
        UiLanguage::ZhCn => SupportedLocale::ZhCn,
        UiLanguage::EnUs => SupportedLocale::EnUs,
        UiLanguage::System => resolve_os_locale(os_locale),
    }
}

/// OS locale detection, primary source for `system` resolution (spec §1):
/// `sys-locale` first, then the POSIX locale env vars as fallback.
pub fn system_locale() -> Option<String> {
    sys_locale::get_locale().or_else(|| {
        std::env::var("LC_ALL")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("LC_MESSAGES").ok().filter(|s| !s.is_empty()))
            .or_else(|| std::env::var("LANG").ok().filter(|s| !s.is_empty()))
    })
}

fn read_ui_language_from(config_path: &std::path::Path) -> UiLanguage {
    let content = match std::fs::read_to_string(config_path) {
        Ok(s) => s,
        // Missing file/field → system (spec §1: legacy configs have no field).
        // Unreadable/corrupt configs also degrade to system — on zh machines
        // that still resolves to zh-CN via the OS locale, so no regression.
        Err(_) => return UiLanguage::System,
    };
    let cfg: PartialI18nConfig = match serde_json::from_str(strip_bom(&content)) {
        Ok(c) => c,
        Err(_) => return UiLanguage::System,
    };
    match cfg.ui_language {
        Some(value) => normalize_ui_language(&value),
        None => UiLanguage::System,
    }
}

pub fn current_ui_language() -> UiLanguage {
    if let Some(dir) = crate::app_dirs::zhishi_data_dir() {
        let value = read_ui_language_from(&dir.join("config.json"));
        ulog_debug!("[i18n] disk: uiLanguage={}", value.as_str());
        return value;
    }
    UiLanguage::System
}

pub fn current_locale() -> SupportedLocale {
    resolve_effective_locale(current_ui_language(), system_locale().as_deref())
}

/// Native-chrome strings the React layer can't reach (spec §5: deliberately
/// tiny hardcoded match table — tray menu only).
pub fn t(key: &str, locale: SupportedLocale) -> &str {
    match (locale, key) {
        (SupportedLocale::ZhCn, "tray.openSession") => "打开会话",
        (SupportedLocale::EnUs, "tray.openSession") => "Open Session",
        (SupportedLocale::ZhCn, "tray.exit") => "退出",
        (SupportedLocale::EnUs, "tray.exit") => "Quit",
        _ => key,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_ui_language_values() {
        assert_eq!(normalize_ui_language("system"), UiLanguage::System);
        assert_eq!(normalize_ui_language("zh-CN"), UiLanguage::ZhCn);
        assert_eq!(normalize_ui_language("en-US"), UiLanguage::EnUs);
        // Unknown values degrade to system rather than failing.
        assert_eq!(normalize_ui_language("fr-FR"), UiLanguage::System);
        assert_eq!(normalize_ui_language(""), UiLanguage::System);
    }

    #[test]
    fn system_language_follows_zh_os_locale() {
        // zh-Hans (and any zh* tag, underscores tolerated) → zh-CN.
        assert_eq!(
            resolve_effective_locale(UiLanguage::System, Some("zh-Hans")),
            SupportedLocale::ZhCn
        );
        assert_eq!(
            resolve_effective_locale(UiLanguage::System, Some("zh_CN.UTF-8")),
            SupportedLocale::ZhCn
        );
        assert_eq!(
            resolve_effective_locale(UiLanguage::System, Some("zh-TW")),
            SupportedLocale::ZhCn
        );
    }

    #[test]
    fn system_language_maps_non_zh_os_locale_to_en_us() {
        assert_eq!(
            resolve_effective_locale(UiLanguage::System, Some("en-US")),
            SupportedLocale::EnUs
        );
        assert_eq!(
            resolve_effective_locale(UiLanguage::System, Some("ja-JP")),
            SupportedLocale::EnUs
        );
        assert_eq!(
            resolve_effective_locale(UiLanguage::System, None),
            SupportedLocale::ZhCn // 无 locale 信息兜底中文（中文先行产品）
        );
    }

    #[test]
    fn explicit_language_wins_over_os_locale() {
        assert_eq!(
            resolve_effective_locale(UiLanguage::EnUs, Some("zh-CN")),
            SupportedLocale::EnUs
        );
        assert_eq!(
            resolve_effective_locale(UiLanguage::ZhCn, Some("en-US")),
            SupportedLocale::ZhCn
        );
    }

    #[test]
    fn serde_wire_format_is_kebab_case_ids() {
        assert_eq!(
            serde_json::to_string(&UiLanguage::System).unwrap(),
            "\"system\""
        );
        assert_eq!(
            serde_json::to_string(&UiLanguage::ZhCn).unwrap(),
            "\"zh-CN\""
        );
        assert_eq!(
            serde_json::to_string(&SupportedLocale::EnUs).unwrap(),
            "\"en-US\""
        );
        assert_eq!(
            serde_json::from_str::<UiLanguage>("\"zh-CN\"").unwrap(),
            UiLanguage::ZhCn
        );
    }

    #[test]
    fn missing_field_defaults_to_system() {
        let cfg: PartialI18nConfig = serde_json::from_str("{\"theme\":\"dark\"}").unwrap();
        assert_eq!(cfg.ui_language, None);
        // And a full disk read of that shape resolves to system.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, "{\"theme\":\"dark\"}").unwrap();
        assert_eq!(read_ui_language_from(&path), UiLanguage::System);
    }

    #[test]
    fn tray_strings_have_both_locales() {
        for key in ["tray.exit", "tray.openSession"] {
            assert_ne!(t(key, SupportedLocale::ZhCn), key);
            assert_ne!(t(key, SupportedLocale::EnUs), key);
            assert_ne!(t(key, SupportedLocale::ZhCn), t(key, SupportedLocale::EnUs));
        }
    }
}
