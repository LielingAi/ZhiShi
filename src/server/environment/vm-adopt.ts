/**
 * 安全研究员版 P2 V6 — 模板认领（template adopt）：把「已有系统的 VM」
 * 自动养成配方模板.
 *
 * 背景：用户机器上常已有装好系统的 VM，离模板只差三件事——能连上
 * （SSH）、能观测（VMware Tools）、有我们的钥匙（researcher 用户 + 公钥）。
 * adopt 把这三步自动化：
 *
 *   1. 校验 vmx + vmware 可用；VM 没在跑则 vmrun start（对原 VM 操作——
 *      认领的语义就是把这台 VM 养成模板，命令本身是人显式发起的）
 *   2. 拿地址：getGuestIPAddress（有 Tools）→ 兜底解析 VMware DHCP 租约
 *      文件（.vmx 的 MAC 反查，guest 零配合）
 *   3. 连通：优先公钥（BatchMode 探测）；不通且人现场输了密码 → plink
 *      密码通道（plink 缺失报安装引导）
 *   4. 初始化（guest 内全自动）：ensure openssh-server/open-vm-tools →
 *      建 researcher（NOPASSWD sudo）→ 写入公钥 → 跑配方 setup.sh
 *   5. 定型：关机（ssh poweroff，vmrun stop soft 兜底）→ snapshot
 *      zhishi-clean → 模板写入 config.json::vmTemplates（之后 env up 免
 *      --vm-base）
 *
 * 凭据红线（D-T4）：密码只经 CLI 现场输入 → POST 体瞬传 → 进程参数瞬现，
 * 绝不落盘；落盘的只有 keyPath 引用。
 *
 * 自动化地板：guest 至少要有 sshd 或 VMware Tools 之一；两者皆无的裸 VM
 * 报清晰错误（控制台手装 openssh-server 后再来）。v1 仅支持 apt 系
 * （Debian/Ubuntu）guest。
 *
 * 结构照 vm-lifecycle.ts：命令/脚本组装与输出解析是纯函数，进程调用走
 * 可注入 Exec，单测绝不真碰 vmrun/ssh/plink。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import { augmentedProcessEnv, resolveCommand } from '../utils/env-utils';
import { getZhiShiDataDir } from '../utils/app-dirs';
import { spawn as spawnSubprocess } from '../utils/subprocess';
import type { EnvironmentRecipe } from './recipes';
import { buildToolCheckScript, parseToolCheckOutput } from './recipes';
import {
  buildVmrunGetIpArgs,
  buildVmrunListArgs,
  buildVmrunSnapshotArgs,
  buildVmrunStartArgs,
  buildVmrunStopArgs,
  ensureVmwareAvailable,
  parseGuestIp,
  parseVmrunList,
  VMRUN_GET_IP_TIMEOUT_MS,
  VMRUN_LIST_TIMEOUT_MS,
  VMRUN_START_TIMEOUT_MS,
  VMRUN_STOP_TIMEOUT_MS,
  type EnvResult,
  type VmExec,
  type VmExecResult,
} from './vm-lifecycle';
import { resolveVmrunBinary } from './vmrun-path';

// 测试与调用方复用同一 exec 形态
export type { VmExec, VmExecResult } from './vm-lifecycle';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** config.json::vmTemplates 的条目——adopt 的产出，env up 的模板来源。 */
export interface VmTemplate {
  /** 模板 .vmx 绝对路径。 */
  vmx: string;
  /** guest 内 zhishi 运维用户（adopt 时创建）。 */
  user: string;
  /** 私钥路径引用（D-T4：只存引用）。 */
  keyPath: string;
  /** 干净现场快照名（adopt 收尾时创建）。 */
  snapshot: string;
  createdAt: string;
}

export interface AdoptInput {
  /** 模板 .vmx 绝对路径（已有系统的 VM）。 */
  vmx: string;
  /** guest 内现有用户（有 sudo）；缺省 researcher（已初始化过的 VM 直接复用）。 */
  user?: string;
  /** 私钥路径（连通探测用）；缺省按 ~/.ssh/id_ed25519 / id_rsa 探测。 */
  keyPath?: string;
  /** 现场输入的登录密码（瞬传，不落盘）；公钥不通时走 plink 密码通道。 */
  password?: string;
}

