/**
 * M1 — tools（loop/tools.ts）unit tests.
 *
 * env_exec 工具定义与 execute 编排：schema 形状、description 写明「环境内
 * 执行，不是宿主机」、execute 经注入 exec 走 env-exec 通道、结果文本格式、
 * 环境未就绪时 execute 按契约 throw（pi loop 转成 isError tool result）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EnvironmentEntry } from '../../shared/config-types';
import type { EnvExec } from './env-exec';
import {
  createEnvBgTool,
  createArchiveTool,
  createEnvExecTool,
  createResearchLogTool,
  formatEnvExecResult,
  ENV_EXEC_TOOL_NAME,
} from './tools';
import { correctEntity, loadArchive } from './archive';
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

    it('1.6.0:注入 ownerSessionId → 登记带归属线;不注入 → 字段缺席', async () => {
      const h = registryHarness();
      try {
        const { exec } = scriptedExec(['missing', '  4242\n', 'missing', '  4243\n']);
        const owned = createEnvBgTool(VM_ENTRY, { exec, registry: h.registry, ownerSessionId: 'ls-invoke' });
        await owned.execute('p1o', { action: 'start', tag: 'fz-own', command: 'afl-fuzz' } as never);
        expect(h.registry.get('fz-own')?.ownerSessionId).toBe('ls-invoke');
        const unowned = createEnvBgTool(VM_ENTRY, { exec, registry: h.registry });
        await unowned.execute('p1u', { action: 'start', tag: 'fz-free', command: 'afl-fuzz' } as never);
        expect(h.registry.get('fz-free')?.ownerSessionId).toBeUndefined();
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

describe('createArchiveTool（1.4.4 research_archive）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zhishi-archive-tool-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeTool(broadcastFn = vi.fn()) {
    return createArchiveTool({
      getSessionId: () => 's-1',
      getAnchor: () => ({ messageId: '42' }),
      dir,
      broadcastFn,
    });
  }

  it('全操作链路:立假设→记证据→立结论→证伪→纠正→广播 archive:changed', async () => {
    const fn = vi.fn();
    const tool = makeTool(fn);
    const h = await tool.execute('t1', { op: 'hypothesis', text: '输入长度无校验', refs: 'Q#1' });
    expect(h.details?.entityId).toBe('H#1');
    const v = await tool.execute('t2', { op: 'evidence', text: 'SIGSEGV 崩溃', refs: 'H#1', anchor: '第 2 轮 env_exec' });
    expect(v.details?.entityId).toBe('V#1');
    const c = await tool.execute('t3', { op: 'finding', text: '栈溢出可控制 RIP', findingType: 'primitive', refs: 'V#1' });
    expect(c.details?.entityId).toBe('C#1');
    await tool.execute('t4', { op: 'falsify', id: 'H#1', reason: '远程不可达' });
    await tool.execute('t5', { op: 'correct', id: 'C#1', reason: '读错了' });

    const snap = loadArchive('s-1', { dir });
    expect(snap.entities.map((e) => e.id)).toEqual(['H#1', 'V#1', 'C#1']);
    expect(snap.entities[0].status).toBe('falsified');
    expect(snap.entities[1].anchorMessageId).toBe('42'); // 来源锚 = turn 快照
    expect(snap.entities[1].anchorLabel).toBe('第 2 轮 env_exec');
    expect(snap.entities[2].status).toBe('corrected');
    expect(snap.corrections.map((c) => c.id)).toEqual(['R#1', 'R#2']);
    expect(fn).toHaveBeenCalledTimes(5);
    expect((fn.mock.calls[0] as [string, unknown])[0]).toBe('archive:changed');
  });

  it('question/resolve:未决问题立→解决(open→resolved)', async () => {
    const tool = makeTool();
    await tool.execute('t1', { op: 'question', text: '远程入口限制是什么' });
    await tool.execute('t2', { op: 'resolve', id: 'Q#1', note: '源码第 42 行确认' });
    const snap = loadArchive('s-1', { dir });
    expect(snap.entities[0].status).toBe('resolved');
    expect(snap.entities[0].links).toContain('note:源码第 42 行确认');
  });

  it('hypothesis/resolve:假设立→证实(pending→confirmed,按实体类型路由)', async () => {
    const tool = makeTool();
    await tool.execute('t1', { op: 'hypothesis', text: 'writeOpcode 扩展段多写一字节' });
    const r = await tool.execute('t2', { op: 'resolve', id: 'H#1', note: 'V#1 实验证实' });
    expect((r.content[0] as { text: string }).text).toContain('已证实');
    const snap = loadArchive('s-1', { dir });
    expect(snap.entities[0].status).toBe('confirmed');
  });

  it('resolve 对证据/结论/不存在 id 抛错（只作用于 H#/Q#）', async () => {
    const tool = makeTool();
    await tool.execute('t1', { op: 'evidence', text: 'env_exec #1 输出' });
    await expect(tool.execute('t2', { op: 'resolve', id: 'V#1' })).rejects.toThrow(/只作用于假设/);
    await expect(tool.execute('t3', { op: 'resolve', id: 'H#99' })).rejects.toThrow(/不存在/);
  });

  it('finding against:反证挂已存在 V# → 立结论带反证;挂非证据实体 → 拒绝', async () => {
    const tool = makeTool();
    await tool.execute('t1', { op: 'hypothesis', text: 'H' });
    await tool.execute('t2', { op: 'evidence', text: '支持', refs: 'H#1' });
    await tool.execute('t3', { op: 'evidence', text: '反证', refs: 'H#1' });
    const r = await tool.execute('t4', { op: 'finding', text: '结论', refs: 'V#1,H#1', against: 'V#2' });
    expect((r.content[0] as { text: string }).text).toContain('反证 V#2');
    const snap = loadArchive('s-1', { dir });
    expect(snap.entities.find((e) => e.id === 'C#1')!.against).toEqual(['V#2']);
    await expect(tool.execute('t5', { op: 'finding', text: '结论2', refs: 'V#1', against: 'V#99' })).rejects.toThrow(/非证据实体/);
    await expect(tool.execute('t6', { op: 'finding', text: '结论3', refs: 'V#1', against: 'H#1' })).rejects.toThrow(/非证据实体/);
  });

  it('挂链提醒（提醒级不拒绝）:证据不挂 H# → 孤儿区提醒;结论不挂 H# → 断链提醒', async () => {
    const tool = makeTool();
    const r1 = await tool.execute('t1', { op: 'evidence', text: '顺手观察' });
    expect((r1.content[0] as { text: string }).text).toContain('孤儿区');
    const r2 = await tool.execute('t2', { op: 'finding', text: '结论', refs: 'V#1' });
    expect((r2.content[0] as { text: string }).text).toContain('断链');
    // 挂上 H# → 无提醒。
    await tool.execute('t3', { op: 'hypothesis', text: 'H' });
    const r3 = await tool.execute('t4', { op: 'evidence', text: '驱动证据', refs: 'H#1' });
    expect((r3.content[0] as { text: string }).text).not.toContain('孤儿区');
    const r4 = await tool.execute('t5', { op: 'finding', text: '结论2', refs: 'V#2,H#1' });
    expect((r4.content[0] as { text: string }).text).not.toContain('断链');
  });

  it('abandon:假设/问题 → 已搁置(终态,reason 必填);证据/结论/终态实体 → 拒绝', async () => {
    const tool = makeTool();
    await tool.execute('t1', { op: 'hypothesis', text: 'H' });
    await tool.execute('t2', { op: 'question', text: 'Q' });
    await tool.execute('t3', { op: 'evidence', text: 'V' });
    const r = await tool.execute('t4', { op: 'abandon', id: 'H#1', reason: '方向改为协议面' });
    expect((r.content[0] as { text: string }).text).toContain('已搁置');
    let snap = loadArchive('s-1', { dir });
    expect(snap.entities.find((e) => e.id === 'H#1')!.status).toBe('abandoned');
    expect(snap.corrections).toHaveLength(0);
    await tool.execute('t5', { op: 'abandon', id: 'Q#1', reason: '目标下线' });
    snap = loadArchive('s-1', { dir });
    expect(snap.entities.find((e) => e.id === 'Q#1')!.status).toBe('abandoned');
    await expect(tool.execute('t6', { op: 'abandon', id: 'V#1', reason: 'x' })).rejects.toThrow(/不存在/);
    await expect(tool.execute('t7', { op: 'abandon', id: 'H#1', reason: 'x' })).rejects.toThrow(/已有终态/);
    await expect(tool.execute('t8', { op: 'abandon', id: 'H#2' })).rejects.toThrow(/reason/);
  });

  it('参数校验:缺 text/id/reason 抛错,错误文本可读', async () => {
    const tool = makeTool();
    await expect(tool.execute('t1', { op: 'hypothesis' })).rejects.toThrow(/text/);
    await expect(tool.execute('t1', { op: 'falsify' })).rejects.toThrow(/id/);
    await expect(tool.execute('t1', { op: 'falsify', id: 'H#1' })).rejects.toThrow(/reason/);
    await expect(tool.execute('t1', { op: 'nope' })).rejects.toThrow(/未知操作/);
    await expect(tool.execute('t1', { op: 'hypothesis', text: 'x', refs: 'V#1,foo' })).rejects.toThrow(/非法 id/);
  });

  it('人纠正过的实体,模型 correct 被拒(权威序)', async () => {
    const tool = makeTool();
    await tool.execute('t0', { op: 'evidence', text: '实验观察:崩溃复现' });
    await tool.execute('t1', { op: 'finding', text: '结论一', refs: 'V#1' });
    await correctEntity('s-1', { id: 'C#1', by: 'human', reason: '人已终审' }, { dir });
    await expect(tool.execute('t2', { op: 'correct', id: 'C#1', reason: '想翻案' })).rejects.toThrow(/人纠正/);
  });
});

describe('createArchiveTool — 1.4.6 举证强度（finding 强制证据引用）', () => {
  let dir2: string;
  beforeEach(() => {
    dir2 = mkdtempSync(join(tmpdir(), 'zhishi-archive-tool-strict-'));
  });
  afterEach(() => {
    rmSync(dir2, { recursive: true, force: true });
  });

  function makeStrictTool() {
    return createArchiveTool({
      getSessionId: () => 's-strict',
      getAnchor: () => ({}),
      dir: dir2,
    });
  }

  it('finding 无 refs → 拒绝(引导先记证据)', async () => {
    const tool = makeStrictTool();
    await expect(tool.execute('t1', { op: 'finding', text: '没证据的结论' })).rejects.toThrow(/证据支撑/);
  });

  it('finding refs 挂不存在的 V# → 拒绝(证据实体须已存在)', async () => {
    const tool = makeStrictTool();
    await expect(tool.execute('t1', { op: 'finding', text: '结论', refs: 'V#99' })).rejects.toThrow(/证据实体/);
    // 挂 H#(假设)而非 V#(证据)同样拒绝。
    await tool.execute('t0', { op: 'hypothesis', text: '假设一' });
    await expect(tool.execute('t1', { op: 'finding', text: '结论', refs: 'H#1' })).rejects.toThrow(/证据实体/);
  });

  it('先 op=evidence 再 finding refs 挂 V# → 通过(举证链正确形态)', async () => {
    const tool = makeStrictTool();
    await tool.execute('t1', { op: 'evidence', text: 'SIGSEGV at 0x41414141' });
    const ok = await tool.execute('t2', { op: 'finding', text: '栈溢出可控制 RIP', refs: 'V#1' });
    expect(ok.details?.entityId).toBe('C#1');
    expect((ok.content[0] as { text: string }).text).toContain('证据 V#1');
  });
});
