#!/usr/bin/env node
/**
 * sync-bundled-skills.js
 *
 * 将 skillshub 分类技能库同步到 ZhiShi 的 bundled-skills/ 目录，
 * 使这些技能随安装包分发并在首次启动时自动 seed 到 ~/.zhishi/skills/。
 *
 * 用法:
 *   node scripts/build/sync-bundled-skills.js
 *   SKILLHUB_DIR=/path/to/skillshub node scripts/build/sync-bundled-skills.js
 *   DRY_RUN=1 node scripts/build/sync-bundled-skills.js
 */

const { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } = require('fs');
const { join, resolve, basename } = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const CLEAN_ONLY = process.env.CLEAN_ONLY === '1' || process.env.CLEAN_ONLY === 'true';
const SKILLHUB_DIR = resolve(process.env.SKILLHUB_DIR || 'D:/project/skillshub/classified_top5');
const BUNDLED_SKILLS_DIR = resolve(process.env.BUNDLED_SKILLS_DIR || './bundled-skills');
const MANIFEST_NAME = '.skillshub-manifest.json';
const MANIFEST_PATH = join(BUNDLED_SKILLS_DIR, MANIFEST_NAME);

// 这些目录里的 SKILL.md 不会被当成独立 skill（常见依赖/示例目录）
const IGNORED_SKILL_DIR_SEGMENTS = new Set(['node_modules', '.git', '.github', '__tests__', 'test', 'tests', 'examples', 'samples']);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function log(...args) {
  console.log(...args);
}

function warn(...args) {
  console.warn('[warn]', ...args);
}

function error(...args) {
  console.error('[error]', ...args);
}

function isSkillDir(dirPath) {
  return existsSync(join(dirPath, 'SKILL.md'));
}

function shouldIgnoreDir(dirName) {
  return IGNORED_SKILL_DIR_SEGMENTS.has(dirName) || dirName.startsWith('.') || dirName.startsWith('_');
}

function shortHash(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 6);
}

