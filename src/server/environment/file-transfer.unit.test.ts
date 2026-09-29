/**
 * 1.8.7 P4 团队大脑——file-transfer 单测（spill 暂存 / 传输分派 / 上传路由）。
 *
 * 配置注入照 admin 测试惯例（临时 HOME + ~/.zhishi/config.json 播种）；
 * 进程执行（docker cp / scp）与 vmrun 通道全部走注入假通道，绝不真连环境；
 * spill 目录走 ZHISHI_FILES_DIR 隔离。
 *
 * 覆盖：sanitizeUploadName / stageUpload（哈希命名 + 去重 + 上限）/
 * sweepStaleSpillFiles / buildDockerCpArgv / putFileToEnv 与 takeFileFromEnv
 * 的 kind 分派（docker/scp/vmrun/local 拒绝）/ handleFileUpload 全链。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildDockerCpFromGuestArgv,
  buildDockerCpToGuestArgv,
  getFilesSpillDir,
  handleFileUpload,
  putFileToEnv,
  sanitizeUploadName,
  stageUpload,
  sweepStaleSpillFiles,
  takeFileFromEnv,
  UploadTooLargeError,
} from './file-transfer';
import type { EnvironmentEntry } from '../../shared/config-types';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let prevFilesDir: string | undefined;
let prevMaxBytes: string | undefined;

const DOCKER_ENTRY: EnvironmentEntry = {
  id: 'zhishi-env-pwn-1',
  kind: 'docker',
  container: 'zhishi-env-pwn-1',
  createdAt: '',
} as EnvironmentEntry;

function seedEntries(entries: EnvironmentEntry[]): void {
  writeFileSync(
    join(scratch, '.zhishi', 'config.json'),
    JSON.stringify({ environments: entries }),
    'utf-8',
  );
}

async function* chunksOf(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const p of parts) yield p;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-ft-'));
  mkdirSync(join(scratch, '.zhishi'), { recursive: true });
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  prevFilesDir = process.env.ZHISHI_FILES_DIR;
  prevMaxBytes = process.env.ZHISHI_FILES_MAX_BYTES;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
  process.env.ZHISHI_FILES_DIR = join(scratch, 'files');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const [key, val] of [
    ['HOME', prevHome],
    ['USERPROFILE', prevUserProfile],
    ['ZHISHI_FILES_DIR', prevFilesDir],
    ['ZHISHI_FILES_MAX_BYTES', prevMaxBytes],
  ] as const) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
});

describe('sanitizeUploadName', () => {
  it('剥目录成分 + 净化不安全字符 + 空名兜底', () => {
    expect(sanitizeUploadName('poc.txt')).toBe('poc.txt');
    expect(sanitizeUploadName('a/b/c.sh')).toBe('c.sh');
    expect(sanitizeUploadName('C:\\work\\poc.exe')).toBe('poc.exe');
    expect(sanitizeUploadName('my file<1>.bin')).toBe('my_file_1_.bin');
    expect(sanitizeUploadName('///')).toBe('file');
  });
});

describe('stageUpload', () => {
  it('按内容哈希命名落盘，回 {refId, bytes, sha256}', async () => {
    const content = Buffer.from('hello zhishi p4');
    const staged = await stageUpload(chunksOf(content, content), 'poc.txt');
    const sha = createHash('sha256').update(Buffer.concat([content, content])).digest('hex');
    expect(staged.sha256).toBe(sha);
    expect(staged.refId).toBe(sha.slice(0, 16));
    expect(staged.bytes).toBe(content.length * 2);
    expect(staged.name).toBe('poc.txt');
    expect(staged.path).toBe(join(getFilesSpillDir(), `${staged.refId}-poc.txt`));
    expect(existsSync(staged.path)).toBe(true);
  });

  it('同内容同尺寸去重：复用已有暂存（不重写，无第二个文件）', async () => {
    const content = Buffer.from('dedupe-me');
    const first = await stageUpload(chunksOf(content), 'x.bin');
    // 把已落盘的 mtime 拨旧，命中去重后应被 utimes 刷新。
    const old = new Date(Date.now() - 60_000);
    utimesSync(first.path, old, old);
    const second = await stageUpload(chunksOf(content), 'x.bin');
    expect(second.path).toBe(first.path);
    expect(readdirSync(getFilesSpillDir()).filter((f) => !f.startsWith('inbound-'))).toHaveLength(1);
    expect(Date.now() - statSync(first.path).mtimeMs).toBeLessThan(10_000);
  });

  it('超限断流 → UploadTooLargeError，tmp 残骸清除', async () => {
    const big = Buffer.alloc(64, 1);
    await expect(stageUpload(chunksOf(big, big, big), 'big.bin', { maxBytes: 100 }))
      .rejects.toBeInstanceOf(UploadTooLargeError);
    expect(existsSync(getFilesSpillDir()) ? readdirSync(getFilesSpillDir()) : []).toEqual([]);
  });
});

describe('sweepStaleSpillFiles', () => {
  it('清过期暂存与死 .tmp，留新鲜文件', async () => {
    const dir = getFilesSpillDir();
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, 'aaaa1111-old.bin');
    const fresh = join(dir, 'bbbb2222-new.bin');
    const tmpDead = join(dir, '.tmp-deadbeef');
    const tmpFresh = join(dir, '.tmp-alive');
    for (const f of [stale, fresh, tmpDead, tmpFresh]) writeFileSync(f, 'x');
    const ancient = new Date(Date.now() - 48 * 3600 * 1000);
    utimesSync(stale, ancient, ancient);
    utimesSync(tmpDead, new Date(Date.now() - 2 * 3600 * 1000), new Date(Date.now() - 2 * 3600 * 1000));
    await sweepStaleSpillFiles(24 * 3600 * 1000);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(tmpDead)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(tmpFresh)).toBe(true);
  });
});

describe('docker cp argv 构造', () => {
  it('双向严格镜像（传入宿主在前，取回容器在前）', () => {
    expect(buildDockerCpToGuestArgv('c1', '/h/f', '/g/f')).toEqual(['docker', 'cp', '/h/f', 'c1:/g/f']);
    expect(buildDockerCpFromGuestArgv('c1', '/g/f', '/h/dst')).toEqual(['docker', 'cp', 'c1:/g/f', '/h/dst']);
  });
});

describe('putFileToEnv / takeFileFromEnv 分派', () => {
  const okExec = vi.fn(async (_argv: string[], _t: number) => ({ exitCode: 0, stdout: '', stderr: '' }));

  beforeEach(() => okExec.mockClear());

  it('docker 条目 → docker cp（上传 hostPath→container，下载反向）', async () => {
    const put = await putFileToEnv(DOCKER_ENTRY, '/spill/abc-poc.txt', '/work/poc.txt', { exec: okExec });
    expect(put).toEqual({ ok: true, via: 'docker-cp' });
    expect(okExec.mock.calls[0]![0]).toEqual(['docker', 'cp', '/spill/abc-poc.txt', 'zhishi-env-pwn-1:/work/poc.txt']);

    const taken = await takeFileFromEnv(DOCKER_ENTRY, '/work/out.bin', '/dest', { exec: okExec });
    expect(taken).toEqual({ ok: true, savedPath: join('/dest', 'out.bin') });
    expect(okExec.mock.calls[1]![0]).toEqual(['docker', 'cp', 'zhishi-env-pwn-1:/work/out.bin', '/dest']);
  });

  it('ssh 条目 → scp（上传/取回 argv 与 push/extract 同构造）', async () => {
    const sshEntry = { id: 'target-x', kind: 'ssh', host: '10.0.0.8', user: 'root', createdAt: '' } as EnvironmentEntry;
    const put = await putFileToEnv(sshEntry, '/spill/f', '/tmp/f', { exec: okExec });
    expect(put).toEqual({ ok: true, via: 'scp' });
    const upArgv = okExec.mock.calls[0]![0];
    expect(upArgv[0]).toBe('scp');
    expect(upArgv.at(-2)).toBe('/spill/f');
    expect(upArgv.at(-1)).toBe('root@10.0.0.8:/tmp/f');

    const taken = await takeFileFromEnv(sshEntry, '/tmp/out.txt', '/dest', { exec: okExec });
    expect(taken.ok).toBe(true);
    const downArgv = okExec.mock.calls[1]![0];
    expect(downArgv[0]).toBe('scp');
    expect(downArgv.at(-2)).toBe('root@10.0.0.8:/tmp/out.txt');
    expect(downArgv.at(-1)).toBe('/dest');
  });

  it('断网 VM：上传走 vmrun 通道（注入）；取回不支持给可读错误', async () => {
    const vmEntry = { id: 'iso-vm', kind: 'vm', vmName: 'iso-vm', createdAt: '' } as EnvironmentEntry;
    const vmPush = vi.fn(async () => ({ ok: true as const, guestPath: 'C:/t/f' }));
    const put = await putFileToEnv(vmEntry, '/spill/f', 'C:/t/f', { vmPush, guest: { guestPassword: 'pw' } });
    expect(put).toEqual({ ok: true, via: 'vmrun' });
    expect(vmPush).toHaveBeenCalledOnce();

    const taken = await takeFileFromEnv(vmEntry, 'C:/t/f', '/dest', { exec: okExec });
    expect(taken.ok).toBe(false);
    if (!taken.ok) expect(taken.error).toContain('不支持取回');
  });

  it('本机环境（local）两个方向都拒绝（宿主读写不开旁路）', async () => {
    const localEntry = { id: 'local', kind: 'local', createdAt: '' } as unknown as EnvironmentEntry;
    const put = await putFileToEnv(localEntry, '/spill/f', '/tmp/f', { exec: okExec });
    expect(put.ok).toBe(false);
    const taken = await takeFileFromEnv(localEntry, '/tmp/f', '/dest', { exec: okExec });
    expect(taken.ok).toBe(false);
    expect(okExec).not.toHaveBeenCalled();
  });

  it('子进程失败 → 可读错误（不抛）', async () => {
    const failExec = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'boom\nlast-line' }));
    const put = await putFileToEnv(DOCKER_ENTRY, '/spill/f', '/tmp/f', { exec: failExec });
    expect(put.ok).toBe(false);
    if (!put.ok) expect(put.error).toContain('docker cp 传入失败');
  });
});

describe('handleFileUpload', () => {
  const okExec = vi.fn(async (_argv: string[], _t?: number) => ({ exitCode: 0, stdout: '', stderr: '' }));

  beforeEach(() => okExec.mockClear());

  it('全链：收流 → spill 暂存 → docker cp 进环境 → 回报', async () => {
    seedEntries([DOCKER_ENTRY]);
    const content = Buffer.from('poc-bytes-0123456789');
    const r = await handleFileUpload({
      body: chunksOf(content.subarray(0, 5), content.subarray(5)),
      envId: 'zhishi-env-pwn-1',
      envPath: '/work/poc.bin',
      name: 'poc.bin',
      transfer: { exec: okExec },
    });
    expect(r.status).toBe(200);
    const data = (r.body as { success: boolean; data: Record<string, unknown> }).data;
    const sha = createHash('sha256').update(content).digest('hex');
    expect(data).toMatchObject({
      refId: sha.slice(0, 16),
      envId: 'zhishi-env-pwn-1',
      envPath: '/work/poc.bin',
      bytes: content.length,
      sha256: sha,
      via: 'docker-cp',
    });
    // docker cp 的 hostPath（argv[2]）就是暂存文件（哈希命名），且文件仍在（TTL 清理策略，非即删）。
    const cpArgv = okExec.mock.calls[0]![0];
    expect(cpArgv[2]).toBe(join(getFilesSpillDir(), `${sha.slice(0, 16)}-poc.bin`));
    expect(existsSync(cpArgv[2]!)).toBe(true);
  });

  it('参数缺失 / 环境未找到 / body 缺失 → 4xx', async () => {
    seedEntries([DOCKER_ENTRY]);
    expect((await handleFileUpload({ body: null, envId: '', envPath: '/x' })).status).toBe(400);
    expect((await handleFileUpload({ body: chunksOf(Buffer.from('x')), envId: 'zhishi-env-pwn-1', envPath: '' })).status).toBe(400);
    expect((await handleFileUpload({ body: null, envId: 'zhishi-env-pwn-1', envPath: '/x' })).status).toBe(400);
    expect((await handleFileUpload({ body: chunksOf(Buffer.from('x')), envId: 'nope', envPath: '/x' })).status).toBe(404);
  });

  it('超限 → 413（ZHISHI_FILES_MAX_BYTES 可调）', async () => {
    seedEntries([DOCKER_ENTRY]);
    process.env.ZHISHI_FILES_MAX_BYTES = '10';
    const r = await handleFileUpload({
      body: chunksOf(Buffer.alloc(32, 7)),
      envId: 'zhishi-env-pwn-1',
      envPath: '/work/big.bin',
      transfer: { exec: okExec },
    });
    expect(r.status).toBe(413);
    expect(okExec).not.toHaveBeenCalled();
  });

  it('put 失败 → 500 + 机器错误透传（暂存保留供重试去重）', async () => {
    seedEntries([DOCKER_ENTRY]);
    const failExec = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'denied' }));
    const r = await handleFileUpload({
      body: chunksOf(Buffer.from('x')),
      envId: 'zhishi-env-pwn-1',
      envPath: '/work/f',
      transfer: { exec: failExec },
    });
    expect(r.status).toBe(500);
    expect(String((r.body as { error: string }).error)).toContain('docker cp 传入失败');
  });
});
