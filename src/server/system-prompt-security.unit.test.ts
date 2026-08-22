/**
 * 安全研究员版 P1 S1 — security 场景安全语境注入 unit tests.
 *
 * 覆盖：三段组装的零注入语义（无引擎/无配方/无现场 → 能力清单段不注入）、
 * 正常组装（按环境分组：引擎/配方工具清单/具名环境/当前现场）、字符硬顶
 * 截断（能力清单 2000、静态段在上限内）、当前现场显示（host / recipe 实例 /
 * 具名环境按注册表解析精确标记）、collectSecurityCapabilities 的依赖注入
 * 采集；D4 research-memory 段的分节组装（成功路径/失败根因/工具组合 +
 * 域分组保留）、零注入、硬顶截断、collectResearchMemory 依赖注入、以及
 * security 场景全链路段顺序（research-memory 排在 research-log 之后）。
 */
import { describe, expect, it } from 'vitest';

import type { EnvironmentEnginesReport } from './environment/engines';
import type { EnvironmentRecipe } from './environment/recipes';
import type { EnvironmentEntry } from './environment/registry';
import type { ResearchDistilledMemory } from './memory/distill-research';

import { buildSystemPromptAppend } from './system-prompt';
import {
  buildNativeCodeSection,
  buildResearchLogSection,
  buildResearchMemorySection,
  buildSecurityCapabilitiesSection,
  buildSecurityKernelSection,
  collectResearchMemory,
  collectSecurityCapabilities,
  resolveSessionResearchDomain,
  NATIVE_CODE_MAX_CHARS,
  RESEARCH_LOG_MAX_CHARS,
  RESEARCH_MEMORY_MAX_CHARS,
  SECURITY_CAPABILITIES_MAX_CHARS,
  SECURITY_KERNEL_MAX_CHARS,
  type SecurityCapabilitiesData,
} from './system-prompt-security';

// ===== Fixtures =====

function enginesReport(available: Array<'docker' | 'ssh' | 'hyperv'>): EnvironmentEnginesReport {
  const engines = (['docker', 'hyperv', 'virtualbox', 'vmware', 'libvirt', 'ssh'] as const).map((kind) => ({
    kind,
    available: available.includes(kind as 'docker' | 'ssh' | 'hyperv'),
    version: available.includes(kind as 'docker' | 'ssh' | 'hyperv') ? '1.0' : undefined,
  }));
  return {
    engines,
    hasContainerEngine: available.includes('docker'),
    hasHypervisor: available.includes('hyperv'),
    hasSsh: available.includes('ssh'),
    detectedAt: Date.now(),
  };
}

function recipe(id: string, tools: string[]): EnvironmentRecipe {
  return {
    id,
    dir: `/recipes/${id}`,
    name: id,
    base: 'docker',
    tools,
    valid: true,
    invalidReasons: [],
  };
}

const SSH_ENV: EnvironmentEntry = { id: 'range-1', kind: 'ssh', host: '10.10.0.5', user: 'root', createdAt: '2026-08-14T00:00:00Z' };
const DOCKER_ENV: EnvironmentEntry = { id: 'dev-box', kind: 'docker', container: 'zhishi-dev-a3f2', createdAt: '2026-08-14T00:00:00Z' };

function data(overrides: Partial<SecurityCapabilitiesData> = {}): SecurityCapabilitiesData {
  return {
    engines: enginesReport([]),
    recipes: [],
    environments: [],
    selection: { kind: 'host' },
    ...overrides,
  };
}

// ===== 静态段：非空 + 在上限内 =====

