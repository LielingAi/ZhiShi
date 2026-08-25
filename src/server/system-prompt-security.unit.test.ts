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
import type { DomainManifest } from './domains/manifest';
import {
  buildNativeCodeSection,
  buildResearchLogSection,
  buildResearchMemorySection,
  buildSecurityCapabilitiesSection,
  buildSecurityKernelSection,
  collectResearchMemory,
  collectSecurityCapabilities,
  resolveSessionDomain,
  resolveSessionResearchDomain,
  DOMAIN_SIGNAL_RECENT_MESSAGES,
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
    // 1.2.6 批次 C：pi 通道无宿主 shell——闭环通道改教 env_exec/env_bg，
    // 开/接环境归为人侧动作；不再教 `zhishi term --cmd`（够不到的 CLI）。
    expect(section).not.toContain('zhishi term --cmd');
    expect(section).toContain('env_exec');
    expect(section).toContain('env_bg');
    expect(section).toContain('人侧');
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
    // 1.2.6 批次 C：截断顺序修正后,配方清单行由第二档主动让位并显式声明
    // (「因预算未注入」),不再走到 hardCapLines 的尾部截断标记;声明语义等价
    // (丢弃可观测,不静默)。
    expect(section).toContain('因预算未注入');
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

// ===== 1.2.5「用」：配方正文工作流摘要进能力清单 =====

describe('buildSecurityCapabilitiesSection — 配方工作流摘要（1.2.5「用」）', () => {
  it('带 workflowSummary 的配方在工具行后注入摘要行；无摘要的配方不出摘要行', () => {
    const withSummary: EnvironmentRecipe = {
      ...recipe('pwn', ['pwndbg', 'pwntools']),
      workflowSummary: 'pwn 环境；checksec 判保护 → cyclic 定偏移 → ROP 链',
    };
    const section = buildSecurityCapabilitiesSection(data({
      recipes: [withSummary, recipe('dev', ['clang'])],
    }));
    expect(section).toContain('- pwn（docker）：pwndbg、pwntools');
    expect(section).toContain('  工作流摘要：pwn 环境；checksec 判保护 → cyclic 定偏移 → ROP 链');
    // 无摘要配方不出摘要行（零注入语义逐配方生效；段头说明行不算摘要行）
    expect(section).toContain('- dev（docker）：clang');
    expect(section.split('\n').filter((l) => l.startsWith('  工作流摘要：'))).toHaveLength(1);
  });

  it('预算分配：工具清单（核心）全量保留，摘要（增强）逐条试装，装不下的显式声明', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...recipe(`recipe-${String(i).padStart(3, '0')}`, ['tool']),
      workflowSummary: `摘要 ${i}：${'工作流内容'.repeat(80)}`, // ~400 字符/环境
    }));
    const section = buildSecurityCapabilitiesSection(data({
      engines: enginesReport(['docker']),
      recipes: many,
    }));
    expect(section).not.toBe('');
    expect(section.length).toBeLessThanOrEqual(SECURITY_CAPABILITIES_MAX_CHARS);
    // 核心（工具清单）一条不丢——摘要让位不能牺牲发现环链路
    for (let i = 0; i < 20; i += 1) {
      expect(section).toContain(`- recipe-${String(i).padStart(3, '0')}（docker）：tool`);
    }
    // 摘要装进预算内的保留（完整行，无半行残片）；装不下的显式声明
    const summaryLines = section.split('\n').filter((l) => l.startsWith('  工作流摘要：'));
    expect(summaryLines.length).toBeGreaterThan(0);
    for (const line of summaryLines) {
      expect(line).toMatch(/^ {2}工作流摘要：摘要 \d+：(?:工作流内容)+$/);
    }
    expect(section).toContain('个环境类型的工作流摘要因预算未注入');
  });

  it('摘要全装得下时不出现丢弃声明（零噪音）', () => {
    const section = buildSecurityCapabilitiesSection(data({
      recipes: [{ ...recipe('pwn', ['pwndbg']), workflowSummary: '短摘要' }],
    }));
    expect(section).toContain('  工作流摘要：短摘要');
    expect(section).not.toContain('因预算未注入');
  });
});

// ===== 1.2.6 批次 C 深化 =====

