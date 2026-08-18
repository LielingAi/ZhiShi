/**
 * loop/skills unit tests — 合并优先级、禁用过滤、截断、零注入。
 * 全部走临时目录注入,绝不碰真实 ~/.zhishi。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectEnabledSkills,
  buildSkillsSection,
  SKILL_BODY_CAP,
  SKILLS_TOTAL_CAP,
} from './skills';

let root: string;
let bundled: string;
let user: string;
let data: string;

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
  bundled = join(root, 'bundled');
  user = join(root, 'user');
  data = join(root, 'data');
  mkdirSync(bundled, { recursive: true });
  mkdirSync(user, { recursive: true });
  mkdirSync(data, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('collectEnabledSkills', () => {
  it('合并 bundled + 用户库,同名用户库覆盖 bundled', () => {
    writeSkill(bundled, 'ctf-pwn', 'ctf-pwn', 'bundled 版正文');
    writeSkill(user, 'ctf-pwn', 'ctf-pwn', 'user 版正文');
    writeSkill(user, 'my-own', 'my-own', '用户私有');
    const packs = collectEnabledSkills({ bundledDir: bundled, userSkillsDir: user, dataDir: data });
    expect(packs).toHaveLength(2);
    const ctf = packs.find((p) => p.id === 'ctf-pwn');
    expect(ctf?.body).toBe('user 版正文');
    expect(ctf?.source).toBe('user');
    expect(packs.find((p) => p.id === 'my-own')?.source).toBe('user');
  });

  it('禁用表按文件夹名过滤两个来源', () => {
    writeSkill(bundled, 'vuln-triage', 'vuln-triage', '方法');
    writeSkill(user, 'docx', 'docx', '文档');
    writeFileSync(join(data, 'skills-config.json'), JSON.stringify({ disabled: ['vuln-triage'] }));
    const packs = collectEnabledSkills({ bundledDir: bundled, userSkillsDir: user, dataDir: data });
    expect(packs.map((p) => p.id)).toEqual(['docx']);
  });

  it('单 skill 截断到 SKILL_BODY_CAP', () => {
    writeSkill(bundled, 'big', 'big', 'x'.repeat(SKILL_BODY_CAP + 500));
    const packs = collectEnabledSkills({ bundledDir: bundled, userSkillsDir: user, dataDir: data });
    expect(packs[0].body.length).toBeLessThanOrEqual(SKILL_BODY_CAP + 20);
    expect(packs[0].body).toContain('截断');
  });

  it('无 SKILL.md 的文件夹被跳过;目录不存在不炸', () => {
    mkdirSync(join(bundled, 'empty-folder'), { recursive: true });
    const packs = collectEnabledSkills({ bundledDir: bundled, userSkillsDir: join(root, 'nope'), dataDir: data });
    expect(packs).toEqual([]);
  });
});

describe('buildSkillsSection', () => {
  it('空/undefined → 零注入', () => {
    expect(buildSkillsSection(undefined)).toBe('');
    expect(buildSkillsSection([])).toBe('');
  });

  it('渲染 <skills> 段含名称/描述/正文', () => {
    const s = buildSkillsSection([
      { id: 'ctf-pwn', name: 'CTF Pwn', description: '打 pwn 题', body: '先 checksec', source: 'bundled' },
    ]);
    expect(s).toContain('<skills>');
    expect(s).toContain('CTF Pwn');
    expect(s).toContain('先 checksec');
    expect(s).toContain('</skills>');
  });

  it('总量封顶 SKILLS_TOTAL_CAP,超出丢弃并注明', () => {
    const big = 'y'.repeat(Math.floor(SKILLS_TOTAL_CAP / 3) - 100);
    const packs = [0, 1, 2, 3].map((i) => ({
      id: `s${i}`, name: `s${i}`, description: '', body: big, source: 'user' as const,
    }));
    const s = buildSkillsSection(packs);
    expect(s).toContain('s0');
    expect(s).toContain('s1');
    expect(s).toContain('s2');
    expect(s).not.toContain('## s3');
    expect(s).toContain('未注入');
  });
});
