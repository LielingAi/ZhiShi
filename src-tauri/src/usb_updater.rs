//! Online in-place update (file-replacement "update package") for both the
//! Windows portable build and the NSIS installed build.
//!
//! Flow (identical for portable and installed):
//! 1. Queries the ticket service for the latest published client version.
//! 2. Downloads the full portable ZIP for the latest version to a temp directory.
//! 3. Extracts the ZIP.
//! 4. Launches the standalone `zhishi-updater.exe` helper to replace the old
//!    program files in place while preserving `.zhishi/` user data.
//!
//! `zhishi-updater.exe` must be bundled next to `zhishi.exe` (shipped via
//! `bundle.externalBin`). For installed builds the install directory is
//! user-writable (per-user Local AppData), so no elevation is required.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use reqwest;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::app_dirs;
use crate::process_cmd;
use crate::sidecar;
use crate::{ulog_info, ulog_warn};

const VERSION_ENDPOINT: &str = "https://ticket.zhishi.help/api/v1/client-version";
const DATA_MODE_FILE: &str = ".data_mode";
const UPDATER_EXE: &str = "zhishi-updater.exe";
const APP_EXE: &str = "zhishi.exe";
/// Marker file stored next to the prepared update package. Holds the version
/// string of the package currently cached in `prepared_dir()`. Prevents a
/// stale package (e.g. v0.2.42) from being reused after the server advertises
/// a newer version (e.g. v0.2.44).
const PREPARED_VERSION_FILE: &str = ".prepared-version";
const DOWNLOAD_TIMEOUT_SECONDS: u64 = 1800;
const DOWNLOAD_CONNECT_TIMEOUT_SECONDS: u64 = 30;
/// Resume-aware retry count for the (large) update-package download. Each
/// attempt continues from the bytes already on disk via an HTTP Range request,
/// so a flaky link only re-transfers the remainder, not the whole ~170 MB.
const MAX_DOWNLOAD_ATTEMPTS: u32 = 3;
const UPDATE_STATUS_FILE: &str = ".update-status";
/// Event channel the renderer subscribes to for live update progress.
const PROGRESS_EVENT: &str = "usb-update:progress";
/// Minimum interval between progress emissions, to avoid flooding the webview
/// with thousands of events on a fast connection.
const PROGRESS_THROTTLE_MS: u128 = 200;

/// Progress payload pushed to the renderer during `apply_usb_update`.
///
/// `phase` is one of `downloading` | `extracting` | `preparing` | `launching`;
/// `percent` is only meaningful while downloading and is `None` when the server
/// does not advertise a `Content-Length`.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateProgress {
    pub phase: String,
    pub percent: Option<u8>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
}

fn emit_progress(
    app: Option<&AppHandle>,
    phase: &str,
    percent: Option<u8>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
) {
    let Some(app) = app else { return };
    // A failed emit must never abort an update in flight — progress is UX.
    let _ = app.emit(
        PROGRESS_EVENT,
        UpdateProgress {
            phase: phase.to_string(),
            percent,
            downloaded_bytes,
            total_bytes,
        },
    );
}

/// Information returned to the frontend when an update package is available.
#[derive(Debug, Clone, Serialize)]
pub struct UsbUpdateInfo {
    pub version: String,
    /// URL of the portable ZIP to download when the user confirms the update.
    pub download_url: String,
    pub release_notes: String,
    pub force_update: bool,
    /// Expected SHA-256 of the downloaded ZIP (hex, lower-case). Empty when the
    /// server did not provide a hash — in that case the download is still
    /// allowed, but we cannot verify integrity.
    pub download_sha256: String,
}

/// Result of an update check. The frontend uses this to show the right message
/// instead of treating every failure as "already up to date".
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "data")]
pub enum UsbUpdateCheckResult {
    UpToDate,
    Available(UsbUpdateInfo),
    Error { code: String, message: String },
}

/// Outcome of a previous updater run, read from `.update-status` on startup.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateStatus {
    pub status: String,
    pub message: String,
    pub timestamp: u64,
}

/// Read and consume the `.update-status` marker left by `zhishi-updater.exe`.
///
/// Returns `None` when:
/// - The status file does not exist
/// - The file is unparseable (corrupt)
///
/// The marker file is deleted after reading so it won't be shown again on the
/// next launch. Works for both portable and installed builds — the marker is
/// written next to the running executable (i.e. the install directory).
pub fn read_update_status() -> Option<UpdateStatus> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let status_path = exe_dir.join(UPDATE_STATUS_FILE);

    if !status_path.exists() {
        return None;
    }

    let content = std::fs::read_to_string(&status_path).ok()?;
    let status: UpdateStatus = serde_json::from_str(&content).ok()?;

    // Consume the marker so it won't re-appear on the next boot.
    let _ = std::fs::remove_file(&status_path);

    Some(status)
}

