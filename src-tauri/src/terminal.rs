//! Embedded terminal module — PTY management for the AI-driven panel terminal.
//!
//! Post-W6 (windowless host): the only consumer is the Panel API `/term/*`
//! routes (`zhishi term` CLI → sidecar → panel_api). The renderer-facing
//! `cmd_terminal_*` invoke commands were removed.
//!
//! Uses `portable-pty` (wezterm's PTY library) for cross-platform PTY support:
//! - macOS/Linux: `forkpty()` (POSIX PTY)
//! - Windows: ConPTY (Windows 10 1809+)
//!
//! Data flow:
//!   CLI write → panel_api /term/write → TerminalManager::write → PTY master write
//!   PTY master read → OutputBuffer ring → panel_api /term/read (emit is a no-op without windows)
//!
//! NOTE: This module does NOT use `process_cmd::new()` — portable-pty manages
//! process creation internally via `CommandBuilder` + `slave.spawn_command()`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use tauri::async_runtime::JoinHandle;

use crate::{ulog_info, ulog_error};

/// Maximum bytes retained in a terminal's output ring buffer.
pub const OUTPUT_BUFFER_CAPACITY: usize = 64 * 1024;

/// Ring buffer of recent PTY output with a global (monotonically increasing)
/// byte cursor. Used by the Panel API (`/term/read`) to let external callers
/// poll output since their last cursor without missing history — the Tauri
/// event stream (`terminal:data:{id}`) is fire-and-forget with no replay.
///
/// Layout: `buf[0]` corresponds to global offset `start`; `total` is the
/// number of bytes ever appended (i.e. the cursor of the write head). Reading
/// with a cursor older than `start` (already evicted) clamps to `start`.
#[derive(Debug, Default)]
pub struct OutputBuffer {
    buf: Vec<u8>,
    start: u64,
    total: u64,
    closed: bool,
}

impl OutputBuffer {
    /// Append raw PTY bytes, evicting from the front when over capacity.
    pub fn append(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
        self.total += data.len() as u64;
        if self.buf.len() > OUTPUT_BUFFER_CAPACITY {
            let excess = self.buf.len() - OUTPUT_BUFFER_CAPACITY;
            self.buf.drain(..excess);
            self.start += excess as u64;
        }
    }

    /// Read all bytes appended since `cursor`.
    /// Returns `(end_cursor, bytes, closed)` where `end_cursor` is the write
    /// head after this read. A cursor beyond the retained window is clamped.
    pub fn read_since(&self, cursor: u64) -> (u64, &[u8], bool) {
        let clamped = cursor.clamp(self.start, self.total);
        let offset = (clamped - self.start) as usize;
        (self.total, &self.buf[offset..], self.closed)
    }

    /// Mark the PTY stream as closed (shell exited / read error). The retained
    /// bytes stay readable; `closed` just tells pollers to stop.
    pub fn mark_closed(&mut self) {
        self.closed = true;
    }
}

/// A single terminal session with its PTY pair and reader task.
struct TerminalSession {
    /// Writer end of the PTY master — receives user keystrokes.
    writer: Box<dyn Write + Send>,
    /// The PTY master handle. Never read since the resize command was removed
    /// (W6) — but LOAD-BEARING as an owned handle: dropping `MasterPty` closes
    /// the PTY underneath the live shell, so the session must keep it pinned.
    /// Wrapped in a Mutex historically for shared resize access.
    #[allow(dead_code)]
    master: Arc<std::sync::Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    /// Shell child process handle (Child is not Sync, use std Mutex).
    child: Arc<std::sync::Mutex<Box<dyn portable_pty::Child + Send>>>,
    // NOTE: portable_pty::Child does not implement Sync, so we must not
    // require Sync on the Box. The std::sync::Mutex handles thread safety.
    /// Background task that reads PTY output and emits Tauri events.
    reader_task: JoinHandle<()>,
    /// Recent output ring buffer (fed by the reader task before emitting).
    /// Shared with the Panel API so output stays pollable even after the
    /// session is self-cleaned from `TerminalManager` on shell exit.
    output: Arc<std::sync::Mutex<OutputBuffer>>,
    /// D14 boundary tag (安全研究员版 P1 E6): which execution environment
    /// this session is attached to — `host` (default/None), `docker:<c>`,
    /// `vm:<name>`, `range:<host>`. Pure metadata: the boundary gate consumes
    /// it (env≠host ⇒ in-env), the PTY itself is environment-agnostic.
    env_tag: Option<String>,
}

