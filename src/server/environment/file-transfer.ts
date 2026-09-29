/**
 * 1.8.7 P4 团队大脑——文件传输（客户端磁盘 ↔ 服务器侧环境）。
 *
 * 背景：环境（docker/vm/ssh）跑在 sidecar 所在机器，既有 `environment/push`
 * / `environment/extract` 的端点是 **sidecar 本机路径**（docker cp / scp /
 * vmrun 都从 sidecar 发起）。远端客户端的文件在客户端机器上，因此需要一条
 * HTTP 上传/下载通道把「客户端磁盘」与「sidecar 本机」这一截接上，再接
 * 既有 push/extract 机器进/出环境。
 *
 * 字节流（两个方向）：
 *   上传  客户端 --HTTP POST 裸流--> /api/files/upload（本模块 handleFileUpload）
 *         --落 spill 暂存（~/.zhishi/spill/files/<hash16>-<name>）--> putFileToEnv
 *         （docker cp / scp 上传 / vmrun copyFileToGuest，与 push 同一批机器）
 *         --> 环境内 envPath。
 *   下载  environment/extract-file（admin-api handler）--> takeFileFromEnv
 *         （docker cp / scp 回收，与 extract 同一批机器）--> spill 暂存
 *         --> large-value-store.spillFileBody 落成 ref --> 客户端 GET /refs/:id
 *         （既有路由，流式回原始字节，auth=readonly）。
 *
 * 清理策略（选定：保留 + mtime 扫描，不选「put 成功即删」）：
 *   - 上传暂存按内容哈希命名去重——并发/重试的同内容上传共享同一份暂存，
 *     「put 后即删」会与正在读同一文件的另一路 put 竞争（删了别人正读的）；
 *   - 暂存盘占用由 TTL 扫描兜底（每次上传顺手扫，默认 24h mtime），与 refs
 *     的 TTL GC 同一哲学——refs 靠 meta.expiresAt，暂存是模块私有文件、
 *     mtime 即足够，不引入 meta 文件；
 *   - 下载暂存是过境的：spillFileBody 直接 rename 进 refs 目录，refs 自身
 *     TTL GC 收尾，暂存目录不留残骸。
 *
 * 边界语义（与设计稿 §P4 一致，审查看这里）：
 *   - 上传写入落在**环境内**（界内，快照可回滚），宿主侧只写受管 spill 目录
 *     ——与 environment/push 不过 boundary-ask 同口径，本通道同样不另设 ask；
 *   - 下载的落点是 **HTTP 响应**（+受管 refs 目录），不写宿主任意路径——
 *     environment/extract 的「写宿主 ask」语义不迁移到本通道（extract 的
 *     ask 针对的是 sidecar 本机交互提取落工作区，端点是宿主盘；这里的端点
 *     是网络响应，ask 无对象可问）；
 *   - 本机环境（kind=local）两个方向都拒绝：对 local 的「传输」等于读写
 *     sidecar 宿主任意路径，宿主读写必须留在 env exec 的既有语义里，不借
 *     文件传输开旁路。
 *
 * 大小上限：ZHISHI_FILES_MAX_BYTES（默认 200MB），上传边收边掐（超限断流
 * 删暂存），下载取回后 stat 掐。目录可用 ZHISHI_FILES_DIR 覆盖（测试隔离，
 * 照 ZHISHI_REFS_DIR 惯例）；TTL 用 ZHISHI_FILES_TTL_MS 覆盖。
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import type { EnvironmentEntry } from './registry';
import { findEnvironmentEntry, listEnvironmentsWithBuiltin } from './registry';
import { loadConfig } from '../utils/admin-config';
import { getZhiShiDataDir } from '../utils/app-dirs';
import {
  buildScpArgv,
  buildScpUploadArgv,
  defaultEnvExec,
  resolveSshTarget,
  type EnvExec,
  type EnvResult,
} from '../loop/env-exec';
import {
  vmPushToGuest,
  type GuestExecInput,
  type GuestExecTemplateRef,
} from './vm-guest-exec';

// ---------------------------------------------------------------------------
// spill 暂存（上传落盘 + 下载过境）
// ---------------------------------------------------------------------------

/** 默认上传/下载大小上限：200MB。 */
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
/** 默认暂存 TTL：24h（mtime 口径）。 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** 传输子进程超时：10 分钟（push/extract 的 120s 对大文件偏紧）。 */
const TRANSFER_TIMEOUT_MS = 600_000;