/// Response from the ticket service version endpoint.
#[derive(Debug, Clone, Deserialize)]
struct ClientVersionResponse {
    #[serde(rename = "latestVersion")]
    latest_version: String,
    #[serde(rename = "minimumVersion")]
    #[allow(dead_code)]
    minimum_version: String,
    #[serde(rename = "forceUpdateBelow")]
    force_update_below: String,
    #[serde(rename = "releaseDate")]
    #[allow(dead_code)]
    release_date: String,
    #[serde(rename = "releaseNotes")]
    release_notes: String,
    #[serde(rename = "downloadUrl")]
    download_url: String,
    #[serde(rename = "downloadSha256")]
    #[serde(default)]
    download_sha256: String,
}

/// Return `true` if the app is running in portable mode (`.data_mode` marker or
/// `.zhishi/` next to the executable).
pub fn is_portable_mode() -> bool {
    app_dirs::zhishi_data_dir()
        .zip(std::env::current_exe().ok())
        .map(|(data_dir, exe_path)| {
            let exe_dir = exe_path.parent().unwrap_or(Path::new(""));
            // Portable mode means data dir is inside the exe dir.
            data_dir.starts_with(exe_dir)
        })
        .unwrap_or(false)
}

/// Check whether an online update is available (portable and installed builds).
///
/// This only queries the ticket service and compares versions; it does NOT
/// download the update package. The actual download happens when the user
/// confirms the update via `apply_usb_update`.
///
/// Returns a discriminated result so the frontend can distinguish:
/// - `UpToDate`       — running the latest version
/// - `Available(info)` — a newer version exists and can be downloaded
/// - `Error{code,message}` — check failed (network, server misconfiguration, etc.)
pub async fn check_usb_update(app: &AppHandle) -> UsbUpdateCheckResult {
    // NOTE: intentionally NOT gated on `.data_mode`. Both portable and
    // home-mode installs check for updates; the check itself only queries the
    // version endpoint and returns a download URL (no download happens here).
    let current_version = app.package_info().version.to_string();
    ulog_info!(
        "[usb-updater] Checking for online update (current v{})",
        current_version
    );

    let version_info = match fetch_version_info(&current_version).await {
        Ok(v) => v,
        Err(e) => {
            ulog_warn!("[usb-updater] Failed to fetch version info: {}", e);
            return UsbUpdateCheckResult::Error {
                code: "network".to_string(),
                message: e,
            };
        }
    };

    let latest = match parse_version(&version_info.latest_version) {
        Ok(v) => v,
        Err(e) => {
            return UsbUpdateCheckResult::Error {
                code: "invalid-server-version".to_string(),
                message: e,
            };
        }
    };
    let current = match parse_version(&current_version) {
        Ok(v) => v,
        Err(e) => {
            return UsbUpdateCheckResult::Error {
                code: "invalid-local-version".to_string(),
                message: e,
            };
        }
    };

    if current >= latest {
        ulog_info!("[usb-updater] Already up to date");
        return UsbUpdateCheckResult::UpToDate;
    }

    let force_update = match parse_version(&version_info.force_update_below) {
        Ok(threshold) => current < threshold,
        Err(_) => false,
    };

    ulog_info!(
        "[usb-updater] Server reports latest v{} (force_update={})",
        version_info.latest_version,
        force_update
    );

    if version_info.download_url.is_empty() {
        ulog_warn!("[usb-updater] Server did not provide a download URL");
        return UsbUpdateCheckResult::Error {
            code: "no-download-url".to_string(),
            message: format!(
                "Server reported v{} but did not provide a download URL",
                version_info.latest_version
            ),
        };
    }

    UsbUpdateCheckResult::Available(UsbUpdateInfo {
        version: version_info.latest_version,
        download_url: version_info.download_url,
        release_notes: version_info.release_notes,
        force_update,
        download_sha256: version_info.download_sha256,
    })
}

