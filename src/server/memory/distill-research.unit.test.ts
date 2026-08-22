// 安全蒸馏弧单测（安全研究员版 P1 D3，技术方案 §1.4）：
// prompt 组装（三节契约 / 按域分组 / 空输入）、输出解析容错合并、
// 蒸馏产物存取（keyed 权威覆盖）、research_events 结算幂等、recall 按 kind 分流。
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyResearchDistillResult,
  buildResearchDistillPrompt,
  hasResearchDistilledContent,
  isResearchDistillArcPrompt,
  readResearchDistilled,
  writeResearchDistilled,
  RESEARCH_DISTILL_CRON_PROMPT,
  RESEARCH_DISTILL_INTERVAL_MINUTES,
  RESEARCH_DISTILL_MAX_CHARS_PER_SECTION,
  RESEARCH_MEMORY_INJECT_BUDGET,
  type ResearchDistilledMemory,
} from './distill-research';
import { DISTILL_CRON_PROMPT } from './distill';
import {
  latestKeyedDistilledEntry,
  keyedDistilledEntryJudgedWrong,
  listActive,
  listArchive,
  listUndistilledResearchEvents,
  listUnsettledRecalls,
  logRecallEvents,
  markResearchEventsDistilled,
  putEntry,
  recordResearchEvent,
  resetMemoryStoreForTest,
  settleRecallEvent,
  type ResearchEvent,
} from './store';

let dir: string;
const NOW = Date.parse('2026-08-14T12:00:00Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhishi-research-distill-'));
  resetMemoryStoreForTest();
});

afterEach(() => {
  resetMemoryStoreForTest();
  rmSync(dir, { recursive: true, force: true });
});

const EMPTY: ResearchDistilledMemory = { successPaths: '', failureRoots: '', toolCombos: '' };

const EXISTING: ResearchDistilledMemory = {
  successPaths: '### 域：binary\n- tcache dup 打 __free_hook 仍是 glibc≤2.31 的速通路径。',
  failureRoots: '### 域：pentest\n- 内核漏洞提权失败多为版本指纹没核准。',
  toolCombos: '### 域：binary\n- pwndbg+ROPgadget 够打 ret2libc。',
};

function ev(overrides: Partial<ResearchEvent> & { taskKind: ResearchEvent['taskKind'] }): ResearchEvent {
  return {
    id: 1,
    ts: NOW,
    workspace: '/ws/pwn',
    outcome: 'success',
    summary: 's',
    ...overrides,
  };
}

function wellFormedOutput(overrides?: Partial<ResearchDistilledMemory>): string {
  return `## 成功路径（success-paths）
${overrides?.successPaths ?? '### 域：binary\n- fastbin dup 改 stdout 泄 libc 再接 system。'}

## 失败根因（failure-roots）
${overrides?.failureRoots ?? '### 域：malware\n- 样本带反调试，静态先行可绕。'}

## 工具组合（tool-combos）
${overrides?.toolCombos ?? '### 域：binary\n- gef 的 heap 命令比 pwndbg 快。'}`;
}

describe('D3：哨兵与节奏', () => {
  it('识别安全蒸馏哨兵，不与认知弧哨兵串线', () => {
    expect(isResearchDistillArcPrompt(RESEARCH_DISTILL_CRON_PROMPT)).toBe(true);
    expect(isResearchDistillArcPrompt('帮我分析这个样本')).toBe(false);
    expect(isResearchDistillArcPrompt(DISTILL_CRON_PROMPT)).toBe(false);
  });

  it('节奏 6 小时（研究事件稀疏，比认知弧的每小时慢）', () => {
    expect(RESEARCH_DISTILL_INTERVAL_MINUTES).toBe(360);
  });
});

