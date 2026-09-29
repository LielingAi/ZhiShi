/**
 * 1.8.7 P4 团队大脑——CLI 文件传输（file-transfer.ts）单测。
 * fetch 全注入（照 ref.unit.test.ts 惯例），绝不碰真实网络；本地文件走
 * mkdtemp 真临时目录（流式读写是本体，必须真盘）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  downloadRefToFile,
  uploadFileToServer,
  type TransferFetch,
  type TransferFetchResponse,
} from './file-transfer';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-cli-ft-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function jsonResponse(status: number, payload: unknown): TransferFetchResponse {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve(payload),
    body: null,
  };
}

describe('uploadFileToServer', () => {
  it('裸流 POST（query envId/envPath/name + Bearer + Content-Length），解析成功回包', async () => {
    const local = join(scratch, 'poc.txt');
    writeFileSync(local, 'upload-me-0123456789');
    const seen = { url: '', headers: {} as Record<string, string>, bodyText: '' };
    const fetchImpl: TransferFetch = vi.fn(async (url, init) => {
      seen.url = url;
      seen.headers = (init?.headers ?? {}) as Record<string, string>;
      const chunks: Buffer[] = [];
      for await (const c of init?.body as AsyncIterable<Buffer>) chunks.push(c);
      seen.bodyText = Buffer.concat(chunks).toString('utf-8');
      return jsonResponse(200, {
        success: true,
        data: { refId: 'aaaa1111', envId: 'e1', envPath: '/work/poc.txt', bytes: 21, sha256: 'ab'.repeat(32), via: 'docker-cp' },
      });
    });
    const r = await uploadFileToServer(
      { base: 'http://10.0.0.8:7411/', token: 'tok', fetchImpl },
      { envId: 'e1', localPath: local, envPath: '/work/poc.txt' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.via).toBe('docker-cp');
    const u = new URL(seen.url);
    expect(`${u.origin}`).toBe('http://10.0.0.8:7411');
    expect(u.pathname).toBe('/api/files/upload');
    expect(u.searchParams.get('envId')).toBe('e1');
    expect(u.searchParams.get('envPath')).toBe('/work/poc.txt');
    expect(u.searchParams.get('name')).toBe('poc.txt');
    expect(seen.headers['Authorization']).toBe('Bearer tok');
    expect(seen.headers['Content-Length']).toBe(String('upload-me-0123456789'.length));
    expect(seen.bodyText).toBe('upload-me-0123456789');
  });

  it('本地文件缺失 / 服务端错误 / 非 JSON 响应 → 可读错误', async () => {
    const fetchImpl: TransferFetch = vi.fn(async () => jsonResponse(500, { success: false, error: 'docker cp 传入失败' }));
    const missing = await uploadFileToServer(
      { base: 'http://x', fetchImpl },
      { envId: 'e1', localPath: join(scratch, 'nope.bin'), envPath: '/x' },
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('不存在');

    const local = join(scratch, 'f.txt');
    writeFileSync(local, 'x');
    const failed = await uploadFileToServer(
      { base: 'http://x', fetchImpl },
      { envId: 'e1', localPath: local, envPath: '/x' },
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toContain('docker cp 传入失败');
  });
});

describe('downloadRefToFile', () => {
  const content = Buffer.from('download-me-0123456789');
  const sha = createHash('sha256').update(content).digest('hex');

  function streamResponse(status: number, body: Buffer): TransferFetchResponse {
    return {
      status,
      statusText: 'OK',
      headers: { get: () => 'application/octet-stream' },
      json: () => Promise.reject(new Error('not json')),
      body: Readable.toWeb(Readable.from(body)),
    };
  }

  it('GET /refs/:id 流式落盘 + sha256 校验通过', async () => {
    const fetchImpl: TransferFetch = vi.fn(async () => streamResponse(200, content));
    const dest = join(scratch, 'out.bin');
    const r = await downloadRefToFile(
      { base: 'http://x', fetchImpl },
      { refId: 'dl000001', destPath: dest, expectedSha256: sha },
    );
    expect(r).toEqual({ ok: true, bytes: content.length, sha256: sha });
    expect(readFileSync(dest).equals(content)).toBe(true);
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('http://x/refs/dl000001');
  });

  it('sha256 不一致 → 报错并删除目标文件（不留静默损坏产物）', async () => {
    const fetchImpl: TransferFetch = vi.fn(async () => streamResponse(200, content));
    const dest = join(scratch, 'out.bin');
    const r = await downloadRefToFile(
      { base: 'http://x', fetchImpl },
      { refId: 'dl000001', destPath: dest, expectedSha256: 'ff'.repeat(32) },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('校验失败');
    expect(existsSync(dest)).toBe(false);
  });

  it('404（refs GC/TTL）→ 降级提示', async () => {
    const fetchImpl: TransferFetch = vi.fn(async () => streamResponse(404, Buffer.from('')));
    const r = await downloadRefToFile(
      { base: 'http://x', fetchImpl },
      { refId: 'dead0000', destPath: join(scratch, 'out.bin') },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不存在或已过期');
  });
});