describe('buildSecurityKernelSection — intel_search 进内核（1.2.6）', () => {
  it('知识权威级段落声明 intel_search（公共原料，线索不是结论）', () => {
    const section = buildSecurityKernelSection();
    expect(section).toContain('intel_search');
    expect(section.length).toBeLessThanOrEqual(SECURITY_KERNEL_MAX_CHARS);
  });
});

describe('buildSecurityKernelSection — 决策点语义（1.3.2）', () => {
  it('kernel 段声明 request_decision：分歧/无把握且库无基准才提请；先查 expert_search；提请后暂停', () => {
    const section = buildSecurityKernelSection();
    expect(section).toContain('request_decision');
    expect(section).toContain('库中无基准');
    expect(section).toContain('先查 expert_search');
    expect(section).toContain('暂停这条线的执行');
    expect(section).toContain('user 消息注入回来');
    expect(section.length).toBeLessThanOrEqual(SECURITY_KERNEL_MAX_CHARS);
  });
});

describe('buildResearchLogSection — 余量修复（1.2.6）', () => {
  it('模板完整注入：收尾标签在、无截断标记（旧 500 顶会把收尾标签截掉）', () => {
    const section = buildResearchLogSection();
    expect(section).toContain('</zhishi-research-log>');
    expect(section).not.toContain('已按上限截断');
    expect(section.length).toBeLessThanOrEqual(RESEARCH_LOG_MAX_CHARS);
  });
});

describe('buildSecurityCapabilitiesSection — 截断顺序（1.2.6）', () => {
  it('超顶时先丢配方清单行，具名环境条目保到最后（旧实现从尾部整行丢，环境条目最先丢）', () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      recipe(`recipe-${String(i).padStart(3, '0')}`, ['a-very-long-tool-name-for-padding-the-list']),
    );
    const section = buildSecurityCapabilitiesSection(data({
      engines: enginesReport(['docker']),
      recipes: many,
      environments: [SSH_ENV, DOCKER_ENV],
    }));
    expect(section).not.toBe('');
    expect(section.length).toBeLessThanOrEqual(SECURITY_CAPABILITIES_MAX_CHARS);
    // 环境条目是现场事实——截断也不能丢
    expect(section).toContain('- range-1 → range:10.10.0.5');
    expect(section).toContain('- dev-box → docker:zhishi-dev-a3f2');
    // 配方清单行整行让位（无半行残片），丢弃显式声明
    const recipeLines = section.split('\n').filter((l) => l.startsWith('- recipe-'));
    for (const line of recipeLines) {
      expect(line).toMatch(/^- recipe-\d{3}（docker）：a-very-long-tool-name-for-padding-the-list$/);
    }
    expect(recipeLines.length).toBeLessThan(80);
    expect(section).toContain('因预算未注入');
  });

  it('配方让位顺序：从清单尾部丢（靠前的配方先保住）', () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      recipe(`recipe-${String(i).padStart(3, '0')}`, ['a-very-long-tool-name-for-padding-the-list']),
    );
    const section = buildSecurityCapabilitiesSection(data({
      recipes: many,
      environments: [SSH_ENV],
    }));
    expect(section).toContain('- recipe-000（docker）');
    expect(section).not.toContain('- recipe-079（docker）');
  });
});


// ===== 1.2.7 域边界：能力清单分域收窄 =====

