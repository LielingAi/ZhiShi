/**
 * 安全研究员版 P2 — VM(vmrun)环境生命周期 unit tests（D22 直连真实 VM）.
 *
 * 全部通过注入的 exec 断言命令组装与输出解析,绝不真调 vmrun；vmx 存在性
 * 检查用真临时文件。覆盖:命名约定（hyperv/vbox 沿用）、start/stop/list/
 * snapshot/ip 参数组装、vmrun list / listSnapshots / getGuestIPAddress
 * 输出解析、vmx 路径规整、vmware 不可用的引导错误、缺 --vm-base 的错误、
 * 直连 up（无任何拷贝：对模板 vmx 直接 revert+start+getIP）、已在 vmrun
 * list → 幂等不 start、快照缺失跳过 revert、start 失败重试一次、down
 * 只收 .vmx、ps 返回全部运行中 vmx。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { EnvironmentRecipe } from './recipes';
import {
  buildVmrunGetIpArgs,
  buildVmrunListArgs,
  buildVmrunListSnapshotsArgs,
  buildVmrunRevertArgs,
  buildVmrunSnapshotArgs,
  buildVmrunStartArgs,
  buildVmrunStopArgs,
  ensureKernelDebugPort,
  normalizeVmxPath,
  parseGuestIp,
  parseVmrunList,
  parseVmrunSnapshotList,
  vmEnvDown,
  vmEnvPs,
  vmEnvUp,
  vmInstanceNameFor,
  vmNameFromVmx,
  type VmExec,
  type VmExecResult,
} from './vm-lifecycle';

const VM_RECIPE: EnvironmentRecipe = {
  id: 'pwn-vm',
  dir: '/recipes/pwn-vm',
  name: 'pwn-vm',
  description: 'Linux pwn VM 研究现场',
  base: 'vm',
  tools: ['gdb'],
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

/** Queue head = successful vmware probe (vmrun list exit 0). */
const PROBE_OK = ok('Total running VMs: 0\n');

// Real temp dirs for the vmx existence check; cleaned up after the suite.
const tempRoots: string[] = [];
function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'zhishi-vm-test-'));
  tempRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** Touch a fake VM .vmx (direct mode operates on it in place — no copy). */
function makeVmx(root: string, name = 'ubuntu.vmx'): string {
  const vmx = join(root, name);
  writeFileSync(vmx, '.encoding = "UTF-8"\ndisplayName = "ubuntu"\n');
  return vmx;
}

describe('command assembly (pure)', () => {
  it('derived-instance naming convention (kept for hyperv/vbox drivers)', () => {
    expect(vmInstanceNameFor('pwn-vm', 'a1b2c3d4')).toBe('zhishi-pwn-vm-a1b2c3d4');
  });

  it('vmNameFromVmx: vmx 路径 → 实例名（stem，去路径去后缀；1.3.7 id 语义源）', () => {
    expect(vmNameFromVmx('C:\\VMs\\kali\\kali.vmx')).toBe('kali');
    expect(vmNameFromVmx('/vms/Win10/Win10.vmx')).toBe('Win10');
    expect(vmNameFromVmx('plain')).toBe('plain');
    expect(vmNameFromVmx('C:\\VMs\\x\\.vmx')).toBe('');
  });

  it('all vmrun commands carry -T ws (Workstation host type)', () => {
    expect(buildVmrunStartArgs('/i/x.vmx')).toEqual(['-T', 'ws', 'start', '/i/x.vmx', 'nogui']);
    expect(buildVmrunStopArgs('/i/x.vmx')).toEqual(['-T', 'ws', 'stop', '/i/x.vmx', 'soft']);
    expect(buildVmrunListArgs()).toEqual(['-T', 'ws', 'list']);
    expect(buildVmrunListSnapshotsArgs('/i/x.vmx')).toEqual(['-T', 'ws', 'listSnapshots', '/i/x.vmx']);
    expect(buildVmrunSnapshotArgs('/i/x.vmx', 'clean')).toEqual(['-T', 'ws', 'snapshot', '/i/x.vmx', 'clean']);
    expect(buildVmrunRevertArgs('/i/x.vmx', 'clean')).toEqual(['-T', 'ws', 'revertToSnapshot', '/i/x.vmx', 'clean']);
    expect(buildVmrunGetIpArgs('/i/x.vmx')).toEqual(['-T', 'ws', 'getGuestIPAddress', '/i/x.vmx', '-wait']);
  });
});

