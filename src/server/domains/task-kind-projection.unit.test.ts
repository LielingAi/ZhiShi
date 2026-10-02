/**
 * 桶 → 投影表（1.9.3）的守卫测试。
 *
 * 存在的意义：RESEARCH_TASK_KINDS 是闭集枚举，而每个桶都必须对「报告骨架」与
 * 「注入归属」两个投影各表态一次。新增桶时这里会红——逼出决定，而不是让新桶
 * 悄悄落进 default 分支（fuzz 桶当初就是这么只写不读的）。
 */
import { describe, expect, it } from 'vitest';

import { RESEARCH_TASK_KINDS } from '../../shared/research-kinds';

import { injectionOwnerOf, TASK_KIND_PROJECTION } from './task-kind-projection';

describe('TASK_KIND_PROJECTION（桶 → 报告域 / 注入归属）', () => {
  it('完备性：9 个桶全部表态，无遗漏无多余', () => {
    expect(Object.keys(TASK_KIND_PROJECTION).sort()).toEqual([...RESEARCH_TASK_KINDS].sort());
    for (const kind of RESEARCH_TASK_KINDS) {
      const p = TASK_KIND_PROJECTION[kind];
      expect(p, kind).toBeTruthy();
      expect(p.report, kind).toMatch(/^(pentest|whitebox|binary|generic)$/);
      expect(p.inject, kind).toMatch(/^(binary|pentest|whitebox|ai-security|cross)$/);
    }
  });

  it('归属表：fuzz/malware 归 binary、redteam 归 pentest、ctf/intel 跨域、ai-security 自成域', () => {
    expect(injectionOwnerOf('binary')).toBe('binary');
    expect(injectionOwnerOf('fuzz')).toBe('binary');
    expect(injectionOwnerOf('malware')).toBe('binary');
    expect(injectionOwnerOf('pentest')).toBe('pentest');
    expect(injectionOwnerOf('redteam')).toBe('pentest');
    expect(injectionOwnerOf('whitebox')).toBe('whitebox');
    expect(injectionOwnerOf('ai-security')).toBe('ai-security');
    expect(injectionOwnerOf('ctf')).toBe('cross'); // D30 补充场景
    expect(injectionOwnerOf('intel')).toBe('cross'); // D29 横切标签
  });

  it('报告投影与既有行为逐值一致（report/skeleton 的映射测试是另一处对账）', () => {
    expect(TASK_KIND_PROJECTION.ctf.report).toBe('pentest');
    expect(TASK_KIND_PROJECTION.redteam.report).toBe('pentest');
    expect(TASK_KIND_PROJECTION.malware.report).toBe('binary');
    expect(TASK_KIND_PROJECTION.fuzz.report).toBe('binary');
    expect(TASK_KIND_PROJECTION['ai-security'].report).toBe('generic');
    expect(TASK_KIND_PROJECTION.intel.report).toBe('generic');
  });

  it('表外桶 → 跨域放行（宁多勿缺，不静默丢经验）', () => {
    expect(injectionOwnerOf('web3')).toBe('cross');
    expect(injectionOwnerOf('')).toBe('cross');
  });
});
