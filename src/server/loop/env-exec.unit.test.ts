/**
 * M1 — env-exec（loop/env-exec.ts）unit tests.
 *
 * 全部通过注入的 EnvExec 断言命令组装与流程编排，绝不真调 ssh。
 * 覆盖：目标解析（ssh/vm/docker、vm 缺 address → 未就绪）、ssh argv
 * 组装（ControlMaster/key/port/destination）、输出截断（head+tail 标记）、
 * 执行错误面（远端非零 exit 原样回传 / 进程级失败 → ok:false / exec
 * 抛错 → ok:false / timeoutMs 透传）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';

import type { EnvironmentEntry } from '../../shared/config-types';
import {
  buildDockerExecArgv,
  buildLocalExecArgv,
  buildPlinkPasswordArgv,
  buildRemoteTimeoutWrapper,
  buildScpUploadArgv,
  buildSshArgv,
  buildSshPasswordArgv,
  buildSshPasswordEnv,
  authConflictHint,
  ensureAskpassScript,
  execInEnvironment,
  noteExecOutcome,
  resetExecTimeoutStreaksForTests,
  resolveExecTarget,
  resolvePasswordRef,
  resolveSshTarget,
  sshAuthMethod,
  sshFileChannelUnsupported,
  SSH_ASKPASS_PASSWORD_ENV,
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
    // 1.6.9 #2 / 2.2.3：末位是远端超时杀包装（heredoc 传命令体 + 能力探测，
    // 不依赖 bash/base64，也没有会被 argv 吃掉的逃逸引号层）。
    const last = calls[0].argv[calls[0].argv.length - 1]!;
    expect(last.startsWith('if command -v timeout')).toBe(true);
    expect(last).toContain('timeout -k 5 120s sh');
    expect(last).toContain('command -v timeout');
    expect(last).not.toContain('base64');
    const marker = "fi <<'ZHISHI_CMD_EOF'\n";
    const start = last.indexOf(marker) + marker.length;
    expect(last.slice(start, last.lastIndexOf('\nZHISHI_CMD_EOF'))).toBe('uname -a');
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

describe('1.6.9 #2：远端超时杀包装 + 自堵检测', () => {
  it('posix：heredoc 传命令体，timeout 按远端能力降级', () => {
    const wrapped = buildRemoteTimeoutWrapper('uname -a', 5000);
    expect(wrapped.startsWith('if command -v timeout')).toBe(true);
    expect(wrapped).toContain("fi <<'ZHISHI_CMD_EOF'");
    expect(wrapped).toContain('timeout -k 5 5s sh');
    // 能力探测：没有 coreutils timeout 的远端降级为裸 sh，而不是 127
    expect(wrapped).toContain('command -v timeout');
    expect(wrapped).not.toContain('bash');
    expect(wrapped).not.toContain('base64');
    // 1ms 下限 1s
    expect(buildRemoteTimeoutWrapper('id', 1)).toContain('timeout -k 5 1s sh');
  });

  it('posix：引号/换行/$/反引号/循环体原样送达（heredoc 不做任何展开）', () => {
    const cmd = 'for i in 1 2; do echo "你好 $i $(whoami)"; done\nls /x \'q\' $HOME `date`';
    const wrapped = buildRemoteTimeoutWrapper(cmd, 5000);
    const marker = "fi <<'ZHISHI_CMD_EOF'\n";
    const start = wrapped.indexOf(marker) + marker.length;
    const end = wrapped.lastIndexOf('\nZHISHI_CMD_EOF');
    expect(wrapped.slice(start, end)).toBe(cmd);
  });

  it('posix：命令里恰好有分隔符行 → 自动换一个', () => {
    const cmd = 'echo a\nZHISHI_CMD_EOF\necho b';
    const wrapped = buildRemoteTimeoutWrapper(cmd, 1000);
    expect(wrapped).toContain("<<'ZHISHI_CMD_EOF_1'");
    expect(wrapped.endsWith('ZHISHI_CMD_EOF_1')).toBe(true);
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

describe('1.7.8 local 通道（Windows 宿主直 spawn）', () => {
  const LOCAL_ENTRY: EnvironmentEntry = {
    id: 'local',
    kind: 'local',
    osFamily: 'windows',
    createdAt: '',
  };

  it('resolveExecTarget:local → local 通道（无 ssh/docker 定位锚要求）', () => {
    const r = resolveExecTarget(LOCAL_ENTRY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.execTarget).toEqual({ channel: 'local' });
  });

  it('resolveSshTarget:local → 明确拒绝（不走 ssh）', () => {
    const r = resolveSshTarget(LOCAL_ENTRY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('local');
  });

  it('buildLocalExecArgv:windows → powershell EncodedCommand（psShellWrapper 口径）', () => {
    const argv = buildLocalExecArgv('whoami /priv', 'windows');
    expect(argv[0]).toBe('powershell');
    expect(argv[1]).toBe('-NoProfile');
    expect(argv[2]).toBe('-EncodedCommand');
    // 载荷可解：psShellWrapper 的 cmd /c + 用户命令 base64。
    const inner = Buffer.from(argv[3]!, 'base64').toString('utf16le');
    expect(inner).toContain('cmd /c $c');
    expect(inner).toContain('exit $LASTEXITCODE');
    const b = /\$b='([A-Za-z0-9+/=]+)'/.exec(inner)?.[1];
    expect(Buffer.from(b!, 'base64').toString('utf8')).toBe('whoami /priv');
  });

  it('buildLocalExecArgv:linux → bash -c（家族完备性）；带 timeoutMs → posix 超时杀包装', () => {
    expect(buildLocalExecArgv('id', 'linux')).toEqual(['bash', '-c', 'id']);
    const wrapped = buildLocalExecArgv('id', 'linux', 5000);
    expect(wrapped[0]).toBe('bash');
    expect(wrapped[1]).toBe('-c');
    expect(wrapped[2]).toContain('timeout -k 5 5s');
  });

  it('execInEnvironment:local → 注入 exec 收到宿主 argv + 超时杀包装（argv 内部组装）', async () => {
    const { exec, calls } = fakeExec({ exitCode: 0, stdout: 'desktop\\researcher\n', stderr: '' });
    const r = await execInEnvironment(LOCAL_ENTRY, 'whoami', { exec });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stdout).toBe('desktop\\researcher\n');
    expect(calls).toHaveLength(1);
    expect(calls[0].argv[0]).toBe('powershell');
    expect(calls[0].argv).toContain('-ExecutionPolicy');
    expect(calls[0].argv).toContain('Bypass');
    // 末位 = 作业超时杀包装的 EncodedCommand 载荷（不再是「整条命令行一个
    // 元素」——local 直 spawn 按 argv 组装）。
    const last = calls[0].argv[calls[0].argv.length - 1]!;
    expect(last).not.toContain(' ');
    const inner = Buffer.from(last, 'base64').toString('utf16le');
    expect(inner).toContain('Start-Job');
    expect(inner).toContain('Wait-Job $j -Timeout 120'); // DEFAULT_TIMEOUT_MS 预算
    // 三层结构：inner → jobBody → 用户命令。
    const bodyB64 = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(inner)?.[1];
    const jobBody = Buffer.from(bodyB64!, 'base64').toString('utf8');
    const b = /\$b='([A-Za-z0-9+/=]+)'/.exec(jobBody)?.[1];
    expect(Buffer.from(b!, 'base64').toString('utf8')).toBe('whoami');
    // 本地超时 = 预算 + 10s 余量（与远端通道同一口径）。
    expect(calls[0].timeoutMs).toBe(130_000);
  });

  it('execInEnvironment:local → 远端非零退出照样 ok:true 语义回传', async () => {
    const { exec } = fakeExec({ exitCode: 9009, stderr: 'not recognized' });
    const r = await execInEnvironment(LOCAL_ENTRY, 'bogus-cmd', { exec });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.exitCode).toBe(9009);
  });


});

// ---------------------------------------------------------------------------
// 2.0.4 只密码设备 —— ssh 密码执行通道
// ---------------------------------------------------------------------------

const PW_ENTRY: EnvironmentEntry = {
  id: 'cam01',
  kind: 'ssh',
  host: '192.168.1.50',
  user: 'admin',
  passwordRef: 'env:ZHISHI_TEST_PW_REF',
  createdAt: '2026-01-01T00:00:00Z',
};

function fakeExecCapture(): {
  exec: EnvExec;
  calls: { argv: string[]; timeoutMs: number; env?: Record<string, string> }[];
} {
  const calls: { argv: string[]; timeoutMs: number; env?: Record<string, string> }[] = [];
  const exec: EnvExec = async (argv, timeoutMs, opts) => {
    calls.push({ argv, timeoutMs, env: opts?.env });
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

describe('sshAuthMethod（认证方式分派）', () => {
  it('keyPath 优先；其次 passwordRef；皆无 = agent', () => {
    expect(sshAuthMethod({ destination: 'h', host: 'h', keyPath: '/k', passwordRef: 'env:X' })).toBe('key');
    expect(sshAuthMethod({ destination: 'h', host: 'h', passwordRef: 'env:X' })).toBe('password');
    expect(sshAuthMethod({ destination: 'h', host: 'h' })).toBe('agent');
  });

  it('authConflictHint：两者同给才出声（否则 null）', () => {
    expect(authConflictHint(null)).toBeNull();
    expect(authConflictHint({ destination: 'h', host: 'h', keyPath: '/k' })).toBeNull();
    expect(authConflictHint({ destination: 'h', host: 'h', passwordRef: 'env:X' })).toBeNull();
    const hint = authConflictHint({ destination: 'h', host: 'h', keyPath: '/k', passwordRef: 'env:X' });
    expect(hint).toContain('keyPath');
    expect(hint).toContain('passwordRef');
  });
});

describe('buildSshPasswordArgv（posix 密码通道）', () => {
  it('无 BatchMode / NumberOfPasswordPrompts=1 / 无 -i / accept-new 保留', () => {
    const argv = buildSshPasswordArgv(
      { destination: 'admin@192.168.1.50', host: '192.168.1.50', user: 'admin', port: 2222 },
      'id',
      { controlMaster: false },
    );
    expect(argv[0]).toBe('ssh');
    expect(argv).not.toContain('BatchMode=yes');
    expect(argv).toContain('NumberOfPasswordPrompts=1');
    expect(argv).not.toContain('-i');
    expect(argv).toContain('StrictHostKeyChecking=accept-new');
    expect(argv[argv.indexOf('-p') + 1]).toBe('2222');
    expect(argv[argv.length - 2]).toBe('admin@192.168.1.50');
    expect(argv[argv.length - 1]).toBe('id');
  });

  it('windows 家族远端命令同样走 EncodedCommand 包装（与 buildSshArgv 同口径）', () => {
    const keyArgv = buildSshArgv(
      { destination: 'u@h', host: 'h' },
      'whoami',
      { controlMaster: false, osFamily: 'windows' },
    );
    const pwArgv = buildSshPasswordArgv(
      { destination: 'u@h', host: 'h' },
      'whoami',
      { controlMaster: false, osFamily: 'windows' },
    );
    expect(pwArgv[pwArgv.length - 1]).toBe(keyArgv[keyArgv.length - 1]);
    expect(pwArgv[pwArgv.length - 1]).toContain('powershell -NoProfile -EncodedCommand');
  });
});

describe('buildSshPasswordEnv + ensureAskpassScript（ASKPASS 三件套）', () => {
  it('环境三件套：脚本路径 / REQUIRE=force / 密码载体', () => {
    const env = buildSshPasswordEnv('s3cret', '/tmp/ask.sh');
    expect(env.SSH_ASKPASS).toBe('/tmp/ask.sh');
    expect(env.SSH_ASKPASS_REQUIRE).toBe('force');
    expect(env[SSH_ASKPASS_PASSWORD_ENV]).toBe('s3cret');
  });

  it('助手脚本幂等落盘且不含秘密本体', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zhishi-askpass-'));
    try {
      const p1 = ensureAskpassScript(dir);
      const p2 = ensureAskpassScript(dir);
      expect(p1).toBe(p2);
      const content = readFileSync(p1, 'utf-8');
      expect(content).toContain(SSH_ASKPASS_PASSWORD_ENV);
      expect(content.startsWith('#!/bin/sh')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildPlinkPasswordArgv（win32 密码通道）', () => {
  it('-pw / -hostkey 钉指纹 / -P 端口插位 / user 显式给', () => {
    const argv = buildPlinkPasswordArgv(
      '/bin/plink',
      { destination: 'admin@h', host: 'h', user: 'admin', port: 2222 },
      'id',
      'pw',
      ['SHA256:abc', 'SHA256:def'],
    );
    expect(argv[0]).toBe('/bin/plink');
    expect(argv[argv.indexOf('-pw') + 1]).toBe('pw');
    expect(argv[argv.indexOf('-P') + 1]).toBe('2222');
    expect(argv[argv.indexOf('-hostkey') + 1]).toBe('SHA256:abc');
    expect(argv[argv.length - 2]).toBe('admin@h');
    // -P 必须插在目标之前（buildPlinkArgsWithPort 同构纪律）。
    expect(argv.indexOf('-P')).toBeLessThan(argv.length - 2);
  });
});

describe('sshFileChannelUnsupported（文件传输/attach 护栏）', () => {
  it('密码条目给明确错误；密钥/agent 不受限', () => {
    expect(sshFileChannelUnsupported({ destination: 'h', host: 'h', passwordRef: 'env:X' }, 'attach')).toContain('attach');
    expect(sshFileChannelUnsupported({ destination: 'h', host: 'h', keyPath: '/k', passwordRef: 'env:X' }, 'attach')).toBeNull();
    expect(sshFileChannelUnsupported({ destination: 'h', host: 'h' }, 'attach')).toBeNull();
  });

});

describe('execInEnvironment：密码引用执行链', () => {
  it('askpass 策略：argv 无 BatchMode、env 三件套注入、远端命令已包超时杀', async () => {
    process.env.ZHISHI_TEST_PW_REF = 's3cret';
    try {
      const { exec, calls } = fakeExecCapture();
      const r = await execInEnvironment(PW_ENTRY, 'id', {
        exec,
        passwordStrategy: 'askpass',
        sshPasswordChannel: { askpassScriptPath: () => '/tmp/ask.sh', ensurePlink: async () => ({ ok: false, error: 'n/a' }), resolveHostKeyFingerprints: async () => undefined },
      });
      expect(r.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].argv).not.toContain('BatchMode=yes');
      expect(calls[0].env?.SSH_ASKPASS).toBe('/tmp/ask.sh');
      expect(calls[0].env?.[SSH_ASKPASS_PASSWORD_ENV]).toBe('s3cret');
      // 远端命令末位 = 超时杀包装（linux 家族 = heredoc + timeout 前缀）。
      const last = calls[0].argv[calls[0].argv.length - 1];
      expect(last.startsWith('if command -v timeout')).toBe(true);
      expect(last).toContain('timeout -k 5');
    } finally {
      delete process.env.ZHISHI_TEST_PW_REF;
    }
  });

  it('引用解析不到 → 明确失败（指引 secrets.env），不 spawn', async () => {
    delete process.env.ZHISHI_TEST_PW_REF;
    const { exec, calls } = fakeExecCapture();
    const r = await execInEnvironment(PW_ENTRY, 'id', { exec, passwordStrategy: 'askpass' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('解析不到密码');
      expect(r.error).toContain('secrets.env');
    }
    expect(calls).toHaveLength(0);
  });

  it('keyPath 与 passwordRef 同给 → 密钥通道（argv 带 -i、无密码 env）', async () => {
    process.env.ZHISHI_TEST_PW_REF = 's3cret';
    try {
      const { exec, calls } = fakeExecCapture();
      const r = await execInEnvironment({ ...PW_ENTRY, keyPath: '/k' }, 'id', { exec, passwordStrategy: 'askpass' });
      expect(r.ok).toBe(true);
      expect(calls[0].argv).toContain('-i');
      expect(calls[0].env).toBeUndefined();
    } finally {
      delete process.env.ZHISHI_TEST_PW_REF;
    }
  });

  it('plink 策略：编排 ensurePlink → 钉指纹 → plink argv', async () => {
    process.env.ZHISHI_TEST_PW_REF = 's3cret';
    try {
      const { exec, calls } = fakeExecCapture();
      const r = await execInEnvironment(PW_ENTRY, 'id', {
        exec,
        passwordStrategy: 'plink',
        sshPasswordChannel: {
          ensurePlink: async () => ({ ok: true, path: '/bin/plink' }),
          resolveHostKeyFingerprints: async () => ['SHA256:abc'],
          askpassScriptPath: () => '/tmp/ask.sh',
        },
      });
      expect(r.ok).toBe(true);
      expect(calls[0].argv[0]).toBe('/bin/plink');
      expect(calls[0].argv[calls[0].argv.indexOf('-pw') + 1]).toBe('s3cret');
      expect(calls[0].argv[calls[0].argv.indexOf('-hostkey') + 1]).toBe('SHA256:abc');
      expect(calls[0].env).toBeUndefined();
    } finally {
      delete process.env.ZHISHI_TEST_PW_REF;
    }
  });

  it('plink 策略：指纹取不到 → 明确失败（不挂起等超时）', async () => {
    process.env.ZHISHI_TEST_PW_REF = 's3cret';
    try {
      const { exec, calls } = fakeExecCapture();
      const r = await execInEnvironment(PW_ENTRY, 'id', {
        exec,
        passwordStrategy: 'plink',
        sshPasswordChannel: {
          ensurePlink: async () => ({ ok: true, path: '/bin/plink' }),
          resolveHostKeyFingerprints: async () => undefined,
          askpassScriptPath: () => '/tmp/ask.sh',
        },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('host key 指纹');
      expect(calls).toHaveLength(0);
    } finally {
      delete process.env.ZHISHI_TEST_PW_REF;
    }
  });

  it('plink 策略：plink 不可用 → 错误透传（含引导文案）', async () => {
    process.env.ZHISHI_TEST_PW_REF = 's3cret';
    try {
      const { exec, calls } = fakeExecCapture();
      const r = await execInEnvironment(PW_ENTRY, 'id', {
        exec,
        passwordStrategy: 'plink',
        sshPasswordChannel: {
          ensurePlink: async () => ({ ok: false, error: 'plink 缺席' }),
          resolveHostKeyFingerprints: async () => ['SHA256:abc'],
          askpassScriptPath: () => '/tmp/ask.sh',
        },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('plink 缺席');
      expect(calls).toHaveLength(0);
    } finally {
      delete process.env.ZHISHI_TEST_PW_REF;
    }
  });
});