/// Snapshot of one live session for the Panel API `/term/list` route.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub terminal_id: String,
    pub env_tag: Option<String>,
}

/// Manages all terminal sessions across Tabs.
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

impl TerminalManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
        })
    }
}

impl TerminalManager {
    /// Create a new terminal instance. Returns `terminal_id`.
    /// Shared by the Tauri command (renderer split-panel) and the Panel API
    /// (`/term/open`, which passes an `ai-<uuid>` ID).
    /// `command` runs a specific command line (via the platform shell)
    /// instead of the default interactive shell; `None` keeps the default.
    /// `env_tag` is the D14 boundary marker (see TerminalSession.env_tag).
    pub async fn create(
        self: &Arc<Self>,
        app: &AppHandle,
        workspace_path: String,
        rows: u16,
        cols: u16,
        sidecar_port: Option<u16>,
        terminal_id: Option<String>,
        command: Option<String>,
        env_tag: Option<String>,
    ) -> Result<String, String> {
    // Use frontend-provided ID if given (allows pre-registering listeners before creation),
    // otherwise generate one server-side.
    let id = terminal_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Reject duplicate IDs to prevent orphaning an existing session
    if self.sessions.lock().await.contains_key(&id) {
        return Err(format!("Terminal {} already exists", id));
    }

    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Build the spawn target — an explicit `command` (wrapped in the platform
    // shell so strings like `ssh user@target` / `docker exec -it <c> bash`
    // work as typed) or, when absent, the default login shell exactly as
    // before (login shell reads /etc/zprofile + ~/.zprofile, shows
    // "Last login" message, and prevents the zsh PROMPT_EOL_MARK (%) on the
    // first line).
    let (program, args) = resolve_spawn_command(command.as_deref());
    let mut cmd = CommandBuilder::new(&program);
    cmd.args(args.iter());
    cmd.cwd(&workspace_path);

    // Inject environment: bundled runtimes PATH + proxy config + sidecar port
    inject_terminal_env(&mut cmd, app, sidecar_port);

    // Spawn shell on the slave end
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell '{}': {}", program, e))?;

    // Drop slave — we only interact via master
    drop(pair.slave);

    // Get reader from master (clone before moving master)
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    // Get writer from master
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    // Wrap master and child for shared access
    let master = Arc::new(std::sync::Mutex::new(pair.master));
    let child: Arc<std::sync::Mutex<Box<dyn portable_pty::Child + Send>>> =
        Arc::new(std::sync::Mutex::new(child));

    // Output ring buffer — cloned into the reader task; the Arc outlives the
    // session so Panel API readers can drain buffered output after shell exit.
    let output = Arc::new(std::sync::Mutex::new(OutputBuffer::default()));

    // Spawn background reader task — passes manager Arc for self-cleanup on EOF
    let emit_id = id.clone();
    let app_clone = app.clone();
    let manager_for_reader: Arc<TerminalManager> = self.clone();
    let output_for_reader = output.clone();
    // Use `tauri::async_runtime::spawn_blocking` so the returned handle's type
    // matches the struct field (`tauri::async_runtime::JoinHandle<()>`); see
    // `clippy.toml` for the project-wide async-spawn rule.
    let reader_task = tauri::async_runtime::spawn_blocking(move || {
        terminal_read_loop(
            reader,
            &emit_id,
            &app_clone,
            manager_for_reader,
            output_for_reader,
        );
    });

    let session = TerminalSession {
        writer,
        master,
        child,
        reader_task,
        output,
        env_tag: env_tag.filter(|t| !t.trim().is_empty()),
    };

    self.sessions.lock().await.insert(id.clone(), session);

    ulog_info!(
        "[terminal] Created terminal {} (shell={}, cwd={})",
        id, program, workspace_path
    );

    Ok(id)
    }

    /// D14 boundary tag of a session (`None` = untagged, treated as `host`).
    pub async fn env_tag(&self, terminal_id: &str) -> Option<String> {
        self.sessions
            .lock()
            .await
            .get(terminal_id)
            .and_then(|s| s.env_tag.clone())
    }

    /// Snapshot all live sessions (id + env tag) for `/term/list`.
    pub async fn list(&self) -> Vec<TerminalInfo> {
        self.sessions
            .lock()
            .await
            .iter()
            .map(|(id, s)| TerminalInfo {
                terminal_id: id.clone(),
                env_tag: s.env_tag.clone(),
            })
            .collect()
    }

    /// Write bytes to a terminal's PTY (caller supplies any `\n`).
    pub async fn write(&self, terminal_id: &str, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        let session = sessions
            .get_mut(terminal_id)
            .ok_or_else(|| format!("Terminal {} not found", terminal_id))?;

        session
            .writer
            .write_all(data)
            .map_err(|e| format!("Failed to write to PTY: {}", e))?;

        // Flush to ensure data is sent immediately (important for single keystrokes)
        session
            .writer
            .flush()
            .map_err(|e| format!("Failed to flush PTY: {}", e))?;

        Ok(())
    }

    /// Read buffered output since `cursor`. Returns `(end_cursor, bytes, closed)`.
    pub async fn read_since(
        &self,
        terminal_id: &str,
        cursor: u64,
    ) -> Result<(u64, Vec<u8>, bool), String> {
        let sessions = self.sessions.lock().await;
        let session = sessions
            .get(terminal_id)
            .ok_or_else(|| format!("Terminal {} not found", terminal_id))?;
        let output = session
            .output
            .lock()
            .map_err(|e| format!("Failed to lock output buffer: {}", e))?;
        let (end, bytes, closed) = output.read_since(cursor);
        Ok((end, bytes.to_vec(), closed))
    }

    /// Clone the output-buffer handle for a session (Panel API keeps this so
    /// output stays readable after the session self-cleans on shell exit).
    pub async fn output_buffer(
        &self,
        terminal_id: &str,
    ) -> Option<Arc<std::sync::Mutex<OutputBuffer>>> {
        self.sessions
            .lock()
            .await
            .get(terminal_id)
            .map(|s| s.output.clone())
    }

    /// Close a terminal and kill its shell process.
    pub async fn close(&self, terminal_id: &str) {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.remove(terminal_id) {
            cleanup_session(session, terminal_id);
        }
    }
}


/// Close all terminals. Called on app exit alongside `stop_all_sidecars()`.
pub async fn close_all_terminals(state: &Arc<TerminalManager>) {
    let mut sessions = state.sessions.lock().await;
    let ids: Vec<String> = sessions.keys().cloned().collect();
    for id in &ids {
        if let Some(session) = sessions.remove(id) {
            cleanup_session(session, id);
        }
    }
    if !ids.is_empty() {
        ulog_info!("[terminal] Closed {} terminal(s) on shutdown", ids.len());
    }
}

/// Clean up a single terminal session: kill child, abort reader task.
fn cleanup_session(session: TerminalSession, terminal_id: &str) {
    // Kill the shell process
    if let Ok(mut child) = session.child.lock() {
        let _ = child.kill();
    }
    // Note: reader_task is a spawn_blocking task — abort() marks it for cancellation
    // but won't interrupt a blocked read(). The kill() above closes the PTY slave,
    // which causes read() to return EOF, naturally ending the reader loop.
    session.reader_task.abort();
    // Writer and master are dropped automatically
    ulog_info!("[terminal] Closed terminal {}", terminal_id);
}

/// Background loop: reads PTY output and emits Tauri events.
/// Self-cleans the session from `TerminalManager` on EOF/error so dead sessions
/// don't leak even if the frontend misses the exit event.
fn terminal_read_loop(
    mut reader: Box<dyn Read + Send>,
    terminal_id: &str,
    app: &AppHandle,
    manager: Arc<TerminalManager>,
    output: Arc<std::sync::Mutex<OutputBuffer>>,
) {
    let mut buf = [0u8; 4096];
    let event_data = format!("terminal:data:{}", terminal_id);
    let event_exit = format!("terminal:exit:{}", terminal_id);

    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                // PTY closed (shell exited)
                if let Ok(mut out) = output.lock() {
                    out.mark_closed();
                }
                let _ = app.emit(&event_exit, ());
                ulog_info!("[terminal] Shell exited for terminal {}", terminal_id);
                break;
            }
            Ok(n) => {
                // Feed the ring buffer BEFORE emitting so Panel API pollers
                // never observe an event for bytes they can't yet read.
                if let Ok(mut out) = output.lock() {
                    out.append(&buf[..n]);
                }
                // Send raw bytes to frontend as Vec<u8> (Tauri serializes to JSON array)
                let _ = app.emit(&event_data, buf[..n].to_vec());
            }
            Err(e) => {
                if let Ok(mut out) = output.lock() {
                    out.mark_closed();
                }
                ulog_error!("[terminal] Read error for {}: {}", terminal_id, e);
                let _ = app.emit(&event_exit, ());
                break;
            }
        }
    }

    // Self-clean: remove dead session from TerminalManager.
    // This prevents leaked sessions when the frontend misses the exit event.
    // Use try_current() — Handle::current() panics if runtime is shutting down (app exit).
    let id = terminal_id.to_string();
    let Some(handle) = tokio::runtime::Handle::try_current().ok() else { return };
    handle.spawn(async move {
        let mut map = manager.sessions.lock().await;
        if let Some(session) = map.remove(&id) {
            // Kill child process if still running
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
            }
            ulog_info!("[terminal] Self-cleaned dead session {}", id);
        }
    });
}