export interface AdoptOptions {
  exec?: VmExec;
  /**  leases 文件路径列表；默认按平台给 VMware 已知位置。测试传临时文件。 */
  leasePaths?: string[];
  /** 读取文件（测试注入）；默认 readFileSync utf-8。 */
  readFile?: (path: string) => string;
  /** 生成密钥对的落点目录；默认 ~/.zhishi/keys。 */
  keysDir?: string;
  /** plink 下载器（测试注入）；默认 undici fetch 官方直链。 */
  download?: PlinkDownload;
  /** plink 路径直给（测试注入）；缺省走 resolvePlinkBinary + 自动下载。 */
  plinkPath?: string;
}

/** adopt 成功产出：模板条目 + 过程摘要。 */
export interface AdoptOutcome {
  template: Omit<VmTemplate, 'createdAt'>;
  /** 拿到的 guest 地址（关机前最后一跳）。 */
  address: string;
  /** 实际使用的通道：key | password。 */
  channel: 'key' | 'password';
}

const RESEARCH_USER = 'researcher';
const SNAPSHOT_NAME = 'zhishi-clean';

// ---------------------------------------------------------------------------
// Pure functions — parsing / command & script assembly
// ---------------------------------------------------------------------------

/** 从 .vmx 文本取第一块网卡的 MAC（generatedAddress / address 都认）。 */
export function parseVmxMac(vmxContent: string): string | undefined {
  const match = vmxContent.match(/^\s*ethernet0\.(?:generatedAddress|address)\s*=\s*"([0-9a-fA-F:]{17})"/m);
  return match ? match[1].toLowerCase() : undefined;
}

/**
 * 解析 VMware DHCP 租约文件为 mac→ip 映射。格式：
 *   lease 192.168.126.130 {
 *     hardware ethernet 00:0c:29:ab:cd:ef;
 *     ...
 *   }
 * 同一 MAC 多条租约时后者覆盖前者（文件 appended 语义，新租约在后）。
 */
export function parseDhcpLeases(content: string): Map<string, string> {
  const byMac = new Map<string, string>();
  const leaseRe = /lease\s+((?:\d{1,3}\.){3}\d{1,3})\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = leaseRe.exec(content)) !== null) {
    const macMatch = /hardware\s+ethernet\s+([0-9a-fA-F:]{17})\s*;/.exec(match[2]);
    if (macMatch) byMac.set(macMatch[1].toLowerCase(), match[1]);
  }
  return byMac;
}

/** 平台相关的 VMware DHCP 租约文件已知位置。 */
export function defaultLeasePaths(): string[] {
  if (platform() === 'win32') {
    return [
      'C:\\ProgramData\\VMware\\vmnetdhcp.leases',
      'C:\\ProgramData\\VMware\\dhcp\\vmnetdhcp.leases',
    ];
  }
  return [
    '/etc/vmware/vmnet8/dhcpd/dhcpd.leases',
    '/etc/vmware/vmnet1/dhcpd/dhcpd.leases',
  ];
}

export interface SshTarget {
  user: string;
  address: string;
  keyPath?: string;
}

/** 公钥连通探测：BatchMode 绝不交互，10s 连接超时。 */
export function buildSshProbeArgs(target: SshTarget): string[] {
  const args = [
    'ssh',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
  ];
  if (target.keyPath) args.push('-i', target.keyPath);
  args.push(`${target.user}@${target.address}`, 'true');
  return args;
}

/** 公钥通道在 guest 内执行一段命令。 */
export function buildSshExecArgs(target: SshTarget, command: string): string[] {
  const args = [
    'ssh',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
  ];
  if (target.keyPath) args.push('-i', target.keyPath);
  args.push(`${target.user}@${target.address}`, command);
  return args;
}

