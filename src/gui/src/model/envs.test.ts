/**
 * 环境侧栏分组单测。
 */

import { describe, expect, it } from 'vitest';

import { groupSidebar, isSwitchable } from './envs';

const envs = [
  { id: 'pwn@docker', kind: 'docker', name: 'pwn@docker' },
  { id: 'audit-box', kind: 'docker', name: 'audit-box' },
];
const running = [
  { id: 'pwn@docker', status: 'running', driver: 'docker' },
];
const discovered = [
  { id: 'kali-2024', name: 'kali-2024', state: 'powered off', driver: 'vmware' },
  { id: 'pwn@docker', name: 'pwn@docker', state: 'running', driver: 'docker' }, // 已登记 → 不入本机已有
];

describe('groupSidebar', () => {
  it('三组划分：运行中 / 已停止 / 本机已有（去重已登记）', () => {
    const groups = groupSidebar(envs, running, discovered);
    expect(groups.map((g) => g.label)).toEqual(['运行中', '已停止', '本机已有']);
    expect(groups[0].items.map((i) => i.key)).toEqual(['pwn@docker']);
    expect(groups[1].items.map((i) => i.key)).toEqual(['audit-box']);
    expect(groups[2].items.map((i) => i.key)).toEqual(['kali-2024']);
  });

  it('空组不渲染', () => {
    const groups = groupSidebar([], [], []);
    expect(groups).toEqual([]);
  });

  it('运行中实例用登记名回退', () => {
    const groups = groupSidebar([], [{ id: 'c1', name: '容器一', status: 'running', driver: 'docker' }], []);
    expect(groups[0].items[0].label).toBe('容器一');
  });
});

describe('isSwitchable', () => {
  it('unreg 组不可切换（未登记）', () => {
    expect(isSwitchable({ key: 'x', label: 'x', group: 'unreg', detail: '', kind: 'docker', warn: false, startable: false })).toBe(false);
    expect(isSwitchable({ key: 'x', label: 'x', group: 'run', detail: '', kind: 'docker', warn: false, startable: false })).toBe(true);
  });
});

describe('startable（1.3.1 ① 启动按钮）', () => {
  const base = { id: 's', name: 's' };

  it('docker/vm 带 recipeId → 启动按钮可用', () => {
    const groups = groupSidebar(
      [
        { ...base, kind: 'docker', recipeId: 'pwn' },
        { ...base, id: 'v', kind: 'vm', recipeId: 'rev' },
        { ...base, id: 'x', kind: 'ssh' },
      ],
      [],
      [],
    );
    const stop = groups.find((g) => g.label === '已停止');
    expect(stop).toBeDefined();
    const byKey = new Map(stop!.items.map((i) => [i.key, i]));
    expect(byKey.get('s')?.startable).toBe(true);
    expect(byKey.get('s')?.recipeId).toBe('pwn');
    expect(byKey.get('v')?.startable).toBe(true);
    expect(byKey.get('x')?.startable).toBe(false); // ssh 无配方不可启
  });

  it('运行中 / 本机已有组永不可启动（已在跑 / 未登记）', () => {
    const groups = groupSidebar(
      [{ ...base, kind: 'docker', recipeId: 'pwn' }],
      [{ id: 's', status: 'running', driver: 'docker' }],
      [{ id: 'k', name: 'k', state: 'powered off', driver: 'vmware' }],
    );
    const run = groups.find((g) => g.label === '运行中');
    const unreg = groups.find((g) => g.label === '本机已有');
    expect(run?.items[0].startable).toBe(false);
    expect(unreg?.items[0].startable).toBe(false);
  });
});
