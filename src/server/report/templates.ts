/**
 * 1.2.0 — 报告域模板（纯函数）。
 *
 * 按事件主 task_kind 选模板（design 1.2.0「报告结构」）：
 *   - pentest：目标/侦察/发现/利用链/复现步骤/修复建议
 *   - whitebox：输入面/确认漏洞(带 文件:行号)/证据/修复建议
 *   - binary：目标/崩溃分析/利用路径/证据
 *   - 无域信息（ai-security/intel 等）→ 通用兜底
 *
 * section.key 是骨架组装（skeleton.ts）与叙述回填（narrate.ts）之间的
 * 契约键——改 key 必须两侧同步。
 */

import type { ResearchEvent, ResearchTaskKind } from '../memory/store';

export type ReportDomain = 'pentest' | 'whitebox' | 'binary' | 'generic';

export interface ReportSectionSpec {
  key: string;
  title: string;
}

export interface DomainTemplate {
  domain: ReportDomain;
  /** 报告标题里的域名（「安全研究报告（渗透测试）」）。 */
  label: string;
  sections: ReportSectionSpec[];
}

export const PENTEST_TEMPLATE: DomainTemplate = {
  domain: 'pentest',
  label: '渗透测试',
  sections: [
    { key: 'target', title: '目标' },
    { key: 'recon', title: '侦察' },
    { key: 'findings', title: '发现' },
    { key: 'exploit-chain', title: '利用链' },
    { key: 'repro', title: '复现步骤' },
    { key: 'fix', title: '修复建议' },
  ],
};

export const WHITEBOX_TEMPLATE: DomainTemplate = {
  domain: 'whitebox',
  label: '白盒审计',
  sections: [
    { key: 'input-surface', title: '输入面' },
    { key: 'confirmed-vulns', title: '确认漏洞' },
    { key: 'evidence', title: '证据' },
    { key: 'fix', title: '修复建议' },
  ],
};

export const BINARY_TEMPLATE: DomainTemplate = {
  domain: 'binary',
  label: '二进制分析',
  sections: [
    { key: 'target', title: '目标' },
    { key: 'crash-analysis', title: '崩溃分析' },
    { key: 'exploit-path', title: '利用路径' },
    { key: 'evidence', title: '证据' },
  ],
};

export const GENERIC_TEMPLATE: DomainTemplate = {
  domain: 'generic',
  label: '通用',
  sections: [
    { key: 'target', title: '目标' },
    { key: 'timeline', title: '研究过程' },
    { key: 'findings', title: '发现' },
    { key: 'evidence', title: '证据' },
    { key: 'summary', title: '总结' },
  ],
};

/** task_kind → 报告域。redteam/ctf 的形态与 pentest 同构；malware 归 binary。 */
export function domainForTaskKind(taskKind: ResearchTaskKind): ReportDomain {
  switch (taskKind) {
    case 'pentest':
    case 'redteam':
    case 'ctf':
      return 'pentest';
    case 'whitebox':
      return 'whitebox';
    case 'binary':
    case 'malware':
      return 'binary';
    default:
      return 'generic';
  }
}

export const DOMAIN_TEMPLATES: Record<ReportDomain, DomainTemplate> = {
  pentest: PENTEST_TEMPLATE,
  whitebox: WHITEBOX_TEMPLATE,
  binary: BINARY_TEMPLATE,
  generic: GENERIC_TEMPLATE,
};

/**
 * 事件主 task_kind：出现次数最多者；并列取时间最早出现的（先起步的线
 * 通常是主线）。事件为空 → undefined（调用方按「无记录」报错）。
 */
export function dominantTaskKind(events: ResearchEvent[]): ResearchTaskKind | undefined {
  if (events.length === 0) return undefined;
  const counts = new Map<ResearchTaskKind, { count: number; firstTs: number }>();
  for (const e of events) {
    const cur = counts.get(e.taskKind);
    if (cur) {
      cur.count += 1;
      cur.firstTs = Math.min(cur.firstTs, e.ts);
    } else {
      counts.set(e.taskKind, { count: 1, firstTs: e.ts });
    }
  }
  let best: ResearchTaskKind | undefined;
  let bestCount = -1;
  let bestFirstTs = Number.POSITIVE_INFINITY;
  for (const [kind, { count, firstTs }] of counts) {
    if (count > bestCount || (count === bestCount && firstTs < bestFirstTs)) {
      best = kind;
      bestCount = count;
      bestFirstTs = firstTs;
    }
  }
  return best;
}

/** 按事件主 task_kind 选模板；无事件 → 通用兜底。 */
export function selectDomainTemplate(events: ResearchEvent[]): DomainTemplate {
  const kind = dominantTaskKind(events);
  if (!kind) return GENERIC_TEMPLATE;
  return DOMAIN_TEMPLATES[domainForTaskKind(kind)];
}
