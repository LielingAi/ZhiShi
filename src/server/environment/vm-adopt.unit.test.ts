/**
 * 安全研究员版 P2 V6 — 模板认领（vm-adopt）unit tests.
 *
 * 全部通过注入的 exec 断言命令组装与流程编排,绝不真调 vmrun/ssh/plink。
 * vmx / 密钥 / setup.sh 用真临时文件。覆盖:MAC/租约解析、ssh/scp/plink
 * 参数组装、provision 脚本（有无 sudo 密码）、happy path（key / password
 * 两通道）、以及各失败路径（非 vm 配方、无地址、无认证手段、plink 缺失、
 * provision 失败、快照失败）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { EnvironmentRecipe } from './recipes';
import {
  buildPlinkArgs,
  buildPlinkVerifyArgs,
  buildProvisionScript,
  buildScpArgs,
  buildSshExecArgs,
  buildSshProbeArgs,
  classifySshProbeFailure,
  defaultLeasePaths,
  ensurePlinkAvailable,
  hostKeyFingerprintFromKeyscan,
  parseDhcpLeases,
  parsePlinkSignature,
  parseVmxMac,
  vmTemplateAdopt,
  type VmExec,
  type VmExecResult,
} from './vm-adopt';

const RECIPE_DIR_SETUP = { 'setup.sh': '#!/bin/sh\necho ok\n' };

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
  const root = mkdtempSync(join(tmpdir(), 'zhishi-adopt-test-'));
  tempRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** 造齐 adopt 需要的本地文件：vmx / 私钥+公钥 / 配方目录（带 setup.sh）。 */
function makeFixture() {
  const root = makeTempRoot();
  const vmx = join(root, 'win-or-linux.vmx');
  writeFileSync(vmx, 'displayName = "mine"\nethernet0.generatedAddress = "00:0c:29:ab:cd:ef"\n');
  const keyPath = join(root, 'id_ed25519');
  writeFileSync(keyPath, 'fake-private-key');
  writeFileSync(`${keyPath}.pub`, 'ssh-ed25519 AAAA fake\n');
  const recipeDir = join(root, 'recipe');
  rmSync(recipeDir, { recursive: true, force: true });
  writeFileSync(join(root, 'dummy'), ''); // ensure root exists
  mkdirSync(recipeDir, { recursive: true });
  writeFileSync(join(recipeDir, 'setup.sh'), RECIPE_DIR_SETUP['setup.sh']);
  return { root, vmx, keyPath, recipeDir };
}

describe('parsing (pure)', () => {
  it('parseVmxMac: reads ethernet0 generatedAddress / address, lowercased', () => {
    expect(parseVmxMac('ethernet0.generatedAddress = "00:0C:29:AB:CD:EF"\n')).toBe('00:0c:29:ab:cd:ef');
    expect(parseVmxMac('ethernet0.address = "00:50:56:01:02:03"\n')).toBe('00:50:56:01:02:03');
    expect(parseVmxMac('displayName = "x"\n')).toBeUndefined();
  });

  it('parseDhcpLeases: mac→ip map, later lease wins', () => {
    const content = [
      'lease 192.168.126.100 {',
      '  hardware ethernet 00:0c:29:ab:cd:ef;',
      '}',
      'lease 192.168.126.130 {',
      '  hardware ethernet 00:0C:29:AB:CD:EF;',
      '}',
      'lease 192.168.126.99 {',
      '  starts 4 2026/08/15 01:00:00;',
      '}',
    ].join('\n');
    const map = parseDhcpLeases(content);
    expect(map.get('00:0c:29:ab:cd:ef')).toBe('192.168.126.130');
    expect(map.size).toBe(1);
  });

  it('defaultLeasePaths: non-empty on any platform', () => {
    expect(defaultLeasePaths().length).toBeGreaterThan(0);
  });
});

