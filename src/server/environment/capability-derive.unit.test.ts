/**
 * 1.3.7 场景 3 — 环境能力集合现场推导 unit tests。
 *
 * 覆盖：工具→域反推表（经 配方→domain.json recipes 反查）、探测面并集、
 * 探测输出解析、绑定域反查（recipeId 优先/回落 id/vmName）、合并规则
 * （绑定域在前=基线语义）、probeEnvironmentCapabilities 的注入 exec 接线
 * （通道失败 → undefined 不写能力字段；绑定域恒在集合不需探测证据；
 * 零命中且无绑定 → undefined 不误判空集合）。
 */
import { describe, expect, it } from 'vitest';

import type { DomainManifest } from '../../shared/domain-manifest';
import type { EnvironmentEntry } from '../../shared/config-types';
import type { EnvironmentRecipe } from './recipes';
import {
  boundDomainsForEntry,
  boundRecipeIdsForEntry,
  buildLocalToolchainProbeScript,
  buildRecipeDomainMap,
  buildToolDomainIndex,
  capabilityMissingInScope,
  capabilityScopeTools,
  collectProbeSurface,
  LOCAL_TOOLCHAIN_PROBE,
  mergeCapabilityDomains,
  parseLocalToolchainProbe,
  parseProbePresentTools,
  probeEnvironmentCapabilities,
  probedDomainsForTools,
} from './capability-derive';

// ===== Fixtures =====

function recipe(id: string, tools: string[], valid = true, firstRunTools?: string[]): EnvironmentRecipe {
  return {
    id,
    dir: `/recipes/${id}`,
    name: id,
    base: 'docker',
    tools,
    ...(firstRunTools ? { firstRunTools } : {}),
    valid,
    invalidReasons: valid ? [] : ['缺少 SKILL.md（配方定义文件）'],
  };
}

function manifest(kind: string, recipes: string[]): DomainManifest {
  return { kind, name: kind, recipes, subagents: [], signals: [], acceptance: [] };
}

const RECIPES = [
  // python3 同时被 binary 域（pwn）与 pentest 域（pentest）声明——1.9.3 起
  // 「跨域共用工具」不构成任何域的证据（真实世界：python3 被 9 个配方声明）。
  recipe('pwn', ['gdb', 'pwntools', 'ROPgadget', 'python3']),
  recipe('fuzz', ['afl-fuzz', 'gdb']),
  recipe('pentest', ['nmap', 'hydra', 'python3']),
  recipe('code-audit', ['opengrep', 'rg']),
  recipe('dev', ['clang', 'gdb']), // dev 不属于任何域——工具在探测面但不落域
  recipe('broken', ['ghost-tool'], false), // invalid 配方不进反推表/探测面
];
const MANIFESTS = [
  manifest('binary', ['pwn', 'fuzz']),
  manifest('pentest', ['pentest']),
  manifest('whitebox', ['code-audit']),
];

const ENTRY: EnvironmentEntry = {
  id: 'zhishi-pwn-a3f2',
  kind: 'docker',
  container: 'zhishi-pwn-a3f2',
  recipeId: 'pwn',
  createdAt: '2026-08-25T00:00:00Z',
};

describe('buildRecipeDomainMap / buildToolDomainIndex（工具→域反推）', () => {
  it('recipe → 域：domain.json recipes 反查', () => {
    const map = buildRecipeDomainMap(MANIFESTS);
    expect(map.get('pwn')).toEqual(['binary']);
    expect(map.get('pentest')).toEqual(['pentest']);
    expect(map.get('dev')).toBeUndefined();
  });

  it('tool → 域：只收独占证据（同域多配方声明仍算；跨域共用不入表）', () => {
    const index = buildToolDomainIndex(RECIPES, MANIFESTS);
    expect(index.get('gdb')).toEqual(['binary']); // pwn/fuzz 都属 binary → 仍算 binary 的独占证据
    expect(index.get('nmap')).toEqual(['pentest']);
    expect(index.get('opengrep')).toEqual(['whitebox']);
    // invalid 配方与无域配方的工具不进表
    expect(index.get('ghost-tool')).toBeUndefined();
    expect(index.get('clang')).toBeUndefined();
  });

  it('1.9.3：跨域共用工具不构成任何域的证据（python3 被 binary 与 pentest 共同声明）', () => {
    // 「这台机器装了 python3」只能说明它是个 Linux 环境，不能说明它有渗透能力——
    // 共用工具进表会让任何容器都被反推出三四个域，能力清单段跟着虚报工具。
    const index = buildToolDomainIndex(RECIPES, MANIFESTS);
    expect(index.get('python3')).toBeUndefined();
  });
});

