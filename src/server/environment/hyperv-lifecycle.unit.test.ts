/**
 * 安全研究员版 P2 B3 — VM(Hyper-V)环境生命周期 unit tests.
 *
 * 全部通过注入的 exec 断言 PowerShell 脚本组装与输出解析，绝不真调
 * powershell（platform 也强制注入 'win32'，Linux CI 同样可跑）。实例目录
 * 冲突/清理用真临时目录。覆盖：psQuote/psArgs、各 cmdlet 脚本组装、
 * Get-VM JSON 列表解析、hypervEnvUp happy path / 缺模板 / 目录缺失 /
 * 引擎不可用 / .vmcx 缺失 / Import 失败 / Start 失败 / 快照 restore /
 * IP 轮询（拿到 / 重试拿到 / 超时不算失败）、down/rm/ps 与路由探测。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { EnvironmentRecipe } from './recipes';
import {
  buildFindVmcxPs,
  buildGetIpPs,
  buildGetSnapshotPs,
  buildGetVmPs,
  buildGetVmStatePs,
  buildImportVmPs,
  buildListAllVmsPs,
  buildListVmsPs,
  buildRemoveVmPs,
  buildRestoreSnapshotPs,
  buildStartVmPs,
  buildStopVmPs,
  hypervEnvDown,
  hypervEnvPs,
  hypervEnvPsAll,
  hypervEnvRm,
  hypervEnvUp,
  hypervVmExists,
  parseHypervVmList,
  psArgs,
  psQuote,
  type HypervLifecycleOptions,
} from './hyperv-lifecycle';
import type { VmExec, VmExecResult } from './vm-lifecycle';

const VM_RECIPE: EnvironmentRecipe = {
  id: 'pwn-vm',
  dir: '/recipes/pwn-vm',
  name: 'pwn-vm',
  description: 'Linux pwn VM 研究现场',
  base: 'vm',
  tools: ['gdb'],
  vmEngine: 'hyperv',
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

/** Queue head = successful hyperv probe (Get-VM + 'ok' marker). */
const PROBE_OK = ok('ok\n');

/** 强制 win32（Hyper-V 平台门控注入），测试与真实运行平台解耦。 */
const WIN32 = { platform: 'win32' as const };

/** IP 轮询一次即弃（deadline 0 + 不真睡的时钟）。 */
const POLL_ONCE = { ipPoll: { deadlineMs: 0, intervalMs: 1, sleep: async () => {} } };

const tempRoots: string[] = [];
function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'zhishi-hyperv-test-'));
  tempRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** 伪造 Export-VM 导出目录（只需存在；.vmcx 定位走注入 exec）。 */
