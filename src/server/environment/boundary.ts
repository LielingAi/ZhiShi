/**
 * 安全研究员版 P1 E6 — D14 边界分类（纯决策核，无 I/O）。
 *
 * WHY THIS EXISTS
 * ---------------
 * D14 安全模型：边界之内全自动，审批只剩跨越边界的动作。term 会话带 env
 * 标记（host / docker:<container> / vm:<name> / range:<host>），canUseTool
 * 在既有 classifyToolRisk 风险分级之前先过一道边界维度：
 *
 *   in-env            界内（zhishi term write/read 指向 env≠host 终端）→ 自动放行
 *   control-plane     环境驱动命令（docker exec/ssh/scp/VBoxManage/…）→ 维持现有分级
 *   cross-boundary    越界写（重定向/cp/mv/del 目标在宿主工作区外）→ 强制人工确认
 *   malware-host-exec 宿主执行 samples/ 下的文件 → 硬拒（边界规则，不是审批）
 *   host-workspace    其余宿主工作区内操作 → 维持现有分级
 *
 * 本模块与 tool-risk.ts 同构：纯函数 + 注入 envLookup（terminalId → envTag），
 * 不 import 任何 server 单例，跑在 fast `unit` vitest pool。canUseTool（软闸）
 * 与 PreToolUse hook（硬闸）共享这里的纯函数，逻辑不复制、防漂移——与
 * plan-mode-gate.ts 的「双闸共享同一常量」模式一致（agent-session.ts 注释）。
 *
 * 保守默认：识别不了的形态一律回落 host-workspace（交给既有 HIGH 确认流），
 * 边界分类只在能证明「界内 / 越界 / 样本执行」时才改变既有行为。
 */

/** 边界分类结果。 */
export type BoundaryClass =
  | 'in-env'
  | 'control-plane'
  | 'cross-boundary'
  | 'host-workspace'
  | 'malware-host-exec';

/** terminalId → envTag 查询（注入化；查不到返回 undefined，按 host 处理）。 */
export type TerminalEnvLookup = (terminalId: string) => string | undefined;

export interface BoundaryContext {
  envLookup: TerminalEnvLookup;
  /** 会话工作区根（agentDir）；空串 = 无上下文，越界判定不臆断。 */
  workspacePath: string;
}

/** 样本硬闸的硬拒消息（canUseTool deny.message / PreToolUse deny reason 共用）。 */
export const MALWARE_HOST_EXEC_DENY_MESSAGE =
  '样本不允许在宿主执行（samples/ 目录硬闸）：请进隔离环境（VM）后再运行，' +
  '例如 zhishi env open <id> 打开隔离环境终端后在界内执行。';

// ---------------------------------------------------------------------------
// 命令行切分工具
// ---------------------------------------------------------------------------

