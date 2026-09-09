/**
 * M1 — env-exec（loop/env-exec.ts）unit tests.
 *
 * 全部通过注入的 EnvExec 断言命令组装与流程编排，绝不真调 ssh。
 * 覆盖：目标解析（ssh/vm/docker、vm 缺 address → 未就绪）、ssh argv
 * 组装（ControlMaster/key/port/destination）、输出截断（head+tail 标记）、
 * 执行错误面（远端非零 exit 原样回传 / 进程级失败 → ok:false / exec
 * 抛错 → ok:false / timeoutMs 透传）。
 */
import { describe, expect, it, beforeEach } from 'vitest';

import type { EnvironmentEntry } from '../../shared/config-types';
import {
  buildDockerExecArgv,
  buildPtyDockerExecArgv,
  buildPtySpawnSpec,
  buildPtySshArgv,
  buildRemoteTimeoutWrapper,
  buildScpUploadArgv,
  buildSshArgv,
  execInEnvironment,
  interactiveShellScript,
  noteExecOutcome,
  resetExecTimeoutStreaksForTests,
  resolveExecTarget,
  resolvePasswordRef,
  resolveSshTarget,
  truncateOutput,
  EXEC_TIMEOUT_STREAK_LIMIT,
  OUTPUT_LIMIT_BYTES,
  type EnvExec,
} from './env-exec';

beforeEach(() => {
  resetExecTimeoutStreaksForTests();
});

const SSH_ENTRY: EnvironmentEntry = {
  id: 'dev-box',
  kind: 'ssh',
  host: '10.0.0.8',
  user: 'researcher',
  port: 2222,
  keyPath: '/home/me/.ssh/id_ed25519',
  createdAt: '2026-01-01T00:00:00Z',
};

const VM_ENTRY: EnvironmentEntry = {
  id: 'pwn-vm',
  kind: 'vm',
  vmName: 'pwn-vm',
  address: '192.168.152.129',
  user: 'researcher',
  keyPath: 'C:\\Users\\me\\.ssh\\id_ed25519',
  createdAt: '2026-01-01T00:00:00Z',
};

