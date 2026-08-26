/**
 * 安全研究员版 P2 B3 — VM(VirtualBox)环境生命周期 unit tests.
 *
 * 全部通过注入的 exec 断言 VBoxManage 参数组装与输出解析，绝不真调
 * VBoxManage。覆盖：clone/start/stop/list/snapshot/guestproperty/unregister
 * 参数组装、list runningvms / snapshot list / guestproperty 各形态解析、
 * vboxEnvUp happy path 与失败分支（缺模板 / 引擎不可用 / clone 失败 /
 * restore 失败 / start 失败 / IP 轮询拿到 / 'No value set!' 重试 / 超时
 * 不算失败）、down/rm/ps 与路由探测容错。
 */
import { describe, expect, it } from 'vitest';

import type { EnvironmentRecipe } from './recipes';
import {
  buildAcpiPowerdownArgs,
  buildCloneVmArgs,
  buildGuestIpArgs,
  buildListRunningArgs,
  buildListVmsArgs,
  buildShowVmInfoArgs,
  buildSnapshotListArgs,
  buildSnapshotRestoreArgs,
  buildStartVmArgs,
  buildUnregisterArgs,
  parseVBoxGuestPropertyIp,
  parseVBoxRunningVms,
  parseVBoxSnapshotNames,
  vboxEnvDown,
  vboxEnvPs,
  vboxEnvPsAll,
  vboxEnvRm,
  vboxEnvUp,
  vboxVmExists,
  type VboxLifecycleOptions,
} from './vbox-lifecycle';
import type { VmExec, VmExecResult } from './vm-lifecycle';

const VM_RECIPE: EnvironmentRecipe = {
  id: 'pwn-vm',
  dir: '/recipes/pwn-vm',
  name: 'pwn-vm',
  description: 'Linux pwn VM 研究现场',
  base: 'vm',
  tools: ['gdb'],
  vmEngine: 'virtualbox',
  vmUser: 'researcher',
  vmSnapshot: 'zhishi-clean',
  valid: true,
  invalidReasons: [],
};

function ok(stdout = ''): VmExecResult {
  return { exitCode: 0, stdout, stderr: '' };
}

/** Scriptable exec: records argv, replays queued results in order. */
function scriptedExec(queue: Array<VmExecResult | ((argv: string[]) => VmExecResult)>) {
  const calls: string[][] = [];
  const exec: VmExec = async (argv) => {
    calls.push(argv);
    const next = queue.shift();
    if (!next) throw new Error(`unexpected exec: ${argv.join(' ')}`);
    return typeof next === 'function' ? next(argv) : next;
  };
  return { exec, calls };
}

/** Queue head = successful virtualbox probe (VBoxManage --version exit 0). */
const PROBE_OK = ok('7.1.4r165100\n');

/** IP 轮询一次即弃（deadline 0 + 不真睡的时钟）。 */
const POLL_ONCE = { ipPoll: { deadlineMs: 0, intervalMs: 1, sleep: async () => {} } };

function upOptions(exec: VmExec, extra: Partial<VboxLifecycleOptions> = {}): VboxLifecycleOptions {
  return { exec, shortId: () => 'a1b2c3d4', ...POLL_ONCE, ...extra };
}

describe('command assembly (pure)', () => {
  it('assembles the VBoxManage argv for each lifecycle verb', () => {
    expect(buildCloneVmArgs('tpl-ubuntu', 'zhishi-pwn-vm-a1b2c3d4')).toEqual([
      'clonevm', 'tpl-ubuntu', '--name', 'zhishi-pwn-vm-a1b2c3d4', '--register',
    ]);
    expect(buildSnapshotListArgs('n')).toEqual(['snapshot', 'n', 'list']);
    expect(buildSnapshotRestoreArgs('n', 'clean')).toEqual(['snapshot', 'n', 'restore', 'clean']);
    expect(buildStartVmArgs('n')).toEqual(['startvm', 'n', '--type', 'headless']);
    expect(buildAcpiPowerdownArgs('n')).toEqual(['controlvm', 'n', 'acpipowerbutton']);
    expect(buildListRunningArgs()).toEqual(['list', 'runningvms']);
    expect(buildListVmsArgs()).toEqual(['list', 'vms']);
    expect(buildGuestIpArgs('n')).toEqual([
      'guestproperty', 'get', 'n', '/VirtualBox/GuestInfo/Net/0/V4/IP',
    ]);
    expect(buildUnregisterArgs('n')).toEqual(['unregistervm', 'n', '--delete']);
    expect(buildShowVmInfoArgs('n')).toEqual(['showvminfo', 'n', '--machinereadable']);
  });
});

