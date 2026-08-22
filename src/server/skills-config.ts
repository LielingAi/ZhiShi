// ============= SKILLS CONFIG & SEED =============
// Extracted from index.ts (1.1.7 ③ god-file strangler split — pure move).
//
// writeSkillsConfig was收编 here into `mutateSkillsConfig`: skills-config.json
// read-modify-write now runs inside withFileLock + tmp+rename atomic replace
// (1.1.7 ① leftover; pattern copied from environment/selection.ts's
// mutateSelectionStore). Reads stay lock-free, matching loadSelectionStore.

import { createHash } from 'crypto';

import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs';

import { dirname, join, resolve } from 'path';

import { getZhiShiDataDir } from './utils/app-dirs';

import { ensureDirSync } from './utils/fs-utils';

import { getScriptDir } from './utils/runtime';

import { getHomeDirOrNull, isSkillBlockedOnPlatform } from './utils/platform';

import { withFileLock } from './utils/file-lock';

import { resolveBundledDir } from './domains/manifest';

import { defaultRecipesRoot } from './environment/recipes';

export interface SkillsConfig {

  seeded: string[];

  disabled: string[];

  generation: number;  // Monotonic counter — incremented on every skill CRUD operation

}



function getSkillsConfigPath(): string {

  return join(getZhiShiDataDir(), 'skills-config.json');

}



export function readSkillsConfig(configPath: string = getSkillsConfigPath()): SkillsConfig {

  const defaults: SkillsConfig = { seeded: [], disabled: [], generation: 0 };

  try {

    if (existsSync(configPath)) {

      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));

      return {

        seeded: Array.isArray(raw?.seeded) ? raw.seeded : defaults.seeded,

        disabled: Array.isArray(raw?.disabled) ? raw.disabled : defaults.disabled,

        generation: typeof raw?.generation === 'number' ? raw.generation : 0,

      };

    }

  } catch (err) {

    console.warn('[skills-config] Error reading config:', err);

  }

  return defaults;

}


/**
 * Locked read-modify-write for skills-config.json (withFileLock + tmp+rename
 * atomic replace). The `mutate` callback edits the freshly-read config in
 * place and returns true to persist; returning false skips the write (no
 * generation bump), mirroring the old conditional-write behavior.
 *
 * Generation auto-increments on every persisted write — signals Tab Sidecars
 * to re-sync symlinks (was writeSkillsConfig's job).
 *
 * Write/lock failures are logged and swallowed, matching the old
 * writeSkillsConfig contract (callers were fire-and-forget).
 */
export async function mutateSkillsConfig(
  mutate: (config: SkillsConfig) => boolean,
  configPath: string = getSkillsConfigPath(),
): Promise<void> {
  try {
    ensureDirSync(dirname(configPath));
    await withFileLock({ lockPath: `${configPath}.lock` }, async () => {
      const config = readSkillsConfig(configPath);
      if (!mutate(config)) return; // 无改动不写盘（不 bump generation）
      config.generation = (config.generation || 0) + 1;
      const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
      renameSync(tmp, configPath);
    });
  } catch (err) {
    console.error('[skills-config] Error writing config:', err);
  }
}

/**
 * Bump skills generation counter without changing seeded/disabled lists.
 * Called after skill CRUD operations (create/update/delete/upload/import)
 * that don't go through mutateSkillsConfig but DO change the available skill set.
 * Tab Sidecars detect this change and re-sync symlinks on next /api/commands fetch.
 */
export async function bumpSkillsGeneration(): Promise<void> {
  await mutateSkillsConfig(() => true);
}




/**

 * Lazy skill sync: Track the last generation we synced to avoid redundant sync work.

 * When a Tab Sidecar's /api/commands is called, we compare the current

 * generation in skills-config.json against this value. Only if they differ do we run

 * syncProjectUserConfig(). This covers the case where the Global Sidecar modified

 * global skills (create/toggle/delete) without the Tab Sidecar knowing.

 */

