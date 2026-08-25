// ZhiShi Tauri Application
// Main entry point with sidecar lifecycle management

pub mod app_dirs;
pub mod cli;
mod commands;
pub mod task_scheduler;
pub mod i18n;
pub mod notification;
pub mod local_http;
mod litellm_cache;
pub mod logger;
pub mod management_api;
pub mod panel_api;
pub mod perf_trace;
pub mod process_cleanup;
pub mod process_cmd;
mod proxy_config;
pub mod system_binary;
mod sidecar;
pub mod task;
pub mod trust;
pub mod terminal;
pub mod tui_launcher;
pub mod usb_updater;
pub mod workspace_files;
mod tray;
mod updater;
pub mod utils;
pub mod wake_lock;

use sidecar::{
    cleanup_stale_sidecars, cleanup_stale_sidecars_preamble, init_startup_cleanup_barrier,
    create_sidecar_state, stop_all_sidecars,
};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tauri_plugin_autostart::MacosLauncher;

// Note: lib.rs is the crate root, so `#[macro_export]` macros (ulog_info!,
// ulog_error!, etc.) are already in scope here without `use`. Importing them
// would cause E0255 "name defined multiple times".

/// Check if CLI arguments indicate CLI mode (delegates to cli module).
pub fn is_cli_mode(args: &[String]) -> bool {
    cli::is_cli_mode(args)
}