describe('buildSecurityKernelSection / buildNativeCodeSection', () => {
  it('kernel 段含能力空间与通用循环，且在上限内', () => {
    const section = buildSecurityKernelSection();
    expect(section).toContain('<zhishi-security-kernel>');
    expect(section).toContain('Recon 侦察 → Analyze 分析 → Construct 构造 → Execute 执行 → Evaluate 评估 → Distill 沉淀');
    expect(section).toContain('漏洞挖掘');
    expect(section).toContain('CTF');
    expect(section.length).toBeLessThanOrEqual(SECURITY_KERNEL_MAX_CHARS);
  });

  it('native-code 段含闭环通道/环境标记/行为约定/恶意样本纪律，且在上限内', () => {
    const section = buildNativeCodeSection();
    expect(section).toContain('<zhishi-native-code>');
    expect(section).toContain('zhishi env up');
    expect(section).toContain('zhishi term --cmd');
    expect(section).toContain('docker:<容器>');
    expect(section).toContain('env≠host');
    expect(section.length).toBeLessThanOrEqual(NATIVE_CODE_MAX_CHARS);
  });

  it('research-log 段（D1）声明三组枚举 + 何时记录 + 命令用法，且在上限内', () => {
    const section = buildResearchLogSection();
    expect(section).toContain('<zhishi-research-log>');
    // 枚举声明（§4 输出侧本体：system prompt 声明 = CLI 校验的同一组值）
    expect(section).toContain('binary / pentest / ai-security / redteam / malware / intel / ctf');
    expect(section).toContain('success / fail / stuck');
    expect(section).toContain('stack-overflow / heap-overflow / uaf / double-free / oob-read / oob-write / null-deref / int-overflow / format-string / type-confusion / other');
    // 何时记录 + 用法(agent 用 research_log 工具,人侧 CLI 查询/补记)
    expect(section).toContain('拿到 flag');
    expect(section).toContain('fuzz 出独有崩溃');
    expect(section).toContain('放弃');
    expect(section).toContain('research_log 工具');
    expect(section).toContain('zhishi research log');
    expect(section).toContain('zhishi research list');
    expect(section.length).toBeLessThanOrEqual(RESEARCH_LOG_MAX_CHARS);
  });
});

// ===== 能力清单段：零注入 =====

describe('buildSecurityCapabilitiesSection — 零注入', () => {
  it('数据缺失（undefined）→ 空串', () => {
    expect(buildSecurityCapabilitiesSection(undefined)).toBe('');
  });

  it('无可用引擎 + 无配方 + 无具名环境 + 未选现场（host）→ 空串', () => {
    expect(buildSecurityCapabilitiesSection(data())).toBe('');
  });

  it('配方全部 invalid 视同无配方 → 空串', () => {
    const broken: EnvironmentRecipe = {
      ...recipe('broken', ['nmap']),
      valid: false,
      invalidReasons: ['缺少 SKILL.md（配方定义文件）'],
    };
    expect(buildSecurityCapabilitiesSection(data({ recipes: [broken] }))).toBe('');
  });
});

// ===== 能力清单段：正常组装 =====

describe('buildSecurityCapabilitiesSection — 正常组装', () => {
  it('按环境分组呈现：引擎 + 配方工具清单 + 具名环境 + 当前现场', () => {
    const section = buildSecurityCapabilitiesSection(data({
      engines: enginesReport(['docker', 'ssh']),
      recipes: [recipe('dev', ['clang', 'gdb', 'python3']), recipe('pwn', ['pwndbg', 'pwntools'])],
      environments: [SSH_ENV],
      selection: { kind: 'recipe', name: 'pwn', instanceId: 'zhishi-pwn-a3f2' },
    }));
    expect(section).toContain('<zhishi-capabilities>');
    // 当前现场（recipe 实例 → docker:<instanceId>）
    expect(section).toContain('当前环境：docker:zhishi-pwn-a3f2（类型 pwn 的实例）');
    // 引擎
    expect(section).toContain('Docker（容器环境）');
    expect(section).toContain('ssh（远程/靶场接入）');
    // 配方工具清单（事实源 = SKILL.md tools[]）
    expect(section).toContain('- dev（docker）：clang、gdb、python3');
    expect(section).toContain('- pwn（docker）：pwndbg、pwntools');
    // 具名环境 → E6 精确标记
    expect(section).toContain('- range-1 → range:10.10.0.5');
    expect(section.length).toBeLessThanOrEqual(SECURITY_CAPABILITIES_MAX_CHARS);
  });

  it('只有 host 现场但存在可用引擎时仍注入（有协作对象可言）', () => {
    const section = buildSecurityCapabilitiesSection(data({ engines: enginesReport(['docker']) }));
    expect(section).toContain('当前环境：host（仅工作区控制面');
    expect(section).toContain('Docker（容器环境）');
  });

  it('具名环境现场选择按注册表解析精确标记（env → docker:<container>）', () => {
    const section = buildSecurityCapabilitiesSection(data({
      environments: [DOCKER_ENV],
      selection: { kind: 'env', id: 'dev-box' },
    }));
    expect(section).toContain('当前环境：docker:zhishi-dev-a3f2（具名环境 dev-box）');
  });

  it('env 选择在注册表查不到时兜底 env:<id>', () => {
    const section = buildSecurityCapabilitiesSection(data({
      engines: enginesReport(['ssh']),
      selection: { kind: 'env', id: 'ghost' },
    }));
    expect(section).toContain('当前环境：env:ghost（具名环境 ghost）');
  });

  it('无任何可用引擎时明示（现场暂开不起来）', () => {
    const section = buildSecurityCapabilitiesSection(data({
      recipes: [recipe('dev', ['clang'])],
    }));
    expect(section).toContain('环境引擎：未检测到可用引擎');
  });
});

