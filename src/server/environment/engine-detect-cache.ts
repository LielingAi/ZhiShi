/**
 * 安全研究员版 P1 E1 — cached environment-engine detection.
 *
 * `detectEnvironmentEngines()` spawns up to six CLI probes; session startup
 * + admin API + CLI may all ask within a short window, so results are cached
 * for 30s with in-flight single-flight de-duplication. There is only one
 * cache slot — the probe is all-engines-at-once, not per-engine.
 *
 * Explicit refresh paths (a future `env diagnose`, the CLI's `--fresh` flag)
 * pass `{ forceFresh: true }` so a real re-probe is never masked by a stale
 * cached entry.
 */
import {
  detectEnvironmentEngines,
  type EnvironmentEnginesReport,
} from './engines';

/** Cache TTL — matches the runtime-detect 30s window. */
const DETECT_CACHE_TTL_MS = 30_000;

interface CacheEntry {
  report: EnvironmentEnginesReport;
  fetchedAt: number;
}

let cacheEntry: CacheEntry | null = null;
let inFlight: Promise<EnvironmentEnginesReport> | null = null;

/**
 * Cached environment-engine detection. Returns the cached report if fresh
 * (< TTL), joins an in-flight probe if one is running, otherwise starts a
 * new probe.
 *
 * @param detector  Injectable for tests; defaults to the real probe.
 * @param opts.forceFresh  Bypass cache AND in-flight — the caller needs a
 *                         genuinely fresh probe.
 */
export async function detectEnvironmentEnginesCached(
  detector: () => Promise<EnvironmentEnginesReport> = detectEnvironmentEngines,
  opts: { forceFresh?: boolean } = {},
): Promise<EnvironmentEnginesReport> {
  const forceFresh = opts.forceFresh === true;
  // Cache TTL is wall-clock based so it works with standard fake timers in tests.
  const now = Date.now();

  if (!forceFresh) {
    if (cacheEntry && now - cacheEntry.fetchedAt < DETECT_CACHE_TTL_MS) {
      return cacheEntry.report;
    }
    // In-flight de-duplication: forceFresh callers do NOT join — the in-flight
    // probe may have started before whatever prompted the refresh.
    if (inFlight) {
      return inFlight;
    }
  }

  const promise = (async () => {
    try {
      const report = await detector();
      cacheEntry = { report, fetchedAt: Date.now() };
      return report;
    } finally {
      // On error, do NOT cache a failure — next caller retries. (In practice
      // detectEnvironmentEngines never throws — per-engine failures degrade
      // to available:false — but an injected detector may.)
      inFlight = null;
    }
  })();

  inFlight = promise;
  return promise;
}

/** Test-only: clear the cache + in-flight slot between unit tests. */
export function __resetEngineDetectCacheForTest(): void {
  cacheEntry = null;
  inFlight = null;
}
