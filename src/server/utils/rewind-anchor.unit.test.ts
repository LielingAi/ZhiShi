import { describe, it, expect } from 'vitest';
import { deriveReloadResumeAnchor, resolveEffectiveResumeAt, type ReloadAnchorMessage } from './rewind-anchor';

const m = (role: 'user' | 'assistant', sdkUuid?: string): ReloadAnchorMessage => ({ role, sdkUuid });

describe('deriveReloadResumeAnchor (PRD 0.2.27 window-B reconcile)', () => {
  it('window B: store truncated to end-on-assistant, tail uuid known → returns it', () => {
    // rewind truncated [1..50]; store ends on assistant a50; SDK file still has the
    // old tail → without this anchor the AI would reload the full pre-rewind history.
    const messages = [m('user', 'u1'), m('assistant', 'a1'), m('user', 'u2'), m('assistant', 'a50')];
    expect(deriveReloadResumeAnchor(messages, new Set(['u1', 'a1', 'u2', 'a50']))).toBe('a50');
  });

  it('no-op case: normal session whose tail is an assistant → returns tail uuid', () => {
    // When tail == SDK newest leaf, slicing the reconstructed chain at the tail
    // returns the whole chain → functionally a no-op, just made explicit.
    const messages = [m('user', 'u1'), m('assistant', 'a1')];
    expect(deriveReloadResumeAnchor(messages, new Set(['u1', 'a1']))).toBe('a1');
  });

  it('decision 3 gate: tail is an UNANSWERED user message → undefined (must not slice it out)', () => {
    const messages = [m('user', 'u1'), m('assistant', 'a1'), m('user', 'u2')];
    expect(deriveReloadResumeAnchor(messages, new Set(['u1', 'a1', 'u2']))).toBeUndefined();
  });

  it('decision 4 gate: tail uuid not in known-valid set (compacted/stale) → undefined', () => {
    const messages = [m('user', 'u1'), m('assistant', 'a50')];
    expect(deriveReloadResumeAnchor(messages, new Set(['u1']))).toBeUndefined();
  });

  it('tail assistant without an sdkUuid (old storage / not stamped) → undefined', () => {
    const messages = [m('user', 'u1'), m('assistant', undefined)];
    expect(deriveReloadResumeAnchor(messages, new Set(['u1']))).toBeUndefined();
  });

  it('empty store → undefined', () => {
    expect(deriveReloadResumeAnchor([], new Set())).toBeUndefined();
  });

  it('death-loop break (decision 6): after the rejected anchor is evicted from the valid set, re-derive yields undefined → bare resume, no retry loop', () => {
    // The "No message found" recovery evicts the rejected uuid from currentSessionUuids.
    // This proves the invariant the recovery relies on: the very next derive can no
    // longer return the same (doomed) anchor, so the pre-warm retry uses a bare resume.
    const messages = [m('user', 'u1'), m('assistant', 'a50')];
    const valid = new Set(['u1', 'a50']);
    expect(deriveReloadResumeAnchor(messages, valid)).toBe('a50'); // first derive — sent, then rejected
    valid.delete('a50');                                            // recovery eviction
    expect(deriveReloadResumeAnchor(messages, valid)).toBeUndefined(); // retry won't re-derive it
  });
});

describe('resolveEffectiveResumeAt (priority fold — locks the invariant the fork PRD must not regress)', () => {
  it('normal: only a reload anchor → uses it (lowest priority but nothing else set)', () => {
    expect(resolveEffectiveResumeAt({ forkMode: false, reloadAnchor: 'r1' })).toBe('r1');
  });

  it('normal: in-process rewind WINS over the reload anchor (existing rewind unchanged)', () => {
    expect(resolveEffectiveResumeAt({ forkMode: false, rewindResumeAt: 'rw1', reloadAnchor: 'r1' })).toBe('rw1');
  });

  it('normal: nothing set → undefined (bare resume)', () => {
    expect(resolveEffectiveResumeAt({ forkMode: false })).toBeUndefined();
  });

  it('fork: NEVER uses the reload anchor — falls to the fork point', () => {
    expect(resolveEffectiveResumeAt({ forkMode: true, forkResumeAt: 'f1', reloadAnchor: 'r1' })).toBe('f1');
  });

  it('fork: rewind anchor wins over the fork point', () => {
    expect(resolveEffectiveResumeAt({ forkMode: true, rewindResumeAt: 'rw1', forkResumeAt: 'f1' })).toBe('rw1');
  });

  it('fork: only a (defensive) reload anchor set → undefined (fork path ignores it)', () => {
    expect(resolveEffectiveResumeAt({ forkMode: true, reloadAnchor: 'r1' })).toBeUndefined();
  });
});
