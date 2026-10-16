//! WebView2 磁盘缓存版本化 —— 根治「重装/升级后仍渲染旧前端」。
//!
//! 实机事故（WREN）：重装 1.9.11 后用户看到的仍是整套旧 UI ——
//! `%LOCALAPPDATA%\com.zhishi.app\EBWebView` 里的 WebView2 磁盘缓存跨重装存活，
//! tauri.localhost 的嵌入式资源响应被启发式缓存，新 exe 照样渲染旧前端，
//! 只能手工清 EBWebView 才恢复。
//!
//! 根治思路（Option A，版本化数据目录）：主 webview 的 data directory 带版本段
//! `{app_data}/EBWebView/v{version}/` —— 版本一变天然全新缓存，重装/升级/降级都
//! 必然看到与 exe 同源的前端；setup 期清扫旧版本目录（保留最近 KEEP 个）防无限膨胀。
//! 为什么不能在 setup 里删默认 EBWebView 目录（Option B）：tauri 2.10.1 内部
//! `setup()` 先于用户 setup 钩子创建 config 定义的窗口（webview 已在跑），那时删
//! 它的数据目录是在运行的 WebView2 眼皮底下动文件 —— 所以 config 窗口改
//! `create:false`，由本模块在用户 setup 里用版本化路径重建。

use std::path::{Path, PathBuf};
use tauri::Manager;

use crate::{ulog_info, ulog_warn};

/// 保留的版本目录个数（不含当前版本；当前版本永不被删）。重装/升级链条上
/// 旧缓存最多残留 KEEP 份，再老的删掉腾地方。
const KEEP_VERSION_DIRS: usize = 2;

/// WebView2 user data folder 默认目录名（wry 约定，实机事故现场目录）。
const EBWEBVIEW_DIR: &str = "EBWebView";

/// 版本目录名前缀：`v1.9.19` → 目录 `v1.9.19`。
const VERSION_DIR_PREFIX: &str = "v";

/// 版本号 → 版本目录名。文件系统安全清洗：只放行 ascii 字母数字和 `. + - _`，
/// 杜绝路径分隔符/空白混进目录段（版本号来自 Cargo.toml，此处纯防御）。
pub fn version_dir_name(version: &str) -> Option<String> {
    let ok = !version.is_empty()
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-' | '_'));
    if ok {
        Some(format!("{VERSION_DIR_PREFIX}{version}"))
    } else {
        None
    }
}

/// 版本目录名 → semver（供「保留最近 N 个」排序；不可解析的视为最旧）。
fn parse_version_dir(name: &str) -> Option<semver::Version> {
    name.strip_prefix(VERSION_DIR_PREFIX)?.parse().ok()
}

/// 纯函数：从 EBWebView 根目录现有条目的名字里，挑出「我们拥有的版本目录」。
/// 其余（旧世界非版本化缓存残骸、手工乱放的目录/文件）都是 legacy 待清。
pub fn partition_root_entries(entry_names: &[String]) -> (Vec<String>, Vec<String>) {
    let mut legacy = Vec::new();
    let mut versioned = Vec::new();
    for name in entry_names {
        if parse_version_dir(name).is_some() {
            versioned.push(name.clone());
        } else {
            legacy.push(name.clone());
        }
    }
    (legacy, versioned)
}

/// 纯函数：旧版本目录取舍列表。规则：按 semver 降序，跳过当前版本目录（永不删），
/// 其余保留最近 `keep` 个，再老的全部进删除列表；不可解析名字的排最后（最先被删）。
pub fn stale_version_dirs(existing: &[String], current_dir_name: &str, keep: usize) -> Vec<String> {
    let mut sortable: Vec<(Option<semver::Version>, &String)> =
        existing.iter().map(|n| (parse_version_dir(n), n)).collect();
    // Option<Version> 的 Ord：None < Some —— 降序后不可解析的落在队尾。
    sortable.sort_by(|a, b| b.0.cmp(&a.0));

    let mut kept = 0usize;
    let mut stale = Vec::new();
    for (_v, name) in sortable {
        if name.as_str() == current_dir_name {
            continue; // 当前版本目录本轮正要使用，绝不删除
        }
        if kept < keep {
            kept += 1;
        } else {
            stale.push((*name).clone());
        }
    }
    stale
}

