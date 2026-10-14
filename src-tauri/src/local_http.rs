//! Centralized HTTP client utilities for local Sidecar communication.
//!
//! **All** HTTP requests to local Sidecars (127.0.0.1) MUST use these builders
//! instead of raw `reqwest::Client::builder()`. This guarantees `.no_proxy()`
//! is always set, preventing system proxies (Clash/V2Ray) from intercepting
//! localhost requests and returning 502 Bad Gateway.
//!
//! ## Usage
//!
//! ```rust
//! use app_lib::local_http;
//! use std::time::Duration;
//!
//! // Simple client with custom timeout
//! let client = local_http::builder()
//!     .timeout(Duration::from_secs(30))
//!     .build()
//!     .expect("Failed to create HTTP client");
//!
//! // Pre-configured clients for common use cases
//! let client = local_http::json_client(Duration::from_secs(60));
//! let client = local_http::sse_client();
//! ```

use std::time::Duration;

/// Base builder for all local Sidecar HTTP clients.
///
/// Returns a `reqwest::ClientBuilder` pre-configured with `.no_proxy()`.
/// Callers can chain additional options (timeout, tcp_nodelay, etc.) before `.build()`.
///
/// This is the **only** approved way to create HTTP clients for localhost communication.
/// Using raw `reqwest::Client::builder()` or `reqwest::Client::new()` for localhost
/// is forbidden — it will silently break when the user has a system proxy configured.
pub fn builder() -> reqwest::ClientBuilder {
    // This module is the single legitimate caller of `Client::builder()`.
    #[allow(clippy::disallowed_methods)]
    reqwest::Client::builder().no_proxy()
}

/// Create a JSON-oriented HTTP client for local Sidecar API calls.
///
/// Pre-configured with:
/// - `.no_proxy()` — bypass system proxy for localhost
/// - Custom timeout — caller specifies based on expected response time
pub fn json_client(timeout: Duration) -> reqwest::Client {
    builder()
        .timeout(timeout)
        .build()
        .expect("[local_http] Failed to create JSON client")
}

/// Create an SSE streaming client for local Sidecar event streams.
///
/// Pre-configured with:
/// - `.no_proxy()` — bypass system proxy for localhost
/// - `.read_timeout(300s)` — idle timeout (no bytes for 300s → drop connection)
/// - `.tcp_nodelay(true)` — disable Nagle's algorithm for low-latency events
/// - `.http1_only()` — force HTTP/1.1 for SSE compatibility
///
/// No overall timeout — streams stay open until the AI turn completes.
/// read_timeout is 300s (not 60s) because on fresh Sidecar startup, the SDK's
/// query() can block the Bun event loop for minutes during session resume +
/// MCP server initialization, preventing heartbeat SSE comments from being sent.
/// The Bun-side heartbeat is 15s, so 300s provides comfortable margin.
pub fn sse_client() -> reqwest::Client {
    builder()
        .read_timeout(Duration::from_secs(300))
        .tcp_nodelay(true)
        .http1_only()
        .build()
        .expect("[local_http] Failed to create SSE client")
}

/// Base builder for **blocking** local Sidecar HTTP clients.
///
/// Same guarantee as [`builder()`] but for synchronous contexts
/// (e.g., `spawn_blocking` or Tauri command handlers).
pub fn blocking_builder() -> reqwest::blocking::ClientBuilder {
    // This module is the single legitimate caller of `Client::builder()`.
    #[allow(clippy::disallowed_methods)]
    reqwest::blocking::Client::builder().no_proxy()
}


// ---------------------------------------------------------------------------
// 内部调用的受控身份（1.8.7 P1 团队大脑，chain-audit 2026-10-14 #3）
// ---------------------------------------------------------------------------

/// 内部 Sidecar 调用的 Bearer token 解析。
///
/// 复用 CLI 同口径的 `ZHISHI_TOKEN` 环境变量（与 src/cli/remote.ts
/// resolveRemoteToken 同一通道）——token 由 `zhishi auth add` 发放，只进
/// Authorization 头，不打印不落盘。auth.enabled=false 时服务端本就不要求
/// token，不带头则行为与旧版一字节相同；auth 开启而未配置时服务端 401，
/// 调度方日志可见——**不做 localhost 豁免，不绕过路由鉴权**。
///
/// 角色要求：/cron/execute-sync 与 trust/event 需 operator 档，session-state
/// 轮询 readonly 即可——给宿主进程配的内部 token 建议 operator。
pub fn internal_token() -> Option<String> {
    std::env::var("ZHISHI_TOKEN")
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// 给异步请求构建器挂内部身份（有 token 时；无则原样返回）。
pub fn with_internal_auth(req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    match internal_token() {
        Some(token) => req.bearer_auth(token),
        None => req,
    }
}

/// blocking 变体（wake-lock 轮询等同步路径）。
pub fn with_internal_auth_blocking(
    req: reqwest::blocking::RequestBuilder,
) -> reqwest::blocking::RequestBuilder {
    match internal_token() {
        Some(token) => req.bearer_auth(token),
        None => req,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // env 变量是进程级共享状态——串行化本模块测试，防并行用例互相污染。
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn internal_token_unset_or_blank_is_none() {
        let _g = ENV_LOCK.lock().unwrap();
        std::env::remove_var("ZHISHI_TOKEN");
        assert_eq!(internal_token(), None);
        std::env::set_var("ZHISHI_TOKEN", "   ");
        assert_eq!(internal_token(), None);
        std::env::remove_var("ZHISHI_TOKEN");
    }

    #[test]
    fn internal_token_trims_value() {
        let _g = ENV_LOCK.lock().unwrap();
        std::env::set_var("ZHISHI_TOKEN", "  zst_abc  ");
        assert_eq!(internal_token().as_deref(), Some("zst_abc"));
        std::env::remove_var("ZHISHI_TOKEN");
    }

    #[test]
    fn with_internal_auth_attaches_bearer_header() {
        let _g = ENV_LOCK.lock().unwrap();
        std::env::set_var("ZHISHI_TOKEN", "zst_test");
        let client = builder().build().unwrap();
        let req = with_internal_auth(client.get("http://127.0.0.1:1/api/session-state"))
            .build()
            .unwrap();
        assert_eq!(
            req.headers().get("authorization").unwrap(),
            "Bearer zst_test"
        );
        std::env::remove_var("ZHISHI_TOKEN");
    }

    #[test]
    fn with_internal_auth_without_token_leaves_request_untouched() {
        let _g = ENV_LOCK.lock().unwrap();
        std::env::remove_var("ZHISHI_TOKEN");
        let client = builder().build().unwrap();
        let req = with_internal_auth(client.post("http://127.0.0.1:1/cron/execute-sync"))
            .build()
            .unwrap();
        assert!(req.headers().get("authorization").is_none());
    }

    #[test]
    fn with_internal_auth_blocking_attaches_bearer_header() {
        let _g = ENV_LOCK.lock().unwrap();
        std::env::set_var("ZHISHI_TOKEN", "zst_block");
        let client = blocking_builder().build().unwrap();
        let req = with_internal_auth_blocking(client.get("http://127.0.0.1:1/api/session-state"))
            .build()
            .unwrap();
        assert_eq!(
            req.headers().get("authorization").unwrap(),
            "Bearer zst_block"
        );
        std::env::remove_var("ZHISHI_TOKEN");
    }
}
