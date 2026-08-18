/**
 * 安全研究员版 P2 V7 — vm-build unit tests.
 *
 * 纯函数全覆盖（SHA256SUMS 解析、autoinstall user-data YAML 形态、
 * meta-data、seed ISO round-trip、模板 vmx 字段集、vdiskmanager 参数）+
 * 编排 scriptedExec 队列（happy path、缓存复用、各失败分支）。ISO/密钥/
 * 配方目录用真临时文件；绝不真调 vmrun/ssh/网络（download 全注入）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { load as yamlLoad } from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';

import { parseIso9660Files } from './iso9660';
import type { EnvironmentRecipe } from './recipes';
import {
  buildAutoinstallMetaData,
  buildAutoinstallUserData,
  buildSeedIso,
  buildTemplateVmx,
  buildVdiskmanagerCreateArgs,
  parseSha256Sums,
  resolveVdiskmanagerBinary,
  UBUNTU_ISO_FILENAME,
  UBUNTU_SHA256SUMS_URL,
  vmTemplateBuild,
  type VmExec,
  type VmExecResult,
} from './vm-build';

function makeRecipe(dir: string): EnvironmentRecipe {
  return {
    id: 'pwn-vm',
    dir,
    name: 'pwn-vm',
    base: 'vm',
    tools: ['gdb'],
    vmUser: 'researcher',
    vmSnapshot: 'zhishi-clean',
    valid: true,
    invalidReasons: [],
  };
}

function ok(stdout = ''): VmExecResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function fail(stderr = ''): VmExecResult {
  return { exitCode: 1, stdout: '', stderr };
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

const tempRoots: string[] = [];
function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'zhishi-build-test-'));
  tempRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

const noopSleep = async () => undefined;

/**
 * 造齐 build 需要的本地件：配方目录（默认带 setup.sh）、本地 OS ISO、
 * 预置密钥对的 keysDir（避免 ensureKeyMaterial 走 ssh-keygen / 真实
 * homedir 密钥的断言分叉）、模板根目录。
 */
function makeFixture(opts: { withSetup?: boolean } = {}) {
  const root = makeTempRoot();
  const recipeDir = join(root, 'recipe');
  mkdirSync(recipeDir, { recursive: true });
  if (opts.withSetup !== false) {
    writeFileSync(join(recipeDir, 'setup.sh'), '#!/bin/sh\necho ok\n');
  }
  const isoPath = join(root, UBUNTU_ISO_FILENAME);
  writeFileSync(isoPath, 'fake-iso-bytes');
  const keysDir = join(root, 'keys');
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(join(keysDir, 'zhishi_vm_ed25519'), 'fake-private-key');
  writeFileSync(join(keysDir, 'zhishi_vm_ed25519.pub'), 'ssh-ed25519 AAAA fake\n');
  const templatesRoot = join(root, 'vm-templates');
  return { root, recipeDir, isoPath, keysDir, templatesRoot };
}

/** happy path 的标准 exec 队列（从 vmware probe 到 snapshot）。 */
function happyQueue(): Array<VmExecResult | ((argv: string[]) => VmExecResult)> {
  return [
    ok('Total running VMs: 0\n'),   // ensureVmwareAvailable probe
    ok(),                            // vdiskmanager create
    ok(),                            // vmrun start
    ok('192.168.126.130\n'),         // getGuestIPAddress
    ok(),                            // ssh probe researcher
    ok(),                            // scp setup.sh
    ok('done\n'),                    // ssh bash setup.sh
    ok(),                            // ssh poweroff
    ok('Total running VMs: 0\n'),    // waitUntilStopped: gone
    ok(),                            // vmrun snapshot
  ];
}

