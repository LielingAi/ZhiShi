/**
 * Pattern 5 §5.3.4.a — admin-config writer is async.
 *
 * Verifies:
 *  - `atomicModifyConfig` returns a Promise (no Atomics.wait / sync busy-wait
 *    in the lock acquisition path).
 *  - Two in-process concurrent mutations serialize without losing writes.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-async-config-'));
  const configDir = join(scratch, '.zhishi');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ initial: true }, null, 2),
    'utf-8',
  );
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
});

afterEach(() => {
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

describe('atomicModifyConfig (async)', () => {
  it('returns a Promise', async () => {
    const { atomicModifyConfig } = await import('../utils/admin-config');
    const result = atomicModifyConfig(c => ({ ...c, marker: 'set' }));
    expect(result).toBeInstanceOf(Promise);
    await result;

    const persisted = JSON.parse(
      readFileSync(join(scratch, '.zhishi', 'config.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(persisted.marker).toBe('set');
  });

  it('serializes two concurrent in-process mutations without loss', async () => {
    const { atomicModifyConfig } = await import('../utils/admin-config');

    const slow = atomicModifyConfig(async c => {
      await new Promise(r => setTimeout(r, 80));
      return { ...c, slow: 'a' };
    });
    const fast = atomicModifyConfig(c => ({ ...c, fast: 'b' }));

    await Promise.all([slow, fast]);

    const persisted = JSON.parse(
      readFileSync(join(scratch, '.zhishi', 'config.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(persisted.initial).toBe(true);
    expect(persisted.slow).toBe('a');
    expect(persisted.fast).toBe('b');
  });
});
