import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { __blacklistForCrossCheck } from './path-safety';

/**
 * Node side of the path-safety blacklist cross-check (PRD 0.2.15 §7.2). The
 * Node blacklist (path-safety.ts) and the Rust blacklist
 * (commands.rs::validate_file_path) MUST stay identical, but neither can import
 * the other. The shared fixture src/shared/path-safety-blacklist.json is the
 * agreed source of truth; this test asserts every Node list equals it, and the
 * Rust test (commands.rs::path_safety_crosscheck_tests) asserts the same for the
 * compiled-in Rust lists. Change one list without the fixture → this test fails.
 *
 * Node arrays aren't platform-gated, so this side verifies ALL pieces (incl. the
 * Windows + macOS lists) on any OS. The Rust side can only verify the list its
 * current cfg compiled, so the two tests together cover every platform's drift.
 */
const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/shared/path-safety-blacklist.json'), 'utf-8'),
) as Record<string, string[]>;

describe('path-safety blacklist — Node ↔ shared fixture cross-check', () => {
  const cases: Array<[keyof typeof __blacklistForCrossCheck, string]> = [
    ['systemDirsPosix', 'systemDirsPosix'],
    ['systemDirsMacosExtra', 'systemDirsMacosExtra'],
    ['systemDirsWindows', 'systemDirsWindows'],
    ['credentialSubdirs', 'credentialSubdirs'],
    ['macSensitiveSubdirs', 'macSensitiveSubdirs'],
    ['winSensitiveSubdirs', 'winSensitiveSubdirs'],
  ];

  it.each(cases)('Node %s matches the fixture (edit both + Rust together)', (nodeKey, fixtureKey) => {
    expect([...__blacklistForCrossCheck[nodeKey]]).toEqual(fixture[fixtureKey]);
  });

  it('fixture has no unexpected keys (so a new category is wired on both sides)', () => {
    const expected = new Set(['_comment', ...cases.map(([, k]) => k)]);
    for (const k of Object.keys(fixture)) {
      expect(expected.has(k)).toBe(true);
    }
  });
});
