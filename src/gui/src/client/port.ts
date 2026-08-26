/**
 * 端口发现（1.3.0 GUI MVP）。
 *
 * Tauri 环境：`window.__TAURI__.core.invoke('get_sidecar_port')` 返回
 * u16 | null——sidecar 启动前为 null，轮询直到拿到端口。
 * 浏览器 dev 模式（非 Tauri）：回退 localStorage.zhishiPort 或 ?port= 参数。
 *
 * 依赖全部注入（invoke / localStorage / location / sleep），单测友好。
 */

export type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface PortDiscoveryEnv {
  /** Tauri IPC invoke；浏览器环境为 undefined。 */
  invoke?: InvokeFn;
  /** localStorage 兼容接口。 */
  storage?: { getItem(key: string): string | null };
  search?: string;
  sleep?: (ms: number) => Promise<void>;
  /** 轮询总时长上限（默认 60s，超时放弃，交给重试/报错路径）。 */
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
}

export const PORT_STORAGE_KEY = 'zhishiPort';

/** 从 ?port= 参数解析端口。 */
export function parsePortParam(search: string): number | null {
  const m = /[?&]port=(\d{1,5})/.exec(search);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

/** 从 localStorage 读取端口。 */
export function readStoredPort(storage: { getItem(key: string): string | null }): number | null {
  const raw = storage.getItem(PORT_STORAGE_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

/** 轮询 Tauri IPC 直到 sidecar 端口可用；超时返回 null。 */
export async function pollTauriPort(
  invoke: InvokeFn,
  opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<number | null> {
  const interval = opts.intervalMs ?? 500;
  const timeout = opts.timeoutMs ?? 60_000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const port = await invoke('get_sidecar_port');
      if (typeof port === 'number' && port > 0 && port <= 65535) return port;
    } catch {
      // IPC 不可用（窗口关闭等）——继续等还是放弃？保守：继续等下一次。
    }
    if (Date.now() >= deadline) return null;
    await sleep(interval);
  }
}

/**
 * 统一入口：Tauri 优先，浏览器 dev 回退。
 * 返回 null = 拿不到端口（连接层会报错并提示）。
 */
export async function resolvePort(env: PortDiscoveryEnv): Promise<number | null> {
  const fromSearch = parsePortParam(env.search ?? '');
  if (fromSearch !== null) return fromSearch;

  if (env.invoke) {
    const port = await pollTauriPort(env.invoke, {
      intervalMs: env.pollIntervalMs,
      timeoutMs: env.pollTimeoutMs,
      sleep: env.sleep,
    });
    if (port !== null) return port;
  }

  if (env.storage) {
    const stored = readStoredPort(env.storage);
    if (stored !== null) return stored;
  }
  return null;
}
