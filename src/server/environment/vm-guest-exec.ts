/**
 * 安全研究员版 P2 B2 — guest-exec 通道：断网隔离 VM 的一次性命令执行.
 *
 * 场景：恶意样本 detonate 的隔离 VM 可彻底无网卡——没有 address、没有
 * SSH，`env open` 的 SSH 通道根本不存在。本模块走 hypervisor 客户机通道
 * （VMware Tools）：
 *
 *   vmrun -T ws -gu <user> -gp <password> runProgramInGuest <vmx>
 *         -activeWindow -interactive /bin/bash -c '<wrapped>'
 *   vmrun ... copyFileFromGuest <vmx> <guest 路径> <host 路径>
 *   vmrun ... deleteFileInGuest <vmx> <guest 路径>          （收尾清理）
 *
 * 输出采集方案：runProgramInGuest 不回传 guest 程序的 stdout，也不回传其
 * 退出码（它自己的退出码只表示「这次 guest 操作」成败——Tools 没在跑、
 * 认证失败这类通道错误）。所以组装函数把用户命令包一层：
 *
 *   ( <cmd> ) > /tmp/zhishi-exec-<rand>.out 2>&1; echo -n $? > /tmp/zhishi-exec-<rand>.code
 *
 * stdout/stderr 与退出码各自落 guest 临时文件，再由 copyFileFromGuest 取回
 * 宿主解析。guest 命令非零退出不算通道失败——原样带 exitCode 返回给调用方。
 *
 * 凭据红线（D-T4）：vmrun 客户机通道只认 guest 密码（-gu/-gp），keyPath
 * 救不了它。密码由 CLI 现场输入 → POST 体瞬传 → 进程参数瞬现，绝不落盘；
 * 缺密码时报含「guest 密码」标记的错误，CLI 据此现场询问后重试一次。
 *
 * v1 只支持 Linux guest（/bin/bash 包装）；Windows guest 报「后续版本」
 * 引导。guest OS 判定不做——包装脚本在 Windows 上会以通道错误形式失败，
 * 由 classifyGuestExecFailure 兜底成可读错误。
 *
 * 结构照 vm-lifecycle.ts：命令组装/输出解析是纯函数；所有进程调用走可
 * 注入的 `VmExec`，单测绝不真调 vmrun。host 侧临时文件是真 fs（测试用
 * 临时目录，scripted exec 在 copyFileFromGuest 时写文件做副作用）。
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvironmentEntry } from './registry';
import { osFamilyOf, psCaptureScript, psEncode, PS_TEMP } from './os-family';
import {
  buildVmrunListArgs,
  defaultVmrunExec,
  ensureVmwareAvailable,
  parseVmrunList,
  VMRUN_LIST_TIMEOUT_MS,
  type EnvResult,
  type VmExec,
  type VmExecResult,
} from './vm-lifecycle';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** vmTemplates 的最小结构依赖（与 config-types.VmTemplateEntry 结构兼容）。 */
export interface GuestExecTemplateRef {
  vmx: string;
  user?: string;
}

export interface GuestExecInput {
  /** guest 登录用户；缺省 entry.user ?? 模板 user ?? 'researcher'。 */
  guestUser?: string;
  /** 现场输入的 guest 密码（瞬传，不落盘）。vmrun 只认密码，缺了报错。 */
  guestPassword?: string;
}

export interface GuestExecOptions {
  exec?: VmExec;
  /** config.json::vmTemplates（模板 vmx 解析 + guest 用户缺省值来源）。 */
  templates?: Record<string, GuestExecTemplateRef>;
  /** host 侧临时文件目录；默认 os.tmpdir()。测试传临时目录。 */
  hostTmpDir?: string;
  /** runProgramInGuest 超时；默认 10 分钟。 */
  execTimeoutMs?: number;
  /** 临时文件名随机段；可注入以便测试断言路径。默认 8 位随机 hex。 */
  runId?: () => string;
}

