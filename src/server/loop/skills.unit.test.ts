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
  filterSkillsByDomain,
  buildSkillsSection,
  SKILL_BODY_CAP,
  SKILLS_TOTAL_CAP,
  type SkillPack,
} from './skills';
import type { DomainManifest } from '../../shared/domain-manifest';

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

// ===== 1.2.6 批次 C 深化 =====

describe('truncateSkillBody — 整行边界截断（1.2.6）', () => {
  it('截断点取整行边界,不断半句', async () => {
    const { truncateSkillBody } = await import('./skills');
    const body = `${'a'.repeat(3990)}\n${'b'.repeat(500)}`;
    const out = truncateSkillBody(body);
    // 在最后一个换行处切——b 行整行不进,不出现半行残片
    expect(out).toBe(`${'a'.repeat(3990)}\n…(截断)`);
    expect(out).not.toContain('b');
  });

  it('cap 内无换行 → 退硬切(单行超长正文没别的边界可取)', async () => {
    const { truncateSkillBody } = await import('./skills');
    const out = truncateSkillBody('x'.repeat(SKILL_BODY_CAP + 100));
    expect(out).toBe(`${'x'.repeat(SKILL_BODY_CAP)}\n…(截断)`);
  });
});

describe('buildSkillsSection — 丢弃顺序用户库最后丢（1.2.6）', () => {
  it('预算满时先丢 bundled,用户 skill 保留', () => {
    const big = 'y'.repeat(Math.floor(SKILLS_TOTAL_CAP / 3) - 100);
    // 传入序 bundled 在前(模拟旧 Map 合并序)——取舍应与传入序无关
    const packs = [
      { id: 'b0', name: 'b0', description: '', body: big, source: 'bundled' as const },
      { id: 'b1', name: 'b1', description: '', body: big, source: 'bundled' as const },
      { id: 'u0', name: 'u0', description: '', body: big, source: 'user' as const },
      { id: 'u1', name: 'u1', description: '', body: big, source: 'user' as const },
    ];
    const s = buildSkillsSection(packs);
    // 4 个 ~3900 字符的包只能装 3 个:用户库两个必须都在,bundled 后装的那个被丢
    expect(s).toContain('## u0');
    expect(s).toContain('## u1');
    expect(s).toContain('## b0');
    expect(s).not.toContain('## b1');
    expect(s).toContain('未注入');
  });
});

// ===== 1.2.7 域边界：skills 分域注入 =====

describe('collectEnabledSkills — 域过滤（1.2.7）', () => {
  const DOMAIN_MANIFESTS: DomainManifest[] = [
    // ghost-skill 在清单里但目录不存在 → 容错跳过（whitebox-audit 缺目录同型）。
    { kind: 'binary', name: '二进制', recipes: [], skills: ['binary-exploit', 'vuln-triage', 'ghost-skill'], subagents: [], signals: [], acceptance: [] },
    { kind: 'pentest', name: '渗透', recipes: [], skills: ['pentest'], subagents: [], signals: [], acceptance: [] },
  ];

  function seedSkills(): void {
    writeSkill(bundled, 'binary-exploit', 'binary-exploit', '二进制利用方法');
    writeSkill(bundled, 'vuln-triage', 'vuln-triage', '漏洞分拣');
    writeSkill(bundled, 'pentest', 'pentest', '渗透方法');
    // task-alignment 不在任何域清单里 → 跨域通用,任何域下都保留。
    writeSkill(bundled, 'task-alignment', 'task-alignment', '任务对齐');
  }

  it('域命中清单 → 只保留该域 skills + 无域归属的通用 skills', () => {
    seedSkills();
    const packs = collectEnabledSkills({ bundledDir: bundled, userSkillsDir: user, dataDir: data, domain: 'binary', domainManifests: DOMAIN_MANIFESTS });
    expect(packs.map((p) => p.id).sort()).toEqual(['binary-exploit', 'task-alignment', 'vuln-triage']);
  });

  it('清单引用了目录里不存在的名字 → 跳过,不炸（缺目录容错）', () => {
    seedSkills();
    const packs = collectEnabledSkills({ bundledDir: bundled, userSkillsDir: user, dataDir: data, domain: 'binary', domainManifests: DOMAIN_MANIFESTS });
    expect(packs.find((p) => p.id === 'ghost-skill')).toBeUndefined();
  });

  it('用户库同名覆盖后仍按 id 过滤（域外 skill 换 source 也进不来）', () => {
    seedSkills();
    writeSkill(user, 'pentest', 'pentest', '用户版渗透');
    writeSkill(user, 'my-tool', 'my-tool', '用户私有通用工具'); // 无域归属 → 通用保留
    const packs = collectEnabledSkills({ bundledDir: bundled, userSkillsDir: user, dataDir: data, domain: 'binary', domainManifests: DOMAIN_MANIFESTS });
    expect(packs.find((p) => p.id === 'pentest')).toBeUndefined();
    expect(packs.find((p) => p.id === 'my-tool')?.source).toBe('user');
  });

  it('无 domain → 全量（现状语义不变）', () => {
    seedSkills();
    const packs = collectEnabledSkills({ bundledDir: bundled, userSkillsDir: user, dataDir: data });
    expect(packs.map((p) => p.id).sort()).toEqual(['binary-exploit', 'pentest', 'task-alignment', 'vuln-triage']);
  });

  it('域未被任何清单覆盖 → 全量（宁多勿缺）', () => {
    seedSkills();
    const packs = collectEnabledSkills({ bundledDir: bundled, userSkillsDir: user, dataDir: data, domain: 'malware', domainManifests: DOMAIN_MANIFESTS });
    expect(packs.map((p) => p.id).sort()).toEqual(['binary-exploit', 'pentest', 'task-alignment', 'vuln-triage']);
  });

  it('域过滤与禁用表叠加生效', () => {
    seedSkills();
    writeFileSync(join(data, 'skills-config.json'), JSON.stringify({ disabled: ['vuln-triage'] }));
    const packs = collectEnabledSkills({ bundledDir: bundled, userSkillsDir: user, dataDir: data, domain: 'binary', domainManifests: DOMAIN_MANIFESTS });
    expect(packs.map((p) => p.id).sort()).toEqual(['binary-exploit', 'task-alignment']);
  });
});

describe('filterSkillsByDomain — 纯函数（1.2.7）', () => {
  const MANIFESTS: DomainManifest[] = [
    { kind: 'binary', name: '二进制', recipes: [], skills: ['a', 'b'], subagents: [], signals: [], acceptance: [] },
    { kind: 'pentest', name: '渗透', recipes: [], skills: ['c'], subagents: [], signals: [], acceptance: [] },
  ];
  const pack = (id: string): SkillPack => ({ id, name: id, description: '', body: 'x', source: 'bundled' });

  it('域命中 → 域内 + 通用保留,域外丢弃;原数组不被改写', () => {
    const input = [pack('a'), pack('b'), pack('c'), pack('generic')];
    const out = filterSkillsByDomain(input, 'binary', MANIFESTS);
    expect(out.map((p) => p.id)).toEqual(['a', 'b', 'generic']);
    expect(input).toHaveLength(4);
  });

  it('无 domain / 域无清单 → 原样返回（同一引用）', () => {
    const input = [pack('a'), pack('c')];
    expect(filterSkillsByDomain(input, undefined, MANIFESTS)).toBe(input);
    expect(filterSkillsByDomain(input, 'malware', MANIFESTS)).toBe(input);
  });
});
