/**
 * TUI 启动器（M3 npm 形态）——CLI 找到 Go 二进制并把它接上前台终端。
 *
 * 为什么在 CLI 里而不是 bin 垫片里：`zhishi` 的所有入口（npm 的 bin、PATH 安装的
 * zhishi.cmd、dev 的 tsx）最终都进 CLI bundle。把「裸 `zhishi` → TUI」的判定与
 * sidecar 地址解析留在 CLI 一处，三套发行形态行为才不会分叉。
 *
 * 二进制查找序：
 *   1. `ZHISHI_TUI_BIN`（显式覆盖；现场排查 / 自定义构建）；
 *   2. 单包形态自带：`<pkg>/dist/tui/<platform>-<arch>/bin/zhishi-tui`（--bundle 产物）；
 *   3. `@lielingai/zhishi-tui-<platform>-<arch>`（optionalDependencies，按平台装）；
 *   4. `<cwd>/src/tui/zhishi-tui(.exe)`（dev：`cd src/tui && go build ./cmd/zhishi-tui`）。
 * 都找不到 → 返回 null，调用方给一条能照着做的错误（不猜、不静默降级到旧界面）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** npm 平台包名（与 scripts/build/npm-package.mjs 生成的一致）。 */
export function tuiPlatformPackage(platform = process.platform, arch = process.arch): string {
  return `@lielingai/zhishi-tui-${platform}-${arch}`;
}

function exeName(platform = process.platform): string {
  return platform === 'win32' ? 'zhishi-tui.exe' : 'zhishi-tui';
}

/** 找 TUI 二进制；找不到返回 null。 */
export function resolveTuiBinary(options: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  resolveFromPackage?: (pkg: string) => string | null;
  /** 测试注入：本模块路径（单包布局定位要用）。 */
  selfPath?: string;
  /** 测试注入：文件存在性判断。 */
  exists?: (path: string) => boolean;
} = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;

  const override = env.ZHISHI_TUI_BIN?.trim();
  if (override) {
    return exists(override) ? override : null;
  }

  // 单包（--bundle）形态：二进制就在本包的 dist/tui/<platform>-<arch>/bin/ 下
  // （布局与 scripts/build/npm-package.mjs 的 bundle 分支一致）。
  const selfDir = dirname(options.selfPath ?? fileURLToPath(import.meta.url));
  const bundled = join(selfDir, 'tui', `${platform}-${options.arch ?? process.arch}`, 'bin', exeName(platform));
  if (exists(bundled)) return bundled;

  const fromPackage =
    options.resolveFromPackage ??
    ((pkg: string) => {
      try {
        const req = createRequire(import.meta.url);
        return join(dirname(req.resolve(`${pkg}/package.json`)), 'bin', exeName(platform));
      } catch {
        return null;
      }
    });
  const packaged = fromPackage(tuiPlatformPackage(platform, options.arch ?? process.arch));
  if (packaged && exists(packaged)) return packaged;

  const devBinary = join(options.cwd ?? process.cwd(), 'src', 'tui', exeName(platform));
  if (exists(devBinary)) return devBinary;

  return null;
}

/**
 * TUI 里 `/命令` 的执行体：CLI 的 argv 前缀（node + 预加载 + 入口）。
 *
 * 由启动器算好、经 `ZHISHI_CLI_ARGV`（JSON 数组）交给 TUI——Go 侧不该猜
 * 「CLI 在哪」：npm 形态在 `<pkg>/dist/cli.js`，dev 是 `src/cli/zhishi.ts`
 * 且要带 tsx 预加载，Tauri 形态就是它自己。三种布局只在启动器这一处认识。
 */
export function resolveCliInvocation(options: {
  selfPath?: string;
  execPath?: string;
  exists?: (path: string) => boolean;
} = {}): string[] {
  const self = options.selfPath ?? fileURLToPath(import.meta.url);
  const execPath = options.execPath ?? process.execPath;
  const exists = options.exists ?? existsSync;
  if (self.endsWith('.ts') || self.endsWith('.tsx')) {
    return [execPath, '--import', 'tsx/esm', self];
  }
  // 捆绑产物：esbuild 把 CLI 与启动器打进同一个文件，sibling 就是它自己；
  // 若未来拆成 cli.js + bin 垫片，这里也能自然找到。
  const sibling = join(dirname(self), 'cli.js');
  return [execPath, exists(sibling) ? sibling : self];
}

export interface LaunchTuiOptions {
  /** sidecar 根地址（http://127.0.0.1:<port> 或远端地址）。 */
  server: string;
  /** 鉴权 token——走环境变量传，不落 argv（进程列表可见）。 */
  token?: string;
  /** 透传给 TUI 的额外参数（如 --probe / --probe-overlays）。 */
  extraArgs?: string[];
  /** 测试注入。 */
  binary?: string | null;
  spawnImpl?: typeof spawn;
  log?: (msg: string) => void;
}

/**
 * 前台启动 TUI，返回它的退出码。spawn 失败（找不到/不可执行）返回 1 并打印
 * 可执行的原因——TUI 是唯一交互面，静默退出等于把人锁在门外。
 */
export async function launchTui(options: LaunchTuiOptions): Promise<number> {
  const log = options.log ?? ((m: string) => console.error(m));
  const binary = options.binary === undefined ? resolveTuiBinary() : options.binary;
  if (!binary) {
    log('Error: 未找到 zhishi TUI 二进制。');
    log(`  期望的 npm 平台包：${tuiPlatformPackage()}（可选依赖，可能因平台不受支持被跳过）。`);
    log('  出路：① 重新 `npm i -g @lielingai/zhishi`；② 或设 ZHISHI_TUI_BIN 指向自建的 zhishi-tui。');
    return 1;
  }

  const args = ['--server', options.server, ...(options.extraArgs ?? [])];
  const child = (options.spawnImpl ?? spawn)(binary, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(options.token ? { ZHISHI_TOKEN: options.token } : {}),
      // TUI 里 `/命令` 要跑的就是这一份 CLI（详见 resolveCliInvocation）。
      ZHISHI_CLI_ARGV: JSON.stringify(resolveCliInvocation()),
    },
    windowsHide: false,
  });

  return await new Promise<number>((resolve) => {
    child.on('error', (err) => {
      log(`Error: 启动 TUI 失败（${binary}）：${err.message}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        // Ctrl-C 之类：按 shell 惯例 128+signal 不合适（拿不到编号），用 130。
        resolve(130);
        return;
      }
      resolve(code ?? 0);
    });
  });
}
