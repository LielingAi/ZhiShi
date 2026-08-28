/** writeFileAtomic 单测（1.4.7 工程卫生收口）：tmp+rename 原子替换纪律。 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeFileAtomic } from './file-lock';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-atomic-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('写入即生效,目录无 tmp 残留', () => {
    const f = join(dir, 'a.json');
    writeFileAtomic(f, '{"ok":true}');
    expect(readFileSync(f, 'utf-8')).toBe('{"ok":true}');
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('覆盖写：旧内容被替换(不追加)', () => {
    const f = join(dir, 'b.json');
    writeFileSync(f, 'old', 'utf-8');
    writeFileAtomic(f, 'new');
    expect(readFileSync(f, 'utf-8')).toBe('new');
  });

  it('中文/长内容原样落盘（编码不丢）', () => {
    const f = join(dir, 'c.txt');
    const content = `中文内容 ${'x'.repeat(10_000)}`;
    writeFileAtomic(f, content);
    expect(readFileSync(f, 'utf-8')).toBe(content);
  });
});
