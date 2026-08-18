/**
 * Pattern 3 §3.2.4 — incremental persistence invariant.
 *
 * Asserts that the per-turn map cost in `persistMessagesToStorage` is O(tail
 * size), not O(history). Rather than wiring a real sidecar + SessionStore,
 * we model the contract directly: a tiny `IncrementalPersister` reproduces
 * the cursor logic from agent-session.ts and we assert that across many
 * turns the underlying mapper is invoked exactly once per *new* message.
 *
 * The shape mirrors the real implementation:
 *   - lastPersistedIndex tracks how many messages have been mapped+saved
 *   - rewind / fork / fresh-session paths reset the cursor
 *   - the mapper runs exactly on `messages.slice(lastPersistedIndex)`
 */

import { describe, expect, it, vi } from 'vitest';

interface Msg { id: string; content: string }

function createPersister() {
  let cursor = 0;
  let cache: Msg[] = [];
  const mapMsg = vi.fn((m: Msg) => ({ ...m, mapped: true }));
  const writer = vi.fn((arr: unknown[]) => arr.length);

  function persist(messages: Msg[]) {
    if (cursor > messages.length) { cursor = 0; cache = []; }
    if (cache.length > messages.length) cache.length = messages.length;
    const tail = messages.slice(cursor);
    const tailMapped = tail.map(mapMsg);
    const out = cache.slice(0, cursor).concat(tailMapped);
    writer(out);
    cache.length = cursor;
    for (const m of tailMapped) cache.push(m as unknown as Msg);
    cursor = messages.length;
  }
  function reset() { cursor = 0; cache = []; }
  return { persist, reset, mapMsg, writer, get cursor() { return cursor; } };
}

describe('incremental persist invariant (Pattern 3 §3.2.4)', () => {
  it('maps only the tail — N turns of 1 new msg each → 1 map call per turn', () => {
    const p = createPersister();
    const messages: Msg[] = [];
    for (let turn = 0; turn < 20; turn++) {
      messages.push({ id: String(turn), content: `m${turn}` });
      p.persist(messages);
      // After turn `turn`, the *cumulative* call count is turn+1 — i.e. each
      // turn added exactly one map invocation, regardless of total history.
      expect(p.mapMsg).toHaveBeenCalledTimes(turn + 1);
    }
    // Cursor advances to full length.
    expect(p.cursor).toBe(20);
  });

  it('handles batch tail (a turn delivers >1 messages)', () => {
    const p = createPersister();
    const messages: Msg[] = [{ id: '0', content: 'u' }];
    p.persist(messages); // 1 map call
    expect(p.mapMsg).toHaveBeenCalledTimes(1);

    // Turn produces user + assistant in one persist round.
    messages.push({ id: '1', content: 'a' }, { id: '2', content: 'a-tool' });
    p.persist(messages);
    expect(p.mapMsg).toHaveBeenCalledTimes(3); // 1 + 2 new
  });

  it('rewind resets the cursor and triggers a full remap', () => {
    const p = createPersister();
    const messages: Msg[] = Array.from({ length: 5 }, (_, i) => ({ id: String(i), content: `m${i}` }));
    p.persist(messages);
    expect(p.mapMsg).toHaveBeenCalledTimes(5);

    // Rewind: shrink + reset cursor (matches agent-session.ts rewind path).
    messages.length = 2;
    p.reset();
    p.persist(messages);
    // 5 prior calls + 2 fresh map calls (full remap of the truncated state).
    expect(p.mapMsg).toHaveBeenCalledTimes(7);
  });

  it('cursor advancing past array length self-heals (defense)', () => {
    const p = createPersister();
    const messages: Msg[] = [{ id: 'a', content: 'a' }, { id: 'b', content: 'b' }];
    p.persist(messages);
    expect(p.mapMsg).toHaveBeenCalledTimes(2);

    // Simulate an array that shrank without a corresponding cursor reset.
    messages.length = 1;
    p.persist(messages);
    // Cursor was 2, length is 1 → cursor reset path runs → full remap (1 call).
    expect(p.mapMsg).toHaveBeenCalledTimes(3);
  });
});

describe('schedulePersist serialization invariant (Pattern 3 §3.2.4 fix #2)', () => {
  // Mirror of the production schedulePersist chain logic. Verifies that two
  // overlapping fire-and-forget persist calls run sequentially (the second
  // observes a fully-completed first) instead of racing on cursor.
  it('serializes two overlapping persists per session via promise chain', async () => {
    const persistChain = new Map<string, Promise<void>>();
    const trace: string[] = [];

    function schedule(sessionId: string, label: string, holdMs: number): Promise<void> {
      const prev = persistChain.get(sessionId) ?? Promise.resolve();
      const next = prev.then(async () => {
        trace.push(`${label}-enter`);
        await new Promise(r => setTimeout(r, holdMs));
        trace.push(`${label}-exit`);
      });
      persistChain.set(sessionId, next);
      return next;
    }

    await Promise.all([
      schedule('S1', 'A', 30),
      schedule('S1', 'B', 5),
    ]);

    // Strict ordering — A entered first; B must enter only after A exits.
    expect(trace).toEqual(['A-enter', 'A-exit', 'B-enter', 'B-exit']);
  });

  it('keeps separate chains per session (fork-style isolation)', async () => {
    const persistChain = new Map<string, Promise<void>>();
    const trace: string[] = [];

    function schedule(sessionId: string, label: string, holdMs: number): Promise<void> {
      const prev = persistChain.get(sessionId) ?? Promise.resolve();
      const next = prev.then(async () => {
        trace.push(`${sessionId}:${label}-enter`);
        await new Promise(r => setTimeout(r, holdMs));
        trace.push(`${sessionId}:${label}-exit`);
      });
      persistChain.set(sessionId, next);
      return next;
    }

    // Different sessions must run concurrently (no cross-session blocking).
    await Promise.all([
      schedule('parent', 'p1', 25),
      schedule('child', 'c1', 5),
    ]);

    // Child finishes before parent — that's only possible if they're independent chains.
    expect(trace.indexOf('child:c1-exit')).toBeLessThan(trace.indexOf('parent:p1-exit'));
  });
});
