/**
 * 安全研究员版 P2 B2 — guest-exec 通道（vm-guest-exec）unit tests.
 *
 * 全部通过注入的 exec 断言命令组装与流程编排，绝不真调 vmrun。host 侧
 * 临时文件用真临时目录——scripted exec 在 copyFileFromGuest 时写文件做
 * 副作用。覆盖：命令组装纯函数、输出包装脚本、退出码解析、失败分类、
 * vmx 解析（D22 直连后只走 vmTemplates 命中 / 未找到）、编排 happy path
 * （list 运行中 → runProgramInGuest → copyFileFromGuest ×2 → 清理）与各
 * 失败分支（非 vm / 有 address / 缺密码 / 未运行 / Tools 未跑 / 认证失败 /
 * guest 命令非零 exitCode 原样返回）。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { EnvironmentEntry } from './registry';
import {
  buildCopyFromGuestArgs,
  buildDeleteGuestFileArgs,
  buildGuestCaptureScript,
  buildGuestExecArgs,
  classifyGuestExecFailure,
  parseGuestExitCode,
  resolveVmxForEntry,
  resolveVmxForVmName,
  vmGuestExec,
  GUEST_EXEC_TIMEOUT_MS,
} from './vm-guest-exec';
import type { VmExec, VmExecResult } from './vm-lifecycle';

const VMX = 'C:\\VMs\\zhishi-pwn-vm-deadbeef\\pwn.vmx';
const INSTANCE_NAME = 'zhishi-pwn-vm-deadbeef';
const RUN_ID = 'testrun1';
const GUEST_OUT = `/tmp/zhishi-exec-${RUN_ID}.out`;
const GUEST_CODE = `/tmp/zhishi-exec-${RUN_ID}.code`;

/** D22 直连后的解析来源：vmTemplates 条目（dirName 命中 INSTANCE_NAME）。 */
const TEMPLATES = { 'pwn-vm': { vmx: VMX } };

function ok(stdout = ''): VmExecResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function fail(stderr: string, exitCode = 1): VmExecResult {
  return { exitCode, stdout: '', stderr };
}

function makeEntry(overrides: Partial<EnvironmentEntry> = {}): EnvironmentEntry {
  return { id: 'range', kind: 'vm', vmName: INSTANCE_NAME, createdAt: 'x', ...overrides };
}

const tempRoots: string[] = [];
function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'zhishi-guest-exec-test-'));
  tempRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

interface HandlerContext {
  hostTmpDir: string;
  /** copyFileFromGuest 写到 host 的 .out / .code 内容。 */
  outContent?: string;
  codeContent?: string;
  /** runProgramInGuest 的响应（缺省成功）。 */
  runResult?: VmExecResult;
  /** vmrun -T ws list 的运行中 vmx 列表。 */
  runningVmx?: string[];
}

/**
 * Handler 式 scripted exec：按 argv 内容分派；copyFileFromGuest 把约定内容
 * 写到 host 路径（最后一个参数）。未识别的调用抛错——测试即命令序列断言。
 */
function makeScriptedExec(ctx: HandlerContext) {
  const calls: string[][] = [];
  const exec: VmExec = async (argv) => {
    calls.push(argv);
    const joined = argv.join(' ');
    // ensureVmwareAvailable 的 probe：ENGINE_SPECS vmware = ['vmrun','list']
    if (argv.length === 2 && argv[0] === 'vmrun' && argv[1] === 'list') {
      return ok('Total running VMs: 1\n');
    }
    if (joined === `vmrun -T ws list`) {
      const running = ctx.runningVmx ?? [VMX];
      return ok(`Total running VMs: ${running.length}\n${running.join('\n')}\n`);
    }
    if (argv.includes('runProgramInGuest')) {
      return ctx.runResult ?? ok();
    }
    if (argv.includes('copyFileFromGuest')) {
      const hostPath = argv[argv.length - 1]!;
      const guestPath = argv[argv.length - 2]!;
      const content = guestPath.endsWith('.code') ? (ctx.codeContent ?? '0') : (ctx.outContent ?? '');
      writeFileSync(hostPath, content);
      return ok();
    }
    if (argv.includes('deleteFileInGuest')) {
      return ok();
    }
    throw new Error(`unexpected exec: ${joined}`);
  };
  return { exec, calls };
}

