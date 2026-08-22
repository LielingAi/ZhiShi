/**
 * 1.2.0 — 报告导出编排（report/export.ts）unit tests。
 * deps 全注入(事件/transcript/批准/回收 exec/叙述/写盘/时钟),覆盖:
 * 快乐路径(批准 objects 列全 + 叙述合并 + meta)、无记录/无历史、
 * 批准拒绝、LLM 失败降级、docker 证据降级、sanitize 脱敏。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { EnvironmentEntry } from '../../shared/config-types';
import type { EnvExec } from '../loop/env-exec';
import type { LoopTranscript } from '../loop/transcript';
import type { ResearchEvent } from '../memory/store';
import { exportReport, type ExportReportDeps } from './export';

const WS = mkdtempSync(join(tmpdir(), 'zhishi-report-export-test-'));

afterAll(() => {
  rmSync(WS, { recursive: true, force: true });
});

const NOW = new Date(2026, 7, 21, 10, 30).getTime();

const EVENTS: ResearchEvent[] = [
  { id: 1, ts: 100, workspace: WS, taskKind: 'pentest', outcome: 'success', bugClass: 'sql-injection', summary: 'SQLi 成功' },
  { id: 2, ts: 200, workspace: WS, taskKind: 'pentest', outcome: 'success', summary: '拿到 flag{abc123}', trajectoryRef: '/work/flag.txt' },
];

const TRANSCRIPT: LoopTranscript = {
  loopSessionId: 'line-1',
  entries: [
    { role: 'assistant', toolCalls: [{ name: 'env_exec', argsSummary: '{"command":"sqlmap ..."}' }] },
    { role: 'tool', toolName: 'env_exec', isError: false, text: 'flag{abc123}' },
  ],
  truncated: false,
  totalMessages: 2,
  meta: null,
};

const SSH_ENTRY = { id: 'pwn-vm', kind: 'ssh', host: '192.168.1.10', user: 'root' } as EnvironmentEntry;

interface Captured {
  approvalObjects?: string[];
  wrote?: { reportDir: string; files: Record<string, string> };
  narrateCalls: number;
}

function makeDeps(overrides: Partial<ExportReportDeps> = {}): { deps: ExportReportDeps; captured: Captured } {
  const captured: Captured = { narrateCalls: 0 };
  const deps: ExportReportDeps = {
    listWorkspaceEvents: () => EVENTS,
    findLoopSessionId: () => 'line-1',
    loadTranscript: () => TRANSCRIPT,
    requestApproval: async (objects) => { captured.approvalObjects = objects; return true; },
    narrate: async () => {
      captured.narrateCalls++;
      return { text: '<<<SECTION:target>>>\n本次针对目标开展渗透测试。\n<<<END>>>' };
    },
    modelId: 'kimi-coding/k3',
    writeOutputs: (reportDir, files) => { captured.wrote = { reportDir, files }; },
    exec: (async () => ({ exitCode: 0, stdout: '', stderr: '' })) satisfies EnvExec,
    now: () => NOW,
    ...overrides,
  };
  return { deps, captured };
}

describe('exportReport 快乐路径', () => {
  it('批准 objects 列全(落点+N 个证据+敏感计数);叙述合并;meta 完整', async () => {
    const { deps, captured } = makeDeps();
    const result = await exportReport({ workspace: WS, env: { envId: 'pwn-vm', entry: SSH_ENTRY } }, deps);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // 批准清单:落点 + 证据文件 + 敏感项计数(flag×1 内网 IP×1,来自骨架渲染文本)
    const objects = captured.approvalObjects!;
    expect(objects[0]).toContain(`报告落点：${result.data.reportDir}`);
    expect(objects[0]).toContain(join('output', 'reports'));
    expect(objects.some((o) => o.includes('证据回收：1 个文件'))).toBe(true);
    expect(objects.some((o) => o.includes('#2 /work/flag.txt'))).toBe(true);
    const sensitiveLine = objects.find((o) => o.startsWith('敏感项命中：'))!;
    // flag{abc123} 在 事件#2 summary(recon/exploit-chain 两行) + transcript 摘录 各出现
    expect(sensitiveLine).toMatch(/^敏感项命中：flag×\d+$/);
    expect(sensitiveLine).not.toContain('内网 IP'); // 骨架不含 host(环境条目不进报告文本)
    expect(result.data.sanitized).toBe(false);
    expect(result.data.degraded).toEqual([]);
    expect(result.data.evidenceCount).toBe(1);

    // 报告:叙述在前 + 事实钉死 + 证据已回收标注
    const md = captured.wrote!.files['report.md'];
    expect(md).toContain('本次针对目标开展渗透测试。');
    expect(md).toContain('#1 pentest/success · sql-injection：SQLi 成功');
    expect(md).toContain('已回收至');
    expect(md).not.toContain('未经叙述润色');

    // meta.json
    const meta = JSON.parse(captured.wrote!.files['meta.json']);
    expect(meta.workspace).toBe(WS);
    expect(meta.envId).toBe('pwn-vm');
    expect(meta.model).toBe('kimi-coding/k3');
    expect(meta.eventIds).toEqual([1, 2]);
    expect(meta.degraded).toEqual([]);
    expect(meta.truncated).toBe(false);
    expect(meta.sanitized).toBe(false);
    expect(meta.evidence.recovered).toBe(1);
    expect(meta.generatedAt).toBe(new Date(NOW).toISOString());
    // 无 expert_refs 的事件 → meta 不出 expertRefs 字段,报告不出引用节(旧行为零变化)
    expect(meta.expertRefs).toBeUndefined();
    expect(md).not.toContain('引用的专家知识');
  });
});

describe('exportReport 专家知识引用（1.2.2）', () => {
  it('事件带 expert_refs + lookup 注入 → 报告出「引用的专家知识」节,meta.expertRefs 清单双向可追', async () => {
    const eventsWithRefs: ResearchEvent[] = [
      { ...EVENTS[0], expertRefs: [12] },
      { ...EVENTS[1], expertRefs: [12, 99] },
    ];
    const { deps, captured } = makeDeps({
      listWorkspaceEvents: () => eventsWithRefs,
      lookupExpertEntry: (id) => (id === 12 ? { title: 'Web 注入三板斧', kind: 'technique' } : null),
    });
    const result = await exportReport({ workspace: WS, env: { envId: 'pwn-vm', entry: SSH_ENTRY } }, deps);
    expect(result.success).toBe(true);

    const md = captured.wrote!.files['report.md'];
    expect(md).toContain('## 引用的专家知识');
    expect(md).toContain('- #12《Web 注入三板斧》（technique）：事件 #1 #2 的决策依据');
    expect(md).toContain('- #99（条目已删除或不可考）：事件 #2 曾引用');

    const meta = JSON.parse(captured.wrote!.files['meta.json']);
    expect(meta.expertRefs).toEqual([
      { entryId: 12, title: 'Web 注入三板斧', kind: 'technique', eventIds: [1, 2] },
      { entryId: 99, eventIds: [2] },
    ]);
  });

  it('事件带 expert_refs 但未注入 lookup → 引用节按「不可考」降级,导出照常成功', async () => {
    const eventsWithRefs: ResearchEvent[] = [{ ...EVENTS[0], expertRefs: [5] }];
    const { deps, captured } = makeDeps({ listWorkspaceEvents: () => eventsWithRefs });
    const result = await exportReport({ workspace: WS, env: { envId: 'pwn-vm', entry: SSH_ENTRY } }, deps);
    expect(result.success).toBe(true);
    expect(captured.wrote!.files['report.md']).toContain('#5（条目已删除或不可考）：事件 #1 曾引用');
    const meta = JSON.parse(captured.wrote!.files['meta.json']);
    expect(meta.expertRefs).toEqual([{ entryId: 5, eventIds: [1] }]);
  });
});

describe('exportReport 错误路径', () => {
  it('无研究事件 → 「没有可导出的研究记录」,不问人不落盘', async () => {
    const { deps, captured } = makeDeps({ listWorkspaceEvents: () => [] });
    const result = await exportReport({ workspace: WS, env: { envId: 'pwn-vm', entry: SSH_ENTRY } }, deps);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('没有可导出的研究记录');
    expect(captured.approvalObjects).toBeUndefined();
    expect(captured.wrote).toBeUndefined();
  });

  it('无 env-sessions 映射 / transcript 缺失或空 → 同样报无记录', async () => {
    const noLine = makeDeps({ findLoopSessionId: () => undefined });
    const r1 = await exportReport({ workspace: WS, env: { envId: 'pwn-vm', entry: SSH_ENTRY } }, noLine.deps);
    expect(r1.success).toBe(false);

    const noTranscript = makeDeps({ loadTranscript: () => null });
    const r2 = await exportReport({ workspace: WS, env: { envId: 'pwn-vm', entry: SSH_ENTRY } }, noTranscript.deps);
    expect(r2.success).toBe(false);

    const emptyTranscript = makeDeps({ loadTranscript: () => ({ ...TRANSCRIPT, entries: [] }) });
    const r3 = await exportReport({ workspace: WS, env: { envId: 'pwn-vm', entry: SSH_ENTRY } }, emptyTranscript.deps);
    expect(r3.success).toBe(false);
    if (!r3.success) expect(r3.error).toContain('没有可导出的研究记录');
  });

  it('批准拒绝 → error,不回收不落盘不调 LLM', async () => {
    let execCalled = 0;
    const exec: EnvExec = async () => { execCalled++; return { exitCode: 0, stdout: '', stderr: '' }; };
    const { deps, captured } = makeDeps({ requestApproval: async () => false, exec });
    const result = await exportReport({ workspace: WS, env: { envId: 'pwn-vm', entry: SSH_ENTRY } }, deps);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('已被拒绝或超时');
    expect(execCalled).toBe(0);
    expect(captured.narrateCalls).toBe(0);
    expect(captured.wrote).toBeUndefined();
  });
});

describe('exportReport 降级路径', () => {
  it('LLM 失败 → 纯骨架 + 「未经叙述润色」标注,导出照常成功', async () => {
    const { deps, captured } = makeDeps({ narrate: async () => ({ error: 'upstream 500' }) });
    const result = await exportReport({ workspace: WS, env: { envId: 'pwn-vm', entry: SSH_ENTRY } }, deps);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.degraded.some((d) => d.includes('未经叙述润色'))).toBe(true);
    const md = captured.wrote!.files['report.md'];
    expect(md).toContain('> 叙述润色失败（upstream 500）——报告未经叙述润色');
    expect(md).toContain('SQLi 成功'); // 事实骨架完整
    const meta = JSON.parse(captured.wrote!.files['meta.json']);
    expect(meta.degraded.some((d: string) => d.includes('叙述润色失败'))).toBe(true);
  });

  it('模型不可用(modelId null) → 不调 narrate,降级标注', async () => {
    const { deps, captured } = makeDeps({ modelId: null });
    const result = await exportReport({ workspace: WS, env: { envId: 'pwn-vm', entry: SSH_ENTRY } }, deps);
    expect(result.success).toBe(true);
    expect(captured.narrateCalls).toBe(0);
    if (!result.success) return;
    expect(result.data.degraded.some((d) => d.includes('模型不可用'))).toBe(true);
  });

  it('docker 环境 → 证据降级标注进报告与 meta,报告照常落盘', async () => {
    const docker = { id: 'pentest-box', kind: 'docker', container: 'c1' } as EnvironmentEntry;
    const { deps, captured } = makeDeps();
    const result = await exportReport({ workspace: WS, env: { envId: 'pentest-box', entry: docker } }, deps);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.evidenceCount).toBe(0);
    expect(result.data.degraded.some((d) => d.includes('docker 环境回收未支持'))).toBe(true);
    const md = captured.wrote!.files['report.md'];
    expect(md).toContain('降级：docker 环境回收未支持——保留环境内路径');
    expect(md).toContain('`/work/flag.txt`'); // 环境内路径保留
    const meta = JSON.parse(captured.wrote!.files['meta.json']);
    expect(meta.evidence.degraded).toBe(1);
  });

  it('单个证据 scp 失败 → 该证据降级,报告含降级标注', async () => {
    const exec: EnvExec = async () => ({ exitCode: 1, stdout: '', stderr: 'Permission denied' });
    const { deps, captured } = makeDeps({ exec });
    const result = await exportReport({ workspace: WS, env: { envId: 'pwn-vm', entry: SSH_ENTRY } }, deps);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.evidenceCount).toBe(0);
    expect(result.data.degraded.some((d) => d.includes('Permission denied'))).toBe(true);
    expect(captured.wrote!.files['report.md']).toContain('降级：scp 提取失败(exit=1)');
  });
});

describe('exportReport sanitize', () => {
  it('sanitize:true → 报告敏感项遮蔽为 [redacted:类别],meta 标注 evidence 未脱敏', async () => {
    const { deps, captured } = makeDeps();
    const result = await exportReport({ workspace: WS, sanitize: true, env: { envId: 'pwn-vm', entry: SSH_ENTRY } }, deps);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sanitized).toBe(true);
    const md = captured.wrote!.files['report.md'];
    expect(md).toContain('[redacted:flag]');
    expect(md).not.toContain('flag{abc123}');
    const meta = JSON.parse(captured.wrote!.files['meta.json']);
    expect(meta.sanitized).toBe(true);
    expect(meta.evidence.note).toContain('evidence 文件本体未脱敏');
  });
});
