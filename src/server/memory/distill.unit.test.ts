import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  buildDistillPrompt,
  applyDistillResult,
  readDistilled,
  writeDistilled,
  hasDistilledContent,
  loadDistilledMemoryForPrompt,
  isDistillArcPrompt,
  isDistillEnabled,
  parseActiveReminders,
  parseReminderMeta,
  buildRecallJudgePrompt,
  parseRecallJudgeOutput,
  DISTILL_CRON_PROMPT,
  DISTILL_MAX_CHARS_PER_FILE,
  type DistilledMemory,
} from './distill';
import { resetMemoryStoreForTest } from './store';

const EMPTY: DistilledMemory = { userModel: '', selfModel: '', routines: '', reminders: '' };

const EXISTING: DistilledMemory = {
  userModel: '他做报表先看数对不对，再看格式，对日期错误零容忍。',
  selfModel: '我擅长数据清洗；在大表 join 上栽过一次。',
  routines: '每周一生成周报。',
  reminders: '- 月度报表按新版模板做（来源：任务《月度报表》｜日期：2026-07-20｜有效至：长期）',
};

function wellFormedOutput(overrides?: { userModel?: string; selfModel?: string; routines?: string; reminders?: string }): string {
  return `## 它眼中的你（user-model）
${overrides?.userModel ?? '他验收报表先核数再核格式，对格式近乎苛刻。'}

## 它眼中的自己（self-model）
${overrides?.selfModel ?? '我擅长报表生成；曾在日期列格式上栽过，已记住先校验。'}

## 老规矩（routines）
${overrides?.routines ?? '每天 03:00 蒸馏；每周一 09:00 周报。'}

## 主动提醒（reminders）
${overrides?.reminders ?? '- 报表交付前双人复核（来源：任务《月度报表》｜日期：2026-07-28｜有效至：2026-08-31）'}`;
}

describe('isDistillArcPrompt / isDistillEnabled', () => {
  it('识别蒸馏哨兵提示词', () => {
    expect(isDistillArcPrompt(DISTILL_CRON_PROMPT)).toBe(true);
    expect(isDistillArcPrompt('帮我写个周报')).toBe(false);
  });

  it('memory.distill.enabled 缺省视同 true，显式 false 才关闭', () => {
    expect(isDistillEnabled(undefined)).toBe(true);
    expect(isDistillEnabled({})).toBe(true);
    expect(isDistillEnabled({ memory: {} })).toBe(true);
    expect(isDistillEnabled({ memory: { distill: {} } })).toBe(true);
    expect(isDistillEnabled({ memory: { distill: { enabled: true } } })).toBe(true);
    expect(isDistillEnabled({ memory: { distill: { enabled: false } } })).toBe(false);
  });
});

describe('buildDistillPrompt', () => {
  it('包含三条蒸馏弧、输出契约、2000 字符上限与合并语义', () => {
    const prompt = buildDistillPrompt({
      recentSessions: [{ title: '报表调整', lastMessagePreview: '把日期格式改一下', messageCount: 12, lastActiveAt: '2026-07-29T10:00:00Z' }],
      recentTasks: [{ name: '月度结账', status: 'completed', updatedAt: Date.parse('2026-07-28T09:00:00Z') }],
      existing: EXISTING,
    });
    expect(prompt).toContain('任务弧');
    expect(prompt).toContain('关系弧');
    expect(prompt).toContain('能力弧');
    expect(prompt).toContain('## 它眼中的你（user-model）');
    expect(prompt).toContain('## 它眼中的自己（self-model）');
    expect(prompt).toContain('## 老规矩（routines）');
    expect(prompt).toContain('## 主动提醒（reminders）');
    expect(prompt).toContain(String(DISTILL_MAX_CHARS_PER_FILE));
    expect(prompt).toContain('更新');
    // 已有蒸馏内容随提示词喂入（合并而非重写的前提）
    expect(prompt).toContain(EXISTING.userModel);
    expect(prompt).toContain(EXISTING.selfModel);
    expect(prompt).toContain(EXISTING.routines);
    expect(prompt).toContain(EXISTING.reminders);
    // P4 红线写进提示词契约：必须附来源、不许编造、过期清理
    expect(prompt).toContain('来源');
    expect(prompt).toContain('有效至');
    // 工作史原料
    expect(prompt).toContain('报表调整');
    expect(prompt).toContain('把日期格式改一下');
    expect(prompt).toContain('月度结账');
  });

  it('空工作史与空已有内容也能生成（占位符而不是崩）', () => {
    const prompt = buildDistillPrompt({ recentSessions: [], recentTasks: [], existing: EMPTY });
    expect(prompt).toContain('（近 7 天无会话）');
    expect(prompt).toContain('（近 7 天无任务）');
    expect(prompt).toContain('（尚无）');
  });
});

