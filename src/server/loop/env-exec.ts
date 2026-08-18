/**
 * M1 — 环境执行通道（「工具执行体挂环境层」本体）。
 *
 * 把一条 shell 命令送进选定的研究环境（EnvironmentEntry）执行：
 *
 *   EnvironmentEntry(kind vm/ssh, address/host, user, keyPath, port)
 *     → ssh target 解析（resolveSshTarget；vm 缺 address → 「环境未就绪」）
 *     → ssh argv 组装（buildSshArgv，纯函数）
 *     → 可注入 exec 执行（EnvExec，照 vm-lifecycle 的 VmExec 模式，
 *       单测绝不真碰 ssh）
 *     → 输出截断（head+tail 各 ~15KB，中间标 [truncated]）
 *
 * SSH 持久连接用 ControlMaster（ControlPersist=10m），避免 agent loop
 * 里每命令一次 TCP+握手——但仅 POSIX 宿主启用；Windows OpenSSH 的 mux
 * 实现不稳（实测 master 即建即断、首个会话 stdout 被吞），win32 默认
 * 每命令一次握手（见 buildSshArgv 注释）。BatchMode 禁交互、
 * accept-new 免首次主机确认。
 * 凭据纪律（D-T4）：只用 keyPath 引用私钥，绝不接受/传递密码。
 *
 * kind=docker 的条目走 docker exec 通道（resolveExecTarget 分派，
 * buildDockerExecArgv 组参）——2026-08-17 接通,不再是 M1 断点。
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EnvironmentEntry } from '../../shared/config-types';
import { vmGuestExec } from '../environment/vm-guest-exec';
import { osFamilyOf, psEncode, psShellWrapper } from '../environment/os-family';
import type { VmExec } from '../environment/vm-lifecycle';
import { loadConfig } from '../utils/admin-config';
import { augmentedProcessEnv, resolveCommand } from '../utils/env-utils';
import { spawn as spawnSubprocess } from '../utils/subprocess';

export type EnvResult<T> = ({ ok: true } & T) | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnvExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** true = stdout 或 stderr 被截断（见 truncateOutput）。 */
  truncated: boolean;
}

/** 与 vm-lifecycle 的 VmExec 同形：argv + 超时 → 进程结果。 */
export interface EnvExecProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** spawn 级错误（ENOENT 等，进程根本没起来）或超时。 */
  error?: string;
}

export type EnvExec = (argv: string[], timeoutMs: number) => Promise<EnvExecProcessResult>;

export interface EnvExecOptions {
  exec?: EnvExec;
  /** 单命令超时（默认 DEFAULT_TIMEOUT_MS；工具层可被参数覆盖）。 */
  timeoutMs?: number;
  /** 输出截断阈值（每侧字节数，默认 OUTPUT_LIMIT_BYTES）。 */
  maxOutputBytes?: number;
  /** 显式覆盖 ControlMaster 开关（默认：win32 关、POSIX 开，见 buildSshArgv）。 */
  controlMaster?: boolean;
  /** 测试注入:guest 通道(断网 VM)的 vmrun exec(绝不真调 vmrun)。 */
  guestExec?: VmExec;
}

export interface SshTarget {
  /** user@host 或 host（user 缺省时用本机用户名，与 `env open` 语义一致）。 */
  destination: string;
  host: string;
  user?: string;
  port?: number;
  keyPath?: string;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
/** head+tail 各保留的字节数（超出部分中间标 [truncated]）。 */
export const OUTPUT_LIMIT_BYTES = 15 * 1024;
/** ControlMaster 控制连接空闲保活时间。 */
export const CONTROL_PERSIST = '10m';

// ---------------------------------------------------------------------------
// Pure — target resolution / argv assembly / truncation
// ---------------------------------------------------------------------------

/**
 * EnvironmentEntry → 执行通道。
 * - kind ssh：host 必填（registry 校验保证；防御性再查一次）。
 * - kind vm：有 address → ssh；无 address（断网隔离）→ guest 通道
 *   （vmrun runProgramInGuest,经 vmGuestExec）。两者都没有 → 「环境未就绪」。
 * - kind docker：container 必填；执行走 docker exec(无 ssh)。
 */
export type ExecTarget =
  | { channel: 'ssh'; target: SshTarget }
  | { channel: 'docker'; container: string }
  | { channel: 'guest'; entry: EnvironmentEntry };

export function resolveExecTarget(entry: EnvironmentEntry): EnvResult<{ execTarget: ExecTarget }> {
  if (entry.kind === 'docker') {
    if (!entry.container) {
      return { ok: false, error: `环境 "${entry.id}" 缺少 container 字段(docker 条目的定位锚)` };
    }
    return { ok: true, execTarget: { channel: 'docker', container: entry.container } };
  }
  if (entry.kind === 'vm' && !entry.address) {
    // 断网隔离 VM:guest-exec 是唯一通道(vmrun 客户机通道,不依赖网络)。
    if (entry.vmName || entry.vmx) {
      return { ok: true, execTarget: { channel: 'guest', entry } };
    }
    return { ok: false, error: `环境 "${entry.id}" 未就绪:VM 无可达地址且无 vmx/vmName 定位锚(guest-exec 也够不到)` };
  }
  const ssh = resolveSshTarget(entry);
  if (!ssh.ok) return ssh;
  return { ok: true, execTarget: { channel: 'ssh', target: ssh.target } };
}

/**
 * guest 密码外部引用解析(D-T4:不落盘、不存本体)。v1 只支持 `env:VAR_NAME`
 * ——从宿主进程环境现场取。无引用/变量未设/空值 → null(调用方给指引)。
 */
export function resolvePasswordRef(ref: string | undefined): string | null {
  if (!ref) return null;
  const m = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref.trim());
  if (!m) return null;
  const v = process.env[m[1]];
  return v ? v : null;
}

