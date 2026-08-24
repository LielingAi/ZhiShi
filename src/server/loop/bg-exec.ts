/**
 * env_bg — 环境内长驻进程通道（docs/spec/env-bg-design.md）。
 *
 * 稳定性红线：
 *   - 真相在环境内：/tmp/zhishi-bg/<tag>.{log,pid,exit,cmd}；宿主侧只有
 *     一张可弃的登记表（bg-registry.ts，Phase 3），丢了不致命；
 *   - 薄编排层：全部动作都是一次性命令，复用 execInEnvironment 的 ssh/docker
 *     通道——本模块零 spawn、零连接管理；
 *   - 注入安全：command base64 编码进远端（不做自定义转义）；tag 严格白名单
 *     [A-Za-z0-9_-]{1,64}（会拼进路径与 kill/cat 参数）。
 *
 * Phase 3（稳定性闭环，docs/spec/env-bg-design.md §8）新增：
 *   - buildBgProbeRemote / envBgPoll knownPid：存活探测（kill -0 级 +
 *     .pid 一致性校验），探测通道失败保守报 running+probeFailed 不误杀；
 *   - buildBgReapRemote / envBgReap：回收 kill（按登记 pid + 一致性校验）。
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
  /**
   * Phase 3 存活探测：登记表里记的 pid。提供时 poll 走探测通道
   * （buildBgProbeRemote，kill -0 级 + .pid 一致性校验，与 start 拿
   * pid 同一条通道）；不提供时走远端 .pid/.exit 现场判定。探测命令
   * 本身失败（ssh 断流）→ 保守报 running+probeFailed，绝不误杀。
   */
  knownPid?: number;
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
  /**
   * Phase 3：true = 探测命令本身失败（环境不可达/超时），结果保守地
   * 报 running——这不是「进程活着」的证据，是「没法证伪」。调用方
   * 必须保留登记、不广播 finished、不回收杀掉。
   */
  probeFailed?: boolean;
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

/** start 的远端一次性命令。返回 stdout = 后台进程组长的 pid。
 *  稳定性陷阱（活体实测钉过，Phase 3 再钉一条）：
 *   ① 后台进程必须 `< /dev/null` 重定向 stdin——否则它继承 ssh 通道的
 *      stdin,ssh 会等它结束才返回,start 表现为超时假死;
 *   ② 全程绝对路径 + mkdir 前置到前台(`;` 而非 `&&` 接后台段)——`cd` 若被
 *      `&&` 卷进后台子壳,前台 `echo $! > pid` 会落到 $HOME 而非 BG_DIR。
 *   ③ 用 `setsid` 建独立进程组(组长 pid = 登记 pid)——回收时按组杀才
 *      杀得干净。旧的 nohup 方案只登记外层 shell,内层 sh → sleep 的孙
 *      进程在回收时被 reparent 残留(活体实测:sleep 600 回收后仍存活)。 */
