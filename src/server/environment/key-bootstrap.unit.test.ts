/**
 * 1.6.5 — 密钥引导（key-bootstrap）unit tests。
 *
 * 全部通过注入的 exec 断言命令组装与流程编排，绝不真碰 plink/vmrun/
 * ssh-keyscan。密钥材料用真临时文件（fixture keyPath + .pub，隔离宿主机
 * ~/.ssh——ensureKeyMaterial 的候选探测会读真 home）。覆盖：linux/windows
 * 推送脚本组装、plink 端口旗标、plink 通道 happy/fail、断网 Windows VM 的
 * vmrun 通道 happy/fail、断网 linux VM 的 adopt 指引、参数守卫。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  bootstrapKeyForTarget,
  buildLinuxKeyPushCommand,
  buildPlinkArgsWithPort,
  buildWindowsKeyPushScript,
  WIN_KEYPUSH_CODE,
  type KeyBootstrapTarget,
} from './key-bootstrap';
import type { VmExec, VmExecResult } from './vm-adopt';

const VMX = 'C:\\VMs\\win10\\win10.vmx';

const tempRoots: string[] = [];
function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'zhishi-keyboot-test-'));
  tempRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** fixture 密钥对（确保 ensureKeyMaterial 不碰宿主机 ~/.ssh 也不调 keygen）。 */
function makeKeys() {
  const keysDir = makeTempRoot();
  const keyPath = join(keysDir, 'id_ed25519');
  writeFileSync(keyPath, 'fake-private');
  writeFileSync(`${keyPath}.pub`, 'ssh-ed25519 AAAA boot\n');
  return { keysDir, keyPath };
}

function ok(stdout = ''): VmExecResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function fail(stderr = ''): VmExecResult {
  return { exitCode: 1, stdout: '', stderr };
}

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

describe('推送脚本组装（纯函数）', () => {
  it('linux：建 .ssh + 幂等追加 + 权限钉 + OK 标记', () => {
    const cmd = buildLinuxKeyPushCommand('ssh-ed25519 AAAA boot');
    expect(cmd).toContain('mkdir -p ~/.ssh');
    expect(cmd).toContain("grep -qF 'ssh-ed25519 AAAA boot'");
    expect(cmd).toContain('chmod 600 ~/.ssh/authorized_keys');
    expect(cmd).toContain('KEY_BOOTSTRAP_OK');
  });

  it('windows：管理员 SID 判定 + 双落点 + icacls；无文件参数时不写 code', () => {
    const script = buildWindowsKeyPushScript('ssh-ed25519 AAAA boot');
    expect(script).toContain('S-1-5-32-544');
    expect(script).toContain('administrators_authorized_keys');
    expect(script).toContain('icacls');
    expect(script).toContain('KEY_BOOTSTRAP_OK');
    expect(script).not.toContain('WriteAllText');
    // 单引号转义（pubkey 含引号的防御）
    const quoted = buildWindowsKeyPushScript("ssh-ed25519 AA'AA");
    expect(quoted).toContain("AA''AA");
  });

  it('windows 带 code/log 文件参数 → 写 0/1 + Log 行（vmrun 通道核对用）', () => {
    const script = buildWindowsKeyPushScript('k', { codeFile: WIN_KEYPUSH_CODE, logFile: 'C:\\Windows\\Temp\\kp.log' });
    expect(script).toContain(`WriteAllText('${WIN_KEYPUSH_CODE}', '0')`);
    expect(script).toContain(`WriteAllText('${WIN_KEYPUSH_CODE}', '1')`);
    expect(script).toContain("Add-Content -Path 'C:\\Windows\\Temp\\kp.log'");
  });

  it('plink 端口旗标：-P 插在目标前；无端口原样', () => {
    const withPort = buildPlinkArgsWithPort('plink', 'u', 'h', 'pw', 'true', undefined, 2222);
    expect(withPort.slice(-4)).toEqual(['-P', '2222', 'u@h', 'true']);
    const noPort = buildPlinkArgsWithPort('plink', 'u', 'h', 'pw', 'true');
    expect(noPort).not.toContain('-P');
  });
});

