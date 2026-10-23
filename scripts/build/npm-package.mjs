#!/usr/bin/env node
/**
 * M3：把 TUI 发行形态装配成一组 npm 包（`npm i -g @lielingai/zhishi` 即可用）。
 *
 * 产物布局（全部在 dist/npm 下，gitignore 覆盖，不入库）：
 *
 *   dist/npm/zhishi/
 *     package.json          ← scripts/build/npm/main-package.json（注入版本）
 *     bin/zhishi.js         ← Node 版本硬门 + 转交 dist/cli.js
 *     dist/cli.js           ← esbuild 的 CLI bundle
 *     dist/server-dist.js   ← esbuild 的 sidecar bundle
 *     dist/bundled-<name>/  ← 内置 skill / subagent / 域清单 / 专家种子 / 环境配方
 *                              （resolveBundledDir 查 scriptDir 同级，见
 *                               src/shared/domain-manifest.ts:67）
 *   dist/npm/zhishi-tui-<platform>-<arch>/
 *     package.json          ← scripts/build/npm/tui-package.json（os/cpu 约束）
 *     bin/zhishi-tui[.exe]  ← Go 静态二进制
 *
 * 用法：
 *   node scripts/build/npm-package.mjs                  # 构建当前平台的 TUI（本地验证）
 *   node scripts/build/npm-package.mjs --all-platforms  # 5 个平台全建（发版前）
 *   node scripts/build/npm-package.mjs --pack           # 额外 npm pack 出 tgz
 *   node scripts/build/npm-package.mjs --skip-build     # 复用已有 bundle（只重装产物）
 *
 * 为什么不用 sqlite-runtime：better-sqlite3 的 .node 是按内置 Node（ABI 137）
 * 预编译的，npm 形态跑用户的 Node，加载不了时 sidecar 自动回落 node:sqlite
 * （见 packages/zhishi-memory-core/src/sqlite.ts）。pty 走 npm 依赖
 * @lydell/node-pty（napi，ABI 稳定），不再复制 pty-runtime。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const allPlatforms = args.includes('--all-platforms');
// --bundle：把 5 个平台二进制塞进主包（单 tgz ≈17MB），不再生成平台包。
// 用途是 GitHub Release / 直接分发——`npm i -g <单文件>` 就能装，不依赖 registry。
const bundleMode = args.includes('--bundle');
const outRoot = join(repoRoot, 'dist', bundleMode ? 'npm-bundle' : 'npm');
const shouldPack = args.includes('--pack');
const skipBuild = args.includes('--skip-build');

const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
const version = rootPkg.version;

const TARGETS = [
  { platform: 'win32', arch: 'x64', os: 'win32', cpu: 'x64', goos: 'windows', goarch: 'amd64' },
  { platform: 'darwin', arch: 'arm64', os: 'darwin', cpu: 'arm64', goos: 'darwin', goarch: 'arm64' },
  { platform: 'darwin', arch: 'x64', os: 'darwin', cpu: 'x64', goos: 'darwin', goarch: 'amd64' },
  { platform: 'linux', arch: 'x64', os: 'linux', cpu: 'x64', goos: 'linux', goarch: 'amd64' },
  { platform: 'linux', arch: 'arm64', os: 'linux', cpu: 'arm64', goos: 'linux', goarch: 'arm64' },
];

const hostTarget = TARGETS.find((t) => t.platform === process.platform && t.arch === process.arch);
if (!allPlatforms && !hostTarget) {
  console.error(`✘ 不支持的宿主平台 ${process.platform}-${process.arch}；用 --all-platforms 只产出别的平台。`);
  process.exit(1);
}
const buildTargets = (bundleMode || allPlatforms) ? TARGETS : [hostTarget];

const NL = String.fromCharCode(10);

const BIN_LAUNCHER = `#!/usr/bin/env node
/**
 * npm bin 垫片（\`@lielingai/zhishi\` 的 \`zhishi\` 命令）。构建产物，源在
 * scripts/build/npm-package.mjs —— 改那里，别改这里。
 *
 *  1. Node 版本硬门：sidecar 的 SQLite 驱动依赖 node:sqlite（>= 22.5），
 *     \`engines\` 在 npm 侧只是 warning，装错版本必须启动即说清；
 *  2. 转交 CLI bundle：参数解析 / TUI 启动 / 运维子命令都在那里。不在此分流，
 *     否则 npm 形态与 PATH 安装的 zhishi.cmd 行为会分叉。
 */
