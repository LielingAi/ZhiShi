/**
 * 显式重建 / 重置确认（1.5.10 三层模型主项，纯函数）。
 *
 * 「镜像为主」落地后 up 不再自动 build——要新配方内容/干净容器走显式入口：
 *   重新构建（environment/rebuild {recipe}）→ 强制 docker build 新镜像 +
 *     stop+rm 同配方旧容器（旧现场随删）+ run 全新容器——镜像坏了/配方
 *     内容更新时人选。
 *   重置容器（environment/reset {id}）→ 镜像不动，stop+rm 条目容器 +
 *     run 干净新容器——现场清空，要干净房间时人选。
 * 两者都是有损操作，确认模态文案按服务端语义写实（src/server/admin-api.ts
 * ::handleEnvironmentRebuild / handleEnvironmentReset，只读核实）。
 *
 * 纯函数：不 import store / React / client；单测逐形态断言文案与显隐。
 */

export interface EnvRebuildTarget {
  /** rebuild 的配方 id（environment/rebuild {recipe} 的入参）。 */
  recipe: string;
  /** 展示名（模态文案；登记条目名或配方 id）。 */
  label: string;
}

export interface EnvResetTarget {
  /** 登记条目 id（environment/reset {id} 的入参）。 */
  id: string;
  /** 展示名（模态文案）。 */
  label: string;
}

export interface EnvOpPlan {
  /** 模态正文（准确说明会发生什么）。 */
  body: string;
  /** 确认按钮文案。 */
  confirmLabel: string;
}

/** ⋯ 菜单「重新构建…」显隐：条目带配方归属（recipeId 非空）才显示
 * （VM 配方由服务端拒走 environment/build——GUI 侧不预判，错误原文 toast）。 */
export function canRebuildEnv(item: { recipeId?: string }): boolean {
  return typeof item.recipeId === 'string' && item.recipeId !== '';
}

/** ⋯ 菜单「重置容器…」显隐：重置只适用于 docker 条目（服务端按 kind 拒绝其它）。 */
export function canResetEnv(item: { kind: string }): boolean {
  return item.kind === 'docker';
}

export function envRebuildPlan(t: EnvRebuildTarget): EnvOpPlan {
  return {
    body:
      `重新构建环境「${t.label}」（配方 ${t.recipe}）？` +
      '将强制重新构建镜像（docker build，分钟级）并换成全新容器——' +
      '旧容器连同其中现场一并删除，不可恢复；/workspace 挂载成果不受影响。',
    confirmLabel: '重新构建',
  };
}

export function envResetPlan(t: EnvResetTarget): EnvOpPlan {
  return {
    body:
      `重置环境「${t.label}」的容器？镜像不动，` +
      '将停止并删除当前容器、用同一镜像换成干净新容器——' +
      '容器内现场全部清空，不可恢复；/workspace 挂载成果不受影响。',
    confirmLabel: '重置容器',
  };
}