describe('D3：buildResearchDistillPrompt', () => {
  it('契约含「成功路径 / 失败根因 / 工具组合」三节，标题一字不差', () => {
    const prompt = buildResearchDistillPrompt({ events: [ev({ taskKind: 'binary' })], existing: EMPTY });
    expect(prompt).toContain('## 成功路径（success-paths）');
    expect(prompt).toContain('## 失败根因（failure-roots）');
    expect(prompt).toContain('## 工具组合（tool-combos）');
  });

  it('事件按研究域（task_kind）分组，域序按 RESEARCH_TASK_KINDS', () => {
    const prompt = buildResearchDistillPrompt({
      events: [
        ev({ id: 1, taskKind: 'ctf', summary: 'ctf 题：babyheap 复现' }),
        ev({ id: 2, taskKind: 'binary', outcome: 'fail', bugClass: 'uaf', summary: 'uaf 利用失败：堆喷布局不稳' }),
        ev({ id: 3, taskKind: 'binary', outcome: 'stuck', summary: '卡在 canary 泄露' }),
      ],
      existing: EMPTY,
    });
    const binaryIdx = prompt.indexOf('### 域：binary');
    const ctfIdx = prompt.indexOf('### 域：ctf');
    expect(binaryIdx).toBeGreaterThan(-1);
    expect(ctfIdx).toBeGreaterThan(-1);
    expect(binaryIdx).toBeLessThan(ctfIdx); // binary 排在 ctf 前（枚举序）
    expect(prompt).toContain('uaf 利用失败：堆喷布局不稳');
    expect(prompt).toContain('uaf'); // bug_class 进原料行
    // 无事件的域不出现。
    expect(prompt).not.toContain('### 域：intel');
  });

  it('已有蒸馏内容与会话摘录进 prompt；空输入有占位（runner 层直接跳过零产出）', () => {
    const prompt = buildResearchDistillPrompt({
      events: [],
      sessionExcerpts: ['AI: 堆喷 256 次后稳定拿 shell'],
      existing: EXISTING,
    });
    expect(prompt).toContain('（无未结算研究事件）');
    expect(prompt).toContain('tcache dup 打 __free_hook');
    expect(prompt).toContain('堆喷 256 次后稳定拿 shell');
  });
});

describe('D3：applyResearchDistillResult 容错合并', () => {
  it('三节齐全 → 全部采纳', () => {
    const { distilled, warnings } = applyResearchDistillResult(EMPTY, wellFormedOutput());
    expect(distilled.successPaths).toContain('fastbin dup');
    expect(distilled.failureRoots).toContain('反调试');
    expect(distilled.toolCombos).toContain('gef');
    expect(warnings).toHaveLength(0);
  });

  it('缺节保留原文并告警（残差守恒）', () => {
    const output = `## 成功路径（success-paths）\n新路径。`;
    const { distilled, warnings } = applyResearchDistillResult(EXISTING, output);
    expect(distilled.successPaths).toBe('新路径。');
    expect(distilled.failureRoots).toBe(EXISTING.failureRoots);
    expect(distilled.toolCombos).toBe(EXISTING.toolCombos);
    expect(warnings.some((w) => w.includes('failureRoots'))).toBe(true);
    expect(warnings.some((w) => w.includes('toolCombos'))).toBe(true);
  });

  it('整体解析失败（无任何 "## " 分节）→ 三节全保留原文', () => {
    const { distilled, warnings } = applyResearchDistillResult(EXISTING, '模型说了一堆废话但没有分节');
    expect(distilled).toEqual(EXISTING);
    expect(warnings.some((w) => w.includes('解析失败'))).toBe(true);
  });

  it('空节视为缺失（保留原文）；超上限截断并告警', () => {
    const long = 'x'.repeat(RESEARCH_DISTILL_MAX_CHARS_PER_SECTION + 100);
    const output = `## 成功路径（success-paths）\n\n## 失败根因（failure-roots）\n${long}\n\n## 工具组合（tool-combos）\n组合。`;
    const { distilled, warnings } = applyResearchDistillResult(EXISTING, output);
    expect(distilled.successPaths).toBe(EXISTING.successPaths);
    expect(distilled.failureRoots).toHaveLength(RESEARCH_DISTILL_MAX_CHARS_PER_SECTION);
    expect(distilled.toolCombos).toBe('组合。');
    expect(warnings.some((w) => w.includes('截断'))).toBe(true);
  });

  it('兜底：恰好三节但标题全认不出 → 按出现顺序映射并告警', () => {
    const output = `## Alpha\n甲。\n\n## Beta\n乙。\n\n## Gamma\n丙。`;
    const { distilled, warnings } = applyResearchDistillResult(EMPTY, output);
    expect(distilled.successPaths).toBe('甲。');
    expect(distilled.failureRoots).toBe('乙。');
    expect(distilled.toolCombos).toBe('丙。');
    expect(warnings.some((w) => w.includes('按出现顺序映射'))).toBe(true);
  });
});

