import { fileURLToPath } from 'node:url';

import { includeIgnoreFile } from '@eslint/compat';

import js from '@eslint/js';

import prettier from 'eslint-config-prettier';

import eslintComments from 'eslint-plugin-eslint-comments';

import { defineConfig } from 'eslint/config';

import ts from 'typescript-eslint';



const gitignorePath = fileURLToPath(new URL('./.gitignore', import.meta.url));



// ────────────────────────────────────────────────────────────────────────

// Lint message convention (read this if you're adding a rule):

//

//   Each `message` MUST tell an LLM reader BOTH the problem and the fix —

//   "what breaks if you violate" + "what to use instead". The lint catches

//   the syntax, but the LLM that gets the error needs to reason about edge

//   cases (is this an exception? do I really need this pattern?). A bare

//   "use X instead" leaves the LLM no way to judge — it just does what it's

//   told without understanding when the rule doesn't apply. Format:

//

//     "<symptom / what breaks>. Use <correct helper>. CLAUDE.md red-line."

//

//   When relevant, name the historical incident or class of bug (502 from

//   system proxy, console-window flash, OS-listener leak, …) so the LLM

//   can match its situation against the failure mode rather than blindly

//   following a recipe.

// ────────────────────────────────────────────────────────────────────────



// CLAUDE.md red-line selectors that apply EVERYWHERE (sidecar + shared +

// cli). Spread into every block that defines `no-restricted-syntax`,

// because Flat Config's later-block-wins semantics would otherwise wipe

// these rules for files matched by a more specific block. Defining the

// array once and spreading it keeps the single-source-of-truth.

const GLOBAL_RESTRICTED_SYNTAX = [

  {

    // CLAUDE.md red-line: synchronous busy-wait blocks the event loop.

    // Sidecar busy-wait kills the SDK pump (no messages flow until the

    // wait returns).

    selector: "MemberExpression[object.name='Atomics'][property.name='wait']",

    message:

      'Atomics.wait blocks the event loop synchronously — Sidecar stops draining SDK messages. Use async polling: setTimeout / setInterval / withFileLock helpers. CLAUDE.md red-line.'

  },

  {

    // CLAUDE.md red-line: `<expr>.toISOString().split('T')[0]` returns the

    // UTC date. The unified log filename is built from the *local* date

    // (`~/.zhishi/logs/unified-{YYYY-MM-DD}.log`), so using the UTC date

    // here means writes land in the wrong file for ~1/3 of every day in

    // UTC+8. The bug manifests as missing log entries when a user grep's

    // "today's" log around midnight CN time.

    selector:

      "CallExpression[callee.property.name='split'][callee.object.type='CallExpression'][callee.object.callee.property.name='toISOString'][arguments.0.value='T']",

    message:

      "toISOString().split('T')[0] returns UTC date — in UTC+8 it differs from the local date for ~1/3 of every day, so the log line lands in yesterday's/tomorrow's file. Use localDate() from '@/shared/logTime'. CLAUDE.md red-line."

  },

  {

    // CLAUDE.md red-line: `shouldAbortSession = true` is the persistent-

    // session abort flag. Setting it directly skips the surrounding cleanup

    // (rescue pending items, notify IM bus subscribers, wake blocked

    // generator) and leaves the SDK in an inconsistent state — pending

    // requests never get an error reply and IM subscribers hang. The ONLY

    // legitimate setter is inside `abortPersistentSession()` in

    // agent-session.ts, which performs the full teardown sequence.

    // Re-setting it to `false` (lifecycle reset at session boundaries) is

    // fine — that's why we only ban `= true`.

    selector:

      "AssignmentExpression[operator='='][left.name='shouldAbortSession'][right.type='Literal'][right.value=true]",

    message:

      'Direct `shouldAbortSession = true` skips the abort cleanup chain (pending request rescue, IM bus notification, generator wake) — pending IM replies hang forever. Call abortPersistentSession() instead. CLAUDE.md red-line.'

  }

];



// Sidecar-only restrictions. Includes everything in GLOBAL plus the

// __dirname ban (esbuild hardcodes __dirname at bundle time).

const SIDECAR_RESTRICTED_SYNTAX = [

  ...GLOBAL_RESTRICTED_SYNTAX,

  {

    // CLAUDE.md red-line: esbuild bundles src/server into a single

    // server-dist.js, hardcoding __dirname to the SOURCE file's directory.

    // At runtime the bundle lives in dist/, so any path.join(__dirname,

    // ...) reads a path that doesn't exist (or, worse, exists from an old

    // build and serves stale content).

    selector: "Identifier[name='__dirname']",

    message:

      'esbuild hardcodes __dirname to the source file path at bundle time → at runtime the path points into a non-existent (or stale) source tree. Use fileURLToPath(import.meta.url) or getScriptDir() from @/server/utils/runtime. CLAUDE.md red-line.'

  }

];



// Tools restrictions. Includes everything in SIDECAR plus

