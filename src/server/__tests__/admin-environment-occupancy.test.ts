/**
 * 1.8.7 P5 团队大脑——环境占用的 admin 接线测试。
 *
 * 配置注入照 admin 测试惯例（临时 HOME + ~/.zhishi/config.json 播种）；
 * 引擎通道全假：exec 走 __setEnvExecForTests、docker down 走
 * __setEnvDownForTests、ps 走 __setPsSourcesForTests、hyperv/vbox 存在性
 * 探测走 vi.mock（绝不真连 docker/powershell/VBoxManage）；boundary ask
 * 走真 pending 表 + respondBoundaryAsk 拒绝（不触发真实 scp）。
 *
 * 覆盖：exec 占用登记/释放 + 冲突 warning（他人占用才警）+ 不踩 turn 线
 * 占用；down 的 loud warning + 成功摘占用；list/ps 占用投影（additive）；
 * extract 的 boundary-ask objects 附占用信息；无占用时零键（本地单用户
 * 行为一字节不变）。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../environment/hyperv-lifecycle', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../environment/hyperv-lifecycle')>();
  return { ...orig, hypervVmExists: async () => false };
});
vi.mock('../environment/vbox-lifecycle', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../environment/vbox-lifecycle')>();
  return { ...orig, vboxVmExists: async () => false };
});

import {
  __setEnvDownForTests,
  __setEnvExecForTests,
  __setPsSourcesForTests,
  handleEnvironmentDown,
  handleEnvironmentExec,
  handleEnvironmentExtract,
  handleEnvironmentList,
  handleEnvironmentPs,
} from '../admin-api';
import {
  __resetOccupancyForTests,
  claimEnv,
  envOccupancy,
  type EnvOccupancy,
} from '../environment/occupancy';
import {
  clearBoundaryAsks,
  pendingBoundaryAsks,
  respondBoundaryAsk,
} from '../loop/boundary-ask';
import type { EnvironmentEntry } from '../../shared/config-types';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

const DOCKER_ENTRY = {
  id: 'zhishi-env-pwn-1',
  kind: 'docker',
  container: 'zhishi-env-pwn-1',
  createdAt: '',
} as EnvironmentEntry;

const SSH_ENTRY = {
  id: 'target-x',
  kind: 'ssh',
  host: '10.0.0.8',
  user: 'root',
  createdAt: '',
} as EnvironmentEntry;

function seedEntries(entries: EnvironmentEntry[]): void {
  writeFileSync(
    join(scratch, '.zhishi', 'config.json'),
    JSON.stringify({ environments: entries }),
    'utf-8',
  );
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-occ-'));
  mkdirSync(join(scratch, '.zhishi'), { recursive: true });
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
  __resetOccupancyForTests();
});

afterEach(() => {
  __setEnvExecForTests(null);
  __setEnvDownForTests(null);
  __setPsSourcesForTests(null);
  clearBoundaryAsks();
  __resetOccupancyForTests();
  rmSync(scratch, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
});

const fakeExecOk = async () => ({ ok: true as const, stdout: 'hi', stderr: '', exitCode: 0, truncated: false });

describe('environment/exec 占用', () => {
  it('exec 期间登记（无线的 exec 占用），完成即释放', async () => {
    seedEntries([DOCKER_ENTRY]);
    let during: EnvOccupancy | undefined;
    __setEnvExecForTests(async () => {
      during = envOccupancy('zhishi-env-pwn-1');
      return fakeExecOk();
    });
    const r = await handleEnvironmentExec({ id: 'zhishi-env-pwn-1', command: 'hostname' });
    expect(r.success).toBe(true);
    expect(during).toBeDefined();
    expect(during!.by).toBe('local');
    expect(during!.line).toBeUndefined();
    expect(envOccupancy('zhishi-env-pwn-1')).toBeUndefined();
    expect(r.data).not.toHaveProperty('warning');
  });

  it('他人占用 → 结果带 warning（软语义不阻断），且不踩/不摘其线占用', async () => {
    seedEntries([DOCKER_ENTRY]);
    claimEnv('zhishi-env-pwn-1', { by: 'wren', line: 'ls-wren-0001' });
    __setEnvExecForTests(fakeExecOk);
    const r = await handleEnvironmentExec({ id: 'zhishi-env-pwn-1', command: 'hostname' });
    expect(r.success).toBe(true);
    const warning = (r.data as { warning?: string }).warning;
    expect(warning).toContain('wren');
    expect(warning).toContain('zhishi-env-pwn-1');
    // exec 未登记（claimEnvIfFree 不踩），turn 的线占用原样保留。
    expect(envOccupancy('zhishi-env-pwn-1')).toEqual(
      expect.objectContaining({ by: 'wren', line: 'ls-wren-0001' }),
    );
  });

  it('同一 actor 占用 → 无 warning（本地单用户永不触发冲突）', async () => {
    seedEntries([DOCKER_ENTRY]);
    claimEnv('zhishi-env-pwn-1', { by: 'local', line: 'ls-local-001' });
    __setEnvExecForTests(fakeExecOk);
    const r = await handleEnvironmentExec({ id: 'zhishi-env-pwn-1', command: 'hostname' });
    expect(r.success).toBe(true);
    expect(r.data).not.toHaveProperty('warning');
  });
});

describe('environment/down 占用联动', () => {
  it('占用中的环境被 down：loud warning + 成功摘占用', async () => {
    seedEntries([DOCKER_ENTRY]);
    claimEnv('zhishi-env-pwn-1', { by: 'wren', line: 'ls-wren-0001' });
    __setEnvDownForTests(async () => ({ ok: true as const, stopped: 'zhishi-env-pwn-1' }));
    const r = await handleEnvironmentDown({ id: 'zhishi-env-pwn-1' });
    expect(r.success).toBe(true);
    const warning = (r.data as { warning?: string }).warning;
    expect(warning).toContain('wren');
    expect(warning).toContain('停止将中断');
    expect(envOccupancy('zhishi-env-pwn-1')).toBeUndefined();
  });

  it('无占用的 down：结果无 warning 键（与 1.8.6 行为一致）', async () => {
    seedEntries([DOCKER_ENTRY]);
    __setEnvDownForTests(async () => ({ ok: true as const, stopped: 'zhishi-env-pwn-1' }));
    const r = await handleEnvironmentDown({ id: 'zhishi-env-pwn-1' });
    expect(r.success).toBe(true);
    expect(r.data).not.toHaveProperty('warning');
  });
});

describe('list / ps 占用投影', () => {
  it('environment/list：占用条目带 occupancy（additive），无占用不加键', async () => {
    seedEntries([DOCKER_ENTRY, SSH_ENTRY]);
    claimEnv('zhishi-env-pwn-1', { by: 'wren', line: 'ls-wren-0001' });
    const r = handleEnvironmentList();
    expect(r.success).toBe(true);
    const envs = (r.data as { environments: Array<Record<string, unknown>> }).environments;
    const docker = envs.find((e) => e.id === 'zhishi-env-pwn-1')!;
    const ssh = envs.find((e) => e.id === 'target-x')!;
    expect(docker.occupancy).toEqual(expect.objectContaining({ by: 'wren', line: 'ls-wren-0001' }));
    expect(ssh).not.toHaveProperty('occupancy');
  });

  it('environment/ps：运行中实例行带 occupancy', async () => {
    seedEntries([DOCKER_ENTRY]);
    claimEnv('zhishi-env-pwn-1', { by: 'wren', line: 'ls-wren-0001' });
    __setPsSourcesForTests({
      dockerPs: () => Promise.resolve({
        ok: true as const,
        instances: [{ id: 'abc123', name: 'zhishi-env-pwn-1', image: 'img', status: 'Up', recipe: '', workspace: '' }],
      }),
      // 其余三源也置空假源——绝不真连 vmrun/Hyper-V/VBoxManage。
      vmPs: () => Promise.resolve({ ok: true as const, vmxes: [] }),
      hypervPs: () => Promise.resolve({ ok: true as const, instances: [] }),
      vboxPs: () => Promise.resolve({ ok: true as const, instances: [] }),
    });
    const r = await handleEnvironmentPs();
    expect(r.success).toBe(true);
    const rows = (r.data as { instances: Array<Record<string, unknown>> }).instances;
    const row = rows.find((x) => x.id === 'zhishi-env-pwn-1')!;
    expect(row.occupancy).toEqual(expect.objectContaining({ by: 'wren' }));
  });
});

describe('boundary-ask 占用呈现', () => {
  it('environment/extract 的 ask objects 附占用信息（审批人看得见）', async () => {
    seedEntries([SSH_ENTRY]);
    claimEnv('target-x', { by: 'wren', line: 'ls-wren-0001' });
    // 不 await——ask 会 pending 到人答；先断言再问拒绝（不触发真实 scp）。
    const pending = handleEnvironmentExtract({ id: 'target-x', guestPath: '/work/out.bin', workspace: scratch });
    await vi.waitFor(() => {
      expect(pendingBoundaryAsks().length).toBe(1);
    }, { timeout: 3000, interval: 10 });
    const ask = pendingBoundaryAsks()[0]!;
    expect(ask.objects.some((o) => o.includes('占用') && o.includes('wren'))).toBe(true);
    respondBoundaryAsk(ask.askId, false, 'reviewer-x');
    const r = await pending;
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('拒绝');
  });

  it('无占用时 ask objects 无占用行（与 1.8.6 形状一致）', async () => {
    seedEntries([SSH_ENTRY]);
    const pending = handleEnvironmentExtract({ id: 'target-x', guestPath: '/work/out.bin', workspace: scratch });
    await vi.waitFor(() => {
      expect(pendingBoundaryAsks().length).toBe(1);
    }, { timeout: 3000, interval: 10 });
    const ask = pendingBoundaryAsks()[0]!;
    expect(ask.objects).toHaveLength(2);
    respondBoundaryAsk(ask.askId, false);
    await pending;
  });
});
