/**
 * 研究「桶」→ 两个投影的**唯一事实源**（1.9.3）。
 *
 * RESEARCH_TASK_KINDS 的 9 个值本质是**桶**（`research_events.task_kind`、蒸馏产出
 * 的「### 域：<桶>」分组键、专家条目的 domain 列），而「域」只有 4 个（bundled-domains
 * 的 4 个域包 / 会话域 resolveSessionDomain 的取值）。桶比域多出的那 5 个各有归宿，
 * 但此前两个消费点各写一遍判据：
 *
 *   - 报告骨架投影（report/templates.ts::domainForTaskKind）——按桶选报告模板；
 *   - 蒸馏经验注入放行（system-prompt-security.ts::filterSectionByDomain）——按会话域
 *     决定哪个「### 域：<桶>」子节进 prompt，且只硬编码放行了 ctf。
 *
 * 后者因此漏掉了 fuzz：1.6.7 R5 为「挖掘任务可观测性」加了 fuzz 桶（mission=discover
 * 的会话按教学强制落 task_kind=fuzz），蒸馏照 9 值分组输出「### 域：fuzz」，而放行判据
 * 只认会话域（恒为 4 值之一）与 ctf —— 挖掘主线的经验攒了、蒸馏了，回流断在最后一步。
 *
 * 两份投影**本就不同**，所以本表显式两列而不是一个函数：
 *   ai-security 的报告走通用骨架（没有 ai-security 模板），注入却属于 ai-security 域；
 *   ctf 的报告投影到 pentest，注入则是跨域补充（任何域都能参考）。
 *
 * 桶的归宿（对齐既有决策）：
 *   fuzz / malware 归 binary —— 同对象域的不同打法与载体（R5 分桶、D31 前的选型）；
 *   redteam 归 pentest —— 形态与渗透同构；
 *   ai-security 自成域；
 *   ctf（D30 补充场景）与 intel（D29 横切标签）在注入面是跨域补充。
 */

import type { ResearchTaskKind } from '../memory/store';

/** 报告骨架域（与 report/templates.ts 的 ReportDomain 同集）。 */
export type ReportTemplateDomain = 'pentest' | 'whitebox' | 'binary' | 'generic';

/** 注入归属：某个会话域，或 'cross' = 任何会话域都放行。 */
export type InjectionOwner = 'binary' | 'pentest' | 'whitebox' | 'ai-security' | 'cross';

export interface TaskKindProjection {
  /** 报告骨架域（report/templates.ts 消费）。 */
  report: ReportTemplateDomain;
  /** 蒸馏经验注入的归属（system-prompt-security.ts 的 filterSectionByDomain 消费）。 */
  inject: InjectionOwner;
}

/**
 * 9 个桶各自的投影。新增桶（改 RESEARCH_TASK_KINDS）时必须在此表态——
 * `task-kind-projection.unit.test.ts` 用完备性断言逼出这个决定。
 */
export const TASK_KIND_PROJECTION: Readonly<Record<ResearchTaskKind, TaskKindProjection>> = {
  binary: { report: 'binary', inject: 'binary' },
  fuzz: { report: 'binary', inject: 'binary' },
  malware: { report: 'binary', inject: 'binary' },
  pentest: { report: 'pentest', inject: 'pentest' },
  redteam: { report: 'pentest', inject: 'pentest' },
  whitebox: { report: 'whitebox', inject: 'whitebox' },
  'ai-security': { report: 'generic', inject: 'ai-security' },
  ctf: { report: 'pentest', inject: 'cross' },
  intel: { report: 'generic', inject: 'cross' },
};

/**
 * 桶 → 注入归属。**表外桶按跨域放行**：存量脏数据或未来新增的桶宁可多注入
 * （域过滤是预算优化，不是正确性闸门——宁多勿缺），也不要静默丢掉一段经验。
 */
export function injectionOwnerOf(kind: string): InjectionOwner {
  return TASK_KIND_PROJECTION[kind as ResearchTaskKind]?.inject ?? 'cross';
}
