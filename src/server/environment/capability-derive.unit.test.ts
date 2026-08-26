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
  buildRecipeDomainMap,
  buildToolDomainIndex,
  collectProbeSurface,
  mergeCapabilityDomains,
  parseProbePresentTools,
  probeEnvironmentCapabilities,
  probedDomainsForTools,
} from './capability-derive';

// ===== Fixtures =====

function recipe(id: string, tools: string[], valid = true): EnvironmentRecipe {
  return {
    id,
    dir: `/recipes/${id}`,
    name: id,
    base: 'docker',
    tools,
    valid,
    invalidReasons: valid ? [] : ['缺少 SKILL.md（配方定义文件）'],
  };
}

function manifest(kind: string, recipes: string[]): DomainManifest {
  return { kind, name: kind, recipes, skills: [], subagents: [], signals: [], acceptance: [] };
}

const RECIPES = [
  recipe('pwn', ['gdb', 'pwntools', 'ROPgadget']),
  recipe('fuzz', ['afl-fuzz', 'gdb']),
  recipe('pentest', ['nmap', 'hydra']),
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

  it('tool → 域：经配方反查；跨配方共享工具落多个域', () => {
    const index = buildToolDomainIndex(RECIPES, MANIFESTS);
    expect(index.get('gdb')).toEqual(['binary']); // pwn/fuzz 都属 binary，去重
    expect(index.get('nmap')).toEqual(['pentest']);
    expect(index.get('opengrep')).toEqual(['whitebox']);
    // invalid 配方与无域配方的工具不进表
    expect(index.get('ghost-tool')).toBeUndefined();
    expect(index.get('clang')).toBeUndefined();
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

  it('回落 id/vmName 同名配方（老条目无 recipeId）', () => {
    const legacy: EnvironmentEntry = { id: 'pentest-box', kind: 'vm', vmName: 'pentest', createdAt: '' };
    expect(boundDomainsForEntry(legacy, MANIFESTS)).toEqual(['pentest']);
  });

  it('无绑定 → []', () => {
    const bare: EnvironmentEntry = { id: 'random', kind: 'ssh', host: 'h', createdAt: '' };
    expect(boundDomainsForEntry(bare, MANIFESTS)).toEqual([]);
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
    // 绑定 pwn→binary 恒在（首位）；探测 nmap→pentest 追加。
    expect(r).toEqual({ capabilityDomains: ['binary', 'pentest'], capabilityDerivedAt: '2026-08-25T12:00:00.000Z' });
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
