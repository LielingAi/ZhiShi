/**
 * W1 — vm 快照/回滚原语(environment/vm-snapshot.ts)unit tests。
 *
 * snapshot(缺省名/非法名/失败可读错误)、rollback(停机 VM 直接 revert;
 * 运行中 stop soft → revert → start;soft 失败补 hard;revert/重启失败
 * 可读错误)。exec 全注入,绝无真 vmrun。
 */
import { describe, expect, it, vi } from 'vitest';

import type { VmExecResult } from './vm-lifecycle';
import { defaultSnapshotName, rollbackVm, snapshotVm } from './vm-snapshot';

const VMX = 'D:\\vm\\pwn-vm\\pwn-vm.vmx';

function ok(stdout = ''): VmExecResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function fail(stderr: string): VmExecResult {
  return { exitCode: 1, stdout: '', stderr };
}

/** 记录 argv 序列的假 exec;routes 按子串匹配。 */
function fakeExec(routes: Array<{ match: string; result: VmExecResult }>) {
  const calls: string[][] = [];
  const exec = async (argv: string[], _timeout: number): Promise<VmExecResult> => {
    calls.push(argv);
    for (const route of routes) {
      if (argv.join(' ').includes(route.match)) return route.result;
    }
    return ok();
  };
  return { exec: exec as Parameters<typeof snapshotVm>[2] extends { exec?: infer E } ? E : never, calls } as {
    exec: (argv: string[], timeout: number) => Promise<VmExecResult>;
    calls: string[][];
  };
}

const NOT_RUNNING = 'Total running VMs: 0\n';
const RUNNING = `Total running VMs: 1\n${VMX}\n`;

describe('snapshotVm', () => {
  it('缺省名 zhishi-<ts>(now 注入),打 vmrun snapshot', async () => {
    const { exec, calls } = fakeExec([{ match: 'snapshot', result: ok() }]);
    const r = await snapshotVm(VMX, undefined, { exec, now: () => 1724000000000 });
    expect(r).toEqual({ ok: true, name: 'zhishi-1724000000000' });
    expect(calls[0]).toEqual(['vmrun', '-T', 'ws', 'snapshot', VMX, 'zhishi-1724000000000']);
  });

  it('显式名;非法名 → 可读错误不调 vmrun', async () => {
    const { exec, calls } = fakeExec([{ match: 'snapshot', result: ok() }]);
    const r = await snapshotVm(VMX, 'snap-clean', { exec });
    expect(r).toEqual({ ok: true, name: 'snap-clean' });
    const bad = await snapshotVm(VMX, 'bad name!', { exec });
    expect(bad.ok).toBe(false);
    expect((bad as { error: string }).error).toContain('非法');
    expect(calls).toHaveLength(1); // 非法名没打 vmrun
  });

  it('vmrun 失败 → 带输出尾的可读错误', async () => {
    const { exec } = fakeExec([{ match: 'snapshot', result: fail('Error: The virtual machine is busy') }]);
    const r = await snapshotVm(VMX, 's1', { exec });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('vmrun snapshot "s1" 失败');
    expect((r as { error: string }).error).toContain('virtual machine is busy');
  });

  it('挂起后成功(超时但 listSnapshots 已见)→ 复核为成功', async () => {
    const { exec, calls } = fakeExec([
      { match: 'snapshot ', result: fail('timed out after 60000ms: vmrun -T ws snapshot') },
      { match: 'listSnapshots', result: ok('Total snapshots: 2\nzhishi-clean\nhung-but-done\n') },
    ]);
    const r = await snapshotVm(VMX, 'hung-but-done', { exec });
    expect(r).toEqual({ ok: true, name: 'hung-but-done' });
    expect(calls.map((c) => c[3])).toEqual(['snapshot', 'listSnapshots']);
  });

  it('超时且 listSnapshots 也无此名 → 仍报失败', async () => {
    const { exec } = fakeExec([
      { match: 'snapshot ', result: fail('timed out after 60000ms') },
      { match: 'listSnapshots', result: ok('Total snapshots: 1\nzhishi-clean\n') },
    ]);
    const r = await snapshotVm(VMX, 'never-made', { exec });
    expect(r.ok).toBe(false);
  });

  it('defaultSnapshotName 形状', () => {
    expect(defaultSnapshotName(42)).toBe('zhishi-42');
  });
});

