/**
 * 安全研究员版 P2 V7 — 模板构建（template build）：从零自动构建 VM 模板.
 *
 * 与 adopt（认领已有 VM）互补：机器上没有现成 VM 时，build 用 Ubuntu
 * Server ISO + autoinstall 无人值守安装出一条模板：
 *
 *   1. ISO 就位：--iso 直给优先；否则下载 Ubuntu Server 24.04 LTS
 *      （noble）live-server amd64 到 ~/.zhishi/iso/ 缓存，拉同目录
 *      SHA256SUMS 校验，不过即删（已存在且校验通过则复用）
 *   2. 生成 autoinstall seed：user-data（identity 锁密码、researcher 用户
 *      NOPASSWD sudo、写公钥、装 openssh-server/open-vm-tools）+ meta-data
 *      （随机 instance-id），iso9660.ts 打成卷标 cidata 的 Joliet ISO
 *   3. 建盘建 VM：vmware-vdiskmanager 建 lsilogic 盘；buildTemplateVmx
 *      以实测可启动的迷你 vmx 字段集为底，OS ISO 挂 sata0:0、seed 挂
 *      sata0:1、bios.bootOrder 带 cdrom；模板落 ~/.zhishi/vm-templates/
 *      <recipe-id>/（与 vm-instances 区分）
 *   4. vmrun start（失败重试一次——实测挂起态残留首发「未知错误」）
 *   5. 等装完：getGuestIPAddress -wait（autoinstall 装 open-vm-tools，
 *      Tools 上报即通）→ 轮询 ssh probe，总 deadline 45 分钟
 *   6. 配方带 setup.sh → scp + ssh 执行（researcher NOPASSWD sudo 已由
 *      autoinstall 配好）
 *   7. 定型：ssh sudo -n poweroff → 等退出运行列表 → snapshot
 *
 * 结构照 vm-lifecycle.ts / vm-adopt.ts：命令组装、seed/vmx/ISO 生成是纯
 * 函数；进程调用走可注入 exec，下载可注入 download，单测绝不真碰
 * vmrun/ssh/网络。
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';

import { dump as yamlDump } from 'js-yaml';

import { augmentedProcessEnv, resolveCommand } from '../utils/env-utils';
import { getZhiShiDataDir } from '../utils/app-dirs';
import { spawn as spawnSubprocess } from '../utils/subprocess';
import { buildIso9660 } from './iso9660';
import type { EnvironmentRecipe } from './recipes';
import { buildToolCheckScript, parseToolCheckOutput } from './recipes';
import {
  buildGuestPoweroffCommand,
  buildScpArgs,
  buildSshExecArgs,
  buildSshProbeArgs,
  ensureKeyMaterial,
  POWEROFF_POLL_MS,
  POWEROFF_WAIT_MS,
  runGuestToolCheck,
  SSH_EXEC_TIMEOUT_MS,
  SSH_PROBE_TIMEOUT_MS,
  type SshTarget,
  type VmTemplate,
} from './vm-adopt';
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

export interface BuildInput {
  /** OS ISO 本地路径（优先；缺省自动下载 Ubuntu Server 24.04 到缓存）。 */
  isoPath?: string;
  /** 系统盘大小（GB），缺省 40。 */
  diskGb?: number;
  /** 内存（MB），缺省 2048。 */
  memMb?: number;
  /** vCPU 数，缺省 2。 */
  cpus?: number;
}

export type IsoDownload = (url: string, destPath: string) => Promise<void>;

export interface BuildOptions {
  exec?: VmExec;
  /** ISO/SHA256SUMS 下载器（测试注入）；默认 undici fetch。 */
  download?: IsoDownload;
  /** 时钟注入（deadline 计算）；默认 Date.now。 */
  now?: () => number;
  /** 轮询间隔注入；默认真 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  /** 模板落点根目录；默认 ~/.zhishi/vm-templates。 */
  templatesRoot?: string;
  /** ISO 缓存目录；默认 ~/.zhishi/iso。 */
  isoCacheDir?: string;
  /** 密钥对落点目录；默认 ~/.zhishi/keys。 */
  keysDir?: string;
  /** 安装等待总 deadline；默认 45 分钟（autoinstall 实机 20-40 分钟属正常）。 */
  installDeadlineMs?: number;
}

