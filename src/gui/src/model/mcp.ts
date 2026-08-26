/**
 * 1.3.5 MCP 管理纯函数层（设置页 MCP 页签数据映射）。
 *
 * 数据源（admin 端点，逐字段对齐 src/server/admin-api.ts）：
 *   - mcp/list        → 全量清单（含 enabled/isBuiltin 标记）：
 *                       data: [{ id, name, type, enabled, isBuiltin,
 *                                command, url, requiresConfig, hasEnv }]
 *   - mcp/list-status → 桥连接状态（仅已启用服务器）：
 *                       data: { servers: [{ id, name, status:
 *                       'connected'|'failed', toolCount?, error? }] }
 *   - mcp/reload      → 桥热重载后的新状态（同 list-status 形状）
 *   - mcp/enable|disable → { id } 写盘 + 桥联动
 *
 * 行合成语义移植自 TUI src/cli/tui/v2/model.ts:159-239 的
 * composeMcpCardRows（全量清单 ∪ 桥状态：清单里 enabled 而桥里没有 →
 * 已启用·未连接；桥里有而清单没有 → 按已启用展示）。
 *
 * 纯函数：不 import store / React / client；单测覆盖解析与合成。
 */

// ---------------------------------------------------------------------------
// 形状（与 server admin-api / loop/mcp-bridge 契约一致的最小声明）
// ---------------------------------------------------------------------------

/** admin mcp/list 的服务器条目（全量，含 enabled/isBuiltin 标记）。 */
export interface McpServerRow {
  id: string;
  name: string;
  type?: string;
  enabled?: boolean;
  isBuiltin?: boolean;
  command?: string;
  url?: string;
  requiresConfig?: boolean;
  hasEnv?: boolean;
}

/** admin mcp/list-status / mcp/reload 的桥状态条目（仅已启用服务器）。 */
export interface McpBridgeRow {
  id: string;
  name: string;
  status: 'connected' | 'failed';
  toolCount?: number;
  error?: string;
}

/** 页签展示行（清单 ∪ 桥状态合成后）。 */
export interface McpDisplayRow {
  id: string;
  name: string;
  enabled: boolean;
  /** 来源：内置（isBuiltin）/自定义；桥状态无清单条目时按自定义展示。 */
  source: 'builtin' | 'custom';
  type?: string;
  /** connected/failed = 桥状态；off = 已停用；unknown = 已启用·未连接。 */
  status: 'connected' | 'failed' | 'off' | 'unknown';
  toolCount?: number;
  error?: string;
}

export interface McpSummary {
  rows: McpDisplayRow[];
  /** 展示的服务器总数（mcp/list 全量为准，清单拉取失败时退化为桥状态数）。 */
  total: number;
  enabledCount: number;
}

// ---------------------------------------------------------------------------
// 解析（形状防御：非法条目静默丢弃）
// ---------------------------------------------------------------------------

/** mcp/list 的 data 数组 → 服务器行。 */
export function parseMcpList(raw: unknown): McpServerRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: McpServerRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'string' && r.id ? r.id : null;
    if (!id) continue;
    const row: McpServerRow = {
      id,
      name: typeof r.name === 'string' && r.name ? r.name : id,
    };
    if (typeof r.type === 'string' && r.type) row.type = r.type;
    if (typeof r.enabled === 'boolean') row.enabled = r.enabled;
    if (typeof r.isBuiltin === 'boolean') row.isBuiltin = r.isBuiltin;
    if (typeof r.command === 'string' && r.command) row.command = r.command;
    if (typeof r.url === 'string' && r.url) row.url = r.url;
    if (typeof r.requiresConfig === 'boolean') row.requiresConfig = r.requiresConfig;
    if (typeof r.hasEnv === 'boolean') row.hasEnv = r.hasEnv;
    rows.push(row);
  }
  return rows;
}

/** mcp/list-status / mcp/reload 的 data { servers } → 桥状态行。 */
export function parseMcpStatus(raw: unknown): McpBridgeRow[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const servers = (raw as Record<string, unknown>).servers;
  if (!Array.isArray(servers)) return [];
  const rows: McpBridgeRow[] = [];
  for (const item of servers) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'string' && r.id ? r.id : null;
    if (!id) continue;
    const status = r.status === 'connected' || r.status === 'failed' ? r.status : null;
    if (!status) continue;
    const row: McpBridgeRow = {
      id,
      name: typeof r.name === 'string' && r.name ? r.name : id,
      status,
    };
    if (typeof r.toolCount === 'number') row.toolCount = r.toolCount;
    if (typeof r.error === 'string' && r.error) row.error = r.error;
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 合成（TUI model.ts:159-239 composeMcpCardRows 的 GUI 行形态）
// ---------------------------------------------------------------------------

/**
 * 全量清单 ∪ 桥状态 → 展示行。清单里 enabled 而桥里没有 → 'unknown'
 * （已启用·未连接）；桥里有而清单没有的（项目作用域差异）→ 按已启用
 * 展示（source='custom'）。
 */
export function composeMcpRows(servers: McpServerRow[], statuses: McpBridgeRow[]): McpSummary {
  const statusMap = new Map(statuses.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const rows: McpDisplayRow[] = [];
  let enabledCount = 0;

  for (const s of servers) {
    seen.add(s.id);
    const base = {
      id: s.id,
      name: s.name,
      source: (s.isBuiltin === true ? 'builtin' : 'custom') as McpDisplayRow['source'],
      ...(s.type ? { type: s.type } : {}),
    };
    if (s.enabled === false) {
      rows.push({ ...base, enabled: false, status: 'off' });
      continue;
    }
    enabledCount++;
    const st = statusMap.get(s.id);
    if (!st) {
      rows.push({ ...base, enabled: true, status: 'unknown' });
    } else if (st.status === 'connected') {
      rows.push({
        ...base,
        enabled: true,
        status: 'connected',
        ...(typeof st.toolCount === 'number' ? { toolCount: st.toolCount } : {}),
      });
    } else {
      rows.push({ ...base, enabled: true, status: 'failed', ...(st.error ? { error: st.error } : {}) });
    }
  }
  for (const st of statuses) {
    if (seen.has(st.id)) continue;
    enabledCount++;
    rows.push(
      st.status === 'connected'
        ? {
            id: st.id,
            name: st.name,
            enabled: true,
            source: 'custom',
            status: 'connected',
            ...(typeof st.toolCount === 'number' ? { toolCount: st.toolCount } : {}),
          }
        : { id: st.id, name: st.name, enabled: true, source: 'custom', status: 'failed', ...(st.error ? { error: st.error } : {}) },
    );
  }
  return { rows, total: Math.max(servers.length, rows.length), enabledCount };
}