describe('bootstrapKeyForTarget — plink 通道（有网络目标）', () => {
  const sshTarget: KeyBootstrapTarget = { kind: 'ssh', host: '10.10.0.5', user: 'root' };

  it('happy path：keyscan 钉指纹 → plink 推送 → 返回 keyPath', async () => {
    const { keysDir, keyPath } = makeKeys();
    const { exec, calls } = scriptedExec([
      ok('10.10.0.5 ssh-ed25519 AAAAhostkey\n'),              // ssh-keyscan
      ok('KEY_BOOTSTRAP_OK /root/.ssh/authorized_keys\n'),     // plink 推送
    ]);
    const r = await bootstrapKeyForTarget(sshTarget, 'pw', { exec, keysDir, keyPath, plinkPath: 'plink' });
    expect(r).toEqual({ ok: true, keyPath, via: 'plink' });
    // plink 调用：-pw 瞬传 + -hostkey 钉指纹 + linux 推送命令
    const plink = calls.find((c) => c[0] === 'plink');
    expect(plink).toBeDefined();
    expect(plink).toContain('-pw');
    expect(plink).toContain('-hostkey');
    expect(plink![plink!.length - 1]).toContain('KEY_BOOTSTRAP_OK');
    expect(plink![plink!.length - 1]).toContain('~/.ssh/authorized_keys');
  });

  it('windows 目标（osFamily=windows）→ EncodedCommand 包装，管理员落点在脚本里', async () => {
    const { keysDir, keyPath } = makeKeys();
    const { exec, calls } = scriptedExec([
      ok('10.10.0.9 ssh-ed25519 AAAAhostkey\n'),
      ok('KEY_BOOTSTRAP_OK C:\\ProgramData\\ssh\\administrators_authorized_keys\n'),
    ]);
    const r = await bootstrapKeyForTarget(
      { kind: 'vm', address: '10.10.0.9', user: 'researcher', osFamily: 'windows' },
      'pw',
      { exec, keysDir, keyPath, plinkPath: 'plink' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.via).toBe('plink');
    const plink = calls.find((c) => c[0] === 'plink');
    const cmd = plink![plink!.length - 1]!;
    expect(cmd).toContain('powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand');
    const decoded = Buffer.from(cmd.split('-EncodedCommand ')[1]!, 'base64').toString('utf16le');
    expect(decoded).toContain('administrators_authorized_keys');
    expect(decoded).toContain('S-1-5-32-544');
  });

  it('plink 推送认证失败 → 可读错误带「密码不对」提示', async () => {
    const { keysDir, keyPath } = makeKeys();
    const { exec } = scriptedExec([
      ok('10.10.0.5 ssh-ed25519 AAAAhostkey\n'),
      fail('FATAL ERROR: Permission denied (password)'),
    ]);
    const r = await bootstrapKeyForTarget(sshTarget, 'wrong', { exec, keysDir, keyPath, plinkPath: 'plink' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('公钥推送失败');
  });

  it('keyscan 取不到指纹（sshd 没跑）→ 指向 adopt 的指引', async () => {
    const { keysDir, keyPath } = makeKeys();
    const { exec } = scriptedExec([fail('')]);
    const r = await bootstrapKeyForTarget(sshTarget, 'pw', { exec, keysDir, keyPath, plinkPath: 'plink' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('env adopt');
  });
});

describe('bootstrapKeyForTarget — vmrun 通道（断网 Windows VM）', () => {
  const vmTarget: KeyBootstrapTarget = {
    kind: 'vm', vmx: VMX, vmName: 'win10', id: 'win10', user: 'admin', osFamily: 'windows',
  };
  const copySideEffect = (content: string) => (argv: string[]) => {
    writeFileSync(argv[argv.length - 1]!, content);
    return ok();
  };

  it('happy path：vmware 可用 → 运行中 → 引导 → code 核对 → 清理', async () => {
    const { keysDir, keyPath } = makeKeys();
    const { exec, calls } = scriptedExec([
      ok('Total running VMs: 0\n'),                    // ensureVmwareAvailable probe
      ok(`Total running VMs: 1\n${VMX}\n`),            // 运行中确认
      ok(),                                            // runProgramInGuest key push
      copySideEffect('0'),                             // copyFileFromGuest code
      copySideEffect('key pushed\n'),                  // log
      ok(), ok(),                                      // deleteFileInGuest ×2
    ]);
    const r = await bootstrapKeyForTarget(vmTarget, 'pw', { exec, keysDir, keyPath });
    expect(r).toEqual({ ok: true, keyPath, via: 'vmrun' });
    const run = calls.find((c) => c.includes('runProgramInGuest'));
    expect(run).toBeDefined();
    expect(run!.slice(1, 7)).toEqual(['-T', 'ws', '-gu', 'admin', '-gp', 'pw']);
    expect(run).toContain('powershell.exe');
  });

  it('guest 内失败（code=1 + 日志尾部）→ 报错', async () => {
    const { keysDir, keyPath } = makeKeys();
    const { exec } = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok(`Total running VMs: 1\n${VMX}\n`),
      ok(),
      copySideEffect('1'),
      copySideEffect("FAILED: Access to the path 'C:\\ProgramData\\ssh' is denied.\n"),
      ok(), ok(),
    ]);
    const r = await bootstrapKeyForTarget(vmTarget, 'pw', { exec, keysDir, keyPath });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('guest 内失败');
      expect(r.error).toContain('denied');
    }
  });

  it('认证失败 → 可读错误；VM 未运行 → 指引先启动', async () => {
    const { keysDir, keyPath } = makeKeys();
    const auth = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok(`Total running VMs: 1\n${VMX}\n`),
      fail('Error: Invalid user name or password'),
    ]);
    const r1 = await bootstrapKeyForTarget(vmTarget, 'wrong', { exec: auth.exec, keysDir, keyPath });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toContain('guest 认证失败');

    const { keysDir: kd2, keyPath: kp2 } = makeKeys();
    const stopped = scriptedExec([
      ok('Total running VMs: 0\n'),
      ok('Total running VMs: 0\n'),
    ]);
    const r2 = await bootstrapKeyForTarget(vmTarget, 'pw', { exec: stopped.exec, keysDir: kd2, keyPath: kp2 });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toContain('未在运行');
  });
});