describe('collectProbeSurface（探测面 = 全配方工具并集）', () => {
  it('valid 配方工具并集去重 + 字典序稳定', () => {
    const surface = collectProbeSurface(RECIPES);
    expect(surface).toEqual([...surface].sort((a, b) => a.localeCompare(b)));
    expect(surface).toContain('gdb');
    expect(surface).toContain('nmap');
    expect(surface).toContain('clang'); // 无域配方工具也在探测面
    expect(new Set(surface).size).toBe(surface.length); // 无重复
    expect(surface).not.toContain('ghost-tool'); // invalid 配方不收
  });
});

describe('parseProbePresentTools（探测输出解析）', () => {
  it('只收 OK 行；MISS 行与噪音忽略', () => {
    const stdout = 'OK:gdb\nMISS:nmap\nrandom noise\nOK:nmap-extra \nOK:pwntools\n';
    const present = parseProbePresentTools(stdout);
    expect(present).toEqual(new Set(['gdb', 'nmap-extra', 'pwntools']));
    expect(present.has('nmap')).toBe(false);
  });
});

describe('boundDomainsForEntry（配方绑定域反查）', () => {
  it('recipeId 优先', () => {
    expect(boundDomainsForEntry(ENTRY, MANIFESTS)).toEqual(['binary']);
  });

  it('回落 vmName 同名配方（老条目无 recipeId）', () => {
    const legacy: EnvironmentEntry = { id: 'pentest-box', kind: 'vm', vmName: 'pentest', createdAt: '' };
    expect(boundDomainsForEntry(legacy, MANIFESTS)).toEqual(['pentest']);
  });

  it('1.9.2：环境 id 不作配方候选——起名不换域', () => {
    // 环境 id 是系统生成（zhishi-<recipe>-<hash>）或人工自由文本，与配方名
    // 撞上纯属巧合：曾让「把环境叫 pentest」（无任何配方绑定）判成 pentest 域。
    const named: EnvironmentEntry = { id: 'pentest', kind: 'ssh', host: 'h', createdAt: '' };
    expect(boundDomainsForEntry(named, MANIFESTS)).toEqual([]);
  });

  it('无绑定 → []', () => {
    const bare: EnvironmentEntry = { id: 'random', kind: 'ssh', host: 'h', createdAt: '' };
    expect(boundDomainsForEntry(bare, MANIFESTS)).toEqual([]);
  });

  it('1.4.9：recipeIds 多配方入候选（辅配方绑定域恒在——1.3.8 漏改修复）', () => {
    const multi: EnvironmentEntry = {
      id: 'pwn-vm',
      kind: 'vm',
      recipeId: 'pwn',
      recipeIds: ['pwn', 'code-audit'],
      createdAt: '',
    };
    // pwn→binary、code-audit→whitebox 都在集合；manifests 顺序（binary 先于 whitebox）。
    expect(boundDomainsForEntry(multi, MANIFESTS)).toEqual(['binary', 'whitebox']);
  });
});

describe('boundRecipeIdsForEntry（绑定配方候选唯一口径，1.9.2）', () => {
  it('recipeId / recipeIds / vmName 三源合并去重，空值滤掉', () => {
    expect(boundRecipeIdsForEntry({ recipeId: 'pwn' })).toEqual(['pwn']);
    expect(boundRecipeIdsForEntry({ recipeIds: ['pwn', 'code-audit'], recipeId: 'pwn' })).toEqual([
      'pwn',
      'code-audit',
    ]);
    // vmName 回落（老 VM 条目无 recipeId；实例名常就是配方名）
    expect(boundRecipeIdsForEntry({ vmName: 'pwn-vm' })).toEqual(['pwn-vm']);
    expect(boundRecipeIdsForEntry({ recipeId: '', vmName: '' })).toEqual([]);
  });

  it('环境 id 不作候选——id 与配方名撞上不是绑定证据', () => {
    const named: EnvironmentEntry = { id: 'fuzz', kind: 'ssh', host: 'h', createdAt: '' };
    expect(boundRecipeIdsForEntry(named)).toEqual([]);
  });
});

