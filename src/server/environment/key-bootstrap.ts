/**
 * 1.6.5 — 密钥引导（key bootstrap）：「一次密码，永久密钥」。
 *
 * 背景：VM/SSH 环境的长期凭据只有 keyPath（D-T4：密码不落盘）。adopt 已
 * 自动配密钥，但手动登记（env add）此前要求用户自己生成密钥、自己把公钥
 * 塞进 guest——不懂密钥的用户卡死。本模块把这一步自动化：登记时现场给的
 * 密码（瞬传不落盘）→ ensureKeyMaterial 生成/复用密钥对 → 密码通道推公钥
 * 进 guest → 调用方把 keyPath 落条目。
 *
 * 通道分派：
 *   - 有网络目标（ssh host / vm address）→ plink 密码通道（复用 vm-adopt 的
 *     签名验证 + hostkey 钉指纹件）；
 *     - linux guest：写 ~/.ssh/authorized_keys（sh 语义，幂等 grep -qF）；
 *     - windows guest（已有 sshd）：powershell -EncodedCommand——按当前用户
 *       是否管理员（SID S-1-5-32-544，本地化免疫）选落点：管理员 →
 *       C:\ProgramData\ssh\administrators_authorized_keys（sshd 只认它）+
 *       icacls 钉 ACL；非管理员 → 用户目录 .ssh/authorized_keys。
 *   - 断网 Windows VM（kind=vm 无 address 有 vmx）→ vmrun 客户机通道
 *     （runProgramInGuest，guest 密码 = 登录密码；自写 log/code 文件核对，
 *     同 M2 引导纪律）。guest 无 sshd 时只推 key 不够——报指向 env adopt
 *     的错误（adopt 会装 OpenSSH）。
 *   - 断网 Linux VM：不做（无密码可推的通用通道——guest 内写他人
 *     authorized_keys 要 sudo，密码通道正是要绕开的东西）→ 报指向 env
 *     adopt 的错误。
 *
 * 结构照 vm-adopt.ts：脚本组装是纯函数；进程调用走可注入 VmExec，单测
 * 绝不真碰 plink/vmrun。
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { psEncode, type OsFamily } from './os-family';
import {
  buildPlinkArgs,
  defaultAdoptExec,
  ensureKeyMaterial,
  ensurePlinkAvailable,
  resolveHostKeyFingerprints,
  type PlinkDownload,
  type VmExec,
} from './vm-adopt';
import {
  buildCopyFromGuestArgs,
  buildDeleteGuestFileArgs,
  buildGuestExecArgs,
  classifyGuestExecFailure,
  parseGuestExitCode,
  resolveVmxForEntry,
  type GuestExecTemplateRef,
} from './vm-guest-exec';
import {
  buildVmrunListArgs,
  ensureVmwareAvailable,
  parseVmrunList,
  VMRUN_LIST_TIMEOUT_MS,
  type EnvResult,
} from './vm-lifecycle';

/** 引导目标：environment/add 条目字段的最小子集（登记前的原始输入）。 */
export interface KeyBootstrapTarget {
  kind: 'ssh' | 'vm';
  /** ssh 条目的主机 / vm 条目的 guest 地址。 */
  host?: string;
  address?: string;
  /** 登录用户（公钥推给这个账号）。 */
  user: string;
  port?: number;
  osFamily?: OsFamily;
  /** 断网 VM 的定位（无 address 时走 vmrun 通道需要）。 */
  vmx?: string;
  vmName?: string;
  id?: string;
}

export interface KeyBootstrapOptions {
  exec?: VmExec;
  /** 生成/复用密钥对的落点目录（生产 = ~/.zhishi/keys；测试传临时目录）。 */
  keysDir: string;
  /** 指定私钥（优先于默认候选探测；测试隔离宿主机 ~/.ssh 用）。 */
  keyPath?: string;
  plinkPath?: string;
  download?: PlinkDownload;
  /** vmrun 通道的 vmTemplates 探测表（resolveVmxForEntry 回落用）。 */
  templates?: Record<string, GuestExecTemplateRef>;
}

