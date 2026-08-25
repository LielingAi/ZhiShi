// Cross-platform esbuild driver for the two Node bundles we ship

// (server, CLI).

//

// Why this script exists: the previous inline `npm run build:*` commands

// embedded the esbuild banner via `--banner:js='...'` with single quotes.

// That worked under bash/zsh on macOS/Linux but **broke under Windows

// `cmd.exe`**, which doesn't recognise single quotes — it just split the

// banner arg on whitespace, and esbuild aborted with:

//

//   ✘ ERROR  Must use "outdir" when there are multiple input files

//

// Switching to the JS API removes shell-quoting entirely and gives us

// one source of truth for everything that defines a Node bundle: entry,

// banner, format, externals, sourcemap. Per-target post-build steps

// (e.g. CLI launcher copy, server-side hardcoded-path validation) live

// here too — used to be duplicated across ./scripts/build/build_macos.sh / ./scripts/build/build_linux.sh

// / .\scripts\build\build_windows.ps1, now centralised so a missed update can't ship a

// half-fixed bundle.



import { build } from 'esbuild';

import { copyFile, readFile, mkdir } from 'node:fs/promises';

import { dirname } from 'node:path';



// Read package.json version once and inject as a compile-time constant.

// This is the ONLY way `zhishi version` can show the real shipped

// version in production: the runtime `process.env.npm_package_version`

// is set by `npm run …` (dev), not by Tauri's sidecar spawn (prod), so

// without compile-time injection the admin-api falls back to a stale

// hardcoded string. Issue #149 follow-up — users couldn't tell whether

// they were running the patched build.

