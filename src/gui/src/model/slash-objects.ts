/**
 * v4 命令对象补全纯函数层——/ 动词的对象注册表推导。
 *
 * 背景：第二批 v4 落地给命令面板加了三个带对象的动词（/resume 切线、
 * /kill 终止战役、/mission 改形态）——用户不应背 id/标签，输完命令名后
 * overlay 直接给对象候选。本模块是「{命令名, 参数段} × 数据源 → 对象表」
 * 的纯函数：openOverlay('slash') 精确命中命令名时把 items 换成对象过滤
 * 结果；返回 null = 该命令无对象表，调用方维持命令名前缀过滤。
 *
 * 纯函数：不 import store / React / client；单测断言行装配与过滤口径。
 */

import type { EnvEntry } from '../client/api';
import type { CampaignRecordLike } from './campaign';
import type { LineRow, LineStateDot } from './lines';
import type { MissionOption } from './mission';

/** 对象候选行（name = 对象 id——选中后经 slashArgs 通道进 runSlashCommand）。 */
export interface SlashObjectItem {
  /** 对象 id：resume/kill/use = 服务端 id；mission = 中文标签（store 映射回 kind）。 */
  name: string;
  detail: string;
  tag: string;
}

/** 对象数据源（store 快照注入——lines/campaigns/envs 来自状态，missions 是常量表）。 */
export interface SlashObjectSources {
  lines: LineRow[];
  campaigns: CampaignRecordLike[];
  /** 形态选项表（MISSION_OPTIONS 注入；首项 '' = 无类型也参与补全）。 */
  missions: MissionOption[];
  /** 环境注册表（V4-S4 /use 动词对象源——EnvSidebar 退正门后的中途切环境）。 */
  envs: EnvEntry[];
  /** 运行中环境 id 集合（EnvEntry 无 state 字段——运行态走 ps 现场列表）。 */
  runningIds: ReadonlySet<string>;
}

/** 线状态点中文标签（与 SidePane「线」页签行 title 同口径——即线行 detail 的 stateLabel）。 */
export const LINE_STATE_LABELS: Record<LineStateDot, string> = {
  running: '运行中',
  idle: '在线空闲',
  cold: '冷线（引擎未起）',
};

function norm(s: string): string {
  return s.trim().toLowerCase();
}

type RegistryFn = (args: string, src: SlashObjectSources) => SlashObjectItem[];

/**
 * 对象注册表：命令名 → 对象表推导。新动词在这里登记一行即进 overlay；
 * 不登记的命令天然返回 null（无对象表 = 维持原命令名前缀过滤）。
 */
const REGISTRY: Record<string, RegistryFn> = {
  /** /resume <线id>：按 id 过滤（includes、大小写不敏感）；空表返回 []（无匹配 ≠ 无对象表）。 */
  resume: (args, src) => {
    const q = norm(args);
    return src.lines
      .filter((l) => !q || l.id.toLowerCase().includes(q))
      .map((l) => ({ name: l.id, detail: `${l.envKey} · ${LINE_STATE_LABELS[l.stateDot]}`, tag: '线' }));
  },
  /** /kill <id>：按战役 id 与 goal 过滤（战役的「名」= goal）；goal 空回落 id。 */
  kill: (args, src) => {
    const q = norm(args);
    return src.campaigns
      .filter((c) => !q || c.id.toLowerCase().includes(q) || c.goal.toLowerCase().includes(q))
      .map((c) => ({ name: c.id, detail: c.goal || c.id, tag: '战役' }));
  },
  /** /mission <标签>：常量表五形态；name = 中文标签（store 选中后映射回 kind 直设）。 */
  mission: (args, src) => {
    const q = norm(args);
    return src.missions
      .filter((o) => !q || norm(o.label).includes(q))
      .map((o) => ({ name: o.label, detail: o.value === '' ? '清除任务形态' : o.value, tag: '形态' }));
  },
  /** /use <环境id>：环境注册表（id/name 过滤）；detail = 运行状态（V4-S4）。 */
  use: (args, src) => {
    const q = norm(args);
    return src.envs
      .filter((e) => !q || e.id.toLowerCase().includes(q) || (e.name ?? '').toLowerCase().includes(q))
      .map((e) => ({ name: e.id, detail: src.runningIds.has(e.id) ? '运行中' : '已停止', tag: '环境' }));
  },
};

/** {命令名, 参数段} × 数据源 → 对象表；该命令无对象表 → null。 */
export function slashObjectItems(
  query: { name: string; args: string },
  src: SlashObjectSources,
): SlashObjectItem[] | null {
  const fn = REGISTRY[query.name];
  return fn ? fn(query.args, src) : null;
}