describe('output parsing (pure)', () => {
  it('parseVmrunList: skips the count header, keeps .vmx lines, drops junk', () => {
    const stdout = 'Total running VMs: 2\r\nC:\\VMs\\a\\a.vmx\r\nnot a vm path\nC:\\VMs\\b\\b.vmx\n';
    expect(parseVmrunList(stdout)).toEqual(['C:\\VMs\\a\\a.vmx', 'C:\\VMs\\b\\b.vmx']);
  });

  it('parseVmrunList: empty output → []', () => {
    expect(parseVmrunList('Total running VMs: 0\n')).toEqual([]);
    expect(parseVmrunList('')).toEqual([]);
  });

  it('parseVmrunSnapshotList: skips count header, keeps names verbatim (spaces allowed)', () => {
    expect(parseVmrunSnapshotList('Total snapshots: 2\nzhishi-clean\nafter tools\n')).toEqual([
      'zhishi-clean',
      'after tools',
    ]);
  });

  it('parseGuestIp: first IPv4 literal; undefined when absent', () => {
    expect(parseGuestIp('192.168.126.130\n')).toBe('192.168.126.130');
    expect(parseGuestIp('10.0.0.8')).toBe('10.0.0.8');
    expect(parseGuestIp('Error: unknown\n')).toBeUndefined();
  });

  it('normalizeVmxPath: case- and slash-insensitive comparison anchor', () => {
    expect(normalizeVmxPath('C:\\VMs\\A\\a.vmx')).toBe(normalizeVmxPath('c:/vms/a/a.vmx'));
  });
});