/// Run in CLI mode — forward args to the Bun CLI script and return exit code.
pub fn run_cli(args: &[String]) -> i32 {
    cli::run(args)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ── DIAGNOSTIC PANIC HOOK (April 2026 crash investigation) ─────────────
    // Install BEFORE any other init so we capture every panic, including
    // setup-time / did_finish_launching ones that don't reach the unified
    // logger. Writes to ~/.zhishi/logs/panic-{pid}-{timestamp}.log so a
    // post-mortem has the actual panic message even when the app aborts
    // before normal log flush.
    {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let log_dir = app_dirs::zhishi_data_dir()
                .map(|d| d.join("logs"))
                .unwrap_or_else(|| std::path::PathBuf::from("."));
            let _ = std::fs::create_dir_all(&log_dir);
            let pid = std::process::id();
            let ts = chrono::Local::now().format("%Y%m%d-%H%M%S%.3f");
            let path = log_dir.join(format!("panic-{}-{}.log", pid, ts));
            let backtrace = std::backtrace::Backtrace::force_capture();
            let payload = format!(
                "TIME: {}\nPID: {}\nINFO: {}\nLOCATION: {:?}\n\nBACKTRACE:\n{}\n",
                chrono::Local::now().to_rfc3339(),
                pid,
                info,
                info.location(),
                backtrace,
            );
            let _ = std::fs::write(&path, &payload);
            // Also try to print to stderr as a fallback
            eprintln!("[PANIC-HOOK] wrote {}", path.display());
            eprintln!("{}", payload);
            prev(info);
        }));
    }

    // NOTE: cleanup_stale_sidecars() was moved into .setup() callback below.
    // This ensures it only runs for the PRIMARY app instance, not when a second
    // instance is launched (which would kill the running app's sidecar processes).
    // The single-instance plugin exits the second process before .setup() is called.

    // Create managed sidecar state (now supports multiple instances)
    let sidecar_state = create_sidecar_state();
    let sidecar_state_for_exit = sidecar_state.clone();
    let sidecar_state_for_monitor = sidecar_state.clone();
    let sidecar_state_for_session_monitor = sidecar_state.clone();
    let sidecar_state_for_wakelock_monitor = sidecar_state.clone();
    let sidecar_state_for_terminal_forwarder = sidecar_state.clone();

    let sidecar_state_for_management = sidecar_state.clone();
    let sidecar_state_for_single_instance = sidecar_state.clone();
    let sidecar_state_for_launcher = sidecar_state.clone();

    // Track if cleanup has been performed to avoid duplicate cleanup
    // All clones share the same underlying AtomicBool - whichever exit path
    // triggers first will do cleanup, and all others will see the flag as true
    // and skip. The separate variables are needed because each is moved into
    // a different closure (app exit, background monitors).
    let cleanup_done = Arc::new(AtomicBool::new(false));
    let cleanup_done_for_exit = cleanup_done.clone();
    let cleanup_done_for_monitor = cleanup_done.clone();
    let cleanup_done_for_session_monitor = cleanup_done.clone();
    let cleanup_done_for_wakelock_monitor = cleanup_done.clone();
    let cleanup_done_for_terminal_forwarder = cleanup_done.clone();

    // Create terminal manager state
    let terminal_state = terminal::TerminalManager::new();
    let terminal_state_for_exit = terminal_state.clone();
    let terminal_state_for_panel = terminal_state.clone();

    // Create Task Center state (v0.1.69 — task store)
    let data_dir = app_dirs::zhishi_data_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let task_state: task::ManagedTaskStore =
        Arc::new(task::TaskStore::new(data_dir.clone()));
    // Expose the same Arc via a OnceLock singleton so the Rust Management API
    // (used by Bun CLI bridge → /api/admin/task/*) can read/write tasks without
    // access to Tauri `State`. It points at the same inner store.
    task::set_task_store(task_state.clone());

    // Build the app first, then run with event handler
    // This allows us to handle RunEvent::ExitRequested for Cmd+Q and Dock quit
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(move |app, _args, _cwd| {
            // Another instance was launched (user clicked the app icon while
            // the host is already running). Windowless host (D13): there is no
            // window to raise — the interactive surface is the CLI/TUI, so a
            // repeated click opens a fresh agent TUI terminal instead (1.2.3).
            // Runs on a blocking worker; see tui_launcher module docs.
            tui_launcher::spawn_open_tui(
                app.clone(),
                sidecar_state_for_single_instance.clone(),
                "single-instance",
            );
            // Notify the front-end that the user just re-activated the app via
            // an external trigger (taskbar icon, dock click on Linux, etc.).
            // The notification module piggy-backs on this to consume any
            // pending deep-link target from a recently-clicked toast on
            // platforms where in-process Activated callbacks aren't available
            // (macOS / Linux fallback path).
            notification::on_window_activated_externally(app);
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        // 1.3.0(GUI):最小 IPC 面——webview 前端拿 sidecar 端口(SSE 直连)。
        .invoke_handler(tauri::generate_handler![crate::commands::get_sidecar_port])
        .manage(sidecar_state)
        .manage(terminal_state)
        .manage(task_state)
        .setup(move |app| {
            // Initialize logging before acquire_lock() and cleanup_stale_sidecars()
            // because those paths need a logger backend for log::warn!/info! calls.
            use tauri_plugin_log::{Target, TargetKind};

            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            };

            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log_level)
                    .target(Target::new(TargetKind::Stdout))
                    .target(Target::new(TargetKind::LogDir { file_name: None }))
                    .build(),
            )?;

            // Initialize global AppHandle for unified logging (IM module etc.)
            logger::init_app_handle(app.handle().clone());

            // Pattern 6: spawn the buffered writer task so subsequent
            // ulog_*! calls go through the bounded mpsc → BufWriter path
            // instead of opening/appending/closing per line. Pre-init
            // calls (extremely early startup) fall back to a synchronous
            // append protected by a mutex.
            logger::init_buffered_writer();

            // USB Portable: ensure the resolved data directory exists (needed
            // for portable mode where the directory may not have been created
            // yet — next to the exe instead of $HOME).
            if let Some(ref data_dir) = app_dirs::zhishi_data_dir() {
                let _ = std::fs::create_dir_all(data_dir);
            }

            // Acquire PID lock — kills any stale instance that macOS auto-restarted
            // (e.g., after ./scripts/dev/build_dev.sh pkill). Must run before cleanup_stale_sidecars
            // so we don't kill sidecars belonging to an instance we're about to replace.
            // The single-instance plugin handles the "user double-clicked" case via IPC;
            // this lock handles the "build script killed + macOS restarted" case via PID.
            let lock_state = app_dirs::acquire_lock();
            let had_prior_instance = lock_state.had_prior_instance();

            // Stale sidecar cleanup:
            //   1. Run the fast preamble (remove stale port file) synchronously
            //      so CLI / admin-api see a consistent state immediately.
            //   2. Hoist the heavy scan onto a blocking worker. Previously this
            //      ran synchronously on the main thread and blocked Tauri
            //      `setup()` for 5–15 s on Windows (PowerShell/WMI cold
            //      start × 6 patterns), which directly caused the
            //      "frontend freezes on first launch" user report. The new
            //      `process_cleanup` module uses native `sysinfo` (no
            //      subprocess spawn) and completes in ~10–200 ms.
            //   3. `start_tab_sidecar` waits on the barrier before
            //      spawning, so port allocation still serializes with
            //      cleanup — no correctness regression.
            init_startup_cleanup_barrier();
            cleanup_stale_sidecars_preamble();
            tauri::async_runtime::spawn_blocking(move || {
                // Panic-safe: if cleanup panics (sysinfo crash, etc.) we
                // still MUST mark the barrier done, otherwise every future
                // sidecar spawn will wait the full 15 s timeout. The outer
                // guard fires regardless of whether the inner closure
                // returned normally or unwound.
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    cleanup_stale_sidecars(had_prior_instance);
                }));
                // Always mark done — cleanup_stale_sidecars normally marks
                // internally on success, but we cover both the panic path
                // and any early-return paths we might add in the future.
                sidecar::mark_startup_cleanup_done();
                if let Err(panic) = result {
                    // Try to log something useful about the panic.
                    let msg = panic
                        .downcast_ref::<&'static str>()
                        .map(|s| s.to_string())
                        .or_else(|| panic.downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "<non-string panic payload>".to_string());
                    ulog_error!(
                        "[sidecar] cleanup_stale_sidecars panicked: {} — barrier released so startup can proceed",
                        msg
                    );
                }
            });

            // Seed system skills + environment recipes at startup. The renderer
            // used to invoke these via IPC; with the GUI deleted (CLI+agent form)
            // nothing else triggers them — run the version gates here.
            {
                let seed_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = commands::cmd_sync_system_skills(seed_handle.clone()).await {
                        ulog_warn!("[startup] system skills sync failed: {}", e);
                    }
                    if let Err(e) = commands::cmd_seed_environment_recipes(seed_handle.clone()).await {
                        ulog_warn!("[startup] environment recipes seed failed: {}", e);
                    }
                    if let Err(e) = commands::cmd_seed_bundled_agents(seed_handle).await {
                        ulog_warn!("[startup] bundled agents seed failed: {}", e);
                    }
                });
            }

            // ── Boot Banner: single-line consolidated diagnostics for AI grep ──
            {
                let pkg = app.package_info();
                let version = pkg.version.to_string();
                let build_mode = if cfg!(debug_assertions) { "debug" } else { "release" };
                let os = std::env::consts::OS;
                let arch = std::env::consts::ARCH;
                let data_dir = app_dirs::zhishi_data_dir();
                let dir_str = data_dir.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "?".into());

                // Read config.json for counts (best-effort)
                let (mut provider, mut mcp, mut agents, mut channels, mut cron, mut proxy) =
                    ("?".to_string(), 0u32, 0u32, 0u32, 0u32, false);
                if let Some(ref dir) = data_dir {
                    if let Ok(c) = std::fs::read_to_string(dir.join("config.json"))
                        .ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()).ok_or(()) {
                        // won't reach — see below
                        let _ = c;
                    }
                    // Simpler: parse as Value directly. strip_bom tolerates a
                    // Windows-editor-prepended UTF-8 BOM (issue #170 #6) so the
                    // boot log reflects real config values instead of "?".
                    if let Ok(cfg) = std::fs::read_to_string(dir.join("config.json"))
                        .and_then(|s| serde_json::from_str::<serde_json::Value>(crate::utils::bom::strip_bom(&s)).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))) {
                        provider = cfg.get("defaultProviderId").and_then(|v| v.as_str()).unwrap_or("none").to_string();
                        mcp = cfg.get("mcpEnabledServers").and_then(|v| v.as_array()).map(|a| a.len() as u32).unwrap_or(0);
                        if let Some(ags) = cfg.get("agents").and_then(|v| v.as_array()) {
                            agents = ags.len() as u32;
                            for a in ags { channels += a.get("channels").and_then(|v| v.as_array()).map(|a| a.len() as u32).unwrap_or(0); }
                        }
                        proxy = cfg.get("proxySettings").and_then(|v| v.get("enabled")).and_then(|v| v.as_bool()).unwrap_or(false);
                    }
                    if let Ok(s) = std::fs::read_to_string(dir.join("task_runtime.json")) {
                        cron = serde_json::from_str::<serde_json::Value>(crate::utils::bom::strip_bom(&s)).ok()
                            .and_then(|v| v.get("tasks")?.as_array().map(|tasks|
                                tasks.iter().filter(|t| t.get("armed").and_then(|e| e.as_bool()).unwrap_or(false)).count() as u32
                            )).unwrap_or(0);
                    }
                }

                ulog_info!("[boot] v={} build={} os={}-{} provider={} mcp={} agents={} channels={} cron={} proxy={} dir={}", version, build_mode, os, arch, provider, mcp, agents, channels, cron, proxy, dir_str);
            }

            // Setup system tray
            if let Err(e) = tray::setup_tray(app) {
                ulog_error!("[App] Failed to setup system tray: {}", e);
            }

            // CLI install chain (restored in 1.2.3 after the W6 removal left
            // fresh machines without a `zhishi` command) + interactive-launch
            // TUI. Runs on every boot so autostart repairs the install too;
            // the TUI window itself is gated on interactive launch — the
            // autostart plugin always passes `--minimized` (see the plugin
            // registration above), which MUST never pop a terminal.
            {
                let interactive = !std::env::args().skip(1).any(|a| a == "--minimized");
                let launcher_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        tui_launcher::sync_cli_resources(&launcher_handle);
                        if interactive {
                            tui_launcher::open_tui_session(
                                &launcher_handle,
                                &sidecar_state_for_launcher,
                                "launch",
                            );
                        }
                    })
                    .await;
                });
            }

            // Inject Sidecar state into management API
            management_api::set_sidecar_state(sidecar_state_for_management);

            // Start management API (internal HTTP server for Bun→Rust IPC)
            tauri::async_runtime::spawn(async move {
                match management_api::start_management_api().await {
                    Ok(port) => ulog_info!("[App] Management API started on port {}", port),
                    Err(e) => ulog_error!("[App] Failed to start management API: {}", e),
                }
            });

            // Start Panel API (loopback HTTP server for external CLI →
            // embedded terminal control). Shares the same TerminalManager
            // as the app-exit cleanup path.
            let panel_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match panel_api::start_panel_api(
                    panel_app,
                    terminal_state_for_panel,
                )
                .await
                {
                    Ok(port) => ulog_info!("[App] Panel API started on port {}", port),
                    Err(e) => ulog_error!("[App] Failed to start panel API: {}", e),
                }
            });

            // Bridge `SidecarManager::terminal_events` → `session:sidecar-terminal`
            // Tauri event. Renderer's App.tsx listens and resets `tab.sessionId`
            // bindings whose underlying sidecar has been definitively released
            // (no owners remained at removal → no auto-restart will revive it).
            // Without this bridge, voluntary-release leaves stale Tab.sessionId
            // values which `planSessionOpen` then "jump-to-tab"s into → empty
            // UI + sidecar-not-running errors. See `forward_terminal_events_to_renderer`
            // doc-comment for the full rationale.
            //
            // Spawn order: BEFORE cron/IM auto-start so any sidecar created
            // and terminally-removed by those subsystems on startup is captured.
            // The forwarder subscribes synchronously inside the spawned task
            // (first await is `rx.recv()`); broadcast channel buffers up to 64
            // events so the few-millisecond gap before `subscribe()` runs is
            // covered. (Codex review ADV-4.)
            let app_handle_for_terminal_forwarder = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sidecar::forward_terminal_events_to_renderer(
                    app_handle_for_terminal_forwarder,
                    sidecar_state_for_terminal_forwarder,
                    cleanup_done_for_terminal_forwarder,
                ).await;
            });
            ulog_info!("[App] Sidecar terminal-event forwarder spawned");

            // Initialize cron task manager with app handle
            let cron_app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                task_scheduler::initialize_task_scheduler(cron_app_handle).await;
            });
            ulog_info!("[App] Cron task manager initialization scheduled");

            // Start Global Sidecar health monitor
            // Periodically checks if the Global Sidecar is alive and auto-restarts it
            // This prevents the "all network broken" state on Windows when the window
            // is minimized to tray and the OS kills child processes
            let app_handle_for_monitor = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sidecar::monitor_global_sidecar(
                    app_handle_for_monitor,
                    sidecar_state_for_monitor,
                    cleanup_done_for_monitor,
                ).await;
            });
            ulog_info!("[App] Global sidecar health monitor spawned");

            // Start Session Sidecar health monitor (20s initial delay)
            let app_handle_for_session_monitor = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sidecar::monitor_session_sidecars(
                    app_handle_for_session_monitor,
                    sidecar_state_for_session_monitor,
                    cleanup_done_for_session_monitor,
                ).await;
            });
            ulog_info!("[App] Session sidecar health monitor spawned");

            // Start the turn wake-lock monitor: holds a system wake-lock (prevents
            // idle sleep) while ANY sidecar has an in-flight AI turn, so a long
            // interactive/cron turn isn't killed when the Mac idle-sleeps and drops
            // the SDK's HTTPS stream. Cron already had per-execution coverage; this
            // generalizes it to interactive turns. (Pairs with the suspension-aware
            // watchdog, which handles the unpreventable lid-close case.)
            tauri::async_runtime::spawn(async move {
                sidecar::monitor_turn_wake_lock(
                    sidecar_state_for_wakelock_monitor,
                    cleanup_done_for_wakelock_monitor,
                ).await;
            });
            ulog_info!("[App] Turn wake-lock monitor spawned");

            // Start background update check (60s delay, then stale updater temp cleanup)
            ulog_info!("[App] Setup complete, spawning background update check task...");
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                ulog_info!("[App] Background update task started, waiting 60 seconds before stale Windows updater temp cleanup and update check...");
                updater::check_update_on_startup(app_handle).await;
                ulog_info!("[App] Background update task completed");
            });
            ulog_info!("[App] Background update task spawned successfully");

            // LiteLLM model-data cache: startup conditional check + 24h interval
            // (gated by config.liteLLMModelDataRefresh, default on). Single owner
            // lives in the Tauri process; the sidecar reads the cached file. See
            // litellm_cache.rs.
            tauri::async_runtime::spawn(async move {
                litellm_cache::start_periodic_refresh().await;
            });
            ulog_info!("[App] LiteLLM model-data refresh task spawned");

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Run with event handler to catch Cmd+Q, Dock quit, and Dock click
    app.run(move |_app_handle, event| {
        match event {
            // Handle app exit events (Cmd+Q, Dock right-click quit, etc.)
            tauri::RunEvent::ExitRequested { code, .. } => {
                // Only cleanup once (Relaxed is sufficient for simple flag)
                use std::sync::atomic::Ordering::Relaxed;
                if !cleanup_done_for_exit.swap(true, Relaxed) {
                    ulog_info!("[App] Exit requested (Cmd+Q or Dock quit), cleaning up sidecars...");
                    // Record a deliberate-quit marker so the next boot starts
                    // fresh instead of restoring the session (Issue #309), UNLESS
                    // this is an update-restart. Both update paths — plugin
                    // `relaunch()` and `AppHandle::restart` — fire ExitRequested
                    // with `code == RESTART_EXIT_CODE`; a deliberate quit carries
                    // `None` (Cmd+Q / Dock) or `Some(0)` (tray "Exit"). Gating on
                    // the code keeps "offer restore after an update" working on
                    // every platform/path without a forgettable flag.
                    app_dirs::record_clean_exit(code == Some(tauri::RESTART_EXIT_CODE));
                    let _ = stop_all_sidecars(&sidecar_state_for_exit);
                    // Clean up terminal PTY sessions
                    let ts = terminal_state_for_exit.clone();
                    tauri::async_runtime::block_on(terminal::close_all_terminals(&ts));
                    app_dirs::release_lock();
                }
            }
            // Handle Dock icon click on macOS (Reopen event)
            // This is triggered when user clicks the Dock icon while app is running but window is hidden
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                ulog_info!("[App] Dock icon clicked (Reopen), showing main window");
                use tauri::Manager;
                if let Some(window) = _app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        }
    });
}
