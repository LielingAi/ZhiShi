/**
 * 1.6.8 M1 — 任务形态（mission）设定面纯函数层。
 *
 * 事实源在 src/shared/mission.ts（种类闭集 + 中文标签）；这里只做 GUI
 * 展示窄化：选择器选项表（'' = 无类型）与标签回落。mission 挂会话线
 * （不挂环境），缺省无类型 = 现状（域信号推导，行为零变化）。
 *
 * 纯函数：不 import store / React / client。
 */

import { isMissionKind, MISSION_KINDS, MISSION_LABELS } from '../../../shared/mission';

export interface MissionOption {
  /** '' = 无类型（PATCH 时转 null 清除）。 */
  value: string;
  label: string;
}

/** 形态选择器选项表（首项无类型，其余按 shared 闭集顺序）。 */
export const MISSION_OPTIONS: MissionOption[] = [
  { value: '', label: '无类型' },
  ...MISSION_KINDS.map((k) => ({ value: k, label: MISSION_LABELS[k] })),
];

/** mission 值 → 中文标签（非法/空 → 无类型）。 */
export function missionLabel(kind: string | null | undefined): string {
  return kind && isMissionKind(kind) ? MISSION_LABELS[kind] : '无类型';
}

/** 选择器值 → PATCH 载荷值（'' → null 清除，其余原样透传）。 */
export function missionPatchValue(value: string): string | null {
  return isMissionKind(value) ? value : null;
}