describe('mergeCapabilityDomains（合并规则：绑定域在前 = 基线语义）', () => {
  it('绑定域居前，探测域按序追加，整体去重', () => {
    expect(mergeCapabilityDomains(['pentest'], ['binary', 'pentest', 'whitebox'])).toEqual([
      'pentest',
      'binary',
      'whitebox',
    ]);
  });

  it('probedDomainsForTools 按 manifests 顺序输出', () => {
    const index = buildToolDomainIndex(RECIPES, MANIFESTS);
    expect(probedDomainsForTools(new Set(['nmap', 'gdb']), index, MANIFESTS)).toEqual(['binary', 'pentest']);
  });
});

describe('1.4.9 — 集合内工具口径（capabilityScopeTools / capabilityMissingInScope）', () => {
  it('capabilityScopeTools：集合内域 → 配方 → valid 工具并集（去重排序）', () => {
    // 口径是「配方声明了什么」而不是「什么算域证据」——共用工具照样算进
    // 集合内工具（python3 由 binary 域的 pwn 声明）。
    const tools = capabilityScopeTools(['binary', 'whitebox'], RECIPES, MANIFESTS);
    expect(new Set(tools)).toEqual(
      new Set(['gdb', 'pwntools', 'ROPgadget', 'python3', 'afl-fuzz', 'opengrep', 'rg']),
    );
    expect(tools).not.toContain('clang'); // dev 配方不在集合内
    expect([...tools].sort((a, b) => a.localeCompare(b))).toEqual(tools); // 输出稳定
  });

  it('capabilityMissingInScope：toolCheck ∪ capabilityMissing 过滤到集合内；无能力集合 → undefined', () => {
    const entry = {
      capabilityDomains: ['binary'],
      capabilityMissing: ['afl-fuzz', 'opengrep'], // opengrep 属 whitebox——不在集合内，被过滤
      toolCheck: { ok: false, missing: ['pwntools'], checkedAt: 't' },
    };
    const r = capabilityMissingInScope(entry, RECIPES, MANIFESTS);
    expect(r?.total).toBe(5); // binary 集合：gdb/pwntools/ROPgadget/python3/afl-fuzz（pwn+fuzz 并集去重）
    expect(new Set(r?.missing)).toEqual(new Set(['afl-fuzz', 'pwntools']));
    expect(capabilityMissingInScope({ capabilityDomains: [] }, RECIPES, MANIFESTS)).toBeUndefined();
  });
});

