// OS notification with reliable click-to-foreground + tab deep-link.
//
// Architectural rationale (see CLAUDE.md "结构保证优于流程约束"):
//
// `tauri-plugin-notification` on desktop is fire-and-forget — its JS shim
// replaces `window.Notification` with a pure invoke proxy that returns no
// handle, and its desktop backend (`notify-rust`) doesn't surface any click
// callback. Relying on `window.onFocusChanged` to detect "user clicked toast"
// works on macOS by accident (OS auto-activates the app) but silently fails
// on Windows — toast clicks go through WinRT's in-process Activated event,
// not a fresh process spawn, so single-instance and focus-changed handlers
// never fire.
//
// This module owns the OS notification surface end-to-end with **two
// platform-exclusive paths** that don't share state:
//
//   ┌──────────────┬─────────────────────────────────────────────────────┐
//   │ Windows      │ `tauri-winrt-notification::Toast::on_activated`     │
//   │              │ closure captures `tab_id` directly. No global       │
//   │              │ queue, no focus-edge consumption. The click handler │
//   │              │ is in-process and deterministic.                    │
//   ├──────────────┼─────────────────────────────────────────────────────┤
//   │ macOS/Linux  │ Three-state global latch                            │
//   │              │ (Empty/Single/Ambiguous). `Single` is consumed when │
//   │              │ the front-end signals window-activation; `Ambiguous`│
//   │              │ (≥2 unconsumed notifications stacked up) raises the │
//   │              │ window but **refuses to deep-link** — wrong-tab     │
//   │              │ navigation is a worse UX than no-deep-link.         │
//   └──────────────┴─────────────────────────────────────────────────────┘
//
// What this REPLACES:
//   - `pendingNavigation` Map + 2-second time window in
//     `notificationService.ts` (fragile; could miss clicks past the window).
//   - `wasHidden` closure flag in `useTrayEvents.ts` (broke when user wasn't
//     minimized to tray — alt-tab away then click toast).
//   - `notification:show` Tauri event hop (Rust → JS → plugin-notification);
//     now Rust calls plugin-notification directly via builder API.
//
// Why mutually exclusive paths matter (review-time finding): an earlier
// draft populated the global latch on Windows too "as a fallback". That
// caused a double-emit bug — the WinRT closure emitted `notification:click`
// directly, then `onFocusChanged(true)` invoked `cmd_consume_notification_click`
// which drained the same entry and emitted a *second* identical event. The
// strict cfg-split below makes the bug structurally unrepresentable.

// `Mutex` / `Duration` / `Instant` only feed the non-Windows fallback
// click-latch path below. Windows uses the WinRT `on_activated` closure
// which captures per-toast state synchronously and needs none of these.
#[cfg(not(target_os = "windows"))]
use std::sync::Mutex;
#[cfg(not(target_os = "windows"))]
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};
// `NotificationExt` powers `show_via_plugin` (the macOS / Linux toast
// path). Windows goes through `tauri_winrt_notification::Toast` directly.
#[cfg(not(target_os = "windows"))]
use tauri_plugin_notification::NotificationExt;

use crate::utils::bom::strip_bom;
use crate::{ulog_debug, ulog_info, ulog_warn};
#[cfg(target_os = "windows")]
use crate::ulog_error;

/// How long an unconsumed deep-link target stays valid on macOS / Linux.
///
/// Only relevant for the non-Windows fallback path. Windows consumes
/// synchronously inside the WinRT `on_activated` callback, so this constant
/// is unused there.
///
/// 30 seconds bounds "user notices toast → finishes current task → clicks"
/// without letting truly stale entries linger.
#[cfg(not(target_os = "windows"))]
const PENDING_CLICK_TTL: Duration = Duration::from_secs(30);

#[cfg(not(target_os = "windows"))]
struct PendingClick {
    tab_id: String,
    queued_at: Instant,
}

/// Three-state latch for the macOS/Linux fallback path.
///
/// `Ambiguous` is the load-bearing piece: when two notifications stack up
/// without an intervening focus-regain, we can't tell *which* one the user
/// clicked, so we refuse to deep-link. The user still gets the window raised
/// (`notification:click` is simply not emitted), which is the no-data-loss
/// degradation.
#[cfg(not(target_os = "windows"))]
enum PendingState {
    Empty,
    Single(PendingClick),
    /// Two-or-more notifications stacked unconsumed. Tracked timestamp is
    /// the *earliest* queue entry's `queued_at` so TTL still expires the
    /// state.
    Ambiguous { queued_at: Instant },
}

