// Startup seed jobs + shared path-safety validation.
//
// W6 subtraction (windowless host): every `#[tauri::command]` registration was
// deleted — the renderer is gone and nothing else invokes IPC. What remains:
//
// 1. The three startup seed jobs (system skills / environment recipes /
//    bundled agents), called directly from `lib.rs` `.setup()` — no longer
//    Tauri commands, just async fns taking the AppHandle.
// 2. `validate_file_path` + its blacklist, reused by
//    `workspace_files::path_safety` (panel_api / sidecar path validation).

use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

use crate::{ulog_info, ulog_warn};

// ============= System Skills Sync =============
//
// A distinct tier from the "seed once" bundled-skills behaviour
// (src/server/skills-config.ts::seedBundledSkills). Those are open-ended
// utility skills users are encouraged to customise — we copy them in on
// first launch and then never touch them again.
//
// System skills are different: they encode flow-level contracts that
// must evolve in lockstep with Rust / CLI / shape changes. Example:
// `/task-implement` used to call `zhishi task update-progress <id>
// "..."`; when we removed that CLI in v0.1.69+ the skill had to update
// in the same release, else existing users' AI calls would fail with
// "unknown command". The seed-once path can't deliver updates — we
// need version-gated force-overwrite, same pattern as ADMIN_AGENT
// and CLI above.
//
// To add a new system skill: put the folder in bundled-skills/, append
// its name to SYSTEM_SKILLS below, and bump SYSTEM_SKILLS_VERSION. The
// matching exclusion list in src/server/skills-config.ts MUST be kept
// in sync (comment there points back here).

const SYSTEM_SKILLS_VERSION: &str = "37";

/// Skills that ship with the app and MUST stay at the bundled version —
/// the app's flows depend on them, users are not meant to customise.
/// Keep in sync with the exclusion list in Node `src/server/skills-config.ts`.
const SYSTEM_SKILLS: &[&str] = &[
    "task-alignment",
    "task-implement",
    // v10: ultra-research removed — not generic enough to ship as system
    // skill. Existing installs retain the dir at ~/.zhishi/skills/
    // ultra-research/ until the user deletes it (no orphan cleanup logic).
    "download-anything",
    // v8: agent-browser promoted from utility → system skill. The CLI is
    // no longer bundled with the app; the SKILL.md teaches AI to self-install
    // on first use with a command-local npm prefix. Existing users
    // need the updated SKILL.md to land or their AI will hit `command not
    // found` after upgrading. The install uses command-local npm_config_prefix
    // so it lands under ~/.zhishi/npm-global without leaking prefix env to
    // every shell. System-skill status forces the overwrite.
    "agent-browser",
    // v9: zhishi-cli promoted from helper-bundled skill (now removed)
    // to a global system skill. Every AI session inside ZhiShi — Chat / IM Bot
    // / Cron — should be able to drive the product's own
    // capabilities (cron, task center, MCP, Provider, channels,
    // skills, widgets) through the CLI. SKILL.md changes track CLI surface
    // changes, so it must force-overwrite on version bumps.
    "zhishi-cli",
    // v36: app-automation 随 1.2.3 AppCraft 退役移除——录制/回放/自愈链路与其
    // sidecar 二进制（cuse / terminator-mcp-agent）整体切除。已 seed 的老目录
    // 留在 ~/.zhishi/skills/app-automation/ 由用户自处（无孤儿清理逻辑，同 v10/v29 惯例）。
    // v29: capability-forge 与通用生产力 skills（docx/pdf/pptx/xlsx/
    // skill-creator）随安全研究员版减法删除（设计 docs/
    // security_researcher_agent_design.md §9）。已 seed 的老目录留在
    // ~/.zhishi/skills/ 由用户自处（无孤儿清理逻辑，同 v10 惯例）。
    // 注：plugin-assistant 随加密插件体系整体移除而删除。
    // v30: 安全研究员版 P1 S2 —— 首批 4 个安全方法 skills
    // （技术方案 docs/spec/security_researcher_agent_tech_plan.md §2.2）：
    // native-code-loop（编译-运行-调试闭环）、binary-exploit（二进制利用实战）、
    // vuln-triage（崩溃研判 → bug_class）、range-ops（靶场连接规范）。
    // 全平台可用，无需 platform block。
    "native-code-loop",
    "binary-exploit",
    "vuln-triage",
    "range-ops",
    // v35: 1.1.8 三域实战验证修正落盘——pentest / whitebox-audit /
    // ai-security 升 system（与 binary-exploit 同待遇：方法论由产品维护、
    // 随版本强制覆盖；此前非 system 时 seed-once 导致修正无法触达老安装）。
    "pentest",
    "whitebox-audit",
    "ai-security",
];

/// Skills unavailable on certain platforms due to upstream bugs.
/// MUST stay in sync with `src/server/utils/platform.ts::PLATFORM_BLOCKED_SKILLS`.
/// Used by `cmd_sync_system_skills` to skip force-syncing skills that the
/// Node-side runtime would later filter out anyway — prevents orphan files
/// in `~/.zhishi/skills/` that confuse users.
fn is_skill_blocked_on_platform(skill_folder: &str) -> bool {
    match skill_folder {
        // agent-browser daemon broken on Windows: vercel-labs/agent-browser#398
        "agent-browser" => cfg!(target_os = "windows"),
        _ => false,
    }
}