/** 上传文件到 guest（配方 setup.sh → /tmp）。 */
export function buildScpArgs(localPath: string, target: SshTarget, remotePath: string): string[] {
  const args = ['scp', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  if (target.keyPath) args.push('-i', target.keyPath);
  args.push(localPath, `${target.user}@${target.address}:${remotePath}`);
  return args;
}

/**
 * 密码通道（plink）。`-batch` 禁交互；密码只在进程参数里瞬现（本机
 * 单用户开发机可接受，文档已声明），绝不写任何文件。
 * plinkPath 由 resolvePlinkBinary 给出（PATH 或 ~/.zhishi/bin/plink.exe）。
 * hostkeyFingerprints：plink 的 host key 缓存在注册表、与 OpenSSH known_hosts
 * 不通用，`-batch` 下未缓存即拒绝连接（2026-08-15 实测踩中）——用 ssh-keyscan
 * 取指纹、`-hostkey` 钉住（TOFU，语义对齐 ssh 的 accept-new）。**每个指纹一条
 * `-hostkey` flag**（plink 0.84 实测：逗号/分号拼接只认第一个，重复 flag 才全生效）。
 */
export function buildPlinkArgs(plinkPath: string, user: string, address: string, password: string, command: string, hostkeyFingerprints?: string[]): string[] {
  const args = [
    plinkPath, '-batch', '-ssh',
    '-pw', password,
  ];
  for (const fp of hostkeyFingerprints ?? []) args.push('-hostkey', fp);
  args.push(`${user}@${address}`, command);
  return args;
}

/**
 * 从 ssh-keyscan 的一行输出算 SHA256 指纹（纯 TS，免去 ssh-keygen -lf 的
 * 跨平台 stdin 差异）：fingerprint = base64(sha256(key blob)) 去尾部 '='。
 */
export function hostKeyFingerprintFromKeyscan(line: string): string | undefined {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3 || parts[0].startsWith('#')) return undefined;
  const blob = Buffer.from(parts[2], 'base64');
  if (blob.length === 0) return undefined;
  const fp = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return `SHA256:${fp}`;
}

/** 取 guest 全部 host key 指纹，keyscan 失败/无 key 返回 undefined。 */
async function resolveHostKeyFingerprints(exec: VmExec, address: string): Promise<string[] | undefined> {
  const scan = await exec(['ssh-keyscan', '-T', '10', '-t', 'ed25519,ecdsa,rsa', address], SSH_PROBE_TIMEOUT_MS);
  if (scan.exitCode !== 0 || scan.error) return undefined;
  const fps = scan.stdout
    .split('\n')
    .map(hostKeyFingerprintFromKeyscan)
    .filter((fp): fp is string => Boolean(fp));
  return fps.length > 0 ? fps : undefined;
}

/**
 * SSH 探测失败分类（纯函数）：
 * - transport：kex 之前断（connection reset/refused/timeout）——guest sshd
 *   坏了或没起，密码通道也救不了，应直接报 guest 修复指引；
 * - auth：Permission denied 等——认证问题，可走密码通道；
 * - unknown：其余。
 */
