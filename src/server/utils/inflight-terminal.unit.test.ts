import { describe, it, expect } from 'vitest';
import { decideInFlightActionOnResult } from './inflight-terminal';

describe('decideInFlightActionOnResult (issue #289 — force-send must surface, not drop)', () => {
  it('FORCE-send (the bug): interrupting + forced + has meta → surface (show the bubble)', () => {
    // This is the regression for #289: force was dropping the in-flight item even though
    // the SDK processes it. It MUST surface now.
    expect(decideInFlightActionOnResult({ isInterrupting: true, forced: true, hasMeta: true })).toBe('surface');
  });

  it('plain STOP: interrupting + NOT forced → drop (unchanged long-standing behavior)', () => {
    expect(decideInFlightActionOnResult({ isInterrupting: true, forced: false, hasMeta: true })).toBe('drop');
  });

  it('natural completion: not interrupting + has meta → surface (turn-end fallback)', () => {
    expect(decideInFlightActionOnResult({ isInterrupting: false, forced: false, hasMeta: true })).toBe('surface');
  });

  it('force but no meta (cannot build a bubble) → noop (defensive)', () => {
    expect(decideInFlightActionOnResult({ isInterrupting: true, forced: true, hasMeta: false })).toBe('noop');
  });

  it('natural completion but no meta → noop', () => {
    expect(decideInFlightActionOnResult({ isInterrupting: false, forced: false, hasMeta: false })).toBe('noop');
  });

  it('forced wins over the stop drop even if both flags are set (force is the explicit intent)', () => {
    // forced=true must NOT be dropped by the `isInterrupting && !forced` stop rule.
    expect(decideInFlightActionOnResult({ isInterrupting: true, forced: true, hasMeta: true })).not.toBe('drop');
  });
});