describe('probeEnvironmentCapabilities（注入 exec，不真连）', () => {
  const fixedNow = () => new Date('2026-08-25T12:00:00Z');
  const okExec = (stdout: string) => () => Promise.resolve({ ok: true as const, stdout });

  it('绑定域 ∪ 探测域合并落盘；绑定域在首位', async () => {
    const r = await probeEnvironmentCapabilities(ENTRY, {
      recipes: RECIPES,
      manifests: MANIFESTS,
      exec: okExec('OK:gdb\nOK:nmap\nMISS:hydra\n'),
      now: fixedNow,
    });
    // 绑定 pwn→binary 恒在（首位）；探测 nmap→pentest 追加（nmap 是 pentest 独占证据）。
    expect(r?.capabilityDomains).toEqual(['binary', 'pentest']);
    expect(r?.capabilityDerivedAt).toBe('2026-08-25T12:00:00.000Z');
    // 1.4.9：MISS 清单 = 探测面 − 在场。
    expect(new Set(r?.capabilityMissing)).toEqual(
      new Set(['afl-fuzz', 'clang', 'hydra', 'opengrep', 'python3', 'pwntools', 'rg', 'ROPgadget']),
    );
  });

  it('1.9.3：共用工具不再把别的域拉进能力集合（pwn 容器装着一堆共用工具也只算 binary）', async () => {
    // 1.9.2 之前那台 pwn 环境的「能力（推导）」行是 binary · whitebox · ai-security ·
    // pentest：其中 whitebox 来自 sg 撞名（1.9.2 修），ai-security / pentest 来自
    // python3 / nc / socat 这类**跨域共用工具**（本版修）。修复后只剩 binary。
    const recipes = [
      recipe('pwn', ['gdb', 'python3']),
      recipe('ai-security', ['garak', 'python3']),
      recipe('pentest', ['nmap', 'python3']),
    ];
    const manifests = [
      manifest('binary', ['pwn']),
      manifest('ai-security', ['ai-security']),
      manifest('pentest', ['pentest']),
    ];
    const r = await probeEnvironmentCapabilities(ENTRY, {
      recipes,
      manifests,
      exec: okExec('OK:gdb\nOK:python3\n'),
      now: fixedNow,
    });
    // gdb → pwn → binary（独占证据）；python3 横跨三个域 → 不构成任何域的证据。
    expect(r?.capabilityDomains).toEqual(['binary']);
  });

  it('探测零缺失 → capabilityMissing 空数组（与「未探测」的 undefined 区分）', async () => {
    const allOk = collectProbeSurface(RECIPES).map((t) => `OK:${t}`).join('\n');
    const r = await probeEnvironmentCapabilities(ENTRY, {
      recipes: RECIPES,
      manifests: MANIFESTS,
      exec: okExec(allOk),
      now: fixedNow,
    });
    expect(r?.capabilityMissing).toEqual([]);
  });

  it('windows 条目 → 探测脚本走 cmd 语义（1.6.4 osFamily 分派），解析协议不变', async () => {
    let seen = '';
    const r = await probeEnvironmentCapabilities({ ...ENTRY, osFamily: 'windows' }, {
      recipes: RECIPES,
      manifests: MANIFESTS,
      exec: (_e, script) => {
        seen = script;
        return Promise.resolve({ ok: true as const, stdout: 'OK:nmap\n' });
      },
      now: fixedNow,
    });
    // cmd 语义的 where 探测；无 posix 的 PATH 前缀
    expect(seen).toContain('where nmap >NUL 2>&1 && echo OK:nmap || echo MISS:nmap');
    expect(seen).not.toContain('export PATH');
    // 解析协议两族一致：OK:nmap → pentest 域
    expect(r?.capabilityDomains).toEqual(['binary', 'pentest']);
  });

  it('通道失败 → undefined（不写能力字段，保 baseline）', async () => {
    const failExec = () => Promise.resolve({ ok: false as const, stdout: '' });
    const r = await probeEnvironmentCapabilities(ENTRY, {
      recipes: RECIPES,
      manifests: MANIFESTS,
      exec: failExec,

    });
    expect(r).toBeUndefined();
  });

  it('exec 抛错 → undefined（同上，不炸调用方）', async () => {
    const r = await probeEnvironmentCapabilities(ENTRY, {
      recipes: RECIPES,
      manifests: MANIFESTS,
      exec: () => Promise.reject(new Error('ssh gone')),
    });
    expect(r).toBeUndefined();
  });

  it('零命中且无配方绑定 → undefined（不误判空集合）', async () => {
    const noBinding: EnvironmentEntry = { id: 'bare', kind: 'ssh', host: 'h', createdAt: '' };
    const r = await probeEnvironmentCapabilities(noBinding, {
      recipes: RECIPES,
      manifests: MANIFESTS,
      exec: okExec('MISS:gdb\nMISS:nmap\n'),
    });
    expect(r).toBeUndefined();
  });

  it('零命中但有配方绑定 → 绑定域恒在集合（不需要探测证据）', async () => {
    const r = await probeEnvironmentCapabilities(ENTRY, {
      recipes: RECIPES,
      manifests: MANIFESTS,
      exec: okExec('MISS:gdb\nMISS:nmap\n'),
      now: fixedNow,
    });
    expect(r?.capabilityDomains).toEqual(['binary']);
  });

  it('探测面为空（无 valid 配方工具）时跳过 exec，绑定域仍落盘', async () => {
    let called = 0;
    const r = await probeEnvironmentCapabilities(ENTRY, {
      recipes: [],
      manifests: MANIFESTS,
      exec: () => {
        called += 1;
        return Promise.resolve({ ok: true as const, stdout: '' });
      },
      now: fixedNow,
    });
    expect(called).toBe(0);
    expect(r?.capabilityDomains).toEqual(['binary']);
  });
});