export function maxTransferBytes(): number {
  const raw = Number(process.env.ZHISHI_FILES_MAX_BYTES ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_BYTES;
}

function spillTtlMs(): number {
  const raw = Number(process.env.ZHISHI_FILES_TTL_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TTL_MS;
}

/** 受管暂存目录（懒创建；ZHISHI_FILES_DIR 覆盖供测试隔离）。 */
export function getFilesSpillDir(): string {
  const override = process.env.ZHISHI_FILES_DIR;
  if (override && override.length > 0) return override;
  return join(getZhiShiDataDir(), 'spill', 'files');
}

function ensureSpillDir(): string {
  const dir = getFilesSpillDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 文件名净化：剥离目录成分（防穿越），只留安全字符（Windows 保留字符
 * < > : " | ? * 全被 \w 排除），超长截断，空名兜底 'file'。
 */
export function sanitizeUploadName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\w.\-一-鿿]/g, '_').slice(0, 64);
  return cleaned || 'file';
}

/** 超限错误（路由层翻 413）。 */
export class UploadTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`文件超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB，ZHISHI_FILES_MAX_BYTES 可调）`);
    this.name = 'UploadTooLargeError';
  }
}

export interface StagedUpload {
  /** 内容哈希短 id（sha256 前 16 hex）——去重键，也随响应回客户端。 */
  refId: string;
  /** 暂存绝对路径（put 机器的 hostPath）。 */
  path: string;
  name: string;
  bytes: number;
  sha256: string;
}

/**
 * 上传落暂存：边收边写临时文件 + 边算 sha256 + 边掐上限；完成后按内容
 * 哈希命名（tmp → 原子 rename）。同哈希同尺寸已存在 → 去重复用（删 tmp、
 * 刷新 mtime 重置 TTL 钟），并发同内容上传共享同一份（见模块头清理策略）。
 */