/// setup 期调用：计算当前版本的 webview data directory，并清扫旧缓存。
/// 返回 None 表示拿不到 app 数据目录 —— 调用方应退化为默认行为（不版本化），
/// 窗口照常创建，只是缓存失效保障降级（老行为）。
pub fn versioned_webview_data_dir(app: &tauri::App) -> Option<PathBuf> {
    let version = app.package_info().version.to_string();
    let dir_name = match version_dir_name(&version) {
        Some(n) => n,
        None => {
            ulog_warn!("[webview-cache] 版本号 {:?} 无法用于目录名，跳过缓存版本化", version);
            return None;
        }
    };

    let root = app.path().app_data_dir().ok().map(|d| d.join(EBWEBVIEW_DIR))?;
    cleanup_webview_root(&root, &dir_name);
    let versioned = root.join(&dir_name);
    if let Err(e) = std::fs::create_dir_all(&versioned) {
        ulog_warn!("[webview-cache] 创建版本目录 {} 失败: {} —— 退回默认 data dir", versioned.display(), e);
        return None;
    }
    Some(versioned)
}

/// 清扫 EBWebView 根目录：(1) 旧世界非版本化缓存残骸（事故里的那批陈旧文件）、
/// (2) 超出保留个数的旧版本目录。当前版本目录不碰。删除失败只告警不阻塞启动。
fn cleanup_webview_root(root: &Path, current_dir_name: &str) {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return, // 根目录不存在（全新安装）——无需清扫
    };
    let names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    let (legacy, versioned) = partition_root_entries(&names);
    let stale = stale_version_dirs(&versioned, current_dir_name, KEEP_VERSION_DIRS);

    for name in legacy.iter().chain(stale.iter()) {
        // 当前版本目录双保险：任何情况下都不删。
        if name == current_dir_name {
            continue;
        }
        remove_entry_quietly(&root.join(name));
    }
    if !legacy.is_empty() || !stale.is_empty() {
        ulog_info!(
            "[webview-cache] EBWebView 清扫完成: legacy={} stale={}",
            legacy.len(),
            stale.len()
        );
    }
}