describe('pure: SHA256SUMS / autoinstall / vmx / vdiskmanager', () => {
  it('parseSha256Sums: "*name" 与双空格两种格式都认，未命中 undefined', () => {
    const text = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa *ubuntu-24.04.2-live-server-amd64.iso',
      'BB' + 'b'.repeat(62) + '  ubuntu-24.04.2-desktop-amd64.iso',
    ].join('\n');
    expect(parseSha256Sums(text, 'ubuntu-24.04.2-live-server-amd64.iso')).toBe('a'.repeat(64));
    expect(parseSha256Sums(text, 'ubuntu-24.04.2-desktop-amd64.iso')).toBe('bb' + 'b'.repeat(62));
    expect(parseSha256Sums(text, 'nope.iso')).toBeUndefined();
  });

  it('buildAutoinstallUserData: version 1 / 锁密码 / NOPASSWD sudo / 公钥 / 包清单', () => {
    const text = buildAutoinstallUserData({ hostname: 'zhishi-pwn-vm', pubkey: 'ssh-ed25519 AAAA fake' });
    expect(text.startsWith('#cloud-config\n')).toBe(true);
    const parsed = yamlLoad(text.slice('#cloud-config\n'.length)) as {
      autoinstall: {
        version: number;
        identity: { hostname: string; username: string; password: string; sudo: string };
        ssh: { 'install-server': boolean; 'authorized-keys': string[] };
        packages: string[];
      };
    };
    expect(parsed.autoinstall.version).toBe(1);
    expect(parsed.autoinstall.identity).toEqual({
      hostname: 'zhishi-pwn-vm',
      username: 'researcher',
      password: '*',
      sudo: 'ALL=(ALL) NOPASSWD:ALL',
    });
    expect(parsed.autoinstall.ssh['install-server']).toBe(true);
    expect(parsed.autoinstall.ssh['authorized-keys']).toEqual(['ssh-ed25519 AAAA fake']);
    expect(parsed.autoinstall.packages).toEqual(['openssh-server', 'open-vm-tools']);
  });

  it('buildAutoinstallMetaData: instance-id 行', () => {
    expect(buildAutoinstallMetaData({ instanceId: 'ab12cd' })).toBe('instance-id: ab12cd\n');
  });

  it('buildSeedIso: cidata 卷标，Joliet 树读回 user-data/meta-data', () => {
    const iso = buildSeedIso({ hostname: 'zhishi-pwn-vm', pubkey: 'ssh-ed25519 AAAA', instanceId: 'ab12' });
    expect(iso.toString('ascii', 16 * 2048 + 32, 16 * 2048 + 64).trim()).toBe('CIDATA');
    expect(parseIso9660Files(iso)).toEqual(['user-data', 'meta-data']);
  });

  it('buildTemplateVmx: 迷你实物字段集 + 双 CD-ROM + cdrom 引导', () => {
    const vmx = buildTemplateVmx({
      name: 'zhishi-pwn-vm-template',
      diskFile: 'disk.vmdk',
      osIsoPath: 'D:\\iso\\ubuntu.iso',
      seedIsoPath: 'D:\\t\\pwn-vm\\seed.iso',
      memMb: 4096,
      cpus: 4,
    });
    // 实测可启动字段集（缺了会「无法读取虚拟机的配置文件」）
    for (const line of [
      '.encoding = "UTF-8"',
      'config.version = "8"',
      'virtualHW.version = "21"',
      'firmware = "bios"',
      'powerType.powerOff = "soft"',
      'scsi0.virtualDev = "lsilogic"',
      'ethernet0.virtualDev = "e1000e"',
      'pciBridge7.functions = "8"',
      'vmci0.present = "TRUE"',
      'hpet0.present = "TRUE"',
    ]) {
      expect(vmx).toContain(line);
    }
    expect(vmx).toContain('displayName = "zhishi-pwn-vm-template"');
    expect(vmx).toContain('guestOS = "ubuntu-64"');
    expect(vmx).toContain('memsize = "4096"');
    expect(vmx).toContain('numvcpus = "4"');
    expect(vmx).toContain('scsi0:0.fileName = "disk.vmdk"');
    expect(vmx).toContain('sata0:0.fileName = "D:\\iso\\ubuntu.iso"');
    expect(vmx).toContain('sata0:0.deviceType = "cdrom-image"');
    expect(vmx).toContain('sata0:1.fileName = "D:\\t\\pwn-vm\\seed.iso"');
    expect(vmx).toContain('sata0:1.deviceType = "cdrom-image"');
    expect(vmx).toContain('bios.bootOrder = "cdrom,hdd"');
  });

  it('buildVdiskmanagerCreateArgs: -c -s NGB -t 0 -a lsilogic', () => {
    expect(buildVdiskmanagerCreateArgs('/t/disk.vmdk', 40)).toEqual([
      '-c', '-s', '40GB', '-t', '0', '-a', 'lsilogic', '/t/disk.vmdk',
    ]);
  });

  it('resolveVdiskmanagerBinary: 落在 vmware-vdiskmanager 上', () => {
    expect(resolveVdiskmanagerBinary()).toContain('vmware-vdiskmanager');
  });
});

