#!/usr/bin/env node
/**
 * 把 TUI 发行形态发到 npm（`npm i -g @lielingai/zhishi` 即可用）。
 *
 * 默认**只打印命令**（dry-run）；确认无误后加 `--yes` 才真的发布。
 *
 *   node scripts/release/publish-npm.mjs                 # 看会发哪些包
 *   node scripts/release/publish-npm.mjs --yes           # 真发（latest）
 *   node scripts/release/publish-npm.mjs --yes --tag next
 *
 * 发布顺序有讲究：**先平台包、后主包**。主包的 optionalDependencies 指向这些
 * 平台包；先发主包的话，用户在那个瞬间安装会解析不到平台二进制（TUI 启动时
 * 会提示"未找到 zhishi TUI 二进制"）。
 *
 * registry 固定 registry.npmjs.org：本机 npm 配置的是 npmmirror（只读镜像），
 * 拿它发布一定失败，而且报错很含糊。这里显式指定，不依赖本机配置。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const registry = 'https://registry.npmjs.org';
const args = process.argv.slice(2);
const doPublish = args.includes('--yes');
const tagIdx = args.indexOf('--tag');
const distTag = tagIdx >= 0 ? (args[tagIdx + 1] ?? 'latest') : 'latest';

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
const version = pkg.version;
if (!version || version.startsWith('0.0.0') || version.includes('-')) {
  console.error(`✘ 版本号不能用于发布：${version}（先改成正式版本，如 2.1.0）`);
  process.exit(1);
}

function run(cmd, cmdArgs, opts = {}) {
  const shell = process.platform === 'win32' && cmd === 'npm';
  const finalArgs = shell ? cmdArgs.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)) : cmdArgs;
  const res = spawnSync(cmd, finalArgs, {
    cwd: opts.cwd ?? repoRoot,
    stdio: opts.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell,
  });
  if (opts.capture) {
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }
  if (res.status !== 0) {
    console.error(`✘ 失败：${cmd} ${cmdArgs.join(' ')}（exit ${res.status}）`);
    process.exit(res.status ?? 1);
  }
  return { status: res.status };
}

// ① 构建 + 打包（5 个平台，跨平台 Go 静态编译）
console.log(`▶ 构建并打包 ${version}（全部平台）…`);
run('node', ['scripts/build/npm-package.mjs', '--all-platforms', '--pack']);

// ② 收集 tgz，按"平台包 → 主包"排序
const outRoot = join(repoRoot, 'dist', 'npm');
const platformDir = (p) => join(outRoot, `zhishi-tui-${p}`);
const platforms = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
const tarballs = [];
for (const p of platforms) {
  const file = join(platformDir(p), `lielingai-zhishi-tui-${p}-${version}.tgz`);
  if (!existsSync(file)) {
    console.error(`✘ 缺少平台包：${file}（先跑 node scripts/build/npm-package.mjs --all-platforms --pack）`);
    process.exit(1);
  }
  tarballs.push({ dir: platformDir(p), file, name: `@lielingai/zhishi-tui-${p}` });
}
const mainTarball = join(outRoot, 'zhishi', `lielingai-zhishi-${version}.tgz`);
if (!existsSync(mainTarball)) {
  console.error(`✘ 缺少主包：${mainTarball}`);
  process.exit(1);
}
tarballs.push({ dir: join(outRoot, 'zhishi'), file: mainTarball, name: '@lielingai/zhishi' });

// ③ 登录检查（只有真发时才查）
if (doPublish) {
  const who = run('npm', ['whoami', `--registry=${registry}`], { capture: true });
  if (who.status !== 0) {
    console.error('✘ 未登录 npmjs.org。先执行：');
    console.error(`    npm login --registry=${registry}`);
    console.error('  （注意：本机默认 registry 是 npmmirror，登录/发布都要显式指定 npmjs.org）');
    process.exit(1);
  }
  console.log(`  已登录：${who.stdout.trim()}`);
}

// ④ 发布（或打印计划）
console.log(`\n▶ 发布计划（tag=${distTag}, registry=${registry}）：`);
for (const t of tarballs) {
  console.log(`  ${t.name}@${version}  ← ${t.file}`);
}
if (!doPublish) {
  console.log('\n（dry-run）真发请加 --yes。');
  process.exit(0);
}

for (const t of tarballs) {
  console.log(`\n▶ npm publish ${t.name}@${version}`);
  run('npm', ['publish', t.file, '--access', 'public', '--tag', distTag, `--registry=${registry}`], { cwd: t.dir });
}

console.log(`\n✓ 发布完成：npm i -g @lielingai/zhishi@${distTag === 'latest' ? version : distTag}`);
console.log('  验证：zhishi version && zhishi（裸命令应进 TUI）');