const PKG_VERSION = JSON.parse(

  (await readFile(new URL('../package.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''),

).version;



// Banner content kept as plain string literals here — no shell parsing

// involved, so single/double quotes mean what they say.

//

// Aliasing `createRequire` here is load-bearing, not stylistic: at least one

// bundled source file (`src/server/utils/imageResize.ts`) uses

// `import { createRequire } from 'module'` at top level, and esbuild keeps

// that import literally in the output. If our banner *also* binds the bare

// name `createRequire`, Node ≥22's ESM loader rejects the module on first

// load with `SyntaxError: Identifier 'createRequire' has already been

// declared` — Sidecar dies before answering /health, the renderer hangs at

// "loading history". A unique alias here permanently sidesteps the

// collision regardless of how many depths-deep deps re-import the symbol.

const ESM_INTEROP_BANNER =

  'import { createRequire as __zhishiCreateRequire } from "module"; const require = __zhishiCreateRequire(import.meta.url);';

const CLI_SHEBANG_BANNER = '#!/usr/bin/env node';



const TARGETS = {

  server: {

    entryPoints: ['src/server/index.ts'],

    outfile: 'src-tauri/resources/server-dist.js',

    format: 'esm',

    sourcemap: true,

    banner: { js: ESM_INTEROP_BANNER },

    /**
     * 1.3.3 attach pty:
     * - `@lydell/node-pty`:napi prebuilds 原生模块——.node 文件与 node-gyp-build
     *   的动态加载路径无法打包,必须运行时 require(term-pty.ts::loadNodePty
     *   惰性解析;发行侧装进 resources/pty-runtime/,对齐 sharp/sqlite-runtime)。
     * - `bufferutil` / `utf-8-validate`:ws 的可选原生加速器(try/catch 动态
     *   require)——external 后 esbuild 不再尝试打包,ws 本体是纯 JS 照常
     *   bundle(若把 ws 整个 external,生产侧 server-dist.js 旁没有
     *   node_modules 会直接加载失败)。
     */

    external: ['@lydell/node-pty', 'bufferutil', 'utf-8-validate'],

    /** Post-build: catch hardcoded `__dirname = "<dev-machine path>"` leaks.

     *  esbuild treats a top-level `__dirname` as a compile-time constant; the

     *  source must use `import.meta.url` / `getScriptDir()` instead. If anyone

     *  regresses that contract, fail the build here so the bad bundle never

     *  ships (used to be a separate `grep` step in each .sh / .ps1 build

     *  script — three near-identical copies before the consolidation).

     */

    postBuild: async (outfile) => {

      const code = await readFile(outfile, 'utf8');

      // Match Mac/Linux absolute (`/Users/...`, `/home/...`) and Windows

      // (`C:\...` or forward-slash form `C:/...`, both upper- and lower-

      // case drives) — esbuild has been observed to emit either slash

      // style on Windows depending on path-normalize internals.

      const m = code.match(/var __dirname = "((?:\/Users|\/home|[A-Za-z]:[\\/])[^"]+)"/);

      if (m) {

        console.error(

          `✘ ${outfile}: hardcoded __dirname → ${m[1]}\n` +

            `  Source must use import.meta.url / utils.getScriptDir(), not __dirname.`,

        );

        process.exit(1);

      }

    },

  },

  cli: {

    entryPoints: ['src/cli/zhishi.ts'],

    outfile: 'src-tauri/resources/cli/zhishi.js',

    // 1.2.3（issue #5）：cjs → esm。repo 本身 type:module、server bundle 已是
    // esm，CLI 的 cjs 是历史异类；cjs 下 import.meta 为空会让 getScriptDir()
    // fallback 到 cwd（宿主资源定位到错误路径 + console.warn 污染 TUI）。
    // banner = shebang（必须首行）+ server 同款 createRequire 互操作别名
    // （bundle 内若有 cjs 依赖/createRequire 字面引用需要）。
    format: 'esm',

    sourcemap: false,

    banner: { js: CLI_SHEBANG_BANNER + '\n' + ESM_INTEROP_BANNER },

    /** Post-build: drop the Windows launcher next to the bundle. Rust's

     *  `cmd_sync_cli` reads `resources/cli/zhishi.js` AND `zhishi.cmd`,

     *  so both have to be present in every release artifact regardless of

     *  the host OS doing the build. Doing the copy here means a single

     *  `npm run build:cli` invocation produces a complete CLI deliverable —

     *  no follow-up shell step in mac/linux/windows builders.

     *

     *  Also writes `package.json` with {"type":"module"}: the bundle is ESM

     *  (1.2.3, issue #5 — was CJS + type:commonjs; CJS has no import.meta,

     *  which made getScriptDir() fall back to cwd) but named .js, and the

     *  repo root package.json is type:module — the marker pins the module

     *  type regardless of the parent package.json scope.

     */

    postBuild: async () => {

      const src = 'src/cli/zhishi.cmd';

      const dst = 'src-tauri/resources/cli/zhishi.cmd';

      await copyFile(src, dst);

      console.log(`  ↳ copied ${src} → ${dst}`);

      const { writeFile } = await import('node:fs/promises');

      await writeFile(

        'src-tauri/resources/cli/package.json',

        JSON.stringify({ type: 'module' }) + '\n',

      );

      console.log('  ↳ wrote src-tauri/resources/cli/package.json (type: module)');

    },

  },

};



const targetName = process.argv[2];

const cfg = TARGETS[targetName];

if (!cfg) {

  const known = Object.keys(TARGETS).join(', ');

  console.error(`Usage: node scripts/esbuild-bundle.mjs <${known}>`);

  process.exit(1);

}



// Ensure the outfile's directory exists. esbuild creates the file but

// requires the parent dir; on a clean checkout (or after `cargo clean`

// nuked target/), `src-tauri/resources/cli/` may not exist yet.

await mkdir(dirname(cfg.outfile), { recursive: true });



await build({

  bundle: true,

  platform: 'node',

  target: 'node22',

  define: {

    // Compile-time version constant. Replaces `process.env.npm_package_version`

    // fallbacks across the codebase so `zhishi version` reports the real

    // shipped build instead of a stale hardcoded string in production.

    __ZHISHI_VERSION__: JSON.stringify(PKG_VERSION),

  },

  // `postBuild` is our own hook — strip it before handing config to esbuild.

  ...(({ postBuild: _strip, ...rest }) => rest)(cfg),

});



if (cfg.postBuild) {

  await cfg.postBuild(cfg.outfile);

}



console.log(`✓ ${targetName} → ${cfg.outfile}`);