describe('command assembly (pure)', () => {
  it('ssh probe: BatchMode + accept-new + optional -i, runs true', () => {
    expect(buildSshProbeArgs({ user: 'u', address: '10.0.0.8' })).toEqual([
      'ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10',
      'u@10.0.0.8', 'true',
    ]);
    expect(buildSshProbeArgs({ user: 'u', address: '10.0.0.8', keyPath: '/k/id' })).toContain('/k/id');
  });

  it('ssh exec / scp assemble target and payload', () => {
    const execArgs = buildSshExecArgs({ user: 'u', address: '10.0.0.8', keyPath: '/k' }, 'echo hi');
    expect(execArgs.slice(-2)).toEqual(['u@10.0.0.8', 'echo hi']);
    const scpArgs = buildScpArgs('/local/setup.sh', { user: 'u', address: '10.0.0.8', keyPath: '/k' }, '/tmp/s.sh');
    expect(scpArgs[0]).toBe('scp');
    expect(scpArgs.slice(-2)).toEqual(['/local/setup.sh', 'u@10.0.0.8:/tmp/s.sh']);
  });

  it('plink: -batch + -pw + command, password only in argv (never files)', () => {
    expect(buildPlinkArgs('plink', 'u', '10.0.0.8', 'p@ss', 'true')).toEqual([
      'plink', '-batch', '-ssh', '-pw', 'p@ss', 'u@10.0.0.8', 'true',
    ]);
  });

  it('plink: -hostkey pinned per fingerprint (repeated flags; csv only honors the first on plink 0.84)', () => {
    expect(buildPlinkArgs('plink', 'u', '10.0.0.8', 'p@ss', 'true', ['SHA256:abc', 'SHA256:def'])).toEqual([
      'plink', '-batch', '-ssh', '-pw', 'p@ss', '-hostkey', 'SHA256:abc', '-hostkey', 'SHA256:def', 'u@10.0.0.8', 'true',
    ]);
  });

  it('hostKeyFingerprintFromKeyscan: sha256 of key blob, comments/垃圾行跳过', () => {
    // 实锚：fuzz VM 的 ed25519 host key（plink/OpenSSH 双侧核对的真指纹）
    const line = '192.168.152.129 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHFqDc+BfdpW53W8tieAWOqQ+vZtwCDVSzb+4cMfQ1bx';
    expect(hostKeyFingerprintFromKeyscan(line)).toBe('SHA256:gecctsRNwUjKdoazxwz2UHk13w0KHDhO13qMdQS2ao8');
    expect(hostKeyFingerprintFromKeyscan('# 192.168.152.129:22 SSH-2.0-OpenSSH_9.6p1')).toBeUndefined();
    expect(hostKeyFingerprintFromKeyscan('')).toBeUndefined();
    expect(hostKeyFingerprintFromKeyscan('host ssh-ed25519')).toBeUndefined();
  });

  it('classifySshProbeFailure: transport vs auth vs unknown', () => {
    expect(classifySshProbeFailure(fail('kex_exchange_identification: read: Connection reset by peer'))).toBe('transport');
    expect(classifySshProbeFailure(fail('ssh: connect to host 10.0.0.8 port 22: Connection refused'))).toBe('transport');
    expect(classifySshProbeFailure(fail('Permission denied (publickey)'))).toBe('auth');
    expect(classifySshProbeFailure(fail('something odd'))).toBe('unknown');
  });

  it('plink signature parse: Valid + Simon Tatham only', () => {
    expect(parsePlinkSignature('Valid|CN=Simon Tatham, O=Simon Tatham, L=Cambridge')).toBe(true);
    expect(parsePlinkSignature('NotSigned|')).toBe(false);
    expect(parsePlinkSignature('Valid|CN=Someone Else')).toBe(false);
  });

  it('plink verify args: powershell Get-AuthenticodeSignature with escaped path', () => {
    const args = buildPlinkVerifyArgs("C:\\x\\it's\\plink.exe");
    expect(args[0]).toBe('powershell');
    expect(args[3]).toContain("it''s");
    expect(args[3]).toContain('Get-AuthenticodeSignature');
  });

  it('provision script: apt guard + researcher + pubkey; sudo -n without password', () => {
    const script = buildProvisionScript({ pubkey: 'ssh-ed25519 AAAA' });
    expect(script).toContain('apt-get');
    expect(script).toContain('useradd -m -s /bin/bash researcher');
    expect(script).toContain(`usermod -p '*' researcher`); // 解锁账号（'!' 锁定态 sshd 拒一切登录）
    expect(script).toContain('ssh-ed25519 AAAA');
    expect(script).toContain('sudo -n');
    expect(script).toContain('PROVISION_OK');
  });

  it('provision script with sudo password: prime once with sudo -S, data pipes use sudo -n', () => {
    const script = buildProvisionScript({ sudoPassword: "it's", pubkey: 'k' });
    // 密码只在 prime 步出现一次
    expect(script).toContain(`echo 'it'\\''s' | sudo -S true`);
    // 数据管道（tee）必须走 sudo -n——echo 不转发 stdin，数据过 sudo -S 会丢
    expect(script).toContain('| sudo -n tee');
    expect(script).not.toContain(`| echo 'it'\\''s' | sudo -S tee`);
  });
});