/// Force-sync every system skill from the app bundle to
/// `~/.zhishi/skills/<name>/`. Runs once per `SYSTEM_SKILLS_VERSION`
/// bump — idempotent otherwise. User edits to these directories will
/// be overwritten when the version changes, by design (see module
/// comment above).
pub async fn cmd_sync_system_skills<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Use the canonical data directory so portable mode (`.data_mode` next to the
        // executable) keeps system skills alongside user data instead of leaking into
        // the host home directory.
        let zhishi_dir = crate::app_dirs::zhishi_data_dir().ok_or("ZhiShi data dir not found")?;
        let skills_dir = zhishi_dir.join("skills");

        // Version gate — skip the whole sweep if we've already landed
        // SYSTEM_SKILLS_VERSION AND every system skill is actually present on disk.
        //
        // The version stamp alone is NOT proof the install is healthy (issue #321):
        // the old destructive sync could write the version after leaving empty
        // `~/.zhishi/skills/<name>/` dirs, freezing that broken state forever.
        // Validating the on-disk result here makes the gate self-healing — a frozen
        // or incomplete install re-runs the (now non-destructive) sync regardless of
        // whether the version happened to be bumped. Healthy installs still
        // early-return after the cheap per-skill SKILL.md stat.
        let ver_file = zhishi_dir.join(".system-skills-version");
        if ver_file.exists() {
            let ver = fs::read_to_string(&ver_file).unwrap_or_default();
            if ver.trim() == SYSTEM_SKILLS_VERSION
                && all_installed_system_skills_complete(&skills_dir)
            {
                return Ok(false);
            }
        }

        // Source: app bundle resources/bundled-skills/
        let res = app_handle
            .path()
            .resource_dir()
            .map_err(|e| format!("Resource dir: {}", e))?;
        let bundled_skills_dir = res.join("bundled-skills");
        if !bundled_skills_dir.exists() {
            return Err(format!("bundled-skills not found: {:?}", bundled_skills_dir));
        }

        fs::create_dir_all(&skills_dir)
            .map_err(|e| format!("Failed to create skills dir: {}", e))?;

        let mut synced = Vec::new();
        let mut missing = Vec::new();
        let mut incomplete = Vec::new();
        let mut platform_skipped = Vec::new();
        for skill_name in SYSTEM_SKILLS {
            // Platform block: keep parity with Node-side `isSkillBlockedOnPlatform`
            // (src/server/utils/platform.ts). Without this, a skill marked
            // unavailable on the current platform (e.g. agent-browser on Windows
            // due to upstream daemon bug) would be force-synced into
            // ~/.zhishi/skills/ but invisible to the SDK runtime — orphan
            // disk files that confuse users and serve no purpose.
            if is_skill_blocked_on_platform(skill_name) {
                platform_skipped.push(*skill_name);
                continue;
            }
            let src = bundled_skills_dir.join(skill_name);
            let dst = skills_dir.join(skill_name);
            match sync_one_system_skill(&src, &dst).map_err(|e| format!("sync {}: {}", skill_name, e))? {
                SystemSkillSync::Synced => synced.push(*skill_name),
                SystemSkillSync::SkippedMissingSource => {
                    // Packaging miss — skill listed in SYSTEM_SKILLS but absent
                    // from the bundle. Log and continue so one missing skill
                    // doesn't block the rest.
                    ulog_warn!("[system-skills] bundled skill missing: {}", skill_name);
                    missing.push(skill_name.to_string());
                }
                SystemSkillSync::SkippedIncompleteSource => {
                    // Packaging miss — the bundled source dir exists but has no
                    // SKILL.md (issue #321: the Windows resource tree shipped some
                    // system skills empty). `sync_one_system_skill` left any
                    // existing good copy untouched. Don't advance the version gate
                    // below so a corrected bundle re-syncs on the next launch.
                    ulog_warn!(
                        "[system-skills] bundled skill incomplete (no SKILL.md), preserved existing copy: {}",
                        skill_name
                    );
                    incomplete.push(skill_name.to_string());
                }
            }
        }

        // Only advance the version gate when every system skill actually landed.
        // A missing/incomplete bundled source is a packaging defect; freezing the
        // version on a partial sweep would make the broken state permanent (the
        // old behavior that produced empty `~/.zhishi/skills/<name>` dirs on
        // Windows — issue #321). Leaving the version unwritten retries next launch
        // and keeps the warnings above visible. Platform-skipped skills are
        // intentional, not defects, so they don't block the advance.
        let complete = missing.is_empty() && incomplete.is_empty();
        if complete {
            fs::write(&ver_file, SYSTEM_SKILLS_VERSION)
                .map_err(|e| format!("version write failed: {}", e))?;
        }

        ulog_info!(
            "[system-skills] Synced v{} (complete={}) — ok: {:?}, missing: {:?}, incomplete: {:?}, platform-skipped: {:?}",
            SYSTEM_SKILLS_VERSION,
            complete,
            synced,
            missing,
            incomplete,
            platform_skipped
        );
        Ok(complete)

    })
    .await
    .map_err(|e| format!("blocking task join failed: {e}"))?
}

/// Outcome of syncing one system skill from the app bundle into
/// `~/.zhishi/skills/`.
enum SystemSkillSync {
    /// Source was valid and copied over `dst`.
    Synced,
    /// Source directory does not exist in the bundle at all.
    SkippedMissingSource,
    /// Source directory exists but is not a valid skill (no SKILL.md). The
    /// existing `dst`, if any, was left untouched.
    SkippedIncompleteSource,
}

/// A skill directory is "complete" iff it carries a top-level `SKILL.md` — the
/// one file every SKILL.md-gated scanner (Settings panel, slash picker, SDK
/// runtime) requires to recognize a skill. An empty / SKILL.md-less directory
/// is a packaging defect, not a skill. Applies equally to a bundled source dir
/// and an installed `~/.zhishi/skills/<name>` dir.
fn skill_dir_is_complete(dir: &Path) -> bool {
    dir.join("SKILL.md").is_file()
}

/// True iff every system skill that SHOULD be installed on this platform has a
/// valid SKILL.md on disk under `skills_dir`. Platform-blocked skills are
/// intentionally absent and don't count against completeness. Used to bypass
/// the version fast-path so a frozen/incomplete install (issue #321) self-heals
/// instead of trusting the version stamp.
fn all_installed_system_skills_complete(skills_dir: &Path) -> bool {
    SYSTEM_SKILLS.iter().all(|name| {
        is_skill_blocked_on_platform(name) || skill_dir_is_complete(&skills_dir.join(name))
    })
}

