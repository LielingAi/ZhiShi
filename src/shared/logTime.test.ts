import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';

import { localDate, localTimestamp } from './logTime';

// The red line these guard: unified-log filenames + timestamps MUST use the
// LOCAL date, never UTC `toISOString().split('T')[0]`. In UTC+8 the UTC date is
// the PREVIOUS calendar day for ~1/3 of every day, so a naive UTC date scatters
// "today's" logs across two files and breaks "grep today's date".
//
// Pin TZ to Asia/Shanghai (UTC+8) so the local-vs-UTC distinction is
// deterministic regardless of where the test runs (dev machine / CI).
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => { process.env.TZ = 'Asia/Shanghai'; });
afterAll(() => { process.env.TZ = ORIGINAL_TZ; });
afterEach(() => { vi.useRealTimers(); });

describe('logTime — local (not UTC) date/time', () => {
  it('localDate() returns the LOCAL date, which differs from the UTC date late in the UTC day', () => {
    vi.useFakeTimers();
    // 2026-02-28 16:30 UTC === 2026-03-01 00:30 in Asia/Shanghai.
    vi.setSystemTime(new Date('2026-02-28T16:30:00Z'));
    expect(localDate()).toBe('2026-03-01'); // local date
    expect(localDate()).not.toBe('2026-02-28'); // would be the UTC date — the bug
  });

  it('localTimestamp() formats local wall-clock with millisecond precision', () => {
    vi.useFakeTimers();
    // 2026-02-28 16:30:40.826 UTC === 2026-03-01 00:30:40.826 +08.
    vi.setSystemTime(new Date('2026-02-28T16:30:40.826Z'));
    expect(localTimestamp()).toBe('2026-03-01 00:30:40.826');
  });

  it('zero-pads month, day, and every time component', () => {
    vi.useFakeTimers();
    // 2026-01-05 01:02:03.004 UTC === 2026-01-05 09:02:03.004 +08 (same day).
    vi.setSystemTime(new Date('2026-01-05T01:02:03.004Z'));
    expect(localDate()).toBe('2026-01-05');
    expect(localTimestamp()).toBe('2026-01-05 09:02:03.004');
  });
});
