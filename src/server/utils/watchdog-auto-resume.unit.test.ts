import { describe, expect, it } from 'vitest';

import {
  planWatchdogAutoResume,
  shouldAdoptPendingContinueIntoScheduledAutoResume,
  shouldConsumePendingContinueAfterAbort,
  shouldDeferPendingContinueToScheduledAutoResume,
  shouldPrependWatchdogAutoResume,
} from './watchdog-auto-resume';

describe('watchdog auto-resume policy', () => {
  it('marks and schedules auto-resume for a substantive watchdog abort', () => {
    expect(planWatchdogAutoResume({
      turnHadSubstantiveActivity: true,
      alreadyAutoResumed: false,
    })).toEqual({
      persistPendingContinue: true,
      scheduleAutoResume: true,
    });
  });

  it('does not schedule auto-resume for an empty watchdog abort', () => {
    expect(planWatchdogAutoResume({
      turnHadSubstantiveActivity: false,
      alreadyAutoResumed: false,
    })).toEqual({
      persistPendingContinue: false,
      scheduleAutoResume: false,
    });
  });

  it('does not re-arm a session after this process already injected auto-resume', () => {
    expect(planWatchdogAutoResume({
      turnHadSubstantiveActivity: true,
      alreadyAutoResumed: true,
    })).toEqual({
      persistPendingContinue: false,
      scheduleAutoResume: false,
    });
  });

  it('allows pending-flag fallback only when not already consuming or capped', () => {
    expect(shouldConsumePendingContinueAfterAbort({
      pendingContinueAfterAbort: true,
      consuming: false,
      alreadyAutoResumed: false,
      deferToScheduledAutoResume: false,
    })).toBe(true);

    expect(shouldConsumePendingContinueAfterAbort({
      pendingContinueAfterAbort: true,
      consuming: true,
      alreadyAutoResumed: false,
      deferToScheduledAutoResume: false,
    })).toBe(false);

    expect(shouldConsumePendingContinueAfterAbort({
      pendingContinueAfterAbort: true,
      consuming: false,
      alreadyAutoResumed: true,
      deferToScheduledAutoResume: false,
    })).toBe(false);

    expect(shouldConsumePendingContinueAfterAbort({
      pendingContinueAfterAbort: false,
      consuming: false,
      alreadyAutoResumed: false,
      deferToScheduledAutoResume: false,
    })).toBe(false);

    expect(shouldConsumePendingContinueAfterAbort({
      pendingContinueAfterAbort: true,
      consuming: false,
      alreadyAutoResumed: false,
      deferToScheduledAutoResume: true,
    })).toBe(false);
  });

  it('prepends watchdog auto-resume after teardown so rescued queued work stays behind it', () => {
    expect(shouldPrependWatchdogAutoResume({ sessionActive: false, sessionTerminating: false })).toBe(true);
    expect(shouldPrependWatchdogAutoResume({ sessionActive: true, sessionTerminating: false })).toBe(false);
    expect(shouldPrependWatchdogAutoResume({ sessionActive: true, sessionTerminating: true })).toBe(true);
  });

  it('defers next-enqueue fallback while watchdog auto-resume still owns the pending flag', () => {
    expect(shouldDeferPendingContinueToScheduledAutoResume({
      trigger: 'next-enqueue',
      scheduledAutoResume: false,
    })).toBe(false);

    expect(shouldDeferPendingContinueToScheduledAutoResume({
      trigger: 'next-enqueue',
      scheduledAutoResume: true,
    })).toBe(true);

    expect(shouldDeferPendingContinueToScheduledAutoResume({
      trigger: 'next-enqueue',
      scheduledAutoResume: false,
    })).toBe(false);

    expect(shouldDeferPendingContinueToScheduledAutoResume({
      trigger: 'watchdog-auto',
      scheduledAutoResume: true,
    })).toBe(false);
  });

  it('adopts crash fallback into scheduled auto-resume when a session is already terminating', () => {
    expect(shouldAdoptPendingContinueIntoScheduledAutoResume({
      trigger: 'next-enqueue',
      pendingContinueAfterAbort: true,
      sessionTerminating: true,
      consuming: false,
      alreadyAutoResumed: false,
      scheduledAutoResume: false,
    })).toBe(true);

    expect(shouldAdoptPendingContinueIntoScheduledAutoResume({
      trigger: 'next-enqueue',
      pendingContinueAfterAbort: true,
      sessionTerminating: false,
      consuming: false,
      alreadyAutoResumed: false,
      scheduledAutoResume: false,
    })).toBe(false);

    expect(shouldAdoptPendingContinueIntoScheduledAutoResume({
      trigger: 'watchdog-auto',
      pendingContinueAfterAbort: true,
      sessionTerminating: true,
      consuming: false,
      alreadyAutoResumed: false,
      scheduledAutoResume: false,
    })).toBe(false);

    expect(shouldAdoptPendingContinueIntoScheduledAutoResume({
      trigger: 'next-enqueue',
      pendingContinueAfterAbort: true,
      sessionTerminating: true,
      consuming: false,
      alreadyAutoResumed: false,
      scheduledAutoResume: true,
    })).toBe(false);
  });
});
