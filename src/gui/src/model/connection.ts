/**
 * 连接模式（1.8.7 P0.5 团队协作——「本机 / 团队大脑」开关，纯逻辑）。
 *
 * 远端模式 = GUI 直连服务器上的团队大脑 sidecar（HTTP + 可选 Bearer
 * token），Rust 侧不起本机 sidecar（spawn 抑制信号经
 * `get_sidecar_port(remote_url)` 传给 Rust，见 useGuiStore.init）。
 *
 * 持久化照 theme.ts 口径：单个 localStorage 键存 JSON，读写异常静默回落
 * 默认（本机模式）——本机模式是零配置的默认路径，一字节不变。
 *
 * URL 归一化语义与 CLI（src/cli/remote.ts::normalizeServerUrl）逐字对齐：
 * 缺 scheme 补 http://、剥尾部斜杠、非法抛错。token 只进 Authorization
 * 请求头，不打印、不回显日志。
 */

export type ConnectionMode = 'local' | 'remote';

export interface ConnectionSettings {
  mode: ConnectionMode;
  /** 远端 server（用户原始输入；消费前过 normalizeServerUrl）。 */
  serverUrl: string;
  /** 远端鉴权 token（可选；只进请求头）。 */
  token: string;
}

/** localStorage 持久化键（zhishi.gui.* 命名族，同 theme）。 */
export const CONNECTION_STORAGE_KEY = 'zhishi.gui.connection';

/** 默认 = 本机模式（未配置时的零变更路径）。 */
export const CONNECTION_DEFAULTS: ConnectionSettings = { mode: 'local', serverUrl: '', token: '' };

type StorageLike = { getItem(k: string): string | null; setItem?(k: string, v: string): void };

/**
 * 归一化团队大脑地址：
 * - 接受 `host:port` 写法并补 `http://`；
 * - 剥尾部斜杠（调用方直接拼 `/api/admin`、`/health`，双斜杠会 404）；
 * - 非法 URL 抛错（调用方翻成 UI 提示，不静默回落本机）。
 */
// 2.0 audit D3：归一化实现收敛到 shared（曾与 CLI 逐字镜像）；本文件对外
// API 不变（re-export），消费方 import 路径零改动。语义：补 scheme/剥斜杠/
// 非法抛错——解析结果不回用（打到 UI 的 URL 应与用户输入一致）。
export { normalizeServerUrl } from '../../../shared/connection-url';

/**
 * 读持久化连接设置：缺失/损坏/非法 mode 一律回落本机默认。
 * storage 可注入（单测）；读写异常静默回落（隐私模式等）。
 *
 * 注意：mode === 'remote' 不保证 serverUrl 合法——消费方（store.init）
 * 必须过 normalizeServerUrl，非法时进连接失败态而不是悄悄回本机。
 */
export function loadConnection(storage?: StorageLike | null): ConnectionSettings {
  try {
    const raw = storage?.getItem(CONNECTION_STORAGE_KEY);
    if (!raw) return { ...CONNECTION_DEFAULTS };
    const v = JSON.parse(raw) as Partial<ConnectionSettings> | null;
    if (!v || (v.mode !== 'local' && v.mode !== 'remote')) return { ...CONNECTION_DEFAULTS };
    return {
      mode: v.mode,
      serverUrl: typeof v.serverUrl === 'string' ? v.serverUrl : '',
      token: typeof v.token === 'string' ? v.token : '',
    };
  } catch {
    return { ...CONNECTION_DEFAULTS };
  }
}

/** 写持久化连接设置；异常静默（隐私模式等）——内存态已生效，仅丢持久化。 */
export function saveConnection(storage: StorageLike | null | undefined, settings: ConnectionSettings): void {
  try {
    storage?.setItem?.(CONNECTION_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 静默：同 theme.ts 的读写兜底口径。
  }
}

// ---------------------------------------------------------------------------
// 2.0.3 remote relay：轮询本机回环中继端口
// ---------------------------------------------------------------------------

/**
 * 轮询 Tauri IPC 直到远端中继（remote_relay 模块 spawn 的 relay.cjs）
 * 报告可服务端口，或超时返回 null。
 *
 * 为什么中继在 Rust 侧异步就绪：spawn 内置 node + 等子进程 stdout 的
 * READY 行是毫秒~秒级不确定延迟，同步 IPC 契约（Option<u16>）下只能由
 * 前端轮询消化——本机模式的端口发现（client/port.ts::pollTauriPort）同口径。
 *
 * 契约（与 commands.rs::get_sidecar_port 对齐）：
 * - 每次调用都是幂等 ensure（稳态 = 锁内一次比较，不会重复 spawn）；
 * - 返回 1-65535 的整数 = 中继就绪；null = 启动中/失败冷却；
 * - IPC 瞬时抛错（窗口关闭竞态）吞掉继续轮询，超时兜底交失败态。
 *
 * 依赖全部注入（invoke/sleep/now），单测友好。
 */
export async function pollRemoteRelayPort(
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
  serverUrl: string,
  opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<number | null> {
  const interval = opts.intervalMs ?? 500;
  const timeout = opts.timeoutMs ?? 20_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + timeout;
  for (;;) {
    try {
      const port = await invoke('get_sidecar_port', { remoteUrl: serverUrl });
      if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535) {
        return port;
      }
    } catch {
      // IPC 瞬断——继续轮询；连续失败由超时兜底。
    }
    if (now() >= deadline) return null;
    await sleep(interval);
  }
}
