//! 团队大脑远端模式的本地回环 TCP 中继（2.0.3 remote relay）。
//!
//! ## 为什么
//!
//! 成员 GUI 的页面是安全上下文（Tauri webview 的 `http://tauri.localhost`），
//! 浏览器混合内容规则会掐死页面向 `http://<局域网IP>` 发起的**一切**请求
//! （fetch / SSE / WebSocket 无一豁免），auth 开启后服务端 CORS allowlist 又
//! 只放行 Tauri origin 与回环地址（`src/server/auth/cors.ts`）。绕行这两道
//! 闸的唯一办法是让 GUI 请求的目标保持回环——这就是 `ssh -L` 手工隧道的
//! 作用。本模块把这条隧道做成应用内建能力（成员零配置、不依赖成员机的
//! sshd），语义与 `ssh -L` 完全同构：
//!
//! ```text
//! webview ──HTTP/SSE/WS──► 127.0.0.1:<relayPort> ──哑 TCP 管道──► 大脑:7411
//! ```
//!
//! ## 结构
//!
//! - 转发器本体是 `resources/relay.cjs`（内置 Node 子进程，纯 `node:net`），
//!   字节流不解析、不改写——HTTP / SSE / WS upgrade / 大文件全透明；
//!   stdout 首行 `ZHISHI_RELAY_READY <port>` 契约见该文件头。
//! - 本模块管生命周期：远端模式进入时 spawn、目标变更/离开远端/应用退出
//!   时 kill。`ensure()` 幂等可重入——前端每 500ms 轮询一次
//!   `get_sidecar_port(remote_url)`，稳态下只是锁内一次比较。
//!
//! ## 信任模型
//!
//! 中继只绑回环；任何本机进程都能借道访问大脑——与 ssh -L 一致，大脑侧
//! token 鉴权兜底。隧道里流过的 Bearer / `?token=` 对本进程不可见也不可见
//! （relay.cjs 不打印 payload/URL）。

use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStderr, ChildStdout, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime};

use crate::{process_cmd, ulog_debug, ulog_error, ulog_info, ulog_warn};

/// READY 行解析成功的等待上限：超过视为启动失败，允许下一轮轮询重试。
const START_TIMEOUT: Duration = Duration::from_secs(15);
/// 启动失败后的重试冷却：避免前端轮询把坏配置变成 spawn 风暴。
const FAIL_RETRY_COOLDOWN: Duration = Duration::from_secs(5);

/// 中继转发目标（从团队大脑 URL 解析出的裸主机 + 端口）。
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RelayTarget {
    pub host: String,
    pub port: u16,
}

/// 从团队大脑 URL 解析转发目标。
///
/// GUI 侧（model/connection.ts::normalizeServerUrl）已保证带 scheme 且剥了
/// 尾斜杠，这里是第二道校验：scheme 必须 http/https（中继只服务 GUI 的
/// HTTP(S) 流量），主机非空，端口缺省取协议默认（http→80 / https→443——
/// 大脑实际几乎总是显式 `:7411`）。
pub(crate) fn parse_relay_target(url: &str) -> Result<RelayTarget, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("empty url".to_string());
    }
    let parsed = reqwest::Url::parse(trimmed).map_err(|e| format!("URL 解析失败：{e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("不支持的 scheme：{other}（中继只转发 HTTP(S) 目标）")),
    }
    let host = parsed.host_str().ok_or_else(|| "URL 缺少主机".to_string())?.to_string();
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "无法确定目标端口".to_string())?;
    Ok(RelayTarget { host, port })
}