export function buildBgStartRemote(command: string, tag: string, family: OsFamily = 'linux'): string {
  if (family === 'windows') return buildBgStartRemoteWin(command, tag);
  const encoded = b64(command);
  return (
    `mkdir -p ${BG_DIR}; ` +
    `setsid sh -c 'echo ${encoded} | base64 -d | sh; echo $? > ${BG_DIR}/${tag}.exit' < /dev/null > ${BG_DIR}/${tag}.log 2>&1 & ` +
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

/**
 * Phase 3 存活探测（登记表 pid 专用）：kill -0 级检查 + .pid 一致性校验。
 * 输出语法与 buildBgPollRemote 完全同构（missing / running:<pid> /
 * exited:<code> / dead:<pid>），直接复用 parseBgPoll。
 *
 * 为什么要 .pid 一致性校验：环境重启/快照回滚后 /tmp 清空，登记表里的
 * 旧 pid 可能已被系统回收给别的进程——直接 kill -0 <旧pid> 会把别人的
 * 进程误判成「还活着」。先核对 .pid 文件仍是登记的那个 pid 再探测。
 */
export function buildBgProbeRemote(tag: string, pid: number, family: OsFamily = 'linux'): string {
  if (family === 'windows') {
    const d = BG_DIR_WIN;
    return (
      `$t='${d}\\${tag}'; $p=${pid}; ` +
      `if((Test-Path "$t.pid") -and ((Get-Content "$t.pid" -Raw).Trim() -eq "$p")){` +
      `if(Get-Process -Id $p -ErrorAction SilentlyContinue){"running:$p"}` +
      `elseif(Test-Path "$t.exit"){'exited:'+((Get-Content "$t.exit" -Raw).Trim())}` +
      `else{"dead:$p"}}else{'missing'}`
    );
  }
  const t = `${BG_DIR}/${tag}`;
  return (
    `t=${t}; p=${pid}; ` +
    `if [ -f $t.pid ] && [ "$(cat $t.pid)" = "$p" ]; then ` +
    `if kill -0 $p 2>/dev/null; then echo "running:$p"; ` +
    `elif [ -f $t.exit ]; then echo "exited:$(cat $t.exit)"; ` +
    `else echo "dead:$p"; fi; ` +
    `else echo missing; fi`
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

/**
 * Phase 3 回收 kill（turn 结束 / 会话 reset 清场专用，envBgReap 的远端
 * 命令）：按登记表 pid 杀，带 .pid 一致性校验——tag 复用（下一个 turn
 * 同名重起）或环境重启导致 pid 失效时**不杀任何东西**，报 pid-mismatch。
 *
 * 与用户主动 env_bg kill（buildBgKillRemote，按 .pid 现场取值）的区别：
 * 回收是异步清场，杀的对象是登记时刻的 pid，绝不能误杀复用 tag 的新
 * 进程。杀主进程 + linux 附带 pkill -P 直接子进程（sh -c 的孩子——
 * fuzz 本体通常是它）；不做进程组杀（后台进程与 ssh 会话同组，组杀会
 * 波及其它正在执行的命令）。Windows 用 taskkill /T /F 树杀。
 */
export function buildBgReapRemote(tag: string, pid: number, family: OsFamily = 'linux'): string {
  if (family === 'windows') {
    const d = BG_DIR_WIN;
    return (
      `$t='${d}\\${tag}'; $p=${pid}; ` +
      `if((Test-Path "$t.pid") -and ((Get-Content "$t.pid" -Raw).Trim() -eq "$p")){` +
      `taskkill /PID $p /T /F 2>$null | Out-Null; "reaped:$p"` +
      `}else{'pid-mismatch'}`
    );
  }
  const t = `${BG_DIR}/${tag}`;
  return (
    `t=${t}; p=${pid}; ` +
    `if [ -f $t.pid ] && [ "$(cat $t.pid)" = "$p" ]; then ` +
    // 组杀优先(setsid 启动后 $p 即组长,`kill -- -$p` 杀全组,孙进程不漏);
    // 兼容旧 nohup 残留(非组长,组杀 ESRCH):pkill 子进程 + kill 自身兜底。
    `kill -TERM -- -$p 2>/dev/null; pkill -TERM -P $p 2>/dev/null; kill -TERM $p 2>/dev/null; echo "reaped:$p"; ` +
    `else echo pid-mismatch; fi`
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
    return { error: 'env_bg 后台通道暂不支持 guest-exec（断网 VM），见 docs/spec/env-bg-design.md §5 三通道矩阵' };
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

  // Phase 3 存活探测：登记表有 pid → 探测通道（kill -0 + .pid 一致性）。
  // 探测命令本身失败（ssh 断流/超时）→ 保守报 running+probeFailed：
  // 这是「没法证伪」，不是「证据说活着」——调用方不得据此广播 finished
  // 或回收杀掉。探测成功 → 活/死/退/丢 如实解析（语法复用 parseBgPoll）。
  const knownPid = options.knownPid;
  if (knownPid !== undefined && Number.isInteger(knownPid) && knownPid > 0) {
    const probe = await execInEnvironment(entry, buildBgProbeRemote(tag, knownPid, osFamilyOf(entry)), {
      exec: options.exec,
      timeoutMs: options.timeoutMs ?? 30_000,
    });
    if (!probe.ok) {
      return { ok: true, tag, status: 'running', pid: knownPid, probeFailed: true };
    }
    return { ok: true, ...parseBgPoll(probe.stdout, tag) };
  }

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

/**
 * Phase 3 回收 kill（turn 结束 / 会话 reset 清场专用；用户主动杀仍走
 * envBgKill）。按登记表 pid 杀 + .pid 一致性校验——tag 复用或环境重启
 * 导致 pid 失效时不杀任何东西，报 pid-mismatch。返回 outcome：
 * `reaped:<pid>` | `pid-mismatch`。
 */
export async function envBgReap(
  entry: EnvironmentEntry,
  tag: string,
  pid: number,
  options: BgExecOptions = {},
): Promise<{ ok: true; outcome: string } | { ok: false; error: string }> {
  const badTag = validateTag(tag);
  if (badTag) return { ok: false, error: badTag };
  const gate = bgEntryOk(entry);
  if ('error' in gate) return { ok: false, error: gate.error };
  const r = await execInEnvironment(entry, buildBgReapRemote(tag, pid, osFamilyOf(entry)), {
    exec: options.exec,
    timeoutMs: options.timeoutMs ?? 15_000,
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