describe('rollbackVm', () => {
  it('停机 VM:list → revert,不 stop 不 start', async () => {
    const { exec, calls } = fakeExec([
      { match: 'list', result: ok(NOT_RUNNING) },
      { match: 'revertToSnapshot', result: ok() },
    ]);
    const r = await rollbackVm(VMX, 'snap-clean', { exec });
    expect(r).toEqual({ ok: true, snapshot: 'snap-clean', restarted: false });
    const verbs = calls.map((c) => c.join(' '));
    expect(verbs.some((v) => v.includes(' stop '))).toBe(false);
    expect(verbs.some((v) => v.includes('revertToSnapshot'))).toBe(true);
    expect(verbs.some((v) => v.includes(' start '))).toBe(false);
  });

  it('运行中:stop soft → revert → start nogui 恢复可用', async () => {
    const { exec, calls } = fakeExec([
      { match: 'list', result: ok(RUNNING) },
      { match: 'revertToSnapshot', result: ok() },
      { match: ' stop ', result: ok() },
      { match: ' start ', result: ok() },
    ]);
    // revert 后第二次 list 按 stopped 处理(快照存的是停机态)→ 触发 start
    let listCount = 0;
    const wrapped = async (argv: string[], t: number) => {
      if (argv.includes('list')) {
        listCount++;
        return ok(listCount === 1 ? RUNNING : NOT_RUNNING);
      }
      return exec(argv, t);
    };
    const r = await rollbackVm(VMX, 'snap-clean', { exec: wrapped });
    expect(r).toEqual({ ok: true, snapshot: 'snap-clean', restarted: true });
    const verbs = calls.map((c) => c.join(' '));
    const stopIdx = verbs.findIndex((v) => v.includes('stop'));
    const revertIdx = verbs.findIndex((v) => v.includes('revertToSnapshot'));
    const startIdx = verbs.findIndex((v) => v.includes('start') && !v.includes('revert'));
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(revertIdx).toBeGreaterThan(stopIdx);
    expect(startIdx).toBeGreaterThan(revertIdx);
  });

  it('soft stop 失败 → 自动补 hard', async () => {
    const verbs: string[] = [];
    const exec = async (argv: string[], _t: number): Promise<VmExecResult> => {
      verbs.push(argv.join(' '));
      if (argv.includes('list')) return ok(verbs.filter((v) => v.includes('list')).length === 1 ? RUNNING : NOT_RUNNING);
      if (argv.includes('soft')) return fail('Tools 无响应');
      return ok();
    };
    const r = await rollbackVm(VMX, 's1', { exec });
    expect(r.ok).toBe(true);
    expect(verbs.some((v) => v.includes('soft'))).toBe(true);
    expect(verbs.some((v) => v.includes('hard'))).toBe(true);
  });

  it('hard 也失败 → 可读错误,不 revert', async () => {
    const verbs: string[] = [];
    const exec = async (argv: string[], _t: number): Promise<VmExecResult> => {
      verbs.push(argv.join(' '));
      if (argv.includes('list')) return ok(RUNNING);
      if (argv.includes('stop')) return fail('boom');
      return ok();
    };
    const r = await rollbackVm(VMX, 's1', { exec });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('停止 VM 失败');
    expect(verbs.some((v) => v.includes('revertToSnapshot'))).toBe(false);
  });

  it('revert 失败 → 可读错误(带快照名与输出尾)', async () => {
    const { exec } = fakeExec([
      { match: 'list', result: ok(NOT_RUNNING) },
      { match: 'revertToSnapshot', result: fail('Error: Snapshot not found') },
    ]);
    const r = await rollbackVm(VMX, 'ghost', { exec });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('revertToSnapshot "ghost" 失败');
    expect((r as { error: string }).error).toContain('Snapshot not found');
    expect((r as { error: string }).error).toContain('listSnapshots');
  });

  it('空快照名 → 直接可读错误', async () => {
    const r = await rollbackVm(VMX, '  ', { exec: vi.fn() });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('缺少快照名');
  });
});