/** build 成功产出：模板条目 + 关机前最后一跳地址（照 AdoptOutcome 形态）。 */
export interface BuildOutcome {
  template: Omit<VmTemplate, 'createdAt'>;
  address: string;
}

const RESEARCH_USER = 'researcher';
const SNAPSHOT_NAME = 'zhishi-clean';

export const UBUNTU_ISO_FILENAME = 'ubuntu-24.04.2-live-server-amd64.iso';
export const UBUNTU_ISO_URL = `https://releases.ubuntu.com/24.04/${UBUNTU_ISO_FILENAME}`;
export const UBUNTU_SHA256SUMS_URL = 'https://releases.ubuntu.com/24.04/SHA256SUMS';

export const INSTALL_DEADLINE_MS = 45 * 60_000;
export const INSTALL_POLL_MS = 15_000;
const VDISK_CREATE_TIMEOUT_MS = 120_000;

const DEFAULT_DISK_GB = 40;
const DEFAULT_MEM_MB = 2048;
const DEFAULT_CPUS = 2;

// ---------------------------------------------------------------------------
// Pure functions — SHA256SUMS 解析 / autoinstall seed / vmx / 命令组装
// ---------------------------------------------------------------------------

/**
 * 解析 SHA256SUMS 取指定文件的期望哈希。行格式：
 *   <64hex> *ubuntu-24.04.2-live-server-amd64.iso
 * 未命中返回 undefined。
 */
export function parseSha256Sums(text: string, filename: string): string | undefined {
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^([0-9a-fA-F]{64}) \*?(.+)$/);
    if (match && match[2].trim() === filename) {
      return match[1].toLowerCase();
    }
  }
  return undefined;
}

/**
 * autoinstall user-data（cloud-init NoCloud）。要点：
 * - identity.password 锁死（'*' = 无可用密码哈希）——只允许密钥登录；
 * - identity.sudo 给 researcher NOPASSWD（setup.sh / poweroff 都要）；
 * - ssh.install-server + authorized-keys 写公钥；
 * - packages 装 openssh-server + open-vm-tools（后者让 getGuestIPAddress 通）。
 */
export function buildAutoinstallUserData(opts: {
  hostname: string;
  username?: string;
  pubkey: string;
}): string {
  const username = opts.username ?? RESEARCH_USER;
  const body = yamlDump({
    autoinstall: {
      version: 1,
      identity: {
        hostname: opts.hostname,
        username,
        password: '*',
        sudo: 'ALL=(ALL) NOPASSWD:ALL',
      },
      ssh: {
        'install-server': true,
        'authorized-keys': [opts.pubkey],
      },
      packages: ['openssh-server', 'open-vm-tools'],
    },
  });
  return `#cloud-config\n${body}`;
}

/** autoinstall meta-data：instance-id 随机 hex（重复实例触发 cloud-init 重跑）。 */
export function buildAutoinstallMetaData(opts: { instanceId: string }): string {
  return `instance-id: ${opts.instanceId}\n`;
}

/** 打出 NoCloud seed ISO（卷标 cidata，user-data + meta-data，Joliet 真名）。 */
export function buildSeedIso(opts: { hostname: string; pubkey: string; instanceId: string }): Buffer {
  return buildIso9660({
    volumeId: 'cidata',
    files: [
      {
        name: 'user-data',
        content: Buffer.from(buildAutoinstallUserData({ hostname: opts.hostname, pubkey: opts.pubkey }), 'utf-8'),
      },
      {
        name: 'meta-data',
        content: Buffer.from(buildAutoinstallMetaData({ instanceId: opts.instanceId }), 'utf-8'),
      },
    ],
  });
}

