import { describe, expect, it } from 'vitest';

import {
  buildMentionItems,
  fileDirOf,
  parseMentionQuery,
  pathBasename,
  type MentionSources,
} from './mention';

describe('parseMentionQuery（@ 触发解析）', () => {
  it('无 /：普通触发（env/agent/tool）', () => {
    expect(parseMentionQuery('pwn-vm')).toEqual({
      query: 'pwn-vm',
      dir: null,
      name: 'pwn-vm',
      isFileDir: false,
    });
  });

  it('目录前缀触发：@src/ → 列目录', () => {
    expect(parseMentionQuery('src/')).toEqual({
      query: 'src/',
      dir: 'src',
      name: '',
      isFileDir: true,
    });
  });

  it('目录前缀 + 片段：@src/ma → 前缀过滤', () => {
    expect(parseMentionQuery('src/ma')).toEqual({
      query: 'src/ma',
      dir: 'src',
      name: 'ma',
      isFileDir: true,
    });
  });

  it('多级目录：取最后一个 / 分界', () => {
    expect(parseMentionQuery('src/gui/x')).toEqual({
      query: 'src/gui/x',
      dir: 'src/gui',
      name: 'x',
      isFileDir: true,
    });
  });
});

describe('pathBasename', () => {
  it('纯字符串末段（浏览器构建不引 node:path）', () => {
    expect(pathBasename('src/gui/main.ts')).toBe('main.ts');
    expect(pathBasename('main.ts')).toBe('main.ts');
    expect(pathBasename('a/b/c/')).toBe('');
  });
});

describe('buildMentionItems（四源合一 + 分节）', () => {
  const src: MentionSources = {
    envs: [{ id: 'env:pwn-vm', kind: 'docker' }],
    agents: [
      { name: 'crash-triager', description: '崩溃三分类', scope: 'project' },
      { name: 'vuln-hunter', scope: 'project' },
    ],
    tools: ['env_exec', 'research_log'],
    files: [
      { path: 'src/gui/main.ts', type: 'file' },
      { path: 'src/gui/App.tsx', type: 'file' },
      { path: 'src/gui/components', type: 'dir' },
      { path: 'src/server/index.ts', type: 'file' },
    ],
  };

  it('普通触发：环境 + 子代理 + 工具三节，无文件', () => {
    const items = buildMentionItems(parseMentionQuery(''), src);
    expect(items.map((i) => i.kind)).toEqual(['env', 'agent', 'agent', 'tool', 'tool']);
    expect(new Set(items.map((i) => i.section))).toEqual(new Set(['环境', '子代理', '工具']));
    expect(items[0]).toMatchObject({ kind: 'env', id: 'env:pwn-vm' });
    expect(items[1]).toMatchObject({ kind: 'agent', insert: 'crash-triager' });
  });

  it('片段过滤（不区分大小写）', () => {
    const items = buildMentionItems(parseMentionQuery('PWn'), src);
    expect(items.map((i) => i.label)).toEqual(['env:pwn-vm']);
    const agents = buildMentionItems(parseMentionQuery('crash'), src);
    expect(agents.map((i) => i.label)).toEqual(['crash-triager']);
    // 片段跨源匹配：'env' 同时命中环境 id 与工具名（预期行为）。
    const tools = buildMentionItems(parseMentionQuery('env'), src);
    expect(tools.map((i) => i.label)).toEqual(['env:pwn-vm', 'env_exec']);
  });

  it('目录前缀触发：只出文件节，按末段片段过滤，dir 带斜杠后缀 + insert 续触发', () => {
    const items = buildMentionItems(parseMentionQuery('src/gui/'), src);
    // 源顺序即服务端字典序（readdir 排序）；本层不再重排。
    expect(items.map((i) => i.label)).toEqual([
      'src/gui/main.ts',
      'src/gui/App.tsx',
      'src/gui/components/',
    ]);
    expect(items.every((i) => i.kind === 'file' && i.section === '文件')).toBe(true);
    const dir = items.find((i) => i.label === 'src/gui/components/');
    expect(dir).toMatchObject({ insert: '@src/gui/components/' });
    const file = items.find((i) => i.label === 'src/gui/main.ts');
    expect(file).toMatchObject({ path: 'src/gui/main.ts' });
  });

  it('目录前缀 + 片段过滤', () => {
    const items = buildMentionItems(parseMentionQuery('src/gui/ma'), src);
    expect(items.map((i) => i.label)).toEqual(['src/gui/main.ts']);
  });

  it('文件目录参数（workspace/files 的 dir）', () => {
    expect(fileDirOf(parseMentionQuery('src/'))).toBe('src');
    expect(fileDirOf(parseMentionQuery('x'))).toBe('');
  });
});
