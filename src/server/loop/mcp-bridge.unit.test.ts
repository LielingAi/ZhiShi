/**
 * M4d — mcp-bridge(loop/mcp-bridge.ts)unit tests.
 *
 * 不真连 MCP:连接/列工具/调用全部注入 fake connector,配置读取注入 fake
 * reader(默认的磁盘 self-resolve 与 MCP SDK 连接器在本测试中零执行)。
 * 覆盖:成功/失败状态、工具命名与 schema 透传、execute 正常/isError、
 * reload 重连语义、init 幂等。
 */
import { describe, expect, it, vi } from 'vitest';

import type { McpServerDefinition } from '../../shared/config-types';
import {
  McpBridge,
  type McpCallResult,
  type McpConnector,
  type McpToolDefinition,
} from './mcp-bridge';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const fsServer: McpServerDefinition = {
  id: 'fs',
  name: '文件系统',
  type: 'stdio',
  isBuiltin: false,
  command: 'node',
};

const httpServer: McpServerDefinition = {
  id: 'http',
  name: 'HTTP 工具',
  type: 'http',
  isBuiltin: false,
  url: 'http://127.0.0.1:9',
};

const readFileTool: McpToolDefinition = {
  name: 'read_file',
  description: '读文件内容,path 为目标路径',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: '文件路径' } },
    required: ['path'],
  },
};

const writeFileTool: McpToolDefinition = {
  name: 'write_file',
  description: '写文件内容',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, data: { type: 'string' } },
    required: ['path', 'data'],
  },
};

function fakeConnector(overrides: Partial<McpConnector> = {}): McpConnector {
  return {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => [] as McpToolDefinition[]),
    callTool: vi.fn(async () => ({ content: [], isError: false }) as McpCallResult),
    disconnect: vi.fn(async () => undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('McpBridge', () => {
  it('连接成功/失败各半:状态正确,失败不阻塞成功,工具只含成功 server', async () => {
    const ok = fakeConnector({ listTools: vi.fn(async () => [readFileTool, writeFileTool]) });
    const bad = fakeConnector({ connect: vi.fn(async () => { throw new Error('connection refused'); }) });
    const bridge = new McpBridge({
      readServers: () => [fsServer, httpServer],
      createConnector: (s) => (s.id === 'fs' ? ok : bad),
    });

    expect(bridge.getStatus()).toEqual([]);
    expect(bridge.buildTools()).toEqual([]);

    await bridge.init();

    expect(bridge.getStatus()).toEqual([
      { id: 'fs', name: '文件系统', status: 'connected', toolCount: 2 },
      { id: 'http', name: 'HTTP 工具', status: 'failed', error: 'connection refused' },
    ]);
    expect(ok.connect).toHaveBeenCalledTimes(1);
    expect(bad.connect).toHaveBeenCalledTimes(1);

    const tools = bridge.buildTools();
    expect(tools.map((t) => t.name)).toEqual(['mcp__fs__read_file', 'mcp__fs__write_file']);
    expect(tools[0].label).toBe('MCP: 文件系统/read_file');
    // 描述保留参数说明,schema 原样透传(JSON Schema 与 pi TSchema 兼容)。
    expect(tools[0].description).toBe('读文件内容,path 为目标路径');
    expect((tools[0].parameters as Record<string, unknown>).type).toBe('object');
  });

  it('execute:正常返回 text/image content 映射为 pi 内容块', async () => {
    const ok = fakeConnector({
      listTools: vi.fn(async () => [readFileTool]),
      callTool: vi.fn(async () => ({
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
        isError: false,
      }) as McpCallResult),
    });
    const bridge = new McpBridge({
      readServers: () => [fsServer],
      createConnector: () => ok,
    });
    await bridge.init();

    const [tool] = bridge.buildTools();
    const result = await tool.execute('tc-1', { path: '/a' });

    expect(ok.callTool).toHaveBeenCalledWith('read_file', { path: '/a' }, { signal: undefined });
    expect(result.content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]);
    expect(result.details).toEqual({ tool: 'read_file', serverId: 'fs' });
  });

  it('execute:isError 抛错(拼接文本)', async () => {
    const ok = fakeConnector({
      listTools: vi.fn(async () => [readFileTool]),
      callTool: vi.fn(async () => ({
        content: [{ type: 'text', text: 'E1' }, { type: 'text', text: 'E2' }],
        isError: true,
      }) as McpCallResult),
    });
    const bridge = new McpBridge({
      readServers: () => [fsServer],
      createConnector: () => ok,
    });
    await bridge.init();

    const [tool] = bridge.buildTools();
    await expect(tool.execute('tc-1', {})).rejects.toThrow('E1\nE2');
  });

  it('execute:connector 调用失败原样抛给 pi(转 isError 结果)', async () => {
    const ok = fakeConnector({
      listTools: vi.fn(async () => [readFileTool]),
      callTool: vi.fn(async () => { throw new Error('rpc died'); }),
    });
    const bridge = new McpBridge({
      readServers: () => [fsServer],
      createConnector: () => ok,
    });
    await bridge.init();

    const [tool] = bridge.buildTools();
    await expect(tool.execute('tc-1', {})).rejects.toThrow('rpc died');
  });

  it('reload:重读配置、重连、旧 client 被断开', async () => {
    const fsConn = fakeConnector({ listTools: vi.fn(async () => [readFileTool]) });
    const httpConn = fakeConnector({ listTools: vi.fn(async () => [writeFileTool]) });
    const readServers = vi.fn(() => [fsServer]);
    const bridge = new McpBridge({
      readServers,
      createConnector: (s) => (s.id === 'fs' ? fsConn : httpConn),
    });
    await bridge.init();
    expect(fsConn.connect).toHaveBeenCalledTimes(1);
    expect(bridge.buildTools().map((t) => t.name)).toEqual(['mcp__fs__read_file']);

    // 磁盘配置变更(新增 http,移除 fs)→ reload。
    readServers.mockReturnValue([httpServer]);
    const status = await bridge.reload();

    expect(fsConn.disconnect).toHaveBeenCalledTimes(1);
    expect(httpConn.connect).toHaveBeenCalledTimes(1);
    expect(status).toEqual([
      { id: 'http', name: 'HTTP 工具', status: 'connected', toolCount: 1 },
    ]);
    expect(bridge.buildTools().map((t) => t.name)).toEqual(['mcp__http__write_file']);
  });

  it('reload:配置读取失败抛错(admin 层转 success:false),旧连接已断开', async () => {
    const fsConn = fakeConnector({ listTools: vi.fn(async () => [readFileTool]) });
    const readServers = vi.fn(() => [fsServer]);
    const bridge = new McpBridge({
      readServers,
      createConnector: () => fsConn,
    });
    await bridge.init();

    readServers.mockImplementation(() => { throw new Error('config.json 损坏'); });
    await expect(bridge.reload()).rejects.toThrow('config.json 损坏');
    expect(fsConn.disconnect).toHaveBeenCalledTimes(1);
    expect(bridge.getStatus()).toEqual([]);
  });

  it('init 幂等:重复 init 不重连', async () => {
    const fsConn = fakeConnector({ listTools: vi.fn(async () => [readFileTool]) });
    const bridge = new McpBridge({
      readServers: () => [fsServer],
      createConnector: () => fsConn,
    });

    await bridge.init();
    await bridge.init();

    expect(fsConn.connect).toHaveBeenCalledTimes(1);
    expect(fsConn.listTools).toHaveBeenCalledTimes(1);
  });
});