function makeExportDir(root: string): string {
  const dir = join(root, 'export-win10');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function upOptions(root: string, exec: VmExec, extra: Partial<HypervLifecycleOptions> = {}): HypervLifecycleOptions {
  return { exec, instancesRoot: join(root, 'instances'), shortId: () => 'a1b2c3d4', ...WIN32, ...POLL_ONCE, ...extra };
}

describe('command assembly (pure)', () => {
  it('psQuote doubles embedded single quotes', () => {
    expect(psQuote('plain')).toBe("'plain'");
    expect(psQuote("it's")).toBe("'it''s'");
  });

  it('psArgs wraps the script in powershell -NoProfile -Command', () => {
    expect(psArgs('Get-VM')).toEqual(['powershell', '-NoProfile', '-Command', 'Get-VM']);
  });

  it('import script copies with a new id into the instance dir and renames', () => {
    const ps = buildImportVmPs('D:\\exp\\Virtual Machines\\x.vmcx', 'zhishi-pwn-vm-a1b2c3d4', 'C:\\inst\\zhishi-pwn-vm-a1b2c3d4');
    expect(ps).toContain("Import-VM -Path 'D:\\exp\\Virtual Machines\\x.vmcx' -Copy -GenerateNewId");
    expect(ps).toContain("-VhdDestinationPath 'C:\\inst\\zhishi-pwn-vm-a1b2c3d4'");
    expect(ps).toContain("-VirtualMachinePath 'C:\\inst\\zhishi-pwn-vm-a1b2c3d4'");
    expect(ps).toContain("Rename-VM -VM $vm -NewName 'zhishi-pwn-vm-a1b2c3d4'");
  });

  it('lifecycle scripts target the named VM', () => {
    expect(buildFindVmcxPs('D:\\exp')).toContain("-Path 'D:\\exp' -Recurse -Filter *.vmcx");
    expect(buildGetSnapshotPs('n', 'snap')).toContain("Get-VMSnapshot -VMName 'n' -Name 'snap'");
    expect(buildRestoreSnapshotPs('n', 'snap')).toContain("Restore-VMSnapshot -Name 'snap' -VMName 'n' -Confirm:$false");
    expect(buildStartVmPs('n')).toBe("Start-VM -Name 'n'");
    expect(buildGetIpPs('n')).toContain("Get-VMNetworkAdapter -VMName 'n'");
    expect(buildStopVmPs('n')).toBe("Stop-VM -Name 'n'");
    expect(buildGetVmPs('n')).toContain("Get-VM -Name 'n'");
    expect(buildGetVmStatePs('n')).toContain('ExpandProperty State');
    expect(buildRemoveVmPs('n')).toBe("Remove-VM -Name 'n' -Force");
    expect(buildListVmsPs()).toContain("Get-VM -Name 'zhishi-*'");
    expect(buildListVmsPs()).toContain('ConvertTo-Json');
  });

  it('B4：ps 脚本带 Running 状态过滤（停止的 VM 不算运行中）', () => {
    expect(buildListVmsPs()).toContain("Where-Object { $_.State -eq 'Running' }");
  });

  it('B5：discover 脚本全量枚举（无 zhishi-* 前缀过滤、无状态过滤）', () => {
    expect(buildListAllVmsPs()).toContain('Get-VM | Select-Object Name, State');
    expect(buildListAllVmsPs()).not.toContain('zhishi-*');
    expect(buildListAllVmsPs()).not.toContain('Where-Object');
  });
});

describe('parseHypervVmList (pure)', () => {
  it('parses an array payload', () => {
    const json = JSON.stringify([
      { Name: 'zhishi-pwn-vm-a1b2c3d4', State: 'Running' },
      { Name: 'zhishi-fuzz-99887766', State: 'Off' },
    ]);
    expect(parseHypervVmList(json)).toEqual([
      { name: 'zhishi-pwn-vm-a1b2c3d4', state: 'Running' },
      { name: 'zhishi-fuzz-99887766', state: 'Off' },
    ]);
  });

  it('parses a single-object payload (ConvertTo-Json quirk)', () => {
    expect(parseHypervVmList(JSON.stringify({ Name: 'zhishi-x-1', State: 'Running' }))).toEqual([
      { name: 'zhishi-x-1', state: 'Running' },
    ]);
  });

  it('empty / garbage → [] (never blows up the listing)', () => {
    expect(parseHypervVmList('')).toEqual([]);
    expect(parseHypervVmList('not json')).toEqual([]);
    expect(parseHypervVmList('[{"State":"Running"}]')).toEqual([]); // 无 Name 的行丢弃
  });
});

describe('hypervEnvUp', () => {
  it('happy path: probe → find vmcx → import → restore(snapshot) → start → poll IP', async () => {
    const root = makeTempRoot();
    const exportDir = makeExportDir(root);
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok(`${join(exportDir, 'Virtual Machines', 'x.vmcx')}\n`), // find vmcx
      ok(), // import
      ok('ok\n'), // snapshot exists
      ok(), // restore
      ok(), // start
      ok('10.0.0.8\n'), // ip poll
    ]);
    const result = await hypervEnvUp(VM_RECIPE, '/work/dir', upOptions(root, exec, { vmBase: exportDir }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instance.name).toBe('zhishi-pwn-vm-a1b2c3d4');
    expect(result.instance.address).toBe('10.0.0.8');
    expect(result.instance.dir).toBe(join(root, 'instances', 'zhishi-pwn-vm-a1b2c3d4'));
    expect(result.instance.recipe).toBe('pwn-vm');
    expect(result.instance.workspace).toBe('/work/dir');
    // 脚本内容断言关键 cmdlet 顺序（argv[3] 是 -Command 的脚本本体）
    const scripts = calls.map((c) => c[3] ?? '');
    expect(scripts[0]).toContain('Get-VM'); // probe
    expect(scripts[1]).toContain('Get-ChildItem');
    expect(scripts[2]).toContain('Import-VM');
    expect(scripts[3]).toContain('Get-VMSnapshot');
    expect(scripts[4]).toContain('Restore-VMSnapshot');
    expect(scripts[5]).toContain('Start-VM');
    expect(scripts[6]).toContain('Get-VMNetworkAdapter');
  });

  it('snapshot declared but absent → skip restore, still start', async () => {
    const root = makeTempRoot();
    const exportDir = makeExportDir(root);
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok('x.vmcx\n'),
      ok(), // import
      ok(''), // snapshot probe: no 'ok' marker
      ok(), // start
      ok('10.0.0.9\n'),
    ]);
    const result = await hypervEnvUp(VM_RECIPE, '/w', upOptions(root, exec, { vmBase: exportDir }));
    expect(result.ok).toBe(true);
    expect(calls.some((c) => (c[3] ?? '').includes('Restore-VMSnapshot'))).toBe(false);
  });

  it('IP poll retries until an address shows up', async () => {
    const root = makeTempRoot();
    const exportDir = makeExportDir(root);
    const recipe: EnvironmentRecipe = { ...VM_RECIPE, vmSnapshot: undefined };
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok('x.vmcx\n'),
      ok(), // import
      ok(), // start
      ok(''), // first poll: no addresses yet
      ok('10.0.0.10\n'), // second poll: ready
    ]);
    const result = await hypervEnvUp(recipe, '/w', upOptions(root, exec, {
      vmBase: exportDir,
      ipPoll: { deadlineMs: 60_000, intervalMs: 1, now: () => 1000, sleep: async () => {} },
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.instance.address).toBe('10.0.0.10');
    expect(calls.filter((c) => (c[3] ?? '').includes('Get-VMNetworkAdapter'))).toHaveLength(2);
  });

  it('IP never ready → still ok, address undefined (VM is running)', async () => {
    const root = makeTempRoot();
    const exportDir = makeExportDir(root);
    const recipe: EnvironmentRecipe = { ...VM_RECIPE, vmSnapshot: undefined };
    const { exec } = scriptedExec([PROBE_OK, ok('x.vmcx\n'), ok(), ok(), ok('')]);
    const result = await hypervEnvUp(recipe, '/w', upOptions(root, exec, { vmBase: exportDir }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.instance.address).toBeUndefined();
  });

  it('missing vmBase → guidance error naming Export-VM and --vm-base, no exec calls', async () => {
    const recipe: EnvironmentRecipe = { ...VM_RECIPE, vmBase: undefined };
    const { exec, calls } = scriptedExec([]);
    const result = await hypervEnvUp(recipe, '/w', { exec, ...WIN32, ...POLL_ONCE });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Export-VM');
      expect(result.error).toContain('--vm-base');
      expect(result.error).toContain('vmware'); // adopt/build 暂只支持 vmware
    }
    expect(calls).toHaveLength(0);
  });

  it('missing export dir → clear error before any exec', async () => {
    const root = makeTempRoot();
    const { exec, calls } = scriptedExec([]);
    const result = await hypervEnvUp(VM_RECIPE, '/w', upOptions(root, exec, { vmBase: join(root, 'ghost') }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('导出目录不存在');
    expect(calls).toHaveLength(0);
  });

  it('hyperv unavailable → guidance error, probe only', async () => {
    const root = makeTempRoot();
    const exportDir = makeExportDir(root);
    const { exec, calls } = scriptedExec([
      { exitCode: 1, stdout: '', stderr: 'Get-VM : 未识别', error: undefined },
    ]);
    const result = await hypervEnvUp(VM_RECIPE, '/w', upOptions(root, exec, { vmBase: exportDir }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Hyper-V');
    expect(calls).toHaveLength(1);
  });

  it('no .vmcx under the export dir → clear error', async () => {
    const root = makeTempRoot();
    const exportDir = makeExportDir(root);
    const { exec } = scriptedExec([PROBE_OK, ok('')]);
    const result = await hypervEnvUp(VM_RECIPE, '/w', upOptions(root, exec, { vmBase: exportDir }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('未找到 .vmcx');
  });

  it('Import-VM failure → error with output tail', async () => {
    const root = makeTempRoot();
    const exportDir = makeExportDir(root);
    const { exec } = scriptedExec([
      PROBE_OK,
      ok('x.vmcx\n'),
      { exitCode: 1, stdout: '', stderr: 'Import-VM : 找不到文件\n' },
    ]);
    const result = await hypervEnvUp(VM_RECIPE, '/w', upOptions(root, exec, { vmBase: exportDir }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Import-VM 失败');
      expect(result.error).toContain('找不到文件');
    }
  });

  it('existing instance dir → conflict error, import never runs', async () => {
    const root = makeTempRoot();
    const exportDir = makeExportDir(root);
    mkdirSync(join(root, 'instances', 'zhishi-pwn-vm-a1b2c3d4'), { recursive: true });
    const { exec, calls } = scriptedExec([PROBE_OK, ok('x.vmcx\n')]);
    const result = await hypervEnvUp(VM_RECIPE, '/w', upOptions(root, exec, { vmBase: exportDir }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('实例目录已存在');
    expect(calls.some((c) => (c[3] ?? '').includes('Import-VM'))).toBe(false);
  });

  it('Start-VM failure → error, IP poll never runs', async () => {
    const root = makeTempRoot();
    const exportDir = makeExportDir(root);
    const recipe: EnvironmentRecipe = { ...VM_RECIPE, vmSnapshot: undefined };
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok('x.vmcx\n'),
      ok(), // import
      { exitCode: 1, stdout: '', stderr: 'Start-VM : 内存不足\n' },
    ]);
    const result = await hypervEnvUp(recipe, '/w', upOptions(root, exec, { vmBase: exportDir }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Start-VM 失败');
    expect(calls.some((c) => (c[3] ?? '').includes('Get-VMNetworkAdapter'))).toBe(false);
  });
});

describe('hypervEnvDown', () => {
  it('exists → Stop-VM (soft)', async () => {
    const { exec, calls } = scriptedExec([ok('zhishi-pwn-vm-a1b2c3d4\n'), ok()]);
    const result = await hypervEnvDown('zhishi-pwn-vm-a1b2c3d4', { exec, ...WIN32 });
    expect(result.ok).toBe(true);
    expect(calls[1]?.[3]).toBe("Stop-VM -Name 'zhishi-pwn-vm-a1b2c3d4'");
  });

  it('unknown instance → clear error', async () => {
    const { exec } = scriptedExec([{ exitCode: 1, stdout: '', stderr: 'Get-VM : 找不到\n' }]);
    const result = await hypervEnvDown('ghost', { exec, ...WIN32 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('未找到 Hyper-V 实例 "ghost"');
  });

  it('stop failure → error with -TurnOff hint', async () => {
    const { exec } = scriptedExec([
      ok('zhishi-x-1\n'),
      { exitCode: 1, stdout: '', stderr: 'Stop-VM : guest 无响应\n' },
    ]);
    const result = await hypervEnvDown('zhishi-x-1', { exec, ...WIN32 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('-TurnOff');
  });
});

describe('hypervEnvRm', () => {
  it('removes a stopped instance and its copy dir', async () => {
    const root = makeTempRoot();
    const dir = join(root, 'instances', 'zhishi-pwn-vm-dead01');
    mkdirSync(dir, { recursive: true });
    const { exec } = scriptedExec([
      ok('zhishi-pwn-vm-dead01\n'), // exists
      ok('Off\n'), // state
      ok(), // Remove-VM
    ]);
    const result = await hypervEnvRm('zhishi-pwn-vm-dead01', { exec, instancesRoot: join(root, 'instances'), ...WIN32 });
    expect(result.ok).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses a running instance (down first)', async () => {
    const root = makeTempRoot();
    const { exec } = scriptedExec([ok('zhishi-x-live\n'), ok('Running\n')]);
    const result = await hypervEnvRm('zhishi-x-live', { exec, instancesRoot: join(root, 'instances'), ...WIN32 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('还在运行');
  });

  it('missing instance and illegal names → clear errors', async () => {
    const root = makeTempRoot();
    const { exec } = scriptedExec([{ exitCode: 1, stdout: '', stderr: '' }]);
    const missing = await hypervEnvRm('ghost', { exec, instancesRoot: join(root, 'instances'), ...WIN32 });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('未找到 Hyper-V 实例 "ghost"');

    const bad = await hypervEnvRm('../escape', { exec: scriptedExec([]).exec, ...WIN32 });
    expect(bad.ok).toBe(false);
  });
});

describe('hypervEnvPs', () => {
  it('lists zhishi-* VMs; recipe recovered from name, state lowercased', async () => {
    const json = JSON.stringify([
      { Name: 'zhishi-pwn-vm-a1b2c3d4', State: 'Running' },
      { Name: 'zhishi-fuzz-99887766', State: 'Off' },
    ]);
    const { exec } = scriptedExec([ok(json)]);
    const result = await hypervEnvPs({ exec, instancesRoot: '/x/instances', ...WIN32 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instances).toHaveLength(2);
    expect(result.instances[0].recipe).toBe('pwn-vm');
    expect(result.instances[0].status).toBe('running');
    expect(result.instances[1].status).toBe('off');
    expect(result.instances[0].dir).toBe(join('/x/instances', 'zhishi-pwn-vm-a1b2c3d4'));
  });

  it('B4：ps 走带 Running 过滤的脚本（过滤在 PowerShell 侧做）', async () => {
    const { exec, calls } = scriptedExec([ok('')]);
    await hypervEnvPs({ exec, ...WIN32 });
    expect(calls[0][3]).toContain("Where-Object { $_.State -eq 'Running' }");
    expect(calls[0][3]).toContain("Get-VM -Name 'zhishi-*'");
  });

  it('Get-VM failure → error (caller tolerates per-engine absence)', async () => {
    const { exec } = scriptedExec([{ exitCode: 1, stdout: '', stderr: '', error: 'spawn powershell ENOENT' }]);
    const result = await hypervEnvPs({ exec, ...WIN32 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Get-VM 失败');
  });
});

describe('hypervEnvPsAll（B5：discover 全量枚举）', () => {
  it('走无过滤的 Get-VM 脚本，保留全部 VM（含停止、含非 zhishi-* 前缀）', async () => {
    const json = JSON.stringify([
      { Name: 'zhishi-pwn-vm-a1b2c3d4', State: 'Running' },
      { Name: 'zhishi-fuzz-99887766', State: 'Off' },
      { Name: 'user-win11', State: 'Saved' },
    ]);
    const { exec, calls } = scriptedExec([ok(json)]);
    const result = await hypervEnvPsAll({ exec, instancesRoot: '/x/instances', ...WIN32 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls[0][3]).toContain('Get-VM | Select-Object Name, State');
    expect(calls[0][3]).not.toContain('Where-Object');
    expect(result.instances.map((i) => i.name)).toEqual([
      'zhishi-pwn-vm-a1b2c3d4',
      'zhishi-fuzz-99887766',
      'user-win11',
    ]);
    expect(result.instances[1].status).toBe('off');
    // 非 zhishi-* 前缀的 VM recipe 为空（不做名字反推）
    expect(result.instances[2].recipe).toBe('');
  });

  it('非 Windows 平台 → ok:false 且不发命令（平台门控与 ps 一致）', async () => {
    const { exec, calls } = scriptedExec([]);
    const result = await hypervEnvPsAll({ exec, platform: 'linux' });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('Get-VM 失败 → error（聚合层降级，不拖垮其它侧）', async () => {
    const { exec } = scriptedExec([{ exitCode: 1, stdout: '', stderr: '', error: 'spawn powershell ENOENT' }]);
    const result = await hypervEnvPsAll({ exec, ...WIN32 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Get-VM 失败');
  });
});

describe('hypervVmExists (routing probe, fault-tolerant)', () => {
  it('true on hit; false on miss / error / throw', async () => {
    const hit = await hypervVmExists('zhishi-x-1', { exec: scriptedExec([ok('zhishi-x-1\n')]).exec, ...WIN32 });
    expect(hit).toBe(true);

    const miss = await hypervVmExists('ghost', {
      exec: scriptedExec([{ exitCode: 1, stdout: '', stderr: 'Get-VM : 找不到\n' }]).exec,
      ...WIN32,
    });
    expect(miss).toBe(false);

    const spawnFailed = await hypervVmExists('x', {
      exec: scriptedExec([{ exitCode: -1, stdout: '', stderr: '', error: 'ENOENT' }]).exec,
      ...WIN32,
    });
    expect(spawnFailed).toBe(false);

    const throwing = await hypervVmExists('x', {
      exec: async () => {
        throw new Error('boom');
      },
      ...WIN32,
    });
    expect(throwing).toBe(false);
  });

  it('non-Windows platform → false without exec', async () => {
    const { exec, calls } = scriptedExec([]);
    expect(await hypervVmExists('x', { exec, platform: 'linux' })).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