#[cfg(not(target_os = "windows"))]
static PENDING_CLICK: Mutex<PendingState> = Mutex::new(PendingState::Empty);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationClickPayload {
    pub tab_id: String,
}

/// Send an OS notification.
///
/// `tab_id` (when supplied) is the deep-link target consumed when the user
/// clicks the notification. The renderer listens on the `notification:click`
/// Tauri event and routes to that tab via the existing `handleSelectTab`
/// pipeline.
///
/// Sound is gated by the `notificationSound` user preference, read disk-first
/// from `~/.zhishi/config.json` (defaults to enabled if missing). The
/// preference flows through to the platform-specific sound API:
///   - Windows: `Toast::sound(None)` for silent, `Sound::Default` for default.
///   - macOS: `NSUserNotificationDefaultSoundName` (default mac chime).
///   - Linux: `message-new-instant` (XDG sound theme; widely supported).
///
/// Best-effort: any OS-level failure is logged but never propagated to the
/// caller — a silent notification is strictly better than failing the cron
/// task / chat turn that triggered it.
pub fn show_with_navigation<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    tab_id: Option<String>,
) {
    let prefs = read_notification_prefs();
    if !prefs.os_notifications {
        ulog_debug!(
            "[Notification] Suppressed by user preference (osNotifications=false): title='{}'",
            title
        );
        return;
    }
    let silent = !prefs.notification_sound;
    ulog_debug!(
        "[Notification] Showing toast title='{}' tab_id={:?} silent={}",
        title,
        tab_id,
        silent
    );

    #[cfg(target_os = "windows")]
    {
        // Pure closure-capture path — no global state, no consumer command.
        if let Err(e) = show_windows_toast(app, title, body, tab_id, silent) {
            ulog_error!(
                "[Notification] WinRT toast rendering failed entirely: {}. \
                 Notification will not be displayed; click activation \
                 unavailable. Likely cause: AUMID mismatch or missing \
                 Start Menu shortcut.",
                e
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Render first; only stash on success. Stashing eagerly would let
        // failed renders pollute the latch for 30s.
        if let Err(e) = show_via_plugin(app, title, body, silent) {
            ulog_warn!("[Notification] plugin-notification show failed: {}", e);
            return;
        }
        if let Some(id) = tab_id {
            queue_pending_click(id);
        }
    }
}

/// Render via the cross-platform `tauri-plugin-notification` builder API.
///
/// `plugin-notification`'s desktop backend (`notify-rust`) routes the `sound`
/// field through to `mac-notification-sys` on macOS and the freedesktop
/// notification spec's `sound-name` hint on Linux. Not calling `.sound()` at
/// all on these platforms means notify-rust never sets the sound key, which
/// produces a *silent* notification — that's why the silent path takes the
/// no-op branch and the audible path needs an explicit name.
#[cfg(not(target_os = "windows"))]
fn show_via_plugin<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    silent: bool,
) -> tauri_plugin_notification::Result<()> {
    let mut builder = app.notification().builder().title(title).body(body);
    if !silent {
        if let Some(sound_name) = default_sound_name() {
            builder = builder.sound(sound_name);
        }
    }
    builder.show()
}

/// Per-platform default sound identifier passed to `notify-rust`.
///
/// macOS: `NSUserNotificationDefaultSoundName` is the documented sentinel for
/// "play the system's default notification chime" (see Apple's
/// NSUserNotification docs). `mac-notification-sys` recognizes any other
/// string as a custom sound name (e.g. "Ping", "Blow") in `/System/Library/Sounds/`.
///
/// Linux: `message-new-instant` is part of the freedesktop sound theme spec
/// and is supported by GNOME / KDE / XFCE / Cinnamon notification daemons.
/// Notification daemons that don't understand it fall back to no sound.
#[cfg(target_os = "macos")]
fn default_sound_name() -> Option<&'static str> {
    Some("NSUserNotificationDefaultSoundName")
}

#[cfg(target_os = "linux")]
fn default_sound_name() -> Option<&'static str> {
    Some("message-new-instant")
}

/// User notification preferences read from `~/.zhishi/config.json`.
///
/// Both fields default to `true` (fail-open) when the config file is missing
/// or unparseable — silently disabling notifications because we couldn't read
/// a JSON file would look like a regression. Read overhead is negligible:
/// notifications are low-frequency events, and the file is small.
struct NotificationPrefs {
    /// Master switch: when false, no OS notification is rendered at all
    /// (covers all 6 trigger sites — cron / task / message complete /
    /// permission request / ask-user-question / plan-mode review).
    os_notifications: bool,
    /// Sound flag: when true, the platform default chime plays alongside
    /// the toast.
    notification_sound: bool,
}

