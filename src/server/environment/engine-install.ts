/**
 * 安全研究员版 P1 E1b — 引擎缺失时的自动安装引导（人确认、机器执行）。
 *
 * `zhishi env install <engine>`（engine ∈ docker | hyperv）把 E1 探测到的
 * 「未安装」从纯文案引导升级为半自动安装：
 *
 * - docker：下载 Docker Desktop for Windows 官方安装包到
 *   ~/.zhishi/downloads/，验 Authenticode（D-T2：只信 Docker Inc 已有信任根，
 *   不开新签名体系），然后 detached 启动 GUI 安装器——UAC 与向导必须人走完，
 *   本命令只负责把验过签的安装器递到人面前。WSL2 状态只作提示附带，不阻断。
 * - hyperv：管理员终端里 dism 启用 Microsoft-Hyper-V-All（/norestart），
 *   非管理员直接报清晰错误让人换终端重跑。
 *
 * 结构约定与全环境层一致：命令组装 / 输出解析是纯函数，所有 I/O（exec /
 * download / launch）可注入，`installEngine` 返回 EnvResult，单测绝不真调
 * 外部命令。v1 只做 Windows；mac/linux 给 brew/apt 指引文案，不执行。
 *
 * 1.7.8 本机工具链补装（installLocalToolchain）：winget 官方源半自动装
 * Build Tools / Windows SDK / WinDbg——人点触发、脚本干活，与 docker /
 * hyperv 同款交互；大模型不参与环境配置（design/local-env-design.md §3）。
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { getZhiShiDataDir } from '../utils/app-dirs';
import { spawn as spawnSubprocess } from '../utils/subprocess';
import {
  ENGINE_PROBE_TIMEOUT_MS,
  ENGINE_SPECS,
  defaultEngineExec,
  parseEngineProbeResult,
  type EngineExec,
} from './engines';
import type { EnvResult } from './vm-lifecycle';

/** v1 支持自动安装引导的引擎。 */
export type InstallableEngineKind = 'docker' | 'hyperv';

/**
 * 1.7.8 本机工具链补装项（design §3）——winget 官方源半自动，人点触发、
 * 脚本干活（与 docker/hyperv 同款交互；不引入 agent 自动触发）。
 * probe = 安装前预检命令（cmd.exe 语义，退出码判在场）。
 */
export type LocalToolchainKind = 'msvc-build-tools' | 'windows-sdk' | 'windbg';

export interface LocalToolchainInstaller {
  kind: LocalToolchainKind;
  /** 给人看的名称。 */
  name: string;
  /** winget 官方源包 id（--exact --source winget——源本身验签发布者）。 */
  wingetId: string;
  /** 安装前预检（exit 0 = 已装，短路报「已就绪」）。 */
  probe: string;
  /** 预检失败时的一句话引导。 */
  guidance: string;
}

export const LOCAL_TOOLCHAIN_INSTALLERS: readonly LocalToolchainInstaller[] = [
  {
    kind: 'msvc-build-tools',
    name: 'Visual Studio Build Tools（MSVC 工具集）',
    wingetId: 'Microsoft.VisualStudio.2022.BuildTools',
    // 与 capability-derive 的 msvc 探测同一命令（vswhere 查带 VC 工具集
    // 组件的实例）。
    probe:
      '"%ProgramFiles(x86)%\\Microsoft Visual Studio\\Installer\\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property instanceId | findstr /r /c:"."',
    guidance: '未检测到 MSVC 工具集——补装 Build Tools（含 cl/link/lib，宿主编译闭环的第一步）',
  },
  {
    kind: 'windows-sdk',
    name: 'Windows SDK（含调试器套件挂载点）',
    // Microsoft 按版本发包；10.0.26100 = Windows 11 24H2 SDK（cdb/WinDbg
    // 的经典落点 %ProgramFiles(x86)%\Windows Kits\10 由其铺）。
    wingetId: 'Microsoft.WindowsSDK.10.0.26100',
    probe: 'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots" /v KitsRoot10',
    guidance: '未检测到 Windows SDK——补装后 cdb/WinDbg 才有标准落点',
  },
  {
    kind: 'windbg',
    name: 'WinDbg（Windows 调试器）',
    wingetId: 'Microsoft.WinDbg',
    probe: 'where windbg || dir /b "%ProgramFiles(x86)%\\Windows Kits\\10\\Debuggers\\x64\\windbg.exe"',
    guidance: '未检测到 WinDbg——内核/用户态调试闭环的工具',
  },
];

