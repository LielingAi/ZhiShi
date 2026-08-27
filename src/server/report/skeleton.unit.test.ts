/**
 * 1.2.0 — 报告骨架组装（report/skeleton.ts + templates.ts）unit tests。
 *
 * 纯函数覆盖:域模板选择(主 task_kind/兜底)、时间线正序、bug_class 事实、
 * 文件:行号摘录、证据引用收集、截断(砍摘录保事件层)、markdown 渲染
 * (事实钉死 + 叙述引子 + 降级标注)、证据回收回填。
 */
import { describe, expect, it } from 'vitest';

import type { ArchiveSnapshot } from '../loop/archive';
import type { LoopTranscript } from '../loop/transcript';
import type { ResearchEvent } from '../memory/store';
import {
  buildReportSkeleton,
  extractFileLineRefs,
  extractTranscriptExcerpts,
  formatReportTimestamp,
  renderReportMarkdown,
  truncateSkeleton,
  withEvidenceResults,
} from './skeleton';
import { dominantTaskKind, selectDomainTemplate } from './templates';

const WS = 'E:/work/target';

function ev(partial: Partial<ResearchEvent> & Pick<ResearchEvent, 'id' | 'ts' | 'taskKind' | 'outcome' | 'summary'>): ResearchEvent {
  return { workspace: WS, ...partial };
}

function transcript(entries: LoopTranscript['entries']): LoopTranscript {
  return { loopSessionId: 's-1', entries, truncated: false, totalMessages: entries.length, meta: null };
}

const NOW = new Date(2026, 7, 21, 10, 30).getTime();

describe('selectDomainTemplate / dominantTaskKind', () => {
  it('主 task_kind 选域:pentest/whitebox/binary;并列取先出现者', () => {
    const pentest = [
      ev({ id: 1, ts: 100, taskKind: 'pentest', outcome: 'success', summary: 'a' }),
      ev({ id: 2, ts: 200, taskKind: 'pentest', outcome: 'fail', summary: 'b' }),
      ev({ id: 3, ts: 300, taskKind: 'binary', outcome: 'fail', summary: 'c' }),
    ];
    expect(dominantTaskKind(pentest)).toBe('pentest');
    expect(selectDomainTemplate(pentest).domain).toBe('pentest');
    expect(selectDomainTemplate(pentest).sections.map((s) => s.key)).toEqual([
      'target', 'recon', 'findings', 'exploit-chain', 'repro', 'fix',
    ]);

    const tie = [
      ev({ id: 1, ts: 200, taskKind: 'binary', outcome: 'fail', summary: 'c' }),
      ev({ id: 2, ts: 100, taskKind: 'whitebox', outcome: 'fail', summary: 'w' }),
    ];
    expect(dominantTaskKind(tie)).toBe('whitebox'); // 并列取 ts 最早
    expect(selectDomainTemplate(tie).sections.map((s) => s.key)).toEqual([
      'input-surface', 'confirmed-vulns', 'evidence', 'fix',
    ]);
  });

  it('域映射:ctf/redteam→pentest,malware→binary,ai-security/intel→通用;空事件→通用', () => {
    const kinds: Array<[ResearchEvent['taskKind'], string]> = [
      ['ctf', 'pentest'], ['redteam', 'pentest'], ['malware', 'binary'],
      ['ai-security', 'generic'], ['intel', 'generic'],
    ];
    for (const [kind, domain] of kinds) {
      expect(selectDomainTemplate([ev({ id: 1, ts: 1, taskKind: kind, outcome: 'success', summary: 'x' })]).domain).toBe(domain);
    }
    expect(selectDomainTemplate([]).domain).toBe('generic');
    expect(dominantTaskKind([])).toBeUndefined();
  });
});

