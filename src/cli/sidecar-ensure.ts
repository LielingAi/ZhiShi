/**
 * CLI ensure sidecar（1.8.2）——无 GUI 场景下 CLI 自己拉起全局 sidecar。
 *
 * 背景：zhishi 的引擎（auto-run runner / 环境 / expert / campaign）全在
 * sidecar 进程（server/index.ts）里，CLI 是零状态 HTTP 客户端。此前 sidecar
 * 只能由 GUI 拉起（写 ~/.zhishi/sidecar.port），CLI 脱离 GUI 即 ECONNREFUSED。
 * 本模块把「确保 sidecar 存活」做成 CLI 侧能力：探测 port 文件 + /health →
 * 活 → 复用（GUI 拉起的照常复用）；死/无 → detached 拉起一个 → 写 port 文件。
 *
 * 进程模型决策：
 * - ensure 而非 always-spawn——单实例语义靠「全局一个 port 文件」天然成立；
 * - 孤儿不自愈（GUI 退出删 port 文件后，旧 sidecar 空转待复用/系统清理）——
 *   v1 不做进程扫描清理，注释写明；
 * - node 用 process.execPath（zhishi.cmd 烘焙的 bundled node 即安装目录
 *   resources/nodejs/node.exe，由此可推 server-dist.js 的 resources 根）；
 * - detached + stdio ignore + unref——CLI 是短命令，sidecar 长驻孤儿。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getZhiShiDataDir } from '../shared/app-dirs';

const HEALTH_TIMEOUT_MS = 2_000;
const HEALTH_POLL_INTERVAL_MS = 1_000;
const HEALTH_POLL_MAX_ATTEMPTS = 30;
/** sidecar spawn 的 argv 标记——与 Rust 侧 SIDECAR_MARKER 同串。 */
const SIDECAR_MARKER = '--zhishi-sidecar';

export interface EnsureCliSidecarOptions {
  /** 诊断输出（CLI 走 stderr，不污染 stdout 管线）。 */
  log?: (msg: string) => void;
  /** 测试注入：健康探测。 */
  fetchHealth?: (port: number) => Promise<boolean>;
  /** 测试注入：node 可执行路径（默认 process.execPath——真实路径在测试
   *  机（vitest/node_modules 布局）下可能命中 dev 回落找到真脚本，必须可注）。 */
  execPath?: string;
  /** 测试注入：cwd（dev 回落探测 server/index.ts 用）。 */
  cwd?: string;
}

/** GET /health——sidecar 就绪的唯一判据（TCP 通但 handler 未装时也会假活）。 */
async function defaultFetchHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 从 node 可执行文件路径推 server 脚本（server-dist.js release 产物）。
 * 布局：resources/nodejs/node(.exe) → resources/server-dist.js。
 * 兜底 exe 同级（便携布局）；dev 场景回落 cwd 的 src/server/index.ts
 * （repo 根跑 npm 系脚本时 cwd = repo）。
 */
export function resolveServerScript(execPath: string, cwd = process.cwd()): string | null {
  const exeDir = dirname(execPath);
  const candidates = [
    // bundled 布局：<res>/nodejs/node(.exe) → <res>/server-dist.js
    join(exeDir, '..', 'server-dist.js'),
    // 便携/扁平布局
    join(exeDir, 'server-dist.js'),
    // dev：repo 根直跑（tsx src/cli/zhishi.ts，cwd = repo）
    join(cwd, 'src', 'server', 'index.ts'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** 取一个随机空闲端口（listen(0) 后关闭；毫秒级竞窗可接受——随后立即被
 *  sidecar bind，撞上同端口的概率极低，撞上则 sidecar 起不来 → 轮询超时 →
 *  调用方走原报错路径）。 */
function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

/**
 * 确保全局 sidecar 存活，返回可用端口；无法自立返回 null（调用方走原
 * 「GUI 未运行」报错路径）。
 */
export async function ensureCliSidecar(opts: EnsureCliSidecarOptions = {}): Promise<number | null> {
  const log = opts.log ?? (() => {});
  const fetchHealth = opts.fetchHealth ?? defaultFetchHealth;
  const dataDir = getZhiShiDataDir();

  // ① 探测 port 文件 → 活 → 复用。
  try {
    const raw = readFileSync(join(dataDir, 'sidecar.port'), 'utf-8').trim();
    const port = Number(raw);
    if (Number.isInteger(port) && port > 0 && port < 65536 && await fetchHealth(port)) {
      return port;
    }
  } catch {
    /* 无文件/坏文件 → 自立 */
  }

  // ② 自立：解析 server 脚本 → 分配端口 → detached spawn → 轮询 health → 写 port 文件。
  const execPath = opts.execPath ?? process.execPath;
  const script = resolveServerScript(execPath, opts.cwd ?? process.cwd());
  if (!script) {
    log('[zhishi] 未找到 server 脚本（server-dist.js）——CLI 无法自立 sidecar。');
    return null;
  }
  const agentDir = join(dataDir, 'sidecar-cli-agent');
  try {
    mkdirSync(agentDir, { recursive: true });
  } catch (err) {
    log(`[zhishi] 创建 sidecar agent 目录失败：${String(err)}`);
    return null;
  }
  const port = await allocateFreePort();
  const args = [script, '--port', String(port), '--agent-dir', agentDir, '--no-pre-warm', SIDECAR_MARKER];
  if (script.endsWith('.ts')) args.unshift('--import', 'tsx/esm');
  log(`[zhishi] 拉起本地 sidecar（port ${port}）…`);
  const child = spawn(execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  child.on('error', (err) => log(`[zhishi] sidecar spawn 错误：${String(err)}`));

  for (let i = 0; i < HEALTH_POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
    if (await fetchHealth(port)) {
      try {
        writeFileSync(join(dataDir, 'sidecar.port'), String(port));
      } catch (err) {
        // port 文件写失败不阻断本次使用（下次 CLI 会重新拉起——孤儿累积的
        // 已知折衷，见模块头注释）。
        log(`[zhishi] 写 sidecar.port 失败（不影响本次使用）：${String(err)}`);
      }
      log(`[zhishi] sidecar 就绪（port ${port}）。`);
      return port;
    }
    if (child.exitCode !== null && child.exitCode !== undefined) {
      log(`[zhishi] sidecar 启动即退出（code ${child.exitCode}）——自立失败。`);
      return null;
    }
  }
  log('[zhishi] sidecar 健康等待超时（30s）——自立失败。');
  try {
    child.kill();
  } catch {
    /* 已死 */
  }
  return null;
}
