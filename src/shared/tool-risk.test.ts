import { describe, it, expect } from 'vitest';

import {
  classifyToolRisk,
  toolCallSignature,
  ZHISHI_READONLY_BASH_PATTERNS,
} from './tool-risk';

// PRD 0.2.36 §6.5 — three-level risk table. Every rule in the table gets a
// test; the conservative default (unclassifiable → high) is load-bearing.

describe('classifyToolRisk — low (read-only) builtin tools', () => {
  const lowTools = ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'Task', 'TodoWrite', 'TodoRead', 'NotebookRead'];
  for (const tool of lowTools) {
    it(`${tool} → low`, () => {
      expect(classifyToolRisk(tool, {})).toBe('low');
    });
  }

  it('control-transfer tools → low (passthrough to their dedicated handlers)', () => {
    for (const tool of ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']) {
      expect(classifyToolRisk(tool, {})).toBe('low');
    }
  });
});

describe('classifyToolRisk — medium (reversible write) tools', () => {
  const mediumTools = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Skill'];
  for (const tool of mediumTools) {
    it(`${tool} → medium`, () => {
      expect(classifyToolRisk(tool, { file_path: '/tmp/x' })).toBe('medium');
    });
  }
});

describe('classifyToolRisk — high (unknown / MCP) tools', () => {
  it('unknown builtin-sounding tool → high (conservative default)', () => {
    expect(classifyToolRisk('SomeFutureTool', {})).toBe('high');
  });

  it('third-party MCP write tool → high', () => {
    expect(classifyToolRisk('mcp__github__create_issue', {})).toBe('high');
  });

  it('even read-sounding MCP tools → high (name carries no semantics)', () => {
    expect(classifyToolRisk('mcp__filesystem__read_file', {})).toBe('high');
  });
});

describe('classifyToolRisk — Bash', () => {
  it('zhishi read-only CLI forms → low', () => {
    const readonlyCmds = [
      'zhishi widget readme',
      'zhishi widget list',
      'zhishi widget chart line',
    ];
    for (const command of readonlyCmds) {
      expect(classifyToolRisk('Bash', { command })).toBe('low');
    }
  });

  it('zhishi readonly allowlist rejects shell-metachar smuggling → high', () => {
    // `\n` after a readonly prefix must fail the pattern (second line could be
    // any command) — the conservative default then applies.
    expect(classifyToolRisk('Bash', { command: 'zhishi widget readme\nrm -rf /' })).toBe('high');
    expect(classifyToolRisk('Bash', { command: 'zhishi widget list; rm -rf /' })).toBe('high');
    expect(classifyToolRisk('Bash', { command: 'zhishi widget list && del x' })).toBe('high');
  });

  it('zhishi mutating CLI forms → high', () => {
    const mutating = [
      'zhishi task delete abc123',
      'zhishi task run abc123',
      'zhishi task archive abc123',
    ];
    for (const command of mutating) {
      expect(classifyToolRisk('Bash', { command })).toBe('high');
    }
  });

  it('destructive commands → high / destructive category', () => {
    const cases: Array<[string, string]> = [
      ['rm -rf ./dist', 'rm'],
      ['Remove-Item -Recurse -Force ./dist', 'remove-item'],
      ['del /q *.log', 'del'],
      ['format C:', 'format'],
      ['mkfs.ext4 /dev/sda1', 'mkfs.ext4'],
    ];
    for (const [command, firstWord] of cases) {
      expect(classifyToolRisk('Bash', { command })).toBe('high');
      expect(toolCallSignature('Bash', { command })).toBe(`bash:${firstWord}:destructive`);
    }
  });

  it('git push → high / git-push category', () => {
    expect(classifyToolRisk('Bash', { command: 'git push origin main' })).toBe('high');
    expect(toolCallSignature('Bash', { command: 'git push --force origin main' })).toBe('bash:git:git-push');
    // read-only git is still high (conservative) but a different category.
    expect(toolCallSignature('Bash', { command: 'git status' })).toBe('bash:git:other');
  });

  it('curl/Invoke-WebRequest with payload → high / net-post category', () => {
    expect(toolCallSignature('Bash', { command: 'curl -X POST https://api.example.com/x' })).toBe('bash:curl:net-post');
    expect(toolCallSignature('Bash', { command: "curl -d 'a=b' https://example.com" })).toBe('bash:curl:net-post');
    expect(toolCallSignature('Bash', { command: 'Invoke-WebRequest -Uri https://x -Method Post -Body $b' })).toBe('bash:invoke-webrequest:net-post');
    // Plain GET curl: not net-post, but still high via conservative default.
    expect(classifyToolRisk('Bash', { command: 'curl https://example.com' })).toBe('high');
    expect(toolCallSignature('Bash', { command: 'curl https://example.com' })).toBe('bash:curl:other');
  });

  it('unclassifiable commands → high (conservative default)', () => {
    for (const command of ['npm test', 'ls -la', 'cat file.txt', 'echo hello', 'python script.py']) {
      expect(classifyToolRisk('Bash', { command })).toBe('high');
    }
  });

  it('empty / missing command → low (no effect)', () => {
    expect(classifyToolRisk('Bash', { command: '   ' })).toBe('low');
    expect(classifyToolRisk('Bash', {})).toBe('low');
    expect(classifyToolRisk('Bash', null)).toBe('low');
  });
});