fn read_notification_prefs() -> NotificationPrefs {
    #[derive(Debug, serde::Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    struct PartialAppConfig {
        os_notifications: Option<bool>,
        /// Pre-0.2.14 master toggle. Read as a fallback so users who
        /// deliberately set `cronNotifications: false` keep notifications
        /// suppressed BEFORE the renderer's migrateOsNotificationsField
        /// runs and rewrites the field on disk. Otherwise: launch app,
        /// notification fires before they open Settings, surprise.
        cron_notifications: Option<bool>,
        notification_sound: Option<bool>,
    }

    // Use the project-canonical data-dir helper rather than `dirs::home_dir()`
    // so future dev/prod isolation in `app_dirs.rs` reaches us automatically.
    let parsed: Option<PartialAppConfig> = crate::app_dirs::zhishi_data_dir()
        .and_then(|dir| std::fs::read_to_string(dir.join("config.json")).ok())
        .and_then(|content| serde_json::from_str(strip_bom(&content)).ok());

    NotificationPrefs {
        os_notifications: parsed
            .as_ref()
            .and_then(|c| c.os_notifications.or(c.cron_notifications))
            .unwrap_or(true),
        notification_sound: parsed.and_then(|c| c.notification_sound).unwrap_or(true),
    }
}

/// Direct WinRT toast with `on_activated` click handler. Compiled only on
/// Windows.
///
/// Two-tier rendering: try the bundle identifier (matches NSIS Start-Menu
/// shortcut AUMID); on failure (portable EXE, custom install, missing
/// shortcut) retry with PowerShell's well-known AUMID. The retry preserves
/// `on_activated`, so click activation still works — the only visible
/// difference is the toast attribution ("PowerShell" instead of "ZhiShi").
/// This beats falling back to plugin-notification, which would render a toast
/// with *no* click handler at all.
#[cfg(target_os = "windows")]
fn show_windows_toast<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    tab_id: Option<String>,
    silent: bool,
) -> tauri_winrt_notification::Result<()> {
    use tauri_winrt_notification::Toast;

    let primary_app_id = resolve_windows_app_id(app);
    let primary_is_powershell = primary_app_id == Toast::POWERSHELL_APP_ID;

    match build_and_show_toast(app, &primary_app_id, title, body, tab_id.clone(), silent) {
        Ok(()) => Ok(()),
        Err(e) if primary_is_powershell => Err(e),
        Err(e) => {
            ulog_warn!(
                "[Notification] WinRT toast with AUMID '{}' failed: {}; \
                 retrying with PowerShell AUMID (click handler preserved).",
                primary_app_id,
                e
            );
            build_and_show_toast(app, Toast::POWERSHELL_APP_ID, title, body, tab_id, silent)
        }
    }
}

#[cfg(target_os = "windows")]
fn build_and_show_toast<R: Runtime>(
    app: &AppHandle<R>,
    app_id: &str,
    title: &str,
    body: &str,
    tab_id: Option<String>,
    silent: bool,
) -> tauri_winrt_notification::Result<()> {
    use tauri_winrt_notification::{Duration as ToastDuration, Sound, Toast};

    let app_handle = app.clone();
    // `Sound::Default` produces an empty `<audio>` element — WinRT then plays
    // the toast template's default chime. `None` injects `<audio silent="true"/>`,
    // suppressing sound entirely.
    let sound = if silent { None } else { Some(Sound::Default) };
    Toast::new(app_id)
        .title(title)
        .text1(body)
        .duration(ToastDuration::Short)
        .sound(sound)
        .on_activated(move |_action| {
            // _action is non-empty only when an action button is clicked;
            // we don't render buttons, so any activation is the toast body.
            // tab_id is closure-captured per-toast — no global queue lookup.
            handle_toast_click(&app_handle, tab_id.clone());
            Ok(())
        })
        .show()
}

/// Resolve the primary AUMID for our toast.
///
/// In production: `app.config().identifier` matches the AUMID NSIS sets on
/// the Start Menu shortcut via `SetLnkAppUserModelId` — required for WinRT
/// to render a toast attributed to ZhiShi.
///
/// In dev (`cargo run`, `tauri dev`): `tauri::is_dev()` is true and we use
/// PowerShell's AUMID — toast still shows but attributed to PowerShell.
///
/// Uses `tauri::is_dev()` (compile-time const) rather than path-suffix
/// heuristics that break under non-standard `CARGO_TARGET_DIR` or monorepo
/// layouts. The `tauri-plugin-notification` desktop backend uses path
/// suffix matching for the same purpose — `is_dev` is the cleaner equivalent
/// (#review-finding-3, CC).
#[cfg(target_os = "windows")]
fn resolve_windows_app_id<R: Runtime>(app: &AppHandle<R>) -> String {
    use tauri_winrt_notification::Toast;

    if tauri::is_dev() {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    }
}

