import { describe, expect, it } from 'vitest';

import { compareVersions, isWindowsReservedName, sanitizeFolderName, stripBom } from './utils';

describe('isWindowsReservedName', () => {
  it('matches reserved device names case-insensitively, including with an extension', () => {
    expect(isWindowsReservedName('CON')).toBe(true);
    expect(isWindowsReservedName('con')).toBe(true);
    expect(isWindowsReservedName('CON.txt')).toBe(true); // reserved regardless of ext
    expect(isWindowsReservedName('LPT1')).toBe(true);
    expect(isWindowsReservedName('nul.log')).toBe(true);
  });

  it('does not match names that merely start with a reserved word', () => {
    expect(isWindowsReservedName('console')).toBe(false);
    expect(isWindowsReservedName('COM10')).toBe(false); // only COM1–COM9 reserved
    expect(isWindowsReservedName('report')).toBe(false);
  });
});

describe('sanitizeFolderName', () => {
  it('strips path separators and Windows-illegal characters', () => {
    expect(sanitizeFolderName('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
  });

  it('preserves Unicode (Chinese/Japanese) names', () => {
    expect(sanitizeFolderName('项目文档')).toBe('项目文档');
    expect(sanitizeFolderName('日本語ファイル')).toBe('日本語ファイル');
  });

  it('collapses whitespace/hyphen runs and trims leading/trailing hyphens', () => {
    expect(sanitizeFolderName('  hello   world  ')).toBe('hello-world');
    expect(sanitizeFolderName('--a--b--')).toBe('a-b');
  });

  it('suffixes Windows reserved names so they become usable', () => {
    expect(sanitizeFolderName('CON')).toBe('CON-file');
    expect(sanitizeFolderName('PRN')).toBe('PRN-file');
  });

  it('falls back to a timestamped name when the result is empty', () => {
    expect(sanitizeFolderName('')).toMatch(/^item-\d+$/);
    expect(sanitizeFolderName('///')).toMatch(/^item-\d+$/);
  });
});

describe('stripBom', () => {
  it('removes a leading UTF-8 BOM (U+FEFF)', () => {
    expect(stripBom('﻿{"a":1}')).toBe('{"a":1}');
  });
  it('leaves BOM-free content unchanged, including empty string', () => {
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
    expect(stripBom('')).toBe('');
    // Only a LEADING BOM is stripped — a mid-string U+FEFF is preserved.
    expect(stripBom('a﻿b')).toBe('a﻿b');
  });
});

describe('compareVersions', () => {
  it('compares numerically, not lexically (1.2.10 > 1.2.3)', () => {
    // The classic bug this prevents: string compare would rank "10" < "3".
    expect(compareVersions('1.2.10', '1.2.3')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.10')).toBe(-1);
  });

  it('returns 0 for equal versions and ignores trailing-zero length differences', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0); // missing parts default to 0
  });

  it('orders major/minor before patch', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('0.2.20', '0.2.21')).toBe(-1);
  });
});
