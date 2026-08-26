import { describe, expect, it } from 'vitest';

import {
  addRecipeBinding,
  boundRecipeIds,
  describeBindingDiff,
  removeRecipeBinding,
} from './env-recipes';

describe('boundRecipeIds（绑定集合归一，缺省等价 [主配方]）', () => {
  it('无 recipeIds → [recipeId]', () => {
    expect(boundRecipeIds({ id: 'e1', recipeId: 'pwn' })).toEqual(['pwn']);
  });

  it('有 recipeIds → 原样保序', () => {
    expect(boundRecipeIds({ id: 'e1', recipeId: 'pwn', recipeIds: ['pwn', 'pentest'] })).toEqual([
      'pwn',
      'pentest',
    ]);
  });

  it('recipeIds 漏主配方 → 补回主配方在前（防御性展示兜底）', () => {
    expect(boundRecipeIds({ id: 'e1', recipeId: 'pwn', recipeIds: ['pentest'] })).toEqual([
      'pwn',
      'pentest',
    ]);
  });

  it('无主配方无 recipeIds → 空集合', () => {
    expect(boundRecipeIds({ id: 'e1' })).toEqual([]);
  });
});

describe('addRecipeBinding / removeRecipeBinding', () => {
  it('追加幂等去重', () => {
    expect(addRecipeBinding(['pwn'], 'pentest')).toEqual(['pwn', 'pentest']);
    expect(addRecipeBinding(['pwn', 'pentest'], 'pentest')).toEqual(['pwn', 'pentest']);
  });

  it('移除非主配方成功', () => {
    const r = removeRecipeBinding(['pwn', 'pentest'], 'pentest', 'pwn');
    expect(r.ok).toBe(true);
    expect(r.next).toEqual(['pwn']);
  });

  it('主配方不可移除', () => {
    const r = removeRecipeBinding(['pwn', 'pentest'], 'pwn', 'pwn');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不可移除');
    expect(r.next).toEqual(['pwn', 'pentest']);
  });

  it('移除不存在的绑定 = 幂等成功', () => {
    const r = removeRecipeBinding(['pwn'], 'nope', 'pwn');
    expect(r.ok).toBe(true);
    expect(r.next).toEqual(['pwn']);
  });
});

describe('describeBindingDiff', () => {
  it('增/减各行一行', () => {
    expect(describeBindingDiff(['pwn'], ['pwn', 'pentest', 'fuzz'])).toEqual([
      '＋ 绑定 pentest',
      '＋ 绑定 fuzz',
    ]);
    expect(describeBindingDiff(['pwn', 'pentest'], ['pwn'])).toEqual(['－ 解绑 pentest']);
  });
});
