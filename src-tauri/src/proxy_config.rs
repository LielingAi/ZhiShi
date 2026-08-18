//! Shared proxy configuration module — one of four "pit of success" modules alongside
//! `local_http` (localhost HTTP clients), `process_cmd` (subprocess GUI flags),
//! and `system_binary` (system tool lookup).
//!
//! This module provides unified proxy configuration for:
//! 1. Tauri updater → CDN downloads (`build_client_with_proxy`)
//! 2. Bun Sidecar / Plugin Bridge → subprocess env injection (`apply_to_subprocess`)
//!
//! **All** child processes that may use `fetch()` or HTTP clients MUST call
//! `proxy_config::apply_to_subprocess()` before spawning. This ensures:
//! - User-configured proxy is injected when enabled
//! - System proxy is inherited when not configured (like other normal apps)
//! - `NO_PROXY` always protects localhost (Bun's `fetch()` honors `HTTP_PROXY`)
//!
//! Configuration is read from `~/.zhishi/config.json` and can be enabled/disabled
//! via Settings > General > Network Proxy.

use serde::Deserialize;
use std::fs;
use std::process::Command;

use crate::utils::bom::strip_bom;
use crate::{ulog_debug, ulog_error, ulog_info, ulog_warn};

/// Default proxy protocol (when not specified in config)
const DEFAULT_PROXY_PROTOCOL: &str = "http";
/// Default proxy host (when not specified in config)
const DEFAULT_PROXY_HOST: &str = "127.0.0.1";
/// Default proxy port (when not specified in config)
const DEFAULT_PROXY_PORT: u16 = 7890;

/// Comprehensive NO_PROXY list for all subprocess types.
/// Bun's `fetch()` honors HTTP_PROXY env vars — without this, inherited system
/// proxy would break internal localhost calls (admin-api, cron-tool, bridge, etc.).
/// Public so that `terminal.rs` can reuse the same constant (portable-pty uses
/// `CommandBuilder` instead of `std::process::Command`, so `apply_to_subprocess`
/// can't be called directly).
pub const LOCALHOST_NO_PROXY: &str = "localhost,localhost.localdomain,127.0.0.1,127.0.0.0/8,::1,[::1]";

/// Proxy settings from `~/.zhishi/config.json`
///
/// # Example JSON
/// ```json
/// {
///   "proxySettings": {
///     "enabled": true,
///     "protocol": "http",
///     "host": "127.0.0.1",
///     "port": 7890
///   }
/// }
/// ```
#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    /// Whether proxy is enabled
    pub enabled: bool,
    /// Proxy protocol: "http", "https", or "socks5"
    pub protocol: Option<String>,
    /// Proxy host (IP or domain)
    pub host: Option<String>,
    /// Proxy port (1-65535)
    pub port: Option<u16>,
}

/// Partial app config for reading proxy settings
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PartialAppConfig {
    proxy_settings: Option<ProxySettings>,
}

/// Read proxy settings from ~/.zhishi/config.json
/// Returns Some(ProxySettings) if proxy is enabled, None otherwise
/// Logs errors for invalid configuration to help users debug
pub fn read_proxy_settings() -> Option<ProxySettings> {
    let home = dirs::home_dir()?;
    let config_path = home.join(".zhishi").join("config.json");

    // Read config file
    let content = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // File not existing is normal (first run or no proxy configured)
            return None;
        }
        Err(e) => {
            ulog_warn!(
                "[proxy_config] Failed to read config file {:?}: {}. \
                 Check file permissions.",
                config_path, e
            );
            return None;
        }
    };

    // Strip UTF-8 BOM if present (Windows editors inject BOM into config.json).
    // Helper centralized in utils/bom.rs (issue #170 #6).
    let content = strip_bom(&content);

    // Parse JSON
    let config: PartialAppConfig = match serde_json::from_str(content) {
        Ok(c) => c,
        Err(e) => {
            ulog_error!(
                "[proxy_config] Invalid JSON in {:?}: {}. \
                 Please check the configuration file format.",
                config_path, e
            );
            return None;
        }
    };

    config.proxy_settings.filter(|p| p.enabled)
}

/// Get proxy URL string from settings with validation
/// Returns Result to ensure configuration is valid
pub fn get_proxy_url(settings: &ProxySettings) -> Result<String, String> {
    // Validate protocol
    let protocol = settings.protocol.as_deref().unwrap_or(DEFAULT_PROXY_PROTOCOL);
    if !["http", "https", "socks5"].contains(&protocol) {
        return Err(format!(
            "Invalid proxy protocol '{}'. Supported: http, https, socks5",
            protocol
        ));
    }

    // Validate port
    let port = settings.port.unwrap_or(DEFAULT_PROXY_PORT);
    if port == 0 {
        return Err(format!(
            "Invalid proxy port: {}. Port must be between 1 and 65535",
            port
        ));
    }

    let host = settings.host.as_deref().unwrap_or(DEFAULT_PROXY_HOST);

    Ok(format!("{}://{}:{}", protocol, host, port))
}

