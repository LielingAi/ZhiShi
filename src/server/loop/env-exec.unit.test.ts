/**
 * M1 — env-exec（loop/env-exec.ts）unit tests.
 *
 * 全部通过注入的 EnvExec 断言命令组装与流程编排，绝不真调 ssh。
 * 覆盖：目标解析（ssh/vm/docker、vm 缺 address → 未就绪）、ssh argv
 * 组装（ControlMaster/key/port/destination）、输出截断（head+tail 标记）、
 * 执行错误面（远端非零 exit 原样回传 / 进程级失败 → ok:false / exec
 * 抛错 → ok:false / timeoutMs 透传）。
 */
import { describe, expect, it } from 'vitest';

import type { EnvironmentEntry } from '../../shared/config-types';
import {
  buildDockerExecArgv,
  buildSshArgv,
  execInEnvironment,
  resolveExecTarget,
  resolvePasswordRef,
  resolveSshTarget,
  truncateOutput,
  OUTPUT_LIMIT_BYTES,
  type EnvExec,
} from './env-exec';

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
    expect(calls[0].argv[calls[0].argv.length - 1]).toBe('uname -a');
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

  it('timeoutMs 透传（默认 120s，可覆盖）', async () => {
    const { exec, calls } = fakeExec({ exitCode: 0 });
    await execInEnvironment(VM_ENTRY, 'id', { exec });
    expect(calls[0].timeoutMs).toBe(120_000);
    await execInEnvironment(VM_ENTRY, 'id', { exec, timeoutMs: 5000 });
    expect(calls[1].timeoutMs).toBe(5000);
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
