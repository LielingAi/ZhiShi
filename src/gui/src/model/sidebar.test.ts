import { describe, expect, it } from 'vitest';

import { mergeSidebarSnapshot, type SidebarSnapshot } from './sidebar';

function snap(): SidebarSnapshot {
  return {
    envs: [{ id: 'env:old', kind: 'docker' }],
    running: [{ id: 'ps:old' }],
    discoveredDocker: [{ id: 'dk:old' }],
    discoveredVm: [{ driver: 'vmware', id: 'vm:old' }],
    discoveredImages: [{ driver: 'docker-image', id: 'zhishi-env-old:latest', recipeId: 'old' }],
    recipes: [{ id: 'r:old', name: 'R-old', tools: [] }],
    domains: [{ kind: 'binary', name: '二进制', recipes: ['r:old'] }],
  };
}

describe('mergeSidebarSnapshot（侧栏快照归并 + 代次治理）', () => {
  it('最新令牌：fulfilled 字段全覆盖', () => {
    const merged = mergeSidebarSnapshot(2, 2, snap(), {
      envs: [{ id: 'env:new', kind: 'ssh' }],
      running: [{ id: 'ps:new' }],
      discover: { docker: [{ id: 'dk:new' }], vm: [{ driver: 'hyperv', id: 'vm:new' }] },
      recipes: [{ id: 'r:new', name: 'R-new', tools: [] }],
      domains: [{ kind: 'pentest', name: '渗透', recipes: ['r:new'] }],
    });
    expect(merged).not.toBeNull();
    expect(merged?.envs.map((e) => e.id)).toEqual(['env:new']);
    expect(merged?.running.map((r) => r.id)).toEqual(['ps:new']);
    expect(merged?.discoveredDocker.map((d) => d.id)).toEqual(['dk:new']);
    expect(merged?.discoveredVm.map((v) => v.id)).toEqual(['vm:new']);
    // 1.5.10：images 键缺失（旧 sidecar 快照）→ 回退旧值，不清空
    expect(merged?.discoveredImages.map((d) => d.id)).toEqual(['zhishi-env-old:latest']);
    expect(merged?.recipes.map((r) => r.id)).toEqual(['r:new']);
    expect(merged?.domains.map((d) => d.kind)).toEqual(['pentest']);
  });

  it('过期令牌：整体丢弃（旧轮结果不落盘）', () => {
    // 令牌 1 是旧轮，期间令牌已推进到 2（更新的刷新已启动）。
    const merged = mergeSidebarSnapshot(1, 2, snap(), {
      envs: [{ id: 'env:stale', kind: 'vm' }],
    });
    expect(merged).toBeNull();
  });

  it('单请求失败/缺失：对应字段回退旧值，其余字段照常覆盖', () => {
    const merged = mergeSidebarSnapshot(3, 3, snap(), {
      envs: undefined, // environment/list 失败 → 保留旧 envs
      running: [{ id: 'ps:new' }],
      // 1.5.10：discover 三键——docker/vm 覆盖，images 缺失 → 回退旧值
      discover: {
        docker: [{ id: 'dk:new' }],
        vm: [],
        images: [{ driver: 'docker-image', id: 'zhishi-env-pwn:latest', recipeId: 'pwn' }],
      },
      // recipes / domains 缺失 → 回退旧值
    });
    expect(merged).not.toBeNull();
    expect(merged?.envs.map((e) => e.id)).toEqual(['env:old']);
    expect(merged?.running.map((r) => r.id)).toEqual(['ps:new']);
    expect(merged?.discoveredDocker.map((d) => d.id)).toEqual(['dk:new']);
    expect(merged?.discoveredVm).toEqual([]);
    expect(merged?.discoveredImages.map((d) => d.id)).toEqual(['zhishi-env-pwn:latest']);
    expect(merged?.recipes.map((r) => r.id)).toEqual(['r:old']);
    expect(merged?.domains.map((d) => d.kind)).toEqual(['binary']);
  });
});
