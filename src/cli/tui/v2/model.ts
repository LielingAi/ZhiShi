/**
 * model / mcp — TUI 配置闭环的纯逻辑层（Functional Core）。
 *
 * app.ts 的 /model 与 /mcp 命令把「参数解析 → 状态卡行构造 → 隐藏输入缓冲」
 * 全部下沉到这里，副作用（adminPost / pushBlock / 输入流接管）留在薄外壳。
 * 与 server 侧的契约（admin-api.ts / index.ts）：
 *
 *   admin model/list      → { success, data: ModelProviderInfo[] }
 *   admin model/set-key   → { id, apiKey } → { success, data: { modelsFetched,
 *                           modelsFetchError }, hint }
 *   POST  /chat/model     → { model, providerId? } → { success, providerId?, model }
 *   admin mcp/list        → { success, data: McpServerRow[] }（全量，含 enabled）
 *   admin mcp/list-status → { success, data: { servers: McpBridgeRow[] } }
 *   admin mcp/reload      → 同上（热重载后返回新状态）
 */

// ---------------------------------------------------------------------------
// /model
// ---------------------------------------------------------------------------

/** admin model/list 的供应商条目（宽松形状，只声明渲染所需字段）。 */
export interface ModelProviderInfo {
  id: string;
  name: string;
  vendor?: string;
  primaryModel?: string;
  enabled: boolean;
  hasApiKey: boolean;
  status: string;
  models: Array<{ model: string }>;
}

export type ModelArgs =
  | { kind: 'status' }
  | { kind: 'set-key'; providerId: string }
  | { kind: 'use'; providerId: string; model: string }
  | { kind: 'switch'; model: string }
  | { kind: 'error'; message: string };

/**
 * /model 参数解析:
 *   无参 → 状态卡;`set-key <id>` → 隐藏输入填 key;`use <id> <模型>`
 *   → 带供应商语义的切换;单个 token → 旧语法 /model <模型名>(向后兼容)。
 */
export function parseModelArgs(arg: string): ModelArgs {
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: 'status' };
  const [verb, ...rest] = tokens;
  if (verb === 'set-key') {
    if (rest.length !== 1) return { kind: 'error', message: '用法：/model set-key <供应商id>' };
    return { kind: 'set-key', providerId: rest[0] };
  }
  if (verb === 'use') {
    if (rest.length !== 2) return { kind: 'error', message: '用法：/model use <供应商id> <模型名>' };
    return { kind: 'use', providerId: rest[0], model: rest[1] };
  }
  if (rest.length > 0) {
    return { kind: 'error', message: `未知参数: ${arg.trim()}（/model 只收一个模型名，或 set-key / use 子命令）` };
  }
  return { kind: 'switch', model: verb };
}

/** 状态卡的一行（divider 渲染语义:tone → green/red/faint）。 */
export interface CardRow {
  label: string;
  follow: string;
  tone: 'info' | 'ok' | 'fail';
}

/**
 * /model 状态卡行构造:表头(家数 + 当前默认模型)+ 每家一行
 * （已配 key → green / 未配 → faint / 已禁用 → red）。
 */