describe('ensurePlinkAvailable（自动下载 + Authenticode 验证）', () => {
  it('already resolved (PATH / own bin) → no download', async () => {
    const { exec } = scriptedExec([]);
    let downloaded = false;
    const result = await ensurePlinkAvailable(exec, async () => { downloaded = true; }, 'C:\\tools\\plink.exe');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe('C:\\tools\\plink.exe');
    expect(downloaded).toBe(false);
  });

  it('missing → downloads official plink and verifies signature', async () => {
    const { exec, calls } = scriptedExec([
      ok('Valid|CN=Simon Tatham, O=Simon Tatham\n'), // Authenticode verify
    ]);
    let downloadUrl = '';
    const dest = join(makeTempRoot(), 'plink.exe');
    const result = await ensurePlinkAvailable(exec, async (url) => { downloadUrl = url; }, 'plink', dest);
    expect(result.ok).toBe(true);
    expect(downloadUrl).toContain('the.earth.li');
    expect(calls[0][0]).toBe('powershell');
  });

  it('bad signature → error, file deleted', async () => {
    const { exec } = scriptedExec([
      ok('NotSigned|\n'),
    ]);
    // 落点必须临时路径——签名失败分支 rmSync(dest)，默认路径会删真 plink
    const dest = join(makeTempRoot(), 'plink.exe');
    const result = await ensurePlinkAvailable(exec, async () => undefined, 'plink', dest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('签名验证失败');
  });

  it('download failure → manual install guidance', async () => {
    const { exec } = scriptedExec([]);
    const result = await ensurePlinkAvailable(exec, async () => { throw new Error('HTTP 403'); }, 'plink');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('自动下载失败');
  });
});

describe('vmTemplateAdopt orchestration', () => {
  it('happy path via password channel: start skip → ip → plink → provision → setup → poweroff → snapshot', async () => {
    const { vmx, keyPath, recipeDir } = makeFixture();
    const { exec, calls } = scriptedExec([
      ok('Total running VMs: 0\n'),                    // ensureVmwareAvailable probe (vmrun list)
      ok(`Total running VMs: 1\n${vmx}\n`),            // running check → already running, skip start
      ok('192.168.126.130\n'),                          // getGuestIPAddress
      fail('Permission denied (publickey)'),            // ssh key probe as researcher fails
      ok('10.0.0.8 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHFqDc+BfdpW53W8tieAWOqQ+vZtwCDVSzb+4cMfQ1bx\n'), // ssh-keyscan（-hostkey 钉指纹）
      ok(),                                             // plink true (password works)
      ok('PROVISION_OK\n'),                             // provision via plink
      ok(),                                             // ssh probe researcher with key
      ok(),                                             // scp setup.sh
      ok('ready\n'),                                    // ssh bash setup.sh
      ok('OK:gdb\n'),                                   // ssh 配方工具自检（1.2.5「配」）
      ok(),                                             // ssh poweroff (断开也算)
      ok('Total running VMs: 0\n'),                     // waitUntilStopped: gone
      ok(),                                             // vmrun snapshot
    ]);
    const result = await vmTemplateAdopt(
      makeRecipe(recipeDir),
      { vmx, keyPath, password: 'pw123' },
      { exec, plinkPath: 'plink' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.channel).toBe('password');
    expect(result.address).toBe('192.168.126.130');
    expect(result.template).toEqual({
      vmx,
      user: 'researcher',
      keyPath,
      snapshot: 'zhishi-clean',
    });
    // 快照命令确实打在模板 vmx 上
    const snapCall = calls.find((c) => c.includes('snapshot'));
    expect(snapCall).toEqual(['vmrun', '-T', 'ws', 'snapshot', vmx, 'zhishi-clean']);
    // 密码通道的 plink 调用必须带 -hostkey 钉指纹（batch 模式无缓存可用）
    const plinkCall = calls.find((c) => c[0] === 'plink');
    expect(plinkCall).toContain('-hostkey');
    expect(plinkCall?.[plinkCall.indexOf('-hostkey') + 1]).toBe('SHA256:gecctsRNwUjKdoazxwz2UHk13w0KHDhO13qMdQS2ao8');
  });

  it('happy path via key channel: no plink, sudo -n provision', async () => {
    const { vmx, keyPath, recipeDir } = makeFixture();
    const { exec, calls } = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok(`Total running VMs: 1\n${vmx}\n`),
      ok('10.0.0.8\n'),
      ok(),                  // ssh key probe succeeds immediately
      ok('PROVISION_OK\n'),  // provision via ssh
      ok(),                  // researcher probe
      ok(),                  // scp
      ok(),                  // setup.sh
      ok('OK:gdb\n'),        // 配方工具自检（1.2.5「配」）
      ok(),                  // poweroff
      ok('Total running VMs: 0\n'),
      ok(),                  // snapshot
    ]);
    const result = await vmTemplateAdopt(makeRecipe(recipeDir), { vmx, keyPath }, { exec });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.channel).toBe('key');
    expect(calls.some((c) => c[0] === 'plink')).toBe(false);
    const provisionCall = calls.find((c) => c[0] === 'ssh' && c.some((a) => a.includes('PROVISION_OK')));
    expect(provisionCall?.some((a) => a.includes('sudo -n'))).toBe(true);
  });

  it('not running → starts the VM first', async () => {
    const { vmx, keyPath, recipeDir } = makeFixture();
    const { exec, calls } = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok('Total running VMs: 0\n'),   // running check: not running
      ok(),                            // vmrun start
      ok('10.0.0.9\n'),
      ok(), ok('PROVISION_OK\n'), ok(), ok(), ok(), ok('OK:gdb\n'), ok(),
      ok('Total running VMs: 0\n'),
      ok(),
    ]);
    const result = await vmTemplateAdopt(makeRecipe(recipeDir), { vmx, keyPath }, { exec });
    expect(result.ok).toBe(true);
    const startCall = calls.find((c) => c.includes('start'));
    expect(startCall).toEqual(['vmrun', '-T', 'ws', 'start', vmx, 'nogui']);
  });

  it('DHCP leases fallback when getGuestIPAddress fails', async () => {
    const { root, vmx, keyPath, recipeDir } = makeFixture();
    const leases = join(root, 'vmnetdhcp.leases');
    writeFileSync(leases, 'lease 192.168.126.200 {\n  hardware ethernet 00:0c:29:ab:cd:ef;\n}\n');
    const { exec } = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok(`Total running VMs: 1\n${vmx}\n`),
      fail('Error: VMware Tools not running'),  // getGuestIPAddress fails
      ok(), ok('PROVISION_OK\n'), ok(), ok(), ok(), ok('OK:gdb\n'), ok(),
      ok('Total running VMs: 0\n'),
      ok(),
    ]);
    const result = await vmTemplateAdopt(makeRecipe(recipeDir), { vmx, keyPath }, { exec, leasePaths: [leases] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.address).toBe('192.168.126.200');
  });

  it('rejects: non-vm recipe / missing vmx / wrong extension', async () => {
    const { vmx, keyPath, recipeDir } = makeFixture();
    const dockerRecipe = { ...makeRecipe(recipeDir), base: 'docker' as const };
    const r1 = await vmTemplateAdopt(dockerRecipe, { vmx, keyPath }, { exec: scriptedExec([]).exec });
    expect(r1.ok).toBe(false);

    const r2 = await vmTemplateAdopt(makeRecipe(recipeDir), { vmx: join(makeTempRoot(), 'ghost.vmx'), keyPath }, { exec: scriptedExec([]).exec });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toContain('VM 不存在');

    const r3 = await vmTemplateAdopt(makeRecipe(recipeDir), { vmx: vmx.replace('.vmx', '.vmdk'), keyPath }, { exec: scriptedExec([]).exec });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error).toContain('.vmx');
  });

  it('no address via either channel → actionable error', async () => {
    const { vmx, keyPath, recipeDir } = makeFixture();
    const { exec } = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok(`Total running VMs: 1\n${vmx}\n`),
      fail('Tools not running'),
      // DHCP 兜底:租约文件里没有这个 MAC → undefined
    ]);
    const result = await vmTemplateAdopt(
      makeRecipe(recipeDir),
      { vmx, keyPath },
      { exec, leasePaths: [], readFile: undefined },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('拿不到 guest 地址');
  });

  it('key auth fails and no password → error telling user to re-run with password', async () => {
    const { vmx, keyPath, recipeDir } = makeFixture();
    const { exec } = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok(`Total running VMs: 1\n${vmx}\n`),
      ok('10.0.0.8\n'),
      fail('Permission denied'),
    ]);
    const result = await vmTemplateAdopt(makeRecipe(recipeDir), { vmx, keyPath }, { exec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('公钥登录不通');
  });

  it('transport-level failure (kex reset) → sshd 修复指引,不进入密码通道', async () => {
    const { vmx, keyPath, recipeDir } = makeFixture();
    const { exec, calls } = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok(`Total running VMs: 1\n${vmx}\n`),
      ok('10.0.0.8\n'),
      fail('kex_exchange_identification: read: Connection reset by peer'),
    ]);
    // 即使带了密码也不应走到 plink——kex 都过不去,密码没有意义
    const result = await vmTemplateAdopt(makeRecipe(recipeDir), { vmx, keyPath, password: 'pw' }, { exec });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('SSH 服务异常');
      expect(result.error).toContain('ssh-keygen -A');
    }
    expect(calls.some((c) => c[0] === 'plink' || c[0].includes('plink'))).toBe(false);
  });

  it('provision failure (no sudo) → clear hint', async () => {
    const { vmx, keyPath, recipeDir } = makeFixture();
    const { exec } = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok(`Total running VMs: 1\n${vmx}\n`),
      ok('10.0.0.8\n'),
      ok(),  // key channel
      fail('NO_SUDO: 当前用户无 sudo 权限或密码不对'),
    ]);
    const result = await vmTemplateAdopt(makeRecipe(recipeDir), { vmx, keyPath }, { exec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('sudo');
  });

  it('snapshot failure → error after clean shutdown', async () => {
    const { vmx, keyPath, recipeDir } = makeFixture();
    const { exec } = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok(`Total running VMs: 1\n${vmx}\n`),
      ok('10.0.0.8\n'),
      ok(), ok('PROVISION_OK\n'), ok(), ok(), ok(), ok('OK:gdb\n'), ok(),
      ok('Total running VMs: 0\n'),
      fail('Error: snapshot failed'),
    ]);
    const result = await vmTemplateAdopt(makeRecipe(recipeDir), { vmx, keyPath }, { exec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('快照');
  });
});

