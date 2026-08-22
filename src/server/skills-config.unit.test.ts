/**
 * 1.1.7 ③ — skills-config（skills-config.json）unit tests.
 *
 * 覆盖 mutateSkillsConfig（withFileLock 锁内读-改-写 + tmp+rename 原子替换，
 * 收编自旧 writeSkillsConfig）：round-trip、conditional write 不 bump
 * generation、并发写串行化不丢更新。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mutateSkillsConfig, readSkillsConfig, seedBundledSkills, syncEnvironmentRecipes, syncSystemSkill } from './skills-config';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skills-config-test-'));
  file = join(dir, 'skills-config.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('mutateSkillsConfig（withFileLock + tmp+rename）', () => {
  it('mutate → read round-trip；每次落盘 generation 自增；缺文件 → defaults', () => {
    expect(readSkillsConfig(file)).toEqual({ seeded: [], disabled: [], generation: 0 });
  });

  it('每次落盘 generation 自增', async () => {
    await mutateSkillsConfig((c) => { c.seeded.push('a'); return true; }, file);
    await mutateSkillsConfig((c) => { c.disabled.push('b'); return true; }, file);
    expect(readSkillsConfig(file)).toEqual({ seeded: ['a'], disabled: ['b'], generation: 2 });
  });

  it('mutate 返回 false 不落盘、不 bump generation', async () => {
    await mutateSkillsConfig((c) => { c.seeded.push('a'); return true; }, file);
    await mutateSkillsConfig(() => false, file);
    expect(readSkillsConfig(file).generation).toBe(1);
  });

  it('并发写串行化：两个 mutate 都不丢（锁内读-改-写）', async () => {
    await Promise.all([
      mutateSkillsConfig((c) => { c.seeded.push('skill-a'); return true; }, file),
      mutateSkillsConfig((c) => { c.disabled.push('skill-b'); return true; }, file),
    ]);
    const config = readSkillsConfig(file);
    expect(config.seeded).toEqual(['skill-a']);
    expect(config.disabled).toEqual(['skill-b']);
    expect(config.generation).toBe(2);
  });
});

// 1.2.2 ④ — system skills 纯 sidecar 模式不更新修复：Node 侧内容哈希同步。
describe('syncSystemSkill（内容哈希同步，1.2.2 ④）', () => {
  let bundled: string;
  let installed: string;
  const skill = 'binary-exploit'; // 任意非 platform-blocked 的 system skill

  const writeSkill = (root: string, files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      const p = join(root, skill, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
  };

  const bundledFiles = {
    'SKILL.md': '# binary-exploit v1',
    'refs/checklist.md': 'step 1\nstep 2',
  };

  beforeEach(() => {
    bundled = join(dir, 'bundled-skills');
    installed = join(dir, 'skills');
    mkdirSync(installed, { recursive: true });
    writeSkill(bundled, bundledFiles);
  });

  it('dst 缺失 → 安装 bundled 副本', () => {
    expect(syncSystemSkill(bundled, installed, skill)).toBe(true);
    expect(readFileSync(join(installed, skill, 'SKILL.md'), 'utf-8')).toBe('# binary-exploit v1');
    expect(readFileSync(join(installed, skill, 'refs', 'checklist.md'), 'utf-8')).toBe('step 1\nstep 2');
  });

  it('内容一致 → no-op（Rust 已同步的常态）', () => {
    cpSync(join(bundled, skill), join(installed, skill), { recursive: true });
    expect(syncSystemSkill(bundled, installed, skill)).toBe(false);
  });

  it('内容不一致（用户本地修改 / 旧版本）→ 整目录替换回 bundled（与 Rust 语义一致）', () => {
    expect(syncSystemSkill(bundled, installed, skill)).toBe(true); // 首次安装
    // 模拟用户本地改动 + 多余文件
    writeFileSync(join(installed, skill, 'SKILL.md'), 'user edit');
    writeFileSync(join(installed, skill, 'local-note.md'), 'mine');
    expect(syncSystemSkill(bundled, installed, skill)).toBe(true);
    expect(readFileSync(join(installed, skill, 'SKILL.md'), 'utf-8')).toBe('# binary-exploit v1');
    // wholesale 替换（同 Rust sync_one_system_skill）：用户多余文件一并清除
    expect(readFileSyncSafe(join(installed, skill, 'local-note.md'))).toBeNull();
  });

  it('bundled 源不完整（无 SKILL.md，issue #321 打包事故）→ 保留已安装副本', () => {
    expect(syncSystemSkill(bundled, installed, skill)).toBe(true); // 先装好
    rmSync(join(bundled, skill, 'SKILL.md')); // 模拟打包缺陷
    expect(syncSystemSkill(bundled, installed, skill)).toBe(false);
    expect(readFileSync(join(installed, skill, 'SKILL.md'), 'utf-8')).toBe('# binary-exploit v1');
  });

  it.runIf(process.platform === 'win32')('platform blocked（agent-browser on Windows）→ 跳过', () => {
    const blocked = 'agent-browser';
    mkdirSync(join(bundled, blocked), { recursive: true });
    writeFileSync(join(bundled, blocked, 'SKILL.md'), '# agent-browser');
    expect(syncSystemSkill(bundled, installed, blocked)).toBe(false);
    expect(readFileSyncSafe(join(installed, blocked, 'SKILL.md'))).toBeNull();
  });
});

function readFileSyncSafe(p: string): string | null {
  try { return readFileSync(p, 'utf-8'); } catch { return null; }
}

describe('seedBundledSkills system-skill 接线（ZHISHI_DATA_DIR 隔离）', () => {
  let dataDir: string;
  let saved: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'zhishi-data-test-'));
    saved = process.env.ZHISHI_DATA_DIR;
    process.env.ZHISHI_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ZHISHI_DATA_DIR;
    else process.env.ZHISHI_DATA_DIR = saved;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('首跑落盘 system skills；二次全量一致 → 不写 config（generation 不变）', async () => {
    await seedBundledSkills();
    const configPath = join(dataDir, 'skills-config.json');
    const first = readSkillsConfig(configPath);
    // system skills 已落盘但绝不进入 config.seeded（版本门语义，非 seed-once）
    expect(readFileSyncSafe(join(dataDir, 'skills', 'binary-exploit', 'SKILL.md'))).not.toBeNull();
    expect(first.seeded).not.toContain('binary-exploit');
    expect(first.generation).toBe(1);

    // 模拟 Rust 版本门记录存在（Tauri 宿主跑过）：Node 不读它，但行为须兼容
    writeFileSync(join(dataDir, '.system-skills-version'), '35');
    await seedBundledSkills();
    const second = readSkillsConfig(configPath);
    expect(second.generation).toBe(1); // 内容一致 → 全程 no-op
  });
});

// 1.2.5「配」— 配方播种从 seed-if-missing 升级为内容哈希同步：
// 一致 no-op / 不一致覆盖 + 旧版备份到 <配方>.bak-<YYYYMMDD>。
describe('syncEnvironmentRecipes（内容哈希同步，1.2.5「配」）', () => {
  let bundled: string;
  let root: string;
  const recipe = 'pwn';

  const stamp = () => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  };

  const writeRecipe = (base: string, files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      const p = join(base, recipe, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
  };

  beforeEach(() => {
    bundled = join(dir, 'bundled-environments');
    root = join(dir, 'environments');
    mkdirSync(root, { recursive: true });
    writeRecipe(bundled, { 'SKILL.md': '# pwn v1', 'setup.sh': 'echo v1' });
  });

  it('dst 缺失 → seeded，内容落盘', () => {
    const outcomes = syncEnvironmentRecipes(bundled, root);
    expect(outcomes).toEqual([{ id: recipe, action: 'seeded' }]);
    expect(readFileSync(join(root, recipe, 'SKILL.md'), 'utf-8')).toBe('# pwn v1');
  });

  it('内容一致 → kept no-op（不产生备份）', () => {
    syncEnvironmentRecipes(bundled, root); // 先播种
    const outcomes = syncEnvironmentRecipes(bundled, root);
    expect(outcomes).toEqual([{ id: recipe, action: 'kept' }]);
    expect(readdirSync(root).sort()).toEqual([recipe]);
  });

  it('bundled 变了 → synced 覆盖 + 旧版备份到 <配方>.bak-<日期>（用户本地改动同理可回滚）', () => {
    syncEnvironmentRecipes(bundled, root); // v1 落盘
    // 用户本地迭代过副本（加了自己的文件）+ bundled 出了 v2
    writeFileSync(join(root, recipe, 'my-notes.md'), 'mine');
    writeRecipe(bundled, { 'SKILL.md': '# pwn v2', 'setup.sh': 'echo v2' });
    const outcomes = syncEnvironmentRecipes(bundled, root);
    expect(outcomes).toEqual([{ id: recipe, action: 'synced' }]);
    // 新内容 = bundled v2；用户多余文件随旧版进了备份
    expect(readFileSync(join(root, recipe, 'SKILL.md'), 'utf-8')).toBe('# pwn v2');
    const backup = join(root, `${recipe}.bak-${stamp()}`);
    expect(readFileSync(join(backup, 'SKILL.md'), 'utf-8')).toBe('# pwn v1');
    expect(readFileSync(join(backup, 'my-notes.md'), 'utf-8')).toBe('mine');
  });

  it('同日第二次覆盖 → 备份缀 -2，不顶掉第一份备份', () => {
    syncEnvironmentRecipes(bundled, root); // v1
    writeRecipe(bundled, { 'SKILL.md': '# pwn v2' });
    syncEnvironmentRecipes(bundled, root); // v2，备份 v1 → .bak-<stamp>
    writeRecipe(bundled, { 'SKILL.md': '# pwn v3' });
    syncEnvironmentRecipes(bundled, root); // v3，备份 v2 → .bak-<stamp>-2
    expect(readFileSync(join(root, recipe, 'SKILL.md'), 'utf-8')).toBe('# pwn v3');
    expect(readFileSync(join(root, `${recipe}.bak-${stamp()}`, 'SKILL.md'), 'utf-8')).toBe('# pwn v1');
    expect(readFileSync(join(root, `${recipe}.bak-${stamp()}-2`, 'SKILL.md'), 'utf-8')).toBe('# pwn v2');
  });

  it('bundled 源不完整（缺 SKILL.md，打包缺陷）→ 跳过，已装副本不动', () => {
    syncEnvironmentRecipes(bundled, root); // 先装好
    rmSync(join(bundled, recipe, 'SKILL.md'));
    writeFileSync(join(bundled, recipe, 'setup.sh'), 'echo broken');
    const outcomes = syncEnvironmentRecipes(bundled, root);
    expect(outcomes).toEqual([]);
    expect(readFileSync(join(root, recipe, 'SKILL.md'), 'utf-8')).toBe('# pwn v1');
    expect(readFileSync(join(root, recipe, 'setup.sh'), 'utf-8')).toBe('echo v1');
  });

  it('bundled 根目录里的散落文件（README.md 等）不当配方', () => {
    writeFileSync(join(bundled, 'README.md'), 'not a recipe');
    const outcomes = syncEnvironmentRecipes(bundled, root);
    expect(outcomes).toEqual([{ id: recipe, action: 'seeded' }]);
    expect(existsSync(join(root, 'README.md'))).toBe(false);
  });
});
