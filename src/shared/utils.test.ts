import { describe, expect, it } from 'vitest';

import { isWindowsReservedName, sanitizeFolderName, stripBom } from './utils';

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
