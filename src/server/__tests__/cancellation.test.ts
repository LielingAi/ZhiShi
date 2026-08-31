/**
 * Pattern 1 — cancellation helpers unit tests.
 *
 * Covers:
 *  (a) withAbortSignal aborts inner op when outer signal fires; outer signal preserved
 *  (b) withAbortSignal enforces timeoutMs even if op never settles
 *
 * NOTE: the "/chat/stream last consumer disconnect → grace → interrupt" flow that
 * an earlier revision of this comment referenced has been REMOVED. SSE disconnect
 * is no longer a turn-cancellation authority — turn lifecycle belongs to the Rust
 * sidecar Owner model (see the load-bearing comment in `src/server/index.ts` at
 * the `/chat/stream` handler). There is therefore nothing to integration-test here.
 */

import { describe, expect, it } from 'vitest';

import { withAbortSignal } from '../utils/cancellation';

describe('withAbortSignal', () => {
  it('aborts inner op when outer signal fires; outer signal preserved', async () => {
    const outer = new AbortController();
    let innerSignal: AbortSignal | undefined;
    let abortReason: string | undefined;

    const opPromise = withAbortSignal(
      outer.signal,
      (signal) => {
        innerSignal = signal;
        return new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('inner-aborted')));
        });
      },
      { onAbort: (reason) => { abortReason = reason; } },
    );

    // Allow op to register its listener.
    await new Promise((r) => setImmediate(r));
    expect(innerSignal?.aborted).toBe(false);
    expect(outer.signal.aborted).toBe(false);

    outer.abort();

    await expect(opPromise).rejects.toThrow('inner-aborted');
    expect(innerSignal?.aborted).toBe(true);
    // Outer signal is owned by the caller — must remain a live AbortController,
    // not consumed/destroyed by the helper.
    expect(outer.signal.aborted).toBe(true); // outer is what we just aborted
    expect(abortReason).toBe('user');
  });

  it('passes through op result when nothing aborts', async () => {
    const result = await withAbortSignal(undefined, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('enforces timeoutMs even if op never settles', async () => {
    let abortReason: string | undefined;

    const start = Date.now();
    await expect(
      withAbortSignal(
        undefined,
        (signal) =>
          new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('timed-out-inner')));
          }),
        { timeoutMs: 50, onAbort: (r) => { abortReason = r; } },
      ),
    ).rejects.toThrow('timed-out-inner');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(500);
    expect(abortReason).toBe('timeout');
  });

  it('does not call onAbort when op settles before any abort', async () => {
    let abortReason: string | undefined;
    const result = await withAbortSignal(
      undefined,
      async () => 'fast',
      { timeoutMs: 1000, onAbort: (r) => { abortReason = r; } },
    );
    expect(result).toBe('fast');
    expect(abortReason).toBeUndefined();
  });

  it('immediately aborts inner if parent signal already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let innerAborted = false;
    await expect(
      withAbortSignal(ctrl.signal, (signal) => {
        innerAborted = signal.aborted;
        return Promise.reject(new Error('n/a'));
      }),
    ).rejects.toThrow('n/a');
    expect(innerAborted).toBe(true);
  });
});
