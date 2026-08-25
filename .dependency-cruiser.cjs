// ZhiShi architectural-boundary lint via dependency-cruiser.
//
// This file holds the "module-graph" rules that ESLint can't express:
// "module A is not allowed to import from module B." Each rule below
// codifies a structural invariant from CLAUDE.md so violations fail at
// `npm run lint:deps` instead of being caught (or missed) during review.
//
// LLM reader convention: each rule's `comment` field MUST explain BOTH
// the bug that arises if you violate (so you can match your situation
// to the failure mode) AND the correct path. See eslint.config.js header
// for the same convention.
//
// Run:  npx depcruise --config .dependency-cruiser.cjs src
// Or via npm script: `npm run lint:deps`

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular dependencies cause init-order surprises (one side sees `undefined` instead of an export at module-eval time, then fails at first call) and bloat bundles. Refactor to extract the shared interface into a third leaf module both sides can depend on.',
      from: {},
      to: { circular: true }
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment:
        'Orphan modules (no other file imports them) are usually leftovers from deleted features that nobody noticed. They still get type-checked and bundled. Either delete the file or wire it back into the entry it should serve. Excludes config files, declaration files, and entry points which are legitimately not imported.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(?:js|cjs|mjs|ts|json)$', // dotfiles like .eslintrc
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.json$',
          '(^|/)(babel|nodemon|jest|vitest|webpack|esbuild|vite|tailwind|postcss|stylelint)\\.config\\.(js|cjs|mjs|ts)$',
          '^src/server/index\\.ts$', // sidecar entry
          '^src/cli/zhishi\\.ts$', // CLI entry
          '^src/gui/src/main\\.tsx$', // GUI entry（由 index.html 引用，非 TS 图）
          '^src-tauri/', // Rust files: depcruise sees them only via fs walk; not part of TS graph
          // Type-only files. Since we set tsPreCompilationDeps:false, dep-cruiser
          // doesn't track `import type {...}` edges, so these files look orphan
          // even though `import type`-consumers exist throughout the codebase.
          // Patterns:
          //   types/<x>.ts  — `src/**/types/foo.ts`
          //   types.ts      — `src/**/types.ts`
          //   *Types.ts     — `src/**/treeTypes.ts`, `src/**/AgentTypes.ts`, etc.
          '(/|^)types/[^/]+\\.ts$',
          '(/|^)types\\.ts$',
          '(/|^)[^/]+[Tt]ypes\\.ts$'
        ]
      },
      to: {}
    },
    {
      // CLAUDE.md red-line: builtin MCP files (`src/server/tools/*.ts`)
      // run inside Sidecar but MUST stay isolated from the agent-session
      // module — they're loaded lazily at MCP-server-creation time, and
      // pulling in agent-session's transitive deps (SDK, zod, session
      // store, IM bus, …) would either re-trigger the cold-start tax that
      // the lazy-load is designed to avoid, OR create a circular dep
      // (agent-session imports from tools/ to register them).
      name: 'tools-no-import-agent-session',
      severity: 'error',
      comment:
        'src/server/tools/* MUST NOT import agent-session — would either re-trigger the cold-start singleton tax that the lazy-load architecture avoids, or create a circular import (agent-session is the one that calls into tools/ to register MCP servers). Restructure: pass any data the tool needs through the createXxxServer() factory args, not a top-level import.',
      from: { path: '^src/server/tools/[^/]+\\.ts$' },
      to: { path: '^src/server/agent-session\\.ts$' }
    },
    {
      // Builtin MCP factory isolation: tools shouldn't import each other
      // either. They're standalone factories registered into a single
      // registry. Cross-tool imports would couple their lazy-load
      // lifecycles and risk re-introducing eager-load bugs.
      // The registry + meta files are the legitimate cross-tool surface.
      name: 'tools-no-cross-imports',
      severity: 'error',
      comment:
        'Builtin MCP tool files in src/server/tools/ MUST NOT import each other — each is an independent lazy-loaded factory, cross-imports would couple their cold-start lifecycles and could resurrect the eager-load tax (~500–1000ms per tool) that the createXxxServer() pattern is designed to defer. Use src/server/tools/builtin-mcp-registry.ts or builtin-mcp-meta.ts as the shared surface.',
      from: {
        path: '^src/server/tools/[^/]+\\.ts$',
        pathNot: [
          '^src/server/tools/builtin-mcp-registry\\.ts$',
          '^src/server/tools/builtin-mcp-meta\\.ts$'
        ]
      },
      to: {
        path: '^src/server/tools/[^/]+\\.ts$',
        pathNot: [
          '^src/server/tools/builtin-mcp-registry\\.ts$',
          '^src/server/tools/builtin-mcp-meta\\.ts$'
        ]
      }
    },
    {
      // Shared/ exists specifically to be the dependency target for both
      // CLI AND sidecar (types, pure utilities, constants). It
      // therefore MUST stay free of process-specific imports — anything
      // it pulls in would itself become "shared" and break the boundary
      // for the side that doesn't have those modules.
      name: 'shared-stays-pure',
      severity: 'error',
      comment:
        'src/shared is consumed by BOTH cli and sidecar — it must stay free of process-specific imports. A sidecar-only or cli-only dep would either crash on the other side at bundle time or sneak the wrong runtime code into the wrong bundle (e.g. fs in a pure module). If you need to share something process-specific, put it in src/server/shared or src/cli/shared instead.',
      from: { path: '^src/shared/' },
      to: { path: '^src/(server|cli)/' }
    }
  ],
  options: {
    doNotFollow: {
      path: ['node_modules']
    },
    exclude: {
      // GUI 构建产物（vite dist）不进依赖图——孤儿/循环规则对它无意义。
      path: '^src/gui/dist/'
    },
    // tsPreCompilationDeps: false → skip `import type` and other
    // type-only imports. Those are erased at compile time and don't
    // create a runtime dependency, so they shouldn't trigger boundary
    // rules. Without this, every shared type that lives in the wrong
    // directory shows up as a false-positive architectural violation.
    tsPreCompilationDeps: false,
    tsConfig: {
      fileName: 'tsconfig.json'
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      mainFields: ['module', 'main', 'types', 'typings']
    }
  }
};
