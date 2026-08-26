// System tray implementation for ZhiShi
// 1.3.9 TUI 退役:「打开会话」改为聚焦 GUI 主窗口(交互面=GUI;原「弹 TUI
// 终端」随 tui_launcher 删除)。托盘只带「打开会话」+ 退出。

use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    menu::{MenuBuilder, MenuItemBuilder},
    Manager, Runtime,
};
#[cfg(target_os = "macos")]
use tauri::image::Image;

use crate::ulog_info;
// `ulog_warn` is only used inside the macOS template-icon load fallback.
#[cfg(target_os = "macos")]
use crate::ulog_warn;

/// Menu item IDs for tray right-click menu
const MENU_OPEN_SESSION: &str = "open_session";
const MENU_EXIT: &str = "exit";

/// Shared action for tray left-click and the "Open Session" menu item:
/// focus the GUI main window (1.3.9 — replaces the retired TUI terminal).
fn open_session<R: Runtime>(app: &tauri::AppHandle<R>) {
    show_main_window(app);
}

/// Initialize the system tray with icon and menu
pub fn setup_tray<R: Runtime>(app: &tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    // Build the tray menu, labelled for the locale resolved from the
    // persisted uiLanguage + OS locale (i18n §1; default zh for legacy
    // configs on zh systems).
    let locale = crate::i18n::current_locale();
    let open_item = MenuItemBuilder::with_id(MENU_OPEN_SESSION, crate::i18n::t("tray.openSession", locale)).build(app)?;
    let exit_item = MenuItemBuilder::with_id(MENU_EXIT, crate::i18n::t("tray.exit", locale)).build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&open_item)
        .separator()
        .item(&exit_item)
        .build()?;

    // Load tray icon - use template icon on macOS for proper menu bar appearance
    #[cfg(target_os = "macos")]
    let tray_icon = {
        // Load template icon from embedded bytes (22x22 for best menu bar appearance)
        let icon_bytes = include_bytes!("../icons/trayIconTemplate@2x.png");
        Image::from_bytes(icon_bytes).unwrap_or_else(|_| {
            ulog_warn!("[Tray] Failed to load template icon, using default");
            app.default_window_icon().unwrap().clone()
        })
    };

    #[cfg(not(target_os = "macos"))]
    let tray_icon = app.default_window_icon().unwrap().clone();

    // Build the tray icon. Left click focuses the GUI main window (1.3.9 —
    // replaces the retired TUI terminal); the menu stays on right click.
    let tray_builder = TrayIconBuilder::new()
        .icon(tray_icon)
        .menu(&menu)
        .tooltip("ZhiShi")
        .show_menu_on_left_click(false);

    // On macOS, mark as template image so system can adjust colors for light/dark mode
    #[cfg(target_os = "macos")]
    let tray_builder = tray_builder.icon_as_template(true);

    let tray = tray_builder
        .on_menu_event(move |app, event| {
            match event.id().as_ref() {
                MENU_OPEN_SESSION => {
                    ulog_info!("[Tray] Open Session menu clicked");
                    open_session(app);
                }
                MENU_EXIT => {
                    ulog_info!("[Tray] Exit menu clicked");
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Left-click release → focus the GUI main window. (Gated on Up so a press that
            // turns into a right-click menu gesture doesn't double-fire.)
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                ulog_info!("[Tray] Icon left-clicked");
                open_session(tray.app_handle());
            }
        })
        .build(app)?;

    // Pin the tray in managed state so the icon outlives this function.
    app.manage(tray);

    ulog_info!("[Tray] System tray initialized successfully");
    Ok(())
}

/// Show the main window (and focus it).
///
/// 1.3.9 TUI 退役:启动/二次实例/托盘/macOS Dock Reopen 各入口统一走这里
/// ——GUI 主窗口是唯一交互面。若主窗口不存在(极端时序)静默降级为无操作。
pub fn show_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
