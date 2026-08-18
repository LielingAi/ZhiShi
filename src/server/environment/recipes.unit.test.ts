/**
 * 安全研究员版 P1 E4 — environment recipe 解析/校验/清单聚合 unit tests.
 *
 * 覆盖：SKILL.md frontmatter 解析（name/description/base/tools）、完整性校验
 * （docker 配方必须有 Dockerfile、缺文件/非法 base 标记 invalid 但不炸整体）、
 * 目录扫描（缺根目录、非目录条目、invalid 配方共存）与工具清单聚合
 * （发现环节能力清单注入的唯一事实源）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  aggregateRecipeTools,
  buildRecipe,
  buildToolCheckCommand,
  loadRecipe,
  parseRecipeFrontmatter,
  parseToolCheckOutput,
  scanRecipes,
  validateRecipe,
} from './recipes';

const VALID_DOCKER_SKILL = `---
name: web-recon
description: Web 侦察研究现场
base: docker
tools:
  - nmap
  - curl
  - whatweb
---

# web-recon

何时用、怎么进、结果怎么采、怎么收尾。
`;

const VALID_VM_SKILL = `---
name: win-range
description: Windows 靶场
base: vm
tools: [mimikatz]
---

# win-range
`;

describe('parseRecipeFrontmatter', () => {
  it('parses name/description/base/tools from valid frontmatter', () => {
    const { frontmatter, errors } = parseRecipeFrontmatter(VALID_DOCKER_SKILL);
    expect(errors).toEqual([]);
    expect(frontmatter.name).toBe('web-recon');
    expect(frontmatter.description).toBe('Web 侦察研究现场');
    expect(frontmatter.base).toBe('docker');
    expect(frontmatter.tools).toEqual(['nmap', 'curl', 'whatweb']);
  });

  it('accepts inline-array tools (yaml flow style)', () => {
    const { frontmatter, errors } = parseRecipeFrontmatter(VALID_VM_SKILL);
    expect(errors).toEqual([]);
    expect(frontmatter.base).toBe('vm');
    expect(frontmatter.tools).toEqual(['mimikatz']);
  });

  it('flags an illegal base value', () => {
    const content = VALID_DOCKER_SKILL.replace('base: docker', 'base: wsl');
    const { errors } = parseRecipeFrontmatter(content);
    expect(errors.some((e) => e.includes('base'))).toBe(true);
  });

  it('flags non-string-array tools', () => {
    const content = VALID_DOCKER_SKILL.replace(
      'tools:\n  - nmap\n  - curl\n  - whatweb',
      'tools: nmap',
    );
    const { errors } = parseRecipeFrontmatter(content);
    expect(errors.some((e) => e.includes('tools'))).toBe(true);
  });

  it('flags a tools array containing non-strings', () => {
    const content = VALID_DOCKER_SKILL.replace('  - whatweb', '  - 42');
    const { errors } = parseRecipeFrontmatter(content);
    expect(errors.some((e) => e.includes('tools'))).toBe(true);
  });

  it('tolerates missing frontmatter (all fields undefined, no parse errors)', () => {
    const { frontmatter, errors } = parseRecipeFrontmatter('# no frontmatter\n');
    expect(errors).toEqual([]);
    expect(frontmatter.name).toBeUndefined();
    expect(frontmatter.base).toBeUndefined();
    expect(frontmatter.tools).toBeUndefined();
  });
});

describe('validateRecipe', () => {
  it('accepts a complete docker recipe', () => {
    const { frontmatter } = parseRecipeFrontmatter(VALID_DOCKER_SKILL);
    expect(validateRecipe(frontmatter, new Set(['SKILL.md', 'Dockerfile', 'setup.sh']))).toEqual([]);
  });

  it('requires Dockerfile for docker recipes', () => {
    const { frontmatter } = parseRecipeFrontmatter(VALID_DOCKER_SKILL);
    const reasons = validateRecipe(frontmatter, new Set(['SKILL.md', 'setup.sh']));
    expect(reasons.some((r) => r.includes('Dockerfile'))).toBe(true);
  });

  it('does not require Dockerfile for vm recipes', () => {
    const { frontmatter } = parseRecipeFrontmatter(VALID_VM_SKILL);
    expect(validateRecipe(frontmatter, new Set(['SKILL.md']))).toEqual([]);
  });

  it('requires name and base', () => {
    const reasons = validateRecipe({}, new Set(['SKILL.md']));
    expect(reasons.some((r) => r.includes('name'))).toBe(true);
    expect(reasons.some((r) => r.includes('base'))).toBe(true);
  });
});

describe('buildRecipe', () => {
  it('marks a recipe without SKILL.md invalid (whole scan must not blow up)', () => {
    const recipe = buildRecipe('broken', '/x/broken', null, new Set(['Dockerfile']));
    expect(recipe.valid).toBe(false);
    expect(recipe.invalidReasons.some((r) => r.includes('SKILL.md'))).toBe(true);
  });

  it('collects parse errors and validation reasons into invalidReasons', () => {
    const content = VALID_DOCKER_SKILL.replace('base: docker', 'base: wsl');
    const recipe = buildRecipe('bad', '/x/bad', content, new Set(['SKILL.md', 'Dockerfile']));
    expect(recipe.valid).toBe(false);
    expect(recipe.invalidReasons.length).toBeGreaterThan(0);
    expect(recipe.invalidReasons.some((r) => r.includes('base'))).toBe(true);
  });

  it('keeps parsed fields even when invalid (UI can show partial info)', () => {
    const recipe = buildRecipe(
      'partial',
      '/x/partial',
      VALID_DOCKER_SKILL,
      new Set(['SKILL.md']), // no Dockerfile
    );
    expect(recipe.valid).toBe(false);
    expect(recipe.name).toBe('web-recon');
    expect(recipe.base).toBe('docker');
    expect(recipe.tools).toEqual(['nmap', 'curl', 'whatweb']);
  });
});

describe('scanRecipes / loadRecipe (thin IO over temp dirs)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zhishi-recipes-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seedRecipe(dirName: string, files: Record<string, string>): void {
    const dir = join(root, dirName);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
  }

  it('returns [] when the recipes root does not exist', () => {
    expect(scanRecipes(join(root, 'nonexistent'))).toEqual([]);
  });

  it('returns [] for an empty root', () => {
    expect(scanRecipes(root)).toEqual([]);
  });

  it('scans valid recipes sorted by id and ignores stray files', () => {
    writeFileSync(join(root, 'README.md'), 'not a recipe');
    seedRecipe('b-lab', {
      'SKILL.md': VALID_DOCKER_SKILL,
      Dockerfile: 'FROM ubuntu\n',
      'setup.sh': '#!/bin/sh\n',
    });
    seedRecipe('a-lab', { 'SKILL.md': VALID_VM_SKILL });

    const recipes = scanRecipes(root);
    expect(recipes.map((r) => r.id)).toEqual(['a-lab', 'b-lab']);
    expect(recipes.every((r) => r.valid)).toBe(true);
    expect(recipes[1].dir).toBe(join(root, 'b-lab'));
  });

  it('keeps invalid recipes in the list with reasons instead of failing the scan', () => {
    seedRecipe('good', {
      'SKILL.md': VALID_DOCKER_SKILL,
      Dockerfile: 'FROM ubuntu\n',
    });
    seedRecipe('broken', { Dockerfile: 'FROM ubuntu\n' }); // no SKILL.md

    const recipes = scanRecipes(root);
    expect(recipes).toHaveLength(2);
    const broken = recipes.find((r) => r.id === 'broken');
    expect(broken?.valid).toBe(false);
    expect(broken?.invalidReasons.some((r) => r.includes('SKILL.md'))).toBe(true);
    expect(recipes.find((r) => r.id === 'good')?.valid).toBe(true);
  });

  it('loadRecipe finds one recipe by id', () => {
    seedRecipe('target', {
      'SKILL.md': VALID_DOCKER_SKILL,
      Dockerfile: 'FROM ubuntu\n',
    });
    const recipe = loadRecipe(root, 'target');
    expect(recipe?.valid).toBe(true);
    expect(recipe?.name).toBe('web-recon');
    expect(loadRecipe(root, 'missing')).toBeUndefined();
  });
});

describe('aggregateRecipeTools', () => {
  it('aggregates tool → recipeIds for capability-list injection', () => {
    const a = buildRecipe('a', '/x/a', VALID_DOCKER_SKILL, new Set(['SKILL.md', 'Dockerfile']));
    const b = buildRecipe(
      'b',
      '/x/b',
      VALID_DOCKER_SKILL.replace('name: web-recon', 'name: other').replace('  - whatweb\n', ''),
      new Set(['SKILL.md', 'Dockerfile']),
    );
    const aggregated = aggregateRecipeTools([a, b]);
    const nmap = aggregated.find((t) => t.tool === 'nmap');
    expect(nmap?.recipeIds.sort()).toEqual(['a', 'b']);
    const whatweb = aggregated.find((t) => t.tool === 'whatweb');
    expect(whatweb?.recipeIds).toEqual(['a']);
    // sorted by tool name
    expect(aggregated.map((t) => t.tool)).toEqual([...aggregated.map((t) => t.tool)].sort());
  });

  it('skips invalid recipes (their tool claims are unverified)', () => {
    const invalid = buildRecipe('bad', '/x/bad', null, new Set());
    expect(aggregateRecipeTools([invalid])).toEqual([]);
  });
});

describe('vm frontmatter fields (P2 VM driver)', () => {
  it('parses vm_base / vm_user / vm_snapshot into camelCase recipe fields', () => {
    const content = VALID_VM_SKILL.replace(
      'tools: [mimikatz]',
      'tools: [mimikatz]\nvm_base: C:\\VMs\\win10\\win10.vmx\nvm_user: researcher\nvm_snapshot: zhishi-clean',
    );
    const recipe = buildRecipe('win-range', '/x/win-range', content, new Set(['SKILL.md']));
    expect(recipe.valid).toBe(true);
    expect(recipe.vmBase).toBe('C:\\VMs\\win10\\win10.vmx');
    expect(recipe.vmUser).toBe('researcher');
    expect(recipe.vmSnapshot).toBe('zhishi-clean');
  });

  it('vm fields are optional — absent stays undefined (vm_base can come from --vm-base)', () => {
    const recipe = buildRecipe('win-range', '/x/win-range', VALID_VM_SKILL, new Set(['SKILL.md']));
    expect(recipe.valid).toBe(true);
    expect(recipe.vmBase).toBeUndefined();
    expect(recipe.vmUser).toBeUndefined();
    expect(recipe.vmSnapshot).toBeUndefined();
  });

  it('wrong-typed vm field → invalid with a clear reason', () => {
    const content = VALID_VM_SKILL.replace('tools: [mimikatz]', 'tools: [mimikatz]\nvm_snapshot: 42');
    const recipe = buildRecipe('win-range', '/x/win-range', content, new Set(['SKILL.md']));
    expect(recipe.valid).toBe(false);
    expect(recipe.invalidReasons.some((r) => r.includes('vm_snapshot'))).toBe(true);
  });
});

describe('vm_engine field (P2 B3 multi-driver)', () => {
  it('parses vm_engine: hyperv / virtualbox into vmEngine', () => {
    const hyperv = buildRecipe(
      'win-range',
      '/x/win-range',
      VALID_VM_SKILL.replace('tools: [mimikatz]', 'tools: [mimikatz]\nvm_engine: hyperv'),
      new Set(['SKILL.md']),
    );
    expect(hyperv.valid).toBe(true);
    expect(hyperv.vmEngine).toBe('hyperv');

    const vbox = buildRecipe(
      'win-range',
      '/x/win-range',
      VALID_VM_SKILL.replace('tools: [mimikatz]', 'tools: [mimikatz]\nvm_engine: virtualbox'),
      new Set(['SKILL.md']),
    );
    expect(vbox.valid).toBe(true);
    expect(vbox.vmEngine).toBe('virtualbox');
  });

  it('absent vm_engine → vmEngine undefined (缺省 vmware 由消费侧兜底)', () => {
    const recipe = buildRecipe('win-range', '/x/win-range', VALID_VM_SKILL, new Set(['SKILL.md']));
    expect(recipe.valid).toBe(true);
    expect(recipe.vmEngine).toBeUndefined();
  });

  it('illegal vm_engine value → invalid with a clear reason', () => {
    const content = VALID_VM_SKILL.replace('tools: [mimikatz]', 'tools: [mimikatz]\nvm_engine: kvm');
    const recipe = buildRecipe('win-range', '/x/win-range', content, new Set(['SKILL.md']));
    expect(recipe.valid).toBe(false);
    expect(recipe.invalidReasons.some((r) => r.includes('vm_engine'))).toBe(true);
  });
});

describe('配方工具自检(声明 vs 实装)', () => {
  it('buildToolCheckCommand:逐个 command -v,单引号包裹', () => {
    expect(buildToolCheckCommand(['semgrep', 'pip-audit'])).toBe(
      `for t in 'semgrep' 'pip-audit'; do command -v "$t" >/dev/null 2>&1 && echo "OK:$t" || echo "MISS:$t"; done`,
    );
  });

  it('parseToolCheckOutput:全 OK → ok;缺失 → missing 清单;空声明 → ok', () => {
    expect(parseToolCheckOutput('OK:semgrep\nOK:pip-audit\n', ['semgrep', 'pip-audit']))
      .toEqual({ ok: true, missing: [] });
    expect(parseToolCheckOutput('OK:semgrep\nMISS:pip-audit\n', ['semgrep', 'pip-audit']))
      .toEqual({ ok: false, missing: ['pip-audit'] });
    // 输出缺行(命令挂了)= 缺失;声明空 = 无验
    expect(parseToolCheckOutput('', ['semgrep'])).toEqual({ ok: false, missing: ['semgrep'] });
    expect(parseToolCheckOutput('', [])).toEqual({ ok: true, missing: [] });
  });
});
