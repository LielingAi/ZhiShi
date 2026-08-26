/**
 * 环境停止确认文案单测（1.3.8 ①）。
 */

import { describe, expect, it } from 'vitest';

import { canStopEnv, envDownPlan } from './env-down';

describe('envDownPlan（1.3.8 ① 停止确认）', () => {
  it('docker：容器将停止并移除', () => {
    const plan = envDownPlan({ id: 'docker-kali', label: 'kali', kind: 'docker' });
    expect(plan.body).toBe('停止环境「kali」？容器将停止并移除（docker stop + rm），进行中的现场可能丢失。');
    expect(plan.confirmLabel).toBe('停止环境');
  });

  it('vm：VM 将关机', () => {
    const plan = envDownPlan({ id: 'fuzz', label: 'fuzz', kind: 'vm' });
    expect(plan.body).toBe('停止环境「fuzz」？VM 将关机，进行中的现场可能丢失。');
  });

  it('ps driver（hyperv/vbox 等未知 kind）兜底「实例将停止」', () => {
    const plan = envDownPlan({ id: 'win11', label: 'win11', kind: 'hyperv' });
    expect(plan.body).toBe('停止环境「win11」？实例将停止，进行中的现场可能丢失。');
  });

  it('各形态都含现场丢失警示', () => {
    for (const kind of ['docker', 'vm', 'hyperv', 'vbox']) {
      expect(envDownPlan({ id: 'x', label: 'x', kind }).body).toContain('进行中的现场可能丢失');
    }
  });
});

describe('canStopEnv（1.3.8 B12：ssh 行不出停止按钮）', () => {
  it('ssh 无实体可停 → false', () => {
    expect(canStopEnv('ssh')).toBe(false);
  });

  it('docker / vm / hyperv / vbox → true（停止只适用于有实体的一类）', () => {
    for (const kind of ['docker', 'vm', 'hyperv', 'vbox']) {
      expect(canStopEnv(kind)).toBe(true);
    }
  });
});