/// Resolve what to spawn for a new terminal session: `(program, args)`.
///
/// With no `command` this is exactly the historical behavior — the platform
/// default shell, started as a login shell on unix (`-l`), bare on Windows.
/// With `command`, the string is run through the platform shell (see
/// `shell_wrap_args`) so compound command lines like `ssh user@target` or
/// `docker exec -it <c> bash` work as typed. A blank/whitespace-only command
/// falls back to the default shell.
fn resolve_spawn_command(command: Option<&str>) -> (String, Vec<String>) {
    let shell = default_shell();
    match command {
        Some(c) if !c.trim().is_empty() => {
            let args = shell_wrap_args(&shell, c);
            (shell, args)
        }
        _ => {
            #[cfg(unix)]
            {
                (shell, vec!["-l".into()])
            }
            #[cfg(windows)]
            {
                (shell, Vec::new())
            }
        }
    }
}

/// Wrap a user-supplied command line for execution by `shell`:
/// unix `shell -c <cmd>`; Windows `cmd.exe /c <cmd>` or
/// `pwsh`/`powershell -Command <cmd>`. The command string is passed through
/// verbatim as a single argv entry — no manual re-quoting or concatenation.
fn shell_wrap_args(shell: &str, command: &str) -> Vec<String> {
    #[cfg(unix)]
    {
        let _ = shell;
        vec!["-c".into(), command.into()]
    }
    #[cfg(windows)]
    {
        let name = shell
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(shell)
            .to_lowercase();
        if name == "cmd.exe" || name == "cmd" {
            vec!["/c".into(), command.into()]
        } else {
            vec!["-Command".into(), command.into()]
        }
    }
}