export interface LocalToolchainInstallOutcome {
  kind: LocalToolchainKind;
  name: string;
  /** 预检发现已可用，未执行任何安装动作。 */
  alreadyAvailable?: boolean;
  /** 面向人的结果说明（成功路径）。 */
  message: string;
}

/** payload 校验用：字符串是否为本机工具链补装项。 */
export function isLocalToolchainKind(value: string): value is LocalToolchainKind {
  return LOCAL_TOOLCHAIN_INSTALLERS.some((s) => s.kind === value);
}

export interface EngineInstallOutcome {
  engine: InstallableEngineKind;
  /** 探测发现引擎已可用，未执行任何安装动作。 */
  alreadyAvailable?: boolean;
  /** docker：已启动的安装器路径。 */
  installerPath?: string;
  /** 面向人的结果说明（成功路径）。 */
  message: string;
}

export interface EngineInstallOptions {
  exec?: EngineExec;
  download?: InstallerDownload;
  launch?: InstallerLaunch;
  /** 测试注入：默认 process.platform。 */
  platform?: NodeJS.Platform;
  /** 测试注入：安装包下载目录，默认 ~/.zhishi/downloads/。 */
  downloadsDir?: string;
}

// ---------------------------------------------------------------------------
// Pure data + pure functions — URL 常量 / 命令组装 / 输出解析 / 指引文案
// ---------------------------------------------------------------------------

/** Docker Desktop for Windows (amd64) 官方直链。 */
export const DOCKER_DESKTOP_URL =
  'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe';

/** 安装包文件名（落 downloadsDir 下）。 */
export const DOCKER_INSTALLER_FILENAME = 'Docker Desktop Installer.exe';

/**
 * Authenticode 验证命令：输出 `Status|Subject` 供 parseDockerSignature 判定。
 * 与 vm-adopt 的 buildPlinkVerifyArgs 同模式。
 */
