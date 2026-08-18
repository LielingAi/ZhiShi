// Populate src-tauri/resources/tsx-runtime/ with a self-contained tsx

// install (tsx + esbuild JS wrapper + per-platform @esbuild/<triple>

// binary + get-tsconfig). The Plugin Bridge consumes this at runtime

// via `--import file:///<runtime>/node_modules/tsx/dist/esm/index.mjs`,

// so OpenClaw plugins shipping raw `.ts` source can be transpiled

// without per-plugin `npm install` (which previously pruned our SDK

// shim because npm reconciles `node_modules/` against `package.json`

// even with `--no-save`).

//

// Why a *target*-platform install (not host): cross-arch builds must

// pick the right native esbuild binary. npm's `--os`/`--cpu` flags

// filter optionalDependencies to the requested platform, so

//   npm install tsx --os=win32 --cpu=x64

// produces `node_modules/@esbuild/win32-x64/bin/esbuild.exe` even on

// a Mac arm64 host. Per-platform release shell scripts pass their

// target triple here; dev / `./scripts/dev/build_dev.sh` passes the host arch.

//

// Usage:

//   node scripts/setup-tsx-runtime.mjs <os> <cpu>

// where:

//   <os>  ∈ darwin | linux | win32

//   <cpu> ∈ arm64  | x64



import { writeFile, mkdir, rm, readFile, readdir } from 'node:fs/promises';

import { existsSync } from 'node:fs';

import { execFileSync } from 'node:child_process';

import { resolve, relative } from 'node:path';



const [os, cpu] = process.argv.slice(2);

const VALID_OS = new Set(['darwin', 'linux', 'win32']);

const VALID_CPU = new Set(['arm64', 'x64']);

if (!VALID_OS.has(os) || !VALID_CPU.has(cpu)) {

  console.error(

    `Usage: node scripts/setup-tsx-runtime.mjs <os> <cpu>\n` +

      `  os  ∈ ${[...VALID_OS].join(', ')}\n` +

      `  cpu ∈ ${[...VALID_CPU].join(', ')}\n` +

      `Got: os=${os ?? '(none)'} cpu=${cpu ?? '(none)'}`,

  );

  process.exit(1);

}



const PROJECT_ROOT = resolve(import.meta.dirname, '..');

const RUNTIME_DIR = resolve(PROJECT_ROOT, 'src-tauri/resources/tsx-runtime');



// Read tsx version from the project so the runtime always matches what

// the project's other tooling (test runner) uses —

// avoids two-tsx-versions-in-one-install footguns.

//

// IMPORTANT: tsx is pinned to an EXACT version (not caret) on purpose.

// tsx 4.21.1 and 4.22.0 introduced a regression in their ESM load hook:

// for any `require('./foo.json')` made under a `--import tsx` process,

// the hook now runs esbuild's JSON-to-ESM transform first, producing

// JS source (`var application_... = {...}; export default ...`). Node's

// CJS `.json` extension handler then JSON.parse's that JS source and

// dies with `SyntaxError: Unexpected token 'v', "var applic"...`.

// Our Plugin Bridge spawns Node with `--import tsx/.../index.mjs` for

// every OpenClaw plugin, so every plugin whose deps require any .json

// (mime-db, axios, form-data → mime-db) fails to load — feishu/wecom/

// qqbot all go gray in production. Repros with tsx 4.21.1+; 4.21.0 is

// the last known-good. See unified-2026-05-16.log for the prod incident.

// Before bumping, verify with:

//   node --import file://<runtime>/node_modules/tsx/dist/esm/index.mjs \

//     -e "require('module').createRequire(\"$HOME/.zhishi/openclaw-plugins/openclaw-lark/\")('mime-db')"

const projectPkgRaw = await readFile(resolve(PROJECT_ROOT, 'package.json'), 'utf8');

const projectPkg = JSON.parse(projectPkgRaw.replace(/^\uFEFF/, ''));

const tsxVersion =

  projectPkg.dependencies?.tsx ||

  projectPkg.devDependencies?.tsx;

