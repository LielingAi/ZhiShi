/**
 * Frame scheduler (design-spec §9: ~16ms 合帧).
 *
 * rAF-style coalescing: any number of `request()` calls inside one frame
 * window collapse into a single `onFrame` invocation — high-frequency
 * appends (streaming chunks) produce one screen update, not forty.
 * `flush()` forces a frame NOW (Esc optimistic insert can't wait 16ms).
 *
 * Timers are injectable so tests run without real time; default is the
 * global setTimeout/clearTimeout.
 */

export interface TimerApi {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface FrameSchedulerOptions {
  /** Coalescing window in ms (default 16 ≈ 60fps). */
  frameMs?: number;
  timer?: TimerApi;
}

const globalTimer: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class FrameScheduler {
  private readonly onFrame: () => void;
  private readonly frameMs: number;
  private readonly timer: TimerApi;
  private pending: unknown = null;
  private disposed = false;

  constructor(onFrame: () => void, opts: FrameSchedulerOptions = {}) {
    this.onFrame = onFrame;
    this.frameMs = Math.max(1, opts.frameMs ?? 16);
    this.timer = opts.timer ?? globalTimer;
  }

  /** Schedule a frame; no-op if one is already pending (that's the merge). */
  request(): void {
    if (this.disposed || this.pending !== null) return;
    this.pending = this.timer.setTimeout(() => {
      this.pending = null;
      this.onFrame();
    }, this.frameMs);
  }

  /** Run the frame immediately, cancelling any pending one. */
  flush(): void {
    if (this.pending !== null) {
      this.timer.clearTimeout(this.pending);
      this.pending = null;
    }
    if (!this.disposed) this.onFrame();
  }

  get scheduled(): boolean {
    return this.pending !== null;
  }

  dispose(): void {
    if (this.pending !== null) {
      this.timer.clearTimeout(this.pending);
      this.pending = null;
    }
    this.disposed = true;
  }
}
