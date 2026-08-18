/**
 * env_bg — 环境内长驻进程通道（docs/env-bg-design.md）。
 *
 * 稳定性红线：
 *   - 真相在环境内：/tmp/zhishi-bg/<tag>.{log,pid,exit,cmd}，宿主零持久状态；
 *   - 薄编排层：全部动作都是一次性命令，复用 execInEnvironment 的 ssh/docker
 *     通道——本模块零 spawn、零连接管理；
 *   - 注入安全：command base64 编码进远端（不做自定义转义）；tag 严格白名单
 *     [A-Za-z0-9_-]{1,64}（会拼进路径与 kill/cat 参数）。
 *
 * guest-exec（断网 VM）后台通道 v1 不做——调用时返回清晰错误。
 */

import type { EnvironmentEntry } from '../../shared/config-types';
import { osFamilyOf, psEmbedCommand, type OsFamily } from '../environment/os-family';
import { execInEnvironment, resolveExecTarget, type EnvExec } from './env-exec';

export const ENV_BG_TOOL_NAME = 'env_bg';
export const BG_DIR = '/tmp/zhishi-bg';
/** Windows 侧的后台目录(ProgramData 全用户可写)。 */
export const BG_DIR_WIN = 'C:\\ProgramData\\zhishi-bg';
export const BG_TAG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_LOG_LIMIT = 8192;

export interface BgExecOptions {
  /** 测试注入：一次性命令 exec（穿透给 execInEnvironment）。 */
  exec?: EnvExec;
  /** 单操作超时（默认 30s——start/poll/log/kill 都是快命令）。 */
  timeoutMs?: number;
}

export interface BgStartResult {
  tag: string;
  pid: number;
  logPath: string;
}

export interface BgPollResult {
  tag: string;
  status: 'running' | 'exited' | 'dead' | 'missing';
  pid?: number;
  exitCode?: number;
}

export interface BgLogResult {
  tag: string;
  size: number;
  text: string;
  truncated: boolean;
}

export interface BgListEntry {
  tag: string;
}

// ---------------------------------------------------------------------------
// tag 与远端命令组装（纯函数，单测直击）
// ---------------------------------------------------------------------------

export function validateTag(tag: string): string | undefined {
  if (!BG_TAG_RE.test(tag)) {
    return `tag "${tag}" 非法：只允许字母/数字/_-（1-64 字符），不允许路径分隔符/空格/shell 元字符`;
  }
  return undefined;
}

function b64(command: string): string {
  return Buffer.from(command, 'utf8').toString('base64');
}

/** start 的远端一次性命令。返回 stdout = 后台 shell 的 pid。
 *  两个稳定性陷阱已钉（活体实测）：
 *   ① 后台进程必须 `< /dev/null` 重定向 stdin——否则它继承 ssh 通道的
 *      stdin,ssh 会等它结束才返回,start 表现为超时假死;
 *   ② 全程绝对路径 + mkdir 前置到前台(`;` 而非 `&&` 接后台段)——`cd` 若被
 *      `&&` 卷进后台子壳,前台 `echo $! > pid` 会落到 $HOME 而非 BG_DIR。 */
export function buildBgStartRemote(command: string, tag: string, family: OsFamily = 'linux'): string {
  if (family === 'windows') return buildBgStartRemoteWin(command, tag);
  const encoded = b64(command);
  return (
    `mkdir -p ${BG_DIR}; ` +
    `nohup sh -c 'echo ${encoded} | base64 -d | sh; echo $? > ${BG_DIR}/${tag}.exit' < /dev/null > ${BG_DIR}/${tag}.log 2>&1 & ` +
    `echo $! > ${BG_DIR}/${tag}.pid; cat ${BG_DIR}/${tag}.pid`
  );
}

/**
 * Windows 变体:用户命令落 <tag>.cmd(追加退出码回写行),Start-Process
 * 后台起 cmd /c,无需重定向 stdin——Windows 的 ssh 通道不被子进程挂住
 * 的方式是 Start-Process 脱离调用会话(-WindowStyle Hidden)。
 * .cmd 内容 = 用户命令 + 重定向 + 退出码回写(%ERRORLEVEL%)。
 */
export function buildBgStartRemoteWin(command: string, tag: string): string {
  const d = BG_DIR_WIN;
  const cmdFile = `${d}\\${tag}.cmd`;
  const cmdBody = `@echo off\r\n${command} > "${d}\\${tag}.log" 2>&1\r\n@echo %ERRORLEVEL%> "${d}\\${tag}.exit"\r\n`;
  const cmdB64 = psEmbedCommand(cmdBody);
  return [
    `$d='${d}'; New-Item -ItemType Directory -Force $d | Out-Null`,
    `$b='${cmdB64}'; [IO.File]::WriteAllText('${cmdFile}',[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)))`,
    `$p=Start-Process cmd.exe -ArgumentList '/c','${cmdFile}' -WindowStyle Hidden -PassThru`,
    `$p.Id | Out-File '${d}\\${tag}.pid'; $p.Id`,
  ].join('; ');
}