/// Apply ZhiShi proxy policy to a child process `Command`.
///
/// This is the **only** approved way to configure proxy env vars for subprocesses.
/// Using manual `cmd.env("HTTP_PROXY", ...)` or `cmd.env_remove(...)` is forbidden —
/// it will silently break when the proxy policy changes.
///
/// Behavior:
/// - **Proxy enabled in config**: injects HTTP_PROXY/HTTPS_PROXY + NO_PROXY + marker flag
/// - **Proxy config invalid**: strips all proxy vars (fail-safe)
/// - **No proxy configured**: inherits system env + injects NO_PROXY to protect localhost
///
/// Returns `true` if explicit proxy was injected (for TypeScript-side snapshot logic).
pub fn apply_to_subprocess(cmd: &mut Command) -> bool {
    if let Some(proxy_settings) = read_proxy_settings() {
        match get_proxy_url(&proxy_settings) {
            Ok(proxy_url) => {
                ulog_info!("[proxy_config] Injecting proxy for subprocess: {}", proxy_url);
                cmd.env("HTTP_PROXY", &proxy_url);
                cmd.env("HTTPS_PROXY", &proxy_url);
                cmd.env("http_proxy", &proxy_url);
                cmd.env("https_proxy", &proxy_url);
                cmd.env("NO_PROXY", LOCALHOST_NO_PROXY);
                cmd.env("no_proxy", LOCALHOST_NO_PROXY);
                // Issue #194 — `ALL_PROXY` (curl-style "use proxy for everything")
                // takes precedence over HTTP_PROXY/HTTPS_PROXY in many HTTP stacks
                // (reqwest, openssl, curl). If the launching env has an inherited
                // `ALL_PROXY` (Tauri started from a shell that exported it), it
                // would shadow the proxy we injected here, sending traffic via
                // the wrong upstream. Strip both casings.
                cmd.env_remove("ALL_PROXY");
                cmd.env_remove("all_proxy");
                // Flag so TypeScript can distinguish explicit injection from inherited system env
                cmd.env("ZHISHI_PROXY_INJECTED", "1");
                true
            }
            Err(e) => {
                ulog_error!(
                    "[proxy_config] Invalid proxy configuration: {}. \
                     Please check Settings > General > Network Proxy. \
                     Subprocess will start without proxy.",
                    e
                );
                for var in &[
                    "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
                    "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
                ] {
                    cmd.env_remove(var);
                }
                false
            }
        }
    } else {
        // No ZhiShi proxy configured: inherit system network behavior.
        // CRITICAL: Still inject NO_PROXY to protect Bun's localhost fetch calls
        // from being routed through any inherited system proxy.
        ulog_debug!("[proxy_config] No proxy configured, inheriting system network behavior");
        cmd.env("NO_PROXY", LOCALHOST_NO_PROXY);
        cmd.env("no_proxy", LOCALHOST_NO_PROXY);
        false
    }
}

/// Build a reqwest client with user's proxy configuration
/// - If proxy is enabled in config, use it for external requests (localhost excluded via NO_PROXY)
/// - If no proxy configured, inherit system network behavior (reqwest default proxy detection)
///
/// NOTE: This function is for OUTGOING requests only (CDN, IM APIs). Localhost
/// communication MUST use `local_http` module which unconditionally bypasses proxy.
pub fn build_client_with_proxy(
    builder: reqwest::ClientBuilder
) -> Result<reqwest::Client, String> {
    let final_builder = if let Some(proxy_settings) = read_proxy_settings() {
        let proxy_url = get_proxy_url(&proxy_settings)?;
        ulog_info!("[proxy_config] Using proxy for external requests: {}", proxy_url);

        // Configure proxy but exclude localhost and all loopback addresses
        // Comprehensive NO_PROXY list for maximum compatibility:
        // - localhost, localhost.localdomain (common DNS names)
        // - 127.0.0.1, 127.0.0.0/8 (IPv4 loopback range)
        // - ::1, [::1] (IPv6 loopback with/without brackets)
        let proxy = reqwest::Proxy::all(&proxy_url)
            .map_err(|e| format!("[proxy_config] Failed to create proxy: {}", e))?
            .no_proxy(reqwest::NoProxy::from_string(LOCALHOST_NO_PROXY));

        builder.proxy(proxy)
    } else {
        // No user proxy configured — inherit system network behavior.
        // Let reqwest use its default proxy detection (env vars + macOS system proxy).
        // This ensures the app respects system-level proxy (Clash TUN, global proxy, etc.)
        // just like other normal applications.
        ulog_info!("[proxy_config] No proxy configured, inheriting system network behavior");
        builder
    };

    final_builder.build()
        .map_err(|e| format!("[proxy_config] Failed to build HTTP client: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_proxy_url_with_defaults() {
        let settings = ProxySettings {
            enabled: true,
            protocol: None,
            host: None,
            port: None,
        };

        let result = get_proxy_url(&settings);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "http://127.0.0.1:7890");
    }

    #[test]
    fn test_get_proxy_url_with_custom_values() {
        let settings = ProxySettings {
            enabled: true,
            protocol: Some("socks5".to_string()),
            host: Some("192.168.1.1".to_string()),
            port: Some(1080),
        };

        let result = get_proxy_url(&settings);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "socks5://192.168.1.1:1080");
    }

    #[test]
    fn test_get_proxy_url_invalid_protocol() {
        let settings = ProxySettings {
            enabled: true,
            protocol: Some("ftp".to_string()),
            host: None,
            port: None,
        };

        let result = get_proxy_url(&settings);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid proxy protocol"));
    }

    #[test]
    fn test_get_proxy_url_zero_port() {
        let settings = ProxySettings {
            enabled: true,
            protocol: None,
            host: None,
            port: Some(0),
        };

        let result = get_proxy_url(&settings);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid proxy port"));
    }

    #[test]
    fn test_get_proxy_url_https_protocol() {
        let settings = ProxySettings {
            enabled: true,
            protocol: Some("https".to_string()),
            host: Some("proxy.example.com".to_string()),
            port: Some(443),
        };

        let result = get_proxy_url(&settings);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "https://proxy.example.com:443");
    }
}
