/**
 * 1.8.7 P3b 研究线面板纯函数层（B6/B7——线一等对象视图）。
 *
 * 设计底账 docs/design/gui-v4-capability-audit.md B6/B7：line/list 端点
 * 服务端已就位的 GUI 接入面。行装配（归属段标签 / live·busy 状态推导 /
 * share·unshare 动作可用性）与时间显示全部在本地完成——线面板只是
 * line/list 清单的投影，无独立聚合逻辑。
 *
 * 纯函数：不 import store / React / client；单测断言行装配与窄化。
 */

// ---------------------------------------------------------------------------
// 记录窄化（admin line/list 的 data.lines 最小面）
// ---------------------------------------------------------------------------

export interface LineEntry {
  loopSessionId: string;
  envKey: string;
  /** 归属段：owner 名 / 'shared' / 'legacy'（旧键归属未知）。 */
  segment: string;
  /** 归属 owner（共享线保留原主署名；旧线 null）。 */
  owner: string | null;
  shared: boolean;
  /** 引擎在跑（有 live engine）。 */
  live: boolean;
  /** live 且 turn 运行中。 */
  busy: boolean;
  /** 调用方当前线。 */
  active: boolean;
  /** ISO-8601；旧数据可能缺失。 */
  updatedAt?: string;
}

/** 状态点三态：running（绿）/ idle / cold（灰）。 */
export type LineStateDot = 'running' | 'idle' | 'cold';

/** 展示行（线面板一行）。 */
export interface LineRow {
  id: string;
  envKey: string;
  /** 归属段标签：shared→「共享」/ legacy→「旧」/ 其余 = owner 名。 */
  segLabel: string;
  /** 归属标签：shared→「共享」；owner=调用方→「我」；归属未知→「旧」。 */
  ownerLabel: string;
  /** 共享标记（menubar 共享徽章直接读，不必反推 canShare/canUnshare）。 */
  shared: boolean;
  stateDot: LineStateDot;
  active: boolean;
  /** 最后活动：今天 HH:MM；否则 M-D。 */
  updatedLabel: string;
  /** 私有线可共享（!shared）。 */
  canShare: boolean;
  /** 共享线可转回私有（shared）；权限细化服务端 403，前端不挡。 */
  canUnshare: boolean;
}

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** 单条服务端行 → LineEntry（loopSessionId/envKey 缺失 = 非线行，丢弃）。 */
function parseLineEntry(raw: unknown): LineEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const loopSessionId = strOf(r.loopSessionId);
  const envKey = strOf(r.envKey);
  if (!loopSessionId || !envKey) return null;
  return {
    loopSessionId,
    envKey,
    segment: strOf(r.segment) ?? 'legacy',
    owner: strOf(r.owner) ?? null,
    shared: r.shared === true,
    live: r.live === true,
    busy: r.busy === true,
    active: r.active === true,
    updatedAt: strOf(r.updatedAt),
  };
}

/** line/list 的 data 载荷 → 行数组（data 形状不合返回空数组，不抛）。 */
export function parseLineList(data: unknown): LineEntry[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const lines = (data as Record<string, unknown>).lines;
  if (!Array.isArray(lines)) return [];
  const out: LineEntry[] = [];
  for (const item of lines) {
    const entry = parseLineEntry(item);
    if (entry) out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 行装配
// ---------------------------------------------------------------------------

function segmentLabel(segment: string): string {
  if (segment === 'shared') return '共享';
  if (segment === 'legacy') return '旧';
  return segment;
}

function ownerLabelOf(entry: LineEntry, segLabel: string, actorName: string | null): string {
  if (entry.shared) return '共享';
  if (entry.owner) return actorName && entry.owner === actorName ? '我' : entry.owner;
  // 旧线归属未知：归属列回落到段标签「旧」,不留空。
  return segLabel;
}

export interface BuildLineRowsOpts {
  /** 调用方名（团队大脑 actor；本机/未知 = null）——自己的线归属显示「我」。 */
  actorName: string | null;
}

/** 服务端行 → 展示行：live+busy=running（绿）、live=idle、非 live=cold（灰）。 */
export function buildLineRows(entries: LineEntry[], opts: BuildLineRowsOpts): LineRow[] {
  return entries.map((e) => {
    const segLabel = segmentLabel(e.segment);
    return {
      id: e.loopSessionId,
      envKey: e.envKey,
      segLabel,
      ownerLabel: ownerLabelOf(e, segLabel, opts.actorName),
      shared: e.shared,
      stateDot: !e.live ? 'cold' : e.busy ? 'running' : 'idle',
      active: e.active,
      updatedLabel: formatLineUpdated(e.updatedAt),
      canShare: !e.shared,
      canUnshare: e.shared,
    };
  });
}

// ---------------------------------------------------------------------------
// 显示辅助
// ---------------------------------------------------------------------------

/** 最后活动：今天 → HH:MM；否则 M-D（本地时区；无法解析 → 空串）。 */
export function formatLineUpdated(ts: string | undefined, now: number = Date.now()): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

/** 短线 id（loopSessionId 是全 UUID——状态栏/回执只取前 8 字）。 */
export function shortLineId(loopSessionId: string): string {
  return loopSessionId.slice(0, 8);
}
