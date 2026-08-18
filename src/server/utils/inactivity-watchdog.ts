/**
 * Suspension-aware inactivity watchdog timing.
 *
 * WHY THIS EXISTS — the bug it fixes:
 * A turn-inactivity watchdog that fires when `Date.now() - lastActivity >
 * timeout` counts wall-clock time during which the *process itself was not
 * running* — macOS system sleep, App Nap throttling, SIGSTOP, a debugger pause
 * — as "inactivity". On resume the elapsed delta jumps past the timeout and the
 * watchdog false-fires, killing a turn that was never actually hung. Real Mac
 * incidents: long tasks "突然自动中止" with "响应超时（10 分钟无活动）" right after
 * the laptop slept or the app was backgrounded.
 *
 * THE FIX — tick-gap detection (clock-source agnostic):
 * Drive the check from a fixed-interval tick. Between two consecutive ticks the
 * gap should be ~`intervalMs`. A gap far larger than that means *our own timer
 * did not run* — i.e. the process was suspended. That excess wall-clock is NOT
 * active inactivity, so it is credited back to the activity clock. This is
 * deliberately NOT based on a monotonic clock (`performance.now()` /
 * `process.hrtime`): those still advance during App Nap throttling while the
 * system is awake, whereas observing "my timer didn't fire" catches every
 * suspension mode uniformly.
 *
 * The watchdog therefore measures only time the process was actually running,
 * so it fires only on genuine API/tool hangs — never on sleep/App Nap.
 *
 * Pure and dependency-free (clock injectable) so the firing logic is unit
 * testable without real timers. See inactivity-watchdog.test.ts.
 */
export interface InactivityWatchdogOptions {
  /** Fire after this much ACTIVE (non-suspended) inactivity. */
  timeoutMs: number;
  /** The cadence the owner calls `evaluateTick()` at. */
  intervalMs: number;
  /**
   * A tick gap ≥ this is treated as a process suspension and credited.
   * Default `2 × intervalMs`: a timer running normally cannot skip a whole
   * interval, so a ≥2× gap is unambiguously "the process wasn't running".
   * Keeping it at 2× means normal scheduling jitter and sub-interval
   * event-loop blocking still count as real (active) inactivity.
   */
  suspensionGapMs?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface WatchdogTickResult {
  /** True iff `timeoutMs` of ACTIVE inactivity has elapsed. */
  fire: boolean;
  /** Suspension credited on this tick (ms), or 0. For diagnostics/logging. */
  suspendedMs: number;
}

export class InactivityWatchdog {
  private lastActivityAt: number;
  private lastTickAt: number;
  private timeoutMs: number;
  private readonly intervalMs: number;
  private readonly suspensionGapMs: number;
  private readonly now: () => number;

  constructor(opts: InactivityWatchdogOptions) {
    this.timeoutMs = opts.timeoutMs;
    this.intervalMs = opts.intervalMs;
    this.suspensionGapMs = opts.suspensionGapMs ?? opts.intervalMs * 2;
    this.now = opts.now ?? Date.now;
    const t = this.now();
    this.lastActivityAt = t;
    this.lastTickAt = t;
  }

  /** Record activity (call on each SDK/runtime event). Resets the idle clock. */
  markActivity(): void {
    this.lastActivityAt = this.now();
  }

  /** Adjust the active inactivity budget without resetting the idle clock. */
  setTimeoutMs(timeoutMs: number): void {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Invalid watchdog timeout: ${timeoutMs}`);
    }
    this.timeoutMs = timeoutMs;
  }

  /** Re-baseline both clocks (call at turn start). */
  reset(): void {
    const t = this.now();
    this.lastActivityAt = t;
    this.lastTickAt = t;
  }

  /**
   * Call exactly once per `intervalMs` tick. Credits any detected suspension
   * (so it is not counted as inactivity), then reports whether the active
   * inactivity timeout has elapsed.
   */
  evaluateTick(): WatchdogTickResult {
    const now = this.now();
    const tickGap = now - this.lastTickAt;
    this.lastTickAt = now;

    let suspendedMs = 0;
    if (tickGap >= this.suspensionGapMs) {
      // The interval timer did not run on schedule → the process was suspended
      // (sleep / App Nap / freeze) for `tickGap`. Everything beyond one normal
      // interval is suspended time; credit it so it is not seen as inactivity.
      suspendedMs = tickGap - this.intervalMs;
      this.lastActivityAt += suspendedMs;
      // Defensive clamp — the activity clock must never move into the future.
      if (this.lastActivityAt > now) this.lastActivityAt = now;
    }

    return { fire: now - this.lastActivityAt > this.timeoutMs, suspendedMs };
  }

  /** Active (suspension-credited) idle time in ms. */
  idleMs(): number {
    return this.now() - this.lastActivityAt;
  }
}
