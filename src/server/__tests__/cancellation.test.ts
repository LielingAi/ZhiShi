/**
 * Pattern 1 — cancellation helpers unit tests.
 *
 * Covers:
 *  (a) withAbortSignal aborts inner op when outer signal fires; outer signal preserved
 *  (b) withAbortSignal enforces timeoutMs even if op never settles
 *  (c) cancellableDelay rejects with AbortError on signal
 *  (d) anySignal aborts when any input signal aborts; doesn't abort others
 *  (e) withBoundedTimeout calls onTimeout and resolves to undefined; doesn't reject
 *
 * NOTE: the "/chat/stream last consumer disconnect → grace → interrupt" flow that
 * an earlier revision of this comment referenced has been REMOVED. SSE disconnect
 * is no longer a turn-cancellation authority — turn lifecycle belongs to the Rust
 * sidecar Owner model (see the load-bearing comment in `src/server/index.ts` at
 * the `/chat/stream` handler). There is therefore nothing to integration-test here.
 */

import { describe, expect, it } from 'vitest';

import {
  anySignal,
  cancellableDelay,
  withAbortSignal,
  withBoundedTimeout,
} from '../utils/cancellation';

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

describe('cancellableDelay', () => {
  it('resolves after ms with no signal', async () => {
    const start = Date.now();
    await cancellableDelay(40);
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  });

  it('rejects with AbortError on signal', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10);
    await expect(cancellableDelay(10_000, ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects synchronously when signal already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(cancellableDelay(10_000, ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('anySignal', () => {
  it('aborts when any input signal aborts; the others are unaffected', () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = anySignal([a.signal, b.signal]);
    expect(merged.aborted).toBe(false);

    a.abort();
    expect(merged.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
  });

  it('returns a never-aborting signal when all inputs are undefined', () => {
    const merged = anySignal([undefined, undefined]);
    expect(merged.aborted).toBe(false);
  });

  it('returns the single input as-is when only one provided', () => {
    const a = new AbortController();
    const merged = anySignal([undefined, a.signal, undefined]);
    expect(merged).toBe(a.signal);
  });

  it('is already aborted if any input is already aborted', () => {
    const a = new AbortController();
    a.abort();
    const b = new AbortController();
    const merged = anySignal([a.signal, b.signal]);
    expect(merged.aborted).toBe(true);
  });
});

describe('withBoundedTimeout', () => {
  it('returns undefined and calls onTimeout after deadline; never rejects', async () => {
    let onTimeoutCalls = 0;
    const stuck = new Promise<string>(() => { /* never settles */ });
    const result = await withBoundedTimeout(stuck, 30, () => { onTimeoutCalls++; });
    expect(result).toBeUndefined();
    expect(onTimeoutCalls).toBe(1);
  });

  it('returns the inner value when it resolves before timeout', async () => {
    const fast = Promise.resolve('hello');
    const result = await withBoundedTimeout(fast, 1000, () => { throw new Error('should not fire'); });
    expect(result).toBe('hello');
  });

  it('translates inner rejection to undefined silently (never rejects)', async () => {
    const failing = Promise.reject(new Error('inner failed'));
    let onTimeoutCalls = 0;
    const result = await withBoundedTimeout(failing, 1000, () => { onTimeoutCalls++; });
    expect(result).toBeUndefined();
    expect(onTimeoutCalls).toBe(0);
  });
});
