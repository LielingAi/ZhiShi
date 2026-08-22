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
import { insertEntry, openExpertStore, resetExpertStoreForTest } from '../expert/store';
import type { ValidatedExpertEntry } from '../expert/validate';
import { createBgRegistry } from './bg-registry';

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
  function scriptedExec(results: Array<string | { exitCode: number; stdout: string; stderr: string; error?: string }>) {
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

  describe('Phase 3:登记表接线', () => {
    type LifecycleEvent =
      | { kind: 'started'; tag: string; pid: number; commandPreview: string }
      | { kind: 'finished'; tag: string; status: 'exited' | 'dead' | 'killed'; exitCode?: number };

    function registryHarness() {
      const dir = mkdtempSync(join(tmpdir(), 'zhishi-bg-tool-'));
      const registry = createBgRegistry({ filePath: join(dir, 'reg.json') });
      const lifecycle: LifecycleEvent[] = [];
      return {
        dir,
        registry,
        lifecycle,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
        onLifecycle: (ev: LifecycleEvent) => { lifecycle.push(ev); },
      };
    }

    it('start 成功 → 登记表登记(tag/pid/envId),生命周期 started 照发', async () => {
      const h = registryHarness();
      try {
        const { exec } = scriptedExec(['missing', '  4242\n']);
        const tool = createEnvBgTool(VM_ENTRY, { exec, registry: h.registry, onLifecycle: h.onLifecycle });
        await tool.execute('p1', { action: 'start', tag: 'fz', command: 'afl-fuzz' } as never);
        expect(h.registry.get('fz')).toMatchObject({ tag: 'fz', pid: 4242, envId: 'pwn-vm', commandPreview: 'afl-fuzz' });
        expect(h.lifecycle).toHaveLength(1);
        expect(h.lifecycle[0]).toMatchObject({ kind: 'started', tag: 'fz', pid: 4242 });
      } finally {
        h.cleanup();
      }
    });

    it('poll 登记过的 tag → 走存活探测通道;running 时登记保留', async () => {
      const h = registryHarness();
      try {
        h.registry.register({ tag: 'fz', pid: 4242, envId: 'pwn-vm', startedAt: Date.now(), commandPreview: 'afl' });
        const { exec, commands } = scriptedExec(['running:4242']);
        const tool = createEnvBgTool(VM_ENTRY, { exec, registry: h.registry, onLifecycle: h.onLifecycle });
        const r = await tool.execute('p2', { action: 'poll', tag: 'fz' } as never);
        expect(commands[0]).toContain('kill -0 $p');
        expect((r.content[0] as { text: string }).text).toContain('status=running');
        expect(h.registry.get('fz')).toBeDefined();
        expect(h.lifecycle).toEqual([]);
      } finally {
        h.cleanup();
      }
    });

    it('poll 观测到终态(exited)→ 清登记 + 广播 finished(带退出码)', async () => {
      const h = registryHarness();
      try {
        h.registry.register({ tag: 'fz', pid: 4242, envId: 'pwn-vm', startedAt: Date.now(), commandPreview: 'afl' });
        const { exec } = scriptedExec(['exited:137']);
        const tool = createEnvBgTool(VM_ENTRY, { exec, registry: h.registry, onLifecycle: h.onLifecycle });
        await tool.execute('p3', { action: 'poll', tag: 'fz' } as never);
        expect(h.registry.get('fz')).toBeUndefined();
        expect(h.lifecycle).toEqual([{ kind: 'finished', tag: 'fz', status: 'exited', exitCode: 137 }]);
      } finally {
        h.cleanup();
      }
    });

    it('探测失败(环境不可达)→ 结果标注「探测失败」,登记保留,不发 finished', async () => {
      const h = registryHarness();
      try {
        h.registry.register({ tag: 'fz', pid: 4242, envId: 'pwn-vm', startedAt: Date.now(), commandPreview: 'afl' });
        const { exec } = scriptedExec([{ exitCode: -1, stdout: '', stderr: '', error: 'ssh: connect timed out' }]);
        const tool = createEnvBgTool(VM_ENTRY, { exec, registry: h.registry, onLifecycle: h.onLifecycle });
        const r = await tool.execute('p4', { action: 'poll', tag: 'fz' } as never);
        expect((r.content[0] as { text: string }).text).toContain('探测失败');
        expect((r.content[0] as { text: string }).text).toContain('status=running');
        expect(h.registry.get('fz')).toBeDefined();
        expect(h.lifecycle).toEqual([]);
      } finally {
        h.cleanup();
      }
    });

    it('kill not-running → 登记表照清(进程已不在),不广播 finished(非本次杀的)', async () => {
      const h = registryHarness();
      try {
        h.registry.register({ tag: 'fz', pid: 4242, envId: 'pwn-vm', startedAt: Date.now(), commandPreview: 'afl' });
        const { exec } = scriptedExec(['not-running']);
        const tool = createEnvBgTool(VM_ENTRY, { exec, registry: h.registry, onLifecycle: h.onLifecycle });
        await tool.execute('p5', { action: 'kill', tag: 'fz' } as never);
        expect(h.registry.get('fz')).toBeUndefined();
        expect(h.lifecycle).toEqual([]);
      } finally {
        h.cleanup();
      }
    });

    it('未初始化全局登记表(registry 未注入)→ 登记降级 no-op,不炸', async () => {
      // 全局单例是 null(unit 池未调 initBgRegistry):start/poll/kill 照常。
      const { exec } = scriptedExec(['missing', '  99\n', 'running:99']);
      const tool = createEnvBgTool(VM_ENTRY, { exec });
      await tool.execute('p6', { action: 'start', tag: 'nx', command: 'sleep 5' } as never);
      const poll = await tool.execute('p7', { action: 'poll', tag: 'nx' } as never);
      expect((poll.content[0] as { text: string }).text).toContain('status=running');
    });
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

  function seedEntry(baseDir: string, title: string): number {
    const value: ValidatedExpertEntry = {
      domain: 'binary', kind: 'technique', title,
      applicability: 'a', content: 'c', criteria: 'k',
      provenance: 'user', reviewer: 'tester', sourceEventId: null, tags: '', enabled: true,
    };
    return insertEntry(openExpertStore(baseDir), value, `hash-${title}`).id;
  }

  it('expert_refs 挂条目 id 落库(逗号串解析+去重);不存在的 id 拒绝', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'zhishi-research-log-tool-'));
    try {
      const e1 = seedEntry(baseDir, '条目一');
      const e2 = seedEntry(baseDir, '条目二');
      const tool = createResearchLogTool('E:/work', { baseDir });
      const result = await tool.execute('tc3', {
        task_kind: 'binary', outcome: 'success', summary: '按条目打通',
        expert_refs: `${e1}, #${e2},${e1}`,
      });
      const events = listResearchEvents({ limit: 10, baseDir });
      expect(events[0].expertRefs).toEqual([e1, e2]);
      expect(result.details?.eventId).toBe(events[0].id);

      await expect(
        tool.execute('tc4', {
          task_kind: 'binary', outcome: 'success', summary: 'x', expert_refs: '4242',
        }),
      ).rejects.toThrow(/不存在的专家条目 id：4242/);
      await expect(
        tool.execute('tc5', {
          task_kind: 'binary', outcome: 'success', summary: 'x', expert_refs: 'abc',
        }),
      ).rejects.toThrow(/非法条目 id/);
    } finally {
      resetMemoryStoreForTest();
      resetExpertStoreForTest();
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('结案晋升提示:success/stuck 带 promote 提示,fail 不带', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'zhishi-research-log-tool-'));
    try {
      const tool = createResearchLogTool('E:/work', { baseDir });
      const ok = await tool.execute('tc6', { task_kind: 'binary', outcome: 'success', summary: '成了' });
      expect((ok.content[0] as { text: string }).text).toContain(
        `zhishi expert promote #${ok.details!.eventId}`,
      );
      expect((ok.content[0] as { text: string }).text).toContain('人审后生效');

      const stuck = await tool.execute('tc7', { task_kind: 'binary', outcome: 'stuck', summary: '卡住结案' });
      expect((stuck.content[0] as { text: string }).text).toContain('expert promote');

      const fail = await tool.execute('tc8', { task_kind: 'binary', outcome: 'fail', summary: '没成' });
      expect((fail.content[0] as { text: string }).text).not.toContain('promote');
      expect((fail.content[0] as { text: string }).text).toContain('研究事件已记录');
    } finally {
      resetMemoryStoreForTest();
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