describe('command assembly (pure)', () => {
  it('buildGuestExecArgs: -T ws + -gu/-gp 全局旗标在子命令前，bash -c 包装', () => {
    expect(buildGuestExecArgs(VMX, 'researcher', 'pw', 'echo hi')).toEqual([
      '-T', 'ws',
      '-gu', 'researcher',
      '-gp', 'pw',
      'runProgramInGuest', VMX,
      '-activeWindow', '-interactive',
      '/bin/bash', '-c', 'echo hi',
    ]);
  });

  it('buildGuestCaptureScript: 子 shell 重定向 stdout/stderr，退出码落 .code', () => {
    expect(buildGuestCaptureScript('echo hi; ls /x', GUEST_OUT, GUEST_CODE)).toBe(
      `( echo hi; ls /x ) > ${GUEST_OUT} 2>&1; echo -n $? > ${GUEST_CODE}`,
    );
  });

  it('buildCopyFromGuestArgs / buildDeleteGuestFileArgs', () => {
    expect(buildCopyFromGuestArgs(VMX, 'researcher', 'pw', GUEST_OUT, 'C:\\tmp\\x.out')).toEqual([
      '-T', 'ws', '-gu', 'researcher', '-gp', 'pw',
      'copyFileFromGuest', VMX, GUEST_OUT, 'C:\\tmp\\x.out',
    ]);
    expect(buildDeleteGuestFileArgs(VMX, 'researcher', 'pw', GUEST_CODE)).toEqual([
      '-T', 'ws', '-gu', 'researcher', '-gp', 'pw',
      'deleteFileInGuest', VMX, GUEST_CODE,
    ]);
  });

  it('parseGuestExitCode: 整数原样返回，脏内容 undefined', () => {
    expect(parseGuestExitCode('0')).toBe(0);
    expect(parseGuestExitCode('127')).toBe(127);
    expect(parseGuestExitCode(' 42\n')).toBe(42);
    expect(parseGuestExitCode('')).toBeUndefined();
    expect(parseGuestExitCode('abc')).toBeUndefined();
  });
});

describe('classifyGuestExecFailure (pure)', () => {
  it('Tools 未运行', () => {
    expect(classifyGuestExecFailure(fail('Error: VMware Tools are not running in the guest'))).toBe('tools-not-running');
    expect(classifyGuestExecFailure(fail('Error: The guest operating system is not running'))).toBe('tools-not-running');
  });

  it('认证失败', () => {
    expect(classifyGuestExecFailure(fail('Error: Invalid user name or password for the guest OS'))).toBe('auth');
    expect(classifyGuestExecFailure(fail('authentication failed'))).toBe('auth');
  });

  it('目标未找到', () => {
    expect(classifyGuestExecFailure(fail('Error: A file was not found'))).toBe('not-found');
  });

  it('其余 → unknown；spawn 级 error 也参与分类', () => {
    expect(classifyGuestExecFailure(fail('something weird happened'))).toBe('unknown');
    expect(classifyGuestExecFailure({ exitCode: -1, stdout: '', stderr: '', error: 'Invalid user name or password' })).toBe('auth');
  });
});

