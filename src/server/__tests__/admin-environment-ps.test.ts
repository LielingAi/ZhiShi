/**
 * 1.3.8 — environment/ps 与 environment/discover 的接线测试（B1/B3/B5/B7/B12）。
 *
 * 配置注入照 admin 测试惯例（临时 HOME + ~/.zhishi/config.json 播种）；
 * 四源采集走 __setPsSourcesForTests / __setDiscoverSourcesForTests 假源，
 * TCP 存活探测走 __setPsTcpProbeForTests 假通道——绝不真连 docker/vmrun/
 * Hyper-V/VirtualBox，也绝不真连 TCP。
 *
 * 覆盖：
 *  - B1：docker ps 行的短容器 id 按容器名 ∩ 登记条目归一为条目 id
 *        （未登记容器保持短 id 原样）；
 *  - B3：ssh 条目探测用 host 字段 + 条目 port（不再 e.address:22）；
 *  - B7：同 id 多源行去重（引擎行 + 手动探测行只出一行）；
 *  - B12：environment/down 对 ssh 条目明确报错（不落 docker 兜底）；
 *  - B5：discover 的 hyperv/vbox 走全量枚举（非 zhishi-* / 停止态也列出）。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __setDiscoverSourcesForTests,
  __setPsSourcesForTests,
  __setPsTcpProbeForTests,
  handleEnvironmentDiscover,
  handleEnvironmentDown,
  handleEnvironmentEngines,
  handleEnvironmentPs,
} from '../admin-api';
import type { EnvironmentEntry } from '../../shared/config-types';

// C3(1.3.10):handleEnvironmentEngines 失败路径注入——detect 走假通道,可抛错。
const detectEnginesMock = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock('../environment/engine-detect-cache', () => ({
  detectEnvironmentEnginesCached: (...args: unknown[]) => detectEnginesMock(...args),
}));

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

function seedEntries(entries: EnvironmentEntry[]): void {
  writeFileSync(
    join(scratch, '.zhishi', 'config.json'),
    JSON.stringify({ environments: entries }),
    'utf-8',
  );
}

interface PsRow {
  id: string;
  name?: string;
  driver?: string;
  status?: string;
  address?: string;
  vmx?: string;
}

async function psRows(): Promise<PsRow[]> {
  const r = await handleEnvironmentPs();
  expect(r.success).toBe(true);
  return (r.data as { instances: PsRow[] }).instances;
}

/** 四源全假（缺省侧返回空成功），防任何真引擎调用漏进测试。 */
function fakePsSources(overrides: {
  docker?: Array<{ id: string; name: string; image: string; status: string; recipe: string; workspace: string }>;
  hyperv?: Array<{ id: string; name: string; dir: string; status: string; recipe: string; workspace: string }>;
  vbox?: Array<{ id: string; name: string; status: string; recipe: string; workspace: string }>;
  vmxes?: string[];
}): void {
  __setPsSourcesForTests({
    dockerPs: () => Promise.resolve({ ok: true as const, instances: overrides.docker ?? [] }),
    vmPs: () => Promise.resolve({ ok: true as const, vmxes: overrides.vmxes ?? [] }),
    hypervPs: () => Promise.resolve({ ok: true as const, instances: overrides.hyperv ?? [] }),
    vboxPs: () => Promise.resolve({ ok: true as const, instances: overrides.vbox ?? [] }),
  });
}

const DOCKER_ENTRY: EnvironmentEntry = {
  id: 'zhishi-pwn-a3f2',
  kind: 'docker',
  container: 'zhishi-pwn-a3f2',
  recipeId: 'pwn',
  createdAt: '2026-08-25T00:00:00Z',
};

const SSH_ENTRY: EnvironmentEntry = {
  id: 'hop',
  kind: 'ssh',
  host: '10.10.0.5',
  port: 2222,
  user: 'root',
  createdAt: '2026-08-25T00:00:00Z',
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-env-ps-'));
  mkdirSync(join(scratch, '.zhishi'), { recursive: true });
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
  __setPsTcpProbeForTests(() => Promise.resolve(false));
  detectEnginesMock.mockReset();
  detectEnginesMock.mockResolvedValue({});
});

