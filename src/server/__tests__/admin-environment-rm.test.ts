/**
 * 1.3.7 补口 — environment/rm 的 ssh/docker 分支接线测试。
 *
 * 配置注入照 admin 测试惯例（临时 HOME + ~/.zhishi/config.json 播种）；
 * docker 运行探测走 __setRmDockerProbeForTests 假通道，绝不真调 docker。
 *
 * 覆盖：
 *  - ssh 条目：只摘登记（远端机器不动），探测通道不被调用；
 *  - docker 条目容器在跑 → 拒绝（照 vm「运行中拒绝」语义），登记不动；
 *  - docker 条目容器停着 → 只摘登记（容器实体归 env down，不在 rm 做）；
 *  - docker 探测失败（docker 不可用）→ 放行摘登记（探测失败视为不在跑）；
 *  - .vmx 直传拒绝（既有守卫不受新分支影响）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __setRmDockerProbeForTests,
  __setRmVmEntityOpsForTests,
  handleEnvironmentRm,
  type RmVmEntityOps,
} from '../admin-api';
import type { EnvironmentEntry } from '../../shared/config-types';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

function readEnvIds(): string[] {
  const config = JSON.parse(readFileSync(join(scratch, '.zhishi', 'config.json'), 'utf-8')) as {
    environments?: EnvironmentEntry[];
  };
  return (config.environments ?? []).map((e) => e.id);
}

function seedEntries(entries: EnvironmentEntry[]): void {
  writeFileSync(
    join(scratch, '.zhishi', 'config.json'),
    JSON.stringify({ environments: entries }),
    'utf-8',
  );
}

const SSH_ENTRY: EnvironmentEntry = {
  id: 'range-1',
  kind: 'ssh',
  host: '10.10.0.5',
  user: 'root',
  createdAt: '2026-08-25T00:00:00Z',
};

const DOCKER_ENTRY: EnvironmentEntry = {
  id: 'zhishi-pwn-a3f2',
  kind: 'docker',
  container: 'zhishi-pwn-a3f2',
  recipeId: 'pwn',
  createdAt: '2026-08-25T00:00:00Z',
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-env-rm-'));
  mkdirSync(join(scratch, '.zhishi'), { recursive: true });
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
});

afterEach(() => {
  __setRmDockerProbeForTests(null);
  __setRmVmEntityOpsForTests(null);
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

describe('handleEnvironmentRm — ssh 条目（只摘登记，远端机器不受影响）', () => {
  it('摘登记成功；docker 探测通道不被调用', async () => {
    seedEntries([SSH_ENTRY, DOCKER_ENTRY]);
    let probeCalled = 0;
    __setRmDockerProbeForTests(() => {
      probeCalled += 1;
      return Promise.resolve({ ok: true, running: true });
    });
    const r = await handleEnvironmentRm({ id: 'range-1' });
    expect(r.success).toBe(true);
    expect((r.data as { removed: string }).removed).toBe('range-1');
    expect(readEnvIds()).toEqual(['zhishi-pwn-a3f2']);
    expect(probeCalled).toBe(0);
  });
});

describe('handleEnvironmentRm — docker 条目（运行中拒绝，停着只摘登记）', () => {
  it('容器在跑 → 拒绝，引导先 env down；登记原样保留', async () => {
    seedEntries([DOCKER_ENTRY]);
    __setRmDockerProbeForTests(() => Promise.resolve({ ok: true, running: true }));
    const r = await handleEnvironmentRm({ id: DOCKER_ENTRY.id });
    expect(r.success).toBe(false);
    expect(r.error).toContain('还在运行');
    expect(r.error).toContain(`zhishi env down ${DOCKER_ENTRY.id}`);
    expect(readEnvIds()).toEqual([DOCKER_ENTRY.id]);
  });

  it('容器停着 → 摘登记成功（容器实体不归 rm 管）', async () => {
    seedEntries([SSH_ENTRY, DOCKER_ENTRY]);
    __setRmDockerProbeForTests(() => Promise.resolve({ ok: true, running: false }));
    const r = await handleEnvironmentRm({ id: DOCKER_ENTRY.id });
    expect(r.success).toBe(true);
    expect(readEnvIds()).toEqual(['range-1']);
  });

  it('探测失败（docker 不可用）→ 视为不在跑，放行摘登记', async () => {
    seedEntries([DOCKER_ENTRY]);
    __setRmDockerProbeForTests(() => Promise.resolve({ ok: false }));
    const r = await handleEnvironmentRm({ id: DOCKER_ENTRY.id });
    expect(r.success).toBe(true);
    expect(readEnvIds()).toEqual([]);
  });

  it('探测按条目 container 字段查（不是 id）', async () => {
    seedEntries([{ ...DOCKER_ENTRY, id: 'my-pwn', container: 'zhishi-pwn-a3f2' }]);
    let probed = '';
    __setRmDockerProbeForTests((container) => {
      probed = container;
      return Promise.resolve({ ok: true, running: false });
    });
    const r = await handleEnvironmentRm({ id: 'my-pwn' });
    expect(r.success).toBe(true);
    expect(probed).toBe('zhishi-pwn-a3f2');
  });
});

describe('handleEnvironmentRm — 既有守卫不受新分支影响', () => {
  it('.vmx 直传 → 拒绝（env rm 只对登记条目）', async () => {
    seedEntries([SSH_ENTRY]);
    const r = await handleEnvironmentRm({ id: 'D:\\VMs\\pwn\\pwn.vmx' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('只对登记条目生效');
  });

  it('id 以 .vmx 结尾的已登记条目 → 守卫不误伤，正常摘登记（旧发现登记流的 id 形态）', async () => {
    const LEGACY: EnvironmentEntry = {
      id: 'vmware-fuzz.vmx',
      kind: 'vm',
      vmName: 'fuzz.vmx',
      // 用不存在的 vmx 路径——宿主机上若有真实 VM 在跑，vmEnvPs 命中会导致
      // rm 按「运行中拒绝」分支返回（测试环境依赖）；不存在的路径稳定走摘登记。
      vmx: 'd:\\vmiso\\ubuntu\\zhishi-test-nonexistent.vmx',
      createdAt: '2026-08-25T00:00:00Z',
    };
    seedEntries([LEGACY]);
    // vmrun 不在测试环境 → vmEnvPs 失败（!ok）→ 跳过运行中拒绝 → 摘登记。
    const r = await handleEnvironmentRm({ id: 'vmware-fuzz.vmx' });
    expect(r.success).toBe(true);
    expect((r.data as { removed: string }).removed).toBe('vmware-fuzz.vmx');
    expect(readEnvIds()).toEqual([]);
  });
});

describe('handleEnvironmentRm — B2：已登记 hyperv/vbox 条目回落实体删除', () => {
  /** hyperv/vbox up 回写条目的形态：kind=vm、id=vmName=实例名、无 vmx。 */
  const HYPERV_ENTRY: EnvironmentEntry = {
    id: 'zhishi-pwn-vm-a1b2c3d4',
    kind: 'vm',
    vmName: 'zhishi-pwn-vm-a1b2c3d4',
    recipeId: 'pwn-vm',
    address: '10.0.0.9',
    createdAt: '2026-08-25T00:00:00Z',
  };

  function fakeVmOps(overrides: Partial<RmVmEntityOps>): RmVmEntityOps {
    return {
      hypervExists: () => Promise.resolve(false),
      hypervRm: () => Promise.resolve({ ok: false as const, error: 'unreachable' }),
      vboxExists: () => Promise.resolve(false),
      vboxRm: () => Promise.resolve({ ok: false as const, error: 'unreachable' }),
      ...overrides,
    };
  }

  it('hyperv 命中 → 实体删除成功 + 摘登记', async () => {
    seedEntries([HYPERV_ENTRY, SSH_ENTRY]);
    const calls: string[] = [];
    __setRmVmEntityOpsForTests(fakeVmOps({
      hypervExists: (name) => {
        calls.push(`hypervExists:${name}`);
        return Promise.resolve(true);
      },
      hypervRm: (name) => {
        calls.push(`hypervRm:${name}`);
        return Promise.resolve({ ok: true as const, removed: name });
      },
    }));
    const r = await handleEnvironmentRm({ id: HYPERV_ENTRY.id });
    expect(r.success).toBe(true);
    expect((r.data as { removed: string }).removed).toBe(HYPERV_ENTRY.id);
    expect(calls).toEqual([`hypervExists:${HYPERV_ENTRY.id}`, `hypervRm:${HYPERV_ENTRY.id}`]);
    expect(readEnvIds()).toEqual(['range-1']);
  });

  it('hyperv 运行中拒绝（实体删除侧自带安全闸）→ 失败，登记保留', async () => {
    seedEntries([HYPERV_ENTRY]);
    __setRmVmEntityOpsForTests(fakeVmOps({
      hypervExists: () => Promise.resolve(true),
      hypervRm: () =>
        Promise.resolve({
          ok: false as const,
          error: `实例 "${HYPERV_ENTRY.id}" 还在运行——先 zhishi env down ${HYPERV_ENTRY.id}，确认不要了再 rm`,
        }),
    }));
    const r = await handleEnvironmentRm({ id: HYPERV_ENTRY.id });
    expect(r.success).toBe(false);
    expect(r.error).toContain('还在运行');
    expect(readEnvIds()).toEqual([HYPERV_ENTRY.id]);
  });

  it('hyperv 未命中、vbox 命中 → 走 vbox 实体删除 + 摘登记', async () => {
    seedEntries([HYPERV_ENTRY]);
    const calls: string[] = [];
    __setRmVmEntityOpsForTests(fakeVmOps({
      vboxExists: (name) => {
        calls.push(`vboxExists:${name}`);
        return Promise.resolve(true);
      },
      vboxRm: (name) => {
        calls.push(`vboxRm:${name}`);
        return Promise.resolve({ ok: true as const, removed: name });
      },
    }));
    const r = await handleEnvironmentRm({ id: HYPERV_ENTRY.id });
    expect(r.success).toBe(true);
    expect(calls).toEqual([`vboxExists:${HYPERV_ENTRY.id}`, `vboxRm:${HYPERV_ENTRY.id}`]);
    expect(readEnvIds()).toEqual([]);
  });

  it('两侧都未命中（实体已被用户手工删掉）→ 只摘登记', async () => {
    seedEntries([HYPERV_ENTRY]);
    const calls: string[] = [];
    __setRmVmEntityOpsForTests(fakeVmOps({
      hypervExists: () => {
        calls.push('hypervExists');
        return Promise.resolve(false);
      },
      vboxExists: () => {
        calls.push('vboxExists');
        return Promise.resolve(false);
      },
    }));
    const r = await handleEnvironmentRm({ id: HYPERV_ENTRY.id });
    expect(r.success).toBe(true);
    expect(calls).toEqual(['hypervExists', 'vboxExists']); // 只探测，不删除
    expect(readEnvIds()).toEqual([]);
  });

  it('vmware 条目（带 vmx）不走实体删除回落——只摘登记', async () => {
    const VMWARE_ENTRY: EnvironmentEntry = {
      id: 'fuzz',
      kind: 'vm',
      vmName: 'fuzz',
      // 同上：不存在的 vmx 路径，避免宿主真实 VM 干扰测试（运行中拒绝分支）。
      vmx: 'd:\\vmiso\\ubuntu\\zhishi-test-nonexistent.vmx',
      createdAt: '2026-08-25T00:00:00Z',
    };
    seedEntries([VMWARE_ENTRY]);
    let opsCalled = 0;
    __setRmVmEntityOpsForTests(fakeVmOps({
      hypervExists: () => {
        opsCalled += 1;
        return Promise.resolve(true);
      },
      vboxExists: () => {
        opsCalled += 1;
        return Promise.resolve(true);
      },
    }));
    // vmrun 不在测试环境 → vmEnvPs !ok → 跳过运行检查 → 只摘登记。
    const r = await handleEnvironmentRm({ id: 'fuzz' });
    expect(r.success).toBe(true);
    expect(opsCalled).toBe(0); // VM 文件是用户的，绝不删
    expect(readEnvIds()).toEqual([]);
  });
});

describe('删除语义唯一（1.3.10 #2：environment/remove 死路由已删）', () => {
  it('admin-api 不再导出 handleEnvironmentRemove——摘登记/实体删除只有 rm 一条语义', async () => {
    // 死路由（弱实现、无运行中拒绝）已删；任何回潮都会让这条红灯亮起。
    const mod = (await import('../admin-api')) as unknown as Record<string, unknown>;
    expect(mod.handleEnvironmentRemove).toBeUndefined();
    // 唯一删除语义 = handleEnvironmentRm（含 ssh 只摘登记 / docker 运行中拒绝 /
    // hyperv+vbox 实体删除回落）。
    expect(typeof handleEnvironmentRm).toBe('function');
  });
});