// Phase E (PRD 0.2.7): the `syncSkillsIfNeeded` wrapper + generation-tracking

// optimization is gone. Rust `cmd_list_slash_commands` is the canonical UI

// path and runs `sync_workspace_skills` (idempotent) every call. The sidecar

// only syncs as a side-effect of skill/command CRUD via direct

// `syncProjectUserConfig(...)` calls; CRUD-time correctness is what matters

// (the picker UI lives in Rust now). `markSkillsSynced` is also gone — there's

// no longer a generation-cached fast-path to invalidate.


/**

 * Resolve bundled-skills directory.

 * - Production (macOS): Contents/Resources/bundled-skills/

 * - Production (Windows): <install-dir>/bundled-skills/

 * - Development: <project-root>/bundled-skills/

 */

function resolveBundledSkillsDir(): string | null {

  const scriptDir = getScriptDir();



  // Production: bundled-skills is alongside server-dist.js in Resources

  const prodPath = resolve(scriptDir, 'bundled-skills');

  if (existsSync(prodPath)) return prodPath;



  // Development: bundled-skills is at project root

  // In dev, scriptDir is something like <project>/src/server/utils

  // Walk up to find bundled-skills at project root

  let dir = scriptDir;

  for (let i = 0; i < 5; i++) {

    const devPath = resolve(dir, 'bundled-skills');

    if (existsSync(devPath)) return devPath;

    dir = dirname(dir);

  }



  return null;

}



/**

 * System skills — owned by the app, version-gated by the Rust side

 * (`SYSTEM_SKILLS` + `SYSTEM_SKILLS_VERSION` in `src-tauri/src/commands.rs`).

 * Their lifecycle is "force-overwrite on every version bump", not "seed once

 * then leave alone". Keep this list in sync with the Rust constant — a

 * mismatch would either double-sync (harmless but confusing logs) or skip a

 * genuine user skill named identically.

 *

 * 1.2.2 ④: they are no longer skipped by `seedBundledSkills`. The Rust

 * version gate only runs when the Tauri host boots; in sidecar-only mode

 * (dev `src/server/index.ts` / CLI-only) no Rust host exists, so bundled

 * updates never reached `~/.zhishi/skills/`. The Node side now does a

 * content-hash sync instead (see `syncSystemSkill`): identical content →

 * no-op (the normal state after a Rust sync), different → force-overwrite.

 * The two paths coexist: same machine running both never fights, because

 * content-identical syncs are no-ops on both sides.

 */

const SYSTEM_SKILLS: readonly string[] = [

  'task-alignment',

  'task-implement',

  // v10: ultra-research removed — not generic enough.

  'download-anything',

  // v8: see commands.rs::SYSTEM_SKILLS — agent-browser promoted to system

  // skill so existing users get the updated command-local npm self-install

  // SKILL.md after the bundled CLI is removed.

  'agent-browser',

  // v9: zhishi-cli — global skill that exposes the entire `zhishi`

  // CLI surface (cron / task / mcp / model / agent / runtime / skill /

  // widget / im / config) to every AI session in the product.

  // Force-synced because SKILL.md must track CLI changes in lockstep.

  'zhishi-cli',

  // v36: app-automation 随 1.2.3 AppCraft 退役移除，存量 seed 目录由用户自处，
  // 见 commands.rs::SYSTEM_SKILLS。

  // v29: capability-forge 与通用生产力 skills 随安全研究员版减法删除，

  // 见 commands.rs::SYSTEM_SKILLS。

  // v30: 安全研究员版 P1 S2 —— 首批 4 个安全方法 skills（native-code-loop /

  // binary-exploit / vuln-triage / range-ops），见 commands.rs::SYSTEM_SKILLS。

  'native-code-loop',

  'binary-exploit',

  'vuln-triage',

  'range-ops',

  // v35: 1.1.8 三域实战验证修正落盘——pentest / whitebox-audit /

  // ai-security 升 system（与 binary-exploit 同待遇），见 commands.rs::SYSTEM_SKILLS。

  'pentest',

  'whitebox-audit',

  'ai-security',

];


