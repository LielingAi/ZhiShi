/**
 * 研究成败信号（research_events）的闭集枚举——CLI 与 Sidecar 共用的事实源。
 *
 * 安全蒸馏闭环的原料：「拿 flag 成功/失败、卡在哪、哪个工具组合有效」
 * 从自由文本落成结构化记录。枚举值同时是输出侧本体——system prompt
 * 教学段声明、CLI 侧校验、server 落库前再校验一次（admin API 可被直接调用）。
 *
 * 1.2.3 起本模块从 server/memory/store.ts 迁至 shared（issue #5）：CLI 此前
 * 为这几个常量把 server 运行时（better-sqlite3 / getScriptDir）卷进 bundle。
 * server/memory/store.ts 从本模块导入并 re-export，既有引用路径不变。
 */

/** 七研究域 + ctf 补充域（D30 实战定位：实战为主，CTF 是补充——任何环境按需适配）。 */
export const RESEARCH_TASK_KINDS = ['binary', 'pentest', 'ai-security', 'redteam', 'malware', 'whitebox', 'intel', 'ctf'] as const;
export type ResearchTaskKind = (typeof RESEARCH_TASK_KINDS)[number];

export const RESEARCH_OUTCOMES = ['success', 'fail', 'stuck'] as const;
export type ResearchOutcome = (typeof RESEARCH_OUTCOMES)[number];

export const RESEARCH_BUG_CLASSES = [
  'stack-overflow', 'heap-overflow', 'uaf', 'double-free', 'oob-read', 'oob-write',
  'null-deref', 'int-overflow', 'format-string', 'type-confusion',
  // 白盒审计/web 侧(P2 whitebox 域):注入家族
  'sql-injection', 'xss', 'ssrf', 'path-traversal', 'command-injection', 'xxe',
  'auth-bypass', 'deserialization', 'other',
] as const;
export type ResearchBugClass = (typeof RESEARCH_BUG_CLASSES)[number];

export function isResearchTaskKind(v: string): v is ResearchTaskKind {
  return (RESEARCH_TASK_KINDS as readonly string[]).includes(v);
}
export function isResearchOutcome(v: string): v is ResearchOutcome {
  return (RESEARCH_OUTCOMES as readonly string[]).includes(v);
}
export function isResearchBugClass(v: string): v is ResearchBugClass {
  return (RESEARCH_BUG_CLASSES as readonly string[]).includes(v);
}
