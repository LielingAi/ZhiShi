/**
 * M1 — tools（loop/tools.ts）unit tests.
 *
 * env_exec 工具定义与 execute 编排：schema 形状、description 写明「环境内
 * 执行，不是宿主机」、execute 经注入 exec 走 env-exec 通道、结果文本格式、
 * 环境未就绪时 execute 按契约 throw（pi loop 转成 isError tool result）。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EnvironmentEntry } from '../../shared/config-types';
import type { EnvExec } from './env-exec';
import {
  createEnvBgTool,
  createEnvExecTool,
  createResearchLogTool,
  formatEnvExecResult,
  ENV_EXEC_TOOL_NAME,
} from './tools';
import { listResearchEvents, resetMemoryStoreForTest } from '../memory/store';

const VM_ENTRY: EnvironmentEntry = {
  id: 'pwn-vm',
  kind: 'vm',
  name: 'pwn-vm（pwn-vm）',
  vmName: 'pwn-vm',
  address: '192.168.152.129',
  user: 'researcher',
  createdAt: '2026-01-01T00:00:00Z',
};

function okExec(stdout: string, exitCode = 0): { exec: EnvExec; commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    exec: async (argv) => {
      commands.push(argv[argv.length - 1]);
      return { exitCode, stdout, stderr: '' };
    },
  };
}

describe('createEnvExecTool', () => {
  it('工具名/描述：写明在选定研究环境内执行，不是宿主机', () => {
    const tool = createEnvExecTool(VM_ENTRY);
    expect(tool.name).toBe(ENV_EXEC_TOOL_NAME);
    expect(tool.description).toContain('不是宿主机');
    expect(tool.description).toContain('pwn-vm（pwn-vm）');
  });

  it('execute：命令经 env-exec 通道执行并格式化结果', async () => {
    const { exec, commands } = okExec('7.0.0-28-generic\n');
    const tool = createEnvExecTool(VM_ENTRY, { exec });
    const result = await tool.execute('tc1', { command: 'uname -r' });
    expect(commands).toEqual(['uname -r']);
    expect(result.content[0].type).toBe('text');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('exit=0');
    expect(text).toContain('7.0.0-28-generic');
    expect(result.details).toEqual({ exitCode: 0, truncated: false });
  });

  it('timeoutMs 参数透传到通道', async () => {
    const timeouts: number[] = [];
    const exec: EnvExec = async (_argv, timeoutMs) => {
      timeouts.push(timeoutMs);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const tool = createEnvExecTool(VM_ENTRY, { exec });
    await tool.execute('tc2', { command: 'id', timeoutMs: 5000 });
    expect(timeouts).toEqual([5000]);
  });

  it('远端非零退出不当错误：exitCode 进 details 与文本', async () => {
    const { exec } = okExec('not found', 127);
    const tool = createEnvExecTool(VM_ENTRY, { exec });
    const result = await tool.execute('tc3', { command: 'missing-cmd' });
    expect(result.details?.exitCode).toBe(127);
    expect((result.content[0] as { text: string }).text).toContain('exit=127');
  });

  it('环境未就绪 → execute throw（AgentTool 契约：throw on failure）', async () => {
    // 无 address 且无 vmx/vmName 定位锚 → ssh/guest 两通道都够不到。
    const tool = createEnvExecTool({ ...VM_ENTRY, address: undefined, vmName: undefined, vmx: undefined });
    await expect(tool.execute('tc4', { command: 'id' })).rejects.toThrow('未就绪');
  });

  it('断网 VM 无 passwordRef → throw 带配置指引(guest 通道,D-T4)', async () => {
    const tool = createEnvExecTool({ ...VM_ENTRY, address: undefined });
    await expect(tool.execute('tc5', { command: 'id' })).rejects.toThrow('passwordRef');
  });
});

describe('formatEnvExecResult', () => {
  it('exit/stdout/stderr 分节；截断时标注', () => {
    const text = formatEnvExecResult({ stdout: 'o', stderr: 'e', exitCode: 1, truncated: true });
    expect(text).toContain('exit=1');
    expect(text).toContain('--- stdout ---\no');
    expect(text).toContain('--- stderr ---\ne');
    expect(text).toContain('truncated');
  });

  it('空流标 (empty)', () => {
    const text = formatEnvExecResult({ stdout: '', stderr: '', exitCode: 0, truncated: false });
    expect(text).toContain('(empty)');
  });
});

describe('createEnvBgTool', () => {
  function scriptedExec(results: Array<string | { exitCode: number; stdout: string; stderr: string }>) {
    const commands: string[] = [];
    let i = 0;
    const exec: EnvExec = async (argv) => {
      commands.push(argv[argv.length - 1]);
      const r = results[i++] ?? { exitCode: 0, stdout: '', stderr: '' };
      return typeof r === 'string' ? { exitCode: 0, stdout: r, stderr: '' } : r;
    };
    return { exec, commands };
  }

  it('start:占用检查→启动,返回 started 文本', async () => {
    const { exec } = scriptedExec(['missing', '  4242\n']);
    const tool = createEnvBgTool(VM_ENTRY, { exec });
    const r = await tool.execute('b1', { action: 'start', command: 'seq 1 10' } as never);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('started');
    expect(text).toContain('pid=4242');
    expect(text).toContain('/tmp/zhishi-bg/bg-'); // 缺省自动 tag
  });

  it('poll/log/kill/list 结果格式化', async () => {
    const { exec } = scriptedExec(['running:9', '64\nhi\n', 'killed:9', 'a\n']);
    const tool = createEnvBgTool(VM_ENTRY, { exec });
    const poll = await tool.execute('b2', { action: 'poll', tag: 't' } as never);
    expect((poll.content[0] as { text: string }).text).toContain('status=running');
    const log = await tool.execute('b3', { action: 'log', tag: 't' } as never);
    expect((log.content[0] as { text: string }).text).toContain('size=64');
    const kill = await tool.execute('b4', { action: 'kill', tag: 't' } as never);
    expect((kill.content[0] as { text: string }).text).toContain('killed:9');
    const list = await tool.execute('b5', { action: 'list' } as never);
    expect((list.content[0] as { text: string }).text).toContain('- a');
  });
});

describe('createResearchLogTool', () => {
  it('合法参数直接落库( harness 原生,不经 shell)', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'zhishi-research-log-tool-'));
    try {
      const tool = createResearchLogTool('E:/work', { baseDir });
      const result = await tool.execute('tc1', {
        task_kind: 'binary',
        outcome: 'success',
        summary: 'ret2win 打通,偏移 72,ret gadget 对齐',
        bug_class: 'stack-overflow',
      });
      expect(result.details?.eventId).toBeGreaterThan(0);
      expect(result.content[0]).toMatchObject({ type: 'text' });
      const events = listResearchEvents({ limit: 10, baseDir });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        workspace: 'E:/work',
        taskKind: 'binary',
        outcome: 'success',
        bugClass: 'stack-overflow',
      });
    } finally {
      resetMemoryStoreForTest();
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('非法 task_kind → throw(落库前校验,不落脏数据)', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'zhishi-research-log-tool-'));
    try {
      const tool = createResearchLogTool('E:/work', { baseDir });
      await expect(
        tool.execute('tc2', {
          task_kind: 'nope' as never,
          outcome: 'success',
          summary: 'x',
        }),
      ).rejects.toThrow('task_kind');
    } finally {
      resetMemoryStoreForTest();
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
