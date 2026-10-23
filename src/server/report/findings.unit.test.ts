/**
 * 2.1 — 报告目录化（findings.ts）unit tests。
 * 纯确定性渲染：单结论文件 + index 目录；不推断严重度/CVSS。
 */
import { describe, expect, it } from 'vitest';

import type { ArchiveSnapshot } from '../loop/archive';
import type { LoopTranscript } from '../loop/transcript';
import type { ResearchEvent } from '../memory/store';
import { renderFindingDocs, renderReportIndex } from './findings';
import { buildReportSkeleton } from './skeleton';

const WS = 'E:/work/target';

const EVENTS: ResearchEvent[] = [
  { id: 1, ts: 100, workspace: WS, taskKind: 'pentest', outcome: 'success', bugClass: 'sql-injection', summary: 'SQLi 拿到管理员会话' },
];

const TRANSCRIPT: LoopTranscript = {
  loopSessionId: 's',
  entries: [{ role: 'tool', toolName: 'env_exec', isError: false, text: 'uid=0' }],
  truncated: false,
  totalMessages: 1,
  meta: null,
};

function snapshot(): ArchiveSnapshot {
  return {
    sessionId: 's',
    updatedAt: '2026-01-01T00:00:00.000Z',
    corrections: [],
    entities: [
      {
        id: 'C#1',
        kind: 'finding',
        text: '登录接口存在 SQL 注入，可读取任意用户会话',
        status: 'established',
        findingType: 'bug_class',
        links: ['V#1', 'V#2', 'H#1'],
        against: ['V#3'],
        anchorLabel: '第 3 轮 env_exec 输出',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      { id: 'V#1', kind: 'evidence', text: 'sqlmap 返回 200 且带 Set-Cookie', status: 'valid', links: [], createdAt: '', updatedAt: '' },
      { id: 'V#2', kind: 'evidence', text: '布尔盲注延时稳定 5s', status: 'valid', links: [], createdAt: '', updatedAt: '' },
      { id: 'V#3', kind: 'evidence', text: 'WAF 对单引号返回 403', status: 'doubtful', links: [], createdAt: '', updatedAt: '' },
      { id: 'H#1', kind: 'hypothesis', text: '输入未参数化', status: 'confirmed', links: [], createdAt: '', updatedAt: '' },
    ],
  };
}

describe('renderFindingDocs', () => {
  it('每个档案结论一份文件：状态/类型/来源/支持证据/反证齐全', () => {
    const docs = renderFindingDocs(snapshot());
    expect(docs).toHaveLength(1);
    const doc = docs[0]!;
    expect(doc.filename).toBe('findings/C-001.md');
    expect(doc.title).toContain('SQL 注入');
    expect(doc.evidenceCount).toBe(2);
    expect(doc.markdown).toContain('# C#1 · 登录接口存在 SQL 注入');
    expect(doc.markdown).toContain('- 状态：已确立');
    expect(doc.markdown).toContain('- 结论类型：漏洞类别');
    expect(doc.markdown).toContain('第 3 轮 env_exec 输出');
    expect(doc.markdown).toContain('V#1 · 有效');
    expect(doc.markdown).toContain('## 反证');
    expect(doc.markdown).toContain('WAF 对单引号返回 403');
    // 不编评级。
    expect(doc.markdown).toContain('严重度 / CVSS 未记录');
  });

  it('无档案 / 空档案 → 空数组（导出零变化）', () => {
    expect(renderFindingDocs(undefined)).toEqual([]);
    expect(renderFindingDocs({ sessionId: 's', entities: [], corrections: [], updatedAt: '' })).toEqual([]);
  });
});

describe('renderReportIndex', () => {
  it('漏洞清单链接到单文件；目录含 report.md / findings / evidence / zip', () => {
    const docs = renderFindingDocs(snapshot());
    const skeleton = buildReportSkeleton({
      workspace: WS, envId: 'pwn-vm', events: EVENTS, transcript: TRANSCRIPT, now: 1000,
    });
    const index = renderReportIndex({
      skeleton,
      findings: docs,
      narration: new Map([['tldr', '- 打通登录口 SQL 注入\n- 可读取任意用户会话']]),
    });
    expect(index).toContain('## 先看结论');
    expect(index).toContain('可读取任意用户会话');
    expect(index).toContain('## 漏洞清单');
    expect(index).toContain('[C#1](findings/C-001.md)');
    expect(index).toContain('| 漏洞类别 | 已确立 | 2 |');
    expect(index).toContain('[完整报告（叙述 + 事实骨架）](report.md)');
    expect(index).toContain('[打包下载](report.zip)');
    expect(index).toContain('[导出元数据](meta.json)');
  });

  it('无档案结论时回落到事件里的 bug_class 清单（不伪造证据链）', () => {
    const skeleton = buildReportSkeleton({
      workspace: WS, envId: 'pwn-vm', events: EVENTS, transcript: TRANSCRIPT, now: 1000,
    });
    const index = renderReportIndex({ skeleton, findings: [] });
    expect(index).toContain('尚未形成带证据链的档案结论');
    expect(index).toContain('sql-injection：SQLi 拿到管理员会话');
    // 没有叙述时结论节给确定性统计，不留空节。
    expect(index).toContain('共 1 条研究事件');
  });
});