/**
 * 模板 vmx 生成器。字段集以实测可启动的迷你 vmx 为底（.encoding /
 * config.version / virtualHW.version / guestOS / memsize / numvcpus /
 * firmware / powerType 四件套 / scsi0 lsilogic / ethernet0 nat e1000e
 * generated / pciBridge0/4/5/6/7 / vmci0 / hpet0——缺字段会报「无法读取
 * 虚拟机的配置文件」），另加两个 CD-ROM：OS ISO 挂 sata0:0、seed 挂
 * sata0:1，bios.bootOrder 带 cdrom 保证从安装介质引导。
 * diskFile 用相对名（与 vmx 同目录），ISO 用绝对路径。
 */
export function buildTemplateVmx(opts: {
  name: string;
  diskFile: string;
  osIsoPath: string;
  seedIsoPath: string;
  memMb: number;
  cpus: number;
}): string {
  return [
    '.encoding = "UTF-8"',
    'config.version = "8"',
    `displayName = "${opts.name}"`,
    'guestOS = "ubuntu-64"',
    `memsize = "${opts.memMb}"`,
    `numvcpus = "${opts.cpus}"`,
    'firmware = "bios"',
    'powerType.powerOff = "soft"',
    'powerType.powerOn = "soft"',
    'powerType.suspend = "soft"',
    'powerType.reset = "soft"',
    'scsi0.present = "TRUE"',
    'scsi0.virtualDev = "lsilogic"',
    'scsi0:0.present = "TRUE"',
    `scsi0:0.fileName = "${opts.diskFile}"`,
    'scsi0:0.deviceType = "disk"',
    'sata0.present = "TRUE"',
    'sata0:0.present = "TRUE"',
    `sata0:0.fileName = "${opts.osIsoPath}"`,
    'sata0:0.deviceType = "cdrom-image"',
    'sata0:0.startConnected = "TRUE"',
    'sata0:1.present = "TRUE"',
    `sata0:1.fileName = "${opts.seedIsoPath}"`,
    'sata0:1.deviceType = "cdrom-image"',
    'sata0:1.startConnected = "TRUE"',
    'bios.bootOrder = "cdrom,hdd"',
    'ethernet0.present = "TRUE"',
    'ethernet0.connectionType = "nat"',
    'ethernet0.virtualDev = "e1000e"',
    'ethernet0.addressType = "generated"',
    'pciBridge0.present = "TRUE"',
    'pciBridge4.present = "TRUE"',
    'pciBridge4.virtualDev = "pcieRootPort"',
    'pciBridge4.functions = "8"',
    'pciBridge5.present = "TRUE"',
    'pciBridge5.virtualDev = "pcieRootPort"',
    'pciBridge5.functions = "8"',
    'pciBridge6.present = "TRUE"',
    'pciBridge6.virtualDev = "pcieRootPort"',
    'pciBridge6.functions = "8"',
    'pciBridge7.present = "TRUE"',
    'pciBridge7.virtualDev = "pcieRootPort"',
    'pciBridge7.functions = "8"',
    'vmci0.present = "TRUE"',
    'hpet0.present = "TRUE"',
    'virtualHW.version = "21"',
    '',
  ].join('\n');
}

/** vmware-vdiskmanager 建盘参数：-t 0 单文件可增长盘，lsilogic 适配器。 */
export function buildVdiskmanagerCreateArgs(diskPath: string, diskGb: number): string[] {
  return ['-c', '-s', `${diskGb}GB`, '-t', '0', '-a', 'lsilogic', diskPath];
}

/**
 * vdiskmanager 与 vmrun 同目录（Workstation 安装目录）。Windows 从
 * resolveVmrunBinary 的目录取 vmware-vdiskmanager.exe；非 Windows 退化
 * 同名裸命令（PATH 解析）。
 */
export function resolveVdiskmanagerBinary(): string {
  if (platform() === 'win32') {
    return join(dirname(resolveVmrunBinary()), 'vmware-vdiskmanager.exe');
  }
  return 'vmware-vdiskmanager';
}

// ---------------------------------------------------------------------------
// I/O — default exec + 下载 + sha256
// ---------------------------------------------------------------------------