describe('buildSecurityCapabilitiesSection — 域收窄（1.2.7）', () => {
  const CAPS_MANIFESTS: DomainManifest[] = [
    { kind: 'binary', name: '二进制', recipes: ['pwn', 'fuzz'], skills: [], subagents: [], signals: [], acceptance: [] },
    { kind: 'pentest', name: '渗透', recipes: ['pentest'], skills: [], subagents: [], signals: [], acceptance: [] },
  ];
  const PWN_ENV: EnvironmentEntry = { id: 'pwn-box', kind: 'docker', container: 'zhishi-pwn-a3f2', recipeId: 'pwn', createdAt: '' };
  const PENTEST_ENV: EnvironmentEntry = { id: 'pt-box', kind: 'ssh', host: '10.10.0.9', user: 'root', recipeId: 'pentest', createdAt: '' };
  const MANUAL_ENV: EnvironmentEntry = { id: 'manual-box', kind: 'ssh', host: '10.10.0.10', user: 'root', createdAt: '' };

  const fullData = () => data({
    engines: enginesReport(['docker', 'ssh']),
    recipes: [recipe('pwn', ['pwndbg']), recipe('fuzz', ['afl++']), recipe('pentest', ['nmap']), recipe('dev', ['clang'])],
    environments: [PWN_ENV, PENTEST_ENV, MANUAL_ENV],
  });

  it('域命中清单 → 只列该域 recipes ∪ 绑定了这些配方的具名环境', () => {
    const section = buildSecurityCapabilitiesSection(fullData(), { domain: 'binary', manifests: CAPS_MANIFESTS });
    // 域内配方保留，域外配方整行消失
    expect(section).toContain('- pwn（docker）：pwndbg');
    expect(section).toContain('- fuzz（docker）：afl++');
    expect(section).not.toContain('- pentest（docker）');
    expect(section).not.toContain('- dev（docker）');
    // 绑定域内配方的具名环境保留；绑定域外配方 / 无类型绑定的被收窄掉
    expect(section).toContain('- pwn-box → docker:zhishi-pwn-a3f2');
    expect(section).not.toContain('- pt-box →');
    expect(section).not.toContain('- manual-box →');
    // 现场行与引擎行不受收窄影响
    expect(section).toContain('当前环境：');
    expect(section).toContain('Docker（容器环境）');
  });

  it('无域（不传/空 options）→ 与现状逐字节一致（全量）', () => {
    const d = fullData();
    const legacy = buildSecurityCapabilitiesSection(d);
    expect(buildSecurityCapabilitiesSection(d, {})).toBe(legacy);
    expect(legacy).toContain('- pentest（docker）：nmap');
    expect(legacy).toContain('- pt-box →');
    expect(legacy).toContain('- manual-box →');
  });

  it('域未被任何清单覆盖 → 全量（宁多勿缺）', () => {
    const section = buildSecurityCapabilitiesSection(fullData(), { domain: 'malware', manifests: CAPS_MANIFESTS });
    expect(section).toContain('- pentest（docker）：nmap');
    expect(section).toContain('- manual-box →');
  });
});

// ===== 1.2.7 域边界：域动态修正（配方默认 + 内容信号） =====

