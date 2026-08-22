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
  buildRecipeWorkflowSummary,
  buildToolCheckCommand,
  buildToolCheckScript,
  isRecipeBackupDir,
  loadRecipe,
  parseRecipeFrontmatter,
  parseToolCheckOutput,
  RECIPE_WORKFLOW_SUMMARY_MAX_CHARS,
  scanRecipes,
  TOOL_PROBE_COMMANDS,
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

describe('声明词 → 探测命令映射（1.2.5「配」）', () => {
  it('TOOL_PROBE_COMMANDS:七个能力名的探测命令', () => {
    expect(TOOL_PROBE_COMMANDS).toEqual({
      pwntools: 'python3 -c "import pwn"',
      pwndbg: 'gdb -q -batch -ex "pi import pwndbg"',
      ripgrep: 'command -v rg',
      'universal-ctags': 'command -v ctags',
      ghidra: 'command -v analyzeHeadless',
      binutils: 'command -v objdump',
      nodejs: 'command -v node',
    });
  });

  it('buildToolCheckScript:PATH 前缀打头(非交互 ssh 没有 ~/.local/bin)', () => {
    const script = buildToolCheckScript(['gdb']);
    expect(script.startsWith('export PATH="$HOME/.local/bin:$PATH"; ')).toBe(true);
  });

  it('buildToolCheckScript:实名走 command -v 循环(与 buildToolCheckCommand 同形态)', () => {
    const script = buildToolCheckScript(['semgrep', 'pip-audit']);
    expect(script).toContain(
      `for t in 'semgrep' 'pip-audit'; do command -v "$t" >/dev/null 2>&1 && echo "OK:$t" || echo "MISS:$t"; done`,
    );
  });

  it('buildToolCheckScript:能力名走映射命令,echo 的仍是声明词(parse 协议不变)', () => {
    const script = buildToolCheckScript(['pwntools', 'universal-ctags']);
    expect(script).toContain('python3 -c "import pwn" >/dev/null 2>&1 && echo "OK:pwntools" || echo "MISS:pwntools"');
    expect(script).toContain('command -v ctags >/dev/null 2>&1 && echo "OK:universal-ctags" || echo "MISS:universal-ctags"');
    // 能力名不再进 command -v <能力名> 的假 MISS 循环
    expect(script).not.toContain("'pwntools'");
    expect(script).not.toContain("'universal-ctags'");
  });

  it('buildToolCheckScript:混合清单两形态共存;空清单只有 PATH 前缀', () => {
    const mixed = buildToolCheckScript(['gdb', 'ripgrep']);
    expect(mixed).toContain('command -v rg >/dev/null 2>&1 && echo "OK:ripgrep" || echo "MISS:ripgrep"');
    expect(mixed).toContain(`for t in 'gdb';`);
    expect(buildToolCheckScript([])).toBe('export PATH="$HOME/.local/bin:$PATH"');
  });

  it('脚本输出与 parseToolCheckOutput 协议对齐:OK/MISS:<声明词>', () => {
    // 映射形态与循环形态产出的行,parse 都认(声明词原样回显)
    expect(parseToolCheckOutput('OK:pwntools\nMISS:gdb\n', ['pwntools', 'gdb']))
      .toEqual({ ok: false, missing: ['gdb'] });
  });
});

describe('isRecipeBackupDir(播种备份目录扫描排除)', () => {
  it('<配方>.bak-<YYYYMMDD> 与 -N 后缀命中;普通配方目录不命中', () => {
    expect(isRecipeBackupDir('pwn.bak-20260822')).toBe(true);
    expect(isRecipeBackupDir('pwn.bak-20260822-2')).toBe(true);
    expect(isRecipeBackupDir('pwn')).toBe(false);
    expect(isRecipeBackupDir('pwn.bak')).toBe(false);
    expect(isRecipeBackupDir('pwn.bak-2026')).toBe(false);
  });

  it('scanRecipes 跳过备份目录(含 SKILL.md 也不进清单)', () => {
    const root = mkdtempSync(join(tmpdir(), 'zhishi-recipes-bak-'));
    try {
      for (const id of ['real', 'real.bak-20260822']) {
        mkdirSync(join(root, id), { recursive: true });
        writeFileSync(join(root, id, 'SKILL.md'), VALID_VM_SKILL);
      }
      const recipes = scanRecipes(root);
      expect(recipes.map((r) => r.id)).toEqual(['real']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('配方正文工作流摘要（1.2.5「用」——正文进能力清单）', () => {
  it('buildRecipe 从正文提炼 workflowSummary：去 frontmatter/标题符/空行/围栏，逐行以「；」连段', () => {
    const recipe = buildRecipe(
      'web-recon',
      '/x/web-recon',
      VALID_DOCKER_SKILL,
      new Set(['SKILL.md', 'Dockerfile']),
    );
    expect(recipe.valid).toBe(true);
    // VALID_DOCKER_SKILL 正文 = '# web-recon' + '何时用、怎么进、结果怎么采、怎么收尾。'
    expect(recipe.workflowSummary).toBe('web-recon；何时用、怎么进、结果怎么采、怎么收尾。');
  });

  it('超长正文按 RECIPE_WORKFLOW_SUMMARY_MAX_CHARS 截断并带 … 标记（预算护栏）', () => {
    const summary = buildRecipeWorkflowSummary(`${VALID_DOCKER_SKILL}\n${'长'.repeat(600)}`);
    expect(summary).toBeDefined();
    expect(summary!.length).toBe(RECIPE_WORKFLOW_SUMMARY_MAX_CHARS);
    expect(summary!.endsWith('…')).toBe(true);
  });

  it('无正文（仅 frontmatter / 全空白）→ workflowSummary undefined（注入侧不出摘要行）', () => {
    expect(buildRecipeWorkflowSummary('---\nname: x\nbase: docker\n---\n')).toBeUndefined();
    expect(buildRecipeWorkflowSummary('---\nname: x\n---\n\n  \n')).toBeUndefined();
    const recipe = buildRecipe(
      'bare',
      '/x/bare',
      '---\nname: bare\ndescription: d\nbase: vm\n---\n',
      new Set(['SKILL.md']),
    );
    expect(recipe.valid).toBe(true);
    expect(recipe.workflowSummary).toBeUndefined();
  });

  it('无 frontmatter 时全文即正文（老配方容错），标题符照常剥掉', () => {
    expect(buildRecipeWorkflowSummary('# 直接正文\n\n怎么做。')).toBe('直接正文；怎么做。');
  });

  it('代码围栏行剔除、围栏内命令保留（标准工作流的命令是摘要的干货）', () => {
    const content = `${VALID_DOCKER_SKILL}\n\`\`\`bash\nchecksec --file=./vuln\n\`\`\`\n`;
    expect(buildRecipeWorkflowSummary(content)).toContain('checksec --file=./vuln');
    expect(buildRecipeWorkflowSummary(content)).not.toContain('```');
  });

  it('小节标题（## 及以下）整行剔除——结构标记是噪音；H1 标题剥 # 保留（一句话定位是干货）', () => {
    const content = '---\nname: x\n---\n# x —— 侦察环境\n\n## 何时用\n\n扫端口。\n';
    expect(buildRecipeWorkflowSummary(content)).toBe('x —— 侦察环境；扫端口。');
  });
});