if (!tsxVersion) {

  console.error('tsx not found in project package.json — add it to dependencies');

  process.exit(1);

}



await rm(RUNTIME_DIR, { recursive: true, force: true });

await mkdir(RUNTIME_DIR, { recursive: true });



await writeFile(

  resolve(RUNTIME_DIR, 'package.json'),

  JSON.stringify(

    {

      name: 'zhishi-tsx-runtime',

      private: true,

      // Comment-equivalent: this dir is populated by setup-tsx-runtime.mjs

      // and consumed by Plugin Bridge via absolute --import path. Don't

      // edit by hand; it gets nuked + reinstalled on every release build.

      dependencies: { tsx: tsxVersion },

    },

    null,

    2,

  ),

);



console.log(`→ npm install tsx@${tsxVersion} --os=${os} --cpu=${cpu} into ${RUNTIME_DIR}`);



// Node ≥20.12 (CVE-2024-27980) refuses to spawn `.cmd` / `.bat` shims

// without `shell: true`, returning `EINVAL`. `npm` on Windows is `npm.cmd`,

// so we have to opt in. On POSIX `npm` is a real script with a shebang

// and `shell: true` would just add a wasted /bin/sh hop — keep it off.

//

// `shell: true` means args are concatenated and re-parsed by cmd.exe,

// so any value containing whitespace or shell metacharacters would need

// quoting. Our args are all `--flag=value` with no spaces, so this is

// safe; revisit if anyone adds an arg with user-supplied content.

const isWindows = process.platform === 'win32';

//

// `--ignore-scripts` is load-bearing for cross-arch builds, not a stylistic

// hardening. esbuild's postinstall runs `node install.js` from inside the

// freshly installed package and validates the **host arch's**

// `@esbuild/<triple>/bin/esbuild` version against esbuild's own

// `package.json` version. With `--cpu=<TARGET>`, npm filters

// optionalDependencies to the target arch only — the host arch's

// `@esbuild/<host-triple>` is never installed under tsx-runtime/, so the

// resolver walks UP the directory tree and ends up finding the project

// root's `node_modules/@esbuild/<host-triple>` (a different version

// pulled in by our own esbuild devDep). Mismatch → throw, build fails:

//

//   Error: Expected "0.27.7" but got "0.25.12"

//

// We don't need esbuild's postinstall at all — we ship the resulting

// directory for the target's runtime to consume, not for invocation

// from this build host. Skipping all install scripts is safe for the

// dependency graph here (tsx itself has no postinstall, and esbuild's

// is purely the version-mismatch check above).

execFileSync(

  isWindows ? 'npm.cmd' : 'npm',

  [

    'install',

    '--no-audit',

    '--no-fund',

    '--ignore-scripts',

    `--os=${os}`,

    `--cpu=${cpu}`,

  ],

  { cwd: RUNTIME_DIR, stdio: 'inherit', shell: isWindows },

);



// Drop unused optionalDependencies that ship native code we don't sign.

//

// `fsevents` is pulled in by tsx purely for chokidar watch-mode FS events

// on macOS. We invoke tsx as an ESM loader (`--import .../tsx/.../index.mjs`),

// never `tsx watch ...`, so fsevents is dead weight. It also ships

// `fsevents.node` — a Mach-O native module — which would force a separate

// codesign + notarization pass on every macOS build (Apple flags any

// unsigned `.node` in the bundle as a "binary not signed" critical

// validation error). Deleting it removes the file before it ever reaches

// the Tauri resources copy, eliminating the failure mode at the source

// rather than papering over it with an extra signing rule.

//

// Safe because fsevents is declared as `optionalDependencies` in tsx's

// package.json — tsx's `try { require('fsevents') } catch {}` fallback

// silently skips when missing. We can't pass `--omit=optional` to npm

// install because esbuild's per-platform `@esbuild/<triple>` packages

// are *also* optionalDependencies, and dropping those would break the

// whole point of this script. Surgically removing fsevents is the only

