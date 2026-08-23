/**
 * bundled-agents 装载单测——frontmatter 解析、容错、列表。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadBundledAgents, loadBundledAgent, filterAgentsByDomain } from './bundled-agents';
import type { DomainManifest } from '../../shared/domain-manifest';

let root: string;

function writeAgent(name: string, fm: string, body: string): void {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${name}.md`), `---\n${fm}---\n\n${body}\n`, 'utf-8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zhishi-agents-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loadBundledAgents', () => {
  it('装载全部;正文去 frontmatter;skills 列表解析', () => {
    writeAgent(
      'vuln-hunter',
      'name: vuln-hunter\ndescription: 深度漏洞挖掘\nskills:\n  - whitebox-audit\n  - binary-exploit\n',
      '# vuln-hunter\n\n假设驱动深挖。',
    );
    writeAgent('critic', 'name: critic\ndescription: 对抗审查\n', '挑刺。');
    const all = loadBundledAgents(root);
    expect(all).toHaveLength(2);
    const vh = all.find((a) => a.name === 'vuln-hunter');
    expect(vh?.body).toContain('假设驱动深挖');
    expect(vh?.body).not.toContain('name:');
    expect(vh?.skills).toEqual(['whitebox-audit', 'binary-exploit']);
    expect(all.find((a) => a.name === 'critic')?.body).toBe('挑刺。');
  });

  it('坏定义/空正文/缺文件 → 跳过或 null;目录不存在 → []', () => {
    writeAgent('bad', 'name: bad\n', '   ');
    writeAgent('nofm', '', 'body only');
    mkdirSync(join(root, 'empty-dir'), { recursive: true });
    const all = loadBundledAgents(root);
    expect(all.map((a) => a.name)).toEqual(['nofm']); // bad 空正文跳过;empty-dir 无文件跳过
    expect(loadBundledAgent('ghost', root)).toBeNull();
    expect(loadBundledAgents(join(root, 'nope'))).toEqual([]);
  });

  it('按名取单个', () => {
    writeAgent('hypothesis-tester', 'name: hypothesis-tester\ndescription: 快速验证\n', '证真证伪。');
    const one = loadBundledAgent('hypothesis-tester', root);
    expect(one?.description).toBe('快速验证');
  });
});

describe('filterAgentsByDomain(1.2.7 域补丁:子代理继承会话域)', () => {
  // 与 bundled-domains 真实清单同形;generic-x 不在任何域清单(通用保留)。
  const MANIFESTS = [
    { kind: 'binary', name: '二进制', recipes: ['pwn'], skills: [], subagents: ['fuzz-runner', 'crash-triager', 'vuln-hunter', 'hypothesis-tester', 'critic'], signals: [], acceptance: [] },
    { kind: 'whitebox', name: '白盒审计', recipes: ['code-audit'], skills: [], subagents: ['vuln-hunter', 'hypothesis-tester', 'critic'], signals: [], acceptance: [] },
    { kind: 'pentest', name: '渗透', recipes: ['pentest'], skills: [], subagents: [], signals: [], acceptance: [] },
  ] as unknown as DomainManifest[];
  const AGENTS = [
    { name: 'fuzz-runner' }, { name: 'crash-triager' }, { name: 'vuln-hunter' },
    { name: 'hypothesis-tester' }, { name: 'critic' }, { name: 'generic-x' },
  ];
  const names = (list: { name: string }[]) => list.map((a) => a.name);

  it('binary 域:清单五子代理保留 + 通用子代理保留', () => {
    expect(names(filterAgentsByDomain(AGENTS, 'binary', MANIFESTS))).toEqual(
      ['fuzz-runner', 'crash-triager', 'vuln-hunter', 'hypothesis-tester', 'critic', 'generic-x'],
    );
  });

  it('whitebox 域:收窄到清单三个 + 通用;binary 独有的被滤掉', () => {
    expect(names(filterAgentsByDomain(AGENTS, 'whitebox', MANIFESTS))).toEqual(
      ['vuln-hunter', 'hypothesis-tester', 'critic', 'generic-x'],
    );
  });

  it('pentest 域(subagents 空清单=该域无专属子代理):只剩通用', () => {
    expect(names(filterAgentsByDomain(AGENTS, 'pentest', MANIFESTS))).toEqual(['generic-x']);
  });

  it('无 domain / 域未被清单覆盖 → 原样全量(宁多勿缺,同一引用)', () => {
    expect(filterAgentsByDomain(AGENTS, undefined, MANIFESTS)).toBe(AGENTS);
    expect(filterAgentsByDomain(AGENTS, 'malware', MANIFESTS)).toBe(AGENTS);
  });
});
