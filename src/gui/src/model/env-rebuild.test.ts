/**
 * 显式重建 / 重置确认（env-rebuild）单测：文案写实 + ⋯ 菜单显隐判定。
 */

import { describe, expect, it } from 'vitest';

import { canRebuildEnv, canResetEnv, envRebuildPlan, envResetPlan } from './env-rebuild';

describe('envRebuildPlan（1.5.10 显式重建确认）', () => {
  it('文案写清：镜像重建 + 换全新容器 + 旧现场随删 + /workspace 不受影响', () => {
    const plan = envRebuildPlan({ recipe: 'pwn', label: 'pwn-box' });
    expect(plan.body).toContain('pwn-box');
    expect(plan.body).toContain('pwn');
    expect(plan.body).toContain('重新构建镜像');
    expect(plan.body).toContain('全新容器');
    expect(plan.body).toContain('不可恢复');
    expect(plan.body).toContain('/workspace');
    expect(plan.confirmLabel).toBe('重新构建');
  });
});

describe('envResetPlan（1.5.10 显式重置确认）', () => {
  it('文案写清：镜像不动 + 换干净容器 + 现场清空', () => {
    const plan = envResetPlan({ id: 'zhishi-pwn-a1b2', label: 'pwn-box' });
    expect(plan.body).toContain('pwn-box');
    expect(plan.body).toContain('镜像不动');
    expect(plan.body).toContain('干净新容器');
    expect(plan.body).toContain('现场全部清空');
    expect(plan.body).toContain('不可恢复');
    expect(plan.confirmLabel).toBe('重置容器');
  });
});

describe('⋯ 菜单显隐（1.5.10）', () => {
  it('重新构建：recipeId 非空才显示', () => {
    expect(canRebuildEnv({ recipeId: 'pwn' })).toBe(true);
    expect(canRebuildEnv({ recipeId: '' })).toBe(false);
    expect(canRebuildEnv({})).toBe(false);
  });

  it('重置容器：仅 docker 条目显示', () => {
    expect(canResetEnv({ kind: 'docker' })).toBe(true);
    expect(canResetEnv({ kind: 'vm' })).toBe(false);
    expect(canResetEnv({ kind: 'ssh' })).toBe(false);
  });
});