/// 解析 relay.cjs 的 stdout 首行契约：`ZHISHI_RELAY_READY <port>`。
fn parse_ready_line(line: &str) -> Option<u16> {
    let rest = line.trim().strip_prefix("ZHISHI_RELAY_READY ")?.trim();
    let port: u16 = rest.parse().ok()?;
    (port > 0).then_some(port)
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

#[derive(Default)]
enum RelayState {
    /// 无中继（本机模式 / 从未进过远端 / 已停止）。
    #[default]
    Stopped,
    /// 子进程已 spawn，等待 READY 行（reader 线程在途）。
    Starting {
        target: RelayTarget,
        since: Instant,
        /// reader 线程就绪后把 child 搬进 Running；ensure 的过期/换目标
        /// 路径则在这里 take 走杀掉的——所有权始终唯一，无双杀。
        child: Option<Child>,
        /// 启动尝试代次：reader 线程只认匹配 epoch 的 Starting，防止把
        /// 已被新一轮 ensure 取代的旧启动写回状态。
        epoch: u64,
    },
    /// READY 行已到，端口可服务。
    Running {
        child: Child,
        port: u16,
        target: RelayTarget,
    },
    /// 启动失败（spawn 失败 / READY 前退出 / READY 行非法）。冷却期内
    /// ensure 直接返回 None，避免轮询变 spawn 风暴。
    Failed {
        target: RelayTarget,
        error: String,
        since: Instant,
    },
}

impl Drop for RelayState {
    fn drop(&mut self) {
        match self {
            RelayState::Starting { child: Some(c), .. } => reap_child(c),
            RelayState::Running { child: c, .. } => reap_child(c),
            _ => {}
        }
    }
}

/// kill + wait 收尸。node 子进程终止是毫秒级，同步等待可接受——
/// 只在状态替换（ensure/stop）与退出清理路径上调用。
fn reap_child(child: &mut Child) {
    if let Err(e) = child.kill() {
        ulog_debug!("[relay] kill 中继进程（可能已退出）：{}", e);
    }
    if let Err(e) = child.wait() {
        ulog_debug!("[relay] wait 中继进程失败：{}", e);
    }
}

#[derive(Default)]
struct RelayInner {
    state: RelayState,
    /// 每次启动尝试 +1，reader 线程据此识别自己是否已被取代。
    epoch: u64,
}

/// 远端中继管理器（Tauri managed state；`Clone` 供退出钩子用）。
#[derive(Clone, Default)]
pub struct RemoteRelayManager {
    inner: Arc<Mutex<RelayInner>>,
}

impl RemoteRelayManager {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock_inner(&self) -> MutexGuard<'_, RelayInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 保证指向 `url` 的中继在跑（或正在启动）：返回可服务端口；
    /// 未就绪（启动中/失败冷却/解析失败）返回 None，调用方轮询重试。
    ///
    /// 幂等可重入：稳态（Running 且目标一致且子进程活着）只是一次锁内
    /// 比较；目标变更、进程退出、启动超时都会安全重启。
    pub fn ensure<R: Runtime>(&self, app: &AppHandle<R>, url: &str) -> Option<u16> {
        let target = match parse_relay_target(url) {
            Ok(t) => t,
            Err(e) => {
                ulog_warn!("[relay] 团队大脑地址无法解析为中继目标：{}（{}）", url, e);
                // 配置已坏——杀掉在跑的中继，别让旧目标继续幽灵转发。
                self.stop();
                return None;
            }
        };

        let mut inner = self.lock_inner();

        // 稳态短路（含子进程已退出的检测）。
        if let RelayState::Running { child, port, target: t } = &mut inner.state {
            if *t == target {
                match child.try_wait() {
                    Ok(None) => return Some(*port),
                    Ok(Some(status)) => {
                        ulog_info!("[relay] 中继进程已退出（{}）——准备重启", status)
                    }
                    Err(e) => ulog_warn!("[relay] try_wait 失败（{}）——按退出处理", e),
                }
            } else {
                ulog_info!(
                    "[relay] 中继目标变更 {}:{} → {}:{}",
                    t.host,
                    t.port,
                    target.host,
                    target.port
                );
            }
        }

        // 在途启动（同目标未超时）与失败冷却：别动，让前端继续轮询。
        if let RelayState::Starting { target: t, since, .. } = &inner.state {
            if *t == target && since.elapsed() < START_TIMEOUT {
                return None;
            }
        }
        if let RelayState::Failed { target: t, since, error } = &inner.state {
            if *t == target && since.elapsed() < FAIL_RETRY_COOLDOWN {
                ulog_debug!("[relay] 中继处于失败冷却期（{}），跳过重试", error);
                return None;
            }
        }

        // 其余情形（Stopped / 进程已退出 / 目标变更 / 启动超时 / 冷却结束）
        // 统一路径：替换掉旧状态（Drop 自动收尸），spawn 新一轮。
        let _old = std::mem::replace(&mut inner.state, RelayState::Stopped);
        drop(_old);
        self.spawn_locked(app, &mut inner, target);
        None
    }

    /// 停掉中继（离开远端模式 / 应用退出 / 地址解析失败）。
    pub fn stop(&self) {
        let mut inner = self.lock_inner();
        if !matches!(inner.state, RelayState::Stopped) {
            ulog_info!("[relay] 中继停止");
        }
        let _old = std::mem::replace(&mut inner.state, RelayState::Stopped);
        drop(_old);
    }

    /// spawn relay.cjs 并落 Starting 态（READY 读取在线程在途）。
    /// 调用方持有锁。
    fn spawn_locked<R: Runtime>(&self, app: &AppHandle<R>, inner: &mut RelayInner, target: RelayTarget) {
        let node = match crate::sidecar::find_node_executable(app) {
            Some(p) => p,
            None => {
                ulog_error!("[relay] 找不到内置 Node——无法启动中继");
                inner.state = RelayState::Failed {
                    error: "bundled node not found".to_string(),
                    since: Instant::now(),
                    target,
                };
                return;
            }
        };
        let script = match relay_script_path(app) {
            Some(p) => p,
            None => {
                ulog_error!("[relay] resources/relay.cjs 缺失——打包/下载脚本可能没跑");
                inner.state = RelayState::Failed {
                    error: "relay.cjs missing".to_string(),
                    since: Instant::now(),
                    target,
                };
                return;
            }
        };

        let mut cmd = process_cmd::new(&node);
        cmd.arg(&script)
            .arg("--target-host")
            .arg(&target.host)
            .arg("--target-port")
            .arg(target.port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // 不套 apply_to_subprocess：中继是纯 TCP 管道（node:net），不消费
        // HTTP_PROXY 类环境——HTTP 层的 no_proxy 红线对它不适用。

        match cmd.spawn() {
            Ok(mut child) => {
                let stdout = child.stdout.take().expect("piped stdout");
                let stderr = child.stderr.take().expect("piped stderr");
                inner.epoch += 1;
                let epoch = inner.epoch;
                inner.state = RelayState::Starting {
                    target: target.clone(),
                    since: Instant::now(),
                    child: Some(child),
                    epoch,
                };
                Self::spawn_stderr_drain(stderr);
                Self::spawn_ready_reader(self.inner.clone(), epoch, stdout);
                ulog_info!(
                    "[relay] 中继进程已 spawn（epoch={}）：127.0.0.1 → {}:{}",
                    epoch,
                    target.host,
                    target.port
                );
            }
            Err(e) => {
                ulog_error!("[relay] spawn 中继失败：{}", e);
                inner.state = RelayState::Failed {
                    error: format!("spawn failed: {e}"),
                    since: Instant::now(),
                    target,
                };
            }
        }
    }

    /// READY 行读取线程：首行合法 → Starting→Running（端口可用）；
    /// EOF/非法 → Starting→Failed。被新一轮 ensure 取代（epoch 不匹配）时
    /// 什么都不写——child 已被取代方收尸。
    fn spawn_ready_reader(inner: Arc<Mutex<RelayInner>>, epoch: u64, stdout: ChildStdout) {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let outcome = match reader.read_line(&mut line) {
                Ok(0) => Err("中继未输出 READY 行即退出（stderr 已入统一日志）".to_string()),
                Ok(_) => parse_ready_line(&line).ok_or_else(|| format!("READY 行无法解析：{:?}", line.trim())),
                Err(e) => Err(format!("读取 READY 行失败：{e}")),
            };
            let mut guard = inner.lock().unwrap_or_else(|e| e.into_inner());
            // 先在借用内取齐过渡所需的所有权（child take + 目标克隆），
            // 借用结束后再整体替换状态——避免对 guard.state 部分借用时赋值。
            let transition = match &mut guard.state {
                RelayState::Starting { epoch: e, target, child, .. } if *e == epoch => match outcome {
                    Ok(port) => {
                        let taken = child.take().expect("Starting 态 child 必须存在");
                        Some(Ok((taken, port, target.clone())))
                    }
                    Err(error) => {
                        let taken = child.take().expect("Starting 态 child 必须存在");
                        Some(Err((taken, error, target.clone())))
                    }
                },
                // epoch 不匹配（已被新 ensure 取代）或非 Starting（被 stop
                // 抢先改写）——本线程是孤儿，状态不归它动。
                _ => None,
            };
            match transition {
                Some(Ok((child, port, target))) => {
                    ulog_info!(
                        "[relay] 中继就绪：127.0.0.1:{} → {}:{}",
                        port,
                        target.host,
                        target.port
                    );
                    guard.state = RelayState::Running { child, port, target };
                }
                Some(Err((mut child, error, target))) => {
                    ulog_warn!("[relay] 中继启动失败：{}", error);
                    // 子进程多半已退出（EOF 触发本路径）——收尸幂等。
                    reap_child(&mut child);
                    guard.state = RelayState::Failed {
                        target,
                        error,
                        since: Instant::now(),
                    };
                }
                None => {}
            }
        });
    }

    /// stderr 逐行 drain 进统一日志（防管道缓冲写满把中继卡死）。
    /// relay.cjs 约定 stderr 只写诊断、绝不写 payload/URL/token。
    fn spawn_stderr_drain(stderr: ChildStderr) {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            while reader.read_line(&mut line).unwrap_or(0) > 0 {
                ulog_debug!("[relay] {}", line.trim_end());
                line.clear();
            }
        });
    }
}