describe('applyDistillResult', () => {
  it('解析四个规范分节并整体替换', () => {
    const { distilled, warnings } = applyDistillResult(EXISTING, wellFormedOutput());
    expect(distilled.userModel).toContain('近乎苛刻');
    expect(distilled.selfModel).toContain('先校验');
    expect(distilled.routines).toContain('每周一 09:00 周报');
    expect(distilled.reminders).toContain('报表交付前双人复核');
    expect(warnings).toEqual([]);
  });

  it('容忍标题变体（无中文括号注释 / 纯英文别名）', () => {
    const output = '## user-model\nA\n\n## self-model\nB\n\n## routines\nC\n\n## reminders\nD';
    const { distilled, warnings } = applyDistillResult(EMPTY, output);
    expect(distilled).toEqual({ userModel: 'A', selfModel: 'B', routines: 'C', reminders: 'D' });
    expect(warnings).toEqual([]);
  });

  it('缺失的分节保留原文并告警', () => {
    const output = '## 它眼中的你（user-model）\n新认知';
    const { distilled, warnings } = applyDistillResult(EXISTING, output);
    expect(distilled.userModel).toBe('新认知');
    expect(distilled.selfModel).toBe(EXISTING.selfModel);
    expect(distilled.routines).toBe(EXISTING.routines);
    expect(warnings.some((w) => w.includes('selfModel'))).toBe(true);
    expect(warnings.some((w) => w.includes('routines'))).toBe(true);
  });

  it('空分节保留原文并告警（绝不覆盖为空）', () => {
    const output = wellFormedOutput({ selfModel: '   ' });
    const { distilled, warnings } = applyDistillResult(EXISTING, output);
    expect(distilled.selfModel).toBe(EXISTING.selfModel);
    expect(warnings.some((w) => w.includes('selfModel') && w.includes('为空'))).toBe(true);
  });

  it('整体解析失败（无任何分节）→ 全部保留原文并告警', () => {
    const { distilled, warnings } = applyDistillResult(EXISTING, '模型说了一堆废话但没有按契约输出');
    expect(distilled).toEqual(EXISTING);
    expect(warnings.some((w) => w.includes('解析失败'))).toBe(true);
  });

  it('四个无法识别的分节按出现顺序兜底映射并告警', () => {
    const output = '## 第一部分\nA\n\n## 第二部分\nB\n\n## 第三部分\nC\n\n## 第四部分\nD';
    const { distilled, warnings } = applyDistillResult(EMPTY, output);
    expect(distilled).toEqual({ userModel: 'A', selfModel: 'B', routines: 'C', reminders: 'D' });
    expect(warnings.some((w) => w.includes('顺序'))).toBe(true);
  });

  it('超过 2000 字符的分节被硬截断并告警', () => {
    const long = 'x'.repeat(DISTILL_MAX_CHARS_PER_FILE + 500);
    const { distilled, warnings } = applyDistillResult(EMPTY, wellFormedOutput({ userModel: long }));
    expect(distilled.userModel.length).toBe(DISTILL_MAX_CHARS_PER_FILE);
    expect(warnings.some((w) => w.includes('截断'))).toBe(true);
    // 其它分节不受影响
    expect(distilled.selfModel).toContain('先校验');
  });

  it('剥离分节正文首尾空白', () => {
    const { distilled } = applyDistillResult(EMPTY, '## user-model\n\n  带空白的内容  \n\n');
    expect(distilled.userModel).toBe('带空白的内容');
  });
});

