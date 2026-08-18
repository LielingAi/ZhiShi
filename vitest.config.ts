import { defineConfig } from 'vitest/config';

// Two test projects, split by what a test TOUCHES — so the dev loop gets a
// fast, parallel pure-logic pool while the stateful integration-ish tests keep
// their (required) serial isolation.
//
//  - `unit`     : pure logic. No module-level singletons, no fixed ports, no
//                 real SDK, no shared disk path → safe to run in PARALLEL forks.
//                 Target: < 5s, run on every save (`npm run test:unit`).
//  - `stateful` : touches `agent-session.ts` / `index.ts` / `external-session.ts`
//                 module-level globals, binds a sidecar port, writes under
//                 ~/.zhishi, or runs the real SDK. MUST stay singleFork serial
//                 (the original reason vitest was configured singleFork).
//
// Routing rule: shared/* is pure today → `unit`. Server tests default to
// `stateful`; a NEW pure server test opts INTO the fast pool by naming itself
// `*.unit.test.ts`. If a `unit` test ever flakes under parallelism (turns out
// to import a stateful module), move it to `stateful` — correctness over speed.
export default defineConfig({
  test: {
    // Coverage is aggregated across projects. No hard % threshold on purpose —
    // we ratchet per changed file rather than chase a global number (which
    // invites filler tests). Run with `npm run coverage`.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'json-summary'],
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**', 'src/test/**'],
    },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'src/shared/**/*.test.ts',
            'src/server/**/*.unit.test.ts',
            'src/cli/**/*.unit.test.ts',
          ],
          // Fast pure tests — a tight timeout surfaces accidental real I/O.
          testTimeout: 10_000,
          hookTimeout: 10_000,
          pool: 'forks',
          // parallel (vitest default) — no singleFork
        },
      },
      {
        test: {
          name: 'stateful',
          environment: 'node',
          include: ['src/server/**/*.test.ts'],
          exclude: ['src/server/**/*.unit.test.ts', '**/node_modules/**'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
