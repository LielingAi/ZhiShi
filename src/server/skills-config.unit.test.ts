/**
 * skills-config unit tests（1.5.1 瘦身后裁留）。
 *
 * 1.5.1 注入面瘦身：mutateSkillsConfig / readSkillsConfig / seedBundledSkills /
 * syncSystemSkill 随 skills 管理面整体删除，对应用例同步删除。本文件只保留
 * 环境配方的内容哈希同步覆盖（syncEnvironmentRecipes）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { syncEnvironmentRecipes } from './skills-config';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skills-config-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
