export const WATCHDOG_RESUME_REMINDER =
  '<system-reminder>The previous turn was aborted by the inactivity watchdog (10-minute timeout). Resume from existing context and complete the unfinished task.</system-reminder>';

export interface WatchdogAutoResumePlanInput {
  turnHadSubstantiveActivity: boolean;
  alreadyAutoResumed: boolean;
}

export interface WatchdogAutoResumePlan {
  persistPendingContinue: boolean;
  scheduleAutoResume: boolean;
}

/**
 * Decide what a watchdog-fired abort should do with the resume reminder.
 *
 * A substantive turn gets both:
 *   1. a durable pending flag, so sidecar death still has a next-enqueue fallback;
 *   2. an immediate auto-resume schedule, so no user message is needed to trigger it.
 *
 * The per-process cap prevents reminder -> watchdog -> reminder loops.
 */
export function planWatchdogAutoResume(input: WatchdogAutoResumePlanInput): WatchdogAutoResumePlan {
  if (!input.turnHadSubstantiveActivity || input.alreadyAutoResumed) {
    return {
      persistPendingContinue: false,
      scheduleAutoResume: false,
    };
  }
  return {
    persistPendingContinue: true,
    scheduleAutoResume: true,
  };
}

export interface PendingContinueConsumeInput {
  pendingContinueAfterAbort?: boolean;
  consuming: boolean;
  alreadyAutoResumed: boolean;
  deferToScheduledAutoResume: boolean;
}

export function shouldConsumePendingContinueAfterAbort(input: PendingContinueConsumeInput): boolean {
  return Boolean(input.pendingContinueAfterAbort)
    && !input.consuming
    && !input.alreadyAutoResumed
    && !input.deferToScheduledAutoResume;
}

export interface PendingContinueDeferralInput {
  trigger: 'next-enqueue' | 'watchdog-auto';
  scheduledAutoResume: boolean;
}

export function shouldDeferPendingContinueToScheduledAutoResume(input: PendingContinueDeferralInput): boolean {
  return input.trigger === 'next-enqueue'
    && input.scheduledAutoResume;
}

export interface PendingContinueAdoptionInput {
  trigger: 'next-enqueue' | 'watchdog-auto';
  pendingContinueAfterAbort: boolean;
  sessionTerminating: boolean;
  consuming: boolean;
  alreadyAutoResumed: boolean;
  scheduledAutoResume: boolean;
}

export function shouldAdoptPendingContinueIntoScheduledAutoResume(input: PendingContinueAdoptionInput): boolean {
  return input.trigger === 'next-enqueue'
    && input.pendingContinueAfterAbort
    && input.sessionTerminating
    && !input.consuming
    && !input.alreadyAutoResumed
    && !input.scheduledAutoResume;
}

export interface WatchdogAutoResumeDispatchInput {
  sessionActive: boolean;
  sessionTerminating: boolean;
}

export function shouldPrependWatchdogAutoResume(input: WatchdogAutoResumeDispatchInput): boolean {
  return input.sessionTerminating || !input.sessionActive;
}