// ===== 能力清单段：字符硬顶截断 =====

describe('buildSecurityCapabilitiesSection — 硬顶截断', () => {
  it('超长清单截到 2000 字符以内并带截断标记', () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      recipe(`recipe-${String(i).padStart(3, '0')}`, ['a-very-long-tool-name-for-padding-the-list']),
    );
    const section = buildSecurityCapabilitiesSection(data({
      engines: enginesReport(['docker']),
      recipes: many,
    }));
    expect(section).not.toBe('');
    expect(section.length).toBeLessThanOrEqual(SECURITY_CAPABILITIES_MAX_CHARS);
    expect(section).toContain('已按上限截断');
    // 截断按整行丢弃：最后一行内容行必须完整（无半个工具名残片）
    const contentLines = section.split('\n').filter((l) => l.startsWith('- recipe-'));
    for (const line of contentLines) {
      expect(line).toMatch(/^- recipe-\d{3}（docker）：a-very-long-tool-name-for-padding-the-list$/);
    }
  });
});

// ===== 采集：依赖注入（不碰真实环境） =====

describe('collectSecurityCapabilities', () => {
  it('按注入依赖聚合四个数据源', async () => {
    const result = await collectSecurityCapabilities('/ws/alpha', {
      detectEngines: () => Promise.resolve(enginesReport(['docker'])),
      recipesRoot: '/nonexistent-recipes-root',   // 缺根目录 → []
      config: { environments: [SSH_ENV] },
      selectionPath: '/nonexistent-selection.json', // 缺文件 → 缺省 host
    });
    expect(result.engines.hasContainerEngine).toBe(true);
    expect(result.recipes).toEqual([]);
    expect(result.environments).toEqual([SSH_ENV]);
    expect(result.selection).toEqual({ kind: 'host' });
  });
});

// ===== D4 研究记忆反喂段（<zhishi-research-memory>） =====

function memory(overrides: Partial<ResearchDistilledMemory> = {}): ResearchDistilledMemory {
  return { successPaths: '', failureRoots: '', toolCombos: '', ...overrides };
}

const SAMPLE_MEMORY: ResearchDistilledMemory = {
  successPaths: '### 域：binary\n- stack-overflow｜AFL++ 字典 + persist 模式出独有崩溃\n### 域：ctf\n- 先 checksec 再定打法',
  failureRoots: '### 域：binary\n- 死路：直接 patch 反调试——样本有完整性自校验',
  toolCombos: '### 域：binary\n- 有效：pwn 类型 + pwndbg + gef',
};

describe('buildResearchMemorySection — 零注入', () => {
  it('数据缺失（undefined）→ 空串', () => {
    expect(buildResearchMemorySection(undefined)).toBe('');
  });

  it('三分节全空 → 空串', () => {
    expect(buildResearchMemorySection(memory())).toBe('');
    expect(buildResearchMemorySection(memory({ successPaths: '  \n ' }))).toBe('');
  });
});