export interface KeyBootstrapOutcome {
  /** 生成的/复用的私钥路径（调用方落条目 keyPath）。 */
  keyPath: string;
  /** 实际使用的推送通道。 */
  via: 'plink' | 'vmrun';
}

export const KEY_BOOTSTRAP_SSH_TIMEOUT_MS = 30_000;
/** vmrun 通道：key push 是秒级操作，但 Tools 慢启动给余量。 */
export const KEY_BOOTSTRAP_VMRUN_TIMEOUT_MS = 120_000;

/** 断网 VM key push 的临时文件（log/code 成对，同 M2 引导纪律）。 */
export const WIN_KEYPUSH_LOG = 'C:\\Windows\\Temp\\zhishi-keypush.log';
export const WIN_KEYPUSH_CODE = 'C:\\Windows\\Temp\\zhishi-keypush.code';

// ---------------------------------------------------------------------------
// 纯函数 — 推送脚本组装
// ---------------------------------------------------------------------------

/**
 * linux 推送命令（plink 远端执行，sh 语义）：建 .ssh、幂等追加公钥、
 * 权限钉 700/600。单引号安全：公钥字符集不含单引号。
 */
export function buildLinuxKeyPushCommand(pubkey: string): string {
  return (
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh && ` +
    `(grep -qF '${pubkey}' ~/.ssh/authorized_keys 2>/dev/null || echo '${pubkey}' >> ~/.ssh/authorized_keys) && ` +
    `chmod 600 ~/.ssh/authorized_keys && echo KEY_BOOTSTRAP_OK`
  );
}

/**
 * windows 推送脚本（powershell；plink 远端经 -EncodedCommand / vmrun 同用）。
 * 管理员（SID S-1-5-32-544，本地化免疫）→ administrators_authorized_keys
 * + icacls 钉 ACL（sshd 对管理员用户只认它）；非管理员 → 用户目录 .ssh。
 * 幂等：公钥已在不重复写。logFile/codeFile 给定时写日志与 0/1（vmrun
 * 通道不回传 stdout/退出码，靠文件核对——同 M2 引导纪律）。
 */
export function buildWindowsKeyPushScript(pubkey: string, files?: { codeFile: string; logFile: string }): string {
  const pub = pubkey.replace(/'/g, "''");
  const logLine = files ? `\nfunction Log($m) { Add-Content -Path '${files.logFile}' -Value $m }` : '';
  const log = (msg: string) => (files ? `\n  Log '${msg}'` : '');
  return `
$ErrorActionPreference = 'Stop'${logLine}
try {
  $pub = '${pub}'
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.SecurityIdentifier]'S-1-5-32-544')
  if ($isAdmin) {
    $keyFile = 'C:\\ProgramData\\ssh\\administrators_authorized_keys'
  } else {
    $keyFile = Join-Path $HOME '.ssh\\authorized_keys'
    $dir = Split-Path $keyFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  }
  if (-not ((Test-Path $keyFile) -and ((Get-Content $keyFile -Raw) -match [regex]::Escape($pub)))) {
    Add-Content -Path $keyFile -Value $pub
  }
  if ($isAdmin) { icacls $keyFile /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null }
  Write-Output ('KEY_BOOTSTRAP_OK ' + $keyFile)${log('key pushed')}
  ${files ? `[IO.File]::WriteAllText('${files.codeFile}', '0')` : ''}
} catch {
  Write-Output ('KEY_BOOTSTRAP_FAIL ' + $_.Exception.Message)${files ? `\n  Log ('FAILED: ' + $_.Exception.Message)\n  [IO.File]::WriteAllText('${files.codeFile}', '1')` : ''}
}
`.trim();
}

/** plink argv 补端口（buildPlinkArgs 不含端口——adopt 恒 22；登记场景用户会给）。 */
export function buildPlinkArgsWithPort(
  plinkPath: string, user: string, address: string, password: string, command: string,
  hostkeyFingerprints?: string[], port?: number,
): string[] {
  const args = buildPlinkArgs(plinkPath, user, address, password, command, hostkeyFingerprints);
  if (port !== undefined) {
    // -P 是全局旗标，插在 -pw 之后、目标之前
    const targetIdx = args.indexOf(`${user}@${address}`);
    args.splice(targetIdx, 0, '-P', String(port));
  }
  return args;
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

/**
 * 密钥引导主流程：密码 → 密钥对 → 推公钥。成功返回 keyPath（调用方落条目）；
 * 任何一步失败返回用户可读错误。密码只用在这一调用里，绝不落盘。
 */
export async function bootstrapKeyForTarget(
  target: KeyBootstrapTarget,
  password: string,
  options: KeyBootstrapOptions,
): Promise<EnvResult<KeyBootstrapOutcome>> {
  if (!password) {
    return { ok: false, error: '密钥引导需要登录密码（现场使用、不落盘）' };
  }
  if (!target.user.trim()) {
    return { ok: false, error: '密钥引导需要登录用户（--user）——公钥要知道推给哪个账号' };
  }
  const exec = options.exec ?? defaultAdoptExec;
  const family = target.osFamily ?? 'linux';

  const keyMaterial = await ensureKeyMaterial(exec, { keyPath: options.keyPath, keysDir: options.keysDir });
  if (!keyMaterial.ok) return { ok: false, error: keyMaterial.error };
  const pubkey = keyMaterial.pubkey;

  const address = (target.host ?? target.address)?.trim();
  if (address) {
    // plink 密码通道（linux / 已有 sshd 的 windows）
    const plink = options.plinkPath
      ? { ok: true as const, path: options.plinkPath }
      : await ensurePlinkAvailable(exec, options.download);
    if (!plink.ok) return { ok: false, error: plink.error };
    const fps = await resolveHostKeyFingerprints(exec, address);
    if (!fps) {
      return { ok: false, error: `取不到 ${address}:22 的 host key 指纹——guest 的 sshd 在跑且网络可达吗？（Windows VM 无 sshd：用 zhishi env adopt 一键装）` };
    }
    const command = family === 'windows'
      ? `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${psEncode(buildWindowsKeyPushScript(pubkey))}`
      : buildLinuxKeyPushCommand(pubkey);
    const r = await exec(
      buildPlinkArgsWithPort(plink.path, target.user, address, password, command, fps, target.port),
      KEY_BOOTSTRAP_SSH_TIMEOUT_MS,
    );
    const out = `${r.stdout}\n${r.stderr}`;
    if (r.exitCode !== 0 || r.error || !out.includes('KEY_BOOTSTRAP_OK')) {
      const authHint = /denied|authentication/i.test(out) ? '（密码不对或用户不存在）' : '';
      return {
        ok: false,
        error: `公钥推送失败${authHint}（${target.user}@${address}）：\n${out.trim().split('\n').slice(-5).join('\n')}`,
      };
    }
    return { ok: true, keyPath: keyMaterial.keyPath, via: 'plink' };
  }

  // 断网 VM → vmrun 客户机通道（仅 windows；linux 断网无通用密码通道）
  if (target.kind === 'vm') {
    if (family !== 'windows') {
      return {
        ok: false,
        error: '断网 Linux VM 没有通用密码推送通道（guest 内写 authorized_keys 需要已登录的 shell）——' +
          '用 zhishi env adopt 养成（密码通道是 plink，要求 guest 有 sshd），或手动配好公钥后用 --key-path 登记',
      };
    }
    const vmError = await ensureVmwareAvailable(exec);
    if (vmError) return { ok: false, error: vmError };
    const resolved = resolveVmxForEntry(
      { id: target.id ?? target.vmName ?? '?', kind: 'vm', vmName: target.vmName, vmx: target.vmx },
      { templates: options.templates },
    );
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const vmx = resolved.vmx;

    const listResult = await exec(['vmrun', ...buildVmrunListArgs()], VMRUN_LIST_TIMEOUT_MS);
    if (listResult.exitCode !== 0 || !parseVmrunList(listResult.stdout).some((p) => p.toLowerCase() === vmx.toLowerCase())) {
      return { ok: false, error: `VM 未在运行（${vmx} 不在 vmrun list 里）——先启动 VM（或 zhishi env up）再引导` };
    }

    const script = buildWindowsKeyPushScript(pubkey, { codeFile: WIN_KEYPUSH_CODE, logFile: WIN_KEYPUSH_LOG });
    const run = await exec(
      ['vmrun', ...buildGuestExecArgs(vmx, target.user, password, script, 'windows')],
      KEY_BOOTSTRAP_VMRUN_TIMEOUT_MS,
    );
    if (run.exitCode !== 0 || run.error) {
      const tail = (run.stderr || run.stdout || run.error || '').trim().split('\n').slice(-5).join('\n');
      switch (classifyGuestExecFailure(run)) {
        case 'auth':
          return { ok: false, error: `guest 认证失败（用户 "${target.user}"，vmrun 报 Invalid user name or password）——guest 密码不对或用户不存在。\n${tail}` };
        case 'tools-not-running':
          return { ok: false, error: `VMware Tools 未在 guest 运行——断网 VM 的密钥引导以 Tools 为地板，请在 guest 控制台装 VMware Tools 后重试。\n${tail}` };
        default:
          return { ok: false, error: `密钥引导执行失败（vmrun runProgramInGuest）：\n${tail}` };
      }
    }

    // 取回 code 核对（脚本自写；log 顺带做排障尾部）
    const hostCode = join(tmpdir(), `zhishi-keypush-${randomBytes(4).toString('hex')}.code`);
    const hostLog = `${hostCode}.log`;
    try {
      const copyCode = await exec(
        ['vmrun', ...buildCopyFromGuestArgs(vmx, target.user, password, WIN_KEYPUSH_CODE, hostCode)],
        KEY_BOOTSTRAP_VMRUN_TIMEOUT_MS,
      );
      if (copyCode.exitCode !== 0 || copyCode.error || !existsSync(hostCode)) {
        return { ok: false, error: `引导结果取回失败（copyFileFromGuest）：${(copyCode.stderr || copyCode.stdout || copyCode.error || '').trim()}` };
      }
      const code = parseGuestExitCode(readFileSync(hostCode, 'utf-8'));
      let logTail = '';
      const copyLog = await exec(
        ['vmrun', ...buildCopyFromGuestArgs(vmx, target.user, password, WIN_KEYPUSH_LOG, hostLog)],
        KEY_BOOTSTRAP_VMRUN_TIMEOUT_MS,
      );
      if (copyLog.exitCode === 0 && !copyLog.error && existsSync(hostLog)) {
        logTail = readFileSync(hostLog, 'utf-8').trim().split('\n').slice(-5).join('\n');
      }
      if (code !== 0) {
        return { ok: false, error: `公钥推送在 guest 内失败（code=${code ?? '?'}）：\n${logTail || '（无日志）'}` };
      }
    } finally {
      for (const guestPath of [WIN_KEYPUSH_CODE, WIN_KEYPUSH_LOG]) {
        try {
          await exec(['vmrun', ...buildDeleteGuestFileArgs(vmx, target.user, password, guestPath)], KEY_BOOTSTRAP_VMRUN_TIMEOUT_MS);
        } catch { /* best effort */ }
      }
      try { rmSync(hostCode, { force: true }); rmSync(hostLog, { force: true }); } catch { /* best effort */ }
    }
    return { ok: true, keyPath: keyMaterial.keyPath, via: 'vmrun' };
  }

  return { ok: false, error: '密钥引导需要网络目标（host/address）或 VM 定位（vmx）——参数不足' };
}