export function buildDockerVerifyArgs(installerPath: string): string[] {
  const escaped = installerPath.replace(/'/g, "''");
  return [
    'powershell', '-NoProfile', '-Command',
    `$s = Get-AuthenticodeSignature '${escaped}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`,
  ];
}

/** 验证输出判定：Status=Valid 且签发者含 'Docker'（Docker Inc 签名）。 */
export function parseDockerSignature(output: string): boolean {
  const [status, subject = ''] = output.trim().split('|');
  return status === 'Valid' && subject.includes('Docker');
}

/** WSL2 前置检查命令（exit 0 与否只作提示，不阻断安装）。 */
export function buildWslStatusArgs(): string[] {
  return ['wsl.exe', '--status'];
}

/** Hyper-V 启用命令：/norestart —— 重启时机交给人。 */
export function buildDismEnableHyperVArgs(): string[] {
  return [
    'dism.exe', '/online', '/enable-feature',
    '/featurename:Microsoft-Hyper-V-All', '/all', '/norestart',
  ];
}

/** 当前进程是否 elevated 的检查命令：输出 True / False。 */
export function buildElevatedCheckArgs(): string[] {
  return [
    'powershell', '-NoProfile', '-Command',
    '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
      '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  ];
}

/** elevated 检查输出判定。 */
export function parseElevatedResult(output: string): boolean {
  return output.trim() === 'True';
}

/** 非 Windows 平台的手动安装指引（v1 不执行，纯文案）。 */
export function nonWindowsGuidance(engine: InstallableEngineKind, platform: NodeJS.Platform): string {
  if (engine === 'hyperv') {
    return 'Hyper-V 仅 Windows 可用；macOS / Linux 请改用 VirtualBox 或 VMware（见 `zhishi env engines` 的引导）。';
  }
  if (platform === 'darwin') {
    return 'macOS 请手动安装 Docker Desktop：`brew install --cask docker`，或从 https://www.docker.com/products/docker-desktop/ 下载。装好后 `zhishi env engines` 应显示 docker ✓。';
  }
  return 'Linux 请用发行版包管理器安装 Docker Engine（如 `apt install docker.io`，详见 https://docs.docker.com/engine/install/）。装好后 `zhishi env engines` 应显示 docker ✓。';
}

// ---------------------------------------------------------------------------
// I/O — 默认 download / launch（exec 复用 engines.ts 的 defaultEngineExec）
// ---------------------------------------------------------------------------

export type InstallerDownload = (url: string, destPath: string) => Promise<void>;

/** 默认下载实现：undici fetch（与 vm-adopt 的 defaultPlinkDownload 同一网络栈）。 */
async function defaultInstallerDownload(url: string, destPath: string): Promise<void> {
  const { fetch } = await import('undici');
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const { writeFileSync: write, mkdirSync: mkdir } = await import('node:fs');
  const { dirname: dir } = await import('node:path');
  mkdir(dir(destPath), { recursive: true });
  write(destPath, Buffer.from(await resp.arrayBuffer()));
}

export type InstallerLaunch = (installerPath: string) => Promise<void>;

/**
 * 默认启动实现：detached spawn 安装器 GUI 后立刻 unref——安装是分钟级
 * 人工流程，server 进程绝不能挂在它上面。
 */
async function defaultInstallerLaunch(installerPath: string): Promise<void> {
  const proc = spawnSubprocess([installerPath], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
    windowsHide: false,
  });
  if (proc.error) throw proc.error;
  proc.unref();
}

// ---------------------------------------------------------------------------
// Orchestration — installEngine（全部 IO 注入化）
// ---------------------------------------------------------------------------

/** dism 启用功能可能要走组件存储，给足时间。 */
export const DISM_TIMEOUT_MS = 10 * 60_000;
const VERIFY_TIMEOUT_MS = 60_000;
const WSL_CHECK_TIMEOUT_MS = 15_000;

/**
 * 安装引导编排：探测 → 已可用短路报「已就绪」→ 平台闸门（非 Windows 纯
 * 文案）→ 分引擎执行。任何一步失败都返回带人工下一步的 EnvResult 错误，
 * 绝不抛出。
 */
export async function installEngine(
  engine: InstallableEngineKind,
  opts: EngineInstallOptions = {},
): Promise<EnvResult<EngineInstallOutcome>> {
  const exec = opts.exec ?? defaultEngineExec;
  const platform = opts.platform ?? process.platform;

  // 1. 探测：已可用直接短路。探测本身失败（超时 / ENOENT）按「缺失」处理。
  const spec = ENGINE_SPECS.find((s) => s.kind === engine);
  if (!spec) return { ok: false, error: `未知引擎 "${engine}"（支持 docker | hyperv）` };
  try {
    const probe = await exec(spec.argv, ENGINE_PROBE_TIMEOUT_MS);
    if (parseEngineProbeResult(spec, probe).available) {
      return {
        ok: true,
        engine,
        alreadyAvailable: true,
        message: `${engine} 已就绪（\`zhishi env engines\` 可见 ✓），无需安装。`,
      };
    }
  } catch {
    // 探测失败 → 按缺失走安装引导
  }

  // 2. 平台闸门：v1 只执行 Windows；mac/linux 给指引文案，不动手。
  if (platform !== 'win32') {
    return { ok: false, error: `当前平台不支持自动安装 ${engine}。${nonWindowsGuidance(engine, platform)}` };
  }

  return engine === 'docker' ? installDocker(exec, opts) : installHyperV(exec);
}

async function installDocker(
  exec: EngineExec,
  opts: EngineInstallOptions,
): Promise<EnvResult<EngineInstallOutcome>> {
  const download = opts.download ?? defaultInstallerDownload;
  const launch = opts.launch ?? defaultInstallerLaunch;
  const dest = join(opts.downloadsDir ?? join(getZhiShiDataDir(), 'downloads'), DOCKER_INSTALLER_FILENAME);

  // WSL2 前置检查：结果只作提示附带，不阻断（安装器自己会引导启用）。
  let wslReady = false;
  try {
    const wsl = await exec(buildWslStatusArgs(), WSL_CHECK_TIMEOUT_MS);
    wslReady = wsl.exitCode === 0 && !wsl.error;
  } catch {
    // wsl.exe 不存在等情况按「未就绪」提示
  }
  const wslNote = wslReady
    ? 'WSL2 已就绪。'
    : '提示：未检测到可用的 WSL2，Docker Desktop 安装器会引导启用。';

  try {
    await download(DOCKER_DESKTOP_URL, dest);
  } catch (err) {
    return {
      ok: false,
      error:
        `Docker Desktop 安装包下载失败：${err instanceof Error ? err.message : String(err)}\n` +
        '可手动从 https://www.docker.com/products/docker-desktop/ 下载安装。',
    };
  }

  // D-T2：只信 Docker Inc 的 Authenticode 签名；验不过即删，绝不启动。
  const verify = await exec(buildDockerVerifyArgs(dest), VERIFY_TIMEOUT_MS);
  if (verify.exitCode !== 0 || verify.error || !parseDockerSignature(verify.stdout)) {
    try {
      rmSync(dest, { force: true });
    } catch { /* best effort */ }
    return {
      ok: false,
      error:
        'Docker Desktop 安装包已下载但 Authenticode 签名验证失败（非 Docker 有效签名），已删除。\n' +
        '这不该发生——请手动从 https://www.docker.com/products/docker-desktop/ 下载安装，并反馈此问题。',
    };
  }

  try {
    await launch(dest);
  } catch (err) {
    return {
      ok: false,
      error: `安装包已下载并验签（${dest}），但启动安装器失败：${err instanceof Error ? err.message : String(err)}。请手动双击运行。`,
    };
  }

  return {
    ok: true,
    engine: 'docker',
    installerPath: dest,
    message:
      `Docker Desktop 安装器已启动（${dest}）。GUI 安装需人走完 UAC 与向导；` +
      '装完重启或重开终端后 `zhishi env engines` 应显示 docker ✓。' + wslNote,
  };
}

async function installHyperV(exec: EngineExec): Promise<EnvResult<EngineInstallOutcome>> {
  // dism 改系统功能必须 elevated；非管理员给人明确的下一步，不硬跑。
  const elevated = await exec(buildElevatedCheckArgs(), ENGINE_PROBE_TIMEOUT_MS);
  if (elevated.exitCode !== 0 || elevated.error || !parseElevatedResult(elevated.stdout)) {
    return {
      ok: false,
      error: '启用 Hyper-V 需要管理员权限：请用管理员终端重跑 `zhishi env install hyperv`。',
    };
  }

  const dism = await exec(buildDismEnableHyperVArgs(), DISM_TIMEOUT_MS);
  if (dism.exitCode !== 0 || dism.error) {
    const detail = dism.error ?? dism.stderr.trim().split('\n')[0] ?? `exit ${dism.exitCode}`;
    return {
      ok: false,
      error:
        `启用 Hyper-V 失败：${detail}\n` +
        '可在「启用或关闭 Windows 功能」中手动勾选 Hyper-V（需 Windows 专业版以上）。',
    };
  }

  return {
    ok: true,
    engine: 'hyperv',
    message:
      'Hyper-V 已启用（dism /norestart），需重启后生效；重启后 `zhishi env engines` 应显示 hyperv ✓。',
  };
}

// ---------------------------------------------------------------------------
// 1.7.8 本机工具链补装 —— winget 官方源半自动（人点触发，与 docker/hyperv
// 同款交互：探测 → 已就绪短路 → 平台闸门 → elevated 闸门 → winget install）
// ---------------------------------------------------------------------------

/** winget 安装命令组装（纯函数）：官方源 + 验签协议同意 + 禁交互
 *  （--disable-interactivity 保证没有「人点」之外的悬挂提示）。 */
export function buildWingetInstallArgs(wingetId: string): string[] {
  return [
    'winget', 'install',
    '--exact', '--id', wingetId,
    '--source', 'winget',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity',
  ];
}

/** Build Tools/SDK 安装包体积大，winget 走分钟级下载安装。 */
export const WINGET_INSTALL_TIMEOUT_MS = 20 * 60_000;

/** winget 本体预检命令（App Installer）。 */
export function buildWingetCheckArgs(): string[] {
  return ['winget', '--version'];
}

/**
 * 补装一件本机工具链：预检（已装短路）→ 平台闸门（v1 只 Windows）→
 * winget 本体预检 → elevated 闸门（Build Tools/SDK 机级安装必须管理员）
 * → winget install（官方源，源侧验签发布者）。任何一步失败返回带人工
 * 下一步的 EnvResult 错误，绝不抛出。
 */
export async function installLocalToolchain(
  kind: LocalToolchainKind,
  opts: EngineInstallOptions = {},
): Promise<EnvResult<LocalToolchainInstallOutcome>> {
  const exec = opts.exec ?? defaultEngineExec;
  const platform = opts.platform ?? process.platform;
  const spec = LOCAL_TOOLCHAIN_INSTALLERS.find((s) => s.kind === kind);
  if (!spec) {
    return { ok: false, error: `未知本机工具链 "${kind}"（支持 msvc-build-tools | windows-sdk | windbg）` };
  }

  // 1. 预检：已可用直接短路（与 installEngine 同纪律）。
  try {
    const probe = await exec(
      ['cmd', '/d', '/c', spec.probe],
      ENGINE_PROBE_TIMEOUT_MS,
    );
    if (probe.exitCode === 0 && !probe.error) {
      return {
        ok: true,
        kind,
        name: spec.name,
        alreadyAvailable: true,
        message: `${spec.name} 已就绪（本机能力探测应显示在场），无需补装。`,
      };
    }
  } catch {
    // 预检失败 → 按缺失走补装引导
  }

  // 2. 平台闸门：本机工具链装的就是 Windows 宿主上的东西。
  if (platform !== 'win32') {
    return { ok: false, error: `当前平台不支持补装 ${spec.name}（本机工具链只面向 Windows 宿主）。` };
  }

  // 3. winget 本体预检：裸机可能没有 App Installer。
  const winget = await exec(buildWingetCheckArgs(), ENGINE_PROBE_TIMEOUT_MS).catch(() => null);
  if (!winget || winget.exitCode !== 0 || winget.error) {
    return {
      ok: false,
      error:
        '未检测到 winget（应用安装程序）。请从 Microsoft Store 安装「应用安装程序」(App Installer)，' +
        `或手动安装 ${spec.name}；装好后重试 \`zhishi env install ${kind}\`。`,
    };
  }

  // 4. elevated 闸门：机级安装必须管理员，非管理员给清晰下一步（hyperv 同款）。
  const elevated = await exec(buildElevatedCheckArgs(), ENGINE_PROBE_TIMEOUT_MS);
  if (elevated.exitCode !== 0 || elevated.error || !parseElevatedResult(elevated.stdout)) {
    return {
      ok: false,
      error: `补装 ${spec.name} 需要管理员权限：请用管理员终端重跑 \`zhishi env install ${kind}\`。`,
    };
  }

  // 5. winget install（官方源；--exact 防模糊匹配，验签由 winget 源协议保证）。
  const install = await exec(buildWingetInstallArgs(spec.wingetId), WINGET_INSTALL_TIMEOUT_MS);
  if (install.exitCode !== 0 || install.error) {
    const detail =
      install.error ??
      install.stderr.trim().split('\n').filter(Boolean).slice(-3).join('\n') ??
      `exit ${install.exitCode}`;
    return {
      ok: false,
      error:
        `winget 安装 ${spec.name} 失败：${detail}\n` +
        `可手动执行 \`winget install --exact --id ${spec.wingetId} --source winget\`，` +
        '或从微软官网下载安装。',
    };
  }

  return {
    ok: true,
    kind,
    name: spec.name,
    message:
      `${spec.name} 安装已执行（winget 官方源，${spec.wingetId}）。` +
      '安装器输出见上；装好后重跑一次本机能力探测（zhishi env probe local / GUI 刷新）确认在场。',
  };
}
