/**
 * 2.0-M4b（GUI 迭代 v2）：环境面板行装配——纯函数层。
 *
 * WREN 真机三条反馈（2026-10-17）驱动本形态：
 *   ① 底栏一排环境太混乱 → 底栏只留一个切换入口（chip），面板收起时零占宽
 *   ② 环境干完任务我不知道 → 行内带"在干什么/最近完成"（auto-run 记录）
 *   ③ 切换麻烦且不知道对方在做什么 → 面板一行一环境：全名/状态/当前任务/点击即切
 *
 * 与 v1 任务栏（env-strip）的关系：v1 的"多段平铺"废弃；排序/短名口径复用。
 */

import type { EnvStripState } from './env-strip';

/** auto-run/list 记录的最小面（记录按落盘序，越新越靠前由调用方保证）。 */
export interface EnvRunLike {
  id?: string;
  name?: string;
  envKey?: string;
  status?: string;
}

export interface EnvPanelRow {
  id: string;
  fullName: string;
  state: EnvStripState;
  current: boolean;
  /** 在干什么 / 最近完成：`auto loop「名」· 运行中` / `· ✓ 已完成`；无记录为 ''。 */
  doing: string;
  /** 该环境最近一 run 已完成（完成未读标记的判定输入；组件侧本地清）。 */
  done: boolean;
}

const RUN_STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  completed: '✓ 已完成',
  stopped: '已终止',
  exited: '已退出',
};

/** 战役（挖掘）活跃态与中文标签（campaign 记录无 envKey——经线反查归属，
 *  见 campaignDoingOf）。 */
const CAMPAIGN_ACTIVE = new Set(['running', 'plateau', 'triaging', 'deepening']);
const CAMPAIGN_STATE_TEXT: Record<string, string> = {
  running: '进行中',
  plateau: '破冰介入中',
  triaging: '分拣介入中',
  deepening: '深挖介入中',
};

/** 面板数据的战役最小面（CampaignRecordLike 子集）。 */
export interface CampaignLike {
  goal?: string;
  state?: string;
  loopSessionId?: string;
}

/** 环境线的最小面（LineRow 子集：id = loopSessionId）。 */
export interface LineLike {
  id: string;
  envKey: string;
}

/**
 * 战役活跃叙事（audit P3：面板漏战役——campaign 记录只有 loopSessionId，
 * 经 line.list 的 envKey 映射归属到环境）。
 */
export function campaignDoingOf(
  campaigns: CampaignLike[],
  lines: LineLike[],
  envId: string,
): string {
  const lineIds = new Set(lines.filter((l) => l.envKey === envId).map((l) => l.id));
  const hit = campaigns.find(
    (c) => c.state && CAMPAIGN_ACTIVE.has(c.state) && c.loopSessionId && lineIds.has(c.loopSessionId),
  );
  if (!hit) return '';
  const goal = (hit.goal ?? '').trim();
  return `战役「${goal || '未命名'}」· ${CAMPAIGN_STATE_TEXT[hit.state!] ?? hit.state}`;
}

/** 某环境最近一条 auto-run 记录（记录按新→旧；run.envKey 是 `env:<id>` 形态）。 */
export function latestRunOf(runs: EnvRunLike[], envId: string): EnvRunLike | null {
  const ref = `env:${envId}`;
  return runs.find((r) => r.envKey === ref) ?? null;
}

/** auto-run 记录 → "在干什么"文案（无记录 → ''，running 显示任务名）。 */
export function doingTextOf(run: EnvRunLike | null): string {
  if (!run) return '';
  const label = RUN_STATUS_LABEL[run.status ?? ''] ?? run.status ?? '';
  const name = (run.name ?? '').trim();
  return name ? `auto loop「${name}」· ${label}` : `auto loop · ${label}`;
}

/**
 * 环境面板行装配。
 * 排序与 v1 一致：运行中→已停止→本机钉底，同组按 id（点击目标不漂移）。
 */
export function buildEnvPanelRows(
  envs: Array<{ id: string; kind?: string; name?: string }>,
  runningIds: Iterable<string>,
  currentEnvKey: string | null,
  runs: EnvRunLike[] = [],
  extra: { campaigns?: CampaignLike[]; lines?: LineLike[] } = {},
): EnvPanelRow[] {
  const runSet = new Set(runningIds);
  const rows: EnvPanelRow[] = envs.map((e) => {
    const state: EnvStripState = e.kind === 'local' ? 'local' : runSet.has(e.id) ? 'running' : 'stopped';
    const run = latestRunOf(runs, e.id);
    // 叙事优先级：活跃战役 > auto-run 记录（在跑 > 最近完成）。
    const campaignText = campaignDoingOf(extra.campaigns ?? [], extra.lines ?? [], e.id);
    const doing = campaignText || doingTextOf(run);
    return {
      id: e.id,
      fullName: (e.name ?? e.id).trim() || e.id,
      state,
      current: currentEnvKey === e.id,
      doing,
      done: !campaignText && run?.status === 'completed',
    };
  });
  const weight = (r: EnvPanelRow): number => (r.state === 'running' ? 0 : r.state === 'stopped' ? 1 : 2);
  rows.sort((a, b) => weight(a) - weight(b) || a.id.localeCompare(b.id));
  return rows;
}