/// Select the default shell for the current platform.
fn default_shell() -> String {    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    }
    #[cfg(windows)]
    {
        // Prefer PowerShell 7 → PowerShell 5.1 → cmd.exe
        // PowerShell supports Unix-like aliases (ls, pwd, clear, cat, etc.),
        // giving users a familiar experience. cmd.exe lacks these entirely.
        // Use system_binary::find() instead of bare which::which() (CLAUDE.md constraint)
        if crate::system_binary::find("pwsh").is_some() {
            "pwsh".into()
        } else if crate::system_binary::find("powershell").is_some() {
            "powershell".into()
        } else {
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
        }
    }
}

/// Inject environment variables into the terminal shell process.
///
/// This ensures the terminal has access to:
/// 1. Bundled Bun and Node.js (same PATH as SDK subprocesses)
/// 2. Proxy configuration (NO_PROXY protects localhost)
/// 3. ~/.zhishi/bin (CLI tools)
fn inject_terminal_env(cmd: &mut CommandBuilder, app: &AppHandle, sidecar_port: Option<u16>) {
    // 1. Build PATH with bundled runtimes
    //    Priority: bundled bun dir → bundled node dir → ~/.zhishi/bin → system PATH
    let mut extra_paths: Vec<String> = Vec::new();

    // Bundled Bun directory
    if let Ok(resource_dir) = app.path().resource_dir() {
        // #229 (same bug class): on Windows resource_dir() may carry the `\\?\`
        // extended-length prefix. cmd.exe / PowerShell don't honor `\\?\` entries
        // in PATH lookups, so a prefixed nodejs/binaries dir would be invisible to
        // the embedded terminal. Strip it before these paths cross into the shell.
        let resource_dir = crate::sidecar::normalize_external_path(resource_dir);

        #[cfg(target_os = "macos")]
        {
            if let Some(contents_dir) = resource_dir.parent() {
                let macos_dir = contents_dir.join("MacOS");
                if macos_dir.exists() {
                    extra_paths.push(macos_dir.to_string_lossy().into_owned());
                }
            }
        }
        let binaries_dir = resource_dir.join("binaries");
        if binaries_dir.exists() {
            extra_paths.push(binaries_dir.to_string_lossy().into_owned());
        }

        // Bundled Node.js directory
        #[cfg(target_os = "windows")]
        let node_dir = resource_dir.join("nodejs");
        #[cfg(not(target_os = "windows"))]
        let node_dir = resource_dir.join("nodejs").join("bin");
        if node_dir.exists() {
            extra_paths.push(node_dir.to_string_lossy().into_owned());
        }
    }

    // ~/.zhishi/bin (CLI tools)
    if let Some(home) = dirs::home_dir() {
        let cli_bin = home.join(".zhishi").join("bin");
        if cli_bin.exists() {
            extra_paths.push(cli_bin.to_string_lossy().into());
        }
    }

    if !extra_paths.is_empty() {
        let current_path = std::env::var("PATH").unwrap_or_default();
        #[cfg(unix)]
        let new_path = format!("{}:{}", extra_paths.join(":"), current_path);
        #[cfg(windows)]
        let new_path = format!("{};{}", extra_paths.join(";"), current_path);
        cmd.env("PATH", new_path);
    }

    // 2. Proxy configuration — reuse proxy_config logic
    //    We can't call proxy_config::apply_to_subprocess() directly because it takes
    //    &mut std::process::Command, not CommandBuilder. Apply the same logic manually,
    //    matching the error handling of the canonical apply_to_subprocess().
    if let Some(proxy) = crate::proxy_config::read_proxy_settings() {
        match crate::proxy_config::get_proxy_url(&proxy) {
            Ok(proxy_url) => {
                cmd.env("HTTP_PROXY", &proxy_url);
                cmd.env("HTTPS_PROXY", &proxy_url);
                cmd.env("http_proxy", &proxy_url);
                cmd.env("https_proxy", &proxy_url);
                cmd.env("ZHISHI_PROXY_INJECTED", "1");
            }
            Err(e) => {
                ulog_error!(
                    "[terminal] Invalid proxy configuration: {}. Terminal will start without proxy.",
                    e
                );
                // Don't inject proxy vars — let terminal inherit system network behavior
            }
        }
    }
    // MUST always inject NO_PROXY to protect localhost (reuse canonical constant)
    cmd.env("NO_PROXY", crate::proxy_config::LOCALHOST_NO_PROXY);
    cmd.env("no_proxy", crate::proxy_config::LOCALHOST_NO_PROXY);

    // 3. Sidecar port — lets `zhishi` CLI talk to the Tab's session sidecar
    if let Some(port) = sidecar_port {
        cmd.env("ZHISHI_PORT", port.to_string());
    }

    // 4. Suppress zsh PROMPT_EOL_MARK (%) — the partial-line indicator that appears
    //    when zsh thinks the cursor is not at column 0 on startup. Previous fixes
    //    (login shell -l, xterm.reset()) were insufficient because the PTY initial
    //    state can still trigger zsh's detection. Setting PROMPT_EOL_MARK="" is the
    //    definitive fix, used by embedded terminal implementations (VS Code, etc.).
    cmd.env("PROMPT_EOL_MARK", "");

    // 5. Terminal type — CRITICAL: without this, shell doesn't know terminal capabilities,
    //    causing broken delete key, missing colors, and broken cursor movement.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "ZhiShi");

    // 6. Locale — preserve system locale or default to UTF-8
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
    }

    // 7. Terminal indicator (so scripts can detect they're in ZhiShi terminal)
    cmd.env("ZHISHI_TERMINAL", "1");
}