describe('D3：蒸馏产物存取（SQLite，keyed 权威覆盖）', () => {
  it('写入 → 读回；重写 → 新版本取代旧版本（旧版进 archive）', () => {
    expect(hasResearchDistilledContent(readResearchDistilled(dir))).toBe(false);

    writeResearchDistilled(EXISTING, dir);
    const first = readResearchDistilled(dir);
    expect(first).toEqual(EXISTING);
    expect(hasResearchDistilledContent(first)).toBe(true);

    // 成功路径与失败根因都落在 vuln-pattern（不同 key 并存），工具组合落 tool-combo。
    expect(listActive('vuln-pattern', dir, NOW)).toHaveLength(2);
    expect(listActive('tool-combo', dir, NOW)).toHaveLength(1);

    writeResearchDistilled({ ...EXISTING, successPaths: '### 域：binary\n- 新路径。' }, dir);
    const second = readResearchDistilled(dir);
    expect(second.successPaths).toContain('新路径');
    expect(second.failureRoots).toBe(EXISTING.failureRoots);
    // 同 key 恒 1 条权威：vuln-pattern 仍 2 条活跃，旧版进 archive。
    expect(listActive('vuln-pattern', dir, NOW)).toHaveLength(2);
    expect(listArchive(dir).some((e) => e.content.includes('tcache dup'))).toBe(true);
  });

  it('空节不写入（零产出语义）；全空不写任何条目', () => {
    writeResearchDistilled({ successPaths: '只有路径。', failureRoots: '  ', toolCombos: '' }, dir);
    expect(readResearchDistilled(dir).successPaths).toBe('只有路径。');
    expect(listActive('tool-combo', dir, NOW)).toHaveLength(0);

    writeResearchDistilled(EMPTY, dir);
    expect(listActive('vuln-pattern', dir, NOW)).toHaveLength(1); // 没有新增
  });
});

describe('D3：research_events 结算（写库即结算，幂等）', () => {
  function log3(): number[] {
    const a = recordResearchEvent({ workspace: '/ws/a', taskKind: 'binary', outcome: 'success', summary: 'e1' }, dir, NOW - 2000);
    const b = recordResearchEvent({ workspace: '/ws/a', taskKind: 'ctf', outcome: 'fail', summary: 'e2' }, dir, NOW - 1000);
    const c = recordResearchEvent({ workspace: '/ws/b', taskKind: 'intel', outcome: 'stuck', summary: 'e3' }, dir, NOW);
    return [a.id, b.id, c.id];
  }

  it('未结算事件按时间正序列出；标记后不再出现', () => {
    const ids = log3();
    const pending = listUndistilledResearchEvents({ baseDir: dir });
    expect(pending.map((e) => e.summary)).toEqual(['e1', 'e2', 'e3']); // 老的先蒸馏

    markResearchEventsDistilled(ids, dir, NOW);
    expect(listUndistilledResearchEvents({ baseDir: dir })).toHaveLength(0);
    // listResearchEvents 不受影响（事件本体还在，只是已结算）。
  });

  it('重复标记幂等；新事件仍会被下一次 tick 捡到', () => {
    const ids = log3();
    markResearchEventsDistilled(ids, dir, NOW);
    markResearchEventsDistilled(ids, dir, NOW + 1000); // 不炸、不变
    expect(listUndistilledResearchEvents({ baseDir: dir })).toHaveLength(0);

    recordResearchEvent({ workspace: '/ws/a', taskKind: 'malware', outcome: 'fail', summary: 'e4' }, dir, NOW + 2000);
    expect(listUndistilledResearchEvents({ baseDir: dir }).map((e) => e.summary)).toEqual(['e4']);
  });

  it('limit 截断；空 ids 标记是 no-op', () => {
    log3();
    expect(listUndistilledResearchEvents({ baseDir: dir, limit: 2 }).map((e) => e.summary)).toEqual(['e1', 'e2']);
    markResearchEventsDistilled([], dir, NOW);
    expect(listUndistilledResearchEvents({ baseDir: dir })).toHaveLength(3);
  });
});

