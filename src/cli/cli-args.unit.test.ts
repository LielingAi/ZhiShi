/**
 * cli-args.ts 单测（1.4.7 zhishi.ts 主体单测起步的第一步）——CLI 边界解析
 * 层纯函数：parseArgs（长短 flag/可重复/等号形态/布尔旗标/位置参数）+
 * camelCase。
 */
import { describe, expect, it } from 'vitest';

import { camelCase, isSidecarPortOverride, parseArgs } from './cli-args';

describe('parseArgs（CLI 边界解析）', () => {
  it('位置参数 + 长 flag(--key value / --key=value) + 布尔旗标', () => {
    const r = parseArgs(['env', 'list', '--task-id', 'abc', '--force', '--limit=5']);
    expect(r.positional).toEqual(['env', 'list']);
    expect(r.flags.taskId).toBe('abc');
    expect(r.flags.force).toBe(true);
    expect(r.flags.limit).toBe('5');
  });

  it('可重复 flag 累积数组（--models 重复出现）', () => {
    const r = parseArgs(['agent', 'set', 'x', '--models', 'a', '--models', '--weird', '--models=c']);
    expect(r.flags.models).toEqual(['a', '--weird', 'c']);
  });

  it('审计 A3-6 回归：--env 非 repeatable，重复传后者覆盖前者（不再拼成数组）', () => {
    const r = parseArgs(['term', 'open', '--env', 'host', '--env', 'docker:c1']);
    expect(r.flags.env).toBe('docker:c1');
  });

  it('短旗标 `-p` 已删除（零消费方）——裸 `-x` 一律按位置参数处理', () => {
    const r = parseArgs(['agent', 'send', '-p', '你好']);
    expect(r.positional).toEqual(['agent', 'send', '-p', '你好']);
    expect(r.flags.prompt).toBeUndefined();
  });

  it('kebab-case key → camelCase（--task-id → taskId）', () => {
    const r = parseArgs(['--loop-session-id', 'ls-1']);
    expect(r.flags.loopSessionId).toBe('ls-1');
  });

  it('空输入 → 空 positional + 空 flags', () => {
    expect(parseArgs([])).toEqual({ positional: [], flags: {} });
  });
});

describe('camelCase', () => {
  it('kebab → camel;无连字符原样', () => {
    expect(camelCase('task-id')).toBe('taskId');
    expect(camelCase('env')).toBe('env');
    expect(camelCase('a-b-c')).toBe('aBC');
  });
});

describe('isSidecarPortOverride（审计 A1-4：env add --port 是 ssh 端口，不覆盖 sidecar 端口）', () => {
  it('env add → false；其余命令 → true', () => {
    expect(isSidecarPortOverride(['env', 'add'])).toBe(false);
    expect(isSidecarPortOverride(['env', 'list'])).toBe(true);
    expect(isSidecarPortOverride(['env', 'open', 'dev-box'])).toBe(true);
    expect(isSidecarPortOverride(['status'])).toBe(true);
    expect(isSidecarPortOverride([])).toBe(true);
  });
});