afterEach(() => {
  __setPsSourcesForTests(null);
  __setDiscoverSourcesForTests(null);
  __setPsTcpProbeForTests(null);
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

describe('handleEnvironmentPs — B1 docker 行 id 归一', () => {
  it('登记条目的容器行：id 归一为条目 id（容器名），不再是孤儿短 id', async () => {
    seedEntries([DOCKER_ENTRY]);
    fakePsSources({
      docker: [
        {
          id: 'a3f2b1c4d5e6',
          name: 'zhishi-pwn-a3f2',
          image: 'zhishi-env-pwn',
          status: 'Up 2 hours',
          recipe: 'pwn',
          workspace: '/work',
        },
      ],
    });
    const rows = await psRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('zhishi-pwn-a3f2');
    expect(rows[0].name).toBe('zhishi-pwn-a3f2');
    expect(rows[0].driver).toBe('docker');
  });

  it('未登记容器行：保持短 id 原样（不归一、不丢）', async () => {
    seedEntries([]);
    fakePsSources({
      docker: [
        {
          id: 'deadbeef1234',
          name: 'zhishi-fuzz-99887766',
          image: 'zhishi-env-fuzz',
          status: 'Up 1 hour',
          recipe: 'fuzz',
          workspace: '/w',
        },
      ],
    });
    const rows = await psRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('deadbeef1234');
  });
});

describe('handleEnvironmentPs — B3 ssh 条目探测', () => {
  it('探测目标是条目 host + 条目 port（不是 e.address:22）', async () => {
    seedEntries([SSH_ENTRY]);
    fakePsSources({});
    const probed: Array<{ host: string; port: number }> = [];
    __setPsTcpProbeForTests((host, port) => {
      probed.push({ host, port });
      return Promise.resolve(true);
    });
    const rows = await psRows();
    expect(probed).toEqual([{ host: '10.10.0.5', port: 2222 }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'hop', driver: 'ssh', status: 'running' });
  });

  it('无 port 字段缺省 22；host 缺失回落 address', async () => {
    seedEntries([
      { id: 'default-port', kind: 'ssh', host: '10.0.0.1', user: 'root', createdAt: '2026-08-25T00:00:00Z' },
      { id: 'addr-only', kind: 'ssh', address: '10.0.0.2', user: 'root', createdAt: '2026-08-25T00:00:00Z' },
    ]);
    fakePsSources({});
    const probed: Array<{ host: string; port: number }> = [];
    __setPsTcpProbeForTests((host, port) => {
      probed.push({ host, port });
      return Promise.resolve(true);
    });
    const rows = await psRows();
    expect(probed).toContainEqual({ host: '10.0.0.1', port: 22 });
    expect(probed).toContainEqual({ host: '10.0.0.2', port: 22 });
    expect(rows.map((r) => r.id).sort()).toEqual(['addr-only', 'default-port']);
  });

  it('探测失败 → ssh 条目不进行（落「已停止」分组由 GUI 侧判定）', async () => {
    seedEntries([SSH_ENTRY]);
    fakePsSources({});
    __setPsTcpProbeForTests(() => Promise.resolve(false));
    const rows = await psRows();
    expect(rows).toHaveLength(0);
  });
});

describe('handleEnvironmentPs — B7 同 id 多源去重', () => {
  it('hyperv 引擎行 + 手动探测行同 id → 只出一行（引擎行优先）', async () => {
    const entry: EnvironmentEntry = {
      id: 'zhishi-pwn-a1b2',
      kind: 'vm',
      vmName: 'zhishi-pwn-a1b2',
      address: '10.0.0.9',
      createdAt: '2026-08-25T00:00:00Z',
    };
    seedEntries([entry]);
    fakePsSources({
      hyperv: [
        {
          id: 'zhishi-pwn-a1b2',
          name: 'zhishi-pwn-a1b2',
          dir: '/x/zhishi-pwn-a1b2',
          status: 'running',
          recipe: 'pwn',
          workspace: '',
        },
      ],
    });
    __setPsTcpProbeForTests(() => Promise.resolve(true)); // 手动探测也命中
    const rows = await psRows();
    expect(rows.filter((r) => r.id === 'zhishi-pwn-a1b2')).toHaveLength(1);
    expect(rows[0].driver).toBe('hyperv');
  });
});

describe('handleEnvironmentDown — B12 ssh 条目明确报错', () => {
  it('ssh 条目 → 「无实体可停」错误，不落 docker 兜底', async () => {
    seedEntries([SSH_ENTRY]);
    const r = await handleEnvironmentDown({ id: 'hop' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('无实体可停');
    expect(r.error).toContain('ssh');
  });
});

describe('handleEnvironmentDiscover — B5 全量枚举', () => {
  it('hyperv/vbox 全量（非 zhishi-* / 停止态也列出），vmware 仅运行中', async () => {
    seedEntries([]);
    __setDiscoverSourcesForTests({
      dockerPsAll: () =>
        Promise.resolve({
          ok: true as const,
          instances: [{ id: 'c1', name: 'user-mysql', image: 'mysql', status: 'Exited', managed: false }],
        }),
      vmPs: () => Promise.resolve({ ok: true as const, vmxes: ['D:\\vms\\kali.vmx'] }),
      hypervPsAll: () =>
        Promise.resolve({
          ok: true as const,
          instances: [
            { id: 'zhishi-pwn-a1b2', name: 'zhishi-pwn-a1b2', dir: '/x/zhishi-pwn-a1b2', status: 'running', recipe: 'pwn', workspace: '' },
            { id: 'user-win11', name: 'user-win11', dir: '', status: 'off', recipe: '', workspace: '' },
          ],
        }),
      vboxPsAll: () =>
        Promise.resolve({
          ok: true as const,
          instances: [{ id: 'user-kali', name: 'user-kali', status: 'unknown', recipe: '', workspace: '' }],
        }),
    });
    const r = await handleEnvironmentDiscover();
    expect(r.success).toBe(true);
    const data = r.data as { docker: Array<{ name: string }>; vm: Array<{ driver: string; name: string; state: string }> };
    expect(data.docker.map((d) => d.name)).toEqual(['user-mysql']);
    const vmNames = data.vm.map((v) => `${v.driver}:${v.name}`);
    expect(vmNames).toContain('hyperv:zhishi-pwn-a1b2');
    expect(vmNames).toContain('hyperv:user-win11'); // 全量：非 zhishi-* 也列出
    expect(vmNames).toContain('vbox:user-kali');
    expect(data.vm.find((v) => v.name === 'user-win11')?.state).toBe('off'); // 停止态保留
  });

  it('单侧引擎失败 → 该侧空数组降级，不拖垮其它侧', async () => {
    seedEntries([]);
    __setDiscoverSourcesForTests({
      dockerPsAll: () => Promise.resolve({ ok: false as const, error: 'docker 不可用' }),
      vmPs: () => Promise.resolve({ ok: false as const, error: 'vmrun 不可用' }),
      hypervPsAll: () => Promise.resolve({ ok: false as const, error: 'Hyper-V 不可用' }),
      vboxPsAll: () =>
        Promise.resolve({
          ok: true as const,
          instances: [{ id: 'user-kali', name: 'user-kali', status: 'unknown', recipe: '', workspace: '' }],
        }),
    });
    const r = await handleEnvironmentDiscover();
    expect(r.success).toBe(true);
    const data = r.data as { docker: unknown[]; vm: Array<{ driver: string; name: string }> };
    expect(data.docker).toEqual([]);
    expect(data.vm).toEqual([{ driver: 'vbox', id: 'user-kali', name: 'user-kali', state: 'unknown' }]);
  });
});

describe('C3(1.3.10) — 失败路径补 recoveryHint', () => {
  it('handleEnvironmentPs 全源失败 → error + recoveryHint(zhishi env engines)', async () => {
    seedEntries([]);
    __setPsSourcesForTests({
      dockerPs: () => Promise.resolve({ ok: false as const, error: 'docker 不可用' }),
      vmPs: () => Promise.resolve({ ok: false as const, error: 'vmrun 不可用' }),
      hypervPs: () => Promise.resolve({ ok: false as const, error: 'Hyper-V 不可用' }),
      vboxPs: () => Promise.resolve({ ok: false as const, error: 'VirtualBox 不可用' }),
    });
    const r = await handleEnvironmentPs();
    expect(r.success).toBe(false);
    expect(r.error).toContain('docker 不可用');
    expect(r.recoveryHint).toEqual({
      recoveryCommand: 'zhishi env engines',
      message: 'See which engines are available.',
    });
  });

  it('handleEnvironmentEngines 探测抛错 → error + recoveryHint(--fresh 重探)', async () => {
    detectEnginesMock.mockRejectedValue(new Error('probe boom'));
    const r = await handleEnvironmentEngines({});
    expect(r.success).toBe(false);
    expect(r.error).toContain('probe boom');
    expect(r.recoveryHint).toEqual({
      recoveryCommand: 'zhishi env engines --fresh',
      message: 'Bypass the 30s detect cache and re-probe.',
    });
  });
});

describe('handleEnvironmentPs — 1.3.10 #3 vmware 匹配走 resolveVmxForEntry', () => {
  it('无 vmx 字段、vmName 经 vmTemplates 解析出 vmx 的条目 → 运行中命中（含解析出的 vmx）', async () => {
    const entry: EnvironmentEntry = {
      id: 'fuzz',
      kind: 'vm',
      vmName: 'fuzz',
      recipeId: 'pwn-vm',
      createdAt: '2026-08-25T00:00:00Z',
    };
    writeFileSync(
      join(scratch, '.zhishi', 'config.json'),
      JSON.stringify({
        environments: [entry],
        vmTemplates: { 'pwn-vm': { vmx: 'd:\\vmiso\\ubuntu\\fuzz.vmx' } },
      }),
      'utf-8',
    );
    fakePsSources({ vmxes: ['d:\\vmiso\\ubuntu\\fuzz.vmx'] });
    const rows = await psRows();
    expect(rows.find((r) => r.id === 'fuzz')).toMatchObject({
      id: 'fuzz',
      driver: 'vm',
      status: 'running',
      vmx: 'd:\\vmiso\\ubuntu\\fuzz.vmx',
    });
  });

  it('vmName 解析不到 vmx（vmTemplates 无命中）→ 不算运行中（旧实现同样不列，语义不回归）', async () => {
    seedEntries([{ id: 'ghost', kind: 'vm', vmName: 'ghost', createdAt: 'x' } as EnvironmentEntry]);
    fakePsSources({ vmxes: ['d:\\vmiso\\ubuntu\\other.vmx'] });
    const rows = await psRows();
    expect(rows.find((r) => r.id === 'ghost')).toBeUndefined();
  });

  it('条目自带 vmx 且 vmrun 运行中 → 照旧命中（resolveVmxForEntry 的 vmx 优先序）', async () => {
    const entry: EnvironmentEntry = {
      id: 'kali',
      kind: 'vm',
      vmName: 'kali',
      vmx: 'C:\\VMs\\kali\\kali.vmx',
      createdAt: '2026-08-25T00:00:00Z',
    };
    seedEntries([entry]);
    fakePsSources({ vmxes: ['c:/vms/kali/kali.vmx'] }); // 大小写/斜杠漂移也归一命中
    const rows = await psRows();
    expect(rows.find((r) => r.id === 'kali')?.status).toBe('running');
  });
});
