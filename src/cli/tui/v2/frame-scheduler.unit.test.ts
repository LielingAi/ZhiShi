// Unit tests for the frame scheduler (~16ms coalescing, flush, dispose).
import { describe, expect, it, vi } from 'vitest';

import { FrameScheduler, type TimerApi } from './frame-scheduler';

class ManualTimer implements TimerApi {
  private queue = new Map<number, () => void>();
  private seq = 0;
  setTimeout(fn: () => void, _ms: number): unknown {
    const h = ++this.seq;
    this.queue.set(h, fn);
    return h;
  }
  clearTimeout(handle: unknown): void {
    this.queue.delete(handle as number);
  }
  runAll(): void {
    const fns = [...this.queue.values()];
    this.queue.clear();
    for (const fn of fns) fn();
  }
  get pending(): number {
    return this.queue.size;
  }
}

describe('FrameScheduler', () => {
  it('coalesces any number of requests into one frame', () => {
    const timer = new ManualTimer();
    const onFrame = vi.fn();
    const s = new FrameScheduler(onFrame, { timer });
    s.request();
    s.request();
    s.request();
    expect(onFrame).not.toHaveBeenCalled();
    expect(timer.pending).toBe(1);
    timer.runAll();
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it('can schedule again after a frame fired', () => {
    const timer = new ManualTimer();
    const onFrame = vi.fn();
    const s = new FrameScheduler(onFrame, { timer });
    s.request();
    timer.runAll();
    s.request();
    timer.runAll();
    expect(onFrame).toHaveBeenCalledTimes(2);
  });

  it('flush() runs the frame immediately and cancels the pending one', () => {
    const timer = new ManualTimer();
    const onFrame = vi.fn();
    const s = new FrameScheduler(onFrame, { timer });
    s.request();
    s.flush();
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(timer.pending).toBe(0);
    timer.runAll(); // nothing left to fire
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it('flush() with nothing pending still paints (optimistic path)', () => {
    const timer = new ManualTimer();
    const onFrame = vi.fn();
    const s = new FrameScheduler(onFrame, { timer });
    s.flush();
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it('dispose() cancels pending and blocks further frames', () => {
    const timer = new ManualTimer();
    const onFrame = vi.fn();
    const s = new FrameScheduler(onFrame, { timer });
    s.request();
    s.dispose();
    expect(timer.pending).toBe(0);
    s.request();
    s.flush();
    timer.runAll();
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('reports scheduled state', () => {
    const timer = new ManualTimer();
    const s = new FrameScheduler(() => {}, { timer });
    expect(s.scheduled).toBe(false);
    s.request();
    expect(s.scheduled).toBe(true);
    timer.runAll();
    expect(s.scheduled).toBe(false);
  });

  it('uses the real timer by default (16ms window)', async () => {
    vi.useFakeTimers();
    try {
      const onFrame = vi.fn();
      const s = new FrameScheduler(onFrame);
      s.request();
      s.request();
      await vi.advanceTimersByTimeAsync(16);
      expect(onFrame).toHaveBeenCalledTimes(1);
      s.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