describe('蒸馏物读写（DB 为体，无文件化）', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'zhishi-distill-test-'));
    resetMemoryStoreForTest();
  });

  afterEach(() => {
    // SQLite（WAL）持有文件锁——先关句柄再删目录，否则 Windows EBUSY。
    resetMemoryStoreForTest();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('未写入前读到四个空串', () => {
    expect(readDistilled(baseDir)).toEqual(EMPTY);
    expect(loadDistilledMemoryForPrompt(baseDir)).toBeUndefined();
  });

  it('writeDistilled → readDistilled 往返一致', () => {
    writeDistilled(EXISTING, baseDir);
    expect(readDistilled(baseDir)).toEqual({
      userModel: EXISTING.userModel,
      selfModel: EXISTING.selfModel,
      routines: EXISTING.routines,
      reminders: EXISTING.reminders,
    });
    expect(loadDistilledMemoryForPrompt(baseDir)).toBeDefined();
  });

  it('空内容不覆盖（绝不把旧认知覆盖为空）', () => {
    writeDistilled(EXISTING, baseDir);
    writeDistilled({ userModel: '', selfModel: '   ', routines: '新规矩', reminders: '' }, baseDir);
    const after = readDistilled(baseDir);
    expect(after.userModel).toBe(EXISTING.userModel);
    expect(after.selfModel).toBe(EXISTING.selfModel);
    expect(after.routines).toBe('新规矩');
    expect(after.reminders).toBe(EXISTING.reminders);
  });

  it('写入侧再做一次 2000 字符硬截断兜底', () => {
    writeDistilled({ userModel: 'y'.repeat(3000), selfModel: '', routines: '', reminders: '' }, baseDir);
    expect(readDistilled(baseDir).userModel.length).toBe(DISTILL_MAX_CHARS_PER_FILE);
  });

  it('无文件化：writeDistilled 不再落 md（DB 是唯一去向）', () => {
    writeDistilled(EXISTING, baseDir);
    const dir = join(baseDir, 'memory', 'distilled');
    expect(existsSync(join(dir, 'user-model.md'))).toBe(false);
    expect(readDistilled(baseDir).userModel).toBe(EXISTING.userModel);
  });

  it('读侧容忍 BOM', () => {
    const dir = join(baseDir, 'memory', 'distilled');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'user-model.md'), '\uFEFF带 BOM 的内容', 'utf-8');
    expect(readDistilled(baseDir).userModel).toBe('带 BOM 的内容');
  });

  it('hasDistilledContent 只看非空分节', () => {
    expect(hasDistilledContent(EMPTY)).toBe(false);
    expect(hasDistilledContent({ ...EMPTY, routines: '每周一' })).toBe(true);
    expect(hasDistilledContent({ ...EMPTY, reminders: '- 别忘了（来源：任务《X》｜日期：2026-07-30｜有效至：长期）' })).toBe(true);
  });
});

describe('parseActiveReminders（P4 红线：附来源 + 过期清理）', () => {
  const NOW = new Date('2026-07-30T12:00:00+08:00');

  it('保留带来源且未过期的提醒', () => {
    const text = [
      '- 报表交付前双人复核（来源：任务《月度报表》｜日期：2026-07-28｜有效至：2026-08-31）',
      '- 长期有效的提醒（来源：会话《对账》｜日期：2026-07-01｜有效至：长期）',
    ].join('\n');
    expect(parseActiveReminders(text, NOW)).toHaveLength(2);
  });

  it('过期提醒被自动清理（有效至 < 今天）', () => {
    const text = [
      '- 已过期（来源：任务《旧报表》｜日期：2026-06-01｜有效至：2026-07-01）',
      '- 仍有效（来源：任务《新报表》｜日期：2026-07-28｜有效至：2026-07-30）',
    ].join('\n');
    const kept = parseActiveReminders(text, NOW);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain('仍有效');
  });

  it('没有来源标注的行被丢弃（不许编造的确定性兑底）', () => {
    const text = [
      '- 无来源的幻觉提醒（日期：2026-07-28｜有效至：长期）',
      '- 有来源（来源：任务《X》｜日期：2026-07-28｜有效至：长期）',
    ].join('\n');
    const kept = parseActiveReminders(text, NOW);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain('有来源');
  });

  it('非 bullet 行与空输入返回空数组（零注入）', () => {
    expect(parseActiveReminders('', NOW)).toEqual([]);
    expect(parseActiveReminders('（暂无）', NOW)).toEqual([]);
    expect(parseActiveReminders('随便一段不是 bullet 的话', NOW)).toEqual([]);
  });
});

