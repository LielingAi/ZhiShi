/**
 * 环境停止确认文案单测（1.3.8 ①）。
 */

import { describe, expect, it } from 'vitest';

import { canStopEnv, envDownPlan } from './env-down';

describe('envDownPlan（1.3.8 ① 停止确认）', () => {
  it('docker：1.5.10 暂停语义——stop 不 rm，现场保留，下次秒续', () => {
    const plan = envDownPlan({ id: 'docker-kali', label: 'kali', kind: 'docker' });
    expect(plan.title).toBe('暂停环境');
    expect(plan.body).toBe('暂停环境「kali」？容器将停止但保留（docker stop，不删容器）——现场保留，下次启动秒续。');
    expect(plan.confirmLabel).toBe('暂停环境');
  });

  it('vm：VM 将关机', () => {
    const plan = envDownPlan({ id: 'fuzz', label: 'fuzz', kind: 'vm' });
    expect(plan.title).toBe('停止环境');
    expect(plan.body).toBe('停止环境「fuzz」？VM 将关机，进行中的现场可能丢失。');
  });

  it('ps driver（hyperv/vbox 等未知 kind）兜底「实例将停止」', () => {
    const plan = envDownPlan({ id: 'win11', label: 'win11', kind: 'hyperv' });
    expect(plan.body).toBe('停止环境「win11」？实例将停止，进行中的现场可能丢失。');
  });

  it('VM 系形态含现场丢失警示；docker 暂停不警示（现场保留）', () => {
    for (const kind of ['vm', 'hyperv', 'vbox']) {
      expect(envDownPlan({ id: 'x', label: 'x', kind }).body).toContain('进行中的现场可能丢失');
    }
    const docker = envDownPlan({ id: 'x', label: 'x', kind: 'docker' });
    expect(docker.body).not.toContain('现场可能丢失');
    expect(docker.body).toContain('现场保留');
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
