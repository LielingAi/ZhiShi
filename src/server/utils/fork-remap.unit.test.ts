import { describe, it, expect } from 'vitest';
import { buildForkUuidRemap, remapStoredSdkUuids, type ForkTranscriptEntry } from './fork-remap';

const e = (type: 'user' | 'assistant' | 'system', uuid: string): ForkTranscriptEntry => ({ type, uuid });

describe('buildForkUuidRemap (SDK↔SDK positional remap)', () => {
  it('happy path: same length + type sequence, all uuids renamed → clean bijection', () => {
    const src = [e('user', 's1'), e('assistant', 's2'), e('assistant', 's3')];
    const fork = [e('user', 'f1'), e('assistant', 'f2'), e('assistant', 'f3')];
    const r = buildForkUuidRemap(src, fork);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.map.get('s1')).toBe('f1');
      expect(r.map.get('s2')).toBe('f2');
      expect(r.map.get('s3')).toBe('f3');
      expect(r.map.size).toBe(3);
    }
  });

  it('length mismatch → ok:false (abort, fall back to lazy path)', () => {
    const r = buildForkUuidRemap([e('user', 's1')], [e('user', 'f1'), e('assistant', 'f2')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/length mismatch/);
  });

  it('type sequence mismatch → ok:false', () => {
    const r = buildForkUuidRemap([e('user', 's1'), e('assistant', 's2')], [e('user', 'f1'), e('user', 'f2')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/type mismatch at index 1/);
  });

  it('duplicate source uuid → ok:false (not a clean bijection)', () => {
    const r = buildForkUuidRemap([e('user', 'dup'), e('assistant', 'dup')], [e('user', 'f1'), e('assistant', 'f2')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/duplicate source uuid/);
  });

  it('duplicate fork uuid → ok:false', () => {
    const r = buildForkUuidRemap([e('user', 's1'), e('assistant', 's2')], [e('user', 'dup'), e('assistant', 'dup')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/duplicate fork uuid/);
  });

  it('empty transcripts → ok:true with empty map', () => {
    const r = buildForkUuidRemap([], []);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.map.size).toBe(0);
  });
});

describe('remapStoredSdkUuids (apply to our stored row uuids)', () => {
  const map = new Map([['s1', 'f1'], ['s2', 'f2'], ['s3', 'f3']]);

  it('re-stamps every present uuid; passes undefined through', () => {
    const r = remapStoredSdkUuids(['s1', undefined, 's3'], map);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.remapped).toEqual(['f1', undefined, 'f3']);
  });

  it('a stored uuid missing from the map → ok:false (abort the eager fork)', () => {
    const r = remapStoredSdkUuids(['s1', 'unknown'], map);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not in remap: unknown/);
  });

  it('only the last SDK assistant per turn is stored — still covered (it is a map key)', () => {
    // Our store keeps the LAST assistant uuid of a turn; the SDK-granularity map covers
    // every source uuid, so whichever one we stored resolves.
    const r = remapStoredSdkUuids(['s2'], map);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.remapped).toEqual(['f2']);
  });
});