describe('1.5.7 — capabilityPending（已登记待装：firstRunTools 声明、探测未命中）', () => {
  const fixedNow = () => new Date('2026-08-25T12:00:00Z');
  const okExec = (stdout: string) => () => Promise.resolve({ ok: true as const, stdout });
  // code-audit 声明首跑安装 joern（构建期装不下，容器首跑钩子后台装）。
  const FIRST_RUN_RECIPES = [...RECIPES.filter((r) => r.id !== 'code-audit'), recipe('code-audit', ['opengrep', 'rg'], true, ['joern'])];

  it('firstRunTools 并入探测面与工具→域反推表（装完后探测命中才算闭环）', () => {
    expect(collectProbeSurface(FIRST_RUN_RECIPES)).toContain('joern');
    expect(buildToolDomainIndex(FIRST_RUN_RECIPES, MANIFESTS).get('joern')).toEqual(['whitebox']);
  });

  it('missing 归并减去 pending：待装工具不进 capabilityMissing 双计数，且随探测返回新 pending', async () => {
    const entry: EnvironmentEntry = {
      ...ENTRY,
      recipeId: 'code-audit',
      capabilityPending: ['joern'],
    };
    const r = await probeEnvironmentCapabilities(entry, {
      recipes: FIRST_RUN_RECIPES,
      manifests: MANIFESTS,
      exec: okExec('OK:opengrep\nOK:rg\nMISS:joern\n'),
      now: fixedNow,
    });
    // joern 在探测面且 MISS，但已登记 pending → 不进 missing。
    expect(r?.capabilityMissing).not.toContain('joern');
    expect(r?.capabilityMissing).toContain('gdb'); // 普通缺失照报
    // 仍未装完 → pending 保留。
    expect(r?.capabilityPending).toEqual(['joern']);
  });

  it('摘除闭环：探测命中 pending 工具（首跑装完）→ 从 pending 摘除，空则返回空数组（调用方删字段）', async () => {
    const entry: EnvironmentEntry = {
      ...ENTRY,
      recipeId: 'code-audit',
      capabilityPending: ['joern'],
    };
    const r = await probeEnvironmentCapabilities(entry, {
      recipes: FIRST_RUN_RECIPES,
      manifests: MANIFESTS,
      exec: okExec('OK:opengrep\nOK:rg\nOK:joern\n'),
      now: fixedNow,
    });
    expect(r?.capabilityPending).toEqual([]); // 全部装完 → 空数组（删字段信号）
    // 装完的 joern 贡献域证据（whitebox 已由绑定域覆盖，不重复）。
    expect(r?.capabilityDomains).toEqual(['whitebox']);
  });

  it('capabilityMissingInScope 同样减去 pending（读侧口径与写侧一致）', () => {
    const r = capabilityMissingInScope(
      {
        capabilityDomains: ['whitebox'],
        capabilityMissing: ['joern', 'opengrep'], // 旧数据可能已把 pending 写进 missing
        capabilityPending: ['joern'],
      },
      FIRST_RUN_RECIPES,
      MANIFESTS,
    );
    expect(r?.missing).toEqual(['opengrep']);
  });

  it('通道失败 → undefined：pending 与能力字段都不动（与既有纪律一致）', async () => {
    const entry: EnvironmentEntry = { ...ENTRY, capabilityPending: ['joern'] };
    const r = await probeEnvironmentCapabilities(entry, {
      recipes: FIRST_RUN_RECIPES,
      manifests: MANIFESTS,
      exec: () => Promise.resolve({ ok: false as const, stdout: '' }),
    });
    expect(r).toBeUndefined();
  });
});


