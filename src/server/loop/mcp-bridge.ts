/**
 * M4d — MCP 工具接入 pi loop 引擎的宿主侧桥(单例)。
 *
 * 定位:pi loop 的 tools 数组每 turn 重建,本桥在 connect 时缓存各 server 的
 * 工具清单,buildMcpTools() 从缓存构造 AgentTool 包装。`mcp/reload` 断开全部
 * 连接 → 重读磁盘配置 → 重连,下一 turn 自动使用新工具集(天然热重载)。
 *
 * 红线:MCP 配置权威来源是磁盘(~/.zhishi/config.json)。本桥的默认配置读取
 * 走 resolveWorkspaceConfig 的磁盘 self-resolve(全局 ∩ 项目启用,含 env/args
 * 覆盖),不读进程镜像——reload 永远反映磁盘真值。
 *
 * 失败语义:单个 server 连接失败只记入状态(status:'failed'),不抛、不阻塞
 * 其他 server;连接超时上限 10s,工具调用超时 60s。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ImageContent, TextContent, TSchema } from '@earendil-works/pi-ai';

import type { McpServerDefinition } from '../../shared/config-types';
import { getAgentDir } from '../agent-session';
import {
  getAllMcpServers,
  getEnabledMcpServerIds,
  loadConfig,
  resolveWorkspaceConfig,
} from '../utils/admin-config';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 连接/列工具超时上限(ms)。 */
export const MCP_CONNECT_TIMEOUT_MS = 10_000;
/** 单次工具调用超时(ms)。 */
export const MCP_CALL_TIMEOUT_MS = 60_000;
/** pi 工具命名前缀:与内置工具隔离。 */
export const MCP_TOOL_NAME_PREFIX = 'mcp__';

const SDK_CLIENT_INFO = { name: 'zhishi-sidecar', version: '1.0.0' };

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface McpBridgeStatus {
  id: string;
  name: string;
  status: 'connected' | 'failed';
  toolCount?: number;
  error?: string;
}

/** MCP 工具最小定义(bridge 内部形状,SDK listTools 结果映射而来)。 */
export interface McpToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema 形式的工具入参 schema。 */
  inputSchema?: Record<string, unknown>;
}

/** MCP callTool 返回的 content 元素(宽松形状,未知类型降级为文本)。 */
export type McpCallContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: string; [key: string]: unknown };

export interface McpCallResult {
  content: McpCallContent[];
  isError?: boolean;
}

export interface McpCallOptions {
  signal?: AbortSignal;
}

/**
 * 可注入连接器:把「连接/列工具/调用/断开」抽象掉。单测注入 fake,生产
 * 走 MCP SDK Client(createSdkConnector)。
 */
export interface McpConnector {
  connect(): Promise<void>;
  listTools(): Promise<McpToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>, options?: McpCallOptions): Promise<McpCallResult>;
  disconnect(): Promise<void>;
}

export interface McpBridgeDeps {
  /** 读启用服务器清单(默认:磁盘 self-resolve)。 */
  readServers: () => McpServerDefinition[] | Promise<McpServerDefinition[]>;
  /** 按服务器定义构造连接器(默认:MCP SDK Client)。 */
  createConnector: (server: McpServerDefinition) => McpConnector;
}

interface ConnectedServer {
  server: McpServerDefinition;
  connector: McpConnector;
}

interface CachedTool {
  server: McpServerDefinition;
  tool: McpToolDefinition;
}

// ---------------------------------------------------------------------------
// 默认依赖实现(磁盘读取 + SDK 连接器)
// ---------------------------------------------------------------------------

/**
 * 磁盘 self-resolve:全局启用 ∩ 当前工作区项目启用,含 env/args 覆盖。
 * 与 admin-api notifyMcpChange 的过滤语义一致,但不经过进程镜像。
 */
export function readEnabledMcpServersFromDisk(): McpServerDefinition[] {
  const dir = getAgentDir();
  if (dir) {
    return resolveWorkspaceConfig(dir, undefined, { includeMcp: true }).mcpServers;
  }
  // 工作区未锚定(理论上仅在启动极早期):退回全局启用过滤。
  const config = loadConfig();
  const enabled = new Set(getEnabledMcpServerIds(config));
  return getAllMcpServers(config).filter((s) => enabled.has(s.id));
}