describe('vmTemplateBuild orchestration', () => {
  it('happy path: probe → vdisk → start → getIP → ssh probe → scp → setup → poweroff → list 消失 → snapshot', async () => {
    const { recipeDir, isoPath, keysDir, templatesRoot } = makeFixture();
    const vmx = join(templatesRoot, 'pwn-vm', 'pwn-vm.vmx');
    const { exec, calls } = scriptedExec(happyQueue());
    const result = await vmTemplateBuild(
      makeRecipe(recipeDir),
      { isoPath },
      { exec, keysDir, templatesRoot, sleep: noopSleep },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.address).toBe('192.168.126.130');
    expect(result.template.vmx).toBe(vmx);
    expect(result.template.user).toBe('researcher');
    expect(result.template.snapshot).toBe('zhishi-clean');
    expect(result.template.keyPath.length).toBeGreaterThan(0);

    // vdiskmanager 建盘参数
    const vdCall = calls.find((c) => c.some((a) => a.includes('vmware-vdiskmanager')));
    expect(vdCall?.slice(1)).toEqual(['-c', '-s', '40GB', '-t', '0', '-a', 'lsilogic', join(templatesRoot, 'pwn-vm', 'disk.vmdk')]);
    // 快照打在模板 vmx 上
    const snapCall = calls.find((c) => c.includes('snapshot'));
    expect(snapCall).toEqual(['vmrun', '-T', 'ws', 'snapshot', vmx, 'zhishi-clean']);

    // 落盘实物：seed.iso（cidata + Joliet 真名）与 vmx（双 CD-ROM）
    const seedIso = readFileSync(join(templatesRoot, 'pwn-vm', 'seed.iso'));
    expect(parseIso9660Files(seedIso)).toEqual(['user-data', 'meta-data']);
    const vmxText = readFileSync(vmx, 'utf-8');
    expect(vmxText).toContain(`sata0:0.fileName = "${isoPath}"`);
    expect(vmxText).toContain('bios.bootOrder = "cdrom,hdd"');
  });

  it('ISO 缓存复用：SHA256SUMS 校验通过则不重下 ISO', async () => {
    const { root, recipeDir, keysDir, templatesRoot } = makeFixture();
    const isoCacheDir = join(root, 'iso-cache');
    mkdirSync(isoCacheDir, { recursive: true });
    const cachedIso = join(isoCacheDir, UBUNTU_ISO_FILENAME);
    writeFileSync(cachedIso, 'cached-iso-bytes');
    const cachedHash = createHash('sha256').update('cached-iso-bytes').digest('hex');

    const downloaded: string[] = [];
    const download = async (url: string, destPath: string) => {
      downloaded.push(url);
      mkdirSync(join(destPath, '..'), { recursive: true });
      writeFileSync(destPath, `${cachedHash} *${UBUNTU_ISO_FILENAME}\n`);
    };

    const { exec } = scriptedExec(happyQueue());
    const result = await vmTemplateBuild(
      makeRecipe(recipeDir),
      {},
      { exec, download, keysDir, templatesRoot, isoCacheDir, sleep: noopSleep },
    );
    expect(result.ok).toBe(true);
    expect(downloaded).toEqual([UBUNTU_SHA256SUMS_URL]); // 只拉了 SUMS，ISO 复用缓存
  });

  it('ISO 哈希不匹配：下载后校验不过即删，报清晰错误', async () => {
    const { root, recipeDir, keysDir, templatesRoot } = makeFixture();
    const isoCacheDir = join(root, 'iso-cache');
    const isoDest = join(isoCacheDir, UBUNTU_ISO_FILENAME);
    const download = async (url: string, destPath: string) => {
      mkdirSync(isoCacheDir, { recursive: true });
      if (url.endsWith('SHA256SUMS')) {
        writeFileSync(destPath, `${'f'.repeat(64)} *${UBUNTU_ISO_FILENAME}\n`);
      } else {
        writeFileSync(destPath, 'tampered-iso');
      }
    };
    const { exec } = scriptedExec([ok('Total running VMs: 0\n')]);
    const result = await vmTemplateBuild(
      makeRecipe(recipeDir),
      {},
      { exec, download, keysDir, templatesRoot, isoCacheDir, sleep: noopSleep },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('SHA256 校验不过');
    expect(existsSync(isoDest)).toBe(false); // 不过即删
  });

  it('start 失败重试一次即成功（实测挂起态残留首发未知错误）', async () => {
    const { recipeDir, isoPath, keysDir, templatesRoot } = makeFixture();
    const { exec, calls } = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok(),                    // vdiskmanager
      fail('Error: 未知错误'), // start 第一次失败
      ok(),                    // start 重试成功
      ok('10.0.0.8\n'),
      ok(), ok(), ok('done\n'), ok(),
      ok('Total running VMs: 0\n'),
      ok(),
    ]);
    const result = await vmTemplateBuild(
      makeRecipe(recipeDir),
      { isoPath },
      { exec, keysDir, templatesRoot, sleep: noopSleep },
    );
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.includes('start')).length).toBe(2);
  });

  it('start 重试仍失败 → 报错', async () => {
    const { recipeDir, isoPath, keysDir, templatesRoot } = makeFixture();
    const { exec } = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok(),
      fail('Error: 未知错误'),
      fail('Error: 未知错误'),
    ]);
    const result = await vmTemplateBuild(
      makeRecipe(recipeDir),
      { isoPath },
      { exec, keysDir, templatesRoot, sleep: noopSleep },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('vmrun start 失败');
  });

  it('安装等待超时 → 错误提示看控制台 + 可 adopt 接管', async () => {
    const { recipeDir, isoPath, keysDir, templatesRoot } = makeFixture();
    let tick = 0;
    const now = () => (tick += 46 * 60_000); // 每看一次钟走 46 分钟 → 一轮即超时
    const { exec } = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok(),                          // vdiskmanager
      ok(),                          // start
      fail('Error: VMware Tools is not running'), // getIP: Tools 还没起
    ]);
    const result = await vmTemplateBuild(
      makeRecipe(recipeDir),
      { isoPath },
      { exec, now, keysDir, templatesRoot, sleep: noopSleep },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('超时');
      expect(result.error).toContain('控制台');
      expect(result.error).toContain('adopt');
    }
  });

  it('setup.sh 失败 → 报 guest 执行失败', async () => {
    const { recipeDir, isoPath, keysDir, templatesRoot } = makeFixture();
    const { exec } = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok(), ok(), ok('10.0.0.8\n'), ok(),
      ok(),                          // scp
      fail('apt: command not found'),// setup.sh
    ]);
    const result = await vmTemplateBuild(
      makeRecipe(recipeDir),
      { isoPath },
      { exec, keysDir, templatesRoot, sleep: noopSleep },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('setup.sh');
  });

  it('配方无 setup.sh → 跳过 scp/ssh exec，直接定型', async () => {
    const { recipeDir, isoPath, keysDir, templatesRoot } = makeFixture({ withSetup: false });
    const { exec, calls } = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok(), ok(), ok('10.0.0.8\n'), ok(),
      ok(),                          // poweroff
      ok('Total running VMs: 0\n'),
      ok(),                          // snapshot
    ]);
    const result = await vmTemplateBuild(
      makeRecipe(recipeDir),
      { isoPath },
      { exec, keysDir, templatesRoot, sleep: noopSleep },
    );
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c[0] === 'scp')).toBe(false);
  });

  it('快照失败 → 报错（VM 已关机）', async () => {
    const { recipeDir, isoPath, keysDir, templatesRoot } = makeFixture();
    const { exec } = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok(), ok(), ok('10.0.0.8\n'), ok(), ok(), ok('done\n'), ok(),
      ok('Total running VMs: 0\n'),
      fail('Error: snapshot failed'),
    ]);
    const result = await vmTemplateBuild(
      makeRecipe(recipeDir),
      { isoPath },
      { exec, keysDir, templatesRoot, sleep: noopSleep },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('快照');
  });

  it('拒绝：非 vm 配方 / 指定 ISO 不存在 / 模板已存在', async () => {
    const { root, recipeDir, isoPath, keysDir, templatesRoot } = makeFixture();
    const dockerRecipe = { ...makeRecipe(recipeDir), base: 'docker' as const };
    const r1 = await vmTemplateBuild(dockerRecipe, { isoPath }, { exec: scriptedExec([]).exec, keysDir, templatesRoot });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toContain('不是 VM 配方');

    const r2 = await vmTemplateBuild(
      makeRecipe(recipeDir),
      { isoPath: join(root, 'ghost.iso') },
      { exec: scriptedExec([ok('Total running VMs: 0\n')]).exec, keysDir, templatesRoot },
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toContain('ISO 不存在');

    // 模板目录里已有同名 vmx → 冲突报错（先造一个）
    mkdirSync(join(templatesRoot, 'pwn-vm'), { recursive: true });
    writeFileSync(join(templatesRoot, 'pwn-vm', 'pwn-vm.vmx'), 'displayName = "old"\n');
    const r3 = await vmTemplateBuild(
      makeRecipe(recipeDir),
      { isoPath },
      { exec: scriptedExec([ok('Total running VMs: 0\n')]).exec, keysDir, templatesRoot },
    );
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error).toContain('模板已存在');
  });
});