describe('output parsing (pure)', () => {
  it('parseVBoxRunningVms: quoted names with uuid braces; junk lines dropped', () => {
    const stdout = '"zhishi-pwn-vm-a1b2c3d4" {a1b2c3d4-0000-0000-0000-000000000000}\r\n"Windows 10" {9b8...}\ngarbage line\n';
    expect(parseVBoxRunningVms(stdout)).toEqual(['zhishi-pwn-vm-a1b2c3d4', 'Windows 10']);
    expect(parseVBoxRunningVms('')).toEqual([]);
  });

  it('parseVBoxSnapshotNames: tree-indented Name: lines', () => {
    const stdout = '   Name: zhishi-clean (UUID: 1111)\n     Name: child snap (UUID: 2222)\n';
    expect(parseVBoxSnapshotNames(stdout)).toEqual(['zhishi-clean', 'child snap']);
    expect(parseVBoxSnapshotNames('This machine does not have any snapshots\n')).toEqual([]);
  });

  it('parseVBoxGuestPropertyIp: Value: line vs No value set! vs garbage', () => {
    expect(parseVBoxGuestPropertyIp('Value: 10.0.2.15\n')).toBe('10.0.2.15');
    expect(parseVBoxGuestPropertyIp('No value set!\n')).toBeUndefined();
    expect(parseVBoxGuestPropertyIp('')).toBeUndefined();
    expect(parseVBoxGuestPropertyIp('Value: pending\n')).toBeUndefined();
  });
});

