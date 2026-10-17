/**
 * 2.0-M4（GUI 迭代）：状态栏多环境任务栏段——纯函数层。
 *
 * 背景：多环境功能（M1-M3）落地后，"点一下就切"没有固定位置——本模块是
 * statusbar 环境段的行装配：每环境一段（状态点 + 短名 + 活性计数），
 * 当前项实心高亮；点击语义由组件层按状态分派（运行中=切换，忙碌=只读
 * 查看，当前=详情）——与"不加列、迭代现有 chrome"的评审口径一致。
 *
 * 排序：运行中在前（按 id 字典序稳定）、已停止压下、内置本机钉底；
 * 当前环境按稳定序占位（不在排头上强制置顶——避免点击目标跳动）。
 */

export interface EnvStripEntryLike {
  id: string;
  kind?: string;
  name?: string;
}

export type EnvStripState = 'running' | 'stopped' | 'local';

export interface EnvStripRow {
  id: string;
  /** 短名（≤3 显示字符；local 恒「本机」）。 */
  label: string;
  /** 全名（tooltip 用）。 */
  fullName: string;
  state: EnvStripState;
  current: boolean;
  /** 该环境的活跃 auto-run 数（静态计数徽章；0 = 不显示）。 */
  activity: number;
}

export interface EnvStripResult {
  /** 前 maxVisible 个可点段。 */
  rows: EnvStripRow[];
  /** 折叠段计数（>0 时组件显示 +N，点击进正门看全量）。 */
  overflow: number;
}

/** 短名：取前 3 个字符；local 恒「本机」（宿主行名字长且语义固定）。 */
export function shortEnvLabel(entry: EnvStripEntryLike): string {
  if (entry.kind === 'local') return '本机';
  const name = (entry.name ?? entry.id).trim();
  if (!name) return entry.id.slice(0, 3);
  return [...name].slice(0, 3).join('');
}

/**
 * 环境段行装配。
 * @param envs 登记条目（environment/list 口径）
 * @param runningIds 运行中的环境 id 集（ps 行 id 与登记 id 同口径）
 * @param currentEnvKey 当前锚定环境（null=宿主）
 * @param activeAutoRunEnvKeys 有活跃 auto-run 的 envKey（`env:<id>` 形态）
 * @param maxVisible 任务栏最多可见段数（超出折叠进 +N）
 */
export function buildEnvStrip(
  envs: EnvStripEntryLike[],
  runningIds: Iterable<string>,
  currentEnvKey: string | null,
  activeAutoRunEnvKeys: Iterable<string> = [],
  maxVisible = 6,
): EnvStripResult {
  const runSet = new Set(runningIds);
  const activeRuns = new Set(activeAutoRunEnvKeys);
  const rows: EnvStripRow[] = envs.map((e) => {
    const state: EnvStripState = e.kind === 'local' ? 'local' : runSet.has(e.id) ? 'running' : 'stopped';
    return {
      id: e.id,
      label: shortEnvLabel(e),
      fullName: (e.name ?? e.id).trim() || e.id,
      state,
      current: currentEnvKey === e.id,
      activity: activeRuns.has(`env:${e.id}`) ? 1 : 0,
    };
  });
  // 稳定序：运行中 → 已停止 → 本机钉底；同组按 id 字典序（点击目标不漂移）。
  const weight = (r: EnvStripRow): number => (r.state === 'running' ? 0 : r.state === 'stopped' ? 1 : 2);
  rows.sort((a, b) => weight(a) - weight(b) || a.id.localeCompare(b.id));
  if (rows.length <= maxVisible) return { rows, overflow: 0 };
  return { rows: rows.slice(0, Math.max(1, maxVisible)), overflow: rows.length - Math.max(1, maxVisible) };
}