describe('配方工具自检挂点（1.2.5「配」——快照之前）', () => {
  it('自检缺工具 → 报错、不做快照（坏现场不固化成模板）', async () => {
    const { vmx, keyPath, recipeDir } = makeFixture();
    const { exec, calls } = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok(`Total running VMs: 1\n${vmx}\n`),
      ok('10.0.0.8\n'),
      ok(), ok('PROVISION_OK\n'), ok(), ok(), ok(),
      ok('MISS:gdb\n'),              // 配方工具自检：声明了但 guest 里没有
    ]);
    const result = await vmTemplateAdopt(makeRecipe(recipeDir), { vmx, keyPath }, { exec });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('工具自检未过');
      expect(result.error).toContain('gdb');
    }
    expect(calls.some((c) => c.includes('snapshot'))).toBe(false);
    expect(calls.some((c) => c.some((a) => a.includes('poweroff')))).toBe(false);
  });

  it('自检通道失败（ssh 非零退出）→ 报错、不做快照', async () => {
    const { vmx, keyPath, recipeDir } = makeFixture();
    const { exec, calls } = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok(`Total running VMs: 1\n${vmx}\n`),
      ok('10.0.0.8\n'),
      ok(), ok('PROVISION_OK\n'), ok(), ok(), ok(),
      fail('Connection reset'),      // 自检 ssh 调用本身挂了
    ]);
    const result = await vmTemplateAdopt(makeRecipe(recipeDir), { vmx, keyPath }, { exec });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('自检通道失败');
    expect(calls.some((c) => c.includes('snapshot'))).toBe(false);
  });

  it('配方 tools 为空 → 跳过自检（不多一次 ssh 调用，老队列原样通过）', async () => {
    const { vmx, keyPath, recipeDir } = makeFixture();
    const { exec, calls } = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok(`Total running VMs: 1\n${vmx}\n`),
      ok('10.0.0.8\n'),
      ok(), ok('PROVISION_OK\n'), ok(), ok(), ok(),
      ok(),                          // poweroff（自检无调用，直接定型）
      ok('Total running VMs: 0\n'),
      ok(),                          // snapshot
    ]);
    const result = await vmTemplateAdopt(
      { ...makeRecipe(recipeDir), tools: [] },
      { vmx, keyPath },
      { exec },
    );
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.includes('snapshot'))).toBe(true);
  });
});