/** poll：现场判定 running/exited/dead/missing。 */
export function buildBgPollRemote(tag: string, family: OsFamily = 'linux'): string {
  if (family === 'windows') {
    const d = BG_DIR_WIN;
    return (
      `$t='${d}\\${tag}'; ` +
      `if(!(Test-Path "$t.pid")){'missing'}` +
      `else{$id=(Get-Content "$t.pid").Trim();` +
      `if(Get-Process -Id $id -ErrorAction SilentlyContinue){"running:$id"}` +
      `elseif(Test-Path "$t.exit"){'exited:'+((Get-Content "$t.exit").Trim())}` +
      `else{"dead:$id"}}`
    );
  }
  return (
    `t=${BG_DIR}/${tag}; ` +
    `if [ ! -f $t.pid ]; then echo missing; ` +
    `elif ps -p "$(cat $t.pid)" >/dev/null 2>&1; then echo "running:$(cat $t.pid)"; ` +
    `elif [ -f $t.exit ]; then echo "exited:$(cat $t.exit)"; ` +
    `else echo "dead:$(cat $t.pid)"; fi`
  );
}

/** log：offset=0 → 尾部 limit 字节；offset>0 → 从 offset 起 limit 字节。 */
export function buildBgLogRemote(tag: string, offset: number, limit: number, family: OsFamily = 'linux'): string {
  if (family === 'windows') {
    const f = `${BG_DIR_WIN}\\${tag}.log`;
    return (
      `$f='${f}'; if(!(Test-Path $f)){'missing'}else{(Get-Item $f).Length;` +
      `$txt=[IO.File]::ReadAllText($f);` +
      (offset > 0
        ? `if(${offset} -lt $txt.Length){$txt.Substring(${offset},[Math]::Min(${limit},$txt.Length-${offset}))}`
        : `if($txt.Length -le ${limit}){$txt}else{$txt.Substring($txt.Length-${limit})}`) +
      `}`
    );
  }
  const f = `${BG_DIR}/${tag}.log`;
  const slice = offset > 0
    ? `tail -c +${offset} $f | head -c ${limit}`
    : `tail -c ${limit} $f`;
  return `f=${f}; if [ ! -f $f ]; then echo missing; else wc -c < $f; ${slice}; fi`;
}

/** kill：SIGTERM；进程不在 → not-running。 */
export function buildBgKillRemote(tag: string, family: OsFamily = 'linux'): string {
  if (family === 'windows') {
    const d = BG_DIR_WIN;
    return (
      `$t='${d}\\${tag}'; ` +
      `if(!(Test-Path "$t.pid")){'missing'}` +
      `else{$id=(Get-Content "$t.pid").Trim();` +
      `if(Get-Process -Id $id -ErrorAction SilentlyContinue){Stop-Process -Id $id -Force;"killed:$id"}` +
      `else{'not-running'}}`
    );
  }
  return (
    `t=${BG_DIR}/${tag}; ` +
    `if [ ! -f $t.pid ]; then echo missing; ` +
    `elif ps -p "$(cat $t.pid)" >/dev/null 2>&1; then kill "$(cat $t.pid)" && echo killed:$(cat $t.pid) || echo kill-failed; ` +
    `else echo not-running; fi`
  );
}

/** list：只报 tag 名（日志残留不保证进程活着，语义见设计底账）。 */
export function buildBgListRemote(family: OsFamily = 'linux'): string {
  if (family === 'windows') {
    return `Get-ChildItem '${BG_DIR_WIN}\\*.log' -ErrorAction SilentlyContinue | ForEach-Object{$_.BaseName}`;
  }
  return `ls -1 ${BG_DIR}/*.log 2>/dev/null | sed 's#.*/##; s#\\.log$##'`;
}

// ---------------------------------------------------------------------------
// stdout 解析（纯函数）
// ---------------------------------------------------------------------------

export function parseBgStart(stdout: string): { pid?: number } {
  const pid = Number(stdout.trim());
  return Number.isInteger(pid) && pid > 0 ? { pid } : {};
}

export function parseBgPoll(stdout: string, tag: string): BgPollResult {
  const line = stdout.trim();
  if (line === 'missing') return { tag, status: 'missing' };
  const m = /^(running|dead):(\d+)$/.exec(line);
  if (m) {
    return { tag, status: m[1] as 'running' | 'dead', pid: Number(m[2]) };
  }
  const e = /^exited:(-?\d+)$/.exec(line);
  if (e) return { tag, status: 'exited', exitCode: Number(e[1]) };
  return { tag, status: 'missing' };
}