/// Sync one system skill `src` → `dst`. Refuses to clear an existing good
/// `dst` unless the source is a complete skill, so a packaging miss can never
/// replace a working installed copy with an empty directory (issue #321: the
/// old path did `remove_dir_all(dst)` BEFORE merging, so an empty bundled
/// source destroyed the user's copy and then wrote the version file, making
/// the empty state permanent and invisible to every panel/scan).
fn sync_one_system_skill(src: &Path, dst: &Path) -> Result<SystemSkillSync, String> {
    if !src.exists() {
        return Ok(SystemSkillSync::SkippedMissingSource);
    }
    if !skill_dir_is_complete(src) {
        return Ok(SystemSkillSync::SkippedIncompleteSource);
    }
    // Source is a valid skill — safe to replace the existing target wholesale.
    // SYSTEM_SKILLS_VERSION bumps mean "the whole skill snapshot is new".
    //
    // Path::exists() follows symlinks → returns false for broken links, so a
    // dangling `~/.zhishi/skills/<name>` left by the user (e.g. pointing at
    // a moved repo) would slip past and then trip `fs::create_dir_all` in
    // `merge_dir_recursive` with EEXIST, failing the whole startup sync.
    // symlink_metadata() does NOT follow, so it's the right probe for "is
    // there anything at this path, even a dangling link?".
    match fs::symlink_metadata(dst) {
        Ok(meta) => {
            let removed = if meta.file_type().is_symlink() || meta.is_file() {
                fs::remove_file(dst)
            } else {
                fs::remove_dir_all(dst)
            };
            if let Err(e) = removed {
                ulog_warn!(
                    "[system-skills] failed to clear {}: {} — falling back to merge",
                    dst.display(),
                    e
                );
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Nothing there, fresh seed below.
        }
        Err(e) => {
            ulog_warn!(
                "[system-skills] symlink_metadata({}) failed: {} — falling back to merge",
                dst.display(),
                e
            );
        }
    }
    merge_dir_recursive(src, dst).map_err(|e| e.to_string())?;
    Ok(SystemSkillSync::Synced)
}

/// Merge src/ into dst/ recursively. Creates missing dirs, overwrites files, never deletes.
fn merge_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == ".git" || name == "node_modules" { continue; }
        let ft = entry.file_type()?;
        if ft.is_symlink() { continue; }
        let d = dst.join(&name);
        if ft.is_dir() {
            merge_dir_recursive(&entry.path(), &d)?;
        } else {
            fs::copy(entry.path(), &d)?;
        }
    }
    Ok(())
}

// ============= Environment Recipes Seed =============
//
// 安全研究员版 P1 E4 — environment recipe（环境配方）播种。我们不分发工具，
// 分发「能把干净环境变成研究现场」的配方（bundled-environments/<name>/
// Dockerfile + setup.sh + SKILL.md）。
//
// 与 SYSTEM_SKILLS 的版本语义刻意不同：skills 是产品所有、版本 bump 强制
// 覆盖；配方要允许用户/LLM 迭代（「环境内自装 → 沉淀回配方」），所以策略是
// **seed-if-missing**——已落盘的配方目录永不覆盖；ENVIRONMENT_RECIPES_VERSION
// bump 只控制「何时再跑一轮播种」（首轮 / bump / 自愈缺失），每一轮内单个
// 配方仍是缺失才落盘。新增随包配方 = bundled-environments/ 建目录 + bump
// 下面的版本号。
//
// v6（1.2.5「组」阶段）：① 新增 pentest-vm 配方（pentest 双形态）；② 六个
// docker 配方按选型终稿 v2 换工具集（pentest +nuclei/SecLists/netexec/ZAP/
// Playwright 等；pwn -ropper/-standalone checksec +patchelf/pwninit/
// seccomp-tools/one_gadget/libc 两件套；rev +radare2/ghidriff；fuzz
// +libFuzzer 支持件；code-audit semgrep→opengrep +ast-grep/joern/bandit；
// ai-security +pyrit）；③ tools[] 全部改真实二进制名（toolCheck 依赖）。
// 注意 seed-if-missing：已落盘的老配方目录不覆盖——v6 的配方修正只触达
// 新安装与缺失自愈，老用户拿到的只是新增的 pentest-vm。

const ENVIRONMENT_RECIPES_VERSION: &str = "6";

/// 配方源目录的判定：bundled-environments/ 下的子目录且含 SKILL.md
/// （与 Node 侧 src/server/environment/recipes.ts 的扫描口径一致——无
/// SKILL.md 的目录不是配方）。
fn recipe_dir_is_complete(dir: &Path) -> bool {
    dir.join("SKILL.md").is_file()
}

/// Outcome of one seed sweep (seed-if-missing per recipe).
struct RecipeSeedOutcome {
    /// Newly copied recipe ids.
    seeded: Vec<String>,
    /// Already on disk — preserved untouched (user/LLM iterations win).
    kept: Vec<String>,
    /// Bundled subdirs that lack SKILL.md — packaging defects; block the
    /// version advance so a corrected bundle re-seeds next launch.
    incomplete_sources: Vec<String>,
}

