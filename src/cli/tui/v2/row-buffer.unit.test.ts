// Unit tests for the logical row buffer (capacity cap, optimistic ids, events).
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_CAPACITY, RowBuffer, type RowBufferEvent } from './row-buffer';

describe('RowBuffer', () => {
  it('appends rows with generated ids and keeps order', () => {
    const buf = new RowBuffer();
    const a = buf.append([{ text: 'hello' }]);
    const b = buf.append([{ text: 'world' }]);
    expect(buf.length).toBe(2);
    expect(buf.rows().map((r) => r.id)).toEqual([a.id, b.id]);
    expect(buf.get(a.id)?.spans[0].text).toBe('hello');
  });

  it('honours caller-supplied ids (optimistic insert) and rejects duplicates', () => {
    const buf = new RowBuffer();
    buf.append([{ text: '── ⏸ 已中断 ──' }], { id: 'int-1' });
    expect(buf.get('int-1')).toBeDefined();
    expect(() => buf.append([{ text: 'x' }], { id: 'int-1' })).toThrow(
      /duplicate/,
    );
  });

  it('updates a row in place by id', () => {
    const buf = new RowBuffer();
    buf.append([{ text: 'a' }], { id: 'u' });
    buf.append([{ text: 'b' }]);
    expect(buf.update('u', [{ text: 'a2' }])).toBe(true);
    expect(buf.rows()[0].spans[0].text).toBe('a2'); // position kept
    expect(buf.update('nope', [{ text: 'x' }])).toBe(false);
  });

  it('removes rows by id', () => {
    const buf = new RowBuffer();
    const a = buf.append([{ text: 'a' }]);
    expect(buf.remove(a.id)).toBe(true);
    expect(buf.get(a.id)).toBeUndefined();
    expect(buf.length).toBe(0);
    expect(buf.remove(a.id)).toBe(false);
  });

  it('caps capacity and evicts oldest rows', () => {
    const buf = new RowBuffer({ capacity: 3 });
    const ids = Array.from(
      { length: 5 },
      (_, i) => buf.append([{ text: `r${i}` }]).id,
    );
    expect(buf.length).toBe(3);
    expect(buf.get(ids[0])).toBeUndefined();
    expect(buf.get(ids[1])).toBeUndefined();
    expect(buf.rows().map((r) => r.id)).toEqual(ids.slice(2));
  });

  it('default capacity is 5000', () => {
    expect(new RowBuffer().capacity).toBe(DEFAULT_CAPACITY);
  });

  it('emits append / update / remove / evict / clear events', () => {
    const buf = new RowBuffer({ capacity: 2 });
    const events: RowBufferEvent[] = [];
    const unsub = buf.subscribe((e) => events.push(e));

    buf.append([{ text: 'a' }], { id: 'a' });
    buf.update('a', [{ text: 'a2' }]);
    buf.append([{ text: 'b' }], { id: 'b' });
    buf.append([{ text: 'c' }], { id: 'c' }); // evicts a
    buf.remove('b');
    buf.clear();

    expect(events.map((e) => e.type)).toEqual([
      'append',
      'update',
      'append',
      'append',
      'evict',
      'remove',
      'clear',
    ]);
    const evict = events.find((e) => e.type === 'evict');
    expect(evict?.type === 'evict' && evict.rows.map((r) => r.id)).toEqual([
      'a',
    ]);

    unsub();
    buf.append([{ text: 'd' }]);
    expect(events).toHaveLength(7);
  });

  it('clear empties everything', () => {
    const buf = new RowBuffer();
    const spy = vi.fn();
    buf.subscribe(spy);
    buf.append([{ text: 'a' }]);
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.rows()).toEqual([]);
    buf.clear(); // no-op: no event
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