describe('buildReportSkeleton', () => {
  const events = [
    ev({ id: 2, ts: 200, taskKind: 'pentest', outcome: 'success', summary: '拿到 secrets', trajectoryRef: '/work/poc/secrets.txt' }),
    ev({ id: 1, ts: 100, taskKind: 'pentest', outcome: 'success', bugClass: 'sql-injection', summary: 'SQLi 注入成功' }),
    ev({ id: 3, ts: 300, taskKind: 'pentest', outcome: 'stuck', summary: 'LFI 卡在过滤' }),
  ];
  const tr = transcript([
    { role: 'user', text: '开搞' },
    { role: 'assistant', toolCalls: [{ name: 'env_exec', argsSummary: '{"command":"cat src/db.ts"}' }] },
    { role: 'tool', toolName: 'env_exec', isError: false, text: '漏洞在 src/db.ts:87 与 app/api/login.php:12' },
    { role: 'assistant', text: '确认注入点' },
  ]);

  it('事件按时间正序;eventIds/证据引用收集;target/recon/findings/exploit-chain 事实钉死', () => {
    const s = buildReportSkeleton({ workspace: WS, envId: 'pwn-vm', events, transcript: tr, now: NOW });
    expect(s.domain).toBe('pentest');
    expect(s.eventIds).toEqual([1, 2, 3]); // 入参乱序 → 内部正序
    expect(s.evidenceRefs).toEqual([{ eventId: 2, guestPath: '/work/poc/secrets.txt' }]);
    expect(s.truncated).toBe(false);

    const byKey = new Map(s.sections.map((sec) => [sec.key, sec.facts]));
    expect(byKey.get('target')![0]).toBe(`工作区:${WS}`.replace(':', '：'));
    expect(byKey.get('target')!.some((f) => f.includes('成功 2 / 失败 0 / 卡住 1'))).toBe(true);
    const recon = byKey.get('recon')!;
    expect(recon).toHaveLength(3);
    expect(recon[0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] #1 pentest\/success · sql-injection：SQLi 注入成功$/);
    expect(recon[2]).toContain('#3 pentest/stuck：LFI 卡在过滤');

    const findings = byKey.get('findings')!;
    expect(findings[0]).toContain('sql-injection（#1 success');
    expect(findings.some((f) => f.includes('src/db.ts:87') && f.includes('app/api/login.php:12'))).toBe(true);

    const chain = byKey.get('exploit-chain')!;
    expect(chain).toHaveLength(2); // 只含 success
    expect(chain[0]).toContain('步骤 1（#1');
    expect(chain[1]).toContain('步骤 2（#2');

    // pentest 模板无独立证据节——证据引用挂在「发现」节末尾
    expect(byKey.get('findings')!.some((f) => f === '#2 `/work/poc/secrets.txt`（待回收）')).toBe(true);
    expect(byKey.get('fix')![0]).toBe('涉及漏洞类别：sql-injection');

    // 复现节 = 工具调用+输出原文;自由文本不进
    const repro = byKey.get('repro')!;
    expect(repro.some((f) => f.startsWith('env_exec {"command"'))).toBe(true);
    expect(repro.some((f) => f.startsWith('[env_exec] 漏洞在'))).toBe(true);
    expect(repro.some((f) => f.includes('确认注入点'))).toBe(false);
  });

  it('无 trajectory_ref → 证据节降级文案;无 bug_class → fix 节兜底', () => {
    const plain = [ev({ id: 1, ts: 100, taskKind: 'intel', outcome: 'success', summary: '情报梳理' })];
    const s = buildReportSkeleton({ workspace: WS, envId: 'host', events: plain, transcript: tr, now: NOW });
    const byKey = new Map(s.sections.map((sec) => [sec.key, sec.facts]));
    expect(byKey.get('evidence')![0]).toContain('无 trajectory_ref 登记');
    expect(byKey.get('summary')![0]).toContain('共 1 条研究事件');

    // fix 节兜底用 pentest 模板测(generic 模板无 fix 节)
    const noBug = [ev({ id: 1, ts: 100, taskKind: 'pentest', outcome: 'fail', summary: '没打下来' })];
    const s2 = buildReportSkeleton({ workspace: WS, envId: 'host', events: noBug, transcript: tr, now: NOW });
    expect(s2.sections.find((sec) => sec.key === 'fix')!.facts[0]).toContain('未记录 bug_class');
  });

  it('1.4.4 研究档案投影:结论带证据锚 + 证伪独立成节;无档案零变化', () => {
    const archive: ArchiveSnapshot = {
      sessionId: 's-1',
      updatedAt: 't',
      entities: [
        { id: 'V#1', kind: 'evidence', text: 'SIGSEGV at 0x41414141', status: 'valid', links: ['H#1'], createdAt: 't', updatedAt: 't' },
        { id: 'C#1', kind: 'finding', text: '栈溢出可控制 RIP', status: 'corrected', links: ['V#1'], findingType: 'primitive', createdAt: 't', updatedAt: 't' },
      ],
      corrections: [{ id: 'R#1', targetId: 'C#1', by: 'model', reason: '远程入口截断 64 字节', createdAt: 't' }],
    };
    const s = buildReportSkeleton({ workspace: WS, envId: 'pwn-vm', events, transcript: tr, now: NOW, archive });
    expect(s.archiveMarkdown).toContain('## 研究结论');
    expect(s.archiveMarkdown).toContain('—— 证据：V#1');
    expect(s.archiveMarkdown).toContain('## 证伪与纠正');
    const md = renderReportMarkdown(s);
    expect(md).toContain('## 研究结论');
    expect(md).toContain('（已纠正）');
    // 无档案 → archiveMarkdown 不存在,报告零变化。
    const bare = buildReportSkeleton({ workspace: WS, envId: 'pwn-vm', events, transcript: tr, now: NOW });
    expect(bare.archiveMarkdown).toBeUndefined();
    expect(renderReportMarkdown(bare)).not.toContain('## 研究结论');
  });
});

describe('extractTranscriptExcerpts / extractFileLineRefs', () => {
  it('摘录:工具调用+工具结果,错误结果带标记;文件:行号去重', () => {
    const entries: LoopTranscript['entries'] = [
      { role: 'assistant', toolCalls: [{ name: 'env_exec', argsSummary: '{"command":"id"}' }] },
      { role: 'tool', toolName: 'env_exec', isError: true, text: 'boom at main.c:10 and main.c:10 again' },
      { role: 'assistant', text: 'assistant 自由文本不进摘录' },
      { role: 'user', text: '用户文本也不进' },
    ];
    const excerpts = extractTranscriptExcerpts(entries);
    expect(excerpts).toHaveLength(2);
    expect(excerpts[1]).toContain('[env_exec 错误]');
    expect(extractFileLineRefs(entries)).toEqual(['main.c:10']);
  });
});

describe('truncateSkeleton', () => {
  it('超预算砍 transcript 摘录,事件层完整保留并标 truncated', () => {
    const events = [
      ev({ id: 1, ts: 100, taskKind: 'pentest', outcome: 'success', bugClass: 'xss', summary: 's1' }),
      ev({ id: 2, ts: 200, taskKind: 'pentest', outcome: 'fail', summary: 's2' }),
    ];
    const big = 'x'.repeat(290);
    const tr = transcript(
      Array.from({ length: 10 }, (_, i) => ({ role: 'tool' as const, toolName: 'env_exec', isError: false, text: `${i}:${big}` })),
    );
    const s = buildReportSkeleton({ workspace: WS, envId: 'e', events, transcript: tr, now: NOW });
    const fullLen = renderReportMarkdown(s).length;
    expect(fullLen).toBeGreaterThan(1500);

    const t = truncateSkeleton(s, 1500);
    expect(t.truncated).toBe(true);
    expect(renderReportMarkdown(t).length).toBeLessThanOrEqual(1500);
    const byKey = new Map(t.sections.map((sec) => [sec.key, sec.facts]));
    expect(byKey.get('recon')).toHaveLength(2); // 事件层不动
    expect(byKey.get('repro')!.length).toBeLessThan(s.excerpts.length);

    expect(truncateSkeleton(s, 1_000_000)).toBe(s); // 预算内原样返回
  });
});

describe('withEvidenceResults / renderReportMarkdown', () => {
  it('回收结果回填证据节(recovered/degraded);渲染:叙述在前事实在后,降级标注进头部', () => {
    const events = [
      ev({ id: 1, ts: 100, taskKind: 'binary', outcome: 'success', summary: '崩溃复现', trajectoryRef: '/tmp/crash.poc' }),
      ev({ id: 2, ts: 200, taskKind: 'binary', outcome: 'success', summary: '控制 rip', trajectoryRef: '/tmp/exploit.py' }),
    ];
    const s = buildReportSkeleton({ workspace: WS, envId: 'fuzz-vm', events, transcript: transcript([]), now: NOW });
    expect(s.domain).toBe('binary');

    const filled = withEvidenceResults(s, [
      { eventId: 1, guestPath: '/tmp/crash.poc', status: 'recovered', savedTo: `${WS}/output/reports/x/evidence/crash.poc` },
      { eventId: 2, guestPath: '/tmp/exploit.py', status: 'degraded', note: 'scp 提取失败(exit=1)——保留环境内路径' },
    ]);
    const evidenceFacts = filled.sections.find((sec) => sec.key === 'evidence')!.facts;
    expect(evidenceFacts[0]).toContain('已回收至');
    expect(evidenceFacts[1]).toContain('降级：scp 提取失败');

    const md = renderReportMarkdown(filled, {
      narration: new Map([['crash-analysis', '先在入口触发崩溃，再确认控制流劫持。']]),
      headerNotes: ['未经叙述润色（测试标注）'],
    });
    expect(md).toContain('# 安全研究报告（二进制分析）');
    expect(md).toContain('> 未经叙述润色（测试标注）');
    expect(md).toContain('先在入口触发崩溃，再确认控制流劫持。');
    // 事实恒在,与叙述并存
    expect(md).toContain('- [');
    expect(md).toContain('#1 binary/success：崩溃复现');
    expect(md).toContain('已回收至');
    expect(md).toContain('降级：scp 提取失败');
  });

  it('无叙述时只有事实骨架;空事实节渲染占位行', () => {
    const events = [ev({ id: 1, ts: 100, taskKind: 'pentest', outcome: 'fail', summary: '没成' })];
    const s = buildReportSkeleton({ workspace: WS, envId: 'e', events, transcript: transcript([]), now: NOW });
    const md = renderReportMarkdown(s);
    expect(md).toContain('（本节无事实记录）'); // exploit-chain 无 success / repro 空
    expect(md).not.toContain('<<<SECTION');
  });
});

describe('formatReportTimestamp', () => {
  it('YYYYMMDD-HHmm', () => {
    expect(formatReportTimestamp(NOW)).toMatch(/^\d{8}-\d{4}$/);
  });
});

describe('引用的专家知识（1.2.2 expert_refs）', () => {
  const citedEvents = [
    ev({ id: 1, ts: 100, taskKind: 'pentest', outcome: 'success', summary: 'SQLi 成功', expertRefs: [12] }),
    ev({ id: 2, ts: 200, taskKind: 'pentest', outcome: 'success', summary: '拿到 flag', expertRefs: [7, 12] }),
  ];
  const lookup = (id: number) =>
    id === 12
      ? { title: 'Web 注入三板斧', kind: 'technique' }
      : id === 7
        ? { title: 'LFI 过滤绕过思路', kind: 'idea' }
        : null;

  it('有引用 → 追加 factOnly 节:条目按 id 升序聚合,事件双向可追;narration 不回填该节', () => {
    const s = buildReportSkeleton({
      workspace: WS, envId: 'pwn-vm', events: citedEvents, transcript: transcript([]), now: NOW,
      lookupExpertEntry: lookup,
    });
    expect(s.expertRefs).toEqual([
      { entryId: 7, title: 'LFI 过滤绕过思路', kind: 'idea', eventIds: [2] },
      { entryId: 12, title: 'Web 注入三板斧', kind: 'technique', eventIds: [1, 2] },
    ]);
    const sec = s.sections.find((x) => x.key === 'expert-refs')!;
    expect(sec.title).toBe('引用的专家知识');
    expect(sec.factOnly).toBe(true);
    expect(sec.facts).toEqual([
      '#7《LFI 过滤绕过思路》（idea）：事件 #2 的决策依据',
      '#12《Web 注入三板斧》（technique）：事件 #1 #2 的决策依据',
    ]);

    // 渲染:节在;即使 narration 恶意带上该节 key 也被忽略
    const md = renderReportMarkdown(s, {
      narration: new Map([['expert-refs', 'LLM 不该写进来的话'], ['recon', '正常叙述']]),
    });
    expect(md).toContain('## 引用的专家知识');
    expect(md).toContain('- #12《Web 注入三板斧》（technique）：事件 #1 #2 的决策依据');
    expect(md).not.toContain('LLM 不该写进来的话');
    expect(md).toContain('正常叙述');
  });

  it('条目已删除/未注入 lookup → 按「不可考」降级渲染,不阻塞', () => {
    const s = buildReportSkeleton({
      workspace: WS, envId: 'pwn-vm', events: citedEvents, transcript: transcript([]), now: NOW,
      lookupExpertEntry: () => null,
    });
    const sec = s.sections.find((x) => x.key === 'expert-refs')!;
    expect(sec.facts).toEqual([
      '#7（条目已删除或不可考）：事件 #2 曾引用',
      '#12（条目已删除或不可考）：事件 #1 #2 曾引用',
    ]);

    // 完全不注入 lookup 同样降级
    const s2 = buildReportSkeleton({ workspace: WS, envId: 'e', events: citedEvents, transcript: transcript([]), now: NOW });
    expect(s2.sections.find((x) => x.key === 'expert-refs')!.facts[0]).toContain('不可考');
  });

  it('无引用 → 不出该节,sections 与模板完全一致(旧报告零变化)', () => {
    const plain = [ev({ id: 1, ts: 100, taskKind: 'pentest', outcome: 'success', summary: 'x' })];
    const s = buildReportSkeleton({ workspace: WS, envId: 'e', events: plain, transcript: transcript([]), now: NOW });
    expect(s.expertRefs).toEqual([]);
    expect(s.sections.map((x) => x.key)).toEqual(['target', 'recon', 'findings', 'exploit-chain', 'repro', 'fix']);
    const md = renderReportMarkdown(s);
    expect(md).not.toContain('引用的专家知识');
  });
});