/// 删一个文件/目录/符号链接。Pit-of-success：写操作前用不跟随 symlink 的
/// `symlink_metadata` 探类型 —— `Path::exists()` 对断链 symlink 返回 false，
/// 会让 remove_dir_all 踩 `std::filesystem::equivalent` 异常（CLAUDE.md 红线表）。
fn remove_entry_quietly(path: &Path) {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => return,
    };
    let result = if meta.is_symlink() || meta.is_file() {
        std::fs::remove_file(path)
    } else {
        std::fs::remove_dir_all(path)
    };
    if let Err(e) = result {
        ulog_warn!("[webview-cache] 删除 {} 失败: {}（多为上一进程 WebView2 尚未释放句柄，下轮再清）", path.display(), e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── version_dir_name ────────────────────────────────────────────────

    #[test]
    fn version_dir_name_normal() {
        assert_eq!(version_dir_name("1.9.19").as_deref(), Some("v1.9.19"));
        assert_eq!(version_dir_name("2.0.0-rc.1").as_deref(), Some("v2.0.0-rc.1"));
        assert_eq!(version_dir_name("1.0.0+build.5").as_deref(), Some("v1.0.0+build.5"));
    }

    #[test]
    fn version_dir_name_rejects_unsafe() {
        assert_eq!(version_dir_name(""), None);
        assert_eq!(version_dir_name("../evil"), None);
        assert_eq!(version_dir_name("1.9/19"), None);
        assert_eq!(version_dir_name("1.9.19 "), None); // 含空白
        assert_eq!(version_dir_name("..\\up"), None);
    }

    // ── partition_root_entries ──────────────────────────────────────────

    #[test]
    fn partition_splits_legacy_and_versioned() {
        // semver 要求三段：v1.2 不合法 → 归 legacy（锁死"严格 semver"行为）
        let names: Vec<String> = ["Default", "v1.9.18", "v1.9.19", "EBWebViewBrowserData", "vbackup", "v1.2"]
            .iter().map(|s| s.to_string()).collect();
        let (legacy, versioned) = partition_root_entries(&names);
        assert!(legacy.contains(&"Default".to_string()));
        assert!(legacy.contains(&"EBWebViewBrowserData".to_string()));
        assert!(legacy.contains(&"vbackup".to_string())); // v 开头但不是合法 semver → legacy
        assert!(legacy.contains(&"v1.2".to_string())); // 两段版本号不是合法 semver → legacy
        assert_eq!(versioned, vec!["v1.9.18".to_string(), "v1.9.19".to_string()]);
    }

    // ── stale_version_dirs ──────────────────────────────────────────────

    #[test]
    fn stale_keeps_latest_two_excluding_current() {
        let existing: Vec<String> = ["v1.9.17", "v1.9.18", "v1.9.19"]
            .iter().map(|s| s.to_string()).collect();
        assert_eq!(stale_version_dirs(&existing, "v1.9.19", 2), Vec::<String>::new());
        // 当前版本不计入保留名额 → 再进一个 v1.9.20 时 v1.9.17 被清
        let existing: Vec<String> = ["v1.9.17", "v1.9.18", "v1.9.19", "v1.9.20"]
            .iter().map(|s| s.to_string()).collect();
        assert_eq!(stale_version_dirs(&existing, "v1.9.20", 2), vec!["v1.9.17".to_string()]);
    }

    #[test]
    fn stale_never_deletes_current_even_if_oldest() {
        // 降级场景：当前是旧版本，它也必须活下来
        let existing: Vec<String> = ["v1.9.18", "v1.9.19", "v1.9.20"]
            .iter().map(|s| s.to_string()).collect();
        let stale = stale_version_dirs(&existing, "v1.9.18", 2);
        assert!(stale.is_empty());
    }

    #[test]
    fn stale_fresh_version_keeps_two_latest_existing() {
        // 升级后首次启动：当前版本目录尚未落盘，列表里没有它 → 保留现有最近 2 个
        let existing: Vec<String> = ["v1.9.17", "v1.9.18"]
            .iter().map(|s| s.to_string()).collect();
        assert!(stale_version_dirs(&existing, "v1.9.19", 2).is_empty());
        let existing: Vec<String> = ["v1.9.16", "v1.9.17", "v1.9.18"]
            .iter().map(|s| s.to_string()).collect();
        assert_eq!(stale_version_dirs(&existing, "v1.9.19", 2), vec!["v1.9.16".to_string()]);
    }

    #[test]
    fn stale_unparseable_sorted_last_deleted_first() {
        // 垃圾名字排在 semver 之后 —— 保留名额紧张时最先被清
        let existing: Vec<String> = ["v1.9.19", "v1.9.18", "vjunk"]
            .iter().map(|s| s.to_string()).collect();
        assert_eq!(stale_version_dirs(&existing, "v1.9.19", 1), vec!["vjunk".to_string()]);
    }

    #[test]
    fn stale_semver_order_not_lexical() {
        // semver 排序：v1.9.9 < v1.9.10（字典序会排反）
        let existing: Vec<String> = ["v1.9.9", "v1.9.10", "v1.9.19"]
            .iter().map(|s| s.to_string()).collect();
        assert_eq!(stale_version_dirs(&existing, "v1.9.19", 1), vec!["v1.9.9".to_string()]);
    }

    #[test]
    fn stale_empty_and_zero_keep() {
        assert!(stale_version_dirs(&[], "v1.9.19", 2).is_empty());
        let existing: Vec<String> = ["v1.9.18", "v1.9.19"].iter().map(|s| s.to_string()).collect();
        // keep=0：除当前外全清
        assert_eq!(stale_version_dirs(&existing, "v1.9.19", 0), vec!["v1.9.18".to_string()]);
    }
}
