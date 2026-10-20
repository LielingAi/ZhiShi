/**
 * brain（cli/brain.ts）unit tests——zhishi brain serve 的一等命令化。
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { BRAIN_SERVE_MARKER, buildBrainServeArgv, resolveServerDist, runBrainCommand, runBrainServe } from './brain';

describe('resolveServerDist（内置 node 相对定位）', () => {
  it('便携平铺布局：<根>/nodejs/node.exe → <根>/server-dist.js', () => {
    const p = resolveServerDist('D:\\ZhiShi\\nodejs\\node.exe', (c) => c === 'D:\\ZhiShi\\server-dist.js');
    expect(p).toBe('D:\\ZhiShi\\server-dist.js');
  });

  it('安装包布局：resources/nodejs → resources/server-dist.js', () => {
    const p = resolveServerDist('C:\\Apps\\ZhiShi\\resources\\nodejs\\node.exe', (c) =>
      c === 'C:\\Apps\\ZhiShi\\resources\\server-dist.js',
    );
    expect(p).toBe('C:\\Apps\\ZhiShi\\resources\\server-dist.js');
  });

  it('平铺优先于 resources（两都存在取第一个候选）', () => {
    const p = resolveServerDist('D:\\ZhiShi\\nodejs\\node.exe', () => true);
    expect(p).toBe('D:\\ZhiShi\\server-dist.js');
  });

  it('都找不到 → null', () => {
    expect(resolveServerDist('D:\\nowhere\\node.exe', () => false)).toBeNull();
  });
});

describe('buildBrainServeArgv（含清扫免疫标记）', () => {
  it('缺省 127.0.0.1:7411 + cwd + 恒带 --zhishi-brain', () => {
    const argv = buildBrainServeArgv('/s/server-dist.js', {});
    expect(argv).toEqual(['/s/server-dist.js', '--host', '127.0.0.1', '--port', '7411', '--agent-dir', process.cwd(), BRAIN_SERVE_MARKER]);
  });

  it('显式 host/port/agentDir 透传；空串回缺省', () => {
    const argv = buildBrainServeArgv('/s/server-dist.js', { host: '  ', port: 7412, agentDir: ' E:\\team-lab ' });
    expect(argv[argv.indexOf('--host') + 1]).toBe('127.0.0.1');
    expect(argv[argv.indexOf('--port') + 1]).toBe('7412');
    expect(argv[argv.indexOf('--agent-dir') + 1]).toBe('E:\\team-lab');
    expect(argv[argv.length - 1]).toBe(BRAIN_SERVE_MARKER);
  });
});

describe('runBrainServe（spawn 编排）', () => {
  it('spawn 参数正确（内置 node + argv），退出码透传', async () => {
    const seen: { file: string; args: string[] }[] = [];
    const fakeSpawn = ((file: string, args: string[]) => {
      seen.push({ file, args });
      const child = new EventEmitter() as EventEmitter & { on: EventEmitter['on'] };
      setImmediate(() => child.emit('exit', 3));
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    const lines: string[] = [];
    const code = await runBrainServe({ spawnImpl: fakeSpawn, log: (m) => lines.push(m), agentDir: 'E:\\team-lab', serverDist: '/s/server-dist.js' });
    expect(code).toBe(3);
    expect(seen).toHaveLength(1);
    expect(seen[0].file).toBe(process.execPath);
    expect(seen[0].args[seen[0].args.length - 1]).toBe(BRAIN_SERVE_MARKER);
    expect(seen[0].args[seen[0].args.indexOf('--agent-dir') + 1]).toBe('E:\\team-lab');
    expect(lines.some((m) => m.includes('serve'))).toBe(true);
  });

  it('spawn 级错误 → 退出码 1 + 错误文案', async () => {
    const fakeSpawn = (() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit('error', new Error('ENOENT')));
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    const errs: string[] = [];
    const code = await runBrainServe({ spawnImpl: fakeSpawn, err: (m) => errs.push(m), serverDist: '/s/server-dist.js' });
    expect(code).toBe(1);
    expect(errs.some((m) => m.includes('spawn 失败'))).toBe(true);
  });
});

describe('runBrainCommand（组分发）', () => {
  it('未知子命令 → 用法 + 退出码 2', async () => {
    const code = await runBrainCommand('oops', {});
    expect(code).toBe(2);
  });

  it('缺子命令 → 用法 + 退出码 0', async () => {
    const code = await runBrainCommand(undefined, {});
    expect(code).toBe(0);
  });
});