const [major, minor] = process.versions.node.split('.').map((n) => Number(n));
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(
    \`zhishi 需要 Node >= 22.5（当前 \${process.versions.node}）——内置 SQLite 驱动依赖 node:sqlite。\\n\` +
      '升级 Node 后重试：https://nodejs.org/',
  );
  process.exit(1);
}

await import('../dist/cli.js');
`;

/**
 * Windows 上 npm 是 .cmd，spawnSync 必须开 shell；开了 shell 后 argv 会被拼成
 * 一行再解析，含空格的参数（`-ldflags=-s -w`）必须自己加引号。go/git 这类
 * 真 exe 一律不开 shell，argv 原样传递才不会被二次切分。
 */
function run(cmd, cmdArgs, { cwd = repoRoot, env } = {}) {
  const needsShell = process.platform === 'win32' && cmd === 'npm';
  const finalArgs = needsShell ? cmdArgs.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)) : cmdArgs;
  const res = spawnSync(cmd, finalArgs, {
    cwd,
    stdio: 'inherit',
    shell: needsShell,
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (res.status !== 0) {
    console.error(`✘ 失败：${cmd} ${cmdArgs.join(' ')}（exit ${res.status ?? res.signal}）`);
    process.exit(res.status ?? 1);
  }
}

function fill(templatePath, values) {
  let text = readFileSync(templatePath, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    text = text.replaceAll(`__${key}__`, value);
  }
  return text;
}

function assertFile(path, minBytes) {
  if (!existsSync(path)) {
    console.error(`✘ 产物缺失：${path}`);
    process.exit(1);
  }
  const size = statSync(path).size;
  if (size < minBytes) {
    console.error(`✘ 产物异常偏小：${path}（${size} bytes）`);
    process.exit(1);
  }
  return size;
}

// ① 两个 bundle（prebuild:server 会先 build:core）
if (!skipBuild) {
  console.log('▶ 构建 sidecar / CLI bundle…');
  run('npm', ['run', 'build:server']);
  run('npm', ['run', 'build:cli']);
}

const serverBundle = join(repoRoot, 'src-tauri', 'resources', 'server-dist.js');
const cliBundle = join(repoRoot, 'src-tauri', 'resources', 'cli', 'zhishi.js');
assertFile(serverBundle, 100_000);
assertFile(cliBundle, 10_000);

// ② 主包
console.log('▶ 装配主包 @lielingai/zhishi…');
const mainDir = join(outRoot, 'zhishi');
rmSync(mainDir, { recursive: true, force: true });
mkdirSync(join(mainDir, 'bin'), { recursive: true });
mkdirSync(join(mainDir, 'dist'), { recursive: true });

cpSync(serverBundle, join(mainDir, 'dist', 'server-dist.js'));
cpSync(cliBundle, join(mainDir, 'dist', 'cli.js'));
for (const dir of ['bundled-skills', 'bundled-agents', 'bundled-domains', 'bundled-expert', 'bundled-environments']) {
  const src = join(repoRoot, dir);
  if (!existsSync(src)) {
    console.error(`✘ 缺少内置资源目录：${dir}`);
    process.exit(1);
  }
  cpSync(src, join(mainDir, 'dist', dir), { recursive: true });
}

const mainPkg = JSON.parse(fill(join(repoRoot, 'scripts', 'build', 'npm', 'main-package.json'), { VERSION: version }));
if (bundleMode) {
  // 单包形态：平台二进制已经在 dist/tui/<platform>-<arch>/ 里，不再依赖 registry 解析。
  delete mainPkg.optionalDependencies;
}
writeFileSync(join(mainDir, 'package.json'), JSON.stringify(mainPkg, null, 2) + NL);
writeFileSync(join(mainDir, 'bin', 'zhishi.js'), BIN_LAUNCHER);
chmodSync(join(mainDir, 'bin', 'zhishi.js'), 0o755);

// ③ 平台包（Go 静态二进制；CGO 关掉 → 纯 Go 交叉编译）
console.log(`▶ 构建 TUI 二进制（${buildTargets.map((t) => t.platform + '-' + t.arch).join(', ')}）…`);
const tuiSource = join(repoRoot, 'src', 'tui');
for (const target of buildTargets) {
  const pkgName = `zhishi-tui-${target.platform}-${target.arch}`;
  const pkgDir = bundleMode
    ? join(mainDir, 'dist', 'tui', `${target.platform}-${target.arch}`)
    : join(outRoot, pkgName);
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  const exe = target.platform === 'win32' ? 'zhishi-tui.exe' : 'zhishi-tui';
  const outfile = join(pkgDir, 'bin', exe);

  run('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', outfile, './cmd/zhishi-tui'], {
    cwd: tuiSource,
    env: { GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: '0' },
  });
  const size = assertFile(outfile, 3_000_000);
  if (!bundleMode) {
    writeFileSync(
      join(pkgDir, 'package.json'),
      fill(join(repoRoot, 'scripts', 'build', 'npm', 'tui-package.json'), {
        PLATFORM: `${target.platform}-${target.arch}`,
        VERSION: version,
        OS: target.os,
        CPU: target.cpu,
      }),
    );
  }
  console.log(`  ✓ ${pkgName}  ${(size / 1024 / 1024).toFixed(1)} MB`);
}

// ④ npm pack（可选）
if (shouldPack) {
  const tarballs = [];
  const packDirs = bundleMode ? [mainDir] : [mainDir, ...buildTargets.map((t) => join(outRoot, `zhishi-tui-${t.platform}-${t.arch}`))];
  for (const dir of packDirs) {
    const res = spawnSync('npm', ['pack', '--silent'], {
      cwd: dir,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (res.status !== 0) {
      console.error(`✘ npm pack 失败（${dir}）：${res.stderr ?? res.stdout}`);
      process.exit(1);
    }
    tarballs.push(join(dir, res.stdout.trim().split(/\r?\n/).pop()));
  }
  console.log('▶ tarball:');
  for (const t of tarballs) console.log(`  ${t}`);
}

console.log(`✓ npm 包就绪：${outRoot}（版本 ${version}）`);
