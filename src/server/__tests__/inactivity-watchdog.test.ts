/**
 * Unit tests for the suspension-aware inactivity watchdog.
 *
 * The whole point of the primitive is that process suspension (macOS sleep /
 * App Nap) must NOT count as inactivity. These tests drive a fake clock so we
 * can simulate "the timer didn't run for an hour because the laptop slept"
 * deterministically, without real timers.
 */
import { describe, expect, it } from 'vitest';

import { InactivityWatchdog } from '../utils/inactivity-watchdog';

const TIMEOUT = 10 * 60 * 1000; // 10 min
const INTERVAL = 30 * 1000; // 30 s

/** A controllable clock. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

describe('InactivityWatchdog', () => {
  it('does not fire while ticks arrive on schedule with periodic activity', () => {
    const clock = fakeClock();
    const wd = new InactivityWatchdog({ timeoutMs: TIMEOUT, intervalMs: INTERVAL, now: clock.now });
    // 20 minutes of normal ticks, with activity every 2 minutes.
    for (let i = 0; i < 40; i++) {
      clock.advance(INTERVAL);
      const { fire, suspendedMs } = wd.evaluateTick();
      expect(suspendedMs).toBe(0); // on-schedule ticks → no suspension credit
      expect(fire).toBe(false);
      if (i % 4 === 3) wd.markActivity(); // activity every ~2 min
    }
  });

  it('fires after timeoutMs of genuine active inactivity (real hang)', () => {
    const clock = fakeClock();
    const wd = new InactivityWatchdog({ timeoutMs: TIMEOUT, intervalMs: INTERVAL, now: clock.now });
    wd.markActivity();
    let fired = false;
    // No activity, ticks on schedule — should fire just after 10 min.
    for (let i = 0; i < 25 && !fired; i++) {
      clock.advance(INTERVAL);
      fired = wd.evaluateTick().fire;
    }
    expect(fired).toBe(true);
    // Should have fired right after the 10-min mark (≤ 21 ticks = 10.5 min).
  });

  it('does NOT fire when a long suspension (sleep) elapses between two ticks', () => {
    const clock = fakeClock();
    const wd = new InactivityWatchdog({ timeoutMs: TIMEOUT, intervalMs: INTERVAL, now: clock.now });
    wd.markActivity();

    // One normal tick (30s active, no hang).
    clock.advance(INTERVAL);
    expect(wd.evaluateTick().fire).toBe(false);

    // Laptop sleeps for 1 hour: the timer doesn't run, then resumes.
    clock.advance(60 * 60 * 1000);
    const resumeTick = wd.evaluateTick();
    // The hour of sleep is credited as suspension, NOT inactivity.
    expect(resumeTick.suspendedMs).toBeGreaterThan(59 * 60 * 1000);
    expect(resumeTick.fire).toBe(false); // <-- the bug this fixes

    // After resume the turn still has its remaining active budget.
    // Another ~9.5 min of on-schedule no-activity ticks must NOT fire yet...
    let fired = false;
    for (let i = 0; i < 18 && !fired; i++) {
      clock.advance(INTERVAL);
      fired = wd.evaluateTick().fire;
    }
    expect(fired).toBe(false);
    // ...but eventually, with no real activity, it does fire (genuine hang).
    for (let i = 0; i < 5 && !fired; i++) {
      clock.advance(INTERVAL);
      fired = wd.evaluateTick().fire;
    }
    expect(fired).toBe(true);
  });

  it('credits suspension that happens mid-budget and preserves pre-sleep active time', () => {
    const clock = fakeClock();
    const wd = new InactivityWatchdog({ timeoutMs: TIMEOUT, intervalMs: INTERVAL, now: clock.now });
    wd.markActivity();

    // 5 minutes of active inactivity (no events), on-schedule ticks.
    for (let i = 0; i < 10; i++) {
      clock.advance(INTERVAL);
      expect(wd.evaluateTick().fire).toBe(false);
    }
    // Now sleep 2 hours mid-budget.
    clock.advance(2 * 60 * 60 * 1000);
    const resume = wd.evaluateTick();
    expect(resume.fire).toBe(false); // sleep credited, only ~5 min active so far
    expect(resume.suspendedMs).toBeGreaterThan(0);

    // Remaining active budget is ~5 min. ~4 min more → still no fire.
    let fired = false;
    for (let i = 0; i < 8 && !fired; i++) {
      clock.advance(INTERVAL);
      fired = wd.evaluateTick().fire;
    }
    expect(fired).toBe(false);
    // Past 10 min of *active* inactivity total → fires.
    for (let i = 0; i < 6 && !fired; i++) {
      clock.advance(INTERVAL);
      fired = wd.evaluateTick().fire;
    }
    expect(fired).toBe(true);
  });

  it('markActivity after resume gives a fresh full budget', () => {
    const clock = fakeClock();
    const wd = new InactivityWatchdog({ timeoutMs: TIMEOUT, intervalMs: INTERVAL, now: clock.now });
    // Sleep a long time, then resume and immediately get a real SDK event.
    clock.advance(3 * 60 * 60 * 1000);
    expect(wd.evaluateTick().fire).toBe(false);
    wd.markActivity(); // event arrived after wake

    // Now 9.5 min of no activity → no fire.
    let fired = false;
    for (let i = 0; i < 19 && !fired; i++) {
      clock.advance(INTERVAL);
      fired = wd.evaluateTick().fire;
    }
    expect(fired).toBe(false);
  });

  it('does not fire across a long human wait when the owner pauses it each tick (High-2)', () => {
    // Models the watchdog gate for interactive turns: while a permission prompt
    // / AskUserQuestion / plan approval is pending, the owner re-baselines the
    // idle clock every tick (markActivity) instead of letting it count down, so
    // the user's think time is never mistaken for a hung turn.
    const clock = fakeClock();
    const wd = new InactivityWatchdog({ timeoutMs: TIMEOUT, intervalMs: INTERVAL, now: clock.now });
    wd.markActivity();

    // 30 minutes (3× the timeout) of the human deliberating on a prompt.
    for (let i = 0; i < 60; i++) {
      clock.advance(INTERVAL);
      const { fire } = wd.evaluateTick();
      expect(fire).toBe(false);
      wd.markActivity(); // owner: "still waiting on the human, not inactivity"
    }

    // User answers → owner stops pausing. A genuine post-answer hang must still
    // be caught: ~10 min of no activity with on-schedule ticks fires.
    let fired = false;
    for (let i = 0; i < 25 && !fired; i++) {
      clock.advance(INTERVAL);
      fired = wd.evaluateTick().fire;
    }
    expect(fired).toBe(true);
  });

  it('treats moderate scheduling jitter (sub-2x) as active inactivity, not suspension', () => {
    const clock = fakeClock();
    const wd = new InactivityWatchdog({ timeoutMs: TIMEOUT, intervalMs: INTERVAL, now: clock.now });
    wd.markActivity();
    let fired = false;
    // Ticks late by 50% (45s gaps) — event-loop pressure, NOT suspension.
    // 45s < suspensionGap (60s) so it must count fully toward inactivity.
    for (let i = 0; i < 20 && !fired; i++) {
      clock.advance(INTERVAL * 1.5);
      const r = wd.evaluateTick();
      expect(r.suspendedMs).toBe(0);
      fired = r.fire;
    }
    expect(fired).toBe(true); // ~13.5 min of jittery-but-active inactivity → fires
  });
});
