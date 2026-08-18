import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { countNonEmptyJsonlLines } from './jsonl-line-count';

let scratch: string | null = null;

function tempFile(content: string): string {
  scratch = mkdtempSync(join(tmpdir(), 'zhishi-jsonl-count-'));
  const file = join(scratch, 'session.jsonl');
  writeFileSync(file, content, 'utf-8');
  return file;
}

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

describe('countNonEmptyJsonlLines', () => {
  it('returns 0 for an empty file', () => {
    expect(countNonEmptyJsonlLines(tempFile(''))).toBe(0);
  });

  it('counts a single line without trailing newline', () => {
    expect(countNonEmptyJsonlLines(tempFile('{"role":"user"}'))).toBe(1);
  });

  it('counts multiple lines with trailing newline', () => {
    expect(countNonEmptyJsonlLines(tempFile('{"a":1}\n{"a":2}\n'))).toBe(2);
  });

  it('counts CRLF lines', () => {
    expect(countNonEmptyJsonlLines(tempFile('{"a":1}\r\n{"a":2}\r\n'))).toBe(2);
  });

  it('counts files larger than one buffer', () => {
    const content = Array.from({ length: 20 }, (_, i) => `{"i":${i}}`).join('\n') + '\n';
    expect(countNonEmptyJsonlLines(tempFile(content), 7)).toBe(20);
  });

  it('returns 0 for a missing file', () => {
    expect(countNonEmptyJsonlLines(join(tmpdir(), 'missing-zhishi-jsonl-count.jsonl'))).toBe(0);
  });
});
