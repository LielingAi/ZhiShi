/**
 * W1 — refs 注入解析(loop/refs.ts)unit tests。
 *
 * parseChatRefs 宽容解析、shQuote/buildReadFileCommand 纯函数、四类 ref
 * 解析(file 小全量/大头尾+行数标注、env 元数据、snapshot 元数据、taskmd)、
 * 单项失败不阻塞。env/vmrun 通道全部注入假实现,绝无 ssh/vmrun。
 */
import { describe, expect, it, vi } from 'vitest';

import type { EnvironmentEntry } from '../../shared/config-types';
import type { EnvExecProcessResult } from './env-exec';
import {
  buildReadFileCommand,
  buildReadTaskmdCommand,
  parseChatRefs,
  REF_FILE_HEAD_LINES,
  REF_FILE_TAIL_LINES,
  resolveChatRefs,
  shQuote,
  type ResolveRefsContext,
} from './refs';

const VM_ENV: EnvironmentEntry = {
  id: 'pwn-vm',
  kind: 'vm',
  vmName: 'pwn-vm',
  vmx: 'D:\\vm\\pwn-vm\\pwn-vm.vmx',
  address: '192.168.152.129',
  user: 'researcher',
  createdAt: '2026-01-01T00:00:00Z',
};

const DOCKER_ENV: EnvironmentEntry = {
  id: 'pwn-docker',
  kind: 'docker',
  container: 'pwn-docker',
  createdAt: '2026-01-01T00:00:00Z',
};

/** 按命令内容路由的假 env 通道。 */
function fakeEnvExec(routes: Array<{ match: string; result: EnvExecProcessResult }>) {
  const calls: string[] = [];
  const exec = async (argv: string[]): Promise<EnvExecProcessResult> => {
    const command = argv[argv.length - 1];
    calls.push(command);
    for (const route of routes) {
      if (command.includes(route.match)) return route.result;
    }
    return { exitCode: 1, stdout: '', stderr: 'no route' };
  };
  return { exec: exec as ResolveRefsContext['envExec'] & ((argv: string[], t: number) => Promise<EnvExecProcessResult>), calls };
}

function ok(stdout: string, exitCode = 0): EnvExecProcessResult {
  return { exitCode, stdout, stderr: '' };
}

function ctx(overrides: Partial<ResolveRefsContext> = {}): ResolveRefsContext {
  return { env: VM_ENV, environments: [VM_ENV, DOCKER_ENV], ...overrides };
}

describe('parseChatRefs(宽容解析)', () => {
  it('undefined/null/空数组 → 空结果', () => {
    expect(parseChatRefs(undefined)).toEqual({ refs: [], invalid: [] });
    expect(parseChatRefs(null)).toEqual({ refs: [], invalid: [] });
    expect(parseChatRefs([])).toEqual({ refs: [], invalid: [] });
  });

  it('四类合法条目全收', () => {
    const { refs, invalid } = parseChatRefs([
      { type: 'file', path: '/work/exp.py' },
      { type: 'env', id: 'pwn-vm' },
      { type: 'snapshot', name: 'snap-clean' },
      { type: 'taskmd' },
    ]);
    expect(refs).toEqual([
      { type: 'file', path: '/work/exp.py' },
      { type: 'env', id: 'pwn-vm' },
      { type: 'snapshot', name: 'snap-clean' },
      { type: 'taskmd' },
    ]);
    expect(invalid).toEqual([]);
  });

  it('坏条目进 invalid,不拖垮好条目', () => {
    const { refs, invalid } = parseChatRefs([
      { type: 'file' }, // 缺 path
      'garbage',
      { type: 'file', path: ' /a.txt ' },
      { type: 'unknown', x: 1 },
    ]);
    expect(refs).toEqual([{ type: 'file', path: '/a.txt' }]);
    expect(invalid).toHaveLength(3);
  });

  it('非数组 → invalid 注明', () => {
    expect(parseChatRefs('nope').invalid).toHaveLength(1);
  });
});