// the bare-fetch ban — these code paths run inside SDK turns,

// where a stuck fetch holds the turn indefinitely.

const TOOLS_RESTRICTED_SYNTAX = [

  ...SIDECAR_RESTRICTED_SYNTAX,

  {

    // CLAUDE.md red-line: bare fetch() inside tool / bridge code has no

    // AbortSignal, so when the upstream hangs (Feishu API timeout, network

    // pause, server slow-loris) the tool turn / IM message processing

    // hangs forever. The whole user-visible session appears frozen until

    // the OS TCP timeout (minutes). cancellableFetch() wires a 30s default

    // timeout AND parent-signal propagation so caller cancellation

    // (turn abort, session cancel, …) actually tears down the request.

    selector: "CallExpression[callee.type='Identifier'][callee.name='fetch']",

    message:

      'Bare fetch() in tools/bridge has no AbortSignal — upstream hang freezes the SDK turn / IM message until OS TCP timeout (minutes). Use cancellableFetch from @/server/utils/cancellation, which wires a default 30s timeout and propagates parent abort signals. CLAUDE.md red-line.'

  },

  {

    // Same hazard via the namespaced form: `globalThis.fetch(...)` /

    // `window.fetch(...)` / `self.fetch(...)`. AST-equivalent to bare

    // `fetch(...)` — same lifetime, same lack of default AbortSignal — so

    // it must be banned alongside. Indirect-via-rebinding (`const f =

    // globalThis.fetch; f(...)`) is harder to express in ESLint and is

    // left to review.

    selector:

      "CallExpression[callee.type='MemberExpression'][callee.property.name='fetch'][callee.object.name=/^(globalThis|window|self)$/]",

    message:

      'Namespaced fetch (globalThis.fetch / window.fetch / self.fetch) has the same hang risk as bare fetch() — Use cancellableFetch from @/server/utils/cancellation. CLAUDE.md red-line.'

  }

];



