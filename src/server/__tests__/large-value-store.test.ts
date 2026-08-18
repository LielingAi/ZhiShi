/**
 * Pattern 2 §G — large-value-store unit tests.
 *
 * Covers:
 *  (a) maybeSpill returns inline for values <= inlineMaxBytes
 *  (b) maybeSpill returns a ref for oversize values; preview = head N bytes
 *  (c) fetchRef returns the spilled bytes
 *  (d) fetchRef returns null after clearExpiredRefs() runs past TTL
 *  (e) clearSessionRefs removes only that session's refs
 */

import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, unlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearExpiredRefs,
  clearSessionRefs,
  fetchRef,
  maybeSpill,
  type LargeValueRef,
} from '../utils/large-value-store';

let scratch: string;
const ORIGINAL_REFS_DIR = process.env.ZHISHI_REFS_DIR;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-refs-'));
  process.env.ZHISHI_REFS_DIR = scratch;
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (ORIGINAL_REFS_DIR === undefined) {
    delete process.env.ZHISHI_REFS_DIR;
  } else {
    process.env.ZHISHI_REFS_DIR = ORIGINAL_REFS_DIR;
  }
});

describe('maybeSpill', () => {
  it('returns inline for small values (<= inlineMaxBytes)', async () => {
    const value = 'small text under threshold';
    const out = await maybeSpill(value, {
      inlineMaxBytes: 1024,
      previewBytes: 64,
      mimetype: 'text/plain',
    });
    expect('inline' in out).toBe(true);
    if ('inline' in out) {
      expect(out.inline).toBe(value);
    }
  });

  it('returns a ref for oversize values; preview is the head bytes', async () => {
    const head = 'HEAD-PREVIEW-XYZ';
    const value = head + 'A'.repeat(2048);
    const out = await maybeSpill(value, {
      inlineMaxBytes: 256,
      previewBytes: 16,
      mimetype: 'text/plain',
    });
    expect('inline' in out).toBe(false);
    const ref = out as LargeValueRef;
    expect(ref.kind).toBe('ref');
    expect(ref.sizeBytes).toBe(Buffer.byteLength(value, 'utf-8'));
    expect(ref.mimetype).toBe('text/plain');
    expect(ref.preview).toBe(head); // head 16 chars
    expect(ref.id).toMatch(/^[a-f0-9]+$/i);
    expect(ref.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe('fetchRef', () => {
  it('returns the spilled bytes', async () => {
    const value = 'B'.repeat(4096);
    const out = await maybeSpill(value, {
      inlineMaxBytes: 256,
      previewBytes: 64,
      mimetype: 'text/plain',
    });
    const ref = out as LargeValueRef;
    const fetched = await fetchRef(ref.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.mimetype).toBe('text/plain');
    expect(Buffer.from(fetched!.data).toString('utf-8')).toBe(value);
  });

  it('returns null for unknown id', async () => {
    const fetched = await fetchRef('deadbeef');
    expect(fetched).toBeNull();
  });

  it('rejects ids with path-traversal patterns', async () => {
    const fetched = await fetchRef('../etc/passwd');
    expect(fetched).toBeNull();
  });

  it('rejects uppercase ids (tightened path-traversal guard, fix #5C)', async () => {
    // Generator emits lowercase hex; uppercase variants must be rejected so
    // case-mixing probes can't slip past the regex.
    const fetched = await fetchRef('DEADBEEF');
    expect(fetched).toBeNull();
  });

  it('rejects too-short ids (< 8 chars) and too-long ids (> 32 chars)', async () => {
    expect(await fetchRef('abc')).toBeNull();
    expect(await fetchRef('a'.repeat(64))).toBeNull();
  });
});

describe('expiresAt validity (fix #5B)', () => {
  it('treats expiresAt=0 (corrupt sentinel) as expired and returns null', async () => {
    const value = 'X'.repeat(2048);
    const out = await maybeSpill(value, {
      inlineMaxBytes: 256,
      mimetype: 'text/plain',
    });
    const ref = out as LargeValueRef;

    // Corrupt the meta file: rewrite expiresAt=0 (legacy "non-expiring" via
    // truthiness check). The fixed isExpired() must reject this.
    const metaPath = join(scratch, `${ref.id}.meta.json`);
    const raw = readFileSync(metaPath, 'utf-8');
    const parsed = JSON.parse(raw);
    parsed.expiresAt = 0;
    writeFileSync(metaPath, JSON.stringify(parsed), 'utf-8');

    expect(await fetchRef(ref.id)).toBeNull();
  });
});

describe('orphan body sweep (fix #5D)', () => {
  it('removes body files older than 1h without a paired meta.json', async () => {
    // Simulate: a body file that lost its meta (meta-write failed mid-spill).
    // Use a valid id shape so the sweep regex accepts it.
    const orphanId = 'aabbccdd';
    const orphanPath = join(scratch, orphanId);
    writeFileSync(orphanPath, Buffer.from('orphaned-data'));

    // Backdate mtime to 2h ago so the sweep picks it up.
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(orphanPath, twoHoursAgo, twoHoursAgo);

    expect(existsSync(orphanPath)).toBe(true);
    await clearExpiredRefs();
    expect(existsSync(orphanPath)).toBe(false);
  });

  it('does NOT remove body files younger than 1h (race-safe)', async () => {
    const value = 'Y'.repeat(4096);
    const out = await maybeSpill(value, {
      inlineMaxBytes: 256,
      mimetype: 'text/plain',
    });
    const ref = out as LargeValueRef;
    // Delete the meta file to simulate a partial write — body is now an
    // "orphan" but very young; the sweep must NOT remove it.
    const metaPath = join(scratch, `${ref.id}.meta.json`);
    unlinkSync(metaPath);

    await clearExpiredRefs();
    expect(existsSync(join(scratch, ref.id))).toBe(true); // young orphan survives
  });
});

describe('clearExpiredRefs', () => {
  it('removes refs whose expiresAt has passed', async () => {
    const value = 'C'.repeat(2048);
    const out = await maybeSpill(value, {
      inlineMaxBytes: 256,
      previewBytes: 16,
      mimetype: 'text/plain',
      ttlMs: -1, // already expired
    });
    const ref = out as LargeValueRef;

    // Body & meta exist before GC.
    expect(existsSync(join(scratch, ref.id))).toBe(true);
    expect(existsSync(join(scratch, `${ref.id}.meta.json`))).toBe(true);

    await clearExpiredRefs();

    // After GC, fetchRef should return null and the body file should be gone.
    expect(await fetchRef(ref.id)).toBeNull();
    expect(existsSync(join(scratch, ref.id))).toBe(false);
    expect(existsSync(join(scratch, `${ref.id}.meta.json`))).toBe(false);
  });
});

describe('clearSessionRefs', () => {
  it('removes only refs tagged with the given sessionId', async () => {
    const tagA = 'session-A';
    const tagB = 'session-B';

    const refA = await maybeSpill('A'.repeat(2048), {
      inlineMaxBytes: 256,
      mimetype: 'text/plain',
      sessionId: tagA,
    }) as LargeValueRef;
    const refB = await maybeSpill('B'.repeat(2048), {
      inlineMaxBytes: 256,
      mimetype: 'text/plain',
      sessionId: tagB,
    }) as LargeValueRef;

    await clearSessionRefs(tagA);

    expect(await fetchRef(refA.id)).toBeNull();
    expect(await fetchRef(refB.id)).not.toBeNull();
  });
});