function createTransport(server: McpServerDefinition): Transport {
  if (server.type === 'stdio') {
    if (!server.command) {
      throw new Error(`stdio MCP server '${server.id}' missing command`);
    }
    // stderr 走默认 inherit:子进程日志进 sidecar 日志,排查友好。
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: server.env,
    });
  }

  const urlStr = server.url;
  if (!urlStr) {
    throw new Error(`${server.type} MCP server '${server.id}' missing url`);
  }
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch (err) {
    throw new Error(`MCP server '${server.id}' invalid url: ${err instanceof Error ? err.message : String(err)}`);
  }
  const requestInit = server.headers ? { headers: server.headers } : undefined;
  if (server.type === 'sse') {
    return new SSEClientTransport(url, { requestInit });
  }
  return new StreamableHTTPClientTransport(url, { requestInit });
}

function wrapSdkClient(client: Client, transport: Transport): McpConnector {
  return {
    connect: () => client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS }),
    listTools: async () => {
      const res = await client.listTools(undefined, { timeout: MCP_CONNECT_TIMEOUT_MS });
      return res.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema as Record<string, unknown> | undefined) ?? undefined,
      }));
    },
    callTool: async (name, args, options) => {
      const res = await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: MCP_CALL_TIMEOUT_MS, signal: options?.signal },
      );
      return { content: (res.content ?? []) as McpCallContent[], isError: res.isError === true };
    },
    disconnect: async () => {
      await client.close();
    },
  };
}

