/**
 * MCP 管理纯函数单测（1.3.5）：admin 载荷解析 + 清单∪桥状态合成
 * （TUI model.ts:159-239 composeMcpCardRows 同语义的 GUI 行形态）。
 */

import { describe, expect, it } from 'vitest';

import { composeMcpRows, parseMcpList, parseMcpStatus } from './mcp';

describe('parseMcpList（admin mcp/list 行归一）', () => {
  it('解析完整行（含 enabled/isBuiltin/type）', () => {
    expect(
      parseMcpList([
        {
          id: 'filesystem',
          name: 'filesystem',
          type: 'stdio',
          enabled: true,
          isBuiltin: true,
          command: 'npx -y @modelcontextprotocol/server-filesystem',
          url: undefined,
          requiresConfig: false,
          hasEnv: false,
        },
      ]),
    ).toEqual([
      {
        id: 'filesystem',
        name: 'filesystem',
        type: 'stdio',
        enabled: true,
        isBuiltin: true,
        command: 'npx -y @modelcontextprotocol/server-filesystem',
        requiresConfig: false,
        hasEnv: false,
      },
    ]);
  });

  it('缺 name 回落 id；可选字段缺省不落', () => {
    expect(parseMcpList([{ id: 'x' }])).toEqual([{ id: 'x', name: 'x' }]);
  });

  it('非法形状静默丢弃', () => {
    expect(parseMcpList(null)).toEqual([]);
    expect(parseMcpList({})).toEqual([]);
    expect(parseMcpList([null, 'junk', 42, { name: 'no-id' }])).toEqual([]);
  });
});

describe('parseMcpStatus（admin mcp/list-status 行归一）', () => {
  it('解析桥状态行（connected 带 toolCount / failed 带 error）', () => {
    expect(
      parseMcpStatus({
        servers: [
          { id: 'a', name: 'a', status: 'connected', toolCount: 3 },
          { id: 'b', name: 'b', status: 'failed', error: 'ECONNREFUSED' },
        ],
      }),
    ).toEqual([
      { id: 'a', name: 'a', status: 'connected', toolCount: 3 },
      { id: 'b', name: 'b', status: 'failed', error: 'ECONNREFUSED' },
    ]);
  });

  it('非法形状/非法 status 静默丢弃', () => {
    expect(parseMcpStatus(null)).toEqual([]);
    expect(parseMcpStatus({ servers: 'x' })).toEqual([]);
    expect(parseMcpStatus({ servers: [{ id: 'a', status: 'weird' }, { name: 'no-id', status: 'connected' }] })).toEqual([]);
  });
});

describe('composeMcpRows（清单 ∪ 桥状态合成）', () => {
  it('已启用·connected 带工具数；已停用 → off', () => {
    const s = composeMcpRows(
      [
        { id: 'a', name: 'a', enabled: true, isBuiltin: true, type: 'stdio' },
        { id: 'b', name: 'b', enabled: false, isBuiltin: false, type: 'sse' },
      ],
      [{ id: 'a', name: 'a', status: 'connected', toolCount: 5 }],
    );
    expect(s.total).toBe(2);
    expect(s.enabledCount).toBe(1);
    expect(s.rows).toEqual([
      { id: 'a', name: 'a', source: 'builtin', type: 'stdio', enabled: true, status: 'connected', toolCount: 5 },
      { id: 'b', name: 'b', source: 'custom', type: 'sse', enabled: false, status: 'off' },
    ]);
  });

  it('已启用·桥状态 failed → failed + error；清单里 enabled 而桥里没有 → unknown', () => {
    const s = composeMcpRows(
      [
        { id: 'a', name: 'a', enabled: true },
        { id: 'b', name: 'b', enabled: true },
      ],
      [{ id: 'a', name: 'a', status: 'failed', error: 'timeout' }],
    );
    expect(s.rows.find((r) => r.id === 'a')).toEqual({
      id: 'a',
      name: 'a',
      source: 'custom',
      enabled: true,
      status: 'failed',
      error: 'timeout',
    });
    expect(s.rows.find((r) => r.id === 'b')).toEqual({
      id: 'b',
      name: 'b',
      source: 'custom',
      enabled: true,
      status: 'unknown',
    });
  });

  it('桥里有而清单没有（项目作用域差异）→ 按已启用·自定义展示', () => {
    const s = composeMcpRows([], [{ id: 'z', name: 'z', status: 'connected', toolCount: 2 }]);
    expect(s.rows).toEqual([
      { id: 'z', name: 'z', enabled: true, source: 'custom', status: 'connected', toolCount: 2 },
    ]);
    expect(s.total).toBe(1);
    expect(s.enabledCount).toBe(1);
  });

  it('全部空 → 空行（页签空态）', () => {
    const s = composeMcpRows([], []);
    expect(s.rows).toEqual([]);
    expect(s.total).toBe(0);
    expect(s.enabledCount).toBe(0);
  });

  it('isBuiltin=false 与缺省都归自定义', () => {
    const s = composeMcpRows(
      [
        { id: 'x', name: 'x', enabled: true, isBuiltin: false },
        { id: 'y', name: 'y', enabled: true },
      ],
      [],
    );
    expect(s.rows.map((r) => r.source)).toEqual(['custom', 'custom']);
  });
});
