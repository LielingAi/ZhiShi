import { describe, expect, it } from 'vitest';

import { InactivityWatchdog } from './inactivity-watchdog';

const INTERVAL = 30 * 1000;

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

describe('InactivityWatchdog dynamic timeout', () => {
  it('can extend the timeout without resetting the idle clock', () => {
    const clock = fakeClock();
    const wd = new InactivityWatchdog({ timeoutMs: 10 * 60 * 1000, intervalMs: INTERVAL, now: clock.now });

    for (let i = 0; i < 10; i++) {
      clock.advance(INTERVAL);
      expect(wd.evaluateTick().fire).toBe(false);
    }

    wd.setTimeoutMs(30 * 60 * 1000);

    for (let i = 0; i < 30; i++) {
      clock.advance(INTERVAL);
      expect(wd.evaluateTick().fire).toBe(false);
    }

    expect(wd.idleMs()).toBe(20 * 60 * 1000);
  });
});
