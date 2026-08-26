/**
 * 环境停止确认（1.3.8 ①，纯函数）。
 *
 * 侧栏「运行中」行的停止入口（environment/down）——停止是有损操作：
 *   vm     → VM 关机（vmrun stop / Stop-VM / controlvm acpipowerbutton）
 *   docker → 容器停止并移除（docker stop + rm）
 * 进行中的现场可能丢失，必须确认模态，文案按 kind 给准确语义。
 * 服务端路由语义见 src/server/admin-api.ts::handleEnvironmentDown（只读核实）。
 *
 * 纯函数：不 import store / React / client；单测逐形态断言文案。
 */

export interface EnvDownTarget {
  /** 实例 id（environment/down 的入参；运行中组条目的 key）。 */
  id: string;
  /** 展示名（模态文案）。 */
  label: string;
  /** 条目 kind / ps driver（docker / vm / hyperv / vbox…）。 */
  kind: string;
}

export interface EnvDownPlan {
  /** 模态正文（准确说明会发生什么）。 */
  body: string;
  /** 确认按钮文案。 */
  confirmLabel: string;
}

export function envDownPlan(t: EnvDownTarget): EnvDownPlan {
  const what =
    t.kind === 'docker'
      ? '容器将停止并移除（docker stop + rm）'
      : t.kind === 'vm'
        ? 'VM 将关机'
        : '实例将停止';
  return {
    body: `停止环境「${t.label}」？${what}，进行中的现场可能丢失。`,
    confirmLabel: '停止环境',
  };
}

/**
 * 1.3.8 B12：侧栏 ⏹ 停止按钮的显隐判定——ssh 直连条目无实体可停
 * （environment/down 对 ssh 明确报错），停止只适用于 docker/VM 系。
 */
export function canStopEnv(kind: string): boolean {
  return kind !== 'ssh';
}