describe('parseReminderMeta（提醒溯源，COWORK 任务8）', () => {
  it('解析正文 / 来源 / 日期 / 有效至', () => {
    expect(parseReminderMeta('- 报表交付前双人复核（来源：任务《月度报表》｜日期：2026-07-28｜有效至：2026-08-31）'))
      .toEqual({ text: '报表交付前双人复核', source: '任务《月度报表》', date: '2026-07-28', validUntil: '2026-08-31' });
  });

  it('长期有效 → validUntil 为 null', () => {
    expect(parseReminderMeta('- 金蝶流程改过版，按新版做（来源：会话《对账》｜日期：2026-07-01｜有效至：长期）'))
      .toEqual({ text: '金蝶流程改过版，按新版做', source: '会话《对账》', date: '2026-07-01', validUntil: null });
  });

  it('无来源标注 / 非 bullet → null', () => {
    expect(parseReminderMeta('- 无来源的话')).toBeNull();
    expect(parseReminderMeta('随便一行')).toBeNull();
    expect(parseReminderMeta('')).toBeNull();
  });
});


describe('土匪回路 judge（buildRecallJudgePrompt / parseRecallJudgeOutput）', () => {
  it('提示词包含裁定标准、输出契约与全部待裁定事件', () => {
    const prompt = buildRecallJudgePrompt([
      { eventId: 12, query: '报价流程', memoryContent: '报价前必须先核库存', context: '用户: 报价呢\nAI: 先核库存' },
      { eventId: 13, query: null, memoryContent: 'x', context: '' },
    ]);
    expect(prompt).toContain('effective');
    expect(prompt).toContain('wrong');
    expect(prompt).toContain('unused');
    expect(prompt).toContain('[id=12]');
    expect(prompt).toContain('报价前必须先核库存');
    expect(prompt).toContain('[id=13]');
    expect(prompt).toContain('（引用后无对话记录）');
  });

  it('解析标准三列输出，跳过认不出的行', () => {
    const verdicts = parseRecallJudgeOutput([
      '前言废话',
      '12 | effective | 用户接着往下走了',
      '13 | wrong | 用户说不对',
      '14|unused|没引用上',
      '这不是裁定行',
      '12 | wrong | 重复 id，先到先得',
    ].join('\n'));
    expect(verdicts.get(12)).toBe('effective');
    expect(verdicts.get(13)).toBe('wrong');
    expect(verdicts.get(14)).toBe('unused');
    expect(verdicts.size).toBe(3);
  });

  it('全角竖线与大小写容错', () => {
    const verdicts = parseRecallJudgeOutput('7 ｜ Effective ｜ ok');
    expect(verdicts.get(7)).toBe('effective');
  });
});

describe('buildDistillPrompt 错记忆史注入（B）', () => {
  const baseInput = {
    recentSessions: [],
    recentTasks: [],
    existing: { userModel: '', selfModel: '', routines: '', reminders: '' },
  };

  it('有错记忆史时渲染前车之鉴分节，没有时不渲染', () => {
    const withWrong = buildDistillPrompt({ ...baseInput, wrongMemories: ['用户说报价不要含运费'] });
    expect(withWrong).toContain('曾被判错的记忆');
    expect(withWrong).toContain('用户说报价不要含运费');
    const without = buildDistillPrompt(baseInput);
    expect(without).not.toContain('曾被判错的记忆');
  });
});
