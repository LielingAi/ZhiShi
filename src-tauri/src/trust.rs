//! Trust ledger（信任账本）— 工作生命宪章 §5.1：「自主不是开关，是挣来的。
//! 每一次被验证的完成都是存款，每一次返工都是取款。权限模式（行动/规划/
//! 自主）只是这个账本的外化。」
//!
//! 存储：`~/.zhishi/trust.json`（单写者 = 主 Rust 进程；sidecar / CLI 的
//! 任务状态变更全部汇聚到 `TaskStore::update_status` 这一个收口，钩子就
//! 挂在那里，因此 IPC / management API / scheduler / watchdog 路径全覆盖）。
//!
//! 计分规则（classify）：
//!   - user → done          +2  验收通过（最强信号：人验过了）
//!   - agent/system → done  +1  完成声明（含 endCondition 达标）
//!   - done → running       -3  返工（推翻了一次"完成"；source=rerun 除外——重跑是用户主动再上膛，不是否定）
//!   - running/verifying → stopped by user  -2  否决（人叫停了它）
//!   - 其余迁移              0   不记账（blocked 多为环境问题，不罚）
//!
//! 建议机制（红线：只是建议，升级仍需用户确认——账本永远不写 config）：
//!   score 相对 baselineScore 的增量 ≥ +10 → 挂起 upgrade 建议；
//!   ≤ -6 → 挂起 downgrade 建议。用户「采纳/忽略」后 baselineScore 对齐
//!   当前 score，避免同一水平反复打扰；采纳动作本身由设置页经既有
//!   config 通道改 defaultPermissionMode，与账本解耦。
//!
//! 透明与删除权（§7.4 / P3 红线）：全部事件在设置页可见；`reset` 整体
//! 清空（分数、事件、建议），是用户对共同过去的权力。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::app_dirs::zhishi_data_dir;
use crate::local_http;
use crate::ulog_warn;
use crate::task::{TaskStatus, TransitionActor, TransitionSource};

