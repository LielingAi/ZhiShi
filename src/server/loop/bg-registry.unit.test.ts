/**
 * bg-registry unit tests（Phase 3）— 落盘/恢复/坏文件容错/原子写失败不致命。
 * 全部走临时目录，绝不碰真实数据目录（unit 池的纯度要求）。
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bgRegistryFilePath,
  createBgRegistry,
  parseBgRegistryFile,
  serializeBgRegistryFile,
  workspaceHash,
  type BgRegistryEntry,
} from './bg-registry';

const ENTRY: BgRegistryEntry = {
  tag: 'fuzz-1',
  pid: 4242,
  envId: 'pwn-vm',
  startedAt: 1756000000000,
  commandPreview: 'afl-fuzz -i in -o out',
};

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'zhishi-bg-registry-'));
}

describe('纯函数:路径与编解码', () => {
  it('workspaceHash:确定且不同工作区不同哈希', () => {
    expect(workspaceHash('E:\\code\\u-disk')).toBe(workspaceHash('E:\\code\\u-disk'));
    expect(workspaceHash('E:\\code\\u-disk')).not.toBe(workspaceHash('E:\\code\\other'));
    expect(workspaceHash('a')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('bgRegistryFilePath:目录 + 工作区哈希文件名', () => {
    const p = bgRegistryFilePath('ws-1', 'D:/tmp/data');
    expect(p).toBe(join('D:/tmp/data', `${workspaceHash('ws-1')}.json`));
  });

  it('serialize/parse 往返;坏 JSON 与坏条目逐条容错', () => {
    expect(parseBgRegistryFile(serializeBgRegistryFile([ENTRY]))).toEqual([ENTRY]);
    expect(parseBgRegistryFile('{oops')).toEqual([]);
    expect(parseBgRegistryFile('null')).toEqual([]);
    const mixed = JSON.stringify({
      version: 1,
      entries: [
        ENTRY,
        { tag: '../bad', pid: 1, envId: 'e' }, // tag 白名单拒收
        { tag: 'ok-2', pid: 'not-a-number', envId: 'e' }, // pid 非数字
        { tag: 'ok-3', pid: 7, envId: '' }, // envId 空
        null,
        { tag: 'ok-4', pid: 8, envId: 'e', startedAt: 'nope', commandPreview: 42 }, // 缺省填充
      ],
    });
    expect(parseBgRegistryFile(mixed)).toEqual([
      ENTRY,
      { tag: 'ok-4', pid: 8, envId: 'e', startedAt: 0, commandPreview: '' },
    ]);
  });

  it('1.6.0 ownerSessionId:往返保留;缺席保持缺席(旧登记兼容)', () => {
    const withOwner: BgRegistryEntry = { ...ENTRY, ownerSessionId: 'ls-invoke' };
    expect(parseBgRegistryFile(serializeBgRegistryFile([withOwner]))).toEqual([withOwner]);
    const parsed = parseBgRegistryFile(serializeBgRegistryFile([ENTRY]));
    expect(parsed[0].ownerSessionId).toBeUndefined();
    // 非法形状(非字符串/空串)按缺席处理。
    const raw = JSON.stringify({ version: 1, entries: [{ ...ENTRY, ownerSessionId: 42 }, { ...ENTRY, tag: 'ok-9', ownerSessionId: '' }] });
    const out = parseBgRegistryFile(raw);
    expect(out.map((e) => e.ownerSessionId)).toEqual([undefined, undefined]);
  });
});

describe('实例:落盘/恢复/清除', () => {
  it('register 落盘、remove 清盘、restore 重建内存表', () => {
    const dir = tmpDir();
    try {
      const file = join(dir, 'reg.json');
      const reg1 = createBgRegistry({ filePath: file });
      reg1.register(ENTRY);
      expect(existsSync(file)).toBe(true);
      expect(parseBgRegistryFile(readFileSync(file, 'utf-8'))).toEqual([ENTRY]);

      // 新实例(模拟 sidecar 重启)从盘上恢复。
      const reg2 = createBgRegistry({ filePath: file });
      expect(reg2.list()).toEqual([]);
      reg2.restore();
      expect(reg2.get('fuzz-1')).toEqual(ENTRY);

      // remove 后盘上清空;再次恢复为空。
      reg2.remove('fuzz-1');
      expect(reg2.list()).toEqual([]);
      const reg3 = createBgRegistry({ filePath: file });
      reg3.restore();
      expect(reg3.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('连续写入后盘上永远是完整 JSON(原子替换无撕裂)', () => {
    const dir = tmpDir();
    try {
      const file = join(dir, 'reg.json');
      const reg = createBgRegistry({ filePath: file });
      for (let i = 0; i < 20; i++) {
        reg.register({ ...ENTRY, tag: `t-${i}` });
      }
      const onDisk = parseBgRegistryFile(readFileSync(file, 'utf-8'));
      expect(onDisk).toHaveLength(20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restore:文件缺失静默空表;损坏文件告警 + 空表(不抛错)', () => {
    const dir = tmpDir();
    try {
      const warns: string[] = [];
      const reg = createBgRegistry({
        filePath: join(dir, 'nope.json'),
        logWarn: (m) => warns.push(m),
      });
      reg.restore();
      expect(reg.list()).toEqual([]);
      expect(warns).toEqual([]);

      writeFileSync(join(dir, 'bad.json'), 'not-json{{{');
      const reg2 = createBgRegistry({ filePath: join(dir, 'bad.json'), logWarn: (m) => warns.push(m) });
      reg2.restore();
      expect(reg2.list()).toEqual([]);
      // 读取失败与解析失败都不该告警炸人——解析失败静默按空表(见模块注释)
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('原子写失败不致命:落盘路径被文件占住 → 仅告警,内存态照常', () => {
    const dir = tmpDir();
    try {
      const blocker = join(dir, 'blocked');
      writeFileSync(blocker, 'x'); // 用文件占住登记表目录名 → mkdirSync 必炸
      const warns: string[] = [];
      const reg = createBgRegistry({
        filePath: join(blocker, 'reg.json'),
        logWarn: (m) => warns.push(m),
      });
      expect(() => reg.register(ENTRY)).not.toThrow();
      expect(warns).toHaveLength(1);
      expect(reg.get('fuzz-1')).toEqual(ENTRY); // 内存态照常可用
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
