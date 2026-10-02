/**
 * 1.9.2 — 域清单加载顺序的确定性。
 *
 * 顺序不是装饰：能力集合（capabilityDomains）按域清单顺序排列，而
 * resolveSessionResearchDomain 取「集合首个 research 域」当会话域基线
 * （boundDomainsForEntry 把绑定域放首位，探测域按清单顺序追加）。此前
 * loadDomainManifests 直接吃 readdirSync 的顺序 → 未绑配方的环境（adopt
 * 进来的容器）拿到哪个域，取决于文件系统返回顺序，不可复现。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadDomainManifests } from './domain-manifest';

const root = mkdtempSync(join(tmpdir(), 'zhishi-domains-order-'));

/** 造一份域包目录（目录名与 kind 故意不同，验证排的是目录序）。 */
function writeDomain(dirName: string, kind: string): void {
  mkdirSync(join(root, dirName), { recursive: true });
  writeFileSync(
    join(root, dirName, 'domain.json'),
    JSON.stringify({
      kind,
      name: kind,
      recipes: [],
      subagents: [],
      signals: [],
      acceptance: ['x'],
    }),
    'utf-8',
  );
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('loadDomainManifests — 顺序确定性（1.9.2）', () => {
  it('按目录名排序输出（与 readdir 返回顺序无关）', () => {
    writeDomain('zeta-whitebox', 'whitebox');
    writeDomain('alpha-binary', 'binary');
    expect(loadDomainManifests(root).map((m) => m.kind)).toEqual(['binary', 'whitebox']);
  });

  it('非法项（无 domain.json）跳过，重复调用结果一致', () => {
    mkdirSync(join(root, 'no-json'), { recursive: true });
    const first = loadDomainManifests(root).map((m) => m.kind);
    const second = loadDomainManifests(root).map((m) => m.kind);
    expect(first).toEqual(['binary', 'whitebox']);
    expect(second).toEqual(first);
  });

  it('真实 bundled-domains：kind 序列等于自身排序（顺序可复现）', () => {
    const kinds = loadDomainManifests().map((m) => m.kind);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).toEqual([...kinds].sort());
  });
});