/// True iff every complete bundled recipe has a directory under `env_dir`.
/// Used to bypass the version fast-path so a deleted recipe self-heals.
fn all_bundled_recipes_present(bundled_dir: &Path, env_dir: &Path) -> bool {
    let entries = match fs::read_dir(bundled_dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    entries.filter_map(|e| e.ok()).all(|entry| {
        let path = entry.path();
        if !path.is_dir() {
            return true; // stray files (README.md) are not recipes
        }
        if !recipe_dir_is_complete(&path) {
            return true; // incomplete sources handled (and reported) by the sweep
        }
        env_dir.join(entry.file_name()).is_dir()
    })
}

/// Seed bundled recipes into `env_dir`, seed-if-missing per recipe. Never
/// overwrites an existing recipe directory. Reuses the same merge helper as
/// the skills sync for the actual copy.
fn seed_environment_recipes(bundled_dir: &Path, env_dir: &Path) -> Result<RecipeSeedOutcome, String> {
    let mut outcome = RecipeSeedOutcome {
        seeded: Vec::new(),
        kept: Vec::new(),
        incomplete_sources: Vec::new(),
    };
    fs::create_dir_all(env_dir).map_err(|e| format!("Failed to create environments dir: {}", e))?;
    let entries = fs::read_dir(bundled_dir)
        .map_err(|e| format!("Failed to read bundled-environments: {}", e))?;
    for entry in entries.filter_map(|e| e.ok()) {
        let src = entry.path();
        if !src.is_dir() {
            continue; // stray files (README.md) are not recipes
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !recipe_dir_is_complete(&src) {
            ulog_warn!(
                "[env-recipes] bundled recipe incomplete (no SKILL.md), skipped: {}",
                name
            );
            outcome.incomplete_sources.push(name);
            continue;
        }
        let dst = env_dir.join(entry.file_name());
        // seed-if-missing：用户/LLM 对已落盘配方的迭代永不覆盖。用
        // symlink_metadata 探（CLAUDE.md 红线：Path::exists() 跟随
        // symlink，断链会漏判）。
        match fs::symlink_metadata(&dst) {
            Ok(_) => {
                outcome.kept.push(name);
                continue;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                ulog_warn!("[env-recipes] symlink_metadata({}) failed: {} — skipping", dst.display(), e);
                outcome.kept.push(name);
                continue;
            }
        }
        merge_dir_recursive(&src, &dst).map_err(|e| format!("seed {}: {}", name, e))?;
        outcome.seeded.push(name);
    }
    Ok(outcome)
}

/// Seed bundled environment recipes from the app bundle to
/// `~/.zhishi/environments/`. Runs once per `ENVIRONMENT_RECIPES_VERSION`
/// bump (or when a bundled recipe is missing on disk — self-heal);
/// seed-if-missing within a sweep, so user edits are never overwritten
/// (unlike cmd_sync_system_skills' force-overwrite — see module comment).
pub async fn cmd_seed_environment_recipes<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Canonical data dir (portable-mode aware), same as system skills.
        let zhishi_dir = crate::app_dirs::zhishi_data_dir().ok_or("ZhiShi data dir not found")?;
        let env_dir = zhishi_dir.join("environments");

        // Source: app bundle resources/bundled-environments/
        let res = app_handle
            .path()
            .resource_dir()
            .map_err(|e| format!("Resource dir: {}", e))?;
        let bundled_dir = res.join("bundled-environments");
        if !bundled_dir.exists() {
            return Err(format!("bundled-environments not found: {:?}", bundled_dir));
        }

        // Version gate — skip when we've already landed this version AND every
        // bundled recipe is actually present (self-healing, same reasoning as
        // the system-skills gate / issue #321).
        let ver_file = zhishi_dir.join(".environment-recipes-version");
        if ver_file.exists() {
            let ver = fs::read_to_string(&ver_file).unwrap_or_default();
            if ver.trim() == ENVIRONMENT_RECIPES_VERSION
                && all_bundled_recipes_present(&bundled_dir, &env_dir)
            {
                return Ok(false);
            }
        }

        let outcome = seed_environment_recipes(&bundled_dir, &env_dir)?;

        // Only advance the version gate when no packaging defects were seen —
        // incomplete bundled sources retry next launch (same discipline as
        // the system-skills gate).
        let complete = outcome.incomplete_sources.is_empty();
        if complete {
            fs::write(&ver_file, ENVIRONMENT_RECIPES_VERSION)
                .map_err(|e| format!("version write failed: {}", e))?;
        }

        ulog_info!(
            "[env-recipes] Seeded v{} (complete={}) — seeded: {:?}, kept: {:?}, incomplete: {:?}",
            ENVIRONMENT_RECIPES_VERSION,
            complete,
            outcome.seeded,
            outcome.kept,
            outcome.incomplete_sources
        );
        Ok(complete)
    })
    .await
    .map_err(|e| format!("blocking task join failed: {e}"))?
}

// ============= Bundled Agents Seed =============
//
// 安全研究员版 P1 A1 — 内置安全 subagent（fuzz-runner / crash-triager）播种。
// agent 定义照 folder 布局（bundled-agents/<name>/<name>.md）随包分发，落盘到
// 用户级 `~/.zhishi/agents/`——agent-loader 扫描该目录 + 项目级
// <workspace>/.claude/agents，folder/flat/nested 三布局都认，模型经 Task 工具委派。
//
// 语义与 cmd_seed_environment_recipes 一致（seed-if-missing + 版本门），而非
// system skills 的强制覆盖：agent 定义同样允许用户在 UI/文件层迭代（agent-loader
// 支持 _meta.json、启停配置），已落盘的 agent 目录永不覆盖；BUNDLED_AGENTS_VERSION
// bump 只控制「何时再跑一轮播种」。新增随包 agent = bundled-agents/ 建目录 +
// bump 下面的版本号。

const BUNDLED_AGENTS_VERSION: &str = "1";

/// agent 源目录的判定：bundled-agents/<name>/ 下含 <name>.md——与 agent-loader
/// 的 folder 布局（ZhiShi canonical，agent-loader.ts classifyLayout）口径一致。
fn agent_dir_is_complete(dir: &Path) -> bool {
    let name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
    !name.is_empty() && dir.join(format!("{}.md", name)).is_file()
}

/// Outcome of one seed sweep (seed-if-missing per agent).
struct AgentSeedOutcome {
    /// Newly copied agent names.
    seeded: Vec<String>,
    /// Already on disk — preserved untouched (user iterations win).
    kept: Vec<String>,
    /// Bundled subdirs that lack <name>.md — packaging defects; block the
    /// version advance so a corrected bundle re-seeds next launch.
    incomplete_sources: Vec<String>,
}