describe('纯函数(shQuote / 命令组装)', () => {
  it('shQuote 单引号转义', () => {
    expect(shQuote('/work/a.txt')).toBe(`'/work/a.txt'`);
    expect(shQuote(`it's`)).toBe(`'it'\\''s'`);
  });

  it('buildReadFileCommand 含存在性/行数/头尾协议', () => {
    const cmd = buildReadFileCommand('/work/big.log');
    expect(cmd).toContain(`p='/work/big.log'`);
    expect(cmd).toContain('__ZHISHI_NOT_FOUND__');
    expect(cmd).toContain('__ZHISHI_TOTAL__=');
    expect(cmd).toContain(`head -n ${REF_FILE_HEAD_LINES}`);
    expect(cmd).toContain(`tail -n ${REF_FILE_TAIL_LINES}`);
  });

  it('buildReadTaskmdCommand 探测三个候选路径', () => {
    const cmd = buildReadTaskmdCommand();
    expect(cmd).toContain('$HOME/task.md');
    expect(cmd).toContain('./task.md');
    expect(cmd).toContain('/work/task.md');
  });
});

describe('file ref(经 env 通道)', () => {
  it('小文件:全量 + 行数标注', async () => {
    const { exec, calls } = fakeEnvExec([
      { match: "p='/work/exp.py'", result: ok('__ZHISHI_TOTAL__=3\nline1\nline2\nline3\n') },
    ]);
    const out = await resolveChatRefs(
      { refs: [{ type: 'file', path: '/work/exp.py' }], invalid: [] },
      ctx({ envExec: exec }),
    );
    expect(out).toContain('<context ref="file:/work/exp.py">');
    expect(out).toContain('共 3 行,以下为完整内容');
    expect(out).toContain('line1\nline2\nline3');
    expect(out).toContain('</context>');
    expect(calls).toHaveLength(1);
  });

  it('大文件:头 100 + 尾 50 + 省略行数标注', async () => {
    const head = Array.from({ length: 100 }, (_, i) => `h${i}`).join('\n');
    const tail = Array.from({ length: 50 }, (_, i) => `t${i}`).join('\n');
    const { exec } = fakeEnvExec([
      { match: "p='/work/big.log'", result: ok(`__ZHISHI_TOTAL__=320\n${head}\n__ZHISHI_OMITTED__\n${tail}\n`) },
    ]);
    const out = await resolveChatRefs(
      { refs: [{ type: 'file', path: '/work/big.log' }], invalid: [] },
      ctx({ envExec: exec }),
    );
    expect(out).toContain('共 320 行,以下为头 100 行 + 尾 50 行');
    expect(out).toContain('中间省略约 170 行');
    expect(out).toContain('h0');
    expect(out).toContain('t49');
  });

  it('环境内不存在 → 注明,不算解析失败', async () => {
    const { exec } = fakeEnvExec([
      { match: "p='/work/ghost'", result: ok('__ZHISHI_NOT_FOUND__\n') },
    ]);
    const out = await resolveChatRefs(
      { refs: [{ type: 'file', path: '/work/ghost' }], invalid: [] },
      ctx({ envExec: exec }),
    );
    expect(out).toContain('内不存在该文件');
    expect(out).not.toContain('解析失败');
  });

  it('通道失败/未锚定 → 单项注明不阻塞', async () => {
    const { exec } = fakeEnvExec([
      { match: "p='/x'", result: { exitCode: -1, stdout: '', stderr: '', error: 'ssh 连不上' } },
    ]);
    const out = await resolveChatRefs(
      { refs: [{ type: 'file', path: '/x' }, { type: 'env', id: 'pwn-vm' }], invalid: [] },
      ctx({ envExec: exec }),
    );
    expect(out).toContain('解析失败');
    expect(out).toContain('<context ref="env:pwn-vm">'); // 另一项照常
    const out2 = await resolveChatRefs(
      { refs: [{ type: 'file', path: '/x' }], invalid: [] },
      ctx({ env: null }),
    );
    expect(out2).toContain('未锚定环境');
  });
});

describe('taskmd ref', () => {
  it('找到:带路径标注 + 内容', async () => {
    const { exec } = fakeEnvExec([
      { match: '$HOME/task.md', result: ok('__ZHISHI_PATH__=/home/researcher/task.md\n# 状态\n已验证:canary 关闭\n') },
    ]);
    const out = await resolveChatRefs({ refs: [{ type: 'taskmd' }], invalid: [] }, ctx({ envExec: exec }));
    expect(out).toContain('<context ref="taskmd">');
    expect(out).toContain('/home/researcher/task.md');
    expect(out).toContain('canary 关闭');
  });

  it('找不到:注明已查路径', async () => {
    const { exec } = fakeEnvExec([
      { match: '$HOME/task.md', result: ok('__ZHISHI_NOT_FOUND__\n') },
    ]);
    const out = await resolveChatRefs({ refs: [{ type: 'taskmd' }], invalid: [] }, ctx({ envExec: exec }));
    expect(out).toContain('未找到 task.md');
  });
});