export async function stageUpload(
  chunks: AsyncIterable<Uint8Array>,
  name: string,
  opts: { maxBytes?: number } = {},
): Promise<StagedUpload> {
  const maxBytes = opts.maxBytes ?? maxTransferBytes();
  const dir = ensureSpillDir();
  const tmp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const out = createWriteStream(tmp);
  // 兜底 error 监听：超限断流路径会 destroy 未完成的流，迟到的底层 error
  // （如测试清理拆掉父目录后 pending open 的 ENOENT）不能变成 unhandled；
  // 真实写错误由下方 drain/end 等待点的 once('error') 正常捕获。
  out.on('error', () => { /* 见上 */ });
  try {
    for await (const chunk of chunks) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        out.destroy();
        throw new UploadTooLargeError(maxBytes);
      }
      hash.update(chunk);
      if (!out.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          out.once('drain', resolve);
          out.once('error', reject);
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    out.destroy();
    rmSync(tmp, { force: true });
    throw err;
  }
  const sha256 = hash.digest('hex');
  const refId = sha256.slice(0, 16);
  const sanitized = sanitizeUploadName(name);
  const final = join(dir, `${refId}-${sanitized}`);
  try {
    if (existsSync(final) && statSync(final).size === bytes) {
      // 去重命中：内容哈希 + 尺寸双吻合即同一份（64bit 哈希截断的碰撞
      // 概率在本场景可忽略）；刷新 mtime 让 TTL 从本次使用起算。
      rmSync(tmp, { force: true });
      utimesSync(final, new Date(), new Date());
    } else {
      renameSync(tmp, final);
    }
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { refId, path: final, name: sanitized, bytes, sha256 };
}

/**
 * TTL 扫描：清掉 mtime 超过 TTL 的暂存文件与写废的 .tmp 残骸（.tmp 超过
 * 1h 即视为死写——正常一次上传不会跨小时）。每次上传顺手扫一遍（readdir
 * 代价可忽略），失败静默（下轮再扫）。
 */
export async function sweepStaleSpillFiles(ttlMs?: number): Promise<void> {
  const ttl = ttlMs ?? spillTtlMs();
  const dir = getFilesSpillDir();
  if (!existsSync(dir)) return;
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(entries.map(async (name) => {
    const full = join(dir, name);
    try {
      const st = await fsp.stat(full);
      if (!st.isFile()) return;
      const age = now - st.mtimeMs;
      const dead = name.startsWith('.tmp-') ? age > 60 * 60 * 1000 : age > ttl;
      if (dead) await fsp.rm(full, { force: true });
    } catch {
      /* best-effort */
    }
  }));
}

// ---------------------------------------------------------------------------
// 环境条目解析（上传路由与 extract-file handler 共用）
// ---------------------------------------------------------------------------

/** 按 id/容器名/别名解析登记条目（含内置 local 条目），未命中 → null。 */
export function resolveTransferEnv(envId: string): EnvironmentEntry | null {
  return findEnvironmentEntry(listEnvironmentsWithBuiltin(loadConfig()), envId) ?? null;
}

// ---------------------------------------------------------------------------
// 进/出环境的传输机器（复用 push/extract 的 argv 构造与 vmrun 通道）
// ---------------------------------------------------------------------------

/** docker cp 传入 argv（纯函数）：宿主文件 → 容器内路径。 */
export function buildDockerCpToGuestArgv(container: string, hostPath: string, envPath: string): string[] {
  return ['docker', 'cp', hostPath, `${container}:${envPath}`];
}

/** docker cp 取回 argv（纯函数）：容器内路径 → 宿主目录（与传入严格镜像）。 */
export function buildDockerCpFromGuestArgv(container: string, envPath: string, destDir: string): string[] {
  return ['docker', 'cp', `${container}:${envPath}`, destDir];
}

/** 环境内路径的 basename（兼容 Windows guest 的 `\` 分隔，照 extract 惯例）。 */
export function guestBasename(guestPath: string): string {
  return guestPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'file';
}

export interface TransferOptions {
  /** 测试注入进程执行（默认 defaultEnvExec——真实 docker cp / scp）。 */
  exec?: EnvExec;
  /** 测试注入 vmrun 传入通道（默认 vmPushToGuest——真实 vmrun）。 */
  vmPush?: typeof vmPushToGuest;
  /** 断网 VM 的 guest 凭据（瞬传，不落盘；只对 vmrun 通道有意义）。 */
  guest?: GuestExecInput;
  /** config.json::vmTemplates（vmrun 通道的模板解析）。 */
  templates?: Record<string, GuestExecTemplateRef>;
}

function execError(op: string, result: { exitCode: number; stdout: string; stderr: string; error?: string }): string {
  const tail = (result.stderr || result.stdout || result.error || '').trim().split('\n').slice(-3).join('\n');
  return `${op}(exit=${result.exitCode}):\n${tail}`;
}

/**
 * 宿主文件 → 环境（environment/push 的全 kind 补齐版：push 只覆盖
 * scp/vmrun，本函数补 docker cp——上传通道的环境覆盖面不能比 push 窄）。
 * kind=local 拒绝（见模块头边界语义）。
 */
export async function putFileToEnv(
  entry: EnvironmentEntry,
  hostPath: string,
  envPath: string,
  opts: TransferOptions = {},
): Promise<EnvResult<{ via: string }>> {
  if (entry.kind === 'local') {
    return { ok: false, error: `环境 "${entry.id}" 是本机环境——文件传输不服务宿主读写（宿主文件请直接用本机路径，远程成员经 env exec）` };
  }
  if (entry.kind === 'docker') {
    if (!entry.container) return { ok: false, error: `环境 "${entry.id}" 缺 container 字段（docker 条目必填）` };
    const exec = opts.exec ?? defaultEnvExec;
    const r = await exec(buildDockerCpToGuestArgv(entry.container, hostPath, envPath), TRANSFER_TIMEOUT_MS);
    if (r.exitCode !== 0 || r.error) return { ok: false, error: execError('docker cp 传入失败', r) };
    return { ok: true, via: 'docker-cp' };
  }
  // 断网 VM → vmrun 客户机通道（与 push 同通道；guest 密码瞬传不落盘）。
  if (entry.kind === 'vm' && !entry.address) {
    const vmPush = opts.vmPush ?? vmPushToGuest;
    const r = await vmPush(entry, hostPath, envPath, opts.guest ?? {}, { templates: opts.templates });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, via: 'vmrun' };
  }
  // 联网环境（ssh 条目 / 联网 VM）→ scp 上传（与 push 同 argv 构造）。
  const resolved = resolveSshTarget(entry);
  if (!resolved.ok) return { ok: false, error: `环境 "${entry.id}"（kind=${entry.kind}）不支持上传——${resolved.error}` };
  const exec = opts.exec ?? defaultEnvExec;
  const r = await exec(buildScpUploadArgv(resolved.target, hostPath, envPath), TRANSFER_TIMEOUT_MS);
  if (r.exitCode !== 0 || r.error) return { ok: false, error: execError('scp 传入失败', r) };
  return { ok: true, via: 'scp' };
}