/// 中继脚本路径：`<resource_dir>/relay.cjs`（dev 与打包形态同构，
/// bundle.resources 显式映射，见 tauri.conf.json）。出 Rust 边界前剥
/// Windows `\\?\` 前缀（CLAUDE.md 红线）。
fn relay_script_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    let script = dir.join("relay.cjs");
    if script.is_file() {
        Some(crate::sidecar::normalize_external_path(script))
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// 单测（纯逻辑；CI cargo test 跑。本机无 Rust 工具链——见 CLAUDE.md 已知遗留）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{parse_ready_line, parse_relay_target};

    #[test]
    fn parse_target_http_with_port() {
        let t = parse_relay_target("http://192.168.1.8:7411").unwrap();
        assert_eq!(t.host, "192.168.1.8");
        assert_eq!(t.port, 7411);
    }

    #[test]
    fn parse_target_scheme_default_port() {
        assert_eq!(parse_relay_target("http://brain.local").unwrap().port, 80);
        assert_eq!(parse_relay_target("https://brain.example.com").unwrap().port, 443);
    }

    #[test]
    fn parse_target_trims_whitespace_and_slashes() {
        let t = parse_relay_target("  http://10.0.0.8:7411/  ").unwrap();
        assert_eq!(t.host, "10.0.0.8");
        assert_eq!(t.port, 7411);
    }

    #[test]
    fn parse_target_rejects_non_http_scheme() {
        assert!(parse_relay_target("ftp://x:1").is_err());
        assert!(parse_relay_target("ws://x:1").is_err());
    }

    #[test]
    fn parse_target_rejects_garbage() {
        assert!(parse_relay_target("").is_err());
        assert!(parse_relay_target("   ").is_err());
        assert!(parse_relay_target("not a url").is_err());
    }

    #[test]
    fn parse_ready_line_ok() {
        assert_eq!(parse_ready_line("ZHISHI_RELAY_READY 41234\n"), Some(41234));
        assert_eq!(parse_ready_line("ZHISHI_RELAY_READY 41234"), Some(41234));
    }

    #[test]
    fn parse_ready_line_rejects_malformed() {
        assert_eq!(parse_ready_line(""), None);
        assert_eq!(parse_ready_line("READY 1234"), None);
        assert_eq!(parse_ready_line("ZHISHI_RELAY_READY 0"), None);
        assert_eq!(parse_ready_line("ZHISHI_RELAY_READY 99999"), None); // u16 溢出
        assert_eq!(parse_ready_line("ZHISHI_RELAY_READY 12a"), None);
    }
}