describe('D3：recall 结算按 kind 分流（安全类走 24h 窗，认知类走主弧）', () => {
  it('listUnsettledRecalls 支持 include/exclude kind 过滤', () => {
    const sec = putEntry({ kind: 'vuln-pattern', content: 'tcache dup 模式', salience: 0.8 }, dir, NOW);
    const cog = putEntry({ kind: 'reminder', content: '周报提醒', salience: 0.6 }, dir, NOW);
    logRecallEvents([sec.id, cog.id], 'tcache', dir, NOW - 3600_000);

    const researchOnly = listUnsettledRecalls(0, 20, dir, NOW, { include: ['research-log', 'vuln-pattern', 'tool-combo'] });
    expect(researchOnly.map((e) => e.memoryId)).toEqual([sec.id]);

    const cognitiveOnly = listUnsettledRecalls(0, 20, dir, NOW, { exclude: ['research-log', 'vuln-pattern', 'tool-combo'] });
    expect(cognitiveOnly.map((e) => e.memoryId)).toEqual([cog.id]);

    const all = listUnsettledRecalls(0, 20, dir, NOW);
    expect(all).toHaveLength(2);
  });
});

describe('1.2.4 深化：预算对齐（修预算倒挂）', () => {
  it('三节上限之和 + 包装预留 ≤ 注入预算（单一事实源推导）', () => {
    // 蒸馏侧每节额度按注入预算三等分：三节写满也必然装得进注入段。
    expect(RESEARCH_MEMORY_INJECT_BUDGET).toBe(2000);
    expect(RESEARCH_DISTILL_MAX_CHARS_PER_SECTION * 3).toBeLessThan(RESEARCH_MEMORY_INJECT_BUDGET);
    // 包装预留（标签+引言+标题行，实测约 190）至少有 100 字符余量。
    expect(RESEARCH_MEMORY_INJECT_BUDGET - RESEARCH_DISTILL_MAX_CHARS_PER_SECTION * 3).toBeGreaterThanOrEqual(100);
  });
});

describe('1.2.4 深化：expert_refs 进蒸馏 prompt（追溯闭环）', () => {
  it('事件行带 expert_refs 与条目标题；prompt 含来源标注指令', () => {
    const prompt = buildResearchDistillPrompt({
      events: [
        ev({ id: 1, taskKind: 'binary', summary: '堆风水布局后 tcache poisoning 成功', expertRefs: [3, 12] }),
        ev({ id: 2, taskKind: 'binary', outcome: 'fail', summary: '无引用事件' }),
      ],
      expertTitles: { 3: 'glibc tcache 利用范式' },
      existing: EMPTY,
    });
    // 有标题 → #id《标题》；无标题 → 仅 #id。
    expect(prompt).toContain('依据 expert #3《glibc tcache 利用范式》、#12');
    // 无 expert_refs 的事件行不带「依据 expert」。
    const failLine = prompt.split('\n').find((l) => l.includes('无引用事件'))!;
    expect(failLine).not.toContain('依据 expert');
    // 来源标注指令进契约。
    expect(prompt).toContain('（源自 expert #N）');
  });

  it('时效/环境锚点/去重置信指令进契约', () => {
    const prompt = buildResearchDistillPrompt({ events: [ev({ taskKind: 'binary' })], existing: EMPTY });
    expect(prompt).toContain('YYYY-MM-DD');
    expect(prompt).toContain('环境锚点');
    expect(prompt).toContain('置信加强');
  });
});

