/**
 * cli-args.ts 单测（1.4.7 zhishi.ts 主体单测起步的第一步）——CLI 边界解析
 * 层纯函数：parseArgs（长短 flag/可重复/等号形态/布尔旗标/位置参数）+
 * camelCase。
 */
import { describe, expect, it } from 'vitest';

import { camelCase, parseArgs } from './cli-args';

describe('parseArgs（CLI 边界解析）', () => {
  it('位置参数 + 长 flag(--key value / --key=value) + 布尔旗标', () => {
    const r = parseArgs(['env', 'list', '--task-id', 'abc', '--force', '--limit=5']);
    expect(r.positional).toEqual(['env', 'list']);
    expect(r.flags.taskId).toBe('abc');
    expect(r.flags.force).toBe(true);
    expect(r.flags.limit).toBe('5');
  });

  it('可重复 flag 累积数组（--args 重复出现）', () => {
    const r = parseArgs(['mcp', 'add', 'x', '--args', 'a', '--args', '--stdio', '--args=c']);
    expect(r.flags.args).toEqual(['a', '--stdio', 'c']);
  });

  it('短 flag -p → prompt;缺值/下一个仍是 flag → true（不吞下一个 flag）', () => {
    const r = parseArgs(['agent', 'send', '-p', '你好']);
    expect(r.flags.prompt).toBe('你好');
    const r2 = parseArgs(['x', '-p', '--help']);
    expect(r2.flags.prompt).toBe(true);
    expect(r2.flags.help).toBe(true);
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
