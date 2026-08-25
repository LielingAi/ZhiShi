/**
 * 1.3.3 — attach 交互式 pty 端点（WS `/api/admin/environment/term?env=<envKey>`）。
 *
 * GUI attach 页从「一次性 environment/exec」升级为真终端：每 env 一条 pty，
 * 全屏交互（vim/top、tab 补全）可用。设计要点：
 *
 * - **生命周期**：连接时 spawn；同 env 重复连接 → 旧连接先关（旧 pty 随
 *   close 回收）；WS close → kill pty（防泄漏）；pty 自然退出 → 发 exit 帧
 *   后关 WS。不做空闲超时（简单优先，attach 是研究员的显式动作）。
 * - **协议**（JSON 文本帧）：
 *   客户端→服务端 `{type:'input',data}` / `{type:'resize',cols,rows}` /
 *   `{type:'ping'}`；服务端→客户端 `{type:'output',data}` /
 *   `{type:'exit',code,signal?}` / `{type:'error',message}` / `{type:'pong'}`。
 * - **审计**：spawn/exit/attach 失败打日志（console → UnifiedLogger 统一
 *   口径）；输入命令**不**落 transcript——这是终端不是 agent 消息。
 *   不走 environment/boundary 分级：attach 与 environment/exec 同等级，
 *   是研究员的合法入口。
 * - **原生模块**：@lydell/node-pty 是 external 的 napi prebuilds——顶层
 *   value-import 会让缺模块的宿主直接炸在启动期，故经 loadNodePty()
 *   **惰性**加载（先常规 node_modules 解析，再 prod 布局
 *   `<Resources>/pty-runtime/` 回落，对齐 sharp/sqlite-runtime 的打包惯例）。
 *   加载失败 → attach 收到 error 帧（sidecar 其余功能不受影响）。
 *
 * 测试纪律：manager 的 env 解析/pty 加载/宿主二进制解析全部可注入——
 * 单测绝不真调 docker/ssh，也不加载原生模块。
 */

import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { WebSocketServer } from 'ws';

import type { EnvironmentEntry } from '../../shared/config-types';
import { findEnvironmentEntry, listEnvironments } from '../environment/registry';
import { loadConfig } from '../utils/admin-config';
import { augmentedProcessEnv, resolveCommand } from '../utils/env-utils';
import { getScriptDir } from '../utils/runtime';
import { buildPtySpawnSpec } from './env-exec';

// ---------------------------------------------------------------------------
// 协议
// ---------------------------------------------------------------------------

export interface TermClientInputMessage {
  type: 'input';
  data: string;
}
export interface TermClientResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}
export interface TermClientPingMessage {
  type: 'ping';
}
export type TermClientMessage = TermClientInputMessage | TermClientResizeMessage | TermClientPingMessage;

export type TermServerMessage =
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number; signal?: string }
  | { type: 'error'; message: string }
  | { type: 'pong' };

/** 默认终端尺寸(连接时无 resize 前)。 */
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
/** resize 尺寸护栏(防病态值把远端 pty 撑爆)。 */
export const MAX_COLS = 1000;
export const MAX_ROWS = 1000;

/** 同 env 抢占连接时给旧 WS 的关闭码(自定义应用码,4000-4999 区间)。 */
export const CLOSE_CODE_SUPERSEDED = 4001;
/** attach 失败(env 缺失/spawn 失败)时的关闭码。 */
export const CLOSE_CODE_ATTACH_FAILED = 1011;

// ---------------------------------------------------------------------------
// 最小接口(鸭子类型:node-pty 的 IPty 与 ws 的 WebSocket 结构兼容;
// 测试直接注入 mock,不加载原生模块)
// ---------------------------------------------------------------------------

export interface TermPty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (ev: { exitCode: number; signal?: number }) => void): unknown;
}

export interface TermWebSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: string | Buffer) => void): unknown;
  on(event: 'close' | 'error', listener: () => void): unknown;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export type PtyApi = {
  spawn(file: string, args: string[], options: PtySpawnOptions): TermPty;
};

// ---------------------------------------------------------------------------
// 原生模块惰性加载
// ---------------------------------------------------------------------------

/**
 * 惰性加载 @lydell/node-pty（external 原生模块,顶层 value-import 会炸启动）。
 * 搜索序:
 * 1. 常规 node_modules 解析(dev / tsx 源码运行);
 * 2. prod 布局回落:`<scriptDir>/pty-runtime/node_modules/@lydell/node-pty`
 *    (对齐 sharp-runtime / sqlite-runtime 的打包惯例——发行侧把 prebuilds
 *    装进该目录即可,见报告「打包侧风险」)。
 * 两处都失败 → null(调用方发 error 帧,不炸进程)。
 */