describe('resolveVmxForVmName（D22 直连：只走 vmTemplates）', () => {
  it('模板命中：recipeId / vmx 文件干名 / 目录名都认，带回模板 user', () => {
    const templates = { 'pwn-vm': { vmx: VMX, user: 'researcher' } };
    expect(resolveVmxForVmName('pwn-vm', { templates }))
      .toEqual({ ok: true, vmx: VMX, templateUser: 'researcher' });
    // vmx 文件干名命中（vmName 是 VM 显示名/文件名的场景）
    expect(resolveVmxForVmName('pwn', { templates }))
      .toEqual({ ok: true, vmx: VMX, templateUser: 'researcher' });
    // 目录名命中
    expect(resolveVmxForVmName(INSTANCE_NAME, { templates }))
      .toEqual({ ok: true, vmx: VMX, templateUser: 'researcher' });
  });

  it('未命中 → 清晰错误（指向 env adopt）', () => {
    const r = resolveVmxForVmName('ghost', { templates: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('ghost');
      expect(r.error).toContain('env adopt');
    }
  });
});

describe('resolveVmxForEntry（1.3.7：down/rm/快照/回滚/guest-exec 的统一解析点）', () => {
  it('条目自带 vmx 字段优先（定位辅助），不碰 vmTemplates', () => {
    const entry = makeEntry({ id: 'kali', vmName: 'kali', vmx: 'D:\\vms\\kali.vmx' });
    expect(resolveVmxForEntry(entry, { templates: TEMPLATES }))
      .toEqual({ ok: true, vmx: 'D:\\vms\\kali.vmx' });
  });

  it('无 vmx 字段 → 回落 vmName→vmTemplates 探测', () => {
    const entry = makeEntry({ id: 'pwn-vm', vmName: 'pwn-vm' });
    expect(resolveVmxForEntry(entry, { templates: TEMPLATES }))
      .toEqual({ ok: true, vmx: VMX, templateUser: undefined });
  });

  it('vmName 缺失时回落 entry.id 探测', () => {
    const entry = makeEntry({ id: INSTANCE_NAME, vmName: undefined });
    expect(resolveVmxForEntry(entry, { templates: TEMPLATES }))
      .toEqual({ ok: true, vmx: VMX, templateUser: undefined });
  });

  it('非 vm 条目 / 解析不到 → ok:false', () => {
    const docker = makeEntry({ kind: 'docker', vmName: undefined });
    const r1 = resolveVmxForEntry(docker, { templates: TEMPLATES });
    expect(r1.ok).toBe(false);
    const ghost = makeEntry({ id: 'ghost', vmName: 'ghost' });
    const r2 = resolveVmxForEntry(ghost, { templates: {} });
    expect(r2.ok).toBe(false);
  });
});

describe('vmGuestExec orchestration', () => {
  const baseInput = { guestPassword: 'pw' };

  async function runHappy(overrides: {
    entry?: EnvironmentEntry;
    ctx?: Partial<HandlerContext>;
    command?: string;
  } = {}) {
    const hostTmpDir = makeTempRoot();
    const ctx: HandlerContext = {
      hostTmpDir,
      outContent: 'hello\n',
      codeContent: '0',
      runningVmx: [VMX],
      ...overrides.ctx,
    };
    const { exec, calls } = makeScriptedExec(ctx);
    const result = await vmGuestExec(
      overrides.entry ?? makeEntry(),
      overrides.command ?? 'echo hello',
      baseInput,
      { exec, hostTmpDir, runId: () => RUN_ID, templates: TEMPLATES },
    );
    return { result, calls, vmx: VMX, hostTmpDir };
  }

  it('happy path：list 运行中 → runProgramInGuest → copyFileFromGuest ×2 → 清理 ×2', async () => {
    const { result, calls, vmx, hostTmpDir } = await runHappy();
    expect(result).toEqual({ ok: true, stdout: 'hello\n', exitCode: 0 });

    // 调用序列：probe → list → runProgramInGuest → copy ×2 → delete ×2
    expect(calls.map((c) => c.join(' '))).toHaveLength(7);
    expect(calls[0]).toEqual(['vmrun', 'list']);
    expect(calls[1]).toEqual(['vmrun', '-T', 'ws', 'list']);

    const run = calls[2]!;
    expect(run.slice(0, 7)).toEqual(['vmrun', '-T', 'ws', '-gu', 'researcher', '-gp', 'pw']);
    expect(run[7]).toBe('runProgramInGuest');
    expect(run[8]).toBe(vmx);
    expect(run.slice(9, 13)).toEqual(['-activeWindow', '-interactive', '/bin/bash', '-c']);
    expect(run[13]).toBe(`( echo hello ) > ${GUEST_OUT} 2>&1; echo -n $? > ${GUEST_CODE}`);

    // copyFileFromGuest：guest 路径 → host 路径
    const copyOut = calls[3]!;
    expect(copyOut.slice(7, 10)).toEqual(['copyFileFromGuest', vmx, GUEST_OUT]);
    expect(copyOut[10]).toBe(join(hostTmpDir, `zhishi-exec-${RUN_ID}.out`));
    expect(calls[4]!.slice(7, 10)).toEqual(['copyFileFromGuest', vmx, GUEST_CODE]);

    // 清理：两个 guest 临时文件都删
    expect(calls[5]).toEqual(['vmrun', '-T', 'ws', '-gu', 'researcher', '-gp', 'pw', 'deleteFileInGuest', vmx, GUEST_OUT]);
    expect(calls[6]).toEqual(['vmrun', '-T', 'ws', '-gu', 'researcher', '-gp', 'pw', 'deleteFileInGuest', vmx, GUEST_CODE]);

    // host 侧临时文件也清了
    expect(existsSync(join(hostTmpDir, `zhishi-exec-${RUN_ID}.out`))).toBe(false);
    expect(existsSync(join(hostTmpDir, `zhishi-exec-${RUN_ID}.code`))).toBe(false);
  });

  it('guest 命令非零退出：通道 ok，exitCode 原样带回', async () => {
    const { result } = await runHappy({ ctx: { codeContent: '42' } });
    expect(result).toEqual({ ok: true, stdout: 'hello\n', exitCode: 42 });
  });

  it('非 vm 条目 / 有 address 的 VM → 引导错误', async () => {
    const r1 = await vmGuestExec(makeEntry({ kind: 'ssh', host: '10.0.0.8' }), 'id', baseInput, {});
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toContain('不是 VM');

    const r2 = await vmGuestExec(makeEntry({ address: '192.168.56.10' }), 'id', baseInput, {});
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toContain('zhishi env open');
  });

  it('缺 guest 密码 → 含「guest 密码」标记的错误（CLI 据此现场问密码）', async () => {
    const r = await vmGuestExec(makeEntry(), 'id', {}, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('guest 密码');
      expect(r.error).toContain('不落盘');
    }
  });

  it('VM 未在运行 → 清晰错误', async () => {
    const { result } = await runHappy({ ctx: { runningVmx: ['C:\\other\\x.vmx'] } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('未在运行');
  });

  it('Tools 未运行 → open-vm-tools 指引', async () => {
    const { result } = await runHappy({
      ctx: { runResult: fail('Error: VMware Tools are not running in the guest') },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('VMware Tools');
      expect(result.error).toContain('open-vm-tools');
    }
  });

  it('认证失败 → 含「guest 密码」标记', async () => {
    const { result } = await runHappy({
      ctx: { runResult: fail('Error: Invalid user name or password for the guest OS') },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('guest 密码');
  });

  it('copyFileFromGuest 失败 → 通道错误，guest 清理仍执行', async () => {
    const hostTmpDir = makeTempRoot();
    const calls: string[][] = [];
    const exec: VmExec = async (argv) => {
      calls.push(argv);
      const joined = argv.join(' ');
      if (argv.length === 2 && argv[1] === 'list') return ok('Total running VMs: 1\n');
      if (joined === 'vmrun -T ws list') return ok(`Total running VMs: 1\n${VMX}\n`);
      if (argv.includes('runProgramInGuest')) return ok();
      if (argv.includes('copyFileFromGuest')) return fail('Error: A file was not found');
      if (argv.includes('deleteFileInGuest')) return ok();
      throw new Error(`unexpected exec: ${joined}`);
    };
    const result = await vmGuestExec(makeEntry(), 'id', baseInput, {
      exec, hostTmpDir, runId: () => RUN_ID, templates: TEMPLATES,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('copyFileFromGuest');
    // 两个 deleteFileInGuest 收尾调用都在
    expect(calls.filter((c) => c.includes('deleteFileInGuest'))).toHaveLength(2);
  });

  it('模板 vmx 解析 + 模板 user 缺省值（entry/input 都没给 user）', async () => {
    const hostTmpDir = makeTempRoot();
    const { exec, calls } = makeScriptedExec({ hostTmpDir, outContent: '', codeContent: '0', runningVmx: [VMX] });
    const result = await vmGuestExec(
      makeEntry({ vmName: 'pwn-vm' }),
      'id',
      baseInput,
      {
        exec,
        hostTmpDir,
        runId: () => RUN_ID,
        templates: { 'pwn-vm': { vmx: VMX, user: 'tpluser' } },
      },
    );
    expect(result.ok).toBe(true);
    const run = calls[2]!;
    expect(run[4]).toBe('tpluser'); // -gu 取模板 user
    expect(run[8]).toBe(VMX);
  });

  it('input.guestUser 优先级最高；runProgramInGuest 超时默认 10 分钟', async () => {
    const hostTmpDir = makeTempRoot();
    const timeouts: number[] = [];
    const exec: VmExec = async (argv, timeoutMs) => {
      timeouts.push(timeoutMs);
      const joined = argv.join(' ');
      if (argv.length === 2 && argv[1] === 'list') return ok('Total running VMs: 1\n');
      if (joined === 'vmrun -T ws list') return ok(`Total running VMs: 1\n${VMX}\n`);
      if (argv.includes('runProgramInGuest')) {
        expect(argv[4]).toBe('analyst');
        return ok();
      }
      if (argv.includes('copyFileFromGuest')) {
        writeFileSync(argv[argv.length - 1]!, argv[argv.length - 2]!.endsWith('.code') ? '0' : '');
        return ok();
      }
      if (argv.includes('deleteFileInGuest')) return ok();
      throw new Error(`unexpected exec: ${joined}`);
    };
    const result = await vmGuestExec(makeEntry({ user: 'entryuser' }), 'id', {
      guestUser: 'analyst',
      guestPassword: 'pw',
    }, { exec, hostTmpDir, runId: () => RUN_ID, templates: TEMPLATES });
    expect(result.ok).toBe(true);
    expect(timeouts[2]).toBe(GUEST_EXEC_TIMEOUT_MS);
  });
});