/** runProgramInGuest 失败分类：Tools 未运行 / 认证失败 / 目标未找到 / 未知。 */
export type GuestExecFailureKind = 'tools-not-running' | 'auth' | 'not-found' | 'unknown';

// ---------------------------------------------------------------------------
// Pure functions — vmrun command assembly + output parsing
// ---------------------------------------------------------------------------

/** 全部命令带 `-T ws`；`-gu/-gp` 是全局旗标，必须在子命令之前。
 *  windows guest:powershell -EncodedCommand(utf16le-b64,OS 抽象层);
 *  linux guest:/bin/bash -c(现状)。 */
export function buildGuestExecArgs(
  vmx: string,
  guestUser: string,
  guestPassword: string,
  guestShellCmd: string,
  family: 'linux' | 'windows' = 'linux',
): string[] {
  const base = [
    '-T', 'ws',
    '-gu', guestUser,
    '-gp', guestPassword,
    'runProgramInGuest', vmx,
    '-activeWindow', '-interactive',
  ];
  if (family === 'windows') {
    return [
      ...base,
      'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', psEncode(guestShellCmd),
    ];
  }
  return [...base, '/bin/bash', '-c', guestShellCmd];
}

/**
 * 输出采集包装：用户命令放进子 shell，stdout/stderr 合并落 .out，退出码
 * 落 .code。runProgramInGuest 等待 bash 退出即返回——两个文件此时已写完。
 * 路径由本模块生成（无空格无引号），不做转义；command 是载荷本体，原样嵌入。
 */
export function buildGuestCaptureScript(command: string, outPath: string, codePath: string): string {
  return `( ${command} ) > ${outPath} 2>&1; echo -n $? > ${codePath}`;
}

export function buildCopyFromGuestArgs(
  vmx: string,
  guestUser: string,
  guestPassword: string,
  guestPath: string,
  hostPath: string,
): string[] {
  return [
    '-T', 'ws',
    '-gu', guestUser,
    '-gp', guestPassword,
    'copyFileFromGuest', vmx,
    guestPath, hostPath,
  ];
}

/** 收尾清理 guest 临时文件（best-effort，失败不阻断主流程）。 */
export function buildDeleteGuestFileArgs(
  vmx: string,
  guestUser: string,
  guestPassword: string,
  guestPath: string,
): string[] {
  return [
    '-T', 'ws',
    '-gu', guestUser,
    '-gp', guestPassword,
    'deleteFileInGuest', vmx,
    guestPath,
  ];
}

/** 解析 .code 文件内容为整数退出码；解析不了返回 undefined（通道异常）。 */
export function parseGuestExitCode(content: string): number | undefined {
  const n = Number.parseInt(content.trim(), 10);
  return Number.isInteger(n) ? n : undefined;
}

/**
 * runProgramInGuest / copyFileFromGuest 失败分类（纯函数）：
 * - tools-not-running：VMware Tools 没在跑（含 guest 未开机/DGA 不响应）——
 *   引导「等 Tools 就绪 / 装 open-vm-tools」；
 * - auth：Invalid user name or password 等——guest 密码不对或用户不存在；
 * - not-found：vmx / guest 内路径不存在；
 * - unknown：其余。
 */