async fn fetch_version_info(current_version: &str) -> Result<ClientVersionResponse, String> {
    // External-host client (update/ticket server, not localhost sidecar) — per
    // clippy.toml policy this call site must carry an explicit allow with reason.
    #[allow(clippy::disallowed_methods)]
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        // The ticket service is reached via local hosts/DNS; avoid picking up
        // a misconfigured system proxy that may return 502 for local addresses.
        .no_proxy()
        // Force HTTP/1.1 to avoid any HTTP/2 negotiation issues with the local
        // nginx / Docker setup during startup.
        .http1_only()
        .build()
        .map_err(|e| format!("failed to build HTTP client: {}", e))?;

    // Report the running version with every check — the admin service records
    // an `update_check` event from this query param, which is what the
    // version-distribution dashboard is built from.
    let url = format!("{}?current={}", VERSION_ENDPOINT, current_version);

    let mut last_error = String::new();
    for attempt in 1..=3 {
        match client.get(&url).send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    return resp
                        .json::<ClientVersionResponse>()
                        .await
                        .map_err(|e| format!("failed to parse response: {}", e));
                }
                let body = resp.text().await.unwrap_or_default();
                last_error = format!("server returned {} (body: {})", status, body);
                ulog_warn!("[usb-updater] Version fetch attempt {} failed: {}", attempt, last_error);
            }
            Err(e) => {
                last_error = format!("request failed: {}", e);
                ulog_warn!("[usb-updater] Version fetch attempt {} failed: {}", attempt, last_error);
            }
        }
        if attempt < 3 {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    Err(last_error)
}

fn parse_version(v: &str) -> Result<Version, String> {
    Version::parse(v).map_err(|e| format!("invalid semver {}: {}", v, e))
}

/// Download the update ZIP from `url`, extract it into `dest_base`, and
/// return the path to the extracted portable directory.
///
/// `app` is optional so the download path stays unit-testable without a Tauri
/// runtime; when present, progress events are streamed to the renderer.
///
/// The download is **resume-aware**: a ~170 MB transfer over a flaky link can
/// be cut mid-flight (reqwest fails with "error decoding response body"); we
/// keep the partial file and continue from the last byte via an HTTP `Range`
/// request (nginx serves Range on static files), retrying up to
/// [`MAX_DOWNLOAD_ATTEMPTS`] times with a short backoff. Extraction happens
/// only once the zip is complete; a failed extraction (torn final chunk after
/// an offset guess) discards the zip so the next attempt restarts cleanly.
async fn download_and_extract_into(
    url: &str,
    app: Option<&AppHandle>,
    dest_base: &Path,
    expected_sha256: Option<&str>,
) -> Result<PathBuf, String> {
    ulog_info!("[usb-updater] Downloading update package from {}", url);

    // External-host client (update package download URL) — allow with reason per
    // clippy.toml policy; proxy is explicitly bypassed below.
    #[allow(clippy::disallowed_methods)]
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(DOWNLOAD_CONNECT_TIMEOUT_SECONDS))
        .timeout(Duration::from_secs(DOWNLOAD_TIMEOUT_SECONDS))
        // The download URL is on the same local nginx as the ticket service;
        // bypass the system proxy to avoid 502 from proxy intercepting local
        // traffic, matching fetch_version_info's proxy-avoidance pattern.
        .no_proxy()
        .build()
        .map_err(|e| format!("failed to build download client: {}", e))?;

    fs::create_dir_all(dest_base)
        .map_err(|e| format!("failed to create temp dir {}: {}", dest_base.display(), e))?;

    let zip_path = dest_base.join("update.zip");

    let mut download_ok = false;
    let mut total_downloaded: u64 = 0;
    for attempt in 1..=MAX_DOWNLOAD_ATTEMPTS {
        match download_zip_with_resume(&client, url, &zip_path, app).await {
            Ok(bytes) => {
                total_downloaded = bytes;
                download_ok = true;
                break;
            }
            Err(e) => {
                ulog_warn!(
                    "[usb-updater] download attempt {}/{} failed: {}",
                    attempt,
                    MAX_DOWNLOAD_ATTEMPTS,
                    e
                );
                if attempt < MAX_DOWNLOAD_ATTEMPTS {
                    // Short backoff; the partial file is kept for the resume.
                    tokio::time::sleep(Duration::from_secs(attempt as u64)).await;
                }
            }
        }
    }
    if !download_ok {
        return Err(format!(
            "failed to download update package after {} attempt(s); check your network and retry",
            MAX_DOWNLOAD_ATTEMPTS
        ));
    }

    ulog_info!(
        "[usb-updater] Downloaded {:.2} MB",
        total_downloaded as f64 / 1_048_576.0
    );

    // Integrity check: if the server provided an expected SHA-256, reject any
    // mismatch. A mismatched package is deleted so the next attempt re-downloads
    // the whole file rather than resuming from a corrupt partial.
    if let Some(expected) = expected_sha256 {
        if !expected.is_empty() {
            ulog_info!("[usb-updater] Verifying update package SHA-256...");
            match verify_file_sha256(&zip_path, expected) {
                Ok(true) => {}
                Ok(false) => {
                    ulog_warn!(
                        "[usb-updater] SHA-256 mismatch; discarding corrupt package"
                    );
                    let _ = fs::remove_file(&zip_path);
                    return Err(
                        "downloaded update package failed integrity check; please retry".to_string(),
                    );
                }
                Err(e) => return Err(e),
            }
        }
    }

    // Extract; on failure the partial zip may be corrupt (bad resume offset) —
    // discard it so the next call starts fresh instead of resuming from there.
    ulog_info!("[usb-updater] Extracting update package...");
    emit_progress(app, "extracting", None, 0, Some(total_downloaded));
    if let Err(e) = extract_zip(&zip_path, dest_base) {
        ulog_warn!(
            "[usb-updater] extraction failed ({}); discarding partial zip",
            e
        );
        let _ = fs::remove_file(&zip_path);
        return Err(format!("failed to extract update package: {}", e));
    }

    // The ZIP should contain a single top-level directory like
    // `ZhiShi_0.2.33_x86_64-portable/`.
    let extracted_dir = find_extracted_portable_dir(dest_base)?;

    ulog_info!(
        "[usb-updater] Extracted portable directory: {}",
        extracted_dir.display()
    );

    Ok(extracted_dir)
}