describe('vmEnvUp (D22 direct: no copy, in-place on the vmx)', () => {
  it('happy path: probe → list(miss) → revert(snapshot exists) → start → get IP, id = VM 名（vmx stem）', async () => {
    const root = makeTempRoot();
    const vmx = makeVmx(root);
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok('Total running VMs: 0\n'), // list: not running
      ok('Total snapshots: 1\nzhishi-clean\n'), // listSnapshots
      ok(), // revertToSnapshot
      ok(), // start
      ok('192.168.126.130\n'), // getGuestIPAddress
    ]);
    const result = await vmEnvUp(VM_RECIPE, '/work/dir', { exec, vmBase: vmx });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 1.3.7「实例即环境」：id/name = VM 名（vmx stem "ubuntu"），不再是 recipe.id
    expect(result.instance.id).toBe('ubuntu');
    expect(result.instance.name).toBe('ubuntu');
    expect(result.instance.vmx).toBe(vmx); // 直连：就是传入的 vmx，无实例目录拷贝
    expect(result.instance.address).toBe('192.168.126.130');
    expect(result.instance.recipe).toBe('pwn-vm');
    expect(result.instance.workspace).toBe('/work/dir');
    expect(calls.map((c) => c.slice(0, 4).join(' '))).toEqual([
      'vmrun list',
      'vmrun -T ws list',
      'vmrun -T ws listSnapshots',
      'vmrun -T ws revertToSnapshot',
      'vmrun -T ws start',
      'vmrun -T ws getGuestIPAddress',
    ]);
    expect(calls.every((c) => c[0] === 'vmrun')).toBe(true); // 无任何文件拷贝命令
  });

  it('already in vmrun list → idempotent ok: no revert, no start, IP refreshed only', async () => {
    const root = makeTempRoot();
    const vmx = makeVmx(root);
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok(`Total running VMs: 1\n${vmx}\n`), // list: already running
      ok('10.0.0.8\n'), // getGuestIPAddress
    ]);
    const result = await vmEnvUp(VM_RECIPE, '/w', { exec, vmBase: vmx });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.instance.address).toBe('10.0.0.8');
    expect(calls.some((c) => c.includes('start'))).toBe(false);
    expect(calls.some((c) => c.includes('revertToSnapshot'))).toBe(false);
    expect(calls.some((c) => c.includes('listSnapshots'))).toBe(false);
  });

  it('vmrun list writes the path with different case/slashes → still idempotent', async () => {
    const root = makeTempRoot();
    const vmx = makeVmx(root);
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok(`Total running VMs: 1\n${vmx.toUpperCase()}\n`),
      ok('10.0.0.8\n'),
    ]);
    const result = await vmEnvUp(VM_RECIPE, '/w', { exec, vmBase: vmx });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.includes('start'))).toBe(false);
  });

  it('snapshot declared but absent → skip revert, still start', async () => {
    const root = makeTempRoot();
    const vmx = makeVmx(root);
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok('Total running VMs: 0\n'),
      ok('Total snapshots: 0\n'), // no snapshots → no revert call
      ok(), // start
      ok('10.0.0.8\n'),
    ]);
    const result = await vmEnvUp(VM_RECIPE, '/w', { exec, vmBase: vmx });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.includes('revertToSnapshot'))).toBe(false);
  });

  it('no snapshot declared → no listSnapshots call at all', async () => {
    const root = makeTempRoot();
    const vmx = makeVmx(root);
    const recipe: EnvironmentRecipe = { ...VM_RECIPE, vmSnapshot: undefined };
    const { exec, calls } = scriptedExec([PROBE_OK, ok('Total running VMs: 0\n'), ok(), ok('10.0.0.9\n')]);
    const result = await vmEnvUp(recipe, '/w', { exec, vmBase: vmx });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.includes('listSnapshots'))).toBe(false);
  });

  it('missing vmBase → actionable error mentioning --vm-base', async () => {
    const recipe: EnvironmentRecipe = { ...VM_RECIPE, vmBase: undefined };
    const { exec } = scriptedExec([]);
    const result = await vmEnvUp(recipe, '/w', { exec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('--vm-base');
  });

  it('non-.vmx / missing vmx file → clear error before any exec', async () => {
    const root = makeTempRoot();
    const { exec, calls } = scriptedExec([]);
    const badExt = await vmEnvUp(VM_RECIPE, '/w', { exec, vmBase: join(root, 'x.vmdk') });
    expect(badExt.ok).toBe(false);
    if (!badExt.ok) expect(badExt.error).toContain('.vmx');
    const missing = await vmEnvUp(VM_RECIPE, '/w', { exec, vmBase: join(root, 'ghost.vmx') });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('VM 不存在');
    expect(calls).toHaveLength(0);
  });

  it('recipe.vmBase from frontmatter is honoured when the flag is absent', async () => {
    const root = makeTempRoot();
    const vmx = makeVmx(root);
    const recipe: EnvironmentRecipe = { ...VM_RECIPE, vmBase: vmx, vmSnapshot: undefined };
    const { exec } = scriptedExec([PROBE_OK, ok('Total running VMs: 0\n'), ok(), ok('10.0.0.10\n')]);
    const result = await vmEnvUp(recipe, '/w', { exec });
    expect(result.ok).toBe(true);
  });

  it('vmware unavailable → guidance error, no further calls', async () => {
    const root = makeTempRoot();
    const vmx = makeVmx(root);
    const { exec, calls } = scriptedExec([
      { exitCode: 1, stdout: '', stderr: '', error: 'spawn vmrun ENOENT' },
    ]);
    const result = await vmEnvUp(VM_RECIPE, '/w', { exec, vmBase: vmx });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('VMware');
    expect(calls).toHaveLength(1);
  });

  it('docker recipe → rejected (driver mismatch)', async () => {
    const recipe: EnvironmentRecipe = { ...VM_RECIPE, base: 'docker' };
    const { exec } = scriptedExec([]);
    const result = await vmEnvUp(recipe, '/w', { exec, vmBase: 'x.vmx' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('不是 VM 配方');
  });

  it('start failure → retries once, then error with vmrun output tail', async () => {
    const root = makeTempRoot();
    const vmx = makeVmx(root);
    const recipe: EnvironmentRecipe = { ...VM_RECIPE, vmSnapshot: undefined };
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok('Total running VMs: 0\n'),
      { exitCode: 1, stdout: '', stderr: 'Error: 未知错误\n' },
      { exitCode: 1, stdout: '', stderr: 'Error: 未知错误\n' }, // retry also fails
    ]);
    const result = await vmEnvUp(recipe, '/w', { exec, vmBase: vmx });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('vmrun start 失败');
      expect(result.error).toContain('未知错误');
    }
    expect(calls.filter((c) => c.includes('start'))).toHaveLength(2);
  });

  it('start flaky failure → retry succeeds (suspended-state residue, observed 2026-08-15)', async () => {
    const root = makeTempRoot();
    const vmx = makeVmx(root);
    const recipe: EnvironmentRecipe = { ...VM_RECIPE, vmSnapshot: undefined };
    const { exec } = scriptedExec([
      PROBE_OK,
      ok('Total running VMs: 0\n'),
      { exitCode: 1, stdout: '', stderr: 'Error: 未知错误\n' }, // first attempt fails
      ok(), // retry succeeds
      ok('10.0.0.11\n'),
    ]);
    const result = await vmEnvUp(recipe, '/w', { exec, vmBase: vmx });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.instance.address).toBe('10.0.0.11');
  });

  it('revert failure → error, never starts', async () => {
    const root = makeTempRoot();
    const vmx = makeVmx(root);
    const { exec, calls } = scriptedExec([
      PROBE_OK,
      ok('Total running VMs: 0\n'),
      ok('Total snapshots: 1\nzhishi-clean\n'),
      { exitCode: 1, stdout: '', stderr: 'Error: snapshot broken\n' },
    ]);
    const result = await vmEnvUp(VM_RECIPE, '/w', { exec, vmBase: vmx });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('revertToSnapshot');
    expect(calls.some((c) => c.includes('start'))).toBe(false);
  });

  it('IP lookup failure → still ok, address undefined (VM is running)', async () => {
    const root = makeTempRoot();
    const vmx = makeVmx(root);
    const recipe: EnvironmentRecipe = { ...VM_RECIPE, vmSnapshot: undefined };
    const { exec } = scriptedExec([
      PROBE_OK,
      ok('Total running VMs: 0\n'),
      ok(), // start
      { exitCode: -1, stdout: '', stderr: '', error: 'timed out' }, // getGuestIPAddress
    ]);
    const result = await vmEnvUp(recipe, '/w', { exec, vmBase: vmx });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.instance.address).toBeUndefined();
  });
});