/** docker 执行 argv:docker exec <container> bash -lc <command>(配方镜像的
 *  WORKDIR 即 /workspace,不加 -w 强写,尊重配方)。非交互(-i 免,命令经
 *  argv 单参数传入,不读 stdin)。 */
export function buildDockerExecArgv(container: string, command: string): string[] {
  return ['docker', 'exec', container, 'bash', '-lc', command];
}

/**
 * EnvironmentEntry → ssh target。
 * - kind ssh：host 必填（registry 校验保证；防御性再查一次）。
 * - kind vm：address 即可达地址；缺省 = VM 未拿到网络 → 「环境未就绪」。
 * - kind docker：不走 ssh（调用方应先用 resolveExecTarget 分派）。
 */
export function resolveSshTarget(entry: EnvironmentEntry): EnvResult<{ target: SshTarget }> {
  if (entry.kind === 'docker') {
    return { ok: false, error: `环境 "${entry.id}" 是 docker 类型——走 docker exec 通道(resolveExecTarget),不走 ssh` };
  }
  const host = entry.kind === 'vm' ? entry.address : entry.host;
  if (!host) {
    return {
      ok: false,
      error: entry.kind === 'vm'
        ? `环境 "${entry.id}" 未就绪：VM 尚无可达地址（先 env up 并确认网络/Tools）`
        : `环境 "${entry.id}" 缺少 host`,
    };
  }
  const port = entry.port !== undefined && entry.port !== null ? Number(entry.port) : undefined;
  return {
    ok: true,
    target: {
      destination: entry.user ? `${entry.user}@${host}` : host,
      host,
      user: entry.user,
      port: Number.isFinite(port) ? port : undefined,
      keyPath: entry.keyPath,
    },
  };
}

/** ControlPath 目录（每进程确保存在；Windows 下 OpenSSH 也走此目录）。 */
export function controlSocketDir(): string {
  return join(tmpdir(), 'zhishi-ssh');
}

/**
 * 组装 ssh argv（纯函数）。命令作为单参数挂在最后，由远端 shell 解释。
 * ControlMaster=auto：有活控制连接则复用，没有则本命令建立并保活。
 * 注意（实测怪癖）：Windows OpenSSH 的 mux 支持不稳——master 建立后即
 * "read from master failed: Connection reset by peer"，首个会话的 stdout
 * 可能被吞。故 win32 宿主默认不加 Control* 参数（每命令一次握手，
 * 功能优先），POSIX 宿主才启用复用；可用 opts.controlMaster 显式覆盖。
 */
