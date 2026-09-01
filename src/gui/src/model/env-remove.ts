/**
 * 环境删除确认（1.3.7 补口，纯函数）。
 *
 * 侧栏「删除」入口的判定与文案——按驱动给准确语义（不许含糊），与服务端
 * handleEnvironmentRm（src/server/admin-api.ts）一一对应：
 *   ssh        → 只摘登记，远端机器不受影响
 *   docker     → 1.5.10 起真删：stop（幂等）+ rm 容器 + 摘登记——容器现场
 *                随删不可恢复；镜像保留（可重新 up 派生）。docker 不可用
 *                探测失败时服务端降级为只摘登记
 *   vm + vmx   → vmware：只摘登记，VM 文件原样保留
 *   vm 无 vmx  → hyperv/vbox：会删除 VM 实例（Remove-VM / unregistervm
 *                --delete）——强警示（红）+ 输入环境名二次确认
 *   运行中     → 不弹模态，toast 提示先停止
 *
 * 纯函数：不 import store / React / client；单测逐形态断言文案与确认强度。
 */

export interface EnvRemoveTarget {
  /** 登记条目 id（environment/rm 的入参）。 */
  id: string;
  /** 展示名（模态文案 + 二次确认输入比对）。 */
  label: string;
  /** 登记条目 kind（ssh / docker / vm）。 */
  kind: string;
  /** vmware 条目的 vmx 路径（有才判定为「只摘登记」形态）。 */
  vmx?: string;
  /** 运行中（侧栏「运行中」组）——先停止再删除。 */
  running: boolean;
}

/** 确认强度：confirm=点「确认」即可；type-name=需输入环境名（仅删 VM 实例）。 */
export type EnvRemoveStrength = 'confirm' | 'type-name';

export interface EnvRemovePlan {
  /** false = 运行中拦截（不弹模态，showToast blockToast）。 */
  allowed: boolean;
  /** 运行中拦截的 toast 文案。 */
  blockToast?: string;
  /** 强警示（红色危险态）——仅「删 VM 实例」形态。 */
  danger: boolean;
  strength: EnvRemoveStrength;
  /** 模态正文（准确说明会发生什么 / 不会发生什么）。 */
  body: string;
  /** 确认按钮文案。 */
  confirmLabel: string;
}

export function envRemovePlan(t: EnvRemoveTarget): EnvRemovePlan {
  if (t.running) {
    return {
      allowed: false,
      blockToast: `环境「${t.label}」正在运行——先停止再删除`,
      danger: false,
      strength: 'confirm',
      body: '',
      confirmLabel: '',
    };
  }
  if (t.kind === 'vm' && !t.vmx) {
    return {
      allowed: true,
      danger: true,
      strength: 'type-name',
      body:
        `将删除「${t.label}」的 VM 实例并移除登记——` +
        'Hyper-V 执行 Remove-VM、VirtualBox 执行 unregistervm --delete，' +
        '虚拟机实例将被永久删除，不可恢复。',
      confirmLabel: '永久删除',
    };
  }
  // 1.5.10：docker 停着删除 = 真删（stop 幂等 + rm 容器 + 摘登记）——现场
  // 随删不可恢复，升警示态（红）；镜像保留，重新 up 可再派生。
  if (t.kind === 'docker') {
    return {
      allowed: true,
      danger: true,
      strength: 'confirm',
      body:
        `将删除「${t.label}」的容器（docker rm）并移除环境登记——` +
        '容器内现场随删、不可恢复；镜像保留（可重新启动派生干净容器），' +
        '/workspace 挂载成果不受影响。',
      confirmLabel: '删除容器并移除登记',
    };
  }
  const body =
    t.kind === 'ssh'
      ? `将移除「${t.label}」的环境登记——只摘除登记，远端机器不受任何影响。`
      : `将移除「${t.label}」的环境登记——只摘除登记，VM 文件原样保留，不做任何删除。`;
  return {
    allowed: true,
    danger: false,
    strength: 'confirm',
    body,
    confirmLabel: '移除登记',
  };
}
