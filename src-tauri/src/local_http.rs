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
