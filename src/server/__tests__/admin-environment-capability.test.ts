/**
 * 1.3.7 场景 3 — 能力集合推导的 admin 接线测试（注入 exec，绝不真连环境）。
 *
 * 覆盖：
 *  - runEnvProbeWithCapabilities：一条批量探测两吃（toolCheck 漂移证据 +
 *    capabilityDomains 能力集合）；通道失败 → {}（不写能力字段）。
 *  - handleEnvironmentAdd：ssh 条目登记前顺手探测，成功落 capabilityDomains；
 *    探测失败静默，不阻塞登记（保 baseline 行为）。
 *  - handleEnvironmentCapabilityRefresh：重推 + 回写；通道失败 → success:false
 *    且旧能力字段不动。
 *
 * 域反查走真实 bundled-domains 清单（仓库内），配方在临时 HOME 的
 * ~/.zhishi/environments/ 下播种（scanRecipes 根目录随 HOME 走）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __setCapabilityExecForTests,
  handleEnvironmentAdd,
  handleEnvironmentCapabilityRefresh,
  runEnvProbeWithCapabilities,
} from '../admin-api';
import { probeEnvironmentCapabilities } from '../environment/capability-derive';
import { loadDomainManifests } from '../domains/manifest';
import { defaultRecipesRoot, scanRecipes } from '../environment/recipes';
import type { EnvironmentEntry } from '../../shared/config-types';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

function seedRecipe(id: string, tools: string[], firstRunTools?: string[]): void {
  const dir = join(scratch, '.zhishi', 'environments', id);
  mkdirSync(dir, { recursive: true });
  const firstRun = firstRunTools?.length
    ? `firstRunTools:\n${firstRunTools.map((t) => `  - ${t}\n`).join('')}`
    : '';
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${id}\nbase: docker\ntools:\n${tools.map((t) => `  - ${t}\n`).join('')}${firstRun}---\n\n# ${id}\n`,
    'utf-8',
  );
  writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n', 'utf-8');
}

function readConfig(): { environments?: EnvironmentEntry[] } {
  return JSON.parse(readFileSync(join(scratch, '.zhishi', 'config.json'), 'utf-8')) as {
    environments?: EnvironmentEntry[];
  };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-capability-'));
  mkdirSync(join(scratch, '.zhishi'), { recursive: true });
  writeFileSync(join(scratch, '.zhishi', 'config.json'), JSON.stringify({ environments: [] }), 'utf-8');
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
  seedRecipe('pwn', ['gdb', 'pwntools']);
  seedRecipe('pentest', ['nmap', 'hydra']);
});

afterEach(() => {
  __setCapabilityExecForTests(null);
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

const PWN_ENTRY: EnvironmentEntry = {
  id: 'zhishi-pwn-a3f2',
  kind: 'docker',
  container: 'zhishi-pwn-a3f2',
  recipeId: 'pwn',
  createdAt: '',
};

describe('runEnvProbeWithCapabilities（up 接线的探测全集，注入 exec）', () => {
  it('一条探测两吃：toolCheck 漂移证据 + 能力集合（绑定域 ∪ 探测域）', async () => {
    __setCapabilityExecForTests(() =>
      Promise.resolve({ ok: true, stdout: 'OK:gdb\nOK:pwntools\nOK:nmap\nMISS:hydra\n' }),
    );
    const r = await runEnvProbeWithCapabilities(PWN_ENTRY, ['gdb', 'pwntools']);
    // 声明工具全在场 → toolCheck ok
    expect(r.toolCheck?.ok).toBe(true);
    // 绑定 pwn→binary 恒在（首位）；探测 nmap→pentest 追加。
    expect(r.capabilityDomains).toEqual(['binary', 'pentest']);
    expect(r.capabilityDerivedAt).toBeTruthy();
  });

  it('声明工具缺失 → toolCheck 漂移照报；能力集合不受影响', async () => {
    __setCapabilityExecForTests(() =>
      Promise.resolve({ ok: true, stdout: 'OK:gdb\nMISS:pwntools\nMISS:nmap\nMISS:hydra\n' }),
    );
    const r = await runEnvProbeWithCapabilities(PWN_ENTRY, ['gdb', 'pwntools']);
    expect(r.toolCheck).toMatchObject({ ok: false, missing: ['pwntools'] });
    // 绑定域不需要探测证据，恒在集合。
    expect(r.capabilityDomains).toEqual(['binary']);
  });

  it('通道失败 → {}（不写能力字段也不写 toolCheck，保 baseline）', async () => {
    __setCapabilityExecForTests(() => Promise.resolve({ ok: false, stdout: '' }));
    const r = await runEnvProbeWithCapabilities(PWN_ENTRY, ['gdb', 'pwntools']);
    expect(r).toEqual({});
  });
});

describe('handleEnvironmentAdd — 登记顺手探测（失败静默不阻塞）', () => {
  it('ssh 条目可达 → capabilityDomains 随登记落盘', async () => {
    __setCapabilityExecForTests(() => Promise.resolve({ ok: true, stdout: 'OK:nmap\nOK:hydra\n' }));
    const r = await handleEnvironmentAdd({ id: 'range-1', kind: 'ssh', host: '10.10.0.5', user: 'root' });
    expect(r.success).toBe(true);
    const saved = readConfig().environments?.find((e) => e.id === 'range-1');
    expect(saved?.capabilityDomains).toEqual(['pentest']);
    expect(saved?.capabilityDerivedAt).toBeTruthy();
  });

  it('探测失败 → 登记照常成功，条目不带能力字段（不误判空集合）', async () => {
    __setCapabilityExecForTests(() => Promise.resolve({ ok: false, stdout: '' }));
    const r = await handleEnvironmentAdd({ id: 'range-2', kind: 'ssh', host: '10.10.0.6', user: 'root' });
    expect(r.success).toBe(true);
    const saved = readConfig().environments?.find((e) => e.id === 'range-2');
    expect(saved).toBeTruthy();
    expect(saved?.capabilityDomains).toBeUndefined();
    expect(saved?.capabilityDerivedAt).toBeUndefined();
  });

  it('无可达通道（vm 无 address）→ 不探测，直接登记', async () => {
    let called = 0;
    __setCapabilityExecForTests(() => {
      called += 1;
      return Promise.resolve({ ok: true, stdout: '' });
    });
    const r = await handleEnvironmentAdd({ id: 'vm-1', kind: 'vm', vmName: 'vm-1' });
    expect(r.success).toBe(true);
    expect(called).toBe(0);
  });
});

describe('handleEnvironmentCapabilityRefresh — 重推 + 回写', () => {
  async function seedEntry(entry: EnvironmentEntry): Promise<void> {
    const config = readConfig();
    writeFileSync(
      join(scratch, '.zhishi', 'config.json'),
      JSON.stringify({ ...config, environments: [entry] }),
      'utf-8',
    );
  }

  it('探测成功 → 回写 capabilityDomains/capabilityDerivedAt 并返回', async () => {
    await seedEntry({ ...PWN_ENTRY, createdAt: '2026-08-25T00:00:00Z' });
    __setCapabilityExecForTests(() => Promise.resolve({ ok: true, stdout: 'OK:gdb\nOK:nmap\n' }));
    const r = await handleEnvironmentCapabilityRefresh({ id: PWN_ENTRY.id });
    expect(r.success).toBe(true);
    expect((r.data as { capabilityDomains: string[] }).capabilityDomains).toEqual(['binary', 'pentest']);
    const saved = readConfig().environments?.find((e) => e.id === PWN_ENTRY.id);
    expect(saved?.capabilityDomains).toEqual(['binary', 'pentest']);
    expect(saved?.capabilityDerivedAt).toBeTruthy();
  });

  it('探测失败 → success:false，旧能力字段原样保留', async () => {
    await seedEntry({
      ...PWN_ENTRY,
      capabilityDomains: ['binary'],
      capabilityDerivedAt: '2026-08-24T00:00:00Z',
      createdAt: '2026-08-25T00:00:00Z',
    });
    __setCapabilityExecForTests(() => Promise.resolve({ ok: false, stdout: '' }));
    const r = await handleEnvironmentCapabilityRefresh({ id: PWN_ENTRY.id });
    expect(r.success).toBe(false);
    const saved = readConfig().environments?.find((e) => e.id === PWN_ENTRY.id);
    expect(saved?.capabilityDomains).toEqual(['binary']);
    expect(saved?.capabilityDerivedAt).toBe('2026-08-24T00:00:00Z');
  });

  it('未登记的 id → success:false + recoveryHint', async () => {
    const r = await handleEnvironmentCapabilityRefresh({ id: 'ghost' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('未找到环境');
  });
});

describe('1.3.10 #4 — 空探测面两实现对齐（绑定域恒在）', () => {
  it('空 surface 两实现都出 bound-only，且不发探测命令', async () => {
    // 清空配方 → 探测面为空。
    rmSync(join(scratch, '.zhishi', 'environments'), { recursive: true, force: true });
    let execCalled = 0;
    __setCapabilityExecForTests(() => {
      execCalled += 1;
      return Promise.resolve({ ok: true, stdout: '' });
    });

    const runProbe = await runEnvProbeWithCapabilities(PWN_ENTRY, []);
    const fromProbe = await probeEnvironmentCapabilities(PWN_ENTRY, {
      recipes: scanRecipes(defaultRecipesRoot()),
      manifests: loadDomainManifests(),
      exec: () => Promise.resolve({ ok: true, stdout: '' }),
    });

    expect(execCalled).toBe(0); // 空探测面不发探测命令
    expect(runProbe.capabilityDomains).toEqual(['binary']); // 绑定域 pwn→binary 恒在
    expect(runProbe.capabilityDerivedAt).toBeTruthy();
    expect(fromProbe).toBeDefined();
    expect(fromProbe!.capabilityDomains).toEqual(runProbe.capabilityDomains);
    expect(fromProbe!.capabilityDerivedAt).toBeTruthy();
  });

  it('无绑定域的条目空 surface → 两实现都不写能力字段（{} / undefined）', async () => {
    rmSync(join(scratch, '.zhishi', 'environments'), { recursive: true, force: true });
    const bare: EnvironmentEntry = { id: 'bare', kind: 'docker', container: 'bare', createdAt: '' };
    const runProbe = await runEnvProbeWithCapabilities(bare, []);
    expect(runProbe).toEqual({});
    const fromProbe = await probeEnvironmentCapabilities(bare, {
      recipes: scanRecipes(defaultRecipesRoot()),
      manifests: loadDomainManifests(),
      exec: () => Promise.resolve({ ok: true, stdout: '' }),
    });
    expect(fromProbe).toBeUndefined();
  });
});

describe('1.5.7 — capabilityPending（env up 落盘 / refresh 摘除闭环）', () => {
  it('env up 探测：firstRunTools 未命中 → capabilityPending 落盘，且不进 capabilityMissing 双计数', async () => {
    seedRecipe('code-audit', ['opengrep', 'rg'], ['joern']);
    const entry: EnvironmentEntry = {
      id: 'zhishi-code-audit-b1c2',
      kind: 'docker',
      container: 'zhishi-code-audit-b1c2',
      recipeId: 'code-audit',
      createdAt: '',
    };
    __setCapabilityExecForTests(() =>
      Promise.resolve({ ok: true, stdout: 'OK:opengrep\nOK:rg\nMISS:joern\nOK:gdb\n' }),
    );
    const r = await runEnvProbeWithCapabilities(entry, ['opengrep', 'rg'], ['joern']);
    expect(r.capabilityPending).toEqual(['joern']);
    expect(r.capabilityMissing).not.toContain('joern');
    expect(r.capabilityMissing).toContain('pwntools'); // 普通缺失照报
    // firstRunTools 已在场（镜像里其实装了）→ 不落 pending
    __setCapabilityExecForTests(() =>
      Promise.resolve({ ok: true, stdout: 'OK:opengrep\nOK:rg\nOK:joern\n' }),
    );
    const r2 = await runEnvProbeWithCapabilities(entry, ['opengrep', 'rg'], ['joern']);
    expect(r2.capabilityPending).toBeUndefined();
  });

  it('探测通道失败 → {}：pending 不落盘（与能力字段同一纪律）', async () => {
    __setCapabilityExecForTests(() => Promise.resolve({ ok: false, stdout: '' }));
    const r = await runEnvProbeWithCapabilities(PWN_ENTRY, ['gdb'], ['joern']);
    expect(r).toEqual({});
  });

  it('refresh：探测命中 pending 工具（首跑装完）→ 摘除，pending 空删字段', async () => {
    seedRecipe('pwn2', ['gdb'], ['joern']);
    const entry: EnvironmentEntry = {
      id: 'zhishi-pwn2-c3d4',
      kind: 'docker',
      container: 'zhishi-pwn2-c3d4',
      recipeId: 'pwn2',
      capabilityPending: ['joern'],
      createdAt: '2026-08-25T00:00:00Z',
    };
    const config = readConfig();
    writeFileSync(
      join(scratch, '.zhishi', 'config.json'),
      JSON.stringify({ ...config, environments: [entry] }),
      'utf-8',
    );
    // joern 已装完（OK）→ refresh 后 pending 字段应消失。
    __setCapabilityExecForTests(() => Promise.resolve({ ok: true, stdout: 'OK:gdb\nOK:joern\n' }));
    const r = await handleEnvironmentCapabilityRefresh({ id: entry.id });
    expect(r.success).toBe(true);
    const saved = readConfig().environments?.find((e) => e.id === entry.id);
    expect(saved?.capabilityPending).toBeUndefined();
  });

  it('refresh：pending 工具仍未装完 → pending 保留且不进 missing', async () => {
    seedRecipe('pwn3', ['gdb'], ['joern']);
    const entry: EnvironmentEntry = {
      id: 'zhishi-pwn3-d4e5',
      kind: 'docker',
      container: 'zhishi-pwn3-d4e5',
      recipeId: 'pwn3',
      capabilityPending: ['joern'],
      createdAt: '2026-08-25T00:00:00Z',
    };
    const config = readConfig();
    writeFileSync(
      join(scratch, '.zhishi', 'config.json'),
      JSON.stringify({ ...config, environments: [entry] }),
      'utf-8',
    );
    __setCapabilityExecForTests(() => Promise.resolve({ ok: true, stdout: 'OK:gdb\nMISS:joern\n' }));
    const r = await handleEnvironmentCapabilityRefresh({ id: entry.id });
    expect(r.success).toBe(true);
    const saved = readConfig().environments?.find((e) => e.id === entry.id);
    expect(saved?.capabilityPending).toEqual(['joern']);
    expect(saved?.capabilityMissing).not.toContain('joern');
  });
});
