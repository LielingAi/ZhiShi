// ============= ENVIRONMENT RECIPES SEED & STARTUP CLEANUP =============
// Extracted from index.ts (1.1.7 ③ god-file strangler split — pure move).
//
// 1.5.1 注入面瘦身:skills 的 seed/配置写侧(seedBundledSkills /
// syncSystemSkill / SYSTEM_SKILLS / mutateSkillsConfig / bumpSkillsGeneration /
// readSkillsConfig)随 skills 管理面整体删除——~/.zhishi/skills 不再有
// sidecar 写入口;skills-config.json 的 disabled 清单只剩 agent-session 的
// .claude/skills 软链同步(兼容面)读侧消费,存量用户配置自然生效、不再变更。

import { createHash } from 'crypto';

import { cpSync, existsSync, readdirSync, readFileSync, readlinkSync, renameSync, unlinkSync } from 'fs';

import { join } from 'path';

import { ensureDirSync } from './utils/fs-utils';

import { getHomeDirOrNull } from './utils/platform';

import { resolveBundledDir } from './domains/manifest';

import { defaultRecipesRoot } from './environment/recipes';

/**
 * Dev-side recipe seeding + 内容哈希同步（1.2.5「配」——修正触达老安装）。
 *
 * 老语义是 seed-if-missing：已落盘的配方目录永不覆盖——bundled 的配方
 * 修正（如 tools[] 词汇修正）永远到不了老用户。新语义对齐内容哈希比对，
 * 但配方没有 system/user 分层（用户/LLM 允许迭代自己的配方副本），所以
 * 覆盖前先把旧版整个改名备份到 <配方>.bak-<YYYYMMDD>（同名已存在缀 -2、
 * -3…；scanRecipes 按 isRecipeBackupDir 跳过这些备份目录，不会混进配方
 * 清单）：
 *
 * - 目标缺失 → 落盘（播种，与老语义一致）
 * - 内容一致 → no-op（与 Rust 宿主 seed-if-missing 共存不打架）
 * - 内容不一致 → 备份旧版 + 强制覆盖为 bundled 新版；覆盖失败回滚备份
 *
 * bundled 源缺 SKILL.md 是打包缺陷，绝不用它替换可用副本（issue #321
 * 同款教训）。
 */
export function seedEnvironmentRecipes(): void {
  try {
    const bundledDir = resolveBundledDir('bundled-environments');
    if (!bundledDir) return;
    syncEnvironmentRecipes(bundledDir, defaultRecipesRoot());
  } catch (err) {
    console.warn('[seed] environment recipes seeding failed (non-fatal):', err);
  }
}

/**
 * syncEnvironmentRecipes 的核心（目录可注入，便于单测）。返回每个配方的
 * 处置结果；单配方失败记 failed 并继续，不阻塞其余配方。
 */
export function syncEnvironmentRecipes(
  bundledDir: string,
  root: string,
): Array<{ id: string; action: 'seeded' | 'synced' | 'kept' | 'failed' }> {
  const outcomes: Array<{ id: string; action: 'seeded' | 'synced' | 'kept' | 'failed' }> = [];
  ensureDirSync(root);
  for (const entry of readdirSync(bundledDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = join(bundledDir, entry.name);
    if (!existsSync(join(src, 'SKILL.md'))) continue; // 打包缺陷源，跳过
    const dst = join(root, entry.name);
    try {
      if (!existsSync(dst)) {
        cpSync(src, dst, { recursive: true });
        console.log(`[seed] recipe seeded: ${entry.name}`);
        outcomes.push({ id: entry.name, action: 'seeded' });
        continue;
      }
      const srcHash = hashDirTree(src);
      if (srcHash !== null && srcHash === hashDirTree(dst)) {
        outcomes.push({ id: entry.name, action: 'kept' }); // 内容一致 no-op
        continue;
      }
      // bundled 变了（或本地被改过）→ 旧版备份 + 覆盖；失败回滚，宁可
      // 留旧版也不留空位。
      const backup = nextRecipeBackupPath(root, entry.name);
      renameSync(dst, backup);
      try {
        cpSync(src, dst, { recursive: true });
      } catch (err) {
        try { renameSync(backup, dst); } catch { /* 已尽力，备份仍在 */ }
        throw err;
      }
      console.log(`[seed] recipe updated: ${entry.name}（旧版备份 → ${backup}）`);
      outcomes.push({ id: entry.name, action: 'synced' });
    } catch (err) {
      console.warn(`[seed] recipe sync failed for ${entry.name} (non-fatal):`, err);
      outcomes.push({ id: entry.name, action: 'failed' });
    }
  }
  return outcomes;
}

/** 备份落点：<root>/<name>.bak-<YYYYMMDD>，同名已存在缀 -2、-3… */
function nextRecipeBackupPath(root: string, name: string): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  let candidate = join(root, `${name}.bak-${stamp}`);
  for (let n = 2; existsSync(candidate); n += 1) {
    candidate = join(root, `${name}.bak-${stamp}-${n}`);
  }
  return candidate;
}

/**
 * Hash a directory's full content tree (relative paths + file bytes +
 * symlink targets, sorted for determinism) into a single digest. Missing,
 * dangling-symlink, or unreadable dirs hash to null, so "absent" always
 * differs from any real bundled source.
 */
function hashDirTree(dir: string): string | null {
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
