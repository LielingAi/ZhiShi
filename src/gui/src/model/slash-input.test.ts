/**
 * slash-input.test.ts — 1.5.2 / 命令输入解析单测。
 *
 * 覆盖：parseSlashInput（命令名+参数段/无参/非斜杠/空体）、slashNameSegment
 * （过滤段只吃命令名——实锤②）、isKnownCommand（路由表+本地四）、
 * acceptsInlineArgs（inline 白名单——rewind/fork 不在列）。
 */
import { describe, expect, it } from 'vitest';

import {
  acceptsInlineArgs,
  isKnownCommand,
  LOCAL_COMMANDS,
  parseSlashInput,
  slashNameSegment,
} from './slash-input';

describe('parseSlashInput（/name args…）', () => {
  it('命令名 + 参数段', () => {
    expect(parseSlashInput('/intel CVE-2024-1234')).toEqual({ name: 'intel', args: 'CVE-2024-1234' });
  });

  it('多词参数段整体保留（trim）', () => {
    expect(parseSlashInput('/decide 要不要换 joern 方案')).toEqual({ name: 'decide', args: '要不要换 joern 方案' });
  });

  it('无参数 → args 空串', () => {
    expect(parseSlashInput('/archive')).toEqual({ name: 'archive', args: '' });
  });

  it('非斜杠/空体/纯斜杠 → null', () => {
    expect(parseSlashInput('普通文本')).toBeNull();
    expect(parseSlashInput('/')).toBeNull();
    expect(parseSlashInput('/  ')).toBeNull();
  });
});

describe('slashNameSegment（过滤段只吃命令名——实锤②）', () => {
  it('/intel CVE-2024-1234 → intel（参数段不参与过滤）', () => {
    expect(slashNameSegment('/intel CVE-2024-1234')).toBe('intel');
  });
  it('无参数 → 全名', () => {
    expect(slashNameSegment('/snapshot')).toBe('snapshot');
  });
});

describe('isKnownCommand / acceptsInlineArgs', () => {
  it('路由表命令 + 本地四命令', () => {
    expect(isKnownCommand('snapshot')).toBe(true);
    expect(isKnownCommand('intel')).toBe(true);
    for (const c of LOCAL_COMMANDS) expect(isKnownCommand(c)).toBe(true);
    expect(isKnownCommand('root')).toBe(false);
    expect(isKnownCommand('etc')).toBe(false);
  });

  it('inline 白名单：snapshot/rollback/extract/intel/decide 在列；rewind/fork 不在', () => {
    for (const c of ['snapshot', 'rollback', 'extract', 'intel', 'decide']) {
      expect(acceptsInlineArgs(c)).toBe(true);
    }
    expect(acceptsInlineArgs('rewind')).toBe(false);
    expect(acceptsInlineArgs('fork')).toBe(false);
    expect(acceptsInlineArgs('archive')).toBe(false);
  });
});