function fakeExec(result: { exitCode: number; stdout?: string; stderr?: string; error?: string }): {
  exec: EnvExec;
  calls: { argv: string[]; timeoutMs: number }[];
} {
  const calls: { argv: string[]; timeoutMs: number }[] = [];
  const exec: EnvExec = async (argv, timeoutMs) => {
    calls.push({ argv, timeoutMs });
    return { exitCode: result.exitCode, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
  };
  return { exec, calls };
}

describe('resolveSshTarget', () => {
  it('ssh 条目：host/user/port/keyPath 全量解析', () => {
    const r = resolveSshTarget(SSH_ENTRY);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target.destination).toBe('researcher@10.0.0.8');
      expect(r.target.port).toBe(2222);
      expect(r.target.keyPath).toBe('/home/me/.ssh/id_ed25519');
    }
  });

  it('vm 条目：address 即可达地址', () => {
    const r = resolveSshTarget(VM_ENTRY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target.destination).toBe('researcher@192.168.152.129');
  });

  it('vm 缺 address → 「环境未就绪」', () => {
    const r = resolveSshTarget({ ...VM_ENTRY, address: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('未就绪');
  });

  it('docker 条目 → ssh 通道明确拒绝（docker 走 docker exec 通道）', () => {
    const r = resolveSshTarget({ id: 'd', kind: 'docker', container: 'c1', createdAt: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('docker exec');
  });

  it('resolveExecTarget:docker 条目 → docker 通道(container 定位锚)', () => {
    const r = resolveExecTarget({ id: 'd', kind: 'docker', container: 'c1', createdAt: '' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.execTarget).toEqual({ channel: 'docker', container: 'c1' });
  });

  it('resolveExecTarget:docker 缺 container → 失败;vm/ssh → ssh 通道', () => {
    const bad = resolveExecTarget({ id: 'd', kind: 'docker', createdAt: '' });
    expect(bad.ok).toBe(false);
    const vm = resolveExecTarget(VM_ENTRY);
    expect(vm.ok).toBe(true);
    if (vm.ok) expect(vm.execTarget.channel).toBe('ssh');
  });

  it('resolveExecTarget:断网 VM(无 address 有 vmx/vmName)→ guest 通道', () => {
    const r = resolveExecTarget({ id: 'v', kind: 'vm', vmName: 'iso-vm', vmx: 'D:\\v\\iso.vmx', createdAt: '' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.execTarget.channel).toBe('guest');
    // 无 address 且无定位锚 → 未就绪
    expect(resolveExecTarget({ id: 'v', kind: 'vm', createdAt: '' }).ok).toBe(false);
  });

  it('ssh 缺 host → 失败', () => {
    const r = resolveSshTarget({ id: 's', kind: 'ssh', createdAt: '' });
    expect(r.ok).toBe(false);
  });

  it('缺 user → destination 为裸 host（本机用户名语义）', () => {
    const r = resolveSshTarget({ id: 's', kind: 'ssh', host: 'h1', createdAt: '' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target.destination).toBe('h1');
  });
});

describe('resolvePasswordRef(D-T4 外部引用)', () => {
  it('env:VAR 形态现场取;未设/非法形态 → null', () => {
    process.env.ZHISHI_TEST_PW = 's3cret';
    expect(resolvePasswordRef('env:ZHISHI_TEST_PW')).toBe('s3cret');
    expect(resolvePasswordRef('env:ZHISHI_TEST_NOPE')).toBeNull();
    expect(resolvePasswordRef('plain-password')).toBeNull(); // 裸密码拒收
    expect(resolvePasswordRef(undefined)).toBeNull();
    delete process.env.ZHISHI_TEST_PW;
  });
});

describe('buildDockerExecArgv', () => {
  it('组装 docker exec <container> bash -lc <command>', () => {
    expect(buildDockerExecArgv('zhishi-pwn-abc', 'uname -a')).toEqual([
      'docker', 'exec', 'zhishi-pwn-abc', 'bash', '-lc', 'uname -a',
    ]);
  });
});


describe('buildSshArgv', () => {
  it('组装 BatchMode/key/port/destination/command（POSIX 默认带 ControlMaster）', () => {
    const target = resolveSshTarget(SSH_ENTRY);
    if (!target.ok) throw new Error('unreachable');
    const argv = buildSshArgv(target.target, 'uname -a', { controlMaster: true });
    const s = argv.join(' ');
    expect(argv[0]).toBe('ssh');
    expect(s).toContain('BatchMode=yes');
    expect(s).toContain('StrictHostKeyChecking=accept-new');
    expect(s).toContain('ControlMaster=auto');
    expect(s).toContain('ControlPersist=10m');
    expect(s).toMatch(/ControlPath=.*zhishi-ssh/);
    expect(argv).toContain('-i');
    expect(argv[argv.indexOf('-i') + 1]).toBe('/home/me/.ssh/id_ed25519');
    expect(argv).toContain('-p');
    expect(argv[argv.indexOf('-p') + 1]).toBe('2222');
    // 命令作为单参数收尾（远端 shell 解释，不拆词）
    expect(argv[argv.length - 2]).toBe('researcher@10.0.0.8');
    expect(argv[argv.length - 1]).toBe('uname -a');
  });

  it('controlMaster:false（win32 默认形态）→ 不带 Control* 参数', () => {
    const argv = buildSshArgv({ destination: 'u@h', host: 'h' }, 'id', { controlMaster: false });
    const s = argv.join(' ');
    expect(s).not.toContain('ControlMaster');
    expect(s).not.toContain('ControlPath');
    expect(s).not.toContain('ControlPersist');
    expect(s).toContain('BatchMode=yes');
    expect(argv[argv.length - 1]).toBe('id');
  });

  it('缺 keyPath/port → 不带 -i/-p', () => {
    const argv = buildSshArgv({ destination: 'h', host: 'h' }, 'id', { controlMaster: false });
    expect(argv).not.toContain('-i');
    expect(argv).not.toContain('-p');
  });
});

describe('buildScpUploadArgv（1.6.4 传入通道：extract 的反向）', () => {
  it('旗标与 buildScpArgv 同构；host 路径在前、destination:guestPath 收尾', () => {
    const argv = buildScpUploadArgv(
      { destination: 'researcher@10.0.0.8', host: '10.0.0.8', keyPath: '/home/me/.ssh/id_ed25519', port: 2222 },
      'C:\\work\\poc.exe',
      'C:/target/poc.exe',
    );
    const s = argv.join(' ');
    expect(argv[0]).toBe('scp');
    expect(s).toContain('BatchMode=yes');
    expect(s).toContain('StrictHostKeyChecking=accept-new');
    expect(argv[argv.indexOf('-i') + 1]).toBe('/home/me/.ssh/id_ed25519');
    expect(argv[argv.indexOf('-P') + 1]).toBe('2222');
    expect(argv[argv.length - 2]).toBe('C:\\work\\poc.exe');
    expect(argv[argv.length - 1]).toBe('researcher@10.0.0.8:C:/target/poc.exe');
  });

  it('缺 keyPath/port → 不带 -i/-P', () => {
    const argv = buildScpUploadArgv({ destination: 'u@h', host: 'h' }, '/tmp/a.bin', '/tmp/b.bin');
    expect(argv).not.toContain('-i');
    expect(argv).not.toContain('-P');
  });
});

describe('truncateOutput', () => {
  it('短输出原样', () => {
    expect(truncateOutput('hello')).toEqual({ text: 'hello', truncated: false });
  });

  it('长输出 head+tail 各保留，中间标记', () => {
    const big = 'A'.repeat(OUTPUT_LIMIT_BYTES) + 'M'.repeat(5000) + 'Z'.repeat(OUTPUT_LIMIT_BYTES);
    const r = truncateOutput(big);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith('A'.repeat(100))).toBe(true);
    expect(r.text.endsWith('Z'.repeat(100))).toBe(true);
    expect(r.text).toContain('[truncated 5000 bytes]');
    expect(r.text).not.toContain('M'.repeat(100));
  });
});

describe('execInEnvironment', () => {
  it('guest 通道:缺 passwordRef → 干净报错(指引 env:VAR),不碰 vmrun', async () => {
    const { exec, calls } = fakeExec({ exitCode: 0, stdout: '', stderr: '' });
    const r = await execInEnvironment(
      { id: 'v', kind: 'vm', vmName: 'iso-vm', vmx: 'D:\\v\\iso.vmx', createdAt: '' },
      'uname -a',
      { exec },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('passwordRef');
    expect(calls).toHaveLength(0); // 没到 argv exec 层
  });

  it('docker 条目 → argv 走 docker exec 通道(不经 ssh)', async () => {
    const { exec, calls } = fakeExec({ exitCode: 0, stdout: 'Linux zhishi-pwn\n', stderr: '' });
    const r = await execInEnvironment(
      { id: 'd', kind: 'docker', container: 'zhishi-pwn-abc', createdAt: '' },
      'uname -a',
      { exec },
    );
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].argv.slice(0, 3)).toEqual(['docker', 'exec', 'zhishi-pwn-abc']);
    expect(calls[0].argv).not.toContain('ssh');
  });

  it('happy path：exitCode/stdout/stderr 原样回传，argv 走 buildSshArgv', async () => {
    const { exec, calls } = fakeExec({ exitCode: 0, stdout: 'Linux fuzz\n', stderr: '' });
    const r = await execInEnvironment(VM_ENTRY, 'uname -a', { exec });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('Linux fuzz\n');
      expect(r.truncated).toBe(false);
    }
    expect(calls).toHaveLength(1);
    // 1.6.9 #2：末位是远端超时杀包装（timeout + base64 载荷可解码回原命令）
    const last = calls[0].argv[calls[0].argv.length - 1]!;
    expect(last.startsWith('timeout -k 5 ')).toBe(true);
    const b64 = /bash -c "\$\(echo ([A-Za-z0-9+/=]+) \| base64 -d\)"/.exec(last)?.[1];
    expect(b64).toBeTruthy();
    expect(Buffer.from(b64!, 'base64').toString('utf8')).toBe('uname -a');
    expect(calls[0].argv.join(' ')).toContain('researcher@192.168.152.129');
  });

  it('远端命令非零退出 → ok:true + exitCode（语义失败回传，不当通道错误）', async () => {
    const { exec } = fakeExec({ exitCode: 3, stderr: 'boom' });
    const r = await execInEnvironment(VM_ENTRY, 'false', { exec });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toBe('boom');
    }
  });

  it('进程级失败（超时/spawn 错误）→ ok:false', async () => {
    const { exec } = fakeExec({ exitCode: -1, error: 'timed out after 120000ms' });
    const r = await execInEnvironment(VM_ENTRY, 'sleep 999', { exec });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('timed out');
  });

  it('exec 抛错 → ok:false（不向上 throw）', async () => {
    const exec: EnvExec = async () => { throw new Error('spawn ENOENT'); };
    const r = await execInEnvironment(VM_ENTRY, 'id', { exec });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ENOENT');
  });

  it('目标解析失败 → ok:false（不触达 exec）', async () => {
    const { exec, calls } = fakeExec({ exitCode: 0 });
    const r = await execInEnvironment({ ...VM_ENTRY, address: undefined }, 'id', { exec });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('timeoutMs 透传（远端按预算杀 + 本地留 10s 余量，1.6.9 #2）', async () => {
    const { exec, calls } = fakeExec({ exitCode: 0 });
    await execInEnvironment(VM_ENTRY, 'id', { exec });
    expect(calls[0].timeoutMs).toBe(130_000);
    expect(calls[0].argv.at(-1)).toContain('timeout -k 5 120s');
    await execInEnvironment(VM_ENTRY, 'id', { exec, timeoutMs: 5000 });
    expect(calls[1].timeoutMs).toBe(15_000);
    expect(calls[1].argv.at(-1)).toContain('timeout -k 5 5s');
  });

  it('超限输出被截断并标记 truncated', async () => {
    const big = 'X'.repeat(OUTPUT_LIMIT_BYTES * 3);
    const { exec } = fakeExec({ exitCode: 0, stdout: big });
    const r = await execInEnvironment(VM_ENTRY, 'cat big', { exec });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.truncated).toBe(true);
      expect(r.stdout).toContain('[truncated');
      expect(r.stdout.length).toBeLessThan(big.length);
    }
  });
});

describe('交互终端 argv（1.3.3 attach pty）', () => {
  it('interactiveShellScript：linux → bash 回退链；windows → cmd.exe', () => {
    expect(interactiveShellScript('linux')).toBe('[ -x /bin/bash ] && exec /bin/bash; exec sh');
    expect(interactiveShellScript('windows')).toBe('cmd.exe');
  });

  it('buildPtyDockerExecArgv：linux 拆 argv(sh -c 回退链)；windows 直连 cmd.exe(不含程序名)', () => {
    expect(buildPtyDockerExecArgv('zhishi-pwn-abc', 'linux')).toEqual([
      'exec', '-it', 'zhishi-pwn-abc', 'sh', '-c', '[ -x /bin/bash ] && exec /bin/bash; exec sh',
    ]);
    expect(buildPtyDockerExecArgv('zhishi-pwn-abc', 'windows')).toEqual([
      'exec', '-it', 'zhishi-pwn-abc', 'cmd.exe',
    ]);
  });

  it('buildPtySshArgv：-tt 强制 TTY + BatchMode/accept-new/ConnectTimeout + 单元素远端 shell', () => {
    const target = resolveSshTarget(SSH_ENTRY);
    if (!target.ok) throw new Error('unreachable');
    const argv = buildPtySshArgv(target.target, 'linux', { controlMaster: true });
    const s = argv.join(' ');
    expect(argv[0]).toBe('-tt');
    expect(s).toContain('BatchMode=yes');
    expect(s).toContain('StrictHostKeyChecking=accept-new');
    expect(s).toContain('ControlMaster=auto');
    expect(argv).toContain('-i');
    expect(argv[argv.indexOf('-i') + 1]).toBe('/home/me/.ssh/id_ed25519');
    expect(argv).toContain('-p');
    expect(argv[argv.indexOf('-p') + 1]).toBe('2222');
    // 远端 shell 作为单元素收尾(与 buildSshArgv 的「命令单参数」同口径)
    expect(argv[argv.length - 2]).toBe('researcher@10.0.0.8');
    expect(argv[argv.length - 1]).toBe('[ -x /bin/bash ] && exec /bin/bash; exec sh');
  });

  it('buildPtySshArgv：windows family → cmd.exe；controlMaster:false(win32 形态)不带 Control*', () => {
    const argv = buildPtySshArgv({ destination: 'u@h', host: 'h' }, 'windows', { controlMaster: false });
    const s = argv.join(' ');
    expect(s).not.toContain('ControlMaster');
    expect(s).toContain('-tt');
    expect(argv[argv.length - 1]).toBe('cmd.exe');
  });

  it('buildPtySpawnSpec：docker → docker exec 通道；vm/ssh → ssh 通道', () => {
    const docker = buildPtySpawnSpec({ id: 'd', kind: 'docker', container: 'c1', createdAt: '' });
    expect(docker.ok).toBe(true);
    if (docker.ok) {
      expect(docker.spec.file).toBe('docker');
      expect(docker.spec.args.slice(0, 3)).toEqual(['exec', '-it', 'c1']);
      expect(docker.spec.family).toBe('linux');
    }
    const ssh = buildPtySpawnSpec(SSH_ENTRY);
    expect(ssh.ok).toBe(true);
    if (ssh.ok) {
      expect(ssh.spec.file).toBe('ssh');
      expect(ssh.spec.args[0]).toBe('-tt');
    }
  });

  it('buildPtySpawnSpec：guest(断网隔离 VM)→ 明确拒绝(无 TTY)', () => {
    const r = buildPtySpawnSpec({ id: 'v', kind: 'vm', vmName: 'iso-vm', vmx: 'D:\\v\\iso.vmx', createdAt: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('guest-exec');
  });

  it('buildPtySpawnSpec：osFamily=windows 条目 → cmd.exe + family 透传', () => {
    const r = buildPtySpawnSpec({
      id: 'w', kind: 'docker', container: 'win-box', osFamily: 'windows', createdAt: '',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.family).toBe('windows');
      expect(r.spec.args[r.spec.args.length - 1]).toBe('cmd.exe');
    }
  });
});

describe('1.6.9 #2：远端超时杀包装 + 自堵检测', () => {
  it('posix：timeout -k 强杀 + base64 载荷可还原（引号/换行安全）', () => {
    const cmd = 'echo "你好 $(whoami)"\nls /x';
    const wrapped = buildRemoteTimeoutWrapper(cmd, 5000);
    expect(wrapped).toContain('timeout -k 5 5s');
    const b64 = /echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(wrapped)?.[1];
    expect(Buffer.from(b64!, 'base64').toString('utf8')).toBe(cmd);
    // 1ms 下限 1s
    expect(buildRemoteTimeoutWrapper('id', 1)).toContain('timeout -k 5 1s');
  });

  it('windows：powershell 作业包装（双层 base64 可解；Stop-Job 强杀 + 标记行）', () => {
    const wrapped = buildRemoteTimeoutWrapper('whoami /priv', 8000, 'windows');
    expect(wrapped.startsWith('powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ')).toBe(true);
    const inner = Buffer.from(wrapped.split('-EncodedCommand ')[1]!, 'base64').toString('utf16le');
    expect(inner).toContain('Start-Job');
    expect(inner).toContain('Wait-Job $j -Timeout 8');
    expect(inner).toContain('Stop-Job');
    expect(inner).toContain('[zhishi-timeout]');
    // 三层结构断言：inner（引导脚本）→ jobBody（base64）→ 用户命令（base64）
    const bodyB64 = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(inner)?.[1];
    const jobBody = Buffer.from(bodyB64!, 'base64').toString('utf8');
    expect(jobBody).toContain('cmd /c $c');
    expect(jobBody).toContain('$LASTEXITCODE');
    const b = /\$b='([A-Za-z0-9+/=]+)'/.exec(jobBody)?.[1];
    expect(Buffer.from(b!, 'base64').toString('utf8')).toBe('whoami /priv');
  });

  it('自堵检测：连续 3 次超时 → 升级文案（不再放行探测）；成功清零', async () => {
    expect(noteExecOutcome('env-a', true)).toBe(false);
    expect(noteExecOutcome('env-a', true)).toBe(false);
    expect(noteExecOutcome('env-a', true)).toBe(true); // 达阈
    expect(noteExecOutcome('env-a', false)).toBe(false); // 成功清零
    expect(noteExecOutcome('env-a', true)).toBe(false); // 重新计数
  });

  it('远端 124（posix timeout TERM）判超时；达阈后 execInEnvironment 返回自堵错误', async () => {
    const timeoutExec: EnvExec = async () => ({ exitCode: 124, stdout: '', stderr: '' });
    for (let i = 0; i < EXEC_TIMEOUT_STREAK_LIMIT - 1; i++) {
      const r = await execInEnvironment(VM_ENTRY, 'id', { exec: timeoutExec });
      expect(r.ok).toBe(true); // 未达阈：按命令语义失败原样回传
      if (r.ok) expect(r.exitCode).toBe(124);
    }
    const r = await execInEnvironment(VM_ENTRY, 'id', { exec: timeoutExec });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('堵死');
      expect(r.error).toContain('升级人');
    }
  });
});
