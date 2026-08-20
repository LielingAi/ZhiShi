/**
 * model unit tests — /model 与 /mcp 参数解析、状态卡行构造、隐藏输入缓冲。
 * 全部纯函数,无 IO;命令的副作用外壳(app.ts 的 adminPost / pushBlock /
 * 输入流接管)留在 integration.sse-replay.unit.test.ts 的路径外,不在此测。
 */

import { describe, it, expect } from 'vitest';
import {
  parseModelArgs,
  parseMcpArgs,
  reduceHiddenLine,
  composeModelCardRows,
  composeMcpCardRows,
  HIDDEN_LINE_MAX,
  type ModelProviderInfo,
  type McpServerRow,
  type McpBridgeRow,
} from './model';

function provider(patch: Partial<ModelProviderInfo> = {}): ModelProviderInfo {
  return {
    id: 'openai',
    name: 'OpenAI',
    enabled: true,
    hasApiKey: true,
    status: 'not-set',
    models: [{ model: 'gpt-5.4' }, { model: 'gpt-5.4-mini' }],
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// parseModelArgs
// ---------------------------------------------------------------------------

describe('parseModelArgs', () => {
  it('无参 → 状态卡', () => {
    expect(parseModelArgs('')).toEqual({ kind: 'status' });
    expect(parseModelArgs('   ')).toEqual({ kind: 'status' });
  });

  it('set-key <id> → 隐藏输入填 key', () => {
    expect(parseModelArgs('set-key deepseek')).toEqual({ kind: 'set-key', providerId: 'deepseek' });
  });

  it('set-key 缺供应商 → 用法错误', () => {
    expect(parseModelArgs('set-key')).toEqual({ kind: 'error', message: '用法：/model set-key <供应商id>' });
    expect(parseModelArgs('set-key a b')).toMatchObject({ kind: 'error' });
  });

  it('use <id> <模型> → 带供应商语义切换', () => {
    expect(parseModelArgs('use openai gpt-5.4')).toEqual({ kind: 'use', providerId: 'openai', model: 'gpt-5.4' });
  });

  it('use 参数个数不对 → 用法错误', () => {
    expect(parseModelArgs('use openai')).toEqual({ kind: 'error', message: '用法：/model use <供应商id> <模型名>' });
    expect(parseModelArgs('use openai gpt-5.4 extra')).toMatchObject({ kind: 'error' });
  });

  it('单个 token → 旧语法 /model <模型名>(向后兼容)', () => {
    expect(parseModelArgs('claude-sonnet-4-6')).toEqual({ kind: 'switch', model: 'claude-sonnet-4-6' });
  });

  it('多余 token → 错误', () => {
    expect(parseModelArgs('foo bar')).toMatchObject({ kind: 'error' });
  });
});

// ---------------------------------------------------------------------------
// parseMcpArgs
// ---------------------------------------------------------------------------

describe('parseMcpArgs', () => {
  it('无参 → 状态', () => {
    expect(parseMcpArgs('')).toEqual({ kind: 'status' });
  });

  it('-r / --reload → 重载(兼容旧语法,任意位置)', () => {
    expect(parseMcpArgs('-r')).toEqual({ kind: 'reload' });
    expect(parseMcpArgs('--reload')).toEqual({ kind: 'reload' });
    expect(parseMcpArgs('foo -r')).toEqual({ kind: 'reload' });
  });

  it('enable/disable <id> → 开关', () => {
    expect(parseMcpArgs('enable terminator')).toEqual({ kind: 'enable', id: 'terminator' });
    expect(parseMcpArgs('disable terminator')).toEqual({ kind: 'disable', id: 'terminator' });
  });

  it('enable/disable 缺 id 或多参数 → 用法错误', () => {
    expect(parseMcpArgs('enable')).toEqual({ kind: 'error', message: '用法：/mcp enable <id>' });
    expect(parseMcpArgs('disable a b')).toEqual({ kind: 'error', message: '用法：/mcp disable <id>' });
  });

  it('未知参数 → 错误', () => {
    expect(parseMcpArgs('garbage')).toMatchObject({ kind: 'error' });
  });
});

// ---------------------------------------------------------------------------
// reduceHiddenLine
// ---------------------------------------------------------------------------

describe('reduceHiddenLine', () => {
  it('字符逐个拼接', () => {
    const a = reduceHiddenLine('', { type: 'char', char: 's' });
    expect(a).toEqual({ done: false, buffer: 's' });
    if (a.done) throw new Error('unreachable');
    expect(reduceHiddenLine(a.buffer, { type: 'char', char: 'k' })).toEqual({ done: false, buffer: 'sk' });
  });

  it('退格删除末字符;空缓冲退格保持空', () => {
    expect(reduceHiddenLine('sk-', { type: 'backspace' })).toEqual({ done: false, buffer: 'sk' });
    expect(reduceHiddenLine('', { type: 'backspace' })).toEqual({ done: false, buffer: '' });
  });

  it('Enter 提交非空值', () => {
    expect(reduceHiddenLine('sk-123', { type: 'submit' })).toEqual({ done: true, cancelled: false, value: 'sk-123' });
  });

  it('Enter 提交空串按取消处理(空 key 无意义)', () => {
    expect(reduceHiddenLine('', { type: 'submit' })).toEqual({ done: true, cancelled: true });
  });

  it('Esc/取消 → cancelled', () => {
    expect(reduceHiddenLine('abc', { type: 'cancel' })).toEqual({ done: true, cancelled: true });
  });

  it('超长拒绝追加(防粘贴事故)', () => {
    let buf = '';
    for (let i = 0; i < HIDDEN_LINE_MAX; i++) {
      const out = reduceHiddenLine(buf, { type: 'char', char: 'x' });
      if (out.done) throw new Error('unreachable');
      buf = out.buffer;
    }
    expect(reduceHiddenLine(buf, { type: 'char', char: 'y' })).toEqual({ done: false, buffer: buf });
    expect(buf.length).toBe(HIDDEN_LINE_MAX);
  });
});

// ---------------------------------------------------------------------------
// composeModelCardRows
// ---------------------------------------------------------------------------

describe('composeModelCardRows', () => {
  it('表头含家数与当前默认模型', () => {
    const rows = composeModelCardRows([provider()], 'kimi-k2');
    expect(rows[0]).toEqual({
      label: '模型供应商',
      follow: '1 家 · 当前默认 kimi-k2',
      tone: 'info',
    });
  });

  it('已配 key → green;未配 → faint;已禁用 → red', () => {
    const rows = composeModelCardRows(
      [
        provider({ id: 'openai', hasApiKey: true }),
        provider({ id: 'deepseek', name: 'DeepSeek', hasApiKey: false, models: [{ model: 'deepseek-v4-pro' }] }),
        provider({ id: 'x', name: 'X', enabled: false, hasApiKey: true }),
      ],
      undefined,
    );
    expect(rows[1]).toMatchObject({ tone: 'ok' });
    expect(rows[1].follow).toContain('已配 key');
    expect(rows[2]).toMatchObject({ tone: 'info' });
    expect(rows[2].follow).toContain('未配 key');
    expect(rows[3]).toMatchObject({ tone: 'fail' });
    expect(rows[3].label).toContain('已禁用');
  });

  it('每行含默认模型(primaryModel 优先,缺省取目录首条)与模型数', () => {
    const rows = composeModelCardRows(
      [
        provider({ primaryModel: 'gpt-5.4', models: [{ model: 'gpt-5.4' }, { model: 'gpt-5.4-mini' }] }),
        provider({ id: 'd', name: 'D', primaryModel: undefined, models: [{ model: 'm1' }, { model: 'm2' }] }),
      ],
      undefined,
    );
    expect(rows[1].follow).toContain('gpt-5.4 · 2 模型');
    expect(rows[2].follow).toContain('m1 · 2 模型');
  });
});

// ---------------------------------------------------------------------------
// composeMcpCardRows
// ---------------------------------------------------------------------------

describe('composeMcpCardRows', () => {
  const servers: McpServerRow[] = [
    { id: 'a', name: 'A', enabled: true },
    { id: 'b', name: 'B', enabled: true },
    { id: 'c', name: 'C', enabled: false },
  ];
  const statuses: McpBridgeRow[] = [
    { id: 'a', name: 'A', status: 'connected', toolCount: 12 },
    { id: 'b', name: 'B', status: 'failed', error: 'spawn ENOENT' },
  ];

  it('已启用+connected → green 带工具数;failed → red 带错误;已停用 → faint', () => {
    const { rows } = composeMcpCardRows(servers, statuses);
    expect(rows[0]).toMatchObject({ label: 'a · A', follow: '已启用 · connected · 12 工具', tone: 'ok' });
    expect(rows[1]).toMatchObject({ label: 'b · B', follow: '已启用 · failed · spawn ENOENT', tone: 'fail' });
    expect(rows[2]).toMatchObject({ label: 'c · C', follow: '已停用', tone: 'info' });
  });

  it('清单里有而桥状态没有的已启用 server → 已启用·未连接', () => {
    const { rows } = composeMcpCardRows(
      [{ id: 'a', name: 'A', enabled: true }],
      [],
    );
    expect(rows[0]).toEqual({ label: 'a · A', follow: '已启用 · 未连接', tone: 'info' });
  });

  it('桥状态里有而清单没有的(项目作用域差异)→ 按已启用补列', () => {
    const { rows, enabledCount } = composeMcpCardRows([], statuses);
    expect(rows).toHaveLength(2);
    expect(rows[0].tone).toBe('ok');
    expect(rows[1].tone).toBe('fail');
    expect(enabledCount).toBe(2);
  });

  it('汇总计数:总数与启用数', () => {
    const summary = composeMcpCardRows(servers, statuses);
    expect(summary.total).toBe(3);
    expect(summary.enabledCount).toBe(2);
  });
});