function parseSkillName(skillDir) {
  const skillMdPath = join(skillDir, 'SKILL.md');
  try {
    const content = readFileSync(skillMdPath, 'utf-8');
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (match) {
      const lines = match[1].split('\n');
      let name = '';
      let description = '';
      for (const line of lines) {
        const nameMatch = line.match(/^name:\s*(.+)$/);
        if (nameMatch) name = nameMatch[1].trim();
        const descMatch = line.match(/^description:\s*(.+)$/);
        if (descMatch) description = descMatch[1].trim();
      }
      return { name, description };
    }
  } catch (err) {
    warn(`Failed to parse SKILL.md frontmatter: ${skillMdPath}`, err.message);
  }
  return { name: basename(skillDir), description: '' };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * 递归查找所有包含 SKILL.md 的目录。
 * 返回 [{ sourceDir, relPath, basename }]
 */
function discoverSkills(rootDir) {
  const skills = [];

  function walk(currentDir, relParts) {
    if (!existsSync(currentDir)) return;
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (shouldIgnoreDir(entry.name)) continue;
      const nextRelParts = [...relParts, entry.name];
      const nextDir = join(currentDir, entry.name);
      if (isSkillDir(nextDir)) {
        skills.push({
          sourceDir: nextDir,
          relPath: nextRelParts.join('/'),
          basename: entry.name,
        });
      }
      walk(nextDir, nextRelParts);
    }
  }

  walk(rootDir, []);
  return skills;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

function resolveTargetNames(skills, existingNames) {
  const usedNames = new Set(existingNames);
  const result = [];

  for (const skill of skills) {
    let targetName = skill.basename;

    if (usedNames.has(targetName)) {
      // 用完整相对路径做 hash，保证不同来源冲突时名字唯一且确定
      const hash = shortHash(skill.relPath);
      targetName = `${skill.basename}-${hash}`;
    }

    // 二次去重（理论上 hash 后不会重复，但防御一下）
    let finalName = targetName;
    let counter = 2;
    while (usedNames.has(finalName)) {
      finalName = `${targetName}-${counter++}`;
    }

    usedNames.add(finalName);
    const { name, description } = parseSkillName(skill.sourceDir);
    result.push({ ...skill, targetName: finalName, displayName: name, description });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function readManifest() {
  if (!existsSync(MANIFEST_PATH)) return { version: 1, synced: [] };
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  } catch (err) {
    warn('Failed to read manifest, starting fresh', err.message);
    return { version: 1, synced: [] };
  }
}

function writeManifest(synced) {
  if (DRY_RUN) return;
  mkdirSync(BUNDLED_SKILLS_DIR, { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify({ version: 1, synced }, null, 2));
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function getExistingBundledSkillNames() {
  if (!existsSync(BUNDLED_SKILLS_DIR)) return [];
  return readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && !shouldIgnoreDir(e.name))
    .map(e => e.name);
}

function removeOldSyncedSkills(manifest) {
  for (const entry of manifest.synced) {
    const dir = join(BUNDLED_SKILLS_DIR, entry.targetName);
    if (existsSync(dir)) {
      if (DRY_RUN) {
        log(`[dry-run] would remove old synced skill: ${entry.targetName}`);
      } else {
        rmSync(dir, { recursive: true, force: true });
        log(`Removed old synced skill: ${entry.targetName}`);
      }
    }
  }
}

function copySkill(skill) {
  const destDir = join(BUNDLED_SKILLS_DIR, skill.targetName);
  if (DRY_RUN) {
    log(`[dry-run] would copy: ${skill.relPath} -> ${skill.targetName}`);
    return;
  }
  mkdirSync(destDir, { recursive: true });
  cpSync(skill.sourceDir, destDir, { recursive: true, filter: (src) => {
    // 不复制 node_modules 等目录
    const name = basename(src);
    if (shouldIgnoreDir(name) && src !== skill.sourceDir) return false;
    return true;
  }});
  log(`Copied: ${skill.relPath} -> ${skill.targetName}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (CLEAN_ONLY) {
    log('================================================');
    log('SkillHub -> bundled-skills cleanup');
    log('================================================');
    log(`Bundled target  : ${BUNDLED_SKILLS_DIR}`);
    log(`Dry run         : ${DRY_RUN}`);
    log('');

    const manifest = readManifest();
    log(`Previously synced skills: ${manifest.synced.length}`);

    removeOldSyncedSkills(manifest);

    if (!DRY_RUN) {
      writeManifest([]);
      if (existsSync(MANIFEST_PATH)) {
        rmSync(MANIFEST_PATH);
        log(`Removed manifest: ${MANIFEST_PATH}`);
      }
    }

    log('');
    log('================================================');
    log('Cleanup complete.');
    log('================================================');
    return;
  }

  log('================================================');
  log('SkillHub -> bundled-skills sync');
  log('================================================');
  log(`SkillHub source : ${SKILLHUB_DIR}`);
  log(`Bundled target  : ${BUNDLED_SKILLS_DIR}`);
  log(`Dry run         : ${DRY_RUN}`);
  log('');

  if (!existsSync(SKILLHUB_DIR)) {
    error(`SkillHub directory not found: ${SKILLHUB_DIR}`);
    process.exit(1);
  }

  mkdirSync(BUNDLED_SKILLS_DIR, { recursive: true });

  const manifest = readManifest();
  const existingNames = getExistingBundledSkillNames();
  const officialNames = existingNames.filter(n => !manifest.synced.some(s => s.targetName === n));

  log(`Existing official bundled skills: ${officialNames.length}`);
  log(`Previously synced skills       : ${manifest.synced.length}`);
  log('');

  const skills = discoverSkills(SKILLHUB_DIR);
  log(`Discovered skills in SkillHub: ${skills.length}`);

  const resolved = resolveTargetNames(skills, officialNames);

  // 检查冲突
  const conflicts = resolved.filter(s => s.targetName !== s.basename);
  if (conflicts.length > 0) {
    log(`Resolved ${conflicts.length} naming conflicts with hash suffixes.`);
  }

  // 清理旧的同步技能
  removeOldSyncedSkills(manifest);

  // 复制新技能
  for (const skill of resolved) {
    copySkill(skill);
  }

  // 写 manifest
  const newManifest = resolved.map(s => ({
    sourceRelPath: s.relPath,
    targetName: s.targetName,
    displayName: s.displayName,
  }));
  writeManifest(newManifest);

  log('');
  log('================================================');
  log(`Sync complete. Total synced skills: ${resolved.length}`);
  log(`Manifest written to: ${MANIFEST_PATH}`);
  log('================================================');

  // 简单统计
  const categoryStats = {};
  for (const s of resolved) {
    const cat = s.relPath.split('/')[0] || 'unknown';
    categoryStats[cat] = (categoryStats[cat] || 0) + 1;
  }
  log('Skills by category:');
  for (const [cat, count] of Object.entries(categoryStats).sort()) {
    log(`  ${cat}: ${count}`);
  }
}

main();
