/**
 * CLI ensure sidecar（1.8.2）——无 GUI 场景下 CLI 自己拉起全局 sidecar。
 *
 * 背景：zhishi 的引擎（auto-run runner / 环境 / expert / campaign）全在
 * sidecar 进程（server/index.ts）里，CLI 是零状态 HTTP 客户端。2.1 起 sidecar
 * 的唯一拉起方就是这里（TUI 也走同一条路）——探测 port 文件 + /health → 活且
 * 同版本 → 复用；死 / 无 / 版本不符 → detached 拉起一个 → 写 port 文件。
 *
 * 进程模型决策：
 * - ensure 而非 always-spawn——单实例语义靠「全局一个 port 文件」天然成立；
 * - 版本漂移不复用：桌面版（2.0.x）的 sidecar 可能还活着，连上去按新协议
 *   对话只会得到莫名其妙的错；另起一个 sidecar 是设计内行为（两个 sidecar
 *   同数据目录有 WAL + busy_timeout 兜底），旧实例仍握着自己的端口；
 * - 孤儿不自愈（旧 sidecar 空转待复用/系统清理）——不做进程扫描清理；
 * - node 用 process.execPath：npm 形态是用户的 node（>=22.5，sidecar 走
 *   node:sqlite），安装版是 resources/nodejs/node.exe（ABI 匹配 better-sqlite3）；
 * - detached + stdio ignore + unref——CLI 是短命令，sidecar 长驻。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getZhiShiDataDir } from '../shared/app-dirs';
import { resolveVersion } from '../shared/version';

const HEALTH_TIMEOUT_MS = 2_000;
const HEALTH_POLL_INTERVAL_MS = 1_000;
const HEALTH_POLL_MAX_ATTEMPTS = 30;
/** sidecar spawn 的 argv 标记——与 Rust 侧 SIDECAR_MARKER 同串。 */
const SIDECAR_MARKER = '--zhishi-sidecar';

/** /health 的判据：活着 + 它自己上报的版本（老 sidecar 没有 version 字段）。 */
export interface HealthProbe {
  ok: boolean;
  version?: string;
}

export interface EnsureCliSidecarOptions {
  /** 诊断输出（CLI 走 stderr，不污染 stdout 管线）。 */
  log?: (msg: string) => void;
  /** 测试注入：健康探测。返回 boolean 等价于 `{ ok }`（旧注入形态兼容）。 */
  fetchHealth?: (port: number) => Promise<boolean | HealthProbe>;
  /** 测试注入：node 可执行路径（默认 process.execPath——真实路径在测试
   *  机（vitest/node_modules 布局）下可能命中 dev 回落找到真脚本，必须可注）。 */
  execPath?: string;
  /** 测试注入：cwd（dev 回落探测 server/index.ts 用）。 */
  cwd?: string;
  /** 测试注入：本进程版本（缺省 resolveVersion()）。 */
  localVersion?: string;
}

function normalizeProbe(result: boolean | HealthProbe): HealthProbe {
  return typeof result === 'boolean' ? { ok: result } : result;
}

/**
 * 版本是否漂移。上报方没带 version（2.0.x 及更早）或任一侧是 `dev`
 * （源码直跑）→ 无法判定，按「不漂移」处理（向后兼容 > 过度设防）。
 */
function isVersionMismatch(reported: string | undefined, local: string): boolean {
  if (!reported || reported === 'dev' || local === 'dev') return false;
  return reported !== local;
}

/** GET /health——sidecar 就绪的唯一判据（TCP 通但 handler 未装时也会假活）。 */
async function defaultFetchHealth(port: number): Promise<HealthProbe> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json().catch(() => null)) as { version?: unknown } | null;
    const version = typeof body?.version === 'string' ? body.version : undefined;
    return version ? { ok: true, version } : { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * 定位 server 脚本（server-dist.js release 产物）。两种发行形态并存：
 *
 * - npm 形态（`npm i -g @lielingai/zhishi`）：bin 与 server-dist.js 同在
 *   `<pkg>/dist`，用 `import.meta.url` 定位——execPath 是**用户的** node，
 *   与包布局无关，按它推路径必然落空；
 * - Tauri 安装形态：resources/cli/zhishi.js → resources/server-dist.js
 *   （模块同级上一级），同时 <res>/nodejs/node(.exe) 也在上一级。
 *
 * 之后才是 exe 同级（便携布局）与 dev 回落（cwd 的 src/server/index.ts）。
 */
export function resolveServerScript(execPath: string, cwd = process.cwd()): string | null {
  const exeDir = dirname(execPath);
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // npm 布局：<pkg>/dist/zhishi.js(cli.js) → <pkg>/dist/server-dist.js
    join(moduleDir, 'server-dist.js'),
    // Tauri 布局：<res>/cli/zhishi.js → <res>/server-dist.js
    join(moduleDir, '..', 'server-dist.js'),
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
 * 确保全局 sidecar 存活，返回可用端口；无法自立返回 null（调用方据此打印
 * 可执行的排查指引）。
 */
export async function ensureCliSidecar(opts: EnsureCliSidecarOptions = {}): Promise<number | null> {
  const log = opts.log ?? (() => {});
  const fetchHealth = opts.fetchHealth ?? defaultFetchHealth;
  const dataDir = getZhiShiDataDir();
  const localVersion = opts.localVersion ?? resolveVersion();

  // ① 探测 port 文件 → 活且同版本 → 复用。
  try {
    const raw = readFileSync(join(dataDir, 'sidecar.port'), 'utf-8').trim();
    const port = Number(raw);
    const probe = Number.isInteger(port) && port > 0 && port < 65536
      ? normalizeProbe(await fetchHealth(port))
      : { ok: false };
    if (probe.ok) {
      if (isVersionMismatch(probe.version, localVersion)) {
        // 不复用旧实例：协议/路由可能已经变了（典型场景：桌面版 2.0.x 的
        // sidecar 还在跑）。另起一个即可——两个 sidecar 共用一个数据目录是
        // 设计内行为（WAL + busy_timeout），旧 GUI 仍握着自己的端口。
        log(
          `[zhishi] 现有 sidecar 版本 ${probe.version} ≠ 当前 ${localVersion}——不复用，另起一个（旧实例可能来自桌面版）。`,
        );
      } else {
        return port;
      }
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
    if (normalizeProbe(await fetchHealth(port)).ok) {
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