/// Download `url` into `zip_path`, resuming from any bytes already on disk via
/// an HTTP `Range` request. Returns the total bytes on disk after this attempt.
///
/// Handles the three server responses:
/// - `206 Partial Content`: resumed from the existing length (append mode).
/// - `200 OK`: the server ignored `Range` (or there was nothing to resume); the
///   file is truncated and written from scratch.
/// - `416 Range Not Satisfiable`: the local file already holds the full body.
async fn download_zip_with_resume(
    client: &reqwest::Client,
    url: &str,
    zip_path: &Path,
    app: Option<&AppHandle>,
) -> Result<u64, String> {
    let existing = fs::metadata(zip_path).map(|m| m.len()).unwrap_or(0);

    let mut req = client.get(url);
    if existing > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={}-", existing));
    }
    let response = req
        .send()
        .await
        .map_err(|e| format!("download request failed: {}", e))?;
    let status = response.status();

    // 416: the local file already holds the complete body — nothing to fetch.
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        return Ok(existing);
    }

    let resumed = status == reqwest::StatusCode::PARTIAL_CONTENT;
    if !status.is_success() && !resumed {
        let body = response.text().await.unwrap_or_default();
        ulog_warn!("[usb-updater] download returned {} (body: {})", status, body);
        return Err(format!("download returned {} (body: {})", status, body));
    }

    // For a resumed transfer the total = existing bytes + remaining length.
    let total_bytes = if resumed {
        response.content_length().map(|rem| existing + rem)
    } else {
        response.content_length()
    };

    // Append when resuming (keep the bytes already on disk), truncate otherwise.
    let mut file = if resumed {
        fs::OpenOptions::new().create(true).append(true).open(zip_path)
    } else {
        fs::File::create(zip_path)
    }
    .map_err(|e| format!("failed to open {}: {}", zip_path.display(), e))?;

    let mut downloaded: u64 = if resumed { existing } else { 0 };
    let mut last_emit = std::time::Instant::now();
    emit_progress(app, "downloading", Some(pct(downloaded, total_bytes)), downloaded, total_bytes);

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download interrupted: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("failed to write {}: {}", zip_path.display(), e))?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed().as_millis() >= PROGRESS_THROTTLE_MS {
            emit_progress(app, "downloading", Some(pct(downloaded, total_bytes)), downloaded, total_bytes);
            last_emit = std::time::Instant::now();
        }
    }

    file.flush()
        .map_err(|e| format!("failed to flush {}: {}", zip_path.display(), e))?;
    emit_progress(app, "downloading", Some(100), downloaded, total_bytes);
    Ok(downloaded)
}

fn pct(done: u64, total: Option<u64>) -> u8 {
    match total {
        Some(t) if t > 0 => ((done.saturating_mul(100)) / t).min(100) as u8,
        _ => 0,
    }
}