// option that keeps esbuild intact.

//

// If new native `.node` files appear in tsx's transitive graph in a

// future tsx release, the sanity check below + the notarization step

// in ./scripts/build/build_macos.sh will both fail loudly so we know to extend this.

const fseventsDir = resolve(RUNTIME_DIR, 'node_modules/fsevents');

if (existsSync(fseventsDir)) {

  await rm(fseventsDir, { recursive: true, force: true });

  console.log(`  ↳ removed fsevents (watch-mode dep, unused as ESM loader)`);

}



// Sanity check: the platform binary must end up under @esbuild/<triple>.

//

// Layout differs by platform — POSIX puts the binary in `bin/esbuild`

// (so npm's bin-symlink machinery works), Windows ships it at the

// package root as `esbuild.exe` (Windows has no symlink-bin convention,

// just a plain "package.json bin field points to a sibling file"

// arrangement). Verified against the upstream tarball, not a guess.

const triple = `${os}-${cpu}`;

const platformBinary =

  os === 'win32'

    ? resolve(RUNTIME_DIR, 'node_modules/@esbuild', triple, 'esbuild.exe')

    : resolve(RUNTIME_DIR, 'node_modules/@esbuild', triple, 'bin/esbuild');

if (!existsSync(platformBinary)) {

  console.error(`✘ Platform binary not produced at ${platformBinary}`);

  console.error(`  npm install --os=${os} --cpu=${cpu} did not pull @esbuild/${triple}.`);

  console.error(`  Check npm version (need ≥10.x for --os/--cpu flags) and network.`);

  process.exit(1);

}



// Guardrail: fail loudly on unexpected native binaries.

//

// Apple notarization rejects any unsigned `.node` (or `.dylib`, `.so`,

// `.dll`) anywhere in the .app bundle. Today the only legitimate native

// file under tsx-runtime is `@esbuild/<triple>/bin/esbuild` (signed by

// ./scripts/build/build_macos.sh's per-target loop). If a future tsx release adds a

// new transitive native dep, we want a build-time failure here naming

// the file rather than a 30-min round-trip through Apple's notarizer.

//

// "Allowed" is encoded as a path predicate, not a list of basenames,

// so a renamed binary in @esbuild's tree still passes while a brand-new

// `.node` elsewhere flags.

async function* walkFiles(dir) {

  for (const ent of await readdir(dir, { withFileTypes: true })) {

    const p = resolve(dir, ent.name);

    if (ent.isDirectory()) yield* walkFiles(p);

    else if (ent.isFile()) yield p;

  }

}

const NATIVE_EXTS = /\.(node|dylib|so|dll)$/i;

const isAllowedNative = (rel) =>

  // The platform-specific esbuild binary lives under @esbuild/<triple>/bin/.

  // It's a Mach-O / ELF / PE depending on target — `.node`/`.dylib`/`.so`/`.dll`

  // never matches there because the file has no extension on POSIX and `.exe`

  // on Windows, so this allowance is effectively for future-proofing if

  // upstream changes naming.

  rel.startsWith('node_modules/@esbuild/');

const stragglers = [];

for await (const file of walkFiles(resolve(RUNTIME_DIR, 'node_modules'))) {

  const rel = relative(RUNTIME_DIR, file).replace(/\\/g, '/');

  if (NATIVE_EXTS.test(rel) && !isAllowedNative(rel)) stragglers.push(rel);

}

if (stragglers.length > 0) {

  console.error(`✘ Unexpected native binaries in tsx-runtime:`);

  for (const s of stragglers) console.error(`  - ${s}`);

  console.error(

    `  Notarization will fail unless these are signed or removed. If they're\n` +

      `  truly needed at runtime, extend ./scripts/build/build_macos.sh's tsx-runtime signing\n` +

      `  loop to cover them. If they're dead weight (like fsevents was), add\n` +

      `  a targeted rm step above.`,

  );

  process.exit(1);

}



console.log(`✓ tsx-runtime ready at ${RUNTIME_DIR} (target=${triple})`);