/// Toast click handler (Windows in-process Activated callback).
///
/// Intentionally **does not** consult the global pending-click latch — that
/// latch is non-Windows only. The closure captures the per-toast `tab_id`
/// at render time, eliminating multi-toast misroute.
#[cfg(target_os = "windows")]
fn handle_toast_click<R: Runtime>(app: &AppHandle<R>, tab_id: Option<String>) {
    ulog_info!("[Notification] Toast clicked; tab_id={:?}", tab_id);
    crate::tray::show_main_window(app);
    emit_click(app, tab_id);
}

/// macOS / Linux fallback: when the user activates our app via an external
/// trigger (single-instance second launch, focus regain after a banner
/// click), drain the pending latch.
///
/// **Tradeoff (acknowledged)**: any external activation drains the latch,
/// not strictly toast clicks — alt-tab back to ZhiShi within 30s of a
/// notification will navigate to the queued tab even though the user didn't
/// click the toast. Mitigations:
///   - The latch is `Ambiguous` (no-route) when ≥2 notifications stacked
///     up unconsumed, so the worst case is a single-toast wrong-tab nudge.
///   - The `Single`-state path is the most common notification flow (one
///     completion, user reacts to it), where this behavior is what the user
///     wants anyway.
///
/// Real fix on macOS would require an `NSUserNotificationCenterDelegate`
/// hooked through Tauri (not currently exposed); on Linux, dbus action
/// callbacks. Both are out of scope for this fix and tracked separately.
#[cfg(not(target_os = "windows"))]
pub fn on_window_activated_externally<R: Runtime>(app: &AppHandle<R>) {
    if let Some(tab_id) = take_pending_click() {
        ulog_info!(
            "[Notification] External activation consumed pending click tab_id={}",
            tab_id
        );
        emit_click(app, Some(tab_id));
    }
}

/// Windows variant: no global latch, so external activation has nothing to
/// consume. Defined as a no-op so the call site in `lib.rs::single_instance`
/// stays platform-agnostic.
#[cfg(target_os = "windows")]
pub fn on_window_activated_externally<R: Runtime>(_app: &AppHandle<R>) {}

fn emit_click<R: Runtime>(app: &AppHandle<R>, tab_id: Option<String>) {
    let Some(tab_id) = tab_id else {
        return;
    };
    if let Err(e) = app.emit("notification:click", NotificationClickPayload { tab_id }) {
        ulog_warn!("[Notification] Failed to emit notification:click: {}", e);
    }
}

#[cfg(not(target_os = "windows"))]
fn queue_pending_click(tab_id: String) {
    let mut guard = match PENDING_CLICK.lock() {
        Ok(g) => g,
        Err(poisoned) => {
            ulog_warn!("[Notification] PENDING_CLICK mutex was poisoned; recovering");
            poisoned.into_inner()
        }
    };
    let now = Instant::now();
    *guard = match std::mem::replace(&mut *guard, PendingState::Empty) {
        // First entry — straightforward.
        PendingState::Empty => PendingState::Single(PendingClick {
            tab_id,
            queued_at: now,
        }),
        // Promote to Ambiguous: we now have ≥2 unconsumed notifications
        // and can't tell which one the user will click. Keep the older
        // queued_at so TTL bounds the ambiguous window correctly.
        //
        // Boundary fix (review-by-codex): if the old `Single` is itself
        // already past TTL (notification fired ≥30s ago, never clicked),
        // the user has clearly abandoned it — treat it as Empty for the
        // promotion. Otherwise we'd build an Ambiguous state seeded with
        // an already-expired timestamp, and `take_pending_click` doesn't
        // apply TTL to Ambiguous → the latch stays stuck refusing routes
        // until the next queue flushes it. v0.2.14 dogfood scenario:
        // queue A, leave window unfocused 31s, queue B, click B → gets
        // no deep-link forever.
        PendingState::Single(prev) if prev.queued_at.elapsed() > PENDING_CLICK_TTL => {
            PendingState::Single(PendingClick {
                tab_id,
                queued_at: now,
            })
        }
        PendingState::Single(prev) => PendingState::Ambiguous {
            queued_at: prev.queued_at,
        },
        // Same TTL hygiene for an already-Ambiguous entry: if its anchor
        // is past TTL when a new notification arrives, reset to Single on
        // the fresh entry. The user's previous batch is no longer the one
        // being clicked.
        PendingState::Ambiguous { queued_at } if queued_at.elapsed() > PENDING_CLICK_TTL => {
            PendingState::Single(PendingClick {
                tab_id,
                queued_at: now,
            })
        }
        PendingState::Ambiguous { queued_at } => PendingState::Ambiguous { queued_at },
    };
}