export function classifyGuestExecFailure(result: VmExecResult): GuestExecFailureKind {
  const text = `${result.error ?? ''}\n${result.stderr}\n${result.stdout}`.toLowerCase();
  if (/invalid user name or password|authentication failed|invalid credentials|access denied/.test(text)) {
    return 'auth';
  }
  if (
    /tools (are|is) not running|vmware tools.*not running|not running.*vmware tools/.test(text) ||
    /guest operating system is not|the guest is not running|unable to connect to the guest/.test(text)
  ) {
    return 'tools-not-running';
  }
  if (/not found|no such file|does not exist/.test(text)) {
    return 'not-found';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// vmx 解析（目录扫描注入化便于测试）
// ---------------------------------------------------------------------------

/**
 * vmName → .vmx 解析（D22 直连后）：vmTemplates 里的登记 VM —— recipeId
 * 命中，或模板 vmx 的文件名/目录名命中；找不到 → 清晰错误（指向 env adopt）。
 * 返回命中时的模板 user（guest 用户缺省值来源之一）。
 */
export function resolveVmxForVmName(
  vmName: string,
  options: {
    templates?: Record<string, GuestExecTemplateRef>;
  } = {},
): EnvResult<{ vmx: string; templateUser?: string }> {
  // vmTemplates 命中（recipeId / vmx 文件名 / vmx 目录名）
  const templates = options.templates ?? {};
  for (const [recipeId, template] of Object.entries(templates)) {
    if (!template || typeof template.vmx !== 'string' || !/\.vmx$/i.test(template.vmx)) continue;
    const base = template.vmx.replace(/\.vmx$/i, '');
    const fileStem = base.split(/[\\/]/).pop() ?? '';
    const dirName = base.split(/[\\/]/).slice(0, -1).pop() ?? '';
    if (vmName === recipeId || vmName === fileStem || vmName === dirName) {
      return { ok: true, vmx: template.vmx, templateUser: template.user };
    }
  }

  return {
    ok: false,
    error:
      `解析不到 VM "${vmName}" 的 .vmx——vmTemplates 里没有 recipeId / vmx 文件名 / 目录名与它对上的条目` +
      '（zhishi env adopt 养成的 VM 自动在册）。',
  };
}

/**
 * 1.3.7「实例即环境」——vm 条目的 id → vmx 唯一解析点（down/rm/snapshot/
 * rollback/guest-exec 全走这里，取代旧的「id 以 .vmx 结尾」启发式路由）。
 * 顺序：条目自带 vmx 字段（定位辅助，up/登记时写入）→ vmName（缺省回落
 * entry.id）经 vmTemplates 的 recipeId / vmx 文件名 / 目录名探测。
 * 非 vm 条目 / 解析不到 → ok:false + 可读错误。
 */
export function resolveVmxForEntry(
  entry: Pick<EnvironmentEntry, 'id' | 'kind' | 'vmName' | 'vmx'>,
  options: {
    /** config.json::vmTemplates（vmName → vmx 回落的探测表）。 */
    templates?: Record<string, GuestExecTemplateRef>;
  } = {},
): EnvResult<{ vmx: string; templateUser?: string }> {
  if (entry.kind !== 'vm') {
    return { ok: false, error: `环境 "${entry.id}" 不是 VM 条目（kind=${entry.kind}）` };
  }
  if (entry.vmx && /\.vmx$/i.test(entry.vmx)) {
    return { ok: true, vmx: entry.vmx };
  }
  const vmName = entry.vmName?.trim() || entry.id;
  return resolveVmxForVmName(vmName, options);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** runProgramInGuest 默认超时：guest 命令可能跑样本，给 10 分钟。 */
export const GUEST_EXEC_TIMEOUT_MS = 10 * 60_000;
/** copyFileFromGuest / deleteFileInGuest 都是秒级操作，超时兜底用。 */
export const GUEST_EXEC_FILE_OP_TIMEOUT_MS = 120_000;

/** Tail of vmrun output for error messages (bounded, last non-empty lines). */
function outputTail(result: VmExecResult, maxLines = 5): string {
  const text = (result.stderr || result.stdout || '').trim();
  if (!text) return result.error ?? '';
  const lines = text.split('\n').filter((l) => l.trim());
  return lines.slice(-maxLines).join('\n');
}

/** 认证失败的通道错误文案：含「guest 密码」标记，CLI 据此现场问密码重试。 */
function authFailureError(user: string, tail: string): string {
  return (
    `guest 认证失败（用户 "${user}"，vmrun 报 Invalid user name or password）——guest 密码不对或用户不存在。\n` +
    '重跑本命令并在提示时输入正确的 guest 密码（现场使用、不落盘）。' +
    (tail ? `\nvmrun 输出：\n${tail}` : '')
  );
}

/** Tools 未运行的通道错误文案：给「等就绪 / 装 open-vm-tools」指引。 */
function toolsNotRunningError(tail: string): string {
  return (
    'VMware Tools 未在 guest 运行，guest-exec 通道不可用。\n' +
    '若 VM 刚启动：等 Tools 就绪（通常几十秒）后重试；\n' +
    '若一直没装：在 guest 内安装 open-vm-tools（Debian/Ubuntu：`sudo apt install -y open-vm-tools`）后重试。' +
    (tail ? `\nvmrun 输出：\n${tail}` : '')
  );
}

/**
 * guest-exec 编排：前置校验 → 解析 vmx → 确认运行中 → runProgramInGuest
 * （包装脚本把 stdout/退出码落 guest 临时文件）→ copyFileFromGuest 取回
 * → 解析退出码 → 删 guest/host 临时文件。
 *
 * 返回 { ok: true, stdout, exitCode }：guest 命令非零退出原样带给调用方；
 * ok: false 只表示通道失败（Tools 没跑 / 认证失败 / VM 未运行等）。
 */
export async function vmGuestExec(
  entry: EnvironmentEntry,
  command: string,
  input: GuestExecInput = {},
  options: GuestExecOptions = {},
): Promise<EnvResult<{ stdout: string; exitCode: number }>> {
  if (entry.kind !== 'vm') {
    return { ok: false, error: `环境 "${entry.id}" 不是 VM（kind=${entry.kind}）——guest-exec 只服务断网隔离 VM` };
  }
  if (entry.address) {
    return {
      ok: false,
      error:
        `环境 "${entry.id}" 已配置 address（${entry.address}）——请走 SSH 通道：zhishi env open ${entry.id}；` +
        'guest-exec 只服务无 address 的断网隔离 VM',
    };
  }
  const vmName = entry.vmName?.trim();
  if (!vmName) {
    return { ok: false, error: `环境 "${entry.id}" 缺少 vmName（kind=vm 必填）` };
  }
  if (!command.trim()) {
    return { ok: false, error: '缺少要执行的命令（zhishi env exec <env-id> -- <command...>）' };
  }

  // vmrun 客户机通道只认密码——keyPath 救不了它（vmrun 不支持密钥认证）。
  const guestPassword = input.guestPassword ?? '';
  if (!guestPassword) {
    return {
      ok: false,
      error:
        'guest-exec 走 vmrun 客户机通道，只认 guest 密码（env 条目的 keyPath 在这里帮不上——vmrun 不支持密钥认证）。\n' +
        '重跑本命令并在提示时输入 guest 密码（现场使用、不落盘）。',
    };
  }

  const exec = options.exec ?? defaultVmrunExec;

  const vmwareError = await ensureVmwareAvailable(exec);
  if (vmwareError) return { ok: false, error: vmwareError };

  const resolved = resolveVmxForEntry(entry, {
    templates: options.templates,
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const vmx = resolved.vmx;

  const guestUser = input.guestUser?.trim() || entry.user?.trim() || resolved.templateUser?.trim() || 'researcher';

  // 前置：VM 必须在运行（vmrun list 精确命中解析出的 vmx）。
  const listResult = await exec(['vmrun', ...buildVmrunListArgs()], VMRUN_LIST_TIMEOUT_MS);
  if (listResult.exitCode !== 0 || listResult.error) {
    return { ok: false, error: `vmrun list 失败（VMware 不可用？）：\n${outputTail(listResult)}` };
  }
  if (!parseVmrunList(listResult.stdout).some((p) => p.toLowerCase() === vmx.toLowerCase())) {
    return {
      ok: false,
      error:
        `VM "${vmName}" 未在运行（${vmx} 不在 vmrun list 里）。\n` +
        '先启动 VM（zhishi env up <配方>，或在 Workstation 里手动启动），启动后等 VMware Tools 就绪再 exec。',
    };
  }

  // 临时文件路径（guest 侧按 OS 家族分派 + host 侧 tmpdir，同名随机段）。
  const runId = (options.runId ?? (() => randomBytes(4).toString('hex')))();
  const family = osFamilyOf(entry);
  const tag = `zhishi-exec-${runId}`;
  const guestOutPath = family === 'windows' ? `${PS_TEMP}\\${tag}.out` : `/tmp/${tag}.out`;
  const guestCodePath = family === 'windows' ? `${PS_TEMP}\\${tag}.code` : `/tmp/${tag}.code`;
  const hostTmpDir = options.hostTmpDir ?? tmpdir();
  const hostOutPath = join(hostTmpDir, `${tag}.out`);
  const hostCodePath = join(hostTmpDir, `${tag}.code`);

  const cleanupGuestFiles = async (): Promise<void> => {
    for (const guestPath of [guestOutPath, guestCodePath]) {
      try {
        await exec(['vmrun', ...buildDeleteGuestFileArgs(vmx, guestUser, guestPassword, guestPath)], GUEST_EXEC_FILE_OP_TIMEOUT_MS);
      } catch { /* best effort */ }
    }
  };
  const cleanupHostFiles = (): void => {
    for (const hostPath of [hostOutPath, hostCodePath]) {
      try {
        rmSync(hostPath, { force: true });
      } catch { /* best effort */ }
    }
  };

  // 1. 执行（包装脚本：stdout/退出码落 guest 临时文件；OS 家族分派包装）。
  const script = family === 'windows'
    ? psCaptureScript(command, guestOutPath, guestCodePath)
    : buildGuestCaptureScript(command, guestOutPath, guestCodePath);
  const runResult = await exec(
    ['vmrun', ...buildGuestExecArgs(vmx, guestUser, guestPassword, script, family)],
    options.execTimeoutMs ?? GUEST_EXEC_TIMEOUT_MS,
  );
  if (runResult.exitCode !== 0 || runResult.error) {
    cleanupHostFiles();
    const tail = outputTail(runResult);
    switch (classifyGuestExecFailure(runResult)) {
      case 'auth':
        return { ok: false, error: authFailureError(guestUser, tail) };
      case 'tools-not-running':
        return { ok: false, error: toolsNotRunningError(tail) };
      case 'not-found':
        return { ok: false, error: `guest 内目标未找到（${vmx} 或 guest shell 不存在？Linux 走 /bin/bash，Windows 走 powershell.exe——OS 家族不对会在 entry.osFamily 里修正）：\n${tail}` };
      default:
        return { ok: false, error: `runProgramInGuest 失败（guest-exec 通道错误）：\n${tail}` };
    }
  }

  // 2. 取回 stdout 与退出码。
  for (const [guestPath, hostPath, label] of [
    [guestOutPath, hostOutPath, 'stdout'],
    [guestCodePath, hostCodePath, '退出码'],
  ] as const) {
    const copyResult = await exec(
      ['vmrun', ...buildCopyFromGuestArgs(vmx, guestUser, guestPassword, guestPath, hostPath)],
      GUEST_EXEC_FILE_OP_TIMEOUT_MS,
    );
    if (copyResult.exitCode !== 0 || copyResult.error) {
      await cleanupGuestFiles();
      cleanupHostFiles();
      return {
        ok: false,
        error: `copyFileFromGuest 取回${label}失败（guest-exec 通道错误）：\n${outputTail(copyResult)}`,
      };
    }
  }

  let stdout = '';
  let exitCode: number | undefined;
  try {
    stdout = readFileSync(hostOutPath, 'utf-8');
    exitCode = parseGuestExitCode(readFileSync(hostCodePath, 'utf-8'));
  } catch (err) {
    await cleanupGuestFiles();
    cleanupHostFiles();
    return {
      ok: false,
      error: `host 侧临时文件读取失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 3. 收尾清理（best-effort，不阻断结果返回）。
  await cleanupGuestFiles();
  cleanupHostFiles();

  if (exitCode === undefined) {
    return { ok: false, error: 'guest 退出码文件内容无法解析（通道写入不完整？）——请重试' };
  }

  return { ok: true, stdout, exitCode };
}