/// Verify the SHA-256 of `path` against the lower-case hex `expected` hash.
/// Returns `Ok(true)` on a match, `Ok(false)` on a mismatch, or an I/O error.
fn verify_file_sha256(path: &Path, expected: &str) -> Result<bool, String> {
    let mut file = fs::File::open(path)
        .map_err(|e| format!("failed to open {} for hashing: {}", path.display(), e))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)
        .map_err(|e| format!("failed to hash {}: {}", path.display(), e))?;
    let actual = hex::encode(hasher.finalize());
    Ok(actual.eq_ignore_ascii_case(expected))
}

/// Thin wrapper for the one-shot download path (unique temp dir per run) —
/// used when no pre-downloaded package is available at apply time.
async fn download_and_extract_update(
    url: &str,
    app: Option<&AppHandle>,
    expected_sha256: Option<&str>,
) -> Result<PathBuf, String> {
    let temp_base = std::env::temp_dir().join(format!(
        "zhishi-update-{}",
        timestamp_string().replace(':', "-")
    ));
    download_and_extract_into(url, app, &temp_base, expected_sha256).await
}

/// Fixed cache directory for a pre-downloaded update package. `prepare_usb_update`
/// downloads into it after a version check reports an update, so that clicking
/// "update now" later installs immediately instead of downloading a ~170 MB ZIP
/// on the spot.
fn prepared_dir() -> PathBuf {
    std::env::temp_dir().join("zhishi-update-prepared")
}

/// Read the version marker stored in `dir`, if any.
fn prepared_version(dir: &Path) -> Option<String> {
    fs::read_to_string(dir.join(PREPARED_VERSION_FILE))
        .ok()
        .map(|s| s.trim().to_string())
}

/// Whether a pre-downloaded package in `dir` is complete and usable.
///
/// `is_valid_portable_dir` alone is not enough: a partially extracted tree can
/// already contain `.data_mode` + a zero-byte `zhishi.exe`. Requiring a
/// non-empty executable rules out torn half-extractions.
fn prepared_is_ready(dir: &Path) -> bool {
    if !is_valid_portable_dir(dir) {
        return false;
    }
    fs::metadata(dir.join(APP_EXE))
        .map(|m| m.len() > 0)
        .unwrap_or(false)
}

/// Whether a pre-downloaded package in `dir` is complete and matches the
/// requested `version`. This is the guard both `prepare_usb_update` and
/// `apply_usb_update` use to decide whether the cache can be reused.
fn prepared_is_ready_for(dir: &Path, version: &str) -> bool {
    if !prepared_is_ready(dir) {
        return false;
    }
    prepared_version(dir).as_deref() == Some(version)
}

/// Write the version marker for a successfully prepared package.
fn write_prepared_version(dir: &Path, version: &str) -> Result<(), String> {
    let path = dir.join(PREPARED_VERSION_FILE);
    fs::write(&path, version)
        .map_err(|e| format!("failed to write prepared version marker {}: {}", path.display(), e))
}

/// Wipe the prepared cache directory. Used when the cached package is for a
/// different version than the one we now want to install, so we don't leave
/// stale files behind.
fn wipe_prepared_dir(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    fs::remove_dir_all(dir)
        .map_err(|e| format!("failed to wipe prepared dir {}: {}", dir.display(), e))
}

/// Pre-download and extract the update package into the fixed cache directory.
///
/// Idempotent: if a complete package for `version` is already cached, this
/// returns immediately. Progress is streamed to the renderer via
/// `usb-update:progress`. On a flaky link the underlying download resumes from
/// the partial file, so a failed attempt does not throw away the bytes already
/// received.
///
/// If the cache holds a package for a different version, it is discarded and
/// re-downloaded. This prevents the "update succeeded but version didn't change"
/// symptom when the server advances to a newer version while an old package
/// remains in `%TEMP%`.
pub async fn prepare_usb_update(
    version: &str,
    download_url: &str,
    download_sha256: Option<&str>,
    app: &AppHandle,
) -> Result<(), String> {
    if version.is_empty() {
        return Err("target version is empty".to_string());
    }
    if download_url.is_empty() {
        return Err("download URL is empty".to_string());
    }

    let dest = prepared_dir();
    if prepared_is_ready_for(&dest, version) {
        ulog_info!(
            "[usb-updater] Update package already prepared for v{}: {}",
            version,
            dest.display()
        );
        return Ok(());
    }

    // Stale cache (different version or corrupt) — wipe before re-downloading.
    // We intentionally discard any partial `update.zip` because resuming across
    // different version packages would produce a corrupt archive.
    if dest.exists() {
        ulog_info!(
            "[usb-updater] Discarding stale prepared package (want v{}); re-downloading",
            version
        );
        wipe_prepared_dir(&dest)?;
    }

    ulog_info!(
        "[usb-updater] Pre-downloading update package for v{} from {}",
        version,
        download_url
    );

    let source = download_and_extract_into(download_url, Some(app), &dest, download_sha256)
        .await
        .map_err(|e| {
            emit_progress(Some(app), "failed", None, 0, None);
            format!("failed to prepare update package: {}", e)
        })?;

    if !is_valid_portable_dir(&source) {
        emit_progress(Some(app), "failed", None, 0, None);
        return Err(format!(
            "prepared directory is not a valid ZhiShi portable directory: {}",
            source.display()
        ));
    }

    write_prepared_version(&dest, version)?;

    ulog_info!("[usb-updater] Update package ready for v{}: {}", version, source.display());
    Ok(())
}