describe('buildResearchMemorySection — 正常组装', () => {
  it('按成功路径/失败根因/工具组合分节呈现，节内保留「### 域」分组', () => {
    const section = buildResearchMemorySection(SAMPLE_MEMORY);
    expect(section).toContain('<zhishi-research-memory>');
    expect(section).toContain('## 成功路径');
    expect(section).toContain('## 失败根因');
    expect(section).toContain('## 工具组合');
    // 域分组是蒸馏产物的内层结构，原样保留
    expect(section).toContain('### 域：binary');
    expect(section).toContain('### 域：ctf');
    expect(section).toContain('stack-overflow｜AFL++ 字典');
    expect(section).toContain('死路：直接 patch 反调试');
    expect(section).toContain('pwn 类型 + pwndbg + gef');
    // 分节顺序固定：成功路径 → 失败根因 → 工具组合
    expect(section.indexOf('## 成功路径')).toBeLessThan(section.indexOf('## 失败根因'));
    expect(section.indexOf('## 失败根因')).toBeLessThan(section.indexOf('## 工具组合'));
  });

  it('空分节不出现（只注入有内容的分节）', () => {
    const section = buildResearchMemorySection(memory({ failureRoots: '### 域：pentest\n- 死路：弱口令爆破全被锁' }));
    expect(section).toContain('<zhishi-research-memory>');
    expect(section).not.toContain('## 成功路径');
    expect(section).toContain('## 失败根因');
    expect(section).not.toContain('## 工具组合');
  });
});

describe('buildResearchMemorySection — 硬顶截断', () => {
  it('超长内容截到 2000 字符以内并带截断标记，按整行截断', () => {
    const longLine = (i: number) => `- 经验条目 ${String(i).padStart(3, '0')}：这是一条足够长的分域安全经验内容用来撑爆硬顶`;
    const section = buildResearchMemorySection(memory({
      successPaths: ['### 域：binary', ...Array.from({ length: 120 }, (_, i) => longLine(i))].join('\n'),
    }));
    expect(section).not.toBe('');
    expect(section.length).toBeLessThanOrEqual(RESEARCH_MEMORY_MAX_CHARS);
    expect(section).toContain('已按上限截断');
    // 整行丢弃：保留的经验条目行必须完整（无半行残片）
    const kept = section.split('\n').filter((l) => l.startsWith('- 经验条目'));
    expect(kept.length).toBeGreaterThan(0);
    for (const line of kept) {
      expect(line).toMatch(/^- 经验条目 \d{3}：这是一条足够长的分域安全经验内容用来撑爆硬顶$/);
    }
  });
});

// ===== D4 采集：依赖注入（不碰真实 db） =====

describe('collectResearchMemory', () => {
  it('走注入的读取函数并透传 baseDir', () => {
    const calls: string[] = [];
    const result = collectResearchMemory({
      baseDir: '/tmp/fake-zhishi',
      read: (baseDir: string) => {
        calls.push(baseDir);
        return SAMPLE_MEMORY;
      },
    });
    expect(calls).toEqual(['/tmp/fake-zhishi']);
    expect(result).toEqual(SAMPLE_MEMORY);
  });
});

// ===== D4 接线：与 capabilities 段共存顺序（security 分支完整链路） =====

describe('buildSystemPromptAppend — security 场景段顺序', () => {
  it('research-memory 段排在 capabilities / native-code / research-log 之后', () => {
    const prompt = buildSystemPromptAppend({ type: 'security' }, {
      securityCapabilities: data({ engines: enginesReport(['docker']) }),
      securityResearchMemory: SAMPLE_MEMORY,
    });
    const iCap = prompt.indexOf('<zhishi-capabilities>');
    const iNative = prompt.indexOf('<zhishi-native-code>');
    const iLog = prompt.indexOf('<zhishi-research-log>');
    const iMem = prompt.indexOf('<zhishi-research-memory>');
    expect(iCap).toBeGreaterThan(-1);
    expect(iMem).toBeGreaterThan(-1);
    expect(iCap).toBeLessThan(iNative);
    expect(iNative).toBeLessThan(iLog);
    expect(iLog).toBeLessThan(iMem);
  });

  it('无蒸馏产物时 research-memory 段零注入，其余段不受影响', () => {
    const prompt = buildSystemPromptAppend({ type: 'security' }, {
      securityCapabilities: data({ engines: enginesReport(['docker']) }),
      securityResearchMemory: memory(),
    });
    expect(prompt).toContain('<zhishi-capabilities>');
    expect(prompt).toContain('<zhishi-research-log>');
    expect(prompt).not.toContain('<zhishi-research-memory>');
  });

  it('desktop 场景不注入 research-memory（security 专属）', () => {
    const prompt = buildSystemPromptAppend({ type: 'desktop' }, {
      securityResearchMemory: SAMPLE_MEMORY,
    });
    expect(prompt).not.toContain('<zhishi-research-memory>');
  });
});