describe('env ref(元数据)', () => {
  it('vm 条目:基底/地址/运行状态(vmrun list 命中 running)', async () => {
    const vmExec = vi.fn(async (argv: string[]) => ({
      exitCode: 0,
      stdout: argv.includes('list')
        ? 'Total running VMs: 1\nD:\\vm\\pwn-vm\\pwn-vm.vmx\n'
        : '',
      stderr: '',
    }));
    const out = await resolveChatRefs(
      { refs: [{ type: 'env', id: 'pwn-vm' }], invalid: [] },
      ctx({ vmExec }),
    );
    expect(out).toContain('id: pwn-vm');
    expect(out).toContain('kind: vm');
    expect(out).toContain('192.168.152.129');
    expect(out).toContain('运行状态: running');
  });

  it('vmrun list 不含该 vmx → stopped;未登记 id → 解析失败', async () => {
    const vmExec = vi.fn(async () => ({ exitCode: 0, stdout: 'Total running VMs: 0\n', stderr: '' }));
    const out = await resolveChatRefs(
      { refs: [{ type: 'env', id: 'pwn-vm' }], invalid: [] },
      ctx({ vmExec }),
    );
    expect(out).toContain('运行状态: stopped');
    const missing = await resolveChatRefs(
      { refs: [{ type: 'env', id: 'ghost' }], invalid: [] },
      ctx({ vmExec }),
    );
    expect(missing).toContain('解析失败');
    expect(missing).toContain('ghost');
  });
});

describe('snapshot ref(元数据)', () => {
  it('vm:listSnapshots 核实存在性,附全量快照清单', async () => {
    const vmExec = vi.fn(async (argv: string[]) => ({
      exitCode: 0,
      stdout: argv.includes('listSnapshots') ? 'Total snapshots: 2\nsnap-clean\nsnap-fuzz\n' : '',
      stderr: '',
    }));
    const out = await resolveChatRefs(
      { refs: [{ type: 'snapshot', name: 'snap-clean' }], invalid: [] },
      ctx({ vmExec }),
    );
    expect(out).toContain('名称: snap-clean');
    expect(out).toContain('存在性: 存在');
    expect(out).toContain('snap-clean, snap-fuzz');
  });

  it('快照不存在 → 注明;docker → 暂未支持;未锚定 → 失败注明', async () => {
    const vmExec = vi.fn(async () => ({ exitCode: 0, stdout: 'Total snapshots: 0\n', stderr: '' }));
    const out = await resolveChatRefs(
      { refs: [{ type: 'snapshot', name: 'nope' }], invalid: [] },
      ctx({ vmExec }),
    );
    expect(out).toContain('存在性: 不存在');
    const docker = await resolveChatRefs(
      { refs: [{ type: 'snapshot', name: 's' }], invalid: [] },
      ctx({ env: DOCKER_ENV }),
    );
    expect(docker).toContain('暂未支持');
    const noEnv = await resolveChatRefs(
      { refs: [{ type: 'snapshot', name: 's' }], invalid: [] },
      ctx({ env: null }),
    );
    expect(noEnv).toContain('解析失败');
  });
});

describe('resolveChatRefs 聚合', () => {
  it('空 refs → 空串;非法条目成失败块;多块空行分隔', async () => {
    expect(await resolveChatRefs({ refs: [], invalid: [] }, ctx())).toBe('');
    const out = await resolveChatRefs(
      { refs: [{ type: 'env', id: 'pwn-docker' }], invalid: ['非法 ref 条目:"x"'] },
      ctx({ vmExec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })) }),
    );
    expect(out).toContain('<context ref="invalid">');
    expect(out).toContain('非法 ref 条目');
    expect(out).toContain('<context ref="env:pwn-docker">');
    expect(out).toContain('\n\n'); // 块间分隔
  });
});
