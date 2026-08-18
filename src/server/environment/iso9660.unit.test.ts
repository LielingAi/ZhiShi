/**
 * 安全研究员版 P2 V7 — iso9660 unit tests.
 *
 * 纯函数断言：卷描述符结构（CD001 magic、PVD/SVD/terminator 类型字节、
 * 卷标 cidata、Joliet escape 序列、双端序字段）、PVD 8.3 大写映射、
 * Joliet 树 round-trip（parseIso9660Files 读回真实文件名）、多文件与
 * 空文件边界、非法输入报错。绝不碰磁盘/进程。
 */
import { describe, expect, it } from 'vitest';

import {
  buildIso9660,
  parseIso9660Files,
  toIsoLevel1Name,
} from './iso9660';

const SECTOR = 2048;

function makeIso(files: Array<{ name: string; content: Buffer }> = [
  { name: 'user-data', content: Buffer.from('#cloud-config\nautoinstall: {}\n') },
  { name: 'meta-data', content: Buffer.from('instance-id: ab12\n') },
]): Buffer {
  return buildIso9660({ volumeId: 'cidata', files });
}

describe('buildIso9660 结构', () => {
  it('镜像长度为 sector 整数倍；16 个空系统区 sector', () => {
    const iso = makeIso();
    expect(iso.length % SECTOR).toBe(0);
    expect(iso.subarray(0, 16 * SECTOR).every((b) => b === 0)).toBe(true);
  });

  it('PVD / SVD / terminator 的类型字节与 CD001 magic', () => {
    const iso = makeIso();
    const pvd = 16 * SECTOR;
    const svd = 17 * SECTOR;
    const term = 18 * SECTOR;
    expect(iso[pvd]).toBe(1);
    expect(iso.toString('ascii', pvd + 1, pvd + 6)).toBe('CD001');
    expect(iso[pvd + 6]).toBe(1);
    expect(iso[svd]).toBe(2);
    expect(iso.toString('ascii', svd + 1, svd + 6)).toBe('CD001');
    expect(iso[term]).toBe(255);
    expect(iso.toString('ascii', term + 1, term + 6)).toBe('CD001');
  });

  it('PVD 卷标大写化 CIDATA（NoCloud 要求 cidata，PVD d-characters 放不下小写）', () => {
    const iso = makeIso();
    expect(iso.toString('ascii', 16 * SECTOR + 32, 16 * SECTOR + 64).trim()).toBe('CIDATA');
  });

  it('SVD 带 Joliet escape sequences（%/@ %/C %/E），卷标 UCS-2BE', () => {
    const iso = makeIso();
    const svd = 17 * SECTOR;
    expect([...iso.subarray(svd + 88, svd + 88 + 9)]).toEqual([
      0x25, 0x2f, 0x40, 0x25, 0x2f, 0x43, 0x25, 0x2f, 0x45,
    ]);
    // 'cidata' → 00 63 00 69 00 64 00 61 00 74 00 61
    expect(iso[svd + 32 + 1]).toBe(0x63);
    expect(iso[svd + 32 + 11]).toBe(0x61);
  });

  it('volume space size 733 双端序两端一致且等于镜像 sector 数', () => {
    const iso = makeIso();
    const pvd = 16 * SECTOR;
    expect(iso.readUInt32LE(pvd + 80)).toBe(iso.length / SECTOR);
    expect(iso.readUInt32BE(pvd + 84)).toBe(iso.length / SECTOR);
    // logical block size 723 = 2048
    expect(iso.readUInt16LE(pvd + 128)).toBe(SECTOR);
    expect(iso.readUInt16BE(pvd + 130)).toBe(SECTOR);
  });

  it('PVD 树放 8.3 大写映射（USER_DAT.;1 / META_DAT.;1）', () => {
    const iso = makeIso();
    expect(iso.includes(Buffer.from('USER_DAT.;1', 'ascii'))).toBe(true);
    expect(iso.includes(Buffer.from('META_DAT.;1', 'ascii'))).toBe(true);
  });
});

describe('toIsoLevel1Name', () => {
  it('连字符转下划线、大写、主干截 8', () => {
    expect(toIsoLevel1Name('user-data')).toBe('USER_DAT.;1');
    expect(toIsoLevel1Name('meta-data')).toBe('META_DAT.;1');
  });

  it('带扩展名：扩展截 3', () => {
    expect(toIsoLevel1Name('seed.iso')).toBe('SEED.ISO;1');
    expect(toIsoLevel1Name('network-config')).toBe('NETWORK_.;1');
  });
});

describe('round-trip（parseIso9660Files 读 Joliet 树）', () => {
  it('读回真实文件名（小写带连字符）', () => {
    expect(parseIso9660Files(makeIso())).toEqual(['user-data', 'meta-data']);
  });

  it('多文件保持写入顺序', () => {
    const iso = buildIso9660({
      volumeId: 'cidata',
      files: [
        { name: 'user-data', content: Buffer.from('u') },
        { name: 'meta-data', content: Buffer.from('m') },
        { name: 'network-config', content: Buffer.from('n') },
        { name: 'vendor-data', content: Buffer.from('v') },
      ],
    });
    expect(parseIso9660Files(iso)).toEqual(['user-data', 'meta-data', 'network-config', 'vendor-data']);
  });

  it('文件内容原样落在镜像里（含跨 sector 大文件）', () => {
    const big = Buffer.alloc(SECTOR * 3 + 17, 0x5a);
    const iso = buildIso9660({
      volumeId: 'cidata',
      files: [{ name: 'user-data', content: big }],
    });
    expect(iso.includes(big)).toBe(true);
    expect(parseIso9660Files(iso)).toEqual(['user-data']);
  });

  it('空文件边界：长度 0 不炸，清单可见', () => {
    const iso = buildIso9660({
      volumeId: 'cidata',
      files: [
        { name: 'user-data', content: Buffer.alloc(0) },
        { name: 'meta-data', content: Buffer.from('x') },
      ],
    });
    expect(parseIso9660Files(iso)).toEqual(['user-data', 'meta-data']);
  });

  it('非 ISO buffer / 无 SVD → parse 报错', () => {
    expect(() => parseIso9660Files(Buffer.alloc(SECTOR * 20))).toThrow('SVD');
  });
});

describe('非法输入', () => {
  it('空卷标 / 重名 / 子目录路径都拒绝', () => {
    expect(() => buildIso9660({ volumeId: ' ', files: [] })).toThrow('volumeId');
    expect(() => buildIso9660({
      volumeId: 'cidata',
      files: [
        { name: 'user-data', content: Buffer.from('a') },
        { name: 'user-data', content: Buffer.from('b') },
      ],
    })).toThrow('重复');
    expect(() => buildIso9660({
      volumeId: 'cidata',
      files: [{ name: 'sub/user-data', content: Buffer.from('a') }],
    })).toThrow('子目录');
  });
});
