/**
 * 1.8.7 P4 团队大脑——CLI 文件传输（zhishi env put-file / get-file）。
 *
 * 远端模式下客户端磁盘与服务器侧环境之间的那一截（sidecar 侧机器与边界
 * 语义见 server environment/file-transfer.ts 模块头）：
 *   put-file：本地文件裸流 POST /api/files/upload?envId&envPath&name
 *             （sidecar 落 spill 暂存 → push 机器进环境）；
 *   get-file：environment/extract-file 拿 {refId, sha256} → GET /refs/:id
 *             流式落本地盘 → sha256 校验（响应字节与 server 取回的一致性
 *             证据；不一致删文件报错，不留静默损坏的产物）。
 *
 * 设计纪律与 ref.ts/remote.ts 相同：fetch 可注入、不碰真实网络的单测；
 * token 只进 Authorization 头；大文件全程流式（上传 createReadStream /
 * 下载写盘流），200MB 不过内存。
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** 注入用的最小 fetch 形态（生产 = undici fetch；单测给假实现）。 */
export interface TransferFetchResponse {
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  /** 下载取流用（web ReadableStream；Node ≥22 可异步迭代/Readable.fromWeb）。 */
  body: unknown;
}

export type TransferFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    /** undici/Node fetch 发送流式 body 时必须（'half'）。 */
    duplex?: string;
    dispatcher?: unknown;
  },
) => Promise<TransferFetchResponse>;

export interface TransferHttpDeps {
  base: string;
  token?: string;
  fetchImpl: TransferFetch;
  dispatcher?: unknown;
}

export type UploadResult =
  | { ok: true; data: { refId: string; envId: string; envPath: string; bytes: number; sha256: string; via?: string } }
  | { ok: false; error: string };

/** 本地文件 → POST /api/files/upload（裸流 + Content-Length，免 chunked）。 */
export async function uploadFileToServer(
  deps: TransferHttpDeps,
  args: { envId: string; localPath: string; envPath: string },
): Promise<UploadResult> {
  let size: number;
  try {
    size = statSync(args.localPath).size;
  } catch {
    return { ok: false, error: `本地文件不存在或不可读：${args.localPath}` };
  }
  const root = deps.base.replace(/\/+$/, '');
  const query = new URLSearchParams({
    envId: args.envId,
    envPath: args.envPath,
    name: basename(args.localPath),
  });
  let res: TransferFetchResponse;
  const body = createReadStream(args.localPath);
  // 兜底 error 监听：fetch 提前应答后我们 destroy 未读完的流，迟到的底层
  // error（如调用方已清理目录后的 pending open ENOENT）不能变成 unhandled；
  // 消费方（undici/测试假 fetch）自己的错误处理不受影响（多监听共存）。
  body.on('error', () => { /* 见上 */ });
  try {
    res = await deps.fetchImpl(`${root}/api/files/upload?${query.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
        ...(deps.token ? { Authorization: `Bearer ${deps.token}` } : {}),
      },
      body,
      // 流式 body 的 undici 硬性要求（缺了抛 "duplex option is required"）。
      duplex: 'half',
      dispatcher: deps.dispatcher,
    });
  } catch (err) {
    body.destroy();
    return { ok: false, error: `上传请求失败：${err instanceof Error ? err.message : String(err)}` };
  }
  // 服务端可能未读完全部 body 就提前应答（413/权限闸等）——此时流仍未
  // 消费完，显式销毁防句柄泄漏与迟到的底层 error（幂等：已读完则 no-op）。
  body.destroy();
  let parsed: { success?: boolean; error?: string; data?: UploadResult extends { ok: true; data: infer D } ? D : never };
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    return { ok: false, error: `上传响应非 JSON（HTTP ${res.status} ${res.statusText}）` };
  }
  if (res.status < 200 || res.status >= 300 || !parsed.success || !parsed.data) {
    return { ok: false, error: parsed.error ?? `HTTP ${res.status} ${res.statusText}` };
  }
  return { ok: true, data: parsed.data };
}

export type DownloadResult =
  | { ok: true; bytes: number; sha256: string }
  | { ok: false; error: string };

/**
 * GET /refs/:id 流式落盘 + 边写边算 sha256；expectedSha256 给定时校验，
 * 不一致删目标文件（不留静默损坏的产物）。
 */
export async function downloadRefToFile(
  deps: TransferHttpDeps,
  args: { refId: string; destPath: string; expectedSha256?: string },
): Promise<DownloadResult> {
  const root = deps.base.replace(/\/+$/, '');
  let res: TransferFetchResponse;
  try {
    res = await deps.fetchImpl(`${root}/refs/${encodeURIComponent(args.refId)}`, {
      method: 'GET',
      headers: deps.token ? { Authorization: `Bearer ${deps.token}` } : undefined,
      dispatcher: deps.dispatcher,
    });
  } catch (err) {
    return { ok: false, error: `下载请求失败：${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.status === 404) {
    return { ok: false, error: `ref ${args.refId} 不存在或已过期（refs GC 回收，默认 TTL 1h）——重跑 get-file 取新 ref` };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, error: `下载失败：HTTP ${res.status} ${res.statusText}` };
  }
  if (!res.body) return { ok: false, error: '下载响应无 body' };
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    // web stream → node stream，边写盘边过哈希计数。
    const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    const hashing = async function* () {
      for await (const chunk of nodeStream) {
        const buf = chunk as Uint8Array;
        bytes += buf.byteLength;
        hash.update(buf);
        yield buf;
      }
    };
    await pipeline(Readable.from(hashing()), createWriteStream(args.destPath));
  } catch (err) {
    await rm(args.destPath, { force: true }).catch(() => undefined);
    return { ok: false, error: `写本地文件失败：${err instanceof Error ? err.message : String(err)}` };
  }
  const sha256 = hash.digest('hex');
  if (args.expectedSha256 && sha256 !== args.expectedSha256) {
    await rm(args.destPath, { force: true }).catch(() => undefined);
    return { ok: false, error: `下载校验失败（sha256 不一致，已删除 ${args.destPath}）——重跑 get-file` };
  }
  return { ok: true, bytes, sha256 };
}