export function composeModelCardRows(
  providers: ModelProviderInfo[],
  currentModel: string | undefined,
): CardRow[] {
  const rows: CardRow[] = [
    {
      label: '模型供应商',
      follow: `${providers.length} 家${currentModel ? ` · 当前默认 ${currentModel}` : ''}`,
      tone: 'info',
    },
  ];
  for (const p of providers) {
    const primary = p.primaryModel ?? p.models[0]?.model;
    rows.push({
      label: `${p.id} · ${p.name}${p.enabled === false ? '（已禁用）' : ''}`,
      follow: `${p.hasApiKey ? '已配 key' : '未配 key'}${primary ? ` · ${primary}` : ''} · ${p.models.length} 模型`,
      tone: p.enabled === false ? 'fail' : p.hasApiKey ? 'ok' : 'info',
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 隐藏输入（/model set-key 的 API key 读取）
// ---------------------------------------------------------------------------

/** 隐藏输入的按键事件（App 层把 Key 归约成这四种）。 */
export type HiddenLineKey =
  | { type: 'char'; char: string }
  | { type: 'backspace' }
  | { type: 'submit' }
  | { type: 'cancel' };

export type HiddenLineOutcome =
  | { done: false; buffer: string }
  | { done: true; cancelled: true }
  | { done: true; cancelled: false; value: string };

/** API key 长度上限——防粘贴事故，超长忽略（防呆，不作静默截断）。 */
export const HIDDEN_LINE_MAX = 512;

/**
 * 隐藏输入缓冲归约。submit 空串按取消处理——空 key 调 model/set-key 只会
 * 得到服务端报错，不如在输入端直接拦住。
 */
export function reduceHiddenLine(buffer: string, ev: HiddenLineKey): HiddenLineOutcome {
  switch (ev.type) {
    case 'char':
      if (buffer.length >= HIDDEN_LINE_MAX) return { done: false, buffer };
      return { done: false, buffer: buffer + ev.char };
    case 'backspace':
      return { done: false, buffer: buffer.slice(0, -1) };
    case 'submit':
      return buffer.length > 0
        ? { done: true, cancelled: false, value: buffer }
        : { done: true, cancelled: true };
    case 'cancel':
      return { done: true, cancelled: true };
  }
}

// ---------------------------------------------------------------------------
// /mcp
// ---------------------------------------------------------------------------

export type McpArgs =
  | { kind: 'status' }
  | { kind: 'reload' }
  | { kind: 'enable'; id: string }
  | { kind: 'disable'; id: string }
  | { kind: 'error'; message: string };

/** /mcp 参数解析。兼容旧语法:任意位置出现 -r/--reload 都按重载处理。 */
export function parseMcpArgs(arg: string): McpArgs {
  const tokens = arg.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: 'status' };
  if (tokens.some((t) => t === '-r' || t === '--reload')) return { kind: 'reload' };
  const [verb, id, ...extra] = tokens;
  if (verb === 'enable' || verb === 'disable') {
    if (!id || extra.length > 0) return { kind: 'error', message: `用法：/mcp ${verb} <id>` };
    return verb === 'enable' ? { kind: 'enable', id } : { kind: 'disable', id };
  }
  return { kind: 'error', message: '用法：/mcp [enable <id> | disable <id> | -r]' };
}

/** admin mcp/list 的服务器条目（全量，含 enabled 标记）。 */
export interface McpServerRow {
  id: string;
  name: string;
  enabled?: boolean;
}

/** admin mcp/list-status / mcp/reload 的桥状态条目（仅已启用服务器）。 */
export interface McpBridgeRow {
  id: string;
  name: string;
  status: 'connected' | 'failed';
  toolCount?: number;
  error?: string;
}

export interface McpCardSummary {
  rows: CardRow[];
  /** 展示的服务器总数（mcp/list 全量为准，清单拉取失败时退化为桥状态数）。 */
  total: number;
  enabledCount: number;
}

/**
 * /mcp 状态卡行构造:全量清单(含 enabled)∪ 桥状态(已启用服务器的连接结果)。
 * 清单里有而桥里没有的 → 已启用·未连接;桥里有而清单没有的(项目作用域差异)
 * → 按已启用展示。
 */
export function composeMcpCardRows(servers: McpServerRow[], statuses: McpBridgeRow[]): McpCardSummary {
  const statusMap = new Map(statuses.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const rows: CardRow[] = [];
  let enabledCount = 0;

  for (const s of servers) {
    seen.add(s.id);
    if (s.enabled === false) {
      rows.push({ label: `${s.id} · ${s.name}`, follow: '已停用', tone: 'info' });
      continue;
    }
    enabledCount++;
    const st = statusMap.get(s.id);
    if (!st) {
      rows.push({ label: `${s.id} · ${s.name}`, follow: '已启用 · 未连接', tone: 'info' });
    } else if (st.status === 'connected') {
      rows.push({
        label: `${s.id} · ${s.name}`,
        follow: `已启用 · connected · ${st.toolCount ?? 0} 工具`,
        tone: 'ok',
      });
    } else {
      rows.push({
        label: `${s.id} · ${s.name}`,
        follow: `已启用 · failed · ${st.error ?? '未知错误'}`,
        tone: 'fail',
      });
    }
  }
  for (const st of statuses) {
    if (seen.has(st.id)) continue;
    enabledCount++;
    rows.push(
      st.status === 'connected'
        ? { label: `${st.id} · ${st.name}`, follow: `已启用 · connected · ${st.toolCount ?? 0} 工具`, tone: 'ok' }
        : { label: `${st.id} · ${st.name}`, follow: `已启用 · failed · ${st.error ?? '未知错误'}`, tone: 'fail' },
    );
  }
  return { rows, total: Math.max(servers.length, rows.length), enabledCount };
}
