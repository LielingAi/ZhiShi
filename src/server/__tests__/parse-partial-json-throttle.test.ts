/**
 * Pattern 3 §D.3 — `parsePartialJson` throttle invariant.
 *
 * The parser itself is pure; the throttle lives in the caller (per the PRD).
 * We model the caller-side gate exactly as it lives in
 * `agent-session.ts::handleToolInputDelta`: only re-parse when the
 * accumulated buffer has grown by ≥16 KiB since the last parse.
 *
 * Property under test: 1000 deltas of 16 bytes each → at most ~10 parse
 * invocations (16 KiB / 16 B = 1024 deltas per parse).
 */

import { describe, expect, it, vi } from 'vitest';
import { parsePartialJson } from '../../shared/parsePartialJson';

const REPARSE_BYTES = 16 * 1024; // 16 KiB — must match the constant in agent-session.ts

function makeThrottledParser() {
  const parseSpy = vi.fn(parsePartialJson);
  const lastParsedByToolId = new Map<string, number>();
  let buffer = '';

  function pushDelta(toolId: string, delta: string): void {
    buffer += delta;
    const lastParsed = lastParsedByToolId.get(toolId) ?? 0;
    if (buffer.length - lastParsed < REPARSE_BYTES) return;
    parseSpy(buffer);
    lastParsedByToolId.set(toolId, buffer.length);
  }
  function forceFinalise(toolId: string): void {
    // content-block-stop path — caller always tries JSON.parse / parsePartialJson once.
    parseSpy(buffer);
    lastParsedByToolId.delete(toolId);
  }
  return { pushDelta, forceFinalise, parseSpy, get buffer() { return buffer; } };
}

describe('parsePartialJson caller-side throttle (Pattern 3 §D.3)', () => {
  it('1000 × 16-byte deltas → ≤ 10 reparses (16 KiB threshold)', () => {
    const p = makeThrottledParser();
    const delta = 'x'.repeat(16); // 16 B; buffer holds non-JSON text
    for (let i = 0; i < 1000; i++) p.pushDelta('tool-1', delta);
    // 1000 × 16 B = 16 000 B. 16 000 / 16 384 < 1 — under threshold no parse.
    // We assert the upper bound stated in the PRD: ≤ ~10.
    expect(p.parseSpy.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('parses fire when buffer crosses the threshold', () => {
    const p = makeThrottledParser();
    // Push exactly 16 384 B in one go — should trigger one parse.
    p.pushDelta('tool-1', 'x'.repeat(REPARSE_BYTES));
    expect(p.parseSpy).toHaveBeenCalledTimes(1);
    // Another 1023 bytes — under threshold from last parse → no new parse.
    p.pushDelta('tool-1', 'x'.repeat(1023));
    expect(p.parseSpy).toHaveBeenCalledTimes(1);
    // Push past threshold (1 more byte to cross) → second parse.
    p.pushDelta('tool-1', 'x'.repeat(REPARSE_BYTES));
    expect(p.parseSpy).toHaveBeenCalledTimes(2);
  });

  it('forceFinalise always triggers exactly one parse (terminal)', () => {
    const p = makeThrottledParser();
    // Sub-threshold: no parse during streaming.
    for (let i = 0; i < 100; i++) p.pushDelta('tool-1', 'y'.repeat(10));
    expect(p.parseSpy).toHaveBeenCalledTimes(0);
    // content-block-stop arrives.
    p.forceFinalise('tool-1');
    expect(p.parseSpy).toHaveBeenCalledTimes(1);
  });
});