describe('1.2.4 深化：轨迹深摘进蒸馏 prompt', () => {
  it('trajectoryExcerpts 进 prompt 的独立分节；缺省有占位', () => {
    const withTraj = buildResearchDistillPrompt({
      events: [ev({ taskKind: 'binary', outcome: 'fail', summary: '卡在 canary' })],
      trajectoryExcerpts: ['事件#2（binary/fail）轨迹末段：\n工具: *** stack smashing detected ***'],
      existing: EMPTY,
    });
    expect(withTraj).toContain('# 失败/卡住事件的轨迹深摘');
    expect(withTraj).toContain('stack smashing detected');

    const without = buildResearchDistillPrompt({ events: [ev({ taskKind: 'binary' })], existing: EMPTY });
    expect(without).toContain('（无轨迹深摘');
  });
});

describe('1.2.4 深化：judge wrong 反馈的注入侧查证（keyedDistilledEntryJudgedWrong）', () => {
  function writeAndGetLiveId(content: string): string {
    writeResearchDistilled({ successPaths: content, failureRoots: '', toolCombos: '' }, dir);
    return latestKeyedDistilledEntry('vuln-pattern', 'research-distill:success-paths', dir)!.id;
  }

  function judgeWrong(memoryId: string): void {
    logRecallEvents([memoryId], 'q', dir, NOW - 1000);
    const pending = listUnsettledRecalls(0, 20, dir, NOW);
    settleRecallEvent(pending.find((e) => e.memoryId === memoryId)!.id, 'wrong', dir, NOW);
  }

  it('live 条目被判 wrong → true；未判过 → false', () => {
    const id = writeAndGetLiveId('### 域：binary\n- 错误经验。');
    expect(keyedDistilledEntryJudgedWrong('vuln-pattern', 'research-distill:success-paths', dir)).toBe(false);
    judgeWrong(id);
    expect(keyedDistilledEntryJudgedWrong('vuln-pattern', 'research-distill:success-paths', dir)).toBe(true);
    // 其它分节不受影响。
    expect(keyedDistilledEntryJudgedWrong('vuln-pattern', 'research-distill:failure-roots', dir)).toBe(false);
  });

  it('archive 旧版被判 wrong 且当前内容未变（content_key 相同）→ 仍 true；内容已修正 → false', () => {
    const v1 = writeAndGetLiveId('### 域：binary\n- 错误经验。');
    judgeWrong(v1);
    // 蒸馏弧重写但内容没变（判错后没修正）→ 依然算 wrong。
    writeAndGetLiveId('### 域：binary\n- 错误经验。');
    expect(keyedDistilledEntryJudgedWrong('vuln-pattern', 'research-distill:success-paths', dir)).toBe(true);
    // 下轮蒸馏修正了内容 → 自动恢复（新内容不是被判错的那版）。
    writeAndGetLiveId('### 域：binary\n- 修正后的经验。');
    expect(keyedDistilledEntryJudgedWrong('vuln-pattern', 'research-distill:success-paths', dir)).toBe(false);
  });

  it('条目不存在 → false', () => {
    expect(keyedDistilledEntryJudgedWrong('tool-combo', 'research-distill:tool-combos', dir)).toBe(false);
  });
});