#[cfg(test)]
mod tests {
    use super::{
        default_shell, resolve_spawn_command, shell_wrap_args, OutputBuffer,
        OUTPUT_BUFFER_CAPACITY,
    };

    #[test]
    fn append_and_read_full_history() {
        let mut buf = OutputBuffer::default();
        buf.append(b"hello ");
        buf.append(b"world");

        let (cursor, bytes, closed) = buf.read_since(0);
        assert_eq!(bytes, b"hello world");
        assert_eq!(cursor, 11);
        assert!(!closed);

        // Reading again from the end cursor yields nothing new.
        let (cursor2, bytes2, _) = buf.read_since(cursor);
        assert_eq!(cursor2, 11);
        assert!(bytes2.is_empty());
    }

    #[test]
    fn read_since_slices_incrementally() {
        let mut buf = OutputBuffer::default();
        buf.append(b"abc");
        let (c1, _, _) = buf.read_since(0);
        buf.append(b"def");
        let (c2, bytes, _) = buf.read_since(c1);
        assert_eq!(bytes, b"def");
        assert_eq!(c2, 6);
    }

    #[test]
    fn capacity_eviction_truncates_oldest() {
        let mut buf = OutputBuffer::default();
        let chunk = vec![b'x'; OUTPUT_BUFFER_CAPACITY];
        buf.append(&chunk);
        buf.append(b"tail");

        // Buffer holds exactly CAPACITY bytes: oldest 4 evicted.
        let (cursor, bytes, _) = buf.read_since(0);
        assert_eq!(bytes.len(), OUTPUT_BUFFER_CAPACITY);
        assert_eq!(cursor, (OUTPUT_BUFFER_CAPACITY + 4) as u64);
        assert!(bytes.ends_with(b"tail"));

        // A cursor pointing at evicted bytes clamps to the retained window,
        // returning everything still buffered (not garbage).
        let (_, bytes2, _) = buf.read_since(2);
        assert_eq!(bytes2.len(), OUTPUT_BUFFER_CAPACITY);

        // Reading from the write head yields only future bytes.
        let (_, bytes3, _) = buf.read_since(cursor);
        assert!(bytes3.is_empty());
    }

