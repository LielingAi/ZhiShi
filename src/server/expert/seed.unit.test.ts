/**
 * expert/seed.ts 单测（1.2.1 骨架期）——临时 bundled 目录 + 临时库，覆盖：
 * 解析、幂等导入、内容变更强制覆盖、user/promoted 条目绝不动、坏文件不阻塞、
 * bundled 目录缺失 → 全零结果。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseExpertEntryMarkdown, seedBundledExpert } from './seed';
import {
  getEntryById,
  insertEntry,
  listEntries,
  openExpertStore,
  resetExpertStoreForTest,
  updateEntry,
} from './store';
import { computeContentHash, validateEntry } from './validate';

let dir: string;
let bundled: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-expertseed-db-'));
  bundled = mkdtempSync(join(tmpdir(), 'zhishi-expertseed-bundled-'));
  resetExpertStoreForTest();
});

afterEach(() => {
  resetExpertStoreForTest();
  rmSync(dir, { recursive: true, force: true });
  rmSync(bundled, { recursive: true, force: true });
});

function writeEntryFile(domain: string, slug: string, body: string): void {
  mkdirSync(join(bundled, domain), { recursive: true });
  writeFileSync(join(bundled, domain, `${slug}.md`), body);
}

const SAMPLE = `---
kind: technique
title: 栈溢出 triage
applicability: 拿到崩溃现场
criteria: 十分钟定位崩溃指令
tags: pwn,栈
---

正文：先看寄存器。
`;

describe('parseExpertEntryMarkdown', () => {
  it('frontmatter + 正文拆分；正文 trim', () => {
    const p = parseExpertEntryMarkdown(SAMPLE);
    expect(p.frontmatter.kind).toBe('technique');
    expect(p.body).toBe('正文：先看寄存器。');
  });

  it('缺 frontmatter / YAML 非法 / 非对象 → throw', () => {
    expect(() => parseExpertEntryMarkdown('没有头')).toThrow(/frontmatter/);
    expect(() => parseExpertEntryMarkdown('---\n: bad: yaml: [\n---\nx')).toThrow(/YAML 非法/);
    expect(() => parseExpertEntryMarkdown('---\n- 列表\n---\nx')).toThrow(/必须是 YAML 对象/);
  });
});

describe('seedBundledExpert', () => {
  it('首次导入 → inserted；再跑 → unchanged（幂等）', () => {
    writeEntryFile('binary', 'triage', SAMPLE);
    const r1 = seedBundledExpert({ baseDir: dir, bundledDir: bundled, now: 1000 });
    expect(r1).toEqual({ inserted: 1, updated: 0, unchanged: 0, errors: [] });
    const db = openExpertStore(dir);
    const entries = listEntries(db);
    expect(entries).toHaveLength(1);
    expect(entries[0].provenance).toBe('builtin');
    expect(entries[0].domain).toBe('binary');
    expect(entries[0].content).toBe('正文：先看寄存器。');
    expect(entries[0].enabled).toBe(true);

    const r2 = seedBundledExpert({ baseDir: dir, bundledDir: bundled, now: 2000 });
    expect(r2).toEqual({ inserted: 0, updated: 0, unchanged: 1, errors: [] });
    expect(listEntries(db)).toHaveLength(1); // 不产生重复条目
  });

  it('内容变更 → 强制覆盖（updated），createdAt 保留、enabled 保留', () => {
    writeEntryFile('binary', 'triage', SAMPLE);
    seedBundledExpert({ baseDir: dir, bundledDir: bundled, now: 1000 });
    const db = openExpertStore(dir);
    const before = listEntries(db)[0];
    // 用户停用了内置条目——内容更新不应替他改回来
    updateEntry(db, before.id, { enabled: false });

    writeEntryFile('binary', 'triage', SAMPLE.replace('先看寄存器', '先看栈帧'));
    const r2 = seedBundledExpert({ baseDir: dir, bundledDir: bundled, now: 3000 });
    expect(r2.updated).toBe(1);
    const after = getEntryById(db, before.id)!;
    expect(after.content).toBe('正文：先看栈帧。');
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt).toBe(3000);
    expect(after.enabled).toBe(false);
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it('user/promoted 条目绝不动', () => {
    writeEntryFile('binary', 'triage', SAMPLE);
    const db = openExpertStore(dir);
    const v = validateEntry({
      domain: 'binary', kind: 'idea', title: '用户自己的条目',
      applicability: 'a', content: 'c', criteria: 'k', provenance: 'user', reviewer: 'bob',
    });
    if (!v.ok) throw new Error('unreachable');
    insertEntry(db, v.value, computeContentHash(v.value));

    seedBundledExpert({ baseDir: dir, bundledDir: bundled });
    const all = listEntries(db);
    expect(all).toHaveLength(2);
    const user = all.find((e) => e.provenance === 'user')!;
    expect(user.title).toBe('用户自己的条目');
    // 改 bundled 文件再 seed——用户条目依旧原样
    writeEntryFile('binary', 'triage', SAMPLE.replace('先看寄存器', '改成别的'));
    seedBundledExpert({ baseDir: dir, bundledDir: bundled });
    expect(listEntries(db).find((e) => e.provenance === 'user')!.title).toBe('用户自己的条目');
  });

  it('非法文件进 errors 不阻塞其余；provenance 写文件里也被强制 builtin', () => {
    writeEntryFile('binary', 'bad', `---\nkind: nope\ntitle: t\n---\n正文`);
    writeEntryFile('pentest', 'good', `---\nkind: sop\ntitle: 好条目\napplicability: a\ncriteria: c\nprovenance: user\n---\n\n正文`);
    const r = seedBundledExpert({ baseDir: dir, bundledDir: bundled });
    expect(r.inserted).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('binary/bad');
    const good = listEntries(openExpertStore(dir))[0];
    expect(good.provenance).toBe('builtin');
    expect(good.domain).toBe('pentest');
  });

  it('bundled 目录缺失（null）→ 全零结果，不建库', () => {
    const r = seedBundledExpert({ baseDir: dir, bundledDir: null });
    expect(r).toEqual({ inserted: 0, updated: 0, unchanged: 0, errors: [] });
  });
});
