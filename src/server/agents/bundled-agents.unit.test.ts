/**
 * bundled-agents 装载单测——frontmatter 解析、容错、列表。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadBundledAgents, loadBundledAgent } from './bundled-agents';

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