#[cfg(not(target_os = "windows"))]
fn take_pending_click() -> Option<String> {
    let mut guard = match PENDING_CLICK.lock() {
        Ok(g) => g,
        Err(poisoned) => {
            ulog_warn!("[Notification] PENDING_CLICK mutex was poisoned; recovering");
            poisoned.into_inner()
        }
    };
    let state = std::mem::replace(&mut *guard, PendingState::Empty);
    match state {
        PendingState::Empty => None,
        PendingState::Single(entry) => {
            if entry.queued_at.elapsed() > PENDING_CLICK_TTL {
                ulog_debug!(
                    "[Notification] Pending click for tab {} expired",
                    entry.tab_id
                );
                None
            } else {
                Some(entry.tab_id)
            }
        }
        PendingState::Ambiguous { queued_at: _ } => {
            // Refusing to route is the safe choice: deep-linking to the
            // *wrong* tab is worse than leaving the user on the current
            // tab after raising the window.
            ulog_debug!(
                "[Notification] Pending click was Ambiguous; raising window without deep-link"
            );
            None
        }
    }
}


// ============ Tests ============

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::*;

    /// All tests in this module touch the same global latch. Run them in a
    /// single `#[test]` so they don't race when `cargo test` parallelizes.
    #[test]
    fn pending_click_state_machine() {
        // 0. Reset (tests share the static; reset to Empty between phases).
        let reset = || {
            let mut guard = PENDING_CLICK.lock().unwrap();
            *guard = PendingState::Empty;
        };
        reset();

        // 1. Empty → take returns None.
        assert_eq!(take_pending_click(), None);

        // 2. queue + take returns the value once.
        queue_pending_click("tab-1".into());
        assert_eq!(take_pending_click(), Some("tab-1".into()));
        assert_eq!(take_pending_click(), None, "single-consumer semantics");

        // 3. Two queues without a take in between → Ambiguous → take None.
        reset();
        queue_pending_click("tab-A".into());
        queue_pending_click("tab-B".into());
        assert_eq!(
            take_pending_click(),
            None,
            "Ambiguous must refuse to deep-link"
        );

        // 4. Three queues → still Ambiguous → still None.
        reset();
        queue_pending_click("tab-A".into());
        queue_pending_click("tab-B".into());
        queue_pending_click("tab-C".into());
        assert_eq!(take_pending_click(), None);

        // 5. After Ambiguous is consumed, state resets and a fresh Single
        //    can route normally.
        queue_pending_click("tab-fresh".into());
        assert_eq!(take_pending_click(), Some("tab-fresh".into()));

        // 6. TTL expiry on Single — synthesize an old entry directly.
        {
            let mut guard = PENDING_CLICK.lock().unwrap();
            *guard = PendingState::Single(PendingClick {
                tab_id: "tab-stale".into(),
                queued_at: Instant::now() - Duration::from_secs(31),
            });
        }
        assert_eq!(take_pending_click(), None, "TTL must drop stale Single");

        // 7. queue → wait past TTL → queue → take must route to the LATER
        //    notification (not stick on Ambiguous-with-stale-anchor). This
        //    is the boundary fix from the v0.2.14 codex review.
        reset();
        {
            let mut guard = PENDING_CLICK.lock().unwrap();
            *guard = PendingState::Single(PendingClick {
                tab_id: "tab-old".into(),
                queued_at: Instant::now() - Duration::from_secs(31),
            });
        }
        queue_pending_click("tab-fresh-after-stale".into());
        assert_eq!(
            take_pending_click(),
            Some("tab-fresh-after-stale".into()),
            "stale Single must not poison the Ambiguous promotion",
        );

        // 8. Pre-existing Ambiguous past TTL + new queue → resets to Single
        //    on the fresh entry rather than refusing forever.
        reset();
        {
            let mut guard = PENDING_CLICK.lock().unwrap();
            *guard = PendingState::Ambiguous {
                queued_at: Instant::now() - Duration::from_secs(31),
            };
        }
        queue_pending_click("tab-after-ambiguous".into());
        assert_eq!(
            take_pending_click(),
            Some("tab-after-ambiguous".into()),
            "stale Ambiguous must not poison subsequent routes",
        );
    }
}