export function loadNodePty(): PtyApi | null {
  const req = createRequire(import.meta.url);
  try {
    return req('@lydell/node-pty') as PtyApi;
  } catch {
    // dev node_modules 无此模块(或 ABI 不符)——回落 prod 布局。
  }
  try {
    const scriptDir = getScriptDir();
    const bundled = resolve(scriptDir, 'pty-runtime', 'node_modules', '@lydell/node-pty');
    return req(bundled) as PtyApi;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Manager — 每 env 一条 pty 的生命周期
// ---------------------------------------------------------------------------

export interface TermSessionManagerDeps {
  /** 环境条目解析(测试注入)。默认:config.json 具名环境注册表。 */
  envResolver?: (envKey: string) => EnvironmentEntry | null;
  /** pty 模块(测试注入)。默认:loadNodePty()。 */
  ptyLoader?: () => PtyApi | null;
  /** 宿主二进制(docker/ssh)全路径解析(测试注入)。默认:resolveCommand。 */
  resolveHostBinary?: (cmd: string) => string;
  /** 日志(测试注入)。默认:console.log(→ UnifiedLogger 统一口径)。 */
  log?: (message: string) => void;
}

interface ActiveTermSession {
  pty: TermPty;
  ws: TermWebSocket;
}

/** 默认 env 解析:与 environment/exec 同口径的具名环境注册表。
 *  (admin-config/registry 已由 env-exec/chat-engine 静态引入——这里复用,
 *  不新增冷启动成本。) */
function defaultEnvResolver(envKey: string): EnvironmentEntry | null {
  return findEnvironmentEntry(listEnvironments(loadConfig()), envKey) ?? null;
}

export class TermSessionManager {
  /** envKey → 活动 pty 会话(每 env 至多一条)。 */
  private sessions = new Map<string, ActiveTermSession>();

  constructor(private readonly deps: TermSessionManagerDeps = {}) {}

  /** 活动会话数(测试/诊断用)。 */
  activeCount(): number {
    return this.sessions.size;
  }

  /** 关停全部会话(宿主退出兜底;测试收尾)。 */
  closeAll(): void {
    for (const [envKey, session] of [...this.sessions]) {
      try { session.pty.kill(); } catch { /* best effort */ }
      try { session.ws.close(1001, 'server shutdown'); } catch { /* best effort */ }
      this.sessions.delete(envKey);
    }
  }

  /**
   * 把一条 WS 连接绑到某 env 的 pty。
   * 失败面(env 缺失 / 通道不支持 / 原生模块缺席 / spawn 异常)统一走
   * error 帧 + close——attach 的失败是「这条连接」的失败,不影响宿主。
   */
  attach(ws: TermWebSocket, envKey: string): void {
    const log = this.deps.log ?? ((m: string) => console.log(m));

    // 同 env 重复连接:旧连接先关,旧 pty **立即**回收——不依赖旧 WS 的
    // close 事件时序(close 是异步握手,若等它触发 reap,新会话已覆盖 map
    // 条目,旧 pty 会永久泄漏)。
    const existing = this.sessions.get(envKey);
    if (existing) {
      log(`[term] env="${envKey}" 重复 attach——关闭旧连接并回收旧 pty`);
      try { existing.ws.close(CLOSE_CODE_SUPERSEDED, 'superseded'); } catch { /* best effort */ }
      try { existing.pty.kill(); } catch { /* best effort */ }
    }

    const env = (this.deps.envResolver ?? defaultEnvResolver)(envKey);
    if (!env) {
      return this.fail(ws, log, envKey, `未找到环境 "${envKey}"(zhishi env list 查看已有环境)`);
    }

    const resolvedSpec = buildPtySpawnSpec(env);
    if (!resolvedSpec.ok) {
      return this.fail(ws, log, envKey, resolvedSpec.error);
    }
    const { spec } = resolvedSpec;

    const ptyApi = (this.deps.ptyLoader ?? loadNodePty)();
    if (!ptyApi) {
      return this.fail(
        ws,
        log,
        envKey,
        'node-pty 原生模块不可用(未安装或 ABI 不匹配)——交互终端 attach 不可用,请走 environment/exec 一次性执行',
      );
    }

    let pty: TermPty;
    try {
      pty = ptyApi.spawn(
        (this.deps.resolveHostBinary ?? resolveCommand)(spec.file),
        spec.args,
        {
          name: 'xterm-256color',
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
          env: augmentedProcessEnv(),
        },
      );
    } catch (err) {
      return this.fail(ws, log, envKey, `pty spawn 失败:${err instanceof Error ? err.message : String(err)}`);
    }
    log(`[term] env="${envKey}" pty spawn: ${spec.file} ${spec.args.join(' ')} (${DEFAULT_COLS}x${DEFAULT_ROWS})`);

    this.sessions.set(envKey, { pty, ws });
    this.wire(ws, envKey, pty, log);
  }

  /** 事件接线:pty ↔ ws 双向桥。 */
  private wire(ws: TermWebSocket, envKey: string, pty: TermPty, log: (m: string) => void): void {
    pty.onData((data) => {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'output', data } satisfies TermServerMessage)); } catch { /* socket 已死 */ }
      }
    });

    pty.onExit((ev) => {
      log(`[term] env="${envKey}" pty exit code=${ev.exitCode}${ev.signal ? ` signal=${ev.signal}` : ''}`);
      // 防误删:仅当本 pty 仍是该 env 的活动会话才清理。
      const cur = this.sessions.get(envKey);
      if (cur && cur.pty === pty) {
        this.sessions.delete(envKey);
      }
      if (ws.readyState === 1) {
        try {
          ws.send(JSON.stringify({
            type: 'exit',
            code: ev.exitCode,
            ...(ev.signal !== undefined ? { signal: String(ev.signal) } : {}),
          } satisfies TermServerMessage));
        } catch { /* best effort */ }
      }
      try { ws.close(1000, 'pty exited'); } catch { /* best effort */ }
    });

    ws.on('message', (raw) => {
      this.handleClientMessage(ws, pty, raw, envKey, log);
    });

    // close/error 同路径:连接没了 → pty 回收(防泄漏)。自然退出路径里
    // pty 已从 map 移除,此处 `cur.pty === pty` 防误杀同 env 的继任会话。
    const reap = (): void => {
      const cur = this.sessions.get(envKey);
      if (cur && cur.pty === pty) {
        log(`[term] env="${envKey}" WS 关闭——回收 pty`);
        this.sessions.delete(envKey);
        try { pty.kill(); } catch { /* best effort */ }
      }
    };
    ws.on('close', reap);
    ws.on('error', reap);
  }

  private handleClientMessage(
    ws: TermWebSocket,
    pty: TermPty,
    raw: string | Buffer,
    envKey: string,
    log: (m: string) => void,
  ): void {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'));
    } catch {
      log(`[term] env="${envKey}" 非法 JSON 帧(忽略)`);
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Partial<TermClientMessage>;

    if (m.type === 'input' && typeof (m as TermClientInputMessage).data === 'string') {
      try { pty.write((m as TermClientInputMessage).data); } catch { /* pty 已死 */ }
    } else if (m.type === 'resize') {
      const { cols, rows } = m as TermClientResizeMessage;
      if (
        Number.isInteger(cols) && Number.isInteger(rows) &&
        cols > 0 && rows > 0 && cols <= MAX_COLS && rows <= MAX_ROWS
      ) {
        try { pty.resize(cols, rows); } catch { /* pty 已死 */ }
      }
    } else if (m.type === 'ping') {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'pong' } satisfies TermServerMessage)); } catch { /* best effort */ }
      }
    }
    // 未知类型:静默忽略(协议前向兼容)。
  }

  private fail(ws: TermWebSocket, log: (m: string) => void, envKey: string, message: string): void {
    log(`[term] env="${envKey}" attach 失败:${message}`);
    try {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'error', message } satisfies TermServerMessage));
      }
    } catch { /* best effort */ }
    try { ws.close(CLOSE_CODE_ATTACH_FAILED, 'attach failed'); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// HTTP upgrade 安装(在 honoServe 返回的 node http.Server 上挂)
// ---------------------------------------------------------------------------

/** WS 端点路径(与 GUI attach 页的 sidecar 直连约定一致)。 */
export const TERM_WS_PATH = '/api/admin/environment/term';

/**
 * 在 sidecar 的 node http.Server 上安装 `/api/admin/environment/term`
 * 的 upgrade 处理。返回 manager(宿主可 closeAll 收尾)。
 *
 * 非本端点的 upgrade 一律 destroy——sidecar 目前没有其它 WS 消费者,
 * 悬挂的 upgrade socket 会泄漏(未来新增 WS 端点时在此统一分派)。
 */
export function installTermUpgradeHandler(server: Server, deps: TermSessionManagerDeps = {}): TermSessionManager {
  const manager = new TermSessionManager(deps);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== TERM_WS_PATH) {
      socket.destroy();
      return;
    }
    const envKey = (url.searchParams.get('env') ?? '').trim();
    if (!envKey) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      manager.attach(ws as unknown as TermWebSocket, envKey);
    });
  });

  return manager;
}
