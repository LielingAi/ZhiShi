import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type EscalatableProcess,
  killWithEscalation,
} from '../utils/kill-with-escalation';

class FakeProcess implements EscalatableProcess {
  readonly pid = 12345;
  exited = false;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  private waiters: Array<() => void> = [];

  constructor(private readonly exitOnSignal?: NodeJS.Signals) {}

  kill(signal?: NodeJS.Signals | number): void {
    this.signals.push(signal);
    if (signal === this.exitOnSignal) {
      this.resolveExit();
    }
  }

  waitForExit(): Promise<number> {
    if (this.exited) return Promise.resolve(0);
    return new Promise((resolve) => {
      this.waiters.push(() => resolve(0));
    });
  }

  private resolveExit(): void {
    this.exited = true;
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((resolve) => resolve());
  }
}

describe('killWithEscalation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns after graceful termination', async () => {
    const proc = new FakeProcess('SIGTERM');

    const result = await killWithEscalation(proc, {
      gracefulMs: 1000,
      hardMs: 1000,
    });

    expect(result.exited).toBe(true);
    expect(result.orphanRisk).toBe(false);
    expect(result.signalUsed).toBe('graceful');
    expect(proc.signals).toEqual(['SIGTERM']);
  });

  it('escalates to hard termination when graceful timeout expires', async () => {
    vi.useFakeTimers();
    const proc = new FakeProcess('SIGKILL');

    const resultPromise = killWithEscalation(proc, {
      gracefulMs: 1000,
      hardMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(result.exited).toBe(true);
    expect(result.orphanRisk).toBe(false);
    expect(result.signalUsed).toBe('hard');
    expect(proc.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('returns orphan risk when both deadlines expire', async () => {
    vi.useFakeTimers();
    const proc = new FakeProcess();
    const steps: string[] = [];

    const resultPromise = killWithEscalation(proc, {
      gracefulMs: 1000,
      hardMs: 500,
      onStep: (step) => steps.push(step),
    });

    await vi.advanceTimersByTimeAsync(1500);
    const result = await resultPromise;

    expect(result).toMatchObject({
      exited: false,
      signalUsed: 'hard',
      orphanRisk: true,
    });
    expect(result.elapsedMs).toBe(1500);
    expect(proc.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(steps).toEqual(['graceful', 'hard', 'orphan']);
  });
});
