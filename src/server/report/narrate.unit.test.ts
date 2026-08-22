/**
 * 1.2.0 — LLM 填肉（report/narrate.ts）unit tests。
 * prompt 契约(分节标记 + 事实全量 + 只许引用纪律)、解析(正常/缺节/
 * 乱标记/未知 key/空段落 → 该节回退骨架,不炸)。
 */
import { describe, expect, it } from 'vitest';

import type { LoopTranscript } from '../loop/transcript';
import type { ResearchEvent } from '../memory/store';
import {
  buildNarrationPrompt,
  NARRATION_SYSTEM_PROMPT,
  parseNarratedSections,
  sectionOpenMarker,
} from './narrate';
import { buildReportSkeleton } from './skeleton';

const WS = 'E:/work/target';

function skeleton() {
  const events: ResearchEvent[] = [
    { id: 1, ts: 100, workspace: WS, taskKind: 'pentest', outcome: 'success', bugClass: 'sql-injection', summary: 'SQLi 成功' },
    { id: 2, ts: 200, workspace: WS, taskKind: 'pentest', outcome: 'success', summary: '拿到 flag{abc}', trajectoryRef: '/work/flag.txt' },
  ];
  const transcript: LoopTranscript = {
    loopSessionId: 's',
    entries: [{ role: 'tool', toolName: 'env_exec', isError: false, text: 'uid=0' }],
    truncated: false,
    totalMessages: 1,
    meta: null,
  };
  return buildReportSkeleton({ workspace: WS, envId: 'pwn-vm', events, transcript, now: 1000 });
}

describe('buildNarrationPrompt', () => {
  it('含每节分节标记 + 全量事实 + 域信息;system prompt 声明事实纪律', () => {
    const s = skeleton();
    const prompt = buildNarrationPrompt(s);
    for (const section of s.sections) {
      expect(prompt).toContain(sectionOpenMarker(section.key));
      expect(prompt).toContain(`key=${section.key}`);
    }
    expect(prompt).toContain('SQLi 成功');
    expect(prompt).toContain('拿到 flag{abc}');
    expect(prompt).toContain('/work/flag.txt');
    expect(prompt).toContain('报告域：渗透测试');
    expect(NARRATION_SYSTEM_PROMPT).toContain('只许引用');
    expect(NARRATION_SYSTEM_PROMPT).toContain('不得改动');
  });

  it('factOnly 节（引用的专家知识）不进 prompt：无分节标记、无事实', () => {
    const events: ResearchEvent[] = [
      { id: 1, ts: 100, workspace: WS, taskKind: 'pentest', outcome: 'success', summary: 'SQLi 成功', expertRefs: [12] },
      { id: 2, ts: 200, workspace: WS, taskKind: 'pentest', outcome: 'success', summary: '拿到 flag{abc}' },
    ];
    const s = buildReportSkeleton({
      workspace: WS, envId: 'pwn-vm', events,
      transcript: { loopSessionId: 's', entries: [], truncated: false, totalMessages: 0, meta: null },
      now: 1000,
      lookupExpertEntry: () => ({ title: 'Web 注入三板斧', kind: 'technique' }),
    });
    expect(s.sections.some((sec) => sec.key === 'expert-refs')).toBe(true);
    const prompt = buildNarrationPrompt(s);
    expect(prompt).not.toContain('expert-refs');
    expect(prompt).not.toContain('Web 注入三板斧');
  });
});

describe('parseNarratedSections', () => {
  it('正常分节输出 → 每节叙述入图', () => {
    const s = skeleton();
    const text = s.sections
      .map((sec) => `${sectionOpenMarker(sec.key)}\n${sec.title}的叙述。\n<<<END>>>`)
      .join('\n');
    const parsed = parseNarratedSections(text, s);
    expect(parsed.size).toBe(s.sections.length);
    expect(parsed.get('target')).toBe('目标的叙述。');
  });

  it('缺节/空段落/未知 key/缺 END → 对应节静默丢弃(调用方回退骨架)', () => {
    const s = skeleton();
    const text = [
      `${sectionOpenMarker('target')}\n目标叙述\n<<<END>>>`,
      `${sectionOpenMarker('recon')}\n<<<END>>>`, // 空段落
      `${sectionOpenMarker('not-a-section')}\n乱入\n<<<END>>>`, // 未知 key
      `${sectionOpenMarker('findings')}\n没有收尾标记`, // 缺 END
    ].join('\n');
    const parsed = parseNarratedSections(text, s);
    expect([...parsed.keys()]).toEqual(['target']);
  });

  it('完全非格式化输出 → 空图(整份回退骨架);重复 key 取第一份', () => {
    const s = skeleton();
    expect(parseNarratedSections('随便写的一大段没有任何标记', s).size).toBe(0);
    const dup = `${sectionOpenMarker('target')}\n第一份\n<<<END>>>\n${sectionOpenMarker('target')}\n第二份\n<<<END>>>`;
    expect(parseNarratedSections(dup, s).get('target')).toBe('第一份');
  });

  it('factOnly 节的 key 即使出现在输出里也静默丢弃（LLM 写不进引用节）', () => {
    const events: ResearchEvent[] = [
      { id: 1, ts: 100, workspace: WS, taskKind: 'pentest', outcome: 'success', summary: 'SQLi 成功', expertRefs: [12] },
    ];
    const s = buildReportSkeleton({
      workspace: WS, envId: 'pwn-vm', events,
      transcript: { loopSessionId: 's', entries: [], truncated: false, totalMessages: 0, meta: null },
      now: 1000,
      lookupExpertEntry: () => ({ title: '条目', kind: 'sop' }),
    });
    const text = [
      `${sectionOpenMarker('expert-refs')}\nLLM 乱写引用节\n<<<END>>>`,
      `${sectionOpenMarker('recon')}\n侦察叙述\n<<<END>>>`,
    ].join('\n');
    const parsed = parseNarratedSections(text, s);
    expect(parsed.has('expert-refs')).toBe(false);
    expect(parsed.get('recon')).toBe('侦察叙述');
  });
});