export function buildSshArgv(
  target: SshTarget,
  command: string,
  opts?: { controlMaster?: boolean; osFamily?: 'linux' | 'windows' },
): string[] {
  const controlMaster = opts?.controlMaster ?? process.platform !== 'win32';
  const argv = [
    'ssh',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
  ];
  if (controlMaster) {
    argv.push(
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${join(controlSocketDir(), '%r@%h:%p')}`,
      '-o', `ControlPersist=${CONTROL_PERSIST}`,
    );
  }
  if (target.keyPath) argv.push('-i', target.keyPath);
  if (target.port) argv.push('-p', String(target.port));
  // OS 家族分派:windows → powershell -EncodedCommand(退出码透传);
  // linux → 命令原样(远端 shell 解释)。
  const remote = opts?.osFamily === 'windows'
    ? `powershell -NoProfile -EncodedCommand ${psEncode(psShellWrapper(command))}`
    : command;
  argv.push(target.destination, remote);
  return argv;
}

export interface TruncatedOutput {
  text: string;
  truncated: boolean;
}

/** head+tail 截断：两侧各留 limit 字节，中间标 [truncated N bytes]。 */
export function truncateOutput(text: string, limit: number = OUTPUT_LIMIT_BYTES): TruncatedOutput {
  if (text.length <= limit * 2) return { text, truncated: false };
  const omitted = text.length - limit * 2;
  return {
    text: `${text.slice(0, limit)}\n[truncated ${omitted} bytes]\n${text.slice(-limit)}`,
    truncated: true,
  };
}

// ---------------------------------------------------------------------------
// I/O — default exec（照 defaultVmrunExec 的形状）
// ---------------------------------------------------------------------------

export async function defaultEnvExec(argv: string[], timeoutMs: number): Promise<EnvExecProcessResult> {
  // ControlPath 目录需预先存在（ssh 不会自建多级目录）。
  try { mkdirSync(controlSocketDir(), { recursive: true }); } catch { /* best-effort */ }

  const proc = spawnSubprocess([resolveCommand(argv[0]), ...argv.slice(1)], {
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
      return { exitCode: -1, stdout, stderr, error: `timed out after ${timeoutMs}ms` };
    }
    if (proc.error) {
      return { exitCode, stdout, stderr, error: proc.error.message };
    }
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Entry — execute a command inside an environment
// ---------------------------------------------------------------------------

/**
 * 在指定环境里执行 shell 命令。
 *
 * 错误面：
 * - 目标解析失败 / 进程级失败（ssh 不存在、连接超时、spawn 错误）
 *   → { ok:false, error }（环境/通道问题，不是命令本身失败）。
 * - 远端命令非零退出 → { ok:true, exitCode≠0, stdout, stderr }
 *   （命令语义失败，原样回传，由调用方/模型解读）。
 */
export async function execInEnvironment(
  entry: EnvironmentEntry,
  command: string,
  options: EnvExecOptions = {},
): Promise<EnvResult<EnvExecResult>> {
  const resolved = resolveExecTarget(entry);
  if (!resolved.ok) return resolved;

  const exec = options.exec ?? defaultEnvExec;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { execTarget } = resolved;

  // guest 通道(断网隔离 VM):vmGuestExec 自带编排(校验/包装/取回),
  // 不走 argv exec 注入——它有独立的 exec 注入点(options 透传)。
  if (execTarget.channel === 'guest') {
    const password = resolvePasswordRef(execTarget.entry.passwordRef);
    if (!password) {
      return {
        ok: false,
        error:
          `环境 "${entry.id}" 是断网隔离 VM,guest-exec 需要 guest 密码引用(D-T4 不落盘)。\n` +
          `给条目配 passwordRef(如 env:ZHISHI_VM_PW)并设好该环境变量后重试。`,
      };
    }
    try {
      const r = await vmGuestExec(execTarget.entry, command, { guestPassword: password }, {
        templates: loadConfig().vmTemplates,
        ...(options.guestExec ? { exec: options.guestExec } : {}),
      });
      if (!r.ok) return { ok: false, error: r.error };
      const stdout = truncateOutput(r.stdout, options.maxOutputBytes);
      return { ok: true, stdout: stdout.text, stderr: '', exitCode: r.exitCode, truncated: stdout.truncated };
    } catch (err) {
      return { ok: false, error: `guest-exec 异常:${err instanceof Error ? err.message : String(err)}` };
    }
  }

  const argv = execTarget.channel === 'docker'
    ? buildDockerExecArgv(execTarget.container, command)
    : buildSshArgv(execTarget.target, command, {
        controlMaster: options.controlMaster,
        osFamily: osFamilyOf(entry),
      });

  let result: EnvExecProcessResult;
  try {
    result = await exec(argv, timeoutMs);
  } catch (err) {
    return { ok: false, error: `环境执行异常：${err instanceof Error ? err.message : String(err)}` };
  }

  if (result.error && result.exitCode < 0) {
    return { ok: false, error: `环境执行失败：${result.error}` };
  }

  const stdout = truncateOutput(result.stdout, options.maxOutputBytes);
  const stderr = truncateOutput(result.stderr, options.maxOutputBytes);
  return {
    ok: true,
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: result.exitCode,
    truncated: stdout.truncated || stderr.truncated,
  };
}