/**
 * 环境 → 宿主目录（environment/extract 的全 kind 补齐版：补 docker cp；
 * 断网 VM 的 vmrun 取回与 extract 同覆盖面——不支持，给可读错误）。
 * kind=local 拒绝（见模块头边界语义）。
 */
export async function takeFileFromEnv(
  entry: EnvironmentEntry,
  envPath: string,
  destDir: string,
  opts: TransferOptions = {},
): Promise<EnvResult<{ savedPath: string }>> {
  if (entry.kind === 'local') {
    return { ok: false, error: `环境 "${entry.id}" 是本机环境——文件传输不服务宿主读写（远程成员经 env exec）` };
  }
  if (entry.kind === 'docker') {
    if (!entry.container) return { ok: false, error: `环境 "${entry.id}" 缺 container 字段（docker 条目必填）` };
    const exec = opts.exec ?? defaultEnvExec;
    const r = await exec(buildDockerCpFromGuestArgv(entry.container, envPath, destDir), TRANSFER_TIMEOUT_MS);
    if (r.exitCode !== 0 || r.error) return { ok: false, error: execError('docker cp 取回失败', r) };
    return { ok: true, savedPath: join(destDir, guestBasename(envPath)) };
  }
  const resolved = resolveSshTarget(entry);
  if (!resolved.ok) {
    return { ok: false, error: `环境 "${entry.id}"（kind=${entry.kind}）不支持取回——${resolved.error}（与 environment/extract 同覆盖面）` };
  }
  const exec = opts.exec ?? defaultEnvExec;
  const r = await exec(buildScpArgv(resolved.target, envPath, destDir), TRANSFER_TIMEOUT_MS);
  if (r.exitCode !== 0 || r.error) return { ok: false, error: execError('scp 取回失败', r) };
  return { ok: true, savedPath: join(destDir, guestBasename(envPath)) };
}

// ---------------------------------------------------------------------------
// 上传路由本体（POST /api/files/upload；index.ts 只做取参/透传）
// ---------------------------------------------------------------------------

export interface FileUploadInput {
  /** 请求裸字节流（request.body；空 body/GET 误打 → null）。 */
  body: AsyncIterable<Uint8Array> | null;
  envId: string;
  envPath: string;
  name?: string;
  /** 测试注入（exec/vmPush；HTTP 路由不传，走生产机器）。 */
  transfer?: TransferOptions;
}

export interface FileUploadHttpResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * 上传一站到底：收流 → 落暂存（哈希去重/上限）→ put 进环境 → 回报
 * {refId, envId, envPath, bytes, sha256}。角色闸在 roles.ts（operator）；
 * boundary 语义见模块头（界内写 + 受管目录，不设第二层 ask）。
 */
export async function handleFileUpload(input: FileUploadInput): Promise<FileUploadHttpResult> {
  const envId = input.envId.trim();
  const envPath = input.envPath.trim();
  if (!envId) return { status: 400, body: { success: false, error: 'Missing required query: envId' } };
  if (!envPath) return { status: 400, body: { success: false, error: 'Missing required query: envPath（环境内目标路径）' } };
  if (!input.body) return { status: 400, body: { success: false, error: 'Missing request body（文件字节流）' } };
  const entry = resolveTransferEnv(envId);
  if (!entry) return { status: 404, body: { success: false, error: `未找到环境 "${envId}"` } };
  // 顺手 TTL 扫描（fire-and-forget，不拖上传主链）。
  void sweepStaleSpillFiles();
  let staged: StagedUpload;
  try {
    staged = await stageUpload(input.body, input.name?.trim() || 'file');
  } catch (err) {
    if (err instanceof UploadTooLargeError) {
      return { status: 413, body: { success: false, error: err.message } };
    }
    return { status: 500, body: { success: false, error: `上传暂存失败：${err instanceof Error ? err.message : String(err)}` } };
  }
  const put = await putFileToEnv(entry, staged.path, envPath, input.transfer ?? {});
  if (!put.ok) {
    return { status: 500, body: { success: false, error: put.error } };
  }
  return {
    status: 200,
    body: {
      success: true,
      data: { refId: staged.refId, envId: entry.id, envPath, bytes: staged.bytes, sha256: staged.sha256, via: put.via },
    },
  };
}
