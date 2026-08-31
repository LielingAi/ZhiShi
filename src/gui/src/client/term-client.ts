/**
 * 1.3.3 — attach 交互式终端 WS 客户端。
 *
 * 消费服务端 `/api/admin/environment/term?env=<envKey>`（见
 * src/server/loop/term-pty.ts）。协议：JSON 文本帧——
 *   C→S {type:'input',data} / {type:'resize',cols,rows} / {type:'ping'}
 *   S→C {type:'output',data} / {type:'exit',code,signal?} /
 *       {type:'error',message} / {type:'pong'}
 * 同 env 重复连接旧连接被 4001 关闭；attach 失败（env 缺失/通道不支持/
 * 原生模块缺席）→ error 帧后关闭（1011）。
 *
 * 本模块只管「协议与接线」：WS 实例由调用方注入（AttachView 建连接；
 * 单测注入 fake），输出写进注入的 sink（xterm 或测试桩）。不依赖 DOM /
 * 不引 xterm ——协议层可 node 单测。
 */

// ---------------------------------------------------------------------------
// 帧类型（与服务端 TermClientMessage / TermServerMessage 逐字段对齐）
// ---------------------------------------------------------------------------

export type TermClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' };

export type TermServerMessage =
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number; signal?: string }
  | { type: 'error'; message: string }
  | { type: 'pong' };

/** 初始 80×24（服务端 DEFAULT_COLS/ROWS 同口径）。 */
export const TERM_DEFAULT_COLS = 80;
export const TERM_DEFAULT_ROWS = 24;

// ---------------------------------------------------------------------------
// WS 最小接口（浏览器 WebSocket 与测试 fake 都满足）
// ---------------------------------------------------------------------------

export interface TermWebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  removeEventListener(type: string, fn: (ev: unknown) => void): void;
}

/** 输出落点（xterm.write / 测试桩）。 */
export interface TermSink {
  write(data: string): void;
}

export interface TermClientOptions {
  ws: TermWebSocketLike;
  sink: TermSink;
  /** 连接 open 后自动补发初始 resize（默认 80×24）。 */
  cols?: number;
  rows?: number;
  onExit?: (info: { code: number; signal?: string }) => void;
  onError?: (message: string) => void;
  onClose?: (code: number) => void;
  log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// 纯 helper（可单测）
// ---------------------------------------------------------------------------

/** http base → 终端 ws 地址（协议替换；envKey encodeURIComponent）。 */
export function termUrl(base: string, envKey: string): string {
  const wsBase = base.replace(/^http/i, 'ws').replace(/\/+$/, '');
  return `${wsBase}/api/admin/environment/term?env=${encodeURIComponent(envKey)}`;
}

/** 服务端 JSON 文本帧解析（非法 JSON / 未知类型 → null）。 */
export function parseServerFrame(raw: string): TermServerMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  if (m.type === 'output' && typeof m.data === 'string') {
    return { type: 'output', data: m.data };
  }
  if (m.type === 'exit' && typeof m.code === 'number') {
    return { type: 'exit', code: m.code, ...(typeof m.signal === 'string' ? { signal: m.signal } : {}) };
  }
  if (m.type === 'error' && typeof m.message === 'string') {
    return { type: 'error', message: m.message };
  }
  if (m.type === 'pong') return { type: 'pong' };
  return null;
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export class TermClient {
  private readonly opts: TermClientOptions;
  private closed = false;

  constructor(opts: TermClientOptions) {
    this.opts = opts;
    this.wire();
  }

  private wire(): void {
    const { ws, log } = this.opts;
    ws.addEventListener('open', this.onOpen);
    ws.addEventListener('message', this.onMessage);
    ws.addEventListener('close', this.onClose);
    ws.addEventListener('error', this.onError);
    if (log) log('term 客户端已接线（open 后发初始 resize）');
  }

  private readonly onOpen = (): void => {
    // 连接就绪先声明尺寸——服务端 pty 初始 80×24，与本地渲染一致。
    this.sendResize(this.opts.cols ?? TERM_DEFAULT_COLS, this.opts.rows ?? TERM_DEFAULT_ROWS);
  };

  private readonly onMessage = (ev: unknown): void => {
    const raw =
      typeof ev === 'string'
        ? ev
        : ev && typeof ev === 'object' && 'data' in ev && typeof (ev as { data: unknown }).data === 'string'
          ? ((ev as { data: string }).data)
          : '';
    if (!raw) return;
    const frame = parseServerFrame(raw);
    if (!frame) {
      this.opts.log?.(`term 忽略未知帧：${raw.slice(0, 80)}`);
      return;
    }
    switch (frame.type) {
      case 'output':
        this.opts.sink.write(frame.data);
        break;
      case 'exit':
        this.opts.onExit?.({ code: frame.code, signal: frame.signal });
        break;
      case 'error':
        this.opts.onError?.(frame.message);
        break;
      case 'pong':
        break; // 心跳回应，无需动作。
    }
  };

  private readonly onClose = (ev: unknown): void => {
    if (this.closed) return;
    this.closed = true;
    const code =
      ev && typeof ev === 'object' && 'code' in ev && typeof (ev as { code: unknown }).code === 'number'
        ? ((ev as { code: number }).code)
        : -1;
    this.opts.onClose?.(code);
  };

  private readonly onError = (): void => {
    // WS error 事件通常后随 close——具体原因走 close code / error 帧。
    this.opts.log?.('term WS error（等待 close）');
  };

  sendInput(data: string): void {
    if (this.closed) return;
    this.opts.ws.send(JSON.stringify({ type: 'input', data } satisfies TermClientMessage));
  }

  sendResize(cols: number, rows: number): void {
    if (this.closed) return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
    this.opts.ws.send(JSON.stringify({ type: 'resize', cols, rows } satisfies TermClientMessage));
  }

  ping(): void {
    if (this.closed) return;
    this.opts.ws.send(JSON.stringify({ type: 'ping' } satisfies TermClientMessage));
  }

  /** 摘监听（组件卸载 / 模式切换时调用；不再 send）。 */
  dispose(): void {
    this.closed = true;
    const { ws } = this.opts;
    ws.removeEventListener('open', this.onOpen);
    ws.removeEventListener('message', this.onMessage);
    ws.removeEventListener('close', this.onClose);
    ws.removeEventListener('error', this.onError);
  }
}
