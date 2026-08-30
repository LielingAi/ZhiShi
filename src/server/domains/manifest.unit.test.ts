/**
 * domains/manifest unit tests — 装载/容错/校验/信号并集。全部临时目录注入,
 * 绝不碰真实 bundled-domains。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectDomainSignals,
  loadDomainManifest,
  loadDomainManifests,
  validateDomainManifest,
  type DomainCheckContext,
} from './manifest';

let root: string;

function writeManifest(domain: string, obj: unknown): void {
  const d = join(root, domain);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'domain.json'), typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf-8');
}

const VALID = {
  kind: 'pentest',
  name: '渗透',
  recipes: ['pentest'],
  subagents: ['scan-runner'],
  signals: [{ re: 'Session (\\d+) opened', label: 'session 已开', appendMatch: true }],
  acceptance: ['recon 到 shell'],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zhishi-domains-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loadDomainManifest', () => {
  it('装载合法清单;缺文件/坏 JSON/缺必填 → null', () => {
    writeManifest('pentest', VALID);
    const m = loadDomainManifest(join(root, 'pentest'));
    expect(m?.kind).toBe('pentest');
    expect(m?.signals).toHaveLength(1);

    mkdirSync(join(root, 'empty'), { recursive: true });
    expect(loadDomainManifest(join(root, 'empty'))).toBeNull();

    writeManifest('bad', '{ not json');
    expect(loadDomainManifest(join(root, 'bad'))).toBeNull();

    writeManifest('nokind', JSON.stringify({ name: 'x' }));
    expect(loadDomainManifest(join(root, 'nokind'))).toBeNull();
  });
});

describe('loadDomainManifests', () => {
  it('收集全部合法清单,跳过非法;目录不存在 → []', () => {
    writeManifest('a', VALID);
    writeManifest('b', '{ bad');
    writeManifest('c', { ...VALID, kind: 'malware', name: '恶意软件' });
    const all = loadDomainManifests(root);
    expect(all.map((m) => m.kind).sort()).toEqual(['malware', 'pentest']);
    expect(loadDomainManifests(join(root, 'nope'))).toEqual([]);
  });
});

describe('validateDomainManifest', () => {
  const ctx: DomainCheckContext = {
    recipeIds: new Set(['pentest']),
    subagentIds: new Set(['scan-runner']),
  };

  it('引用完整 + 正则可编译 → 无 error', () => {
    writeManifest('pentest', VALID);
    const m = loadDomainManifest(join(root, 'pentest'))!;
    const issues = validateDomainManifest(m, ctx);
    expect(issues.filter((i) => i.level === 'error')).toHaveLength(0);
  });

  it('缺失引用/非法正则/空验收 → 对应 issue', () => {
    writeManifest('broken', {
      kind: 'broken', name: '坏',
      recipes: ['ghost-recipe'], subagents: ['ghost-agent'],
      signals: [{ re: '([', label: 'x' }],
      acceptance: [],
    });
    const m = loadDomainManifest(join(root, 'broken'))!;
    const issues = validateDomainManifest(m, ctx);
    expect(issues.filter((i) => i.level === 'error')).toHaveLength(3); // 2 引用 + 1 正则（1.5.1：skill 引用校验随字段删除）
    expect(issues.some((i) => i.level === 'warn' && i.message.includes('验收'))).toBe(true);
  });
});

describe('collectDomainSignals', () => {
  it('多域信号并集', () => {
    writeManifest('a', VALID);
    writeManifest('b', { ...VALID, kind: 'malware', name: 'm', signals: [{ re: 'yara hit', label: 'y' }] });
    const signals = collectDomainSignals(loadDomainManifests(root));
    expect(signals).toHaveLength(2);
  });
});