describe('vboxEnvUp', () => {
  it('happy path: probe → clonevm → restore(snapshot exists) → startvm → poll IP', async () => {
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok(), // clonevm
      ok('Name: zhishi-clean (UUID: 1111)\n'), // snapshot list
      ok(), // snapshot restore
      ok(), // startvm
      ok('Value: 10.0.2.15\n'), // guestproperty
    ]);
    const result = await vboxEnvUp(VM_RECIPE, '/work/dir', upOptions(exec, { vmBase: 'tpl-ubuntu' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instance.name).toBe('zhishi-pwn-vm-a1b2c3d4');
    expect(result.instance.address).toBe('10.0.2.15');
    expect(result.instance.template).toBe('tpl-ubuntu');
    expect(result.instance.recipe).toBe('pwn-vm');
    expect(result.instance.workspace).toBe('/work/dir');
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual([
      'VBoxManage --version',
      'VBoxManage clonevm',
      'VBoxManage snapshot',
      'VBoxManage snapshot',
      'VBoxManage startvm',
      'VBoxManage guestproperty',
    ]);
  });

  it('snapshot declared but absent → skip restore, still start', async () => {
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok(), // clonevm
      ok('This machine does not have any snapshots\n'),
      ok(), // startvm
      ok('Value: 10.0.2.16\n'),
    ]);
    const result = await vboxEnvUp(VM_RECIPE, '/w', upOptions(exec, { vmBase: 'tpl-ubuntu' }));
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c[1] === 'snapshot')).toHaveLength(1); // list only
  });

  it("'No value set!' poll retries until the IP shows up", async () => {
    const recipe: EnvironmentRecipe = { ...VM_RECIPE, vmSnapshot: undefined };
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok(), // clonevm
      ok(), // startvm
      ok('No value set!\n'), // first poll: not ready
      ok('Value: 10.0.2.17\n'), // second poll: ready
    ]);
    const result = await vboxEnvUp(recipe, '/w', upOptions(exec, {
      vmBase: 'tpl-ubuntu',
      ipPoll: { deadlineMs: 60_000, intervalMs: 1, now: () => 1000, sleep: async () => {} },
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.instance.address).toBe('10.0.2.17');
    expect(calls.filter((c) => c[1] === 'guestproperty')).toHaveLength(2);
  });

  it('IP never ready → still ok, address undefined (VM is running)', async () => {
    const recipe: EnvironmentRecipe = { ...VM_RECIPE, vmSnapshot: undefined };
    const { exec } = scriptedExec([PROBE_OK, ok(), ok(), ok('No value set!\n')]);
    const result = await vboxEnvUp(recipe, '/w', upOptions(exec, { vmBase: 'tpl-ubuntu' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.instance.address).toBeUndefined();
  });

  it('missing vmBase → guidance error naming list vms and --vm-base, no exec calls', async () => {
    const recipe: EnvironmentRecipe = { ...VM_RECIPE, vmBase: undefined };
    const { exec, calls } = scriptedExec([]);
    const result = await vboxEnvUp(recipe, '/w', { exec, ...POLL_ONCE });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('已注册的 VM 名');
      expect(result.error).toContain('--vm-base');
      expect(result.error).toContain('vmware'); // adopt/build 暂只支持 vmware
    }
    expect(calls).toHaveLength(0);
  });

  it('recipe.vmBase from frontmatter is honoured when the flag is absent', async () => {
    const recipe: EnvironmentRecipe = { ...VM_RECIPE, vmBase: 'tpl-frontmatter', vmSnapshot: undefined };
    const { exec, calls } = scriptedExec([PROBE_OK, ok(), ok(), ok('Value: 10.0.2.18\n')]);
    const result = await vboxEnvUp(recipe, '/w', upOptions(exec));
    expect(result.ok).toBe(true);
    expect(calls[1]).toEqual(['VBoxManage', 'clonevm', 'tpl-frontmatter', '--name', 'zhishi-pwn-vm-a1b2c3d4', '--register']);
  });

  it('virtualbox unavailable → guidance error, probe only', async () => {
    const { exec, calls } = scriptedExec([
      { exitCode: -1, stdout: '', stderr: '', error: 'spawn VBoxManage ENOENT' },
    ]);
    const result = await vboxEnvUp(VM_RECIPE, '/w', upOptions(exec, { vmBase: 'tpl-ubuntu' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('VirtualBox');
    expect(calls).toHaveLength(1);
  });

  it('clonevm failure (template not registered) → error with hint', async () => {
    const { exec } = scriptedExec([
      PROBE_OK,
      { exitCode: 1, stdout: '', stderr: 'VBoxManage: error: Could not find a registered machine\n' },
    ]);
    const result = await vboxEnvUp(VM_RECIPE, '/w', upOptions(exec, { vmBase: 'ghost-tpl' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('clonevm 失败');
      expect(result.error).toContain('list vms');
    }
  });

  it('snapshot restore failure → error, never starts', async () => {
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok(), // clonevm
      ok('Name: zhishi-clean (UUID: 1111)\n'),
      { exitCode: 1, stdout: '', stderr: 'VBoxManage: error: snapshot broken\n' },
    ]);
    const result = await vboxEnvUp(VM_RECIPE, '/w', upOptions(exec, { vmBase: 'tpl-ubuntu' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('snapshot restore');
    expect(calls.some((c) => c[1] === 'startvm')).toBe(false);
  });

  it('startvm failure → error, IP poll never runs', async () => {
    const recipe: EnvironmentRecipe = { ...VM_RECIPE, vmSnapshot: undefined };
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok(), // clonevm
      { exitCode: 1, stdout: '', stderr: 'VBoxManage: error: The machine is not usable\n' },
    ]);
    const result = await vboxEnvUp(recipe, '/w', upOptions(exec, { vmBase: 'tpl-ubuntu' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('startvm 失败');
    expect(calls.some((c) => c[1] === 'guestproperty')).toBe(false);
  });
});

describe('vboxEnvDown', () => {
  it('running instance → controlvm acpipowerbutton', async () => {
    const { exec, calls } = scriptedExec([
      ok('"zhishi-pwn-vm-a1b2c3d4" {uuid}\n'),
      ok(),
    ]);
    const result = await vboxEnvDown('zhishi-pwn-vm-a1b2c3d4', { exec });
    expect(result.ok).toBe(true);
    expect(calls[1]).toEqual(['VBoxManage', 'controlvm', 'zhishi-pwn-vm-a1b2c3d4', 'acpipowerbutton']);
  });

  it('not running → clear error', async () => {
    const { exec } = scriptedExec([ok('"other-vm" {uuid}\n')]);
    const result = await vboxEnvDown('ghost', { exec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('未找到运行中的 VirtualBox 实例 "ghost"');
  });

  it('stop failure → error with poweroff hint', async () => {
    const { exec } = scriptedExec([
      ok('"zhishi-x-1" {uuid}\n'),
      { exitCode: 1, stdout: '', stderr: 'VBoxManage: error: guest 无响应\n' },
    ]);
    const result = await vboxEnvDown('zhishi-x-1', { exec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('poweroff');
  });
});

describe('vboxEnvRm', () => {
  it('removes a stopped instance (unregistervm --delete)', async () => {
    const { exec, calls } = scriptedExec([
      ok('vmstate="poweroff"\n'), // showvminfo
      ok(''), // list runningvms: empty
      ok(), // unregistervm
    ]);
    const result = await vboxEnvRm('zhishi-pwn-vm-dead01', { exec });
    expect(result.ok).toBe(true);
    expect(calls[2]).toEqual(['VBoxManage', 'unregistervm', 'zhishi-pwn-vm-dead01', '--delete']);
  });

  it('refuses a running instance (down first)', async () => {
    const { exec } = scriptedExec([
      ok('vmstate="running"\n'),
      ok('"zhishi-x-live" {uuid}\n'),
    ]);
    const result = await vboxEnvRm('zhishi-x-live', { exec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('还在运行');
  });

  it('missing instance and illegal names → clear errors', async () => {
    const { exec } = scriptedExec([
      { exitCode: 1, stdout: '', stderr: 'VBoxManage: error: Could not find a registered machine\n' },
    ]);
    const missing = await vboxEnvRm('ghost', { exec });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('未找到 VirtualBox 实例 "ghost"');

    const bad = await vboxEnvRm('../escape', { exec: scriptedExec([]).exec });
    expect(bad.ok).toBe(false);
  });
});

describe('vboxEnvPs', () => {
  it('lists only zhishi- prefixed running VMs; recipe recovered from name', async () => {
    const { exec } = scriptedExec([
      ok('"zhishi-pwn-vm-a1b2c3d4" {u1}\n"Windows 10" {u2}\n"zhishi-fuzz-99887766" {u3}\n'),
    ]);
    const result = await vboxEnvPs({ exec });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instances).toHaveLength(2);
    expect(result.instances[0].recipe).toBe('pwn-vm');
    expect(result.instances[1].recipe).toBe('fuzz');
    expect(result.instances.every((i) => i.status === 'running')).toBe(true);
  });

  it('list failure → error (caller tolerates per-engine absence)', async () => {
    const { exec } = scriptedExec([{ exitCode: -1, stdout: '', stderr: '', error: 'spawn VBoxManage ENOENT' }]);
    const result = await vboxEnvPs({ exec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('VirtualBox');
  });
});

describe('vboxEnvPsAll（B5：discover 全量枚举）', () => {
  it('走 list vms（全量），保留非 zhishi-* 前缀 VM，status 记 unknown', async () => {
    const { exec, calls } = scriptedExec([
      ok('"zhishi-pwn-vm-a1b2c3d4" {u1}\n"Windows 10" {u2}\n"user-kali" {u3}\n'),
    ]);
    const result = await vboxEnvPsAll({ exec });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls[0].slice(0, 3)).toEqual(['VBoxManage', 'list', 'vms']);
    expect(result.instances.map((i) => i.name)).toEqual([
      'zhishi-pwn-vm-a1b2c3d4',
      'Windows 10',
      'user-kali',
    ]);
    // list vms 输出不带状态——不猜，记 unknown
    expect(result.instances.every((i) => i.status === 'unknown')).toBe(true);
    // 非 zhishi-* 前缀的 VM recipe 为空（不做名字反推）
    expect(result.instances[2].recipe).toBe('');
  });

  it('list vms 失败 → error（聚合层降级，不拖垮其它侧）', async () => {
    const { exec } = scriptedExec([{ exitCode: -1, stdout: '', stderr: '', error: 'spawn VBoxManage ENOENT' }]);
    const result = await vboxEnvPsAll({ exec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('VirtualBox');
  });
});

describe('vboxVmExists (routing probe, fault-tolerant)', () => {
  it('true on hit; false on miss / error / throw', async () => {
    const hit = await vboxVmExists('zhishi-x-1', { exec: scriptedExec([ok('vmstate="running"\n')]).exec });
    expect(hit).toBe(true);

    const miss = await vboxVmExists('ghost', {
      exec: scriptedExec([{ exitCode: 1, stdout: '', stderr: 'not found\n' }]).exec,
    });
    expect(miss).toBe(false);

    const spawnFailed = await vboxVmExists('x', {
      exec: scriptedExec([{ exitCode: -1, stdout: '', stderr: '', error: 'ENOENT' }]).exec,
    });
    expect(spawnFailed).toBe(false);

    const throwing = await vboxVmExists('x', {
      exec: async () => {
        throw new Error('boom');
      },
    });
    expect(throwing).toBe(false);
  });
});