export default defineConfig(

  includeIgnoreFile(gitignorePath),

  {

    // Additional ignore patterns for build output and bundled resources

    ignores: ['**/out/**', '**/dist/**', '**/.vite/**', '**/coverage/**', '**/.eslintcache', 'bundled-skills/**', 'output/**', 'tmp_replace_build.cjs']

  },

  js.configs.recommended,

  ...ts.configs.recommended,

  prettier,

  {

    plugins: {

      'eslint-comments': eslintComments,

    }

  },

  // Global rules for all files

  {

    rules: {

      // TypeScript rules

      'no-undef': 'off', // TypeScript handles this

      '@typescript-eslint/no-explicit-any': 'error',

      '@typescript-eslint/no-unused-vars': [

        'error',

        {

          argsIgnorePattern: '^_',

          varsIgnorePattern: '^_',

          caughtErrorsIgnorePattern: '^_'

        }

      ],

      // Prevent disabling no-explicit-any via inline comments — it hides real

      // type bugs behind `any`. Ban list extends below for ESM-targeted files

      // (which is everything except `src/cli/**`).

      'eslint-comments/no-restricted-disable': ['error', '@typescript-eslint/no-explicit-any']

    }

  },

  // ESM-targeted files (everything except the CJS-bundled CLI): forbid

  // `// eslint-disable-next-line @typescript-eslint/no-require-imports`.

  //

  // Why: bare `require()` in an ESM file throws `ReferenceError: require is

  // not defined` at runtime. The Bun→Node v0.2.0 migration accumulated 6+

  // sites where developers reached for `require()` (probably copy-paste from

  // legacy CJS code) and silenced the lint with a disable comment. Each one

  // was a latent crash waiting for the right code path. The MCP playwright

  // "initialization failed: require is not defined" regression in v0.2.0 was

  // caused by exactly this. ESM files MUST use static `import` or

  // `await import()` — never `require()`.

  {

    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],

    ignores: ['src/cli/**'],

    rules: {

      'eslint-comments/no-restricted-disable': [

        'error',

        '@typescript-eslint/no-explicit-any',

        '@typescript-eslint/no-require-imports'

      ]

    }

  },

  // CLI is bundled by esbuild with `--format=cjs` (see package.json:build:cli),

  // so `require()` runs in a real CJS context after bundling. Disable the rule

  // entirely for CLI files — relying on disable-next-line comments would force

  // every `require()` call site to carry boilerplate, and (per Codex review)

  // doesn't actually constitute a true exemption since the underlying rule

  // would still fire if a contributor forgot the comment.

  {

    files: ['src/cli/**/*.{ts,tsx}'],

    rules: {

      '@typescript-eslint/no-require-imports': 'off'

    }

  },

  // CJS config/build scripts run in a real CommonJS context, so `require()`
  // is the correct module syntax. Disable the ESM-only import rule for them.
  {
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },

  // Structural guard: builtin MCP tool files MUST NOT eager-import the SDK

  // or zod at module top (value imports only — `import type { ... }` is

  // erased at compile time and is fine). Value imports from these modules

  // must be loaded inside `createXxxServer()` via `await import(...)` so

  // the Sidecar cold-start singleton-creation tax (~500-1000ms) stays

  // deferred. Enforces the "Pit of success" convention codified in

  // CLAUDE.md 补充禁止事项 and builtin-mcp-meta.ts header.

  //

  // Uses @typescript-eslint/no-restricted-imports (not the base rule) so

  // that `allowTypeImports: true` lets us keep type-only imports zero-cost.

  {

    files: ['src/server/tools/*.ts'],

    ignores: ['src/server/tools/builtin-mcp-registry.ts', 'src/server/tools/builtin-mcp-meta.ts'],

    rules: {

      'no-restricted-imports': 'off',

      '@typescript-eslint/no-restricted-imports': [

        'error',

        {

          paths: [

            {

              name: '@anthropic-ai/claude-agent-sdk',

              message:

                "Top-level value-import of @anthropic-ai/claude-agent-sdk in src/server/tools/* defeats the lazy-load architecture: the SDK's createSdkMcpServer() singleton-init runs at module-eval time, paid by every Sidecar cold start (~500–1000ms each, 6 tools = ~3–6s). Move the import inside the `createXxxServer()` factory body via `await import('@anthropic-ai/claude-agent-sdk')` so the cost is paid only when the tool is actually used. `import type { ... }` at module top is fine — types erase at compile. CLAUDE.md red-line.",

              allowTypeImports: true

            },

            {

              name: 'zod',

              message:

                "Top-level value-import of zod in src/server/tools/* eager-creates the schema-validation runtime — same Sidecar cold-start tax as the SDK ban above (~500ms per tool). Move inside `createXxxServer()` via `await import('zod/v4')`. `import type { ... }` at module top is fine. CLAUDE.md red-line.",

              allowTypeImports: true

            },

            {

              name: 'zod/v4',

              message:

                "Same as the `zod` rule above: top-level value-import eager-creates the schema runtime at Sidecar cold start. Move inside `createXxxServer()` via `await import('zod/v4')`. `import type { ... }` at module top is fine. CLAUDE.md red-line.",

              allowTypeImports: true

            }

          ]

        }

      ]

    }

  },

  // Sidecar (`src/server/**`): inherits GLOBAL bans + adds the __dirname

  // ban (esbuild hardcodes __dirname at bundle time → runtime path

  // resolves into a non-existent source tree).

  //

  // SIDECAR_RESTRICTED_SYNTAX is the full set: GLOBAL + __dirname.

  // The next block (tools) is more specific (later in the

  // file) and adds the fetch ban on top — Flat Config's later-block-wins

  // semantics mean the more specific block must respread the full set,

  // which TOOLS_RESTRICTED_SYNTAX does.

  {

    files: ['src/server/**/*.ts'],

    rules: {

      'no-restricted-syntax': ['error', ...SIDECAR_RESTRICTED_SYNTAX]

    }

  },

  // Tools: bare fetch() ban on top of all sidecar rules.

  // These code paths run inside SDK turns (tools/), where a stuck upstream

  // freezes the user-visible

  // session. cancellableFetch() from @/server/utils/cancellation provides

  // a default 30s timeout and propagates parent abort signals.

  //

  // Tests (`__tests__/`) and the cancellation helper itself are exempt —

  // the helper IS the wrapper around raw fetch.

  {

    files: ['src/server/tools/**/*.ts'],

    ignores: [

      'src/server/utils/cancellation.ts', // the wrapper itself

      'src/server/**/__tests__/**',

      'src/server/**/*.test.ts'

    ],

    rules: {

      'no-restricted-syntax': ['error', ...TOOLS_RESTRICTED_SYNTAX]

    }

  },

  // Other-files catchall: shared / cli / scripts that didn't match any

  // earlier block above still need the Atomics.wait + UTC-date bans.

  // The sidecar + tools-bridge blocks override this for their own files

  // (each carrying its own restricted-syntax superset).

  {

    files: ['src/**/*.{ts,tsx,js,mjs,cjs}'],

    ignores: ['src/server/**'],

    rules: {

      'no-restricted-syntax': ['error', ...GLOBAL_RESTRICTED_SYNTAX]

    }

  },

  // ===== i18n 棘轮（specs/tech_docs/i18n_architecture.md §6）=====
  // 已迁移 surface 禁止出现裸中文（字符串 / 模板串里的 CJK）。
  // t('中文 key') 豁免（callee 不是 t 的字面量才报）；测试豁免。
  {
    files: [
      'src/shared/i18n.ts',
    ],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.name!='t'] > Literal[value=/[一-鿿]/]",
          message: 'i18n：字符串禁止裸中文——请用 t()（中文原文可直接作 key）',
        },
        {
          selector: "CallExpression[callee.name!='t'] TemplateElement[value.raw=/[一-鿿]/]",
          message: 'i18n：模板串禁止裸中文——请用 t()',
        },
      ],
    },
  }

);