// ===== 1.2.4 深化：域过滤 =====

describe('buildResearchMemorySection — 按会话域过滤（1.2.4）', () => {
  it('给定域：注入该域子节 + 跨域通用行；ctf 子节视同跨域通用（kernel 定位）', () => {
    const section = buildResearchMemorySection(memory({
      successPaths: '### 域：binary\n- stack-overflow｜AFL++ 字典 + persist 模式出独有崩溃\n### 域：ctf\n- 先 checksec 再定打法\n### 域：pentest\n- 渗透专用：kerberoasting 拿票据',
      failureRoots: '### 域：binary\n- 死路：直接 patch 反调试——样本有完整性自校验',
      toolCombos: '### 域：binary\n- 有效：pwn 类型 + pwndbg + gef',
    }), { domain: 'binary' });
    expect(section).toContain('<zhishi-research-memory>');
    expect(section).toContain('### 域：binary');
    expect(section).toContain('stack-overflow｜AFL++ 字典');
    // pentest 子节整节去掉（标题与内容都不在）。
    expect(section).not.toContain('### 域：pentest');
    expect(section).not.toContain('kerberoasting');
    // ctf 是全域补充场景，保留。
    expect(section).toContain('### 域：ctf');
    expect(section).toContain('先 checksec 再定打法');
    // 引言行声明已按域过滤。
    expect(section).toContain('已按当前会话域 binary 过滤');
  });

  it('跨域通用行（无 ### 域 前缀）在过滤后保留', () => {
    const section = buildResearchMemorySection(memory({
      successPaths: '- 通用：先建心智模型再动手\n### 域：pentest\n- 渗透专用经验',
    }), { domain: 'binary' });
    expect(section).toContain('通用：先建心智模型再动手');
    expect(section).not.toContain('渗透专用经验');
  });

  it('过滤后三分节全空 → 整段零注入', () => {
    // 只有 malware 内容，binary 会话（ctf 除外）无任何可注入子节。
    const only = memory({ failureRoots: '### 域：malware\n- 样本反调试死路' });
    expect(buildResearchMemorySection(only, { domain: 'binary' })).toBe('');
  });

  it('无域信号（不传 domain）→ 全量注入（降级语义不变）', () => {
    const section = buildResearchMemorySection(SAMPLE_MEMORY, {});
    expect(section).toContain('### 域：ctf');
    expect(section).toContain('先 checksec 再定打法');
  });

  it('过滤后内容变短，硬顶截断标记仍是研究记忆专用文案', () => {
    const longLine = (i: number) => `- 经验条目 ${String(i).padStart(3, '0')}：这是一条足够长的分域安全经验内容用来撑爆硬顶`;
    const section = buildResearchMemorySection(memory({
      successPaths: ['### 域：binary', ...Array.from({ length: 120 }, (_, i) => longLine(i))].join('\n'),
    }), { domain: 'binary' });
    expect(section.length).toBeLessThanOrEqual(RESEARCH_MEMORY_MAX_CHARS);
    expect(section).toContain('研究记忆超出注入预算，已按上限截断');
  });
});

// ===== 1.2.4 深化：会话域推导 =====