/** 按 shell 连接符切段（&& / || / ; / | / 换行），去空段。 */
function splitSegments(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 段落首 token，去首尾引号。 */
function firstToken(segment: string): string {
  return (segment.split(/[ \t]+/)[0] ?? '').replace(/^["']+|["']+$/g, '');
}

// ---------------------------------------------------------------------------
// 样本硬闸：宿主执行 samples/ 下的文件
// ---------------------------------------------------------------------------

/**
 * token 是否指向 samples/ 目录下的路径：含 `samples` 路径分量（前后必须是
 * 路径边界，避免 `mysamples/x` 误中）。大小写不敏感（Windows 语义），
 * 分隔符 / 与 \ 皆可。覆盖 ./samples/x、samples\x、C:\lab\samples\x、
 * /tmp/samples/x、..\samples\x。
 */
function isSamplePathToken(token: string): boolean {
  return /(?:^|[\\/])samples[\\/]/i.test(token);
}

/** `cmd /c <样本路径>` / `cmd.exe /c "样本路径"` 调用形态。 */
function isCmdInvocationOfSample(segment: string): boolean {
  const tokens = segment
    .split(/[ \t]+/)
    .map((t) => t.replace(/^["']+|["']+$/g, ''));
  if (!/^cmd(?:\.exe)?$/i.test(tokens[0] ?? '')) return false;
  const cIdx = tokens.findIndex((t) => /^\/c$/i.test(t));
  if (cIdx < 0) return false;
  return isSamplePathToken(tokens[cIdx + 1] ?? '');
}

/**
 * 命令是否在宿主直接执行 samples/ 下的文件。只判「执行」形态（段落首 token
 * 是样本路径，或 cmd /c 调用）——`cat samples/x`、`sha256sum samples/x` 这类
 * 读取/分析样本的操作不触发硬闸。
 */
export function isHostSampleExec(cmd: string): boolean {
  for (const segment of splitSegments(cmd)) {
    if (isSamplePathToken(firstToken(segment))) return true;
    if (isCmdInvocationOfSample(segment)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 界内：zhishi term write/read 指向 env≠host 终端
// ---------------------------------------------------------------------------

/** `zhishi term write|read <terminalId> …` — 捕获 terminalId。 */
const TERM_IO_PATTERN =
  /^zhishi(?:\.(?:cmd|exe))?[ \t]+term[ \t]+(?:write|read)[ \t]+([^\s;|&"']+)/;

// ---------------------------------------------------------------------------
// 控制面：环境驱动命令（操作隔离环境本身，而非在宿主执行）
// ---------------------------------------------------------------------------

const ENV_DRIVER_PATTERN =
  /^(?:docker(?:\.exe)?[ \t]+(?:exec|run)|(?:ssh|scp|sftp|vmrun|virsh)(?:\.exe)?|VBoxManage(?:\.exe)?|Get-VM)(?=[ \t]|$)/i;

// ---------------------------------------------------------------------------
// 越界写：目标在宿主工作区外
// ---------------------------------------------------------------------------

/** 绝对路径判定：Windows 盘符 / UNC / POSIX 根。 */
function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
}

/** 规范化比较：统一分隔符、去重斜杠、去尾斜杠、小写（Windows/macOS 默认大小写不敏感）。 */
function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * target 是否为工作区外的绝对路径。相对路径一律视为工作区内（cwd 即工作区）；
 * 空 workspacePath = 无上下文，不臆断（回落现有分级）。
 */
export function isOutsideWorkspace(target: string, workspacePath: string): boolean {
  const cleaned = target.replace(/^["']+|["']+$/g, '');
  if (!isAbsolutePath(cleaned)) return false;
  if (!workspacePath.trim()) return false;
  const t = normalizePath(cleaned);
  const w = normalizePath(workspacePath);
  // 前缀陷阱：workspace 必须以路径分量边界结尾（u-disk2 ≠ u-disk）。
  return t !== w && !t.startsWith(w + '/');
}

/** 重定向目标：`>` / `>>` 后的 token（引号感知）。2>&1 之 & 被字符类排除，不匹配。 */
const REDIRECT_PATTERN = />>?[ \t]*(?:("[^"]*")|('[^']*')|([^\s;|&>]+))/g;

/** 良性重定向目标，不算越界。 */
const BENIGN_REDIRECT_TARGETS = new Set(['/dev/null', 'nul']);

/**
 * 带文件目标的写命令。cp/mv/copy/move 任一路径参数越界即算（保守：从外部
 * 读入也花一次确认）；del/erase/Remove-Item 删工作区外同理。
 */
const WRITE_OP_COMMANDS = new Set([
  'cp',
  'mv',
  'copy',
  'move',
  'del',
  'erase',
  'remove-item',
  'ren',
  'rename',
  'xcopy',
  'robocopy',
]);

/** 命令是否含目标在工作区外的写操作（重定向 / cp/mv/del 等）。 */
function hasCrossBoundaryWrite(cmd: string, workspacePath: string): boolean {
  for (const match of cmd.matchAll(REDIRECT_PATTERN)) {
    const target = match[1] ?? match[2] ?? match[3] ?? '';
    const cleaned = target.replace(/^["']+|["']+$/g, '');
    if (BENIGN_REDIRECT_TARGETS.has(cleaned.toLowerCase())) continue;
    if (isOutsideWorkspace(cleaned, workspacePath)) return true;
  }
  for (const segment of splitSegments(cmd)) {
    const tokens = segment
      .split(/[ \t]+/)
      .map((t) => t.replace(/^["']+|["']+$/g, ''))
      .filter(Boolean);
    const commandWord = (tokens[0] ?? '')
      .replace(/\\/g, '/')
      .split('/')
      .pop()!
      .replace(/\.exe$/i, '')
      .toLowerCase();
    if (!WRITE_OP_COMMANDS.has(commandWord)) continue;
    for (const arg of tokens.slice(1)) {
      // 跳过分隔旗标：-rf、/Y（Windows 单字母旗标；POSIX 绝对路径长度 > 2 不误伤）
      if (/^-/.test(arg) || /^\/[a-zA-Z]$/.test(arg)) continue;
      if (isOutsideWorkspace(arg, workspacePath)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 边界分类。判定顺序即优先级：
 *   1. 写工具的 file_path 越界 → cross-boundary
 *   2. 样本宿主执行 → malware-host-exec（硬闸优先于一切）
 *   3. zhishi term write/read → env≠host 则 in-env；host/未知终端回落 host-workspace
 *   4. 环境驱动命令 → control-plane
 *   5. 越界写 → cross-boundary
 *   6. 其余 → host-workspace
 */
export function classifyBoundary(
  toolName: string,
  args: unknown,
  ctx: BoundaryContext,
): BoundaryClass {
  const input = (args ?? {}) as Record<string, unknown>;

  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    const filePath = typeof input.file_path === 'string' ? input.file_path : '';
    if (filePath && isOutsideWorkspace(filePath, ctx.workspacePath)) return 'cross-boundary';
    return 'host-workspace';
  }

  if (toolName !== 'Bash') return 'host-workspace';

  const cmd = typeof input.command === 'string' ? input.command.trim() : '';
  if (!cmd) return 'host-workspace';

  if (isHostSampleExec(cmd)) return 'malware-host-exec';

  const termMatch = TERM_IO_PATTERN.exec(cmd);
  if (termMatch) {
    const tag = ctx.envLookup(termMatch[1]);
    return tag && tag.toLowerCase() !== 'host' ? 'in-env' : 'host-workspace';
  }

  if (ENV_DRIVER_PATTERN.test(cmd)) return 'control-plane';

  if (hasCrossBoundaryWrite(cmd, ctx.workspacePath)) return 'cross-boundary';

  return 'host-workspace';
}