/// True iff every complete bundled agent has a directory under `agents_dir`.
/// Used to bypass the version fast-path so a deleted agent self-heals.
fn all_bundled_agents_present(bundled_dir: &Path, agents_dir: &Path) -> bool {
    let entries = match fs::read_dir(bundled_dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    entries.filter_map(|e| e.ok()).all(|entry| {
        let path = entry.path();
        if !path.is_dir() {
            return true; // stray files (README.md) are not agents
        }
        if !agent_dir_is_complete(&path) {
            return true; // incomplete sources handled (and reported) by the sweep
        }
        agents_dir.join(entry.file_name()).is_dir()
    })
}

/// Seed bundled agents into `agents_dir`, seed-if-missing per agent. Never
/// overwrites an existing agent directory. Reuses the same merge helper as
/// the skills sync for the actual copy.
fn seed_bundled_agents(bundled_dir: &Path, agents_dir: &Path) -> Result<AgentSeedOutcome, String> {
    let mut outcome = AgentSeedOutcome {
        seeded: Vec::new(),
        kept: Vec::new(),
        incomplete_sources: Vec::new(),
    };
    fs::create_dir_all(agents_dir).map_err(|e| format!("Failed to create agents dir: {}", e))?;
    let entries = fs::read_dir(bundled_dir)
        .map_err(|e| format!("Failed to read bundled-agents: {}", e))?;
    for entry in entries.filter_map(|e| e.ok()) {
        let src = entry.path();
        if !src.is_dir() {
            continue; // stray files (README.md) are not agents
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !agent_dir_is_complete(&src) {
            ulog_warn!(
                "[bundled-agents] bundled agent incomplete (no {}.md), skipped: {}",
                name,
                name
            );
            outcome.incomplete_sources.push(name);
            continue;
        }
        let dst = agents_dir.join(entry.file_name());
        // seed-if-missing：用户对已落盘 agent 的迭代（改 prompt/加 _meta.json）
        // 永不覆盖。用 symlink_metadata 探（CLAUDE.md 红线：Path::exists()
        // 跟随 symlink，断链会漏判）。
        match fs::symlink_metadata(&dst) {
            Ok(_) => {
                outcome.kept.push(name);
                continue;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                ulog_warn!("[bundled-agents] symlink_metadata({}) failed: {} — skipping", dst.display(), e);
                outcome.kept.push(name);
                continue;
            }
        }
        merge_dir_recursive(&src, &dst).map_err(|e| format!("seed {}: {}", name, e))?;
        outcome.seeded.push(name);
    }
    Ok(outcome)
}

/// Seed bundled security subagents (fuzz-runner / crash-triager) from the app
/// bundle to `~/.zhishi/agents/`. Runs once per `BUNDLED_AGENTS_VERSION` bump
/// (or when a bundled agent is missing on disk — self-heal); seed-if-missing
/// within a sweep, so user edits are never overwritten.
pub async fn cmd_seed_bundled_agents<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Canonical data dir (portable-mode aware), same as system skills.
        let zhishi_dir = crate::app_dirs::zhishi_data_dir().ok_or("ZhiShi data dir not found")?;
        let agents_dir = zhishi_dir.join("agents");

        // Source: app bundle resources/bundled-agents/
        let res = app_handle
            .path()
            .resource_dir()
            .map_err(|e| format!("Resource dir: {}", e))?;
        let bundled_dir = res.join("bundled-agents");
        if !bundled_dir.exists() {
            return Err(format!("bundled-agents not found: {:?}", bundled_dir));
        }

        // Version gate — skip when we've already landed this version AND every
        // bundled agent is actually present (self-healing, same reasoning as
        // the system-skills gate / issue #321).
        let ver_file = zhishi_dir.join(".bundled-agents-version");
        if ver_file.exists() {
            let ver = fs::read_to_string(&ver_file).unwrap_or_default();
            if ver.trim() == BUNDLED_AGENTS_VERSION
                && all_bundled_agents_present(&bundled_dir, &agents_dir)
            {
                return Ok(false);
            }
        }

        let outcome = seed_bundled_agents(&bundled_dir, &agents_dir)?;

        // Only advance the version gate when no packaging defects were seen —
        // incomplete bundled sources retry next launch (same discipline as
        // the system-skills gate).
        let complete = outcome.incomplete_sources.is_empty();
        if complete {
            fs::write(&ver_file, BUNDLED_AGENTS_VERSION)
                .map_err(|e| format!("version write failed: {}", e))?;
        }

        ulog_info!(
            "[bundled-agents] Seeded v{} (complete={}) — seeded: {:?}, kept: {:?}, incomplete: {:?}",
            BUNDLED_AGENTS_VERSION,
            complete,
            outcome.seeded,
            outcome.kept,
            outcome.incomplete_sources
        );
        Ok(complete)
    })
    .await
    .map_err(|e| format!("blocking task join failed: {e}"))?
}

#[cfg(test)]
mod system_skills_tests {
    use super::{
        all_installed_system_skills_complete, is_skill_blocked_on_platform, skill_dir_is_complete,
        sync_one_system_skill, SystemSkillSync, SYSTEM_SKILLS,
    };
    use std::fs;

    // Issue #321: a Windows install shipped some system-skill source dirs
    // empty (no SKILL.md). The old sync removed the user's good copy, merged
    // the empty source, then wrote the version file — freezing an empty,
    // panel-invisible directory permanently. These tests pin the invariant
    // that an incomplete source can never destroy a working copy, and that the
    // version gate validates on-disk state rather than trusting the stamp.

