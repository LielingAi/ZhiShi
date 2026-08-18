/**
 * Pattern 1 follow-up — turn-scoped AbortController plumbing.
 *
 * Covers the registry helper + the cancellableFetch parent-signal hookup that
 * tools rely on. We don't exercise the full SDK turn (no agent harness at the
 * unit-test layer); instead we verify the contract that tools depend on:
 *
 *   beginTurn(sid)              → getCurrentTurnSignal() returns its signal
 *   abortTurn(sid, 'user')      → that signal aborts within ~one tick
 *   cancellableFetch hung-fetch + parent=getCurrentTurnSignal()
 *                               → rejects with AbortError immediately on abort
 *   endTurn(sid)                → drops registration, no abort
 *   nested begin / end          → stack semantics, top-of-stack wins
 *
 * Production wiring: `agent-session.ts` calls `beginTurn(sessionId)` at turn
 * start and `endTurn(sessionId)` in handleMessageComplete/Stopped.
 * `interruptCurrentResponse(reason)` calls `abortTurn(sessionId, reason)`
 * before `querySession.interrupt()`. Tools pull `getCurrentTurnSignal()` and
 * pass it as
 * `parentSignal` to `cancellableFetch`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { cancellableFetch } from '../utils/cancellation';
import {
  __resetTurnAbortRegistryForTests,
  abortTurn,
  beginTurn,
  endTurn,
  getCurrentTurnSignal,
} from '../utils/turn-abort';

afterEach(() => {
  __resetTurnAbortRegistryForTests();
});

describe('turn-abort registry', () => {
  it('beginTurn returns a fresh signal that getCurrentTurnSignal exposes', () => {
    expect(getCurrentTurnSignal()).toBeUndefined();
    const { signal } = beginTurn('s1');
    expect(signal.aborted).toBe(false);
    expect(getCurrentTurnSignal()).toBe(signal);
  });

  it('abortTurn aborts the controller with the given reason', async () => {
    const { signal } = beginTurn('s1');
    expect(signal.aborted).toBe(false);
    abortTurn('s1', 'user');
    expect(signal.aborted).toBe(true);
    // Reason is wrapped in Error with a stable message format.
    const reason = signal.reason as Error;
    expect(reason).toBeInstanceOf(Error);
    expect(reason.message).toContain('turn interrupted: user');
    // Registration was dropped — getCurrentTurnSignal no longer sees it.
    expect(getCurrentTurnSignal()).toBeUndefined();
  });

  it('endTurn drops registration without aborting', () => {
    const { signal } = beginTurn('s1');
    endTurn('s1');
    expect(signal.aborted).toBe(false);
    expect(getCurrentTurnSignal()).toBeUndefined();
  });

  it('endTurn / abortTurn on unknown session is a no-op', () => {
    expect(() => endTurn('nope')).not.toThrow();
    expect(() => abortTurn('nope', 'user')).not.toThrow();
    expect(getCurrentTurnSignal()).toBeUndefined();
  });

  it('nested begin: getCurrentTurnSignal returns the most recently begun turn', () => {
    const a = beginTurn('s1');
    const b = beginTurn('s2');
    expect(getCurrentTurnSignal()).toBe(b.signal);
    endTurn('s2');
    // After s2 ends, s1 is the current turn again.
    expect(getCurrentTurnSignal()).toBe(a.signal);
    endTurn('s1');
    expect(getCurrentTurnSignal()).toBeUndefined();
  });

  it('aborting one session does not affect another', () => {
    const a = beginTurn('s1');
    const b = beginTurn('s2');
    abortTurn('s1', 'user');
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    // s2 is still the current turn; s1's slot was cleared on abort.
    expect(getCurrentTurnSignal()).toBe(b.signal);
  });

  it('beginTurn on a session that already has a turn replaces the slot', () => {
    const first = beginTurn('s1');
    const second = beginTurn('s1');
    // Old controller is abandoned, NOT aborted (safer default — see module
    // docstring rationale).
    expect(first.signal.aborted).toBe(false);
    expect(getCurrentTurnSignal()).toBe(second.signal);
    abortTurn('s1', 'user');
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.aborted).toBe(false);
  });

  it('empty sessionId yields a never-aborting signal and skips registration', () => {
    const { signal } = beginTurn('');
    expect(signal.aborted).toBe(false);
    // No-op slot: getCurrentTurnSignal still returns undefined.
    expect(getCurrentTurnSignal()).toBeUndefined();
    abortTurn('', 'user');
    expect(signal.aborted).toBe(false);
  });
});

describe('cancellableFetch + turn signal hookup', () => {
  it('aborts a hung fetch via abortTurn within a few ms', async () => {
    beginTurn('s1');
    const turnSignal = getCurrentTurnSignal();
    expect(turnSignal).toBeDefined();

    // Stand-in for `fetch(url, { signal })` — never resolves. We use
    // `cancellableFetch`'s codepath shape by handing a fake fetch via the
    // op argument is NOT exposed; instead test withAbortSignal directly with
    // a hung op that mirrors fetch's signal-abort behaviour.
    //
    // The ~50ms budget is the contract every tool migration relies on:
    // a stop button must release in-flight bridge / API fetches well under
    // any per-call timeoutMs (15s / 30s / API_TIMEOUT_MS).
    const start = Date.now();
    const hung = (async () => {
      // Reuse cancellableFetch's wrapper by passing parentSignal=turnSignal
      // and an AbortError-compliant fake op. We do that via the real
      // primitive: a fetch to a port that drops connections is fragile in
      // CI; instead we simulate the fetch.signal contract directly.
      const ac = new AbortController();
      const onParent = (): void => ac.abort(turnSignal!.reason);
      if (turnSignal!.aborted) onParent();
      else turnSignal!.addEventListener('abort', onParent, { once: true });
      try {
        await new Promise<void>((_, reject) => {
          ac.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      } finally {
        turnSignal!.removeEventListener('abort', onParent);
      }
    })();

    // Schedule the abort on the next tick.
    setImmediate(() => abortTurn('s1', 'user'));

    await expect(hung).rejects.toThrow(/abort/i);
    const elapsed = Date.now() - start;
    // Generous bound: the Vitest event loop is busy with tracking, but the
    // observable cancel-time should still be well under 200ms.
    expect(elapsed).toBeLessThan(200);
  });

  it('cancellableFetch with parentSignal=getCurrentTurnSignal aborts on turn abort', async () => {
    // Real fetch test: connect-then-hang server. We use a raw net.Server
    // that accepts the connection but never writes a response. fetch then
    // hangs on the body read until aborted.
    const { createServer } = await import('net');
    const server = createServer((sock) => {
      // Drain inbound bytes (the request) so the kernel doesn't backpressure
      // the client write; never reply.
      sock.on('data', () => { /* discard */ });
      sock.on('error', () => { /* ignore */ });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      server.close();
      throw new Error('failed to bind test server');
    }
    const url = `http://127.0.0.1:${addr.port}/`;

    try {
      beginTurn('s1');
      const start = Date.now();
      const fetchPromise = cancellableFetch(
        url,
        undefined,
        { timeoutMs: 30_000, parentSignal: getCurrentTurnSignal() },
      );
      // Schedule abort after the fetch has had a chance to dispatch.
      setTimeout(() => abortTurn('s1', 'user'), 20);
      await expect(fetchPromise).rejects.toThrow();
      const elapsed = Date.now() - start;
      // The abort must release the fetch FAR before the 30s ceiling.
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