export function parseBgLog(stdout: string, tag: string, limit: number): BgLogResult | null {
  const s = stdout;
  if (s.trim() === 'missing') return null;
  // 首行 size,余下为切片。
  const nl = s.indexOf('\n');
  if (nl < 0) return { tag, size: 0, text: '', truncated: false };
  const size = Number(s.slice(0, nl).trim());
  const text = s.slice(nl + 1);
  return { tag, size: Number.isFinite(size) ? size : 0, text, truncated: text.length >= limit };
}

export function parseBgList(stdout: string): BgListEntry[] {
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((tag) => ({ tag }));
}

// ---------------------------------------------------------------------------
// 编排（薄包 execInEnvironment；ssh/docker 同一条路径）
// ---------------------------------------------------------------------------

function bgEntryOk(entry: EnvironmentEntry): { channel: 'ssh' | 'docker' } | { error: string } {
  const resolved = resolveExecTarget(entry);
  if (!resolved.ok) return { error: resolved.error };
  if (resolved.execTarget.channel === 'guest') {
    return { error: 'env_bg 后台通道暂不支持 guest-exec（断网 VM），见 docs/env-bg-design.md Phase 3' };
  }
  return { channel: resolved.execTarget.channel };
}

export async function envBgStart(
  entry: EnvironmentEntry,
  command: string,
  tag: string,
  options: BgExecOptions = {},
): Promise<{ ok: true } & BgStartResult | { ok: false; error: string }> {
  const badTag = validateTag(tag);
  if (badTag) return { ok: false, error: badTag };
  const gate = bgEntryOk(entry);
  if ('error' in gate) return { ok: false, error: gate.error };

  // 占用检查：tag 已占用且进程活着 → 拒绝（防并发撞名覆盖日志）。
  const existing = await envBgPoll(entry, tag, options);
  if (existing.ok && (existing.status === 'running')) {
    return { ok: false, error: `tag "${tag}" 已被运行中的进程占用（先 env_bg kill 或换名）` };
  }

  const r = await execInEnvironment(entry, buildBgStartRemote(command, tag, osFamilyOf(entry)), {
    exec: options.exec,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  if (!r.ok) return { ok: false, error: r.error };
  const { pid } = parseBgStart(r.stdout);
  if (!pid) return { ok: false, error: `启动失败：远端未返回 pid（stdout: ${r.stdout.slice(0, 200)}）` };
  return { ok: true, tag, pid, logPath: `${BG_DIR}/${tag}.log` };
}

export async function envBgPoll(
  entry: EnvironmentEntry,
  tag: string,
  options: BgExecOptions = {},
): Promise<{ ok: true } & BgPollResult | { ok: false; error: string }> {
  const badTag = validateTag(tag);
  if (badTag) return { ok: false, error: badTag };
  const gate = bgEntryOk(entry);
  if ('error' in gate) return { ok: false, error: gate.error };
  const r = await execInEnvironment(entry, buildBgPollRemote(tag, osFamilyOf(entry)), {
    exec: options.exec,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, ...parseBgPoll(r.stdout, tag) };
}

export async function envBgLog(
  entry: EnvironmentEntry,
  tag: string,
  offset: number,
  limit: number,
  options: BgExecOptions = {},
): Promise<{ ok: true } & BgLogResult | { ok: false; error: string }> {
  const badTag = validateTag(tag);
  if (badTag) return { ok: false, error: badTag };
  const gate = bgEntryOk(entry);
  if ('error' in gate) return { ok: false, error: gate.error };
  const lim = Math.max(1, Math.min(limit || DEFAULT_LOG_LIMIT, 64 * 1024));
  const r = await execInEnvironment(entry, buildBgLogRemote(tag, Math.max(0, offset), lim, osFamilyOf(entry)), {
    exec: options.exec,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  if (!r.ok) return { ok: false, error: r.error };
  const parsed = parseBgLog(r.stdout, tag, lim);
  if (!parsed) return { ok: false, error: `tag "${tag}" 无日志（可能从未启动或日志已丢）` };
  return { ok: true, ...parsed };
}

export async function envBgKill(
  entry: EnvironmentEntry,
  tag: string,
  options: BgExecOptions = {},
): Promise<{ ok: true; outcome: string } | { ok: false; error: string }> {
  const badTag = validateTag(tag);
  if (badTag) return { ok: false, error: badTag };
  const gate = bgEntryOk(entry);
  if ('error' in gate) return { ok: false, error: gate.error };
  const r = await execInEnvironment(entry, buildBgKillRemote(tag, osFamilyOf(entry)), {
    exec: options.exec,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, outcome: r.stdout.trim() || 'done' };
}

export async function envBgList(
  entry: EnvironmentEntry,
  options: BgExecOptions = {},
): Promise<{ ok: true; entries: BgListEntry[] } | { ok: false; error: string }> {
  const gate = bgEntryOk(entry);
  if ('error' in gate) return { ok: false, error: gate.error };
  const r = await execInEnvironment(entry, buildBgListRemote(osFamilyOf(entry)), {
    exec: options.exec,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, entries: parseBgList(r.stdout) };
}