describe('vmEnvDown', () => {
  it('direct .vmx path → stop soft, no list call', async () => {
    const { exec, calls } = scriptedExec([ok()]);
    const result = await vmEnvDown('/i/x.vmx', { exec });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([['vmrun', '-T', 'ws', 'stop', '/i/x.vmx', 'soft']]);
  });

  it('non-.vmx id → clear error (id → vmx resolution lives in admin-api)', async () => {
    const { exec, calls } = scriptedExec([]);
    const result = await vmEnvDown('pwn-vm', { exec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('未知 VM "pwn-vm"');
    expect(calls).toHaveLength(0);
  });

  it('stop failure → error with hard-stop hint', async () => {
    const { exec } = scriptedExec([
      { exitCode: 1, stdout: '', stderr: 'Error: guest not responding\n' },
    ]);
    const result = await vmEnvDown('/i/x.vmx', { exec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('hard');
  });
});

describe('vmEnvPs', () => {
  it('returns every running vmx verbatim (intersection with entries lives in admin-api)', async () => {
    const { exec } = scriptedExec([
      ok('Total running VMs: 3\nC:\\VMs\\a\\a.vmx\nC:\\other\\unrelated.vmx\nD:\\vms\\f.vmx\n'),
    ]);
    const result = await vmEnvPs({ exec });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.vmxes).toEqual(['C:\\VMs\\a\\a.vmx', 'C:\\other\\unrelated.vmx', 'D:\\vms\\f.vmx']);
  });

  it('vmrun list failure → error', async () => {
    const { exec } = scriptedExec([
      { exitCode: 1, stdout: '', stderr: '', error: 'spawn vmrun ENOENT' },
    ]);
    const result = await vmEnvPs({ exec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('vmrun list 失败');
  });
});

describe('ensureKernelDebugPort（1.8.0 win-kernel：vmx 注入纯函数）', () => {
  const VMX_BASE = '.encoding = "UTF-8"\ndisplayName = "win10-kd"\n';

  it('注入 4 行：serial0 管道（guest=server 约定，vmx 反斜线双写）', () => {
    const out = ensureKernelDebugPort(VMX_BASE, 'kd_win-kernel');
    expect(out).toBe(
      VMX_BASE +
      'serial0.present = "TRUE"\n' +
      'serial0.fileType = "pipe"\n' +
      'serial0.fileName = "\\\\.\\pipe\\kd_win-kernel"\n' +
      'serial0.startConnected = "TRUE"\n',
    );
  });

  it('幂等：二次调用零变化（重复 up 不叠加）', () => {
    const once = ensureKernelDebugPort(VMX_BASE, 'kd_win-kernel');
    expect(ensureKernelDebugPort(once, 'kd_win-kernel')).toBe(once);
  });

  it('幂等：手写等价配置（无空格形态）也不重复注入', () => {
    const handwritten = VMX_BASE + 'serial0.present="TRUE"\nserial0.fileType="pipe"\nserial0.fileName="\\\\.\\pipe\\kd_win-kernel"\nserial0.startConnected="TRUE"\n';
    expect(ensureKernelDebugPort(handwritten, 'kd_win-kernel')).toBe(handwritten);
  });

  it('已有异名 serial 设备共存：取最小空闲序号（serial0 被占 → serial1）', () => {
    const withSerial0 = VMX_BASE + 'serial0.present = "TRUE"\nserial0.fileType = "file"\nserial0.fileName = "com1.log"\n';
    const out = ensureKernelDebugPort(withSerial0, 'kd_win-kernel');
    expect(out).toContain('serial1.fileName = "\\\\.\\pipe\\kd_win-kernel"');
    expect(out).toContain('serial0.fileName = "com1.log"'); // 原设备不动
  });

  it('present=FALSE 的占位序号视为空闲（复用 serial0）', () => {
    const withFalse = VMX_BASE + 'serial0.present = "FALSE"\nserial0.fileName = "com1.log"\n';
    const out = ensureKernelDebugPort(withFalse, 'kd_x');
    expect(out).toContain('serial0.fileName = "\\\\.\\pipe\\kd_x"');
  });

  it('尾部空白不累积：注入只加一个换行', () => {
    const out = ensureKernelDebugPort(VMX_BASE + '\n\n', 'kd_win-kernel');
    expect(out.endsWith('serial0.startConnected = "TRUE"\n')).toBe(true);
    expect(out).not.toContain('\n\n\n');
  });
});

describe('vmEnvUp debug 注入（win-kernel：revert 后、start 前回写 vmx）', () => {
  const KD_RECIPE: EnvironmentRecipe = {
    ...VM_RECIPE,
    id: 'win-kernel',
    debug: { transport: 'pipe', pipe: 'kd_win-kernel' },
  };

  it('debug 段配方：start 前注入 vmx 并回写文件（get IP 后 vmx 含管道 4 行）', async () => {
    const root = makeTempRoot();
    const vmx = makeVmx(root);
    const { exec } = scriptedExec([
      PROBE_OK,
      ok('Total running VMs: 0\n'),
      ok('Total snapshots: 1\nzhishi-clean\n'),
      ok(), // revert
      ok(), // start
      ok('10.0.0.8\n'),
    ]);
    const result = await vmEnvUp(KD_RECIPE, '/w', { exec, vmBase: vmx });
    expect(result.ok).toBe(true);
    const content = readFileSync(vmx, 'utf-8');
    expect(content).toContain('serial0.fileName = "\\\\.\\pipe\\kd_win-kernel"');
    expect(content).toContain('serial0.fileType = "pipe"');
  });

  it('重复 up 幂等：已在运行列表 → 不 revert 不 start，也不重写 vmx', async () => {
    const root = makeTempRoot();
    const vmx = makeVmx(root);
    const before = readFileSync(vmx, 'utf-8');
    const { exec } = scriptedExec([
      PROBE_OK,
      ok(`Total running VMs: 1\n${vmx}\n`),
      ok('10.0.0.8\n'),
    ]);
    const result = await vmEnvUp(KD_RECIPE, '/w', { exec, vmBase: vmx });
    expect(result.ok).toBe(true);
    // 运行中的 VM 绝不写 vmx（vmware 会忽略/覆盖运行期修改）
    expect(readFileSync(vmx, 'utf-8')).toBe(before);
  });

  it('无 debug 段的配方 → vmx 原样不动', async () => {
    const root = makeTempRoot();
    const vmx = makeVmx(root);
    const { exec } = scriptedExec([
      PROBE_OK,
      ok('Total running VMs: 0\n'),
      ok(), // start
      ok('10.0.0.9\n'),
    ]);
    const result = await vmEnvUp({ ...VM_RECIPE, vmSnapshot: undefined }, '/w', { exec, vmBase: vmx });
    expect(result.ok).toBe(true);
    expect(readFileSync(vmx, 'utf-8')).toBe('.encoding = "UTF-8"\ndisplayName = "ubuntu"\n');
  });
});
