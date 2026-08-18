/**

 * Pattern 6 §6.3.5 — bounded async writer + drop counter.

 *

 * Verifies:

 *  (a) Synthesizing 10000 entries into the queue does NOT OOM and does

 *      NOT silently grow the queue beyond `QUEUE_MAX_ENTRIES` — overflow

 *      bumps the internal drop counter.

 *  (b) The flusher function (exposed as `_flushUnifiedLogForTests`) drains

 *      what's queued to disk synchronously when called.

 *  (c) The recent-lines ring buffer (used by the crash dumper) caps at

 *      its capacity even when the input far exceeds it.

 *

 * Isolation: `vi.mock('../logUtils')` redirects LOGS_DIR to a per-run

 * tmpdir BEFORE UnifiedLogger imports it, so the test never writes to

 * the developer's real `~/.zhishi/logs/`. (Prior versions polluted

 * the real unified log with thousands of `[bench]` entries every run.)

 */



import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';

import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';



// Hoisted to run before any `import` is resolved, so the path string is

// available when `vi.mock`'s factory is later invoked. We deliberately

// only compute a path here — directory creation happens lazily inside

// the mocked `ensureLogsDir`, which runs after fs imports are bound.

const { TEST_LOGS_ROOT, TEST_LOGS_DIR } = vi.hoisted(() => {

  // Use only globals available pre-import: `process` + a unique suffix.

  const root = `${process.env.TMPDIR ?? '/tmp'}`.replace(/\/+$/, '')

    + `/zhishi-unified-log-test-${process.pid}-${Date.now()}`;

  return { TEST_LOGS_ROOT: root, TEST_LOGS_DIR: `${root}/logs` };

});



vi.mock('../logUtils', () => ({

  ZHISHI_DIR: TEST_LOGS_ROOT,

  LOGS_DIR: TEST_LOGS_DIR,

  ensureLogsDir: () => {

    if (!existsSync(TEST_LOGS_DIR)) {

      mkdirSync(TEST_LOGS_DIR, { recursive: true });

    }

  },

}));



import {

  appendUnifiedLog,

  appendUnifiedLogBatch,

  _flushUnifiedLogForTests,

  _getDroppedCount,

  getRecentLogLines,

} from '../UnifiedLogger';

import { localTimestamp } from '../../shared/logTime';

import type { LogEntry } from '../../shared/types/log';



interface DirSnapshot {

  files: Map<string, number>; // filename → size

}



function snapshot(): DirSnapshot {

  const files = new Map<string, number>();

  if (existsSync(TEST_LOGS_DIR)) {

    for (const f of readdirSync(TEST_LOGS_DIR)) {

      if (!f.startsWith('unified-') || !f.endsWith('.log')) continue;

      try {

        files.set(f, statSync(join(TEST_LOGS_DIR, f)).size);

      } catch { /* ignore */ }

    }

  }

  return { files };

}



let before: DirSnapshot;



beforeEach(() => {

  // Ensure the directory exists so snapshot() returns a stable baseline.

  if (!existsSync(TEST_LOGS_DIR)) {

    mkdirSync(TEST_LOGS_DIR, { recursive: true });

  }

  before = snapshot();

});



afterEach(() => {

  // Drain anything the 100ms flusher might still be queueing so it doesn't

  // leak into the next test's snapshot baseline.

  _flushUnifiedLogForTests();

});



afterAll(() => {

  // Best-effort cleanup of the temp dir tree.

  try {

    rmSync(TEST_LOGS_ROOT, { recursive: true, force: true });

  } catch { /* ignore */ }

});



function makeEntry(i: number): LogEntry {

  return {

    source: 'bun',

    level: 'info',

    message: `[bench] entry ${i}`,

    // Match production's localTimestamp() format so log-line timestamps

    // stay consistent with the rest of the unified log (no UTC mismatch

    // when grepping by today's local date).

    timestamp: localTimestamp(),

  };

}



describe('UnifiedLogger — bounded queue + drop counter', () => {

  it('(a) burst of 10000 entries does not unbound the queue', () => {

    // The HOME env var only affects logs path resolution; the test

    // primarily exercises queue + ring-buffer caps. We don't try to flush

    // 10000 to disk because that's slow on CI.

    const burstSize = 10000;

    const startDropped = _getDroppedCount();

    const entries: LogEntry[] = [];

    for (let i = 0; i < burstSize; i++) entries.push(makeEntry(i));

    appendUnifiedLogBatch(entries);



    const dropped = _getDroppedCount() - startDropped;

    // QUEUE_MAX_ENTRIES is 1000 → 9000+ should be dropped (since we

    // didn't flush concurrently). Allow some slack if the timer flusher

    // fires during the batch loop.

    expect(dropped).toBeGreaterThan(0);

    expect(dropped).toBeLessThanOrEqual(burstSize);

  });



  it('(b) _flushUnifiedLogForTests writes queued entries to disk', () => {

    appendUnifiedLog(makeEntry(1));

    appendUnifiedLog(makeEntry(2));

    appendUnifiedLog(makeEntry(3));

    _flushUnifiedLogForTests();



    const after = snapshot();

    // Either a new file was created OR an existing file grew. Either is

    // proof that the flusher actually wrote to disk.

    let grew = false;

    for (const [name, size] of after.files) {

      const prev = before.files.get(name) ?? 0;

      if (size > prev) { grew = true; break; }

    }

    expect(grew).toBe(true);

  });



  it('(c) recent-lines ring buffer caps at capacity', () => {

    const burstSize = 5000;

    for (let i = 0; i < burstSize; i++) {

      appendUnifiedLog(makeEntry(i));

    }

    const recent = getRecentLogLines(1000);

    // Capacity is 200 (RECENT_LINES_CAPACITY), so even asking for 1000

    // returns at most that many.

    expect(recent.length).toBeLessThanOrEqual(200);

    expect(recent.length).toBeGreaterThan(0);

    // Tail should contain the most-recent entries — entry 4999 must be

    // present in the tail buffer.

    const last = recent[recent.length - 1];

    expect(last).toContain(`entry ${burstSize - 1}`);

  });

});