async function defaultBuildExec(argv: string[], timeoutMs: number): Promise<VmExecResult> {
  // vmrun / vdiskmanager 特例：自定义安装路径不进 PATH，注册表/同目录兜底解析
  const binary = argv[0] === 'vmrun'
    ? resolveVmrunBinary()
    : argv[0] === 'vmware-vdiskmanager'
      ? resolveVdiskmanagerBinary()
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

/** 默认下载实现：undici fetch（与 vm-adopt 的 defaultPlinkDownload 同一网络栈）。 */
async function defaultIsoDownload(url: string, destPath: string): Promise<void> {
  const { fetch } = await import('undici');
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, Buffer.from(await resp.arrayBuffer()));
}

/** 流式 sha256（ISO 约 2.6GB，不整读进内存）。 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * OS ISO 就位：input.isoPath 优先（存在即用，不校验——人给的自己负责）；
 * 否则走缓存：SHA256SUMS 每次拉（小文件，兼作缓存校验依据），缓存 ISO
 * 校验通过则复用，不过删了重下；下载完成再校验，不过即删报错。
 */
async function ensureOsIso(
  isoPathInput: string | undefined,
  options: BuildOptions,
): Promise<EnvResult<{ path: string }>> {
  if (isoPathInput) {
    if (!existsSync(isoPathInput)) {
      return { ok: false, error: `指定的 ISO 不存在："${isoPathInput}"` };
    }
    return { ok: true, path: isoPathInput };
  }

  const cacheDir = options.isoCacheDir ?? join(getZhiShiDataDir(), 'iso');
  const isoPath = join(cacheDir, UBUNTU_ISO_FILENAME);
  const download = options.download ?? defaultIsoDownload;

  const sumsPath = join(cacheDir, 'SHA256SUMS');
  try {
    await download(UBUNTU_SHA256SUMS_URL, sumsPath);
  } catch (err) {
    return {
      ok: false,
      error:
        `下载 SHA256SUMS 失败：${err instanceof Error ? err.message : String(err)}\n` +
        '可用 --iso <本地 ISO 路径> 跳过下载。',
    };
  }
  const expected = parseSha256Sums(readFileSync(sumsPath, 'utf-8'), UBUNTU_ISO_FILENAME);
  if (!expected) {
    return { ok: false, error: `SHA256SUMS 里找不到 ${UBUNTU_ISO_FILENAME} 的条目（发布页结构变了？）` };
  }

  if (existsSync(isoPath)) {
    const cached = await sha256File(isoPath);
    if (cached === expected) {
      console.warn(`[vm-build] 复用 ISO 缓存：${isoPath}`);
      return { ok: true, path: isoPath };
    }
    console.warn(`[vm-build] ISO 缓存校验不过（期望 ${expected}，实际 ${cached}），重新下载`);
    rmSync(isoPath, { force: true });
  }

  console.warn(`[vm-build] 下载 ${UBUNTU_ISO_URL}（约 2.6GB，无进度条，请耐心等待）`);
  try {
    await download(UBUNTU_ISO_URL, isoPath);
  } catch (err) {
    rmSync(isoPath, { force: true });
    return {
      ok: false,
      error:
        `下载 Ubuntu ISO 失败：${err instanceof Error ? err.message : String(err)}\n` +
        '可手动下载后 --iso 指定本地路径。',
    };
  }
  const actual = await sha256File(isoPath);
  if (actual !== expected) {
    rmSync(isoPath, { force: true });
    return {
      ok: false,
      error: `ISO 下载完成但 SHA256 校验不过（期望 ${expected}，实际 ${actual}），已删除。请重试或 --iso 指定本地 ISO。`,
    };
  }
  return { ok: true, path: isoPath };
}