describe('toolCallSignature', () => {
  it('Bash: first word is normalized (path stripped, .exe stripped, lowercased)', () => {
    expect(toolCallSignature('Bash', { command: 'C:\\Tools\\RM.EXE -rf x' })).toBe('bash:rm:destructive');
    expect(toolCallSignature('Bash', { command: '/usr/bin/curl -X POST https://x' })).toBe('bash:curl:net-post');
  });

  it('Bash: same category ⇒ same signature (§6.6 coarse always-allow)', () => {
    expect(toolCallSignature('Bash', { command: 'rm -rf a/' })).toBe(toolCallSignature('Bash', { command: 'rm -rf b/' }));
  });

  it('Bash: stable for the same input', () => {
    const input = { command: 'npm test' };
    expect(toolCallSignature('Bash', input)).toBe(toolCallSignature('Bash', input));
    expect(toolCallSignature('Bash', input)).toBe('bash:npm:other');
  });

  it('Bash: chained commands sign by first segment', () => {
    expect(toolCallSignature('Bash', { command: 'npm run build && npm test' })).toBe('bash:npm:other');
  });

  it('Write/Edit: per-file signature with path normalization', () => {
    expect(toolCallSignature('Write', { file_path: 'src\\App.ts' })).toBe('Write:src/app.ts');
    expect(toolCallSignature('Write', { file_path: 'src/App.ts' })).toBe('Write:src/app.ts');
    expect(toolCallSignature('Edit', { file_path: '/a//b/' })).toBe('Edit:/a/b');
    expect(toolCallSignature('NotebookEdit', { notebook_path: 'N.ipynb' })).toBe('NotebookEdit:n.ipynb');
  });

  it('Write/Edit: missing path falls back to tool name', () => {
    expect(toolCallSignature('Write', {})).toBe('Write');
  });

  it('MCP tools: full tool name is the signature', () => {
    expect(toolCallSignature('mcp__github__create_issue', { title: 'x' })).toBe('mcp__github__create_issue');
  });

  it('plain tools: tool name is the signature', () => {
    expect(toolCallSignature('Read', { file_path: '/a' })).toBe('Read');
  });
});

describe('ZHISHI_READONLY_BASH_PATTERNS — contract with agent-session auto-allow', () => {
  it('matches the exact readonly forms agent-session auto-allows', () => {
    expect(ZHISHI_READONLY_BASH_PATTERNS.some((p) => p.test('zhishi widget readme'))).toBe(true);
    expect(ZHISHI_READONLY_BASH_PATTERNS.some((p) => p.test('zhishi widget list'))).toBe(true);
  });

  it('does NOT match mutating zhishi forms', () => {
    expect(ZHISHI_READONLY_BASH_PATTERNS.some((p) => p.test('zhishi task run abc123'))).toBe(false);
  });
});
