// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // CLI mode: detect known subcommands/flags and route to CLI handler.
    // This avoids starting the GUI, running cleanup_stale_sidecars (which kills
    // running sidecars), and triggering the single-instance window focus.
    if app_lib::is_cli_mode(&args) {
        std::process::exit(app_lib::run_cli(&args));
    }

    // Background host mode: Tauri app without any windows (tray + APIs only).
    app_lib::run();
}