    #[test]
    fn complete_requires_skill_md() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("foo");
        fs::create_dir_all(&dir).unwrap();
        assert!(!skill_dir_is_complete(&dir), "empty dir is not a skill");
        fs::write(dir.join("SKILL.md"), "x").unwrap();
        assert!(skill_dir_is_complete(&dir), "dir with SKILL.md is a skill");
    }

    #[test]
    fn version_gate_validation_detects_frozen_install() {
        // Lay down every platform-available system skill WITH a SKILL.md →
        // gate may early-return. Then blank one out → gate must bypass so the
        // (non-destructive) re-sync runs and self-heals.
        let tmp = tempfile::tempdir().unwrap();
        let skills_dir = tmp.path().join("skills");
        for name in SYSTEM_SKILLS {
            if is_skill_blocked_on_platform(name) {
                continue;
            }
            let d = skills_dir.join(name);
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("SKILL.md"), "x").unwrap();
        }
        assert!(
            all_installed_system_skills_complete(&skills_dir),
            "all SKILL.md present → install is complete"
        );

        // Freeze one into the empty-dir state seen in #321.
        let victim = SYSTEM_SKILLS
            .iter()
            .find(|n| !is_skill_blocked_on_platform(n))
            .expect("at least one platform-available system skill");
        fs::remove_file(skills_dir.join(victim).join("SKILL.md")).unwrap();
        assert!(
            !all_installed_system_skills_complete(&skills_dir),
            "a SKILL.md-less system skill must fail the gate so sync re-runs"
        );
    }

    #[test]
    fn missing_source_reports_missing_and_leaves_dst() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src/skill"); // never created
        let dst = tmp.path().join("dst/skill");
        fs::create_dir_all(&dst).unwrap();
        fs::write(dst.join("SKILL.md"), "good").unwrap();
        let outcome = sync_one_system_skill(&src, &dst).unwrap();
        assert!(matches!(outcome, SystemSkillSync::SkippedMissingSource));
        assert_eq!(fs::read_to_string(dst.join("SKILL.md")).unwrap(), "good");
    }

    #[test]
    fn incomplete_source_preserves_existing_good_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src/skill");
        fs::create_dir_all(&src).unwrap(); // source exists but has NO SKILL.md
        fs::write(src.join("README.md"), "noise").unwrap();
        let dst = tmp.path().join("dst/skill");
        fs::create_dir_all(&dst).unwrap();
        fs::write(dst.join("SKILL.md"), "good").unwrap();

        let outcome = sync_one_system_skill(&src, &dst).unwrap();
        assert!(matches!(outcome, SystemSkillSync::SkippedIncompleteSource));
        assert!(
            dst.join("SKILL.md").exists(),
            "an incomplete bundled source must NOT destroy the installed copy"
        );
        assert_eq!(fs::read_to_string(dst.join("SKILL.md")).unwrap(), "good");
    }

    #[test]
    fn valid_source_replaces_dst_wholesale() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src/skill");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("SKILL.md"), "new").unwrap();
        let dst = tmp.path().join("dst/skill");
        fs::create_dir_all(&dst).unwrap();
        fs::write(dst.join("SKILL.md"), "old").unwrap();
        // A stale file under dst must be gone after a wholesale replace.
        fs::write(dst.join("stale.txt"), "stale").unwrap();

        let outcome = sync_one_system_skill(&src, &dst).unwrap();
        assert!(matches!(outcome, SystemSkillSync::Synced));
        assert_eq!(fs::read_to_string(dst.join("SKILL.md")).unwrap(), "new");
        assert!(!dst.join("stale.txt").exists(), "wholesale replace drops stale files");
    }
}

#[cfg(test)]
mod environment_recipes_tests {
    use super::{
        all_bundled_recipes_present, recipe_dir_is_complete, seed_environment_recipes,
    };
    use std::fs;

    fn make_bundled_recipe(root: &std::path::Path, name: &str, with_skill: bool) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("Dockerfile"), "FROM ubuntu\n").unwrap();
        if with_skill {
            fs::write(dir.join("SKILL.md"), "---\nname: x\nbase: docker\n---\n").unwrap();
        }
    }

    #[test]
    fn seed_if_missing_copies_new_recipes() {
        let tmp = tempfile::tempdir().unwrap();
        let bundled = tmp.path().join("bundled-environments");
        fs::create_dir_all(&bundled).unwrap();
        make_bundled_recipe(&bundled, "web-recon", true);
        let env_dir = tmp.path().join("environments");

        let outcome = seed_environment_recipes(&bundled, &env_dir).unwrap();
        assert_eq!(outcome.seeded, vec!["web-recon".to_string()]);
        assert!(outcome.kept.is_empty());
        assert!(outcome.incomplete_sources.is_empty());
        assert!(env_dir.join("web-recon/Dockerfile").is_file());
        assert!(env_dir.join("web-recon/SKILL.md").is_file());
    }

    #[test]
    fn seed_if_missing_never_overwrites_user_iterations() {
        // 配方允许用户/LLM 迭代（「环境内自装 → 沉淀回配方」）——已落盘的
        // 配方目录在版本 bump 重播种时也必须原样保留（与 system skills 的
        // 强制覆盖语义相反）。
        let tmp = tempfile::tempdir().unwrap();
        let bundled = tmp.path().join("bundled-environments");
        fs::create_dir_all(&bundled).unwrap();
        make_bundled_recipe(&bundled, "web-recon", true);
        let env_dir = tmp.path().join("environments");
        let dst = env_dir.join("web-recon");
        fs::create_dir_all(&dst).unwrap();
        fs::write(dst.join("SKILL.md"), "user-edited").unwrap();
        fs::write(dst.join("notes.md"), "沉淀回配方的笔记").unwrap();

        let outcome = seed_environment_recipes(&bundled, &env_dir).unwrap();
        assert!(outcome.seeded.is_empty());
        assert_eq!(outcome.kept, vec!["web-recon".to_string()]);
        assert_eq!(fs::read_to_string(dst.join("SKILL.md")).unwrap(), "user-edited");
        assert!(dst.join("notes.md").exists(), "user files must survive a re-seed");
    }

    #[test]
    fn stray_files_and_incomplete_sources_are_not_recipes() {
        let tmp = tempfile::tempdir().unwrap();
        let bundled = tmp.path().join("bundled-environments");
        fs::create_dir_all(&bundled).unwrap();
        fs::write(bundled.join("README.md"), "not a recipe").unwrap();
        make_bundled_recipe(&bundled, "broken", false); // no SKILL.md
        let env_dir = tmp.path().join("environments");

        let outcome = seed_environment_recipes(&bundled, &env_dir).unwrap();
        assert!(outcome.seeded.is_empty());
        assert_eq!(outcome.incomplete_sources, vec!["broken".to_string()]);
        assert!(!env_dir.join("README.md").exists());
        assert!(!env_dir.join("broken").exists());
    }

    #[test]
    fn presence_gate_detects_deleted_recipe_for_self_heal() {
        let tmp = tempfile::tempdir().unwrap();
        let bundled = tmp.path().join("bundled-environments");
        fs::create_dir_all(&bundled).unwrap();
        make_bundled_recipe(&bundled, "web-recon", true);
        let env_dir = tmp.path().join("environments");
        fs::create_dir_all(&env_dir).unwrap();

        assert!(!all_bundled_recipes_present(&bundled, &env_dir));
        seed_environment_recipes(&bundled, &env_dir).unwrap();
        assert!(all_bundled_recipes_present(&bundled, &env_dir));
        // 用户删掉已落盘配方 → 门控必须放行下一轮播种来自愈。
        fs::remove_dir_all(env_dir.join("web-recon")).unwrap();
        assert!(!all_bundled_recipes_present(&bundled, &env_dir));
    }

    #[test]
    fn recipe_completeness_matches_node_scan_convention() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("r");
        fs::create_dir_all(&dir).unwrap();
        assert!(!recipe_dir_is_complete(&dir), "no SKILL.md → not a recipe");
        fs::write(dir.join("SKILL.md"), "x").unwrap();
        assert!(recipe_dir_is_complete(&dir));
    }
}