describe('1.7.8 — 本机工具链探测面（kind=local）', () => {
  const LOCAL_ENTRY: EnvironmentEntry = {
    id: 'local',
    kind: 'local',
    osFamily: 'windows',
    createdAt: '',
  };

  it('LOCAL_TOOLCHAIN_PROBE 覆盖 design §3 探测面八项', () => {
    expect(LOCAL_TOOLCHAIN_PROBE.map((t) => t.key)).toEqual([
      'msvc', 'clang', 'cdb', 'windbg', 'python', 'git', 'wsl', 'sympath',
    ]);
  });

  it('buildLocalToolchainProbeScript：cmd 语义 + OK:/MISS: 协议行（vswhere/WSL/符号路径可见）', () => {
    const script = buildLocalToolchainProbeScript();
    expect(script).toContain('vswhere.exe');
    expect(script).toContain('OK:msvc || echo MISS:msvc');
    expect(script).toContain('wsl.exe --status');
    expect(script).toContain('OK:wsl || echo MISS:wsl');
    expect(script).toContain('_NT_SYMBOL_PATH');
    expect(script).toContain('OK:sympath || echo MISS:sympath');
    // cmd 语句分隔符（与 buildToolCheckScript windows 分支同构）。
    expect(script.split(' & ')).toHaveLength(LOCAL_TOOLCHAIN_PROBE.length);
  });

  it('parseLocalToolchainProbe：OK/MISS 行 → 在场/缺失清单（声明序）', () => {
    const stdout = 'OK:msvc\r\nMISS:clang\r\nOK:cdb\r\nMISS:windbg\r\nOK:python\r\nMISS:git\r\nOK:wsl\r\nMISS:sympath\n';
    expect(parseLocalToolchainProbe(stdout)).toEqual({
      present: ['msvc', 'cdb', 'python', 'wsl'],
      missing: ['clang', 'windbg', 'git', 'sympath'],
    });
    // 空输出全 MISS；噪音行不误判。
    expect(parseLocalToolchainProbe('').missing).toHaveLength(LOCAL_TOOLCHAIN_PROBE.length);
    expect(parseLocalToolchainProbe('OK:msvc-extra\n')).toMatchObject({ present: [] });
  });

  it('probeEnvironmentCapabilities:local → 一条合并探测脚本（配方面 & 工具链面），产出 localToolchain', async () => {
    let seenScript = '';
    const r = await probeEnvironmentCapabilities(LOCAL_ENTRY, {
      recipes: RECIPES,
      manifests: MANIFESTS,
      exec: async (_e, script) => {
        seenScript = script;
        return {
          ok: true as const,
          stdout: 'OK:msvc\r\nMISS:clang\r\nOK:cdb\r\nMISS:windbg\r\nOK:python\r\nOK:git\r\nMISS:wsl\r\nMISS:sympath\n',
        };
      },
    });
    // 脚本 = 配方工具面（windows where 协议）& 工具链面，一次 exec。
    expect(seenScript).toContain('where gdb');
    expect(seenScript).toContain('OK:msvc');
    expect(seenScript).toContain(' & ');
    expect(r).toBeTruthy();
    expect(r!.localToolchain).toEqual({
      present: ['msvc', 'cdb', 'python', 'git'],
      missing: ['clang', 'windbg', 'wsl', 'sympath'],
    });
    // 裸宿主无配方命中：域集合可为空，但结果必须有（不误判 undefined）。
    expect(r!.capabilityDomains).toEqual([]);
  });

  it('probeEnvironmentCapabilities:local → 配方工具命中照常贡献域（工具链是追加面）', async () => {
    const r = await probeEnvironmentCapabilities(LOCAL_ENTRY, {
      recipes: RECIPES,
      manifests: MANIFESTS,
      exec: async () => ({
        ok: true as const,
        stdout: 'OK:gdb\r\nOK:msvc\r\nMISS:clang\r\nOK:cdb\r\nMISS:windbg\r\nOK:python\r\nOK:git\r\nOK:wsl\r\nMISS:sympath\n',
      }),
    });
    expect(r!.capabilityDomains).toEqual(['binary']); // gdb → pwn/fuzz 域
    expect(r!.localToolchain!.present).toContain('msvc');
  });

  it('probeEnvironmentCapabilities:非 local 条目 → 不跑工具链面（localToolchain undefined）', async () => {
    let seenScript = '';
    const r = await probeEnvironmentCapabilities(ENTRY, {
      recipes: RECIPES,
      manifests: MANIFESTS,
      exec: async (_e, script) => {
        seenScript = script;
        return { ok: true as const, stdout: 'OK:gdb\n' };
      },
    });
    expect(seenScript).not.toContain('vswhere');
    expect(r!.localToolchain).toBeUndefined();
  });

  it('probeEnvironmentCapabilities:local 通道失败 → undefined（旧纪律：不写能力字段）', async () => {
    const r = await probeEnvironmentCapabilities(LOCAL_ENTRY, {
      recipes: RECIPES,
      manifests: MANIFESTS,
      exec: () => Promise.resolve({ ok: false as const, stdout: '' }),
    });
    expect(r).toBeUndefined();
  });
});