/** 等 VM 从 vmrun list 里消失（poweroff 生效），超时返回 false。 */
async function waitUntilStopped(
  exec: VmExec,
  vmx: string,
  timeoutMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const r = await exec(['vmrun', ...buildVmrunListArgs()], VMRUN_LIST_TIMEOUT_MS);
    if (r.exitCode === 0 && !parseVmrunList(r.stdout).some((p) => p.toLowerCase() === vmx.toLowerCase())) {
      return true;
    }
    await sleep(POWEROFF_POLL_MS);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Build orchestration
// ---------------------------------------------------------------------------

/**
 * 模板构建主流程。成功返回模板条目（调用方负责写 config.json::vmTemplates）；
 * 任何一步失败返回用户可读错误（含下一步指引）。
 */
export async function vmTemplateBuild(
  recipe: EnvironmentRecipe,
  input: BuildInput = {},
  options: BuildOptions = {},
): Promise<EnvResult<BuildOutcome>> {
  if (recipe.base !== 'vm') {
    return { ok: false, error: `配方 "${recipe.id}" 不是 VM 配方（base: ${recipe.base ?? '?'}）` };
  }

  const exec = options.exec ?? defaultBuildExec;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const vmwareError = await ensureVmwareAvailable(exec);
  if (vmwareError) return { ok: false, error: vmwareError };

  // 密钥对（公钥进 seed，私钥路径落模板条目）
  const keyMaterial = await ensureKeyMaterial(exec, {
    keysDir: options.keysDir ?? join(getZhiShiDataDir(), 'keys'),
  });
  if (!keyMaterial.ok) return { ok: false, error: keyMaterial.error };

  // 1. ISO 就位
  const isoReady = await ensureOsIso(input.isoPath, options);
  if (!isoReady.ok) return { ok: false, error: isoReady.error };

  // 2. 模板目录（已存在模板 = 冲突，不覆盖——快照可能是别人的依靠）
  const templatesRoot = options.templatesRoot ?? join(getZhiShiDataDir(), 'vm-templates');
  const templateDir = join(templatesRoot, recipe.id);
  const vmx = join(templateDir, `${recipe.id}.vmx`);
  if (existsSync(vmx)) {
    return {
      ok: false,
      error: `模板已存在："${vmx}"（重建请先手动删除目录 "${templateDir}"）`,
    };
  }
  mkdirSync(templateDir, { recursive: true });

  // 3. autoinstall seed ISO
  const hostname = `zhishi-${recipe.id}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const seedIsoPath = join(templateDir, 'seed.iso');
  writeFileSync(seedIsoPath, buildSeedIso({
    hostname,
    pubkey: keyMaterial.pubkey,
    instanceId: randomBytes(8).toString('hex'),
  }));

  // 4. 建盘 + vmx
  const diskGb = input.diskGb ?? DEFAULT_DISK_GB;
  const diskPath = join(templateDir, 'disk.vmdk');
  const vdResult = await exec(
    [resolveVdiskmanagerBinary(), ...buildVdiskmanagerCreateArgs(diskPath, diskGb)],
    VDISK_CREATE_TIMEOUT_MS,
  );
  if (vdResult.exitCode !== 0 || vdResult.error) {
    return {
      ok: false,
      error: `vmware-vdiskmanager 建盘失败：\n${(vdResult.stderr || vdResult.stdout || vdResult.error || '').trim()}`,
    };
  }
  writeFileSync(vmx, buildTemplateVmx({
    name: `zhishi-${recipe.id}-template`,
    diskFile: 'disk.vmdk',
    osIsoPath: isoReady.path,
    seedIsoPath,
    memMb: input.memMb ?? DEFAULT_MEM_MB,
    cpus: input.cpus ?? DEFAULT_CPUS,
  }));

  // 5. 启动（失败重试一次——实测挂起态残留首发「未知错误」）
  let startResult = await exec(['vmrun', ...buildVmrunStartArgs(vmx)], VMRUN_START_TIMEOUT_MS);
  if (startResult.exitCode !== 0 || startResult.error) {
    startResult = await exec(['vmrun', ...buildVmrunStartArgs(vmx)], VMRUN_START_TIMEOUT_MS);
  }
  if (startResult.exitCode !== 0 || startResult.error) {
    return {
      ok: false,
      error: `vmrun start 失败：\n${(startResult.stderr || startResult.stdout || startResult.error || '').trim()}`,
    };
  }
  console.warn(`[vm-build] VM 已启动（${vmx}），autoinstall 进行中（实机 20-40 分钟属正常）`);

  // 6. 等装完：Tools 上报 IP → ssh probe 通，总 deadline 45 分钟
  const installDeadline = now() + (options.installDeadlineMs ?? INSTALL_DEADLINE_MS);
  let address: string | undefined;
  for (;;) {
    const ipResult = await exec(['vmrun', ...buildVmrunGetIpArgs(vmx)], VMRUN_GET_IP_TIMEOUT_MS);
    if (ipResult.exitCode === 0 && !ipResult.error) {
      const ip = parseGuestIp(ipResult.stdout);
      if (ip) {
        const probe = await exec(
          buildSshProbeArgs({ user: RESEARCH_USER, address: ip, keyPath: keyMaterial.keyPath }),
          SSH_PROBE_TIMEOUT_MS,
        );
        if (probe.exitCode === 0 && !probe.error) {
          address = ip;
          break;
        }
      }
    }
    if (now() >= installDeadline) {
      return {
        ok: false,
        error:
          '等待自动安装超时（45 分钟）。VM 还在跑——打开 VMware 控制台看是不是卡在' +
          '安装器交互界面（cidata seed 未被识别 / 网络异常）。\n' +
          `若实际已装好，可 zhishi env adopt ${recipe.id} --vm "${vmx}" 接管养成。`,
      };
    }
    await sleep(INSTALL_POLL_MS);
  }
  const researcherTarget: SshTarget = { user: RESEARCH_USER, address, keyPath: keyMaterial.keyPath };

  // 7. 配方 setup.sh（researcher NOPASSWD sudo 已由 autoinstall 配好）
  if (existsSync(join(recipe.dir, 'setup.sh'))) {
    const scpResult = await exec(
      buildScpArgs(join(recipe.dir, 'setup.sh'), researcherTarget, '/tmp/zhishi-setup.sh'),
      SSH_EXEC_TIMEOUT_MS,
    );
    if (scpResult.exitCode !== 0 || scpResult.error) {
      return { ok: false, error: 'setup.sh 上传 guest 失败（scp）' };
    }
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

  // 7.5 配方工具自检：缺工具不定型（不做快照、报错，避免固化坏现场）
  const toolCheck = await runGuestToolCheck(exec, researcherTarget, recipe);
  if (!toolCheck.ok) return toolCheck;

  // 8. 定型：关机 → 等退出运行列表 → 快照
  await exec(buildSshExecArgs(researcherTarget, buildGuestPoweroffCommand()), SSH_PROBE_TIMEOUT_MS)
    .catch(() => undefined); // poweroff 会断连，失败无所谓
  if (!(await waitUntilStopped(exec, vmx, POWEROFF_WAIT_MS, now, sleep))) {
    const stopResult = await exec(['vmrun', ...buildVmrunStopArgs(vmx)], VMRUN_STOP_TIMEOUT_MS);
    if (stopResult.exitCode !== 0 || stopResult.error) {
      return {
        ok: false,
        error: `guest 关机失败（poweroff 与 vmrun stop soft 都不通）：${(stopResult.stderr || '').trim()}。请手动关机后重跑 build`,
      };
    }
    if (!(await waitUntilStopped(exec, vmx, POWEROFF_WAIT_MS, now, sleep))) {
      return { ok: false, error: 'vmrun stop 已发但 VM 未退出运行列表，请手动确认后重跑 build' };
    }
  }

  const snapshotName = recipe.vmSnapshot ?? SNAPSHOT_NAME;
  const snapResult = await exec(['vmrun', ...buildVmrunSnapshotArgs(vmx, snapshotName)], VMRUN_START_TIMEOUT_MS);
  if (snapResult.exitCode !== 0 || snapResult.error) {
    return { ok: false, error: `快照 "${snapshotName}" 创建失败：\n${(snapResult.stderr || snapResult.stdout).trim()}` };
  }

  return {
    ok: true,
    template: { vmx, user: RESEARCH_USER, keyPath: keyMaterial.keyPath, snapshot: snapshotName },
    address,
  };
}
