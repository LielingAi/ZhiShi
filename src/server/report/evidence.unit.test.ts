/**
 * 1.2.0 — 证据批量回收（report/evidence.ts）unit tests。
 * exec 全注入(绝不真碰 scp);落盘目录用真临时目录。覆盖:未锚定/docker/
 * 环境不可达整批降级、单文件失败降级不拖垮整批、同路径去重、scp argv
 * 形态(与 environment/extract 同构)。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { EnvironmentEntry } from '../../shared/config-types';
import type { EnvExec } from '../loop/env-exec';
import { recoverEvidenceBatch, scpGuestFile } from './evidence';

const DIR = mkdtempSync(join(tmpdir(), 'zhishi-report-evidence-test-'));

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

const REFS = [
  { eventId: 1, guestPath: '/work/poc/exp.py' },
  { eventId: 2, guestPath: '/work/poc/flag.txt' },
];

function sshEntry(): EnvironmentEntry {
  return { id: 'vm1', kind: 'vm', address: '10.0.0.5', user: 'root', keyPath: '/keys/id', port: 2222 } as EnvironmentEntry;
}

const okExec: EnvExec = async () => ({ exitCode: 0, stdout: '', stderr: '' });

describe('recoverEvidenceBatch 整批降级', () => {
  it('未锚定环境(entry null) → 全部降级标注,不碰 exec', async () => {
    let called = 0;
    const exec: EnvExec = async () => { called++; return { exitCode: 0, stdout: '', stderr: '' }; };
    const results = await recoverEvidenceBatch(null, REFS, join(DIR, 'a'), exec);
    expect(called).toBe(0);
    expect(results.every((r) => r.status === 'degraded' && r.note!.includes('未锚定环境'))).toBe(true);
  });

  it('docker 环境 → 「docker 环境回收未支持」', async () => {
    const entry = { id: 'd1', kind: 'docker', container: 'c1' } as EnvironmentEntry;
    const results = await recoverEvidenceBatch(entry, REFS, join(DIR, 'b'), okExec);
    expect(results.every((r) => r.status === 'degraded' && r.note!.includes('docker 环境回收未支持'))).toBe(true);
  });

  it('ssh target 解析失败(VM 无地址) → 环境不可达降级', async () => {
    const entry = { id: 'vm-down', kind: 'vm' } as EnvironmentEntry;
    const results = await recoverEvidenceBatch(entry, REFS, join(DIR, 'c'), okExec);
    expect(results.every((r) => r.status === 'degraded' && r.note!.includes('环境不可达'))).toBe(true);
  });

  it('空清单 → 空结果(调用方跳过此步)', async () => {
    expect(await recoverEvidenceBatch(null, [], join(DIR, 'd'), okExec)).toEqual([]);
  });
});

describe('recoverEvidenceBatch 批量回收', () => {
  it('全部成功 → recovered + savedTo;scp argv 与 environment/extract 同构', async () => {
    const argvSeen: string[][] = [];
    const exec: EnvExec = async (argv) => { argvSeen.push(argv); return { exitCode: 0, stdout: '', stderr: '' }; };
    const destDir = join(DIR, 'ok');
    const results = await recoverEvidenceBatch(sshEntry(), REFS, destDir, exec);
    expect(results.every((r) => r.status === 'recovered')).toBe(true);
    expect(results[0].savedTo).toBe(join(destDir, 'exp.py'));
    expect(argvSeen).toHaveLength(2);
    expect(argvSeen[0]).toEqual([
      'scp',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes',
      '-i', '/keys/id',
      '-P', '2222',
      'root@10.0.0.5:/work/poc/exp.py',
      destDir,
    ]);
  });

  it('单文件失败 → 该文件降级(带 stderr 尾部),其余照常回收', async () => {
    const exec: EnvExec = async (argv) => {
      const src = argv[argv.length - 2];
      if (src.endsWith('flag.txt')) {
        return { exitCode: 1, stdout: '', stderr: 'line1\nline2\nscp: /work/poc/flag.txt: No such file or directory' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const results = await recoverEvidenceBatch(sshEntry(), REFS, join(DIR, 'partial'), exec);
    expect(results[0].status).toBe('recovered');
    expect(results[1].status).toBe('degraded');
    expect(results[1].note).toContain('scp 提取失败(exit=1)');
    expect(results[1].note).toContain('No such file or directory');
    expect(results[1].note).toContain('保留环境内路径');
  });

  it('同 guestPath 多事件登记 → 只 scp 一次,结果共享', async () => {
    let called = 0;
    const exec: EnvExec = async () => { called++; return { exitCode: 0, stdout: '', stderr: '' }; };
    const refs = [
      { eventId: 1, guestPath: '/work/same.poc' },
      { eventId: 2, guestPath: '/work/same.poc' },
    ];
    const results = await recoverEvidenceBatch(sshEntry(), refs, join(DIR, 'dedupe'), exec);
    expect(called).toBe(1);
    expect(results.map((r) => r.status)).toEqual(['recovered', 'recovered']);
  });
});

describe('scpGuestFile', () => {
  it('exec 抛异常 → 降级错误;进程级错误(error+exit<0)透传', async () => {
    const target = { destination: 'root@10.0.0.5', host: '10.0.0.5' };
    const boom = await scpGuestFile(target, '/x', join(DIR, 'e1'), async () => { throw new Error('spawn ENOENT'); });
    expect(boom.ok).toBe(false);
    expect(boom.error).toContain('spawn ENOENT');
    const procErr = await scpGuestFile(target, '/x', join(DIR, 'e2'), async () => ({
      exitCode: -1, stdout: '', stderr: '', error: 'timed out after 120000ms',
    }));
    expect(procErr.ok).toBe(false);
    expect(procErr.error).toContain('timed out');
  });
});
