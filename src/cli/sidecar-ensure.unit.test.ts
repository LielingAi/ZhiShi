/**
 * sidecar-ensure 单测（1.8.2）——CLI 自立 sidecar 的探测/解析/轮询逻辑。
 * spawn 与端口分配不真跑（fetchHealth 注入短路）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureCliSidecar, resolveServerScript } from './sidecar-ensure';

let dataDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zhishi-ensure-'));
  prevDataDir = process.env.ZHISHI_DATA_DIR;
  process.env.ZHISHI_DATA_DIR = dataDir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.ZHISHI_DATA_DIR;
  else process.env.ZHISHI_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('resolveServerScript', () => {
  it('bundled 布局：<res>/nodejs/node(.exe) → <res>/server-dist.js', () => {
    const res = mkdtempSync(join(tmpdir(), 'zhishi-res-'));
    writeFileSync(join(res, 'server-dist.js'), '// dist');
    const node = join(res, 'nodejs', process.platform === 'win32' ? 'node.exe' : 'node');
    expect(resolveServerScript(node)).toBe(join(res, 'server-dist.js'));
    rmSync(res, { recursive: true, force: true });
  });

  it('找不到 → null（不猜测）', () => {
    const res = mkdtempSync(join(tmpdir(), 'zhishi-empty-'));
    const node = join(res, 'nodejs', 'node.exe');
    expect(resolveServerScript(node, res)).toBeNull();
    rmSync(res, { recursive: true, force: true });
  });
});

describe('ensureCliSidecar', () => {
  // 虚无 node 路径——确保 resolveServerScript 找不到脚本、绝不真 spawn
  // （测试机的 execPath 会命中 dev 回落 src/server/index.ts，曾真拉起 sidecar
  // 导致 30s 轮询超时 + 临时目录 EBUSY）。
  const FAKE_NODE = join(tmpdir(), 'zhishi-fake-res', 'nodejs', 'node.exe');

  it('port 文件在且 health 活 → 复用，不自立（fetchHealth 未被二次询问端口）', async () => {
    writeFileSync(join(dataDir, 'sidecar.port'), '31415');
    let calls = 0;
    const port = await ensureCliSidecar({
      fetchHealth: async () => { calls++; return true; },
    });
    expect(port).toBe(31415);
    expect(calls).toBe(1);
  });

  it('port 文件在但 health 死 → 走自立路径（脚本缺失 → null，秒回）', async () => {
    writeFileSync(join(dataDir, 'sidecar.port'), '31415');
    const logs: string[] = [];
    const port = await ensureCliSidecar({
      log: (m) => logs.push(m),
      fetchHealth: async () => false,
      execPath: FAKE_NODE,
      cwd: tmpdir(),
    });
    expect(port).toBeNull();
    expect(logs.some((m) => m.includes('server 脚本'))).toBe(true);
  });

  it('无 port 文件 + 脚本缺失 → null', async () => {
    const port = await ensureCliSidecar({
      fetchHealth: async () => false,
      execPath: FAKE_NODE,
      cwd: tmpdir(),
    });
    expect(port).toBeNull();
  });

  it('坏端口文件（非数字）→ 自立路径而非 NaN 透传', async () => {
    writeFileSync(join(dataDir, 'sidecar.port'), 'not-a-port');
    const port = await ensureCliSidecar({
      fetchHealth: async () => false,
      execPath: FAKE_NODE,
      cwd: tmpdir(),
    });
    expect(port === null || Number.isInteger(port)).toBe(true);
  });
});
