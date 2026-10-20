/**
 * 2.0.5 zhishi brain —— 团队大脑一等命令。
 *
 * 为什么存在（实机排障两个痛点的根治）：
 * 1. **启动复杂**——此前起 LAN 大脑要手拼 `node.exe` 全路径 + `server-dist.js`
 *    全路径 + 三个参数。CLI 自身就跑在应用内置 node 上（`zhishi.cmd` 垫片
 *    保证），`process.execPath` 即内置 node，`server-dist.js` 相对它只有
 *    两种布局（便携平铺 / 安装包 resources）——定位与起服务都该内建。
 * 2. **被清扫误杀**——GUI 每次启动/退出的进程清扫按 cmdline 模式
 *    `/zhishi/nodejs/` 清孤儿，手工起的 LAN 大脑（同款 node 路径）被当
 *    孤儿杀掉，表现为「server 自己会挂」。本命令给 argv 加 `--zhishi-brain`
 *    标记，Rust 清扫（process_cleanup::kill_stale_processes 的 exclude）
 *    对该标记进程及其子树一律豁免。
 *
 * 用法：`zhishi brain serve [--host <ip>] [--port <port>] [--agent-dir <工作区>]`
 * 前台常驻（stdio 继承，日志直出），Ctrl+C 停止。绑非回环地址前服务端
 * 仍会强制要求 auth 已启用（既有红线，不在此重复检查）。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** argv 标记：进程清扫豁免的凭据（Rust 侧 BRAIN_SERVE_MARKER 同字符串，
 *  改动必须两侧同步）。server-dist 对未知参数本就不解析，纯作身份标记。 */
export const BRAIN_SERVE_MARKER = '--zhishi-brain';

/**
 * server-dist.js 运行期定位（纯函数，exists 可注入单测）。
 * zhishi CLI 经 `zhishi.cmd` 垫片跑在应用内置 node 上，两种安装布局：
 * - 便携平铺：`<根>/nodejs/node.exe` + `<根>/server-dist.js`
 * - 安装包：  `<根>/resources/nodejs/node.exe` + `<根>/resources/server-dist.js`
 */
export function resolveServerDist(
  execPath: string,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const nodeDir = dirname(execPath);
  const candidates = [
    join(nodeDir, '..', 'server-dist.js'),
    join(nodeDir, '..', 'resources', 'server-dist.js'),
    join(nodeDir, 'server-dist.js'),
  ];
  for (const c of candidates) {
    if (exists(c)) return resolve(c);
  }
  return null;
}

export interface BrainServeOptions {
  host?: string;
  port?: number;
  agentDir?: string;
  /** 测试注入：显式 server-dist 路径（缺省从 process.execPath 相对定位）。 */
  serverDist?: string;
  /** 测试注入：spawn 实现（签名同 node:child_process.spawn）。 */
  spawnImpl?: typeof spawn;
  log?: (msg: string) => void;
  err?: (msg: string) => void;
}

/** 组装 server argv（纯函数）：缺省 127.0.0.1:7411，agentDir 缺省进程 cwd，
 *  恒带 BRAIN_SERVE_MARKER（清扫豁免——忘打的代价是 GUI 一重启就被杀）。 */
export function buildBrainServeArgv(serverDist: string, opts: BrainServeOptions): string[] {
  const host = (opts.host ?? '127.0.0.1').trim() || '127.0.0.1';
  const port = opts.port ?? 7411;
  const agentDir = (opts.agentDir ?? process.cwd()).trim() || process.cwd();
  return [serverDist, '--host', host, '--port', String(port), '--agent-dir', agentDir, BRAIN_SERVE_MARKER];
}

/** 前台 serve：stdio 继承（大脑日志直出当前终端），退出码透传。 */
export async function runBrainServe(opts: BrainServeOptions = {}): Promise<number> {
  const log = opts.log ?? console.log;
  const err = opts.err ?? console.error;
  const serverDist = opts.serverDist ?? resolveServerDist(process.execPath);
  if (!serverDist) {
    err(
      'Error: 找不到 server-dist.js——`zhishi brain serve` 必须经应用内置 node 运行（zhishi.cmd 垫片）。' +
        '请用应用自带的 zhishi 命令重试，或升级应用到 ≥2.0.5。',
    );
    return 1;
  }
  const argv = buildBrainServeArgv(serverDist, opts);
  const at = (flag: string) => argv[argv.indexOf(flag) + 1];
  log(`[brain] serve ${at('--host')}:${at('--port')}（agent-dir ${at('--agent-dir')}）——Ctrl+C 停止`);
  return new Promise<number>((resolveExit) => {
    const child = (opts.spawnImpl ?? spawn)(process.execPath, argv, { stdio: 'inherit' });
    child.on('error', (e) => {
      err(`Error: 大脑 spawn 失败：${e.message}`);
      resolveExit(1);
    });
    child.on('exit', (code) => resolveExit(code ?? 0));
  });
}

/** brain 组入口（zhishi.ts 主流程拦截后经此分发，不经 admin API）。 */
export async function runBrainCommand(action: string | undefined, flags: Record<string, unknown>): Promise<number> {
  if (action !== 'serve') {
    console.log('用法: zhishi brain serve [--host <ip>] [--port <port>] [--agent-dir <工作区>]');
    console.log('  团队大脑常驻服务——应用内置 node 直起 server-dist，带清扫免疫标记；前台运行，Ctrl+C 停止。');
    console.log('  绑非回环地址前请先 `zhishi auth enable`（服务端强制）。');
    return action ? 2 : 0;
  }
  const port = Number(flags.port);
  return runBrainServe({
    host: typeof flags.host === 'string' ? flags.host : undefined,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined,
    agentDir: typeof flags.agentDir === 'string' ? flags.agentDir : undefined,
  });
}