/** 生产连接器:按 type 选 stdio / sse / http transport。 */
export function createSdkConnector(server: McpServerDefinition): McpConnector {
  const client = new Client(SDK_CLIENT_INFO, { capabilities: {} });
  return wrapSdkClient(client, createTransport(server));
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export interface McpToolDetails {
  tool: string;
  serverId: string;
}

/** MCP content 元素 → pi TextContent/ImageContent;未知类型降级为 JSON 文本。 */
function mapContent(item: McpCallContent): TextContent | ImageContent {
  if (item.type === 'text') {
    return { type: 'text', text: typeof item.text === 'string' ? item.text : JSON.stringify(item.text) };
  }
  if (item.type === 'image') {
    const { data, mimeType } = item as { data?: unknown; mimeType?: unknown };
    if (typeof data === 'string' && typeof mimeType === 'string') {
      return { type: 'image', data, mimeType };
    }
  }
  return { type: 'text', text: JSON.stringify(item) };
}

export class McpBridge {
  private readonly deps: McpBridgeDeps;
  private readonly connectors = new Map<string, ConnectedServer>();
  private readonly tools = new Map<string, CachedTool>();
  private statuses: McpBridgeStatus[] = [];
  private started = false;
  /** 串行化 init/reload(重入安全)。 */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(deps: Partial<McpBridgeDeps> = {}) {
    this.deps = {
      readServers: deps.readServers ?? readEnabledMcpServersFromDisk,
      createConnector: deps.createConnector ?? createSdkConnector,
    };
  }

  /** 幂等初始化:已初始化则直接返回;单个 server 失败不阻塞。 */
  async init(): Promise<void> {
    await this.withLock(async () => {
      if (this.started) return;
      this.started = true;
      await this.reconnect();
    });
  }

  /** 断开全部 → 重读磁盘配置 → 重连;返回新状态列表。 */
  async reload(): Promise<McpBridgeStatus[]> {
    return this.withLock(async () => {
      this.started = true;
      await this.reconnect();
      return this.getStatus();
    });
  }

  /** 当前状态快照(含 failed 项;未初始化时为空数组)。 */
  getStatus(): McpBridgeStatus[] {
    return this.statuses.map((s) => ({ ...s }));
  }

  /**
   * 从已连接 server 的缓存工具清单构造 pi 工具。
   * 命名 mcp__<serverId>__<toolName>,与内置工具无冲突空间。
   */
  buildTools(): AgentTool[] {
    const out: AgentTool[] = [];
    for (const [key, cached] of this.tools) {
      out.push(this.buildTool(key, cached));
    }
    return out;
  }

  private buildTool(key: string, { server, tool }: CachedTool): AgentTool {
    const connector = this.connectors.get(server.id)?.connector;
    const name = `${MCP_TOOL_NAME_PREFIX}${server.id}__${tool.name}`;
    // MCP inputSchema 是 JSON Schema({type:'object',properties})——与 pi 的
    // TSchema 结构兼容:pi 内部校验走 typebox Compile 的 JSON Schema 路径
    // (已验证 $ref/$defs/oneOf 可编译、校验正常),直接透传即可,无需 Unsafe。
    const rawSchema = tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object' };
    return {
      name,
      label: `MCP: ${server.name}/${tool.name}`,
      description: tool.description ?? `MCP 工具 ${tool.name}(来自服务器 ${server.name})`,
      parameters: rawSchema as unknown as TSchema,
      execute: async (_toolCallId, params, signal): Promise<AgentToolResult<McpToolDetails>> => {
        if (!connector) {
          throw new Error(`MCP server '${server.id}' 未连接`);
        }
        const result = await connector.callTool(tool.name, (params ?? {}) as Record<string, unknown>, { signal });
        if (result.isError) {
          const text = result.content
            .filter((c) => c.type === 'text' && typeof c.text === 'string')
            .map((c) => (c as { text: string }).text)
            .join('\n')
            .trim();
          throw new Error(text || `MCP 工具 ${tool.name} 执行失败`);
        }
        return {
          content: result.content.map(mapContent),
          details: { tool: tool.name, serverId: server.id },
        };
      },
    };
  }

  /** 断开全部 → 读配置 → 逐个连接;失败只记状态。 */
  private async reconnect(): Promise<void> {
    await this.disconnectAll();
    this.tools.clear();

    let servers: McpServerDefinition[];
    try {
      servers = (await this.deps.readServers()) ?? [];
    } catch (err) {
      this.statuses = [];
      throw new Error(`MCP config read failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const statuses: McpBridgeStatus[] = [];
    for (const server of servers) {
      const { status, tools } = await this.connectOne(server);
      statuses.push(status);
      if (status.status === 'connected') {
        for (const tool of tools) {
          this.tools.set(`${server.id}\u0000${tool.name}`, { server, tool });
        }
      }
    }
    this.statuses = statuses;
  }

  private async connectOne(
    server: McpServerDefinition,
  ): Promise<{ status: McpBridgeStatus; tools: McpToolDefinition[] }> {
    let connector: McpConnector | undefined;
    try {
      connector = this.deps.createConnector(server);
      await connector.connect();
      const tools = await connector.listTools();
      this.connectors.set(server.id, { server, connector });
      console.log(`[mcp-bridge] connected '${server.id}' (${tools.length} tools)`);
      return {
        status: { id: server.id, name: server.name, status: 'connected', toolCount: tools.length },
        tools,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.warn(`[mcp-bridge] connect '${server.id}' failed: ${error}`);
      if (connector) {
        await connector.disconnect().catch(() => undefined);
      }
      return {
        status: { id: server.id, name: server.name, status: 'failed', error },
        tools: [],
      };
    }
  }

  private async disconnectAll(): Promise<void> {
    const entries = [...this.connectors.values()];
    this.connectors.clear();
    await Promise.allSettled(entries.map(({ connector }) => connector.disconnect()));
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }
}

// ---------------------------------------------------------------------------
// 单例 + 模块级 API
// ---------------------------------------------------------------------------

let defaultBridge: McpBridge | null = null;

/** 单例桥(测试注入请直接 new McpBridge(deps),不碰单例)。 */
export function getMcpBridge(): McpBridge {
  if (!defaultBridge) defaultBridge = new McpBridge();
  return defaultBridge;
}

/** sidecar 启动时调用:连接全部启用的 MCP server(幂等)。 */
export async function initMcpBridge(): Promise<void> {
  await getMcpBridge().init();
}

/** 每 turn 由 chat-engine 调用:构造当前已连接 server 的 pi 工具数组。 */
export function buildMcpTools(): AgentTool[] {
  return getMcpBridge().buildTools();
}

/** 断开全部 → 重读磁盘 → 重连,返回新状态列表。 */
export async function reloadMcpBridge(): Promise<McpBridgeStatus[]> {
  return getMcpBridge().reload();
}

/** 当前连接状态(含 failed)。 */
export function getMcpStatus(): McpBridgeStatus[] {
  return getMcpBridge().getStatus();
}
