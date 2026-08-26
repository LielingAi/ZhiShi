/**
 * 环境删除确认（env-remove）单测：五类形态各自的文案 / 确认强度 / 警示级。
 */

import { describe, expect, it } from 'vitest';

import { envRemovePlan, type EnvRemoveTarget } from './env-remove';

function target(patch: Partial<EnvRemoveTarget>): EnvRemoveTarget {
  return { id: 'e1', label: '靶机一', kind: 'ssh', running: false, ...patch };
}

describe('envRemovePlan — 五类形态', () => {
  it('ssh：只摘登记，远端机器不受影响（轻确认，非警示）', () => {
    const plan = envRemovePlan(target({ kind: 'ssh' }));
    expect(plan.allowed).toBe(true);
    expect(plan.danger).toBe(false);
    expect(plan.strength).toBe('confirm');
    expect(plan.body).toContain('只摘除登记');
    expect(plan.body).toContain('远端机器不受');
    expect(plan.confirmLabel).toBe('移除登记');
  });

  it('docker：只摘登记，容器实例销毁走「环境停止」（轻确认，非警示）', () => {
    const plan = envRemovePlan(target({ kind: 'docker' }));
    expect(plan.allowed).toBe(true);
    expect(plan.danger).toBe(false);
    expect(plan.strength).toBe('confirm');
    expect(plan.body).toContain('只摘除登记');
    expect(plan.body).toContain('容器实例不在此删除');
    expect(plan.body).toContain('环境停止');
  });

  it('vm + vmx（vmware）：只摘登记，VM 文件原样保留（轻确认，非警示）', () => {
    const plan = envRemovePlan(target({ kind: 'vm', vmx: 'D:\\VMs\\pwn\\pwn.vmx' }));
    expect(plan.allowed).toBe(true);
    expect(plan.danger).toBe(false);
    expect(plan.strength).toBe('confirm');
    expect(plan.body).toContain('只摘除登记');
    expect(plan.body).toContain('VM 文件原样保留');
  });

  it('vm 无 vmx（hyperv/vbox）：会删除 VM 实例——强警示 + 输入环境名', () => {
    const plan = envRemovePlan(target({ kind: 'vm' }));
    expect(plan.allowed).toBe(true);
    expect(plan.danger).toBe(true);
    expect(plan.strength).toBe('type-name');
    expect(plan.body).toContain('Remove-VM');
    expect(plan.body).toContain('unregistervm --delete');
    expect(plan.body).toContain('不可恢复');
    expect(plan.confirmLabel).toBe('永久删除');
  });

  it('运行中：不弹模态，toast 提示先停止（与 kind 无关）', () => {
    for (const kind of ['ssh', 'docker', 'vm']) {
      const plan = envRemovePlan(target({ kind, running: true }));
      expect(plan.allowed).toBe(false);
      expect(plan.blockToast).toContain('正在运行');
      expect(plan.blockToast).toContain('先停止再删除');
    }
  });

  it('文案带展示名；未知 kind 兜底按「只摘登记」处理', () => {
    const plan = envRemovePlan(target({ kind: 'vm', vmx: '/v/a.vmx', label: '靶场A' }));
    expect(plan.body).toContain('靶场A');
    const unknown = envRemovePlan(target({ kind: 'mystery' }));
    expect(unknown.danger).toBe(false);
    expect(unknown.body).toContain('只摘除登记');
  });
});
