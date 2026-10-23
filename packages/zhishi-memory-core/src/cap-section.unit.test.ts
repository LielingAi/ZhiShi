/**
 * 分节裁剪单测（2.0.8）。
 *
 * 锁死的是实机事故的形态：reminders 2349 > 2000 被**按字符硬切**，
 * 切出半条 bullet（`…｜日期：` 断在这里），下一轮蒸馏把残句喂回模型 → 越写越歪。
 */
import { describe, expect, it } from 'vitest';

import { capSectionByLines } from './cap-section';

// 真实提醒长度约 90–120 字符（含来源与日期），fixture 必须同量级，
// 否则 20 条也塞不进 2000，测不到淘汰路径。
const bullet = (text: string, date: string) =>
  `- ${text}：这条提醒正文要撑到接近真实长度，否则测不到淘汰路径，多写几句凑够预算（来源：会话《某次 vsrx 排障》｜日期：${date}｜长期）`;

describe('capSectionByLines（按整条淘汰，不切断条目）', () => {
  it('预算内原样返回', () => {
    const body = '- a\n- b';
    const r = capSectionByLines(body, 2000, 'reminders');
    expect(r.text).toBe(body);
    expect(r.evicted).toBe(0);
    expect(r.hardCut).toBe(false);
  });

  it('超预算 → 淘汰最旧条目，绝不切断半行', () => {
    const old = Array.from({ length: 24 }, (_, i) => bullet(`旧提醒 ${i}`, `2026-08-${String((i % 28) + 1).padStart(2, '0')}`));
    const fresh = [bullet('最新一条', '2026-10-22'), bullet('次新一条', '2026-10-21')];
    const body = [...old, ...fresh].join('\n');
    expect(body.length).toBeGreaterThan(2000);

    const r = capSectionByLines(body, 2000, 'reminders');
    expect(r.hardCut).toBe(false);
    expect(r.evicted).toBeGreaterThan(0);
    expect(r.text.length).toBeLessThanOrEqual(2000);

    // 每条留下的行都以 `- ` 开头（没有半条）
    for (const line of r.text.split('\n').filter((l) => !l.startsWith('…'))) {
      expect(line.startsWith('- ')).toBe(true);
      expect(line).toMatch(/｜长期）$/);
    }
    // 新的留下、旧的最先走
    expect(r.text).toContain('2026-10-22');
    expect(r.text).toContain('2026-10-21');
    expect(r.text).not.toContain('2026-08-01');
  });

  it('淘汰标记写明条数（下一轮蒸馏据此知道"少了"而不是"没了"）', () => {
    const body = Array.from({ length: 20 }, (_, i) => bullet(`条目 ${i}`, `2026-09-${String(i + 1).padStart(2, '0')}`)).join('\n');
    const r = capSectionByLines(body, 800, 'reminders');
    expect(r.text).toMatch(/另有 \d+ 条较早记录因篇幅未纳入/);
  });

  it('结构标题（### 域：xxx）不会被优先淘汰', () => {
    const sections = [
      '### 域：binary',
      bullet('bin 条目 1', '2026-09-01'),
      bullet('bin 条目 2', '2026-09-02'),
      '### 域：pentest',
      bullet('pentest 条目 1', '2026-09-03'),
    ].join('\n');
    const r = capSectionByLines(sections, 120, 'successPaths');
    // 至少一个标题还在（不会被清空成纯 bullet）
    expect(r.text).toContain('###');
  });

  it('至少留一条：全淘汰比超长更糟', () => {
    const body = [bullet('唯一一条很长很长的提醒', '2026-09-01')].join('');
    const r = capSectionByLines(`${body}${'x'.repeat(500)}`, 100, 'reminders');
    // 单条 + 超长尾巴 → 兜底硬切，但仍告警说明
    expect(r.text.length).toBeLessThanOrEqual(100);
    expect(r.warnings.join('\n')).toMatch(/硬截断|按整条淘汰/);
  });

  it('没有可淘汰行（整段散文）→ 退回硬切并明说', () => {
    const prose = 'x'.repeat(2500);
    const r = capSectionByLines(prose, 2000, 'userModel');
    expect(r.hardCut).toBe(true);
    expect(r.text.length).toBe(2000);
    expect(r.warnings.join('\n')).toContain('退回按字符硬截断');
  });
});