    #[test]
    fn mark_closed_is_sticky_and_readable() {
        let mut buf = OutputBuffer::default();
        buf.append(b"done");
        buf.mark_closed();
        let (_, bytes, closed) = buf.read_since(0);
        assert_eq!(bytes, b"done");
        assert!(closed);
    }

    // ── spawn-command resolution (terminal create 参数化) ──

    #[test]
    fn no_command_keeps_default_shell_behavior() {
        let (program, args) = resolve_spawn_command(None);
        assert_eq!(program, default_shell());
        #[cfg(unix)]
        assert_eq!(args, vec!["-l".to_string()]);
        #[cfg(windows)]
        assert!(args.is_empty());
    }

    #[test]
    fn blank_command_falls_back_to_default_shell() {
        for blank in ["", "   ", "\t\n"] {
            let (program, args) = resolve_spawn_command(Some(blank));
            assert_eq!(program, default_shell());
            #[cfg(unix)]
            assert_eq!(args, vec!["-l".to_string()]);
            #[cfg(windows)]
            assert!(args.is_empty());
        }
    }

    #[test]
    fn command_is_wrapped_in_platform_shell_verbatim() {
        let line = "ssh user@target -p 2222";
        let (program, args) = resolve_spawn_command(Some(line));
        assert_eq!(program, default_shell());
        // The command string rides as a single trailing argv entry, untouched.
        assert_eq!(args.len(), 2);
        assert_eq!(args[1], line);
        #[cfg(unix)]
        assert_eq!(args[0], "-c");
        #[cfg(windows)]
        assert!(args[0] == "/c" || args[0] == "-Command");
    }

    #[cfg(windows)]
    #[test]
    fn windows_wrap_picks_flag_by_shell() {
        assert_eq!(
            shell_wrap_args("cmd.exe", "dir"),
            vec!["/c".to_string(), "dir".to_string()]
        );
        assert_eq!(
            shell_wrap_args("C:\\Windows\\System32\\cmd.exe", "dir"),
            vec!["/c".to_string(), "dir".to_string()]
        );
        assert_eq!(
            shell_wrap_args("pwsh", "Get-Item ."),
            vec!["-Command".to_string(), "Get-Item .".to_string()]
        );
        assert_eq!(
            shell_wrap_args("powershell", "Get-Item ."),
            vec!["-Command".to_string(), "Get-Item .".to_string()]
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_wrap_is_dash_c() {
        assert_eq!(
            shell_wrap_args("/bin/zsh", "ls -la"),
            vec!["-c".to_string(), "ls -la".to_string()]
        );
    }
}