export function classifySshProbeFailure(result: VmExecResult): 'transport' | 'auth' | 'unknown' {
  const text = `${result.error ?? ''}\n${result.stderr}\n${result.stdout}`.toLowerCase();
  if (/connection (reset|refused)|timed out|no route to host|network is unreachable/.test(text)) {
    return 'transport';
  }
  if (/permission denied|authentication failed|auth fail/.test(text)) {
    return 'auth';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// plink 解析与自动下载（D-T2：只信 PuTTY 官方的 Authenticode 签名）
// ---------------------------------------------------------------------------

/** PuTTY 官方 w64 plink.exe 直链（the.earth.li 是 PuTTY 作者官方站点）。 */
export const PLINK_DOWNLOAD_URL = 'https://the.earth.li/~sgtatham/putty/latest/w64/plink.exe';

/** Authenticode 验证命令：输出 `Status|Subject` 供 parsePlinkSignature 判定。 */
export function buildPlinkVerifyArgs(plinkPath: string): string[] {
  const escaped = plinkPath.replace(/'/g, "''");
  return [
    'powershell', '-NoProfile', '-Command',
    `$s = Get-AuthenticodeSignature '${escaped}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`,
  ];
}

/** 验证输出判定：Status=Valid 且签发者是 Simon Tatham（PuTTY 作者）。 */
export function parsePlinkSignature(output: string): boolean {
  const [status, subject = ''] = output.trim().split('|');
  return status === 'Valid' && subject.includes('Simon Tatham');
}

let cachedPlink: string | undefined;

/** plink 解析：PATH 优先 → ~/.zhishi/bin/plink.exe；都没有返回 'plink'（ ENOENT 兜底）。 */
export function resolvePlinkBinary(): string {
  if (cachedPlink) return cachedPlink;
  const onPath = resolveCommand('plink');
  if (onPath !== 'plink' && existsSync(onPath)) {
    cachedPlink = onPath;
    return cachedPlink;
  }
  const bundled = join(getZhiShiDataDir(), 'bin', 'plink.exe');
  if (existsSync(bundled)) {
    cachedPlink = bundled;
    return cachedPlink;
  }
  return 'plink';
}

/** 测试钩子：清缓存。 */
export function resetPlinkBinaryCacheForTest(): void {
  cachedPlink = undefined;
}

export type PlinkDownload = (url: string, destPath: string) => Promise<void>;

/** 默认下载实现：undici fetch（与 provider-probe 同一网络栈）。 */
async function defaultPlinkDownload(url: string, destPath: string): Promise<void> {
  const { fetch } = await import('undici');
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const { writeFileSync: write, mkdirSync: mkdir } = await import('node:fs');
  const { dirname: dir } = await import('node:path');
  mkdir(dir(destPath), { recursive: true });
  write(destPath, Buffer.from(await resp.arrayBuffer()));
}

/**
 * 确保 plink 可用：PATH/自有 bin 已有 → 直接用；缺失 → 自动下载 PuTTY
 * 官方 plink.exe 到 ~/.zhishi/bin/ 并验 Authenticode 签名（Status=Valid
 * 且签发者 Simon Tatham），签名不过则删除文件报错。
 */
export async function ensurePlinkAvailable(
  exec: VmExec,
  download: PlinkDownload = defaultPlinkDownload,
  /** 测试注入：跳过 PATH/bin 探测，直接假定解析结果。 */
  currentPath: string = resolvePlinkBinary(),
  /** 测试注入：下载落点（默认 ~/.zhishi/bin/plink.exe）。测试必须给临时
   *  路径——签名失败分支会 rmSync 落点，默认路径会把真 plink 删掉
   *  （2026-08-15 实测踩中：单测把 ~/.zhishi/bin/plink.exe 删了）。 */
  destPath: string = join(getZhiShiDataDir(), 'bin', 'plink.exe'),
): Promise<EnvResult<{ path: string }>> {
  if (currentPath !== 'plink') return { ok: true, path: currentPath };

  const dest = destPath;
  try {
    await download(PLINK_DOWNLOAD_URL, dest);
  } catch (err) {
    return {
      ok: false,
      error:
        `公钥登录不通，密码通道需要 plink，自动下载失败：${err instanceof Error ? err.message : String(err)}\n` +
        '手动安装 PuTTY（https://www.putty.org）后重试。',
    };
  }

  const verify = await exec(buildPlinkVerifyArgs(dest), 30_000);
  if (verify.exitCode !== 0 || verify.error || !parsePlinkSignature(verify.stdout)) {
    try {
      rmSync(dest, { force: true });
    } catch { /* best effort */ }
    return {
      ok: false,
      error:
        'plink 已下载但 Authenticode 签名验证失败（非 Simon Tatham 有效签名），已删除。\n' +
        '这不该发生——请手动从 https://www.putty.org 安装 PuTTY 后重试，并反馈此问题。',
    };
  }

  cachedPlink = dest;
  return { ok: true, path: dest };
}

/**
 * guest 初始化脚本（apt 系）。以现有用户执行。幂等：重复执行安全。
 *
 * sudo 策略：密码通道在第一步 `echo pw | sudo -S true` **prime 一次凭据
 * 缓存**，之后全部用 `sudo -n`（同一 shell 内 ppid 时间戳缓存生效）。
 * 绝不能把 `echo pw | sudo -S` 插进数据管道中间——
 * `echo '数据' | echo 'pw' | sudo -S tee file` 里 echo 不转发 stdin，
 * 数据在管道中段丢失，tee 收到空流（2026-08-15 实测：authorized_keys
 * 和 sudoers.d 都被写成空文件，researcher 公钥自检 Permission denied）。
 */
export function buildProvisionScript(opts: { sudoPassword?: string; pubkey: string }): string {
  const prime = opts.sudoPassword ? `echo '${opts.sudoPassword.replace(/'/g, `'\\''`)}' | sudo -S` : 'sudo -n';
  const sudo = 'sudo -n'; // prime 之后全靠凭据缓存；数据管道绝不过 sudo -S
  return [
    'set -e',
    'command -v apt-get >/dev/null || { echo "UNSUPPORTED_GUEST: 仅支持 apt 系（Debian/Ubuntu）guest"; exit 42; }',
    `${prime} true 2>/dev/null || { echo "NO_SUDO: 当前用户无 sudo 权限或密码不对"; exit 43; }`,
    `id ${RESEARCH_USER} >/dev/null 2>&1 || ${sudo} useradd -m -s /bin/bash ${RESEARCH_USER}`,
    // useradd 不设密码 → shadow 是 '!'（锁定）→ sshd allowed_user() 拒绝该账号的
    // 一切登录（含公钥）。改成 '*'（无密码可登录但账号未锁），公钥通道才通。
    `${sudo} usermod -p '*' ${RESEARCH_USER}`,
    `echo '${RESEARCH_USER} ALL=(ALL) NOPASSWD:ALL' | ${sudo} tee /etc/sudoers.d/zhishi-${RESEARCH_USER} >/dev/null`,
    `${sudo} mkdir -p /home/${RESEARCH_USER}/.ssh`,
    `grep -qF '${opts.pubkey}' /home/${RESEARCH_USER}/.ssh/authorized_keys 2>/dev/null || echo '${opts.pubkey}' | ${sudo} tee -a /home/${RESEARCH_USER}/.ssh/authorized_keys >/dev/null`,
    `${sudo} chown -R ${RESEARCH_USER}:${RESEARCH_USER} /home/${RESEARCH_USER}/.ssh`,
    `${sudo} chmod 700 /home/${RESEARCH_USER}/.ssh && ${sudo} chmod 600 /home/${RESEARCH_USER}/.ssh/authorized_keys`,
    `dpkg -s openssh-server >/dev/null 2>&1 || { ${sudo} apt-get update -qq && ${sudo} apt-get install -y -qq openssh-server; }`,
    `dpkg -s open-vm-tools >/dev/null 2>&1 || { ${sudo} apt-get install -y -qq open-vm-tools || true; }`,
    'echo PROVISION_OK',
  ].join(' && \\\n  ');
}

/** 关机命令：guest 内 poweroff（researcher 有 NOPASSWD sudo）。 */
export function buildGuestPoweroffCommand(): string {
  return 'sudo -n poweroff';
}

/**
 * 配方工具自检（1.2.5「配」——adopt/build 共用）：声明的工具真在
 * guest 里才配定型——缺工具不做快照、直接报错（快照会把「坏现场」
 * 固化成模板）。setup.sh 之后、关机之前调，researcher 公钥通道。
 * tools 为空 → ok（无声明无需验，零额外 ssh 调用）。
 */
export async function runGuestToolCheck(
  exec: VmExec,
  target: SshTarget,
  recipe: EnvironmentRecipe,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (recipe.tools.length === 0) return { ok: true };
  const r = await exec(
    buildSshExecArgs(target, buildToolCheckScript(recipe.tools)),
    SSH_EXEC_TIMEOUT_MS,
  );
  if (r.error || r.exitCode !== 0) {
    return { ok: false, error: `配方工具自检通道失败（ssh）：${(r.error || r.stderr).trim() || '未知错误'}` };
  }
  const check = parseToolCheckOutput(r.stdout, recipe.tools);
  if (!check.ok) {
    return {
      ok: false,
      error:
        `配方 "${recipe.id}" 工具自检未过：声明了但 guest 里没有：${check.missing.join('、')}。\n` +
        '请在 guest 内补齐（或修正配方 SKILL.md 的 tools[] 声明）后重跑——不做快照，避免把不完整现场固化成模板。',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// I/O — default exec + key material
// ---------------------------------------------------------------------------

export const SSH_PROBE_TIMEOUT_MS = 20_000;
export const SSH_EXEC_TIMEOUT_MS = 10 * 60_000; // apt 装包可能慢
export const POWEROFF_WAIT_MS = 120_000;
export const POWEROFF_POLL_MS = 3_000;

async function defaultExec(argv: string[], timeoutMs: number): Promise<VmExecResult> {
  // vmrun/plink 特例：自定义安装路径或 ~/.zhishi/bin 的自有副本不进 PATH，兜底解析
  const binary = argv[0] === 'vmrun'
    ? resolveVmrunBinary()
    : argv[0] === 'plink'
      ? resolvePlinkBinary()
      : resolveCommand(argv[0]);
  const proc = spawnSubprocess([binary, ...argv.slice(1)], {
    env: augmentedProcessEnv(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (timedOut) {
      return { exitCode: -1, stdout, stderr, error: `timed out after ${timeoutMs}ms: ${argv.join(' ')}` };
    }
    if (proc.error) return { exitCode, stdout, stderr, error: proc.error.message };
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 选/造密钥对：--key-path 给定且 <path>.pub 存在 → 用之；否则现有默认
 * 密钥可用则复用；都没有 → ssh-keygen 生成 zhishi 自有对（落 keysDir）。
 * 返回 { keyPath（私钥）, pubkey（公钥内容） }。
 */
export async function ensureKeyMaterial(
  exec: VmExec,
  opts: { keyPath?: string; keysDir: string },
): Promise<EnvResult<{ keyPath: string; pubkey: string }>> {
  const candidates: string[] = [];
  if (opts.keyPath) candidates.push(opts.keyPath);
  candidates.push(join(homedir(), '.ssh', 'id_ed25519'), join(homedir(), '.ssh', 'id_rsa'));

  for (const key of candidates) {
    const pubPath = `${key}.pub`;
    if (existsSync(key) && existsSync(pubPath)) {
      return { ok: true, keyPath: key, pubkey: readFileSync(pubPath, 'utf-8').trim() };
    }
  }

  mkdirSync(opts.keysDir, { recursive: true });
  const keyPath = join(opts.keysDir, 'zhishi_vm_ed25519');
  if (!existsSync(keyPath)) {
    const gen = await exec(
      ['ssh-keygen', '-t', 'ed25519', '-N', '', '-C', 'zhishi-vm-template', '-f', keyPath],
      30_000,
    );
    if (gen.exitCode !== 0 || gen.error) {
      return { ok: false, error: `ssh-keygen 生成密钥失败：${gen.error ?? gen.stderr}` };
    }
  }
  return { ok: true, keyPath, pubkey: readFileSync(`${keyPath}.pub`, 'utf-8').trim() };
}

// ---------------------------------------------------------------------------
// Adopt orchestration
// ---------------------------------------------------------------------------

async function execOk(exec: VmExec, argv: string[], timeoutMs: number): Promise<boolean> {
  try {
    const r = await exec(argv, timeoutMs);
    return r.exitCode === 0 && !r.error;
  } catch {
    return false;
  }
}

/** 等 VM 从 vmrun list 里消失（poweroff 生效），超时返回 false。 */
async function waitUntilStopped(exec: VmExec, vmx: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await exec(['vmrun', ...buildVmrunListArgs()], VMRUN_LIST_TIMEOUT_MS);
    if (r.exitCode === 0 && !parseVmrunList(r.stdout).some((p) => p.toLowerCase() === vmx.toLowerCase())) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, POWEROFF_POLL_MS));
  }
  return false;
}

/** 拿 guest 地址：Tools 优先，DHCP 租约文件（MAC 反查）兜底。 */
async function resolveGuestAddress(
  exec: VmExec,
  vmx: string,
  opts: AdoptOptions,
): Promise<string | undefined> {
  const ipResult = await exec(['vmrun', ...buildVmrunGetIpArgs(vmx)], VMRUN_GET_IP_TIMEOUT_MS);
  if (ipResult.exitCode === 0 && !ipResult.error) {
    const ip = parseGuestIp(ipResult.stdout);
    if (ip) return ip;
  }
  // 兜底：.vmx MAC → DHCP 租约反查（guest 零配合，宿主本机文件）
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));
  let mac: string | undefined;
  try {
    mac = parseVmxMac(readFile(vmx));
  } catch {
    return undefined;
  }
  if (!mac) return undefined;
  for (const leasePath of opts.leasePaths ?? defaultLeasePaths()) {
    try {
      const ip = parseDhcpLeases(readFile(leasePath)).get(mac);
      if (ip) return ip;
    } catch {
      continue; // 文件不存在/不可读 → 下一个
    }
  }
  return undefined;
}

/**
 * 模板认领主流程。成功返回模板条目（调用方负责写 config）；任何一步
 * 失败返回用户可读错误（含下一步指引）。
 */
export async function vmTemplateAdopt(
  recipe: EnvironmentRecipe,
  input: AdoptInput,
  options: AdoptOptions = {},
): Promise<EnvResult<AdoptOutcome>> {
  if (recipe.base !== 'vm') {
    return { ok: false, error: `配方 "${recipe.id}" 不是 VM 配方（base: ${recipe.base ?? '?'}）` };
  }
  if (!/\.vmx$/i.test(input.vmx)) {
    return { ok: false, error: `template adopt 需要 .vmx 路径（收到："${input.vmx}"）` };
  }
  if (!existsSync(input.vmx)) {
    return { ok: false, error: `VM 不存在："${input.vmx}"` };
  }

  const exec = options.exec ?? defaultExec;

  const vmwareError = await ensureVmwareAvailable(exec);
  if (vmwareError) return { ok: false, error: vmwareError };

  // 1. 确保在跑
  const listResult = await exec(['vmrun', ...buildVmrunListArgs()], VMRUN_LIST_TIMEOUT_MS);
  const running = listResult.exitCode === 0
    && parseVmrunList(listResult.stdout).some((p) => p.toLowerCase() === input.vmx.toLowerCase());
  if (!running) {
    let startResult = await exec(['vmrun', ...buildVmrunStartArgs(input.vmx)], VMRUN_START_TIMEOUT_MS);
    if (startResult.exitCode !== 0 || startResult.error) {
      // 实测（2026-08-15）：vmrun start 偶发「未知错误」（挂起态残留/锁文件），
      // 同一命令立即重试即成功——失败时重试一次再报错。
      startResult = await exec(['vmrun', ...buildVmrunStartArgs(input.vmx)], VMRUN_START_TIMEOUT_MS);
    }
    if (startResult.exitCode !== 0 || startResult.error) {
      return { ok: false, error: `vmrun start 失败：\n${(startResult.stderr || startResult.stdout || startResult.error || '').trim()}` };
    }
  }

  // 2. 拿地址
  const address = await resolveGuestAddress(exec, input.vmx, options);
  if (!address) {
    return {
      ok: false,
      error:
        '拿不到 guest 地址。两条通道都不通：VMware Tools 未装（getGuestIPAddress 失败）' +
        '且 DHCP 租约里找不到它的 MAC（VM 无网络 / 非 NAT·Host-Only）。\n' +
        '请在 guest 控制台里确认网络已连（NAT 模式最省事），或装 open-vm-tools 后重试。',
    };
  }

  // 3. 连通：公钥优先，密码（plink）兜底
  const loginUser = input.user?.trim() || RESEARCH_USER;
  const keyMaterial = await ensureKeyMaterial(exec, {
    keyPath: input.keyPath,
    keysDir: options.keysDir ?? join(getZhiShiDataDir(), 'keys'),
  });
  if (!keyMaterial.ok) return { ok: false, error: keyMaterial.error };

  let channel: 'key' | 'password' | null = null;
  let plinkHostkey: string[] | undefined;
  const keyProbe = await exec(
    buildSshProbeArgs({ user: loginUser, address, keyPath: keyMaterial.keyPath }),
    SSH_PROBE_TIMEOUT_MS,
  );
  if (keyProbe.exitCode === 0 && !keyProbe.error) {
    channel = 'key';
  } else if (classifySshProbeFailure(keyProbe) === 'transport') {
    // kex 之前就被重置/拒绝——不是认证问题，是 guest 的 sshd 坏了或根本没起。
    // 密码通道也救不了（同样过不了 kex），直接给 guest 侧修复指引。
    return {
      ok: false,
      error:
        `guest 的 SSH 服务异常（${address}:22 在密钥交换前重置/拒绝连接）。\n` +
        '请在 guest 控制台检查：\n' +
        '  sudo ss -tlnp | grep :22        # 确认 22 上是 sshd\n' +
        '  sudo apt install -y openssh-server   # 没装就装\n' +
        '  sudo ssh-keygen -A && sudo systemctl restart ssh   # host key 缺失则重建\n' +
        '修好后重跑本命令。',
    };
  } else if (input.password) {
    const plink = options.plinkPath
      ? { ok: true as const, path: options.plinkPath }
      : await ensurePlinkAvailable(exec, options.download);
    if (!plink.ok) return { ok: false, error: plink.error };
    // plink 的 host key 缓存与 OpenSSH known_hosts 不通用，-batch 下未缓存
    // 即拒连——ssh-keyscan 取指纹、-hostkey 钉住（TOFU）。
    const hostkeyFp = await resolveHostKeyFingerprints(exec, address);
    if (!hostkeyFp) {
      return { ok: false, error: `取不到 ${address}:22 的 host key 指纹（ssh-keyscan 失败）——确认 guest sshd 在跑且宿主网络可达后重试` };
    }
    plinkHostkey = hostkeyFp;
    const probe = await exec(buildPlinkArgs(plink.path, loginUser, address, input.password, 'true', hostkeyFp), SSH_PROBE_TIMEOUT_MS);
    if (probe.exitCode !== 0 || probe.error) {
      return { ok: false, error: `密码登录失败（${loginUser}@${address}）：${(probe.stderr || probe.stdout).trim()}` };
    }
    channel = 'password';
  } else {
    return {
      ok: false,
      error:
        `SSH 公钥登录不通（${loginUser}@${address}）。\n` +
        '重新运行并在提示时输入该用户的登录密码（现场使用、不落盘），' +
        '或用 --user/--key-path 指定已有公钥登录的账号。',
    };
  }

  // 4. 初始化（guest 内）
  const provision = buildProvisionScript({
    sudoPassword: channel === 'password' ? input.password : undefined,
    pubkey: keyMaterial.pubkey,
  });
  const provisionArgv = channel === 'key'
    ? buildSshExecArgs({ user: loginUser, address, keyPath: keyMaterial.keyPath }, provision)
    : buildPlinkArgs(options.plinkPath ?? resolvePlinkBinary(), loginUser, address, input.password!, provision, plinkHostkey);
  const provisionResult = await exec(provisionArgv, SSH_EXEC_TIMEOUT_MS);
  const provisionOut = `${provisionResult.stdout}\n${provisionResult.stderr}`;
  if (provisionResult.exitCode !== 0 || provisionResult.error || !provisionOut.includes('PROVISION_OK')) {
    const hint = provisionOut.includes('UNSUPPORTED_GUEST')
      ? 'guest 不是 apt 系（v1 仅支持 Debian/Ubuntu）'
      : provisionOut.includes('NO_SUDO')
        ? `用户 ${loginUser} 没有可用 sudo（密码不对或未授权）`
        : provisionOut.trim().split('\n').slice(-5).join('\n');
    return { ok: false, error: `guest 初始化失败：${hint}` };
  }

  // 换 researcher + 公钥通道跑配方 setup.sh（若配方带）
  const researcherTarget: SshTarget = { user: RESEARCH_USER, address, keyPath: keyMaterial.keyPath };
  if (!(await execOk(exec, buildSshProbeArgs(researcherTarget), SSH_PROBE_TIMEOUT_MS))) {
    return { ok: false, error: 'researcher 用户已建但公钥登录自检失败——guest 初始化可能不完整，请检查 /etc/sudoers.d/zhishi-researcher 与 authorized_keys' };
  }
  if (existsSync(join(recipe.dir, 'setup.sh'))) {
    const scpOk = await execOk(
      exec,
      buildScpArgs(join(recipe.dir, 'setup.sh'), researcherTarget, '/tmp/zhishi-setup.sh'),
      SSH_EXEC_TIMEOUT_MS,
    );
    if (!scpOk) return { ok: false, error: 'setup.sh 上传 guest 失败（scp）' };
    const setupResult = await exec(
      buildSshExecArgs(researcherTarget, 'bash /tmp/zhishi-setup.sh'),
      SSH_EXEC_TIMEOUT_MS,
    );
    if (setupResult.exitCode !== 0 || setupResult.error) {
      return {
        ok: false,
        error: `配方 setup.sh 在 guest 内执行失败：\n${(setupResult.stderr || setupResult.stdout).trim().split('\n').slice(-8).join('\n')}`,
      };
    }
  }

  // 4.5 配方工具自检：缺工具不定型（不做快照、报错，避免固化坏现场）
  const toolCheck = await runGuestToolCheck(exec, researcherTarget, recipe);
  if (!toolCheck.ok) return toolCheck;

  // 5. 定型：关机 → 快照
  const poweroffArgv = buildSshExecArgs(researcherTarget, buildGuestPoweroffCommand());
  await exec(poweroffArgv, SSH_PROBE_TIMEOUT_MS).catch(() => undefined); // poweroff 会断连，失败无所谓
  if (!(await waitUntilStopped(exec, input.vmx, POWEROFF_WAIT_MS))) {
    const stopResult = await exec(['vmrun', ...buildVmrunStopArgs(input.vmx)], VMRUN_STOP_TIMEOUT_MS);
    if (stopResult.exitCode !== 0 || stopResult.error) {
      return { ok: false, error: `guest 关机失败（poweroff 与 vmrun stop soft 都不通）：${(stopResult.stderr || '').trim()}。请手动关机后重跑 adopt` };
    }
    if (!(await waitUntilStopped(exec, input.vmx, POWEROFF_WAIT_MS))) {
      return { ok: false, error: 'vmrun stop 已发但 VM 未退出运行列表，请手动确认后重跑 adopt' };
    }
  }

  const snapshotName = recipe.vmSnapshot ?? SNAPSHOT_NAME;
  const snapResult = await exec(['vmrun', ...buildVmrunSnapshotArgs(input.vmx, snapshotName)], VMRUN_START_TIMEOUT_MS);
  if (snapResult.exitCode !== 0 || snapResult.error) {
    return { ok: false, error: `快照 "${snapshotName}" 创建失败：\n${(snapResult.stderr || snapResult.stdout).trim()}` };
  }

  return {
    ok: true,
    template: { vmx: input.vmx, user: RESEARCH_USER, keyPath: keyMaterial.keyPath, snapshot: snapshotName },
    address,
    channel,
  };
}
