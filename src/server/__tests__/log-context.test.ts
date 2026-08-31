/**

 * Pattern 6 §6.2.1 — correlation context propagation.

 *

 * Verifies:

 *  (a) `withLogContext({ sessionId: 'X' })` makes a `console.warn(...)`

 *      inside its body produce a LogEntry whose `sessionId === 'X'`.

 *  (b) Nested `withLogContext` merges fields — outer `sessionId` plus

 *      inner `turnId` both land on the entry.

 *  (c) Outside any context wrapper, `sessionId` (and friends) is undefined.

 *

 * The capture path under test:

 *   console.warn(...) → patched by initLogger → createAndBroadcast()

 *     → reads getLogContext() → merges fields onto LogEntry

 *     → invokes broadcastLog() (we install a recording broadcaster)

 *

 * No SSE / no real broadcast — we just intercept what the logger would

 * have sent to clients.

 */



import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';



// Stub UnifiedLogger so console.warn → createAndBroadcast → appendUnifiedLog

// doesn't actually write to the developer's real ~/.zhishi/logs/. The

// behaviour under test (correlation-field merging on the broadcast LogEntry)

// is fully observable via the in-memory `captured[]` array; disk writes

// would only pollute the unified log with `[test]` lines that have no

// diagnostic value outside the test run.

vi.mock('../UnifiedLogger', () => ({

  appendUnifiedLog: () => {},

  _flushUnifiedLogForTests: () => {},

  _getDroppedCount: () => 0,

  getRecentLogLines: () => [],

  getActiveUnifiedLogPath: () => null,

}));



import { initLogger, restoreConsole, withLogContext } from '../logger';

import {

  setAmbientLogContext,

  clearAmbientLogContextField,

  __resetAmbientForTests,

} from '../logger-context';

import type { LogEntry } from '../../shared/types/log';



let captured: LogEntry[] = [];

const fakeClients = [

  {

    send: (event: string, data: unknown) => {

      if (event === 'chat:log') captured.push(data as LogEntry);

    },

  } as unknown as { send: (event: string, data: unknown) => void },

];



beforeEach(() => {

  captured = [];

  // Cast through unknown — initLogger expects a strict SSE client type, but

  // for this test we only care about `.send(event, data)` being callable.

  initLogger(() => fakeClients as unknown as ReturnType<

    typeof import('../sse').createSseClient

  >['client'][]);

});



afterEach(() => {

  restoreConsole();

  captured = [];

  __resetAmbientForTests();

});



describe('Pattern 6 — withLogContext correlation injection', () => {

  it('(a) injects sessionId into a console.warn inside the wrapper', () => {

    withLogContext({ sessionId: 'X' }, () => {

      console.warn('[test] hello');

    });

    expect(captured.length).toBeGreaterThan(0);

    const e = captured.find(c => c.message === '[test] hello');

    expect(e).toBeDefined();

    expect(e!.sessionId).toBe('X');

    // Other fields stay undefined unless explicitly provided.

    expect(e!.turnId).toBeUndefined();

    expect(e!.tabId).toBeUndefined();

  });



  it('(b) nested withLogContext merges fields', () => {

    withLogContext({ sessionId: 'S1', tabId: 'T1' }, () => {

      withLogContext({ turnId: 'turn-1' }, () => {

        console.warn('[test] nested');

      });

    });

    const e = captured.find(c => c.message === '[test] nested');

    expect(e).toBeDefined();

    expect(e!.sessionId).toBe('S1');

    expect(e!.tabId).toBe('T1');

    expect(e!.turnId).toBe('turn-1');

  });



  it('(c) outside any context, correlation fields are undefined', () => {

    console.warn('[test] outside');

    const e = captured.find(c => c.message === '[test] outside');

    expect(e).toBeDefined();

    expect(e!.sessionId).toBeUndefined();

    expect(e!.tabId).toBeUndefined();

    expect(e!.turnId).toBeUndefined();

    expect(e!.requestId).toBeUndefined();

    expect(e!.runtime).toBeUndefined();

    expect(e!.ownerId).toBeUndefined();

  });



  it('(e) cross-owner ambient slots do not contaminate each other', async () => {

    // Two concurrent owners (A, B) each stamp their own ambient turnId. The

    // ALS frame for each owner carries its sessionId, which getLogContext()

    // uses to look up the right ambient slot. Without the per-owner Map fix,

    // the second setAmbientLogContext would clobber the first's turnId, and

    // both logs would be mis-tagged.

    setAmbientLogContext('A', { turnId: 'a1', sessionId: 'A' });

    setAmbientLogContext('B', { turnId: 'b1', sessionId: 'B' });



    await Promise.all([

      withLogContext({ sessionId: 'A' }, async () => {

        await Promise.resolve();

        console.warn('[test] from-A');

      }),

      withLogContext({ sessionId: 'B' }, async () => {

        await Promise.resolve();

        console.warn('[test] from-B');

      }),

    ]);



    const a = captured.find(c => c.message === '[test] from-A');

    const b = captured.find(c => c.message === '[test] from-B');

    expect(a).toBeDefined();

    expect(b).toBeDefined();

    expect(a!.sessionId).toBe('A');

    expect(a!.turnId).toBe('a1');

    expect(b!.sessionId).toBe('B');

    expect(b!.turnId).toBe('b1');



    // Clearing A's turnId leaves B's intact.

    clearAmbientLogContextField('A', 'turnId');

    captured = [];

    await withLogContext({ sessionId: 'B' }, async () => {

      console.warn('[test] still-B');

    });

    const stillB = captured.find(c => c.message === '[test] still-B');

    expect(stillB).toBeDefined();

    expect(stillB!.turnId).toBe('b1');

  });



  it('(d) async work inside withLogContext keeps the frame across awaits', async () => {

    await withLogContext({ sessionId: 'async-session' }, async () => {

      await Promise.resolve();

      await new Promise(r => setTimeout(r, 1));

      console.warn('[test] after await');

    });

    const e = captured.find(c => c.message === '[test] after await');

    expect(e).toBeDefined();

    expect(e!.sessionId).toBe('async-session');

  });

});

