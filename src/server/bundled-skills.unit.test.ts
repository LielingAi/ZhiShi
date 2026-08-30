import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 守卫测试：工具侧技能本体分发（1.5.1 注入面瘦身——skills 提示词注入层
// 已删，方法论类沉专家库；随包分发的只剩 4 个工具侧技能本体）。
// 防三类静默事故：
//  1. bundled-skills/<name>/SKILL.md 缺失或 frontmatter 缺 name/description；
//  2. Rust SYSTEM_SKILLS（src-tauri/src/commands.rs）清单与 bundled-skills
//     目录漂移——清单里有、目录没有会在 Tauri 宿主 sync 时静默跳过；
//  3. 新增/变更 system skill 忘了 bump SYSTEM_SKILLS_VERSION（版本门不触发，
//     存量用户拿不到新 skill）。
// 1.5.1：Node 侧镜像清单（skills-config.ts::SYSTEM_SKILLS）随 skills 管理面
// 整体删除——system skills 的落盘只剩 Rust 宿主版本门一条路径，不再有
// 双写漂移面，对应两条 Node 镜像断言同步删除。
const ROOT = process.cwd();
const SKILLS_ROOT = resolve(ROOT, 'bundled-skills');

const TOOL_SIDE_SKILLS = ['agent-browser', 'download-anything', 'zhishi-cli', 'range-ops'] as const;

// 从源码文本里抽出清单数组体中的引号字符串（数组体内无模板串/转义，正则够用）。
function extractStringList(source: string, startMarker: string): string[] {
  const start = source.indexOf(startMarker);
  expect(start, `marker not found: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('];', start);
  expect(end, `closing ]; not found after: ${startMarker}`).toBeGreaterThan(start);
  const body = source.slice(start, end);
  return [...body.matchAll(/["']([a-z0-9-]+)["']/g)].map((m) => m[1]);
}

const rustSrc = readFileSync(resolve(ROOT, 'src-tauri/src/commands.rs'), 'utf8');
const rustList = extractStringList(rustSrc, 'const SYSTEM_SKILLS: &[&str] = &[');

describe('bundled 工具侧技能（1.5.1 守卫）', () => {
  it('4 个工具侧 skill 目录与 SKILL.md 齐备', () => {
    for (const name of TOOL_SIDE_SKILLS) {
      const skillMd = resolve(SKILLS_ROOT, name, 'SKILL.md');
      expect(existsSync(skillMd), `${name}/SKILL.md missing`).toBe(true);
    }
  });

  it('每个 SKILL.md frontmatter 有 name（与目录一致）+ 非空 description', () => {
    for (const name of TOOL_SIDE_SKILLS) {
      const content = readFileSync(resolve(SKILLS_ROOT, name, 'SKILL.md'), 'utf8');
      const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      expect(fm, `${name}: frontmatter block missing`).toBeTruthy();
      const block = fm![1];
      expect(block, name).toMatch(new RegExp(`^name:\\s*${name}\\s*$`, 'm'));
      // description 允许单行或 YAML 折叠块（>-），只断言字段存在且有内容。
      expect(block, name).toMatch(/^description:\s*\S/m);
    }
  });

  it('退役的方法论 skill 目录不再随包分发（已沉专家库/已删）', () => {
    for (const name of ['whitebox-audit', 'binary-exploit', 'pentest', 'ai-security', 'vuln-triage', 'native-code-loop', 'task-alignment', 'task-implement']) {
      expect(existsSync(resolve(SKILLS_ROOT, name)), `${name} 应已从 bundled-skills 移除`).toBe(false);
    }
  });

  it('Rust SYSTEM_SKILLS 与工具侧 4 个一致（不多不少）', () => {
    expect([...rustList].sort()).toEqual([...TOOL_SIDE_SKILLS].sort());
  });

  it('清单内每个 system skill 都有对应 bundled-skills 目录', () => {
    for (const name of rustList) {
      expect(existsSync(resolve(SKILLS_ROOT, name, 'SKILL.md')), `${name}/SKILL.md missing`).toBe(true);
    }
  });

  it('SYSTEM_SKILLS_VERSION 已随 1.5.1 bump（≥38）', () => {
    const m = rustSrc.match(/const SYSTEM_SKILLS_VERSION: &str = "(\d+)";/);
    expect(m, 'SYSTEM_SKILLS_VERSION not found in commands.rs').toBeTruthy();
    expect(Number.parseInt(m![1], 10)).toBeGreaterThanOrEqual(38);
  });
});