#[cfg(test)]
mod bundled_agents_tests {
    use super::{
        agent_dir_is_complete, all_bundled_agents_present, seed_bundled_agents,
    };
    use std::fs;

    fn make_bundled_agent(root: &std::path::Path, name: &str, with_md: bool) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        if with_md {
            fs::write(
                dir.join(format!("{}.md", name)),
                "---\nname: x\ndescription: y\n---\nprompt body\n",
            )
            .unwrap();
        }
    }

    #[test]
    fn seed_if_missing_copies_new_agents() {
        let tmp = tempfile::tempdir().unwrap();
        let bundled = tmp.path().join("bundled-agents");
        fs::create_dir_all(&bundled).unwrap();
        make_bundled_agent(&bundled, "fuzz-runner", true);
        let agents_dir = tmp.path().join("agents");

        let outcome = seed_bundled_agents(&bundled, &agents_dir).unwrap();
        assert_eq!(outcome.seeded, vec!["fuzz-runner".to_string()]);
        assert!(outcome.kept.is_empty());
        assert!(outcome.incomplete_sources.is_empty());
        assert!(agents_dir.join("fuzz-runner/fuzz-runner.md").is_file());
    }

    #[test]
    fn seed_if_missing_never_overwrites_user_iterations() {
        // agent 定义允许用户迭代（改 prompt / 加 _meta.json / 启停配置）——
        // 已落盘的 agent 目录在版本 bump 重播种时也必须原样保留（与 system
        // skills 的强制覆盖语义相反，同 env recipes 的 seed-if-missing）。
        let tmp = tempfile::tempdir().unwrap();
        let bundled = tmp.path().join("bundled-agents");
        fs::create_dir_all(&bundled).unwrap();
        make_bundled_agent(&bundled, "fuzz-runner", true);
        let agents_dir = tmp.path().join("agents");
        let dst = agents_dir.join("fuzz-runner");
        fs::create_dir_all(&dst).unwrap();
        fs::write(dst.join("fuzz-runner.md"), "user-edited").unwrap();
        fs::write(dst.join("_meta.json"), r#"{"displayName":"我的 fuzz"}"#).unwrap();

        let outcome = seed_bundled_agents(&bundled, &agents_dir).unwrap();
        assert!(outcome.seeded.is_empty());
        assert_eq!(outcome.kept, vec!["fuzz-runner".to_string()]);
        assert_eq!(fs::read_to_string(dst.join("fuzz-runner.md")).unwrap(), "user-edited");
        assert!(dst.join("_meta.json").exists(), "user files must survive a re-seed");
    }

    #[test]
    fn stray_files_and_incomplete_sources_are_not_agents() {
        let tmp = tempfile::tempdir().unwrap();
        let bundled = tmp.path().join("bundled-agents");
        fs::create_dir_all(&bundled).unwrap();
        fs::write(bundled.join("README.md"), "not an agent").unwrap();
        make_bundled_agent(&bundled, "broken", false); // no <name>.md
        let agents_dir = tmp.path().join("agents");

        let outcome = seed_bundled_agents(&bundled, &agents_dir).unwrap();
        assert!(outcome.seeded.is_empty());
        assert_eq!(outcome.incomplete_sources, vec!["broken".to_string()]);
        assert!(!agents_dir.join("README.md").exists());
        assert!(!agents_dir.join("broken").exists());
    }

    #[test]
    fn presence_gate_detects_deleted_agent_for_self_heal() {
        let tmp = tempfile::tempdir().unwrap();
        let bundled = tmp.path().join("bundled-agents");
        fs::create_dir_all(&bundled).unwrap();
        make_bundled_agent(&bundled, "crash-triager", true);
        let agents_dir = tmp.path().join("agents");
        fs::create_dir_all(&agents_dir).unwrap();

        assert!(!all_bundled_agents_present(&bundled, &agents_dir));
        seed_bundled_agents(&bundled, &agents_dir).unwrap();
        assert!(all_bundled_agents_present(&bundled, &agents_dir));
        // 用户删掉已落盘 agent → 门控必须放行下一轮播种来自愈。
        fs::remove_dir_all(agents_dir.join("crash-triager")).unwrap();
        assert!(!all_bundled_agents_present(&bundled, &agents_dir));
    }

    #[test]
    fn agent_completeness_matches_agent_loader_folder_layout() {
        // agent-loader 的 folder 布局（canonical）：<name>/<name>.md——
        // 完整性判定必须与它口径一致，否则播下去的目录 loader 不认。
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("fuzz-runner");
        fs::create_dir_all(&dir).unwrap();
        assert!(!agent_dir_is_complete(&dir), "no <name>.md → not an agent");
        // 文件名与目录名不一致（flat/nested 布局）也不算 complete。
        fs::write(dir.join("other.md"), "x").unwrap();
        assert!(!agent_dir_is_complete(&dir));
        fs::write(dir.join("fuzz-runner.md"), "x").unwrap();
        assert!(agent_dir_is_complete(&dir));
    }
}