describe('bootstrapKeyForTarget — 守卫与边界', () => {
  it('断网 Linux VM 走 vmrun 通道（1.6.13 修正误砍——runProgramInGuest 以登录用户身份执行，写自己 ~/.ssh 无需提权）', async () => {
    const { keysDir, keyPath } = makeKeys();
    const LINUX_VMX = '/vms/u.vmx';
    const copySideEffect = (content: string) => (argv: string[]) => {
      writeFileSync(argv[argv.length - 1]!, content);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const { exec, calls } = scriptedExec([
      { exitCode: 0, stdout: 'Total running VMs: 0\n', stderr: '' },   // ensureVmwareAvailable probe
      { exitCode: 0, stdout: `Total running VMs: 1\n${LINUX_VMX}\n`, stderr: '' }, // 运行中确认
      { exitCode: 0, stdout: '', stderr: '' },                          // runProgramInGuest（bash 推送）
      copySideEffect('0'),                                               // copyFileFromGuest code
      copySideEffect('KEY_BOOTSTRAP_OK\n'),                              // out
      { exitCode: 0, stdout: '', stderr: '' },                           // deleteFileInGuest ×2
      { exitCode: 0, stdout: '', stderr: '' },
    ]);
    const r = await bootstrapKeyForTarget(
      { kind: 'vm', vmx: LINUX_VMX, vmName: 'u', user: 'researcher', osFamily: 'linux' },
      'pw',
      { exec, keysDir, keyPath },
    );
    expect(r).toEqual({ ok: true, keyPath, via: 'vmrun' });
    const run = calls.find((c) => c.includes('runProgramInGuest'));
    expect(run).toBeDefined();
    // linux 包装：/bin/bash -c + 捕获脚本（写自己 home 的 authorized_keys）
    expect(run).toContain('/bin/bash');
    const script = run![run!.length - 1]!;
    expect(script).toContain('~/.ssh/authorized_keys');
    expect(script).toContain('KEY_BOOTSTRAP_OK');
    expect(script).toContain('/tmp/zhishi-keypush.code');
  });

  it('缺密码 / 缺用户 → 参数错误（零 exec 调用）', async () => {
    const { keysDir, keyPath } = makeKeys();
    const { exec, calls } = scriptedExec([]);
    const r1 = await bootstrapKeyForTarget({ kind: 'ssh', host: 'h', user: 'u' }, '', { exec, keysDir, keyPath });
    expect(r1.ok).toBe(false);
    const r2 = await bootstrapKeyForTarget({ kind: 'ssh', host: 'h', user: ' ' }, 'pw', { exec, keysDir, keyPath });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toContain('登录用户');
    expect(calls).toHaveLength(0);
  });
});
