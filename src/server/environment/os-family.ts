/**
 * OS 家族抽象层（guest OS abstraction）——二进制/恶意软件域的 Windows 执行面。
 *
 * 背景：环境层的全部执行通道此前隐含「guest = Linux」假设（sh/bash 包装、
 * apt 系初始化）。二进制/恶意软件域的 Windows 目标（PE 逆向、Windows 样本
 * detonate）需要 PowerShell 包装。本模块是唯一的 OS 分派点：
 *
 *   osFamilyOf(entry)   —— 条目 osFamily 字段（缺省 linux，存量兼容）
 *   psEncode(script)    —— PowerShell -EncodedCommand 的 utf16le-base64
 *   psCaptureScript(cmd, out, code) —— Windows 的 stdout/退出码捕获包装
 *                          （对齐 Linux 的 buildGuestCaptureScript 语义）
 *
 * 双 base64 封装纪律：用户命令本体 utf8-base64 嵌进 ps 脚本，ps 脚本整体再
 * utf16le-base64 给 -EncodedCommand——任何引号/换行/特殊字符都不破壳
 * （与 bg-exec 的 base64 纪律同构）。
 *
 * v1 范围：linux-sh / windows-ps 两族。guest-exec/env_exec/env_bg 三通道的
 * 分派都从这里出。adopt 的 Windows 自动初始化不在本层（v1 不做）。
 */

import { readFileSync } from 'node:fs';

import type { EnvironmentEntry } from './registry';

export type OsFamily = 'linux' | 'windows';

/** 条目的 guest OS 家族；未声明 → linux（存量条目的隐含假设）。 */
export function osFamilyOf(entry: Pick<EnvironmentEntry, 'osFamily'>): OsFamily {
  return entry.osFamily === 'windows' ? 'windows' : 'linux';
}

/** PowerShell -EncodedCommand 的编码（UTF-16LE base64，PS 的硬约定）。 */
export function psEncode(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** 用户命令 → utf8 base64（嵌进 ps 脚本的第二层封装）。 */
export function psEmbedCommand(command: string): string {
  return Buffer.from(command, 'utf8').toString('base64');
}

/** ssh 的 Windows 包装：用户命令 cmd /c 执行,退出码经 exit $LASTEXITCODE
 *  透传(ssh 把远端退出码带回宿主)。EncodedCommand 避 cmd 引号地狱。 */
export function psShellWrapper(command: string): string {
  return (
    `$b='${psEmbedCommand(command)}';` +
    `$c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b));` +
    `cmd /c $c;exit $LASTEXITCODE`
  );
}

/** Windows guest 的临时文件目录（所有用户可写，恒存在）。 */
export const PS_TEMP = 'C:\\Windows\\Temp';

// ---------------------------------------------------------------------------
// guest OS 探测(vmx 静态读取——VM 不用开机、不用 Tools、不用 ssh)
// ---------------------------------------------------------------------------

/** guestOS 字符串 → 家族(纯函数)。win* → windows;其余/空 → linux。 */
export function osFamilyFromGuestOS(guestOS: string | undefined | null): OsFamily {
  return guestOS && /^win/i.test(guestOS.trim()) ? 'windows' : 'linux';
}

/**
 * 从 .vmx 读 guestOS 判定家族。读不到文件/字段 → null(调用方回落缺省)。
 * 这是 VM 条目的零探测判定——.vmx 静态声明,VM 关着也能判。
 */
export function detectOsFamilyFromVmx(vmxPath: string): OsFamily | null {
  try {
    const content = readFileSync(vmxPath, 'utf-8');
    const m = /^guestOS\s*=\s*"([^"]+)"/m.exec(content);
    if (!m) return null;
    return osFamilyFromGuestOS(m[1]);
  } catch {
    return null;
  }
}

/**
 * Windows 的捕获包装（对齐 Linux `( cmd ) > out 2>&1; echo $? > code`）：
 * 用户命令经 cmd /c 执行（任意 shell 命令形态都通，退出码取 $LASTEXITCODE），
 * stdout/stderr 合并落 out，退出码落 code。
 */
export function psCaptureScript(command: string, outPath: string, codePath: string): string {
  const b = psEmbedCommand(command);
  return (
    `$b='${b}';` +
    `$c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b));` +
    `$o=(cmd /c $c 2>&1 | Out-String);` +
    `[IO.File]::WriteAllText('${outPath}',$o);` +
    `[IO.File]::WriteAllText('${codePath}',"$LASTEXITCODE")`
  );
}