/// 增量达到 +10 → 建议升一档自主级别。
pub const UPGRADE_THRESHOLD: i32 = 10;
/// 增量跌到 -6 → 建议降一档。
pub const DOWNGRADE_THRESHOLD: i32 = -6;
/// 事件上限（滚动丢弃最旧）——账本有界，不无限增长。
const MAX_EVENTS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustEvent {
    pub ts: i64,
    pub task_id: String,
    pub task_name: String,
    /// 'deposit' | 'withdrawal' | 'decision'
    pub kind: String,
    pub delta: i32,
    /// 'user_done' | 'agent_done' | 'system_done' | 'rework' | 'user_stopped'
    /// | 'suggestion_accepted' | 'suggestion_dismissed'
    pub reason: String,
    pub score_after: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustSuggestion {
    /// 'upgrade' | 'downgrade'
    pub direction: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustLedger {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub score: i32,
    /// 上次建议被处置（采纳/忽略）时的分数基准；建议只看相对增量。
    #[serde(default)]
    pub baseline_score: i32,
    #[serde(default)]
    pub events: Vec<TrustEvent>,
    #[serde(default)]
    pub suggestion: Option<TrustSuggestion>,
}

fn default_version() -> u32 {
    1
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn ledger_path() -> Option<PathBuf> {
    zhishi_data_dir().map(|d| d.join("trust.json"))
}

fn load_ledger() -> TrustLedger {
    let Some(path) = ledger_path() else {
        return TrustLedger {
            version: 1,
            ..Default::default()
        };
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return TrustLedger {
            version: 1,
            ..Default::default()
        };
    };
    serde_json::from_str(&raw).unwrap_or_else(|err| {
        ulog_warn!("[trust] trust.json parse failed ({err}); starting from a fresh ledger");
        TrustLedger {
            version: 1,
            ..Default::default()
        }
    })
}

/// Atomic write: tmp file in the same directory + rename（与 task persist 同策略）。
fn save_ledger(ledger: &TrustLedger) -> Result<(), String> {
    let path = ledger_path().ok_or_else(|| "cannot resolve zhishi data dir".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let json = serde_json::to_string_pretty(ledger).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, json).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename to {}: {e}", path.display()))?;
    Ok(())
}

/// 状态迁移 → 记账条目；None = 不记账。
fn classify(
    from: TaskStatus,
    to: TaskStatus,
    actor: TransitionActor,
    source: Option<TransitionSource>,
) -> Option<(i32, &'static str)> {
    match (from, to, actor) {
        // 返工：一次"完成"被推翻。source=rerun 是用户主动重跑（再上膛），
        // 不是对完成质量的否定，排除。
        (TaskStatus::Done, TaskStatus::Running, _) if source != Some(TransitionSource::Rerun) => {
            Some((-3, "rework"))
        }
        // 否决：人在它干活中途叫停。
        (TaskStatus::Running | TaskStatus::Verifying, TaskStatus::Stopped, TransitionActor::User) => {
            Some((-2, "user_stopped"))
        }
        (_, TaskStatus::Done, TransitionActor::User) => Some((2, "user_done")),
        (_, TaskStatus::Done, TransitionActor::Agent) => Some((1, "agent_done")),
        (_, TaskStatus::Done, TransitionActor::System) => Some((1, "system_done")),
        _ => None,
    }
}

/// 追加事件并按阈值维护 pending 建议。调用方负责 save。
fn apply_event(ledger: &mut TrustLedger, event: TrustEvent) {
    ledger.score = event.score_after;
    ledger.events.push(event);
    if ledger.events.len() > MAX_EVENTS {
        let overflow = ledger.events.len() - MAX_EVENTS;
        ledger.events.drain(0..overflow);
    }
    if ledger.suggestion.is_none() {
        let delta = ledger.score - ledger.baseline_score;
        if delta >= UPGRADE_THRESHOLD {
            ledger.suggestion = Some(TrustSuggestion {
                direction: "upgrade".to_string(),
                created_at: now_ms(),
            });
        } else if delta <= DOWNGRADE_THRESHOLD {
            ledger.suggestion = Some(TrustSuggestion {
                direction: "downgrade".to_string(),
                created_at: now_ms(),
            });
        }
    }
}

/// `TaskStore::update_status` 的钩子：成功迁移持久化后调用。Best-effort——
/// 账本写失败只记日志，绝不影响状态迁移本身（账本是外化，不是账本在记账）。
///
/// 写路径（P3，memory.db 时代）：优先 POST 给全局 sidecar 的
/// `/api/admin/trust/event`（账本本体在 Node 侧 memory.db 的 trust_events 表）；
/// sidecar 不在场（未启动/刚重启）时回落 trust.json 文件账本——Node 侧首次
/// 打开 memory.db 时会自动把它导入（store.migrateLegacy 的 trust.json 段），
/// 不丢账。
pub fn record_transition(
    task_id: &str,
    task_name: &str,
    from: TaskStatus,
    to: TaskStatus,
    actor: TransitionActor,
    source: Option<TransitionSource>,
) {
    let Some((_delta, reason)) = classify(from, to, actor, source) else {
        return;
    };

    let payload = serde_json::json!({
        "taskId": task_id,
        "taskName": task_name,
        "from": from.as_str(),
        "to": to.as_str(),
        "actor": actor.as_str(),
        "source": source.map(|s| s.as_str()),
    });

    match sidecar_port() {
        Some(port) => {
            let task_id_owned = task_id.to_string();
            let task_name_owned = task_name.to_string();
            tauri::async_runtime::spawn(async move {
                let url = format!("http://127.0.0.1:{port}/api/admin/trust/event");
                let client = local_http::json_client(std::time::Duration::from_secs(10));
                match client.post(&url).json(&payload).send().await {
                    Ok(resp) if resp.status().is_success() => {}
                    other => {
                        ulog_warn!(
                            "[trust] sidecar trust/event failed ({:?}), falling back to trust.json",
                            other.map(|r| r.status()).err()
                        );
                        write_fallback_ledger(&task_id_owned, &task_name_owned, _delta, reason);
                    }
                }
            });
        }
        None => {
            write_fallback_ledger(task_id, task_name, _delta, reason);
        }
    }
}

/// 读全局 sidecar 端口（~/.zhishi/sidecar.port；sidecar.rs 启动时写入）。
fn sidecar_port() -> Option<u16> {
    let content = std::fs::read_to_string(zhishi_data_dir()?.join("sidecar.port")).ok()?;
    content.trim().parse::<u16>().ok()
}

/// 离线兜底：沿用文件账本（load/apply/save）。Node 侧首次 openDb 自动导入。
fn write_fallback_ledger(task_id: &str, task_name: &str, delta: i32, reason: &'static str) {
    let result = {
        let mut ledger = load_ledger();
        let score_after = ledger.score + delta;
        apply_event(
            &mut ledger,
            TrustEvent {
                ts: now_ms(),
                task_id: task_id.to_string(),
                task_name: task_name.to_string(),
                kind: if delta >= 0 { "deposit" } else { "withdrawal" }.to_string(),
                delta,
                reason: reason.to_string(),
                score_after,
            },
        );
        save_ledger(&ledger)
    };
    if let Err(err) = result {
        ulog_warn!("[trust] record_transition({reason}, task={task_id}) failed: {err}");
    }
}

// ================ Tests ================

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_ledger() -> TrustLedger {
        TrustLedger {
            version: 1,
            ..Default::default()
        }
    }

    #[test]
    fn classify_scores_verified_completion_as_deposit() {
        assert_eq!(
            classify(
                TaskStatus::Verifying,
                TaskStatus::Done,
                TransitionActor::User,
                Some(TransitionSource::Ui)
            ),
            Some((2, "user_done"))
        );
        assert_eq!(
            classify(
                TaskStatus::Running,
                TaskStatus::Done,
                TransitionActor::Agent,
                Some(TransitionSource::Cli)
            ),
            Some((1, "agent_done"))
        );
        assert_eq!(
            classify(
                TaskStatus::Running,
                TaskStatus::Done,
                TransitionActor::System,
                Some(TransitionSource::EndCondition)
            ),
            Some((1, "system_done"))
        );
    }

    #[test]
    fn classify_scores_rework_and_rejection_as_withdrawal() {
        assert_eq!(
            classify(
                TaskStatus::Done,
                TaskStatus::Running,
                TransitionActor::User,
                Some(TransitionSource::Ui)
            ),
            Some((-3, "rework"))
        );
        assert_eq!(
            classify(
                TaskStatus::Running,
                TaskStatus::Stopped,
                TransitionActor::User,
                Some(TransitionSource::Ui)
            ),
            Some((-2, "user_stopped"))
        );
    }

    #[test]
    fn classify_excludes_rerun_from_rework() {
        // 重跑是用户主动再上膛，不是返工。
        assert_eq!(
            classify(
                TaskStatus::Done,
                TaskStatus::Running,
                TransitionActor::User,
                Some(TransitionSource::Rerun)
            ),
            None
        );
    }

    #[test]
    fn classify_ignores_neutral_transitions() {
        assert_eq!(
            classify(
                TaskStatus::Running,
                TaskStatus::Blocked,
                TransitionActor::Agent,
                Some(TransitionSource::Cli)
            ),
            None
        );
        assert_eq!(
            classify(
                TaskStatus::Todo,
                TaskStatus::Running,
                TransitionActor::System,
                Some(TransitionSource::Scheduler)
            ),
            None
        );
        assert_eq!(
            classify(
                TaskStatus::Running,
                TaskStatus::Stopped,
                TransitionActor::System,
                Some(TransitionSource::Watchdog)
            ),
            None
        );
    }

    fn push(ledger: &mut TrustLedger, delta: i32, reason: &str) {
        let score_after = ledger.score + delta;
        apply_event(
            ledger,
            TrustEvent {
                ts: 1,
                task_id: "t".into(),
                task_name: "n".into(),
                kind: if delta >= 0 { "deposit" } else { "withdrawal" }.into(),
                delta,
                reason: reason.into(),
                score_after,
            },
        );
    }

    #[test]
    fn suggestion_pends_on_upgrade_threshold() {
        let mut ledger = fresh_ledger();
        for _ in 0..5 {
            push(&mut ledger, 2, "user_done");
        }
        assert_eq!(ledger.score, 10);
        assert_eq!(
            ledger.suggestion.as_ref().map(|s| s.direction.as_str()),
            Some("upgrade")
        );
        // pending 期间不重复挂建议。
        push(&mut ledger, 2, "user_done");
        assert_eq!(ledger.suggestion.as_ref().map(|s| s.direction.as_str()), Some("upgrade"));
    }

    #[test]
    fn suggestion_pends_on_downgrade_threshold() {
        let mut ledger = fresh_ledger();
        push(&mut ledger, -3, "rework");
        push(&mut ledger, -3, "rework");
        assert_eq!(
            ledger.suggestion.as_ref().map(|s| s.direction.as_str()),
            Some("downgrade")
        );
    }

    #[test]
    fn resolve_suggestion_rebases_and_leaves_decision_event() {
        let mut ledger = fresh_ledger();
        for _ in 0..5 {
            push(&mut ledger, 2, "user_done");
        }
        assert!(ledger.suggestion.is_some());
        // 模拟 resolve：先取走 pending 建议（resolve_suggestion 的 take），
        // 再 baseline 对齐 + decision 事件，不再立即重挂。
        ledger.suggestion = None;
        ledger.baseline_score = ledger.score;
        let score = ledger.score;
        apply_event(
            &mut ledger,
            TrustEvent {
                ts: 2,
                task_id: String::new(),
                task_name: String::new(),
                kind: "decision".into(),
                delta: 0,
                reason: "suggestion_accepted_upgrade".into(),
                score_after: score,
            },
        );
        assert!(ledger.suggestion.is_none());
        assert_eq!(ledger.baseline_score, 10);
        // 再存 4 分（增量 < 10）不挂建议；攒到 +10 才再次建议。
        push(&mut ledger, 2, "user_done");
        push(&mut ledger, 2, "user_done");
        assert!(ledger.suggestion.is_none());
        for _ in 0..3 {
            push(&mut ledger, 2, "user_done");
        }
        assert!(ledger.suggestion.is_some());
    }

    #[test]
    fn events_are_capped() {
        let mut ledger = fresh_ledger();
        for _ in 0..(MAX_EVENTS + 20) {
            push(&mut ledger, 1, "agent_done");
        }
        assert_eq!(ledger.events.len(), MAX_EVENTS);
        assert_eq!(ledger.score, (MAX_EVENTS + 20) as i32);
    }
}