describe('resolveSessionResearchDomain（1.2.4 域过滤信号源）', () => {
  const MANIFESTS = [
    { kind: 'binary', name: '二进制', recipes: ['pwn', 'pwn-vm', 'fuzz'], skills: [], subagents: [], signals: [], acceptance: [] },
    { kind: 'pentest', name: '渗透', recipes: ['pentest'], skills: [], subagents: [], signals: [], acceptance: [] },
  ];

  it('host 现场 / 数据缺失 → undefined（降级全量）', () => {
    expect(resolveSessionResearchDomain(undefined, MANIFESTS)).toBeUndefined();
    expect(resolveSessionResearchDomain(data(), MANIFESTS)).toBeUndefined();
  });

  it('recipe 现场：按配方 id 反查域清单', () => {
    const d = data({ selection: { kind: 'recipe', name: 'pwn', instanceId: 'zhishi-pwn-a3f2' } });
    expect(resolveSessionResearchDomain(d, MANIFESTS)).toBe('binary');
  });

  it('env 现场：recipeId 优先，回落 id/vmName 同名配方', () => {
    const withRecipe = data({
      environments: [{ ...DOCKER_ENV, id: 'my-box', recipeId: 'fuzz' }],
      selection: { kind: 'env', id: 'my-box' },
    });
    expect(resolveSessionResearchDomain(withRecipe, MANIFESTS)).toBe('binary');
    // 老条目无 recipeId → id 同名配方（pwn-vm）。
    const legacy = data({
      environments: [{ id: 'pwn-vm', kind: 'vm' as const, vmName: 'pwn-vm', createdAt: '' }],
      selection: { kind: 'env', id: 'pwn-vm' },
    });
    expect(resolveSessionResearchDomain(legacy, MANIFESTS)).toBe('binary');
  });

  it('配方未被任何域清单覆盖 / env 条目不存在 → undefined', () => {
    const unknown = data({ selection: { kind: 'recipe', name: 'dev', instanceId: 'x' } });
    expect(resolveSessionResearchDomain(unknown, MANIFESTS)).toBeUndefined();
    const ghost = data({ selection: { kind: 'env', id: 'ghost' } });
    expect(resolveSessionResearchDomain(ghost, MANIFESTS)).toBeUndefined();
  });
});

// ===== 1.2.4 深化：judge wrong 降权 =====

describe('collectResearchMemory — judge wrong 分节不注入（1.2.4）', () => {
  it('judgedWrong 命中的分节被清空；其余分节不动；不改动 read 返回的原对象', () => {
    const fixture = memory({
      successPaths: '### 域：binary\n- 有效路径',
      failureRoots: '### 域：binary\n- 被判错的根因经验',
    });
    const result = collectResearchMemory({
      baseDir: '/tmp/fake-zhishi',
      read: () => fixture,
      judgedWrong: (_kind, storeKey) => storeKey === 'research-distill:failure-roots',
    });
    expect(result.successPaths).toBe(fixture.successPaths);
    expect(result.failureRoots).toBe('');
    // 原 fixture 不被改写（调用方可能复用）。
    expect(fixture.failureRoots).toContain('被判错的根因经验');
  });

  it('judgedWrong 查证抛错 → 按未判错处理（降权不是闸门）', () => {
    const result = collectResearchMemory({
      baseDir: '/tmp/fake-zhishi',
      read: () => SAMPLE_MEMORY,
      judgedWrong: () => { throw new Error('db gone'); },
    });
    expect(result).toEqual(SAMPLE_MEMORY);
  });

  it('read 注入但未给 judgedWrong → 不做判错查证（测试不碰库）', () => {
    const result = collectResearchMemory({ baseDir: '/tmp/fake-zhishi', read: () => SAMPLE_MEMORY });
    expect(result).toEqual(SAMPLE_MEMORY);
  });
});

// ===== 1.2.4 接线：securityResearchDomain 经 buildSystemPromptAppend 生效 =====

describe('buildSystemPromptAppend — security 场景域过滤接线（1.2.4）', () => {
  it('传 securityResearchDomain 时 research-memory 段按域过滤', () => {
    const prompt = buildSystemPromptAppend({ type: 'security' }, {
      securityCapabilities: data({ engines: enginesReport(['docker']) }),
      securityResearchMemory: memory({
        successPaths: '### 域：binary\n- stack-overflow｜AFL++ 字典\n### 域：pentest\n- 渗透专用经验',
      }),
      securityResearchDomain: 'binary',
    });
    expect(prompt).toContain('<zhishi-research-memory>');
    expect(prompt).toContain('stack-overflow｜AFL++ 字典');
    expect(prompt).not.toContain('渗透专用经验');
  });
});
