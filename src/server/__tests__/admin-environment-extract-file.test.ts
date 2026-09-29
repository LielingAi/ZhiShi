/**
 * 1.8.7 P4 团队大脑——environment/extract-file（文件下载第一步）接线测试。
 *
 * 配置注入照 admin 测试惯例（临时 HOME + ~/.zhishi/config.json 播种）；
 * 取回机器走 __setFileTakeForTests 假通道（在 destDir 写真文件，绝不真连
 * docker/ssh）；refs/spill 目录走 ZHISHI_REFS_DIR / ZHISHI_FILES_DIR 隔离。
 *
 * 覆盖：取回 → refs 化（spillFileBody 移动语义）→ {refId,name,bytes,sha256}
 * 回报 → GET /refs/:id 同源 fetchRef 可取回原始字节；错误面（环境未找到 /
 * 取回失败 / 目录 / 超限）；暂存目录不残留。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __setFileTakeForTests, handleEnvironmentExtractFile } from '../admin-api';
import { fetchRef } from '../utils/large-value-store';
import type { EnvironmentEntry } from '../../shared/config-types';

let scratch: string;
let saved: Record<string, string | undefined>;

const ENV_KEYS = ['HOME', 'USERPROFILE', 'ZHISHI_FILES_DIR', 'ZHISHI_REFS_DIR', 'ZHISHI_FILES_MAX_BYTES'] as const;

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

/** 假取回通道：在 destDir 落一个真文件（生产 = docker cp / scp）。 */
function fakeTake(content: Buffer | null) {
  return async (_entry: EnvironmentEntry, envPath: string, destDir: string) => {
    if (content === null) return { ok: false as const, error: 'scp 取回失败(exit=1):\nfake' };
    const name = envPath.split('/').pop() ?? 'out.bin';
    const savedPath = join(destDir, name);
    writeFileSync(savedPath, content);
    return { ok: true as const, savedPath };
  };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-xf-'));
  mkdirSync(join(scratch, '.zhishi'), { recursive: true });
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
  process.env.ZHISHI_FILES_DIR = join(scratch, 'files');
  process.env.ZHISHI_REFS_DIR = join(scratch, 'refs');
});

afterEach(() => {
  __setFileTakeForTests(null);
  rmSync(scratch, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('environment/extract-file', () => {
  it('取回 → refs 化 → 回报；ref 同源可取回原始字节，暂存不残留', async () => {
    seedEntries([DOCKER_ENTRY]);
    const content = Buffer.from('extracted-poc-bytes-0123456789');
    __setFileTakeForTests(fakeTake(content));
    const r = await handleEnvironmentExtractFile({ id: 'zhishi-env-pwn-1', envPath: '/work/out.bin' });
    expect(r.success).toBe(true);
    const data = r.data as { refId: string; name: string; bytes: number; sha256: string; expiresAt: number };
    const sha = createHash('sha256').update(content).digest('hex');
    expect(data.name).toBe('out.bin');
    expect(data.bytes).toBe(content.length);
    expect(data.sha256).toBe(sha);
    expect(data.refId).toMatch(/^[a-f0-9]{8,32}$/);
    // 客户端第二步（GET /refs/:id 同源）：原始字节可取回。
    const ref = await fetchRef(data.refId);
    expect(ref).not.toBeNull();
    expect(Buffer.from(ref!.data).equals(content)).toBe(true);
    expect(ref!.mimetype).toBe('application/octet-stream');
    // 移动语义：暂存目录不残留（inbound-* 摘净），refs 目录有 body + meta。
    const filesDir = join(scratch, 'files');
    expect(existsSync(filesDir) ? readdirSync(filesDir) : []).toEqual([]);
    expect(readdirSync(join(scratch, 'refs')).sort()).toEqual([data.refId, `${data.refId}.meta.json`].sort());
  });

  it('环境未找到 / 参数缺失 → 可读错误', async () => {
    seedEntries([DOCKER_ENTRY]);
    expect((await handleEnvironmentExtractFile({ id: '', envPath: '/x' })).success).toBe(false);
    expect((await handleEnvironmentExtractFile({ id: 'zhishi-env-pwn-1', envPath: '' })).success).toBe(false);
    const r = await handleEnvironmentExtractFile({ id: 'nope', envPath: '/x' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('未找到环境');
  });

  it('取回通道失败 → 错误透传，不落 ref', async () => {
    seedEntries([DOCKER_ENTRY]);
    __setFileTakeForTests(fakeTake(null));
    const r = await handleEnvironmentExtractFile({ id: 'zhishi-env-pwn-1', envPath: '/work/out.bin' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('取回失败');
    expect(existsSync(join(scratch, 'refs')) ? readdirSync(join(scratch, 'refs')) : []).toEqual([]);
  });

  it('目录取回 → 拒绝（仅单文件）', async () => {
    seedEntries([DOCKER_ENTRY]);
    __setFileTakeForTests(async (_e, envPath, destDir) => {
      const savedPath = join(destDir, 'outdir');
      mkdirSync(savedPath, { recursive: true });
      return { ok: true as const, savedPath };
    });
    const r = await handleEnvironmentExtractFile({ id: 'zhishi-env-pwn-1', envPath: '/work/outdir' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('不是单个文件');
  });

  it('超限 → 拒绝（ZHISHI_FILES_MAX_BYTES 可调）', async () => {
    seedEntries([DOCKER_ENTRY]);
    process.env.ZHISHI_FILES_MAX_BYTES = '10';
    __setFileTakeForTests(fakeTake(Buffer.alloc(32, 9)));
    const r = await handleEnvironmentExtractFile({ id: 'zhishi-env-pwn-1', envPath: '/work/big.bin' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('大小上限');
  });
});