describe('resolveSessionDomain（1.2.7 配方默认 + 信号动态修正）', () => {
  const SIGNAL_MANIFESTS: DomainManifest[] = [
    {
      kind: 'binary', name: '二进制', recipes: ['pwn', 'pwn-vm', 'fuzz'], skills: [], subagents: [],
      signals: [
        { re: 'SIGSEGV', label: '崩溃信号' },
        { re: 'core dumped', label: 'core dump' },
      ],
      acceptance: [],
    },
    {
      kind: 'pentest', name: '渗透', recipes: ['pentest'], skills: [], subagents: [],
      signals: [
        { re: 'session \\d+ opened', label: '会话已开' },
        { re: '\\[\\+\\]', label: '成功标记' },
      ],
      acceptance: [],
    },
  ];
  const msg = (content: unknown) => ({ content });
  // 基线 = binary（recipe 现场 pwn → 域清单反查）。
  const binaryBaseline = data({ selection: { kind: 'recipe', name: 'pwn', instanceId: 'x' } });

  it('有基线且无强信号（命中 <2）→ 维持基线', () => {
    const messages = [msg('跑了一下'), msg('程序崩了：SIGSEGV')];
    expect(resolveSessionDomain(messages, binaryBaseline, SIGNAL_MANIFESTS)).toBe('binary');
  });

  it('无基线（host 现场）且信号强 → 采用信号域', () => {
    const messages = [msg('session 1 opened'), msg('[+] 拿到 shell')];
    expect(resolveSessionDomain(messages, data(), SIGNAL_MANIFESTS)).toBe('pentest');
  });

  it('基线与信号域不同且信号强（≥3 且 ≥2 倍于基线域）→ 改判信号域', () => {
    const messages = [
      msg('段错误 SIGSEGV'),          // binary ×1
      msg('session 1 opened'),         // pentest ×3
      msg('session 2 opened'),
      msg('[+] shell'),
    ];
    expect(resolveSessionDomain(messages, binaryBaseline, SIGNAL_MANIFESTS)).toBe('pentest');
  });

  it('信号域命中 <3 或不足基线域 2 倍 → 维持基线（零星命中不翻盘）', () => {
    const messages = [msg('session 1 opened'), msg('[+] shell'), msg('SIGSEGV')];
    expect(resolveSessionDomain(messages, binaryBaseline, SIGNAL_MANIFESTS)).toBe('binary');
  });

  it('信号打平（两域同数）→ 维持基线', () => {
    const messages = [msg('SIGSEGV'), msg('core dumped'), msg('session 1 opened'), msg('[+] x')];
    expect(resolveSessionDomain(messages, binaryBaseline, SIGNAL_MANIFESTS)).toBe('binary');
    // 无基线时打平 → undefined（全量，宁多勿缺）
    expect(resolveSessionDomain(messages, data(), SIGNAL_MANIFESTS)).toBeUndefined();
  });

  it('无任何命中 → 维持基线；无基线 → undefined', () => {
    const messages = [msg('你好'), msg('继续分析')];
    expect(resolveSessionDomain(messages, binaryBaseline, SIGNAL_MANIFESTS)).toBe('binary');
    expect(resolveSessionDomain(messages, data(), SIGNAL_MANIFESTS)).toBeUndefined();
    expect(resolveSessionDomain([], data(), SIGNAL_MANIFESTS)).toBeUndefined();
  });

  it('只扫最近 20 条消息：窗口外的命中不计', () => {
    const filler = Array.from({ length: DOMAIN_SIGNAL_RECENT_MESSAGES }, () => msg('无关内容'));
    // 命中全在窗口外（第 0 条被 slice(-20) 排除）→ 无强信号
    const outOfWindow = [msg('session 1 opened\nsession 2 opened'), ...filler];
    expect(resolveSessionDomain(outOfWindow, data(), SIGNAL_MANIFESTS)).toBeUndefined();
    // 对照：同样命中放窗口内（末尾）→ 采用信号域
    const inWindow = [...filler, msg('session 1 opened\nsession 2 opened')];
    expect(resolveSessionDomain(inWindow, data(), SIGNAL_MANIFESTS)).toBe('pentest');
  });

  it('命中 text 块 / toolCall 参数同样计入（与 messageText 同口径）', () => {
    const messages = [
      msg([{ type: 'text', text: 'session 1 opened' }]),
      msg([{ type: 'toolCall', name: 'env_exec', arguments: { cmd: 'check' } }, { type: 'text', text: '[+] done' }]),
    ];
    expect(resolveSessionDomain(messages, data(), SIGNAL_MANIFESTS)).toBe('pentest');
  });

  it('manifests 缺省走真实 bundled-domains：binary 信号命中 → binary', () => {
    const messages = [msg('Program received signal SIGSEGV'), msg('core dumped')];
    expect(resolveSessionDomain(messages, data())).toBe('binary');
  });
});

// ===== 1.2.7 接线：securityResearchDomain 同时收窄 capabilities 段 =====

describe('buildSystemPromptAppend — securityResearchDomain 透传能力清单（1.2.7）', () => {
  it('传域时 capabilities 段只列该域配方（真实 bundled-domains 清单）', () => {
    const prompt = buildSystemPromptAppend({ type: 'security' }, {
      securityCapabilities: data({
        engines: enginesReport(['docker']),
        recipes: [recipe('pwn', ['pwndbg']), recipe('pentest', ['nmap'])],
      }),
      securityResearchDomain: 'binary',
    });
    expect(prompt).toContain('<zhishi-capabilities>');
    expect(prompt).toContain('- pwn（docker）：pwndbg');
    expect(prompt).not.toContain('- pentest（docker）：nmap');
  });

  it('不传域 → capabilities 段全量（现状语义不变）', () => {
    const prompt = buildSystemPromptAppend({ type: 'security' }, {
      securityCapabilities: data({
        engines: enginesReport(['docker']),
        recipes: [recipe('pwn', ['pwndbg']), recipe('pentest', ['nmap'])],
      }),
    });
    expect(prompt).toContain('- pwn（docker）：pwndbg');
    expect(prompt).toContain('- pentest（docker）：nmap');
  });
});