/**

 * Seed bundled skills to ~/.zhishi/skills/ on first launch.

 * Only copies skills that haven't been seeded before (tracked in skills-config.json).

 *

 * System skills (SYSTEM_SKILLS above) follow a different path: they are

 * force-overwritten by Rust's `cmd_sync_system_skills` when the Tauri host

 * boots, and content-hash synced by `syncSystemSkill` here so sidecar-only

 * mode (no Rust host) also receives bundled updates (1.2.2 ④). They are

 * deliberately NOT tracked in `config.seeded` — their lifecycle is the

 * version/content gate, not seed-once — so a Rust-synced install and a

 * sidecar-synced install leave the config identical.

 */

/**
 * Dev-side recipe seeding: Rust 宿主负责把 bundled-environments 播种到
 * ~/.zhishi/environments(ENVIRONMENT_RECIPES_VERSION 版本门控),但裸
 * sidecar 开发态没有 Rust——新增配方(code-audit)永远不会落盘。这里做
 * 「缺 id 补种」:已存在的配方目录绝不动(用户改过的配方不覆盖),只补
 * 目标目录里没有的 bundled 配方。
 */
export function seedEnvironmentRecipes(): void {
  try {
    const bundledDir = resolveBundledDir('bundled-environments');
    if (!bundledDir) return;
    const root = defaultRecipesRoot();
    ensureDirSync(root);
    for (const entry of readdirSync(bundledDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = join(bundledDir, entry.name);
      const dst = join(root, entry.name);
      if (existsSync(dst)) continue; // 已存在(含用户改过的)不动
      cpSync(src, dst, { recursive: true });
      console.log(`[seed] recipe seeded: ${entry.name}`);
    }
  } catch (err) {
    console.warn('[seed] environment recipes seeding failed (non-fatal):', err);
  }
}

/**
 * Hash a skill directory's full content tree (relative paths + file bytes +
 * symlink targets, sorted for determinism) into a single digest. Missing,
 * dangling-symlink, or unreadable dirs hash to null, so "absent" always
 * differs from any real bundled source.
 */
function hashSkillDir(dir: string): string | null {
  if (!existsSync(dir)) return null; // follows symlinks: broken link & missing both null
  const hash = createHash('sha256');
  const walk = (rel: string): void => {
    const abs = rel ? join(dir, rel) : dir;
    const entries = readdirSync(abs, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const entryAbs = join(abs, entry.name);
      if (entry.isDirectory()) {
        hash.update(`dir:${relPath}\0`);
        walk(relPath);
      } else if (entry.isSymbolicLink()) {
        hash.update(`link:${relPath}\0${readlinkSync(entryAbs)}\0`);
      } else if (entry.isFile()) {
        hash.update(`file:${relPath}\0`);
        hash.update(readFileSync(entryAbs));
        hash.update('\0');
      }
    }
  };
  try {
    walk('');
    return hash.digest('hex');
  } catch {
    return null; // unreadable (e.g. a regular file sitting at dst) → treat as differs
  }
}

/**
 * 1.2.2 ④ — Content-hash sync for one system skill (sidecar-only mode fix).
 *
 * Rust's `cmd_sync_system_skills` only runs when the Tauri host boots, so in
 * sidecar-only mode (dev `src/server/index.ts`, CLI-only usage) bundled
 * system-skill updates never landed. Here we compare the bundled source
 * against the installed copy:
 *
 * - identical content → no-op. This is the normal state after a Rust sync,
 *   so both paths coexist on one machine without fighting (each side's
 *   content-identical run is a no-op).
 * - different / missing → force-overwrite with the bundled copy. User edits
 *   to system-skill directories are overwritten, by design — same semantics
 *   as the Rust version gate ("随版本强制覆盖", see commands.rs module
 *   comment).
 *
 * Returns true iff the installed copy was (re)written. Mirrors the Rust
 * guards: platform-blocked skills are skipped (parity with
 * PLATFORM_BLOCKED_SKILLS / is_skill_blocked_on_platform), and a bundled
 * source without SKILL.md is a packaging defect that must never replace a
 * working installed copy (issue #321).
 */
export function syncSystemSkill(bundledDir: string, userSkillsDir: string, folder: string): boolean {
  if (isSkillBlockedOnPlatform(folder)) {
    console.log(`[seed] Skipping system skill ${folder} on ${process.platform} (platform blocked)`);
    return false;
  }
  const src = join(bundledDir, folder);
  const dst = join(userSkillsDir, folder);
  if (!existsSync(join(src, 'SKILL.md'))) {
    console.warn(`[seed] Bundled system skill incomplete (no SKILL.md), preserved existing copy: ${folder}`);
    return false;
  }
  const srcHash = hashSkillDir(src);
  if (srcHash !== null && srcHash === hashSkillDir(dst)) {
    return false; // already in sync — no-op
  }
  try {
    // rmSync on a symlink removes the link itself (never the target), so a
    // dangling ~/.zhishi/skills/<name> symlink is cleared here instead of
    // wedging cpSync (the Node v24 cpSync equivalent() crash the non-system
    // path below guards against).
    rmSync(dst, { recursive: true, force: true });
    cpSync(src, dst, { recursive: true });
    console.log(`[seed] Synced system skill (content changed): ${folder}`);
    return true;
  } catch (err) {
    console.warn(`[seed] Failed to sync system skill ${folder}:`, err);
    return false;
  }
}

export async function seedBundledSkills(): Promise<void> {

  try {

    const bundledDir = resolveBundledSkillsDir();

    if (!bundledDir) {

      console.log('[seed] Bundled skills directory not found, skipping seed');

      return;

    }

    const userSkillsDir = join(getZhiShiDataDir(), 'skills');



    ensureDirSync(userSkillsDir);



    const bundledFolders = readdirSync(bundledDir, { withFileTypes: true })

      .filter(d => d.isDirectory())

      .map(d => d.name);




    await mutateSkillsConfig((config) => {

      let changed = false;

    for (const folder of bundledFolders) {

      if (SYSTEM_SKILLS.includes(folder)) {

        // 1.2.2 ④: content-hash sync (was: skipped as Rust-owned). A real
        // overwrite bumps generation via `changed` so Tab Sidecars re-sync —
        // mirrors the skill-update CRUD path's bumpSkillsGeneration.

        if (syncSystemSkill(bundledDir, userSkillsDir, folder)) changed = true;

        continue;

      }

      if (isSkillBlockedOnPlatform(folder)) {

        console.log(`[seed] Skipping ${folder} on ${process.platform} (platform blocked)`);

        continue;

      }

      const dst = join(userSkillsDir, folder);



      // Detect broken symlinks at dst BEFORE any operation that resolves the

      // path. Node v24's cpSync C++ implementation calls

      // `std::filesystem::equivalent(src, dst)` for src/dst equality

      // detection; on a broken symlink that throws an uncaught C++ exception

      // (`libc++abi: ... filesystem error: in equivalent: Operation not

      // supported`) which terminates the entire sidecar — JS try/catch

      // cannot intercept it. existsSync follows the link and returns false,

      // hiding the symlink from every guard below, so we must lstat first.

      // Repro: `node -e 'fs.cpSync("/tmp/src", "/tmp/dangling", {recursive:true})'`

      // where /tmp/dangling -> /nonexistent. Reported as user crash on v0.2.5

      // (~/.zhishi/skills/docx pointed at a deleted target).

      let dstLstat: ReturnType<typeof lstatSync> | null = null;

      try {

        dstLstat = lstatSync(dst);

      } catch {

        // dst doesn't exist — fall through to seed path

      }

      const dstExists = existsSync(dst); // follows symlinks

      const isBrokenSymlink = dstLstat?.isSymbolicLink() && !dstExists;



      if (isBrokenSymlink) {

        try {

          unlinkSync(dst);

          console.warn(`[seed] Removed broken symlink at ${dst} so the bundled skill can seed`);

        } catch (err) {

          console.warn(`[seed] Failed to remove broken symlink ${dst}, skipping:`, err);

          continue;

        }

      }



      // Re-seed if marked as seeded but directory was deleted (or was a broken symlink we just cleared)

      if (config.seeded.includes(folder) && dstExists) continue;



      const src = join(bundledDir, folder);

      // Packaging guard (issue #321, mirrors Rust cmd_sync_system_skills):

      // only treat a bundled folder as a seedable skill if it carries a

      // SKILL.md. An empty / SKILL.md-less source dir is a packaging defect —

      // seeding it would copy an empty directory that every SKILL.md-gated

      // scanner (Settings panel, slash picker, SDK runtime) ignores, and

      // marking it `seeded` would freeze that broken state so a corrected

      // bundle never re-seeds. Skip without marking seeded → retries next launch.

      if (!existsSync(join(src, 'SKILL.md'))) {

        console.warn(`[seed] Bundled skill incomplete (no SKILL.md), skipping: ${folder}`);

        continue;

      }

      // Skip if destination already exists (don't overwrite user's custom content)

      if (dstExists) {

        config.seeded.push(folder);

        changed = true;

        console.log(`[seed] Skipped existing folder: ${folder}`);

        continue;

      }

      try {

        cpSync(src, dst, { recursive: true });

        console.log(`[seed] Seeded skill: ${folder}`);

      } catch (err) {

        console.warn(`[seed] Failed to seed skill ${folder}:`, err);

        continue;

      }



      config.seeded.push(folder);

      changed = true;

    }

      return changed;

    });

  } catch (err) {

    console.error('[seed] Error seeding bundled skills:', err);

  }

}


/**

 * Clean up stale Playwright MCP profile lock files left by a crashed Chromium.

 *

 * Independent of the agent-browser bundle removal — this exists because

 * Chromium leaves SingletonLock / SingletonSocket / SingletonCookie files in

 * the user-data-dir when the process crashes (or the OS kills it on app exit

 * without a clean shutdown). Subsequent Chromium launches with the same

 * user-data-dir refuse to start with "ProfileInUse" until the locks clear.

 *

 * Playwright's own startup mostly handles this, but the legacy

 * `~/.playwright-mcp-profile/` directory pre-dates Playwright MCP's improved

 * recovery paths and we've seen real "Chromium hangs forever" reports tied to

 * stale locks here. Cheap idempotent cleanup at sidecar boot.

 */

export function cleanupStalePlaywrightProfile(): void {

  try {

    const homeDir = getHomeDirOrNull();

    if (!homeDir) return;



    const profileDir = join(homeDir, '.playwright-mcp-profile');

    const lockPath = join(profileDir, 'SingletonLock');



    if (!existsSync(lockPath)) return;



    // SingletonLock content: "hostname-pid" (POSIX symlink target on macOS/Linux,

    // regular file content on Windows).

    let linkTarget: string;

    try {

      linkTarget = readlinkSync(lockPath);

    } catch {

      try {

        linkTarget = readFileSync(lockPath, 'utf-8').trim();

      } catch {

        return; // Can't read — bail

      }

    }



    const pidMatch = linkTarget.match(/-(\d+)$/);

    if (!pidMatch) return;

    const pid = parseInt(pidMatch[1], 10);



    // Probe pid liveness; if the process is alive, leave its locks alone.

    try {

      process.kill(pid, 0);

      return;

    } catch {

      // Process is dead → safe to clean up

    }



    for (const file of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {

      const filePath = join(profileDir, file);

      try {

        if (existsSync(filePath)) {

          unlinkSync(filePath);

        }

      } catch { /* best effort */ }

    }



    console.log(`[startup] Cleaned up stale Playwright MCP profile lock (pid ${pid} dead)`);

  } catch (err) {

    console.warn('[startup] Playwright profile cleanup failed:', err);

  }

}



// ============= END SKILLS CONFIG & SEED =============
