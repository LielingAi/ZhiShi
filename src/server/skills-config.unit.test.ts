/**
 * 1.1.7 ③ — skills-config（skills-config.json）unit tests.
 *
 * 覆盖 mutateSkillsConfig（withFileLock 锁内读-改-写 + tmp+rename 原子替换，
 * 收编自旧 writeSkillsConfig）：round-trip、conditional write 不 bump
 * generation、并发写串行化不丢更新。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mutateSkillsConfig, readSkillsConfig } from './skills-config';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skills-config-test-'));
  file = join(dir, 'skills-config.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('mutateSkillsConfig（withFileLock + tmp+rename）', () => {
  it('mutate → read round-trip；每次落盘 generation 自增；缺文件 → defaults', () => {
    expect(readSkillsConfig(file)).toEqual({ seeded: [], disabled: [], generation: 0 });
  });

  it('每次落盘 generation 自增', async () => {
    await mutateSkillsConfig((c) => { c.seeded.push('a'); return true; }, file);
    await mutateSkillsConfig((c) => { c.disabled.push('b'); return true; }, file);
    expect(readSkillsConfig(file)).toEqual({ seeded: ['a'], disabled: ['b'], generation: 2 });
  });

  it('mutate 返回 false 不落盘、不 bump generation', async () => {
    await mutateSkillsConfig((c) => { c.seeded.push('a'); return true; }, file);
    await mutateSkillsConfig(() => false, file);
    expect(readSkillsConfig(file).generation).toBe(1);
  });

  it('并发写串行化：两个 mutate 都不丢（锁内读-改-写）', async () => {
    await Promise.all([
      mutateSkillsConfig((c) => { c.seeded.push('skill-a'); return true; }, file),
      mutateSkillsConfig((c) => { c.disabled.push('skill-b'); return true; }, file),
    ]);
    const config = readSkillsConfig(file);
    expect(config.seeded).toEqual(['skill-a']);
    expect(config.disabled).toEqual(['skill-b']);
    expect(config.generation).toBe(2);
  });
});