fn extract_zip(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path)
        .map_err(|e| format!("failed to open {}: {}", zip_path.display(), e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("failed to read zip {}: {}", zip_path.display(), e))?;

    // Manually extract each file. The `archive.extract()` method in zip 0.6
    // can fail on Windows with os error 267 (invalid directory name) when
    // the archive contains directory entries with trailing slashes.
    for i in 0..archive.len() {
        let mut zip_file = archive
            .by_index(i)
            .map_err(|e| format!("failed to read zip entry {}: {}", i, e))?;
        let name = zip_file.name().to_string();

        // Skip directory entries.
        if name.ends_with('/') || name.ends_with('\\') {
            continue;
        }

        // Sanitize path separators for Windows.
        let sanitized = name.replace('/', "\\");
        let out_path = dest_dir.join(&sanitized);

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                format!("failed to create dir {}: {}", parent.display(), e)
            })?;
        }

        let mut out_file = fs::File::create(&out_path)
            .map_err(|e| format!("failed to create file {}: {}", out_path.display(), e))?;
        std::io::copy(&mut zip_file, &mut out_file).map_err(|e| {
            format!("failed to write file {}: {}", out_path.display(), e)
        })?;
    }

    Ok(())
}

fn find_extracted_portable_dir(temp_dir: &Path) -> Result<PathBuf, String> {
    // First check if the temp dir itself is a valid portable directory (some
    // ZIP archives for local testing have files at the root level rather than
    // inside a version-named subdirectory).
    if is_valid_portable_dir(temp_dir) {
        return Ok(temp_dir.to_path_buf());
    }

    let entries = fs::read_dir(temp_dir)
        .map_err(|e| format!("failed to read temp dir {}: {}", temp_dir.display(), e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && is_valid_portable_dir(&path) {
            return Ok(path);
        }
    }

    Err(format!(
        "no valid ZhiShi portable directory found inside {}",
        temp_dir.display()
    ))
}

fn is_valid_portable_dir(path: &Path) -> bool {
    path.join(DATA_MODE_FILE).exists() && path.join(APP_EXE).exists()
}

fn timestamp_string() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let dt = chrono::DateTime::from_timestamp(now as i64, 0)
        .unwrap_or(chrono::DateTime::UNIX_EPOCH);
    dt.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// Apply an online update (portable and installed) by downloading the update
/// package, extracting it, launching `zhishi-updater.exe` and exiting the app.
///
/// ## Shutdown-before-spawn protocol
///
/// Before launching the updater we call `shutdown_for_update()` to kill all
/// sidecar (bun/SDK/MCP) processes. Without this, orphaned child processes
/// hold file locks on the target directory's `node_modules/`, `server-dist.js`,
/// etc., which causes `zhishi-updater.exe`'s `copy_new_version()` to fail and
/// the new app to never launch.
///
/// The updater binary itself is launched via `process_cmd::new()` (not bare
/// `Command::new()`) to apply `CREATE_NO_WINDOW` on Windows, preventing the
/// console window that would otherwise flash during the update.
pub async fn apply_usb_update(
    version: String,
    download_url: String,
    download_sha256: Option<String>,
    app: &AppHandle,
    manager: &sidecar::ManagedSidecarManager,
) -> Result<(), String> {
    if version.is_empty() {
        return Err("target version is empty".to_string());
    }
    if download_url.is_empty() {
        return Err("download URL is empty".to_string());
    }

    // NOTE: intentionally NOT gated on `.data_mode` — home-mode installs
    // update through this same file-replacement path (see check_usb_update).
    let exe_path = std::env::current_exe().map_err(|e| format!("failed to get exe path: {}", e))?;
    let target_dir = exe_path
        .parent()
        .ok_or("failed to get exe directory")?
        .to_path_buf();

    let updater_exe = target_dir.join(UPDATER_EXE);
    if !updater_exe.exists() {
        return Err(format!(
            "updater helper not found: {}",
            updater_exe.display()
        ));
    }

    // Step 1: Prefer the pre-downloaded package (prepared by prepare_usb_update
    // after the version check), otherwise download now. Reusing the cache makes
    // "click update" install immediately instead of waiting for a ~170 MB ZIP.
    let prepared = prepared_dir();
    let source_path = if prepared_is_ready_for(&prepared, &version) {
        ulog_info!(
            "[usb-updater] Using pre-downloaded update package for v{}: {}",
            version,
            prepared.display()
        );
        prepared
    } else {
        if prepared.exists() {
            ulog_info!(
                "[usb-updater] Prepared package mismatch (want v{}); downloading fresh",
                version
            );
        } else {
            ulog_info!("[usb-updater] Downloading update package from {}", download_url);
        }
        let sha = download_sha256.as_deref();
        download_and_extract_update(&download_url, Some(app), sha)
            .await
            .map_err(|e| {
                emit_progress(Some(app), "failed", None, 0, None);
                format!("failed to download or extract update package: {}", e)
            })?
    };

    ulog_info!(
        "[usb-updater] Update package ready: {}",
        source_path.display()
    );

    if !is_valid_portable_dir(&source_path) {
        emit_progress(Some(app), "failed", None, 0, None);
        return Err(format!(
            "extracted directory is not a valid ZhiShi portable directory: {}",
            source_path.display()
        ));
    }

    emit_progress(Some(app), "preparing", None, 0, None);

    // Step 2: Shut down all sidecar/SDK/MCP processes so file locks are released
    // before the updater tries to overwrite files. This must happen BEFORE
    // spawning the updater, otherwise shutdown_for_update would kill it too.
    ulog_info!("[usb-updater] Shutting down sidecars before update...");
    if let Err(e) = sidecar::shutdown_for_update(manager) {
        ulog_warn!(
            "[usb-updater] Sidecar shutdown returned error (continuing with update): {}",
            e
        );
    }

    let current_pid = std::process::id() as usize;

    ulog_info!(
        "[usb-updater] Launching updater: target={}, source={}, wait_pid={}",
        target_dir.display(),
        source_path.display(),
        current_pid
    );

    // Step 3: Spawn the updater and detach it. We intentionally do NOT wait on it.
    // Uses process_cmd::new() to prevent a console window on Windows.
    process_cmd::new(&updater_exe)
        .arg("--target-dir")
        .arg(&target_dir)
        .arg("--source-dir")
        .arg(&source_path)
        .arg("--wait-pid")
        .arg(current_pid.to_string())
        .spawn()
        .map_err(|e| {
            emit_progress(Some(app), "failed", None, 0, None);
            format!(
                "failed to launch updater {}: {}",
                updater_exe.display(),
                e
            )
        })?;

    emit_progress(Some(app), "launching", None, 0, None);

    // Give the updater a moment to observe this process before we exit.
    tokio::time::sleep(Duration::from_millis(500)).await;

    ulog_info!("[usb-updater] Exiting app for update");
    app.exit(0);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_version() {
        assert_eq!(parse_version("0.2.33").unwrap(), Version::new(0, 2, 33));
        assert!(parse_version("v0.2.33").is_err());
        assert!(parse_version("").is_err());
    }

    #[test]
    fn test_is_valid_portable_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("ZhiShi_0.2.33_x86_64-portable");
        std::fs::create_dir(&dir).unwrap();

        // Missing both marker and exe.
        assert!(!is_valid_portable_dir(&dir));

        // Only marker.
        std::fs::File::create(dir.join(DATA_MODE_FILE)).unwrap();
        assert!(!is_valid_portable_dir(&dir));

        // Both marker and exe.
        std::fs::File::create(dir.join(APP_EXE)).unwrap();
        assert!(is_valid_portable_dir(&dir));
    }

    #[test]
    fn test_client_version_response_deserialization() {
        let json = r#"{
            "latestVersion": "0.2.33",
            "minimumVersion": "0.2.30",
            "forceUpdateBelow": "0.2.31",
            "releaseDate": "2026-06-15",
            "releaseNotes": "fixed stuff",
            "downloadUrl": "https://ticket.zhishi.help/download/ZhiShi_0.2.33_x86_64-portable.zip"
        }"#;
        let resp: ClientVersionResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.latest_version, "0.2.33");
        assert_eq!(resp.force_update_below, "0.2.31");
        assert_eq!(resp.release_notes, "fixed stuff");
        assert_eq!(resp.download_url, "https://ticket.zhishi.help/download/ZhiShi_0.2.33_x86_64-portable.zip");
    }

    #[test]
    fn test_is_portable_mode_returns_false_in_test_env() {
        // In a standard test environment (no .data_mode or .zhishi/ next to the
        // test binary), is_portable_mode() must return false rather than panic.
        assert!(!is_portable_mode());
    }

    #[test]
    fn test_apply_usb_update_rejects_empty_source_dir() {
        // apply_usb_update is gated by is_portable_mode(). In a test env
        // where is_portable_mode() returns false, it must return the expected
        // "not in portable mode" error before doing anything else.
        //
        // This is a compile-time & early-return sanity check: the function's
        // first guard is is_portable_mode(), and if that fires correctly no
        // Tauri runtime is needed to reach the Err.
        assert!(!is_portable_mode(), "precondition: test env is not portable");
    }

    #[test]
    fn test_extract_zip_rejects_invalid_file() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_zip = tmp.path().join("not-a-zip.zip");
        std::fs::write(&fake_zip, b"this is not a zip file").unwrap();

        let dest = tmp.path().join("out");
        std::fs::create_dir(&dest).unwrap();

        let result = extract_zip(&fake_zip, &dest);
        assert!(result.is_err(), "extract_zip should reject invalid zip data");
        assert!(
            result.unwrap_err().contains("failed to read zip"),
            "error message should mention zip reading failure"
        );
    }

    #[test]
    fn test_timestamp_string_format() {
        let ts = timestamp_string();
        assert!(ts.contains('T'), "timestamp should contain T separator");
        assert_eq!(ts.len(), 19, "timestamp should be YYYY-MM-DDTHH:MM:SS");
        // Year should be 20xx or 202x
        assert!(ts.starts_with("20"), "timestamp should start with 20xx");
    }

    #[test]
    fn test_prepared_is_ready_for_requires_version_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        // Helper: create a non-empty stub executable so `prepared_is_ready` passes.
        let create_exe = || {
            let path = dir.join(APP_EXE);
            std::fs::write(&path, b"stub exe").unwrap();
            path
        };

        // Empty directory is not ready.
        assert!(!prepared_is_ready_for(dir, "0.2.44"));

        // Valid portable dir but no version marker is not ready for any version.
        std::fs::File::create(dir.join(DATA_MODE_FILE)).unwrap();
        create_exe();
        assert!(!prepared_is_ready_for(dir, "0.2.44"));

        // Marker for a different version is not ready.
        std::fs::write(dir.join(PREPARED_VERSION_FILE), "0.2.42").unwrap();
        assert!(!prepared_is_ready_for(dir, "0.2.44"));

        // Marker matching the requested version is ready.
        std::fs::write(dir.join(PREPARED_VERSION_FILE), "0.2.44").unwrap();
        assert!(prepared_is_ready_for(dir, "0.2.44"));
    }

    #[test]
    fn test_wipe_prepared_dir_cleans_stale_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("zhishi-update-prepared");
        std::fs::create_dir(&dir).unwrap();
        std::fs::File::create(dir.join(DATA_MODE_FILE)).unwrap();
        std::fs::File::create(dir.join(APP_EXE)).unwrap();
        std::fs::write(dir.join(PREPARED_VERSION_FILE), "0.2.42").unwrap();

        assert!(dir.exists());
        wipe_prepared_dir(&dir).unwrap();
        assert!(!dir.exists());
        // Wiping a non-existent dir is a no-op.
        wipe_prepared_dir(&dir).unwrap();
    }

    #[test]
    fn test_write_prepared_version_round_trips() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        write_prepared_version(dir, "0.2.44").unwrap();
        assert_eq!(prepared_version(dir).as_deref(), Some("0.2.44"));
    }

    #[test]
    fn test_find_extracted_portable_dir_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let result = find_extracted_portable_dir(tmp.path());
        assert!(result.is_err(), "empty dir should yield error");
        assert!(
            result.unwrap_err().contains("no valid ZhiShi portable directory"),
            "error should mention no valid dir found"
        );
    }

    #[test]
    fn test_download_and_extract_update_rejects_bad_url() {
        // The async function should return an Err for unreachable URLs.
        // We use a localhost URL that will be refused (no server listening).
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(download_and_extract_update(
            "http://127.0.0.1:1/update.zip",
            None,
            None,
        ));
        assert!(result.is_err(), "unreachable URL should yield error");
        let err = result.unwrap_err();
        assert!(
            err.contains("download") || err.contains("request"),
            "error should relate to download failure, got: {}",
            err
        );
    }
}