// Path-safety blacklist (single source for validate_file_path + the cross-check
// test). cfg-gated so each platform compiles only its own list. MUST stay in
// sync with Node path-safety.ts and the shared fixture
// src/shared/path-safety-blacklist.json — see path_safety_crosscheck_tests.
#[cfg(windows)]
const FORBIDDEN_SYSTEM_DIRS: &[&str] = &[
    "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)",
    "C:\\ProgramData", "C:\\Recovery", "C:\\$Recycle.Bin",
];
#[cfg(all(not(windows), not(target_os = "macos")))]
const FORBIDDEN_SYSTEM_DIRS: &[&str] = &[
    "/etc", "/var", "/usr", "/bin", "/sbin", "/boot", "/root", "/sys", "/proc", "/dev",
];
// macOS symlinks /etc → /private/etc and /var → /private/var; block the canonical
// /private targets too so a literal /private/etc path can't slip the lexical check.
#[cfg(target_os = "macos")]
const FORBIDDEN_SYSTEM_DIRS: &[&str] = &[
    "/etc", "/var", "/usr", "/bin", "/sbin", "/boot", "/root", "/sys", "/proc", "/dev",
    "/private/etc", "/private/var",
];
const CREDENTIAL_SUBDIRS: &[&str] = &[".ssh", ".gnupg", ".aws", ".kube", ".docker", ".config/op"];
#[cfg(target_os = "macos")]
const MAC_SENSITIVE_SUBDIRS: &[&str] =
    &["Library/Keychains", "Library/Cookies", "Library/Mail", "Library/Messages", "Library/Safari"];
#[cfg(windows)]
const WIN_SENSITIVE_SUBDIRS: &[&str] = &["AppData/Local/Microsoft"];

/// Validate that a file path does not target sensitive system or credential directories.
/// Resolves `..` components to prevent path traversal. Mirrors `isSafeReadPath()` in Bun.
///
/// `pub(crate)` so workspace_files::path_safety can reuse the exact same blacklist —
/// duplicating it would be a pit-of-failure (two places to update for new credential dirs).
pub(crate) fn validate_file_path(raw_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw_path);

    if !path.is_absolute() {
        return Err("Path must be absolute".to_string());
    }

    // Resolve .. and . components without requiring the file to exist
    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => { resolved.pop(); },
            std::path::Component::CurDir => {},
            _ => resolved.push(component),
        }
    }

    let home = dirs::home_dir().unwrap_or_default();

    // System directories blacklist (FORBIDDEN_SYSTEM_DIRS is cfg-gated above).
    for dir in FORBIDDEN_SYSTEM_DIRS {
        if resolved.starts_with(dir) {
            return Err("Access denied: protected system directory".to_string());
        }
    }

    // Credential / key store directories
    if !home.as_os_str().is_empty() {
        for name in CREDENTIAL_SUBDIRS {
            if resolved.starts_with(home.join(name)) {
                return Err("Access denied: protected credential directory".to_string());
            }
        }

        #[cfg(target_os = "macos")]
        for name in MAC_SENSITIVE_SUBDIRS {
            // `name` contains a "/"; PathBuf::join treats it as a separator.
            if resolved.starts_with(home.join(name)) {
                return Err("Access denied: protected system directory".to_string());
            }
        }

        #[cfg(windows)]
        for name in WIN_SENSITIVE_SUBDIRS {
            if resolved.starts_with(home.join(name)) {
                return Err("Access denied: protected system directory".to_string());
            }
        }
    }

    Ok(resolved)
}

#[cfg(test)]
mod path_safety_crosscheck_tests {
    use super::{CREDENTIAL_SUBDIRS, FORBIDDEN_SYSTEM_DIRS};
    use serde_json::Value;

    // Rust side of the Node↔Rust blacklist cross-check (PRD 0.2.15 §7.2). Asserts
    // the lists THIS platform compiled equal the shared fixture; the Node test
    // (path-safety-crosscheck.unit.test.ts) covers every platform's list. Change
    // a list without the fixture → one of the two sides fails.
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../src/shared/path-safety-blacklist.json"))
            .expect("path-safety-blacklist.json parses")
    }
    fn arr(v: &Value, key: &str) -> Vec<String> {
        v[key]
            .as_array()
            .unwrap_or_else(|| panic!("fixture.{key} must be an array"))
            .iter()
            .map(|x| x.as_str().expect("fixture entry is a string").to_string())
            .collect()
    }

    #[test]
    fn credential_subdirs_match_fixture() {
        let owned: Vec<String> = CREDENTIAL_SUBDIRS.iter().map(|s| s.to_string()).collect();
        assert_eq!(owned, arr(&fixture(), "credentialSubdirs"));
    }

    #[test]
    fn system_dirs_match_fixture_for_this_platform() {
        let f = fixture();
        #[cfg(windows)]
        let expected = arr(&f, "systemDirsWindows");
        #[cfg(all(not(windows), not(target_os = "macos")))]
        let expected = arr(&f, "systemDirsPosix");
        #[cfg(target_os = "macos")]
        let expected = {
            let mut v = arr(&f, "systemDirsPosix");
            v.extend(arr(&f, "systemDirsMacosExtra"));
            v
        };
        let owned: Vec<String> = FORBIDDEN_SYSTEM_DIRS.iter().map(|s| s.to_string()).collect();
        assert_eq!(owned, expected);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_sensitive_subdirs_match_fixture() {
        let owned: Vec<String> = super::MAC_SENSITIVE_SUBDIRS.iter().map(|s| s.to_string()).collect();
        assert_eq!(owned, arr(&fixture(), "macSensitiveSubdirs"));
    }

    #[cfg(windows)]
    #[test]
    fn win_sensitive_subdirs_match_fixture() {
        let owned: Vec<String> = super::WIN_SENSITIVE_SUBDIRS.iter().map(|s| s.to_string()).collect();
        assert_eq!(owned, arr(&fixture(), "winSensitiveSubdirs"));
    }
}

// ============= GUI IPC (1.3.0) =============
// The GUI webview needs the sidecar port to open SSE/HTTP. Reading the same
// port file the CLI uses keeps one source of truth; the frontend polls this
// until the sidecar finishes booting (port file appears).

/// 1.3.0(GUI): return the current sidecar port for the webview frontend.
/// None = sidecar not started yet (frontend should poll and show booting).
#[tauri::command]
pub fn get_sidecar_port() -> Option<u16> {
    let dir = crate::app_dirs::zhishi_data_dir()?;
    let port_file = dir.join(crate::sidecar::PORT_FILE_NAME);
    let raw = std::fs::read_to_string(&port_file).ok()?;
    let port = raw.trim().parse::<u16>().ok();
    port
}
