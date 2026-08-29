/**
 * loop/skills unit tests — 1.5.1 注入面瘦身后只覆盖裁留的扫描器口径：
 * scanSkillsDir（合法 skill 定义）/ truncateSkillBody（整行截断）/
 * resolveBundledSkillsDir（目录解析）。注入层（collectEnabledSkills /
 * buildSkillsSection / filterSkillsByDomain / SKILLS_TOTAL_CAP）已删除，
 * 对应用例同步删除。全部走临时目录注入,绝不碰真实 ~/.zhishi。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  scanSkillsDir,
  resolveBundledSkillsDir,
  truncateSkillBody,
  SKILL_BODY_CAP,
} from './skills';

let root: string;
let bundled: string;

function writeSkill(dir: string, folder: string, name: string, body: string, description = ''): void {
  const d = join(dir, folder);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    'utf-8',
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zhishi-skills-'));
  bundled = join(root, 'bundled-skills');
  mkdirSync(bundled, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scanSkillsDir', () => {
  it('扫描合法 skill（SKILL.md + frontmatter），按文件夹名收录', () => {
    writeSkill(bundled, 'ctf-pwn', 'CTF Pwn', '先 checksec', '打 pwn 题');
    const packs = scanSkillsDir(bundled, 'bundled');
    expect(packs.size).toBe(1);
    const ctf = packs.get('ctf-pwn');
    expect(ctf?.name).toBe('CTF Pwn');
    expect(ctf?.description).toBe('打 pwn 题');
    expect(ctf?.body).toBe('先 checksec');
    expect(ctf?.source).toBe('bundled');
  });

  it('无 SKILL.md / 正文为空的文件夹被跳过；目录不存在返回空表', () => {
    mkdirSync(join(bundled, 'empty-folder'), { recursive: true });
    writeSkill(bundled, 'no-body', 'no-body', '');
    expect(scanSkillsDir(bundled, 'bundled').size).toBe(0);
    expect(scanSkillsDir(join(root, 'nope'), 'user').size).toBe(0);
    expect(scanSkillsDir(null, 'user').size).toBe(0);
  });

  it('单 skill 正文截断到 SKILL_BODY_CAP', () => {
    writeSkill(bundled, 'big', 'big', 'x'.repeat(SKILL_BODY_CAP + 500));
    const packs = scanSkillsDir(bundled, 'bundled');
    const big = packs.get('big');
    expect(big?.body.length).toBeLessThanOrEqual(SKILL_BODY_CAP + 20);
    expect(big?.body).toContain('截断');
  });
});

describe('truncateSkillBody — 整行边界截断', () => {
  it('截断点取整行边界,不断半句', () => {
    const body = `${'a'.repeat(3990)}\n${'b'.repeat(500)}`;
    const out = truncateSkillBody(body);
    // 在最后一个换行处切——b 行整行不进,不出现半行残片
    expect(out).toBe(`${'a'.repeat(3990)}\n…(截断)`);
    expect(out).not.toContain('b');
  });

  it('cap 内无换行 → 退硬切(单行超长正文没别的边界可取)', () => {
    const out = truncateSkillBody('x'.repeat(SKILL_BODY_CAP + 100));
    expect(out).toBe(`${'x'.repeat(SKILL_BODY_CAP)}\n…(截断)`);
  });

  it('cap 以内原样返回', () => {
    expect(truncateSkillBody('short body')).toBe('short body');
  });
});

describe('resolveBundledSkillsDir', () => {
  it('脚本同级命中 bundled-skills（prod 布局）', () => {
    expect(resolveBundledSkillsDir(root)).toBe(bundled);
  });

  it('向上 5 层内命中（dev 布局）；都找不到返回 null', () => {
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(resolveBundledSkillsDir(nested)).toBe(bundled);
    const isolated = mkdtempSync(join(tmpdir(), 'zhishi-noskills-'));
    try {
      expect(resolveBundledSkillsDir(isolated)).toBeNull();
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});
